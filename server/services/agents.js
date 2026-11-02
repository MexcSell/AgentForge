import { pool, one, many, query } from '../db/pool.js';
import { getSettings } from '../db/seed.js';
import { emit } from '../events.js';
import { CODENAMES, roleInfo, normalizeRole } from '../roles.js';
import { notify, audit } from './notify.js';
import { publishMembers } from './members.js';
import { combineLearning, mergePlaybooks, foldPlaybooks, event as evolutionEvent } from '../orchestrator/evolution.js';

/**
 * Walk up a clone's chain in SQL: from start, step past each archived agent to its merged_into (else cloned_from),
 * never revisiting an id (seen starts as [self]). One row per agent visited, the last one live when the walk found one.
 * where (on the first step) limits which rows walk at all. liveAncestor() and merge_target_* both use it.
 */
const ancestorWalk = (self, start, where = 'true') => `WITH RECURSIVE walk(id, seen) AS (
    SELECT ${start}, ARRAY[${self}] WHERE ${where}
    UNION ALL
    SELECT COALESCE(x.merged_into, x.cloned_from), w.seen || w.id FROM walk w JOIN agents x ON x.id = w.id
    WHERE x.archived AND w.id <> ALL(w.seen))
  SELECT x.* FROM walk w JOIN agents x ON x.id = w.id WHERE NOT x.archived AND w.id <> ALL(w.seen) LIMIT 1`;

// active_tasks: the agent's running tasks across all projects (at most 1: claim() in the engine keeps agents exclusive).
// merge_target_*: the agent a live clone would merge into, as liveAncestor() resolves it; null for others.
const AGENT_COLS = `a.*, s.name AS supervisor_name,
  (SELECT count(*)::int FROM agents c WHERE c.supervisor_id = a.id AND NOT c.archived) AS reports,
  (SELECT count(*)::int FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running') AS active_tasks,
  mt.id AS merge_target_id, mt.name AS merge_target_name`;
const AGENT_FROM = `agents a LEFT JOIN agents s ON s.id = a.supervisor_id
  LEFT JOIN LATERAL (${ancestorWalk('a.id', 'a.cloned_from', `a.origin = 'cloned' AND NOT a.archived`)}) mt ON true`;

export async function listAgents() {
  return many(`SELECT ${AGENT_COLS} FROM ${AGENT_FROM} WHERE NOT a.archived ORDER BY a.tier, a.created_at`);
}

export async function getAgent(id) {
  return one(`SELECT ${AGENT_COLS} FROM ${AGENT_FROM} WHERE a.id = $1`, [id]);
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
 * After agent id was archived, republish the live clones whose chain walk passes it: their merge target moved on
 * (to its own resolution, or to none). Call once the archive is committed.
 */
export async function publishCloneTargets(id) {
  const rows = await many(
    `WITH RECURSIVE walk(root, id, seen) AS (
       SELECT a.id, a.cloned_from, ARRAY[a.id] FROM agents a WHERE a.origin = 'cloned' AND NOT a.archived AND a.cloned_from IS NOT NULL
       UNION ALL
       SELECT w.root, COALESCE(x.merged_into, x.cloned_from), w.seen || w.id FROM walk w JOIN agents x ON x.id = w.id
       WHERE x.archived AND w.id <> ALL(w.seen))
     SELECT DISTINCT root FROM walk WHERE id = $1 AND id <> ALL(seen)`, [id]);
  for (const r of rows) await publishAgent(r.root);
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
// A clone is "<base>-N" with the lowest N >= 1 that no agent row holds. Archived (removed or merged) agents keep their
// names and still block them: agents.name is UNIQUE across all rows, and an archived agent stays visible in history.
function cloneName(base, taken) {
  for (let i = 1; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function allocateName(base) {
  const taken = new Set((await many(`SELECT name FROM agents`)).map((r) => r.name));
  if (base) return cloneName(base, taken);
  const free = CODENAMES.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  for (let i = 2; ; i++) {
    const n = `${CODENAMES[i % CODENAMES.length]}-${i}`;
    if (!taken.has(n)) return n;
  }
}

// insert(name) with a freshly allocated name, retried when an insert made at the same moment took that name first.
async function insertNamed(base, insert) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await insert(await allocateName(base));
    } catch (e) {
      if (e.code !== '23505' || e.constraint !== 'agents_name_key' || attempt >= 20) throw e;
    }
  }
}

// The executive: the oldest live agent of role 'executive' (its clones are newer). Top manager and GM of the protected project.
export const EXECUTIVE_SQL = `SELECT id FROM agents WHERE role = 'executive' AND NOT archived ORDER BY created_at, id LIMIT 1`;

export async function executiveId() {
  return (await one(EXECUTIVE_SQL))?.id || null;
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
  const supervisor = supervisor_id === undefined ? await defaultSupervisorFor(role) : supervisor_id;
  const insert = (n) => one(
    `INSERT INTO agents(name, role, title, tier, department, skills, supervisor_id, mission, purpose, model_id, origin, cloned_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [n, role, title || info.title, info.tier, info.department, JSON.stringify(skillList),
      supervisor,
      mission || `Deliver ${info.title.toLowerCase()} work with verifiable evidence.`,
      purpose || `Raise the quality bar of ${info.department.toLowerCase()} across projects.`,
      model_id || null, origin, cloned_from],
  );
  const row = name ? await insert(name) : await insertNamed(null, insert);
  const agent = await getAgent(row.id);
  emit('agent:new', agent);
  return agent;
}

// Duplicate an agent (same role, skills, playbook) so work can run in parallel. leaseMissionId: the mission the clone
// is made for; mergeMissionClones() folds it back into its original when that mission ends.
export async function cloneAgent(sourceId, reason = 'parallel work', { leaseMissionId = null } = {}) {
  const src = await getAgent(sourceId);
  if (!src) throw new Error('agent not found');
  const base = src.name.replace(/-\d+$/, '');
  const row = await insertNamed(base, (name) => one(
    `INSERT INTO agents(name, role, title, tier, department, skills, supervisor_id, mission, purpose, playbook, prompt_version, model_id, origin, cloned_from, xp, level, clone_base, lease_mission_id)
     SELECT $2, role, title, tier, department, skills, supervisor_id, mission, purpose, playbook, prompt_version, model_id, 'cloned', id, xp / 2, GREATEST(1, level - 1),
       jsonb_build_object('xp', xp / 2, 'skills', skills), $3
     FROM agents WHERE id = $1 RETURNING id`,
    [sourceId, name, leaseMissionId],
  ));
  const agent = await getAgent(row.id);
  emit('agent:new', { ...agent, reason });
  return agent;
}

// First live agent down a merged clone's merged_into chain; null when it was never merged or the chain ends archived.
export async function mergeTarget(gone) {
  for (let id = gone?.merged_into, seen = new Set(); id && !seen.has(id);) {
    seen.add(id);
    const a = await getAgent(id);
    if (a && !a.archived) return a;
    id = a?.merged_into;
  }
  return null;
}

/**
 * Of agents (rows like listAgents()), the best non-archived one of the gone agent's role (the task's when none is gone)
 * by overlap with the gone agent's and the task's skills, idle agents ahead by the staffing bonus. The gone agent and
 * the ids in exclude never qualify. Null when nobody of that role is left, i.e. replacementFor() would recruit. Pure.
 */
export function pickReplacement(gone, task = {}, agents = [], { exclude = [] } = {}) {
  const role = gone?.role || task.role;
  const skip = new Set([gone?.id, ...exclude]);
  const want = new Set([...(gone?.skills || []).map((s) => s.name), ...(task.skills || [])]);
  const score = (a) => a.skills.reduce((n, s) => n + (want.has(s.name) ? s.level : 0), 0) + (a.status === 'idle' ? 15 : 0);
  return agents.filter((a) => a.role === role && !a.archived && !skip.has(a.id)).sort((a, b) => score(b) - score(a))[0] || null;
}

/**
 * A live agent to take over a task from one that is gone (a merged clone, a removed agent, or null when the task has
 * none). A merged clone's merge target comes first. Otherwise pickReplacement() over the live agents; with nobody of
 * that role left, an agent is recruited with the gone one's role, title and skills. One pick per role at a time, so
 * picks made at the same moment reuse a recruit instead of recruiting twice. Returns { agent, merged, recruited }.
 */
export async function replacementFor(gone, task = {}) {
  const into = gone?.merged_into ? await mergeTarget(gone) : null;
  if (into) return { agent: into, merged: true, recruited: false };
  const role = gone?.role || task.role;
  return withAgentLock('replace', role, async () => {
    const best = pickReplacement(gone, task, await listAgents());
    if (best) return { agent: best, merged: false, recruited: false };
    const skills = gone?.skills?.length ? gone.skills.map((s) => s.name) : task.skills;
    return { agent: await createAgent({ role, title: gone?.title, skills }), merged: false, recruited: true };
  });
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Archive an agent and move its reports up to supervisorId. In the agent's 'claim' lane, so no task can start on it in
 * between. ready() is checked first in the lane: when it returns false nothing changes and the result is false. An
 * executive is never retired (false).
 */
export const retireAgent = (id, supervisorId, ready = () => true) => withAgentLock('claim', id, async () => {
  if ((await one(`SELECT role FROM agents WHERE id = $1`, [id]))?.role === 'executive') return false;
  if (!(await ready())) return false;
  await query(`UPDATE agents SET supervisor_id = $2 WHERE supervisor_id = $1`, [id, supervisorId]);
  await query(`UPDATE agents SET archived = true, status = 'offline' WHERE id = $1`, [id]);
  return true;
}).then(async (done) => {
  // Outside the lane, so a clone's republish never waits behind it. Clones that merged into it now resolve further up.
  if (done) await publishCloneTargets(id);
  return done;
});

// First live agent up the clone's chain: its source, or wherever an archived source was merged into (or cloned from).
export async function liveAncestor(clone) {
  return one(ancestorWalk('$1::uuid', '$2::uuid'), [clone.id, clone.cloned_from]);
}

// The original behind an agent: itself when it is not a clone, else the first live non-clone up its chain; null if none.
export async function originalOf(agent) {
  for (let a = agent, seen = new Set(); a && !seen.has(a.id); a = await liveAncestor(a)) {
    if (a.origin !== 'cloned') return a;
    seen.add(a.id);
  }
  return null;
}

/**
 * Merge (return) an idle clone into its original: what it learned since it was copied is added to the original,
 * its experiences move over, and the clone is archived with merged_into set.
 * Lanes: the clone's 'claim' (no task can start on it meanwhile) and 'learn' lanes, then the original's 'learn'
 * lane, so a task the original finishes at the same moment loses nothing. Always clone before ancestor. All of it runs in
 * the role's 'merge-role' lane, shared with consolidateRole(), whose keeper may be a clone of its source: no deadlock.
 */
export async function mergeAgent(cloneId, { actor = 'user', why = '' } = {}) {
  const found = await getAgent(cloneId);
  if (!found) throw httpError(404, 'Not found');
  if (found.origin !== 'cloned') throw httpError(400, 'Only clones can be merged');
  const { clone, target, merged, projects, memberProjects } = await withAgentLock('merge-role', found.role, () => withAgentLock('claim', found.id, () => withAgentLock('learn', found.id, async () => {
    const c = await one(`SELECT a.*, EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running') AS running FROM agents a WHERE a.id = $1`, [found.id]);
    if (c.archived) throw httpError(409, c.merged_into ? 'This clone was already merged' : 'Agent is archived');
    if (c.running || c.status === 'working') throw httpError(409, 'Agent is working');
    for (;;) {
      const up = await liveAncestor(c);
      if (!up) throw httpError(409, 'No live original to merge into');
      const done = await withAgentLock('learn', up.id, () => absorb(c.id, up.id));
      if (done) return done; // null: that original was archived meanwhile, look further up
    }
  })));
  await evolutionEvent('merge', target.id, `${clone.name} merged back into ${target.name}`, { clone: clone.id, cloneName: clone.name, ...merged });
  await notify({ source_type: 'admin', source_name: 'Admin', agent_id: target.id, level: 'success', title: `Merged ${clone.name} into ${target.name}`,
    body: `${why}+${merged.xp} XP · ${merged.skills} skills · ${merged.lessons} lessons${merged.playbookVersion ? ` · playbook v${merged.playbookVersion}` : ''}` });
  await audit(actor, 'agent.merge', clone.name, { into: target.name, intoId: target.id, ...merged, ...(clone.lease_mission_id ? { missionId: clone.lease_mission_id } : {}) });
  emit('agent:delete', { id: clone.id });
  await publishCloneTargets(clone.id);
  for (const id of memberProjects) await publishMembers(id).catch(() => {});
  // projects: those the clone managed, now managed by the original (the caller publishes them).
  return { agent: await publishAgent(target.id), merged, projects };
}

const mergeWaits = new Map(); // missionId -> retry timer while a leased clone still runs a task

/**
 * The mission is over: merge each live clone leased to it (lease_mission_id) into its original with mergeAgent(), and
 * call onMerged(cloneId, result) after each merge (the engine hands the clone's pending work over and publishes its
 * projects). A clone that still runs a task (or reads 'working') is retried every retryMs until it is idle, merged or
 * archived; it is never merged while a task runs (mergeAgent re-checks in the clone's 'claim' lane). Executive clones,
 * clones without a lease and clones with no live original are left alone. ids: clones
 * leased to it whose lease_mission_id may be gone (its project was deleted). Returns { merged: [ids], waiting: [ids] }.
 */
export async function mergeMissionClones(missionId, { ids = [], onMerged = async () => {}, retryMs = 2000 } = {}) {
  clearTimeout(mergeWaits.get(missionId));
  mergeWaits.delete(missionId);
  const clones = await many(
    `SELECT a.id, a.name, EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running') AS running
     FROM agents a WHERE (a.lease_mission_id = $1 OR a.id = ANY($2::uuid[])) AND a.origin = 'cloned' AND NOT a.archived AND a.role <> 'executive' ORDER BY a.created_at, a.id`, [missionId, ids]);
  const merged = [];
  const waiting = [];
  for (const c of clones) {
    if (c.running) { waiting.push(c.id); continue; }
    try {
      const out = await mergeAgent(c.id, { actor: 'system', why: 'Mission finished · ' });
      merged.push(c.id);
      await onMerged(c.id, out);
    } catch (e) {
      if (e.status === 409 && e.message === 'Agent is working') {
        await refreshAgentStatus(c.id); // a stale 'working' with no running task clears here
        waiting.push(c.id);
      } else if (e.status) console.error('[lease-merge]', c.name, e.message); // archived, or no live original: leave it
      else throw e;
    }
  }
  if (waiting.length) {
    const timer = setTimeout(() => {
      if (mergeWaits.get(missionId) !== timer) return;
      mergeWaits.delete(missionId);
      mergeMissionClones(missionId, { ids, onMerged, retryMs }).catch((e) => console.error('[lease-merge]', e.message));
    }, retryMs);
    timer.unref?.();
    mergeWaits.set(missionId, timer);
  }
  return { merged, waiting };
}

// One transaction: the target gains the source's learning, experiences, reports and GM projects, and the source is retired.
// The source is a clone merging into its original, or any agent of the target's role being consolidated into it.
async function absorb(sourceId, targetId) {
  const settings = await getSettings();
  const db = await pool.connect();
  let source, target, gained, moved, projects, memberProjects;
  try {
    await db.query('BEGIN');
    const rows = (await db.query(`SELECT * FROM agents WHERE id = ANY($1) FOR UPDATE`, [[sourceId, targetId]])).rows;
    source = rows.find((r) => r.id === sourceId);
    target = rows.find((r) => r.id === targetId);
    if (source.archived) throw httpError(409, 'Agent is archived');
    if (!target || target.archived) { await db.query('ROLLBACK'); return null; }
    if (source.role !== target.role) throw httpError(409, 'Only agents of the same role can be merged');
    // Only a clone of the executive may fold back into it; the executive itself is never merged away.
    if (source.role === 'executive' && source.origin !== 'cloned') throw httpError(409, 'The executive agent cannot be merged');
    const m = combineLearning(target, source);
    gained = m.gained;
    await db.query(`UPDATE agents SET xp=$2, level=$3, skills=$4, stats=stats || $5, updated_at=now() WHERE id=$1`, [target.id, m.xp, m.level, JSON.stringify(m.skills), m.stats]);
    moved = (await db.query(`UPDATE experiences SET agent_id = $2 WHERE agent_id = $1 AND kind IN ('lesson', 'failure') RETURNING kind`, [source.id, target.id])).rows;
    // Reports move to the target (which itself falls back to the source's supervisor if it reported to the source).
    await db.query(`UPDATE agents SET supervisor_id = CASE WHEN id = $2 THEN NULLIF($3::uuid, $2) ELSE $2 END, updated_at=now() WHERE supervisor_id = $1`, [source.id, target.id, source.supervisor_id]);
    // Projects the source managed get the target as General Manager, in the same step that retires the source.
    projects = (await db.query(`UPDATE projects SET manager_id = $2, updated_at = now() WHERE manager_id = $1 RETURNING id`, [source.id, target.id])).rows.map((r) => r.id);
    // Project memberships move to the target; where both are members it stays active if either was, except that an
    // 'auto' membership (e.g. a leased clone's) never re-activates a target the user released from that project.
    memberProjects = (await db.query(`WITH moved AS (DELETE FROM project_members WHERE agent_id = $1 RETURNING *)
      INSERT INTO project_members(project_id, agent_id, status, added_by, added_at, released_at)
      SELECT project_id, $2, status, added_by, added_at, released_at FROM moved
      ON CONFLICT (project_id, agent_id) DO UPDATE SET
        status = CASE WHEN EXCLUDED.status = 'active' AND (project_members.status = 'active' OR EXCLUDED.added_by = 'user') THEN 'active' ELSE project_members.status END,
        released_at = CASE WHEN EXCLUDED.status = 'active' AND (project_members.status = 'active' OR EXCLUDED.added_by = 'user') THEN NULL ELSE project_members.released_at END
      RETURNING project_id`, [source.id, target.id])).rows.map((r) => r.project_id);
    await db.query(`UPDATE agents SET archived=true, status='offline', merged_into=$2, current_task_id=NULL, updated_at=now() WHERE id=$1`, [source.id, target.id]);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
  const playbookVersion = await mergePlaybooks(target, source, settings);
  const lessons = moved.filter((r) => r.kind === 'lesson').length;
  return { clone: source, target, projects, memberProjects, merged: { skills: gained.skills, xp: gained.xp, lessons, failures: moved.length - lessons, playbookVersion } };
}

// Roles the organization itself runs on (direction, evolution, project GMs): never consolidated.
export const SYSTEM_ROLES = new Set(['executive', 'evolution', 'analyst', 'optimizer', 'manager']);

const busyReason = (a) => (a.running ? 'Has a running task' : a.status === 'working' ? 'Agent is working' : null);

/**
 * Who a consolidation of role keeps and folds in. keeper: keeperId (a live agent of the role), else the live agent of
 * the role with the highest level, then XP, then the oldest. sources: every other live agent of the role, oldest first
 * (the fold order), each with running (has a running task). SELECT-only.
 */
async function consolidatePlan(role, keeperId) {
  const r = String(role ?? '').trim().toLowerCase();
  if (!r) throw httpError(400, 'Role is required');
  if (SYSTEM_ROLES.has(r)) throw httpError(400, `${roleInfo(r).title} agents cannot be consolidated`);
  const rows = await many(
    `SELECT a.*, EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running') AS running
     FROM agents a WHERE a.role = $1 AND NOT a.archived ORDER BY a.level DESC, a.xp DESC, a.created_at, a.id`, [r]);
  const keeper = keeperId ? rows.find((a) => a.id === keeperId) : rows[0];
  if (!keeper) throw httpError(keeperId ? 400 : 404, keeperId ? `The keeper must be a live ${r} agent` : `No live ${r} agents`);
  const sources = rows.filter((a) => a.id !== keeper.id).sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  return { role: r, keeper, sources };
}

/**
 * Read-only preview of consolidateRole(): the same keeper, merged and skipped sets, with what each source would add
 * (the combineLearning fold in order, the lessons and failures it moves, the playbook version a change would get).
 * result: the keeper's XP, level, skills and playbook version afterwards.
 */
export async function previewConsolidate(role, { keeperId = null } = {}) {
  const { keeper, sources } = await consolidatePlan(role, keeperId);
  const settings = await getSettings();
  const exps = await many(`SELECT agent_id, kind, content, score FROM experiences WHERE agent_id = ANY($1) AND kind IN ('lesson', 'failure')`, [[keeper.id, ...sources.map((s) => s.id)]]);
  const lessonsOf = (id) => exps.filter((e) => e.agent_id === id && e.kind === 'lesson');
  let t = keeper;
  let lessons = lessonsOf(keeper.id);
  const merged = [];
  const skipped = [];
  for (const s of sources) {
    const reason = busyReason(s);
    if (reason) { skipped.push({ id: s.id, name: s.name, reason }); continue; }
    const m = combineLearning(t, s);
    const own = lessonsOf(s.id);
    lessons = [...lessons, ...own];
    const playbook = foldPlaybooks(t.playbook || [], s.playbook || [], lessons, settings.evolution?.playbookSize || 8);
    t = { ...t, xp: m.xp, level: m.level, skills: m.skills, stats: { ...t.stats, ...m.stats }, playbook: playbook || t.playbook, prompt_version: t.prompt_version + (playbook ? 1 : 0) };
    const failures = exps.filter((e) => e.agent_id === s.id && e.kind === 'failure').length;
    merged.push({ id: s.id, name: s.name, xp: m.gained.xp, skills: m.gained.skills, lessons: own.length, failures, playbookVersion: playbook ? t.prompt_version : null });
  }
  return { keeper: await getAgent(keeper.id), merged, skipped, result: { xp: t.xp, level: t.level, skills: t.skills, prompt_version: t.prompt_version } };
}

/**
 * Fold every other live agent of role into one keeper (see consolidatePlan), one source at a time, each like a clone
 * merge: absorb() moves its learning, experiences, reports and GM projects, merges playbooks and archives it with
 * merged_into = keeper. A source that is working or has a running task is skipped with a reason. Lanes per source, in
 * mergeAgent()'s order: its 'claim', its 'learn', then the keeper's 'learn'; the whole run holds the role's
 * 'merge-role' lane, so two consolidations (or a clone merge) of one role never take each other's lanes in reverse.
 * Returns { keeper, merged, skipped, projects }; the caller publishes projects and hands the merged sources' pending
 * work over (they resolve to the keeper through merged_into).
 */
export async function consolidateRole(role, { keeperId = null } = {}) {
  const r = (await consolidatePlan(role, keeperId)).role; // refuse before queueing behind the lane
  const out = await withAgentLock('merge-role', r, async () => {
    const { keeper, sources } = await consolidatePlan(r, keeperId);
    const merged = [];
    const skipped = [];
    const projects = new Set();
    for (const s of sources) {
      const done = await withAgentLock('claim', s.id, () => withAgentLock('learn', s.id, async () => {
        const c = await one(`SELECT a.*, EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'running') AS running FROM agents a WHERE a.id = $1`, [s.id]);
        if (!c || c.archived) return { reason: 'Agent is archived' };
        const reason = busyReason(c);
        if (reason) return { reason };
        try {
          return (await withAgentLock('learn', keeper.id, () => absorb(c.id, keeper.id))) || { reason: `${keeper.name} was archived` };
        } catch (e) {
          if (e.status) return { reason: e.message }; // refused inside the transaction (rolled back): leave it as it is
          throw e;
        }
      }));
      if (done.reason) { skipped.push({ id: s.id, name: s.name, reason: done.reason }); continue; }
      const { xp, skills, lessons, failures, playbookVersion } = done.merged;
      merged.push({ id: s.id, name: s.name, xp, skills, lessons, failures, playbookVersion });
      for (const id of done.projects) projects.add(id);
      await evolutionEvent('merge', keeper.id, `${s.name} consolidated into ${keeper.name}`, { source: s.id, sourceName: s.name, origin: s.origin, consolidate: r, ...done.merged });
      emit('agent:delete', { id: s.id });
      await publishCloneTargets(s.id);
      for (const id of done.memberProjects) await publishMembers(id).catch(() => {});
    }
    return { keeper, merged, skipped, projects: [...projects] };
  });
  const { keeper, merged, skipped } = out;
  const total = (k) => merged.reduce((n, m) => n + m[k], 0);
  const totals = { xp: total('xp'), skills: total('skills'), lessons: total('lessons'), failures: total('failures') };
  if (merged.length) {
    await notify({ source_type: 'admin', source_name: 'Admin', agent_id: keeper.id, level: 'success', title: `Consolidated ${merged.length} ${roleInfo(r).title} agent${merged.length === 1 ? '' : 's'} into ${keeper.name}`,
      body: `+${totals.xp} XP · ${totals.skills} skills · ${totals.lessons} lessons · ${totals.failures} failures${skipped.length ? ` · ${skipped.length} skipped` : ''}` });
  }
  await audit('user', 'agent.consolidate', keeper.name, { role: r, keeperId: keeper.id, merged: merged.map((m) => ({ id: m.id, name: m.name })), skipped, ...totals });
  return { keeper: await publishAgent(keeper.id), merged, skipped, projects: out.projects };
}
