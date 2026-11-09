import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 模拟器网页：纯静态文件（base: './'，可以放到任意子路径）；仿真在 Web Worker 里跑。
// root 用绝对路径：从仓库根目录或 StoreX 目录启动都可以
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  base: './',
  worker: { format: 'es' },
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 900 },
  server: { port: 5180, strictPort: false },
});
