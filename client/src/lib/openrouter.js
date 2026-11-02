// OpenRouter catalog helpers for the Model Manager picker (rows from GET /api/openrouter/models).

export const SORTS = {
  free: 'Free first, then cheapest',
  cheap: 'Cheapest first',
  pricey: 'Most expensive first',
  newest: 'Newest first',
  context: 'Largest context first',
  name: 'Name (A–Z)',
};

/** Blended USD per 1M tokens (input + output) used for the cost ranking; Infinity for routers with a variable price. */
export const blended = (m) => (m.variable ? Infinity : (m.prompt || 0) + (m.completion || 0));

const byName = (a, b) => a.name.localeCompare(b.name);
// Variable-price routers have no cost to rank: they go last in both price orders.
const byCost = (dir) => (a, b) => {
  if (a.variable !== b.variable) return a.variable ? 1 : -1;
  return dir * (blended(a) - blended(b)) || byName(a, b);
};
const COMPARE = {
  free: (a, b) => (b.free - a.free) || byCost(1)(a, b),
  cheap: byCost(1),
  pricey: byCost(-1),
  newest: (a, b) => (b.created - a.created) || byName(a, b),
  context: (a, b) => (b.context - a.context) || byName(a, b),
  name: byName,
};

/** Filters by free-only and a search over id, name and aliases (every word must match), then sorts. */
export function pickList(models, { query = '', freeOnly = false, sort = 'free' } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models
    .filter((m) => (!freeOnly || m.free) && words.every((w) => [m.id, m.name, ...(m.aliases || [])].some((s) => s.toLowerCase().includes(w))))
    .sort(COMPARE[sort] || COMPARE.free);
}

/** "$0.15", "$12", "free" or "varies" for a price per 1M tokens. */
export function perM(v, variable) {
  if (variable || v == null) return 'varies';
  if (v === 0) return 'free';
  return `$${v < 0.01 ? Number(v.toPrecision(2)) : v < 10 ? Number(v.toFixed(2)) : Math.round(v)}`;
}

/** "128K" / "1M" context window. */
export const ctx = (n) => (!n ? '—' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
