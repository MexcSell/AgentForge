import { forwardRef, useEffect, useState } from 'react';
import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';
import { roleStyle, RoleIcon } from '../lib/icons.jsx';

export const cx = clsx;

const BTN = {
  primary: 'grad-accent text-accent-fg shadow-sm hover:brightness-110 border border-transparent',
  secondary: 'bg-raised text-fg border border-line hover:border-line-strong hover:bg-hover',
  ghost: 'text-muted hover:text-fg hover:bg-hover border border-transparent',
  danger: 'bg-bad-soft text-bad border border-transparent hover:bg-bad hover:text-white',
  outline: 'border border-line text-fg hover:bg-hover',
};

export const Button = forwardRef(function Button({ variant = 'secondary', size = 'md', icon: Icon, loading, className, children, ...rest }, ref) {
  const sz = size === 'sm' ? 'h-7 px-2.5 text-xs gap-1.5' : size === 'lg' ? 'h-10 px-4 text-sm gap-2' : 'h-8 px-3 text-[0.82rem] gap-1.5';
  return (
    <button ref={ref} className={cx('inline-flex items-center justify-center rounded-lg font-medium transition-all duration-150 select-none whitespace-nowrap disabled:opacity-45 disabled:pointer-events-none active:scale-[0.98]', BTN[variant], sz, className)} {...rest}>
      {loading ? <LoaderCircle size={14} className="animate-spin" /> : Icon ? <Icon size={size === 'sm' ? 13 : 15} strokeWidth={2} /> : null}
      {children}
    </button>
  );
});

const DOT = { ok: 'bg-ok', accent: 'bg-accent', warn: 'bg-warn', bad: 'bg-bad' };

/** `dot` (ok | accent | warn | bad) adds a small status dot in the top-right corner; `badge` a red counter. */
export const IconButton = forwardRef(function IconButton({ icon: Icon, label, active, size = 'md', className, badge, dot, tone, ...rest }, ref) {
  const sz = size === 'sm' ? 'size-6' : size === 'lg' ? 'size-9' : 'size-7';
  return (
    <button ref={ref} title={label} aria-label={label} className={cx('relative inline-flex items-center justify-center rounded-md transition-colors shrink-0 disabled:opacity-40 disabled:pointer-events-none', sz,
      active ? 'bg-accent-soft text-accent' : tone === 'danger' ? 'text-muted hover:text-bad hover:bg-bad-soft' : 'text-muted hover:text-fg hover:bg-hover', className)} {...rest}>
      <Icon size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} strokeWidth={1.9} />
      {badge ? <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10px] font-semibold leading-4 text-center tabular">{badge > 99 ? '99+' : badge}</span>
        : dot ? <span aria-hidden="true" data-dot={dot} className={cx('absolute top-0.5 right-0.5 size-2 rounded-full ring-2 ring-[var(--af-panel)]', DOT[dot] || DOT.ok)} /> : null}
    </button>
  );
});

export const Input = forwardRef(function Input({ className, icon: Icon, right, ...rest }, ref) {
  return (
    <div className={cx('relative flex items-center', className)}>
      {Icon && <Icon size={14} className="absolute left-2.5 text-subtle pointer-events-none" />}
      <input ref={ref} className={cx('w-full h-8 rounded-lg bg-sunken border border-line px-2.5 text-[0.85rem] text-fg placeholder:text-subtle outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent-soft', Icon && 'pl-8', right && 'pr-9')} {...rest} />
      {right && <div className="absolute right-1">{right}</div>}
    </div>
  );
});

export const Textarea = forwardRef(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx('w-full rounded-lg bg-sunken border border-line px-2.5 py-2 text-[0.85rem] text-fg placeholder:text-subtle outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent-soft resize-none', className)} {...rest} />;
});

export function Select({ className, children, ...rest }) {
  return (
    <select className={cx('h-8 rounded-lg bg-sunken border border-line px-2 text-[0.85rem] text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft', className)} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('inline-flex items-center gap-2 text-[0.82rem] text-fg disabled:opacity-50', !label && 'shrink-0')}>
      <span className={cx('relative inline-flex h-[18px] w-8 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}>
        <span className={cx('absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[16px]' : 'translate-x-[2px]')} />
      </span>
      {label}
    </button>
  );
}

export function Field({ label, hint, children, className }) {
  return (
    <label className={cx('flex flex-col gap-1.5', className)}>
      <span className="text-[0.72rem] font-medium uppercase tracking-wider text-subtle">{label}</span>
      {children}
      {hint && <span className="text-xs text-subtle">{hint}</span>}
    </label>
  );
}

const TONES = {
  neutral: 'bg-hover text-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export function Badge({ tone = 'neutral', className, children, icon: Icon }) {
  return (
    <span className={cx('inline-flex items-center gap-1 h-5 px-1.5 rounded-md border text-[0.7rem] font-medium whitespace-nowrap', TONES[tone], className)}>
      {Icon && <Icon size={11} strokeWidth={2.2} />}
      {children}
    </span>
  );
}

export const STATUS_TONE = { idle: 'neutral', working: 'accent', running: 'accent', planning: 'info', waiting: 'warn', blocked: 'bad', done: 'ok', failed: 'bad', cancelled: 'neutral', pending: 'neutral', proposed: 'warn', offline: 'neutral' };

export function StatusDot({ status, className }) {
  const color = { online: 'bg-ok', working: 'bg-accent', running: 'bg-accent', busy: 'bg-info', planning: 'bg-info', degraded: 'bg-warn', restarting: 'bg-warn', down: 'bg-bad', failed: 'bg-bad', done: 'bg-ok', idle: 'bg-subtle', offline: 'bg-subtle' }[status] || 'bg-subtle';
  const pulse = ['working', 'running', 'busy', 'planning', 'restarting'].includes(status);
  return <span className={cx('relative inline-flex size-2 shrink-0 rounded-full', color, className)}>{pulse && <span className={cx('absolute inset-0 rounded-full animate-ping opacity-60', color)} />}</span>;
}

export function Kbd({ children }) {
  return <kbd className="inline-flex items-center h-[18px] px-1.5 rounded border border-line bg-sunken text-[10px] font-medium text-subtle mono">{children}</kbd>;
}

export function Spinner({ size = 14, className }) {
  return <LoaderCircle size={size} className={cx('animate-spin text-accent', className)} />;
}

export function Progress({ value = 0, tone = 'accent', className, striped }) {
  const bar = { accent: 'grad-accent', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', series: 'bg-series-1' }[tone];
  return (
    <div className={cx('h-1.5 w-full rounded-full bg-hover overflow-hidden', className)} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-[width] duration-500', bar, striped && 'af-stripes')} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function AgentAvatar({ agent, role, size = 32, status, className }) {
  const r = role || agent?.role;
  const st = roleStyle(r);
  const s = status ?? agent?.status;
  return (
    <span className={cx('relative inline-flex shrink-0 items-center justify-center rounded-[28%] text-white shadow-sm', className)}
      style={{ width: size, height: size, backgroundImage: `linear-gradient(135deg, ${st.from}, ${st.to})` }}>
      <RoleIcon role={r} size={Math.round(size * 0.52)} />
      {s && s !== 'idle' && (
        <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full p-[2px] bg-panel"><StatusDot status={s} /></span>
      )}
    </span>
  );
}

export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-6 text-muted h-full">
      {Icon && <div className="size-11 rounded-xl bg-hover flex items-center justify-center mb-1"><Icon size={20} className="text-subtle" /></div>}
      <div className="text-sm font-medium text-fg">{title}</div>
      {children && <div className="text-xs max-w-xs leading-relaxed">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PanelHeader({ icon: Icon, title, count, children, className }) {
  return (
    <div className={cx('flex items-center gap-2 h-10 px-3 border-b border-line shrink-0', className)}>
      {Icon && <Icon size={15} className="text-subtle" />}
      <span className="text-[0.72rem] font-semibold uppercase tracking-wider text-muted truncate">{title}</span>
      {count != null && <span className="text-[0.7rem] font-semibold text-subtle tabular">{count}</span>}
      <div className="ml-auto flex items-center gap-0.5">{children}</div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange, className, size = 'md' }) {
  return (
    <div className={cx('inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-sunken border border-line', className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('inline-flex items-center gap-1.5 rounded-md font-medium transition-all', size === 'sm' ? 'h-6 px-2 text-[0.72rem]' : 'h-7 px-2.5 text-[0.78rem]',
            value === t.id ? 'bg-raised text-fg shadow-sm border border-line' : 'text-muted hover:text-fg border border-transparent')}>
          {t.icon && <t.icon size={13} />}
          {t.label}
          {t.count != null && <span className={cx('tabular text-[0.68rem]', value === t.id ? 'text-accent' : 'text-subtle')}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Meter for usage vs. a limit: single sequential hue; status color + icon only past thresholds. */
export function Meter({ label, used, limit, format = (n) => n, icon: Icon }) {
  const p = limit ? Math.min(100, (used / limit) * 100) : 0;
  const tone = p >= 100 ? 'bad' : p >= 80 ? 'warn' : 'series';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        {Icon && <Icon size={12} className="text-subtle self-center" />}
        <span className="text-muted">{label}</span>
        <span className="ml-auto tabular text-fg font-medium">{format(used)}</span>
        <span className="tabular text-subtle">/ {limit ? format(limit) : '∞'}</span>
      </div>
      <Progress value={limit ? p : 0} tone={tone} />
      {p >= 80 && <span className={cx('text-[0.68rem] font-medium', p >= 100 ? 'text-bad' : 'text-warn')}>{p >= 100 ? '■ Limit reached' : '▲ Above 80% of limit'}</span>}
    </div>
  );
}
