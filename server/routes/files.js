import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { audit } from '../services/notify.js';

const TEXT_LIMIT = 5 * 1024 * 1024;
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.json': 'application/json', '.html': 'text/html', '.txt': 'text/plain',
};

const abs = (p) => path.resolve(String(p || os.homedir()).replace(/^~(?=$|\/)/, os.homedir()));

function bad(reply, code, message) {
  return reply.code(code).send({ error: message });
}

async function entry(dir, name) {
  const full = path.join(dir, name);
  try {
    const l = await fsp.lstat(full);
    const isLink = l.isSymbolicLink();
    const s = isLink ? await fsp.stat(full).catch(() => l) : l;
    return { name, path: full, type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs, link: isLink, ext: s.isDirectory() ? '' : path.extname(name).slice(1).toLowerCase(), hidden: name.startsWith('.') };
  } catch {
    return { name, path: full, type: 'file', size: 0, mtime: 0, broken: true, ext: '' };
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function uniqueTarget(dest) {
  if (!fs.existsSync(dest)) return dest;
  const { dir, name, ext } = path.parse(dest);
  for (let i = 1; ; i++) {
    const cand = path.join(dir, `${name} copy${i > 1 ? ` ${i}` : ''}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
}

export default async function filesRoutes(app) {
  app.get('/api/fs/list', async (req, reply) => {
    const dir = abs(req.query.path);
    try {
      const names = await fsp.readdir(dir);
      const entries = await Promise.all(names.map((n) => entry(dir, n)));
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
      return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries };
    } catch (err) {
      return bad(reply, err.code === 'ENOENT' ? 404 : 400, err.message);
    }
  });

  // Directory completion for path inputs and the project path picker.
  app.get('/api/fs/complete', async (req) => {
    const raw = String(req.query.q || '');
    const input = raw.replace(/^~(?=$|\/)/, os.homedir());
    const dir = input.endsWith('/') ? input : path.dirname(input) || '/';
    const prefix = input.endsWith('/') ? '' : path.basename(input);
    try {
      const names = await fsp.readdir(dir, { withFileTypes: true });
      return names
        .filter((d) => d.isDirectory() && d.name.startsWith(prefix) && (prefix.startsWith('.') || !d.name.startsWith('.')))
        .slice(0, 40)
        .map((d) => path.join(dir, d.name) + '/');
    } catch {
      return [];
    }
  });

  app.get('/api/fs/read', async (req, reply) => {
    const file = abs(req.query.path);
    try {
      const s = await fsp.stat(file);
      if (s.isDirectory()) return bad(reply, 400, 'Is a directory');
      const ext = path.extname(file).toLowerCase();
      const mime = MIME[ext] || null;
      if (mime && /^(image|video|audio)\/|pdf/.test(mime) && ext !== '.svg') return { path: file, size: s.size, mtime: s.mtimeMs, binary: true, mime };
      if (s.size > TEXT_LIMIT) return { path: file, size: s.size, mtime: s.mtimeMs, tooLarge: true };
      const buf = await fsp.readFile(file);
      if (looksBinary(buf)) return { path: file, size: s.size, mtime: s.mtimeMs, binary: true, mime: mime || 'application/octet-stream' };
      return { path: file, size: s.size, mtime: s.mtimeMs, content: buf.toString('utf8'), mime };
    } catch (err) {
      return bad(reply, 404, err.message);
    }
  });

  app.get('/api/fs/raw', async (req, reply) => {
    const file = abs(req.query.path);
    try {
      const s = await fsp.stat(file);
      reply.header('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      reply.header('content-length', s.size);
      if (req.query.download) reply.header('content-disposition', `attachment; filename="${encodeURIComponent(path.basename(file))}"`);
      return reply.send(fs.createReadStream(file));
    } catch (err) {
      return bad(reply, 404, err.message);
    }
  });

  app.post('/api/fs/write', async (req, reply) => {
    const { path: p, content = '', expectedMtime } = req.body || {};
    const file = abs(p);
    try {
      if (expectedMtime) {
        const s = await fsp.stat(file).catch(() => null);
        if (s && Math.abs(s.mtimeMs - expectedMtime) > 1) return bad(reply, 409, 'File changed on disk since it was opened');
      }
      await fsp.writeFile(file, content);
      await audit('user', 'fs.write', file);
      const s = await fsp.stat(file);
      return { ok: true, mtime: s.mtimeMs, size: s.size };
    } catch (err) {
      return bad(reply, 400, err.message);
    }
  });

  app.post('/api/fs/create', async (req, reply) => {
    const { dir, name, type = 'file' } = req.body || {};
    if (!name || /[/\\]/.test(name) || name === '.' || name === '..') return bad(reply, 400, 'Invalid name');
    const target = path.join(abs(dir), name);
    if (fs.existsSync(target)) return bad(reply, 409, 'Already exists');
    try {
      if (type === 'dir') await fsp.mkdir(target, { recursive: true });
      else await fsp.writeFile(target, '', { flag: 'wx' });
      await audit('user', `fs.create.${type}`, target);
      return { ok: true, path: target };
    } catch (err) {
      return bad(reply, 400, err.message);
    }
  });

  app.post('/api/fs/rename', async (req, reply) => {
    const { path: p, name } = req.body || {};
    if (!name || /[/\\]/.test(name)) return bad(reply, 400, 'Invalid name');
    const from = abs(p);
    const to = path.join(path.dirname(from), name);
    if (fs.existsSync(to)) return bad(reply, 409, 'A file with that name already exists');
    try {
      await fsp.rename(from, to);
      await audit('user', 'fs.rename', from, { to });
      return { ok: true, path: to };
    } catch (err) {
      return bad(reply, 400, err.message);
    }
  });

  app.post('/api/fs/transfer', async (req, reply) => {
    const { sources = [], dest, mode = 'copy' } = req.body || {};
    const destDir = abs(dest);
    const results = [];
    for (const src of sources.map(abs)) {
      if (destDir === src || destDir.startsWith(src + path.sep)) { results.push({ src, error: 'Cannot place a folder inside itself' }); continue; }
      let target = path.join(destDir, path.basename(src));
      if (mode === 'move' && path.dirname(src) === destDir) { results.push({ src, skipped: true }); continue; }
      target = await uniqueTarget(target);
      try {
        if (mode === 'move') {
          await fsp.rename(src, target).catch(async (err) => {
            if (err.code !== 'EXDEV') throw err;
            await fsp.cp(src, target, { recursive: true });
            await fsp.rm(src, { recursive: true, force: true });
          });
        } else {
          await fsp.cp(src, target, { recursive: true, errorOnExist: true });
        }
        results.push({ src, target });
      } catch (err) {
        results.push({ src, error: err.message });
      }
    }
    await audit('user', `fs.${mode}`, destDir, { count: sources.length });
    return { results };
  });

  app.post('/api/fs/delete', async (req, reply) => {
    const { paths = [] } = req.body || {};
    const results = [];
    for (const p of paths.map(abs)) {
      if (p === '/' || p === os.homedir() || p.split(path.sep).filter(Boolean).length < 2) { results.push({ path: p, error: 'Refusing to delete a top-level directory' }); continue; }
      try {
        await fsp.rm(p, { recursive: true, force: false });
        results.push({ path: p, ok: true });
      } catch (err) {
        results.push({ path: p, error: err.message });
      }
    }
    await audit('user', 'fs.delete', paths.join(', ').slice(0, 500));
    return { results };
  });

  app.post('/api/fs/upload', async (req, reply) => {
    const dir = abs(req.query.dir);
    const saved = [];
    try {
      for await (const part of req.files()) {
        const rel = String(part.filename || 'upload').replace(/\\/g, '/').split('/').filter((s) => s && s !== '..').join('/');
        const target = await uniqueTarget(path.join(dir, rel));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await pipeline(part.file, fs.createWriteStream(target));
        saved.push(target);
      }
      return { saved };
    } catch (err) {
      return bad(reply, 400, err.message);
    }
  });
}
