import { describe, expect, it } from 'vitest';
import { DEFAULT_REPLENISH_RULES, stockoutRisk } from '@storewright/algorithms';
import type { RecommendationDraft } from '@storewright/ai';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateCatalog, generateOrders } from '@storewright/synth';
import type { OpsCommand } from './commands';
import { planogramByItem, sellableCases } from './inventory';
import { planNudges } from './nudges';
import { buildBins, buildPlanogram, execute, initialInventory, orderInfoFrom, type OpsContext } from './server';
import { emptyState, type OpsState, type StoreStatic } from './types';

/** 门店 AI 第二轮 · 第一批的作业侧（决策记录 0021）：建议中枢、按断货概率补货、运营预警的动作 */

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
    { id: 'L1', name: 'Lead', role: 'LEAD', exceptionAuthorized: true },
    { id: 'X1', name: 'Backroom', role: 'BACKROOM', exceptionAuthorized: true },
    { id: 'R1', name: 'Restock', role: 'RESTOCK', exceptionAuthorized: false },
  ],
  bins: buildBins(model),
  planogram: buildPlanogram(model, catalog.byId),
  replenish: DEFAULT_REPLENISH_RULES,
};
const ctx: OpsContext = { model, items: catalog.byId, hash: (s) => `h(${s})`, statics };
const T0 = new Date(2026, 9, 20, 15, 0).getTime();
const MIN = 60_000;
const orders = generateOrders(model, catalog, DEFAULT_DEMAND.medium, { seed: 3 });

class Store {
  s: OpsState = emptyState();
  now = T0;
  run(cmd: OpsCommand, actor = 'console') {
    return execute(this.s, { cmd, actor, at: this.now }, ctx);
  }
  ok(cmd: OpsCommand, actor = 'console') {
    const r = this.run(cmd, actor);
    if (!r.decision.ok) throw new Error(`${cmd.type} rejected: ${JSON.stringify(r.decision.reject)}`);
    return r.events;
  }
  rec(module: RecommendationDraft['module'], target: string, extra: Partial<RecommendationDraft> = {}): string {
    const draft: RecommendationDraft = { module, target, action: { kind: 'EXPEDITE_ORDERS', params: { orderIds: target } }, confidence: 0.8, reasons: [], alternatives: [], model: { id: 'm', version: 1, kind: 'k' }, expiresAt: this.now + 30 * MIN, ...extra };
    const ev = this.ok({ type: 'IssueRecommendation', draft }, 'ai');
    return (ev.find((e) => e.type === 'RecommendationIssued')?.payload as { rec: { id: string } }).rec.id;
  }
  order(i: number, slotInMin: number, prefix = 'O') {
    const o = orders[i];
    if (!o) throw new Error('no order');
    const info = orderInfoFrom({ ...o, id: `${prefix}${i}`, shortCode: `S${prefix}${i}` }, catalog.byId, this.now + slotInMin * MIN, rules.slotLengthMin);
    this.ok({ type: 'CreateOrder', order: info, codeHash: 'x' });
    return info;
  }
}

describe('建议中枢（决策记录 0021 · G1）', () => {
  it('建议发给在岗的带班负责人；正在交付的人先不打扰（紧急的照发）；每人每小时最多 3 条非紧急', () => {
    const st = new Store();
    for (let i = 0; i < 4; i++) st.order(i, 120 + i);
    const a = st.rec('FORESIGHT', 'O0');
    const plan = planNudges(st.s, statics, st.now);
    const toLead = plan.send.filter((n) => n.to === 'L1');
    expect(toLead).toHaveLength(1);
    expect(toLead[0]?.refs).toEqual([a]);
    expect(plan.send.some((n) => n.to === 'P1')).toBe(false);

    // 带班负责人正在交付：非紧急的先不发
    st.s.sessions.O9 = { key: 'O9', kind: 'ORDER', orderIds: [], status: 'READY', owner: 'L1', helpers: [], startedAt: st.now, scanned: [], codeFailures: 0, manualRequired: false, ageVerified: false };
    const busy = planNudges(st.s, statics, st.now);
    expect(busy.send.filter((n) => n.to === 'L1')).toHaveLength(0);
    expect(busy.deferred.some((d) => d.to === 'L1' && d.why === 'BUSY')).toBe(true);
    // 紧急的照发
    st.rec('STAFFING', 'O1', { action: { kind: 'EXPEDITE_ORDERS', params: { orderIds: 'O1', urgent: true } } });
    expect(planNudges(st.s, statics, st.now).send.some((n) => n.to === 'L1' && n.urgent)).toBe(true);
    delete st.s.sessions.O9;

    // 预算：4 个不同模块的非紧急建议，只发 3 条
    const s2 = new Store();
    for (let i = 0; i < 4; i++) s2.order(i, 120 + i);
    s2.rec('FORESIGHT', 'O0');
    s2.rec('CAPACITY', 'O1');
    s2.rec('STAGING', 'O2');
    s2.rec('INBOUND', 'O3');
    const p2 = planNudges(s2.s, statics, s2.now);
    expect(p2.send.filter((n) => n.to === 'L1')).toHaveLength(3);
    expect(p2.deferred.filter((d) => d.why === 'BUDGET')).toHaveLength(1);
    // 发出去以后：同一组没处理完的不重复发；处理完的关闭
    s2.ok({ type: 'SendNudges', nudges: p2.send }, 'ai');
    const again = planNudges(s2.s, statics, s2.now + MIN);
    expect(again.send.filter((n) => n.to === 'L1')).toHaveLength(0);
    const first = Object.values(s2.s.nudges)[0];
    s2.ok({ type: 'DismissRecommendation', recId: first?.refs[0] as string }, 'L1');
    expect(planNudges(s2.s, statics, s2.now + 2 * MIN).close).toEqual([{ id: first?.id, status: 'DONE' }]);
  });

  it('同一通道的核对任务合成一条；几台冷柜同时超温合成一条；严重告警没人确认就升级给门店管理员', () => {
    const st = new Store();
    const byRun = new Map<string, string[]>();
    for (const p of statics.planogram) byRun.set(p.runId, [...(byRun.get(p.runId) ?? []), p.itemId]);
    const [, items] = [...byRun.entries()].find(([, v]) => v.length >= 2) ?? ['', []];
    for (const id of (items as string[]).slice(0, 2)) st.ok({ type: 'ConfirmShelf', itemId: id, units: 5 }, 'R1');
    const sc = (items as string[]).slice(0, 2);
    for (const id of sc) {
      const p = planogramByItem(statics).get(id);
      st.s.checks[`SC-${id}`] = { id: `SC-${id}`, itemId: id, locationId: p?.locationId ?? '', reason: 'AI', createdAt: st.now, status: 'OPEN' };
    }
    const plan = planNudges(st.s, statics, st.now);
    const checks = plan.send.filter((n) => n.to === 'R1' && n.kind === 'TASK');
    expect(checks).toHaveLength(1);
    expect(checks[0]?.refs).toHaveLength(2);
    expect(checks[0]?.params?.count).toBe(2);

    const impact = { orders: [], totes: 0, cases: 0, units: 0, moveTo: [] };
    st.ok({ type: 'RaiseEquipmentAlert', sensorId: 'T-COOLER-1', kind: 'TEMP_HIGH', severity: 'ALARM', value: 9, limit: 8, since: st.now, impact }, 'twin');
    st.ok({ type: 'RaiseEquipmentAlert', sensorId: 'T-FREEZER-1', kind: 'TEMP_HIGH', severity: 'ALARM', value: -10, limit: -12, since: st.now, impact }, 'twin');
    const p2 = planNudges(st.s, statics, st.now + 30_000);
    const multi = p2.send.filter((n) => n.to === 'X1' && n.topic === 'ALERT:MULTI');
    expect(multi).toHaveLength(1);
    expect(multi[0]?.refs).toHaveLength(2);
    expect(multi[0]?.urgent).toBe(true);
    expect(p2.send.some((n) => n.to === 'console')).toBe(false);
    // 6 分钟后还没人确认：升级
    const p3 = planNudges(st.s, statics, st.now + 6 * MIN);
    expect(p3.send.filter((n) => n.to === 'console' && n.kind === 'ESCALATION')).toHaveLength(2);
  });
});

describe('补货优先级：按断货概率，含已下单的线上需求（决策记录 0021 · C2）', () => {
  it('断货概率随线上订单增加；已下单要的件数超过货架估算时概率为 1', () => {
    const base = { est: 6, velocityPerHour: 1, onlineOrderedUnits: 0, onlineForecastUnits: 0, horizonH: 2 };
    const r0 = stockoutRisk(base);
    const r1 = stockoutRisk({ ...base, onlineForecastUnits: 4 });
    const r2 = stockoutRisk({ ...base, onlineOrderedUnits: 4 });
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
    expect(stockoutRisk({ ...base, onlineOrderedUnits: 6 })).toBe(1);
    expect(stockoutRisk({ ...base, pFind: 0.3 })).toBeGreaterThan(r0);
  });

  it('补货任务按断货概率排，任务里写着依据（线上要几件、货架估计几件）', () => {
    const st = new Store();
    st.ok({ type: 'LoadInventory', cases: initialInventory(statics.planogram, statics.bins, catalog.byId, 9, st.now).cases }, 'system');
    // 一张订单要 6 件某商品；货架上只剩 4 件（高于补货线，原来的规则不会触发）
    const p = statics.planogram.find((x) => x.capacity >= 12 && sellableCases(st.s, x.itemId).length > 0 && x.baseVelocity < 2);
    if (!p) throw new Error('no item');
    const info = st.order(0, 60);
    info.lines = [{ ...(info.lines[0] as (typeof info.lines)[number]), itemId: p.itemId, qty: 6 }];
    st.s.orders[info.id] = { ...(st.s.orders[info.id] as OpsState['orders'][string]), lines: info.lines };
    st.ok({ type: 'ConfirmShelf', itemId: p.itemId, units: Math.max(7, Math.ceil(p.capacity * 0.4)) }, 'R1');
    st.ok({ type: 'Tick', release: false }, 'system');
    const task = Object.values(st.s.repl).find((t) => t.itemId === p.itemId);
    expect(task).toBeDefined();
    expect(task?.risk).toBeGreaterThan(0.5);
    expect(task?.why?.ordered).toBe(6);
    expect(task?.why?.orders).toBe(1);
  });
});

describe('运营预警的动作（决策记录 0021 · A2）', () => {
  it('提前开始：不等锁单时间就锁单，批次排在最前；冷冻商品晚点拣：到时间才进批次；通知顾客延后', () => {
    const st = new Store();
    const far = st.order(0, 300);
    const id = st.rec('FORESIGHT', 'LATE', { action: { kind: 'EXPEDITE_ORDERS', params: { orderIds: far.id } } });
    st.ok({ type: 'AcceptRecommendation', recId: id }, 'L1');
    expect(st.s.orders[far.id]?.expedite).toBe(true);
    st.ok({ type: 'Tick', release: false }, 'system');
    expect(st.s.orders[far.id]?.status).toBe('LOCKED');
    const walks = Object.values(st.s.walks).filter((w) => w.toteIds.some((t) => st.s.totes[t]?.orderId === far.id));
    expect(walks.length).toBeGreaterThan(0);
    expect(walks.every((w) => w.priority)).toBe(true);

    // 冷冻商品晚点拣
    const i = orders.findIndex((o) => o.lines.some((l) => catalog.byId.get(l.itemId)?.tempZone === 'FROZEN'));
    const frozen = st.order(i, 90, 'F');
    const d = st.rec('FORESIGHT', 'COLD_FULL', { action: { kind: 'DEFER_FROZEN', params: { orderIds: frozen.id, until: st.now + 40 * MIN } } });
    st.ok({ type: 'AcceptRecommendation', recId: d }, 'L1');
    st.ok({ type: 'LockOrder', orderId: frozen.id });
    st.ok({ type: 'ReleaseWalks' });
    const totes = st.s.orders[frozen.id]?.toteIds.map((t) => st.s.totes[t]) ?? [];
    expect(totes.filter((t) => t?.tempZone === 'FROZEN').every((t) => t?.status === 'PLANNED')).toBe(true);
    expect(totes.filter((t) => t?.tempZone !== 'FROZEN').every((t) => t?.status !== 'PLANNED')).toBe(true);
    st.now += 41 * MIN;
    st.ok({ type: 'ReleaseWalks' });
    expect(st.s.orders[frozen.id]?.toteIds.every((t) => st.s.totes[t]?.status !== 'PLANNED')).toBe(true);

    // 通知顾客延后
    const n = st.rec('FORESIGHT', 'NOTE', { action: { kind: 'NOTIFY_DELAY', params: { orderIds: frozen.id, minutes: 15 } } });
    st.ok({ type: 'AcceptRecommendation', recId: n }, 'L1');
    expect(st.s.orders[frozen.id]?.delayMin).toBe(15);
    expect(st.s.orders[frozen.id]?.delayNoticeAt).toBe(st.now);
  });
});

describe('效果追踪与 AI 运行监控（决策记录 0022 · F4、H3）', () => {
  it('采纳后连续不准时自动降成只显示，并提醒带班负责人；改回来以后要重新攒够次数才会再降', () => {
    const st = new Store();
    const record = (id: string, hit: boolean) => st.ok({ type: 'RecordOutcome', recId: id, outcome: { kind: 'EFFECT', metric: 'LATE', unit: 'ORDERS', predicted: 1, baseline: 5, actual: hit ? 1 : 5, hit, realized: hit ? 1 : 0 } }, 'ai');
    const adopt = (i: number) => {
      const id = st.rec('FORESIGHT', `T${i}`, { action: { kind: 'INFO' } });
      st.ok({ type: 'AcceptRecommendation', recId: id }, 'L1');
      return id;
    };
    let events: Array<{ type: string }> = [];
    for (let i = 0; i < 6; i++) events = record(adopt(i), i === 0);
    const o = st.s.aiStats.FORESIGHT?.outcomes;
    expect(o?.n).toBe(6);
    expect(o?.hits).toBe(1);
    expect(o?.realizedSum).toBe(1);
    expect(o?.gains.LATE).toEqual({ n: 6, predicted: 24, actual: 4 });
    // 第 6 次后说到做到率 1/6 < 40%：自动降成只显示，计数清零
    expect(events.some((e) => e.type === 'AiModeSet')).toBe(true);
    expect(st.s.aiModes.FORESIGHT?.mode).toBe('SHOW');
    expect(st.s.aiModes.FORESIGHT?.auto).toEqual({ hitRate: 0.17, n: 6 });
    expect(st.s.aiStats.FORESIGHT?.outcomes?.recent).toEqual([]);
    // 带班负责人收到通知；已经发过的不再发
    const plan = planNudges(st.s, statics, st.now);
    const notice = plan.send.find((n) => n.kind === 'NOTICE' && n.topic === 'MODE:FORESIGHT');
    expect(notice?.to).toBe('L1');
    st.ok({ type: 'SendNudges', nudges: plan.send }, 'ai');
    expect(planNudges(st.s, statics, st.now + 3 * 3_600_000).send.some((n) => n.topic === 'MODE:FORESIGHT')).toBe(false);
    // 带班负责人确认原因后改回需确认：通知关闭；之后要再攒 6 次才会再降
    st.ok({ type: 'SetAiMode', module: 'FORESIGHT', mode: 'CONFIRM' }, 'L1');
    expect(st.s.aiModes.FORESIGHT?.auto).toBeUndefined();
    expect(planNudges(st.s, statics, st.now).close.some((c) => st.s.nudges[c.id]?.topic === 'MODE:FORESIGHT')).toBe(true);
    for (let i = 6; i < 11; i++) record(adopt(i), false);
    expect(st.s.aiModes.FORESIGHT?.mode).toBe('CONFIRM');
    record(adopt(11), false);
    expect(st.s.aiModes.FORESIGHT?.mode).toBe('SHOW');
    // 只有 AI 服务可以记效果；同一条只记一次
    const x = adopt(12);
    expect(st.run({ type: 'RecordOutcome', recId: x, outcome: { kind: 'EVENT', metric: 'X', unit: '', predicted: 1, actual: 1, hit: true } }, 'L1').decision.ok).toBe(false);
    record(x, true);
    expect(record(x, true)).toHaveLength(0);
  });

  it('概率预测记 Brier 分数；没采纳的建议记作对照；AI 运行状态写进事件流，暂停的模型会提醒带班负责人', () => {
    const st = new Store();
    const a = st.rec('AVAILABILITY', 'ITEM-A', { action: { kind: 'INFO' }, prediction: { value: 0.2, unit: 'PROBABILITY' } });
    st.ok({ type: 'AcceptRecommendation', recId: a }, 'L1');
    st.ok({ type: 'RecordOutcome', recId: a, outcome: { kind: 'EVENT', metric: 'ON_SHELF', unit: 'PROBABILITY', predicted: 0.2, actual: 0, hit: true } }, 'ai');
    const b = st.rec('AVAILABILITY', 'ITEM-B', { action: { kind: 'INFO' }, prediction: { value: 0.3, unit: 'PROBABILITY' } });
    st.ok({ type: 'DismissRecommendation', recId: b }, 'L1');
    st.ok({ type: 'RecordOutcome', recId: b, outcome: { kind: 'EVENT', metric: 'ON_SHELF', unit: 'PROBABILITY', predicted: 0.3, actual: 1, hit: false } }, 'ai');
    const o = st.s.aiStats.AVAILABILITY?.outcomes;
    expect(o?.n).toBe(1);
    expect(o?.ctrlN).toBe(1);
    expect(o?.brierN).toBe(2);
    expect(o?.brierSum).toBeCloseTo(0.04 + 0.49, 6);
    // 还开着的建议不能记（订单量预测除外）
    const c = st.rec('AVAILABILITY', 'ITEM-C', { action: { kind: 'INFO' } });
    expect(st.run({ type: 'RecordOutcome', recId: c, outcome: { kind: 'EVENT', metric: 'ON_SHELF', unit: 'PROBABILITY', predicted: 0.3, actual: 1, hit: false } }, 'ai').decision.ok).toBe(false);

    // 运行监控：收银流水中断，可售概率暂停
    st.ok({ type: 'PublishAiHealth', health: { at: st.now, models: [{ id: 'shelf-availability', status: 'PAUSED', cause: 'POS_STALE', since: st.now }, { id: 'orders-hourly', status: 'OK', since: st.now }] } }, 'ai');
    expect(st.s.aiHealth?.models.find((m) => m.id === 'shelf-availability')?.status).toBe('PAUSED');
    expect(st.run({ type: 'PublishAiHealth', health: { at: st.now, models: [] } }, 'L1').decision.ok).toBe(false);
    const plan = planNudges(st.s, statics, st.now);
    const n = plan.send.find((x) => x.kind === 'NOTICE' && x.topic === 'HEALTH:shelf-availability');
    expect(n?.to).toBe('L1');
    expect(n?.params?.cause).toBe('POS_STALE');
  });
});
