/**
 * 排队论（M/M/c，Erlang C）：收银通道开几条（规划孪生的前场建议，决策记录 0020；门店的实时版，决策记录 0022 · A3）。
 */

/** M/M/c 排队的平均等待（分钟）：λ 每分钟到达、μ 每分钟每通道服务、c 条通道；c·μ ≤ λ 时排不过来（Infinity） */
export function erlangWaitMin(lambda: number, mu: number, c: number): number {
  if (lambda <= 0) return 0;
  if (c <= 0 || c * mu <= lambda) return Infinity;
  const a = lambda / mu;
  let sum = 0;
  let term = 1;
  for (let k = 0; k < c; k++) {
    if (k > 0) term *= a / k;
    sum += term;
  }
  const last = (term * a) / c;
  const pc = last * (c / (c - a));
  const pWait = pc / (sum + pc);
  return pWait / (c * mu - lambda);
}

/** 人工通道每位顾客的平均服务时间（分钟）、自助收银分走的比例、目标排队时间（分钟）、算「排不过来」的等待（分钟） */
export const FRONT_RULES = { serviceMin: 2.6, selfShare: 0.35, targetWaitMin: 2, shortWaitMin: 3 } as const;

/** 每小时 perHour 位顾客结账时，要开几条人工通道才能让平均排队不超过目标（最多 manual 条）；同时返回那时的平均等待 */
export function lanesNeeded(perHour: number, manual: number, hasSelf: boolean): { lanes: number; waitMin: number } {
  const mu = 1 / FRONT_RULES.serviceMin;
  const perMin = (perHour * (hasSelf ? 1 - FRONT_RULES.selfShare : 1)) / 60;
  let c = 1;
  while (c < manual && erlangWaitMin(perMin, mu, c) > FRONT_RULES.targetWaitMin) c++;
  return { lanes: c, waitMin: erlangWaitMin(perMin, mu, c) };
}
