// HTTPS mode (Settings → Network; server/config.js networkMode, server/routes/network.js). Off: plain HTTP straight on all
// interfaces, forwarded headers ignored. On: plain port on loopback behind the TLS proxy, forwarded headers trusted from
// it. HOST / TRUST_PROXY win. Each mode boots the real auth, settings and network routes the way server/index.js composes
// them, against session temp tables (search_path=pg_temp), never the live tables. "Another computer" is this host's own
// non-loopback address: the peer is then not 127.0.0.1, as for a remote client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import WebSocket from 'ws';

process.env.PGOPTIONS = '-c search_path=pg_temp';
const { pool, one } = await import('../server/db/pool.js');
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { default: authRoutes, authHooks } = await import('../server/routes/auth.js');
const { default: apiRoutes } = await import('../server/routes/api.js');
const { default: networkRoutes } = await import('../server/routes/network.js');
const { networkMode } = await import('../server/config.js');
const { getSettings } = await import('../server/db/seed.js');
const { addClient } = await import('../server/events.js');

const device = () => ({ secret: crypto.randomBytes(32).toString('base64url'), info: { label: 'Chrome on Linux', os: 'Linux', browser: 'Chrome' } });
const OWNER = device();
const BOB = device();
// This host's address as another computer on the network reaches it (none: those checks are skipped).
const LAN = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;

const servers = [];
let restarts = 0;
/** The app as server/index.js builds it for this HTTPS mode and environment. */
async function boot(https, env = {}) {
  const net = networkMode(https, env);
  const app = Fastify({ trustProxy: net.trustProxy });
  await app.register(websocket);
  authHooks(app);
  app.register(async (scope) => scope.get('/api/events', { websocket: true }, (ws, req) => addClient(ws, req.user)));
  await app.register(authRoutes, { signupLimit: { max: 1000, windowMs: 60_000 } });
  await app.register(networkRoutes, { net, supervised: true, restart: () => { restarts++; }, env });
  await app.register(apiRoutes);
  await app.listen({ port: 0, host: net.host });
  servers.push(app);
  const port = app.server.address().port;
  return { net, port, local: `http://127.0.0.1:${port}`, lan: LAN && `http://${LAN}:${port}` };
}

async function call(at, method, path, { body, cookie, headers = {} } = {}) {
  const res = await fetch(at + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') || '' };
}
const cookieOf = (r) => r.setCookie.split(';')[0];
const signIn = (at, dev, headers) => call(at, 'POST', '/api/auth/device', { body: { device: dev }, headers });

function socket(at, cookie, { origin, headers = {} } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(at.replace('http', 'ws') + '/api/events', { headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(origin ? { origin } : {}) });
    ws.on('open', () => resolve({ ws, ok: true }));
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }));
    ws.on('error', (e) => resolve({ error: e.code }));
  });
}

before(async () => {
  await pool.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const temp = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relname IN ('users', 'sessions', 'settings') AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(temp.n, 3, 'users, sessions and settings must be session temp tables');
});

after(async () => {
  for (const s of servers) await s.close();
  client.release();
  await pool.end();
});

test('networkMode: off by default (all interfaces, no proxy trusted), on = loopback behind a trusted local proxy; HOST and TRUST_PROXY win', () => {
  const pick = (m) => ({ https: m.https, host: m.host, trustProxy: m.trustProxy, env: m.env });
  assert.deepEqual(pick(networkMode(false, {})), { https: false, host: '0.0.0.0', trustProxy: false, env: { HOST: false, TRUST_PROXY: false } });
  assert.deepEqual(pick(networkMode(undefined, {})), pick(networkMode(false, {})), 'no saved setting = off = the behaviour before the setting existed');
  assert.deepEqual(pick(networkMode(true, {})), { https: true, host: '127.0.0.1', trustProxy: 'loopback', env: { HOST: false, TRUST_PROXY: false } });
  assert.deepEqual(pick(networkMode(true, { HOST: '0.0.0.0', TRUST_PROXY: '10.0.0.0/8' })), { https: true, host: '0.0.0.0', trustProxy: '10.0.0.0/8', env: { HOST: true, TRUST_PROXY: true } });
  assert.deepEqual(pick(networkMode(false, { HOST: '127.0.0.1', TRUST_PROXY: 'true' })), { https: false, host: '127.0.0.1', trustProxy: 'loopback', env: { HOST: true, TRUST_PROXY: true } });
  assert.equal(networkMode(true, { TRUST_PROXY: '0' }).trustProxy, false, 'an explicit TRUST_PROXY=0 wins too');
  assert.equal(networkMode(false, { HOST: ' ', TRUST_PROXY: '' }).env.HOST, false, 'blank = not set');
  assert.equal(networkMode(false, { AF_CANDIDATE: '1' }).host, '127.0.0.1', 'the health-check candidate stays local');
});

test('HTTPS off: another computer opens http://<host>:<port> directly, signs in (cookie not Secure) and uses the event socket', async () => {
  const off = await boot(false);
  assert.equal(off.net.host, '0.0.0.0');
  const at = off.lan || off.local;
  const first = await call(at, 'POST', '/api/auth/signup', { body: { username: 'owner', device: OWNER } });
  assert.equal(first.status, 200);
  assert.equal(first.data.user.role, 'admin');
  assert.doesNotMatch(first.setCookie, /Secure/);
  // A direct client can not claim https or another origin: forwarded headers are ignored.
  const spoof = await signIn(at, OWNER, { 'x-forwarded-proto': 'https' });
  assert.doesNotMatch(spoof.setCookie, /Secure/);
  const admin = cookieOf(first);
  assert.equal((await call(at, 'GET', '/api/auth/me', { cookie: admin })).status, 200);
  const ws = await socket(at, admin, { origin: at });
  assert.equal(ws.ok, true, 'the direct http origin is accepted');
  ws.ws.close();
  assert.equal((await socket(at, admin, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await socket(at, admin, { origin: 'https://af.example', headers: { 'x-forwarded-host': 'af.example' } })).status, 403);
  // Login stays enforced.
  assert.equal((await call(at, 'GET', '/api/projects')).status, 401);
  assert.equal((await socket(at, undefined, { origin: at })).status, 401);
});

test('the setting is admin only: a user with manageSettings can neither read nor change it', async () => {
  const { local } = await boot(false);
  const admin = cookieOf(await signIn(local, OWNER));
  await call(local, 'POST', '/api/auth/signup', { body: { username: 'bob', device: BOB } });
  const bobId = (await one(`SELECT id FROM users WHERE username = 'bob'`)).id;
  assert.equal((await call(local, 'POST', `/api/users/${bobId}/approve`, { cookie: admin })).status, 200);
  assert.equal((await call(local, 'PUT', `/api/users/${bobId}/permissions`, { cookie: admin, body: { manageSettings: true } })).status, 200);
  const bob = cookieOf(await signIn(local, BOB));
  assert.equal((await call(local, 'GET', '/api/settings', { cookie: bob })).status, 200, 'other settings are his');
  assert.equal((await call(local, 'GET', '/api/system/network', { cookie: bob })).status, 403);
  assert.equal((await call(local, 'PUT', '/api/system/network', { cookie: bob, body: { https: false } })).status, 403);
  assert.equal((await call(local, 'PUT', '/api/settings/network', { cookie: admin, body: { https: true } })).status, 400, 'not through the generic settings route');
  assert.equal((await call(local, 'GET', '/api/system/network')).status, 401);
});

test('switching on: refused from a direct remote connection (lock-out), saved from this host with a safe restart, kept across a restart', async () => {
  const off = await boot(false);
  const admin = cookieOf(await signIn(off.local, OWNER));
  const now = await call(off.local, 'GET', '/api/system/network', { cookie: admin });
  assert.deepEqual(now.data, { https: false, env: { HOST: false, TRUST_PROXY: false }, supervised: true, running: { https: false, host: '0.0.0.0', port: off.port, trustProxy: false }, restartNeeded: false });

  if (off.lan) {
    const remote = await call(off.lan, 'PUT', '/api/system/network', { cookie: admin, body: { https: true } });
    assert.deepEqual([remote.status, remote.data.code], [409, 'not_via_proxy']);
    assert.equal((await getSettings()).network, undefined, 'nothing saved');
  }
  restarts = 0;
  const on = await call(off.local, 'PUT', '/api/system/network', { cookie: admin, body: { https: true } });
  assert.equal(on.status, 200);
  assert.deepEqual([on.data.https, on.data.restartNeeded, on.data.restarting, restarts], [true, true, true, 1]);
  assert.deepEqual((await getSettings()).network, { https: true });
  // Back to off before the restart happened: nothing to restart for.
  const back = await call(off.local, 'PUT', '/api/system/network', { cookie: admin, body: { https: false } });
  assert.deepEqual([back.data.restartNeeded, back.data.restarting, restarts], [false, false, 1]);
  await call(off.local, 'PUT', '/api/system/network', { cookie: admin, body: { https: true } });

  // "Restart": a new process resolves its mode from the saved setting, as server/index.js does on boot.
  const saved = (await getSettings()).network?.https === true;
  assert.equal(saved, true);
  const after = await boot(saved);
  assert.deepEqual([after.net.host, after.net.trustProxy], ['127.0.0.1', 'loopback']);
  const state = await call(after.local, 'GET', '/api/system/network', { cookie: admin });
  assert.deepEqual([state.data.https, state.data.running.https, state.data.restartNeeded], [true, true, false]);
});

test('HTTPS on: the plain port is loopback only; through the proxy cookies are Secure and the forwarded https origin opens the socket', async () => {
  const on = await boot(true);
  if (on.lan) assert.equal((await socket(on.lan, '', {})).error, 'ECONNREFUSED', 'other computers can not reach the plain port');
  const XF = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'af.example', 'x-forwarded-for': '203.0.113.9' };
  const r = await signIn(on.local, OWNER, XF);
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /; Secure$/);
  const ws = await socket(on.local, cookieOf(r), { origin: 'https://af.example', headers: XF });
  assert.equal(ws.ok, true);
  ws.ws.close();
  assert.equal((await socket(on.local, cookieOf(r), { origin: 'https://evil.example', headers: XF })).status, 403);
  assert.equal((await call(on.local, 'GET', '/api/projects', { headers: XF })).status, 401, 'login stays enforced');
});

test('HOST / TRUST_PROXY in the environment win, and the state says so', async () => {
  const env = { HOST: '127.0.0.1', TRUST_PROXY: '1' };
  const s = await boot(false, env);
  assert.deepEqual([s.net.host, s.net.trustProxy], ['127.0.0.1', 'loopback']);
  const admin = cookieOf(await signIn(s.local, OWNER));
  const st = await call(s.local, 'GET', '/api/system/network', { cookie: admin });
  assert.deepEqual(st.data.env, { HOST: true, TRUST_PROXY: true });
  restarts = 0;
  for (const https of [false, true]) {
    const r = await call(s.local, 'PUT', '/api/system/network', { cookie: admin, body: { https } });
    assert.deepEqual([r.status, r.data.restartNeeded, r.data.restarting], [200, false, false], 'the setting changes nothing while both are set');
  }
  assert.equal(restarts, 0);
});
