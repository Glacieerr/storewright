import { planRoutes, routeKm, type Job } from '../sim/routing';

/**
 * 配送线路的对照验证：仿真用的节约法（Clarke–Wright，src/sim/routing.ts）和同一个例子的精确最优解比，
 * 再和最近邻贪心（常见的简单做法）比。例子是随机的（种子固定），距离按 TSPLIB 的 EUC_2D 取整，
 * 所以最优值是整数，可以写成 CVRPLIB 格式的文件（toVrp / toSol），任何别的求解器都能读来核对。
 *
 * 精确解：先对每个「车能装下、停靠点不超限」的客户子集用 Held–Karp 动态规划求单车最短回路，再对全部客户做集合划分动态规划。
 * 客户数 n ≤ 12 时几十毫秒内求完。
 *
 * Routing validation: the simulator's Clarke–Wright savings heuristic vs the exact optimum
 * (Held–Karp per feasible subset + set-partition DP) and vs a nearest-neighbour baseline.
 */
export interface CvrpInstance {
  name: string;
  /** 坐标：第 0 个是配送中心 */
  xy: [number, number][];
  /** 每个点的需求（托盘）；第 0 个是 0 */
  demand: number[];
  capacity: number;
  /** 一车最多停几家（Infinity = 不限，就是标准的 CVRP） */
  maxStops: number;
}

export interface CvrpSolution {
  routes: number[][];
  cost: number;
}

/** TSPLIB 的 EUC_2D：欧氏距离四舍五入取整 */
export const nint = (x: number): number => Math.floor(x + 0.5);
export function distMatrix(inst: CvrpInstance): number[][] {
  return inst.xy.map(([x1, y1]) => inst.xy.map(([x2, y2]) => nint(Math.hypot(x1 - x2, y1 - y2))));
}

export function routeCost(d: number[][], r: readonly number[]): number {
  let c = 0;
  let at = 0;
  for (const v of r) {
    c += (d[at] as number[])[v] as number;
    at = v;
  }
  return c + ((d[at] as number[])[0] as number);
}

/** 随机例子：坐标 0–100 的整数，需求 1–maxDemand */
export function randomInstance(rng: () => number, n: number, capacity: number, maxStops: number, maxDemand: number, name: string): CvrpInstance {
  const xy: [number, number][] = [[50, 50]];
  const demand = [0];
  for (let i = 0; i < n; i++) {
    xy.push([Math.floor(rng() * 101), Math.floor(rng() * 101)]);
    demand.push(1 + Math.floor(rng() * maxDemand));
  }
  return { name, xy, demand, capacity, maxStops };
}

/** 精确最优（n ≤ 14 才算得动） */
export function solveExact(inst: CvrpInstance): CvrpSolution {
  const n = inst.xy.length - 1;
  if (n > 14) throw new Error('solveExact: too many customers');
  const d = distMatrix(inst);
  const full = 1 << n;
  // Held–Karp：hk[mask * n + j] = 从配送中心出发、走完 mask、停在 j 的最短路
  const hk = new Float64Array(full * n).fill(Infinity);
  const par = new Int16Array(full * n).fill(-1);
  for (let j = 0; j < n; j++) hk[(1 << j) * n + j] = (d[0] as number[])[j + 1] as number;
  for (let mask = 1; mask < full; mask++)
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = hk[mask * n + j] as number;
      if (!Number.isFinite(cur)) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k);
        const v = cur + ((d[j + 1] as number[])[k + 1] as number);
        if (v < (hk[nm * n + k] as number)) {
          hk[nm * n + k] = v;
          par[nm * n + k] = j;
        }
      }
    }
  const load = new Int32Array(full);
  const size = new Int8Array(full);
  for (let mask = 1; mask < full; mask++) {
    const low = mask & -mask;
    const j = 31 - Math.clz32(low);
    load[mask] = (load[mask ^ low] as number) + (inst.demand[j + 1] as number);
    size[mask] = (size[mask ^ low] as number) + 1;
  }
  const cost = new Float64Array(full).fill(Infinity);
  const last = new Int16Array(full).fill(-1);
  for (let mask = 1; mask < full; mask++) {
    if ((load[mask] as number) > inst.capacity || (size[mask] as number) > inst.maxStops) continue;
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      const v = (hk[mask * n + j] as number) + ((d[j + 1] as number[])[0] as number);
      if (v < (cost[mask] as number)) {
        cost[mask] = v;
        last[mask] = j;
      }
    }
  }
  // 集合划分：f[S] = 最小的 cost(T) + f[S \ T]，T 含 S 里编号最小的客户
  const f = new Float64Array(full).fill(Infinity);
  const pick = new Int32Array(full);
  f[0] = 0;
  for (let S = 1; S < full; S++) {
    const low = S & -S;
    const rest = S ^ low;
    // 枚举 rest 的子集 sub，T = sub | low
    for (let sub = rest; ; sub = (sub - 1) & rest) {
      const T = sub | low;
      const c = cost[T] as number;
      if (Number.isFinite(c)) {
        const v = c + (f[S ^ T] as number);
        if (v < (f[S] as number)) {
          f[S] = v;
          pick[S] = T;
        }
      }
      if (sub === 0) break;
    }
  }
  // 还原线路
  const routes: number[][] = [];
  let S = full - 1;
  while (S) {
    const T = pick[S] as number;
    const order: number[] = [];
    let mask = T;
    let j = last[T] as number;
    while (j >= 0) {
      order.push(j + 1);
      const pj = par[mask * n + j] as number;
      mask ^= 1 << j;
      j = pj;
    }
    routes.push(order.reverse());
    S ^= T;
  }
  return { routes, cost: f[full - 1] as number };
}

/** 仿真用的节约法（直接调 src/sim/routing.ts 的 planRoutes） */
export function solveSavings(inst: CvrpInstance): CvrpSolution {
  const d = distMatrix(inst);
  const id = (i: number) => (i === 0 ? 'DC' : `c${String(i).padStart(2, '0')}`);
  const idx = (s: string) => (s === 'DC' ? 0 : Number(s.slice(1)));
  const dist = (a: string, b: string) => (d[idx(a)] as number[])[idx(b)] as number;
  const jobs: Job[] = inst.demand.slice(1).map((p, i) => ({ store: id(i + 1), pallets: p }));
  const rs = planRoutes(jobs, inst.capacity, inst.maxStops, dist, 'DC');
  return { routes: rs.map((r) => r.stops.map((s) => idx(s.store))), cost: rs.reduce((s, r) => s + routeKm(r, dist, 'DC'), 0) };
}

/** 最近邻贪心：从配送中心出发，每次去最近的、还装得下的客户；装不下了回中心再开一车 */
export function solveNearest(inst: CvrpInstance): CvrpSolution {
  const d = distMatrix(inst);
  const n = inst.xy.length - 1;
  const left = new Set(Array.from({ length: n }, (_, i) => i + 1));
  const routes: number[][] = [];
  while (left.size) {
    const r: number[] = [];
    let at = 0;
    let load = 0;
    for (;;) {
      let best = -1;
      for (const v of left) {
        if (load + (inst.demand[v] as number) > inst.capacity || r.length >= inst.maxStops) continue;
        if (best < 0 || ((d[at] as number[])[v] as number) < ((d[at] as number[])[best] as number) || (((d[at] as number[])[v] as number) === ((d[at] as number[])[best] as number) && v < best)) best = v;
      }
      if (best < 0) break;
      r.push(best);
      left.delete(best);
      load += inst.demand[best] as number;
      at = best;
    }
    routes.push(r);
  }
  return { routes, cost: routes.reduce((s, r) => s + routeCost(d, r), 0) };
}

/** 检查一个解：每个客户恰好一次、不超载、不超停靠点数，费用对得上 */
export function checkSolution(inst: CvrpInstance, sol: CvrpSolution): string[] {
  const d = distMatrix(inst);
  const errs: string[] = [];
  const seen = new Map<number, number>();
  for (const r of sol.routes) {
    for (const v of r) seen.set(v, (seen.get(v) ?? 0) + 1);
    const load = r.reduce((s, v) => s + (inst.demand[v] as number), 0);
    if (load > inst.capacity) errs.push(`route overload ${load} > ${inst.capacity}`);
    if (r.length > inst.maxStops) errs.push(`route has ${r.length} stops > ${inst.maxStops}`);
  }
  for (let v = 1; v < inst.xy.length; v++) if (seen.get(v) !== 1) errs.push(`customer ${v} visited ${seen.get(v) ?? 0} times`);
  const c = sol.routes.reduce((s, r) => s + routeCost(d, r), 0);
  if (c !== sol.cost) errs.push(`cost ${sol.cost} != recomputed ${c}`);
  return errs;
}

/** CVRPLIB / TSPLIB 格式的例子文件（标准 CVRP，没有停靠点上限） */
export function toVrp(inst: CvrpInstance, comment: string): string {
  const L = [`NAME : ${inst.name}`, `COMMENT : ${comment}`, 'TYPE : CVRP', `DIMENSION : ${inst.xy.length}`, 'EDGE_WEIGHT_TYPE : EUC_2D', `CAPACITY : ${inst.capacity}`, 'NODE_COORD_SECTION'];
  inst.xy.forEach(([x, y], i) => L.push(`${i + 1} ${x} ${y}`));
  L.push('DEMAND_SECTION');
  inst.demand.forEach((q, i) => L.push(`${i + 1} ${q}`));
  L.push('DEPOT_SECTION', '1', '-1', 'EOF');
  return `${L.join('\n')}\n`;
}

/** CVRPLIB 的解文件：客户编号从 1 起（不含配送中心），最后一行 Cost */
export function toSol(sol: CvrpSolution): string {
  return `${sol.routes.map((r, i) => `Route #${i + 1}: ${r.join(' ')}`).join('\n')}\nCost ${sol.cost}\n`;
}

/** 读 CVRPLIB 的解文件（别的求解器的结果拿回来核对） */
export function parseSol(text: string): CvrpSolution {
  const routes: number[][] = [];
  let cost = NaN;
  for (const line of text.split(/\r?\n/)) {
    const m = /^Route\s*#\d+\s*:\s*(.*)$/i.exec(line.trim());
    if (m) routes.push((m[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number));
    const c = /^Cost\s+([\d.]+)/i.exec(line.trim());
    if (c) cost = Number(c[1]);
  }
  return { routes, cost };
}

/** 读 CVRPLIB 的例子文件（EUC_2D、一个配送中心；只认这里用到的几节） */
export function parseVrp(text: string): CvrpInstance {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let name = 'instance';
  let capacity = 0;
  let dim = 0;
  const xy: [number, number][] = [];
  const demand: number[] = [];
  let sec = '';
  let depot = 1;
  for (const l of lines) {
    if (!l || l === 'EOF') continue;
    const kv = /^([A-Z_]+)\s*:\s*(.*)$/.exec(l);
    if (kv) {
      const [, k, v] = kv as unknown as [string, string, string];
      if (k === 'NAME') name = v.trim();
      if (k === 'CAPACITY') capacity = Number(v);
      if (k === 'DIMENSION') dim = Number(v);
      if (k === 'EDGE_WEIGHT_TYPE' && v.trim() !== 'EUC_2D') throw new Error(`only EUC_2D is supported, got ${v}`);
      continue;
    }
    if (/^[A-Z_]+_SECTION$/.test(l)) {
      sec = l;
      continue;
    }
    const nums = l.split(/\s+/).map(Number);
    if (sec === 'NODE_COORD_SECTION') xy[(nums[0] as number) - 1] = [nums[1] as number, nums[2] as number];
    else if (sec === 'DEMAND_SECTION') demand[(nums[0] as number) - 1] = nums[1] as number;
    else if (sec === 'DEPOT_SECTION' && (nums[0] as number) > 0) depot = nums[0] as number;
  }
  if (depot !== 1) throw new Error('the depot must be node 1');
  if (xy.length !== dim || demand.length !== dim) throw new Error('DIMENSION does not match the sections');
  return { name, xy, demand, capacity, maxStops: Infinity };
}
