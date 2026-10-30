import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MonitorPlay, Play, Square, RotateCcw, RotateCw, Copy, Check, ExternalLink, Monitor, Tablet, Smartphone,
  SquareTerminal, ChevronDown, ChevronRight, Loader2, TriangleAlert, Settings2, Globe, ArrowDownToLine, CircleStop,
} from 'lucide-react';
import { useStore } from '../../lib/store.js';
import { copyText, clockTime, dateTime } from '../../lib/format.js';
import { toast } from '../../lib/toast.js';
import { Modal } from '../../components/Modal.jsx';
import { cx, Badge, Button, IconButton, Tabs, Empty } from '../../components/ui.jsx';

const EMPTY = [];
const TONE = { idle: 'neutral', starting: 'info', running: 'ok', exited: 'warn', error: 'bad', unavailable: 'bad', loading: 'neutral' };
const VIEWPORTS = { desktop: null, tablet: 768, mobile: 390 };
const VIEWPORT_TABS = [
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'tablet', label: 'Tablet', icon: Tablet, count: VIEWPORTS.tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone, count: VIEWPORTS.mobile },
];
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g; // colour codes and title sequences dev servers print
const CONSOLE_MIN = 72;
const PREF_KEY = 'af.preview';
const PREF_DEFAULT = { viewport: 'desktop', consoleOpen: true, consoleHeight: 180 };

function loadPref() {
  try { return { ...PREF_DEFAULT, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return PREF_DEFAULT; }
}
/** A carriage return redraws the line (progress bars): keep what was drawn last. */
const clean = (line) => String(line).replace(ANSI, '').replace(/\r+$/, '').split('\r').pop();
const Spin = ({ className, ...p }) => <Loader2 {...p} className={cx(className, 'animate-spin motion-reduce:animate-none')} />;

/** Output console: mono log that follows new lines while the user is at the bottom. */
function OutputConsole({ log, command, open, height, onToggle }) {
  const box = useRef(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const text = useMemo(() => log.map(clean).join('\n'), [log]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text, open, height]);
  const jump = () => {
    pinned.current = true;
    setAtBottom(true);
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  };
  return (
    <>
      <div className={cx('flex items-center gap-2 h-8 px-2 shrink-0 bg-panel', !open && 'border-t border-line')}>
        <button type="button" aria-expanded={open} aria-controls="preview-output" onClick={onToggle}
          className="flex items-center gap-1.5 h-6 px-1.5 rounded-md text-[0.72rem] font-semibold uppercase tracking-wider text-muted hover:text-fg hover:bg-hover shrink-0">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<SquareTerminal size={13} />Output
        </button>
        <span className="text-[0.7rem] text-subtle tabular shrink-0">{log.length} line{log.length === 1 ? '' : 's'}</span>
        {command && <span className="mono text-[0.7rem] text-subtle truncate min-w-0" title={command}>$ {command}</span>}
        {open && !atBottom && <IconButton size="sm" icon={ArrowDownToLine} label="Jump to latest output" className="ml-auto" onClick={jump} />}
      </div>
      {open && (
        <div ref={box} id="preview-output" role="log" aria-live="off" aria-label="Preview output" tabIndex={0} style={{ height }}
          className="shrink-0 overflow-auto bg-sunken"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (pinned.current !== atBottom) setAtBottom(pinned.current);
          }}>
          {log.length ? <pre className="mono text-[0.72rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] px-3 py-2 text-muted">{text}</pre>
            : <div className="px-3 py-2 text-[0.72rem] text-subtle">No output yet.</div>}
        </div>
      )}
    </>
  );
}

/**
 * Run & preview window: starts the project's dev server (or shows AgentForge itself in mode 'self') and frames it.
 * Opening only loads the session; the user presses Run. Closing leaves the process running.
 */
export function PreviewWindow({ project, onClose, onOpenSettings }) {
  const s = useStore((st) => st.previews[project.id]);
  const loadPreview = useStore((st) => st.loadPreview);
  const previewAction = useStore((st) => st.previewAction);
  const [pref, setPrefState] = useState(loadPref);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null); // start | stop | restart while its request is in flight
  const [nonce, setNonce] = useState(0); // bumped to reload the iframe
  const [frameLoading, setFrameLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const body = useRef(null);
  const primary = useRef(null);
  const drag = useRef(null);

  const setPref = (patch) => setPrefState((p) => {
    const next = { ...p, ...patch };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  const load = () => {
    setLoadError(null);
    loadPreview(project.id).catch((e) => setLoadError(e.message || 'Request failed'));
  };
  useEffect(load, [project.id]);

  const status = s?.status;
  const running = status === 'running';
  const active = running || status === 'starting';
  const self = s?.mode === 'self';
  const src = self ? '/' : `/preview/${encodeURIComponent(project.id)}/${(project.preview_path || '').replace(/^\/+/, '')}`;
  const url = new URL(src, window.location.origin).href;
  const width = VIEWPORTS[pref.viewport] ?? null;
  const log = s?.log || EMPTY;
  // Nothing to run: the server tried and found no dev/start script (and none is configured).
  const noCommand = !self && !s?.command && (status === 'error' || !!s?.error);

  const reload = () => { setNonce((n) => n + 1); setFrameLoading(true); };
  const prevStatus = useRef(status);
  useEffect(() => {
    if (running && prevStatus.current !== 'running') reload();
    prevStatus.current = status;
  }, [status]);
  // Keep keyboard focus in the dialog: on open, and when Run ↔ Stop swap under the user's focus.
  useEffect(() => {
    if (!body.current?.closest('[role="dialog"]')?.contains(document.activeElement)) primary.current?.focus();
  }, [active, !!s]);

  const act = async (action) => {
    if (busy) return;
    setBusy(action);
    try { await previewAction(project.id, action); } catch { /* the api layer already showed a toast */ } finally { setBusy(null); }
  };
  const copy = async () => {
    if (!(await copyText(url))) return toast.error('Could not copy the URL');
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const maxHeight = () => {
    const room = body.current?.clientHeight;
    return room ? Math.max(CONSOLE_MIN, room - 140) : 1200; // keep ~140px for the toolbar and frame
  };
  const resize = (h) => setPref({ consoleHeight: Math.round(Math.max(CONSOLE_MIN, Math.min(h, maxHeight()))) });
  const endDrag = () => { drag.current = null; setDragging(false); };

  const badge = status ? (status === 'exited' && s.exitCode != null ? `exited · ${s.exitCode}` : status) : loadError ? 'unavailable' : 'loading';
  const settingsLink = <button type="button" onClick={onOpenSettings} className="font-medium text-fg hover:underline focus-visible:outline-accent!">Project settings</button>;
  const runCta = <Button size="sm" variant="primary" icon={Play} loading={busy === 'start'} onClick={() => act('start')}>Run</Button>;

  // What the frame area shows while there is nothing to frame.
  let state = null;
  if (running) {
    // the iframe
  } else if (!s?.status && loadError) {
    state = <Empty icon={TriangleAlert} title="Couldn't load the preview" action={<Button size="sm" icon={RotateCw} onClick={load}>Retry</Button>}>{loadError}</Empty>;
  } else if (!s?.status) {
    state = <div className="h-full flex items-center justify-center"><Loader2 className="animate-spin text-subtle motion-reduce:animate-none" /></div>;
  } else if (status === 'starting') {
    state = <Empty icon={Spin} title="Starting…">{s.command ? <>Running <code className="mono text-fg">{s.command}</code>. </> : null}The preview opens as soon as the server answers.</Empty>;
  } else if (noCommand) {
    state = (
      <Empty icon={Settings2} title="No run command detected"
        action={<Button size="sm" variant="primary" icon={Settings2} onClick={onOpenSettings}>Open project settings</Button>}>
        {s.error ? <span className="block mb-1 text-bad">{s.error}</span> : null}
        No dev or start script was found in <span className="mono">{project.path}</span>. Set a run command (and a port, if it isn't printed) in Project settings, then press Run.
      </Empty>
    );
  } else if (status === 'error') {
    state = <Empty icon={TriangleAlert} title="The preview failed to start" action={runCta}>{s.error || 'Something went wrong.'} Check the output below or the run command in {settingsLink}.</Empty>;
  } else if (status === 'exited') {
    state = <Empty icon={CircleStop} title={`The process exited${s.exitCode != null ? ` with code ${s.exitCode}` : ''}`} action={runCta}>Check the output below, then run it again.</Empty>;
  } else {
    state = (
      <Empty icon={MonitorPlay} title="Preview is not running" action={runCta}>
        {s.command ? <>Run starts <code className="mono text-fg">{s.command}</code> and shows the result here.</>
          : <>Run starts the project's dev or start script and shows the result here, or set a command in {settingsLink}.</>}
        {' '}It keeps running after you close this window.
      </Empty>
    );
  }

  return (
    <Modal open onClose={onClose} title="Preview" icon={MonitorPlay} subtitle={project.name} size="full" bodyClass="flex flex-col overflow-hidden!">
      <div ref={body} className="flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line shrink-0">
          <span role="status" className="inline-flex"><span className="sr-only">Preview </span><Badge tone={TONE[badge.split(' ')[0]]} icon={status === 'starting' ? Spin : undefined}>{badge}</Badge></span>
          {active ? (
            <>
              <Button ref={primary} size="sm" variant="danger" icon={Square} loading={busy === 'stop'} onClick={() => act('stop')}>Stop</Button>
              <Button size="sm" icon={RotateCcw} loading={busy === 'restart'} onClick={() => act('restart')}>Restart</Button>
            </>
          ) : <Button ref={primary} size="sm" variant="primary" icon={Play} loading={busy === 'start'} onClick={() => act('start')}>Run</Button>}
          {running && s.startedAt && <span className="text-[0.7rem] text-subtle tabular" title={dateTime(s.startedAt)}>since {clockTime(s.startedAt)}</span>}
          <div className="flex-1 min-w-56 flex items-center gap-0.5 h-7 pl-2.5 pr-0.5 rounded-lg bg-sunken border border-line">
            <Globe size={13} className="text-subtle shrink-0" />
            <input readOnly value={url} aria-label="Preview URL" title={s?.url ? `Served from ${s.url}` : url} onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 h-full bg-transparent outline-none px-1.5 mono text-[0.75rem] text-muted" />
            <IconButton size="sm" icon={RotateCw} label="Reload preview" disabled={!running} onClick={reload} />
            <IconButton size="sm" icon={copied ? Check : Copy} label="Copy URL" className={copied ? 'text-ok!' : undefined} onClick={copy} />
            <IconButton size="sm" icon={ExternalLink} label="Open in new tab" disabled={!running} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} />
          </div>
          <div role="group" aria-label="Viewport">
            <Tabs size="sm" value={pref.viewport} onChange={(viewport) => setPref({ viewport })} tabs={VIEWPORT_TABS} />
          </div>
        </div>

        <div className="flex-1 min-h-0 relative overflow-auto bg-sunken">
          {running ? (
            <>
              {frameLoading && <div className="absolute inset-x-0 top-0 h-0.5 af-shimmer z-10 pointer-events-none" />}
              <iframe key={nonce} src={src} title={`${project.name} preview`} sandbox={SANDBOX} onLoad={() => setFrameLoading(false)}
                style={width ? { width } : undefined}
                className={cx('block h-full mx-auto bg-white', width ? 'border-x border-line shadow-af' : 'w-full', dragging && 'pointer-events-none')} />
            </>
          ) : state}
        </div>

        {pref.consoleOpen && (
          <div role="separator" aria-orientation="horizontal" aria-label="Resize output" aria-controls="preview-output" tabIndex={0}
            aria-valuenow={pref.consoleHeight} aria-valuemin={CONSOLE_MIN} aria-valuemax={maxHeight()}
            className="af-sep cursor-row-resize touch-none"
            onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); drag.current = { y: e.clientY, h: pref.consoleHeight }; setDragging(true); }}
            onPointerMove={(e) => { if (drag.current) resize(drag.current.h + drag.current.y - e.clientY); }}
            onPointerUp={endDrag} onLostPointerCapture={endDrag}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              resize(pref.consoleHeight + (e.key === 'ArrowUp' ? 24 : -24));
            }} />
        )}
        <OutputConsole log={log} command={s?.command} open={pref.consoleOpen} height={pref.consoleHeight} onToggle={() => setPref({ consoleOpen: !pref.consoleOpen })} />
      </div>
    </Modal>
  );
}
