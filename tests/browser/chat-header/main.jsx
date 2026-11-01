// Fixture for tests/chat-header-layout.test.mjs: the real CommandWindow (its header is what gets measured) once per case from
// the hash, e.g. #243:gh:running:lock:long,307:-:idle:-:short. Each case gets its own project id and a pane of exactly that width
// (no border, like the chat Split panel).
// The store is seeded and fetch/WebSocket are stubbed, so no server is needed and no live event can change a case.
import './styles.css';
import { createRoot } from 'react-dom/client';
import { useStore } from '../../../client/src/lib/store.js';
import { CommandWindow } from '../../../client/src/views/projects/CommandWindow.jsx';

// Installed before the first render (nothing fetches at import time). Every GET answers an empty object (loadPreview → no
// preview session); anything else is refused, and every request is recorded.
window.__requests = [];
window.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  window.__requests.push(`${method} ${url}`);
  return method === 'GET' ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('{"error":"read-only fixture"}', { status: 403, headers: { 'content-type': 'application/json' } });
};
window.WebSocket = class { constructor(url) { window.__requests.push(`WS ${url}`); this.readyState = 3; } send() {} close() {} addEventListener() {} removeEventListener() {} };

const NAMES = { short: 'AgentForge', long: 'AgentForge Platform Engineering Workspace With A Very Long Name' };
const GM = { id: 'gm', name: 'Lumen', role: 'manager', tier: 1, level: 4, status: 'idle', supervisor_id: null };
const cases = (location.hash.slice(1) || '243:gh:running:lock:short').split(',').map((key) => {
  const [w, gh, state, lock, name] = key.split(':');
  return { key, w: +w, github: gh === 'gh', state, lock: lock === 'lock', name, pid: `p-${key.replace(/:/g, '-')}` };
});

const topics = {}, activeTopic = {}, messages = {}, tasks = {}, missionsByTopic = {};
for (const c of cases) {
  const tid = `${c.pid}-t`;
  // queued: the project runs (another topic's mission holds the slot) and this topic has an order waiting.
  topics[c.pid] = [{ id: tid, project_id: c.pid, title: 'Header width budget', tags: [], running: c.state !== 'idle', message_count: 1, created_at: '2026-11-01T10:00:00Z' }];
  activeTopic[c.pid] = tid;
  messages[tid] = [];
  tasks[c.pid] = [];
  if (c.state === 'running') missionsByTopic[tid] = { id: `${c.pid}-m`, topic_id: tid, project_id: c.pid, status: 'running', command: 'Measure the header', created_at: '2026-11-01T10:01:00Z' };
  c.project = { id: c.pid, name: NAMES[c.name], path: '/home/luca/AgentForge', status: c.state === 'idle' ? 'idle' : 'running',
    protected: c.lock, github_url: c.github ? 'https://github.com/example/agentforge.git' : null, manager_id: GM.id, manager_name: GM.name };
}
useStore.setState({ agents: [GM], projects: cases.map((c) => c.project), topics, activeTopic, messages, tasks, missionsByTopic, loadedRuns: {}, previews: {} });

function App() {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, alignItems: 'flex-start' }}>
    {cases.map((c) => (
      <div key={c.pid} data-case={c.key} data-w={c.w} style={{ width: c.w, height: 160, overflow: 'hidden' }} className="bg-panel">
        <CommandWindow project={c.project} />
      </div>))}
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
