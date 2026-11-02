import { one, many, query } from '../db/pool.js';
import { emit } from '../events.js';
import { runClaudeCode } from './claudeCode.js';
import { runCodex } from './codex.js';
import { anthropicEnvKey, runAnthropic, runGpt, runOpenAI } from './http.js';
import { openrouterEnvKey, runOpenRouter } from './openrouter.js';
import { groqEnvKey, runGroq } from './groq.js';
import { mistralEnvKey, runMistral } from './mistral.js';
import { cohereEnvKey, runCohere } from './cohere.js';
import { sambanovaEnvKey, runSambanova } from './sambanova.js';
import { runSimulator } from './simulator.js';

export const PROVIDERS = {
  'claude-code': { label: 'Claude Code', canEdit: true, run: runClaudeCode },
  codex: { label: 'Codex CLI', canEdit: true, run: runCodex },
  anthropic: { label: 'Anthropic API', canEdit: false, run: runAnthropic },
  gpt: { label: 'OpenAI GPT', canEdit: false, run: runGpt },
  openai: { label: 'OpenAI-compatible', canEdit: false, run: runOpenAI },
  openrouter: { label: 'OpenRouter', canEdit: false, run: runOpenRouter },
  groq: { label: 'Groq', canEdit: false, run: runGroq },
  mistral: { label: 'Mistral', canEdit: false, run: runMistral },
  cohere: { label: 'Cohere', canEdit: false, run: runCohere },
  sambanova: { label: 'SambaNova', canEdit: false, run: runSambanova },
  simulator: { label: 'Simulator', canEdit: false, run: runSimulator },
};

// ---- usage windows -------------------------------------------------------

export function windows(limits = {}, now = new Date()) {
  const hour = Number(limits.resetHour ?? 0);
  const day = Number(limits.weeklyResetDay ?? 1); // 0=Sun … 6=Sat
  const dailyStart = new Date(now);
  dailyStart.setHours(hour, 0, 0, 0);
  if (dailyStart > now) dailyStart.setDate(dailyStart.getDate() - 1);
  const dailyReset = new Date(dailyStart);
  dailyReset.setDate(dailyReset.getDate() + 1);
  const weeklyStart = new Date(dailyStart);
  while (weeklyStart.getDay() !== day) weeklyStart.setDate(weeklyStart.getDate() - 1);
  if (weeklyStart > now) weeklyStart.setDate(weeklyStart.getDate() - 7);
  const weeklyReset = new Date(weeklyStart);
  weeklyReset.setDate(weeklyReset.getDate() + 7);
  return { dailyStart, dailyReset, weeklyStart, weeklyReset };
}

export async function usageFor(model) {
  const w = windows(model.limits);
  const tokens = 'input_tokens + cache_write_5m_tokens + cache_write_1h_tokens + output_tokens';
  const row = await one(
    `SELECT
       coalesce(sum(${tokens}) FILTER (WHERE created_at >= $2), 0) AS daily_tokens,
       count(*) FILTER (WHERE created_at >= $2) AS daily_prompts,
       coalesce(sum(${tokens}) FILTER (WHERE created_at >= $3), 0) AS weekly_tokens,
       count(*) FILTER (WHERE created_at >= $3) AS weekly_prompts,
       coalesce(sum(cost_usd) FILTER (WHERE created_at >= $3), 0) AS weekly_cost,
       coalesce(sum(cache_tokens) FILTER (WHERE created_at >= $3), 0) AS weekly_cache,
       coalesce(sum(${tokens}), 0) AS total_tokens,
       count(*) AS total_prompts
     FROM runs WHERE model_id = $1`,
    [model.id, w.dailyStart, w.weeklyStart],
  );
  return {
    daily: { tokens: row.daily_tokens, prompts: Number(row.daily_prompts), resetAt: w.dailyReset },
    weekly: { tokens: row.weekly_tokens, prompts: Number(row.weekly_prompts), cost: row.weekly_cost, cache: row.weekly_cache, resetAt: w.weeklyReset },
    total: { tokens: row.total_tokens, prompts: Number(row.total_prompts) },
  };
}

export function publicModel(m) {
  const { api_key, ...rest } = m;
  return { ...rest, has_api_key: !!api_key, provider_label: PROVIDERS[m.provider]?.label || m.provider, can_edit: !!PROVIDERS[m.provider]?.canEdit };
}

export async function listModels() {
  const rows = await many(`SELECT * FROM models ORDER BY is_default DESC, created_at`);
  return Promise.all(rows.map(async (m) => ({ ...publicModel(m), usage: await usageFor(m) })));
}

export async function publishModels() {
  emit('models:update', await listModels());
}

export async function getDefaultModel() {
  return one(`SELECT * FROM models WHERE enabled ORDER BY is_default DESC, created_at LIMIT 1`);
}

export async function resolveModel(modelId) {
  let m = modelId ? await one(`SELECT * FROM models WHERE id = $1`, [modelId]) : null;
  if (!m || !m.enabled) m = await getDefaultModel();
  if (!m) throw new Error('No enabled model. Add one in Model Manager.');
  const l = m.limits || {};
  if (l.dailyTokens || l.dailyPrompts || l.weeklyTokens || l.weeklyPrompts) {
    const u = await usageFor(m);
    const over = (l.dailyTokens && u.daily.tokens >= l.dailyTokens && 'daily token') || (l.dailyPrompts && u.daily.prompts >= l.dailyPrompts && 'daily prompt')
      || (l.weeklyTokens && u.weekly.tokens >= l.weeklyTokens && 'weekly token') || (l.weeklyPrompts && u.weekly.prompts >= l.weeklyPrompts && 'weekly prompt');
    if (over) throw new Error(`${m.name}: ${over} limit reached. Raise the limit in Model Manager or wait for the reset.`);
  }
  return m;
}

/** Whether the server process has each provider key: the only thing about them that leaves the server (admins only). */
export const credentialStatus = () => ({
  ANTHROPIC_API_KEY: anthropicEnvKey() ? 'set' : 'missing',
  OPENROUTER_API_KEY: openrouterEnvKey() ? 'set' : 'missing',
  GROQ_API_KEY: groqEnvKey() ? 'set' : 'missing',
  MISTRAL_API_KEY: mistralEnvKey() ? 'set' : 'missing',
  COHERE_API_KEY: cohereEnvKey() ? 'set' : 'missing',
  SAMBANOVA_API_KEY: sambanovaEnvKey() ? 'set' : 'missing',
});

/**
 * Masks Anthropic, OpenRouter, Groq, Mistral, Cohere and SambaNova keys in what a run produces: agents inherit ANTHROPIC_API_KEY, so a shell `env` could
 * print it, and run events and outputs are stored and broadcast. The key prefixes also catch a key cut by a preview limit.
 */
export function redactKeys(v, key = anthropicEnvKey()) {
  if (typeof v === 'string') {
    let s = v;
    for (const k of [key, openrouterEnvKey(), groqEnvKey(), mistralEnvKey(), cohereEnvKey(), sambanovaEnvKey()].flat()) if (k) s = s.split(k).join('[redacted]');
    return s.replace(/sk-ant-[A-Za-z0-9_-]+|sk-or-v1-[A-Za-z0-9]+|gsk_[A-Za-z0-9]+|mstrl_[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/((?:ANTHROPIC|OPENROUTER|GROQ|MISTRAL|COHERE|SAMBANOVA)_API_KEY["']?\s*[=:]\s*["']?)[^\s"'\[]+/g, '$1[redacted]');
  }
  if (Array.isArray(v)) return v.map((x) => redactKeys(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactKeys(x, key)]));
  return v;
}

/** Runs a model and records usage. Every call becomes a row in `runs`. */
export async function runModel(model, opts, runId) {
  const provider = PROVIDERS[model.provider];
  if (!provider) throw new Error(`Unknown provider ${model.provider}`);
  // A key stored on the model reaches Claude Code agents too (their env), so it is masked like the server's.
  const keys = [anthropicEnvKey(), model.api_key];
  const onEvent = opts.onEvent && ((e) => opts.onEvent(redactKeys(e, keys)));
  let out;
  try {
    out = await provider.run({ ...opts, onEvent, model, access: provider.canEdit ? opts.access : 'read' });
  } catch (err) {
    // Assign only on a change: an abort's DOMException has a read-only message.
    const msg = redactKeys(err.message, keys);
    if (msg !== err.message) err.message = msg;
    if (err.partial) err.partial.text = redactKeys(err.partial.text, keys);
    throw err;
  }
  out.text = redactKeys(out.text, keys);
  if (out.rateLimit) {
    await query(`UPDATE models SET rate_limit = $2 WHERE id = $1`, [model.id, { ...out.rateLimit, observedAt: new Date().toISOString() }]);
  }
  return out;
}

export async function recordRunUsage(runId, out) {
  if (!out) return;
  await query(
    `UPDATE runs SET input_tokens=$2, output_tokens=$3, cache_tokens=$4, cost_usd=$5, tool_calls=$6, duration_ms=$7, session_id=$8, context_tokens=$9,
       cache_write_5m_tokens=$10, cache_write_1h_tokens=$11 WHERE id=$1`,
    [runId, out.usage?.input || 0, out.usage?.output || 0, out.usage?.cache || 0, out.costUsd || 0, out.toolCalls || {}, out.durationMs || 0, out.sessionId || null, out.contextTokens || 0,
      out.usage?.cacheWrite5m || 0, out.usage?.cacheWrite1h || 0],
  );
}
