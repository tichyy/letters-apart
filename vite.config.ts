import { defineConfig } from 'vite';

export default defineConfig({
  // Keep the supplied artwork in one place, in development and production.
  publicDir: 'assets',
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
});
