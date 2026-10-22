import { batchByArea, checkBin, needsReplenishment, replenishPriority, suggestedUnits, COUNT_INTERVAL_DAYS, type AbcClass, type BinCheck } from '@storewright/algorithms/replenish';
import { caseId as makeCaseId, gtin14 } from '@storewright/domain';
import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type PendingEvent } from './events';
import { locationIndex, planogramIndex } from './apply';
import type { BinInfo, CountReason, Discrepancy, LiveCase, OpsState, PlanogramEntry, ReplReason, ShelfState, StoreStatic } from './types';

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
      | 'DeliverException'
      | 'CreateAsn'
      | 'ArriveTruck'
      | 'ReceiveCases'
      | 'CloseReceipt'
      | 'PutAwayCase'
      | 'ChangeCaseStatus'
      | 'CreateCount'
      | 'ClaimCount'
      | 'CompleteCount'
      | 'RecordSales'
      | 'RecordSensor'
      | 'RequestReplenishment'
      | 'ClaimReplenishment'
      | 'ReleaseReplenishment'
      | 'CompleteReplenishment'
      | 'CancelReplenishment'
      | 'ConfirmShelf';
  }
>;

export const INVENTORY_COMMANDS = new Set<OpsCommand['type']>([
  'ClaimException',
  'ExceptionFound',
  'ExceptionMissing',
  'DeliverException',
  'CreateAsn',
  'ArriveTruck',
  'ReceiveCases',
  'CloseReceipt',
  'PutAwayCase',
  'ChangeCaseStatus',
  'CreateCount',
  'ClaimCount',
  'CompleteCount',
  'RecordSales',
  'RecordSensor',
  'RequestReplenishment',
  'ClaimReplenishment',
  'ReleaseReplenishment',
  'CompleteReplenishment',
  'CancelReplenishment',
  'ConfirmShelf',
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
export function planogramByItem(st: StoreStatic): Map<string, PlanogramEntry> {
  return planogramIndex(st);
}

/** 商品在货架上的存量估算（没有记录时视为开门时补满） */
export function shelfNow(s: OpsState, p: PlanogramEntry): ShelfState {
  return s.shelf[p.itemId] ?? { est: p.capacity, conf: 0.5, source: 'INIT', at: 0, velocity: p.baseVelocity };
}

/** 后仓里某商品可售且有剩余的箱子，按收货时间先进先出 */
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

/** 生成补货任务的事件（检查后仓库存、重复任务） */
export function replTaskEvent(s: OpsState, st: StoreStatic, p: PlanogramEntry, reason: ReplReason, seqOffset: number, est?: number, demand = 0): PendingEvent | undefined {
  if (openTaskAt(s, p.itemId)) return undefined;
  if (s.suspect[p.itemId] !== undefined || !sellableCases(s, p.itemId).length) return undefined;
  const sh = shelfNow(s, p);
  const e = est ?? sh.est;
  const priority = replenishPriority({ est: e, capacity: p.capacity, velocityPerHour: sh.velocity, onlineDemand: demand, unitPrice: p.unitPrice });
  return ev('ReplenishmentTaskCreated', {
    taskId: `RP${String(s.counters.repl + 1 + seqOffset).padStart(4, '0')}`,
    locationId: p.locationId,
    itemId: p.itemId,
    area: p.runId,
    reason,
    suggestedUnits: Math.max(1, suggestedUnits({ est: e, capacity: p.capacity })),
    priority,
  });
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
        const hasStock = rest > 0 || sellableCases(s, x.itemId).some((k) => k.id !== c.id);
        if (hasStock && s.suspect[x.itemId] === undefined) {
          const sh = shelfNow(s, p);
          out.push(
            ev('ReplenishmentTaskCreated', {
              taskId: `RP${String(s.counters.repl + 1).padStart(4, '0')}`,
              locationId: p.locationId,
              itemId: p.itemId,
              area: p.runId,
              reason: 'EXCEPTION',
              suggestedUnits: Math.max(1, suggestedUnits({ est: sh.est, capacity: p.capacity })),
              priority: replenishPriority({ est: sh.est, capacity: p.capacity, velocityPerHour: sh.velocity, onlineDemand: 0, unitPrice: p.unitPrice }),
            }),
          );
        }
      }
      return yes(out);
    }
    case 'ExceptionMissing': {
      const x = s.exceptions[cmd.exceptionId];
      if (!x) return no('EXCEPTION_NOT_FOUND');
      if (x.associateId !== actor) return no('EXCEPTION_NOT_YOURS', { by: x.associateId ?? '' });
      if (x.status !== 'ASSIGNED') return no('EXCEPTION_STATE', { status: x.status });
      // 幽灵库存：记录标为可疑，生成盘点任务（决策 X-02）
      const out: PendingEvent[] = [ev('ExceptionNotFound', { exceptionId: x.id })];
      let k = 0;
      for (const bin of binsOfItem(s, x.itemId)) if (!openCountFor(s, bin)) out.push(countEvent(s, bin, 'EXCEPTION_NOT_FOUND', k++, x.itemId));
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
    // —— 收货 ——
    case 'CreateAsn': {
      if (!cmd.lines.length) return no('INVALID_ORDER');
      for (const l of cmd.lines) if (!ctx.itemExists(l.itemId) || !Number.isInteger(l.cases) || l.cases <= 0) return no('ITEM_NOT_FOUND', { itemId: l.itemId });
      return yes([ev('AsnReceived', { receiptId: `R${String(s.counters.receipts + 1).padStart(4, '0')}`, supplier: cmd.supplier, expected: cmd.lines })]);
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
      if (!r.arrivedAt) return no('RECEIPT_NOT_ARRIVED');
      const itemId = ctx.itemByGtin(cmd.gtin);
      if (!itemId) return no('ITEM_NOT_FOUND');
      if (!Number.isInteger(cmd.cases) || cmd.cases <= 0 || cmd.cases > 200) return no('QTY_INVALID', { remaining: 200 });
      const p = byItem.get(itemId);
      const asn = r.expected.find((l) => l.itemId === itemId);
      const packQty = asn?.packQty ?? p?.packQty ?? 12;
      // 扫描箱上原有条码后自动生成内部箱号，按托盘批量打印内部标签（决策 I-02）
      const caseIds = Array.from({ length: cmd.cases }, (_, i) => makeCaseId(at, s.counters.cases + i + 1));
      return yes([ev('CasesReceived', { receiptId: r.id, itemId, gtin: gtin14(cmd.gtin), name: asn?.name ?? p?.name ?? itemId, packQty, caseIds, damaged: !!cmd.damaged })]);
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
    case 'CompleteCount': {
      const c = s.counts[cmd.countId];
      if (!c) return no('COUNT_NOT_FOUND');
      if (c.status === 'DONE') return no('COUNT_DONE');
      if (c.associateId !== actor) return no('COUNT_TAKEN', { by: c.associateId ?? '' });
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
        checkId = c.id;
      } else {
        // 没指定任务时，顺带完成这个商品未完成的核对任务
        checkId = Object.values(s.checks).find((c) => c.itemId === p.itemId && c.status === 'OPEN')?.id;
      }
      const prev = Math.round(shelfNow(s, p).est);
      const out: PendingEvent[] = [ev('ShelfCounted', { itemId: p.itemId, locationId: p.locationId, units: cmd.units, previousEst: prev, ...(checkId ? { checkId } : {}) })];
      out.push(...thresholdTasks(s, st, [[p.itemId, cmd.units]], 'LOW', 0));
      return yes(out);
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
      // 后仓按记录找不到：记录标为可疑，生成盘点任务
      const out: PendingEvent[] = [ev('ReplenishmentCancelled', { taskId: t.id, reason: 'NOT_FOUND' })];
      let k = 0;
      for (const bin of binsOfItem(s, t.itemId)) if (!openCountFor(s, bin)) out.push(countEvent(s, bin, 'REPLENISH_NOT_FOUND', k++, t.itemId));
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
  const candidates: Array<{ p: PlanogramEntry; priority: number }> = [];
  for (const p of st.planogram) {
    if (s.suspect[p.itemId] !== undefined || !s.itemCases[p.itemId]?.length) continue;
    const sh = shelfNow(s, p);
    const need = { est: sh.est, capacity: p.capacity, velocityPerHour: sh.velocity, onlineDemand: demand.get(p.itemId) ?? 0 };
    if (!needsReplenishment(need, st.replenish) || openTaskAt(s, p.itemId)) continue;
    candidates.push({ p, priority: replenishPriority({ ...need, unitPrice: p.unitPrice }) });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.p.locationId.localeCompare(b.p.locationId));
  const out: PendingEvent[] = [];
  for (const c of candidates.slice(0, limit)) {
    const sh = shelfNow(s, c.p);
    const e = replTaskEvent(s, st, c.p, sh.est <= 0 ? 'EMPTY' : 'LOW', out.length, undefined, demand.get(c.p.itemId) ?? 0);
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
  return out;
}

/** 补货队列：未领取的任务按通道合并成批（决策 R-05） */
export function replBatches(s: OpsState) {
  const open = Object.values(s.repl).filter((t) => t.status === 'OPEN');
  return batchByArea(open.map((t) => ({ ...t, area: t.area })));
}
