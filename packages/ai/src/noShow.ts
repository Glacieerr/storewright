import { dot, fitGlm } from './glm';
import { auc, brier, expectedCalibrationError } from './metrics';
import type { Reason } from './recommendation';
import type { GatePolicy } from './registry';

/**
 * 未取订单的风险（决策记录 0023 · 第三批 B5）：顾客下了自取单、最后没来。
 *
 * 用途：风险高的订单冷冻商品不提前拣（来了再拣也来得及，省得冷冻格位被占满、最后退回货架）；营业结束前提醒联系顾客。
 * - 对照：规则（到取货时段前 30 分钟还没报预计到达就算有风险）；
 * - 模型：逻辑回归。特征：下单提前量、当天临时下单、晚上的时段、下雨、没报预计到达、
 *   这位顾客以前的爽约率（经验贝叶斯收缩：先验相当于 2 单、爽约率 5%，新顾客等于大家的平均）、老顾客、周末。
 * 评估：按时间先后，前 70% 训练、后 30% 评估；看 Brier 分数、AUC、校准误差，以及风险最高的一成订单抓到了多少爽约。
 */

export const NOSHOW_VARIANTS = ['noshow-rule', 'noshow-logistic'] as const;
export type NoShowVariant = (typeof NOSHOW_VARIANTS)[number];

export interface NoShowInput {
  aheadH: number;
  slotHour: number;
  dow: number;
  rain: boolean;
  etaShared: boolean;
  pastOrders: number;
  pastNoShows: number;
}

export interface NoShowParams {
  variant: NoShowVariant;
  beta: number[];
  /** 训练数据里的平均爽约率 */
  base: number;
}

export const NOSHOW_GATE: GatePolicy = {
  primary: { metric: 'brier', lowerIsBetter: true },
  minImprovement: 0.01,
  guardrails: [{ metric: 'ece', lowerIsBetter: true, maxRegression: 1 }],
};

const FACTORS = ['INTERCEPT', 'ORDERED_AHEAD', 'SAME_DAY', 'EVENING_SLOT', 'RAIN', 'NO_ETA', 'PAST_NO_SHOWS', 'LOYAL', 'WEEKEND'] as const;

/** 这位顾客以前的爽约率（收缩到 5%，先验相当于 2 单） */
export function shrunkNoShowRate(pastNoShows: number, pastOrders: number): number {
  return (pastNoShows + 0.1) / (pastOrders + 2);
}

function features(i: NoShowInput): number[] {
  return [1, Math.max(0, i.aheadH - 24) / 24, i.aheadH < 3 ? 1 : 0, i.slotHour >= 19 ? 1 : 0, i.rain ? 1 : 0, i.etaShared ? 0 : 1, shrunkNoShowRate(i.pastNoShows, i.pastOrders), Math.min(10, i.pastOrders) / 10, i.dow === 0 || i.dow === 6 ? 1 : 0];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fitNoShow(rows: ReadonlyArray<NoShowInput & { noShow: boolean }>, variant: NoShowVariant = 'noshow-logistic'): NoShowParams {
  const base = rows.length ? rows.filter((r) => r.noShow).length / rows.length : 0.05;
  if (variant === 'noshow-rule' || rows.length < 50) return { variant: 'noshow-rule', beta: [], base };
  const X = rows.map(features);
  const fit = fitGlm(X, rows.map((r) => (r.noShow ? 1 : 0)), { family: 'logistic', lambda: 1, penalize: FACTORS.map((_, j) => j > 0) });
  return { variant, beta: fit.beta.map((b) => Math.round(b * 10000) / 10000), base: Math.round(base * 10000) / 10000 };
}

/** 这张订单最后不来的概率与主要理由 */
export function predictNoShow(p: NoShowParams, i: NoShowInput): { p: number; reasons: Reason[] } {
  if (p.variant === 'noshow-rule' || !p.beta.length) {
    const prob = i.etaShared ? p.base : Math.min(0.9, p.base * 6 * (i.pastNoShows > 0 ? 1.5 : 1));
    return { p: Math.round(prob * 1000) / 1000, reasons: i.etaShared ? [] : [{ factor: 'NO_ETA', weight: 1 }] };
  }
  const x = features(i);
  const prob = sigmoid(dot(x, p.beta));
  const contrib = x.map((v, j) => ({ factor: FACTORS[j] as string, c: v * (p.beta[j] ?? 0), v })).filter((r) => r.factor !== 'INTERCEPT' && r.c > 0.05);
  const total = contrib.reduce((a, r) => a + r.c, 0) || 1;
  const reasons: Reason[] = contrib
    .sort((a, b) => b.c - a.c)
    .slice(0, 3)
    .map((r) => ({
      factor: r.factor,
      weight: Math.round((r.c / total) * 1000) / 1000,
      ...(r.factor === 'PAST_NO_SHOWS' ? { value: i.pastNoShows, params: { orders: i.pastOrders } } : r.factor === 'ORDERED_AHEAD' ? { value: Math.round(i.aheadH) } : {}),
    }));
  return { p: Math.round(prob * 1000) / 1000, reasons };
}

/** 离线评估：按时间先后切分（前 70% 训练） */
export function evaluateNoShow(rows: ReadonlyArray<NoShowInput & { noShow: boolean; t: number }>): { metrics: Record<NoShowVariant, Record<string, number>>; n: number } {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const cut = Math.floor(sorted.length * 0.7);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const y = test.map((r) => (r.noShow ? 1 : 0) as 0 | 1);
  const metrics = {} as Record<NoShowVariant, Record<string, number>>;
  for (const v of NOSHOW_VARIANTS) {
    const params = fitNoShow(train, v);
    const p = test.map((r) => predictNoShow(params, r).p);
    // 风险最高的一成订单抓到了多少爽约
    const order = p.map((x, i) => ({ x, i })).sort((a, b) => b.x - a.x);
    const top = order.slice(0, Math.max(1, Math.round(order.length * 0.1)));
    const caught = top.filter((o) => y[o.i] === 1).length;
    const positives = y.filter((v2) => v2 === 1).length || 1;
    metrics[v] = {
      brier: Math.round(brier(p, y) * 10000) / 10000,
      auc: Math.round(auc(p, y) * 1000) / 1000,
      ece: Math.round(expectedCalibrationError(p, y) * 10000) / 10000,
      captureTop10: Math.round((caught / positives) * 1000) / 1000,
      rate: Math.round((positives / Math.max(1, y.length)) * 10000) / 10000,
    };
  }
  return { metrics, n: test.length };
}
