// SambaNova Cloud (server/models/sambanova.js): the public model list is slimmed to prices per 1M tokens (Whisper and
// embedding models left out) and cached per key, sending the key when there is one; runs send the server's
// SAMBANOVA_API_KEY (or the model's own) as a bearer token and are costed from the saved prices; the key never reaches
// agents or run output. Everything runs against a local fake API: no request reaches sambanova.ai, and the real key (.env) is replaced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = crypto.randomUUID();

// What SambaNova's /v1/models returns: chat models with per-token price strings, plus speech and embedding models.
const CATALOG = [
  { id: 'DeepSeek-V3.1', object: 'model', owned_by: 'no-reply@sambanova.ai', context_length: 131072, max_completion_tokens: 7168, pricing: { completion: '0.00000450', prompt: '0.00000300' }, sn_metadata: {} },
  { id: 'MiniMax-M3.1-Flash', object: 'model', context_length: 1048576, pricing: { completion: '0.00000120', input_cache_read: '0.00000003', input_cache_write: '0.00000000', prompt: '0.00000030' } },
  { id: 'Whisper-Large-v3', object: 'model', context_length: 4096, pricing: { completion: '0', prompt: '0.0000001' } },
  { id: 'E5-Mistral-7B-Instruct', object: 'model', context_length: 4096, pricing: { completion: '0', prompt: '0.0000001' } },
];

const hits = [];
let catalogStatus = 200;
let reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1000, completion_tokens: 2000 } }];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch {}
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
    const [status, data] = req.url === '/models'
      ? (catalogStatus === 200 ? [200, { object: 'list', data: CATALOG }] : [catalogStatus, { error: { message: `Incorrect API key provided: ${req.headers.authorization}` } }])
      : reply(json);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
});
let base;

const { runModel, redactKeys, credentialStatus, PROVIDERS } = await import('../server/models/index.js');
const { sambanovaCatalog, resetSambanovaCache, SAMBANOVA_BASE } = await import('../server/models/sambanova.js');
const { childEnv } = await import('../server/services/env.js');

const realKey = process.env.SAMBANOVA_API_KEY;
const withKey = (v, fn) => async () => {
  if (v === undefined) delete process.env.SAMBANOVA_API_KEY; else process.env.SAMBANOVA_API_KEY = v;
  try { return await fn(); } finally { process.env.SAMBANOVA_API_KEY = KEY; }
};
const PRICING = { prompt: 3, completion: 4.5, free: false, variable: false };
const snModel = (extra = {}) => ({ id: 'sn-test', provider: 'sambanova', model: 'DeepSeek-V3.1', base_url: base, api_key: null, config: { pricing: PRICING }, ...extra });

before(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
  process.env.SAMBANOVA_CATALOG_URL = `${base}/models`;
  process.env.SAMBANOVA_API_KEY = KEY;
});

after(() => {
  api.close();
  if (realKey === undefined) delete process.env.SAMBANOVA_API_KEY; else process.env.SAMBANOVA_API_KEY = realKey;
  delete process.env.SAMBANOVA_CATALOG_URL;
});

test('SambaNova is a text-only provider on its OpenAI-compatible API', () => {
  assert.equal(PROVIDERS.sambanova.label, 'SambaNova');
  assert.equal(PROVIDERS.sambanova.canEdit, false);
  assert.equal(SAMBANOVA_BASE, 'https://api.sambanova.ai/v1');
});

test('the model list keeps chat models only, with prices per 1M tokens and context', async () => {
  resetSambanovaCache();
  const { models } = await sambanovaCatalog();
  assert.deepEqual(models, [
    { id: 'DeepSeek-V3.1', name: 'DeepSeek-V3.1', created: 0, context: 131072, prompt: 3, completion: 4.5, variable: false, free: false, vision: false },
    { id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', created: 0, context: 1048576, prompt: 0.3, completion: 1.2, variable: false, free: false, vision: false },
  ]);
});

test('the list is cached per key and loads without one; a failure keeps the stale copy, and with no copy it errors without the key', withKey(undefined, async () => {
  resetSambanovaCache();
  hits.length = 0;
  const a = await sambanovaCatalog();
  const b = await sambanovaCatalog();
  assert.equal(b.fetchedAt, a.fetchedAt);
  await sambanovaCatalog({ key: KEY });
  assert.deepEqual(hits.map((h) => [h.method, h.url, h.auth]), [['GET', '/models', undefined], ['GET', '/models', `Bearer ${KEY}`]], 'public without a key; cached per key');
  catalogStatus = 401;
  try {
    assert.equal((await sambanovaCatalog({ key: KEY, refresh: true })).models.length, 2, 'stale copy on failure');
    resetSambanovaCache();
    await assert.rejects(sambanovaCatalog({ key: KEY }), (e) => /Could not load the SambaNova model list: 401 Incorrect API key provided: Bearer \[redacted\]/.test(e.message) && !e.message.includes(KEY));
  } finally { catalogStatus = 200; }
}));

test('a run sends the server key as a bearer token and is costed from the saved prices', async () => {
  hits.length = 0;
  const out = await runModel(snModel(), { prompt: 'Reply OK', system: 'be brief' });
  assert.equal(out.text, 'OK');
  assert.deepEqual(out.usage, { input: 1000, output: 2000, cache: 0 });
  assert.equal(out.costUsd, (1000 * 3 + 2000 * 4.5) / 1e6);
  const [h] = hits;
  assert.deepEqual([h.method, h.url, h.auth, h.body.model], ['POST', '/chat/completions', `Bearer ${KEY}`, 'DeepSeek-V3.1']);
  assert.deepEqual(h.body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'Reply OK' }]);
  assert.equal((await runModel(snModel({ config: {} }), { prompt: 'x' })).costUsd, 0, 'no saved prices (typed model id): no cost');
});

test('a key stored on the model wins; a busy model\'s message is shown', async () => {
  hits.length = 0;
  await runModel(snModel({ api_key: 'stored-uuid' }), { prompt: 'x' });
  assert.equal(hits[0].auth, 'Bearer stored-uuid');
  reply = () => [503, { error: { code: null, message: 'DeepSeek-V3.1-16k is currently experiencing high demand. Please try again later!' } }];
  try {
    await assert.rejects(runModel(snModel(), { prompt: 'x' }), /503 DeepSeek-V3\.1-16k is currently experiencing high demand/);
  } finally {
    reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: {} }];
  }
});

test('without SAMBANOVA_API_KEY a run fails clearly and sends nothing', withKey(undefined, async () => {
  hits.length = 0;
  await assert.rejects(runModel(snModel(), { prompt: 'x' }), /SAMBANOVA_API_KEY is not set in the AgentForge service environment/);
  assert.equal(hits.length, 0);
  assert.equal(credentialStatus().SAMBANOVA_API_KEY, 'missing');
  process.env.SAMBANOVA_API_KEY = KEY;
  assert.equal(credentialStatus().SAMBANOVA_API_KEY, 'set');
  assert.equal(JSON.stringify(credentialStatus()).includes(KEY), false);
}));

test('the key is masked in run output and errors, and agents never inherit it', async () => {
  reply = () => [200, { choices: [{ message: { content: `env: SAMBANOVA_API_KEY=${KEY} again ${KEY}` } }], usage: {} }];
  try {
    const out = await runModel(snModel(), { prompt: 'x' });
    assert.equal(out.text, 'env: SAMBANOVA_API_KEY=[redacted] again [redacted]');
    reply = () => [401, { error: { message: `bad key ${KEY}` } }];
    await assert.rejects(runModel(snModel(), { prompt: 'x' }), (e) => !e.message.includes(KEY) && /401 bad key \[redacted\]/.test(e.message));
  } finally {
    reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: {} }];
  }
  assert.equal(redactKeys({ a: [`x ${KEY} y`] }).a[0], 'x [redacted] y');
  assert.equal(childEnv().SAMBANOVA_API_KEY, undefined);
  assert.ok(childEnv().PATH, 'other variables pass through');
});
