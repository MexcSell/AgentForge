import os from 'node:os';
import fs from 'node:fs';
import pty from 'node-pty';
import { childEnv } from './env.js';

const sessions = new Set();

/** Bridges one WebSocket to one login shell running in a pseudo-terminal. */
export function attachTerminal(socket, { cwd, cols, rows }) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
  const term = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: Math.max(20, Number(cols) || 100),
    rows: Math.max(5, Number(rows) || 24),
    cwd: dir,
    env: childEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', AGENTFORGE: '1' }),
  });
  sessions.add(term);
  term.onData((d) => { if (socket.readyState === 1) socket.send(d); });
  term.onExit(({ exitCode }) => {
    sessions.delete(term);
    if (socket.readyState === 1) {
      socket.send(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      socket.close();
    }
  });
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') term.write(msg.data);
    else if (msg.type === 'resize') term.resize(Math.max(20, msg.cols | 0), Math.max(5, msg.rows | 0));
  });
  socket.on('close', () => {
    sessions.delete(term);
    try { term.kill(); } catch {}
  });
}

export function killAllTerminals() {
  for (const t of sessions) { try { t.kill(); } catch {} }
  sessions.clear();
}

export const terminalCount = () => sessions.size;
