// 140：去 Durable Object 那一下出了错（免费额度用光、存储满、DO 里的代码抛了异常），原来整个 Worker 跟着崩，
// 手机、大管家只看到 Cloudflare 的「error code: 1101」（500），线上到底卡在哪只有 wrangler tail 看得见。
// 现在接住：回 503 + Cloudflare 给的报错原文（只有报错那句话，不带信箱号、不带信的内容），带 Retry-After。
// - 额度 / 存储到顶（报错里有 free tier、exceeded、limit）：error = do_quota，Retry-After 600 秒。
// - 别的：error = do_error，Retry-After 30 秒。
// 客户端照旧当「暂时不通」处理；查原因不用登录 Cloudflare：curl 一下 /dgj/<随便 32 个 0>/state 就看得到是哪项。

export const QUOTA_RE = /free tier|exceeded|limit/i;

/** stub.fetch(...) 包一层：出错回 503 的 Response，不往外抛 */
export async function viaDO(stub, ...args) {
  try {
    return await stub.fetch(...args);
  } catch (e) {
    return doFail(e);
  }
}

export function doFail(e) {
  const msg = String((e && e.message) || e || 'unknown').replace(/\s+/g, ' ').slice(0, 300);
  const quota = QUOTA_RE.test(msg);
  return new Response(JSON.stringify({ error: quota ? 'do_quota' : 'do_error', message: msg }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': quota ? '600' : '30' },
  });
}
