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
import { seed } from './db/seed.js';
import { addClient, emit, clientCount } from './events.js';
import { attachTerminal, killAllTerminals, terminalCount } from './services/terminal.js';
import { notify } from './services/notify.js';
import { busyState, recoverInterrupted } from './orchestrator/engine.js';
import apiRoutes from './routes/api.js';
import filesRoutes from './routes/files.js';

const startedAt = new Date();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = null;
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}

// State reported by scripts/supervisor.js over IPC.
let supervisor = { attached: config.supervised, pendingRestart: false, building: false, lastRestartAt: null, lastBuildAt: null, lastError: null, clientVersion: null };

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' }, bodyLimit: 25 * 1024 * 1024 });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 50 } });

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

app.get('/api/health', async () => ({ ok: true, candidate: config.candidate }));
app.get('/api/system/status', systemStatus);
app.post('/api/system/restart', async (req, reply) => {
  if (!config.supervised) return reply.code(400).send({ error: 'Not running under the supervisor (start with npm start).' });
  process.send({ type: 'restart-request', force: !!req.body?.force });
  return { ok: true };
});

app.register(async (scope) => {
  scope.get('/api/events', { websocket: true }, (socket) => {
    addClient(socket);
    systemStatus().then((s) => socket.send(JSON.stringify({ type: 'system:status', payload: s, ts: Date.now() })));
  });
  scope.get('/api/terminal', { websocket: true }, (socket, req) => {
    attachTerminal(socket, { cwd: req.query.cwd, cols: req.query.cols, rows: req.query.rows });
  });
});

await app.register(apiRoutes);
await app.register(filesRoutes);

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
  killAllTerminals();
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
