// 167 Claude 通道：门禁（cid、撤了、一天上限、正文大小）、原样转、额度用完歇着（歇着不打上游，过了窗口放一个试探）、
// 钥匙只写不读、记账对不对。上游是本机一个假的 Claude（AI_UPSTREAM 只在 LR_TEST 下认），不花钱、不用钥匙。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startDev, socket, sleep } from './dev.mjs';
import { cost, isQuota, sgtMonth } from '../src/ai.js';

const PORT = 9500 + Math.floor(Math.random() * 100);
const UP_PORT = PORT + 200;
const TOK = 'A'.repeat(40);
const KEY = 'sk-ant-api03-' + 'k'.repeat(80) + 'WXYZ';
let dev, BASE;

// ---------------------------------------------------------------- 假的 Claude
const seen = [];                 // 上游收到的：{key, version, body}
const next = [];                 // 接下来怎么回：[status, body]；空了就回成功
const OK = (model = 'claude-opus-5-5', usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 0 } }) =>
  [200, { id: 'msg_x', type: 'message', role: 'assistant', model, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"records":[]}' }], stop_reason: 'end_turn', usage }];
const up = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({ key: req.headers['x-api-key'], version: req.headers['anthropic-version'], body: Buffer.concat(chunks).toString() });
    const [st, body] = next.length ? next.shift() : OK();
    res.writeHead(st, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
});

before(async () => {
  await new Promise((ok) => up.listen(UP_PORT, '127.0.0.1', ok));
  dev = await startDev(PORT, '.wrangler/ai-state', ['LR_TEST:1', `AI_UPSTREAM:http://127.0.0.1:${UP_PORT}/v1/messages`,
    'AI_DAY_MAX:5', 'AI_REST_MS:3000', 'AI_PROBE_MS:2000', 'AI_MAX_BYTES:200000', 'RL_OFF:1']);
  BASE = dev.base;
});
after(() => { dev.stop(); up.close(); });

let roomN = 0;
const newRoom = () => `ai${Date.now()}x${roomN++}`;
let cidN = 0;
const newCid = () => `cid${Date.now()}c${cidN++}`.padEnd(20, 'q');
const pc = (room, path, { method = 'GET', body, tok = TOK, origin } = {}) => fetch(`${BASE}/lr/pc/ai/${path}`, {
  method, headers: { 'x-test-room': room, 'x-lr-token': tok, 'x-lr-who': 'desk', ...(origin ? { Origin: origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const onDevice = (room, path, { method = 'GET', body, cid, origin } = {}) => fetch(`${BASE}/ai/${path}`, {
  method, headers: { 'x-test-room': room, ...(cid ? { 'x-lr-cid': cid } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
const MSG = { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: '认一下' }] };
const ask = (room, cid, body = MSG) => onDevice(room, 'messages', { method: 'POST', cid, body });

/** 一个房间：大管家定下口令、放钥匙、登记一个 cid */
async function setup(key = KEY) {
  const room = newRoom();
  const cid = newCid();
  if (key) assert.equal((await pc(room, 'key', { method: 'POST', body: { key } })).status, 200);
  assert.equal((await pc(room, 'client', { method: 'POST', body: { cid, label: '167 测试' } })).status, 200);
  return { room, cid };
}

test('price math: Opus in/out/cache, unknown models priced as Opus', () => {
  const c = cost('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000 } });
  assert.equal(Math.round(c.usd * 100) / 100, 4 + 20 + 0.2 + 5);
  assert.equal(Math.round(cost('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }).usd * 100) / 100, 12);
  assert.equal(Math.round(cost('claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 1e6 }).usd * 100) / 100, 0.6);
  assert.equal(cost('claude-mystery', { input_tokens: 1e6 }).guess, true);
  assert.equal(Math.round(cost('claude-opus-5-5', { cache_creation: { ephemeral_1h_input_tokens: 1e6 } }).usd * 100) / 100, 8);
  assert.ok(isQuota(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'));
  assert.ok(isQuota(402, ''));
  assert.ok(!isQuota(400, '{"error":{"message":"messages: field required"}}'));
  assert.equal(sgtMonth(Date.parse('2026-11-30T16:30:00Z')), '2026-12');   // 新加坡已经 12 月 1 号了
});

test('the key: only the butler may set it, nobody reads it back', async () => {
  const room = newRoom();
  assert.equal((await pc(room, 'key', { method: 'POST', body: { key: KEY } })).status, 200);       // 第一台定下口令
  assert.equal((await pc(room, 'key', { method: 'POST', body: { key: KEY }, tok: 'B'.repeat(40) })).status, 403);
  assert.equal((await pc(room, 'key', { method: 'POST', body: { key: KEY }, tok: 'short' })).status, 403);
  assert.equal((await pc(room, 'key', { method: 'POST', body: { key: KEY }, origin: 'https://qianshoulab.github.io' })).status, 403);
  assert.equal((await pc(room, 'state', { tok: 'B'.repeat(40) })).status, 403);
  assert.equal((await pc(room, 'key', { method: 'POST', body: { key: 'nope' } })).status, 400);
  assert.equal((await pc(room, 'key')).status, 404);                                               // 没有读钥匙的口子
  const st = await (await pc(room, 'state')).json();
  assert.deepEqual([st.key.has, st.key.tail], [true, 'WXYZ']);
  assert.ok(!JSON.stringify(st).includes(KEY.slice(0, 30)));
  assert.equal((await pc(room, 'key', { method: 'POST', body: { clear: true } })).status, 200);
  assert.equal((await (await pc(room, 'state')).json()).key.has, false);
});

test('no cid, unknown, revoked -> 403; other websites -> 403; no key -> 503 nokey', async () => {
  const { room, cid } = await setup(null);
  assert.equal((await onDevice(room, 'messages', { method: 'POST', body: MSG })).status, 403);
  assert.equal((await ask(room, 'x'.repeat(20))).status, 403);
  assert.equal((await onDevice(room, 'conf', { cid, origin: 'https://evil.example' })).status, 403);
  const pre = await onDevice(room, 'messages', { method: 'OPTIONS', origin: 'https://qianshoulab.github.io' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /x-lr-cid/);
  const nk = await ask(room, cid);
  assert.equal(nk.status, 503);
  assert.equal((await nk.json()).why, 'nokey');
  await pc(room, 'key', { method: 'POST', body: { key: KEY } });
  const n0 = seen.length;
  assert.equal((await ask(room, cid)).status, 200);
  assert.equal(seen.length, n0 + 1);
  // 撤：跟 089 的 pc/revoke 一起
  const rv = await fetch(`${BASE}/lr/pc/revoke`, { method: 'POST', headers: { 'x-test-room': room, 'x-lr-token': TOK, 'x-lr-who': 'desk', 'content-type': 'application/json' }, body: JSON.stringify({ cid }) });
  assert.equal(rv.status, 200);
  const no = await ask(room, cid);
  assert.equal(no.status, 403);
  assert.equal((await no.json()).revoked, true);
  assert.equal(seen.length, n0 + 1);
});

test('conf: the butler pushes the model table, devices read it with their cid', async () => {
  const { room, cid } = await setup();
  const conf = { v: 1, luru: { model: 'claude-opus-5-5', effort: 'low' }, tiexie: { fast: { model: 'claude-sonnet-5-5', effort: 'medium' } } };
  assert.equal((await pc(room, 'conf', { method: 'POST', body: conf })).status, 200);
  const r = await (await onDevice(room, 'conf', { cid, origin: 'https://qianshoulab.github.io' })).json();
  assert.deepEqual([r.ok, r.key, r.rest, r.conf], [true, true, null, conf]);
  assert.equal((await onDevice(room, 'conf', { cid: newCid() })).status, 403);
});

test('a good one goes through untouched, the key is added there, the bill is right', async () => {
  const { room, cid } = await setup();
  const body = JSON.stringify({ ...MSG, messages: [{ role: 'user', content: [{ type: 'text', text: '照片：' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(50000) } }] }] });
  const n0 = seen.length;
  const r = await ask(room, cid, body);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), OK()[1]);
  assert.equal(seen.length, n0 + 1);
  assert.equal(seen[n0].body, body);                    // 原样流过去
  assert.equal(seen[n0].key, KEY);
  assert.equal(seen[n0].version, '2023-06-01');
  next.push(OK('claude-sonnet-5-5', { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 600 }));
  await ask(room, cid);
  const st = await (await pc(room, 'state')).json();
  const o = st.models['claude-opus-5-5'], s = st.models['claude-sonnet-5-5'];
  assert.deepEqual([o.n, o.in, o.out, o.cache_write, o.cache_read], [1, 1000, 200, 600, 0]);
  assert.equal(o.usd, Math.round((1000 * 4 + 200 * 20 + 600 * 5) / 1e6 * 1e4) / 1e4);
  assert.equal(s.usd, Math.round((500 * 2 + 100 * 10 + 600 * 0.1) / 1e6 * 1e4) / 1e4);
  assert.equal(st.usd, Math.round((o.usd + s.usd) * 1e4) / 1e4);
  assert.ok(st.last_ok);
  assert.equal(st.today.find((x) => cid.startsWith(x.cid)).n, 2);
});

test('upstream errors come back as they are and are noted (no content kept)', async () => {
  const { room, cid } = await setup();
  next.push([500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }]);
  const r = await ask(room, cid);
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error.type, 'api_error');
  next.push([400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-workspace-id header is required for organization-scoped keys' } }]);
  assert.equal((await ask(room, cid)).status, 400);
  const st = await (await pc(room, 'state')).json();
  assert.equal(st.last_error.status, 400);
  assert.match(st.last_error.msg, /workspace-id/);
  assert.equal(st.rest, null);
  assert.equal(st.models['(错)'].err, 2);
});

test('quota: 503 quota, upstream left alone for the window, then one probe; good probe wakes it', async () => {
  const { room, cid } = await setup();
  const butler = await socket(`${BASE.replace('http', 'ws')}/lr/pc/ws?who=desk&tok=${TOK}&room=${room}`);
  next.push([400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }]);
  const r1 = await ask(room, cid);
  assert.equal(r1.status, 503);
  assert.equal((await r1.json()).why, 'quota');
  await butler.next((m) => m.t === 'ai' && m.what === 'rest');
  const n0 = seen.length;
  for (let i = 0; i < 2; i++) {
    const r = await ask(room, cid);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).why, 'quota');
  }
  assert.equal(seen.length, n0);                         // 歇着：没打上游
  const c = await (await onDevice(room, 'conf', { cid })).json();
  assert.ok(c.rest > Date.now());
  let st = await (await pc(room, 'state')).json();
  assert.equal(st.rest.now, true);
  assert.equal(st.last_error.quota, true);
  await sleep(3200);                                     // 过了窗口：放一个试探，又是额度用完 -> 再歇
  next.push([402, { type: 'error', error: { type: 'billing_error', message: 'billing' } }]);
  assert.equal((await ask(room, cid)).status, 503);
  assert.equal(seen.length, n0 + 1);
  assert.equal((await ask(room, cid)).status, 503);
  assert.equal(seen.length, n0 + 1);
  await sleep(3200);                                     // 再过窗口：试探成了 -> 醒
  const ok = await ask(room, cid);
  assert.equal(ok.status, 200);
  await butler.next((m) => m.t === 'ai' && m.what === 'woke');
  st = await (await pc(room, 'state')).json();
  assert.equal(st.rest, null);
  assert.ok(st.woke);
  assert.equal((await ask(room, cid)).status, 200);
  butler.close();
});

test('a day has a limit per cid; too big a body is refused before anything', async () => {
  const { room, cid } = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await ask(room, cid)).status, 200);
  const r = await ask(room, cid);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).why, 'day');
  const other = await setup();
  const n0 = seen.length;
  const big = await ask(other.room, other.cid, JSON.stringify({ ...MSG, pad: 'x'.repeat(250000) }));
  assert.equal(big.status, 413);
  assert.equal(seen.length, n0);
});
