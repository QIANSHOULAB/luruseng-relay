// 信箱的两个「时间到了」：没人取的信过期删掉（线上 7 天）、掌机不再 ping 就算不在（线上 90 秒）。
// 这里用 --var 调成 2 秒、1.5 秒，跑得快；另起一个 wrangler dev，免得影响别的测试。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, socket, newBox, sleep } from './dev.mjs';

const PORT = 9200 + Math.floor(Math.random() * 100);
let dev, BASE, WS;

before(async () => {
  dev = await startDev(PORT, '.wrangler/dgj-expire-state', ['DGJ_KEEP_MS:2000', 'DGJ_STALE_MS:1500']);
  BASE = dev.base;
  WS = BASE.replace('http', 'ws');
});
after(() => dev.stop());

test('mail nobody takes is deleted when its time is up, and both sides are told', async () => {
  const b = newBox();
  const phone = await socket(`${WS}/dgj/${b}/ws?as=phone`);
  const r = await fetch(`${BASE}/dgj/${b}/msg?to=pc&mid=OLD-REQ-1`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
  const { seq } = await r.json();
  const gone = await phone.next((m) => m.t === 'gone', 10000);
  assert.deepEqual([gone.seq, gone.mid, gone.expired], [seq, 'OLD-REQ-1', true]);
  assert.equal((await fetch(`${BASE}/dgj/${b}/msg/${seq}`)).status, 404);
  assert.deepEqual((await (await fetch(`${BASE}/dgj/${b}/state`)).json()).pending, { pc: 0, phone: 0 });
  phone.close();
});

test('a butler that pinged and then went quiet counts as gone; pinging again brings it back', async () => {
  const b = newBox();
  const state = async () => (await fetch(`${BASE}/dgj/${b}/state`)).json();
  const pc = await socket(`${WS}/dgj/${b}/ws?as=pc`);
  assert.equal((await state()).pc, true);
  pc.send('ping');
  await pc.next((m) => m.t === 'pong');
  const pinged = Date.now();
  assert.equal((await state()).pc, true);
  await sleep(2200);                                                  // 连接还在，可它不 ping 了（掌机睡了、网断了一半）
  const st = await state();
  assert.equal(st.pc, false);
  assert.ok(Math.abs(st.pcSeen - pinged) < 1500, `pcSeen ${st.pcSeen} vs ${pinged}`);
  pc.send('ping');
  await pc.next((m) => m.t === 'pong' && pc.got.filter((x) => x.t === 'pong').length === 2);
  assert.equal((await state()).pc, true);
  pc.close();
});

test('a butler that connected and never pinged counts as gone after the same time', async () => {
  const b = newBox();
  const state = async () => (await fetch(`${BASE}/dgj/${b}/state`)).json();
  const pc = await socket(`${WS}/dgj/${b}/ws?as=pc`);
  const connected = Date.now();
  assert.equal((await state()).pc, true);                             // 刚连上，还没到 ping 的时候：算在
  await sleep(2200);                                                  // 连上就睡了，一声 ping 都没有
  const st = await state();
  assert.equal(st.pc, false);
  assert.ok(Math.abs(st.pcSeen - connected) < 1500, `pcSeen ${st.pcSeen} vs ${connected}`);
  pc.send('ping');
  await pc.next((m) => m.t === 'pong');
  assert.equal((await state()).pc, true);
  pc.close();
});
