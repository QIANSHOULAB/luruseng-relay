// 录入僧 ⇄ 大管家（施工单 089）：/lr/...
// 录入僧（网页版、电脑版）认照片先问大管家；大管家不在、没配对、超时，录入僧自己跳回 Gemini。
// - 配对：录入僧输一次暗号。暗号用大管家的公钥（P-256）加密着过来，站里看不见；对了，大管家给那个录入僧一把它自己的钥匙
//   （也是加密着回去），以后照片和结果都用那把钥匙加密，站里只转密文、不存（转完就扔）。
// - 站里只记：配上的是谁（cid、一句「哪个浏览器、哪台电脑」、什么时候配的、最后一次用、撤了没有），
//   哪个地方输错了几次（IP 只存加盐的哈希）。同一个地方一小时错 LR_FAILS 次（10）就锁一小时。
// - 大管家这头（电脑 who=desk、掌机 who=handheld）带一个口令（x-lr-token）连上来；站里只存口令的哈希，第一台连上来的定下它。
//   一件活只交一台：先电脑、后掌机；交过去 LR_TAKE_MS（8 秒）没来取就转给下一台。
// - 撤掉的、站里不认识的录入僧发来的照片：直接回 403，录入僧退回 Gemini。

const WHO = ['desk', 'handheld'];
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const B64_RE = /^[A-Za-z0-9_-]+$/;
const STALE_MS = 90_000;               // 90 秒没 ping：当它不在了（跟 /dgj 一样）
const TAKE_MS = 8_000;                 // 交给一台以后，这么久没来取，转给下一台
const ASK_MS = 75_000;                 // 认一张最多等多久（录入僧自己 60 秒就不等了）
const PAIR_MS = 30_000;                // 配对最多等多久
const FAILS = 10;                      // 一小时错几次锁
const LOCK_MS = 3600_000;              // 锁多久
const MAX_ASK = 8_000_000;             // 一张照片（加密后、base64）最大
const MAX_PAIR = 8_000;
const MAX_CONF = 8_000;

export const LR_PATH = /^\/lr\/(hello|pair|ask|pc\/(?:ws|pub|state|revoke|conf|job|answer))(?:\/([A-Za-z0-9_-]+))?$/;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
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
  const room = env.LR_TEST ? (req.headers.get('x-test-room') || new URL(req.url).searchParams.get('room')) : null;
  const name = room || 'main';           // 测试：每组一个干净的房间
  const res = await env.LURU.get(env.LURU.idFromName(name)).fetch(fwd);
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
    this.pairMs = num('LR_PAIR_MS', PAIR_MS);
    this.fails = num('LR_FAILS', FAILS);
    this.lockMs = num('LR_LOCK_MS', LOCK_MS);
    this.jobs = new Map();               // 正在等大管家回的活：只在内存里，回了就扔
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

  /** 在线的大管家，一台一项，先电脑、后掌机 */
  machines() {
    const now = Date.now();
    const by = new Map();
    for (const ws of this.ctx.getWebSockets('pc')) {
      const t = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const a = ws.deserializeAttachment() || {};
      const last = Math.max(a.at || 0, t ? t.getTime() : 0);
      if (now - last >= this.staleMs) continue;
      const m = by.get(a.who) || { who: a.who, socks: [] };
      m.socks.push(ws);
      by.set(a.who, m);
    }
    return [...by.values()].sort((x, y) => rank(x.who) - rank(y.who));
  }

  /** 锁着没有：一小时里错满 LR_FAILS 次，从最后一次错起锁一小时 */
  lockOf(ip) {
    const now = Date.now();
    this.sql.exec('DELETE FROM fails WHERE at < ?', now - Math.max(this.lockMs, 3600_000));
    const r = this.sql.exec('SELECT COUNT(*) AS n, MAX(at) AS last FROM fails WHERE ip = ? AND at >= ?', ip, now - 3600_000).one();
    const until = r.n >= this.fails ? r.last + this.lockMs : 0;
    return { n: r.n, until: until > now ? until : 0 };
  }

  /** 交一件活给大管家，等它回（或者超时、没人在） */
  run(kind, cid, ip, payload, ms) {
    const j = { id: rid(), kind, cid, ip, payload, skip: [], who: null, by: null, t: null };
    const p = new Promise((ok) => { j.done = ok; });
    this.jobs.set(j.id, j);
    const all = setTimeout(() => j.done({ timeout: true }), ms);
    this.give(j);
    return p.finally(() => { clearTimeout(all); clearTimeout(j.t); this.jobs.delete(j.id); });
  }

  give(j) {
    const on = this.machines().filter((m) => !j.skip.includes(m.who));
    if (!on.length) { if (!j.who) j.done({ off: true }); return; }   // 没有下一台：还等交过去的那台
    const m = on[0];
    j.who = m.who;
    const s = JSON.stringify({ t: 'job', id: j.id, kind: j.kind });
    for (const ws of m.socks) { try { ws.send(s); } catch (e) { /* 断了 */ } }
    j.t = setTimeout(() => { if (!j.by) { j.skip.push(m.who); this.give(j); } }, this.takeMs);
  }

  clientRows() {
    return this.sql.exec('SELECT cid, label, at, last, uses, revoked FROM clients ORDER BY at').toArray();
  }

  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(LR_PATH);
    const what = m[1], arg = m[2];
    const method = req.method;
    const ip = await sha('lr-ip/' + this.salt() + '/' + (req.headers.get('x-lr-ip') || ''));

    if (what === 'hello' && method === 'GET') {
      return json({ v: 1, on: this.machines().length > 0, pcs: this.machines().map((x) => x.who), pub: this.getMeta('pub') });
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
      if (!this.machines().length) return json({ off: true }, 503);
      const r = await this.run('ask', b.cid, ip, { cid: b.cid, n: b.n, ct: b.ct }, this.askMs);
      if (r.off) return json({ off: true }, 503);
      if (r.timeout) return json({ timeout: true }, 504);
      if (!r.answer.ok) return json({ ok: false, forget: Boolean(r.answer.forget), by: r.by });   // 大管家拆不开（钥匙对不上）：录入僧忘掉这次配对
      this.sql.exec('UPDATE clients SET last = ?, uses = uses + 1 WHERE cid = ?', Date.now(), b.cid);
      return json({ ok: true, n: r.answer.n, ct: r.answer.ct, by: r.by });
    }

    // ------------------------------------------------------------------ 大管家这头
    if (!(await this.pcOk(req))) return json({ error: 'not the butler' }, 403);
    const who = url.searchParams.get('who') || req.headers.get('x-lr-who') || '';
    if (!WHO.includes(who)) return json({ error: 'who=desk 或 who=handheld' }, 400);

    if (what === 'pc/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['pc']);
      server.serializeAttachment({ who, at: Date.now() });
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
      return json({ clients: this.clientRows(), locks, pcs: this.machines().map((x) => x.who) });
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
      j.by = who;
      return json({ id: j.id, kind: j.kind, ...j.payload });
    }

    if (what === 'pc/answer' && arg && method === 'POST') {
      const j = this.jobs.get(arg);
      if (!j) return json({ error: 'gone' }, 404);
      if (j.by !== who) return json({ error: 'not yours' }, 409);
      const b = await req.json().catch(() => null);
      if (!b || typeof b.ok !== 'boolean' || (b.ok && (!B64_RE.test(b.n || '') || !B64_RE.test(b.ct || '')))) return json({ error: 'bad answer' }, 400);
      j.done({ answer: b, by: who });
      return json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }

  salt() {
    let s = this.getMeta('salt');
    if (!s) { s = rid(); this.setMeta('salt', s); }
    return s;
  }

  webSocketMessage() { /* 只收心跳（自动回了） */ }
  webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* 已经关了 */ } }
  webSocketError(ws) { this.webSocketClose(ws, 1011); }
}
