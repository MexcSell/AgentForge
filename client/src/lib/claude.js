// Claude models offered by the Claude Code / Anthropic API model picker in Model Manager.
// Prices are Anthropic API rates in USD per 1M tokens (Claude Code on a subscription login is billed by the plan instead).

export const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', note: 'Most capable: hardest reasoning and long agentic work', context: 1_000_000, prompt: 10, completion: 50 },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'Default: strong coding and agents', context: 1_000_000, prompt: 4, completion: 20 },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', note: 'Fast everyday coding and agents', context: 1_000_000, prompt: 2, completion: 10 },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: 'Fastest and cheapest', context: 1_000_000, prompt: 0.1, completion: 0.5 },
  { id: 'claude-fable-5', name: 'Fable 5', older: true, context: 1_000_000, prompt: 10, completion: 50 },
  { id: 'claude-opus-5', name: 'Opus 5', older: true, context: 1_000_000, prompt: 5, completion: 25 },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', older: true, context: 1_000_000, prompt: 5, completion: 25 },
  { id: 'claude-opus-4-7', name: 'Opus 4.7', older: true, context: 1_000_000, prompt: 5, completion: 25 },
  { id: 'claude-opus-4-6', name: 'Opus 4.6', older: true, context: 1_000_000, prompt: 5, completion: 25 },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', older: true, context: 1_000_000, prompt: 2, completion: 10 },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', older: true, context: 1_000_000, prompt: 3, completion: 15 },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', older: true, context: 200_000, prompt: 1, completion: 5 },
];

/** Claude Code session ids are UUIDs (the server refuses anything else). */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
