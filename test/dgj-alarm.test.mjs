// 125：闹钟不能空转。大管家拿了信（或者没来得及拿）就断了，之后一台机器都不在线：信箱不能每 0.1 秒响一次闹钟（每响一次算一次请求，
// 一天免费 10 万次，线上就是这样被吃光的）。机器连上来以后照常把信交出去。
// 时间调小：断了宽限 0.5 秒（线上 10 秒）、1.5 秒不 ping 算不在（线上 90 秒）、等「接了」1 秒（线上 20 秒）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, socket, newBox, sleep } from './dev.mjs';

const PORT = 9500 + Math.floor(Math.random() * 100);
let dev, BASE, WS;

before(async () => {
  dev = await startDev(PORT, '.wrangler/dgj-alarm-state', ['DGJ_TAKE_MS:1000', 'DGJ_GRACE_MS:500', 'DGJ_STALE_MS:1500']);
  BASE = dev.base;
  WS = BASE.replace('http', 'ws');
});
after(() => dev.stop());

const put = (b, to, mid) => fetch(`${BASE}/dgj/${b}/msg?to=${to}&mid=${mid}`, { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]) });
const stats = async (b) => (await fetch(`${BASE}/dgj/${b}/stats`)).json();
const alarms = (st) => Object.entries(st.sum).filter(([k]) => k === 'alarm' || k.startsWith('alarm|')).reduce((a, [, n]) => a + n, 0);

test('the butler took a letter and vanished: nothing is on, the alarm does not spin', async () => {
  const b = newBox();
  const desk = await socket(`${WS}/dgj/${b}/ws?as=pc&who=desk`);
  const { seq } = await (await put(b, 'pc', 'REQ-SPIN-1')).json();
  await desk.next((m) => m.t === 'msg');
  desk.send(JSON.stringify({ t: 'take', seq }));
  await desk.next((m) => m.t === 'took');
  desk.close();
  await sleep(4000);                                  // 断了、宽限过了、一台都不在
  const st = await stats(b);
  assert.deepEqual(st.box.pcs, []);
  assert.equal(st.box.lost, 1);
  const n = alarms(st);
  assert.ok(n <= 5, `alarm fired ${n} times in 4 s with nobody on`);
});

test('the butler never took it and vanished: same, and a butler that comes back gets the letter', async () => {
  const b = newBox();
  const desk = await socket(`${WS}/dgj/${b}/ws?as=pc&who=desk`);
  const { seq } = await (await put(b, 'pc', 'REQ-SPIN-2')).json();
  await desk.next((m) => m.t === 'msg');
  desk.close();
  await sleep(4000);
  const n = alarms(await stats(b));
  assert.ok(n <= 5, `alarm fired ${n} times in 4 s with nobody on`);
  const hand = await socket(`${WS}/dgj/${b}/ws?as=pc&who=handheld`);
  const hello = await hand.next((m) => m.t === 'hello');
  assert.deepEqual(hello.items.map((i) => i.seq), [seq]);
  hand.close();
});

test('the only butler on never says it took it: no other to pass it to, no spinning', async () => {
  const b = newBox();
  const desk = await socket(`${WS}/dgj/${b}/ws?as=pc&who=desk`);
  const t = setInterval(() => { try { desk.send('ping'); } catch (e) { /* 关了 */ } }, 500);
  await put(b, 'pc', 'REQ-SPIN-3');
  await desk.next((m) => m.t === 'msg');
  await sleep(4000);
  const n = alarms(await stats(b));
  clearInterval(t);
  assert.ok(n <= 6, `alarm fired ${n} times in 4 s`);
  desk.close();
});
