import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { SITE } from './helpers';

/** 浏览器内演示（纯静态网站，没有后端）：展示页、引导、数据保存、重置、手机布局、英文、标签页面、建材店 */
test('09 浏览器内演示与展示页', async ({ browser }) => {
  const r = new Recorder('浏览器内演示与展示页', 9);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const page = await ctx.newPage();

  await r.step('打开网站首页：跳到展示页；模拟器、控制台和两部手机都连上浏览器里的门店中枢', async () => {
    const t0 = Date.now();
    await page.goto('/');
    await expect(page).toHaveURL(/showcase\.html/);
    await expect(page.frameLocator('iframe.sc-sim').locator('.live-chip', { hasText: '已连接' })).toBeVisible({ timeout: 90_000 });
    await expect(page.frameLocator('.phone iframe').first().locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
    return `从打开到全部在线 ${((Date.now() - t0) / 1000).toFixed(1)} 秒（第一次打开时在浏览器里建店并训练 AI 模型）`;
  }, { shot: page, device: '电脑' });

  await r.step('跟着引导做：控制台下单 → 引导第 1 步打勾，提示下一步', async () => {
    const con = page.frameLocator('iframe.sc-console');
    await con.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.locator('.sc-steps li').first()).toHaveClass(/done/);
    return (await page.locator('.sc-hint').innerText()).trim();
  }, { shot: page, device: '电脑' });

  await r.step('第一部手机（拣货员）同步出现批次；模拟器门店实况出现订单', async () => {
    await expect(page.frameLocator('.phone iframe').first().getByText(/可以领取的批次/)).toBeVisible();
    await expect(page.frameLocator('iframe.sc-sim').locator('.live-chip', { hasText: /今日订单 1/ })).toBeVisible();
  }, { shot: page, device: '电脑' });

  await r.step('关闭这个网站的所有页面再打开：门店和引导进度都还在（保存在浏览器里）', async () => {
    await page.close();
    const blank = await ctx.newPage();
    await blank.waitForTimeout(1500);
    const again = await ctx.newPage();
    await blank.close();
    await again.goto('/app/showcase.html');
    await expect(again.locator('.sc-steps li').first()).toHaveClass(/done/, { timeout: 60_000 });
    await expect(again.frameLocator('iframe.sc-console').getByText('进行中的订单（1）')).toBeVisible();
    await again.screenshot({ path: 'experiments/results/walkthrough/shots/09-reopen.png' });
    again.on('dialog', (d) => void d.accept());
    await again.getByRole('button', { name: '重置演示门店' }).click();
    await expect(again.frameLocator('iframe.sc-console').getByText('进行中的订单（0）')).toBeVisible();
    await again.close();
    return '重新打开后订单还在；点「重置演示门店」后清空，引导回到第 1 步';
  });

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', baseURL: SITE, isMobile: true, hasTouch: true });
  const m = await phone.newPage();
  await r.step('手机上的展示页：引导在上方，用标签切换控制台 / 手机 1 / 手机 2 / 模拟器', async () => {
    await m.goto('/app/showcase.html');
    await expect(m.frameLocator('iframe.sc-console').getByRole('heading', { name: '创建测试订单' })).toBeVisible({ timeout: 60_000 });
  }, { shot: m, device: '手机' });
  for (const name of ['手机 1', '模拟器']) {
    await r.step(`手机上切换到「${name}」`, async () => {
      await m.getByRole('tab', { name }).click();
      await m.waitForTimeout(name === '模拟器' ? 4000 : 1500);
    }, { shot: m, device: '手机' });
  }

  const en = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', baseURL: SITE });
  const e = await en.newPage();
  await r.step('英文界面的展示页', async () => {
    await e.goto('/app/showcase.html');
    await e.evaluate(() => {
      localStorage.setItem('storewright.associate.lang', 'en');
      localStorage.setItem('storewright.lang', 'en');
    });
    await e.reload();
    await expect(e.getByText(/Walk through it|跟着做一遍/)).toBeVisible({ timeout: 30_000 });
    await e.waitForTimeout(3000);
  }, { shot: e, device: '电脑' });

  await r.step('家居建材店的展示页（?store=hardware）：模拟器换成建材店的布局', async () => {
    await e.goto('/app/showcase.html?store=hardware');
    await expect(e.frameLocator('iframe.sc-sim').locator('.live-chip', { hasText: /Connected|已连接/ })).toBeVisible({ timeout: 90_000 });
    await e.waitForTimeout(3000);
  }, { shot: e, device: '电脑' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
