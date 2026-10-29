import type { AnyOpsEvent } from './events';
import { applyAiEvent } from './ai';
import { applyStaffEvent } from './staff';
import { applyNoteEvent } from './notes';
import { applyAlertEvent } from './alerts';
import { applyModuleEvent } from './modules';
import { applyAssistEvent } from './assist';
import { applyNudgeEvent } from './nudges';
import { applyRosterEvent } from './roster';
import { applyMaintenanceEvent } from './maintenance';
import { applyColdEvent } from './coldchain';
import { applyCapacityEvent } from './capacity';
import { applyExpiryEvent, consumeLots, trimLots } from './expiry';
import { applyFieldEvent } from './fieldops';
import { applySettingsEvent } from './settings';
import { emptyState, type HandoffSession, type LiveCase, type LiveOrder, type OpsState, type PlanogramEntry, type ShelfLot, type ShelfState, type StoreStatic } from './types';

/**
 * 把一条事件应用到状态上（原地修改，返回同一个对象）。
 *
 * 服务端、员工端、模拟器都用这个函数从事件流还原状态。原地修改是为了让长事件流的重放足够快；
 * 界面层用状态里的 seq 判断是否需要重新渲染。事件必须按序号依次应用。
 */
export function applyEvent(s: OpsState, e: AnyOpsEvent, st?: StoreStatic): OpsState {
  s.seq = e.seq;
  s.at = e.at;
  const touch = (locationId?: string, slotCode?: string) => {
    if (!e.actor || e.actor === 'system') return;
    const a = (s.activity[e.actor] ??= {});
    a.lastScanAt = e.at;
    if (locationId) {
      a.lastLocationId = locationId;
      delete a.lastSlotCode;
    }
    if (slotCode) {
      a.lastSlotCode = slotCode;
      delete a.lastLocationId;
    }
  };
  if (applyAiEvent(s, e) || applyStaffEvent(s, e, st) || applyNoteEvent(s, e) || applyAlertEvent(s, e) || applyModuleEvent(s, e, st) || applyAssistEvent(s, e) || applyNudgeEvent(s, e) || applyRosterEvent(s, e) || applyMaintenanceEvent(s, e) || applyColdEvent(s, e) || applyCapacityEvent(s, e) || applyExpiryEvent(s, e) || applyFieldEvent(s, e, st) || applySettingsEvent(s, e)) return s;
  switch (e.type) {
    case 'OrderCreated': {
      const o = e.payload.order;
      s.orders[o.id] = { ...o, status: 'CREATED', createdAt: e.at, codeHash: e.payload.codeHash, toteIds: [], oversized: 0, lineResults: {} };
      break;
    }
    case 'OrderLocked': {
      const o = s.orders[e.payload.orderId];
      if (o) {
        o.status = 'LOCKED';
        o.lockedAt = e.at;
      }
      break;
    }
    case 'OrderCancelled': {
      const o = s.orders[e.payload.orderId];
      if (o) {
        o.status = 'CANCELLED';
        o.cancelledAt = e.at;
        o.cancelReason = e.payload.reason;
      }
      // 准备中取消（流程梳理发现，决策记录 0025）：这一单的交付准备结束，员工不再「忙」；已取出的框进回收专区的列表。
      // 行程里的订单全部取消或完成时，行程的准备也结束
      for (const [key, ss] of Object.entries(s.sessions)) {
        if (ss.status === 'COMPLETED' || !ss.orderIds.includes(e.payload.orderId)) continue;
        if (ss.orderIds.every((id) => s.orders[id]?.status === 'CANCELLED' || s.orders[id]?.status === 'COMPLETED')) delete s.sessions[key];
      }
      break;
    }
    case 'ToteAssignmentsCreated': {
      const o = s.orders[e.payload.orderId];
      for (const t of e.payload.totes) s.totes[t.id] = { ...t, status: 'PLANNED', labelVersion: 0 };
      if (o) {
        o.toteIds = e.payload.totes.map((t) => t.id);
        o.oversized = e.payload.oversized;
      }
      break;
    }
    case 'PickWalkCreated': {
      const w = e.payload.walk;
      s.walks[w.id] = { ...w, status: 'OPEN', createdAt: e.at, bound: [], done: {} };
      s.counters.walks += 1;
      for (const id of w.toteIds) {
        const t = s.totes[id];
        if (t) {
          t.status = 'IN_WALK';
          t.walkId = w.id;
        }
      }
      break;
    }
    case 'LabelPrinted': {
      const { labelId, toteId, version } = e.payload;
      s.labels[labelId] = { labelId, toteId, version, voided: false, printedAt: e.at, reprints: 0 };
      const t = s.totes[toteId];
      if (t) {
        t.labelId = labelId;
        t.labelVersion = version;
      }
      break;
    }
    case 'LabelReprinted': {
      const l = s.labels[e.payload.labelId];
      if (l) l.reprints += 1;
      break;
    }
    case 'LabelVoided': {
      const l = s.labels[e.payload.labelId];
      if (l) l.voided = true;
      break;
    }
    case 'LabelBound': {
      const l = s.labels[e.payload.labelId];
      const w = s.walks[e.payload.walkId];
      if (l && w && !w.bound.includes(l.toteId)) w.bound.push(l.toteId);
      const t = l ? s.totes[l.toteId] : undefined;
      if (t && t.status === 'IN_WALK') t.status = 'BOUND';
      touch();
      break;
    }
    case 'PickWalkClaimed': {
      const w = s.walks[e.payload.walkId];
      if (w) {
        w.status = 'CLAIMED';
        w.associateId = e.actor;
        w.claimedAt = e.at;
      }
      touch();
      break;
    }
    case 'PickWalkUnclaimed': {
      const w = s.walks[e.payload.walkId];
      if (w) {
        w.status = 'OPEN';
        delete w.associateId;
        delete w.claimedAt;
        // 解除绑定（决策记录 0026）：下一个人重新扫框
        for (const id of w.bound) {
          const t = s.totes[id];
          if (t && t.status === 'BOUND') t.status = 'IN_WALK';
        }
        w.bound = [];
      }
      break;
    }
    case 'ItemPicked':
    case 'ItemNotFound': {
      const p = e.payload;
      const w = s.walks[p.walkId];
      if (w) {
        const k = `${p.toteId}|${p.lineId}`;
        w.done[k] = (w.done[k] ?? 0) + p.qty;
        if (w.status === 'CLAIMED') {
          w.status = 'PICKING';
          w.startedAt = e.at;
        }
      }
      const t = s.totes[p.toteId];
      const o = t ? s.orders[t.orderId] : undefined;
      if (o) {
        const r = (o.lineResults[p.lineId] ??= { picked: 0, short: 0, substituted: 0 });
        if (e.type === 'ItemPicked') {
          r.picked += p.qty;
          r.pickedAt = e.at;
        } else if (e.payload.resolution === 'SHORT') r.short += p.qty;
        else if (e.payload.resolution === 'EXCEPTION') {
          r.short += p.qty;
          r.exception = true;
        }
        if (o.status === 'LOCKED') o.status = 'PICKING';
      }
      const lineItem = o?.lines.find((l) => l.lineId === p.lineId)?.itemId;
      // 线上拣货也按到期先后扣批次（决策记录 0024 · C4）
      if (lineItem && e.type === 'ItemPicked') consumeLots(s, lineItem, p.qty);
      const sh = lineItem ? shelfOf(s, st, lineItem, e.at) : undefined;
      if (sh) {
        if (e.type === 'ItemPicked') {
          sh.est = Math.max(0, sh.est - p.qty);
          sh.conf = Math.max(sh.conf, 0.7);
        } else {
          // 拣货员报告找不到 = 确认这个货位空了
          sh.est = 0;
          sh.conf = 0.95;
          sh.confirmedAt = e.at;
        }
        sh.source = 'SCAN';
        sh.at = e.at;
      }
      touch(p.locationId);
      break;
    }
    case 'SubstitutionPicked': {
      const p = e.payload;
      const t = s.totes[p.toteId];
      const o = t ? s.orders[t.orderId] : undefined;
      if (o) {
        const r = (o.lineResults[p.lineId] ??= { picked: 0, short: 0, substituted: 0 });
        r.substituted += p.qty;
        r.substituteName = p.itemName;
        r.substituteGtin = p.gtin;
        if (p.rank !== undefined) r.subRank = p.rank;
        if (p.model) r.subModel = p.model;
      }
      break;
    }
    case 'SubstitutionRated': {
      const o = s.orders[e.payload.orderId];
      const r = o?.lineResults[e.payload.lineId];
      if (r) {
        const first = r.subAccepted === undefined;
        r.subAccepted = e.payload.accepted;
        if (first) {
          const l = (s.subLabels ??= { n: 0, accepted: 0, top1: 0, top1Accepted: 0 });
          l.n++;
          if (e.payload.accepted) l.accepted++;
          if (r.subRank === 1) {
            l.top1++;
            if (e.payload.accepted) l.top1Accepted++;
          }
        }
      }
      break;
    }
    case 'ColdChainTimerStarted': {
      const w = s.walks[e.payload.walkId];
      if (w) w.coldStartedAt = e.at;
      break;
    }
    case 'ColdChainAlert': {
      const w = s.walks[e.payload.walkId];
      if (w) w.coldAlerted = true;
      break;
    }
    case 'PickWalkCompleted': {
      const w = s.walks[e.payload.walkId];
      if (w) {
        w.status = 'COMPLETED';
        w.completedAt = e.at;
        for (const id of w.toteIds) {
          const t = s.totes[id];
          if (t && (t.status === 'BOUND' || t.status === 'IN_WALK')) t.status = 'PICKED';
        }
      }
      break;
    }
    case 'ExceptionCreated': {
      const p = e.payload;
      const line = s.orders[p.orderId]?.lines.find((l) => l.lineId === p.lineId);
      s.exceptions[p.exceptionId] = {
        id: p.exceptionId,
        orderId: p.orderId,
        lineId: p.lineId,
        walkId: p.walkId,
        createdAt: e.at,
        itemId: p.itemId ?? line?.itemId ?? '',
        qty: p.qty ?? line?.qty ?? 1,
        status: 'OPEN',
      };
      s.counters.exceptions += 1;
      break;
    }
    case 'ExceptionAssigned': {
      const x = s.exceptions[e.payload.exceptionId];
      if (x) {
        x.status = 'ASSIGNED';
        x.associateId = e.actor;
        x.assignedAt = e.at;
      }
      touch();
      break;
    }
    case 'ExceptionItemFound': {
      const p = e.payload;
      const x = s.exceptions[p.exceptionId];
      if (x) {
        x.status = 'FOUND';
        x.caseId = p.caseId;
        x.foundAt = e.at;
        x.units = p.units;
      }
      takeFromCase(s, p.caseId, p.units);
      touch();
      break;
    }
    case 'ExceptionNotFound': {
      const x = s.exceptions[e.payload.exceptionId];
      if (x) {
        x.status = 'NOT_FOUND';
        if (!e.payload.binCode) s.suspect[x.itemId] = e.at;
      }
      touch();
      break;
    }
    case 'ExceptionDeliveredToStaging': {
      const p = e.payload;
      const x = s.exceptions[p.exceptionId];
      if (x) {
        x.status = 'DELIVERED';
        x.deliveredAt = e.at;
        x.slotCode = p.slotCode;
        const o = s.orders[x.orderId];
        const r = o?.lineResults[x.lineId];
        if (r) {
          // 按实际取出的件数记（箱子里不够时比要的少）
          const n = Math.min(r.short, x.units ?? x.qty);
          r.short -= n;
          r.picked += n;
          r.recovered = (r.recovered ?? 0) + n;
          r.exception = false;
        }
      }
      touch(undefined, p.slotCode);
      break;
    }
    case 'ExceptionVoided': {
      const x = s.exceptions[e.payload.exceptionId];
      if (x) x.status = 'VOID';
      break;
    }
    case 'ExceptionReleased': {
      const x = s.exceptions[e.payload.exceptionId];
      if (x) {
        x.status = 'OPEN';
        delete x.associateId;
      }
      break;
    }
    case 'ExceptionItemsReturned': {
      const p = e.payload;
      const x = s.exceptions[p.exceptionId];
      if (x) x.status = 'VOID';
      // 放回货架：货架估算加上这些件数
      const sh = shelfOf(s, st, p.itemId, e.at);
      if (sh && p.units > 0) {
        const cap = st ? (planogramIndex(st).get(p.itemId)?.capacity ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        sh.est = Math.min(cap, sh.est + p.units);
        sh.at = e.at;
      }
      touch();
      break;
    }
    // —— 后仓库存 ——
    case 'InventoryLoaded': {
      for (const c of e.payload.cases) {
        addCase(s, { id: c.caseId, itemId: c.itemId, gtin: c.gtin, name: c.name, packQty: c.packQty, units: c.units, status: 'SELLABLE', state: 'STORED', binCode: c.binCode, receivedAt: e.at });
        s.countedAt[c.binCode] = e.at;
      }
      s.counters.cases += e.payload.cases.length;
      break;
    }
    case 'AsnReceived': {
      const p = e.payload;
      s.receipts[p.receiptId] = { id: p.receiptId, supplier: p.supplier, expected: p.expected, createdAt: e.at, received: {}, ...(p.expectedAt !== undefined ? { expectedAt: p.expectedAt } : {}) };
      s.counters.receipts += 1;
      break;
    }
    case 'AsnEtaUpdated': {
      const r = s.receipts[e.payload.receiptId];
      if (r) {
        if (r.firstExpectedAt === undefined && r.expectedAt !== undefined) r.firstExpectedAt = r.expectedAt;
        r.expectedAt = e.payload.expectedAt;
      }
      break;
    }
    case 'TruckArrived': {
      const r = s.receipts[e.payload.receiptId];
      if (r) r.arrivedAt = e.at;
      break;
    }
    case 'CasesReceived': {
      const p = e.payload;
      const r = s.receipts[p.receiptId];
      for (const id of p.caseIds) {
        addCase(s, { id, itemId: p.itemId, gtin: p.gtin, name: p.name, packQty: p.packQty, units: p.packQty, status: p.damaged ? 'QA' : 'SELLABLE', state: 'RECEIVED', receiptId: p.receiptId, receivedAt: e.at, ...(p.damaged ? { damaged: true } : {}), ...(p.lot ? { lot: p.lot } : {}), ...(p.expiry ? { expiry: p.expiry } : {}) });
      }
      s.counters.cases += p.caseIds.length;
      if (r) {
        const got = (r.received[p.itemId] ??= { cases: 0, damaged: 0 });
        if (p.damaged) got.damaged += p.caseIds.length;
        else got.cases += p.caseIds.length;
      }
      touch();
      break;
    }
    case 'ReceiptClosed': {
      const r = s.receipts[e.payload.receiptId];
      if (r) {
        r.closedAt = e.at;
        r.discrepancies = e.payload.discrepancies;
      }
      break;
    }
    case 'CasePutAway': {
      const c = s.cases[e.payload.caseId];
      if (c) {
        unlinkCase(s, c);
        c.binCode = e.payload.binCode;
        c.state = 'STORED';
        linkCase(s, c);
      }
      touch();
      break;
    }
    case 'CaseStatusChanged': {
      const c = s.cases[e.payload.caseId];
      if (c) {
        unlinkCase(s, c);
        c.status = e.payload.status;
        if (e.payload.binCode) {
          c.binCode = e.payload.binCode;
          c.state = 'STORED';
        }
        linkCase(s, c);
      }
      break;
    }
    case 'CycleCountCreated': {
      const p = e.payload;
      s.counts[p.countId] = { id: p.countId, binCode: p.binCode, reason: p.reason, createdAt: e.at, status: 'OPEN', ...(p.itemId ? { itemId: p.itemId } : {}) };
      s.counters.counts += 1;
      break;
    }
    case 'CycleCountClaimed': {
      const c = s.counts[e.payload.countId];
      if (c) {
        c.status = 'CLAIMED';
        c.associateId = e.actor;
      }
      break;
    }
    case 'CycleCountReleased': {
      const c = s.counts[e.payload.countId];
      if (c) {
        c.status = 'OPEN';
        delete c.associateId;
      }
      break;
    }
    case 'CycleCountCompleted': {
      const p = e.payload;
      const c = s.counts[p.countId];
      if (c) {
        c.status = 'DONE';
        c.doneAt = e.at;
        c.results = p.results;
      }
      s.countedAt[p.binCode] = e.at;
      for (const id of p.lostCaseIds) {
        const x = s.cases[id];
        if (x) {
          unlinkCase(s, x);
          x.state = 'LOST';
        }
      }
      for (const f of p.foundCases) addCase(s, { id: f.caseId, itemId: f.itemId, gtin: f.gtin, name: f.name, packQty: f.packQty, units: f.packQty, status: 'SELLABLE', state: 'STORED', binCode: p.binCode, receivedAt: e.at });
      s.counters.cases += p.foundCases.length;
      for (const r of p.results) delete s.suspect[r.itemId];
      touch();
      break;
    }
    // —— 货架存量与补货 ——
    case 'SalesRecorded': {
      for (const l of e.payload.lines) {
        const sh = shelfOf(s, st, l.itemId, e.at);
        if (sh) sell(sh, l.qty, e.at);
        consumeLots(s, l.itemId, l.qty);
      }
      break;
    }
    case 'SensorReading': {
      const p = e.payload;
      const sh = shelfOf(s, st, p.itemId, e.at);
      if (sh) {
        sh.sensorAt = e.at;
        sh.sensorAnomaly = p.anomaly;
        if (!p.anomaly) {
          sh.est = Math.max(0, p.units);
          sh.conf = p.confidence;
          sh.source = 'SENSOR';
          sh.at = e.at;
        }
      }
      break;
    }
    case 'ShelfCheckRequested': {
      const p = e.payload;
      s.checks[p.checkId] = { id: p.checkId, itemId: p.itemId, locationId: p.locationId, reason: p.reason, createdAt: e.at, status: 'OPEN', ...(p.recId ? { recId: p.recId } : {}), ...(p.near?.length ? { near: p.near } : {}), ...(p.lot ? { lot: p.lot } : {}), ...(p.pct !== undefined ? { pct: p.pct } : {}), ...(p.expected !== undefined ? { expected: p.expected } : {}) };
      s.counters.checks += 1;
      break;
    }
    case 'LotTaskDone': {
      // 货架上的批次任务（决策记录 0026）：下架的从货架和批次里减掉；退货放回的加上（捐赠由 LotDonated 处理）
      const p = e.payload;
      const c = s.checks[p.checkId];
      if (c) {
        c.status = 'DONE';
        c.doneAt = e.at;
        c.units = p.units;
        c.associateId = e.actor;
      }
      const sh = shelfOf(s, st, p.itemId, e.at);
      if (p.kind === 'PULL') {
        const lots = s.shelfLots?.[p.itemId];
        if (lots && p.lot) (s.shelfLots as Record<string, ShelfLot[]>)[p.itemId] = lots.map((l) => (l.lot === p.lot ? { ...l, units: Math.max(0, l.units - p.units) } : l)).filter((l) => l.units > 0);
        if (sh) {
          sh.est = Math.max(0, sh.est - p.units);
          sh.at = e.at;
        }
      } else if (p.kind === 'RETURN' && sh) {
        const cap = st ? (planogramIndex(st).get(p.itemId)?.capacity ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        sh.est = Math.min(cap, sh.est + p.units);
        sh.at = e.at;
      }
      touch(c?.locationId);
      break;
    }
    case 'ShelfCounted': {
      const p = e.payload;
      trimLots(s, p.itemId, p.units);
      const sh = shelfOf(s, st, p.itemId, e.at);
      if (sh) {
        sh.est = p.units;
        sh.conf = 1;
        sh.source = 'SCAN';
        sh.at = e.at;
        sh.confirmedAt = e.at;
      }
      const c = p.checkId ? s.checks[p.checkId] : undefined;
      if (c) {
        c.status = 'DONE';
        c.doneAt = e.at;
        c.units = p.units;
        if (p.found) c.found = p.found;
        c.previousEst = p.previousEst;
        c.associateId = e.actor;
      }
      const wc = p.walkId ? s.walks[p.walkId]?.checks?.find((x) => x.itemId === p.itemId && x.status === 'OPEN') : undefined;
      if (wc) {
        wc.status = 'DONE';
        wc.units = p.units;
      }
      touch(p.locationId);
      break;
    }
    case 'WalkCheckAdded': {
      const w = s.walks[e.payload.walkId];
      if (w) (w.checks ??= []).push({ ...e.payload.check, status: 'OPEN' });
      break;
    }
    case 'WalkCheckSkipped': {
      const c = s.walks[e.payload.walkId]?.checks?.find((x) => x.itemId === e.payload.itemId && x.status === 'OPEN');
      if (c) c.status = 'SKIPPED';
      break;
    }
    case 'ReplenishmentTaskCreated': {
      const p = e.payload;
      s.repl[p.taskId] = {
        id: p.taskId,
        locationId: p.locationId,
        itemId: p.itemId,
        area: p.area,
        reason: p.reason,
        suggestedUnits: p.suggestedUnits,
        priority: p.priority,
        createdAt: e.at,
        status: 'OPEN',
        ...(p.dueAt !== undefined ? { dueAt: p.dueAt } : {}),
        ...(p.risk !== undefined ? { risk: p.risk } : {}),
        ...(p.why ? { why: p.why } : {}),
        ...(p.fromCaseId ? { fromCaseId: p.fromCaseId } : {}),
      };
      s.counters.repl += 1;
      break;
    }
    case 'ReplenishmentClaimed': {
      for (const id of e.payload.taskIds) {
        const t = s.repl[id];
        if (t) {
          t.status = 'CLAIMED';
          t.associateId = e.actor;
          t.claimedAt = e.at;
        }
      }
      touch();
      break;
    }
    case 'ReplenishmentReleased': {
      for (const id of e.payload.taskIds) {
        const t = s.repl[id];
        if (t) {
          t.status = 'OPEN';
          delete t.associateId;
          delete t.claimedAt;
        }
      }
      break;
    }
    case 'ReplenishmentCompleted': {
      const p = e.payload;
      const t = s.repl[p.taskId];
      if (t) {
        t.status = 'DONE';
        t.doneAt = e.at;
        t.caseId = p.caseId;
        t.units = p.units;
      }
      // 有批号或保质期的箱子：这一批上了货架（决策记录 0024 · C4）
      const src = s.cases[p.caseId];
      if (src && (src.lot || src.expiry) && p.units > 0) ((s.shelfLots ??= {})[p.itemId] ??= []).push({ lot: src.lot ?? src.id, ...(src.expiry ? { expiry: src.expiry } : {}), units: p.units, at: e.at, caseId: src.id });
      takeFromCase(s, p.caseId, p.units);
      const sh = shelfOf(s, st, p.itemId, e.at);
      if (sh) {
        const cap = st ? (planogramIndex(st).get(p.itemId)?.capacity ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        // 补货上架时扫描货位：同时校准存量（决策 P-06）
        sh.est = Math.min(cap, sh.est + p.units);
        sh.conf = 0.95;
        sh.source = 'SCAN';
        sh.at = e.at;
        sh.confirmedAt = e.at;
      }
      touch(p.locationId);
      break;
    }
    case 'ReplenishmentCancelled': {
      const t = s.repl[e.payload.taskId];
      if (t) {
        t.status = 'CANCELLED';
        t.doneAt = e.at;
        // 说了找过哪个库位时只盘这个库位，不把整个商品标为可疑（决策记录 0026）
        if (e.payload.reason === 'NOT_FOUND' && !e.payload.binCode) s.suspect[t.itemId] = e.at;
      }
      break;
    }
    case 'ToteStaged': {
      const t = s.totes[e.payload.toteId];
      if (t) {
        t.status = 'STAGED';
        t.slotCode = e.payload.slotCode;
        (s.slots[e.payload.slotCode] ??= []).push(t.id);
      }
      touch(undefined, e.payload.slotCode);
      break;
    }
    case 'ToteMoved': {
      const t = s.totes[e.payload.toteId];
      if (t) {
        removeFromSlot(s, e.payload.from, t.id);
        t.slotCode = e.payload.to;
        (s.slots[e.payload.to] ??= []).push(t.id);
      }
      touch(undefined, e.payload.to);
      break;
    }
    case 'OrderStaged': {
      const o = s.orders[e.payload.orderId];
      if (o) {
        if (o.status === 'PICKING' || o.status === 'LOCKED') o.status = 'STAGED';
        o.stagedAt = e.at;
      }
      break;
    }
    case 'CancelledOrderDetected':
      touch();
      break;
    case 'ToteSentToRecovery': {
      const t = s.totes[e.payload.toteId];
      if (t) {
        if (t.slotCode) removeFromSlot(s, t.slotCode, t.id);
        delete t.slotCode;
        t.status = 'RECOVERY';
      }
      touch();
      break;
    }
    case 'EtaUpdated': {
      const p = e.payload;
      if (p.orderId) {
        const o = s.orders[p.orderId];
        if (o) {
          o.etaAt = p.etaAt;
          o.etaReportedAt = e.at;
          // 顾客重新上报后，之前的 AI 修正作废，等新的修正
          delete o.aiEtaAt;
        }
      }
      if (p.tripId) {
        const tr = s.trips[p.tripId];
        if (tr) tr.etaAt = p.etaAt;
      }
      break;
    }
    case 'CustomerArrived': {
      const p = e.payload;
      const set = (x: { arrivedAt?: number; bay?: string; vehicle?: string }) => {
        x.arrivedAt ??= e.at;
        if (p.bay !== undefined) x.bay = p.bay;
        if (p.vehicle !== undefined) x.vehicle = p.vehicle;
      };
      if (p.orderId) {
        const o = s.orders[p.orderId];
        if (o) set(o);
      }
      if (p.tripId) {
        const tr = s.trips[p.tripId];
        if (tr) {
          set(tr);
          for (const id of tr.orderIds) {
            const o = s.orders[id];
            if (o) o.arrivedAt ??= e.at;
          }
        }
      }
      break;
    }
    case 'PrepStarted': {
      const p = e.payload;
      const session: HandoffSession = {
        key: p.key,
        kind: p.kind,
        orderIds: p.orderIds,
        status: 'PREPPING',
        owner: e.actor,
        helpers: [],
        startedAt: e.at,
        scanned: [],
        codeFailures: 0,
        manualRequired: false,
        ageVerified: false,
      };
      s.sessions[p.key] = session;
      forOrders(s, p.orderIds, (o) => {
        o.status = 'PREPPING';
      });
      touch();
      break;
    }
    case 'PrepJoined': {
      const ss = s.sessions[e.payload.key];
      if (ss && ss.owner !== e.actor && !ss.helpers.includes(e.actor)) ss.helpers.push(e.actor);
      break;
    }
    case 'ToteScannedForPrep': {
      const ss = s.sessions[e.payload.key];
      const t = s.totes[e.payload.toteId];
      if (ss && !ss.scanned.includes(e.payload.toteId)) ss.scanned.push(e.payload.toteId);
      if (t) {
        if (t.slotCode) {
          removeFromSlot(s, t.slotCode, t.id);
          touch(undefined, t.slotCode);
        }
        t.status = 'PULLED';
      }
      break;
    }
    case 'ReadyToLoad': {
      // 先核验过的（决策记录 0026）：框取完就直接进入交付
      const ss = s.sessions[e.payload.key];
      if (ss) {
        ss.status = ss.verified ? 'HANDING_OFF' : 'READY';
        forOrders(s, ss.orderIds, (o) => {
          o.status = ss.verified ? 'HANDING_OFF' : 'READY';
        });
      }
      break;
    }
    case 'CodeVerified': {
      // 框还没取完时先核验（决策记录 0026）：记下核验，取完框再进入交付
      const ss = s.sessions[e.payload.key];
      if (ss) {
        ss.verified = e.payload.method;
        if (ss.status === 'READY') {
          ss.status = 'HANDING_OFF';
          forOrders(s, ss.orderIds, (o) => {
            o.status = 'HANDING_OFF';
          });
        }
      }
      break;
    }
    case 'PrepAbandoned': {
      // 退出交付准备（决策记录 0026）：订单回到已暂存，取出的框留在「待暂存」里放回
      delete s.sessions[e.payload.key];
      forOrders(s, e.payload.orderIds, (o) => {
        if (o.status === 'PREPPING' || o.status === 'READY' || o.status === 'HANDING_OFF') o.status = 'STAGED';
      });
      touch();
      break;
    }
    case 'CodeFailed': {
      const ss = s.sessions[e.payload.key];
      if (ss) {
        ss.codeFailures = e.payload.attempt;
        ss.manualRequired = e.payload.manualRequired;
      }
      break;
    }
    case 'AgeVerified': {
      const ss = s.sessions[e.payload.key];
      if (ss) ss.ageVerified = true;
      break;
    }
    case 'VehiclePlacementRecorded': {
      const tr = s.trips[e.payload.tripId];
      if (tr) tr.placements[e.payload.orderId] = e.payload.position;
      break;
    }
    case 'OrderHandedOff': {
      const o = s.orders[e.payload.orderId];
      if (o) {
        o.status = 'COMPLETED';
        o.completedAt = e.at;
        o.ageItemsRemoved = e.payload.ageItemsRemoved;
        if (e.payload.recallRemoved) o.recallRemoved = true;
        for (const id of o.toteIds) {
          const t = s.totes[id];
          if (t && t.status !== 'RECOVERY') t.status = 'HANDED_OFF';
        }
        const key = o.tripId ?? o.id;
        const ss = s.sessions[key];
        if (ss && ss.orderIds.every((id) => s.orders[id]?.status === 'COMPLETED')) {
          ss.status = 'COMPLETED';
          ss.completedAt = e.at;
        }
      }
      break;
    }
    case 'TripProposed': {
      const p = e.payload;
      s.trips[p.tripId] = { id: p.tripId, orderIds: p.orderIds, placements: { ...p.placements }, proposedAt: e.at };
      s.counters.trips += 1;
      forOrders(s, p.orderIds, (o) => {
        o.tripId = p.tripId;
      });
      break;
    }
    case 'TripAccepted': {
      const tr = s.trips[e.payload.tripId];
      if (tr) {
        tr.driverName = e.payload.driverName;
        tr.codeHash = e.payload.codeHash;
        tr.acceptedAt = e.at;
      }
      break;
    }
    case 'TripCompleted': {
      const tr = s.trips[e.payload.tripId];
      if (tr) tr.completedAt = e.at;
      break;
    }
    case 'TripDriverCancelled': {
      // 行程回到待接单（重新派单），司机、验证码、到店信息清空；交付准备结束，已取出的框放回暂存区（决策记录 0014）
      const p = e.payload;
      const tr = s.trips[p.tripId];
      if (!tr) break;
      (tr.cancellations ??= []).push({ at: e.at, by: p.by, reason: p.reason, returns: p.returns, atRisk: p.atRisk, ...(p.driverName ? { driverName: p.driverName } : {}), ...(p.waitedMin !== undefined ? { waitedMin: p.waitedMin } : {}), ...(p.sessionOwner ? { sessionOwner: p.sessionOwner } : {}) });
      tr.redispatchedAt = e.at;
      delete tr.driverName;
      delete tr.codeHash;
      delete tr.acceptedAt;
      delete tr.etaAt;
      delete tr.arrivedAt;
      delete tr.bay;
      delete tr.vehicle;
      for (const r of p.returns) {
        const t = s.totes[r.toteId];
        if (!t) continue;
        t.status = 'STAGED';
        t.slotCode = r.slotCode;
        (s.slots[r.slotCode] ??= []).push(t.id);
        touch(undefined, r.slotCode);
      }
      const hadSession = !!s.sessions[p.tripId];
      delete s.sessions[p.tripId];
      forOrders(s, tr.orderIds, (o) => {
        delete o.arrivedAt;
        delete o.etaAt;
        if (o.status === 'CANCELLED' || o.status === 'COMPLETED') return;
        o.delayNoticeAt = e.at;
        if (hadSession) o.status = 'STAGED';
      });
      touch();
      break;
    }
  }
  return s;
}

function removeFromSlot(s: OpsState, code: string, toteId: string): void {
  const list = s.slots[code];
  if (!list) return;
  const i = list.indexOf(toteId);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) delete s.slots[code];
}

function forOrders(s: OpsState, ids: readonly string[], fn: (o: LiveOrder) => void): void {
  for (const id of ids) {
    const o = s.orders[id];
    if (o && o.status !== 'CANCELLED' && o.status !== 'COMPLETED') fn(o);
  }
}

/** 从事件流重建状态 */
export function replay(events: Iterable<AnyOpsEvent>, into: OpsState = emptyState(), st?: StoreStatic): OpsState {
  for (const e of events) applyEvent(into, e, st);
  return into;
}

// —— 后仓箱子 ——

function addCase(s: OpsState, c: LiveCase): void {
  s.cases[c.id] = c;
  linkCase(s, c);
}

/** 箱子放进库位 / 可售清单 */
function linkCase(s: OpsState, c: LiveCase): void {
  if (c.state !== 'STORED' || !c.binCode) return;
  const list = (s.bins[c.binCode] ??= []);
  if (!list.includes(c.id)) list.push(c.id);
  if (c.status === 'SELLABLE' && c.units > 0) {
    const items = (s.itemCases[c.itemId] ??= []);
    if (!items.includes(c.id)) items.push(c.id);
  }
}

function unlinkCase(s: OpsState, c: LiveCase): void {
  if (c.binCode) {
    const list = s.bins[c.binCode];
    if (list) {
      const i = list.indexOf(c.id);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) delete s.bins[c.binCode];
    }
  }
  const items = s.itemCases[c.itemId];
  if (items) {
    const i = items.indexOf(c.id);
    if (i >= 0) items.splice(i, 1);
    if (!items.length) delete s.itemCases[c.itemId];
  }
}

function takeFromCase(s: OpsState, caseId: string, units: number): void {
  const c = s.cases[caseId];
  if (!c) return;
  c.units = Math.max(0, c.units - units);
  if (c.units === 0) {
    unlinkCase(s, c);
    c.state = 'EMPTY';
  }
}

// —— 货架存量 ——

const planIndex = new WeakMap<StoreStatic, Map<string, PlanogramEntry>>();
const locIndex = new WeakMap<StoreStatic, Map<string, PlanogramEntry[]>>();

/** 商品 → 陈列表条目（按静态数据对象缓存） */
export function planogramIndex(st: StoreStatic): Map<string, PlanogramEntry> {
  let m = planIndex.get(st);
  if (!m) {
    m = new Map();
    for (const p of st.planogram) if (!m.has(p.itemId)) m.set(p.itemId, p);
    planIndex.set(st, m);
  }
  return m;
}

/** 货位 → 放在这个货位的商品（一个货位通常有几个商品并排陈列） */
export function locationIndex(st: StoreStatic): Map<string, PlanogramEntry[]> {
  let m = locIndex.get(st);
  if (!m) {
    m = new Map();
    for (const p of st.planogram) {
      const list = m.get(p.locationId) ?? [];
      list.push(p);
      m.set(p.locationId, list);
    }
    locIndex.set(st, m);
  }
  return m;
}

/** 商品的货架存量记录；第一次用到时按「开门时补满」建立（需要陈列表） */
function shelfOf(s: OpsState, st: StoreStatic | undefined, itemId: string, at: number): ShelfState | undefined {
  const sh = s.shelf[itemId];
  if (sh) return sh;
  const p = st ? planogramIndex(st).get(itemId) : undefined;
  if (!p) return undefined;
  const created: ShelfState = { est: p.capacity, conf: 0.5, source: 'INIT', at, velocity: p.baseVelocity };
  s.shelf[itemId] = created;
  return created;
}

/** 销售推算：扣减估算值，按 1 小时时间常数更新销售速度，置信度略降 */
function sell(sh: ShelfState, qty: number, at: number): void {
  const dtH = sh.lastSaleAt !== undefined ? Math.max(1 / 60, (at - sh.lastSaleAt) / 3_600_000) : 1;
  const alpha = 1 - Math.exp(-dtH);
  sh.velocity = sh.velocity * (1 - alpha) + (qty / dtH) * alpha;
  sh.lastSaleAt = at;
  sh.est = Math.max(0, sh.est - qty);
  sh.conf = Math.max(0.2, sh.conf * 0.98);
  if (sh.source !== 'SCAN' || sh.conf < 0.8) sh.source = 'POS';
  sh.at = at;
}
