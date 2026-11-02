import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = `http://127.0.0.1:${process.env.PORT || 4800}`;

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

// Writes .br and .gz next to every text asset of the build, so server/index.js serves them compressed with no CPU per
// request (@fastify/static preCompressed). A plugin, not a script: the supervisor runs `vite build` directly.
function precompress() {
  let outDir;
  return {
    name: 'af-precompress',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    async closeBundle() {
      const files = fs.readdirSync(outDir, { recursive: true }).map((f) => path.join(outDir, f))
        .filter((f) => /\.(js|mjs|css|svg|json|txt|wasm)$/.test(f) && fs.statSync(f).size >= 1024);
      await Promise.all(files.map(async (f) => {
        const raw = fs.readFileSync(f);
        const [br, gz] = await Promise.all([
          brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
          gzip(raw, { level: 9 }),
        ]);
        if (br.length < raw.length) fs.writeFileSync(`${f}.br`, br);
        if (gz.length < raw.length) fs.writeFileSync(`${f}.gz`, gz);
      }));
    },
  };
}

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss(), precompress()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  server: {
    port: 5173,
    host: process.env.HOST || '0.0.0.0', // reachable from other computers like the API (HOST=127.0.0.1 keeps it local)
    allowedHosts: true, // any IP or hostname; /api still needs a session
    proxy: {
      '/api': { target: api, ws: true },
      '/uploads': api,
      '/preview': { target: api, ws: true }, // project previews (dev servers proxied by the API, HMR sockets included)
    },
  },
});
