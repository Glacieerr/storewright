import { casesPerPallet, FAMILIES, type Family } from '../region/products';
import { buildBoard, DOORS, doorGroup, isFleet, RECEIVING_DOORS, UNIT_LABEL, UNIT_PREFIX, unitClass, type Board, type BoardOp, type DoorGroup, type UnitClass } from './board';
import { COSTS, scenarioFor, type Gen } from './config';
import { hhmm, type DayPlan } from './plan';
import type { Op } from './trace';

/**
 * 求解：把调度台上的三件事写成优化问题，求出最优解（或者证明离最优还差多少），再用大白话说明改了什么、省了什么。
 *
 * - 月台门：每个进货车（卸货）、配送车（装车）在门上的时段已知；门不够时进货车在场地排队（往后挪）、配送车提前装好（往前挪），
 *   都按 5 分钟一挡。目标依次是：挤门 + 排队 + 提前装车的分钟最少 → 收货门给进货车、发货门给配送车（错用最少）→ 用到的门最少。
 *   两步求解：先用分支定界求「挪多少」（门够用时直接是 0；求不到最优时用时间窗的能量下界给出最多还差多少），
 *   再把作业排到具体的门上：两类门各自够用时按编号小的先用就是最优；有一类不够时用区间贪心挪走最少的车；
 *   调度员指定了门时按时间分段、带记忆地搜索（同一类、此刻都空着的门是等价的，只试一樘）。
 *   落到调度台时只能指定门、不能指定排队到几点，所以再按调度台的规则重排、在几种指定方式里挑结果最好的；
 * - 车辆：同一辆车跑完一趟、回场 30 分钟以后才能跑下一趟，只能接同车型的车次；电动车按续航和充电速度检查电量；
 *   一辆车从第一趟出发到最后一趟回场超过司机最长工时，就要两位司机接力。目标依次是：用车最少 → 接力最少 → 司机空等最少，分支定界精确求解；
 * - 补货：门店每个商品族多久补一次、安全系数多大（订到多少），在货架和后仓的容量里让每天的持有、补货、缺货、报废成本合计最小
 *   （多选背包，按容量动态规划精确求解），再用一年的逐日模拟核对。
 *
 * 默认的排法不变：调度台照旧按「先到先排、编号小的门和车先用」自动排；这里只给出另一个方案，调度员点「采用」才写进当天调度
 * （月台门和车辆用调度台原有的「指定门 / 指定车」，不用重新仿真）。补货只给建议（门店的补货规则在仿真里，改了要重新仿真）。
 */

// —— 和调度台一致的规则（src/sim/board.ts） ——
/** 同一樘门前后两车之间留的时间、同一辆车回场以后再出车的间隔（秒） */
export const DOOR_GAP = 300;
export const TURN = 1800;
/** 挪动的一挡（秒）；进货车最多排队、配送车最多提前装车多久（秒） */
const STEP = 300;
const MAX_WAIT = 8 * 3600;
const MAX_PRELOAD = 4 * 3600;

export interface SolverOptions {
  /** 收货门优先给进货车、发货门优先给配送车 */
  rolePreference: boolean;
  /** 保留调度员已经指定的门和车 */
  keepFixed: boolean;
  /** 司机一个班最长几小时：一辆车从第一趟出发到最后一趟回场超过它，要两位司机接力 */
  maxDutyHours: number;
  /** 电动车充满一次能跑多少公里、在配送中心每小时能充多少公里（留 10% 电量不用） */
  evRangeKm: number;
  evChargeKmPerHour: number;
  /** 排班：加班工资是平时的几倍、每人每天最多加班几小时、在作业量之外留多少余量、每班最少几个人 */
  overtimeRate: number;
  maxOvertimeHours: number;
  reservePct: number;
  minPerShift: number;
  /** 排班：会影响仿真作业效率的岗位（物流园叉车司机和收货员、门店收货员、机场牵引车和拆板、港口闸口）不低于默认人数 */
  simNeutral: boolean;
  /** 补货：每个商品族每补一次的固定成本（美元：配送中心拣货准备、门店收货核对、单据）；货架和后仓最多比现在多用百分之几 */
  orderCost: number;
  extraSpacePct: number;
}
export const DEFAULT_OPTIONS: SolverOptions = {
  rolePreference: true,
  keepFixed: true,
  maxDutyHours: 11,
  evRangeKm: 250,
  evChargeKmPerHour: 120,
  overtimeRate: 1.5,
  maxOvertimeHours: 2,
  reservePct: 10,
  minPerShift: 1,
  simNeutral: true,
  orderCost: 3,
  extraSpacePct: 0,
};

const min = (s: number) => Math.round(s / 60);
const hm = (s: number) => hhmm(s / 3600);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 调度台的结果去掉排出来的字段，还原成仿真给的作业（重新排门排车时用） */
const BOARD_FIELDS = ['door', 'dockAt', 'yardWait', 'preload', 'docks', 'unitId', 'issues', 'moved'];
export function sourceOps(board: Board): Op[] {
  return board.ops.map((o) => {
    const op = { ...o } as Record<string, unknown>;
    for (const k of BOARD_FIELDS) delete op[k];
    return op as unknown as Op;
  });
}

/** 分配库存的时刻（当天的小时）→ 配送车最早几点能开始装车（秒） */
export const earliestLoadOf = (allocation: number): number => (allocation >= 12 ? allocation - 24 : allocation) * 3600;

// ———————————————————————— 月台门 ————————————————————————

export interface DoorJob {
  /** 在调度台作业里的下标（作业编号可能重复：同一天几趟空运冷藏车都叫 AT-1） */
  k: number;
  id: string;
  group: DoorGroup;
  inbound: boolean;
  /** 原定在门上的时段（秒） */
  s: number;
  e: number;
  /** 调度员在当天调度里指定的门 */
  fixed?: string;
}
export interface DoorPlacement {
  k: number;
  id: string;
  door: string;
  t0: number;
  t1: number;
  /** 往后挪（排队，正）或往前挪（提前装车，负）的秒数 */
  shift: number;
}
export interface DoorStats {
  /** 同一樘门上两车挤在一起的分钟（门全满时调度台只能硬塞） */
  overlapMin: number;
  waitMin: number;
  preloadMin: number;
  /** 进货车用了发货门、配送车用了收货门 */
  mismatches: number;
  /** 至少停过一辆车的门 */
  doorsUsed: number;
}
export interface DoorGroupResult {
  group: DoorGroup;
  doors: number;
  jobs: number;
  placements: DoorPlacement[];
  stats: DoorStats;
  /** 排队 + 提前装车的下界（分钟）：怎么排也少不了这么多 */
  lowerBoundMin: number;
  optimal: boolean;
  nodes: number;
  /** 门不够：最多排队 8 小时、提前 4 小时装车也排不开（或者没求出来），保留调度台的排法（有两车挤一樘门） */
  overflow?: boolean;
}
export interface DoorSolution {
  groups: DoorGroupResult[];
  stats: DoorStats;
  baseline: DoorStats;
  /** 落到调度台规则上的当天调度（指定门）、按它重排以后的指标 */
  day: DayPlan;
  realized: DoorStats;
  /** 开门曲线：每组开几樘门 → 最少排队 + 提前装车的分钟（optimal = 搜完了） */
  curve: { group: DoorGroup; doors: number; minutes: number; optimal: boolean }[];
  changes: string[];
  ms: number;
}

export function doorJobs(board: Board, day?: DayPlan): DoorJob[] {
  const out: DoorJob[] = [];
  board.ops.forEach((o, k) => {
    const g = doorGroup(o);
    if (!g || !o.dock) return;
    const f = day?.door[o.id];
    out.push({ k, id: o.id, group: g, inbound: o.kind !== 'delivery', s: o.dock[0], e: o.dock[1], ...(f && DOORS[g].includes(f) ? { fixed: f } : {}) });
  });
  return out;
}

/** 调度台排出来的结果：排队、提前装车、收发门错用、用到的门 */
export function doorStatsOf(board: Board, group?: DoorGroup): DoorStats {
  let wait = 0;
  let pre = 0;
  let mis = 0;
  const byDoor = new Map<string, [number, number][]>();
  for (const o of board.ops) {
    const g = doorGroup(o);
    if (!o.door || !g || (group && g !== group)) continue;
    const recv = DOORS[g].indexOf(o.door) < RECEIVING_DOORS[g];
    if (o.dockAt) byDoor.set(o.door, [...(byDoor.get(o.door) ?? []), o.dockAt]);
    wait += o.yardWait ?? 0;
    pre += o.preload ?? 0;
    if ((o.kind !== 'delivery') !== recv) mis++;
  }
  let overlap = 0;
  for (const list of byDoor.values()) {
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < list.length; i++) for (let k = 0; k < i; k++) overlap += Math.max(0, Math.min((list[k] as [number, number])[1], (list[i] as [number, number])[1]) - (list[i] as [number, number])[0]);
  }
  return { overlapMin: min(overlap), waitMin: min(wait), preloadMin: min(pre), mismatches: mis, doorsUsed: byDoor.size };
}

export interface PJob {
  key: string;
  inbound: boolean;
  s: number;
  /** 在门上的时长加上和下一车之间留的时间 */
  len: number;
  lo: number;
  hi: number;
  fixed: boolean;
}

/**
 * 一组门（D 樘一样的门）：每个作业挪多少（5 分钟一挡），排队 + 提前装车最少。分支定界；
 * incumbent 是已知的一个排法（调度台现在的），只找比它严格更好的，搜完没找到就证明它是最优的。
 */
export function minShift(jobs: PJob[], D: number, incumbent: Map<string, number> | undefined, nodeLimit: number): { start: Map<string, number>; cost: number; optimal: boolean; nodes: number } {
  const js = [...jobs].sort((a, b) => a.s - b.s || a.key.localeCompare(b.key));
  const n = js.length;
  const A: number[] = [];
  const B: number[] = [];
  const count = (p: number) => {
    let c = 0;
    for (let k = 0; k < A.length; k++) if ((A[k] as number) <= p && p < (B[k] as number)) c++;
    return c;
  };
  const fits = (a: number, len: number) => {
    const b = a + len;
    if (count(a) >= D) return false;
    for (let k = 0; k < A.length; k++) {
      const p = A[k] as number;
      if (p > a && p < b && count(p) >= D) return false;
    }
    return true;
  };
  const tryAll = (startOf: (j: PJob) => number) => {
    let ok = true;
    for (const j of js) {
      const a = startOf(j);
      if (!fits(a, j.len)) {
        ok = false;
        break;
      }
      A.push(a);
      B.push(a + j.len);
    }
    A.length = 0;
    B.length = 0;
    return ok;
  };
  // 门够用（都不挪）就不用搜
  if (tryAll((j) => j.s)) return { start: new Map(js.map((j) => [j.key, j.s] as const)), cost: 0, optimal: true, nodes: n };
  let best = Infinity;
  let bestStart: Map<string, number> | undefined;
  if (incumbent && js.every((j) => incumbent.has(j.key)) && tryAll((j) => incumbent.get(j.key) as number)) {
    best = js.reduce((sum, j) => sum + Math.abs((incumbent.get(j.key) as number) - j.s), 0);
    bestStart = new Map(incumbent);
  }
  const options = (j: PJob): number[] => {
    if (j.fixed) return [j.s];
    const out: number[] = [];
    if (j.inbound) for (let a = j.s; a <= j.hi; a += STEP) out.push(a);
    else for (let a = j.s; a >= j.lo; a -= STEP) out.push(a);
    return out;
  };
  const alone = (j: PJob): number => {
    for (const a of options(j)) if (fits(a, j.len)) return Math.abs(a - j.s);
    return Infinity;
  };
  const cur: number[] = new Array<number>(n).fill(0);
  let nodes = 0;
  let cut = false;
  const dfs = (i: number, cost: number): void => {
    if (cut) return;
    if (++nodes > nodeLimit) {
      cut = true;
      return;
    }
    if (i === n) {
      if (cost < best) {
        best = cost;
        bestStart = new Map(js.map((j, k) => [j.key, cur[k] as number] as const));
      }
      return;
    }
    // 下界：还没排的作业各自单独放进现在的排法里最少要挪多少（后面再放别的只会更挤）
    let rest = 0;
    const maxB = B.reduce((m, b) => Math.max(m, b), -Infinity);
    for (let k = i + 1; k < n; k++) {
      const j = js[k] as PJob;
      if (j.s >= maxB) continue;
      rest += alone(j);
      if (cost + rest >= best) return;
    }
    const j = js[i] as PJob;
    for (const a of options(j)) {
      const c = Math.abs(a - j.s);
      if (cost + c + rest >= best) break;
      if (!fits(a, j.len)) continue;
      A.push(a);
      B.push(a + j.len);
      cur[i] = a;
      dfs(i + 1, cost + c);
      A.pop();
      B.pop();
      if (cut) return;
    }
  };
  dfs(0, 0);
  return { start: bestStart ?? new Map(), cost: bestStart ? best : Infinity, optimal: !cut && !!bestStart, nodes };
}

/** 先到先排的挪法（和调度台的思路一样，但不会两车挤一樘门）：进货车往后找、配送车往前找第一个排得下的时刻 */
function greedyShift(jobs: PJob[], D: number): Map<string, number> | undefined {
  const js = [...jobs].sort((a, b) => a.s - b.s || a.key.localeCompare(b.key));
  const placed: [number, number][] = [];
  const fits = (a: number, len: number) => {
    const b = a + len;
    const pts = [a, ...placed.filter(([x]) => x > a && x < b).map(([x]) => x)];
    return pts.every((p) => placed.filter(([x, y]) => x <= p && p < y).length < D);
  };
  const out = new Map<string, number>();
  for (const j of js) {
    let start: number | undefined;
    if (j.fixed) start = fits(j.s, j.len) ? j.s : undefined;
    else if (j.inbound) {
      for (let a = j.s; a <= j.hi && start === undefined; a += STEP) if (fits(a, j.len)) start = a;
    } else for (let a = j.s; a >= j.lo && start === undefined; a -= STEP) if (fits(a, j.len)) start = a;
    if (start === undefined) return undefined;
    placed.push([start, start + j.len]);
    out.set(j.key, start);
  }
  return out;
}

/** 配送车最早能提前到的那一挡（按作业自己的 5 分钟格子，和调度台一样允许差 1 秒） */
const preloadLo = (s: number, earliestLoad: number) => Math.min(s, Math.max(s - MAX_PRELOAD, s - Math.floor((s - earliestLoad + 1) / STEP) * STEP));

/**
 * 下界（怎么排也少不了这么多挪动）取两种算法的大者：
 * - 单个时刻：这一刻要占门的作业比门多，多出来的那几个最少要挪多少才能让开这一刻；
 * - 时间窗（能量推理）：任取一段 [p, q]，作业原定在里面占门的时长合计超过 D ×（q − p）的部分，必须靠挪动挪出去，
 *   而每个作业挪 t 秒最多只能让它在这段里少占 t 秒。
 */
function shiftLowerBound(jobs: PJob[], D: number): number {
  let lb = 0;
  const pts = [...new Set(jobs.flatMap((j) => [j.s, j.s + j.len]))].sort((a, b) => a - b);
  for (let i = 0; i < pts.length; i++)
    for (let k = i + 1; k < pts.length; k++) {
      const p = pts[i] as number;
      const q = pts[k] as number;
      let occ = 0;
      for (const j of jobs) occ += Math.max(0, Math.min(q, j.s + j.len) - Math.max(p, j.s));
      const need = occ - D * (q - p);
      if (need > lb) lb = need;
    }
  lb = Math.ceil(lb / STEP - 1e-9) * STEP;
  for (const p0 of jobs) {
    const p = p0.s;
    const over = jobs.filter((j) => j.s <= p && p < j.s + j.len);
    if (over.length <= D) continue;
    const costs = over
      .map((j) => {
        if (j.fixed) return Infinity;
        if (j.inbound) return Math.ceil((p - j.s + 1) / STEP) * STEP;
        const need = Math.ceil((j.s + j.len - p) / STEP) * STEP;
        return j.s - need >= j.lo ? need : Infinity;
      })
      .sort((a, b) => a - b);
    let sum = 0;
    for (let k = 0; k < over.length - D; k++) sum += costs[k] as number;
    if (Number.isFinite(sum)) lb = Math.max(lb, sum);
  }
  return lb;
}

export interface AJob {
  key: string;
  inbound: boolean;
  a: number;
  /** 结束 + 留给下一车的时间 */
  b: number;
  door?: number;
}

/**
 * 时刻定了以后排到具体的门上：收发门错用最少，再用到的门最少（编号小的先用）。
 * 同一类（收货门 / 发货门）、此刻空着、以后也没被调度员指定的门是等价的，只试一樘；按状态记忆，精确求解。
 */
export function assignDoors(jobs: AJob[], nDoors: number, R: number, rolePref: boolean): { door: Map<string, number>; mismatches: number; used: number; exact: boolean } | undefined {
  const js = [...jobs].sort((x, y) => x.a - y.a || (x.door !== undefined ? 0 : 1) - (y.door !== undefined ? 0 : 1) || x.key.localeCompare(y.key));
  // 快路：没有调度员指定的门、进货车同时最多不超过收货门数、配送车不超过发货门数时，
  // 各自按编号小的先用排进自己那一类门就是最优（不错用，用到的门 = 各自同时最多的车数）
  const width = (list: AJob[]) => {
    let w = 0;
    for (const j of list) w = Math.max(w, list.filter((k) => k.a <= j.a && j.a < k.b).length);
    return w;
  };
  /** 快路排出来、但证明不了门数最少的结果（留作精确搜索的对照） */
  let fast: { door: Map<string, number>; mismatches: number; used: number; exact: boolean } | undefined;
  if (!js.some((j) => j.door !== undefined)) {
    const ins = js.filter((j) => j.inbound);
    const outs = js.filter((j) => !j.inbound);
    if (!rolePref || (width(ins) <= R && width(outs) <= nDoors - R)) {
      const door = new Map<string, number>();
      const firstFit = (list: AJob[], from: number, to: number): boolean => {
        const busyT = new Float64Array(to - from).fill(-Infinity);
        for (const j of list) {
          let d = 0;
          while (d < busyT.length && (busyT[d] as number) > j.a) d++;
          if (d >= busyT.length) return false;
          busyT[d] = j.b;
          door.set(j.key, from + d);
        }
        return true;
      };
      const ok = rolePref ? firstFit(ins, 0, R) && firstFit(outs, R, nDoors) : firstFit(js, 0, nDoors);
      if (ok) return { door, mismatches: 0, used: new Set(door.values()).size, exact: true };
    }
    if (rolePref) {
      // 有一类门不够：按开始先后，这一类同时在门上的车超过门数时，把结束得最晚的那辆挪到另一类门（错用）。
      // 每一类各自挪走的车数都是最少的（区间图里保留最多区间的经典贪心），两类加起来就是错用的下界；
      // 两类门各自按编号小的先用排得下，错用就是最少的
      const evict = (list: AJob[], cap: number): Set<string> => {
        const out = new Set<string>();
        const active: AJob[] = [];
        for (const j of list) {
          for (let k = active.length - 1; k >= 0; k--) if ((active[k] as AJob).b <= j.a) active.splice(k, 1);
          active.push(j);
          if (active.length > cap) {
            let w = 0;
            for (let k = 1; k < active.length; k++) if ((active[k] as AJob).b > (active[w] as AJob).b) w = k;
            out.add((active[w] as AJob).key);
            active.splice(w, 1);
          }
        }
        return out;
      };
      const movedIn = evict(ins, R);
      const movedOut = evict(outs, nDoors - R);
      const recv = js.filter((j) => (j.inbound ? !movedIn.has(j.key) : movedOut.has(j.key)));
      const ship = js.filter((j) => (j.inbound ? movedIn.has(j.key) : !movedOut.has(j.key)));
      const door = new Map<string, number>();
      const firstFit = (list: AJob[], from: number, to: number): boolean => {
        const busyT = new Float64Array(to - from).fill(-Infinity);
        for (const j of list) {
          let d = 0;
          while (d < busyT.length && (busyT[d] as number) > j.a) d++;
          if (d >= busyT.length) return false;
          busyT[d] = j.b;
          door.set(j.key, from + d);
        }
        return true;
      };
      if (firstFit(recv, 0, R) && firstFit(ship, R, nDoors)) {
        const used = new Set(door.values()).size;
        // 用到的门等于同时在门上最多的车数就证明也是最少的；证明不了时交给下面的精确搜索，搜索给不出更好的再用这个
        //（对照验证 npm run validate 发现：只按这条快路，少数例子会多用一樘门）
        const quick = { door, mismatches: movedIn.size + movedOut.size, used, exact: used === width(js) };
        if (quick.exact) return quick;
        fast = quick;
      }
    }
  }
  const resv: AJob[][] = Array.from({ length: nDoors }, () => []);
  for (const j of js) if (j.door !== undefined) (resv[j.door] as AJob[]).push(j);
  const busy = new Float64Array(nDoors).fill(-Infinity);
  const used = new Uint8Array(nDoors);
  const free = (d: number, j: AJob) => {
    if ((busy[d] as number) > j.a) return false;
    if (j.door !== undefined) return j.door === d;
    for (const r of resv[d] as AJob[]) if (r.a < j.b && j.a < r.b) return false;
    return true;
  };
  const mis = (d: number, j: AJob) => (rolePref && (j.inbound ? d >= R : d < R) ? 1 : 0);
  const sigOf = (d: number) => ((resv[d] as AJob[]).length ? `r${d}` : `${d < R ? 'R' : 'S'}${used[d]}`);
  // 按时间切成互不相连的几段（前一段的车都走了才开始下一段），每段单独精确求解；段与段之间只带着「哪些门用过」
  const comps: AJob[][] = [];
  let cur: AJob[] = [];
  let maxB = -Infinity;
  for (const j of js) {
    if (cur.length && j.a >= maxB) {
      comps.push(cur);
      cur = [];
    }
    cur.push(j);
    maxB = Math.max(maxB, j.b);
  }
  if (cur.length) comps.push(cur);
  /** 一段里的状态太多（门多、同时在门上的车多）就停下，这一段退回先到先排 */
  const MEMO_CAP = 40_000;
  const door = new Map<string, number>();
  let mm = 0;
  let exact = true;
  for (const list of comps) {
    const n = list.length;
    const memo = new Map<string, number>();
    let over = false;
    const key = (i: number) => {
      const t = (list[i] as AJob).a;
      const fixedPart: string[] = [];
      const busyPart: string[] = [];
      const freeCount = new Map<string, number>();
      for (let d = 0; d < nDoors; d++) {
        const bu = busy[d] as number;
        if ((resv[d] as AJob[]).length) fixedPart.push(`${d}:${bu > t ? bu : 0}:${used[d]}`);
        else if (bu > t) busyPart.push(`${d < R ? 'R' : 'S'}${used[d]}@${bu}`);
        else {
          const k = `${d < R ? 'R' : 'S'}${used[d]}`;
          freeCount.set(k, (freeCount.get(k) ?? 0) + 1);
        }
      }
      busyPart.sort();
      return `${i}|${fixedPart.join(',')}|${busyPart.join(',')}|${[...freeCount].sort().map(([k, v]) => `${k}${v}`).join(',')}`;
    };
    /** 从这一段的第 i 个作业起最少还要多少（错用 × 1000 + 新开的门） */
    const solve = (i: number): number => {
      if (i === n) return 0;
      if (over) return Infinity;
      const k = key(i);
      const hit = memo.get(k);
      if (hit !== undefined) return hit;
      if (memo.size > MEMO_CAP) {
        over = true;
        return Infinity;
      }
      const j = list[i] as AJob;
      let best = Infinity;
      const seen = new Set<string>();
      for (let d = 0; d < nDoors; d++) {
        if (!free(d, j)) continue;
        const sig = sigOf(d);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const c = mis(d, j) * 1000 + (used[d] ? 0 : 1);
        const b0 = busy[d] as number;
        const u0 = used[d] as number;
        busy[d] = j.b;
        used[d] = 1;
        const v = c + solve(i + 1);
        busy[d] = b0;
        used[d] = u0;
        if (v < best) best = v;
      }
      memo.set(k, best);
      return best;
    };
    if (!Number.isFinite(solve(0))) {
      if (!over) return undefined;
      // 退回：按开始先后，优先自己那一类门、编号小的先用（调度员指定的门照用）
      exact = false;
      for (const j of list) {
        const order = Array.from({ length: nDoors }, (_, d) => d).sort((x, y) => mis(x, j) - mis(y, j) || (used[y] as number) - (used[x] as number) || x - y);
        const d = order.find((x) => free(x, j));
        if (d === undefined) return undefined;
        busy[d] = j.b;
        used[d] = 1;
        door.set(j.key, d);
        mm += mis(d, j);
      }
      continue;
    }
    // 按记下的值走一遍，取出每个作业的门
    for (let i = 0; i < n; i++) {
      const j = list[i] as AJob;
      const target = solve(i);
      const seen = new Set<string>();
      let pick = -1;
      for (let d = 0; d < nDoors && pick < 0; d++) {
        if (!free(d, j)) continue;
        const sig = sigOf(d);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const c = mis(d, j) * 1000 + (used[d] ? 0 : 1);
        const b0 = busy[d] as number;
        const u0 = used[d] as number;
        busy[d] = j.b;
        used[d] = 1;
        if (c + solve(i + 1) === target) pick = d;
        else {
          busy[d] = b0;
          used[d] = u0;
        }
      }
      if (pick < 0) return undefined;
      door.set(j.key, pick);
      mm += mis(pick, j);
    }
  }
  // 错用在每一段里都是最少的（段与段互不影响）；用到的门要是正好等于同时在门上最多的车数，就证明也是最少的
  const usedN = [...used].filter(Boolean).length;
  if (comps.length > 1 && usedN > width(js)) exact = false;
  // 精确搜索没证明最优时（分了几段、或者状态太多退回了先到先排），和快路的结果比，取错用 → 用门更少的
  if (!exact && fast && fast.mismatches * 1000 + fast.used < mm * 1000 + usedN) return fast;
  return { door, mismatches: mm, used: usedN, exact };
}

const toPJob = (j: DoorJob, earliestLoad: number, fixed: boolean): PJob => ({ key: String(j.k), inbound: j.inbound, s: j.s, len: j.e - j.s + DOOR_GAP, lo: j.inbound ? j.s : preloadLo(j.s, earliestLoad), hi: j.inbound ? j.s + MAX_WAIT : j.s, fixed });

/** 一组门的求解：先求挪多少，再排到门上；排不开就保留调度台的排法（fallback） */
function solveGroup(jobs: DoorJob[], group: DoorGroup, earliestLoad: number, opts: SolverOptions, incumbent: Map<string, number>, fallback: { placements: DoorPlacement[]; stats: DoorStats }): DoorGroupResult {
  const ids = DOORS[group];
  const nDoors = ids.length;
  const R = RECEIVING_DOORS[group];
  const keepFixed = (j: DoorJob) => opts.keepFixed && !!j.fixed;
  const pj = jobs.map((j) => toPJob(j, earliestLoad, keepFixed(j)));
  const lb = shiftLowerBound(pj, nDoors);
  // 已知的排法：调度台现在的（门全满时它会两车挤一樘门，那就不算数）和先到先排的，哪个好用哪个
  const cost = (m: Map<string, number> | undefined) => (m ? pj.reduce((a, j) => a + Math.abs((m.get(j.key) ?? j.s) - j.s), 0) : Infinity);
  const greedy = greedyShift(pj, nDoors);
  const ms0 = minShift(pj, nDoors, incumbent, 0);
  const inc = ms0.start.size && cost(incumbent) <= cost(greedy) ? incumbent : greedy;
  const ms = minShift(pj, nDoors, inc, 150_000);
  if (!ms.start.size) return { group, doors: nDoors, jobs: jobs.length, placements: fallback.placements, stats: fallback.stats, lowerBoundMin: min(lb), optimal: false, nodes: ms.nodes, overflow: true };
  const start = ms.start;
  const aj: AJob[] = jobs.map((j) => {
    const a = start.get(String(j.k)) ?? j.s;
    return { key: String(j.k), inbound: j.inbound, a, b: a + (j.e - j.s) + DOOR_GAP, ...(keepFixed(j) ? { door: ids.indexOf(j.fixed as string) } : {}) };
  });
  // 调度员指定的门互相冲突就不保留指定，重新排
  const as = assignDoors(aj, nDoors, R, opts.rolePreference) ?? assignDoors(aj.map((x) => ({ key: x.key, inbound: x.inbound, a: x.a, b: x.b })), nDoors, R, opts.rolePreference);
  if (!as) return { group, doors: nDoors, jobs: jobs.length, placements: fallback.placements, stats: fallback.stats, lowerBoundMin: min(lb), optimal: false, nodes: ms.nodes, overflow: true };
  const placements: DoorPlacement[] = jobs.map((j) => {
    const a = start.get(String(j.k)) ?? j.s;
    return { k: j.k, id: j.id, door: ids[as.door.get(String(j.k)) ?? 0] as string, t0: a, t1: a + (j.e - j.s), shift: a - j.s };
  });
  const wait = placements.reduce((s, p) => s + Math.max(0, p.shift), 0);
  const pre = placements.reduce((s, p) => s + Math.max(0, -p.shift), 0);
  return {
    group,
    doors: nDoors,
    jobs: jobs.length,
    placements,
    stats: { overlapMin: 0, waitMin: min(wait), preloadMin: min(pre), mismatches: as.mismatches, doorsUsed: as.used },
    lowerBoundMin: min(lb),
    optimal: ms.optimal && as.exact,
    nodes: ms.nodes,
  };
}

const sumStats = (list: DoorStats[]): DoorStats => list.reduce((a, s) => ({ overlapMin: a.overlapMin + s.overlapMin, waitMin: a.waitMin + s.waitMin, preloadMin: a.preloadMin + s.preloadMin, mismatches: a.mismatches + s.mismatches, doorsUsed: a.doorsUsed + s.doorsUsed }), { overlapMin: 0, waitMin: 0, preloadMin: 0, mismatches: 0, doorsUsed: 0 });
/**
 * 字典序：挤门 + 排队 + 提前装车的分钟 → 错用 → 用到的门。
 * 两车挤一樘门在现实里就是后来的那辆在门口等，所以挤门的分钟按等待算（和排队一样计）。
 */
export const doorScore = (s: DoorStats): number => (s.overlapMin + s.waitMin + s.preloadMin) * 1e6 + s.mismatches * 1e3 + s.doorsUsed;

/**
 * 月台门求解。allocation：分配库存的时刻（当天的小时，配送车之前不能装车）。
 * 返回求解的排法、调度台现在的排法、落到当天调度（指定门）上的结果和每一处改动的说明。
 */
export function solveDoors(board: Board, day: DayPlan, allocation: number, opts: SolverOptions = DEFAULT_OPTIONS): DoorSolution {
  const t0 = now();
  const earliestLoad = earliestLoadOf(allocation);
  const jobs = doorJobs(board, day);
  const groups: DoorGroupResult[] = [];
  const curve: DoorSolution['curve'] = [];
  for (const g of ['cold', 'dry'] as DoorGroup[]) {
    const list = jobs.filter((j) => j.group === g);
    if (!list.length) continue;
    // 已知的排法：调度台现在每个作业在门上的开始时刻
    const incumbent = new Map(list.map((j) => [String(j.k), board.ops[j.k]?.dockAt?.[0] ?? j.s] as const));
    const fallback = {
      placements: list.map((j) => {
        const o = board.ops[j.k];
        const t = o?.dockAt?.[0] ?? j.s;
        return { k: j.k, id: j.id, door: o?.door ?? (DOORS[g][0] as string), t0: t, t1: t + (j.e - j.s), shift: t - j.s };
      }),
      stats: doorStatsOf(board, g),
    };
    groups.push(solveGroup(list, g, earliestLoad, opts, incumbent, fallback));
    // 开门曲线：从不用挪需要的门数往下减，直到排不下或减到 1 樘
    const pj = list.map((j) => toPJob(j, earliestLoad, false));
    let need = 0;
    for (const j of pj) need = Math.max(need, pj.filter((k) => k.s <= j.s && j.s < k.s + k.len).length);
    for (let d = need; d >= Math.max(1, need - 4); d--) {
      const r = minShift(pj, d, greedyShift(pj, d), 6_000);
      if (!Number.isFinite(r.cost)) break;
      curve.push({ group: g, doors: d, minutes: min(r.cost), optimal: r.optimal });
    }
  }
  const stats = sumStats(groups.map((x) => x.stats));
  const baseline = doorStatsOf(board);
  // 落到当天调度上：不挪的作业指定到求解的门（调度台按原定时刻放），要挪的交给调度台自动排；
  // 作业编号重复的没法单独指定，也交给自动排。先只指定改了门的，对不上再全部指定
  const placements = groups.flatMap((g) => g.placements);
  const idCount = new Map<string, number>();
  for (const j of jobs) idCount.set(j.id, (idCount.get(j.id) ?? 0) + 1);
  const solo = (p: DoorPlacement) => idCount.get(p.id) === 1;
  const src = sourceOps(board);
  const build = (d: DayPlan) => buildBoard(src, d, { allocation, crossDock: false });
  const clone = (d: DayPlan): DayPlan => ({ depart: { ...d.depart }, arrive: { ...d.arrive }, door: { ...d.door }, unit: { ...d.unit } });
  const tryDay = (all: boolean): DayPlan => {
    const next = clone(day);
    for (const p of placements) {
      if (!solo(p)) continue;
      if (p.shift !== 0) {
        if (!(opts.keepFixed && day.door[p.id])) delete next.door[p.id];
        continue;
      }
      if (all || board.ops[p.k]?.door !== p.door) next.door[p.id] = p.door;
    }
    return next;
  };
  type Cand = { day: DayPlan; b: Board; st: DoorStats; score: number };
  const evaluate = (d: DayPlan): Cand => {
    const b = build(d);
    const st = doorStatsOf(b);
    return { day: d, b, st, score: doorScore(st) };
  };
  // 候选：现在的、只指定改了门的、不挪的全部指定；再逐个试「放开一个指定」「把排在原定时刻的固定下来」，有改进就接着试
  let best: Cand = { day, b: board, st: baseline, score: doorScore(baseline) };
  for (const d of [tryDay(false), tryDay(true)]) {
    const c = evaluate(d);
    if (c.score < best.score) best = c;
  }
  let evals = 2;
  for (let round = 0; round < 4 && evals < 160; round++) {
    let improved = false;
    for (const p of placements) {
      if (!solo(p) || evals >= 160) continue;
      if (opts.keepFixed && day.door[p.id]) continue;
      const d = clone(best.day);
      if (d.door[p.id]) delete d.door[p.id];
      else {
        const o = best.b.ops[p.k];
        const j = jobs.find((x) => x.k === p.k);
        if (!o?.door || !o.dockAt || !j || Math.abs(o.dockAt[0] - j.s) > 1) continue;
        d.door[p.id] = o.door;
      }
      evals++;
      const c = evaluate(d);
      if (c.score < best.score) {
        best = c;
        improved = true;
      }
    }
    if (!improved) break;
  }
  const chosen = best.day;
  const realized = best.st;
  const changes = doorScore(stats) < doorScore(baseline) ? doorChanges(board, groups) : [];
  for (const g of groups)
    if (g.overflow) {
      const enough = curve.find((c) => c.group === g.group && c.minutes === 0);
      changes.unshift(`${g.group === 'cold' ? '冷链' : '干货'}门不够：这一天在场地最多排队 8 小时、最多提前 4 小时装车也排不开，只能两车挤一樘门（保留调度台现在的排法）${enough ? `；开到 ${enough.doors} 樘就都排得开` : ''}`);
    }
  return { groups, stats, baseline, day: chosen, realized, curve, changes, ms: now() - t0 };
}

function doorChanges(board: Board, groups: DoorGroupResult[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (g.overflow) continue;
    const R = RECEIVING_DOORS[g.group];
    const role = (door: string) => (DOORS[g.group].indexOf(door) < R ? '收货门' : '发货门');
    for (const p of g.placements) {
      const o = board.ops[p.k];
      if (!o) continue;
      const what = o.kind === 'delivery' ? '装车' : '卸货';
      const was = o.door ?? '—';
      const shift0 = (o.yardWait ?? 0) - (o.preload ?? 0);
      const parts: string[] = [];
      if (was !== p.door) parts.push(`从 ${was}（${role(was)}）改到 ${p.door}（${role(p.door)}）`);
      if (Math.abs(shift0 - p.shift) >= 60) {
        if (p.shift > 0) parts.push(`在场地排队 ${min(p.shift)} 分钟（原来 ${min(Math.max(0, shift0))} 分钟）`);
        else if (p.shift < 0) parts.push(`提前 ${min(-p.shift)} 分钟装好（原来 ${min(Math.max(0, -shift0))} 分钟）`);
        else parts.push(shift0 > 0 ? `不用在场地排队了（原来排 ${min(shift0)} 分钟）` : `不用提前装车了（原来提前 ${min(-shift0)} 分钟）`);
      }
      if (parts.length) out.push(`${p.id}（${hm(p.t0)} ${what}）${parts.join('，')}`);
    }
    const before = new Set(board.ops.filter((o) => doorGroup(o) === g.group && o.door).map((o) => o.door as string));
    const after = new Set(g.placements.map((p) => p.door));
    const freed = [...before].filter((d) => !after.has(d)).sort();
    if (freed.length) out.push(`${g.group === 'cold' ? '冷链' : '干货'}门 ${freed.join('、')} 全天空出来（可以检修，或少排一个叉车班组）`);
  }
  return out;
}

// ———————————————————————— 车辆 ————————————————————————

export interface TripRow {
  id: string;
  cls: UnitClass;
  t0: number;
  t1: number;
  km: number;
  /** 调度员指定的车 */
  fixed?: string;
}
export interface Chain {
  unit: string;
  cls: UnitClass;
  trips: string[];
  from: number;
  to: number;
  /** 开车（含装卸）的时间、两趟之间空等的时间（秒）、要不要两位司机接力 */
  busy: number;
  idle: number;
  relays: number;
}
export interface FleetStats {
  units: number;
  unitsBy: Partial<Record<UnitClass, number>>;
  relays: number;
  idleH: number;
  driverH: number;
  /** 每天的车辆 + 司机成本（美元） */
  cost: number;
}
export interface FleetSolution {
  chains: Chain[];
  stats: FleetStats;
  baseline: FleetStats;
  /** 用车下界：同一时刻要在路上（含回场间隔）的车次最多几趟 */
  lowerBound: number;
  optimal: boolean;
  nodes: number;
  /** 本身就排不进的车次（单趟超过续航、超过两班司机） */
  infeasible: string[];
  day: DayPlan;
  changes: string[];
  ms: number;
}

/** 每辆车每天的成本（车 + 车厢，美元）、司机时薪 */
export const UNIT_DAY_COST: Record<UnitClass, number> = {
  ev: COSTS.ev.perDay + COSTS.trailerPerDay.multi,
  multi: COSTS.diesel.perDay + COSTS.trailerPerDay.multi,
  reefer: COSTS.diesel.perDay + COSTS.trailerPerDay.reefer,
  dry: COSTS.diesel.perDay + COSTS.trailerPerDay.dry,
  van: COSTS.van.perDay,
};
const wageOf = (cls: UnitClass) => (cls === 'van' ? COSTS.van.driverHour : COSTS.driverHour);
/** 两位司机接力：交接多算半小时 */
const RELAY_H = 0.5;

/** 配送车次（调度员在当天调度里指定了车的带上 fixed） */
export function tripRows(board: Board, day?: DayPlan): TripRow[] {
  return board.ops.filter(isFleet).map((o: BoardOp) => {
    const fixed = day?.unit[o.id] && o.unitId === day.unit[o.id] ? o.unitId : undefined;
    return { id: o.id, cls: unitClass(o), t0: o.t0, t1: o.t1, km: o.km ?? 0, ...(fixed ? { fixed } : {}) };
  });
}

const relaysOf = (span: number, maxDuty: number) => Math.max(0, Math.ceil(span / (maxDuty * 3600) - 1e-9) - 1);

function chainStats(chains: Chain[], opts: SolverOptions): FleetStats {
  const unitsBy: Partial<Record<UnitClass, number>> = {};
  let relays = 0;
  let idle = 0;
  let driver = 0;
  let cost = 0;
  for (const c of chains) {
    unitsBy[c.cls] = (unitsBy[c.cls] ?? 0) + 1;
    const span = c.to - c.from;
    const r = relaysOf(span, opts.maxDutyHours);
    relays += r;
    idle += c.idle;
    const h = span / 3600 + r * RELAY_H;
    driver += h;
    cost += UNIT_DAY_COST[c.cls] + h * wageOf(c.cls);
  }
  return { units: chains.length, unitsBy, relays, idleH: idle / 3600, driverH: driver, cost };
}

function makeChain(unit: string, cls: UnitClass, list: TripRow[], opts: SolverOptions): Chain {
  const sorted = [...list].sort((a, b) => a.t0 - b.t0);
  const busy = sorted.reduce((s, x) => s + (x.t1 - x.t0), 0);
  const from = (sorted[0] as TripRow).t0;
  const to = (sorted[sorted.length - 1] as TripRow).t1;
  return { unit, cls, trips: sorted.map((x) => x.id), from, to, busy, idle: to - from - busy, relays: relaysOf(to - from, opts.maxDutyHours) };
}

/** 现在调度台派的车 */
export function boardChains(board: Board, opts: SolverOptions = DEFAULT_OPTIONS): Chain[] {
  const rows = new Map(tripRows(board).map((t) => [t.id, t] as const));
  return board.units.map((u) => makeChain(u.id, u.cls, u.ops.map((id) => rows.get(id)).filter((x): x is TripRow => !!x), opts)).filter((c) => c.trips.length);
}

interface UnitState {
  first: number;
  last: number;
  soc: number;
  trips: number[];
  fixed?: string;
}

/** 一种车型的车次接成车：用车最少 → 接力最少 → 空等最少（字典序），分支定界 */
export function chainClass(trips: TripRow[], cls: UnitClass, opts: SolverOptions, ub: number, nodeLimit: number): { groups: number[][]; optimal: boolean; nodes: number; infeasible: string[] } {
  const ev = cls === 'ev';
  const range = opts.evRangeKm;
  const reserve = range * 0.1;
  const rate = opts.evChargeKmPerHour;
  const maxDuty = opts.maxDutyHours;
  const infeasible = trips.filter((t) => (ev && t.km > range - reserve) || t.t1 - t.t0 > 2 * maxDuty * 3600).map((t) => t.id);
  const ok = trips.filter((t) => !infeasible.includes(t.id));
  const n = ok.length;
  // 用车下界：同一时刻在用（含回场间隔）的车次最多几趟
  let peak = 0;
  for (const t of ok) peak = Math.max(peak, ok.filter((k) => k.t0 <= t.t0 && t.t0 < k.t1 + TURN).length);
  const units: UnitState[] = [];
  const pick = new Int32Array(n);
  let best = ub;
  let bestPick: Int32Array | undefined;
  let nodes = 0;
  let cut = false;
  const score = (u: number, relays: number, idle: number) => u * 1e9 + relays * 1e6 + idle;
  const dfs = (i: number, relays: number, idle: number): void => {
    if (cut) return;
    if (++nodes > nodeLimit) {
      cut = true;
      return;
    }
    if (score(Math.max(units.length, peak), relays, idle) >= best) return;
    if (i === n) {
      best = score(units.length, relays, idle);
      bestPick = pick.slice();
      return;
    }
    const t = ok[i] as TripRow;
    const cand: { u: number; relays: number; idle: number }[] = [];
    const seen = new Set<string>();
    const fixedUnit = opts.keepFixed && t.fixed ? units.findIndex((u) => u.fixed === t.fixed) : -1;
    for (let k = 0; k < units.length; k++) {
      const u = units[k] as UnitState;
      if (opts.keepFixed && t.fixed && u.fixed !== t.fixed) continue;
      if (u.last + TURN > t.t0) continue;
      let soc = u.soc;
      if (ev) {
        soc = Math.min(range, soc + ((t.t0 - u.last) / 3600) * rate);
        if (soc - t.km < reserve) continue;
      }
      const sig = `${u.last}:${Math.round(soc)}:${u.first}:${u.fixed ?? ''}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const r = relaysOf(t.t1 - u.first, maxDuty) - relaysOf(u.last - u.first, maxDuty);
      cand.push({ u: k, relays: r, idle: t.t0 - u.last });
    }
    if (!(opts.keepFixed && t.fixed && fixedUnit >= 0)) cand.push({ u: -1, relays: relaysOf(t.t1 - t.t0, maxDuty), idle: 0 });
    cand.sort((a, b) => (a.u < 0 ? 1 : 0) - (b.u < 0 ? 1 : 0) || a.relays - b.relays || a.idle - b.idle);
    for (const c of cand) {
      if (c.u >= 0) {
        const u = units[c.u] as UnitState;
        const save = { last: u.last, soc: u.soc };
        u.soc = ev ? Math.min(range, u.soc + ((t.t0 - u.last) / 3600) * rate) - t.km : 0;
        u.last = t.t1;
        u.trips.push(i);
        pick[i] = c.u;
        dfs(i + 1, relays + c.relays, idle + c.idle);
        u.trips.pop();
        u.last = save.last;
        u.soc = save.soc;
      } else {
        units.push({ first: t.t0, last: t.t1, soc: ev ? range - t.km : 0, trips: [i], ...(opts.keepFixed && t.fixed ? { fixed: t.fixed } : {}) });
        pick[i] = units.length - 1;
        dfs(i + 1, relays + c.relays, idle);
        units.pop();
      }
      if (cut) return;
    }
  };
  dfs(0, 0, 0);
  // 没找到比已知的更好的：搜完了就证明已知的就是最优的
  if (!bestPick) return { groups: [], optimal: !cut, nodes, infeasible };
  const groups: number[][] = [];
  bestPick.forEach((u, i) => {
    (groups[u] ??= []).push(trips.indexOf(ok[i] as TripRow));
  });
  for (const id of infeasible) groups.push([trips.findIndex((t) => t.id === id)]);
  return { groups: groups.filter((g) => g.length), optimal: !cut, nodes, infeasible };
}

/** 车辆求解：每种车型分开接车次，返回接成的车、现在调度台派的车、落到当天调度（指定车）上的结果和说明 */
export function solveFleet(board: Board, day: DayPlan, allocation: number, opts: SolverOptions = DEFAULT_OPTIONS): FleetSolution {
  const t0 = now();
  const rows = tripRows(board, day).sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
  const baseChains = boardChains(board, opts);
  const baseline = chainStats(baseChains, opts);
  const chains: Chain[] = [];
  let optimal = true;
  let nodes = 0;
  let lower = 0;
  const infeasible: string[] = [];
  const classes = [...new Set(rows.map((r) => r.cls))].sort();
  for (const cls of classes) {
    const list = rows.filter((r) => r.cls === cls);
    let peak = 0;
    for (const t of list) peak = Math.max(peak, list.filter((k) => k.t0 <= t.t0 && t.t0 < k.t1 + TURN).length);
    lower += peak;
    // 已知解：调度台现在派的车（同一个字典序的值，再小 1 才算更好）
    const mine = baseChains.filter((c) => c.cls === cls);
    const ub = mine.length * 1e9 + mine.reduce((s, c) => s + relaysOf(c.to - c.from, opts.maxDutyHours), 0) * 1e6 + mine.reduce((s, c) => s + c.idle, 0);
    const r = chainClass(list, cls, opts, ub, 300_000);
    nodes += r.nodes;
    infeasible.push(...r.infeasible);
    if (!r.groups.length) {
      // 没找到更好的：保留现在的
      chains.push(...mine);
      optimal &&= r.optimal;
      continue;
    }
    optimal &&= r.optimal;
    // 编号：调度员指定的车保留原编号，其余按第一趟出发的先后编
    const made = r.groups.map((g) => g.map((k) => list[k] as TripRow)).sort((a, b) => (a[0] as TripRow).t0 - (b[0] as TripRow).t0);
    const taken = new Set(made.flatMap((g) => g.map((t) => t.fixed).filter((x): x is string => !!x)));
    let k = 0;
    const nextId = () => {
      let id = '';
      do id = `${UNIT_PREFIX[cls]}${String(++k).padStart(2, '0')}`;
      while (taken.has(id));
      return id;
    };
    for (const g of made) {
      const fixed = opts.keepFixed ? g.find((t) => t.fixed)?.fixed : undefined;
      chains.push(makeChain(fixed ?? nextId(), cls, g, opts));
    }
  }
  chains.sort((a, b) => a.cls.localeCompare(b.cls) || a.unit.localeCompare(b.unit));
  const stats = chainStats(chains, opts);
  // 和现在的接法一样（同样的车次分在同样的车上）就不用改
  const groupKey = (cs: Chain[]) => cs.map((c) => [...c.trips].sort().join('+')).sort().join('|');
  const same = groupKey(chains) === groupKey(baseChains);
  let next: DayPlan = day;
  if (!same) {
    next = { depart: { ...day.depart }, arrive: { ...day.arrive }, door: { ...day.door }, unit: { ...day.unit } };
    for (const c of chains) for (const id of c.trips) next.unit[id] = c.unit;
    // 核对：调度台按指定的车排出来，每趟车都在求解的车上、没有「车辆还没回来」
    const b = buildBoard(sourceOps(board), next, { allocation, crossDock: false });
    const okAll = chains.every((c) => c.trips.every((id) => b.byId.get(id)?.unitId === c.unit)) && !b.issues.some((i) => i.code === 'unit-busy');
    if (!okAll) next = day;
  }
  const changes = same ? [] : fleetChanges(baseChains, chains, board);
  return { chains, stats, baseline, lowerBound: lower, optimal, nodes, infeasible, day: next, changes, ms: now() - t0 };
}

function fleetChanges(before: Chain[], after: Chain[], board: Board): string[] {
  const out: string[] = [];
  const beforeKey = new Set(before.map((c) => [...c.trips].sort().join('+')));
  const desc = (id: string) => {
    const o = board.byId.get(id);
    return o ? `${id}（${hm(o.t0)}–${hm(o.t1)}）` : id;
  };
  for (const c of after) {
    if (beforeKey.has([...c.trips].sort().join('+'))) continue;
    if (c.trips.length === 1) {
      out.push(`${c.unit}（${UNIT_LABEL[c.cls]}）只跑 ${desc(c.trips[0] as string)}`);
      continue;
    }
    const steps: string[] = [];
    c.trips.forEach((id, k) => {
      if (k > 0) {
        const prev = board.byId.get(c.trips[k - 1] as string);
        const cur = board.byId.get(id);
        if (prev && cur) steps.push(`回场后 ${min(cur.t0 - prev.t1)} 分钟接`);
      }
      steps.push(desc(id));
    });
    out.push(`${c.unit}（${UNIT_LABEL[c.cls]}）：${steps.join(' → ')}${c.relays ? `；从 ${hm(c.from)} 用到 ${hm(c.to)}，要两位司机接力` : ''}`);
  }
  return out;
}

// ———————————————————————— 补货 ————————————————————————

/** 生鲜陈列量系数（和仿真一致，src/sim/engine.ts） */
const PRESENTATION: Partial<Record<string, number>> = { dairy: 1.0, produce: 1.3, meat: 0.6, bakery: 0.5 };
/** 生鲜到店时还剩的保质期比例（仿真里卖出时平均还剩约八成）；隔夜下单、第二天上午到货算的提前期（天） */
const LIFE_LEFT = 0.8;
const LEAD = 0.25;
const K_OPTIONS = [1, 2, 3, 4, 7];
const Z_OPTIONS = [0.84, 1.04, 1.28, 1.48, 1.65, 1.88, 2.05, 2.33];
/** 选做法用一组随机需求，核对用另一组（避免只是碰巧适合那一组） */
const FIT_SEED = 11;
const CHECK_SEED = 97;

export interface ReplenPolicy {
  /** 每几天补一次、安全系数、订到多少（件） */
  k: number;
  z: number;
  S: number;
}
export interface ReplenCost {
  /** 每天：持有、补货、缺货（毛利损失）、报废（进价）成本，合计（美元） */
  hold: number;
  order: number;
  short: number;
  waste: number;
  total: number;
  /** 平均库存（天）、每天缺货和报废的件数、订满时占的体积（立方米） */
  coverDays: number;
  lostUnits: number;
  wasteUnits: number;
  space: number;
}
export interface ReplenRow {
  key: string;
  label: string;
  /** 每天卖多少件 */
  demand: number;
  cur: ReplenPolicy;
  opt: ReplenPolicy;
  /** 选做法用的那组需求下的成本、核对用的另一组需求下的成本 */
  curCost: ReplenCost;
  optCost: ReplenCost;
  curCheck: ReplenCost;
  optCheck: ReplenCost;
}
export interface ReplenSolution {
  rows: ReplenRow[];
  /** 直送门店的商品族（整车订，不在这里算） */
  direct: string[];
  /** 货架和后仓的容量、现在和求解订满时占的体积（立方米） */
  capacity: number;
  usedCur: number;
  usedOpt: number;
  totalCur: number;
  totalOpt: number;
  checkCur: number;
  checkOpt: number;
  /** 每天的补货次数（商品族 × 次）：现在 / 求解 */
  ordersCur: number;
  ordersOpt: number;
  /** 配送车：车队每天能装的托盘、最忙那天要送的托盘（隔几天送一次的商品族错开送货日）：现在 / 求解 */
  truckPallets: number;
  peakCur: number;
  peakOpt: number;
  changes: string[];
  ms: number;
}

interface FamIn {
  fam: Family;
  mu: number;
  sigma: number;
  unitCost: number;
  pres: number;
}

const orderUpTo = (f: FamIn, k: number, z: number) => {
  const H = k + LEAD;
  return f.mu * H + z * f.sigma * Math.sqrt(H) + f.pres;
};

/**
 * 一年（364 天）的逐日模拟：每 k 天晚上订到 S（整箱），第二天上午到；卖不到就丢单；
 * 生鲜按批次先进先出，到店后过了剩下的保质期就报废。同一个商品族的各种做法用同一组随机需求比。
 */
function simulate(f: FamIn, p: ReplenPolicy, opts: SolverOptions, seed: number): ReplenCost {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
  const DAYS = 364;
  const life = f.fam.life ? Math.max(2, Math.floor(f.fam.life * LIFE_LEFT)) : Infinity;
  const cv = f.sigma / Math.max(1e-9, f.mu);
  let cohorts: { q: number; age: number }[] = [{ q: Math.max(0, p.S - f.mu * LEAD), age: 0 }];
  let onOrder = 0;
  let held = 0;
  let lost = 0;
  let waste = 0;
  let orders = 0;
  for (let d = 0; d < DAYS; d++) {
    if (onOrder > 0) {
      cohorts.push({ q: onOrder, age: 0 });
      onOrder = 0;
    }
    let want = Math.max(0, f.mu * (1 + cv * normal()));
    for (const c of cohorts) {
      const take = Math.min(c.q, want);
      c.q -= take;
      want -= take;
      if (want <= 0) break;
    }
    lost += want;
    held += cohorts.reduce((a, c) => a + c.q, 0);
    for (const c of cohorts) {
      c.age++;
      if (c.age >= life && c.q > 0) {
        waste += c.q;
        c.q = 0;
      }
    }
    cohorts = cohorts.filter((c) => c.q > 1e-6);
    if (d % p.k === 0) {
      const q = p.S - cohorts.reduce((a, c) => a + c.q, 0);
      if (q >= f.fam.unitsPerCase * 0.25) {
        onOrder = Math.ceil(q / f.fam.unitsPerCase) * f.fam.unitsPerCase;
        orders++;
      }
    }
  }
  const avg = held / DAYS;
  const hold = avg * f.unitCost * (COSTS.carrying / 365);
  const order = (orders / DAYS) * opts.orderCost;
  const short = (lost / DAYS) * f.fam.price * f.fam.margin;
  const wasteCost = (waste / DAYS) * f.unitCost;
  return { hold, order, short, waste: wasteCost, total: hold + order + short + wasteCost, coverDays: avg / Math.max(1e-9, f.mu), lostUnits: lost / DAYS, wasteUnits: waste / DAYS, space: (p.S / f.fam.unitsPerCase) * f.fam.cube };
}

/**
 * 补货求解。demand：门店每个商品族每天卖多少件；direct：长途整车直送门店的商品族（不在这里算）。
 * 现在的规则按仿真（几天送一次按送货日，安全系数和陈列量按方案）；每个商品族在（几天补一次 × 安全系数）里挑一种，
 * 每种做法的成本用一年的逐日模拟算，再在「订满时不多占货架和后仓」的条件下用多选背包挑出合计最省的组合，最后换一组随机需求核对。
 */
export function solveReplen(gen: Gen, demand: Record<string, number>, direct: readonly string[], opts: SolverOptions = DEFAULT_OPTIONS, storeGroup: 'A' | 'B' = 'A', truckPallets = Infinity): ReplenSolution {
  const t0 = now();
  const store = scenarioFor(gen).store;
  const fams: FamIn[] = [];
  const curK: number[] = [];
  for (const fam of FAMILIES) {
    const mu = demand[fam.key] ?? 0;
    if (mu <= 0 || direct.includes(fam.key)) continue;
    const cvc = Math.sqrt(fam.cv * fam.cv + store.forecastError * store.forecastError);
    const pres = fam.life ? store.presentationDays * (PRESENTATION[fam.cat] ?? 0) * mu : 1.2 * mu;
    fams.push({ fam, mu, sigma: mu * cvc, unitCost: fam.caseCost / fam.unitsPerCase, pres });
    const days = fam.source === 'bakery' ? 7 : store.deliveryDays[fam.temp][storeGroup].length;
    curK.push(Math.max(1, Math.round(7 / Math.max(1, days))));
  }
  const curZ = (f: FamIn) => (f.fam.life ? (store.safetyZFresh ?? store.safetyZ) : store.safetyZ);
  const cur: ReplenPolicy[] = fams.map((f, i) => {
    const k = curK[i] as number;
    const z = curZ(f);
    return { k, z, S: orderUpTo(f, k, z) };
  });
  const curCost = fams.map((f, i) => simulate(f, cur[i] as ReplenPolicy, opts, FIT_SEED + i));
  const usedCur = curCost.reduce((a, c) => a + c.space, 0);
  const capacity = usedCur * (1 + opts.extraSpacePct / 100);
  // 候选：现在的做法一定在里面；生鲜放不到剩下保质期的 1.3 倍以上
  const CELL = 0.05;
  const cellsOf = (space: number) => Math.ceil(space / CELL - 1e-9);
  const choices = fams.map((f, i) => {
    const list: { p: ReplenPolicy; c: ReplenCost; w: number }[] = [{ p: cur[i] as ReplenPolicy, c: curCost[i] as ReplenCost, w: cellsOf((curCost[i] as ReplenCost).space) }];
    for (const k of K_OPTIONS)
      for (const z of Z_OPTIONS) {
        if (k === (cur[i] as ReplenPolicy).k && Math.abs(z - (cur[i] as ReplenPolicy).z) < 1e-9) continue;
        const S = orderUpTo(f, k, z);
        if (f.fam.life && S / f.mu > f.fam.life * LIFE_LEFT * 1.3) continue;
        const p = { k, z, S };
        const c = simulate(f, p, opts, FIT_SEED + i);
        list.push({ p, c, w: cellsOf(c.space) });
      }
    return list;
  });
  // 多选背包：每个商品族挑一个做法，体积（0.05 立方米一格，向上取整）合计不超过容量，成本合计最小；maxK 限制每个商品族最多几天补一次
  const cap = choices.reduce((a, list) => a + (list[0] as { w: number }).w, 0) + Math.floor((usedCur * opts.extraSpacePct) / 100 / CELL);
  const INF = Number.POSITIVE_INFINITY;
  const knapsack = (maxK: number[]): number[] => {
    let dp = new Float64Array(cap + 1).fill(INF);
    dp[0] = 0;
    const prev: Int32Array[] = [];
    choices.forEach((list, i) => {
      const nx = new Float64Array(cap + 1).fill(INF);
      const from = new Int32Array(cap + 1).fill(-1);
      for (let w = 0; w <= cap; w++) {
        const base = dp[w] as number;
        if (base === INF) continue;
        for (let j = 0; j < list.length; j++) {
          const o = list[j] as { p: ReplenPolicy; c: ReplenCost; w: number };
          if (j > 0 && o.p.k > (maxK[i] as number)) continue;
          const w2 = w + o.w;
          if (w2 > cap) continue;
          const v = base + o.c.total;
          if (v < (nx[w2] as number) - 1e-12) {
            nx[w2] = v;
            from[w2] = w * 64 + j;
          }
        }
      }
      prev.push(from);
      dp = nx;
    });
    let bestW = 0;
    for (let w = 0; w <= cap; w++) if ((dp[w] as number) < (dp[bestW] as number)) bestW = w;
    const pick = choices.map(() => 0);
    if (Number.isFinite(dp[bestW] as number)) {
      let w = bestW;
      for (let i = fams.length - 1; i >= 0; i--) {
        const code = (prev[i] as Int32Array)[w] as number;
        pick[i] = code % 64;
        w = Math.floor(code / 64);
      }
    }
    return pick;
  };
  // 配送车：隔几天送一次的商品族错开送货日（大的先排，排在最空的那几天），算最忙那天要送多少托
  const upp = (f: FamIn) => casesPerPallet(f.fam) * f.fam.unitsPerCase;
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  const peakOf = (ks: number[]): number => {
    const L = ks.reduce((a, k) => (a * k) / gcd(a, k), 1);
    const load = new Float64Array(L);
    const order = fams.map((_, i) => i).sort((x, y) => ((ks[y] as number) * (fams[y] as FamIn).mu) / upp(fams[y] as FamIn) - ((ks[x] as number) * (fams[x] as FamIn).mu) / upp(fams[x] as FamIn));
    for (const i of order) {
      const k = ks[i] as number;
      const size = (k * (fams[i] as FamIn).mu) / upp(fams[i] as FamIn);
      let best = 0;
      let bestMax = Infinity;
      for (let ph = 0; ph < k; ph++) {
        let m = 0;
        for (let d = ph; d < L; d += k) m = Math.max(m, (load[d] as number) + size);
        if (m < bestMax) {
          bestMax = m;
          best = ph;
        }
      }
      for (let d = best; d < L; d += k) load[d] = (load[d] as number) + size;
    }
    return load.reduce((m, x) => Math.max(m, x), 0);
  };
  const kOf = (pick: number[]) => pick.map((j, i) => ((choices[i] as { p: ReplenPolicy }[])[j] as { p: ReplenPolicy }).p.k);
  const peakCur = peakOf(cur.map((p) => p.k));
  // 车装不下：不能比现在最忙那天还多（现在本身就超的按现在算）
  const truckCap = Math.max(truckPallets, peakCur);
  const maxK = choices.map(() => Math.max(...K_OPTIONS));
  let chosen = knapsack(maxK);
  for (let it = 0; it < 24 && peakOf(kOf(chosen)) > truckCap + 1e-6; it++) {
    // 把单次送得最多、又比现在隔得久的那个商品族的间隔缩短一挡，再求
    const ks = kOf(chosen);
    let worst = -1;
    let size = -1;
    ks.forEach((k, i) => {
      const sz = (k * (fams[i] as FamIn).mu) / upp(fams[i] as FamIn);
      if (k > (cur[i] as ReplenPolicy).k && sz > size) {
        size = sz;
        worst = i;
      }
    });
    if (worst < 0) break;
    maxK[worst] = Math.max(...K_OPTIONS.filter((k) => k < (ks[worst] as number)), (cur[worst] as ReplenPolicy).k);
    chosen = knapsack(maxK);
  }
  const rows: ReplenRow[] = fams.map((f, i) => {
    const o = (choices[i] as { p: ReplenPolicy; c: ReplenCost }[])[chosen[i] as number] as { p: ReplenPolicy; c: ReplenCost };
    const c0 = cur[i] as ReplenPolicy;
    return { key: f.fam.key, label: f.fam.label, demand: f.mu, cur: c0, opt: o.p, curCost: curCost[i] as ReplenCost, optCost: o.c, curCheck: simulate(f, c0, opts, CHECK_SEED + i), optCheck: simulate(f, o.p, opts, CHECK_SEED + i) };
  });
  const sum = (g: (r: ReplenRow) => number) => rows.reduce((a, r) => a + g(r), 0);
  const changes: string[] = [];
  for (const r of rows) {
    const parts: string[] = [];
    if (r.opt.k !== r.cur.k) parts.push(r.opt.k > r.cur.k ? `改成每 ${r.opt.k} 天补一次（现在每 ${r.cur.k} 天），补货次数少、单次多送` : `改成每 ${r.opt.k} 天补一次（现在每 ${r.cur.k} 天），库存压得低`);
    if (Math.abs(r.opt.z - r.cur.z) > 1e-9) {
      const why = r.opt.z < r.cur.z ? (r.curCost.waste > r.curCost.short ? '多备的货在报废' : '多压的库存比偶尔缺货贵') : r.curCost.short > r.curCost.waste ? '缺货丢的毛利比多备的库存贵' : '多备一点更稳';
      parts.push(`安全系数 ${r.cur.z.toFixed(2)} → ${r.opt.z.toFixed(2)}（${why}）`);
    }
    if (!parts.length) continue;
    changes.push(`${r.label}：${parts.join('；')}，每天省约 $${(r.curCost.total - r.optCost.total).toFixed(1)}（换一组需求核对：$${(r.curCheck.total - r.optCheck.total).toFixed(1)}）`);
  }
  return {
    rows,
    direct: [...direct],
    capacity,
    usedCur,
    usedOpt: sum((r) => r.optCost.space),
    totalCur: sum((r) => r.curCost.total),
    totalOpt: sum((r) => r.optCost.total),
    checkCur: sum((r) => r.curCheck.total),
    checkOpt: sum((r) => r.optCheck.total),
    ordersCur: sum((r) => 1 / r.cur.k),
    ordersOpt: sum((r) => 1 / r.opt.k),
    truckPallets,
    peakCur,
    peakOpt: peakOf(kOf(chosen)),
    changes,
    ms: now() - t0,
  };
}

/** 门店每个商品族每天的量：当天配送车送到这家店的件数（直送的整车另算） */
export function demandFromBoard(board: Board, storeKey: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of board.ops)
    for (const st of o.stops ?? []) {
      if (st.key !== storeKey || !st.load) continue;
      for (const [k, u] of Object.entries(st.load)) out[k] = (out[k] ?? 0) + u;
    }
  return out;
}

/** 一个托盘放多少件（给界面换算托盘） */
export const unitsPerPallet = (key: string): number => {
  const f = FAMILIES.find((x) => x.key === key);
  return f ? casesPerPallet(f) * f.unitsPerCase : 1;
};
