// 184 录入僧越用越准：配上的录入僧交一包改动（POST /lr/learn）→ 大管家（先电脑，不占认字的空位）→ 回执原样回；
// 没大管家 503、不认识 / 撤了 403、太大 413；大管家放上常错清单（POST /lr/pc/learn），配上的录入僧读得到（GET /lr/learn/list），别人读不到。
// 「密文」是随便几个字，站里本来也不拆。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, socket } from './dev.mjs';

const PORT = 9600 + Math.floor(Math.random() * 100);
let dev, BASE, WS;
const TOK = 'L'.repeat(40);

before(async () => {
  dev = await startDev(PORT, '.wrangler/learn-state', ['LR_TEST:1', 'LR_TAKE_MS:1000', 'LR_LEARN_MS:3000', 'LR_PAIR_MS:3000', 'LR_STALE_MS:5000']);
  BASE = dev.base;
  WS = BASE.replace('http', 'ws');
});
after(() => dev.stop());

let roomN = 0;
const newRoom = () => `l${Date.now()}x${roomN++}`;
const call = (room, path, { method = 'GET', body, tok, who, origin, cid } = {}) => fetch(`${BASE}/lr/${path}`, {
  method,
  headers: {
    'x-test-room': room, ...(tok ? { 'x-lr-token': tok } : {}), ...(who ? { 'x-lr-who': who } : {}), ...(cid ? { 'x-lr-cid': cid } : {}),
    ...(origin ? { Origin: origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
const pcSock = (room, who, cap = null) => socket(`${WS}/lr/pc/ws?who=${who}&tok=${TOK}&room=${room}${cap === null ? '' : '&cap=' + cap}`);
const keepAlive = (...socks) => { const t = setInterval(() => { for (const s of socks) { try { s.send('ping'); } catch (e) { /* 关了 */ } } }, 500); return () => clearInterval(t); };
const CID = 'learnlearnlearn0001';

function butler(room, sock, who, decide) {
  const seen = [];
  sock.onmessage = async (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data);
    if (m.t !== 'job') return;
    seen.push(m);
    const ans = await decide(m);
    if (ans === null) return;
    const j = await (await call(room, `pc/job/${m.id}`, { tok: TOK, who })).json();
    await call(room, `pc/answer/${m.id}`, { method: 'POST', tok: TOK, who, body: ans(j) });
  };
  return seen;
}

/** 配上一台录入僧（假大管家说暗号对） */
async function paired(room, sock, who) {
  butler(room, sock, who, () => () => ({ ok: true, n: 'PN', ct: 'PCT', label: '测试浏览器' }));
  const r = await (await call(room, 'pair', { method: 'POST', body: { cid: CID, epk: 'EPK', n: 'NNN', ct: 'CODE' } })).json();
  assert.equal(r.ok, true);
}

test('184: nobody paired / nobody home', async () => {
  const r = newRoom();
  const a = await call(r, 'learn', { method: 'POST', body: { cid: CID, n: 'N', ct: 'C' } });
  assert.equal(a.status, 403);
  assert.equal((await a.json()).unknown, true);
  const l = await call(r, 'learn/list', { cid: CID });
  assert.equal(l.status, 403);
  assert.equal((await call(r, 'learn', { method: 'POST', body: { cid: 'short', n: 'N', ct: 'C' } })).status, 400);
});

test('184: a package goes to the desk (not the handheld), the receipt comes back as is; ask slots untouched', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk', 0);            // 打游戏（cap 0）也收改动：不占认字的空位
  const hh = await pcSock(r, 'handheld');
  const stop = keepAlive(desk, hh);
  try {
    await paired(r, desk, 'desk');
    const got = [];
    const seen = butler(r, desk, 'desk', () => (j) => { got.push(j); return { ok: true, n: 'RN', ct: 'RECEIPT' }; });
    const seenH = butler(r, hh, 'handheld', () => () => ({ ok: true, n: 'X', ct: 'WRONG' }));
    const res = await call(r, 'learn', { method: 'POST', body: { cid: CID, n: 'LN', ct: 'SEALED' } });
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.deepEqual([b.ok, b.n, b.ct, b.by], [true, 'RN', 'RECEIPT', 'desk']);
    assert.equal(seen[0].kind, 'learn');
    assert.deepEqual([got[0].kind, got[0].cid, got[0].n, got[0].ct], ['learn', CID, 'LN', 'SEALED']);
    assert.equal(seenH.length, 0);
    const st = await (await call(r, 'pc/state', { tok: TOK, who: 'desk' })).json();
    assert.equal(st.clients[0].uses, 0);                 // 交改动不算「用了一次」
  } finally { stop(); desk.close(); hh.close(); }
});

test('184: the desk does not come: the handheld gets it; the butler cannot open it: forget; nobody online: 503', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk');
  const hh = await pcSock(r, 'handheld');
  const stop = keepAlive(desk, hh);
  try {
    await paired(r, desk, 'desk');
    butler(r, desk, 'desk', () => null);                 // 装死
    butler(r, hh, 'handheld', () => () => ({ ok: true, n: 'HN', ct: 'HCT' }));
    const b = await (await call(r, 'learn', { method: 'POST', body: { cid: CID, n: 'N', ct: 'C' } })).json();
    assert.deepEqual([b.ok, b.by], [true, 'handheld']);
    butler(r, desk, 'desk', () => () => ({ ok: false, forget: true }));
    butler(r, hh, 'handheld', () => () => ({ ok: false, forget: true }));
    const f = await (await call(r, 'learn', { method: 'POST', body: { cid: CID, n: 'N', ct: 'C' } })).json();
    assert.deepEqual([f.ok, f.forget], [false, true]);
  } finally { stop(); desk.close(); hh.close(); }
  await new Promise((ok) => setTimeout(ok, 300));
  const off = await call(r, 'learn', { method: 'POST', body: { cid: CID, n: 'N', ct: 'C' } });
  assert.equal(off.status, 503);
  assert.equal((await off.json()).off, true);
});

test('184: too big -> 413; revoked -> 403 for both', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk');
  const stop = keepAlive(desk);
  try {
    await paired(r, desk, 'desk');
    const big = await call(r, 'learn', { method: 'POST', body: { cid: CID, n: 'N', ct: 'A'.repeat(4_100_000) } });
    assert.equal(big.status, 413);
    await call(r, 'pc/revoke', { method: 'POST', tok: TOK, who: 'desk', body: { cid: CID } });
    const a = await call(r, 'learn', { method: 'POST', body: { cid: CID, n: 'N', ct: 'C' } });
    assert.equal(a.status, 403);
    assert.equal((await a.json()).revoked, true);
    assert.equal((await call(r, 'learn/list', { cid: CID })).status, 403);
  } finally { stop(); desk.close(); }
});

test('184: the butler puts the list; paired devices read it (header or ?cid=, pages too); others cannot; clear', async () => {
  const r = newRoom();
  const desk = await pcSock(r, 'desk');
  const stop = keepAlive(desk);
  try {
    await paired(r, desk, 'desk');
    let l = await (await call(r, 'learn/list', { cid: CID })).json();
    assert.deepEqual(l, { ok: true, learn: null });
    const list = { ver: 3, lists: { 考勤表: ['SHIFT 只有 D、N；手写 N 斜杠短，别看成 D'], '*': ['日期写成 日/月'] }, nored: [{ cat: '考勤表', col: 'SHIFT', value: 'D', extra: 'x' }] };
    assert.equal((await call(r, 'pc/learn', { method: 'POST', tok: 'X'.repeat(40), who: 'desk', body: list })).status, 403);
    assert.equal((await call(r, 'pc/learn', { method: 'POST', tok: TOK, who: 'desk', body: { ver: 0, lists: {}, nored: [] } })).status, 400);
    assert.equal((await call(r, 'pc/learn', { method: 'POST', tok: TOK, who: 'desk', body: { ver: 1, lists: { a: [1] }, nored: [] } })).status, 400);
    assert.equal((await call(r, 'pc/learn', { method: 'POST', tok: TOK, who: 'desk', origin: 'https://qianshoulab.github.io', body: list })).status, 403);
    const put = await (await call(r, 'pc/learn', { method: 'POST', tok: TOK, who: 'desk', body: list })).json();
    assert.deepEqual(put, { ok: true, ver: 3 });
    l = await (await call(r, 'learn/list', { cid: CID })).json();
    assert.equal(l.learn.ver, 3);
    assert.deepEqual(l.learn.lists, list.lists);
    assert.deepEqual(l.learn.nored, [{ cat: '考勤表', col: 'SHIFT', value: 'D' }]);
    assert.ok(l.learn.at > 0);
    const page = await call(r, `learn/list?cid=${CID}`, { origin: 'https://qianshoulab.github.io' });
    assert.equal(page.status, 200);
    assert.equal((await page.json()).learn.ver, 3);
    const pre = await call(r, 'learn/list', { method: 'OPTIONS', origin: 'https://qianshoulab.github.io' });
    assert.match(pre.headers.get('Access-Control-Allow-Headers'), /x-lr-cid/);
    assert.equal((await call(r, 'learn/list', { cid: 'nobodynobodynobody01' })).status, 403);
    assert.equal((await (await call(r, 'pc/learn', { tok: TOK, who: 'desk' })).json()).learn.ver, 3);
    await call(r, 'pc/learn', { method: 'POST', tok: TOK, who: 'desk', body: { clear: true } });
    l = await (await call(r, 'learn/list', { cid: CID })).json();
    assert.equal(l.learn, null);
  } finally { stop(); desk.close(); }
});
