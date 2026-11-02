import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency): KEY=VALUE lines, existing env wins.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const env = process.env;

const parseTrustProxy = (v) => /^(|0|false|no|off)$/i.test(v || '') ? false : /^(1|true|yes|on)$/i.test(v) ? 'loopback' : v;
const isSet = (v) => v !== undefined && String(v).trim() !== '';

/**
 * Where the server listens and which proxies it trusts, from the admin's HTTPS mode setting (settings.network.https)
 * unless HOST / TRUST_PROXY are set in the environment, which always win.
 * - HTTPS on: TLS proxy in front (deploy/Caddyfile). The plain port stays on loopback and X-Forwarded-Proto/Host/For are
 *   honoured from loopback only, so cookies are Secure over https.
 * - HTTPS off (the default): plain HTTP straight on all interfaces, forwarded headers ignored (direct clients can not
 *   spoof them).
 * TRUST_PROXY: unset/0/false = ignored; 1/true = loopback; otherwise IPs/CIDRs, comma-separated. The supervisor's
 * health-check candidate (side port) stays on loopback unless HOST is set.
 */
export function networkMode(https = false, e = process.env) {
  const host = isSet(e.HOST) ? e.HOST.trim() : e.AF_CANDIDATE === '1' || https ? '127.0.0.1' : '0.0.0.0';
  const trustProxy = isSet(e.TRUST_PROXY) ? parseTrustProxy(e.TRUST_PROXY.trim()) : https ? 'loopback' : false;
  return { https: !!https, host, trustProxy, env: { HOST: isSet(e.HOST), TRUST_PROXY: isSet(e.TRUST_PROXY) } };
}

export const config = {
  root: ROOT,
  port: Number(env.PORT || 4800),
  // Bind address and trusted proxies from the environment alone (networkMode above); server/index.js resolves them
  // again with the saved HTTPS mode before it creates the app.
  network: networkMode(),
  candidate: env.AF_CANDIDATE === '1', // health-check instance spawned by the supervisor
  supervised: typeof process.send === 'function',
  dataDir: path.join(ROOT, 'data'),
  uploadsDir: path.join(ROOT, 'data', 'uploads'),
  clientDist: path.join(ROOT, 'client', 'dist'),
  db: {
    host: env.PGHOST || 'localhost',
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE || 'agentapp',
    user: env.PGUSER || 'agentuser',
    password: env.PGPASSWORD || 'agentuser',
  },
  github: {
    url: 'https://github.com/MexcSell/AgentForge.git',
    userName: 'mexcsell',
    userEmail: 'sellmexc9@gmail.com',
  },
  claudeBin: env.CLAUDE_BIN || 'claude',
  codexBin: env.CODEX_BIN || 'codex',
};

fs.mkdirSync(config.uploadsDir, { recursive: true });
