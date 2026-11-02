// Environment for child processes (agents, terminals): drop variables that belong
// to whatever Claude Code session launched this server, and the OpenRouter, Groq, Mistral, Cohere and SambaNova keys (only the server calls them).
const KEEP = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_BIN']);

export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (KEEP.has(k)) { env[k] = v; continue; }
    if (/^(CLAUDE|AI_AGENT$|MCP_CONNECTION|AF_|SUPERVISOR|OPENROUTER_API_KEY$|GROQ_API_KEY$|MISTRAL_API_KEY$|COHERE_API_KEY$|SAMBANOVA_API_KEY$)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}
