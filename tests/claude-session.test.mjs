// Claude Code models: an API key and a session id stored on the model in Model Manager (server/models/claudeCode.js,
// routes/api.js). A stored key wins over the server's ANTHROPIC_API_KEY in the CLI's environment and is masked in run
// output; a saved session id starts every agent task run that has no session of its own, forked (--resume <id> --fork-session) so
// the saved session never changes, and a session the CLI does not have falls back to a fresh run. The routes accept only
// a UUID as session id and can remove a stored key. A fake claude CLI reports its argv and a hash of its key; database
// checks run on session temp tables (search_path=pg_temp), never the live tables.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SERVER_KEY = `sk-ant-server-${crypto.randomBytes(8).toString('hex')}`;
const MODEL_KEY = `sk-ant-model-${crypto.randomBytes(8).toString('hex')}`;
const SESSION = '0f8b4c2e-1d3a-4b5c-9e6f-7a8b9c0d1e2f';
const GONE = '00000000-0000-4000-8000-000000000000'; // a session the fake CLI does not have
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-csess-'));

// Fake claude CLI: answers with its argv and the hash of its ANTHROPIC_API_KEY; `say-key` prints the key itself (as an
// agent's `env` could). A --resume of GONE ends like the real CLI: an error result before any init event.
const fakeBin = path.join(dir, 'claude');
fs.writeFileSync(fakeBin, `#!${process.execPath}
const args = process.argv.slice(2);
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const r = args.indexOf('--resume');
if (r >= 0 && args[r + 1] === '${GONE}') { out({ type: 'result', subtype: 'success', is_error: true, num_turns: 0, result: 'No conversation found' }); process.exit(1); }
let input = '';
process.stdin.on('data', (c) => { input += c; }).on('end', () => {
  const key = process.env.ANTHROPIC_API_KEY || '';
  out({ type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-opus-5-5', permissionMode: 'bypassPermissions' });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    result: input.includes('say-key') ? 'key=' + key : JSON.stringify({ args, input, key: key && require('crypto').createHash('sha256').update(key).digest('hex') }) });
});
`);
fs.chmodSync(fakeBin, 0o755);
process.env.CLAUDE_BIN = fakeBin;
process.env.PGOPTIONS = '-c search_path=pg_temp';
process.env.ANTHROPIC_API_KEY = SERVER_KEY;

const { pool, one } = await import('../server/db/pool.js');
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);
const { runModel } = await import('../server/models/index.js');
const { default: Fastify } = await import('fastify');
const { default: apiRoutes } = await import('../server/routes/api.js');

let app, base;
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const ccModel = (extra = {}) => ({ id: 'cc-test', provider: 'claude-code', model: 'claude-opus-5-5', api_key: null, config: {}, ...extra });
const run = async (model, opts = {}) => {
  const events = [];
  const out = await runModel(model, { prompt: 'hi', cwd: dir, meta: { kind: 'task' }, onEvent: (e) => events.push(e), ...opts });
  return { ...JSON.parse(out.text), events };
};

before(async () => {
  await pool.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const temp = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relname = 'models' AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(temp.n, 1, 'models must be a session temp table');
  app = Fastify();
  await app.register(apiRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  client.release();
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a key stored on a Claude Code model wins over the server ANTHROPIC_API_KEY; without one the server key is used', async () => {
  assert.equal((await run(ccModel({ api_key: MODEL_KEY }))).key, sha(MODEL_KEY));
  assert.equal((await run(ccModel())).key, sha(SERVER_KEY));
});

test('the stored key is masked in run output', async () => {
  const out = await runModel(ccModel({ api_key: 'sk-other-format-123' }), { prompt: 'say-key', cwd: dir });
  assert.equal(out.text, 'key=[redacted]');
});

test('a saved session id starts the run from that session, forked; without one the run starts fresh', async () => {
  const { args, events } = await run(ccModel({ config: { sessionId: SESSION } }));
  const r = args.indexOf('--resume');
  assert.deepEqual(args.slice(r, r + 3), ['--resume', SESSION, '--fork-session']);
  assert.ok(args.includes('--no-session-persistence'), 'a one-off run keeps no fork on disk');
  assert.match(events[0].text, /Session resumed/);
  const fresh = await run(ccModel());
  assert.ok(!fresh.args.includes('--resume') && !fresh.args.includes('--fork-session'));
});

test('only agent task runs start from the saved session: GM and test runs stay fresh', async () => {
  for (const kind of ['plan', 'digest', 'triage', 'commit', 'test']) {
    const { args } = await run(ccModel({ config: { sessionId: SESSION } }), { meta: { kind } });
    assert.ok(!args.includes('--resume') && !args.includes(SESSION), kind);
  }
});

test('a persisted run keeps its fork; the engine resuming its own session wins over the saved one, unforked', async () => {
  const kept = await run(ccModel({ config: { sessionId: SESSION } }), { persist: true });
  assert.ok(kept.args.includes('--fork-session') && !kept.args.includes('--no-session-persistence'));
  const own = await run(ccModel({ config: { sessionId: SESSION } }), { resume: 'engine-session', persist: true });
  const r = own.args.indexOf('--resume');
  assert.equal(own.args[r + 1], 'engine-session');
  assert.ok(!own.args.includes('--fork-session') && !own.args.includes(SESSION));
});

test('a saved session the CLI does not have falls back to a fresh run with the full prompt', async () => {
  const { args, input, events } = await run(ccModel({ config: { sessionId: GONE } }), { freshPrompt: 'full prompt' });
  assert.ok(!args.includes('--resume'));
  assert.equal(input, 'full prompt');
  assert.ok(events.some((e) => e.text === 'Saved session not found · starting fresh'));
});

test('anything but a UUID saved as session id never reaches the CLI argv', async () => {
  const { args } = await run(ccModel({ config: { sessionId: '--dangerously-skip-permissions' } }));
  assert.ok(!args.includes('--resume') && !args.includes('--dangerously-skip-permissions'));
});

test('routes: a session id must be a UUID (blank removes it); clear_api_key removes the stored key, blank keeps it', async () => {
  const bad = await call('POST', '/api/models', { name: 'CC', provider: 'claude-code', model: 'claude-opus-5-5', config: { sessionId: 'not-a-session' } });
  assert.deepEqual([bad.status, bad.data.error], [400, 'Session ID must be a Claude Code session id (a UUID)']);
  const made = await call('POST', '/api/models', { name: 'CC', provider: 'claude-code', model: 'claude-opus-5-5', api_key: MODEL_KEY, config: { sessionId: SESSION } });
  assert.equal(made.status, 200);
  const id = made.data.id;
  const row = () => one(`SELECT api_key, config FROM models WHERE id = $1`, [id]);
  assert.deepEqual([(await row()).api_key, (await row()).config.sessionId], [MODEL_KEY, SESSION]);

  assert.equal((await call('PATCH', `/api/models/${id}`, { config: { sessionId: 'x' } })).status, 400);
  assert.equal((await row()).config.sessionId, SESSION, 'a refused change leaves the row as it was');
  await call('PATCH', `/api/models/${id}`, { name: 'CC 2' });
  assert.equal((await row()).api_key, MODEL_KEY, 'no api_key: the stored key is kept');
  await call('PATCH', `/api/models/${id}`, { config: { sessionId: '' } });
  assert.equal((await row()).config.sessionId, '', 'blank removes the session id');
  await call('PATCH', `/api/models/${id}`, { clear_api_key: true });
  assert.equal((await row()).api_key, null);

  const listed = await call('GET', '/api/models');
  const m = listed.data.find((x) => x.id === id);
  assert.equal(m.has_api_key, false);
  assert.equal('api_key' in m, false, 'the key never leaves the server');
});
