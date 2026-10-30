#!/usr/bin/env node
// Development: API with node --watch + Vite dev server (HMR) proxying /api to it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const procs = [
  spawn(process.execPath, ['--watch-path=server', 'server/index.js'], { cwd: ROOT, stdio: 'inherit' }),
  spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], { cwd: ROOT, stdio: 'inherit' }),
];
const stop = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
