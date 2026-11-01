// Minimal Chrome DevTools Protocol driver over Node's global WebSocket (no playwright package needed).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// AF_CHROME_BIN wins when set (a missing path means "no browser"); otherwise the newest Playwright headless shell from
// PLAYWRIGHT_BROWSERS_PATH or ~/.cache/ms-playwright.
export function findChrome() {
  if (process.env.AF_CHROME_BIN) return existsSync(process.env.AF_CHROME_BIN) ? process.env.AF_CHROME_BIN : null;
  for (const cache of [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache/ms-playwright')].filter(Boolean)) {
    let dirs = [];
    try { dirs = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')); } catch { continue; }
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const bin = join(cache, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); })]).finally(() => clearTimeout(t));
};

// Starts the browser in its own process group so kill() takes its helper processes down too (by pgid, never by pattern).
export async function launch(bin, { userDataDir, width = 1400, height = 1300 }) {
  const proc = spawn(bin, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0',
    `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const exited = new Promise((r) => proc.once('exit', r));
  const kill = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    if (!done) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} await exited; }
  };
  try {
    let err = '';
    const wsUrl = await withTimeout(new Promise((resolve, reject) => {
      proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
      proc.once('exit', (code) => reject(new Error(`browser exited (${code}) before DevTools was ready: ${err.slice(-500)}`)));
      proc.once('error', reject);
    }), 15000, 'browser start');
    const { host } = new URL(wsUrl);
    const page = (await (await fetch(`http://${host}/json/list`)).json()).find((x) => x.type === 'page');
    const s = new WebSocket(page.webSocketDebuggerUrl);
    await withTimeout(new Promise((r, j) => { s.onopen = r; s.onerror = () => j(new Error('CDP socket error')); }), 10000, 'CDP connect');
    let n = 0; const pend = new Map(); const logs = [];
    s.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') logs.push(d.params.exceptionDetails);
    };
    const send = (method, params = {}) => withTimeout(new Promise((r) => { const i = ++n; pend.set(i, r); s.send(JSON.stringify({ id: i, method, params })); }), 20000, method)
      .then((d) => { if (d.error) throw new Error(`${method}: ${d.error.message}`); return d.result; });
    // Runs fn(...args) in the page and returns its JSON value.
    const ev = async (fn, ...args) => {
      const r = await send('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    return { send, ev, logs, pid: proc.pid, close: async () => { try { s.close(); } catch {} await kill(); } };
  } catch (e) {
    await kill();
    throw e;
  }
}
