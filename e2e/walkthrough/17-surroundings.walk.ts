import { expect, type Page } from '@playwright/test';
import { Recorder } from './recorder';
import { SITE, test } from './helpers';

const app = (p: Page, fn: string) => p.evaluate(`(() => { const s = window.__sw.useApp.getState(); return (${fn})(s); })()`);
/** 暂停在某个仿真时刻，镜头对准 (x, y, z)、半径 r 的范围（保持当前的视线方向） */
const at = async (p: Page, t: number, frame: string) => {
  await p.evaluate(`(() => { window.__sw.clock.playing = false; window.__sw.setTime(${t}); window.__sw.useApp.getState().frame(${frame}); })()`);
  await p.waitForTimeout(1800);
};
/** 暂停在某个仿真时刻，相机放在 cam、看向 tgt（门店背后、侧面的镜头要换视线方向） */
const look = async (p: Page, t: number, cam: readonly number[], tgt: readonly number[]) => {
  await p.evaluate(`(() => { const sw = window.__sw; sw.clock.playing = false; sw.setTime(${t}); const th = sw.three(); th.camera.position.set(${cam.join(',')}); th.controls.target.set(${tgt.join(',')}); th.controls.update(); })()`);
  await p.waitForTimeout(1800);
};
const yardForm = (p: Page) => p.locator('div.form', { has: p.getByRole('heading', { name: '卸货场', exact: true }) });
/** 等重新仿真跑完 */
const settle = async (p: Page) => {
  await p.waitForTimeout(600);
  await expect.poll(async () => app(p, '(s) => s.status'), { timeout: 90_000 }).toBe('ready');
  await p.waitForTimeout(1500);
};

interface Tk {
  id: string;
  kind: string;
  label: string;
  source?: string;
  appt?: number;
  arrive: number;
  dockAt: number;
  goneAt: number;
  pallets: number;
  door: number;
}
interface Box {
  minX: number;
  maxX: number;
  maxZ: number;
}
const KIND: Record<string, string> = { SEMI: '半挂车', REEFER: '冷藏半挂车', BOX: '厢式货车', VAN: '面包车' };
const hm = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;

/**
 * 卸货场、到货排班与周边环境（决策记录 0019）：到货车辆按星期、季节和门店规模排班（配送中心半挂车、供应商直送、快递），
 * 路况让车晚到；后勤通道接主路的喇叭口（半挂车走圆弧，不用直角转弯）、停车场一进一出的出入口；卸货场在门店哪一侧、
 * 接主路还是支路、待命车位和甩挂车位可以自定义；湖经出海口通到海湾，船只进港、离港，帆船经过时开合桥抬起；
 * 铁路道口和学校带来的问题；没有水面的环境；暂存区的冷藏库、冷冻库和连通通道；两层门店二楼的收银区、补货区和卸货区（货梯）
 */
test('17 卸货场、到货排班与周边环境', async ({ browser }) => {
  const r = new Recorder('卸货场、到货排班与周边环境', 17);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));
  await p.goto('/sim/?debug');
  await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });
  await p.getByRole('button', { name: '3D', exact: true }).click();
  await p.waitForTimeout(2000);
  const trucksOf = async () => (await app(p, '(s) => s.timeline.inbound.trucks')) as Tk[];
  const store = async () => (await app(p, '(s) => { const f = s.simGeo.floors[0]; return { minX: f.minX, maxX: f.maxX, maxZ: f.maxZ }; }')) as Box;
  const weekday = (name: string) => p.getByRole('group', { name: '星期' }).getByRole('button', { name, exact: true });

  await r.step('今日到货（默认周四）：配送中心的冷藏半挂车清晨到、长途半挂车夜里到；供应商直送多在上午；快递下午来。比预约晚 10 分钟以上的标出来；点车名跳到它进场前、镜头跟随', async () => {
    const ts = await trucksOf();
    await p.locator('details.deliveries summary').click();
    await p.locator('details.deliveries').scrollIntoViewIfNeeded();
    const late = ts.filter((t) => t.appt !== undefined && t.arrive - t.appt >= 600);
    return `${ts.length} 辆：${ts.map((t) => `${hm(t.arrive)} ${t.label}（${KIND[t.kind] ?? t.kind}，${t.pallets} 托）`).join('、')}${late.length ? `；路上耽误、比预约晚 10 分钟以上的 ${late.length} 辆` : ''}`;
  }, { shot: p, device: '电脑' });

  await r.step('换星期：周一供应商直送最多；周六晚上没有配送中心的长途半挂车；周日供应商基本不送货（截周日）', async () => {
    const out: string[] = [];
    for (const name of ['周一', '周六', '周日']) {
      await weekday(name).click();
      await settle(p);
      const ts = await trucksOf();
      const dc = ts.filter((t) => (t.source ?? 'DC').startsWith('DC')).length;
      out.push(`${name} ${ts.length} 辆（配送中心 ${dc}、供应商直送 ${ts.filter((t) => t.source === 'VENDOR').length}、快递 ${ts.filter((t) => t.source === 'PARCEL').length}）`);
    }
    await p.locator('details.deliveries').scrollIntoViewIfNeeded();
    return out.join('；');
  }, { shot: p, device: '电脑' });

  await r.step('半挂车从主路转进后勤通道：路口两边是 15 米半径的喇叭口，牵引车沿圆弧转弯、挂车跟着内切，不用直角转弯', async () => {
    await weekday('周四').click();
    await settle(p);
    await p.waitForTimeout(1000);
    // 白天到的半挂车（没有就用第一辆）走到喇叭口的时刻
    const m = (await p.evaluate(`(() => {
      const sw = window.__sw; const site = sw.site; const lot = sw.useApp.getState().simGeo.lot;
      const semis = sw.yardTrucks.filter((x) => x.kind === 'SEMI' || x.kind === 'REEFER');
      const tk = semis.find((x) => x.arrive > 7 * 3600 && x.arrive < 18 * 3600) ?? semis[0];
      const st = { x: 0, z: 0, heading: 0 };
      let best = 0, bd = Infinity;
      for (let tau = 0; tau < tk.approach.duration; tau += 0.25) { tk.approach.at(tau, st); const d = Math.hypot(st.x - site.access.x, st.z - (lot.edgeZ + 4)); if (d < bd) { bd = d; best = tau; } }
      const f = Math.min(12, Math.max(1, sw.clock.speed / 8));
      return { id: tk.id, t: tk.arrive - (tk.approach.duration - best) * f, x: site.access.x, z: lot.edgeZ };
    })()`)) as { id: string; t: number; x: number; z: number };
    await look(p, m.t, [m.x - 28, 32, m.z - 36], [m.x - 6, 0, m.z + 6]);
    return `${m.id}，${hm(m.t)}`;
  }, { shot: p, device: '电脑' });

  await r.step('卸货场：单向绕行车道和导向箭头；半挂车绕到靠台车道、驶过卸货门后从司机一侧倒车靠台', async () => {
    const ts = await trucksOf();
    const tk = ts.find((t) => (t.kind === 'SEMI' || t.kind === 'REEFER') && t.arrive > 7 * 3600 && t.arrive < 18 * 3600) ?? ts[0];
    if (!tk) throw new Error('no truck');
    const g = await store();
    await look(p, tk.dockAt + 170, [g.maxX + 38, 42, g.maxZ + 70], [g.maxX - 12, 0, g.maxZ + 22]);
    return `${tk.label}，${hm(tk.dockAt + 170)}`;
  }, { shot: p, device: '电脑' });

  await r.step('停车场出入口：一进一出两条车道、中间隔离岛、6 米半径的喇叭口；进出车道各有导向箭头', async () => {
    const m = (await p.evaluate('(() => { const s = window.__sw.site; return s.medians[0] ?? { x: 0, z: 0 }; })()')) as { x: number; z: number };
    await look(p, 11 * 3600 + 20 * 60, [m.x + 10.5, 18, m.z - 20], [m.x + 0.5, 0, m.z + 4]);
  }, { shot: p, device: '电脑' });

  await r.step('自定义卸货场：编辑器里把进场道路改到门店左侧、经侧面支路进出，待命车位 3 个、甩挂车位 6 个；场地按新设置重新画', async () => {
    await p.getByRole('button', { name: '编辑布局', exact: true }).click();
    // 编辑器自己的「卸货场」一节（门店生成器里也有一份同样的字段）
    const yard = yardForm(p);
    await yard.scrollIntoViewIfNeeded();
    await yard.getByLabel('进场道路在哪一侧').selectOption('LEFT');
    await yard.getByLabel('进场道路接到哪里').selectOption('STREET');
    await yard.locator('label', { hasText: '待命车位' }).locator('input').fill('3');
    await yard.locator('label', { hasText: '甩挂车位' }).locator('input').fill('6');
    await p.waitForTimeout(800);
    const y = String(await app(p, '(s) => JSON.stringify(s.draft.outdoor.yard)'));
    await p.getByRole('button', { name: '完成编辑' }).first().click();
    await settle(p);
    const g = await store();
    const lotMinX = Number(await app(p, '(s) => s.simGeo.lot.minX'));
    await look(p, 7 * 3600, [lotMinX - 140, 150, g.maxZ + 160], [lotMinX + 20, 0, g.maxZ + 30]);
    return `门店配置 outdoor.yard = ${y}`;
  }, { shot: p, device: '电脑' });

  await r.step('改回默认（右侧、专用后勤通道）', async () => {
    await p.getByRole('button', { name: '编辑布局', exact: true }).click();
    const yard = yardForm(p);
    await yard.getByLabel('进场道路在哪一侧').selectOption('RIGHT');
    await yard.getByLabel('进场道路接到哪里').selectOption('DRIVE');
    await yard.locator('label', { hasText: '待命车位' }).locator('input').fill('0');
    await yard.locator('label', { hasText: '甩挂车位' }).locator('input').fill('0');
    await p.getByRole('button', { name: '完成编辑' }).first().click();
    await settle(p);
  });

  await r.step('湖经出海口通到海湾：帆船出海经过环湖步道时，开合桥的两扇桥面抬起', async () => {
    const m = (await p.evaluate(`(() => {
      const sw = window.__sw; const o = sw.site.water.outlet; const st = { x: 0, z: 0, heading: 0 };
      const f = Math.min(12, Math.max(1, sw.clock.speed / 8));
      const leg = sw.boats.find((b) => b.boat === 'sail' && b.kind === 'out');
      let best = 0, bd = Infinity;
      for (let tau = 0; tau < leg.path.duration; tau += 0.5) { leg.path.at(tau, st); const d = Math.hypot(st.x - o.x, st.z - o.bridge.z); if (d < bd) { bd = d; best = tau; } }
      return { t: leg.start + best * f, x: o.x, z: o.bridge.z };
    })()`)) as { t: number; x: number; z: number };
    await at(p, m.t, `${m.x}, 0, ${m.z}, 20`);
    return `${hm(m.t)}`;
  }, { shot: p, device: '电脑' });

  await r.step('出海口外：两道防波堤（堤头红绿航标灯）之间驶出，进了海湾加速、拖出尾迹，驶出场地边缘', async () => {
    const m = (await p.evaluate(`(() => {
      const sw = window.__sw; const o = sw.site.water.outlet; const st = { x: 0, z: 0, heading: 0 };
      const f = Math.min(12, Math.max(1, sw.clock.speed / 8));
      const leg = sw.boats.find((b) => b.boat === 'motor' && b.kind === 'out') ?? sw.boats.find((b) => b.kind === 'out');
      let best = 0, bd = Infinity;
      for (let tau = 0; tau < leg.path.duration; tau += 0.5) { leg.path.at(tau, st); const d = Math.hypot(st.x - o.x, st.z - (o.z0 - 14)); if (d < bd) { bd = d; best = tau; } }
      return { t: leg.start + best * f, x: o.x, z: o.z0 - 6 };
    })()`)) as { t: number; x: number; z: number };
    await at(p, m.t, `${m.x}, 0, ${m.z}, 32`);
    return `${hm(m.t)}`;
  }, { shot: p, device: '电脑' });

  await r.step('周边环境：编辑器里勾选「附近有学校」和「主路上有铁路道口」（会推迟顾客、司机和货车的到店时间，重新仿真）', async () => {
    await p.getByRole('button', { name: '编辑布局', exact: true }).click();
    await p.getByLabel('附近有学校（上学、放学时车多人多）').check();
    await p.getByLabel('主路上有铁路道口（火车经过时道口关闭）').check();
    await p.locator('h3', { hasText: '周边环境' }).scrollIntoViewIfNeeded();
    await p.waitForTimeout(600);
    await p.getByRole('button', { name: '完成编辑' }).first().click();
    await settle(p);
  }, { shot: p, device: '电脑' });

  await r.step('铁路道口：火车到来前 25 秒栏杆放下、红灯交替闪，主路上的车在停止线前排队；车尾过去 5 秒后抬起', async () => {
    await p.waitForTimeout(1000);
    const m = (await p.evaluate(`(() => {
      const sw = window.__sw; const r = sw.site.railway;
      const tr = sw.trains.find((x) => x.t0 > 8.2 * 3600);
      return { t: tr.t0 + 4, kind: tr.kind, x: r.x, z: (r.roadZ0 + r.roadZ1) / 2 };
    })()`)) as { t: number; kind: string; x: number; z: number };
    await look(p, m.t, [m.x - 39, 35, m.z - 31], [m.x, 0, m.z - 1]);
    return `${hm(m.t)}，${m.kind === 'freight' ? '长货车' : '通勤列车'}`;
  }, { shot: p, device: '电脑' });

  await r.step('学校：上学时段学生在路边攒几个人，护导员举着停车牌走到人行横道中间拦车，学生排着过马路，两边的车停下等', async () => {
    const m = (await p.evaluate('(() => { const s = window.__sw.site; return { x: s.school.crossX, top: s.roadTopZ, bottom: s.roadBottomZ }; })()')) as { x: number; top: number; bottom: number };
    // 7:39:13：护导员每 90 秒拦一次车、每次 25 秒，这一刻学生正在过马路（从门店这一侧走向学校）
    await look(p, 7 * 3600 + 39 * 60 + 13, [m.x + 8, 18, m.top + 14], [m.x, 0, m.bottom - 1]);
  }, { shot: p, device: '电脑' });

  await r.step('没有水面的环境：周边是有边界的沙盘，边缘露出土层剖面，不会无限延伸', async () => {
    await p.getByRole('button', { name: '编辑布局', exact: true }).click();
    await p.getByLabel('水系').selectOption('none');
    await p.getByLabel('附近有学校（上学、放学时车多人多）').uncheck();
    await p.getByLabel('主路上有铁路道口（火车经过时道口关闭）').uncheck();
    await p.getByRole('button', { name: '完成编辑' }).first().click();
    await settle(p);
    const g = (await p.evaluate('(() => window.__sw.site.ground)()')) as { x: number; z: number; w: number; d: number };
    await at(p, 10 * 3600, `${g.x}, 0, ${g.z}, ${Math.round(Math.max(g.w, g.d) / 2)}`);
    return `沙盘 ${Math.round(g.w)} × ${Math.round(g.d)} 米`;
  }, { shot: p, device: '电脑' });

  await r.step('改回湖与出海口', async () => {
    await p.getByRole('button', { name: '编辑布局', exact: true }).click();
    await p.getByLabel('水系').selectOption('lake');
    await p.getByRole('button', { name: '完成编辑' }).first().click();
    await settle(p);
  });

  await r.step('暂存区（线上订单交付区）：步入式冷藏库、冷冻库；连通通道通到收货区，后仓放不下的托盘经通道放到暂存区的溢流位', async () => {
    const a = (await app(p, "(s) => { const pick = (k) => s.simGeo.areas.find((x) => x.kind === k); return ['STAGING_COOLER', 'STAGING_FREEZER', 'PASSAGE', 'OVERFLOW'].map((k) => { const x = pick(k); return x ? { id: x.id, cx: (x.x0 + x.x1) / 2, cz: (x.z0 + x.z1) / 2 } : null; }); }")) as Array<{ id: string; cx: number; cz: number } | null>;
    const ok = a.filter((x): x is { id: string; cx: number; cz: number } => !!x);
    expect(ok.length).toBe(4);
    const cx = ok.reduce((m, x) => m + x.cx, 0) / ok.length;
    const cz = ok.reduce((m, x) => m + x.cz, 0) / ok.length;
    await p.getByRole('button', { name: '内部', exact: true }).click();
    await look(p, 15 * 3600, [cx + 22, 30, cz - 26], [cx, 0, cz]);
    return ok.map((x) => x.id).join('、');
  }, { shot: p, device: '电脑' });

  await r.step('两层的大型店：二楼铺满货架，后面是补货区和货梯口的卸货区，托盘从一楼收货区经货梯送上来；二楼只盖到货梯外侧，一楼其余部分是单层（截二楼后部）', async () => {
    await p.locator('select').filter({ has: p.locator('option[value="large"]') }).first().selectOption('large');
    await settle(p);
    await p.getByRole('group', { name: '楼层' }).getByRole('button').nth(1).click();
    await p.waitForTimeout(1000);
    const f = (await app(p, "(s) => { const f = s.simGeo.floors.find((x) => x.level === 1); return { maxX: f.maxX, maxZ: f.maxZ, y: f.y, id: f.floorId }; }")) as { maxX: number; maxZ: number; y: number; id: string };
    const ids = String(await app(p, `(s) => s.simGeo.areas.filter((a) => a.floorId === '${f.id}').map((a) => a.id).join('、')`));
    const aisles = Number(await app(p, `(s) => s.config.layout.runs.filter((r) => r.floorId === '${f.id}' && r.kind === 'AISLE').length`));
    const up = Number(await app(p, '(s) => s.timeline.inbound.pallets.filter((x) => x.upAt !== undefined).length'));
    await look(p, 10 * 3600, [f.maxX + 32, f.y + 34, f.maxZ + 25], [f.maxX - 6, f.y, f.maxZ - 12]);
    return `二楼 ${aisles} 条通道；二楼的区域：${ids}；今天经货梯送上二楼的托盘 ${up} 个`;
  }, { shot: p, device: '电脑' });

  await r.step('二楼的收银区：和一楼一样在正面墙与前走廊之间，从卖场右端排开，人工收银通道和自助收银，避开扶梯和电梯', async () => {
    const c = (await app(p, "(s) => { const f = s.simGeo.floors.find((x) => x.level === 1); const cs = s.simGeo.checkouts.filter((k) => k.floorId === f.floorId); return { n: cs.length, self: cs.filter((k) => k.self).length, x: cs.reduce((m, k) => m + k.x, 0) / Math.max(1, cs.length), y: f.y }; }")) as { n: number; self: number; x: number; y: number };
    expect(c.n).toBeGreaterThan(1);
    await look(p, 11 * 3600, [c.x + 12, c.y + 14, -14], [c.x - 2, c.y, 5]);
    return `二楼 ${c.n - c.self} 条人工收银通道、${c.self} 台自助收银`;
  }, { shot: p, device: '电脑' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
