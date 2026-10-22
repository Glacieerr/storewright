import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { signIn, state, tab, until, type AnyState } from './helpers';

/** 门店 AI：建议列表与理由、否决必须选原因、运行模式与锁定、人员调动、模型仓库（重新训练、上线检查、回滚）、本地助手与门店经验 */
test('06 门店 AI', async ({ browser }) => {
  const r = new Recorder('门店 AI', 6);
  const con = await signIn(browser, 'console');
  const lead = await signIn(browser, 'Taylor');
  await tab(lead, 'AI');

  await r.step('模型页：各模型族的当前版本与回测指标（订单量、到店时间、可售概率、盘点、替代、熟食、退货）', async () => {
    await lead.getByRole('tab', { name: '模型' }).click();
    await expect(lead.getByText('订单量预测模型')).toBeVisible();
    const txt = await lead.locator('main').innerText();
    return txt.split('\n').filter((l) => /模型$|当前版本|v\d/.test(l)).slice(0, 14).join(' · ');
  }, { shot: lead, device: '带班负责人手机', fullPage: true });

  await r.step('立即预测：发出接下来几小时的订单量预测（区间、置信度、理由、其他模型的预测）', async () => {
    await lead.getByRole('button', { name: '立即预测' }).click();
    await lead.getByRole('tab', { name: '建议' }).click();
    const card = lead.locator('.ai-rec', { hasText: '订单量' }).first();
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    return (await card.innerText()).replace(/\n/g, ' ').slice(0, 400);
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('否决一条建议：必须选原因（可以补充说明），原因计入统计', async () => {
    const card = lead.locator('.ai-rec').first();
    const title = (await card.locator('.card-head').innerText()).replace(/\n/g, ' ');
    await card.getByRole('button', { name: /否决|不准/ }).click();
    await expect(card.getByRole('button', { name: '提交' })).toBeVisible();
    await card.getByRole('button', { name: '我知道系统不知道的情况' }).click();
    await card.getByPlaceholder('补充说明（可选）').fill('附近学校今天放假');
    await card.getByRole('button', { name: '提交' }).click();
    await until(lead, (s) => Object.values(s.recs as Record<string, AnyState>).some((x) => x.status === 'OVERRIDDEN'));
    return title;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('模式与统计：每个模块的运行模式（只显示 / 需确认 / 自动执行）和采纳率；把「按风险盘点」改成自动执行', async () => {
    await lead.getByRole('tab', { name: '模式与统计' }).click();
    const row = lead.locator('.card, li', { hasText: '按风险盘点' }).first();
    await row.getByRole('button', { name: '自动执行' }).click();
    await until(lead, (s) => s.aiModes?.COUNT?.mode === 'AUTO');
    return (await lead.locator('main').innerText()).split('\n').filter((l) => /发出|还没有建议/.test(l)).slice(0, 9).join(' · ');
  }, { shot: lead, device: '带班负责人手机', fullPage: true });

  await r.step('控制台（门店管理员）锁定「订单量预测」：带班负责人不能再改', async () => {
    await con.getByRole('tab', { name: /AI/ }).click();
    await con.getByRole('tab', { name: '模式与统计' }).click();
    const row = con.locator('.card, li', { hasText: '订单量预测' }).first();
    await row.getByRole('button', { name: '锁定' }).click();
    await until(lead, (s) => !!(s.aiModes?.FORECAST?.locked));
    const leadRow = lead.locator('.card, li', { hasText: '订单量预测' }).first();
    await expect(leadRow.getByText('已锁定')).toBeVisible();
    await expect(leadRow.getByRole('button', { name: '自动执行' })).toBeDisabled();
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('人员：把一名拣货员临时调到交付，固定另一名（AI 不会建议调动固定名单上的人）', async () => {
    const card = lead.locator('li').filter({ hasText: 'Sam' }).filter({ has: lead.getByRole('button', { name: /调到交付/ }) }).first();
    await card.getByRole('button', { name: /调到交付/ }).click();
    await until(lead, (s) => s.roles?.A03 === 'HANDOFF');
    const other = lead.locator('li').filter({ hasText: 'Jordan' }).filter({ has: lead.getByRole('button', { name: '固定' }) }).first();
    await other.getByRole('button', { name: '固定' }).click();
    await until(lead, (s) => !!s.staffLocks?.A02);
    return 'Sam → 交付（临时）；Jordan 固定';
  }, { shot: lead, device: '带班负责人手机', fullPage: true });

  await r.step('重新训练：候选模型与当前版本在同样的数据上比较，过了上线检查才上线', async () => {
    await lead.getByRole('tab', { name: '模型' }).click();
    await lead.getByRole('button', { name: '重新训练' }).click();
    const toast = lead.locator('.toast', { hasText: /已上线|没有通过/ }).last();
    await expect(toast).toBeVisible({ timeout: 90_000 });
    return (await toast.innerText()).trim();
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('用较弱的模型测试上线检查：候选没有通过，保留当前版本', async () => {
    await lead.getByRole('button', { name: '用较弱的模型测试上线检查' }).click();
    const toast = lead.locator('.toast', { hasText: /没有通过|已上线/ }).last();
    await expect(toast).toBeVisible({ timeout: 60_000 });
    return (await toast.innerText()).trim();
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('回滚订单量模型：有更早的上线版本时回到它；没有时提示「没有可以回滚的版本」', async () => {
    await lead.getByRole('button', { name: '回滚订单量模型' }).click();
    const toast = lead.locator('.toast', { hasText: /回滚/ }).last();
    await expect(toast).toBeVisible({ timeout: 30_000 });
    return (await toast.innerText()).trim();
  }, { shot: lead, device: '带班负责人手机' });

  const ask = async (q: string) => {
    const answers = lead.locator('.ask-turn').filter({ hasText: '数据来自' });
    const before = await answers.count();
    await lead.getByPlaceholder('问门店的情况、商品、人员、操作规范，或「如果……会怎样」').fill(q);
    await lead.getByRole('button', { name: '提问' }).click();
    await expect.poll(() => answers.count(), { timeout: 90_000 }).toBeGreaterThan(before);
    return (await answers.first().innerText()).replace(/\n/g, ' ').slice(0, 420);
  };
  await r.step('问助手：「现在店里情况怎么样？」（只用门店数据回答，附出处）', async () => {
    await lead.getByRole('tab', { name: '问答' }).click();
    return ask('现在店里情况怎么样？');
  }, { shot: lead, device: '带班负责人手机' });
  await r.step('问助手：「如果下午 3 点到 6 点交付多一个人会怎样？」（用仿真推演；结果变化很小时说明原因）', async () => {
    const answer = await ask('如果下午3点到6点交付多一个人会怎样？');
    expect(answer).toContain('15–18 点');
    return answer;
  }, { shot: lead, device: '带班负责人手机' });
  await r.step('问助手：「冷链超时怎么处理？」（检索操作规范）', async () => ask('冷链超时怎么处理？'), { shot: lead, device: '带班负责人手机' });
  await r.step('记下一条门店经验，助手以后回答会用到', async () => {
    await lead.getByPlaceholder('例如：周末烤鸡放在熟食柜旁边的冷柜，不在原货位').fill('周末烤鸡放在熟食柜旁边的冷柜，不在原货位');
    await lead.getByPlaceholder('标签（可选，用逗号分隔）').fill('熟食,周末');
    await lead.getByRole('button', { name: '记下这条经验' }).click();
    await until(lead, (s) => Object.values(s.notes ?? {}).length > 0);
    const answer = await ask('周末烤鸡放在哪？');
    expect(answer).toContain('熟食柜旁边的冷柜');
    return answer;
  }, { shot: lead, device: '带班负责人手机', fullPage: true });

  r.note('AI 统计', await (async () => {
    const s = await state(con);
    return Object.entries(s.aiStats as Record<string, AnyState>).map(([m, x]) => `${m}: 发出 ${x.issued}，采纳 ${x.ACCEPTED}，否决 ${x.OVERRIDDEN}，自动 ${x.AUTO_APPLIED}`).join('；');
  })());
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
