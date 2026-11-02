import { runOpenAI } from './http.js';
import { slimModel } from './openrouter.js';
import { costOf } from './groq.js';

export const SAMBANOVA_BASE = 'https://api.sambanova.ai/v1';
// Catalog source; tests point it at a local fake.
const catalogUrl = () => process.env.SAMBANOVA_CATALOG_URL || `${SAMBANOVA_BASE}/models`;
const CATALOG_TTL = 10 * 60_000;

/** SAMBANOVA_API_KEY of the server process (.env or the systemd EnvironmentFile), or '' when unset. */
export const sambanovaEnvKey = () => (process.env.SAMBANOVA_API_KEY || '').trim();

/** SambaNova Cloud's OpenAI-compatible API: the key falls back to SAMBANOVA_API_KEY; runs are costed from the saved prices. */
export async function runSambanova(opts) {
  const key = opts.model.api_key || sambanovaEnvKey();
  if (!key) throw new Error('SAMBANOVA_API_KEY is not set in the AgentForge service environment (README → SambaNova), and no key is stored for this model in Model Manager.');
  const out = await runOpenAI({ ...opts, model: { ...opts.model, api_key: key, base_url: opts.model.base_url || SAMBANOVA_BASE } });
  return { ...out, costUsd: costOf(out.usage, opts.model.config?.pricing) };
}

// The list has no modality fields: speech-to-text (Whisper) and embedding (E5) models are told apart by name.
const isChat = (m) => !/whisper|embed|(^|-)e5-/i.test(m.id);

const cache = new Map(); // key ('' = none) → { at, models }

/**
 * Every SambaNova chat model with prices per 1M tokens, cached for 10 minutes; a stale copy beats an error. The list is
 * public, but a key is sent when there is one (typed, stored on the model, else SAMBANOVA_API_KEY) in case it is account-specific.
 */
export async function sambanovaCatalog({ key = sambanovaEnvKey(), refresh = false } = {}) {
  let hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < CATALOG_TTL) return { models: hit.models, fetchedAt: new Date(hit.at).toISOString() };
  try {
    const res = await fetch(catalogUrl(), { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${json.error?.message || res.statusText}`);
    if (!Array.isArray(json.data)) throw new Error('unexpected response');
    hit = { at: Date.now(), models: json.data.filter((m) => m?.id && isChat(m)).map(slimModel) };
    cache.set(key, hit);
  } catch (err) {
    if (!hit) throw new Error(`Could not load the SambaNova model list: ${key ? err.message.split(key).join('[redacted]') : err.message}`);
  }
  return { models: hit.models, fetchedAt: new Date(hit.at).toISOString() };
}

export const resetSambanovaCache = () => { cache.clear(); };
