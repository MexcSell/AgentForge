// Sign-in, sign-up, the admin Users API, and the hooks that put every other route behind an active account
// (docs/users.md). Route policies live in POLICY below; a route that is not listed there is admin-only.
import { one } from '../db/pool.js';
import { isUuid } from '../services/topics.js';
import { can, canSeeProject, isAdmin, CAPABILITIES } from '../services/access.js';
import {
  signup, login, deviceLogin, needsSetup, createSession, sessionUser, destroySession, tokenOf, sessionCookie, clearedCookie, publicUser,
  listUsers, pendingCount, userAction, setPermissions, setGitIdentity, deleteUser,
} from '../services/auth.js';
import { previewTarget } from './preview.js';

const err = (reply, code, message, extra = {}) => reply.code(code).send({ error: message, ...extra });

// Reachable without a session. /api/health is polled by the supervisor; /api/auth/me answers 401 itself.
const PUBLIC = new Set(['/api/health', '/api/auth/state', '/api/auth/signup', '/api/auth/login', '/api/auth/device', '/api/auth/logout', '/api/auth/me']);
const GATED = /^\/(api|uploads)(\/|$)/;

// 'user': any active account (the handler filters by permission). { cap }: a capability flag. { project, write }:
// the route's project (from :id, or the topic / task :id) must be granted; write also needs runMissions.
const ANY = 'user';
const P = (from, write = false) => ({ project: from, write });
const POLICY = {
  'GET /api/system/status': ANY,
  'GET /api/system/metrics': ANY,
  'GET /api/events': ANY,
  'GET /api/roles': ANY,
  'GET /api/models': ANY,
  'GET /api/dashboard': ANY,
  'GET /uploads/*': ANY,

  'GET /api/projects': ANY,
  'POST /api/projects': { cap: 'createProjects' },
  'GET /api/projects/:id/messages': P('id'),
  'GET /api/projects/:id/tasks': P('id'),
  'GET /api/projects/:id/git': P('id'),
  'GET /api/projects/:id/members': P('id'),
  'GET /api/projects/:id/topics': P('id'),
  'GET /api/projects/:id/preview': P('id'),
  'POST /api/projects/:id/command': P('id', true),
  'POST /api/projects/:id/cancel': P('id', true),
  'POST /api/projects/:id/standup': P('id', true),
  'POST /api/projects/:id/sync': P('id', true),
  'POST /api/projects/:id/members': P('id', true),
  'DELETE /api/projects/:id/members/:agentId': P('id', true),
  'POST /api/projects/:id/members/release-idle': P('id', true),
  'POST /api/projects/:id/topics': P('id', true),
  'POST /api/projects/:id/preview/start': P('id', true),
  'POST /api/projects/:id/preview/stop': P('id', true),
  'POST /api/projects/:id/preview/restart': P('id', true),
  'PATCH /api/topics/:id': P('topic', true),
  'DELETE /api/topics/:id': P('topic', true),
  'POST /api/tasks/:id/approve': P('task', true),
  'POST /api/tasks/:id/reject': P('task', true),
  'POST /api/uploads': { cap: 'runMissions' },

  'GET /api/agents': ANY,
  'GET /api/agents/:id': { cap: 'manageAgents' },
  'GET /api/agents/:id/live': { cap: 'manageAgents' },
  'POST /api/agents': { cap: 'manageAgents' },
  'PATCH /api/agents/:id': { cap: 'manageAgents' },
  'POST /api/agents/:id/clone': { cap: 'manageAgents' },
  'GET /api/agents/:id/handover': { cap: 'manageAgents' },
  'POST /api/agents/:id/merge': { cap: 'manageAgents' },
  'GET /api/agents/consolidate/preview': { cap: 'manageAgents' },
  'POST /api/agents/consolidate': { cap: 'manageAgents' },
  'DELETE /api/agents/:id': { cap: 'manageAgents' },
  'GET /api/evolution': { cap: 'manageAgents' },
  'POST /api/evolution/cycle': { cap: 'manageAgents' },

  // GET/PUT /api/settings are admin-only (not listed): a non-admin's Settings page has only Appearance and Screen
  // format, which are browser preferences (client/src/lib/store.js PREFS) and never reach the server.
  'GET /api/providers': { cap: 'manageSettings' },
  'POST /api/models': { cap: 'manageSettings' },
  'PATCH /api/models/:id': { cap: 'manageSettings' },
  'POST /api/models/:id/default': { cap: 'manageSettings' },
  'DELETE /api/models/:id': { cap: 'manageSettings' },
  'POST /api/models/:id/test': { cap: 'manageSettings' },

  'GET /api/notifications': ANY,
  'POST /api/notifications/read': ANY,
};

async function projectOf(from, id) {
  if (from === 'id') return id;
  if (!isUuid(id)) return null;
  const row = await one(from === 'topic' ? `SELECT project_id FROM topics WHERE id = $1` : `SELECT project_id FROM tasks WHERE id = $1`, [id]);
  return row?.project_id || null;
}

/**
 * Whether an active user may call this route (method + route pattern): 0 if so, else the status to refuse with — 404
 * for a project they may not see (as if it did not exist), 403 otherwise. Routes not in POLICY are admin-only.
 */
export async function refusal(user, method, url, params = {}) {
  if (isAdmin(user)) return 0;
  const rule = POLICY[`${method === 'HEAD' ? 'GET' : method} ${url}`];
  if (!rule) return 403;
  if (rule === ANY) return 0;
  if (rule.cap) return can(user, rule.cap) ? 0 : 403;
  if (!canSeeProject(user, await projectOf(rule.project, params.id))) return 404;
  return !rule.write || can(user, 'runMissions') ? 0 : 403;
}

/**
 * A browser WebSocket upgrade whose Origin is not this server (req.host: Host, or X-Forwarded-Host from a trusted proxy
 * only, see config.network). SameSite=Lax
 * still sends the cookie from another port of the same host, so a page there could otherwise open the events socket
 * or the terminal. Clients without an Origin (not browsers) are left to the session check.
 */
function crossOriginSocket(req) {
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers.origin) return false;
  let origin;
  try { origin = new URL(req.headers.origin).host.toLowerCase(); } catch { return true; }
  return !req.host || req.host.trim().toLowerCase() !== origin;
}

/**
 * Root hooks. onRequest (registered before the preview hook): /api, /uploads and project previews need an active
 * account → 401 without a session (pending, rejected and disabled accounts have none). preHandler: the route's POLICY.
 */
export function authHooks(app) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.raw.url.split('?')[0];
    const preview = previewTarget(req.raw);
    req.raw.afPreview = preview; // computed once: the preview hook reuses it
    if (!preview && pathname.startsWith('/api/') && crossOriginSocket(req)) return err(reply, 403, 'Cross-origin WebSocket refused');
    if (!preview && (!GATED.test(pathname) || PUBLIC.has(pathname))) return;
    const user = await sessionUser(tokenOf(req));
    if (!user) return err(reply, 401, 'Sign in required');
    if (user.status !== 'active') return err(reply, 403, user.status === 'pending' ? 'Your account is waiting for administrator approval' : 'This account can not sign in', { status: user.status });
    req.user = user;
    if (preview && !canSeeProject(user, preview.id)) return err(reply, 404, 'Not found');
  });
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return; // public route (or not gated)
    const url = req.routeOptions?.url;
    if (!url) return;
    const code = await refusal(req.user, req.method, url, req.params || {});
    if (code) return err(reply, code, code === 404 ? 'Not found' : 'You do not have permission for this');
  });
}

/** At most max hits per key within windowMs (in memory, per process): false once over. */
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    const ok = recent.length < max;
    if (ok) recent.push(now);
    if (hits.size > 10000) hits.clear(); // never grows without bound
    hits.set(key, recent);
    return ok;
  };
}

// The sign-in endpoints take a username, a device secret and a few KB of computer info: nothing bigger.
const AUTH_BODY = { bodyLimit: 16 * 1024 };

/** opts.signupLimit: { max, windowMs } registrations per client address (req.ip, see config.network). */
export default async function authRoutes(app, opts = {}) {
  const signupAllowed = rateLimiter(opts.signupLimit || { max: 10, windowMs: 15 * 60_000 });
  const done = async (req, reply, user) => {
    const token = await createSession(user.id);
    reply.header('set-cookie', sessionCookie(req, token));
    return { user: publicUser(user) };
  };
  const guard = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e.status) return err(reply, e.status, e.message, { ...(e.code ? { code: e.code } : {}), ...(e.user ? { user: e.user } : {}) });
      throw e;
    }
  };

  // The homepage asks first: setup = no administrator yet, so the first sign-up creates it.
  app.get('/api/auth/state', async () => ({ setup: await needsSetup() }));
  // A session only for an active account (sessionUser): a pending or rejected one answers 401 here.
  app.get('/api/auth/me', async (req, reply) => {
    const user = await sessionUser(tokenOf(req));
    if (!user) return err(reply, 401, 'Sign in required');
    return { user: publicUser(user), capabilities: CAPABILITIES };
  });
  // Username + this browser's device (secret and computer info). Only the first account (the administrator) is
  // signed in at once; any other waits for approval without a session, then signs in through /api/auth/device.
  app.post('/api/auth/signup', AUTH_BODY, guard(async (req, reply) => {
    if (!signupAllowed(req.ip)) return err(reply, 429, 'Too many registrations from this address. Try again later.', { code: 'rate_limited' });
    const user = await signup(req.body || {});
    if (user.status === 'active') return done(req, reply, user);
    return { user: publicUser(user), pending: true };
  }));
  app.post('/api/auth/device', AUTH_BODY, guard(async (req, reply) => done(req, reply, await deviceLogin(req.body || {}))));
  app.post('/api/auth/login', AUTH_BODY, guard(async (req, reply) => done(req, reply, await login(req.body || {}))));
  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(tokenOf(req));
    reply.header('set-cookie', clearedCookie(req));
    return { ok: true };
  });

  // ---- users (admin only: not in POLICY) -------------------------------------
  app.get('/api/users', async () => ({ users: await listUsers(), capabilities: CAPABILITIES }));
  app.get('/api/users/pending', async () => ({ count: await pendingCount() }));
  app.post('/api/users/:id/:action', guard(async (req) => {
    if (!isUuid(req.params.id)) throw Object.assign(new Error('User not found'), { status: 404 });
    return userAction(req.user, req.params.id, req.params.action);
  }));
  app.put('/api/users/:id/permissions', guard(async (req) => {
    if (!isUuid(req.params.id)) throw Object.assign(new Error('User not found'), { status: 404 });
    return setPermissions(req.user, req.params.id, req.body || {});
  }));
  // GitHub identity of the account's missions: { git_name, git_email, git_branch }, '' or null falls back to the global one.
  app.put('/api/users/:id/git', guard(async (req) => {
    if (!isUuid(req.params.id)) throw Object.assign(new Error('User not found'), { status: 404 });
    return setGitIdentity(req.user, req.params.id, req.body || {});
  }));
  app.delete('/api/users/:id', guard(async (req) => {
    if (!isUuid(req.params.id)) throw Object.assign(new Error('User not found'), { status: 404 });
    return deleteUser(req.user, req.params.id);
  }));
}
