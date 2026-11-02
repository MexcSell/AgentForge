// Model Manager → Add model → SambaNova (client/src/views/Models.jsx): the picker lists SambaNova's chat models
// (POST /api/sambanova/models), cheapest first, searchable; picking one fills the Model id and Display name and saves its
// prices; a whole key (a UUID) typed in the API key field reloads the list with it; editing asks with the model's id.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;
const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin', status: 'active', permissions: {} };
const usage = { daily: { tokens: 0, prompts: 0, resetAt: new Date().toISOString() }, weekly: { tokens: 0, prompts: 0, cost: 0, cache: 0, resetAt: new Date().toISOString() }, total: { tokens: 0, prompts: 0 } };
const CLAUDE = { id: 'claude-code-opus', name: 'Claude Code · Opus 5.5', provider: 'claude-code', provider_label: 'Claude Code', model: 'claude-opus-5-5', enabled: true, is_default: true, can_edit: true, limits: {}, config: {}, usage };
const SAMBA = { id: 'samba-x', name: 'SambaNova · gpt-oss-120b', provider: 'sambanova', provider_label: 'SambaNova', model: 'gpt-oss-120b', enabled: true, can_edit: false, has_api_key: true, limits: {}, config: { pricing: { prompt: 0.22, completion: 0.59, free: false, variable: false } }, usage };
const CATALOG = [
  { id: 'DeepSeek-V3.1', name: 'DeepSeek-V3.1', created: 0, context: 131072, prompt: 3, completion: 4.5, variable: false, free: false, vision: false },
  { id: 'gpt-oss-120b', name: 'gpt-oss-120b', created: 0, context: 131072, prompt: 0.22, completion: 0.59, variable: false, free: false, vision: false },
  { id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', created: 0, context: 1048576, prompt: 0.3, completion: 1.2, variable: false, free: false, vision: false },
];
const KEY = '0a171761-0000-4283-a2c1-e13e443eef9c';

const calls = [];
let keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'set', SAMBANOVA_API_KEY: 'set' };
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url, 'http://localhost:4800').pathname;
  calls.push({ method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null });
  let body = {};
  if (path === '/api/sambanova/models') body = { models: CATALOG, fetchedAt: new Date().toISOString() };
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
const rows = () => [...document.querySelectorAll('[role="listbox"][aria-label="SambaNova models"] [role="option"]')].map((o) => o.querySelector('.mono').textContent);
const fieldInput = (label) => [...document.querySelectorAll('label')].find((l) => l.firstChild?.textContent === label)?.querySelector('input');
const listCalls = () => calls.filter((c) => c.path === '/api/sambanova/models');

test('Add model → SambaNova lists the chat models cheapest first, searches, and picking fills the form and saves prices', async () => {
  await render([CLAUDE]);
  await click(button('Add model'));
  assert.equal(listCalls().length, 0, 'list not fetched before SambaNova is picked');
  await click(button('SambaNova'));
  assert.deepEqual(listCalls().map((c) => [c.method, c.body]), [['POST', { refresh: false }]], 'no key typed, no model id: the server key');
  assert.equal(fieldInput('Model id').value, 'gpt-oss-120b', 'preset');
  assert.equal(fieldInput('Base URL').placeholder, 'https://api.sambanova.ai/v1');
  assert.deepEqual(rows(), ['gpt-oss-120b', 'MiniMax-M3.1-Flash', 'DeepSeek-V3.1']);
  assert.match(document.body.textContent, /3 of 3 chat models for this key · prices per 1M tokens/);
  const sort = document.querySelector('select[aria-label="Sort SambaNova models"]');
  assert.ok(![...sort.options].some((o) => o.value === 'free'), 'no free-first sort');
  await type(sort, 'context');
  assert.deepEqual(rows(), ['MiniMax-M3.1-Flash', 'DeepSeek-V3.1', 'gpt-oss-120b']);
  await type(document.querySelector('input[aria-label="Search SambaNova models"]'), 'deepseek');
  assert.deepEqual(rows(), ['DeepSeek-V3.1']);
  assert.match(document.querySelector('[role="option"]').textContent, /DeepSeek-V3\.1.*\$3 in · \$4\.5 out/);

  await click(document.querySelector('[role="option"]'));
  assert.equal(fieldInput('Display name').value, 'SambaNova · DeepSeek-V3.1');
  assert.match(document.body.textContent, /server's SAMBANOVA_API_KEY is used \(set\)/);
  await click(buttons().filter((b) => b.textContent.trim() === 'Add model').at(-1));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/models');
  assert.deepEqual([post.body.provider, post.body.model, post.body.name, post.body.base_url], ['sambanova', 'DeepSeek-V3.1', 'SambaNova · DeepSeek-V3.1', null]);
  assert.deepEqual(post.body.config.pricing, { prompt: 3, completion: 4.5, free: false, variable: false });
});

test('a whole key typed in the API key field reloads the list with it; a partial key does not; a typed id drops prices', async () => {
  await render([CLAUDE]);
  await click(button('Add model'));
  await click(button('SambaNova'));
  await type(fieldInput('API key'), KEY.slice(0, 30));
  assert.equal(listCalls().length, 1, 'partial key: no reload');
  await type(fieldInput('API key'), KEY);
  assert.deepEqual(listCalls().at(-1).body, { api_key: KEY, refresh: true });
  await click(document.querySelector('[role="option"]'));
  await type(fieldInput('Model id'), 'Some-Unlisted');
  await type(fieldInput('Display name'), 'Mine');
  await click(buttons().filter((b) => b.textContent.trim() === 'Add model').at(-1));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/models');
  assert.deepEqual([post.body.model, post.body.config.pricing, post.body.api_key], ['Some-Unlisted', null, KEY]);
});

test('editing a SambaNova model asks for the list with its id (its stored key); the card shows prices and key status', async () => {
  keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'set', SAMBANOVA_API_KEY: 'missing' };
  try {
    await render([CLAUDE, { ...SAMBA, has_api_key: false }]);
    assert.match(document.body.textContent, /SambaNova · gpt-oss-120b · text only · in \$0\.22 · out \$0\.59 \/1M/);
    assert.match(document.body.textContent, /SAMBANOVA_API_KEY missing/, 'warn badge on the SambaNova card');
    assert.match(document.body.textContent, /SAMBANOVA_API_KEY in the server environment: missing/);
    await click(buttons().filter((b) => b.textContent.trim() === 'Edit').at(-1));
    assert.deepEqual(listCalls().map((c) => c.body), [{ model_id: 'samba-x', refresh: false }]);
    assert.equal(document.querySelector('[role="option"][aria-selected="true"]').querySelector('.mono').textContent, 'gpt-oss-120b');
  } finally {
    keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'set', SAMBANOVA_API_KEY: 'set' };
  }
});
