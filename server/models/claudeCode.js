import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { childEnv } from '../services/env.js';

function brief(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.path || input.command || input.pattern || input.url || input.description || '';
  return String(v).slice(0, 200);
}

// Tools that write files; their events carry `files` so a mission's edits can be committed on their own.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Runs one Claude Code turn non-interactively and streams normalized events.
 * tools: null = Claude Code's default set, '' = no tools (a plain answer), or a comma list such as 'Read,Grep,Glob'.
 * resume: a session id to continue (warm context, like the next message in an editor session); a session the CLI no
 * longer has falls back to a fresh run with freshPrompt (default: prompt). persist: keep the session on disk so a later run can resume it.
 */
export function runClaudeCode(opts) {
  return runOnce(opts).catch((err) => {
    if (!opts.resume || !err.resumeMissing || opts.signal?.aborted) throw err;
    opts.onEvent?.({ type: 'status', text: 'Previous session not found · starting fresh' });
    return runOnce({ ...opts, resume: null, prompt: opts.freshPrompt ?? opts.prompt });
  });
}

function runOnce({ model, prompt, system, cwd, addDirs = [], signal, onEvent, timeoutMs, tools = null, resume = null, persist = false }) {
  const cfg = model.config || {};
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', resume);
  else if (!persist) args.push('--no-session-persistence');
  if (model.model) args.push('--model', model.model);
  if (cfg.effort) args.push('--effort', cfg.effort);
  if (cfg.maxBudgetUsd) args.push('--max-budget-usd', String(cfg.maxBudgetUsd));
  if (system) args.push('--append-system-prompt', system);
  // A tool-less run needs no MCP servers either: their tool schemas and connection time would be wasted.
  if (tools !== null) args.push('--tools', tools, ...(tools ? [] : ['--strict-mcp-config']));
  // Every agent runs with full tool authority, whatever its role or the stored model config.
  args.push('--permission-mode', 'bypassPermissions');
  for (const d of addDirs) args.push('--add-dir', d);

  return new Promise((resolve, reject) => {
    const started = Date.now();
    // The service runs as root; Claude Code refuses bypassPermissions as uid 0 unless IS_SANDBOX=1.
    const child = spawn(config.claudeBin, args, { cwd, env: childEnv({ IS_SANDBOX: '1' }), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const toolCalls = {};
    const toolNames = {};
    let text = '';
    let final = null;
    let rateLimit = null;
    let sessionId = null;
    let contextTokens = 0; // prompt size of the last model call: what a resume of this session starts from
    let stderr = '';
    let buf = '';
    let settled = false;

    const kill = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 4000).unref();
    };
    const timer = timeoutMs ? setTimeout(() => { onEvent?.({ type: 'error', text: `Timed out after ${Math.round(timeoutMs / 60000)} min` }); kill(); }, timeoutMs) : null;
    const onAbort = () => { onEvent?.({ type: 'status', text: 'Cancelled' }); kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handle = (e) => {
      if (e.type === 'system' && e.subtype === 'init') {
        sessionId = e.session_id || null;
        onEvent?.({ type: 'status', text: `Session ${resume ? 'resumed' : 'started'} · ${e.model} · ${e.permissionMode}` });
      } else if (e.type === 'rate_limit_event') {
        rateLimit = e.rate_limit_info || null;
      } else if (e.type === 'assistant') {
        const u = e.message?.usage;
        if (u && !e.parent_tool_use_id) contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        for (const b of e.message?.content || []) {
          if (b.type === 'text' && b.text) { text += (text ? '\n' : '') + b.text; onEvent?.({ type: 'text', text: b.text }); }
          else if (b.type === 'thinking' && b.thinking) onEvent?.({ type: 'thinking', text: b.thinking });
          else if (b.type === 'tool_use') {
            toolCalls[b.name] = (toolCalls[b.name] || 0) + 1;
            toolNames[b.id] = b.name;
            const file = EDIT_TOOLS.has(b.name) && (b.input?.file_path || b.input?.notebook_path);
            onEvent?.({ type: 'tool_use', name: b.name, input: brief(b.input), ...(typeof file === 'string' && file ? { files: [file] } : {}) });
          }
        }
      } else if (e.type === 'user') {
        const content = e.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type !== 'tool_result') continue;
            const raw = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : String(b.content ?? '');
            onEvent?.({ type: 'tool_result', name: toolNames[b.tool_use_id], ok: !b.is_error, preview: raw.slice(0, 400) });
          }
        }
      } else if (e.type === 'result') {
        final = e;
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
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start Claude Code (${config.claudeBin}): ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const u = final?.usage || {};
      const out = {
        text: final?.result ?? text,
        usage: {
          input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          output: u.output_tokens || 0,
          cache: u.cache_read_input_tokens || 0,
        },
        toolCalls,
        costUsd: final?.total_cost_usd || 0,
        durationMs: final?.duration_ms || Date.now() - started,
        rateLimit,
        sessionId,
        contextTokens,
      };
      if (signal?.aborted) return reject(Object.assign(new Error('Cancelled'), { partial: out }));
      // --resume of a session the CLI no longer has: an error result before any init event, nothing ran.
      if (resume && !sessionId && final?.is_error && !final.num_turns) {
        return reject(Object.assign(new Error('Claude Code session not found'), { partial: out, resumeMissing: true }));
      }
      if (!final || final.is_error) {
        const why = final?.subtype && final.subtype !== 'success' ? final.subtype : (stderr.trim().split('\n').pop() || `exit code ${code}`);
        return reject(Object.assign(new Error(`Claude Code failed: ${why}`), { partial: out }));
      }
      resolve(out);
    });

    child.stdin.end(prompt);
  });
}
