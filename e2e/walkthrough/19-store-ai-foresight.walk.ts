import { expect } from '@playwright/test';
import { Recorder } from './recorder';
import { accept, LIVE, signIn, state, tab, until, test, type AnyState } from './helpers';

const api = (path: string) => `${LIVE}/api${path}`;

/** 门店 AI 第一批（决策记录 0021）：拣货的 AI 预计用时、运营预警（推演 + 试过的办法）、建议中枢的提醒、订单量展望 */
test('19 门店 AI：运营预警与提醒', async ({ browser, request }) => {
  const r = new Recorder('门店 AI：运营预警与提醒', 19);
  const session = async (data: Record<string, string>) => ((await (await request.post(api('/stores/demo/session'), { data })).json()) as { token: string }).token;
  const headers = { authorization: `Bearer ${await session({ role: 'console' })}` };
  const lead = await signIn(browser, 'Taylor');
  const picker = await signIn(browser, 'Avery');

  await r.step('订单一下子很多：40 张自取单、取货时段在 25 分钟后；只有 Avery 在拣货，领取后批次上写着 AI 预计还要多久', async () => {
    for (let k = 0; k < 2; k++) await request.post(api('/stores/demo/demo/orders'), { headers, data: { type: 'PICKUP', count: 20, release: true, maxLines: 5, slotInMin: 25 } });
    await until(picker, (s) => Object.values(s.walks as Record<string, AnyState>).some((w) => w.status === 'OPEN' && w.track !== 'AUTO'));
    const s = await state(picker);
    const w = Object.values(s.walks as Record<string, AnyState>).find((x) => x.status === 'OPEN' && x.track !== 'AUTO');
    await tab(picker, '拣货');
    await picker.locator('.card', { hasText: w.id }).getByRole('button', { name: '领取这个批次' }).click();
    await until(picker, (x) => x.walks[w.id]?.status !== 'OPEN');
    await expect(picker.getByText(/AI 预计还要约 \d+ 分钟/)).toBeVisible();
    const open = Object.values(s.walks as Record<string, AnyState>).filter((x) => x.status === 'OPEN').length;
    return `待领取 ${open} 个批次；Avery 领了 ${w.id}（${w.ai ? `AI 预计 ${Math.round(w.ai.sec / 60)} 分钟，` : ''}标准 ${Math.round(w.estimatedSec / 60)} 分钟）`;
  }, { shot: picker, device: '拣货员手机' });

  await r.step('运营预警：推演接下来的几个小时，发现会有订单赶不上取货时段；附上试过的办法和采纳后的预计效果', async () => {
    const res = (await (await request.post(api('/stores/demo/ai/foresight'), { headers })).json()) as { problems: Array<{ kind: string }>; options: Array<{ action: { kind: string }; gain: number }> };
    await tab(lead, 'AI');
    await lead.getByRole('tab', { name: '建议' }).click();
    const card = lead.locator('.ai-rec').filter({ hasText: '预计效果（推演）' }).first();
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    return `问题：${res.problems.map((p) => p.kind).join('、') || '无'}；试过 ${res.options.length} 个办法 · ${(await card.innerText()).replace(/\n/g, ' ').slice(0, 320)}`;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('建议中枢：几条运营预警合成一条提醒，发给在岗的带班负责人（铃铛）；正在交付的人先不打扰', async () => {
    const bell = lead.getByRole('button', { name: /提醒（[1-9]\d* 条未读）/ });
    await expect(bell).toBeVisible({ timeout: 40_000 });
    await bell.click();
    const sheet = lead.getByRole('dialog', { name: '提醒' });
    await expect(sheet).toBeVisible();
    const text = (await sheet.innerText()).replace(/\n/g, ' ').slice(0, 260);
    return text;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('采纳：AI 执行试过的办法（例如提前开始这些订单），记下采纳；提醒随之关闭', async () => {
    await lead.getByRole('dialog', { name: '提醒' }).getByRole('button', { name: '关闭' }).click();
    const card = lead.locator('.ai-rec').filter({ hasText: '预计效果（推演）' }).first();
    const title = (await card.locator('.card-head').innerText()).replace(/\n/g, ' ');
    await accept(card);
    await until(lead, (s) => Object.values(s.recs as Record<string, AnyState>).some((x) => x.module === 'FORESIGHT' && (x.status === 'ACCEPTED' || x.status === 'AUTO_APPLIED')));
    const s = await state(lead);
    const rec = Object.values(s.recs as Record<string, AnyState>).find((x) => x.module === 'FORESIGHT' && x.status === 'ACCEPTED');
    return `${title} → 已采纳（${rec?.action.kind ?? ''}）`;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('提醒统计（模式与统计）：最近一小时发出几条、因为正在交付而延后几条、合并了几条', async () => {
    await lead.getByRole('tab', { name: '模式与统计' }).click();
    const txt = (await lead.locator('main').innerText()).split('\n').filter((l) => /提醒|延后|合并/.test(l)).slice(0, 6).join(' · ');
    return txt;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('订单量展望：接下来几个小时的预计单数，按今天的实际修正（推演和补货优先级都用这条线；只看营业时间里的小时）', async () => {
    await lead.getByRole('tab', { name: '建议' }).click();
    const card = lead.locator('.card.outlook');
    const hours = ((await state(lead)).outlook?.hours ?? []) as Array<{ t: number }>;
    // 营业时间以外（例如晚上关门后）接下来没有营业的小时，卡片不显示
    if (!hours.some((h) => h.t + 3_600_000 > Date.now())) return '现在是营业时间以外，接下来没有要展望的小时，卡片不显示';
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.scrollIntoViewIfNeeded();
    return (await card.innerText()).replace(/\n/g, ' ').slice(0, 300);
  }, { shot: lead, device: '带班负责人手机' });

  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
