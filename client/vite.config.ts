import { defineConfig } from 'vite';

export default defineConfig({
  // All artwork lives in ../assets and is imported (see src/art.ts), so nothing is
  // copied by path: the build holds only used files, content-hashed or inlined.
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    // assets/ and world.json sit beside client/, outside Vite's default dev root.
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000' },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
});
