import { fillRate } from '../network/allocate';
import { mulberry32, normal } from './rng';

/**
 * 补货分配用的满足率公式（src/network/allocate.ts 的 fillRate：需求服从正态分布时，备货 y 能满足的需求比例，
 * 1 − σ·L(z) / μ，L 是标准正态的损失函数）和蒙特卡洛模拟比：同样的 μ、σ、y，抽 n 个需求，算实际缺了多少。
 * 再和教科书里的标准正态损失函数值核对（L(0) = φ(0) = 0.39894…）。
 *
 * Fill-rate formula (normal loss function) vs Monte Carlo sampling and vs textbook loss-function values.
 */
export interface FillCase {
  z: number;
  cv: number;
  formula: number;
  simulated: number;
  /** 模拟的标准误（两者之差应在 3 倍以内） */
  se: number;
}

export function fillRateCases(samples: number, seed = 20261107): FillCase[] {
  const out: FillCase[] = [];
  const mu = 100;
  for (const cv of [0.2, 0.5])
    for (const z of [-1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5]) {
      const sigma = cv * mu;
      const y = mu + z * sigma;
      const g = normal(mulberry32(seed + Math.round((z + 5) * 100) + Math.round(cv * 1000)));
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < samples; i++) {
        const short = Math.max(0, mu + sigma * g() - y);
        s1 += short;
        s2 += short * short;
      }
      const mean = s1 / samples;
      const sd = Math.sqrt(Math.max(0, s2 / samples - mean * mean));
      out.push({ z, cv, formula: fillRate(y, mu, sigma), simulated: 1 - mean / mu, se: sd / Math.sqrt(samples) / mu });
    }
  return out;
}

/** 标准正态损失函数 L(z) = φ(z) − z(1 − Φ(z)) 的教科书值（数学常数，保留 4 位） */
export const LOSS_TABLE: readonly [number, number][] = [
  [0, 0.3989],
  [0.5, 0.1978],
  [1, 0.0833],
  [1.5, 0.0293],
  [2, 0.0085],
  [2.5, 0.002],
];

/** 由 fillRate 反推的 L(z)：μ = 1、σ = 1 时 fillRate = 1 − L(z) */
export const lossFromFill = (z: number): number => 1 - fillRate(1 + z, 1, 1);
