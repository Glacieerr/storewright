import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { SITE } from './helpers';

/** 运营模拟器：视角、建筑剖切、叠加层、门店模板（含建材店）、策略对比、方案与报告、布局编辑、导览与巡游 */
test('10 运营模拟器', async ({ browser }) => {
  const r = new Recorder('运营模拟器', 10);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const p = await ctx.newPage();
  const btn = (name: string) => p.getByRole('button', { name, exact: true });
  const panel = (name: string) => p.getByRole('tab', { name }).or(p.getByRole('button', { name, exact: true })).first();

  await r.step('打开模拟器：中型店、默认档位，一天的仿真在 Web Worker 里跑完（第一次打开会邀请导览）', async () => {
    const t0 = Date.now();
    await p.goto('/sim/');
    await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });
    await p.waitForTimeout(2500);
    return `${((Date.now() - t0) / 1000).toFixed(1)} 秒；${(await p.getByText(/单 · 仿真用时/).innerText()).trim()}`;
  }, { shot: p, device: '电脑' });

  await r.step('导览：一步一步介绍界面（截第一步）', async () => {
    const start = p.getByRole('button', { name: /开始导览|导览/ }).first();
    await start.click();
    await p.waitForTimeout(800);
    const txt = (await p.locator('.tour-card, .tour-step, [role="dialog"]').first().innerText().catch(() => '')).replace(/\n/g, ' ').slice(0, 200);
    await p.keyboard.press('Escape');
    return txt;
  }, { shot: p, device: '电脑' });

  for (const v of ['3D', '俯视', '2.5D']) {
    await r.step(`视角：${v}`, async () => {
      await btn(v).click();
      await p.waitForTimeout(1500);
    }, { shot: p, device: '电脑' });
  }
  for (const v of ['外观', '半剖', '内部']) {
    await r.step(`建筑：${v}`, async () => {
      await btn(v).click();
      await p.waitForTimeout(1500);
    }, { shot: p, device: '电脑' });
  }
  await r.step('叠加层：拣货热度', async () => {
    await p.getByLabel('叠加层').selectOption({ label: '拣货热度' });
    await p.waitForTimeout(1500);
  }, { shot: p, device: '电脑' });

  await r.step('策略对比：基线 / 默认档位 / 效率优先在同样的订单和随机事件上比较', async () => {
    await p.getByLabel('叠加层').selectOption({ label: '温区' });
    await panel('策略对比').click();
    // 后台算完三种策略后显示对比表
    await expect(p.locator('.data-pane .compare').first()).toBeVisible();
    await expect(p.locator('.data-pane .compare').getByText('正在后台计算三种策略（不影响左侧播放）…')).toHaveCount(0, { timeout: 60_000 });
    await p.waitForTimeout(1000);
    return (await p.locator('.data-pane .compare').first().innerText()).split('\n').slice(0, 18).join(' · ');
  }, { shot: p, device: '电脑' });

  await r.step('方案与报告：保存方案、连续多天、经营账、导出报告', async () => {
    await panel('方案与报告').click();
    await p.waitForTimeout(1500);
    return (await p.locator('.data-pane').first().innerText()).split('\n').slice(0, 14).join(' · ');
  }, { shot: p, device: '电脑' });

  await r.step('换成家居建材店模板：板材墙、建材、家电，没有冷柜；园艺中心', async () => {
    await panel('实时数据').click();
    await p.locator('select').filter({ has: p.locator('option[value="hardware"]') }).first().selectOption('hardware');
    await expect(p.getByText(/仿真用时/)).toBeVisible();
    await p.waitForTimeout(3000);
    return (await p.getByText(/单 · 仿真用时/).innerText()).trim();
  }, { shot: p, device: '电脑' });

  await r.step('布局编辑：实时应用、可以撤销（截编辑模式）', async () => {
    await btn('编辑布局').click();
    await p.waitForTimeout(1500);
    const txt = (await p.locator('.data-pane').first().innerText()).split('\n').slice(0, 10).join(' · ');
    await btn('完成编辑').first().click();
    return txt;
  }, { shot: p, device: '电脑' });

  await r.step('巡游：镜头自动在门店、停车场、后仓和路口之间切换', async () => {
    await btn('巡游').click();
    await p.waitForTimeout(5000);
  }, { shot: p, device: '电脑' });
  await p.keyboard.press('Escape');
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
