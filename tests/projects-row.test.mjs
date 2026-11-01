// Project rows (client/src/views/projects/Projects.jsx): rename only via context menu "Rename" or F2, never by double-click.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { window as w, createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;

const PROJECTS = [
  { id: 'p-a', name: 'Alpha', status: 'idle', path: '/x/a', manager_name: 'Atlas', tasks_done: 1, running_agents: 0, updated_at: '2026-10-31T10:00:00Z' },
  { id: 'p-b', name: 'Beta', status: 'idle', path: '/x/b', manager_name: 'Orion', tasks_done: 2, running_agents: 0, updated_at: '2026-10-31T10:05:00Z' },
];
// Only the project list is mounted; the chat and agent panes are hidden.
const LAYOUT = { id: 'test', floating: false, project: { orientation: 'horizontal', order: ['list', 'chat', 'agents'], hide: ['chat', 'agents'], sizes: {} } };

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://localhost:4800');
  calls.push({ method: opts.method || 'GET', url: u.pathname, body: opts.body ? JSON.parse(opts.body) : undefined });
  return new Response(JSON.stringify(/\/(topics|messages)$/.test(u.pathname) ? [] : {}), { status: 200 });
};
const patches = () => calls.filter((c) => c.method === 'PATCH');

let loader, Projects, ContextMenuHost, useStore, INIT, root;

before(async () => {
  loader = await createLoader({
    stubs: {
      'src/views/projects/CommandWindow.jsx': 'export const CommandWindow = () => null;',
      'src/views/projects/AgentRail.jsx': 'export const AgentRail = () => null;',
    },
  });
  ({ useStore } = await loader.load('/src/lib/store.js'));
  ({ ContextMenuHost } = await loader.load('/src/components/ContextMenu.jsx'));
  Projects = (await loader.load('/src/views/projects/Projects.jsx')).default;
  INIT = { ...useStore.getState() };
});

after(async () => {
  if (root) await act(async () => root.unmount());
  await loader?.close();
});

beforeEach(async () => {
  if (root) await act(async () => root.unmount());
  await act(async () => {
    useStore.setState({ ...INIT, projects: structuredClone(PROJECTS), activeProjectId: null, topics: {}, activeTopic: {}, messages: {}, agents: [] }, true);
  });
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(React.Fragment, null, h(Projects, { layout: LAYOUT }), h(ContextMenuHost))));
  calls.length = 0;
});

const rows = () => [...document.querySelectorAll('#root .group.relative')];
const row = (name) => rows().find((r) => r.textContent.includes(name) || r.querySelector('input')?.defaultValue === name);
const renameInput = () => document.querySelector('#root .group.relative input');
const listRoot = () => document.querySelector('#root [tabindex="-1"]');
const mouse = (node, type, o = {}) => act(async () => { node.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...o })); });
const key = (node, k) => act(async () => { node.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
// Browser order for a double-click; each event in its own act() so React commits between events, as in a browser.
const doubleClick = async (node) => {
  await mouse(node, 'click', { detail: 1 });
  await mouse(node, 'click', { detail: 2 });
  await mouse(node, 'dblclick', { detail: 2 });
};
const contextRename = async (node) => {
  await mouse(node, 'contextmenu', { button: 2, clientX: 20, clientY: 20 });
  const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((b) => b.textContent.includes('Rename'));
  assert.ok(item, 'context menu has a Rename item');
  await mouse(item, 'click', { detail: 1 });
};
const typeInto = (el, v) => act(async () => {
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
});

test('double-click on a project row selects it but shows no rename input', async () => {
  assert.equal(rows().length, 2);
  await doubleClick(row('Beta'));
  assert.ok(!renameInput(), 'no rename input');
  assert.equal(useStore.getState().activeProjectId, 'p-b');
  // Double-clicking the row that is already active must not rename either.
  await doubleClick(row('Beta'));
  assert.ok(!renameInput(), 'no rename input');
  assert.deepEqual(patches(), []);
});

test('context-menu Rename shows the rename input for that row', async () => {
  await contextRename(row('Beta'));
  const input = renameInput();
  assert.ok(input, 'rename input shown');
  assert.ok(row('Beta').contains(input), 'input is in the Beta row');
  assert.equal(input.value, 'Beta');
  assert.ok(document.activeElement === input, 'rename input focused');
});

test('F2 on the selected row shows the rename input', async () => {
  await mouse(row('Alpha'), 'click', { detail: 1 });
  assert.ok(!renameInput(), 'no rename input');
  await key(listRoot(), 'F2');
  const input = renameInput();
  assert.ok(input, 'rename input shown');
  assert.ok(row('Alpha').contains(input), 'input is in the Alpha row');
  assert.equal(input.value, 'Alpha');
});

test('Escape cancels the rename without an API call', async () => {
  await contextRename(row('Alpha'));
  await typeInto(renameInput(), 'Alpha renamed');
  await key(renameInput(), 'Escape');
  assert.ok(!renameInput(), 'no rename input');
  assert.deepEqual(patches(), []);
});

test('blur with the name unchanged closes the input without an API call', async () => {
  await mouse(row('Beta'), 'click', { detail: 1 });
  await key(listRoot(), 'F2');
  const input = renameInput();
  await act(async () => input.blur());
  assert.ok(!renameInput(), 'no rename input');
  assert.deepEqual(patches(), []);
});
