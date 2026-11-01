import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Search, UserMinus, UserPlus } from 'lucide-react';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { Confirm, Modal } from '../../components/Modal.jsx';
import { cx, AgentAvatar, Badge, Button, Input, Select } from '../../components/ui.jsx';
import { AgentOrg } from './AgentOrg.jsx';
import { TIER } from './AgentWorkDialog.jsx';

const EMPTY = [];
const BUSY = ['pending', 'running']; // the task states that block a release (members.js)
const roleLabel = (roles, r) => roles?.[r]?.title || r;

/** Picks agents to add: every live agent not on the team (released members come back), with a search and a role filter. */
function AddAgentPicker({ open, project, candidates, released, onAdd, onClose }) {
  const roles = useStore((s) => s.roles?.roles);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [adding, setAdding] = useState(null);
  const list = useRef(null);
  const searchId = useId();
  useEffect(() => { if (open) { setQ(''); setRole(''); setAdding(null); } }, [open]);
  const roleOptions = useMemo(() => [...new Set(candidates.map((a) => a.role).filter(Boolean))].sort(), [candidates]);
  const needle = q.trim().toLowerCase();
  const shown = candidates.filter((a) => (!role || a.role === role)
    && (!needle || [a.name, a.title, a.role, roleLabel(roles, a.role)].some((x) => x && String(x).toLowerCase().includes(needle))));
  // Up/Down move between the search field and the rows.
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(list.current?.querySelectorAll('button[data-add]') || [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? items[Math.min(items.length - 1, i + 1)] : i <= 0 ? document.getElementById(searchId) : items[i - 1];
    if (next) { e.preventDefault(); next.focus(); }
  };
  const add = async (a) => {
    if (adding) return;
    setAdding(a.id);
    try { await onAdd(a); } catch { setAdding(null); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Add an agent to ${project.name}`} icon={UserPlus} size="sm" bodyClass="p-3">
      <div className="flex flex-col gap-2" onKeyDown={onKeyDown}>
        <div className="flex gap-2 min-w-0">
          <Input id={searchId} autoFocus icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents" aria-label="Search agents" className="flex-1 min-w-0" />
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role" className="w-32 min-w-0">
            <option value="">All roles</option>
            {roleOptions.map((r) => <option key={r} value={r}>{roleLabel(roles, r)}</option>)}
          </Select>
        </div>
        <div aria-live="polite" className="sr-only">{`${shown.length} agent${shown.length === 1 ? '' : 's'} available`}</div>
        {shown.length ? (
          <ul ref={list} aria-label="Agents you can add" className="flex flex-col gap-1 max-h-[50vh] overflow-auto">
            {shown.map((a) => {
              const tier = TIER[a.tier];
              return (
                <li key={a.id}>
                  <button type="button" data-add={a.id} disabled={!!adding} onClick={() => add(a)}
                    aria-label={[`Add ${a.name}`, roleLabel(roles, a.role), `L${a.level || 1}${tier ? ` ${tier}` : ''}`, released.has(a.id) && 'released from this project'].filter(Boolean).join(', ')}
                    className="w-full min-w-0 flex items-center gap-2 p-1.5 rounded-lg text-left border border-transparent hover:bg-hover hover:border-line disabled:opacity-60">
                    <AgentAvatar agent={a} size={26} status="idle" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 min-w-0">
                        <span className="text-[0.82rem] font-medium truncate">{a.name}</span>
                        {released.has(a.id) && <Badge>Released</Badge>}
                      </span>
                      <span className="block text-[0.7rem] text-subtle truncate">{a.title || roleLabel(roles, a.role)} · L{a.level || 1}{tier ? ` ${tier}` : ''}</span>
                    </span>
                    <UserPlus size={14} aria-hidden="true" className="shrink-0 text-subtle" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="py-6 text-center text-xs text-muted">{candidates.length ? 'No agents match the search.' : 'Every agent is already on this team.'}</div>
        )}
      </div>
    </Modal>
  );
}

/** Released members, collapsed by default; Restore makes one an active member again. */
function ReleasedSection({ released, agentsById, onRestore }) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState(null);
  const listId = useId();
  if (!released.length) return null;
  const restore = async (m) => {
    setRestoring(m.agent_id);
    try { await onRestore(m); } catch { /* api.js showed the server's message */ } finally { setRestoring(null); }
  };
  return (
    <section aria-label="Released agents" className="rounded-xl border border-line bg-raised min-w-0">
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)} data-released-toggle
        className="w-full min-w-0 flex items-center gap-1.5 h-8 px-2 text-left rounded-xl hover:bg-hover">
        <ChevronRight size={13} aria-hidden="true" className={cx('shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        <span className="text-[0.68rem] uppercase tracking-wider text-subtle truncate">Released</span>
        <span className="text-[0.68rem] font-semibold text-subtle tabular">{released.length}</span>
      </button>
      {open && (
        <ul id={listId} className="px-2 pb-2 flex flex-col gap-1 min-w-0">
          {released.map((m) => {
            const a = agentsById.get(m.agent_id) || { id: m.agent_id, name: m.name, role: m.role };
            return (
              <li key={m.agent_id} className="flex items-center gap-2 min-w-0">
                <AgentAvatar agent={a} size={20} status="idle" />
                <span className="flex-1 min-w-0 text-[0.75rem] truncate" title={a.name}>{a.name}</span>
                <Button size="sm" variant="ghost" className="shrink-0" loading={restoring === m.agent_id} disabled={!!restoring}
                  aria-label={`Restore ${a.name} to the project`} onClick={() => restore(m)}>Restore</Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function AgentRail({ project }) {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks[project.id]);
  const members = useStore((s) => s.members[project.id]);
  const loadMembers = useStore((s) => s.loadMembers);
  const memberAction = useStore((s) => s.memberAction);
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState(null); // { kind: 'release', agent } | { kind: 'idle', ids }
  const opener = useRef(null);
  const addButton = useRef(null);

  useEffect(() => { loadMembers(project.id).catch(() => {}); }, [project.id, loadMembers]);

  const agentsById = useMemo(() => new Map(agents.filter((a) => !a.archived).map((a) => [a.id, a])), [agents]);
  // Until the members list arrives, the team is the GM plus the agents with tasks (what the server backfilled from).
  const team = useMemo(() => {
    const ids = members ? new Set(members.filter((m) => m.status === 'active' || m.is_manager).map((m) => m.agent_id))
      : new Set([project.manager_id, ...(tasks || EMPTY).map((t) => t.agent_id)]);
    return agents.filter((a) => ids.has(a.id) && !a.archived);
  }, [members, tasks, agents, project.manager_id]);
  const released = useMemo(() => (members || EMPTY).filter((m) => m.status === 'released' && !m.is_manager), [members]);
  const releasedIds = useMemo(() => new Set(released.map((m) => m.agent_id)), [released]);
  const candidates = useMemo(() => {
    const onTeam = new Set(team.map((a) => a.id));
    return agents.filter((a) => !a.archived && !onTeam.has(a.id)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [agents, team]);
  // Blocking work: live from the task list when it is loaded, else what the members list said.
  const busy = useMemo(() => {
    const m = new Map();
    if (tasks) {
      for (const t of tasks) if (BUSY.includes(t.status) && t.agent_id) m.set(t.agent_id, [...(m.get(t.agent_id) || []), t.key]);
    } else {
      for (const x of members || EMPTY) if (x.busy_tasks?.length) m.set(x.agent_id, x.busy_tasks);
    }
    return m;
  }, [tasks, members]);
  const idle = team.filter((a) => a.id !== project.manager_id && !busy.has(a.id));

  // Focus goes back to the control that opened a dialog; when that is gone (a released card), to Add agent.
  const refocus = () => {
    const el = opener.current;
    opener.current = null;
    (el?.isConnected ? el : addButton.current)?.focus();
  };
  const release = useMemo(() => ({
    busy: (id) => busy.get(id) || EMPTY,
    onRelease: (agent, el, keys) => {
      if (keys.length) { toast.info(`${agent.name} is still working`, `Release it once ${keys.join(', ')} ${keys.length === 1 ? 'finishes' : 'finish'}.`); return; }
      opener.current = el;
      setConfirm({ kind: 'release', agent });
    },
  }), [busy]);

  const add = async (a) => {
    const r = await memberAction(project.id, 'add', a.id);
    toast.success(releasedIds.has(a.id) ? `${a.name} restored` : `${a.name} added`, `On the ${project.name} team.`);
    setPicker(false);
    refocus();
    return r;
  };
  const restore = async (m) => {
    await memberAction(project.id, 'add', m.agent_id);
    toast.success(`${m.name} restored`, `Back on the ${project.name} team.`);
  };
  const doConfirm = async () => {
    try {
      if (confirm.kind === 'release') {
        await memberAction(project.id, 'release', confirm.agent.id);
        toast.success(`${confirm.agent.name} released`, `Restore it from Released below.`);
      } else {
        const r = await memberAction(project.id, 'idle');
        const n = r?.released?.length || 0;
        toast.success(n ? `Released ${n} idle agent${n === 1 ? '' : 's'}` : 'No idle agents to release');
      }
    } catch { /* api.js showed the server's message (409) */ }
  };
  const closeConfirm = () => { setConfirm(null); refocus(); };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto p-2 flex flex-col gap-1.5">
        <div role="toolbar" aria-label="Team" className="flex flex-wrap items-center gap-1.5 min-w-0">
          <Button ref={addButton} size="sm" icon={UserPlus} aria-haspopup="dialog" className="flex-1"
            onClick={(e) => { opener.current = e.currentTarget; setPicker(true); }}>Add agent</Button>
          <Button size="sm" variant="ghost" icon={UserMinus} disabled={!members || !idle.length}
            title={idle.length ? `Release ${idle.length} idle agent${idle.length === 1 ? '' : 's'}` : 'No idle agents to release'}
            onClick={(e) => { opener.current = e.currentTarget; setConfirm({ kind: 'idle', names: idle.map((a) => a.name) }); }}>Release idle</Button>
        </div>
        <AgentOrg project={project} team={team} release={members ? release : undefined} />
        <ReleasedSection released={released} agentsById={agentsById} onRestore={restore} />
      </div>
      <AddAgentPicker open={picker} project={project} candidates={candidates} released={releasedIds} onAdd={add}
        onClose={() => { setPicker(false); refocus(); }} />
      <Confirm open={!!confirm} danger confirmLabel="Release" onConfirm={doConfirm} onClose={closeConfirm}
        title={confirm?.kind === 'idle' ? 'Release idle agents' : `Release ${confirm?.agent?.name || ''}`}
        body={confirm?.kind === 'idle'
          ? <>Release {confirm.names.join(', ')} from {project.name}? Agents with queued or running work stay. You can restore them from Released.</>
          : <>Release {confirm?.agent?.name} from {project.name}? It leaves the team; you can restore it from Released.</>} />
    </div>
  );
}
