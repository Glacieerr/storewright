import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物是纯静态文件，可以部署到任意子路径（base: './'）
// 第三方库按用途分包：React 与状态管理、three.js、React Three Fiber 生态，便于浏览器缓存；
// 三维场景、「你的商店」和几个标签页在代码里按需加载
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite 的预加载小工具单独成块，否则会落进 three 相关的块，让首页也去下载 three.js
          if (id.includes('vite/preload-helper')) return 'preload';
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/three\//.test(id)) return 'three';
          if (/node_modules\/(@react-three|three-stdlib|troika|@monogrid|maath|camera-controls|suspend-react|its-fine|zustand\/.*shallow)/.test(id)) return 'r3f';
          if (/node_modules\/(react|react-dom|scheduler|zustand)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  server: { port: 5173, strictPort: false },
});
