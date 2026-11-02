import { listCompetitions } from '../services/bittensor.js';

// Bittensor competition watcher: status (never secrets) and the competitions it detected.
export default async function bittensorRoutes(app, { watcher }) {
  app.get('/api/bittensor', async (req) => ({
    status: watcher.status(),
    competitions: await listCompetitions({ all: req.query.all === '1' }),
  }));
  // Poll now instead of waiting for the next interval (an inert watcher just re-reads its config).
  app.post('/api/bittensor/poll', async () => {
    const result = await watcher.pollOnce();
    return { result, status: watcher.status() };
  });
}
