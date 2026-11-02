// Model Manager → Add model → OpenRouter (client/src/views/Models.jsx): the picker lists every model of the catalog
// (GET /api/openrouter/models), sorts free-first / by cost, filters to free models and by search; picking one fills the
// Model id and Display name and saves its prices with the model. Other providers keep the plain Model id field.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, React, createRoot } from './setup/jsdom-vite.mjs';

const { act } = React;
const h = React.createElement;
const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin', status: 'active', permissions: {} };
const usage = { daily: { tokens: 0, prompts: 0, resetAt: new Date().toISOString() }, weekly: { tokens: 0, prompts: 0, cost: 0, cache: 0, resetAt: new Date().toISOString() }, total: { tokens: 0, prompts: 0 } };
const CLAUDE = { id: 'claude-code-opus', name: 'Claude Code · Opus 5.5', provider: 'claude-code', provider_label: 'Claude Code', model: 'claude-opus-5-5', enabled: true, is_default: true, can_edit: true, limits: {}, config: {}, usage };
const ROUTED = { id: 'openrouter-x', name: 'OpenRouter · Zeta: Mini', provider: 'openrouter', provider_label: 'OpenRouter', model: 'zeta/mini', enabled: true, can_edit: false, has_api_key: false, limits: {}, config: { pricing: { prompt: 0.15, completion: 0.6, free: false, variable: false } }, usage };
const CATALOG = [
  { id: 'acme/big', name: 'Acme: Big', created: 300, context: 200000, prompt: 15, completion: 75, variable: false, free: false },
  { id: 'acme/small:free', name: 'Acme: Small (free)', created: 100, context: 32768, prompt: 0, completion: 0, variable: false, free: true },
  { id: 'openrouter/auto', name: 'Auto Router', created: 50, context: 2000000, prompt: null, completion: null, variable: true, free: false },
  { id: 'zeta/mini', name: 'Zeta: Mini', created: 400, context: 1048576, prompt: 0.15, completion: 0.6, variable: false, free: false },
];

const calls = [];
let keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set' };
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url, 'http://localhost:4800').pathname;
  calls.push({ method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null });
  let body = {};
  if (path === '/api/openrouter/models') body = { models: CATALOG, fetchedAt: new Date().toISOString() };
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
const rows = () => [...document.querySelectorAll('[role="listbox"][aria-label="OpenRouter models"] [role="option"]')].map((o) => o.querySelector('.mono').textContent);
const fieldInput = (label) => [...document.querySelectorAll('label')].find((l) => l.firstChild?.textContent === label)?.querySelector('input');

test('Add model → OpenRouter lists the whole catalog, sorts by free and cost, filters, and picking fills the form', async () => {
  await render([CLAUDE]);
  await click(button('Add model'));
  assert.ok(!document.querySelector('[role="listbox"][aria-label="OpenRouter models"]'), 'no OpenRouter picker for the default Claude Code provider');
  assert.equal(calls.filter((c) => c.path === '/api/openrouter/models').length, 0, 'catalog not fetched before OpenRouter is picked');

  await click(button('OpenRouter'));
  assert.equal(calls.filter((c) => c.path === '/api/openrouter/models').length, 1);
  assert.equal(fieldInput('Model id').value, 'openrouter/free', 'preset is the free router');
  assert.deepEqual(rows(), ['acme/small:free', 'zeta/mini', 'acme/big', 'openrouter/auto'], 'free first, then cheapest, variable last');
  assert.match(document.body.textContent, /4 of 4 models · 1 free · prices per 1M tokens/);

  const sort = document.querySelector('select[aria-label="Sort OpenRouter models"]');
  await type(sort, 'pricey');
  assert.deepEqual(rows(), ['acme/big', 'zeta/mini', 'acme/small:free', 'openrouter/auto']);
  await type(sort, 'cheap');
  assert.deepEqual(rows(), ['acme/small:free', 'zeta/mini', 'acme/big', 'openrouter/auto']);

  await click(buttons().find((b) => b.getAttribute('role') === 'switch' && b.textContent.includes('Free only')));
  assert.deepEqual(rows(), ['acme/small:free']);
  await click(buttons().find((b) => b.getAttribute('role') === 'switch' && b.textContent.includes('Free only')));

  await type(document.querySelector('input[aria-label="Search OpenRouter models"]'), 'zeta');
  assert.deepEqual(rows(), ['zeta/mini']);
  assert.match(document.querySelector('[role="option"]').textContent, /\$0\.15 in · \$0\.6 out/);

  await click(document.querySelector('[role="option"]'));
  assert.equal(fieldInput('Model id').value, 'zeta/mini');
  assert.equal(fieldInput('Display name').value, 'OpenRouter · Zeta: Mini');
  assert.equal(document.querySelector('[role="option"]').getAttribute('aria-selected'), 'true');
  assert.match(document.body.textContent, /server's OPENROUTER_API_KEY is used \(set\)/);

  await click(buttons().filter((b) => b.textContent.trim() === 'Add model').at(-1));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/models');
  assert.ok(post, 'saved');
  assert.deepEqual([post.body.provider, post.body.model, post.body.name, post.body.base_url], ['openrouter', 'zeta/mini', 'OpenRouter · Zeta: Mini', null]);
  assert.deepEqual(post.body.config.pricing, { prompt: 0.15, completion: 0.6, free: false, variable: false });
});

test('typing a model id by hand drops the prices of a picked model', async () => {
  await render([CLAUDE]);
  await click(button('Add model'));
  await click(button('OpenRouter'));
  await click(document.querySelector('[role="option"]'));
  await type(fieldInput('Model id'), 'someone/unlisted');
  await type(fieldInput('Display name'), 'Mine');
  await click(buttons().filter((b) => b.textContent.trim() === 'Add model').at(-1));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/models');
  assert.deepEqual([post.body.model, post.body.config.pricing], ['someone/unlisted', null]);
});

test('cards show OpenRouter prices and key status; editing a Claude model keeps the plain Model id field', async () => {
  keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'missing' };
  try {
    await render([CLAUDE, ROUTED]);
    assert.match(document.body.textContent, /OpenRouter · zeta\/mini · text only · in \$0\.15 · out \$0\.6 \/1M/);
    assert.match(document.body.textContent, /OPENROUTER_API_KEY missing/, 'warn badge on the OpenRouter card');
    assert.match(document.body.textContent, /OPENROUTER_API_KEY in the server environment: missing/);
    await click(buttons().filter((b) => b.textContent.trim() === 'Edit')[0]);
    assert.equal(fieldInput('Model id').value, 'claude-opus-5-5');
    assert.ok(!document.querySelector('[role="listbox"][aria-label="OpenRouter models"]'), 'no OpenRouter picker for Claude Code');
    assert.ok(document.querySelector('[role="listbox"][aria-label="Claude models"]'), 'the Claude picker instead');
    assert.equal(calls.filter((c) => c.path === '/api/openrouter/models').length, 0);
  } finally {
    keys = { ANTHROPIC_API_KEY: 'missing', OPENROUTER_API_KEY: 'set' };
  }
});
