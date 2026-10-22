import { solve, dot, fitGlm, sigmoid } from './glm';
import { mae } from './metrics';
import { rankReasons, type Reason } from './recommendation';

/**
 * Phase 6 扩展模块的 AI 接入点：出餐时间预测、退货去向判断、大件装载规划。
 */

// ---------------------------------------------------------------------------
// 出餐时间预测：每道菜在本店的系数（向标准时长收缩）+ 负荷效应

export interface PrepSample {
  dishId: string;
  standardMin: number;
  load: number;
  actualMin: number;
}

export interface PrepParams {
  /** 每同时多做一单增加的分钟 */
  perLoad: number;
  /** 菜品 → 收缩后的系数（实际 / 标准） */
  factors: Record<string, number>;
  /** 收缩强度（相当于看过多少次标准时长） */
  k: number;
  residualSd: number;
}

export function fitPrepTime(samples: readonly PrepSample[], k = 5): PrepParams {
  // 先估负荷效应：实际 − 标准 对 负荷做回归（带截距）
  const A = [
    [0, 0],
    [0, 0],
  ];
  const b = [0, 0];
  for (const s of samples) {
    const x = [1, s.load];
    const y = s.actualMin - s.standardMin;
    for (let i = 0; i < 2; i++) {
      b[i] = (b[i] as number) + (x[i] as number) * y;
      for (let j = 0; j < 2; j++) (A[i] as number[])[j] = ((A[i] as number[])[j] as number) + (x[i] as number) * (x[j] as number);
    }
  }
  const [, perLoad] = samples.length >= 5 ? solve(A, b) : [0, 0];
  const by = new Map<string, { n: number; sum: number }>();
  for (const s of samples) {
    const r = (s.actualMin - (perLoad ?? 0) * s.load) / s.standardMin;
    const e = by.get(s.dishId) ?? { n: 0, sum: 0 };
    e.n++;
    e.sum += r;
    by.set(s.dishId, e);
  }
  const factors: Record<string, number> = {};
  for (const [d, e] of by) factors[d] = Math.round(((e.sum + k * 1) / (e.n + k)) * 1000) / 1000;
  const params: PrepParams = { perLoad: Math.round((perLoad ?? 0) * 100) / 100, factors, k, residualSd: 0 };
  const res = samples.map((s) => s.actualMin - predictPrepTime(params, s.dishId, s.standardMin, s.load).minutes);
  params.residualSd = Math.round(Math.sqrt(res.reduce((a, r) => a + r * r, 0) / Math.max(1, res.length)) * 100) / 100;
  return params;
}

export function predictPrepTime(params: PrepParams, dishId: string, standardMin: number, load: number): { minutes: number; reasons: Reason[] } {
  const f = params.factors[dishId] ?? 1;
  const minutes = Math.max(1, standardMin * f + params.perLoad * load);
  const reasons = rankReasons(
    [
      { factor: 'STANDARD_TIME', value: standardMin, weight: 0.0001 },
      { factor: 'DISH_FACTOR', value: f, effect: { kind: 'ADD', amount: Math.round(standardMin * (f - 1) * 10) / 10 }, weight: 0 },
      { factor: 'KITCHEN_LOAD', value: load, effect: { kind: 'ADD', amount: Math.round(params.perLoad * load * 10) / 10 }, weight: 0 },
    ],
    3,
  );
  return { minutes: Math.round(minutes * 10) / 10, reasons };
}

/** 按时间先后评估：前 70% 训练；对照是「按标准时长」 */
export function evaluatePrepTime(samples: readonly PrepSample[]): { params: PrepParams; metrics: Record<string, number> } {
  const cut = Math.floor(samples.length * 0.7);
  const params = fitPrepTime(samples.slice(0, cut));
  const test = samples.slice(cut);
  const act = test.map((s) => s.actualMin);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    params,
    metrics: {
      maeStandard: r3(mae(act, test.map((s) => s.standardMin))),
      maeModel: r3(mae(act, test.map((s) => predictPrepTime(params, s.dishId, s.standardMin, s.load).minutes))),
      n: test.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 退货去向判断：能否再售的概率 + 规则

export type Disposition = 'RESTOCK' | 'DISPOSE' | 'HAZMAT' | 'VENDOR';

export interface ReturnInput {
  condition: 'SEALED' | 'OPENED' | 'DAMAGED';
  tempZone: string;
  perishable: boolean;
  chemical: boolean;
  hoursSinceHandoff: number;
  unitPrice: number;
}

export interface ReturnParams {
  beta: number[];
}

const RETURN_CODES = ['INTERCEPT', 'OPENED', 'DAMAGED', 'COLD_HOURS', 'PERISHABLE', 'PERISHABLE_HOURS', 'CHEMICAL'] as const;

function returnFeatures(r: ReturnInput): number[] {
  const cold = r.tempZone === 'CHILLED' || r.tempZone === 'FROZEN';
  return [1, r.condition === 'OPENED' ? 1 : 0, r.condition === 'DAMAGED' ? 1 : 0, cold ? Math.log1p(r.hoursSinceHandoff) : 0, r.perishable ? 1 : 0, r.perishable ? r.hoursSinceHandoff / 10 : 0, r.chemical ? 1 : 0];
}

export function fitReturnModel(rows: ReadonlyArray<ReturnInput & { resellable: boolean }>): ReturnParams {
  const fit = fitGlm(
    rows.map(returnFeatures),
    rows.map((r) => (r.resellable ? 1 : 0)),
    { family: 'logistic', lambda: 1, penalize: RETURN_CODES.map((_, i) => i > 0) },
  );
  return { beta: fit.beta.map((b) => Math.round(b * 10000) / 10000) };
}

/** 去向建议：化学品 → 危险品回收；能再售的概率 ≥ 0.7 → 回架；高价且损坏 → 退供应商；其余 → 报废 */
export function suggestDisposition(params: ReturnParams, r: ReturnInput): { disposition: Disposition; p: number; reasons: Reason[] } {
  const x = returnFeatures(r);
  const p = Math.round(sigmoid(dot(x, params.beta)) * 1000) / 1000;
  const reasons: Reason[] = [];
  for (let j = 1; j < x.length; j++) {
    const lo = (params.beta[j] as number) * (x[j] as number);
    if (Math.abs(lo) < 0.1) continue;
    const code = RETURN_CODES[j] as string;
    reasons.push({ factor: code, ...(code === 'COLD_HOURS' || code === 'PERISHABLE_HOURS' ? { value: r.hoursSinceHandoff } : {}), effect: { kind: 'MULTIPLY', amount: Math.round(Math.exp(lo) * 100) / 100 }, weight: 0 });
  }
  let disposition: Disposition = p >= 0.7 ? 'RESTOCK' : 'DISPOSE';
  if (r.chemical && r.condition !== 'SEALED') disposition = 'HAZMAT';
  else if (disposition !== 'RESTOCK' && r.condition === 'DAMAGED' && r.unitPrice >= 25 && !r.perishable) disposition = 'VENDOR';
  return { disposition, p, reasons: rankReasons(reasons, 3) };
}

// ---------------------------------------------------------------------------
// 大件装载规划：按重量把一单的大件分成几趟；需要两人搬运的单独一趟

export interface LoadPiece {
  id: string;
  weightKg: number;
  teamLift: boolean;
}

export interface LoadTrip {
  pieceIds: string[];
  weightKg: number;
  teamLift: boolean;
}

/** 首次适应递减：重的先放；每趟不超过 maxKg 和 maxPieces；两人搬运的件单独成趟 */
export function planLoads(pieces: readonly LoadPiece[], maxKg = 25, maxPieces = 4): LoadTrip[] {
  const trips: LoadTrip[] = [];
  for (const p of [...pieces].sort((a, b) => b.weightKg - a.weightKg || a.id.localeCompare(b.id))) {
    if (p.teamLift) {
      trips.push({ pieceIds: [p.id], weightKg: p.weightKg, teamLift: true });
      continue;
    }
    const t = trips.find((x) => !x.teamLift && x.weightKg + p.weightKg <= maxKg && x.pieceIds.length < maxPieces);
    if (t) {
      t.pieceIds.push(p.id);
      t.weightKg = Math.round((t.weightKg + p.weightKg) * 10) / 10;
    } else trips.push({ pieceIds: [p.id], weightKg: p.weightKg, teamLift: false });
  }
  return trips;
}

/** 现有规则：只有未开封、非易腐、常温的商品回架 */
export function ruleDisposition(r: ReturnInput): Disposition {
  if (r.chemical && r.condition !== 'SEALED') return 'HAZMAT';
  return r.condition === 'SEALED' && !r.perishable && r.tempZone === 'AMBIENT' ? 'RESTOCK' : 'DISPOSE';
}

/**
 * 退货去向的评估：前 70% 训练，比较规则与模型的「回架判断」：
 * 准确率、错误回架率（回架了但其实不能再售，食品安全风险）、错失再售率（报废了但其实可以再售，损失）。
 */
export function evaluateReturns(rows: ReadonlyArray<ReturnInput & { resellable: boolean }>): { params: ReturnParams; metrics: Record<string, Record<string, number>> } {
  const cut = Math.floor(rows.length * 0.7);
  const params = fitReturnModel(rows.slice(0, cut));
  const test = rows.slice(cut);
  const score = (decide: (r: ReturnInput) => Disposition) => {
    let ok = 0;
    let falseRestock = 0;
    let missed = 0;
    for (const r of test) {
      const restock = decide(r) === 'RESTOCK';
      if (restock === r.resellable) ok++;
      else if (restock) falseRestock++;
      else missed++;
    }
    const n = Math.max(1, test.length);
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    return { accuracy: r4(ok / n), falseRestock: r4(falseRestock / n), missedResale: r4(missed / n), n: test.length };
  };
  return { params, metrics: { rule: score(ruleDisposition), model: score((r) => suggestDisposition(params, r).disposition) } };
}
