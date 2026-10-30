import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = `http://127.0.0.1:${process.env.PORT || 4800}`;

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, ws: true },
      '/uploads': api,
      '/preview': { target: api, ws: true }, // project previews (dev servers proxied by the API, HMR sockets included)
    },
  },
});
