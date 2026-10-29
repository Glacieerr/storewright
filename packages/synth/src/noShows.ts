import { createRng } from '@storewright/domain';

/**
 * 合成「未取订单」记录（决策记录 0023 · B5）：顾客下了自取单、最后没来。
 *
 * 每位顾客有一个模型看不到的「爽约倾向」（对数几率，正态，σ = 0.9）；每张订单爽约的对数几率 =
 *   基础（约 3%）+ 顾客倾向 + 提前很多天下单（+）+ 当天临时下单（−）+ 晚上最后几个时段（+）+ 雨天（+）
 *   + 到取货时段前 30 分钟还没报预计到达（+1.6）+ 之前爽约过（随次数增加）− 老顾客（取过很多次）。
 * 模型看得到的：下单提前量、时段、星期、天气、是否报了预计到达、这位顾客以前取过几次、爽约过几次；
 * 看不到的：顾客自己的倾向（只能从以前的记录里间接看到）。全部为假设参数。
 */

export interface NoShowRecord {
  customer: string;
  t: number;
  /** 下单到取货时段开始的小时数 */
  aheadH: number;
  slotHour: number;
  dow: number;
  rain: boolean;
  /** 到取货时段前 30 分钟有没有报预计到达 */
  etaShared: boolean;
  /** 这位顾客以前的自取单数、爽约次数（不含这一单） */
  pastOrders: number;
  pastNoShows: number;
  noShow: boolean;
}

export function generateNoShowRecords(opts: { seed?: number; customers?: number; days?: number } = {}): NoShowRecord[] {
  const rng = createRng((opts.seed ?? 1) * 7919 + 13);
  const customers = Array.from({ length: opts.customers ?? 1000 }, (_, i) => ({ id: `C${i + 1}`, bias: rng.normal(0, 0.9), rate: 0.05 + rng.next() * 0.35, orders: 0, noShows: 0 }));
  const days = opts.days ?? 240;
  const out: NoShowRecord[] = [];
  const logit = (p: number) => Math.log(p / (1 - p));
  for (let d = 0; d < days; d++) {
    const dow = d % 7;
    const rain = rng.chance(0.22);
    for (const c of customers) {
      if (!rng.chance(c.rate / 7)) continue;
      const slotHour = 9 + Math.floor(rng.next() * 12);
      const aheadH = rng.chance(0.35) ? rng.next() * 4 : 4 + rng.next() * 68;
      // 顾客本来就打算来的话多半会报预计到达；倾向高的人更少报
      const etaShared = rng.chance(Math.max(0.15, 0.82 - 0.12 * c.bias));
      let z = logit(0.03) + c.bias + 0.012 * Math.max(0, aheadH - 24) - (aheadH < 3 ? 0.5 : 0) + (slotHour >= 19 ? 0.45 : 0) + (rain ? 0.35 : 0) + (etaShared ? 0 : 1.6) + 0.55 * Math.min(4, c.noShows) - 0.15 * Math.min(10, c.orders);
      z += rng.normal(0, 0.3);
      const noShow = rng.chance(1 / (1 + Math.exp(-z)));
      out.push({ customer: c.id, t: d * 24 + slotHour, aheadH: Math.round(aheadH * 10) / 10, slotHour, dow, rain, etaShared, pastOrders: c.orders, pastNoShows: c.noShows, noShow });
      c.orders += 1;
      if (noShow) c.noShows += 1;
    }
  }
  return out;
}
