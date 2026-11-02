// Model Manager → Add model → Groq (client/src/views/Models.jsx): the picker lists the chat models of the key
// (POST /api/groq/models), cheapest first, searchable; picking one fills the Model id and Display name and saves its
// prices; a whole key typed in the API key field reloads the list with that key; editing asks with the model's id.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;
const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin', status: 'active', permissions: {} };
const usage = { daily: { tokens: 0, prompts: 0, resetAt: new Date().toISOString() }, weekly: { tokens: 0, prompts: 0, cost: 0, cache: 0, resetAt: new Date().toISOString() }, total: { tokens: 0, prompts: 0 } };
const CLAUDE = { id: 'claude-code-opus', name: 'Claude Code · Opus 5.5', provider: 'claude-code', provider_label: 'Claude Code', model: 'claude-opus-5-5', enabled: true, is_default: true, can_edit: true, limits: {}, config: {}, usage };
const GROQ = { id: 'groq-x', name: 'Groq · GPT OSS 120B', provider: 'groq', provider_label: 'Groq', model: 'openai/gpt-oss-120b', enabled: true, can_edit: false, has_api_key: true, limits: {}, config: { pricing: { prompt: 0.15, completion: 0.6, free: false, variable: false } }, usage };
const CATALOG = [
  { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', note: 'Alibaba Cloud', created: 400, context: 131072, prompt: 0.3, completion: 1.2, variable: false, free: false },
  { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', note: 'OpenAI', created: 300, context: 131072, prompt: 0.15, completion: 0.6, variable: false, free: false },
  { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', note: 'OpenAI', created: 200, context: 131072, prompt: 0.075, completion: 0.3, variable: false, free: false },
];
const KEY = `gsk_${'a'.repeat(52)}`;

const calls = [];
let keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'set' };
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url, 'http://localhost:4800').pathname;
  calls.push({ method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null });
  let body = {};
  if (path === '/api/groq/models') body = { models: CATALOG, fetchedAt: new Date().toISOString() };
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
const rows = () => [...document.querySelectorAll('[role="listbox"][aria-label="Groq models"] [role="option"]')].map((o) => o.querySelector('.mono').textContent);
const fieldInput = (label) => [...document.querySelectorAll('label')].find((l) => l.firstChild?.textContent === label)?.querySelector('input');
const listCalls = () => calls.filter((c) => c.path === '/api/groq/models');

test('Add model → Groq lists the key\'s chat models cheapest first, searches, and picking fills the form and saves prices', async () => {
  await render([CLAUDE]);
  await click(button('Add model'));
  assert.equal(listCalls().length, 0, 'list not fetched before Groq is picked');
  await click(button('Groq'));
  assert.deepEqual(listCalls().map((c) => [c.method, c.body]), [['POST', { refresh: false }]], 'no key typed, no model id: the server key');
  assert.equal(fieldInput('Model id').value, 'openai/gpt-oss-120b', 'preset');
  assert.deepEqual(rows(), ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
  assert.match(document.body.textContent, /3 of 3 chat models for this key/);
  const sort = document.querySelector('select[aria-label="Sort Groq models"]');
  assert.ok(![...sort.options].some((o) => o.value === 'free'), 'no free-first sort');
  await type(sort, 'pricey');
  assert.deepEqual(rows(), ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  await type(document.querySelector('input[aria-label="Search Groq models"]'), '120b');
  assert.deepEqual(rows(), ['openai/gpt-oss-120b']);
  assert.match(document.querySelector('[role="option"]').textContent, /GPT OSS 120B · OpenAI.*\$0\.15 in · \$0\.6 out/);

  await click(document.querySelector('[role="option"]'));
  assert.equal(fieldInput('Display name').value, 'Groq · GPT OSS 120B');
  assert.equal(fieldInput('API key').placeholder, 'gsk_…');
  assert.match(document.body.textContent, /server's GROQ_API_KEY is used \(set\)/);
  await click(buttons().filter((b) => b.textContent.trim() === 'Add model').at(-1));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/models');
  assert.deepEqual([post.body.provider, post.body.model, post.body.name, post.body.base_url], ['groq', 'openai/gpt-oss-120b', 'Groq · GPT OSS 120B', null]);
  assert.deepEqual(post.body.config.pricing, { prompt: 0.15, completion: 0.6, free: false, variable: false });
});

test('a whole key typed in the API key field reloads the list with it; a partial key does not', async () => {
  await render([CLAUDE]);
  await click(button('Add model'));
  await click(button('Groq'));
  await type(fieldInput('API key'), 'gsk_abc');
  assert.equal(listCalls().length, 1, 'partial key: no reload');
  await type(fieldInput('API key'), KEY);
  assert.deepEqual(listCalls().at(-1).body, { api_key: KEY, refresh: true });
  await click(buttons().find((b) => b.getAttribute('aria-label') === 'Reload the model list'));
  assert.deepEqual(listCalls().at(-1).body, { api_key: KEY, refresh: true }, 'reload button uses the typed key too');
  await click(document.querySelector('[role="option"]'));
  await type(fieldInput('Model id'), 'someone/unlisted');
  await type(fieldInput('Display name'), 'Mine');
  await click(buttons().filter((b) => b.textContent.trim() === 'Add model').at(-1));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/models');
  assert.deepEqual([post.body.model, post.body.config.pricing, post.body.api_key], ['someone/unlisted', null, KEY], 'typed id drops prices');
});

test('editing a Groq model asks for the list with its id (its stored key); the card shows prices and key status', async () => {
  keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'missing' };
  try {
    await render([CLAUDE, { ...GROQ, has_api_key: false }]);
    assert.match(document.body.textContent, /Groq · openai\/gpt-oss-120b · text only · in \$0\.15 · out \$0\.6 \/1M/);
    assert.match(document.body.textContent, /GROQ_API_KEY missing/, 'warn badge on the Groq card');
    assert.match(document.body.textContent, /GROQ_API_KEY in the server environment: missing/);
    await click(buttons().filter((b) => b.textContent.trim() === 'Edit').at(-1));
    assert.deepEqual(listCalls().map((c) => c.body), [{ model_id: 'groq-x', refresh: false }]);
    assert.equal(document.querySelector('[role="option"][aria-selected="true"]').querySelector('.mono').textContent, 'openai/gpt-oss-120b');
  } finally {
    keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set', GROQ_API_KEY: 'set' };
  }
});
