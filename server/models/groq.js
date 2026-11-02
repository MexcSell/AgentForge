import { runOpenAI } from './http.js';
import { slimModel } from './openrouter.js';

export const GROQ_BASE = 'https://api.groq.com/openai/v1';
// Catalog source; tests point it at a local fake.
const catalogUrl = () => process.env.GROQ_CATALOG_URL || `${GROQ_BASE}/models`;
const CATALOG_TTL = 10 * 60_000;

/** GROQ_API_KEY of the server process (.env or the systemd EnvironmentFile), or '' when unset. */
export const groqEnvKey = () => (process.env.GROQ_API_KEY || '').trim();

/** USD of one run from the prices per 1M tokens saved with the model when it was picked (Groq and SambaNova report no cost). */
export const costOf = (usage, p) => (p && !p.variable ? ((usage.input * (p.prompt || 0)) + (usage.output * (p.completion || 0))) / 1e6 : 0);

/** Groq's OpenAI-compatible API: the key falls back to GROQ_API_KEY. */
export async function runGroq(opts) {
  const key = opts.model.api_key || groqEnvKey();
  if (!key) throw new Error('GROQ_API_KEY is not set in the AgentForge service environment (README → Groq), and no key is stored for this model in Model Manager.');
  const out = await runOpenAI({ ...opts, model: { ...opts.model, api_key: key, base_url: opts.model.base_url || GROQ_BASE } });
  return { ...out, costUsd: costOf(out.usage, opts.model.config?.pricing) };
}

/** A model that answers a chat in text: not speech-to-text (Whisper), text-to-speech (Orpheus) or a Prompt Guard classifier. */
const isChat = (m) => m.active !== false && (m.output_modalities || ['text']).includes('text') && !/prompt-guard/.test(m.id);

/** The picker fields of one Groq /models entry: OpenRouter's shape, with the owner as a note. */
export const slimGroqModel = (m) => ({
  ...slimModel({ ...m, context_length: m.context_window || m.context_length, architecture: { input_modalities: m.input_modalities } }),
  note: m.owned_by || undefined,
});

const cache = new Map(); // key → { at, models }

/**
 * The chat models a Groq key can use, cached per key for 10 minutes; a stale copy beats an error. Unlike OpenRouter's,
 * Groq's list needs a key: the one typed in the dialog, else the one stored on the model, else GROQ_API_KEY.
 */
export async function groqCatalog({ key = groqEnvKey(), refresh = false } = {}) {
  if (!key) throw new Error('No Groq API key: set GROQ_API_KEY on the server (README → Groq) or type the key below, then reload the list');
  let hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < CATALOG_TTL) return { models: hit.models, fetchedAt: new Date(hit.at).toISOString() };
  try {
    const res = await fetch(catalogUrl(), { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${json.error?.message || res.statusText}`);
    if (!Array.isArray(json.data)) throw new Error('unexpected response');
    hit = { at: Date.now(), models: json.data.filter((m) => m?.id && isChat(m)).map(slimGroqModel) };
    cache.set(key, hit);
  } catch (err) {
    if (!hit) throw new Error(`Could not load the Groq model list: ${err.message.split(key).join('[redacted]')}`);
  }
  return { models: hit.models, fetchedAt: new Date(hit.at).toISOString() };
}

export const resetGroqCache = () => { cache.clear(); };
