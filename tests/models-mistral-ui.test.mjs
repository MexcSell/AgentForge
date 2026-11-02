// Model Manager → Add model → Mistral (client/src/views/Models.jsx): the picker lists the chat models of the key
// (POST /api/mistral/models) by name, with no prices, searchable by any alias; picking one fills the Model id and Display
// name and saves no prices; a whole key typed in the API key field reloads the list with it; editing asks with the model's id.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;
const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin', status: 'active', permissions: {} };
const usage = { daily: { tokens: 0, prompts: 0, resetAt: new Date().toISOString() }, weekly: { tokens: 0, prompts: 0, cost: 0, cache: 0, resetAt: new Date().toISOString() }, total: { tokens: 0, prompts: 0 } };
const CLAUDE = { id: 'claude-code-opus', name: 'Claude Code · Opus 5.5', provider: 'claude-code', provider_label: 'Claude Code', model: 'claude-opus-5-5', enabled: true, is_default: true, can_edit: true, limits: {}, config: {}, usage };
const MISTRAL = { id: 'mistral-x', name: 'Mistral · codestral-latest', provider: 'mistral', provider_label: 'Mistral', model: 'codestral-latest', enabled: true, can_edit: false, has_api_key: true, limits: {}, config: {}, usage };
const CATALOG = [
  { id: 'mistral-large-4', name: 'mistral-large-4', created: 5, context: 1048576, vision: true, note: 'reasoning · vision', aliases: ['mistral-large-4-0'] },
  { id: 'codestral-latest', name: 'codestral-latest', created: 5, context: 256000, vision: false, note: 'code', aliases: ['codestral-2508', 'mistral-code-latest'] },
  { id: 'ministral-3b-latest', name: 'ministral-3b-latest', created: 5, context: 131072, vision: true, note: 'vision', aliases: ['ministral-3b-2512'] },
];
const KEY = `mstrl_${'a'.repeat(20)}_${'b'.repeat(16)}`;

const calls = [];
let keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'set', MISTRAL_API_KEY: 'set' };
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url, 'http://localhost:4800').pathname;
  calls.push({ method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null });
  let body = {};
  if (path === '/api/mistral/models') body = { models: CATALOG, fetchedAt: new Date().toISOString() };
  else if (path === '/api/models/credentials') body = keys;
  else if (path === '/api/models') body = init.method === 'POST' ? { id: 'new' } : [];
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
const button = (text) => buttons().find((b) => b.textContent.trim() === text);
const click = async (el) => { await act(async () => el.click()); await settle(); };
// React tracks input values: set through the native setter, then dispatch, so onChange fires.
const type = async (el, value) => {
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  await act(async () => el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })));
  await settle();
};
const rows = () => [...document.querySelectorAll('[role="listbox"][aria-label="Mistral models"] [role="option"]')].map((o) => o.querySelector('.mono').textContent);
const fieldInput = (label) => [...document.querySelectorAll('label')].find((l) => l.firstChild?.textContent === label)?.querySelector('input');
const listCalls = () => calls.filter((c) => c.path === '/api/mistral/models');

test('Add model → Mistral lists the key\'s chat models by name without prices, searches aliases, and picking fills the form', async () => {
  await render([CLAUDE]);
  await click(button('Add model'));
  assert.equal(listCalls().length, 0, 'list not fetched before Mistral is picked');
  await click(button('Mistral'));
  assert.deepEqual(listCalls().map((c) => [c.method, c.body]), [['POST', { refresh: false }]], 'no key typed, no model id: the server key');
  assert.equal(fieldInput('Model id').value, 'mistral-large-4', 'preset');
  assert.equal(fieldInput('Base URL').placeholder, 'https://api.mistral.ai/v1');
  assert.deepEqual(rows(), ['codestral-latest', 'ministral-3b-latest', 'mistral-large-4']);
  assert.equal(document.querySelector('[role="option"][aria-selected="true"]').querySelector('.mono').textContent, 'mistral-large-4', 'preset is selected');
  assert.match(document.body.textContent, /3 of 3 chat models for this key · Mistral lists no prices/);
  const sort = document.querySelector('select[aria-label="Sort Mistral models"]');
  assert.deepEqual([...sort.options].map((o) => o.value), ['name', 'context']);
  await type(sort, 'context');
  assert.deepEqual(rows(), ['mistral-large-4', 'codestral-latest', 'ministral-3b-latest']);
  const options = [...document.querySelectorAll('[role="option"]')];
  assert.ok(options.every((o) => !/varies|\$|free/.test(o.textContent)), 'no price column');
  assert.match(options[0].textContent, /mistral-large-4 · reasoning · vision.*1M ctx/);
  await type(document.querySelector('input[aria-label="Search Mistral models"]'), '2508');
  assert.deepEqual(rows(), ['codestral-latest'], 'an alias finds its model');

  await click(document.querySelector('[role="option"]'));
  assert.equal(fieldInput('Model id').value, 'codestral-latest');
  assert.equal(fieldInput('Display name').value, 'Mistral · codestral-latest');
  assert.equal(fieldInput('API key').placeholder, 'mstrl_…');
  assert.match(document.body.textContent, /server's MISTRAL_API_KEY is used \(set\)/);
  await click(buttons().filter((b) => b.textContent.trim() === 'Add model').at(-1));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/models');
  assert.deepEqual([post.body.provider, post.body.model, post.body.name, post.body.base_url], ['mistral', 'codestral-latest', 'Mistral · codestral-latest', null]);
  assert.equal(post.body.config.pricing, undefined, 'no prices saved');
});

test('a whole key typed in the API key field reloads the list with it; a partial key does not', async () => {
  await render([CLAUDE]);
  await click(button('Add model'));
  await click(button('Mistral'));
  await type(fieldInput('API key'), 'mstrl_abc');
  assert.equal(listCalls().length, 1, 'partial key: no reload');
  await type(fieldInput('API key'), KEY);
  assert.deepEqual(listCalls().at(-1).body, { api_key: KEY, refresh: true });
  await type(fieldInput('API key'), 'A'.repeat(32));
  assert.deepEqual(listCalls().at(-1).body, { api_key: 'A'.repeat(32), refresh: true }, 'a legacy 32-character key too');
  await click(buttons().find((b) => b.getAttribute('aria-label') === 'Reload the model list'));
  assert.deepEqual(listCalls().at(-1).body, { api_key: 'A'.repeat(32), refresh: true }, 'reload button uses the typed key too');
});

test('editing a Mistral model asks for the list with its id (its stored key); the panel shows the key status', async () => {
  keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'set', MISTRAL_API_KEY: 'missing' };
  try {
    await render([CLAUDE, MISTRAL]);
    assert.match(document.body.textContent, /Mistral · codestral-latest · text only/);
    assert.match(document.body.textContent, /MISTRAL_API_KEY in the server environment: missing/);
    await click(buttons().filter((b) => b.textContent.trim() === 'Edit').at(-1));
    assert.deepEqual(listCalls().map((c) => c.body), [{ model_id: 'mistral-x', refresh: false }]);
    assert.equal(document.querySelector('[role="option"][aria-selected="true"]').querySelector('.mono').textContent, 'codestral-latest');
  } finally {
    keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'set', MISTRAL_API_KEY: 'set' };
  }
});
