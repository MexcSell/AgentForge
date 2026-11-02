// Cohere (server/models/cohere.js): the model list comes from the native API (needs a key, chat endpoint only, every
// page, deprecated models left out) and is cached per key; runs go to the OpenAI-compatible API with the server's
// COHERE_API_KEY (or the model's own) as a bearer token and record no cost; the key never reaches agents or run output.
// Everything runs against a local fake API: no request reaches cohere.com, and any real key (.env) is replaced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = crypto.randomBytes(20).toString('hex');

// Two pages: a chat model, a vision model, a fine-tune, and a deprecated model the picker must leave out.
const PAGES = {
  '': { models: [
    { name: 'command-a-03-2025', endpoints: ['chat'], context_length: 256000, features: ['tools'], is_deprecated: false },
    { name: 'command-r-old', endpoints: ['chat'], context_length: 128000, is_deprecated: true },
  ], next_page_token: 'p2' },
  p2: { models: [
    { name: 'command-a-vision-07-2025', endpoints: ['chat'], context_length: 128000, features: ['vision'] },
    { name: 'my-tune', endpoints: ['chat'], context_length: 4096, finetuned: true },
  ] },
};

const hits = [];
let catalogStatus = 200;
let reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 9, completion_tokens: 1 } }];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch {}
    const url = new URL(req.url, 'http://x');
    hits.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body: json });
    // Cohere's errors carry `message` at the top level.
    const [status, data] = url.pathname === '/v1/models'
      ? (catalogStatus === 200 ? [200, PAGES[url.searchParams.get('page_token') || '']] : [catalogStatus, { id: 'e1', message: `invalid api token ${req.headers.authorization}` }])
      : reply(json);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
});
let base;

const { runModel, redactKeys, credentialStatus, PROVIDERS } = await import('../server/models/index.js');
const { cohereCatalog, resetCohereCache, COHERE_BASE } = await import('../server/models/cohere.js');
const { childEnv } = await import('../server/services/env.js');

const realKey = process.env.COHERE_API_KEY;
const withKey = (v, fn) => async () => {
  if (v === undefined) delete process.env.COHERE_API_KEY; else process.env.COHERE_API_KEY = v;
  try { return await fn(); } finally { process.env.COHERE_API_KEY = KEY; }
};
const cohereModel = (extra = {}) => ({ id: 'cohere-test', provider: 'cohere', model: 'command-a-03-2025', base_url: base, api_key: null, config: {}, ...extra });

before(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
  process.env.COHERE_CATALOG_URL = `${base}/v1/models`;
  process.env.COHERE_API_KEY = KEY;
});

after(() => {
  api.close();
  if (realKey === undefined) delete process.env.COHERE_API_KEY; else process.env.COHERE_API_KEY = realKey;
  delete process.env.COHERE_CATALOG_URL;
});

test('Cohere is a text-only provider on its OpenAI-compatible API', () => {
  assert.equal(PROVIDERS.cohere.label, 'Cohere');
  assert.equal(PROVIDERS.cohere.canEdit, false);
  assert.equal(COHERE_BASE, 'https://api.cohere.ai/compatibility/v1');
});

test('the model list reads every page of chat models, leaves deprecated ones out, and carries no prices', async () => {
  resetCohereCache();
  hits.length = 0;
  const { models } = await cohereCatalog();
  assert.deepEqual(models, [
    { id: 'command-a-03-2025', name: 'command-a-03-2025', created: 0, context: 256000, vision: false, note: undefined },
    { id: 'command-a-vision-07-2025', name: 'command-a-vision-07-2025', created: 0, context: 128000, vision: true, note: 'vision' },
    { id: 'my-tune', name: 'my-tune', created: 0, context: 4096, vision: false, note: 'fine-tuned' },
  ]);
  assert.ok(models.every((m) => !('prompt' in m)), 'unpriced rows, like Mistral\'s');
  assert.deepEqual(hits.map((h) => [h.method, h.path, h.query, h.auth]), [
    ['GET', '/v1/models', { endpoint: 'chat', page_size: '1000' }, `Bearer ${KEY}`],
    ['GET', '/v1/models', { endpoint: 'chat', page_size: '1000', page_token: 'p2' }, `Bearer ${KEY}`],
  ]);
});

test('the list is cached per key; a failure keeps the stale copy, and with no copy it errors with Cohere\'s message, key masked', async () => {
  resetCohereCache();
  hits.length = 0;
  const a = await cohereCatalog();
  const b = await cohereCatalog();
  assert.equal(b.fetchedAt, a.fetchedAt);
  await cohereCatalog({ key: 'other' });
  assert.deepEqual(hits.map((h) => h.auth), [`Bearer ${KEY}`, `Bearer ${KEY}`, 'Bearer other', 'Bearer other'], 'two pages per key, once');
  catalogStatus = 401;
  try {
    assert.equal((await cohereCatalog({ refresh: true })).models.length, 3, 'stale copy on failure');
    resetCohereCache();
    await assert.rejects(cohereCatalog(), (e) => /Could not load the Cohere model list: 401 invalid api token Bearer \[redacted\]/.test(e.message) && !e.message.includes(KEY));
  } finally { catalogStatus = 200; }
});

test('without any key the list fails clearly and sends nothing', withKey(undefined, async () => {
  resetCohereCache();
  hits.length = 0;
  await assert.rejects(cohereCatalog(), /No Cohere API key: set COHERE_API_KEY/);
  assert.equal(hits.length, 0);
}));

test('a run sends the server key as a bearer token to /chat/completions and records no cost', async () => {
  hits.length = 0;
  const out = await runModel(cohereModel(), { prompt: 'Reply OK', system: 'be brief' });
  assert.equal(out.text, 'OK');
  assert.deepEqual(out.usage, { input: 9, output: 1, cache: 0 });
  assert.equal(out.costUsd, 0);
  const [h] = hits;
  assert.deepEqual([h.method, h.path, h.auth, h.body.model], ['POST', '/chat/completions', `Bearer ${KEY}`, 'command-a-03-2025']);
  assert.deepEqual(h.body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'Reply OK' }]);
});

test('a key stored on the model wins over the server key; Cohere\'s top-level error message is shown', async () => {
  hits.length = 0;
  await runModel(cohereModel({ api_key: 'stored-key' }), { prompt: 'x' });
  assert.equal(hits[0].auth, 'Bearer stored-key');
  reply = () => [429, { id: 'e2', message: 'You are using a Trial key, which is limited to 20 API calls / minute.' }];
  try {
    await assert.rejects(runModel(cohereModel(), { prompt: 'x' }), /429 You are using a Trial key/);
  } finally {
    reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: {} }];
  }
});

test('without COHERE_API_KEY a run fails clearly and sends nothing', withKey(undefined, async () => {
  hits.length = 0;
  await assert.rejects(runModel(cohereModel(), { prompt: 'x' }), /COHERE_API_KEY is not set in the AgentForge service environment/);
  assert.equal(hits.length, 0);
  assert.equal(credentialStatus().COHERE_API_KEY, 'missing');
  process.env.COHERE_API_KEY = KEY;
  assert.equal(credentialStatus().COHERE_API_KEY, 'set');
  assert.equal(JSON.stringify(credentialStatus()).includes(KEY), false);
}));

test('the key is masked in run output and errors, and agents never inherit it', async () => {
  reply = () => [200, { choices: [{ message: { content: `env: COHERE_API_KEY=${KEY} again ${KEY}` } }], usage: {} }];
  try {
    const out = await runModel(cohereModel(), { prompt: 'x' });
    assert.equal(out.text, 'env: COHERE_API_KEY=[redacted] again [redacted]');
    reply = () => [401, { message: `bad key ${KEY}` }];
    await assert.rejects(runModel(cohereModel(), { prompt: 'x' }), (e) => !e.message.includes(KEY) && /401 bad key \[redacted\]/.test(e.message));
  } finally {
    reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: {} }];
  }
  assert.equal(redactKeys({ a: [`x ${KEY} y`] }).a[0], 'x [redacted] y');
  assert.equal(childEnv().COHERE_API_KEY, undefined);
  assert.ok(childEnv().PATH, 'other variables pass through');
});
