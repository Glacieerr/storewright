import { planogramIndex, shelfNow, type OpsState, type StoreStatic } from '@storewright/ops';

/**
 * 货架存量叠加层的数据：
 * - 仿真：每个货架段的 [t, 填充率, 空商品数] 序列，按时刻二分查找；
 * - 门店实况：按后端的存量估算现算每个货架段的平均填充率和空商品数。
 */

export interface BayStock {
  fill: number;
  empty: number;
  /** 这一段的商品数 */
  items?: number;
}

/** 序列为 [t0, f0, e0, t1, f1, e1, …]，返回时刻 t 时的状态 */
export function bayAt(steps: number[] | undefined, t: number): BayStock | undefined {
  if (!steps || steps.length < 3) return undefined;
  let lo = 0;
  let hi = steps.length / 3 - 1;
  if ((steps[0] as number) > t) return { fill: steps[1] as number, empty: steps[2] as number };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((steps[mid * 3] as number) <= t) lo = mid;
    else hi = mid - 1;
  }
  return { fill: steps[lo * 3 + 1] as number, empty: steps[lo * 3 + 2] as number };
}

/** 货位编码 → 货架段键 `${runId}|${bay}`（编码里的段号从 1 开始） */
export function bayKey(locationId: string): string | undefined {
  const m = /^(.*)-[LRW](\d+)-\d+$/.exec(locationId);
  return m ? `${m[1]}|${Number(m[2]) - 1}` : undefined;
}

/** 门店实况：各货架段的平均填充率与空商品数（按估算） */
export function liveBays(s: OpsState, st: StoreStatic): Map<string, BayStock> {
  const acc = new Map<string, { sum: number; n: number; empty: number }>();
  for (const p of planogramIndex(st).values()) {
    const k = bayKey(p.locationId);
    if (!k) continue;
    const est = shelfNow(s, p).est;
    const a = acc.get(k) ?? { sum: 0, n: 0, empty: 0 };
    a.sum += p.capacity ? Math.min(1, est / p.capacity) : 0;
    a.n += 1;
    if (est <= 0) a.empty += 1;
    acc.set(k, a);
  }
  const out = new Map<string, BayStock>();
  for (const [k, a] of acc) out.set(k, { fill: a.n ? a.sum / a.n : 1, empty: a.empty, items: a.n });
  return out;
}

/** 颜色：空商品占两成以上为红色，有空商品为橙红；否则按平均填充率从绿到黄 */
export function stockColor(b: BayStock | undefined): string {
  if (!b) return '#cfcac0';
  const share = b.items ? b.empty / b.items : b.empty > 0 ? 1 : 0;
  if (share >= 0.2) return '#d13b2f';
  if (b.empty > 0) return '#ef7d3c';
  if (b.fill >= 0.55) return '#3fa36b';
  if (b.fill >= 0.3) return '#9cc25a';
  return '#e0b02a';
}
