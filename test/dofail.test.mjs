// 140：去 Durable Object 那一下抛了错（额度用光之类），回 503 + 原因，不往外抛（往外抛线上就是 1101）。纯 node，不用 wrangler。
import test from 'node:test';
import assert from 'node:assert/strict';
import { viaDO } from '../src/dofail.js';

const boom = (msg) => ({ fetch: async () => { throw new Error(msg); } });

test('DO over the free tier: 503 do_quota with the reason and Retry-After 600', async () => {
  const r = await viaDO(boom('Exceeded allowed volume of requests in Durable Objects free tier.'), 'https://x/');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '600');
  const j = await r.json();
  assert.equal(j.error, 'do_quota');
  assert.match(j.message, /free tier/);
});

test('DO code threw: 503 do_error, Retry-After 30', async () => {
  const r = await viaDO(boom('TypeError: x is undefined'), 'https://x/');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '30');
  assert.equal((await r.json()).error, 'do_error');
});

test('DO answered: passed through untouched, all args forwarded', async () => {
  let got;
  const ok = new Response('hi', { status: 201 });
  const r = await viaDO({ fetch: async (...a) => { got = a; return ok; } }, 'https://x/', { method: 'POST' });
  assert.equal(r, ok);
  assert.deepEqual(got, ['https://x/', { method: 'POST' }]);
});
