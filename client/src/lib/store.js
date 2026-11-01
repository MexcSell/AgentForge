import { create } from 'zustand';
import { api } from './api.js';
import { toast } from './toast.js';

const PREF_KEY = 'af.prefs';
const PREFS = ['theme', 'accent', 'layoutId', 'view', 'activeProjectId', 'activeTopic', 'filePanes', 'activePane', 'showHidden', 'notifFilter'];

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
const EMPTY = [];

const without = (obj, key) => {
  if (!obj || !(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
};
const byCreated = (a, b) => new Date(a.created_at) - new Date(b.created_at);
const IN_FLIGHT = ['planning', 'running'];
const inFlight = (m) => IN_FLIGHT.includes(m?.status);
/** The mission a topic shows: its oldest in-flight one (orders in one topic run in order), else its newest. */
function pickMission(prev, m) {
  if (!prev || prev.id === m.id) return m;
  if (inFlight(prev) !== inFlight(m)) return inFlight(prev) ? prev : m;
  const newer = new Date(m.created_at) >= new Date(prev.created_at);
  return inFlight(m) === newer ? prev : m;
}
export const PREVIEW_LOG_MAX = 2000; // output lines kept per preview session
const capLog = (lines) => (lines.length > PREVIEW_LOG_MAX ? lines.slice(-PREVIEW_LOG_MAX) : lines);

/** The topic to show after `goneId` disappears: the next open tab in strip order, else the previous one. */
function nextTopic(list, goneId) {
  const open = list.filter((t) => !t.archived || t.id === goneId).sort(byCreated);
  const i = open.findIndex((t) => t.id === goneId);
  const rest = open.filter((t) => t.id !== goneId);
  return (i === -1 ? rest[0] : rest[i] || rest[i - 1]) || list.find((t) => t.id !== goneId) || null;
}
export const useStore = create((set, get) => ({
  // preferences
  theme: prefs.theme || 'dark',
  accent: prefs.accent || 'indigo',
  layoutId: prefs.layoutId || 'standard',
  view: prefs.view || 'dashboard',
  activeProjectId: prefs.activeProjectId || null,
  activeTopic: prefs.activeTopic || {}, // { [projectId]: topicId }
  filePanes: prefs.filePanes?.length ? prefs.filePanes : [{ id: 'p1', path: null }],
  activePane: prefs.activePane || 'p1',
  showHidden: prefs.showHidden ?? false,
  notifFilter: prefs.notifFilter || 'all',

  // server data
  connected: false,
  loaded: false,
  system: null,
  metrics: null, // latest system:metrics sample (machine usage); stays null with servers that don't send it
  projects: [],
  agents: [],
  models: [],
  notifications: [],
  settings: null,
  roles: null,
  topics: {}, // { [projectId]: Topic[] }
  messages: {}, // { [topicId]: Message[] }
  unread: {}, // { [topicId]: count } — messages that arrived while another topic was active
  failedTopics: {}, // { [topicId]: true } — last mission failed while the topic was not active
  movedFrom: {}, // { [topicId]: originTopicId } — topics the GM split off (this session only)
  retitled: {}, // { [topicId]: earlierTitle } — the title before a live keyword retitle (this session only)
  announce: '', // polite live-region text for topic changes
  tasks: {},
  members: {}, // { [projectId]: Member[] } — GET /members, kept live by project:members (GM first, active before released)
  missionsByTopic: {}, // { [topicId]: Mission } — from mission:update; see pickMission
  loadedRuns: {}, // { [topicId]: true } — already running when loadTopics fetched it; no mission:update seen since
  live: {},
  previews: {}, // { [projectId]: { status, mode, command, port, url, startedAt, exitCode, error, log: string[] } }
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

  /** Loads the project's topics (and tasks) and picks the active topic: the saved one if it still exists, else the first. */
  async loadTopics(projectId) {
    const [topics, tasks] = await Promise.all([api.get(`/api/projects/${projectId}/topics`), api.get(`/api/projects/${projectId}/tasks`)]);
    const st = get();
    const saved = st.activeTopic[projectId];
    const active = topics.some((t) => t.id === saved) ? saved : topics[0]?.id || null;
    // A live mission the server disagrees with (an event missed while disconnected) gives way to the topic's running flag.
    let missionsByTopic = st.missionsByTopic;
    const loadedRuns = { ...st.loadedRuns };
    for (const t of topics) {
      if (missionsByTopic[t.id] && inFlight(missionsByTopic[t.id]) !== !!t.running) missionsByTopic = without(missionsByTopic, t.id);
      if (t.running && !missionsByTopic[t.id]) loadedRuns[t.id] = true;
      else delete loadedRuns[t.id];
    }
    set({ topics: { ...st.topics, [projectId]: topics }, tasks: { ...st.tasks, [projectId]: tasks }, activeTopic: { ...st.activeTopic, [projectId]: active }, missionsByTopic, loadedRuns });
    savePrefs(get());
    return topics;
  },

  async loadMessages(projectId, topicId) {
    const msgs = await api.get(`/api/projects/${projectId}/messages?topic=${encodeURIComponent(topicId)}`);
    set((st) => ({ messages: { ...st.messages, [topicId]: msgs } }));
  },

  setActiveTopic(projectId, topicId) {
    set((st) => ({ activeTopic: { ...st.activeTopic, [projectId]: topicId }, unread: without(st.unread, topicId), failedTopics: without(st.failedTopics, topicId) }));
    savePrefs(get());
  },

  /** Creates a topic, makes it active and returns it. Its (empty) message list is known, so nothing is fetched. */
  async createTopic(projectId, { title, tags } = {}) {
    const t = await api.post(`/api/projects/${projectId}/topics`, { title: title || undefined, tags });
    set((st) => ({
      topics: { ...st.topics, [projectId]: upsert(st.topics[projectId] || [], t) },
      messages: st.messages[t.id] ? st.messages : { ...st.messages, [t.id]: [] },
      announce: `Topic created: ${t.title}`,
    }));
    get().setActiveTopic(projectId, t.id);
    return t;
  },

  async updateTopic(id, patch) {
    const t = await api.patch(`/api/topics/${id}`, patch);
    set((st) => ({ topics: { ...st.topics, [t.project_id]: upsert(st.topics[t.project_id] || [], t) } }));
    return t;
  },

  /** Archives a topic; if it was being viewed, the next open topic becomes active. */
  async archiveTopic(t, archived = true) {
    await get().updateTopic(t.id, { archived });
    const st = get();
    if (archived && st.activeTopic[t.project_id] === t.id) {
      const next = nextTopic(st.topics[t.project_id] || [], t.id);
      if (next) st.setActiveTopic(t.project_id, next.id);
    }
    set({ announce: `Topic ${archived ? 'archived' : 'restored'}: ${t.title}` });
  },

  async deleteTopic(t) {
    await api.del(`/api/topics/${t.id}`);
    get().applyEvent('topic:delete', { id: t.id, project_id: t.project_id });
  },

  async loadMembers(projectId) {
    const members = await api.get(`/api/projects/${projectId}/members`);
    set((st) => ({ members: { ...st.members, [projectId]: members } }));
    return members;
  },

  /**
   * Membership changes: add (also restores a released member), release, release-idle. Live state arrives as project:members;
   * the reply's list only counts if no event beat it here. Refusals (409) throw after api.js showed the server's message.
   */
  async memberAction(projectId, action, agentId) {
    const before = get().members[projectId];
    const r = action === 'add' ? await api.post(`/api/projects/${projectId}/members`, { agent_id: agentId })
      : action === 'release' ? await api.del(`/api/projects/${projectId}/members/${agentId}`)
        : await api.post(`/api/projects/${projectId}/members/release-idle`);
    if (Array.isArray(r?.members) && get().members[projectId] === before) set((st) => ({ members: { ...st.members, [projectId]: r.members } }));
    return r;
  },

  /** Fetches the project's preview session snapshot (never starts it). */
  async loadPreview(projectId) {
    const p = await api.get(`/api/projects/${projectId}/preview`, { quiet: true });
    get().applyEvent('preview:update', { ...p, project_id: projectId });
    return get().previews[projectId];
  },

  /** action: start | stop | restart. Live state arrives as preview:update; the reply only counts if no event beat it here. */
  async previewAction(projectId, action) {
    const before = get().previews[projectId];
    const p = await api.post(`/api/projects/${projectId}/preview/${action}`);
    if (p?.status && get().previews[projectId] === before) get().applyEvent('preview:update', { ...p, project_id: projectId });
  },

  applyEvent(type, p) {
    const st = get();
    switch (type) {
      case 'system:status': set({ system: p }); break;
      case 'system:metrics': set({ metrics: p }); break;
      case 'system:restarting':set({ system: { ...(st.system || {}), status: 'restarting' } }); break;
      case 'system:client-updated': set({ clientUpdate: p.version }); break;
      case 'project:update': {
        const patch = { projects: upsert(st.projects, p) };
        // An idle project runs nothing: drop in-flight missions whose final update never arrived, and the load-time guesses.
        if (p.status && p.status !== 'running') {
          const stale = Object.keys(st.missionsByTopic).filter((k) => st.missionsByTopic[k].project_id === p.id && inFlight(st.missionsByTopic[k]));
          if (stale.length) patch.missionsByTopic = stale.reduce(without, st.missionsByTopic);
          const loaded = (st.topics[p.id] || EMPTY).filter((t) => st.loadedRuns[t.id]);
          if (loaded.length) patch.loadedRuns = loaded.map((t) => t.id).reduce(without, st.loadedRuns);
        }
        set(patch);
        break;
      }
      case 'project:delete': set({ projects: st.projects.filter((x) => x.id !== p.id), activeProjectId: st.activeProjectId === p.id ? null : st.activeProjectId, members: without(st.members, p.id) }); break;
      case 'project:members': if (p.project_id && Array.isArray(p.members)) set({ members: { ...st.members, [p.project_id]: p.members } }); break;
      case 'agent:new':
      case 'agent:update': set({ agents: upsert(st.agents, p) }); break;
      case 'agent:delete': set({ agents: st.agents.filter((x) => x.id !== p.id) }); break;
      case 'message:new': {
        const tid = p.topic_id || st.activeTopic[p.project_id];
        if (!tid) break;
        const list = st.messages[tid];
        if (list?.some((m) => m.id === p.id)) break;
        const patch = {};
        if (list) patch.messages = { ...st.messages, [tid]: [...list, p] };
        const topics = st.topics[p.project_id];
        if (topics) patch.topics = { ...st.topics, [p.project_id]: topics.map((t) => (t.id === tid ? { ...t, message_count: (t.message_count || 0) + 1, last_activity_at: p.created_at || t.last_activity_at } : t)) };
        // The GM's "Continued in new topic" notice is a pointer, not news.
        if (st.activeTopic[p.project_id] !== tid && !p.meta?.topic_id) patch.unread = { ...st.unread, [tid]: (st.unread[tid] || 0) + 1 };
        set(patch);
        break;
      }
      case 'topic:new':
      case 'topic:update': {
        const { moved_from: movedFrom, mission_id: _mission, ...t } = p;
        const list = st.topics[t.project_id];
        if (!list) break; // not loaded yet: loadTopics brings it in
        const patch = { topics: { ...st.topics, [t.project_id]: upsert(list, t) } };
        if (type === 'topic:update') {
          // Keyword titles evolve with the topic; keep the one it replaced for the summary block (not the first naming).
          const prev = list.find((x) => x.id === t.id)?.title;
          if (t.title && prev && prev !== t.title && prev !== 'New topic') patch.retitled = { ...st.retitled, [t.id]: prev };
          set(patch);
          break;
        }
        // A brand-new topic starts empty, unless the GM moved an order into it (topic:moved brings those messages).
        if (!movedFrom && !t.message_count && !st.messages[t.id]) patch.messages = { ...st.messages, [t.id]: [] };
        if (movedFrom) patch.movedFrom = { ...st.movedFrom, [t.id]: movedFrom };
        const active = st.activeTopic[t.project_id];
        if (movedFrom && movedFrom === active) {
          // The user is looking at the topic the order came from: follow the order.
          patch.activeTopic = { ...st.activeTopic, [t.project_id]: t.id };
          const gm = st.projects.find((x) => x.id === t.project_id)?.manager_name || 'The GM';
          patch.announce = `${gm} moved your order to a new topic: ${t.title}.`;
          toast.info(`New topic: ${t.title}`, `${gm} moved your order out of "${list.find((x) => x.id === movedFrom)?.title || 'the previous topic'}"`);
        } else if (!active || !list.some((x) => x.id === active)) {
          patch.activeTopic = { ...st.activeTopic, [t.project_id]: t.id }; // the project had no topic yet
        } else if (movedFrom) {
          patch.unread = { ...st.unread, [t.id]: t.message_count || 1 };
        }
        set(patch);
        if (patch.activeTopic) savePrefs(get());
        break;
      }
      case 'topic:delete': {
        const list = st.topics[p.project_id];
        const patch = {
          messages: without(st.messages, p.id), unread: without(st.unread, p.id), failedTopics: without(st.failedTopics, p.id),
          missionsByTopic: without(st.missionsByTopic, p.id), loadedRuns: without(st.loadedRuns, p.id),
        };
        if (list) patch.topics = { ...st.topics, [p.project_id]: list.filter((t) => t.id !== p.id) };
        if (st.activeTopic[p.project_id] === p.id) patch.activeTopic = { ...st.activeTopic, [p.project_id]: (list && nextTopic(list, p.id)?.id) || null };
        set(patch);
        if (patch.activeTopic) savePrefs(get());
        break;
      }
      case 'topic:moved': {
        // The GM split an order off into p.topic_id: move the cached messages along with it.
        const ids = new Set(p.message_ids || []);
        const from = st.messages[p.moved_from];
        const to = st.messages[p.topic_id];
        const moving = (from || []).filter((m) => ids.has(m.id)).map((m) => ({ ...m, topic_id: p.topic_id }));
        const messages = { ...st.messages };
        if (from) messages[p.moved_from] = from.filter((m) => !ids.has(m.id));
        if (to || moving.length === ids.size) messages[p.topic_id] = [...(to || []).filter((m) => !ids.has(m.id)), ...moving].sort(byCreated);
        else delete messages[p.topic_id]; // not all cached here: fetched when opened
        const patch = { messages };
        const list = st.topics[p.project_id];
        if (list) patch.topics = { ...st.topics, [p.project_id]: list.map((t) => (t.id === p.moved_from ? { ...t, message_count: Math.max(0, (t.message_count || 0) - ids.size) } : t)) };
        // The moved mission's live state follows it to the new topic.
        const m = st.missionsByTopic[p.moved_from];
        if (m?.id === p.mission_id) {
          patch.missionsByTopic = { ...without(st.missionsByTopic, p.moved_from), [p.topic_id]: pickMission(st.missionsByTopic[p.topic_id], { ...m, topic_id: p.topic_id }) };
        } else if (!m && st.loadedRuns[p.moved_from]) {
          patch.loadedRuns = { ...without(st.loadedRuns, p.moved_from), [p.topic_id]: true };
        }
        set(patch);
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
      case 'mission:update': {
        const patch = {};
        if (p.topic_id) {
          patch.missionsByTopic = { ...st.missionsByTopic, [p.topic_id]: pickMission(st.missionsByTopic[p.topic_id], p) };
          patch.loadedRuns = without(st.loadedRuns, p.topic_id);
        }
        if (p.status === 'failed' && p.topic_id && p.topic_id !== st.activeTopic[p.project_id]) patch.failedTopics = { ...st.failedTopics, [p.topic_id]: true };
        set(patch);
        break;
      }
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
      case 'preview:update': {
        // Session snapshot. A snapshot without `log` keeps the lines streamed so far.
        const pid = p.project_id ?? p.projectId;
        if (!pid) break;
        const prev = st.previews[pid];
        set({ previews: { ...st.previews, [pid]: { ...prev, ...p, log: Array.isArray(p.log) ? capLog(p.log) : prev?.log || [] } } });
        break;
      }
      case 'preview:log': {
        const prev = st.previews[p.project_id];
        const lines = Array.isArray(p.lines) ? p.lines : [String(p.lines ?? '')];
        set({ previews: { ...st.previews, [p.project_id]: { ...prev, log: capLog([...(prev?.log || []), ...lines]) } } });
        break;
      }
      case 'sync:log': set({ syncTick: st.syncTick + 1 }); break;
      case 'evolution:event': set({ evolutionTick: st.evolutionTick + 1 }); break;
      default: break;
    }
  },
}));

export const selectUnread = (s) => s.notifications.filter((n) => !n.read).length;
export const selectWorkingAgents = (s) => s.agents.filter((a) => a.status === 'working');
export const selectRunningProjects = (s) => s.projects.filter((p) => p.status === 'running');

/**
 * In-flight missions by topic: { [topicId]: { planning, progress, missionId } }. Topics run their missions side by side.
 * A topic's live mission (mission:update) is authoritative. Without one, a topic that was already running when it was
 * loaded (after a reload) counts as running — queued orders included. Every other topic whose `running` flag is set
 * has an order waiting that has not started (starting always sends mission:update): it is queued, not running.
 */
export function selectRuns(s, project) {
  const runs = {};
  if (!project || project.status !== 'running') return runs;
  const tasks = (s.tasks[project.id] || EMPTY).filter((x) => x.origin !== 'proposal');
  for (const t of s.topics[project.id] || EMPTY) {
    const m = s.missionsByTopic[t.id];
    if (m ? !inFlight(m) : !(t.running && s.loadedRuns[t.id])) continue;
    const planning = m?.status === 'planning';
    // After a reload the mission id comes from the topic's messages: the one with unfinished tasks, else the latest order.
    let id = m?.id || null;
    if (!id && s.messages[t.id]) {
      const ids = new Set(s.messages[t.id].map((x) => x.mission_id).filter(Boolean));
      id = tasks.find((x) => ids.has(x.mission_id) && ['pending', 'running'].includes(x.status))?.mission_id
        || s.messages[t.id].findLast((x) => x.mission_id)?.mission_id || null;
    }
    const live = !planning && id ? tasks.filter((x) => x.mission_id === id) : EMPTY;
    runs[t.id] = { planning, progress: live.length ? `${live.filter((x) => x.status === 'done').length}/${live.length}` : null, missionId: id };
  }
  return runs;
}
