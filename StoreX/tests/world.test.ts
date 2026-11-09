import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/ops/day';
import { CATEGORY } from '../src/world/catalog';
import { gen1, storex } from '../src/world/config';
import { buildLayout, CATEGORIES, type Generation, type Pt } from '../src/world/layout';
import { Router, routeOrder } from '../src/world/path';

const GENS: Generation[] = ['gen1', 'storex'];

describe.each(GENS)('门店布局（%s）', (g) => {
  const layout = buildLayout(g);
  const router = new Router(layout);
  const from = layout.poi.entrance;

  it('每个陈列面都能从入口走到', () => {
    for (const c of CATEGORIES) {
      expect(layout.faces[c].length, c).toBeGreaterThan(0);
      for (const f of layout.faces[c]) expect(router.reachable(from, f), `${c} ${f.x},${f.y}`).toBe(true);
    }
  });

  it('室内的作业点都能走到', () => {
    const p = layout.poi;
    const inside: Pt[] = [
      p.service,
      p.freshPrep,
      ...p.staffedLanes,
      ...p.selfCheckouts,
      ...p.gates,
      ...p.backroomStock,
      ...p.backroomDoors,
      ...p.docks.map((d) => d.inside),
      ...p.chargers,
      ...p.mfcPorts,
      ...p.lockerLoad,
      ...[p.staging, p.pickupDoor, p.decant, p.consolidation, p.freshDrop, p.driveHatch].filter((x): x is Pt => !!x),
    ];
    for (const q of inside) expect(router.reachable(from, q), `${q.x},${q.y}`).toBe(true);
  });

  it('室外的车位能从门口走到（走室外）', () => {
    const p = layout.poi;
    const start = g === 'gen1' ? (p.pickupDoor as Pt) : (p.driveHatch as Pt);
    // 出口在南墙门外：顾客结完账从这里走到停车场
    for (const q of [p.exit, ...p.parking, ...p.curbsideBays, ...p.driveBays, ...p.lockerAccess]) expect(router.reachable(start, q, true), `${q.x},${q.y}`).toBe(true);
  });

  it('两代各自的设施', () => {
    if (g === 'gen1') {
      expect(layout.poi.staging).toBeDefined();
      expect(layout.poi.curbsideBays.length).toBeGreaterThan(0);
      expect(layout.poi.mfcPorts).toHaveLength(0);
    } else {
      expect(layout.poi.mfcPorts.length).toBeGreaterThanOrEqual(3);
      expect(layout.poi.lockerLoad.length).toBeGreaterThan(0);
      expect(layout.poi.driveBays.length).toBeGreaterThan(0);
      expect(layout.poi.mfc).toBeDefined();
    }
  });

  it('拣货路线：经过所有点，不比按原顺序走更远', () => {
    const stops = layout.faces.ambient.filter((_, i) => i % 23 === 0).slice(0, 12);
    const r = routeOrder(router, from, stops, from);
    expect([...r.order].sort((a, b) => a - b)).toEqual(stops.map((_, i) => i));
    let naive = 0;
    let cur = from;
    for (const s of stops) {
      naive += router.distance(cur, s);
      cur = s;
    }
    naive += router.distance(cur, from);
    expect(r.meters).toBeLessThanOrEqual(naive + 1e-9);
  });
});

describe('商品和需求', () => {
  const a = buildWorld(gen1(11));
  const b = buildWorld(storex(11));

  it('两代流程在同一个种子下面对完全相同的需求（公共随机数）', () => {
    expect(a.orders.length).toBe(b.orders.length);
    expect(a.shoppers.length).toBe(b.shoppers.length);
    a.orders.forEach((o, i) => {
      const p = b.orders[i]!;
      expect([o.slot, o.items, o.arrival, o.delivery, o.ageRestricted]).toEqual([p.slot, p.items, p.arrival, p.delivery, p.ageRestricted]);
      expect(o.lines.map((l) => l.sku.id)).toEqual(p.lines.map((l) => l.sku.id));
    });
    a.shoppers.forEach((s, i) => expect(s.items.map((k) => k.id)).toEqual(b.shoppers[i]!.items.map((k) => k.id)));
    a.catalog.skus.forEach((s, i) => expect([s.price, s.bulky, s.ageRestricted]).toEqual([b.catalog.skus[i]!.price, b.catalog.skus[i]!.bulky, b.catalog.skus[i]!.ageRestricted]));
  });

  it('需求规模和上一代的实测一致（266 单，约 28 件 / 单）', () => {
    expect(a.orders).toHaveLength(266);
    const items = a.orders.reduce((s, o) => s + o.items, 0) / a.orders.length;
    expect(items).toBeGreaterThan(24);
    expect(items).toBeLessThan(33);
    expect(a.shoppers.length).toBeGreaterThan(1650);
    expect(a.shoppers.length).toBeLessThan(1950);
  });

  it('立体货格仓只放包装商品：不放生鲜、冷冻、大件，不超过容量', () => {
    const inMfc = b.catalog.skus.filter((s) => s.inMfc);
    expect(inMfc.length).toBeLessThanOrEqual(storex().catalog.mfcSkuCapacity);
    expect(inMfc.length).toBeGreaterThan(1000);
    for (const s of inMfc) {
      expect(CATEGORY[s.category].mfc).toBe(true);
      expect(s.bulky).toBe(false);
    }
  });

  it('配送单的时段不早于第一班车，自提单都有到店时刻', () => {
    for (const o of a.orders) {
      if (o.delivery) expect(o.slot).toBeGreaterThanOrEqual(10 * 3600);
      else {
        expect(o.arrival).toBeGreaterThan(0);
        expect(o.notice).toBeLessThanOrEqual(o.arrival);
      }
    }
  });
});
