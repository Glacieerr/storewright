import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * 真实后端上的多浏览器端到端测试：每个身份一个独立的浏览器上下文（相当于不同的手机），
 * 扫码用键盘输入 + 回车模拟（与硬件扫码枪相同）。标签上的编码从页面的实时状态里读（相当于看实物标签）。
 */

type AnyState = {
  orders: Record<string, { id: string; shortCode: string; status: string; toteIds: string[]; lines: Array<{ ageRestricted: boolean }> }>;
  totes: Record<string, { id: string; labelId?: string; status: string; orderId: string }>;
  walks: Record<string, { id: string; status: string; toteIds: string[] }>;
  recs: Record<string, { id: string; status: string; module: string }>;
  repl: Record<string, { id: string; itemId: string; locationId: string; status: string }>;
  shelf: Record<string, { est: number }>;
};

async function signIn(browser: Browser, who: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/?debug');
  if (who === 'console') await page.getByRole('button', { name: /演示控制台/ }).click();
  else await page.getByRole('button', { name: new RegExp(who) }).click();
  await expect(page.locator('.link-state.live')).toBeVisible();
  return page;
}

const state = (p: Page) => p.evaluate(() => (window as unknown as { __swa: { state: unknown } }).__swa.state) as Promise<AnyState>;

async function scan(page: Page, label: string, code: string): Promise<void> {
  const box = page.getByLabel(label, { exact: true });
  await box.fill(code);
  await box.press('Enter');
}

test('一张自取订单在四台设备上走完：下单 → 拣货 → 暂存 → 到店 → 交付', async ({ browser }) => {
  const consolePage = await signIn(browser, 'console');
  const picker = await signIn(browser, 'Avery');
  const stager = await signIn(browser, 'Riley');
  const handoff = await signIn(browser, 'Morgan');

  // 控制台下单（立即锁单并生成拣货批次）；验证码只返回给控制台
  await consolePage.getByLabel('每单最多商品行').fill('3');
  const [res] = await Promise.all([consolePage.waitForResponse((r) => r.url().endsWith('/demo/orders')), consolePage.getByRole('button', { name: '创建', exact: true }).click()]);
  const { orders } = (await res.json()) as { orders: Array<{ orderId: string; shortCode: string; code: string }> };
  const order = orders[0] as { orderId: string; shortCode: string; code: string };

  // 拣货：逐个领取包含这张订单的批次，扫框标签绑定，逐行拣货
  await expect(picker.getByText(/可以领取的批次/)).toBeVisible();
  for (let guard = 0; guard < 4; guard++) {
    const s = await state(picker);
    const walk = Object.values(s.walks).find((w) => w.status === 'OPEN' && w.toteIds.some((id) => s.totes[id]?.orderId === order.orderId));
    if (!walk) break;
    await picker.locator('.tabbar button').filter({ hasText: '拣货' }).click();
    await picker.locator('.card', { hasText: walk.id }).getByRole('button', { name: '领取这个批次' }).click();
    for (const id of walk.toteIds) await scan(picker, '扫描框上的标签', s.totes[id]?.labelId ?? '');
    // 逐行点「已拣到」，每次等进度变化后再点下一行（拣货进度「已拣 N / M 件」）
    const picked = async () => Number(/已拣 (\d+)/.exec(await picker.locator('main').innerText())?.[1] ?? 0);
    for (let i = 0; i < 40 && !(await picker.getByRole('button', { name: '完成拣货，去暂存' }).isVisible()); i++) {
      const before = await picked();
      await picker.getByRole('button', { name: /^已拣到/ }).click();
      await expect.poll(async () => (await picker.getByRole('button', { name: '完成拣货，去暂存' }).isVisible()) || (await picked()) > before).toBe(true);
    }
    await picker.getByRole('button', { name: '完成拣货，去暂存' }).click();
  }
  await expect.poll(async () => Object.values((await state(stager)).totes).filter((t) => t.orderId === order.orderId && t.status === 'PICKED').length).toBeGreaterThan(0);

  // 暂存：另一台设备逐框扫描，放进建议的格位
  await stager.locator('.tabbar button').filter({ hasText: '暂存' }).click();
  const toStage = Object.values(await state(stager).then((s) => s.totes)).filter((t) => t.orderId === order.orderId);
  for (const t of toStage) {
    await scan(stager, '扫描框标签', t.labelId ?? '');
    await stager.locator('.chip.mono').first().click();
  }
  await expect.poll(async () => (await state(handoff)).orders[order.orderId]?.status).toBe('STAGED');

  // 顾客到店（控制台代替顾客签到）
  await consolePage.locator('tr', { hasText: order.shortCode }).getByRole('button', { name: '到店' }).click();
  await expect(handoff.locator('.board-row.c-blue')).toBeVisible();

  // 交付：输入订单短号打开，逐框扫描，核验取货码，完成交付
  await handoff.locator('.tabbar button').filter({ hasText: '交付' }).click();
  await scan(handoff, '扫描任意一个框，或输入订单短号', order.shortCode);
  await handoff.getByRole('button', { name: '开始准备' }).click();
  const s = await state(handoff);
  for (const id of s.orders[order.orderId]?.toteIds ?? []) await scan(handoff, '逐框扫描', s.totes[id]?.labelId ?? '');
  await handoff.getByLabel('验证码').fill(order.code);
  await handoff.getByRole('button', { name: '核验', exact: true }).click();
  if (s.orders[order.orderId]?.lines.some((l) => l.ageRestricted)) await handoff.getByRole('button', { name: /确认/ }).first().click();
  await handoff.getByRole('button', { name: '完成交付' }).click();

  // 四台设备都看到订单已完成
  for (const p of [consolePage, picker, stager, handoff]) await expect.poll(async () => (await state(p)).orders[order.orderId]?.status).toBe('COMPLETED');
});

test('带班负责人在 AI 页处理订单量预测建议，控制台同步看到结果', async ({ browser }) => {
  const consolePage = await signIn(browser, 'console');
  const lead = await signIn(browser, 'Taylor');
  // 控制台立即发出一次预测（每小时也会自动发出）
  await consolePage.getByRole('tab', { name: /AI/ }).click();
  await consolePage.getByRole('tab', { name: '模型' }).click();
  await consolePage.getByRole('button', { name: '立即预测' }).click();
  await lead.locator('.tabbar button').filter({ hasText: 'AI' }).click();
  // 按标题找订单量预测的卡片：别的卡片也会写「接下来…」（上面的「订单量展望」；下午积压时排在前面的运营预警，理由里有「接下来 2 小时还会来约 N 单」）
  const card = lead.locator('.ai-rec', { hasText: /接下来 \d+ 小时的订单量/ }).first();
  await expect(card).toBeVisible();
  // 同一个后端上别的浏览器可能已经采纳过一条：要看这次多了一条
  const accepted = async () => Object.values((await state(consolePage)).recs).filter((r) => r.module === 'FORECAST' && r.status === 'ACCEPTED').length;
  const before = await accepted();
  await card.getByRole('button', { name: '有用' }).click();
  await expect.poll(accepted).toBe(before + 1);
});

test('补货闭环：控制台让货架变空 → 系统生成补货任务 → 补货员取箱上架 → 货架估算恢复', async ({ browser }) => {
  const consolePage = await signIn(browser, 'console');
  const restocker = await signIn(browser, 'Robin');
  const select = consolePage.getByLabel('让这个商品的货架变空');
  const itemId = await select.locator('option').nth(1).getAttribute('value');
  await select.selectOption(itemId ?? '');
  await consolePage.getByRole('button', { name: '让货架变空', exact: true }).click();
  await expect.poll(async () => Object.values((await state(restocker)).repl).some((r) => r.itemId === itemId && r.status === 'OPEN')).toBe(true);

  // 补货员：库存 → 补货，领取这一批，按取箱清单取齐整批的箱子（决策记录 0026），再按货位逐个扫描货位标签上架
  await restocker.locator('.tabbar button').filter({ hasText: '库存' }).click();
  await restocker.getByRole('button', { name: '领取这一批' }).first().click();
  await expect.poll(async () => Object.values((await state(restocker)).repl).some((r) => r.status === 'CLAIMED')).toBe(true);
  const task = Object.values((await state(restocker)).repl).find((r) => r.itemId === itemId);
  const claimed = Object.values((await state(restocker)).repl).filter((r) => r.status === 'CLAIMED');
  for (let i = 0; i < claimed.length; i++) {
    const row = restocker.locator('.batch-cases .row-btn:not([disabled])').first();
    if (!(await row.count())) break;
    await row.click();
  }
  for (const current of claimed) {
    await scan(restocker, '扫描箱子或货位标签', current.locationId);
    const done = restocker.getByRole('button', { name: '完成上架' });
    if (!(await done.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false))) continue;
    await done.click();
    await expect.poll(async () => (await state(restocker)).repl[current.id]?.status).not.toBe('CLAIMED');
  }
  await expect.poll(async () => (await state(consolePage)).repl[task?.id ?? '']?.status).toBe('DONE');
  await expect.poll(async () => (await state(consolePage)).shelf[itemId ?? '']?.est ?? 0).toBeGreaterThan(0);
});


test('退货的硬性规则：冷藏商品的「可售回架」按钮不可用并说明原因，AI 建议也不会是回架', async ({ browser }) => {
  const lead = await signIn(browser, 'Taylor');
  await lead.locator('.tabbar button').filter({ hasText: '扩展' }).click();
  await lead.getByRole('tab', { name: '退货' }).click();
  await lead.getByRole('button', { name: '开始退货' }).click();
  const cold = await lead.evaluate(() => (window as unknown as { __swa: { statics: { planogram: Array<{ gtin: string; tempZone: string }> } } }).__swa.statics.planogram.find((p) => p.tempZone === 'CHILLED')?.gtin ?? '');
  await scan(lead, '扫描退回的商品', cold);
  const card = lead.locator('.card', { hasText: '未开封' }).last();
  await expect(card.getByText('冷藏、冷冻、热食退回后一律不能回架')).toBeVisible();
  await expect(card.getByRole('button', { name: '可售回架' })).toBeDisabled();
  await expect(card.getByText(/AI 建议：/)).toBeVisible();
  await expect(card.getByText('AI 建议：可售回架')).toHaveCount(0);
  await card.getByRole('button', { name: '报废' }).click();
  await expect(card.locator('.tag.ok', { hasText: '报废' })).toBeVisible();
});
