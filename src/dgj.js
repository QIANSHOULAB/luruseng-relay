// 一叶笺 ⇄ 大管家 信箱（施工单 065；070 起电脑、掌机两台大管家共用一个信箱）：/dgj/<信箱号>/...
// - 信箱号 128 位随机（32 个小写十六进制字），知道号就能用。
// - 信两头加密（AES-256-GCM，钥匙只在手机和大管家上），这里只存密文、不拆、不看，日志不记内容。
// - 两个方向：手机 → 大管家（to=pc），大管家 → 手机（to=phone）。收信的一方连着 WebSocket 就马上推过去；
//   没连着就攒着，等它下次连上一次取完。收信的一方处理完回 ack 才删；没人取的 7 天删。
// - 大管家在不在线：大管家的 WebSocket 连着（90 秒内 ping 过）就算在线，手机的横条照这个显示。
// - 070（接口 v3）：电脑、掌机都连着（as=pc&who=desk、as=pc&who=handheld）时，寄给大管家的每封信只交给一台：先电脑、后掌机。
//   拿到的那台马上回「接了」（{"t":"take"}）；20 秒没回，或者接了以后断了（10 秒没回来）、不 ping 了（90 秒），转给下一台在线的。
//   接了的信，别的机器连上来也不给，免得两台都干。不带 who 的老掌机照 v2：推过去就算它接了，排在最后。
//   回手机的信带 re=<请求的 id>：同一个请求已经回过一份，第二份不收。
// - 大管家长连着也不费额度：WebSocket 休眠那一套（acceptWebSocket + 自动回 pong），ping 不叫醒它，空着不算时长。
// - 照片、配音 mp3 几 MB 一封：一行存不下就拆成几片存，取的时候拼回一整封。每个信箱有上限，防止被灌爆。
// - 手机 app、大管家发请求不带 Origin：不带 Origin 的只有这条路放行（录入僧 /r、点钞机 /count 照旧只认网页）。

import { Stats, clientClass } from './stats.js';
import { guard } from './limit.js';

const BOX_RE =/^[0-9a-f]{32}$/;
const MID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const ROLES = new Set(['pc', 'phone']);
const WHO = ['desk', 'handheld'];      // 070：先电脑、后掌机；不带 who 的老掌机排最后
const PART = 1_900_000;                // 一片最大（Durable Object 一行最多 2MB）
const MAX_MSG = 24_000_000;            // 一封最大
const MAX_BOX_BYTES = 64_000_000;      // 一个信箱里没取的加起来最多
const MAX_ITEMS = 200;                 // 一个信箱里没取的最多几封
const KEEP_MS = 7 * 24 * 3600 * 1000;  // 没人取的放 7 天
const STALE_MS = 90_000;               // 大管家 ping 过、之后 90 秒没再 ping：当它不在了（半死的连接不会一直显示在线）
const TAKE_MS = 20_000;                // 070：推给一台以后，这么久没回「接了」就转给下一台
const GRACE_MS = 10_000;               // 070：接了的那台断了，等它这么久（断了马上重连的照旧是它的），没回来再转
const INLINE = 48 * 1024;              // 小信（理好的字、请求的字）直接跟着推送走，省一次来回
const INLINE_HELLO = 256 * 1024;       // 刚连上时跟着 hello 一起带过去的，最多这么多

export const DGJ_PATH = /^\/dgj\/([^/]+)\/(ws|msg|msgs|state|replied|stats)(?:\/([^/]+))?$/;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rank = (who) => { const i = WHO.indexOf(who); return i < 0 ? WHO.length : i; };

/** 谁能用这条路：不带 Origin 的（手机 app、大管家）、跟站同一个 Origin 的、ALLOW_ORIGINS 里的网页。别的网站一律不行 */
function access(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin || origin === new URL(req.url).origin) return {};
  const allow = String(env.ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.includes('*') && !allow.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Expose-Headers': 'x-mid, x-to',
    'Access-Control-Max-Age': '86400', Vary: 'Origin',
  };
}

export async function handleDgj(req, env, m) {
  if (!BOX_RE.test(m[1])) return new Response('not found', { status: 404 });
  const h = access(req, env);
  if (!h) return new Response('origin not allowed', { status: 403 });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const u = new URL(req.url);   // 125：狂敲的在进 Durable Object 之前就挡住（每一下进去都算一次请求）
  const ws = req.headers.get('Upgrade') === 'websocket';
  const limited = guard(env, ws ? 'ws' : 'http', ws ? `${m[1]}|${u.searchParams.get('as')}|${u.searchParams.get('who') || ''}` : m[1]);
  if (limited) { for (const [k, v] of Object.entries(h)) limited.headers.set(k, v); return limited; }
  const res = await env.BOX.get(env.BOX.idFromName(m[1])).fetch(req);
  if (res.status === 101) return res;   // WebSocket
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}

function b64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Box {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS msgs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, mid TEXT NOT NULL, dest TEXT NOT NULL, at INTEGER NOT NULL,
      size INTEGER NOT NULL, parts INTEGER NOT NULL, UNIQUE (dest, mid))`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS parts (seq INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (seq, n))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    // 070：寄给大管家的信交给了哪台（who，老掌机是空字）、接了没有、什么时候交的、那台什么时候不见的、哪几台没回「接了」被跳过
    this.sql.exec('CREATE TABLE IF NOT EXISTS claims (seq INTEGER PRIMARY KEY, who TEXT NOT NULL, took INTEGER NOT NULL, at INTEGER NOT NULL, lost INTEGER, skip TEXT NOT NULL)');
    // 070：回过手机的请求（re）和回的时候，同一个请求的第二份回信不收；放 7 天
    this.sql.exec('CREATE TABLE IF NOT EXISTS replies (re TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    this.stats = new Stats(ctx, 'dgj');   // 125：额度账，见 stats.js
    this.alarmAt = [];                    // 125：最近几次闹钟响的时间，响得太密就拉长间隔（见 alarm()）
    this.slow = 0;                        // 125：拉长到什么时候
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));   // 心跳不叫醒它
    // 测试时用 --var 调小（DGJ_KEEP_MS 等）；线上不设，用上面的数
    const num = (k, d) => { const n = Number(env?.[k]); return Number.isFinite(n) && n > 0 ? n : d; };
    this.keepMs = num('DGJ_KEEP_MS', KEEP_MS);
    this.staleMs = num('DGJ_STALE_MS', STALE_MS);
    this.takeMs = num('DGJ_TAKE_MS', TAKE_MS);
    this.graceMs = num('DGJ_GRACE_MS', GRACE_MS);
    this.maxMsg = num('DGJ_MAX_MSG', MAX_MSG);
    this.maxBox = num('DGJ_MAX_BOX_BYTES', MAX_BOX_BYTES);
    this.maxItems = num('DGJ_MAX_ITEMS', MAX_ITEMS);
  }

  // ------------------------------------------------------------------ 账
  list(dest) {
    const q = 'SELECT seq, mid, dest AS "to", at, size FROM msgs' + (dest ? ' WHERE dest = ?' : '') + ' ORDER BY seq';
    return (dest ? this.sql.exec(q, dest) : this.sql.exec(q)).toArray();
  }
  row(seq) { return this.sql.exec('SELECT seq, mid, dest AS "to", at, size FROM msgs WHERE seq = ?', seq).toArray()[0]; }
  body(seq) {
    const rows = this.sql.exec('SELECT data FROM parts WHERE seq = ? ORDER BY n', seq).toArray();
    if (rows.length === 1) return rows[0].data;
    const out = new Uint8Array(rows.reduce((a, r) => a + r.data.byteLength, 0));
    let at = 0;
    for (const r of rows) { out.set(new Uint8Array(r.data), at); at += r.data.byteLength; }
    return out.buffer;
  }
  getMeta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]; return r ? r.v : null; }
  setMeta(k, v) { this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, String(v)); }
  counts() {
    const c = { pc: 0, phone: 0 };
    for (const r of this.sql.exec('SELECT dest, COUNT(*) AS n FROM msgs GROUP BY dest').toArray()) c[r.dest] = r.n;
    return c;
  }

  /** 小信把内容也带上（base64），收的一方不用再来取一趟 */
  inline(items, budget) {
    let left = budget;
    return items.map((it) => {
      if (it.size > INLINE || it.size > left) return it;
      left -= it.size;
      return { ...it, data: b64(this.body(it.seq)) };
    });
  }

  remove(seq, expired = false) {
    const r = this.row(seq);
    if (!r) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM parts WHERE seq = ?', seq);
      this.sql.exec('DELETE FROM msgs WHERE seq = ?', seq);
      this.sql.exec('DELETE FROM claims WHERE seq = ?', seq);
    });
    this.send({ t: 'gone', seq: r.seq, mid: r.mid, to: r.to, ...(expired ? { expired: true } : {}) });
    return true;
  }

  // ------------------------------------------------------------------ 谁在
  /** 大管家在不在：有一台的连接还在，而且最近 90 秒里连上过或 ping 过。seen = 最后一次见到它（在线时就是现在） */
  pc(except = null) {
    const now = Date.now();
    let on = false;
    let seen = Number(this.getMeta('pcSeen')) || null;
    for (const ws of this.ctx.getWebSockets('pc')) {
      if (ws === except) continue;
      const t = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const a = ws.deserializeAttachment() || {};
      const last = Math.max(a.at || 0, t ? t.getTime() : 0);
      if (now - last < this.staleMs) on = true;     // 连上以后一声 ping 都没有的也照这个算（last 就是连上的时间）：大管家连上就睡了，不能一直显示在线
      else seen = Math.max(seen || 0, last);
    }
    return { on, seen: on ? now : seen };
  }
  /** 070：在线的大管家，一台一项（一台可能连着不止一个口子），先电脑、后掌机、老掌机最后：[{ who, last, socks }] */
  machines(except = null) {
    const now = Date.now();
    const by = new Map();
    for (const ws of this.ctx.getWebSockets('pc')) {
      if (ws === except) continue;
      const t = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const a = ws.deserializeAttachment() || {};
      const last = Math.max(a.at || 0, t ? t.getTime() : 0);
      if (now - last >= this.staleMs) continue;
      const who = a.who || '';
      const m = by.get(who) || { who, last: 0, socks: [] };
      m.last = Math.max(m.last, last);
      m.socks.push(ws);
      by.set(who, m);
    }
    return [...by.values()].sort((x, y) => rank(x.who) - rank(y.who));
  }
  /** 070：给手机看「哪几台在」：desk、handheld；不带 who 的老掌机写 pc */
  pcs(except = null) { return this.machines(except).map((m) => m.who || 'pc'); }
  phoneOn(except = null) { return this.ctx.getWebSockets('phone').some((ws) => ws !== except); }
  state() { const pc = this.pc(); return { pc: pc.on, pcSeen: pc.seen, pcs: this.pcs(), phone: this.phoneOn(), pending: this.counts() }; }

  send(msg, role = undefined, except = null) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(role)) {
      if (ws === except) continue;
      try { ws.send(s); } catch (e) { /* 断了的不管 */ }
    }
  }

  // ------------------------------------------------------------------ 交给哪台（070）
  claim(seq) { return this.sql.exec('SELECT who, took, at, lost, skip FROM claims WHERE seq = ?', seq).toArray()[0]; }

  /** 寄给大管家、还没 ack 的信，每封只交给一台。返回这次新交出去的 [{ who, item }]，由调用的人推过去 */
  dispatch(except = null) {
    const now = Date.now();
    const on = this.machines(except);
    const out = [];
    const give = (r, m, skip) => {
      this.sql.exec('INSERT OR REPLACE INTO claims (seq, who, took, at, lost, skip) VALUES (?, ?, ?, ?, NULL, ?)',
        r.seq, m.who, m.who ? 0 : 1, now, skip.join(','));   // 老掌机不会回「接了」：推过去就算它接了
      out.push({ who: m.who, item: r });
    };
    for (const r of this.list('pc')) {
      const c = this.claim(r.seq);
      if (!c) { if (on.length) give(r, on[0], []); continue; }
      if (on.some((m) => m.who === c.who)) {                         // 拿着它的那台在
        if (c.lost) this.sql.exec('UPDATE claims SET lost = NULL WHERE seq = ?', r.seq);   // 断了又回来了：还是它的
        if (c.took || now - c.at < this.takeMs) continue;
        const skip = [...(c.skip ? c.skip.split(',') : []), c.who]; // 20 秒没回「接了」：转给下一台；没有下一台就还等它
        const next = on.find((m) => !skip.includes(m.who));
        if (next) give(r, next, skip);
        continue;
      }
      if (!c.lost) { this.sql.exec('UPDATE claims SET lost = ? WHERE seq = ?', now, r.seq); continue; }   // 不在了：先记下，等一会儿
      if (now - c.lost >= this.graceMs && on.length) give(r, on[0], []);
    }
    return out;
  }

  /** 新交出去的信推给拿到的那台（它连着几个口子就推几个） */
  push(out, except = null) {
    for (const { who, item } of out) {
      const s = JSON.stringify({ t: 'msg', item: this.inline([item], INLINE)[0] });
      for (const ws of this.ctx.getWebSockets('pc')) {
        if (ws === except || ((ws.deserializeAttachment() || {}).who || '') !== who) continue;
        try { ws.send(s); } catch (e) { /* 断了的不管 */ }
      }
    }
  }

  /** 下回什么时候醒：最早一封放满 7 天、等「接了」满 20 秒（有下一台可转才等）、断了的那台等满 10 秒（有机器在线才等）、接了的那台该 ping 了还没 ping。
   *  125：没有进展可做的不定闹钟。原来「断了的那台」的 10 秒一到、可是一台机器都不在线，闹钟定在 0.1 秒以后，响了又什么也做不了、再定 0.1 秒以后……
   *  一秒十次，一直到有机器连上来；每响一次都算一次请求（一天免费 10 万次，一晚上就吃光了）。机器连上来、断开、收到信、回执的时候，
   *  都会自己再 dispatch + schedule 一遍，所以没有进展可做的时候不用靠闹钟等。 */
  async schedule() {
    const now = Date.now();
    const when = [];
    const oldest = this.sql.exec('SELECT MIN(at) AS a FROM msgs').one().a;
    if (oldest) when.push(oldest + this.keepMs + 1000);
    const replied = this.sql.exec('SELECT MIN(at) AS a FROM replies').one().a;
    if (replied) when.push(replied + this.keepMs + 1000);
    const on = this.machines();
    const last = new Map(on.map((m) => [m.who, m.last]));
    for (const c of this.sql.exec('SELECT who, took, at, lost, skip FROM claims').toArray()) {
      if (c.lost) { if (on.length) when.push(c.lost + this.graceMs + 100); continue; }   // 一台都不在：等它们连上来，连上来会自己交
      if (!last.has(c.who)) { when.push(now + 1000); continue; }                           // 拿着的那台刚不在了、还没记「不见了」：马上记一下
      when.push(last.get(c.who) + this.staleMs + 100);                                      // 它该 ping 了还没 ping
      if (!c.took) {
        const skip = c.skip ? c.skip.split(',') : [];
        if (on.some((m) => m.who !== c.who && !skip.includes(m.who))) when.push(c.at + this.takeMs + 100);   // 有下一台可转才等「接了」
      }
    }
    if (when.length) {
      let at = Math.max(Math.min(...when), now + 100);
      if (this.slow > now) at = Math.max(at, now + 30_000);   // 响得太密（见 alarm()）：先放慢
      await this.ctx.storage.setAlarm(at);
    } else await this.ctx.storage.deleteAlarm();
  }

  // ------------------------------------------------------------------ 请求
  /** 125：先记账再办。op 是口的名字，who 是谁（连 WebSocket 的是 desk / handheld / phone，普通请求按 User-Agent 分大类） */
  async fetch(req) {
    const url = new URL(req.url);
    const what = url.pathname.split('/')[3];
    const method = req.method;
    let op, who;
    if (what === 'ws') {
      const role = url.searchParams.get('as');
      op = 'ws ' + (ROLES.has(role) ? role : '?');
      who = role === 'pc' ? (url.searchParams.get('who') || 'pc') : 'phone';
    } else {
      who = clientClass(req);
      op = what === 'msg' ? (method === 'PUT' ? 'PUT msg>' + (url.searchParams.get('to') || '?') : (method === 'DELETE' ? 'DEL msg' : 'GET msg')) : `${method} ${what}`;
    }
    if (what === 'stats' && method === 'GET') {           // 只给数：次数、几封在排着、几台在线，没有信的内容、没有信箱号
      this.stats.hit('GET stats', who, 200);
      const c = this.sql.exec('SELECT COUNT(*) AS n, SUM(took) AS t, SUM(lost IS NOT NULL) AS l FROM claims').one();
      return json(this.stats.read({ box: { ...this.state(), claims: c.n, took: c.t || 0, lost: c.l || 0, sockets: this.ctx.getWebSockets().length, alarm: await this.ctx.storage.getAlarm() } }));
    }
    let res;
    try { res = await this.route(req); } catch (e) { this.stats.hit(op, who, 500); throw e; }
    this.stats.hit(op, who, res.status);
    return res;
  }

  async route(req) {
    const url = new URL(req.url);
    const [, , , what, arg] = url.pathname.split('/');
    const method = req.method;

    if (what === 'ws') {                 // 大管家（?as=pc&who=desk|handheld）一直连着；手机（?as=phone）开着时连着
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const role = url.searchParams.get('as');
      if (!ROLES.has(role)) return json({ error: 'as=pc 或 as=phone' }, 400);
      const who = role === 'pc' ? (url.searchParams.get('who') || '') : '';
      if (who && !WHO.includes(who)) return json({ error: 'who=desk 或 who=handheld' }, 400);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [role]);
      const now = Date.now();
      server.serializeAttachment({ role, at: now, ...(who ? { who } : {}) });
      let items;
      if (role === 'pc') {
        this.setMeta('pcSeen', now);
        this.push(this.dispatch(), server);                          // 别的机器这会儿新拿到的推过去；这一台的跟着 hello 走
        items = this.list('pc').filter((r) => { const c = this.claim(r.seq); return c && c.who === who; });
      } else items = this.list('phone');
      server.send(JSON.stringify({ t: 'hello', v: 3, role, ...(who ? { who } : {}), ...this.state(), items: this.inline(items, INLINE_HELLO) }));
      if (role === 'pc') {
        this.send({ t: 'pc', on: true, seen: now, pcs: this.pcs() }, 'phone');
        await this.schedule();
      } else this.send({ t: 'phone', on: true }, 'pc');
      return new Response(null, { status: 101, webSocket: client });
    }

    if (what === 'state' && method === 'GET') return json(this.state());

    if (what === 'replied' && arg && method === 'GET') {   // 070：这个请求回过手机没有（听力稿配之前先问一句，免得两台都配）
      if (!MID_RE.test(arg)) return json({ error: 'bad re' }, 400);
      const r = this.sql.exec('SELECT at FROM replies WHERE re = ?', arg).toArray()[0];
      return json({ re: arg, replied: Boolean(r), at: r ? r.at : null });
    }

    if (what === 'msgs' && method === 'GET') {
      const dest = url.searchParams.get('for');
      if (dest && !ROLES.has(dest)) return json({ error: 'for=pc 或 for=phone' }, 400);
      return json(this.list(dest));
    }

    if (what === 'msg' && !arg && method === 'PUT') {
      const to = url.searchParams.get('to');
      const mid = url.searchParams.get('mid') || '';
      const re = to === 'phone' ? url.searchParams.get('re') : null;   // 070：回的是哪个请求
      if (!ROLES.has(to) || !MID_RE.test(mid) || (re !== null && !MID_RE.test(re))) return json({ error: 'bad to/mid/re' }, 400);
      if (Number(req.headers.get('Content-Length') || 0) > this.maxMsg) return json({ error: `太大了：一封最多 ${this.maxMsg} 字节` }, 413);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return json({ error: 'empty' }, 400);
      if (buf.byteLength > this.maxMsg) return json({ error: `太大了：一封最多 ${this.maxMsg} 字节` }, 413);
      // 从这儿往下不 await，查重、查上限、存，一口气做完
      const had = this.sql.exec('SELECT seq, at FROM msgs WHERE dest = ? AND mid = ?', to, mid).toArray()[0];
      if (had) return json({ seq: had.seq, at: had.at, again: true, pc: this.pc().on });   // 重传同一封：不存第二份
      if (re) {
        const done = this.sql.exec('SELECT at FROM replies WHERE re = ?', re).toArray()[0];
        if (done) return json({ seq: null, at: done.at, again: true, dup: true, pc: this.pc().on });   // 070：这个请求已经回过手机一份（两台都干了）：第二份不收
      }
      const tot = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM msgs').one();
      if (tot.n >= this.maxItems) return json({ error: `信箱满了：攒了 ${tot.n} 封没取` }, 429);
      if (tot.b + buf.byteLength > this.maxBox) return json({ error: `信箱满了：没取的已经有 ${tot.b} 字节` }, 429);
      const at = Date.now();
      const parts = Math.ceil(buf.byteLength / PART);
      let seq = 0;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('INSERT INTO msgs (mid, dest, at, size, parts) VALUES (?, ?, ?, ?, ?)', mid, to, at, buf.byteLength, parts);
        seq = this.sql.exec('SELECT last_insert_rowid() AS s').one().s;
        for (let i = 0; i < parts; i++) {
          this.sql.exec('INSERT INTO parts (seq, n, data) VALUES (?, ?, ?)', seq, i, buf.slice(i * PART, Math.min((i + 1) * PART, buf.byteLength)));
        }
        if (re) this.sql.exec('INSERT OR REPLACE INTO replies (re, at) VALUES (?, ?)', re, at);
      });
      if (to === 'pc') this.push(this.dispatch());                    // 070：只交给一台
      else this.send({ t: 'msg', item: this.inline([{ seq, mid, to, at, size: buf.byteLength }], INLINE)[0] }, to);
      await this.schedule();
      return json({ seq, at, parts, pc: this.pc().on, phone: this.phoneOn() });
    }

    if (what === 'msg' && arg) {
      const seq = Number(arg);
      if (!Number.isSafeInteger(seq) || seq < 1) return json({ error: 'bad seq' }, 400);
      if (method === 'GET') {
        const r = this.row(seq);
        if (!r) return json({ error: 'gone' }, 404);
        return new Response(this.body(seq), {
          headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-mid': r.mid, 'x-to': r.to },
        });
      }
      if (method === 'DELETE') {         // 收到了（ack），或者寄的人撤回
        const had = this.remove(seq);
        await this.schedule();
        return json({ ok: true, had });
      }
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, message) {  // ping 自动回了不进这里；这里只认 ack、state、take
    const a0 = ws.deserializeAttachment() || {};
    const wh = a0.who || a0.role || '?';
    if (typeof message !== 'string' || message.length > 512) { this.stats.hit('wsmsg bad', wh); return; }
    let m;
    try { m = JSON.parse(message); } catch (e) { this.stats.hit('wsmsg bad', wh); return; }
    this.stats.hit('wsmsg ' + (m && ['ack', 'state', 'take'].includes(m.t) ? m.t : 'other'), wh);
    if (m && m.t === 'ack' && Number.isSafeInteger(m.seq)) {
      this.remove(m.seq);
      await this.schedule();
    } else if (m && m.t === 'state') {
      try { ws.send(JSON.stringify({ t: 'state', ...this.state() })); } catch (e) { /* 断了 */ }
    } else if (m && m.t === 'take' && Number.isSafeInteger(m.seq)) {   // 070：「接了」
      const who = (ws.deserializeAttachment() || {}).who || '';
      const c = this.claim(m.seq);
      let back;
      if (!this.row(m.seq)) back = { t: 'nope', seq: m.seq, gone: true };   // 撤回了、过期了、已经理完了
      else if (c && c.who === who) {
        this.sql.exec('UPDATE claims SET took = 1, lost = NULL WHERE seq = ?', m.seq);
        back = { t: 'took', seq: m.seq };
      } else back = { t: 'nope', seq: m.seq, by: c ? (c.who || 'pc') : null };   // 晚了，已经转给别的机器
      try { ws.send(JSON.stringify(back)); } catch (e) { /* 断了 */ }
      await this.schedule();
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* 已经关了 */ }
    const a = ws.deserializeAttachment() || {};
    this.stats.hit('wsclose', a.who || a.role || '?');
    if (a.role === 'pc') {
      const now = Date.now();
      this.setMeta('pcSeen', now);
      const st = this.pc(ws);
      this.send({ t: 'pc', on: st.on, seen: now, pcs: this.pcs(ws) }, 'phone');
      this.push(this.dispatch(ws), ws);  // 070：它拿着的信先记下「不见了」，过一会儿还没回来再转
      await this.schedule();
    } else if (a.role === 'phone') {
      this.send({ t: 'phone', on: this.phoneOn(ws) }, 'pc');
    }
  }
  async webSocketError(ws) { await this.webSocketClose(ws, 1011); }

  async alarm() {                        // 放了 7 天没人取的：删掉，两头都说一声；070：到时候该转给下一台的转过去
    this.stats.hit('alarm');
    const t = Date.now();              // 125：10 秒里响了 20 次以上：有什么没算对，放慢 5 分钟（记一笔「alarm slowed」，读数里看得见）
    this.alarmAt = this.alarmAt.filter((x) => t - x < 10_000);
    this.alarmAt.push(t);
    if (this.alarmAt.length >= 20 && this.slow < t) { this.slow = t + 300_000; this.stats.hit('alarm slowed'); }
    const cut = Date.now() - this.keepMs;
    for (const r of this.sql.exec('SELECT seq FROM msgs WHERE at < ?', cut).toArray()) this.remove(r.seq, true);
    this.sql.exec('DELETE FROM replies WHERE at < ?', cut);
    this.push(this.dispatch());
    await this.schedule();
  }
}
