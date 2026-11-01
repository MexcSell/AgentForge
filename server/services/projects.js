import fs from 'node:fs';
import path from 'node:path';
import { one, many } from '../db/pool.js';
import { emit } from '../events.js';
import { createAgent, cloneAgent, executiveId, publishAgent, withAgentLock } from './agents.js';
import { ensureMembers } from './members.js';

// running_agents: distinct agents working on the project now, i.e. its running tasks' agents plus the GM while a mission plans or runs.
const PROJECT_COLS = `p.*, m.name AS manager_name,
  (SELECT count(w.agent_id)::int FROM (
     SELECT t.agent_id FROM tasks t WHERE t.project_id = p.id AND t.status = 'running'
     UNION SELECT p.manager_id WHERE p.status = 'running' AND EXISTS (SELECT 1 FROM missions s WHERE s.project_id = p.id AND s.status IN ('planning', 'running'))
   ) w(agent_id)) AS running_agents,
  (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS tasks_done,
  (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id) AS tasks_total`;

export async function listProjects() {
  return many(`SELECT ${PROJECT_COLS} FROM projects p LEFT JOIN agents m ON m.id = p.manager_id ORDER BY p.protected DESC, p.created_at`);
}

export async function getProject(id) {
  return one(`SELECT ${PROJECT_COLS} FROM projects p LEFT JOIN agents m ON m.id = p.manager_id WHERE p.id = $1`, [id]);
}

const publishing = new Map(); // projectId -> last publish

// One at a time per project, in call order, so a stale read from parallel tasks can never be the last update.
export function publishProject(id) {
  const run = (publishing.get(id) || Promise.resolve()).then(async () => {
    const p = await getProject(id);
    if (p) emit('project:update', p);
    return p;
  });
  const tail = run.catch(() => {});
  publishing.set(id, tail);
  tail.then(() => { if (publishing.get(id) === tail) publishing.delete(id); });
  return run;
}

export async function setProjectStatus(id, status) {
  await one(`UPDATE projects SET status=$2, updated_at=now() WHERE id=$1 RETURNING id`, [id, status]);
  // The status is saved; a failed publish must not abort the mission that set it.
  return publishProject(id).catch(() => null);
}

const CLAUDE_SETTINGS = {
  permissions: {
    allow: [
      'WebFetch(domain:www.ridges.ai)',
      'WebFetch(domain:ridges.ai)',
      'WebFetch(domain:docs.ridges.ai)',
      'Bash(curl *)',
      'Bash(mkdir -p *)',
      'Bash(curl * https://*.ridges.ai/*)',
    ],
    additionalDirectories: ['/tmp'],
  },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Adds the default Claude Code permissions to <abs>/.claude/settings.local.json, keeping every existing entry; never throws.
function ensureClaudeSettings(abs) {
  const file = path.join(abs, '.claude', 'settings.local.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) return fs.writeFileSync(file, JSON.stringify(CLAUDE_SETTINGS, null, 2) + '\n');
    const text = fs.readFileSync(file, 'utf8');
    let cur;
    try { cur = JSON.parse(text); } catch {}
    const perms = isObject(cur) ? cur.permissions ?? {} : null;
    const allow = perms?.allow ?? [], dirs = perms?.additionalDirectories ?? [];
    if (!isObject(perms) || !Array.isArray(allow) || !Array.isArray(dirs)) return console.warn('[claude settings]', `${file} is not a valid settings object, left untouched`);
    const addAllow = CLAUDE_SETTINGS.permissions.allow.filter((a) => !allow.includes(a));
    const addDirs = CLAUDE_SETTINGS.permissions.additionalDirectories.filter((d) => !dirs.includes(d));
    if (!addAllow.length && !addDirs.length) return;
    cur.permissions = { ...perms, allow: [...allow, ...addAllow], additionalDirectories: [...dirs, ...addDirs] };
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
  } catch (e) {
    console.warn('[claude settings]', e.message);
  }
}

const gmMission = (name) => `Run project "${name}": decompose commands into verifiable tasks, staff them, and report results.`;
const GM_DEFAULTS = {
  role: 'manager',
  purpose: 'Turn intent into shipped, verified software.',
  skills: [{ name: 'planning', level: 70 }, { name: 'decomposition', level: 72 }, { name: 'coordination', level: 70 }],
};

/**
 * The original manager: the oldest live non-clone agent of role 'manager'. With none, one is created with the GM
 * defaults, reporting to the executive. One lookup at a time, so two projects created together share one new original.
 */
export function originalManager() {
  return withAgentLock('original', 'manager', async () => {
    const found = await one(`SELECT id FROM agents WHERE role = 'manager' AND origin <> 'cloned' AND NOT archived ORDER BY created_at, id LIMIT 1`);
    if (found) return found;
    return createAgent({ ...GM_DEFAULTS, supervisor_id: (await executiveId()) || undefined,
      mission: 'Original General Manager: each project runs on a clone of it, merged back when the project is deleted.' });
  });
}

// Every project's General Manager is a clone of the original manager (it reports where the original does, i.e. to the
// executive). Deleting the project merges it back (routes/api.js). manager_id instead names an existing agent to manage
// it (the executive runs the protected AgentForge project itself).
export async function createProjectRecord({ name, path: dir, github_url, description, protected: isProtected = false, manager_id = null }) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  ensureClaudeSettings(abs);
  let gmId = manager_id;
  if (!gmId) {
    const gm = await cloneAgent((await originalManager()).id, `General Manager of "${name}"`);
    await one(`UPDATE agents SET mission = $2, updated_at = now() WHERE id = $1 RETURNING id`, [gm.id, gmMission(name)]);
    await publishAgent(gm.id);
    gmId = gm.id;
  }
  const row = await one(
    `INSERT INTO projects(name, path, github_url, description, protected, manager_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name, abs, github_url || null, description || null, isProtected, gmId],
  );
  await ensureMembers(row.id, [gmId]);
  return publishProject(row.id);
}
