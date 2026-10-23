import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { createOrders, signIn, state, until, type AnyState } from './helpers';

/** 双线并行（决策记录 0013）：自动运营的虚拟顾客和虚拟员工做一条线，你在手机上做另一条线，分开批次、分开行程，共用暂存区和货架 */
test('12 双线并行：自动运营与你的操作', async ({ browser }) => {
  const r = new Recorder('双线并行：自动运营与你的操作', 12);
  const con = await signIn(browser, 'console');
  const picker = await signIn(browser, 'Avery');
  const card = con.locator('.card.autopilot');

  await r.step('控制台的「自动运营（双线并行）」卡片：每小时订单、作业速度、开始 / 停止', async () => {
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText('已停止');
    return (await card.locator('.note').first().innerText()).trim();
  }, { shot: con, device: '控制台' });

  await r.step('开始自动运营（每小时 160 单、作业速度 4 倍）：虚拟顾客下单，虚拟员工开始作业', async () => {
    await card.getByLabel('每小时订单').selectOption('160');
    await card.getByLabel('作业速度').selectOption('4');
    await card.getByRole('button', { name: '开始自动运营' }).click();
    await expect(card).toContainText('运行中');
    await until(con, (s) => Object.values(s.orders as Record<string, AnyState>).some((o) => o.track === 'AUTO'), 30_000);
    await con.waitForTimeout(6000);
    return (await card.locator('.auto-workers').innerText()).replace(/\n/g, '；');
  }, { shot: con, device: '控制台' });

  await r.step('你这条线：控制台下一张自己的订单，拣货员手机只显示这张订单的批次（自动运营的批次不在手机上）', async () => {
    const [o] = await createOrders(con, { type: 'PICKUP', count: 1, lines: 3 });
    await until(picker, (s) => Object.values(s.walks as Record<string, AnyState>).some((w) => w.toteIds.some((t: string) => s.totes[t]?.orderId === o?.orderId)));
    const s = await state(picker);
    const all = Object.values(s.walks as Record<string, AnyState>).filter((w) => w.status === 'OPEN');
    const auto = all.filter((w) => w.track === 'AUTO').length;
    const cards = await picker.locator('.walk-card').count();
    expect(cards).toBe(all.length - auto);
    return `可领取的批次：手机上 ${cards} 个；作业核心里另有自动运营的 ${auto} 个（由虚拟员工处理）`;
  }, { shot: picker, device: '拣货员手机' });

  await r.step('等自动运营做完几张订单：虚拟顾客到店、虚拟交付员核验取货码并交付', async () => {
    await until(con, (s) => Object.values(s.orders as Record<string, AnyState>).filter((o) => o.track === 'AUTO' && o.status === 'COMPLETED').length >= 3, 180_000);
    await con.waitForTimeout(2500);
    return (await card.locator('.note').nth(1).innerText()).trim();
  }, { shot: con, device: '控制台' });

  await r.step('分开批次、分开行程：每个批次、每个行程要么全是自动运营的订单，要么一张都没有', async () => {
    const s = await state(con);
    const isAuto = (orderId: string) => s.orders[orderId]?.track === 'AUTO';
    for (const w of Object.values(s.walks as Record<string, AnyState>)) expect(new Set(w.toteIds.map((t: string) => isAuto(s.totes[t]?.orderId))).size).toBe(1);
    for (const tr of Object.values(s.trips as Record<string, AnyState>)) expect(new Set(tr.orderIds.map((id: string) => isAuto(id))).size).toBe(1);
    const autoTrips = Object.values(s.trips as Record<string, AnyState>).filter((tr) => tr.orderIds.every(isAuto));
    return `批次 ${Object.keys(s.walks).length} 个、行程 ${Object.keys(s.trips).length} 个，没有混在一起；自动运营的配送行程 ${autoTrips.length} 个（已交接 ${autoTrips.filter((x) => x.completedAt).length} 个）`;
  });

  await r.step('控制台的订单列表默认只列你的订单；勾选后也显示自动运营的订单', async () => {
    const list = con.locator('.card', { hasText: '进行中的订单' });
    const before = (await list.locator('h2').innerText()).trim();
    await list.getByLabel(/显示自动运营的订单/).check();
    await con.waitForTimeout(800);
    const after = (await list.locator('h2').innerText()).trim();
    await list.scrollIntoViewIfNeeded();
    return `${before} → ${after}`;
  }, { shot: con, device: '控制台' });

  await r.step('区域管理：自动运营让暂存区、包裹区等区域的占用变化，超过预警线的区域标红', async () => {
    const box = con.locator('.card', { hasText: '区域管理' });
    await box.scrollIntoViewIfNeeded();
    return (await box.locator('.note').first().innerText()).trim();
  }, { shot: con, device: '控制台', fullPage: false });

  await r.step('停止自动运营', async () => {
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: '停止自动运营' }).click();
    await expect(card).toContainText('已停止');
  }, { shot: con, device: '控制台' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
