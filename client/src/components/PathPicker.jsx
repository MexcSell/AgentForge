import { useEffect, useRef, useState } from 'react';
import { FolderOpen, ArrowUp, Home, FolderPlus, Check, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { FileIcon } from '../lib/icons.jsx';
import { Modal } from './Modal.jsx';
import { Button, IconButton, Input, Spinner, cx } from './ui.jsx';

/** Text input with directory autocomplete + a "Browse" button that opens a folder picker. */
export function PathInput({ value, onChange, placeholder = '/home/you/projects/app' }) {
  const [sugs, setSugs] = useState([]);
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [hi, setHi] = useState(0);
  useEffect(() => {
    if (!value) return setSugs([]);
    const t = setTimeout(() => api.get(`/api/fs/complete?q=${encodeURIComponent(value)}`, { quiet: true }).then(setSugs).catch(() => setSugs([])), 120);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <div className="relative flex gap-2">
      <div className="relative flex-1">
        <Input value={value} placeholder={placeholder} icon={FolderOpen} className="mono"
          onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (!open || !sugs.length) return;
            if (e.key === 'Tab' || (e.key === 'Enter' && sugs[hi])) { e.preventDefault(); onChange(sugs[hi]); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((hi + 1) % sugs.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((hi - 1 + sugs.length) % sugs.length); }
          }} />
        {open && sugs.length > 0 && (
          <div className="absolute z-20 left-0 right-0 top-9 max-h-56 overflow-auto rounded-lg border border-line bg-raised shadow-af-lg py-1">
            {sugs.map((s, i) => (
              <button key={s} onMouseDown={(e) => { e.preventDefault(); onChange(s); }} className={cx('w-full flex items-center gap-2 px-2.5 h-7 text-left text-xs mono truncate', i === hi ? 'bg-accent-soft' : 'hover:bg-hover')}>
                <FileIcon entry={{ type: 'dir', name: s }} size={13} />{s}
              </button>
            ))}
          </div>
        )}
      </div>
      <Button type="button" icon={FolderOpen} onClick={() => setBrowse(true)}>Browse</Button>
      <FolderPicker open={browse} start={value} onClose={() => setBrowse(false)} onPick={(p) => { onChange(p); setBrowse(false); }} />
    </div>
  );
}

export function FolderPicker({ open, start, onClose, onPick }) {
  const [path, setPath] = useState(null);
  const [data, setData] = useState(null);
  const [newName, setNewName] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => { if (open) setPath(start?.replace(/\/$/, '') || null); }, [open]);
  useEffect(() => {
    if (!open) return;
    setData(null);
    api.get(`/api/fs/list?path=${encodeURIComponent(path || '')}`, { quiet: true })
      .then(setData)
      .catch(() => api.get('/api/fs/list').then((d) => { setData(d); setPath(d.path); }));
  }, [open, path]);
  const crumbs = (data?.path || '').split('/').filter(Boolean);
  const create = async () => {
    if (!newName?.trim()) return setNewName(null);
    const r = await api.post('/api/fs/create', { dir: data.path, name: newName.trim(), type: 'dir' });
    setNewName(null);
    setPath(r.path);
  };
  return (
    <Modal open={open} onClose={onClose} title="Choose working directory" icon={FolderOpen} size="md" bodyClass="p-0"
      footer={<>
        <span className="mr-auto text-xs mono text-muted truncate">{data?.path}</span>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={Check} onClick={() => onPick(data.path)} disabled={!data}>Select this folder</Button>
      </>}>
      <div className="flex items-center gap-1 px-3 h-10 border-b border-line">
        <IconButton icon={ArrowUp} label="Up" disabled={!data?.parent} onClick={() => setPath(data.parent)} />
        <IconButton icon={Home} label="Home" onClick={() => setPath('~')} />
        <div className="flex items-center gap-0.5 text-xs min-w-0 overflow-x-auto mx-1">
          <button className="px-1 hover:text-accent" onClick={() => setPath('/')}>/</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5 shrink-0"><ChevronRight size={11} className="text-subtle" />
              <button className="px-1 rounded hover:text-accent" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>
          ))}
        </div>
        <IconButton icon={FolderPlus} label="New folder" className="ml-auto" onClick={() => { setNewName(''); setTimeout(() => inputRef.current?.focus(), 10); }} />
      </div>
      {newName !== null && (
        <div className="flex gap-2 px-3 py-2 border-b border-line">
          <Input ref={inputRef} className="flex-1" placeholder="Folder name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setNewName(null); }} />
          <Button onClick={create}>Create</Button>
        </div>
      )}
      <div className="h-[46vh] overflow-auto py-1">
        {!data && <div className="flex justify-center py-10"><Spinner /></div>}
        {data?.entries.filter((e) => e.type === 'dir' && !e.hidden).map((e) => (
          <button key={e.path} onDoubleClick={() => setPath(e.path)} onClick={() => setPath(e.path)} className="w-full flex items-center gap-2.5 px-3.5 h-8 text-left text-[0.82rem] hover:bg-hover">
            <FileIcon entry={e} /><span className="truncate">{e.name}</span>
          </button>
        ))}
        {data && !data.entries.some((e) => e.type === 'dir' && !e.hidden) && <div className="text-center text-xs text-subtle py-8">No sub-folders. Select this folder or create one.</div>}
      </div>
    </Modal>
  );
}
