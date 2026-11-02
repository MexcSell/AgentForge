// Role-limited Settings and the per-user Git identity editor (client/src/views/Settings.jsx, Users.jsx,
// client/src/lib/access.js + store.js): a non-admin opens Settings from the activity bar and sees only Appearance and
// Screen format (browser preferences, saved in localStorage; /api/settings is never requested); an administrator sees
// every section. On the Users page the administrator edits a user's Git name, email and branch; the server's refusal
// message is shown and nothing is reported as saved.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;
const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin', status: 'active', permissions: {} };
// Even with manageSettings: Settings beyond the browser preferences is admin-only.
const BOB = { id: 'u-bob', username: 'bob', role: 'user', status: 'active', permissions: { projects: [], manageSettings: true } };
const SETTINGS = { orchestrator: { maxParallel: 4, taskTimeoutMin: 30 }, evolution: { enabled: true, lessonsPerVersion: 3, playbookSize: 8 }, monitor: { enabled: true, intervalSec: 3 }, github: {} };
const SYSTEM = { status: 'online', version: '0.1.0', uptimeSec: 5, startedAt: new Date().toISOString(), supervisor: { attached: false }, node: 'v22', pid: 1, memory: { rss: 1 }, clients: 1, terminals: 0 };

const calls = [];
let gitReply = null; // { status, body } for PUT /api/users/:id/git
const BOB_ROW = { ...BOB, created_at: new Date().toISOString(), device_bound: true, git_name: null, git_email: null, git_branch: null };
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url, 'http://localhost:4800').pathname;
  calls.push(`${init.method || 'GET'} ${path}${init.body ? ` ${init.body}` : ''}`);
  let status = 200, body = [];
  if (path === '/api/settings') body = SETTINGS;
  else if (path === '/api/system/status') body = SYSTEM;
  else if (path === '/api/users/pending') body = { count: 0 };
  else if (path === '/api/system/network') body = { https: false, env: {}, running: { port: 4800, host: '0.0.0.0', trustProxy: null }, restartNeeded: false };
  else if (path === '/api/users') body = { users: [ADMIN, BOB_ROW].map((u) => ({ created_at: new Date().toISOString(), ...u })), capabilities: {} };
  else if (path.endsWith('/git')) ({ status, body } = gitReply);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

let loader, useStore, useToasts, Settings, Users, ActivityBar, LAYOUTS, INIT, root;

before(async () => {
  loader = await createLoader();
  ({ useStore } = await loader.load('/src/lib/store.js'));
  ({ useToasts } = await loader.load('/src/lib/toast.js'));
  ({ default: Settings } = await loader.load('/src/views/Settings.jsx'));
  ({ default: Users } = await loader.load('/src/views/Users.jsx'));
  ({ ActivityBar } = await loader.load('/src/components/Shell.jsx'));
  ({ LAYOUTS } = await loader.load('/src/lib/layouts.js'));
  INIT = { ...useStore.getState() };
});

after(async () => {
  if (root) await act(async () => root.unmount());
  await loader?.close();
});

beforeEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  calls.length = 0;
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const render = async (el) => {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(el));
  await settle();
};
const sections = () => [...document.querySelectorAll('#root section span.font-semibold')].map((s) => s.textContent.split(' · ')[0]);
const signIn = async (me) => {
  await act(async () => useStore.setState({ ...INIT, me, view: 'settings' }, true));
  await act(async () => useStore.getState().loadAll());
};

test('a non-admin sees only Appearance and Screen format, can open Settings, and never asks for /api/settings', async () => {
  await signIn(BOB);
  assert.equal(useStore.getState().view, 'settings', 'Settings stays open for a non-admin');
  assert.ok(!calls.some((c) => c.includes('/api/settings')), calls.join('\n'));
  await render(h(Settings));
  assert.deepEqual(sections(), ['Appearance', 'Screen format']);
  assert.ok(!calls.some((c) => c.includes('/api/settings') || c.includes('/api/system/network')), calls.join('\n'));
  // Their choices still save: browser preferences.
  const other = LAYOUTS.find((l) => l.id !== useStore.getState().layoutId);
  const btn = [...document.querySelectorAll('#root button')].find((b) => b.textContent.includes(other.name));
  await act(async () => btn.click());
  const light = [...document.querySelectorAll('#root button')].find((b) => b.textContent === 'Light');
  await act(async () => light.click());
  const prefs = JSON.parse(localStorage.getItem('af.prefs') || '{}');
  assert.equal(prefs.layoutId, other.id);
  assert.equal(prefs.theme, 'light');
  assert.ok(!calls.some((c) => c.startsWith('PUT')), 'nothing is sent to the server');
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(ActivityBar, { layout: LAYOUTS[0] })));
  assert.ok(document.querySelector('#root button[aria-label^="Settings"]'), 'the Settings nav entry is shown');
  assert.ok(!document.querySelector('#root button[aria-label^="Users"]'), 'no Users nav entry'); // never a rendered node in a failing assert: its diff inspects the whole React tree
});

test('an administrator sees every section as before', async () => {
  await signIn(ADMIN);
  assert.ok(calls.includes('GET /api/settings'));
  await render(h(Settings));
  assert.deepEqual(sections(), ['Appearance', 'Screen format', 'Orchestrator', 'Self-learning', 'System monitor', 'Network', 'Service', 'Technology choices']);
});

test('the administrator edits a user\'s Git identity on the Users page; a refusal shows the server\'s message', async () => {
  await signIn(ADMIN);
  await render(h(Users));
  const row = [...document.querySelectorAll('#root .rounded-\\[var\\(--af-radius\\)\\]')].find((r) => r.textContent.startsWith('bob'));
  await act(async () => [...row.querySelectorAll('button')].find((b) => b.textContent === 'Git').click());
  const form = row.querySelector('[data-git-identity]');
  assert.ok(form);
  const type = async (name, value) => {
    const input = form.querySelector(`input[name="${name}"]`);
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  };
  const save = () => [...form.querySelectorAll('button')].find((b) => b.textContent.includes('Save Git identity'));
  assert.equal(save().disabled, true, 'nothing to save yet');
  await type('git_name', 'Bob Builder');
  await type('git_email', 'bob@example');
  await type('git_branch', 'users/bob');
  gitReply = { status: 400, body: { error: 'Git user.email "bob@example" is not an email address (like name@example.com)', code: 'invalid_git_email' } };
  await act(async () => save().click());
  await settle();
  assert.ok(calls.includes('PUT /api/users/u-bob/git {"git_name":"Bob Builder","git_email":"bob@example","git_branch":"users/bob"}'), calls.join('\n'));
  const toasts = () => useToasts.getState().items.map((t) => `${t.kind}: ${t.title}`);
  assert.ok(toasts().includes('error: Git user.email "bob@example" is not an email address (like name@example.com)'), toasts().join('\n'));
  assert.ok(!toasts().some((t) => t.startsWith('success')));
  assert.equal(save().disabled, false, 'the edit stays to be fixed');
  await type('git_email', 'bob@example.com');
  gitReply = { status: 200, body: { ...BOB_ROW, git_name: 'Bob Builder', git_email: 'bob@example.com', git_branch: 'users/bob' } };
  await act(async () => save().click());
  await settle();
  assert.equal(save().disabled, true, 'saved: the form matches the stored values');
  assert.ok(toasts().includes('success: Git identity saved · bob'));
  assert.ok(row.textContent.includes('users/bob'), 'the branch badge shows');
});
