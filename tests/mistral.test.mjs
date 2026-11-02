// Mistral (server/models/mistral.js): the model list needs a key, keeps chat models only, folds each model's aliases into
// one row (its -latest name) and is cached per key; runs send the server's MISTRAL_API_KEY (or the model's own) as a
// bearer token, keep only the text of reasoning models' answers, and report Mistral's top-level error message; the key
// never reaches agents or run output.
// Everything runs against a local fake API: no request reaches mistral.ai, and the real key (.env) is replaced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = `mstrl_${crypto.randomBytes(18).toString('hex')}_x`;

const caps = (c = {}) => ({ completion_chat: true, function_calling: true, reasoning: false, completion_fim: false, vision: false, audio: false, ...c });
// One model under three names, a reasoning model under two, a model with no -latest name, then what the picker must
// leave out: embeddings, OCR, transcription, and a model past its deprecation date.
const CATALOG = [
  { id: 'codestral-2508', created: 5, max_context_length: 256000, capabilities: caps({ completion_fim: true }), aliases: ['codestral-latest', 'mistral-code-latest'], deprecation: null },
  { id: 'codestral-latest', created: 5, max_context_length: 256000, capabilities: caps({ completion_fim: true }), aliases: ['codestral-2508', 'mistral-code-latest'], deprecation: null },
  { id: 'mistral-code-latest', created: 5, max_context_length: 256000, capabilities: caps({ completion_fim: true }), aliases: ['codestral-2508', 'codestral-latest'], deprecation: null },
  { id: 'mistral-large-4', created: 5, max_context_length: 1048576, capabilities: caps({ reasoning: true, vision: true }), aliases: ['mistral-large-4-0'] },
  { id: 'mistral-large-4-0', created: 5, max_context_length: 1048576, capabilities: caps({ reasoning: true, vision: true }), aliases: ['mistral-large-4'] },
  { id: 'ministral-3b-latest', created: 5, max_context_length: 131072, capabilities: caps({ vision: true }), aliases: ['ministral-3b-2512'], deprecation: '2999-01-01T00:00:00Z' },
  { id: 'mistral-embed', created: 5, max_context_length: 8192, capabilities: caps({ completion_chat: false, function_calling: false }), aliases: [] },
  { id: 'mistral-ocr-latest', created: 5, max_context_length: 16384, capabilities: caps({ completion_chat: false, ocr: true }), aliases: [] },
  { id: 'voxtral-mini-latest', created: 5, max_context_length: 16384, capabilities: caps({ completion_chat: false, audio_transcription: true }), aliases: [] },
  { id: 'open-mistral-7b', created: 5, max_context_length: 32768, capabilities: caps(), aliases: [], deprecation: '2025-03-30T12:00:00Z' },
];

const hits = [];
let catalogStatus = 200;
const OK = () => [200, { choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }];
let reply = OK;
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch {}
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
    const [status, data] = req.url === '/models'
      ? (catalogStatus === 200 ? [200, { object: 'list', data: CATALOG }] : [catalogStatus, { detail: 'Unauthorized', message: `Invalid key ${req.headers.authorization}` }])
      : reply(json);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
});
let base;

const { runModel, redactKeys, credentialStatus, PROVIDERS } = await import('../server/models/index.js');
const { mistralCatalog, resetMistralCache, MISTRAL_BASE } = await import('../server/models/mistral.js');
const { childEnv } = await import('../server/services/env.js');

const realKey = process.env.MISTRAL_API_KEY;
const withKey = (v, fn) => async () => {
  if (v === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = v;
  try { return await fn(); } finally { process.env.MISTRAL_API_KEY = KEY; }
};
const mistralModel = (extra = {}) => ({ id: 'mistral-test', provider: 'mistral', model: 'mistral-large-4', base_url: base, api_key: null, config: {}, ...extra });

before(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
  process.env.MISTRAL_CATALOG_URL = `${base}/models`;
  process.env.MISTRAL_API_KEY = KEY;
});

after(() => {
  api.close();
  if (realKey === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = realKey;
  delete process.env.MISTRAL_CATALOG_URL;
});

test('Mistral is a text-only provider on its OpenAI-compatible API', () => {
  assert.equal(PROVIDERS.mistral.label, 'Mistral');
  assert.equal(PROVIDERS.mistral.canEdit, false);
  assert.equal(MISTRAL_BASE, 'https://api.mistral.ai/v1');
});

test('the model list keeps current chat models, one row per model under its -latest name, with its other names and capabilities', async () => {
  resetMistralCache();
  const { models } = await mistralCatalog();
  assert.deepEqual(models, [
    { id: 'codestral-latest', name: 'codestral-latest', created: 5, context: 256000, vision: false, note: 'code', aliases: ['codestral-2508', 'mistral-code-latest'] },
    { id: 'mistral-large-4', name: 'mistral-large-4', created: 5, context: 1048576, vision: true, note: 'reasoning · vision', aliases: ['mistral-large-4-0'] },
    { id: 'ministral-3b-latest', name: 'ministral-3b-latest', created: 5, context: 131072, vision: true, note: 'vision', aliases: ['ministral-3b-2512'] },
  ]);
  assert.ok(models.every((m) => !('prompt' in m)), 'no prices: the picker shows none');
});

test('the list is fetched with the key, cached per key; a failure keeps the stale copy, and with no copy it errors without the key', async () => {
  resetMistralCache();
  hits.length = 0;
  const a = await mistralCatalog();
  const b = await mistralCatalog();
  assert.equal(b.fetchedAt, a.fetchedAt);
  await mistralCatalog({ key: 'mstrl_other' });
  assert.deepEqual(hits.map((h) => [h.method, h.url, h.auth]), [['GET', '/models', `Bearer ${KEY}`], ['GET', '/models', 'Bearer mstrl_other']], 'cached per key');
  catalogStatus = 401;
  try {
    assert.equal((await mistralCatalog({ refresh: true })).models.length, 3, 'stale copy on failure');
    resetMistralCache();
    await assert.rejects(mistralCatalog(), (e) => /Could not load the Mistral model list: 401 Invalid key Bearer \[redacted\]/.test(e.message) && !e.message.includes(KEY));
  } finally { catalogStatus = 200; }
});

test('without any key the list fails clearly and sends nothing', withKey(undefined, async () => {
  resetMistralCache();
  hits.length = 0;
  await assert.rejects(mistralCatalog(), /No Mistral API key: set MISTRAL_API_KEY/);
  assert.equal(hits.length, 0);
}));

test('a run sends the server key as a bearer token to the chosen model; Mistral reports no cost', async () => {
  hits.length = 0;
  const out = await runModel(mistralModel(), { prompt: 'Reply OK', system: 'be brief' });
  assert.equal(out.text, 'OK');
  assert.deepEqual(out.usage, { input: 20, output: 10, cache: 0 });
  assert.equal(out.costUsd, 0);
  const [h] = hits;
  assert.deepEqual([h.method, h.url, h.auth, h.body.model], ['POST', '/chat/completions', `Bearer ${KEY}`, 'mistral-large-4']);
  assert.deepEqual(h.body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'Reply OK' }]);
});

test('a reasoning model\'s answer keeps its text blocks and leaves out the thinking', async () => {
  reply = () => [200, { choices: [{ message: { role: 'assistant', content: [
    { type: 'thinking', thinking: [{ type: 'text', text: 'The user wants two words.' }] },
    { type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' },
  ] } }], usage: { prompt_tokens: 9, completion_tokens: 300 } }];
  const events = [];
  try {
    const out = await runModel(mistralModel(), { prompt: 'Say hi in 2 words', onEvent: (e) => events.push(e) });
    assert.equal(out.text, 'Hi there');
    assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['Hi there']);
  } finally { reply = OK; }
});

test('Mistral\'s top-level error message reaches the run error', async () => {
  reply = () => [429, { object: 'error', message: 'Rate limit exceeded', type: 'rate_limited', code: '1300' }];
  try {
    await assert.rejects(runModel(mistralModel(), { prompt: 'x' }), /429 Rate limit exceeded/);
    reply = () => [422, { object: 'error', message: { detail: [{ msg: 'bad field' }] }, type: 'invalid_request_error' }];
    await assert.rejects(runModel(mistralModel(), { prompt: 'x' }), /422 \{"detail":\[\{"msg":"bad field"\}\]\}/);
  } finally { reply = OK; }
});

test('a key stored on the model wins over the server key', async () => {
  hits.length = 0;
  await runModel(mistralModel({ api_key: 'mstrl_stored' }), { prompt: 'x' });
  assert.equal(hits[0].auth, 'Bearer mstrl_stored');
});

test('without MISTRAL_API_KEY a run fails clearly and sends nothing', withKey(undefined, async () => {
  hits.length = 0;
  await assert.rejects(runModel(mistralModel(), { prompt: 'x' }), /MISTRAL_API_KEY is not set in the AgentForge service environment/);
  assert.equal(hits.length, 0);
  assert.equal(credentialStatus().MISTRAL_API_KEY, 'missing');
  process.env.MISTRAL_API_KEY = KEY;
  assert.equal(credentialStatus().MISTRAL_API_KEY, 'set');
  assert.equal(JSON.stringify(credentialStatus()).includes(KEY), false);
}));

test('the key is masked in run output and errors, and agents never inherit it', async () => {
  reply = () => [200, { choices: [{ message: { content: `env: MISTRAL_API_KEY=${KEY} other mstrl_abc_12-3` } }], usage: {} }];
  try {
    const out = await runModel(mistralModel(), { prompt: 'x' });
    assert.equal(out.text, 'env: MISTRAL_API_KEY=[redacted] other [redacted]');
    reply = () => [401, { object: 'error', message: `bad key ${KEY}` }];
    await assert.rejects(runModel(mistralModel(), { prompt: 'x' }), (e) => !e.message.includes(KEY) && /401 bad key \[redacted\]/.test(e.message));
  } finally { reply = OK; }
  assert.equal(redactKeys({ a: [KEY.slice(0, 20)] }).a[0], '[redacted]', 'a key cut short is still masked');
  assert.equal(childEnv().MISTRAL_API_KEY, undefined);
  assert.ok(childEnv().PATH, 'other variables pass through');
});
