import fs from 'node:fs';
import path from 'node:path';
import { one, many } from '../db/pool.js';
import { emit } from '../events.js';
import { createAgent } from './agents.js';

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

// Every project gets its own General Manager agent who reports to the executive.
export async function createProjectRecord({ name, path: dir, github_url, description, protected: isProtected = false }) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  ensureClaudeSettings(abs);
  const gm = await createAgent({
    role: 'manager',
    mission: `Run project "${name}": decompose commands into verifiable tasks, staff them, and report results.`,
    purpose: 'Turn intent into shipped, verified software.',
    skills: [{ name: 'planning', level: 70 }, { name: 'decomposition', level: 72 }, { name: 'coordination', level: 70 }],
  });
  const row = await one(
    `INSERT INTO projects(name, path, github_url, description, protected, manager_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name, abs, github_url || null, description || null, isProtected, gm.id],
  );
  return publishProject(row.id);
}
