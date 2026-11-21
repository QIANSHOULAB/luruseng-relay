// 信箱测试用：起一个 wrangler dev（不用 Cloudflare 账号），等它好了再测；测完整组关掉。
import { spawn } from 'node:child_process';

export async function startDev(port, persist, vars = []) {
  const args = ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist];
  for (const v of vars) args.push('--var', v);
  const dev = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, detached: true });
  let out = '';
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('wrangler dev 没起来：\n' + out)), 90000);
    const look = (d) => { out += d; if (/Ready on/.test(out)) { clearTimeout(t); ok(); } };
    dev.stdout.on('data', look);
    dev.stderr.on('data', look);
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/ping')).ok) break; } catch (e) { /* 还没好 */ } await new Promise((r) => setTimeout(r, 200)); }
  return {
    base,
    stop() {                            // npx 底下还有 wrangler、workerd：整组一起关
      try { process.kill(-dev.pid, 'SIGTERM'); } catch (e) { /* 已经没了 */ }
      dev.stdout.destroy();
      dev.stderr.destroy();
    },
  };
}

/** 一个 WebSocket：收到的都记下来，next(条件) 等某一条 */
export function socket(url, opts = {}) {
  const s = new WebSocket(url, opts);
  s.got = [];
  s.waiters = [];
  s.onmessage = (e) => {
    const m = e.data === 'pong' ? { t: 'pong' } : JSON.parse(e.data);
    s.got.push(m);
    s.waiters = s.waiters.filter((w) => !w(m));
  };
  s.next = (pred, ms = 5000) => new Promise((ok, bad) => {
    const hit = s.got.find(pred);
    if (hit) return ok(hit);
    const t = setTimeout(() => bad(new Error('等不到消息，收到的：' + JSON.stringify(s.got).slice(0, 2000))), ms);
    s.waiters.push((m) => (pred(m) ? (clearTimeout(t), ok(m), true) : false));
  });
  s.closed = new Promise((r) => { s.onclose = (e) => r(e); });
  return new Promise((ok, bad) => { s.onopen = () => ok(s); s.onerror = (e) => bad(new Error('连不上 ' + url + '：' + (e.message || e.type))); });
}

export const newBox = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
