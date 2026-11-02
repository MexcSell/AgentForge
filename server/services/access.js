// Who may see what (docs/users.md). Pure and synchronous, so WebSocket broadcasts can be filtered per socket.
// A user is { id, role: 'admin' | 'user', status, permissions }; permissions is
// { projects: uuid[], createProjects, runMissions, manageAgents, manageSettings } (missing = false / none).

export const CAPABILITIES = {
  createProjects: 'Create projects (a project they create is granted to them)',
  runMissions: 'Run missions in granted projects: orders, stop, stand-ups, sync, proposals, topics, team and preview',
  manageAgents: 'Agent registry and evolution: view, create, edit, clone, merge and archive agents',
  manageSettings: 'Settings, models and GitHub: view and change',
};

// Protected projects (the AgentForge platform itself) are never visible to a non-admin, even when granted.
// Kept here for the synchronous WebSocket filter; refreshed by services/auth.js loadProtected().
const hidden = new Set();
export function setProtectedProjects(ids) {
  hidden.clear();
  for (const id of ids) hidden.add(id);
}
export const isProtectedProject = (id) => hidden.has(id);

export const isAdmin = (u) => u?.role === 'admin' && u.status === 'active';

export function can(u, perm) {
  if (!u || u.status !== 'active') return false;
  return isAdmin(u) || u.permissions?.[perm] === true;
}

export function canSeeProject(u, projectId) {
  if (!u || u.status !== 'active' || !projectId) return false;
  if (isAdmin(u)) return true;
  return !hidden.has(projectId) && Array.isArray(u.permissions?.projects) && u.permissions.projects.includes(projectId);
}

/** The project ids a non-admin may see (null = everything, for an admin). */
export function grantedProjects(u) {
  if (isAdmin(u)) return null;
  return (u?.permissions?.projects || []).filter((id) => !hidden.has(id));
}

/** Cleans a permissions object from the Users page: known flags only, project ids as unique uuids, no protected ones. */
export function sanitizePermissions(p = {}) {
  const out = { projects: [] };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (Array.isArray(p.projects)) out.projects = [...new Set(p.projects.filter((id) => typeof id === 'string' && uuid.test(id) && !hidden.has(id)))];
  for (const k of Object.keys(CAPABILITIES)) out[k] = p[k] === true;
  return out;
}

// Events every signed-in user receives: service status, host metrics, restarts; notification read/delete carry ids only.
const PUBLIC_EVENTS = new Set(['system:status', 'system:metrics', 'system:restarting', 'system:client-updated', 'auth:update', 'notification:read', 'notification:delete']);
// Events of one project: the project id is payload.id for these, payload.project_id for the rest.
const PROJECT_BY_ID = new Set(['project:update', 'project:delete']);
const PROJECT_EVENTS = new Set(['project:members', 'message:new', 'message:update', 'task:update', 'mission:update', 'run:start', 'run:event', 'run:end',
  'topic:new', 'topic:update', 'topic:delete', 'topic:moved', 'preview:log', 'preview:update', 'sync:log', 'notification:new']);
const AGENT_EVENTS = new Set(['agent:new', 'agent:update', 'agent:delete', 'evolution:event']);
const SETTINGS_EVENTS = new Set(['settings:update', 'models:update']);

/** Whether a broadcast event may go to this user. Anything not listed is admin-only. */
export function eventVisibleTo(u, type, payload) {
  if (!u || u.status !== 'active') return false;
  if (isAdmin(u)) return true;
  if (PUBLIC_EVENTS.has(type)) return true;
  if (PROJECT_BY_ID.has(type)) return canSeeProject(u, payload?.id);
  if (PROJECT_EVENTS.has(type)) return canSeeProject(u, payload?.project_id);
  if (AGENT_EVENTS.has(type)) return can(u, 'manageAgents');
  if (SETTINGS_EVENTS.has(type)) return can(u, 'manageSettings');
  return false;
}
