import { useState } from 'react';
import { Cpu, Plus, Star, Trash2, FlaskConical, Pencil, Timer, CalendarClock, Coins, Hash, CircleCheck, CircleX, Gauge, KeyRound, Info } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { toast } from '../lib/toast.js';
import { compact, usd, duration, dateTime } from '../lib/format.js';
import { PROVIDER_STYLE } from '../lib/icons.jsx';
import { Modal, Confirm } from '../components/Modal.jsx';
import { cx, Badge, Button, IconButton, Input, Field, Select, Toggle, Meter, useNow } from '../components/ui.jsx';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ProviderMark({ provider, size = 40 }) {
  const s = PROVIDER_STYLE[provider] || PROVIDER_STYLE.simulator;
  return (
    <span className="relative inline-flex items-center justify-center rounded-xl text-white shrink-0 shadow-sm" style={{ width: size, height: size, backgroundImage: `linear-gradient(135deg, ${s.from}, ${s.to})` }}>
      {provider === 'claude-code' || provider === 'anthropic' ? (
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.6 6.1 6.1-3.3-3.3 6.1 6.1 1.6-6.1 1.6 3.3 6.1-6.1-3.3L12 23.1l-1.6-6.1-6.1 3.3 3.3-6.1-6.1-1.6 6.1-1.6-3.3-6.1 6.1 3.3z" /></svg>
      ) : provider === 'openai' ? <Cpu size={size * 0.5} /> : <FlaskConical size={size * 0.5} />}
    </span>
  );
}

function Countdown({ to, label, icon: Icon }) {
  const now = useNow(1000);
  const ms = new Date(to) - now;
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon size={12} className="text-subtle" />
      <span className="text-muted">{label}</span>
      <span className="ml-auto tabular font-medium">{ms > 0 ? duration(ms) : 'now'}</span>
      <span className="text-subtle tabular hidden xl:inline">· {dateTime(to)}</span>
    </div>
  );
}

const toDate = (v) => (v ? new Date(Number(v) * (Number(v) < 1e12 ? 1000 : 1)) : null);
const WINDOW_LABEL = { five_hour: '5-hour window', seven_day: '7-day window', seven_day_opus: '7-day (Opus)', seven_day_sonnet: '7-day (Sonnet)' };

/** Plan limits as reported by the provider on the last run (e.g. Claude's 5-hour and 7-day windows). */
function RateLimit({ info }) {
  const now = useNow(30000);
  if (!info) return null;
  const windows = Object.entries(info.unifiedWindows || {});
  if (!windows.length) windows.push([info.rateLimitType || 'limit', info]);
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg bg-sunken border border-line">
      <div className="flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-subtle"><Gauge size={11} />Provider plan limits{info.observedAt && <span className="normal-case font-normal tracking-normal">· as of {dateTime(info.observedAt)}</span>}</div>
      {windows.map(([k, w]) => {
        const used = w.utilization != null ? Number(w.utilization) * (Number(w.utilization) <= 1 ? 100 : 1) : null;
        const reset = toDate(w.resetsAt);
        const ok = w.status === 'allowed';
        return (
          <div key={k} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              {ok ? <CircleCheck size={12} className="text-ok" /> : <CircleX size={12} className="text-warn" />}
              <span className="text-muted">{WINDOW_LABEL[k] || k.replace(/_/g, ' ')}</span>
              {used != null && <span className="tabular font-medium">{Math.round(used)}% used</span>}
              {reset && <span className="ml-auto tabular text-subtle">resets in <b className="text-fg font-medium">{duration(reset - now)}</b> · {dateTime(reset)}</span>}
            </div>
            {used != null && <div className="h-1 rounded-full bg-hover overflow-hidden"><div className={cx('h-full rounded-full', used >= 90 ? 'bg-bad' : used >= 75 ? 'bg-warn' : 'bg-series-1')} style={{ width: `${Math.min(100, used)}%` }} /></div>}
          </div>
        );
      })}
    </div>
  );
}

function ModelDialog({ open, model, onClose }) {
  const providers = PROVIDER_STYLE;
  const blank = { name: '', provider: 'claude-code', model: 'claude-sonnet-5-5', base_url: '', api_key: '', limits: { dailyTokens: 2000000, weeklyTokens: 10000000, dailyPrompts: 400, weeklyPrompts: 2000, resetHour: 0, weeklyResetDay: 1 }, config: { effort: '' } };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  if (open && last !== (model?.id || 'new')) { setLast(model?.id || 'new'); setF(model ? { ...blank, ...model, api_key: '', limits: { ...blank.limits, ...model.limits }, config: { ...blank.config, ...model.config } } : blank); }
  if (!open && last) setLast(null);
  const L = (k, v) => setF({ ...f, limits: { ...f.limits, [k]: v === '' ? 0 : Number(v) } });
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, provider: f.provider, model: f.model, base_url: f.base_url || null, limits: f.limits, config: f.config, ...(f.api_key ? { api_key: f.api_key } : {}) };
      if (model) await api.patch(`/api/models/${model.id}`, body); else await api.post('/api/models', body);
      toast.success(model ? 'Model updated' : 'Model added');
      onClose();
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={model ? `Edit ${model.name}` : 'Add model'} icon={Cpu} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f.name || !f.model} onClick={save}>{model ? 'Save' : 'Add model'}</Button></>}>
      <div className="flex flex-col gap-5">
        {!model && (
          <Field label="Provider">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {Object.entries(providers).map(([k, p]) => (
                <button key={k} type="button" onClick={() => setF({ ...f, provider: k, model: k === 'claude-code' ? 'claude-sonnet-5-5' : k === 'anthropic' ? 'claude-sonnet-5-5' : k === 'openai' ? 'gpt-4o' : 'sim-1', base_url: k === 'openai' ? 'http://localhost:11434/v1' : '' })}
                  className={cx('flex items-center gap-2 p-2 rounded-lg border text-left', f.provider === k ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
                  <ProviderMark provider={k} size={24} /><span className="text-xs font-medium">{p.label}</span>
                </button>
              ))}
            </div>
          </Field>
        )}
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Display name"><Input value={f.name} placeholder="Claude Code · Sonnet" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Model id"><Input className="mono" value={f.model || ''} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
          {(f.provider === 'openai' || f.provider === 'anthropic') && <Field label="Base URL"><Input className="mono" value={f.base_url || ''} placeholder={f.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} onChange={(e) => setF({ ...f, base_url: e.target.value })} /></Field>}
          {(f.provider === 'openai' || f.provider === 'anthropic') && <Field label="API key" hint={model?.has_api_key ? 'A key is stored. Leave blank to keep it.' : 'Stored server-side; never sent to the browser.'}><Input icon={KeyRound} type="password" value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} /></Field>}
          {f.provider === 'claude-code' && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-[0.72rem] font-medium uppercase tracking-wider text-subtle">Permissions</span>
                <span className="min-h-8 flex items-center text-xs text-subtle">Full authority — every agent runs with bypassPermissions; no tool needs approval.</span>
              </div>
              <Field label="Effort"><Select value={f.config.effort || ''} onChange={(e) => setF({ ...f, config: { ...f.config, effort: e.target.value } })}><option value="">Model default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></Select></Field>
            </>
          )}
        </div>
        <div>
          <div className="text-[0.72rem] font-medium uppercase tracking-wider text-subtle mb-2">Budgets &amp; reset schedule (0 = unlimited)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Daily tokens"><Input type="number" min="0" value={f.limits.dailyTokens} onChange={(e) => L('dailyTokens', e.target.value)} /></Field>
            <Field label="Weekly tokens"><Input type="number" min="0" value={f.limits.weeklyTokens} onChange={(e) => L('weeklyTokens', e.target.value)} /></Field>
            <Field label="Daily prompts"><Input type="number" min="0" value={f.limits.dailyPrompts} onChange={(e) => L('dailyPrompts', e.target.value)} /></Field>
            <Field label="Weekly prompts"><Input type="number" min="0" value={f.limits.weeklyPrompts} onChange={(e) => L('weeklyPrompts', e.target.value)} /></Field>
            <Field label="Daily reset hour"><Select value={f.limits.resetHour} onChange={(e) => L('resetHour', e.target.value)}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select></Field>
            <Field label="Weekly reset day"><Select value={f.limits.weeklyResetDay} onChange={(e) => L('weeklyResetDay', e.target.value)}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ModelCard({ m, onEdit, onDelete }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const L = m.limits || {};
  const test = async () => {
    setTesting(true);
    setResult(null);
    try { setResult(await api.post(`/api/models/${m.id}/test`)); } finally { setTesting(false); }
  };
  return (
    <div className={cx('flex flex-col rounded-[var(--af-radius)] border bg-panel overflow-hidden', m.is_default ? 'border-accent/50 shadow-af' : 'border-line', !m.enabled && 'opacity-60')}>
      <div className="flex items-center gap-3 p-4 border-b border-line">
        <ProviderMark provider={m.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="font-semibold truncate">{m.name}</span>{m.is_default && <Badge tone="accent" icon={Star}>Default</Badge>}{m.provider === 'claude-code' && !m.is_default && <Badge>Recommended</Badge>}</div>
          <div className="text-xs text-subtle mono truncate">{m.provider_label} · {m.model}{m.can_edit ? ' · can edit files' : ' · text only'}</div>
        </div>
        <Toggle checked={m.enabled} onChange={(v) => api.patch(`/api/models/${m.id}`, { enabled: v })} />
      </div>
      <div className="p-4 grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-subtle">Today</div>
          <Meter label="Tokens" icon={Coins} used={m.usage.daily.tokens} limit={L.dailyTokens} format={compact} />
          <Meter label="Prompts" icon={Hash} used={m.usage.daily.prompts} limit={L.dailyPrompts} />
          <Countdown to={m.usage.daily.resetAt} label={`Daily reset (${String(L.resetHour ?? 0).padStart(2, '0')}:00)`} icon={Timer} />
        </div>
        <div className="flex flex-col gap-3">
          <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-subtle">This week</div>
          <Meter label="Tokens" icon={Coins} used={m.usage.weekly.tokens} limit={L.weeklyTokens} format={compact} />
          <Meter label="Prompts" icon={Hash} used={m.usage.weekly.prompts} limit={L.weeklyPrompts} />
          <Countdown to={m.usage.weekly.resetAt} label={`Weekly reset (${DAYS[L.weeklyResetDay ?? 1].slice(0, 3)})`} icon={CalendarClock} />
        </div>
      </div>
      <div className="px-4 pb-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.7rem] text-subtle">
          <span>All time: <b className="text-fg tabular">{compact(m.usage.total.tokens)}</b> tokens · <b className="text-fg tabular">{m.usage.total.prompts}</b> prompts</span>
          <span>Cache reads this week: <b className="text-fg tabular">{compact(m.usage.weekly.cache)}</b></span>
          {m.usage.weekly.cost > 0 && <span>Reported cost this week: <b className="text-fg tabular">{usd(m.usage.weekly.cost)}</b></span>}
        </div>
        <RateLimit info={m.rate_limit} />
        {result && (
          <div className={cx('flex items-start gap-2 text-xs px-2.5 py-2 rounded-lg', result.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad')}>
            {result.ok ? <CircleCheck size={13} className="mt-0.5" /> : <CircleX size={13} className="mt-0.5" />}
            <span className="break-all">{result.ok ? `Responded "${result.text}" in ${duration(result.ms)}` : result.error}</span>
          </div>
        )}
      </div>
      <div className="mt-auto flex items-center gap-1 px-3 py-2 border-t border-line bg-sunken/40">
        <Button size="sm" variant="ghost" icon={FlaskConical} loading={testing} onClick={test}>Test</Button>
        {!m.is_default && <Button size="sm" variant="ghost" icon={Star} onClick={() => api.post(`/api/models/${m.id}/default`)}>Make default</Button>}
        <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit}>Edit</Button>
        <IconButton icon={Trash2} tone="danger" label="Delete model" className="ml-auto" onClick={onDelete} />
      </div>
    </div>
  );
}

export default function Models({ layout }) {
  const models = useStore((s) => s.models);
  const [dialog, setDialog] = useState(null);
  const [del, setDel] = useState(null);
  return (
    <div className={cx('h-full overflow-auto', layout.floating && 'p-1.5')}>
      <div className="p-4 flex flex-col gap-4 max-w-[1500px]">
        <div className="flex items-center gap-3">
          <Cpu size={18} className="text-subtle" />
          <div>
            <div className="font-semibold text-[0.95rem]">Model Manager</div>
            <div className="text-xs text-muted">Claude Code is the recommended standard: agents get real file and tool access. Other providers answer in text.</div>
          </div>
          <Button variant="primary" icon={Plus} className="ml-auto" onClick={() => setDialog({})}>Add model</Button>
        </div>
        <div className="flex items-start gap-2 text-xs text-muted p-3 rounded-lg border border-line bg-panel">
          <Info size={13} className="mt-0.5 shrink-0 text-info" />
          <span>Budgets are enforced by AgentForge before each run (tokens = input + output; cache reads shown separately). Provider-side limits reported by Claude Code appear on each card after its first run.</span>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {models.map((m) => <ModelCard key={m.id} m={m} onEdit={() => setDialog({ model: m })} onDelete={() => setDel(m)} />)}
        </div>
      </div>
      <ModelDialog open={!!dialog} model={dialog?.model} onClose={() => setDialog(null)} />
      <Confirm open={!!del} title={`Delete ${del?.name}?`} danger confirmLabel="Delete" body="Agents assigned to this model fall back to the default model. Usage history is kept." onConfirm={() => api.del(`/api/models/${del.id}`)} onClose={() => setDel(null)} />
    </div>
  );
}

