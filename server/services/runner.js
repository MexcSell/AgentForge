// Run & preview: one in-memory session per project. Detects how to run the project, spawns it in
// its own process group on a loopback port, and streams status + logs as preview:* events.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { emit } from '../events.js';
import { childEnv } from './env.js';

export const NO_PLAN = 'No run command detected — set one in Project settings';
const LOG_LINES = 2000;
const LINE_MAX = 4000;
const READY_TIMEOUT_MS = 60000;
const KILL_GRACE_MS = 3000;
const EMIT_MS = 100; // per project: at most ~10 flushes (one log + one update event each) per second
const LOOPBACK = ['127.0.0.1', '::1'];
const SHELL = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
const VITE = /(?:^|[\s/])vite(?:\.js)?(?=\s|$)/;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

const sessions = new Map(); // project id → session
const groups = new Set(); // process group ids that may still be alive
let closing = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export const previewBase = (id) => `/preview/${id}/`;

// The AgentForge checkout itself is never spawned again: a second copy would hit the live DB and port.
export const isSelf = (dir) => path.resolve(dir) === config.root || real(dir) === real(config.root);

/** run_command → package.json dev/start (npm run) → index.html in ./, public/ or dist/ (static). */
export function detectPlan(project) {
  const dir = path.resolve(String(project.path || ''));
  if (isSelf(dir)) return { mode: 'self', source: 'self', command: null };
  const scripts = readJson(path.join(dir, 'package.json'))?.scripts || {};
  const custom = project.run_command?.trim();
  if (custom) {
    const m = /^npm\s+(?:run(?:-script)?\s+(\S+)|(start))\s*$/.exec(custom);
    const body = m ? scripts[m[1] || m[2]] : null;
    const npmScript = typeof body === 'string';
    return { mode: 'server', source: 'run_command', command: custom, vite: VITE.test(npmScript ? body : custom), npmScript };
  }
  for (const name of ['dev', 'start']) {
    if (typeof scripts[name] === 'string' && scripts[name].trim()) {
      return { mode: 'server', source: `package.json:${name}`, command: `npm run ${name}`, vite: VITE.test(scripts[name]), npmScript: true };
    }
  }
  for (const sub of ['', 'public', 'dist']) {
    const root = path.join(dir, sub);
    if (isFile(path.join(root, 'index.html'))) return { mode: 'static', source: 'index.html', command: null, root };
  }
  return { mode: null, source: null, command: null, error: NO_PLAN };
}

function blank(id) {
  return {
    project_id: id, status: 'idle', mode: null, command: null, port: null, pid: null, url: null,
    startedAt: null, exitCode: null, signal: null, error: null, updatedAt: null,
    host: null, root: null, keepPrefix: false, child: null, stopping: false, gen: 0,
    log: [], pending: [], skipped: 0, partial: {}, dirty: false, timer: null, lastEmit: 0,
  };
}

function session(id) {
  if (!sessions.has(id)) sessions.set(id, blank(id));
  return sessions.get(id);
}

export function snapshot(s) {
  return {
    project_id: s.project_id, status: s.status, mode: s.mode, command: s.command, port: s.port, pid: s.pid, url: s.url,
    startedAt: s.startedAt, exitCode: s.exitCode, signal: s.signal, error: s.error, updatedAt: s.updatedAt,
  };
}

/** Live session used by the /preview proxy (null when the project never started one). */
export const getPreview = (id) => sessions.get(id) || null;

export function previewState(project, lines = 500) {
  const s = sessions.get(project.id) || blank(project.id);
  const n = Math.min(LOG_LINES, Math.max(0, Number(lines) || 500));
  return { ...snapshot(s), plan: detectPlan(project), log: n ? s.log.slice(-n) : [] };
}

// ---- events ----------------------------------------------------------------
function schedule(s) {
  if (s.timer) return;
  s.timer = setTimeout(() => flush(s), Math.max(0, s.lastEmit + EMIT_MS - Date.now()));
  s.timer.unref();
}

function flush(s) {
  s.timer = null;
  s.lastEmit = Date.now();
  if (s.skipped) {
    s.pending.unshift(`[preview] … ${s.skipped} lines skipped (output faster than the log stream)`);
    s.skipped = 0;
  }
  if (s.pending.length) emit('preview:log', { project_id: s.project_id, lines: s.pending.splice(0) });
  if (s.dirty) {
    s.dirty = false;
    emit('preview:update', snapshot(s));
  }
}

function update(s, fields) {
  Object.assign(s, fields, { updatedAt: new Date().toISOString() });
  s.dirty = true;
  schedule(s);
  return snapshot(s);
}

function addLines(s, lines) {
  for (let line of lines) {
    line = line.replace(/\r$/, '');
    if (line.includes('\r')) line = line.slice(line.lastIndexOf('\r') + 1); // progress output: keep what a terminal would show
    line = line.replace(ANSI, '').slice(0, LINE_MAX);
    s.log.push(line);
    s.pending.push(line);
  }
  if (s.log.length > LOG_LINES + 200) s.log.splice(0, s.log.length - LOG_LINES);
  if (s.pending.length > LOG_LINES) s.skipped += s.pending.splice(0, s.pending.length - LOG_LINES).length;
  schedule(s);
}

function onOutput(s, key, chunk) {
  const parts = ((s.partial[key] || '') + chunk).split('\n');
  s.partial[key] = parts.pop();
  if (s.partial[key].length > LINE_MAX) {
    parts.push(s.partial[key]);
    s.partial[key] = '';
  }
  if (parts.length) addLines(s, parts);
}

function endOutput(s, key) {
  if (s.partial[key]) addLines(s, [s.partial[key]]);
  delete s.partial[key];
}

function fail(s, message) {
  addLines(s, [`[preview] ${message}`]);
  return update(s, { status: 'error', error: message });
}

// ---- processes -------------------------------------------------------------
function signalGroup(pgid, sig) {
  try { process.kill(-pgid, sig); return true; } catch { return false; }
}

async function groupGone(pgid, ms) {
  const deadline = Date.now() + ms;
  while (signalGroup(pgid, 0)) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

// SIGTERM the whole process group, SIGKILL whatever is left after the grace period.
async function killGroup(pgid) {
  if (signalGroup(pgid, 'SIGTERM') && !(await groupGone(pgid, KILL_GRACE_MS))) {
    signalGroup(pgid, 'SIGKILL');
    await groupGone(pgid, 1000);
  }
  groups.delete(pgid);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function listeningHost(port) {
  for (const host of LOOPBACK) if (await canConnect(host, port)) return host;
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitUntilListening(s, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (s.child === child && s.status === 'starting') {
    const host = await listeningHost(s.port);
    if (s.child !== child || s.status !== 'starting') return;
    if (host) {
      addLines(s, [`[preview] ready on port ${s.port}`]);
      update(s, { status: 'running', host });
      return;
    }
    if (Date.now() > deadline) {
      fail(s, `Nothing listened on port ${s.port} within ${READY_TIMEOUT_MS / 1000} s — make the app use the PORT environment variable or set a preview port in Project settings`);
      killGroup(child.pid);
      return;
    }
    await sleep(300);
  }
}

function onExit(s, child, code, signal) {
  if (s.child !== child) return;
  for (const key of Object.keys(s.partial)) endOutput(s, key);
  s.child = null;
  killGroup(child.pid); // stragglers the leader left behind in its group
  const how = signal ? `signal ${signal}` : `code ${code}`;
  addLines(s, [`[preview] process exited (${how})`]);
  const early = s.status === 'starting' && !s.stopping;
  update(s, {
    status: early || s.status === 'error' ? 'error' : 'exited',
    error: early ? `Exited (${how}) before port ${s.port} accepted connections` : s.error,
    exitCode: code, signal, pid: null,
  });
}

export async function startPreview(project) {
  const s = session(project.id);
  if (s.status === 'starting' || s.status === 'running') return snapshot(s);
  const gen = ++s.gen;
  const plan = detectPlan(project);
  const sub = String(project.preview_path || '').trim().replace(/^\/+/, '');
  Object.assign(s, {
    mode: plan.mode, command: plan.command, port: null, pid: null, url: null, host: null, root: null, keepPrefix: false,
    exitCode: null, signal: null, error: null, stopping: false, partial: {}, startedAt: new Date().toISOString(),
  });
  if (closing) return fail(s, 'AgentForge is shutting down');
  if (plan.mode === 'self') {
    addLines(s, ['[preview] This is AgentForge itself — showing the live instance instead of starting a copy']);
    return update(s, { status: 'running', url: '/' });
  }
  if (plan.error) return fail(s, plan.error);
  const base = previewBase(project.id);
  if (plan.mode === 'static') {
    s.root = real(plan.root);
    addLines(s, [`[preview] serving static files from ${s.root}`]);
    return update(s, { status: 'running', url: base + sub });
  }

  const dir = path.resolve(project.path);
  if (!fs.existsSync(dir)) return fail(s, `Project folder not found: ${dir}`);
  update(s, { status: 'starting', url: base + sub });
  let port = Number(project.preview_port) || null;
  try {
    // A fixed port must be free: the proxy may only ever reach a process this session started.
    if (port && (await listeningHost(port))) throw new Error(`Port ${port} is already in use — stop what is using it or clear the preview port`);
    port ||= await freePort();
  } catch (e) {
    return gen === s.gen ? fail(s, e.message) : snapshot(s);
  }
  if (gen !== s.gen) return snapshot(s); // stopped while we were picking a port

  const command = plan.vite ? `${plan.command}${plan.npmScript ? ' --' : ''} --port ${port} --strictPort --host 127.0.0.1 --base ${base}` : plan.command;
  let child;
  try {
    child = spawn(SHELL, ['-c', command], {
      cwd: dir,
      detached: true, // own process group → stop kills the whole tree
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', PATH: [path.join(dir, 'node_modules', '.bin'), process.env.PATH].filter(Boolean).join(path.delimiter) }),
    });
  } catch (e) {
    return fail(s, `Could not start: ${e.message}`);
  }
  if (child.pid) groups.add(child.pid);
  s.child = child;
  s.keepPrefix = !!plan.vite; // vite serves under --base, so the proxy forwards the full /preview/<id>/ path
  addLines(s, [`[preview] $ ${command}`, `[preview] PORT=${port}  cwd=${dir}`]);
  for (const [key, stream] of [['out', child.stdout], ['err', child.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', (d) => onOutput(s, key, d));
    stream.on('end', () => endOutput(s, key));
  }
  child.on('error', (e) => { if (s.child === child && !child.pid) { s.child = null; fail(s, `Could not start: ${e.message}`); } });
  child.on('exit', (code, signal) => onExit(s, child, code, signal));
  const snap = update(s, { command, port, pid: child.pid ?? null });
  waitUntilListening(s, child);
  return snap;
}

export async function stopPreview(id) {
  const s = sessions.get(id);
  if (!s) return snapshot(blank(id));
  s.gen++; // cancels a start that is still picking a port
  const child = s.child;
  if (child?.pid) {
    s.stopping = true;
    addLines(s, ['[preview] stopping…']);
    const exited = child.exitCode !== null || child.signalCode !== null ? null : new Promise((r) => child.once('exit', r));
    await killGroup(child.pid);
    if (exited) await Promise.race([exited, sleep(1000)]);
    s.stopping = false;
  } else if (s.status === 'running' || s.status === 'starting') {
    update(s, { status: 'idle' });
  }
  return snapshot(s);
}

export async function restartPreview(project) {
  await stopPreview(project.id);
  return startPreview(project);
}

/** Project deleted: stop its preview and forget the session. */
export async function disposePreview(id) {
  await stopPreview(id);
  const s = sessions.get(id);
  if (s) clearTimeout(s.timer);
  sessions.delete(id);
}

/** Server shutdown: stop every preview process group (SIGKILL after a short grace period). */
export async function killAllPreviews() {
  closing = true;
  for (const s of sessions.values()) s.gen++;
  await Promise.all([...groups].map(killGroup));
}

// Last resort if the server exits without a graceful shutdown.
process.on('exit', () => { for (const pgid of groups) signalGroup(pgid, 'SIGKILL'); });
