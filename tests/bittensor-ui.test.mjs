// Bittensor competitions panel (client/src/views/Bittensor.jsx) and its live events (client/src/lib/store.js):
// the list loads from GET /api/bittensor, bittensor:competition events add/update rows (dry-run and submission
// outcomes, the Mino agent), and the notification:new for a new competition raises a toast.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;

const STATUS = { state: 'idle', reason: null, network: 'finney', sources: ['rpc'], lastPollAt: new Date().toISOString(), lastError: null, keysPresent: false, submitArmed: false, autoSubmit: false, dryRun: true };
const comp = (o) => ({ id: 'c1', network: 'finney', netuid: 64, name: 'Chutes', registered_block: 5000, status: 'detected', agent_id: null, agent_name: null, submit_status: null, submit_output: null, detected_at: new Date().toISOString(), ...o });

let response = { status: STATUS, competitions: [] };
globalThis.fetch = async (url) => new Response(JSON.stringify(new URL(url, 'http://localhost:4800').pathname === '/api/bittensor' ? response : {}), { status: 200 });

let loader, useStore, useToasts, mod, root;

before(async () => {
  loader = await createLoader();
  ({ useStore } = await loader.load('/src/lib/store.js'));
  ({ useToasts } = await loader.load('/src/lib/toast.js'));
  mod = await loader.load('/src/views/Bittensor.jsx');
});

after(async () => {
  if (root) await act(async () => root.unmount());
  await loader?.close();
});

const text = () => document.getElementById('root').textContent;
const rowText = (id) => document.querySelector(`[data-competition="${id}"]`)?.textContent ?? null;
const apply = (type, payload) => act(async () => useStore.getState().applyEvent(type, payload));

test('inert watcher explains how to enable it', async () => {
  response = { status: { ...STATUS, state: 'inert', reason: 'config/bittensor.json not found' }, competitions: [] };
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(React.Fragment, null, h(mod.BittensorState), h(mod.BittensorCompetitions))));
  await act(async () => {});
  assert.match(text(), /Watcher off: config\/bittensor\.json not found/);
  assert.match(text(), /off/);
  await act(async () => root.unmount());
  root = null;
});

test('competitions load, update live with agent and dry-run outcome, and a new one raises a toast', async () => {
  response = { status: STATUS, competitions: [comp({ id: 'old', netuid: 3, name: 'Subnet 3', status: 'staffed', agent_id: 'a0', agent_name: 'Vega', submit_status: 'submitted', submit_output: 'submitted' })] };
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(React.Fragment, null, h(mod.BittensorState), h(mod.BittensorCompetitions))));
  await act(async () => {});
  assert.match(rowText('old'), /Subnet 3/);
  assert.match(rowText('old'), /Mino Vega/);
  assert.match(rowText('old'), /submitted/);
  assert.match(text(), /dry run/, 'header shows the dry-run mode');

  await apply('bittensor:competition', comp({}));
  assert.match(rowText('c1'), /Subnet 64 · Chutes/);
  assert.match(rowText('c1'), /new/);
  await apply('bittensor:competition', comp({ status: 'staffed', agent_id: 'a1', agent_name: 'Orion', submit_status: 'dry-run', submit_output: 'would submit (dry-run): bash scripts/bittensor/submit.sh — dryRun is on' }));
  assert.match(rowText('c1'), /Mino Orion/);
  assert.match(rowText('c1'), /dry run/);
  assert.match(rowText('c1'), /would submit \(dry-run\)/);
  assert.equal(document.querySelectorAll('[data-competition]').length, 2, 'updated in place, newest first');
  assert.equal(document.querySelector('[data-competition]').dataset.competition, 'c1');
  await apply('bittensor:competition', comp({ id: 'base', status: 'baseline' }));
  assert.equal(rowText('base'), null, 'baseline rows are not listed');

  await act(async () => useToasts.setState({ items: [] }));
  await apply('notification:new', { id: 'n1', source_type: 'system', source_name: 'Bittensor', level: 'info', title: 'New Bittensor competition: subnet 64 (Chutes)', body: 'Mino agent Orion created', read: false });
  assert.ok(useToasts.getState().items.some((t) => t.title === 'New Bittensor competition: subnet 64 (Chutes)'));

  await apply('bittensor:status', { ...STATUS, state: 'error', lastError: 'rpc: RPC unreachable' });
  assert.match(text(), /rpc: RPC unreachable/);
});
