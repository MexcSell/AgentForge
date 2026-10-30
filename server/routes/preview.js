// Run & preview: API for the per-project runner, and serving under /preview/<id>/ (static files, or a
// reverse proxy with WebSocket upgrades). The proxy only ever reaches the port of that project's own
// live session on loopback; nothing in the request can choose the upstream host or port.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { config } from '../config.js';
import { getProject } from '../services/projects.js';
import { isUuid } from '../services/topics.js';
import { getPreview, previewState, startPreview, stopPreview, restartPreview } from '../services/runner.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const PREVIEW_URL = /^\/preview\/([^/?]+)(\/[^?]*)?(\?.*)?$/s;
const APP_PATH = /^\/(api|uploads|preview)(\/|$)/;
const PREVIEW_REFERER = /^\/preview\/([0-9a-f-]{36})\//i;

const err = (reply, code, message) => reply.code(code).send({ error: message });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const inside = (root, p) => p === root || p.startsWith(root + path.sep);

export default async function previewRoutes(app) {
  const load = async (id) => (isUuid(id) ? getProject(id) : null);

  app.get('/api/projects/:id/preview', async (req, reply) => {
    const p = await load(req.params.id);
    if (!p) return err(reply, 404, 'Not found');
    return previewState(p, req.query.lines);
  });

  const actions = { start: startPreview, stop: (p) => stopPreview(p.id), restart: restartPreview };
  for (const [name, run] of Object.entries(actions)) {
    app.post(`/api/projects/:id/preview/${name}`, async (req, reply) => {
      const p = await load(req.params.id);
      if (!p) return err(reply, 404, 'Not found');
      return run(p);
    });
  }
}

/**
 * Root onRequest hook. It runs before body parsing, so request bodies and WebSocket upgrades can be piped
 * as-is. It serves /preview/<id>/*, and sends root-absolute URLs that a preview page asks for
 * (/assets/app.js, /favicon.ico…, recognised by the Referer) to that preview. Anything else falls through.
 */
export function previewHook(req, reply, done) {
  const target = previewTarget(req.raw);
  if (!target) return done();
  reply.hijack();
  done();
  servePreview(req.raw, reply.raw, target).catch((e) => {
    req.log.warn({ err: e }, 'preview request failed');
    if (req.raw.upgrade) req.raw.socket.destroy();
    else if (!reply.raw.headersSent) page(req.raw, reply.raw, 502, 'Preview error', e.message);
    else reply.raw.destroy();
  });
}

function previewTarget(raw) {
  const m = PREVIEW_URL.exec(raw.url);
  if (m) return { id: m[1], rest: m[2], query: m[3] || '' };
  const id = refererPreview(raw);
  if (!id) return null;
  const q = raw.url.indexOf('?');
  return q < 0 ? { id, rest: raw.url, query: '' } : { id, rest: raw.url.slice(0, q), query: raw.url.slice(q) };
}

// Root-absolute paths already sent to a preview → its id: their own sub-requests (module imports,
// CSS url()) carry that path as Referer instead of /preview/<id>/.
const routed = new Map();

function refererPreview(raw) {
  const ref = raw.headers.referer;
  if (!ref || !raw.url.startsWith('/')) return null;
  const pathname = raw.url.split('?')[0];
  if (APP_PATH.test(pathname)) return null;
  let from;
  try { from = new URL(ref).pathname; } catch { return null; }
  const id = PREVIEW_REFERER.exec(from)?.[1] || routed.get(from);
  if (!id || isClientAsset(pathname)) return null;
  const s = getPreview(id);
  if (s?.status !== 'running' || (s.mode !== 'server' && s.mode !== 'static')) return null;
  routed.delete(pathname);
  routed.set(pathname, id);
  if (routed.size > 500) routed.delete(routed.keys().next().value);
  return id;
}

function isClientAsset(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  const file = path.join(config.clientDist, rel);
  if (!inside(config.clientDist, file)) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

async function servePreview(raw, res, { id, rest, query }) {
  const socket = raw.upgrade ? raw.socket : null;
  const refuse = (code, title, detail, refresh) => (socket ? refuseUpgrade(socket, code) : page(raw, res, code, title, detail, refresh));
  const s = isUuid(id) ? getPreview(id) : null;
  if (!s || s.status === 'idle') return refuse(404, 'No preview running', 'Start the project from its preview panel in AgentForge.');
  if (s.status === 'starting') return refuse(503, 'Starting…', 'The project is starting; this page reloads by itself.', 2);
  if (s.status !== 'running') return refuse(503, 'Preview is not running', s.error || `The process exited${s.exitCode != null ? ` with code ${s.exitCode}` : ''}.`);
  if (rest === undefined) return socket ? refuseUpgrade(socket, 404) : redirect(res, `/preview/${id}/${query}`); // relative URLs need the slash
  if (s.mode === 'self') return socket ? refuseUpgrade(socket, 404) : redirect(res, rest + query);
  if (s.mode === 'static') return socket ? refuseUpgrade(socket, 404) : serveStatic(raw, res, s, rest, query);
  const upstreamPath = (s.keepPrefix ? `/preview/${id}` : '') + rest + query;
  return socket ? proxyUpgrade(raw, socket, s, upstreamPath) : proxyHttp(raw, res, s, upstreamPath);
}

function page(raw, res, code, title, detail, refresh) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}</head>`
    + '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d12;color:#9ca3af;font:14px system-ui,sans-serif">'
    + `<div style="max-width:32rem;padding:1rem;text-align:center"><h1 style="margin:0 0 .5rem;font-size:1rem;color:#e5e7eb">${esc(title)}</h1><p style="margin:0">${esc(detail)}</p></div></body></html>`;
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(raw.method === 'HEAD' ? undefined : body);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'content-length': 0 });
  res.end();
}

function refuseUpgrade(socket, code) {
  socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] || 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// ---- static ------------------------------------------------------------------
async function serveStatic(raw, res, s, rest, query) {
  if (raw.method !== 'GET' && raw.method !== 'HEAD') return page(raw, res, 405, 'Method not allowed', 'A static preview only answers GET requests.');
  let rel;
  try { rel = decodeURIComponent(rest); } catch { return page(raw, res, 400, 'Bad request', 'Malformed URL.'); }
  let file = path.resolve(s.root, `.${rel}`);
  if (rel.includes('\0') || !inside(s.root, file)) return page(raw, res, 403, 'Forbidden', 'That path is outside the preview folder.');
  if (path.relative(s.root, file).split(path.sep).some((seg) => seg.startsWith('.') && seg !== '.well-known')) {
    return page(raw, res, 404, 'Not found', 'Hidden files are not served.'); // .git, .env…
  }
  let st = await fsp.stat(file).catch(() => null);
  if (st?.isDirectory()) {
    if (!rest.endsWith('/')) return redirect(res, `/preview/${s.project_id}${rest}/${query}`);
    file = path.join(file, 'index.html');
    st = await fsp.stat(file).catch(() => null);
  }
  if (!st?.isFile() && !path.extname(file) && /text\/html/.test(raw.headers.accept || '')) {
    file = path.join(s.root, 'index.html'); // client-side route of a single-page app
    st = await fsp.stat(file).catch(() => null);
  }
  if (!st?.isFile()) return page(raw, res, 404, 'Not found', `${rel} is not in the preview folder.`);
  const target = await fsp.realpath(file).catch(() => null);
  if (!target || !inside(s.root, target)) return page(raw, res, 403, 'Forbidden', 'That path is outside the preview folder.');
  res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
  if (raw.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

// ---- reverse proxy -------------------------------------------------------------
function forwardHeaders(raw, s, upgrade = false) {
  const h = {};
  for (const [k, v] of Object.entries(raw.headers)) if (!HOP.has(k)) h[k] = v;
  h.host = `localhost:${s.port}`; // dev servers check Host (e.g. Vite allowedHosts)
  const via = [raw.headers['x-forwarded-for'], raw.socket.remoteAddress].filter(Boolean).join(', ');
  if (via) h['x-forwarded-for'] = via;
  if (raw.headers.host) h['x-forwarded-host'] = raw.headers['x-forwarded-host'] || raw.headers.host;
  h['x-forwarded-proto'] = raw.headers['x-forwarded-proto'] || 'http';
  h['x-forwarded-prefix'] = `/preview/${s.project_id}`;
  if (upgrade) Object.assign(h, { connection: 'Upgrade', upgrade: raw.headers.upgrade });
  return h;
}

// Drop frame-ancestors from every policy (comma-separated policies, semicolon-separated directives).
const allowFraming = (csp) => csp.split(',')
  .map((policy) => policy.split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d)).join('; '))
  .filter(Boolean).join(', ');

function responseHeaders(headers, s, raw) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP.has(k) || k === 'x-frame-options') continue;
    if (k === 'content-security-policy' || k === 'content-security-policy-report-only') {
      const csp = allowFraming(String(v));
      if (csp) h[k] = csp;
    } else if (k === 'location') {
      h[k] = rewriteLocation(String(v), s, raw);
    } else {
      h[k] = v;
    }
  }
  return h;
}

// Redirects to the upstream itself (or to a root-absolute path) are kept inside /preview/<id>/.
function rewriteLocation(loc, s, raw) {
  const prefix = `/preview/${s.project_id}`;
  let u;
  try { u = new URL(loc, 'http://upstream.invalid/'); } catch { return loc; }
  if (/^([a-z][a-z\d+.-]*:)?\/\//i.test(loc)) {
    const own = [`localhost:${s.port}`, `127.0.0.1:${s.port}`, `[::1]:${s.port}`, raw.headers['x-forwarded-host'], raw.headers.host];
    if (!own.includes(u.host)) return loc; // a real external redirect
  } else if (!loc.startsWith('/')) {
    return loc; // relative: already resolves under the prefix
  }
  const p = u.pathname + u.search + u.hash;
  return p === prefix || p.startsWith(`${prefix}/`) ? p : prefix + p;
}

function proxyHttp(raw, res, s, upstreamPath) {
  const up = http.request({ host: s.host, port: s.port, method: raw.method, path: upstreamPath, headers: forwardHeaders(raw, s) }, (ur) => {
    try {
      res.writeHead(ur.statusCode, ur.statusMessage || undefined, responseHeaders(ur.headers, s, raw));
    } catch {
      ur.destroy();
      return res.destroy();
    }
    ur.on('error', () => res.destroy());
    ur.pipe(res);
  });
  up.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    page(raw, res, 502, 'Preview not responding', `Could not reach the project on port ${s.port} (${e.code || e.message}).`);
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  raw.pipe(up);
}

function proxyUpgrade(raw, socket, s, upstreamPath) {
  // @fastify/websocket keeps the bytes that arrived with the upgrade request on the raw request.
  const headKey = Object.getOwnPropertySymbols(raw).find((k) => k.description === 'ws-head');
  const head = (headKey && raw[headKey]) || Buffer.alloc(0);
  const up = http.request({ host: s.host, port: s.port, method: raw.method, path: upstreamPath, headers: forwardHeaders(raw, s, true) });
  socket.on('error', () => up.destroy());
  up.on('upgrade', (ur, upSocket, upHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (let i = 0; i < ur.rawHeaders.length; i += 2) lines.push(`${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    const close = () => { socket.destroy(); upSocket.destroy(); };
    for (const x of [socket, upSocket]) {
      x.setTimeout(0);
      x.setNoDelay(true);
      x.on('error', close);
      x.on('close', close);
    }
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on('response', (ur) => { ur.resume(); refuseUpgrade(socket, ur.statusCode); });
  up.on('error', () => socket.destroy());
  up.end();
}
