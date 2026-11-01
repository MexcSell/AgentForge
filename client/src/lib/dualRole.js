import { createElement as h } from 'react';
import { Crown } from 'lucide-react';
import { useStore } from './store.js';
import { Badge, cx } from '../components/ui.jsx';

/**
 * The executive's two roles: top-level manager of the org and GM of the projects it manages (protected first).
 * Only the executive itself counts: its clones (origin 'cloned') and archived agents get no roles.
 */
export function executiveRoles(agent, projects) {
  const top = !!agent && agent.role === 'executive' && agent.origin !== 'cloned' && !agent.archived;
  const gmOf = !top ? [] : (projects || [])
    .filter((p) => p.manager_id === agent.id && !p.archived)
    .sort((x, y) => (y.protected ? 1 : 0) - (x.protected ? 1 : 0) || String(x.name).localeCompare(String(y.name)))
    .map((p) => ({ id: p.id, name: p.name }));
  return { top, gmOf };
}

/** 'Top-level manager · GM of A, B'; short=true shows the first project and '+N' for the rest. */
export function executiveLabel({ gmOf }, short = false) {
  if (!gmOf.length) return 'Top-level manager';
  const names = short && gmOf.length > 2 ? `${gmOf[0].name} +${gmOf.length - 1}` : gmOf.map((p) => p.name).join(', ');
  return `Top-level manager · GM of ${names}`;
}

/** Dual-role badge for the executive, from live store data; renders nothing for any other agent. */
export function ExecBadge({ agent, className }) {
  const projects = useStore((s) => s.projects);
  const roles = executiveRoles(agent, projects);
  if (!roles.top) return null;
  const full = executiveLabel(roles);
  return h('span', { className: cx('block min-w-0', className), title: full },
    h(Badge, { tone: 'warn', className: 'max-w-full' },
      h(Crown, { size: 11, strokeWidth: 2.2, className: 'shrink-0', 'aria-hidden': true }),
      h('span', { className: 'truncate min-w-0' }, executiveLabel(roles, true))));
}
