// ANTHROPIC_API_KEY and the Claude 5 models (server/models/http.js, claudeCode.js, index.js, db/seed.js): the Anthropic
// API provider and Claude Code runs authenticate with the key from the server environment (a local fake API checks the
// x-api-key header); a missing key gives a clear error; run output masks the key; seeding adds the new models without
// touching existing rows. Database checks run on session temp tables (search_path=pg_temp), never the live tables.
// The real-CLI case runs only when a `claude` binary is installed; it spends no tokens (the fake API answers 400).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const KEY = `sk-ant-test-${crypto.randomBytes(12).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-akey-'));

// Fake claude CLI: reports a hash of the ANTHROPIC_API_KEY it was given (never the value) as its result, or the error a
// real CLI prints when it has no credentials.
const fakeBin = path.join(dir, 'claude');
fs.writeFileSync(fakeBin, `#!${process.execPath}
const key = process.env.ANTHROPIC_API_KEY;
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5', permissionMode: 'bypassPermissions' });
out(key ? { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'key ' + require('crypto').createHash('sha256').update(key).digest('hex') }
  : { type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: 'Not logged in · Please run /login' });
`);
fs.chmodSync(fakeBin, 0o755);
const realClaude = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
process.env.CLAUDE_BIN = fakeBin;
process.env.PGOPTIONS = '-c search_path=pg_temp';

const { config } = await import('../server/config.js');
const { pool, one } = await import('../server/db/pool.js');
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);
const { runModel, redactKeys, credentialStatus, listModels } = await import('../server/models/index.js');
const { runClaudeCode } = await import('../server/models/claudeCode.js');
const { MODELS, seedModels } = await import('../server/db/seed.js');

// Fake Anthropic API: records each request (path, auth headers, model); `reply` decides the answer.
const hits = [];
let reply = () => [200, { content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1 } }];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch {}
    hits.push({ url: req.url, apiKey: req.headers['x-api-key'], bearer: !!req.headers.authorization, model: json.model });
    const [status, data] = reply(json);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
});
let base;
const withKey = (v, fn) => async () => {
  const old = process.env.ANTHROPIC_API_KEY;
  if (v === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = v;
  try { return await fn(); } finally { if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old; }
};
const anthropicModel = (model = 'claude-sonnet-5-5') => ({ id: 'anthropic-test', provider: 'anthropic', model, base_url: base, api_key: null, config: {} });

before(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
  await pool.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const temp = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relname IN ('models', 'agents') AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(temp.n, 2, 'models and agents must be session temp tables');
});

after(async () => {
  api.close();
  client.release();
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Anthropic API runs send ANTHROPIC_API_KEY from the environment as x-api-key', withKey(KEY, async () => {
  hits.length = 0;
  for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    const out = await runModel(anthropicModel(id), { prompt: 'Reply with exactly: OK' });
    assert.equal(out.text, 'OK');
  }
  assert.deepEqual(hits.map((h) => [h.url, h.apiKey === KEY, h.bearer, h.model]), [
    ['/v1/messages', true, false, 'claude-fable-5-1'], ['/v1/messages', true, false, 'claude-opus-5-5'],
    ['/v1/messages', true, false, 'claude-sonnet-5-5'], ['/v1/messages', true, false, 'claude-haiku-5-5'],
  ]);
  // A key stored on the model still wins over the environment, as before.
  hits.length = 0;
  await runModel({ ...anthropicModel(), api_key: 'sk-ant-stored' }, { prompt: 'x' });
  assert.equal(hits[0].apiKey, 'sk-ant-stored');
}));

test('without ANTHROPIC_API_KEY an Anthropic API run fails clearly and sends nothing', withKey(undefined, async () => {
  hits.length = 0;
  await assert.rejects(runModel(anthropicModel(), { prompt: 'x' }), /ANTHROPIC_API_KEY is not set in the AgentForge service environment/);
  assert.equal(hits.length, 0);
  assert.equal(credentialStatus().ANTHROPIC_API_KEY, 'missing');
}));

test('a cancelled run still rejects with the abort, not a masking error', withKey(KEY, async () => {
  await assert.rejects(runModel(anthropicModel(), { prompt: 'x', signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');
}));

test('credential status says set / missing, never the value', withKey(KEY, async () => {
  assert.equal(credentialStatus().ANTHROPIC_API_KEY, 'set');
  assert.equal(JSON.stringify(credentialStatus()).includes(KEY), false);
  process.env.ANTHROPIC_API_KEY = '   ';
  assert.equal(credentialStatus().ANTHROPIC_API_KEY, 'missing', 'blank counts as missing');
}));

test('Claude Code runs get the server ANTHROPIC_API_KEY; without it an auth failure names the variable', async () => {
  assert.equal(config.claudeBin, fakeBin);
  await withKey(KEY, async () => {
    const out = await runClaudeCode({ model: { model: 'claude-fable-5-1', config: {} }, prompt: 'hi', cwd: dir, tools: '' });
    assert.equal(out.text, `key ${sha(KEY)}`);
  })();
  await withKey(undefined, async () => {
    await assert.rejects(runClaudeCode({ model: { model: 'claude-opus-5-5', config: {} }, prompt: 'hi', cwd: dir, tools: '' }),
      (e) => /Not logged in/.test(e.message) && /ANTHROPIC_API_KEY is not set/.test(e.message));
  })();
});

test('real claude CLI authenticates with ANTHROPIC_API_KEY (fake API, zero tokens)', { skip: !realClaude && 'claude CLI not installed' }, withKey(KEY, async () => {
  const oldBase = process.env.ANTHROPIC_BASE_URL;
  const oldBin = config.claudeBin;
  process.env.ANTHROPIC_BASE_URL = base;
  config.claudeBin = realClaude;
  reply = () => [400, { type: 'error', error: { type: 'invalid_request_error', message: 'fake API refuses' } }];
  hits.length = 0;
  try {
    await assert.rejects(runClaudeCode({ model: { model: 'claude-opus-5-5', config: {} }, prompt: 'hi', cwd: dir, tools: '', timeoutMs: 60_000 }),
      /Claude Code failed: .*fake API refuses/);
  } finally {
    if (oldBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = oldBase;
    config.claudeBin = oldBin;
    reply = () => [200, { content: [{ type: 'text', text: 'OK' }], usage: {} }];
  }
  const calls = hits.filter((h) => h.url.startsWith('/v1/messages'));
  assert.ok(calls.length >= 1, 'the CLI called the Messages API');
  assert.ok(calls.every((h) => h.apiKey === KEY && !h.bearer && h.model === 'claude-opus-5-5'), 'every call carries the key as x-api-key, no login token');
}));

test('run output and events mask the key, also when a preview cuts it', withKey(KEY, async () => {
  reply = () => [200, { content: [{ type: 'text', text: `env: ANTHROPIC_API_KEY=${KEY} HOME=/root` }], usage: {} }];
  const events = [];
  try {
    const out = await runModel(anthropicModel(), { prompt: 'x', onEvent: (e) => events.push(e) });
    assert.equal(out.text, 'env: ANTHROPIC_API_KEY=[redacted] HOME=/root');
    assert.equal(JSON.stringify(events).includes(KEY), false);
    assert.equal(JSON.stringify(events).includes('sk-ant-'), false);
  } finally {
    reply = () => [200, { content: [{ type: 'text', text: 'OK' }], usage: {} }];
  }
  assert.equal(redactKeys(`… ${KEY.slice(0, 20)}`), '… [redacted]');
  assert.deepEqual(redactKeys({ preview: `"ANTHROPIC_API_KEY": "${KEY}"`, n: 3 }), { preview: '"ANTHROPIC_API_KEY": "[redacted]"', n: 3 });
  assert.equal(redactKeys('nothing secret here'), 'nothing secret here');
}));

test('seeding adds the Claude 5 models and leaves existing models and choices alone', async () => {
  const want = {
    'claude-code-fable': ['claude-code', 'claude-fable-5-1'], 'claude-code-opus': ['claude-code', 'claude-opus-5-5'],
    'claude-code-sonnet': ['claude-code', 'claude-sonnet-5-5'], 'claude-code-haiku': ['claude-code', 'claude-haiku-5-5'],
    'anthropic-fable': ['anthropic', 'claude-fable-5-1'], 'anthropic-opus': ['anthropic', 'claude-opus-5-5'],
    'anthropic-sonnet': ['anthropic', 'claude-sonnet-5-5'], 'anthropic-haiku': ['anthropic', 'claude-haiku-5-5'],
  };
  for (const [id, [provider, model]] of Object.entries(want)) {
    assert.ok(MODELS.some((m) => m.id === id && m.provider === provider && m.model === model), id);
  }
  // An existing install: the user renamed and disabled the seeded Opus, made Sonnet the default, stored a key on an
  // Anthropic model, and assigned an agent.
  await pool.query(`INSERT INTO models(id, name, provider, model, is_default, enabled, config) VALUES
    ('claude-code-opus', 'My Opus', 'claude-code', 'claude-opus-4-1', false, false, '{"effort":"high"}'),
    ('claude-code-sonnet', 'Claude Code · Sonnet 5.5', 'claude-code', 'claude-sonnet-5-5', true, true, '{}')`);
  await pool.query(`INSERT INTO models(id, name, provider, model, api_key) VALUES ('anthropic-own', 'Mine', 'anthropic', 'claude-opus-5-5', 'sk-ant-stored-${KEY.slice(-6)}')`);
  const agent = await one(`INSERT INTO agents(name, role, title, model_id) VALUES ('Ada', 'fullstack', 'Developer', 'claude-code-opus') RETURNING id`);
  const before = await pool.query(`SELECT * FROM models ORDER BY id`);

  await seedModels();
  await seedModels(); // idempotent

  const rows = (await pool.query(`SELECT * FROM models ORDER BY id`)).rows;
  for (const b of before.rows) assert.deepEqual(rows.find((r) => r.id === b.id), b, `${b.id} unchanged`);
  for (const [id, [provider, model]] of Object.entries(want)) {
    const r = rows.find((x) => x.id === id);
    assert.ok(r, `${id} seeded`);
    if (!before.rows.some((b) => b.id === id)) assert.deepEqual([r.provider, r.model, r.is_default, r.enabled], [provider, model, false, true], id);
  }
  assert.deepEqual(rows.filter((r) => r.is_default).map((r) => r.id), ['claude-code-sonnet'], 'the default stays');
  assert.equal((await one(`SELECT model_id FROM agents WHERE id = $1`, [agent.id])).model_id, 'claude-code-opus', 'agent keeps its model');

  // The model list (HTTP and the models:update event) has the new models and no key material.
  const listed = await withKey(KEY, () => listModels())();
  assert.ok(Object.keys(want).every((id) => listed.some((m) => m.id === id)));
  const text = JSON.stringify(listed);
  assert.equal(text.includes('sk-ant-'), false);
  assert.equal(listed.some((m) => 'api_key' in m), false);
  assert.equal(listed.find((m) => m.id === 'anthropic-own').has_api_key, true);
});
