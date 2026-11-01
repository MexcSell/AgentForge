// Org rail membership (client/src/views/projects/AgentRail.jsx + AgentOrg.jsx): the team comes from GET /members and stays live
// through 'project:members' (real ws.js); Add agent, Release, Release idle and Restore call the members API (stubbed here as a
// small in-memory server that publishes before it replies, like server/services/members.js).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { window as w, createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;
const PID = '00000000-0000-4000-8000-0000000000aa';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AGENTS = [
  { id: id(1), name: 'Atlas', role: 'manager', tier: 2, level: 5, status: 'idle', supervisor_id: null },
  { id: id(2), name: 'Kernel', role: 'backend', tier: 3, level: 6, status: 'idle', supervisor_id: id(1) },
  { id: id(3), name: 'Pixel', role: 'frontend', tier: 3, level: 6, status: 'working', supervisor_id: id(1) },
  { id: id(4), name: 'Lens', role: 'qa', tier: 4, level: 5, status: 'idle', supervisor_id: id(1) },
  { id: id(5), name: 'Iris', role: 'designer', tier: 3, level: 3, status: 'idle', supervisor_id: id(1) },
  { id: id(6), name: 'Probe', role: 'qa', tier: 4, level: 7, status: 'idle', supervisor_id: id(4) },
  { id: id(7), name: 'Quill', role: 'writer', tier: 3, level: 2, status: 'idle', supervisor_id: null },
];
const PROJECT = { id: PID, name: 'AgentForge', status: 'running', manager_id: id(1), manager_name: 'Atlas' };
// Pixel has a running task (busy); Kernel's task is done.
const TASKS = [
  { id: 't1', key: 'T1', title: 'Members API', status: 'done', progress: 100, agent_id: id(2), project_id: PID, created_at: '2026-11-01T10:00:00Z' },
  { id: 't3', key: 'T3', title: 'Org rail controls', status: 'running', progress: 40, agent_id: id(3), project_id: PID, created_at: '2026-11-01T10:01:00Z', started_at: '2026-11-01T10:02:00Z' },
];

// ---- stubbed server -------------------------------------------------------
let server; // { rows: Map(agentId → status), busyOverride: Set }
const calls = [];
let sock = null;
let holdNext = null; // when set, the next mutation waits for this promise before replying (event already sent)
const memberRows = () => {
  const out = [];
  for (const [aid, status] of server.rows) {
    const a = AGENTS.find((x) => x.id === aid);
    const busy = [...TASKS.filter((t) => t.agent_id === aid && ['pending', 'running'].includes(t.status)).map((t) => t.key), ...(server.busy.get(aid) || [])];
    out.push({ agent_id: aid, name: a.name, role: a.role, tier: a.tier, level: a.level, status, added_by: 'auto', is_manager: aid === PROJECT.manager_id, busy_tasks: busy });
  }
  return out.sort((x, y) => (y.is_manager - x.is_manager) || x.status.localeCompare(y.status));
};
const publish = () => sock?.onmessage({ data: JSON.stringify({ type: 'project:members', payload: { project_id: PID, members: memberRows() } }) });
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const idleOk = (aid) => aid !== PROJECT.manager_id && !memberRows().find((m) => m.agent_id === aid)?.busy_tasks.length;

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://localhost:4800');
  const method = opts.method || 'GET';
  calls.push({ method, url: u.pathname, body: opts.body ? JSON.parse(opts.body) : undefined });
  const base = `/api/projects/${PID}/members`;
  if (method === 'GET' && u.pathname === base) return reply(200, memberRows());
  let out;
  if (method === 'POST' && u.pathname === base) {
    const aid = JSON.parse(opts.body).agent_id;
    const changed = server.rows.get(aid) !== 'active';
    server.rows.set(aid, 'active');
    if (changed) publish();
    out = { changed, agent: { id: aid }, members: memberRows() };
  } else if (method === 'POST' && u.pathname === `${base}/release-idle`) {
    const released = [...server.rows].filter(([aid, s]) => s === 'active' && idleOk(aid)).map(([aid]) => aid);
    for (const aid of released) server.rows.set(aid, 'released');
    if (released.length) publish();
    out = { released, members: memberRows() };
  } else if (method === 'DELETE' && u.pathname.startsWith(`${base}/`)) {
    const aid = u.pathname.slice(base.length + 1);
    const m = memberRows().find((x) => x.agent_id === aid);
    if (m.is_manager) return reply(409, { error: `${m.name} is the General Manager of AgentForge and can't be released` });
    if (m.busy_tasks.length) return reply(409, { error: `${m.name} still has a pending or running task in AgentForge (${m.busy_tasks.join(', ')}); release it once they finish` });
    server.rows.set(aid, 'released');
    publish();
    out = { changed: true, members: memberRows() };
  } else {
    return reply(404, { error: 'Not found' });
  }
  if (holdNext) { const p = holdNext; holdNext = null; await p; }
  return reply(200, out);
};
const mutations = () => calls.filter((c) => c.method !== 'GET');

let mountCalls = [];
let loader, AgentRail, useStore, useToasts, ToastsHost, INIT, root;

before(async () => {
  globalThis.WebSocket = class { constructor() { sock = this; this.readyState = 1; } send() {} close() {} };
  loader = await createLoader();
  ({ useStore } = await loader.load('/src/lib/store.js'));
  ({ useToasts } = await loader.load('/src/lib/toast.js'));
  ({ connectEvents: globalThis.__connect } = await loader.load('/src/lib/ws.js'));
  ({ AgentRail } = await loader.load('/src/views/projects/AgentRail.jsx'));
  ({ Toasts: ToastsHost } = await loader.load('/src/components/Shell.jsx'));
  INIT = { ...useStore.getState() };
  globalThis.__connect();
});

after(async () => {
  if (root) await act(async () => root.unmount());
  await loader?.close();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

beforeEach(async () => {
  if (root) await act(async () => root.unmount());
  // Atlas (GM), Kernel, Pixel (busy), Lens, Probe active; Iris released; Quill never a member.
  server = { rows: new Map([[id(1), 'active'], [id(2), 'active'], [id(3), 'active'], [id(4), 'active'], [id(6), 'active'], [id(5), 'released']]), busy: new Map() };
  await act(async () => {
    useStore.setState({ ...INIT, projects: [PROJECT], agents: structuredClone(AGENTS), tasks: { [PID]: structuredClone(TASKS) }, members: {}, topics: {}, missionsByTopic: {} }, true);
    useToasts.setState({ items: [] });
  });
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(AgentRail, { project: PROJECT })));
  await settle();
  mountCalls = calls.splice(0);
});

// ---- helpers ----------------------------------------------------------------
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const nameOf = (aid) => AGENTS.find((a) => a.id === aid).name;
const cardNames = () => qa('#root [aria-label="Team hierarchy"] [data-agent]').map((b) => nameOf(b.dataset.agent)).sort();
const releaseBtn = (name) => q(`#root [data-release="${AGENTS.find((a) => a.name === name).id}"]`);
const button = (text, scope = document) => [...scope.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const dialog = () => q('[role="dialog"]');
const click = async (el) => { await act(async () => { el.click(); }); await settle(); };
const key = (el, k) => act(async () => { el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const focus = (el) => act(async () => el.focus());
const typeInto = (el, v) => act(async () => {
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
});
const pick = (el, v) => act(async () => {
  Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
});
const releasedToggle = () => q('#root [data-released-toggle]');
const releasedNames = async () => {
  const t = releasedToggle();
  if (!t) return [];
  if (t.getAttribute('aria-expanded') !== 'true') await click(t);
  return qa(`#${CSS.escape(t.getAttribute('aria-controls'))} li`).map((li) => li.textContent.replace('Restore', '').trim()).sort();
};
const CSS = { escape: (s) => s.replace(/:/g, '\\:') };
// The rail must show exactly the server's active members as cards and its released members under Released.
const assertMatchesServer = async () => {
  const rows = memberRows();
  assert.deepEqual(cardNames(), rows.filter((m) => m.status === 'active').map((m) => m.name).sort(), 'cards = active members');
  assert.deepEqual(await releasedNames(), rows.filter((m) => m.status === 'released').map((m) => m.name).sort(), 'Released = released members');
};
const toasts = () => useToasts.getState().items.map((t) => `${t.kind}: ${t.title}${t.body ? ` — ${t.body}` : ''}`);

// ---- tests ------------------------------------------------------------------
test('team comes from GET /members: GM + active members; released listed under a collapsed Released section', async () => {
  assert.deepEqual(mountCalls.map((c) => `${c.method} ${c.url}`), [`GET /api/projects/${PID}/members`]);
  assert.equal(releasedToggle().getAttribute('aria-expanded'), 'false');
  assert.match(releasedToggle().textContent, /Released\s*1/);
  await assertMatchesServer();
  // Probe still hangs under Lens (connector tree untouched).
  const probe = q(`#root li[data-depth="2"] [data-agent="${id(6)}"]`);
  assert.ok(probe, 'Probe at depth 2 under Lens');
});

test('cards show no tier line or XP bar; the hierarchy toggle flattens the tree and is remembered', async () => {
  const card = q(`#root [data-agent="${id(2)}"]`);
  assert.doesNotMatch(card.textContent, /Specialist|Executive|Management|Verification|Evolution/);
  assert.ok(card.children[0].querySelector('[role="progressbar"]') === null, 'no XP bar on the name row');
  const toggle = () => q('#root [aria-pressed][aria-label$="hierarchy"]');
  assert.equal(toggle().getAttribute('aria-label'), 'Hide hierarchy');
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  await click(toggle());
  assert.equal(toggle().getAttribute('aria-label'), 'Show hierarchy');
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  assert.deepEqual(qa('#root li[data-depth]').map((li) => li.dataset.depth), qa('#root li[data-depth]').map(() => '0'), 'all at depth 0');
  assert.equal(qa('#root [aria-label="Team hierarchy"] [data-agent]')[0].dataset.agent, id(1), 'GM first');
  await assertMatchesServer();
  assert.equal(JSON.parse(localStorage.getItem('af.prefs')).orgTree, false);
  await click(toggle());
  assert.ok(q(`#root li[data-depth="2"] [data-agent="${id(6)}"]`), 'tree back');
});

test('the GM card has no Release action; a busy agent\'s Release is disabled with an explanation and sends nothing', async () => {
  assert.ok(q(`#root [data-release="${id(1)}"]`) === null, 'no Release on the GM');
  assert.ok(q(`#root [data-agent="${id(1)}"]`), 'GM card present');
  const b = releaseBtn('Pixel');
  assert.equal(b.getAttribute('aria-disabled'), 'true');
  assert.match(b.getAttribute('aria-label'), /Can't release Pixel yet: T3 is queued or running/);
  assert.equal(b.title, b.getAttribute('aria-label'));
  assert.ok(!b.disabled, 'stays focusable so the hint can be read');
  await click(b);
  assert.ok(dialog() === null, 'no confirm');
  assert.deepEqual(mutations(), []);
  assert.ok(toasts().some((t) => /Pixel is still working/.test(t)));
  // The idle ones are enabled.
  for (const n of ['Kernel', 'Lens', 'Probe']) assert.equal(releaseBtn(n).getAttribute('aria-disabled'), null, n);
  // When the task finishes (task:update), Pixel becomes releasable without a reload.
  await act(async () => sock.onmessage({ data: JSON.stringify({ type: 'task:update', payload: { id: 't3', project_id: PID, status: 'done' } }) }));
  assert.equal(releaseBtn('Pixel').getAttribute('aria-disabled'), null);
});

test('Release: keyboard confirm → DELETE; the card moves to Released; focus returns to Add agent', async () => {
  const b = releaseBtn('Kernel');
  await focus(b);
  await click(b);
  assert.ok(dialog(), 'confirm open');
  assert.match(dialog().textContent, /Release Kernel from AgentForge\?/);
  // Esc cancels and returns focus to the Release button.
  await key(document.activeElement, 'Escape');
  await settle();
  assert.ok(dialog() === null, 'dialog closed');
  assert.ok(document.activeElement === releaseBtn('Kernel'), 'focus back on Kernel\'s Release');
  assert.deepEqual(mutations(), []);
  await click(releaseBtn('Kernel'));
  const confirmBtn = button('Release', dialog());
  assert.ok(document.activeElement === confirmBtn, 'confirm button focused');
  await click(confirmBtn);
  assert.deepEqual(mutations().map((c) => `${c.method} ${c.url}`), [`DELETE /api/projects/${PID}/members/${id(2)}`]);
  assert.ok(dialog() === null, 'dialog closed');
  assert.ok(document.activeElement === button('Add agent'), 'focus on Add agent once the card is gone');
  await assertMatchesServer();
  assert.ok(toasts().some((t) => /success: Kernel released/.test(t)));
});

test('Restore from Released → POST /members; the agent is back on the team', async () => {
  await releasedNames(); // expand
  const restore = q('#root [aria-label="Restore Iris to the project"]');
  assert.ok(restore);
  await click(restore);
  assert.deepEqual(mutations(), [{ method: 'POST', url: `/api/projects/${PID}/members`, body: { agent_id: id(5) } }]);
  assert.ok(releasedToggle() === null, 'Released section gone when empty');
  await assertMatchesServer();
  assert.ok(cardNames().includes('Iris'));
});

test('Add agent picker: keyboard only, search + role filter, Esc closes and focus returns to the opener', async () => {
  const opener = button('Add agent');
  await focus(opener);
  await click(opener);
  assert.ok(dialog());
  const search = dialog().querySelector('input[aria-label="Search agents"]');
  assert.ok(document.activeElement === search, 'search focused');
  const rows = () => qa('[role="dialog"] button[data-add]').map((b) => nameOf(b.dataset.add));
  assert.deepEqual(rows(), ['Iris', 'Quill'], 'only agents not on the team (released included)');
  assert.match(q(`[role="dialog"] [data-add="${id(5)}"]`).getAttribute('aria-label'), /released from this project/);
  await typeInto(search, 'qui');
  assert.deepEqual(rows(), ['Quill']);
  await typeInto(search, '');
  await pick(dialog().querySelector('select[aria-label="Filter by role"]'), 'designer');
  assert.deepEqual(rows(), ['Iris']);
  // Only the candidates' roles are offered.
  assert.deepEqual(qa('[role="dialog"] select option').map((o) => o.value), ['', 'designer', 'writer']);
  await pick(dialog().querySelector('select[aria-label="Filter by role"]'), 'writer');
  assert.deepEqual(rows(), ['Quill']);
  await typeInto(search, 'iris');
  assert.deepEqual(rows(), []);
  assert.match(dialog().textContent, /No agents match/);
  await typeInto(search, '');
  await pick(dialog().querySelector('select[aria-label="Filter by role"]'), '');
  // ArrowDown from the search moves to the first row; Esc closes and refocuses the opener.
  await focus(search);
  await key(search, 'ArrowDown');
  assert.equal(document.activeElement?.dataset.add, id(5));
  await key(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement?.dataset.add, id(7));
  await key(document.activeElement, 'ArrowUp');
  await key(document.activeElement, 'ArrowUp');
  assert.ok(document.activeElement === dialog().querySelector('input[aria-label="Search agents"]'), 'focus back on the search');
  await key(document.activeElement, 'Escape');
  await settle();
  assert.ok(dialog() === null, 'dialog closed');
  assert.ok(document.activeElement === button('Add agent'), 'focus back on Add agent');
  assert.deepEqual(mutations(), []);
  // Add Quill: the picker closes, focus returns, the card appears.
  await click(button('Add agent'));
  await click(q(`[role="dialog"] [data-add="${id(7)}"]`));
  assert.deepEqual(mutations(), [{ method: 'POST', url: `/api/projects/${PID}/members`, body: { agent_id: id(7) } }]);
  assert.ok(dialog() === null, 'dialog closed');
  assert.ok(document.activeElement === button('Add agent'), 'focus back on Add agent');
  assert.ok(cardNames().includes('Quill'));
  await assertMatchesServer();
  assert.ok(toasts().some((t) => /success: Quill added/.test(t)));
});

test('Release idle: confirm lists the idle members; busy Pixel and the GM stay', async () => {
  await click(button('Release idle'));
  assert.match(dialog().textContent, /Release Kernel, Lens, Probe from AgentForge\?/);
  await click(button('Release', dialog()));
  assert.deepEqual(mutations().map((c) => `${c.method} ${c.url}`), [`POST /api/projects/${PID}/members/release-idle`]);
  assert.deepEqual(cardNames(), ['Atlas', 'Pixel']);
  await assertMatchesServer();
  assert.ok(toasts().some((t) => /Released 3 idle agents/.test(t)));
  assert.ok(button('Release idle').disabled, 'nothing idle left');
});

test('a server 409 shows its message as a toast and leaves the rail as it was', async () => {
  server.busy.set(id(4), ['T9']); // a task the client has not heard of yet
  await click(releaseBtn('Lens'));
  await click(button('Release', dialog()));
  assert.ok(dialog() === null, 'dialog closed');
  assert.ok(toasts().some((t) => t === 'error: Lens still has a pending or running task in AgentForge (T9); release it once they finish'), toasts().join('\n'));
  assert.ok(cardNames().includes('Lens'));
  await assertMatchesServer();
  // The toast is rendered by the Toasts host too.
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r2 = createRoot(host);
  await act(async () => r2.render(h(ToastsHost)));
  assert.match(host.textContent, /T9/);
  await act(async () => r2.unmount());
  host.remove();
});

test('a project:members event from elsewhere updates the rail live; a slower reply never overwrites a newer event', async () => {
  server.rows.set(id(7), 'active');
  await act(async () => publish());
  await settle();
  assert.ok(cardNames().includes('Quill'));
  // Release Kernel but hold the reply; meanwhile another client restores Iris, so the reply's list is older than the last event.
  let release;
  holdNext = new Promise((r) => { release = r; });
  await click(releaseBtn('Kernel'));
  await act(async () => { button('Release', dialog()).click(); });
  await settle();
  assert.ok(dialog(), 'still waiting for the reply');
  server.rows.set(id(5), 'active'); // Iris restored by someone else after our reply's list was taken
  await act(async () => publish());
  await settle();
  await act(async () => { release(); });
  await settle();
  assert.ok(dialog() === null, 'dialog closed');
  await assertMatchesServer();
  assert.ok(cardNames().includes('Iris') && !cardNames().includes('Kernel'));
});

test('a card (wrapped beside its Release button) still opens the work dialog; Esc returns focus to the card', async () => {
  const card = q(`#root [aria-label="Team hierarchy"] [data-agent="${id(2)}"]`);
  await focus(card);
  await click(card);
  assert.ok(dialog(), 'work dialog open');
  assert.match(dialog().textContent, /Kernel/);
  await key(document.activeElement, 'Escape');
  await settle();
  assert.ok(dialog() === null, 'dialog closed');
  assert.ok(document.activeElement === q(`#root [data-agent="${id(2)}"]`), 'focus back on the card');
  assert.deepEqual(mutations(), []);
});
