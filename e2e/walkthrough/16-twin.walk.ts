import { expect } from '@playwright/test';
import { Recorder } from './recorder';
import { LIVE, SITE, test } from './helpers';

/**
 * 数字孪生（决策记录 0016）：设备读数进三维孪生和控制台；暂存冷藏柜故障 → 告警（带影响）→ 带班负责人确认；
 * 孪生时间轴回放到过去、推演未来；修复后告警自动解除；设备遥测和回放的接口（真实后端）。
 */
test('16 数字孪生：设备告警、回放与推演', async ({ browser, request }) => {
  const r = new Recorder('数字孪生：设备告警、回放与推演', 16);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', baseURL: SITE });
  const page = await ctx.newPage();
  const con = page.frameLocator('iframe.sc-console');
  const sim = page.frameLocator('iframe.sc-sim');

  await r.step('展示页左栏「上下并排」：上面是三维数字孪生，下面是控制台；场景里的设备牌显示冷库、暂存冷柜、卸货门和入口客流的读数', async () => {
    await page.goto('/app/showcase.html?layout=split');
    await expect(sim.locator('.live-chip', { hasText: '已连接' })).toBeVisible({ timeout: 90_000 });
    await expect(sim.locator('.twin-label', { hasText: '暂存冷藏柜' })).toHaveCount(1, { timeout: 60_000 });
    await page.waitForTimeout(2500);
    // 场景小的时候设备牌按重要程度去重叠，被挡住的牌暂时隐藏
    const labels = await sim.locator('.twin-label:not(.declutter-hidden)').allInnerTexts();
    const total = await sim.locator('.twin-label').count();
    return `场景里 ${total} 块设备牌，此刻看得见的：${labels.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('；')}`;
  }, { shot: page, device: '电脑' });

  await r.step('控制台的「设备与告警」：每台设备的读数和状态，演示门店可以制造故障', async () => {
    const card = con.locator('.card.twin-card');
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.twin-readings li').first()).toBeVisible();
    return (await card.locator('.twin-readings').innerText()).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }, { shot: page, device: '电脑' });

  await r.step('点「暂存冷藏柜故障」：温度持续升高，约 1 分钟越过严重线（8 °C），孪生里设备牌变红、暂存冷柜所在区域闪红，控制台出现告警和影响', async () => {
    const t0 = Date.now();
    await con.getByRole('button', { name: '暂存冷藏柜故障' }).click();
    await expect(sim.locator('.twin-label.s-alarm', { hasText: '暂存冷藏柜' })).toBeVisible({ timeout: 150_000 });
    const alert = con.locator('.twin-alert.alarm').first();
    await expect(alert).toBeVisible();
    await page.waitForTimeout(1500);
    return `${((Date.now() - t0) / 1000).toFixed(0)} 秒后告警：${(await alert.innerText()).replace(/\n+/g, ' · ')}`;
  }, { shot: page, device: '电脑' });

  await r.step('带班负责人 Taylor 的手机：顶部的告警条，展开后点「确认，我来处理」；引导第 7 步「孪生」打勾', async () => {
    await page.locator('.phone select').first().selectOption('A08');
    const lead = page.frameLocator('.phone iframe').first();
    const banner = lead.locator('.alert-banner.alarm');
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await banner.locator('.alert-banner-head').click();
    await lead.getByRole('button', { name: '确认，我来处理' }).click();
    await expect(lead.getByText('已确认，正在处理')).toBeVisible();
    await expect(page.locator('.sc-steps li').nth(6)).toHaveClass(/done/);
    return (await banner.innerText()).replace(/\n+/g, ' · ');
  }, { shot: page, device: '电脑' });

  await r.step('场景右上角的「孪生面板」：孪生健康度（有告警时扣分）、设备与传感器（迷你曲线）、设备告警（已确认）、推演', async () => {
    await sim.getByRole('button', { name: '孪生面板' }).click();
    const drawer = sim.locator('.twin-drawer');
    await expect(drawer.locator('.twin-score')).toBeVisible();
    await expect(drawer.locator('.twin-alerts')).toContainText('已确认');
    return `${(await drawer.locator('.twin-score').innerText()).trim()}；${(await drawer.locator('.twin-facts').innerText()).replace(/\n+/g, ' ')}`;
  }, { shot: page, device: '电脑' });

  await r.step('推演：未来 3 小时的预计（今天实测校准），试「+1 拣货员」和现状对比', async () => {
    const drawer = sim.locator('.twin-drawer');
    await drawer.locator('.twin-plans').getByRole('button', { name: '+1 拣货员' }).click();
    await expect(drawer.locator('table.twin-kpi th', { hasText: '方案' })).toBeVisible();
    await drawer.locator('table.twin-kpi').scrollIntoViewIfNeeded();
    const basis = (await drawer.locator('.twin-plans').locator('xpath=preceding-sibling::p[1]').innerText()).trim();
    return `${basis}；${(await drawer.locator('table.twin-kpi').innerText()).replace(/\n+/g, ' ').replace(/\t/g, ' ')}`;
  }, { shot: page, device: '电脑' });

  await r.step('孪生时间轴往回 30 分钟：场景、面板回到那一刻的门店（那时还没有告警）', async () => {
    await sim.getByRole('button', { name: '孪生面板' }).click();
    await sim.getByRole('button', { name: '◀ 回放' }).click();
    const card = sim.locator('.twin-card.replay');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    return (await card.innerText()).replace(/\n+/g, ' ');
  }, { shot: page, device: '电脑' });

  await r.step('往后推演 1 小时：场景上方显示那一刻预计的等候顾客、待交付、拣货积压和赶不上时段的订单', async () => {
    await sim.getByRole('button', { name: '推演 ▶' }).click();
    await sim.getByRole('button', { name: '推演 ▶' }).click();
    const card = sim.locator('.twin-card.forecast');
    await expect(card).toContainText('预计');
    return (await card.innerText()).replace(/\n+/g, ' ');
  }, { shot: page, device: '电脑' });

  await r.step('回到实时，控制台「全部修复」：温度回落到告警线以内 30 秒后，告警自动解除（写进事件流，记下持续时长和最高温度）', async () => {
    await sim.getByRole('button', { name: '实时', exact: true }).click();
    await con.getByRole('button', { name: '全部修复' }).click();
    await expect(sim.locator('.twin-label.s-alarm')).toHaveCount(0, { timeout: 150_000 });
    await expect(con.locator('.twin-alert')).toHaveCount(0, { timeout: 30_000 });
    return (await con.locator('.twin-readings li', { hasText: '暂存冷藏柜' }).innerText()).replace(/\n+/g, ' ');
  }, { shot: page, device: '电脑' });

  // 真实后端：设备遥测接入、孪生快照、回放
  const api = (path: string) => `${LIVE}/api${path}`;
  await r.step('真实后端的设备遥测接入：POST /api/stores/demo/telemetry（一次可以发多条；不认识的传感器拒收）', async () => {
    const res = await request.post(api('/stores/demo/telemetry'), { data: { readings: [{ sensor: 'T-COOLER-1', value: 3.4 }, { sensor: 'D-DOOR-1', value: 0 }, { sensor: 'X-UNKNOWN', value: 1 }] } });
    expect(res.status()).toBe(200);
    return JSON.stringify(await res.json());
  });

  await r.step('孪生快照与回放接口：GET /twin（读数、健康度、最近 60 分钟的曲线）和 GET /twin/at?t=（任意时刻的门店）', async () => {
    const { token } = (await (await request.post(api('/stores/demo/session'), { data: { role: 'viewer' } })).json()) as { token: string };
    const headers = { authorization: `Bearer ${token}` };
    const snap = (await (await request.get(api('/stores/demo/twin'), { headers })).json()) as { frame: { sensors: unknown[]; health: { score: number } }; from?: number };
    const at = Date.now() - 10 * 60_000;
    const past = (await (await request.get(api(`/stores/demo/twin/at?t=${at}`), { headers })).json()) as { at: number; state: { seq: number; orders: Record<string, unknown> } };
    return `传感器 ${snap.frame.sensors.length} 个，健康度 ${snap.frame.health.score}；回放到 10 分钟前：事件序号 #${past.state.seq}、订单 ${Object.keys(past.state.orders).length} 张`;
  });

  await ctx.close();
});
