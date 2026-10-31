import { pool, one, many, query } from '../db/pool.js';
import { getSettings } from '../db/seed.js';
import { emit } from '../events.js';
import { CODENAMES, roleInfo, normalizeRole } from '../roles.js';
import { notify, audit } from './notify.js';
import { combineLearning, mergePlaybooks, event as evolutionEvent } from '../orchestrator/evolution.js';

// active_tasks: the agent's running tasks across all projects (at most 1: claim() in the engine keeps agents exclusive).
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
// Archived agents are not pushed: their agent:delete went out already, and clients would upsert them back.
export function publishAgent(id) {
  return withAgentLock('publish', id, async () => {
    const a = await getAgent(id);
    if (a && !a.archived) emit('agent:update', a);
    return a;
  });
}

/**
 * Derive status from the DB in one statement: 'offline' once archived, else 'working' while the agent has a running
 * task or manages a running project with a planning/running mission, else 'idle'. current_task_id is its most recently
 * started running task. Serialized per agent: each recompute starts after the previous one committed, so the last one
 * sees every task change.
 */
export async function refreshAgentStatus(id) {
  await withAgentLock('status', id, () => query(
    `UPDATE agents a SET
       current_task_id = (SELECT t.id FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running' ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC LIMIT 1),
       status = CASE WHEN a.archived THEN 'offline'
         WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running')
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
    `INSERT INTO agents(name, role, title, tier, department, skills, supervisor_id, mission, purpose, playbook, prompt_version, model_id, origin, cloned_from, xp, level, clone_base)
     SELECT $2, role, title, tier, department, skills, supervisor_id, mission, purpose, playbook, prompt_version, model_id, 'cloned', id, xp / 2, GREATEST(1, level - 1),
       jsonb_build_object('xp', xp / 2, 'skills', skills)
     FROM agents WHERE id = $1 RETURNING id`,
    [sourceId, await allocateName(base)],
  );
  const agent = await getAgent(row.id);
  emit('agent:new', { ...agent, reason });
  return agent;
}

/**
 * A live agent to take over a task from one that is gone (a merged clone, a removed agent, or null when the task has
 * none). A merged clone's merge target comes first. Otherwise the best non-archived agent of the same role by overlap
 * with the gone agent's and the task's skills, idle agents ahead by the staffing bonus; with nobody of that role left,
 * an agent is recruited with the gone one's role, title and skills. One pick per role at a time, so picks made at the
 * same moment reuse a recruit instead of recruiting twice. Returns { agent, merged, recruited }.
 */
export async function replacementFor(gone, task = {}) {
  for (let id = gone?.merged_into, seen = new Set(); id && !seen.has(id);) {
    seen.add(id);
    const a = await getAgent(id);
    if (a && !a.archived) return { agent: a, merged: true, recruited: false };
    id = a?.merged_into;
  }
  const role = gone?.role || task.role;
  return withAgentLock('replace', role, async () => {
    const want = new Set([...(gone?.skills || []).map((s) => s.name), ...(task.skills || [])]);
    const score = (a) => a.skills.reduce((n, s) => n + (want.has(s.name) ? s.level : 0), 0) + (a.status === 'idle' ? 15 : 0);
    const best = (await listAgents()).filter((a) => a.role === role && a.id !== gone?.id).sort((a, b) => score(b) - score(a))[0];
    if (best) return { agent: best, merged: false, recruited: false };
    const skills = gone?.skills?.length ? gone.skills.map((s) => s.name) : task.skills;
    return { agent: await createAgent({ role, title: gone?.title, skills }), merged: false, recruited: true };
  });
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// First live agent up the clone's chain: its source, or wherever an archived source was merged into (or cloned from).
async function liveAncestor(clone) {
  const seen = new Set([clone.id]);
  for (let id = clone.cloned_from; id && !seen.has(id);) {
    seen.add(id);
    const a = await one(`SELECT id, archived, merged_into, cloned_from FROM agents WHERE id = $1`, [id]);
    if (!a) return null;
    if (!a.archived) return a;
    id = a.merged_into || a.cloned_from;
  }
  return null;
}

/**
 * Merge (return) an idle clone into its original: what it learned since it was copied is added to the original,
 * its experiences move over, and the clone is archived with merged_into set.
 * Lanes: the clone's 'claim' (no task can start on it meanwhile) and 'learn' lanes, then the original's 'learn'
 * lane, so a task the original finishes at the same moment loses nothing. Always clone before ancestor: no deadlock.
 */
export async function mergeAgent(cloneId) {
  const found = await getAgent(cloneId);
  if (!found) throw httpError(404, 'Not found');
  if (found.origin !== 'cloned') throw httpError(400, 'Only clones can be merged');
  const { clone, target, merged, projects } = await withAgentLock('claim', found.id, () => withAgentLock('learn', found.id, async () => {
    const c = await one(`SELECT a.*, EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running') AS running FROM agents a WHERE a.id = $1`, [found.id]);
    if (c.archived) throw httpError(409, c.merged_into ? 'This clone was already merged' : 'Agent is archived');
    if (c.running || c.status === 'working') throw httpError(409, 'Agent is working');
    for (;;) {
      const up = await liveAncestor(c);
      if (!up) throw httpError(409, 'No live original to merge into');
      const done = await withAgentLock('learn', up.id, () => absorb(c.id, up.id));
      if (done) return done; // null: that original was archived meanwhile, look further up
    }
  }));
  await evolutionEvent('merge', target.id, `${clone.name} merged back into ${target.name}`, { clone: clone.id, cloneName: clone.name, ...merged });
  await notify({ source_type: 'admin', source_name: 'Admin', agent_id: target.id, level: 'success', title: `Merged ${clone.name} into ${target.name}`,
    body: `+${merged.xp} XP · ${merged.skills} skills · ${merged.lessons} lessons${merged.playbookVersion ? ` · playbook v${merged.playbookVersion}` : ''}` });
  await audit('user', 'agent.merge', clone.name, { into: target.name, intoId: target.id, ...merged });
  emit('agent:delete', { id: clone.id });
  // projects: those the clone managed, now managed by the original (the caller publishes them).
  return { agent: await publishAgent(target.id), merged, projects };
}

// One transaction: the original gains the clone's learning, experiences and reports, and the clone is retired.
async function absorb(cloneId, targetId) {
  const settings = await getSettings();
  const db = await pool.connect();
  let clone, target, gained, moved, projects;
  try {
    await db.query('BEGIN');
    const rows = (await db.query(`SELECT * FROM agents WHERE id = ANY($1) FOR UPDATE`, [[cloneId, targetId]])).rows;
    clone = rows.find((r) => r.id === cloneId);
    target = rows.find((r) => r.id === targetId);
    if (clone.archived) throw httpError(409, 'Agent is archived');
    if (!target || target.archived) { await db.query('ROLLBACK'); return null; }
    const m = combineLearning(target, clone);
    gained = m.gained;
    await db.query(`UPDATE agents SET xp=$2, level=$3, skills=$4, stats=stats || $5, updated_at=now() WHERE id=$1`, [target.id, m.xp, m.level, JSON.stringify(m.skills), m.stats]);
    moved = (await db.query(`UPDATE experiences SET agent_id = $2 WHERE agent_id = $1 AND kind IN ('lesson', 'failure') RETURNING kind`, [clone.id, target.id])).rows;
    // Reports move to the original (which itself falls back to the clone's supervisor if it reported to the clone).
    await db.query(`UPDATE agents SET supervisor_id = CASE WHEN id = $2 THEN NULLIF($3::uuid, $2) ELSE $2 END, updated_at=now() WHERE supervisor_id = $1`, [clone.id, target.id, clone.supervisor_id]);
    // Projects the clone managed get the original as General Manager, in the same step that retires the clone.
    projects = (await db.query(`UPDATE projects SET manager_id = $2, updated_at = now() WHERE manager_id = $1 RETURNING id`, [clone.id, target.id])).rows.map((r) => r.id);
    await db.query(`UPDATE agents SET archived=true, status='offline', merged_into=$2, current_task_id=NULL, updated_at=now() WHERE id=$1`, [clone.id, target.id]);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
  const playbookVersion = await mergePlaybooks(target, clone, settings);
  const lessons = moved.filter((r) => r.kind === 'lesson').length;
  return { clone, target, projects, merged: { skills: gained.skills, xp: gained.xp, lessons, failures: moved.length - lessons, playbookVersion } };
}
