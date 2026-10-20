import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRng, volumeLiters, type Order, type ToteAssignment } from '@storewright/domain';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateCatalog, generateOrders } from '@storewright/synth';
import { assignTotes, assignTotesByEye, hasCrushRisk, mixesChemicalWithFood } from './totes';
import { coldChainLimitSec, partitionTotes, planPickWalks, summarize } from './batching';
import { routeTsp } from './routing';
import { composeTrips } from './trips';
import type { PlanningContext } from './context';

const model = new StoreModel(createTemplate('small'));
const catalog = generateCatalog(model, { seed: 11 });
const ctx: PlanningContext = { model, items: catalog.byId };
const tote = model.config.equipment.tote;
const ordersFor = (seed: number): Order[] => generateOrders(model, catalog, DEFAULT_DEMAND.small, { seed });

function unitsByLine(orders: readonly Order[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of orders) for (const l of o.lines) m.set(l.lineId, l.qty);
  return m;
}

describe('分箱（工程约束 EC-1）', () => {
  it('不超重、不超容、一框一单、单一温区、化学品不与食品混装、无压坏风险、每件只装一次', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const orders = ordersFor(seed).slice(0, 25);
        const expected = unitsByLine(orders);
        const seen = new Map<string, number>();
        for (const o of orders) {
          const { totes, oversized } = assignTotes(ctx, o);
          for (const t of totes) {
            expect(t.orderId).toBe(o.id);
            expect(t.weightKg).toBeLessThanOrEqual(tote.maxWeightKg + 1e-9);
            const units = t.lines.reduce((n, l) => n + l.qty, 0);
            // 体积按两位小数存储，容差 0.01 升
            if (units > 1) expect(t.volumeL).toBeLessThanOrEqual(model.toteCapacityL * tote.fillFactor + 0.01);
            const zones = new Set(t.lines.map((l) => catalog.byId.get(l.itemId)?.tempZone));
            expect(zones.size).toBe(1);
            expect(zones.has(t.tempZone)).toBe(true);
            expect(mixesChemicalWithFood(ctx, t)).toBe(false);
            expect(hasCrushRisk(ctx, t)).toBe(false);
            expect(t.count).toBe(totes.length);
            for (const l of t.lines) seen.set(l.lineId, (seen.get(l.lineId) ?? 0) + l.qty);
          }
          for (const p of oversized) seen.set(p.lineId, (seen.get(p.lineId) ?? 0) + 1);
          expect(totes.map((t) => t.index)).toEqual(totes.map((_, i) => i + 1));
        }
        expect(seen).toEqual(expected);
      }),
      { numRuns: 20 },
    );
  });

  it('基线分箱会产生超重或压坏风险（用于对比）', () => {
    const orders = ordersFor(3);
    const totes = orders.flatMap((o) => assignTotesByEye(ctx, o).totes);
    const risky = totes.filter((t) => t.weightKg > tote.maxWeightKg || hasCrushRisk(ctx, t) || mixesChemicalWithFood(ctx, t));
    expect(risky.length).toBeGreaterThan(0);
    for (const t of totes) expect(t.volumeL).toBeLessThanOrEqual(model.toteCapacityL + Math.max(...t.lines.map((l) => volumeLiters(catalog.byId.get(l.itemId)?.dims ?? { l: 0, w: 0, h: 0 }))));
  });
});

describe('分批（工程约束 EC-2、EC-3、EC-5）', () => {
  const cap = model.config.equipment.cart.totesPerCart;
  const allTotes = (seed: number): ToteAssignment[] => ordersFor(seed).flatMap((o) => assignTotes(ctx, o).totes);

  it('每车不超过框数上限、单一温区、每个框恰好出现一次', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.constantFrom<'ORDER' | 'TOTE'>('ORDER', 'TOTE'), (seed, unit) => {
        const totes = allTotes(seed);
        const walks = planPickWalks(ctx, totes, { strategy: 'ZONE_PARTITION', routing: 'TSP', enforceColdLimit: true, unit });
        const count = new Map<string, number>();
        for (const w of walks) {
          expect(w.toteAssignmentIds.length).toBeLessThanOrEqual(cap);
          const zones = new Set(w.toteAssignmentIds.map((id) => totes.find((t) => t.id === id)?.tempZone));
          expect(zones.size).toBe(1);
          for (const id of w.toteAssignmentIds) count.set(id, (count.get(id) ?? 0) + 1);
          // 拣货顺序 = 路线顺序：每个站点都在清单里，且每条拣货指令属于本车的框
          for (const s of w.stops) for (const p of s.picks) expect(w.toteAssignmentIds).toContain(p.toteAssignmentId);
        }
        expect(count.size).toBe(totes.length);
        expect([...count.values()].every((c) => c === 1)).toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  it('划分结果与输入顺序无关', () => {
    const totes = allTotes(77);
    const opts = { strategy: 'ZONE_PARTITION' as const, routing: 'TSP' as const, enforceColdLimit: true };
    const a = partitionTotes(ctx, totes.map((t) => summarize(ctx, t)), opts).map((g) => g.map((t) => t.id).join(','));
    const shuffled = createRng(5).shuffle([...totes]);
    const b = partitionTotes(ctx, shuffled.map((t) => summarize(ctx, t)), opts).map((g) => g.map((t) => t.id).join(','));
    expect(b).toEqual(a);
  });

  it('按订单划分时，同一订单同温区的框在同一辆车上', () => {
    const totes = allTotes(19);
    const walks = planPickWalks(ctx, totes, { strategy: 'ZONE_PARTITION', routing: 'TSP', enforceColdLimit: true, unit: 'ORDER' });
    const walkOf = new Map<string, string>();
    for (const w of walks) for (const id of w.toteAssignmentIds) walkOf.set(id, w.id);
    const groups = new Map<string, Set<string>>();
    for (const t of totes) {
      const key = `${t.orderId}|${t.tempZone}`;
      const set = groups.get(key) ?? new Set<string>();
      set.add(walkOf.get(t.id) as string);
      groups.set(key, set);
      const sameGroup = totes.filter((x) => x.orderId === t.orderId && x.tempZone === t.tempZone).length;
      if (sameGroup <= cap) expect(groups.get(key)?.size).toBe(1);
    }
  });

  it('多个单位组成的冷链批次不超过冷链时限', () => {
    const totes = allTotes(23);
    const walks = planPickWalks(ctx, totes, { strategy: 'ZONE_PARTITION', routing: 'TSP', enforceColdLimit: true });
    for (const w of walks) {
      if (w.coldLimitSec === undefined) continue;
      const orders = new Set(w.toteAssignmentIds.map((id) => id.slice(0, id.lastIndexOf('-T'))));
      if (orders.size > 1) expect(w.estimatedSec).toBeLessThanOrEqual(w.coldLimitSec);
    }
  });

  it('冷链时限公式（决策 P-12）', () => {
    const rules = model.config.rules.coldChain;
    expect(coldChainLimitSec(0, rules)).toBe(rules.baseMin * 60);
    expect(coldChainLimitSec(10_000, rules)).toBe(rules.maxMin * 60);
  });
});

describe('路线', () => {
  it('2-opt 改进后的路线不比最近邻构造更长', () => {
    const locs = [...model.locations.values()];
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: locs.length - 1 }), { minLength: 2, maxLength: 40 }), (idx) => {
        const nodes = idx.map((i) => (locs[i] as (typeof locs)[number]).nodeId);
        const nn = routeTsp(model, nodes, model.cartDepotNode, model.stagingNode, 0);
        const opt = routeTsp(model, nodes, model.cartDepotNode, model.stagingNode);
        expect(opt.distanceM).toBeLessThanOrEqual(nn.distanceM + 1e-6);
        expect(new Set(opt.order)).toEqual(new Set(nodes));
      }),
      { numRuns: 30 },
    );
  });
});

describe('配送行程（决策 D-01、D-07）', () => {
  it('每趟不超过上限、不超车辆容量、车内位置不重复、每单恰好一次', () => {
    const orders = ordersFor(5).filter((o) => o.type === 'DELIVERY');
    const candidates = orders.map((o) => ({ order: o, totes: 1 + (o.lines.length % 4), weightKg: 10 }));
    const trips = composeTrips(candidates, { maxOrders: 4, vehicleTotes: 8, vehicleMaxKg: 100 });
    const seen = new Set<string>();
    for (const t of trips) {
      expect(t.orderIds.length).toBeLessThanOrEqual(4);
      if (t.orderIds.length > 1) expect(t.totes).toBeLessThanOrEqual(8);
      expect(new Set(Object.values(t.placements)).size).toBe(t.orderIds.length);
      for (const id of t.orderIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(orders.length);
  });
});
