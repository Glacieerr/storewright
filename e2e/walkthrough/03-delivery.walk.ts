import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { createOrders, pickOrders, scan, signIn, stageOrders, state, tab, until, type AnyState } from './helpers';

/** 配送：两张配送订单组成一个行程 → 司机接单（验证码）→ 拣货暂存 → 司机到店 → 整个行程一次核验、记录车内位置、交付 */
test('03 配送行程', async ({ browser }) => {
  const r = new Recorder('配送行程', 3);
  const con = await signIn(browser, 'console');
  const picker = await signIn(browser, 'Jordan');
  const stager = await signIn(browser, 'Riley');
  const handoff = await signIn(browser, 'Casey');
  let ids: string[] = [];
  let tripId = '';
  let driverCode = '';

  await r.step('控制台下 2 张配送订单（立即锁单，时段在 40 分钟后）', async () => {
    const os = await createOrders(con, { type: 'DELIVERY', count: 2, lines: 3 });
    ids = os.map((o) => o.orderId);
    const s = await state(con);
    return os.map((o) => `${o.shortCode}（${o.name}，目的地 ${JSON.stringify(s.orders[o.orderId].destinationKm ?? {})} km）`).join('；');
  }, { shot: con, device: '控制台' });

  await r.step('拣货：两张订单的全部批次', async () => {
    const n = await pickOrders(picker, ids);
    return `${n} 行`;
  }, { shot: picker, device: '拣货员手机' });

  await r.step('暂存：配送订单放进配送区的格位', async () => {
    const slots = await stageOrders(stager, ids);
    return `格位：${[...new Set(slots)].join('、')}`;
  }, { shot: stager, device: '暂存员手机' });

  await r.step('订单暂存后，排程按目的地和车辆容量组成配送行程（工程约束 EC-6：先暂存再组行程）', async () => {
    await until(con, (s) => Object.values(s.trips as Record<string, AnyState>).some((t) => t.orderIds.some((id: string) => ids.includes(id))), 30_000);
    const s = await state(con);
    const trip = Object.values(s.trips as Record<string, AnyState>).find((t) => t.orderIds.some((id: string) => ids.includes(id)));
    tripId = trip.id;
    // 时段临近时先等同一时段还在拣货、暂存的订单，两张订单组成一趟
    expect(trip.orderIds.length).toBe(2);
    ids = trip.orderIds;
    return `行程 ${trip.id}：${trip.orderIds.length} 单（${trip.orderIds.map((id: string) => s.orders[id].shortCode).join('、')}），建议车内位置 ${JSON.stringify(trip.placements)}`;
  }, { shot: con, device: '控制台', fullPage: true });

  await r.step('司机接单：控制台代替司机，生成司机的取货验证码', async () => {
    await con.locator('.trip-list li', { hasText: tripId }).getByRole('button', { name: '司机接单' }).click();
    await expect(con.locator('.trip-list li', { hasText: tripId })).toContainText('司机验证码');
    driverCode = /司机验证码 (\S+)/.exec(await con.locator('.trip-list li', { hasText: tripId }).innerText())?.[1] ?? '';
    return `司机验证码 ${driverCode}`;
  }, { shot: con, device: '控制台' });

  await r.step('司机到店：交付看板显示这个行程（多单一起）', async () => {
    await con.locator('.trip-list li', { hasText: tripId }).getByRole('button', { name: '司机到店' }).click();
    await tab(handoff, '交付');
    await expect(handoff.locator('.board-row', { hasText: '行程' }).first()).toBeVisible();
    return (await handoff.locator('.board-row', { hasText: '行程' }).first().innerText()).replace(/\n/g, ' ');
  }, { shot: handoff, device: '交付员手机' });

  await r.step('打开行程，开始准备，逐框扫描', async () => {
    await handoff.locator('.board-row', { hasText: '行程' }).first().click();
    await handoff.getByRole('button', { name: '开始准备' }).click();
    const s = await state(handoff);
    let n = 0;
    for (const id of ids) for (const tid of s.orders[id].toteIds) if (s.totes[tid]?.status === 'STAGED') {
      await scan(handoff, '逐框扫描', s.totes[tid].labelId);
      n++;
    }
    return `${n} 个框`;
  }, { shot: handoff, device: '交付员手机' });

  await r.step('核验司机验证码（整个行程一次）；系统已按目的地建议每单在车里的位置，员工可以改', async () => {
    await expect(handoff.getByLabel('验证码')).toBeVisible();
    await handoff.getByLabel('验证码').fill(driverCode);
    await handoff.getByRole('button', { name: '核验' }).click();
    if (await handoff.getByRole('button', { name: '已核验证件' }).isVisible()) await handoff.getByRole('button', { name: '已核验证件' }).click();
    const groups = handoff.getByRole('radiogroup', { name: '车内位置' });
    await expect(groups.first()).toBeVisible();
    await groups.first().getByRole('button', { name: '副驾' }).click();
    await expect(handoff.getByRole('button', { name: '完成交付' })).toBeEnabled();
    return `${await groups.count()} 单；第一单改放副驾`;
  }, { shot: handoff, device: '交付员手机' });

  await r.step('完成交付：行程里的订单全部完成', async () => {
    await handoff.getByRole('button', { name: '完成交付' }).click();
    for (const id of ids) await until(con, (s) => s.orders[id]?.status === 'COMPLETED');
    const s = await state(con);
    return `行程 ${tripId} 已交接；车内位置：${Object.entries(s.trips[tripId].placements ?? {}).map(([o, p]) => `${s.orders[o].shortCode}→${p}`).join('、')}`;
  }, { shot: con, device: '控制台' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
