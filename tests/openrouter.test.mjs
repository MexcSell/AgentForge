// OpenRouter (server/models/openrouter.js, client/src/lib/openrouter.js): the catalog is fetched once, slimmed to prices
// per 1M tokens with a free flag and cached; runs send the server's OPENROUTER_API_KEY as a bearer token and record the
// reported cost; the key never reaches agents or run output; the Model Manager picker sorts by free / cost and filters.
// Everything runs against a local fake API: no request reaches openrouter.ai, and the real key (.env) is replaced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = `sk-or-v1-${crypto.randomBytes(16).toString('hex')}`;

// Fake catalog: a free (`:free`), a zero-priced router without the suffix, a variable-price router (-1), two paid.
const CATALOG = [
  { id: 'acme/big', name: 'Acme: Big', created: 300, context_length: 200000, pricing: { prompt: '0.000015', completion: '0.000075' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'acme/small:free', name: 'Acme: Small (free)', created: 100, context_length: 32768, pricing: { prompt: '0', completion: '0' } },
  { id: 'openrouter/auto', name: 'Auto Router', created: 50, context_length: 2000000, pricing: { prompt: '-1', completion: '-1' } },
  { id: 'openrouter/free', name: 'Free Models Router', created: 200, context_length: 128000, pricing: { prompt: '0', completion: '0' } },
  { id: 'zeta/mini', name: 'Zeta: Mini', created: 400, context_length: 1048576, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
];
// Not free although the token prices are (or round to) zero.
const NOT_FREE = [
  { id: 'per/request', name: 'Per request', pricing: { prompt: '0', completion: '0', request: '0.002' } },
  { id: 'tiny/price', name: 'Tiny price', pricing: { prompt: '0.00000000001', completion: '0' } },
];

const hits = [];
let catalogDown = false;
let reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 7, completion_tokens: 1, cost: 0.00042 } }];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch {}
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, title: req.headers['x-title'], body: json });
    const [status, data] = req.url === '/models' ? (catalogDown ? [503, {}] : [200, { data: CATALOG }]) : reply(json);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
});
let base;

const { runModel, redactKeys, credentialStatus, PROVIDERS } = await import('../server/models/index.js');
const { openrouterCatalog, resetCatalogCache, slimModel } = await import('../server/models/openrouter.js');
const { childEnv } = await import('../server/services/env.js');
const { pickList, perM, ctx } = await import('../client/src/lib/openrouter.js');

const realKey = process.env.OPENROUTER_API_KEY;
const withKey = (v, fn) => async () => {
  if (v === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = v;
  try { return await fn(); } finally { process.env.OPENROUTER_API_KEY = KEY; }
};
const orModel = (extra = {}) => ({ id: 'openrouter-test', provider: 'openrouter', model: 'acme/small:free', base_url: base, api_key: null, config: {}, ...extra });

before(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
  process.env.OPENROUTER_CATALOG_URL = `${base}/models`;
  process.env.OPENROUTER_API_KEY = KEY;
});

after(() => {
  api.close();
  if (realKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = realKey;
  delete process.env.OPENROUTER_CATALOG_URL;
});

test('OpenRouter is a text-only provider', () => {
  assert.equal(PROVIDERS.openrouter.label, 'OpenRouter');
  assert.equal(PROVIDERS.openrouter.canEdit, false);
});

test('catalog entries carry USD per 1M tokens, a free flag, and routers with a variable price', () => {
  const [big, small, auto, free, mini] = CATALOG.map(slimModel);
  assert.deepEqual(big, { id: 'acme/big', name: 'Acme: Big', created: 300, context: 200000, prompt: 15, completion: 75, variable: false, free: false, vision: true });
  assert.deepEqual([small.free, small.prompt, small.completion], [true, 0, 0]);
  assert.deepEqual([auto.variable, auto.free, auto.prompt], [true, false, null], '-1 is a variable price, not free');
  assert.equal(free.free, true, 'zero-priced without the :free suffix is free too');
  assert.deepEqual([mini.prompt, mini.completion], [0.15, 0.6]);
  assert.deepEqual(NOT_FREE.map((m) => slimModel(m).free), [false, false], 'a per-request price or a price that rounds to 0 is not free');
  assert.equal(slimModel({ id: 'z', pricing: { prompt: '0', completion: '0', input_cache_read: '0', overrides: {} } }).free, true);
});

test('the catalog is fetched once and cached; a failure keeps the stale copy, and with no copy it errors', async () => {
  resetCatalogCache();
  hits.length = 0;
  const a = await openrouterCatalog();
  const b = await openrouterCatalog();
  assert.equal(a.models.length, 5);
  assert.equal(b.fetchedAt, a.fetchedAt);
  assert.equal(hits.filter((h) => h.url === '/models').length, 1, 'second call served from cache');
  assert.equal(hits[0].auth, undefined, 'the public catalog is fetched without the key');
  catalogDown = true;
  try {
    assert.equal((await openrouterCatalog({ refresh: true })).models.length, 5, 'stale copy on failure');
    resetCatalogCache();
    await assert.rejects(openrouterCatalog(), /Could not load the OpenRouter model list: 503/);
  } finally { catalogDown = false; }
});

test('a run sends the server key as a bearer token to the OpenRouter API and records the reported cost', async () => {
  hits.length = 0;
  const out = await runModel(orModel(), { prompt: 'Reply OK', system: 'be brief' });
  assert.equal(out.text, 'OK');
  assert.deepEqual(out.usage, { input: 7, output: 1, cache: 0 });
  assert.equal(out.costUsd, 0.00042);
  const [h] = hits;
  assert.deepEqual([h.method, h.url, h.auth, h.title], ['POST', '/chat/completions', `Bearer ${KEY}`, 'AgentForge']);
  assert.equal(h.body.model, 'acme/small:free');
  assert.deepEqual(h.body.usage, { include: true });
  assert.deepEqual(h.body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'Reply OK' }]);
});

test('a key stored on the model wins over the server key', async () => {
  hits.length = 0;
  await runModel(orModel({ api_key: 'sk-or-v1-stored' }), { prompt: 'x' });
  assert.equal(hits[0].auth, 'Bearer sk-or-v1-stored');
});

test('without OPENROUTER_API_KEY a run fails clearly and sends nothing', withKey(undefined, async () => {
  hits.length = 0;
  await assert.rejects(runModel(orModel(), { prompt: 'x' }), /OPENROUTER_API_KEY is not set in the AgentForge service environment/);
  assert.equal(hits.length, 0);
  assert.equal(credentialStatus().OPENROUTER_API_KEY, 'missing');
}));

test('credential status says set / missing, never the value', withKey('  ', async () => {
  assert.equal(credentialStatus().OPENROUTER_API_KEY, 'missing', 'blank counts as missing');
  process.env.OPENROUTER_API_KEY = KEY;
  assert.equal(credentialStatus().OPENROUTER_API_KEY, 'set');
  assert.equal(JSON.stringify(credentialStatus()).includes(KEY), false);
}));

test('the key is masked in run output and errors, and agents never inherit it', async () => {
  reply = () => [200, { choices: [{ message: { content: `env: OPENROUTER_API_KEY=${KEY} other sk-or-v1-abc123` } }], usage: {} }];
  try {
    const out = await runModel(orModel(), { prompt: 'x' });
    assert.equal(out.text, 'env: OPENROUTER_API_KEY=[redacted] other [redacted]');
    reply = () => [401, { error: { message: `bad key ${KEY}` } }];
    await assert.rejects(runModel(orModel(), { prompt: 'x' }), (e) => !e.message.includes(KEY) && /401 bad key \[redacted\]/.test(e.message));
  } finally {
    reply = () => [200, { choices: [{ message: { content: 'OK' } }], usage: {} }];
  }
  assert.equal(redactKeys({ a: [`${KEY.slice(0, 20)}`] }).a[0], '[redacted]', 'a key cut short is still masked');
  assert.equal(childEnv().OPENROUTER_API_KEY, undefined);
  assert.ok(childEnv().PATH, 'other variables pass through');
});

test('picker: free first then cheapest; variable-price routers go last in both cost orders', () => {
  const models = CATALOG.map(slimModel);
  const ids = (o) => pickList(models, o).map((m) => m.id);
  assert.deepEqual(ids({ sort: 'free' }), ['acme/small:free', 'openrouter/free', 'zeta/mini', 'acme/big', 'openrouter/auto']);
  assert.deepEqual(ids({ sort: 'cheap' }), ['acme/small:free', 'openrouter/free', 'zeta/mini', 'acme/big', 'openrouter/auto']);
  assert.deepEqual(ids({ sort: 'pricey' }), ['acme/big', 'zeta/mini', 'acme/small:free', 'openrouter/free', 'openrouter/auto']);
  assert.deepEqual(ids({ sort: 'newest' }), ['zeta/mini', 'acme/big', 'openrouter/free', 'acme/small:free', 'openrouter/auto']);
  assert.deepEqual(ids({ sort: 'context' }), ['openrouter/auto', 'zeta/mini', 'acme/big', 'openrouter/free', 'acme/small:free']);
  assert.deepEqual(ids({ sort: 'name' }), ['acme/big', 'acme/small:free', 'openrouter/auto', 'openrouter/free', 'zeta/mini']);
});

test('picker: free-only filter and a search where every word must match the id or name', () => {
  const models = CATALOG.map(slimModel);
  const ids = (o) => pickList(models, o).map((m) => m.id);
  assert.deepEqual(ids({ freeOnly: true }), ['acme/small:free', 'openrouter/free']);
  assert.deepEqual(ids({ query: 'ACME' }), ['acme/small:free', 'acme/big']);
  assert.deepEqual(ids({ query: 'router free' }), ['openrouter/free']);
  assert.deepEqual(ids({ query: 'acme', freeOnly: true }), ['acme/small:free']);
  assert.equal(models[0].id, 'acme/big', 'the input list is not sorted in place');
});

test('picker labels: prices per 1M tokens and context size', () => {
  assert.deepEqual([perM(0), perM(0.15), perM(1.5), perM(2), perM(0.0042), perM(15), perM(null, true)], ['free', '$0.15', '$1.5', '$2', '$0.0042', '$15', 'varies']);
  assert.deepEqual([ctx(32768), ctx(200000), ctx(1048576), ctx(2000000), ctx(0)], ['33K', '200K', '1M', '2M', '—']);
});
