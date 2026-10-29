import { expect } from '@playwright/test';
import { Recorder } from './recorder';
import { accept, LIVE, signIn, state, statics, tab, until, test, type AnyState } from './helpers';

const api = (path: string) => `${LIVE}/api${path}`;

/** 门店 AI 第二批（决策记录 0022）：开店简报、AI 运行状态、缺勤补位（邀请本人接受）、到货排队与收货顺序 */
test('20 门店 AI：简报、补位与到货', async ({ browser, request }) => {
  const r = new Recorder('门店 AI：简报、补位与到货', 20);
  const session = async (data: Record<string, string>) => ((await (await request.post(api('/stores/demo/session'), { data })).json()) as { token: string }).token;
  const headers = { authorization: `Bearer ${await session({ role: 'console' })}` };
  const lead = await signIn(browser, 'Taylor');
  await tab(lead, 'AI');

  await r.step('开店简报（带班负责人 AI 页最上面）：今天的订单预测和理由、到货、排班和缺口、要注意的事、需要你决定的事', async () => {
    const card = lead.locator('details.brief');
    await expect(card).toBeVisible();
    return (await card.innerText()).split('\n').slice(0, 10).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('切到「傍晚」：明天的预测和明天要注意的事（早、中、晚三次，门店助手也能回答「今天要注意什么」）', async () => {
    const card = lead.locator('details.brief');
    await card.getByRole('radio', { name: '傍晚' }).click();
    await expect(card.getByText(/明天预计 \d+ 单/)).toBeVisible();
    return (await card.innerText()).split('\n').slice(0, 6).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('AI 运行状态（模型页）：每个模型最近 7 天对账的误差、校准，收银流水中断或传感器离线时相关模型自动暂停', async () => {
    await lead.getByRole('tab', { name: '模型' }).click();
    const card = lead.locator('.card', { has: lead.locator('.ai-health') });
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    return (await card.innerText()).split('\n').slice(0, 12).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('排班草稿能改（决策记录 0026）：AI 生成下周草稿 → 点一个班把下班提前 2 小时 → 缺口、多排、工时和规则检查按改后的班表重算', async () => {
    await lead.getByRole('tab', { name: '排班' }).click();
    await lead.getByRole('button', { name: 'AI 生成这一周的排班草稿' }).click();
    const card = lead.locator('.card', { hasText: '总工时' }).first();
    const facts = card.locator('.facts');
    await expect(facts).toBeVisible({ timeout: 60_000 });
    const before = `${(await card.locator('.strong').first().innerText()).trim()} · ${(await facts.innerText()).replace(/\n/g, ' ')}`;
    await lead.locator('.plan.schedule td .cell-btn').filter({ hasText: /\d\d:\d\d–\d\d:\d\d/ }).first().click();
    const editor = lead.locator('.shift-editor');
    const end = editor.getByLabel('下班', { exact: true });
    const [h = 0, m = 0] = (await end.inputValue()).split(':').map(Number);
    await end.fill(`${String(h - 2).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    await editor.getByRole('button', { name: '保存' }).click();
    await expect(lead.getByText(/已手动改了 1 处/)).toBeVisible();
    const after = `${(await card.locator('.strong').first().innerText()).trim()} · ${(await facts.innerText()).replace(/\n/g, ' ')}`;
    expect(after).not.toEqual(before);
    return `改之前：${before}；改之后：${after}`;
  }, { shot: lead, device: '带班负责人手机' });

  let offered = '';
  await r.step('报告缺勤（排班页）：Avery 明天不能来；AI 找能补这个班的人（会这个岗位、这段时间能上班、这周还有工时、不加班的优先）', async () => {
    await lead.getByRole('tab', { name: '排班' }).click();
    await lead.getByLabel('谁').selectOption({ label: 'Avery · 拣货' });
    const form = lead.locator('.card', { has: lead.getByLabel('谁') });
    await form.getByRole('button', { name: '明天' }).click();
    await form.getByRole('button', { name: '报告缺勤' }).click();
    await until(lead, (s) => Object.values(s.recs as Record<string, AnyState>).some((x) => x.module === 'STAFFING' && String(x.target).startsWith('absence:') && x.status === 'OPEN'));
    await lead.getByRole('tab', { name: '建议' }).click();
    const card = lead.locator('.ai-rec', { hasText: /Avery 缺勤/ }).first();
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    const s = await state(lead);
    const rec = Object.values(s.recs as Record<string, AnyState>).find((x) => x.module === 'STAFFING' && String(x.target).startsWith('absence:') && x.status === 'OPEN');
    offered = String(rec?.action.params?.associateId ?? '');
    return (await card.innerText()).replace(/\n/g, ' ').slice(0, 300);
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('采纳：给这位同事发补班邀请；本人在「更多 → 我的班次」里接受后才生效', async () => {
    const card = lead.locator('.ai-rec', { hasText: /Avery 缺勤/ }).first();
    // 涉及人的动作点两下（决策记录 0026）；默认勾着「被拒后自动问下一个人」
    await accept(card);
    await until(lead, (s) => Object.values(s.offers ?? {}).some((o: AnyState) => o.associateId === offered && o.status === 'PENDING'));
    const name = ((await statics(lead)).roster as Array<{ id: string; name: string }>).find((a) => a.id === offered)?.name as string;
    const who = await signIn(browser, name);
    await tab(who, '更多');
    const offer = who.locator('.offer').first();
    await expect(offer).toBeVisible();
    const text = (await offer.innerText()).replace(/\n/g, ' ');
    await offer.getByRole('button', { name: '接受' }).click();
    await until(who, (x) => Object.values(x.offers ?? {}).some((o: AnyState) => o.associateId === offered && o.status === 'ACCEPTED'));
    return `${name}：${text} → 已接受`;
  }, { device: '补班同事手机' });

  await r.step('到货排队：三辆车同时到、卸货门和收货员不够；AI 给出收货顺序（冷链优先），能调人时建议调一名会后仓的人', async () => {
    const before = new Set(Object.keys((await state(lead)).receipts));
    for (let k = 0; k < 3; k++) await request.post(api('/stores/demo/demo/asn'), { headers, data: { items: 10, inMin: 0 } });
    await until(lead, (s) => Object.keys(s.receipts).filter((id) => !before.has(id)).length >= 3);
    const ids = Object.keys((await state(lead)).receipts).filter((id) => !before.has(id));
    for (const id of ids) await request.post(api('/stores/demo/commands'), { headers, data: { cmd: { type: 'ArriveTruck', receiptId: id } } });
    // 门店扫描每分钟一次（演示）
    await until(lead, (s) => Object.values(s.recs as Record<string, AnyState>).some((x) => x.module === 'INBOUND' && x.target === 'DOCK' && x.status === 'OPEN'), 100_000);
    const card = lead.locator('.ai-rec', { hasText: '卸货门排队' }).first();
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    return (await card.innerText()).replace(/\n/g, ' ').slice(0, 320);
  }, { shot: lead, device: '带班负责人手机' });

  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
