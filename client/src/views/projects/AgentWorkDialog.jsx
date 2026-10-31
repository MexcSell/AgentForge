import { useMemo, useState } from 'react';
import {
  Activity, Ban, Brain, CircleCheck, CircleDashed, CircleHelp, CircleX, ClipboardList, FileText, GitBranch, History, ListChecks,
  LoaderCircle, MessageSquareText, ScrollText, Square, SquareCheck, Timer, UserRound, Wrench,
} from 'lucide-react';
import { useStore } from '../../lib/store.js';
import { clockTime, duration, timeAgo } from '../../lib/format.js';
import { Modal } from '../../components/Modal.jsx';
import { Markdown } from '../../components/Markdown.jsx';
import { cx, AgentAvatar, Badge, Button, Empty, Progress, useNow } from '../../components/ui.jsx';

export const TIER = { 1: 'Executive', 2: 'Management', 3: 'Specialist', 4: 'Verification', 5: 'Evolution' }; // as in AgentDetail.jsx
const STATUS = {
  running: { label: 'Running', tone: 'accent', icon: LoaderCircle, color: 'text-accent animate-spin' },
  done: { label: 'Completed', tone: 'ok', icon: CircleCheck, color: 'text-ok' },
  failed: { label: 'Failed', tone: 'bad', icon: CircleX, color: 'text-bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban, color: 'text-subtle' },
  pending: { label: 'Queued', tone: 'neutral', icon: CircleDashed, color: 'text-subtle' },
};
const UNKNOWN = { label: 'Unknown', tone: 'neutral', icon: CircleHelp, color: 'text-subtle' };
const FINISHED = ['done', 'failed', 'cancelled'];
const ACTIVITY = ['tool_use', 'thinking', 'text'];
const EMPTY = [];

const time = (d) => (d ? new Date(d).getTime() : 0);
const statusOf = (t) => (t ? STATUS[t.status] || { ...UNKNOWN, label: t.status } : UNKNOWN);
const isProposal = (t) => t.status === 'proposed' || t.origin === 'proposal';
const ago = (d) => { const s = timeAgo(d); return s === 'now' ? 'just now' : `${s} ago`; };
const took = (t) => (t.started_at && t.finished_at ? duration(time(t.finished_at) - time(t.started_at)) : null);
const RANK = { running: 0, pending: 1 };

/** The agent's tasks in a project, proposals left out: running (latest start first), queued (oldest first), then finished (latest first). */
export function agentTasks(tasks, agentId) {
  return tasks.filter((t) => t.agent_id === agentId && !isProposal(t)).sort((a, b) => {
    const r = (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2);
    if (r) return r;
    if (a.status === 'running') return time(b.started_at) - time(a.started_at);
    if (a.status === 'pending') return time(a.created_at) - time(b.created_at);
    return time(b.finished_at) - time(a.finished_at);
  });
}

/** The work an agentTasks() list shows: the running task, else the latest finished one (it stays as Completed), else the next queued one. */
export function currentWork(list) {
  return list.find((t) => t.status === 'running') || list.find((t) => FINISHED.includes(t.status)) || list.find((t) => t.status === 'pending') || null;
}

function activity(e) {
  const d = e.data || {};
  if (e.type === 'tool_use') return { icon: Wrench, text: `${d.name} ${d.input || ''}` };
  if (e.type === 'thinking') return { icon: Brain, text: d.text };
  return { icon: MessageSquareText, text: d.text };
}

function StatusIcon({ task, size = 14, className }) {
  const s = statusOf(task);
  return <s.icon size={size} aria-hidden="true" className={cx('shrink-0', s.color, className)} />;
}

function Elapsed({ since }) {
  const now = useNow();
  return <span className="tabular text-muted">{duration(now - time(since))}</span>;
}

function Section({ icon: Icon, title, count, children }) {
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-[0.68rem] uppercase tracking-wider text-subtle mb-1.5"><Icon size={11} />{title}{count != null && <span className="tabular">{count}</span>}</h3>
      {children}
    </section>
  );
}

function AgentHeader({ agent, name, role }) {
  const level = agent?.level || 1;
  const xp = agent?.xp || 0;
  const xpPrev = 40 * (level - 1) ** 2;
  const xpNext = 40 * level ** 2;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3 border-b border-line shrink-0">
      <AgentAvatar agent={agent} role={role} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[0.95rem] font-semibold truncate">{name}</span>
          {agent && <Badge tone="accent">L{level}</Badge>}
          {TIER[agent?.tier] && <Badge>{TIER[agent.tier]}</Badge>}
        </div>
        <div className="text-xs text-muted truncate">{agent?.title}</div>
      </div>
      {agent && (
        <div className="w-full sm:w-52 flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-[0.68rem] text-subtle">
            <span>XP to L{level + 1}</span>
            <span className="tabular text-muted">{xp} / {xpNext}</span>
          </div>
          <Progress value={((xp - xpPrev) / Math.max(1, xpNext - xpPrev)) * 100} />
        </div>
      )}
    </div>
  );
}

function WorkCard({ task, heading, onCurrent }) {
  const s = statusOf(task);
  const running = task.status === 'running';
  const finished = FINISHED.includes(task.status);
  const value = task.status === 'done' ? 100 : task.progress || 0;
  return (
    <div className={cx('p-3.5 rounded-xl border', running ? 'border-accent/40 bg-accent-soft/40' : 'border-line bg-raised')}>
      <div className={cx('flex items-center gap-1.5 text-[0.68rem] uppercase tracking-wider font-semibold', running ? 'text-accent' : 'text-subtle')}>
        <Activity size={11} />{heading}
        {onCurrent && <button className="ml-auto normal-case tracking-normal font-medium text-accent hover:underline" onClick={onCurrent}>Back to current work</button>}
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        <div className="min-w-0 flex-1 text-[0.92rem] font-medium leading-snug"><span className="mono text-subtle text-[0.75rem] mr-1.5">{task.key}</span>{task.title}</div>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <div className="mt-3 flex items-center gap-2.5">
        <Progress value={value} tone={task.status === 'done' ? 'ok' : task.status === 'failed' ? 'bad' : 'accent'} striped={running} className="flex-1" />
        <span className="w-9 text-right text-xs tabular text-muted">{Math.round(value)}%</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-subtle">
        {running && task.started_at && <span className="flex items-center gap-1"><Timer size={11} />Elapsed <Elapsed since={task.started_at} /></span>}
        {finished && <span className="flex items-center gap-1"><Timer size={11} />Took <span className="tabular text-muted">{took(task) || '—'}</span></span>}
        {task.started_at && <span>Started {clockTime(task.started_at)}</span>}
        {finished && task.finished_at && <span>Finished {ago(task.finished_at)}</span>}
        {task.status === 'pending' && <span>Queued {ago(task.created_at)}</span>}
      </div>
    </div>
  );
}

function WorkDetails({ project, agentId }) {
  const all = useStore((s) => s.tasks[project.id]) || EMPTY;
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const live = useStore((s) => s.live[agentId]) || EMPTY;
  const [picked, setPicked] = useState(null);
  const tasks = useMemo(() => agentTasks(all, agentId), [all, agentId]);
  const current = currentWork(tasks);
  const task = tasks.find((t) => t.id === picked) || current;
  const events = useMemo(() => (task?.status === 'running' ? live.filter((e) => ACTIVITY.includes(e.type) && e.task_id === task.id).slice(-12) : EMPTY), [live, task?.id, task?.status]);
  const name = agent?.name || tasks[0]?.agent_name || 'Agent';
  const header = <AgentHeader agent={agent} name={name} role={agent?.role || tasks[0]?.agent_role} />;

  if (!task) return (
    <div className="md:h-full flex flex-col">
      {header}
      <div className="flex-1 min-h-0"><Empty icon={ClipboardList} title="No work yet">{name} has no tasks in {project.name}.</Empty></div>
    </div>
  );

  const isCurrent = task.id === current?.id;
  const finished = FINISHED.includes(task.status);
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : EMPTY;
  const deps = (Array.isArray(task.depends_on) ? task.depends_on : EMPTY).map((key) => ({ key, dep: all.find((t) => t.mission_id === task.mission_id && t.key === key && !isProposal(t)) }));
  const heading = !isCurrent ? 'Selected task' : task.status === 'running' ? 'Working on' : finished ? 'Latest task' : 'Up next';

  return (
    <div className="md:h-full flex flex-col">
      {header}
      <div className="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="md:min-h-0 md:overflow-auto p-4 flex flex-col gap-4">
          <WorkCard task={task} heading={heading} onCurrent={!isCurrent && current ? () => setPicked(null) : null} />

          {task.description && <Section icon={FileText} title="Description"><Markdown>{task.description}</Markdown></Section>}

          {acceptance.length > 0 && (
            <Section icon={ListChecks} title="Acceptance criteria" count={acceptance.length}>
              <ul className="flex flex-col gap-1.5">
                {acceptance.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-[0.82rem]">
                    {task.status === 'done' ? <SquareCheck size={14} aria-hidden="true" className="text-ok mt-0.5 shrink-0" /> : <Square size={14} aria-hidden="true" className="text-subtle mt-0.5 shrink-0" />}
                    <span className={task.status === 'done' ? 'text-fg' : 'text-muted'}>{task.status === 'done' && <span className="sr-only">Met: </span>}{String(c)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {deps.length > 0 && (
            <Section icon={GitBranch} title="Depends on" count={deps.length}>
              <ul className="flex flex-col gap-1">
                {deps.map(({ key, dep }) => (
                  <li key={key} className="flex items-center gap-2 text-[0.8rem] min-w-0">
                    <StatusIcon task={dep} />
                    <span className="mono text-subtle text-[0.7rem] shrink-0">{key}</span>
                    <span className={cx('truncate flex-1', !dep && 'text-subtle')}>{dep ? dep.title : 'Not among the recent tasks'}</span>
                    {dep && <span className="text-[0.68rem] text-subtle shrink-0">{dep.agent_name ? `${dep.agent_name} · ` : ''}{statusOf(dep).label}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {task.status === 'running' && (
            <Section icon={Activity} title="Live activity">
              {events.length ? (
                <ol className="flex flex-col gap-1">
                  {events.map((e, i) => {
                    const a = activity(e);
                    return <li key={i} className="flex items-center gap-1.5 text-[0.7rem] text-muted min-w-0"><a.icon size={11} className="shrink-0 text-accent" /><span className="truncate mono">{a.text}</span></li>;
                  })}
                </ol>
              ) : <div className="text-xs text-subtle">Waiting for the agent's next step…</div>}
            </Section>
          )}

          {finished && (
            <Section icon={ScrollText} title="Result">
              {task.result ? (
                <div tabIndex={0} role="region" aria-label="Result" className="max-h-72 overflow-auto rounded-lg border border-line bg-sunken px-3 py-2.5"><Markdown>{task.result}</Markdown></div>
              ) : <div className="text-xs text-subtle">No result was reported.</div>}
            </Section>
          )}
        </div>

        <aside aria-label="Tasks in this project" className="md:min-h-0 md:overflow-auto border-t md:border-t-0 md:border-l border-line p-2">
          <h3 className="flex items-center gap-1.5 px-1.5 pt-1 pb-2 text-[0.68rem] uppercase tracking-wider text-subtle"><History size={11} />Tasks in this project<span className="tabular">{tasks.length}</span></h3>
          <ul className="flex flex-col gap-0.5">
            {tasks.map((t) => {
              const s = statusOf(t);
              const meta = t.status === 'running' ? `${t.progress || 0}%` : FINISHED.includes(t.status) ? [took(t), t.finished_at && timeAgo(t.finished_at)].filter(Boolean).join(' · ') : '';
              return (
                <li key={t.id}>
                  <button onClick={() => setPicked(t.id === current?.id ? null : t.id)} aria-current={t.id === task.id ? 'true' : undefined}
                    className={cx('w-full text-left flex items-start gap-2 p-2 rounded-lg transition-colors', t.id === task.id ? 'bg-accent-soft' : 'hover:bg-hover')}>
                    <StatusIcon task={t} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.78rem] truncate"><span className="mono text-subtle text-[0.68rem]">{t.key}</span> {t.title}</span>
                      <span className="block text-[0.66rem] text-subtle truncate">{s.label}{meta && ` · ${meta}`}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    </div>
  );
}

/** What an agent is working on in a project: open while `agentId` is set, live from the store (tasks, agents, run events). */
export function AgentWorkDialog({ project, agentId, onClose }) {
  const set = useStore((s) => s.set);
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const openProfile = () => { set({ agentModal: agentId }); onClose?.(); };
  return (
    <Modal open={!!agentId} onClose={onClose} size="lg" bodyClass="p-0" icon={Activity} title="Work details"
      subtitle={[agent?.name, project?.name].filter(Boolean).join(' · ')}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" icon={UserRound} onClick={openProfile}>Open full profile</Button>
      </>}>
      <WorkDetails key={agentId} project={project} agentId={agentId} />
    </Modal>
  );
}
