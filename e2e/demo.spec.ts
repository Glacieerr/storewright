import { existsSync } from 'node:fs';
import { expect, test } from './fixtures';

/**
 * 浏览器内演示站点（静态文件，没有后端）：门店中枢在 SharedWorker 里运行，
 * 同一个浏览器上下文里的页面（标签页、iframe）共用一家店。
 */

test('两个标签页通过浏览器里的门店中枢实时同步；标签页面可以打开', async ({ context }, testInfo) => {
  const consolePage = await context.newPage();
  await consolePage.goto('/app/?as=console');
  await expect(consolePage.getByRole('heading', { name: '创建测试订单' })).toBeVisible({ timeout: 60_000 });
  await consolePage.getByRole('button', { name: '创建', exact: true }).click();
  await expect(consolePage.getByText('已创建 1 张订单')).toBeVisible();

  const picker = await context.newPage();
  await picker.goto('/app/?as=A01');
  if ((testInfo.project.metadata as { noSharedWorker?: boolean } | undefined)?.noSharedWorker) {
    // 不支持 SharedWorker 的浏览器：第二个标签页的门店是单独的，页面上说明原因（多设备同步请用展示页，见决策记录 0015）
    await expect(picker.locator('.demo-banner.isolated')).toBeVisible({ timeout: 60_000 });
    return;
  }
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
  await page.goto('/app/showcase.html?layout=split');
  // 门店实况、控制台、全天仿真（第一次切换时才加载）、两部手机
  const frames = page.locator('iframe');
  await expect(frames).toHaveCount(5);
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

test('自动运营（双线并行）：虚拟员工领取自动运营的批次，员工手机上不显示它们', async ({ context }) => {
  const con = await context.newPage();
  await con.goto('/app/?demo&store=demo&as=console&debug');
  const card = con.locator('.card.autopilot');
  await expect(card).toBeVisible({ timeout: 90_000 });
  await card.getByLabel('每小时订单').selectOption('160');
  await card.getByLabel('作业速度').selectOption('4');
  await card.getByRole('button', { name: '开始自动运营' }).click();
  await expect
    .poll(async () => con.evaluate(() => Object.values((window as unknown as { __swa: { state: { walks: Record<string, { track?: string; associateId?: string }> } } }).__swa.state.walks).some((w) => w.track === 'AUTO' && w.associateId?.startsWith('V-'))), { timeout: 60_000 })
    .toBe(true);
  const phone = await context.newPage();
  await phone.goto('/app/?demo&store=demo&as=A01&debug');
  await expect(phone.locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
  // 手机上一个自动运营的批次也没有
  await expect(phone.locator('.walk-card')).toHaveCount(0);
  await card.getByRole('button', { name: '停止自动运营' }).click();
  await expect(card).toContainText('已停止');
});

test('你的商店：新建门店 → 编辑器 → 开业检查；免费版的实时沙盒提示专业版', async ({ page }) => {
  // 「你的商店」是在线版的付费部分，代码在私有仓库；公开仓库的持续集成里没有它
  test.skip(!existsSync('private/your-store-app/src/index.tsx'), '没有「你的商店」的私有模块');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));
  await page.goto('/sim/?yours');
  await page.getByRole('button', { name: '新建门店' }).click();
  await page.locator('.ys-wizard').getByLabel('名称').fill('E2E Store');
  await page.getByRole('button', { name: '生成并开始搭建' }).click();
  await expect(page.locator('.project-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pb-name')).toHaveValue('E2E Store');
  await page.locator('.pb-steps').getByRole('button', { name: /开业检查/ }).click();
  await expect(page.locator('.golive')).toContainText('可以开业');
  await page.getByRole('button', { name: '知道了' }).click();
  await page.locator('.project-bar').getByRole('button', { name: '实时沙盒' }).click();
  // 免费版：打开项目页并直接提示专业版
  await expect(page.locator('.your-store')).toBeVisible();
  await expect(page.locator('.ys-modal')).toContainText('专业版');
  // 关掉提示后，门店卡片上的「实时沙盒」也会提示
  await page.locator('.ys-modal').getByRole('button', { name: '以后再说' }).click();
  await expect(page.locator('.ys-modal')).toHaveCount(0);
  await page.locator('.ys-card').getByRole('button', { name: '实时沙盒' }).click();
  await expect(page.locator('.ys-modal')).toContainText('专业版');
});

test('手机宽度的模拟器：顶栏收成一行，点「设置」展开其余控件；场景占屏幕的大部分，没有横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));
  await page.goto('/sim/');
  const bar = page.locator('.topbar');
  const toggle = bar.getByRole('button', { name: '设置' });
  await expect(toggle).toBeVisible();
  await expect(bar.getByRole('combobox', { name: '策略' })).toBeHidden();
  expect((await bar.boundingBox())!.height).toBeLessThan(60);
  const stage = (await page.locator('.stage').boundingBox())!;
  expect(stage.height / 812).toBeGreaterThan(0.6);
  await toggle.click();
  await expect(bar.getByRole('combobox', { name: '策略' })).toBeVisible();
  await expect(bar.getByRole('button', { name: '编辑布局' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
