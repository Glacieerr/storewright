import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

/**
 * 多浏览器端到端测试（决策记录 0010 第 7 节：代替真机验收）。
 * - live：真实后端（嵌入式数据库，每次运行用新的数据目录）+ 员工端构建；每个身份一个独立的浏览器上下文；
 * - demo：浏览器内演示站点（静态文件），同一个上下文里的几个页面共用浏览器里的门店中枢。
 * 先构建：npm run build:associate && npm run build:demo && npm run build:sim
 * 本机默认用已安装的 Chrome（不下载浏览器）；持续集成里设置 PW_CHANNEL= 使用 Playwright 自带的 Chromium。
 * PW_ALL=1（npm run e2e:browsers）时再加：Safari 内核（WebKit）、Firefox、不支持 SharedWorker 的浏览器（较旧的安卓 Chrome），
 * 以及 iPhone 和安卓手机上的窄屏场景（需要先 npx playwright install webkit firefox）。
 * PW_SOFTWARE_GL=1：Chromium 关掉显卡加速、在 CPU 上软件渲染 WebGL，和持续集成的机器一样，用来在本机复现那里的慢。
 */
const channel = process.env.PW_CHANNEL ?? 'chrome';
const softwareGl = process.env.PW_SOFTWARE_GL ? { launchOptions: { args: ['--disable-gpu', '--enable-unsafe-swiftshader'] } } : {};
// 本机的 Chrome 只用于 Chromium 项目（WebKit、Firefox 不能指定 channel）
const chrome = { ...(channel ? { channel } : {}), ...softwareGl };
const dataDir = mkdtempSync(join(tmpdir(), 'storewright-e2e-'));

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  // 持续集成的机器慢（没有显卡，4 核 CPU）：等待上限放宽到 30 秒
  expect: { timeout: process.env.CI ? 30_000 : 15_000 },
  fullyParallel: false,
  workers: 1,
  // 持续集成的机器慢、波动大：失败的用例再跑一次，报告里标成 flaky（不稳定），方便以后查
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'experiments/results/e2e-report' }]] : 'list',
  use: {
    viewport: { width: 420, height: 860 },
    locale: 'zh-CN',
    // 持续集成里只在失败重跑时录 trace：录屏和页面快照很耗 CPU
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
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
    { name: 'live', testMatch: /live\.spec\.ts/, use: { ...chrome, baseURL: 'http://127.0.0.1:8799' } },
    { name: 'demo', testMatch: /demo\.spec\.ts/, use: { ...chrome, baseURL: 'http://127.0.0.1:4177' } },
    { name: 'a11y', testMatch: /a11y\.spec\.ts/, use: { ...chrome, baseURL: 'http://127.0.0.1:4177' } },
    ...(process.env.PW_ALL ? otherBrowsers() : []),
  ],
});

/** 其他浏览器和手机（不用本机的 Chrome，用 Playwright 自带的浏览器） */
function otherBrowsers(): Project[] {
  const live = { testMatch: /live\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:8799' } };
  const demo = { testMatch: /demo\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:4177' } };
  const narrow = /窄屏|手机宽度/;
  return [
    { name: 'live-webkit', ...live, use: { ...live.use, browserName: 'webkit' } },
    { name: 'demo-webkit', ...demo, use: { ...demo.use, browserName: 'webkit' } },
    { name: 'live-firefox', ...live, use: { ...live.use, browserName: 'firefox' } },
    { name: 'demo-firefox', ...demo, use: { ...demo.use, browserName: 'firefox' } },
    { name: 'demo-no-sharedworker', ...demo, metadata: { noSharedWorker: true }, use: { ...chrome, ...demo.use } },
    { name: 'iphone', ...demo, grep: narrow, use: { ...devices['iPhone 14'], ...demo.use } },
    { name: 'android', ...demo, grep: narrow, metadata: { noSharedWorker: true }, use: { ...devices['Pixel 7'], ...chrome, ...demo.use } },
  ];
}
