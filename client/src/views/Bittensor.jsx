import { useEffect } from 'react';
import { Pickaxe, RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { timeAgo } from '../lib/format.js';
import { Badge, IconButton } from '../components/ui.jsx';

const STATE_TONE = { idle: 'ok', polling: 'info', error: 'bad', inert: 'neutral', stopped: 'neutral' };
const SUBMIT = {
  pending: ['neutral', 'submit pending'],
  running: ['info', 'submitting…'],
  'dry-run': ['warn', 'dry run'],
  submitted: ['ok', 'submitted'],
  failed: ['bad', 'submit failed'],
};
const STATUS_LABEL = { detected: 'new', staffing: 'creating agent', staffed: 'agent assigned', ignored: 'filtered out' };

const ago = (d) => (timeAgo(d) === 'now' ? 'just now' : `${timeAgo(d)} ago`);
const competitionLabel = (c) => (c.netuid !== null && c.netuid !== undefined ? `Subnet ${c.netuid}` : c.name);

/** Watcher state badge for the card header. */
export function BittensorState() {
  const s = useStore((x) => x.bittensor?.status);
  if (!s) return null;
  return (
    <span className="flex items-center gap-1.5">
      <Badge tone={STATE_TONE[s.state] || 'neutral'}>{s.state === 'inert' ? 'off' : s.state}</Badge>
      {s.state !== 'inert' && <Badge tone={s.submitArmed ? 'accent' : 'neutral'}>{s.submitArmed ? 'auto-submit' : 'dry run'}</Badge>}
      <IconButton icon={RefreshCw} label="Poll now" onClick={() => api.post('/api/bittensor/poll', {}, { quiet: true }).catch(() => {})} />
    </span>
  );
}

/** Competitions the watcher detected (newest first) with their miner agent and submission outcome. */
export function BittensorCompetitions() {
  const data = useStore((x) => x.bittensor);
  const loadBittensor = useStore((x) => x.loadBittensor);
  const set = useStore((x) => x.set);
  useEffect(() => { loadBittensor().catch(() => {}); }, [loadBittensor]);
  const s = data?.status;
  const list = data?.competitions || [];
  return (
    <div className="flex flex-col gap-2">
      {s?.state === 'inert' && <div className="text-xs text-subtle">Watcher off: {s.reason}. Copy config/bittensor.example.json to config/bittensor.json and set "enabled": true (see README).</div>}
      {s?.lastError && <div className="text-xs text-bad break-words">{s.lastError}</div>}
      {s && s.state !== 'inert' && (
        <div className="text-[0.68rem] text-subtle">{s.network} · {s.sources.join(', ')}{s.lastPollAt ? ` · polled ${ago(s.lastPollAt)}` : ''}{s.keysPresent ? '' : ' · no wallet keys'}</div>
      )}
      {!list.length && s?.state !== 'inert' && <div className="text-xs text-subtle">No new competitions yet.</div>}
      <div className="flex flex-col -my-1">
        {list.map((c) => {
          const [tone, label] = SUBMIT[c.submit_status] || [];
          return (
            <div key={c.id} className="flex items-start gap-3 py-2 border-b last:border-0 border-line" data-competition={c.id}>
              <Pickaxe size={13} className="text-subtle mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[0.82rem] truncate">{competitionLabel(c)}{c.name && c.name !== competitionLabel(c) ? <span className="text-muted"> · {c.name}</span> : null}</div>
                <div className="text-[0.68rem] text-subtle">
                  {c.network}{c.registered_block ? ` · block ${c.registered_block}` : ''} · {ago(c.detected_at)}
                  {c.agent_name && <> · Mino <button className="underline hover:text-fg" onClick={() => set({ agentModal: c.agent_id })}>{c.agent_name}</button></>}
                </div>
                {c.submit_output && <div className="text-[0.68rem] text-muted truncate" title={c.submit_output}>{c.submit_output.split('\n')[0]}</div>}
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Badge tone={c.status === 'staffed' ? 'accent' : 'neutral'}>{STATUS_LABEL[c.status] || c.status}</Badge>
                {label && <Badge tone={tone}>{label}</Badge>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
