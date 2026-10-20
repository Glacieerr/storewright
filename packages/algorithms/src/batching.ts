import type { PickInstruction, PickStop, PickWalk, TempZone, ToteAssignment } from '@storewright/domain';
import type { RulesConfig } from '@storewright/store-config';
import { DEFAULT_PICK_STANDARDS, getItem, type PickStandards, type PlanningContext } from './context';
import { routeSShape, routeTsp } from './routing';

/** 冷链时限（决策 P-12）：clamp(base + perItem × 件数, min, max)，单位秒 */
export function coldChainLimitSec(units: number, rules: RulesConfig['coldChain']): number {
  const min = rules.baseMin + rules.perItemMin * units;
  return Math.round(Math.min(rules.maxMin, Math.max(rules.minMin, min)) * 60);
}

export const isColdZone = (z: TempZone): boolean => z === 'CHILLED' || z === 'FROZEN';

/**
 * 批次模块看到的框任务摘要：只有框号、温区、截止时间、行数、件数和所涉通道。
 * 刻意不包含重量和体积（工程约束 EC-1）。
 */
export interface ToteSummary {
  id: string;
  orderId: string;
  index: number;
  tempZone: TempZone;
  fulfillmentType: ToteAssignment['fulfillmentType'];
  slotStart: number;
  dueAt: number;
  lines: number;
  units: number;
  runSequences: number[];
}

export function summarize(ctx: PlanningContext, t: ToteAssignment): ToteSummary {
  const runs = new Set<number>();
  let units = 0;
  for (const l of t.lines) {
    const item = getItem(ctx, l.itemId);
    const loc = ctx.model.location(item.locationIds[0] as string);
    runs.add(loc.runSequence);
    units += l.qty;
  }
  return {
    id: t.id,
    orderId: t.orderId,
    index: t.index,
    tempZone: t.tempZone,
    fulfillmentType: t.fulfillmentType,
    slotStart: t.slotStart,
    dueAt: t.dueAt,
    lines: t.lines.length,
    units,
    runSequences: [...runs].sort((a, b) => a - b),
  };
}

interface Unit {
  orderId: string;
  firstIndex: number;
  totes: ToteSummary[];
  runSequences: number[];
}

export interface BatchingOptions {
  strategy: 'ZONE_PARTITION' | 'FIFO';
  routing: 'TSP' | 'SSHAPE';
  standards?: PickStandards;
  /** 是否用冷链时限约束批次大小 */
  enforceColdLimit: boolean;
  /** 划分单位：ORDER = 同一订单同温区的框同车（默认）；TOTE = 允许拆开 */
  unit?: 'ORDER' | 'TOTE';
}

function estimateSec(group: readonly ToteSummary[], s: PickStandards): { sec: number; units: number } {
  const runs = new Set<number>();
  let lines = 0;
  let units = 0;
  for (const t of group) {
    lines += t.lines;
    units += t.units;
    for (const r of t.runSequences) runs.add(r);
  }
  return { sec: s.baseSec + lines * s.perLineSec + units * s.perUnitSec + runs.size * s.perRunSec, units };
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? (xs[m] as number) : ((xs[m - 1] as number) + (xs[m] as number)) / 2;
}

/**
 * 把 n 个划分单位切成恰好 k 段连续区间，每段满足 feasible（框数 ≤ 每车框数、冷链时预计用时 ≤ 时限），
 * 并使各段预计用时之和最小（动态规划）。不可行时返回 undefined。
 */
function partitionIntoK(
  n: number,
  k: number,
  cost: (i: number, j: number) => number,
  /** 单调约束（区间变大后不会重新满足），例如框数上限 */
  fits: (i: number, j: number) => boolean,
  /** 其他约束，例如冷链时限 */
  feasible: (i: number, j: number) => boolean,
): { total: number; groups: number[][] } | undefined {
  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(INF));
  const cut: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(-1));
  (dp[0] as number[])[0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n; i++) {
      for (let p = i - 1; p >= j - 1; p--) {
        if (!fits(p, i)) break; // 区间越往前越大，超过每车框数后不必再看
        if (!feasible(p, i)) continue;
        const prev = (dp[j - 1] as number[])[p] as number;
        if (prev === INF) continue;
        const v = prev + cost(p, i);
        if (v < ((dp[j] as number[])[i] as number) - 1e-9) {
          (dp[j] as number[])[i] = v;
          (cut[j] as number[])[i] = p;
        }
      }
    }
  }
  const total = (dp[k] as number[])[n] as number;
  if (total === INF) return undefined;
  const groups: number[][] = [];
  let i = n;
  for (let j = k; j >= 1; j--) {
    const p = (cut[j] as number[])[i] as number;
    groups.unshift(Array.from({ length: i - p }, (_, x) => p + x));
    i = p;
  }
  return { total, groups };
}

/**
 * 全局划分（工程约束 EC-2、EC-3）：
 * 1. 按温区 × 履约类型 × 时段分组（常温同车、冷藏同车、冷冻同车）；
 * 2. 组内按「所涉通道的中位顺序、最小顺序、最大顺序、订单号、框序号」排序——与输入顺序无关；
 * 3. 同一订单在同一温区的框作为一个划分单位（同车）；
 * 4. 对每个候选推车数 k（从 ⌈框数 / 每车框数⌉ 起）：固定 k，把排序后的单位序列切成 k 段，使预计总用时最小；
 *    每段框数 ≤ 每车框数、冷链批次 ≤ 时限；最后取总用时最小的 k。
 */
export function partitionTotes(ctx: PlanningContext, summaries: readonly ToteSummary[], options: BatchingOptions): ToteSummary[][] {
  const cap = ctx.model.config.equipment.cart.totesPerCart;
  const s = options.standards ?? DEFAULT_PICK_STANDARDS;
  const groups = new Map<string, ToteSummary[]>();
  for (const t of summaries) {
    const key = `${t.tempZone}|${t.fulfillmentType}|${String(t.slotStart).padStart(6, '0')}`;
    const g = groups.get(key) ?? [];
    g.push(t);
    groups.set(key, g);
  }
  const out: ToteSummary[][] = [];
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    const group = groups.get(key) as ToteSummary[];
    if (options.strategy === 'FIFO') {
      const sorted = [...group].sort((a, b) => a.orderId.localeCompare(b.orderId) || a.index - b.index);
      for (let i = 0; i < sorted.length; i += cap) out.push(sorted.slice(i, i + cap));
      continue;
    }
    // 划分单位：同一订单在同一温区的框作为整体，放在同一辆推车上，避免订单被拆到多辆车而推迟就绪
    const byOrder = new Map<string, ToteSummary[]>();
    for (const t of group) {
      const list = byOrder.get(t.orderId) ?? [];
      list.push(t);
      byOrder.set(t.orderId, list);
    }
    const units: Unit[] = [];
    const unitSize = options.unit === 'TOTE' ? 1 : cap;
    for (const [orderId, totes] of byOrder) {
      totes.sort((a, b) => a.index - b.index);
      for (let i = 0; i < totes.length; i += unitSize) {
        const chunk = totes.slice(i, i + unitSize);
        const runs = [...new Set(chunk.flatMap((x) => x.runSequences))].sort((a, b) => a - b);
        units.push({ orderId, firstIndex: chunk[0]?.index ?? 0, totes: chunk, runSequences: runs });
      }
    }
    units.sort(
      (a, b) =>
        median(a.runSequences) - median(b.runSequences) ||
        (a.runSequences[0] ?? 0) - (b.runSequences[0] ?? 0) ||
        (a.runSequences[a.runSequences.length - 1] ?? 0) - (b.runSequences[b.runSequences.length - 1] ?? 0) ||
        a.orderId.localeCompare(b.orderId) ||
        a.firstIndex - b.firstIndex,
    );
    const cold = options.enforceColdLimit && isColdZone(group[0]?.tempZone ?? 'AMBIENT');
    const n = units.length;
    const prefixTotes = [0];
    for (const u of units) prefixTotes.push((prefixTotes[prefixTotes.length - 1] as number) + u.totes.length);
    const totesIn = (i: number, j: number) => (prefixTotes[j] as number) - (prefixTotes[i] as number);
    const costCache = new Map<number, { sec: number; units: number }>();
    const est = (i: number, j: number) => {
      const key = i * 100003 + j;
      let v = costCache.get(key);
      if (!v) {
        v = estimateSec(units.slice(i, j).flatMap((u) => u.totes), s);
        costCache.set(key, v);
      }
      return v;
    };
    const cost = (i: number, j: number) => est(i, j).sec;
    const fits = (i: number, j: number) => totesIn(i, j) <= cap;
    const feasible = (i: number, j: number) => {
      if (!cold || j - i === 1) return true; // 单个单位总是允许
      const e = est(i, j);
      return e.sec <= coldChainLimitSec(e.units, ctx.model.config.rules.coldChain);
    };
    // 对每个候选推车数 k：先固定 k，再求总用时最小的划分；取总用时最小的 k
    let best: { total: number; groups: number[][] } | undefined;
    let worse = 0;
    for (let k = Math.max(1, Math.ceil(totesIn(0, n) / cap)); k <= n; k++) {
      const res = partitionIntoK(n, k, cost, fits, feasible);
      if (!res) continue;
      if (!best || res.total < best.total - 1e-9) {
        best = res;
        worse = 0;
      } else if (++worse >= 3) break;
    }
    for (const p of best?.groups ?? units.map((_, i) => [i])) out.push(p.flatMap((i) => (units[i] as Unit).totes));
  }
  return out;
}

/** 为一个批次生成拣货清单：按路线顺序排列的拣货站点（工程约束 EC-5：拣货顺序就是路线顺序） */
export function buildWalk(ctx: PlanningContext, id: string, totes: readonly ToteAssignment[], options: BatchingOptions): PickWalk {
  const { model } = ctx;
  const s = options.standards ?? DEFAULT_PICK_STANDARDS;
  const byLocation = new Map<string, PickInstruction[]>();
  for (const t of totes) {
    for (const l of t.lines) {
      const item = getItem(ctx, l.itemId);
      const locId = item.locationIds[0] as string;
      const list = byLocation.get(locId) ?? [];
      list.push({ toteAssignmentId: t.id, lineId: l.lineId, itemId: l.itemId, qty: l.qty });
      byLocation.set(locId, list);
    }
  }
  const locs = [...byLocation.keys()].map((id) => model.location(id));
  const start = model.cartDepotNode;
  const end = model.stagingNode;
  const route =
    options.routing === 'TSP'
      ? routeTsp(model, locs.map((l) => l.nodeId), start, end)
      : routeSShape(
          model,
          locs.map((l) => ({ node: l.nodeId, runSequence: l.runSequence, along: l.bay })),
          start,
          end,
        );
  const rank = new Map<number, number>();
  route.order.forEach((n, i) => {
    if (!rank.has(n)) rank.set(n, i);
  });
  const stops: PickStop[] = locs
    .sort((a, b) => (rank.get(a.nodeId) ?? 0) - (rank.get(b.nodeId) ?? 0) || a.side.localeCompare(b.side) || a.level - b.level || a.id.localeCompare(b.id))
    .map((l) => ({ locationId: l.id, nodeId: l.nodeId, picks: byLocation.get(l.id) as PickInstruction[] }));

  const summaries = totes.map((t) => summarize(ctx, t));
  const e = estimateSec(summaries, s);
  const zone = totes[0]?.tempZone ?? 'AMBIENT';
  const walk: PickWalk = {
    id,
    tempZone: zone,
    fulfillmentType: totes[0]?.fulfillmentType ?? 'GROCERY',
    toteAssignmentIds: totes.map((t) => t.id),
    stops,
    distanceM: Math.round(route.distanceM * 10) / 10,
    estimatedSec: Math.round(e.sec),
    dueAt: Math.min(...totes.map((t) => t.dueAt)),
  };
  if (isColdZone(zone)) walk.coldLimitSec = coldChainLimitSec(e.units, model.config.rules.coldChain);
  return walk;
}

/** 分批 + 生成拣货清单 */
export function planPickWalks(ctx: PlanningContext, totes: readonly ToteAssignment[], options: BatchingOptions, idPrefix = 'W'): PickWalk[] {
  const byId = new Map(totes.map((t) => [t.id, t]));
  const parts = partitionTotes(ctx, totes.map((t) => summarize(ctx, t)), options);
  return parts.map((p, i) => buildWalk(ctx, `${idPrefix}${i + 1}`, p.map((s) => byId.get(s.id) as ToteAssignment), options));
}
