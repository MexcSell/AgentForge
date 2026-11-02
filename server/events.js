// In-process event bus fanned out to every connected WebSocket client, filtered by what its user may see
// (services/access.js eventVisibleTo).
import { eventVisibleTo } from './services/access.js';

const clients = new Set();

// Counts the events a page snapshot could miss: /api/auth/me returns it and a new socket's first frame ('hello') repeats
// it, so a client that loaded its data in parallel with the socket handshake knows whether anything happened in between
// (no resync then). Streams that no snapshot holds and that a new socket gets anyway are left out.
const UNCOUNTED = new Set(['run:start', 'run:event', 'system:metrics', 'system:status']);
let seq = Date.now(); // starts per process, so a restart between /api/auth/me and the socket never looks like a match
export const eventSeq = () => seq;

// user: the signed-in account of the socket (a users row); its permissions decide which events it receives.
export function addClient(socket, user) {
  socket.user = user;
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
}

export function clientCount() {
  return clients.size;
}

export function emit(type, payload) {
  if (!UNCOUNTED.has(type)) seq++;
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const s of clients) {
    if (s.readyState === 1 && eventVisibleTo(s.user, type, payload)) s.send(msg);
  }
}

/**
 * An account changed: its sockets get the new permissions and an 'auth:update' (pub: what the API shows of it), or
 * are closed when the account is gone or can no longer use the app.
 */
export function refreshUserClients(userId, user, pub) {
  seq++;
  for (const s of clients) {
    if (s.user?.id !== userId) continue;
    if (!user || user.status !== 'active') {
      clients.delete(s);
      s.close(4401, 'Signed out');
      continue;
    }
    s.user = user;
    if (s.readyState === 1) s.send(JSON.stringify({ type: 'auth:update', payload: pub, ts: Date.now() }));
  }
}
