import { solve } from './glm';
import { bias, coverage, mae, wape } from './metrics';
import { rankReasons, type Reason } from './recommendation';
import type { GatePolicy } from './registry';

/**
 * 拣货时长预测（决策记录 0021 · 第一批 B1）。
 *
 *   log(一行的用时) = β0 + β1·log(1 + 距离) + β2·件数 + 商品类型 + 层高 + 时段拥挤 + 熟练度组 + 货位难度
 *
 * - 固定效应用带轻微 L2 正则的最小二乘估计；先拟合一次，去掉残差超过 2.5σ 的行（拣货中途被叫去帮忙），再拟合；
 * - 货位难度是分层收缩（经验贝叶斯，与到店时间的「顾客习惯」同一个写法）：样本少的货位接近 0，样本多的越来越相信自己的记录；
 * - 批次用时 = 批次开销（领车、绑定、回暂存区，取训练期的中位数）+ 各行预测之和；
 * - 区间：训练期最后 20% 的批次「实际 ÷ 预测」的 10% / 90% 分位数（只用当时已有的数据）。
 * 熟练度只到组（按入职时长），不对个人建模（决策记录 0010 第 9 节）。
 *
 * 三个版本互为对照：分批算法的标准工时（pick-standard）、标准工时 × 训练期实测比例（pick-standard-ratio，
 * 推演现在的做法）、本模型（pick-model）。
 */

export type PickVariant = 'pick-standard' | 'pick-standard-ratio' | 'pick-model';
export const PICK_VARIANTS: readonly PickVariant[] = ['pick-standard', 'pick-standard-ratio', 'pick-model'];
export type PickTenure = 'NEW' | 'MID' | 'SENIOR';

export interface PickLine {
  locationId: string;
  /** SHELF / CHILLED_DOOR / FROZEN_DOOR / PRODUCE / BULKY */
  kind: string;
  level: number;
  distM: number;
  qty: number;
  sec?: number;
}

export interface PickWalkSample {
  /** 时间先后（任意单调的数） */
  t: number;
  hour: number;
  tenure: PickTenure;
  lines: PickLine[];
  standardSec: number;
  actualSec?: number;
  overheadSec?: number;
}

export interface PickTimeParams {
  variant: PickVariant;
  beta: number[];
  sigma2: number;
  /** 货位难度（对数尺度，已收缩） */
  loc: Record<string, number>;
  k: number;
  overheadSec: number;
  /** 标准工时 × 比例（pick-standard-ratio） */
  ratio: number;
  /** 批次「实际 ÷ 预测」的分位数 */
  q10: number;
  q90: number;
  /** 每小时客流系数（时段拥挤的特征） */
  traffic: number[];
}

/** 拣货时长：批次 WAPE 至少改善 1%，偏差与区间覆盖率不明显变差 */
export const PICKTIME_GATE: GatePolicy = {
  primary: { metric: 'wape', lowerIsBetter: true },
  minImprovement: 0.01,
  guardrails: [
    { metric: 'absBias', lowerIsBetter: true, maxRegression: 0.5 },
    { metric: 'coverageGap', lowerIsBetter: true, maxRegression: 1 },
  ],
};

const KINDS = ['CHILLED_DOOR', 'FROZEN_DOOR', 'PRODUCE', 'BULKY'] as const;
const DEFAULT_TRAFFIC = [0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.7, 0.9, 1, 1.1, 1.3, 1.4, 1.2, 1.1, 1.1, 1.3, 1.6, 1.7, 1.5, 1.2, 0.9, 0.6, 0.3];
const P = 12;

interface LineCtx {
  hour: number;
  tenure: PickTenure;
}

function features(l: PickLine, c: LineCtx, traffic: readonly number[]): number[] {
  const x = new Array<number>(P).fill(0);
  x[0] = 1;
  x[1] = Math.log1p(Math.max(0, l.distM));
  x[2] = l.qty;
  KINDS.forEach((k, i) => (x[3 + i] = l.kind === k ? 1 : 0));
  x[7] = l.level >= 4 ? 1 : 0;
  x[8] = l.level <= 1 ? 1 : 0;
  x[9] = (traffic[c.hour] ?? 1) - 1;
  x[10] = c.tenure === 'NEW' ? 1 : 0;
  x[11] = c.tenure === 'SENIOR' ? 1 : 0;
  return x;
}

const dot = (x: readonly number[], b: readonly number[]) => x.reduce((a, v, i) => a + v * (b[i] ?? 0), 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 1;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i] as number;
}

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

function ridge(rows: ReadonlyArray<{ x: number[]; y: number }>, lambda: number): number[] {
  const A = Array.from({ length: P }, () => new Array<number>(P).fill(0));
  const b = new Array<number>(P).fill(0);
  for (const r of rows) {
    for (let i = 0; i < P; i++) {
      const xi = r.x[i] as number;
      if (xi === 0) continue;
      b[i] = (b[i] as number) + xi * r.y;
      const Ai = A[i] as number[];
      for (let j = 0; j < P; j++) Ai[j] = (Ai[j] as number) + xi * (r.x[j] as number);
    }
  }
  for (let i = 1; i < P; i++) (A[i] as number[])[i] = ((A[i] as number[])[i] as number) + lambda;
  return solve(A, b);
}

/** 拟合；walks 需要 actualSec，pick-model 还需要每行的 sec */
export function fitPickTime(walks: readonly PickWalkSample[], variant: PickVariant, opts: { traffic?: readonly number[]; lambda?: number } = {}): PickTimeParams {
  const traffic = [...(opts.traffic ?? DEFAULT_TRAFFIC)];
  const train = walks.filter((w) => w.actualSec !== undefined && w.actualSec > 0).sort((a, b) => a.t - b.t);
  const base: PickTimeParams = { variant, beta: new Array<number>(P).fill(0), sigma2: 0, loc: {}, k: 0, overheadSec: 0, ratio: 1, q10: 1, q90: 1, traffic };
  if (!train.length) return base;
  base.ratio = median(train.map((w) => (w.actualSec as number) / Math.max(1, w.standardSec))) || 1;
  if (variant !== 'pick-model') {
    const ratios = train.map((w) => (w.actualSec as number) / Math.max(1, variant === 'pick-standard' ? w.standardSec : w.standardSec * base.ratio)).sort((a, b) => a - b);
    return { ...base, q10: quantile(ratios, 0.1), q90: quantile(ratios, 0.9) };
  }
  const fit = (ws: readonly PickWalkSample[]) => fitLines(ws, traffic, opts.lambda ?? 1);
  // 区间用训练期最后 20% 的批次估计（模型只用前 80% 拟合），上线时再用全部批次重新拟合
  const cut = Math.max(1, Math.floor(train.length * 0.8));
  const early = fit(train.slice(0, cut));
  const tail = train.slice(cut);
  const ratios = (tail.length >= 10 ? tail : train)
    .map((w) => (w.actualSec as number) / Math.max(1, predictPickWalk({ ...base, ...early, variant }, w).sec))
    .sort((a, b) => a - b);
  return { ...base, ...fit(train), q10: quantile(ratios, 0.1), q90: quantile(ratios, 0.9) };
}

function fitLines(walks: readonly PickWalkSample[], traffic: readonly number[], lambda: number): Pick<PickTimeParams, 'beta' | 'sigma2' | 'loc' | 'k' | 'overheadSec'> {
  const rows: Array<{ x: number[]; y: number; loc: string }> = [];
  const overheads: number[] = [];
  for (const w of walks) {
    let lineSum = 0;
    for (const l of w.lines) {
      if (!(l.sec !== undefined && l.sec > 0)) continue;
      rows.push({ x: features(l, w, traffic), y: Math.log(l.sec), loc: l.locationId });
      lineSum += l.sec;
    }
    if (w.overheadSec !== undefined) overheads.push(w.overheadSec);
    else if (w.actualSec !== undefined && lineSum > 0) overheads.push(Math.max(0, w.actualSec - lineSum));
  }
  const overheadSec = median(overheads);
  if (rows.length < P * 3) return { beta: new Array<number>(P).fill(0), sigma2: 0, loc: {}, k: 0, overheadSec };
  let beta = ridge(rows, lambda);
  let resid = rows.map((r) => r.y - dot(r.x, beta));
  let sigma = Math.sqrt(resid.reduce((a, e) => a + e * e, 0) / Math.max(1, resid.length - P));
  // 去掉被打断的行（残差远大于噪声）后重新拟合
  const kept = rows.filter((_, i) => Math.abs(resid[i] as number) <= 2.5 * sigma);
  beta = ridge(kept, lambda);
  resid = kept.map((r) => r.y - dot(r.x, beta));
  const sigma2 = resid.reduce((a, e) => a + e * e, 0) / Math.max(1, resid.length - P);
  // 货位难度：残差按货位汇总，矩估计「货位之间的方差」τ²，收缩系数 k = σ² / τ²
  const by = new Map<string, { n: number; sum: number }>();
  kept.forEach((r, i) => {
    const s = by.get(r.loc) ?? { n: 0, sum: 0 };
    s.n++;
    s.sum += resid[i] as number;
    by.set(r.loc, s);
  });
  const means = [...by.values()].filter((s) => s.n >= 2);
  const meanN = means.length ? means.reduce((a, s) => a + s.n, 0) / means.length : 1;
  const varMeans = means.length > 1 ? means.reduce((a, s) => a + (s.sum / s.n) ** 2, 0) / means.length : 0;
  const tau2 = Math.max(1e-4, varMeans - sigma2 / meanN);
  const k = sigma2 / tau2;
  const loc: Record<string, number> = {};
  for (const [id, s] of by) loc[id] = Math.round((s.sum / (s.n + k)) * 1000) / 1000;
  return { beta: beta.map((b) => Math.round(b * 10000) / 10000), sigma2: Math.round(sigma2 * 10000) / 10000, loc, k: Math.round(k * 100) / 100, overheadSec: Math.round(overheadSec) };
}

export interface PickPrediction {
  sec: number;
  low: number;
  high: number;
  /** 每一行的预测（秒，不含批次开销） */
  lines: number[];
  reasons: Reason[];
}

function lineMean(p: PickTimeParams, l: PickLine, c: LineCtx): number {
  return Math.exp(dot(features(l, c, p.traffic), p.beta) + (p.loc[l.locationId] ?? 0) + p.sigma2 / 2);
}

/** 预测一个批次；标准工时版本只看 standardSec */
export function predictPickWalk(p: PickTimeParams, w: Pick<PickWalkSample, 'hour' | 'tenure' | 'lines' | 'standardSec'>): PickPrediction {
  if (p.variant !== 'pick-model' || !p.beta.some((b) => b !== 0)) {
    const sec = w.standardSec * (p.variant === 'pick-standard-ratio' ? p.ratio : 1);
    return { sec: Math.round(sec), low: Math.round(sec * p.q10), high: Math.round(sec * p.q90), lines: w.lines.map(() => 0), reasons: [{ factor: 'PICK_STANDARD', value: Math.round(w.standardSec), weight: 1 }] };
  }
  const lines = w.lines.map((l) => lineMean(p, l, w));
  const sec = p.overheadSec + lines.reduce((a, b) => a + b, 0);
  return { sec: Math.round(sec), low: Math.round(sec * p.q10), high: Math.round(sec * p.q90), lines: lines.map((x) => Math.round(x)), reasons: pickReasons(p, w, lines) };
}

/**
 * 理由：和「普通情况」（常温货架、中间层、平峰、中等熟练度、普通货位）相比，多出或少用的时间。
 * 每一项是把这个因素换成普通情况后整批预测的差（秒）。
 */
function pickReasons(p: PickTimeParams, w: Pick<PickWalkSample, 'hour' | 'tenure' | 'lines'>, lines: readonly number[]): Reason[] {
  const total = (fn: (l: PickLine) => PickLine, c: LineCtx, noLoc = false) =>
    w.lines.reduce((a, l) => a + Math.exp(dot(features(fn(l), c, p.traffic), p.beta) + (noLoc ? 0 : (p.loc[l.locationId] ?? 0)) + p.sigma2 / 2), 0);
  const full = lines.reduce((a, b) => a + b, 0);
  const same = (l: PickLine) => l;
  const kindGap = full - total((l) => ({ ...l, kind: 'SHELF', level: 2 }), w);
  const peakGap = full - total(same, { hour: 10, tenure: w.tenure });
  const tenureGap = full - total(same, { hour: w.hour, tenure: 'MID' });
  const hard = w.lines.filter((l) => (p.loc[l.locationId] ?? 0) > 0.12);
  const hardGap = full - total(same, w, true);
  const kinds = new Map<string, number>();
  for (const l of w.lines) if (l.kind !== 'SHELF') kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1);
  const topKind = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
  const dist = w.lines.reduce((a, l) => a + l.distM, 0);
  const add = (s: number) => ({ kind: 'ADD' as const, amount: r2(s / 60) });
  const out: Reason[] = [
    { factor: 'PICK_LINES', value: w.lines.length, weight: 0, effect: add(full * 0.25), params: { units: w.lines.reduce((a, l) => a + l.qty, 0), distM: Math.round(dist) } },
  ];
  if (topKind && Math.abs(kindGap) >= 20) out.push({ factor: 'PICK_KIND', value: topKind[1], weight: 0, effect: add(kindGap), params: { kind: topKind[0] } });
  if (Math.abs(peakGap) >= 20) out.push({ factor: 'PICK_PEAK', value: w.hour, weight: 0, effect: add(peakGap) });
  if (Math.abs(tenureGap) >= 20) out.push({ factor: 'PICK_TENURE', weight: 0, effect: add(tenureGap), params: { tenure: w.tenure } });
  if (hard.length && hardGap >= 20) out.push({ factor: 'PICK_HARD_SPOTS', value: hard.length, weight: 0, effect: add(hardGap) });
  return rankReasons(out, 3);
}

/**
 * 拣货进行中：剩余用时 = 没做完的各行预测 × 这一批到现在的「实际 ÷ 预测」（向 1 收缩），再加回暂存区的开销。
 * done 是已经做完的行数（按路线顺序），elapsedSec 是从领取到现在的秒数。
 */
export function remainingPickSec(p: PickTimeParams, w: Pick<PickWalkSample, 'hour' | 'tenure' | 'lines' | 'standardSec'>, done: number, elapsedSec: number): number {
  const pred = predictPickWalk(p, w);
  if (p.variant !== 'pick-model' || !pred.lines.some((x) => x > 0)) {
    const frac = w.lines.length ? Math.max(0, 1 - done / w.lines.length) : 1;
    return Math.round(pred.sec * frac);
  }
  const overheadIn = p.overheadSec * 0.6;
  const doneSum = pred.lines.slice(0, done).reduce((a, b) => a + b, 0);
  const left = pred.lines.slice(done).reduce((a, b) => a + b, 0);
  const expected = overheadIn + doneSum;
  const ratio = expected > 0 && done > 0 ? elapsedSec / expected : 1;
  const wgt = done / (done + 3);
  const factor = Math.min(2.5, Math.max(0.5, 1 + wgt * (ratio - 1)));
  return Math.round(left * factor + p.overheadSec * 0.4);
}

export interface PickEvaluation {
  metrics: Record<PickVariant, Record<string, number>>;
  n: number;
}

/** 按时间先后：前 70% 拟合，之后的批次逐个预测 */
export function evaluatePickTime(walks: readonly PickWalkSample[], opts: { traffic?: readonly number[] } = {}): PickEvaluation {
  const all = walks.filter((w) => w.actualSec !== undefined).sort((a, b) => a.t - b.t);
  const cut = Math.floor(all.length * 0.7);
  const train = all.slice(0, cut);
  const test = all.slice(cut);
  const metrics = {} as PickEvaluation['metrics'];
  const actual = test.map((w) => w.actualSec as number);
  for (const v of PICK_VARIANTS) {
    const prm = fitPickTime(train, v, opts);
    const pr = test.map((w) => predictPickWalk(prm, w));
    const mean = pr.map((x) => x.sec);
    metrics[v] = {
      wape: Math.round(wape(actual, mean) * 10000) / 10000,
      mae: Math.round(mae(actual, mean) * 10) / 10,
      bias: Math.round(bias(actual, mean) * 10) / 10,
      coverage80: Math.round(coverage(actual, pr.map((x) => x.low), pr.map((x) => x.high)) * 1000) / 1000,
      n: test.length,
    };
  }
  return { metrics, n: test.length };
}
