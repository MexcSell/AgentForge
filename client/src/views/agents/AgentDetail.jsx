import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Brain, Wrench, MessageSquareText, CircleCheck, CircleX, Play, TriangleAlert, Timer, Hash, ArrowDownToLine, ArrowUpFromLine, Target, Compass,
  Info, GitFork, GitMerge, Archive, Cpu, Sparkles, BookOpen, History, Activity, Save, Crown, Lock, Coins,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { compact, duration, timeAgo, usd, dateTime } from '../../lib/format.js';
import { Modal } from '../../components/Modal.jsx';
import { cx, AgentAvatar, Badge, Button, Progress, Tabs, Select, Textarea, Empty, Spinner, STATUS_TONE } from '../../components/ui.jsx';
import { canMerge, mergeOriginal, MergeButton, MergeConfirm } from './merge.jsx';

const TIER = { 1: 'Executive', 2: 'Management', 3: 'Specialist', 4: 'Verification', 5: 'Evolution' };

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="flex flex-col gap-1 p-2.5 rounded-lg bg-sunken border border-line min-w-0">
      <span className="flex items-center gap-1.5 text-[0.66rem] uppercase tracking-wider text-subtle"><Icon size={11} />{label}</span>
      <span className="text-[0.95rem] font-semibold tabular truncate">{value}</span>
    </div>
  );
}

function EventRow({ e }) {
  const d = e.data || {};
  if (e.type === 'run-start') return <div className="flex items-center gap-2 py-2 text-[0.7rem] text-accent"><Play size={11} />New run · {d.kind} · {d.model}<span className="flex-1 h-px bg-accent/30" /></div>;
  if (e.type === 'thinking') return <div className="flex gap-2 py-1"><Brain size={13} className="text-accent-2 mt-0.5 shrink-0" /><div className="text-xs text-muted italic whitespace-pre-wrap break-words">{d.text}</div></div>;
  if (e.type === 'text') return <div className="flex gap-2 py-1"><MessageSquareText size={13} className="text-fg mt-0.5 shrink-0" /><div className="text-xs whitespace-pre-wrap break-words">{d.text}</div></div>;
  if (e.type === 'tool_use') return <div className="flex gap-2 py-1 items-center"><Wrench size={12} className="text-info shrink-0" /><Badge tone="info">{d.name}</Badge><span className="text-[0.72rem] mono text-muted truncate">{d.input}</span></div>;
  if (e.type === 'tool_result') return <div className="flex gap-2 py-0.5 pl-5 items-start">{d.ok ? <CircleCheck size={11} className="text-ok mt-0.5 shrink-0" /> : <CircleX size={11} className="text-bad mt-0.5 shrink-0" />}<span className="text-[0.68rem] mono text-subtle line-clamp-2 break-all">{d.preview || (d.ok ? 'ok' : 'error')}</span></div>;
  if (e.type === 'error') return <div className="flex gap-2 py-1"><TriangleAlert size={13} className="text-bad mt-0.5 shrink-0" /><div className="text-xs text-bad whitespace-pre-wrap">{d.text}</div></div>;
  return <div className="flex gap-2 py-1 text-[0.7rem] text-subtle"><Info size={12} className="shrink-0" />{d.text}</div>;
}

export function AgentDetailModal() {
  const id = useStore((s) => s.agentModal);
  const set = useStore((s) => s.set);
  const agents = useStore((s) => s.agents);
  const models = useStore((s) => s.models);
  const liveEvents = useStore((s) => (id ? s.live[id] : null));
  const agent = agents.find((a) => a.id === id);
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState('live');
  const [edit, setEdit] = useState(null);
  const [merging, setMerging] = useState(false);
  const streamRef = useRef(null);

  useEffect(() => {
    if (!id) return;
    setTab('live');
    setEdit(null);
    setMerging(false);
    setDetail(null);
    setHistory([]);
    api.get(`/api/agents/${id}`).then(setDetail).catch(() => set({ agentModal: null }));
    api.get(`/api/agents/${id}/live`).then((d) => setHistory([...(d.run ? [{ type: 'run-start', data: { kind: d.run.kind, model: d.run.model_id }, ts: d.run.created_at }] : []), ...d.events])).catch(() => {});
  }, [id]);
  useEffect(() => { if (id && agent?.status && detail) api.get(`/api/agents/${id}`).then(setDetail).catch(() => {}); }, [agent?.status, agent?.xp]);

  const events = useMemo(() => {
    const live = liveEvents || [];
    if (!live.length) return history;
    const firstLive = live.findIndex((e) => e.type === 'run-start');
    return firstLive >= 0 ? live.slice(firstLive) : [...history, ...live];
  }, [history, liveEvents]);
  useEffect(() => { const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight; }, [events.length, tab]);

  if (!id) return null;
  const a = { ...(detail || {}), ...(agent || {}) };
  const s = a.stats || {};
  const toolTotals = {};
  for (const r of detail?.runs || []) for (const [k, v] of Object.entries(r.tool_calls || {})) toolTotals[k] = (toolTotals[k] || 0) + v;
  const doneTasks = (detail?.tasks || []).filter((t) => t.status === 'done' && t.started_at && t.finished_at);
  const avgMs = doneTasks.length ? doneTasks.reduce((x, t) => x + (new Date(t.finished_at) - new Date(t.started_at)), 0) / doneTasks.length : null;
  const xpNext = 40 * (a.level || 1) ** 2;
  const xpPrev = 40 * ((a.level || 1) - 1) ** 2;
  const nonEditable = a.role === 'executive';
  const original = canMerge(a) ? mergeOriginal(a, agents) : null;

  const save = async () => {
    await api.patch(`/api/agents/${a.id}`, edit);
    toast.success(`${a.name} updated`);
    setEdit(null);
    api.get(`/api/agents/${id}`).then(setDetail);
  };

  return (<>
    <Modal open={!!id} onClose={() => set({ agentModal: null })} size="xl" bodyClass="p-0"
      title={<span className="flex items-center gap-2">{a.name}<Lock size={11} className="text-subtle" title="Names are system-managed" /><Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge></span>}
      subtitle={`${a.title || ''} · ${TIER[a.tier] || ''} tier · ${a.department || ''}`} icon={Bot}
      actions={a.id && !a.merged_into && <>
        <Button size="sm" variant="ghost" icon={GitFork} onClick={async () => { const c = await api.post(`/api/agents/${a.id}/clone`); toast.success(`Cloned ${a.name} → ${c.name}`); }}>Clone</Button>
        {canMerge(a) && <MergeButton clone={a} original={original} onClick={() => setMerging(true)} />}
        {!nonEditable && <Button size="sm" variant="ghost" icon={Archive} onClick={async () => { await api.del(`/api/agents/${a.id}`); set({ agentModal: null }); toast.info(`${a.name} archived`); }}>Archive</Button>}
      </>}>
      {!detail ? <div className="h-full flex items-center justify-center"><Spinner /></div> : (
        <div className="h-full grid md:grid-cols-[minmax(320px,38%)_1fr]">
          {/* Left: identity, metrics, mission */}
          <div className="min-h-0 overflow-auto border-r border-line p-4 flex flex-col gap-4">
            {a.merged_into && (
              <div className="flex items-center gap-2 p-3 rounded-xl border border-line bg-sunken text-[0.8rem]">
                <GitMerge size={14} className="text-accent shrink-0" />
                <span className="min-w-0">Merged into <button className="font-medium text-accent hover:underline" onClick={() => set({ agentModal: a.merged_into })}>{a.merged_into_name || 'its original'}</button>, which carries on its skills, XP and lessons.</span>
              </div>
            )}

            <div className="flex items-center gap-3.5">
              <AgentAvatar agent={a} size={56} />
              <div className="min-w-0 flex-1">
                <div className="text-lg font-semibold tracking-tight">{a.name}</div>
                <div className="text-xs text-muted">{a.title}</div>
                <div className="mt-2 flex items-center gap-2 text-[0.7rem] text-subtle">
                  <span className="font-semibold text-accent">Level {a.level}</span>
                  <Progress value={((a.xp - xpPrev) / Math.max(1, xpNext - xpPrev)) * 100} className="flex-1" />
                  <span className="tabular">{a.xp} XP</span>
                </div>
              </div>
            </div>

            {detail.current && (
              <div className="p-3 rounded-xl border border-accent/40 bg-accent-soft/40">
                <div className="flex items-center gap-1.5 text-[0.68rem] uppercase tracking-wider text-accent font-semibold"><Activity size={11} />Current task · {detail.current.project_name}</div>
                <div className="text-[0.84rem] font-medium mt-1">{detail.current.key} {detail.current.title}</div>
                <Progress value={detail.current.progress} className="mt-2" striped />
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Stat icon={Hash} label="Prompts" value={compact(s.prompts || 0)} />
              <Stat icon={Wrench} label="Tool calls" value={compact(s.toolCalls || 0)} />
              <Stat icon={ArrowDownToLine} label="Input tokens" value={compact(s.tokensIn || 0)} />
              <Stat icon={ArrowUpFromLine} label="Output tokens" value={compact(s.tokensOut || 0)} />
              <Stat icon={CircleCheck} label="Tasks done" value={`${s.tasksDone || 0}${s.tasksFailed ? ` · ${s.tasksFailed} failed` : ''}`} />
              <Stat icon={Timer} label="Avg completion" value={avgMs ? duration(avgMs) : '—'} />
              <Stat icon={Timer} label="Busy time" value={duration(s.totalMs || 0)} />
              <Stat icon={Coins} label="Reported cost" value={usd(s.costUsd || 0)} />
            </div>

            {Object.keys(toolTotals).length > 0 && (
              <div>
                <div className="text-[0.68rem] uppercase tracking-wider text-subtle mb-1.5">Tools used (recent runs)</div>
                <div className="flex flex-wrap gap-1.5">{Object.entries(toolTotals).sort((x, y) => y[1] - x[1]).map(([k, v]) => <Badge key={k} tone="info">{k} <b className="tabular">{v}</b></Badge>)}</div>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <div><div className="flex items-center gap-1.5 text-[0.68rem] uppercase tracking-wider text-subtle mb-1"><Target size={11} />Mission</div>
                {edit ? <Textarea rows={2} value={edit.mission} onChange={(e) => setEdit({ ...edit, mission: e.target.value })} /> : <div className="text-[0.84rem]">{a.mission}</div>}</div>
              <div><div className="flex items-center gap-1.5 text-[0.68rem] uppercase tracking-wider text-subtle mb-1"><Compass size={11} />Purpose</div>
                {edit ? <Textarea rows={2} value={edit.purpose} onChange={(e) => setEdit({ ...edit, purpose: e.target.value })} /> : <div className="text-[0.84rem] text-muted">{a.purpose}</div>}</div>
            </div>

            <div>
              <div className="text-[0.68rem] uppercase tracking-wider text-subtle mb-2">Skills</div>
              <div className="flex flex-col gap-2">
                {(a.skills || []).slice().sort((x, y) => y.level - x.level).map((k) => (
                  <div key={k.name} className="flex items-center gap-2.5 text-xs">
                    <span className="w-28 truncate">{k.name}</span>
                    <Progress value={k.level} tone="series" className="flex-1" />
                    <span className="w-7 text-right tabular text-muted">{k.level}</span>
                    {k.learnedAt && <Sparkles size={11} className="text-accent" title="Learned on the job" />}
                  </div>
                ))}
              </div>
            </div>

            <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-xs">
              <dt className="text-subtle">Role</dt><dd>{a.role}</dd>
              <dt className="text-subtle">Supervisor</dt>
              <dd>{edit && !nonEditable ? (
                <Select value={edit.supervisor_id || ''} onChange={(e) => setEdit({ ...edit, supervisor_id: e.target.value || null })} className="w-full h-7 text-xs">
                  <option value="">— none —</option>
                  {agents.filter((x) => x.id !== a.id).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.title}</option>)}
                </Select>
              ) : a.supervisor_name ? <button className="hover:underline" onClick={() => set({ agentModal: a.supervisor_id })}>{a.supervisor_name}</button> : <span className="flex items-center gap-1"><Crown size={11} />top of hierarchy</span>}</dd>
              <dt className="text-subtle">Reports</dt>
              <dd className="flex flex-wrap gap-1">{detail.reportsList?.length ? detail.reportsList.map((r) => <button key={r.id} className="hover:underline text-muted" onClick={() => set({ agentModal: r.id })}>{r.name}</button>) : '—'}</dd>
              <dt className="text-subtle">Model</dt>
              <dd>{edit ? (
                <Select value={edit.model_id || ''} onChange={(e) => setEdit({ ...edit, model_id: e.target.value || null })} className="w-full h-7 text-xs">
                  <option value="">Default model</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              ) : <span className="flex items-center gap-1"><Cpu size={11} />{models.find((m) => m.id === a.model_id)?.name || 'Default model'}</span>}</dd>
              <dt className="text-subtle">Playbook</dt><dd>v{a.prompt_version} · {(a.playbook || []).length} lessons{s.experiment ? ' · experiment running' : ''}</dd>
              <dt className="text-subtle">Origin</dt><dd>{a.origin}{a.cloned_from ? ' (clone)' : ''} · {a.created_at ? timeAgo(a.created_at) + ' ago' : ''}</dd>
            </dl>
            <div className="flex gap-2">
              {edit ? <><Button size="sm" variant="primary" icon={Save} onClick={save}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></>
                : <Button size="sm" onClick={() => setEdit({ mission: a.mission, purpose: a.purpose, supervisor_id: a.supervisor_id, model_id: a.model_id })}>Edit mission, model & hierarchy</Button>}
            </div>
          </div>

          {/* Right: live thinking, usage and results */}
          <div className="min-h-0 flex flex-col">
            <div className="flex items-center gap-2 px-4 h-11 border-b border-line shrink-0">
              <Tabs size="sm" value={tab} onChange={setTab} tabs={[
                { id: 'live', label: 'Live', icon: Activity },
                { id: 'tasks', label: 'Tasks', icon: History, count: detail.tasks.length },
                { id: 'memory', label: 'Memory', icon: BookOpen, count: detail.experiences.length },
                { id: 'runs', label: 'Usage', icon: Cpu, count: detail.runs.length },
              ]} />
              {a.status === 'working' && <span className="ml-auto flex items-center gap-1.5 text-xs text-accent"><span className="size-1.5 rounded-full bg-accent animate-af-pulse" />thinking…</span>}
            </div>
            <div ref={streamRef} className="flex-1 min-h-0 overflow-auto px-4 py-3">
              {tab === 'live' && (events.length ? <div className="flex flex-col">{events.map((e, i) => <EventRow key={i} e={e} />)}</div> : <Empty icon={Brain} title="No activity yet">This pane streams the agent's reasoning, tool calls and results while it works.</Empty>)}
              {tab === 'tasks' && (detail.tasks.length ? detail.tasks.map((t) => (
                <div key={t.id} className="flex items-center gap-2.5 py-2 border-b border-line">
                  {t.status === 'done' ? <CircleCheck size={14} className="text-ok" /> : t.status === 'failed' ? <CircleX size={14} className="text-bad" /> : <Activity size={14} className="text-subtle" />}
                  <div className="min-w-0 flex-1"><div className="text-[0.82rem] truncate">{t.key} {t.title}</div><div className="text-[0.68rem] text-subtle">{t.project_name} · {dateTime(t.created_at)}{t.started_at && t.finished_at ? ` · ${duration(new Date(t.finished_at) - new Date(t.started_at))}` : ''}</div></div>
                  <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                </div>
              )) : <Empty icon={History} title="No tasks yet" />)}
              {tab === 'memory' && (
                <div className="flex flex-col gap-4">
                  {(a.playbook || []).length > 0 && (
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-wider text-subtle mb-2">Active playbook v{a.prompt_version}</div>
                      <ol className="flex flex-col gap-1.5 list-decimal pl-5 text-xs">{a.playbook.map((l, i) => <li key={i}>{l}</li>)}</ol>
                    </div>
                  )}
                  <div>
                    <div className="text-[0.68rem] uppercase tracking-wider text-subtle mb-2">Experiences</div>
                    {detail.experiences.length ? detail.experiences.map((x) => (
                      <div key={x.id} className="flex gap-2 py-1.5 border-b border-line text-xs">
                        {x.kind === 'failure' ? <CircleX size={13} className="text-bad shrink-0 mt-0.5" /> : <Sparkles size={13} className="text-accent shrink-0 mt-0.5" />}
                        <span className="flex-1">{x.content}</span><span className="text-subtle shrink-0">{timeAgo(x.created_at)}</span>
                      </div>
                    )) : <div className="text-xs text-subtle">Lessons appear after the agent completes tasks.</div>}
                  </div>
                  {detail.versions.length > 0 && (
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-wider text-subtle mb-2">Version history</div>
                      {detail.versions.map((v) => <div key={v.version} className="flex gap-2 text-xs py-1"><Badge tone="accent">v{v.version}</Badge><span className="text-muted flex-1">{v.reason}</span><span className="text-subtle">{timeAgo(v.created_at)}</span></div>)}
                    </div>
                  )}
                </div>
              )}
              {tab === 'runs' && (detail.runs.length ? (
                <table className="w-full text-xs tabular">
                  <thead className="text-subtle text-left"><tr><th className="font-medium py-1.5">When</th><th className="font-medium">Kind</th><th className="font-medium">Model</th><th className="font-medium text-right">In</th><th className="font-medium text-right">Out</th><th className="font-medium text-right">Tools</th><th className="font-medium text-right">Time</th></tr></thead>
                  <tbody>{detail.runs.map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <td className="py-1.5">{timeAgo(r.created_at)}</td><td>{r.kind}</td><td className="truncate max-w-32">{r.model_id}</td>
                      <td className="text-right">{compact(r.input_tokens)}</td><td className="text-right">{compact(r.output_tokens)}</td>
                      <td className="text-right">{Object.values(r.tool_calls || {}).reduce((x, y) => x + y, 0)}</td><td className="text-right">{duration(r.duration_ms)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <Empty icon={Cpu} title="No model usage yet" />)}
            </div>
          </div>
        </div>
      )}
    </Modal>
    <MergeConfirm clone={merging ? a : null} original={original} onClose={() => setMerging(false)} />
  </>);
}

