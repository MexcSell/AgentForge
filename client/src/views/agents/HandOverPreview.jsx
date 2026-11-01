import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

const MAX = 6;

const target = (m) => m.agent ? <>move to <span className="text-fg" title={m.agent.title || undefined}>{m.agent.name}</span></>
  : m.recruit ? <>go to a new <span className="text-fg">{m.recruit.title || m.recruit.role}</span></>
    : 'be handed over';

/**
 * The pending tasks a merge or delete would hand over (GET `url`, no side effects), listed below a confirm's body while
 * it is open. Quiet and best-effort: loading shows one subtle line, nothing or an error shows nothing, and the confirm
 * never waits on it. A late answer for another clone or project set is never shown. Moves from several agents (a bulk
 * project delete with several GMs) say whose they are.
 */
export function HandOverPreview({ url }) {
  const [res, setRes] = useState(null); // { url, moves, merges }: the answer to the request for `url`
  useEffect(() => {
    if (!url) return;
    let live = true;
    const done = (moves, merges = []) => { if (live) setRes({ url, moves, merges }); };
    api.get(url, { quiet: true }).then((d) => done(Array.isArray(d?.moves) ? d.moves : [], Array.isArray(d?.merges) ? d.merges : []), () => done([]));
    return () => { live = false; };
  }, [url]);
  const moves = res?.url === url ? res.moves : null;
  const merges = res?.url === url ? res.merges : [];
  return (
    <div aria-live="polite">
      {!url ? null : !moves ? <div className="mt-3 text-[0.75rem] text-subtle">Checking pending work…</div> : <><MergeList merges={merges} /><HandOverList moves={moves} /></>}
    </div>
  );
}

/** Cloned project GMs a delete merges back into their original manager (the project preview's merges) instead of retiring. */
function MergeList({ merges }) {
  if (!merges.length) return null;
  const byProject = merges.length > 1;
  return (
    <ul aria-label="Managers merged back" className="mt-3 space-y-1 text-[0.8rem] leading-snug">
      {merges.map((m) => (
        <li key={m.project?.id || m.from?.id} className="break-words">
          {byProject && m.project?.name && <>{m.project.name}: </>}<span className="font-medium text-fg">{m.from?.name}</span> merges back into <span className="font-medium text-fg">{m.into?.name}</span>, which keeps what it learned.
        </li>
      ))}
    </ul>
  );
}

/** The list part of HandOverPreview, for callers that already hold the moves (the consolidate preview returns them). */
export function HandOverList({ moves }) {
  const byFrom = new Set(moves.map((m) => m.from?.name)).size > 1;
  const rest = moves.slice(MAX);
  if (!moves.length) return null;
  return (
    <ul aria-label="Pending work handed over" className="mt-3 pt-3 border-t border-line space-y-1.5 text-[0.8rem] leading-snug">
      {moves.slice(0, MAX).map((m) => (
        <li key={m.task_id} className="break-words">
          <div>{byFrom && m.from?.name && <><span className="text-fg">{m.from.name}</span>: </>}<span className="font-medium text-fg">{m.key}</span>{m.project_name && ` in ${m.project_name}`} will {target(m)}</div>
          {m.title && <div className="truncate text-[0.72rem] text-subtle" title={m.title}>{m.title}</div>}
        </li>
      ))}
      {rest.length > 0 && <li className="text-subtle" title={rest.map((m) => `${m.key}${m.project_name ? ` in ${m.project_name}` : ''}`).join('\n')}>+{rest.length} more</li>}
    </ul>
  );
}
