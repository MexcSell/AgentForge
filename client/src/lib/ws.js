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

// Only while signed in to an active account: the server refuses the socket otherwise (401 / 403).
const signedIn = () => useStore.getState().me?.status === 'active';

export function connectEvents() {
  if (!signedIn() || (socket && socket.readyState <= 1)) return;
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
    if (st.bittensor) st.loadBittensor().catch(() => {});
  };
  socket.onmessage = (e) => {
    try {
      const { type, payload } = JSON.parse(e.data);
      useStore.getState().applyEvent(type, payload);
    } catch { /* ignore */ }
  };
  socket.onclose = (e) => {
    useStore.getState().set({ connected: false });
    socket = null;
    // 4401: the account was disabled, rejected or deleted. A refused reconnect (session expired) finds out via the API.
    if (e.code === 4401) return useStore.getState().signedOut();
    setTimeout(() => {
      if (!signedIn()) return;
      useStore.getState().loadMe().then(() => connectEvents()).catch(() => connectEvents());
    }, RETRY_MS);
  };
  socket.onerror = () => socket?.close();
}

export function disconnectEvents() {
  const s = socket;
  socket = null;
  if (s) { s.onclose = null; s.close(); }
  useStore.getState().set({ connected: false });
}
