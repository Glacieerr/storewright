import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { scan, signIn, state, tab, until, type AnyState } from './helpers';

/** 后仓：到货通知 → 卡车到 → 逐个商品收货（含破损、少收）→ 关闭收货单显示差异 → 上架 → 待检处理 → 盲盘 */
test('04 收货、上架与盘点', async ({ browser }) => {
  const r = new Recorder('收货、上架与盘点', 4);
  const con = await signIn(browser, 'console');
  const br = await signIn(browser, 'Drew');
  let receiptId = '';

  await r.step('控制台代替供应商发送到货通知（ASN）：挑后仓没货、卖得快的商品', async () => {
    const before = Object.keys((await state(con)).receipts).length;
    await con.getByRole('button', { name: '发送到货通知（ASN）' }).click();
    await until(con, (s) => Object.keys(s.receipts).length > before);
    const s = await state(con);
    const rc = Object.values(s.receipts as Record<string, AnyState>).sort((a, b) => b.createdAt - a.createdAt)[0];
    receiptId = rc.id;
    return `收货单 ${rc.id}：${rc.expected.length} 个商品，共 ${rc.expected.reduce((a: number, l: AnyState) => a + l.cases, 0)} 箱`;
  }, { shot: con, device: '控制台' });

  await r.step('后仓员打开收货单，卡车到了开始收货', async () => {
    await tab(br, '库存');
    await br.getByRole('tab', { name: /收货/ }).click();
    await br.locator('.row-btn', { hasText: receiptId }).click();
    await br.getByRole('button', { name: '卡车已到，开始收货' }).click();
    await expect(br.getByLabel('扫描箱上原有条码', { exact: true })).toBeVisible();
  }, { shot: br, device: '后仓员手机' });

  await r.step('逐个商品扫箱上原有条码收货：一个商品少收 1 箱，另一个有 1 箱破损（进待检区），其余按通知收', async () => {
    const s = await state(br);
    const rc = s.receipts[receiptId];
    const notes: string[] = [];
    // 扫描后数量默认是 1；按目标箱数加上去
    const receive = async (gtin: string, name: string, cases: number, damaged: boolean) => {
      await scan(br, '扫描箱上原有条码', gtin);
      const card = br.locator('.card', { hasText: name }).filter({ has: br.locator('.stepper') });
      for (let k = 1; k < cases; k++) await card.locator('.stepper button').last().click();
      if (damaged) await card.getByLabel('有破损（进入待检区）').check();
      await card.getByRole('button', { name: /收货并打印/ }).click();
      await expect(card).toHaveCount(0);
    };
    const lines = rc.expected as AnyState[];
    // 少收：第一个应到多于 1 箱的商品；破损：另一个商品
    const shortIdx = lines.findIndex((l) => l.cases > 1);
    const damagedIdx = lines.findIndex((_, k) => k !== shortIdx);
    for (const [i, l] of lines.entries()) {
      if (i === shortIdx) {
        await receive(l.gtin, l.name, l.cases - 1, false);
        notes.push(`${l.name}：收 ${l.cases - 1} / ${l.cases} 箱（少 1 箱）`);
      } else if (i === damagedIdx) {
        await receive(l.gtin, l.name, 1, true);
        if (l.cases > 1) await receive(l.gtin, l.name, l.cases - 1, false);
        notes.push(`${l.name}：${l.cases} 箱，其中 1 箱破损`);
      } else {
        await receive(l.gtin, l.name, l.cases, false);
        notes.push(`${l.name}：${l.cases} 箱`);
      }
    }
    return notes.join('；');
  }, { shot: br, device: '后仓员手机', fullPage: true });

  await r.step('关闭收货单：与通知比较，列出短少和破损', async () => {
    await br.getByRole('button', { name: '关闭收货单' }).click();
    await until(br, (s) => !!s.receipts[receiptId].closedAt);
    const s = await state(br);
    const rc = s.receipts[receiptId];
    const kinds: Record<string, string> = { SHORT: '短少', OVER: '多出', DAMAGED: '破损' };
    const name = (id: string) => (rc.expected as AnyState[]).find((l) => l.itemId === id)?.name ?? id;
    return (rc.discrepancies ?? []).map((d: AnyState) => `${name(d.itemId)}：${kinds[d.kind] ?? d.kind}（应到 ${d.expected}，实收 ${d.received}，破损 ${d.damaged}）`).join('；') || '与通知一致';
  }, { shot: br, device: '后仓员手机', fullPage: true });

  await r.step('上架：点选一箱（= 扫描箱标签），放进建议的库位', async () => {
    await br.getByRole('tab', { name: /上架/ }).click();
    await br.locator('.tote-list .row-btn, .list .row-btn').first().click();
    const chip = br.locator('.chip.mono').first();
    const bin = (await chip.innerText()).trim();
    await chip.click();
    return `放进 ${bin}`;
  }, { shot: br, device: '后仓员手机' });

  await r.step('上架其余的箱子：好箱放进可售库位；破损箱先放进待检区，检验后改为「退供应商」', async () => {
    for (let i = 0; i < 40; i++) {
      const s = await state(br);
      const pending = Object.values(s.cases as Record<string, AnyState>).filter((c) => c.receiptId === receiptId && (c.state === 'RECEIVED' || (c.status === 'QA' && c.state === 'STORED')));
      if (!pending.length) break;
      const c = pending[0];
      await br.locator('.tote-list .row-btn', { hasText: c.id }).click();
      if (c.status === 'QA' && c.state === 'STORED') await br.getByRole('button', { name: '退供应商' }).click();
      else await br.locator('.chip.mono').first().click();
      await expect.poll(async () => {
        const x = (await state(br)).cases[c.id];
        return `${x.status}/${x.state}`;
      }).not.toBe(`${c.status}/${c.state}`);
    }
    const s = await state(br);
    const cs = Object.values(s.cases as Record<string, AnyState>).filter((c) => c.receiptId === receiptId);
    return `本单 ${cs.length} 箱：可售 ${cs.filter((c) => c.status === 'SELLABLE').length}，退供应商 ${cs.filter((c) => c.status === 'RTV').length}，待检 ${cs.filter((c) => c.status === 'QA').length}`;
  }, { shot: br, device: '后仓员手机' });

  await r.step('生成一个盘点任务（控制台代替排程），后仓员领取', async () => {
    const s = await state(br);
    const bin = Object.values(s.cases as Record<string, AnyState>).find((c) => c.receiptId === receiptId && c.status === 'SELLABLE')?.binCode;
    await con.evaluate((b) => (window as unknown as { __swa: { send(c: unknown): Promise<unknown> } }).__swa.send({ type: 'CreateCount', binCode: b }), bin);
    await br.getByRole('tab', { name: /盘点/ }).click();
    await br.getByRole('button', { name: '领取' }).first().click();
    await expect(br.getByRole('button', { name: '提交盘点' })).toBeVisible();
    return `库位 ${bin}`;
  }, { shot: br, device: '后仓员手机' });

  await r.step('盲盘：不显示系统数量，逐个商品数箱数后提交；数量一致时记录一致', async () => {
    const s = await state(br);
    const count = Object.values(s.counts as Record<string, AnyState>).find((c) => c.status === 'CLAIMED' && c.associateId === 'A09');
    const expected: Record<string, number> = {};
    for (const id of s.bins[count.binCode] ?? []) {
      const c = s.cases[id];
      if (c?.state === 'STORED') expected[c.itemId] = (expected[c.itemId] ?? 0) + 1;
    }
    const rows = br.locator('.count-row');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const target = Object.values(expected)[i] ?? 0;
      for (let k = 0; k < target; k++) await rows.nth(i).locator('button').last().click();
    }
    await br.getByRole('button', { name: '提交盘点' }).click();
    await until(br, (st) => st.counts[count.id]?.status === 'DONE');
    const done = (await state(br)).counts[count.id];
    const diff = (done.results ?? []).filter((x: AnyState) => x.counted !== x.expected).length;
    return `库位 ${count.binCode}：${n} 个商品，${diff ? `${diff} 个与记录不一致（已修正）` : '与记录一致'}`;
  }, { shot: br, device: '后仓员手机' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
