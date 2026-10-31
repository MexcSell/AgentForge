import { useMemo } from 'react';
import { useStore } from '../../lib/store.js';
import { AgentOrg } from './AgentOrg.jsx';

export function AgentRail({ project }) {
  const st = useStore();
  const tasks = st.tasks[project.id] || [];
  const team = useMemo(() => {
    const ids = new Set([project.manager_id, ...tasks.map((t) => t.agent_id)]);
    return st.agents.filter((a) => ids.has(a.id));
  }, [tasks, st.agents, project.manager_id]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto p-2 flex flex-col gap-1.5">
        <AgentOrg project={project} team={team} />
      </div>
    </div>
  );
}
