/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * The loading screen shows before any script runs, so its dog and toy frames are written
 * into index.html as data URIs: no request, and the dog runs from the first paint.
 * (index.html can't link ../assets directly in development.)
 */
function loaderArt(): Plugin {
  const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
  // [CSS property, file in assets/dog]: the dog, and the toy it chases.
  const frames = [
    ['dog-idle-1', 'dog_idle_1'],
    ...range(4).map(i => [`dog-run-${i}`, `dog_run_${i}`]),
    ...range(7).map(i => [`dog-jump-${i}`, `dog_jump_${i}`]),
    ...range(8).map(i => [`toy-${i}`, `toy${i}`]),
    ['toy-held', 'toy_held'],
  ];
  return {
    name: 'loader-art',
    transformIndexHtml(html) {
      const properties = frames.map(([property, name]) => {
        const file = new URL(`../assets/dog/${name}.png`, import.meta.url);
        return `--${property}: url(data:image/png;base64,${readFileSync(file).toString('base64')});`;
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
