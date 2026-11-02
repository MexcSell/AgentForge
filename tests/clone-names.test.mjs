// Clone names (server/services/agents.js cloneAgent): "<base>-N" with the smallest N from 1 no live agent holds, no stacked
// suffixes, unique under concurrent cloning; archived agents free their names. Runs against session temp tables (search_path=pg_temp), never the live tables.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.PGOPTIONS = '-c search_path=pg_temp';
const { pool, one } = await import('../server/db/pool.js');
const { cloneAgent, createAgent } = await import('../server/services/agents.js');
// Temp tables belong to one session: run every query on one held client. pool.query would destroy its client on the
// unique violation a racing clone retries after, and the temp tables with it.
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);

let pixel;
const names = async () => (await pool.query(`SELECT name FROM agents WHERE name LIKE 'Pixel%' ORDER BY name`)).rows.map((r) => r.name);

before(async () => {
  await pool.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  // Every table the services touch must be a temp table, or the test would write to the live DB.
  const live = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relname = 'agents' AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(live.n, 1, 'agents must be a session temp table');
  pixel = await createAgent({ role: 'frontend', name: 'Pixel' });
});

after(async () => {
  client.release();
  await pool.end();
});

test('the first clone is <name>-1, the next ones count up', async () => {
  assert.equal((await cloneAgent(pixel.id)).name, 'Pixel-1');
  assert.equal((await cloneAgent(pixel.id)).name, 'Pixel-2');
});

test('cloning a numbered clone does not stack suffixes', async () => {
  const two = await one(`SELECT id FROM agents WHERE name = 'Pixel-2'`);
  assert.equal((await cloneAgent(two.id)).name, 'Pixel-3');
});

test('gaps left by deleted and archived clones are reused; the archived row keeps its name in history', async () => {
  await pool.query(`DELETE FROM agents WHERE name = 'Pixel-1'`);
  await pool.query(`UPDATE agents SET archived = true WHERE name = 'Pixel-2'`);
  assert.equal((await cloneAgent(pixel.id)).name, 'Pixel-1');
  assert.equal((await cloneAgent(pixel.id)).name, 'Pixel-2');
  assert.equal((await cloneAgent(pixel.id)).name, 'Pixel-4');
  assert.deepEqual((await pool.query(`SELECT archived FROM agents WHERE name = 'Pixel-2' ORDER BY archived`)).rows.map((r) => r.archived), [false, true]);
});

test('with Aria-1 and Aria-4 live (Aria-2, Aria-3 archived), the next clones are Aria-2, Aria-3, then Aria-5', async () => {
  const aria = await createAgent({ role: 'manager', name: 'Aria' });
  for (let i = 0; i < 4; i++) await cloneAgent(aria.id);
  await pool.query(`UPDATE agents SET archived = true WHERE name IN ('Aria-2', 'Aria-3')`);
  assert.deepEqual([(await cloneAgent(aria.id)).name, (await cloneAgent(aria.id)).name, (await cloneAgent(aria.id)).name], ['Aria-2', 'Aria-3', 'Aria-5']);
});

test('a live name stays unique: a second live agent can not take it', async () => {
  await assert.rejects(createAgent({ role: 'manager', name: 'Aria-5' }), { code: '23505', constraint: 'agents_live_name_key' });
});

test('concurrent clones get unique, gap-free names', async () => {
  await pool.query(`DELETE FROM agents WHERE name LIKE 'Pixel-%'`);
  // One session, but each clone awaits between reading the taken names and inserting, so the reads of all six run
  // before any insert: they all pick the same number and every one but the first has to retry.
  const made = await Promise.all(Array.from({ length: 6 }, () => cloneAgent(pixel.id, 'parallel work')));
  assert.deepEqual(made.map((a) => a.name).sort(), ['Pixel-1', 'Pixel-2', 'Pixel-3', 'Pixel-4', 'Pixel-5', 'Pixel-6']);
});

test('concurrent clones fill the smallest free gaps first', async () => {
  await pool.query(`UPDATE agents SET archived = true WHERE name IN ('Pixel-2', 'Pixel-3', 'Pixel-5')`);
  const made = await Promise.all(Array.from({ length: 4 }, () => cloneAgent(pixel.id, 'parallel work')));
  assert.deepEqual(made.map((a) => a.name).sort(), ['Pixel-2', 'Pixel-3', 'Pixel-5', 'Pixel-7']);
});
