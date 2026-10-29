/**
 * 时段产能的取舍（决策记录 0023 · 第三批 B6）。
 *
 * 门店每个取货时段能做多少单，取决于时段开始前在岗的拣货员和每单的拣货用时；接得多了就有订单赶不上时段。
 * 这里用一个小仿真画出取舍：同一天的需求（每个时段想下单的人数，泊松），按「产能估计 × 系数」作为每个时段的接单上限，
 * 拣货员按取货时段先后拣（每单用时有波动），看一共接了多少单、多少单赶不上取货时段。
 * 系数 ∞ 表示不设上限（现在的做法）。全部为假设参数，结论看相对变化。
 */

export interface CapacityDay {
  /** 取货时段：开始（当天的分钟）、平均有多少人想下单 */
  slots: Array<{ start: number; demand: number }>;
  slotMin: number;
  /** 每个时段开始前一段时间里在岗的拣货员（与 slots 对应） */
  pickers: number[];
  /** 每单的平均拣货用时（分钟，含批次开销分摊） */
  perOrderMin: number;
  /** 拣货可以提前多久开始（分钟） */
  leadMin?: number;
}

export interface CapacityPoint {
  factor: number;
  offered: number;
  accepted: number;
  late: number;
  latePct: number;
}

/** 每个时段估计能接的单：时段开始前一个时段长度里在岗的拣货员 × 可用时间（八五折）÷ 每单用时 */
export function estimateSlotCapacity(day: CapacityDay): number[] {
  return day.slots.map((_, k) => Math.max(0, Math.floor(((day.pickers[k] ?? 0) * day.slotMin * 0.85) / Math.max(0.1, day.perOrderMin))));
}

function rngOf(seed: number): () => number {
  let x = (seed * 2654435761) % 4294967296;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function poisson(rnd: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 50) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rnd)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rnd();
  } while (p > L);
  return k - 1;
}

function normal(rnd: () => number): number {
  const u = Math.max(1e-12, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** 一天：按上限接单，拣货员的可用时间按在岗人数累计，订单按取货时段先后做；做完的时刻晚于时段开始就算迟到 */
export function simulateCapacity(day: CapacityDay, factor: number, seed = 1): Omit<CapacityPoint, 'factor' | 'latePct'> {
  const rnd = rngOf(seed);
  const caps = estimateSlotCapacity(day);
  const lead = day.leadMin ?? 120;
  let offered = 0;
  let accepted = 0;
  let late = 0;
  // 每单的用时（对数正态，变异系数约 0.35）
  const work: Array<{ due: number; w: number }> = [];
  day.slots.forEach((sl, k) => {
    const want = poisson(rnd, sl.demand);
    offered += want;
    const limit = Number.isFinite(factor) ? Math.floor((caps[k] ?? 0) * factor) : Infinity;
    const take = Math.min(want, limit);
    accepted += take;
    for (let i = 0; i < take; i++) work.push({ due: sl.start, w: day.perOrderMin * Math.exp(0.34 * normal(rnd) - 0.058) });
  });
  // 可用的拣货时间：时段 k 开始前 lead 分钟内按 pickers[k] 人算（取各时段的最大值作为那一分钟的人数）
  const first = Math.min(...day.slots.map((x) => x.start)) - lead;
  const last = Math.max(...day.slots.map((x) => x.start));
  const rate = (t: number) => {
    let n = 0;
    day.slots.forEach((sl, k) => {
      if (t >= sl.start - lead && t < sl.start) n = Math.max(n, day.pickers[k] ?? 0);
    });
    return n * 0.85;
  };
  // 拣货员当作一个整体按速率做：每单最早在取货时段前 lead 分钟可以开始，做完的时刻晚于时段开始就算迟到
  let t = first;
  for (const job of work.sort((a, b) => a.due - b.due)) {
    t = Math.max(t, job.due - lead);
    let left = job.w;
    while (left > 1e-9 && t < last + 600) {
      const r = rate(t);
      if (r <= 0) {
        t = Math.floor(t) + 1;
        continue;
      }
      const step = Math.min(1 - (t % 1), left / r);
      left -= r * step;
      t += step;
    }
    if (t > job.due) late++;
  }
  return { offered, accepted, late };
}

/** 取舍曲线：每个系数跑多天（随机种子），取平均 */
export function capacityCurve(day: CapacityDay, factors: readonly number[] = [0.6, 0.8, 1, 1.2, 1.5, Infinity], days = 20): CapacityPoint[] {
  return factors.map((factor) => {
    let offered = 0;
    let accepted = 0;
    let late = 0;
    for (let d = 1; d <= days; d++) {
      const r = simulateCapacity(day, factor, d);
      offered += r.offered;
      accepted += r.accepted;
      late += r.late;
    }
    return { factor, offered: Math.round(offered / days), accepted: Math.round(accepted / days), late: Math.round((late / days) * 10) / 10, latePct: accepted ? Math.round((late / accepted) * 1000) / 1000 : 0 };
  });
}
