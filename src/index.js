// 录入僧 · 手机传图中转站（Cloudflare Worker + Durable Object）
// 手机把加密好的照片放这儿，电脑取走就删。站里只有加密过的数据：开锁的钥匙只在手机和电脑上（藏在二维码里），从不经过这里。
// 一个通道（room）= 一台电脑配的对；扫过这个码的手机都往这个通道传。

const MAX_BYTES = 1_990_000;            // 一张最大（Durable Object 一行最多 2MB；手机那边会先压到 1.9MB 以下）
const MAX_ITEMS = 300;                  // 一个通道最多攒多少张没取的
const KEEP_MS = 3 * 24 * 3600 * 1000;   // 没人取的照片放 3 天自动删
const MAX_STATUS = 4096;                // 电脑报的进度（加密过的）最长
const ROOM_RE = /^[A-Za-z0-9_-]{20,64}$/;
const BATCH_RE = /^[A-Za-z0-9_-]{6,64}$/;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function cors(req, env) {                // 只认录入僧网页发来的（ALLOW_ORIGINS），别的网站拿不去用
  const origin = req.headers.get('Origin') || '';
  const allow = String(env.ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.includes('*') && !allow.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin',
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/ping') {
      return new Response('录入僧中转站：在。\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    }
    const m = url.pathname.match(/^\/r\/([^/]+)\/(ws|items|item|status)(?:\/(\d+))?$/);
    if (!m || !ROOM_RE.test(m[1])) return new Response('not found', { status: 404 });
    const h = cors(req, env);
    if (!h) return new Response('origin not allowed', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const res = await env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    if (res.status === 101) return res;  // WebSocket
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
    return out;
  },
};

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL, seq INTEGER NOT NULL, total INTEGER NOT NULL,
      at INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE (batch, seq))`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));   // 心跳不用叫醒它
  }

  items() { return this.sql.exec('SELECT id, batch, seq, total, at, size FROM items ORDER BY id').toArray(); }
  status() {
    const r = this.sql.exec("SELECT v FROM meta WHERE k = 'status'").toArray()[0];
    return r ? JSON.parse(r.v) : null;
  }
  pcOnline(except = null) { return this.ctx.getWebSockets('pc').some((ws) => ws !== except); }
  send(msg, tag = undefined, except = null) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(tag)) {
      if (ws === except) continue;
      try { ws.send(s); } catch (e) { /* 断了的不管 */ }
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, , , what, arg] = url.pathname.split('/');
    const method = req.method;

    if (what === 'ws') {                 // 电脑（?as=pc）、手机（?as=phone）都挂一根长连接：来了新照片、电脑报进度，马上推过去
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const role = url.searchParams.get('as') === 'pc' ? 'pc' : 'phone';
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [role]);
      server.send(JSON.stringify({ t: 'hello', items: this.items(), status: this.status(), pc: this.pcOnline() }));
      if (role === 'pc') this.send({ t: 'pc', on: true }, 'phone');
      return new Response(null, { status: 101, webSocket: client });
    }

    if (what === 'items' && method === 'GET') return json(this.items());

    if (what === 'item' && !arg && method === 'PUT') {
      const batch = url.searchParams.get('batch') || '';
      const seq = Number(url.searchParams.get('seq')), total = Number(url.searchParams.get('total'));
      if (!BATCH_RE.test(batch) || !Number.isInteger(seq) || !Number.isInteger(total) || seq < 1 || total < 1 || seq > total || total > MAX_ITEMS) {
        return json({ error: 'bad batch/seq/total' }, 400);
      }
      if (Number(req.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: `太大了：一张最多 ${MAX_BYTES} 字节` }, 413);
      const data = await req.arrayBuffer();
      if (!data.byteLength || data.byteLength > MAX_BYTES) return json({ error: `太大了：一张最多 ${MAX_BYTES} 字节` }, 413);
      const had = this.sql.exec('SELECT id FROM items WHERE batch = ? AND seq = ?', batch, seq).toArray()[0];
      if (had) return json({ id: had.id, again: true });           // 手机重传同一张：不存第二份
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM items').one().n;
      if (n >= MAX_ITEMS) return json({ error: `通道满了：已经攒了 ${n} 张没取，电脑打开录入僧网页版就会取走` }, 429);
      const at = Date.now();
      this.sql.exec('INSERT INTO items (batch, seq, total, at, size, data) VALUES (?, ?, ?, ?, ?, ?)', batch, seq, total, at, data.byteLength, data);
      const id = this.sql.exec('SELECT last_insert_rowid() AS id').one().id;
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(at + KEEP_MS + 60_000);
      this.send({ t: 'new', item: { id, batch, seq, total, at, size: data.byteLength } });
      return json({ id, pc: this.pcOnline() });
    }

    if (what === 'item' && arg && method === 'GET') {
      const r = this.sql.exec('SELECT data FROM items WHERE id = ?', Number(arg)).toArray()[0];
      if (!r) return json({ error: 'gone' }, 404);
      return new Response(r.data, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }

    if (what === 'item' && arg && method === 'DELETE') {   // 电脑取走了：删掉，告诉手机「电脑收到了」
      const r = this.sql.exec('SELECT batch, seq FROM items WHERE id = ?', Number(arg)).toArray()[0];
      if (r) {
        this.sql.exec('DELETE FROM items WHERE id = ?', Number(arg));
        this.send({ t: 'gone', id: Number(arg), batch: r.batch, seq: r.seq });
      }
      return json({ ok: true });
    }

    if (what === 'status' && method === 'GET') return json(this.status());
    if (what === 'status' && method === 'PUT') {        // 电脑报进度（加密过的），手机那边显示「开工了 3/10」「干完了」
      const text = await req.text();
      if (!text || text.length > MAX_STATUS) return json({ error: 'bad status' }, 400);
      const st = { data: text, at: Date.now() };
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('status', ?)", JSON.stringify(st));
      this.send({ t: 'status', status: st });
      return json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }

  webSocketMessage() { /* 只收心跳（自动回了）；别的不认 */ }
  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* 已经关了 */ }
    if (this.ctx.getWebSockets('pc').includes(ws)) this.send({ t: 'pc', on: this.pcOnline(ws) }, 'phone');
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011); }

  async alarm() {                        // 放了 3 天没人取的：删掉
    const cut = Date.now() - KEEP_MS;
    const old = this.sql.exec('SELECT id, batch, seq FROM items WHERE at < ?', cut).toArray();
    if (old.length) {
      this.sql.exec('DELETE FROM items WHERE at < ?', cut);
      for (const r of old) this.send({ t: 'gone', id: r.id, batch: r.batch, seq: r.seq, expired: true });
    }
    const next = this.sql.exec('SELECT MIN(at) AS a FROM items').one().a;
    if (next) await this.ctx.storage.setAlarm(next + KEEP_MS + 60_000);
  }
}
