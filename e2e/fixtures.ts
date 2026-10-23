import { test as base } from '@playwright/test';

/**
 * 端到端测试共用的 test：项目设置了 metadata.noSharedWorker 时，所有页面（包括 iframe）都当作不支持 SharedWorker 的浏览器
 * （较旧的安卓 Chrome 等），演示要走「每个页面一个专用 Worker、展示页把端口交给 iframe」的退路。
 */
export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    if ((testInfo.project.metadata as { noSharedWorker?: boolean } | undefined)?.noSharedWorker) {
      await context.addInitScript(() => {
        Object.defineProperty(window, 'SharedWorker', { value: undefined, configurable: true, writable: true });
      });
    }
    await use(context);
  },
});

export { expect } from '@playwright/test';
