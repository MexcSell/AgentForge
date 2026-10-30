import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { one, query } from '../db/pool.js';
import { emit } from '../events.js';
import { childEnv } from './env.js';
import { notify } from './notify.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_IGNORES = ['node_modules/', 'dist/', 'build/', '.env', '.env.*', '!.env.example', 'data/', '*.log', '.DS_Store', 'coverage/'];
const DIFF_LIMIT = 40000;
const DIFF_EXCLUDES = [':(exclude)package-lock.json', ':(exclude)*/package-lock.json', ':(exclude)*.lock'];
const MESSAGE_TIMEOUT = 240000; // outer guard: the engine's builder bounds its model run to ~3 min itself

function run(cmd, args, cwd, timeout = 60000, { input, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout, maxBuffer, env: childEnv({ GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, out: `${stdout || ''}${stderr || ''}`.trim(), stdout: (stdout || '').trim(), raw: stdout || '' });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // EPIPE if git exits before reading
      child.stdin.end(input);
    }
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

/** What was staged: file list, --stat, and a diff without lockfiles capped at DIFF_LIMIT chars. */
async function stagedChanges(dir) {
  const [stat, diff] = await Promise.all([
    run('git', ['diff', '--cached', '--stat'], dir),
    run('git', ['diff', '--cached', '--no-color', '--no-ext-diff', '-U2', '--', '.', ...DIFF_EXCLUDES], dir, 60000, { maxBuffer: DIFF_LIMIT * 4 }),
  ]);
  let text = diff.raw.trimEnd();
  if (text.length > DIFF_LIMIT || diff.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    const cut = text.lastIndexOf('\n', DIFF_LIMIT);
    text = `${text.slice(0, cut > DIFF_LIMIT / 2 ? cut : DIFF_LIMIT)}\n[diff truncated]`;
  }
  return { stat: stat.raw.trimEnd(), diff: text };
}

/** Run a message builder over the staged changes; any failure falls back to a safe default. */
async function buildMessage(dir, builder, files, steps) {
  const { stat, diff } = await stagedChanges(dir);
  let text, reason = '', timer;
  try {
    text = await Promise.race([
      Promise.resolve().then(() => builder({ files: [...files], stat, diff })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${MESSAGE_TIMEOUT / 1000}s`)), MESSAGE_TIMEOUT); }),
    ]);
    if (typeof text !== 'string' || !text.replace(/\0/g, '').trim()) reason = 'empty message';
  } catch (err) {
    reason = String(err?.message || err).split('\n')[0].slice(0, 300);
  } finally {
    clearTimeout(timer);
  }
  steps.push(`$ commit message\n${reason ? `builder failed (${reason}); using default` : 'generated from staged diff'}`);
  if (!reason) return text.replace(/\0/g, '');
  return `Update ${files.length} file${files.length === 1 ? '' : 's'}${stat ? `\n\n${stat}` : ''}`;
}

/**
 * Commit everything that is source code and push it. Returns a sync log row.
 * `message` is the commit message, or an async builder `({ files, stat, diff }) => string`
 * that is only called when something is staged.
 */
export async function syncProject(project, message, settings) {
  const dir = project.path;
  const steps = [];
  let commitMessage = null;
  const step = async (label, p) => { const r = await p; steps.push(`$ ${label}\n${r.out}`); return r; };
  const log = async (status, commit, msg) => {
    if (commitMessage) msg = `${msg} · ${commitMessage.split('\n')[0]}`;
    const row = await one(`INSERT INTO sync_logs(project_id, status, commit, message, output) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [project.id, status, commit, msg, steps.join('\n').slice(-12000)]);
    if (status !== 'noop') await query(`UPDATE projects SET last_synced_at = now() WHERE id = $1`, [project.id]);
    row.commit_message = commitMessage;
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
    const text = typeof message === 'function' ? await buildMessage(dir, message, staged.filter((f) => !tooBig.includes(f)), steps) : message;
    // Message goes through stdin so its content can never be parsed as an argument or option.
    const c = await step('git commit', run('git', ['commit', '-F', '-'], dir, 60000, { input: String(text ?? '') }));
    if (!c.ok) return log('error', null, 'Commit failed');
    commit = (await git(dir, 'rev-parse', '--short', 'HEAD')).stdout;
    commitMessage = (await git(dir, 'log', '-1', '--format=%B')).stdout || text;
  }

  if (!project.github_url) return log(commit ? 'committed' : 'noop', commit, commit ? 'Committed locally' : 'Nothing to commit');

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
