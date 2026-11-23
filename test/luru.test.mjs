// 089 录入僧 ⇄ 大管家：配对（错几次锁）、认照片只交一台（先电脑、后掌机，不来取转下一台）、撤掉的退回、超时、不在。
// 站里只转密文：这里的「密文」是随便几个字，站里本来也不拆。时间调小了跑得快。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, socket, sleep } from './dev.mjs';

const PORT = 9400 + Math.floor(Math.random() * 100);
let dev, BASE, WS;
const TOK = 'T'.repeat(40);

before(async () => {
  dev = await startDev(PORT, '.wrangler/luru-state', ['LR_TEST:1', 'LR_TAKE_MS:1000', 'LR_ASK_MS:4000', 'LR_PAIR_MS:3000', 'LR_FAILS:3', 'LR_STALE_MS:5000', 'LR_QUEUE_MS:20000']);
  BASE = dev.base;
  WS = BASE.replace('http', 'ws');
});
after(() => dev.stop());

let roomN = 0;
const newRoom = () => `r${Date.now()}x${roomN++}`;
const call = (room, path, { method = 'GET', body, ip, tok, who, origin } = {}) => fetch(`${BASE}/lr/${path}`, {
  method,
  headers: {
    'x-test-room': room, ...(ip ? { 'x-test-ip': ip } : {}), ...(tok ? { 'x-lr-token': tok } : {}), ...(who ? { 'x-lr-who': who } : {}),
    ...(origin ? { Origin: origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
const pcSock = async (room, who, tok = TOK, cap = null) => {
  // Node 的 WebSocket 加不了头：房间、口令走查询串（x-test-room 只在 LR_TEST 下认，这里借 fetch 一样的名字）
  const s = await socket(`${WS}/lr/pc/ws?who=${who}&tok=${tok}&room=${room}${cap === null ? '' : '&cap=' + cap}`);
  return s;
};
const keepAlive = (...socks) => { const t = setInterval(() => { for (const s of socks) { try { s.send('ping'); } catch (e) { /* 关了 */ } } }, 500); return () => clearInterval(t); };
const CID = 'cidcidcidcidcidcid01';
const pairBody = (cid = CID) => ({ cid, epk: 'EPK', n: 'NNN', ct: 'CODE' });

/** 假大管家：收到活就取、照 decide 回 */
function butler(room, sock, who, decide) {
  const seen = [];
  sock.onmessage = async (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data);
    if (m.t !== 'job') return;
    seen.push(m);
    const ans = await decide(m);
    if (ans === null) return;               // 装死：不取
    const j = await (await call(room, `pc/job/${m.id}`, { tok: TOK, who })).json();
    await call(room, `pc/answer/${m.id}`, { method: 'POST', tok: TOK, who, body: ans(j) });
  };
  return seen;
}

test('nobody home: hello says off, pairing and asking fall back at once', async () => {
  const r = newRoom();
  const h = await (await call(r, 'hello')).json();
  assert.equal(h.on, false);
  assert.equal((await call(r, 'pair', { method: 'POST', body: pairBody() })).status, 503);
  const a = await call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct: 'C' } });
  assert.equal(a.status, 403);
  assert.equal((await a.json()).unknown, true);
});

test('other websites are turned away; pages cannot touch the butler side', async () => {
  const r = newRoom();
  assert.equal((await call(r, 'hello', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(r, 'hello', { origin: 'https://qianshoulab.github.io' })).status, 200);
  assert.equal((await call(r, 'pc/state', { tok: TOK, who: 'desk', origin: 'https://qianshoulab.github.io' })).status, 403);
  const pre = await call(r, 'ask', { method: 'OPTIONS', origin: 'https://qianshoulab.github.io' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /POST/);
});

test('the first butler sets the word; a wrong word is refused', async () => {
  const r = newRoom();
  assert.equal((await call(r, 'pc/pub', { method: 'POST', tok: TOK, who: 'desk', body: { pub: 'PUBKEY' } })).status, 200);
  assert.equal((await call(r, 'pc/state', { tok: 'X'.repeat(40), who: 'desk' })).status, 403);
  assert.equal((await call(r, 'pc/state', { tok: 'short', who: 'desk' })).status, 403);
  assert.equal((await (await call(r, 'hello')).json()).pub, 'PUBKEY');
});

test('a wrong code counts; the third one locks that place for an hour, another place still may try', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk');
  const stop = keepAlive(desk);
  butler(r, desk, 'desk', async () => () => ({ ok: false }));
  const try1 = await (await call(r, 'pair', { method: 'POST', body: pairBody(), ip: '1.1.1.1' })).json();
  assert.deepEqual([try1.ok, try1.wrong, try1.left], [false, true, 2]);
  await call(r, 'pair', { method: 'POST', body: pairBody(), ip: '1.1.1.1' });
  const try3 = await (await call(r, 'pair', { method: 'POST', body: pairBody(), ip: '1.1.1.1' })).json();
  assert.equal(try3.locked, true);
  const try4 = await call(r, 'pair', { method: 'POST', body: pairBody(), ip: '1.1.1.1' });
  assert.equal(try4.status, 429);
  assert.ok((await try4.json()).until > Date.now() + 3000_000);
  const other = await (await call(r, 'pair', { method: 'POST', body: pairBody(), ip: '2.2.2.2' })).json();
  assert.equal(other.wrong, true);
  const st = await (await call(r, 'pc/state', { tok: TOK, who: 'desk' })).json();
  assert.equal(st.locks.filter((l) => l.until).length, 1);
  assert.equal(st.locks.length, 2);
  assert.equal(st.clients.length, 0);
  stop(); desk.close();
});

test('right code: paired; asks go to the butler and the answer comes back; revoked -> 403', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk');
  const stop = keepAlive(desk);
  const seen = butler(r, desk, 'desk', async (m) => (j) => (m.kind === 'pair'
    ? { ok: true, n: 'N2', ct: 'KEY' + j.ct, label: 'Edge · Windows' }
    : { ok: true, n: 'N3', ct: 'ANS' + j.ct }));
  const p = await (await call(r, 'pair', { method: 'POST', body: pairBody() })).json();
  assert.deepEqual([p.ok, p.ct], [true, 'KEYCODE']);
  const a = await (await call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct: 'PHOTO' } })).json();
  assert.deepEqual([a.ok, a.ct, a.by], [true, 'ANSPHOTO', 'desk']);
  assert.deepEqual(seen.map((m) => m.kind), ['pair', 'ask']);
  let st = await (await call(r, 'pc/state', { tok: TOK, who: 'desk' })).json();
  assert.equal(st.clients.length, 1);
  assert.deepEqual([st.clients[0].label, st.clients[0].uses, st.clients[0].revoked], ['Edge · Windows', 1, null]);
  assert.ok(st.clients[0].last);
  await call(r, 'pc/revoke', { method: 'POST', tok: TOK, who: 'desk', body: { cid: CID } });
  const no = await call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct: 'PHOTO' } });
  assert.equal(no.status, 403);
  assert.equal((await no.json()).revoked, true);
  st = await (await call(r, 'pc/state', { tok: TOK, who: 'desk' })).json();
  assert.ok(st.clients[0].revoked);
  const again = await (await call(r, 'pair', { method: 'POST', body: pairBody() })).json();   // 撤了以后再输对暗号：重新配上
  assert.equal(again.ok, true);
  assert.equal((await call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct: 'X' } })).status, 200);
  stop(); desk.close();
});

test('both on: the desk gets it; the desk does not come for it: the handheld does it', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk');
  const hand = await pcSock(r, 'handheld');
  const stop = keepAlive(desk, hand);
  let deskDead = false;
  const dseen = butler(r, desk, 'desk', async (m) => (m.kind === 'pair' || !deskDead ? (j) => ({ ok: true, n: 'n', ct: 'D' + j.ct }) : null));
  const hseen = butler(r, hand, 'handheld', async () => (j) => ({ ok: true, n: 'n', ct: 'H' + j.ct }));
  assert.deepEqual((await (await call(r, 'hello')).json()).pcs, ['desk', 'handheld']);
  await call(r, 'pair', { method: 'POST', body: pairBody() });
  const a = await (await call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct: 'P' } })).json();
  assert.deepEqual([a.ct, a.by], ['DP', 'desk']);
  assert.equal(hseen.length, 0);
  deskDead = true;
  const t0 = Date.now();
  const b = await (await call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct: 'Q' } })).json();
  assert.deepEqual([b.ct, b.by], ['HQ', 'handheld']);
  assert.ok(Date.now() - t0 >= 900);
  assert.equal(dseen.length, 3);
  stop(); desk.close(); hand.close();
});

test('the butler takes it but never answers: 504; the butler cannot open it: forget', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk');
  const stop = keepAlive(desk);
  let mode = 'ok';
  butler(r, desk, 'desk', async (m) => {
    if (m.kind === 'pair') return () => ({ ok: true, n: 'n', ct: 'k' });
    if (mode === 'mute') { await call(r, `pc/job/${m.id}`, { tok: TOK, who: 'desk' }); return null; }
    return () => ({ ok: false, forget: true });
  });
  await call(r, 'pair', { method: 'POST', body: pairBody() });
  const f = await (await call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct: 'P' } })).json();
  assert.deepEqual([f.ok, f.forget], [false, true]);
  mode = 'mute';
  const t = await call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct: 'P' } });
  assert.equal(t.status, 504);
  stop(); desk.close();
});

test('a job is taken once: the second machine gets 409', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk');
  const stop = keepAlive(desk);
  let jid = null;
  desk.onmessage = (e) => { if (e.data !== 'pong') { const m = JSON.parse(e.data); if (m.t === 'job') jid = m.id; } };
  const pending = call(r, 'pair', { method: 'POST', body: pairBody() });
  while (!jid) await sleep(50);
  assert.equal((await call(r, `pc/job/${jid}`, { tok: TOK, who: 'desk' })).status, 200);
  assert.equal((await call(r, `pc/job/${jid}`, { tok: TOK, who: 'handheld' })).status, 409);
  assert.equal((await call(r, `pc/answer/${jid}`, { method: 'POST', tok: TOK, who: 'handheld', body: { ok: false } })).status, 409);
  await call(r, `pc/answer/${jid}`, { method: 'POST', tok: TOK, who: 'desk', body: { ok: false } });
  assert.equal((await (await pending).json()).wrong, true);
  stop(); desk.close();
});

test('the shared settings blob: what one butler puts, the other reads', async () => {
  const r = newRoom();
  assert.equal((await (await call(r, 'pc/conf', { tok: TOK, who: 'desk' })).json()).data, null);
  await call(r, 'pc/conf', { method: 'POST', tok: TOK, who: 'desk', body: 'SEALED' });
  assert.equal((await (await call(r, 'pc/conf', { tok: TOK, who: 'handheld' })).json()).data, 'SEALED');
});

// ------------------------------------------------------------------ 093 两台一起认：按空位分、满了在站里排着
const ask = (r, ct) => call(r, 'ask', { method: 'POST', body: { cid: CID, n: 'N', ct } });

/** 假大管家：认一张要 ms 毫秒，记同时最多认几张 */
function slowButler(room, sock, who, ms, opts = {}) {
  const st = { now: 0, max: 0, n: 0 };
  sock.onmessage = async (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data);
    if (m.t !== 'job') return;
    if (m.kind === 'ask' && opts.no && opts.no(m)) { sock.send(JSON.stringify({ t: 'no', id: m.id })); return; }
    const res = await call(room, `pc/job/${m.id}`, { tok: TOK, who });
    if (res.status !== 200) return;
    const j = await res.json();
    if (m.kind === 'ask') { st.now++; st.n++; st.max = Math.max(st.max, st.now); await sleep(ms); st.now--; }
    await call(room, `pc/answer/${m.id}`, { method: 'POST', tok: TOK, who, body: m.kind === 'pair' ? { ok: true, n: 'n', ct: 'k' } : { ok: true, n: 'n', ct: who[0] + j.ct } });
  };
  return st;
}

test('093: jobs go to the machine with the most free slots; both full -> they wait in the relay', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk', TOK, 1);
  const hand = await pcSock(r, 'handheld', TOK, 2);
  const stop = keepAlive(desk, hand);
  const d = slowButler(r, desk, 'desk', 600);
  const h = slowButler(r, hand, 'handheld', 600);
  await call(r, 'pair', { method: 'POST', body: pairBody() });
  const hello = await (await call(r, 'hello')).json();
  assert.deepEqual([hello.v, hello.cap], [2, { desk: 1, handheld: 2 }]);
  const out = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => ask(r, 'P' + i).then((x) => x.json())));
  assert.ok(out.every((a) => a.ok));
  assert.ok(d.max <= 1 && h.max <= 2, JSON.stringify([d, h]));
  assert.equal(d.n + h.n, 6);
  assert.ok(d.n >= 1 && h.n >= 2, JSON.stringify([d, h]));
  assert.ok(out.some((a) => a.qms >= 300), 'some waited in the queue');
  stop(); desk.close(); hand.close();
});

test('093: time in the queue does not count against the 4 s (test) working limit', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk', TOK, 1);
  const stop = keepAlive(desk);
  slowButler(r, desk, 'desk', 2500);
  await call(r, 'pair', { method: 'POST', body: pairBody() });
  const t0 = Date.now();
  const out = await Promise.all([ask(r, 'A'), ask(r, 'B'), ask(r, 'C')]);
  assert.deepEqual(out.map((x) => x.status), [200, 200, 200]);
  assert.ok(Date.now() - t0 >= 7000);
  stop(); desk.close();
});

test('093: playing (cap 0) -> 503 cant at once; cap back up -> read again', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk', TOK, 0);
  const stop = keepAlive(desk);
  slowButler(r, desk, 'desk', 50);
  await call(r, 'pair', { method: 'POST', body: pairBody() });      // 配对不看空位
  const no = await ask(r, 'P');
  assert.equal(no.status, 503);
  assert.deepEqual(await no.json(), { off: true, cant: true });
  desk.send(JSON.stringify({ t: 'cap', n: 2 }));
  await sleep(300);
  const yes = await (await ask(r, 'Q')).json();
  assert.deepEqual([yes.ok, yes.by], [true, 'desk']);
  const st = await (await call(r, 'pc/state', { tok: TOK, who: 'desk' })).json();
  assert.deepEqual(st.machines, [{ who: 'desk', cap: 2, busy: 0, free: 2 }]);
  stop(); desk.close();
});

test('093: a butler that says no (full) gets no more until it answers; the other one takes it', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk', TOK, 4);
  const hand = await pcSock(r, 'handheld', TOK, 1);
  const stop = keepAlive(desk, hand);
  const d = slowButler(r, desk, 'desk', 100, { no: () => true });
  const h = slowButler(r, hand, 'handheld', 100);
  await call(r, 'pair', { method: 'POST', body: pairBody() });
  const a = await (await ask(r, 'P')).json();
  assert.deepEqual([a.ok, a.by], [true, 'handheld']);
  const b = await (await ask(r, 'Q')).json();
  assert.deepEqual([b.ok, b.by], [true, 'handheld']);
  assert.equal(d.n, 0);
  stop(); desk.close(); hand.close();
});
