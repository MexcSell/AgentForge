import { one, many, query } from './pool.js';
import { config } from '../config.js';
import { ROLES } from '../roles.js';

export const DEFAULT_SETTINGS = {
  orchestrator: { maxParallel: 3, taskTimeoutMin: 30, autoApproveProposals: false, proposalTriage: true, verification: true, retryFailed: true },
  github: { autoSync: true, userName: config.github.userName, userEmail: config.github.userEmail, branch: 'main' },
  evolution: { enabled: true, playbookSize: 8, lessonsPerVersion: 4 },
  monitor: { enabled: true, intervalSec: 3 },
};

// Host-metrics status bar: boolean switch + redraw interval clamped to 1–60 s. Bad input keeps `base`.
export function sanitizeMonitor(value, base = DEFAULT_SETTINGS.monitor) {
  const v = value && typeof value === 'object' ? value : {};
  const enabled = v.enabled === undefined ? base.enabled !== false
    : typeof v.enabled === 'string' ? !/^(false|0|off|no|)$/i.test(v.enabled.trim()) : Boolean(v.enabled);
  const n = v.intervalSec === null || v.intervalSec === '' ? NaN : Number(v.intervalSec);
  const intervalSec = Math.min(60, Math.max(1, Math.round(Number.isFinite(n) ? n : Number(base.intervalSec) || DEFAULT_SETTINGS.monitor.intervalSec)));
  return { enabled, intervalSec };
}

const DEFAULT_LIMITS = { dailyTokens: 2_000_000, weeklyTokens: 10_000_000, dailyPrompts: 400, weeklyPrompts: 2000, resetHour: 0, weeklyResetDay: 1 };

const MODELS = [
  { id: 'claude-code-opus', name: 'Claude Code · Opus 5.5', provider: 'claude-code', model: 'claude-opus-5-5', is_default: true },
  { id: 'claude-code-sonnet', name: 'Claude Code · Sonnet 5.5', provider: 'claude-code', model: 'claude-sonnet-5-5' },
  { id: 'claude-code-haiku', name: 'Claude Code · Haiku 5.5', provider: 'claude-code', model: 'claude-haiku-5-5' },
  { id: 'codex-gpt-6-luna', name: 'Codex · GPT-6 Luna', provider: 'codex', model: 'gpt-6-luna' },
  // Enabled only if OPENAI_API_KEY is set on first seed; otherwise add a key and enable it in Model Manager.
  { id: 'gpt-6-luna', name: 'GPT · GPT-6 Luna', provider: 'gpt', model: 'gpt-6-luna', enabled: !!process.env.OPENAI_API_KEY },
  { id: 'simulator', name: 'Simulator (offline)', provider: 'simulator', model: 'sim-1', limits: { ...DEFAULT_LIMITS, dailyTokens: 0, weeklyTokens: 0 } },
];

// [name, role, supervisor, skills{name:level}, mission, model]
const AGENTS = [
  ['AgentForge Agent', 'executive', null, { strategy: 80, prioritization: 78, risk: 70 }, 'Sets objectives and priorities across every project.'],
  ['Darwin', 'evolution', 'AgentForge Agent', { 'org-design': 75, evaluation: 72, experimentation: 70 }, 'Improves the agent organization: roles, playbooks and team structure.'],
  ['Archer', 'architect', 'AgentForge Agent', { 'system-design': 85, 'api-design': 80, adr: 70 }, 'Owns architecture, standards and technical decisions.'],
  ['Lens', 'reviewer', 'AgentForge Agent', { 'code-review': 82, standards: 78 }, 'Independently verifies work. Never reports to the authors it reviews.'],
  ['Scout', 'research', 'AgentForge Agent', { research: 80, analysis: 75, comparison: 72 }, 'Researches technologies, options and prior art.'],
  ['Pixel', 'frontend', 'Archer', { react: 85, css: 82, typescript: 75, accessibility: 60 }, 'Builds fast, accessible, beautiful interfaces.'],
  ['Kernel', 'backend', 'Archer', { node: 86, fastify: 76, rest: 80, postgres: 70 }, 'Builds reliable APIs and services.'],
  ['Iris', 'designer', 'Archer', { ux: 85, ui: 86, 'design-systems': 76 }, 'Designs flows, layouts and visual systems.'],
  ['Ledger', 'data', 'Archer', { postgres: 86, sql: 85, migrations: 74 }, 'Designs schemas, queries and migrations.'],
  ['Harbor', 'devops', 'Archer', { linux: 82, git: 80, ci: 74, docker: 72 }, 'Automates builds, deploys and safe restarts.'],
  ['Quill', 'docs', 'Archer', { markdown: 82, documentation: 80 }, 'Keeps documentation accurate and current.'],
  ['Probe', 'qa', 'Lens', { testing: 82, e2e: 68, regression: 72 }, 'Proves features work with tests and evidence.'],
  ['Sentinel', 'security', 'Lens', { owasp: 76, 'threat-modeling': 70, secrets: 78 }, 'Finds vulnerabilities and unsafe patterns.'],
  ['Gauge', 'analyst', 'Darwin', { metrics: 80, diagnosis: 74 }, 'Measures agent performance and finds recurring failures.'],
  ['Muse', 'optimizer', 'Darwin', { prompting: 80, playbooks: 76 }, 'Turns lessons into versioned playbooks.'],
];

export async function seed() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(`INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, value]);
  }

  for (const m of MODELS) {
    await query(
      `INSERT INTO models(id, name, provider, model, is_default, enabled, limits, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [m.id, m.name, m.provider, m.model, !!m.is_default, m.enabled ?? true, m.limits || DEFAULT_LIMITS,
        m.provider === 'claude-code' || m.provider === 'codex' ? { effort: '' } : {}],
    );
  }

  const existing = await one(`SELECT count(*)::int AS n FROM agents`);
  if (existing.n === 0) {
    const ids = {};
    for (const [name, role, sup, skills, mission] of AGENTS) {
      const r = ROLES[role];
      const row = await one(
        `INSERT INTO agents(name, role, title, tier, department, skills, supervisor_id, mission, purpose, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'seed') RETURNING id`,
        [name, role, r.title, r.tier, r.department, JSON.stringify(Object.entries(skills).map(([n, level]) => ({ name: n, level }))),
          sup ? ids[sup] : null, mission, `Deliver verified ${r.department.toLowerCase()} outcomes for every project.`],
      );
      ids[name] = row.id;
    }
  }

  // The AgentForge platform itself is a protected, undeletable project, run by the executive as its GM.
  const { executiveId } = await import('../services/agents.js');
  const core = await one(`SELECT id FROM projects WHERE protected = true LIMIT 1`);
  if (!core) {
    const { createProjectRecord } = await import('../services/projects.js');
    await createProjectRecord({
      name: 'AgentForge',
      path: config.root,
      github_url: config.github.url,
      description: 'Develop the AgentForge platform itself. Every completed change is pushed to GitHub and the service restarts safely.',
      protected: true,
      manager_id: await executiveId(),
    });
  } else if (!config.candidate) {
    await adoptCoreProject(core.id, await executiveId());
  }
  // Project GMs are clones of one original manager; make sure it exists. Not on a candidate boot, like the adoption.
  if (!config.candidate) await (await import('../services/projects.js')).originalManager();
}

/**
 * Make the executive the GM of the protected project (id). The GM it replaces is retired like a deleted project's GM:
 * archived with its history, reports moved to the executive, pending work handed over. Skipped on a health-check
 * candidate boot, which runs beside the live server and its missions; a real boot runs after the old process is gone.
 */
async function adoptCoreProject(id, exec) {
  const core = await one(`SELECT id, name, manager_id FROM projects WHERE id = $1`, [id]);
  if (!exec || !core || core.manager_id === exec) return;
  const { retireAgent, refreshAgentStatus } = await import('../services/agents.js');
  const { publishProject } = await import('../services/projects.js');
  const { handOver } = await import('../orchestrator/engine.js');
  const { audit } = await import('../services/notify.js');
  const { emit } = await import('../events.js');
  await query(`UPDATE projects SET manager_id = $2, updated_at = now() WHERE id = $1`, [core.id, exec]);
  const old = core.manager_id && (await one(`SELECT id, name FROM agents WHERE id = $1 AND NOT archived`, [core.manager_id]));
  // retireAgent refuses an executive; a GM that still runs another project keeps working there.
  const retired = old && !(await one(`SELECT 1 FROM projects WHERE manager_id = $1`, [old.id])) && (await retireAgent(old.id, exec));
  if (retired) {
    emit('agent:delete', { id: old.id });
    await handOver(old.id).catch((e) => console.error('[handover]', e.message));
  } else if (old) {
    await refreshAgentStatus(old.id).catch(() => {});
  }
  await refreshAgentStatus(exec).catch(() => {});
  await publishProject(core.id).catch(() => {});
  await audit('system', 'project.manager', core.name, { from: old?.id || null, fromName: old?.name || null, to: exec, retired: !!retired });
}

export async function getSettings() {
  const rows = await many(`SELECT key, value FROM settings`);
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) out[r.key] = { ...(out[r.key] || {}), ...r.value };
  return out;
}
