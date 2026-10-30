import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ArrowUp, RefreshCw, FilePlus, FolderPlus, Upload, Copy, Scissors, ClipboardPaste, Trash2, Pencil, Plus, X, Eye, EyeOff,
  LayoutList, LayoutGrid, Download, TerminalSquare, ChevronRight, Link, Files as FilesIcon, Search, CopyPlus, FolderOpen, ClipboardCopy,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { bytes, timeAgo, copyText, dateTime } from '../../lib/format.js';
import { FileIcon } from '../../lib/icons.jsx';
import { Split } from '../../components/Split.jsx';
import { Confirm } from '../../components/Modal.jsx';
import { openContextMenu } from '../../components/ContextMenu.jsx';
import { cx, IconButton, Input, Spinner, Empty } from '../../components/ui.jsx';
import { useFs, DRAG_TYPE, join, parentOf, transfer, removePaths, uploadTo } from './fsStore.js';
import { FileViewer } from './FileViewer.jsx';
import { TerminalPanel } from './Terminal.jsx';

function dropHandlers(targetDir, setOver) {
  return {
    onDragOver: (e) => {
      const t = [...e.dataTransfer.types];
      if (!t.includes(DRAG_TYPE) && !t.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : t.includes('Files') ? 'copy' : 'move';
      setOver?.(true);
    },
    onDragLeave: () => setOver?.(false),
    onDrop: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      setOver?.(false);
      const paths = e.dataTransfer.getData(DRAG_TYPE);
      if (paths) await transfer(JSON.parse(paths), targetDir, e.ctrlKey || e.altKey ? 'copy' : 'move');
      else if (e.dataTransfer.files.length) await uploadTo(targetDir, [...e.dataTransfer.files]);
    },
  };
}

function Row({ e, selected, cut, view, onClick, onOpen, onMenu, onDragStart, renaming, onRename }) {
  const [over, setOver] = useState(false);
  const isDir = e.type === 'dir';
  const drop = isDir ? dropHandlers(e.path, setOver) : {};
  const name = renaming ? (
    <input autoFocus defaultValue={e.name} onClick={(x) => x.stopPropagation()} onFocus={(x) => { const i = e.name.lastIndexOf('.'); x.target.setSelectionRange(0, i > 0 && !isDir ? i : e.name.length); }}
      onBlur={(x) => onRename(x.target.value)} onKeyDown={(x) => { if (x.key === 'Enter') x.currentTarget.blur(); if (x.key === 'Escape') onRename(null); x.stopPropagation(); }}
      className="w-full h-6 px-1.5 rounded bg-sunken border border-accent outline-none text-[0.82rem]" />
  ) : <span className="truncate">{e.name}</span>;
  if (view === 'grid') {
    return (
      <div draggable={!renaming} onDragStart={onDragStart} onClick={onClick} onDoubleClick={onOpen} onContextMenu={onMenu} {...drop} title={e.name}
        className={cx('flex flex-col items-center gap-1.5 p-2 rounded-lg cursor-default select-none text-center text-[0.76rem]', selected ? 'bg-accent-soft ring-1 ring-accent/40' : 'hover:bg-hover', over && 'ring-2 ring-accent', cut && 'opacity-50', e.hidden && 'opacity-70')}>
        <FileIcon entry={e} size={34} />
        <div className="w-full line-clamp-2 break-all">{name}</div>
      </div>
    );
  }
  return (
    <div draggable={!renaming} onDragStart={onDragStart} onClick={onClick} onDoubleClick={onOpen} onContextMenu={onMenu} {...drop}
      className={cx('grid grid-cols-[minmax(0,1fr)_80px_96px] items-center gap-3 px-3 row-h text-[0.82rem] cursor-default select-none border-l-2',
        selected ? 'bg-accent-soft border-accent' : 'border-transparent hover:bg-hover', over && 'ring-2 ring-inset ring-accent', cut && 'opacity-50', e.hidden && 'text-muted')}>
      <div className="flex items-center gap-2 min-w-0"><FileIcon entry={e} />{name}{e.link && <Link size={10} className="text-subtle shrink-0" />}</div>
      <span className="text-right text-xs text-subtle tabular">{isDir ? '—' : bytes(e.size)}</span>
      <span className="text-right text-xs text-subtle" title={dateTime(e.mtime)}>{timeAgo(e.mtime)}</span>
    </div>
  );
}

function FilePane({ pane, index, count, root, active, onFocus, onClose, onSplit }) {
  const st = useStore();
  const tick = useFs((s) => s.tick);
  const [path, setPath] = useState(pane.path || root);
  const [hist, setHist] = useState({ back: [], fwd: [] });
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [anchor, setAnchor] = useState(null);
  const [view, setView] = useState('list');
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [creating, setCreating] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [over, setOver] = useState(false);
  const [editPath, setEditPath] = useState(null);
  const box = useRef(null);
  const upload = useRef(null);

  useEffect(() => { if (pane.path && pane.path !== path) setPath(pane.path); }, [pane.path]);
  useEffect(() => {
    if (!path) return;
    setErr(null);
    api.get(`/api/fs/list?path=${encodeURIComponent(path)}`, { quiet: true }).then((d) => { setData(d); if (d.path !== path) setPath(d.path); }).catch((e) => setErr(e.message));
  }, [path, tick]);
  useEffect(() => {
    // Persist pane path so a reload restores it.
    const panes = useStore.getState().filePanes.map((p) => (p.id === pane.id ? { ...p, path } : p));
    useStore.getState().set({ filePanes: panes });
  }, [path]);

  const go = (p) => { if (p === path) return; setHist({ back: [...hist.back, path], fwd: [] }); setPath(p); setSel(new Set()); setFilter(''); };
  const back = () => { const b = hist.back.at(-1); if (!b) return; setHist({ back: hist.back.slice(0, -1), fwd: [path, ...hist.fwd] }); setPath(b); };
  const fwd = () => { const f = hist.fwd[0]; if (!f) return; setHist({ back: [...hist.back, path], fwd: hist.fwd.slice(1) }); setPath(f); };

  const entries = useMemo(() => (data?.entries || []).filter((e) => (st.showHidden || !e.hidden) && (!filter || e.name.toLowerCase().includes(filter.toLowerCase()))), [data, st.showHidden, filter]);
  const selected = entries.filter((e) => sel.has(e.path));
  const clip = st.fileClipboard;

  const open = (e) => (e.type === 'dir' ? go(e.path) : st.set({ openFile: { path: e.path } }));
  const click = (ev, e, i) => {
    onFocus();
    if (ev.shiftKey && anchor != null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSel(new Set(entries.slice(a, b + 1).map((x) => x.path)));
    } else if (ev.ctrlKey || ev.metaKey) {
      const n = new Set(sel);
      n.has(e.path) ? n.delete(e.path) : n.add(e.path);
      setSel(n);
      setAnchor(i);
    } else {
      setSel(new Set([e.path]));
      setAnchor(i);
    }
  };
  const copy = (mode, paths = [...sel]) => { if (!paths.length) return; st.set({ fileClipboard: { mode, paths } }); toast.info(`${paths.length} item${paths.length > 1 ? 's' : ''} ${mode === 'cut' ? 'cut' : 'copied'}`); };
  const paste = async (dest = path) => {
    if (!clip) return;
    await transfer(clip.paths, dest, clip.mode === 'cut' ? 'move' : 'copy');
    if (clip.mode === 'cut') st.set({ fileClipboard: null });
  };
  const del = (paths = [...sel]) => {
    if (!paths.length) return;
    setConfirm({ title: `Delete ${paths.length} item${paths.length > 1 ? 's' : ''}?`, body: <div className="flex flex-col gap-1">{paths.slice(0, 8).map((p) => <span key={p} className="mono text-xs text-fg truncate">{p}</span>)}{paths.length > 8 && <span>…and {paths.length - 8} more</span>}<span className="mt-2">This permanently removes them from disk.</span></div>, onConfirm: async () => { await removePaths(paths); setSel(new Set()); } });
  };
  const rename = async (e, name) => {
    setRenaming(null);
    if (!name || name === e.name) return;
    await api.post('/api/fs/rename', { path: e.path, name });
    useFs.getState().bump();
  };
  const create = async (name) => {
    const type = creating;
    setCreating(null);
    if (!name?.trim()) return;
    const r = await api.post('/api/fs/create', { dir: path, name: name.trim(), type });
    useFs.getState().bump();
    if (type === 'file') st.set({ openFile: { path: r.path } });
  };
  const duplicate = (paths = [...sel]) => transfer(paths, path, 'copy');

  const entryMenu = (ev, e) => {
    if (!sel.has(e.path)) setSel(new Set([e.path]));
    const targets = sel.has(e.path) ? [...sel] : [e.path];
    openContextMenu(ev, [
      { label: e.type === 'dir' ? 'Open folder' : 'Open', icon: e.type === 'dir' ? FolderOpen : Eye, shortcut: 'Enter', onClick: () => open(e) },
      e.type === 'dir' && { label: 'Open in new pane', icon: Plus, onClick: () => onSplit(e.path) },
      { label: 'Open terminal here', icon: TerminalSquare, onClick: () => window.dispatchEvent(new CustomEvent('af:terminal-cd', { detail: e.type === 'dir' ? e.path : path })) },
      '-',
      { label: 'Copy', icon: Copy, shortcut: 'Ctrl+C', onClick: () => copy('copy', targets) },
      { label: 'Cut', icon: Scissors, shortcut: 'Ctrl+X', onClick: () => copy('cut', targets) },
      e.type === 'dir' && { label: 'Paste into folder', icon: ClipboardPaste, disabled: !clip, onClick: () => paste(e.path) },
      { label: 'Duplicate', icon: CopyPlus, onClick: () => duplicate(targets) },
      { label: 'Rename', icon: Pencil, shortcut: 'F2', onClick: () => setRenaming(e.path) },
      { label: 'Copy path', icon: Link, onClick: () => copyText(targets.join('\n')) },
      e.type === 'file' && { label: 'Download', icon: Download, onClick: () => { location.href = `/api/fs/raw?path=${encodeURIComponent(e.path)}&download=1`; } },
      '-',
      { label: targets.length > 1 ? `Delete ${targets.length} items` : 'Delete', icon: Trash2, danger: true, shortcut: 'Del', onClick: () => del(targets) },
    ]);
  };
  const bgMenu = (ev) => openContextMenu(ev, [
    { label: 'New file', icon: FilePlus, onClick: () => setCreating('file') },
    { label: 'New folder', icon: FolderPlus, onClick: () => setCreating('dir') },
    { label: 'Upload files…', icon: Upload, onClick: () => upload.current?.click() },
    { label: 'Paste', icon: ClipboardPaste, shortcut: 'Ctrl+V', disabled: !clip, onClick: () => paste() },
    '-',
    { label: 'Open terminal here', icon: TerminalSquare, onClick: () => window.dispatchEvent(new CustomEvent('af:terminal-cd', { detail: path })) },
    { label: 'Copy path', icon: Link, onClick: () => copyText(path) },
    { label: 'Refresh', icon: RefreshCw, onClick: () => useFs.getState().bump() },
  ]);

  const onKey = (ev) => {
    if (renaming || creating || editPath != null || ev.target.tagName === 'INPUT') return;
    const k = ev.key.toLowerCase();
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && k === 'a') { ev.preventDefault(); setSel(new Set(entries.map((e) => e.path))); }
    else if (mod && k === 'c') copy('copy');
    else if (mod && k === 'x') copy('cut');
    else if (mod && k === 'v') paste();
    else if (k === 'delete') del();
    else if (k === 'f2' && selected[0]) setRenaming(selected[0].path);
    else if (k === 'enter' && selected.length === 1) open(selected[0]);
    else if (k === 'backspace' && data?.parent) go(data.parent);
    else if (k === 'escape') setSel(new Set());
    else if (k === 'arrowdown' || k === 'arrowup') {
      ev.preventDefault();
      const i = entries.findIndex((e) => e.path === [...sel].at(-1));
      const n = Math.max(0, Math.min(entries.length - 1, i + (k === 'arrowdown' ? 1 : -1)));
      if (entries[n]) { setSel(new Set([entries[n].path])); setAnchor(n); }
    }
  };

  const crumbs = path ? path.split('/').filter(Boolean) : [];
  // mousedown preventDefault keeps focus in the path input, so copying doesn't end edit mode.
  const copyPath = (
    <IconButton icon={ClipboardCopy} size="sm" label="Copy path" className="mr-0.5" onMouseDown={(e) => e.preventDefault()}
      onClick={async (e) => { e.stopPropagation(); if (await copyText(path)) toast.success('Path copied', path); else toast.error('Could not copy path'); }} />
  );
  return (
    <div ref={box} tabIndex={0} onKeyDown={onKey} onMouseDown={onFocus} className={cx('h-full flex flex-col outline-none', active && count > 1 && 'ring-1 ring-inset ring-accent/40')}>
      <div className="flex items-center gap-0.5 h-10 px-1.5 border-b border-line shrink-0">
        <IconButton icon={ArrowLeft} label="Back" disabled={!hist.back.length} onClick={back} />
        <IconButton icon={ArrowRight} label="Forward" disabled={!hist.fwd.length} onClick={fwd} />
        <IconButton icon={ArrowUp} label="Up (Backspace)" disabled={!data?.parent} onClick={() => go(data.parent)} />
        {editPath != null ? (
          <Input autoFocus className="flex-1 mx-1 mono" value={editPath} onChange={(e) => setEditPath(e.target.value)} onBlur={() => setEditPath(null)} right={copyPath}
            onKeyDown={(e) => { if (e.key === 'Enter') { go(editPath.trim()); setEditPath(null); } if (e.key === 'Escape') setEditPath(null); }} />
        ) : (
          <div className="flex-1 min-w-0 flex items-center mx-1 h-7 rounded-md bg-sunken border border-line text-xs">
            <div className="flex-1 min-w-0 self-stretch flex items-center gap-0.5 pl-1.5 overflow-x-auto cursor-text" onClick={(e) => e.target === e.currentTarget && setEditPath(path)}>
              <button className="px-1 rounded hover:bg-hover" onClick={() => go('/')}>/</button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center shrink-0"><ChevronRight size={11} className="text-subtle" />
                  <button className="px-1 rounded hover:bg-hover" {...dropHandlers('/' + crumbs.slice(0, i + 1).join('/'))} onClick={() => go('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>
              ))}
              <span className="flex-1 self-stretch" onClick={() => setEditPath(path)} />
            </div>
            {copyPath}
          </div>
        )}
        <IconButton icon={FilePlus} label="New file" onClick={() => setCreating('file')} />
        <IconButton icon={FolderPlus} label="New folder" onClick={() => setCreating('dir')} />
        <IconButton icon={Upload} label="Upload" onClick={() => upload.current?.click()} />
        <input ref={upload} type="file" multiple hidden onChange={(e) => { uploadTo(path, [...e.target.files]); e.target.value = ''; }} />
        <IconButton icon={Plus} label="Split: open another pane" onClick={() => onSplit(path)} />
        {count > 1 && <IconButton icon={X} label="Close pane" onClick={onClose} />}
      </div>
      <div className="flex items-center gap-1 h-9 px-2 border-b border-line shrink-0">
        <IconButton icon={Copy} size="sm" label="Copy (Ctrl+C)" disabled={!sel.size} onClick={() => copy('copy')} />
        <IconButton icon={Scissors} size="sm" label="Cut (Ctrl+X)" disabled={!sel.size} onClick={() => copy('cut')} />
        <IconButton icon={ClipboardPaste} size="sm" label={clip ? `Paste ${clip.paths.length} (Ctrl+V)` : 'Paste'} disabled={!clip} onClick={() => paste()} />
        <IconButton icon={Pencil} size="sm" label="Rename (F2)" disabled={sel.size !== 1} onClick={() => setRenaming([...sel][0])} />
        <IconButton icon={Trash2} size="sm" tone="danger" label="Delete (Del)" disabled={!sel.size} onClick={() => del()} />
        <span className="w-px h-4 bg-line mx-1" />
        <Input icon={Search} className="w-40 [&_input]:h-6 [&_input]:text-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="ml-auto text-[0.68rem] text-subtle tabular whitespace-nowrap">{sel.size ? `${sel.size} selected · ` : ''}{entries.length} items</span>
        <IconButton icon={st.showHidden ? Eye : EyeOff} size="sm" label={st.showHidden ? 'Hide dotfiles' : 'Show dotfiles'} active={st.showHidden} onClick={() => st.set({ showHidden: !st.showHidden })} />
        <IconButton icon={view === 'list' ? LayoutGrid : LayoutList} size="sm" label={view === 'list' ? 'Grid view' : 'List view'} onClick={() => setView(view === 'list' ? 'grid' : 'list')} />
        <IconButton icon={RefreshCw} size="sm" label="Refresh" onClick={() => useFs.getState().bump()} />
      </div>
      {view === 'list' && <div className="grid grid-cols-[minmax(0,1fr)_80px_96px] gap-3 px-3 h-7 items-center text-[0.66rem] uppercase tracking-wider text-subtle border-b border-line shrink-0"><span>Name</span><span className="text-right">Size</span><span className="text-right">Modified</span></div>}
      <div className={cx('flex-1 min-h-0 overflow-auto', over && 'bg-accent-soft/50')} onClick={(e) => e.target === e.currentTarget && setSel(new Set())} onContextMenu={bgMenu} {...dropHandlers(path, setOver)}>
        {creating && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line bg-accent-soft/40">
            <FileIcon entry={{ type: creating, name: '', ext: '' }} />
            <input autoFocus placeholder={creating === 'dir' ? 'New folder name' : 'New file name (e.g. notes.md)'} onBlur={(e) => create(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setCreating(null); }}
              className="flex-1 h-6 px-1.5 rounded bg-sunken border border-accent outline-none text-[0.82rem]" />
          </div>
        )}
        {err && <Empty icon={FolderOpen} title="Cannot open folder">{err}</Empty>}
        {!data && !err && <div className="flex justify-center py-8"><Spinner /></div>}
        {data && !entries.length && !creating && <Empty icon={FilesIcon} title={filter ? 'No matches' : 'Empty folder'}>Drop files here to upload, or right-click to create.</Empty>}
        <div className={cx(view === 'grid' && 'grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1 p-2')} onClick={(e) => e.target === e.currentTarget && setSel(new Set())}>
          {entries.map((e, i) => (
            <Row key={e.path} e={e} view={view} selected={sel.has(e.path)} cut={clip?.mode === 'cut' && clip.paths.includes(e.path)} renaming={renaming === e.path}
              onRename={(name) => rename(e, name)} onClick={(ev) => click(ev, e, i)} onOpen={() => open(e)} onMenu={(ev) => entryMenu(ev, e)}
              onDragStart={(ev) => {
                const paths = sel.has(e.path) ? [...sel] : [e.path];
                if (!sel.has(e.path)) setSel(new Set([e.path]));
                ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
                ev.dataTransfer.setData('text/plain', paths.join('\n'));
                ev.dataTransfer.effectAllowed = 'copyMove';
              }} />
          ))}
        </div>
      </div>
      <Confirm open={!!confirm} {...confirm} danger confirmLabel="Delete" onClose={() => setConfirm(null)} />
    </div>
  );
}

export default function Files({ layout }) {
  const st = useStore();
  const project = st.projects.find((p) => p.id === st.activeProjectId) || st.projects[0];
  const panes = st.filePanes;
  const activeId = panes.some((p) => p.id === st.activePane) ? st.activePane : panes[0].id;
  const [paths, setPaths] = useState({});
  const activePath = paths[activeId] || panes.find((p) => p.id === activeId)?.path || project?.path;
  const [termKey] = useState(0);

  // Keep a map of pane → current path (FilePane persists into the store).
  useEffect(() => { setPaths(Object.fromEntries(panes.map((p) => [p.id, p.path]))); }, [panes]);

  const split = useCallback((path) => {
    if (panes.length >= 4) return toast.warn('Up to 4 panes');
    const id = `p${Date.now()}`;
    st.set({ filePanes: [...panes, { id, path }], activePane: id });
  }, [panes]);
  const close = (id) => {
    const next = panes.filter((p) => p.id !== id);
    st.set({ filePanes: next, activePane: next[0].id });
  };

  const paneArea = (
    <Split id={`files-panes-${panes.length}`} orientation="horizontal" panels={panes.map((p, i) => ({
      id: p.id, size: 100 / panes.length, min: 15,
      node: <FilePane pane={p} index={i} count={panes.length} root={project?.path || '/'} active={p.id === activeId}
        onFocus={() => activeId !== p.id && st.set({ activePane: p.id })} onClose={() => close(p.id)} onSplit={split} />,
    }))} />
  );
  return (
    <>
      <Split id={`files-${layout.id}`} orientation="vertical" floating={layout.floating}
        panels={[{ id: 'top', size: 100 - layout.files.terminal, min: 20, node: paneArea }, { id: 'terminal', size: layout.files.terminal, min: 10, node: <TerminalPanel key={termKey} cwd={activePath} /> }]} />
      <FileViewer />
    </>
  );
}

