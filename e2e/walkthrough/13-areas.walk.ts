import { expect, test, type Page } from '@playwright/test';
import { Recorder } from './recorder';
import { signIn, SITE, tab } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sw = any;
const app = (p: Page, fn: string) => p.evaluate(`(() => { const s = window.__sw.useApp.getState(); return (${fn})(s); })()`);

/** 区域、卸货门与线上取货车位（决策记录 0013）：编辑器里逐个编辑、校验，场景里画出来，作业里按区域统计占用 */
test('13 区域、卸货门与取货车位', async ({ browser }) => {
  const r = new Recorder('区域、卸货门与取货车位', 13);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));

  await r.step('模拟器里的区域：冷藏库、冷冻库（步入式冷库）、托盘货架区、收货区的卸货区 / 暂放 / 待检 / 退供应商 / 空托盘 / 纸箱回收、暂存区和大件暂存区', async () => {
    await p.goto('/sim/?debug');
    await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });
    await app(p, '(s) => s.frame(36, 0, 32, 30)');
    await p.waitForTimeout(2500);
    return String(await app(p, "(s) => s.simGeo.areas.map((a) => a.id).join('、')"));
  }, { shot: p, device: '电脑' });

  await r.step('叠加层「区域占用」：按占用着色（仿真里用暂存占用和后仓托盘数），标出百分比', async () => {
    await p.getByLabel('叠加层').selectOption({ label: '区域占用' });
    await p.waitForTimeout(2000);
  }, { shot: p, device: '电脑' });

  await r.step('编辑器：区域与卸货门（自动生成的区域先「改为手动编辑」，布局不变）', async () => {
    await p.getByLabel('叠加层').selectOption({ label: '温区' });
    await p.getByRole('button', { name: '编辑布局', exact: true }).click();
    await p.getByRole('button', { name: '改为手动编辑' }).click();
    const n = Number(await app(p, '(s) => s.draft.areas.length'));
    expect(n).toBeGreaterThan(10);
    await p.locator('.area-editor').scrollIntoViewIfNeeded();
    return `${n} 个区域、${await app(p, '(s) => s.draft.docks.length')} 个卸货门写进了门店配置`;
  }, { shot: p, device: '电脑' });

  await r.step('选中冷藏库：名称、类型、温区、容量、预警线、位置都可以改；场景里出现移动把手和改大小把手', async () => {
    await p.locator('.area-row', { hasText: 'COOLER-1' }).click();
    const fields = p.locator('.area-fields');
    await fields.getByLabel('容量').fill('480');
    await p.waitForTimeout(800);
    await app(p, '(s) => s.frame(6, 0, 34, 12)');
    await p.waitForTimeout(1500);
    return `冷藏库容量 ${await app(p, "(s) => s.draft.areas.find((a) => a.id === 'COOLER-1').capacity")} 箱`;
  }, { shot: p, device: '电脑' });

  await r.step('新建一个「叉车充电区」：自动放在空地上；把它移到冷藏库上面时校验报「区域重叠」', async () => {
    await p.getByLabel('新区域的类型').selectOption({ label: '叉车充电区' });
    await p.getByRole('button', { name: '添加区域' }).click();
    const id = String(await app(p, '(s) => s.areaSel'));
    await app(p, `(s) => s.updateDraft((d) => { const a = d.areas.find((x) => x.id === '${id}'); const c = d.areas.find((x) => x.id === 'COOLER-1'); const w = a.x1 - a.x0, h = a.z1 - a.z0; a.x0 = c.x0 + 1; a.z0 = c.z0 + 1; a.x1 = a.x0 + w; a.z1 = a.z0 + h; })`);
    await p.waitForTimeout(1200);
    const issues = String(await app(p, "(s) => (s.draftIssues || []).map((i) => i.message).join('；')"));
    expect(issues).toContain('区域重叠');
    await p.getByRole('button', { name: '删除这个区域' }).click();
    await p.waitForTimeout(800);
    return `${id}：${issues.slice(0, 120)}；删除后问题消失：${String(await app(p, '(s) => (s.draftIssues || []).length'))} 个问题`;
  }, { shot: p, device: '电脑' });

  await r.step('卸货门：加一个卸货门（自动放在后墙上离已有门最远的地方），把第一个门设为地面卷帘门', async () => {
    await p.getByRole('button', { name: '添加卸货门' }).click();
    await p.locator('.area-editor .dock-list li').first().getByRole('combobox').selectOption('GRADE');
    await p.waitForTimeout(800);
    const docks = String(await app(p, "(s) => s.draft.docks.map((d) => d.id + ' x=' + d.x + (d.reefer ? ' 冷藏' : '') + (d.kind === 'GRADE' ? ' 地面门' : '')).join('、')"));
    await p.locator('.area-editor h4', { hasText: '卸货门' }).scrollIntoViewIfNeeded();
    return docks;
  }, { shot: p, device: '电脑' });

  await r.step('线上取货车位：改为手动摆放后，每个车位有编号、位置和车头朝向；加一个车位、按离交付门的距离重新编号', async () => {
    await p.getByRole('button', { name: '改为手动摆放' }).click();
    const before = Number(await app(p, '(s) => s.draft.parking.pickupBays.length'));
    await p.getByRole('button', { name: '添加取货车位' }).click();
    await p.getByRole('button', { name: '按离交付门的距离重新编号' }).click();
    await p.waitForTimeout(1200);
    await app(p, '(s) => s.frame(s.geo.lot.pickupSign.x, 0, s.geo.lot.pickupSign.z - 4, 18)');
    await p.waitForTimeout(1500);
    const ids = String(await app(p, "(s) => s.draft.parking.pickupBays.map((b) => b.id).join(' ')"));
    await p.locator('.bay-editor').scrollIntoViewIfNeeded();
    return `${before} → ${before + 1} 个车位：${ids}`;
  }, { shot: p, device: '电脑' });

  await r.step('校验通过、实时应用；退出编辑后按新的区域和车位跑一天', async () => {
    const issues = Number(await app(p, '(s) => (s.draftIssues || []).length'));
    expect(issues).toBe(0);
    await p.getByRole('button', { name: '完成编辑' }).first().click();
    await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });
    await p.waitForTimeout(1500);
  }, { shot: p, device: '电脑' });

  const drew = await signIn(browser, 'Drew');
  await r.step('员工手机：库存页的「区域」——每个区域的占用、容量、预警线和尺寸，按收货 / 后仓存储 / 暂存分组', async () => {
    await tab(drew, '库存');
    await drew.getByRole('tab', { name: /区域/ }).click();
    await expect(drew.locator('.area-board')).toBeVisible();
    return (await drew.locator('.area-board .note').first().innerText()).trim();
  }, { shot: drew, device: '后仓员工手机', fullPage: true });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});

export type { Sw };
