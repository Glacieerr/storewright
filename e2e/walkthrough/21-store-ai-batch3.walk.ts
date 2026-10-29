import { expect } from '@playwright/test';
import { Recorder } from './recorder';
import { LIVE, scan, signIn, state, tab, until, test, type AnyState } from './helpers';

const api = (path: string) => `${LIVE}/api${path}`;

/** 门店 AI 第三批（决策记录 0023）：时段产能与取舍曲线、拣货中加框与分框系数学习、替代推荐的真实标签 */
test('21 门店 AI：时段产能与分框', async ({ browser, request }) => {
  const r = new Recorder('门店 AI：时段产能与分框', 21);
  const session = async (data: Record<string, string>) => ((await (await request.post(api('/stores/demo/session'), { data })).json()) as { token: string }).token;
  const headers = { authorization: `Bearer ${await session({ role: 'console' })}` };
  const lead = await signIn(browser, 'Taylor');
  const picker = await signIn(browser, 'Logan');
  await tab(lead, 'AI');
  await lead.getByRole('tab', { name: '模型' }).click();
  const capacity = lead.locator('.card', { has: lead.getByRole('columnheader', { name: '还能接' }) });

  await r.step('时段产能（模型页）：每个取货时段已接几单、拣货和交付各能做几单、还能接几单；订单平台按这个接口决定能不能接单', async () => {
    await expect(capacity).toBeVisible();
    await capacity.scrollIntoViewIfNeeded();
    return (await capacity.innerText()).split('\n').slice(0, 10).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('带班负责人手动停止一个时段接新单（已经接的照常做），再重新开放', async () => {
    const row = capacity.locator('tr', { has: lead.getByRole('button', { name: '停止接单' }) }).first();
    await row.getByRole('button', { name: '停止接单' }).click();
    // 停止接单要再确认一次（决策记录 0026）；点了以后这一行的按钮变了，直接找「确认停止」
    await capacity.getByRole('button', { name: /确认停止/ }).first().click();
    await until(lead, (s) => Object.keys(s.closedSlots ?? {}).length > 0);
    const closed = Object.keys((await state(lead)).closedSlots ?? {}).length;
    await capacity.getByRole('button', { name: '重新开放' }).first().click();
    await until(lead, (s) => Object.keys(s.closedSlots ?? {}).length < closed);
    return `停止接单 ${closed} 个时段 → 已重新开放`;
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('仿真：接单上限和迟到的取舍（同一天按不同上限各跑一遍）', async () => {
    await capacity.getByRole('button', { name: '仿真：接单上限和迟到的取舍' }).click();
    const table = capacity.locator('table', { has: lead.getByRole('columnheader', { name: '接单上限' }) });
    await expect(table).toBeVisible({ timeout: 60_000 });
    return (await table.innerText()).split('\n').slice(0, 8).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  await r.step('拣货中框装满了：同一订单补一个框（打印新标签），这个框里还没拣的商品放进新框', async () => {
    await request.post(api('/stores/demo/demo/orders'), { headers, data: { type: 'PICKUP', count: 4, release: true, maxLines: 6, slotInMin: 90 } });
    await until(picker, (s) => Object.values(s.walks as Record<string, AnyState>).some((w) => w.status === 'OPEN' && w.track !== 'AUTO'));
    const s = await state(picker);
    const w = Object.values(s.walks as Record<string, AnyState>).find((x) => x.status === 'OPEN' && x.track !== 'AUTO');
    await tab(picker, '拣货');
    await picker.locator('.card', { hasText: w.id }).getByRole('button', { name: '领取这个批次' }).click();
    for (const id of w.toteIds) await scan(picker, '扫描框上的标签', s.totes[id]?.labelId ?? '');
    const before = Object.values((await state(picker)).totes as Record<string, AnyState>).filter((t) => t.walkId === w.id).length;
    await picker.getByRole('button', { name: /装满了？加一个框/ }).click();
    await until(picker, (x) => Object.values(x.totes as Record<string, AnyState>).filter((t) => t.walkId === w.id).length > before);
    return `批次 ${w.id}：${before} 个框 → ${before + 1} 个框`;
  }, { shot: picker, device: '拣货员手机' });

  await r.step('AI 从加框记录学分框系数：按这单各类商品的体积占比调高，写进作业核心（以后锁单时少分错）', async () => {
    await until(lead, (s) => Object.keys(s.toteFactors ?? {}).length > 0, 60_000);
    const f = (await state(lead)).toteFactors as Record<string, number>;
    return Object.entries(f)
      .map(([k, v]) => `${k} × ${v}`)
      .join('；');
  });

  await r.step('替代推荐（模型页）：交付时记下的顾客反应是真实标签；商品属性（口味、规格、有机……）补充比对', async () => {
    const card = lead.locator('.card', { has: lead.getByText(/真实标签/) }).first();
    if (!(await card.isVisible())) return '还没有替代品的真实标签（交付时点「顾客满意 / 不太满意」后出现）';
    await card.scrollIntoViewIfNeeded();
    return (await card.innerText()).split('\n').slice(0, 8).join(' · ');
  }, { shot: lead, device: '带班负责人手机' });

  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
