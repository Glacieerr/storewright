import { describe, expect, it } from 'vitest';
import { backroomLayout, createTemplate, floorSpotFor, StoreModel } from '@storewright/store-config';
import { generateCatalog, generateOrders } from '@storewright/synth';
import { EventQueue } from './kernel';
import { simulateDay } from './day';
import { BASELINE, OPTIMIZED, ablationPolicies, defaultScenario, scaledStaffing, shiftStaffing, storeSizing } from './scenario';
import { percentile, summarize } from './stats';
import { DEFAULT_TRAFFIC, congestionAt, trafficDelaySec } from './traffic';
import { simulateAutoService } from './autoService';
import { DEFAULT_INBOUND, estimateRestockCases, simulateInbound } from './inbound';
import { DEFAULT_COSTS, dayPnL, distribution, WEEKDAY_FACTORS } from './economics';
import { simulatePharmacy } from './pharmacy';
import { DEFAULT_SMALL_INCIDENTS, pauseOverlap, randomDisruptions, type Disruption } from './incidents';
import type { AutoServiceConfig } from '@storewright/store-config';
import { buildPlanogram } from '@storewright/algorithms';
import { ShelfStock } from './shelfStock';

const model = new StoreModel(createTemplate('small'));
const catalog = generateCatalog(model, { seed: 7 });
const scenario = defaultScenario('small');
const orders = generateOrders(model, catalog, scenario.demand, { seed: 99 });

describe('事件队列', () => {
  it('按时间排序，同一时刻按加入顺序', () => {
    const q = new EventQueue();
    const out: string[] = [];
    q.push(5, () => out.push('c'));
    q.push(1, () => out.push('a'));
    q.push(5, () => out.push('d'));
    q.push(3, () => out.push('b'));
    for (let e = q.pop(); e; e = q.pop()) e.action();
    expect(out).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('一天的仿真', () => {
  it('同一输入和种子得到完全相同的结果（可复现）', () => {
    const a = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3 });
    const b = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3 });
    expect(b.metrics).toEqual(a.metrics);
  });

  it('家居建材店（第二个行业）：同一个引擎跑完一天，油漆和五金可以同框，默认档位没有超重框', () => {
    const hw = new StoreModel(createTemplate('hardware'));
    const cat = generateCatalog(hw, { seed: 7 });
    expect(cat.items.every((i) => i.nonFood === true)).toBe(true);
    const sc = defaultScenario('hardware');
    const os = generateOrders(hw, cat, sc.demand, { seed: 3 });
    for (const policy of [BASELINE, OPTIMIZED]) {
      const r = simulateDay({ model: hw, items: cat.byId, orders: os, scenario: sc, policy, seed: 3 });
      expect(r.metrics.unfinishedOrders).toBe(0);
      expect(r.metrics.chemicalMixTotePct).toBe(0);
      expect(r.metrics.coldWalks).toBe(0);
      expect(r.metrics.oversizedPieces).toBeGreaterThan(50);
      if (policy === OPTIMIZED) expect(r.metrics.overweightTotePct).toBe(0);
    }
  });

  it('所有订单都完成交付，事件时间单调不减', () => {
    for (const policy of [BASELINE, OPTIMIZED, ...ablationPolicies()]) {
      const r = simulateDay({ model, items: catalog.byId, orders, scenario, policy, seed: 3, retainEvents: true });
      expect(r.metrics.unfinishedOrders).toBe(0);
      expect(r.metrics.orders).toBe(orders.length);
      for (let i = 1; i < r.events.length; i++) expect((r.events[i] as { t: number }).t).toBeGreaterThanOrEqual((r.events[i - 1] as { t: number }).t - 1e-6);
    }
  });

  it('公共随机数：不同策略面对同一批缺货事件', () => {
    const a = simulateDay({ model, items: catalog.byId, orders, scenario, policy: BASELINE, seed: 8 });
    const b = simulateDay({ model, items: catalog.byId, orders, scenario, policy: { ...BASELINE, name: 'b2', routing: 'TSP' }, seed: 8 });
    expect(b.metrics.notFoundLinePct).toBe(a.metrics.notFoundLinePct);
    expect(b.metrics.substitutedLines).toBe(a.metrics.substitutedLines);
  });

  it('优化策略消除超重、压坏风险和化学品混装', () => {
    const r = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3 });
    expect(r.metrics.overweightTotePct).toBe(0);
    expect(r.metrics.crushRiskTotePct).toBe(0);
    expect(r.metrics.chemicalMixTotePct).toBe(0);
  });
});

describe('动画轨迹', () => {
  const plain = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 5 });
  const traced = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 5, trace: true });

  it('打开轨迹不改变任何结果', () => {
    expect(traced.metrics).toEqual(plain.metrics);
    expect(plain.trace).toBeUndefined();
  });

  it('每个员工的片段按时间排序、互不重叠、都在在岗时间内，节点合法', () => {
    const trace = traced.trace;
    if (!trace) throw new Error('no trace');
    expect(trace.associates.length).toBeGreaterThan(0);
    for (const a of trace.associates) {
      for (let i = 0; i < a.segments.length; i++) {
        const s = a.segments[i] as (typeof a.segments)[number];
        expect(s.t1).toBeGreaterThan(s.t0);
        expect(s.from).toBeGreaterThanOrEqual(0);
        expect(s.to).toBeLessThan(model.nodes.length);
        if (i > 0) expect(s.t0).toBeGreaterThanOrEqual((a.segments[i - 1] as typeof s).t1 - 1e-6);
        expect(a.shifts.some(([on, off]) => s.t0 >= on - 1e-6 && s.t0 <= off + 1e-6)).toBe(true);
      }
    }
  });

  it('暂存占用：每次取出都对应之前的放入，最后全部清空', () => {
    const trace = traced.trace;
    if (!trace) throw new Error('no trace');
    const occ = new Map<string, number>();
    for (const c of trace.staging) {
      const key = `${c.orderId}|${c.slotCode}`;
      occ.set(key, (occ.get(key) ?? 0) + c.delta);
      expect(occ.get(key)).toBeGreaterThanOrEqual(0);
    }
    expect([...occ.values()].every((v) => v === 0)).toBe(true);
    expect(trace.sessions.every((s) => s.arrivedAt !== undefined && s.doneAt !== undefined && s.doneAt >= s.arrivedAt)).toBe(true);
  });
});

describe('统计', () => {
  it('分位数与置信区间', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    const s = summarize([10, 10, 10]);
    expect(s.mean).toBe(10);
    expect(s.ci95).toBe(0);
  });
});

describe('道路拥堵', () => {
  it('强度为 0 时结果与不接入拥堵模型逐位相同', () => {
    const off = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 4 });
    const zero = simulateDay({ model, items: catalog.byId, orders, scenario: { ...scenario, traffic: { ...DEFAULT_TRAFFIC, level: 0 } }, policy: OPTIMIZED, seed: 4 });
    expect(zero.metrics).toEqual(off.metrics);
    expect(off.metrics.avgTrafficDelayMin).toBe(0);
  });

  it('拥堵指数在相邻小时之间线性插值，跨午夜循环', () => {
    const p = { ...DEFAULT_TRAFFIC, level: 1, profile: Array.from({ length: 24 }, (_, h) => (h === 17 ? 1 : h === 18 ? 0.5 : 0)) };
    expect(congestionAt(p, 17 * 3600)).toBeCloseTo(1);
    expect(congestionAt(p, 17.5 * 3600)).toBeCloseTo(0.75);
    expect(congestionAt(p, (24 + 17) * 3600)).toBeCloseTo(1);
    expect(congestionAt({ ...p, level: 2 }, 17 * 3600)).toBeCloseTo(2);
  });

  it('延误随拥堵和个体系数变化，并有上下界', () => {
    const p = { ...DEFAULT_TRAFFIC, level: 1 };
    const peak = 17 * 3600;
    const free = 15 * 60;
    expect(trafficDelaySec(undefined, peak, free, 0.5)).toBe(0);
    expect(trafficDelaySec({ ...p, level: 0 }, peak, free, 0.5)).toBe(0);
    const lo = trafficDelaySec(p, peak, free, 0);
    const hi = trafficDelaySec(p, peak, free, 0.999);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(Math.round(free * p.slowdown * (1 + p.spread)));
    expect(trafficDelaySec(p, 3 * 3600, free, 0.5)).toBeLessThan(trafficDelaySec(p, peak, free, 0.5));
  });

  it('堵车时按「我在路上」备货的订单在门口等得更久，按 ETA 备货的基本不受影响', () => {
    const heavy = { ...scenario, traffic: { ...DEFAULT_TRAFFIC, level: 2 } };
    const run = (policy: typeof BASELINE, sc: typeof scenario) => simulateDay({ model, items: catalog.byId, orders, scenario: sc, policy, seed: 6 }).metrics;
    const b0 = run(BASELINE, scenario);
    const b2 = run(BASELINE, heavy);
    const o0 = run(OPTIMIZED, scenario);
    const o2 = run(OPTIMIZED, heavy);
    expect(b2.avgTrafficDelayMin).toBeGreaterThan(5);
    expect(b2.avgReadyDwellMin - b0.avgReadyDwellMin).toBeGreaterThan(5);
    expect(Math.abs(o2.avgReadyDwellMin - o0.avgReadyDwellMin)).toBeLessThan(1.5);
    expect(b2.unfinishedOrders).toBe(0);
    expect(o2.unfinishedOrders).toBe(0);
  });
});

describe('汽车快修中心', () => {
  const cfg: AutoServiceConfig = { id: 'AUTO-1', kind: 'AUTO_SERVICE', name: 'Auto', side: 'LEFT', oilBays: 2, tireBays: 2, carsPerDay: 40, hours: { openMin: 8 * 60, closeMin: 19 * 60 } };

  it('可复现：同一种子结果相同', () => {
    expect(simulateAutoService(cfg, 3)).toEqual(simulateAutoService(cfg, 3));
  });

  it('工位不会同时服务两辆车，作业类型与工位类型一致，所有排队车辆当天做完', () => {
    const r = simulateAutoService(cfg, 4);
    const served = r.jobs.filter((j) => !j.balked);
    expect(served.every((j) => j.start !== undefined && j.end !== undefined)).toBe(true);
    for (const j of served) {
      expect(j.start as number).toBeGreaterThanOrEqual(j.arrive);
      expect(j.kind === 'OIL' ? (j.bay as number) < cfg.oilBays : (j.bay as number) >= cfg.oilBays).toBe(true);
    }
    for (let b = 0; b < cfg.oilBays + cfg.tireBays; b++) {
      const list = served.filter((j) => j.bay === b).sort((x, y) => (x.start as number) - (y.start as number));
      for (let i = 1; i < list.length; i++) expect(list[i]?.start as number).toBeGreaterThanOrEqual((list[i - 1]?.end as number) - 1e-6);
    }
    expect(r.metrics.served + r.metrics.balked).toBe(r.metrics.arrivals);
    expect(r.metrics.revenue).toBeGreaterThan(0);
  });

  it('工位越多等待越短；需求远超能力时顾客流失', () => {
    const busy = { ...cfg, carsPerDay: 120 };
    const few = simulateAutoService({ ...busy, oilBays: 1, tireBays: 1 }, 5);
    const many = simulateAutoService({ ...busy, oilBays: 4, tireBays: 4 }, 5);
    expect(many.metrics.avgWaitMin).toBeLessThan(few.metrics.avgWaitMin);
    expect(few.metrics.balked).toBeGreaterThan(many.metrics.balked);
    expect(few.metrics.bayUtil).toBeGreaterThan(many.metrics.bayUtil);
  });
});

describe('门店规模与营业时间', () => {
  it('规模插值经过三个模板的取值，并随通道数单调增加', () => {
    expect(storeSizing(8)).toEqual({ ordersPerDay: 70, staffScale: 0.3 });
    expect(storeSizing(16)).toEqual({ ordersPerDay: 260, staffScale: 1 });
    expect(storeSizing(31)).toEqual({ ordersPerDay: 650, staffScale: 2.5 });
    let prev = 0;
    for (let n = 4; n <= 40; n++) {
      const s = storeSizing(n);
      expect(s.ordersPerDay).toBeGreaterThanOrEqual(prev);
      prev = s.ordersPerDay;
    }
    expect(scaledStaffing(1)).toEqual(defaultScenario('medium').staffing);
  });

  it('营业时间不变时排班不变；营业时间缩短后，关门后不再排班', () => {
    const base = defaultScenario('medium').staffing;
    expect(shiftStaffing(base, 7 * 60, 22 * 60)).toEqual(base);
    const short = shiftStaffing(base, 9 * 60, 20 * 60);
    for (const role of ['pick', 'stage', 'handoff', 'exception'] as const) {
      expect(short[role].slice(21).every((v) => v === 0)).toBe(true);
      expect(short[role].slice(0, 8).every((v) => v === 0)).toBe(true);
    }
    expect(short.pick.slice(9, 20).every((v) => v > 0)).toBe(true);
  });
});

describe('到货、上架与夜班补货', () => {
  const run = (nightCrew: number, totalCases = 900, forklifts?: number) => {
    const m = forklifts === undefined ? model : new StoreModel({ ...model.config, backroom: { ...model.config.backroom, forklifts } });
    return simulateInbound(m, {}, { ...DEFAULT_INBOUND, open: 7 * 3600, close: 22 * 3600, nextOpen: 31 * 3600, nightCrew, totalCases, dcPallets: 14, reeferPallets: 6, vendorTrucks: 3 }, 3);
  };

  it('可复现；所有到货车辆都卸完离开；每个人的作业片段按时间排列、互不重叠', () => {
    const a = run(4);
    expect(run(4)).toEqual(a);
    for (const tr of a.trucks) {
      expect(tr.leave).toBeGreaterThan(tr.arrive);
      const unloaded = a.pallets.filter((p) => p.truck === tr.id && p.receivedAt !== undefined).length;
      expect(unloaded).toBe(tr.pallets);
    }
    for (const w of a.workers) {
      for (let i = 1; i < w.segments.length; i++) expect((w.segments[i] as (typeof w.segments)[number]).t0).toBeGreaterThanOrEqual((w.segments[i - 1] as (typeof w.segments)[number]).t1 - 1e-6);
    }
    expect(a.metrics.stockedCases + a.metrics.backlogCases).toBe(a.metrics.totalCases);
  });

  it('放进货架的托盘占用不同货位；叉车同一时刻只做一件事', () => {
    const a = run(4);
    const stored = a.pallets.filter((p) => p.location !== undefined);
    const byLoc = new Map<string, typeof stored>();
    for (const p of stored) byLoc.set(p.location as string, [...(byLoc.get(p.location as string) ?? []), p]);
    for (const list of byLoc.values()) {
      const spans = list.map((p) => [p.storedAt ?? 0, p.emptiedAt ?? Infinity] as const).sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < spans.length; i++) expect((spans[i] as readonly [number, number])[0]).toBeGreaterThanOrEqual((spans[i - 1] as readonly [number, number])[1] - 1e-6);
    }
    for (const e of a.equipment) {
      for (let i = 1; i < e.segments.length; i++) expect((e.segments[i] as (typeof e.segments)[number]).t0).toBeGreaterThanOrEqual((e.segments[i - 1] as (typeof e.segments)[number]).t1 - 1e-6);
    }
  });

  it('叉车放货 / 取下高层托盘都有举升片段；取下的托盘落在后仓地面上；剩余箱数按取货记录递减', () => {
    const a = run(4, 1500);
    const b = backroomLayout(model.config);
    const locs = new Map(b.locations.map((l) => [l.id, l]));
    const lifts = a.equipment.flatMap((e) => e.segments.filter((s) => s.lift));
    for (const p of a.pallets.filter((q) => q.truck && q.storedAt !== undefined)) {
      const up = lifts.find((s) => s.lift?.pallet === p.id && s.lift.mode === 'up');
      expect(up?.t1).toBeCloseTo(p.storedAt as number, 6);
      expect(up?.lift?.y).toBe(locs.get(p.location as string)?.y);
    }
    const downs = a.pallets.filter((q) => q.letdownAt !== undefined);
    expect(downs.length).toBeGreaterThan(0);
    for (const p of downs) {
      const l = locs.get(p.location as string);
      expect(l?.level).toBeGreaterThan(0);
      expect(lifts.find((s) => s.lift?.pallet === p.id && s.lift.mode === 'down')?.t1).toBeCloseTo(p.letdownAt as number, 6);
      const spot = floorSpotFor(l as NonNullable<typeof l>);
      expect(spot.z).toBeGreaterThan(b.zone.z0 - 0.5);
      expect(spot.z).toBeLessThan(b.zone.z1);
    }
    for (const p of a.pallets) {
      const drawn = p.draws.reduce((n, [, c]) => n + c, 0);
      expect(p.initialCases - drawn).toBe(p.cases);
    }
  });

  it('夜班人越少开门时积压越多；没有叉车时只能用搬运车卸货，货不进高层货架', () => {
    const few = run(1, 1500);
    const many = run(10, 1500);
    expect(few.metrics.backlogCases).toBeGreaterThan(many.metrics.backlogCases);
    const noFork = run(4, 600, 0);
    expect(noFork.pallets.filter((p) => p.truck && p.storedAt !== undefined)).toHaveLength(0);
    expect(estimateRestockCases(6000)).toBeGreaterThan(estimateRestockCases(3000));
  });
});

describe('突发状况', () => {
  const run = (incidents?: { small: typeof DEFAULT_SMALL_INCIDENTS | null; disruptions: Disruption[] }) =>
    simulateDay({ model, items: catalog.byId, orders, scenario: incidents ? { ...scenario, incidents } : scenario, policy: OPTIMIZED, seed: 12, retainEvents: true });

  it('没有突发状况时结果逐位相同', () => {
    expect(run({ small: null, disruptions: [] }).metrics).toEqual(run().metrics);
  });

  it('火警期间不开始任何新作业，顾客等待变长，所有订单仍然完成', () => {
    const fire: Disruption = { id: 'F', kind: 'FIRE_ALARM', start: 12 * 3600, end: 12.5 * 3600 };
    const base = run();
    const r = run({ small: null, disruptions: [fire] });
    const startedInWindow = r.events.filter((e) => (e.type === 'PrepStarted' || e.type === 'PickWalkClaimed') && e.t > fire.start + 1 && e.t < fire.end - 1);
    expect(startedInWindow).toHaveLength(0);
    expect(r.metrics.avgWaitMin).toBeGreaterThan(base.metrics.avgWaitMin);
    expect(r.metrics.unfinishedOrders).toBe(0);
    expect(r.events.some((e) => e.type === 'IncidentOccurred')).toBe(true);
  });

  it('系统故障期间订单不下发；小状况增加作业时间', () => {
    const sys: Disruption = { id: 'S', kind: 'SYSTEM_OUTAGE', start: 11 * 3600, end: 11.75 * 3600 };
    const r = run({ small: null, disruptions: [sys] });
    expect(r.events.filter((e) => e.type === 'OrderLocked' && e.t > sys.start && e.t < sys.end)).toHaveLength(0);
    const small = run({ small: { ...DEFAULT_SMALL_INCIDENTS, labelReprint: 0.2, damagedItem: 0.1, missingTote: 0.2 }, disruptions: [] });
    expect(small.metrics.busyHoursTotal).toBeGreaterThan(run().metrics.busyHoursTotal);
    expect(small.events.filter((e) => e.type === 'IncidentOccurred').length).toBeGreaterThan(10);
  });

  it('暂停顺延按窗口累加；随机大事件可复现且在营业时间内', () => {
    const ds: Disruption[] = [
      { id: 'a', kind: 'FIRE_ALARM', start: 100, end: 160 },
      { id: 'b', kind: 'FIRE_ALARM', start: 200, end: 230 },
    ];
    expect(pauseOverlap(ds, 'pick', 50, 100)).toBe(60 + 30);
    expect(pauseOverlap(ds, 'pick', 0, 40)).toBe(0);
    const a = randomDisruptions(5, 7 * 3600, 22 * 3600, 3);
    expect(randomDisruptions(5, 7 * 3600, 22 * 3600, 3)).toEqual(a);
    for (const d of a) {
      expect(d.start).toBeGreaterThanOrEqual(7 * 3600);
      expect(d.end).toBeLessThanOrEqual(22 * 3600 + 3600);
    }
  });
});

describe('药房柜台', () => {
  const cfg = { id: 'PHARM-1', kind: 'PHARMACY' as const, name: 'Rx', counters: 1, patientsPerDay: 120, hours: { openMin: 8 * 60, closeMin: 21 * 60 } };
  it('可复现；所有顾客都得到服务；柜台越多等待越短', () => {
    const one = simulatePharmacy(cfg, 2);
    expect(simulatePharmacy(cfg, 2)).toEqual(one);
    expect(one.metrics.served).toBe(one.metrics.patients);
    const three = simulatePharmacy({ ...cfg, counters: 3 }, 2);
    expect(three.metrics.avgWaitMin).toBeLessThan(one.metrics.avgWaitMin);
    for (const v of one.visits) expect(v.start as number).toBeGreaterThanOrEqual(v.arrive);
  });
});

describe('方案经营账与多日分布', () => {
  const base = {
    metrics: { orders: 200, fillRate: 0.98, staffedHoursTotal: 60, lateOrderPct: 5, longWaitPct: 10, handoffSessions: 180, shortValue: 400 },
    receivingHours: 16,
    nightHours: 48,
    forklifts: 1,
    palletJacks: 2,
    backlogCases: 100,
    autoRevenue: 3000,
  };

  it('收入、成本与净额相互一致；人更多成本更高，迟到更多净额更低', () => {
    const p = dayPnL(base);
    expect(p.revenue - p.cost).toBeCloseTo(p.net, 6);
    expect(p.groups.online + p.groups.service + p.groups.backroom).toBeCloseTo(p.net, 6);
    expect(p.groups.service).toBeCloseTo(3000 * 0.45, 6);
    expect(p.groups.backroom).toBeLessThan(0);
    expect(p.lines.find((l) => l.key === 'online')?.value).toBeCloseTo(200 * 85 * 0.98 * 0.25, 6);
    expect(p.lines.find((l) => l.key === 'labor')?.value).toBeCloseTo(-60 * 18, 6);
    const more = dayPnL({ ...base, metrics: { ...base.metrics, staffedHoursTotal: 80 } });
    expect(more.cost).toBeGreaterThan(p.cost);
    const late = dayPnL({ ...base, metrics: { ...base.metrics, lateOrderPct: 20 } });
    expect(late.net).toBeLessThan(p.net);
    expect(dayPnL(base, { ...DEFAULT_COSTS, wagePerHour: 25 }).net).toBeLessThan(p.net);
  });

  it('分布的分位数有序；单个值时各分位相等；一周系数平均约为 1', () => {
    const d = distribution([5, 1, 3, 2, 4, Number.NaN]);
    expect(d.n).toBe(5);
    expect(d.min).toBe(1);
    expect(d.max).toBe(5);
    expect(d.p50).toBe(3);
    expect(d.p10).toBeLessThanOrEqual(d.p50);
    expect(d.p90).toBeGreaterThanOrEqual(d.p50);
    expect(distribution([7]).p90).toBe(7);
    expect(distribution([]).n).toBe(0);
    const avg = WEEKDAY_FACTORS.reduce((a, b) => a + b, 0) / 7;
    expect(avg).toBeGreaterThan(0.98);
    expect(avg).toBeLessThan(1.04);
  });
});

describe('货架存量闭环（Phase 4）', () => {
  const planogram = buildPlanogram(model, catalog.byId);
  const backroom = new Map(planogram.map((p, i) => [p.itemId, i % 2 === 0 ? p.packQty * 2 : 0]));
  const make = (seed = 5) =>
    new ShelfStock({ planogram, open: model.config.hours.openMin * 60, close: model.config.hours.closeMin * 60, seed, backroom, openFill: 0.5, lowShare: 0.15 });

  it('存量由事件重放得到：销售不会把存量变成负数；补货最多补到满', () => {
    const shelf = make();
    const p = planogram.find((x) => backroom.get(x.itemId)) as (typeof planogram)[number];
    const t0 = model.config.hours.openMin * 60;
    const start = shelf.level(p.itemId, t0);
    const end = shelf.level(p.itemId, model.config.hours.closeMin * 60);
    expect(end).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(start);
    const units = shelf.restock(p.itemId, t0 + 3600);
    expect(units).toBeGreaterThan(0);
    expect(shelf.level(p.itemId, t0 + 3600)).toBeLessThanOrEqual(p.capacity);
    expect(shelf.backroom(p.itemId)).toBe((backroom.get(p.itemId) ?? 0) - units);
  });

  it('货架空 → Exception → 补货任务 → 货架恢复：同一种子可复现；不传货架模块时结果不变', () => {
    const run = () => simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3, retainEvents: true, trace: true, shelf: make() });
    const a = run();
    const b = run();
    expect(b.metrics).toEqual(a.metrics);
    expect(b.shelf).toEqual(a.shelf);
    const ev = a.events;
    const empty = ev.filter((e) => e.type === 'ShelfEmpty');
    const created = ev.filter((e) => e.type === 'ReplenishmentTaskCreated');
    const done = ev.filter((e) => e.type === 'ReplenishmentCompleted');
    expect(empty.length).toBeGreaterThan(0);
    expect(created.length).toBeGreaterThan(0);
    expect(done.length).toBeGreaterThan(0);
    // 至少有一个商品：货架空 → 补货完成，之后的存量大于 0
    const restored = done.find((d) => empty.some((e) => e.payload.itemId === d.payload.itemId && e.t <= d.t));
    expect(restored).toBeDefined();
    expect(a.shelf?.restocks).toBe(done.length);
    expect(a.shelf?.lostSalesUnits).toBeGreaterThan(0);
    expect(a.shelf?.changes.length).toBeGreaterThan(100);
    // 补货员的轨迹：去后仓取箱、到货位上架
    const acts = new Set(a.trace?.associates.flatMap((x) => x.segments.map((s) => s.activity)));
    expect(acts.has('后仓取箱') && acts.has('补货上架')).toBe(true);
    // 不传货架模块：与原来的概率模型完全一致
    const plain1 = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3 });
    const plain2 = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3 });
    expect(plain2.metrics).toEqual(plain1.metrics);
    expect(plain1.shelf).toBeUndefined();
  });

  it('手动请求补货：在指定时刻生成任务并完成', () => {
    const p = planogram.find((x) => backroom.get(x.itemId)) as (typeof planogram)[number];
    const t = model.config.hours.openMin * 60 + 4 * 3600;
    const shelf = new ShelfStock({ planogram, open: model.config.hours.openMin * 60, close: model.config.hours.closeMin * 60, seed: 5, backroom, requests: [{ itemId: p.itemId, t }] });
    // 白天补货员：后仓补取岗位每小时多 2 人
    const staffed = { ...scenario, staffing: { ...scenario.staffing, exception: scenario.staffing.exception.map((n, h) => (h >= 7 && h < 22 ? n + 2 : n)) } };
    const r = simulateDay({ model, items: catalog.byId, orders, scenario: staffed, policy: OPTIMIZED, seed: 3, retainEvents: true, shelf });
    const mine = r.events.filter((e) => (e.type === 'ReplenishmentTaskCreated' || e.type === 'ReplenishmentCompleted') && e.payload.itemId === p.itemId);
    // 在请求时刻之前可能已经因为偏低而生成过任务；否则手动请求生成任务
    expect(mine.some((e) => e.type === 'ReplenishmentTaskCreated' && (e.payload.reason === 'MANUAL' || e.t <= t))).toBe(true);
    expect(mine.some((e) => e.type === 'ReplenishmentCompleted')).toBe(true);
  });
});

describe('AI 模块开关（Phase 5c）', () => {
  it('不打开时与原策略逐项相同；AI 排班总工时不变，AI 全开时平均等待更短', async () => {
    const { aiAblationPolicies, runExperiment, OPTIMIZED: OPT } = await import('./index');
    const r = runExperiment({ template: 'medium', reps: 4, baseSeed: 77, policies: [OPT, { ...OPT, name: 'optimized-noai', ai: {} }, ...aiAblationPolicies(OPT)] });
    const by = new Map(r.policies.map((p) => [p.policy, p]));
    const plain = by.get('optimized')!;
    const empty = by.get('optimized-noai')!;
    expect(empty.runs.map((m) => ({ ...m, policy: '' }))).toEqual(plain.runs.map((m) => ({ ...m, policy: '' })));
    const staffing = by.get('optimized+ai-staffing')!;
    expect(staffing.summary.staffedHoursTotal.mean).toBeCloseTo(plain.summary.staffedHoursTotal.mean, 6);
    const all = by.get('optimized+ai-all')!;
    expect(all.summary.avgWaitMin.mean).toBeLessThan(plain.summary.avgWaitMin.mean);
    expect(by.get('optimized+ai-substitution')!.summary.substitutedLines.mean).toBeGreaterThan(plain.summary.substitutedLines.mean);
  });
});
