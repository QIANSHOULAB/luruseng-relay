// 070 接口 v3：电脑、掌机都连着信箱时，寄给大管家的信只交给一台（先电脑、后掌机），拿到的回「接了」；
// 没回、断了、不 ping 了就转给下一台；不带 who 的老掌机照 v2；回手机的信同一个请求只收一份。
// 时间调小了跑得快：等「接了」1.5 秒（线上 20 秒）、断了宽限 1 秒（线上 10 秒）、3 秒不 ping 算不在（线上 90 秒）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, socket, newBox, sleep } from './dev.mjs';

const PORT = 9300 + Math.floor(Math.random() * 100);
let dev, BASE, WS;

before(async () => {
  dev = await startDev(PORT, '.wrangler/dgj-v3-state', ['DGJ_TAKE_MS:1500', 'DGJ_GRACE_MS:1000', 'DGJ_STALE_MS:3000']);
  BASE = dev.base;
  WS = BASE.replace('http', 'ws');
});
after(() => dev.stop());

const put = (b, to, mid, extra = '') => fetch(`${BASE}/dgj/${b}/msg?to=${to}&mid=${mid}${extra}`, { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]) });
const state = async (b) => (await fetch(`${BASE}/dgj/${b}/state`)).json();
const pc = (b, who) => socket(`${WS}/dgj/${b}/ws?as=pc${who ? `&who=${who}` : ''}`);
const letters = (s) => s.got.filter((m) => m.t === 'msg');
const take = (s, seq) => s.send(JSON.stringify({ t: 'take', seq }));
/** 等的时候让这几个口子照常 ping（线上 30 秒一次），免得它们自己也被当成不在了 */
function keepAlive(...socks) {
  const t = setInterval(() => { for (const s of socks) { try { s.send('ping'); } catch (e) { /* 关了 */ } } }, 700);
  return () => clearInterval(t);
}

test('desk and handheld both on: the letter goes to the desk only, the desk says it took it', async () => {
  const b = newBox();
  const desk = await pc(b, 'desk');
  const hand = await pc(b, 'handheld');
  const stop = keepAlive(desk, hand);
  const hello = await desk.next((m) => m.t === 'hello');
  assert.deepEqual([hello.v, hello.who], [3, 'desk']);
  assert.deepEqual((await state(b)).pcs, ['desk', 'handheld']);
  const { seq } = await (await put(b, 'pc', 'REQ-BOTH-1')).json();
  assert.equal((await desk.next((m) => m.t === 'msg')).item.seq, seq);
  take(desk, seq);
  await desk.next((m) => m.t === 'took' && m.seq === seq);
  await sleep(2200);                                                  // 过了等「接了」的时间，也没转
  assert.equal(letters(hand).length, 0);
  desk.send(JSON.stringify({ t: 'ack', seq }));
  await hand.next((m) => m.t === 'gone' && m.seq === seq);
  stop(); desk.close(); hand.close();
});

test('the desk is not on: the handheld gets it', async () => {
  const b = newBox();
  const hand = await pc(b, 'handheld');
  const { seq } = await (await put(b, 'pc', 'REQ-HAND-1')).json();
  assert.equal((await hand.next((m) => m.t === 'msg')).item.seq, seq);
  take(hand, seq);
  await hand.next((m) => m.t === 'took' && m.seq === seq);
  hand.close();
});

test('the desk does not say it took it in time: passed on to the handheld, the late word is turned down', async () => {
  const b = newBox();
  const desk = await pc(b, 'desk');
  const hand = await pc(b, 'handheld');
  const stop = keepAlive(desk, hand);
  const t0 = Date.now();
  const { seq } = await (await put(b, 'pc', 'REQ-SLOW-1')).json();
  await desk.next((m) => m.t === 'msg');                              // 电脑收到了，可它一声不吭
  assert.equal((await hand.next((m) => m.t === 'msg', 8000)).item.seq, seq);
  assert.ok(Date.now() - t0 >= 1400, `passed on after ${Date.now() - t0} ms`);
  take(desk, seq);
  assert.equal((await desk.next((m) => m.t === 'nope' && m.seq === seq)).by, 'handheld');
  take(hand, seq);
  await hand.next((m) => m.t === 'took' && m.seq === seq);
  stop(); desk.close(); hand.close();
});

test('240: the desk says the letter is not its own (pass): the handheld gets it at once, not after the wait', async () => {
  const b = newBox();
  const desk = await pc(b, 'desk');
  const hand = await pc(b, 'handheld');
  const stop = keepAlive(desk, hand);
  const { seq } = await (await put(b, 'pc', 'REQ-PASS-1')).json();
  await desk.next((m) => m.t === 'msg');
  const t0 = Date.now();
  desk.send(JSON.stringify({ t: 'pass', seq }));
  assert.equal((await hand.next((m) => m.t === 'msg', 8000)).item.seq, seq);
  assert.ok(Date.now() - t0 < 1000, `passed on after ${Date.now() - t0} ms`);
  take(hand, seq);
  await hand.next((m) => m.t === 'took' && m.seq === seq);
  hand.send(JSON.stringify({ t: 'pass', seq }));                      // the one that took it cannot pass it any more
  take(desk, seq);
  assert.equal((await desk.next((m) => m.t === 'nope' && m.seq === seq)).by, 'handheld');
  stop(); desk.close(); hand.close();
});

test('240: a pass with nobody next waits for the next machine; a pass from one that does not hold the letter is ignored', async () => {
  const b = newBox();
  const desk = await pc(b, 'desk');
  const stop = keepAlive(desk);
  const { seq } = await (await put(b, 'pc', 'REQ-PASS-2')).json();
  await desk.next((m) => m.t === 'msg');
  desk.send(JSON.stringify({ t: 'pass', seq }));                      // nobody next: nothing moves
  await sleep(300);
  const hand = await pc(b, 'handheld');
  const stop2 = keepAlive(hand);
  const hello = await hand.next((m) => m.t === 'hello');
  assert.deepEqual((hello.items || []).map((i) => i.seq), [seq]);    // the next one to come gets it
  const { seq: seq2 } = await (await put(b, 'pc', 'REQ-PASS-3')).json();
  await desk.next((m) => m.t === 'msg' && m.item.seq === seq2);
  hand.send(JSON.stringify({ t: 'pass', seq: seq2 }));                // not the handheld's: ignored
  await sleep(300);
  assert.equal(letters(hand).filter((m) => m.item.seq === seq2).length, 0);
  take(desk, seq2);
  await desk.next((m) => m.t === 'took' && m.seq === seq2);
  stop(); stop2(); desk.close(); hand.close();
});

test('the desk took it and dropped off: after the grace it goes to the handheld; the desk coming back does not get it', async () => {
  const b = newBox();
  const desk = await pc(b, 'desk');
  const hand = await pc(b, 'handheld');
  const stop = keepAlive(hand);
  const { seq } = await (await put(b, 'pc', 'REQ-DROP-1')).json();
  await desk.next((m) => m.t === 'msg');
  take(desk, seq);
  await desk.next((m) => m.t === 'took');
  const t0 = Date.now();
  desk.close();
  assert.equal((await hand.next((m) => m.t === 'msg', 8000)).item.seq, seq);
  assert.ok(Date.now() - t0 >= 900, `passed on after ${Date.now() - t0} ms`);
  take(hand, seq);
  await hand.next((m) => m.t === 'took');
  const back = await pc(b, 'desk');
  assert.deepEqual((await back.next((m) => m.t === 'hello')).items, []);   // 接了的信，别的机器连上来也不给
  await sleep(300);
  assert.equal(letters(back).length, 0);
  stop(); back.close(); hand.close();
});

test('a desk that drops and is back within the grace keeps its letter', async () => {
  const b = newBox();
  const desk = await pc(b, 'desk');
  const hand = await pc(b, 'handheld');
  const stop = keepAlive(hand);
  const { seq } = await (await put(b, 'pc', 'REQ-BLIP-1')).json();
  await desk.next((m) => m.t === 'msg');
  take(desk, seq);
  await desk.next((m) => m.t === 'took');
  desk.close();
  const again = await pc(b, 'desk');
  assert.deepEqual((await again.next((m) => m.t === 'hello')).items.map((x) => x.seq), [seq]);
  await sleep(1800);
  assert.equal(letters(hand).length, 0);
  stop(); again.close(); hand.close();
});

test('the desk took it and went quiet (no pings): counted gone, the handheld gets it', async () => {
  const b = newBox();
  const desk = await pc(b, 'desk');
  const hand = await pc(b, 'handheld');
  const stop = keepAlive(hand);                                       // 掌机照常 ping，电脑不 ping 了（睡了、网断了一半）
  const { seq } = await (await put(b, 'pc', 'REQ-QUIET-1')).json();
  await desk.next((m) => m.t === 'msg');
  take(desk, seq);
  await desk.next((m) => m.t === 'took');
  assert.equal((await hand.next((m) => m.t === 'msg', 10000)).item.seq, seq);
  assert.deepEqual((await state(b)).pcs, ['handheld']);
  stop(); desk.close(); hand.close();
});

test('an old handheld without who: alone it gets letters as in v2 with no word back; with the desk on, the desk comes first', async () => {
  const b = newBox();
  const old = await pc(b);
  const stop = keepAlive(old);
  const s1 = (await (await put(b, 'pc', 'REQ-OLD-1')).json()).seq;
  assert.equal((await old.next((m) => m.t === 'msg')).item.seq, s1);
  await sleep(1800);                                                  // 不回「接了」也不转
  old.send(JSON.stringify({ t: 'ack', seq: s1 }));
  await old.next((m) => m.t === 'gone' && m.seq === s1);
  const desk = await pc(b, 'desk');
  assert.deepEqual((await state(b)).pcs, ['desk', 'pc']);
  const s2 = (await (await put(b, 'pc', 'REQ-OLD-2')).json()).seq;
  assert.equal((await desk.next((m) => m.t === 'msg')).item.seq, s2);
  await sleep(300);
  assert.equal(letters(old).filter((m) => m.item.seq === s2).length, 0);
  stop(); old.close(); desk.close();
});

test('two answers to one request: the phone gets only the first, even after it took the first away', async () => {
  const b = newBox();
  const phone = await socket(`${WS}/dgj/${b}/ws?as=phone`);
  await phone.next((m) => m.t === 'hello');
  const first = await (await put(b, 'phone', 'RES-ONE-1', '&re=REQ-ONE-1')).json();
  assert.ok(first.seq > 0);
  const second = await (await put(b, 'phone', 'RES-ONE-2', '&re=REQ-ONE-1')).json();
  assert.deepEqual([second.again, second.dup, second.seq], [true, true, null]);
  await phone.next((m) => m.t === 'msg' && m.item.seq === first.seq);
  await sleep(300);
  assert.equal(letters(phone).length, 1);
  assert.deepEqual((await state(b)).pending, { pc: 0, phone: 1 });
  phone.send(JSON.stringify({ t: 'ack', seq: first.seq }));
  await phone.next((m) => m.t === 'gone');
  assert.equal((await (await put(b, 'phone', 'RES-ONE-3', '&re=REQ-ONE-1')).json()).dup, true);
  const asked = await (await fetch(`${BASE}/dgj/${b}/replied/REQ-ONE-1`)).json();   // 配之前先问一句：回过了
  assert.deepEqual([asked.replied, asked.at], [true, first.at]);
  assert.equal((await (await fetch(`${BASE}/dgj/${b}/replied/REQ-NONE-1`)).json()).replied, false);
  assert.equal((await fetch(`${BASE}/dgj/${b}/replied/no`)).status, 400);
  assert.equal((await put(b, 'phone', 'RES-TWO-1', '&re=no')).status, 400);
  assert.equal((await put(b, 'phone', 'RES-TWO-2')).status, 200);    // 不带 re 的（老掌机）照旧收
  phone.close();
});

test('the phone hears which machines are on', async () => {
  const b = newBox();
  const phone = await socket(`${WS}/dgj/${b}/ws?as=phone`);
  await phone.next((m) => m.t === 'hello');
  const hand = await pc(b, 'handheld');
  assert.deepEqual((await phone.next((m) => m.t === 'pc' && m.on)).pcs, ['handheld']);
  const desk = await pc(b, 'desk');
  assert.deepEqual((await phone.next((m) => m.t === 'pc' && m.pcs && m.pcs.length === 2)).pcs, ['desk', 'handheld']);
  const n = phone.got.length;
  desk.close();
  const after = await phone.next((m) => m.t === 'pc' && phone.got.indexOf(m) >= n);
  assert.deepEqual([after.on, after.pcs], [true, ['handheld']]);
  hand.close(); phone.close();
});

test('who must be desk or handheld', async () => {
  await assert.rejects(pc(newBox(), 'laptop'));
});
