import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { config, ROOT } from './config.js';
import { pool, migrate, one } from './db/pool.js';
import { seed, getSettings, sanitizeMonitor } from './db/seed.js';
import { addClient, emit, clientCount } from './events.js';
import { attachTerminal, killAllTerminals, terminalCount } from './services/terminal.js';
import { killAllPreviews } from './services/runner.js';
import { notify } from './services/notify.js';
import { createSampler, measureOnce } from './services/metrics.js';
import { busyState, recoverInterrupted } from './orchestrator/engine.js';
import apiRoutes from './routes/api.js';
import filesRoutes from './routes/files.js';
import previewRoutes, { previewHook } from './routes/preview.js';

const startedAt = new Date();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = null;
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}

// State reported by scripts/supervisor.js over IPC.
let supervisor = { attached: config.supervised, pendingRestart: false, building: false, lastRestartAt: null, lastBuildAt: null, lastError: null, clientVersion: null };

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' }, bodyLimit: 25 * 1024 * 1024 });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 50 } });
// /preview/<id>/* (and root-absolute requests from a preview page) are served before routing and body parsing.
app.addHook('onRequest', previewHook);

async function systemStatus() {
  let db = false;
  try { await one('SELECT 1 AS ok'); db = true; } catch {}
  const busy = busyState();
  const status = !db ? 'down' : supervisor.lastError || supervisor.pendingRestart ? 'degraded' : busy.busy ? 'busy' : 'online';
  return {
    status, db, busy, supervisor,
    version: pkg.version, commit, startedAt, uptimeSec: Math.round(process.uptime()),
    node: process.version, host: os.hostname(), pid: process.pid,
    load: os.loadavg()[0], memory: { rss: process.memoryUsage().rss, free: os.freemem(), total: os.totalmem() },
    clients: clientCount(), terminals: terminalCount(),
  };
}

// ---- host metrics (status bar) ---------------------------------------------
// Sampled only on the real server (not the candidate), while the monitor setting is on and a browser is connected.
const sampler = createSampler();
let monitor = sanitizeMonitor();
let metrics = null; // latest snapshot
let metricsTimer = null;
let metricsBusy = false;
let metricsHalted = false; // set on shutdown

const metricsWanted = () => !config.candidate && !metricsHalted && monitor.enabled && clientCount() > 0;

function armMetrics(sec) {
  clearTimeout(metricsTimer);
  metricsTimer = setTimeout(() => metricsTick().catch(() => {}), sec * 1000);
  metricsTimer.unref();
}

async function metricsTick() {
  metricsTimer = null;
  metricsBusy = true;
  const snap = await sampler.sample(monitor.intervalSec).catch(() => null);
  metricsBusy = false;
  if (!metricsWanted()) return syncMetrics();
  if (snap) { metrics = snap; emit('system:metrics', snap); }
  armMetrics(snap ? monitor.intervalSec : 1); // the first reading after priming comes 1 s later
}

// Start or stop the sampler to match the current state; `rearm` applies a new interval right away.
function syncMetrics(rearm = false) {
  if (!metricsWanted()) {
    clearTimeout(metricsTimer);
    metricsTimer = null;
    metrics = null;
    sampler.reset();
    return;
  }
  if (metricsBusy) return; // the running tick re-arms with the current interval
  if (!metricsTimer) metricsTick().catch(() => {});
  else if (rearm) armMetrics(monitor.intervalSec);
}

app.get('/api/health', async () => ({ ok: true, candidate: config.candidate }));
app.get('/api/system/status', systemStatus);
app.get('/api/system/metrics', async () => {
  if (!monitor.enabled) return { enabled: false };
  return metrics || measureOnce(monitor.intervalSec);
});
app.post('/api/system/restart', async (req, reply) => {
  if (!config.supervised) return reply.code(400).send({ error: 'Not running under the supervisor (start with npm start).' });
  process.send({ type: 'restart-request', force: !!req.body?.force });
  return { ok: true };
});

app.register(async (scope) => {
  scope.get('/api/events', { websocket: true }, (socket) => {
    addClient(socket);
    socket.on('close', () => syncMetrics());
    systemStatus().then((s) => socket.send(JSON.stringify({ type: 'system:status', payload: s, ts: Date.now() })));
    if (metrics) socket.send(JSON.stringify({ type: 'system:metrics', payload: metrics, ts: Date.now() }));
    syncMetrics();
  });
  scope.get('/api/terminal', { websocket: true }, (socket, req) => {
    attachTerminal(socket, { cwd: req.query.cwd, cols: req.query.cols, rows: req.query.rows });
  });
});

await app.register(apiRoutes, {
  onSettingsChange: (key, value) => {
    if (key !== 'monitor') return;
    monitor = sanitizeMonitor(value);
    syncMetrics(true);
  },
});
await app.register(filesRoutes);
await app.register(previewRoutes);

await app.register(fastifyStatic, { root: config.uploadsDir, prefix: '/uploads/', decorateReply: false });
if (fs.existsSync(config.clientDist)) {
  // Wildcard serving: hashed bundles from a hot client rebuild are picked up without a restart.
  await app.register(fastifyStatic, { root: config.clientDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) return reply.code(404).send({ error: 'Not found' });
    const index = path.join(config.clientDist, 'index.html');
    return fs.existsSync(index) ? reply.type('text/html').header('cache-control', 'no-cache').send(fs.readFileSync(index)) : reply.code(503).send('Client not built yet');
  });
} else {
  app.get('/', async (req, reply) => reply.type('text/html').send('<p>AgentForge API is running. Build the client with <code>npm run build</code>, or use <code>npm run dev</code>.</p>'));
}

// ---- boot ----------------------------------------------------------------
await migrate();
await seed();
monitor = sanitizeMonitor((await getSettings()).monitor);
if (!config.candidate) await recoverInterrupted();

await app.listen({ port: config.port, host: config.host });
console.log(`[agentforge] ${config.candidate ? 'candidate' : 'server'} listening on http://${config.host}:${config.port}`);

const pushStatus = async () => emit('system:status', await systemStatus());
if (!config.candidate) {
  setInterval(() => pushStatus().catch(() => {}), 15000).unref();
  if (config.supervised) process.send({ type: 'ready', port: config.port });
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'supervisor') {
    const prev = supervisor;
    supervisor = { ...supervisor, ...msg.state, attached: true };
    await pushStatus().catch(() => {});
    if (msg.state.lastError && msg.state.lastError !== prev.lastError) {
      await notify({ source_type: 'system', source_name: 'Supervisor', level: 'error', title: 'Safe restart blocked', body: msg.state.lastError }).catch(() => {});
    }
  } else if (msg.type === 'busy?') {
    process.send({ type: 'busy', id: msg.id, ...busyState() });
  } else if (msg.type === 'client-updated') {
    emit('system:client-updated', { version: msg.version });
  } else if (msg.type === 'restarted') {
    await notify({ source_type: 'system', source_name: 'Supervisor', level: 'success', title: 'Service restarted safely', body: msg.reason }).catch(() => {});
  } else if (msg.type === 'shutdown') {
    await shutdown('supervisor');
  }
});

let closing = false;
async function shutdown(reason) {
  if (closing) return;
  closing = true;
  console.log(`[agentforge] shutting down (${reason})`);
  emit('system:restarting', { reason });
  metricsHalted = true;
  syncMetrics();
  killAllTerminals();
  await killAllPreviews();
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
