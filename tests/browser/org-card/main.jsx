// Fixture for tests/org-card-layout.test.mjs: the real AgentRail (Org view) once per pane width from the hash (#243,307),
// with a seeded store and stubbed members API. a1 is the idle GM (no Release), a3/a5 are busy (aria-disabled Release),
// a3/a5/a7 have long names that truncate.
import './styles.css';
import { createRoot } from 'react-dom/client';
import { useStore } from '../../../client/src/lib/store.js';
import { AgentRail } from '../../../client/src/views/projects/AgentRail.jsx';

const id = (n) => `a${n}`;
const AGENTS = [
  { id: id(1), name: 'AgentForge Agent Executive Orchestrator', role: 'manager', tier: 0, level: 9, xp: 3300, status: 'idle', supervisor_id: null },
  { id: id(2), name: 'Pixel', role: 'frontend', tier: 3, level: 6, xp: 1500, status: 'idle', supervisor_id: id(1) },
  { id: id(3), name: 'Bartholomew-Maximilian Longname-Fitzgerald', role: 'backend', tier: 3, level: 12, xp: 5000, status: 'working', supervisor_id: id(1) },
  { id: id(4), name: 'Lens', role: 'qa', tier: 4, level: 5, status: 'idle', supervisor_id: id(1) },
  { id: id(5), name: 'Wolfeschlegelsteinhausenbergerdorff', role: 'qa', tier: 4, level: 100, xp: 400000, status: 'idle', supervisor_id: id(4) },
  { id: id(6), name: 'Kai', role: 'qa', level: 1, status: 'idle', supervisor_id: id(4) },
  { id: id(7), name: 'Quill-Verylongsurname-Hyphenated', role: 'docs', tier: 3, level: 3, status: 'idle', supervisor_id: id(1) },
];
const widths = (location.hash.slice(1) || '243,307').split(',').map(Number);
const insts = widths.map((w) => ({ w, pid: `p-${w}` }));
const tasksFor = (pid) => [
  { id: pid + 't1', key: 'T3', title: 'Org rail controls to add, release and restore agents', status: 'failed', progress: 90, agent_id: id(2), project_id: pid, created_at: '2026-11-01T10:00:00Z' },
  { id: pid + 't2', key: 'T4', title: 'Members API', status: 'running', progress: 40, agent_id: id(3), project_id: pid, created_at: '2026-11-01T10:01:00Z', started_at: '2026-11-01T10:02:00Z' },
  { id: pid + 't3', key: 'T5', title: 'Queued long work item with a very long title to truncate', status: 'pending', progress: 0, agent_id: id(5), project_id: pid, created_at: '2026-11-01T10:03:00Z' },
  { id: pid + 't4', key: 'T6', title: 'Docs', status: 'done', progress: 100, agent_id: id(7), project_id: pid, created_at: '2026-11-01T10:04:00Z' },
];
const BUSY = { [id(3)]: ['T4'], [id(5)]: ['T5'] };
const memberRows = () => AGENTS.map((a) => ({ agent_id: a.id, name: a.name, is_manager: a.id === id(1), status: 'active', busy_tasks: BUSY[a.id] || [] }));

useStore.setState({
  agents: AGENTS, topics: {}, missionsByTopic: {},
  tasks: Object.fromEntries(insts.map((i) => [i.pid, tasksFor(i.pid)])),
  members: Object.fromEntries(insts.map((i) => [i.pid, memberRows()])),
  loadMembers: async () => {},
  memberAction: async () => ({ members: memberRows() }),
});

function App() {
  return <div style={{ display: 'flex', gap: 20, padding: 12, alignItems: 'flex-start' }}>
    {insts.map(({ w, pid }) => (
      <div key={pid} data-pane data-w={w} style={{ width: w, height: 1100 }} className="bg-panel border-x border-line">
        <AgentRail project={{ id: pid, name: 'AgentForge', manager_id: id(1) }} />
      </div>))}
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
