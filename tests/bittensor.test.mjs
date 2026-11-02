// Bittensor competition watcher (server/services/bittensor.js): config loading, chain-key decoding, detection persisted
// once, one 'miner' agent per competition, dry-run vs armed submission, error handling and shutdown. Offline only: a
// file source, a local fake RPC server and node -e submit commands. Runs against session temp tables (search_path=pg_temp).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.PGOPTIONS = '-c search_path=pg_temp';
const { pool, one, many } = await import('../server/db/pool.js');
const { addClient } = await import('../server/events.js');
const bt = await import('../server/services/bittensor.js');
// Temp tables belong to one session: run every query on one held client.
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-bt-test-'));
const events = [];
addClient({ readyState: 1, send: (m) => events.push(JSON.parse(m)), on() {} });
const logs = [];
const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };

let n = 0;
/** Fresh config/secrets/source files under dir; returns a watcher over them. */
function setup({ config = {}, secrets = null, items = [] } = {}) {
  const id = ++n;
  const files = { config: path.join(dir, `c${id}.json`), secrets: path.join(dir, `s${id}.json`), source: path.join(dir, `src${id}.json`), marker: path.join(dir, `ran${id}.json`) };
  const write = (list) => fs.writeFileSync(files.source, JSON.stringify(list));
  write(items);
  fs.writeFileSync(files.config, JSON.stringify({ enabled: true, network: `net${id}`, sources: ['file'], file: { path: files.source }, ...config }));
  if (secrets) fs.writeFileSync(files.secrets, JSON.stringify(secrets));
  const watcher = () => bt.createWatcher({ configPath: files.config, secretsPath: files.secrets, log });
  return { files, write, watcher, network: `net${id}` };
}
// A submit command that records its environment (and pid) in marker and echoes the mnemonic, then exits with code
// (or, with hang, keeps running until killed).
const recorder = (marker, code = 0, hang = false) => [process.execPath, '-e',
  `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ ...process.env, SELF_PID: String(process.pid) })); console.log('mnemonic is ' + process.env.BT_COLDKEY_MNEMONIC); ${hang ? 'setInterval(() => {}, 1000);' : `process.exit(${code})`}`];
const KEYS = { wallet: { name: 'w', hotkey: 'h', coldkeyMnemonic: 'abandon ability able about' } };

const comps = (network) => many(`SELECT * FROM bt_competitions WHERE network = $1 ORDER BY netuid`, [network]);
const minersFor = (id) => many(`SELECT id, name, title FROM agents WHERE role = 'miner' AND position($1 in mission) > 0`, [`Competition ref: ${id}`]);

before(async () => {
  await pool.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const live = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relname IN ('agents', 'bt_competitions', 'tasks', 'notifications') AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(live.n, 4, 'tables must be session temp tables');
  await pool.query(`INSERT INTO projects(name, path, protected) VALUES ('AgentForge', '/tmp/af', true)`);
});

after(async () => {
  client.release();
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing, empty, invalid and disabled config leave the watcher inert with a reason', async () => {
  const p = path.join(dir, 'cfg.json');
  const reason = () => bt.loadSettings({ configPath: p, secretsPath: path.join(dir, 'none.json') }).inert;
  assert.match(reason(), /not found/);
  fs.writeFileSync(p, '  \n');
  assert.match(reason(), /is empty/);
  fs.writeFileSync(p, '{ nope');
  assert.match(reason(), /bad config/);
  fs.writeFileSync(p, JSON.stringify({ enabled: true, sources: ['carrier-pigeon'] }));
  assert.match(reason(), /bad config.*unknown source/);
  fs.writeFileSync(p, JSON.stringify({ network: 'finney' }));
  assert.match(reason(), /disabled/);
  fs.writeFileSync(p, fs.readFileSync(new URL('../config/bittensor.example.json', import.meta.url)));
  assert.match(reason(), /disabled/, 'the committed template is disabled');

  logs.length = 0;
  const w = bt.createWatcher({ configPath: path.join(dir, 'absent.json'), secretsPath: path.join(dir, 'absent2.json'), log });
  const r = await w.pollOnce();
  assert.match(r.inert, /not found/);
  assert.equal(w.status().state, 'inert');
  assert.ok(logs.some((l) => /\[bittensor\] watcher inert: .*not found/.test(l)), 'clear log line');
  await w.pollOnce();
  assert.equal(logs.filter((l) => /inert/.test(l)).length, 1, 'logged once, not every poll');
});

test('defaults: dry run on, auto-submit off; templates hold only empty placeholders', () => {
  const cfg = bt.normalizeConfig({ enabled: true });
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.autoSubmit, false);
  assert.deepEqual(bt.submitBlockers(cfg, bt.normalizeSecrets({})), ['autoSubmit is off', 'dryRun is on', 'wallet keys missing']);
  const secrets = JSON.parse(fs.readFileSync(new URL('../config/bittensor.secrets.example.json', import.meta.url), 'utf8'));
  const values = (o) => Object.values(o).flatMap((v) => (v && typeof v === 'object' ? values(v) : [v]));
  assert.ok(values(secrets).every((v) => v === ''), 'every secret placeholder is empty');
});

test('twox128 storage prefixes match known substrate keys', () => {
  assert.equal(bt.twox128('System'), '26aa394eea5630e07c48ae0c9558cef7');
  assert.equal(bt.storagePrefix('Balances', 'TotalIssuance'), '0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80');
});

test('rpc source reads netuids and registration blocks from a (fake) subtensor node', async () => {
  const added = bt.storagePrefix('SubtensorModule', 'NetworksAdded');
  const reg = bt.storagePrefix('SubtensorModule', 'NetworkRegisteredAt');
  const u16 = (n) => Buffer.from([n & 255, n >> 8]).toString('hex');
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return `0x${b.toString('hex')}`; };
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const { method, params } = JSON.parse(body);
      calls.push(method);
      const result = method === 'state_getKeysPaged' ? [0, 1, 300, 7].map((x) => added + u16(x))
        : [{ block: '0x1', changes: [[added + u16(0), '0x01'], [added + u16(1), '0x01'], [added + u16(300), '0x01'], [added + u16(7), '0x00'],
          [reg + u16(1), u64(4242)], [reg + u16(300), u64(5_000_000)], [reg + u16(0), null]] }];
      assert.ok(method !== 'state_queryStorageAt' || params[0].length === 8);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const cfg = bt.normalizeConfig({ enabled: true, network: 'local', endpoint: `ws://127.0.0.1:${server.address().port}` });
    const items = await bt.fetchSource('rpc', cfg, bt.normalizeSecrets({}), new AbortController().signal);
    assert.deepEqual(items.map((i) => [i.netuid, i.registered_block, i.external_id]), [[0, 0, 'subnet:0@0'], [1, 4242, 'subnet:1@4242'], [300, 5_000_000, 'subnet:300@5000000']]);
    assert.deepEqual(calls, ['state_getKeysPaged', 'state_queryStorageAt']);
  } finally {
    server.close();
  }
});

test('a new competition is persisted once, notifies live, creates exactly one Mino agent and a dry-run outcome; restarts do not duplicate', async () => {
  const s = setup({ config: { submit: { command: recorder(path.join(dir, 'never.json')) } }, items: [{ netuid: 1, registered_block: 10 }, { netuid: 2, registered_block: 20 }] });
  let w = s.watcher();
  await w.pollOnce();
  assert.deepEqual((await comps(s.network)).map((c) => c.status), ['baseline', 'baseline'], 'subnets already open on the first poll are baseline');
  assert.equal((await many(`SELECT 1 FROM agents WHERE role = 'miner'`)).length, 0);

  events.length = 0;
  s.write([{ netuid: 1, registered_block: 10 }, { netuid: 2, registered_block: 20 }, { netuid: 3, registered_block: 30, name: 'Apex' }]);
  const r = await w.pollOnce();
  assert.equal(r.fresh, 1);
  assert.equal(r.error, null);
  const [c] = (await comps(s.network)).filter((x) => x.netuid === 3);
  assert.equal(c.status, 'staffed');
  assert.equal(c.submit_status, 'dry-run');
  assert.match(c.submit_output, /^would submit \(dry-run\)/);
  assert.ok(!fs.existsSync(path.join(dir, 'never.json')), 'no submission command ran');

  const miners = await minersFor(c.id);
  assert.equal(miners.length, 1);
  assert.equal(miners[0].title, 'Mino');
  assert.equal(miners[0].id, c.agent_id);
  const task = await one(`SELECT t.*, p.protected FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [c.task_id]);
  assert.equal(task.agent_id, c.agent_id);
  assert.equal(task.role, 'miner');
  assert.equal(task.origin, 'bittensor');
  assert.match(task.description, /subnet 3 \(Apex\)/);

  const note = events.find((e) => e.type === 'notification:new');
  assert.match(note?.payload.title, /New Bittensor competition: subnet 3/);
  assert.match(note.payload.body, new RegExp(`Mino agent ${miners[0].name} created`));
  assert.ok(events.some((e) => e.type === 'agent:new' && e.payload.role === 'miner'));
  assert.ok(events.some((e) => e.type === 'task:update' && e.payload.id === c.task_id));
  const last = events.filter((e) => e.type === 'bittensor:competition' && e.payload.id === c.id).pop();
  assert.equal(last.payload.submit_status, 'dry-run');
  assert.equal(last.payload.agent_name, miners[0].name);

  await w.pollOnce();
  await w.stop();
  w = s.watcher(); // a restart: new watcher over the same database
  await w.start({ delaySec: 3600 });
  await w.pollOnce();
  await w.stop();
  assert.equal((await comps(s.network)).length, 3);
  assert.equal((await minersFor(c.id)).length, 1);
  assert.equal((await many(`SELECT 1 FROM notifications WHERE title LIKE 'New Bittensor competition: subnet 3%'`)).length, 1);
  const listed = await bt.listCompetitions();
  assert.ok(listed.some((x) => x.id === c.id) && !listed.some((x) => x.status === 'baseline'));
});

test('a crash between creating the agent and recording it resumes without a second agent', async () => {
  const s = setup({ config: { baselineOnFirstRun: false } });
  const row = await one(`INSERT INTO bt_competitions(network, source, external_id, netuid, status) VALUES ($1, 'file', 'subnet:9@1', 9, 'staffing') RETURNING id`, [s.network]);
  const { createAgent } = await import('../server/services/agents.js');
  await createAgent({ role: 'miner', mission: `Mine it. Competition ref: ${row.id}` });
  const w = s.watcher();
  await w.start({ delaySec: 3600 });
  await w.pollOnce();
  await w.stop();
  const c = await one(`SELECT * FROM bt_competitions WHERE id = $1`, [row.id]);
  assert.equal(c.status, 'staffed');
  assert.equal((await minersFor(row.id)).length, 1);
});

test('the subnet filter records other subnets as ignored, without agents', async () => {
  const s = setup({ config: { baselineOnFirstRun: false, subnets: { include: [5] } }, items: [{ netuid: 5 }, { netuid: 6 }] });
  await s.watcher().pollOnce();
  assert.deepEqual((await comps(s.network)).map((c) => [c.netuid, c.status, !!c.agent_id]), [[5, 'staffed', true], [6, 'ignored', false]]);
});

test('armed submission runs the command with the keys, records success and redacts secrets', async () => {
  const s = setup({ secrets: KEYS, items: [{ netuid: 11, registered_block: 7 }] });
  s.files.cmd = recorder(s.files.marker);
  fs.writeFileSync(s.files.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.files.config)), baselineOnFirstRun: false, autoSubmit: true, dryRun: false, submit: { command: s.files.cmd } }));
  const w = s.watcher();
  assert.equal((await w.pollOnce(), w.status().submitArmed), true);
  const [c] = await comps(s.network);
  assert.equal(c.submit_status, 'submitted');
  assert.ok(c.submitted_at);
  assert.ok(!c.submit_output.includes(KEYS.wallet.coldkeyMnemonic) && c.submit_output.includes('mnemonic is ***'), 'mnemonic redacted');
  const env = JSON.parse(fs.readFileSync(s.files.marker, 'utf8'));
  assert.equal(env.BT_NETUID, '11');
  assert.equal(env.BT_WALLET_HOTKEY, 'h');
  assert.equal(env.BT_COMPETITION_ID, c.id);
  assert.ok((await many(`SELECT 1 FROM notifications WHERE title = 'Submitted to Bittensor subnet 11'`)).length === 1);
});

test('a failing submission is recorded as failed; without keys or with dryRun it never runs', async () => {
  const fail = setup({ secrets: KEYS, config: { baselineOnFirstRun: false, autoSubmit: true, dryRun: false }, items: [{ netuid: 12 }] });
  fs.writeFileSync(fail.files.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(fail.files.config)), submit: { command: recorder(fail.files.marker, 3) } }));
  await fail.watcher().pollOnce();
  const [c] = await comps(fail.network);
  assert.equal(c.submit_status, 'failed');
  assert.match(c.submit_output, /exit code 3/);

  for (const [config, secrets, why] of [[{ autoSubmit: true, dryRun: false }, null, /wallet keys missing/], [{ autoSubmit: true }, KEYS, /dryRun is on/], [{ dryRun: false }, KEYS, /autoSubmit is off/]]) {
    const s = setup({ secrets, config: { baselineOnFirstRun: false, ...config }, items: [{ netuid: 13 }] });
    fs.writeFileSync(s.files.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.files.config)), submit: { command: recorder(s.files.marker) } }));
    await s.watcher().pollOnce();
    const [d] = await comps(s.network);
    assert.equal(d.submit_status, 'dry-run');
    assert.match(d.submit_output, why);
    assert.ok(!fs.existsSync(s.files.marker), 'command did not run');
  }
});

test('an unreachable RPC endpoint is logged and kept in status, never thrown', async () => {
  const s = setup({ config: { sources: ['rpc'], endpoint: 'http://127.0.0.1:1' } });
  logs.length = 0;
  const w = s.watcher();
  const r = await w.pollOnce();
  assert.match(r.error, /rpc: RPC http:\/\/127\.0\.0\.1:1 unreachable/);
  assert.equal(w.status().state, 'error');
  assert.ok(logs.some((l) => /\[bittensor\] poll failed: rpc: RPC .* unreachable/.test(l)));
  const bad = setup();
  fs.writeFileSync(bad.files.config, '{"enabled": true, "sources": "rpc", "endpoint": 42');
  assert.match((await bad.watcher().pollOnce()).inert, /bad config/);
});

test('stop() cancels the poll timer and kills a running submission, recording it as failed', async () => {
  const s = setup({ secrets: KEYS, config: { baselineOnFirstRun: false, autoSubmit: true, dryRun: false }, items: [{ netuid: 21 }] });
  fs.writeFileSync(s.files.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.files.config)), submit: { command: recorder(s.files.marker, 0, true) } }));
  const w = s.watcher();
  await w.start({ delaySec: 0 });
  for (let i = 0; i < 200 && !fs.existsSync(s.files.marker); i++) await new Promise((r) => setTimeout(r, 25));
  const pid = Number(JSON.parse(fs.readFileSync(s.files.marker, 'utf8')).SELF_PID || 0);
  const t0 = Date.now();
  await w.stop();
  assert.ok(Date.now() - t0 < 3000, 'stop returns promptly');
  assert.equal(w.timer, null);
  assert.equal(w.status().state, 'stopped');
  const [c] = await comps(s.network);
  assert.equal(c.submit_status, 'failed');
  assert.match(c.submit_output, /aborted by shutdown/);
  if (pid) assert.throws(() => process.kill(pid, 0));
});
