import { expect, type Page } from '@playwright/test';
import { Recorder } from './recorder';
import { SITE, test } from './helpers';

const app = (p: Page, fn: string) => p.evaluate(`(() => { const s = window.__sw.useApp.getState(); return (${fn})(s); })()`);

/** 「你的商店」（决策记录 0013、0027）：从零搭建自己的门店 → 编辑 → 开业检查 → 全天仿真 → 复制、导出 → 实时沙盒 */
test('15 你的商店', async ({ browser }) => {
  const r = new Recorder('你的商店', 15);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));

  await r.step('顶栏的「你的商店」：项目页（门店保存在这台电脑的浏览器里，数量不限）', async () => {
    await p.goto('/sim/?debug');
    await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });
    await p.getByRole('button', { name: '你的商店', exact: true }).click();
    await expect(p.locator('.your-store')).toBeVisible();
    return (await p.locator('.ys-empty').innerText()).trim();
  }, { shot: p, device: '电脑' });

  await r.step('新建门店：名称、行业、建筑宽度和进深（占地）、楼层、暂存规模、卸货门、取货车位、营业时间、附属设施', async () => {
    await p.getByRole('button', { name: '新建门店' }).click();
    const w = p.locator('.ys-wizard');
    await w.getByLabel('名称').fill('社区生鲜店');
    await w.locator('input[type=range]').first().fill('64');
    await w.locator('input[type=range]').nth(1).fill('38');
    await w.getByLabel('药房').check();
    return (await w.locator('.ys-area').innerText()).trim();
  }, { shot: p, device: '电脑' });

  await r.step('生成并开始搭建：按占地找到最接近的通道数和货架段数，生成一家能运行的门店，进入编辑器；顶栏下方是项目栏', async () => {
    await p.getByRole('button', { name: '生成并开始搭建' }).click();
    await expect(p.locator('.project-bar')).toBeVisible({ timeout: 30_000 });
    await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });
    await p.waitForTimeout(2000);
    const f = (await app(p, '(s) => s.config.layout.floors[0]')) as { widthM: number; depthM: number };
    return `生成的一楼 ${f.widthM.toFixed(1)} × ${f.depthM.toFixed(1)} 米（想要 64 × 38）；${String(await app(p, "(s) => s.config.layout.runs.filter((r) => r.kind === 'AISLE').length"))} 条通道`;
  }, { shot: p, device: '电脑' });

  await r.step('搭建步骤「后仓与收货区域」：打开编辑器里的区域与卸货门', async () => {
    await p.locator('.pb-steps').getByRole('button', { name: /后仓与收货区域/ }).click();
    await p.waitForTimeout(1200);
    await expect(p.locator('.area-editor')).toBeInViewport();
  }, { shot: p, device: '电脑' });

  await r.step('开业检查：配置问题、必需区域、冷链存储、暂存格位和取货车位够不够、卸货门、后仓托盘位', async () => {
    await p.locator('.pb-steps').getByRole('button', { name: /开业检查/ }).click();
    const d = p.locator('.golive');
    await expect(d).toBeVisible();
    const head = (await d.locator('p').first().innerText()).trim();
    const items = (await d.locator('li').allInnerTexts()).map((x) => x.replace(/\n/g, ' ')).join('；');
    return `${head} ${items}`.slice(0, 600);
  }, { shot: p, device: '电脑' });

  await r.step('完成搭建，跑全天仿真（修改已经自动保存到这台电脑的浏览器）', async () => {
    await p.getByRole('button', { name: '知道了' }).click();
    await p.getByRole('button', { name: '完成搭建，跑全天仿真' }).click();
    await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });
    await p.waitForTimeout(2500);
    return (await p.locator('.pb-saved').innerText()).trim();
  }, { shot: p, device: '电脑' });

  await r.step('回到「我的门店」：门店卡片（行业、尺寸、楼层、通道数、最近修改）和操作', async () => {
    await p.locator('.project-bar').getByRole('button', { name: '我的门店' }).click();
    await expect(p.locator('.ys-card')).toHaveCount(1);
    return (await p.locator('.ys-card').innerText()).replace(/\n/g, ' ');
  }, { shot: p, device: '电脑' });

  await r.step('复制门店：门店数量不限，复制出的门店排在前面，方便在副本上试另一种方案', async () => {
    await p.locator('.ys-card').getByRole('button', { name: '复制' }).click();
    await expect(p.locator('.ys-card')).toHaveCount(2);
    return (await p.locator('.ys-card h3').allInnerTexts()).join('、');
  }, { shot: p, device: '电脑' });

  await r.step('导出门店文件：下载 .storewright.json，换电脑或换浏览器时用「导入门店文件」导回来', async () => {
    const [file] = await Promise.all([p.waitForEvent('download'), p.locator('.ys-card').first().getByRole('button', { name: '导出' }).click()]);
    expect(file.suggestedFilename()).toMatch(/\.storewright\.json$/);
    return file.suggestedFilename();
  });

  const id = String(await p.evaluate(`new Promise((res) => { const r = indexedDB.open('storewright-projects', 1); r.onsuccess = () => { const g = r.result.transaction('projects').objectStore('projects').getAll(); g.onsuccess = () => res(g.result.find((x) => x.name === '社区生鲜店').id); }; })`));
  const sc = await ctx.newPage();
  await r.step('实时沙盒：浏览器里的门店中枢按你搭的门店建店；控制台、两部手机和数字孪生都连到这家门店', async () => {
    await sc.goto(`/app/showcase.html?project=${encodeURIComponent(id)}&layout=split`);
    await expect(sc.locator('.sc-head h1')).toContainText('社区生鲜店', { timeout: 60_000 });
    await expect(sc.frameLocator('iframe.sc-sim').locator('.live-chip', { hasText: '社区生鲜店' })).toBeVisible({ timeout: 120_000 });
    await expect(sc.frameLocator('.phone iframe').first().locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
    await sc.waitForTimeout(3000);
    return (await sc.locator('.sc-head p').innerText()).trim();
  }, { shot: sc, device: '电脑' });

  await r.step('在你的门店里下单：拣货员手机出现批次', async () => {
    await sc.frameLocator('iframe.sc-console').getByRole('button', { name: '创建', exact: true }).click();
    await expect(sc.frameLocator('.phone iframe').first().getByText(/可以领取的批次/)).toBeVisible({ timeout: 30_000 });
    await sc.waitForTimeout(1500);
  }, { shot: sc, device: '电脑' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
