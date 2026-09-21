import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the SPA on :5173 and proxies /api + webhooks to the Fastify server on :3000.
// Prod (default): `vite build` outputs to ../server/public/dashboard, served by @fastify/static.
// Prod (Vercel): VERCEL=1 is set by the platform → build into local dist/ instead.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: process.env.VERCEL ? 'dist' : '../server/public/dashboard',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
