import { useEffect, useRef, useState } from 'react';
import { FolderKanban, Plus, Lock, Trash2, Pencil, FolderOpen, Copy, Bot, X, CheckSquare, Square, Loader2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore, selectWorkingAgents } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { copyText, timeAgo } from '../../lib/format.js';
import { GithubMark } from '../../lib/icons.jsx';
import { Split } from '../../components/Split.jsx';
import { Confirm, Modal } from '../../components/Modal.jsx';
import { PathInput } from '../../components/PathPicker.jsx';
import { openContextMenu } from '../../components/ContextMenu.jsx';
import { cx, Button, IconButton, Input, Field, Textarea, Empty, StatusDot } from '../../components/ui.jsx';
import { CommandWindow } from './CommandWindow.jsx';
import { AgentRail } from './AgentRail.jsx';

export function CreateProjectDialog() {
  const open = useStore((s) => s.createProject);
  const set = useStore((s) => s.set);
  const [f, setF] = useState({ name: '', path: '', github_url: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [touchedPath, setTouchedPath] = useState(false);
  useEffect(() => { if (open) { setF({ name: '', path: '/home/', github_url: '', description: '' }); setTouchedPath(false); } }, [open]);
  const slug = f.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const p = await api.post('/api/projects', f);
      toast.success(`Project "${p.name}" created`, `${p.manager_name} is its General Manager`);
      set({ createProject: false, activeProjectId: p.id, view: 'projects' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={() => set({ createProject: false })} title="New project" icon={FolderKanban} size="md"
      footer={<><Button variant="ghost" onClick={() => set({ createProject: false })}>Cancel</Button><Button variant="primary" icon={Plus} loading={busy} disabled={!f.name.trim() || !f.path.trim()} onClick={submit}>Create project</Button></>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={f.name} placeholder="My new app" onChange={(e) => {
            const name = e.target.value;
            setF((x) => ({ ...x, name, path: touchedPath ? x.path : x.path.replace(/[^/]*$/, name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) }));
          }} />
        </Field>
        <Field label="Working directory" hint="Created if it does not exist. Tab completes; Browse opens the file manager.">
          <PathInput value={f.path} onChange={(path) => { setTouchedPath(true); setF((x) => ({ ...x, path })); }} placeholder={`/home/you/${slug || 'project'}`} />
        </Field>
        <Field label="GitHub URL" hint="Recommended. Every completed mission is committed and pushed here.">
          <Input value={f.github_url} placeholder="https://github.com/owner/repo.git" onChange={(e) => setF({ ...f, github_url: e.target.value })} />
        </Field>
        <Field label="Brief (optional)">
          <Textarea rows={3} value={f.description} placeholder="What is this project for?" onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}

function ProjectList() {
  const st = useStore();
  const working = useStore((s) => selectWorkingAgents(s).length);
  const [sel, setSel] = useState(new Set());
  const [anchor, setAnchor] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const running = st.projects.filter((p) => p.status === 'running').length;

  const click = (e, p, i) => {
    if (e.shiftKey && anchor != null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSel(new Set(st.projects.slice(a, b + 1).map((x) => x.id)));
    } else if (e.ctrlKey || e.metaKey || selectMode) {
      const next = new Set(sel);
      next.has(p.id) ? next.delete(p.id) : next.add(p.id);
      setSel(next);
      setAnchor(i);
    } else {
      setSel(new Set());
      setAnchor(i);
      st.set({ activeProjectId: p.id });
    }
  };
  const del = (ids) => {
    const targets = st.projects.filter((p) => ids.includes(p.id));
    const deletable = targets.filter((p) => !p.protected);
    if (!deletable.length) return toast.warn('The AgentForge core project is protected and cannot be deleted');
    setConfirm({
      title: `Delete ${deletable.length} project${deletable.length > 1 ? 's' : ''}?`,
      body: <>Removes {deletable.map((p) => <b key={p.id} className="text-fg">{p.name} </b>)} from AgentForge with its chat history and tasks. Files on disk are kept.{targets.some((p) => p.protected) && <div className="mt-2 text-warn">Protected projects are skipped.</div>}</>,
      onConfirm: async () => { await api.post('/api/projects/delete', { ids: deletable.map((p) => p.id) }); setSel(new Set()); },
    });
  };
  const rename = async (p, name) => {
    setRenaming(null);
    if (name.trim() && name.trim() !== p.name) await api.patch(`/api/projects/${p.id}`, { name: name.trim() });
  };
  const menu = (e, p) => openContextMenu(e, [
    { label: 'Open', icon: FolderKanban, onClick: () => st.set({ activeProjectId: p.id }) },
    { label: 'Rename', icon: Pencil, shortcut: 'F2', onClick: () => setRenaming(p.id) },
    { label: 'Open in Files', icon: FolderOpen, onClick: () => st.set({ view: 'files', filePanes: [{ id: 'p1', path: p.path }], activePane: 'p1' }) },
    { label: 'Sync to GitHub', icon: GithubMark, onClick: () => api.post(`/api/projects/${p.id}/sync`) },
    { label: 'Copy path', icon: Copy, onClick: () => copyText(p.path) },
    '-',
    { label: p.protected ? 'Delete (protected)' : sel.size > 1 && sel.has(p.id) ? `Delete ${sel.size} selected` : 'Delete', icon: Trash2, danger: true, disabled: p.protected, onClick: () => del(sel.size > 1 && sel.has(p.id) ? [...sel] : [p.id]) },
  ]);

  return (
    <div className="h-full flex flex-col" tabIndex={-1} onKeyDown={(e) => {
      const active = st.projects.find((p) => p.id === st.activeProjectId);
      if (e.key === 'F2' && active) setRenaming(active.id);
      if (e.key === 'Delete' && (sel.size || active)) del(sel.size ? [...sel] : [active.id]);
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); setSel(new Set(st.projects.map((p) => p.id))); }
    }}>
      <div className="flex items-center gap-2 h-10 px-3 border-b border-line shrink-0">
        <FolderKanban size={15} className="text-subtle" />
        <span className="text-[0.72rem] font-semibold uppercase tracking-wider text-muted">Projects</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={selectMode ? CheckSquare : Square} label="Multi-select" active={selectMode} onClick={() => { setSelectMode(!selectMode); setSel(new Set()); }} />
          <IconButton icon={Plus} label="New project" onClick={() => st.set({ createProject: true })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 p-2.5 border-b border-line shrink-0">
        <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-sunken border border-line" title="Projects currently running">
          <FolderKanban size={15} className={running ? 'text-accent' : 'text-subtle'} />
          <div><div className="text-base font-semibold leading-none tabular">{running}<span className="text-subtle text-xs font-normal"> / {st.projects.length}</span></div><div className="text-[0.66rem] text-subtle mt-0.5">projects running</div></div>
        </div>
        <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-sunken border border-line" title="Agents currently running">
          <Bot size={15} className={working ? 'text-accent' : 'text-subtle'} />
          <div><div className="text-base font-semibold leading-none tabular">{working}</div><div className="text-[0.66rem] text-subtle mt-0.5">agents running</div></div>
        </div>
      </div>
      {sel.size > 0 && (
        <div className="flex items-center gap-2 px-3 h-9 border-b border-line bg-accent-soft text-xs shrink-0 animate-af-fade">
          <span className="font-medium">{sel.size} selected</span>
          <button className="ml-auto flex items-center gap-1 text-bad hover:underline" onClick={() => del([...sel])}><Trash2 size={12} />Delete</button>
          <IconButton icon={X} size="sm" label="Clear selection" onClick={() => setSel(new Set())} />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-1.5">
        {st.projects.map((p, i) => {
          const active = p.id === st.activeProjectId;
          const selected = sel.has(p.id);
          return (
            <div key={p.id} onClick={(e) => click(e, p, i)} onDoubleClick={() => setRenaming(p.id)} onContextMenu={(e) => menu(e, p)}
              className={cx('group relative flex items-center gap-2.5 px-2 py-2 rounded-lg cursor-pointer select-none mb-0.5 transition-colors',
                selected ? 'bg-accent-soft ring-1 ring-accent/40' : active ? 'bg-hover' : 'hover:bg-hover')}>
              {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full grad-accent" />}
              {(selectMode || sel.size > 0) && (
                <span className={cx('size-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-accent border-accent text-accent-fg' : 'border-line-strong')}>{selected && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.8" fill="none" /></svg>}</span>
              )}
              <span className={cx('size-8 rounded-lg flex items-center justify-center shrink-0', p.protected ? 'grad-accent text-accent-fg' : 'bg-sunken border border-line text-muted')}>
                {p.status === 'running' ? <Loader2 size={15} className="animate-spin" /> : p.protected ? <Lock size={14} /> : <FolderKanban size={15} />}
              </span>
              <div className="min-w-0 flex-1">
                {renaming === p.id ? (
                  <input autoFocus defaultValue={p.name} onClick={(e) => e.stopPropagation()} onBlur={(e) => rename(p, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); }}
                    className="w-full h-6 px-1.5 -mx-1.5 rounded bg-sunken border border-accent outline-none text-[0.84rem]" />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[0.84rem] font-medium truncate">{p.name}</span>
                    {p.github_url && <GithubMark size={11} className="text-subtle shrink-0" />}
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-[0.68rem] text-subtle">
                  <StatusDot status={p.status === 'running' ? 'running' : 'idle'} />
                  <span>{p.status === 'running' ? `${p.running_agents} agent${p.running_agents === 1 ? '' : 's'} running` : `${p.tasks_done} tasks done`}</span>
                  <span>·</span><span>{timeAgo(p.updated_at)}</span>
                </div>
              </div>
              {!p.protected ? (
                <IconButton icon={Trash2} size="sm" tone="danger" label="Delete project" className="opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); del([p.id]); }} />
              ) : <Lock size={12} className="text-subtle mr-1" title="Protected" />}
            </div>
          );
        })}
        {!st.projects.length && <Empty icon={FolderKanban} title="No projects" action={<Button variant="primary" icon={Plus} onClick={() => st.set({ createProject: true })}>New project</Button>} />}
      </div>
      <div className="px-3 py-2 border-t border-line text-[0.66rem] text-subtle shrink-0">Ctrl/⇧-click to multi-select · F2 rename · Del delete</div>
      <Confirm open={!!confirm} {...confirm} danger confirmLabel="Delete" onClose={() => setConfirm(null)} />
    </div>
  );
}

export default function Projects({ layout }) {
  const st = useStore();
  const project = st.projects.find((p) => p.id === st.activeProjectId);
  useEffect(() => {
    if (project && !st.messages[project.id]) st.loadMessages(project.id).catch(() => {});
  }, [project?.id]);
  const L = layout.project;
  const nodes = {
    list: { id: 'list', size: L.sizes.list ?? 20, min: 12, node: <ProjectList /> },
    chat: { id: 'chat', size: L.sizes.chat ?? 55, min: 25, node: project ? <CommandWindow project={project} /> : <Empty icon={FolderKanban} title="Select or create a project" action={<Button variant="primary" icon={Plus} onClick={() => st.set({ createProject: true })}>New project</Button>} /> },
    agents: { id: 'agents', size: L.sizes.agents ?? 25, min: 14, node: project ? <AgentRail project={project} /> : <div /> },
  };
  return (
    <>
      <Split id={`projects-${layout.id}`} orientation={L.orientation} floating={layout.floating} panels={L.order.filter((k) => !L.hide.includes(k)).map((k) => nodes[k])} />
      <CreateProjectDialog />
    </>
  );
}
