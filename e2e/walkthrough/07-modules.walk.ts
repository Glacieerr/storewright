import { expect } from '@playwright/test';
import { Recorder } from './recorder';
import { createOrders, scan, signIn, state, statics, tab, until, test, type AnyState } from './helpers';

/** 扩展模块：熟食现做、退货（含硬性规则）、大件（先扫后打）、包裹中转 */
test('07 扩展模块', async ({ browser }) => {
  const r = new Recorder('扩展模块', 7);
  const con = await signIn(browser, 'console');
  const deli = await signIn(browser, 'Jamie');
  const lead = await signIn(browser, 'Taylor');
  const stager = await signIn(browser, 'Quinn');
  const br = await signIn(browser, 'Drew');
  let orders: Array<{ orderId: string; shortCode: string; code: string; name: string }> = [];

  await r.step('控制台下 2 张订单，每单加一份熟食现做和一件大件（2 件）', async () => {
    orders = await createOrders(con, { count: 2, lines: 2, mto: true, big: true });
    await until(con, (s) => Object.values(s.mto as Record<string, AnyState>).length >= 2 && Object.values(s.oversized as Record<string, AnyState>).length >= 4);
    const s = await state(con);
    return `现做单 ${Object.keys(s.mto).length} 张，大件 ${Object.keys(s.oversized).length} 件`;
  }, { shot: con, device: '控制台' });

  await r.step('熟食员工的默认页面是熟食看板：AI 按菜品和厨房负荷调整建议开始时间（标出标准时间）', async () => {
    await expect(deli.getByText(/排队中/)).toBeVisible();
    const s = await state(deli);
    return Object.values(s.mto as Record<string, AnyState>).map((t) => `${t.name}：建议 ${new Date(t.startAt).toTimeString().slice(0, 5)}（标准 ${new Date(t.standardStartAt).toTimeString().slice(0, 5)}${t.aiAdjusted ? '，AI 调整' : ''}）`).join('；');
  }, { shot: deli, device: '熟食员工手机' });

  await r.step('开始制作 → 完成放进保温位（开始计时）→ 取出', async () => {
    await deli.getByRole('button', { name: '开始制作' }).first().click();
    await deli.getByRole('button', { name: /^完成/ }).first().click();
    await expect(deli.getByText(/分钟后丢弃/).first()).toBeVisible();
    const held = (await deli.locator('.card', { hasText: '分钟后丢弃' }).first().innerText()).replace(/\n/g, ' ');
    await deli.getByRole('button', { name: '取出（交付准备）' }).first().click();
    return held;
  }, { shot: deli, device: '熟食员工手机' });

  await r.step('丢弃另一张现做单（记录原因）', async () => {
    await deli.getByRole('button', { name: '丢弃' }).first().click();
    await until(deli, (s) => Object.values(s.mto as Record<string, AnyState>).some((t) => t.status === 'DISCARDED'));
    await expect(deli.getByText(/已丢弃 1 份/)).toBeVisible();
    return (await deli.locator('main').innerText()).split('\n').find((l) => l.includes('今天已取出')) ?? '';
  }, { shot: deli, device: '熟食员工手机' });

  await r.step('大件：领取装载建议的第 1 趟，扫描商品条码后打印这一件的标签（PIECE 1/2）', async () => {
    await tab(stager, '扩展');
    await stager.getByRole('tab', { name: '大件' }).click();
    const plan = (await stager.locator('.note', { hasText: '装载建议' }).first().innerText()).trim();
    await stager.getByRole('button', { name: /领取第 1 趟/ }).first().click();
    await until(stager, (st) => Object.values(st.oversized as Record<string, AnyState>).some((p) => p.associateId === 'A07' && p.status === 'CLAIMED'));
    const s = await state(stager);
    const mine = Object.values(s.oversized as Record<string, AnyState>).find((p) => p.associateId === 'A07' && p.status === 'CLAIMED');
    await scan(stager, '扫描商品条码，然后打印这一件的标签', mine.gtin);
    await expect(stager.getByRole('link', { name: /打印标签/ }).first()).toBeVisible();
    return `${plan}；扫描 ${mine.name} 后可以打印 ${mine.index}/${mine.count}`;
  }, { shot: stager, device: '暂存员手机' });

  await r.step('打印这一件的标签后才能放到大件区；交付看板能看到每单的大件进度', async () => {
    // 打印时记下（决策记录 0026）：没打印就没有「放到」按钮
    await expect(stager.getByRole('button', { name: /^放到 / })).toHaveCount(0);
    const [popup] = await Promise.all([stager.waitForEvent('popup'), stager.getByRole('link', { name: /打印标签/ }).first().click()]);
    await popup.close();
    await stager.getByRole('button', { name: /^放到 / }).first().click();
    await until(stager, (s) => Object.values(s.oversized as Record<string, AnyState>).some((p) => p.status === 'STAGED'));
    const s = await state(stager);
    return Object.values(s.oversized as Record<string, AnyState>).map((p) => `${p.orderId} ${p.index}/${p.count} ${p.status}${p.area ? ` @${p.area}` : ''}`).join('；');
  }, { shot: stager, device: '暂存员手机' });

  await r.step('包裹中转：控制台发出到货通知（8 件 / 2 个行程）', async () => {
    await con.getByRole('button', { name: '包裹到货通知（8 件 / 2 个行程）' }).click();
    await until(con, (s) => Object.keys(s.parcels).length >= 8);
    return (await con.locator('.card', { hasText: '包裹中转' }).innerText()).replace(/\n/g, ' · ').slice(0, 300);
  }, { shot: con, device: '控制台' });

  await r.step('后仓员扫描包裹入站：系统建议格位（同一行程放一起、尺寸合适、靠近门口）', async () => {
    await tab(br, '扩展');
    await br.getByRole('tab', { name: '包裹' }).click();
    const s = await state(br);
    const ps = Object.values(s.parcels as Record<string, AnyState>).filter((p) => p.status === 'EXPECTED').slice(0, 3);
    for (const p of ps) {
      await scan(br, '扫描包裹编码入站', p.id);
      await br.getByRole('button', { name: /^放到 / }).first().click();
      await expect.poll(async () => (await state(br)).parcels[p.id]?.status).toBe('STAGED');
    }
    const after = await state(br);
    return ps.map((p) => `${p.id}（${p.tripRef}，${p.sizeClass}）→ ${after.parcels[p.id].slotCode}`).join('；');
  }, { shot: br, device: '后仓员手机' });

  await r.step('扫描一个没有到货通知的包裹：先问是不是扫错了，确认后标为「多出（待核实）」；登记一个损坏的包裹', async () => {
    await scan(br, '扫描包裹编码入站', 'PKG-UNKNOWN-1');
    await expect(br.getByText(/PKG-UNKNOWN-1 不在到货通知里/)).toBeVisible();
    await br.getByRole('button', { name: '登记为多出（放待核实区）' }).click();
    await expect.poll(async () => (await state(br)).parcels['PKG-UNKNOWN-1']?.status).toBe('OVER');
    const s = await state(br);
    const next = Object.values(s.parcels as Record<string, AnyState>).find((p) => p.status === 'EXPECTED');
    await scan(br, '扫描包裹编码入站', next.id);
    await br.getByRole('button', { name: '登记损坏' }).first().click();
    await expect.poll(async () => (await state(br)).parcels[next.id]?.status).toBe('DAMAGED');
    return `PKG-UNKNOWN-1 → 多出；${next.id} → 损坏`;
  }, { shot: br, device: '后仓员手机' });

  await r.step('多出的包裹退回快递，损坏的放在异常区等认领', async () => {
    const s = await state(br);
    const damaged = Object.values(s.parcels as Record<string, AnyState>).find((p) => p.status === 'DAMAGED');
    await br.locator('.card', { hasText: 'PKG-UNKNOWN-1' }).getByRole('button', { name: '退回快递' }).click();
    await br.locator('.card', { hasText: damaged.id }).filter({ has: br.getByRole('button', { name: '放异常区等认领' }) }).getByRole('button', { name: '放异常区等认领' }).click();
    await expect.poll(async () => [(await state(br)).parcels['PKG-UNKNOWN-1']?.status, (await state(br)).parcels[damaged.id]?.status]).toEqual(['RETURNED', 'HELD']);
    return `PKG-UNKNOWN-1 → 已退回快递；${damaged.id} → 异常区保留`;
  }, { shot: br, device: '后仓员手机' });

  await r.step('司机来取：后仓员在手机上按行程交给司机（行程里还有已入站没放进格位的包裹时不能交）', async () => {
    const s = await state(br);
    const trip = Object.values(s.parcels as Record<string, AnyState>).find((p) => p.status === 'STAGED')?.tripRef;
    await br.locator('.card', { hasText: trip }).filter({ has: br.getByRole('button', { name: /交给司机/ }) }).getByRole('button', { name: /交给司机/ }).click();
    await expect.poll(async () => Object.values((await state(br)).parcels as Record<string, AnyState>).some((p) => p.status === 'HANDED_OFF')).toBe(true);
    const after = await state(br);
    return `行程 ${trip}：交接 ${Object.values(after.parcels as Record<string, AnyState>).filter((p) => p.status === 'HANDED_OFF').length} 件（没入站的仍为预期到货，超时后标为短少）`;
  }, { shot: br, device: '后仓员手机' });

  await r.step('退货（无小票）：冷藏商品的「可售回架」不可用并说明规则；AI 建议在允许的去向里', async () => {
    await tab(lead, '扩展');
    await lead.getByRole('tab', { name: '退货' }).click();
    await lead.getByRole('button', { name: '开始退货' }).click();
    const st = await statics(lead);
    const cold = st.planogram.find((p: AnyState) => p.tempZone === 'CHILLED');
    await scan(lead, '扫描退回的商品', cold.gtin);
    const card = lead.locator('.card', { hasText: cold.name }).last();
    await expect(card.getByRole('button', { name: '可售回架' })).toBeDisabled();
    await expect(card.getByText(/AI 建议：/)).toBeVisible();
    return (await card.innerText()).replace(/\n/g, ' ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('再扫一瓶开封的清洁剂（化学品）：只能走危险品回收；AI 也建议危险品回收', async () => {
    const st = await statics(lead);
    const s = await state(lead);
    void s;
    const chem = st.planogram.find((p: AnyState) => p.chemical);
    if (!chem) return '目录里没有化学品';
    await lead.getByRole('button', { name: '已开封' }).click();
    await scan(lead, '扫描退回的商品', chem.gtin);
    const card = lead.locator('.card', { hasText: chem.name }).last();
    await expect(card.getByText('开封或损坏的化学品只能走危险品回收')).toBeVisible();
    for (const d of ['可售回架', '报废', '退供应商']) await expect(card.getByRole('button', { name: d })).toBeDisabled();
    return (await card.innerText()).replace(/\n/g, ' ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('选择去向并完成退货：发出「退货完成」事件和退款金额（退款由外部系统处理）', async () => {
    const cards = lead.locator('.card').filter({ has: lead.getByRole('button', { name: '危险品回收' }) });
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const c = cards.nth(i);
      const hazmatOnly = await c.getByRole('button', { name: '报废' }).isDisabled();
      await c.getByRole('button', { name: hazmatOnly ? '危险品回收' : '报废' }).click();
    }
    await lead.getByRole('button', { name: '完成退货' }).click();
    await expect(lead.getByText(/已完成 · 退款/)).toBeVisible();
    const s = await state(lead);
    const st = s.aiStats.RETURNS ?? {};
    return `${(await lead.getByText(/已完成 · 退款/).innerText()).trim()}；退货 AI 建议采纳 ${st.ACCEPTED ?? 0} / 否决 ${st.OVERRIDDEN ?? 0}`;
  }, { shot: lead, device: '带班负责人手机' });
  void orders;
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
