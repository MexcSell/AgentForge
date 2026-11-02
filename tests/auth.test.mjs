// Accounts and authorization (routes/auth.js, services/auth.js, services/access.js, events.js): username-only sign-up
// bound to a device secret → pending (no session) → admin approval → password-less device sign-in, foreign devices
// refused, rejected/disabled accounts, per-project permissions over REST and WebSocket (the protected AgentForge project
// stays hidden). Legacy password accounts: tests/auth-migration.test.mjs. Runs the real routes in-process against session temp tables
// (search_path=pg_temp), never the live tables.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import WebSocket from 'ws';

process.env.PGOPTIONS = '-c search_path=pg_temp';
const { pool, one } = await import('../server/db/pool.js');
// One session holds the temp tables: every query runs on it.
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { default: authRoutes, authHooks } = await import('../server/routes/auth.js');
const { default: apiRoutes } = await import('../server/routes/api.js');
const { default: filesRoutes } = await import('../server/routes/files.js');
const { addClient, emit } = await import('../server/events.js');
const auth = await import('../server/services/auth.js');

// A browser as client/src/lib/device.js reports it: its random secret and what it says about the computer.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const browser = (label, info = {}) => ({ secret: crypto.randomBytes(32).toString('base64url'),
  info: { label, os: 'Linux', browser: 'Chrome', platform: 'Linux x86_64', userAgent: UA, screen: '1920x1080', language: 'en-US', timezone: 'Europe/Berlin', ...info } });
const OWNER_DEV = browser('Chrome on Linux');
const BOB_DEV = browser('Chrome on Linux', { screen: '1366x768' });
const CAROL_DEV = browser('Edge on Windows', { os: 'Windows', browser: 'Edge', platform: 'Win32', timezone: 'Asia/Seoul', language: 'ko-KR' });
const LAPTOP_DEV = browser('Safari on macOS', { os: 'macOS', browser: 'Safari', platform: 'MacIntel' });

// The legacy fingerprint (password logins of accounts created before device secrets), and variations of it.
const PC = { platform: 'Linux x86_64', cores: 8, memory: 8, gpu: 'ANGLE (NVIDIA, GeForce GTX 1080)', canvas: 'c0ffee12', touch: 0, screen: '1920x1080', colorDepth: 24, timezone: 'Europe/Berlin', language: 'en-US' };
const pc = (over = {}) => ({ ...PC, ...over });
const LAPTOP = pc({ platform: 'MacIntel', cores: 10, memory: 16, gpu: 'Apple M1 Pro', canvas: 'aa11bb22', screen: '1512x982', colorDepth: 30 });

let app, base, core, alpha, beta;
let proxied, proxiedBase; // the same routes with TRUST_PROXY=1 (config.trustProxy 'loopback'), as behind deploy/Caddyfile

async function call(method, path, { body, cookie, headers = {}, at = base } = {}) {
  const res = await fetch(at + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}
const cookieOf = (r) => r.setCookie.split(';')[0];
const signup = (username, device, extra = {}) => call('POST', '/api/auth/signup', { body: { username, device, ...extra } });
const deviceLogin = (device, opts = {}) => call('POST', '/api/auth/device', { body: { device }, ...opts });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const userId = async (name) => (await one(`SELECT id FROM users WHERE username = $1`, [name])).id;

/** Opens /api/events (or path) with the cookie and an optional browser Origin; resolves { ws, events } once open, or { status } when the upgrade is refused. */
function socket(cookie, { origin, path = '/api/events', headers = {}, at = base } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(at.replace('http', 'ws') + path, { headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(origin ? { origin } : {}) });
    const events = [];
    ws.on('message', (m) => events.push(JSON.parse(String(m))));
    ws.on('open', () => resolve({ ws, events }));
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => {});
  });
}
const tick = () => new Promise((r) => setTimeout(r, 150));

let admin, bob; // cookies

before(async () => {
  await pool.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const live = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relname IN ('users', 'sessions', 'projects') AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(live.n, 3, 'users, sessions and projects must be session temp tables');
  core = (await one(`INSERT INTO projects(name, path, protected) VALUES ('AgentForge', '/tmp/af-core', true) RETURNING id`)).id;
  alpha = (await one(`INSERT INTO projects(name, path) VALUES ('Alpha', '/tmp/af-alpha') RETURNING id`)).id;
  beta = (await one(`INSERT INTO projects(name, path) VALUES ('Beta', '/tmp/af-beta') RETURNING id`)).id;
  await auth.loadProtected();

  app = Fastify();
  await app.register(websocket);
  authHooks(app);
  app.get('/api/health', async () => ({ ok: true }));
  app.post('/api/system/restart', async () => ({ ok: true })); // as in index.js: not in POLICY, so admin-only
  app.register(async (scope) => {
    scope.get('/api/events', { websocket: true }, (ws, req) => addClient(ws, req.user));
    scope.get('/api/terminal', { websocket: true }, (ws) => ws.close());
  });
  await app.register(authRoutes, { signupLimit: { max: 1000, windowMs: 60_000 } });
  await app.register(apiRoutes);
  await app.register(filesRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;

  proxied = Fastify({ trustProxy: 'loopback' });
  await proxied.register(websocket);
  authHooks(proxied);
  proxied.get('/api/whoami', async (req) => ({ ip: req.ip, protocol: req.protocol, host: req.host }));
  proxied.register(async (scope) => {
    scope.get('/api/events', { websocket: true }, (ws, req) => addClient(ws, req.user));
    scope.get('/api/terminal', { websocket: true }, (ws) => ws.close());
  });
  await proxied.register(authRoutes, { signupLimit: { max: 2, windowMs: 60_000 } });
  await proxied.listen({ port: 0, host: '127.0.0.1' });
  proxiedBase = `http://127.0.0.1:${proxied.server.address().port}`;
});

after(async () => {
  await proxied.close();
  await app.close();
  client.release();
  await pool.end();
});

test('signed out: the API and the event socket answer 401; health and the sign-in endpoints stay open', async () => {
  for (const p of ['/api/projects', '/api/agents', '/api/settings', '/api/dashboard', `/api/projects/${alpha}/messages`, '/api/users', '/api/fs/list', '/uploads/x.png']) {
    assert.equal((await call('GET', p)).status, 401, p);
  }
  assert.equal((await call('POST', `/api/projects/${alpha}/command`, { body: { content: 'hi' } })).status, 401);
  assert.equal((await socket()).status, 401);
  assert.equal((await socket('af_session=forged')).status, 401);
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.deepEqual((await call('GET', '/api/auth/state')).data, { setup: true });
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  const none = await call('POST', '/api/auth/device', { body: {} });
  assert.deepEqual([none.status, none.data.code], [400, 'device_required']);
  assert.equal((await deviceLogin(OWNER_DEV)).data.code, 'unknown_device');
});

test('the first account becomes the active administrator: username only, bound to its device, with an httpOnly session cookie', async () => {
  const r = await signup('owner', OWNER_DEV);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
  assert.equal(r.data.user.status, 'active');
  assert.match(r.setCookie, /^af_session=[\w-]{40,};/);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  admin = cookieOf(r);
  // No password; only a hash of the device secret is stored, never the secret.
  const row = await one(`SELECT * FROM users WHERE username = 'owner'`);
  assert.equal(row.password_hash, null);
  assert.match(row.device_secret_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.device_secret_hash, sha(OWNER_DEV.secret));
  assert.ok(!JSON.stringify(row).includes(OWNER_DEV.secret));
  // Signing in again from the same browser needs nothing but its device.
  const again = await deviceLogin(OWNER_DEV);
  assert.equal(again.status, 200);
  assert.equal(again.data.user.username, 'owner');
  // Only the token's SHA-256 is stored.
  assert.equal((await one(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1`, [admin.split('=')[1]])).n, 0);
  assert.deepEqual((await call('GET', '/api/auth/state')).data, { setup: false });
  assert.equal((await call('GET', '/api/projects', { cookie: admin })).data.length, 3);
  // Legacy password hashing (accounts from before, the break-glass administrator).
  const hash = await auth.hashPassword('correct horse');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]{20,}\$[A-Za-z0-9+/=]{80,}$/);
  assert.notEqual(await auth.hashPassword('correct horse'), hash, 'random salt');
  assert.equal(await auth.verifyPassword('correct horse', hash), true);
  assert.equal(await auth.verifyPassword('wrong horse', hash), false);
  assert.equal(await auth.verifyPassword('', null), false, 'an account without a password never matches');
});

test('WebSockets accept the app\'s own origin (any host name or IP it is opened by) and refuse other origins', async () => {
  const port = new URL(base).port;
  const own = await socket(admin, { origin: base });
  assert.equal(own.status, undefined, 'same-origin socket opens');
  own.ws.close();
  // X-Forwarded-Host is ignored without TRUST_PROXY: a direct client can not name the origin it wants accepted.
  const spoofed = await socket(admin, { origin: 'http://192.0.2.10:4800', headers: { 'x-forwarded-host': '192.0.2.10:4800' } });
  assert.equal(spoofed.status, 403, 'untrusted X-Forwarded-Host');
  for (const origin of [`http://127.0.0.1:${Number(port) + 1}`, 'http://evil.example', 'null']) {
    assert.equal((await socket(admin, { origin })).status, 403, origin);
    assert.equal((await socket(admin, { origin, path: '/api/terminal' })).status, 403, `terminal ${origin}`);
  }
  assert.equal((await socket(undefined, { origin: 'http://evil.example' })).status, 403, 'refused before the session check');
});

test('a new sign-up is pending and bound to its device: no session over HTTP or WebSocket until approved', async () => {
  const r = await signup('bob', BOB_DEV, { team: 'Platform' });
  assert.equal(r.status, 200);
  assert.equal(r.data.pending, true);
  assert.equal(r.data.user.status, 'pending');
  assert.equal(r.data.user.role, 'user');
  assert.equal(r.setCookie, null, 'no session cookie while pending');
  // Its browser signing in is told why, with no session either.
  const wait = await deviceLogin(BOB_DEV);
  assert.equal(wait.status, 403);
  assert.equal(wait.data.code, 'pending');
  assert.equal(wait.data.user.username, 'bob');
  assert.equal(wait.setCookie, null);
  // A session made for it anyway (as the old sign-up did) is worth nothing.
  const stale = `af_session=${await auth.createSession(await userId('bob'))}`;
  assert.equal((await call('GET', '/api/auth/me', { cookie: stale })).status, 401);
  assert.equal((await call('GET', '/api/projects', { cookie: stale })).status, 401);
  assert.equal((await socket(stale)).status, 401);
  // The administrator is told, and sees it first in the list, with the computer it registered from.
  const list = await call('GET', '/api/users', { cookie: admin });
  const u = list.data.users[0];
  assert.equal(u.username, 'bob');
  assert.equal(u.team, 'Platform');
  assert.equal(u.device_bound, true);
  assert.deepEqual(u.device_info, BOB_DEV.info);
  for (const k of ['password_hash', 'device', 'device_secret_hash']) assert.ok(!(k in u), k);
  assert.ok(!JSON.stringify(list.data).includes(BOB_DEV.secret));
  assert.ok((await one(`SELECT 1 FROM notifications WHERE title LIKE '%bob%' AND body LIKE '%Chrome on Linux%'`)));
});

test('TRUST_PROXY: forwarded https gives Secure cookies, the forwarded origin and the real client IP; never without it', async () => {
  const XF = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'af.example', 'x-forwarded-for': '203.0.113.9' };
  // Behind the trusted proxy (loopback here).
  const r = await deviceLogin(OWNER_DEV, { at: proxiedBase, headers: XF });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /; Secure$/);
  const out = await call('POST', '/api/auth/logout', { at: proxiedBase, headers: XF, cookie: cookieOf(r) });
  assert.match(out.setCookie, /Max-Age=0; Secure$/);
  assert.doesNotMatch((await deviceLogin(OWNER_DEV, { at: proxiedBase })).setCookie, /Secure/, 'plain http via the proxy');
  const who = await call('GET', '/api/whoami', { at: proxiedBase, cookie: admin, headers: { ...XF, 'x-forwarded-for': '198.51.100.1, 203.0.113.9' } });
  assert.deepEqual(who.data, { ip: '203.0.113.9', protocol: 'https', host: 'af.example' }, 'the address the proxy saw, not what the client claims');
  // Direct clients (the default, TRUST_PROXY unset) can not claim https: identical cookies to plain http.
  const direct = await deviceLogin(OWNER_DEV, { headers: XF });
  assert.equal(direct.status, 200);
  assert.doesNotMatch(direct.setCookie, /Secure/);
  assert.doesNotMatch((await call('POST', '/api/auth/logout', { headers: XF, cookie: cookieOf(direct) })).setCookie, /Secure/);

  // WebSockets: the public https origin the proxy forwards is accepted, foreign origins are not.
  const pub = await socket(admin, { at: proxiedBase, origin: 'https://af.example', headers: XF });
  assert.equal(pub.status, undefined, 'forwarded public origin opens');
  pub.ws.close();
  const term = await socket(admin, { at: proxiedBase, origin: 'https://af.example', headers: XF, path: '/api/terminal' });
  assert.equal(term.status, undefined, 'terminal through the proxy');
  term.ws.close();
  for (const origin of ['https://evil.example', 'http://af.example.evil.example', 'null']) {
    assert.equal((await socket(admin, { at: proxiedBase, origin, headers: XF })).status, 403, origin);
    assert.equal((await socket(admin, { at: proxiedBase, origin, headers: XF, path: '/api/terminal' })).status, 403, `terminal ${origin}`);
  }
  // A foreign page whose Host the proxy forwards for its own domain is still refused.
  assert.equal((await socket(admin, { at: proxiedBase, origin: 'https://evil.example', headers: { ...XF, host: 'evil.example' } })).status, 403, 'XFH wins over Host');
  // The same forwarded origin straight to the untrusted server is refused.
  assert.equal((await socket(admin, { origin: 'https://af.example', headers: XF })).status, 403, 'untrusted forwarded origin');
});

test('sign-up is refused for a registered device, a taken or invalid username, a missing secret and an oversized payload', async () => {
  const again = await signup('bob2', BOB_DEV);
  assert.deepEqual([again.status, again.data.code], [409, 'device_taken']);
  assert.match(again.data.error, /already registered as bob/);
  const taken = await signup('BOB', CAROL_DEV);
  assert.deepEqual([taken.status, taken.data.code], [409, 'username_taken']);
  assert.match(taken.data.error, /username/);
  // bob's key lives in another browser (or another address: localStorage is per origin): say how to get back in.
  assert.match(taken.data.error, /address and in the browser profile you registered with/);
  for (const name of ['x', '', '-bob', 'a b c', 'x'.repeat(33), '../etc']) {
    const r = await signup(name, CAROL_DEV);
    assert.deepEqual([r.status, r.data.code], [400, 'invalid_username'], name);
  }
  // The secret is what binds the device: describing a computer is not enough.
  for (const device of [undefined, { info: CAROL_DEV.info }, { secret: 'short', info: CAROL_DEV.info }, { secret: 'x'.repeat(40) + '!!!', info: {} }]) {
    const r = await signup('carol', device);
    assert.deepEqual([r.status, r.data.code], [400, 'device_required'], JSON.stringify(device));
    assert.match(r.data.error, /device key/);
  }
  assert.equal((await signup('carol', { ...CAROL_DEV, info: 'Windows' })).status, 400);
  const big = await signup('carol', { ...CAROL_DEV, info: { ...CAROL_DEV.info, label: 'x'.repeat(5000) } });
  assert.deepEqual([big.status, big.data.code], [413, 'device_info_too_large']);
  assert.match(big.data.error, /too large/);
  const huge = await signup('carol', { ...CAROL_DEV, info: { padding: 'x'.repeat(40_000) } });
  assert.equal(huge.status, 413, 'over the route body limit');
  assert.equal(await one(`SELECT 1 FROM users WHERE lower(username) IN ('bob2', 'carol')`), null);
});

test('registrations are rate-limited per client address', async () => {
  const XF = (ip) => ({ 'x-forwarded-for': ip });
  const at = proxiedBase; // signupLimit max 2, keyed by the address the trusted proxy saw
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/api/auth/signup', { at, headers: XF('203.0.113.50'), body: { username: '!' } })).status, 400);
  const over = await call('POST', '/api/auth/signup', { at, headers: XF('203.0.113.50'), body: { username: 'dave', device: browser('x') } });
  assert.deepEqual([over.status, over.data.code], [429, 'rate_limited']);
  assert.equal(await one(`SELECT 1 FROM users WHERE username = 'dave'`), null);
  assert.equal((await call('POST', '/api/auth/signup', { at, headers: XF('203.0.113.51'), body: { username: '!' } })).status, 400, 'another address is not limited');
});

test('the stored device: a hash of the secret plus the known descriptive fields, never an IP address', async () => {
  const r = await signup('carol', { ...CAROL_DEV, info: { ...CAROL_DEV.info, ip: '203.0.113.7', ipv6: '2001:db8::1', localAddress: '192.168.1.20', cores: { nested: true } } });
  assert.equal(r.status, 200);
  const row = await one(`SELECT device, device_secret_hash, device_info FROM users WHERE username = 'carol'`);
  assert.equal(row.device, null, 'no legacy fingerprint for new accounts');
  assert.deepEqual(row.device_info, CAROL_DEV.info);
  assert.deepEqual(Object.keys(row.device_info).sort(), [...auth.DEVICE_INFO].sort());
  const text = JSON.stringify(row);
  for (const raw of ['203.0.113', '2001:db8', '192.168', CAROL_DEV.secret]) assert.ok(!text.includes(raw), raw);
});

test('fingerprint matching tolerates small changes, not another computer', () => {
  const a = auth.hashDevice(PC);
  assert.equal(auth.sameDevice(a, auth.hashDevice(pc({ screen: '2560x1440' }))), true);
  assert.equal(auth.sameDevice(a, auth.hashDevice(pc({ screen: '2560x1440', canvas: 'new' }))), true);
  assert.equal(auth.sameDevice(a, auth.hashDevice(pc({ screen: '1', canvas: '2', language: '3' }))), false);
  for (const k of auth.DEVICE_HARDWARE) assert.equal(auth.sameDevice(a, auth.hashDevice(pc({ [k]: 'other' }))), false, k);
  assert.equal(auth.sameDevice(a, auth.hashDevice(LAPTOP)), false);
  assert.equal(auth.hashDevice({ screen: '1920x1080', ip: '1.2.3.4' }), null);
});

test('the admin approves; permissions decide the projects (never the AgentForge one) and the capabilities', async () => {
  const bobId = await userId('bob');
  assert.equal((await call('POST', `/api/users/${bobId}/approve`, { cookie: admin })).data.status, 'active');
  const signedIn = await deviceLogin(BOB_DEV);
  assert.equal(signedIn.status, 200);
  bob = cookieOf(signedIn);
  assert.deepEqual((await call('GET', '/api/projects', { cookie: bob })).data, []);
  const set = await call('PUT', `/api/users/${bobId}/permissions`, { cookie: admin, body: { projects: [alpha, core, 'nope'], runMissions: false, bogus: true } });
  assert.deepEqual(set.data.permissions, { projects: [alpha], createProjects: false, runMissions: false, manageAgents: false, manageSettings: false });

  assert.deepEqual((await call('GET', '/api/projects', { cookie: bob })).data.map((p) => p.name), ['Alpha']);
  assert.equal((await call('GET', `/api/projects/${alpha}/messages`, { cookie: bob })).status, 200);
  assert.equal((await call('GET', `/api/projects/${alpha}/topics`, { cookie: bob })).status, 200);
  for (const id of [core, beta]) {
    for (const p of ['messages', 'tasks', 'topics', 'members', 'git']) assert.equal((await call('GET', `/api/projects/${id}/${p}`, { cookie: bob })).status, 404, `${p} of ${id}`);
  }
  // A topic or task of the hidden project, addressed by its own id.
  const topic = (await one(`INSERT INTO topics(project_id, title) VALUES ($1, 'secret') RETURNING id`, [core])).id;
  const task = (await one(`INSERT INTO tasks(project_id, key, title, role) VALUES ($1, 'T1', 'secret', 'backend') RETURNING id`, [core])).id;
  assert.equal((await call('PATCH', `/api/topics/${topic}`, { cookie: bob, body: { title: 'x' } })).status, 404);
  assert.equal((await call('POST', `/api/tasks/${task}/approve`, { cookie: bob })).status, 404);
  // Read-only on Alpha without runMissions; admin areas stay closed.
  assert.equal((await call('POST', `/api/projects/${alpha}/command`, { cookie: bob, body: { content: 'go' } })).status, 403);
  assert.equal((await call('POST', `/api/projects/${alpha}/topics`, { cookie: bob, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/projects', { cookie: bob, body: { name: 'Mine', path: '/tmp/af-mine' } })).status, 403);
  for (const [m, p] of [['GET', '/api/settings'], ['GET', '/api/users'], ['GET', '/api/fs/list'], ['GET', '/api/github'], ['GET', '/api/evolution'], ['POST', '/api/system/restart'], ['POST', '/api/projects/delete'], ['PATCH', `/api/projects/${alpha}`], ['POST', `/api/users/${bobId}/approve`]]) {
    assert.equal((await call(m, p, { cookie: bob, body: m === 'GET' ? undefined : {} })).status, 403, `${m} ${p}`);
  }
  assert.equal((await socket(bob)).status === undefined, true, 'events socket opens');
  const term = await new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/terminal', { headers: { cookie: bob } });
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('open', () => resolve('open'));
    ws.on('error', () => {});
  });
  assert.equal(term, 403, 'no terminal for non-admins');

  // Capabilities: runMissions opens writes on Alpha; createProjects grants the new project to its creator.
  await call('PUT', `/api/users/${bobId}/permissions`, { cookie: admin, body: { projects: [alpha], runMissions: true, createProjects: true } });
  assert.equal((await call('POST', `/api/projects/${alpha}/topics`, { cookie: bob, body: { title: 'Plans' } })).status, 200);
  assert.equal((await call('POST', `/api/projects/${beta}/topics`, { cookie: bob, body: { title: 'Plans' } })).status, 404);
  const dash = await call('GET', '/api/dashboard', { cookie: bob });
  assert.equal(dash.status, 200);
  assert.equal(dash.data.counts.projects, 1);
  assert.equal((await call('GET', '/api/dashboard', { cookie: admin })).data.counts.projects, 3);
});

test('an approved browser signs in with no password; another device or a forged user agent without its secret is refused', async () => {
  const me = await call('GET', '/api/auth/me', { cookie: bob });
  assert.deepEqual([me.status, me.data.user.username, me.data.user.status], [200, 'bob', 'active']);
  // Everything the browser says about itself, copied exactly, with another secret or none.
  for (const device of [{ ...BOB_DEV, secret: browser('x').secret }, { info: BOB_DEV.info }, { secret: sha(BOB_DEV.secret).slice(0, 43), info: BOB_DEV.info }]) {
    const r = await call('POST', '/api/auth/device', { body: { device }, headers: { 'user-agent': UA } });
    assert.ok([400, 401].includes(r.status), `${r.status} ${JSON.stringify(device).slice(0, 60)}`);
    assert.equal(r.setCookie, null);
  }
  assert.equal((await deviceLogin(LAPTOP_DEV)).data.code, 'unknown_device');
  // The secret alone decides: the same browser on another network, with another user agent string, still signs in.
  assert.equal((await deviceLogin({ secret: BOB_DEV.secret })).status, 200);
});

test('notifications of hidden projects are not listed for a non-admin', async () => {
  await pool.query(`INSERT INTO notifications(project_id, title) VALUES ($1, 'core news'), ($2, 'alpha news'), (NULL, 'system news')`, [core, alpha]);
  const titles = (await call('GET', '/api/notifications', { cookie: bob })).data.map((n) => n.title);
  assert.deepEqual(titles, ['alpha news']);
  assert.ok((await call('GET', '/api/notifications', { cookie: admin })).data.some((n) => n.title === 'core news'));
});

test('WebSocket broadcasts reach a non-admin only for granted projects; the admin gets everything', async () => {
  const b = await socket(bob);
  const a = await socket(admin);
  await tick();
  b.events.length = 0;
  a.events.length = 0;
  emit('message:new', { id: 'm1', project_id: core, content: 'core secret' });
  emit('message:new', { id: 'm2', project_id: alpha, content: 'alpha' });
  emit('task:update', { id: 't1', project_id: beta });
  emit('project:update', { id: core, name: 'AgentForge' });
  emit('project:update', { id: alpha, name: 'Alpha' });
  emit('run:end', { id: 'r1', agent_id: 'x', project_id: core });
  emit('topic:moved', { project_id: core });
  emit('agent:update', { id: 'x', name: 'Kernel' });
  emit('settings:update', { key: 'github', value: {} });
  emit('notification:new', { id: 'n1', project_id: null, title: 'system' });
  emit('some:future-event', { project_id: alpha });
  emit('system:status', { status: 'online' });
  await tick();
  assert.deepEqual(b.events.map((e) => `${e.type} ${e.payload.id || e.payload.status || ''}`), ['message:new m2', 'project:update ' + alpha, 'system:status online']);
  assert.equal(a.events.length, 12);
  assert.ok(!JSON.stringify(b.events).includes('core secret'));

  // A permission change reaches the open socket at once: Alpha events stop, and the browser is told to reload.
  await call('PUT', `/api/users/${await userId('bob')}/permissions`, { cookie: admin, body: { projects: [beta] } });
  await tick();
  assert.equal(b.events.at(-1).type, 'auth:update');
  b.events.length = 0;
  emit('message:new', { id: 'm3', project_id: alpha });
  emit('message:new', { id: 'm4', project_id: beta });
  await tick();
  assert.deepEqual(b.events.map((e) => e.payload.id), ['m4']);
  b.ws.close();
  a.ws.close();
});

test('reset device: the user registers again from the new computer and waits for approval; rejected and disabled are refused', async () => {
  const bobId = await userId('bob');
  // A bound name can not be claimed from another computer.
  assert.equal((await signup('bob', LAPTOP_DEV)).data.code, 'username_taken');
  const reset = await call('POST', `/api/users/${bobId}/reset-device`, { cookie: admin });
  assert.equal(reset.data.device_bound, false);
  assert.equal(reset.data.device_info, null);
  assert.equal((await deviceLogin(BOB_DEV)).data.code, 'unknown_device', 'the old computer is refused');
  assert.equal((await call('GET', '/api/projects', { cookie: bob })).status, 200, 'a reset alone does not end sessions');
  assert.equal((await signup('bob', CAROL_DEV)).data.code, 'device_taken', 'carol\'s computer can not take bob over');
  const re = await signup('bob', LAPTOP_DEV);
  assert.deepEqual([re.status, re.data.user.status, re.data.user.id], [200, 'pending', bobId], 'the same account, pending again');
  assert.deepEqual(re.data.user.permissions.projects, [beta], 'permissions are kept');
  assert.equal((await call('GET', '/api/projects', { cookie: bob })).status, 401, 'its sessions ended');
  assert.equal((await deviceLogin(LAPTOP_DEV)).data.code, 'pending');
  await call('POST', `/api/users/${bobId}/approve`, { cookie: admin });
  const back = await deviceLogin(LAPTOP_DEV);
  assert.equal(back.status, 200);
  bob = cookieOf(back);

  const carolId = await userId('carol');
  assert.equal((await call('POST', `/api/users/${carolId}/reject`, { cookie: admin })).data.status, 'rejected');
  const rejected = await deviceLogin(CAROL_DEV);
  assert.deepEqual([rejected.status, rejected.data.code, rejected.setCookie], [403, 'rejected', null]);

  const live = await socket(bob);
  const closed = new Promise((r) => live.ws.on('close', (code) => r(code)));
  assert.equal((await call('POST', `/api/users/${bobId}/disable`, { cookie: admin })).data.status, 'disabled');
  assert.equal(await closed, 4401, 'open sockets of a disabled account are closed');
  assert.equal((await call('GET', '/api/projects', { cookie: bob })).status, 401, 'its sessions end');
  assert.equal((await deviceLogin(LAPTOP_DEV)).data.code, 'disabled');
  assert.equal((await call('POST', `/api/users/${bobId}/enable`, { cookie: admin })).data.status, 'active');
  assert.equal((await deviceLogin(LAPTOP_DEV)).status, 200);
});

test('the waiting count (Users nav badge): GET /api/users/pending and live users:pending events, for administrators only', async () => {
  const count = async (cookie) => (await call('GET', '/api/users/pending', { cookie })).data.count;
  bob = cookieOf(await deviceLogin(LAPTOP_DEV)); // re-enabled above, with a fresh session
  const before = await count(admin);
  assert.equal(before, (await one(`SELECT count(*)::int AS n FROM users WHERE status = 'pending'`)).n);
  assert.equal((await call('GET', '/api/users/pending', { cookie: bob })).status, 403, 'a non-admin never gets the count');
  assert.equal((await call('GET', '/api/users/pending')).status, 401);
  const a = await socket(admin);
  const b = await socket(bob);
  assert.ok(a.events && b.events, 'both sockets opened');
  await tick();
  a.events.length = 0;
  b.events.length = 0;
  const seen = () => a.events.filter((e) => e.type === 'users:pending').map((e) => e.payload.count);

  // New sign-ups raise it; approve, reject and delete lower it.
  assert.equal((await signup('hank', browser('Chrome on Linux'))).data.user.status, 'pending');
  await signup('ivy', browser('Firefox on Linux'));
  await signup('jude', browser('Safari on macOS'));
  await tick();
  assert.deepEqual(seen(), [before + 1, before + 2, before + 3]);
  assert.equal(await count(admin), before + 3);
  await call('POST', `/api/users/${await userId('hank')}/approve`, { cookie: admin });
  await call('POST', `/api/users/${await userId('ivy')}/reject`, { cookie: admin });
  await call('DELETE', `/api/users/${await userId('jude')}`, { cookie: admin });
  await tick();
  assert.deepEqual(seen(), [before + 1, before + 2, before + 3, before + 2, before + 1, before]);
  assert.equal(await count(admin), before);
  assert.ok(!b.events.some((e) => e.type === 'users:pending'), 'a non-admin socket never receives the count');
  a.ws.close();
  b.ws.close();
});

test('the admin can not lock itself out; delete removes an account and its sessions', async () => {
  const ownerId = await userId('owner');
  assert.equal((await call('POST', `/api/users/${ownerId}/disable`, { cookie: admin })).status, 400);
  const reset = await call('POST', `/api/users/${ownerId}/reset-device`, { cookie: admin });
  assert.equal(reset.status, 400, 'a password-less administrator keeps its device');
  assert.match(reset.data.error, /reset-admin/);
  assert.equal((await call('DELETE', `/api/users/${ownerId}`, { cookie: admin })).status, 400);
  const carolId = await userId('carol');
  assert.equal((await call('DELETE', `/api/users/${carolId}`, { cookie: admin })).status, 200);
  assert.equal(await one(`SELECT 1 FROM users WHERE id = $1`, [carolId]), null);
  // That computer is free again for a new account, which starts pending.
  assert.equal((await signup('carol', CAROL_DEV)).data.user.status, 'pending');
  const out = await call('POST', '/api/auth/logout', { cookie: admin });
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await call('GET', '/api/projects', { cookie: admin })).status, 401);
});

test('AF_ADMIN_USERNAME bootstraps or restores the administrator on boot; it signs in with its password anywhere', async () => {
  assert.equal(await auth.ensureAdmin({}), null);
  const made = await auth.ensureAdmin({ AF_ADMIN_USERNAME: 'root-owner', AF_ADMIN_PASSWORD: 'long enough pw' });
  assert.deepEqual([made.role, made.status], ['admin', 'active']);
  const pw = (device, password = 'long enough pw') => call('POST', '/api/auth/login', { body: { username: 'root-owner', password, device } });
  assert.equal((await pw(browser('x'), 'wrong')).status, 401);
  assert.equal((await pw(LAPTOP_DEV)).status, 200, 'on a computer bound to bob: signed in, never taking it over');
  assert.equal((await one(`SELECT device_secret_hash FROM users WHERE username = 'root-owner'`)).device_secret_hash, null);
  assert.equal((await pw(undefined)).status, 200, 'with no device at all');
  const own = browser('Firefox on Linux');
  assert.equal((await pw(own)).status, 200);
  assert.equal((await deviceLogin(own)).data.user.username, 'root-owner', 'a free browser is bound at its password login');
  await pool.query(`UPDATE users SET status = 'disabled', role = 'user' WHERE username = 'carol'`);
  const promoted = await auth.ensureAdmin({ AF_ADMIN_USERNAME: 'carol' });
  assert.deepEqual([promoted.role, promoted.status], ['admin', 'active']);
});

test('the page-load device check: approved → session; pending, rejected, disabled → why, with no session; deleted → unknown, a fresh secret registers', async () => {
  const owner = cookieOf(await call('POST', '/api/auth/login', { body: { username: 'root-owner', password: 'long enough pw' } }));
  const dev = browser('Firefox on Linux');
  assert.equal((await signup('gina', dev)).data.user.status, 'pending');
  const id = await userId('gina');
  for (const [action, code] of [[null, 'pending'], ['reject', 'rejected'], ['approve', null], ['disable', 'disabled']]) {
    if (action) assert.equal((await call('POST', `/api/users/${id}/${action}`, { cookie: owner })).status, 200, action);
    const r = await deviceLogin(dev);
    if (!code) {
      assert.equal(r.status, 200);
      const me = await call('GET', '/api/auth/me', { cookie: cookieOf(r) });
      assert.equal(me.data.user.username, 'gina', 'an approved device lands signed in');
      continue;
    }
    assert.deepEqual([r.status, r.data.code, r.data.user.username, r.setCookie], [403, code, 'gina', null], code);
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
  }
  // The account is deleted: its browser's secret is unknown (no session), and that browser registers with a fresh one.
  assert.equal((await call('DELETE', `/api/users/${id}`, { cookie: owner })).status, 200);
  const gone = await deviceLogin(dev);
  assert.deepEqual([gone.status, gone.data.code, gone.setCookie], [401, 'unknown_device', null]);
  const fresh = await signup('gina', browser('Firefox on Linux'));
  assert.deepEqual([fresh.status, fresh.data.user.status, fresh.setCookie], [200, 'pending', null]);
});

let root, nia; // fresh cookies for the settings and Git identity tests

test('settings are admin-only: even with manageSettings a non-admin can neither read nor write them, over HTTP or WebSocket', async () => {
  // Earlier tests reset the owner's device and end sessions: fresh ones for the owner and another non-admin.
  root = `af_session=${await auth.createSession(await userId('owner'))}`;
  assert.equal((await signup('nia', browser('Chrome on Linux', { screen: '800x600' }))).status, 200);
  assert.equal((await call('POST', `/api/users/${await userId('nia')}/approve`, { cookie: root })).status, 200);
  nia = `af_session=${await auth.createSession(await userId('nia'))}`;
  const dev = browser('Firefox on Linux');
  assert.equal((await signup('sid', dev)).status, 200);
  const id = await userId('sid');
  assert.equal((await call('POST', `/api/users/${id}/approve`, { cookie: root })).status, 200);
  assert.equal((await call('PUT', `/api/users/${id}/permissions`, { cookie: root, body: { manageSettings: true } })).status, 200);
  const sid = cookieOf(await deviceLogin(dev));
  for (const key of ['orchestrator', 'evolution', 'monitor', 'github']) {
    assert.equal((await call('PUT', `/api/settings/${key}`, { cookie: sid, body: { enabled: false } })).status, 403, key);
  }
  assert.equal((await call('GET', '/api/settings', { cookie: sid })).status, 403);
  assert.equal((await call('GET', '/api/settings', { cookie: root })).status, 200, 'the administrator still reads them');
  assert.equal((await call('GET', '/api/models', { cookie: sid })).status, 200, 'models stay open to manageSettings');
  const s = await socket(sid);
  const a = await socket(root);
  await tick();
  s.events.length = 0;
  a.events.length = 0;
  emit('settings:update', { key: 'orchestrator', value: { maxParallel: 3 } });
  emit('models:update', {});
  await tick();
  assert.deepEqual(s.events.map((e) => e.type), ['models:update']);
  assert.deepEqual(a.events.map((e) => e.type), ['settings:update', 'models:update']);
  s.ws.close();
  a.ws.close();
});

test('per-user Git identity: the administrator sets name, email and branch (validated); other non-admins never see them', async () => {
  const id = await userId('sid');
  const put = (body, cookie = root) => call('PUT', `/api/users/${id}/git`, { cookie, body });
  const ok = await put({ git_name: ' Sid Vicious ', git_email: 'sid@example.com', git_branch: 'users/sid' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.git_name, ok.data.git_email, ok.data.git_branch], ['Sid Vicious', 'sid@example.com', 'users/sid']);
  const listed = (await call('GET', '/api/users', { cookie: root })).data.users.find((u) => u.id === id);
  assert.equal(listed.git_email, 'sid@example.com', 'the Users page lists it');
  for (const email of ['sid', 'sid@', '@example.com', 'sid@example', 'a b@example.com', '<sid@example.com>']) {
    const r = await put({ git_email: email });
    assert.deepEqual([r.status, r.data.code], [400, 'invalid_git_email'], email);
    assert.match(r.data.error, /not an email address/);
  }
  for (const branch of ['-x', 'a..b', 'a b', 'HEAD', '@{-1}', 'x.lock', 'feat/', 'a~1', 'a:b', '/x', '.hidden']) {
    const r = await put({ git_branch: branch });
    assert.deepEqual([r.status, r.data.code], [400, 'invalid_git_branch'], branch);
    assert.match(r.data.error, /not a valid branch name/);
  }
  assert.equal((await put({ git_name: 'x', git_email: 'sid@example.com', git_branch: 'users/sid' }, nia)).status, 403, 'non-admins can not set it');
  assert.equal((await one(`SELECT git_name FROM users WHERE id = $1`, [id])).git_name, 'Sid Vicious', 'refused changes are not stored');
  // nia sees nobody else's account (Users is admin-only), and their own has no identity set.
  assert.equal((await call('GET', '/api/users', { cookie: nia })).status, 403);
  const me = await call('GET', '/api/auth/me', { cookie: nia });
  assert.deepEqual([me.data.user.git_email, me.data.user.git_branch], [null, null]);
  assert.ok(!JSON.stringify(me.data).includes('sid@example.com'));
  // Empty fields clear it: the global identity applies again.
  const cleared = await put({ git_name: '', git_email: '  ', git_branch: null });
  assert.deepEqual([cleared.status, cleared.data.git_name, cleared.data.git_email, cleared.data.git_branch], [200, null, null, null]);
});
