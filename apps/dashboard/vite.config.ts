import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the SPA on :5173 and proxies /api + webhooks to the Fastify server on :3000.
// Prod: `vite build` outputs to ../server/public/dashboard, served by @fastify/static.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public/dashboard',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
