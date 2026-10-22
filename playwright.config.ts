import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * 多浏览器端到端测试（决策记录 0010 第 7 节：代替真机验收）。
 * - live：真实后端（嵌入式数据库，每次运行用新的数据目录）+ 员工端构建；每个身份一个独立的浏览器上下文；
 * - demo：浏览器内演示站点（静态文件），同一个上下文里的几个页面共用浏览器里的门店中枢。
 * 先构建：npm run build:associate && npm run build:demo && npm run build:sim
 * 本机默认用已安装的 Chrome（不下载浏览器）；持续集成里设置 PW_CHANNEL= 使用 Playwright 自带的 Chromium。
 */
const channel = process.env.PW_CHANNEL ?? 'chrome';
const dataDir = mkdtempSync(join(tmpdir(), 'storewright-e2e-'));

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'experiments/results/e2e-report' }]] : 'list',
  use: {
    ...(channel ? { channel } : {}),
    viewport: { width: 420, height: 860 },
    locale: 'zh-CN',
    trace: 'retain-on-failure',
  },
  outputDir: 'experiments/results/e2e-artifacts',
  webServer: [
    {
      command: 'node node_modules/tsx/dist/cli.mjs apps/server/src/main.ts',
      url: 'http://127.0.0.1:8799/api/health',
      env: { PORT: '8799', HOST: '127.0.0.1', DATA_DIR: dataDir, TICK_MS: '2000', RELEASE_MS: '600000' },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/static-server.mjs',
      url: 'http://127.0.0.1:4177/app/index.html',
      env: { PORT: '4177' },
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
  projects: [
    { name: 'live', testMatch: /live\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:8799' } },
    { name: 'demo', testMatch: /demo\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:4177' } },
  ],
});
