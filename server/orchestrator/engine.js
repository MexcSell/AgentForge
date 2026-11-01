import path from 'node:path';
import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import { emit } from '../events.js';
import { getSettings } from '../db/seed.js';
import { normalizeRole, roleInfo } from '../roles.js';
import { getAgent, listAgents, createAgent, cloneAgent, publishAgent, refreshAgentStatus, withAgentLock, replacementFor, pickReplacement, mergeTarget, originalOf, mergeMissionClones } from '../services/agents.js';
import { getProject, publishProject, setProjectStatus } from '../services/projects.js';
import { getTopic, createTopic, updateTopic, touchTopic, ensureTopic, publishTopic } from '../services/topics.js';
import { notify, audit } from '../services/notify.js';
import { ensureMembers, memberStanding } from '../services/members.js';
import { syncProject, touchedFiles, repoPaths } from '../services/git.js';
import { PROVIDERS, resolveModel, runModel, recordRunUsage, publishModels } from '../models/index.js';
import { heuristicPlan, topicTitle, topicSummary } from './heuristics.js';
import { planPrompt, taskPrompt, commitPrompt, digestPrompt, triagePrompt, parseJson, topicContext, inflightContext } from './prompts.js';
import { learn, analyzeMission } from './evolution.js';

// Missions run in per-topic lanes: one at a time per topic (FIFO), different topics in parallel with no project-wide
// cap. The lane is the mission's topic at submit time.
const active = new Map(); // missionId -> { projectId, topicId (lane), mission, controller, tasks (planned), phase ('done' once it will commit nothing more) }
const queues = new Map(); // projectId -> [mission], oldest first
const liveRuns = new Map(); // runId -> { agentId, taskId }

// File leases between missions of one project (one working tree). A running write task holds the files its plan declared
// plus every file it was seen editing; none declared = exclusive. A write task of another mission whose files overlap
// waits, still pending, until a task of the project finishes. Only running tasks hold leases, so waiting can't deadlock;
// tasks of one mission are never checked against each other (depends_on orders those).
const leases = new Map(); // taskId -> { projectId, missionId, mission, key, files: [path] | null, live: Set<path> }
const finishes = new Map(); // projectId -> { promise, resolve }: settles when the next task of the project finishes
const sweeps = new Set(); // projectIds whose scoped sync left changes for the last mission to commit

const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const leased = (l) => [...new Set([...(l.files || []), ...l.live])];

/** Other missions' running write tasks that a write task declaring `files` would collide with. */
function blockersOf(projectId, missionId, files) {
  return [...leases.values()].filter((l) => l.projectId === projectId && l.missionId !== missionId
    && (!files?.length || !l.files || files.some((f) => leased(l).some((p) => overlaps(f, p)))));
}

/** Takes the task's lease (write roles only) unless it collides; returns the colliding leases. Check and take are one step. */
function lease(projectId, mission, t) {
  if (roleInfo(t.role).access !== 'write') return [];
  const found = blockersOf(projectId, mission.id, t.files);
  if (!found.length) leases.set(t.id, { projectId, missionId: mission.id, mission, key: t.key, files: t.files?.length ? t.files : null, live: new Set() });
  return found;
}

/** A task of the project finished: drop its lease and wake every task waiting for one. */
function taskFinished(projectId, taskId) {
  leases.delete(taskId);
  const f = finishes.get(projectId);
  if (f) { finishes.delete(projectId); f.resolve(); }
}

function nextFinish(projectId) {
  if (!finishes.has(projectId)) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    finishes.set(projectId, { promise, resolve });
  }
  return finishes.get(projectId).promise;
}

/** 'T2 waits for <topic> · T3 (server/foo.js) to avoid editing the same files.' */
async function waitText(t, found) {
  const parts = [];
  for (const l of found.slice(0, 3)) {
    const topic = await getTopic(l.mission.topic_id).catch(() => null);
    const paths = l.files ? leased(l).filter((p) => !t.files?.length || t.files.some((f) => overlaps(f, p))) : [];
    const shown = paths.length ? `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3}` : ''}` : 'files not declared';
    parts.push(`${topic?.title || 'another topic'} · ${l.key} (${shown})`);
  }
  return `${t.key} waits for ${parts.join(', ')}${found.length > 3 ? ` and ${found.length - 3} more` : ''} to avoid editing the same files.`;
}

/** Repo-relative files that these missions' runs edited or that their running tasks lease now. */
async function filesOf(project, missions) {
  const out = new Set();
  for (const a of missions) {
    for (const f of await touchedFiles(a.mission.id, project.path)) out.add(f);
    for (const l of leases.values()) if (l.missionId === a.mission.id) for (const f of leased(l)) out.add(f);
  }
  return [...out];
}

export function busyState() {
  return { missions: active.size, runs: liveRuns.size, busy: active.size > 0 || liveRuns.size > 0 };
}

// ---- messages ------------------------------------------------------------

// Without an explicit topic_id a mission's messages land in the mission's current topic.
export async function postMessage({ project_id, mission_id = null, topic_id = null, author_type, agent_id = null, kind = 'chat', content = '', attachments = [], meta = {} }) {
  if (!topic_id && mission_id) topic_id = (await one(`SELECT topic_id FROM missions WHERE id = $1`, [mission_id]))?.topic_id || null;
  const row = await one(
    `INSERT INTO messages(project_id, mission_id, topic_id, author_type, agent_id, kind, content, attachments, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [project_id, mission_id, topic_id, author_type, agent_id, kind, content, JSON.stringify(attachments), meta],
  );
  if (topic_id) await touchTopic(topic_id);
  const full = await one(`SELECT m.*, a.name AS agent_name, a.role AS agent_role, a.title AS agent_title FROM messages m LEFT JOIN agents a ON a.id = m.agent_id WHERE m.id = $1`, [row.id]);
  emit('message:new', full);
  return full;
}

async function publishTask(id) {
  const t = await one(`SELECT t.*, a.name AS agent_name, a.role AS agent_role FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.id = $1`, [id]);
  if (t) emit('task:update', t);
  return t;
}

async function publishMission(id) {
  const m = await one(`SELECT * FROM missions WHERE id = $1`, [id]);
  if (m) emit('mission:update', m);
  return m;
}

// running_agents follows every task and GM status change; a failed publish never blocks or fails the mission.
function refreshProject(id) {
  publishProject(id).catch(() => {});
}

// ---- runs ----------------------------------------------------------------

// timeoutMs overrides the task timeout and is also a hard deadline for providers that ignore it (HTTP, simulator).
async function executeRun({ kind, agent, project, mission, task, model, prompt, system, access, attachments, signal, meta, timeoutMs = null }) {
  const run = await one(
    `INSERT INTO runs(task_id, mission_id, agent_id, project_id, model_id, kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [task?.id || null, mission?.id || null, agent.id, project.id, model.id, kind],
  );
  liveRuns.set(run.id, { agentId: agent.id, taskId: task?.id });
  emit('run:start', { ...run, agent_name: agent.name });
  const held = task && leases.get(task.id);
  const onEvent = (e) => {
    if (held && Array.isArray(e.files)) for (const f of repoPaths(project.path, e.files)) held.live.add(f); // seen editing: part of its lease
    const data = { ...e };
    delete data.type;
    query(`INSERT INTO run_events(run_id, type, data) VALUES ($1,$2,$3)`, [run.id, e.type, data]).catch(() => {});
    emit('run:event', { run_id: run.id, agent_id: agent.id, task_id: task?.id || null, project_id: project.id, type: e.type, data, ts: Date.now() });
  };
  const images = (attachments || []).map((a) => a.path).filter(Boolean);
  const settings = await getSettings();
  const deadline = timeoutMs ? AbortSignal.timeout(timeoutMs + 5000) : null;
  try {
    const out = await runModel(model, {
      prompt, system, cwd: project.path, access, images, addDirs: images.length ? [config.uploadsDir] : [],
      signal: deadline ? AbortSignal.any([signal, deadline].filter(Boolean)) : signal, onEvent,
      timeoutMs: timeoutMs || (settings.orchestrator.taskTimeoutMin || 30) * 60000, meta,
    });
    await recordRunUsage(run.id, out);
    await query(`UPDATE runs SET status='done', output=$2, finished_at=now() WHERE id=$1`, [run.id, String(out.text || '').slice(0, 200000)]);
    await bumpAgentStats(agent.id, out);
    return { ...out, runId: run.id };
  } catch (err) {
    if (deadline?.aborted && !signal?.aborted) err = Object.assign(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`), { partial: err.partial });
    await recordRunUsage(run.id, err.partial);
    await query(`UPDATE runs SET status=$2, error=$3, finished_at=now() WHERE id=$1`, [run.id, signal?.aborted ? 'cancelled' : 'failed', err.message]);
    if (err.partial) await bumpAgentStats(agent.id, err.partial);
    onEvent({ type: 'error', text: err.message });
    throw err;
  } finally {
    liveRuns.delete(run.id);
    emit('run:end', { id: run.id, agent_id: agent.id });
    publishModels().catch(() => {});
  }
}

async function bumpAgentStats(agentId, out) {
  const tools = Object.values(out.toolCalls || {}).reduce((a, b) => a + b, 0);
  await query(
    `UPDATE agents SET stats = stats || jsonb_build_object(
        'prompts', coalesce((stats->>'prompts')::int, 0) + 1,
        'tokensIn', coalesce((stats->>'tokensIn')::bigint, 0) + $2,
        'tokensOut', coalesce((stats->>'tokensOut')::bigint, 0) + $3,
        'toolCalls', coalesce((stats->>'toolCalls')::int, 0) + $4,
        'totalMs', coalesce((stats->>'totalMs')::bigint, 0) + $5,
        'costUsd', coalesce((stats->>'costUsd')::numeric, 0) + $6)
     WHERE id = $1`,
    [agentId, out.usage?.input || 0, out.usage?.output || 0, tools, out.durationMs || 0, out.costUsd || 0],
  );
}

// ---- commands ------------------------------------------------------------

export async function submitCommand(projectId, { content, attachments = [], topicId = null }) {
  const project = await getProject(projectId);
  if (!project) throw new Error('project not found');
  const topic = await ensureTopic(projectId, topicId);
  const text = String(content || '').trim();
  const userMsg = await postMessage({ project_id: projectId, topic_id: topic.id, author_type: 'user', content: text, attachments });

  const slash = text.match(/^\/(\w+)/)?.[1]?.toLowerCase();
  if (slash === 'stop') { await cancelMission(projectId, topic.id); return userMsg; }
  if (slash === 'standup') { await standup(projectId, topic.id); return userMsg; }
  if (slash === 'sync') { await syncNow(projectId, 'Manual sync', topic.id); return userMsg; }

  const mission = await one(`INSERT INTO missions(project_id, command, topic_id) VALUES ($1,$2,$3) RETURNING *`, [projectId, text, topic.id]);
  await query(`UPDATE messages SET mission_id = $2 WHERE id = $1`, [userMsg.id, mission.id]);
  mission.attachments = attachments;
  queues.set(projectId, [...(queues.get(projectId) || []), mission]);
  pump(projectId);
  // Started right away (in parallel with other topics): nothing to say. Only a busy topic makes an order wait.
  const waiting = queues.get(projectId) || [];
  if (waiting.includes(mission)) {
    const content = `Queued. I will start this after the current mission in this topic (${waiting.filter((m) => m.topic_id === topic.id).length} waiting here).`;
    await postMessage({ project_id: projectId, mission_id: mission.id, author_type: 'agent', agent_id: project.manager_id, kind: 'status', content });
  }
  return userMsg;
}

const activeIn = (projectId) => [...active.values()].filter((a) => a.projectId === projectId);

// A mission that assignTopic moves to a fresh topic keeps its original lane until it finishes: later orders in the
// original topic still wait for it. Orders typed in the topic it moved to wait for it too, so a topic never runs two.
const inTopic = (a, topicId) => a.topicId === topicId || a.mission.topic_id === topicId;

/** Start every queued order that may run now: oldest first, never two in one topic. */
function pump(projectId) {
  const busy = new Set(activeIn(projectId).flatMap((a) => [a.topicId, a.mission.topic_id]));
  const waiting = [];
  for (const m of queues.get(projectId) || []) {
    if (busy.has(m.topic_id)) { waiting.push(m); continue; }
    busy.add(m.topic_id);
    start(projectId, m);
  }
  if (waiting.length) queues.set(projectId, waiting);
  else queues.delete(projectId);
}

function start(projectId, mission) {
  const controller = new AbortController();
  active.set(mission.id, { projectId, topicId: mission.topic_id, mission, controller });
  runMission(mission, controller.signal)
    .catch((err) => console.error('[mission]', err))
    .finally(async () => {
      active.delete(mission.id);
      pump(projectId);
      await settleProject(projectId).catch(() => {});
    });
}

/**
 * 'running' while a mission of the project is active; 'idle' (and the GM's status re-derived) once none is active and
 * nothing is queued. Decided when the write runs and serialized per project, so a mission starting while another
 * ends can never be left under an idle project.
 */
function settleProject(projectId) {
  // withAgentLock is a plain keyed lane; here it orders one project's status writes.
  return withAgentLock('project-status', projectId, async () => {
    if (activeIn(projectId).length) return setProjectStatus(projectId, 'running');
    if ((queues.get(projectId) || []).length) return;
    await setProjectStatus(projectId, 'idle');
    const p = await one(`SELECT manager_id FROM projects WHERE id = $1`, [projectId]);
    if (p?.manager_id) await refreshAgentStatus(p.manager_id);
  });
}

/**
 * topicId (where /stop was typed, or the API's topic_id): stop only that topic's mission and drop only its queued
 * orders. Without it every mission of the project stops and the whole queue is dropped (e.g. project delete).
 */
export async function cancelMission(projectId, topicId = null) {
  const stopping = activeIn(projectId).filter((a) => !topicId || inTopic(a, topicId));
  const q = queues.get(projectId) || [];
  const dropped = q.filter((m) => !topicId || m.topic_id === topicId);
  const kept = q.filter((m) => !dropped.includes(m));
  if (kept.length) queues.set(projectId, kept);
  else queues.delete(projectId);
  for (const a of stopping) a.controller.abort();
  const project = await getProject(projectId);
  const say = async (topic_id, mission_id, content) => postMessage({ project_id: projectId, mission_id, topic_id, author_type: 'agent', agent_id: project?.manager_id, kind: 'status', content });

  // Dropped orders never started: close them so their topics stop showing a running mission.
  if (dropped.length) {
    await query(`UPDATE missions SET status='cancelled', summary='Cancelled before it started', finished_at=now() WHERE id = ANY($1::uuid[]) AND status = 'planning'`, [dropped.map((m) => m.id)]);
    for (const m of dropped) await publishMission(m.id);
    for (const id of new Set(dropped.map((m) => m.topic_id))) await publishTopic(id).catch(() => {});
  }
  const queued = dropped.length ? ` ${dropped.length} queued order${dropped.length === 1 ? '' : 's'} dropped.` : '';
  if (!stopping.length) {
    const here = (await ensureTopic(projectId, topicId)).id;
    await say(here, null, `${topicId ? 'Nothing is running in this topic.' : 'Nothing is running.'}${queued}`);
    return dropped.length > 0;
  }
  if (topicId) {
    // mission_id stays off a reply posted where /stop was typed, so mission messages always share the mission's topic.
    await say((await ensureTopic(projectId, topicId)).id, null, `Stopping all agents on this mission.${queued}`);
  } else {
    for (const a of stopping) await say(null, a.mission.id, 'Stopping all agents on this mission.');
  }
  return true;
}

// ---- planning & staffing -------------------------------------------------

// Context is scoped to the mission's topic: a brand-new topic sends no prior missions at all.
async function plan({ project, gm, mission, topic, history, signal }) {
  const agents = await listAgents();
  const standing = await memberStanding(project.id);
  const model = await resolveModel(gm.model_id);
  const inflight = inflightContext(await inflightMissions(project.id, mission.id));
  const { system, prompt } = planPrompt({ project, gm, command: mission.command, attachments: mission.attachments, agents, standing, topic: topicContext(topic, history), inflight });
  let parsed = null;
  let out = null;
  try {
    out = await executeRun({ kind: 'plan', agent: gm, project, mission, model, prompt, system, access: 'read', attachments: mission.attachments, signal, meta: { kind: 'plan', command: mission.command } });
    parsed = parseJson(out.text);
  } catch (err) {
    if (signal.aborted) throw err;
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'system', kind: 'error', content: `Planner model failed: ${err.message}\nFalling back to the built-in planner.` });
  }
  if (!parsed || !Array.isArray(parsed.tasks)) {
    if (out && !parsed && out.text && !/```/.test(out.text) && out.text.length < 4000) {
      return { analysis: '', reply: out.text, tasks: [] };
    }
    parsed = heuristicPlan(mission.command);
  }
  return parsed;
}

/** The project's other active missions, for the planner: topic, order and tasks with status and declared files. */
async function inflightMissions(projectId, missionId) {
  const others = activeIn(projectId).filter((a) => a.mission.id !== missionId);
  if (!others.length) return [];
  const ids = others.map((a) => a.mission.id);
  const topics = await many(`SELECT m.id, t.title FROM missions m LEFT JOIN topics t ON t.id = m.topic_id WHERE m.id = ANY($1::uuid[])`, [ids]);
  const rows = await many(`SELECT mission_id, key, title, role, status FROM tasks WHERE mission_id = ANY($1::uuid[]) AND origin <> 'proposal' ORDER BY created_at`, [ids]);
  return others.map((a) => {
    const declared = new Map((a.tasks || []).map((t) => [t.key, t.files || []]));
    const tasks = rows.filter((t) => t.mission_id === a.mission.id).map((t) => ({ ...t, files: declared.get(t.key) || [] }));
    return { topic: topics.find((t) => t.id === a.mission.id)?.title, order: a.mission.command, tasks };
  });
}

/**
 * Keep the topic's key-word title and summary current, or move a clearly unrelated order (and its mission) into a new
 * topic. Every mission refreshes the summary; the title follows the planner's key words unless a human locked it.
 */
async function assignTopic({ project, gm, mission, topic, history, p, settings }) {
  const t = p.topic && typeof p.topic === 'object' ? p.topic : {};
  const proposed = topicTitle(t.title);
  const title = proposed || topicTitle(mission.command);
  const tags = Array.isArray(t.tags) ? t.tags.slice(0, 3) : undefined;
  const summary = typeof t.summary === 'string' && t.summary.trim() ? t.summary : null;
  if (!history.length || t.new !== true || settings.orchestrator.autoTopics === false) {
    const cur = (await getTopic(topic.id)) || topic; // a human may have renamed (locked) it while this order was planned
    const untitled = !history.length || cur.title === 'New topic';
    const patch = { summary: summary || cur.summary || topicSummary(mission.command) };
    if (!cur.title_locked && (untitled || (proposed && proposed !== cur.title))) Object.assign(patch, { title: untitled ? title : proposed, tags });
    await updateTopic(cur.id, patch);
    return;
  }
  const fresh = await createTopic({ project_id: project.id, title, tags, summary: summary || topicSummary(mission.command) });
  await query(`UPDATE missions SET topic_id = $2 WHERE id = $1`, [mission.id, fresh.id]);
  const moved = await many(`UPDATE messages SET topic_id = $2 WHERE mission_id = $1 RETURNING id`, [mission.id, fresh.id]);
  mission.topic_id = fresh.id; // it keeps its original lane (the topic it was submitted in) until it finishes; see inTopic()
  emit('topic:new', { ...(await getTopic(fresh.id)), moved_from: topic.id, mission_id: mission.id });
  emit('topic:moved', { project_id: project.id, mission_id: mission.id, moved_from: topic.id, topic_id: fresh.id, message_ids: moved.map((m) => m.id) });
  await postMessage({ project_id: project.id, topic_id: topic.id, author_type: 'agent', agent_id: gm.id, kind: 'status', content: `Continued in new topic: ${fresh.title}`, meta: { topic_id: fresh.id } });
  await publishTopic(topic.id);
}

/** A task's declared files: up to 20 repo-relative paths or directories; absolute paths and `..` segments are dropped. */
function declaredFiles(list) {
  const out = new Set();
  for (const f of Array.isArray(list) ? list : []) {
    if (typeof f !== 'string' || f.includes('\0')) continue;
    const p = path.posix.normalize(f.trim() || '.').replace(/\/+$/, '');
    if (p && p !== '.' && p.length <= 300 && !path.posix.isAbsolute(p) && !p.split('/').includes('..')) out.add(p);
  }
  return [...out].slice(0, 20);
}

function normalizeTasks(raw, settings) {
  const tasks = (raw || []).slice(0, 20).map((t, i) => {
    const files = declaredFiles(t.files); // kept in missions.plan; the file leases use it
    return {
      key: String(t.key || `T${i + 1}`).slice(0, 12),
      title: String(t.title || `Task ${i + 1}`).slice(0, 200),
      description: String(t.description || t.title || '').slice(0, 4000),
      role: normalizeRole(t.role),
      skills: (Array.isArray(t.skills) ? t.skills : []).map((s) => String(s).toLowerCase()).slice(0, 8),
      acceptance: (Array.isArray(t.acceptance) ? t.acceptance : []).map(String).slice(0, 10),
      depends_on: (Array.isArray(t.depends_on) ? t.depends_on : []).map(String),
      ...(files.length ? { files } : {}),
    };
  });
  const keys = new Set(tasks.map((t) => t.key));
  for (const t of tasks) t.depends_on = t.depends_on.filter((k) => keys.has(k) && k !== t.key);
  // Independent verification: code-changing work must be checked by someone else.
  const writes = tasks.filter((t) => roleInfo(t.role).access === 'write' && !['qa'].includes(t.role));
  if (settings.orchestrator.verification && writes.length && !tasks.some((t) => ['reviewer', 'qa'].includes(t.role))) {
    tasks.push({ key: `T${tasks.length + 1}`, title: 'Independent verification', description: 'Verify every upstream task against its acceptance criteria. Run available tests/builds. Report any gaps.', role: 'reviewer', skills: ['code-review'], acceptance: ['Each upstream acceptance criterion checked with evidence'], depends_on: tasks.map((t) => t.key) });
  }
  return tasks;
}

function ancestors(tasks) {
  const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
  const memo = {};
  const walk = (k, seen = new Set()) => {
    if (memo[k]) return memo[k];
    const out = new Set();
    for (const d of byKey[k]?.depends_on || []) {
      if (seen.has(d)) continue;
      seen.add(d);
      out.add(d);
      for (const x of walk(d, seen)) out.add(x);
    }
    return (memo[k] = out);
  };
  return (a, b) => walk(a).has(b) || walk(b).has(a);
}

function skillScore(agent, task) {
  const map = Object.fromEntries(agent.skills.map((s) => [s.name, s.level]));
  return task.skills.reduce((sum, s) => sum + (map[s] || 0), 0) + agent.level * 3 + (agent.status === 'idle' ? 15 : 0);
}

// Staffing score in a project: skillScore plus a small bonus for its active members, so with comparable skills the team
// keeps the work. standing: memberStanding(projectId).
const MEMBER_BONUS = 5;
const staffScore = (agent, task, standing) => skillScore(agent, task) + (standing?.get(agent.id) === 'active' ? MEMBER_BONUS : 0);

// missionId -> ids of the clones leased to it, so they still merge when a project delete nulls lease_mission_id first.
const leasedClones = new Map();

/**
 * A clone leased to mission for task t: of the original (the best live non-clone of the role, else the original behind
 * from), or of a newly recruited original that stays in reserve when the role has none. Returns { agent, src, recruited }.
 */
async function leaseClone(t, project, mission, from = null, standing = null) {
  const best = (await listAgents()).filter((a) => a.role === t.role && a.origin !== 'cloned').sort((a, b) => staffScore(b, t, standing) - staffScore(a, t, standing))[0];
  let src = (from && (await originalOf(from))) || best || null;
  const recruited = !src;
  if (recruited) src = await createAgent({ role: t.role, skills: t.skills?.length ? t.skills : undefined, mission: `Specialist recruited for ${project.name}: ${t.title}` });
  const agent = await cloneAgent(src.id, `${t.role} work in ${project.name} (leased to this mission)`, { leaseMissionId: mission.id });
  leasedClones.set(mission.id, (leasedClones.get(mission.id) || new Set()).add(agent.id));
  return { agent, src, recruited };
}

// The staffing note for a leased clone: which case it was (the role's originals busy, or none of the role at all).
const leaseNote = ({ agent, src, recruited }, t) => (recruited
  ? `Recruited ${src.name} as a new ${roleInfo(t.role).title} (kept in reserve) and cloned ${agent.name} for ${t.key}; the clone merges back when the mission ends`
  : `Cloned ${src.name} → ${agent.name} for ${t.key}: every ${roleInfo(t.role).title} is busy; the clone merges back into ${src.name} when the mission ends`);

async function notifyLease(lease, t, project, mission) {
  const { agent, src, recruited } = lease;
  await notify(recruited
    ? { source_type: 'manager', source_name: project.manager_name, project_id: project.id, agent_id: agent.id, level: 'success', title: `New agent ${src.name} · ${src.title} + clone ${agent.name}`, body: `No ${src.title} existed for "${t.title}": ${src.name} stays in reserve, ${agent.name} does the work and merges back when the mission ends` }
    : { source_type: 'manager', source_name: project.manager_name, project_id: project.id, agent_id: agent.id, title: `${agent.name} cloned from ${src.name}`, body: `Every ${src.title} is busy — for "${t.title}"; merges back into ${src.name} when the mission ends` });
}

/**
 * Pick, clone or recruit an agent for every task. (1) A live, idle original of the role (or a clone already leased to
 * this mission) that holds no unrelated task of this plan. (2) Else a clone of the role's best original, leased to the
 * mission. (3) With nobody of the role, a new original plus a leased clone of it. The executive is never cloned or
 * recruited here: its task waits for it. Agents released from the project are never picked (a clone of one may be);
 * active members win over comparable outsiders. Returns staffing notes for the chat.
 */
async function staff(tasks, project, mission) {
  const notes = [];
  const owned = new Map(); // agentId -> [taskKeys]
  const related = ancestors(tasks);
  const standing = await memberStanding(project.id);
  for (const t of tasks) {
    const all = (await listAgents()).filter((a) => a.role === t.role);
    const pool = all.filter((a) => standing.get(a.id) !== 'released').sort((a, b) => staffScore(b, t, standing) - staffScore(a, t, standing));
    let chosen = pool.find((a) => (a.origin !== 'cloned' || a.lease_mission_id === mission.id)
      && (owned.get(a.id) || []).every((k) => related(k, t.key)) && a.status !== 'working');
    // The executive is never recruited a second time: one released from this project still takes its own task.
    if (!chosen && t.role === 'executive') chosen = pool.find((a) => a.origin !== 'cloned') || pool[0] || all.find((a) => a.origin !== 'cloned') || all[0];
    if (!chosen && t.role === 'executive') {
      chosen = await createAgent({ role: t.role, skills: t.skills.length ? t.skills : undefined, mission: `Specialist recruited for ${project.name}: ${t.title}` });
      notes.push(`Recruited new agent ${chosen.name} (${chosen.title})`);
    }
    if (!chosen) {
      const lease = await leaseClone(t, project, mission, null, standing);
      chosen = lease.agent;
      notes.push(leaseNote(lease, t));
      await notifyLease(lease, t, project, mission);
    }
    owned.set(chosen.id, [...(owned.get(chosen.id) || []), t.key]);
    t.agent_id = chosen.id;
    t.agent_name = chosen.name;
  }
  return notes;
}

/**
 * Mission over (done, failed, cancelled, or found finished on boot): merge its leased clones into their originals. A
 * merged clone's pending work elsewhere is handed over and the projects it managed are republished.
 */
function mergeLeases(missionId) {
  const ids = [...(leasedClones.get(missionId) || [])];
  leasedClones.delete(missionId);
  return mergeMissionClones(missionId, {
    ids,
    onMerged: async (cloneId, out) => {
      for (const id of out.projects) await publishProject(id).catch(() => {});
      await handOver(cloneId).catch((e) => console.error('[handover]', e.message));
    },
  }).catch((e) => console.error('[lease-merge]', e.message));
}

// ---- mission -------------------------------------------------------------

async function runMission(mission, signal) {
  const settings = await getSettings();
  let project = await getProject(mission.project_id);
  const gm = await getAgent(project.manager_id);
  await settleProject(project.id); // 'running' while this mission is active
  await refreshAgentStatus(gm.id); // working: its project is running and this mission is planning
  refreshProject(project.id);
  const started = Date.now();
  try {
    await query(`UPDATE missions SET status='planning' WHERE id=$1`, [mission.id]);
    // The topic may have been deleted while this order waited in the queue.
    let topic = await getTopic(mission.topic_id);
    if (!topic) {
      topic = await ensureTopic(project.id);
      await query(`UPDATE missions SET topic_id=$2 WHERE id=$1`, [mission.id, topic.id]);
      mission.topic_id = topic.id;
    }
    await publishMission(mission.id);
    await publishTopic(topic.id);
    const history = await many(
      `SELECT command, status, summary FROM missions WHERE topic_id = $1 AND created_at < (SELECT created_at FROM missions WHERE id = $2) ORDER BY created_at DESC LIMIT 4`,
      [topic.id, mission.id]);
    const p = await plan({ project, gm, mission, topic, history, signal });
    await assignTopic({ project, gm, mission, topic, history, p, settings });
    const tasks = normalizeTasks(p.tasks, settings);
    const self = active.get(mission.id);
    if (self) self.tasks = tasks; // declared files for other topics' planners

    if (!tasks.length) {
      await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'chat', content: p.reply || p.analysis || 'Done.' });
      await query(`UPDATE missions SET status='done', plan=$2, summary=$3, finished_at=now() WHERE id=$1`, [mission.id, p, p.reply || '']);
      await publishMission(mission.id);
      return;
    }

    const notes = await staff(tasks, project, mission);
    const rows = [];
    for (const t of tasks) {
      const row = await one(
        `INSERT INTO tasks(project_id, mission_id, key, title, description, role, skills, acceptance, depends_on, agent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [project.id, mission.id, t.key, t.title, t.description, t.role, JSON.stringify(t.skills), JSON.stringify(t.acceptance), JSON.stringify(t.depends_on), t.agent_id],
      );
      if (t.files) row.files = t.files;
      rows.push(row);
    }
    // Staffed agents join the project as 'auto' members (a released one stays released); a membership error never stops the mission.
    await ensureMembers(project.id, rows.map((r) => r.agent_id)).catch((e) => console.error('[members]', e.message));
    // An agent archived between staff() and the INSERT is handed over here (the mission is still 'planning', so
    // pendingOf() sees these rows); one archived after this check is handed over by its route's own handOver(), which
    // now sees them too. The plan names whoever holds each task afterwards, even when the route's handOver() moved it.
    const gone = await many(`SELECT DISTINCT t.agent_id FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE t.mission_id = $1 AND a.archived`, [mission.id]);
    if (gone.length) {
      for (const { agent_id } of gone) await handOver(agent_id).catch((e) => console.error('[handover]', e.message));
      const now = new Map((await many(`SELECT t.id, t.agent_id, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.mission_id = $1`, [mission.id])).map((r) => [r.id, r]));
      rows.forEach((row, i) => {
        const cur = now.get(row.id);
        if (!cur) return;
        row.agent_id = tasks[i].agent_id = cur.agent_id;
        tasks[i].agent_name = cur.agent_name;
      });
    }
    await query(`UPDATE missions SET status='running', plan=$2 WHERE id=$1`, [mission.id, { analysis: p.analysis, tasks }]);
    await publishMission(mission.id);
    await postMessage({
      project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'plan',
      content: p.analysis || `Plan: ${tasks.length} tasks.`,
      meta: { tasks: tasks.map((t) => ({ key: t.key, title: t.title, role: t.role, agent: t.agent_name, depends_on: t.depends_on })), staffing: notes },
    });
    for (const r of rows) await publishTask(r.id);

    await schedule({ rows, project, gm, mission, settings, signal });

    const final = await many(`SELECT t.*, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.mission_id = $1 AND t.origin <> 'proposal' ORDER BY t.created_at`, [mission.id]);
    const done = final.filter((t) => t.status === 'done').length;
    const status = signal.aborted ? 'cancelled' : done === final.length ? 'done' : 'failed';
    // Per-task lines: kept in the summary's meta for the client, and the summary body when the GM digest fails.
    const taskLines = final.map((t) => ({ key: t.key, title: t.title, agent: t.agent_name || null, status: t.status, summary: (t.report?.summary || t.result || t.status).split('\n')[0].slice(0, 220) }));
    const lines = taskLines.map((t) => `- ${t.status === 'done' ? '✓' : t.status === 'cancelled' ? '⊘' : '✗'} **${t.key} ${t.title}** — ${t.agent || '—'}: ${t.summary}`);

    // GitHub: upload the result when files may have changed. Any agent on an edit-capable provider
    // (canEdit: Claude Code, Codex CLI) can edit files, and syncProject is a no-op on a clean tree,
    // so role access is not checked here.
    const editProviders = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].canEdit);
    const wrote = !!(await one(
      `SELECT 1 FROM runs r JOIN models m ON m.id = r.model_id JOIN tasks t ON t.id = r.task_id
       WHERE r.mission_id = $1 AND r.status = 'done' AND m.provider = ANY($2::text[]) AND t.status = 'done' LIMIT 1`, [mission.id, editProviders]));
    project = await getProject(project.id);
    let github = '';
    if (project.auto_sync && settings.github.autoSync && !signal.aborted) {
      // Marked done inside the sync lane, so the next mission's sync never counts it as still active.
      const log = await syncMission({ project, mission, wrote, tasks, final, settings, message: commitMessageBuilder({ project, gm, mission, tasks: final, signal }) });
      if (log) github = `\n\n${syncReport(log)}${deferredNote(log)}`;
    } else if (self) self.phase = 'done';

    const digest = await missionDigest({ project, gm, mission, final, signal });

    // Measured after the sync and the digest so the GM's commit-message and digest runs are counted too.
    const usage = await one(`SELECT coalesce(sum(input_tokens + output_tokens),0) AS tokens, coalesce(sum(cost_usd),0) AS cost FROM runs WHERE mission_id = $1`, [mission.id]);
    const secs = Math.round((Date.now() - started) / 1000);
    const summary = `**Mission ${status}** · ${done}/${final.length} tasks · ${fmtDuration(secs)} · ${Number(usage.tokens).toLocaleString()} tokens\n\n${digest || lines.join('\n')}${github}`;

    await query(`UPDATE missions SET status=$2, summary=$3, finished_at=now() WHERE id=$1`, [mission.id, status, summary]);
    await publishMission(mission.id);
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'summary', content: summary, meta: { status, done, total: final.length, digest: !!digest, tasks: taskLines } });
    await notify({
      source_type: 'manager', source_name: gm.name, agent_id: gm.id, project_id: project.id,
      level: status === 'done' ? 'success' : status === 'cancelled' ? 'warning' : 'error',
      title: `${project.name}: mission ${status} (${done}/${final.length})`, body: mission.command.slice(0, 160),
    });
    await audit(gm.name, `mission.${status}`, project.name, { missionId: mission.id });
    analyzeMission(mission.id).catch((e) => console.error('[evolution]', e.message));
  } catch (err) {
    const status = signal.aborted ? 'cancelled' : 'failed';
    const self = active.get(mission.id);
    if (self) self.phase = 'done'; // commits nothing: its changes are left to the last mission's sweep
    await query(`UPDATE missions SET status=$2, summary=$3, finished_at=now() WHERE id=$1`, [mission.id, status, err.message]);
    await query(`UPDATE tasks SET status='cancelled', finished_at=now() WHERE mission_id=$1 AND status IN ('pending','running')`, [mission.id]);
    refreshProject(project.id);
    await publishMission(mission.id);
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: status === 'cancelled' ? 'status' : 'error', content: status === 'cancelled' ? 'Mission cancelled.' : `Mission failed: ${err.message}` });
  } finally {
    // Stays 'working' while another mission of a project it manages is still planning or running.
    await refreshAgentStatus(gm.id);
    await mergeLeases(mission.id);
    await publishProject(project.id).catch(() => {});
    await publishTopic(mission.topic_id).catch(() => {});
  }
}

const fmtDuration = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

/**
 * Commit a finished mission's work; one sync at a time per project, so the choice below still holds at commit time.
 * While another mission of the project is active and has not committed yet, only this mission's files are committed
 * (what its runs edited plus its done tasks' declared files) minus what those missions touched or lease; the rest stays
 * for the last one, which sweeps with the usual add -A. Returns the sync log, or null when there is nothing to sync now.
 */
function syncMission({ project, mission, wrote, tasks, final, settings, message }) {
  return withAgentLock('sync', project.id, async () => {
    const self = active.get(mission.id);
    try {
      const others = activeIn(project.id).filter((a) => a.mission.id !== mission.id && a.phase !== 'done');
      if (!others.length) {
        if (!wrote && !sweeps.has(project.id)) return null;
        const log = await syncProject(project, message, settings.github);
        if (log.status !== 'error') sweeps.delete(project.id);
        return log;
      }
      if (!wrote) return null;
      const done = new Set(final.filter((t) => t.status === 'done').map((t) => t.key));
      const declared = tasks.filter((t) => done.has(t.key)).flatMap((t) => t.files || []);
      const only = [...new Set([...(await touchedFiles(mission.id, project.path)), ...declared])];
      const log = await syncProject(project, message, settings.github, { only, exclude: await filesOf(project, others) });
      if (log.deferred?.length) sweeps.add(project.id);
      return log;
    } finally {
      if (self) self.phase = 'done';
    }
  });
}

const fileList = (files, n = 12) => `${[...files].sort().slice(0, n).map((f) => `\`${f}\``).join(', ')}${files.length > n ? ` and ${files.length - n} more` : ''}`;

/** Summary note for the changes a scoped sync left uncommitted. */
const deferredNote = (log) => (log.deferred?.length
  ? `\n\nDeferred while other missions in this project are active (the last one to finish commits them): ${fileList(log.deferred)}`
  : '');

async function schedule({ rows, project, gm, mission, settings, signal }) {
  const state = Object.fromEntries(rows.map((r) => [r.key, r]));
  const running = new Map();
  const limit = Math.max(1, settings.orchestrator.maxParallel || 3);
  const announced = new Set(); // keys whose file-lease wait was posted
  const aborted = new Promise((r) => { if (signal.aborted) r(); else signal.addEventListener('abort', r, { once: true }); });
  while (!signal.aborted) {
    for (const t of Object.values(state)) {
      if (t.status !== 'pending') continue;
      const blocked = t.depends_on.find((k) => ['failed', 'cancelled'].includes(state[k]?.status));
      if (blocked) {
        t.status = 'cancelled';
        await query(`UPDATE tasks SET status='cancelled', result=$2, finished_at=now() WHERE id=$1`, [t.id, `Blocked: dependency ${blocked} did not complete`]);
        await publishTask(t.id);
        refreshProject(project.id);
      }
    }
    const ready = Object.values(state).filter((t) => t.status === 'pending' && t.depends_on.every((k) => state[k]?.status === 'done'));
    let wake = null; // set when a ready task waits for another mission's file lease
    for (const t of ready) {
      if (running.size >= limit) break;
      const found = lease(project.id, mission, t);
      if (found.length) {
        wake ||= nextFinish(project.id); // taken with the check, so a finish during the post below still wakes it
        if (!announced.has(t.key)) {
          announced.add(t.key);
          await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'status', content: await waitText(t, found), meta: { detail: true } });
        }
        continue;
      }
      t.status = 'running';
      const p = runTask({ task: t, state, project, gm, mission, settings, signal })
        .then((status) => { t.status = status; })
        .catch((err) => { t.status = 'failed'; console.error('[task]', err.message); })
        .finally(() => { running.delete(t.key); taskFinished(project.id, t.id); });
      running.set(t.key, p);
    }
    if (!running.size && !wake) break;
    await Promise.race(wake ? [...running.values(), wake, aborted] : running.values());
  }
  if (signal.aborted) {
    await Promise.allSettled(running.values());
    await query(`UPDATE tasks SET status='cancelled', finished_at=now() WHERE mission_id=$1 AND status IN ('pending','running')`, [mission.id]);
    refreshProject(project.id);
  }
}

/**
 * Mark the task running on agentId unless that agent already runs another task (false) or is archived (null). The
 * check and the update are serialized per agent, so two tasks starting at the same moment in different missions can't
 * both take it, and a merge or delete (same lane) can't archive it in between.
 */
function claim(task, agentId) {
  return withAgentLock('claim', agentId, async () => {
    const a = await one(`SELECT archived, EXISTS (SELECT 1 FROM tasks WHERE agent_id = $1 AND status = 'running' AND id <> $2) AS busy FROM agents WHERE id = $1`, [agentId, task.id]);
    if (!a || a.archived) return null;
    if (a.busy) return false;
    await query(`UPDATE tasks SET status='running', started_at=now(), progress=5, agent_id=$2 WHERE id=$1`, [task.id, agentId]);
    task.agent_id = agentId;
    return true;
  });
}

// '<X> was merged into <Y> — <Y> takes over T2' / '<X> was removed — <Z> (similar Backend Engineer) takes over T2, T3'.
function handOverText(gone, moves) {
  const takers = new Map(); // agentId -> { agent, merged, recruited, keys }
  for (const m of moves) {
    const t = takers.get(m.agent.id);
    takers.set(m.agent.id, t ? { ...t, keys: [...t.keys, m.key] } : { ...m, keys: [m.key] }); // the first pick says whether it was recruited
  }
  const merged = moves.find((m) => m.merged)?.agent;
  const lead = !gone ? `No agent was left on ${moves.map((m) => m.key).join(', ')}`
    : merged ? `${gone.name} was merged into ${merged.name}` : `${gone.name} was ${gone.merged_into ? 'merged' : 'removed'}`;
  const parts = [...takers.values()].map((t) => `${t.agent.name}${t.merged ? '' : ` (${t.recruited ? 'new' : 'similar'} ${roleInfo(t.agent.role).title})`} takes over ${t.keys.join(', ')}`);
  return `${lead} — ${parts.join('; ')}`;
}

/**
 * The task's agent as stored now (a merge or delete may have handed the task over since staffing). One that is archived
 * or missing is replaced the way handOver() does it, and the mission's chat says so. The update is conditional, so a
 * hand-over at the same moment wins and its choice is read on the next pass (the row is re-read on every pass).
 * Returns null, with nothing written, once the mission is aborted (checked on each pass and after replacementFor) or
 * the task row is gone (its project or mission was deleted).
 */
async function liveAgent({ task, project, gm, mission, signal }) {
  for (;;) {
    if (signal.aborted) return null;
    const row = await one(`SELECT agent_id FROM tasks WHERE id = $1`, [task.id]);
    if (!row) return null;
    const id = row.agent_id;
    const assigned = id && (await getAgent(id));
    if (assigned && !assigned.archived) return assigned;
    const pick = await replacementFor(assigned || null, task);
    if (signal.aborted) return null;
    if (!(await one(`UPDATE tasks SET agent_id = $2 WHERE id = $1 AND agent_id IS NOT DISTINCT FROM $3::uuid RETURNING id`, [task.id, pick.agent.id, id]))) continue;
    task.agent_id = pick.agent.id;
    const content = handOverText(assigned || null, [{ ...pick, key: task.key }]);
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'status', content, meta: { detail: true } });
    await notify({ source_type: 'manager', source_name: gm.name, project_id: project.id, agent_id: pick.agent.id, title: `${project.name}: ${pick.agent.name} takes over ${task.key}`, body: content });
    return pick.agent;
  }
}

// The agent's pending tasks in planning or running missions: the work handOver() moves once it is gone.
const pendingOf = (agentId) => many(
  `SELECT t.id, t.key, t.title, t.role, t.skills, t.mission_id, t.project_id FROM tasks t JOIN missions m ON m.id = t.mission_id
   WHERE t.agent_id = $1 AND t.status = 'pending' AND m.status IN ('planning', 'running') ORDER BY t.created_at`, [agentId]);

/**
 * An agent is gone (merged or removed): every pending task it had in a planning or running mission moves to a similar
 * live agent (replacementFor), and each affected mission's chat says who took over. Started tasks are left to runTask.
 */
export async function handOver(agentId) {
  const gone = await getAgent(agentId);
  if (!gone) return [];
  const pending = await pendingOf(agentId);
  const byMission = new Map(); // missionId -> [{ agent, merged, recruited, key, task }]
  for (const t of pending) {
    const pick = await replacementFor(gone, t);
    // Conditional: a task that started meanwhile (or was picked up by runTask) keeps what it has.
    if (!(await one(`UPDATE tasks SET agent_id = $2 WHERE id = $1 AND agent_id = $3 AND status = 'pending' RETURNING id`, [t.id, pick.agent.id, agentId]))) continue;
    byMission.set(t.mission_id, [...(byMission.get(t.mission_id) || []), { ...pick, key: t.key, task: t }]);
  }
  const projects = new Set();
  for (const [missionId, moves] of byMission) {
    const project = await getProject(moves[0].task.project_id);
    const content = handOverText(gone, moves);
    await postMessage({ project_id: project.id, mission_id: missionId, author_type: 'agent', agent_id: project.manager_id, kind: 'status', content, meta: { detail: true } });
    await notify({ source_type: 'manager', source_name: project.manager_name, project_id: project.id, agent_id: moves[0].agent.id, title: `${project.name}: ${gone.name} ${gone.merged_into ? 'merged' : 'removed'} — work handed over`, body: content });
    for (const m of moves) await publishTask(m.task.id);
    projects.add(project.id);
  }
  for (const id of projects) await publishProject(id).catch(() => {});
  return [...byMission.values()].flat().map((m) => ({ task_id: m.task.id, key: m.key, agent_id: m.agent.id }));
}

/**
 * Read-only: what handOver() would do if the goneIds agents went now, one after the other (as a bulk project delete
 * retires its GMs). Returns the final owner of each pending task they hold; a task picked onto a later agent of the list
 * moves on with it. mergeInto (the merge target) takes all of it. Tasks of excludeProjects (being deleted) are left out.
 * Where nobody of the role is left, recruit is who would be recruited ({ role, title }), and later picks reuse it.
 */
export async function previewHandOver(goneIds, { mergeInto = null, excludeProjects = [] } = {}) {
  const gone = [];
  for (const id of new Set(goneIds)) {
    const a = await getAgent(id);
    if (a) gone.push(a);
  }
  const skip = new Set(excludeProjects);
  const tasks = [];
  for (const g of gone) for (const t of await pendingOf(g.id)) if (!skip.has(t.project_id)) tasks.push({ ...t, from: g });
  if (!tasks.length) return [];
  const agents = mergeInto ? [] : await listAgents();
  const names = new Map((await many(`SELECT id, name FROM projects WHERE id = ANY($1)`, [[...new Set(tasks.map((t) => t.project_id))]])).map((p) => [p.id, p.name]));
  const holder = new Map(tasks.map((t) => [t.id, t.from.id])); // taskId -> who has it at this step
  const picks = new Map(); // taskId -> { agent, merged, recruit }, the last one being final
  const recruits = new Map(); // role -> { role, title }
  const out = [];
  for (const g of gone) {
    out.push(g.id);
    const into = mergeInto || (g.merged_into ? await mergeTarget(g) : null);
    for (const t of tasks.filter((x) => holder.get(x.id) === g.id)) {
      const agent = into || pickReplacement(g, t, agents, { exclude: out });
      const role = normalizeRole(g.role);
      const recruit = agent ? null : recruits.get(role) || { role, title: g.title || roleInfo(role).title };
      if (recruit) recruits.set(role, recruit);
      picks.set(t.id, { agent, merged: !!into, recruit });
      holder.set(t.id, agent?.id ?? null);
    }
  }
  return tasks.map((t) => {
    const { agent, merged, recruit } = picks.get(t.id);
    return { task_id: t.id, key: t.key, title: t.title, mission_id: t.mission_id, project_id: t.project_id, project_name: names.get(t.project_id) ?? null,
      from: { id: t.from.id, name: t.from.name }, agent: agent && { id: agent.id, name: agent.name, role: agent.role, title: agent.title }, merged, recruit };
  });
}

async function runTask({ task, state, project, gm, mission, settings, signal, attempt = 1 }) {
  let agent;
  for (let claimed = null; !claimed;) {
    agent = signal.aborted ? null : await liveAgent({ task, project, gm, mission, signal });
    if (!agent) {
      // Aborted, or the task row is gone (project or mission deleted): nothing to run. A gone row has nothing to publish.
      if (await one(`UPDATE tasks SET status='cancelled', finished_at=now() WHERE id=$1 RETURNING id`, [task.id])) {
        await publishTask(task.id);
        refreshProject(project.id);
      }
      return 'cancelled';
    }
    // An agent released from the project (after staff() read the roster, or given the task by a hand-over) is passed
    // over like a busy one. Its pending task blocks any later release, so the check can't go stale before the claim.
    const released = agent.role !== 'executive' && (await memberStanding(project.id)).get(agent.id) === 'released';
    claimed = released ? false : await claim(task, agent.id); // null: archived since it was read, look again
    if (claimed === false && agent.role === 'executive') {
      // Never cloned: wait for it to finish its other task.
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (claimed === false) {
      // The assigned agent is busy elsewhere (or released): an idle original of the role takes the task, else a clone
      // leased to this mission (of the busy agent's original, or of a new original when the role has none left).
      const busy = agent;
      const why = released ? 'was released from this project' : 'is busy';
      let content = null;
      const standing = await memberStanding(project.id); // never an agent released from this project
      for (const a of (await listAgents()).filter((x) => x.role === busy.role && x.origin !== 'cloned' && x.id !== busy.id && x.status !== 'working' && !x.active_tasks && standing.get(x.id) !== 'released')) {
        if (!(await claim(task, a.id))) continue;
        agent = a;
        content = `${busy.name} ${why} — ${a.name} (idle ${roleInfo(a.role).title}) takes ${task.key}.`;
        break;
      }
      if (!content) {
        let lease;
        do {
          lease = await leaseClone(task, project, mission, busy);
          agent = lease.agent;
        } while (!(await claim(task, agent.id)));
        content = lease.recruited
          ? `${busy.name} ${why} and no ${roleInfo(busy.role).title} original is left — recruited ${lease.src.name} (kept in reserve) and cloned ${agent.name} for ${task.key}; the clone merges back when the mission ends.`
          : `${busy.name} ${why} — cloned ${agent.name} from ${lease.src.name} for ${task.key}; it merges back into ${lease.src.name} when the mission ends.`;
        await notifyLease(lease, task, project, mission);
      }
      await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'status', content, meta: { detail: true } });
      claimed = true;
    }
  }
  await refreshAgentStatus(agent.id);
  await publishTask(task.id);
  refreshProject(project.id);
  // Whoever runs it (a hand-over, an idle original or a leased clone) is a member of the project from now on.
  await ensureMembers(project.id, [agent.id]).catch((e) => console.error('[members]', e.message));

  const deps = await many(`SELECT t.*, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.mission_id = $1 AND t.key = ANY($2)`, [mission.id, task.depends_on]);
  const playbook = agent.stats?.experiment?.playbook || agent.playbook;
  const others = activeIn(project.id).filter((a) => a.mission.id !== mission.id);
  const shared = others.length ? await filesOf(project, others) : null;
  const { system, prompt } = taskPrompt({ project, agent, task: { ...task, acceptance: task.acceptance }, gm, supervisor: agent.supervisor_name, deps, mission, attachments: mission.attachments, playbook, shared });
  const access = roleInfo(agent.role).access;

  let ok = false;
  let report = null;
  let out = null;
  let errorText = null;
  let progressTimer = null;
  try {
    const model = await resolveModel(agent.model_id);
    let progress = 5;
    progressTimer = setInterval(() => {
      progress = Math.min(92, progress + Math.max(1, Math.round((95 - progress) / 12)));
      query(`UPDATE tasks SET progress=$2 WHERE id=$1 AND status='running'`, [task.id, progress]).then(() => publishTask(task.id)).catch(() => {});
    }, 4000);
    out = await executeRun({ kind: 'task', agent, project, mission, task, model, prompt, system, access, attachments: mission.attachments, signal, meta: { kind: 'task', role: agent.role, title: task.title } });
    report = parseJson(out.text) || { status: 'done', summary: String(out.text || '').slice(-1500) };
    ok = !['failed', 'blocked'].includes(String(report.status || 'done').toLowerCase());
  } catch (err) {
    errorText = err.message;
    report = { status: 'failed', summary: err.message };
  } finally {
    clearInterval(progressTimer);
  }

  if (signal.aborted) {
    await query(`UPDATE tasks SET status='cancelled', finished_at=now() WHERE id=$1`, [task.id]);
    await refreshAgentStatus(agent.id);
    await publishTask(task.id);
    refreshProject(project.id);
    return 'cancelled';
  }

  const status = ok ? 'done' : 'failed';
  await query(`UPDATE tasks SET status=$2, progress=$3, result=$4, report=$5, finished_at=now() WHERE id=$1`,
    [task.id, status, ok ? 100 : 0, String(report.summary || out?.text || errorText || '').slice(0, 8000), report]);
  await refreshAgentStatus(agent.id);
  await publishTask(task.id);
  refreshProject(project.id);

  // Report upward to the General Manager.
  await postMessage({
    project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: agent.id, kind: 'report',
    content: String(report.summary || errorText || 'No summary').slice(0, 4000),
    meta: { task_id: task.id, task_key: task.key, task_title: task.title, status, to: gm.name, artifacts: report.artifacts || [], confidence: report.confidence ?? null },
  });

  await learn({ agent, task, report, ok, out: { ...out, error: errorText }, settings, project }).catch((e) => console.error('[learn]', e.message));

  // Agents may raise their own follow-up work.
  for (const prop of (Array.isArray(report.proposals) ? report.proposals : []).slice(0, 3)) {
    if (!prop?.title) continue;
    const row = await one(
      `INSERT INTO tasks(project_id, mission_id, key, title, description, role, status, origin, agent_id) VALUES ($1,$2,$3,$4,$5,$6,'proposed','proposal',$7) RETURNING *`,
      [project.id, mission.id, `P-${task.key}`, String(prop.title).slice(0, 200), String(prop.description || '').slice(0, 2000), normalizeRole(prop.role || agent.role), agent.id],
    );
    const msg = await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: agent.id, kind: 'proposal', content: `${prop.title}${prop.description ? `\n\n${prop.description}` : ''}`, meta: { task_id: row.id, role: row.role } });
    if (settings.orchestrator.autoApproveProposals) {
      // Approved without review, as before, within the loop guard.
      await withAgentLock('proposals', mission.id, async () => {
        const limit = await proposalLimit(mission);
        if (limit) await decideProposal({ row, msg, decider: gm, project, mission, verdict: 'reject', reason: limit });
        else await approveProposal(row.id);
      }).catch((e) => console.error('[proposal]', e.message));
    } else if (settings.orchestrator.proposalTriage !== false) {
      await triageProposal({ row, msg, proposer: agent, report, project, gm, mission, signal })
        .catch((e) => console.error('[triage]', e.message));
    }
  }

  if (!ok && attempt === 1 && settings.orchestrator.retryFailed && !errorText?.includes('limit reached')) {
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'status', content: `${task.key} failed — asking ${agent.name} to retry once with the failure context.`, meta: { detail: true } });
    task.description = `${task.description}\n\nPREVIOUS ATTEMPT FAILED:\n${String(report.summary || errorText).slice(0, 1500)}\nFix the cause and complete the task.`;
    // 'running' again only on a live agent: one merged or removed since the first attempt is replaced as the retry starts.
    await query(`UPDATE tasks t SET description=$2, status = CASE WHEN EXISTS (SELECT 1 FROM agents a WHERE a.id = t.agent_id AND NOT a.archived) THEN 'running' ELSE t.status END WHERE t.id=$1`, [task.id, task.description]);
    refreshProject(project.id);
    return runTask({ task, state, project, gm, mission, settings, signal, attempt: 2 });
  }
  return status;
}

// ---- commit messages -----------------------------------------------------

const COMMIT_TIMEOUT = 3 * 60000; // stays under git.js's 4 min builder guard, so our fallback (with trailer) wins
const SUBJECT_MAX = 72;
const BODY_MAX = 2000;
const TRAILER = /^\s*(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|change-id|generated-by)\s*:|^\s*(🤖\s*)?generated (with|by) \[?claude|^\s*agentforge (mission|sync)\b/i;
const plain = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Cut to ≤ max chars at a word boundary, without dangling punctuation or a final period. */
function cutSubject(text, max = SUBJECT_MAX) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    const sp = s.lastIndexOf(' ', max);
    s = s.slice(0, sp > max / 2 ? sp : max);
  }
  return s.replace(/[\s.,;:!?…-]+$/, '');
}

/** Model output → { subject, body } as plain commit text, or null when nothing usable is left. */
export function cleanCommitMessage(text) {
  let s = String(text ?? '').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
  const fenced = s.match(/```[^\n]*\n([\s\S]*?)```/);
  if (fenced?.[1].trim()) s = fenced[1].trim();
  if (/^["'“]/.test(s) && /["'”]$/.test(s)) s = s.slice(1, -1).trim();
  const lines = s.split('\n').filter((l) => !/^\s*```/.test(l) && !TRAILER.test(l)).map((l) => l.trimEnd());
  // Chatty lead-ins such as "Here is the commit message:".
  while (lines.length && (!lines[0].trim() || /^(here|sure|ok|okay|certainly|below)\b.*:$|^(proposed |suggested )?commit message:?$/i.test(lines[0].trim()))) lines.shift();
  if (!lines.length) return null;
  const subject = cutSubject(lines.shift()
    .replace(/^\s*(#{1,6}|[-*•])\s+/, '')
    .replace(/^(subject|title|commit message)\s*:\s*/i, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^["'“‘]+|["'”’]+$/g, ''));
  if (!/\p{L}{2,}\S*\s+\S*\p{L}/u.test(subject) || /^[{[<]/.test(subject) || /^(i('m| am)? (sorry|cannot|can't|unable)|as an ai)\b/i.test(subject)) return null;

  const body = [];
  let bullets = 0;
  for (const line of lines) {
    if (/^\s*#{1,6}\s/.test(line)) continue;
    const l = line.replace(/^(\s*)([*•]|\d{1,2}[.)])\s+/, '$1- ').replace(/\*\*|__/g, '');
    if (/^- /.test(l) && ++bullets > 6) break;
    body.push(l);
  }
  const paras = body.join('\n').replace(/\n{3,}/g, '\n\n').trim().split('\n\n');
  // A trailing "Key-Name: value" block is a trailer, whatever its key.
  if (paras.length > 1 && paras.at(-1).split('\n').every((l) => /^[A-Za-z]+(-[A-Za-z]+)+:\s/.test(l))) paras.pop();
  let rest = paras.join('\n\n').trim();
  if (rest.length > BODY_MAX) {
    const cut = rest.lastIndexOf('\n', BODY_MAX);
    rest = rest.slice(0, cut > BODY_MAX / 2 ? cut : BODY_MAX).trimEnd();
  }
  return { subject, body: rest };
}

/** Deterministic message: topic title or first done task, done task titles and the diffstat summary. */
function fallbackCommit({ title, tasks, files, stat, order }) {
  const done = tasks.filter((t) => t.status === 'done');
  const areas = [...new Set(files.map((f) => (f.includes('/') ? f.split('/')[0] : 'root')))].slice(0, 3);
  const generic = `Update ${files.length} file${files.length === 1 ? '' : 's'}${areas.length ? ` in ${areas.join(', ')}` : ''}`;
  const subject = cutSubject([title, done[0]?.title].find((c) => plain(c) && plain(c) !== plain(order)) || generic);
  const bullets = done.slice(0, 5).map((t) => `- ${cutSubject(t.title, 100)}`);
  if (!bullets.length && files.length) bullets.push(`- Update ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`);
  const total = String(stat || '').trim().split('\n').pop()?.trim();
  if (total && / changed/.test(total)) bullets.push(`- ${total}`);
  return { subject: subject.charAt(0).toUpperCase() + subject.slice(1), body: bullets.join('\n') };
}

/**
 * The async ({ files, stat, diff }) => message builder for syncProject(). The GM writes the message
 * from the staged diff; a failure, abort, timeout or junk output falls back to a deterministic one.
 * `mission` is null for manual syncs, where `reason` stands in for the order.
 */
export function commitMessageBuilder({ project, gm, mission, tasks = [], signal, reason = 'Manual sync' }) {
  const trailer = mission ? `AgentForge mission ${mission.id}` : 'AgentForge sync';
  return async ({ files = [], stat = '', diff = '' } = {}) => {
    let msg = null;
    if (gm && !signal?.aborted) {
      try {
        const model = await resolveModel(gm.model_id);
        const { system, prompt } = commitPrompt({ project, gm, command: mission?.command, reason, tasks, files, stat, diff });
        const out = await executeRun({ kind: 'commit', agent: gm, project, mission, model, prompt, system, access: 'read', signal, meta: { kind: 'commit' }, timeoutMs: COMMIT_TIMEOUT });
        msg = cleanCommitMessage(out.text);
      } catch (err) {
        console.error('[commit message]', err.message);
      }
    }
    let title = null;
    if (mission?.topic_id) title = await getTopic(mission.topic_id).then((t) => (t && t.title !== 'New topic' ? t.title : null), () => null);
    const order = String(mission?.command || '').split('\n')[0];
    const fb = fallbackCommit({ title, tasks, files, stat, order });
    // The subject must summarize the change, not echo the order.
    if (msg && order && [order, cutSubject(order)].some((c) => plain(c) === plain(msg.subject))) msg.subject = fb.subject;
    const { subject, body } = msg ? { subject: msg.subject, body: msg.body || fb.body } : fb;
    return `${subject}\n\n${body ? `${body}\n\n` : ''}${trailer}`;
  };
}

/**
 * The GM's digest of a finished mission: 3-8 short markdown lines with the main content only. Null when the mission
 * was aborted or the run fails, times out or returns nothing; the caller then posts the per-task lines instead.
 */
async function missionDigest({ project, gm, mission, final, signal }) {
  if (!gm || signal?.aborted) return null;
  try {
    const model = await resolveModel(gm.model_id);
    const tasks = final.map((t) => ({ key: t.key, title: t.title, agent: t.agent_name, status: t.status, summary: t.report?.summary || t.result || '' }));
    const { system, prompt } = digestPrompt({ project, gm, mission, tasks });
    const out = await executeRun({ kind: 'digest', agent: gm, project, mission, model, prompt, system, access: 'read', signal, meta: { kind: 'digest' }, timeoutMs: COMMIT_TIMEOUT });
    const text = String(out.text || '').replace(/^\s*```[\w-]*\s*\n?|\n?\s*```\s*$/g, '').trim();
    if (!text || signal?.aborted) return null;
    return text.replace(/\n{3,}/g, '\n\n').slice(0, 4000);
  } catch (err) {
    console.error('[digest]', err.message);
    return null;
  }
}

/** "GitHub: …" status line, then the commit message (minus the AgentForge trailer) as a short quote. */
function syncReport(log) {
  const lines = String(log.commit_message || '').split('\n');
  const subject = lines[0];
  const status = subject && log.message.endsWith(` · ${subject}`) ? log.message.slice(0, -(subject.length + 3)) : log.message;
  const text = `GitHub: ${log.status}${log.commit ? ` · ${log.commit}` : ''} — ${status}`;
  const quote = lines.filter((l) => !/^AgentForge (mission|sync)\b/.test(l)).slice(0, 12).join('\n').trim();
  return quote ? `${text}\n\n${quote.split('\n').map((l) => (l ? `> ${l.slice(0, 300)}` : '>')).join('\n')}` : text;
}

// ---- proposals, meetings, sync ------------------------------------------

// A worker's proposal goes to its live line supervisor, else the GM; a supervisor may escalate it to the GM, who approves or rejects it.
// An executive line supervisor is final like the GM: it outranks every project GM, so it only approves or rejects.
// Loop guard: a mission launches at most MAX_PROPOSAL_MISSIONS approved proposals, and a mission launched by a
// proposal chain MAX_PROPOSAL_DEPTH deep launches none. The depth is the last line of the launched mission's order.
const MAX_PROPOSAL_MISSIONS = 2;
const MAX_PROPOSAL_DEPTH = 2;
const TRIAGE_TIMEOUT = 5 * 60000;
const CHAIN = /\(proposal chain depth (\d+)\)\s*$/;
const chainDepth = (command) => Number(String(command || '').match(CHAIN)?.[1]) || 0;

/** 'proposal limit reached' when the mission may not launch another proposal, else null. */
async function proposalLimit(mission) {
  if (chainDepth(mission.command) >= MAX_PROPOSAL_DEPTH) return 'proposal limit reached';
  const { n } = await one(`SELECT count(*)::int AS n FROM tasks WHERE mission_id = $1 AND origin = 'proposal' AND result LIKE 'Approved%'`, [mission.id]);
  return n >= MAX_PROPOSAL_MISSIONS ? 'proposal limit reached' : null;
}

/** Closes a still-proposed proposal as approved; null when it was decided elsewhere meanwhile. */
async function claimProposal(taskId, by = null) {
  const t = await one(`SELECT t.*, m.topic_id, m.command AS order_text FROM tasks t LEFT JOIN missions m ON m.id = t.mission_id WHERE t.id = $1 AND t.status = 'proposed'`, [taskId]);
  if (!t || !(await one(`UPDATE tasks SET status='cancelled', result=$2 WHERE id=$1 AND status='proposed' RETURNING id`, [taskId, by ? `Approved by ${by} → new mission` : 'Approved → new mission']))) return null;
  await publishTask(taskId);
  return t;
}

/** The approved proposal as a new order in the same topic, one level deeper in the proposal chain. */
function launchProposal(t) {
  const content = `${`${t.title}\n\n${t.description || ''}`.trim()}\n\n(proposal chain depth ${chainDepth(t.order_text) + 1})`;
  return submitCommand(t.project_id, { content, topicId: t.topic_id });
}

export async function approveProposal(taskId) {
  const t = await claimProposal(taskId);
  if (!t) throw new Error('proposal not found');
  return launchProposal(t);
}

export async function rejectProposal(taskId, { by = null, reason = '' } = {}) {
  await query(`UPDATE tasks SET status='cancelled', result=$2 WHERE id=$1 AND status='proposed'`, [taskId, by ? `Rejected by ${by}: ${reason}` : 'Rejected']);
  return publishTask(taskId);
}

/** { decider, final }: the live line supervisor, else the GM. The GM and an executive decide finally (no escalation). */
async function deciderFor(proposer, gm) {
  const sup = proposer.supervisor_id ? await getAgent(proposer.supervisor_id).catch(() => null) : null;
  const decider = sup && !sup.archived ? sup : gm;
  return { decider, final: decider.id === gm.id || decider.role === 'executive' };
}

const triageRelation = (decider, gm) => (decider.id === gm.id ? 'General Manager' : decider.role === 'executive' ? 'executive (top-level manager)' : 'line supervisor');

/** One triage run: { verdict, reason }, verdict null when the answer is unusable, the model fails or the run is aborted. */
async function askTriage({ decider, final, gm, row, proposer, report, project, mission, signal, escalation = null }) {
  if (signal.aborted) return { verdict: null, reason: 'the mission was stopped before the proposal could be reviewed', aborted: true };
  try {
    const model = await resolveModel(decider.model_id);
    const inflight = inflightContext(await inflightMissions(project.id, mission.id));
    const { system, prompt } = triagePrompt({
      project, decider, proposer, relation: triageRelation(decider, gm), final, command: mission.command,
      summary: report.summary, proposal: row, inflight, escalation,
    });
    const out = await executeRun({ kind: 'triage', agent: decider, project, mission, model, prompt, system, access: 'read', signal, meta: { kind: 'triage', task_id: row.id, title: row.title, escalated: !!escalation }, timeoutMs: TRIAGE_TIMEOUT });
    const parsed = parseJson(out.text);
    const said = String(parsed?.decision || '').trim().toLowerCase();
    const why = String(parsed?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (signal.aborted) return { verdict: null, reason: 'the mission was stopped during the review', aborted: true };
    if (!['approve', 'reject', 'escalate'].includes(said)) return { verdict: null, reason: 'no valid decision came back from the review' };
    return { verdict: said, reason: why || 'no reason given' };
  } catch (err) {
    return signal.aborted ? { verdict: null, reason: 'the mission was stopped during the review', aborted: true } : { verdict: null, reason: `the review failed (${String(err.message).slice(0, 200)})` };
  }
}

const proposalName = (msg, row) => `${msg.agent_name ? `${msg.agent_name}'s` : 'the'} proposal "${row.title}"`;
const sentence = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/**
 * Agents decide proposals themselves; none reaches the user. A line supervisor's escalation (or failed review) hands the
 * proposal up to the GM, who only approves or rejects. An executive line supervisor is final like the GM. Anything else
 * from a final decider, a model error or an abort rejects it.
 */
async function triageProposal({ row, msg, proposer, report, project, gm, mission, signal }) {
  let { decider, final } = await deciderFor(proposer, gm);
  const limit = await proposalLimit(mission);
  if (limit) return decideProposal({ row, msg, decider, project, mission, verdict: 'reject', reason: limit });
  let answer = await askTriage({ decider, final, gm, row, proposer, report, project, mission, signal });
  let escalation = null;
  if (!final && !answer.aborted && answer.verdict !== 'approve' && answer.verdict !== 'reject') {
    // Decided elsewhere meanwhile (a manual approve/reject): nothing to hand up.
    if (!(await one(`SELECT 1 FROM tasks WHERE id = $1 AND status = 'proposed'`, [row.id]))) return null;
    escalation = { by: decider.name, by_id: decider.id, reason: answer.reason };
    await postMessage({
      project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: decider.id, kind: 'status',
      content: `Escalated ${proposalName(msg, row)} to ${gm.name}: ${sentence(answer.reason)}`, meta: { task_id: row.id, escalation, detail: true },
    });
    [decider, final] = [gm, true];
    answer = await askTriage({ decider, final, gm, row, proposer, report, project, mission, signal, escalation });
  }
  let { verdict, reason } = answer;
  if (verdict === 'escalate') [verdict, reason] = ['reject', `escalated instead of deciding (${reason.replace(/[.!?…]$/, '')}), so it is rejected to stay safe`];
  else if (verdict !== 'approve' && verdict !== 'reject') [verdict, reason] = ['reject', answer.aborted ? reason : `${reason}, so it is rejected to stay safe`];
  if (verdict !== 'approve') return decideProposal({ row, msg, decider, project, mission, verdict, reason, escalation });
  // Approvals of one mission are counted and launched one at a time.
  return withAgentLock('proposals', mission.id, async () => {
    const limit = await proposalLimit(mission);
    return decideProposal({ row, msg, decider, project, mission, verdict: limit ? 'reject' : 'approve', reason: limit || reason, escalation });
  });
}

/** Applies an approve/reject verdict, records it on the proposal message and says it in the chat. A proposal decided meanwhile is left alone. */
async function decideProposal({ row, msg, decider, project, mission, verdict, reason, escalation = null }) {
  let approved = null;
  if (verdict === 'approve') {
    approved = await claimProposal(row.id, decider.name);
    if (!approved) return null;
  } else {
    verdict = 'reject';
    const done = await one(`UPDATE tasks SET status='cancelled', result=$2 WHERE id=$1 AND status='proposed' RETURNING id`, [row.id, `Rejected by ${decider.name}: ${reason}`]);
    if (!done) return null;
    await publishTask(row.id);
  }
  const decision = { by: decider.name, by_id: decider.id, verdict, reason, ...(escalation ? { escalation } : {}) };
  const updated = await one(`UPDATE messages SET meta = meta || $2 WHERE id = $1 RETURNING id`, [msg.id, { decision }]);
  if (updated) emit('message:update', await one(`SELECT m.*, a.name AS agent_name, a.role AS agent_role, a.title AS agent_title FROM messages m LEFT JOIN agents a ON a.id = m.agent_id WHERE m.id = $1`, [msg.id]));
  const what = proposalName(msg, row);
  const content = verdict === 'approve' ? `Approved ${what}: ${sentence(reason)} Starting it as a new mission.` : `Rejected ${what}: ${sentence(reason)}`;
  await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: decider.id, kind: 'status', content, meta: { task_id: row.id, decision, detail: true } });
  if (approved) await launchProposal(approved);
  return verdict;
}

export async function standup(projectId, topicId = null) {
  const project = await getProject(projectId);
  const topic = await ensureTopic(projectId, topicId);
  const rows = await many(
    `SELECT DISTINCT ON (a.id) a.name, a.title, a.status, t.key, t.title AS task, t.status AS task_status, t.progress
     FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE t.project_id = $1 ORDER BY a.id, t.created_at DESC`, [projectId]);
  const blockers = rows.filter((r) => ['failed', 'cancelled'].includes(r.task_status));
  const running = activeIn(projectId).length;
  const body = rows.length
    ? rows.map((r) => `- **${r.name}** (${r.title}) · ${r.status} — last: ${r.key} ${r.task} · ${r.task_status}${r.task_status === 'running' ? ` ${r.progress}%` : ''}`).join('\n')
    : '- No agents have worked on this project yet.';
  return postMessage({
    project_id: projectId, topic_id: topic.id, author_type: 'agent', agent_id: project.manager_id, kind: 'meeting',
    content: `**Stand-up · ${project.name}**\n\n${body}\n\n**Blockers:** ${blockers.length ? blockers.map((b) => `${b.key} (${b.name})`).join(', ') : 'none'}\n**Next:** ${running ? `${running} mission${running === 1 ? '' : 's'} in progress` : 'awaiting your next order'}`,
  });
}

export async function syncNow(projectId, reason, topicId = null) {
  const project = await getProject(projectId);
  const settings = await getSettings();
  const gm = project.manager_id ? await getAgent(project.manager_id) : null;
  // Files that missions still in progress touched or lease stay out: their own missions commit them.
  const log = await withAgentLock('sync', projectId, async () => {
    const others = activeIn(projectId).filter((a) => a.phase !== 'done');
    const exclude = others.length ? await filesOf(project, others) : [];
    const row = await syncProject(project, commitMessageBuilder({ project, gm, mission: null, reason }), settings.github, exclude.length ? { exclude } : {});
    if (!others.length && row.status !== 'error') sweeps.delete(projectId);
    return row;
  });
  let content = syncReport(log);
  if (log.deferred?.length) content += `\n\nLeft out ${log.deferred.length === 1 ? 'a file' : `${log.deferred.length} files`} that missions in progress are still editing (they commit them): ${fileList(log.deferred)}`;
  // The chat shows a 'status' as one plain line; the quoted commit message needs the Markdown card.
  await postMessage({ project_id: projectId, topic_id: (await ensureTopic(projectId, topicId)).id, author_type: 'system', kind: content.includes('\n') ? 'chat' : 'status', content });
  await publishProject(projectId);
  return log;
}

/** On boot: anything that was running belongs to a dead process. */
export async function recoverInterrupted() {
  await query(`UPDATE tasks SET status='failed', result=coalesce(result,'') || ' (interrupted by restart)', finished_at=now() WHERE status='running' OR (status='pending' AND mission_id IN (SELECT id FROM missions WHERE status IN ('planning','running')))`);
  await query(`UPDATE missions SET status='failed', summary='Interrupted by a service restart', finished_at=now() WHERE status IN ('planning','running')`);
  await query(`UPDATE runs SET status='failed', error='interrupted', finished_at=now() WHERE status='running'`);
  await query(`UPDATE agents SET status='idle', current_task_id=NULL WHERE status <> 'idle'`);
  await query(`UPDATE projects SET status='idle' WHERE status <> 'idle'`);
  // Leased clones of missions that ended (now, or before a crash cut their merge short) go back into their originals.
  const ended = await many(
    `SELECT DISTINCT a.lease_mission_id AS id FROM agents a JOIN missions m ON m.id = a.lease_mission_id
     WHERE NOT a.archived AND a.origin = 'cloned' AND m.status NOT IN ('planning', 'running')`);
  for (const m of ended) await mergeLeases(m.id);
}

export { publishAgent };
