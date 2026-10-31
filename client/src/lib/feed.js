// Topic-feed fold predicates, shared by CommandWindow and the engine e2e harnesses. Plain ES module (no JSX,
// React or store imports) so Node can import it directly.

/** A superior's verdict on a proposal: messages.meta.decision, else read back from the task result. */
export function proposalDecision(m, t) {
  if (m.meta?.decision?.verdict) return m.meta.decision;
  const r = /^(Approved|Rejected|Escalated) by (.+?)(?: → new mission|: ([\s\S]*))$/.exec(t?.result || '');
  return r ? { verdict: { Approved: 'approve', Rejected: 'reject', Escalated: 'escalate' }[r[1]], by: r[2], reason: r[3] || '' } : null;
}

/**
 * Superiors decide proposals; the user only gets Approve/Reject on a still-proposed task that was escalated to them
 * (or that nobody else decides because triage is off).
 */
export function needsUser(m, t, triage) {
  const d = proposalDecision(m, t);
  return (!t || t.status === 'proposed') && (d?.verdict === 'escalate' || (!triage && !d));
}

/**
 * The topic feed keeps the GM's main content: orders, the GM's chat/plan/summary/error/meeting/status lines, system
 * messages and moved-topic notices. Worker reports and proposals, other agents' statuses and meta.detail chatter fold
 * into one row per mission. An escalated proposal waiting for the user stays visible.
 */
export function isHeadline(m, gmId, tasks, triage) {
  if (m.author_type === 'user' || (m.kind === 'status' && m.meta?.topic_id)) return true;
  if (m.kind === 'proposal') return needsUser(m, tasks?.find((x) => x.id === m.meta?.task_id), triage);
  if (m.meta?.detail) return false;
  if (m.author_type === 'system') return true;
  return !!m.agent_id && m.agent_id === gmId && m.kind !== 'report';
}
