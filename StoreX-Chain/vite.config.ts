import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 区域三维孪生网页：纯静态文件（base: './'）；仿真在 Web Worker 里跑。root 用绝对路径，从仓库根目录或本目录启动都可以
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  base: './',
  worker: { format: 'es' },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    // three.js 单独一块（和应用代码并行下载；应用更新时浏览器缓存里的这一块还能用）；导出器按需加载，不放进来
    rollupOptions: { output: { manualChunks: (id) => (id.includes('/node_modules/three/') && !id.includes('/exporters/') ? 'three' : undefined) } },
  },
  server: { port: 5182, strictPort: false },
});
