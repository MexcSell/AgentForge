import { useStore } from './store.js';

let socket = null;
let retry = 500;

export function connectEvents() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    retry = 500;
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
    setTimeout(connectEvents, retry);
    retry = Math.min(8000, retry * 1.6);
  };
  socket.onerror = () => socket.close();
}
