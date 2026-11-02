// Model Manager → Claude models (client/src/views/Models.jsx): the Claude Code / Anthropic API dialog lists the Claude
// models to pick from (older ones behind a toggle); a Claude Code model takes an API key and a Claude Code session id,
// entered the same way: type to replace, blank keeps the stored value, × removes it. A session id must be a UUID.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;
const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin', status: 'active', permissions: {} };
const usage = { daily: { tokens: 0, prompts: 0, resetAt: new Date().toISOString() }, weekly: { tokens: 0, prompts: 0, cost: 0, cache: 0, resetAt: new Date().toISOString() }, total: { tokens: 0, prompts: 0 } };
const SESSION = '0f8b4c2e-1d3a-4b5c-9e6f-7a8b9c0d1e2f';
const STORED = { id: 'claude-code-opus', name: 'Claude Code · Opus 5.5', provider: 'claude-code', provider_label: 'Claude Code', model: 'claude-opus-5-5', enabled: true, is_default: true, can_edit: true, has_api_key: true, limits: {}, config: { effort: '', sessionId: SESSION }, usage };
const API = { id: 'anthropic-opus', name: 'Anthropic API · Opus 5.5', provider: 'anthropic', provider_label: 'Anthropic API', model: 'claude-opus-5-5', enabled: true, can_edit: false, has_api_key: false, limits: {}, config: {}, usage };

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url, 'http://localhost:4800').pathname;
  calls.push({ method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null });
  const body = path === '/api/models/credentials' ? { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set' } : path === '/api/models' && init.method === 'POST' ? { id: 'new' } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

let loader, useStore, Models, INIT, root;

before(async () => {
  loader = await createLoader();
  ({ useStore } = await loader.load('/src/lib/store.js'));
  ({ default: Models } = await loader.load('/src/views/Models.jsx'));
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
const render = async (models) => {
  await act(async () => useStore.setState({ ...INIT, me: ADMIN, models }, true));
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(Models, { layout: {} })));
  await settle();
};
const buttons = () => [...document.querySelectorAll('button')];
const click = async (el) => { await act(async () => el.click()); await settle(); };
const type = async (el, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  await act(async () => el.dispatchEvent(new window.Event('input', { bubbles: true })));
  await settle();
};
const field = (label) => [...document.querySelectorAll('label')].find((l) => l.firstChild?.textContent === label);
const input = (label) => field(label)?.querySelector('input');
const hint = (label) => field(label)?.lastChild?.textContent;
const claudeRows = () => [...document.querySelectorAll('[role="listbox"][aria-label="Claude models"] [role="option"]')].map((o) => o.querySelector('.mono').textContent);
const saveButton = (text) => buttons().filter((b) => b.textContent.trim() === text).at(-1);
const posted = () => calls.find((c) => c.method === 'POST' && c.path === '/api/models')?.body;
const patched = () => calls.find((c) => c.method === 'PATCH')?.body;

test('Add model → Claude Code: pick a Claude model from the list; API key and session id fields work the same way', async () => {
  await render([]);
  await click(buttons().find((b) => b.textContent.trim() === 'Add model'));
  assert.deepEqual(claudeRows(), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.match(document.querySelector('[aria-label="Claude models"]').textContent, /Haiku 5\.5 · Fastest and cheapest.*\$0\.1 in · \$0\.5 out/);
  await click(buttons().find((b) => b.getAttribute('role') === 'switch' && b.textContent.includes('Older models')));
  assert.equal(claudeRows().length, 12);
  assert.ok(claudeRows().includes('claude-haiku-4-5'));

  await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('claude-haiku-5-5')));
  assert.equal(input('Model id').value, 'claude-haiku-5-5');
  assert.equal(input('Display name').value, 'Claude Code · Haiku 5.5');
  await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('claude-sonnet-5-5')));
  assert.equal(input('Display name').value, 'Claude Code · Sonnet 5.5', 'an auto-filled name follows the pick');

  // Same kind of field for both: an input with an icon, nothing stored yet, a hint about the fallback.
  assert.equal(input('API key').type, 'password');
  assert.equal(input('Session ID').type, 'text');
  assert.match(hint('API key'), /instead of the server's ANTHROPIC_API_KEY \(missing\) or the claude CLI login/);
  assert.match(hint('Session ID'), /start from this Claude Code conversation/);

  await type(input('Session ID'), 'not-a-uuid');
  assert.match(hint('Session ID'), /is a UUID/);
  assert.equal(saveButton('Add model').disabled, true, 'an invalid session id blocks saving');
  await type(input('Session ID'), ` ${SESSION} `);
  await type(input('API key'), 'sk-ant-mine');
  assert.equal(saveButton('Add model').disabled, false);
  await click(saveButton('Add model'));
  const body = posted();
  assert.deepEqual([body.provider, body.model, body.name, body.api_key, body.config.sessionId], ['claude-code', 'claude-sonnet-5-5', 'Claude Code · Sonnet 5.5', 'sk-ant-mine', SESSION]);
});

test('editing a stored key and session: blank keeps both, × removes each, a new value replaces', async () => {
  await render([STORED]);
  assert.match(document.body.textContent, /can edit files · own API key · session 0f8b4c2e/);
  const edit = async () => { calls.length = 0; await click(buttons().filter((b) => b.textContent.trim() === 'Edit')[0]); };

  await edit();
  assert.equal(input('Session ID').value, '', 'a stored value is not put in the field');
  assert.match(hint('API key'), /A key is stored \(never shown\)\. Type a new one to replace it, or leave blank to keep it\./);
  assert.match(hint('Session ID'), new RegExp(`Saved: ${SESSION}\\. Type a new one to replace it, or leave blank to keep it\\.`));
  assert.equal(claudeRows().includes('claude-opus-5-5'), true);
  assert.equal(document.querySelector('[role="option"][aria-selected="true"]').textContent.includes('claude-opus-5-5'), true);
  await click(saveButton('Save'));
  assert.equal(patched().config.sessionId, SESSION, 'blank keeps the saved session');
  assert.equal('api_key' in patched() || 'clear_api_key' in patched(), false, 'blank keeps the stored key');

  await edit();
  await click(buttons().find((b) => b.getAttribute('aria-label') === 'Remove the stored API key'));
  await click(buttons().find((b) => b.getAttribute('aria-label') === 'Remove the stored Session ID'));
  assert.equal(hint('API key'), 'Removed when you save.');
  assert.equal(hint('Session ID'), 'Removed when you save.');
  await click(saveButton('Save'));
  assert.deepEqual([patched().clear_api_key, patched().config.sessionId], [true, '']);

  await edit();
  const next = '11111111-2222-4333-8444-555555555555';
  await type(input('Session ID'), next);
  await type(input('API key'), 'sk-ant-new');
  await click(saveButton('Save'));
  assert.deepEqual([patched().api_key, patched().config.sessionId, 'clear_api_key' in patched()], ['sk-ant-new', next, false]);
});

test('the Anthropic API dialog has the Claude picker and the API key field, but no session id', async () => {
  await render([API]);
  await click(buttons().filter((b) => b.textContent.trim() === 'Edit')[0]);
  assert.deepEqual(claudeRows(), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.ok(input('API key'));
  assert.equal(input('Session ID'), undefined);
  await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('claude-fable-5-1')));
  assert.equal(input('Display name').value, 'Anthropic API · Fable 5.1');
  await click(saveButton('Save'));
  assert.equal(patched().config.sessionId, undefined, 'no session id for the Anthropic API');
});
