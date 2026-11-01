import { useEffect, useState } from 'react';
import { Settings as SettingsIcon, Sun, Moon, Monitor, Palette, Layers, Workflow, Dna, Server, RefreshCw, Check, Database, Boxes, Layout, Cpu, Zap, ShieldCheck, Gauge } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { toast } from '../lib/toast.js';
import { LAYOUTS } from '../lib/layouts.js';
import { duration, bytes, dateTime } from '../lib/format.js';
import { cx, Button, Field, Input, Toggle, StatusDot } from '../components/ui.jsx';

const ACCENTS = [['indigo', '#6366f1'], ['violet', '#8b5cf6'], ['blue', '#3b82f6'], ['emerald', '#10b981'], ['amber', '#f59e0b'], ['rose', '#f43f5e'], ['mono', '#71717a']];

function Section({ icon: Icon, title, desc, children }) {
  return (
    <section className="rounded-[var(--af-radius)] border border-line bg-panel">
      <div className="flex items-center gap-2.5 px-4 h-11 border-b border-line">
        <Icon size={15} className="text-subtle" />
        <span className="font-semibold text-[0.86rem]">{title}</span>
        {desc && <span className="text-xs text-subtle hidden md:inline">· {desc}</span>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Miniature drawing of a screen format. */
function LayoutThumb({ l }) {
  const P = l.project;
  const order = P.order.filter((k) => !P.hide.includes(k));
  const vertical = P.orientation === 'vertical';
  const color = { list: 'bg-line-strong', chat: 'grad-accent opacity-70', agents: 'bg-info/50' };
  const act = <div className={cx('bg-line-strong/70', l.activity === 'bottom' ? 'h-1.5 w-full' : 'w-1.5 h-full')} />;
  return (
    <div className={cx('h-16 w-full rounded-md border border-line bg-sunken overflow-hidden flex', l.activity === 'bottom' ? 'flex-col-reverse' : l.activity === 'right' ? 'flex-row-reverse' : 'flex-row')} style={{ padding: l.floating ? 3 : 0 }}>
      {act}
      <div className={cx('flex-1 flex gap-[2px] p-[2px]', vertical && 'flex-col', l.maxWidth && 'px-3')}>
        {order.map((k) => <div key={k} className={cx('rounded-[2px]', color[k])} style={{ flex: P.sizes[k] || 20 }} />)}
      </div>
    </div>
  );
}

export default function Settings() {
  const st = useStore();
  const [orc, setOrc] = useState(null);
  const [evo, setEvo] = useState(null);
  const [mon, setMon] = useState(null);
  useEffect(() => {
    if (st.settings) { setOrc(st.settings.orchestrator); setEvo(st.settings.evolution); setMon({ enabled: true, intervalSec: 3, ...st.settings.monitor }); }
  }, [st.settings]);
  const sys = st.system;
  const save = async (key, value) => { await api.put(`/api/settings/${key}`, value); toast.success('Settings saved'); };
  return (
    <div className="h-full overflow-auto">
      <div className="p-4 flex flex-col gap-4 max-w-[1200px]">
        <div className="flex items-center gap-3"><SettingsIcon size={18} className="text-subtle" /><span className="font-semibold text-[0.95rem]">Settings</span></div>

        <Section icon={Palette} title="Appearance">
          <div className="flex flex-wrap gap-6">
            <Field label="Theme">
              <div className="flex gap-2">
                {[['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor]].map(([k, label, I]) => (
                  <button key={k} onClick={() => st.set({ theme: k })} className={cx('flex flex-col items-center gap-1.5 w-24 p-2.5 rounded-lg border', st.theme === k ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
                    <span className={cx('w-full h-10 rounded-md border border-line flex items-center justify-center', k === 'light' ? 'bg-white text-zinc-800' : k === 'dark' ? 'bg-zinc-900 text-zinc-100' : 'bg-gradient-to-r from-white to-zinc-900 text-zinc-500')}><I size={16} /></span>
                    <span className="text-xs font-medium">{label}</span>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Accent">
              <div className="flex gap-2 h-[72px] items-center">
                {ACCENTS.map(([k, c]) => (
                  <button key={k} title={k} onClick={() => st.set({ accent: k })} className={cx('size-8 rounded-full flex items-center justify-center ring-offset-2 ring-offset-[var(--af-panel)]', st.accent === k && 'ring-2 ring-[var(--af-fg)]')} style={{ background: c }}>
                    {st.accent === k && <Check size={14} className="text-white" />}
                  </button>
                ))}
              </div>
            </Field>
          </div>
        </Section>

        <Section icon={Layers} title={`Screen format · ${LAYOUTS.length} presets`} desc="Every panel stays resizable; sizes are remembered per format">
          <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
            {LAYOUTS.map((l) => (
              <button key={l.id} onClick={() => st.set({ layoutId: l.id })} className={cx('flex flex-col gap-2 p-2 rounded-lg border text-left transition-colors', st.layoutId === l.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
                <LayoutThumb l={l} />
                <span className="flex items-center gap-1.5 text-[0.78rem] font-medium"><l.icon size={13} className={st.layoutId === l.id ? 'text-accent' : 'text-subtle'} />{l.name}</span>
                <span className="text-[0.66rem] text-subtle -mt-1.5">{l.hint}</span>
              </button>
            ))}
          </div>
        </Section>

        {orc && (
          <Section icon={Workflow} title="Orchestrator" desc="How General Managers run missions — orders in different topics run at the same time; orders in one topic run in order">
            <div className="grid gap-4 md:grid-cols-2 items-start">
              <Field label="Max parallel agents per mission"><Input type="number" min="1" max="12" value={orc.maxParallel} onChange={(e) => setOrc({ ...orc, maxParallel: Number(e.target.value) })} /></Field>
              <Field label="Task timeout (minutes)"><Input type="number" min="1" max="240" value={orc.taskTimeoutMin} onChange={(e) => setOrc({ ...orc, taskTimeoutMin: Number(e.target.value) })} /></Field>
            </div>
            <div className="grid gap-4 md:grid-cols-2 mt-4">
              <Toggle checked={orc.verification} onChange={(v) => setOrc({ ...orc, verification: v })} label="Independent verification when several agents change code" />
              <Toggle checked={orc.retryFailed} onChange={(v) => setOrc({ ...orc, retryFailed: v })} label="Retry a failed task once with the failure context" />
              <Toggle checked={orc.proposalTriage !== false} onChange={(v) => setOrc({ ...orc, proposalTriage: v })} label="Superiors decide agent proposals — only escalations reach you" />
              <Toggle checked={orc.autoApproveProposals} onChange={(v) => setOrc({ ...orc, autoApproveProposals: v })} label="Auto-approve agent proposals (agents start their own work)" />
            </div>
            <Button className="mt-4" variant="primary" onClick={() => save('orchestrator', orc)}>Save orchestrator settings</Button>
          </Section>
        )}

        {evo && (
          <Section icon={Dna} title="Self-learning" desc="Playbooks evolve from lessons; experiments must beat the baseline">
            <div className="grid gap-4 md:grid-cols-3">
              <Toggle checked={evo.enabled} onChange={(v) => setEvo({ ...evo, enabled: v })} label="Evolve playbooks automatically" />
              <Field label="Lessons per new version"><Input type="number" min="1" value={evo.lessonsPerVersion} onChange={(e) => setEvo({ ...evo, lessonsPerVersion: Number(e.target.value) })} /></Field>
              <Field label="Playbook size"><Input type="number" min="1" max="20" value={evo.playbookSize} onChange={(e) => setEvo({ ...evo, playbookSize: Number(e.target.value) })} /></Field>
            </div>
            <Button className="mt-4" variant="primary" onClick={() => save('evolution', evo)}>Save learning settings</Button>
          </Section>
        )}

        {mon && (
          <Section icon={Gauge} title="System monitor" desc="CPU, memory, disk and network usage of this machine">
            <div className="grid gap-4 md:grid-cols-2 items-end">
              <div className="flex items-center h-8"><Toggle checked={mon.enabled} onChange={(v) => setMon({ ...mon, enabled: v })} label="Show machine usage in the status bar" /></div>
              <Field label="Redraw interval (seconds)"><Input type="number" min="1" max="60" value={mon.intervalSec} onChange={(e) => setMon({ ...mon, intervalSec: Number(e.target.value) })} /></Field>
            </div>
            <Button className="mt-4" variant="primary" onClick={() => {
              const v = { enabled: mon.enabled, intervalSec: Math.min(60, Math.max(1, Math.round(mon.intervalSec) || 3)) };
              setMon(v);
              save('monitor', v);
            }}>Save monitor settings</Button>
          </Section>
        )}

        <Section icon={Server} title="Service" desc="Self-restart is guarded: syntax check → candidate health check → wait for idle agents → swap">
          {sys && (
            <div className="grid gap-4 md:grid-cols-[1fr_auto] items-start">
              <dl className="grid grid-cols-[150px_1fr] gap-y-2 text-xs">
                <dt className="text-subtle">Status</dt><dd className="flex items-center gap-1.5 capitalize"><StatusDot status={sys.status} />{sys.status}</dd>
                <dt className="text-subtle">Version</dt><dd className="mono">v{sys.version} · {sys.commit || 'uncommitted'}</dd>
                <dt className="text-subtle">Uptime</dt><dd>{duration(sys.uptimeSec * 1000)} (since {dateTime(sys.startedAt)})</dd>
                <dt className="text-subtle">Supervisor</dt><dd>{sys.supervisor?.attached ? `attached · ${sys.supervisor.restarts || 0} safe restarts` : 'not attached (started without npm start)'}</dd>
                <dt className="text-subtle">Runtime</dt><dd>Node {sys.node} · pid {sys.pid} · {bytes(sys.memory.rss)} RSS · {sys.clients} browser(s) · {sys.terminals} terminal(s)</dd>
              </dl>
              <Button icon={RefreshCw} disabled={!sys.supervisor?.attached} onClick={async () => { await api.post('/api/system/restart', {}); toast.info('Safe restart scheduled', 'Waits for running agents to finish first'); }}>Safe restart</Button>
            </div>
          )}
        </Section>

        <Section icon={Boxes} title="Technology choices" desc="Why this stack">
          <div className="grid gap-3 md:grid-cols-2 text-xs">
            {[
              [Server, 'Backend · Node.js + Fastify', 'One language across UI, API and agent orchestration; non-blocking I/O suits many concurrent agent processes, WebSockets and terminals.'],
              [Layout, 'Frontend · React + Vite + Tailwind', 'A single-page control room like VS Code. Vite builds in seconds, which keeps self-updates fast.'],
              [Database, 'Database · PostgreSQL', 'Relational integrity for projects, tasks, runs and audit history; JSONB for flexible agent skills, plans and reports.'],
              [Cpu, 'Agent runtime · Claude Code CLI', 'Gives agents real tools (read, edit, run) inside each project directory, with streamed usage and rate-limit data.'],
              [Zap, 'Not used yet · Redis, Qdrant', 'A single node needs no external queue or cache; agent memory starts in PostgreSQL. Both can be added when scaling out.'],
              [ShieldCheck, 'Not used yet · Better Auth, Cloudflare', 'The service binds to 127.0.0.1 only. Add authentication before exposing it to a network.'],
            ].map(([I, t, d]) => (
              <div key={t} className="flex gap-3 p-3 rounded-lg bg-sunken border border-line">
                <I size={16} className="text-accent shrink-0 mt-0.5" />
                <div><div className="font-medium text-fg text-[0.8rem]">{t}</div><div className="text-muted mt-0.5 leading-relaxed">{d}</div></div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
