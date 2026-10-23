import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 「你的商店」是在线版的付费部分，代码在私有仓库（本机放在 private/your-store-app）；
// 有就打包进来，没有就用空实现（公开仓库的构建照常，只是没有这个板块）
const privateYourStore = fileURLToPath(new URL('../../private/your-store-app/src/index.tsx', import.meta.url));
// SW_PUBLIC_ONLY=1：即使本机有私有模块，也按公开仓库的样子构建（检查公开版本、给 README 截图；决策记录 0015）
const withPrivate = !process.env.SW_PUBLIC_ONLY && existsSync(privateYourStore);
const yourStoreModule = withPrivate ? privateYourStore : fileURLToPath(new URL('./src/yourStoreStub.ts', import.meta.url));

// 构建产物是纯静态文件，可以部署到任意子路径（base: './'）
// 第三方库按用途分包：React 与状态管理、three.js、React Three Fiber 生态，便于浏览器缓存；
// 三维场景和几个标签页在代码里按需加载
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: 'virtual:your-store', replacement: yourStoreModule },
      { find: /^@sim\//, replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}` },
    ],
  },
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
