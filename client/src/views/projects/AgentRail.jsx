import { useMemo, useState } from 'react';
import { Bot, CircleCheck, CircleX, Ban, Wrench, Brain, MessageSquareText, Users, Lightbulb } from 'lucide-react';
import { useStore } from '../../lib/store.js';
import { duration, timeAgo } from '../../lib/format.js';
import { cx, AgentAvatar, Progress, Tabs, Empty, Badge } from '../../components/ui.jsx';

function lastActivity(events) {
  const e = [...(events || [])].reverse().find((x) => ['tool_use', 'text', 'thinking', 'status'].includes(x.type));
  if (!e) return null;
  if (e.type === 'tool_use') return { icon: Wrench, text: `${e.data.name} ${e.data.input || ''}` };
  if (e.type === 'thinking') return { icon: Brain, text: e.data.text };
  return { icon: MessageSquareText, text: e.data.text };
}

export function AgentRail({ project }) {
  const st = useStore();
  const tasks = st.tasks[project.id] || [];
  const [tab, setTab] = useState('running');
  const running = tasks.filter((t) => t.status === 'running');
  const finished = tasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status));
  const proposals = tasks.filter((t) => t.status === 'proposed');
  const team = useMemo(() => {
    const ids = new Set([project.manager_id, ...tasks.map((t) => t.agent_id)]);
    return st.agents.filter((a) => ids.has(a.id));
  }, [tasks, st.agents, project.manager_id]);
  const runningAgents = new Set(running.map((t) => t.agent_id)).size;
  const open = (id) => st.set({ agentModal: id });

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-3.5 h-14 border-b border-line shrink-0">
        <span className={cx('size-9 rounded-xl flex items-center justify-center', runningAgents ? 'grad-accent text-accent-fg' : 'bg-hover text-subtle')}><Bot size={18} /></span>
        <div>
          <div className="text-xl font-semibold leading-none tabular">{runningAgents}</div>
          <div className="text-[0.68rem] text-subtle mt-0.5">agent{runningAgents === 1 ? '' : 's'} running · {team.length} on team</div>
        </div>
      </div>
      <div className="px-2.5 py-2 border-b border-line shrink-0 overflow-x-auto">
        <Tabs size="sm" value={tab} onChange={setTab} tabs={[
          { id: 'running', label: 'Running', count: running.length },
          { id: 'done', label: 'Completed', count: finished.length },
          { id: 'team', label: 'Team', count: team.length },
          ...(proposals.length ? [{ id: 'proposals', label: 'Ideas', count: proposals.length }] : []),
        ]} />
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2 flex flex-col gap-1.5">
        {tab === 'running' && (running.length ? running.map((t) => {
          const agent = st.agents.find((a) => a.id === t.agent_id);
          const act = lastActivity(st.live[t.agent_id]);
          return (
            <button key={t.id} onClick={() => open(t.agent_id)} className="text-left p-2.5 rounded-xl border border-line bg-raised hover:border-accent/50 transition-colors animate-af-in">
              <div className="flex items-center gap-2.5">
                <AgentAvatar agent={agent} role={t.agent_role} size={30} status="working" />
                <div className="min-w-0 flex-1">
                  <div className="text-[0.82rem] font-medium truncate">{t.agent_name}</div>
                  <div className="text-[0.68rem] text-subtle truncate">{agent?.title}</div>
                </div>
                <span className="text-[0.68rem] tabular text-muted">{t.started_at ? duration(Date.now() - new Date(t.started_at)) : ''}</span>
              </div>
              <div className="mt-2 text-xs truncate"><span className="mono text-subtle">{t.key}</span> {t.title}</div>
              <Progress value={t.progress} className="mt-2" striped />
              {act && <div className="mt-2 flex items-center gap-1.5 text-[0.7rem] text-muted min-w-0"><act.icon size={11} className="shrink-0 text-accent" /><span className="truncate mono">{act.text}</span></div>}
            </button>
          );
        }) : <Empty icon={Bot} title="No agents running">Give the General Manager an order to start a mission.</Empty>)}

        {tab === 'done' && (finished.length ? finished.map((t) => (
          <button key={t.id} onClick={() => t.agent_id && open(t.agent_id)} className="text-left flex items-start gap-2.5 p-2 rounded-lg hover:bg-hover">
            {t.status === 'done' ? <CircleCheck size={15} className="text-ok mt-0.5 shrink-0" /> : t.status === 'failed' ? <CircleX size={15} className="text-bad mt-0.5 shrink-0" /> : <Ban size={15} className="text-subtle mt-0.5 shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="text-[0.8rem] truncate"><span className="mono text-subtle text-[0.7rem]">{t.key}</span> {t.title}</div>
              <div className="text-[0.68rem] text-subtle truncate">{t.agent_name || '—'} · {t.started_at && t.finished_at ? duration(new Date(t.finished_at) - new Date(t.started_at)) : t.status} · {timeAgo(t.finished_at)}</div>
            </div>
          </button>
        )) : <Empty icon={CircleCheck} title="Nothing completed yet" />)}

        {tab === 'team' && (team.length ? team.map((a) => (
          <button key={a.id} onClick={() => open(a.id)} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-hover text-left">
            <AgentAvatar agent={a} size={28} />
            <div className="min-w-0 flex-1"><div className="text-[0.8rem] font-medium truncate">{a.name}</div><div className="text-[0.68rem] text-subtle truncate">{a.title} · L{a.level}</div></div>
            {a.id === project.manager_id && <Badge tone="accent">GM</Badge>}
          </button>
        )) : <Empty icon={Users} title="No team yet" />)}

        {tab === 'proposals' && proposals.map((t) => (
          <div key={t.id} className="p-2.5 rounded-lg border border-warn/40 bg-warn-soft/40">
            <div className="flex items-center gap-1.5 text-[0.8rem] font-medium"><Lightbulb size={13} className="text-warn" />{t.title}</div>
            <div className="text-[0.7rem] text-muted mt-1 line-clamp-3">{t.description}</div>
            <div className="text-[0.68rem] text-subtle mt-1">from {t.agent_name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
