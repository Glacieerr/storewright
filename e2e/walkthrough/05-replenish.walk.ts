import { expect } from '@playwright/test';
import { Recorder } from './recorder';
import { accept, restockClaimed, signIn, state, tab, until, test, type AnyState } from './helpers';

/**
 * 补货与幽灵库存：
 * - 系统知道货架空了 → 补货任务 → 补货员取箱上架；
 * - 系统不知道（放错位置 / 损耗）→ 顾客购物仿真持续卖货，这个商品「该卖没卖」→ AI 可售概率下降 → 派出核对货架（默认自动执行，决策记录 0026）→ 记录 0 件 → 补货任务。
 */
test('05 补货与幽灵库存', async ({ browser }) => {
  const r = new Recorder('补货与幽灵库存', 5);
  const con = await signIn(browser, 'console');
  const restock = await signIn(browser, 'Robin');
  const lead = await signIn(browser, 'Taylor');
  let itemId = '';

  await r.step('控制台让一个商品的货架变空（系统知道）', async () => {
    const select = con.getByLabel('让这个商品的货架变空');
    itemId = (await select.locator('option').nth(1).getAttribute('value')) ?? '';
    const label = await select.locator('option').nth(1).innerText();
    await select.selectOption(itemId);
    await con.getByRole('button', { name: '让货架变空', exact: true }).click();
    await until(con, (s) => Object.values(s.repl as Record<string, AnyState>).some((x) => x.itemId === itemId && x.status === 'OPEN'));
    return label;
  }, { shot: con, device: '控制台' });

  await r.step('补货员的「补货」页按区域成批显示任务（理由、建议件数）', async () => {
    await tab(restock, '库存');
    await expect(restock.getByRole('button', { name: '领取这一批' }).first()).toBeVisible();
    return (await restock.locator('main').innerText()).split('\n').slice(0, 10).join(' · ');
  }, { shot: restock, device: '补货员手机' });

  await r.step('领取一批 → 按取箱清单一趟取齐整批的箱子 → 按货位顺序扫描货位标签 → 上架', async () => {
    await restock.getByRole('button', { name: '领取这一批' }).first().click();
    await until(restock, (s) => Object.values(s.repl as Record<string, AnyState>).some((x) => x.status === 'CLAIMED'));
    const done = await restockClaimed(restock);
    const s = await state(con);
    return `完成 ${done} 个补货任务；${itemId} 货架估算 ${Math.round(s.shelf[itemId]?.est ?? 0)} 件`;
  }, { shot: restock, device: '补货员手机' });

  let phantom = '';
  // 商品名（选项文字是「名称 · 货位」）：购物仿真里别的商品也可能被 AI 标出来，按名字找这个商品的卡片
  let phantomName = '';
  await r.step('开始顾客购物仿真（600 倍速），让一个卖得快、没有货架传感器的商品「系统不知道地」变空', async () => {
    await con.getByLabel('仿真速度').selectOption('600');
    await con.getByRole('button', { name: '开始顾客购物仿真' }).click();
    const select = con.getByLabel('让这个商品的货架变空');
    // 选一个没有货架传感器的商品：有传感器的商品变空时传感器会直接报告，不需要 AI 推断
    const opts = await select.locator('option').evaluateAll((os) => os.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent ?? '' })));
    const pick = opts.slice(2).find((o) => o.value && !/· (tof|weight)$/.test(o.label.trim())) ?? opts[2];
    phantom = pick?.value ?? '';
    const label = pick?.label ?? '';
    phantomName = label.split(' · ')[0]?.trim() ?? '';
    await select.selectOption(phantom);
    await con.getByLabel('系统不知道（放错位置 / 损耗），等拣货员或传感器发现').check();
    await con.getByRole('button', { name: '让货架变空', exact: true }).click();
    return `${label}：真实存量 0，系统估算仍按原来的数量`;
  }, { shot: con, device: '控制台' });

  await r.step('AI 发现「该卖没卖」：带班负责人在模型页立即检查，出现「可能不在货架上」的建议（理由：多久没卖出、按平时应卖出几件）', async () => {
    await tab(lead, 'AI');
    const t0 = Date.now();
    let found = false;
    while (Date.now() - t0 < 240_000 && !found) {
      await lead.getByRole('tab', { name: '模型' }).click();
      await lead.getByRole('button', { name: '立即检查货架与盘点风险' }).click();
      await lead.waitForTimeout(4000);
      const s = await state(lead);
      // 核对货架默认自动执行（决策记录 0026）：建议发出时就派出了核对任务；改成需确认时卡片等带班负责人采纳
      found = Object.values(s.recs as Record<string, AnyState>).some((x) => x.module === 'AVAILABILITY' && x.target === phantom && (x.status === 'OPEN' || x.status === 'AUTO_APPLIED'));
      if (!found) await lead.waitForTimeout(8000);
    }
    await lead.getByRole('tab', { name: '建议' }).click();
    if (!found) throw new Error(`240 秒内没有出现这个商品的建议（仿真时间约 ${Math.round(((Date.now() - t0) / 1000) * 600 / 3600)} 小时）`);
    const card = lead.locator('.ai-rec').filter({ hasText: '可能不在货架上' }).filter({ hasText: phantomName }).first();
    const open = await card.isVisible();
    if (open) await card.scrollIntoViewIfNeeded();
    const text = open ? (await card.innerText()).replace(/\n/g, ' ').slice(0, 300) : (await lead.locator('.ai-history li', { hasText: phantomName }).first().innerText().catch(() => '')).replace(/\n/g, ' ');
    return `${Math.round((Date.now() - t0) / 1000)} 秒（仿真约 ${Math.round(((Date.now() - t0) / 1000) * 600 / 3600)} 小时）后出现；${text}`;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('派出「核对货架」任务：核对默认自动执行（最近处理里写「已自动执行」）；模块改成需确认时由带班负责人采纳', async () => {
    const card = lead.locator('.ai-rec').filter({ hasText: '可能不在货架上' }).filter({ hasText: phantomName }).first();
    if (await card.isVisible()) await accept(card);
    await until(lead, (s) => Object.values(s.checks as Record<string, AnyState>).some((c) => c.itemId === phantom && c.status === 'OPEN'));
    const s = await state(lead);
    const rec = Object.values(s.recs as Record<string, AnyState>).find((x) => x.module === 'AVAILABILITY' && x.target === phantom);
    return `建议 ${rec?.id ?? ''}：${rec?.status ?? ''}；核对任务已派给补货员`;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('补货员去核对：到货位，货架上实际 0 件 → 提交 → 系统修正估算并安排补货', async () => {
    await tab(restock, '库存');
    await restock.getByRole('tab', { name: /补货/ }).click();
    await restock.locator('.card', { hasText: 'AI：可能不在货架上' }).filter({ hasText: phantomName }).first().getByRole('button', { name: '去核对' }).click();
    await restock.getByRole('button', { name: /手动确认已到货位/ }).click();
    // 数量直接输入（决策记录 0026）
    await restock.getByLabel('货架上有几件').fill('0');
    await restock.getByRole('button', { name: '提交数量' }).click();
    await until(restock, (s) => Object.values(s.repl as Record<string, AnyState>).some((x) => x.itemId === phantom));
    const s = await state(restock);
    return `估算改为 ${Math.round(s.shelf[phantom]?.est ?? 0)} 件；补货任务 ${Object.values(s.repl as Record<string, AnyState>).filter((x) => x.itemId === phantom).length} 个`;
  }, { shot: restock, device: '补货员手机' });

  await r.step('打开「自动补货」：虚拟补货员按优先级处理补货任务（长时间演示时缺货不会越积越多）', async () => {
    await con.getByLabel(/自动补货：虚拟补货员/).check();
    await until(con, (s) => Object.values(s.repl as Record<string, AnyState>).some((x) => x.associateId === 'auto-restock' && x.status === 'DONE'), 30_000);
    await expect(con.locator('.note', { hasText: '自动补货' }).first()).toBeVisible();
    const s = await state(con);
    const done = Object.values(s.repl as Record<string, AnyState>).filter((x) => x.associateId === 'auto-restock' && x.status === 'DONE');
    const open = Object.values(s.repl as Record<string, AnyState>).filter((x) => x.status === 'OPEN').length;
    const phantomTask = Object.values(s.repl as Record<string, AnyState>).find((x) => x.itemId === phantom);
    return `自动补货完成 ${done.length} 个任务，还有 ${open} 个开放；刚才核对出来的补货任务：${phantomTask ? `${phantomTask.status}${phantomTask.associateId ? `（${phantomTask.associateId}）` : ''}` : '无'}`;
  }, { shot: con, device: '控制台' });

  await r.step('停止顾客购物仿真（控制台显示已售、缺货少卖、损耗和传感器读数）', async () => {
    await con.getByRole('button', { name: '停止顾客购物仿真' }).click();
    return (await con.locator('.note', { hasText: '已售' }).first().innerText()).trim();
  }, { shot: con, device: '控制台' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
