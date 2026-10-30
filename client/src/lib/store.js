import { create } from 'zustand';
import { api } from './api.js';
import { toast } from './toast.js';

const PREF_KEY = 'af.prefs';
const PREFS = ['theme', 'accent', 'layoutId', 'view', 'activeProjectId', 'filePanes', 'activePane', 'termFollow', 'showHidden', 'notifFilter'];

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; }
}
function savePrefs(state) {
  try {
    const out = {};
    for (const k of PREFS) out[k] = state[k];
    localStorage.setItem(PREF_KEY, JSON.stringify(out));
    localStorage.setItem('af.theme', state.theme);
    localStorage.setItem('af.accent', state.accent);
  } catch { /* storage unavailable */ }
}

const upsert = (list, item, key = 'id') => {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = { ...list[i], ...item };
  return next;
};

const prefs = loadPrefs();

export const useStore = create((set, get) => ({
  // preferences
  theme: prefs.theme || 'dark',
  accent: prefs.accent || 'indigo',
  layoutId: prefs.layoutId || 'standard',
  view: prefs.view || 'dashboard',
  activeProjectId: prefs.activeProjectId || null,
  filePanes: prefs.filePanes?.length ? prefs.filePanes : [{ id: 'p1', path: null }],
  activePane: prefs.activePane || 'p1',
  termFollow: prefs.termFollow ?? true,
  showHidden: prefs.showHidden ?? false,
  notifFilter: prefs.notifFilter || 'all',

  // server data
  connected: false,
  loaded: false,
  system: null,
  projects: [],
  agents: [],
  models: [],
  notifications: [],
  settings: null,
  roles: null,
  messages: {},
  tasks: {},
  missions: {},
  live: {},
  syncTick: 0,
  evolutionTick: 0,
  clientUpdate: null,

  // ui
  agentModal: null,
  palette: false,
  createProject: false,
  fileClipboard: null,
  openFile: null,

  set: (patch) => {
    set(patch);
    if (Object.keys(patch).some((k) => PREFS.includes(k))) savePrefs(get());
  },

  async loadAll() {
    const [projects, agents, models, notifications, settings, roles, system] = await Promise.all([
      api.get('/api/projects'), api.get('/api/agents'), api.get('/api/models'), api.get('/api/notifications'),
      api.get('/api/settings'), api.get('/api/roles'), api.get('/api/system/status'),
    ]);
    const s = { projects, agents, models, notifications, settings, roles, system, loaded: true };
    if (!projects.some((p) => p.id === get().activeProjectId)) s.activeProjectId = projects[0]?.id || null;
    set(s);
    savePrefs(get());
  },

  async loadMessages(projectId) {
    const [msgs, tasks] = await Promise.all([api.get(`/api/projects/${projectId}/messages`), api.get(`/api/projects/${projectId}/tasks`)]);
    set((st) => ({ messages: { ...st.messages, [projectId]: msgs }, tasks: { ...st.tasks, [projectId]: tasks } }));
  },

  applyEvent(type, p) {
    const st = get();
    switch (type) {
      case 'system:status': set({ system: p }); break;
      case 'system:restarting': set({ system: { ...(st.system || {}), status: 'restarting' } }); break;
      case 'system:client-updated': set({ clientUpdate: p.version }); break;
      case 'project:update': set({ projects: upsert(st.projects, p) }); break;
      case 'project:delete': set({ projects: st.projects.filter((x) => x.id !== p.id), activeProjectId: st.activeProjectId === p.id ? null : st.activeProjectId }); break;
      case 'agent:new':
      case 'agent:update': set({ agents: upsert(st.agents, p) }); break;
      case 'agent:delete': set({ agents: st.agents.filter((x) => x.id !== p.id) }); break;
      case 'message:new': {
        const list = st.messages[p.project_id];
        if (list && !list.some((m) => m.id === p.id)) set({ messages: { ...st.messages, [p.project_id]: [...list, p] } });
        break;
      }
      case 'task:update': {
        const list = st.tasks[p.project_id];
        if (list) {
          const exists = list.some((t) => t.id === p.id);
          set({ tasks: { ...st.tasks, [p.project_id]: exists ? list.map((t) => (t.id === p.id ? { ...t, ...p } : t)) : [p, ...list] } });
        }
        break;
      }
      case 'mission:update': set({ missions: { ...st.missions, [p.project_id]: p } }); break;
      case 'run:start':
      case 'run:event': {
        const ev = type === 'run:start' ? { type: 'run-start', run_id: p.id, data: { kind: p.kind, model: p.model_id }, ts: Date.now() } : p;
        const id = p.agent_id;
        const prev = st.live[id] || [];
        set({ live: { ...st.live, [id]: [...prev.slice(-399), ev] } });
        break;
      }
      case 'notification:new':
        set({ notifications: [p, ...st.notifications].slice(0, 300) });
        toast[p.level === 'error' ? 'error' : p.level === 'success' ? 'success' : p.level === 'warning' ? 'warn' : 'info'](p.title, p.body, { source: p.source_name });
        break;
      case 'notification:read':
        set({ notifications: st.notifications.map((n) => (p.ids === 'all' || p.ids.includes(n.id) ? { ...n, read: true } : n)) });
        break;
      case 'notification:delete': set({ notifications: st.notifications.filter((n) => n.id !== p.id) }); break;
      case 'models:update': set({ models: p }); break;
      case 'settings:update': set({ settings: { ...st.settings, [p.key]: p.value } }); break;
      case 'sync:log': set({ syncTick: st.syncTick + 1 }); break;
      case 'evolution:event': set({ evolutionTick: st.evolutionTick + 1 }); break;
      default: break;
    }
  },
}));

export const selectUnread = (s) => s.notifications.filter((n) => !n.read).length;
export const selectWorkingAgents = (s) => s.agents.filter((a) => a.status === 'working');
export const selectRunningProjects = (s) => s.projects.filter((p) => p.status === 'running');
