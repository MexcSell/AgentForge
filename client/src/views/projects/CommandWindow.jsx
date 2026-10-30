import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Send, ImagePlus, X, Copy, Check, Users, Square, Trash2, Lock, FolderOpen, Settings2, ArrowRight, Lightbulb, ThumbsUp, ThumbsDown,
  ListTree, Sparkles, CircleCheck, CircleX, TriangleAlert, Workflow, UserPlus, CopyPlus, Loader2, Slash,
  Hash, Plus, Pencil, Split, CornerDownRight, Archive, ArchiveRestore, MonitorPlay,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore, selectRun } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { copyText, clockTime, dateTime } from '../../lib/format.js';
import { parseNew, isUntitled, tagCounts, MAX_TAGS } from '../../lib/topics.js';
import { GithubMark, roleStyle } from '../../lib/icons.jsx';
import { Markdown } from '../../components/Markdown.jsx';
import { Modal, Confirm } from '../../components/Modal.jsx';
import { cx, Badge, Button, IconButton, Input, Field, Textarea, Toggle, Kbd, AgentAvatar, Progress, STATUS_TONE } from '../../components/ui.jsx';
import { TopicBar, TagChip, TagEditor, RenameInput } from './TopicBar.jsx';
import { PreviewWindow } from './PreviewWindow.jsx';

const EMPTY = [];
const SLASH = [
  { cmd: '/new', desc: 'Start a new topic — /new [title] [#tag …]', args: true },
  { cmd: '/standup', desc: 'Agent coordination meeting: status, blockers, next' },
  { cmd: '/sync', desc: 'Commit and push this project to GitHub now' },
  { cmd: '/stop', desc: 'Cancel the running mission' },
];

function CopyButton({ text, count }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1200); } }}
      title={count > 1 ? `Copy (identical message ×${count} collapsed)` : 'Copy'} className="size-6 rounded-md flex items-center justify-center text-subtle hover:text-fg hover:bg-hover">
      {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

function AgentName({ m }) {
  const set = useStore((s) => s.set);
  if (!m.agent_id) return <span className="font-medium">System</span>;
  return <button className="font-medium hover:underline" onClick={() => set({ agentModal: m.agent_id })}>{m.agent_name}</button>;
}

function PlanBody({ m }) {
  const tasks = m.meta?.tasks || [];
  return (
    <div className="flex flex-col gap-2.5">
      {m.content && <div className="text-[0.84rem] text-muted">{m.content}</div>}
      <div className="rounded-lg border border-line overflow-hidden">
        {tasks.map((t) => {
          const R = roleStyle(t.role);
          return (
            <div key={t.key} className="flex items-center gap-2.5 px-3 py-2 border-b last:border-0 border-line bg-sunken/50">
              <span className="text-[0.7rem] mono text-subtle w-7">{t.key}</span>
              <span className="size-5 rounded-md flex items-center justify-center text-white shrink-0" style={{ backgroundImage: `linear-gradient(135deg, ${R.from}, ${R.to})` }}><R.icon size={11} /></span>
              <span className="text-[0.82rem] flex-1 min-w-0 truncate">{t.title}</span>
              {t.depends_on?.length > 0 && <span className="hidden md:inline text-[0.68rem] text-subtle mono">← {t.depends_on.join(', ')}</span>}
              <span className="text-[0.72rem] text-muted">{t.agent}</span>
            </div>
          );
        })}
      </div>
      {m.meta?.staffing?.length > 0 && (
        <div className="flex flex-col gap-1">
          {m.meta.staffing.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-muted">{s.startsWith('Cloned') ? <CopyPlus size={12} className="text-accent" /> : <UserPlus size={12} className="text-ok" />}{s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalBody({ m, tasks }) {
  const t = tasks?.find((x) => x.id === m.meta?.task_id);
  const pending = !t || t.status === 'proposed';
  return (
    <div className="flex flex-col gap-2.5">
      <Markdown>{m.content}</Markdown>
      {pending ? (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" icon={ThumbsUp} onClick={() => api.post(`/api/tasks/${m.meta.task_id}/approve`)}>Approve → new mission</Button>
          <Button size="sm" variant="ghost" icon={ThumbsDown} onClick={() => api.post(`/api/tasks/${m.meta.task_id}/reject`)}>Reject</Button>
        </div>
      ) : <Badge tone={t.result?.startsWith('Approved') ? 'ok' : 'neutral'}>{t.result || t.status}</Badge>}
    </div>
  );
}

/** The GM's "Continued in new topic" status (meta.topic_id): a notice with a link to the new topic (§5.2a). */
function MovedNotice({ m }) {
  const target = useStore((s) => s.topics[m.project_id]?.find((t) => t.id === m.meta.topic_id));
  const setActiveTopic = useStore((s) => s.setActiveTopic);
  const title = target?.title || m.content.replace(/^Continued in new topic:\s*/, '');
  const open = target ? () => setActiveTopic(m.project_id, target.id) : null;
  return (
    <div className="mx-4 my-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-accent/30 bg-accent-soft/40 px-3 py-1.5 text-xs text-muted animate-af-in motion-reduce:animate-none">
      <Split size={13} className="text-accent shrink-0" />
      <span className="min-w-0 flex-1">
        <b className="font-medium text-fg">{m.agent_name || 'The GM'}</b> moved this order to a new topic{' '}
        {open ? <button className="font-medium text-fg hover:underline focus-visible:outline-accent!" onClick={open}>{title}</button> : <span className="text-fg">{title} (deleted)</span>}
      </span>
      {(target?.tags || EMPTY).slice(0, 2).map((g) => <TagChip key={g} tag={g} />)}
      {open && <Button size="sm" variant="secondary" icon={ArrowRight} className="ml-auto" onClick={open}>Open</Button>}
    </div>
  );
}

/** Empty state of a fresh topic in a project that already has history elsewhere (§5.1). */
function TopicEmpty({ project, topic, topics, tasks, onPick }) {
  const [renaming, setRenaming] = useState(false);
  const [editTags, setEditTags] = useState(false);
  const other = topics.filter((t) => t.id !== topic.id && t.message_count > 0).sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))[0];
  const unfinished = tasks?.find((t) => ['failed', 'blocked'].includes(t.status) && t.origin !== 'proposal');
  const suggestions = [other && `Summarize what was decided in "${other.title}"`, unfinished && `Continue: ${unfinished.title}`, '/standup'].filter(Boolean);
  const tags = topic.tags || EMPTY;
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 gap-3 animate-af-fade motion-reduce:animate-none">
      <span className="size-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center"><Hash size={18} /></span>
      {renaming ? (
        <RenameInput topic={topic} onDone={() => setRenaming(false)}
          className="w-72 max-w-full h-8 px-2 rounded-lg bg-sunken border border-accent outline-none text-base font-semibold text-center" />
      ) : isUntitled(topic) ? (
        <button title="Rename" onClick={() => setRenaming(true)} className="text-base font-semibold hover:underline decoration-dotted underline-offset-4 focus-visible:outline-accent!">{topic.title}</button>
      ) : <div className="max-w-md text-base font-semibold [overflow-wrap:anywhere]">{topic.title}</div>}
      <div className="relative flex flex-wrap justify-center gap-1">
        {tags.map((g) => <TagChip key={g} tag={g} size="sm" />)}
        <button type="button" onClick={() => setEditTags(true)}
          className="inline-flex items-center gap-1 h-5 px-2 rounded-full border border-dashed border-line-strong text-[0.7rem] text-muted hover:text-fg hover:border-accent transition-colors focus-visible:outline-accent! focus-visible:rounded-full!">
          {tags.length ? <><Pencil size={10} />Edit tags</> : <><Plus size={10} />Add tag</>}
        </button>
        {/* max-w-none: this anchor row shrink-wraps its chips, so the editor's default max-w-[calc(100%-1rem)] would squash it. */}
        {editTags && <TagEditor topic={topic} allTags={tagCounts(topics)} onClose={() => setEditTags(false)} className="absolute top-full mt-1.5 left-1/2 -translate-x-1/2 max-w-none!" />}
      </div>
      <div className="text-xs text-muted max-w-md leading-relaxed">
        A fresh conversation: {project.manager_name} starts without the other topics' chat, so orders here stay short and cheap. Project files, tasks and agent memory are still shared.
      </div>
      <div className="flex flex-wrap justify-center gap-2 mt-1">
        {suggestions.map((s) => (
          <button key={s} onClick={() => onPick(s)} className="text-xs px-3 h-7 rounded-full border border-line hover:border-accent hover:text-accent transition-colors max-w-full truncate focus-visible:outline-accent! focus-visible:rounded-full!">{s}</button>
        ))}
      </div>
      <div className="text-[0.7rem] text-muted">Tip: type <Kbd>/new</Kbd> in any topic to branch off</div>
    </div>
  );
}

function Message({ m, count, tasks }) {
  const [zoom, setZoom] = useState(null);
  const time = <span className="text-[0.68rem] text-subtle" title={dateTime(m.created_at)}>{clockTime(m.created_at)}</span>;
  const tools = (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <CopyButton text={m.content} count={count} />
    </div>
  );
  const repeat = count > 1 && <Badge tone="accent" className="tabular">×{count}</Badge>;
  const images = m.attachments?.length > 0 && (
    <div className="flex flex-wrap gap-2 mt-2">
      {m.attachments.map((a) => <img key={a.id} src={a.url} alt={a.name} onClick={() => setZoom(a)} className="h-24 max-w-48 object-cover rounded-lg border border-line cursor-zoom-in" />)}
      <Modal open={!!zoom} onClose={() => setZoom(null)} title={zoom?.name} size="lg" bodyClass="p-2 flex items-center justify-center bg-sunken">{zoom && <img src={zoom.url} alt={zoom.name} className="max-w-full max-h-full object-contain" />}</Modal>
    </div>
  );

  if (m.author_type === 'user') {
    return (
      <div className="group flex justify-end gap-2 px-4 py-1.5 animate-af-in">
        <div className="flex flex-col items-end gap-1 max-w-[85%]">
          <div className="flex items-center gap-2">{tools}{repeat}{time}<span className="text-xs font-medium">You</span></div>
          <div className="rounded-2xl rounded-tr-md px-3.5 py-2 grad-accent text-accent-fg text-[0.86rem] whitespace-pre-wrap break-words shadow-sm">{m.content}</div>
          {images}
        </div>
      </div>
    );
  }

  if (m.kind === 'status' && m.meta?.topic_id) return <MovedNotice m={m} />;

  if (m.kind === 'status') {
    return (
      <div className="group flex items-center gap-2 px-4 py-1 text-xs text-muted">
        <span className="w-8 flex justify-center"><span className="size-1.5 rounded-full bg-line-strong" /></span>
        <AgentName m={m} /><span className="truncate">{m.content}</span>{repeat}<span className="ml-auto">{time}</span>{tools}
      </div>
    );
  }

  const frame = {
    plan: { icon: ListTree, label: 'Plan', cls: 'border-info/30' },
    report: { icon: m.meta?.status === 'done' ? CircleCheck : CircleX, label: 'Report', cls: m.meta?.status === 'done' ? 'border-ok/25' : 'border-bad/35' },
    proposal: { icon: Lightbulb, label: 'Proposal', cls: 'border-warn/40 bg-warn-soft/40' },
    summary: { icon: Sparkles, label: 'Mission summary', cls: 'border-accent/40 bg-accent-soft/40' },
    meeting: { icon: Users, label: 'Stand-up meeting', cls: 'border-info/30 bg-info-soft/30' },
    error: { icon: TriangleAlert, label: 'Error', cls: 'border-bad/40 bg-bad-soft/40' },
    chat: { icon: null, label: null, cls: 'border-line' },
  }[m.kind] || { cls: 'border-line' };

  return (
    <div className="group flex gap-3 px-4 py-2 animate-af-in">
      {m.agent_id ? <button onClick={() => useStore.getState().set({ agentModal: m.agent_id })}><AgentAvatar role={m.agent_role} size={30} status="idle" /></button>
        : <span className="size-[30px] rounded-[28%] bg-hover flex items-center justify-center text-subtle"><Workflow size={15} /></span>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs mb-1 min-h-6">
          <AgentName m={m} />
          {m.agent_title && <span className="text-subtle hidden sm:inline">{m.agent_title}</span>}
          {m.kind === 'report' && <span className="flex items-center gap-1 text-subtle"><ArrowRight size={11} />{m.meta?.to}</span>}
          {frame.label && <Badge tone={m.kind === 'report' ? STATUS_TONE[m.meta?.status] : m.kind === 'error' ? 'bad' : m.kind === 'proposal' ? 'warn' : 'accent'} icon={frame.icon}>{frame.label}</Badge>}
          {m.kind === 'report' && <span className="text-subtle mono text-[0.7rem] truncate">{m.meta?.task_key} {m.meta?.task_title}</span>}
          {repeat}
          <span className="ml-auto flex items-center gap-1">{tools}{time}</span>
        </div>
        <div className={cx('rounded-xl border px-3.5 py-2.5 bg-panel', frame.cls)}>
          {m.kind === 'plan' ? <PlanBody m={m} /> : m.kind === 'proposal' ? <ProposalBody m={m} tasks={tasks} /> : <Markdown>{m.content}</Markdown>}
          {m.kind === 'report' && m.meta?.artifacts?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2.5 border-t border-line">
              {m.meta.artifacts.slice(0, 12).map((a) => <span key={a} className="text-[0.7rem] mono px-1.5 py-0.5 rounded bg-sunken border border-line text-muted">{a}</span>)}
              {m.meta.confidence != null && <span className="ml-auto text-[0.7rem] text-subtle">confidence {Math.round(m.meta.confidence * 100)}%</span>}
            </div>
          )}
        </div>
        {images}
      </div>
    </div>
  );
}

function ProjectSettings({ project, open, onClose }) {
  const [f, setF] = useState(project);
  useEffect(() => { if (open) setF(project); }, [open]);
  const save = async () => {
    // Preview fields: empty means auto-detect (null); the port is a number.
    const port = String(f.preview_port ?? '').trim();
    if (port && !(Number.isInteger(+port) && +port >= 1 && +port <= 65535)) return toast.warn('Preview port must be a whole number from 1 to 65535');
    const path = f.preview_path?.trim() || null;
    await api.patch(`/api/projects/${project.id}`, {
      ...f, run_command: f.run_command?.trim() || null, preview_port: port ? +port : null, preview_path: path && !path.startsWith('/') ? `/${path}` : path,
    });
    toast.success('Project updated');
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Project settings" icon={Settings2} size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Working directory"><Input className="mono" value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} disabled={project.protected} /></Field>
        <Field label="GitHub URL"><Input value={f.github_url || ''} placeholder="https://github.com/owner/repo.git" onChange={(e) => setF({ ...f, github_url: e.target.value })} /></Field>
        <Field label="Brief"><Textarea rows={3} value={f.description || ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Toggle checked={f.auto_sync} onChange={(v) => setF({ ...f, auto_sync: v })} label="Upload to GitHub after every completed mission" />
        <div className="flex flex-col gap-4 pt-4 border-t border-line">
          <Field label="Run command" hint="What Run starts in the Preview window.">
            <Input className="mono" value={f.run_command || ''} placeholder="npm run dev — auto-detected if empty" onChange={(e) => setF({ ...f, run_command: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Preview port"><Input type="number" min={1} max={65535} value={f.preview_port ?? ''} placeholder="Auto-detected" onChange={(e) => setF({ ...f, preview_port: e.target.value })} /></Field>
            <Field label="Preview path"><Input className="mono" value={f.preview_path || ''} placeholder="/ (e.g. /index.html)" onChange={(e) => setF({ ...f, preview_path: e.target.value })} /></Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function CommandWindow({ project }) {
  const st = useStore();
  const topics = st.topics[project.id];
  const topicId = st.activeTopic[project.id] || null;
  const topic = topics?.find((t) => t.id === topicId) || null;
  // Only the active topic's messages. A project without any topic yet has an empty chat.
  const messages = topicId ? st.messages[topicId] : topics ? EMPTY : undefined;
  const tasks = st.tasks[project.id];
  const mission = st.missions[project.id];
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [drag, setDrag] = useState(false);
  const [settings, setSettings] = useState(false); // true, or 'preview' when opened from the Preview window (returns there on close)
  const [confirmDel, setConfirmDel] = useState(false);
  const [hideHint, setHideHint] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewWin, setPreviewWin] = useState(false);
  const scroller = useRef(null);
  const stick = useRef(true);
  const fileInput = useRef(null);
  const ta = useRef(null);
  const previewBtn = useRef(null);
  // The session outlives the window (and page reloads): fetch it so the header can show that it is running.
  useEffect(() => { st.loadPreview(project.id).catch(() => {}); }, [project.id]);
  const previewRunning = st.previews[project.id]?.status === 'running';

  // Collapse consecutive identical messages into one with a counter.
  const grouped = useMemo(() => {
    const out = [];
    for (const m of messages || []) {
      const prev = out[out.length - 1];
      if (prev && prev.m.content === m.content && prev.m.author_type === m.author_type && prev.m.agent_id === m.agent_id && prev.m.kind === m.kind && !m.attachments?.length) prev.count++;
      else out.push({ m, count: 1 });
    }
    return out;
  }, [messages]);

  useEffect(() => { stick.current = true; }, [project.id, topicId]);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [grouped.length, project.id, topicId]);

  const running = project.status === 'running';
  const currentMissionId = mission?.id || tasks?.[0]?.mission_id;
  const live = running && mission?.status !== 'planning' ? tasks?.filter((t) => t.mission_id === currentMissionId && t.origin !== 'proposal') : null;
  const doneCount = live ? live.filter((t) => t.status === 'done').length : 0;
  // The mission bar and "Agents are working…" belong to the topic that owns the mission; other topics get a link to it.
  const run = { ...selectRun(st, project), progress: live?.length ? `${doneCount}/${live.length}` : null };
  const owns = running && !!run.id && run.id === topicId;
  const runTopic = run.id ? topics?.find((t) => t.id === run.id) : null;
  const origin = topicId && st.movedFrom[topicId] ? topics?.find((t) => t.id === st.movedFrom[topicId]) : null;
  const othersHaveHistory = !!topics?.some((t) => t.id !== topicId && t.message_count > 0);
  // Argument hint for "/new …" once the command is followed by a space (bare "/new" still shows the slash menu).
  const newCmd = !hideHint && /^\/new\s/.test(text) ? parseNew(text) : null;
  useEffect(() => { if (!/^\/new(\s|$)/.test(text)) setHideHint(false); }, [text]);
  const focusComposer = () => ta.current?.focus();

  const addFiles = (list) => {
    const imgs = [...list].filter((f) => f.type.startsWith('image/'));
    if (imgs.length < list.length) toast.warn('Only images can be attached to commands');
    setFiles((f) => [...f, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, 8));
  };
  const send = async () => {
    const content = text.trim();
    if ((!content && !files.length) || sending) return;
    setSending(true);
    try {
      let target = topic;
      let body = content;
      const cmd = parseNew(content);
      if (cmd) {
        // "/new [title] [#tag …]" creates and opens a topic; lines after the first become its first order.
        target = await st.createTopic(project.id, { title: cmd.title, tags: cmd.tags });
        setText('');
        if (!cmd.body) return; // attached images stay in the composer of the new topic
        body = cmd.body;
      } else if (topic?.archived) {
        await st.updateTopic(topic.id, { archived: false }); // writing in an archived topic brings it back
      }
      const attachments = files.length ? await api.upload('/api/uploads', files.map((f) => f.file)) : [];
      await api.post(`/api/projects/${project.id}/command`, { content: body, attachments, topic_id: target?.id || undefined });
      setText('');
      setFiles([]);
      stick.current = true;
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };
  const slash = text.startsWith('/') && !text.includes(' ') ? SLASH.filter((s) => s.cmd.startsWith(text)) : [];

  return (
    <div className="h-full flex flex-col relative" onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
      {/* @container: below @md (28rem, e.g. a 25% chat pane) the icon group tightens and Stop becomes icon-only, so only the title truncates. */}
      <div className="@container flex items-center gap-2.5 px-4 h-12 border-b border-line shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {project.protected && <Lock size={13} className="text-accent shrink-0" />}
            <span className="font-semibold text-[0.92rem] truncate">{project.name}</span>
            <Badge tone={running ? 'accent' : 'neutral'}>{running ? (mission?.status === 'planning' ? 'planning' : 'running') : 'idle'}</Badge>
          </div>
          <div className="flex items-center gap-2 text-[0.7rem] text-subtle min-w-0">
            <button className="mono truncate hover:text-accent" title="Open in Files" onClick={() => st.set({ view: 'files', filePanes: [{ id: 'p1', path: project.path }], activePane: 'p1' })}>{project.path}</button>
            <span>·</span><span className="shrink-0">GM <button className="hover:underline text-muted" onClick={() => st.set({ agentModal: project.manager_id })}>{project.manager_name}</button></span>
          </div>
        </div>
        <div className="flex items-center gap-2.5 @max-md:gap-1 shrink-0">
          {project.github_url && <a href={project.github_url.replace(/\.git$/, '')} target="_blank" rel="noreferrer" title={project.github_url} className="size-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-hover"><GithubMark size={15} /></a>}
          <IconButton ref={previewBtn} icon={MonitorPlay} label="Run & preview project" dot={previewRunning ? 'ok' : undefined} onClick={() => setPreviewWin(true)}
            {...(previewRunning && { title: 'Run & preview project — the preview is running' })} />
          <IconButton icon={Users} label="Stand-up meeting" onClick={() => api.post(`/api/projects/${project.id}/standup`, { topic_id: topicId || undefined })} />
          <IconButton icon={FolderOpen} label="Open in Files" onClick={() => st.set({ view: 'files', filePanes: [{ id: 'p1', path: project.path }], activePane: 'p1' })} />
          <IconButton icon={Settings2} label="Project settings" onClick={() => setSettings(true)} />
          {running && <Button size="sm" variant="danger" icon={Square} title="Stop the mission" className="@max-md:px-1.5" onClick={() => api.post(`/api/projects/${project.id}/cancel`)}><span className="@max-md:sr-only">Stop</span></Button>}
          <IconButton icon={Trash2} label={project.protected ? 'Protected project — cannot be deleted' : 'Delete project'} tone="danger" disabled={project.protected} onClick={() => setConfirmDel(true)} />
        </div>
      </div>

      <TopicBar project={project} run={run} onCompose={focusComposer} />

      {owns && live && live.length > 0 && (
        <div className="px-4 py-2 border-b border-line bg-sunken/50 shrink-0">
          <div className="flex items-center gap-2 text-xs mb-1.5"><Loader2 size={12} className="animate-spin text-accent" /><span className="font-medium">Mission in progress</span><span className="text-subtle truncate">{mission?.command?.split('\n')[0]}</span><span className="ml-auto tabular text-muted">{doneCount}/{live.length}</span></div>
          <Progress value={(doneCount / live.length) * 100} striped />
        </div>
      )}
      {running && !owns && (
        <div className="flex items-center gap-2 min-w-0 px-4 py-2 border-b border-line bg-sunken/50 text-xs shrink-0">
          <Loader2 size={12} className="animate-spin text-accent shrink-0 motion-reduce:animate-none" />
          <span className="truncate">
            {runTopic ? <>Mission {run.planning ? 'planning' : 'running'} in <b className="font-medium">{runTopic.title}</b></> : 'A mission is running in this project'}
          </span>
          {run.progress && <span className="tabular text-muted shrink-0">· {run.progress}</span>}
          {runTopic && <Button size="sm" variant="ghost" icon={ArrowRight} className="ml-auto -my-1 shrink-0" onClick={() => st.setActiveTopic(project.id, runTopic.id)}>Go to topic</Button>}
        </div>
      )}

      <div ref={scroller} role="tabpanel" id="topic-panel" aria-label={topic ? `Topic: ${topic.title}` : 'Messages'} tabIndex={0}
        className="flex-1 min-h-0 overflow-auto py-3" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {!messages && <div className="flex justify-center py-10"><Loader2 className="animate-spin text-subtle" /></div>}
        {messages && !messages.length && topic && othersHaveHistory && (
          <TopicEmpty project={project} topic={topic} topics={topics} tasks={tasks} onPick={(s) => { setText(s); focusComposer(); }} />
        )}
        {messages && !messages.length && !(topic && othersHaveHistory) && (
          <div className="h-full flex flex-col items-center justify-center text-center px-8 gap-3">
            <span className="size-12 rounded-2xl grad-accent flex items-center justify-center text-accent-fg shadow-af"><Workflow size={22} /></span>
            <div className="text-base font-semibold">Talk to {project.manager_name}, your General Manager</div>
            <div className="text-xs text-muted max-w-md leading-relaxed">Give an order. The GM decomposes it into task contracts, recruits or clones specialists, runs them in parallel and reports back. Paste screenshots to give visual context.</div>
            <div className="flex flex-wrap justify-center gap-2 mt-1">
              {['Summarize this codebase and propose improvements', 'Add a health-check endpoint with tests', '/standup'].map((s) => (
                <button key={s} onClick={() => { setText(s); ta.current?.focus(); }} className="text-xs px-3 h-7 rounded-full border border-line hover:border-accent hover:text-accent transition-colors">{s}</button>
              ))}
            </div>
          </div>
        )}
        {grouped.length > 0 && (
          <div key={topicId} className="animate-af-fade motion-reduce:animate-none">
            {origin && (
              <div className="flex items-center justify-center gap-1 px-4 py-1.5 text-[0.68rem] text-muted">
                <CornerDownRight size={11} />Continued from an order in <button className="font-medium text-fg hover:underline" onClick={() => st.setActiveTopic(project.id, origin.id)}>{origin.title}</button>
              </div>
            )}
            {grouped.map(({ m, count }) => <Message key={m.id} m={m} count={count} tasks={tasks} />)}
          </div>
        )}
        {owns && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted">
            <span className="flex gap-1">{[0, 1, 2].map((i) => <span key={i} className="size-1.5 rounded-full bg-accent animate-af-pulse" style={{ animationDelay: `${i * 0.2}s` }} />)}</span>
            {mission?.status === 'planning' ? `${project.manager_name} is planning and staffing…` : 'Agents are working…'}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-line shrink-0 relative">
        {newCmd && (
          <div className="absolute bottom-full left-3 right-3 mb-1 rounded-xl border border-line bg-raised shadow-af-lg p-1 animate-af-in motion-reduce:animate-none">
            <div className="flex items-center gap-2 h-8 px-2.5 min-w-0">
              <Slash size={12} className="text-accent shrink-0" />
              <span className="mono text-xs font-medium shrink-0">/new</span>
              <span className="mono text-xs truncate min-w-0">
                {newCmd.title ? <span className="text-fg">{newCmd.title}</span> : <span className="text-muted">[title]</span>}{' '}
                {newCmd.tags.length ? <span className="text-fg">{newCmd.tags.map((g) => `#${g}`).join(' ')}</span> : <span className="text-muted">[#tag …]</span>}
              </span>
              <span className="ml-auto flex items-center gap-1.5 shrink-0"><Kbd>Enter</Kbd><span className="text-[0.7rem] text-muted">create topic</span></span>
            </div>
            {(newCmd.title || newCmd.tags.length > 0 || newCmd.body) && (
              <div className="flex items-center gap-1.5 px-2.5 pb-1.5 min-w-0">
                <Hash size={12} className="text-subtle shrink-0" />
                <span className={cx('text-[0.82rem] font-medium truncate', !newCmd.title && 'italic text-muted')}>{newCmd.title || 'New topic'}</span>
                {newCmd.tags.map((g) => <TagChip key={g} tag={g} size="sm" fluid />)}
                {newCmd.body && <span className="text-[0.7rem] text-muted truncate">· then sends {newCmd.body.split('\n').length} line{newCmd.body.includes('\n') ? 's' : ''} as the first order</span>}
                {(newCmd.long || newCmd.extraTags) && <span className="ml-auto text-[0.7rem] text-warn-ink shrink-0">{newCmd.long ? 'title will be shortened' : `max ${MAX_TAGS} tags`}</span>}
              </div>
            )}
          </div>
        )}
        {slash.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 rounded-xl border border-line bg-raised shadow-af-lg p-1 animate-af-in">
            {slash.map((s) => (
              <button key={s.cmd} onClick={() => { setText(s.args ? `${s.cmd} ` : s.cmd); ta.current?.focus(); }} className="w-full flex items-center gap-3 px-2.5 h-8 rounded-lg hover:bg-accent-soft text-left">
                <Slash size={12} className="text-accent" /><span className="mono text-xs font-medium">{s.cmd}</span><span className="text-xs text-subtle">{s.desc}</span>
              </button>
            ))}
          </div>
        )}
        {topic?.archived && (
          <div className="mb-2 flex items-center gap-2 h-8 px-3 rounded-lg bg-sunken border border-line text-xs text-muted">
            <Archive size={13} className="shrink-0" />This topic is archived.
            <Button size="sm" variant="ghost" icon={ArchiveRestore} className="ml-auto -mr-2" onClick={() => st.archiveTopic(topic, false).catch(() => {})}>Unarchive</Button>
          </div>
        )}
        <div className={cx('rounded-xl border bg-sunken transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft', drag ? 'border-accent border-dashed' : 'border-line')}>
          <textarea ref={ta} value={text} rows={Math.min(8, Math.max(2, text.split('\n').length))}
            placeholder={drag ? 'Drop images to attach…' : `Order for ${project.manager_name}${topic ? ` in "${topic.title}"` : ''}…  (Enter to send · Shift+Enter newline · / for commands · paste images)`}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && slash.length) { e.preventDefault(); setText(slash[0].args ? `${slash[0].cmd} ` : slash[0].cmd); }
              else if (e.key === 'Escape' && newCmd) { e.preventDefault(); setHideHint(true); }
              else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            className="w-full bg-transparent resize-none outline-none focus-visible:outline-none! px-3 pt-2.5 text-[0.86rem] placeholder:text-subtle" />
          {/* items-end: the add-image button and Send stay level at the bottom however many thumbnail rows wrap between them. */}
          <div className="flex items-end gap-2 px-2 pb-2">
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <IconButton icon={ImagePlus} label="Attach images" onClick={() => fileInput.current?.click()} />
            {files.length > 0 && (
              <div className="flex-1 min-w-0 flex flex-wrap gap-2">
                {files.map((f, i) => (
                  <div key={f.url} className="relative group">
                    {/* Double-click (or Enter/Space when focused) opens the preview; a single click does nothing. */}
                    <img src={f.url} alt={f.file.name} title="Double-click to preview" tabIndex={0} onDoubleClick={() => setPreview(f)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreview(f); } }}
                      className="size-10 object-cover rounded-md border border-line cursor-zoom-in select-none" />
                    <button aria-label={`Remove ${f.file.name}`} onClick={() => { setFiles(files.filter((_, j) => j !== i)); if (preview === f) setPreview(null); }}
                      className="absolute -top-1 -right-1 size-4 rounded-full bg-raised border border-line flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100"><X size={9} /></button>
                  </div>
                ))}
              </div>
            )}
            <Button variant="primary" size="sm" icon={Send} className="ml-auto" loading={sending} disabled={!text.trim() && !files.length} onClick={send}
              title={running ? 'New orders are queued after the current mission' : undefined}>Send</Button>
            <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.file.name || 'Image'} size="lg" bodyClass="p-2 flex items-center justify-center bg-sunken">
              {preview && <img src={preview.url} alt={preview.file.name} className="max-w-full max-h-full object-contain" />}
            </Modal>
          </div>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">{st.announce}</div>
      <ProjectSettings project={project} open={!!settings} onClose={() => { if (settings === 'preview') setPreviewWin(true); setSettings(false); }} />
      {/* Closing the window leaves the preview process running. */}
      {previewWin && (
        <PreviewWindow project={project} onClose={() => { setPreviewWin(false); previewBtn.current?.focus(); }}
          onOpenSettings={() => { setPreviewWin(false); setSettings('preview'); }} />
      )}
      <Confirm open={confirmDel} title={`Delete "${project.name}"?`} danger confirmLabel="Delete project" onClose={() => setConfirmDel(false)}
        body="Removes the project, its chat history and tasks from AgentForge. Files on disk are kept."
        onConfirm={() => api.post('/api/projects/delete', { ids: [project.id] })} />
    </div>
  );
}

