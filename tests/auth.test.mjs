// Accounts and authorization (routes/auth.js, services/auth.js, services/access.js, events.js): sign-up → pending →
// admin approval, rejected/disabled logins, per-project permissions over REST and WebSocket (the protected AgentForge
// project stays hidden), and device binding. Runs the real routes in-process against session temp tables
// (search_path=pg_temp), never the live tables.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// A computer as client/src/lib/device.js reports it, and variations of it.
const PC = { platform: 'Linux x86_64', cores: 8, memory: 8, gpu: 'ANGLE (NVIDIA, GeForce GTX 1080)', canvas: 'c0ffee12', touch: 0, screen: '1920x1080', colorDepth: 24, timezone: 'Europe/Berlin', language: 'en-US' };
const pc = (over = {}) => ({ ...PC, ...over });
const LAPTOP = pc({ platform: 'MacIntel', cores: 10, memory: 16, gpu: 'Apple M1 Pro', canvas: 'aa11bb22', screen: '1512x982', colorDepth: 30 });
const BOB_PC = pc({ cores: 4, memory: 4, gpu: 'Mesa Intel(R) UHD Graphics 620', canvas: '5eed5eed', screen: '1366x768' });
const CAROL_PC = pc({ platform: 'Win32', cores: 12, memory: 32, gpu: 'ANGLE (AMD Radeon RX 6700)', canvas: '0ddba11', timezone: 'Asia/Seoul', language: 'ko-KR' });

let app, base, core, alpha, beta;

async function call(method, path, { body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}
const cookieOf = (r) => r.setCookie.split(';')[0];
const signup = (username, device, extra = {}) => call('POST', '/api/auth/signup', { body: { username, password: 'correct horse', device, ...extra } });
const login = (username, device, password = 'correct horse') => call('POST', '/api/auth/login', { body: { username, password, device } });
const userId = async (name) => (await one(`SELECT id FROM users WHERE username = $1`, [name])).id;

/** Opens /api/events (or path) with the cookie and an optional browser Origin; resolves { ws, events } once open, or { status } when the upgrade is refused. */
function socket(cookie, { origin, path = '/api/events' } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: cookie ? { cookie } : {}, ...(origin ? { origin } : {}) });
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
  await app.register(authRoutes);
  await app.register(apiRoutes);
  await app.register(filesRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
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
});

test('the first account becomes the active administrator, with a salted scrypt hash and an httpOnly session cookie', async () => {
  const r = await signup('owner', PC);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
  assert.equal(r.data.user.status, 'active');
  assert.match(r.setCookie, /^af_session=[\w-]{40,};/);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  admin = cookieOf(r);
  const row = await one(`SELECT password_hash FROM users WHERE username = 'owner'`);
  assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]{20,}\$[A-Za-z0-9+/=]{80,}$/);
  assert.ok(!row.password_hash.includes('correct horse'));
  assert.notEqual(await auth.hashPassword('correct horse'), await auth.hashPassword('correct horse'), 'random salt');
  assert.equal(await auth.verifyPassword('correct horse', row.password_hash), true);
  assert.equal(await auth.verifyPassword('wrong horse', row.password_hash), false);
  // Only the token's SHA-256 is stored.
  assert.equal((await one(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1`, [admin.split('=')[1]])).n, 0);
  assert.deepEqual((await call('GET', '/api/auth/state')).data, { setup: false });
  assert.equal((await call('GET', '/api/projects', { cookie: admin })).data.length, 3);
});

test('WebSockets accept the app\'s own origin (any host name or IP it is opened by) and refuse other origins', async () => {
  const port = new URL(base).port;
  const own = await socket(admin, { origin: base });
  assert.equal(own.status, undefined, 'same-origin socket opens');
  own.ws.close();
  // Opened by a LAN/public address through a proxy that keeps the browser's host in X-Forwarded-Host.
  const proxied = await new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/events', { origin: 'http://192.0.2.10:4800', headers: { cookie: admin, 'x-forwarded-host': '192.0.2.10:4800' } });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('error', () => {});
  });
  assert.equal(proxied, 'open');
  for (const origin of [`http://127.0.0.1:${Number(port) + 1}`, 'http://evil.example', 'null']) {
    assert.equal((await socket(admin, { origin })).status, 403, origin);
    assert.equal((await socket(admin, { origin, path: '/api/terminal' })).status, 403, `terminal ${origin}`);
  }
  assert.equal((await socket(undefined, { origin: 'http://evil.example' })).status, 403, 'refused before the session check');
});

test('a new sign-up is pending: it can see its own state but nothing else until approved', async () => {
  const r = await signup('bob', BOB_PC, { team: 'Platform' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.status, 'pending');
  assert.equal(r.data.user.role, 'user');
  bob = cookieOf(r);
  assert.equal((await call('GET', '/api/auth/me', { cookie: bob })).data.user.status, 'pending');
  const p = await call('GET', '/api/projects', { cookie: bob });
  assert.equal(p.status, 403);
  assert.equal(p.data.status, 'pending');
  assert.equal((await socket(bob)).status, 403);
  // The administrator is told, and sees it first in the list.
  const list = await call('GET', '/api/users', { cookie: admin });
  assert.equal(list.data.users[0].username, 'bob');
  assert.equal(list.data.users[0].team, 'Platform');
  assert.ok(!('password_hash' in list.data.users[0]) && !('device' in list.data.users[0]));
  assert.ok((await one(`SELECT 1 FROM notifications WHERE title LIKE '%bob%'`)));
});

test('sign-up is refused for a computer bound to another username, or a name that is taken', async () => {
  const again = await signup('bob2', BOB_PC);
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'device_taken');
  // A bigger window, another monitor or language is still the same computer.
  assert.equal((await signup('bob3', pc({ ...BOB_PC, screen: '2560x1440', language: 'de-DE', innerWidth: 900 }))).data.code, 'device_taken');
  const taken = await signup('BOB', CAROL_PC);
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /username/);
  assert.equal((await signup('x', CAROL_PC)).status, 400);
  assert.equal((await call('POST', '/api/auth/signup', { body: { username: 'carol', password: 'short', device: CAROL_PC } })).status, 400);
  assert.equal((await signup('carol', { ip: '10.0.0.1' })).status, 400, 'no device characteristics');
  assert.equal(await one(`SELECT 1 FROM users WHERE lower(username) IN ('bob2', 'bob3', 'carol')`), null);
});

test('the stored device holds hashed characteristics only, never an IP address', async () => {
  const r = await signup('carol', { ...CAROL_PC, ip: '203.0.113.7', ipv6: '2001:db8::1', localAddress: '192.168.1.20' });
  assert.equal(r.status, 200);
  const { device } = await one(`SELECT device FROM users WHERE username = 'carol'`);
  assert.deepEqual(Object.keys(device).sort(), [...auth.DEVICE_HARDWARE, ...auth.DEVICE_SOFT].sort());
  for (const v of Object.values(device)) assert.match(v, /^[0-9a-f]{64}$/);
  const text = JSON.stringify(device);
  for (const raw of ['203.0.113', '2001:db8', '192.168', 'Win32', 'Radeon', 'Asia/Seoul']) assert.ok(!text.includes(raw), raw);
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

test('login: wrong password, another computer and rejected or disabled accounts are refused', async () => {
  assert.equal((await login('bob', BOB_PC, 'wrong horse')).status, 401);
  assert.equal((await login('nobody', BOB_PC)).status, 401);
  const away = await login('bob', LAPTOP);
  assert.equal(away.status, 403);
  assert.equal(away.data.code, 'device_mismatch');
  assert.match(away.data.error, /another computer/);
  assert.equal((await login('bob', pc({ ...BOB_PC, screen: '3840x2160', timezone: 'UTC' }))).status, 200, 'same computer, other monitor and timezone');
  // The admin may sign in from anywhere.
  assert.equal((await login('owner', LAPTOP)).status, 200);

  // Reset: the next login binds the new computer, and the old one is refused from then on.
  const bobId = await userId('bob');
  const reset = await call('POST', `/api/users/${bobId}/reset-device`, { cookie: admin });
  assert.equal(reset.data.device_bound, false);
  assert.equal((await login('bob', CAROL_PC)).data.code, 'device_taken', 'a computer bound to carol can not be taken over');
  assert.equal((await login('bob', LAPTOP)).status, 200);
  assert.equal((await login('bob', BOB_PC)).data.code, 'device_mismatch');

  const carolId = await userId('carol');
  assert.equal((await call('POST', `/api/users/${carolId}/reject`, { cookie: admin })).data.status, 'rejected');
  const rejected = await login('carol', CAROL_PC);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.data.code, 'rejected');

  const live = await socket(bob);
  const closed = new Promise((r) => live.ws.on('close', (code) => r(code)));
  assert.equal((await call('POST', `/api/users/${bobId}/disable`, { cookie: admin })).data.status, 'disabled');
  assert.equal(await closed, 4401, 'open sockets of a disabled account are closed');
  assert.equal((await call('GET', '/api/projects', { cookie: bob })).status, 401, 'its sessions end');
  assert.equal((await login('bob', LAPTOP)).data.code, 'disabled');
  assert.equal((await call('POST', `/api/users/${bobId}/enable`, { cookie: admin })).data.status, 'active');
  assert.equal((await login('bob', LAPTOP)).status, 200);
});

test('the admin can not lock itself out; delete removes an account and its sessions', async () => {
  const ownerId = await userId('owner');
  assert.equal((await call('POST', `/api/users/${ownerId}/disable`, { cookie: admin })).status, 400);
  assert.equal((await call('DELETE', `/api/users/${ownerId}`, { cookie: admin })).status, 400);
  const carolId = await userId('carol');
  assert.equal((await call('DELETE', `/api/users/${carolId}`, { cookie: admin })).status, 200);
  assert.equal(await one(`SELECT 1 FROM users WHERE id = $1`, [carolId]), null);
  // Her computer is free again for a new account, which starts pending.
  assert.equal((await signup('carol', CAROL_PC)).data.user.status, 'pending');
  const out = await call('POST', '/api/auth/logout', { cookie: admin });
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await call('GET', '/api/projects', { cookie: admin })).status, 401);
});

test('AF_ADMIN_USERNAME bootstraps or restores the administrator on boot', async () => {
  assert.equal(await auth.ensureAdmin({}), null);
  const made = await auth.ensureAdmin({ AF_ADMIN_USERNAME: 'root-owner', AF_ADMIN_PASSWORD: 'long enough pw' });
  assert.deepEqual([made.role, made.status], ['admin', 'active']);
  assert.equal((await login('root-owner', LAPTOP, 'long enough pw')).status, 200);
  await pool.query(`UPDATE users SET status = 'disabled', role = 'user' WHERE username = 'carol'`);
  const promoted = await auth.ensureAdmin({ AF_ADMIN_USERNAME: 'carol' });
  assert.deepEqual([promoted.role, promoted.status], ['admin', 'active']);
});
