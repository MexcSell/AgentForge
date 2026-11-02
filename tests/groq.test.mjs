// Groq (server/models/groq.js): the model list needs a key, keeps chat models only, is slimmed to prices per 1M tokens and
// cached per key; runs send the server's GROQ_API_KEY (or the model's own) as a bearer token and are costed from the
// prices saved with the model; the key never reaches agents or run output.
// Everything runs against a local fake API: no request reaches groq.com, and the real key (.env) is replaced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = `gsk_${crypto.randomBytes(24).toString('hex')}`;

// Two chat models, then what the picker must leave out: speech-to-text, text-to-speech, a Prompt Guard classifier, an inactive model.
const CATALOG = [
  { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', owned_by: 'OpenAI', created: 300, context_window: 131072, input_modalities: ['text'], output_modalities: ['text'], pricing: { prompt: '0.00000015', completion: '0.0000006', image: '0', request: '0', input_cache_read: '0.000000075' } },
  { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', owned_by: 'Alibaba Cloud', created: 400, context_window: 131072, input_modalities: ['text', 'image'], output_modalities: ['text'], pricing: { prompt: '0.0000003', completion: '0.0000012' } },
  { id: 'whisper-large-v3', name: 'Whisper', owned_by: 'OpenAI', created: 100, context_window: 448, input_modalities: ['audio'], output_modalities: ['transcription'] },
  { id: 'canopylabs/orpheus-v1-english', name: 'Orpheus', created: 100, context_window: 4000, input_modalities: ['text'], output_modalities: ['speech'], pricing: { prompt: '0.000022' } },
  { id: 'meta-llama/llama-prompt-guard-2-86m', name: 'Prompt Guard', created: 100, context_window: 512, output_modalities: ['text'] },
  { id: 'old/retired', name: 'Retired', created: 1, context_window: 8192, active: false, output_modalities: ['text'] },
];

const hits = [];
let catalogStatus = 200;
let reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 2000, completion_tokens: 1000 } }];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch {}
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
    const [status, data] = req.url === '/models'
      ? (catalogStatus === 200 ? [200, { object: 'list', data: CATALOG }] : [catalogStatus, { error: { message: `Invalid API Key ${req.headers.authorization}` } }])
      : reply(json);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
});
let base;

const { runModel, redactKeys, credentialStatus, PROVIDERS } = await import('../server/models/index.js');
const { groqCatalog, resetGroqCache, GROQ_BASE } = await import('../server/models/groq.js');
const { childEnv } = await import('../server/services/env.js');

const realKey = process.env.GROQ_API_KEY;
const withKey = (v, fn) => async () => {
  if (v === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = v;
  try { return await fn(); } finally { process.env.GROQ_API_KEY = KEY; }
};
const PRICING = { prompt: 0.15, completion: 0.6, free: false, variable: false };
const groqModel = (extra = {}) => ({ id: 'groq-test', provider: 'groq', model: 'openai/gpt-oss-120b', base_url: base, api_key: null, config: { pricing: PRICING }, ...extra });

before(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
  process.env.GROQ_CATALOG_URL = `${base}/models`;
  process.env.GROQ_API_KEY = KEY;
});

after(() => {
  api.close();
  if (realKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = realKey;
  delete process.env.GROQ_CATALOG_URL;
});

test('Groq is a text-only provider on its OpenAI-compatible API', () => {
  assert.equal(PROVIDERS.groq.label, 'Groq');
  assert.equal(PROVIDERS.groq.canEdit, false);
  assert.equal(GROQ_BASE, 'https://api.groq.com/openai/v1');
});

test('the model list keeps chat models only, with prices per 1M tokens, context, vision and the owner', async () => {
  resetGroqCache();
  const { models } = await groqCatalog();
  assert.deepEqual(models, [
    { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', created: 300, context: 131072, prompt: 0.15, completion: 0.6, variable: false, free: false, vision: false, note: 'OpenAI' },
    { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', created: 400, context: 131072, prompt: 0.3, completion: 1.2, variable: false, free: false, vision: true, note: 'Alibaba Cloud' },
  ]);
});

test('the list is fetched with the key, cached per key; a failure keeps the stale copy, and with no copy it errors without the key', async () => {
  resetGroqCache();
  hits.length = 0;
  const a = await groqCatalog();
  const b = await groqCatalog();
  assert.equal(b.fetchedAt, a.fetchedAt);
  await groqCatalog({ key: 'gsk_other' });
  assert.deepEqual(hits.map((h) => [h.method, h.url, h.auth]), [['GET', '/models', `Bearer ${KEY}`], ['GET', '/models', 'Bearer gsk_other']], 'cached per key');
  catalogStatus = 401;
  try {
    assert.equal((await groqCatalog({ refresh: true })).models.length, 2, 'stale copy on failure');
    resetGroqCache();
    await assert.rejects(groqCatalog(), (e) => /Could not load the Groq model list: 401 Invalid API Key Bearer \[redacted\]/.test(e.message) && !e.message.includes(KEY));
  } finally { catalogStatus = 200; }
});

test('without any key the list fails clearly and sends nothing', withKey(undefined, async () => {
  resetGroqCache();
  hits.length = 0;
  await assert.rejects(groqCatalog(), /No Groq API key: set GROQ_API_KEY/);
  assert.equal(hits.length, 0);
}));

test('a run sends the server key as a bearer token and is costed from the saved prices', async () => {
  hits.length = 0;
  const out = await runModel(groqModel(), { prompt: 'Reply OK', system: 'be brief' });
  assert.equal(out.text, 'OK');
  assert.deepEqual(out.usage, { input: 2000, output: 1000, cache: 0 });
  assert.equal(out.costUsd, (2000 * 0.15 + 1000 * 0.6) / 1e6);
  const [h] = hits;
  assert.deepEqual([h.method, h.url, h.auth, h.body.model], ['POST', '/chat/completions', `Bearer ${KEY}`, 'openai/gpt-oss-120b']);
  assert.deepEqual(h.body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'Reply OK' }]);
  assert.equal((await runModel(groqModel({ config: {} }), { prompt: 'x' })).costUsd, 0, 'no saved prices (typed model id): no cost');
});

test('a key stored on the model wins over the server key', async () => {
  hits.length = 0;
  await runModel(groqModel({ api_key: 'gsk_stored' }), { prompt: 'x' });
  assert.equal(hits[0].auth, 'Bearer gsk_stored');
});

test('without GROQ_API_KEY a run fails clearly and sends nothing', withKey(undefined, async () => {
  hits.length = 0;
  await assert.rejects(runModel(groqModel(), { prompt: 'x' }), /GROQ_API_KEY is not set in the AgentForge service environment/);
  assert.equal(hits.length, 0);
  assert.equal(credentialStatus().GROQ_API_KEY, 'missing');
  process.env.GROQ_API_KEY = KEY;
  assert.equal(credentialStatus().GROQ_API_KEY, 'set');
  assert.equal(JSON.stringify(credentialStatus()).includes(KEY), false);
}));

test('the key is masked in run output and errors, and agents never inherit it', async () => {
  reply = () => [200, { choices: [{ message: { content: `env: GROQ_API_KEY=${KEY} other gsk_abc123` } }], usage: {} }];
  try {
    const out = await runModel(groqModel(), { prompt: 'x' });
    assert.equal(out.text, 'env: GROQ_API_KEY=[redacted] other [redacted]');
    reply = () => [401, { error: { message: `bad key ${KEY}` } }];
    await assert.rejects(runModel(groqModel(), { prompt: 'x' }), (e) => !e.message.includes(KEY) && /401 bad key \[redacted\]/.test(e.message));
  } finally {
    reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: {} }];
  }
  assert.equal(redactKeys({ a: [KEY.slice(0, 20)] }).a[0], '[redacted]', 'a key cut short is still masked');
  assert.equal(childEnv().GROQ_API_KEY, undefined);
  assert.ok(childEnv().PATH, 'other variables pass through');
});
