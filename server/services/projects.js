import fs from 'node:fs';
import path from 'node:path';
import { one, many } from '../db/pool.js';
import { emit } from '../events.js';
import { createAgent } from './agents.js';

const PROJECT_COLS = `p.*, m.name AS manager_name,
  (SELECT count(DISTINCT t.agent_id)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'running') AS running_agents,
  (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS tasks_done,
  (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id) AS tasks_total`;

export async function listProjects() {
  return many(`SELECT ${PROJECT_COLS} FROM projects p LEFT JOIN agents m ON m.id = p.manager_id ORDER BY p.protected DESC, p.created_at`);
}

export async function getProject(id) {
  return one(`SELECT ${PROJECT_COLS} FROM projects p LEFT JOIN agents m ON m.id = p.manager_id WHERE p.id = $1`, [id]);
}

export async function publishProject(id) {
  const p = await getProject(id);
  if (p) emit('project:update', p);
  return p;
}

export async function setProjectStatus(id, status) {
  await one(`UPDATE projects SET status=$2, updated_at=now() WHERE id=$1 RETURNING id`, [id, status]);
  return publishProject(id);
}

// Every project gets its own General Manager agent who reports to the executive.
export async function createProjectRecord({ name, path: dir, github_url, description, protected: isProtected = false }) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
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
