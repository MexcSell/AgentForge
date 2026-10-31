import { useEffect, useId, useRef, useState } from 'react';
import { GitMerge, ChevronDown } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { Confirm } from '../../components/Modal.jsx';
import { cx, Button, Select } from '../../components/ui.jsx';
import { HandOverList } from './HandOverPreview.jsx';

// Same set as the server's SYSTEM_ROLES (services/agents.js): the roles the organization runs on are never consolidated.
export const SYSTEM_ROLES = new Set(['executive', 'evolution', 'analyst', 'optimizer', 'manager']);
export const CONSOLIDATE_BUSY = 'Every agent to merge is busy — consolidate when one is idle';

const isBusy = (a) => a.status === 'working' || a.active_tasks > 0;
// The server's keeper order (consolidatePlan): level, XP, oldest, id; the first live agent is the default keeper
const keeperOrder = (x, y) => y.level - x.level || y.xp - x.xp || new Date(x.created_at) - new Date(y.created_at) || (x.id < y.id ? -1 : 1);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// The gains line of the server's merge and consolidate notifications
const gains = (g) => `+${g.xp} XP · ${g.skills} skills · ${g.lessons} lessons${g.playbookVersion ? ` · playbook v${g.playbookVersion}` : ''}`;

/**
 * Roles that can be consolidated: non-system roles with 2+ live agents, as { role, count, busy }. busy: every agent but
 * the keeper the server would pick (level, XP, oldest) is working, so nothing would merge.
 */
export function consolidatableRoles(agents) {
  const by = new Map();
  for (const a of agents) if (!a.archived && !SYSTEM_ROLES.has(a.role)) by.set(a.role, [...(by.get(a.role) || []), a]);
  return [...by].filter(([, list]) => list.length > 1).sort(([x], [y]) => x.localeCompare(y)).map(([role, list]) => {
    const keeper = list.slice().sort((x, y) => y.level - x.level || y.xp - x.xp || new Date(x.created_at) - new Date(y.created_at) || (x.id < y.id ? -1 : 1))[0];
    return { role, count: list.length, busy: list.every((a) => a === keeper || isBusy(a)) };
  });
}

/**
 * Toolbar menu of the roles with 2+ live agents; picking one calls onPick(role). Hidden when no role qualifies.
 * Arrow keys move between items, Escape closes and returns focus to the trigger. A role whose candidates are all busy
 * stays focusable (aria-disabled) so its hint can be read.
 */
export function ConsolidateMenu({ onPick }) {
  const agents = useStore((s) => s.agents);
  const titles = useStore((s) => s.roles?.roles);
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const menu = useRef(null);
  const menuId = useId();
  const roles = consolidatableRoles(agents);
  useEffect(() => { if (open) menu.current?.querySelector('[role="menuitem"]')?.focus(); }, [open]);
  useEffect(() => { if (!roles.length) setOpen(false); }, [roles.length]);
  if (!roles.length) return null;
  const close = (refocus) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const onKey = (e) => {
    const items = [...menu.current.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    const go = (j) => { e.preventDefault(); items[(j + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  };
  return (
    <div className="relative shrink-0" onBlur={(e) => { if (open && !e.currentTarget.contains(e.relatedTarget)) close(false); }}>
      <Button ref={trigger} size="sm" variant="ghost" icon={GitMerge} aria-label="Consolidate a role" title="Merge every idle agent of a role into one" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        Consolidate<ChevronDown size={12} aria-hidden="true" className="text-subtle" />
      </Button>
      {open && (
        <div ref={menu} id={menuId} role="menu" aria-label="Consolidate a role" onKeyDown={onKey}
          className="absolute right-0 top-full mt-1 z-40 min-w-60 py-1 rounded-xl border border-line bg-raised shadow-af-lg animate-af-in motion-reduce:animate-none">
          {roles.map(({ role, count, busy }) => (
            <button key={role} type="button" role="menuitem" aria-disabled={busy || undefined} title={busy ? CONSOLIDATE_BUSY : undefined}
              onClick={() => { if (busy) return; close(true); onPick(role); }}
              className={cx('w-[calc(100%-8px)] mx-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-[0.8rem] text-left', busy ? 'text-subtle cursor-not-allowed' : 'text-fg hover:bg-accent-soft focus-visible:bg-accent-soft')}>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{titles?.[role]?.title || role}</span>
                {busy && <span className="block text-[0.68rem] text-subtle">All busy — try when one is idle</span>}
              </span>
              <span className="text-[0.7rem] text-subtle tabular">{plural(count, 'agent')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Row of the preview: name and what it adds or why it is skipped. */
const Row = ({ name, children }) => (
  <li className="flex items-baseline gap-2 min-w-0"><span className="font-medium text-fg truncate">{name}</span><span className="ml-auto shrink-0 text-[0.72rem] tabular">{children}</span></li>
);

/**
 * What the keeper ends up with (the preview's `result`): every skill with its level (new or raised ones highlighted),
 * the lessons and failures moved in, and the playbook version. Chips wrap, so the sm dialog never scrolls sideways.
 */
function Result({ keeper, result, merged }) {
  const before = new Map((keeper.skills || []).map((s) => [s.name, s.level]));
  const skills = (result.skills || []).slice().sort((x, y) => y.level - x.level || x.name.localeCompare(y.name));
  const lessons = merged.reduce((n, m) => n + m.lessons, 0);
  const failures = merged.reduce((n, m) => n + (m.failures || 0), 0);
  const v = result.prompt_version;
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.72rem]">
      <dt className="text-subtle">Skills</dt>
      <dd className="min-w-0">
        {skills.length ? (
          <ul aria-label={`Skills after consolidating · ${skills.length}`} className="flex flex-wrap gap-1">
            {skills.map((k) => {
              const was = before.get(k.name);
              const up = was == null || k.level > was;
              return (
                <li key={k.name} title={was == null ? 'New skill' : up ? `Was ${was}` : undefined}
                  className={cx('max-w-full truncate px-1.5 py-0.5 rounded border', up ? 'border-accent bg-accent-soft text-fg' : 'border-line bg-sunken text-muted')}>
                  {k.name} <b className="tabular">{k.level}</b>{was == null ? <span className="sr-only"> (new)</span> : up && <span className="sr-only"> (was {was})</span>}
                </li>
              );
            })}
          </ul>
        ) : <span className="text-subtle">None</span>}
      </dd>
      <dt className="text-subtle">Lessons</dt>
      <dd className="tabular">+{plural(lessons, 'lesson')}{failures > 0 && ` · ${plural(failures, 'failure')}`} moved in</dd>
      {v != null && <>
        <dt className="text-subtle">Playbook</dt>
        <dd className="tabular">{v !== keeper.prompt_version ? `v${keeper.prompt_version} → v${v}` : `v${v}, unchanged`}</dd>
      </>}
    </dl>
  );
}

/**
 * Confirms consolidating `role` (null = closed) with the server preview: the keeper, each agent merged and what it adds,
 * the busy agents skipped and the pending work handed over. The Keeper picker lists the role's live agents (busy ones
 * too: a working agent can keep, only the merged ones must be idle); null = the server's default, previewed without
 * keeperId. A pick that leaves the roster falls back to the default; it resets when `role` changes or the dialog closes.
 * A late answer for another role, keeper or an older roster is never shown, and Confirm waits for the current one. The
 * POST pins the previewed keeper; the roster follows from the agent:delete / agent:update events.
 */
export function ConsolidateConfirm({ role, onClose }) {
  const title = useStore((s) => (role && s.roles?.roles?.[role]?.title) || role);
  // Refetch when an agent of the role starts or stops working, so the merged and skipped lists stay true while open
  const rev = useStore((s) => role ? s.agents.filter((a) => a.role === role).map((a) => `${a.id}:${isBusy(a) ? 1 : 0}`).join(',') : '');
  const roster = useStore((s) => s.agents);
  const list = role ? roster.filter((a) => a.role === role && !a.archived).sort(keeperOrder) : [];
  const pickId = useId();
  const [picked, setPicked] = useState(null); // keeper id the user chose; null = the server's default
  useEffect(() => setPicked(null), [role]);
  // A picked agent that was merged, archived or deleted meanwhile falls back to the default (no stuck 400)
  const keeperId = picked && list.some((a) => a.id === picked) ? picked : null;
  useEffect(() => { if (picked && !keeperId) setPicked(null); }, [picked, keeperId]);
  const url = role && `/api/agents/consolidate/preview?role=${encodeURIComponent(role)}${keeperId ? `&keeperId=${encodeURIComponent(keeperId)}` : ''}`;
  const key = url && `${url}#${rev}`;
  const [res, setRes] = useState(null); // { url, key, data } | { url, key, error }: the answer to the request for `key`
  const [def, setDef] = useState(null); // { role, id }: the keeper the server picked in the last default preview
  useEffect(() => {
    if (!url) return setRes(null);
    let live = true;
    api.get(url, { quiet: true }).then((data) => {
      if (!live) return;
      setRes({ url, key, data });
      if (!keeperId) setDef({ role, id: data.keeper.id });
    }, (e) => live && setRes({ url, key, error: e.message || 'Preview failed' }));
    return () => { live = false; };
  }, [key]);
  const defId = (def?.role === role && list.some((a) => a.id === def.id) && def.id) || list[0]?.id;
  const cur = res?.key === key ? res : null;
  // While a refetch for a newer roster runs, the last preview of this role and keeper stays up; another keeper's
  // preview never does (its url differs), and confirming waits for the current one
  const p = res?.url === url ? res : null;
  const d = p?.data;
  return (
    <Confirm open={!!role} title={`Consolidate ${title} agents?`} confirmLabel="Consolidate" confirmDisabled={!cur?.data?.merged?.length} onClose={onClose}
      body={<>Every idle {title} agent is merged into one keeper: their skills, XP, lessons and playbooks are combined, and the others are retired. Task history stays.
        {list.length > 0 && (
          <div className="mt-3 flex flex-col min-w-0">
            <label htmlFor={pickId} className="text-[0.68rem] font-semibold uppercase tracking-wider text-subtle mb-1">Keeper</label>
            <Select id={pickId} value={keeperId || defId} onChange={(e) => setPicked(e.target.value === defId ? null : e.target.value)} className="w-full min-w-0">
              {list.map((a) => (
                <option key={a.id} value={a.id}>{a.name} · L{a.level} · {a.xp} XP{isBusy(a) ? ' · busy' : ''}{a.id === defId ? ' (default)' : ''}</option>
              ))}
            </Select>
          </div>
        )}
        <div aria-live="polite" className="mt-2 text-[0.8rem] leading-snug">
          {!p ? <div className="text-[0.75rem] text-subtle">Loading preview…</div>
            : p.error ? <div className="text-bad">{p.error}</div>
              : (
                <div className="flex flex-col gap-3">
                  <div>
                    <ul aria-label="Keeper"><Row name={d.keeper.name}>L{d.keeper.level} · {d.keeper.xp} XP → L{d.result.level} · {d.result.xp} XP</Row></ul>
                    <Result keeper={d.keeper} result={d.result} merged={d.merged} />
                  </div>
                  <div>
                    <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-subtle mb-1">Merged into {d.keeper.name} · {d.merged.length}</div>
                    {d.merged.length ? <ul aria-label="Agents merged" className="space-y-1">{d.merged.map((m) => <Row key={m.id} name={m.name}><span className="text-accent">{gains(m)}</span></Row>)}</ul>
                      : <div className="text-subtle">Nothing to merge right now.</div>}
                  </div>
                  {d.skipped.length > 0 && (
                    <div>
                      <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-subtle mb-1">Skipped · {d.skipped.length}</div>
                      <ul aria-label="Agents skipped" className="space-y-1">{d.skipped.map((s) => <Row key={s.id} name={s.name}><span className="text-warn">{s.reason}</span></Row>)}</ul>
                    </div>
                  )}
                  {Array.isArray(d.moves) && <HandOverList moves={d.moves} />}
                </div>
              )}
        </div></>}
      onConfirm={async () => {
        let out;
        try {
          out = await api.post('/api/agents/consolidate', { role, keeperId: cur.data.keeper.id }, { quiet: true }); // Confirm is enabled only with cur
        } catch (e) {
          return toast.error(`Could not consolidate ${title} agents`, e.message); // 400/404: the server says why
        }
        const { keeper, merged, skipped } = out;
        const skip = skipped.length ? ` · ${skipped.length} skipped` : '';
        if (!merged.length) return toast.warn(`No ${title} agent was merged`, skipped.map((s) => `${s.name}: ${s.reason}`).join(' · ') || undefined);
        const sum = (k) => merged.reduce((n, m) => n + m[k], 0);
        const playbookVersion = merged.reduce((v, m) => m.playbookVersion || v, null);
        toast.success(`Consolidated ${plural(merged.length, `${title} agent`)} into ${keeper.name}`, gains({ xp: sum('xp'), skills: sum('skills'), lessons: sum('lessons'), playbookVersion }) + skip);
        const st = useStore.getState();
        if (merged.some((m) => m.id === st.agentModal)) st.set({ agentModal: keeper.id });
      }} />
  );
}
