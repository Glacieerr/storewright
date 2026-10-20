import type { TempZone } from '@storewright/domain';
import type { StagingSlot } from '@storewright/store-config';

export interface SlotOccupancy {
  /** 格位编码 → 已放框数 */
  used: Map<string, number>;
  /** 格位编码 → 占用该格位的订单 */
  orders: Map<string, Set<string>>;
}

export function createOccupancy(): SlotOccupancy {
  return { used: new Map(), orders: new Map() };
}

export interface SlotRequest {
  orderId: string;
  tempZone: TempZone;
  purpose: StagingSlot['purpose'];
  area: 'PICKUP' | 'DELIVERY';
}

function eligible(slot: StagingSlot, req: SlotRequest): boolean {
  return slot.tempZone === req.tempZone && slot.purpose === req.purpose && (slot.area === 'ANY' || slot.area === req.area);
}

/**
 * 暂存格位建议（决策 S-02：员工自选为主，布局稳定时显示建议）。
 * 优先：同订单已占用且未满的格位 → 最近的空余格位。没有可用格位时返回 undefined（溢出）。
 */
export function suggestSlot(slots: readonly StagingSlot[], occ: SlotOccupancy, req: SlotRequest): StagingSlot | undefined {
  let best: StagingSlot | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    if (!eligible(s, req)) continue;
    const used = occ.used.get(s.code) ?? 0;
    if (used >= s.capacityTotes) continue;
    const sameOrder = occ.orders.get(s.code)?.has(req.orderId) ?? false;
    const score = (sameOrder ? 0 : 1000) + s.distanceM;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

export function occupy(occ: SlotOccupancy, slot: StagingSlot, orderId: string): void {
  occ.used.set(slot.code, (occ.used.get(slot.code) ?? 0) + 1);
  const set = occ.orders.get(slot.code) ?? new Set<string>();
  set.add(orderId);
  occ.orders.set(slot.code, set);
}

export function release(occ: SlotOccupancy, slotCode: string, orderId: string): void {
  const used = (occ.used.get(slotCode) ?? 1) - 1;
  if (used <= 0) {
    occ.used.delete(slotCode);
    occ.orders.delete(slotCode);
  } else {
    occ.used.set(slotCode, used);
    occ.orders.get(slotCode)?.delete(orderId);
  }
}

/** 某温区的占用率 */
export function occupancyRate(slots: readonly StagingSlot[], occ: SlotOccupancy, tempZone: TempZone): number {
  let cap = 0;
  let used = 0;
  for (const s of slots) {
    if (s.tempZone !== tempZone || s.purpose !== 'ORDERS') continue;
    cap += s.capacityTotes;
    used += occ.used.get(s.code) ?? 0;
  }
  return cap === 0 ? 0 : used / cap;
}
