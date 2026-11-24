// 站里限速（施工单 125）：谁一秒敲好几次，在进 Durable Object 之前就挡住、回 429 并带「几秒后再来」。
// 进 Durable Object 的每一下都算一次请求（一天免费 10 万次）；挡在这里的不算。
// - 水桶：每个信箱 / 每个口子一个桶，桶里有 burst 个「牌」，每过 every 秒补一个，敲一下拿一个，没牌了就 429。
// - 桶只放在 Worker 自己的内存里（不花额度、不写盘）。Worker 可能有好几个实例各数各的，所以这是「挡狂敲」的护栏，不是精确的额度；
//   但一个人的手机、电脑、掌机连的是同一个地方的实例，一般落在同一个桶里。
// - 键是信箱号 / 来源地址的哈希前缀，只在内存里，不记日志；桶多到 5000 个就清掉最老的一半。
// - 正常用法远远用不到：一个信箱每 3 秒补一张牌（每分钟 20 下、一天最多 2.9 万下），攒着的 60 下够一波急用；
//   WebSocket 重连每 10 秒补一张、攒 10 张。线上用 vars 调（RL_*），RL_OFF=1 关掉。

const buckets = new Map();

function num(env, k, d) { const n = Number(env && env[k]); return Number.isFinite(n) && n > 0 ? n : d; }

/** 拿一个牌：-> 0 拿到了；> 0 是该几秒后再来 */
export function take(key, burst, everyS, now = Date.now()) {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= 5000) { let i = 0; for (const k of buckets.keys()) { buckets.delete(k); if (++i >= 2500) break; } }
    b = { n: burst, t: now };
    buckets.set(key, b);
  }
  b.n = Math.min(burst, b.n + (now - b.t) / (everyS * 1000));
  b.t = now;
  if (b.n >= 1) { b.n -= 1; return 0; }
  return Math.max(1, Math.ceil((1 - b.n) * everyS));
}

const tooMany = (retry) => new Response(JSON.stringify({ error: 'slow down', retry_after: retry }), {
  status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(retry) },
});

/** kind：'ws'（连 WebSocket）或 'http'（别的请求）；key：信箱号 / 来源 + 谁。-> null（放行）或一个 429 */
export function guard(env, kind, key) {
  if (env && (env.RL_OFF === '1' || env.RL_OFF === 1 || env.RL_OFF === true)) return null;
  const ws = kind === 'ws';
  const retry = take(`${kind}|${key}`, ws ? num(env, 'RL_WS_BURST', 10) : num(env, 'RL_HTTP_BURST', 60), ws ? num(env, 'RL_WS_EVERY_S', 10) : num(env, 'RL_HTTP_EVERY_S', 3));
  return retry ? tooMany(retry) : null;
}

export function _reset() { buckets.clear(); }   // 测试用
