import { useStore } from './store.js';

const RETRY_MS = 5000; // while the connection is down, try again every 5 s

let socket = null;

export function connectEvents() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    const st = useStore.getState();
    st.set({ connected: true });
    // Resync everything after a reconnect (e.g. the server restarted).
    st.loadAll().catch(() => {});
    for (const pid of Object.keys(st.messages)) st.loadMessages(pid).catch(() => {});
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
