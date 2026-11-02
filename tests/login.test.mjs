// Login homepage, waiting screen and Users page (client/src/App.jsx, views/Login.jsx, views/Users.jsx) over a fake API:
// signed out → homepage with Sign up and Team registration; a sign-up waits for approval; an approved non-admin gets
// no admin views; the administrator approves, sets permissions and resets devices from the Users page.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { window as w, createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;

const PENDING = { id: 'u2', username: 'bob', role: 'user', status: 'pending', team: 'Platform', permissions: { projects: [] }, device_bound: true };
let server; // { me, setup, users }
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://localhost:4800');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ method, url: u.pathname, body });
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  if (u.pathname === '/api/auth/me') return server.me ? json({ user: server.me, capabilities: {} }) : json({ error: 'Sign in required' }, 401);
  if (u.pathname === '/api/auth/state') return json({ setup: server.setup });
  if (u.pathname === '/api/auth/signup') { server.me = { ...PENDING, username: body.username, team: body.team || null }; return json({ user: server.me }); }
  if (u.pathname === '/api/users') return json({ users: server.users, capabilities: { runMissions: 'Run missions' } });
  const m = /^\/api\/users\/([^/]+)\/([a-z-]+)$/.exec(u.pathname);
  if (m) {
    const user = server.users.find((x) => x.id === m[1]);
    if (m[2] === 'permissions') Object.assign(user, { permissions: body });
    if (m[2] === 'approve') user.status = 'active';
    if (m[2] === 'reset-device') user.device_bound = false;
    return json(user);
  }
  return json(/\/api\/(projects|agents|models|notifications)$/.test(u.pathname) ? [] : {});
};

let loader, App, Users, useStore, INIT, root;
w.HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no canvas: the fingerprint falls back to 'no-webgl'

before(async () => {
  loader = await createLoader({
    stubs: {
      'src/views/Dashboard.jsx': 'export default () => null;',
      'src/views/projects/Projects.jsx': 'export default () => null;',
      'src/views/agents/AgentDetail.jsx': 'export const AgentDetailModal = () => null;',
      'src/lib/favicon.js': 'export const updateFavicon = () => {};', // draws on a canvas
    },
  });
  ({ useStore } = await loader.load('/src/lib/store.js'));
  App = (await loader.load('/src/App.jsx')).default;
  Users = (await loader.load('/src/views/Users.jsx')).default;
  INIT = { ...useStore.getState() };
});

after(async () => {
  if (root) await act(async () => root.unmount());
  await loader?.close();
});

beforeEach(async () => {
  if (root) await act(async () => root.unmount());
  server = { me: null, setup: false, users: [] };
  calls.length = 0;
  await act(async () => useStore.setState({ ...INIT, me: undefined, setup: false }, true));
  root = createRoot(document.getElementById('root'));
});

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
const text = () => document.getElementById('root').textContent;
const button = (label) => [...document.querySelectorAll('#root button')].find((b) => b.textContent.trim() === label || b.getAttribute('aria-label') === label);
const click = (node) => act(async () => { node.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); });
const typeInto = (el, v) => act(async () => {
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
});
const inputs = () => [...document.querySelectorAll('#root input')];

test('signed out: the homepage shows Log in, a Sign up button and a small Team registration button, and nothing else', async () => {
  await act(async () => root.render(h(App)));
  await settle();
  assert.ok(text().includes('Sign in to the AgentForge control room'));
  assert.ok(button('Log in') && button('Sign up') && button('Team registration'));
  assert.equal(button('Dashboard'), undefined, 'no navigation');
  assert.ok(!calls.some((c) => c.url === '/api/projects'), 'no data requested');
});

test('team registration sends the device fingerprint (no IP) and lands on the waiting screen', async () => {
  await act(async () => root.render(h(App)));
  await settle();
  await click(button('Team registration'));
  assert.ok(text().includes('Team registration'));
  const [team, name, pw, confirm] = inputs();
  await typeInto(team, 'Platform');
  await typeInto(name, 'bob');
  await typeInto(pw, 'correct horse');
  await typeInto(confirm, 'correct horse');
  await act(async () => document.querySelector('#root form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  const sent = calls.find((c) => c.url === '/api/auth/signup').body;
  assert.equal(sent.team, 'Platform');
  assert.deepEqual(Object.keys(sent.device).sort(), ['canvas', 'colorDepth', 'cores', 'gpu', 'language', 'memory', 'platform', 'screen', 'timezone', 'touch']);
  assert.ok(text().includes('Waiting for administrator approval'));
  assert.ok(text().includes('Platform'));
  assert.equal(button('Dashboard'), undefined);

  // Approved as a plain user: the control room opens, without admin-only views.
  server.me = { ...server.me, status: 'active' };
  await click(button('Check again'));
  await settle();
  assert.ok(button('Dashboard') && button('Projects'));
  for (const v of ['Users', 'Settings', 'Files', 'GitHub', 'Agents', 'Models']) assert.equal(button(v), undefined, v);
});

test('with no administrator yet, the homepage creates it', async () => {
  server.setup = true;
  await act(async () => root.render(h(App)));
  await settle();
  assert.ok(text().includes('Create the administrator account'));
  assert.ok(button('Create administrator'));
  assert.equal(button('Sign up'), undefined);
});

test('Users page: approve a registration, grant a project and a capability, reset the device', async () => {
  server.users = [{ ...PENDING }];
  await act(async () => useStore.setState({ me: { id: 'u1', username: 'owner', role: 'admin', status: 'active' }, projects: [{ id: 'core', name: 'AgentForge', protected: true }, { id: 'p1', name: 'Alpha' }] }));
  await act(async () => root.render(h(Users)));
  await settle();
  assert.ok(text().includes('1 waiting for approval'));
  await click(button('Approve'));
  await settle();
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.url), ['/api/users/u2/approve']);
  await click(button('Permissions'));
  const labels = [...document.querySelectorAll('#root label')].map((l) => l.textContent);
  assert.ok(labels.includes('Alpha') && !labels.includes('AgentForge'), 'the platform project is not offered');
  await click(document.querySelector('#root input[type="checkbox"]'));
  await click(document.querySelector('#root [role="switch"]'));
  await click(button('Save permissions'));
  await settle();
  assert.deepEqual(calls.find((c) => c.method === 'PUT').body, { projects: ['p1'], runMissions: true });
  await click(button('Reset device'));
  await settle();
  assert.ok(calls.some((c) => c.url === '/api/users/u2/reset-device'));
  assert.ok(text().includes('No device bound'));
});
