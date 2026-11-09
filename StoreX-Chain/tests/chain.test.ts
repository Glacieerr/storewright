import { beforeAll, describe, expect, it } from 'vitest';
import { runChain, type ChainResult } from '../src/sim/engine';
import { g1, g2, g3 } from '../src/sim/config';
import { buildGraph, dcMainRoad, Routes, shortestPath, STORE, STORES, TOTAL_SIZE } from '../src/region/network';
import { FAMILIES } from '../src/region/products';
import { RAIL } from '../src/region/region';
import { planRoutes } from '../src/sim/routing';

describe('区域和网络', () => {
  const g = buildGraph();
  it('配送中心、港口、机场、面包房、出口和每家店之间都通', () => {
    for (const a of ['DC', 'PORT', 'AIR', 'BAKERY', 'NORTH', 'EAST']) for (const s of STORES) expect(shortestPath(g, a, s.key).km, `${a}→${s.key}`).toBeGreaterThan(0);
  });
  it('区域里只有一家综合店（规模 2.5，4 个收货口）', () => {
    expect(STORES).toHaveLength(1);
    expect(STORE.flagship).toBe(true);
    expect(STORE.size).toBe(2.5);
    expect(STORE.docks).toBe(4);
    expect(TOTAL_SIZE).toBe(2.5);
  });
  it('海运、铁路班列、空运的货都进配送中心；只有长途公路的货能直送门店', () => {
    for (const make of [g1, g2, g3])
      for (const key of make(1).flow.direct) expect(FAMILIES.find((f) => f.key === key)?.source, key).toBe('domestic');
    expect(FAMILIES.some((f) => f.source === 'rail')).toBe(true);
    expect(FAMILIES.some((f) => f.supplier?.border)).toBe(true);
  });
  it('门店不压在高速、快速路、干道和铁路上（三维场景里店房和停车场不和道路重叠）', () => {
    const seg = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
    };
    for (const s of STORES) {
      // 店房 + 停车场的半对角线（公里，沙盘上 1 公里 = 100 米），再留 150 米
      const half = s.flagship ? 0.55 : Math.hypot(60 * Math.sqrt(s.size) + 50, 46 * Math.sqrt(s.size) + 58) / 200;
      for (const e of g.edges) {
        if (e.cls === 'local') continue;
        for (let i = 1; i < e.pts.length; i++) expect(seg(s.km, e.pts[i - 1] as { x: number; y: number }, e.pts[i] as { x: number; y: number }), `${s.key} 和 ${e.a}–${e.b}`).toBeGreaterThan(half + 0.15);
      }
      for (let i = 1; i < RAIL.length; i++) expect(seg(s.km, RAIL[i - 1] as { x: number; y: number }, RAIL[i] as { x: number; y: number }), `${s.key} 和铁路`).toBeGreaterThan(half + 0.15);
    }
  });
  it('商品族的需求占比加起来是 1', () => {
    expect(FAMILIES.reduce((a, f) => a + f.share, 0)).toBeCloseTo(1, 6);
  });
  it('道路封闭后改走别的路，更远', () => {
    const open = new Routes(buildGraph());
    const closed = new Routes(buildGraph(new Set([dcMainRoad()])));
    expect(closed.get('DC', 'S01').km).toBeGreaterThan(open.get('DC', 'S01').km);
  });
});

describe('配送线路（节约法）', () => {
  const dist = (a: string, b: string) => (a === b ? 0 : Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) + 10);
  it('不超过车的容量和停靠点数，每家店都送到', () => {
    const jobs = ['A', 'B', 'C', 'D', 'E', 'F'].map((s, i) => ({ store: s, pallets: 5 + i * 3 }));
    const routes = planRoutes(jobs, 24, 3, dist, 'Z');
    for (const r of routes) {
      expect(r.pallets).toBeLessThanOrEqual(24);
      expect(r.stops.length).toBeLessThanOrEqual(3);
    }
    const total = routes.reduce((a, r) => a + r.pallets, 0);
    expect(total).toBe(jobs.reduce((a, j) => a + j.pallets, 0));
  });
  it('超过一车的店先派整车', () => {
    const routes = planRoutes([{ store: 'A', pallets: 60 }], 24, 3, dist, 'Z');
    expect(routes.map((r) => r.pallets).sort((a, b) => b - a)).toEqual([24, 24, 12]);
  });
});

describe('三代全链路（同一个种子）', () => {
  let a: ChainResult;
  let b: ChainResult;
  let c: ChainResult;
  beforeAll(() => {
    a = runChain(g1(2));
    b = runChain(g2(2));
    c = runChain(g3(2));
  });

  it('三代面对完全一样的需求（公共随机数）', () => {
    expect(b.store.demandUnits).toBe(a.store.demandUnits);
    expect(c.store.demandUnits).toBe(a.store.demandUnits);
  });

  it('件数守恒：卖出 + 缺货 = 需求', () => {
    for (const r of [a, b, c]) expect(r.store.soldUnits + r.store.lostUnits).toBeCloseTo(r.store.demandUnits, 3);
  });

  it('结果在合理范围：服务水平 98–100%，配送中心满足率 ≥ 97%，生鲜损耗 1–8%', () => {
    for (const r of [a, b, c]) {
      expect(r.store.service).toBeGreaterThan(98);
      expect(r.dc.fillPct).toBeGreaterThan(97);
      expect(r.store.wastePct).toBeGreaterThan(1);
      expect(r.store.wastePct).toBeLessThan(8);
      // 一家店：每周约 6 个海运箱、3 个班列箱
      expect(r.inbound.containers).toBeGreaterThan(0.5);
      expect(r.inbound.trainBoxes).toBeGreaterThan(0.2);
      expect(r.leadTime.railDays).toBeLessThan(r.leadTime.seaDays);
    }
  });

  it('全链路：库存、配送中心工时、到店车次、成本都更少，生鲜更新鲜', () => {
    expect(c.dc.invDays).toBeLessThan(b.dc.invDays * 0.7);
    expect(c.store.invDays).toBeLessThan(b.store.invDays);
    expect(c.dc.laborHours).toBeLessThan(b.dc.laborHours * 0.7);
    // 面包房直送并进多温区车：到店的车次少两成以上
    expect(c.store.arrivals).toBeLessThan(b.store.arrivals * 0.8);
    expect(c.store.freshRemainPct).toBeGreaterThan(b.store.freshRemainPct + 4);
    expect(c.cost.total).toBeLessThan(b.cost.total);
    expect(b.cost.total).toBeLessThan(a.cost.total);
    expect(c.inbound.portDwellDays).toBeLessThan(a.inbound.portDwellDays / 2);
    expect(c.outbound.vanTrips).toBe(0);
    expect(a.outbound.vanTrips).toBeGreaterThan(1.5);
    // 长途整车：上一代全部进配送中心，全链路一部分按规划直送门店
    expect(a.inbound.directLoads).toBe(0);
    expect(c.inbound.directLoads).toBeGreaterThan(1);
  });

  it('打开动画不改变结果；动画里有卡车、船、飞机和铁路', () => {
    const s = g3(2);
    // 动画放在洲际班列到站的那天（每周一列），保证有火车
    s.traceDay = [85, 86, 87, 88, 89, 90, 91].find((d) => d % 7 === s.rail.arriveDay) as number;
    const r = runChain(s);
    expect(r.cost.total).toBe(c.cost.total);
    expect(r.store.service).toBe(c.store.service);
    const kinds = new Set(r.trace?.vehicles.map((v) => v.kind));
    for (const k of ['truck', 'reefer', 'ev', 'van', 'plane', 'train']) expect(kinds.has(k), k).toBe(true);
    for (const v of r.trace?.vehicles ?? []) for (const seg of v.segs) expect(seg.t1).toBeGreaterThan(seg.t0);
    // 门店这一天 0 点的库存和需求都记下来了（闭环孪生的现场从这里开始）；每一站卸的货也记了
    expect(Object.keys(r.trace?.storeStock ?? {})).toHaveLength(FAMILIES.length);
    for (const o of (r.trace?.ops ?? []).filter((x) => x.kind === 'delivery' || x.kind === 'direct')) expect(Object.values(o.stops?.[0]?.load ?? {}).reduce((p, q) => p + q, 0), o.id).toBeGreaterThan(0);
  });
  it('班列每周一列，到站日按时刻表；动画那天如果有班列，它从东面开进物流园货运站', () => {
    const s = g3(2);
    s.traceDay = 7 * 12 + s.rail.arriveDay;
    const r = runChain(s);
    const train = r.trace?.ops.find((o) => o.kind === 'train');
    expect(train).toBeDefined();
    expect(train?.from).toBe('RAIL_EAST');
  });
});

describe('压力演练', () => {
  it('港口拥堵：全链路按推算的缺口过桥采购、优先放行自己的箱，比不这么做缺货少（上一代配送中心库存厚，不需要）', () => {
    const extra = (make: typeof g1, seed: number, days: number, bridge = true) => {
      const base = runChain(make(seed));
      const s = make(seed);
      s.disruption = { key: 'portCongestion', start: 80, days };
      if (!bridge) s.twin = { ...s.twin, bridgeBuy: false };
      const r = runChain(s);
      const lost = (x: typeof r) => x.daily.lost.slice(80, 80 + days + 14).reduce((p, q) => p + q, 0);
      return { lost: lost(r) - lost(base), cost: r.responseCost };
    };
    expect(extra(g1, 4, 10).cost).toBe(0);
    const nw = extra(g3, 4, 10);
    const no = extra(g3, 4, 10, false);
    expect(nw.cost).toBeGreaterThan(0);
    expect(nw.lost).toBeLessThan(no.lost);
    // 三周的长拥堵：全链路配送中心库存压得低，会缺货；预案把缺货压下去一大半
    const withBridge = extra(g3, 3, 21);
    const without = extra(g3, 3, 21, false);
    expect(without.lost).toBeGreaterThan(withBridge.lost * 2);
  });
});
