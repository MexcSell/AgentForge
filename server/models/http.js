import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function loadImages(images = []) {
  return images
    .filter((p) => MIME[path.extname(p).toLowerCase()] && fs.existsSync(p))
    .map((p) => ({ mime: MIME[path.extname(p).toLowerCase()], data: fs.readFileSync(p).toString('base64') }));
}

async function post(url, headers, body, signal) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error?.message || json.error || res.statusText}`);
  return json;
}

/** Anthropic Messages API (text-only agents: they report, they do not edit files). */
export async function runAnthropic({ model, prompt, system, images, signal, onEvent }) {
  const key = model.api_key || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('No API key configured for this model (set it in Model Manager or ANTHROPIC_API_KEY).');
  const started = Date.now();
  const content = [
    ...loadImages(images).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
    { type: 'text', text: prompt },
  ];
  onEvent?.({ type: 'status', text: `Calling ${model.model}` });
  const json = await post(`${(model.base_url || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`,
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model: model.model, max_tokens: model.config?.maxTokens || 8192, system: system || undefined, messages: [{ role: 'user', content }] },
    signal);
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  onEvent?.({ type: 'text', text });
  return {
    text,
    usage: { input: json.usage?.input_tokens || 0, output: json.usage?.output_tokens || 0, cache: json.usage?.cache_read_input_tokens || 0 },
    toolCalls: {},
    costUsd: 0,
    durationMs: Date.now() - started,
  };
}

/** OpenAI's own API for GPT models: the OpenAI-compatible call, with the key falling back to OPENAI_API_KEY. */
export async function runGpt(opts) {
  const key = opts.model.api_key || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('No API key configured for this model (set it in Model Manager or OPENAI_API_KEY).');
  return runOpenAI({ ...opts, model: { ...opts.model, api_key: key } });
}

/** Any OpenAI-compatible /chat/completions endpoint (OpenAI, Ollama, llama.cpp, vLLM, OpenRouter...). */
export async function runOpenAI({ model, prompt, system, images, signal, onEvent }) {
  const started = Date.now();
  const base = (model.base_url || 'https://api.openai.com/v1').replace(/\/$/, '');
  const content = [{ type: 'text', text: prompt }, ...loadImages(images).map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))];
  onEvent?.({ type: 'status', text: `Calling ${model.model} @ ${base}` });
  const json = await post(`${base}/chat/completions`, model.api_key ? { authorization: `Bearer ${model.api_key}` } : {},
    { model: model.model, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: images?.length ? content : prompt }] },
    signal);
  const text = json.choices?.[0]?.message?.content || '';
  onEvent?.({ type: 'text', text });
  return {
    text,
    usage: { input: json.usage?.prompt_tokens || 0, output: json.usage?.completion_tokens || 0, cache: 0 },
    toolCalls: {},
    costUsd: 0,
    durationMs: Date.now() - started,
  };
}
