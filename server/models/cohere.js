import { runOpenAI } from './http.js';

// Chat runs go through Cohere's OpenAI-compatible API; the model list only exists on the native API.
export const COHERE_BASE = 'https://api.cohere.ai/compatibility/v1';
// Catalog source; tests point it at a local fake.
const catalogUrl = () => process.env.COHERE_CATALOG_URL || 'https://api.cohere.com/v1/models';
const CATALOG_TTL = 10 * 60_000;

/** COHERE_API_KEY of the server process (.env or the systemd EnvironmentFile), or '' when unset. */
export const cohereEnvKey = () => (process.env.COHERE_API_KEY || '').trim();

/** Cohere's OpenAI-compatible API: the key falls back to COHERE_API_KEY. Cohere reports no cost. */
export async function runCohere(opts) {
  const key = opts.model.api_key || cohereEnvKey();
  if (!key) throw new Error('COHERE_API_KEY is not set in the AgentForge service environment (README → Cohere), and no key is stored for this model in Model Manager.');
  return runOpenAI({ ...opts, model: { ...opts.model, api_key: key, base_url: opts.model.base_url || COHERE_BASE } });
}

/** The picker fields of one Cohere /v1/models entry (no prices, like Mistral's: Cohere's list has none). */
export const slimCohereModel = (m) => ({
  id: m.name,
  name: m.name,
  created: 0,
  context: m.context_length || 0,
  vision: (m.features || []).includes('vision'),
  note: [m.finetuned && 'fine-tuned', (m.features || []).includes('vision') && 'vision'].filter(Boolean).join(' · ') || undefined,
});

const cache = new Map(); // key → { at, models }

/** Every page of the chat models a key can use (deprecated ones left out). */
async function fetchModels(key) {
  const models = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(catalogUrl());
    url.searchParams.set('endpoint', 'chat');
    url.searchParams.set('page_size', '1000');
    if (token) url.searchParams.set('page_token', token);
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${json.message || res.statusText}`);
    if (!Array.isArray(json.models)) throw new Error('unexpected response');
    models.push(...json.models.filter((m) => m?.name && !m.is_deprecated).map(slimCohereModel));
    token = json.next_page_token;
    if (!token) break;
  }
  return models;
}

/**
 * The chat models a Cohere key can use, cached per key for 10 minutes; a stale copy beats an error. The list needs a
 * key: the one typed in the dialog, else the one stored on the model, else COHERE_API_KEY.
 */
export async function cohereCatalog({ key = cohereEnvKey(), refresh = false } = {}) {
  if (!key) throw new Error('No Cohere API key: set COHERE_API_KEY on the server (README → Cohere) or type the key below, then reload the list');
  let hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < CATALOG_TTL) return { models: hit.models, fetchedAt: new Date(hit.at).toISOString() };
  try {
    hit = { at: Date.now(), models: await fetchModels(key) };
    cache.set(key, hit);
  } catch (err) {
    if (!hit) throw new Error(`Could not load the Cohere model list: ${err.message.split(key).join('[redacted]')}`);
  }
  return { models: hit.models, fetchedAt: new Date(hit.at).toISOString() };
}

export const resetCohereCache = () => { cache.clear(); };
