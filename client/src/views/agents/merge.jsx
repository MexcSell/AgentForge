import { useId } from 'react';
import { GitMerge, Timer } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { Confirm } from '../../components/Modal.jsx';
import { Badge, Button, IconButton } from '../../components/ui.jsx';
import { HandOverPreview } from './HandOverPreview.jsx';

export const MERGE_BUSY = 'Busy — merge when it is idle';

/** A clone can be merged (returned) into its original while it is on the roster. */
export const canMerge = (a) => a.origin === 'cloned' && !a.archived && !a.merged_into;

/**
 * The agent a clone merges into: the server's merge_target (its nearest live ancestor, as liveAncestor() resolves it).
 * Prefers the roster entry so live renames show; falls back to the row's merge_target_name while the store lacks it.
 * Null when the server found no live ancestor, so the labels say 'original'.
 */
export const mergeOriginal = (a, agents) => {
  if (!a.merge_target_id) return null;
  return agents.find((x) => x.id === a.merge_target_id) || { id: a.merge_target_id, name: a.merge_target_name };
};

/** A live clone leased to a mission (lease_mission_id): the engine merges it back into its original when that mission ends. */
export const isLeased = (a) => canMerge(a) && !!a.lease_mission_id;

/** 'Leased · returns to <merge target> after mission'; wraps instead of widening a narrow column. Nothing for originals and unleased clones. */
export function LeaseBadge({ clone, original, className }) {
  if (!isLeased(clone)) return null;
  const text = `Leased · returns to ${original?.name || 'its original'} after mission`;
  return <Badge tone="info" icon={Timer} className={`max-w-full h-auto! min-h-5 py-0.5 whitespace-normal! ${className || ''}`}><span className="min-w-0 break-words">{text}</span></Badge>;
}

const mergeLabel = (original) => `Merge into ${original?.name || 'original'}`;

/**
 * Merge action of a clone; disabled while it works. A disabled button shows no tooltip, so the wrapper carries the hint.
 * `compact` is the card's icon button; the header button drops its label below sm so the modal header still fits a phone.
 */
export function MergeButton({ clone, original, onClick, compact }) {
  const busy = clone.status === 'working' || clone.active_tasks > 0;
  const hintId = useId();
  const label = mergeLabel(original);
  const props = { disabled: busy, 'aria-describedby': busy ? hintId : undefined, onClick };
  return (
    <span className="inline-flex" title={busy ? MERGE_BUSY : undefined} onClick={(e) => e.stopPropagation()}>
      {compact ? <IconButton icon={GitMerge} size="sm" label={label} {...props} />
        : <Button size="sm" variant="ghost" icon={GitMerge} aria-label={label} className="max-sm:px-1.5" {...props}><span className="max-sm:hidden">{label}</span></Button>}
      {busy && <span id={hintId} className="sr-only">{MERGE_BUSY}</span>}
    </span>
  );
}

/** Confirms the merge into the resolved target, then drops the clone from the roster and moves an open detail page over to the agent the server merged into. */
export function MergeConfirm({ clone, original, onClose }) {
  // The caller may hold a snapshot of the clone; re-resolve from the live row so an agent:update while open retitles it
  const live = useStore((s) => clone && s.agents.find((x) => x.id === clone.id));
  const agents = useStore((s) => s.agents);
  const into = (live ? mergeOriginal(live, agents) : original)?.name || 'its original';
  return (
    <Confirm open={!!clone} title={`Merge ${clone?.name} into ${into}?`} confirmLabel="Merge" onClose={onClose}
      body={<>The skills, XP, lessons and playbook {clone?.name} gained are combined into {into}, and {clone?.name} is retired. Its task history stays.
        <HandOverPreview url={clone && `/api/agents/${clone.id}/handover?as=merge`} /></>}
      onConfirm={async () => {
        let agent, merged;
        try {
          ({ agent, merged } = await api.post(`/api/agents/${clone.id}/merge`, {}, { quiet: true }));
        } catch (e) {
          return toast.error(`Could not merge ${clone.name}`, e.message); // 400/409: the server says why
        }
        const st = useStore.getState();
        st.applyEvent('agent:delete', { id: clone.id });
        st.applyEvent('agent:update', agent);
        // Same gains line as the server's merge notification
        toast.success(`Merged ${clone.name} into ${agent.name}`, merged && `+${merged.xp} XP · ${merged.skills} skills · ${merged.lessons} lessons${merged.playbookVersion ? ` · playbook v${merged.playbookVersion}` : ''}`);
        if (st.agentModal === clone.id) st.set({ agentModal: agent.id });
      }} />
  );
}
