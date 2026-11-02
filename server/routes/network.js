// HTTPS mode (Settings → Network): admin only, since these routes are not in routes/auth.js POLICY. The mode is the
// 'network' setting; config.js networkMode() turns it into the bind address and trusted proxies, HOST / TRUST_PROXY win.
import { query } from '../db/pool.js';
import { getSettings } from '../db/seed.js';
import { networkMode } from '../config.js';
import { emit } from '../events.js';

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/** opts.net: what this process runs with (networkMode at boot); opts.restart(): asks the supervisor for a safe restart. */
export default async function networkRoutes(app, { net, supervised = false, restart = () => {}, env = process.env }) {
  const state = async () => {
    const https = (await getSettings()).network?.https === true;
    const next = networkMode(https, env);
    return {
      https, env: net.env, supervised,
      running: { https: net.https, host: net.host, port: app.server.address()?.port ?? null, trustProxy: net.trustProxy },
      restartNeeded: next.host !== net.host || String(next.trustProxy) !== String(net.trustProxy),
    };
  };
  app.get('/api/system/network', state);
  app.put('/api/system/network', async (req, reply) => {
    const https = req.body?.https === true;
    // On moves the plain port to loopback: from a direct remote connection this admin would be locked out until someone
    // edits the database. Only from this machine, i.e. through the local TLS proxy (or an SSH tunnel).
    if (https && !net.env.HOST && !LOOPBACK.test(req.socket.remoteAddress || '')) {
      return reply.code(409).send({ error: 'Turning HTTPS on closes the plain port to other computers. Open AgentForge through the HTTPS proxy on this host (deploy/Caddyfile) first, then switch it on there.', code: 'not_via_proxy' });
    }
    await query(`INSERT INTO settings(key, value, updated_at) VALUES ('network', $1, now()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [{ https }]);
    emit('settings:update', { key: 'network', value: { https } });
    const s = await state();
    const restarting = s.restartNeeded && supervised;
    if (restarting) restart();
    return { ...s, restarting };
  });
}
