// 一叶笺 ⇄ 大管家 信箱（/dgj）：npm test 里一起跑。起一个 wrangler dev，真发请求、真连 WebSocket、真加密。
// 手机 app 和掌机发请求不带 Origin，所以这里默认都不带。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, socket, newBox } from './dev.mjs';

const PORT = 9100 + Math.floor(Math.random() * 100);
let dev, BASE, WS;

before(async () => {
  // 上限调小好测：一封最多 8MB、一个信箱最多 5 封 / 9MB（线上是 24MB、200 封、64MB）
  dev = await startDev(PORT, '.wrangler/dgj-state', ['DGJ_MAX_MSG:8000000', 'DGJ_MAX_ITEMS:5', 'DGJ_MAX_BOX_BYTES:9000000']);
  BASE = dev.base;
  WS = BASE.replace('http', 'ws');
});
after(() => dev.stop());

const put = (b, to, mid, body, headers = {}) => fetch(`${BASE}/dgj/${b}/msg?to=${to}&mid=${mid}`, { method: 'PUT', body, headers });
const get = (b, path, headers = {}) => fetch(`${BASE}/dgj/${b}/${path}`, { headers });
const del = (b, seq) => fetch(`${BASE}/dgj/${b}/msg/${seq}`, { method: 'DELETE' });
const ws = (b, as) => socket(`${WS}/dgj/${b}/ws?as=${as}`);
const bytes = (n, k = 7) => new Uint8Array(n).map((_, i) => (i * k + (i >> 8)) % 256);
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha = async (u8) => Buffer.from(await crypto.subtle.digest('SHA-256', u8)).toString('hex');

// 两头的加密（接口 v2）：AES-256-GCM，12 字节随机 nonce 放最前面，附加数据「yiye-dgj/2/<信箱号>/<收信的一方>」
async function seal(keyRaw, box, to, text) {
  const key = await crypto.subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`yiye-dgj/2/${box}/${to}`) }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
async function open(keyRaw, box, to, data) {
  const key = await crypto.subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: new TextEncoder().encode(`yiye-dgj/2/${box}/${to}`) }, key, data.slice(12));
  return new TextDecoder().decode(pt);
}

test('phone → butler: pushed at once, only ciphertext on the relay, ack deletes it, phone hears it was taken', async () => {
  const b = newBox();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const pc = await ws(b, 'pc');
  const phone = await ws(b, 'phone');
  const hello = await phone.next((m) => m.t === 'hello');
  assert.equal(hello.pc, true);                                       // 手机看得见大管家在线
  assert.equal((await pc.next((m) => m.t === 'phone')).on, true);
  const plain = JSON.stringify({ v: 2, kind: 'request', id: 'REQ-0001', data: { v: 1, id: 'REQ-0001', text: 'A线早班 128O件' } });
  const sealed = await seal(key, b, 'pc', plain);
  const res = await put(b, 'pc', 'REQ-0001', sealed);
  assert.equal(res.status, 200);
  const { seq, pc: online } = await res.json();
  assert.ok(seq > 0 && online === true);
  const pushed = await pc.next((m) => m.t === 'msg');
  assert.deepEqual([pushed.item.seq, pushed.item.mid, pushed.item.to, pushed.item.size], [seq, 'REQ-0001', 'pc', sealed.length]);
  assert.equal(await open(key, b, 'pc', unb64(pushed.item.data)), plain);   // 小信跟着推送走，拆得开
  const stored = new Uint8Array(await (await get(b, `msg/${seq}`)).arrayBuffer());
  assert.deepEqual(stored, sealed);                                   // 站里存的就是密文，一个字节不差
  assert.ok(!Buffer.from(stored).toString('latin1').includes('128O'));
  assert.ok(!Buffer.from(stored).toString('utf8').includes('A线早班'));
  await assert.rejects(open(key, b, 'phone', stored));                // 方向对不上拆不开（不能拿去冒充另一头）
  const again = await (await put(b, 'pc', 'REQ-0001', sealed)).json();
  assert.deepEqual([again.seq, again.again], [seq, true]);           // 手机重传同一封：不存第二份
  assert.equal((await (await get(b, 'msgs?for=pc')).json()).length, 1);
  pc.send(JSON.stringify({ t: 'ack', seq }));                         // 大管家理完了：删
  const gone = await phone.next((m) => m.t === 'gone');
  assert.deepEqual([gone.seq, gone.mid, gone.to], [seq, 'REQ-0001', 'pc']);
  assert.equal((await get(b, `msg/${seq}`)).status, 404);
  assert.deepEqual(await (await get(b, 'msgs?for=pc')).json(), []);
  const t0 = Date.now();
  pc.close();
  const off = await phone.next((m) => m.t === 'pc' && m.on === false);
  assert.ok(off.seen >= t0 - 1000);                                   // 掌机断了：手机马上知道，带着「上次在线」
  const st = await (await get(b, 'state')).json();
  assert.equal(st.pc, false);
  assert.ok(st.pcSeen >= t0 - 1000);
  phone.close();
});

test('butler → phone: mail waits while the phone is closed, comes all at once when it opens', async () => {
  const b = newBox();
  const sizes = [900, 60_000, 1200];                                  // 中间那封超过 48KB：不跟着 hello 走，要来取
  const seqs = [];
  for (let i = 0; i < 3; i++) {
    const r = await put(b, 'phone', `RES-000${i}`, bytes(sizes[i], i + 3));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.pc, false);
    seqs.push(j.seq);
  }
  assert.deepEqual((await (await get(b, 'state')).json()).pending, { pc: 0, phone: 3 });
  const phone = await ws(b, 'phone');
  const hello = await phone.next((m) => m.t === 'hello');
  assert.deepEqual(hello.items.map((x) => x.mid), ['RES-0000', 'RES-0001', 'RES-0002']);
  assert.deepEqual(hello.items.map((x) => x.size), sizes);
  assert.deepEqual(unb64(hello.items[0].data), bytes(900, 3));
  assert.equal(hello.items[1].data, undefined);
  assert.deepEqual(new Uint8Array(await (await get(b, `msg/${seqs[1]}`)).arrayBuffer()), bytes(60_000, 4));
  assert.equal(hello.pc, false);
  assert.equal(hello.pcSeen, null);                                   // 掌机从没来过
  for (const s of seqs) assert.equal((await del(b, s)).status, 200);
  assert.deepEqual(await (await get(b, 'msgs?for=phone')).json(), []);
  const pc = await ws(b, 'pc');
  const on = await phone.next((m) => m.t === 'pc' && m.on === true);
  assert.ok(on.seen > 0);
  pc.close(); phone.close();
});

test('a 5 MB mp3 is stored in 3 pieces and comes back byte for byte', async () => {
  const b = newBox();
  const pc = await ws(b, 'pc');
  const big = bytes(5_000_000, 11);
  const r = await put(b, 'pc', 'BIG-MP3-1', big);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.parts, 3);
  const pushed = await pc.next((m) => m.t === 'msg');
  assert.equal(pushed.item.size, 5_000_000);
  assert.equal(pushed.item.data, undefined);                          // 大的只推「来了」，自己来取
  const back = new Uint8Array(await (await get(b, `msg/${j.seq}`)).arrayBuffer());
  assert.equal(back.length, big.length);
  assert.equal(await sha(back), await sha(big));
  pc.send(JSON.stringify({ t: 'ack', seq: j.seq }));
  await pc.next((m) => m.t === 'gone');
  pc.close();
});

test('caps: one letter too big, too many letters, too many bytes waiting', async () => {
  assert.equal((await put(newBox(), 'pc', 'TOO-BIG-1', bytes(8_000_001))).status, 413);
  const b1 = newBox();
  for (let i = 0; i < 5; i++) assert.equal((await put(b1, 'pc', `MANY-${i}xx`, bytes(10))).status, 200);
  const full = await put(b1, 'phone', 'MANY-6xx', bytes(10));
  assert.equal(full.status, 429);
  assert.match((await full.json()).error, /满了/);
  const b2 = newBox();
  assert.equal((await put(b2, 'phone', 'HEAVY-1', bytes(5_000_000))).status, 200);
  assert.equal((await put(b2, 'phone', 'HEAVY-2', bytes(5_000_000))).status, 429);
  assert.equal((await put(b2, 'phone', 'LIGHT-3', bytes(1000))).status, 200);   // 没超的照收
});

test('withdraw: the phone takes back a request the butler has not taken', async () => {
  const b = newBox();
  const pc = await ws(b, 'pc');
  const { seq } = await (await put(b, 'pc', 'DUB-REQ-1', bytes(100))).json();
  await pc.next((m) => m.t === 'msg');
  assert.equal((await del(b, seq)).status, 200);
  const gone = await pc.next((m) => m.t === 'gone');
  assert.equal(gone.mid, 'DUB-REQ-1');
  assert.deepEqual(await (await get(b, 'msgs?for=pc')).json(), []);
  assert.deepEqual(await (await del(b, seq)).json(), { ok: true, had: false });
  pc.close();
});

test('over the socket: ping gets pong without waking anything, state on request', async () => {
  const b = newBox();
  const phone = await ws(b, 'phone');
  await phone.next((m) => m.t === 'hello');
  phone.send('ping');
  await phone.next((m) => m.t === 'pong');
  phone.send(JSON.stringify({ t: 'state' }));
  const st = await phone.next((m) => m.t === 'state');
  assert.deepEqual([st.pc, st.phone, st.pending], [false, true, { pc: 0, phone: 0 }]);
  phone.send('not json');                                             // 乱发的不理，也不断
  phone.send(JSON.stringify({ t: 'state' }));
  await phone.next((m) => m.t === 'state' && m !== st);
  phone.close();
});

test('guards: no Origin is let in only here; other websites out; bad box, role, id, empty', async () => {
  const b = newBox();
  assert.equal((await fetch(`${BASE}/r/room_${'x'.repeat(20)}/items`)).status, 403);          // 录入僧照旧只认网页
  assert.equal((await fetch(`${BASE}/count`, { method: 'POST', body: '/9j/' + 'A'.repeat(5000) })).status, 403);   // 点钞机也是
  assert.equal((await get(b, 'state')).status, 200);
  assert.equal((await get(b, 'state', { Origin: 'https://evil.example' })).status, 403);
  const mine = await get(b, 'state', { Origin: 'https://qianshoulab.github.io' });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('access-control-allow-origin'), 'https://qianshoulab.github.io');
  assert.equal((await get(b, 'state', { Origin: BASE })).status, 200);                     // 跟站同一个 Origin（有的 WebSocket 库会带）
  assert.equal((await put(b, 'pc', 'EVIL-0001', bytes(10), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${BASE}/dgj/short/state`)).status, 404);
  assert.equal((await fetch(`${BASE}/dgj/${b.toUpperCase()}/state`)).status, 404);
  assert.equal((await fetch(`${BASE}/dgj/${b}/nope`)).status, 404);
  assert.equal((await put(b, 'boss', 'ROLE-0001', bytes(10))).status, 400);
  assert.equal((await put(b, 'pc', 'a', bytes(10))).status, 400);
  assert.equal((await put(b, 'pc', 'EMPTY-001', new Uint8Array(0))).status, 400);
  assert.equal((await get(b, 'msg/abc')).status, 400);
  assert.equal((await get(b, 'msgs?for=boss')).status, 400);
  assert.equal((await get(b, 'ws')).status, 426);
  const pre = await fetch(`${BASE}/dgj/${b}/msg`, { method: 'OPTIONS', headers: { Origin: 'https://qianshoulab.github.io', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
  assert.deepEqual((await (await get(b, 'state')).json()).pending, { pc: 0, phone: 0 });    // 上面挡掉的一封都没进来
});
