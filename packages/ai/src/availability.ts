import { dot, fitGlm, sigmoid } from './glm';
import { auc, brier, expectedCalibrationError, logLoss } from './metrics';
import { rankReasons, type Reason } from './recommendation';

/**
 * 可售概率与幽灵库存（Phase 5b）。
 *
 * 问题：系统估算显示货架上还有货，实际找得到吗？
 * 最关键的证据是「沉默」：一件平时每小时卖 1.5 件的商品已经 8 小时没有卖出，
 * 如果货架上真有货，这件事发生的概率只有 e^(−12)，几乎可以肯定货不在架上。
 *
 * - 朴素贝叶斯基线：P(幽灵) = π / (π + (1 − π)·e^(−λ))，λ = 上次销售以来本应卖出的件数，π 为历史比例；
 * - 正式模型：逻辑回归，特征为 λ、估算件数（封顶 12）、是否只剩 1–2 件、距上次员工确认的时间、销量；
 *   系数可以直接读成「几率比」，理由由各特征相对平均情况的几率比给出。
 */

export interface AvailabilityInput {
  est: number;
  velocity: number;
  expectedSinceSale: number;
  hoursSinceSale: number;
  hoursSinceConfirm: number;
}

export interface AvailabilityParams {
  beta: number[];
  /** 训练数据中各特征的平均值（解释用） */
  means: number[];
  /** 训练数据中幽灵库存的比例（朴素贝叶斯基线的先验） */
  prior: number;
}

const FEATURE_CODES = ['INTERCEPT', 'NO_SALES', 'SHELF_ESTIMATE', 'ALMOST_EMPTY', 'SINCE_CONFIRMED', 'VELOCITY'] as const;

export function availabilityFeatures(o: AvailabilityInput): number[] {
  // 估算件数封顶 12：件数多只能说明「不太可能被零星卖空」，不能抵消「整批找不到」时的沉默证据
  return [1, Math.min(20, o.expectedSinceSale), Math.log1p(Math.min(12, o.est)), o.est <= 2 ? 1 : 0, Math.log1p(o.hoursSinceConfirm), Math.log1p(Math.min(6, o.velocity))];
}

export function fitAvailability(rows: ReadonlyArray<AvailabilityInput & { available: boolean }>, lambda = 1): AvailabilityParams {
  const X = rows.map(availabilityFeatures);
  const y = rows.map((r) => (r.available ? 1 : 0));
  const fit = fitGlm(X, y, { family: 'logistic', lambda, penalize: [false, true, true, true, true, true] });
  const means = X[0] ? X[0].map((_, j) => X.reduce((a, x) => a + (x[j] as number), 0) / X.length) : [];
  const prior = rows.length ? rows.filter((r) => !r.available).length / rows.length : 0.02;
  return { beta: fit.beta.map((b) => Math.round(b * 10000) / 10000), means: means.map((m) => Math.round(m * 1000) / 1000), prior: Math.round(prior * 10000) / 10000 };
}

/**
 * 销量是估计出来的，本身有误差：把「本应卖出 λ 件」按负二项分布折算成等价的泊松证据，
 * 使 P(一件都没卖出 | 货在架上) = (1 + λ/k)^(−k)，等价 λ' = k·ln(1 + λ/k)。k 越小越保守。
 * 训练用的合成数据销量是精确已知的，线上使用时先用这个函数折算，避免把偶然的空档当成幽灵库存。
 */
export function discountSilence(expected: number, k = 4): number {
  return expected > 0 ? k * Math.log1p(expected / k) : 0;
}

/** 朴素贝叶斯：只看「本应卖出却没有卖出」 */
export function bayesAvailability(prior: number, o: AvailabilityInput): number {
  const quiet = Math.exp(-Math.min(50, o.expectedSinceSale));
  return 1 - prior / (prior + (1 - prior) * quiet);
}

export interface AvailabilityPrediction {
  /** 货架上找得到的概率 */
  pAvailable: number;
  reasons: Reason[];
}

export function predictAvailability(params: AvailabilityParams, o: AvailabilityInput): AvailabilityPrediction {
  const x = availabilityFeatures(o);
  const p = sigmoid(dot(x, params.beta));
  const reasons: Reason[] = [];
  for (let j = 1; j < x.length; j++) {
    // 相对平均情况的几率比：< 1 表示让「有货」更不可能
    const logOr = ((params.beta[j] as number) * ((x[j] as number) - (params.means[j] ?? 0)));
    if (Math.abs(logOr) < 0.05) continue;
    const code = FEATURE_CODES[j] as string;
    const value = code === 'NO_SALES' ? o.hoursSinceSale : code === 'SHELF_ESTIMATE' || code === 'ALMOST_EMPTY' ? o.est : code === 'SINCE_CONFIRMED' ? o.hoursSinceConfirm : o.velocity;
    reasons.push({ factor: code, value: Math.round(value * 10) / 10, effect: { kind: 'MULTIPLY', amount: Math.round(Math.exp(logOr) * 1000) / 1000 }, weight: 0, ...(code === 'NO_SALES' ? { params: { expected: Math.round(o.expectedSinceSale * 10) / 10 } } : {}) });
  }
  return { pAvailable: Math.round(p * 10000) / 10000, reasons: rankReasons(reasons, 4) };
}

/**
 * 按天切分评估（前 trainFrac 的天数训练）。三个版本：
 * system（系统估算大于 0 就认为有货）、bayes（朴素贝叶斯）、logistic（正式模型）。
 * 另外给出「幽灵库存提醒」的精确率和召回率：P(幽灵) ≥ alert 时提醒。
 */
export function evaluateAvailability(
  rows: ReadonlyArray<AvailabilityInput & { available: boolean; day: number }>,
  opts: { trainFrac?: number; alert?: number } = {},
): { params: AvailabilityParams; metrics: Record<string, Record<string, number>> } {
  const days = rows.reduce((m, r) => Math.max(m, r.day), 0) + 1;
  const cut = Math.floor(days * (opts.trainFrac ?? 0.7));
  const train = rows.filter((r) => r.day < cut);
  const test = rows.filter((r) => r.day >= cut);
  const params = fitAvailability(train);
  const y = test.map((r) => (r.available ? 1 : 0) as 0 | 1);
  const phantom = test.map((r) => (r.available ? 0 : 1) as 0 | 1);
  const alert = opts.alert ?? 0.5;
  const score = (p: number[]) => {
    const pPh = p.map((v) => 1 - v);
    let tp = 0;
    let fp = 0;
    let fn = 0;
    pPh.forEach((v, i) => {
      const yes = v >= alert;
      if (yes && phantom[i]) tp++;
      else if (yes) fp++;
      else if (phantom[i]) fn++;
    });
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    return {
      brier: r4(brier(p, y)),
      logLoss: r4(logLoss(p, y)),
      ece: r4(expectedCalibrationError(p, y)),
      auc: r4(auc(p, y)),
      precision: r4(tp + fp ? tp / (tp + fp) : NaN),
      recall: r4(tp + fn ? tp / (tp + fn) : NaN),
      n: test.length,
    };
  };
  return {
    params,
    metrics: {
      system: score(test.map(() => 1 - 1e-6)),
      bayes: score(test.map((r) => bayesAvailability(params.prior, r))),
      logistic: score(test.map((r) => predictAvailability(params, r).pAvailable)),
    },
  };
}
