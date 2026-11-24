// 125 额度账 + 站里限速：每个口各数一笔、只数不记内容、读数的口只给数；狂敲的在进 Durable Object 之前就被挡成 429（带 Retry-After），
// 挡掉的不进账（没碰 Durable Object）。限速调得很小跑得快：每个信箱攒 6 下（线上 60）、连 WebSocket 攒 3 张（线上 10）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, socket, newBox, sleep } from './dev.mjs';

const PORT = 9600 + Math.floor(Math.random() * 100);
let dev, BASE, WS;
const TOK = 'S'.repeat(40);

before(async () => {
  dev = await startDev(PORT, '.wrangler/stats-state', ['LR_TEST:1', 'RL_HTTP_BURST:6', 'RL_HTTP_EVERY_S:30', 'RL_WS_BURST:3', 'RL_WS_EVERY_S:30']);
  BASE = dev.base;
  WS = BASE.replace('http', 'ws');
});
after(() => dev.stop());

const stats = async (b) => (await fetch(`${BASE}/dgj/${b}/stats`)).json();

test('dgj: every door is counted by who knocked, with the status; the stats hold counts and nothing else', async () => {
  const b = newBox();
  const desk = await socket(`${WS}/dgj/${b}/ws?as=pc&who=desk`);
  const SECRET = 'AAAA-secret-body-AAAA';
  const put = await fetch(`${BASE}/dgj/${b}/msg?to=pc&mid=REQ-STATS-1`, { method: 'PUT', body: SECRET, headers: { 'User-Agent': 'Dagj-handheld/abc123' } });
  const { seq } = await put.json();
  await desk.next((m) => m.t === 'msg');
  desk.send(JSON.stringify({ t: 'ack', seq }));
  await desk.next((m) => m.t === 'gone');
  desk.send('ping');
  await desk.next((m) => m.t === 'pong');
  const raw = await (await fetch(`${BASE}/dgj/${b}/stats`)).text();
  const st = JSON.parse(raw);
  assert.equal(st.route, 'dgj');
  assert.ok(!raw.includes(b), 'the box number must not be in the stats');
  assert.ok(!raw.includes(SECRET) && !raw.includes('REQ-STATS-1'), 'no letter content, no ids');
  assert.ok(!raw.includes('abc123') && !/Dagj-handheld/.test(raw), 'no User-Agent text');
  assert.equal(st.sum['ws pc|desk|101'], 1);
  assert.equal(st.sum['PUT msg>pc|dagj|200'], 1);
  assert.equal(st.sum['wsmsg ack|desk'], 1);
  assert.equal(st.box.pcs[0], 'desk');
  assert.equal(st.todayUTC >= 3, true);
  assert.equal(st.hours.length >= 1, true);
  assert.equal(st.hours.at(-1).total > 0, true);
  desk.close();
});

test('dgj: a client that hammers is turned away with 429 + Retry-After before it reaches the box; the turned-away are not counted', async () => {
  const b = newBox();
  const codes = [];
  let retry;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE}/dgj/${b}/state`);
    codes.push(r.status);
    if (r.status === 429) { retry = r.headers.get('retry-after'); assert.equal((await r.json()).error, 'slow down'); }
  }
  assert.deepEqual(codes.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.ok(codes.slice(6).every((c) => c === 429), codes.join());
  assert.ok(Number(retry) >= 1);
  const st = await fetch(`${BASE}/dgj/${b}/stats`);       // 桶也空了：读数也被挡
  assert.equal(st.status, 429);
  const other = newBox();                                  // 别的信箱不受影响
  assert.equal((await fetch(`${BASE}/dgj/${other}/state`)).status, 200);
});

test('dgj: reconnecting every moment is stopped at the WebSocket door too', async () => {
  const b = newBox();
  const ok = [];
  for (let i = 0; i < 3; i++) { const s = await socket(`${WS}/dgj/${b}/ws?as=phone`); ok.push(s); }
  await assert.rejects(socket(`${WS}/dgj/${b}/ws?as=phone`));
  const d = await socket(`${WS}/dgj/${b}/ws?as=pc&who=desk`);   // 别的角色另有一桶
  d.close();
  ok.forEach((s) => s.close());
});

test('lr: the stats door wants the butler token and counts the doors', async () => {
  const room = 'stats' + Date.now();
  const h = (tok) => ({ 'x-test-room': room, ...(tok ? { 'x-lr-token': tok, 'x-lr-who': 'desk' } : {}) });
  assert.equal((await fetch(`${BASE}/lr/hello`, { headers: h() })).status, 200);
  assert.equal((await fetch(`${BASE}/lr/pc/stats`, { headers: { 'x-test-room': room, 'x-lr-who': 'desk' } })).status, 403);   // 没口令不给
  const r = await fetch(`${BASE}/lr/pc/stats`, { headers: h(TOK) });
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.equal(st.route, 'lr');
  assert.equal(st.sum['GET hello|tool|200'] >= 0, true);
  assert.ok(Object.keys(st.sum).some((k) => k.startsWith('GET hello')));
  assert.ok(!JSON.stringify(st).includes(TOK));
});

test('r: the room door counts too (the page must send its Origin)', async () => {
  const room = 'room_' + Math.random().toString(36).slice(2).padEnd(20, 'x');
  const O = { Origin: 'https://qianshoulab.github.io' };
  await fetch(`${BASE}/r/${room}/items`, { headers: O });
  const st = await (await fetch(`${BASE}/r/${room}/stats`, { headers: O })).json();
  assert.equal(st.route, 'r');
  assert.equal(st.sum['GET items|web|200'], 1);
});
