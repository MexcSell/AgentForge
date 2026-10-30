#!/usr/bin/env node
// AgentForge supervisor: keeps the service up and restarts it *safely* when code changes.
//   server/**  change → syntax check → candidate boot on a side port → health check
//                    → wait until no agent is running → graceful swap → health check
//   client/**  change → build into client/dist-next → atomic swap → browsers reload
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fork, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { config } = await import(path.join(ROOT, 'server', 'config.js'));
const PORT = config.port;
const PID_FILE = path.join(ROOT, 'data', 'supervisor.pid');
const DIST = path.join(ROOT, 'client', 'dist');

const log = (...a) => console.log(new Date().toISOString(), '[supervisor]', ...a);

// ---- single instance -------------------------------------------------------
if (fs.existsSync(PID_FILE)) {
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  try { process.kill(pid, 0); log(`already running (pid ${pid})`); process.exit(1); } catch { /* stale */ }
}
fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));

const state = { pendingRestart: false, waitingForAgents: 0, building: false, lastRestartAt: null, lastBuildAt: null, lastError: null, clientVersion: null, restarts: 0 };
let server = null;
let stopping = false;
let swapping = false;
let crashBackoff = 1000;

const send = (msg) => { try { server?.connected && server.send(msg); } catch {} };
const publish = () => send({ type: 'supervisor', state });

// ---- helpers ---------------------------------------------------------------
function health(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); });
    };
    const retry = () => (Date.now() > deadline ? resolve(false) : setTimeout(attempt, 400));
    attempt();
  });
}

function startServer() {
  const child = fork(path.join(ROOT, 'server', 'index.js'), [], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
  child.on('message', onServerMessage);
  child.on('exit', (code, signal) => {
    if (child !== server) return;
    server = null;
    if (stopping || swapping) return;
    log(`server exited unexpectedly (code ${code}, signal ${signal}); restarting in ${crashBackoff}ms`);
    setTimeout(() => { if (!server && !stopping) server = startServer(); }, crashBackoff);
    crashBackoff = Math.min(30000, crashBackoff * 2);
  });
  return child;
}

function onServerMessage(msg) {
  if (msg?.type === 'ready') { crashBackoff = 1000; publish(); }
  else if (msg?.type === 'restart-request') scheduleRestart('requested from the dashboard', msg.force ? 0 : 200, !!msg.force);
  else if (msg?.type === 'busy') pendingBusy.get(msg.id)?.(msg);
}

const pendingBusy = new Map();
function askBusy() {
  return new Promise((resolve) => {
    if (!server?.connected) return resolve({ busy: false });
    const id = Math.random().toString(36).slice(2);
    const t = setTimeout(() => { pendingBusy.delete(id); resolve({ busy: false }); }, 3000);
    pendingBusy.set(id, (m) => { clearTimeout(t); pendingBusy.delete(id); resolve(m); });
    send({ type: 'busy?', id });
  });
}

function stopServer(child, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill('SIGTERM');
  });
}

// ---- safe restart ----------------------------------------------------------
const changedServerFiles = new Set();
let restartTimer = null;
let restartRunning = false;
let restartAgain = false;
let forceNext = false;

function scheduleRestart(reason, delay = 1500, force = false) {
  forceNext = forceNext || force;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => safeRestart(reason), delay);
}

async function safeRestart(reason) {
  if (restartRunning) { restartAgain = true; return; }
  restartRunning = true;
  const force = forceNext;
  forceNext = false;
  state.pendingRestart = true;
  publish();
  const files = [...changedServerFiles];
  changedServerFiles.clear();
  try {
    // 1. Syntax check.
    for (const f of files.filter((f) => f.endsWith('.js') && fs.existsSync(f))) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`Syntax error in ${path.relative(ROOT, f)}:\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`);
    }
    // 2. Candidate boot on a side port.
    const cport = PORT + 1;
    let out = '';
    const cand = fork(path.join(ROOT, 'server', 'index.js'), [], { cwd: ROOT, env: { ...process.env, PORT: String(cport), AF_CANDIDATE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    cand.stdout.on('data', (d) => { out += d; });
    cand.stderr.on('data', (d) => { out += d; });
    const ok = await health(cport, 20000);
    await stopServer(cand, 5000);
    if (!ok) throw new Error(`Candidate failed health check:\n${out.trim().split('\n').slice(-8).join('\n')}`);
    // 3. Wait until no agent is mid-task.
    if (!force) {
      for (;;) {
        const b = await askBusy();
        if (!b.busy) break;
        state.waitingForAgents = b.runs || b.missions || 1;
        publish();
        await new Promise((r) => setTimeout(r, 3000));
        if (forceNext) break;
      }
    }
    state.waitingForAgents = 0;
    // 4. Graceful swap.
    log(`restarting: ${reason}`);
    swapping = true;
    await stopServer(server);
    server = startServer();
    swapping = false;
    if (!(await health(PORT, 30000))) throw new Error('New server did not become healthy');
    state.lastRestartAt = new Date().toISOString();
    state.restarts += 1;
    state.lastError = null;
    state.pendingRestart = false;
    setTimeout(() => { publish(); send({ type: 'restarted', reason }); }, 500);
    log('restart complete');
  } catch (err) {
    swapping = false;
    if (!server) server = startServer();
    state.lastError = err.message;
    state.pendingRestart = false;
    state.waitingForAgents = 0;
    log('restart blocked:', err.message);
    publish();
  } finally {
    restartRunning = false;
    if (restartAgain) { restartAgain = false; scheduleRestart('more changes', 500); }
  }
}

// ---- client build ----------------------------------------------------------
let buildTimer = null;
let buildRunning = false;
let buildAgain = false;

function viteBuild(outDir) {
  return new Promise((resolve) => {
    const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const p = spawn(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: ROOT, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ ok: code === 0, out }));
  });
}

async function buildClient(reason) {
  if (buildRunning) { buildAgain = true; return; }
  buildRunning = true;
  state.building = true;
  publish();
  log(`building client: ${reason}`);
  const next = path.join(ROOT, 'client', 'dist-next');
  const prev = path.join(ROOT, 'client', 'dist-prev');
  const r = await viteBuild(next);
  if (r.ok && fs.existsSync(path.join(next, 'index.html'))) {
    fs.rmSync(prev, { recursive: true, force: true });
    if (fs.existsSync(DIST)) fs.renameSync(DIST, prev);
    fs.renameSync(next, DIST);
    state.lastBuildAt = new Date().toISOString();
    state.clientVersion = Date.now().toString(36);
    if (state.lastError?.startsWith('Client build')) state.lastError = null;
    send({ type: 'client-updated', version: state.clientVersion });
    log('client build swapped in');
  } else {
    state.lastError = `Client build failed:\n${r.out.trim().split('\n').slice(-10).join('\n')}`;
    log(state.lastError);
  }
  state.building = false;
  publish();
  buildRunning = false;
  if (buildAgain) { buildAgain = false; buildClient('more changes'); }
}

function clientIsStale() {
  const index = path.join(DIST, 'index.html');
  if (!fs.existsSync(index)) return true;
  const built = fs.statSync(index).mtimeMs;
  const newest = (dir) => {
    let m = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      m = Math.max(m, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
    }
    return m;
  };
  return Math.max(newest(path.join(ROOT, 'client', 'src')), fs.statSync(path.join(ROOT, 'client', 'index.html')).mtimeMs) > built;
}

// ---- boot ------------------------------------------------------------------
if (clientIsStale()) {
  log('client build is missing or stale; building before start');
  const r = await viteBuild(DIST);
  if (!r.ok) log('initial client build failed:\n' + r.out);
  else state.lastBuildAt = new Date().toISOString();
}
server = startServer();
log(`supervising server on http://${config.host}:${PORT} (pid ${process.pid})`);

const ignored = (p) => /node_modules|\/dist(-next|-prev)?\/|\.git\//.test(p);
chokidar.watch([path.join(ROOT, 'server'), path.join(ROOT, 'package.json')], { ignoreInitial: true, ignored, awaitWriteFinish: { stabilityThreshold: 400 } })
  .on('all', (ev, file) => { changedServerFiles.add(file); scheduleRestart(`${ev} ${path.relative(ROOT, file)}`); });
chokidar.watch([path.join(ROOT, 'client', 'src'), path.join(ROOT, 'client', 'index.html'), path.join(ROOT, 'client', 'public'), path.join(ROOT, 'vite.config.js')], { ignoreInitial: true, ignored, awaitWriteFinish: { stabilityThreshold: 400 } })
  .on('all', (ev, file) => { clearTimeout(buildTimer); buildTimer = setTimeout(() => buildClient(`${ev} ${path.relative(ROOT, file)}`), 1200); });

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('stopping');
  await stopServer(server);
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
