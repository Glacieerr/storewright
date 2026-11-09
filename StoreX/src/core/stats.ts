/** 统计工具：均值、标准差、分位数、t 分布 95% 置信区间（重复次数少时用 t 分布） */
export function mean(xs: readonly number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (a[lo] as number) + ((a[hi] as number) - (a[lo] as number)) * (pos - lo);
}

/** 自由度 1–30 的 t 分布 0.975 分位数，更大时用 1.96 */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

export function ci95(xs: readonly number[]): { mean: number; half: number } {
  const n = xs.length;
  if (n < 2) return { mean: mean(xs), half: 0 };
  const t = n - 1 <= 30 ? (T975[n - 2] as number) : 1.96;
  return { mean: mean(xs), half: (t * sd(xs)) / Math.sqrt(n) };
}

/** 配对差值（同一种子下 B − A）的均值和 95% 置信区间 */
export function pairedDiff(a: readonly number[], b: readonly number[]): { mean: number; half: number; significant: boolean } {
  const d = a.map((x, i) => (b[i] as number) - x);
  const c = ci95(d);
  return { ...c, significant: c.half > 0 ? Math.abs(c.mean) > c.half : c.mean !== 0 };
}

/** 按时间加权的平均值（例如在岗人数、空货架数） */
export class TimeWeighted {
  private last = 0;
  private value = 0;
  private area = 0;
  private start: number;
  max = 0;

  constructor(t0: number, v0 = 0) {
    this.start = t0;
    this.last = t0;
    this.value = v0;
    this.max = v0;
  }

  set(t: number, v: number): void {
    this.area += this.value * (t - this.last);
    this.last = t;
    this.value = v;
    if (v > this.max) this.max = v;
  }

  add(t: number, dv: number): void {
    this.set(t, this.value + dv);
  }

  get current(): number {
    return this.value;
  }

  average(tEnd: number): number {
    const area = this.area + this.value * (tEnd - this.last);
    return tEnd > this.start ? area / (tEnd - this.start) : this.value;
  }
}
