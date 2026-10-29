import { describe, expect, it } from 'vitest';
import { backroomLayout, createTemplate, floorSpotFor, StoreModel } from '@storewright/store-config';
import { generateCatalog, generateOrders } from '@storewright/synth';
import { EventQueue } from './kernel';
import { simulateDay } from './day';
import { BASELINE, OPTIMIZED, ablationPolicies, defaultScenario, scaledStaffing, shiftStaffing, storeSizing } from './scenario';
import { percentile, summarize } from './stats';
import { DEFAULT_TRAFFIC, congestionAt, trafficDelaySec } from './traffic';
import { simulateAutoService } from './autoService';
import { DEFAULT_INBOUND, estimateRestockCases, simulateInbound, VERTICAL_WEIGHT, YARD_TIMING } from './inbound';
import { GROCERY_VENDORS, planDeliveries, visitDays, weeklyVisits, type DeliveryInput } from './deliveries';
import { DEFAULT_COSTS, dayPnL, distribution, WEEKDAY_FACTORS } from './economics';
import { simulatePharmacy } from './pharmacy';
import { DEFAULT_SMALL_INCIDENTS, pauseOverlap, randomDisruptions, type Disruption } from './incidents';
import type { AutoServiceConfig } from '@storewright/store-config';
import { buildPlanogram } from '@storewright/algorithms';
import { ShelfStock } from './shelfStock';
import { isSchoolDay, STUDENT_RULES, studentDays, studentShifts, studentWeeklyHours } from './students';
import { inboundDeliveries, type InboundParams } from './inbound';
import { moveDelivery } from './deliveries';
import { adviseBackroom, adviseFront, adviseInbound, adviseRisks, adviseStaging, erlangWaitMin, totalYardWaitMin, type BackroomLab, type InboundAdjust, type InboundRun, type StagingLab, type StagingRun } from './advisor';

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
    return simulateInbound(m, {}, { ...DEFAULT_INBOUND, open: 7 * 3600, close: 22 * 3600, nextOpen: 31 * 3600, nightCrew, totalCases, dcPallets: 14, reeferPallets: 6, scale: 1 }, 3);
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

  const overlaps = (spans: Array<[number, number]>) => {
    const s = [...spans].sort((a, b) => a[0] - b[0]);
    return s.some((x, i) => i > 0 && x[0] < (s[i - 1] as [number, number])[1] - 1e-6);
  };

  it('卸货场：先到先进；场地同一时间只有一辆车行驶；一个卸货门同时只停一辆车；靠稳并做完准备才开始卸货（决策记录 0018）', () => {
    // 夜里的托盘多：四辆半挂车先后到达，卸货门不够用，会有车在场内排队；上午一家接一家的供应商直送
    // 中型店只有两个卸货门：夜里三辆车前后脚到，会有车在场内排队
    const med = createTemplate('medium');
    const m3 = new StoreModel({ ...med, backroom: { ...med.backroom, docks: 2 } });
    const a = simulateInbound(m3, {}, { ...DEFAULT_INBOUND, open: 7 * 3600, close: 22 * 3600, nextOpen: 31 * 3600, nightCrew: 6, totalCases: 1200, dcPallets: 48, reeferPallets: 6, scale: 1 }, 5);
    expect(a.trucks.filter((t) => t.kind === 'SEMI' && t.source === 'DC').length).toBe(3);
    expect(a.trucks.some((t) => t.vendor)).toBe(true);
    const doors = backroomLayout(m3.config).docks.length;
    const byArrive = [...a.trucks].sort((x, y) => x.arrive - y.arrive);
    for (let i = 1; i < byArrive.length; i++) expect((byArrive[i] as (typeof byArrive)[number]).dockAt).toBeGreaterThanOrEqual((byArrive[i - 1] as (typeof byArrive)[number]).dockAt);
    // 场地上的行驶：进场靠台 [dockAt, dockedAt]、拉出驶离 [leave, goneAt] 互不重叠
    expect(overlaps(a.trucks.flatMap((t) => [[t.dockAt, t.dockedAt] as [number, number], [t.leave, t.goneAt] as [number, number]]))).toBe(false);
    for (let d = 0; d < doors; d++) expect(overlaps(a.trucks.filter((t) => t.door === d).map((t) => [t.dockAt, t.leave] as [number, number]))).toBe(false);
    for (const t of a.trucks) {
      expect(t.dockAt).toBeGreaterThanOrEqual(t.arrive);
      expect(t.dockedAt - t.dockAt).toBe(YARD_TIMING[t.kind].dock);
      expect(t.unloadStart - t.dockedAt).toBe(YARD_TIMING[t.kind].setup);
      const received = a.pallets.filter((p) => p.truck === t.id).map((p) => p.receivedAt as number);
      expect(received.length).toBe(t.pallets);
      expect(Math.min(...received)).toBeGreaterThan(t.unloadStart);
      expect(t.leave).toBeGreaterThanOrEqual(Math.max(...received) + 8 * 60 - 1e-6);
      expect(t.goneAt - t.leave).toBe(YARD_TIMING[t.kind].exit);
    }
    // 有车在场内排过队（到达时不能马上进场）
    expect(a.trucks.some((t) => t.dockAt > t.arrive + 1)).toBe(true);
  });

  it('叉车与搬运车：一个车厢同时只进一台设备；一条货架通道同时只有一台叉车；作业完驶出通道、停回充电位（决策记录 0018）', () => {
    // 中型店三台叉车
    const m = new StoreModel({ ...createTemplate('medium'), backroom: { ...createTemplate('medium').backroom, forklifts: 3 } });
    const a = simulateInbound(m, {}, { ...DEFAULT_INBOUND, open: 7 * 3600, close: 22 * 3600, nextOpen: 31 * 3600, nightCrew: 6, totalCases: 1500, dcPallets: 30, reeferPallets: 8, scale: 1 }, 3);
    const b = backroomLayout(m.config);
    // 车厢：从开往卸货门到叉着托盘退出、开到收货区（按卸货门分组）
    const inTrailer = new Map<number, Array<[number, number]>>();
    for (const e of a.equipment) {
      const segs = e.segments;
      for (let i = 0; i < segs.length; i++) {
        const s0 = segs[i] as (typeof segs)[number];
        if (!/进车厢$/.test(s0.activity)) continue;
        const s1 = segs.slice(i + 1).find((s) => /卸货$/.test(s.activity));
        if (!s1) continue;
        const last = s0.pts[s0.pts.length - 1] as { x: number };
        const door = b.docks.findIndex((d) => Math.abs(d.x - last.x) < 0.01);
        inTrailer.set(door, [...(inTrailer.get(door) ?? []), [s0.t0, s1.t1]]);
      }
    }
    expect([...inTrailer.values()].flat().length).toBeGreaterThan(0);
    for (const spans of inTrailer.values()) expect(overlaps(spans)).toBe(false);
    // 货架通道：从通道口开进去到驶出通道回到通道口（按通道分组）
    const inAisle = new Map<number, Array<[number, number]>>();
    const forks = a.equipment.filter((e) => e.kind === 'forklift');
    expect(forks).toHaveLength(3);
    for (const e of forks) {
      let enter: { t: number; ai: number } | undefined;
      for (const s of e.segments) {
        const p0 = s.pts[0] as { x: number; z: number };
        const ai = b.aisles.findIndex((z) => Math.abs(z - p0.z) < 0.01);
        if ((s.activity === '叉车放进货架' || s.activity === '叉车去高层货位') && Math.abs(p0.x - b.mainAisleX) < 0.01 && ai >= 0 && s.pts.length > 1) enter = { t: s.t0, ai };
        if (s.activity === '叉车驶出通道' && enter) {
          const end = s.pts[s.pts.length - 1] as { x: number; z: number };
          expect(end.x).toBeCloseTo(b.mainAisleX, 6);
          inAisle.set(enter.ai, [...(inAisle.get(enter.ai) ?? []), [enter.t, s.t1]]);
          enter = undefined;
        }
      }
    }
    expect([...inAisle.values()].flat().length).toBeGreaterThan(3);
    for (const spans of inAisle.values()) expect(overlaps(spans)).toBe(false);
    // 分工：三台叉车都干过活；去做别的事之前把叉车停回收货区的充电位
    for (const e of forks) expect(e.segments.length).toBeGreaterThan(0);
    const parks = a.equipment.flatMap((e) => e.segments.filter((s) => s.activity === '叉车停回充电位'));
    expect(parks.length).toBeGreaterThan(0);
    for (const s of parks) {
      const end = s.pts[s.pts.length - 1] as { x: number; z: number };
      expect(end.x).toBeGreaterThanOrEqual(b.receiving.x0 - 0.01);
      expect(end.x).toBeLessThanOrEqual(b.receiving.x1 + 0.01);
    }
  });
});

describe('到货排班（决策记录 0019）', () => {
  const base: DeliveryInput = { scale: 1, weekday: 3, season: 'autumn', open: 7 * 3600, close: 22 * 3600, dcPallets: 22, reeferPallets: 8, gm: true, pharmacy: true, seed: 1 };
  const week = (over: Partial<DeliveryInput>) => [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => planDeliveries({ ...base, ...over, weekday }));

  it('每周的次数均匀排在星期几；规模和季节调整次数', () => {
    expect(visitDays('X', 3)).toHaveLength(3);
    expect(visitDays('X', 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const d = visitDays('BREAD-A', 3);
    // 相邻两次至少隔一天
    for (let i = 1; i < d.length; i++) expect(d[i]! - d[i - 1]!).toBeGreaterThanOrEqual(2);
    const ice = GROCERY_VENDORS.find((v) => v.id === 'ICE')!;
    expect(weeklyVisits(ice, 1, 'summer')).toBeGreaterThan(weeklyVisits(ice, 1, 'winter'));
    const water = GROCERY_VENDORS.find((v) => v.id === 'WATER')!;
    expect(weeklyVisits(water, 0.5, 'autumn')).toBe(0);
  });

  it('中型超市的一天：清晨冷藏车，上午一家接一家的供应商直送（多数在 4:30–13:00），下午快递和百货车，关门后长途半挂车', () => {
    const day = planDeliveries(base);
    const dsd = day.filter((d) => d.source === 'VENDOR');
    expect(dsd.length).toBeGreaterThanOrEqual(6);
    expect(dsd.length).toBeLessThanOrEqual(20);
    expect(dsd.filter((d) => d.appt >= 4.5 * 3600 && d.appt <= 13 * 3600).length / dsd.length).toBeGreaterThan(0.85);
    const reefer = day.find((d) => d.kind === 'REEFER')!;
    expect(Math.abs(reefer.appt - (base.open - 90 * 60))).toBeLessThan(1);
    expect(day.filter((d) => d.source === 'DC' && d.kind === 'SEMI').every((d) => d.arrive >= base.close)).toBe(true);
    expect(day.some((d) => d.kind === 'VAN')).toBe(true);
    // 按到达时刻排好
    for (let i = 1; i < day.length; i++) expect(day[i]!.arrive).toBeGreaterThanOrEqual(day[i - 1]!.arrive);
    // 一周：周六晚没有长途半挂车；百货车每周 3 次
    expect(planDeliveries({ ...base, weekday: 5 }).some((d) => d.id.startsWith('TRUCK-NIGHT'))).toBe(false);
    expect(week({}).filter((d) => d.source === 'DC_GM')).toHaveLength(3);
  });

  it('规模越大来得越多；夏天冰品、饮用水多跑；建材店是另一套供应商，没有冷藏车', () => {
    const small = week({ scale: 0.5 }).filter((d) => d.source === 'VENDOR').length;
    const large = week({ scale: 2 }).filter((d) => d.source === 'VENDOR').length;
    expect(large).toBeGreaterThan(small * 1.4);
    expect(week({ season: 'summer' }).filter((d) => d.id === 'VENDOR-ICE').length).toBeGreaterThan(week({ season: 'winter' }).filter((d) => d.id === 'VENDOR-ICE').length);
    const hw = week({ industry: 'HARDWARE', gm: true });
    expect(hw.some((d) => d.kind === 'REEFER')).toBe(false);
    expect(hw.filter((d) => d.id === 'VENDOR-LUMBER').length).toBe(2);
  });

  it('后仓放满时，搬运车把托盘经连通通道送到暂存区的溢流位，夜班从那里取货补货', () => {
    const m = new StoreModel(createTemplate('medium'));
    const a = simulateInbound(m, {}, { ...DEFAULT_INBOUND, initialFill: 1, open: 7 * 3600, close: 22 * 3600, nextOpen: 31 * 3600, nightCrew: 6, totalCases: 1500, dcPallets: 30, reeferPallets: 8, scale: 1 }, 2);
    const moved = a.pallets.filter((q) => q.overflowAt !== undefined);
    expect(moved.length).toBeGreaterThan(0);
    for (const q of moved) expect(q.overflowAt!).toBeGreaterThan(q.receivedAt!);
    const legs = a.equipment.flatMap((e) => e.segments.filter((s) => s.activity === '经连通通道送往溢流位'));
    expect(legs.length).toBe(moved.length);
    expect(moved.some((q) => q.draws.length > 0)).toBe(true);
  });

  it('两层的门店：二楼货架的托盘用搬运车经货梯送到二楼卸货区；夜班从二楼补货区给二楼货架补货', () => {
    const m = new StoreModel(createTemplate('large'));
    const runW: Record<string, number> = {};
    for (const r of m.config.layout.runs) runW[r.id] = r.floorId === 'F2' ? 3 : 1;
    const a = simulateInbound(m, runW, { ...DEFAULT_INBOUND, open: 7 * 3600, close: 22 * 3600, nextOpen: 31 * 3600, nightCrew: 10, totalCases: 2400, dcPallets: 40, reeferPallets: 10, scale: 2 }, 4);
    const ups = a.pallets.filter((q) => q.upAt !== undefined);
    expect(ups.length).toBeGreaterThan(0);
    for (const q of ups) expect(m.config.layout.runs.find((r) => r.id === q.runId)?.floorId).toBe('F2');
    expect(ups.every((q) => q.upSpot!.y === 7)).toBe(true);
    // 乘货梯：搬运车的轨迹里有竖直方向的一段
    const rides = a.equipment.flatMap((e) => e.segments.filter((s) => s.pts.some((q, i) => i > 0 && Math.abs(q.y - s.pts[i - 1]!.y) > 1)));
    expect(rides.length).toBeGreaterThan(0);
    expect(ups.some((q) => q.draws.length > 0)).toBe(true);
    expect(VERTICAL_WEIGHT).toBeGreaterThan(1);
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

describe('学生兼职工（决策记录 0020）', () => {
  const day = (weekday: number, season: 'autumn' | 'summer' = 'autumn') => ({ weekday, season, open: 7 * 3600, close: 22 * 3600 });

  it('上学日放学后才来、每人最多 4 小时，分两拨；周末 9–20 点之间最多 6 小时，分三拨', () => {
    const thu = studentShifts({ count: 6, roles: ['pick', 'handoff'] }, day(3));
    expect(thu.length).toBeGreaterThan(0);
    expect(thu.length).toBeLessThan(6);
    for (const s of thu) {
      expect(s.start).toBeGreaterThanOrEqual(STUDENT_RULES.schoolDay.from * 3600);
      expect(s.end).toBeLessThanOrEqual(STUDENT_RULES.schoolDay.to * 3600);
      expect(s.end - s.start).toBeLessThanOrEqual(STUDENT_RULES.schoolDay.maxHours * 3600);
    }
    expect(new Set(thu.map((s) => s.start)).size).toBe(Math.min(2, thu.length));
    const sat = studentShifts({ count: 6, roles: ['pick'] }, day(5));
    for (const s of sat) {
      expect(s.start).toBeGreaterThanOrEqual(STUDENT_RULES.freeDay.from * 3600);
      expect(s.end).toBeLessThanOrEqual(STUDENT_RULES.freeDay.to * 3600);
      expect(s.end - s.start).toBe(STUDENT_RULES.freeDay.maxHours * 3600);
    }
    expect(new Set(sat.map((s) => s.start)).size).toBe(Math.min(3, sat.length));
    // 岗位按名单顺序轮流
    expect(new Set(thu.map((s) => s.role))).toEqual(new Set(['pick', 'handoff']));
  });

  it('每人每周不超过 20 小时（学期里每周 4 天，暑假 3 天），暑假没有上学日；营业时间以外不排班', () => {
    for (let i = 0; i < 12; i++) {
      expect(studentDays(i, 'autumn')).toHaveLength(4);
      expect(studentDays(i, 'summer')).toHaveLength(3);
      expect(studentWeeklyHours(i, 'autumn', 7 * 3600, 22 * 3600)).toBeLessThanOrEqual(STUDENT_RULES.weeklyMaxHours);
      expect(studentWeeklyHours(i, 'summer', 7 * 3600, 22 * 3600)).toBeLessThanOrEqual(STUDENT_RULES.weeklyMaxHours);
    }
    expect(isSchoolDay(2, 'autumn')).toBe(true);
    expect(isSchoolDay(2, 'summer')).toBe(false);
    expect(isSchoolDay(6, 'spring')).toBe(false);
    // 下午 5 点关门的店：上学日只剩 1 小时
    const early = studentShifts({ count: 6, roles: ['pick'] }, { weekday: 1, season: 'autumn', open: 7 * 3600, close: 17 * 3600 });
    for (const s of early) expect(s.end).toBeLessThanOrEqual(17 * 3600);
    expect(studentShifts({ count: 6, roles: ['pick'] }, { weekday: 1, season: 'autumn', open: 7 * 3600, close: 16.5 * 3600 })).toEqual([]);
  });

  it('仿真里学生在全职排班之外按自己的班次上下岗：轨迹标出学生，工时计入在岗工时并单独统计', () => {
    const shifts = studentShifts({ count: 6, roles: ['pick', 'handoff'] }, day(3));
    const plain = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3, trace: true });
    const withStudents = simulateDay({ model, items: catalog.byId, orders, scenario: { ...scenario, students: shifts }, policy: OPTIMIZED, seed: 3, trace: true });
    const hours = shifts.reduce((h, s) => h + (s.end - s.start) / 3600, 0);
    expect(withStudents.metrics.studentHours).toBeCloseTo(hours, 6);
    expect(withStudents.metrics.staffedHoursTotal).toBeCloseTo(plain.metrics.staffedHoursTotal + hours, 6);
    const st = withStudents.trace!.associates.filter((a) => a.student);
    expect(st).toHaveLength(shifts.length);
    for (const a of st) {
      const sh = shifts.find((x) => a.id === `${x.role}-${x.id}`)!;
      expect(a.role).toBe(sh.role);
      expect(a.shifts[0]![0]).toBe(sh.start);
      // 下岗时手上的活做完再走
      expect(a.shifts[0]![1]).toBeGreaterThanOrEqual(sh.end);
      expect(a.shifts[0]![1] - sh.end).toBeLessThan(1800);
    }
    // 全职员工没有被学生顶替
    expect(withStudents.trace!.associates.filter((a) => !a.student).length).toBeGreaterThanOrEqual(plain.trace!.associates.length - 1);
    // 学生按学生时薪计入经营账
    const base = { receivingHours: 0, nightHours: 0, forklifts: 0, palletJacks: 0, backlogCases: 0, autoRevenue: 0 };
    const m = { orders: 200, fillRate: 0.98, staffedHoursTotal: 60, lateOrderPct: 5, longWaitPct: 10, handoffSessions: 180, shortValue: 400 };
    const full = dayPnL({ ...base, metrics: m });
    const mixed = dayPnL({ ...base, metrics: { ...m, studentHours: 10 } });
    const labor = (r: typeof full) => r.lines.find((l) => l.key === 'labor')!.value;
    expect(labor(mixed) - labor(full)).toBeCloseTo(10 * (DEFAULT_COSTS.wagePerHour - DEFAULT_COSTS.studentWagePerHour), 6);
  });
});

describe('AI 建议（决策记录 0020）', () => {
  // 只有一个卸货门的中型店：上午的供应商直送会在卸货场排队
  const cfg = createTemplate('medium');
  cfg.backroom.docks = 1;
  const m1 = new StoreModel(cfg);
  const P: InboundParams = { ...DEFAULT_INBOUND, open: 7 * 3600, close: 22 * 3600, nextOpen: 31 * 3600, nightCrew: 6, totalCases: 1500, dcPallets: 30, reeferPallets: 8, scale: 1, weekday: 0 };
  const run = (adj: InboundAdjust, seed: number): InboundRun => {
    const p: InboundParams = { ...P, ...(adj.receivers !== undefined ? { receivers: adj.receivers } : {}), ...(adj.nightCrew !== undefined ? { nightCrew: adj.nightCrew } : {}), ...(adj.slotting ? { slotting: adj.slotting } : {}) };
    const moves = adj.appt;
    if (moves) p.deliveries = inboundDeliveries(m1, P, seed).map((d) => (moves[d.id] !== undefined ? moveDelivery(d, moves[d.id] as number) : d));
    const r = simulateInbound(m1, {}, p, seed);
    return { trucks: r.trucks, metrics: r.metrics, pallets: r.pallets, equipment: r.equipment };
  };
  const seeds = [3, 1012, 2030, 3014];
  const lab: BackroomLab = { plans: inboundDeliveries(m1, P, 3), docks: 1, receivers: P.receivers, nightCrew: P.nightCrew, twoFloor: false, run, seeds, slotting: 'default', liftOrder: 'fifo', defaultNightCrew: 6, forklifts: cfg.backroom.forklifts };
  const runs = seeds.map((sd) => run({}, sd));

  it('卸货门排队：挪附近一家供应商的预约（仍在它的送货时段里），再仿真排队确实少了；晚到的车给出预计到达和原因', () => {
    const advice = adviseInbound(lab, runs);
    const q = advice.find((a) => a.code === 'YARD_QUEUE');
    expect(q).toBeDefined();
    const act = q!.action as { kind: 'MOVE_APPOINTMENT'; deliveryId: string; from: number; to: number };
    expect(act.kind).toBe('MOVE_APPOINTMENT');
    const plan = lab.plans.find((d) => d.id === act.deliveryId)!;
    expect(plan.window).toBeDefined();
    expect(act.to).toBeGreaterThanOrEqual(plan.window![0] * 3600);
    expect(act.to).toBeLessThanOrEqual(plan.window![1] * 3600);
    const eff = q!.effect!.find((e) => e.metric === 'YARD_WAIT')!;
    expect(eff.after).toBeLessThan(eff.before - 4);
    // 采纳后（当前种子）排队确实少了
    expect(totalYardWaitMin(run({ appt: { [act.deliveryId]: act.to } }, 3))).toBeLessThan(totalYardWaitMin(runs[0]!));
    expect(q!.confidence).toBeGreaterThan(0.3);
    expect(q!.confidence).toBeLessThanOrEqual(0.95);
    // 理由按权重从大到小排（只保留最重要的几条，权重加起来不超过 1）
    expect(q!.reasons.map((r) => r.weight)).toEqual([...q!.reasons.map((r) => r.weight)].sort((a, b) => b - a));
    expect(q!.reasons.reduce((a, r) => a + r.weight, 0)).toBeLessThanOrEqual(1.0001);
    for (const a of advice.filter((x) => x.code === 'LATE_ARRIVAL')) expect(Number(a.params.eta) - Number(a.params.appt)).toBeGreaterThanOrEqual(15 * 60);
  });

  it('挪预约：准点的起伏不变，到达跟着预约走', () => {
    const d = lab.plans.find((x) => x.window)!;
    const moved = moveDelivery(d, d.appt + 3600);
    expect(moved.appt).toBe(d.appt + 3600);
    expect(moved.arrive - moved.appt).toBeCloseTo(d.arrive - d.appt, 6);
  });

  it('夜班：人太少时建议加到开门前能补齐的人数（每一天都补齐），人够时可能建议减', () => {
    const short: BackroomLab = { ...lab, nightCrew: 2, run: (adj, sd) => run({ nightCrew: 2, ...adj }, sd) };
    const sRuns = seeds.map((sd) => short.run({}, sd));
    const adv = adviseBackroom(short, sRuns).find((a) => a.code.startsWith('NIGHT_CREW'));
    expect(adv).toBeDefined();
    if (adv!.code === 'NIGHT_CREW_ADD') {
      const act = adv!.action as { kind: 'NIGHT_CREW'; from: number; to: number };
      expect(act.to).toBeGreaterThan(2);
      expect(short.run({ nightCrew: act.to }, 3).metrics.backlogCases).toBe(0);
    }
  });

  it('收银通道：排队论的等待随通道增加而减少、排不过来时是无穷大；计划不超过收银台数，停车场快满时提醒', () => {
    expect(erlangWaitMin(1, 0.4, 2)).toBe(Infinity);
    expect(erlangWaitMin(1, 0.4, 3)).toBeGreaterThan(erlangWaitMin(1, 0.4, 4));
    expect(erlangWaitMin(0, 0.4, 1)).toBe(0);
    const shoppers = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 22 ? (h === 17 ? 90 : 40) : 0));
    const parking = Array.from({ length: 24 }, (_, h) => (h === 12 ? 190 : 100));
    const out = adviseFront({ shoppersByHour: shoppers, parkingByHour: parking, parkingSpots: 200, floors: [{ floorId: 'F1', manual: 6, self: 4, share: 1 }], open: 7 * 3600, close: 22 * 3600 });
    const plan = out.find((a) => a.code === 'CHECKOUT_PLAN')!;
    const lanes = (plan.action as { kind: 'CHECKOUT_PLAN'; lanes: Array<{ byHour: number[] }> }).lanes[0]!.byHour;
    expect(Math.max(...lanes)).toBeLessThanOrEqual(6);
    expect(lanes[17]).toBeGreaterThan(lanes[9] as number);
    expect(lanes[3]).toBe(0);
    expect(out.some((a) => a.code === 'PARKING_PEAK' && a.params.fromHour === 12)).toBe(true);
  });

  it('暂存与风险：快满时按档位提醒（90% 紧急、80% 提醒）；等太久集中的小时加人有效时给出可采纳的动作', () => {
    const occ = (peak: number) => Array.from({ length: 600 }, (_, i) => (i > 280 && i < 320 ? peak : 0.3));
    const mk = (peak: number, wait: number, long: number): StagingRun => ({ t0: 7 * 3600, step: 60, occ: { AMBIENT: occ(0.3), CHILLED: occ(peak), FROZEN: occ(0.5) }, capacity: { AMBIENT: 100, CHILLED: 80, FROZEN: 60 }, avgWaitMin: wait, longWaitPct: long, lateOrderPct: 0, longWaitByHour: Array.from({ length: 24 }, (_, h) => (h === 12 ? 6 : 0)) });
    const fake: StagingLab = { seeds: [1, 2, 3], run: (staff) => (staff.length ? mk(0.8, 3, 2) : mk(0.93, 4, 6)) };
    const base = [mk(0.93, 4, 6), mk(0.92, 4, 6), mk(0.7, 4, 6)];
    const st = adviseStaging(fake, base);
    const chilled = st.find((a) => a.params.zone === 'CHILLED')!;
    expect(chilled.severity).toBe('critical');
    expect(chilled.action?.kind).toBe('STAFF');
    expect(chilled.recur).toEqual({ days: 2, of: 3 });
    expect(st.some((a) => a.params.zone === 'AMBIENT')).toBe(false);
    const risks = adviseRisks({ lateOrderPct: 0, longWaitPct: 6, avgWaitMin: 4, coldViolationPct: 0, maxColdMinutes: 0, coldAlerts: [], lateByHour: new Array(24).fill(0), forkliftWaits: [{ t: 30000, sec: 400 }], forklifts: 2, disruptions: [{ id: 'D1', kind: 'POWER_OUTAGE', start: 40000, end: 42000 }] }, fake, base);
    const lw = risks.find((a) => a.code === 'LONG_WAIT')!;
    expect(lw.params.hour).toBe(12);
    expect(lw.action).toEqual({ kind: 'STAFF', role: 'handoff', fromHour: 11, toHour: 14, delta: 1 });
    expect(risks.some((a) => a.code === 'FORKLIFT_WAIT')).toBe(true);
    expect(risks.find((a) => a.code === 'INCIDENT_POWER_OUTAGE')?.severity).toBe('critical');
  });
});
