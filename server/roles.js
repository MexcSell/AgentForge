// Role catalog for the Hierarchical Evolutionary Agent Organization (HEAO).
// access: 'write' agents may edit project files, 'read' agents inspect and report.

export const TIERS = {
  1: 'Executive Intelligence',
  2: 'Management & Orchestration',
  3: 'Specialist Teams',
  4: 'Independent Verification',
  5: 'Self-Evolution',
};

export const ROLES = {
  executive: { title: 'Executive Director', tier: 1, department: 'Executive', access: 'read', skills: ['strategy', 'prioritization', 'risk'] },
  evolution: { title: 'Evolution Director', tier: 1, department: 'Evolution', access: 'read', skills: ['org-design', 'evaluation', 'experimentation'] },
  manager: { title: 'General Manager', tier: 2, department: 'Management', access: 'read', skills: ['planning', 'decomposition', 'coordination'] },
  architect: { title: 'Chief Architect', tier: 2, department: 'Architecture', access: 'write', skills: ['system-design', 'api-design', 'adr'] },
  frontend: { title: 'Frontend Engineer', tier: 3, department: 'Engineering', access: 'write', skills: ['react', 'css', 'typescript', 'accessibility'] },
  backend: { title: 'Backend Engineer', tier: 3, department: 'Engineering', access: 'write', skills: ['node', 'fastify', 'rest', 'postgres'] },
  fullstack: { title: 'Full-stack Developer', tier: 3, department: 'Engineering', access: 'write', skills: ['react', 'node', 'sql'] },
  designer: { title: 'UI/UX Designer', tier: 3, department: 'Design', access: 'write', skills: ['ux', 'ui', 'design-systems'] },
  data: { title: 'Database Engineer', tier: 3, department: 'Engineering', access: 'write', skills: ['postgres', 'sql', 'migrations'] },
  ai: { title: 'AI Engineer', tier: 3, department: 'Engineering', access: 'write', skills: ['llm', 'prompting', 'agents'] },
  devops: { title: 'DevOps Engineer', tier: 3, department: 'Operations', access: 'write', skills: ['linux', 'git', 'ci', 'docker'] },
  research: { title: 'Research Analyst', tier: 3, department: 'Research', access: 'read', skills: ['research', 'analysis', 'comparison'] },
  docs: { title: 'Technical Writer', tier: 3, department: 'Product', access: 'write', skills: ['markdown', 'documentation'] },
  qa: { title: 'QA Engineer', tier: 4, department: 'Verification', access: 'write', skills: ['testing', 'e2e', 'regression'] },
  security: { title: 'Security Auditor', tier: 4, department: 'Verification', access: 'read', skills: ['owasp', 'threat-modeling', 'secrets'] },
  reviewer: { title: 'Independent Code Reviewer', tier: 4, department: 'Verification', access: 'read', skills: ['code-review', 'standards'] },
  analyst: { title: 'Performance Analyst', tier: 5, department: 'Evolution', access: 'read', skills: ['metrics', 'diagnosis'] },
  optimizer: { title: 'Prompt Optimizer', tier: 5, department: 'Evolution', access: 'read', skills: ['prompting', 'playbooks'] },
};

// Fuzzy role matching for planner output ("Frontend Developer" -> frontend).
// Order matters: the most specific discipline wins ("security tester" -> security).
const ALIASES = [
  [/full.?stack/i, 'fullstack'],
  [/secur|\baudit/i, 'security'],
  [/\bqa\b|test|quality/i, 'qa'],
  [/review/i, 'reviewer'],
  [/front|\bui\b|react|web dev/i, 'frontend'],
  [/back|\bapi\b|server|\bnode/i, 'backend'],
  [/design|\bux\b|visual/i, 'designer'],
  [/data(base)?\b|\bsql|postgres|schema/i, 'data'],
  [/\bml\b|\bai\b|llm|prompt eng/i, 'ai'],
  [/devops|deploy|infra|\bops\b|\bci\b|release/i, 'devops'],
  [/research|investigat/i, 'research'],
  [/\bdocs?\b|documentation|writer|readme/i, 'docs'],
  [/architect|\bcto\b/i, 'architect'],
  [/manag|\bpm\b|coordinat/i, 'manager'],
  [/engineer|develop|\bdev\b|coder|programmer|implement/i, 'fullstack'],
];

export function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (ROLES[r]) return r;
  for (const [re, key] of ALIASES) if (re.test(r)) return key;
  return r.replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'fullstack';
}

export function roleInfo(role) {
  return ROLES[role] || { title: role.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase()) + ' Specialist', tier: 3, department: 'Specialists', access: 'write', skills: [role] };
}

export const CODENAMES = [
  'Orion', 'Nova', 'Vega', 'Lyra', 'Rigel', 'Juno', 'Echo', 'Cosmo', 'Aria', 'Sirius', 'Altair', 'Cygnus', 'Draco', 'Electra', 'Fenix',
  'Halo', 'Ion', 'Jett', 'Kepler', 'Luna', 'Mira', 'Nebula', 'Onyx', 'Pulsar', 'Quasar', 'Rhea', 'Sol', 'Titan', 'Umbra', 'Vesper',
  'Wren', 'Xenon', 'Yara', 'Zephyr', 'Apollo', 'Bolt', 'Cipher', 'Delta', 'Ember', 'Flux', 'Glint', 'Helix', 'Indigo', 'Jade', 'Koda',
  'Lumen', 'Matrix', 'Nyx', 'Opal', 'Prism', 'Quill', 'Raven', 'Sage', 'Tesla', 'Unity', 'Volt', 'Wave', 'Zen', 'Astra', 'Blaze',
];
