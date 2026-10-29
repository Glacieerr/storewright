/**
 * 打烊复盘与反事实归因（决策记录 0024 · 第四批 F3）。
 *
 * 用当天的实际输入复刻今天：每个取货时段的单量、时段开始前在拣货的人数、拣货的快慢（实际用时 ÷ 标准用时）；
 * 复刻模型和时段产能的仿真相同（拣货员当作一个整体按速率做，每单最早在时段前 leadMin 分钟可以开始，做完晚于时段开始就算迟到）。
 * 然后逐个去掉扰动——单量等于预测、拣货的人数等于排班、拣货按标准快慢——重新复刻，
 * 三个因素的全部组合（8 种）算 Shapley 值，分出每个原因各占多少迟到订单（可能为负：例如单量比预测少，帮了忙）。
 * 复刻出来的迟到和实际的差就是「其他」，也是复刻（孪生）的精度，一起报告。
 */

export type ReviewFactor = 'DEMAND' | 'STAFF' | 'PACE';
export const REVIEW_FACTORS: readonly ReviewFactor[] = ['DEMAND', 'STAFF', 'PACE'];

export interface ReviewDay {
  slots: Array<{
    /** 时段开始（当天的分钟） */
    start: number;
    orders: number;
    forecast: number;
    /** 时段开始前实际在拣货的人数、排班里的拣货人数 */
    pickers: number;
    scheduled: number;
  }>;
  /** 每单的标准拣货用时（分钟） */
  perOrderMin: number;
  /** 实际拣货用时 ÷ 标准用时（> 1 是比标准慢） */
  pace: number;
  leadMin?: number;
}

/** 复刻一天：去掉 removed 里的扰动后，有多少单赶不上取货时段 */
export function replayLate(d: ReviewDay, removed: ReadonlySet<ReviewFactor> = new Set()): number {
  const lead = d.leadMin ?? 120;
  const slots = d.slots.map((x) => ({ start: x.start, orders: Math.max(0, Math.round(removed.has('DEMAND') ? x.forecast : x.orders)), pickers: removed.has('STAFF') ? x.scheduled : x.pickers }));
  const w = d.perOrderMin * (removed.has('PACE') ? 1 : d.pace);
  const rate = (t: number) => {
    let n = 0;
    for (const sl of slots) if (t >= sl.start - lead && t < sl.start) n = Math.max(n, sl.pickers);
    return n * 0.85;
  };
  const jobs = slots.flatMap((sl) => Array.from({ length: sl.orders }, () => sl.start)).sort((a, b) => a - b);
  if (!jobs.length) return 0;
  const last = Math.max(...slots.map((x) => x.start)) + 12 * 60;
  let t = Math.min(...slots.map((x) => x.start)) - lead;
  let late = 0;
  for (const due of jobs) {
    t = Math.max(t, due - lead);
    let left = w;
    while (left > 1e-9 && t < last) {
      const r = rate(t);
      if (r <= 0) {
        t = Math.floor(t) + 1;
        continue;
      }
      const step = Math.min(1 - (t % 1), left / r);
      left -= r * step;
      t += step;
    }
    if (t > due) late++;
  }
  return late;
}

export interface ReviewResult {
  /** 实际输入复刻出来的迟到、三个扰动都去掉后的迟到 */
  replay: number;
  baseline: number;
  /** 每个原因的 Shapley 值（单数，和 = replay − baseline） */
  factors: Record<ReviewFactor, number>;
}

export function attributeLate(d: ReviewDay): ReviewResult {
  const n = REVIEW_FACTORS.length;
  const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
  const cache = new Map<string, number>();
  // 「出现的扰动」集合 → 迟到（去掉的就是不在集合里的）
  const value = (present: ReadonlySet<ReviewFactor>) => {
    const key = REVIEW_FACTORS.filter((f) => present.has(f)).join(',');
    if (!cache.has(key)) cache.set(key, replayLate(d, new Set(REVIEW_FACTORS.filter((f) => !present.has(f)))));
    return cache.get(key) as number;
  };
  const factors = { DEMAND: 0, STAFF: 0, PACE: 0 } as Record<ReviewFactor, number>;
  for (const f of REVIEW_FACTORS) {
    const others = REVIEW_FACTORS.filter((x) => x !== f);
    for (let mask = 0; mask < 1 << others.length; mask++) {
      const S = new Set(others.filter((_, i) => mask & (1 << i)));
      const w = (fact(S.size) * fact(n - S.size - 1)) / fact(n);
      factors[f] += w * (value(new Set([...S, f])) - value(S));
    }
  }
  for (const f of REVIEW_FACTORS) factors[f] = Math.round(factors[f] * 10) / 10;
  return { replay: value(new Set(REVIEW_FACTORS)), baseline: value(new Set()), factors };
}
