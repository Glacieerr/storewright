import { expect, type Page } from '@playwright/test';
import { Recorder } from './recorder';
import { SITE, test } from './helpers';

const app = (p: Page, fn: string) => p.evaluate(`(() => { const s = window.__sw.useApp.getState(); return (${fn})(s); })()`);
const at = async (p: Page, t: number, frame: string) => {
  await p.evaluate(`(() => { window.__sw.clock.playing = false; window.__sw.setTime(${t}); window.__sw.useApp.getState().frame(${frame}); })()`);
  await p.waitForTimeout(1800);
};

/**
 * 车辆拟真（决策记录 0013、0018）：按公开外形建模的车辆、加减速、转向的前轮、刹车灯 / 倒车灯 / 双闪、车身姿态；
 * 铰接半挂车（挂车跟随）；卸货场（待命车道先到先进、绕到靠台车道、车头外摆、从司机一侧倒车靠台、绕场驶离）、
 * 卸货门调度（冷藏车用冷藏门）和卷帘门；叉车从车厢里倒出来；停车场里的房车、倒车入位；运营孪生里的车辆
 */
test('14 车辆拟真', async ({ browser }) => {
  const r = new Recorder('车辆拟真', 14);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));
  await p.goto('/sim/?debug');
  await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });

  const trucks = (await app(p, '(s) => s.timeline.inbound.trucks')) as Array<{ id: string; kind: string; label: string; door: number; arrive: number; dockAt: number; dockedAt: number; unloadStart: number; leave: number; pallets: number }>;
  const KIND: Record<string, string> = { SEMI: '半挂车', REEFER: '冷藏半挂车', BOX: '厢式货车', VAN: '面包车' };
  const hm = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
  r.note('到货车辆与卸货门', trucks.map((t) => `${t.label}（${KIND[t.kind] ?? t.kind}，${t.pallets} 托）门 ${t.door + 1}：到达 ${hm(t.arrive)}${t.dockAt > t.arrive + 30 ? `，在待命车道排队到 ${hm(t.dockAt)}` : ''}，靠稳 ${hm(t.dockedAt)}，卸货 ${hm(t.unloadStart)}，驶离 ${hm(t.leave)}`).join('；'));
  const reefer = trucks.find((t) => t.kind === 'REEFER');
  if (!reefer) throw new Error('no reefer');
  const docks = (await app(p, '(s) => s.simGeo.docks')) as Array<{ x: number; z: number; reefer: boolean }>;
  const door = docks[reefer.door] ?? docks[0];
  const frame = `${door?.x ?? 60}, 0, ${(door?.z ?? 40) + 14}, 26`;

  await r.step('冷藏半挂车（蓝色长头卧铺牵引车 + 带冷机的挂车）清晨沿后勤通道开进卸货场：车灯亮着，挂车跟着牵引车转弯', async () => {
    await at(p, reefer.arrive + 25, `${door?.x ?? 60}, 0, ${(door?.z ?? 40) + 40}, 60`);
    return `冷藏车用冷藏门（门 ${reefer.door + 1}${door?.reefer ? '，冷藏' : ''}）`;
  }, { shot: p, device: '电脑' });

  await r.step('驶过卸货门、车头向外一摆停下，司机下车打开挂车后门（双闪）', async () => {
    await at(p, reefer.dockAt + 130, `${door?.x ?? 60}, 0, ${(door?.z ?? 40) + 30}, 34`);
  }, { shot: p, device: '电脑' });

  await r.step('从司机一侧倒车：挂车先在离墙 24 米外摆正，再笔直退进门里，牵引车跟着折角（倒车灯、双闪）', async () => {
    await at(p, reefer.dockAt + 175, `${door?.x ?? 60}, 0, ${(door?.z ?? 40) + 22}, 30`);
  }, { shot: p, device: '电脑' });

  await r.step('靠台卸货：卷帘门升起，门边信号灯变红；叉车进车厢叉托盘', async () => {
    await at(p, reefer.unloadStart + 150, frame);
  }, { shot: p, device: '电脑' });

  await r.step('叉车叉着托盘从车厢里倒出来（车头仍朝车厢），再开到收货区', async () => {
    const t = (await app(p, `(s) => { for (const e of s.timeline.inbound.equipment) for (const g of e.segments) if (g.reverseLegs && g.t0 >= ${reefer.unloadStart}) return g.t0 + (g.t1 - g.t0) * 0.15; return ${reefer.unloadStart + 300}; }`)) as number;
    await at(p, t, `${door?.x ?? 60}, 0, ${(door?.z ?? 40) - 3}, 9`);
    return `时刻 ${hm(t)}`;
  }, { shot: p, device: '电脑' });

  const box = trucks.find((t) => t.kind === 'BOX');
  if (box) {
    await r.step('白天的供应商厢式货车：沿后勤通道开进卸货场，绕到靠台车道倒车靠台；场地里有别的车在倒车时先在待命车道排队', async () => {
      const bd = docks[box.door] ?? docks[0];
      await at(p, box.dockAt + 90, `${bd?.x ?? 60}, 0, ${(bd?.z ?? 40) + 24}, 34`);
      return `${box.id}：门 ${box.door + 1}${box.dockAt > box.arrive + 30 ? `，排队 ${Math.round((box.dockAt - box.arrive) / 60)} 分钟` : ''}`;
    }, { shot: p, device: '电脑' });
  }

  await r.step('停车场最远一排的端头：房车和带拖车的车平行于车道停在几个车位的前沿上', async () => {
    await at(p, 11 * 3600, '0, 0, 0, 1');
    await app(p, '(s) => { const l = s.simGeo.lot; s.frame((l.minX + l.maxX) / 2, 0, l.edgeZ + 4, 70); }');
  }, { shot: p, device: '电脑' });

  await r.step('中午的停车场：顾客的车开进车位、倒出车位；也有人倒车入位、穿过对面空车位（起步、刹车、过弯减速时车身点头、侧倾）', async () => {
    await at(p, 12 * 3600 + 15 * 60, '0, 0, 0, 1');
    await app(p, '(s) => s.frame(s.simGeo.lot.pickupSign.x, 0, s.simGeo.lot.pickupSign.z - 8, 24)');
    await p.evaluate('window.__sw.clock.playing = true');
    await p.waitForTimeout(2500);
    await p.evaluate('window.__sw.clock.playing = false');
  }, { shot: p, device: '电脑' });

  await r.step('夜里的路口：背景车流开着车灯，前车刹车时尾灯变亮', async () => {
    await at(p, 21 * 3600 + 40 * 60, '0, 0, 0, 1');
    await app(p, '(s) => s.frame(s.simGeo.lot.pickupSign.x, 0, s.simGeo.lot.edgeZ - 12, 40)');
    await p.evaluate('window.__sw.clock.playing = true');
    await p.waitForTimeout(2500);
    await p.evaluate('window.__sw.clock.playing = false');
  }, { shot: p, device: '电脑' });

  // 运营孪生：控制台打开自动运营，顾客的车按自己填的车型和颜色开进取货车位
  const con = await ctx.newPage();
  const live = await ctx.newPage();
  await r.step('运营孪生里的车辆：打开自动运营后，虚拟顾客按自己填的车型和颜色开进取货车位，交付后倒出驶离；路上有背景车流', async () => {
    await con.goto('/app/?demo&store=demo&as=console&debug');
    const card = con.locator('.card.autopilot');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.getByLabel('每小时订单').selectOption('160');
    await card.getByLabel('作业速度').selectOption('4');
    await card.getByRole('button', { name: '开始自动运营' }).click();
    await live.goto(`/sim/?live=demo&store=demo&bridge=${encodeURIComponent(`${SITE}/app/bridge.html`)}&debug`);
    await expect(live.locator('.live-chip', { hasText: '已连接' }).or(live.getByText(/已连接/)).first()).toBeVisible({ timeout: 90_000 });
    await expect.poll(async () => live.locator('.live-label.car').count(), { timeout: 150_000 }).toBeGreaterThan(0);
    await live.evaluate('(() => { const s = window.__sw.useApp.getState(); s.frame(s.simGeo.lot.pickupSign.x, 0, s.simGeo.lot.pickupSign.z - 4, 16); })()');
    await live.waitForTimeout(2500);
    const labels = await live.locator('.live-label.car').allInnerTexts();
    await card.getByRole('button', { name: '停止自动运营' }).click();
    return `到店的车：${labels.join('、')}`;
  }, { shot: live, device: '电脑' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
