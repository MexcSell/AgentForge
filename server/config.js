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

export const config = {
  root: ROOT,
  port: Number(env.PORT || 4800),
  host: env.HOST || '127.0.0.1',
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
