// 中转站本地跑一遍（不用 Cloudflare 账号）：npm test
// 起一个 wrangler dev，真的发请求、真的连 WebSocket。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'https://qianshoulab.github.io';
const room = () => 'room_' + Math.random().toString(36).slice(2).padEnd(20, 'x');
let dev;

before(async () => {
  dev = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', '.wrangler/test-state'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, detached: true,
  });
  let out = '';
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('wrangler dev 没起来：\n' + out)), 90000);
    const look = (d) => { out += d; if (/Ready on/.test(out)) { clearTimeout(t); ok(); } };
    dev.stdout.on('data', look);
    dev.stderr.on('data', look);
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/ping')).ok) break; } catch (e) { /* 还没好 */ } await new Promise((r) => setTimeout(r, 200)); }
});
after(() => {                            // npx 底下还有 wrangler、workerd：整组一起关，不然测试退不出去
  try { process.kill(-dev.pid, 'SIGTERM'); } catch (e) { /* 已经没了 */ }
  dev.stdout.destroy();
  dev.stderr.destroy();
});

const put = (r, q, body, origin = ORIGIN) => fetch(`${BASE}/r/${r}/item?${q}`, { method: 'PUT', body, headers: { Origin: origin } });
const get = (r, path, origin = ORIGIN) => fetch(`${BASE}/r/${r}/${path}`, { headers: { Origin: origin } });
const del = (r, id) => fetch(`${BASE}/r/${r}/item/${id}`, { method: 'DELETE', headers: { Origin: ORIGIN } });
function ws(r, as) {
  const s = new WebSocket(`${BASE.replace('http', 'ws')}/r/${r}/ws?as=${as}`, { headers: { Origin: ORIGIN } });
  s.got = [];
  s.waiters = [];
  s.onmessage = (e) => { const m = JSON.parse(e.data); s.got.push(m); s.waiters = s.waiters.filter((w) => !w(m)); };
  s.next = (pred) => new Promise((ok, bad) => {
    const hit = s.got.find(pred);
    if (hit) return ok(hit);
    const t = setTimeout(() => bad(new Error('等不到消息，收到的：' + JSON.stringify(s.got))), 5000);
    s.waiters.push((m) => (pred(m) ? (clearTimeout(t), ok(m), true) : false));
  });
  return new Promise((ok, bad) => { s.onopen = () => ok(s); s.onerror = (e) => bad(e); });
}

test('alive', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /中转站/);
});

test('photo goes in, PC is told at once, takes it, phone hears it was taken', async () => {
  const r = room();
  const pc = await ws(r, 'pc');
  const phone = await ws(r, 'phone');
  const hello = await phone.next((m) => m.t === 'hello');
  assert.equal(hello.pc, true);                                  // 手机看得见电脑在线
  const body = new Uint8Array(300_000).map((_, i) => i % 251);
  const res = await put(r, 'batch=b_abcdef&seq=1&total=2', body);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const { id, pc: online } = await res.json();
  assert.ok(id > 0 && online === true);
  const pushed = await pc.next((m) => m.t === 'new');
  assert.deepEqual([pushed.item.id, pushed.item.batch, pushed.item.seq, pushed.item.total, pushed.item.size], [id, 'b_abcdef', 1, 2, 300_000]);
  const again = await (await put(r, 'batch=b_abcdef&seq=1&total=2', body)).json();
  assert.deepEqual([again.id, again.again], [id, true]);           // 重传同一张：不存第二份
  assert.equal((await (await get(r, 'items')).json()).length, 1);
  const back = new Uint8Array(await (await get(r, `item/${id}`)).arrayBuffer());
  assert.deepEqual(back, body);                                   // 一个字节不差
  assert.equal((await del(r, id)).status, 200);
  const gone = await phone.next((m) => m.t === 'gone');
  assert.deepEqual([gone.id, gone.batch, gone.seq], [id, 'b_abcdef', 1]);
  assert.equal((await get(r, `item/${id}`)).status, 404);
  assert.deepEqual(await (await get(r, 'items')).json(), []);
  pc.close();
  const off = await phone.next((m) => m.t === 'pc' && m.on === false);
  assert.equal(off.on, false);                                    // 电脑关了：手机知道
  phone.close();
});

test('photos sent while the PC is away wait for it', async () => {
  const r = room();
  for (let i = 1; i <= 3; i++) assert.equal((await put(r, `batch=b_wait01&seq=${i}&total=3`, new Uint8Array([i, i, i]))).status, 200);
  const pc = await ws(r, 'pc');
  const hello = await pc.next((m) => m.t === 'hello');
  assert.deepEqual(hello.items.map((x) => x.seq), [1, 2, 3]);
  pc.close();
});

test('PC reports progress (already encrypted); phones get it pushed and on connect', async () => {
  const r = room();
  const phone = await ws(r, 'phone');
  assert.equal((await fetch(`${BASE}/r/${r}/status`, { method: 'PUT', body: 'Y2lwaGVy', headers: { Origin: ORIGIN } })).status, 200);
  const pushed = await phone.next((m) => m.t === 'status');
  assert.equal(pushed.status.data, 'Y2lwaGVy');
  const later = await ws(r, 'phone');
  assert.equal((await later.next((m) => m.t === 'hello')).status.data, 'Y2lwaGVy');
  phone.close(); later.close();
});

test('guards: other websites, bad room names, oversize photos, nonsense numbers', async () => {
  const r = room();
  assert.equal((await put(r, 'batch=b_abcdef&seq=1&total=1', new Uint8Array(10), 'https://evil.example')).status, 403);
  assert.equal((await fetch(`${BASE}/r/short/items`, { headers: { Origin: ORIGIN } })).status, 404);
  assert.equal((await put(r, 'batch=b_abcdef&seq=1&total=1', new Uint8Array(2_000_001))).status, 413);
  assert.equal((await put(r, 'batch=b_abcdef&seq=3&total=2', new Uint8Array(10))).status, 400);
  assert.equal((await put(r, 'batch=x&seq=1&total=1', new Uint8Array(10))).status, 400);
  const pre = await fetch(`${BASE}/r/${r}/item`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
});
