import { describe, expect, it } from 'vitest';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { buildGeometry } from './layout';
import { buildLot, carSpotIndex, entryPath, exitPaths, SPOT_D, SPOT_W } from './lot';
import { generateSite, signalLight, type Rect, type RoadStyle } from './site';
import { TrafficSim } from './traffic';
import { PedestrianSim } from './pedestrians';
import { corralCounts, planCarts } from './carts';

const geo = buildGeometry(new StoreModel(createTemplate('medium')));
const f0 = geo.floors[0] as (typeof geo.floors)[number];
const store = { minX: f0.minX, maxX: f0.maxX, minZ: f0.minZ, maxZ: f0.maxZ };
const STYLES: RoadStyle[] = ['suburban', 'urban', 'arterial'];

const overlap = (a: Rect, b: Rect, eps = 0.01) => Math.abs(a.x - b.x) * 2 < a.w + b.w - eps && Math.abs(a.z - b.z) * 2 < a.d + b.d - eps;

describe('停车场', () => {
  const lot = geo.lot;

  it('车位互不重叠，都在停车场范围内，且在门店正面之外', () => {
    const rects = lot.spots.map((s) => ({ x: s.x, z: s.z, w: SPOT_W, d: SPOT_D }));
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i] as Rect;
      expect(r.x - r.w / 2).toBeGreaterThanOrEqual(lot.minX);
      expect(r.x + r.w / 2).toBeLessThanOrEqual(lot.maxX);
      expect(r.z + r.d / 2).toBeLessThanOrEqual(lot.frontZ);
      expect(r.z - r.d / 2).toBeGreaterThanOrEqual(lot.edgeZ);
      for (let j = i + 1; j < rects.length; j++) expect(overlap(r, rects[j] as Rect)).toBe(false);
    }
  });

  it('取货专用车位离交付门口最近，并按距离编号', () => {
    expect(lot.pickupCount).toBeGreaterThanOrEqual(8);
    expect(lot.pickupCount).toBeLessThanOrEqual(16);
    const pickup = lot.spots.slice(0, lot.pickupCount);
    expect(pickup.every((s) => s.kind === 'pickup')).toBe(true);
    const d = pickup.map((s) => Math.abs(s.x - geo.door.x));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual((d[i - 1] as number) - 1e-9);
  });

  it('溢出的取货车辆循环使用离门口最近的预留车位', () => {
    expect(carSpotIndex(lot, 0)).toBe(0);
    expect(carSpotIndex(lot, lot.pickupCount + 3)).toBe(lot.pickupCount + 3);
    expect(carSpotIndex(lot, 500)).toBeLessThan(lot.pickupCount + 8);
  });

  it('更宽的门店有更多排车位', () => {
    const narrow = buildLot({ storeMinX: 0, storeMaxX: 30, doorX: 25 });
    const wide = buildLot({ storeMinX: 0, storeMaxX: 110, doorX: 100 });
    expect(wide.spots.length).toBeGreaterThan(narrow.spots.length);
    expect(wide.aisles.length).toBeGreaterThan(narrow.aisles.length);
  });
});

describe('周边环境', () => {
  it('同一种子得到完全相同的道路和建筑（可复现），不同种子不同', () => {
    for (const style of STYLES) {
      const a = generateSite({ lot: geo.lot, store, settings: { style, seed: 7, traffic: 1 } });
      const b = generateSite({ lot: geo.lot, store, settings: { style, seed: 7, traffic: 1 } });
      const c = generateSite({ lot: geo.lot, store, settings: { style, seed: 8, traffic: 1 } });
      expect(b).toEqual(a);
      expect(JSON.stringify(c.buildings)).not.toBe(JSON.stringify(a.buildings));
    }
  });

  it('建筑不压在道路、停车场、门店上，彼此也不重叠', () => {
    const lotRect: Rect = { x: (geo.lot.minX + geo.lot.maxX) / 2, z: (geo.lot.edgeZ + 0) / 2, w: geo.lot.maxX - geo.lot.minX, d: -geo.lot.edgeZ };
    const storeRect: Rect = { x: (store.minX + store.maxX) / 2, z: (store.minZ + store.maxZ) / 2, w: store.maxX - store.minX, d: store.maxZ - store.minZ };
    for (const style of STYLES) {
      for (const seed of [1, 2, 3]) {
        const site = generateSite({ lot: geo.lot, store, settings: { style, seed, traffic: 1 } });
        expect(site.buildings.length).toBeGreaterThan(3);
        for (const [i, b] of site.buildings.entries()) {
          expect(overlap(b, lotRect)).toBe(false);
          expect(overlap(b, storeRect)).toBe(false);
          for (const road of site.asphalt.slice(0, 1)) expect(overlap(b, road)).toBe(false);
          for (const other of site.buildings.slice(i + 1)) expect(overlap(b, other)).toBe(false);
        }
      }
    }
  });

  it('信号灯从不同时给主路和支路放行', () => {
    const site = generateSite({ lot: geo.lot, store, settings: { style: 'urban', seed: 3, traffic: 1 } });
    expect(site.signals.length).toBeGreaterThan(0);
    for (const s of site.signals) {
      let mainGreen = 0;
      let sideGreen = 0;
      for (let t = 0; t < s.cycle * 3; t += 0.25) {
        const m = signalLight(s, t, 0);
        const d = signalLight(s, t, 1);
        expect(m !== 'R' && d !== 'R').toBe(false);
        if (m === 'G') mainGreen++;
        if (d === 'G') sideGreen++;
      }
      expect(mainGreen).toBeGreaterThan(sideGreen);
    }
  });

  it('车辆驶入路径从道路出发、终点在车位；驶离路径从车位出发、回到道路', () => {
    const site = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 1, traffic: 1 } });
    const pos = { x: 0, z: 0, heading: 0 };
    for (const idx of [0, 5, geo.lot.spots.length - 1]) {
      const spot = geo.lot.spots[idx] as (typeof geo.lot.spots)[number];
      for (const side of [true, false]) {
        const p = entryPath(geo.lot, site.road, spot, side);
        p.at(0, pos);
        expect(pos.z).toBeLessThan(geo.lot.edgeZ);
        p.at(p.duration, pos);
        expect(Math.hypot(pos.x - spot.x, pos.z - spot.z)).toBeLessThan(0.01);
        const [back, drive] = exitPaths(geo.lot, site.road, spot, side);
        back.at(0, pos);
        expect(Math.hypot(pos.x - spot.x, pos.z - spot.z)).toBeLessThan(0.01);
        // 倒车时车头仍朝向车位方向
        expect(Math.abs(Math.cos(pos.heading - spot.heading) - 1)).toBeLessThan(0.01);
        drive.at(drive.duration, pos);
        expect(pos.z).toBeLessThan(geo.lot.edgeZ);
      }
    }
  });
});

describe('背景车流', () => {
  const site = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 2, traffic: 2 } });

  it('同一车道上的车辆不重叠，红灯时不越过停止线', () => {
    const sim = new TrafficSim(site, 5);
    sim.warmUp(60, 1.5);
    for (let k = 0; k < 2400; k++) {
      const before = sim.lanes.map((list) => list.map((c) => ({ id: c.id, front: c.d + c.len / 2 })));
      const t0 = sim.time;
      sim.step(0.1, 1.5);
      sim.lanes.forEach((list, li) => {
        for (let i = 1; i < list.length; i++) {
          const lead = list[i - 1] as (typeof list)[number];
          const car = list[i] as (typeof list)[number];
          expect(lead.d - lead.len / 2 - (car.d + car.len / 2)).toBeGreaterThan(-0.05);
        }
        const lane = site.lanes[li] as (typeof site.lanes)[number];
        for (const st of lane.stops) {
          const signal = site.signals[st.signal];
          if (!signal) continue;
          // 整个步长内都是红灯
          if (signalLight(signal, t0, st.group) !== 'R' || signalLight(signal, sim.time, st.group) !== 'R') continue;
          for (const car of list) {
            const prev = before[li]?.find((b) => b.id === car.id);
            if (!prev || prev.front > st.d - 0.6) continue;
            // 在这个路口左转的车看左转箭头（或许可式左转），不受直行红灯约束
            const turn = car.turn !== undefined ? site.turns[car.turn] : undefined;
            if (turn && turn.kind === 'left' && turn.signal === st.signal) continue;
            expect(car.d + car.len / 2).toBeLessThanOrEqual(st.d + 0.05);
          }
        }
      });
    }
  });

  it('拥堵越严重，路上的车越多、排队越长、平均车速越低（10 分钟内每 2 秒取样的平均）', () => {
    const run = (c: number) => {
      const sim = new TrafficSim(site, 9);
      sim.warmUp(300, c);
      let cars = 0;
      let queued = 0;
      let speed = 0;
      for (let k = 0; k < 300; k++) {
        for (let j = 0; j < 8; j++) sim.step(0.25, c);
        const st = sim.stats();
        cars += st.cars;
        queued += st.queued;
        speed += st.avgSpeed * st.cars;
      }
      return { cars, queued, avgSpeed: speed / Math.max(1, cars) };
    };
    const a = run(0.2);
    const b = run(2);
    expect(b.cars).toBeGreaterThan(a.cars);
    expect(b.queued).toBeGreaterThan(a.queued);
    expect(b.avgSpeed).toBeLessThan(a.avgSpeed);
  });

  it('多车道路上会变道；要左转的车在路口前并到最内侧车道，按箭头或对向无车时转弯', () => {
    const urban = generateSite({ lot: geo.lot, store, settings: { style: 'urban', seed: 3, traffic: 1.5 } });
    const sim = new TrafficSim(urban, 4);
    let lefts = 0;
    let wrongLane = 0;
    for (let k = 0; k < 6000; k++) {
      sim.step(0.1, 1.2);
      for (const tc of sim.turning) {
        const turn = urban.turns[tc.turn];
        if (turn?.kind === 'left' && tc.s < 0.6) lefts++;
      }
      sim.lanes.forEach((list, li) => {
        for (const car of list) {
          const turn = car.turn !== undefined ? urban.turns[car.turn] : undefined;
          // 已经过了转弯点还在别的车道上
          if (turn && turn.from !== li && car.d > turn.atD + 1) wrongLane++;
        }
      });
    }
    expect(sim.laneChanges).toBeGreaterThan(5);
    expect(lefts).toBeGreaterThan(0);
    expect(wrongLane).toBe(0);
    expect(urban.signals.every((s) => s.leftGreen > 0)).toBe(true);
  });
});

describe('路口转弯、地块类型与施工', () => {
  it('右转弧线的起点在来源车道的转弯点上，终点在目标车道的并入点上', () => {
    for (const style of STYLES) {
      const site = generateSite({ lot: geo.lot, store, settings: { style, seed: 4, traffic: 1, layout: 'standard' } });
      expect(site.turns.length).toBeGreaterThan(0);
      for (const t of site.turns) {
        const at = (li: number, d: number) => {
          const l = site.lanes[li] as (typeof site.lanes)[number];
          return { x: l.pts[0].x + l.dir.x * d, z: l.pts[0].z + l.dir.z * d };
        };
        const a = at(t.from, t.atD);
        const b = at(t.to, t.toD);
        expect(Math.hypot(a.x - (t.pts[0]?.x ?? 0), a.z - (t.pts[0]?.z ?? 0))).toBeLessThan(0.01);
        const last = t.pts[t.pts.length - 1] as { x: number; z: number };
        expect(Math.hypot(b.x - last.x, b.z - last.z)).toBeLessThan(0.01);
      }
    }
  });

  it('街角地块在门店左侧有一条支路；商业街地块在左侧连着小店', () => {
    const corner = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 3, traffic: 1, layout: 'corner' } });
    expect(corner.layout).toBe('corner');
    expect(corner.signals.some((s) => s.x < geo.lot.minX && s.x > geo.lot.minX - 25)).toBe(true);
    const strip = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 3, traffic: 1, layout: 'strip' } });
    expect(strip.buildings.filter((b) => b.x < geo.lot.minX && b.x > geo.lot.minX - 80 && Math.abs(b.z - 10) < 0.01).length).toBeGreaterThanOrEqual(3);
  });

  it('施工路段限速：背景车流经过时明显变慢；部分车辆会右转进入支路', () => {
    const site = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 6, traffic: 1, layout: 'standard', roadWorks: true } });
    expect(site.works).toBeDefined();
    const sim = new TrafficSim(site, 4);
    let turned = 0;
    let inZone = 0;
    let zoneSpeed = 0;
    for (let k = 0; k < 4000; k++) {
      sim.step(0.1, 1);
      turned = Math.max(turned, sim.turning.length);
      sim.lanes.forEach((list, li) => {
        const zones = site.lanes[li]?.zones ?? [];
        for (const c of list) {
          if (zones.some((z) => c.d > z.d0 + 10 && c.d < z.d1 - 10)) {
            inZone++;
            zoneSpeed += c.v;
          }
        }
      });
    }
    expect(turned).toBeGreaterThan(0);
    expect(inZone).toBeGreaterThan(0);
    expect(zoneSpeed / inZone).toBeLessThan(5);
  });
});

describe('路边行人与购物车回收', () => {
  it('行人只在行人绿灯时走上人行横道；有人的横道把穿过它的车道登记为障碍', () => {
    const site = generateSite({ lot: geo.lot, store, settings: { style: 'urban', seed: 5, traffic: 1 } });
    const peds = new PedestrianSim(site, 2);
    expect(peds.crosswalks.length).toBe(site.intersections.length * 4);
    expect(peds.crosswalks.every((c) => c.lanes.length > 0)).toBe(true);
    let t = 0;
    let crossings = 0;
    const onCross = new Map<number, boolean>();
    for (let k = 0; k < 4000; k++) {
      t += 0.25;
      peds.step(0.25, t, 1);
      for (const w of peds.walkers) {
        const a = w.path[w.leg] as number;
        const b = w.path[w.leg + 1] as number;
        const e = peds.edges.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
        const was = onCross.get(w.id) ?? false;
        const now = !!e?.cross && w.s > 0;
        // 刚走上横道的这一步，信号必须是绿灯
        if (now && !was && e?.cross) {
          crossings++;
          const sig = site.signals[e.cross.signal];
          if (sig) expect(['G', 'Y']).toContain(signalLight(sig, t, e.cross.group));
        }
        onCross.set(w.id, now);
      }
      if (peds.occupied.size) expect(peds.obstacles().length).toBeGreaterThan(0);
    }
    expect(crossings).toBeGreaterThan(0);
  });

  it('回收栏里的购物车数量不为负；回收员的轨迹按时间排列，收车发生在顾客放车之后', () => {
    const lot = buildLot({ storeMinX: 0, storeMaxX: 90, doorX: 40, doubleRows: 3 });
    expect(lot.corrals.length).toBeGreaterThan(0);
    // 回收栏占用的位置上没有车位
    for (const c of lot.corrals) expect(lot.spots.some((s) => Math.abs(s.x - c.x) < 0.1 && Math.abs(s.z - c.z) < SPOT_D)).toBe(false);
    const stays = lot.spots.map((_, i) => (i % 3 === 0 ? [{ spot: i, arrive: 9 * 3600 + i * 40, leave: 9 * 3600 + i * 40 + 1800, type: 'sedan' as const, color: '#fff', fromLeft: true, toLeft: false, staff: false }] : []));
    const plan = planCarts(lot, stays, { x: 40, z: 0 }, 7 * 3600, 22 * 3600);
    expect(plan.deposits.length).toBeGreaterThan(5);
    expect(plan.pickups.length).toBeGreaterThan(0);
    for (let i = 1; i < plan.segments.length; i++) expect((plan.segments[i] as (typeof plan.segments)[number]).t0).toBeGreaterThanOrEqual((plan.segments[i - 1] as (typeof plan.segments)[number]).t1 - 1e-6);
    for (let t = 8 * 3600; t < 23 * 3600; t += 600) for (const n of corralCounts(plan, t)) expect(n).toBeGreaterThanOrEqual(0);
    const firstDeposit = plan.deposits[0]?.t ?? 0;
    expect(plan.pickups.every((p) => p.t >= firstDeposit)).toBe(true);
  });
});
