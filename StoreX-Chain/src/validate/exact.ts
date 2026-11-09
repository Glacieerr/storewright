import { Distances } from '../network/graph';
import { DEFAULT_PARAMS, type NetParams } from '../network/model';
import { bruteForce, buildInstance, solve } from '../network/solve';
import { networkSites } from '../network/sites';
import { setRegion } from '../region/network';
import { DEFAULT_REGION, regionSpecFrom } from '../region/regionGen';
import { assignDoors, chainClass, DEFAULT_OPTIONS, DOOR_GAP, minShift, TURN, type AJob, type PJob, type TripRow } from '../sim/optimize';
import { mulberry32 } from './rng';

/**
 * 调度台的三个求解器和多门店网络规划，都声称「精确最优」：这里在小规模的随机例子上和穷举所有可能的结果比，
 * 统计一致的比例和用时（单元测试 tests/optimize.test.ts、tests/network.test.ts 里有同样的检查，这里放大到几百个例子并计时）。
 *
 * Exactness check of the solvers that claim optimality: branch-and-bound / DP vs exhaustive enumeration on random small instances.
 */
export interface ExactRow {
  key: string;
  label: string;
  labelEn: string;
  instances: number;
  /** 和穷举一致的例子数 */
  matched: number;
  /** 不一致、但求解器自己标了「不保证最优」的例子数 */
  flagged: number;
  /** 不一致、求解器却声称最优的例子数（应该是 0） */
  wrong: number;
  /** 求解器、穷举的总用时（毫秒） */
  solverMs: number;
  bruteMs: number;
}

const now = () => performance.now();

/** 月台门「挪多少」（minShift）：5 个作业、1–2 樘门 */
function doorsShift(n: number, seed: number): ExactRow {
  const r = mulberry32(seed);
  let matched = 0;
  let flagged = 0;
  let wrong = 0;
  let sm = 0;
  let bm = 0;
  for (let k = 0; k < n; k++) {
    const D = 1 + Math.floor(r() * 2);
    const jobs: PJob[] = Array.from({ length: 5 }, (_, i) => {
      const s = Math.round((r() * 6 * 3600) / 300) * 300;
      const inbound = r() < 0.6;
      return { key: String(i), inbound, s, len: 1800 + Math.round(r() * 4) * 900, lo: inbound ? s : s - 4 * 300, hi: inbound ? s + 6 * 300 : s, fixed: false };
    });
    let t = now();
    let best = Infinity;
    const pick: number[] = [];
    const ok = () => {
      const iv = jobs.map((j, i) => [pick[i] as number, (pick[i] as number) + j.len] as const);
      for (const [a] of iv) if (iv.filter(([x, y]) => x <= a && a < y).length > D) return false;
      return true;
    };
    const rec = (i: number) => {
      if (i === jobs.length) {
        if (ok()) best = Math.min(best, jobs.reduce((s, j, q) => s + Math.abs((pick[q] as number) - j.s), 0));
        return;
      }
      const j = jobs[i] as PJob;
      for (let a = j.lo; a <= j.hi; a += 300) {
        pick[i] = a;
        rec(i + 1);
      }
    };
    rec(0);
    bm += now() - t;
    t = now();
    const got = minShift(jobs, D, undefined, 1e7);
    sm += now() - t;
    if (got.cost === best && (got.optimal || !Number.isFinite(best))) matched++;
    else if (!got.optimal) flagged++;
    else wrong++;
  }
  return { key: 'doors-shift', label: '月台门：排队和提前装车最少（分支定界）', labelEn: 'Dock doors: least queueing and pre-loading (branch and bound)', instances: n, matched, flagged, wrong, solverMs: sm, bruteMs: bm };
}

/** 月台门「排到哪樘门」（assignDoors）：6 个作业、2–3 樘门 */
function doorsAssign(n: number, seed: number): ExactRow {
  const r = mulberry32(seed);
  let matched = 0;
  let flagged = 0;
  let wrong = 0;
  let sm = 0;
  let bm = 0;
  for (let k = 0; k < n; k++) {
    const nDoors = 2 + Math.floor(r() * 2);
    const R = 1;
    const jobs: AJob[] = Array.from({ length: 6 }, (_, i) => {
      const a = Math.round((r() * 5 * 3600) / 300) * 300;
      return { key: String(i), inbound: r() < 0.5, a, b: a + 1800 + Math.round(r() * 3) * 900 + DOOR_GAP };
    });
    let t = now();
    let best = Infinity;
    const doorOf: number[] = [];
    const rec = (i: number) => {
      if (i === jobs.length) {
        for (let d = 0; d < nDoors; d++) {
          const on = jobs.filter((_, q) => doorOf[q] === d);
          for (const x of on) for (const y of on) if (x !== y && x.a < y.b && y.a < x.b) return;
        }
        const mis = jobs.filter((j, q) => (j.inbound ? (doorOf[q] as number) >= R : (doorOf[q] as number) < R)).length;
        best = Math.min(best, mis * 1000 + new Set(doorOf).size);
        return;
      }
      for (let d = 0; d < nDoors; d++) {
        doorOf[i] = d;
        rec(i + 1);
      }
    };
    rec(0);
    bm += now() - t;
    t = now();
    const got = assignDoors(jobs, nDoors, R, true);
    sm += now() - t;
    const score = got ? got.mismatches * 1000 + got.used : Infinity;
    if (score === best) matched++;
    else if (got && !got.exact) flagged++;
    else wrong++;
  }
  return { key: 'doors-assign', label: '月台门：收发门错用和用门最少（带记忆的搜索）', labelEn: 'Dock doors: fewest role mismatches and doors used (memoised search)', instances: n, matched, flagged, wrong, solverMs: sm, bruteMs: bm };
}

/** 车辆接趟（chainClass）：6 趟电动车，续航和充电约束、司机工时 */
function fleet(n: number, seed: number): ExactRow {
  const r = mulberry32(seed);
  const opts = { ...DEFAULT_OPTIONS, maxDutyHours: 9, evRangeKm: 160, evChargeKmPerHour: 60 };
  let matched = 0;
  let flagged = 0;
  let wrong = 0;
  let sm = 0;
  let bm = 0;
  const score = (groups: TripRow[][]) => {
    let relays = 0;
    let idle = 0;
    for (const g of groups) {
      g.sort((a, b) => a.t0 - b.t0);
      let soc = opts.evRangeKm;
      for (let i = 0; i < g.length; i++) {
        const tr = g[i] as TripRow;
        if (i > 0) {
          const p = g[i - 1] as TripRow;
          if (p.t1 + TURN > tr.t0) return Infinity;
          soc = Math.min(opts.evRangeKm, soc + ((tr.t0 - p.t1) / 3600) * opts.evChargeKmPerHour);
          idle += tr.t0 - p.t1;
        }
        if (soc - tr.km < opts.evRangeKm * 0.1) return Infinity;
        soc -= tr.km;
      }
      const span = (g[g.length - 1] as TripRow).t1 - (g[0] as TripRow).t0;
      relays += Math.max(0, Math.ceil(span / (opts.maxDutyHours * 3600) - 1e-9) - 1);
    }
    return groups.length * 1e9 + relays * 1e6 + idle;
  };
  for (let k = 0; k < n; k++) {
    const trips: TripRow[] = Array.from({ length: 6 }, (_, i) => {
      const t0 = Math.round((r() * 14 * 3600) / 300) * 300;
      return { id: `T${i}`, cls: 'ev' as const, t0, t1: t0 + 3600 + Math.round(r() * 8) * 900, km: 30 + Math.round(r() * 60) };
    }).sort((a, b) => a.t0 - b.t0);
    let t = now();
    let best = Infinity;
    const groups: TripRow[][] = [];
    const rec = (i: number) => {
      if (i === trips.length) {
        best = Math.min(best, score(groups.map((g) => [...g])));
        return;
      }
      const tr = trips[i] as TripRow;
      for (const g of groups) {
        g.push(tr);
        rec(i + 1);
        g.pop();
      }
      groups.push([tr]);
      rec(i + 1);
      groups.pop();
    };
    rec(0);
    bm += now() - t;
    t = now();
    const got = chainClass(trips, 'ev', opts, Infinity, 1e7);
    sm += now() - t;
    const same = score(got.groups.map((g) => g.map((i) => trips[i] as TripRow))) === best;
    if (same && got.optimal) matched++;
    else if (!got.optimal) flagged++;
    else wrong++;
  }
  return { key: 'fleet', label: '车辆接趟：用车、接力、空等最少（分支定界）', labelEn: 'Vehicle chaining: fewest vehicles, relays, idle time (branch and bound)', instances: n, matched, flagged, wrong, solverMs: sm, bruteMs: bm };
}

/** 多门店网络：开哪些仓、每家店归哪个仓（分支定界）和穷举比；几个区域 × 几组参数 */
function network(): ExactRow {
  let n = 0;
  let matched = 0;
  let wrong = 0;
  let sm = 0;
  let bm = 0;
  const params: NetParams[] = [
    { ...DEFAULT_PARAMS, growth: 1, freight: 1, allowExpand: true },
    { ...DEFAULT_PARAMS, growth: 1.6, freight: 1, allowExpand: false },
    { ...DEFAULT_PARAMS, growth: 2, freight: 1.5, allowExpand: true },
  ];
  try {
    for (const region of ['default', 'random-3', 'random-11', 'random-21']) {
      setRegion(region === 'default' ? DEFAULT_REGION : regionSpecFrom(region));
      const d = new Distances();
      const { stores, sites } = networkSites(d.g, { outerKm: 60 });
      for (const p of params)
        for (const k of [5, 6, 7]) {
          const inst = buildInstance(d, stores.slice(0, k), sites.slice(0, 4), p);
          let t = now();
          const a = solve(inst).objective;
          sm += now() - t;
          t = now();
          const b = bruteForce(inst).objective;
          bm += now() - t;
          n++;
          if (Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))) matched++;
          else wrong++;
        }
    }
  } finally {
    setRegion(DEFAULT_REGION);
  }
  return { key: 'network', label: '多门店网络：开仓和分配（分支定界）', labelEn: 'Multi-store network: site opening and assignment (branch and bound)', instances: n, matched, flagged: 0, wrong, solverMs: sm, bruteMs: bm };
}

export function exactRows(scale = 1): ExactRow[] {
  return [doorsShift(Math.round(200 * scale), 101), doorsAssign(Math.round(200 * scale), 202), fleet(Math.round(150 * scale), 303), network()];
}
