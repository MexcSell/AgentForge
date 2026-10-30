import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutDashboard, FolderKanban, Bot, FolderTree, Cpu, Settings, Bell, Sun, Moon, Monitor, Search, Command, GitBranch, Activity,
  CircleCheck, CircleX, TriangleAlert, Info, X, RefreshCw, Zap, WifiOff, Layers, Plus, Users, Dna, MemoryStick, HardDrive, Network,
} from 'lucide-react';
import { useStore, selectUnread, selectWorkingAgents, selectRunningProjects } from '../lib/store.js';
import { useToasts } from '../lib/toast.js';
import { LAYOUTS, getLayout } from '../lib/layouts.js';
import { GithubMark } from '../lib/icons.jsx';
import { compact, duration } from '../lib/format.js';
import { cx, Kbd, StatusDot, AgentAvatar } from './ui.jsx';

const GithubIcon = (p) => <GithubMark size={p.size || 18} />;

export const VIEWS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, key: '1' },
  { id: 'projects', label: 'Projects', icon: FolderKanban, key: '2' },
  { id: 'agents', label: 'Agents', icon: Bot, key: '3' },
  { id: 'files', label: 'Files', icon: FolderTree, key: '4' },
  { id: 'models', label: 'Models', icon: Cpu, key: '5' },
  { id: 'github', label: 'GitHub', icon: GithubIcon, key: '6' },
];

export function ActivityBar({ layout }) {
  const view = useStore((s) => s.view);
  const set = useStore((s) => s.set);
  const unread = useStore(selectUnread);
  const working = useStore((s) => selectWorkingAgents(s).length);
  const running = useStore((s) => selectRunningProjects(s).length);
  const badges = { dashboard: unread, projects: running, agents: working };
  const bottom = layout.activity === 'bottom';
  const labels = layout.activityLabels && !bottom;
  const item = (v) => {
    const active = view === v.id;
    const b = badges[v.id];
    return (
      <button key={v.id} onClick={() => set({ view: v.id })} title={`${v.label}  (Alt+${v.key})`} aria-label={v.label} aria-current={active ? 'page' : undefined}
        className={cx('group relative flex items-center rounded-lg transition-colors shrink-0',
          bottom ? 'flex-col justify-center gap-0.5 h-12 flex-1 max-w-24' : labels ? 'gap-2.5 h-9 px-2.5 w-full' : 'justify-center size-10',
          active ? 'text-fg bg-accent-soft' : 'text-subtle hover:text-fg hover:bg-hover')}>
        {active && !bottom && <span className={cx('absolute top-2 bottom-2 w-[3px] rounded-full grad-accent', layout.activity === 'right' ? '-right-[5px]' : '-left-[5px]')} />}
        <span className="relative">
          <v.icon size={bottom ? 19 : 18} strokeWidth={1.8} />
          {b > 0 && (
            <span className={cx('absolute -top-1.5 -right-2 min-w-[15px] h-[15px] px-[3px] rounded-full text-[9.5px] font-bold leading-[15px] text-center tabular ring-2 ring-[var(--af-panel)]',
              v.id === 'dashboard' ? 'bg-bad text-white' : 'grad-accent text-accent-fg')}>{b > 99 ? '99+' : b}</span>
          )}
        </span>
        {(labels || bottom) && <span className={cx('font-medium', bottom ? 'text-[10px]' : 'text-[0.8rem]')}>{v.label}</span>}
      </button>
    );
  };
  if (bottom) {
    return (
      <nav className="flex items-center justify-around gap-1 px-2 border-t border-line bg-panel shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {[...VIEWS, { id: 'settings', label: 'Settings', icon: Settings, key: '7' }].map(item)}
      </nav>
    );
  }
  return (
    <nav className={cx('flex flex-col items-center gap-1 py-2 bg-panel shrink-0', labels ? 'w-44 px-2.5 items-stretch' : 'w-[52px]', layout.activity === 'right' ? 'border-l border-line order-last' : 'border-r border-line')}>
      {VIEWS.map(item)}
      <div className="flex-1" />
      {item({ id: 'settings', label: 'Settings', icon: Settings, key: '7' })}
    </nav>
  );
}

export function TitleBar({ layout }) {
  const st = useStore();
  const unread = useStore(selectUnread);
  const working = useStore((s) => selectWorkingAgents(s).length);
  const running = useStore((s) => selectRunningProjects(s).length);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const view = VIEWS.find((v) => v.id === st.view) || { label: 'Settings' };
  const project = st.projects.find((p) => p.id === st.activeProjectId);
  const ThemeIcon = st.theme === 'dark' ? Moon : st.theme === 'light' ? Sun : Monitor;
  const nextTheme = { dark: 'light', light: 'system', system: 'dark' }[st.theme];
  return (
    <header className="relative flex items-center gap-2 h-11 px-3 border-b border-line bg-panel shrink-0 z-20">
      <button onClick={() => st.set({ view: 'dashboard' })} className="flex items-center gap-2 pr-2 shrink-0" title="AgentForge">
        <span className="size-6 rounded-[7px] grad-accent flex items-center justify-center shadow-sm">
          <svg viewBox="0 0 64 64" width="14" height="14"><path d="M18 46 30 18l12 28M22.5 37h15" fill="none" stroke="currentColor" className="text-accent-fg" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span className="font-semibold tracking-tight text-[0.92rem] hidden sm:inline">AgentForge</span>
      </button>
      <div className="hidden md:flex items-center gap-1.5 text-[0.8rem] text-subtle min-w-0">
        <span>/</span><span className="text-muted">{view.label}</span>
        {st.view === 'projects' && project && <><span>/</span><span className="text-fg truncate max-w-48">{project.name}</span></>}
      </div>

      <button onClick={() => st.set({ palette: true })} className="mx-auto flex items-center gap-2 h-7 w-[min(440px,40vw)] px-2.5 rounded-lg border border-line bg-sunken text-subtle text-[0.8rem] hover:border-line-strong transition-colors">
        <Search size={13} /><span className="truncate">Search or run a command…</span><span className="ml-auto hidden sm:flex gap-0.5"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
      </button>

      <div className="hidden lg:flex items-center gap-3 text-[0.75rem] text-muted mr-1">
        <span className="flex items-center gap-1.5" title="Projects running"><FolderKanban size={13} className={running ? 'text-accent' : ''} /><b className="text-fg tabular">{running}</b> running</span>
        <span className="flex items-center gap-1.5" title="Agents working"><Bot size={13} className={working ? 'text-accent' : ''} /><b className="text-fg tabular">{working}</b> agents</span>
      </div>
      <div className="relative">
        <button onClick={() => setLayoutOpen(!layoutOpen)} className="size-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-hover" title={`Screen format: ${layout.name}`}><Layers size={16} /></button>
        {layoutOpen && <LayoutMenu onClose={() => setLayoutOpen(false)} />}
      </div>
      <button onClick={() => st.set({ theme: nextTheme })} className="size-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-hover" title={`Theme: ${st.theme} (click for ${nextTheme})`}><ThemeIcon size={16} /></button>
      <button onClick={() => st.set({ view: 'dashboard' })} className="relative size-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-hover" title={`${unread} unread notifications`}>
        <Bell size={16} />
        {unread > 0 && <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-bad ring-2 ring-[var(--af-panel)]" />}
      </button>
    </header>
  );
}

function LayoutMenu({ onClose }) {
  const layoutId = useStore((s) => s.layoutId);
  const set = useStore((s) => s.set);
  const ref = useRef(null);
  useEffect(() => {
    const off = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    setTimeout(() => window.addEventListener('mousedown', off));
    return () => window.removeEventListener('mousedown', off);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-9 w-[340px] p-2 rounded-xl border border-line bg-raised shadow-af-lg animate-af-in z-50">
      <div className="px-1.5 pb-2 text-[0.7rem] font-semibold uppercase tracking-wider text-subtle">Screen format · {LAYOUTS.length}</div>
      <div className="grid grid-cols-2 gap-1 max-h-[60vh] overflow-auto">
        {LAYOUTS.map((l) => {
          const I = l.icon || Layers;
          return (
            <button key={l.id} onClick={() => { set({ layoutId: l.id }); }} className={cx('flex items-center gap-2 p-2 rounded-lg text-left transition-colors', layoutId === l.id ? 'bg-accent-soft text-fg' : 'hover:bg-hover text-muted')}>
              <I size={15} className={layoutId === l.id ? 'text-accent' : ''} />
              <span className="min-w-0"><span className="block text-[0.78rem] font-medium text-fg truncate">{l.name}</span><span className="block text-[0.68rem] text-subtle truncate">{l.hint}</span></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fixed = (v, d) => (isNum(v) ? v.toFixed(d) : '—');
const big = (v) => fixed(v, v >= 100 ? 0 : 1); // GB and Mb/s: one decimal below 100
const pctText = (v) => (isNum(v) ? `${Math.round(v)}%` : '—');
/** Milliseconds since the epoch for a sample timestamp (ms, unix seconds or ISO string); NaN if unknown. */
const tsMs = (ts) => (typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : ts ? Date.parse(ts) : NaN);

/** True once `at + ms` has passed; re-renders by itself at that moment. An unknown time never expires. */
function useExpired(at, ms) {
  const [, tick] = useState(0);
  const left = at + ms - Date.now();
  useEffect(() => {
    if (!(left > 0)) return undefined;
    const t = setTimeout(() => tick((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [at, ms]);
  return left <= 0;
}

/** A number in a fixed-width slot, so redraws don't shift the footer. */
const Num = ({ w, left, children }) => <span className={cx('inline-block tabular', left ? 'text-left' : 'text-right')} style={{ minWidth: `${w}ch` }}>{children}</span>;

function Pct({ v }) {
  if (!isNum(v)) return <Num w={3}>—</Num>;
  const r = Math.round(v);
  return <span className={r >= 90 ? 'text-bad' : r >= 75 ? 'text-warn' : undefined}><Num w={3}>{r}</Num>%</span>;
}

function Usage({ icon: I, show, title, children }) {
  return <span className={cx('hidden items-center gap-1 h-6 shrink-0', show)} title={title}><I size={11} className="shrink-0" />{children}</span>;
}

/**
 * Machine usage of the host (system:metrics). Renders nothing until the server sends a sample.
 * Items hide by priority: breakpoints first, then any item that still doesn't fit wraps onto the
 * strip's clipped second line, so the other footer items keep their room and nothing is cut mid-text.
 */
function MachineUsage() {
  const m = useStore((s) => s.metrics);
  const enabled = useStore((s) => s.settings?.monitor?.enabled !== false);
  const connected = useStore((s) => s.connected);
  const savedSec = useStore((s) => s.settings?.monitor?.intervalSec);
  const sec = m?.intervalSec || savedSec || 3;
  const stale = useExpired(tsMs(m?.ts), 3 * sec * 1000);
  if (!m || !enabled) return null;
  const c = m.cpu || {};
  const mem = m.memory || {};
  const d = m.storage || {};
  const n = m.network || {};
  const link = isNum(n.linkMbps) && n.linkMbps > 0;
  const note = !connected ? '\nOffline: showing the last sample' : stale ? `\nStale: no new sample for over ${3 * sec}s` : '';
  return (
    <div role="group" aria-label={`Machine usage${!connected ? ' (offline)' : stale ? ' (stale)' : ''}`}
      className={cx('hidden sm:flex flex-wrap items-center gap-x-3 h-6 min-w-0 overflow-hidden transition-opacity',(!connected || stale) && 'opacity-50')}>
      <Usage icon={Cpu} show="sm:flex" title={`CPU: ${pctText(c.percent)} in use\nClock: ${fixed(c.ghz, 2)} GHz · max ${fixed(c.maxGhz, 2)} GHz\nCores: ${c.cores ?? '—'}${note}`}>
        CPU <Num w={3}>{fixed(c.ghz, 1)}</Num> GHz · <Pct v={c.percent} />
      </Usage>
      <Usage icon={MemoryStick} show="md:flex" title={`Memory: ${fixed(mem.usedGb, 1)} GB used of ${fixed(mem.totalGb, 1)} GB (${pctText(mem.percent)})${note}`}>
        RAM <Num w={4}>{big(mem.usedGb)}</Num>/{big(mem.totalGb)} GB · <Pct v={mem.percent} />
      </Usage>
      <Usage icon={HardDrive} show="lg:flex"
        title={`Disk${d.mount ? ` ${d.mount}` : ''}: ${fixed(d.usedGb, 1)} GB used of ${fixed(d.totalGb, 1)} GB (${pctText(d.percent)})\nI/O busy: ${pctText(d.busyPercent)} · read ${fixed(d.readMBps, 1)} MB/s · write ${fixed(d.writeMBps, 1)} MB/s${note}`}>
        Disk <Num w={4}>{big(d.usedGb)}</Num>/{big(d.totalGb)} GB · <Pct v={d.percent} /> · I/O <Pct v={d.busyPercent} />
      </Usage>
      <Usage icon={Network} show="lg:flex"
        title={`Network${n.iface ? ` ${n.iface}` : ''}: ↓ ${fixed(n.rxMbps, 2)} Mb/s · ↑ ${fixed(n.txMbps, 2)} Mb/s\nLink: ${link ? `${n.linkMbps} Mb/s · ${pctText(n.percent)} used` : 'speed unknown'}${note}`}>
        Net ↓<Num w={4} left>{big(n.rxMbps)}</Num> ↑<Num w={4} left>{big(n.txMbps)}</Num> Mb/s{link && <> · <Pct v={n.percent} /></>}
      </Usage>
    </div>
  );
}

export function StatusBar() {
  const st = useStore();
  const working = useStore((s) => selectWorkingAgents(s).length);
  const sys = st.system;
  const status = !st.connected ? 'offline' : sys?.status || 'online';
  const def = st.models.find((m) => m.is_default);
  const layout = getLayout(st.layoutId);
  const project = st.projects.find((p) => p.id === st.activeProjectId);
  const sup = sys?.supervisor || {};
  return (
    <footer className="flex items-center gap-3 h-6 px-2.5 border-t border-line bg-panel text-[0.7rem] text-muted shrink-0 overflow-hidden whitespace-nowrap">
      <button onClick={() => st.set({ view: 'settings' })} className="flex items-center gap-1.5 hover:text-fg" title="Service status">
        {st.connected ? <StatusDot status={status} /> : <WifiOff size={11} className="text-bad" />}
        <span className="capitalize">{status}</span>
        {sys?.uptimeSec != null && <span className="text-subtle">· up {duration(sys.uptimeSec * 1000)}</span>}
      </button>
      {sup.pendingRestart && <span className="flex items-center gap-1 text-warn"><RefreshCw size={11} className="animate-spin" />restart pending{sup.waitingForAgents ? ` · waiting for ${sup.waitingForAgents} agent run(s)` : ''}</span>}
      {sup.building && <span className="flex items-center gap-1 text-info"><RefreshCw size={11} className="animate-spin" />building UI</span>}
      {sup.lastError && <span className="flex items-center gap-1 text-bad truncate max-w-72" title={sup.lastError}><TriangleAlert size={11} />{sup.lastError.split('\n')[0]}</span>}
      {project && <span className="hidden md:flex items-center gap-1"><GitBranch size={11} />{project.name}</span>}
      <span className="flex items-center gap-1"><Activity size={11} className={working ? 'text-accent' : ''} />{working} agent{working === 1 ? '' : 's'} working</span>
      <MachineUsage />
      <div className="flex-1" />
      {def && <span className="hidden md:flex items-center gap-1" title="Default model · tokens today"><Zap size={11} />{def.name} · {compact(def.usage?.daily?.tokens)} today</span>}
      <button className="hidden sm:flex items-center gap-1 hover:text-fg" onClick={() => st.set({ view: 'settings' })}><Layers size={11} />{layout.name}</button>
      <span className="hidden sm:inline">{sys?.commit ? `v${sys.version} · ${sys.commit}` : ''}</span>
    </footer>
  );
}

export function Toasts() {
  const { items, dismiss } = useToasts();
  const ICON = { success: [CircleCheck, 'text-ok'], error: [CircleX, 'text-bad'], warn: [TriangleAlert, 'text-warn'], info: [Info, 'text-info'] };
  return (
    <div className="fixed bottom-9 right-3 z-[70] flex flex-col gap-2 w-[min(360px,92vw)] pointer-events-none">
      {items.map((t) => {
        const [I, c] = ICON[t.kind] || ICON.info;
        return (
          <div key={t.id} className="pointer-events-auto flex gap-2.5 p-3 rounded-xl border border-line bg-raised shadow-af-lg animate-af-in">
            <I size={16} className={cx(c, 'shrink-0 mt-0.5')} />
            <div className="min-w-0 flex-1">
              <div className="text-[0.82rem] font-medium leading-snug">{t.title}</div>
              {t.body && <div className="text-xs text-muted mt-0.5 line-clamp-3 whitespace-pre-line">{t.body}</div>}
              {t.source && <div className="text-[0.68rem] text-subtle mt-1">{t.source}</div>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-subtle hover:text-fg self-start"><X size={13} /></button>
          </div>
        );
      })}
    </div>
  );
}

export function ClientUpdateBanner() {
  const v = useStore((s) => s.clientUpdate);
  const [secs, setSecs] = useState(6);
  useEffect(() => {
    if (!v) return;
    setSecs(6);
    const t = setInterval(() => setSecs((s) => {
      if (s <= 1) { location.reload(); return 0; }
      return s - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [v]);
  if (!v) return null;
  return (
    <div className="fixed top-14 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-3 pl-3 pr-1.5 h-10 rounded-full border border-line bg-raised shadow-af-lg animate-af-in text-[0.82rem]">
      <RefreshCw size={14} className="text-accent" />
      A new version of AgentForge was deployed. Reloading in {secs}s
      <button className="h-7 px-3 rounded-full grad-accent text-accent-fg font-medium" onClick={() => location.reload()}>Reload now</button>
      <button className="h-7 px-2 rounded-full text-muted hover:bg-hover" onClick={() => useStore.getState().set({ clientUpdate: null })}>Later</button>
    </div>
  );
}

export function CommandPalette() {
  const st = useStore();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { if (st.palette) { setQ(''); setI(0); setTimeout(() => inputRef.current?.focus(), 10); } }, [st.palette]);

  const items = useMemo(() => {
    const go = (view, extra = {}) => () => st.set({ view, palette: false, ...extra });
    const list = [
      ...VIEWS.map((v) => ({ group: 'Go to', label: v.label, icon: v.icon, run: go(v.id), hint: `Alt+${v.key}` })),
      { group: 'Go to', label: 'Settings', icon: Settings, run: go('settings') },
      { group: 'Actions', label: 'New project…', icon: Plus, run: () => st.set({ palette: false, view: 'projects', createProject: true }) },
      { group: 'Actions', label: 'Toggle light / dark', icon: st.theme === 'dark' ? Sun : Moon, run: () => st.set({ palette: false, theme: st.theme === 'dark' ? 'light' : 'dark' }) },
      { group: 'Actions', label: 'Org chart', icon: Users, run: go('agents') },
      { group: 'Actions', label: 'Evolution engine', icon: Dna, run: go('agents') },
      ...st.projects.map((p) => ({ group: 'Projects', label: p.name, sub: p.path, icon: FolderKanban, run: go('projects', { activeProjectId: p.id }) })),
      ...st.agents.map((a) => ({ group: 'Agents', label: a.name, sub: a.title, agent: a, run: () => st.set({ palette: false, agentModal: a.id }) })),
      ...LAYOUTS.map((l) => ({ group: 'Screen format', label: l.name, sub: l.hint, icon: l.icon || Layers, run: () => st.set({ palette: false, layoutId: l.id }) })),
    ];
    const s = q.trim().toLowerCase();
    return s ? list.filter((x) => `${x.label} ${x.sub || ''} ${x.group}`.toLowerCase().includes(s)) : list;
  }, [q, st.projects, st.agents, st.theme]);

  if (!st.palette) return null;
  const pick = (x) => x?.run();
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center pt-[12vh] px-3 animate-af-fade" onMouseDown={(e) => e.target === e.currentTarget && st.set({ palette: false })}>
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[2px] pointer-events-none" />
      <div className="relative w-[min(640px,96vw)] rounded-2xl border border-line bg-raised shadow-af-lg overflow-hidden animate-af-in">
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line">
          <Command size={16} className="text-accent" />
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} placeholder="Type a command, project, agent or layout…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((i + 1) % Math.max(1, items.length)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI((i - 1 + items.length) % Math.max(1, items.length)); }
              else if (e.key === 'Enter') pick(items[i]);
              else if (e.key === 'Escape') st.set({ palette: false });
            }}
            className="flex-1 bg-transparent outline-none text-[0.95rem] placeholder:text-subtle" />
          <Kbd>Esc</Kbd>
        </div>
        <div className="max-h-[52vh] overflow-auto p-1.5">
          {!items.length && <div className="py-8 text-center text-sm text-subtle">No results</div>}
          {items.map((x, idx) => (
            <div key={`${x.group}-${x.label}-${idx}`}>
              {(idx === 0 || items[idx - 1].group !== x.group) && <div className="px-2.5 pt-2 pb-1 text-[0.68rem] font-semibold uppercase tracking-wider text-subtle">{x.group}</div>}
              <button onMouseEnter={() => setI(idx)} onClick={() => pick(x)} ref={(el) => idx === i && el?.scrollIntoView({ block: 'nearest' })}
                className={cx('w-full flex items-center gap-3 h-9 px-2.5 rounded-lg text-left', idx === i ? 'bg-accent-soft' : '')}>
                {x.agent ? <AgentAvatar agent={x.agent} size={20} /> : x.icon ? <x.icon size={16} className="text-muted" /> : null}
                <span className="text-[0.85rem] truncate">{x.label}</span>
                {x.sub && <span className="text-xs text-subtle truncate">{x.sub}</span>}
                {x.hint && <span className="ml-auto"><Kbd>{x.hint}</Kbd></span>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

