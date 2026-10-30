import { useEffect, useMemo, useState } from 'react';
import {
  Bell, BellRing, CheckCheck, FolderKanban, Bot, ListChecks, Coins, Activity, Megaphone, Send, Trash2, Server, Crown, Workflow,
  CircleCheck, CircleX, TriangleAlert, Info, Trophy, Cpu, HeartPulse, RefreshCw, Clock, Zap, ShieldCheck, Hammer,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore, selectUnread } from '../lib/store.js';
import { timeAgo, compact, usd, duration, bytes, dateTime } from '../lib/format.js';
import { Split } from '../components/Split.jsx';
import { ThroughputChart, Sparkline, StatusBar as TaskStatusBar } from '../components/charts.jsx';
import { cx, Badge, Button, IconButton, Input, PanelHeader, Tabs, StatusDot, AgentAvatar, Empty, Select, Meter, STATUS_TONE } from '../components/ui.jsx';

const SOURCE = {
  admin: { icon: Crown, label: 'Admin' },
  manager: { icon: Workflow, label: 'Manager' },
  agent: { icon: Bot, label: 'Agent' },
  system: { icon: Server, label: 'System' },
};
const LEVEL = { success: [CircleCheck, 'text-ok'], error: [CircleX, 'text-bad'], warning: [TriangleAlert, 'text-warn'], info: [Info, 'text-info'] };

function Tile({ icon: Icon, label, value, sub, tone, children, onClick }) {
  return (
    <button onClick={onClick} className="group text-left flex flex-col gap-1 p-3.5 rounded-[var(--af-radius)] border border-line bg-panel hover:border-line-strong transition-colors min-w-0">
      <div className="flex items-center gap-2 text-[0.72rem] font-medium text-muted">
        <span className={cx('size-6 rounded-md flex items-center justify-center', tone || 'bg-accent-soft text-accent')}><Icon size={13} /></span>
        <span className="truncate">{label}</span>
      </div>
      <div className="text-[1.6rem] font-semibold tracking-tight tabular leading-none mt-1.5">{value}</div>
      {sub && <div className="text-[0.72rem] text-subtle truncate">{sub}</div>}
      {children}
    </button>
  );
}

function Notifications() {
  const st = useStore();
  const unread = useStore(selectUnread);
  const [compose, setCompose] = useState('');
  const [level, setLevel] = useState('info');
  const filter = st.notifFilter;
  const list = st.notifications.filter((n) => filter === 'all' || (filter === 'unread' ? !n.read : n.source_type === filter));
  const counts = useMemo(() => {
    const c = { all: st.notifications.length, unread };
    for (const n of st.notifications) c[n.source_type] = (c[n.source_type] || 0) + 1;
    return c;
  }, [st.notifications, unread]);
  const post = async () => {
    if (!compose.trim()) return;
    await api.post('/api/notifications', { title: compose.trim(), level });
    setCompose('');
  };
  return (
    <div className="h-full flex flex-col">
      <PanelHeader icon={unread ? BellRing : Bell} title="Notifications" count={unread ? `${unread} unread` : null}>
        <IconButton icon={CheckCheck} label="Mark all read" onClick={() => api.post('/api/notifications/read', {})} disabled={!unread} />
      </PanelHeader>
      <div className="px-3 pt-2.5 pb-2 border-b border-line overflow-x-auto">
        <Tabs size="sm" value={filter} onChange={(v) => st.set({ notifFilter: v })} tabs={[
          { id: 'all', label: 'All', count: counts.all }, { id: 'unread', label: 'Unread', count: counts.unread },
          { id: 'admin', label: 'Admin', count: counts.admin || 0 }, { id: 'manager', label: 'Managers', count: counts.manager || 0 },
          { id: 'agent', label: 'Agents', count: counts.agent || 0 }, { id: 'system', label: 'System', count: counts.system || 0 },
        ]} />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!list.length && <Empty icon={Bell} title="All caught up">Notices from admins, managers and agents appear here.</Empty>}
        {list.map((n) => {
          const S = SOURCE[n.source_type] || SOURCE.system;
          const [LI, lc] = LEVEL[n.level] || LEVEL.info;
          return (
            <div key={n.id} onClick={() => !n.read && api.post('/api/notifications/read', { ids: [n.id] })}
              className={cx('group relative flex gap-3 px-3.5 py-2.5 border-b border-line cursor-default hover:bg-hover', !n.read && 'bg-accent-soft/40')}>
              {!n.read && <span className="absolute left-1.5 top-4 size-1.5 rounded-full bg-accent" />}
              <div className="relative shrink-0 mt-0.5">
                <span className="size-7 rounded-lg bg-hover flex items-center justify-center text-muted"><S.icon size={14} /></span>
                <LI size={12} className={cx('absolute -bottom-1 -right-1 bg-panel rounded-full', lc)} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cx('text-[0.82rem] leading-snug', n.read ? 'text-muted' : 'text-fg font-medium')}>{n.title}</span>
                </div>
                {n.body && <div className="text-xs text-subtle mt-0.5 line-clamp-2">{n.body}</div>}
                <div className="flex items-center gap-1.5 mt-1 text-[0.68rem] text-subtle">
                  <span>{n.source_name || S.label}</span>{n.project_name && <><span>·</span><span>{n.project_name}</span></>}<span>·</span><span title={dateTime(n.created_at)}>{timeAgo(n.created_at)}</span>
                </div>
              </div>
              <IconButton icon={Trash2} size="sm" label="Delete" tone="danger" className="opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); api.del(`/api/notifications/${n.id}`); }} />
            </div>
          );
        })}
      </div>
      <div className="p-2.5 border-t border-line flex gap-2">
        <Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-24 shrink-0" aria-label="Level">
          <option value="info">Info</option><option value="success">Success</option><option value="warning">Warning</option><option value="error">Critical</option>
        </Select>
        <Input className="flex-1" icon={Megaphone} placeholder="Post a notice as admin…" value={compose} onChange={(e) => setCompose(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && post()} />
        <IconButton icon={Send} label="Post" onClick={post} disabled={!compose.trim()} />
      </div>
    </div>
  );
}

function Card({ title, icon: Icon, children, right, className }) {
  return (
    <section className={cx('rounded-[var(--af-radius)] border border-line bg-panel', className)}>
      <div className="flex items-center gap-2 h-9 px-3.5 border-b border-line">
        {Icon && <Icon size={13} className="text-subtle" />}
        <h3 className="text-[0.72rem] font-semibold uppercase tracking-wider text-muted">{title}</h3>
        <div className="ml-auto">{right}</div>
      </div>
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export default function Dashboard({ layout }) {
  const st = useStore();
  const [data, setData] = useState(null);
  const tick = st.notifications.length + st.agents.filter((a) => a.status === 'working').length + st.evolutionTick;
  useEffect(() => {
    let alive = true;
    api.get('/api/dashboard', { quiet: true }).then((d) => alive && setData(d)).catch(() => {});
    return () => { alive = false; };
  }, [tick, st.projects]);
  const sys = st.system;
  const c = data?.counts || {};
  const status = !st.connected ? 'offline' : sys?.status || 'online';
  const def = st.models.find((m) => m.is_default);

  const overview = (
    <div className="h-full overflow-auto">
      <div className="p-4 flex flex-col gap-4 max-w-[1400px]">
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <Tile icon={HeartPulse} label="Service" value={<span className="flex items-center gap-2 text-[1.25rem] capitalize"><StatusDot status={status} className="size-2.5" />{status}</span>}
            sub={sys ? `up ${duration(sys.uptimeSec * 1000)} · ${sys.supervisor?.attached ? 'supervised' : 'unsupervised'}` : '—'} tone="bg-ok-soft text-ok" onClick={() => st.set({ view: 'settings' })} />
          <Tile icon={FolderKanban} label="Projects running" value={<>{c.projects_running ?? 0}<span className="text-base text-subtle font-normal"> / {c.projects ?? 0}</span></>} sub="click to open projects" onClick={() => st.set({ view: 'projects' })} />
          <Tile icon={Bot} label="Agents working" value={<>{c.agents_working ?? 0}<span className="text-base text-subtle font-normal"> / {c.agents ?? 0}</span></>} sub={`${st.agents.filter((a) => a.origin === 'cloned').length} clones · ${st.agents.filter((a) => a.origin === 'created').length} recruited`} onClick={() => st.set({ view: 'agents' })} />
          <Tile icon={ListChecks} label="Tasks today" value={c.tasks_done_today ?? 0} sub={`${c.tasks_failed_today ?? 0} failed · ${c.tasks_running ?? 0} running · ${c.proposals ?? 0} proposals`} tone="bg-info-soft text-info" />
          <Tile icon={Coins} label="Tokens today" value={compact(c.tokens_today)} sub={`${usd(c.cost_week)} reported this week`} onClick={() => st.set({ view: 'models' })}>
            {data && <div className="mt-1.5"><Sparkline values={data.throughput.map((d) => d.tokens)} labels={data.throughput.map((d) => d.day)} height={26} /></div>}
          </Tile>
          <Tile icon={Bell} label="Unread notices" value={c.unread ?? 0} sub={`${st.notifications.length} total`} tone={c.unread ? 'bg-bad-soft text-bad' : undefined} />
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card title="Task throughput · 14 days" icon={Activity} className="lg:col-span-3">
            {data ? <ThroughputChart data={data.throughput} /> : <div className="h-44" />}
          </Card>
          <Card title="Task states" icon={ListChecks} className="lg:col-span-2">
            {data && <TaskStatusBar dist={data.statusDist} />}
            {def && (
              <div className="mt-4 pt-3.5 border-t border-line flex flex-col gap-3">
                <div className="flex items-center gap-2 text-xs"><Cpu size={12} className="text-subtle" /><span className="font-medium">{def.name}</span><Badge tone="accent">default</Badge></div>
                <Meter label="Tokens today" used={def.usage.daily.tokens} limit={def.limits?.dailyTokens} format={compact} />
                <Meter label="Prompts today" used={def.usage.daily.prompts} limit={def.limits?.dailyPrompts} />
              </div>
            )}
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card title="Recent missions" icon={Zap} className="lg:col-span-3">
            {!data?.activity?.length && <div className="text-xs text-subtle">No missions yet. Open a project and give its General Manager an order.</div>}
            <div className="flex flex-col -my-1">
              {data?.activity?.map((m) => (
                <button key={m.id} onClick={() => st.set({ view: 'projects', activeProjectId: m.project_id })} className="flex items-center gap-3 py-2 border-b last:border-0 border-line text-left hover:bg-hover -mx-2 px-2 rounded-md">
                  <StatusDot status={m.status === 'done' ? 'done' : m.status === 'failed' ? 'failed' : ['running', 'planning'].includes(m.status) ? 'running' : 'idle'} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[0.82rem] truncate">{m.command.split('\n')[0]}</div>
                    <div className="text-[0.68rem] text-subtle">{m.project_name} · {m.done}/{m.tasks} tasks · {timeAgo(m.created_at)}{m.finished_at ? ` · ${duration(new Date(m.finished_at) - new Date(m.created_at))}` : ''}</div>
                  </div>
                  <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
                </button>
              ))}
            </div>
          </Card>
          <div className="lg:col-span-2 flex flex-col gap-4">
            <Card title="Top agents" icon={Trophy}>
              <div className="flex flex-col gap-2">
                {data?.leaders?.map((a, i) => (
                  <button key={a.id} onClick={() => st.set({ agentModal: a.id })} className="flex items-center gap-2.5 text-left hover:bg-hover -mx-1.5 px-1.5 py-1 rounded-md">
                    <span className="w-4 text-xs text-subtle tabular">{i + 1}</span>
                    <AgentAvatar agent={a} size={24} />
                    <div className="min-w-0 flex-1"><div className="text-[0.8rem] font-medium truncate">{a.name}</div><div className="text-[0.68rem] text-subtle truncate">{a.title}</div></div>
                    <span className="text-xs tabular text-muted">L{a.level} · {a.xp} XP</span>
                  </button>
                ))}
              </div>
            </Card>
            <Card title="Service health" icon={ShieldCheck}>
              {sys && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <dt className="text-subtle">Database</dt><dd className="flex items-center gap-1.5">{sys.db ? <CircleCheck size={12} className="text-ok" /> : <CircleX size={12} className="text-bad" />}{sys.db ? 'PostgreSQL connected' : 'unreachable'}</dd>
                  <dt className="text-subtle">Supervisor</dt><dd className="flex items-center gap-1.5">{sys.supervisor?.attached ? <CircleCheck size={12} className="text-ok" /> : <TriangleAlert size={12} className="text-warn" />}{sys.supervisor?.attached ? `${sys.supervisor.restarts || 0} safe restarts` : 'not attached'}</dd>
                  <dt className="text-subtle">Last restart</dt><dd className="flex items-center gap-1.5"><RefreshCw size={11} className="text-subtle" />{sys.supervisor?.lastRestartAt ? timeAgo(sys.supervisor.lastRestartAt) + ' ago' : '—'}</dd>
                  <dt className="text-subtle">Last UI build</dt><dd className="flex items-center gap-1.5"><Hammer size={11} className="text-subtle" />{sys.supervisor?.lastBuildAt ? timeAgo(sys.supervisor.lastBuildAt) + ' ago' : '—'}</dd>
                  <dt className="text-subtle">Memory</dt><dd>{bytes(sys.memory.rss)} · load {sys.load.toFixed(2)}</dd>
                  <dt className="text-subtle">Started</dt><dd className="flex items-center gap-1.5"><Clock size={11} className="text-subtle" />{dateTime(sys.startedAt)}</dd>
                </dl>
              )}
              {sys?.supervisor?.lastError && <pre className="mt-3 p-2 rounded-md bg-bad-soft text-bad text-[0.7rem] whitespace-pre-wrap max-h-28 overflow-auto">{sys.supervisor.lastError}</pre>}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <Split id="dashboard" orientation={layout.dashboard.orientation} floating={layout.floating}
      panels={[{ id: 'notifications', size: layout.dashboard.orientation === 'vertical' ? 38 : 30, min: 18, node: <Notifications /> }, { id: 'overview', size: layout.dashboard.orientation === 'vertical' ? 62 : 70, min: 30, node: overview }]} />
  );
}
