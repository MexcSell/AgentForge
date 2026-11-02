import { runOpenAI } from './http.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
// Catalog source; tests point it at a local fake.
const catalogUrl = () => process.env.OPENROUTER_CATALOG_URL || `${OPENROUTER_BASE}/models`;
const CATALOG_TTL = 10 * 60_000;

/** OPENROUTER_API_KEY of the server process (.env or the systemd EnvironmentFile), or '' when unset. */
export const openrouterEnvKey = () => (process.env.OPENROUTER_API_KEY || '').trim();

/** OpenRouter's OpenAI-compatible API: the key falls back to OPENROUTER_API_KEY, and the reported cost is recorded. */
export async function runOpenRouter(opts) {
  const key = opts.model.api_key || openrouterEnvKey();
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in the AgentForge service environment (README → OpenRouter), and no key is stored for this model in Model Manager.');
  return runOpenAI({
    ...opts,
    model: { ...opts.model, api_key: key, base_url: opts.model.base_url || OPENROUTER_BASE },
    headers: { 'X-Title': 'AgentForge' },
    body: { usage: { include: true } },
  });
}

/** USD per 1M tokens from OpenRouter's per-token string; null for a router whose price depends on the model it picks (-1). */
const perMillion = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null;
};

/** The fields the Model Manager picker needs from one /models entry. */
export function slimModel(m) {
  const prompt = perMillion(m.pricing?.prompt);
  const completion = perMillion(m.pricing?.completion);
  const variable = prompt === null || completion === null;
  return {
    id: m.id,
    name: m.name || m.id,
    created: m.created || 0,
    context: m.context_length || m.top_provider?.context_length || 0,
    prompt,
    completion,
    variable,
    // Every price exactly zero (raw strings: a tiny token price rounds to 0 per 1M; a per-request or image price counts).
    free: !variable && Object.values(m.pricing || {}).every((v) => typeof v !== 'string' || Number(v) === 0),
    vision: (m.architecture?.input_modalities || []).includes('image'),
  };
}

let cache = null; // { at, models }

/** Every model OpenRouter lists (public endpoint, no key needed), cached for 10 minutes; a stale copy beats an error. */
export async function openrouterCatalog({ refresh = false } = {}) {
  if (cache && !refresh && Date.now() - cache.at < CATALOG_TTL) return { models: cache.models, fetchedAt: new Date(cache.at).toISOString() };
  try {
    const res = await fetch(catalogUrl(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    if (!Array.isArray(json.data)) throw new Error('unexpected response');
    cache = { at: Date.now(), models: json.data.filter((m) => m?.id).map(slimModel) };
  } catch (err) {
    if (!cache) throw new Error(`Could not load the OpenRouter model list: ${err.message}`);
  }
  return { models: cache.models, fetchedAt: new Date(cache.at).toISOString() };
}

export const resetCatalogCache = () => { cache = null; };
