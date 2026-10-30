import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { one, query } from '../db/pool.js';
import { emit } from '../events.js';
import { childEnv } from './env.js';
import { notify } from './notify.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_IGNORES = ['node_modules/', 'dist/', 'build/', '.env', '.env.*', '!.env.example', 'data/', '*.log', '.DS_Store', 'coverage/'];

function run(cmd, args, cwd, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: childEnv({ GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, out: `${stdout || ''}${stderr || ''}`.trim(), stdout: (stdout || '').trim() });
    });
  });
}

const git = (cwd, ...args) => run('git', args, cwd);

let ghHelper;
async function credentialArgs() {
  if (ghHelper === undefined) {
    const r = await run('gh', ['auth', 'status'], process.cwd(), 10000);
    ghHelper = r.ok;
  }
  return ghHelper ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : [];
}

export async function gitInfo(dir) {
  if (!fs.existsSync(dir)) return { isRepo: false, exists: false };
  const inside = await git(dir, 'rev-parse', '--is-inside-work-tree');
  if (!inside.ok) return { isRepo: false, exists: true };
  const [branch, remote, status, last] = await Promise.all([
    git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(dir, 'remote', 'get-url', 'origin'),
    git(dir, 'status', '--porcelain'),
    git(dir, 'log', '-1', '--format=%h%x09%s%x09%cI'),
  ]);
  const [hash, subject, date] = last.stdout.split('\t');
  return {
    isRepo: true,
    exists: true,
    branch: branch.stdout,
    remote: remote.ok ? remote.stdout : null,
    changes: status.stdout ? status.stdout.split('\n').length : 0,
    lastCommit: hash ? { hash, subject, date } : null,
  };
}

function ensureGitignore(dir) {
  const file = path.join(dir, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(current.split('\n').map((l) => l.trim()));
  const missing = DEFAULT_IGNORES.filter((l) => !lines.has(l) && !(l === 'dist/' && lines.has('client/dist/')));
  if (missing.length) fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}# added by AgentForge (source-only uploads)\n${missing.join('\n')}\n`);
}

/** Commit everything that is source code and push it. Returns a sync log row. */
export async function syncProject(project, message, settings) {
  const dir = project.path;
  const steps = [];
  const step = async (label, p) => { const r = await p; steps.push(`$ ${label}\n${r.out}`); return r; };
  const log = async (status, commit, msg) => {
    const row = await one(`INSERT INTO sync_logs(project_id, status, commit, message, output) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [project.id, status, commit, msg, steps.join('\n').slice(-12000)]);
    if (status !== 'noop') await query(`UPDATE projects SET last_synced_at = now() WHERE id = $1`, [project.id]);
    emit('sync:log', row);
    return row;
  };

  if (!fs.existsSync(dir)) return log('error', null, `Path not found: ${dir}`);
  const branchName = settings.branch || 'main';
  if (!(await gitInfo(dir)).isRepo) await step('git init', git(dir, 'init', '-b', branchName));
  ensureGitignore(dir);
  await step('git config user.name', git(dir, 'config', 'user.name', settings.userName));
  await step('git config user.email', git(dir, 'config', 'user.email', settings.userEmail));
  const cur = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (cur.ok && cur.stdout === 'master') await step(`git branch -M ${branchName}`, git(dir, 'branch', '-M', branchName));

  if (project.github_url) {
    const remote = await git(dir, 'remote', 'get-url', 'origin');
    if (!remote.ok) await step('git remote add origin', git(dir, 'remote', 'add', 'origin', project.github_url));
    else if (remote.stdout !== project.github_url) await step('git remote set-url origin', git(dir, 'remote', 'set-url', 'origin', project.github_url));
  }

  await step('git add -A', git(dir, 'add', '-A'));
  const staged = (await git(dir, 'diff', '--cached', '--name-only')).stdout.split('\n').filter(Boolean);
  const tooBig = staged.filter((f) => { try { return fs.statSync(path.join(dir, f)).size > MAX_FILE_BYTES; } catch { return false; } });
  if (tooBig.length) await step('git reset (files > 50MB)', git(dir, 'reset', '-q', '--', ...tooBig));

  let commit = null;
  const hasStaged = !(await git(dir, 'diff', '--cached', '--quiet')).ok;
  if (hasStaged) {
    const c = await step('git commit', git(dir, 'commit', '-m', message));
    if (!c.ok) return log('error', null, 'Commit failed');
    commit = (await git(dir, 'rev-parse', '--short', 'HEAD')).stdout;
  }

  if (!project.github_url) return log(commit ? 'committed' : 'noop', commit, commit ? 'Committed locally (no GitHub URL set)' : 'Nothing to commit');

  const branch = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout || branchName;
  const ahead = await git(dir, 'rev-list', '--count', `origin/${branch}..HEAD`);
  if (!commit && ahead.ok && ahead.stdout === '0') return log('noop', null, 'Already up to date');

  const push = await step(`git push -u origin ${branch}`, run('git', [...(await credentialArgs()), 'push', '-u', 'origin', branch], dir, 120000));
  if (!push.ok) {
    const row = await log('error', commit, 'Push failed');
    await notify({ source_type: 'system', source_name: 'GitHub', project_id: project.id, level: 'error', title: `GitHub push failed · ${project.name}`, body: push.out.slice(-400) });
    return row;
  }
  return log('pushed', commit, commit ? `Pushed ${commit}` : 'Pushed pending commits');
}
