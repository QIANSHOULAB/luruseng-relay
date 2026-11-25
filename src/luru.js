// 录入僧 ⇄ 大管家（施工单 089）：/lr/...
// 录入僧（网页版、电脑版）认照片先问大管家；大管家不在、没配对、超时，录入僧自己跳回 Gemini。
// - 配对：录入僧输一次暗号。暗号用大管家的公钥（P-256）加密着过来，站里看不见；对了，大管家给那个录入僧一把它自己的钥匙
//   （也是加密着回去），以后照片和结果都用那把钥匙加密，站里只转密文、不存（转完就扔）。
// - 站里只记：配上的是谁（cid、一句「哪个浏览器、哪台电脑」、什么时候配的、最后一次用、撤了没有），
//   哪个地方输错了几次（IP 只存加盐的哈希）。同一个地方一小时错 LR_FAILS 次（10）就锁一小时。
// - 大管家这头（电脑 who=desk、掌机 who=handheld）带一个口令（x-lr-token）连上来；站里只存口令的哈希，第一台连上来的定下它。
//   一件活只交一台；交过去 LR_TAKE_MS（8 秒）没来取就转给下一台。
// - 093 两台一起认：大管家连上来报自己能同时认几张（?cap=，电脑 4、掌机 8；打游戏报 0，连着的时候发 {"t":"cap","n":…}）。
//   站里记每台手上正在认几张，来活交给空位最多的那台（一样多先电脑）；两台都满了，活在站里排着，哪台空出一位交哪台。
//   大管家手上满了（或者刚开始打游戏）回 {"t":"no","id":…}：这件放回队头，那台先不给，等它回下一件。
//   认一张最多等 LR_ASK_MS（5 分钟），从大管家取走那一刻算，站里排队的时间不算；排队最多 LR_QUEUE_MS（15 分钟）。
//   在线的都报 0（打游戏）：直接回 503 cant，录入僧换 Gemini。
// - 撤掉的、站里不认识的录入僧发来的照片：直接回 403，录入僧退回 Gemini。

import { Stats, clientClass } from './stats.js';
import { guard } from './limit.js';
import { viaDO } from './dofail.js';

const WHO = ['desk', 'handheld'];
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const B64_RE = /^[A-Za-z0-9_-]+$/;
const STALE_MS = 90_000;               // 90 秒没 ping：当它不在了（跟 /dgj 一样）
const TAKE_MS = 8_000;                 // 交给一台以后，这么久没来取，转给下一台
const ASK_MS = 300_000;                // 093：认一张最多等多久，从大管家取走算（大管家自己 280 秒放弃）
const QUEUE_MS = 900_000;              // 093：两台都满，在站里最多排多久
const CAP = 4;                         // 093：没报能认几张的（老大管家）当 4
const CAP_MAX = 32;
const PAIR_MS = 30_000;                // 配对最多等多久
const FAILS = 10;                      // 一小时错几次锁
const LOCK_MS = 3600_000;              // 锁多久
const MAX_ASK = 8_000_000;             // 一张照片（加密后、base64）最大
const MAX_PAIR = 8_000;
const MAX_CONF = 8_000;

export const LR_PATH = /^\/lr\/(hello|pair|ask|pc\/(?:ws|pub|state|revoke|conf|job|answer|stats))(?:\/([A-Za-z0-9_-]+))?$/;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const clampCap = (n) => { const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.min(CAP_MAX, Math.max(0, v)) : CAP; };
const rank = (who) => { const i = WHO.indexOf(who); return i < 0 ? WHO.length : i; };
const rid = () => { const b = crypto.getRandomValues(new Uint8Array(16)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 谁能用：不带 Origin 的（录入僧电脑版、大管家）、ALLOW_ORIGINS 里的网页（录入僧网页版）。别的网站一律不行 */
function access(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin || origin === new URL(req.url).origin) return {};
  const allow = String(env.ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.includes('*') && !allow.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin',
  };
}

export async function handleLuru(req, env, m) {
  const h = access(req, env);
  if (!h) return new Response('origin not allowed', { status: 403 });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (m[1].startsWith('pc/') && req.headers.get('Origin')) return new Response('not for pages', { status: 403 });   // 大管家那头的口子网页不能碰
  const fwd = new Request(req);
  fwd.headers.delete('x-lr-ip');
  let ip = req.headers.get('CF-Connecting-IP') || '';
  if (env.LR_TEST && req.headers.get('x-test-ip')) ip = req.headers.get('x-test-ip');   // 测试：假装从不同地方来
  fwd.headers.set('x-lr-ip', ip || 'local');
  const ws = m[1] === 'pc/ws';   // 125：狂敲的在进 Durable Object 之前就挡住（每一下进去都算一次请求）。大管家按 who 一把桶，别的按来源地址
  const limited = guard(env, ws ? 'ws' : 'http', 'lr|' + (m[1].startsWith('pc/') ? 'pc|' + (new URL(req.url).searchParams.get('who') || req.headers.get('x-lr-who') || '') : (ip || 'local')) + (ws ? '' : '|' + m[1]));
  if (limited) { for (const [k, v] of Object.entries(h)) limited.headers.set(k, v); return limited; }
  const room = env.LR_TEST ? (req.headers.get('x-test-room') || new URL(req.url).searchParams.get('room')) : null;
  const name = room || 'main';           // 测试：每组一个干净的房间
  const res = await viaDO(env.LURU.get(env.LURU.idFromName(name)), fwd);   // 140：DO 出错回 503 + 原因，不崩成 1101
  if (res.status === 101) return res;   // WebSocket
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}

export class Luru {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS clients (cid TEXT PRIMARY KEY, label TEXT NOT NULL, at INTEGER NOT NULL,
      last INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS fails (ip TEXT NOT NULL, at INTEGER NOT NULL)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    const num = (k, d) => { const n = Number(env?.[k]); return Number.isFinite(n) && n > 0 ? n : d; };
    this.staleMs = num('LR_STALE_MS', STALE_MS);
    this.takeMs = num('LR_TAKE_MS', TAKE_MS);
    this.askMs = num('LR_ASK_MS', ASK_MS);
    this.queueMs = num('LR_QUEUE_MS', QUEUE_MS);
    this.pairMs = num('LR_PAIR_MS', PAIR_MS);
    this.fails = num('LR_FAILS', FAILS);
    this.lockMs = num('LR_LOCK_MS', LOCK_MS);
    this.jobs = new Map();               // 正在等大管家回的活：只在内存里，回了就扔
    this.queue = [];                     // 093：两台都满，排着的活（先来先给）
    this.hold = new Set();               // 093：说了「满了」的那台，等它回下一件再给
    this.tick = null;
    this.stats = new Stats(ctx, 'lr');   // 125：额度账，见 stats.js
  }

  getMeta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]; return r ? r.v : null; }
  setMeta(k, v) { this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, String(v)); }

  /** 大管家的口令对不对：站里只存哈希，第一台带口令来的定下它 */
  async pcOk(req) {
    const tok = req.headers.get('x-lr-token') || new URL(req.url).searchParams.get('tok') || '';   // WebSocket 带不了头的（测试）走 ?tok=
    if (tok.length < 32) return false;
    const h = await sha('lr-pc/' + tok);
    const had = this.getMeta('pcHash');
    if (!had) { this.setMeta('pcHash', h); return true; }
    return had === h;
  }

  /** 在线的大管家，一台一项，先电脑、后掌机。cap：它报的能同时认几张（最新那条连接的）；busy：站里交给它、还没回的 */
  machines() {
    const now = Date.now();
    const by = new Map();
    for (const ws of this.ctx.getWebSockets('pc')) {
      const t = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const a = ws.deserializeAttachment() || {};
      const last = Math.max(a.at || 0, t ? t.getTime() : 0);
      if (now - last >= this.staleMs) continue;
      const m = by.get(a.who) || { who: a.who, socks: [], cap: CAP, since: -1 };
      m.socks.push(ws);
      if ((a.since || 0) > m.since) { m.since = a.since || 0; m.cap = Number.isFinite(a.cap) ? a.cap : CAP; }
      by.set(a.who, m);
    }
    for (const m of by.values()) {
      m.busy = this.busy(m.who);
      m.free = this.hold.has(m.who) ? 0 : Math.max(0, m.cap - m.busy);
    }
    return [...by.values()].sort((x, y) => rank(x.who) - rank(y.who));
  }

  busy(who) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.kind === 'ask' && !j.over && j.who === who) n++;
    return n;
  }

  /** 锁着没有：一小时里错满 LR_FAILS 次，从最后一次错起锁一小时 */
  lockOf(ip) {
    const now = Date.now();
    this.sql.exec('DELETE FROM fails WHERE at < ?', now - Math.max(this.lockMs, 3600_000));
    const r = this.sql.exec('SELECT COUNT(*) AS n, MAX(at) AS last FROM fails WHERE ip = ? AND at >= ?', ip, now - 3600_000).one();
    const until = r.n >= this.fails ? r.last + this.lockMs : 0;
    return { n: r.n, until: until > now ? until : 0 };
  }

  /** 交一件活给大管家，等它回（或者超时、没人在）。093：认照片的先进队，pump() 按空位交；配对的不占空位，马上交 */
  run(kind, cid, ip, payload, ms) {
    const j = { id: rid(), kind, cid, ip, payload, ms, skip: [], who: null, by: null, t: null, w: null, over: false, at: Date.now() };
    const p = new Promise((ok) => { j.done = (r) => { if (j.over) return; j.over = true; ok(r); }; });
    this.jobs.set(j.id, j);
    if (kind === 'ask') {
      j.q = setTimeout(() => j.done({ timeout: true, queued: true }), this.queueMs);
      this.queue.push(j);
      this.pump();
    } else {
      j.q = setTimeout(() => j.done({ timeout: true }), ms);
      this.give(j);
    }
    return p.finally(() => {
      clearTimeout(j.q); clearTimeout(j.t); clearTimeout(j.w);
      this.jobs.delete(j.id);
      const i = this.queue.indexOf(j);
      if (i >= 0) this.queue.splice(i, 1);
      this.pump();
    });
  }

  /** 配对：交给下一台在线的（先电脑），不看空位 */
  give(j) {
    const on = this.machines().filter((m) => !j.skip.includes(m.who));
    if (!on.length) { if (!j.who) j.done({ off: true }); return; }   // 没有下一台：还等交过去的那台
    this.send(j, on[0]);
  }

  send(j, m) {
    j.who = m.who;
    const s = JSON.stringify({ t: 'job', id: j.id, kind: j.kind });
    for (const ws of m.socks) { try { ws.send(s); } catch (e) { /* 断了 */ } }
    clearTimeout(j.t);
    j.t = setTimeout(() => {
      if (j.by || j.over || j.who !== m.who) return;
      j.skip.push(m.who);
      if (j.kind === 'ask') { j.who = null; this.queue.unshift(j); this.pump(); } else this.give(j);
    }, this.takeMs);
  }

  /** 093：把排着的活按空位交出去；取走了的那台掉线了，放回队头 */
  pump() {
    if (!this.jobs.size) { if (this.tick) { clearInterval(this.tick); this.tick = null; } return; }
    if (!this.tick) this.tick = setInterval(() => this.pump(), 5_000);   // 掉线不一定有动静：隔 5 秒看一眼
    let ms = this.machines();
    const on = new Set(ms.map((m) => m.who));
    for (const j of this.jobs.values()) {
      if (j.kind !== 'ask' || j.over || !j.who || on.has(j.who)) continue;
      clearTimeout(j.t); clearTimeout(j.w); clearTimeout(j.q);
      j.who = null; j.by = null;
      j.q = setTimeout(() => j.done({ timeout: true, queued: true }), this.queueMs);
      if (!this.queue.includes(j)) this.queue.unshift(j);
    }
    for (const j of [...this.queue]) {
      if (j.over) continue;
      ms = this.machines();
      const cands = ms.filter((m) => !j.skip.includes(m.who));
      if (!cands.length) { j.done({ off: true }); continue; }
      if (cands.every((m) => m.cap <= 0)) { j.done({ off: true, cant: true }); continue; }
      const best = cands.filter((m) => m.free > 0).sort((x, y) => y.free - x.free || rank(x.who) - rank(y.who))[0];
      if (!best) continue;                 // 都满：排着
      this.queue.splice(this.queue.indexOf(j), 1);
      this.send(j, best);
    }
  }

  clientRows() {
    return this.sql.exec('SELECT cid, label, at, last, uses, revoked FROM clients ORDER BY at').toArray();
  }

  /** 125：先记账再办。谁：大管家带 who（desk / handheld），录入僧网页、电脑版按 User-Agent 分大类 */
  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(LR_PATH);
    const w = url.searchParams.get('who') || req.headers.get('x-lr-who') || '';
    const who = m[1].startsWith('pc/') ? (WHO.includes(w) ? w : 'pc?') : clientClass(req);
    const op = (req.method + ' ' + m[1]).replace(/^(GET|POST) /, '$1 ');
    if (m[1] === 'pc/stats' && req.method === 'GET') {            // 只给数；要大管家的口令（跟 pc/state 一样）
      if (!(await this.pcOk(req))) { this.stats.hit(op, who, 403); return json({ error: 'not the butler' }, 403); }
      this.stats.hit(op, who, 200);
      const ms = this.machines();
      return json(this.stats.read({ lr: { machines: ms.map((x) => ({ who: x.who, cap: x.cap, busy: x.busy, free: x.free })), jobs: this.jobs.size, queued: this.queue.length, sockets: this.ctx.getWebSockets().length, tick: Boolean(this.tick) } }));
    }
    const res = await this.route(req, url, m);
    this.stats.hit(op, who, res.status);
    return res;
  }

  async route(req, url, m) {
    const what = m[1], arg = m[2];
    const method = req.method;
    const ip = await sha('lr-ip/' + this.salt() + '/' + (req.headers.get('x-lr-ip') || ''));

    if (what === 'hello' && method === 'GET') {
      const ms = this.machines();
      return json({ v: 2, on: ms.length > 0, pcs: ms.map((x) => x.who), cap: Object.fromEntries(ms.map((x) => [x.who, x.cap])), pub: this.getMeta('pub') });
    }

    if (what === 'pair' && method === 'POST') {
      if (Number(req.headers.get('Content-Length') || 0) > MAX_PAIR) return json({ error: 'too big' }, 413);
      let b;
      try { b = JSON.parse(await req.text()); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (!b || !ID_RE.test(b.cid || '') || !B64_RE.test(b.epk || '') || !B64_RE.test(b.n || '') || !B64_RE.test(b.ct || '')) return json({ error: 'bad pair' }, 400);
      const lk = this.lockOf(ip);
      if (lk.until) return json({ locked: true, until: lk.until }, 429);
      if (!this.machines().length) return json({ off: true }, 503);
      const r = await this.run('pair', b.cid, ip, { cid: b.cid, epk: b.epk, n: b.n, ct: b.ct }, this.pairMs);
      if (r.off) return json({ off: true }, 503);
      if (r.timeout) return json({ timeout: true }, 504);
      const a = r.answer;
      if (!a.ok) {
        this.sql.exec('INSERT INTO fails (ip, at) VALUES (?, ?)', ip, Date.now());
        const after = this.lockOf(ip);
        return json({ ok: false, wrong: true, left: Math.max(0, this.fails - after.n), ...(after.until ? { locked: true, until: after.until } : {}) });
      }
      const now = Date.now();
      this.sql.exec(`INSERT INTO clients (cid, label, at, last, uses, revoked) VALUES (?, ?, ?, NULL, 0, NULL)
        ON CONFLICT (cid) DO UPDATE SET label = excluded.label, at = excluded.at, revoked = NULL`, b.cid, String(a.label || '').slice(0, 80), now);
      return json({ ok: true, n: a.n, ct: a.ct });
    }

    if (what === 'ask' && method === 'POST') {
      if (Number(req.headers.get('Content-Length') || 0) > MAX_ASK) return json({ error: 'too big' }, 413);
      const text = await req.text();
      if (text.length > MAX_ASK) return json({ error: 'too big' }, 413);
      let b;
      try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (!b || !ID_RE.test(b.cid || '') || !B64_RE.test(b.n || '') || !B64_RE.test(b.ct || '')) return json({ error: 'bad ask' }, 400);
      const c = this.sql.exec('SELECT revoked FROM clients WHERE cid = ?', b.cid).toArray()[0];
      if (!c) return json({ unknown: true }, 403);
      if (c.revoked) return json({ revoked: true }, 403);
      const ms = this.machines();
      if (!ms.length) return json({ off: true }, 503);
      if (ms.every((x) => x.cap <= 0)) return json({ off: true, cant: true }, 503);   // 093：在线的都在打游戏
      const r = await this.run('ask', b.cid, ip, { cid: b.cid, n: b.n, ct: b.ct }, this.askMs);
      if (r.off) return json({ off: true, ...(r.cant ? { cant: true } : {}) }, 503);
      if (r.timeout) return json({ timeout: true, ...(r.queued ? { queued: true } : {}) }, 504);
      if (!r.answer.ok) return json({ ok: false, forget: Boolean(r.answer.forget), by: r.by });   // 大管家拆不开（钥匙对不上）：录入僧忘掉这次配对
      this.sql.exec('UPDATE clients SET last = ?, uses = uses + 1 WHERE cid = ?', Date.now(), b.cid);
      return json({ ok: true, n: r.answer.n, ct: r.answer.ct, by: r.by, qms: r.qms });
    }

    // ------------------------------------------------------------------ 大管家这头
    if (!(await this.pcOk(req))) return json({ error: 'not the butler' }, 403);
    const who = url.searchParams.get('who') || req.headers.get('x-lr-who') || '';
    if (!WHO.includes(who)) return json({ error: 'who=desk 或 who=handheld' }, 400);

    if (what === 'pc/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['pc']);
      const cap = url.searchParams.get('cap');
      server.serializeAttachment({ who, at: Date.now(), since: Date.now(), ...(cap !== null && cap !== '' ? { cap: clampCap(cap) } : {}) });
      this.hold.delete(who);
      this.pump();
      server.send(JSON.stringify({ t: 'hello', v: 1, who, pcs: this.machines().map((x) => x.who) }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (what === 'pc/pub' && method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b || !B64_RE.test(b.pub || '') || b.pub.length > 200) return json({ error: 'bad pub' }, 400);
      this.setMeta('pub', b.pub);
      return json({ ok: true });
    }

    if (what === 'pc/conf') {            // 两台大管家共用的设置（暗号），大管家自己加密过，站里看不懂
      if (method === 'GET') return json({ data: this.getMeta('conf') });
      if (method === 'POST') {
        const t = await req.text();
        if (!t || t.length > MAX_CONF) return json({ error: 'bad conf' }, 400);
        this.setMeta('conf', t);
        return json({ ok: true });
      }
    }

    if (what === 'pc/state' && method === 'GET') {
      const now = Date.now();
      const locks = this.sql.exec('SELECT ip, COUNT(*) AS n, MAX(at) AS last FROM fails WHERE at >= ? GROUP BY ip', now - 3600_000).toArray()
        .map((r) => ({ ip: r.ip.slice(0, 6), fails: r.n, last: r.last, until: r.n >= this.fails && r.last + this.lockMs > now ? r.last + this.lockMs : null }));
      const ms = this.machines();
      return json({ clients: this.clientRows(), locks, pcs: ms.map((x) => x.who), machines: ms.map((x) => ({ who: x.who, cap: x.cap, busy: x.busy, free: x.free })), queued: this.queue.length });
    }

    if (what === 'pc/revoke' && method === 'POST') {
      const b = await req.json().catch(() => null);
      const now = Date.now();
      if (b && b.all) this.sql.exec('UPDATE clients SET revoked = ? WHERE revoked IS NULL', now);
      else if (b && ID_RE.test(b.cid || '')) this.sql.exec('UPDATE clients SET revoked = ? WHERE cid = ?', b.undo ? null : now, b.cid);
      else return json({ error: 'cid 或 all' }, 400);
      return json({ ok: true, clients: this.clientRows() });
    }

    if (what === 'pc/job' && arg && method === 'GET') {   // 取活：先来先得，别的机器再来取回 409
      const j = this.jobs.get(arg);
      if (!j) return json({ error: 'gone' }, 404);
      if (j.by && j.by !== who) return json({ error: 'taken', by: j.by }, 409);
      if (j.kind === 'ask' && j.who !== who) return json({ error: 'not yours' }, 409);   // 093：放回队里了 / 交给另一台了
      if (!j.by) {
        j.by = who;
        clearTimeout(j.t);
        if (j.kind === 'ask') {            // 从取走算 5 分钟，排队的时间不算
          j.qms = Date.now() - j.at;
          clearTimeout(j.q); clearTimeout(j.w);
          j.w = setTimeout(() => j.done({ timeout: true }), j.ms);
        }
      }
      return json({ id: j.id, kind: j.kind, ...j.payload });
    }

    if (what === 'pc/answer' && arg && method === 'POST') {
      const j = this.jobs.get(arg);
      if (!j) return json({ error: 'gone' }, 404);
      if (j.by !== who) return json({ error: 'not yours' }, 409);
      const b = await req.json().catch(() => null);
      if (!b || typeof b.ok !== 'boolean' || (b.ok && (!B64_RE.test(b.n || '') || !B64_RE.test(b.ct || '')))) return json({ error: 'bad answer' }, 400);
      j.done({ answer: b, by: who, qms: j.qms });
      this.hold.delete(who);
      return json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }

  salt() {
    let s = this.getMeta('salt');
    if (!s) { s = rid(); this.setMeta('salt', s); }
    return s;
  }

  /** 心跳自动回了；093 收大管家报的 {"t":"cap","n":…}（能同时认几张，打游戏 0）、{"t":"no","id":…}（满了 / 刚开始打游戏，这件不接） */
  webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment() || {};
    if (typeof msg !== 'string' || msg.length > 300 || msg[0] !== '{') { this.stats.hit('wsmsg bad', a.who || '?'); return; }
    let m;
    try { m = JSON.parse(msg); } catch (e) { this.stats.hit('wsmsg bad', a.who || '?'); return; }
    this.stats.hit('wsmsg ' + (m && ['cap', 'no'].includes(m.t) ? m.t : 'other'), a.who || '?');
    if (!WHO.includes(a.who)) return;
    if (m.t === 'cap') {
      a.cap = clampCap(m.n);
      a.at = Date.now();
      ws.serializeAttachment(a);
      this.hold.delete(a.who);
      this.pump();
    } else if (m.t === 'no' && typeof m.id === 'string') {
      const j = this.jobs.get(m.id);
      if (!j || j.over || j.kind !== 'ask' || j.who !== a.who || j.by) return;
      clearTimeout(j.t);
      j.who = null;
      this.hold.add(a.who);
      this.queue.unshift(j);
      this.pump();
    }
  }

  webSocketClose(ws, code) { this.stats.hit('wsclose', (ws.deserializeAttachment() || {}).who || '?'); try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* 已经关了 */ } this.pump(); }
  webSocketError(ws) { this.webSocketClose(ws, 1011); }
}
