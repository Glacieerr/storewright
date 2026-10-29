import { batchByArea, checkBin, needsReplenishment, replenishPriority, riskPriority, stockoutRisk, suggestedUnits, COUNT_INTERVAL_DAYS, DEFAULT_CART, DEFAULT_REPLENISH_RULES, type AbcClass, type BinCheck } from '@storewright/algorithms/replenish';
import { caseId as makeCaseId, gtin14 } from '@storewright/domain';
import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type PendingEvent } from './events';
import { locationIndex, planogramIndex } from './apply';
import { requireScan } from './settings';
import { dateOf } from './roster';
import { LOT_TASKS } from './types';
import type { BinInfo, CountReason, Discrepancy, LiveCase, OpsState, PlanogramEntry, ReplReason, ReplWhy, ShelfState, StoreStatic } from './types';

/**
 * 后仓库存、Exception、盘点、货架存量与补货的命令处理（决策 I-01～I-05、X-01～X-04、R-01～R-05）。
 * 与 decide.ts 一样是纯函数：时间来自信封，编号来自状态里的计数器。
 */

export interface InventoryContext {
  statics: StoreStatic;
  /** GTIN（任意位数）→ 商品 ID */
  itemByGtin(gtin: string): string | undefined;
  itemExists(itemId: string): boolean;
}

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode, params?: Record<string, string | number>): Result => ({ ok: false, reject: params ? { code, params } : { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

type InventoryCommand = Extract<
  OpsCommand,
  {
    type:
      | 'ClaimException'
      | 'ExceptionFound'
      | 'ExceptionMissing'
      | 'ReleaseException'
      | 'DeliverException'
      | 'ReturnExceptionItems'
      | 'CreateAsn'
      | 'UpdateAsnEta'
      | 'ArriveTruck'
      | 'ReceiveCases'
      | 'CloseReceipt'
      | 'PutAwayCase'
      | 'ChangeCaseStatus'
      | 'CreateCount'
      | 'ClaimCount'
      | 'ReleaseCount'
      | 'CompleteCount'
      | 'RecordSales'
      | 'RecordSensor'
      | 'RequestReplenishment'
      | 'ClaimReplenishment'
      | 'ReleaseReplenishment'
      | 'CompleteReplenishment'
      | 'CancelReplenishment'
      | 'ConfirmShelf'
      | 'SkipWalkCheck';
  }
>;

export const INVENTORY_COMMANDS = new Set<OpsCommand['type']>([
  'ClaimException',
  'ExceptionFound',
  'ExceptionMissing',
  'ReleaseException',
  'DeliverException',
  'ReturnExceptionItems',
  'CreateAsn',
  'UpdateAsnEta',
  'ArriveTruck',
  'ReceiveCases',
  'CloseReceipt',
  'PutAwayCase',
  'ChangeCaseStatus',
  'CreateCount',
  'ClaimCount',
  'ReleaseCount',
  'CompleteCount',
  'RecordSales',
  'RecordSensor',
  'RequestReplenishment',
  'ClaimReplenishment',
  'ReleaseReplenishment',
  'CompleteReplenishment',
  'CancelReplenishment',
  'ConfirmShelf',
  'SkipWalkCheck',
]);

export function isInventoryCommand(cmd: OpsCommand): cmd is InventoryCommand {
  return INVENTORY_COMMANDS.has(cmd.type);
}

// ---------------------------------------------------------------------------
// 共用查询（也给 Tick 用）

const binIndexCache = new WeakMap<StoreStatic, Map<string, BinInfo>>();
export function binIndex(st: StoreStatic): Map<string, BinInfo> {
  let m = binIndexCache.get(st);
  if (!m) {
    m = new Map(st.bins.map((b) => [b.code, b]));
    binIndexCache.set(st, m);
  }
  return m;
}

/** 商品 → 主货位的陈列表条目 */
/** 批号是否在召回范围里：没给批号时全算；给了的按开头匹配；箱子没记批号时也算（宁可多下架） */
export function lotHit(lots: readonly string[], lot: string | undefined): boolean {
  if (!lots.length || !lot) return true;
  return lots.some((x) => lot.toUpperCase().startsWith(x.toUpperCase()));
}

/** 这一箱是否在进行中的召回里 */
export function caseRecalled(s: OpsState, c: { itemId: string; lot?: string | undefined }): boolean {
  return Object.values(s.recalls ?? {}).some((r) => r.status === 'OPEN' && r.itemIds.includes(c.itemId) && lotHit(r.lots, c.lot));
}

export function planogramByItem(st: StoreStatic): Map<string, PlanogramEntry> {
  return planogramIndex(st);
}

/** 商品在货架上的存量估算（没有记录时视为开门时补满） */
export function shelfNow(s: OpsState, p: PlanogramEntry): ShelfState {
  return s.shelf[p.itemId] ?? { est: p.capacity, conf: 0.5, source: 'INIT', at: 0, velocity: p.baseVelocity };
}

/** 后仓里某商品可售且有剩余的箱子，按收货时间先进先出 */
/**
 * 能用的箱子（决策记录 0026）：可售、在库位里、库位没有正在进行的盘点。
 * 一次「后仓找不到」只盘找过的那个库位，别的库位的箱子照样能补货、补取。
 */
export function usableCases(s: OpsState, itemId: string): LiveCase[] {
  return sellableCases(s, itemId).filter((c) => !c.binCode || !openCountFor(s, c.binCode));
}

export function sellableCases(s: OpsState, itemId: string): LiveCase[] {
  return (s.itemCases[itemId] ?? [])
    .map((id) => s.cases[id])
    .filter((c): c is LiveCase => !!c && c.state === 'STORED' && c.status === 'SELLABLE' && c.units > 0)
    .sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
}

/** 已下单但还没拣的件数（在线订单占用） */
export function onlineDemand(s: OpsState): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of Object.values(s.orders)) {
    if (o.status !== 'LOCKED' && o.status !== 'PICKING' && o.status !== 'CREATED') continue;
    for (const l of o.lines) {
      const r = o.lineResults[l.lineId];
      const done = r ? r.picked + r.short + r.substituted : 0;
      if (done < l.qty) m.set(l.itemId, (m.get(l.itemId) ?? 0) + (l.qty - done));
    }
  }
  return m;
}

/** 这个商品是否已有未完成的补货任务 */
export function openTaskAt(s: OpsState, itemId: string): boolean {
  for (const t of Object.values(s.repl)) if (t.itemId === itemId && (t.status === 'OPEN' || t.status === 'CLAIMED')) return true;
  return false;
}

/** 生成补货任务的事件（检查后仓库存、重复任务）；extra 是按断货概率排的优先级和依据（决策记录 0021 · C2） */
export function replTaskEvent(s: OpsState, st: StoreStatic, p: PlanogramEntry, reason: ReplReason, seqOffset: number, est?: number, demand = 0, extra?: { priority: number; risk: number; why: ReplWhy }): PendingEvent | undefined {
  if (openTaskAt(s, p.itemId)) return undefined;
  if (s.suspect[p.itemId] !== undefined || !usableCases(s, p.itemId).length) return undefined;
  const sh = shelfNow(s, p);
  const e = est ?? sh.est;
  // 不是排程批量生成的任务（货架数出来是 0、拣货找不到、传感器……）也附上断货概率和依据
  const x = extra ?? riskFor(s, st, p, s.at, e);
  const priority = Math.min(x.priority, replenishPriority({ est: e, capacity: p.capacity, velocityPerHour: sh.velocity, onlineDemand: demand, unitPrice: p.unitPrice }));
  return ev('ReplenishmentTaskCreated', {
    taskId: `RP${String(s.counters.repl + 1 + seqOffset).padStart(4, '0')}`,
    locationId: p.locationId,
    itemId: p.itemId,
    area: p.runId,
    reason,
    suggestedUnits: Math.max(1, suggestedUnits({ est: e, capacity: p.capacity })),
    priority,
    risk: x.risk,
    why: x.why,
  });
}

/** 一件商品接下来几小时断货的概率、按概率的优先级和依据（决策记录 0021 · C2） */
export function riskFor(s: OpsState, st: StoreStatic, p: PlanogramEntry, now: number, est?: number, need = onlineNeed(s, st, now)): { priority: number; risk: number; why: ReplWhy } {
  const sh = shelfNow(s, p);
  const e = est ?? sh.est;
  const o = need.get(p.itemId) ?? { ordered: 0, orders: 0, forecast: 0 };
  const rec = Object.values(s.recs).find((r) => r.status === 'OPEN' && r.module === 'AVAILABILITY' && r.target === p.itemId && r.prediction?.unit === 'PROBABILITY');
  const pFind = rec?.prediction?.value;
  const risk = stockoutRisk({ est: e, ...(pFind !== undefined ? { pFind } : {}), velocityPerHour: sh.velocity, onlineOrderedUnits: o.ordered, onlineForecastUnits: o.forecast, horizonH: RISK_HORIZON_H });
  const why: ReplWhy = { online: Math.round((o.ordered + o.forecast) * 10) / 10, ordered: o.ordered, orders: o.orders, est: Math.round(e * 10) / 10, instore: Math.round(sh.velocity * RISK_HORIZON_H * 10) / 10, horizonH: RISK_HORIZON_H, ...(pFind !== undefined ? { pFind } : {}) };
  return { priority: riskPriority(risk, RISK_HORIZON_H, p.unitPrice), risk, why };
}

/** 补货优先级看多远（小时） */
export const RISK_HORIZON_H = 2;

/**
 * 接下来几小时的线上需求（决策记录 0021 · C2）：已下单、取货时段在这段时间（加上锁单提前量）里的未拣件数，
 * 加上订单量展望里还会来的订单按这件商品的销售占比折算的件数。
 */
export function onlineNeed(s: OpsState, st: StoreStatic, now: number, horizonH = RISK_HORIZON_H, lockLeadMin = 60): Map<string, { ordered: number; orders: number; forecast: number }> {
  const end = now + horizonH * 3_600_000;
  const out = new Map<string, { ordered: number; orders: number; forecast: number }>();
  const get = (id: string) => {
    let v = out.get(id);
    if (!v) out.set(id, (v = { ordered: 0, orders: 0, forecast: 0 }));
    return v;
  };
  const existing = new Map<number, number>();
  for (const o of Object.values(s.orders)) {
    if (o.status === 'CANCELLED') continue;
    const h = Math.floor(o.slotStart / 3_600_000);
    existing.set(h, (existing.get(h) ?? 0) + 1);
    if (o.status !== 'CREATED' && o.status !== 'LOCKED' && o.status !== 'PICKING') continue;
    if (o.slotStart - lockLeadMin * 60_000 > end) continue;
    const seen = new Set<string>();
    for (const l of o.lines) {
      const r = o.lineResults[l.lineId];
      const left = l.qty - (r ? r.picked + r.short + r.substituted : 0);
      if (left <= 0) continue;
      const v = get(l.itemId);
      v.ordered += left;
      if (!seen.has(l.itemId)) {
        v.orders += 1;
        seen.add(l.itemId);
      }
    }
  }
  const ol = s.outlook;
  if (ol?.hours.length) {
    // 还会来的订单：展望里的预计单数 − 已经下单的单数（同一个取货小时）
    let more = 0;
    for (const h of ol.hours) {
      const from = Math.max(h.t, now);
      const to = Math.min(h.t + 3_600_000, end + lockLeadMin * 60_000);
      if (to <= from) continue;
      const left = Math.max(0, h.mean - (existing.get(Math.floor(h.t / 3_600_000)) ?? 0));
      more += left * ((to - from) / 3_600_000);
    }
    const units = more * (ol.unitsPerOrder ?? 5);
    const total = st.planogram.reduce((a, p) => a + p.baseVelocity, 0);
    if (units > 0 && total > 0) for (const p of st.planogram) get(p.itemId).forecast += (units * p.baseVelocity) / total;
  }
  return out;
}

function countEvent(s: OpsState, binCode: string, reason: CountReason, seqOffset: number, itemId?: string): PendingEvent {
  const p: { countId: string; binCode: string; reason: CountReason; itemId?: string } = { countId: `CC${String(s.counters.counts + 1 + seqOffset).padStart(4, '0')}`, binCode, reason };
  if (itemId) p.itemId = itemId;
  return ev('CycleCountCreated', p);
}

export function openCountFor(s: OpsState, binCode: string): boolean {
  return Object.values(s.counts).some((c) => c.binCode === binCode && c.status !== 'DONE');
}

/** 某商品的箱子所在的库位 */
function binsOfItem(s: OpsState, itemId: string): string[] {
  const set = new Set<string>();
  for (const c of Object.values(s.cases)) if (c.itemId === itemId && c.state === 'STORED' && c.binCode) set.add(c.binCode);
  return [...set].sort();
}

const BIN_REJECT: Record<Exclude<BinCheck, 'OK'>, RejectCode> = { ZONE: 'BIN_ZONE', ISOLATION: 'BIN_ISOLATION', STATUS: 'BIN_STATUS', FULL: 'BIN_FULL' };

// ---------------------------------------------------------------------------

export function decideInventory(s: OpsState, env: CommandEnvelope & { cmd: InventoryCommand }, ctx: InventoryContext): Result {
  const { cmd, actor, at } = env;
  const st = ctx.statics;
  const byItem = planogramByItem(st);
  switch (cmd.type) {
    // —— Exception ——
    case 'ClaimException': {
      const x = s.exceptions[cmd.exceptionId];
      if (!x) return no('EXCEPTION_NOT_FOUND');
      if (x.status === 'ASSIGNED' && x.associateId === actor) return yes([]);
      if (x.status !== 'OPEN') return no('EXCEPTION_TAKEN', { by: x.associateId ?? '' });
      // 只有永久授权的员工可以执行（决策 X-01）
      if (!st.roster.find((a) => a.id === actor)?.exceptionAuthorized) return no('NOT_AUTHORIZED');
      const o = s.orders[x.orderId];
      if (!o || o.status === 'CANCELLED') return no('ORDER_CANCELLED');
      if (o.status === 'COMPLETED') return no('ORDER_COMPLETED');
      return yes([ev('ExceptionAssigned', { exceptionId: x.id })]);
    }
    case 'ReleaseException': {
      const x = s.exceptions[cmd.exceptionId];
      if (!x) return no('EXCEPTION_NOT_FOUND');
      if (x.associateId !== actor) return no('EXCEPTION_NOT_YOURS', { by: x.associateId ?? '' });
      if (x.status !== 'ASSIGNED') return no('EXCEPTION_STATE', { status: x.status });
      return yes([ev('ExceptionReleased', { exceptionId: x.id })]);
    }
    case 'ExceptionFound': {
      const x = s.exceptions[cmd.exceptionId];
      if (!x) return no('EXCEPTION_NOT_FOUND');
      if (x.associateId !== actor) return no('EXCEPTION_NOT_YOURS', { by: x.associateId ?? '' });
      if (x.status !== 'ASSIGNED') return no('EXCEPTION_STATE', { status: x.status });
      const c = s.cases[cmd.caseId.trim().toUpperCase()];
      if (!c) return no('CASE_NOT_FOUND');
      if (c.itemId !== x.itemId) return no('CASE_WRONG_ITEM');
      if (c.state !== 'STORED' || c.status !== 'SELLABLE' || c.units <= 0) return no('CASE_EMPTY');
      const units = Math.min(x.qty, c.units);
      const out: PendingEvent[] = [ev('ExceptionItemFound', { exceptionId: x.id, caseId: c.id, units, binEmpty: cmd.binEmpty })];
      // 员工说库位已空，但记录里还有这个商品的其他箱子：生成盘点任务
      const others = (s.bins[c.binCode ?? ''] ?? []).filter((id) => id !== c.id && s.cases[id]?.itemId === x.itemId && (s.cases[id]?.units ?? 0) > 0);
      let counts = 0;
      if (cmd.binEmpty && others.length && c.binCode && !openCountFor(s, c.binCode)) out.push(countEvent(s, c.binCode, 'DISCREPANCY', counts++, x.itemId));
      // Exception 完成后自动生成补货任务（决策 X-04）
      const p = byItem.get(x.itemId);
      if (p && !openTaskAt(s, p.itemId)) {
        const rest = c.units - units;
        const hasStock = rest > 0 || usableCases(s, x.itemId).some((k) => k.id !== c.id);
        if (hasStock && s.suspect[x.itemId] === undefined) {
          const sh = shelfNow(s, p);
          const taskId = `RP${String(s.counters.repl + 1).padStart(4, '0')}`;
          out.push(
            ev('ReplenishmentTaskCreated', {
              taskId,
              locationId: p.locationId,
              itemId: p.itemId,
              area: p.runId,
              reason: 'EXCEPTION',
              suggestedUnits: Math.max(1, suggestedUnits({ est: sh.est, capacity: p.capacity })),
              priority: replenishPriority({ est: sh.est, capacity: p.capacity, velocityPerHour: sh.velocity, onlineDemand: 0, unitPrice: p.unitPrice }),
              ...(rest > 0 ? { fromCaseId: c.id } : {}),
            }),
          );
          // 箱里剩下的顺手上架（决策记录 0026）：任务直接交给补取的人
          if (cmd.alsoRestock && rest > 0) out.push(ev('ReplenishmentClaimed', { taskIds: [taskId] }));
        }
      }
      return yes(out);
    }
    case 'ExceptionMissing': {
      const x = s.exceptions[cmd.exceptionId];
      if (!x) return no('EXCEPTION_NOT_FOUND');
      if (x.associateId !== actor) return no('EXCEPTION_NOT_YOURS', { by: x.associateId ?? '' });
      if (x.status !== 'ASSIGNED') return no('EXCEPTION_STATE', { status: x.status });
      // 幽灵库存：生成盘点任务（决策 X-02）。说了找过哪个库位时只盘这个库位，别的库位的箱子照样能用（决策记录 0026）；
      // 没说时整个商品标为可疑，盘所有库位
      const bin = cmd.binCode?.trim().toUpperCase();
      const out: PendingEvent[] = [ev('ExceptionNotFound', { exceptionId: x.id, ...(bin ? { binCode: bin } : {}) })];
      let k = 0;
      for (const b of bin ? [bin] : binsOfItem(s, x.itemId)) if (!openCountFor(s, b)) out.push(countEvent(s, b, 'EXCEPTION_NOT_FOUND', k++, x.itemId));
      return yes(out);
    }
    case 'DeliverException': {
      const x = s.exceptions[cmd.exceptionId];
      if (!x) return no('EXCEPTION_NOT_FOUND');
      if (x.associateId !== actor) return no('EXCEPTION_NOT_YOURS', { by: x.associateId ?? '' });
      if (x.status !== 'FOUND') return no('EXCEPTION_STATE', { status: x.status });
      const o = s.orders[x.orderId];
      if (!o || o.status === 'CANCELLED') return no('ORDER_CANCELLED');
      if (o.status === 'COMPLETED') return no('ORDER_COMPLETED');
      const tote = o.toteIds.map((id) => s.totes[id]).find((t) => t?.lines.some((l) => l.lineId === x.lineId));
      if (!tote) return no('TOTE_NOT_FOUND');
      if (tote.status !== 'STAGED' || !tote.slotCode) return no('TOTE_NOT_STAGED', { status: tote.status });
      const slot = cmd.slotCode.trim().toUpperCase();
      if (slot !== tote.slotCode) return no('LOCATION_MISMATCH', { expected: tote.slotCode });
      return yes([ev('ExceptionDeliveredToStaging', { exceptionId: x.id, toteId: tote.id, slotCode: slot })]);
    }
    // 订单已交付或已取消（流程梳理发现，决策记录 0025）：取出的商品送不到暂存了，放回货架
    case 'ReturnExceptionItems': {
      const x = s.exceptions[cmd.exceptionId];
      if (!x) return no('EXCEPTION_NOT_FOUND');
      if (x.associateId !== actor) return no('EXCEPTION_NOT_YOURS', { by: x.associateId ?? '' });
      if (x.status !== 'FOUND') return no('EXCEPTION_STATE', { status: x.status });
      const o = s.orders[x.orderId];
      if (o && o.status !== 'CANCELLED' && o.status !== 'COMPLETED') return no('EXCEPTION_STATE', { status: x.status });
      return yes([ev('ExceptionItemsReturned', { exceptionId: x.id, itemId: x.itemId, units: x.units ?? x.qty })]);
    }
    // —— 收货 ——
    case 'CreateAsn': {
      if (!cmd.lines.length) return no('INVALID_ORDER');
      for (const l of cmd.lines) if (!ctx.itemExists(l.itemId) || !Number.isInteger(l.cases) || l.cases <= 0) return no('ITEM_NOT_FOUND', { itemId: l.itemId });
      const expectedAt = cmd.expectedAt !== undefined && Number.isFinite(cmd.expectedAt) ? Math.round(cmd.expectedAt) : undefined;
      return yes([ev('AsnReceived', { receiptId: `R${String(s.counters.receipts + 1).padStart(4, '0')}`, supplier: cmd.supplier, expected: cmd.lines, ...(expectedAt !== undefined ? { expectedAt } : {}) })]);
    }
    case 'UpdateAsnEta': {
      const r = s.receipts[cmd.receiptId];
      if (!r) return no('RECEIPT_NOT_FOUND');
      if (r.arrivedAt !== undefined || r.closedAt !== undefined) return no('RECEIPT_CLOSED');
      if (!Number.isFinite(cmd.expectedAt)) return no('ETA_INVALID');
      if (r.expectedAt === Math.round(cmd.expectedAt)) return yes([]);
      return yes([ev('AsnEtaUpdated', { receiptId: r.id, expectedAt: Math.round(cmd.expectedAt), ...(r.expectedAt !== undefined ? { previous: r.expectedAt } : {}) })]);
    }
    case 'ArriveTruck': {
      const r = s.receipts[cmd.receiptId];
      if (!r) return no('RECEIPT_NOT_FOUND');
      if (r.arrivedAt) return yes([]);
      return yes([ev('TruckArrived', { receiptId: r.id })]);
    }
    case 'ReceiveCases': {
      const r = s.receipts[cmd.receiptId];
      if (!r) return no('RECEIPT_NOT_FOUND');
      if (r.closedAt) return no('RECEIPT_CLOSED');
      // 第一次扫箱就算卡车到了（决策记录 0026：不用先点「卡车已到」）
      const arrive: PendingEvent[] = r.arrivedAt ? [] : [ev('TruckArrived', { receiptId: r.id })];
      const itemId = ctx.itemByGtin(cmd.gtin);
      if (!itemId) return no('ITEM_NOT_FOUND');
      if (!Number.isInteger(cmd.cases) || cmd.cases <= 0 || cmd.cases > 200) return no('QTY_INVALID', { remaining: 200 });
      const p = byItem.get(itemId);
      const asn = r.expected.find((l) => l.itemId === itemId);
      const packQty = asn?.packQty ?? p?.packQty ?? 12;
      // 扫描箱上原有条码后自动生成内部箱号，按托盘批量打印内部标签（决策 I-02）
      const caseIds = Array.from({ length: cmd.cases }, (_, i) => makeCaseId(at, s.counters.cases + i + 1));
      // 批号和保质期（决策记录 0024 · C4）：日期写法不对时不收
      const lot = typeof cmd.lot === 'string' && cmd.lot.trim() ? cmd.lot.trim().slice(0, 20) : undefined;
      if (cmd.expiry !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(cmd.expiry)) return no('DATE_INVALID');
      return yes([...arrive, ev('CasesReceived', { receiptId: r.id, itemId, gtin: gtin14(cmd.gtin), name: asn?.name ?? p?.name ?? itemId, packQty, caseIds, damaged: !!cmd.damaged, ...(lot ? { lot } : {}), ...(cmd.expiry ? { expiry: cmd.expiry } : {}) })]);
    }
    case 'CloseReceipt': {
      const r = s.receipts[cmd.receiptId];
      if (!r) return no('RECEIPT_NOT_FOUND');
      if (r.closedAt) return no('RECEIPT_CLOSED');
      if (!r.arrivedAt) return no('RECEIPT_NOT_ARRIVED');
      const diffs: Discrepancy[] = [];
      const ids = new Set([...r.expected.map((l) => l.itemId), ...Object.keys(r.received)]);
      for (const itemId of [...ids].sort()) {
        const expected = r.expected.filter((l) => l.itemId === itemId).reduce((n, l) => n + l.cases, 0);
        const got = r.received[itemId] ?? { cases: 0, damaged: 0 };
        const received = got.cases + got.damaged;
        if (received < expected) diffs.push({ itemId, expected, received, damaged: got.damaged, kind: 'SHORT' });
        else if (received > expected) diffs.push({ itemId, expected, received, damaged: got.damaged, kind: 'OVER' });
        if (got.damaged > 0) diffs.push({ itemId, expected, received, damaged: got.damaged, kind: 'DAMAGED' });
      }
      return yes([ev('ReceiptClosed', { receiptId: r.id, discrepancies: diffs })]);
    }
    case 'PutAwayCase': {
      const c = s.cases[cmd.caseId.trim().toUpperCase()];
      if (!c) return no('CASE_NOT_FOUND');
      if (c.state === 'EMPTY' || c.state === 'LOST') return no('CASE_EMPTY');
      const code = cmd.binCode.trim().toUpperCase();
      const bin = binIndex(st).get(code);
      if (!bin) return no('BIN_NOT_FOUND');
      if (c.binCode === code && c.state === 'STORED') return no('SAME_SLOT');
      const p = byItem.get(c.itemId);
      const check = checkBin(bin, { tempZone: p?.tempZone ?? bin.tempZone, chemical: p?.chemical ?? false, area: p?.area ?? bin.area }, s.bins[code]?.length ?? 0, c.status);
      if (check !== 'OK') return no(BIN_REJECT[check], { bin: bin.tempZone, area: bin.area });
      return yes([ev('CasePutAway', { caseId: c.id, binCode: code })]);
    }
    case 'ChangeCaseStatus': {
      const c = s.cases[cmd.caseId.trim().toUpperCase()];
      if (!c) return no('CASE_NOT_FOUND');
      if (c.state === 'EMPTY' || c.state === 'LOST') return no('CASE_EMPTY');
      if (c.status === cmd.status && !cmd.binCode) return yes([]);
      // 召回中的商品不能放回可售（流程梳理发现，决策记录 0025）
      if (cmd.status === 'SELLABLE' && caseRecalled(s, c)) return no('ITEM_RECALLED');
      const p: { caseId: string; status: typeof cmd.status; binCode?: string } = { caseId: c.id, status: cmd.status };
      if (cmd.binCode) {
        const code = cmd.binCode.trim().toUpperCase();
        const bin = binIndex(st).get(code);
        if (!bin) return no('BIN_NOT_FOUND');
        const item = byItem.get(c.itemId);
        const check = checkBin(bin, { tempZone: item?.tempZone ?? bin.tempZone, chemical: item?.chemical ?? false, area: item?.area ?? bin.area }, s.bins[code]?.length ?? 0, cmd.status);
        // 退供应商 / 报废区不按大类分区，只检查温区、状态和容量
        if (check !== 'OK' && !(check === 'ISOLATION' && cmd.status !== 'SELLABLE')) return no(BIN_REJECT[check], { bin: bin.tempZone, area: bin.area });
        p.binCode = code;
      }
      return yes([ev('CaseStatusChanged', p)]);
    }
    // —— 盘点 ——
    case 'CreateCount': {
      const code = cmd.binCode.trim().toUpperCase();
      if (!binIndex(st).get(code)) return no('BIN_NOT_FOUND');
      if (openCountFor(s, code)) return no('TASK_EXISTS');
      return yes([countEvent(s, code, 'MANUAL', 0, cmd.itemId)]);
    }
    case 'ClaimCount': {
      const c = s.counts[cmd.countId];
      if (!c) return no('COUNT_NOT_FOUND');
      if (c.status === 'DONE') return no('COUNT_DONE');
      if (c.status === 'CLAIMED') return c.associateId === actor ? yes([]) : no('COUNT_TAKEN', { by: c.associateId ?? '' });
      return yes([ev('CycleCountClaimed', { countId: c.id })]);
    }
    case 'ReleaseCount': {
      const c = s.counts[cmd.countId];
      if (!c) return no('COUNT_NOT_FOUND');
      if (c.status !== 'CLAIMED' || c.associateId !== actor) return no('COUNT_TAKEN', { by: c.associateId ?? '' });
      return yes([ev('CycleCountReleased', { countId: c.id })]);
    }
    case 'CompleteCount': {
      const c = s.counts[cmd.countId];
      if (!c) return no('COUNT_NOT_FOUND');
      if (c.status === 'DONE') return no('COUNT_DONE');
      if (c.associateId !== actor) return no('COUNT_TAKEN', { by: c.associateId ?? '' });
      // 开始数之前扫库位标签（决策记录 0026）
      if (cmd.binCode !== undefined && cmd.binCode.trim().toUpperCase() !== c.binCode) return no('LOCATION_MISMATCH', { expected: c.binCode });
      if (cmd.binCode === undefined && requireScan(s)) return no('SCAN_REQUIRED');
      const inBin = (s.bins[c.binCode] ?? []).map((id) => s.cases[id]).filter((x): x is LiveCase => !!x && x.state === 'STORED');
      const results: Array<{ itemId: string; expected: number; counted: number }> = [];
      const lostCaseIds: string[] = [];
      const foundCases: Array<{ caseId: string; itemId: string; gtin: string; name: string; packQty: number }> = [];
      let made = 0;
      for (const r of cmd.results) {
        if (!Number.isInteger(r.counted) || r.counted < 0) return no('QTY_INVALID', { remaining: 0 });
        const mine = inBin.filter((x) => x.itemId === r.itemId).sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id));
        const expected = mine.length;
        results.push({ itemId: r.itemId, expected, counted: r.counted });
        // 少了：最近收货的箱子记为丢失；多了：按陈列表的箱规补建箱子
        for (const x of mine.slice(0, Math.max(0, expected - r.counted))) lostCaseIds.push(x.id);
        if (r.counted > expected) {
          const p = byItem.get(r.itemId);
          if (!p && !ctx.itemExists(r.itemId)) return no('ITEM_NOT_FOUND', { itemId: r.itemId });
          for (let k = 0; k < r.counted - expected; k++) {
            made++;
            foundCases.push({ caseId: makeCaseId(at, s.counters.cases + made), itemId: r.itemId, gtin: p ? gtin14(p.gtin) : '', name: p?.name ?? r.itemId, packQty: p?.packQty ?? 12 });
          }
        }
      }
      return yes([ev('CycleCountCompleted', { countId: c.id, binCode: c.binCode, results, lostCaseIds, foundCases })]);
    }
    // —— 货架存量与补货 ——
    case 'RecordSales': {
      const lines: Array<{ itemId: string; locationId: string; qty: number }> = [];
      const after = new Map<string, number>();
      for (const l of cmd.lines) {
        const p = byItem.get(l.itemId);
        if (!p || !Number.isFinite(l.qty) || l.qty <= 0) continue;
        lines.push({ itemId: l.itemId, locationId: p.locationId, qty: l.qty });
        after.set(p.itemId, Math.max(0, (after.get(p.itemId) ?? shelfNow(s, p).est) - l.qty));
      }
      if (!lines.length) return yes([]);
      const out: PendingEvent[] = [ev('SalesRecorded', { lines })];
      out.push(...thresholdTasks(s, st, [...after.entries()], 'LOW', 0));
      return yes(out);
    }
    case 'RecordSensor': {
      const here = locationIndex(st).get(cmd.locationId.trim().toUpperCase()) ?? [];
      // 传感器装在某个商品的通道上：优先用指定的商品，其次用这个货位上配了同类传感器的商品
      const p = (cmd.itemId ? here.find((x) => x.itemId === cmd.itemId) : undefined) ?? here.find((x) => x.sensor === cmd.sensor) ?? here[0];
      if (!p) return no('LOCATION_NOT_FOUND');
      const sh = shelfNow(s, p);
      const units = Math.round(cmd.units);
      const anomaly = !Number.isFinite(cmd.units) || units < 0 || units > p.capacity + 1 || cmd.confidence < 0.3;
      // 只有变化、异常或超过 10 分钟心跳时才写事件
      const changed = anomaly !== !!sh.sensorAnomaly || units !== Math.round(sh.est) || Math.abs(cmd.confidence - sh.conf) > 0.2 || sh.sensorAt === undefined || at - sh.sensorAt > 10 * 60_000;
      if (!changed) return yes([]);
      const out: PendingEvent[] = [ev('SensorReading', { locationId: p.locationId, itemId: p.itemId, sensor: cmd.sensor, units: Math.max(0, units), confidence: Math.max(0, Math.min(1, cmd.confidence)), anomaly })];
      if (!anomaly) out.push(...thresholdTasks(s, st, [[p.itemId, units]], 'SENSOR', 0));
      return yes(out);
    }
    case 'ConfirmShelf': {
      const p = byItem.get(cmd.itemId);
      if (!p) return no('ITEM_NOT_FOUND');
      if (!Number.isInteger(cmd.units) || cmd.units < 0 || cmd.units > p.capacity * 3) return no('QTY_INVALID', { remaining: 0 });
      let checkId: string | undefined;
      if (cmd.checkId) {
        const c = s.checks[cmd.checkId];
        if (!c || c.itemId !== p.itemId) return no('CHECK_NOT_FOUND');
        if (c.status === 'DONE') return no('CHECK_DONE');
        // 核对时扫货位（决策记录 0026）：扫了就核对；门店要求扫码时必须扫
        if (cmd.locationId !== undefined && cmd.locationId.trim().toUpperCase() !== c.locationId) return no('LOCATION_MISMATCH', { expected: c.locationId });
        if (cmd.locationId === undefined && requireScan(s)) return no('SCAN_REQUIRED');
        checkId = c.id;
        // 货架上的批次任务（决策记录 0026）：贴折扣签、下架过期、拿下来捐赠、退货放回 —— 数的是做了几件，不是货架上有几件
        if (LOT_TASKS.includes(c.reason)) {
          const kind = c.reason as 'MARKDOWN' | 'PULL' | 'DONATE' | 'RETURN';
          const out: PendingEvent[] = [ev('LotTaskDone', { checkId: c.id, itemId: p.itemId, kind, ...(c.lot ? { lot: c.lot } : {}), units: cmd.units })];
          if (kind === 'DONATE' && c.lot && cmd.units > 0) out.push(ev('LotDonated', { itemId: p.itemId, lot: c.lot, units: cmd.units, ...(c.recId ? { recId: c.recId } : {}) }));
          return yes(out);
        }
      } else {
        // 没指定任务时，顺带完成这个商品未完成的核对任务（不含批次任务）
        checkId = Object.values(s.checks).find((c) => c.itemId === p.itemId && c.status === 'OPEN' && !LOT_TASKS.includes(c.reason))?.id;
      }
      const prev = Math.round(shelfNow(s, p).est);
      // 顺路核对（决策记录 0022 · C3）：只认这个批次里还没做的核对
      const walkId = cmd.walkId && s.walks[cmd.walkId]?.checks?.some((c) => c.itemId === p.itemId && c.status === 'OPEN') ? cmd.walkId : undefined;
      // 附近找一找（决策记录 0022 · C1）：都没有时数量只能是 0
      if (cmd.found !== undefined && (!['HOME', 'NEARBY', 'NONE'].includes(cmd.found) || (cmd.found === 'NONE' && cmd.units > 0))) return no('QTY_INVALID', { remaining: 0 });
      const out: PendingEvent[] = [ev('ShelfCounted', { itemId: p.itemId, locationId: p.locationId, units: cmd.units, previousEst: prev, ...(checkId ? { checkId } : {}), ...(walkId ? { walkId } : {}), ...(cmd.found ? { found: cmd.found } : {}) })];
      out.push(...thresholdTasks(s, st, [[p.itemId, cmd.units]], 'LOW', 0));
      return yes(out);
    }
    case 'SkipWalkCheck': {
      const w = s.walks[cmd.walkId];
      if (!w) return no('WALK_NOT_FOUND');
      if (w.associateId !== env.actor) return no('WALK_NOT_YOURS');
      if (!w.checks?.some((c) => c.itemId === cmd.itemId && c.status === 'OPEN')) return no('CHECK_NOT_FOUND');
      return yes([ev('WalkCheckSkipped', { walkId: w.id, itemId: cmd.itemId })]);
    }
    case 'RequestReplenishment': {
      const p = byItem.get(cmd.itemId);
      if (!p) return no('ITEM_NOT_FOUND');
      if (openTaskAt(s, p.itemId)) return no('TASK_EXISTS');
      const e = replTaskEvent(s, st, p, 'MANUAL', 0, undefined, onlineDemand(s).get(p.itemId) ?? 0);
      if (!e) return no('NO_BACKROOM_STOCK');
      return yes([e]);
    }
    case 'ClaimReplenishment': {
      const ids: string[] = [];
      for (const id of cmd.taskIds) {
        const t = s.repl[id];
        if (!t) return no('TASK_NOT_FOUND');
        if (t.status === 'DONE' || t.status === 'CANCELLED') return no('TASK_DONE');
        if (t.status === 'CLAIMED') {
          if (t.associateId !== actor) return no('TASK_TAKEN', { by: t.associateId ?? '' });
          continue;
        }
        ids.push(id);
      }
      return yes(ids.length ? [ev('ReplenishmentClaimed', { taskIds: ids })] : []);
    }
    case 'ReleaseReplenishment': {
      const ids = cmd.taskIds.filter((id) => s.repl[id]?.status === 'CLAIMED' && s.repl[id]?.associateId === actor);
      return yes(ids.length ? [ev('ReplenishmentReleased', { taskIds: ids })] : []);
    }
    case 'CompleteReplenishment': {
      const t = s.repl[cmd.taskId];
      if (!t) return no('TASK_NOT_FOUND');
      if (t.status === 'DONE' || t.status === 'CANCELLED') return no('TASK_DONE');
      if (t.associateId !== actor || t.status !== 'CLAIMED') return no('TASK_NOT_YOURS', { by: t.associateId ?? '' });
      // 扫描货位确认摆放位置（决策 P-06）
      if (cmd.locationId.trim().toUpperCase() !== t.locationId.toUpperCase()) return no('LOCATION_MISMATCH', { expected: t.locationId });
      const c = s.cases[cmd.caseId.trim().toUpperCase()];
      if (!c) return no('CASE_NOT_FOUND');
      if (c.itemId !== t.itemId) return no('CASE_WRONG_ITEM');
      if (c.state !== 'STORED' || c.status !== 'SELLABLE' || c.units <= 0) return no('CASE_EMPTY');
      if (!Number.isInteger(cmd.units) || cmd.units <= 0 || cmd.units > c.units) return no('QTY_INVALID', { remaining: c.units });
      return yes([ev('ReplenishmentCompleted', { taskId: t.id, locationId: t.locationId, itemId: t.itemId, caseId: c.id, units: cmd.units })]);
    }
    case 'CancelReplenishment': {
      const t = s.repl[cmd.taskId];
      if (!t) return no('TASK_NOT_FOUND');
      if (t.status === 'DONE' || t.status === 'CANCELLED') return no('TASK_DONE');
      if (t.status === 'CLAIMED' && t.associateId !== actor) return no('TASK_NOT_YOURS', { by: t.associateId ?? '' });
      // 后仓按记录找不到：生成盘点任务。说了找过哪个库位时只盘这个库位（别的库位的箱子照样能补货，决策记录 0026）；
      // 没说时整个商品标为可疑，盘所有库位
      const bin = cmd.binCode?.trim().toUpperCase();
      const out: PendingEvent[] = [ev('ReplenishmentCancelled', { taskId: t.id, reason: 'NOT_FOUND', ...(bin ? { binCode: bin } : {}) })];
      let k = 0;
      for (const b of bin ? [bin] : binsOfItem(s, t.itemId)) if (!openCountFor(s, b)) out.push(countEvent(s, b, 'REPLENISH_NOT_FOUND', k++, t.itemId));
      return yes(out);
    }
  }
}

/** 估算低于阈值的商品生成补货任务（同一条命令里已生成的不重复）；entries 为 [商品, 估算件数] */
function thresholdTasks(s: OpsState, st: StoreStatic, entries: Array<[string, number]>, reason: ReplReason, offset: number): PendingEvent[] {
  const index = planogramIndex(st);
  const demand = onlineDemand(s);
  const out: PendingEvent[] = [];
  for (const [itemId, est] of entries) {
    const p = index.get(itemId);
    if (!p) continue;
    const sh = shelfNow(s, p);
    const need = { est, capacity: p.capacity, velocityPerHour: sh.velocity, onlineDemand: demand.get(p.itemId) ?? 0 };
    if (!needsReplenishment(need, st.replenish)) continue;
    const e = replTaskEvent(s, st, p, est <= 0 ? 'EMPTY' : reason, offset + out.length, est, need.onlineDemand);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 排程里的库存部分：低于阈值的货位生成补货任务（最多 limit 个，按优先级）；到期的周期盘点（每次最多 3 个）。
 */
export function inventoryTick(s: OpsState, st: StoreStatic, at: number, limit = 20): PendingEvent[] {
  const demand = onlineDemand(s);
  // 按断货概率排（决策记录 0021 · C2）：已下单的线上需求是已经知道的未来需求；
  // 原来的低库存规则仍然触发任务，另外断货概率 ≥ 50% 的也生成任务（原因「可能断货」）
  const need2 = onlineNeed(s, st, at);
  const candidates: Array<{ p: PlanogramEntry; priority: number; risk: number; why: ReplWhy; rule: boolean }> = [];
  for (const p of st.planogram) {
    if (s.suspect[p.itemId] !== undefined || !usableCases(s, p.itemId).length || openTaskAt(s, p.itemId)) continue;
    const sh = shelfNow(s, p);
    const need = { est: sh.est, capacity: p.capacity, velocityPerHour: sh.velocity, onlineDemand: demand.get(p.itemId) ?? 0 };
    const x = riskFor(s, st, p, at, sh.est, need2);
    const rule = needsReplenishment(need, st.replenish);
    if (!rule && x.risk < 0.5) continue;
    candidates.push({ p, priority: Math.min(replenishPriority({ ...need, unitPrice: p.unitPrice }), x.priority), risk: x.risk, why: x.why, rule });
  }
  candidates.sort((a, b) => a.priority - b.priority || b.risk - a.risk || a.p.locationId.localeCompare(b.p.locationId));
  const out: PendingEvent[] = [];
  for (const c of candidates.slice(0, limit)) {
    const sh = shelfNow(s, c.p);
    const e = replTaskEvent(s, st, c.p, sh.est <= 0 ? 'EMPTY' : c.rule ? 'LOW' : 'RISK', out.length, undefined, demand.get(c.p.itemId) ?? 0, { priority: c.priority, risk: c.risk, why: c.why });
    if (e) out.push(e);
  }
  // 周期盘点：库位里价值最高的商品决定周期（A 每周、B 每月、C 每季度）
  const abcOf = new Map<string, AbcClass>(st.planogram.map((p) => [p.itemId, p.abc]));
  const rank: Record<AbcClass, number> = { A: 0, B: 1, C: 2 };
  const due: Array<{ bin: string; overdue: number }> = [];
  for (const [bin, ids] of Object.entries(s.bins)) {
    if (openCountFor(s, bin)) continue;
    let cls: AbcClass = 'C';
    for (const id of ids) {
      const a = abcOf.get(s.cases[id]?.itemId ?? '') ?? 'C';
      if (rank[a] < rank[cls]) cls = a;
    }
    const last = s.countedAt[bin] ?? 0;
    const overdue = at - last - COUNT_INTERVAL_DAYS[cls] * 86_400_000;
    if (overdue >= 0) due.push({ bin, overdue });
  }
  due.sort((a, b) => b.overdue - a.overdue || a.bin.localeCompare(b.bin));
  due.slice(0, 3).forEach((d, i) => out.push(countEvent(s, d.bin, 'SCHEDULED', i)));
  // 过期的批次（决策记录 0026）：生成「下架」任务，每一批只生成一次（食品安全，不用等人确认）
  const today = dateOf(at);
  let pulls = 0;
  for (const [itemId, lots] of Object.entries(s.shelfLots ?? {})) {
    const p = byItemOf(st).get(itemId);
    if (!p) continue;
    for (const l of lots) {
      if (!l.expiry || l.expiry >= today || l.units <= 0 || pulls >= 5) continue;
      if (Object.values(s.checks).some((c) => c.reason === 'PULL' && c.itemId === itemId && c.lot === l.lot)) continue;
      out.push(ev('ShelfCheckRequested', { checkId: `SC${String(s.counters.checks + 1 + pulls).padStart(4, '0')}`, itemId, locationId: p.locationId, reason: 'PULL', lot: l.lot, expected: l.units }));
      pulls++;
    }
  }
  return out;
}

const byItemOf = (st: StoreStatic) => planogramByItem(st);

/**
 * 补货队列：未领取的任务按通道合并成批（决策 R-05）。
 * 给了门店静态数据时还按推车的装载上限分批（决策记录 0026）：一批的箱子加起来不超过推车的重量和体积。
 */
export function replBatches(s: OpsState, st?: StoreStatic) {
  const open = Object.values(s.repl).filter((t) => t.status === 'OPEN');
  if (!st) return batchByArea(open.map((t) => ({ ...t, area: t.area })));
  const plan = planogramByItem(st);
  return batchByArea(
    open.map((t) => ({ ...t, area: t.area })),
    st.replenish?.batchSize ?? DEFAULT_REPLENISH_RULES.batchSize,
    { kg: st.replenish?.cartKg ?? DEFAULT_CART.kg, liters: st.replenish?.cartL ?? DEFAULT_CART.liters, weight: (t) => plan.get(t.itemId)?.caseKg ?? 0, volume: (t) => plan.get(t.itemId)?.caseL ?? 0 },
  );
}

/** 一批任务（每个一箱）大约多重、多大，和推车的上限（补货页显示） */
export function batchLoad(st: StoreStatic, tasks: ReadonlyArray<{ itemId: string }>): { kg: number; liters: number; cartKg: number; cartL: number } {
  const plan = planogramByItem(st);
  const kg = tasks.reduce((n, t) => n + (plan.get(t.itemId)?.caseKg ?? 0), 0);
  const liters = tasks.reduce((n, t) => n + (plan.get(t.itemId)?.caseL ?? 0), 0);
  return { kg: Math.round(kg), liters: Math.round(liters), cartKg: st.replenish?.cartKg ?? DEFAULT_CART.kg, cartL: st.replenish?.cartL ?? DEFAULT_CART.liters };
}
