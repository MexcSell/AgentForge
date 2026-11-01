import { useMemo, useRef, useState } from 'react';
import { Network, UserMinus } from 'lucide-react';
import { useStore } from '../../lib/store.js';
import { cx, AgentAvatar, Badge, Empty, IconButton, Progress } from '../../components/ui.jsx';
import { AgentWorkDialog, agentTasks, currentWork, TIER } from './AgentWorkDialog.jsx';

// Work state of an agent's current work (AgentWorkDialog's rules): a finished task stays on the card as Completed / Failed / Cancelled.
const STATE_OF = { running: 'working', done: 'completed', failed: 'failed', cancelled: 'cancelled', pending: 'queued' };
const STATES = {
  working: { label: 'Working', text: 'text-accent', dot: 'bg-accent' },
  orchestrating: { label: 'Orchestrating', text: 'text-accent', dot: 'bg-accent' }, // the GM without a task of its own during a mission
  completed: { label: 'Completed', text: 'text-ok', dot: 'bg-ok' },
  failed: { label: 'Failed', text: 'text-bad', dot: 'bg-bad' },
  cancelled: { label: 'Cancelled', text: 'text-subtle', dot: 'bg-subtle' },
  queued: { label: 'Queued', text: 'text-subtle', dot: 'bg-subtle' },
  idle: { label: 'Idle', text: 'text-subtle', dot: 'bg-line-strong' },
};
const ALWAYS = ['working', 'completed', 'idle']; // the other states are only counted when present
const LINE = { working: 'af-flow', completed: 'bg-ok' };
const EMPTY = [];
const IN_FLIGHT = ['planning', 'running'];

// Connector geometry (calc() so it follows the font scale): a child's elbow leaves its parent's trunk, which hangs from the
// parent's avatar centre (card border + p-2 + half the avatar), and enters the child's card at its avatar centre (li pt-1.5 on top).
const AVATAR = 26;
const TRUNK_X = `calc(0.5rem + ${AVATAR / 2 + 0.5}px)`;
const INDENT = `calc(0.5rem + ${AVATAR + 2}px)`;
const ELBOW_Y = `calc(0.875rem + ${AVATAR / 2 + 0.5}px)`;
const ELBOW_END = `calc(0.875rem + ${AVATAR / 2 + 1.5}px)`;
const ELBOW_W = `${AVATAR / 2 + 1.5}px`;

const byRank = (a, b) => (a.tier ?? 9) - (b.tier ?? 9) || (b.level || 1) - (a.level || 1) || (a.name || '').localeCompare(b.name || '');

/**
 * The team as a tree under the GM. Each member hangs under its nearest ancestor on the supervisor_id chain (walked through all
 * agents) that is also on the team, else directly under the GM. Without the GM on the team, the top-level members are the roots.
 */
export function orgTree(team, agents, managerId) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const nodes = new Map(team.map((a) => [a.id, { agent: a, children: [] }]));
  const parent = new Map();
  for (const a of team) {
    if (a.id === managerId) continue;
    const seen = new Set([a.id]);
    let p = null;
    for (let id = a.supervisor_id; id && !seen.has(id); id = byId.get(id)?.supervisor_id) {
      if (nodes.has(id)) { p = id; break; }
      seen.add(id);
    }
    parent.set(a.id, p);
  }
  // A supervisor loop among team members would hang off nothing: the member that closes it goes under the GM.
  for (const id of parent.keys()) {
    const seen = new Set();
    for (let p = id; p && p !== managerId; p = parent.get(p)) {
      if (seen.has(p)) { parent.set(id, null); break; }
      seen.add(p);
    }
  }
  const root = nodes.get(managerId);
  const top = [];
  for (const [id, p] of parent) (p ? nodes.get(p).children : root ? root.children : top).push(nodes.get(id));
  const sort = (list) => { list.sort((x, y) => byRank(x.agent, y.agent)); list.forEach((n) => sort(n.children)); return list; };
  return sort(root ? [root] : top);
}

const stateOf = (task) => (task ? STATE_OF[task.status] || 'idle' : 'idle');
const stateLabel = (task) => (task?.status === 'running' ? `Working ${Math.round(task.progress || 0)}%` : STATES[stateOf(task)].label);

function OrgCard({ agent, gm, task, orchestrating, releasable, onOpen }) {
  const level = agent.level || 1;
  const xp = agent.xp || 0;
  const xpPrev = 40 * (level - 1) ** 2;
  const xpNext = 40 * level ** 2;
  const xpPct = Math.max(0, Math.min(100, ((xp - xpPrev) / Math.max(1, xpNext - xpPrev)) * 100));
  const tier = TIER[agent.tier];
  const coordinating = gm && !task && orchestrating;
  const state = coordinating ? 'orchestrating' : stateOf(task);
  const label = coordinating ? STATES.orchestrating.label : stateLabel(task);
  const name = [agent.name, gm && 'General Manager', `L${level}${tier ? ` ${tier}` : ''}`, label, task && `${task.key} ${task.title}`].filter(Boolean).join(', ');
  return (
    <button type="button" onClick={onOpen} aria-label={name} data-agent={agent.id}
      className={cx('block w-full min-w-0 text-left p-2 rounded-xl border transition-colors hover:border-accent/50', state === 'working' || coordinating ? 'border-accent/40 bg-accent-soft/40' : 'border-line bg-raised')}>
      <span className="flex items-start gap-2 min-w-0">
        <AgentAvatar agent={agent} size={AVATAR} />
        <span className="min-w-0 flex-1">
          <span className={cx('flex items-center gap-1 min-w-0', releasable && 'pr-6')}>
            <span className="text-[0.8rem] font-medium truncate">{agent.name}</span>
            {gm && <Badge tone="accent" className="shrink-0">GM</Badge>}
            <Badge className="shrink-0 h-4! px-1! text-[0.62rem]! tabular">L{level}</Badge>
          </span>
          {tier && <span className="block text-[0.66rem] leading-4 text-subtle truncate">{tier}</span>}
          <span role="progressbar" aria-label={`XP toward L${level + 1}`} aria-valuenow={Math.round(xpPct)} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${xp} / ${xpNext} XP`}
            title={`${xp} / ${xpNext} XP to L${level + 1}`} className="mt-1.5 block h-1 rounded-full bg-hover overflow-hidden">
            <span className="block h-full rounded-full bg-series-1 transition-[width] duration-500" style={{ width: `${xpPct}%` }} />
          </span>
        </span>
      </span>
      <span className="mt-2 pt-2 border-t border-line flex flex-col gap-1.5 min-w-0">
        {task ? <>
          <span className="block text-[0.72rem] truncate"><span className="mono text-subtle text-[0.66rem]">{task.key}</span> {task.title}</span>
          <span className="flex items-center gap-2 min-w-0">
            <Progress value={task.status === 'done' ? 100 : task.progress || 0} tone={task.status === 'done' ? 'ok' : task.status === 'failed' ? 'bad' : 'accent'} striped={state === 'working'} className="flex-1 min-w-0" />
            <span data-state={state} className={cx('shrink-0 text-[0.66rem] font-medium tabular', STATES[state].text)}>{label}</span>
          </span>
        </> : coordinating ? (
          <span className="flex items-center gap-2 min-w-0">
            <span className="flex-1 min-w-0 truncate text-[0.72rem] text-subtle">Coordinating the mission</span>
            <span data-state="orchestrating" className={cx('shrink-0 text-[0.66rem] font-medium', STATES.orchestrating.text)}>{label}</span>
          </span>
        ) : (
          <span className="flex items-center gap-2 min-w-0">
            <span className="flex-1 min-w-0 truncate text-[0.72rem] text-subtle">No tasks in this project</span>
            <span data-state="idle" className="shrink-0 text-[0.66rem] font-medium text-subtle">Idle</span>
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * A member's Release button, top-right on its card (a sibling of the card button: buttons don't nest). With queued or running
 * work in the project it stays focusable but aria-disabled, and says why; activating it then only repeats the reason.
 */
function ReleaseButton({ agent, busy, onRelease }) {
  const label = busy.length ? `Can't release ${agent.name} yet: ${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} queued or running in this project` : `Release ${agent.name} from the project`;
  return (
    <IconButton icon={UserMinus} size="sm" label={label} tone={busy.length ? undefined : 'danger'} aria-disabled={busy.length ? true : undefined} data-release={agent.id}
      className={cx('absolute! top-1.5 right-1.5', busy.length && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-muted')}
      onClick={(e) => onRelease(agent, e.currentTarget, busy)} />
  );
}

function OrgNode({ node, depth, last, work, managerId, orchestrating, release, onOpen }) {
  const { agent } = node;
  const task = work.get(agent.id);
  const state = stateOf(task);
  const releasable = !!release && agent.id !== managerId;
  return (
    <li className={cx('relative min-w-0', depth > 0 && 'pt-1.5')} style={depth > 0 ? { paddingLeft: INDENT } : undefined} data-depth={depth}>
      {depth > 0 && <>
        <span aria-hidden="true" className="absolute top-0 w-px bg-line-strong" style={{ left: TRUNK_X, ...(last ? { height: ELBOW_END } : { bottom: 0 }) }} />
        <span aria-hidden="true" data-line={state} className={cx('absolute h-px', LINE[state] || 'bg-line-strong')} style={{ left: TRUNK_X, top: ELBOW_Y, width: ELBOW_W }} />
      </>}
      {releasable ? (
        <div className="relative min-w-0">
          <OrgCard agent={agent} gm={false} task={task} orchestrating={orchestrating} releasable onOpen={(e) => onOpen(agent.id, e)} />
          <ReleaseButton agent={agent} busy={release.busy(agent.id)} onRelease={release.onRelease} />
        </div>
      ) : <OrgCard agent={agent} gm={agent.id === managerId} task={task} orchestrating={orchestrating} onOpen={(e) => onOpen(agent.id, e)} />}
      {node.children.length > 0 && (
        <ul className="min-w-0">
          {node.children.map((c, i) => <OrgNode key={c.agent.id} node={c} depth={depth + 1} last={i === node.children.length - 1} work={work} managerId={managerId} orchestrating={orchestrating} release={release} onOpen={onOpen} />)}
        </ul>
      )}
    </li>
  );
}

/** A summary count: `children` is the visual chip, `label` what it says in words (also the tooltip). */
function Chip({ children, label }) {
  return (
    <li title={label} className="inline-flex items-center h-5 px-1.5 rounded-md bg-hover text-[0.68rem] text-muted whitespace-nowrap">
      <span aria-hidden="true" className="inline-flex items-center gap-1">{children}</span><span className="sr-only">{label}</span>
    </li>
  );
}

/**
 * The project team as a hierarchy under the GM, with each agent's level and current work; a card opens AgentWorkDialog.
 * release (optional): { busy(agentId) → task keys that block a release, onRelease(agent, opener, busy) } adds a Release
 * button to every card but the GM's.
 */
export function AgentOrg({ project, team, release }) {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks[project.id]) || EMPTY;
  const topics = useStore((s) => s.topics[project.id]) || EMPTY;
  const missionsByTopic = useStore((s) => s.missionsByTopic);
  const [selected, setSelected] = useState(null);
  const opener = useRef(null);
  const roots = useMemo(() => orgTree(team, agents, project.manager_id), [team, agents, project.manager_id]);
  const work = useMemo(() => new Map(team.map((a) => [a.id, currentWork(agentTasks(tasks, a.id))])), [team, tasks]);
  // The GM never holds mission tasks, so while the project is orchestrating it counts as orchestrating rather than idle.
  const orchestrating = useMemo(() => topics.some((t) => t.running)
    || Object.values(missionsByTopic).some((m) => m?.project_id === project.id && IN_FLIGHT.includes(m.status)), [topics, missionsByTopic, project.id]);
  const states = useMemo(() => {
    const n = Object.fromEntries(Object.keys(STATES).map((k) => [k, 0]));
    for (const a of team) {
      const task = work.get(a.id);
      n[a.id === project.manager_id && !task && orchestrating ? 'orchestrating' : stateOf(task)]++;
    }
    return Object.keys(STATES).filter((k) => ALWAYS.includes(k) || n[k]).map((k) => [k, n[k]]);
  }, [team, work, project.manager_id, orchestrating]);
  const open = (id, e) => { opener.current = e.currentTarget; setSelected(id); };
  const close = () => { setSelected(null); opener.current?.focus(); };

  if (!team.length) return <Empty icon={Network} title="No team yet">The hierarchy appears once the General Manager staffs this project.</Empty>;
  return (
    <div className="min-w-0 flex flex-col gap-2">
      <div className="p-2 rounded-xl border border-line bg-raised min-w-0">
        <div className="flex items-start gap-2 min-w-0">
          <span className="w-10 shrink-0 pt-1 text-[0.62rem] uppercase tracking-wider text-subtle">Work</span>
          <ul aria-label="Team by work state" className="flex flex-wrap gap-1 min-w-0">
            {states.map(([k, n]) => (
              <Chip key={k} label={`${n} ${STATES[k].label.toLowerCase()}`}><span className={cx('size-1.5 rounded-full', STATES[k].dot)} /><span className="tabular text-fg">{n}</span>{STATES[k].label.toLowerCase()}</Chip>
            ))}
          </ul>
        </div>
      </div>
      <ul aria-label="Team hierarchy" className="min-w-0 flex flex-col gap-1.5">
        {roots.map((n) => <OrgNode key={n.agent.id} node={n} depth={0} work={work} managerId={project.manager_id} orchestrating={orchestrating} release={release} onOpen={open} />)}
      </ul>
      <AgentWorkDialog project={project} agentId={selected} onClose={close} />
    </div>
  );
}
