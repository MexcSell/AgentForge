import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import { emit } from '../events.js';
import { getSettings } from '../db/seed.js';
import { normalizeRole, roleInfo } from '../roles.js';
import { getAgent, listAgents, createAgent, cloneAgent, setAgentStatus, publishAgent } from '../services/agents.js';
import { getProject, publishProject, setProjectStatus } from '../services/projects.js';
import { getTopic, createTopic, updateTopic, touchTopic, ensureTopic, publishTopic } from '../services/topics.js';
import { notify, audit } from '../services/notify.js';
import { syncProject } from '../services/git.js';
import { PROVIDERS, resolveModel, runModel, recordRunUsage, publishModels } from '../models/index.js';
import { heuristicPlan, topicTitle } from './heuristics.js';
import { planPrompt, taskPrompt, commitPrompt, parseJson, topicContext } from './prompts.js';
import { learn, analyzeMission } from './evolution.js';

const active = new Map(); // projectId -> { missionId, controller }
const queues = new Map(); // projectId -> [missionId]
const liveRuns = new Map(); // runId -> { agentId, taskId }

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
  const onEvent = (e) => {
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
  const q = queues.get(projectId) || [];
  q.push(mission);
  queues.set(projectId, q);
  if (active.has(projectId)) {
    await postMessage({ project_id: projectId, mission_id: mission.id, author_type: 'agent', agent_id: project.manager_id, kind: 'status', content: `Queued. I will start this after the current mission (${q.length} waiting).` });
  } else {
    pump(projectId);
  }
  return userMsg;
}

function pump(projectId) {
  if (active.has(projectId)) return;
  const q = queues.get(projectId) || [];
  const next = q.shift();
  if (!next) return;
  const controller = new AbortController();
  active.set(projectId, { missionId: next.id, controller });
  runMission(next, controller.signal)
    .catch((err) => console.error('[mission]', err))
    .finally(async () => {
      active.delete(projectId);
      if (!(queues.get(projectId) || []).length) await setProjectStatus(projectId, 'idle').catch(() => {});
      pump(projectId);
    });
}

// topicId: where /stop was typed. Without it the reply goes to the running mission's topic.
export async function cancelMission(projectId, topicId = null) {
  const a = active.get(projectId);
  queues.set(projectId, []);
  const project = await getProject(projectId);
  if (!a) {
    await postMessage({ project_id: projectId, topic_id: (await ensureTopic(projectId, topicId)).id, author_type: 'agent', agent_id: project?.manager_id, kind: 'status', content: 'Nothing is running.' });
    return false;
  }
  a.controller.abort();
  // mission_id stays off a reply posted in another topic, so mission messages always share the mission's topic.
  await postMessage({ project_id: projectId, mission_id: topicId ? null : a.missionId, topic_id: topicId, author_type: 'agent', agent_id: project?.manager_id, kind: 'status', content: 'Stopping all agents on this mission.' });
  return true;
}

// ---- planning & staffing -------------------------------------------------

// Context is scoped to the mission's topic: a brand-new topic sends no prior missions at all.
async function plan({ project, gm, mission, topic, history, signal }) {
  const agents = await listAgents();
  const model = await resolveModel(gm.model_id);
  const { system, prompt } = planPrompt({ project, gm, command: mission.command, attachments: mission.attachments, agents, topic: topicContext(topic, history) });
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

/** Name an untitled topic after its first order, or move a clearly unrelated order (and its mission) into a new topic. */
async function assignTopic({ project, gm, mission, topic, history, p, settings }) {
  const t = p.topic && typeof p.topic === 'object' ? p.topic : {};
  const title = topicTitle(t.title) || topicTitle(mission.command);
  const tags = Array.isArray(t.tags) ? t.tags.slice(0, 3) : undefined;
  if (!history.length || t.new !== true || settings.orchestrator.autoTopics === false) {
    if (!topic.title_locked && (!history.length || topic.title === 'New topic')) await updateTopic(topic.id, { title, tags });
    return;
  }
  const fresh = await createTopic({ project_id: project.id, title, tags });
  await query(`UPDATE missions SET topic_id = $2 WHERE id = $1`, [mission.id, fresh.id]);
  const moved = await many(`UPDATE messages SET topic_id = $2 WHERE mission_id = $1 RETURNING id`, [mission.id, fresh.id]);
  mission.topic_id = fresh.id;
  emit('topic:new', { ...(await getTopic(fresh.id)), moved_from: topic.id, mission_id: mission.id });
  emit('topic:moved', { project_id: project.id, mission_id: mission.id, moved_from: topic.id, topic_id: fresh.id, message_ids: moved.map((m) => m.id) });
  await postMessage({ project_id: project.id, topic_id: topic.id, author_type: 'agent', agent_id: gm.id, kind: 'status', content: `Continued in new topic: ${fresh.title}`, meta: { topic_id: fresh.id } });
  await publishTopic(topic.id);
}

function normalizeTasks(raw, settings) {
  const tasks = (raw || []).slice(0, 20).map((t, i) => ({
    key: String(t.key || `T${i + 1}`).slice(0, 12),
    title: String(t.title || `Task ${i + 1}`).slice(0, 200),
    description: String(t.description || t.title || '').slice(0, 4000),
    role: normalizeRole(t.role),
    skills: (Array.isArray(t.skills) ? t.skills : []).map((s) => String(s).toLowerCase()).slice(0, 8),
    acceptance: (Array.isArray(t.acceptance) ? t.acceptance : []).map(String).slice(0, 10),
    depends_on: (Array.isArray(t.depends_on) ? t.depends_on : []).map(String),
  }));
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

/** Pick, clone or recruit an agent for every task. Returns staffing notes for the chat. */
async function staff(tasks, project) {
  const notes = [];
  const owned = new Map(); // agentId -> [taskKeys]
  const related = ancestors(tasks);
  for (const t of tasks) {
    const pool = (await listAgents()).filter((a) => a.role === t.role).sort((a, b) => skillScore(b, t) - skillScore(a, t));
    let chosen = pool.find((a) => (owned.get(a.id) || []).every((k) => related(k, t.key)) && a.status !== 'working');
    if (!chosen && pool.length) {
      const src = pool[0];
      chosen = await cloneAgent(src.id, `parallel ${t.role} work in ${project.name}`);
      notes.push(`Cloned ${src.name} → ${chosen.name} for parallel ${roleInfo(t.role).title} work`);
      await notify({ source_type: 'manager', source_name: project.manager_name, project_id: project.id, agent_id: chosen.id, title: `${chosen.name} cloned from ${src.name}`, body: `For "${t.title}"` });
    }
    if (!chosen) {
      chosen = await createAgent({ role: t.role, skills: t.skills.length ? t.skills : undefined, mission: `Specialist recruited for ${project.name}: ${t.title}` });
      notes.push(`Recruited new agent ${chosen.name} (${chosen.title})`);
      await notify({ source_type: 'manager', source_name: project.manager_name, project_id: project.id, agent_id: chosen.id, level: 'success', title: `New agent ${chosen.name} · ${chosen.title}`, body: `Created for "${t.title}"` });
    }
    owned.set(chosen.id, [...(owned.get(chosen.id) || []), t.key]);
    t.agent_id = chosen.id;
    t.agent_name = chosen.name;
  }
  return notes;
}

// ---- mission -------------------------------------------------------------

async function runMission(mission, signal) {
  const settings = await getSettings();
  let project = await getProject(mission.project_id);
  const gm = await getAgent(project.manager_id);
  await setProjectStatus(project.id, 'running');
  await setAgentStatus(gm.id, 'working');
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

    if (!tasks.length) {
      await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'chat', content: p.reply || p.analysis || 'Done.' });
      await query(`UPDATE missions SET status='done', plan=$2, summary=$3, finished_at=now() WHERE id=$1`, [mission.id, p, p.reply || '']);
      await publishMission(mission.id);
      return;
    }

    const notes = await staff(tasks, project);
    const rows = [];
    for (const t of tasks) {
      rows.push(await one(
        `INSERT INTO tasks(project_id, mission_id, key, title, description, role, skills, acceptance, depends_on, agent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [project.id, mission.id, t.key, t.title, t.description, t.role, JSON.stringify(t.skills), JSON.stringify(t.acceptance), JSON.stringify(t.depends_on), t.agent_id],
      ));
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
    const lines = final.map((t) => `- ${t.status === 'done' ? '✓' : t.status === 'cancelled' ? '⊘' : '✗'} **${t.key} ${t.title}** — ${t.agent_name || '—'}: ${(t.report?.summary || t.result || t.status).split('\n')[0].slice(0, 220)}`);

    // GitHub: upload the result when files may have changed. Any agent on an edit-capable provider
    // (canEdit: Claude Code, Codex CLI) can edit files, and syncProject is a no-op on a clean tree,
    // so role access is not checked here.
    const editProviders = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].canEdit);
    const wrote = !!(await one(
      `SELECT 1 FROM runs r JOIN models m ON m.id = r.model_id JOIN tasks t ON t.id = r.task_id
       WHERE r.mission_id = $1 AND r.status = 'done' AND m.provider = ANY($2::text[]) AND t.status = 'done' LIMIT 1`, [mission.id, editProviders]));
    project = await getProject(project.id);
    let github = '';
    if (wrote && project.auto_sync && settings.github.autoSync && !signal.aborted) {
      const log = await syncProject(project, commitMessageBuilder({ project, gm, mission, tasks: final, signal }), settings.github);
      github = `\n\n${syncReport(log)}`;
    }

    // Measured after the sync so the GM's commit-message run is counted too.
    const usage = await one(`SELECT coalesce(sum(input_tokens + output_tokens),0) AS tokens, coalesce(sum(cost_usd),0) AS cost FROM runs WHERE mission_id = $1`, [mission.id]);
    const secs = Math.round((Date.now() - started) / 1000);
    const summary = `**Mission ${status}** · ${done}/${final.length} tasks · ${fmtDuration(secs)} · ${Number(usage.tokens).toLocaleString()} tokens\n\n${lines.join('\n')}${github}`;

    await query(`UPDATE missions SET status=$2, summary=$3, finished_at=now() WHERE id=$1`, [mission.id, status, summary]);
    await publishMission(mission.id);
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'summary', content: summary, meta: { status, done, total: final.length } });
    await notify({
      source_type: 'manager', source_name: gm.name, agent_id: gm.id, project_id: project.id,
      level: status === 'done' ? 'success' : status === 'cancelled' ? 'warning' : 'error',
      title: `${project.name}: mission ${status} (${done}/${final.length})`, body: mission.command.slice(0, 160),
    });
    await audit(gm.name, `mission.${status}`, project.name, { missionId: mission.id });
    analyzeMission(mission.id).catch((e) => console.error('[evolution]', e.message));
  } catch (err) {
    const status = signal.aborted ? 'cancelled' : 'failed';
    await query(`UPDATE missions SET status=$2, summary=$3, finished_at=now() WHERE id=$1`, [mission.id, status, err.message]);
    await query(`UPDATE tasks SET status='cancelled', finished_at=now() WHERE mission_id=$1 AND status IN ('pending','running')`, [mission.id]);
    refreshProject(project.id);
    await publishMission(mission.id);
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: status === 'cancelled' ? 'status' : 'error', content: status === 'cancelled' ? 'Mission cancelled.' : `Mission failed: ${err.message}` });
  } finally {
    await setAgentStatus(gm.id, 'idle');
    await publishProject(project.id).catch(() => {});
    await publishTopic(mission.topic_id).catch(() => {});
  }
}

const fmtDuration = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

async function schedule({ rows, project, gm, mission, settings, signal }) {
  const state = Object.fromEntries(rows.map((r) => [r.key, r]));
  const running = new Map();
  const limit = Math.max(1, settings.orchestrator.maxParallel || 3);
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
    for (const t of ready) {
      if (running.size >= limit) break;
      t.status = 'running';
      const p = runTask({ task: t, state, project, gm, mission, settings, signal })
        .then((status) => { t.status = status; })
        .catch((err) => { t.status = 'failed'; console.error('[task]', err.message); })
        .finally(() => running.delete(t.key));
      running.set(t.key, p);
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }
  if (signal.aborted) {
    await Promise.allSettled(running.values());
    await query(`UPDATE tasks SET status='cancelled', finished_at=now() WHERE mission_id=$1 AND status IN ('pending','running')`, [mission.id]);
    refreshProject(project.id);
  }
}

async function runTask({ task, state, project, gm, mission, settings, signal, attempt = 1 }) {
  let agent = await getAgent(task.agent_id);
  // The assigned agent is busy elsewhere: duplicate it rather than wait.
  if (agent.status === 'working' && agent.current_task_id && agent.current_task_id !== task.id) {
    const clone = await cloneAgent(agent.id, 'busy in another mission');
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'status', content: `${agent.name} is busy — cloned ${clone.name} for ${task.key}.` });
    agent = clone;
    await query(`UPDATE tasks SET agent_id=$2 WHERE id=$1`, [task.id, agent.id]);
  }
  await query(`UPDATE tasks SET status='running', started_at=now(), progress=5 WHERE id=$1`, [task.id]);
  await setAgentStatus(agent.id, 'working', task.id);
  await publishTask(task.id);
  refreshProject(project.id);

  const deps = await many(`SELECT t.*, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.mission_id = $1 AND t.key = ANY($2)`, [mission.id, task.depends_on]);
  const playbook = agent.stats?.experiment?.playbook || agent.playbook;
  const { system, prompt } = taskPrompt({ project, agent, task: { ...task, acceptance: task.acceptance }, gm, supervisor: agent.supervisor_name, deps, mission, attachments: mission.attachments, playbook });
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
    await setAgentStatus(agent.id, 'idle');
    await publishTask(task.id);
    refreshProject(project.id);
    return 'cancelled';
  }

  const status = ok ? 'done' : 'failed';
  await query(`UPDATE tasks SET status=$2, progress=$3, result=$4, report=$5, finished_at=now() WHERE id=$1`,
    [task.id, status, ok ? 100 : 0, String(report.summary || out?.text || errorText || '').slice(0, 8000), report]);
  await setAgentStatus(agent.id, 'idle');
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
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: agent.id, kind: 'proposal', content: `${prop.title}${prop.description ? `\n\n${prop.description}` : ''}`, meta: { task_id: row.id, role: row.role } });
    if (settings.orchestrator.autoApproveProposals) await approveProposal(row.id);
  }

  if (!ok && attempt === 1 && settings.orchestrator.retryFailed && !errorText?.includes('limit reached')) {
    await postMessage({ project_id: project.id, mission_id: mission.id, author_type: 'agent', agent_id: gm.id, kind: 'status', content: `${task.key} failed — asking ${agent.name} to retry once with the failure context.` });
    task.description = `${task.description}\n\nPREVIOUS ATTEMPT FAILED:\n${String(report.summary || errorText).slice(0, 1500)}\nFix the cause and complete the task.`;
    await query(`UPDATE tasks SET description=$2, status='running' WHERE id=$1`, [task.id, task.description]);
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

export async function approveProposal(taskId) {
  const t = await one(`SELECT t.*, m.topic_id FROM tasks t LEFT JOIN missions m ON m.id = t.mission_id WHERE t.id = $1 AND t.status = 'proposed'`, [taskId]);
  if (!t) throw new Error('proposal not found');
  await query(`UPDATE tasks SET status='cancelled', result='Approved → new mission' WHERE id=$1`, [taskId]);
  await publishTask(taskId);
  return submitCommand(t.project_id, { content: `${t.title}\n\n${t.description || ''}`.trim(), topicId: t.topic_id });
}

export async function rejectProposal(taskId) {
  await query(`UPDATE tasks SET status='cancelled', result='Rejected' WHERE id=$1 AND status='proposed'`, [taskId]);
  return publishTask(taskId);
}

export async function standup(projectId, topicId = null) {
  const project = await getProject(projectId);
  const topic = await ensureTopic(projectId, topicId);
  const rows = await many(
    `SELECT DISTINCT ON (a.id) a.name, a.title, a.status, t.key, t.title AS task, t.status AS task_status, t.progress
     FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE t.project_id = $1 ORDER BY a.id, t.created_at DESC`, [projectId]);
  const blockers = rows.filter((r) => ['failed', 'cancelled'].includes(r.task_status));
  const body = rows.length
    ? rows.map((r) => `- **${r.name}** (${r.title}) · ${r.status} — last: ${r.key} ${r.task} · ${r.task_status}${r.task_status === 'running' ? ` ${r.progress}%` : ''}`).join('\n')
    : '- No agents have worked on this project yet.';
  return postMessage({
    project_id: projectId, topic_id: topic.id, author_type: 'agent', agent_id: project.manager_id, kind: 'meeting',
    content: `**Stand-up · ${project.name}**\n\n${body}\n\n**Blockers:** ${blockers.length ? blockers.map((b) => `${b.key} (${b.name})`).join(', ') : 'none'}\n**Next:** ${active.has(projectId) ? 'mission in progress' : 'awaiting your next order'}`,
  });
}

export async function syncNow(projectId, reason, topicId = null) {
  const project = await getProject(projectId);
  const settings = await getSettings();
  const gm = project.manager_id ? await getAgent(project.manager_id) : null;
  const log = await syncProject(project, commitMessageBuilder({ project, gm, mission: null, reason }), settings.github);
  const content = syncReport(log);
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
}

export { publishAgent };
