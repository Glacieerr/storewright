/**
 * 评估指标。所有函数接受等长数组；空数组返回 NaN（调用方据此判断「没有可评估的数据」）。
 *
 * 数量预测：MAE、RMSE、偏差、WAPE、分位数损失、区间覆盖率；
 * 概率预测：Brier 分数、对数损失、校准分箱与期望校准误差（ECE）。
 */

function check(a: readonly number[], b: readonly number[]): void {
  if (a.length !== b.length) throw new Error(`length mismatch: ${a.length} vs ${b.length}`);
}

const at = (xs: readonly number[], i: number) => xs[i] as number;

/** 平均绝对误差 */
export function mae(actual: readonly number[], pred: readonly number[]): number {
  check(actual, pred);
  if (!actual.length) return NaN;
  let s = 0;
  for (let i = 0; i < actual.length; i++) s += Math.abs(at(pred, i) - at(actual, i));
  return s / actual.length;
}

/** 均方根误差 */
export function rmse(actual: readonly number[], pred: readonly number[]): number {
  check(actual, pred);
  if (!actual.length) return NaN;
  let s = 0;
  for (let i = 0; i < actual.length; i++) s += (at(pred, i) - at(actual, i)) ** 2;
  return Math.sqrt(s / actual.length);
}

/** 平均偏差（预测 − 实际）：正数表示系统性高估 */
export function bias(actual: readonly number[], pred: readonly number[]): number {
  check(actual, pred);
  if (!actual.length) return NaN;
  let s = 0;
  for (let i = 0; i < actual.length; i++) s += at(pred, i) - at(actual, i);
  return s / actual.length;
}

/** 加权绝对百分比误差：Σ|误差| / Σ|实际|。对零值稳健，适合按小时的订单量 */
export function wape(actual: readonly number[], pred: readonly number[]): number {
  check(actual, pred);
  if (!actual.length) return NaN;
  let e = 0;
  let a = 0;
  for (let i = 0; i < actual.length; i++) {
    e += Math.abs(at(pred, i) - at(actual, i));
    a += Math.abs(at(actual, i));
  }
  return a > 0 ? e / a : NaN;
}

/** 分位数（pinball）损失：q 分位预测的质量，越小越好 */
export function pinball(actual: readonly number[], quantile: readonly number[], q: number): number {
  check(actual, quantile);
  if (!actual.length) return NaN;
  let s = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = at(actual, i) - at(quantile, i);
    s += d >= 0 ? q * d : (q - 1) * d;
  }
  return s / actual.length;
}

/** 实际值落在 [low, high] 内的比例；80% 区间的理想值是 0.8 */
export function coverage(actual: readonly number[], low: readonly number[], high: readonly number[]): number {
  check(actual, low);
  check(actual, high);
  if (!actual.length) return NaN;
  let n = 0;
  for (let i = 0; i < actual.length; i++) if (at(actual, i) >= at(low, i) && at(actual, i) <= at(high, i)) n++;
  return n / actual.length;
}

/** Brier 分数：概率预测的均方误差，0 最好，0.25 相当于永远猜 50% */
export function brier(prob: readonly number[], outcome: readonly (0 | 1 | boolean)[]): number {
  if (prob.length !== outcome.length) throw new Error('length mismatch');
  if (!prob.length) return NaN;
  let s = 0;
  for (let i = 0; i < prob.length; i++) s += (at(prob, i) - (outcome[i] ? 1 : 0)) ** 2;
  return s / prob.length;
}

/** 对数损失（概率截断到 [eps, 1 − eps]） */
export function logLoss(prob: readonly number[], outcome: readonly (0 | 1 | boolean)[], eps = 1e-6): number {
  if (prob.length !== outcome.length) throw new Error('length mismatch');
  if (!prob.length) return NaN;
  let s = 0;
  for (let i = 0; i < prob.length; i++) {
    const p = Math.min(1 - eps, Math.max(eps, at(prob, i)));
    s -= outcome[i] ? Math.log(p) : Math.log(1 - p);
  }
  return s / prob.length;
}

export interface CalibrationBin {
  /** 分箱区间 [from, to) */
  from: number;
  to: number;
  n: number;
  /** 箱内平均预测概率 */
  meanProb: number;
  /** 箱内实际发生的比例 */
  observed: number;
}

/** 校准分箱：等宽分箱，空箱省略。画成曲线时越贴近对角线越好 */
export function calibration(prob: readonly number[], outcome: readonly (0 | 1 | boolean)[], bins = 10): CalibrationBin[] {
  if (prob.length !== outcome.length) throw new Error('length mismatch');
  const acc = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (let i = 0; i < prob.length; i++) {
    const p = Math.min(1, Math.max(0, at(prob, i)));
    const b = acc[Math.min(bins - 1, Math.floor(p * bins))] as { n: number; p: number; y: number };
    b.n++;
    b.p += p;
    b.y += outcome[i] ? 1 : 0;
  }
  return acc.flatMap((b, i) => (b.n ? [{ from: i / bins, to: (i + 1) / bins, n: b.n, meanProb: b.p / b.n, observed: b.y / b.n }] : []));
}

/** 期望校准误差：各箱 |平均预测 − 实际比例| 按样本数加权 */
export function expectedCalibrationError(prob: readonly number[], outcome: readonly (0 | 1 | boolean)[], bins = 10): number {
  const cal = calibration(prob, outcome, bins);
  const n = cal.reduce((a, b) => a + b.n, 0);
  if (!n) return NaN;
  return cal.reduce((a, b) => a + (b.n / n) * Math.abs(b.meanProb - b.observed), 0);
}

/** 数量预测的常用指标汇总（低 / 高为 80% 区间时，同时给出 10% / 90% 分位损失） */
export function forecastMetrics(actual: readonly number[], mean: readonly number[], low?: readonly number[], high?: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {
    mae: mae(actual, mean),
    rmse: rmse(actual, mean),
    bias: bias(actual, mean),
    wape: wape(actual, mean),
    n: actual.length,
  };
  if (low && high) {
    out.coverage80 = coverage(actual, low, high);
    out.pinball10 = pinball(actual, low, 0.1);
    out.pinball90 = pinball(actual, high, 0.9);
  }
  return out;
}

/** ROC 曲线下面积（Mann–Whitney 秩和，相同分数取平均秩）；只有一类时返回 NaN */
export function auc(score: readonly number[], outcome: readonly (0 | 1 | boolean)[]): number {
  if (score.length !== outcome.length) throw new Error('length mismatch');
  const idx = score.map((s, i) => ({ s, y: outcome[i] ? 1 : 0 })).sort((a, b) => a.s - b.s);
  let pos = 0;
  let rankSum = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as { s: number }).s === (idx[i] as { s: number }).s) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if ((idx[k] as { y: number }).y) {
      pos++;
      rankSum += avg;
    }
    i = j + 1;
  }
  const neg = idx.length - pos;
  if (!pos || !neg) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}
