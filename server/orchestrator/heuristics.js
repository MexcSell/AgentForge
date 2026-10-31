// Keyword-based planner: used by the offline simulator and as a fallback when a
// model's plan cannot be parsed. Produces the same JSON shape as the model planner.

const RULES = [
  { role: 'research', re: /research|investigat|compare|evaluate options|benchmark|analy[sz]e/i, title: 'Research options and constraints', skills: ['research'] },
  { role: 'designer', re: /design|ux|ui\b|layout|theme|look|style|beautiful|aesthetic|icon/i, title: 'Design the user flow and visual spec', skills: ['ux', 'ui'] },
  { role: 'data', re: /database|schema|table|migration|sql|postgres|index/i, title: 'Design and migrate the data model', skills: ['postgres', 'sql'] },
  { role: 'backend', re: /api|endpoint|server|backend|service|auth|webhook|route/i, title: 'Implement the backend changes', skills: ['node', 'rest'] },
  { role: 'frontend', re: /page|screen|button|component|frontend|react|ui\b|view|modal|dialog|form|dashboard/i, title: 'Implement the frontend changes', skills: ['react', 'css'] },
  { role: 'devops', re: /deploy|docker|ci\b|pipeline|restart|build|infra|server setup/i, title: 'Update build, deploy and restart automation', skills: ['ci', 'linux'] },
  { role: 'security', re: /secur|vulnerab|auth|permission|secret|xss|csrf|injection/i, title: 'Security review of the change', skills: ['owasp'] },
  { role: 'docs', re: /doc|readme|guide|explain|changelog/i, title: 'Update documentation', skills: ['markdown'] },
  { role: 'qa', re: /test|bug|fix|qa|regress|broken|error|crash/i, title: 'Write and run tests for the change', skills: ['testing'] },
];

const CONVERSATIONAL = /^(hi|hello|hey|thanks|thank you|status|what('?s| is) (the )?status|who are you|help)\b/i;

// Filler words a keyword title drops. schema.sql's topic-keywords backfill uses the same list.
const STOPWORDS = new Set(('a an the and or but nor so of to in on at by for from with without into onto over under about as is are was were be been '
  + 'being am do does did has have had it its this that these those there here what which who whom whose when where why how i me my we our '
  + 'you your he she they them their please can could should would will shall may might must just also only very too then than not no '
  + 'all any some more most each every make let lets get show add use new now up out off via vs').split(' '));

/** Topic title fallback: at most 3 key words and 28 chars, stopwords and edge punctuation dropped. */
export function topicTitle(text) {
  const words = String(text || '').split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  const keys = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const picked = (keys.length ? keys : words).slice(0, 3);
  while (picked.length > 1 && picked.join(' ').length > 28) picked.pop();
  return picked.join(' ').slice(0, 28).trim();
}

/** Topic summary fallback: the order's first 240 chars, cut at a word. */
export function topicSummary(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 240) return t;
  return `${t.slice(0, 239).replace(/\s+\S*$/, '')}…`;
}

export function heuristicPlan(command) {
  const text = String(command || '').trim();
  if (!text || (CONVERSATIONAL.test(text) && text.length < 60)) {
    return { analysis: 'Conversational message; no work required.', reply: 'Ready. Give me a goal and I will break it down, staff it and report back.', topic: { title: topicTitle(text), tags: ['chat'], new: false }, tasks: [] };
  }
  const hits = RULES.filter((r) => r.re.test(text));
  const tasks = [];
  const keyOf = (role) => tasks.find((t) => t.role === role)?.key;
  const push = (t) => { t.key = `T${tasks.length + 1}`; tasks.push(t); return t.key; };

  const goal = text.length > 90 ? `${text.slice(0, 87)}…` : text;
  for (const r of hits.filter((h) => ['research', 'designer', 'data'].includes(h.role))) {
    push({ title: r.title, role: r.role, skills: r.skills, description: `${r.title} for: ${goal}`, acceptance: ['Written output attached to the task report'], depends_on: [] });
  }
  const upstream = tasks.map((t) => t.key);
  const builders = hits.filter((h) => ['backend', 'frontend', 'devops', 'docs'].includes(h.role));
  if (!builders.length && !hits.some((h) => h.role === 'qa')) builders.push({ role: 'fullstack', title: 'Implement the requested change', skills: ['react', 'node'] });
  for (const r of builders) {
    const deps = [...upstream];
    if (r.role === 'frontend' && keyOf('backend')) deps.push(keyOf('backend'));
    push({ title: r.title, role: r.role, skills: r.skills, description: `${r.title} for: ${goal}`, acceptance: ['Change implemented', 'Existing behaviour not broken'], depends_on: deps });
  }
  const built = tasks.map((t) => t.key);
  if (hits.some((h) => h.role === 'qa') || builders.length) {
    push({ title: 'Write and run tests', role: 'qa', skills: ['testing'], description: `Verify: ${goal}`, acceptance: ['Tests cover the change', 'All tests pass'], depends_on: built });
  }
  if (hits.some((h) => h.role === 'security')) {
    push({ title: 'Security review of the change', role: 'security', skills: ['owasp'], description: `Audit: ${goal}`, acceptance: ['No high-severity findings left open'], depends_on: built });
  }
  push({ title: 'Independent verification', role: 'reviewer', skills: ['code-review'], description: `Independently verify the result of: ${goal}`, acceptance: ['Acceptance criteria of every task checked'], depends_on: tasks.map((t) => t.key) });

  const roles = [...new Set(tasks.map((t) => t.role))];
  return { analysis: `Detected areas: ${roles.join(', ')}.`, topic: { title: topicTitle(text), tags: roles.filter((r) => !['qa', 'reviewer'].includes(r)).slice(0, 3), new: false }, tasks };
}
