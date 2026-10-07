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
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: apiProxy(),
  },
  // `vite preview` serves the real production build, which is the only way to
  // exercise the service worker and the install prompt locally (both are
  // compiled out of dev). It needs the same API proxy to be usable at all.
  preview: {
    port: 4173,
    proxy: apiProxy(),
  },
});

/** DEV_API_TARGET points at a non-local backend (e.g. the deployed host). */
function apiProxy(): Record<string, string> {
  const target = process.env.DEV_API_TARGET ?? 'http://localhost:3000';
  return { '/api': target, '/files': target };
}
