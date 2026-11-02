// Per-user Git identity (services/git.js gitIdentityFor + syncProject, users.git_name/git_email/git_branch,
// missions.ordered_by): a mission ordered by a configured user commits as that user (author and committer) and pushes
// to their branch, created from the default branch when the remote lacks it; an unconfigured user, or a mission nobody
// ordered, keeps the global identity and branch. Offline: session temp tables (search_path=pg_temp) and a bare local
// remote; a fake `gh` keeps the credential probe off the network. Also: schema.sql migrates a database whose users and
// missions tables have the previous shape, and is idempotent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.PGOPTIONS = '-c search_path=pg_temp';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-git-identity-'));
fs.mkdirSync(path.join(tmp, 'bin'));
fs.writeFileSync(path.join(tmp, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${path.join(tmp, 'bin')}:${process.env.PATH}`;
for (const k of Object.keys(process.env)) if (/^GIT_(AUTHOR|COMMITTER)_/.test(k)) delete process.env[k];

const { pool, one } = await import('../server/db/pool.js');
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);
const { syncProject, gitIdentityFor } = await import('../server/services/git.js');

const SCHEMA = fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
const GLOBAL = { autoSync: true, userName: 'AgentForge Bot', userEmail: 'bot@agentforge.local', branch: 'main' };
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

let remote, work, project, users = {};

before(async () => {
  await pool.query(SCHEMA);
  const temp = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relname IN ('users', 'missions', 'projects') AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(temp.n, 3, 'users, missions and projects must be session temp tables');

  remote = path.join(tmp, 'remote.git');
  g(tmp, 'init', '--bare', '-b', 'main', remote);
  work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  g(work, 'init', '-b', 'main');
  fs.writeFileSync(path.join(work, 'README.md'), '# demo\n');
  g(work, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'add', '-A');
  g(work, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-m', 'seed');
  g(work, 'remote', 'add', 'origin', remote);
  g(work, 'push', '-u', 'origin', 'main');
  project = await one(`INSERT INTO projects(name, path, github_url) VALUES ('Demo', $1, $2) RETURNING *`, [work, remote]);

  const add = async (username, git = {}) => (users[username] = (await one(
    `INSERT INTO users(username, role, status, git_name, git_email, git_branch) VALUES ($1, 'user', 'active', $2, $3, $4) RETURNING id`,
    [username, git.name || null, git.email || null, git.branch || null])).id);
  await add('alice', { name: 'Alice Liddell', email: 'alice@example.com', branch: 'users/alice' });
  await add('plain');
  await add('mailonly', { email: 'mail@example.com' });
});

after(async () => {
  client.release();
  await pool.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A mission ordered by username (or nobody) whose work changes file; synced as the engine's syncMission does. */
async function missionSync(username, file) {
  const mission = await one(`INSERT INTO missions(project_id, command, ordered_by) VALUES ($1, 'work', $2) RETURNING *`, [project.id, username ? users[username] : null]);
  fs.writeFileSync(path.join(work, file), `${file} by ${username || 'nobody'}\n`);
  return syncProject(project, `Change ${file}`, await gitIdentityFor(mission.ordered_by, GLOBAL));
}
const head = (ref) => g(remote, 'log', '-1', '--format=%an|%ae|%cn|%ce|%s', ref);
const branches = () => g(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();

test('an unconfigured user and a mission nobody ordered keep the global identity and branch', async () => {
  assert.equal(await gitIdentityFor(users.plain, GLOBAL), GLOBAL, 'the settings object itself: nothing changes');
  assert.equal(await gitIdentityFor(null, GLOBAL), GLOBAL);
  const log = await missionSync('plain', 'plain.txt');
  assert.equal(log.status, 'pushed', log.output);
  assert.equal(head('main'), 'AgentForge Bot|bot@agentforge.local|AgentForge Bot|bot@agentforge.local|Change plain.txt');
  const none = await missionSync(null, 'none.txt');
  assert.equal(none.status, 'pushed', none.output);
  assert.equal(head('main'), 'AgentForge Bot|bot@agentforge.local|AgentForge Bot|bot@agentforge.local|Change none.txt');
  assert.deepEqual(branches(), ['main']);
});

test('a configured user commits as themself (author and committer) on their branch, created from the default branch', async () => {
  const mainTip = g(remote, 'rev-parse', 'main');
  const log = await missionSync('alice', 'alice.txt');
  assert.equal(log.status, 'pushed', log.output);
  assert.match(log.message, /to users\/alice/);
  assert.deepEqual(branches(), ['main', 'users/alice'], 'the missing branch was created');
  assert.equal(head('users/alice'), 'Alice Liddell|alice@example.com|Alice Liddell|alice@example.com|Change alice.txt');
  assert.equal(g(remote, 'rev-parse', 'users/alice~1'), mainTip, 'branched from the default branch');
  assert.equal(g(remote, 'rev-parse', 'main'), mainTip, 'the default branch is not pushed');
  assert.equal(g(work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the working tree stays on the default branch');
  assert.equal(g(work, 'config', 'user.name'), 'AgentForge Bot', 'the repo identity stays global');
  // The next order of the same user lands on the existing branch, on top of the last one.
  const again = await missionSync('alice', 'alice2.txt');
  assert.equal(again.status, 'pushed', again.output);
  assert.equal(head('users/alice'), 'Alice Liddell|alice@example.com|Alice Liddell|alice@example.com|Change alice2.txt');
  assert.equal(g(remote, 'log', '-1', '--format=%s', 'users/alice~1'), 'Change alice.txt');
  // Nothing new: no push.
  assert.equal((await syncProject(project, 'noop', await gitIdentityFor(users.alice, GLOBAL))).status, 'noop');
});

test('empty fields fall back one by one: an email-only user keeps the global name and branch', async () => {
  const id = await gitIdentityFor(users.mailonly, GLOBAL);
  assert.deepEqual([id.as, id.branch, id.pushBranch], [{ name: 'AgentForge Bot', email: 'mail@example.com' }, 'main', undefined]);
  const log = await missionSync('mailonly', 'mail.txt');
  assert.equal(log.status, 'pushed', log.output);
  assert.equal(head('main'), 'AgentForge Bot|mail@example.com|AgentForge Bot|mail@example.com|Change mail.txt');
});

test('schema.sql migrates a database made before per-user Git identity, keeping its rows, and is idempotent', async () => {
  // The previous users table (no git_*) and missions without ordered_by, then the current schema.sql over them.
  await pool.query(`DROP TABLE sessions, users CASCADE`);
  await pool.query(`ALTER TABLE missions DROP COLUMN ordered_by`);
  await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL, password_hash text,
    role text NOT NULL DEFAULT 'user', status text NOT NULL DEFAULT 'pending', team text, permissions jsonb NOT NULL DEFAULT '{}', device jsonb,
    device_bound_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz, last_login_at timestamptz, device_secret_hash text, device_info jsonb)`);
  const old = (await one(`INSERT INTO users(username, status) VALUES ('legacy', 'active') RETURNING id`)).id;
  const missions = (await one(`SELECT count(*)::int AS n FROM missions`)).n;
  await pool.query(SCHEMA);
  await pool.query(SCHEMA);
  const u = await one(`SELECT username, git_name, git_email, git_branch FROM users WHERE id = $1`, [old]);
  assert.deepEqual(u, { username: 'legacy', git_name: null, git_email: null, git_branch: null });
  assert.equal((await one(`SELECT count(*)::int AS n FROM missions WHERE ordered_by IS NULL`)).n, missions, 'existing missions: nobody ordered them');
  const m = await one(`INSERT INTO missions(project_id, command, ordered_by) VALUES ($1, 'x', $2) RETURNING id`, [project.id, old]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [old]);
  assert.equal((await one(`SELECT ordered_by FROM missions WHERE id = $1`, [m.id])).ordered_by, null, 'a deleted user leaves the mission');
});
