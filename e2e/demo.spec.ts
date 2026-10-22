import { expect, test } from '@playwright/test';

/**
 * 浏览器内演示站点（静态文件，没有后端）：门店中枢在 SharedWorker 里运行，
 * 同一个浏览器上下文里的页面（标签页、iframe）共用一家店。
 */

test('两个标签页通过浏览器里的门店中枢实时同步；标签页面可以打开', async ({ context }) => {
  const consolePage = await context.newPage();
  await consolePage.goto('/app/?as=console');
  await expect(consolePage.getByRole('heading', { name: '创建测试订单' })).toBeVisible({ timeout: 60_000 });
  await consolePage.getByRole('button', { name: '创建', exact: true }).click();
  await expect(consolePage.getByText('已创建 1 张订单')).toBeVisible();

  const picker = await context.newPage();
  await picker.goto('/app/?as=A01');
  await expect(picker.getByText(/可以领取的批次/)).toBeVisible();
  await picker.getByRole('button', { name: '领取这个批次' }).first().click();
  await expect(picker.getByText(/第 1 步：给框贴标签并扫描/)).toBeVisible();
  // 控制台同步看到批次已被领取
  await expect.poll(() => consolePage.locator('.kpi, .stat, .card').filter({ hasText: '拣货批次' }).count()).toBeGreaterThan(0);

  const href = await picker.getByRole('link', { name: '打印本批标签' }).getAttribute('href');
  expect(href).toContain('label.html#');
  const label = await context.newPage();
  await label.goto(`/app/${href?.replace(/^\.\//, '')}`);
  await expect.poll(() => label.locator('svg').count()).toBeGreaterThan(0);
});

test('展示页：模拟器经过桥接页面连到同一个中枢，员工手机和控制台都在线', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/app/showcase.html');
  const frames = page.locator('iframe');
  await expect(frames).toHaveCount(4);
  const sim = page.frameLocator('iframe.sc-sim');
  await expect(sim.locator('.live-chip', { hasText: '已连接' })).toBeVisible({ timeout: 90_000 });
  const phone = page.frameLocator('.phone iframe').first();
  await expect(phone.locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
  // 控制台下单后，模拟器的门店实况里出现订单
  const con = page.frameLocator('iframe.sc-console');
  await con.getByRole('button', { name: '创建', exact: true }).click();
  await expect(sim.locator('.live-chip', { hasText: /今日订单 1/ })).toBeVisible();
});

test('家居建材店（第二个行业）也能在浏览器里打开，没有熟食模块', async ({ page }) => {
  await page.goto('/app/?as=console&store=hardware');
  await expect(page.getByText('Home improvement store')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('每单加一件大件（2 件）')).toBeVisible();
  await expect(page.getByText('每单加一份熟食现做')).toHaveCount(0);
});

test('展示页的引导按实时状态打勾；关闭所有页面后数据还在；重置清空门店', async ({ context }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/app/showcase.html');
  const con = page.frameLocator('iframe.sc-console');
  await expect(con.getByRole('heading', { name: '创建测试订单' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.sc-steps li').first()).toHaveClass(/current/);
  await con.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('.sc-steps li').first()).toHaveClass(/done/);
  await expect(page.locator('.sc-steps li').nth(1)).toHaveClass(/current/);

  // 关闭这个网站的所有页面（中枢随之结束），再打开：从浏览器存储恢复
  await page.close();
  const blank = await context.newPage();
  await blank.waitForTimeout(1500);
  const again = await context.newPage();
  await again.setViewportSize({ width: 1440, height: 900 });
  await blank.close();
  await again.goto('/app/showcase.html');
  await expect(again.locator('.sc-steps li').first()).toHaveClass(/done/, { timeout: 60_000 });
  await expect(again.frameLocator('iframe.sc-console').getByText('进行中的订单（1）')).toBeVisible();

  again.on('dialog', (d) => void d.accept());
  await again.getByRole('button', { name: '重置演示门店' }).click();
  await expect(again.frameLocator('iframe.sc-console').getByText('进行中的订单（0）')).toBeVisible();
  await expect(again.locator('.sc-steps li').first()).toHaveClass(/current/);
});

test('窄屏的展示页一次显示一个画面，用标签切换', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/showcase.html');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(4);
  await expect(page.locator('iframe.sc-console')).toBeVisible();
  await expect(page.locator('.phone').first()).toBeHidden();
  await page.getByRole('tab', { name: '手机 1' }).click();
  await expect(page.locator('.phone').first()).toBeVisible();
  await expect(page.locator('iframe.sc-console')).toBeHidden();
  await expect(page.frameLocator('.phone iframe').first().locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
});
