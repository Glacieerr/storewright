import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { Recorder } from './recorder';
import { SITE } from './helpers';

const app = (p: Page, fn: string) => p.evaluate(`(() => { const s = window.__sw.useApp.getState(); return (${fn})(s); })()`);
// 「你的商店」在私有模块里（在线版的付费部分）；公开仓库里没有时跳过整个部分
const PRIVATE_MODULE = 'private/your-store-app/src/index.tsx';
// 测试授权码只在作者的电脑上；没有时跳过专业版的步骤
const LICENSE = 'private/your-store-app/keys/test-license.txt';

/** 「你的商店」（决策记录 0013）：从零搭建自己的门店 → 编辑 → 开业检查 → 全天仿真；专业版：实时沙盒 */
test('15 你的商店', async ({ browser }) => {
  test.skip(!existsSync(PRIVATE_MODULE), '「你的商店」的私有模块不在这台电脑上');
  const r = new Recorder('你的商店', 15);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));

  await r.step('顶栏的「你的商店」：项目页（免费版可以搭建并运行一家门店）', async () => {
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

  await r.step('免费版只能保存一家门店：再点「新建门店」时提示专业版', async () => {
    await p.getByRole('button', { name: '新建门店' }).click();
    await expect(p.locator('.ys-modal')).toBeVisible();
    return (await p.locator('.ys-modal-card p').first().innerText()).trim();
  }, { shot: p, device: '电脑' });

  if (!existsSync(LICENSE)) {
    r.note('专业版', '没有测试授权码（private/ 只在作者的电脑上），跳过实时沙盒的步骤');
  } else {
    await r.step('购买 / 授权提示：一次性购买、不需要账号；输入测试授权码激活专业版（测试授权码只在本机有效）', async () => {
      await p.locator('#ys-license').fill(readFileSync(LICENSE, 'utf8').trim());
      await p.getByRole('button', { name: '激活' }).click();
      await expect(p.locator('.ys-plan.pro')).toBeVisible();
      return (await p.locator('.ys-plan').innerText()).trim();
    }, { shot: p, device: '电脑' });

    const id = String(await p.evaluate(`new Promise((res) => { const r = indexedDB.open('storewright-projects', 1); r.onsuccess = () => { const g = r.result.transaction('projects').objectStore('projects').getAll(); g.onsuccess = () => res(g.result[0].id); }; })`));
    const sc = await ctx.newPage();
    await r.step('实时沙盒：浏览器里的门店中枢按你搭的门店建店；控制台、两部手机和门店实况都连到这家门店', async () => {
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
  }
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
