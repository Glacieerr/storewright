import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { createOrders, signIn, state, tab, until, type AnyState } from './helpers';

/** 第二个行业：家居建材店（同一个服务器上的另一个门店） */
test('08 家居建材店', async ({ browser }) => {
  const r = new Recorder('家居建材店（第二个行业）', 8);
  const con = await signIn(browser, 'console', { store: 'hardware' });
  const picker = await signIn(browser, 'Avery', { store: 'hardware' });
  const lead = await signIn(browser, 'Taylor', { store: 'hardware' });

  await r.step('建材店的控制台：门店名、没有熟食现做选项、有大件和包裹中转', async () => {
    await expect(con.getByText('Home improvement store')).toBeVisible();
    await expect(con.getByText('每单加一份熟食现做')).toHaveCount(0);
    const st = await con.evaluate(() => (window as unknown as { __swa: { statics: AnyState } }).__swa.statics);
    return `暂存格位 ${st.slots.length} 个（温区：${[...new Set(st.slots.map((s: AnyState) => s.tempZone))].join('、')}）；后仓分区：${[...new Set(st.bins.map((b: AnyState) => b.area))].join('、')}；大件区：${st.oversizedAreas.join('、')}`;
  }, { shot: con, device: '控制台' });

  await r.step('下 2 张带大件的订单：每单行数少、单件重，分框后有大件', async () => {
    const os = await createOrders(con, { count: 2, lines: 4, big: true });
    await until(con, (s) => os.every((o) => s.orders[o.orderId]?.status === 'LOCKED'));
    const s = await state(con);
    return os.map((o) => {
      const ord = s.orders[o.orderId];
      return `${o.shortCode}：${ord.lines.map((l: AnyState) => `${l.name}×${l.qty}`).join('、')}；${ord.toteIds.length} 框，大件 ${Object.values(s.oversized as Record<string, AnyState>).filter((p) => p.orderId === o.orderId).length} 件`;
    }).join('\n');
  }, { shot: con, device: '控制台', fullPage: true });

  await r.step('拣货员看到建材店的批次（全部常温）', async () => {
    await expect(picker.getByText(/可以领取的批次/)).toBeVisible();
    return (await picker.locator('main').innerText()).split('\n').slice(0, 10).join(' · ');
  }, { shot: picker, device: '拣货员手机' });

  await r.step('扩展页只有退货、大件、包裹（没有熟食现做）', async () => {
    await tab(lead, '扩展');
    const tabs = await lead.getByRole('tab').allInnerTexts();
    expect(tabs.join(' ')).not.toContain('熟食现做');
    return tabs.join('、');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('AI 模型用建材店自己的仿真历史训练：退货去向模型没有超过固定规则，上线检查保留规则', async () => {
    await tab(lead, 'AI');
    await lead.getByRole('tab', { name: '模型' }).click();
    await expect(lead.getByText('退货去向模型')).toBeVisible();
    const res = await lead.evaluate(async () => {
      const a = JSON.parse(sessionStorage.getItem('storewright.associate.auth') ?? '{}') as { token: string };
      const r = await fetch('/api/stores/hardware/ai/models', { headers: { authorization: `Bearer ${a.token}` } });
      return (await r.json()) as { models: Array<{ id: string; kind: string; status: string; metrics: Record<string, number> }> };
    });
    const champ = (id: string) => res.models.find((m) => m.id === id && m.status === 'CHAMPION');
    return ['orders-hourly', 'returns-disposition', 'substitution'].map((id) => `${id}：当前版本 ${champ(id)?.kind ?? '—'}`).join('；');
  }, { shot: lead, device: '带班负责人手机', fullPage: true });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
