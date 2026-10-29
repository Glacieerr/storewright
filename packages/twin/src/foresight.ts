import type { OpsState, StoreStatic } from '@storewright/ops';
import { forecast, type Forecast, type ForecastKpi, type ForecastOptions, type ForecastRole } from './forecast';

/**
 * 运营预警（决策记录 0021 · 第一批 A2）：问题被看见时往往已经晚了，带班负责人需要的是
 * 「还有 40 分钟，现在做这件事就来得及」。
 *
 * 1. 发现问题：用 AI 驱动的推演（订单量展望 + 批次的 AI 预计用时）看未来几个小时，
 *    找赶不上取货时段的订单、顾客等太久、冷区暂存快满、拣货积压；
 * 2. 列出处置办法：调一个人、请一个人来、提前开始一批订单、冷冻商品晚点拣、通知顾客延后；
 * 3. 试跑：每个办法在推演里跑一遍，按「问题改善 − 代价」打分；乐观和悲观两种订单量下都变好，把握才高。
 * 纯函数，几毫秒：推演本身就是几毫秒的排队计算。
 */

export interface ForesightThresholds {
  /** 赶不上取货时段的订单：不少于几单，或占推演期间到期订单的比例 */
  lateOrders: number;
  latePct: number;
  avgWaitMin: number;
  maxWaitMin: number;
  /** 冷藏、冷冻暂存的最高占用率 */
  coldOccupancy: number;
  /** 拣货积压峰值（分钟） */
  backlogMin: number;
}

export const DEFAULT_FORESIGHT: ForesightThresholds = { lateOrders: 3, latePct: 0.05, avgWaitMin: 5, maxWaitMin: 10, coldOccupancy: 0.9, backlogMin: 60 };

export type ProblemKind = 'LATE' | 'WAIT' | 'COLD_FULL' | 'BACKLOG';

export interface ForesightProblem {
  kind: ProblemKind;
  /** 问题最早出现的时间 */
  at: number;
  value: number;
  limit: number;
  /** 赶不上的订单（现有订单，不含推演里新增的） */
  orders?: string[];
}

export type ForesightAction =
  /** 调一个人：from = OTHER 表示从推演之外的岗位（补货、后仓）调来，只增加目标岗位 */
  | { kind: 'MOVE'; from: ForecastRole | 'OTHER'; to: ForecastRole }
  | { kind: 'CALL_IN'; role: ForecastRole }
  | { kind: 'EXPEDITE'; orderIds: string[] }
  | { kind: 'DEFER_FROZEN'; orderIds: string[]; until: number }
  | { kind: 'NOTIFY_DELAY'; orderIds: string[]; minutes: number };

export interface ForesightOption {
  action: ForesightAction;
  kpi: ForecastKpi;
  /** 推演里的问题改善（同一量纲的罚分之差）与代价 */
  gain: number;
  cost: number;
  /** 乐观、悲观两种订单量下也都变好 */
  robust: boolean;
}

export interface ForesightReason {
  factor: string;
  value: number;
  params?: Record<string, string | number>;
}

export interface ForesightResult {
  base: Forecast;
  problems: ForesightProblem[];
  /** 改善足够大的办法，最好的在前 */
  options: ForesightOption[];
  reasons: ForesightReason[];
}

export interface ForesightOptions {
  horizonMin?: number;
  thresholds?: Partial<ForesightThresholds>;
  /** 各岗位此刻可以调出来的人数（没在忙、没被锁定、在班次里）；OTHER 是补货、后仓等推演之外的岗位 */
  movable?: Partial<Record<ForecastRole | 'OTHER', number>>;
  /** 可以请人提前来或延长（需要店长） */
  callIn?: boolean;
  /** 试跑的办法的最低净改善 */
  minGain?: number;
}

const MIN = 60_000;

/** 推演结果的罚分：迟到订单最重，其次是等待、冷区快满、积压 */
export function penalty(k: ForecastKpi): number {
  return 3 * k.late + 1.2 * Math.max(0, k.avgWaitMin - 2) + 0.3 * Math.max(0, k.maxWaitMin - 6) + 25 * Math.max(0, k.peakColdOccupancy - 0.85) + Math.max(0, k.peakBacklogMin - 30) / 15;
}

const COST: Record<ForesightAction['kind'], number> = { MOVE: 0.6, CALL_IN: 2.5, EXPEDITE: 0.2, DEFER_FROZEN: 0.4, NOTIFY_DELAY: 0 };
/** 从补货、后仓调人：那边的活会往后推，代价比在线订单岗位之间互调高一点 */
const OTHER_MOVE_COST = 0.9;

export function detectProblems(f: Forecast, th: ForesightThresholds): ForesightProblem[] {
  const out: ForesightProblem[] = [];
  const end = f.at + f.horizonMin * MIN;
  const due = f.orders.filter((o) => o.dueAt <= end && o.dueAt > f.at);
  const late = due.filter((o) => o.late);
  if (late.length >= th.lateOrders || (due.length >= 10 && late.length / due.length >= th.latePct && late.length >= 2)) {
    const real = late.filter((o) => !o.projected);
    out.push({ kind: 'LATE', at: Math.min(...late.map((o) => o.dueAt)), value: late.length, limit: th.lateOrders, ...(real.length ? { orders: real.map((o) => o.orderId) } : {}) });
  }
  if (f.kpi.avgWaitMin > th.avgWaitMin || f.kpi.maxWaitMin > th.maxWaitMin) {
    const peak = f.steps.reduce((m, x) => (x.waiting > m.waiting ? x : m), f.steps[0] ?? { t: f.at, waiting: 0 });
    out.push({ kind: 'WAIT', at: peak.t, value: f.kpi.avgWaitMin > th.avgWaitMin ? f.kpi.avgWaitMin : f.kpi.maxWaitMin, limit: f.kpi.avgWaitMin > th.avgWaitMin ? th.avgWaitMin : th.maxWaitMin });
  }
  if (f.kpi.peakColdOccupancy > th.coldOccupancy) out.push({ kind: 'COLD_FULL', at: f.at, value: f.kpi.peakColdOccupancy, limit: th.coldOccupancy });
  if (f.kpi.peakBacklogMin > th.backlogMin) {
    const peak = f.steps.reduce((m, x) => (x.backlogMin > m.backlogMin ? x : m), f.steps[0] ?? { t: f.at, backlogMin: 0 });
    out.push({ kind: 'BACKLOG', at: peak.t, value: f.kpi.peakBacklogMin, limit: th.backlogMin });
  }
  return out;
}

function optsFor(a: ForesightAction): ForecastOptions {
  switch (a.kind) {
    case 'MOVE':
      return { staffDelta: a.from === 'OTHER' ? { [a.to]: 1 } : { [a.from]: -1, [a.to]: 1 } };
    case 'CALL_IN':
      return { staffDelta: { [a.role]: 1 } };
    case 'EXPEDITE':
      return { expedite: a.orderIds };
    case 'DEFER_FROZEN':
      return { deferFrozen: { orderIds: a.orderIds, until: a.until } };
    case 'NOTIFY_DELAY':
      return {};
  }
}

/** 根据问题列出可以试的办法 */
export function candidateActions(s: OpsState, f: Forecast, problems: readonly ForesightProblem[], o: ForesightOptions): ForesightAction[] {
  const out: ForesightAction[] = [];
  const kinds = new Set(problems.map((p) => p.kind));
  const movable = o.movable ?? {};
  const target: ForecastRole[] = [];
  if (kinds.has('LATE') || kinds.has('BACKLOG')) target.push('PICK');
  if (kinds.has('WAIT') || kinds.has('COLD_FULL')) target.push('HANDOFF');
  for (const to of target) {
    for (const from of ['PICK', 'STAGE', 'HANDOFF', 'OTHER'] as const) if (from !== to && (movable[from] ?? 0) > 0) out.push({ kind: 'MOVE', from, to });
    if (o.callIn) out.push({ kind: 'CALL_IN', role: to });
  }
  if (kinds.has('LATE') || kinds.has('BACKLOG')) {
    // 提前开始：还没到锁单时间、时段最早的几单
    const created = Object.values(s.orders)
      .filter((x) => x.status === 'CREATED' && !x.expedite)
      .sort((a, b) => a.slotStart - b.slotStart || a.id.localeCompare(b.id))
      .slice(0, 6)
      .map((x) => x.id);
    if (created.length) out.push({ kind: 'EXPEDITE', orderIds: created });
  }
  if (kinds.has('COLD_FULL')) {
    // 冷冻商品晚点拣：顾客一个多小时后才到、冷冻框还没进批次的订单
    const later = f.orders.filter((x) => !x.projected && x.arriveAt - f.at >= 60 * MIN && x.readyAt === undefined).map((x) => x.orderId);
    const ids = later.filter((id) => {
      const ord = s.orders[id];
      return !!ord && (ord.status === 'CREATED' || ord.toteIds.some((t) => s.totes[t]?.tempZone === 'FROZEN' && s.totes[t]?.status === 'PLANNED'));
    });
    if (ids.length) {
      const first = Math.min(...ids.map((id) => f.orders.find((x) => x.orderId === id)?.arriveAt ?? f.at));
      out.push({ kind: 'DEFER_FROZEN', orderIds: ids.slice(0, 8), until: Math.max(f.at + 30 * MIN, first - 40 * MIN) });
    }
  }
  return out;
}

/** 罚分随订单量变化：乐观、预计、悲观三条线 */
function bandsOf(s: OpsState, st: StoreStatic, now: number, horizonMin: number, extra: ForecastOptions): [ForecastKpi, ForecastKpi, ForecastKpi] {
  return [forecast(s, st, now, { horizonMin, ...extra, band: 'low' }).kpi, forecast(s, st, now, { horizonMin, ...extra }).kpi, forecast(s, st, now, { horizonMin, ...extra, band: 'high' }).kpi];
}

export function foresee(s: OpsState, st: StoreStatic, now: number, o: ForesightOptions = {}): ForesightResult {
  const horizonMin = o.horizonMin ?? 120;
  const th = { ...DEFAULT_FORESIGHT, ...o.thresholds };
  const base = forecast(s, st, now, { horizonMin });
  const problems = detectProblems(base, th);
  const reasons = reasonsFor(base);
  if (!problems.length) return { base, problems, options: [], reasons };
  const baseBands = bandsOf(s, st, now, horizonMin, {});
  const options: ForesightOption[] = [];
  for (const action of candidateActions(s, base, problems, o)) {
    const kpis = bandsOf(s, st, now, horizonMin, optsFor(action));
    const gains = kpis.map((k, i) => penalty(baseBands[i] as ForecastKpi) - penalty(k));
    const gain = Math.round((gains[1] as number) * 100) / 100;
    const cost = action.kind === 'MOVE' && action.from === 'OTHER' ? OTHER_MOVE_COST : COST[action.kind];
    if (gain - cost < (o.minGain ?? 1)) continue;
    options.push({ action, kpi: kpis[1] as ForecastKpi, gain, cost, robust: (gains[0] as number) > 0 && (gains[2] as number) > 0 });
  }
  options.sort((a, b) => b.gain - b.cost - (a.gain - a.cost) || a.cost - b.cost);
  // 迟到已经避免不了（最好的办法之后仍有迟到的现有订单）：通知这些顾客延后。
  // 只通知取货时段还没开始、延后不超过 3 小时的（早就过了时段的订单通知「延后多久」没有意义，由带班负责人另行联系）
  const late = problems.find((p) => p.kind === 'LATE');
  if (late?.orders?.length) {
    const after = options[0] ? forecast(s, st, now, { horizonMin, ...optsFor(options[0].action) }) : base;
    const still = after.orders.filter((x) => !x.projected && x.late && late.orders?.includes(x.orderId) && x.readyAt !== undefined && x.dueAt >= now && (x.readyAt as number) - x.dueAt <= 180 * MIN);
    if (still.length) {
      const minutes = Math.max(5, Math.ceil(Math.max(...still.map((x) => ((x.readyAt as number) - x.dueAt) / MIN)) / 5) * 5);
      options.push({ action: { kind: 'NOTIFY_DELAY', orderIds: still.map((x) => x.orderId).slice(0, 10), minutes }, kpi: after.kpi, gain: 0, cost: 0, robust: true });
    }
  }
  return { base, problems, options, reasons };
}

/** 为什么会出问题：今天的单量比预测多、拣货比计划慢、在岗人数、接下来还会来的单数 */
function reasonsFor(f: Forecast): ForesightReason[] {
  const b = f.basis;
  const out: ForesightReason[] = [];
  if (b.outlook && Math.abs(b.outlook.correction - 1) >= 0.08) out.push({ factor: 'DEMAND_VS_FORECAST', value: Math.round((b.outlook.correction - 1) * 100) });
  const slow = b.aiFactor ?? (b.measured.pick ? b.pickFactor : 1);
  if (Math.abs(slow - 1) >= 0.08) out.push({ factor: 'PICK_PACE', value: Math.round((slow - 1) * 100) });
  out.push({ factor: 'STAFF_ON_DUTY', value: b.staff.PICK + b.staff.STAGE + b.staff.HANDOFF, params: { pick: b.staff.PICK, stage: b.staff.STAGE, handoff: b.staff.HANDOFF } });
  if (f.kpi.projectedOrders > 0) out.push({ factor: 'MORE_ORDERS', value: f.kpi.projectedOrders, params: { hours: Math.round(f.horizonMin / 60) } });
  return out;
}
