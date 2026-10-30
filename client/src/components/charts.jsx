import { useState } from 'react';
import { CircleCheck, CircleX, Table2, BarChart3 } from 'lucide-react';
import { compact } from '../lib/format.js';
import { cx } from './ui.jsx';

// Status colors for task outcomes (state, not identity) — always paired with icon + label.
const OK = 'var(--af-ok)';
const BAD = 'var(--af-bad)';

function Tooltip({ x, y, children }) {
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full px-2.5 py-1.5 rounded-lg border border-line bg-raised shadow-af text-xs whitespace-nowrap" style={{ left: x, top: y - 8 }}>
      {children}
    </div>
  );
}

/** Daily tasks done (bottom) and failed (top) as stacked bars, one y-axis. */
export function ThroughputChart({ data }) {
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const W = 560;
  const H = 168;
  const pad = { l: 28, r: 6, t: 10, b: 22 };
  const max = Math.max(4, ...data.map((d) => d.done + d.failed));
  const ticks = [0, Math.ceil(max / 2), max];
  const bw = (W - pad.l - pad.r) / data.length;
  const barW = Math.min(22, bw - 6);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: OK }} /><CircleCheck size={12} />Done</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: BAD }} /><CircleX size={12} />Failed</span>
        <button className="ml-auto flex items-center gap-1 text-subtle hover:text-fg" onClick={() => setTable(!table)}>
          {table ? <BarChart3 size={12} /> : <Table2 size={12} />}{table ? 'Chart' : 'Table'}
        </button>
      </div>
      {table ? (
        <div className="max-h-[168px] overflow-auto text-xs">
          <table className="w-full tabular"><thead className="text-subtle"><tr><th className="text-left font-medium py-1">Day</th><th className="text-right font-medium">Done</th><th className="text-right font-medium">Failed</th><th className="text-right font-medium">Tokens</th></tr></thead>
            <tbody>{data.map((d) => <tr key={d.day} className="border-t border-line"><td className="py-1">{d.day}</td><td className="text-right">{d.done}</td><td className="text-right">{d.failed}</td><td className="text-right">{compact(d.tokens)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="relative" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Tasks completed and failed per day, last 14 days">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--af-line)" strokeDasharray={t ? '2 4' : undefined} />
                <text x={pad.l - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--af-subtle)" className="tabular">{t}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx0 = pad.l + bw * i + bw / 2;
              const yDone = y(d.done);
              const yTop = y(d.done + d.failed);
              const base = y(0);
              const gap = d.done && d.failed ? 2 : 0;
              return (
                <g key={d.day}>
                  <rect x={pad.l + bw * i} y={pad.t} width={bw} height={H - pad.t - pad.b} fill={hover?.i === i ? 'var(--af-hover)' : 'transparent'} onMouseEnter={() => setHover({ i, x: cx0, y: yTop })} />
                  {d.done > 0 && <path d={roundedTop(cx0 - barW / 2, yDone, barW, base - yDone, d.failed ? 0 : 4)} fill={OK} pointerEvents="none" />}
                  {d.failed > 0 && <path d={roundedTop(cx0 - barW / 2, yTop, barW, yDone - yTop - gap, 4)} fill={BAD} pointerEvents="none" />}
                  {i % 2 === (data.length - 1) % 2 && <text x={cx0} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--af-subtle)">{d.day}</text>}
                </g>
              );
            })}
          </svg>
          {hover && (() => {
            const d = data[hover.i];
            return (
              <Tooltip x={`${(hover.x / W) * 100}%`} y={(hover.y / H) * 100 + '%'}>
                <div className="font-medium text-fg mb-0.5">{d.day}</div>
                <div className="flex items-center gap-1.5 text-muted"><CircleCheck size={11} className="text-ok" />Done <b className="ml-auto pl-3 text-fg tabular">{d.done}</b></div>
                <div className="flex items-center gap-1.5 text-muted"><CircleX size={11} className="text-bad" />Failed <b className="ml-auto pl-3 text-fg tabular">{d.failed}</b></div>
              </Tooltip>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function roundedTop(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** Single-series sparkline (sequential hue) with crosshair tooltip. */
export function Sparkline({ values, labels, height = 34, format = compact }) {
  const [hover, setHover] = useState(null);
  const W = 200;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length === 1 ? W / 2 : (i / (values.length - 1)) * W, height - 3 - (v / max) * (height - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left) / r.width) * (values.length - 1));
        setHover(Math.max(0, Math.min(values.length - 1, i)));
      }}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="w-full block" style={{ height }} aria-hidden="true">
        <path d={`${d} L${W},${height} L0,${height} Z`} fill="var(--af-series-1)" opacity="0.12" />
        <path d={d} fill="none" stroke="var(--af-series-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover != null && <line x1={pts[hover][0]} x2={pts[hover][0]} y1="0" y2={height} stroke="var(--af-line-strong)" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hover != null && (
        <Tooltip x={`${(pts[hover][0] / W) * 100}%`} y={0}>
          <span className="text-muted">{labels?.[hover]}</span> <b className="tabular text-fg">{format(values[hover])}</b>
        </Tooltip>
      )}
    </div>
  );
}

const STATUS_ORDER = [
  ['done', 'Done', 'var(--af-ok)'], ['running', 'Running', 'var(--af-accent)'], ['proposed', 'Proposed', 'var(--af-warn)'],
  ['pending', 'Pending', 'var(--af-subtle)'], ['failed', 'Failed', 'var(--af-bad)'], ['cancelled', 'Cancelled', 'var(--af-line-strong)'],
];

/** Part-to-whole of task states: one stacked bar, direct legend with counts. */
export function StatusBar({ dist }) {
  const map = Object.fromEntries(dist.map((d) => [d.status, d.n]));
  const rows = STATUS_ORDER.filter(([k]) => map[k]).map(([k, label, color]) => ({ k, label, color, n: map[k] }));
  const total = rows.reduce((a, r) => a + r.n, 0);
  const [hover, setHover] = useState(null);
  if (!total) return <div className="text-xs text-subtle py-2">No tasks yet.</div>;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex h-2.5 gap-[2px] rounded-full overflow-hidden" onMouseLeave={() => setHover(null)}>
        {rows.map((r) => <div key={r.k} title={`${r.label}: ${r.n}`} onMouseEnter={() => setHover(r.k)} className={cx('h-full transition-opacity', hover && hover !== r.k && 'opacity-40')} style={{ flex: r.n, background: r.color }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {rows.map((r) => (
          <span key={r.k} className={cx('flex items-center gap-1.5 text-xs text-muted transition-opacity', hover && hover !== r.k && 'opacity-50')} onMouseEnter={() => setHover(r.k)} onMouseLeave={() => setHover(null)}>
            <span className="size-2 rounded-sm" style={{ background: r.color }} />{r.label}<b className="text-fg tabular">{r.n}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
