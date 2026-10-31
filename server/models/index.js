import { one, many, query } from '../db/pool.js';
import { emit } from '../events.js';
import { runClaudeCode } from './claudeCode.js';
import { runCodex } from './codex.js';
import { runAnthropic, runGpt, runOpenAI } from './http.js';
import { runSimulator } from './simulator.js';

export const PROVIDERS = {
  'claude-code': { label: 'Claude Code', canEdit: true, run: runClaudeCode },
  codex: { label: 'Codex CLI', canEdit: true, run: runCodex },
  anthropic: { label: 'Anthropic API', canEdit: false, run: runAnthropic },
  gpt: { label: 'OpenAI GPT', canEdit: false, run: runGpt },
  openai: { label: 'OpenAI-compatible', canEdit: false, run: runOpenAI },
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
  const row = await one(
    `SELECT
       coalesce(sum(input_tokens + output_tokens) FILTER (WHERE created_at >= $2), 0) AS daily_tokens,
       count(*) FILTER (WHERE created_at >= $2) AS daily_prompts,
       coalesce(sum(input_tokens + output_tokens) FILTER (WHERE created_at >= $3), 0) AS weekly_tokens,
       count(*) FILTER (WHERE created_at >= $3) AS weekly_prompts,
       coalesce(sum(cost_usd) FILTER (WHERE created_at >= $3), 0) AS weekly_cost,
       coalesce(sum(cache_tokens) FILTER (WHERE created_at >= $3), 0) AS weekly_cache,
       coalesce(sum(input_tokens + output_tokens), 0) AS total_tokens,
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

/** Runs a model and records usage. Every call becomes a row in `runs`. */
export async function runModel(model, opts, runId) {
  const provider = PROVIDERS[model.provider];
  if (!provider) throw new Error(`Unknown provider ${model.provider}`);
  const out = await provider.run({ ...opts, model, access: provider.canEdit ? opts.access : 'read' });
  if (out.rateLimit) {
    await query(`UPDATE models SET rate_limit = $2 WHERE id = $1`, [model.id, { ...out.rateLimit, observedAt: new Date().toISOString() }]);
  }
  return out;
}

export async function recordRunUsage(runId, out) {
  if (!out) return;
  await query(
    `UPDATE runs SET input_tokens=$2, output_tokens=$3, cache_tokens=$4, cost_usd=$5, tool_calls=$6, duration_ms=$7 WHERE id=$1`,
    [runId, out.usage?.input || 0, out.usage?.output || 0, out.usage?.cache || 0, out.costUsd || 0, out.toolCalls || {}, out.durationMs || 0],
  );
}
