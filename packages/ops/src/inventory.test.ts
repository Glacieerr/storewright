import { describe, expect, it } from 'vitest';
import { batchByArea, checkBin, classifyAbc, DEFAULT_REPLENISH_RULES, needsReplenishment, replenishPriority, suggestBins } from '@storewright/algorithms';
import { caseDigitalLink, isValidUpcA, parseDigitalLink, type Order } from '@storewright/domain';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateCatalog, generateOrders } from '@storewright/synth';
import { replay } from './apply';
import type { OpsCommand } from './commands';
import type { AnyOpsEvent } from './events';
import { planogramByItem, replBatches, sellableCases, shelfNow, usableCases } from './inventory';
import { resolveScan } from './scan';
import { buildBins, buildPlanogram, execute, initialInventory, orderInfoFrom, type OpsContext } from './server';
import { emptyState, type OpsState, type PlanogramEntry, type StoreStatic } from './types';
import { codeHashInput, pickRows, suggestSlots } from './views';

const model = new StoreModel(createTemplate('medium'));
const catalog = generateCatalog(model, { seed: 7 });
const rules = model.config.rules;
const statics: StoreStatic = {
  storeId: 'S1',
  name: 'Test',
  rules: { approachingMin: rules.handoff.approachingMin, longWaitMin: rules.handoff.longWaitMin, codeAttempts: rules.handoff.codeAttempts, occupancyAlert: rules.staging.occupancyAlert, slotLengthMin: rules.slotLengthMin, lockLeadMin: rules.lockLeadMin },
  slots: model.stagingSlots.map((s) => ({ code: s.code, tempZone: s.tempZone, capacity: s.capacityTotes, area: s.area, purpose: s.purpose })),
  roster: [
    { id: 'P1', name: 'Picker', role: 'PICK', exceptionAuthorized: false },
    { id: 'X1', name: 'Backroom', role: 'BACKROOM', exceptionAuthorized: true },
    { id: 'R1', name: 'Restock', role: 'RESTOCK', exceptionAuthorized: false },
  ],
  bins: buildBins(model),
  planogram: buildPlanogram(model, catalog.byId),
  replenish: DEFAULT_REPLENISH_RULES,
};
const ctx: OpsContext = { model, items: catalog.byId, hash: (s) => `h(${s})`, statics };
const byItem = planogramByItem(statics);
const T0 = Date.UTC(2026, 9, 20, 15, 0);
const MIN = 60_000;

class Store {
  s: OpsState = emptyState();
  log: AnyOpsEvent[] = [];
  now = T0;
  run(cmd: OpsCommand, actor = 'console') {
    const r = execute(this.s, { cmd, actor, at: this.now }, ctx);
    this.log.push(...r.events);
    return r;
  }
  ok(cmd: OpsCommand, actor = 'console') {
    const r = this.run(cmd, actor);
    if (!r.decision.ok) throw new Error(`${cmd.type} rejected: ${JSON.stringify(r.decision.reject)}`);
    return r.events;
  }
  code(cmd: OpsCommand, actor = 'console') {
    const r = this.run(cmd, actor);
    return r.decision.ok ? 'OK' : r.decision.reject.code;
  }
  loadOpening() {
    this.ok({ type: 'LoadInventory', cases: initialInventory(statics.planogram, statics.bins, catalog.byId, 9, this.now).cases }, 'system');
  }
  /** 放一箱指定商品到合适的库位 */
  stock(p: PlanogramEntry, n = 1) {
    const bin = statics.bins.find((b) => checkBin(b, { tempZone: p.tempZone, chemical: p.chemical, area: p.area }, this.s.bins[b.code]?.length ?? 0) === 'OK' && b.area === p.area) ?? statics.bins.find((b) => b.status === 'SELLABLE' && b.tempZone === p.tempZone);
    const base = this.s.counters.cases;
    const cases = Array.from({ length: n }, (_, i) => ({ caseId: `C-261020-${String(base + i + 1).padStart(6, '0')}`, itemId: p.itemId, gtin: p.gtin, name: p.name, packQty: p.packQty, units: p.packQty, binCode: bin?.code ?? '' }));
    // 期初库存只能载入一次，之后用收货流程；测试里直接构造一条载入事件更简单
    if (this.s.counters.cases === 0) this.ok({ type: 'LoadInventory', cases }, 'system');
    else {
      const ev: AnyOpsEvent = { seq: this.s.seq + 1, at: this.now, actor: 'system', type: 'InventoryLoaded', payload: { cases } } as AnyOpsEvent;
      replay([ev], this.s, statics);
      this.log.push(ev);
    }
    return cases.map((c) => c.caseId);
  }
}

const orders: Order[] = generateOrders(model, catalog, DEFAULT_DEMAND.medium, { seed: 5 }).filter(
  (o) => o.type === 'PICKUP' && o.fulfillmentType === 'GROCERY' && o.lines.every((l) => !catalog.byId.get(l.itemId)?.handling.some((h) => h === 'OVERSIZED' || h === 'TEAM_LIFT')),
);

describe('陈列表、库位与期初库存', () => {
  it('货位都存在；只有少数货位配传感器；期初库存遵守温区与隔离规则', () => {
    expect(statics.planogram.length).toBeGreaterThan(1000);
    for (const p of statics.planogram) {
      expect(model.locations.has(p.locationId)).toBe(true);
      expect(p.capacity).toBeGreaterThanOrEqual(4);
      if (p.chemical) expect(p.area).toBe('CHEM');
    }
    const sensors = statics.planogram.filter((p) => p.sensor).length;
    expect(sensors).toBeGreaterThan(0);
    expect(sensors / statics.planogram.length).toBeLessThan(0.05);
    expect(new Set(statics.planogram.map((p) => p.abc))).toEqual(new Set(['A', 'B', 'C']));
    const bins = new Map(statics.bins.map((b) => [b.code, b]));
    const opening = initialInventory(statics.planogram, statics.bins, catalog.byId, 9, T0);
    expect(opening.cases.length).toBeGreaterThan(300);
    const used = new Map<string, number>();
    for (const c of opening.cases) {
      const b = bins.get(c.binCode);
      const p = byItem.get(c.itemId);
      if (!b || !p) throw new Error('missing');
      expect(checkBin(b, { tempZone: p.tempZone, chemical: p.chemical, area: p.area }, used.get(b.code) ?? 0)).toBe('OK');
      used.set(b.code, (used.get(b.code) ?? 0) + 1);
    }
  });
});

describe('put-away suggestions by inventory status', () => {
  it('damaged (QA), return-to-vendor and scrap cases get bins of their own status and temperature zone', () => {
    const bins = buildBins(new StoreModel(createTemplate('medium')));
    const used = () => 0;
    const chilled = { tempZone: 'CHILLED' as const, chemical: false, area: 'COLD' };
    // 走查发现的问题：以前只按「可售」检查，待检的箱子没有任何建议
    expect(suggestBins(bins.filter((b) => b.status === 'QA'), used, chilled, 3, 'QA')).toEqual(['QA-CHL']);
    expect(suggestBins(bins.filter((b) => b.status === 'RTV'), used, { ...chilled, tempZone: 'AMBIENT', area: 'DRY' }, 3, 'RTV')).toEqual(['RTV-AMB']);
    expect(suggestBins(bins.filter((b) => b.status === 'QA'), used, chilled, 3)).toEqual([]);
    expect(suggestBins(bins.filter((b) => b.status === 'SELLABLE'), used, chilled).length).toBeGreaterThan(0);
  });
});

describe('收货与上架（决策 I-01～I-05）', () => {
  it('ASN → 到店 → 逐箱生成内部箱号 → 关闭时生成差异 → 上架规则', () => {
    const st = new Store();
    st.loadOpening();
    const dry = statics.planogram.find((p) => p.area === 'DRY' && p.tempZone === 'AMBIENT') as PlanogramEntry;
    const chem = statics.planogram.find((p) => p.chemical) as PlanogramEntry;
    const frozen = statics.planogram.find((p) => p.tempZone === 'FROZEN') as PlanogramEntry;
    st.ok({ type: 'CreateAsn', supplier: 'DC', lines: [dry, chem, frozen].map((p) => ({ itemId: p.itemId, gtin: p.gtin, name: p.name, cases: 2, packQty: p.packQty })) });
    const receiptId = Object.keys(st.s.receipts)[0] as string;
    // 第一次扫箱就算卡车到了（决策记录 0026）；用 12 位 UPC 也能识别（GTIN 统一补齐为 14 位）
    const got = st.ok({ type: 'ReceiveCases', receiptId, gtin: dry.gtin.slice(2), cases: 3 }, 'X1');
    expect(got.map((e) => e.type)).toEqual(['TruckArrived', 'CasesReceived']);
    const recd = got.find((e) => e.type === 'CasesReceived');
    const caseIds = recd?.type === 'CasesReceived' ? recd.payload.caseIds : [];
    expect(caseIds).toHaveLength(3);
    for (const id of caseIds) expect(id).toMatch(/^C-\d{6}-\d{6}$/);
    st.ok({ type: 'ReceiveCases', receiptId, gtin: chem.gtin, cases: 1, damaged: true }, 'X1');
    st.ok({ type: 'ReceiveCases', receiptId, gtin: chem.gtin, cases: 1 }, 'X1');
    const closed = st.ok({ type: 'CloseReceipt', receiptId }, 'X1');
    const diffs = closed[0]?.type === 'ReceiptClosed' ? closed[0].payload.discrepancies : [];
    expect(diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: dry.itemId, kind: 'OVER', expected: 2, received: 3 }),
        expect.objectContaining({ itemId: chem.itemId, kind: 'DAMAGED', damaged: 1 }),
        expect.objectContaining({ itemId: frozen.itemId, kind: 'SHORT', received: 0 }),
      ]),
    );
    expect(st.code({ type: 'ReceiveCases', receiptId, gtin: dry.gtin, cases: 1 }, 'X1')).toBe('RECEIPT_CLOSED');
    // 上架：温区、隔离、状态
    const c0 = caseIds[0] as string;
    const coldBin = statics.bins.find((b) => b.tempZone === 'CHILLED' && b.status === 'SELLABLE') as { code: string };
    const chemBin = statics.bins.find((b) => b.area === 'CHEM') as { code: string };
    const dryBin = statics.bins.find((b) => b.area === 'DRY' && (st.s.bins[b.code]?.length ?? 0) < b.capacityCases) as { code: string };
    expect(st.code({ type: 'PutAwayCase', caseId: c0, binCode: coldBin.code }, 'X1')).toBe('BIN_ZONE');
    expect(st.code({ type: 'PutAwayCase', caseId: c0, binCode: chemBin.code }, 'X1')).toBe('BIN_ISOLATION');
    expect(st.code({ type: 'PutAwayCase', caseId: c0, binCode: 'QA-AMB' }, 'X1')).toBe('BIN_STATUS');
    expect(st.code({ type: 'PutAwayCase', caseId: c0, binCode: 'NOPE' }, 'X1')).toBe('BIN_NOT_FOUND');
    st.ok({ type: 'PutAwayCase', caseId: c0, binCode: dryBin.code }, 'X1');
    expect(st.s.cases[c0]?.state).toBe('STORED');
    expect(sellableCases(st.s, dry.itemId).map((c) => c.id)).toContain(c0);
    // 损坏箱：待检 → 报废
    const damaged = Object.values(st.s.cases).find((c) => c.damaged) as { id: string; status: string };
    expect(damaged.status).toBe('QA');
    st.ok({ type: 'PutAwayCase', caseId: damaged.id, binCode: 'QA-AMB' }, 'X1');
    st.ok({ type: 'ChangeCaseStatus', caseId: damaged.id, status: 'SCRAP', binCode: 'SCRAP-AMB' }, 'X1');
    expect(st.s.cases[damaged.id]).toMatchObject({ status: 'SCRAP', binCode: 'SCRAP-AMB' });
    expect(sellableCases(st.s, chem.itemId).some((c) => c.id === damaged.id)).toBe(false);
  });

  it('箱标签的二维码是 GS1 Digital Link，扫描后识别为箱子；库位和货架货位也能扫', () => {
    const st = new Store();
    st.loadOpening();
    const c = Object.values(st.s.cases)[0];
    if (!c) throw new Error('no case');
    const link = caseDigitalLink(c.gtin, c.id);
    expect(parseDigitalLink(link)).toEqual({ gtin14: c.gtin, serial: c.id.replace(/-/g, ''), caseId: c.id });
    expect(resolveScan(st.s, statics, link)).toMatchObject({ kind: 'case', caseId: c.id, itemId: c.itemId });
    expect(resolveScan(st.s, statics, c.id)).toMatchObject({ kind: 'case', caseId: c.id });
    expect(resolveScan(st.s, statics, c.binCode ?? '')).toEqual({ kind: 'bin', code: c.binCode });
    const p = statics.planogram[0] as PlanogramEntry;
    expect(resolveScan(st.s, statics, p.locationId.toLowerCase())).toMatchObject({ kind: 'location', locationId: p.locationId, itemIds: expect.arrayContaining([p.itemId]) });
    expect(isValidUpcA('012345678905')).toBe(true);
    expect(isValidUpcA('012345678904')).toBe(false);
  });
});

describe('货架存量估算（决策 R-01、R-02、P-06）', () => {
  it('销售推算扣减、传感器覆盖、重复读数不写事件、异常读数只标记', () => {
    const st = new Store();
    const p = statics.planogram.find((x) => x.sensor === 'tof') as PlanogramEntry;
    st.ok({ type: 'RecordSales', lines: [{ itemId: p.itemId, qty: 2 }] }, 'system');
    expect(shelfNow(st.s, p)).toMatchObject({ est: p.capacity - 2, source: 'POS' });
    st.now += 10 * MIN;
    st.ok({ type: 'RecordSales', lines: [{ itemId: p.itemId, qty: 3 }] }, 'system');
    const v1 = shelfNow(st.s, p).velocity;
    expect(v1).toBeGreaterThan(p.baseVelocity * 0.5);
    const r1 = st.ok({ type: 'RecordSensor', locationId: p.locationId, sensor: 'tof', units: 1, confidence: 0.94, itemId: p.itemId }, 'system');
    expect(r1[0]?.type).toBe('SensorReading');
    expect(shelfNow(st.s, p)).toMatchObject({ est: 1, source: 'SENSOR', conf: 0.94 });
    expect(st.ok({ type: 'RecordSensor', locationId: p.locationId, sensor: 'tof', units: 1, confidence: 0.94, itemId: p.itemId }, 'system')).toHaveLength(0);
    st.ok({ type: 'RecordSensor', locationId: p.locationId, sensor: 'tof', units: p.capacity + 9, confidence: 0.9, itemId: p.itemId }, 'system');
    expect(shelfNow(st.s, p)).toMatchObject({ est: 1, sensorAnomaly: true });
    expect(st.code({ type: 'RecordSensor', locationId: 'NOPE', sensor: 'tof', units: 1, confidence: 1 }, 'system')).toBe('LOCATION_NOT_FOUND');
  });
});

describe('补货任务（决策 R-05、X-04）', () => {
  it('低于阈值且后仓有货时生成任务；按预计售罄时间排序；同一通道合并成批；领取与完成', () => {
    const st = new Store();
    const [a, b] = statics.planogram.filter((x) => x.capacity >= 8).slice(0, 2) as [PlanogramEntry, PlanogramEntry];
    const none = statics.planogram.find((x) => x.itemId !== a.itemId && x.itemId !== b.itemId && x.capacity >= 8) as PlanogramEntry;
    const [caseA] = st.stock(a, 1);
    st.stock(b, 1);
    // 没有后仓库存的商品不生成任务
    st.ok({ type: 'RecordSales', lines: [{ itemId: none.itemId, qty: none.capacity }] }, 'system');
    expect(Object.keys(st.s.repl)).toHaveLength(0);
    st.ok({ type: 'RecordSales', lines: [{ itemId: a.itemId, qty: a.capacity }, { itemId: b.itemId, qty: b.capacity - 2 }] }, 'system');
    const tasks = Object.values(st.s.repl);
    expect(tasks.map((t) => [t.itemId, t.reason])).toEqual(expect.arrayContaining([[a.itemId, 'EMPTY'], [b.itemId, 'LOW']]));
    const ta = tasks.find((t) => t.itemId === a.itemId);
    const tb = tasks.find((t) => t.itemId === b.itemId);
    if (!ta || !tb) throw new Error('tasks');
    expect(ta.priority).toBeLessThanOrEqual(tb.priority);
    expect(ta.suggestedUnits).toBe(a.capacity);
    // 重复请求被拒绝
    expect(st.code({ type: 'RequestReplenishment', itemId: a.itemId }, 'R1')).toBe('TASK_EXISTS');
    expect(replBatches(st.s).flat().map((t) => t.id).sort()).toEqual([ta.id, tb.id].sort());
    // 领取：只能一人
    st.ok({ type: 'ClaimReplenishment', taskIds: [ta.id] }, 'R1');
    expect(st.code({ type: 'ClaimReplenishment', taskIds: [ta.id] }, 'X1')).toBe('TASK_TAKEN');
    // 完成：必须扫描对的货位和对的商品的箱子
    const wrongCase = Object.keys(st.s.cases).find((id) => id !== caseA) as string;
    expect(st.code({ type: 'CompleteReplenishment', taskId: ta.id, caseId: caseA as string, locationId: b.locationId, units: 4 }, 'R1')).toBe('LOCATION_MISMATCH');
    expect(st.code({ type: 'CompleteReplenishment', taskId: ta.id, caseId: wrongCase, locationId: a.locationId, units: 4 }, 'R1')).toBe('CASE_WRONG_ITEM');
    const units = Math.min(a.packQty, a.capacity);
    st.ok({ type: 'CompleteReplenishment', taskId: ta.id, caseId: caseA as string, locationId: a.locationId, units }, 'R1');
    expect(shelfNow(st.s, a)).toMatchObject({ est: units, conf: 0.95, source: 'SCAN' });
    expect(st.s.repl[ta.id]?.status).toBe('DONE');
    expect(st.s.cases[caseA as string]?.units).toBe(a.packQty - units);
    // 后仓按记录找不到：可疑 + 盘点
    st.ok({ type: 'ClaimReplenishment', taskIds: [tb.id] }, 'R1');
    const cancel = st.ok({ type: 'CancelReplenishment', taskId: tb.id }, 'R1');
    expect(cancel.map((e) => e.type)).toEqual(['ReplenishmentCancelled', 'CycleCountCreated']);
    expect(st.s.suspect[b.itemId]).toBe(st.now);
    expect(replay(st.log, emptyState(), statics)).toEqual(st.s);
  });

  it('优先级、触发条件、分批与 ABC 分类', () => {
    const base = { capacity: 20, velocityPerHour: 4, onlineDemand: 0, unitPrice: 3 };
    expect(needsReplenishment({ ...base, est: 5 })).toBe(true);
    expect(needsReplenishment({ ...base, est: 15 })).toBe(false);
    expect(needsReplenishment({ ...base, est: 15, velocityPerHour: 10 })).toBe(true);
    expect(needsReplenishment({ ...base, est: 15, onlineDemand: 12 })).toBe(true);
    expect(replenishPriority({ ...base, est: 0 })).toBe(0);
    expect(replenishPriority({ ...base, est: 4 })).toBeLessThan(replenishPriority({ ...base, est: 8 }));
    expect(replenishPriority({ ...base, est: 8, unitPrice: 30 })).toBeLessThan(replenishPriority({ ...base, est: 8, unitPrice: 1 }));
    const batches = batchByArea(
      [
        { id: 't1', area: 'A1', priority: 50 },
        { id: 't2', area: 'A2', priority: 5 },
        { id: 't3', area: 'A1', priority: 10 },
      ],
      8,
    );
    expect(batches.map((b) => b.map((t) => t.id))).toEqual([['t2'], ['t3', 't1']]);
    // 推车的装载上限（决策记录 0026）：超重、超体积另起一批；一箱就超的单独成批
    const heavy = [
      { id: 'h1', area: 'B', priority: 1, kg: 60, l: 40 },
      { id: 'h2', area: 'B', priority: 2, kg: 60, l: 40 },
      { id: 'h3', area: 'B', priority: 3, kg: 60, l: 40 },
      { id: 'h4', area: 'B', priority: 4, kg: 200, l: 10 },
      { id: 'h5', area: 'B', priority: 5, kg: 5, l: 500 },
      { id: 'h6', area: 'B', priority: 6, kg: 5, l: 200 },
    ];
    const load = { kg: 150, liters: 600, weight: (t: (typeof heavy)[number]) => t.kg, volume: (t: (typeof heavy)[number]) => t.l };
    expect(batchByArea(heavy, 8, load).map((b) => b.map((t) => t.id))).toEqual([['h1', 'h2'], ['h3'], ['h4'], ['h5'], ['h6']]);
    expect(batchByArea(heavy, 2).map((b) => b.length)).toEqual([2, 2, 2]);
    const abc = classifyAbc(Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, value: i === 0 ? 100 : 1 })));
    expect(abc.get('i0')).toBe('A');
    expect([...abc.values()].filter((c) => c === 'C').length).toBeGreaterThan(0);
  });
});

describe('补货推车的装载上限（决策记录 0026）', () => {
  it('陈列表里有每箱的重量和体积；按门店的推车上限分批，不给门店数据时仍只按 8 个任务分', () => {
    expect(statics.planogram.every((p) => (p.caseKg ?? 0) > 0 && (p.caseL ?? 0) > 0)).toBe(true);
    const run = statics.planogram[0]?.runId;
    const items = statics.planogram.filter((p) => p.runId === run).slice(0, 6);
    expect(items.length).toBeGreaterThan(2);
    const s = emptyState();
    items.forEach((p, i) => {
      s.repl[`R${i}`] = { id: `R${i}`, locationId: p.locationId, itemId: p.itemId, area: run as string, reason: 'LOW', suggestedUnits: 1, priority: i, createdAt: 0, status: 'OPEN' };
    });
    expect(replBatches(s).map((b) => b.length)).toEqual([items.length]);
    const kgOf = (id: string) => statics.planogram.find((p) => p.itemId === id)?.caseKg ?? 0;
    const cartKg = Math.max(...items.map((p) => p.caseKg ?? 0)) + 0.1;
    const small = { ...statics, replenish: { ...statics.replenish, cartKg, cartL: 10_000 } };
    const batches = replBatches(s, small);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.length === 1 || b.reduce((n, t) => n + kgOf(t.itemId), 0) <= cartKg).toBe(true);
    expect(batches.flat().map((t) => t.id).sort()).toEqual(Object.keys(s.repl).sort());
  });
});

describe('Exception 与闭环（决策 X-01～X-04）', () => {
  function pickedOrder(st: Store, o: Order, noStockItem?: string) {
    const info = orderInfoFrom(o, catalog.byId, st.now + 90 * MIN, rules.slotLengthMin);
    st.ok({ type: 'CreateOrder', order: info, codeHash: ctx.hash(codeHashInput(info.id, 'AAAA')) });
    st.ok({ type: 'LockOrder', orderId: info.id });
    st.ok({ type: 'ReleaseWalks' });
    const walks = Object.values(st.s.walks).filter((w) => w.toteIds.some((t) => st.s.totes[t]?.orderId === info.id));
    let exceptionId = '';
    for (const w of walks) {
      st.ok({ type: 'ClaimWalk', walkId: w.id }, 'P1');
      for (const t of w.toteIds) st.ok({ type: 'BindLabel', walkId: w.id, labelId: st.s.totes[t]?.labelId ?? '' }, 'P1');
      for (const r of pickRows(st.s, w)) {
        if (r.itemId === noStockItem && !exceptionId) {
          const out = st.ok({ type: 'ReportNotFound', walkId: w.id, toteId: r.toteId, lineId: r.lineId, qty: r.qty, resolution: 'EXCEPTION' }, 'P1');
          exceptionId = out.find((e) => e.type === 'ExceptionCreated')?.type === 'ExceptionCreated' ? ((out.find((e) => e.type === 'ExceptionCreated') as { payload: { exceptionId: string } }).payload.exceptionId) : '';
        } else st.ok({ type: 'PickItem', walkId: w.id, toteId: r.toteId, lineId: r.lineId, qty: r.qty }, 'P1');
      }
      st.ok({ type: 'CompleteWalk', walkId: w.id }, 'P1');
    }
    for (const id of st.s.orders[info.id]?.toteIds ?? []) st.ok({ type: 'StageTote', labelId: st.s.totes[id]?.labelId ?? '', slotCode: suggestSlots(st.s, statics, id)[0] ?? '' }, 'P1');
    return { orderId: info.id, exceptionId };
  }

  it('货架空 → Exception → 补货任务 → 货架恢复', () => {
    const st = new Store();
    const o = orders.find((x) => x.lines.length >= 2 && byItem.get(x.lines[0]?.itemId ?? '')) as Order;
    const line = o.lines[0];
    if (!line) throw new Error('line');
    const p = byItem.get(line.itemId) as PlanogramEntry;
    // 没有后仓库存时不能转后仓补取
    const [caseId] = st.stock(p, 1);
    const { orderId, exceptionId } = pickedOrder(st, o, line.itemId);
    expect(exceptionId).not.toBe('');
    // 1. 货架空：拣货员报告找不到 = 确认为空
    expect(shelfNow(st.s, p).est).toBe(0);
    // 2. Exception：只有授权员工可以领取
    expect(st.code({ type: 'ClaimException', exceptionId }, 'P1')).toBe('NOT_AUTHORIZED');
    st.ok({ type: 'ClaimException', exceptionId }, 'X1');
    expect(st.code({ type: 'ExceptionFound', exceptionId, caseId: 'C-000000-000000', binEmpty: false }, 'X1')).toBe('CASE_NOT_FOUND');
    const found = st.ok({ type: 'ExceptionFound', exceptionId, caseId: caseId as string, binEmpty: false }, 'X1');
    expect(found.map((e) => e.type)).toContain('ExceptionItemFound');
    // 送到订单的框所在的暂存格位
    const tote = st.s.orders[orderId]?.toteIds.map((id) => st.s.totes[id]).find((t) => t?.lines.some((l) => l.lineId === line.lineId));
    expect(st.code({ type: 'DeliverException', exceptionId, slotCode: 'AMB-99-99-99' }, 'X1')).toBe('LOCATION_MISMATCH');
    st.ok({ type: 'DeliverException', exceptionId, slotCode: tote?.slotCode ?? '' }, 'X1');
    expect(st.s.orders[orderId]?.lineResults[line.lineId]).toMatchObject({ short: 0, recovered: line.qty });
    // 3. 补货任务：拣货员报告时已经生成（货架空、后仓有货），Exception 找到后不重复生成
    const tasks = Object.values(st.s.repl).filter((t) => t.locationId === p.locationId);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    if (!task) throw new Error('task');
    // 4. 补货上架：箱子里剩下的件数补到货架上
    st.ok({ type: 'ClaimReplenishment', taskIds: [task.id] }, 'R1');
    const left = st.s.cases[caseId as string]?.units ?? 0;
    expect(left).toBe(p.packQty - line.qty);
    if (left > 0) {
      st.ok({ type: 'CompleteReplenishment', taskId: task.id, caseId: caseId as string, locationId: p.locationId, units: Math.min(left, p.capacity) }, 'R1');
      expect(shelfNow(st.s, p).est).toBe(Math.min(left, p.capacity));
    }
    expect(replay(st.log, emptyState(), statics)).toEqual(st.s);
  });

  // 流程梳理发现的问题（决策记录 0025）
  it('箱子里不够时按实际取出的件数记；订单交付后，没找到的补取作废，已经找到的放回货架', () => {
    const st = new Store();
    const o = orders.find((x) => x.lines.some((l) => l.qty >= 2 && byItem.get(l.itemId))) as Order;
    const line = o.lines.find((l) => l.qty >= 2 && byItem.get(l.itemId));
    if (!line) throw new Error('line');
    const p = byItem.get(line.itemId) as PlanogramEntry;
    // 后仓只有一箱、箱里只剩 1 件
    const [caseId] = st.stock(p, 1);
    // 测试里直接改箱子的件数（不检查重放）
    (st.s.cases[caseId as string] as { units: number }).units = 1;
    const { orderId, exceptionId } = pickedOrder(st, o, line.itemId);
    st.ok({ type: 'ClaimException', exceptionId }, 'X1');
    st.ok({ type: 'ExceptionFound', exceptionId, caseId: caseId as string, binEmpty: true }, 'X1');
    expect(st.s.exceptions[exceptionId]?.units).toBe(1);
    // 顾客到店、交付（还没送到暂存）
    st.ok({ type: 'CheckIn', orderId, bay: '1' }, 'customer');
    st.ok({ type: 'StartPrep', key: orderId }, 'H1');
    for (const id of st.s.orders[orderId]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: orderId, labelId: st.s.totes[id]?.labelId ?? '' }, 'H1');
    st.ok({ type: 'VerifyCode', key: orderId, code: 'AAAA' }, 'H1');
    st.ok({ type: 'CompleteHandoff', key: orderId, removeAgeItems: true }, 'H1');
    expect(st.code({ type: 'DeliverException', exceptionId, slotCode: 'X' }, 'X1')).toBe('ORDER_COMPLETED');
    // 放回货架：货架估算加上实际取出的 1 件
    expect(st.code({ type: 'ReturnExceptionItems', exceptionId }, 'P1')).toBe('EXCEPTION_NOT_YOURS');
    const before = shelfNow(st.s, p).est;
    st.ok({ type: 'ReturnExceptionItems', exceptionId }, 'X1');
    expect(st.s.exceptions[exceptionId]?.status).toBe('VOID');
    expect(shelfNow(st.s, p).est).toBe(Math.min(p.capacity, before + 1));
    // 另一张订单：补取还没人领就交付了，作废
    const o2 = orders.filter((x) => x.id !== o.id).find((x) => x.lines.some((l) => byItem.get(l.itemId))) as Order;
    const line2 = o2.lines.find((l) => byItem.get(l.itemId)) as Order['lines'][number];
    st.stock(byItem.get(line2.itemId) as PlanogramEntry, 1);
    const second = pickedOrder(st, o2, line2.itemId);
    st.ok({ type: 'CheckIn', orderId: second.orderId, bay: '2' }, 'customer');
    st.ok({ type: 'StartPrep', key: second.orderId }, 'H1');
    for (const id of st.s.orders[second.orderId]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: second.orderId, labelId: st.s.totes[id]?.labelId ?? '' }, 'H1');
    st.ok({ type: 'VerifyCode', key: second.orderId, code: 'AAAA' }, 'H1');
    st.ok({ type: 'CompleteHandoff', key: second.orderId, removeAgeItems: true }, 'H1');
    expect(st.s.exceptions[second.exceptionId]?.status).toBe('VOID');
  });

  it('召回中的箱子不能从待检放回可售；保质期写法不对时说明是日期', () => {
    const st = new Store();
    const p = [...byItem.values()][3] as PlanogramEntry;
    const [caseId] = st.stock(p, 1);
    st.ok({ type: 'ChangeCaseStatus', caseId: caseId as string, status: 'QA' }, 'X1');
    st.s.recalls = { RC1: { id: 'RC1', title: 't', itemIds: [p.itemId], lots: [], openedAt: st.now, by: 'L1', status: 'OPEN', steps: {}, affected: { shelf: {}, cases: [], totes: [], openOrders: [], doneOrders: [] } } };
    expect(st.code({ type: 'ChangeCaseStatus', caseId: caseId as string, status: 'SELLABLE' }, 'X1')).toBe('ITEM_RECALLED');
    expect(st.code({ type: 'ChangeCaseStatus', caseId: caseId as string, status: 'SCRAP' }, 'X1')).toBe('OK');
    st.ok({ type: 'CreateAsn', supplier: 'S', lines: [{ itemId: p.itemId, gtin: p.gtin, name: p.name, cases: 1, packQty: p.packQty }] });
    const r = Object.keys(st.s.receipts)[0] as string;
    st.ok({ type: 'ArriveTruck', receiptId: r }, 'X1');
    expect(st.code({ type: 'ReceiveCases', receiptId: r, gtin: p.gtin, cases: 1, expiry: '2026/11/01' }, 'X1')).toBe('DATE_INVALID');
  });

  it('后仓也找不到（幽灵库存）：记录可疑、生成盘点任务；盘点后修正箱子并清除可疑', () => {
    const st = new Store();
    const o = orders.find((x) => x.lines.length >= 2 && byItem.get(x.lines[1]?.itemId ?? '')) as Order;
    const line = o.lines[1];
    if (!line) throw new Error('line');
    const p = byItem.get(line.itemId) as PlanogramEntry;
    const [caseId] = st.stock(p, 2);
    const { exceptionId } = pickedOrder(st, o, line.itemId);
    st.ok({ type: 'ClaimException', exceptionId }, 'X1');
    const out = st.ok({ type: 'ExceptionMissing', exceptionId }, 'X1');
    expect(out.map((e) => e.type)).toEqual(['ExceptionNotFound', 'CycleCountCreated']);
    expect(st.s.suspect[p.itemId]).toBeDefined();
    // 可疑期间不再生成这个商品的补货任务，也不能再转后仓补取
    expect(st.code({ type: 'RequestReplenishment', itemId: p.itemId }, 'R1')).toBe('NO_BACKROOM_STOCK');
    const count = Object.values(st.s.counts)[0];
    if (!count) throw new Error('count');
    st.ok({ type: 'ClaimCount', countId: count.id }, 'X1');
    expect(st.code({ type: 'ClaimCount', countId: count.id }, 'R1')).toBe('COUNT_TAKEN');
    // 实际只有 1 箱：记为丢失 1 箱
    const done = st.ok({ type: 'CompleteCount', countId: count.id, results: [{ itemId: p.itemId, counted: 1 }] }, 'X1');
    const payload = done[0]?.type === 'CycleCountCompleted' ? done[0].payload : undefined;
    expect(payload?.results).toEqual([{ itemId: p.itemId, expected: 2, counted: 1 }]);
    expect(payload?.lostCaseIds).toHaveLength(1);
    expect(st.s.suspect[p.itemId]).toBeUndefined();
    expect(sellableCases(st.s, p.itemId)).toHaveLength(1);
    void caseId;
  });

  it('排程：低库存货位批量生成任务；盘点按 ABC 周期到期', () => {
    const st = new Store();
    st.loadOpening();
    const withStock = statics.planogram.filter((p) => st.s.itemCases[p.itemId]?.length).slice(0, 30);
    st.ok({ type: 'RecordSales', lines: withStock.map((p) => ({ itemId: p.itemId, qty: p.capacity })) }, 'system');
    const n = Object.keys(st.s.repl).length;
    expect(n).toBeGreaterThan(20);
    // 已有任务的货位不重复生成
    expect(st.ok({ type: 'Tick', release: false }).filter((e) => e.type === 'ReplenishmentTaskCreated')).toHaveLength(0);
    // 8 天后 A 类库位的盘点到期
    st.now += 8 * 86_400_000;
    const counts = st.ok({ type: 'Tick', release: false }).filter((e) => e.type === 'CycleCountCreated');
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.length).toBeLessThanOrEqual(3);
  });
});

describe('一次找不到只盘这个库位、盘点放回队列、核对和盘点扫码（决策记录 0026）', () => {
  it('补货时说了找过的库位：只盘这个库位，别的库位的箱子照样能用；没说时整个商品标为可疑', () => {
    const st = new Store();
    const p = [...byItem.values()].find((x) => x.tempZone === 'AMBIENT') as PlanogramEntry;
    st.stock(p, 1);
    // 第二箱放到另一个库位
    const other = statics.bins.find((b) => b.status === 'SELLABLE' && b.tempZone === p.tempZone && b.area === p.area && b.code !== st.s.cases[sellableCases(st.s, p.itemId)[0]?.id ?? '']?.binCode);
    const ev = { seq: st.s.seq + 1, at: st.now, actor: 'system', type: 'InventoryLoaded', payload: { cases: [{ caseId: 'C-261020-000999', itemId: p.itemId, gtin: p.gtin, name: p.name, packQty: p.packQty, units: p.packQty, binCode: other?.code ?? '' }] } } as AnyOpsEvent;
    replay([ev], st.s, statics);
    st.log.push(ev);
    st.ok({ type: 'RequestReplenishment', itemId: p.itemId }, 'R1');
    const task = Object.values(st.s.repl).find((x) => x.itemId === p.itemId && x.status === 'OPEN');
    if (!task) throw new Error('task');
    st.ok({ type: 'ClaimReplenishment', taskIds: [task.id] }, 'R1');
    const first = usableCases(st.s, p.itemId)[0];
    st.ok({ type: 'CancelReplenishment', taskId: task.id, binCode: first?.binCode ?? '' }, 'R1');
    expect(st.s.suspect[p.itemId]).toBeUndefined();
    expect(Object.values(st.s.counts).filter((c) => c.status === 'OPEN').map((c) => c.binCode)).toEqual([first?.binCode]);
    expect(usableCases(st.s, p.itemId).map((c) => c.binCode)).not.toContain(first?.binCode);
    expect(usableCases(st.s, p.itemId).length).toBeGreaterThan(0);
  });

  it('盘点放回队列；扫了库位就核对；要求扫码时必须扫库位；核对货架要扫货位', () => {
    const st = new Store();
    const p = [...byItem.values()][5] as PlanogramEntry;
    const [caseId] = st.stock(p, 1);
    const bin = st.s.cases[caseId as string]?.binCode as string;
    st.ok({ type: 'CreateCount', binCode: bin });
    const count = Object.values(st.s.counts).find((c) => c.binCode === bin) as NonNullable<OpsState['counts'][string]>;
    st.ok({ type: 'ClaimCount', countId: count.id }, 'X1');
    expect(st.code({ type: 'ReleaseCount', countId: count.id }, 'R1')).toBe('COUNT_TAKEN');
    st.ok({ type: 'ReleaseCount', countId: count.id }, 'X1');
    expect(st.s.counts[count.id]?.status).toBe('OPEN');
    st.ok({ type: 'ClaimCount', countId: count.id }, 'X1');
    expect(st.code({ type: 'CompleteCount', countId: count.id, results: [{ itemId: p.itemId, counted: 1 }], binCode: 'NOPE' }, 'X1')).toBe('LOCATION_MISMATCH');
    st.ok({ type: 'SetStoreSettings', requireScan: true });
    expect(st.code({ type: 'CompleteCount', countId: count.id, results: [{ itemId: p.itemId, counted: 1 }] }, 'X1')).toBe('SCAN_REQUIRED');
    st.ok({ type: 'CompleteCount', countId: count.id, results: [{ itemId: p.itemId, counted: 1 }], binCode: bin }, 'X1');
    expect(st.s.counts[count.id]?.status).toBe('DONE');
    expect(replay(st.log, emptyState(), statics)).toEqual(st.s);
  });
});

describe('货架上的批次任务、补取放回队列（决策记录 0026）', () => {
  it('过期的批次自动生成「下架」任务（每批一次）；做完后批次和货架估算减掉；降价采纳后给补货员「贴折扣签」任务', () => {
    const st = new Store();
    const p = [...byItem.values()].find((x) => x.tempZone === 'AMBIENT') as PlanogramEntry;
    st.stock(p, 1);
    st.s.shelfLots = { [p.itemId]: [{ lot: 'OLD1', expiry: '2026-10-01', units: 5, at: st.now, caseId: 'C-1' }, { lot: 'NEW1', expiry: '2027-01-01', units: 7, at: st.now, caseId: 'C-2' }] };
    (st.s.shelf as Record<string, { est: number }>)[p.itemId] = { ...(st.s.shelf[p.itemId] ?? {}), est: 12 } as never;
    const out = st.ok({ type: 'Tick', release: false }, 'system');
    const pull = out.find((e) => e.type === 'ShelfCheckRequested');
    expect(pull?.type === 'ShelfCheckRequested' && pull.payload).toMatchObject({ reason: 'PULL', lot: 'OLD1', expected: 5 });
    expect(st.ok({ type: 'Tick', release: false }, 'system').some((e) => e.type === 'ShelfCheckRequested' && e.payload.reason === 'PULL')).toBe(false);
    const task = Object.values(st.s.checks).find((c) => c.reason === 'PULL') as NonNullable<OpsState['checks'][string]>;
    st.ok({ type: 'ConfirmShelf', itemId: p.itemId, units: 5, checkId: task.id }, 'R1');
    expect(st.s.checks[task.id]?.status).toBe('DONE');
    expect(st.s.shelfLots?.[p.itemId]?.map((l) => l.lot)).toEqual(['NEW1']);
    expect(st.s.shelf[p.itemId]?.est).toBe(7);
    // 降价：采纳后同时生成「贴折扣签」任务
    const draft = { module: 'EXPIRY' as const, target: `${p.itemId}|NEW1`, action: { kind: 'MARKDOWN', params: { itemId: p.itemId, lot: 'NEW1', pct: 0.3 } }, confidence: 0.6, reasons: [], alternatives: [], model: { id: 'expiry-risk', version: 1, kind: 'k' }, expiresAt: st.now + 3_600_000 };
    st.ok({ type: 'IssueRecommendation', draft }, 'ai');
    const rec = Object.values(st.s.recs).find((r) => r.module === 'EXPIRY') as NonNullable<OpsState['recs'][string]>;
    const accepted = st.ok({ type: 'AcceptRecommendation', recId: rec.id });
    expect(accepted.map((e) => e.type)).toEqual(['RecommendationResolved', 'MarkdownApplied', 'ShelfCheckRequested']);
    expect(Object.values(st.s.checks).find((c) => c.reason === 'MARKDOWN')).toMatchObject({ lot: 'NEW1', pct: 0.3, expected: 7, status: 'OPEN' });
  });
});
