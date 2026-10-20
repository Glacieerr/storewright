/**
 * 确定性随机数。
 *
 * 两种生成器：
 * 1. `createRng(seed)`：顺序生成器（sfc32），用于生成合成数据。
 * 2. `keyedUniform(seed, stream, key)`：按键生成（计数器式）。同一个种子、流名和键永远得到同一个数，
 *    与调用顺序无关。仿真中的随机事件（缺货、到达时间偏移等）都按「订单 / 行」取数，
 *    因此不同策略在同一种子下面对完全相同的随机事件，这是公共随机数实验的前提。
 */

export interface Rng {
  /** [0, 1) 均匀分布 */
  next(): number;
  /** [min, max) 均匀分布 */
  uniform(min: number, max: number): number;
  /** [min, max] 整数 */
  int(min: number, max: number): number;
  normal(mean: number, sd: number): number;
  logNormal(mu: number, sigma: number): number;
  poisson(lambda: number): number;
  exponential(rate: number): number;
  pick<T>(items: readonly T[]): T;
  /** 按权重选取下标 */
  weightedIndex(weights: readonly number[]): number;
  shuffle<T>(items: T[]): T[];
  chance(p: number): boolean;
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** 32 位整数混合函数（murmur3 fmix32） */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 字符串哈希（FNV-1a 后接 fmix32） */
export function hashString(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

export function createRng(seed: number): Rng {
  const s = mix32(seed >>> 0);
  const raw = sfc32(0x9e3779b9, s, mix32(s ^ 0x243f6a88), mix32(s ^ 0xb7e15162));
  for (let i = 0; i < 12; i++) raw();
  let spareNormal: number | undefined;

  const rng: Rng = {
    next: raw,
    uniform: (min, max) => min + (max - min) * raw(),
    int: (min, max) => min + Math.floor(raw() * (max - min + 1)),
    normal: (mean, sd) => {
      if (spareNormal !== undefined) {
        const v = spareNormal;
        spareNormal = undefined;
        return mean + sd * v;
      }
      let u = 0;
      let v = 0;
      while (u === 0) u = raw();
      while (v === 0) v = raw();
      const mag = Math.sqrt(-2 * Math.log(u));
      spareNormal = mag * Math.sin(2 * Math.PI * v);
      return mean + sd * mag * Math.cos(2 * Math.PI * v);
    },
    logNormal: (mu, sigma) => Math.exp(rng.normal(mu, sigma)),
    poisson: (lambda) => {
      if (lambda <= 0) return 0;
      if (lambda > 60) return Math.max(0, Math.round(rng.normal(lambda, Math.sqrt(lambda))));
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= raw();
      } while (p > limit);
      return k - 1;
    },
    exponential: (rate) => -Math.log(1 - raw()) / rate,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() on empty array');
      return items[Math.floor(raw() * items.length)] as (typeof items)[number];
    },
    weightedIndex: (weights) => {
      let total = 0;
      for (const w of weights) total += w;
      let r = raw() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i] ?? 0;
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(raw() * (i + 1));
        const tmp = items[i] as (typeof items)[number];
        items[i] = items[j] as (typeof items)[number];
        items[j] = tmp;
      }
      return items;
    },
    chance: (p) => raw() < p,
  };
  return rng;
}

/** 按键生成 [0, 1) 均匀数：与调用顺序无关。 */
export function keyedUniform(seed: number, stream: string, key: string): number {
  const h = mix32(hashString(key, hashString(stream, seed >>> 0)) ^ 0x5bd1e995);
  const h2 = mix32(h + 0x6d2b79f5);
  // 53 位精度
  return ((h >>> 5) * 67108864 + (h2 >>> 6)) / 9007199254740992;
}

/** 按键生成 [min, max) 均匀数 */
export function keyedRange(seed: number, stream: string, key: string, min: number, max: number): number {
  return min + (max - min) * keyedUniform(seed, stream, key);
}
