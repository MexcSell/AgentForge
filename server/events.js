// In-process event bus fanned out to every connected WebSocket client.
const clients = new Set();

export function addClient(socket) {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
}

export function clientCount() {
  return clients.size;
}

export function emit(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const s of clients) {
    if (s.readyState === 1) s.send(msg);
  }
}
