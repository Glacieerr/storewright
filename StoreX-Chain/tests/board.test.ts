import { describe, expect, it } from 'vitest';
import { applyFix, autoFix, buildBoard, DOORS, type Board } from '../src/sim/board';
import { g1, g3, type ChainScenario } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, applyStanding, emptyDay, standingOf, type DayPlan } from '../src/sim/plan';
import type { Op } from '../src/sim/trace';

const DAY = 86;
function run(s: ChainScenario) {
  s.traceDay = DAY;
  return runChain(s);
}
function board(s: ChainScenario, ops: readonly Op[], day: DayPlan = emptyDay()): Board {
  return buildBoard(ops, day, { allocation: allocationHour(s), crossDock: s.dc.crossDock });
}

describe('调度台：当天的作业', () => {
  const s = g3(1);
  const r = run(s);
  const ops = r.trace?.ops ?? [];
  const b = board(s, ops);

  it('每趟配送、每辆进货车、班轮、航班都是一个作业，编号不重复、能找到对应的车辆', () => {
    const kinds = new Set(ops.map((o) => o.kind));
    for (const k of ['delivery', 'supplier', 'farm', 'vessel', 'flight', 'van']) expect(kinds.has(k as Op['kind']), k).toBe(true);
    expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
    for (const o of ops) {
      if (o.vehicle >= 0) expect(r.trace?.vehicles[o.vehicle]).toBeDefined();
      expect(o.t1).toBeGreaterThan(o.t0);
    }
    for (const o of ops.filter((x) => x.kind === 'delivery')) {
      expect(o.stops?.length).toBeGreaterThan(0);
      expect(o.depart).toBeGreaterThanOrEqual(2.5 * 3600 - 1);
      // 装车在分配（2 点）之后、出发之前
      expect((o.dock as [number, number])[0]).toBeGreaterThanOrEqual(2 * 3600 - 1);
      expect((o.dock as [number, number])[1]).toBeCloseTo(o.depart as number, 3);
      for (const st of o.stops ?? []) expect(st.start).toBeGreaterThanOrEqual(st.arrive - 1e-6);
    }
  });

  it('默认计划：每趟车都有月台门和车辆，同一樘门、同一辆车的时段不重叠', () => {
    for (const o of b.ops.filter((x) => x.kind === 'delivery')) {
      expect(o.door, o.id).toBeDefined();
      expect(o.unitId, o.id).toBeDefined();
    }
    for (const d of b.doors)
      for (let i = 1; i < d.bookings.length; i++) expect(d.bookings[i]!.t0).toBeGreaterThanOrEqual(d.bookings[i - 1]!.t1);
    expect(b.issues.filter((i) => i.code === 'door-conflict' || i.code === 'unit-busy')).toHaveLength(0);
    expect(b.kpi.doorPeak.cold).toBeLessThanOrEqual(DOORS.cold.length);
    expect(b.kpi.trips).toBe(ops.filter((o) => o.kind === 'delivery' || o.kind === 'bakery').length);
  });

  it('把两趟时间重叠的车指定到同一樘门：报月台门冲突，按修法改了就没有了', () => {
    // 上一代常温车下午一车接一车装，装车时段有重叠
    const s1 = g1(1);
    const ops1 = run(s1).trace?.ops ?? [];
    const b1 = board(s1, ops1);
    const loads = b1.ops.filter((o) => o.kind === 'delivery' && o.dock).sort((x, y) => (x.dock as number[])[0]! - (y.dock as number[])[0]!);
    let a: Op | undefined;
    let c: Op | undefined;
    for (const x of loads) {
      c = loads.find((o) => o !== x && (o.dock as number[])[0]! >= (x.dock as number[])[0]! && (o.dock as number[])[0]! < (x.dock as number[])[1]!);
      if (c) {
        a = x;
        break;
      }
    }
    expect(a && c).toBeDefined();
    const day = { ...emptyDay(), door: { [a!.id]: 'D20', [c!.id]: 'D20' } };
    const b2 = board(s1, ops1, day);
    const conflict = b2.issues.find((i) => i.code === 'door-conflict');
    expect(conflict?.fix?.kind).toBe('door');
    const b3 = board(s1, ops1, applyFix(day, conflict!.fix!));
    expect(b3.issues.filter((i) => i.code === 'door-conflict')).toHaveLength(0);
  });

  it('门店 4 个收货口：配送中心的车和长途直送车都排到口上，同一个口的时段不重叠', () => {
    const stops = b.ops.filter((o) => o.stops?.length).map((o) => ({ o, st: o.stops![0]!, k: o.docks?.[o.stops![0]!.key] }));
    expect(stops.some((x) => x.o.kind === 'direct')).toBe(true);
    for (const x of stops) {
      expect(x.k, x.o.id).toBeDefined();
      expect(x.k!).toBeLessThan(4);
    }
    for (let k = 0; k < 4; k++) {
      const on = stops.filter((x) => x.k === k).sort((p, q) => p.st.start - q.st.start);
      for (let i = 1; i < on.length; i++) if (b.issues.every((is) => is.code !== 'store-dock')) expect(on[i]!.st.start).toBeGreaterThanOrEqual(on[i - 1]!.st.end - 1);
    }
  });

  it('把两趟时间重叠的车派给同一辆车：报车辆还没回来，自动排程修好', () => {
    const trips = b.ops.filter((o) => o.kind === 'delivery' && o.unitId?.startsWith('M')).sort((x, y) => x.t0 - y.t0);
    const a = trips[0] as Op;
    const c = trips[1] as Op;
    const day = { ...emptyDay(), unit: { [a.id]: 'M01', [c.id]: 'M01' } };
    const b2 = board(s, ops, day);
    expect(b2.issues.some((i) => i.code === 'unit-busy')).toBe(true);
    const fixed = autoFix(b2, day);
    expect(board(s, ops, fixed.day).issues.filter((i) => i.code === 'unit-busy')).toHaveLength(0);
  });
});

describe('调度台：改计划要重新仿真', () => {
  it('常规计划原样写回，结果完全一样', () => {
    for (const make of [g1, g3]) {
      const a = run(make(2));
      const s = make(2);
      const b = run(applyStanding(s, standingOf(s)));
      expect(b.cost.total).toBe(a.cost.total);
      expect(b.store.service).toBe(a.store.service);
      expect(b.trace?.ops.length).toBe(a.trace?.ops.length);
    }
  });

  it('当天调度：只改动的那趟车换了出发时刻，别的车不变', () => {
    const base = run(g3(1)).trace?.ops ?? [];
    const target = base.find((o) => o.kind === 'delivery' && o.id === 'M05') as Op;
    const hour = (target.depart as number) / 3600 + 1;
    const s = g3(1);
    s.plan = { depart: { M05: hour } };
    const moved = run(s).trace?.ops ?? [];
    const after = moved.find((o) => o.id === 'M05') as Op;
    expect(after.depart! / 3600).toBeCloseTo(hour, 6);
    expect(after.planned).toBeCloseTo(target.planned as number, 6);
    expect(after.stops![0]!.arrive - target.stops![0]!.arrive).toBeGreaterThan(0);
    const other = (id: string, list: readonly Op[]) => list.find((o) => o.id === id)?.depart;
    for (const o of base.filter((x) => x.kind === 'delivery' && x.id !== 'M05')) expect(other(o.id, moved)).toBe(o.depart);
  });

  it('门店收货时段：开门前到的车在门外等，过了截止算迟到', () => {
    const s = g3(1);
    const st = (run(g3(1)).trace?.ops ?? []).find((o) => o.kind === 'delivery')!.stops![0]!;
    const open = Math.ceil(st.arrive / 3600) + 1;
    s.store.windows = { [st.key]: [open, open + 0.5] };
    // 长途直送车按自己的收货时段（flow.window），这里只看配送中心的车
    const after = (run(s).trace?.ops ?? []).filter((o) => o.kind === 'delivery').flatMap((o) => o.stops ?? []).filter((x) => x.key === st.key);
    expect(after.length).toBeGreaterThan(0);
    for (const x of after) {
      expect(x.start).toBeGreaterThanOrEqual(open * 3600 - 1e-6);
      expect(x.onTime).toBe(x.start <= (open + 0.5) * 3600 + 1e-6);
    }
  });

  it('全链路的区域生鲜集货改到 3 点（赶不上 2 点的越库分配）：生鲜到店更老，调度台提示赶不上分配', () => {
    const base = run(g3(1));
    const s = g3(1);
    const p = standingOf(s);
    p.farm = 3;
    const late = run(applyStanding(s, p));
    expect(late.store.freshAgeDays).toBeGreaterThan(base.store.freshAgeDays);
    const b = board(s, late.trace?.ops ?? []);
    expect(b.issues.some((i) => i.code === 'cutoff' && i.ops.some((id) => id.startsWith('FR')))).toBe(true);
  });
});
