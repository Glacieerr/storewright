import { expect } from '@playwright/test';
import { Recorder } from './recorder';
import { LIVE, scan, signIn, state, tab, until, test, type AnyState } from './helpers';

const api = (path: string) => `${LIVE}/api${path}`;

/**
 * 门店 AI 第四批（决策记录 0024）：突发状况清单、召回、食品安全记录、送货单收货（批号和保质期）、
 * 打烊复盘与周报、问答反馈、现场操作提示、「下一步」、语音命令
 */
test('22 门店 AI：现场应对与员工助手', async ({ browser, request }) => {
  const r = new Recorder('门店 AI：现场应对与员工助手', 22);
  const session = async (data: Record<string, string>) => ((await (await request.post(api('/stores/demo/session'), { data })).json()) as { token: string }).token;
  const c = await session({ role: 'console' });
  const headers = { authorization: `Bearer ${c}` };
  const lead = await signIn(browser, 'Taylor');
  const stager = await signIn(browser, 'Riley');
  await tab(lead, 'AI');
  await lead.getByRole('tab', { name: '现场' }).click();

  await r.step('突发状况：带班负责人开启「停电」清单；卡片上是实时影响（暂存里的冷藏冷冻框、后仓冷链箱、两小时内要取的订单）和顾客通知草稿', async () => {
    await lead.getByRole('button', { name: '开启：停电' }).click();
    // 开启前再确认一次（决策记录 0026）
    await lead.getByRole('button', { name: '确认开启' }).click();
    await until(lead, (s) => Object.values(s.incidents ?? {}).some((x: AnyState) => x.endedAt === undefined));
    const card = lead.locator('.card', { hasText: '冷链计时从开始算' });
    await expect(card).toBeVisible();
    return (await card.innerText()).split('\n').slice(0, 6).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('每个人顶部出现自己岗位的清单：Riley 在自己岗位的步骤上打勾（暂存员是「关好所有冷柜、冷库的门」；前面被调到交付时看到的是交付的步骤）', async () => {
    const banner = stager.locator('.banner.incident');
    await expect(banner).toBeVisible();
    const step = banner.locator('label.toggle').first();
    const text = (await step.innerText()).replace(/\n/g, ' ');
    await step.locator('input[type=checkbox]').click();
    await until(stager, (s) => Object.values(s.incidents ?? {}).some((x: AnyState) => Object.values(x.checked ?? {}).some((c: AnyState) => c.by === 'A04')));
    return `打勾：${text} · ${(await banner.innerText()).replace(/\n/g, ' · ')}`;
  }, { shot: stager, device: '暂存员手机' });

  await r.step('结束：按事件记录生成时间线（谁在几点做了哪一步）', async () => {
    await lead.getByRole('button', { name: '结束，生成时间线' }).click();
    const report = lead.locator('details.card', { hasText: '上一次：停电' });
    await expect(report).toBeVisible();
    await report.locator('summary').click();
    await expect(report.locator('.timeline li').first()).toBeVisible();
    return (await report.innerText()).split('\n').slice(0, 8).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('召回：粘贴公开的召回通知（演示生成一条），AI 抽出商品、条码、批号、日期和原因，和商品目录匹配', async () => {
    await lead.getByRole('button', { name: '演示：生成一条召回通知' }).click();
    const list = lead.locator('.recall-matches');
    await expect(list).toBeVisible();
    await list.scrollIntoViewIfNeeded();
    const card = lead.locator('.card', { has: list });
    return (await card.innerText()).split('\n').slice(0, 8).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('确认后开始召回：后仓的箱子转待检、线上拣货不能再拣、收银可以按接口拦截；按步骤打勾（货架下架后存量清零）', async () => {
    await lead.getByRole('button', { name: /确认 \d+ 件商品，开始召回/ }).click();
    const card = lead.locator('.card.recall').first();
    await expect(card).toBeVisible();
    await card.getByLabel(/货架下架/).click();
    await until(lead, (s) => Object.values(s.recalls ?? {}).some((x: AnyState) => x.status === 'OPEN' && x.steps?.SHELF));
    const blocked = (await (await request.get(api('/stores/demo/recalls/blocked'), { headers })).json()) as { gtins: string[] };
    return `收银拦截接口：${blocked.gtins.length} 个条码 · ${(await card.innerText()).split('\n').slice(0, 6).join(' · ')}`;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('食品安全记录：每台温控设备的最低 / 平均 / 最高温度和越线分钟、告警和报修；带班负责人确认后记进事件记录', async () => {
    const card = lead.locator('.card', { has: lead.getByRole('button', { name: '确认这一天的记录' }) });
    await card.scrollIntoViewIfNeeded();
    const text = (await card.innerText()).split('\n').slice(0, 6).join(' · ');
    await card.getByRole('button', { name: '确认这一天的记录' }).click();
    await until(lead, (s) => Object.keys(s.foodSafety ?? {}).length > 0);
    await expect(lead.getByText(/已确认/).first()).toBeVisible();
    return text;
  }, { shot: lead, device: '带班负责人手机' });

  const br = await signIn(browser, 'Drew');
  await r.step('送货单收货：后仓员读取这车送货单上的二维码，和到货通知比对（少了的标出来），一次收完，每箱带批号和保质期', async () => {
    const before = new Set(Object.keys((await state(lead)).receipts));
    await request.post(api('/stores/demo/demo/asn'), { headers, data: { items: 4, inMin: 0 } });
    await until(lead, (s) => Object.keys(s.receipts).some((id) => !before.has(id)));
    const receiptId = Object.keys((await state(lead)).receipts).find((id) => !before.has(id)) as string;
    await tab(br, '库存');
    await br.getByRole('tab', { name: /收货/ }).click();
    await br.locator('.row-btn', { hasText: receiptId }).click();
    // 第一次收货就算卡车到了，不用先点「卡车已到」（决策记录 0026）
    await br.getByRole('button', { name: '演示：读取这车的送货单' }).click();
    const compare = br.locator('.card', { hasText: '送货单比对' });
    await expect(compare).toBeVisible();
    const text = (await compare.innerText()).split('\n').slice(0, 8).join(' · ');
    await compare.getByRole('button', { name: '按送货单收货' }).click();
    await until(br, (s) => Object.values(s.cases as Record<string, AnyState>).some((x) => x.receiptId === receiptId && x.lot && x.expiry));
    const s = await state(br);
    const cases = Object.values(s.cases as Record<string, AnyState>).filter((x) => x.receiptId === receiptId);
    return `${text} → 收了 ${cases.length} 箱，例如 ${cases[0]?.id}：批号 ${cases[0]?.lot}，保质期 ${cases[0]?.expiry}`;
  }, { shot: br, device: '后仓员手机' });

  await r.step('打烊复盘：今天的迟到订单按原因分开（单量比预测多、拣货的人比排班少、拣货比标准慢、其他），附复刻精度', async () => {
    await lead.getByRole('tab', { name: '建议' }).click();
    const review = lead.locator('details.review');
    await review.locator('summary').click();
    await expect(review.getByText(/复刻今天/)).toBeVisible({ timeout: 60_000 });
    await review.scrollIntoViewIfNeeded();
    return (await review.innerText()).split('\n').slice(0, 8).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('周报：最近 7 天的指标、各模块的说到做到率、下周的单量预测和排班缺口', async () => {
    const weekly = lead.locator('details.weekly');
    await weekly.locator('summary').click();
    await expect(weekly.getByText(/下周（/)).toBeVisible({ timeout: 60_000 });
    await weekly.scrollIntoViewIfNeeded();
    return (await weekly.innerText()).split('\n').slice(0, 8).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('问数：门店助手回答「今天每小时的单量和迟到」；问答写进事件记录，可以标有用 / 没用（用来改进回答和评测集）', async () => {
    await lead.getByRole('tab', { name: '问答' }).click();
    await lead.getByPlaceholder(/问门店的情况/).fill('今天每小时的单量和迟到');
    await lead.getByRole('button', { name: '提问' }).click();
    const turn = lead.locator('.ask-turn').first();
    await expect(turn.locator('.ask-a')).toBeVisible({ timeout: 60_000 });
    await turn.getByRole('group', { name: '这个回答有用吗' }).getByRole('button', { name: '有用' }).click();
    await until(lead, (s) => (s.answerStats?.helpful ?? 0) > 0);
    return (await turn.innerText()).split('\n').slice(0, 6).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  const jordan = await signIn(browser, 'Jordan');
  await r.step('现场操作提示：在「更多」里打开（入职两周内默认打开）；第一次拣冷链批次时弹出冷链时限的要点和小测验', async () => {
    await tab(jordan, '更多');
    const box = jordan.getByLabel(/第一次遇到某种情况时弹出操作要点/);
    if (!(await box.isChecked())) await box.check();
    await request.post(api('/stores/demo/demo/orders'), { headers, data: { type: 'PICKUP', count: 6, release: true, maxLines: 6, slotInMin: 90 } });
    await until(jordan, (s) => Object.values(s.walks as Record<string, AnyState>).some((w) => w.status === 'OPEN' && w.track !== 'AUTO' && (w.tempZone === 'CHILLED' || w.tempZone === 'FROZEN')));
    const s = await state(jordan);
    const w = Object.values(s.walks as Record<string, AnyState>).find((x) => x.status === 'OPEN' && x.track !== 'AUTO' && (x.tempZone === 'CHILLED' || x.tempZone === 'FROZEN'));
    await tab(jordan, '拣货');
    await jordan.locator('.card', { hasText: w.id }).getByRole('button', { name: '领取这个批次' }).click();
    const tip = jordan.locator('.sop-tip');
    await expect(tip).toBeVisible();
    for (const q of await tip.locator('.sop-quiz').all()) await q.getByRole('radio').first().click();
    const text = (await tip.innerText()).split('\n').slice(0, 6).join(' · ');
    await tip.getByRole('button', { name: /知道了/ }).click();
    await until(jordan, (x) => !!x.sopAcks?.A02?.['cold-chain']);
    return text;
  }, { shot: jordan, device: '新员工手机' });

  const harper = await signIn(browser, 'Harper');
  await r.step('「下一步」：拣货员手上没活、又不在拣货页时，顶部推荐一个可领取的批次（自己岗位优先、附理由，可以换一个、收起）；在拣货页不显示（批次就在下面的列表里）', async () => {
    await expect(harper.getByRole('button', { name: '领取这个批次' }).first()).toBeVisible({ timeout: 30_000 });
    await expect(harper.locator('.next-task')).toHaveCount(0);
    await tab(harper, '库存');
    const card = harper.locator('.next-task');
    await expect(card).toBeVisible({ timeout: 30_000 });
    return (await card.innerText()).replace(/\n/g, ' · ');
  }, { shot: harper, device: '拣货员手机' });

  await r.step('点「领取并开始」：直接领取这个批次；扫框标签后用语音命令（演示用打字代替）记下一条门店经验', async () => {
    await harper.locator('.next-task').getByRole('button', { name: '领取并开始' }).click();
    await until(harper, (s) => Object.values(s.walks as Record<string, AnyState>).some((w) => w.associateId === 'A14' && w.status !== 'COMPLETED'));
    const s = await state(harper);
    const w = Object.values(s.walks as Record<string, AnyState>).find((x) => x.associateId === 'A14' && x.status !== 'COMPLETED');
    for (const id of w.toteIds) await scan(harper, '扫描框上的标签', s.totes[id]?.labelId ?? '');
    await harper.getByRole('button', { name: '语音命令' }).click();
    await harper.getByLabel('语音命令').fill('记一下：冷冻 3 号门把手松了');
    await harper.getByRole('button', { name: '执行' }).click();
    await expect(harper.locator('.toast', { hasText: '已记下' })).toBeVisible();
    return `批次 ${w.id}（${w.tempZone}）· 语音：记一下：冷冻 3 号门把手松了`;
  }, { shot: harper, device: '拣货员手机' });

  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
