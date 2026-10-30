import { heuristicPlan } from '../orchestrator/heuristics.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Cancelled')); }, { once: true });
});

const STEPS = {
  frontend: [['Glob', 'client/src/**/*.jsx'], ['Read', 'client/src/App.jsx'], ['Edit', 'client/src/views/…'], ['Bash', 'npm run build']],
  backend: [['Grep', 'route'], ['Read', 'server/index.js'], ['Edit', 'server/routes/…'], ['Bash', 'node --check server/index.js']],
  qa: [['Glob', '**/*.test.*'], ['Write', 'tests/feature.test.js'], ['Bash', 'npm test']],
  default: [['Glob', '**/*'], ['Read', 'README.md'], ['Grep', 'TODO']],
};

/** Offline provider: deterministic, free, clearly labelled. Never touches files. */
export async function runSimulator({ prompt, meta = {}, signal, onEvent }) {
  const started = Date.now();
  const toolCalls = {};
  let text;
  if (meta.kind === 'plan') {
    onEvent?.({ type: 'thinking', text: 'Analyzing the command and the agent registry…' });
    await sleep(900, signal);
    text = '```json\n' + JSON.stringify(heuristicPlan(meta.command), null, 2) + '\n```';
  } else {
    const steps = STEPS[meta.role] || STEPS.default;
    onEvent?.({ type: 'thinking', text: `Reading the task contract for "${meta.title}"…` });
    for (const [tool, input] of steps) {
      await sleep(700 + Math.random() * 900, signal);
      toolCalls[tool] = (toolCalls[tool] || 0) + 1;
      onEvent?.({ type: 'tool_use', name: tool, input: `${input} (simulated)` });
      onEvent?.({ type: 'tool_result', name: tool, ok: true, preview: 'ok (simulated)' });
    }
    const report = {
      status: 'done',
      summary: `[Simulated] Completed "${meta.title}". Switch the agent to a Claude Code model to perform real work.`,
      artifacts: [],
      lesson: `For ${meta.role} tasks, confirm acceptance criteria before editing files.`,
      proposals: [],
      confidence: 0.5,
    };
    text = `Work finished (simulation).\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``;
    onEvent?.({ type: 'text', text });
  }
  const input = Math.ceil(prompt.length / 4);
  return { text, usage: { input, output: Math.ceil(text.length / 4), cache: 0 }, toolCalls, costUsd: 0, durationMs: Date.now() - started };
}
