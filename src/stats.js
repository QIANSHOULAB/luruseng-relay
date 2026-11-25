// 额度账（施工单 125）：每个 Durable Object 自己数「谁、敲了哪个口、几次」，一小时一格，只数、不记内容。
// - 数在内存里（加一下，不花额度、不写盘）；隔 10 分钟以上、或者换了小时、或者攒了 200 下才落盘，落盘是一行（一次写）。
//   所以落盘的写次数一天最多 144 次，不会再去吃「写行数」的额度；DO 被收走时最多丢掉最后 10 分钟没落盘的。
// - 140：上面那条在线上几乎全丢：信箱用 WebSocket 休眠，一下请求办完 10 秒左右 DO 就被收走，10 分钟 / 200 下从来等不到，
//   读数永远只有「刚才读数那一下」。现在记一下以后 5 秒落一次盘（5 秒里再来的一起落，一个 DO 最多 5 秒一次写）；
//   DO 本来就要 10 秒才休眠，多等这 5 秒不多占时长。
// - 一格的名字：<口>[|<谁>][|<状态码>]，例如 「PUT msg>pc|dagj|200」「ws pc|desk|101」「alarm」。
//   谁：连 WebSocket 的是 desk / handheld / phone；普通请求按 User-Agent 分大类（dagj＝大管家、ios＝手机 app、web＝带 Origin 的网页、other）。
//   只记大类，不记 User-Agent 原文、不记 IP、不记信箱号全文、不记信的内容。
// - 读数：每条路各有一个口（/dgj/<信箱号>/stats、/lr/pc/stats、/r/<房间>/stats），只给数。读数本身也算一次请求，记在「stats」里。
// - 为什么不用 Workers 日志 / Analytics Engine：日志要在 Cloudflare 后台看、而且每条请求会带上完整地址（含信箱号）；
//   Analytics Engine 要建 API token 才读得出来。这里自己数，一条 curl 就读得到，也不带任何私密的东西。

const HOUR = 3600_000;
const KEEP_HOURS = 72;                 // 留 3 天
const FLUSH_MS = 600_000;              // 隔多久落一次盘
const FLUSH_EVERY = 200;               // 或者攒了多少下
const SOON_MS = 5_000;                 // 140：记了一下，这么久以后落盘（赶在 DO 被收走之前）
const KEY = 'stats';

/** 谁在敲（普通请求）：只分大类 */
export function clientClass(req) {
  if (req.headers.get('Origin')) return 'web';
  const ua = req.headers.get('User-Agent') || '';
  if (/^Dagj/i.test(ua)) return 'dagj';
  if (/CFNetwork|Darwin|Yiye/i.test(ua)) return 'ios';
  if (/^python|^urllib|^curl|^node|^undici/i.test(ua)) return 'tool';
  return 'other';
}

export class Stats {
  constructor(ctx, route, now = () => Date.now(), soonMs = SOON_MS) {
    this.soonMs = soonMs;
    this.timer = null;
    this.ctx = ctx;
    this.route = route;
    this.now = now;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS stats_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const r = this.sql.exec('SELECT v FROM stats_meta WHERE k = ?', KEY).toArray()[0];
    let saved = null;
    try { saved = r ? JSON.parse(r.v) : null; } catch (e) { /* 坏了就重新数 */ }
    this.hours = (saved && saved.hours) || {};          // { '<小时起点毫秒>': { '<格>': 次数 } }
    this.since = (saved && saved.since) || this.now();   // 从什么时候开始数的
    this.born = this.now();                              // 这个 DO 这一回醒来的时间
    this.dirty = 0;
    this.lastFlush = this.now();
    this.lastHour = null;
  }

  /** 记一下：op 是口，who 是谁，status 是回的状态码（没有就不写） */
  hit(op, who = '', status = 0) {
    const t = this.now();
    const h = String(Math.floor(t / HOUR) * HOUR);
    const key = op + (who || status ? '|' + who : '') + (status ? '|' + status : '');
    const hr = this.hours[h] || (this.hours[h] = {});
    hr[key] = (hr[key] || 0) + 1;
    this.dirty++;
    if (this.dirty >= FLUSH_EVERY || t - this.lastFlush >= FLUSH_MS || (this.lastHour && this.lastHour !== h)) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.soonMs);   // 140
    this.lastHour = h;
  }

  flush() {
    if (!this.dirty) return;
    const cut = Math.floor(this.now() / HOUR) * HOUR - KEEP_HOURS * HOUR;
    for (const h of Object.keys(this.hours)) if (Number(h) < cut) delete this.hours[h];
    try {
      this.sql.exec('INSERT OR REPLACE INTO stats_meta (k, v) VALUES (?, ?)', KEY, JSON.stringify({ since: this.since, hours: this.hours }));
    } catch (e) { /* 落不了盘也不要紧，内存里还在 */ }
    this.dirty = 0;
    this.lastFlush = this.now();
  }

  /** 读数：按小时，每小时有总数和每一格；另给一份合计、从什么时候数起、这个 DO 这一回醒了多久 */
  read(extra = {}) {
    const hours = Object.keys(this.hours).sort().map((h) => {
      const ops = this.hours[h];
      const total = Object.values(ops).reduce((a, b) => a + b, 0);
      return { hour: new Date(Number(h)).toISOString().slice(0, 13) + 'Z', total, ops, start: Number(h) };
    });
    const sum = {};
    let all = 0;
    const today = Math.floor(this.now() / (24 * HOUR)) * 24 * HOUR;        // 额度按 UTC 一天算（UTC 0 点清零）
    let todayN = 0;
    for (const hr of hours) {
      for (const [k, n] of Object.entries(hr.ops)) { sum[k] = (sum[k] || 0) + n; all += n; }
      if (hr.start >= today) todayN += hr.total;
    }
    return {
      route: this.route, now: new Date(this.now()).toISOString(), since: new Date(this.since).toISOString(),
      awakeFor_s: Math.round((this.now() - this.born) / 1000), todayUTC: todayN, total: all,
      note: '次数＝这个口被敲了几次（WebSocket 消息 20 条才算 1 次请求；alarm 每响一次算 1 次请求）；还没落盘的最后几分钟也在里面',
      ...extra, sum: Object.fromEntries(Object.entries(sum).sort((a, b) => b[1] - a[1])),
      hours: hours.map(({ start, ...rest }) => rest),
    };
  }
}
