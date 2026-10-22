import { createRng, hashString, type Item } from '@storewright/domain';

/**
 * 合成退货记录（Phase 6 · 退货去向判断）。
 * 能否再售取决于：温区（冷藏 / 冷冻离店越久越不能再售）、包装状态、是否易腐（蔬果、面包、熟食）、
 * 是否化学品（只能危险品回收）、离店时间；还有模型看不到的随机因素（顾客保存方式）。全部为假设参数。
 */

export type ReturnCondition = 'SEALED' | 'OPENED' | 'DAMAGED';

export interface ReturnRecord {
  itemId: string;
  categoryId: string;
  tempZone: string;
  chemical: boolean;
  unitPrice: number;
  condition: ReturnCondition;
  hoursSinceHandoff: number;
  /** 真实答案：检查后可以回架再售 */
  resellable: boolean;
}

const PERISHABLE = new Set(['produce-amb', 'produce-chl', 'bakery', 'deli', 'meat', 'seafood', 'dairy']);

export function isPerishableCategory(categoryId: string): boolean {
  return PERISHABLE.has(categoryId);
}

export function generateReturns(items: readonly Item[], opts: { seed: number; n?: number }): ReturnRecord[] {
  const rng = createRng(hashString(`${opts.seed}:returns`));
  const pool = items.filter((i) => i.fulfillmentType === 'GROCERY' || i.fulfillmentType === 'GM');
  const out: ReturnRecord[] = [];
  for (let k = 0; k < (opts.n ?? 3000); k++) {
    const it = pool[rng.int(0, pool.length - 1)] as Item;
    const condition: ReturnCondition = rng.chance(0.6) ? 'SEALED' : rng.chance(0.6) ? 'OPENED' : 'DAMAGED';
    const hours = Math.round(rng.exponential(1 / 20) * 10) / 10;
    const chemical = it.handling.includes('CHEMICAL');
    const cold = it.tempZone === 'CHILLED' || it.tempZone === 'FROZEN';
    let u = 2.2;
    if (condition === 'OPENED') u -= 3.5;
    if (condition === 'DAMAGED') u -= 4.5;
    if (cold) u -= 0.9 * Math.log1p(hours);
    if (PERISHABLE.has(it.categoryId)) u -= 1.2 + 0.03 * hours;
    if (chemical) u -= 0.5;
    u += rng.normal(0, 0.8);
    out.push({ itemId: it.id, categoryId: it.categoryId, tempZone: it.tempZone, chemical, unitPrice: it.unitPrice, condition, hoursSinceHandoff: hours, resellable: rng.next() < 1 / (1 + Math.exp(-u)) });
  }
  return out;
}
