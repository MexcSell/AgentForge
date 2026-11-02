// Sign-in, sign-up, the admin Users API, and the hooks that put every other route behind an active account
// (docs/users.md). Route policies live in POLICY below; a route that is not listed there is admin-only.
import { one } from '../db/pool.js';
import { isUuid } from '../services/topics.js';
import { can, canSeeProject, isAdmin, CAPABILITIES } from '../services/access.js';
import {
  signup, login, needsSetup, createSession, sessionUser, destroySession, tokenOf, sessionCookie, clearedCookie, publicUser,
  listUsers, userAction, setPermissions, deleteUser,
} from '../services/auth.js';
import { previewTarget } from './preview.js';

const err = (reply, code, message, extra = {}) => reply.code(code).send({ error: message, ...extra });

// Reachable without a session. /api/health is polled by the supervisor; /api/auth/me answers 401 itself.
const PUBLIC = new Set(['/api/health', '/api/auth/state', '/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/auth/me']);
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

  'GET /api/settings': { cap: 'manageSettings' },
  'PUT /api/settings/:key': { cap: 'manageSettings' },
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
 * Root hooks. onRequest (registered before the preview hook): /api, /uploads and project previews need an active
 * account → 401 without a session, 403 while pending. preHandler: the route's POLICY.
 */
export function authHooks(app) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.raw.url.split('?')[0];
    const preview = previewTarget(req.raw);
    req.raw.afPreview = preview; // computed once: the preview hook reuses it
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

export default async function authRoutes(app) {
  const done = async (req, reply, user) => {
    const token = await createSession(user.id);
    reply.header('set-cookie', sessionCookie(req, token));
    return { user: publicUser(user) };
  };
  const guard = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e.status) return err(reply, e.status, e.message, e.code ? { code: e.code } : {});
      throw e;
    }
  };

  // The homepage asks first: setup = no administrator yet, so the first sign-up creates it.
  app.get('/api/auth/state', async () => ({ setup: await needsSetup() }));
  app.get('/api/auth/me', async (req, reply) => {
    const user = await sessionUser(tokenOf(req));
    if (!user) return err(reply, 401, 'Sign in required');
    return { user: publicUser(user), capabilities: CAPABILITIES };
  });
  app.post('/api/auth/signup', guard(async (req, reply) => done(req, reply, await signup(req.body || {}))));
  app.post('/api/auth/login', guard(async (req, reply) => done(req, reply, await login(req.body || {}))));
  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(tokenOf(req));
    reply.header('set-cookie', clearedCookie(req));
    return { ok: true };
  });

  // ---- users (admin only: not in POLICY) -------------------------------------
  app.get('/api/users', async () => ({ users: await listUsers(), capabilities: CAPABILITIES }));
  app.post('/api/users/:id/:action', guard(async (req) => {
    if (!isUuid(req.params.id)) throw Object.assign(new Error('User not found'), { status: 404 });
    return userAction(req.user, req.params.id, req.params.action);
  }));
  app.put('/api/users/:id/permissions', guard(async (req) => {
    if (!isUuid(req.params.id)) throw Object.assign(new Error('User not found'), { status: 404 });
    return setPermissions(req.user, req.params.id, req.body || {});
  }));
  app.delete('/api/users/:id', guard(async (req) => {
    if (!isUuid(req.params.id)) throw Object.assign(new Error('User not found'), { status: 404 });
    return deleteUser(req.user, req.params.id);
  }));
}
