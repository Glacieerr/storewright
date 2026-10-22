import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * 全流程走查（npm run walkthrough）：真实后端（中型超市 + 家居建材店）、浏览器内演示站点、模拟器，
 * 逐个流程操作并截图，结果写入 experiments/results/walkthrough/，再由 scripts/walkthrough-report.mjs 生成图文报告。
 * 先构建：npm run build:all
 */
const channel = process.env.PW_CHANNEL ?? 'chrome';
const dataDir = mkdtempSync(join(tmpdir(), 'storewright-walkthrough-'));

export default defineConfig({
  testDir: './e2e/walkthrough',
  testMatch: /\.walk\.ts$/,
  // 只在开始时清空一次结果目录（工作进程重启时不会再清）
  globalSetup: './e2e/walkthrough/setup.ts',
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { ...(channel ? { channel } : {}), locale: 'zh-CN', actionTimeout: 20_000 },
  outputDir: 'experiments/results/walkthrough-artifacts',
  webServer: [
    {
      command: 'node node_modules/tsx/dist/cli.mjs apps/server/src/main.ts',
      url: 'http://127.0.0.1:8798/api/health',
      env: { PORT: '8798', HOST: '127.0.0.1', DATA_DIR: dataDir, TICK_MS: '2000', RELEASE_MS: '600000', STORES: 'demo,hardware' },
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/static-server.mjs',
      url: 'http://127.0.0.1:4178/app/index.html',
      env: { PORT: '4178' },
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});
