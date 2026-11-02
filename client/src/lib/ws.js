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

// Reloads everything the client holds (after a reconnect, e.g. the server restarted).
function resync() {
  const st = useStore.getState();
  st.loadAll().catch(() => {});
  for (const pid of Object.keys(st.topics)) reloadProject(pid).catch(() => {});
  for (const pid of Object.keys(st.previews)) st.loadPreview(pid).catch(() => {});
  for (const pid of Object.keys(st.members)) st.loadMembers(pid).catch(() => {});
  if (st.bittensor) st.loadBittensor().catch(() => {});
}

// The first load of a session runs in parallel with the handshake instead of after it: events arriving meanwhile wait
// for its snapshot and are applied on top. The socket's 'hello' (the server's event counter when it joined) equal to
// the one /api/auth/me returned means nothing happened in between, so the snapshot is complete; anything else (events
// in that window, a failed load, an older server without 'hello') falls back to the resync a reconnect does.
let boot = null; // { seq, loading, failed, covered, queue } for the session's first socket

function startBoot(st) {
  const b = { seq: st.eventSeq, loading: true, failed: false, covered: false, queue: [] };
  boot = b;
  st.loadAll().catch(() => { b.failed = true; }).finally(() => {
    b.loading = false;
    if (boot !== b) return;
    const apply = useStore.getState().applyEvent;
    for (const [type, payload] of b.queue.splice(0)) apply(type, payload);
    if (b.failed && b.covered) resync();
  });
  return b;
}

export function connectEvents() {
  if (!signedIn() || (socket && socket.readyState <= 1)) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
  const st = useStore.getState();
  const b = st.loaded ? null : startBoot(st);
  let first = true;
  socket = new WebSocket(url);
  socket.onopen = () => {
    useStore.getState().set({ connected: true });
    if (!b) resync();
  };
  socket.onmessage = (e) => {
    try {
      const { type, payload } = JSON.parse(e.data);
      if (b && first) {
        b.covered = type === 'hello' && b.seq != null && payload?.seq === b.seq && !b.failed;
        if (!b.covered) resync();
      }
      first = false;
      if (type === 'hello') return;
      if (b?.loading && boot === b) b.queue.push([type, payload]);
      else useStore.getState().applyEvent(type, payload);
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
  boot = null;
  if (s) { s.onclose = null; s.close(); }
  useStore.getState().set({ connected: false });
}
