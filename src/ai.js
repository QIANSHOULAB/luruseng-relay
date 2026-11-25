// 167 Claude 通道：录入僧（以后还有 168 铁屑江湖）先用 Song 那把 Claude API 钥匙（Max 每月送的额度），额度用完回老办法。
// - 钥匙只放这里（Luru 那个 Durable Object 的存储），由大管家推上来；设备上不放。设备只有配对时拿到的 cid（089），撤一台不用换钥匙。
// - 这里只做带门禁的直通：设备自己拼好 Claude Messages 请求，带 cid 发到 /ai/messages；站里补上钥匙，转给 api.anthropic.com，原样回。
//   代价：照片经过站里时是明文。只在内存里转一手：请求体直接流过去，不存、不拆、不记内容。
// - 门禁：cid 在 clients 表里、没被撤；每个 cid 一天最多 AI_DAY_MAX 次（新加坡时间的一天）；正文最大 AI_MAX_BYTES。
// - 额度用完（上游 400 且 message 带 credit balance，或者 402）：记成「歇着」，6 小时里 /ai/messages 直接回 503 {why:"quota"}，不打上游；
//   过了 6 小时放一个真请求去试（同一时间只放一个），成了就醒，没成再歇 6 小时。歇了、醒了都在大管家的 WebSocket 上说一声 {"t":"ai"}。
// - 记账：只从回答的 usage 记次数和 tokens（含缓存读写），按价目表折美元，按月（新加坡时间）、按模型分。不记内容。
// - 免费档：等上游的那 10～60 秒在 Worker 里等（Worker 等网络不算 CPU），Durable Object 只做门禁、记账两下快的。
//   请求体不 JSON.parse（几 MB 的 base64 会撞 10ms CPU）：直接流给上游；回答小，从回答里读 usage。
//
// 大管家的口子（/lr/pc/ai/…，要 x-lr-token，网页碰不了，见 luru.js）：
//   POST key {key} 放钥匙（只写不读，回尾 4 位）；POST conf {…} 模型表；GET state 看状态；POST client {cid, label} 登记设备（168 的 app）。
// 设备的口子（Origin 照 /lr/ask 的规矩，不带 Origin 的也行）：
//   GET /ai/conf（头 x-lr-cid）回模型表；POST /ai/messages（头 x-lr-cid，正文 = Claude Messages 请求，非流式）。

import { guard } from './limit.js';
import { viaDO } from './dofail.js';
import { access } from './luru.js';

export const AI_PATH = /^\/ai\/(conf|messages)$/;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MAX_BYTES = 10_000_000;          // 一张照片缩到大脑看的尺寸（JPEG 90）几百 KB，base64 再大三成；10MB 够两三张
const DAY_MAX = 400;                   // 一个 cid 一天最多几次（一张照片两遍，对不上第三遍：够一天一百多张）
const REST_MS = 6 * 3600_000;          // 额度用完歇多久再试
const PROBE_MS = 300_000;              // 试探的那一个这么久没回，再放下一个
const UP_MS = 240_000;                 // 等上游最多多久（Opus low 认一张一般 10～60 秒）
const SGT = 8 * 3600_000;

// 每百万 tokens 的美元价（Claude 价目表，11-25）：输入、输出、缓存读。缓存写 = 输入 × 1.25（5 分钟）/ × 2（1 小时）。
export const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};

const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const num = (env, k, d) => { const n = Number(env && env[k]); return Number.isFinite(n) && n > 0 ? n : d; };

export const sgtMonth = (t) => new Date(t + SGT).toISOString().slice(0, 7);
export const sgtDay = (t) => new Date(t + SGT).toISOString().slice(0, 10);

/** usage -> {in, out, cw, cr, usd, guess}；没见过的模型按 Opus 算、guess = true */
export function cost(model, u) {
  u = u || {};
  const id = Object.keys(PRICES).find((k) => String(model || '').startsWith(k));
  const [pi, po, pr] = PRICES[id || 'claude-opus-5-5'];
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const cc = u.cache_creation || {};
  const w5 = n(cc.ephemeral_5m_input_tokens), w1 = n(cc.ephemeral_1h_input_tokens);
  const cw = n(u.cache_creation_input_tokens) || w5 + w1;
  const writes = w5 + w1 > 0 ? w5 * 1.25 + w1 * 2 : cw * 1.25;
  const r = { in: n(u.input_tokens), out: n(u.output_tokens), cw, cr: n(u.cache_read_input_tokens) };
  r.usd = (r.in * pi + r.out * po + r.cr * pr + writes * pi) / 1e6;
  r.guess = !id;
  return r;
}

/** 上游回的是不是「额度用完」 */
export function isQuota(status, text) {
  if (status === 402) return true;
  return status === 400 && /credit balance/i.test(String(text || ''));
}

function errOf(text) {
  try {
    const e = JSON.parse(text).error || {};
    return { type: String(e.type || '').slice(0, 60), msg: String(e.message || '').replace(/\s+/g, ' ').slice(0, 200) };
  } catch (e) { return { type: '', msg: String(text || '').replace(/\s+/g, ' ').slice(0, 120) }; }
}

// ------------------------------------------------------------------ Worker 这头
export async function handleAi(req, env, m) {
  const h = access(req, env);
  if (!h) return new Response('origin not allowed', { status: 403 });
  if (h['Access-Control-Allow-Origin']) h['Access-Control-Allow-Headers'] = 'Content-Type, x-lr-cid, anthropic-version, anthropic-beta';
  const out = (res) => { for (const [k, v] of Object.entries(h)) res.headers.set(k, v); return res; };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const what = m[1];
  let ip = req.headers.get('CF-Connecting-IP') || '';
  if (env.LR_TEST && req.headers.get('x-test-ip')) ip = req.headers.get('x-test-ip');
  const limited = guard(env, 'http', 'ai|' + (ip || 'local') + '|' + what);
  if (limited) return out(limited);
  const cid = req.headers.get('x-lr-cid') || '';
  if (!ID_RE.test(cid)) return out(json({ why: 'cid', unknown: true }, 403));
  const room = env.LR_TEST ? (req.headers.get('x-test-room') || 'main') : 'main';
  const stub = env.LURU.get(env.LURU.idFromName(room));
  const inner = (path, body) => viaDO(stub, new Request('https://do/lr/_ai/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

  if (what === 'conf' && req.method === 'GET') {
    const r = await inner('conf', { cid });
    return out(new Response(r.body, r));
  }
  if (what !== 'messages' || req.method !== 'POST') return out(new Response('not found', { status: 404 }));

  const len = Number(req.headers.get('Content-Length') || NaN);
  if (!Number.isFinite(len)) return out(json({ why: 'length', error: 'Content-Length 要有' }, 411));
  if (len > num(env, 'AI_MAX_BYTES', MAX_BYTES)) return out(json({ why: 'big', error: 'too big' }, 413));

  const g = await inner('gate', { cid });
  if (g.status !== 200) return out(new Response(g.body, g));
  const gate = await g.json();

  const up = env.LR_TEST && env.AI_UPSTREAM ? env.AI_UPSTREAM : UPSTREAM;
  const ver = req.headers.get('anthropic-version');
  const beta = req.headers.get('anthropic-beta');
  let status = 0, text = '', type = 'application/json';
  try {
    const r = await fetch(up, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': String(len), 'x-api-key': gate.key,
        'anthropic-version': ver && /^\d{4}-\d{2}-\d{2}$/.test(ver) ? ver : VERSION,
        ...(beta && /^[a-z0-9,._ -]{1,300}$/i.test(beta) ? { 'anthropic-beta': beta } : {}),
      },
      body: req.body,                    // 直接流过去：站里不拆、不存
      signal: AbortSignal.timeout(num(env, 'AI_UP_MS', UP_MS)),
    });
    status = r.status;
    type = r.headers.get('content-type') || type;
    text = await r.text();
  } catch (e) {
    text = JSON.stringify({ type: 'error', error: { type: 'relay_upstream', message: String(e && e.message || e).slice(0, 200) } });
    status = 502;
  }

  const quota = isQuota(status, text);
  const note = { cid, probe: Boolean(gate.probe), status, quota };
  if (status === 200) {
    try { const j = JSON.parse(text); note.model = j.model; note.usage = j.usage; } catch (e) { note.model = '?'; }
  } else note.err = errOf(text);
  await inner('done', note);            // 记账：一下快的
  if (quota) return out(json({ why: 'quota', until: Date.now() + num(env, 'AI_REST_MS', REST_MS) }, 503));
  return out(new Response(text, { status, headers: { 'content-type': type, 'cache-control': 'no-store' } }));
}

// ------------------------------------------------------------------ Durable Object 这头（Luru 里用）
export class Ai {
  constructor(luru, env) {
    this.l = luru;
    this.sql = luru.sql;
    this.dayMax = num(env, 'AI_DAY_MAX', DAY_MAX);
    this.restMs = num(env, 'AI_REST_MS', REST_MS);
    this.probeMs = num(env, 'AI_PROBE_MS', PROBE_MS);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ai_use (month TEXT NOT NULL, model TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      err INTEGER NOT NULL DEFAULT 0, inp INTEGER NOT NULL DEFAULT 0, outp INTEGER NOT NULL DEFAULT 0, cw INTEGER NOT NULL DEFAULT 0,
      cr INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (month, model))`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS ai_day (day TEXT NOT NULL, cid TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, cid))');
  }

  get(k) { const v = this.l.getMeta('ai.' + k); if (v === null) return null; try { return JSON.parse(v); } catch (e) { return null; } }
  set(k, v) { if (v === null) this.sql.exec('DELETE FROM meta WHERE k = ?', 'ai.' + k); else this.l.setMeta('ai.' + k, JSON.stringify(v)); }

  client(cid) { return this.sql.exec('SELECT revoked FROM clients WHERE cid = ?', cid).toArray()[0]; }

  /** 有人在等：歇了、醒了说一声，大管家自己来读 state */
  tell(what) {
    const s = JSON.stringify({ t: 'ai', what });
    for (const ws of this.l.ctx.getWebSockets('pc')) { try { ws.send(s); } catch (e) { /* 断了 */ } }
  }

  /** Worker 来问的两下：gate（放不放、给钥匙）、done（记账）；conf（设备读模型表） */
  async inner(what, req) {
    const b = await req.json().catch(() => null);
    if (!b || !ID_RE.test(b.cid || '')) return json({ why: 'cid', unknown: true }, 403);
    const c = this.client(b.cid);
    if (what === 'done') return this.done(b);
    if (!c) return json({ why: 'cid', unknown: true }, 403);
    if (c.revoked) return json({ why: 'cid', revoked: true }, 403);
    const now = Date.now();
    const key = this.get('key');
    const rest = this.get('rest');
    if (what === 'conf') {
      return json({ ok: true, conf: this.get('conf') || {}, key: Boolean(key), rest: rest && now < rest.until ? rest.until : null });
    }
    if (what !== 'gate') return json({ error: 'not found' }, 404);
    if (!key) return json({ why: 'nokey' }, 503);
    let probe = false;
    if (rest) {
      if (now < rest.until) return json({ why: 'quota', until: rest.until }, 503);
      if (rest.probeAt && now - rest.probeAt < this.probeMs) return json({ why: 'quota', until: rest.probeAt + this.probeMs, probing: true }, 503);
      rest.probeAt = now;
      this.set('rest', rest);
      probe = true;
    }
    const day = sgtDay(now);
    this.sql.exec('DELETE FROM ai_day WHERE day < ?', sgtDay(now - 3 * 86400_000));
    const r = this.sql.exec('SELECT n FROM ai_day WHERE day = ? AND cid = ?', day, b.cid).toArray()[0];
    if (r && r.n >= this.dayMax) {
      if (probe) { rest.probeAt = 0; this.set('rest', rest); }
      return json({ why: 'day', max: this.dayMax }, 429);
    }
    this.sql.exec('INSERT INTO ai_day (day, cid, n) VALUES (?, ?, 1) ON CONFLICT (day, cid) DO UPDATE SET n = n + 1', day, b.cid);
    return json({ ok: true, key: key.k, probe });
  }

  done(b) {
    const now = Date.now();
    const month = sgtMonth(now);
    const ok = b.status === 200;
    const model = String((ok && b.model) || b.model || '?').slice(0, 60);
    if (ok) {
      const u = cost(model, b.usage);
      this.sql.exec(`INSERT INTO ai_use (month, model, n, inp, outp, cw, cr, usd) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT (month, model) DO UPDATE SET n = n + 1, inp = inp + excluded.inp, outp = outp + excluded.outp,
        cw = cw + excluded.cw, cr = cr + excluded.cr, usd = usd + excluded.usd`, month, model, u.in, u.out, u.cw, u.cr, u.usd);
      this.set('ok', now);
    } else {
      this.sql.exec(`INSERT INTO ai_use (month, model, err) VALUES (?, ?, 1)
        ON CONFLICT (month, model) DO UPDATE SET err = err + 1`, month, model === '?' ? '(错)' : model);
      this.set('err', { at: now, status: b.status, ...(b.err || {}), quota: Boolean(b.quota) });
    }
    const rest = this.get('rest');
    if (b.quota) {
      this.set('rest', { from: rest ? rest.from : now, until: now + this.restMs, probeAt: 0, tries: rest ? (rest.tries || 0) + 1 : 0 });
      if (!rest) this.tell('rest');
    } else if (rest && ok) {
      this.set('rest', null);
      this.set('woke', now);
      this.tell('woke');
    } else if (rest && b.probe) {
      rest.probeAt = 0;                  // 试探的那一个出了别的错：下一个接着试
      this.set('rest', rest);
    }
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- 大管家的口子（口令已经验过）
  async pc(what, req) {
    const now = Date.now();
    if (what === 'key' && req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (b && b.clear) { this.set('key', null); return json({ ok: true, has: false }); }
      const k = b && typeof b.key === 'string' ? b.key.trim() : '';
      if (!KEY_RE.test(k)) return json({ error: 'bad key' }, 400);
      const had = this.get('key');
      if (!had || had.k !== k) {
        this.set('key', { k, at: now });
        this.set('rest', null);          // 换了一把：先当它有额度
      }
      return json({ ok: true, tail: k.slice(-4), at: had && had.k === k ? had.at : now });
    }
    if (what === 'conf' && req.method === 'POST') {
      const t = await req.text();
      let c;
      try { c = JSON.parse(t); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (!c || typeof c !== 'object' || Array.isArray(c) || t.length > 4000) return json({ error: 'bad conf' }, 400);
      this.set('conf', c);
      return json({ ok: true });
    }
    if (what === 'client' && req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b || !ID_RE.test(b.cid || '')) return json({ error: 'cid' }, 400);
      this.sql.exec(`INSERT INTO clients (cid, label, at, last, uses, revoked) VALUES (?, ?, ?, NULL, 0, NULL)
        ON CONFLICT (cid) DO UPDATE SET label = excluded.label, revoked = NULL`, b.cid, String(b.label || '').replace(/[\x00-\x1f]/g, '').slice(0, 80), now);
      return json({ ok: true });
    }
    if (what === 'state' && req.method === 'GET') return json(this.state(now));
    return json({ error: 'not found' }, 404);
  }

  state(now) {
    const key = this.get('key');
    const rest = this.get('rest');
    const month = sgtMonth(now);
    const rows = (mo) => this.sql.exec('SELECT model, n, err, inp, outp, cw, cr, usd FROM ai_use WHERE month = ? ORDER BY model', mo).toArray();
    const sum = (rs) => Math.round(rs.reduce((a, r) => a + r.usd, 0) * 10000) / 10000;
    const cur = rows(month);
    const prevMonth = sgtMonth(Date.parse(month + '-01T00:00:00+08:00') - 86400_000);
    const prev = rows(prevMonth);
    const today = this.sql.exec('SELECT cid, n FROM ai_day WHERE day = ?', sgtDay(now)).toArray().map((r) => ({ cid: r.cid.slice(0, 6), n: r.n }));
    return {
      key: key ? { has: true, tail: key.k.slice(-4), at: key.at } : { has: false },
      rest: rest ? { from: rest.from, until: rest.until, probing: Boolean(rest.probeAt && now - rest.probeAt < this.probeMs), now: now < rest.until } : null,
      woke: this.get('woke'), last_ok: this.get('ok'), last_error: this.get('err'),
      month, models: Object.fromEntries(cur.map((r) => [r.model, { n: r.n, err: r.err, in: r.inp, out: r.outp, cache_write: r.cw, cache_read: r.cr, usd: Math.round(r.usd * 10000) / 10000 }])),
      usd: sum(cur), prev: { month: prevMonth, usd: sum(prev), n: prev.reduce((a, r) => a + r.n, 0) },
      today, day_max: this.dayMax, conf: this.get('conf'), pcs: this.l.machines().map((x) => x.who),   // 谁在线：歇了、醒了只让一台去喊 Song
    };
  }
}
