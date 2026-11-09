import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The yard demo: a static page (relative base, so it works under any sub-path, e.g. site/yard/ on the live demo).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: { outDir: fileURLToPath(new URL('../dist-demo', import.meta.url)), emptyOutDir: true, target: 'es2022' },
  server: { port: 5190, strictPort: false },
});
