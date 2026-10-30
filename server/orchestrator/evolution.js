// Self-evolution layer: Observe → Diagnose → Generate → Experiment → Evaluate → Promote.
// Every change is versioned (agent_versions) and reversible; nothing edits production
// instructions without passing an evaluation window first.
import { one, many, query } from '../db/pool.js';
import { emit } from '../events.js';
import { publishAgent } from '../services/agents.js';
import { notify } from '../services/notify.js';

const EVAL_WINDOW = 3;

async function event(stage, agentId, title, detail = {}) {
  const row = await one(`INSERT INTO evolution_events(stage, agent_id, title, detail) VALUES ($1,$2,$3,$4) RETURNING *`, [stage, agentId, title, detail]);
  emit('evolution:event', row);
  return row;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function levelFor(xp) {
  return 1 + Math.floor(Math.sqrt(xp / 40));
}

async function recentOutcomes(agentId, n) {
  const rows = await many(`SELECT status FROM tasks WHERE agent_id = $1 AND status IN ('done','failed') ORDER BY finished_at DESC LIMIT $2`, [agentId, n]);
  return rows.map((r) => r.status === 'done');
}

const rate = (arr) => (arr.length ? arr.filter(Boolean).length / arr.length : 1);

/** Called after every task: experience, skills, XP, playbook versions, running experiments. */
export async function learn({ agent, task, report, ok, out, settings, project }) {
  const a = await one(`SELECT * FROM agents WHERE id = $1`, [agent.id]);
  if (!a) return;
  const conf = Math.max(0, Math.min(1, Number(report?.confidence ?? 0.6)));
  const xp = a.xp + (ok ? 20 + Math.round(conf * 10) : 6);
  const level = levelFor(xp);

  // Skill growth: practiced skills improve, new ones are acquired.
  const skills = [...a.skills];
  for (const name of (task.skills || []).map((s) => String(s).toLowerCase())) {
    const s = skills.find((k) => k.name === name);
    if (s) s.level = Math.min(100, s.level + (ok ? 2 : 1));
    else skills.push({ name, level: ok ? 22 : 12, learnedAt: new Date().toISOString() });
  }

  const st = { ...a.stats };
  st.tasksDone = (st.tasksDone || 0) + (ok ? 1 : 0);
  st.tasksFailed = (st.tasksFailed || 0) + (ok ? 0 : 1);
  st.projects = [...new Set([...(st.projects || []), project.name])].slice(-50);

  // Memory: lessons and failures become episodic experience.
  if (report?.lesson) {
    await query(`INSERT INTO experiences(agent_id, project_id, task_id, kind, content, score) VALUES ($1,$2,$3,'lesson',$4,$5)`,
      [a.id, project.id, task.id, String(report.lesson).slice(0, 500), ok ? 0.5 + conf / 2 : 0.3]);
  }
  if (!ok) {
    await query(`INSERT INTO experiences(agent_id, project_id, task_id, kind, content, score) VALUES ($1,$2,$3,'failure',$4,0.8)`,
      [a.id, project.id, task.id, `Failed "${task.title}": ${String(report?.summary || out?.error || 'unknown').slice(0, 400)}`]);
  }

  // Running experiment: count outcomes, then evaluate.
  if (st.experiment) {
    st.experiment.outcomes = [...(st.experiment.outcomes || []), ok];
    if (st.experiment.outcomes.length >= EVAL_WINDOW) {
      const candidateRate = rate(st.experiment.outcomes);
      const exp = st.experiment;
      delete st.experiment;
      await event('evaluate', a.id, `${a.name}: candidate ${Math.round(candidateRate * 100)}% vs baseline ${Math.round(exp.baseline * 100)}%`, { candidateRate, baseline: exp.baseline });
      if (candidateRate >= exp.baseline) {
        await promote(a, exp.playbook, `Experiment won (${Math.round(candidateRate * 100)}% ≥ ${Math.round(exp.baseline * 100)}%)`);
      } else {
        await event('promote', a.id, `${a.name}: candidate rolled back`, { rolledBack: true });
      }
    }
  }

  await query(`UPDATE agents SET xp=$2, level=$3, skills=$4, stats=$5, updated_at=now() WHERE id=$1`, [a.id, xp, level, JSON.stringify(skills), st]);
  if (level > a.level) {
    await notify({ source_type: 'agent', source_name: a.name, agent_id: a.id, level: 'success', title: `${a.name} reached level ${level}`, body: `${a.title} · ${xp} XP` });
  }

  if (settings.evolution?.enabled !== false) await maybeNewPlaybook(a.id, settings);
  await publishAgent(a.id);
}

async function promote(agent, playbook, reason) {
  const version = agent.prompt_version + 1;
  await query(`UPDATE agents SET playbook=$2, prompt_version=$3 WHERE id=$1`, [agent.id, JSON.stringify(playbook), version]);
  await query(`INSERT INTO agent_versions(agent_id, version, playbook, reason) VALUES ($1,$2,$3,$4)`, [agent.id, version, JSON.stringify(playbook), reason]);
  await event('promote', agent.id, `${agent.name}: playbook v${version} promoted`, { reason, size: playbook.length });
}

// Prompt evolution: once enough new lessons accumulate, curate a new playbook version.
async function maybeNewPlaybook(agentId, settings) {
  const a = await one(`SELECT * FROM agents WHERE id = $1`, [agentId]);
  const since = await one(`SELECT max(created_at) AS t FROM agent_versions WHERE agent_id = $1`, [agentId]);
  const fresh = await one(`SELECT count(*)::int AS n FROM experiences WHERE agent_id = $1 AND kind = 'lesson' AND created_at > coalesce($2, 'epoch'::timestamptz)`, [agentId, since.t]);
  if (fresh.n < (settings.evolution?.lessonsPerVersion || 4)) return;
  const lessons = await many(`SELECT content, score FROM experiences WHERE agent_id = $1 AND kind = 'lesson' ORDER BY score DESC, created_at DESC LIMIT 60`, [agentId]);
  const seen = new Set();
  const playbook = [];
  for (const l of lessons) {
    const k = norm(l.content).slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    playbook.push(l.content);
    if (playbook.length >= (settings.evolution?.playbookSize || 8)) break;
  }
  await event('generate', a.id, `Muse drafted playbook v${a.prompt_version + 1} for ${a.name}`, { lessons: playbook.length });
  await promote(a, playbook, `Curated from ${fresh.n} new lessons`);
}

/** Called after each mission: organisation-level observation and diagnosis. */
export async function analyzeMission(missionId) {
  const m = await one(`SELECT * FROM missions WHERE id = $1`, [missionId]);
  if (!m) return;
  const stats = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE t.status='done')::int AS done,
            coalesce(sum(r.input_tokens + r.output_tokens),0) AS tokens, coalesce(sum(r.duration_ms),0) AS ms
     FROM tasks t LEFT JOIN runs r ON r.task_id = t.id WHERE t.mission_id = $1`, [missionId]);
  if (!stats.total) return;
  await event('observe', null, `Gauge observed mission: ${stats.done}/${stats.total} tasks passed`, { missionId, ...stats });

  const agents = await many(`SELECT DISTINCT a.* FROM agents a JOIN tasks t ON t.agent_id = a.id WHERE t.mission_id = $1`, [missionId]);
  for (const a of agents) {
    if (a.stats?.experiment) continue;
    const outcomes = await recentOutcomes(a.id, 6);
    if (outcomes.length < 3) continue;
    const r = rate(outcomes);
    if (r >= 0.67) continue;
    await event('diagnose', a.id, `${a.name}: success rate ${Math.round(r * 100)}% over last ${outcomes.length} tasks`, { rate: r });
    const failures = await many(`SELECT content FROM experiences WHERE agent_id = $1 AND kind = 'failure' ORDER BY created_at DESC LIMIT 4`, [a.id]);
    const candidate = [
      'Before editing, restate the acceptance criteria and check each one explicitly before reporting done.',
      ...failures.map((f) => `Avoid repeating: ${f.content.slice(0, 160)}`),
      ...(a.playbook || []),
    ].slice(0, 10);
    await event('generate', a.id, `Failure-aware playbook candidate for ${a.name}`, { size: candidate.length });
    await query(`UPDATE agents SET stats = stats || $2 WHERE id = $1`, [a.id, { experiment: { playbook: candidate, baseline: r, outcomes: [], startedAt: new Date().toISOString() } }]);
    await event('experiment', a.id, `${a.name} runs candidate playbook for the next ${EVAL_WINDOW} tasks`, {});
    await publishAgent(a.id);
  }
}

export async function evolutionOverview() {
  const [events, versions, top] = await Promise.all([
    many(`SELECT e.*, a.name AS agent_name, a.role AS agent_role FROM evolution_events e LEFT JOIN agents a ON a.id = e.agent_id ORDER BY e.created_at DESC LIMIT 80`),
    many(`SELECT v.agent_id, v.version, v.reason, v.created_at, a.name FROM agent_versions v JOIN agents a ON a.id = v.agent_id ORDER BY v.created_at DESC LIMIT 30`),
    many(`SELECT e.content, e.kind, e.score, e.created_at, a.name AS agent_name, a.role FROM experiences e JOIN agents a ON a.id = e.agent_id ORDER BY e.created_at DESC LIMIT 40`),
  ]);
  return { events, versions, experiences: top };
}
