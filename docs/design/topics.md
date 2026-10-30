# Topic threads — visual & interaction spec

| | |
|---|---|
| **Status** | Implemented (T4) · design polish pass done (T5). The spec below reflects the shipped values; deviations are logged in §11 |
| **Owner** | Iris (UI/UX) · reviewer: Archer |
| **Date** | 2026-10-30 |
| **Applies to** | `client/src/views/projects/CommandWindow.jsx` (project command window) |
| **Builds on** | `client/src/styles.css` tokens, `client/src/components/ui.jsx` (`Badge`, `Button`, `IconButton`, `Input`, `Toggle`, `Kbd`), `ContextMenu.jsx`, `Modal.jsx` (`Confirm`) |

## Why

Today every order for a project goes into one long conversation (see the `comp30` screenshot: a counter bug, a composer
layout fix and two proposals all share one thread). Each order then carries the whole history, which costs tokens and makes
the chat hard to scan. **Topics** split the project chat into separate threads. Each one has its own conversation
context, its own tags and its own unread state. A strip at the top of the command window lets the user switch between them.
Project files, tasks, agents and agent memory stay shared across topics.

> In this spec, "topic" = the "new window" from the request. The UI word is **Topic** everywhere: tab, buttons, copy.

---

## 0. Anatomy & sizing conventions

Vertical order inside `CommandWindow` (top → bottom):

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ comp30 [running]                                         👥  📁  ⚙   [■ Stop]   🗑    │ ← header h-12 (unchanged)
│ /home/luca/SN62/c_30 · GM Zen                                                         │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ # General 214   ⟳ Agent mark shows 0 (ui)(bug) ● 12   # Composer images (ui) 8  ┆ + New topic  ☰ 5 ▾ │ ← topic strip h-10 (NEW)
│                 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                                    │   2px grad-accent = active
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ⟳ Mission in progress  …                                                     2/9     │ ← mission bar (active topic only, §0.2)
├──────────────────────────────────────────────────────────────────────────────────────┤
│ messages of the active topic (role=tabpanel)                                          │
│ …                                                                                     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ composer                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 0.1 Units

Tailwind v4 spacing is rem-based (`--spacing: 0.25rem`), and `html { font-size: calc(14.5px * var(--af-scale)) }`.
So **1rem = 14.5px at scale 1**, and every size here scales with the layout preset. Pixel values in brackets assume scale 1:

| Class | px @ scale 1 | | Class | px @ scale 1 |
|---|---|---|---|---|
| `h-4` | 14.5 | | `text-[0.68rem]` | 9.9 |
| `h-5` | 18.1 | | `text-[0.7rem]` | 10.2 |
| `h-7` | 25.4 | | `text-[0.78rem]` | 11.3 |
| `h-8` | 29 | | `text-[0.82rem]` | 11.9 |
| `h-10` | 36.3 | | `24rem` | 348 |
| `h-12` | 43.5 | | `42rem` | 609 |

### 0.2 Things that become per-topic

- **Message list**: shows only the active topic's messages (`role="tabpanel"`, §7).
- **Mission bar** (`Mission in progress … 2/9`): shown in full only when the running mission belongs to the active topic.
  Otherwise it becomes one slim row, with the same container classes as today (`px-4 py-2 border-b border-line bg-sunken/50 text-xs`):
  `⟳ Mission running in **Agent mark shows 0** · 2/9 · [Go to topic →]` (`Button size="sm" variant="ghost" icon={ArrowRight}`).
- **"Agents are working…" indicator**: only in the topic that is running.
- **Composer**: sends to the active topic. The placeholder becomes ``Order for ${gm} in "${topic.title}"…  (Enter to send · Shift+Enter newline · / for commands · paste images)``.
  The hint "New orders are queued after the current mission" stays. The queue is per project, because the agents are shared.
- The **active topic per project** is persisted with the other prefs (`activeTopicId` keyed by project id), so a reload returns to the same topic.
- **Migration**: the existing history of a project becomes its first topic, **General** (backend backfill: tag `history`, `title_locked`). It can be renamed and tagged like any other topic.
- **Unread** is client-derived (`unread` in the snippets below). The backend has no unread field (§10).

---

## Tokens: what's used, and the one addition

Every color in this spec maps to a token that already exists in `styles.css`, **except one derived family**, explained in §T.2.

### T.1 Inventory (existing tokens)

| Utility used | Token(s) in `styles.css` | Used for |
|---|---|---|
| `bg-sunken/60` | `--af-sunken` | Topic strip background |
| `bg-raised` | `--af-raised` | Active tab, popovers, collapsed switcher |
| `border-line`, `bg-line` | `--af-line` | Strip bottom border, active tab border, popover border, dividers |
| `border-line-strong` | `--af-line-strong` | Dashed border on archived tab, dashed "+ Add tag" chip |
| `bg-hover` | `--af-hover` | Hover states, list rows, neutral tag chip |
| `text-fg` | `--af-fg` | Active and unread titles |
| `text-muted` | `--af-muted` | Inactive titles, counts, timestamps, meta lines |
| `text-subtle` | `--af-subtle` | **Decorative only**: idle `#` glyph, chevrons, input placeholders |
| `grad-accent` | `--af-accent` → `--af-accent-2` | Active-tab indicator, active-row bar in the list |
| `bg-accent`, `text-accent`, `outline-accent` | `--af-accent` | Unread dot, running spinner, active `#` glyph, tab focus outline (non-text only) |
| `bg-accent-soft`, `border-accent/30` | `--af-accent-soft`, `--af-accent` | Auto-move notice, search match highlight, input focus ring |
| `bg-info-soft` / `bg-ok-soft` / `bg-warn-soft` | `--color-*-soft` (`@theme inline`) | Tag chip fills |
| `bg-info` / `bg-warn` | `--af-info` / `--af-warn` | Planning pulse dot / queued dot |
| `text-bad`, `bg-bad-soft` | `--af-bad` | Failed-mission glyph, Delete menu item (existing `ContextMenu` danger style) |
| `shadow-sm`, `shadow-af-lg` | Tailwind default / `--af-shadow-lg` | Active tab lift, popovers |
| `[mask-image:…black…]` | — | Alpha mask for the fade edges (§4). **Not a rendered color**, so it works the same in both themes |

### T.2 New derived tokens: `--color-{info,ok,warn}-ink` (justified)

**Problem (measured, §7.4):** tone text on its own `*-soft` fill fails WCAG AA (4.5:1) for chip-sized text (≈10px):

| Pair | Light | Dark |
|---|---|---|
| `text-info` on `bg-info-soft` (on raised / on strip) | 3.70 / 3.46 ✗ | 4.20 ✗ / 4.62 |
| `text-ok` on `bg-ok-soft` | 3.51 / 3.28 ✗ | 6.05 / 6.70 |
| `text-warn` on `bg-warn-soft` | 3.05 / 2.85 ✗ | 6.98 / 7.79 |

**Fix:** a text-safe "ink" for each tone. It mixes the tone toward `--af-fg` in OKLab, the same way the existing `-soft`
tokens are derived. **No new hue is added**, and the inks follow theme and tone changes automatically.

```css
/* styles.css — @theme inline, next to the -soft tokens */
--color-info-ink: color-mix(in oklab, var(--af-info) var(--af-ink-mix), var(--af-fg));
--color-ok-ink:   color-mix(in oklab, var(--af-ok)   var(--af-ink-mix), var(--af-fg));
--color-warn-ink: color-mix(in oklab, var(--af-warn) var(--af-ink-mix), var(--af-fg));

/* :root */                 --af-ink-mix: 70%;
/* [data-theme='dark'] */   --af-ink-mix: 80%;
```

Resolved values and their contrast on the chip's own fill, for every surface a chip sits on. The tab is raised, the strip
is `bg-sunken/60`, a list row is `bg-hover` on raised, and the tag-editor input is `bg-sunken`. The worst case per theme is in bold:

| Ink | Light (70%) | raised / strip / list row / input | Dark (80%) | raised / strip / list row / input |
|---|---|---|---|---|
| `text-info-ink` | `#275796` | 6.07 / 5.67 / 5.57 / 5.42 | `#619de9` | 5.44 / 5.99 / **4.82** / 6.07 |
| `text-ok-ink` | `#1c6631` | 5.84 / 5.46 / 5.36 / 5.22 | `#65c98b` | 7.06 / 7.83 / 6.23 / 7.95 |
| `text-warn-ink` | `#805824` | 5.26 / 4.93 / 4.84 / **4.71** | `#f4bd6e` | 7.73 / 8.62 / 6.79 / 8.78 |

Chips inside the auto-move notice (§5.2, `bg-accent-soft/40`) measure ≥ 4.88 (light) and ≥ 5.15 (dark) with the indigo, amber, emerald and mono accents (the lightest and darkest notice fills).
On a full `bg-accent-soft` fill, light warn ink measures 4.49 ✗.
**List rows must therefore use `hover:bg-hover`, never `bg-accent-soft`** (§3.4).

No `accent-ink` is added. This component never uses accent for **text** (see §7.4). The existing `Badge` keeps its
current classes; moving it to the inks is listed as a follow-up.

---

## 1. Topic tab strip

### 1.1 Container

Placed directly under the `h-12` header, above the mission bar.

```jsx
<div ref={stripRef} className="relative flex items-stretch h-10 shrink-0 border-b border-line bg-sunken/60">
  {/* tier = 'collapsed' renders <TopicSwitcher/> (§4.3) instead of the tablist */}
  <div ref={scrollRef} role="tablist" aria-label="Topics" aria-orientation="horizontal"
    onWheel={wheelToHorizontal} onScroll={updateFade}
    className={cx('flex-1 min-w-0 flex items-end gap-1 px-2 pb-1.5 overflow-x-auto overscroll-x-contain scroll-px-6',
      '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden', FADE[fade])}>
    {tabs}
  </div>
  <span aria-hidden className="w-px h-4 self-center bg-line shrink-0" />
  <div className="flex items-center gap-0.5 pl-1.5 pr-3 shrink-0">   {/* pr-3: last glyph lines up with the header icons (§11) */}
    <NewTopicButton />   {/* §3.1 */}
    {tier !== 'collapsed' && <AllTopicsButton />}  {/* §3.2 — in the collapsed tier the switcher opens the list */}
  </div>
</div>
```

- Strip height `h-10` (≈36px). This matches `PanelHeader`, so the window reads as header (`h-12`) + sub-header (`h-10`).
- `bg-sunken/60` gives light `#f7f7f5` and dark `#0d0d10`. It is the same "sunken track / raised selection" idea as the existing `Tabs` component.
- Tabs sit on the bottom edge (`items-end pb-1.5`). This lets the active indicator (`-bottom-1.5`) land exactly on the strip's `border-b`.
- **Alignment with the header**: the tab lead glyph (`px-2` strip + 1px border + `pl-2` tab) and the collapsed switcher glyph (`mx-2` + 1px + `px-2`)
  both start ≈1rem from the pane edge, the same as the header's project name (`px-4`). On the right, `pr-3` puts the All topics chevron on
  the same vertical as the header's last icon (`px-4` + 6px icon inset). The right controls are centred in the strip, and the tabs' centre is within 0.5px of them.
- **Order of tabs**: open (non-archived) topics in creation order, oldest left, new topics appended on the right.
  Tabs are **never re-sorted by activity**, so a tab never moves under the pointer. The list (§3) sorts by activity instead.
- The strip is shown even when there is only one topic. One tab plus **+ New topic** teaches the feature.

### 1.2 Tab anatomy

```
 ┌──────────────────────────────────────────────┐
 │ [lead] Title text that trunc… (tag)(tag) +1 ● 12 │   h-7, rounded-md
 └──────────────────────────────────────────────┘
   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀      active indicator, 2px grad-accent, inset-x-2
```

| Part | Spec |
|---|---|
| Tab (button) | `relative shrink-0 inline-flex items-center gap-1.5 h-7 max-w-[20rem] pl-2 pr-2.5 rounded-md border text-[0.78rem] font-medium transition-[color,background-color,border-color,box-shadow,scale] duration-150 focus-visible:outline-accent!` |
| Lead slot | `size-3 inline-flex items-center justify-center shrink-0`. Fixed width so state changes never shift the title (§1.4) |
| Title | `truncate max-w-[9rem]` (≈130px). Falls back to **New topic** when untitled. The full title is in `title=` and the accessible name |
| Tag chips | Up to **2** chips + `+N` chip, size `xs`, **`fluid`** (§2.2). Number shown depends on width tier (§4.1). The wrapper `flex items-center gap-1 min-w-0` is `aria-hidden` (tags are in the description, §7.2) |
| Unread dot | `size-1.5 rounded-full bg-accent shrink-0 animate-af-in`. Placed **before** the count so it never overlaps it |
| Count | `tabular text-[0.68rem] text-muted shrink-0` (`text-fg` when unread). Formatted with `compact()` from `lib/format.js` (`1.2k`). Total messages in the topic |

**Width budget.** A full title (9rem) plus two typical chips plus lead, dot and count is ≈19.8rem, so the tab cap is `20rem`, not 17rem.
When the content is still wider (long title and two 24-char tags), the title and the chips shrink in proportion, each with an ellipsis.
`+N`, the dot and the count never shrink. Nothing can paint outside the tab.
| Active indicator | `<span aria-hidden className="absolute inset-x-2 -bottom-1.5 h-0.5 rounded-full grad-accent animate-af-fade" />` |

Notes:
- **Corner radius `rounded-md` (≈5.4px), not `rounded-lg` (≈7.3px).** The global `:focus-visible` rule in `styles.css` is unlayered,
  so it beats Tailwind utilities, and it forces `border-radius: 6px`. `rounded-md` is the closest radius, so the tab keeps its shape on keyboard focus.
- **No font-weight change** between states. Inter Variable gets wider at 600, and neighbouring tabs would shift.
  Active and unread states use color, the raised pill and the indicator instead.
- **No close (×) button inside the tab.** A button inside `role="tab"` is an invalid nested interactive.
  Archive and close live in the context menu (§1.5) and the list (§3).

Tooltip (`title=`): `Agent mark shows 0 — #ui #bug — 12 messages · active 5m ago`.

### 1.3 States

| State | Classes / glyph | Notes |
|---|---|---|
| **Default (inactive)** | `border-transparent text-muted` | Title 6.25:1 (light) / 7.59:1 (dark) on the strip |
| **Hover** | `hover:bg-hover hover:text-fg` | `transition-colors duration-150` |
| **Active** (`aria-selected=true`) | `bg-raised text-fg border-line shadow-sm` + active indicator. Lead `#` glyph becomes `text-accent`, count stays `text-muted` | Only one active tab |
| **Focus-visible** | Global outline (2px, offset 1px, radius 6px) with color forced to full accent: `focus-visible:outline-accent!` | The global 70%-alpha accent outline is only 2.59:1 on the strip; full accent is 4.15–4.36:1 (§7.4). `!` is the Tailwind v4 important modifier and is needed because the global rule is unlayered |
| **Pressed** | `active:scale-[0.98]` | Same as `Button` |
| **Running** (mission executing for this topic) | Lead = `<LoaderCircle size={12} className="animate-spin text-accent motion-reduce:animate-none" />` | At most one running topic per project, because the mission queue is per project |
| **Planning** (GM is planning) | Lead = `<span className="size-1.5 rounded-full bg-info animate-af-pulse motion-reduce:animate-none" />` | Matches `STATUS_TONE.planning = 'info'` |
| **Queued** (order waiting behind another topic's mission) | Lead = `<span className="size-1.5 rounded-full bg-warn" />` (static) | Matches `STATUS_TONE.waiting = 'warn'` |
| **Failed** (last mission failed, not yet viewed) | Lead = `<CircleX size={12} className="text-bad" />` | Cleared when the topic is opened |
| **Unread** (new messages since last viewed, inactive only) | Title `text-fg`, unread dot, count `text-fg` | Never shown on the active tab |
| **Archived** (only when opened from the list, §3.5) | `border-dashed border-line-strong` (also when active), lead `<Archive size={12} className="text-subtle" />`, title `text-muted` | Temporary tab placed last. It disappears when the user switches away, unless unarchived |
| **Renaming** | Title replaced by `<input className="h-5 w-[9rem] px-1.5 -mx-1.5 rounded bg-sunken border border-accent outline-none text-[0.78rem]" />` | Same pattern as project rename in `Projects.jsx`: Enter or blur commits, Esc cancels, max 120 chars (server limit) |
| **Just created by the GM** (not auto-switched, §5.2) | Overlay `<span aria-hidden className="pointer-events-none absolute -inset-px rounded-md ring-2 ring-accent/40 transition-opacity duration-500 motion-reduce:transition-none" />` at `opacity-100` for 2s, then `opacity-0` | One-shot attention cue, together with `animate-af-in` on mount. It is a separate layer, so the 500ms fade-out doesn't also slow the tab's own `shadow-sm` transition when the active tab changes |
| **Idle** (none of the above) | Lead = `<Hash size={12} className={active ? 'text-accent' : 'text-subtle'} />` | Decorative glyph |

Lead-slot precedence when several apply: **running › planning › failed › queued › archived › idle.**
Unread is independent and can combine with any lead state.

### 1.4 Reference JSX (illustrative, for the implementer)

```jsx
<button role="tab" id={`topic-tab-${t.id}`} aria-selected={active} aria-controls="topic-panel"
  aria-label={t.title || 'New topic'} aria-describedby={`topic-tab-${t.id}-d`}
  tabIndex={t.id === focusId ? 0 : -1} title={tooltip(t)}
  onClick={() => openTopic(t.id)} onDoubleClick={() => setRenaming(t.id)} onContextMenu={(e) => topicMenu(e, t)}
  className={cx('relative shrink-0 inline-flex items-center gap-1.5 h-7 max-w-[20rem] pl-2 pr-2.5 rounded-md border text-[0.78rem] font-medium',
    'transition-[color,background-color,border-color,box-shadow,scale] duration-150 active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:outline-accent!',
    t.archived ? 'border-dashed border-line-strong' : active ? 'border-line' : 'border-transparent',
    active ? 'bg-raised text-fg shadow-sm' : 'text-muted hover:bg-hover hover:text-fg', mountedAfterStrip && 'animate-af-in')}>
  <TopicLead topic={t} active={active} />
  {/* one color class at a time: archived wins over active/unread (two text-* classes would race in the cascade) */}
  <span className={cx('truncate max-w-[9rem]', t.archived ? 'text-muted' : (unread || active) && 'text-fg')}>{t.title || 'New topic'}</span>
  {chips.length > 0 && <span aria-hidden className="flex items-center gap-1 min-w-0">{chips /* <TagChip fluid /> */}</span>}
  {unread && !active && <span aria-hidden className="size-1.5 rounded-full bg-accent shrink-0 animate-af-in" />}
  {showCount && <span aria-hidden className={cx('tabular text-[0.68rem] shrink-0', unread && !active ? 'text-fg' : 'text-muted')}>{compact(t.message_count)}</span>}
  <span id={`topic-tab-${t.id}-d`} className="sr-only">{describe(t)}</span>
  {active && <span aria-hidden className="absolute inset-x-2 -bottom-1.5 h-0.5 rounded-full grad-accent animate-af-fade" />}
  <span aria-hidden className={cx('pointer-events-none absolute -inset-px rounded-md ring-2 ring-accent/40 transition-opacity duration-500', isNewFromGm ? 'opacity-100' : 'opacity-0')} />
</button>
```

### 1.5 Tab context menu

Right-click, `Shift+F10` or the `ContextMenu` key opens the existing `openContextMenu` with:

| Item | Icon | Shortcut | Rule |
|---|---|---|---|
| Rename | `Pencil` | `F2` | Inline rename (§1.3) |
| Edit tags | `Tags` | — | Opens the tag editor anchored under the tab (§3.6) |
| `-` | | | |
| Archive / Unarchive | `Archive` / `ArchiveRestore` | — | Disabled while the topic is running, planning or queued ("Stop or wait for the mission first"). Disabled for the last open topic ("A project keeps at least one open topic") |
| Delete | `Trash2` | `Del` | `danger`. Same disabled rules as Archive. Opens `Confirm` (§3.5) |

When the menu is opened from the keyboard there is no pointer position. Pass the tab's rect as the position:
`{ clientX: r.left, clientY: r.bottom + 4 }`.

---

## 2. Tag chips

### 2.1 Normalisation and deterministic tone

```js
// lib/topics.js (suggested)
export const TAG_TONES = ['info', 'ok', 'warn', 'neutral'];
// Identical to normalizeTags() in server/services/topics.js, so client and server agree on the stored tag.
export const normTag = (t) => String(t).trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 24);
export function tagTone(tag) {
  let h = 0x811c9dc5;                                    // FNV-1a 32-bit
  for (const ch of normTag(tag)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;   // avalanche, so short tags spread evenly
  return TAG_TONES[(h >>> 0) % TAG_TONES.length];
}
```

Test vectors (use them in a unit test). The same tag gives the same tone in every topic, project, session and theme:

| Tag | Tone | | Tag | Tone | | Tag | Tone |
|---|---|---|---|---|---|---|---|
| `backend` | info | | `api` | info | | `refactor` | warn |
| `frontend` | neutral | | `bug` | ok | | `tests` | warn |
| `ui` | warn | | `docs` | ok | | `research` | ok |
| `design` | info | | `auth` | info | | `mobile` | neutral |
| `Backend`, ` #UI `, `##ui` | info, warn, warn (normalised) | | `perf` | warn | | `security` | warn |
| `history` (default tag of the backfilled **General** topic) | ok | | | | | | |

Distribution over 4,000 synthetic tags: info 994, ok 991, warn 992, neutral 1023, so even.

**Why only these four tones**
- **`accent` is excluded.** In this strip accent means *selected / live / unread* (indicator, spinner, unread dot).
  A tag in accent would dilute that. Accent is also user-chosen, so with `blue` or `emerald` it would collide with `info` or `ok`.
- **`bad` is excluded.** Red reads as an error and collides with the failed glyph and the **Stop** button.
- Four tones mean collisions are common. **Color only groups tags, it never identifies them**: the tag text is always shown (WCAG 1.4.1).
- A per-tag color override is out of scope for v1 and listed as a follow-up.

### 2.2 Chip classes

Tags are **pills** (`rounded-full`). Status badges stay `rounded-md` (`Badge`), so a tag never reads as a status, even in the same tone.

```js
const TAG_CLS = {
  info:    'bg-info-soft text-info-ink',
  ok:      'bg-ok-soft text-ok-ink',
  warn:    'bg-warn-soft text-warn-ink',
  neutral: 'bg-hover text-muted ring-1 ring-inset ring-line',
};
const TAG_SIZE = {
  xs: 'h-4 px-1.5 text-[0.68rem] gap-0.5',   // in tabs, list rows, notices
  sm: 'h-5 px-2 text-[0.7rem] gap-1',        // in filters, tag editor, empty state, /new preview
};
// <span className={cx('inline-flex items-center rounded-full font-medium whitespace-nowrap shrink-0', TAG_SIZE[size], TAG_CLS[tagTone(tag)])}>
//   <span className="truncate max-w-[5.5rem]">{tag}</span>
// </span>
```

- Text is the normalised tag, without a `#` (the `#` only appears in `/new` syntax).
- Max visible width `max-w-[5.5rem]` (≈80px), with truncation. The full tag is in the parent `title`.
- **Overflow chip** `+N`: neutral classes, `tabular`. `title="also: perf, docs"`.
- Neutral uses `ring-inset ring-line` instead of a border, so all four chips have the same box size.
- **`fluid` chips**: in single-line rows (tabs, list rows, the `/new` preview) a chip uses `min-w-0` instead of `shrink-0`, so it shrinks
  with an ellipsis instead of pushing past the row. Chips in wrapping containers (tag editor, empty state, notice) and in the filter
  scroller stay `shrink-0`.

### 2.3 Rendered values (both themes)

| Tone | Light fill (on raised) | Light text | Dark fill (on raised) | Dark text | Min contrast L / D |
|---|---|---|---|---|---|
| info | `--af-info` 14% → ≈`#e1ecf9` | `#275796` | ≈`#1b2636` | `#619de9` | 5.42 / 4.82 |
| ok | `--af-ok` 14% → ≈`#ddefe4` | `#1c6631` | ≈`#1a2e26` | `#65c98b` | 5.22 / 6.23 |
| warn | `--af-warn` 16% → ≈`#f3eadb` | `#805824` | ≈`#3a2f20` | `#f4bd6e` | 4.71 / 6.79 |
| neutral | `--af-hover` | `#5b5b63` | `--af-hover` | `#a1a1aa` | 5.59 / 5.54 |

Fills are the existing `-soft` tokens. The hex values are approximate composites on `bg-raised`, given for review only.
Implement with the token classes. The min-contrast column is the lowest value across all surfaces in §T.2.

### 2.4 Interactive chip variants

| Variant | Where | Classes |
|---|---|---|
| Filter toggle | List popover (§3.3) | `<button aria-pressed>` + `sm` chip + `cursor-pointer`. Off: as is. On: `ring-1 ring-inset ring-current` + leading `<Check size={10} />`. Hover (off): `hover:ring-1 hover:ring-inset hover:ring-line-strong`. Neutral-tone chips keep their `ring-line` when off and switch it to `ring-current` when on |
| Removable | Tag editor (§3.6) | `sm` chip + trailing `<button aria-label="Remove tag ui" className="-mr-1 size-4 rounded-full inline-flex items-center justify-center hover:bg-current/15"><X size={10} /></button>`. `bg-hover` was invisible on a tinted chip, while `current/15` tints with the chip's own ink |
| Add tag | Empty state, tag editor | `inline-flex items-center gap-1 h-5 px-2 rounded-full border border-dashed border-line-strong text-[0.7rem] text-muted hover:text-fg hover:border-accent transition-colors` + `Plus size={10}` "Add tag". Once the topic has tags it reads `Pencil size={10}` "Edit tags" |

**Focus on pills.** The global `:focus-visible` rule is unlayered and forces `border-radius: 6px`, so a focused pill would turn into a
rounded square. Every focusable pill (filter chips, remove ×, Add tag, empty-state suggestions) adds `focus-visible:rounded-full!`
alongside `focus-visible:outline-accent!`.

---

## 3. "+ New topic" and the "All topics" popover

### 3.1 + New topic

| Tier (§4.1) | Element |
|---|---|
| full | `<Button size="sm" variant="ghost" icon={Plus} className="focus-visible:outline-accent!">New topic</Button>` (h-7, `text-xs`) |
| compact, collapsed | `<IconButton icon={Plus} label="New topic" className="focus-visible:outline-accent!" />` (size-7) |

**Focus outline rule for this whole feature:** every focusable control that sits on the strip, the popover, the notice or the empty state
uses `focus-visible:outline-accent!`. The global 70% accent outline measures only 2.6:1 on these surfaces (§7.4).

Behaviour:
1. Create an untitled topic, append its tab (with `animate-af-in`), make it active, scroll it into view and focus the composer.
2. The tab reads **New topic** until it is named. The title comes from the GM's short title for the first order (backend `assignTopic`), or from a user rename.
   A user rename always wins.
3. If the active topic is empty and untitled, clicking **New topic** just focuses the composer. No duplicate empty topics are created.

### 3.2 All topics trigger

```jsx
<button aria-haspopup="dialog" aria-expanded={open} aria-label={`All topics (${total})`} title="All topics"
  className={cx('relative h-7 px-1.5 inline-flex items-center gap-1 rounded-md transition-colors focus-visible:outline-accent!',
    open ? 'bg-hover text-fg' : 'text-muted hover:text-fg hover:bg-hover')}>
  <LayoutList size={16} strokeWidth={1.9} />   {/* same glyph metrics as IconButton: matches the Plus beside it and the header icons above */}
  {tier === 'full' && <span className="tabular text-[0.68rem]">{total}</span>}
  <ChevronDown size={12} className="text-subtle" />
  {hiddenUnread && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-accent animate-af-in" />}
</button>
```

`hiddenUnread` is true when an unread topic's tab is scrolled out of view or the topic is archived. The implementation
recomputes it together with the fade (on scroll, resize and tab changes): a tab counts as hidden when its centre is outside the tablist.
This replaces the `IntersectionObserver` first suggested here, and the result looks the same.

### 3.3 Popover container

Non-modal popover, anchored to the strip (render it inside the strip's `relative` container):

```jsx
<div role="dialog" aria-label="All topics"
  className={cx('absolute top-full mt-1 z-40 max-h-[min(30rem,70vh)] flex flex-col rounded-xl border border-line bg-raised shadow-af-lg animate-af-in',
    tier === 'collapsed' ? 'right-2 w-[calc(100%-1rem)]'          // left edge flush with the switcher (mx-2)
                         : 'right-3 w-[min(24rem,calc(100%-1.5rem))]')}>   // right edge flush with the All topics trigger (pr-3)
  {/* 1. search + tag filters */}
  <div className="p-2 flex flex-col gap-2 border-b border-line">
    <Input autoFocus icon={Search} placeholder="Search topics and tags" value={q} onChange={…} />
    {tags.length > 0 && (
      <div role="group" aria-label="Filter by tag" onScroll={updateTagFade} onWheel={wheelToHorizontal}
        className={cx('flex items-center gap-1 overflow-x-auto overscroll-x-contain scroll-px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', FADE[tagFade])}>
        {tags.map(filterChip)}
        {selected.size > 0 && <button className="h-5 px-1.5 text-[0.7rem] text-muted hover:text-fg hover:underline shrink-0 focus-visible:outline-accent!">Clear</button>}
      </div>
    )}
  </div>
  {/* 2. list */}
  <ul aria-label="Topics" className="flex-1 min-h-0 overflow-auto p-1">{rows}</ul>
  {/* 3. footer: rounded-b-xl because the card has no overflow-hidden, so the tinted footer would otherwise show square corners */}
  <div className="flex items-center gap-2 h-9 px-2.5 border-t border-line bg-sunken/40 rounded-b-xl shrink-0">
    <Toggle checked={showArchived} onChange={setShowArchived} label={`Show archived (${archivedCount})`} />
    <span className="ml-auto inline-flex items-center gap-1 text-[0.7rem] text-muted">or type <Kbd>/new</Kbd></span>
  </div>
</div>
```

- Width is `24rem` (≈348px) and never wider than the pane minus 1.5rem. In the collapsed tier it fills the pane with 0.5rem margins.
- **Filter row overflow** uses the strip's pattern: hidden scrollbar, `FADE` edges (recomputed on scroll, resize and filter changes),
  and the vertical wheel mapped to horizontal. Without the wheel mapping, mouse users couldn't reach chips past the right edge.
- The header, rows and footer follow the slash-menu / `ContextMenu` look (`rounded-xl border-line bg-raised shadow-af-lg`), so it reads as part of the same family.
- The footer hint `or type /new` is hidden when the popover is narrower than `20rem` (`tier !== 'full'` is a good proxy).
- **Search** matches title and tags, case-insensitive substring. Matched substrings are wrapped in `<mark className="bg-accent-soft text-fg rounded-sm">`.
- **Tag filters** list every tag used in the project, ordered by use count (descending). Several selected tags combine with **AND**.

### 3.4 List row

```
 ┃ [⟳]  Agent mark shows 0                    ●  5m      ⋯
 ┃      (ui) (bug)                            12 msgs
```

```jsx
<li className={cx('group relative flex items-center gap-1 rounded-lg transition-colors', active ? 'bg-hover' : 'hover:bg-hover')}>
  {active && <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full grad-accent" />}
  <button data-row onClick={() => openTopic(t.id)} aria-current={active ? 'true' : undefined}
    className="flex-1 min-w-0 flex items-start gap-2.5 pl-2.5 pr-1 py-1.5 text-left rounded-lg focus-visible:outline-accent!">
    <span className="mt-0.5 size-6 rounded-md bg-sunken border border-line flex items-center justify-center shrink-0"><TopicLead topic={t} /></span>
    <span className="min-w-0 flex-1 flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span className={cx('text-[0.82rem] font-medium truncate', t.archived ? 'text-muted' : 'text-fg')}>{highlight(t.title)}</span>
        {unread && <span className="size-1.5 rounded-full bg-accent shrink-0" />}
        <span className="ml-auto text-[0.68rem] text-muted tabular shrink-0" title={dateTime(t.last_activity_at)}>{timeAgo(t.last_activity_at)}</span>
      </span>
      <span className="flex items-center gap-1 min-w-0">
        {chips /* up to 3 xs fluid chips + "+N" */}
        <span className="ml-auto text-[0.68rem] text-muted tabular shrink-0">{metaLine(t) /* "12 msgs" | "running · 2/9" | "queued" | "archived" */}</span>
      </span>
    </span>
  </button>
  <IconButton icon={Ellipsis} size="sm" label={`Actions for ${t.title}`} aria-haspopup="menu"
    className="mr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-accent!"
    onClick={rowMenu} />
</li>
```

- The `⋯` button appears on row hover, whenever focus is anywhere in the row (arrow-key users see the affordance), and always on
  touch devices (`hover:none`). `aria-expanded:opacity-100` was dropped because `ContextMenu` does not report an expanded state.

- Hover and active rows use **`bg-hover`, not `bg-accent-soft`**. This keeps light warn-ink chips at ≥ 4.5:1 (§T.2).
  The active row is marked by the same 3px `grad-accent` bar the project list uses.
- **Sorting**: running, then planning, then queued pinned on top. All other topics follow by `last_activity_at` (descending).
  Archived topics appear only when **Show archived** is on, under a header:
  `<li className="px-2.5 pt-2 pb-1 text-[0.66rem] font-semibold uppercase tracking-wider text-muted">Archived</li>`.
- Archived rows: title `text-muted`, lead `Archive`, meta `archived`.
- **Empty results**: one `<li className="py-8 px-4 flex flex-col items-center gap-2 text-center">` holding
  `<span className="text-xs text-muted">No topics match "{q}"</span>` and
  `<Button size="sm" variant="ghost" icon={Plus}>Create "{q}"</Button>`. The button creates a topic with that title.
  With no query and no filters, the copy reads "No open topics" and there is no button.
- **Opening** a row switches the topic, closes the popover and returns focus to the active tab.

### 3.5 Actions

The row menu `⋯` and the tab context menu use the same `openContextMenu` items as §1.5.

| Action | Interaction |
|---|---|
| **Rename** | The row title becomes `<input className="w-full h-6 px-1.5 -mx-1.5 rounded bg-sunken border border-accent outline-none text-[0.82rem]" />` (project-rename pattern). Enter or blur commits, Esc cancels |
| **Edit tags** | Tag editor (§3.6), anchored under the row |
| **Archive** | The row moves to the Archived group. Its tab leaves the strip. If it was active, the most recently active open topic becomes active |
| **Unarchive** | The row returns to the main list and its tab is appended to the strip |
| **Open an archived topic** | It opens as a temporary dashed tab (§1.3). Above the composer, inside its `p-3` wrapper (so no `mx-3`, and the bar lines up with the composer box), an inline bar: `<div className="mb-2 flex items-center gap-2 h-8 px-3 rounded-lg bg-sunken border border-line text-xs text-muted"><Archive size={13} className="shrink-0"/>This topic is archived.<Button size="sm" variant="ghost" icon={ArchiveRestore} className="ml-auto -mr-2">Unarchive</Button></div>`. Sending a message unarchives the topic automatically |
| **Delete** | `Confirm` with `danger`: title `Delete topic "Agent mark shows 0"?`, body `Removes its 12 messages from AgentForge. Tasks, files and commits made from this topic are kept.`, confirmLabel `Delete topic` |

Shared guardrails: Archive and Delete are disabled while the topic is running, planning or queued, and for the last open topic (§1.5).

### 3.6 Tag editor (sub-popover)

```jsx
<div role="dialog" aria-label={`Tags for ${t.title}`}
  className="absolute z-50 w-64 max-w-[calc(100%-1rem)] p-2 flex flex-col gap-1.5 rounded-xl border border-line bg-raised shadow-af-lg animate-af-in">
  <div className="flex flex-wrap items-center gap-1 min-h-8 px-1.5 py-1 rounded-lg bg-sunken border border-line
                  focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft">
    {tags.map(removableChip)}
    {/* focus-visible:outline-none!: the box shows focus via focus-within; the global outline would draw a second ring around the bare input */}
    <input autoFocus placeholder={tags.length ? '' : 'Add tag…'} className="flex-1 min-w-16 h-5 bg-transparent outline-none focus-visible:outline-none! text-[0.82rem] placeholder:text-subtle" />
  </div>
  {/* live preview of the new tag + suggestions */}
  <div role="listbox" className="flex flex-col">
    {draft && <div role="option" className="flex items-center gap-2 h-7 px-2 rounded-md hover:bg-hover text-xs text-muted">Create {chip(draft,'sm')}</div>}
    {suggestions.map((s) => <div role="option" className="flex items-center gap-2 h-7 px-2 rounded-md hover:bg-hover">{chip(s,'sm')}<span className="ml-auto text-[0.68rem] text-muted tabular">{uses}</span></div>)}
  </div>
</div>
```

Keys: **Enter** or **,** adds the draft (or the highlighted suggestion). **Backspace** in an empty input removes the last chip.
**↑ / ↓** move through suggestions. **Esc** closes and saves. Limits: 5 tags per topic, 24 chars per tag, normalised with `normTag`.
The preview chip shows its final hashed tone while the user types.

Anchoring: under the tab or row (clamped inside the strip) when opened from a menu. In the empty state (§5.1) it is centred under the
chip row and adds `max-w-none!`. That row shrink-wraps its chips, so the default `max-w-[calc(100%-1rem)]` would squash the editor to a few rem.

---

## 4. Narrow panes & overflow

### 4.1 Width tiers

The chat pane can shrink to `min: 25` (% of the window, `Projects.jsx`). That is ≈ 300–360px on 1280–1440px screens.
The strip measures its own width with a `ResizeObserver` (`useStripTier(stripRef)`). Thresholds are in rem, so they follow `--af-scale`:

| Tier | Strip width | px @ scale 1 | Strip content |
|---|---|---|---|
| **collapsed** | `< 24rem` | < 348 | No tablist. A **topic switcher** button (§4.3) + New topic icon. Hits the 25% pane on ≤ 1440px screens |
| **compact** | `24rem – 42rem` | 348–609 | Scrolling tablist with fade edges. Chips only on the **active** tab (max 1 + `+N`). Count only on active and unread tabs. New topic and All topics are icon-only |
| **full** | `≥ 42rem` | ≥ 609 | Scrolling tablist. Up to 2 chips + `+N` on every tab. Counts everywhere. New topic has a label. All topics shows the total count |

Vertical layouts (`stacked`, `tablet`, `mobile`) give the chat pane the full width, so they normally land in **full** or **compact**. Height is unaffected because the strip is fixed at `h-10`.

### 4.2 Horizontal scroll with fade edges (compact and full tiers)

- **No visible scrollbar** (`[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`). Content is reachable by trackpad or touch swipe,
  by the mouse wheel (vertical delta mapped to horizontal: `if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY`),
  and by keyboard focus (§7.3).
- **Fade edges** are an alpha mask, so they work identically on light and dark strips and never need a color:

```js
const FADE = {
  none: '',
  l:  '[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]',
  r:  '[mask-image:linear-gradient(to_left,transparent,black_1.5rem)]',
  lr: '[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]',
};
// updateFade(): l = scrollLeft > 1; r = scrollLeft + clientWidth < scrollWidth - 1
```

- Recompute the fade on scroll, on resize (`ResizeObserver`) and whenever tabs change.
- **Active tab always visible**: on activation, on focus and on mount call
  `tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' })`.
  `scroll-px-6` on the tablist keeps the tab clear of the 1.5rem fade.
- The New topic and All topics controls sit **outside** the scroller and never scroll away.
- Off-screen unread topics are surfaced by the dot on the All topics trigger (§3.2).

### 4.3 Collapsed tier: topic switcher

The tablist collapses into one button that names the active topic and opens the same **All topics** popover:

```jsx
<button aria-haspopup="dialog" aria-expanded={open} aria-label={`Topic: ${active.title}. ${otherUnread} other topics unread. Show all topics`}
  className="flex-1 min-w-0 mx-2 self-center h-7 inline-flex items-center gap-1.5 px-2 rounded-md bg-raised border border-line shadow-sm
             text-[0.78rem] font-medium text-fg hover:border-line-strong aria-expanded:border-line-strong transition-colors focus-visible:outline-accent!">
  <TopicLead topic={active} active />
  <span className="truncate">{active.title || 'New topic'}</span>
  <span className="tabular text-[0.68rem] text-muted shrink-0">{compact(active.message_count)}</span>
  {otherUnread > 0 && <span className="ml-auto inline-flex items-center gap-1 text-[0.68rem] text-muted tabular shrink-0"><span className="size-1.5 rounded-full bg-accent" />{otherUnread}</span>}
  <ChevronDown size={12} className={cx('text-subtle shrink-0', !otherUnread && 'ml-auto')} />
</button>
```

```
collapsed (~300px):   │ [⟳ Agent mark shows 0  12      ● 2 ▾] │ + │
compact   (~420px):   │ ░# General 214  ⟳ Agent mark sh… (ui) +1 12  # Compo░ ┆ + ☰ ▾ │
full      (~640px+):  │ # General 214   ⟳ Agent mark shows 0 (ui)(bug) ● 12   # Composer images (ui) 8 ┆ + New topic  ☰ 5 ▾ │
```

The popover (§3.3) then spans the pane width minus 1rem. In this tier, the list is the topic navigation.
`self-center` replaces the first draft's `my-1.5`, which overflowed the strip by 1px (`h-7` + 2 × `my-1.5` = 2.5rem, but the content box is 2.5rem − 1px of border).
While the popover is open the switcher keeps its `border-line-strong`, so it reads as the anchor.

---

## 5. New-topic empty state & GM auto-move notice

### 5.1 Empty state of a new topic

This replaces the project-level empty state (the `Workflow` hero) when the **project already has messages in other topics**.
A brand-new project keeps today's hero.

```jsx
<div className="h-full flex flex-col items-center justify-center text-center px-8 gap-3 animate-af-fade">
  <span className="size-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center"><Hash size={18} /></span>
  <div className="text-base font-semibold">{topic.title || 'New topic'}</div>
  <div className="flex flex-wrap justify-center gap-1">{topic.tags.map((t) => chip(t, 'sm'))}<AddTagChip /></div>
  <div className="text-xs text-muted max-w-md leading-relaxed">
    A fresh conversation: {gm} starts without the other topics' chat, so orders here stay short and cheap.
    Project files, tasks and agent memory are still shared.
  </div>
  <div className="flex flex-wrap justify-center gap-2 mt-1">
    {suggestions.map((s) => <button className="text-xs px-3 h-7 rounded-full border border-line hover:border-accent hover:text-accent transition-colors">{s}</button>)}
  </div>
  <div className="text-[0.7rem] text-muted">Tip: type <Kbd>/new</Kbd> in any topic to branch off</div>
</div>
```

- The icon is lighter than the project hero (`bg-accent-soft`, size-10, rather than `grad-accent`, size-12). It reads as "a thread within the project", not "a new project".
- Suggestion pills reuse the existing pill classes: "Summarize what was decided in General", "Continue: {last unfinished task}", "/standup".
- If the topic is untitled, the title line is a click-to-rename button
  (`hover:underline decoration-dotted underline-offset-4`, `title="Rename"`). A named title is
  `max-w-md [overflow-wrap:anywhere]`, so a 120-char title wraps to the same measure as the description below it.
- The suggestion pills and the Add tag chip follow the pill focus rule (§2.4).
- Composer focus is set automatically when the topic is created.
- **Copy accuracy**: the "fresh conversation" line is a product promise. The backend must actually scope the GM prompt to the topic.

### 5.2 Inline notice when the GM moves an order to a new topic

When the GM decides an incoming order is a different subject, it creates a topic and moves the order's mission there.
In the backend being built in parallel (`assignTopic` in `server/orchestrator/engine.js`), the user's order bubble **stays in the
origin topic**. The mission's messages move, `topic:new` (with `moved_from`) and `topic:moved` are emitted, and the GM posts a
`kind: 'status'` message in the origin with `meta.topic_id` = the new topic. The UI needs **three things**:

**(a) In the origin topic**, render that status message (`m.kind === 'status' && m.meta?.topic_id`) as a notice row,
directly under the order bubble, instead of the plain status line:

```jsx
<div className="mx-4 my-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-accent/30 bg-accent-soft/40 px-3 py-1.5 text-xs text-muted animate-af-in">
  <Split size={13} className="text-accent shrink-0" />
  <span className="min-w-0 flex-1">
    <b className="font-medium text-fg">{gm}</b> moved this order to a new topic{' '}
    <button className="font-medium text-fg hover:underline" onClick={open}>{title}</button>
  </span>
  {tags.slice(0, 2).map((t) => chip(t, 'xs'))}
  <span className="flex items-center gap-1 ml-auto">
    {undoable && (tier === 'full'
      ? <Button size="sm" variant="ghost" icon={Undo2}>Keep here</Button>
      : <IconButton size="sm" icon={Undo2} label="Keep here" />)}
    <Button size="sm" variant="secondary" icon={ArrowRight} onClick={open}>Open</Button>
  </span>
</div>
```

- Same visual family as the existing `summary` frame (`border-accent/40 bg-accent-soft/40`), but slimmer, because this is an event, not content.
- If the new topic was deleted since, the title renders as plain `text-fg` "{title} (deleted)" and the Open button is not shown.
- The row wraps (`flex-wrap`) on narrow panes. Buttons move to their own line, right-aligned.
- **Keep here** (undo) moves the mission back and deletes the new topic if it is still empty. It needs a backend endpoint
  that does not exist yet, so **v1 omits it** (`undoable` false). The layout already reserves its place.
  Once it ships, offer it only until the moved mission starts running.
- Text contrast: `text-muted` on the notice fill is ≥ 6.19:1 (light) and ≥ 6.71:1 (dark), and the chips are ≥ 4.88:1 (§7.4).

**(b) In the new topic**, a caption sits at the top of the message list:
`<div className="flex items-center justify-center gap-1 px-4 py-1.5 text-[0.68rem] text-muted"><CornerDownRight size={11} />Continued from an order in <button className="font-medium text-fg hover:underline">General</button></div>`.
The source is `moved_from` on the `topic:new` event. That field is not persisted on the topic row, so after a reload the caption
cannot be rebuilt. Persisting `moved_from` is listed in §10.

**(c) Switching rule**
- **Auto-switch** to the new topic only if all of these hold: the moved mission came from the user's latest order, the user is
  still viewing the origin topic, and the composer is empty. The user just sent it, so following the conversation is expected.
- **Otherwise** stay put. The new tab appears with `animate-af-in`, the 2s `ring-accent/40` highlight, an unread dot,
  and its lead state (usually planning or running).
- **Announce** through one persistent, visually hidden live region in `CommandWindow`:
  `<div aria-live="polite" className="sr-only">{announcement}</div>` → "Zen moved your order to a new topic: Agent mark shows 0."
  A persistent region is more reliable than inserting a new `role="status"` element.

---

## 6. `/new [title]` slash command

### 6.1 Command list entry

Add it as the first item of `SLASH`. It is the most frequent command:
`{ cmd: '/new', desc: 'Start a new topic — /new [title] [#tag …]', args: true }`.

**Tab** on a partial `/ne` completes to `/new ` **with a trailing space**, because the command takes arguments.

### 6.2 Argument hint

Today the menu hides as soon as the text contains a space (`!text.includes(' ')`). For commands with `args: true`,
show a **hint card** once the first line matches `^/new\s`. While the text is a bare `/new`, the slash menu is still open and its
`/new` row already shows the syntax, so the two cards never stack. It uses the same container as the slash menu:

```
┌─ absolute bottom-full left-3 right-3 mb-1 rounded-xl border border-line bg-raised shadow-af-lg p-1 animate-af-in ─┐
│  /  /new  Agent mark shows 0  #ui #bug                                         [Enter] create topic │  row 1
│     # Agent mark shows 0  (ui) (bug)  · then sends 2 lines as the first order                        │  row 2 (preview)
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Row | Spec |
|---|---|
| 1 — syntax | `flex items-center gap-2 h-8 px-2.5`: `<Slash size={12} className="text-accent" />` · `mono text-xs font-medium` "/new" · argument area `mono text-xs`. Parts not typed yet are shown as `text-muted` placeholders `[title] [#tag …]`. Typed parts are shown in `text-fg`. Right: `ml-auto` `<Kbd>Enter</Kbd>` + `text-[0.7rem] text-muted` "create topic" |
| 2 — preview | Shown once a title, tag or body exists. `flex items-center gap-1.5 px-2.5 pb-1.5 min-w-0`: `<Hash size={12} className="text-subtle" />` + title `text-[0.82rem] font-medium truncate` (or *New topic*) + `sm` **fluid** chips in their **final hashed tone** (five tags must not push the card wider than the composer) + `text-[0.7rem] text-muted truncate` "· then sends N lines as the first order" |

### 6.3 Grammar and behaviour

```
/new [title words…] [#tag …]⏎?[first order body…]
```

- **Title**: the first line after `/new`, without `#tag` tokens and trimmed. Max 120 chars (server `cleanTitle`); the preview shows a `text-warn-ink` "title will be shortened" note above that.
  An empty title creates **New topic**, which the GM names later (§3.1).
- **Tags**: the regex `#[\p{L}\p{N}_-]{1,24}` (Unicode), normalised with `normTag`, max 5 tags. Extras are ignored and the preview says "max 5 tags".
- **Body**: lines after the first (Shift+Enter) are sent as the **first order** in the new topic.
- **Enter**: create the topic, switch to it, send the body if there is one, and clear the composer. Attached images go with the body. Without a body, the images stay in the composer of the new topic.
- **Esc**: hide the hint and keep the text.
- **Discoverability**: the empty states (§5.1) and the popover footer (§3.3) both mention `/new`.

---

## 7. Accessibility

### 7.1 Roles & ARIA

| Element | Markup |
|---|---|
| Strip scroller | `role="tablist" aria-label="Topics" aria-orientation="horizontal"`. It contains **only** tabs. New topic and All topics are siblings outside it |
| Tab | `<button role="tab" id="topic-tab-{id}" aria-selected aria-controls="topic-panel" aria-label="{title}" aria-describedby="topic-tab-{id}-d" tabIndex={roving}>` |
| Tab description | `sr-only` text, e.g. "Running. 3 unread. 12 messages. Tags: ui, bug." or "Archived. 40 messages." Chips, dot and count are `aria-hidden` to avoid double reading |
| Message list | `role="tabpanel" id="topic-panel" aria-labelledby="topic-tab-{activeId}" tabIndex={0}` (the existing scroller). `tabIndex=0` lets keyboard users scroll it |
| All topics trigger / collapsed switcher | `aria-haspopup="dialog" aria-expanded`, plus an explicit `aria-label` that includes the count / unread count |
| Popover | `role="dialog" aria-label="All topics"` (non-modal, no focus trap). The list is a plain `<ul>` of rows. Each row has a primary `<button>` (opens the topic, `aria-current` when active) and a separate actions `<IconButton>` |
| Filter chips | `<button aria-pressed>` inside `role="group" aria-label="Filter by tag"` |
| Tag editor | `role="dialog"`. The suggestions are `role="listbox"` / `option`, with `aria-activedescendant` on the input |
| Live region | One persistent `aria-live="polite"` `sr-only` node per `CommandWindow` (§5.2c). It also announces "Topic created: …" and "Topic archived: …" |

### 7.2 Activation model

Tabs use **manual activation**: arrow keys move focus, and Enter or Space opens the topic. Opening a topic can fetch messages from
the server while agents are streaming. Per the WAI-ARIA APG, manual activation avoids firing a load on every arrow press.
Mouse click activates immediately.

### 7.3 Keyboard map

| Context | Key | Action |
|---|---|---|
| Tablist | `←` / `→` | Focus the previous / next tab (wraps) and scroll it into view |
| | `Home` / `End` | First / last tab |
| | `Enter` / `Space` | Open the focused topic |
| | `F2` | Rename the focused topic |
| | `Delete` | Delete the focused topic (opens `Confirm`, same as the project list) |
| | `Shift+F10` / `ContextMenu` | Actions menu, positioned at the tab |
| | `Tab` | Leave to New topic → All topics → message panel |
| Popover | (on open) | Focus goes to search |
| | `↓` from search | First row. `↑` / `↓` move between rows (roving focus on the row buttons) |
| | `Enter` | Open topic, close popover, focus returns to the active tab |
| | `F2`, `Shift+F10` | Rename / actions for the focused row |
| | `Esc` | Close the innermost layer first (rename → tag editor → popover). Focus returns to the trigger |
| | Focus leaving the popover or clicking outside | Close |
| Composer | `Tab` on `/ne` | Complete to `/new ` |

**Known gap (not introduced here):** `ContextMenu.jsx` does not move focus into the menu and has no arrow-key navigation.
Keyboard users reach topic actions through `F2` / `Delete` and the popover row buttons, but the menu itself should be fixed (see proposals).

### 7.4 Contrast (WCAG 2.x, computed)

Method: relative luminance per WCAG 2.x. Alpha fills are composited in sRGB over the real surface. `color-mix` is
computed in OKLab. The accent is the default `indigo`. Strip = `bg-sunken/60` over `bg-panel`.

| Element | Requirement | Light | Dark | |
|---|---|---|---|---|
| Inactive title / count, `text-muted` on strip | 4.5:1 | 6.25 | 7.59 | ✓ |
| Active title, `text-fg` on raised | 4.5:1 | 18.71 | 15.44 | ✓ |
| `text-subtle` on strip (would-be counts) | 4.5:1 | 3.10 | 3.86 | ✗ — so **not used for information** here, only decorative glyphs |
| Tag ink on own fill, worst case | 4.5:1 | 4.71 (warn, input bg) | 4.82 (info, list-row hover) | ✓ |
| Neutral tag, `text-muted` on `bg-hover`, worst case | 4.5:1 | 5.59 | 5.54 | ✓ |
| Unread dot / active indicator vs strip (`bg-accent`) | 3:1 non-text | 4.15 | 4.36 | ✓ |
| Tab focus outline, full accent | 3:1 non-text | 4.15 | 4.36 | ✓ |
| ↳ global outline (accent @70%) if not overridden | 3:1 | 2.59 | 2.69 | ✗ — hence `focus-visible:outline-accent!` |
| Notice text, `text-muted` on `bg-accent-soft/40` (indigo, amber, emerald, mono) | 4.5:1 | ≥ 6.19 | ≥ 6.71 | ✓ |
| Tag chips inside the notice | 4.5:1 | ≥ 4.88 | ≥ 5.15 | ✓ |

Accent variations (unread dot vs strip, light / dark): violet 3.94 / 4.60, blue 3.42 / 5.29, rose 3.41 / 5.30, mono 7.18 / 15.33 ✓.
**`emerald` (2.36) and `amber` (2.00) fail 3:1 in light theme.** For that reason unread is never color-only: it also
changes the title to `text-fg` and has `sr-only` text. The active tab is also never color-only: it has the raised pill, border and shadow, and `aria-selected`.
The accent palettes themselves are an app-wide issue (proposal).

### 7.5 Targets & motion preferences

- Tab `h-7` is ≈25.4px, above the 24px minimum (WCAG 2.5.8). Under the `compact` and `dense` presets (scale 0.93 / 0.86) it drops to ≈23.6 / 21.8px, like every other control in those opt-in dense layouts. This is accepted.
- Every animation in §8 has a `motion-reduce:` fallback. The status meaning (running, planning) is still there without motion: the spinner becomes a static `LoaderCircle` glyph and the pulse dot becomes static. Programmatic scrolling uses `behavior: 'auto'` when `prefers-reduced-motion: reduce`.

---

## 8. Motion

Only existing keyframes are used: `animate-af-in` (160ms, `cubic-bezier(.2,.8,.2,1)`, 4px rise + 0.985 scale), `animate-af-fade` (160ms),
`animate-af-pulse` (1.6s), and Tailwind `animate-spin`. **No new keyframes.**

| Element | Animation | When | Reduced motion |
|---|---|---|---|
| New tab | `animate-af-in` | Only for tabs created after the strip mounted. Track `created_at > mountedAt`, so switching projects doesn't animate every tab | `motion-reduce:animate-none` |
| Active indicator | `animate-af-fade` | On activation (keyed by topic id) | `motion-reduce:animate-none` |
| Tab colors | `transition-[color,background-color,border-color,box-shadow,scale] duration-150` | Hover, active, unread | Kept (not motion) |
| Tab press | `active:scale-[0.98]`, eased by the `scale` entry above (Tailwind v4 scales with the `scale` property, not `transform`) | Pointer press | `motion-reduce:active:scale-100` |
| Running lead | `animate-spin` | While running | Static glyph |
| Planning lead | `animate-af-pulse` | While planning | Static dot |
| Unread dot, hidden-unread dot | `animate-af-in` | When it appears | `motion-reduce:animate-none` |
| All topics popover, tag editor, `/new` hint | `animate-af-in` | Open. Close is instant, like every other popover in the app | `motion-reduce:animate-none` |
| Topic switch | Message list wrapper keyed by topic id with `animate-af-fade`. Each message keeps its existing `animate-af-in` | On switch | `motion-reduce:animate-none` |
| New-topic empty state | `animate-af-fade` | Mount | `motion-reduce:animate-none` |
| Auto-move notice | `animate-af-in` | Insert | `motion-reduce:animate-none` |
| GM-created tab highlight | Overlay span `ring-2 ring-accent/40`, faded out after 2s with `transition-opacity duration-500` (§1.3) | §5.2c | `motion-reduce:transition-none`: ring is removed without transition |
| Scroll active tab into view | `scrollIntoView({ behavior: 'smooth' })` | Activate / focus | `behavior: 'auto'` |

Archive and delete remove the tab instantly. There are no exit animations or FLIP reflow, matching the rest of the app.

---

## 9. Light / dark summary

Everything above is token-driven, so both themes are covered by `data-theme`. Here are the rendered results, to review side by side:

| Element | Light | Dark |
|---|---|---|
| Strip `bg-sunken/60` | `#f7f7f5` | `#0d0d10` |
| Active tab `bg-raised` + `border-line` + `shadow-sm` | `#ffffff`, 8.5% black hairline, soft shadow visible | `#16161a`, 7.5% white hairline. The shadow is barely visible, so the border and indicator carry the lift |
| Hover `bg-hover` | 4.5% black | 4.5% white |
| Active indicator `grad-accent` | accent → accent-2 | same |
| Tag chips | tinted fills with deep inks (`#275796` / `#1c6631` / `#805824`) | tinted fills with light inks (`#619de9` / `#65c98b` / `#f4bd6e`) |
| Fade edges | alpha mask, no color | alpha mask, no color |
| Popover `bg-raised` + `shadow-af-lg` | white card, 6% black ring | `#16161a` card, 6% white ring |

QA must check every state in §1.3 in **both themes** and with at least the `indigo`, `amber` and `mono` accents.

---

## 10. Hand-off checklist (frontend)

Suggested files:
- `client/src/lib/topics.js`: `normTag`, `tagTone`, `TAG_CLS`, `TAG_SIZE`, the `/new` parser, plus a unit test with the §2.1 vectors.
- `client/src/views/projects/TopicStrip.jsx`: the strip, tabs, switcher, `useStripTier`, fade logic.
- `client/src/views/projects/TopicList.jsx`: the popover and the tag editor.
- `client/src/components/ui.jsx`: `TagChip` export, next to `Badge`.
- `client/src/styles.css`: the 3 ink tokens and `--af-ink-mix` (§T.2). Nothing else.
- `CommandWindow.jsx`: mount the strip, scope messages, the mission bar and the placeholder to the active topic. Add the notice renderer for status messages with `meta.topic_id`, the `/new` SLASH entry and its hint, and the live region.

**Data mapping** to the backend in progress (`server/services/topics.js`, `server/db/schema.sql`, uncommitted at the time of writing):

| UI need | Backend field / event | Gap → how the UI behaves |
|---|---|---|
| Title, tags, archived, count, activity | `title` (default `'New topic'`, cleaned to 120 chars), `tags` (≤ 5, `normalizeTags`), `archived`, `message_count`, `last_activity_at` | None. **Untitled** = `title === 'New topic' && !title_locked`. User renames send `title_locked: true`. Rename and `/new` titles are capped at **120 chars**, matching `cleanTitle` (the tab still truncates visually at 9rem) |
| Running / planning lead | `running` (mission `planning` or `running`) + the client's `missions[projectId].status` for that topic | Planning vs running comes from the mission status |
| Queued, failed leads | Not exposed per topic | Derive from mission rows with `topic_id` if the client has them. Otherwise these states are simply not shown |
| Unread | Not server-side | Client-side: `lastSeen[topicId]` (message count or timestamp) persisted in `localStorage`. Bump it when the topic is active and the list is scrolled to the bottom |
| Live updates | WS `topic:new`, `topic:update`, `topic:delete`, `topic:moved` | `topic:new` with `moved_from` drives §5.2c. `topic:delete` of the active topic switches to the most recently active open topic |
| Auto-move notice | `status` message with `meta.topic_id` | See §5.2a |
| "Continued from" caption after reload | `moved_from` only on the event | Proposal: persist `moved_from_topic_id` on `topics` |
| Keep here (undo) | — | v1 omits it (§5.2) |
| `/new` | `submitCommand` handles `/stop`, `/standup`, `/sync` | Needs a create-topic endpoint, or a `/new` branch in `submitCommand`, that accepts title, tags and an optional body |

Out of scope for v1: drag-to-reorder tabs, per-tag color override, global keyboard shortcuts for switching topics,
merging topics.

Acceptance for the build:
1. All §1.3 states render as specified in light and dark themes.
2. At 25% pane width the strip is in the **collapsed** tier, and every topic can be reached through the switcher.
3. Axe or Lighthouse shows no tablist/tab ARIA errors.
4. The §2.1 hash vectors pass.
5. Keyboard-only users can create, switch, rename, tag, archive and delete topics.

---

## 11. Implementation review — design polish pass (T5, 2026-10-30)

I compared `TopicBar.jsx`, the topic parts of `CommandWindow.jsx` and the `styles.css` tokens with this spec. Every deviation is listed
below as either **fixed in code** or **adopted into the spec** (the sections above were updated to match). These were presentation-only changes:
classes, markup structure and one presentational scroll-fade hook. Store, API calls and data flow are untouched.

### 11.1 Fixed in code

| # | Where | Problem | Fix |
|---|---|---|---|
| 1 | Tab, list row, `/new` preview | Chips were `shrink-0` inside single-line rows. A long title plus two chips overflowed the 17rem tab and painted over the count and the tab edge. In list rows and the preview they spilled over the `⋯` button or the card edge | `TagChip fluid` (`min-w-0`, ellipsis) in single-line rows. The tab cap is raised to 20rem (§1.2 width budget), and the count is `shrink-0` |
| 2 | Tab title | Archived + active (or unread) put `text-fg` and `text-muted` on one element, so the cascade decided the color | One color class at a time: archived wins |
| 3 | Tag editor input | The global unlayered `:focus-visible` outline beat `outline-none`, drawing a second ring inside the focus-within box | `focus-visible:outline-none!` on the bare input |
| 4 | Empty-state tag editor | It was anchored to a shrink-wrapped chip row, so `max-w-[calc(100%-1rem)]` squashed it to a few rem | `max-w-none!` there (§3.6) |
| 5 | Filter row (popover) | No fade edges (§3.3 asked for `FADE[tagFade]`), and mouse users could not scroll it (hidden scrollbar, no wheel mapping) | `useEdgeFade` + `FADE`, `scroll-px-6`, `overscroll-x-contain`, wheel → horizontal |
| 6 | Strip right side | `pr-2` left the All topics chevron ≈5px inside the header's icon column | `pr-3`. The popover anchors `right-3` so it stays flush with the trigger (§1.1, §3.3) |
| 7 | Focus outlines | New topic, All topics, filter chips, Clear, row `⋯`, remove ×, the notice link, empty-state title, pills and suggestions used the global 70% outline (≈2.6:1, fails 3:1) | `focus-visible:outline-accent!` on all of them. Pills also get `focus-visible:rounded-full!`, because the global rule forces a 6px radius |
| 8 | GM highlight | Ring removal used the tab's 150ms transition, not the specified 500ms. Slowing the tab's `box-shadow` would also have made the active tab's shadow linger | Separate overlay span with `transition-opacity duration-500` (§1.3) |
| 9 | Tab press | `active:scale` was not in the transition list, so the press snapped | `scale` added to the transition properties |
| 10 | All topics icon | `LayoutList` 15px / stroke 2 beside a 16px / 1.9 `Plus` (compact tier) and under 16px / 1.9 header icons | 16px / stroke 1.9 |
| 11 | Remove-tag × hover | `hover:bg-hover` was invisible on tinted chips | `hover:bg-current/15` |
| 12 | Row `⋯` | Invisible to arrow-key users and on touch screens | Also shown on `group-focus-within` and `@media (hover: none)` |
| 13 | Collapsed switcher | No open-state cue | `aria-expanded:border-line-strong` |
| 14 | Empty strip placeholder | `px-3` sat 0.25rem left of the header text | `px-4` |
| 15 | Empty search results | `py-6` (spec `py-8`) | `py-8` |
| 16 | Empty state | The Add tag chip showed `Plus` + "Edit tags" or "Edit" once tags existed. A 120-char title ran wider than the copy under it | `Pencil` + "Edit tags". The title is `max-w-md [overflow-wrap:anywhere]` |
| 17 | Archived bar | Icon could shrink on narrow panes | `shrink-0` |

### 11.2 Adopted into the spec (implementation is better or equivalent)

| Where | Implementation | Why it stays |
|---|---|---|
| Popover footer | `rounded-b-xl` added | The card has no `overflow-hidden`, so the tinted footer would show square corners |
| Collapsed switcher | `self-center` instead of `my-1.5` | `my-1.5` overflowed the strip's content box by 1px |
| Archived bar | No `mx-3`, `-mr-2` on Unarchive | It lives inside the composer's `p-3`, so it already lines up with the composer box |
| `hiddenUnread` | Rect check during the fade measurement instead of an `IntersectionObserver` | Same result, one measurement pass (§3.2) |
| `/new` hint | Appears after `/new␠`, not on a bare `/new` | The slash menu's `/new` row covers the bare state, so the cards never stack (§6.2) |
| Moved notice | "{title} (deleted)" without Open when the target topic is gone | Avoids a dead link (§5.2) |
| Row `⋯` | No `aria-expanded:opacity-100` | `ContextMenu` exposes no expanded state (§3.4) |
| Neutral filter chips | Keep `ring-line` off, `ring-current` on | Neutral chips already have a ring, so an off-state ring keeps all filters the same size (§2.4) |
| Files | Everything in `TopicBar.jsx` (strip, list, tag editor, `TagChip`) instead of the suggested `TopicStrip.jsx` / `TopicList.jsx` / `ui.jsx` split | The §10 split was a suggestion. Moving `TagChip` to `ui.jsx` is a reasonable follow-up once `Badge` moves to the inks |

### 11.3 Verified

- `npm run build` passes with no warnings (built to a temp `--outDir`, so the live `client/dist` was not touched). Every new utility
  (`focus-visible:rounded-full!`, `focus-visible:outline-none!`, `max-w-none!`, `hover:bg-current/15`, `aria-expanded:*`,
  `[@media(hover:none)]:*`, `group-focus-within:*`, the `…,scale` transition list) is present in the compiled CSS, and the fade mask compiles to
  `linear-gradient(90deg,#0000,#000 1.5rem calc(100% - 1.5rem),#0000)`.
- The `text-{info,ok,warn}-ink` utilities compile from the §T.2 tokens. The §2.1 hash vectors (18) pass against `client/src/lib/topics.js`.
- Not verified in a browser: no headless browser is installed on this host, so the in-app check in both themes (§9) is still for QA.
