// Login homepage, waiting screen and Users page (client/src/App.jsx, lib/store.js, views/Login.jsx, views/Users.jsx)
// over a fake API that keys accounts by device secret like the server: sign-up asks for a username only and sends this
// browser's device; the pending browser waits without a session; once approved it signs in by itself, with no
// password, after a reload too; another browser (another or a forged secret) is not; Log out is not undone by the
// automatic sign-in; the administrator sees the computer info in the approval list.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { window as w, createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;

const INFO = { label: 'Chrome on Linux', os: 'Linux', browser: 'Chrome', platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0', screen: '1920x1080', language: 'en-US', timezone: 'Europe/Berlin' };
const PENDING = { id: 'u2', username: 'bob', role: 'user', status: 'pending', team: null, permissions: { projects: [] }, device_bound: true, device_info: INFO };
let server; // { me, setup, users, accounts: { [secret]: user } }
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://localhost:4800');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ method, url: u.pathname, body });
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  if (u.pathname === '/api/auth/me') return server.me ? json({ user: server.me, capabilities: {} }) : json({ error: 'Sign in required' }, 401);
  if (u.pathname === '/api/auth/state') return json({ setup: server.setup });
  if (u.pathname === '/api/auth/signup') {
    if (!/^[\w-]{43}$/.test(body.device?.secret || '')) return json({ error: 'no device key', code: 'device_required' }, 400);
    const user = { ...PENDING, username: body.username, ...(server.setup ? { role: 'admin', status: 'active' } : {}) };
    server.accounts[body.device.secret] = user;
    if (user.status === 'active') { server.me = user; return json({ user }); }
    return json({ user, pending: true });
  }
  if (u.pathname === '/api/auth/device') {
    const user = server.accounts[body.device?.secret];
    if (!user) return json({ error: 'This computer is not registered. Sign up with a username first.', code: 'unknown_device' }, 401);
    if (user.status !== 'active') return json({ error: `status ${user.status}`, code: user.status, user: { username: user.username } }, 403);
    server.me = user;
    return json({ user });
  }
  if (u.pathname === '/api/auth/logout') { server.me = null; return json({ ok: true }); }
  if (u.pathname === '/api/users') return json({ users: server.users, capabilities: { runMissions: 'Run missions' } });
  const m = /^\/api\/users\/([^/]+)\/([a-z-]+)$/.exec(u.pathname);
  if (m) {
    const user = server.users.find((x) => x.id === m[1]);
    if (m[2] === 'permissions') Object.assign(user, { permissions: body });
    if (m[2] === 'approve') user.status = 'active';
    if (m[2] === 'reset-device') Object.assign(user, { device_bound: false, device_info: null });
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
  server = { me: null, setup: false, users: [], accounts: {} };
  calls.length = 0;
  localStorage.clear(); // a browser that never registered
  await act(async () => useStore.setState({ ...INIT, me: undefined, setup: false, device: null }, true));
  root = createRoot(document.getElementById('root'));
});

// A page reload: the store starts over, the browser's storage stays.
const reload = async () => {
  await act(async () => root.unmount());
  await act(async () => useStore.setState({ ...INIT, me: undefined, setup: false, device: null }, true));
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(App)));
  await settle();
};
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
const text = () => document.getElementById('root').textContent;
const button = (label) => [...document.querySelectorAll('#root button')].find((b) => b.textContent.trim() === label || b.getAttribute('aria-label') === label);
const click = (node) => act(async () => { node.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); });
const typeInto = (el, v) => act(async () => {
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
});
const inputs = () => [...document.querySelectorAll('#root input')];

const submit = () => act(async () => document.querySelector('#root form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })));
const signedInView = () => !!(button('Dashboard') && button('Projects'));

test('signed out: the sign-up screen has only a username field and a Register button', async () => {
  await act(async () => root.render(h(App)));
  await settle();
  assert.ok(text().includes('Sign up'));
  assert.deepEqual(inputs().map((i) => i.type || 'text'), ['text'], 'one field');
  assert.equal(document.querySelector('#root input[type="password"]'), null);
  assert.ok(button('Register'));
  assert.equal(button('Team registration'), undefined);
  assert.equal(button('Sign in on this computer'), undefined, 'this browser has no device yet');
  assert.equal(button('Dashboard'), undefined, 'no navigation');
  assert.ok(!calls.some((c) => c.url === '/api/projects' || c.url === '/api/auth/device'), 'no data requested, no device sign-in without a device');
});

test('register → waiting for approval (no session) → approved → signed in by its device with no password, after a reload too', async () => {
  await act(async () => root.render(h(App)));
  await settle();
  await typeInto(inputs()[0], ' bob ');
  await submit();
  await settle();
  const sent = calls.find((c) => c.url === '/api/auth/signup').body;
  assert.deepEqual(Object.keys(sent).sort(), ['device', 'username']);
  assert.equal(sent.username, 'bob');
  assert.match(sent.device.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(localStorage.getItem('agentforge.device'), sent.device.secret, 'the secret stays in this browser');
  assert.ok(sent.device.info.label && sent.device.info.userAgent && 'screen' in sent.device.info && 'platform' in sent.device.info);
  assert.ok(text().includes('Waiting for administrator approval'));
  assert.ok(text().includes('bob'));
  assert.equal(server.me, null, 'no session');
  assert.equal(button('Dashboard'), undefined);

  // Still pending: checking again keeps waiting.
  await click(button('Check again'));
  await settle();
  assert.ok(text().includes('Waiting for administrator approval'));
  // A reload while pending lands on the waiting screen again, not on sign-up.
  await reload();
  assert.ok(text().includes('Waiting for administrator approval'));

  // Approved as a plain user: the control room opens, without admin-only views.
  server.accounts[sent.device.secret].status = 'active';
  await click(button('Check again'));
  await settle();
  assert.ok(signedInView());
  for (const v of ['Users', 'Settings', 'Files', 'GitHub', 'Agents', 'Models']) assert.equal(button(v), undefined, v);
  assert.ok(!calls.some((c) => c.url === '/api/auth/login'), 'never a password');

  // Session gone (expired, server restart…): a reload signs in again by the device alone.
  server.me = null;
  calls.length = 0;
  await reload();
  assert.ok(signedInView());
  assert.equal(calls.find((c) => c.url === '/api/auth/device').body.device.secret, sent.device.secret);

  // Log out sticks: the reload shows the homepage, and "Sign in on this computer" signs in again.
  await act(async () => useStore.getState().logout());
  await reload();
  assert.equal(button('Dashboard'), undefined);
  await click(button('Sign in on this computer'));
  await settle();
  assert.ok(signedInView());
});

test('another browser, or a forged device secret, is not signed in', async () => {
  const mine = 'A'.repeat(43);
  server.accounts[mine] = { ...PENDING, status: 'active' };
  localStorage.setItem('agentforge.device', 'B'.repeat(43)); // registered nowhere
  await act(async () => root.render(h(App)));
  await settle();
  assert.equal(button('Dashboard'), undefined);
  assert.ok(text().includes('Sign up'));
  await click(button('Sign in on this computer'));
  await settle();
  assert.ok(text().includes('This computer is not registered'));
  assert.equal(button('Dashboard'), undefined);
  // Only its own secret signs the account in.
  localStorage.setItem('agentforge.device', mine);
  await reload();
  assert.ok(signedInView());
});

test('a rejected registration is told so on the homepage, with no session', async () => {
  const secret = 'R'.repeat(43);
  server.accounts[secret] = { ...PENDING, status: 'rejected' };
  localStorage.setItem('agentforge.device', secret);
  await act(async () => root.render(h(App)));
  await settle();
  assert.ok(text().includes('status rejected'));
  assert.ok(text().includes('bob'));
  assert.equal(button('Dashboard'), undefined);
  assert.equal(server.me, null);
});

test('existing password accounts: "Log in with a password" sends the password with this browser\'s device', async () => {
  await act(async () => root.render(h(App)));
  await settle();
  const link = [...document.querySelectorAll('#root button')].find((b) => b.textContent.includes('Log in with a password'));
  await click(link);
  const [name, pw] = inputs();
  assert.equal(pw.type, 'password');
  await typeInto(name, 'dave');
  await typeInto(pw, 'correct horse');
  await submit();
  await settle();
  const sent = calls.find((c) => c.url === '/api/auth/login').body;
  assert.deepEqual([sent.username, sent.password], ['dave', 'correct horse']);
  assert.match(sent.device.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(sent.fingerprint && 'gpu' in sent.fingerprint, 'the legacy fingerprint, for accounts bound to one');
});

test('with no administrator yet, the homepage creates it from a username alone', async () => {
  server.setup = true;
  await act(async () => root.render(h(App)));
  await settle();
  assert.ok(text().includes('Create the administrator account'));
  assert.equal(inputs().length, 1);
  assert.equal(button('Sign up'), undefined);
  await typeInto(inputs()[0], 'owner');
  await click(button('Create administrator'));
  await settle();
  assert.ok(signedInView());
  assert.ok(button('Users'), 'administrator views');
});

test('Users page: approve a registration, grant a project and a capability, reset the device', async () => {
  server.users = [{ ...PENDING }];
  await act(async () => useStore.setState({ me: { id: 'u1', username: 'owner', role: 'admin', status: 'active' }, projects: [{ id: 'core', name: 'AgentForge', protected: true }, { id: 'p1', name: 'Alpha' }] }));
  await act(async () => root.render(h(Users)));
  await settle();
  assert.ok(text().includes('1 waiting for approval'));
  // The computer it registered from, as its browser described it.
  const dev = document.querySelector('#root [data-device-info]').textContent;
  for (const v of ['Chrome on Linux', 'Linux', 'Linux x86_64', 'screen 1920x1080', 'Europe/Berlin', INFO.userAgent]) assert.ok(dev.includes(v), v);
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
  assert.equal(document.querySelector('#root [data-device-info]'), null);
});
