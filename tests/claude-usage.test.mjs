// Claude Code run usage (server/models/claudeCode.js): a -p run can write several `result` events (queued
// background-task turns), and each result's `usage` covers only its own turn's main loop. The run's tokens are the sum
// over all results, plus the calls beyond the main loop (advisor iterations, subagents) that each result's
// model_usage_since_last_result states. Cache writes are stored by TTL in their own runs columns, not in input_tokens.
// total_cost_usd is a running total, so the last result's is the run's. The fixture is shaped like the real CLI's
// stream (2.1.310 against a fake API): streamed assistant events carry message_start usage, `usage.iterations` lists
// only the turn's last API call, and modelUsage is cumulative and, for a resumed session, starts from earlier turns.
// Database checks run on session temp tables (search_path=pg_temp), never the live tables.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cusage-'));
const MAIN = 'claude-opus-5-5';
const ADVISOR = 'claude-fable-5-1';
const mu = (input, output, read, write) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write, costUSD: 0 });
const advisorIteration = (input, output) => ({ type: 'advisor_message', model: ADVISOR, input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
// Three turns. modelUsage starts from a resumed session's earlier 1M input tokens, so reading it absolutely over-counts.
const EARLIER = mu(1_000_000, 0, 0, 0);
const results = [
  { usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, iterations: [advisorIteration(1, 1)] },
    model_usage_since_last_result: { [MAIN]: mu(10, 100, 1000, 300), [ADVISOR]: mu(5000, 400, 0, 0) },
    modelUsage: { [MAIN]: mu(1_000_010, 100, 1000, 300), [ADVISOR]: mu(5000, 400, 0, 0) }, total_cost_usd: 0.5 },
  { usage: { input_tokens: 20, output_tokens: 200, cache_read_input_tokens: 2000, cache_creation_input_tokens: 600,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600 }, iterations: [advisorIteration(2, 2)] },
    model_usage_since_last_result: { [MAIN]: mu(20, 200, 2000, 600), [ADVISOR]: mu(3000, 300, 50, 70) },
    modelUsage: { [MAIN]: mu(1_000_030, 300, 3000, 900), [ADVISOR]: mu(8000, 700, 50, 70) }, total_cost_usd: 0.9 },
  // An older CLI's result: no TTL split and no model_usage_since_last_result.
  { usage: { input_tokens: 30, output_tokens: 300, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 },
    modelUsage: { [MAIN]: mu(1_000_060, 600, 6000, 1300), [ADVISOR]: mu(8000, 700, 50, 70) }, total_cost_usd: 1.2 },
];
const EXPECTED = {
  input: 10 + 20 + 30 + 5000 + 3000, // main-loop uncached input of every turn + advisor input; no cache writes
  output: 100 + 200 + 300 + 400 + 300,
  cache: 1000 + 2000 + 3000 + 50,
  cacheWrite5m: 100 + 0 + 400 + 70, // the TTL-less writes (older result, advisor) count as 5-minute ones
  cacheWrite1h: 200 + 600 + 0,
};

// Fake claude CLI: per turn an assistant event with message_start usage (output_tokens 1), then the turn's result.
const fakeBin = path.join(dir, 'claude');
fs.writeFileSync(fakeBin, `#!${process.execPath}
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const results = ${JSON.stringify(results)};
process.stdin.resume().on('end', () => {
  out({ type: 'system', subtype: 'init', session_id: 'usage-session', model: '${MAIN}', permissionMode: 'bypassPermissions' });
  results.forEach((r, i) => {
    out({ type: 'assistant', message: { id: 'msg_' + i, content: [{ type: 'text', text: 'turn ' + i }],
      usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 5 } } });
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'turn ' + i + ' done', duration_ms: 1000 * (i + 1), ...r });
  });
});
`);
fs.chmodSync(fakeBin, 0o755);
process.env.CLAUDE_BIN = fakeBin;
process.env.PGOPTIONS = '-c search_path=pg_temp';

const { pool, one } = await import('../server/db/pool.js');
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);
const { runModel, recordRunUsage, usageFor } = await import('../server/models/index.js');
const schema = fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
const ccModel = { id: 'cc-usage', provider: 'claude-code', model: MAIN, api_key: null, config: {}, limits: {} };

before(async () => {
  await pool.query(schema);
  const temp = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relname = 'runs' AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(temp.n, 1, 'runs must be a session temp table');
});

after(async () => {
  client.release();
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a multi-turn run records the sum of every turn, advisor calls included, with cache writes split by TTL', async () => {
  const out = await runModel(ccModel, { prompt: 'hi', cwd: dir, onEvent: () => {} });
  assert.deepEqual(out.usage, EXPECTED);
  assert.equal(out.costUsd, 1.2, 'cost is the last result\'s running total');
  assert.equal(out.text, 'turn 2 done');
  assert.equal(out.contextTokens, 3 + 5 + 7);

  const { id } = await one(`INSERT INTO runs (model_id, kind) VALUES ($1, 'task') RETURNING id`, [ccModel.id]);
  await recordRunUsage(id, out);
  const row = await one(`SELECT input_tokens, output_tokens, cache_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost_usd FROM runs WHERE id = $1`, [id]);
  assert.deepEqual(
    { ...row, cost_usd: Number(row.cost_usd) },
    { input_tokens: EXPECTED.input, output_tokens: EXPECTED.output, cache_tokens: EXPECTED.cache,
      cache_write_5m_tokens: EXPECTED.cacheWrite5m, cache_write_1h_tokens: EXPECTED.cacheWrite1h, cost_usd: 1.2 },
  );

  // Usage readers count the cache writes as input, as they did when input_tokens included them.
  const u = await usageFor(ccModel);
  const total = EXPECTED.input + EXPECTED.cacheWrite5m + EXPECTED.cacheWrite1h + EXPECTED.output;
  assert.equal(Number(u.total.tokens), total);
  assert.equal(Number(u.daily.tokens), total);
  assert.equal(Number(u.weekly.tokens), total);
  assert.equal(Number(u.weekly.cache), EXPECTED.cache);
});

test('the schema change is additive and idempotent: existing rows keep their values', async () => {
  const { id } = await one(`INSERT INTO runs (model_id, input_tokens, output_tokens, cache_tokens, cost_usd) VALUES ('legacy', 1234, 56, 789, 0.25) RETURNING id`);
  const before = await one(`SELECT * FROM runs WHERE id = $1`, [id]);
  await pool.query(schema);
  const after = await one(`SELECT * FROM runs WHERE id = $1`, [id]);
  assert.deepEqual(after, before);
  assert.equal(after.cache_write_5m_tokens, 0);
  assert.equal(after.cache_write_1h_tokens, 0);
  const cols = await one(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = pg_my_temp_schema()::regnamespace::text
    AND table_name = 'runs' AND column_name LIKE 'cache_write_%'`);
  assert.equal(cols.n, 2);
});
