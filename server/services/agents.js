import { one, many, query } from '../db/pool.js';
import { emit } from '../events.js';
import { CODENAMES, roleInfo, normalizeRole } from '../roles.js';

const AGENT_COLS = `a.*, s.name AS supervisor_name,
  (SELECT count(*)::int FROM agents c WHERE c.supervisor_id = a.id AND NOT c.archived) AS reports`;

export async function listAgents() {
  return many(`SELECT ${AGENT_COLS} FROM agents a LEFT JOIN agents s ON s.id = a.supervisor_id WHERE NOT a.archived ORDER BY a.tier, a.created_at`);
}

export async function getAgent(id) {
  return one(`SELECT ${AGENT_COLS} FROM agents a LEFT JOIN agents s ON s.id = a.supervisor_id WHERE a.id = $1`, [id]);
}

export async function publishAgent(id) {
  const a = await getAgent(id);
  if (a) emit('agent:update', a);
  return a;
}

export async function setAgentStatus(id, status, currentTaskId = null) {
  await query(`UPDATE agents SET status=$2, current_task_id=$3, updated_at=now() WHERE id=$1`, [id, status, currentTaskId]);
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
