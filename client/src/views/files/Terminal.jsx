import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Plus, X, TerminalSquare } from 'lucide-react';
import { useStore } from '../../lib/store.js';
import { cx, IconButton } from '../../components/ui.jsx';

const sessions = new Map(); // id -> { term, ws }

function themeFor(dark) {
  return dark
    ? { background: '#0b0b0e', foreground: '#e4e4e7', cursor: '#a5b4fc', selectionBackground: '#6366f155', black: '#18181b', brightBlack: '#52525b', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e4e4e7' }
    : { background: '#fbfbfa', foreground: '#18181b', cursor: '#4f46e5', selectionBackground: '#6366f133', black: '#18181b', brightBlack: '#71717a', red: '#dc2626', green: '#16a34a', yellow: '#a16207', blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#d4d4d8' };
}

function TermView({ id, cwd, active, dark, onExit }) {
  const ref = useRef(null);
  useEffect(() => {
    const term = new XTerm({ fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace', fontSize: 13, lineHeight: 1.25, cursorBlink: true, allowProposedApi: true, scrollback: 5000, theme: themeFor(dark) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    try { fit.fit(); } catch {}
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?cwd=${encodeURIComponent(cwd || '')}&cols=${term.cols}&rows=${term.rows}`);
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => { term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n'); onExit?.(); };
    const sub = term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data: d })));
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
    ro.observe(ref.current);
    sessions.set(id, { term, ws, fit });
    return () => { ro.disconnect(); sub.dispose(); ws.close(); term.dispose(); sessions.delete(id); };
  }, [id]);
  useEffect(() => { const s = sessions.get(id); if (s) s.term.options.theme = themeFor(dark); }, [dark]);
  useEffect(() => { if (active) setTimeout(() => { const s = sessions.get(id); try { s?.fit.fit(); } catch {} s?.term.focus(); }, 30); }, [active]);
  return <div ref={ref} className={cx('absolute inset-0', !active && 'invisible')} />;
}

/** Sends a one-time cd to a terminal (used by the file manager's "Open terminal here"). */
export function terminalCd(id, path) {
  const s = sessions.get(id);
  if (s?.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'input', data: ` cd -- '${path.replace(/'/g, "'\\''")}'\r` }));
}

/** `cwd` only seeds new tabs; folder navigation never sends input to the shell. */
export function TerminalPanel({ cwd }) {
  const theme = useStore((s) => s.theme);
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const [tabs, setTabs] = useState(() => [{ id: `t${Date.now()}`, cwd, n: 1 }]);
  const [active, setActive] = useState(tabs[0].id);

  useEffect(() => {
    const on = (e) => e.detail && terminalCd(active, e.detail);
    window.addEventListener('af:terminal-cd', on);
    return () => window.removeEventListener('af:terminal-cd', on);
  }, [active]);

  const add = () => {
    const t = { id: `t${Date.now()}`, cwd, n: Math.max(0, ...tabs.map((x) => x.n)) + 1 };
    setTabs([...tabs, t]);
    setActive(t.id);
  };
  const close = (id) => {
    const next = tabs.filter((t) => t.id !== id);
    if (!next.length) { const t = { id: `t${Date.now()}`, cwd, n: 1 }; setTabs([t]); setActive(t.id); return; }
    setTabs(next);
    if (active === id) setActive(next[next.length - 1].id);
  };
  return (
    <div className="h-full flex flex-col bg-sunken">
      <div className="flex items-center gap-1 h-9 px-2 border-b border-line shrink-0 overflow-x-auto">
        <TerminalSquare size={14} className="text-subtle mx-1 shrink-0" />
        {tabs.map((t) => (
          <div key={t.id} onClick={() => setActive(t.id)} className={cx('group flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-md text-xs cursor-pointer shrink-0', active === t.id ? 'bg-panel text-fg border border-line' : 'text-muted hover:bg-hover')}>
            <span>bash {t.n}</span>
            <button onClick={(e) => { e.stopPropagation(); close(t.id); }} className="size-4 rounded flex items-center justify-center text-subtle hover:text-fg hover:bg-hover"><X size={11} /></button>
          </div>
        ))}
        <IconButton icon={Plus} size="sm" label="New terminal" onClick={add} />
      </div>
      <div className="relative flex-1 min-h-0">
        {tabs.map((t) => <TermView key={t.id} id={t.id} cwd={t.cwd} active={active === t.id} dark={dark} />)}
      </div>
    </div>
  );
}
