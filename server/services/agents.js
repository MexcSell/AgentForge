import { one, many, query } from '../db/pool.js';
import { emit } from '../events.js';
import { CODENAMES, roleInfo, normalizeRole } from '../roles.js';

// active_tasks: the agent's running tasks across all projects (its load against orchestrator.maxTasksPerAgent).
const AGENT_COLS = `a.*, s.name AS supervisor_name,
  (SELECT count(*)::int FROM agents c WHERE c.supervisor_id = a.id AND NOT c.archived) AS reports,
  (SELECT count(*)::int FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running') AS active_tasks`;

export async function listAgents() {
  return many(`SELECT ${AGENT_COLS} FROM agents a LEFT JOIN agents s ON s.id = a.supervisor_id WHERE NOT a.archived ORDER BY a.tier, a.created_at`);
}

export async function getAgent(id) {
  return one(`SELECT ${AGENT_COLS} FROM agents a LEFT JOIN agents s ON s.id = a.supervisor_id WHERE a.id = $1`, [id]);
}

const lanes = new Map(); // `${lane}:${agentId}` -> tail of its chain

/** Run fn for one agent at a time per lane, in call order. Different lanes never wait on each other. */
export function withAgentLock(lane, id, fn) {
  const key = `${lane}:${id}`;
  const run = (lanes.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  lanes.set(key, tail);
  tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key); });
  return run;
}

// Serialized per agent, so a stale read from a parallel task can never be the last update.
export function publishAgent(id) {
  return withAgentLock('publish', id, async () => {
    const a = await getAgent(id);
    if (a) emit('agent:update', a);
    return a;
  });
}

/**
 * Derive status from the DB in one statement: 'working' while the agent has a running task or manages a running
 * project with a planning/running mission, else 'idle'. current_task_id is its most recently started running task.
 * Serialized per agent: each recompute starts after the previous one committed, so the last one sees every task change.
 */
export async function refreshAgentStatus(id) {
  await withAgentLock('status', id, () => query(
    `UPDATE agents a SET
       current_task_id = (SELECT t.id FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running' ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC LIMIT 1),
       status = CASE WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running')
         OR EXISTS (SELECT 1 FROM projects p JOIN missions s ON s.project_id = p.id WHERE p.manager_id = a.id AND p.status = 'running' AND s.status IN ('planning', 'running'))
         THEN 'working' ELSE 'idle' END,
       updated_at = now()
     WHERE a.id = $1`, [id]));
  return publishAgent(id);
}

// Agent names are system-assigned and immutable.
async function allocateName(base) {
  const taken = new Set((await many(`SELECT name FROM agents`)).map((r) => r.name));
  if (base) {
    for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  const free = CODENAMES.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  for (let i = 2; ; i++) {
    const n = `${CODENAMES[i % CODENAMES.length]}-${i}`;
    if (!taken.has(n)) return n;
  }
}

export async function defaultSupervisorFor(role) {
  const info = roleInfo(role);
  const pick = async (r) => (await one(`SELECT id FROM agents WHERE role=$1 AND NOT archived ORDER BY created_at LIMIT 1`, [r]))?.id;
  if (info.tier <= 1) return pick('executive');
  if (info.tier === 4) return (await pick('reviewer')) || pick('executive');
  if (info.tier === 5) return (await pick('evolution')) || pick('executive');
  if (role === 'manager') return pick('executive');
  return (await pick('architect')) || pick('executive');
}

export async function createAgent({ role, title, skills, supervisor_id, mission, purpose, model_id, origin = 'created', cloned_from = null, name = null }) {
  role = normalizeRole(role);
  const info = roleInfo(role);
  const skillList = (skills?.length ? skills : info.skills).map((s) => (typeof s === 'string' ? { name: s.toLowerCase(), level: 35 } : s));
  const row = await one(
    `INSERT INTO agents(name, role, title, tier, department, skills, supervisor_id, mission, purpose, model_id, origin, cloned_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [name || (await allocateName()), role, title || info.title, info.tier, info.department, JSON.stringify(skillList),
      supervisor_id === undefined ? await defaultSupervisorFor(role) : supervisor_id,
      mission || `Deliver ${info.title.toLowerCase()} work with verifiable evidence.`,
      purpose || `Raise the quality bar of ${info.department.toLowerCase()} across projects.`,
      model_id || null, origin, cloned_from],
  );
  const agent = await getAgent(row.id);
  emit('agent:new', agent);
  return agent;
}

// Duplicate an agent (same role, skills, playbook) so work can run in parallel.
export async function cloneAgent(sourceId, reason = 'parallel work') {
  const src = await getAgent(sourceId);
  if (!src) throw new Error('agent not found');
  const base = src.name.replace(/-\d+$/, '');
  const row = await one(
    `INSERT INTO agents(name, role, title, tier, department, skills, supervisor_id, mission, purpose, playbook, prompt_version, model_id, origin, cloned_from, xp, level)
     SELECT $2, role, title, tier, department, skills, supervisor_id, mission, purpose, playbook, prompt_version, model_id, 'cloned', id, xp / 2, GREATEST(1, level - 1)
     FROM agents WHERE id = $1 RETURNING id`,
    [sourceId, await allocateName(base)],
  );
  const agent = await getAgent(row.id);
  emit('agent:new', { ...agent, reason });
  return agent;
}
