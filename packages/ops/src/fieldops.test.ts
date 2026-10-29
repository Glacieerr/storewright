import { describe, expect, it } from 'vitest';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateCatalog, generateOrders } from '@storewright/synth';
import type { OpsCommand } from './commands';
import type { AnyOpsEvent } from './events';
import { consumeLots, donateEvent, markdownEvent, applyExpiryEvent, trimLots } from './expiry';
import { activeIncident, INCIDENT_STEPS, lineRecalled, pickBlockedItems, recallTotes, recalledItems } from './fieldops';
import { nextTasksFor } from './nextTask';
import { buildBins, buildPlanogram, execute, orderInfoFrom, type OpsContext } from './server';
import { emptyState, type LiveWalk, type OpsState, type StoreStatic } from './types';

/** 第四批（决策记录 0024）的作业侧：临期批次、召回、突发状况、问答记录、操作提示、下一步 */

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
    // 补货员：R1 会拣货（可以跨岗位），R2 不会
    { id: 'R1', name: 'Restock', role: 'RESTOCK', exceptionAuthorized: false, skills: ['PICK'] },
    { id: 'R2', name: 'Restock 2', role: 'RESTOCK', exceptionAuthorized: false },
  ],
  bins: buildBins(model),
  planogram: buildPlanogram(model, catalog.byId),
  replenish: DEFAULT_REPLENISH_RULES,
};
const ctx: OpsContext = { model, items: catalog.byId, hash: (s) => `h(${s})`, statics };
const T0 = new Date(2026, 9, 20, 15, 0).getTime();
const MIN = 60_000;
const orders = generateOrders(model, catalog, DEFAULT_DEMAND.medium, { seed: 11 });

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
  code(cmd: OpsCommand, actor = 'console'): string | undefined {
    const d = this.run(cmd, actor).decision;
    return d.ok ? undefined : d.reject.code;
  }
  walks(n = 6): LiveWalk[] {
    for (let i = 0; i < n; i++) {
      const o = orders[i];
      if (!o) throw new Error('no order');
      const info = orderInfoFrom({ ...o, id: `O${i}`, shortCode: `S${i}` }, catalog.byId, this.now + 60 * MIN, rules.slotLengthMin);
      this.ok({ type: 'CreateOrder', order: info, codeHash: 'x' });
      this.ok({ type: 'LockOrder', orderId: info.id });
    }
    this.ok({ type: 'ReleaseWalks' });
    return Object.values(this.s.walks);
  }
}

const at = (e: { type: string; payload: unknown }, t = T0) => ({ ...e, at: t, actor: 'L1', seq: 1 }) as unknown as AnyOpsEvent;

describe('临期批次（决策记录 0024 · C4）', () => {
  it('卖出按到期先后扣（没有保质期的最后）；数货架少了从最早的扣；降价只升不降；捐赠拿下整批并扣货架存量', () => {
    const s = emptyState();
    s.shelfLots = {
      I1: [
        { lot: 'B', expiry: '2026-10-25', units: 10, at: 2 },
        { lot: 'A', expiry: '2026-10-22', units: 5, at: 1 },
        { lot: 'C', units: 3, at: 0 },
      ],
    };
    s.shelf.I1 = { est: 18, conf: 1, source: 'SCAN', at: 0, velocity: 1 };
    consumeLots(s, 'I1', 7);
    expect(s.shelfLots.I1?.map((l) => [l.lot, l.units])).toEqual([
      ['B', 8],
      ['C', 3],
    ]);
    // 记录 11 件，数出来 6 件：从最早到期的扣 5 件
    trimLots(s, 'I1', 6);
    expect(s.shelfLots.I1?.map((l) => [l.lot, l.units])).toEqual([
      ['B', 3],
      ['C', 3],
    ]);
    // 数出来比记录多：不动
    trimLots(s, 'I1', 50);
    expect(s.shelfLots.I1?.reduce((a, l) => a + l.units, 0)).toBe(6);
    const md = markdownEvent(s, 'I1', 'B', 0.3);
    expect(md?.type).toBe('MarkdownApplied');
    if (md) applyExpiryEvent(s, at(md));
    expect(s.markdowns?.['I1|B']?.pct).toBe(0.3);
    expect(markdownEvent(s, 'I1', 'B', 0.2)).toBeUndefined();
    expect(markdownEvent(s, 'I1', 'B', 1)).toBeUndefined();
    expect(markdownEvent(s, 'I1', 'A', 0.4)).toBeUndefined();
    const dn = donateEvent(s, 'I1', 'B');
    expect(dn?.payload).toMatchObject({ lot: 'B', units: 3 });
    if (dn) applyExpiryEvent(s, at(dn));
    expect(s.shelfLots.I1?.map((l) => l.lot)).toEqual(['C']);
    expect(s.shelf.I1?.est).toBe(15);
    expect(s.donated).toBe(3);
    expect(donateEvent(s, 'I1', 'B')).toBeUndefined();
  });
});

describe('召回（决策记录 0024 · C5）', () => {
  it('只有带班负责人能开启；开启后正在拣的批次不能再拣这件商品；下架打勾后存量清零；关闭后恢复', () => {
    const st = new Store();
    const w = st.walks().find((x) => x.tempZone === 'AMBIENT') as LiveWalk;
    st.ok({ type: 'ClaimWalk', walkId: w.id }, 'P1');
    for (const id of w.toteIds) st.ok({ type: 'BindLabel', walkId: w.id, labelId: st.s.totes[id]?.labelId as string }, 'P1');
    const p = w.stops[0]?.picks[0];
    if (!p) throw new Error('no pick');
    const orderId = st.s.totes[p.toteId]?.orderId as string;
    const itemId = st.s.orders[orderId]?.lines.find((l) => l.lineId === p.lineId)?.itemId as string;
    const open: OpsCommand = { type: 'OpenRecall', title: 'Test recall', itemIds: [itemId, 'NOPE'], lots: [' lot1 '], reason: 'UNDECLARED_ALLERGEN' };
    expect(st.code(open, 'P1')).toBe('NOT_AUTHORIZED');
    expect(st.code({ ...open, itemIds: ['NOPE'] } as OpsCommand, 'L1')).toBe('ITEM_NOT_FOUND');
    st.ok(open, 'L1');
    const rc = Object.values(st.s.recalls ?? {})[0];
    if (!rc) throw new Error('no recall');
    expect(rc.itemIds).toEqual([itemId]);
    expect(rc.lots).toEqual(['LOT1']);
    expect(rc.affected.totes).toContain(p.toteId);
    expect(rc.affected.openOrders).toContain(orderId);
    expect(recalledItems(st.s).has(itemId)).toBe(true);
    expect(st.code({ type: 'PickItem', walkId: w.id, toteId: p.toteId, lineId: p.lineId, qty: p.qty }, 'P1')).toBe('ITEM_RECALLED');
    // 开启时已经做了的步骤直接打勾：后仓的箱子转待检；没有已经取走的顾客（决策记录 0026）
    expect(Object.keys(rc.steps).sort()).toEqual(['BACKROOM', 'CUSTOMERS']);
    expect(rc.steps.BACKROOM?.auto).toBe(true);
    // 货架下架谁都可以打勾；只召回 LOT1、货架上没有批次记录：不知道拿走了几件，存量不清零、把握降低
    st.ok({ type: 'MarkRecallStep', recallId: rc.id, step: 'SHELF', done: true }, 'P1');
    expect(st.s.shelf[itemId]?.est).toBeGreaterThan(0);
    expect(st.s.shelf[itemId]?.conf).toBeLessThanOrEqual(0.3);
    expect(st.s.recalls?.[rc.id]?.steps.SHELF?.by).toBe('P1');
    // 只召回部分批号：货架下架之后剩下的是别的批号，可以照常拣；下架之前拣的才算召回的
    expect(pickBlockedItems(st.s).has(itemId)).toBe(false);
    st.ok({ type: 'PickItem', walkId: w.id, toteId: p.toteId, lineId: p.lineId, qty: p.qty }, 'P1');
    expect(lineRecalled(st.s, itemId, st.s.orders[orderId]?.lineResults[p.lineId]?.pickedAt)).toBe(false);
    expect(lineRecalled(st.s, itemId, st.s.recalls?.[rc.id]?.steps.SHELF?.at ? (st.s.recalls[rc.id]!.steps.SHELF!.at - 1) : 0)).toBe(true);
    expect(st.code({ type: 'MarkRecallStep', recallId: rc.id, step: 'CUSTOMERS', done: true }, 'P1')).toBe('NOT_AUTHORIZED');
    expect(st.code({ type: 'CloseRecall', recallId: rc.id }, 'P1')).toBe('NOT_AUTHORIZED');
    // 五步都做完才能关
    expect(st.code({ type: 'CloseRecall', recallId: rc.id }, 'L1')).toBe('RECALL_STEPS_OPEN');
    st.ok({ type: 'MarkRecallStep', recallId: rc.id, step: 'STAGED', done: true }, 'P1');
    st.ok({ type: 'MarkRecallStep', recallId: rc.id, step: 'ORDERS', done: true }, 'L1');
    st.ok({ type: 'CloseRecall', recallId: rc.id }, 'L1');
    expect(st.code({ type: 'MarkRecallStep', recallId: rc.id, step: 'BACKROOM', done: true }, 'L1')).toBe('RECALL_CLOSED');
    expect(st.code({ type: 'MarkRecallStep', recallId: 'RC999', step: 'BACKROOM', done: true }, 'L1')).toBe('RECALL_NOT_FOUND');
    expect(recalledItems(st.s).has(itemId)).toBe(false);
  });

  it('只召回部分批号、货架上没有批次记录：下架打勾时请补货员数一下剩下的，数完货架估算按数到的算（决策记录 0026）', () => {
    const st = new Store();
    const itemId = statics.planogram[0]?.itemId as string;
    st.ok({ type: 'OpenRecall', title: 'Lot recall', itemIds: [itemId], lots: ['L9'] }, 'L1');
    const rc = Object.values(st.s.recalls ?? {})[0];
    if (!rc) throw new Error('no recall');
    const out = st.ok({ type: 'MarkRecallStep', recallId: rc.id, step: 'SHELF', done: true }, 'P1');
    expect(out.map((e) => e.type)).toEqual(['RecallStepMarked', 'ShelfCheckRequested']);
    const check = Object.values(st.s.checks).find((c) => c.itemId === itemId && c.reason === 'RECALL');
    expect(check).toMatchObject({ status: 'OPEN', locationId: statics.planogram[0]?.locationId });
    expect(st.s.shelf[itemId]?.conf).toBeLessThanOrEqual(0.3);
    st.ok({ type: 'ConfirmShelf', itemId, units: 7, checkId: check?.id as string }, 'P1');
    expect(st.s.shelf[itemId]).toMatchObject({ est: 7, conf: 1 });
    expect(st.s.checks[check?.id as string]?.status).toBe('DONE');
    // 再打一次勾（取消再勾）不会重复派任务；整个商品召回不派（货架清零就是对的）
    st.ok({ type: 'MarkRecallStep', recallId: rc.id, step: 'SHELF', done: false }, 'P1');
    st.ok({ type: 'OpenRecall', title: 'Whole', itemIds: [statics.planogram[1]?.itemId as string] }, 'L1');
    const whole = Object.values(st.s.recalls ?? {}).find((r) => r.title === 'Whole');
    expect(st.ok({ type: 'MarkRecallStep', recallId: whole?.id as string, step: 'SHELF', done: true }, 'P1').map((e) => e.type)).toEqual(['RecallStepMarked']);
  });

  it('整个商品召回：下架后货架存量清零，关闭之前一直不能拣；召回卡片列出受影响的框（决策记录 0026）', () => {
    const st = new Store();
    const w = st.walks().find((x) => x.tempZone === 'AMBIENT') as LiveWalk;
    st.ok({ type: 'ClaimWalk', walkId: w.id }, 'P1');
    const [first, second] = w.stops.flatMap((x) => x.picks);
    if (!first) throw new Error('no pick');
    const orderId = st.s.totes[first.toteId]?.orderId as string;
    const itemId = st.s.orders[orderId]?.lines.find((l) => l.lineId === first.lineId)?.itemId as string;
    st.ok({ type: 'PickItem', walkId: w.id, toteId: first.toteId, lineId: first.lineId, qty: first.qty }, 'P1');
    st.ok({ type: 'OpenRecall', title: 'Whole item', itemIds: [itemId] }, 'L1');
    const rc = Object.values(st.s.recalls ?? {})[0]!;
    expect(recallTotes(st.s, rc).map((x) => x.toteId)).toContain(first.toteId);
    st.ok({ type: 'MarkRecallStep', recallId: rc.id, step: 'SHELF', done: true }, 'P1');
    expect(st.s.shelf[itemId]?.est).toBe(0);
    expect(pickBlockedItems(st.s).has(itemId)).toBe(true);
    if (second && st.s.orders[st.s.totes[second.toteId]?.orderId ?? '']?.lines.find((l) => l.lineId === second.lineId)?.itemId === itemId) expect(st.code({ type: 'PickItem', walkId: w.id, toteId: second.toteId, lineId: second.lineId, qty: second.qty }, 'P1')).toBe('ITEM_RECALLED');
    expect(lineRecalled(st.s, itemId, Date.now() + 86_400_000)).toBe(true);
  });
});

describe('突发状况（决策记录 0024 · E4）', () => {
  it('同时只能有一个；清单按步骤打勾、记下是谁；只有带班负责人能结束；结束后可以开新的', () => {
    const st = new Store();
    expect(st.code({ type: 'StartIncident', kind: 'POWER' }, 'P1')).toBe('NOT_AUTHORIZED');
    st.ok({ type: 'StartIncident', kind: 'POWER' }, 'L1');
    const x = activeIncident(st.s);
    if (!x) throw new Error('no incident');
    expect(st.code({ type: 'StartIncident', kind: 'STORM' }, 'L1')).toBe('INCIDENT_ACTIVE');
    const step = INCIDENT_STEPS.POWER.find((p) => p.role === 'PICK')?.id as string;
    st.ok({ type: 'CheckIncidentStep', incidentId: x.id, stepId: step }, 'P1');
    expect(st.s.incidents?.[x.id]?.checked[step]?.by).toBe('P1');
    // 再打一次不重复记
    expect(st.ok({ type: 'CheckIncidentStep', incidentId: x.id, stepId: step }, 'L1')).toHaveLength(0);
    expect(st.code({ type: 'CheckIncidentStep', incidentId: x.id, stepId: 'NOT_A_STEP' }, 'P1')).toBe('INCIDENT_NOT_FOUND');
    expect(st.code({ type: 'EndIncident', incidentId: x.id }, 'P1')).toBe('NOT_AUTHORIZED');
    st.ok({ type: 'EndIncident', incidentId: x.id }, 'L1');
    expect(activeIncident(st.s)).toBeUndefined();
    expect(st.code({ type: 'CheckIncidentStep', incidentId: x.id, stepId: step }, 'P1')).toBe('INCIDENT_NOT_FOUND');
    st.ok({ type: 'StartIncident', kind: 'STORM' }, 'L1');
    expect(activeIncident(st.s)?.kind).toBe('STORM');
  });
});

describe('问答记录与操作提示（决策记录 0024 · F2、D4）', () => {
  it('问答只由 AI 服务写；提问的人或带班负责人标有用 / 没用，改主意时统计跟着改；看过操作提示记一次，测验分数不超过题数', () => {
    const st = new Store();
    const log: OpsCommand = { type: 'LogAnswer', answerId: 'Q1', question: 'how many late?', tools: ['store_status'], source: 'TEMPLATE', by: 'P1' };
    expect(st.code(log, 'P1')).toBe('NOT_AUTHORIZED');
    st.ok(log, 'ai');
    expect(st.code({ type: 'RateAnswer', answerId: 'Q1', helpful: true }, 'R1')).toBe('NOT_YOURS');
    expect(st.code({ type: 'RateAnswer', answerId: 'Q9', helpful: true }, 'P1')).toBe('ANSWER_NOT_FOUND');
    st.ok({ type: 'RateAnswer', answerId: 'Q1', helpful: true }, 'P1');
    expect(st.s.answerStats).toEqual({ answered: 1, helpful: 1, unhelpful: 0 });
    st.ok({ type: 'RateAnswer', answerId: 'Q1', helpful: false }, 'L1');
    expect(st.s.answerStats).toEqual({ answered: 1, helpful: 0, unhelpful: 1 });
    expect(st.code({ type: 'AckSop', sopId: 'Bad Id!' }, 'P1')).toBe('INVALID_ORDER');
    st.ok({ type: 'AckSop', sopId: 'cold-chain', correct: 5, total: 2 }, 'P1');
    expect(st.s.sopAcks?.P1?.['cold-chain']).toMatchObject({ correct: 2, total: 2 });
  });
});

describe('涉及人、钱、顾客的动作始终要人确认（15 号文档第 9 节）', () => {
  it('模块设成自动执行时，调人的建议仍按「需确认」发、不自动执行；带班负责人采纳后才调', () => {
    const st = new Store();
    st.ok({ type: 'SetAiMode', module: 'STAFFING', mode: 'AUTO' }, 'L1');
    const draft = { module: 'STAFFING' as const, target: 'P1', action: { kind: 'MOVE_ASSOCIATE', params: { associateId: 'P1', from: 'PICK', to: 'STAGE', hours: 1 } }, confidence: 0.8, reasons: [], alternatives: [], model: { id: 'm', version: 1, kind: 'k' }, expiresAt: st.now + 30 * MIN };
    st.ok({ type: 'IssueRecommendation', draft }, 'ai');
    const rec = Object.values(st.s.recs).find((r) => r.target === 'P1');
    expect(rec).toMatchObject({ status: 'OPEN', mode: 'CONFIRM' });
    expect(st.s.roles.P1).toBeUndefined();
    st.ok({ type: 'AcceptRecommendation', recId: rec?.id as string }, 'L1');
    expect(st.s.roles.P1).toBe('STAGE');
  });
});

describe('下一步（决策记录 0024 · D3）', () => {
  it('拣货员排自己岗位可领取的批次；会拣货的补货员也能排到但标为跨岗位、分数打折；不会的不排；带班负责人不排；领了批次后不再排', () => {
    const st = new Store();
    st.walks();
    const mine = nextTasksFor(st.s, statics, 'P1', st.now);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThanOrEqual(3);
    for (const t of mine) {
      expect(t.kind).toBe('WALK');
      expect(t.crossRole).toBe(false);
      expect(t.why).toContain('YOUR_ROLE');
    }
    // 分数从高到低
    expect(mine.map((t) => t.score)).toEqual([...mine.map((t) => t.score)].sort((a, b) => b - a));
    const cross = nextTasksFor(st.s, statics, 'R1', st.now);
    expect(cross.length).toBeGreaterThan(0);
    for (const t of cross) {
      expect(t.crossRole).toBe(true);
      const same = mine.find((m) => m.ref === t.ref);
      if (same) expect(t.score).toBeCloseTo(same.score * 0.6, 1);
    }
    expect(nextTasksFor(st.s, statics, 'R2', st.now)).toHaveLength(0);
    expect(nextTasksFor(st.s, statics, 'L1', st.now)).toHaveLength(0);
    expect(st.code({ type: 'NextTaskFeedback', kind: 'NAP', ref: 'x', taken: true }, 'P1')).toBe('INVALID_ORDER');
    st.ok({ type: 'NextTaskFeedback', kind: 'WALK', ref: mine[0]?.ref as string, taken: true }, 'P1');
    expect(st.s.nextTaskStats?.WALK).toEqual({ taken: 1, skipped: 0 });
    st.ok({ type: 'ClaimWalk', walkId: mine[0]?.ref as string }, 'P1');
    expect(nextTasksFor(st.s, statics, 'P1', st.now)).toHaveLength(0);
    // 已经被领走的批次不再出现在别人的列表里
    expect(nextTasksFor(st.s, statics, 'R1', st.now).some((t) => t.ref === mine[0]?.ref)).toBe(false);
  });
});
