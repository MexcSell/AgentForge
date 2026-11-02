// Users nav badge (client/src/components/Shell.jsx ActivityBar + client/src/lib/store.js): administrators see how many
// accounts wait for approval on the Users icon. The count loads with loadAll from GET /api/users/pending (admins only) and
// stays live through 'users:pending' events (real ws.js); it is hidden at 0 and in every activity-bar layout labelled.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;
const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin', status: 'active', permissions: {} };
const BOB = { id: 'u-bob', username: 'bob', role: 'user', status: 'active', permissions: { projects: [], manageSettings: true } };

let pending = 0;
const calls = [];
globalThis.fetch = async (url) => {
  const path = new URL(url, 'http://localhost:4800').pathname;
  calls.push(path);
  const body = path === '/api/users/pending' ? { count: pending } : path === '/api/system/status' ? { status: 'online' } : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

let sock = null;
let loader, useStore, ActivityBar, LAYOUTS, INIT, root;

before(async () => {
  globalThis.WebSocket = class { constructor() { sock = this; this.readyState = 1; } send() {} close() {} };
  loader = await createLoader();
  ({ useStore } = await loader.load('/src/lib/store.js'));
  ({ ActivityBar } = await loader.load('/src/components/Shell.jsx'));
  ({ LAYOUTS } = await loader.load('/src/lib/layouts.js'));
  const { connectEvents } = await loader.load('/src/lib/ws.js');
  INIT = { ...useStore.getState() };
  useStore.setState({ me: ADMIN }); // ws.js connects only when signed in
  connectEvents();
});

after(async () => {
  if (root) await act(async () => root.unmount());
  await loader?.close();
});

beforeEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  calls.length = 0;
  await act(async () => useStore.setState({ ...INIT, me: ADMIN, view: 'dashboard' }, true));
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const STANDARD = () => LAYOUTS.find((l) => l.id === 'standard');
const render = async (layout = STANDARD()) => {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(ActivityBar, { layout })));
};
const usersButton = () => document.querySelector('#root button[aria-label^="Users"]');
const badge = () => usersButton()?.querySelector('[data-badge="users"]')?.textContent ?? null;
const label = () => usersButton()?.getAttribute('aria-label') ?? null;
const event = (type, payload) => act(async () => sock.onmessage({ data: JSON.stringify({ type, payload, ts: Date.now() }) }));

test('an administrator sees the waiting count from loadAll; none at 0', async () => {
  pending = 3;
  await act(async () => useStore.getState().loadAll());
  assert.ok(calls.includes('/api/users/pending'));
  await render();
  assert.equal(badge(), '3');
  assert.equal(label(), 'Users, 3 users awaiting approval');
  assert.match(usersButton().getAttribute('title'), /3 users awaiting approval/);

  pending = 0;
  await act(async () => useStore.getState().loadAll());
  assert.equal(badge(), null, 'no badge at 0');
  assert.equal(label(), 'Users');
});

test('users:pending updates the badge live: a new sign-up, then approvals', async () => {
  await render();
  assert.equal(badge(), null);
  await event('users:pending', { count: 1 });
  assert.equal(badge(), '1');
  assert.equal(label(), 'Users, 1 user awaiting approval');
  await event('users:pending', { count: 2 });
  assert.equal(badge(), '2');
  await event('users:pending', { count: 120 });
  assert.equal(badge(), '99+', 'capped like the other activity-bar badges');
  assert.equal(label(), 'Users, 120 users awaiting approval', 'the label keeps the exact number');
  await event('users:pending', { count: 0 });
  assert.equal(badge(), null);
  // Signing out drops the count.
  await event('users:pending', { count: 4 });
  await act(async () => useStore.getState().signedOut());
  assert.equal(useStore.getState().pendingUsers, 0);
});

test('the badge shows in the labelled and the bottom (narrow) activity bar too', async () => {
  await event('users:pending', { count: 5 });
  for (const layout of [{ ...STANDARD(), activityLabels: true }, { ...STANDARD(), activity: 'bottom' }, LAYOUTS.find((l) => l.activity === 'right')]) {
    await render(layout);
    assert.equal(badge(), '5', `${layout.id} ${layout.activity} labels=${layout.activityLabels}`);
    assert.equal(label(), 'Users, 5 users awaiting approval');
    await act(async () => root.unmount());
    root = null;
  }
});

test('a non-admin never asks for the count nor sees a Users badge', async () => {
  pending = 7;
  await act(async () => useStore.setState({ me: BOB }));
  await act(async () => useStore.getState().loadAll());
  await settle();
  assert.ok(!calls.includes('/api/users/pending'), 'no count request for a non-admin');
  assert.equal(useStore.getState().pendingUsers, 0);
  // Even a count that somehow reached the store is not shown: the Users view is admin-only.
  await act(async () => useStore.setState({ pendingUsers: 7 }));
  await render();
  assert.equal(usersButton() === null, true, 'no Users item for a non-admin');
  assert.equal(document.querySelector('#root [data-badge="users"]') === null, true);
});
