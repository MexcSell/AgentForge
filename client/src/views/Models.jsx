import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Plus, Star, Trash2, FlaskConical, Pencil, Timer, CalendarClock, Coins, Hash, CircleCheck, CircleX, Gauge, KeyRound, Info, SquareTerminal, Sparkles, Search, RefreshCw, Route, History, X, Zap, Wind, Shapes, CircuitBoard } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { isAdmin } from '../lib/access.js';
import { toast } from '../lib/toast.js';
import { compact, usd, duration, dateTime } from '../lib/format.js';
import { PROVIDER_STYLE } from '../lib/icons.jsx';
import { SORTS, pickList, perM, ctx } from '../lib/openrouter.js';
import { CLAUDE_MODELS, SESSION_ID } from '../lib/claude.js';
import { Modal, Confirm } from '../components/Modal.jsx';
import { cx, Badge, Button, IconButton, Input, Field, Select, Toggle, Meter, useNow } from '../components/ui.jsx';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MARK_ICON = { codex: SquareTerminal, gpt: Sparkles, openai: Cpu, openrouter: Route, groq: Zap, mistral: Wind, cohere: Shapes, sambanova: CircuitBoard };
/** Model id / base URL pre-filled when a provider tile is picked. */
const PRESETS = {
  'claude-code': { model: 'claude-sonnet-5-5', base_url: '' },
  codex: { model: 'gpt-6-luna', base_url: '' },
  anthropic: { model: 'claude-sonnet-5-5', base_url: '' },
  gpt: { model: 'gpt-6-luna', base_url: '' },
  openai: { model: 'gpt-4o', base_url: 'http://localhost:11434/v1' },
  openrouter: { model: 'openrouter/free', base_url: '' },
  groq: { model: 'openai/gpt-oss-120b', base_url: '' },
  mistral: { model: 'mistral-large-4', base_url: '' },
  cohere: { model: 'command-a-03-2025', base_url: '' },
  sambanova: { model: 'gpt-oss-120b', base_url: '' },
  simulator: { model: 'sim-1', base_url: '' },
};
/** Server environment variable that holds the key of a provider, when it has one. */
const ENV_KEY = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY', mistral: 'MISTRAL_API_KEY', cohere: 'COHERE_API_KEY', sambanova: 'SAMBANOVA_API_KEY' };
/** Picking a listed model saves its prices with the model: the card shows them, and Groq runs are costed from them. */
const PRICED = ['openrouter', 'groq', 'sambanova'];
const pricingOf = (m) => ({ prompt: m.prompt, completion: m.completion, free: m.free, variable: m.variable });

function ProviderMark({ provider, size = 40 }) {
  const s = PROVIDER_STYLE[provider] || PROVIDER_STYLE.simulator;
  const Icon = MARK_ICON[provider] || FlaskConical;
  return (
    <span className="relative inline-flex items-center justify-center rounded-xl text-white shrink-0 shadow-sm" style={{ width: size, height: size, backgroundImage: `linear-gradient(135deg, ${s.from}, ${s.to})` }}>
      {provider === 'claude-code' || provider === 'anthropic' ? (
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.6 6.1 6.1-3.3-3.3 6.1 6.1 1.6-6.1 1.6 3.3 6.1-6.1-3.3L12 23.1l-1.6-6.1-6.1 3.3 3.3-6.1-6.1-1.6 6.1-1.6-3.3-6.1 6.1 3.3z" /></svg>
      ) : <Icon size={size * 0.5} />}
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

/** Prices per 1M tokens as "in $x · out $y", or "free" / "varies". */
const priceLabel = (p) => (p.free ? 'free' : p.variable ? 'price varies' : `in ${perM(p.prompt)} · out ${perM(p.completion)} /1M`);

/** One pickable model: name, id (and a note), context size and price per 1M tokens (none for Mistral's and Cohere's unpriced lists). */
function ModelOption({ m, selected, onPick }) {
  return (
    <button type="button" role="option" aria-selected={selected} onClick={() => onPick(m)}
      className={cx('flex items-center gap-3 px-2 py-1.5 rounded-md text-left', selected ? 'bg-accent-soft' : 'hover:bg-hover')}>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium truncate">{m.name}{m.note && <span className="font-normal text-subtle"> · {m.note}</span>}</span>
        <span className="block text-[0.7rem] text-subtle mono truncate">{m.id}</span>
      </span>
      <span className="shrink-0 text-[0.7rem] text-subtle tabular hidden sm:inline">{ctx(m.context)} ctx</span>
      {m.free ? <Badge tone="ok">free</Badge>
        : m.prompt === undefined ? null
        : <span className="shrink-0 text-[0.7rem] tabular text-muted text-right">{m.variable ? 'varies' : <>{perM(m.prompt)} in · {perM(m.completion)} out</>}</span>}
    </button>
  );
}

/** The Claude models for Claude Code and the Anthropic API: current ones first, then older ones that are still served. */
function ClaudePicker({ value, onPick }) {
  const [older, setOlder] = useState(() => CLAUDE_MODELS.some((m) => m.older && m.id === value));
  const list = CLAUDE_MODELS.filter((m) => older || !m.older);
  return (
    <div className="md:col-span-2 flex flex-col gap-2 rounded-lg border border-line p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
        <span className="flex-1">Claude models · Anthropic API prices per 1M tokens</span>
        <Toggle checked={older} onChange={setOlder} label="Older models" />
      </div>
      <div className="flex flex-col gap-0.5" role="listbox" aria-label="Claude models">
        {list.map((m) => <ModelOption key={m.id} m={m} selected={value === m.id} onPick={onPick} />)}
      </div>
    </div>
  );
}

/**
 * A value kept on the server (API key, Claude Code session id), entered the same way for both: type a new value to
 * replace the stored one, leave it blank to keep it, or remove it with the × button.
 */
function StoredField({ label, icon, secret, stored, storedHint, hint, value, onChange, removed, onRemove, error, placeholder }) {
  return (
    <Field label={label} hint={error ? <span className="text-bad">{error}</span> : removed ? 'Removed when you save.' : stored ? `${storedHint} Type a new one to replace it, or leave blank to keep it.` : hint}>
      <Input icon={icon} type={secret ? 'password' : 'text'} className={secret ? undefined : 'mono'} value={value} placeholder={placeholder} aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        right={stored && !removed ? <IconButton icon={X} size="sm" label={`Remove the stored ${label}`} onClick={(e) => { e.preventDefault(); onRemove(); }} /> : null} />
    </Field>
  );
}

/** Every OpenRouter model, searchable, sortable by price, with a free-only filter. Picking one fills the Model id. */
function OpenRouterPicker({ value, onPick }) {
  const [state, setState] = useState({ models: null, error: null, loading: true });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('free');
  const [freeOnly, setFreeOnly] = useState(false);
  const load = (refresh) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    return api.get(`/api/openrouter/models${refresh ? '?refresh=1' : ''}`, { quiet: true })
      .then((r) => setState({ models: r.models || [], error: null, loading: false }), (e) => setState((s) => ({ ...s, error: e.message, loading: false })));
  };
  useEffect(() => { load(false); }, []);
  const all = state.models || [];
  const list = useMemo(() => pickList(all, { query, freeOnly, sort }), [all, query, freeOnly, sort]);
  const free = useMemo(() => all.filter((m) => m.free).length, [all]);
  return (
    <div className="md:col-span-2 flex flex-col gap-2 rounded-lg border border-line p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input icon={Search} className="flex-1 min-w-48" value={query} placeholder="Search OpenRouter models" aria-label="Search OpenRouter models" onChange={(e) => setQuery(e.target.value)} />
        <Select value={sort} aria-label="Sort OpenRouter models" onChange={(e) => setSort(e.target.value)}>{Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Toggle checked={freeOnly} onChange={setFreeOnly} label="Free only" />
        <IconButton icon={RefreshCw} label="Reload the model list" disabled={state.loading} onClick={() => load(true)} />
      </div>
      <div className="text-xs text-subtle">
        {state.error ? <span className="text-bad">{state.error}. Type the model id above instead.</span>
          : state.models ? <>{list.length} of {all.length} models · {free} free · prices per 1M tokens</> : 'Loading the OpenRouter model list…'}
      </div>
      {list.length > 0 && (
        <div className="max-h-72 overflow-auto -mx-1 px-1 flex flex-col gap-0.5" role="listbox" aria-label="OpenRouter models">
          {list.map((m) => <ModelOption key={m.id} m={m} selected={value === m.id} onPick={onPick} />)}
        </div>
      )}
    </div>
  );
}

// Groq has no free models, so its sort menu leaves out "Free first"; Mistral's and Cohere's lists have no prices (or useful dates).
const GROQ_SORTS = Object.fromEntries(Object.entries(SORTS).filter(([k]) => k !== 'free'));
const MISTRAL_SORTS = { name: SORTS.name, context: SORTS.context };
/** Providers whose model list needs a key: the API route, a whole typed key (reloads the list), sorts and the list footer. */
const KEYED_CATALOG = {
  groq: { label: 'Groq', url: '/api/groq/models', key: /^gsk_[A-Za-z0-9]{40,}$/, sorts: GROQ_SORTS, sort: 'cheap', unit: 'prices per 1M tokens' },
  mistral: { label: 'Mistral', url: '/api/mistral/models', key: /^(mstrl_[A-Za-z0-9_-]{30,}|[A-Za-z0-9]{32})$/, sorts: MISTRAL_SORTS, sort: 'name', unit: 'Mistral lists no prices' },
  // Cohere does not document its key format; its keys are 40 letters and digits (the reload button works for any key).
  cohere: { label: 'Cohere', url: '/api/cohere/models', key: /^[A-Za-z0-9]{40}$/, sorts: MISTRAL_SORTS, sort: 'name', unit: 'Cohere lists no prices' },
  // SambaNova's list is public (a key is sent when there is one); its keys are UUIDs.
  sambanova: { label: 'SambaNova', url: '/api/sambanova/models', key: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, sorts: GROQ_SORTS, sort: 'cheap', unit: 'prices per 1M tokens' },
};

/**
 * The chat models a Groq, Mistral, Cohere or SambaNova key can use (POST /api/<provider>/models), searchable and sortable. The list needs a
 * key: the one typed in the dialog (reloaded as soon as a whole key is typed), else the model's stored key, else the env key.
 */
function KeyedCatalogPicker({ provider, value, onPick, apiKey, modelId }) {
  const c = KEYED_CATALOG[provider];
  const [state, setState] = useState({ models: null, error: null, loading: true });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(c.sort);
  const seq = useRef(0);
  const load = (refresh) => {
    const n = ++seq.current; // only the latest request may update the list
    setState((s) => ({ ...s, loading: true, error: null }));
    return api.post(c.url, { api_key: apiKey || undefined, model_id: modelId, refresh }, { quiet: true })
      .then((r) => n === seq.current && setState({ models: r.models || [], error: null, loading: false }),
        (e) => n === seq.current && setState((s) => ({ ...s, error: e.message, loading: false })));
  };
  useEffect(() => { load(false); }, []);
  const typedKey = c.key.test(apiKey || '') ? apiKey : '';
  useEffect(() => { if (typedKey) load(true); }, [typedKey]);
  const all = state.models || [];
  const list = useMemo(() => pickList(all, { query, sort }), [all, query, sort]);
  return (
    <div className="md:col-span-2 flex flex-col gap-2 rounded-lg border border-line p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input icon={Search} className="flex-1 min-w-48" value={query} placeholder={`Search ${c.label} models`} aria-label={`Search ${c.label} models`} onChange={(e) => setQuery(e.target.value)} />
        <Select value={sort} aria-label={`Sort ${c.label} models`} onChange={(e) => setSort(e.target.value)}>{Object.entries(c.sorts).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <IconButton icon={RefreshCw} label="Reload the model list" disabled={state.loading} onClick={() => load(true)} />
      </div>
      <div className="text-xs text-subtle">
        {state.error ? <span className="text-bad">{state.error}. You can also type the model id above.</span>
          : state.models ? <>{list.length} of {all.length} chat models for this key · {c.unit}</> : `Loading the ${c.label} model list…`}
      </div>
      {list.length > 0 && (
        <div className="max-h-72 overflow-auto -mx-1 px-1 flex flex-col gap-0.5" role="listbox" aria-label={`${c.label} models`}>
          {list.map((m) => <ModelOption key={m.id} m={m} selected={value === m.id} onPick={onPick} />)}
        </div>
      )}
    </div>
  );
}

function ModelDialog({ open, model, onClose, keys }) {
  const providers = PROVIDER_STYLE;
  const blank = { name: '', provider: 'claude-code', ...PRESETS['claude-code'], api_key: '', clear_api_key: false, session_id: '', clear_session: false, limits: { dailyTokens: 2000000, weeklyTokens: 10000000, dailyPrompts: 400, weeklyPrompts: 2000, resetHour: 0, weeklyResetDay: 1 }, config: { effort: '' } };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  if (open && last !== (model?.id || 'new')) { setLast(model?.id || 'new'); setF(model ? { ...blank, ...model, api_key: '', clear_api_key: false, session_id: '', clear_session: false, limits: { ...blank.limits, ...model.limits }, config: { ...blank.config, ...model.config } } : blank); }
  if (!open && last) setLast(null);
  const L = (k, v) => setF({ ...f, limits: { ...f.limits, [k]: v === '' ? 0 : Number(v) } });
  const viaHttp = ['anthropic', 'openai', 'gpt', 'openrouter', 'groq', 'mistral', 'cohere', 'sambanova'].includes(f.provider);
  const agentCli = f.provider === 'claude-code' || f.provider === 'codex';
  const envVar = ENV_KEY[f.provider];
  const isClaudeCode = f.provider === 'claude-code';
  const storedSession = model?.config?.sessionId || '';
  const sessionError = f.session_id.trim() && !SESSION_ID.test(f.session_id.trim()) ? 'A Claude Code session id is a UUID, e.g. 0f8b4c2e-1d3a-4b5c-9e6f-7a8b9c0d1e2f.' : null;
  const claudePrefix = { 'claude-code': 'Claude Code · ', anthropic: 'Anthropic API · ' }[f.provider];
  const save = async () => {
    setBusy(true);
    try {
      const sessionId = f.session_id.trim() || (f.clear_session ? '' : storedSession);
      const config = isClaudeCode ? { ...f.config, sessionId } : f.config;
      const body = { name: f.name, provider: f.provider, model: f.model, base_url: f.base_url || null, limits: f.limits, config,
        ...(f.api_key ? { api_key: f.api_key } : f.clear_api_key ? { clear_api_key: true } : {}) };
      if (model) await api.patch(`/api/models/${model.id}`, body); else await api.post('/api/models', body);
      toast.success(model ? 'Model updated' : 'Model added');
      onClose();
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={model ? `Edit ${model.name}` : 'Add model'} icon={Cpu} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f.name || !f.model || !!sessionError} onClick={save}>{model ? 'Save' : 'Add model'}</Button></>}>
      <div className="flex flex-col gap-5">
        {!model && (
          <Field label="Provider">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {Object.entries(providers).map(([k, p]) => (
                <button key={k} type="button" aria-pressed={f.provider === k} onClick={() => setF({ ...f, provider: k, ...PRESETS[k] })}
                  className={cx('flex items-center gap-2 p-2 rounded-lg border text-left', f.provider === k ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
                  <ProviderMark provider={k} size={24} /><span className="text-xs font-medium">{p.label}</span>
                </button>
              ))}
            </div>
          </Field>
        )}
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Display name"><Input value={f.name} placeholder="Claude Code · Sonnet" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Model id">
            <Input className="mono" value={f.model || ''}
              onChange={(e) => setF({ ...f, model: e.target.value, ...(PRICED.includes(f.provider) && { config: { ...f.config, pricing: null } }) })} />
          </Field>
          {claudePrefix && open && (
            <ClaudePicker value={f.model} onPick={(m) => setF({ ...f, model: m.id, name: !f.name || f.name.startsWith(claudePrefix) ? claudePrefix + m.name : f.name })} />
          )}
          {f.provider === 'openrouter' && open && (
            <OpenRouterPicker value={f.model} onPick={(m) => setF({ ...f, model: m.id, name: !f.name || f.name.startsWith('OpenRouter · ') ? `OpenRouter · ${m.name}` : f.name,
              config: { ...f.config, pricing: pricingOf(m) } })} />
          )}
          {f.provider === 'groq' && open && (
            <KeyedCatalogPicker provider="groq" value={f.model} apiKey={f.api_key.trim()} modelId={model?.id}
              onPick={(m) => setF({ ...f, model: m.id, name: !f.name || f.name.startsWith('Groq · ') ? `Groq · ${m.name}` : f.name, config: { ...f.config, pricing: pricingOf(m) } })} />
          )}
          {f.provider === 'mistral' && open && (
            <KeyedCatalogPicker provider="mistral" value={f.model} apiKey={f.api_key.trim()} modelId={model?.id}
              onPick={(m) => setF({ ...f, model: m.id, name: !f.name || f.name.startsWith('Mistral · ') ? `Mistral · ${m.name}` : f.name })} />
          )}
          {f.provider === 'cohere' && open && (
            <KeyedCatalogPicker provider="cohere" value={f.model} apiKey={f.api_key.trim()} modelId={model?.id}
              onPick={(m) => setF({ ...f, model: m.id, name: !f.name || f.name.startsWith('Cohere · ') ? `Cohere · ${m.name}` : f.name })} />
          )}
          {f.provider === 'sambanova' && open && (
            <KeyedCatalogPicker provider="sambanova" value={f.model} apiKey={f.api_key.trim()} modelId={model?.id}
              onPick={(m) => setF({ ...f, model: m.id, name: !f.name || f.name.startsWith('SambaNova · ') ? `SambaNova · ${m.name}` : f.name, config: { ...f.config, pricing: pricingOf(m) } })} />
          )}
          {viaHttp && <Field label="Base URL"><Input className="mono" value={f.base_url || ''} placeholder={{ anthropic: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai/api/v1', groq: 'https://api.groq.com/openai/v1', mistral: 'https://api.mistral.ai/v1', cohere: 'https://api.cohere.ai/compatibility/v1', sambanova: 'https://api.sambanova.ai/v1' }[f.provider] || 'https://api.openai.com/v1'} onChange={(e) => setF({ ...f, base_url: e.target.value })} /></Field>}
          {(viaHttp || isClaudeCode) && (
            <StoredField label="API key" icon={KeyRound} secret value={f.api_key} stored={model?.has_api_key} storedHint="A key is stored (never shown)."
              removed={f.clear_api_key} onRemove={() => setF({ ...f, clear_api_key: true })} onChange={(v) => setF({ ...f, api_key: v, clear_api_key: false })}
              placeholder={isClaudeCode || f.provider === 'anthropic' ? 'sk-ant-…' : f.provider === 'openrouter' ? 'sk-or-v1-…' : f.provider === 'groq' ? 'gsk_…' : f.provider === 'mistral' ? 'mstrl_…' : ''}
              hint={isClaudeCode ? `Optional. Claude Code runs authenticate with it instead of the server's ANTHROPIC_API_KEY${keys?.ANTHROPIC_API_KEY ? ` (${keys.ANTHROPIC_API_KEY})` : ''} or the claude CLI login. Stored server-side; never sent to the browser.`
                : f.provider === 'gpt' ? 'Stored server-side; never sent to the browser. Without a stored key, OPENAI_API_KEY is used.'
                : envVar ? `Optional. Without a stored key, the server's ${envVar} is used${keys?.[envVar] ? ` (${keys[envVar]})` : ''}.` : 'Stored server-side; never sent to the browser.'} />
          )}
          {isClaudeCode && (
            <StoredField label="Session ID" icon={History} value={f.session_id} stored={!!storedSession} storedHint={`Saved: ${storedSession}.`}
              removed={f.clear_session} onRemove={() => setF({ ...f, clear_session: true })} onChange={(v) => setF({ ...f, session_id: v, clear_session: false })}
              error={sessionError} placeholder="Claude Code session id (UUID)"
              hint="Optional. Agent task runs without a session of their own start from this Claude Code conversation (forked, so it stays as it is). It must belong to the agent's project folder; otherwise the run starts fresh." />
          )}
          {agentCli && (
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

function ModelCard({ m, onEdit, onDelete, keys }) {
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
          <div className="flex items-center gap-2"><span className="font-semibold truncate">{m.name}</span>{m.is_default && <Badge tone="accent" icon={Star}>Default</Badge>}{m.can_edit && !m.is_default && <Badge>Recommended</Badge>}{m.provider === 'gpt' && !m.has_api_key && <Badge tone="warn" icon={KeyRound}>API key required</Badge>}{ENV_KEY[m.provider] && !m.has_api_key && keys?.[ENV_KEY[m.provider]] === 'missing' && <Badge tone="warn" icon={KeyRound}>{ENV_KEY[m.provider]} missing</Badge>}</div>
          <div className="text-xs text-subtle mono truncate">{m.provider_label} · {m.model}{m.can_edit ? ' · can edit files' : ' · text only'}{m.config?.pricing ? ` · ${priceLabel(m.config.pricing)}` : ''}{m.provider === 'claude-code' && m.has_api_key ? ' · own API key' : ''}{m.provider === 'claude-code' && m.config?.sessionId ? ` · session ${m.config.sessionId.slice(0, 8)}` : ''}</div>
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
  const admin = isAdmin(useStore((s) => s.me));
  const [dialog, setDialog] = useState(null);
  const [del, setDel] = useState(null);
  // { ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, COHERE_API_KEY, SAMBANOVA_API_KEY: 'set' | 'missing' } of the server; the endpoint is admin-only, so others never ask.
  const [keys, setKeys] = useState(null);
  const envKey = keys?.ANTHROPIC_API_KEY;
  useEffect(() => {
    if (!admin) return setKeys(null);
    let live = true;
    api.get('/api/models/credentials', { quiet: true }).then((c) => live && setKeys(c || null), () => {});
    return () => { live = false; };
  }, [admin]);
  return (
    <div className={cx('h-full overflow-auto', layout.floating && 'p-1.5')}>
      <div className="p-4 flex flex-col gap-4 max-w-[1500px]">
        <div className="flex items-center gap-3">
          <Cpu size={18} className="text-subtle" />
          <div>
            <div className="font-semibold text-[0.95rem]">Model Manager</div>
            <div className="text-xs text-muted">Claude Code and Codex CLI are the recommended standard: their agents get real file and tool access. Other providers answer in text.</div>
          </div>
          <Button variant="primary" icon={Plus} className="ml-auto" onClick={() => setDialog({})}>Add model</Button>
        </div>
        <div className="flex items-start gap-2 text-xs text-muted p-3 rounded-lg border border-line bg-panel">
          <Info size={13} className="mt-0.5 shrink-0 text-info" />
          <span>Budgets are enforced by AgentForge before each run (tokens = input + output; cache reads shown separately). Provider plan limits reported by Claude Code or Codex appear on each card after its first run.</span>
        </div>
        {envKey && (
          <div className="flex items-start gap-2 text-xs text-muted p-3 rounded-lg border border-line bg-panel">
            <KeyRound size={13} className={cx('mt-0.5 shrink-0', envKey === 'set' ? 'text-ok' : 'text-warn')} />
            <span>
              <span className="mono">ANTHROPIC_API_KEY</span> in the server environment: <b className={envKey === 'set' ? 'text-ok' : 'text-warn'}>{envKey}</b>.
              {envKey === 'set' ? ' Anthropic API models and Claude Code runs authenticate with it.' : ' Anthropic API models need it (or a key stored on the model); Claude Code falls back to the claude CLI login. See README → Anthropic API key.'}
            </span>
          </div>
        )}
        {keys?.OPENROUTER_API_KEY && (
          <div className="flex items-start gap-2 text-xs text-muted p-3 rounded-lg border border-line bg-panel">
            <KeyRound size={13} className={cx('mt-0.5 shrink-0', keys.OPENROUTER_API_KEY === 'set' ? 'text-ok' : 'text-warn')} />
            <span>
              <span className="mono">OPENROUTER_API_KEY</span> in the server environment: <b className={keys.OPENROUTER_API_KEY === 'set' ? 'text-ok' : 'text-warn'}>{keys.OPENROUTER_API_KEY}</b>.
              {keys.OPENROUTER_API_KEY === 'set' ? ' OpenRouter models use it. Add any OpenRouter model with Add model → OpenRouter.' : ' OpenRouter models need it (or a key stored on the model). See README → OpenRouter.'}
            </span>
          </div>
        )}
        {keys?.GROQ_API_KEY && (
          <div className="flex items-start gap-2 text-xs text-muted p-3 rounded-lg border border-line bg-panel">
            <KeyRound size={13} className={cx('mt-0.5 shrink-0', keys.GROQ_API_KEY === 'set' ? 'text-ok' : 'text-warn')} />
            <span>
              <span className="mono">GROQ_API_KEY</span> in the server environment: <b className={keys.GROQ_API_KEY === 'set' ? 'text-ok' : 'text-warn'}>{keys.GROQ_API_KEY}</b>.
              {keys.GROQ_API_KEY === 'set' ? ' Groq models use it. Add one with Add model → Groq.' : ' Groq models need it (or a key stored on the model). See README → Groq.'}
            </span>
          </div>
        )}
        {keys?.MISTRAL_API_KEY && (
          <div className="flex items-start gap-2 text-xs text-muted p-3 rounded-lg border border-line bg-panel">
            <KeyRound size={13} className={cx('mt-0.5 shrink-0', keys.MISTRAL_API_KEY === 'set' ? 'text-ok' : 'text-warn')} />
            <span>
              <span className="mono">MISTRAL_API_KEY</span> in the server environment: <b className={keys.MISTRAL_API_KEY === 'set' ? 'text-ok' : 'text-warn'}>{keys.MISTRAL_API_KEY}</b>.
              {keys.MISTRAL_API_KEY === 'set' ? ' Mistral models use it. Add one with Add model → Mistral.' : ' Mistral models need it (or a key stored on the model). See README → Mistral.'}
            </span>
          </div>
        )}
        {keys?.COHERE_API_KEY && (
          <div className="flex items-start gap-2 text-xs text-muted p-3 rounded-lg border border-line bg-panel">
            <KeyRound size={13} className={cx('mt-0.5 shrink-0', keys.COHERE_API_KEY === 'set' ? 'text-ok' : 'text-warn')} />
            <span>
              <span className="mono">COHERE_API_KEY</span> in the server environment: <b className={keys.COHERE_API_KEY === 'set' ? 'text-ok' : 'text-warn'}>{keys.COHERE_API_KEY}</b>.
              {keys.COHERE_API_KEY === 'set' ? ' Cohere models use it. Add one with Add model → Cohere.' : ' Cohere models need it (or a key stored on the model). See README → Cohere.'}
            </span>
          </div>
        )}
        {keys?.SAMBANOVA_API_KEY && (
          <div className="flex items-start gap-2 text-xs text-muted p-3 rounded-lg border border-line bg-panel">
            <KeyRound size={13} className={cx('mt-0.5 shrink-0', keys.SAMBANOVA_API_KEY === 'set' ? 'text-ok' : 'text-warn')} />
            <span>
              <span className="mono">SAMBANOVA_API_KEY</span> in the server environment: <b className={keys.SAMBANOVA_API_KEY === 'set' ? 'text-ok' : 'text-warn'}>{keys.SAMBANOVA_API_KEY}</b>.
              {keys.SAMBANOVA_API_KEY === 'set' ? ' SambaNova models use it. Add one with Add model → SambaNova.' : ' SambaNova models need it (or a key stored on the model). See README → SambaNova.'}
            </span>
          </div>
        )}
        <div className="grid gap-4 xl:grid-cols-2">
          {models.map((m) => <ModelCard key={m.id} m={m} keys={keys} onEdit={() => setDialog({ model: m })} onDelete={() => setDel(m)} />)}
        </div>
      </div>
      <ModelDialog open={!!dialog} model={dialog?.model} keys={keys} onClose={() => setDialog(null)} />
      <Confirm open={!!del} title={`Delete ${del?.name}?`} danger confirmLabel="Delete" body="Agents assigned to this model fall back to the default model. Usage history is kept." onConfirm={() => api.del(`/api/models/${del.id}`)} onClose={() => setDel(null)} />
    </div>
  );
}

