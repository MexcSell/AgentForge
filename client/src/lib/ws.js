import { useStore } from './store.js';

const RETRY_MS = 5000; // while the connection is down, try again every 5 s

let socket = null;

// Topics first (they pick the active topic), then every topic whose messages were cached plus the active one.
async function reloadProject(pid) {
  await useStore.getState().loadTopics(pid);
  const st = useStore.getState();
  const active = st.activeTopic[pid];
  await Promise.all((st.topics[pid] || []).filter((t) => t.id === active || st.messages[t.id]).map((t) => st.loadMessages(pid, t.id)));
}

export function connectEvents() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    const st = useStore.getState();
    st.set({ connected: true });
    // Resync everything after a reconnect (e.g. the server restarted).
    st.loadAll().catch(() => {});
    for (const pid of Object.keys(st.topics)) reloadProject(pid).catch(() => {});
    for (const pid of Object.keys(st.previews)) st.loadPreview(pid).catch(() => {});
    for (const pid of Object.keys(st.members)) st.loadMembers(pid).catch(() => {});
  };
  socket.onmessage = (e) => {
    try {
      const { type, payload } = JSON.parse(e.data);
      useStore.getState().applyEvent(type, payload);
    } catch { /* ignore */ }
  };
  socket.onclose = () => {
    useStore.getState().set({ connected: false });
    setTimeout(connectEvents, RETRY_MS);
  };
  socket.onerror = () => socket.close();
}
