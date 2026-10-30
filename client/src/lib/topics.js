// Topic threads: tag normalisation, deterministic tag tones and the /new parser (docs/design/topics.md §2, §6).

export const TAG_TONES = ['info', 'ok', 'warn', 'neutral'];
export const MAX_TAGS = 5;
export const MAX_TITLE = 120;

// Identical to normalizeTags() in server/services/topics.js, so client and server agree on the stored tag.
export const normTag = (t) => String(t).trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 24);

export function tagTone(tag) {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (const ch of normTag(tag)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; // avalanche, so short tags spread evenly
  return TAG_TONES[(h >>> 0) % TAG_TONES.length];
}

export const TAG_CLS = {
  info: 'bg-info-soft text-info-ink',
  ok: 'bg-ok-soft text-ok-ink',
  warn: 'bg-warn-soft text-warn-ink',
  neutral: 'bg-hover text-muted ring-1 ring-inset ring-line',
};
export const TAG_SIZE = {
  xs: 'h-4 px-1.5 text-[0.68rem] gap-0.5',
  sm: 'h-5 px-2 text-[0.7rem] gap-1',
};

/** A topic nobody has named yet: the GM names it after its first order. */
export const isUntitled = (t) => !!t && t.title === 'New topic' && !t.title_locked;

/** "/new [title words…] [#tag …]⏎[first order body…]" → { title, tags, body, extraTags, long } or null. */
export function parseNew(text) {
  const m = /^\/new(?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const line = m[1] || '';
  const all = [];
  for (const [, tag] of line.matchAll(/#([\p{L}\p{N}_-]{1,24})/gu)) {
    const n = normTag(tag);
    if (n && !all.includes(n)) all.push(n);
  }
  const title = line.replace(/#[\p{L}\p{N}_-]{1,24}/gu, ' ').replace(/\s+/g, ' ').trim();
  return { title: title.slice(0, MAX_TITLE), long: title.length > MAX_TITLE, tags: all.slice(0, MAX_TAGS), extraTags: all.length > MAX_TAGS, body: (m[2] || '').trim() };
}

/** Every tag used in the project, most used first. */
export function tagCounts(topics) {
  const n = new Map();
  for (const t of topics || []) for (const tag of t.tags || []) n.set(tag, (n.get(tag) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
