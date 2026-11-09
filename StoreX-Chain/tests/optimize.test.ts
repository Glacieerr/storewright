import { describe, expect, it } from 'vitest';
import { buildBoard, DOORS, type Board } from '../src/sim/board';
import { g1, g3, withLoad, type ChainScenario } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, emptyDay, type DayPlan } from '../src/sim/plan';
import { setFacilities } from '../src/facility/state';
import { defaultFacilities } from '../src/facility/config';
import { assignDoors, chainClass, DEFAULT_OPTIONS, DOOR_GAP, doorScore, doorStatsOf, minShift, solveDoors, solveFleet, solveReplen, sourceOps, TURN, type AJob, type PJob, type TripRow } from '../src/sim/optimize';

const DAY = 86;
function dayBoard(s: ChainScenario): { board: Board; ops: ReturnType<typeof sourceOps>; s: ChainScenario; demand: Record<string, number> } {
  s.traceDay = DAY;
  const r = runChain(s);
  const ops = r.trace?.ops ?? [];
  return { board: buildBoard(ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock }), ops, s, demand: r.trace?.storeDemand ?? {} };
}
/** 可重复的小随机数 */
function rng(seed: number): () => number {
  let x = seed * 9301 + 49297;
  return () => ((x = (x * 9301 + 49297) % 233280) / 233280);
}

describe('求解：月台门挪多少（和穷举比）', () => {
  it('小规模的随机例子：分支定界的最少挪动和穷举所有挪法的结果一样', () => {
    const r = rng(7);
    for (let n = 0; n < 40; n++) {
      const D = 1 + Math.floor(r() * 2);
      const jobs: PJob[] = Array.from({ length: 5 }, (_, k) => {
        const s = Math.round((r() * 6 * 3600) / 300) * 300;
        const inbound = r() < 0.6;
        return { key: String(k), inbound, s, len: 1800 + Math.round(r() * 4) * 900, lo: inbound ? s : s - 4 * 300, hi: inbound ? s + 6 * 300 : s, fixed: false };
      });
      // 穷举：每个作业在自己的范围里按 5 分钟一挡挪
      const opts = jobs.map((j) => {
        const out: number[] = [];
        for (let a = j.lo; a <= j.hi; a += 300) out.push(a);
        return out;
      });
      let best = Infinity;
      const pick: number[] = [];
      const ok = () => {
        const iv = jobs.map((j, k) => [pick[k] as number, (pick[k] as number) + j.len] as const);
        for (const [a] of iv) if (iv.filter(([x, y]) => x <= a && a < y).length > D) return false;
        return true;
      };
      const rec = (k: number) => {
        if (k === jobs.length) {
          if (ok()) best = Math.min(best, jobs.reduce((s, j, i) => s + Math.abs((pick[i] as number) - j.s), 0));
          return;
        }
        for (const a of opts[k] as number[]) {
          pick[k] = a;
          rec(k + 1);
        }
      };
      rec(0);
      const got = minShift(jobs, D, undefined, 1e7);
      expect(got.optimal || !Number.isFinite(best)).toBe(true);
      expect(got.cost).toBe(best);
    }
  });

  it('小规模的随机例子：排到具体门上的收发门错用、用到的门和穷举一样', () => {
    const r = rng(11);
    for (let n = 0; n < 40; n++) {
      const nDoors = 2 + Math.floor(r() * 2);
      const R = 1;
      const jobs: AJob[] = Array.from({ length: 6 }, (_, k) => {
        const a = Math.round((r() * 5 * 3600) / 300) * 300;
        return { key: String(k), inbound: r() < 0.5, a, b: a + 1800 + Math.round(r() * 3) * 900 + DOOR_GAP };
      });
      let best = Infinity;
      const doorOf: number[] = [];
      const rec = (k: number) => {
        if (k === jobs.length) {
          for (let d = 0; d < nDoors; d++) {
            const on = jobs.filter((_, i) => doorOf[i] === d);
            for (const x of on) for (const y of on) if (x !== y && x.a < y.b && y.a < x.b) return;
          }
          const mis = jobs.filter((j, i) => (j.inbound ? (doorOf[i] as number) >= R : (doorOf[i] as number) < R)).length;
          best = Math.min(best, mis * 1000 + new Set(doorOf).size);
          return;
        }
        for (let d = 0; d < nDoors; d++) {
          doorOf[k] = d;
          rec(k + 1);
        }
      };
      rec(0);
      const got = assignDoors(jobs, nDoors, R, true);
      if (!Number.isFinite(best)) expect(got).toBeUndefined();
      else expect((got?.mismatches ?? 0) * 1000 + (got?.used ?? 0)).toBe(best);
    }
  });
});

describe('求解：月台门（真实的一天）', () => {
  it('默认设施：自动排已经最优，求解不改当天调度', () => {
    for (const load of ['normal', 'extreme'] as const) {
      const { board, s } = dayBoard(withLoad(g3(1), load));
      const day = emptyDay();
      const sol = solveDoors(board, day, allocationHour(s));
      expect(sol.groups.every((g) => g.optimal)).toBe(true);
      expect(doorScore(sol.stats)).toBe(doorScore(sol.baseline));
      expect(sol.day).toEqual(day);
      expect(sol.ms).toBeLessThan(2000);
    }
  });

  it('门少的时候：求解不比自动排差，同一樘门前后两车留够 5 分钟，落到调度台以后也不比原来差', () => {
    const f = defaultFacilities();
    f.dc.coldDoors = 3;
    f.dc.dryDoors = 4;
    setFacilities(f);
    try {
      for (const s of [withLoad(g3(1), 'extreme'), withLoad(g1(1), 'high')]) {
        const { board } = dayBoard(s);
        const sol = solveDoors(board, emptyDay(), allocationHour(s));
        expect(doorScore(sol.stats)).toBeLessThanOrEqual(doorScore(sol.baseline));
        expect(doorScore(sol.realized)).toBeLessThanOrEqual(doorScore(sol.baseline));
        for (const g of sol.groups) {
          // 门不够、排不开的那一组保留调度台的排法
          if (g.overflow) {
            expect(g.stats).toEqual(doorStatsOf(board, g.group));
            continue;
          }
          expect(g.stats.waitMin + g.stats.preloadMin).toBeGreaterThanOrEqual(g.lowerBoundMin);
          for (const d of DOORS[g.group]) {
            const on = g.placements.filter((p) => p.door === d).sort((a, b) => a.t0 - b.t0);
            for (let i = 1; i < on.length; i++) expect((on[i] as { t0: number }).t0).toBeGreaterThanOrEqual((on[i - 1] as { t1: number }).t1 + DOOR_GAP - 1);
          }
        }
        // 落到当天调度上：调度台按指定门重排，结果就是报的那样
        const again = buildBoard(sourceOps(board), sol.day, { allocation: allocationHour(s), crossDock: s.dc.crossDock });
        expect(doorStatsOf(again)).toEqual(sol.realized);
      }
    } finally {
      setFacilities(defaultFacilities());
    }
  });
});

describe('求解：车辆接趟', () => {
  it('小规模的随机例子：分支定界和穷举所有分法的结果一样（用车 → 接力 → 空等）', () => {
    const r = rng(5);
    const opts = { ...DEFAULT_OPTIONS, maxDutyHours: 9, evRangeKm: 160, evChargeKmPerHour: 60 };
    for (let n = 0; n < 30; n++) {
      const trips: TripRow[] = Array.from({ length: 6 }, (_, k) => {
        const t0 = Math.round((r() * 14 * 3600) / 300) * 300;
        return { id: `T${k}`, cls: 'ev' as const, t0, t1: t0 + 3600 + Math.round(r() * 8) * 900, km: 30 + Math.round(r() * 60) };
      }).sort((a, b) => a.t0 - b.t0);
      // 穷举：每趟车放进已有的车里或者开一辆新车（集合划分）
      const score = (groups: TripRow[][]) => {
        let relays = 0;
        let idle = 0;
        for (const g of groups) {
          g.sort((a, b) => a.t0 - b.t0);
          let soc = opts.evRangeKm;
          for (let i = 0; i < g.length; i++) {
            const t = g[i] as TripRow;
            if (i > 0) {
              const p = g[i - 1] as TripRow;
              if (p.t1 + TURN > t.t0) return Infinity;
              soc = Math.min(opts.evRangeKm, soc + ((t.t0 - p.t1) / 3600) * opts.evChargeKmPerHour);
              idle += t.t0 - p.t1;
            }
            if (soc - t.km < opts.evRangeKm * 0.1) return Infinity;
            soc -= t.km;
          }
          const span = (g[g.length - 1] as TripRow).t1 - (g[0] as TripRow).t0;
          relays += Math.max(0, Math.ceil(span / (opts.maxDutyHours * 3600) - 1e-9) - 1);
        }
        return groups.length * 1e9 + relays * 1e6 + idle;
      };
      let best = Infinity;
      const groups: TripRow[][] = [];
      const rec = (k: number) => {
        if (k === trips.length) {
          best = Math.min(best, score(groups.map((g) => [...g])));
          return;
        }
        const t = trips[k] as TripRow;
        for (const g of groups) {
          g.push(t);
          rec(k + 1);
          g.pop();
        }
        groups.push([t]);
        rec(k + 1);
        groups.pop();
      };
      rec(0);
      const got = chainClass(trips, 'ev', opts, Infinity, 1e7);
      expect(got.optimal).toBe(true);
      expect(score(got.groups.map((g) => g.map((i) => trips[i] as TripRow)))).toBe(best);
    }
  });

  it('真实的一天：每辆车回场 30 分钟后才接下一趟，按求解结果指定车以后调度台没有冲突', () => {
    for (const s of [withLoad(g3(1), 'extreme'), withLoad(g1(1), 'extreme')]) {
      const { board } = dayBoard(s);
      const sol = solveFleet(board, emptyDay(), allocationHour(s));
      expect(sol.stats.units).toBeGreaterThanOrEqual(sol.lowerBound);
      expect(sol.stats.units).toBeLessThanOrEqual(sol.baseline.units);
      for (const c of sol.chains) {
        const ts = c.trips.map((id) => board.ops.find((o) => o.id === id) as Board['ops'][number]).sort((a, b) => a.t0 - b.t0);
        for (let i = 1; i < ts.length; i++) expect((ts[i] as { t0: number }).t0).toBeGreaterThanOrEqual((ts[i - 1] as { t1: number }).t1 + TURN);
      }
      const day: DayPlan = sol.day;
      const again = buildBoard(sourceOps(board), day, { allocation: allocationHour(s), crossDock: s.dc.crossDock });
      expect(again.issues.filter((i) => i.code === 'unit-busy')).toEqual([]);
      if (Object.keys(day.unit).length) expect(again.units.length).toBe(sol.stats.units);
    }
  });
});

describe('求解：门店补货', () => {
  const { demand, s } = dayBoard(g3(1));
  const sol = solveReplen('g3', demand, s.flow.direct);

  it('订满时不多占货架和后仓，合计成本不高于现在的规则，同样的输入结果一样', () => {
    expect(sol.rows.length).toBeGreaterThan(5);
    expect(sol.usedOpt).toBeLessThanOrEqual(sol.capacity + 0.05 * sol.rows.length);
    expect(sol.totalOpt).toBeLessThanOrEqual(sol.totalCur + 1e-6);
    for (const r of sol.rows) expect(r.optCost.total).toBeLessThan(r.curCost.total + 50);
    expect(solveReplen('g3', demand, s.flow.direct)).toEqual({ ...sol, ms: expect.any(Number) });
  });

  it('换一组随机需求核对：求出的做法照样比现在省', () => {
    expect(sol.checkOpt).toBeLessThan(sol.checkCur);
  });

  it('直送门店的商品族不在这里算', () => {
    for (const k of s.flow.direct) expect(sol.rows.some((r) => r.key === k)).toBe(false);
  });
});
