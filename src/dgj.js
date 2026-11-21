// 一叶笺 ⇄ 大管家 信箱（施工单 065）：/dgj/<信箱号>/...
// - 信箱号 128 位随机（32 个小写十六进制字），知道号就能用。
// - 信两头加密（AES-256-GCM，钥匙只在手机和掌机上），这里只存密文、不拆、不看，日志不记内容。
// - 两个方向：手机 → 大管家（to=pc），大管家 → 手机（to=phone）。收信的一方连着 WebSocket 就马上推过去；
//   没连着就攒着，等它下次连上一次取完。收信的一方处理完回 ack 才删；没人取的 7 天删。
// - 大管家在不在线：掌机的 WebSocket 连着（90 秒内 ping 过）就算在线，手机的横条照这个显示。
// - 掌机长连着也不费额度：WebSocket 休眠那一套（acceptWebSocket + 自动回 pong），ping 不叫醒它，空着不算时长。
// - 照片、配音 mp3 几 MB 一封：一行存不下就拆成几片存，取的时候拼回一整封。每个信箱有上限，防止被灌爆。
// - 手机 app、掌机发请求不带 Origin：不带 Origin 的只有这条路放行（录入僧 /r、点钞机 /count 照旧只认网页）。

const BOX_RE = /^[0-9a-f]{32}$/;
const MID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const ROLES = new Set(['pc', 'phone']);
const PART = 1_900_000;                // 一片最大（Durable Object 一行最多 2MB）
const MAX_MSG = 24_000_000;            // 一封最大
const MAX_BOX_BYTES = 64_000_000;      // 一个信箱里没取的加起来最多
const MAX_ITEMS = 200;                 // 一个信箱里没取的最多几封
const KEEP_MS = 7 * 24 * 3600 * 1000;  // 没人取的放 7 天
const STALE_MS = 90_000;               // 掌机 ping 过、之后 90 秒没再 ping：当它不在了（半死的连接不会一直显示在线）
const INLINE = 48 * 1024;              // 小信（理好的字、请求的字）直接跟着推送走，省一次来回
const INLINE_HELLO = 256 * 1024;       // 刚连上时跟着 hello 一起带过去的，最多这么多

export const DGJ_PATH = /^\/dgj\/([^/]+)\/(ws|msg|msgs|state)(?:\/([^/]+))?$/;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** 谁能用这条路：不带 Origin 的（手机 app、掌机）、跟站同一个 Origin 的、ALLOW_ORIGINS 里的网页。别的网站一律不行 */
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
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));   // 心跳不叫醒它
    // 测试时用 --var 调小（DGJ_KEEP_MS 等）；线上不设，用上面的数
    const num = (k, d) => { const n = Number(env?.[k]); return Number.isFinite(n) && n > 0 ? n : d; };
    this.keepMs = num('DGJ_KEEP_MS', KEEP_MS);
    this.staleMs = num('DGJ_STALE_MS', STALE_MS);
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
    });
    this.send({ t: 'gone', seq: r.seq, mid: r.mid, to: r.to, ...(expired ? { expired: true } : {}) });
    return true;
  }

  // ------------------------------------------------------------------ 谁在
  /** 大管家在不在：掌机的连接还在，而且没「ping 过又 90 秒不 ping」。seen = 最后一次见到它（在线时就是现在） */
  pc(except = null) {
    const now = Date.now();
    let on = false;
    let seen = Number(this.getMeta('pcSeen')) || null;
    for (const ws of this.ctx.getWebSockets('pc')) {
      if (ws === except) continue;
      const t = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const a = ws.deserializeAttachment() || {};
      const last = Math.max(a.at || 0, t ? t.getTime() : 0);
      if (!t || now - last < this.staleMs) on = true;
      else seen = Math.max(seen || 0, last);
    }
    return { on, seen: on ? now : seen };
  }
  phoneOn(except = null) { return this.ctx.getWebSockets('phone').some((ws) => ws !== except); }
  state() { const pc = this.pc(); return { pc: pc.on, pcSeen: pc.seen, phone: this.phoneOn(), pending: this.counts() }; }

  send(msg, role = undefined, except = null) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(role)) {
      if (ws === except) continue;
      try { ws.send(s); } catch (e) { /* 断了的不管 */ }
    }
  }

  // ------------------------------------------------------------------ 请求
  async fetch(req) {
    const url = new URL(req.url);
    const [, , , what, arg] = url.pathname.split('/');
    const method = req.method;

    if (what === 'ws') {                 // 掌机（?as=pc）一直连着；手机（?as=phone）开着时连着
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const role = url.searchParams.get('as');
      if (!ROLES.has(role)) return json({ error: 'as=pc 或 as=phone' }, 400);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [role]);
      const now = Date.now();
      server.serializeAttachment({ role, at: now });
      if (role === 'pc') this.setMeta('pcSeen', now);
      const st = this.state();
      server.send(JSON.stringify({ t: 'hello', role, ...st, items: this.inline(this.list(role), INLINE_HELLO) }));
      if (role === 'pc') this.send({ t: 'pc', on: true, seen: now }, 'phone');
      else this.send({ t: 'phone', on: true }, 'pc');
      return new Response(null, { status: 101, webSocket: client });
    }

    if (what === 'state' && method === 'GET') return json(this.state());

    if (what === 'msgs' && method === 'GET') {
      const dest = url.searchParams.get('for');
      if (dest && !ROLES.has(dest)) return json({ error: 'for=pc 或 for=phone' }, 400);
      return json(this.list(dest));
    }

    if (what === 'msg' && !arg && method === 'PUT') {
      const to = url.searchParams.get('to');
      const mid = url.searchParams.get('mid') || '';
      if (!ROLES.has(to) || !MID_RE.test(mid)) return json({ error: 'bad to/mid' }, 400);
      if (Number(req.headers.get('Content-Length') || 0) > this.maxMsg) return json({ error: `太大了：一封最多 ${this.maxMsg} 字节` }, 413);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return json({ error: 'empty' }, 400);
      if (buf.byteLength > this.maxMsg) return json({ error: `太大了：一封最多 ${this.maxMsg} 字节` }, 413);
      // 从这儿往下不 await，查重、查上限、存，一口气做完
      const had = this.sql.exec('SELECT seq, at FROM msgs WHERE dest = ? AND mid = ?', to, mid).toArray()[0];
      if (had) return json({ seq: had.seq, at: had.at, again: true, pc: this.pc().on });   // 重传同一封：不存第二份
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
      });
      const item = { seq, mid, to, at, size: buf.byteLength };
      this.send({ t: 'msg', item: this.inline([item], INLINE)[0] }, to);
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(at + this.keepMs + 1000);
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
      if (method === 'DELETE') return json({ ok: true, had: this.remove(seq) });   // 收到了（ack），或者寄的人撤回
    }
    return new Response('not found', { status: 404 });
  }

  webSocketMessage(ws, message) {        // ping 自动回了不进这里；这里只认 ack 和 state
    if (typeof message !== 'string' || message.length > 512) return;
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    if (m && m.t === 'ack' && Number.isSafeInteger(m.seq)) this.remove(m.seq);
    else if (m && m.t === 'state') {
      try { ws.send(JSON.stringify({ t: 'state', ...this.state() })); } catch (e) { /* 断了 */ }
    }
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* 已经关了 */ }
    const a = ws.deserializeAttachment() || {};
    if (a.role === 'pc') {
      const now = Date.now();
      this.setMeta('pcSeen', now);
      const st = this.pc(ws);
      this.send({ t: 'pc', on: st.on, seen: now }, 'phone');
    } else if (a.role === 'phone') {
      this.send({ t: 'phone', on: this.phoneOn(ws) }, 'pc');
    }
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011); }

  async alarm() {                        // 放了 7 天没人取的：删掉，两头都说一声
    const cut = Date.now() - this.keepMs;
    for (const r of this.sql.exec('SELECT seq FROM msgs WHERE at < ?', cut).toArray()) this.remove(r.seq, true);
    const next = this.sql.exec('SELECT MIN(at) AS a FROM msgs').one().a;
    if (next) await this.ctx.storage.setAlarm(next + this.keepMs + 1000);
  }
}
