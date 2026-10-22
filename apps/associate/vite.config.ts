import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时把 /api（含 WebSocket）转发到后端；生产构建由后端从根路径提供，同源访问。
// 浏览器内演示模式（--mode demo）不需要后端：门店中枢作为 SharedWorker 在浏览器里运行，
// 另外构建标签页面、模拟器用的桥接页面和展示页。
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify(mode === 'demo' ? '1' : '') },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        label: resolve(__dirname, 'label.html'),
        bridge: resolve(__dirname, 'bridge.html'),
        showcase: resolve(__dirname, 'showcase.html'),
      },
    },
  },
  worker: { format: 'es' },
  server: {
    port: 5174,
    host: true,
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
  preview: {
    port: 4174,
    host: true,
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
}));
