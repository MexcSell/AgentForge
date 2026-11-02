import { runOpenAI } from './http.js';

export const MISTRAL_BASE = 'https://api.mistral.ai/v1';
// Catalog source; tests point it at a local fake.
const catalogUrl = () => process.env.MISTRAL_CATALOG_URL || `${MISTRAL_BASE}/models`;
const CATALOG_TTL = 10 * 60_000;

/** MISTRAL_API_KEY of the server process (.env or the systemd EnvironmentFile), or '' when unset. */
export const mistralEnvKey = () => (process.env.MISTRAL_API_KEY || '').trim();

/** Mistral's OpenAI-compatible API (console.mistral.ai): the key falls back to MISTRAL_API_KEY. Mistral reports no cost. */
export async function runMistral(opts) {
  const key = opts.model.api_key || mistralEnvKey();
  if (!key) throw new Error('MISTRAL_API_KEY is not set in the AgentForge service environment (README → Mistral), and no key is stored for this model in Model Manager.');
  return runOpenAI({ ...opts, model: { ...opts.model, api_key: key, base_url: opts.model.base_url || MISTRAL_BASE } });
}

/** A model that answers a chat and is not retired: not embeddings, OCR, moderation, transcription or speech. */
const isChat = (m, now) => m.capabilities?.completion_chat === true && !(m.deprecation && Date.parse(m.deprecation) <= now);

/** "reasoning · vision · code" from a /models entry's capabilities. */
const noteOf = (c = {}) => [c.reasoning && 'reasoning', c.vision && 'vision', c.completion_fim && 'code', c.audio && 'audio'].filter(Boolean).join(' · ') || undefined;

/**
 * Mistral lists every alias of a model as its own entry (codestral-2508, codestral-latest, mistral-code-latest…): one
 * picker row per model, under its `-latest` name when it has one (it follows upgrades), with the other names searchable.
 */
export function slimMistralModels(data, now = Date.now()) {
  const groups = new Map(); // sorted names → entries
  for (const m of data) {
    if (!m?.id || !isChat(m, now)) continue;
    const names = [...new Set([m.id, ...(m.aliases || [])])].sort().join(' ');
    groups.set(names, [...(groups.get(names) || []), m]);
  }
  return [...groups.entries()].map(([names, entries]) => {
    const m = entries.find((e) => e.id.endsWith('-latest')) || entries[0];
    return {
      id: m.id,
      name: m.id,
      created: m.created || 0,
      context: m.max_context_length || 0,
      vision: !!m.capabilities.vision,
      note: noteOf(m.capabilities),
      aliases: names.split(' ').filter((n) => n !== m.id),
    };
  });
}

const cache = new Map(); // key → { at, models }

/**
 * The chat models a Mistral key can see, cached per key for 10 minutes; a stale copy beats an error. The list needs a
 * key: the one typed in the dialog, else the one stored on the model, else MISTRAL_API_KEY.
 */
export async function mistralCatalog({ key = mistralEnvKey(), refresh = false } = {}) {
  if (!key) throw new Error('No Mistral API key: set MISTRAL_API_KEY on the server (README → Mistral) or type the key below, then reload the list');
  let hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < CATALOG_TTL) return { models: hit.models, fetchedAt: new Date(hit.at).toISOString() };
  try {
    const res = await fetch(catalogUrl(), { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${json.message || json.detail || res.statusText}`);
    if (!Array.isArray(json.data)) throw new Error('unexpected response');
    hit = { at: Date.now(), models: slimMistralModels(json.data) };
    cache.set(key, hit);
  } catch (err) {
    if (!hit) throw new Error(`Could not load the Mistral model list: ${String(err.message).split(key).join('[redacted]')}`);
  }
  return { models: hit.models, fetchedAt: new Date(hit.at).toISOString() };
}

export const resetMistralCache = () => { cache.clear(); };
