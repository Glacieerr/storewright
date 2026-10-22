import { solve } from './glm';
import { mae, bias, coverage } from './metrics';
import { rankReasons, type Reason } from './recommendation';

/**
 * 到店时间修正（Phase 5b）。
 *
 *   实际用时 = β0 + β1·导航用时 + β2·高峰×导航用时 + β3·预报大雨×导航用时 + β4·周末 + 顾客习惯
 *
 * - 固定效应用带轻微 L2 正则的最小二乘估计；
 * - 顾客习惯是分层收缩（经验贝叶斯）：顾客 c 的习惯 = 残差之和 / (次数 + k)，k = 噪声方差 / 习惯方差。
 *   第一次来的顾客习惯为 0，来得越多越相信他自己的记录；
 * - 区间用「只用当时已有的记录」滚动预测的残差分位数（10% / 90%）。
 *
 * 三个版本互为对照：只信导航（eta-reported）、加固定效应（eta-fixed）、再加顾客习惯（eta-hierarchical）。
 */

export type EtaVariant = 'eta-reported' | 'eta-fixed' | 'eta-hierarchical';
export const ETA_VARIANTS: readonly EtaVariant[] = ['eta-reported', 'eta-fixed', 'eta-hierarchical'];

export interface EtaSample {
  /** 时间先后（任意单调的数，例如分钟） */
  t: number;
  customer: string;
  reportedMin: number;
  actualMin?: number;
  hour: number;
  dow: number;
  x?: Record<string, number>;
}

export interface CustomerStats {
  n: number;
  /** 残差（实际 − 固定效应预测）之和 */
  sum: number;
}

export interface EtaParams {
  variant: EtaVariant;
  beta: number[];
  /** 噪声方差、顾客习惯方差、收缩系数 k */
  sigma2: number;
  tau2: number;
  k: number;
  q10: number;
  q90: number;
  customers: Record<string, CustomerStats>;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function row(s: EtaSample): number[] {
  const r = s.reportedMin;
  return [1, r, (s.x?.rush ?? 0) * r, (s.x?.rainHeavy ?? 0) * r, s.x?.weekend ?? 0];
}

const dotRow = (x: readonly number[], b: readonly number[]) => x.reduce((a, v, i) => a + v * (b[i] ?? 0), 0);

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i] as number;
}

export function fitEta(samples: readonly EtaSample[], variant: EtaVariant, lambda = 1): EtaParams {
  const train = samples.filter((s) => s.actualMin !== undefined).sort((a, b) => a.t - b.t);
  let beta = [0, 1, 0, 0, 0];
  if (variant !== 'eta-reported' && train.length >= 10) {
    const p = 5;
    const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const b = new Array<number>(p).fill(0);
    for (const s of train) {
      const x = row(s);
      for (let i = 0; i < p; i++) {
        b[i] = (b[i] as number) + (x[i] as number) * (s.actualMin as number);
        for (let j = 0; j < p; j++) (A[i] as number[])[j] = ((A[i] as number[])[j] as number) + (x[i] as number) * (x[j] as number);
      }
    }
    for (let i = 1; i < p; i++) (A[i] as number[])[i] = ((A[i] as number[])[i] as number) + lambda;
    beta = solve(A, b);
  }
  // 顾客习惯的方差分解（矩估计）
  const resid = train.map((s) => ({ c: s.customer, e: (s.actualMin as number) - dotRow(row(s), beta) }));
  const by = new Map<string, number[]>();
  for (const r of resid) {
    const list = by.get(r.c) ?? [];
    list.push(r.e);
    by.set(r.c, list);
  }
  let within = 0;
  let dfWithin = 0;
  const means: number[] = [];
  const sizes: number[] = [];
  for (const list of by.values()) {
    const m = list.reduce((a, b) => a + b, 0) / list.length;
    if (list.length >= 2) {
      for (const e of list) within += (e - m) ** 2;
      dfWithin += list.length - 1;
      means.push(m);
      sizes.push(list.length);
    }
  }
  const sigma2 = dfWithin > 0 ? within / dfWithin : 16;
  const grand = means.length ? means.reduce((a, b) => a + b, 0) / means.length : 0;
  const varMeans = means.length > 1 ? means.reduce((a, m) => a + (m - grand) ** 2, 0) / (means.length - 1) : 0;
  const meanInvN = sizes.length ? sizes.reduce((a, n) => a + 1 / n, 0) / sizes.length : 1;
  const tau2 = Math.max(0.1, varMeans - sigma2 * meanInvN);
  const k = sigma2 / tau2;
  const hierarchical = variant === 'eta-hierarchical';

  // 区间：按时间顺序滚动预测（顾客习惯只用之前的记录）的残差分位数
  const stats = new Map<string, CustomerStats>();
  const online: number[] = [];
  for (const r of resid) {
    const st = stats.get(r.c) ?? { n: 0, sum: 0 };
    const eff = hierarchical ? st.sum / (st.n + k) : 0;
    online.push(r.e - eff);
    st.n++;
    st.sum += r.e;
    stats.set(r.c, st);
  }
  online.sort((a, b) => a - b);
  const customers: Record<string, CustomerStats> = {};
  if (hierarchical) for (const [c, st] of stats) customers[c] = { n: st.n, sum: r3(st.sum) };
  return { variant, beta: beta.map(r3), sigma2: r3(sigma2), tau2: r3(tau2), k: r3(k), q10: r3(quantile(online, 0.1)), q90: r3(quantile(online, 0.9)), customers };
}

export interface EtaPrediction {
  /** 预计用时（分钟，从顾客点「我在路上」算起） */
  mean: number;
  low: number;
  high: number;
  reasons: Reason[];
}

/** extra：参数之外新积累的顾客记录（例如上线后的真实到店），与训练时的记录相加 */
export function predictEta(params: EtaParams, s: EtaSample, extra?: CustomerStats): EtaPrediction {
  const x = row(s);
  const b = params.beta;
  const fixed = dotRow(x, b);
  const base = params.customers[s.customer] ?? { n: 0, sum: 0 };
  const st = { n: base.n + (extra?.n ?? 0), sum: base.sum + (extra?.sum ?? 0) };
  const habit = params.variant === 'eta-hierarchical' ? st.sum / (st.n + params.k) : 0;
  const mean = Math.max(1, fixed + habit);
  const r = s.reportedMin;
  const add = (factor: string, amount: number, value?: number, p?: Record<string, string | number>): Reason | undefined =>
    Math.abs(amount) < 0.05 ? undefined : { factor, ...(value !== undefined ? { value } : {}), effect: { kind: 'ADD', amount: r3(amount) }, weight: 0, ...(p ? { params: p } : {}) };
  const reasons = [
    { factor: 'REPORTED_ETA', value: r, weight: 0.0001 } as Reason,
    add('TYPICAL_DELAY', (b[0] as number) + ((b[1] as number) - 1) * r),
    add('RUSH_HOUR', (b[2] as number) * (x[2] as number)),
    add('HEAVY_RAIN_FORECAST', (b[3] as number) * (x[3] as number), s.x?.forecastRainMm),
    add('WEEKEND', (b[4] as number) * (x[4] as number)),
    add('CUSTOMER_HABIT', habit, undefined, { visits: st.n }),
  ].filter((v): v is Reason => !!v);
  return { mean: r3(mean), low: r3(Math.max(0, mean + params.q10)), high: r3(mean + params.q90), reasons: rankReasons(reasons, 5) };
}

/**
 * 按时间先后评估：前 trainFrac 训练，之后的记录逐条预测；预测完把这条记录计入顾客习惯（上线后的真实情形）。
 */
export function evaluateEta(samples: readonly EtaSample[], variant: EtaVariant, trainFrac = 0.7): { metrics: Record<string, number>; params: EtaParams } {
  const sorted = [...samples].filter((s) => s.actualMin !== undefined).sort((a, b) => a.t - b.t);
  const cut = Math.floor(sorted.length * trainFrac);
  const params = fitEta(sorted.slice(0, cut), variant);
  // 「老顾客」：按训练期次数统计，与版本无关，三个版本在同一批记录上比较
  const visits = new Map<string, number>();
  for (const s of sorted.slice(0, cut)) visits.set(s.customer, (visits.get(s.customer) ?? 0) + 1);
  const extra = new Map<string, CustomerStats>();
  const act: number[] = [];
  const pred: number[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  const repeat: { a: number[]; p: number[] } = { a: [], p: [] };
  for (const s of sorted.slice(cut)) {
    const e = extra.get(s.customer);
    const p = predictEta(params, s, e);
    act.push(s.actualMin as number);
    pred.push(p.mean);
    lo.push(p.low);
    hi.push(p.high);
    const seen = (visits.get(s.customer) ?? 0) + (e?.n ?? 0);
    if (seen >= 3) {
      repeat.a.push(s.actualMin as number);
      repeat.p.push(p.mean);
    }
    const st = e ?? { n: 0, sum: 0 };
    st.n++;
    st.sum += (s.actualMin as number) - dotRow(row(s), params.beta);
    extra.set(s.customer, st);
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    params,
    metrics: { mae: round(mae(act, pred)), bias: round(bias(act, pred)), coverage80: round(coverage(act, lo, hi)), n: act.length, maeRepeat: round(mae(repeat.a, repeat.p)), nRepeat: repeat.a.length },
  };
}
