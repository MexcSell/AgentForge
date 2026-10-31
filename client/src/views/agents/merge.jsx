import { useId } from 'react';
import { GitMerge } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { Confirm } from '../../components/Modal.jsx';
import { Button, IconButton } from '../../components/ui.jsx';

export const MERGE_BUSY = 'Busy — merge when it is idle';

/** A clone can be merged (returned) into its original while it is on the roster. */
export const canMerge = (a) => a.origin === 'cloned' && !a.archived && !a.merged_into;

/** The original a clone returns to, if it is on the roster (the server resolves the final target either way). */
export const mergeOriginal = (a, agents) => agents.find((x) => x.id === a.cloned_from) || null;

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

/** Confirms the merge, then drops the clone from the roster and moves an open detail page over to the original. */
export function MergeConfirm({ clone, original, onClose }) {
  const into = original?.name || 'its original';
  return (
    <Confirm open={!!clone} title={`Merge ${clone?.name} into ${into}?`} confirmLabel="Merge" onClose={onClose}
      body={<>The skills, XP, lessons and playbook {clone?.name} gained are combined into {into}, and {clone?.name} is retired. Its task history stays.</>}
      onConfirm={async () => {
        let agent;
        try {
          ({ agent } = await api.post(`/api/agents/${clone.id}/merge`, {}, { quiet: true }));
        } catch (e) {
          return toast.error(`Could not merge ${clone.name}`, e.message); // 400/409: the server says why
        }
        const st = useStore.getState();
        st.applyEvent('agent:delete', { id: clone.id });
        st.applyEvent('agent:update', agent);
        toast.success(`Merged ${clone.name} into ${agent.name}`);
        if (st.agentModal === clone.id) st.set({ agentModal: agent.id });
      }} />
  );
}
