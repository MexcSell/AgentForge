// Environment for child processes (agents, terminals): drop variables that belong
// to whatever Claude Code session launched this server.
const KEEP = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_BIN']);

export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (KEEP.has(k)) { env[k] = v; continue; }
    if (/^(CLAUDE|AI_AGENT$|MCP_CONNECTION|AF_|SUPERVISOR)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}
