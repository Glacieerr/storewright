export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** 线性插值分位数，p ∈ [0, 1] */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (idx - lo);
}

/** t 分布双侧 97.5% 分位数（自由度 1–30，之后用正态近似） */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

export function tCritical(df: number): number {
  if (df <= 0) return Number.NaN;
  return df <= 30 ? (T975[df - 1] as number) : 1.96;
}

export interface Summary {
  mean: number;
  sd: number;
  n: number;
  /** 95% 置信区间半宽 */
  ci95: number;
}

export function summarize(xs: readonly number[]): Summary {
  const n = xs.length;
  const sd = stdev(xs);
  return { mean: mean(xs), sd, n, ci95: n > 1 ? (tCritical(n - 1) * sd) / Math.sqrt(n) : 0 };
}
