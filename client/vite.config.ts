/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * The loading screen shows before any script runs, so its dog frames are written
 * into index.html as data URIs: no request, and the dog runs from the first paint.
 * (index.html can't link ../assets directly in development.)
 */
function loaderArt(): Plugin {
  const frames = ['idle_1', ...[1, 2, 3, 4].map(i => `run_${i}`), ...[1, 2, 3, 4, 5, 6, 7].map(i => `jump_${i}`)];
  return {
    name: 'loader-art',
    transformIndexHtml(html) {
      const properties = frames.map(frame => {
        const file = new URL(`../assets/dog/dog_${frame}.png`, import.meta.url);
        return `--dog-${frame.replace('_', '-')}: url(data:image/png;base64,${readFileSync(file).toString('base64')});`;
      });
      return html.replace('<!-- loader-art -->', `<style>:root { ${properties.join(' ')} }</style>`);
    },
  };
}

export default defineConfig({
  // All artwork lives in ../assets and is imported (see src/art.ts), so nothing is
  // copied by path: the build holds only used files, content-hashed or inlined.
  publicDir: false,
  plugins: [loaderArt()],
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
