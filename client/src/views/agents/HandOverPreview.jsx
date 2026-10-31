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
  const [res, setRes] = useState(null); // { url, moves }: the answer to the request for `url`
  useEffect(() => {
    if (!url) return;
    let live = true;
    const done = (moves) => { if (live) setRes({ url, moves }); };
    api.get(url, { quiet: true }).then((d) => done(Array.isArray(d?.moves) ? d.moves : []), () => done([]));
    return () => { live = false; };
  }, [url]);
  const moves = res?.url === url ? res.moves : null;
  const byFrom = new Set(moves?.map((m) => m.from?.name)).size > 1;
  const rest = moves?.slice(MAX) || [];
  return (
    <div aria-live="polite">
      {!url ? null : !moves ? <div className="mt-3 text-[0.75rem] text-subtle">Checking pending work…</div>
        : moves.length > 0 && (
          <ul aria-label="Pending work handed over" className="mt-3 pt-3 border-t border-line space-y-1.5 text-[0.8rem] leading-snug">
            {moves.slice(0, MAX).map((m) => (
              <li key={m.task_id} className="break-words">
                <div>{byFrom && m.from?.name && <><span className="text-fg">{m.from.name}</span>: </>}<span className="font-medium text-fg">{m.key}</span>{m.project_name && ` in ${m.project_name}`} will {target(m)}</div>
                {m.title && <div className="truncate text-[0.72rem] text-subtle" title={m.title}>{m.title}</div>}
              </li>
            ))}
            {rest.length > 0 && <li className="text-subtle" title={rest.map((m) => `${m.key}${m.project_name ? ` in ${m.project_name}` : ''}`).join('\n')}>+{rest.length} more</li>}
          </ul>
        )}
    </div>
  );
}
