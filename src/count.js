// 铁件点钞机 · 免钥匙通道：网页把照片（JPEG 的 base64）POST 到 /count，这里拿 Song 的谷歌钥匙去问 Gemini，原样把回答还回去。
// 钥匙是 Cloudflare 里的 Secret（GEMINI_KEY，可选备胎 GEMINI_KEY2），不在代码里、不进仓库。
// 只帮数工件：问什么（提示词、回答格式）写死在这里，网页只能递照片，别人拿去问别的问不了。
// 额度：每个 IP 每天、所有人每天各有上限（新加坡时间零点重置），超了回 429，网页就让用户贴自己的钥匙。

export const COUNT_PROMPT = [
  'This is a shop-floor photo of finished machined parts sitting in foam trays (boxes). Count the parts.',
  '1. Find every tray / box / foam insert in the photo, including ones only partly visible at the image edges.',
  '   For each one give box_2d = [ymin, xmin, ymax, xmax] normalized to 0-1000, and complete = true only if the whole tray,',
  '   all four sides, is inside the photo: not cut off by the image border and not hidden behind something. If not complete, say why in cut_reason.',
  '2. For each tray, put exactly one point [y, x] (normalized 0-1000) on every individual part in that tray.',
  '   Work slot by slot, row by row, so none is skipped. Parts that overlap, lean, stack or share one slot each get their own point,',
  '   placed on a visible area of that specific part. Never mark empty slots, foam, labels, paper tags, strings, tools or anything outside a tray.',
  '3. part = a 2-4 word description of the parts.',
].join('\n');

export const COUNT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    part: { type: 'STRING' },
    trays: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
          complete: { type: 'BOOLEAN' },
          cut_reason: { type: 'STRING' },
          parts: { type: 'ARRAY', items: { type: 'OBJECT', properties: { point: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['point'] } },
        },
        required: ['box_2d', 'complete', 'parts'],
        propertyOrdering: ['box_2d', 'complete', 'cut_reason', 'parts'],
      },
    },
  },
  required: ['trays'],
  propertyOrdering: ['part', 'trays'],
};

const MAX_B64 = 4_000_000;              // 照片 base64 最长（网页缩到 2048 边、JPEG 0.85，一般 0.5–1.5MB）
const MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash'];   // 先 Pro，额度没了换 Flash
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/';

// 请求体用字符串拼，不 JSON.parse 那几 MB 的照片：免费版 Worker 每次只给 10ms CPU
const HEAD = '{"contents":[{"role":"user","parts":[{"inline_data":{"mime_type":"image/jpeg","data":"';
const TAIL = '"}},{"text":' + JSON.stringify(COUNT_PROMPT) + '}]}],"generationConfig":{"responseMimeType":"application/json","responseSchema":'
  + JSON.stringify(COUNT_SCHEMA) + ',"maxOutputTokens":32768}}';

const sgDay = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);   // 新加坡日期

export async function handleCount(req, env, h) {
  const out = (o, status) => new Response(JSON.stringify(o), { status, headers: { ...h, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (req.method !== 'POST') return out({ error: { code: 'method', message: 'POST only' } }, 405);

  const keys = [env.GEMINI_KEY, env.GEMINI_KEY2].map((k) => String(k || '').trim()).filter(Boolean);
  if (!keys.length) return out({ error: { code: 'no_key', message: 'relay has no key' } }, 503);

  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_B64) return out({ error: { code: 'too_big', message: 'photo too big' } }, 413);
  const b64 = await req.text();
  // 只收 JPEG 的 base64：开头 /9j/，里面不许有引号、反斜杠（拼进 JSON 时插不进别的东西）
  if (b64.length < 1000 || b64.length > MAX_B64 || !b64.startsWith('/9j/') || b64.indexOf('"') >= 0 || b64.indexOf('\\') >= 0) {
    return out({ error: { code: 'bad_image', message: 'not a JPEG' } }, 400);
  }

  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const q = await env.QUOTA.get(env.QUOTA.idFromName('count')).fetch('https://quota/take', {
    method: 'POST',
    body: JSON.stringify({ day: sgDay(), ip, ipMax: Number(env.COUNT_IP_MAX || 40), allMax: Number(env.COUNT_ALL_MAX || 400) }),
  }).then((r) => r.json());
  if (!q.ok) return out({ error: { code: 'quota_' + q.why, message: 'free quota used up today' } }, 429);

  const body = HEAD + b64 + TAIL;
  let last = { status: 502, text: JSON.stringify({ error: { code: 'upstream', message: 'cannot reach Google' } }) };
  for (const m of MODELS) {
    for (const k of keys) {
      let r;
      try {
        r = await fetch((env.GEMINI_BASE || GEMINI) + m + ':generateContent?key=' + encodeURIComponent(k), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        });
      } catch (e) { continue; }
      const text = await r.text();
      if (r.ok) return new Response(text, { status: 200, headers: { ...h, 'content-type': 'application/json', 'x-model': m } });
      last = { status: r.status, text };
      if (!(r.status === 429 || r.status === 500 || r.status === 503)) break;   // 别的错（钥匙坏了、图有问题）换模型也没用
    }
    if (!(last.status === 429 || last.status === 500 || last.status === 503 || last.status === 502)) break;
  }
  // 谷歌的错原样还回去（网页显示 HTTP 状态 + message）；钥匙绝不回传
  const safe = last.text.split(keys[0]).join('***').split(keys[1] || '\u0000').join('***');
  return new Response(safe, { status: last.status, headers: { ...h, 'content-type': 'application/json' } });
}

// 额度账本：一个 Durable Object，按天记每个 IP 和总数
export class Quota {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS hits (day TEXT NOT NULL, ip TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, ip))');
  }

  async fetch(req) {
    const { day, ip, ipMax, allMax } = await req.json();
    this.sql.exec('DELETE FROM hits WHERE day < ?', day);   // 昨天的账清掉
    const all = this.sql.exec('SELECT COALESCE(SUM(n), 0) AS s FROM hits WHERE day = ?', day).one().s;
    if (all >= allMax) return Response.json({ ok: false, why: 'all' });
    const mine = (this.sql.exec('SELECT n FROM hits WHERE day = ? AND ip = ?', day, ip).toArray()[0] || { n: 0 }).n;
    if (mine >= ipMax) return Response.json({ ok: false, why: 'ip' });
    this.sql.exec('INSERT INTO hits (day, ip, n) VALUES (?, ?, 1) ON CONFLICT (day, ip) DO UPDATE SET n = n + 1', day, ip);
    return Response.json({ ok: true, left: Math.min(allMax - all - 1, ipMax - mine - 1) });
  }
}
