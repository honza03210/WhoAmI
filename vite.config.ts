import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  // Photo packs are generated into public/packs and served as static assets.
  publicDir: '../public',
  // .env lives at the repo root, not in client/.
  envDir: '..',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // cloudflared hands out a random *.trycloudflare.com hostname; without this Vite
    // rejects it as an unrecognised Host header and the activity shows a blank frame.
    allowedHosts: true,
    proxy: {
      // Mirrors production, where the Worker owns /api and the asset layer owns the rest.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
