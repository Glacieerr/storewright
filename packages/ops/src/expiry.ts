import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { OpsState, ShelfLot } from './types';

/**
 * 临期与损耗（决策记录 0024 · 第四批 C4）：收货时记下批号和保质期（扫箱上的 GS1 码或手填），
 * 补货上架时这一箱的批次上了货架；卖出、拣货按保质期先后（先进先出）从最早到期的批次扣。
 * AI（服务端）按每批到期前卖不完的概率建议降价、移到显眼位置或到期前捐赠；线上拣货避开剩余保质期太短的批次。
 * 开业时货架上的存量没有批次记录，不在这里跟踪。
 */

/** 按到期先后（没有保质期的排最后）从最早的批次扣掉 qty 件 */
export function consumeLots(s: OpsState, itemId: string, qty: number): void {
  const lots = s.shelfLots?.[itemId];
  if (!lots?.length || qty <= 0) return;
  lots.sort((a, b) => (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999') || a.at - b.at);
  let left = qty;
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(l.units, left);
    l.units -= take;
    left -= take;
  }
  (s.shelfLots as Record<string, ShelfLot[]>)[itemId] = lots.filter((l) => l.units > 0);
}

/** 员工数过货架：数出来比批次记录少，从最早到期的批次扣掉差额 */
export function trimLots(s: OpsState, itemId: string, counted: number): void {
  const lots = s.shelfLots?.[itemId];
  if (!lots?.length) return;
  const total = lots.reduce((a, l) => a + l.units, 0);
  if (counted < total) consumeLots(s, itemId, total - counted);
}

/** 降价（AI 建议、店长确认）：记下这一批的降价幅度 */
export function markdownEvent(s: OpsState, itemId: string, lot: string, pct: number, recId?: string): PendingEvent | undefined {
  if (!s.shelfLots?.[itemId]?.some((l) => l.lot === lot && l.units > 0) || !(pct > 0 && pct < 1)) return undefined;
  if ((s.markdowns?.[`${itemId}|${lot}`]?.pct ?? 0) >= pct) return undefined;
  return ev('MarkdownApplied', { itemId, lot, pct: Math.round(pct * 100) / 100, ...(recId ? { recId } : {}) });
}

/** 到期前捐赠：这一批从货架上拿下来 */
export function donateEvent(s: OpsState, itemId: string, lot: string, recId?: string): PendingEvent | undefined {
  const l = s.shelfLots?.[itemId]?.find((x) => x.lot === lot && x.units > 0);
  if (!l) return undefined;
  return ev('LotDonated', { itemId, lot, units: l.units, ...(recId ? { recId } : {}) });
}

export function applyExpiryEvent(s: OpsState, e: AnyOpsEvent): boolean {
  switch (e.type) {
    case 'MarkdownApplied':
      (s.markdowns ??= {})[`${e.payload.itemId}|${e.payload.lot}`] = { pct: e.payload.pct, at: e.at };
      return true;
    case 'LotDonated': {
      const lots = s.shelfLots?.[e.payload.itemId];
      if (lots) (s.shelfLots as Record<string, ShelfLot[]>)[e.payload.itemId] = lots.filter((l) => l.lot !== e.payload.lot);
      const sh = s.shelf[e.payload.itemId];
      if (sh) {
        sh.est = Math.max(0, sh.est - e.payload.units);
        sh.at = e.at;
      }
      s.donated = (s.donated ?? 0) + e.payload.units;
      return true;
    }
    default:
      return false;
  }
}

/** 这件商品货架上最早到期的批次（线上拣货提醒「避开快到期的」用） */
export function oldestLot(s: OpsState, itemId: string): ShelfLot | undefined {
  return [...(s.shelfLots?.[itemId] ?? [])].filter((l) => l.expiry && l.units > 0).sort((a, b) => (a.expiry as string).localeCompare(b.expiry as string))[0];
}
