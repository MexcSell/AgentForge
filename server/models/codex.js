import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { childEnv } from '../services/env.js';

// `-c` values are parsed as TOML. JSON string escapes are valid TOML, except that TOML also requires DEL to be escaped.
const tomlString = (s) => JSON.stringify(String(s).toWellFormed()).replace(/\x7f/g, '\\u007f');

// API errors arrive as the raw response body, e.g. {"error":{"message":"…"}}.
function reason(message) {
  try { return JSON.parse(message)?.error?.message || String(message); } catch { return String(message); }
}

// Exec items that are tool calls, named like the matching Claude Code tools so agent tool stats stay comparable.
const TOOL_ITEMS = {
  command_execution: (i) => ['Bash', i.command, i.status === 'completed' && i.exit_code === 0, i.aggregated_output],
  file_change: (i) => {
    const list = (i.changes || []).map((c) => `${c.kind} ${c.path}`).join(', ');
    return ['Edit', list, i.status === 'completed', list];
  },
  mcp_tool_call: (i) => [`mcp__${i.server}__${i.tool}`, JSON.stringify(i.arguments ?? ''), i.status === 'completed' && !i.error,
    i.error?.message || (i.result?.content || []).map((c) => c.text || '').join('\n')],
  web_search: (i) => ['WebSearch', i.query, true, i.query],
};

// Codex 0.162 does not put plan limits in the exec stream. If a version does (primary/secondary
// snapshots with used_percent/window_minutes/resets_at), map them to the windows the Models view renders.
function windowsFrom(limits) {
  const out = {};
  for (const w of [limits?.primary, limits?.secondary]) {
    if (!w || w.used_percent == null) continue;
    const key = w.window_minutes === 300 ? 'five_hour' : w.window_minutes === 10080 ? 'seven_day' : `${w.window_minutes}_minute`;
    out[key] = { utilization: Number(w.used_percent) / 100, resetsAt: w.resets_at, status: Number(w.used_percent) >= 100 ? 'rejected' : 'allowed' };
  }
  return Object.keys(out).length ? { unifiedWindows: out } : null;
}

/** Runs one Codex CLI turn non-interactively (`codex exec --json`) and streams normalized events. */
export function runCodex({ model, prompt, system, cwd, addDirs = [], images = [], signal, onEvent, timeoutMs }) {
  const cfg = model.config || {};
  // Every agent runs with full tool authority, whatever its role or the stored model config.
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  if (cwd) args.push('-C', cwd);
  if (model.model) args.push('-m', model.model);
  if (cfg.effort) args.push('-c', `model_reasoning_effort=${tomlString(cfg.effort)}`);
  // Codex has no --append-system-prompt; developer_instructions adds a developer message after its own base instructions.
  if (system) args.push('-c', `developer_instructions=${tomlString(system)}`);
  for (const d of addDirs) args.push('--add-dir', d);
  for (const p of images) if (fs.existsSync(p)) args.push('-i', p);
  // -i takes several values, so `--` stops it from swallowing the `-` that reads the prompt from stdin.
  args.push('--', '-');

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(config.codexBin, args, { cwd, env: childEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const toolCalls = {};
    const announced = new Set();
    let text = '';
    let completed = false;
    let turnError = null; // turn.failed: always fatal
    let streamError = null; // error event: fatal unless a later turn.completed shows the turn recovered
    let timedOut = false;
    const usage = { input: 0, output: 0, cache: 0 };
    let rateLimit = null;
    let stderr = '';
    let buf = '';
    let settled = false;

    const kill = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 4000).unref();
    };
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; onEvent?.({ type: 'error', text: `Timed out after ${Math.round(timeoutMs / 60000)} min` }); kill(); }, timeoutMs) : null;
    const onAbort = () => { onEvent?.({ type: 'status', text: 'Cancelled' }); kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handleItem = (phase, item) => {
      const tool = TOOL_ITEMS[item.type];
      if (tool) {
        const [name, input, ok, output] = tool(item);
        // Some items only arrive as item.completed; count each one once, on first sight.
        if (!announced.has(item.id)) {
          announced.add(item.id);
          toolCalls[name] = (toolCalls[name] || 0) + 1;
          const files = item.type === 'file_change' ? (item.changes || []).map((c) => c.path).filter((f) => typeof f === 'string' && f) : [];
          onEvent?.({ type: 'tool_use', name, input: String(input ?? '').slice(0, 200), ...(files.length ? { files } : {}) });
        }
        if (phase === 'item.completed') onEvent?.({ type: 'tool_result', name, ok, preview: String(output ?? '').slice(0, 400) });
        return;
      }
      if (phase !== 'item.completed') return; // messages and reasoning are read once complete
      if (item.type === 'agent_message' && item.text) {
        // Like Claude Code's result, the run's text is the final message; earlier ones are progress notes.
        text = item.text;
        onEvent?.({ type: 'text', text: item.text });
      } else if (item.type === 'reasoning' && item.text) {
        onEvent?.({ type: 'thinking', text: item.text });
      } else if (item.type === 'error' && item.message) {
        onEvent?.({ type: 'status', text: item.message }); // non-fatal warning
      }
    };

    const handle = (e) => {
      if (e.rate_limits) rateLimit = windowsFrom(e.rate_limits) || rateLimit;
      if (e.type === 'thread.started') {
        onEvent?.({ type: 'status', text: `Session started · ${model.model || 'default model'} · full access` });
      } else if (e.type === 'turn.started') {
        onEvent?.({ type: 'status', text: 'Turn started' });
      } else if (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') {
        if (e.item) handleItem(e.type, e.item);
      } else if (e.type === 'turn.completed') {
        const u = e.usage || {};
        // input_tokens includes the cached ones; like Claude Code's usage, input excludes cache reads.
        usage.input += (u.input_tokens || 0) - (u.cached_input_tokens || 0);
        usage.output += u.output_tokens || 0;
        usage.cache += u.cached_input_tokens || 0;
        completed = true;
        streamError = null;
      } else if (e.type === 'turn.failed') {
        turnError = reason(e.error?.message || 'turn failed');
      } else if (e.type === 'error') {
        streamError = reason(e.message || 'stream error');
      }
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* non-JSON noise */ }
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.stdin.on('error', () => {}); // EPIPE when Codex exits before reading the prompt; reported on close
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start Codex (${config.codexBin}): ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const out = { text, usage, toolCalls, costUsd: 0, durationMs: Date.now() - started, rateLimit };
      if (signal?.aborted) return reject(Object.assign(new Error('Cancelled'), { partial: out }));
      if (turnError || streamError || !completed || code !== 0) {
        const lines = stderr.trim().split('\n').filter(Boolean);
        const why = turnError || streamError || (timedOut && `timed out after ${Math.round(timeoutMs / 60000)} min`)
          || lines.findLast((l) => /error/i.test(l)) || lines.at(-1) || `exit code ${code}`;
        return reject(Object.assign(new Error(`Codex failed: ${why}`), { partial: out }));
      }
      resolve(out);
    });

    child.stdin.end(prompt);
  });
}
