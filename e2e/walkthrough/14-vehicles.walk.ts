import { expect, test, type Page } from '@playwright/test';
import { Recorder } from './recorder';
import { SITE } from './helpers';

const app = (p: Page, fn: string) => p.evaluate(`(() => { const s = window.__sw.useApp.getState(); return (${fn})(s); })()`);
const at = async (p: Page, t: number, frame: string) => {
  await p.evaluate(`(() => { window.__sw.clock.playing = false; window.__sw.setTime(${t}); window.__sw.useApp.getState().frame(${frame}); })()`);
  await p.waitForTimeout(1800);
};

/**
 * 车辆拟真（决策记录 0013）：加减速、转向的前轮、刹车灯 / 倒车灯 / 双闪；铰接半挂车（挂车跟随、倒车靠台）；
 * 卸货门调度（同一个门只停一辆车，冷藏车用冷藏门）和卷帘门；叉车从车厢里倒出来；门店实况里的车辆
 */
test('14 车辆拟真', async ({ browser }) => {
  const r = new Recorder('车辆拟真', 14);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));
  await p.goto('/sim/?debug');
  await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });

  const trucks = (await app(p, '(s) => s.timeline.inbound.trucks')) as Array<{ id: string; kind: string; door: number; arrive: number; dockAt: number; unloadStart: number; leave: number; pallets: number }>;
  const hm = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
  r.note('到货车辆与卸货门', trucks.map((t) => `${t.id}（${t.kind === 'REEFER' ? '冷藏半挂' : t.kind === 'SEMI' ? '长途半挂' : '厢式货车'}，${t.pallets} 托）门 ${t.door + 1}：到达 ${hm(t.arrive)}${t.dockAt > t.arrive + 30 ? `，等门到 ${hm(t.dockAt)}` : ''}，卸货 ${hm(t.unloadStart)}，驶离 ${hm(t.leave)}`).join('；'));
  const reefer = trucks.find((t) => t.kind === 'REEFER');
  if (!reefer) throw new Error('no reefer');
  const docks = (await app(p, '(s) => s.simGeo.docks')) as Array<{ x: number; z: number; reefer: boolean }>;
  const door = docks[reefer.door] ?? docks[0];
  const frame = `${door?.x ?? 60}, 0, ${(door?.z ?? 40) + 14}, 26`;

  await r.step('冷藏半挂车（蓝色牵引车 + 带冷机的挂车）清晨开上卸货场：车灯亮着，挂车跟着牵引车转弯', async () => {
    await at(p, reefer.arrive - 40, frame);
    return `冷藏车用冷藏门（门 ${reefer.door + 1}${door?.reefer ? '，冷藏' : ''}）`;
  }, { shot: p, device: '电脑' });

  await r.step('倒车靠台：挂车沿圆弧退进卸货口，牵引车跟着折角（倒车灯、双闪）', async () => {
    await at(p, reefer.dockAt + 110, frame);
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
    await r.step('白天的供应商厢式货车：从服务道路开来、倒车靠台；同一个门有车时在门前等（双闪）', async () => {
      const bd = docks[box.door] ?? docks[0];
      await at(p, box.dockAt + 60, `${bd?.x ?? 60}, 0, ${(bd?.z ?? 40) + 12}, 22`);
      return `${box.id}：门 ${box.door + 1}${box.dockAt > box.arrive + 30 ? `，等了 ${Math.round((box.dockAt - box.arrive) / 60)} 分钟` : ''}`;
    }, { shot: p, device: '电脑' });
  }

  await r.step('中午的停车场：顾客的车开进车位、倒出车位（起步、刹车、过弯减速，前轮转向）', async () => {
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

  // 门店实况：控制台打开自动运营，顾客的车按自己填的车型和颜色开进取货车位
  const con = await ctx.newPage();
  const live = await ctx.newPage();
  await r.step('门店实况里的车辆：打开自动运营后，虚拟顾客按自己填的车型和颜色开进取货车位，交付后倒出驶离；路上有背景车流', async () => {
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
