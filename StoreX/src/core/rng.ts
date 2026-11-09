/**
 * 可复现的随机数：xoshiro128**，种子用 splitmix32 展开。
 * 每个随机来源用 fork(标签) 得到独立的子流：需求（订单、顾客）和作业（设备故障、作业时间波动）分开，
 * 两代流程在同一个种子下看到完全相同的需求（公共随机数，配对比较的前提）。
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** 由标签派生一个独立的子流（同一个种子、同一个标签总是得到同一个子流） */
  fork(label: string): Rng {
    let h = 2166136261;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619);
    return new Rng((this.s0 ^ h ^ Math.imul(this.s3, 0x27d4eb2d)) >>> 0);
  }

  /** [0, 1) 均匀分布 */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result / 4294967296;
  }

  /** [lo, hi] 的整数 */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 标准正态（Box–Muller） */
  normal(mean = 0, sd = 1): number {
    let u = this.next();
    while (u <= 1e-12) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 对数正态：给定均值和变异系数 */
  logNormal(mean: number, cv: number): number {
    const s2 = Math.log(1 + cv * cv);
    const mu = Math.log(mean) - s2 / 2;
    return Math.exp(this.normal(mu, Math.sqrt(s2)));
  }

  exp(mean: number): number {
    let u = this.next();
    while (u <= 1e-12) u = this.next();
    return -mean * Math.log(u);
  }

  /** 泊松分布（均值较大时用正态近似） */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 60) return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** 按权重选下标 */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i] as number;
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j] as T, items[i] as T];
    }
    return items;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** 累积权重表上的快速抽样（Zipf 等长尾分布） */
export class Sampler {
  private readonly cum: Float64Array;

  constructor(weights: readonly number[]) {
    this.cum = new Float64Array(weights.length);
    let s = 0;
    weights.forEach((w, i) => {
      s += w;
      this.cum[i] = s;
    });
  }

  sample(rng: Rng): number {
    const total = this.cum[this.cum.length - 1] as number;
    const r = rng.next() * total;
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cum[mid] as number) > r) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}
