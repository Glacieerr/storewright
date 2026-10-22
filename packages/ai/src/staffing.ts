import { rankReasons, type Reason } from './recommendation';

/**
 * 人员调配（Phase 5c）：排班建议与实时调度。
 *
 * 排班建议：由每小时的订单预测算出各岗位的工作量（人分钟），在**总工时不变**的前提下，
 * 按工作量重新分配到各小时（每小时至少保留最低人数），整数化用最大余数法。
 * 这样比较的是「同样的人手放在哪个小时」，不会靠多排人取胜。
 *
 * 实时调度：交付区按短时排队（现有排队 + 接下来一刻钟的到达，先到先服务）估算顾客平均等待；拣货按待拣工作量和截止时间估算迟到。
 * 试着把一个人从某个岗位调到另一个岗位，如果总代价（等待分钟 × 权重 + 迟到分钟 × 权重）明显下降就建议调动。
 * 只在员工层面做调动建议，不对个人效率排名；被管理员锁定的员工不会被调动；同岗位里优先调今天工作量少的人（负荷均衡）。
 */

export type StaffRole = 'pick' | 'stage' | 'handoff';
export const STAFF_ROLES: readonly StaffRole[] = ['pick', 'stage', 'handoff'];

export interface WorkloadParams {
  /** 每单平均商品行数 */
  linesPerOrder: number;
  /** 每行拣货秒数（走到货位 + 取货 + 扫描） */
  pickSecPerLine: number;
  /** 每单的固定拣货开销（贴标签、装框） */
  pickSecPerOrder: number;
  /** 拣货在时段开始前多少小时完成（工作量平摊到这几个小时） */
  pickLeadHours: number;
  /** 每单暂存秒数（每单约 2–3 框） */
  stageSecPerOrder: number;
  /** 每单交付秒数（取框、走到车边、核验、装车） */
  handoffSecPerOrder: number;
  /** 自取订单占比（只有自取需要交付区） */
  pickupShare: number;
}

export const DEFAULT_WORKLOAD: WorkloadParams = {
  linesPerOrder: 20,
  pickSecPerLine: 55,
  pickSecPerOrder: 60,
  pickLeadHours: 2,
  stageSecPerOrder: 30,
  handoffSecPerOrder: 240,
  pickupShare: 0.45,
};

/** 每小时的工作量（人分钟），输入为按取货时段开始小时统计的订单量 */
export function workloadByHour(ordersByHour: readonly number[], p: WorkloadParams = DEFAULT_WORKLOAD): Record<StaffRole, number[]> {
  const pick = new Array<number>(24).fill(0);
  const stage = new Array<number>(24).fill(0);
  const handoff = new Array<number>(24).fill(0);
  ordersByHour.forEach((n, h) => {
    if (!n) return;
    const pickMin = (n * (p.linesPerOrder * p.pickSecPerLine + p.pickSecPerOrder)) / 60;
    const lead = Math.max(1, Math.round(p.pickLeadHours));
    for (let k = 1; k <= lead; k++) {
      const hh = h - k;
      if (hh >= 0) pick[hh] = (pick[hh] as number) + pickMin / lead;
    }
    if (h - 1 >= 0) stage[h - 1] = (stage[h - 1] as number) + (n * p.stageSecPerOrder) / 60;
    handoff[h] = (handoff[h] as number) + (n * p.pickupShare * p.handoffSecPerOrder) / 60;
  });
  return { pick, stage, handoff };
}

/**
 * 把一天的总工时（人小时）按工作量分配到各小时。
 * minimum[h]：该小时至少几人（营业时间内通常为 1）；工作量为 0 的小时只排最低人数。
 */
export function allocateHours(workload: readonly number[], totalHours: number, minimum: readonly number[]): number[] {
  const n = workload.length;
  const out = minimum.map((m) => Math.max(0, Math.round(m)));
  let left = Math.round(totalHours) - out.reduce((a, b) => a + b, 0);
  if (left <= 0) return out;
  const w = workload.map((x) => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return out;
  // 先按比例分整数部分，再按余数从大到小补齐
  const shares = w.map((x) => (x / sum) * left);
  const floors = shares.map(Math.floor);
  for (let h = 0; h < n; h++) out[h] = (out[h] as number) + (floors[h] as number);
  left -= floors.reduce((a, b) => a + b, 0);
  const order = shares.map((x, h) => ({ h, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.h - b.h);
  for (let i = 0; i < left && i < order.length; i++) {
    const h = (order[i] as { h: number }).h;
    out[h] = (out[h] as number) + 1;
  }
  return out;
}

export interface StaffPlan {
  plan: Record<StaffRole, number[]>;
  workload: Record<StaffRole, number[]>;
}

/** 排班建议：各岗位总工时与当前排班相同，按预测工作量重新分配 */
export function planStaffing(ordersByHour: readonly number[], current: Record<StaffRole, readonly number[]>, p: WorkloadParams = DEFAULT_WORKLOAD): StaffPlan {
  const workload = workloadByHour(ordersByHour, p);
  const plan = {} as Record<StaffRole, number[]>;
  for (const r of STAFF_ROLES) {
    const cur = current[r];
    const total = cur.reduce((a, b) => a + b, 0);
    // 当前排班有人的小时至少保留 1 人（开门准备、收尾、覆盖午休）
    const minimum = cur.map((v) => (v > 0 ? 1 : 0));
    plan[r] = allocateHours(workload[r], total, minimum);
  }
  return { plan, workload };
}

// ---------------------------------------------------------------------------
// 实时调度

/** Erlang C：c 个服务台、到达率 λ（每分钟）、平均服务时间 s（分钟）时的平均排队等待（分钟）；超载时返回 Infinity */
export function erlangCWait(lambda: number, serviceMin: number, c: number): number {
  if (lambda <= 0) return 0;
  if (c <= 0) return Infinity;
  const a = lambda * serviceMin;
  const rho = a / c;
  if (rho >= 1) return Infinity;
  let sum = 0;
  let term = 1;
  for (let k = 0; k < c; k++) {
    if (k > 0) term *= a / k;
    sum += term;
  }
  const last = (term * a) / c / (1 - rho);
  const pWait = last / (sum + last);
  return (pWait * serviceMin) / (c - a);
}

/**
 * 短时排队：现在有 waiting 位顾客在等，接下来 horizon 分钟里均匀到达 arriving 位，c 个人每位服务 s 分钟（先到先服务）。
 * 返回所有这些顾客的平均等待（分钟）。比稳态公式更适合「接下来一刻钟」的判断，人数越多等待越短（单调）。
 */
export function queueWait(waiting: number, arriving: number, horizonMin: number, serviceMin: number, c: number): number {
  const n = Math.max(0, Math.round(waiting)) + Math.max(0, Math.round(arriving));
  if (!n) return 0;
  if (c <= 0) return 60;
  const free = new Array<number>(c).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const arrive = i < waiting ? 0 : ((i - waiting + 0.5) / Math.max(1, arriving)) * horizonMin;
    let k = 0;
    for (let j = 1; j < c; j++) if ((free[j] as number) < (free[k] as number)) k = j;
    const start = Math.max(arrive, free[k] as number);
    total += start - arrive;
    free[k] = start + serviceMin;
  }
  return total / n;
}

export interface DispatchState {
  /** 各岗位在岗人数 */
  staff: Record<StaffRole, number>;
  /** 交付：已到达在等的顾客数、接下来 horizon 分钟内预计到达的顾客数 */
  waiting: number;
  arriving: number;
  horizonMin: number;
  handoffServiceMin: number;
  /** 拣货：待拣工作量（分钟）与最早截止还有多少分钟 */
  pickBacklogMin: number;
  pickDueInMin: number;
  /** 暂存：待暂存的框数与每框分钟 */
  stageBacklog: number;
  stageMinPerTote: number;
}

export interface DispatchCost {
  handoffWaitMin: number;
  pickLateMin: number;
  stageDelayMin: number;
  total: number;
}

const WEIGHTS = { handoff: 1.5, pick: 1, stage: 0.5 };

/** 当前人手下的代价估计 */
export function dispatchCost(s: DispatchState): DispatchCost {
  const handoffWaitMin = Math.min(60, queueWait(s.waiting, s.arriving, s.horizonMin, s.handoffServiceMin, s.staff.handoff));
  const finishPick = s.staff.pick > 0 ? s.pickBacklogMin / s.staff.pick : s.pickBacklogMin > 0 ? 240 : 0;
  const pickLateMin = Math.max(0, finishPick - s.pickDueInMin);
  const stageDelayMin = s.staff.stage > 0 ? (s.stageBacklog * s.stageMinPerTote) / s.staff.stage : s.stageBacklog > 0 ? 30 : 0;
  const total = WEIGHTS.handoff * handoffWaitMin * (s.waiting + s.arriving) + WEIGHTS.pick * pickLateMin + WEIGHTS.stage * stageDelayMin;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { handoffWaitMin: r1(handoffWaitMin), pickLateMin: r1(pickLateMin), stageDelayMin: r1(stageDelayMin), total: r1(total) };
}

export interface DispatchAdvice {
  from: StaffRole;
  to: StaffRole;
  before: DispatchCost;
  after: DispatchCost;
  /** 代价下降的比例 */
  gain: number;
  reasons: Reason[];
}

/**
 * 试遍「从 A 调 1 人到 B」，返回代价下降最多的方案；下降不足 minGain（相对）或绝对值太小时不建议。
 * movable[r]：岗位 r 里可以调动的人数（未锁定、手上没有进行中的任务）。
 */
export function adviseDispatch(s: DispatchState, movable: Record<StaffRole, number>, minGain = 0.25, minAbs = 3): DispatchAdvice | undefined {
  const before = dispatchCost(s);
  let best: DispatchAdvice | undefined;
  for (const from of STAFF_ROLES)
    for (const to of STAFF_ROLES) {
      if (from === to || (movable[from] ?? 0) <= 0 || s.staff[from] <= 1) continue;
      const next: DispatchState = { ...s, staff: { ...s.staff, [from]: s.staff[from] - 1, [to]: s.staff[to] + 1 } };
      const after = dispatchCost(next);
      const drop = before.total - after.total;
      if (drop <= 0) continue;
      const gain = before.total > 0 ? drop / before.total : 0;
      if (!best || drop > before.total - best.after.total) best = { from, to, before, after, gain: Math.round(gain * 1000) / 1000, reasons: [] };
    }
  if (!best || best.gain < minGain || before.total - best.after.total < minAbs) return undefined;
  const reasons: Reason[] = [];
  if (best.to === 'handoff' || best.from === 'handoff') reasons.push({ factor: 'HANDOFF_QUEUE', value: s.waiting, weight: 0, effect: { kind: 'ADD', amount: best.after.handoffWaitMin - best.before.handoffWaitMin }, params: { arriving: s.arriving, horizon: s.horizonMin } });
  if (best.to === 'pick' || best.from === 'pick') reasons.push({ factor: 'PICK_BACKLOG', value: Math.round(s.pickBacklogMin), weight: 0, effect: { kind: 'ADD', amount: best.after.pickLateMin - best.before.pickLateMin }, params: { due: Math.round(s.pickDueInMin) } });
  if (best.to === 'stage' || best.from === 'stage') reasons.push({ factor: 'STAGE_BACKLOG', value: s.stageBacklog, weight: 0, effect: { kind: 'ADD', amount: best.after.stageDelayMin - best.before.stageDelayMin } });
  reasons.push({ factor: 'IDLE_IN_SOURCE', value: movable[best.from] ?? 0, weight: 0.0001, params: { role: best.from } });
  best.reasons = rankReasons(reasons, 4);
  return best;
}
