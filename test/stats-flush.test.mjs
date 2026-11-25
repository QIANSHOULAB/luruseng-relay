// 140：额度账记了一下就在几秒内落盘（线上 DO 办完一下 10 秒左右就被收走，等 10 分钟 / 200 下的话数全丢）。纯 node，假 storage。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Stats } from '../src/stats.js';

function fakeCtx() {
  const writes = [];
  const sql = {
    exec(q, ...args) {
      if (/^INSERT/.test(q)) writes.push(args);
      return { toArray: () => [], one: () => ({}) };
    },
  };
  return { ctx: { storage: { sql } }, writes };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('one hit is on disk a moment later, before the DO would be put away', async () => {
  const { ctx, writes } = fakeCtx();
  const s = new Stats(ctx, 'dgj', () => Date.now(), 50);
  s.hit('GET state', 'tool', 200);
  assert.equal(writes.length, 0);
  await sleep(120);
  assert.equal(writes.length, 1);
  const saved = JSON.parse(writes[0][1]);
  const hour = Object.values(saved.hours)[0];
  assert.equal(hour['GET state|tool|200'], 1);
});

test('hits that come together go down in one write', async () => {
  const { ctx, writes } = fakeCtx();
  const s = new Stats(ctx, 'dgj', () => Date.now(), 50);
  for (let i = 0; i < 30; i++) s.hit('alarm');
  await sleep(120);
  assert.equal(writes.length, 1);
  assert.equal(Object.values(JSON.parse(writes[0][1]).hours)[0].alarm, 30);
});
