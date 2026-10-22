import { describe, expect, it } from 'vitest';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import type { Order } from '@storewright/domain';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { generateCatalog } from '@storewright/synth';
import { replay } from './apply';
import type { OpsCommand } from './commands';
import type { AnyOpsEvent } from './events';
import { allowedDispositions, mtoBoard, parcelTrips, suggestParcelSlot } from './modules';
import { buildBins, buildPlanogram, execute, orderInfoFrom, type OpsContext } from './server';
import { emptyState, type OpsState, type StoreStatic } from './types';

const model = new StoreModel(createTemplate('medium'));
const catalog = generateCatalog(model, { seed: 7 });
const base: StoreStatic = {
  storeId: 'S1',
  name: 'Test',
  rules: { approachingMin: 10, longWaitMin: 10, codeAttempts: 3, occupancyAlert: 0.9, slotLengthMin: 60, lockLeadMin: 90 },
  slots: model.stagingSlots.map((s) => ({ code: s.code, tempZone: s.tempZone, capacity: s.capacityTotes, area: s.area, purpose: s.purpose })),
  roster: [
    { id: 'L1', name: 'Lead', role: 'LEAD', exceptionAuthorized: true },
    { id: 'D1', name: 'Deli', role: 'DELI', exceptionAuthorized: false },
    { id: 'P1', name: 'Picker', role: 'PICK', exceptionAuthorized: false },
    { id: 'P2', name: 'Picker 2', role: 'PICK', exceptionAuthorized: false },
  ],
  bins: buildBins(model),
  planogram: buildPlanogram(model, catalog.byId),
  replenish: DEFAULT_REPLENISH_RULES,
  modules: { mto: true, returns: true, oversized: true, parcel: true },
  mtoMenu: [
    { id: 'M-CHICKEN', name: 'Rotisserie Chicken', prepMin: 45, holdMin: 240, hot: true },
    { id: 'M-SUB', name: 'Sub', prepMin: 6, holdMin: 240, hot: false },
  ],
  hotSlots: ['H-01', 'H-02'],
  parcelSlots: [
    { code: 'P01', capacity: 2, size: 'S' },
    { code: 'P02', capacity: 3, size: 'M' },
    { code: 'P03', capacity: 2, size: 'L' },
  ],
  oversizedAreas: ['BULK-1', 'BULK-2'],
};
const T0 = Date.UTC(2026, 9, 22, 15, 0);
const MIN = 60_000;

class Store {
  s: OpsState = emptyState();
  log: AnyOpsEvent[] = [];
  now = T0;
  constructor(readonly statics: StoreStatic = base) {}
  get ctx(): OpsContext {
    return { model, items: catalog.byId, hash: (x) => x, statics: this.statics };
  }
  run(cmd: OpsCommand, actor = 'console') {
    const r = execute(this.s, { cmd, actor, at: this.now }, this.ctx);
    this.log.push(...r.events);
    return r.decision.ok ? 'OK' : r.decision.reject.code;
  }
  order(id: string, itemIds: string[], slotInMin = 120) {
    const o: Order = { id, shortCode: id, customer: { id: `C-${id}`, firstName: 'Test', lastName: id }, type: 'PICKUP', fulfillmentType: 'GROCERY', express: false, createdAt: 0, slotStart: 0, slotLengthSec: 3600, lines: itemIds.map((it, i) => ({ lineId: `${id}-L${i + 1}`, itemId: it, qty: 1, allowSubstitution: true })) };
    const info = orderInfoFrom(o, catalog.byId, this.now + slotInMin * MIN, 60);
    expect(this.run({ type: 'CreateOrder', order: info, codeHash: 'h' })).toBe('OK');
    return info;
  }
}

const grocery = catalog.items.filter((i) => i.fulfillmentType === 'GROCERY' && !i.handling.includes('OVERSIZED') && i.weightKg < 5);

describe('pluggable modules (Phase 6)', () => {
  it('a disabled module rejects its commands', () => {
    const st = new Store({ ...base, modules: { mto: false, returns: false, oversized: false, parcel: false } });
    st.order('O1', [grocery[0]!.id]);
    expect(st.run({ type: 'CreateMtoTicket', orderId: 'O1', menuId: 'M-SUB', qty: 1 })).toBe('MODULE_DISABLED');
    expect(st.run({ type: 'StartReturn', kind: 'CUSTOMER' })).toBe('MODULE_DISABLED');
    expect(st.run({ type: 'InductParcel', code: 'X' })).toBe('MODULE_DISABLED');
  });

  it('MTO: start time from prep time, hold timer and forced discard, cancelled orders', () => {
    const st = new Store();
    const o = st.order('O1', [grocery[0]!.id], 120);
    expect(st.run({ type: 'CreateMtoTicket', orderId: 'O1', menuId: 'NOPE', qty: 1 })).toBe('MENU_NOT_FOUND');
    expect(st.run({ type: 'CreateMtoTicket', orderId: 'O1', menuId: 'M-CHICKEN', qty: 2 })).toBe('OK');
    const t = Object.values(st.s.mto)[0]!;
    expect(t.startAt).toBe(o.slotStart - (45 + 10) * MIN);
    expect(mtoBoard(st.s).queued.map((x) => x.id)).toEqual([t.id]);
    expect(st.run({ type: 'CompleteMto', ticketId: t.id }, 'D1')).toBe('TICKET_STATE');
    expect(st.run({ type: 'StartMto', ticketId: t.id }, 'D1')).toBe('OK');
    expect(st.run({ type: 'CompleteMto', ticketId: t.id, slotCode: 'X-9' }, 'D1')).toBe('SLOT_NOT_FOUND');
    expect(st.run({ type: 'CompleteMto', ticketId: t.id, slotCode: 'h-01' }, 'D1')).toBe('OK');
    expect(st.s.mto[t.id]).toMatchObject({ status: 'HELD', slotCode: 'H-01', discardAt: st.now + 240 * MIN, associateId: 'D1' });
    st.now += 241 * MIN;
    st.run({ type: 'Tick', release: false }, 'system');
    expect(st.s.mto[t.id]).toMatchObject({ status: 'DISCARDED', discardReason: 'HOLD_EXPIRED' });
    // 第二单：取出；第三单：订单取消后丢弃
    st.order('O2', [grocery[1]!.id], 300);
    st.run({ type: 'CreateMtoTicket', orderId: 'O2', menuId: 'M-SUB', qty: 1 });
    const t2 = mtoBoard(st.s).queued[0]!;
    st.run({ type: 'StartMto', ticketId: t2.id }, 'D1');
    st.run({ type: 'CompleteMto', ticketId: t2.id }, 'D1');
    expect(st.run({ type: 'PullMto', ticketId: t2.id }, 'P1')).toBe('OK');
    st.order('O3', [grocery[2]!.id], 300);
    st.run({ type: 'CreateMtoTicket', orderId: 'O3', menuId: 'M-SUB', qty: 1 });
    st.run({ type: 'CancelOrder', orderId: 'O3', reason: 'customer' });
    st.run({ type: 'Tick', release: false }, 'system');
    const t3 = Object.values(st.s.mto).find((x) => x.orderId === 'O3')!;
    expect(t3).toMatchObject({ status: 'DISCARDED', discardReason: 'ORDER_CANCELLED' });
    expect(replay(st.log, emptyState(), base)).toEqual(st.s);
  });

  it('returns: line-by-line scan against the order, dispositions with AI adoption, refund and restock', () => {
    const st = new Store();
    const it = grocery[3]!;
    const other = grocery[4]!;
    st.order('O1', [it.id]);
    // 先让货架有一条估算记录
    st.run({ type: 'RecordSales', lines: [{ itemId: it.id, qty: 1 }] }, 'pos');
    const before = st.s.shelf[it.id]?.est ?? 0;
    expect(st.run({ type: 'StartReturn', orderId: 'O1', kind: 'CUSTOMER' }, 'L1')).toBe('OK');
    const r = Object.values(st.s.returns)[0]!;
    expect(st.run({ type: 'ScanReturnItem', returnId: r.id, code: '000000000000', qty: 1, condition: 'SEALED' }, 'L1')).toBe('ITEM_NOT_FOUND');
    expect(st.run({ type: 'ScanReturnItem', returnId: r.id, code: it.gtin, qty: 1, condition: 'SEALED' }, 'L1')).toBe('OK');
    expect(st.run({ type: 'ScanReturnItem', returnId: r.id, code: other.gtin, qty: 2, condition: 'OPENED' }, 'L1')).toBe('OK');
    expect(st.s.returns[r.id]!.lines.map((l) => l.inOrder)).toEqual([true, false]);
    expect(st.run({ type: 'CompleteReturn', returnId: r.id }, 'L1')).toBe('RETURN_INCOMPLETE');
    st.run({ type: 'SetReturnDisposition', returnId: r.id, index: 0, disposition: 'RESTOCK', aiSuggested: 'RESTOCK' }, 'L1');
    st.run({ type: 'SetReturnDisposition', returnId: r.id, index: 1, disposition: 'VENDOR', aiSuggested: 'DISPOSE' }, 'L1');
    expect(st.s.aiStats.RETURNS).toMatchObject({ issued: 2, ACCEPTED: 1, OVERRIDDEN: 1 });
    expect(st.run({ type: 'CompleteReturn', returnId: r.id }, 'L1')).toBe('OK');
    expect(st.s.returns[r.id]).toMatchObject({ status: 'COMPLETED', refundValue: Math.round((it.unitPrice + other.unitPrice * 2) * 100) / 100 });
    expect(st.s.shelf[it.id]!.est).toBe(before + 1);
    expect(st.run({ type: 'ScanReturnItem', returnId: r.id, code: it.gtin, qty: 1, condition: 'SEALED' }, 'L1')).toBe('RETURN_CLOSED');
  });

  it('returns: hard rules (RT-02) block unsafe dispositions whatever the associate or AI picks', () => {
    const st = new Store();
    const find = (f: (i: (typeof catalog.items)[number]) => boolean) => catalog.items.find(f) as (typeof catalog.items)[number];
    const chilled = find((i) => i.tempZone === 'CHILLED');
    const chem = find((i) => i.handling.includes('CHEMICAL'));
    const food = find((i) => i.fulfillmentType === 'GROCERY' && i.tempZone === 'AMBIENT' && !i.handling.includes('CHEMICAL'));
    const gm = find((i) => i.fulfillmentType === 'GM' && i.tempZone === 'AMBIENT' && !i.handling.includes('CHEMICAL'));
    expect(st.run({ type: 'StartReturn', kind: 'CUSTOMER' }, 'L1')).toBe('OK');
    const r = Object.values(st.s.returns)[0]!;
    const scan = (code: string, condition: 'SEALED' | 'OPENED' | 'DAMAGED') => st.run({ type: 'ScanReturnItem', returnId: r.id, code, qty: 1, condition }, 'L1');
    scan(chilled.gtin, 'SEALED'); // 0：冷藏，未开封也不能回架
    scan(food.gtin, 'OPENED'); // 1：开封的食品不能回架
    scan(food.gtin, 'SEALED'); // 2：未开封的食品可以回架
    scan(chem.gtin, 'SEALED'); // 3：未开封的化学品可以回架，不能当普通垃圾
    scan(chem.gtin, 'OPENED'); // 4：开封的化学品只能走危险品回收
    scan(gm.gtin, 'OPENED'); // 5：百货开封后检验分流，可以回架
    scan(gm.gtin, 'DAMAGED'); // 6：损坏的不能回架
    const set = (index: number, disposition: 'RESTOCK' | 'DISPOSE' | 'HAZMAT' | 'VENDOR') => st.run({ type: 'SetReturnDisposition', returnId: r.id, index, disposition }, 'L1');
    expect(set(0, 'RESTOCK')).toBe('DISPOSITION_NOT_ALLOWED');
    expect(set(1, 'RESTOCK')).toBe('DISPOSITION_NOT_ALLOWED');
    expect(set(2, 'RESTOCK')).toBe('OK');
    expect(set(3, 'DISPOSE')).toBe('DISPOSITION_NOT_ALLOWED');
    expect(set(3, 'RESTOCK')).toBe('OK');
    expect(set(4, 'RESTOCK')).toBe('DISPOSITION_NOT_ALLOWED');
    expect(set(4, 'VENDOR')).toBe('DISPOSITION_NOT_ALLOWED');
    expect(set(4, 'HAZMAT')).toBe('OK');
    expect(set(5, 'RESTOCK')).toBe('OK');
    expect(set(6, 'RESTOCK')).toBe('DISPOSITION_NOT_ALLOWED');
    expect(set(6, 'VENDOR')).toBe('OK');
    expect(set(0, 'DISPOSE')).toBe('OK');
    expect(set(1, 'DISPOSE')).toBe('OK');
    expect(allowedDispositions(st.s.returns[r.id]!.lines[4]!)).toEqual(['HAZMAT']);
    expect(st.run({ type: 'CompleteReturn', returnId: r.id }, 'L1')).toBe('OK');
    expect(replay(st.log, emptyState(), base)).toEqual(st.s);
  });

  it('oversized: pieces at lock time, load limit when claiming, scan-then-print, staging area', () => {
    const st = new Store();
    const big = catalog.items.find((i) => i.handling.includes('OVERSIZED') || i.weightKg > 14);
    expect(big).toBeDefined();
    const o = st.order('O1', [big!.id, big!.id === grocery[0]!.id ? grocery[1]!.id : grocery[0]!.id], 60);
    // 把第一行改成 3 件：分出 3 个大件
    const info = { ...o, id: 'O2', shortCode: 'O2', lines: o.lines.map((l, i) => ({ ...l, lineId: `O2-L${i + 1}`, qty: i === 0 ? 3 : 1 })) };
    st.run({ type: 'CreateOrder', order: info, codeHash: 'h' });
    expect(st.run({ type: 'LockOrder', orderId: 'O2' })).toBe('OK');
    const pieces = Object.values(st.s.oversized).filter((p) => p.orderId === 'O2');
    expect(pieces.length).toBe(3);
    expect(pieces.map((p) => `${p.index}/${p.count}`)).toEqual(['1/3', '2/3', '3/3']);
    expect(st.run({ type: 'ClaimOversized', orderId: 'O2', maxPieces: 2 }, 'P1')).toBe('OK');
    expect(Object.values(st.s.oversized).filter((p) => p.associateId === 'P1')).toHaveLength(2);
    expect(st.run({ type: 'ClaimOversized', orderId: 'O2', maxPieces: 5 }, 'P2')).toBe('OK');
    expect(Object.values(st.s.oversized).filter((p) => p.associateId === 'P2')).toHaveLength(1);
    const mine = pieces[0]!.id;
    expect(st.run({ type: 'ScanOversized', pieceId: mine, code: grocery[0]!.gtin }, 'P1')).toBe('CASE_WRONG_ITEM');
    expect(st.run({ type: 'ScanOversized', pieceId: mine, code: big!.gtin }, 'P2')).toBe('PIECE_NOT_YOURS');
    expect(st.run({ type: 'ScanOversized', pieceId: mine, code: big!.gtin }, 'P1')).toBe('OK');
    expect(st.s.oversized[mine]!.labelId).toMatch(/^SW1:/);
    expect(st.run({ type: 'StageOversized', pieceId: mine, area: 'DOCK' }, 'P1')).toBe('SLOT_NOT_FOUND');
    expect(st.run({ type: 'StageOversized', pieceId: mine, area: 'bulk-1' }, 'P1')).toBe('OK');
    expect(st.s.oversized[mine]).toMatchObject({ status: 'STAGED', area: 'BULK-1' });
    expect(st.run({ type: 'ReleaseOversized', pieceIds: [pieces[1]!.id] }, 'P1')).toBe('OK');
    expect(st.s.oversized[pieces[1]!.id]).toMatchObject({ status: 'OPEN' });
    // 按装载建议指定件领取：只领指定的、还没人领的件
    expect(st.run({ type: 'ClaimOversized', orderId: 'O2', maxPieces: 1, pieceIds: [pieces[2]!.id] }, 'P3')).toBe('NOTHING_TO_CLAIM');
    expect(st.run({ type: 'ClaimOversized', orderId: 'O2', maxPieces: 1, pieceIds: [pieces[1]!.id] }, 'P3')).toBe('OK');
    expect(st.s.oversized[pieces[1]!.id]).toMatchObject({ status: 'CLAIMED', associateId: 'P3' });
    expect(replay(st.log, emptyState(), base)).toEqual(st.s);
  });

  it('parcel hub: ASN, induct, over, slot suggestion by trip, short after grace, damaged, trip handoff', () => {
    const st = new Store();
    expect(st.run({ type: 'CreateParcelAsn', carrier: 'Carrier A', expectedInMin: 60, parcels: [
      { parcelId: 'pk1', tripRef: 't1', sizeClass: 'S', weightKg: 1 },
      { parcelId: 'pk2', tripRef: 't1', sizeClass: 'S', weightKg: 2 },
      { parcelId: 'pk3', tripRef: 't2', sizeClass: 'L', weightKg: 9 },
      { parcelId: 'pk4', tripRef: 't2', sizeClass: 'M', weightKg: 3 },
    ] })).toBe('OK');
    expect(st.run({ type: 'InductParcel', code: 'PK1' }, 'P1')).toBe('OK');
    expect(st.run({ type: 'InductParcel', code: 'pk2' }, 'P1')).toBe('OK');
    expect(st.run({ type: 'InductParcel', code: 'ZZZ' }, 'P1')).toBe('OK');
    expect(st.s.parcels.ZZZ?.status).toBe('OVER');
    const s1 = suggestParcelSlot(st.s, base, st.s.parcels.PK1!);
    expect(s1).toEqual({ slotCode: 'P01', reason: 'SIZE_AND_DISTANCE' });
    expect(st.run({ type: 'StageParcel', parcelId: 'PK1', slotCode: 'P01' }, 'P1')).toBe('OK');
    expect(suggestParcelSlot(st.s, base, st.s.parcels.PK2!)).toEqual({ slotCode: 'P01', reason: 'SAME_TRIP' });
    // 行程里还有已入站没暂存的：不能交接
    expect(st.run({ type: 'HandOffParcels', tripRef: 'T1' })).toBe('TRIP_NOT_READY');
    st.run({ type: 'StageParcel', parcelId: 'PK2', slotCode: 'P01' }, 'P1');
    expect(st.run({ type: 'StageParcel', parcelId: 'PK3', slotCode: 'P01' }, 'P1')).toBe('PARCEL_STATE');
    expect(st.run({ type: 'HandOffParcels', tripRef: 't1' })).toBe('OK');
    expect([st.s.parcels.PK1?.status, st.s.parcels.PK2?.status]).toEqual(['HANDED_OFF', 'HANDED_OFF']);
    st.run({ type: 'InductParcel', code: 'PK3' }, 'P1');
    expect(st.run({ type: 'ReportParcelDamaged', parcelId: 'PK3' }, 'P1')).toBe('OK');
    st.now += 91 * MIN;
    st.run({ type: 'Tick', release: false }, 'system');
    expect(st.s.parcels.PK4?.status).toBe('SHORT');
    expect(parcelTrips(st.s).map((t) => t.tripRef)).toEqual(['T2']);
    expect(replay(st.log, emptyState(), base)).toEqual(st.s);
  });
});
