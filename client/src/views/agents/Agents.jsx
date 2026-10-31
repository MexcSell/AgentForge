import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Plus, Search, Network, LayoutGrid, Dna, GitFork, Eye, Stethoscope, Lightbulb, FlaskConical, Scale, Rocket, ChevronDown, ChevronRight,
  ZoomIn, ZoomOut, RefreshCw, Sparkles, CircleX, Lock, X,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { timeAgo } from '../../lib/format.js';
import { roleStyle, ROLE_STYLE } from '../../lib/icons.jsx';
import { Modal } from '../../components/Modal.jsx';
import { cx, AgentAvatar, Badge, Button, IconButton, Input, Field, Select, Textarea, Tabs, Empty, StatusDot, Spinner } from '../../components/ui.jsx';

const TIERS = { 1: 'Executive Intelligence', 2: 'Management & Orchestration', 3: 'Specialist Teams', 4: 'Independent Verification', 5: 'Self-Evolution' };

/** Avatar with a "×N" corner badge while the agent works on several tasks at once (it is shared across projects). */
function Avatar({ a, size }) {
  const n = a.active_tasks;
  const label = `Working on ${n} tasks`;
  return (
    <span className="relative flex shrink-0">
      <AgentAvatar agent={a} size={size} />
      {n > 1 && <span role="img" aria-label={label} title={label} className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-accent text-accent-fg text-[10px] font-semibold leading-4 text-center tabular ring-2 ring-[var(--af-panel)]">×{n}</span>}
    </span>
  );
}

function AgentCard({ a }) {
  const set = useStore((s) => s.set);
  return (
    <div onClick={() => set({ agentModal: a.id })} className="group relative flex flex-col gap-3 p-3.5 rounded-[var(--af-radius)] border border-line bg-panel hover:border-line-strong hover:shadow-af transition-all cursor-pointer">
      <div className="flex items-center gap-3">
        <Avatar a={a} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5"><span className="font-semibold text-[0.88rem] truncate">{a.name}</span>{a.origin === 'cloned' && <GitFork size={11} className="text-subtle" title="Clone" />}{a.origin === 'created' && <Sparkles size={11} className="text-accent" title="Recruited dynamically" />}</div>
          <div className="text-[0.72rem] text-muted truncate">{a.title}</div>
        </div>
        <div className="text-right">
          <div className="text-[0.72rem] font-semibold text-accent tabular">L{a.level}</div>
          <div className="text-[0.64rem] text-subtle tabular">{a.xp} XP</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {(a.skills || []).slice().sort((x, y) => y.level - x.level).slice(0, 4).map((k) => <span key={k.name} className="text-[0.66rem] px-1.5 py-0.5 rounded bg-sunken border border-line text-muted">{k.name} <b className="text-fg tabular">{k.level}</b></span>)}
      </div>
      <div className="flex items-center gap-2 text-[0.68rem] text-subtle">
        <StatusDot status={a.status} /><span className="capitalize">{a.status}</span>
        <span>·</span><span>{a.stats?.tasksDone || 0} done</span>
        {a.supervisor_name && <><span>·</span><span className="truncate">↑ {a.supervisor_name}</span></>}
        <span className="ml-auto">v{a.prompt_version}</span>
      </div>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 bg-panel rounded-md">
        <IconButton icon={GitFork} size="sm" label="Clone" onClick={async (e) => { e.stopPropagation(); const c = await api.post(`/api/agents/${a.id}/clone`); toast.success(`Cloned ${a.name} → ${c.name}`); }} />
      </div>
    </div>
  );
}

function Registry() {
  const agents = useStore((s) => s.agents);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const list = agents.filter((a) => (!role || a.role === role) && `${a.name} ${a.title} ${a.role} ${(a.skills || []).map((s) => s.name).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const roles = [...new Set(agents.map((a) => a.role))].sort();
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line">
        <Input icon={Search} className="w-72" placeholder="Search name, role or skill…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-44"><option value="">All roles</option>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
        <span className="text-xs text-subtle ml-auto">{list.length} agents</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-6">
        {[1, 2, 3, 4, 5].map((tier) => {
          const items = list.filter((a) => a.tier === tier);
          if (!items.length) return null;
          return (
            <section key={tier}>
              <div className="flex items-center gap-2 mb-2.5"><span className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Level {tier} · {TIERS[tier]}</span><span className="text-[0.68rem] text-subtle tabular">{items.length}</span><span className="flex-1 h-px bg-line" /></div>
              <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(250px,1fr))]">{items.map((a) => <AgentCard key={a.id} a={a} />)}</div>
            </section>
          );
        })}
        {!list.length && <Empty icon={Bot} title="No agents match" />}
      </div>
    </div>
  );
}

function OrgNode({ node, collapsed, toggle }) {
  const set = useStore((s) => s.set);
  const a = node.agent;
  const closed = collapsed.has(a.id);
  const R = roleStyle(a.role);
  return (
    <li>
      <div className="relative inline-flex flex-col items-center">
        <button onClick={() => set({ agentModal: a.id })} className="flex items-center gap-2.5 pl-2 pr-3 py-2 rounded-xl border border-line bg-panel hover:border-accent/60 hover:shadow-af transition-all text-left min-w-44"
          style={{ boxShadow: a.status === 'working' ? `0 0 0 2px ${R.from}55` : undefined }}>
          <Avatar a={a} size={30} />
          <span className="min-w-0"><span className="block text-[0.8rem] font-semibold truncate">{a.name}</span><span className="block text-[0.66rem] text-subtle truncate max-w-36">{a.title}</span></span>
          <span className="ml-auto text-[0.64rem] text-accent font-semibold tabular">L{a.level}</span>
        </button>
        {node.children.length > 0 && (
          <button onClick={() => toggle(a.id)} className="absolute -bottom-2.5 size-5 rounded-full border border-line bg-raised flex items-center justify-center text-subtle hover:text-fg z-10" title={closed ? `Expand ${node.children.length}` : 'Collapse'}>
            {closed ? <span className="text-[9px] font-bold">{node.children.length}</span> : <ChevronDown size={11} />}
          </button>
        )}
      </div>
      {node.children.length > 0 && !closed && <ul>{node.children.map((c) => <OrgNode key={c.agent.id} node={c} collapsed={collapsed} toggle={toggle} />)}</ul>}
    </li>
  );
}

function OrgChart() {
  const agents = useStore((s) => s.agents);
  const [zoom, setZoom] = useState(1);
  const wrap = useRef(null);
  const chart = useRef(null);
  const fit = () => {
    const w = wrap.current?.clientWidth;
    const c = chart.current ? chart.current.getBoundingClientRect().width / (Number(chart.current.style.zoom) || 1) : 0;
    if (w && c) setZoom(Math.max(0.4, Math.min(1, Math.floor(((w - 16) / c) * 20) / 20)));
  };
  useEffect(() => { requestAnimationFrame(fit); }, [agents.length]);
  const [collapsed, setCollapsed] = useState(new Set());
  const roots = useMemo(() => {
    const map = new Map(agents.map((a) => [a.id, { agent: a, children: [] }]));
    const top = [];
    for (const n of map.values()) {
      const p = n.agent.supervisor_id && map.get(n.agent.supervisor_id);
      p ? p.children.push(n) : top.push(n);
    }
    const sort = (n) => { n.children.sort((x, y) => x.agent.tier - y.agent.tier || x.agent.name.localeCompare(y.agent.name)); n.children.forEach(sort); };
    top.forEach(sort);
    return top.sort((x, y) => x.agent.tier - y.agent.tier);
  }, [agents]);
  const toggle = (id) => { const n = new Set(collapsed); n.has(id) ? n.delete(id) : n.add(id); setCollapsed(n); };
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line">
        <span className="text-xs text-muted">Superiors assign, subordinates report. Click a node for details.</span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton icon={ZoomOut} label="Zoom out" onClick={() => setZoom(Math.max(0.4, zoom - 0.1))} />
          <span className="text-xs tabular w-10 text-center text-muted">{Math.round(zoom * 100)}%</span>
          <IconButton icon={ZoomIn} label="Zoom in" onClick={() => setZoom(Math.min(1.6, zoom + 0.1))} />
          <Button size="sm" variant="ghost" onClick={fit}>Fit</Button>
          <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>Expand all</Button>
        </div>
      </div>
      <div ref={wrap} className="flex-1 min-h-0 overflow-auto dotgrid">
        <div ref={chart} className="org p-8 w-max mx-auto" style={{ zoom }}>
          <ul>{roots.map((r) => <OrgNode key={r.agent.id} node={r} collapsed={collapsed} toggle={toggle} />)}</ul>
        </div>
      </div>
    </div>
  );
}

const STAGES = [
  ['observe', 'Observe', Eye, 'Performance Analyst collects outcomes, time and cost'],
  ['diagnose', 'Diagnose', Stethoscope, 'Recurring failures and bottlenecks'],
  ['generate', 'Generate', Lightbulb, 'Candidate playbooks, skills, team changes'],
  ['experiment', 'Experiment', FlaskConical, 'Candidates run on real tasks'],
  ['evaluate', 'Evaluate', Scale, 'Candidate vs. baseline success rate'],
  ['promote', 'Promote', Rocket, 'Winner versioned; loser rolled back'],
];

function Evolution() {
  const tick = useStore((s) => s.evolutionTick);
  const set = useStore((s) => s.set);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/evolution').then(setData).catch(() => {}); }, [tick]);
  const counts = Object.fromEntries(STAGES.map(([k]) => [k, data?.events.filter((e) => e.stage === k).length || 0]));
  return (
    <div className="h-full overflow-auto">
      <div className="p-4 flex flex-col gap-5 max-w-[1300px]">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[0.95rem] font-semibold">Self-evolution engine</div>
            <div className="text-xs text-muted">Agents improve through versioned, evaluated changes — never by silently rewriting themselves.</div>
          </div>
          <Button className="ml-auto" icon={RefreshCw} loading={busy} onClick={async () => { setBusy(true); try { setData(await api.post('/api/evolution/cycle')); toast.success('Evolution cycle complete'); } finally { setBusy(false); } }}>Run cycle now</Button>
        </div>
        <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          {STAGES.map(([k, label, Icon, desc], i) => (
            <div key={k} className="relative p-3 rounded-[var(--af-radius)] border border-line bg-panel">
              <div className="flex items-center gap-2"><span className="size-7 rounded-lg grad-accent text-accent-fg flex items-center justify-center"><Icon size={14} /></span><span className="text-[0.68rem] text-subtle tabular">0{i + 1}</span><span className="ml-auto text-lg font-semibold tabular">{counts[k]}</span></div>
              <div className="mt-2 text-[0.84rem] font-semibold">{label}</div>
              <div className="text-[0.7rem] text-subtle leading-snug mt-0.5">{desc}</div>
              {i < STAGES.length - 1 && <ChevronRight size={14} className="hidden xl:block absolute -right-[11px] top-1/2 -translate-y-1/2 text-subtle bg-bg rounded-full z-10" />}
            </div>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-5">
          <section className="lg:col-span-3 rounded-[var(--af-radius)] border border-line bg-panel">
            <div className="h-9 px-3.5 flex items-center border-b border-line text-[0.72rem] font-semibold uppercase tracking-wider text-muted">Timeline</div>
            <div className="p-3.5 max-h-[460px] overflow-auto">
              {!data && <Spinner />}
              {data && !data.events.length && <div className="text-xs text-subtle">The loop starts after the first missions complete.</div>}
              {data?.events.map((e) => {
                const S = STAGES.find((s) => s[0] === e.stage);
                const Icon = S?.[2] || Dna;
                return (
                  <div key={e.id} className="flex gap-3 py-2 border-b last:border-0 border-line">
                    <Icon size={14} className={cx('mt-0.5 shrink-0', e.detail?.rolledBack ? 'text-bad' : 'text-accent')} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[0.82rem]">{e.title}</div>
                      <div className="text-[0.68rem] text-subtle">{S?.[1]} · {timeAgo(e.created_at)}{e.agent_name && <> · <button className="hover:underline" onClick={() => set({ agentModal: e.agent_id })}>{e.agent_name}</button></>}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <div className="lg:col-span-2 flex flex-col gap-4">
            <section className="rounded-[var(--af-radius)] border border-line bg-panel">
              <div className="h-9 px-3.5 flex items-center border-b border-line text-[0.72rem] font-semibold uppercase tracking-wider text-muted">Playbook versions</div>
              <div className="p-3.5 max-h-56 overflow-auto">
                {data?.versions.length ? data.versions.map((v, i) => <div key={i} className="flex items-center gap-2 py-1 text-xs"><Badge tone="accent">v{v.version}</Badge><button className="font-medium hover:underline" onClick={() => set({ agentModal: v.agent_id })}>{v.name}</button><span className="text-muted truncate flex-1">{v.reason}</span><span className="text-subtle">{timeAgo(v.created_at)}</span></div>) : <div className="text-xs text-subtle">No versions promoted yet.</div>}
              </div>
            </section>
            <section className="rounded-[var(--af-radius)] border border-line bg-panel">
              <div className="h-9 px-3.5 flex items-center border-b border-line text-[0.72rem] font-semibold uppercase tracking-wider text-muted">Organizational memory</div>
              <div className="p-3.5 max-h-72 overflow-auto">
                {data?.experiences.length ? data.experiences.map((x, i) => (
                  <div key={i} className="flex gap-2 py-1.5 border-b last:border-0 border-line text-xs">
                    {x.kind === 'failure' ? <CircleX size={12} className="text-bad mt-0.5 shrink-0" /> : <Sparkles size={12} className="text-accent mt-0.5 shrink-0" />}
                    <span className="flex-1"><b className="font-medium">{x.agent_name}</b> <span className="text-muted">{x.content}</span></span>
                  </div>
                )) : <div className="text-xs text-subtle">Lessons from completed tasks accumulate here.</div>}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateAgent({ open, onClose }) {
  const st = useStore();
  const roles = st.roles?.roles || {};
  const [f, setF] = useState({ role: 'frontend', skills: [], skill: '', supervisor_id: '', model_id: '', mission: '', purpose: '', title: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF({ role: 'frontend', skills: [...(roles.frontend?.skills || [])], skill: '', supervisor_id: '', model_id: '', mission: '', purpose: '', title: '' }); }, [open]);
  const pickRole = (role) => setF({ ...f, role, skills: [...(roles[role]?.skills || [])] });
  const addSkill = () => { const s = f.skill.trim().toLowerCase(); if (s && !f.skills.includes(s)) setF({ ...f, skills: [...f.skills, s], skill: '' }); else setF({ ...f, skill: '' }); };
  const submit = async () => {
    setBusy(true);
    try {
      const a = await api.post('/api/agents', { role: f.role, title: f.title || undefined, skills: f.skills.map((n) => ({ name: n, level: 40 })), supervisor_id: f.supervisor_id || undefined, model_id: f.model_id || undefined, mission: f.mission || undefined, purpose: f.purpose || undefined });
      toast.success(`${a.name} joined as ${a.title}`);
      onClose();
      st.set({ agentModal: a.id });
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Create agent" icon={Plus} size="lg"
      footer={<><span className="mr-auto flex items-center gap-1.5 text-xs text-subtle"><Lock size={12} />The name is assigned by the system and cannot be edited.</span><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Plus} loading={busy} onClick={submit}>Create agent</Button></>}>
      <div className="flex flex-col gap-5">
        <Field label="Role">
          <div className="grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
            {Object.entries(roles).map(([k, r]) => {
              const S = ROLE_STYLE[k] || roleStyle(k);
              return (
                <button key={k} type="button" onClick={() => pickRole(k)} className={cx('flex items-center gap-2 p-2 rounded-lg border text-left transition-colors', f.role === k ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
                  <span className="size-6 rounded-md flex items-center justify-center text-white shrink-0" style={{ backgroundImage: `linear-gradient(135deg, ${S.from}, ${S.to})` }}><S.icon size={13} /></span>
                  <span className="min-w-0"><span className="block text-[0.76rem] font-medium truncate">{r.title}</span><span className="block text-[0.64rem] text-subtle">tier {r.tier}</span></span>
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Skills">
            <div className="flex flex-wrap gap-1.5 p-1.5 rounded-lg bg-sunken border border-line min-h-8">
              {f.skills.map((s) => <span key={s} className="flex items-center gap-1 h-6 pl-2 pr-1 rounded-md bg-raised border border-line text-xs">{s}<button onClick={() => setF({ ...f, skills: f.skills.filter((x) => x !== s) })} className="text-subtle hover:text-bad"><X size={11} /></button></span>)}
              <input value={f.skill} onChange={(e) => setF({ ...f, skill: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSkill(); } }} placeholder="add skill…" className="flex-1 min-w-20 bg-transparent outline-none text-xs px-1" />
            </div>
          </Field>
          <Field label="Custom title (optional)"><Input value={f.title} placeholder={roles[f.role]?.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Supervisor"><Select value={f.supervisor_id} onChange={(e) => setF({ ...f, supervisor_id: e.target.value })}><option value="">Automatic (by tier)</option>{st.agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.title}</option>)}</Select></Field>
          <Field label="Model"><Select value={f.model_id} onChange={(e) => setF({ ...f, model_id: e.target.value })}><option value="">Default model</option>{st.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        </div>
        <Field label="Mission (optional)"><Textarea rows={2} value={f.mission} onChange={(e) => setF({ ...f, mission: e.target.value })} placeholder="What this agent is accountable for" /></Field>
      </div>
    </Modal>
  );
}

export default function Agents({ layout }) {
  const agents = useStore((s) => s.agents);
  const [tab, setTab] = useState('registry');
  const [create, setCreate] = useState(false);
  const working = agents.filter((a) => a.status === 'working').length;
  return (
    <div className={cx('h-full flex flex-col', layout.floating && 'p-1.5')}>
      <div className={cx('flex-1 min-h-0 flex flex-col bg-panel', layout.floating && 'rounded-[var(--af-radius)] border border-line shadow-af overflow-hidden')}>
        <div className="flex items-center gap-3 px-4 h-12 border-b border-line shrink-0">
          <Bot size={16} className="text-subtle" />
          <span className="font-semibold text-[0.92rem]">Agents</span>
          <span className="text-xs text-subtle tabular">{agents.length} total · {working} working</span>
          <Tabs className="ml-3" value={tab} onChange={setTab} tabs={[{ id: 'registry', label: 'Registry', icon: LayoutGrid }, { id: 'org', label: 'Org chart', icon: Network }, { id: 'evolution', label: 'Evolution', icon: Dna }]} />
          <Button variant="primary" icon={Plus} className="ml-auto" onClick={() => setCreate(true)}>New agent</Button>
        </div>
        <div className="flex-1 min-h-0">
          {tab === 'registry' && <Registry />}
          {tab === 'org' && <OrgChart />}
          {tab === 'evolution' && <Evolution />}
        </div>
      </div>
      <CreateAgent open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

