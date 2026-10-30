import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Save, Download, Eye, Code2, Columns2, WrapText, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { bytes, dateTime } from '../../lib/format.js';
import { FileIcon } from '../../lib/icons.jsx';
import { Modal } from '../../components/Modal.jsx';
import { Markdown } from '../../components/Markdown.jsx';
import { cx, Button, IconButton, Tabs, Spinner, Badge } from '../../components/ui.jsx';
import { useFs, baseName } from './fsStore.js';

const surface = EditorView.theme({
  '&': { backgroundColor: 'transparent', height: '100%' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--af-line)', color: 'var(--af-subtle)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--af-hover)' },
});

/** Opens any file: syntax-coloured editor, Markdown preview, image/PDF/media preview. */
export function FileViewer() {
  const file = useStore((s) => s.openFile);
  const set = useStore((s) => s.set);
  const theme = useStore((s) => s.theme);
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [lang, setLang] = useState(null);
  const [mode, setMode] = useState('edit');
  const [wrap, setWrap] = useState(false);
  const [saving, setSaving] = useState(false);
  const isMd = /\.(md|mdx|markdown)$/i.test(file?.path || '');
  const dirty = data?.content != null && text !== data.content;
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    if (!file) return;
    setData(null);
    setLang(null);
    setMode(/\.(md|mdx|markdown)$/i.test(file.path) ? 'preview' : 'edit');
    api.get(`/api/fs/read?path=${encodeURIComponent(file.path)}`).then((d) => { setData(d); setText(d.content ?? ''); }).catch(() => set({ openFile: null }));
    const desc = LanguageDescription.matchFilename(languages, baseName(file.path));
    if (desc) desc.load().then(setLang).catch(() => {});
  }, [file?.path]);

  const save = async (force) => {
    setSaving(true);
    try {
      const r = await api.post('/api/fs/write', { path: file.path, content: text, expectedMtime: force ? undefined : data.mtime }, { quiet: true });
      setData({ ...data, content: text, mtime: r.mtime, size: r.size });
      toast.success(`Saved ${baseName(file.path)}`);
      useFs.getState().bump();
    } catch (e) {
      if (/changed on disk/.test(e.message)) {
        if (confirm('The file changed on disk since you opened it. Overwrite it?')) return save(true);
      } else toast.error(e.message);
    } finally { setSaving(false); }
  };

  useEffect(() => {
    if (!file) return;
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (data?.content != null) save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const extensions = useMemo(() => [surface, ...(lang ? [lang] : []), ...(wrap ? [EditorView.lineWrapping] : [])], [lang, wrap]);
  if (!file) return null;
  const raw = `/api/fs/raw?path=${encodeURIComponent(file.path)}`;
  const mime = data?.mime || '';
  const close = () => { if (!dirty || confirm('Discard unsaved changes?')) set({ openFile: null }); };

  const editor = <CodeMirror value={text} onChange={setText} theme={dark ? 'dark' : 'light'} extensions={extensions} height="100%" className="h-full" basicSetup={{ foldGutter: true, highlightActiveLine: true, bracketMatching: true, autocompletion: false }} />;

  return (
    <Modal open onClose={close} size="xl" bodyClass="p-0 flex flex-col"
      title={<span className="flex items-center gap-2"><FileIcon entry={{ type: 'file', name: baseName(file.path), ext: file.path.split('.').pop().toLowerCase() }} size={15} />{baseName(file.path)}{dirty && <span className="size-2 rounded-full bg-warn" title="Unsaved changes" />}</span>}
      subtitle={data ? `${file.path} · ${bytes(data.size)} · modified ${dateTime(data.mtime)}` : file.path}
      actions={<>
        {isMd && data?.content != null && <Tabs size="sm" value={mode} onChange={setMode} tabs={[{ id: 'preview', label: 'Preview', icon: Eye }, { id: 'split', label: 'Split', icon: Columns2 }, { id: 'edit', label: 'Edit', icon: Code2 }]} />}
        {data?.content != null && <IconButton icon={WrapText} label="Word wrap" active={wrap} onClick={() => setWrap(!wrap)} />}
        <a href={`${raw}&download=1`} className="size-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-hover" title="Download"><Download size={16} /></a>
        {data?.content != null && <Button size="sm" variant="primary" icon={Save} loading={saving} disabled={!dirty} onClick={() => save()}>Save</Button>}
      </>}>
      {!data && <div className="flex-1 flex items-center justify-center"><Spinner /></div>}
      {data?.tooLarge && <div className="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-muted"><TriangleAlert className="text-warn" />File is too large to open in the editor ({bytes(data.size)}).<a className="text-accent underline" href={`${raw}&download=1`}>Download instead</a></div>}
      {data?.binary && (
        <div className="flex-1 min-h-0 flex items-center justify-center bg-sunken dotgrid p-4">
          {mime.startsWith('image/') ? <img src={raw} alt="" className="max-w-full max-h-full object-contain rounded-lg shadow-af" />
            : mime === 'application/pdf' ? <iframe title="pdf" src={raw} className="w-full h-full rounded-lg bg-white" />
            : mime.startsWith('video/') ? <video src={raw} controls className="max-w-full max-h-full rounded-lg" />
            : mime.startsWith('audio/') ? <audio src={raw} controls />
            : <div className="text-sm text-muted flex flex-col items-center gap-2"><Badge>{mime}</Badge>Binary file — no preview available.</div>}
        </div>
      )}
      {data?.content != null && (
        <div className="flex-1 min-h-0 flex">
          {(!isMd || mode !== 'preview') && <div className={cx('min-w-0 h-full overflow-hidden', isMd && mode === 'split' ? 'w-1/2 border-r border-line' : 'flex-1')}>{editor}</div>}
          {isMd && mode !== 'edit' && <div className={cx('min-w-0 h-full overflow-auto px-8 py-6', mode === 'split' ? 'w-1/2' : 'flex-1')}><div className="max-w-3xl mx-auto"><Markdown className="text-[0.92rem]">{text}</Markdown></div></div>}
        </div>
      )}
    </Modal>
  );
}
