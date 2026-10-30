import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import { emit } from '../events.js';
import { getSettings, sanitizeMonitor } from '../db/seed.js';
import { ROLES, TIERS } from '../roles.js';
import { listAgents, getAgent, createAgent, cloneAgent, publishAgent } from '../services/agents.js';
import { listProjects, getProject, createProjectRecord, publishProject } from '../services/projects.js';
import { listTopics, getTopic, createTopic, updateTopic, deleteTopic, isUuid } from '../services/topics.js';
import { notify, audit } from '../services/notify.js';
import { gitInfo } from '../services/git.js';
import { disposePreview } from '../services/runner.js';
import { listModels, publishModels, PROVIDERS, runModel, recordRunUsage } from '../models/index.js';
import { submitCommand, cancelMission, standup, syncNow, approveProposal, rejectProposal } from '../orchestrator/engine.js';
import { evolutionOverview, analyzeMission } from '../orchestrator/evolution.js';

const err = (reply, code, message) => reply.code(code).send({ error: message });

// opts.onSettingsChange(key, value) lets the server react to a saved setting without a restart.
export default async function apiRoutes(app, opts = {}) {
  // ---- projects ----------------------------------------------------------
  app.get('/api/projects', () => listProjects());

  app.post('/api/projects', async (req, reply) => {
    const { name, path: dir, github_url, description } = req.body || {};
    if (!name?.trim()) return err(reply, 400, 'Name is required');
    if (!dir?.trim() || !path.isAbsolute(dir.trim().replace(/^~/, '/root'))) return err(reply, 400, 'An absolute work path is required');
    if (github_url && !/^(https:\/\/|git@)[\w.@:/~-]+$/.test(github_url.trim())) return err(reply, 400, 'GitHub URL looks invalid');
    const p = await createProjectRecord({ name: name.trim(), path: dir.trim().replace(/^~(?=$|\/)/, process.env.HOME || '/root'), github_url: github_url?.trim(), description: description?.trim() });
    await notify({ source_type: 'admin', source_name: 'Admin', project_id: p.id, level: 'success', title: `Project created · ${p.name}`, body: `${p.manager_name} assigned as General Manager` });
    await audit('user', 'project.create', p.name);
    return p;
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const p = await getProject(req.params.id);
    if (!p) return err(reply, 404, 'Not found');
    const b = req.body || {};
    // Run & preview settings: undefined keeps the current value, '' or null clears it (auto-detect).
    const text = (v, cur) => (v === undefined ? cur : String(v ?? '').trim() || null);
    const port = b.preview_port === undefined ? p.preview_port : b.preview_port === null || String(b.preview_port).trim() === '' ? null : Number(b.preview_port);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535 || port === config.port)) return err(reply, 400, 'Preview port must be a free port number between 1 and 65535');
    const fields = { name: b.name?.trim() || p.name, github_url: b.github_url === undefined ? p.github_url : b.github_url?.trim() || null, description: b.description ?? p.description, auto_sync: b.auto_sync ?? p.auto_sync, path: b.path?.trim() || p.path,
      run_command: text(b.run_command, p.run_command), preview_port: port, preview_path: text(b.preview_path, p.preview_path) };
    await query(`UPDATE projects SET name=$2, github_url=$3, description=$4, auto_sync=$5, path=$6, run_command=$7, preview_port=$8, preview_path=$9, updated_at=now() WHERE id=$1`,
      [p.id, fields.name, fields.github_url, fields.description, fields.auto_sync, fields.path, fields.run_command, fields.preview_port, fields.preview_path]);
    return publishProject(p.id);
  });

  app.post('/api/projects/delete', async (req, reply) => {
    const ids = req.body?.ids || [];
    const rows = await many(`SELECT id, name, protected, manager_id FROM projects WHERE id = ANY($1)`, [ids]);
    const deleted = [];
    const refused = [];
    for (const p of rows) {
      if (p.protected) { refused.push(p.name); continue; }
      await cancelMission(p.id).catch(() => {});
      await disposePreview(p.id).catch(() => {});
      await query(`DELETE FROM projects WHERE id = $1`, [p.id]);
      if (p.manager_id) await query(`UPDATE agents SET archived = true WHERE id = $1`, [p.manager_id]);
      emit('project:delete', { id: p.id });
      if (p.manager_id) emit('agent:delete', { id: p.manager_id });
      deleted.push(p.name);
      await audit('user', 'project.delete', p.name);
    }
    return { deleted, refused };
  });

  // Optional ?topic=<id> narrows to one topic thread; without it the whole project chat is returned.
  app.get('/api/projects/:id/messages', async (req, reply) => {
    const topic = req.query.topic || null;
    if (topic && !isUuid(topic)) return err(reply, 400, 'Invalid topic id');
    return many(
      `SELECT * FROM (SELECT m.*, a.name AS agent_name, a.role AS agent_role, a.title AS agent_title FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
       WHERE m.project_id = $1${topic ? ' AND m.topic_id = $3' : ''} ORDER BY m.created_at DESC LIMIT $2) x ORDER BY created_at`,
      [req.params.id, Math.min(1000, Number(req.query.limit) || 300), ...(topic ? [topic] : [])]);
  });

  app.get('/api/projects/:id/tasks', async (req) => many(
    `SELECT t.*, a.name AS agent_name, a.role AS agent_role FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
     WHERE t.project_id = $1 ORDER BY t.created_at DESC LIMIT 150`, [req.params.id]));

  app.post('/api/projects/:id/command', async (req, reply) => {
    const { content, attachments, topic_id } = req.body || {};
    if (!content?.trim() && !attachments?.length) return err(reply, 400, 'Empty command');
    return submitCommand(req.params.id, { content: content || '(see attached images)', attachments: attachments || [], topicId: topic_id || null });
  });
  app.post('/api/projects/:id/cancel', (req) => cancelMission(req.params.id).then((ok) => ({ ok })));
  app.post('/api/projects/:id/standup', (req) => standup(req.params.id, req.body?.topic_id || null));
  app.post('/api/projects/:id/sync', (req) => syncNow(req.params.id, 'Manual sync from AgentForge'));
  app.get('/api/projects/:id/git', async (req, reply) => {
    const p = await getProject(req.params.id);
    if (!p) return err(reply, 404, 'Not found');
    return { ...(await gitInfo(p.path)), logs: await many(`SELECT * FROM sync_logs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`, [p.id]) };
  });

  // ---- topics (chat threads) ---------------------------------------------
  app.get('/api/projects/:id/topics', async (req, reply) => {
    if (!isUuid(req.params.id)) return err(reply, 404, 'Not found');
    return listTopics(req.params.id);
  });

  app.post('/api/projects/:id/topics', async (req, reply) => {
    if (!isUuid(req.params.id) || !(await one(`SELECT 1 FROM projects WHERE id = $1`, [req.params.id]))) return err(reply, 404, 'Not found');
    const { title, tags } = req.body || {};
    const named = typeof title === 'string' && !!title.trim();
    const t = await createTopic({ project_id: req.params.id, title: named ? title : undefined, tags, title_locked: named });
    emit('topic:new', t);
    return t;
  });

  app.patch('/api/topics/:id', async (req, reply) => {
    const t = await getTopic(req.params.id);
    if (!t) return err(reply, 404, 'Not found');
    const { title, tags, archived } = req.body || {};
    if (title !== undefined && !String(title ?? '').trim()) return err(reply, 400, 'Title cannot be empty');
    // A human rename pins the title so the manager stops auto-naming the topic.
    return updateTopic(t.id, { title, tags, archived, title_locked: title !== undefined ? true : undefined });
  });

  app.delete('/api/topics/:id', async (req, reply) => {
    const t = await getTopic(req.params.id);
    if (!t) return err(reply, 404, 'Not found');
    if (t.running) return err(reply, 409, 'This topic has a mission in progress');
    await deleteTopic(t.id);
    return { ok: true };
  });

  app.post('/api/tasks/:id/approve', (req) => approveProposal(req.params.id));
  app.post('/api/tasks/:id/reject', (req) => rejectProposal(req.params.id));

  // ---- agents ------------------------------------------------------------
  app.get('/api/roles', () => ({ roles: ROLES, tiers: TIERS }));
  app.get('/api/agents', () => listAgents());

  app.get('/api/agents/:id', async (req, reply) => {
    const a = await getAgent(req.params.id);
    if (!a) return err(reply, 404, 'Not found');
    const [tasks, experiences, versions, runs] = await Promise.all([
      many(`SELECT t.id, t.key, t.title, t.status, t.progress, t.started_at, t.finished_at, t.created_at, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.agent_id = $1 ORDER BY t.created_at DESC LIMIT 40`, [a.id]),
      many(`SELECT * FROM experiences WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 30`, [a.id]),
      many(`SELECT version, reason, created_at FROM agent_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 20`, [a.id]),
      many(`SELECT id, kind, status, model_id, input_tokens, output_tokens, cost_usd, tool_calls, duration_ms, created_at, finished_at FROM runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 30`, [a.id]),
    ]);
    const current = a.current_task_id ? await one(`SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [a.current_task_id]) : null;
    const reports = await many(`SELECT id, name, role, title, status, level FROM agents WHERE supervisor_id = $1 AND NOT archived`, [a.id]);
    return { ...a, tasks, experiences, versions, runs, current, reportsList: reports };
  });

  // Latest run + its event stream, for the live "thinking" pane.
  app.get('/api/agents/:id/live', async (req) => {
    const run = await one(`SELECT r.*, t.title AS task_title, t.key AS task_key FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.agent_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [req.params.id]);
    if (!run) return { run: null, events: [] };
    const events = await many(`SELECT * FROM (SELECT id, ts, type, data FROM run_events WHERE run_id = $1 ORDER BY id DESC LIMIT 400) x ORDER BY id`, [run.id]);
    return { run, events };
  });

  app.post('/api/agents', async (req, reply) => {
    const b = req.body || {};
    if (!b.role) return err(reply, 400, 'Role is required');
    const a = await createAgent({ role: b.role, title: b.title, skills: b.skills, supervisor_id: b.supervisor_id || undefined, mission: b.mission, purpose: b.purpose, model_id: b.model_id || null });
    await notify({ source_type: 'admin', source_name: 'Admin', agent_id: a.id, title: `Agent created · ${a.name}`, body: a.title });
    return a;
  });

  app.patch('/api/agents/:id', async (req, reply) => {
    const b = req.body || {};
    if ('name' in b) return err(reply, 400, 'Agent names are system-managed and cannot be edited');
    const a = await getAgent(req.params.id);
    if (!a) return err(reply, 404, 'Not found');
    if (b.supervisor_id === a.id) return err(reply, 400, 'An agent cannot supervise itself');
    await query(
      `UPDATE agents SET skills=$2, supervisor_id=$3, mission=$4, purpose=$5, model_id=$6, title=$7, updated_at=now() WHERE id=$1`,
      [a.id, JSON.stringify(b.skills ?? a.skills), b.supervisor_id === undefined ? a.supervisor_id : b.supervisor_id || null, b.mission ?? a.mission, b.purpose ?? a.purpose,
        b.model_id === undefined ? a.model_id : b.model_id || null, b.title || a.title],
    );
    return publishAgent(a.id);
  });

  app.post('/api/agents/:id/clone', async (req) => cloneAgent(req.params.id, 'manual clone'));

  app.delete('/api/agents/:id', async (req, reply) => {
    const a = await getAgent(req.params.id);
    if (!a) return err(reply, 404, 'Not found');
    if (a.role === 'executive') return err(reply, 400, 'The executive agent cannot be removed');
    if (await one(`SELECT 1 FROM projects WHERE manager_id = $1`, [a.id])) return err(reply, 400, 'This agent manages a project');
    if (a.status === 'working') return err(reply, 409, 'Agent is working');
    await query(`UPDATE agents SET supervisor_id = $2 WHERE supervisor_id = $1`, [a.id, a.supervisor_id]);
    await query(`UPDATE agents SET archived = true, status = 'offline' WHERE id = $1`, [a.id]);
    emit('agent:delete', { id: a.id });
    await audit('user', 'agent.archive', a.name);
    return { ok: true };
  });

  // ---- models ------------------------------------------------------------
  app.get('/api/models', () => listModels());
  app.get('/api/providers', () => Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, canEdit: v.canEdit }])));

  app.post('/api/models', async (req, reply) => {
    const b = req.body || {};
    if (!b.name || !PROVIDERS[b.provider]) return err(reply, 400, 'Name and a valid provider are required');
    const id = `${b.provider}-${String(b.model || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60) + '-' + crypto.randomBytes(2).toString('hex');
    await query(`INSERT INTO models(id, name, provider, model, base_url, api_key, limits, config) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, b.name, b.provider, b.model || null, b.base_url || null, b.api_key || null, b.limits || {}, b.config || {}]);
    await publishModels();
    return { id };
  });

  app.patch('/api/models/:id', async (req, reply) => {
    const m = await one(`SELECT * FROM models WHERE id = $1`, [req.params.id]);
    if (!m) return err(reply, 404, 'Not found');
    const b = req.body || {};
    await query(`UPDATE models SET name=$2, model=$3, base_url=$4, api_key=$5, limits=$6, config=$7, enabled=$8 WHERE id=$1`,
      [m.id, b.name ?? m.name, b.model ?? m.model, b.base_url ?? m.base_url, b.api_key ? b.api_key : m.api_key, { ...m.limits, ...(b.limits || {}) }, { ...m.config, ...(b.config || {}) }, b.enabled ?? m.enabled]);
    await publishModels();
    return { ok: true };
  });

  app.post('/api/models/:id/default', async (req) => {
    await query(`UPDATE models SET is_default = (id = $1)`, [req.params.id]);
    await publishModels();
    return { ok: true };
  });

  app.delete('/api/models/:id', async (req, reply) => {
    const left = await one(`SELECT count(*)::int AS n FROM models WHERE enabled AND id <> $1`, [req.params.id]);
    if (!left.n) return err(reply, 400, 'Keep at least one enabled model');
    const m = await one(`DELETE FROM models WHERE id = $1 RETURNING is_default`, [req.params.id]);
    if (m?.is_default) await query(`UPDATE models SET is_default = true WHERE id = (SELECT id FROM models WHERE enabled ORDER BY created_at LIMIT 1)`);
    await publishModels();
    return { ok: true };
  });

  app.post('/api/models/:id/test', async (req, reply) => {
    const m = await one(`SELECT * FROM models WHERE id = $1`, [req.params.id]);
    if (!m) return err(reply, 404, 'Not found');
    const run = await one(`INSERT INTO runs(model_id, kind) VALUES ($1,'test') RETURNING id`, [m.id]);
    try {
      const out = await runModel(m, { prompt: 'Reply with exactly: OK', cwd: config.dataDir, access: 'read', timeoutMs: 120000, meta: { kind: 'test', title: 'connectivity test' } });
      await recordRunUsage(run.id, out);
      await query(`UPDATE runs SET status='done', output=$2, finished_at=now() WHERE id=$1`, [run.id, out.text]);
      await publishModels();
      return { ok: true, text: String(out.text).slice(0, 200), ms: out.durationMs, usage: out.usage };
    } catch (e) {
      await query(`UPDATE runs SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [run.id, e.message]);
      return { ok: false, error: e.message };
    }
  });

  // ---- notifications -----------------------------------------------------
  app.get('/api/notifications', async (req) => many(
    `SELECT n.*, p.name AS project_name FROM notifications n LEFT JOIN projects p ON p.id = n.project_id ORDER BY n.created_at DESC LIMIT $1`,
    [Math.min(500, Number(req.query.limit) || 150)]));
  app.post('/api/notifications', async (req, reply) => {
    const { title, body, level = 'info', project_id = null } = req.body || {};
    if (!title?.trim()) return err(reply, 400, 'Title is required');
    return notify({ source_type: 'admin', source_name: 'Admin', title: title.trim(), body, level, project_id });
  });
  app.post('/api/notifications/read', async (req) => {
    const ids = req.body?.ids;
    if (ids?.length) await query(`UPDATE notifications SET read = true WHERE id = ANY($1)`, [ids]);
    else await query(`UPDATE notifications SET read = true WHERE NOT read`);
    emit('notification:read', { ids: ids || 'all' });
    return { ok: true };
  });
  app.delete('/api/notifications/:id', async (req) => {
    await query(`DELETE FROM notifications WHERE id = $1`, [req.params.id]);
    emit('notification:delete', { id: req.params.id });
    return { ok: true };
  });

  // ---- settings ----------------------------------------------------------
  app.get('/api/settings', () => getSettings());
  app.put('/api/settings/:key', async (req, reply) => {
    const allowed = ['orchestrator', 'github', 'evolution', 'monitor'];
    if (!allowed.includes(req.params.key)) return err(reply, 400, 'Unknown settings key');
    const cur = (await getSettings())[req.params.key] || {};
    let value = { ...cur, ...(req.body || {}) };
    if (req.params.key === 'monitor') value = sanitizeMonitor(value, sanitizeMonitor(cur));
    await query(`INSERT INTO settings(key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [req.params.key, value]);
    emit('settings:update', { key: req.params.key, value });
    opts.onSettingsChange?.(req.params.key, value);
    return value;
  });

  // ---- github ------------------------------------------------------------
  app.get('/api/github', async () => {
    const projects = await listProjects();
    const withGit = await Promise.all(projects.map(async (p) => ({ id: p.id, name: p.name, path: p.path, github_url: p.github_url, auto_sync: p.auto_sync, protected: p.protected, last_synced_at: p.last_synced_at, git: await gitInfo(p.path) })));
    const logs = await many(`SELECT l.*, p.name AS project_name FROM sync_logs l LEFT JOIN projects p ON p.id = l.project_id ORDER BY l.created_at DESC LIMIT 40`);
    return { settings: (await getSettings()).github, projects: withGit, logs };
  });

  // ---- uploads (command window images) -----------------------------------
  app.post('/api/uploads', async (req, reply) => {
    const out = [];
    for await (const part of req.files()) {
      const ext = path.extname(part.filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
      const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      const file = path.join(config.uploadsDir, id);
      await pipeline(part.file, fs.createWriteStream(file));
      const size = (await fsp.stat(file)).size;
      out.push({ id, name: part.filename, mime: part.mimetype, size, url: `/uploads/${id}`, path: file });
    }
    if (!out.length) return err(reply, 400, 'No files');
    return out;
  });

  // ---- evolution ---------------------------------------------------------
  app.get('/api/evolution', () => evolutionOverview());
  app.post('/api/evolution/cycle', async () => {
    const missions = await many(`SELECT id FROM missions WHERE status IN ('done','failed') ORDER BY created_at DESC LIMIT 5`);
    for (const m of missions) await analyzeMission(m.id);
    return evolutionOverview();
  });

  // ---- dashboard ---------------------------------------------------------
  app.get('/api/dashboard', async () => {
    const [counts, activity, leaders, throughput, statusDist] = await Promise.all([
      one(`SELECT
        (SELECT count(*)::int FROM projects) AS projects,
        (SELECT count(*)::int FROM projects WHERE status = 'running') AS projects_running,
        (SELECT count(*)::int FROM agents WHERE NOT archived) AS agents,
        (SELECT count(*)::int FROM agents WHERE status = 'working') AS agents_working,
        (SELECT count(*)::int FROM tasks WHERE status = 'done' AND finished_at >= date_trunc('day', now())) AS tasks_done_today,
        (SELECT count(*)::int FROM tasks WHERE status = 'failed' AND finished_at >= date_trunc('day', now())) AS tasks_failed_today,
        (SELECT count(*)::int FROM tasks WHERE status = 'running') AS tasks_running,
        (SELECT count(*)::int FROM tasks WHERE status = 'proposed') AS proposals,
        (SELECT coalesce(sum(input_tokens + output_tokens),0) FROM runs WHERE created_at >= date_trunc('day', now())) AS tokens_today,
        (SELECT coalesce(sum(cost_usd),0) FROM runs WHERE created_at >= now() - interval '7 days') AS cost_week,
        (SELECT count(*)::int FROM notifications WHERE NOT read) AS unread`),
      many(`SELECT m.id, m.command, m.status, m.created_at, m.finished_at, p.name AS project_name, p.id AS project_id,
              (SELECT count(*)::int FROM tasks t WHERE t.mission_id = m.id) AS tasks,
              (SELECT count(*)::int FROM tasks t WHERE t.mission_id = m.id AND t.status = 'done') AS done
            FROM missions m JOIN projects p ON p.id = m.project_id ORDER BY m.created_at DESC LIMIT 12`),
      many(`SELECT id, name, role, title, level, xp, status, stats FROM agents WHERE NOT archived ORDER BY xp DESC, level DESC LIMIT 6`),
      many(`SELECT to_char(d, 'MM-DD') AS day,
              (SELECT count(*)::int FROM tasks t WHERE t.status='done' AND t.finished_at >= d AND t.finished_at < d + interval '1 day') AS done,
              (SELECT count(*)::int FROM tasks t WHERE t.status='failed' AND t.finished_at >= d AND t.finished_at < d + interval '1 day') AS failed,
              (SELECT coalesce(sum(input_tokens + output_tokens),0) FROM runs r WHERE r.created_at >= d AND r.created_at < d + interval '1 day') AS tokens
            FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d ORDER BY d`),
      many(`SELECT status, count(*)::int AS n FROM tasks GROUP BY status`),
    ]);
    return { counts, activity, leaders, throughput, statusDist };
  });
}
