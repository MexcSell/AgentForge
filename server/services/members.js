import { one, many } from '../db/pool.js';
import { emit } from '../events.js';
import { audit } from './notify.js';

/**
 * Project membership (project_members): the agents on a project, added by a human ('user') or when the GM staffs them
 * ('auto'), and released again when they are no longer needed there. The GM (projects.manager_id) is always a member and
 * is never released; an agent with a pending or running task in the project can't be released either.
 * Merging an agent moves its rows to the agent it merges into (absorb() in agents.js); a retired (archived, unmerged)
 * agent's rows stay, but archived agents are left out of every list and release.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status });

// busy: the agent's pending or running tasks in this project (keys), the ones that block a release.
const BUSY = (pid, aid) => `(SELECT coalesce(array_agg(t.key ORDER BY t.created_at), '{}') FROM tasks t
  WHERE t.project_id = ${pid} AND t.agent_id = ${aid} AND t.status IN ('pending', 'running'))`;

/**
 * Live members of a project, the GM first, then active before released, oldest first. The GM is listed even without a
 * row (a manager set outside this service), as an active 'auto' member.
 */
export async function listMembers(projectId) {
  return many(
    `SELECT a.id AS agent_id, a.name, a.role, a.title, a.tier, a.level, a.status AS agent_status, a.origin,
       coalesce(pm.status, 'active') AS status, coalesce(pm.added_by, 'auto') AS added_by, coalesce(pm.added_at, p.created_at) AS added_at,
       pm.released_at, a.id = p.manager_id AS is_manager, ${BUSY('p.id', 'a.id')} AS busy_tasks
     FROM projects p
     JOIN agents a ON a.id IN (SELECT agent_id FROM project_members WHERE project_id = p.id) OR a.id = p.manager_id
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.agent_id = a.id
     WHERE p.id = $1 AND NOT a.archived
     ORDER BY a.id = p.manager_id DESC, coalesce(pm.status, 'active'), coalesce(pm.added_at, p.created_at), a.name`, [projectId]);
}

// Sends 'project:members' { project_id, members } to every client; returns the members.
export async function publishMembers(projectId) {
  const members = await listMembers(projectId);
  emit('project:members', { project_id: projectId, members });
  return members;
}

async function projectOf(projectId) {
  const p = await one(`SELECT id, name, manager_id FROM projects WHERE id = $1`, [projectId]);
  if (!p) throw httpError(404, 'Project not found');
  return p;
}

/**
 * Add an agent to the project, or re-activate a released member. by: 'user' or 'auto'. Archived agents are refused (409).
 * Returns { changed, agent, members }; changed is false when it was an active member already (nothing is published).
 */
export async function addMember(projectId, agentId, by = 'user') {
  const p = await projectOf(projectId);
  const a = await one(`SELECT id, name, archived FROM agents WHERE id = $1`, [agentId]);
  if (!a) throw httpError(404, 'Agent not found');
  if (a.archived) throw httpError(409, `${a.name} is archived and can't be added to a project`);
  const changed = !!(await one(
    `INSERT INTO project_members(project_id, agent_id, status, added_by) VALUES ($1, $2, 'active', $3)
     ON CONFLICT (project_id, agent_id) DO UPDATE SET status = 'active', added_by = EXCLUDED.added_by, added_at = now(), released_at = NULL
     WHERE project_members.status <> 'active' RETURNING agent_id`, [p.id, a.id, by]));
  if (!changed) return { changed, agent: a, members: await listMembers(p.id) };
  await audit(by === 'user' ? 'user' : 'system', 'project.member.add', a.name, { projectId: p.id, project: p.name, agentId: a.id, by });
  return { changed, agent: a, members: await publishMembers(p.id) };
}

/**
 * Standing of every agent with a row in the project, plus the GM: Map agentId -> 'active' | 'released'. Agents not in
 * the map are not members. Staffing and the planner prompt read it (archived agents are left to their callers).
 */
export async function memberStanding(projectId) {
  const rows = await many(
    `SELECT agent_id, status FROM project_members WHERE project_id = $1
     UNION ALL SELECT manager_id, 'active' FROM projects WHERE id = $1 AND manager_id IS NOT NULL`, [projectId]);
  const out = new Map();
  for (const r of rows) if (!out.has(r.agent_id) || r.status === 'active') out.set(r.agent_id, r.status);
  return out;
}

/**
 * The GM staffed or started agents on the project: each new one becomes an active 'auto' member. A member the user
 * released stays released (only addMember brings it back). Archived agents are skipped. Publishes once when anything
 * changed; returns the ids added.
 */
export async function ensureMembers(projectId, agentIds) {
  const ids = [...new Set(agentIds.filter(Boolean))];
  if (!ids.length) return [];
  const added = (await many(
    `INSERT INTO project_members(project_id, agent_id, status, added_by)
     SELECT $1, a.id, 'active', 'auto' FROM agents a WHERE a.id = ANY($2::uuid[]) AND NOT a.archived AND EXISTS (SELECT 1 FROM projects WHERE id = $1)
     ON CONFLICT (project_id, agent_id) DO NOTHING RETURNING agent_id`, [projectId, ids])).map((r) => r.agent_id);
  if (added.length) {
    await audit('system', 'project.member.add', null, { projectId, agentIds: added, by: 'auto' });
    await publishMembers(projectId);
  }
  return added;
}

// Release candidates in one statement, so a task staffed meanwhile can't slip past the checks: active, live, not the GM,
// nothing pending or running in the project. $2 NULL: every such member.
const RELEASE = `UPDATE project_members pm SET status = 'released', released_at = now()
  FROM projects p, agents a
  WHERE pm.project_id = $1 AND ($2::uuid IS NULL OR pm.agent_id = $2) AND p.id = pm.project_id AND a.id = pm.agent_id
    AND pm.status = 'active' AND NOT a.archived AND p.manager_id IS DISTINCT FROM pm.agent_id
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = pm.project_id AND t.agent_id = pm.agent_id AND t.status IN ('pending', 'running'))
  RETURNING pm.agent_id, a.name`;

/**
 * Release one member. Refused with 409 for the GM and for an agent with a pending or running task in the project
 * (nothing changes); 404 when it is not a member. Releasing a released member changes nothing.
 * Returns { changed, members }.
 */
export async function releaseMember(projectId, agentId) {
  const p = await projectOf(projectId);
  const row = await one(RELEASE, [p.id, agentId]);
  if (!row) {
    const m = await one(
      `SELECT a.name, a.archived, pm.status, a.id = $3::uuid AS is_manager, ${BUSY('$1::uuid', 'a.id')} AS busy
       FROM agents a LEFT JOIN project_members pm ON pm.project_id = $1 AND pm.agent_id = a.id WHERE a.id = $2`, [p.id, agentId, p.manager_id]);
    if (m?.is_manager) throw httpError(409, `${m.name} is the General Manager of ${p.name} and can't be released`);
    if (!m || !m.status || m.archived) throw httpError(404, 'Not a member of this project');
    if (m.status === 'released') return { changed: false, members: await listMembers(p.id) };
    if (m.busy.length) throw httpError(409, `${m.name} still has ${m.busy.length === 1 ? 'a pending or running task' : `${m.busy.length} pending or running tasks`} in ${p.name} (${m.busy.join(', ')}); release it once they finish`);
    // Active, live, not the GM and idle: a task finished or the GM changed between the two reads. Try once more.
    return releaseMember(projectId, agentId);
  }
  await audit('user', 'project.member.release', row.name, { projectId: p.id, project: p.name, agentId: row.agent_id });
  return { changed: true, members: await publishMembers(p.id) };
}

/** Release every idle member: not the GM, nothing pending or running in the project. Returns { released: [ids], members }. */
export async function releaseIdle(projectId) {
  const p = await projectOf(projectId);
  const rows = await many(RELEASE, [p.id, null]);
  if (!rows.length) return { released: [], members: await listMembers(p.id) };
  await audit('user', 'project.member.release-idle', p.name, { projectId: p.id, released: rows.map((r) => ({ id: r.agent_id, name: r.name })) });
  return { released: rows.map((r) => r.agent_id), members: await publishMembers(p.id) };
}
