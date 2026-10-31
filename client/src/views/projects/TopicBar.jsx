import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus, Hash, LoaderCircle, CircleX, Archive, ArchiveRestore, Pencil, Tags, Trash2, LayoutList, ChevronDown, Search, Ellipsis, Check, X } from 'lucide-react';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { compact, timeAgo, dateTime } from '../../lib/format.js';
import { normTag, tagTone, tagCounts, isUntitled, TAG_CLS, TAG_SIZE, MAX_TAGS, MAX_TITLE } from '../../lib/topics.js';
import { openContextMenu } from '../../components/ContextMenu.jsx';
import { Confirm } from '../../components/Modal.jsx';
import { cx, Button, IconButton, Input, Toggle, Kbd } from '../../components/ui.jsx';

// Topic strip of the project command window — docs/design/topics.md §1–§4, §7.

const EMPTY = [];
const FADE = {
  none: '',
  l: '[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]',
  r: '[mask-image:linear-gradient(to_left,transparent,black_1.5rem)]',
  lr: '[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]',
};
const STATE_LABEL = { running: 'Running', planning: 'Planning', failed: 'Last mission failed', queued: 'Queued', archived: 'Archived', idle: '' };
const byCreated = (a, b) => new Date(a.created_at) - new Date(b.created_at);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 14.5;
const scrollOpts = () => ({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
const tabEl = (id) => document.getElementById(`topic-tab-${id}`);

/**
 * Lead-slot state. Precedence: running › planning › failed › queued › archived › idle.
 * runs = selectRuns(); busy = the project is running, so a flagged topic without a run of its own is waiting for a slot.
 */
export function topicState(t, runs, failed, busy) {
  const run = runs?.[t.id];
  if (run) return run.planning ? 'planning' : 'running';
  if (failed?.[t.id]) return 'failed';
  if (busy && t.running) return 'queued';
  if (t.archived) return 'archived';
  return 'idle';
}

export function TopicLead({ state, active }) {
  return (
    <span className="size-3 inline-flex items-center justify-center shrink-0">
      {state === 'running' ? <LoaderCircle size={12} className="animate-spin text-accent motion-reduce:animate-none" />
        : state === 'planning' ? <span className="size-1.5 rounded-full bg-info animate-af-pulse motion-reduce:animate-none" />
          : state === 'failed' ? <CircleX size={12} className="text-bad" />
            : state === 'queued' ? <span className="size-1.5 rounded-full bg-warn" />
              : state === 'archived' ? <Archive size={12} className="text-subtle" />
                : <Hash size={12} className={active ? 'text-accent' : 'text-subtle'} />}
    </span>
  );
}

/** fluid: in single-line rows (tabs, list rows, /new preview) the chip shrinks with an ellipsis instead of overflowing. */
export function TagChip({ tag, size = 'xs', fluid, className, children }) {
  return (
    <span className={cx('inline-flex items-center rounded-full font-medium whitespace-nowrap', fluid ? 'min-w-0' : 'shrink-0', TAG_SIZE[size], TAG_CLS[tagTone(tag)], className)}>
      <span className="truncate max-w-[5.5rem]">{tag}</span>
      {children}
    </span>
  );
}

function MoreChip({ tags, size = 'xs' }) {
  return <span title={`also: ${tags.join(', ')}`} className={cx('inline-flex items-center rounded-full font-medium tabular shrink-0', TAG_SIZE[size], TAG_CLS.neutral)}>+{tags.length}</span>;
}

/** Inline title editor: Enter or blur commits, Esc cancels. onDone(byKeyboard). */
export function RenameInput({ topic, className, onDone }) {
  const done = useRef(false);
  const finish = (value, byKeyboard) => {
    if (done.current) return;
    done.current = true;
    const title = value?.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    if (title && title !== topic.title) useStore.getState().updateTopic(topic.id, { title }).catch(() => {});
    onDone(byKeyboard);
  };
  return (
    <input autoFocus defaultValue={isUntitled(topic) ? '' : topic.title} placeholder="Topic title" maxLength={MAX_TITLE} aria-label="Topic title"
      onFocus={(e) => e.target.select()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value, false)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value, true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null, true); }
      }}
      className={className} />
  );
}

/** Tag editor popover (§3.6). Enter or "," adds, Backspace removes the last chip, ↑/↓ pick a suggestion, Esc closes and saves. */
export function TagEditor({ topic, allTags, onClose, className, style, boxRef }) {
  const [tags, setTags] = useState(topic.tags || EMPTY);
  const [draft, setDraft] = useState('');
  const [hi, setHi] = useState(-1);
  const own = useRef(null);
  const ref = boxRef || own;
  const closed = useRef(false);
  const listId = useId();
  const d = normTag(draft);
  const full = tags.length >= MAX_TAGS;
  const options = full ? EMPTY : [
    ...(d && !tags.includes(d) ? [{ tag: d, create: !allTags.some(([g]) => g === d), n: allTags.find(([g]) => g === d)?.[1] }] : []),
    ...allTags.filter(([g]) => !tags.includes(g) && g !== d && (!d || g.includes(d))).slice(0, 6).map(([tag, n]) => ({ tag, n })),
  ];
  const add = (raw) => {
    const g = normTag(raw || '');
    setDraft('');
    setHi(-1);
    if (g && !tags.includes(g) && !full) setTags([...tags, g]);
  };
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    if (tags.join(',') !== (topic.tags || []).join(',')) useStore.getState().updateTopic(topic.id, { tags }).catch(() => {});
    onClose();
  };
  useEffect(() => {
    const off = (e) => { if (!ref.current?.contains(e.target)) close(); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  });
  return (
    <div ref={ref} role="dialog" aria-label={`Tags for ${topic.title}`} style={style}
      className={cx('z-50 w-64 max-w-[calc(100%-1rem)] p-2 flex flex-col gap-1.5 rounded-xl border border-line bg-raised shadow-af-lg text-left animate-af-in motion-reduce:animate-none', className)}>
      <div className="flex flex-wrap items-center gap-1 min-h-8 px-1.5 py-1 rounded-lg bg-sunken border border-line focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft">
        {tags.map((g) => (
          <TagChip key={g} tag={g} size="sm">
            <button type="button" aria-label={`Remove tag ${g}`} onClick={() => setTags(tags.filter((x) => x !== g))}
              className="-mr-1 size-4 rounded-full inline-flex items-center justify-center hover:bg-current/15 focus-visible:outline-accent! focus-visible:rounded-full!"><X size={10} /></button>
          </TagChip>
        ))}
        <input autoFocus value={draft} onChange={(e) => { setDraft(e.target.value); setHi(-1); }} maxLength={30}
          placeholder={full ? `Max ${MAX_TAGS} tags` : tags.length ? '' : 'Add tag…'} aria-label="Add tag"
          role="combobox" aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={hi >= 0 ? `${listId}-${hi}` : undefined}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(hi >= 0 ? options[hi]?.tag : draft); }
            else if (e.key === 'Backspace' && !draft && tags.length) setTags(tags.slice(0, -1));
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(options.length - 1, h + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(-1, h - 1)); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
          }}
          className="flex-1 min-w-16 h-5 bg-transparent outline-none focus-visible:outline-none! text-[0.82rem] placeholder:text-subtle" />
      </div>
      {options.length > 0 && (
        <div role="listbox" id={listId} aria-label="Tag suggestions" className="flex flex-col">
          {options.map((o, i) => (
            <div key={o.tag} id={`${listId}-${i}`} role="option" aria-selected={i === hi}
              onMouseDown={(e) => e.preventDefault()} onClick={() => add(o.tag)} onMouseEnter={() => setHi(i)}
              className={cx('flex items-center gap-2 h-7 px-2 rounded-md cursor-pointer text-xs text-muted', i === hi && 'bg-hover')}>
              {o.create && 'Create'}<TagChip tag={o.tag} size="sm" />
              {o.n != null && <span className="ml-auto text-[0.68rem] text-muted tabular">{o.n}</span>}
            </div>
          ))}
        </div>
      )}
      {full && <div className="px-1 text-[0.7rem] text-muted">A topic can have up to {MAX_TAGS} tags.</div>}
    </div>
  );
}

/** Width tier from the strip's own width, in rem so it follows the layout scale (§4.1). */
function useStripTier(ref) {
  const [tier, setTier] = useState('full');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth / remPx();
      setTier(w < 24 ? 'collapsed' : w < 42 ? 'compact' : 'full');
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return tier;
}

/** FADE key for a scroller with a hidden scrollbar: which edges have content out of view (§4.2). */
function useEdgeFade(ref, deps) {
  const [fade, setFade] = useState('none');
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade(l && r ? 'lr' : l ? 'l' : r ? 'r' : 'none');
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, ...deps]);
  return [fade, update];
}
const wheelToHorizontal = (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; };

/** Context menus opened from the keyboard have no pointer position: anchor them under the element. */
function at(e, el) {
  if (e.clientX || e.clientY) return e;
  const r = el.getBoundingClientRect();
  return { preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation(), clientX: r.left, clientY: r.bottom + 4 };
}
const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

/** The GM's running summary of the topic; the title itself is only its key words. */
const summaryOf = (t) => t?.summary?.trim() || '';
function tooltip(t) {
  const ago = timeAgo(t.last_activity_at);
  const tags = t.tags?.length ? ` — ${t.tags.map((g) => `#${g}`).join(' ')}` : '';
  const summary = summaryOf(t);
  return `${t.title}${tags} — ${t.message_count || 0} message${t.message_count === 1 ? '' : 's'} · active ${ago === 'now' ? 'now' : `${ago} ago`}${summary ? `\n${summary}` : ''}`;
}
function describe(t, state, unread) {
  return [STATE_LABEL[state], unread ? `${unread} unread` : '', `${t.message_count || 0} messages`, t.tags?.length ? `Tags: ${t.tags.join(', ')}` : '', summaryOf(t)]
    .filter(Boolean).map((x) => x.replace(/[.\s]+$/, '')).join('. ') + '.';
}
function highlight(text, needle) {
  const i = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (i === -1) return text;
  return <>{text.slice(0, i)}<mark className="bg-accent-soft text-fg rounded-sm">{text.slice(i, i + needle.length)}</mark>{text.slice(i + needle.length)}</>;
}

/** "All topics" popover (§3.3): search, AND tag filters, archived toggle, row actions. */
function TopicList({ topics, activeId, runs, busy, failed, unread, tier, allTags, items, renaming, setRenaming, onOpen, onCreate, onClose, ignore }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(EMPTY);
  const [showArchived, setShowArchived] = useState(false);
  const ref = useRef(null);
  const searchRef = useRef(null);
  const filterRef = useRef(null);
  const [filterFade, updateFilterFade] = useEdgeFade(filterRef, [allTags, sel]);
  const needle = q.trim().toLowerCase();
  const match = (t) => (!needle || t.title.toLowerCase().includes(needle) || (t.tags || []).some((g) => g.includes(needle))) && sel.every((g) => t.tags?.includes(g));
  // Running, planning and queued topics are pinned on top; the rest follow by activity.
  const rank = (t) => ({ running: 0, planning: 1, queued: 2 })[topicState(t, runs, null, busy)] ?? 3;
  const sorted = [...topics].sort((a, b) => rank(a) - rank(b) || new Date(b.last_activity_at) - new Date(a.last_activity_at));
  const openRows = sorted.filter((t) => !t.archived && match(t));
  const archivedRows = showArchived ? sorted.filter((t) => t.archived && match(t)) : EMPTY;
  const archivedCount = topics.filter((t) => t.archived).length;

  useEffect(() => {
    const off = (e) => { if (!ref.current?.contains(e.target) && !ignore(e.target)) onClose(false); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [onClose, ignore]);

  const focusRow = (id) => requestAnimationFrame(() => ref.current?.querySelector(`[data-row="${id}"]`)?.focus());
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(true); return; }
    const rows = [...ref.current.querySelectorAll('[data-row]')];
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && (i !== -1 || e.target === searchRef.current)) { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp' && i !== -1) { e.preventDefault(); (i === 0 ? searchRef.current : rows[i - 1])?.focus(); }
  };
  const metaLine = (t, state) => (state === 'running' ? `running${runs[t.id].progress ? ` · ${runs[t.id].progress}` : ''}` : state === 'planning' || state === 'queued' || state === 'archived' ? state
    : `${t.message_count || 0} msg${t.message_count === 1 ? '' : 's'}`);

  const row = (t) => {
    const isActive = t.id === activeId;
    const n = isActive ? 0 : unread[t.id] || 0;
    const state = topicState(t, runs, failed, busy);
    const tags = t.tags || EMPTY;
    const lead = <span className="mt-0.5 size-6 rounded-md bg-sunken border border-line flex items-center justify-center shrink-0"><TopicLead state={state} active={isActive} /></span>;
    return (
      <li key={t.id} className={cx('group relative flex items-center gap-1 rounded-lg transition-colors', isActive ? 'bg-hover' : 'hover:bg-hover')}>
        {isActive && <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full grad-accent" />}
        {renaming === t.id ? (
          <div className="flex-1 min-w-0 flex items-center gap-2.5 pl-2.5 pr-1 py-1.5">
            {lead}
            <RenameInput topic={t} onDone={(kb) => { setRenaming(null); if (kb) focusRow(t.id); }}
              className="w-full h-6 px-1.5 -mx-1.5 rounded bg-sunken border border-accent outline-none text-[0.82rem]" />
          </div>
        ) : (
          <button type="button" data-row={t.id} onClick={() => onOpen(t)} aria-current={isActive ? 'true' : undefined}
            title={summaryOf(t) || undefined} aria-describedby={summaryOf(t) ? `topic-row-${t.id}-d` : undefined}
            onContextMenu={(e) => openContextMenu(at(e, e.currentTarget), items(t, e.currentTarget.closest('li'), 'row'))}
            onKeyDown={(e) => {
              if (e.key === 'F2') { e.preventDefault(); setRenaming(t.id); }
              else if (isMenuKey(e)) { e.preventDefault(); openContextMenu(at(e, e.currentTarget), items(t, e.currentTarget.closest('li'), 'row')); }
            }}
            className="flex-1 min-w-0 flex items-start gap-2.5 pl-2.5 pr-1 py-1.5 text-left rounded-lg focus-visible:outline-accent!">
            {lead}
            <span className="min-w-0 flex-1 flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <span className={cx('text-[0.82rem] font-medium truncate', t.archived ? 'text-muted' : 'text-fg')}>{highlight(t.title || 'New topic', needle)}</span>
                {n > 0 && <span className="size-1.5 rounded-full bg-accent shrink-0"><span className="sr-only">{n} unread</span></span>}
                <span className="ml-auto text-[0.68rem] text-muted tabular shrink-0" title={dateTime(t.last_activity_at)}>{timeAgo(t.last_activity_at)}</span>
              </span>
              <span className="flex items-center gap-1 min-w-0">
                {tags.slice(0, 2).map((g) => <TagChip key={g} tag={g} fluid />)}
                {tags.length > 2 && <MoreChip tags={tags.slice(2)} />}
                <span className="ml-auto text-[0.68rem] text-muted tabular shrink-0">{metaLine(t, state)}</span>
              </span>
            </span>
          </button>
        )}
        {summaryOf(t) && renaming !== t.id && <span id={`topic-row-${t.id}-d`} className="sr-only">{summaryOf(t)}</span>}
        <IconButton icon={Ellipsis} size="sm" label={`Actions for ${t.title}`} aria-haspopup="menu"
          className="mr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-accent!"
          onClick={(e) => openContextMenu(at(e, e.currentTarget), items(t, e.currentTarget.closest('li'), 'row'))} />
      </li>
    );
  };

  return (
    <div ref={ref} role="dialog" aria-label="All topics" onKeyDown={onKey}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (to && !ref.current.contains(to) && !ignore(to) && !to.closest('[role="menu"]')) onClose(false);
      }}
      className={cx('absolute top-full mt-1 z-40 max-h-[min(30rem,70vh)] flex flex-col rounded-xl border border-line bg-raised shadow-af-lg animate-af-in motion-reduce:animate-none',
        // Right edge flush with the All topics trigger; in the collapsed tier, left edge flush with the switcher.
        tier === 'collapsed' ? 'right-2 w-[calc(100%-1rem)]' : 'right-3 w-[min(24rem,calc(100%-1.5rem))]')}>
      <div className="p-2 flex flex-col gap-2 border-b border-line">
        <Input ref={searchRef} autoFocus icon={Search} placeholder="Search topics and tags" aria-label="Search topics and tags" value={q} onChange={(e) => setQ(e.target.value)} />
        {allTags.length > 0 && (
          <div ref={filterRef} role="group" aria-label="Filter by tag" onScroll={updateFilterFade} onWheel={wheelToHorizontal}
            className={cx('flex items-center gap-1 overflow-x-auto overscroll-x-contain scroll-px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', FADE[filterFade])}>
            {allTags.map(([g]) => {
              const on = sel.includes(g);
              const tone = tagTone(g);
              return (
                <button key={g} type="button" aria-pressed={on} onClick={() => setSel(on ? sel.filter((x) => x !== g) : [...sel, g])}
                  className={cx('inline-flex items-center rounded-full font-medium whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-accent! focus-visible:rounded-full!', TAG_SIZE.sm,
                    tone === 'neutral' ? cx('bg-hover text-muted ring-1 ring-inset', on ? 'ring-current' : 'ring-line hover:ring-line-strong')
                      : cx(TAG_CLS[tone], on ? 'ring-1 ring-inset ring-current' : 'hover:ring-1 hover:ring-inset hover:ring-line-strong'))}>
                  {on && <Check size={10} />}{g}
                </button>
              );
            })}
            {sel.length > 0 && <button type="button" onClick={() => setSel(EMPTY)} className="h-5 px-1.5 text-[0.7rem] text-muted hover:text-fg hover:underline shrink-0 focus-visible:outline-accent!">Clear</button>}
          </div>
        )}
      </div>
      <ul aria-label="Topics" className="flex-1 min-h-0 overflow-auto p-1">
        {openRows.map(row)}
        {archivedRows.length > 0 && <li className="px-2.5 pt-2 pb-1 text-[0.66rem] font-semibold uppercase tracking-wider text-muted">Archived</li>}
        {archivedRows.map(row)}
        {!openRows.length && !archivedRows.length && (
          <li className="py-8 px-4 flex flex-col items-center gap-2 text-center">
            <span className="text-xs text-muted">{needle || sel.length ? `No topics match "${q.trim() || sel.join(' + ')}"` : 'No open topics'}</span>
            {q.trim() && <Button size="sm" variant="ghost" icon={Plus} onClick={() => onCreate(q.trim())}>Create "{q.trim()}"</Button>}
          </li>
        )}
      </ul>
      <div className="flex items-center gap-2 h-9 px-2.5 border-t border-line bg-sunken/40 rounded-b-xl shrink-0">
        <Toggle checked={showArchived} onChange={setShowArchived} label={`Show archived (${archivedCount})`} />
        {tier === 'full' && <span className="ml-auto inline-flex items-center gap-1 text-[0.7rem] text-muted">or type <Kbd>/new</Kbd></span>}
      </div>
    </div>
  );
}

/**
 * Topic strip under the command window header. runs = selectRuns(): { [topicId]: { planning, progress } } of every
 * topic with an in-flight mission; onCompose focuses the composer.
 */
export function TopicBar({ project, runs, onCompose }) {
  const raw = useStore((s) => s.topics[project.id]);
  const topics = raw || EMPTY;
  const activeId = useStore((s) => s.activeTopic[project.id]) || null;
  const unread = useStore((s) => s.unread);
  const failed = useStore((s) => s.failedTopics);
  const movedFrom = useStore((s) => s.movedFrom);
  const busy = project.status === 'running';
  const stripRef = useRef(null);
  const scrollRef = useRef(null);
  const triggerRef = useRef(null);
  const editorRef = useRef(null);
  const kbMenu = useRef(0);
  const seen = useRef(null);
  const mountedAt = useRef(Date.now());
  const tier = useStripTier(stripRef);
  const [focusId, setFocusId] = useState(activeId);
  const [renaming, setRenaming] = useState(null);
  const [rowRenaming, setRowRenaming] = useState(null);
  const [tagsFor, setTagsFor] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const [fade, setFade] = useState('none');
  const [hiddenUnread, setHiddenUnread] = useState(false);
  const [flash, setFlash] = useState(EMPTY);

  const active = topics.find((t) => t.id === activeId) || null;
  const open = useMemo(() => topics.filter((t) => !t.archived).sort(byCreated), [topics]);
  // Open topics in creation order; an archived topic opened from the list gets a temporary tab at the end.
  const tabs = active?.archived ? [...open, active] : open;
  const focus = tabs.some((t) => t.id === focusId) ? focusId : activeId || tabs[0]?.id;
  const allTags = useMemo(() => tagCounts(topics), [topics]);
  const otherUnread = topics.filter((t) => t.id !== activeId && unread[t.id]).length;
  const archivedUnread = topics.some((t) => t.archived && t.id !== activeId && unread[t.id]);

  useEffect(() => { setFocusId(activeId); }, [activeId]);
  useEffect(() => { setListOpen(false); setTagsFor(null); setRenaming(null); setRowRenaming(null); }, [project.id]);

  // A topic the GM split off without switching to it gets a 2 s highlight.
  useEffect(() => {
    if (!raw) return;
    const prev = seen.current;
    seen.current = { pid: project.id, ids: new Set(raw.map((t) => t.id)) };
    if (prev?.pid !== project.id) return;
    const fresh = raw.filter((t) => !prev.ids.has(t.id) && t.id !== activeId && movedFrom[t.id]).map((t) => t.id);
    if (!fresh.length) return;
    setFlash((f) => [...f, ...fresh]);
    setTimeout(() => setFlash((f) => f.filter((id) => !fresh.includes(id))), 2000);
  }, [raw, project.id]);

  // Fade edges and the "unread topic out of view" dot on the All topics trigger.
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) { setFade('none'); setHiddenUnread(false); return; }
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade(l && r ? 'lr' : l ? 'l' : r ? 'r' : 'none');
    const box = el.getBoundingClientRect();
    setHiddenUnread([...el.querySelectorAll('[data-unread]')].some((tab) => {
      const b = tab.getBoundingClientRect();
      const mid = b.left + b.width / 2;
      return mid < box.left || mid > box.right;
    }));
  }, []);
  useLayoutEffect(() => { measure(); }, [measure, tabs.length, unread, tier, activeId]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tier, tabs.length > 0]);
  useEffect(() => { if (activeId) tabEl(activeId)?.scrollIntoView(scrollOpts()); }, [activeId, tier, tabs.length]);

  const openTopic = (id) => useStore.getState().setActiveTopic(project.id, id);
  const focusTab = (id) => requestAnimationFrame(() => (tabEl(id) || triggerRef.current)?.focus({ preventScroll: true }));
  const newTopic = async () => {
    // Never stack up empty topics: an untouched, unnamed active topic is reused.
    if (active && !active.archived && !active.message_count && isUntitled(active)) return onCompose?.();
    await useStore.getState().createTopic(project.id).catch(() => {});
    onCompose?.();
  };
  const createNamed = async (title) => {
    setListOpen(false);
    await useStore.getState().createTopic(project.id, { title }).catch(() => {});
    onCompose?.();
  };
  // Archive / delete guardrails (§1.5): the topic's own mission, running, planning or queued.
  const guard = (t) => {
    if (['running', 'planning', 'queued'].includes(topicState(t, runs, null, busy))) return 'mission running';
    if (!t.archived && open.length <= 1) return 'last open topic';
    return null;
  };
  const askDelete = (t) => {
    const g = guard(t);
    if (g) toast.warn(g === 'mission running' ? 'Stop or wait for the mission first' : 'A project keeps at least one open topic');
    else setConfirmDel(t);
  };
  const openTags = (t, el) => {
    const s = stripRef.current.getBoundingClientRect();
    const r = (el || stripRef.current).getBoundingClientRect();
    setTagsFor({ id: t.id, left: Math.max(8, Math.min(r.left - s.left, s.width - 16 * remPx() - 8)), top: r.bottom - s.top + 4 });
  };
  const items = (t, el, where) => {
    const g = guard(t);
    const why = g ? ` · ${g}` : '';
    const st = useStore.getState();
    return [
      { label: 'Rename', icon: Pencil, shortcut: 'F2', onClick: () => (where === 'row' ? setRowRenaming(t.id) : setRenaming(t.id)) },
      { label: 'Edit tags', icon: Tags, onClick: () => openTags(t, el) },
      '-',
      t.archived
        ? { label: 'Unarchive', icon: ArchiveRestore, onClick: () => st.archiveTopic(t, false).catch(() => {}) }
        : { label: `Archive${why}`, icon: Archive, disabled: !!g, onClick: () => st.archiveTopic(t).catch(() => {}) },
      { label: `Delete${why}`, icon: Trash2, shortcut: 'Del', danger: true, disabled: !!g, onClick: () => setConfirmDel(t) },
    ];
  };
  const tabMenu = (e, t) => {
    // The keydown already opened it; a key-generated contextmenu (not a right click) would open it twice.
    if (e.button !== 2 && Date.now() - kbMenu.current < 500) { e.preventDefault(); return; }
    openContextMenu(at(e, e.currentTarget), items(t, e.currentTarget, 'tab'));
  };
  // Manual activation (§7.2): arrows move focus, Enter / Space open.
  const onTabKey = (e, t) => {
    const i = tabs.findIndex((x) => x.id === t.id);
    const go = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length], Home: tabs[0], End: tabs[tabs.length - 1] }[e.key];
    if (go) {
      e.preventDefault();
      setFocusId(go.id);
      const el = tabEl(go.id);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView(scrollOpts());
    } else if (e.key === 'F2') { e.preventDefault(); setRenaming(t.id); }
    else if (e.key === 'Delete') { e.preventDefault(); askDelete(t); }
    else if (isMenuKey(e)) {
      e.preventDefault();
      kbMenu.current = Date.now();
      openContextMenu(at(e, e.currentTarget), items(t, e.currentTarget, 'tab'));
    }
  };
  const closeList = useCallback((refocus) => {
    setListOpen(false);
    setRowRenaming(null);
    if (refocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  const ignore = useCallback((el) => !!(triggerRef.current?.contains(el) || editorRef.current?.contains(el)), []);
  const openFromList = (t) => {
    openTopic(t.id);
    closeList(false);
    focusTab(t.id);
  };

  const renderTab = (t) => {
    const isActive = t.id === activeId;
    const state = topicState(t, runs, failed, busy);
    const n = isActive ? 0 : unread[t.id] || 0;
    const tags = t.tags || EMPTY;
    // The title is only key words now; a single chip (full tier) keeps them from being squeezed. The rest is in the tooltip.
    const max = tier === 'full' ? 1 : 0;
    const shown = tags.slice(0, max);
    const rest = max ? tags.slice(max) : EMPTY;
    const editing = renaming === t.id;
    const Tab = editing ? 'div' : 'button';
    return (
      <Tab key={t.id} type={editing ? undefined : 'button'} role="tab" id={`topic-tab-${t.id}`} aria-selected={isActive} aria-controls="topic-panel"
        aria-label={t.title || 'New topic'} aria-describedby={`topic-tab-${t.id}-d`} tabIndex={t.id === focus ? 0 : -1}
        title={editing ? undefined : tooltip(t)} data-unread={n ? '' : undefined}
        onClick={() => { if (!editing) openTopic(t.id); }} onDoubleClick={() => setRenaming(t.id)} onFocus={() => setFocusId(t.id)}
        onContextMenu={(e) => tabMenu(e, t)} onKeyDown={(e) => onTabKey(e, t)}
        className={cx('relative shrink-0 inline-flex items-center gap-1.5 h-7 max-w-[20rem] pl-2 pr-2.5 rounded-md border text-[0.78rem] font-medium',
          'transition-[color,background-color,border-color,box-shadow,scale] duration-150 active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:outline-accent!',
          t.archived ? 'border-dashed border-line-strong' : isActive ? 'border-line' : 'border-transparent',
          isActive ? 'bg-raised text-fg shadow-sm' : 'text-muted hover:bg-hover hover:text-fg',
          new Date(t.created_at).getTime() > mountedAt.current && 'animate-af-in motion-reduce:animate-none')}>
        <TopicLead state={state} active={isActive} />
        {editing
          ? <RenameInput topic={t} onDone={(kb) => { setRenaming(null); if (kb) focusTab(t.id); }}
            className="h-5 w-[9rem] px-1.5 -mx-1.5 rounded bg-sunken border border-accent outline-none text-[0.78rem] text-fg" />
          : <span className={cx('truncate max-w-[12rem]', t.archived ? 'text-muted' : (n > 0 || isActive) && 'text-fg')}>{t.title || 'New topic'}</span>}
        {(shown.length > 0 || rest.length > 0) && (
          <span aria-hidden className="flex items-center gap-1 min-w-0">
            {shown.map((g) => <TagChip key={g} tag={g} fluid />)}
            {rest.length > 0 && <MoreChip tags={rest} />}
          </span>
        )}
        {n > 0 && <span aria-hidden className="size-1.5 rounded-full bg-accent shrink-0 animate-af-in motion-reduce:animate-none" />}
        {(tier === 'full' || isActive || n > 0) && <span aria-hidden className={cx('tabular text-[0.68rem] shrink-0', n > 0 ? 'text-fg' : 'text-muted')}>{compact(t.message_count)}</span>}
        <span id={`topic-tab-${t.id}-d`} className="sr-only">{describe(t, state, n)}</span>
        {isActive && <span key={activeId} aria-hidden className="absolute inset-x-2 -bottom-1.5 h-0.5 rounded-full grad-accent animate-af-fade motion-reduce:animate-none" />}
        {/* GM-created highlight: its own layer so it fades out over 500 ms without slowing the tab's shadow transition. */}
        <span aria-hidden className={cx('pointer-events-none absolute -inset-px rounded-md ring-2 ring-accent/40 transition-opacity duration-500 motion-reduce:transition-none',
          flash.includes(t.id) ? 'opacity-100' : 'opacity-0')} />
      </Tab>
    );
  };

  const total = topics.length;
  const tagTopic = tagsFor && topics.find((t) => t.id === tagsFor.id);

  return (
    <div ref={stripRef} className="@container relative flex items-stretch h-10 shrink-0 border-b border-line bg-sunken/60">
      {tier === 'collapsed' ? (
        <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}
          aria-label={`Topic: ${active?.title || 'none'}. ${otherUnread} other topic${otherUnread === 1 ? '' : 's'} unread. Show all topics`}
          title={active ? tooltip(active) : undefined} aria-describedby={summaryOf(active) ? 'topic-switcher-d' : undefined}
          className="flex-1 min-w-0 mx-2 self-center h-7 inline-flex items-center gap-1.5 px-2 rounded-md bg-raised border border-line shadow-sm text-[0.78rem] font-medium text-fg hover:border-line-strong aria-expanded:border-line-strong transition-colors focus-visible:outline-accent!">
          {active ? (
            <>
              <TopicLead state={topicState(active, runs, failed, busy)} active />
              <span className="truncate">{active.title || 'New topic'}</span>
              {/* Below 20rem (a 25% chat pane at 1024px) the count gives its room to the keyword title; it stays in the tooltip. */}
              <span className="tabular text-[0.68rem] text-muted shrink-0 @max-[20rem]:hidden">{compact(active.message_count)}</span>
              {summaryOf(active) && <span id="topic-switcher-d" className="sr-only">{summaryOf(active)}</span>}
            </>
          ) : <span className="truncate text-muted">{raw ? 'No topic yet' : 'Loading topics…'}</span>}
          {otherUnread > 0 && <span className="ml-auto inline-flex items-center gap-1 text-[0.68rem] text-muted tabular shrink-0"><span className="size-1.5 rounded-full bg-accent" />{otherUnread}</span>}
          <ChevronDown size={12} className={cx('text-subtle shrink-0', !otherUnread && 'ml-auto')} />
        </button>
      ) : tabs.length > 0 ? (
        <div ref={scrollRef} role="tablist" aria-label="Topics" aria-orientation="horizontal" onScroll={measure} onWheel={wheelToHorizontal}
          className={cx('flex-1 min-w-0 flex items-end gap-1 px-2 pb-1.5 overflow-x-auto overscroll-x-contain scroll-px-6',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden', FADE[fade])}>
          {tabs.map(renderTab)}
        </div>
      ) : (
        <div className="flex-1 min-w-0 flex items-center px-4 text-[0.75rem] text-muted truncate">{raw ? 'Your first order starts a topic' : ''}</div>
      )}
      <span aria-hidden className="w-px h-4 self-center bg-line shrink-0" />
      {/* pr-3 puts the last glyph on the same vertical as the header's icon buttons above (header is px-4, icons inset 6px). */}
      <div className="flex items-center gap-0.5 pl-1.5 pr-3 shrink-0">
        {tier === 'full'
          ? <Button size="sm" variant="ghost" icon={Plus} className="focus-visible:outline-accent!" onClick={newTopic}>New topic</Button>
          : <IconButton icon={Plus} label="New topic" className="focus-visible:outline-accent!" onClick={newTopic} />}
        {tier !== 'collapsed' && (
          <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={listOpen} aria-label={`All topics (${total})`} title="All topics"
            onClick={() => setListOpen(!listOpen)}
            className={cx('relative h-7 px-1.5 inline-flex items-center gap-1 rounded-md transition-colors focus-visible:outline-accent!', listOpen ? 'bg-hover text-fg' : 'text-muted hover:text-fg hover:bg-hover')}>
            <LayoutList size={16} strokeWidth={1.9} />
            {tier === 'full' && <span className="tabular text-[0.68rem]">{total}</span>}
            <ChevronDown size={12} className="text-subtle" />
            {(hiddenUnread || archivedUnread) && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-accent animate-af-in motion-reduce:animate-none" />}
          </button>
        )}
      </div>

      {listOpen && (
        <TopicList topics={topics} activeId={activeId} runs={runs} busy={busy} failed={failed} unread={unread} tier={tier} allTags={allTags} items={items}
          renaming={rowRenaming} setRenaming={setRowRenaming} onOpen={openFromList} onCreate={createNamed} onClose={closeList} ignore={ignore} />
      )}
      {tagTopic && (
        <TagEditor key={tagTopic.id} topic={tagTopic} allTags={allTags} boxRef={editorRef} className="absolute" style={{ left: tagsFor.left, top: tagsFor.top }}
          onClose={() => { setTagsFor(null); if (!listOpen) focusTab(tagTopic.id); }} />
      )}
      <Confirm open={!!confirmDel} danger confirmLabel="Delete topic" onClose={() => setConfirmDel(null)}
        title={`Delete topic "${confirmDel?.title}"?`}
        body={`Removes its ${confirmDel?.message_count || 0} message${confirmDel?.message_count === 1 ? '' : 's'} from AgentForge. Tasks, files and commits made from this topic are kept.`}
        onConfirm={async () => {
          await useStore.getState().deleteTopic(confirmDel);
          focusTab(useStore.getState().activeTopic[project.id]);
        }} />
    </div>
  );
}
