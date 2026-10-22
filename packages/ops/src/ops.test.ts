import { beforeEach, describe, expect, it } from 'vitest';
import type { Order } from '@storewright/domain';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateCatalog, generateOrders } from '@storewright/synth';
import { applyEvent, replay } from './apply';
import type { OpsCommand } from './commands';
import type { AnyOpsEvent } from './events';
import { resolveScan } from './scan';
import { buildBins, buildPlanogram, execute, orderInfoFrom, type OpsContext } from './server';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import { emptyState, type OpsState, type StoreStatic } from './types';
import { codeHashInput, handoffBoard, openWalks, orderShortages, pickRows, stagingOccupancy, suggestSlots } from './views';

const model = new StoreModel(createTemplate('medium'));
const catalog = generateCatalog(model, { seed: 7 });
const hash = (s: string) => `h(${s})`;
const rules = model.config.rules;
export const statics: StoreStatic = {
  storeId: 'S1',
  name: 'Test',
  rules: { approachingMin: rules.handoff.approachingMin, longWaitMin: rules.handoff.longWaitMin, codeAttempts: rules.handoff.codeAttempts, occupancyAlert: rules.staging.occupancyAlert, slotLengthMin: rules.slotLengthMin, lockLeadMin: rules.lockLeadMin },
  slots: model.stagingSlots.map((s) => ({ code: s.code, tempZone: s.tempZone, capacity: s.capacityTotes, area: s.area, purpose: s.purpose })),
  roster: [
    { id: 'A1', name: 'Picker', role: 'PICK', exceptionAuthorized: false },
    { id: 'X1', name: 'Backroom', role: 'BACKROOM', exceptionAuthorized: true },
  ],
  bins: buildBins(model),
  planogram: buildPlanogram(model, catalog.byId),
  replenish: DEFAULT_REPLENISH_RULES,
};
const ctx: OpsContext = { model, items: catalog.byId, hash, statics };

/** 合成订单里不含大件（Phase 3 不处理先扫后打）的订单 */
const pool: Order[] = generateOrders(model, catalog, DEFAULT_DEMAND.medium, { seed: 3 }).filter((o) =>
  o.fulfillmentType === 'GROCERY' && o.lines.every((l) => !catalog.byId.get(l.itemId)?.handling.some((h) => h === 'OVERSIZED' || h === 'TEAM_LIFT')),
);
const T0 = Date.UTC(2026, 9, 20, 14, 0, 0);
const MIN = 60_000;

function pickOrder(pred: (o: Order) => boolean, skip = 0): Order {
  const list = pool.filter(pred);
  const o = list[skip];
  if (!o) throw new Error('no order');
  return o;
}

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
  create(o: Order, slotOffsetMin = 150, code = 'K7Q2') {
    const info = orderInfoFrom(o, catalog.byId, this.now + slotOffsetMin * MIN, rules.slotLengthMin);
    this.ok({ type: 'CreateOrder', order: info, codeHash: hash(codeHashInput(info.id, code)) });
    return info;
  }
  /** 领取并拣完一个批次（每行全部拣到） */
  pickWalk(walkId: string, who: string) {
    this.ok({ type: 'ClaimWalk', walkId }, who);
    const w = this.s.walks[walkId];
    if (!w) throw new Error('walk');
    for (const id of w.toteIds) {
      const labelId = this.s.totes[id]?.labelId;
      if (labelId && this.s.orders[this.s.totes[id]?.orderId ?? '']?.status !== 'CANCELLED') this.ok({ type: 'BindLabel', walkId, labelId }, who);
    }
    for (const r of pickRows(this.s, w)) if (!r.cancelled) this.ok({ type: 'PickItem', walkId, toteId: r.toteId, lineId: r.lineId, qty: r.qty - r.done }, who);
    this.ok({ type: 'CompleteWalk', walkId }, who);
  }
  /** 把订单的所有框放进建议格位 */
  stageOrder(orderId: string, who: string) {
    const o = this.s.orders[orderId];
    if (!o) throw new Error('order');
    for (const id of o.toteIds) {
      const slot = suggestSlots(this.s, statics, id)[0];
      if (!slot) throw new Error('no slot');
      this.ok({ type: 'StageTote', labelId: this.s.totes[id]?.labelId ?? '', slotCode: slot }, who);
    }
  }
  walksOf(orderId: string): string[] {
    const o = this.s.orders[orderId];
    return [...new Set((o?.toteIds ?? []).map((id) => this.s.totes[id]?.walkId).filter((x): x is string => !!x))];
  }
}

describe('一张自取订单的全链路', () => {
  let st: Store;
  beforeEach(() => {
    st = new Store();
  });

  it('下单 → 锁单 → 批次与标签 → 拣货 → 暂存 → 签到 → 准备（加锁）→ 核验 → 交付', () => {
    const o = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.length >= 3));
    expect(st.s.orders[o.id]?.status).toBe('CREATED');
    // 锁单：分框
    st.ok({ type: 'LockOrder', orderId: o.id });
    const order = st.s.orders[o.id];
    expect(order?.status).toBe('LOCKED');
    expect(order?.toteIds.length).toBeGreaterThan(0);
    // 生成批次：每个框都有标签，二维码只含不透明 ID
    st.ok({ type: 'ReleaseWalks' });
    for (const id of order?.toteIds ?? []) {
      const t = st.s.totes[id];
      expect(t?.status).toBe('IN_WALK');
      expect(t?.labelId).toMatch(/^SW1:[A-Z2-9]{9}$/);
      expect(t?.labelId).not.toContain(o.lastName.toUpperCase());
    }
    // 拣货：一车一温区，按路线顺序
    const walks = st.walksOf(o.id);
    for (const w of walks) {
      const walk = st.s.walks[w];
      expect(new Set(walk?.toteIds.map((id) => st.s.totes[id]?.tempZone)).size).toBe(1);
      st.pickWalk(w, 'A1');
    }
    expect(Object.values(order?.lineResults ?? {}).reduce((n, r) => n + r.picked, 0)).toBe(o.lines.reduce((n, l) => n + l.qty, 0));
    // 暂存
    st.stageOrder(o.id, 'A2');
    expect(order?.status).toBe('STAGED');
    expect(stagingOccupancy(st.s, statics).reduce((n, z) => n + z.used, 0)).toBe(order?.toteIds.length);
    // 顾客在路上 → 黄色；到达 → 蓝色
    st.ok({ type: 'UpdateEta', orderId: o.id, etaAt: st.now + 4 * MIN }, 'customer');
    expect(handoffBoard(st.s, statics, st.now)[0]?.color).toBe('YELLOW');
    st.now += 4 * MIN;
    st.ok({ type: 'CheckIn', orderId: o.id, bay: '3' }, 'customer');
    expect(handoffBoard(st.s, statics, st.now)[0]).toMatchObject({ color: 'BLUE', bay: '3' });
    // 扫描任意一个框开始准备并加锁；第二个员工只能加入协助
    st.ok({ type: 'StartPrep', key: o.id }, 'A3');
    expect(st.code({ type: 'StartPrep', key: o.id }, 'A4')).toBe('PREP_LOCKED');
    st.ok({ type: 'JoinPrep', key: o.id }, 'A4');
    const totes = order?.toteIds ?? [];
    totes.forEach((id, i) => st.ok({ type: 'ScanPrepTote', key: o.id, labelId: st.s.totes[id]?.labelId ?? '' }, i % 2 ? 'A4' : 'A3'));
    expect(st.s.sessions[o.id]?.status).toBe('READY');
    expect(Object.keys(st.s.slots)).toHaveLength(0);
    // 核验验证码
    st.ok({ type: 'VerifyCode', key: o.id, code: 'WRONG' }, 'A3');
    expect(st.s.sessions[o.id]?.codeFailures).toBe(1);
    st.ok({ type: 'VerifyCode', key: o.id, code: 'k7q2' }, 'A3');
    expect(st.s.sessions[o.id]?.verified).toBe('CODE');
    st.now += 2 * MIN;
    const done = st.ok({ type: 'CompleteHandoff', key: o.id, removeAgeItems: true }, 'A3');
    expect(done.find((e) => e.type === 'OrderHandedOff')?.payload).toMatchObject({ orderId: o.id, waitSec: 120 });
    expect(order?.status).toBe('COMPLETED');
    expect(handoffBoard(st.s, statics, st.now)).toHaveLength(0);
    // 重放事件流得到同样的状态
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
  });

  it('同一个批次只能被一人领取；一人同时只能做一个批次', () => {
    st.create(pickOrder((x) => x.type === 'PICKUP', 0), rules.lockLeadMin - 10);
    st.create(pickOrder((x) => x.type === 'PICKUP', 1), rules.lockLeadMin - 10);
    st.ok({ type: 'Tick', release: true });
    const [w1, w2] = openWalks(st.s);
    expect(w1 && w2).toBeTruthy();
    st.ok({ type: 'ClaimWalk', walkId: w1?.id ?? '' }, 'A1');
    expect(st.code({ type: 'ClaimWalk', walkId: w1?.id ?? '' }, 'A2')).toBe('WALK_CLAIMED');
    expect(st.code({ type: 'ClaimWalk', walkId: w2?.id ?? '' }, 'A1')).toBe('ASSOCIATE_BUSY');
    // 不是自己的批次不能拣
    const r = pickRows(st.s, st.s.walks[w1?.id ?? ''] as never)[0];
    expect(st.code({ type: 'PickItem', walkId: w1?.id ?? '', toteId: r?.toteId ?? '', lineId: r?.lineId ?? '', qty: 1 }, 'A2')).toBe('WALK_NOT_YOURS');
    // 没有扫描绑定框不能拣进去
    expect(st.code({ type: 'PickItem', walkId: w1?.id ?? '', toteId: r?.toteId ?? '', lineId: r?.lineId ?? '', qty: 1 }, 'A1')).toBe('TOTE_NOT_BOUND');
    // 没拣完不能结束
    expect(st.code({ type: 'CompleteWalk', walkId: w1?.id ?? '' }, 'A1')).toBe('WALK_UNFINISHED');
    // 还没开始拣可以放弃
    st.ok({ type: 'UnclaimWalk', walkId: w1?.id ?? '' }, 'A1');
    st.ok({ type: 'ClaimWalk', walkId: w1?.id ?? '' }, 'A2');
  });
});

describe('排程', () => {
  it('到锁单时间才锁单；生成批次时冷藏 / 冷冻批次带冷链时限', () => {
    const st = new Store();
    const later = st.create(pickOrder((x) => x.type === 'PICKUP', 2), rules.lockLeadMin + 30);
    const soon = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.some((l) => catalog.byId.get(l.itemId)?.tempZone === 'FROZEN'), 0), rules.lockLeadMin - 5);
    st.ok({ type: 'Tick', release: false });
    expect(st.s.orders[soon.id]?.status).toBe('LOCKED');
    expect(st.s.orders[later.id]?.status).toBe('CREATED');
    expect(Object.keys(st.s.walks)).toHaveLength(0);
    st.ok({ type: 'Tick', release: true });
    const walks = Object.values(st.s.walks);
    expect(walks.length).toBeGreaterThan(0);
    for (const w of walks) {
      if (w.tempZone === 'CHILLED' || w.tempZone === 'FROZEN') expect(w.coldLimitSec).toBeGreaterThan(0);
      else expect(w.coldLimitSec).toBeUndefined();
    }
    // 没有可以生成的批次
    expect(st.code({ type: 'ReleaseWalks' })).toBe('NOTHING_TO_RELEASE');
    // 冷链计时从第一件冷藏 / 冷冻商品开始，超时提醒一次
    const cold = walks.find((w) => w.tempZone === 'FROZEN') ?? walks.find((w) => w.coldLimitSec);
    if (!cold) throw new Error('no cold walk');
    st.ok({ type: 'ClaimWalk', walkId: cold.id }, 'A1');
    const r = pickRows(st.s, cold)[0];
    st.ok({ type: 'BindLabel', walkId: cold.id, labelId: st.s.totes[r?.toteId ?? '']?.labelId ?? '' }, 'A1');
    st.ok({ type: 'PickItem', walkId: cold.id, toteId: r?.toteId ?? '', lineId: r?.lineId ?? '', qty: 1 }, 'A1');
    expect(st.s.walks[cold.id]?.coldStartedAt).toBe(st.now);
    st.now += ((cold.coldLimitSec ?? 0) + 60) * 1000;
    const alerts = st.ok({ type: 'Tick', release: false }).filter((e) => e.type === 'ColdChainAlert');
    expect(alerts).toHaveLength(1);
    expect(st.ok({ type: 'Tick', release: false }).filter((e) => e.type === 'ColdChainAlert')).toHaveLength(0);
  });
});

describe('缺货、替代与取消', () => {
  it('不允许替代的行不能替代；替代与缺货在交付时列出；转后仓补取生成待办', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.length >= 3 && x.lines.some((l) => l.allowSubstitution) && x.lines.some((l) => !l.allowSubstitution)));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    // 后仓里放一箱不允许替代的商品，转后仓补取才会被接受
    const noSub = o.lines.filter((l) => !l.allowSubstitution);
    st.ok({ type: 'LoadInventory', cases: noSub.map((l, i) => ({ caseId: `C-261020-${String(i + 1).padStart(6, '0')}`, itemId: l.itemId, gtin: l.gtin, name: l.name, packQty: 12, units: 12, binCode: 'QA-AMB' })) }, 'system');
    const order = st.s.orders[o.id];
    let sub = false;
    let ex = false;
    for (const wid of st.walksOf(o.id)) {
      st.ok({ type: 'ClaimWalk', walkId: wid }, 'A1');
      const w = st.s.walks[wid];
      if (!w) continue;
      for (const id of w.toteIds) st.ok({ type: 'BindLabel', walkId: wid, labelId: st.s.totes[id]?.labelId ?? '' }, 'A1');
      for (const r of pickRows(st.s, w)) {
        const base = { walkId: wid, toteId: r.toteId, lineId: r.lineId, qty: r.qty };
        if (!r.allowSubstitution) {
          expect(st.code({ type: 'ReportNotFound', ...base, resolution: 'SUBSTITUTED', substitute: { name: 'X', gtin: '0' } }, 'A1')).toBe('SUBSTITUTION_NOT_ALLOWED');
          if (!ex) {
            st.ok({ type: 'ReportNotFound', ...base, resolution: 'EXCEPTION' }, 'A1');
            ex = true;
            continue;
          }
        } else if (!sub) {
          expect(st.code({ type: 'ReportNotFound', ...base, resolution: 'SUBSTITUTED' }, 'A1')).toBe('SUBSTITUTE_REQUIRED');
          st.ok({ type: 'ReportNotFound', ...base, resolution: 'SUBSTITUTED', substitute: { name: 'Similar brand', gtin: '012345678905' } }, 'A1');
          sub = true;
          continue;
        }
        expect(st.code({ type: 'PickItem', ...base, qty: r.qty + 1 }, 'A1')).toBe('QTY_INVALID');
        st.ok({ type: 'PickItem', ...base }, 'A1');
      }
      st.ok({ type: 'CompleteWalk', walkId: wid }, 'A1');
    }
    expect(sub && ex).toBe(true);
    const shortages = orderShortages(order as never);
    expect(shortages.some((x) => x.substituteName === 'Similar brand')).toBe(true);
    expect(shortages.some((x) => x.short > 0)).toBe(true);
    expect(Object.values(st.s.exceptions)).toHaveLength(1);
  });

  it('拣货前取消：标签作废；拣货后取消：暂存扫描时提示放回收专区', () => {
    const st = new Store();
    const a = st.create(pickOrder((x) => x.type === 'PICKUP', 3));
    const b = st.create(pickOrder((x) => x.type === 'PICKUP', 4));
    st.ok({ type: 'LockOrder', orderId: a.id });
    st.ok({ type: 'LockOrder', orderId: b.id });
    st.ok({ type: 'ReleaseWalks' });
    // a：拣货前取消
    const cancelA = st.ok({ type: 'CancelOrder', orderId: a.id, reason: 'customer' });
    expect(cancelA.filter((e) => e.type === 'LabelVoided')).toHaveLength(st.s.orders[a.id]?.toteIds.length ?? -1);
    const voided = st.s.totes[st.s.orders[a.id]?.toteIds[0] ?? '']?.labelId ?? '';
    expect(resolveScan(st.s, statics, voided)).toMatchObject({ kind: 'label', voided: true });
    // b：拣完后取消
    for (const w of st.walksOf(b.id)) if (st.s.walks[w]?.status === 'OPEN') st.pickWalk(w, 'A1');
    for (const w of st.walksOf(a.id)) if (st.s.walks[w]?.status === 'OPEN') st.pickWalk(w, 'A1');
    st.ok({ type: 'CancelOrder', orderId: b.id, reason: 'customer' });
    const tote = st.s.totes[st.s.orders[b.id]?.toteIds[0] ?? ''];
    const events = st.ok({ type: 'StageTote', labelId: tote?.labelId ?? '', slotCode: statics.slots[0]?.code ?? '' }, 'A2');
    expect(events.map((e) => e.type)).toEqual(['CancelledOrderDetected', 'ToteSentToRecovery']);
    expect(tote?.status).toBe('RECOVERY');
  });
});

describe('暂存规则', () => {
  it('温区必须一致、格位满了不能再放、移动格位', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.some((l) => catalog.byId.get(l.itemId)?.tempZone === 'AMBIENT'), 5));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of st.walksOf(o.id)) st.pickWalk(w, 'A1');
    const tote = Object.values(st.s.totes).find((t) => t.orderId === o.id && t.tempZone === 'AMBIENT');
    if (!tote?.labelId) throw new Error('tote');
    const wrong = statics.slots.find((x) => x.tempZone !== 'AMBIENT');
    const amb = statics.slots.filter((x) => x.tempZone === 'AMBIENT');
    expect(st.code({ type: 'StageTote', labelId: tote.labelId, slotCode: wrong?.code ?? '' }, 'A2')).toBe('SLOT_ZONE_MISMATCH');
    expect(st.code({ type: 'StageTote', labelId: tote.labelId, slotCode: 'NOPE-1' }, 'A2')).toBe('SLOT_NOT_FOUND');
    st.ok({ type: 'StageTote', labelId: tote.labelId, slotCode: amb[0]?.code ?? '' }, 'A2');
    expect(st.code({ type: 'StageTote', labelId: tote.labelId, slotCode: amb[0]?.code ?? '' }, 'A2')).toBe('SAME_SLOT');
    st.ok({ type: 'StageTote', labelId: tote.labelId, slotCode: amb[1]?.code ?? '' }, 'A2');
    expect(tote.slotCode).toBe(amb[1]?.code);
    expect(st.s.slots[amb[0]?.code ?? '']).toBeUndefined();
    // 填满一个格位
    const target = amb[2];
    if (!target) throw new Error('slot');
    st.s.slots[target.code] = Array.from({ length: target.capacity }, (_, i) => `X${i}`);
    expect(st.code({ type: 'StageTote', labelId: tote.labelId, slotCode: target.code }, 'A2')).toBe('SLOT_FULL');
  });
});

describe('交付看板与核验', () => {
  it('已到达按到达先后排在前面，等待过久变红；未到达按时段排列', () => {
    const st = new Store();
    const a = st.create(pickOrder((x) => x.type === 'PICKUP', 6), 150);
    const b = st.create(pickOrder((x) => x.type === 'PICKUP', 7), 120);
    const c = st.create(pickOrder((x) => x.type === 'PICKUP', 8), 100);
    for (const o of [a, b, c]) st.ok({ type: 'LockOrder', orderId: o.id });
    let rows = handoffBoard(st.s, statics, st.now);
    expect(rows.map((r) => r.key)).toEqual([c.id, b.id, a.id]);
    st.ok({ type: 'CheckIn', orderId: a.id }, 'customer');
    st.now += MIN;
    st.ok({ type: 'CheckIn', orderId: b.id }, 'customer');
    rows = handoffBoard(st.s, statics, st.now);
    expect(rows.map((r) => r.key)).toEqual([a.id, b.id, c.id]);
    expect(rows.map((r) => r.color)).toEqual(['BLUE', 'BLUE', 'GREY']);
    st.now += rules.handoff.longWaitMin * MIN;
    rows = handoffBoard(st.s, statics, st.now);
    expect(rows[0]?.color).toBe('RED');
    expect(rows[0]?.waitSec).toBe((rules.handoff.longWaitMin + 1) * 60);
  });

  it('顾客早到：订单未暂存时不能开始准备；验证码错满次数后转人工核验', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'PICKUP', 9));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    st.ok({ type: 'CheckIn', orderId: o.id }, 'customer');
    expect(st.code({ type: 'StartPrep', key: o.id }, 'A3')).toBe('NOT_STAGED');
    for (const w of st.walksOf(o.id)) st.pickWalk(w, 'A1');
    st.stageOrder(o.id, 'A2');
    st.ok({ type: 'StartPrep', key: o.id }, 'A3');
    expect(st.code({ type: 'VerifyCode', key: o.id, code: 'K7Q2' }, 'A3')).toBe('NOT_READY');
    for (const id of st.s.orders[o.id]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: o.id, labelId: st.s.totes[id]?.labelId ?? '' }, 'A3');
    expect(st.code({ type: 'VerifyManually', key: o.id }, 'A3')).toBe('MANUAL_NOT_ALLOWED');
    for (let i = 0; i < rules.handoff.codeAttempts; i++) st.ok({ type: 'VerifyCode', key: o.id, code: `BAD${i}` }, 'A3');
    expect(st.s.sessions[o.id]?.manualRequired).toBe(true);
    expect(st.code({ type: 'VerifyCode', key: o.id, code: 'K7Q2' }, 'A3')).toBe('MANUAL_REQUIRED');
    st.ok({ type: 'VerifyManually', key: o.id }, 'A3');
    expect(st.code({ type: 'CompleteHandoff', key: o.id }, 'A9')).toBe('NOT_IN_SESSION');
  });

  it('含年龄限制商品时必须核验证件（或移除这些商品）', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.some((l) => catalog.byId.get(l.itemId)?.handling.includes('AGE_RESTRICTED'))));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of st.walksOf(o.id)) st.pickWalk(w, 'A1');
    st.stageOrder(o.id, 'A2');
    st.ok({ type: 'CheckIn', orderId: o.id }, 'customer');
    st.ok({ type: 'StartPrep', key: o.id }, 'A3');
    for (const id of st.s.orders[o.id]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: o.id, labelId: st.s.totes[id]?.labelId ?? '' }, 'A3');
    st.ok({ type: 'VerifyCode', key: o.id, code: 'K7Q2' }, 'A3');
    expect(st.code({ type: 'CompleteHandoff', key: o.id }, 'A3')).toBe('AGE_CHECK_REQUIRED');
    st.ok({ type: 'VerifyAge', key: o.id }, 'A3');
    st.ok({ type: 'CompleteHandoff', key: o.id }, 'A3');
    expect(st.s.orders[o.id]?.ageItemsRemoved).toBe(false);
  });
});

describe('配送行程', () => {
  it('暂存后组合行程；司机接单得到一个验证码；一次核验交付整趟', () => {
    const st = new Store();
    const ids = [0, 1, 2, 3].map((i) => st.create(pickOrder((x) => x.type === 'DELIVERY', i), 150).id);
    for (const id of ids) st.ok({ type: 'LockOrder', orderId: id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of Object.keys(st.s.walks)) st.pickWalk(w, 'A1');
    for (const id of ids) st.stageOrder(id, 'A2');
    st.ok({ type: 'Tick', release: false });
    const trips = Object.values(st.s.trips);
    expect(trips.length).toBeGreaterThan(0);
    const trip = trips[0];
    if (!trip) throw new Error('trip');
    expect(trip.orderIds.length).toBeLessThanOrEqual(rules.handoff.maxOrdersPerTrip);
    // 行程里的订单按行程交付
    expect(st.code({ type: 'StartPrep', key: trip.orderIds[0] ?? '' }, 'A3')).toBe('ORDER_IN_TRIP');
    st.ok({ type: 'AcceptTrip', tripId: trip.id, driverName: 'Driver', codeHash: hash(codeHashInput(trip.id, 'TR77')) }, 'driver');
    st.ok({ type: 'CheckIn', tripId: trip.id, vehicle: 'Blue hatchback' }, 'driver');
    st.ok({ type: 'StartPrep', key: trip.id }, 'A3');
    for (const id of trip.orderIds) for (const t of st.s.orders[id]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: trip.id, labelId: st.s.totes[t]?.labelId ?? '' }, 'A3');
    st.ok({ type: 'VerifyCode', key: trip.id, code: 'tr77' }, 'A3');
    st.ok({ type: 'RecordPlacement', tripId: trip.id, orderId: trip.orderIds[0] ?? '', position: 'TRUNK' }, 'A3');
    const out = st.ok({ type: 'CompleteHandoff', key: trip.id, removeAgeItems: true }, 'A3');
    expect(out.filter((e) => e.type === 'OrderHandedOff')).toHaveLength(trip.orderIds.length);
    expect(out.at(-1)?.type).toBe('TripCompleted');
    expect(trip.orderIds.every((id) => st.s.orders[id]?.status === 'COMPLETED')).toBe(true);
  });

  it('时段临近时先等同一时段还在拣货的订单，凑成一趟（全流程走查发现）', () => {
    const st = new Store();
    // 时段在 40 分钟后、提前量 30 分钟：离必须出发只剩 10 分钟
    const ids = [0, 1].map((i) => st.create(pickOrder((x) => x.type === 'DELIVERY', i), 40).id);
    for (const id of ids) st.ok({ type: 'LockOrder', orderId: id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of Object.keys(st.s.walks)) st.pickWalk(w, 'A1');
    const [a, b] = ids as [string, string];
    st.stageOrder(a, 'A2');
    st.ok({ type: 'Tick', release: false });
    // 另一单拣完但还没暂存：先等
    expect(Object.values(st.s.trips)).toHaveLength(0);
    st.stageOrder(b, 'A2');
    st.ok({ type: 'Tick', release: false });
    const trips = Object.values(st.s.trips);
    expect(trips).toHaveLength(1);
    expect(trips[0]?.orderIds.sort()).toEqual([...ids].sort());
  });

  it('只剩 5 分钟以内、或没有同行的订单时，不再等待', () => {
    const st = new Store();
    const ids = [0, 1].map((i) => st.create(pickOrder((x) => x.type === 'DELIVERY', i), 40).id);
    for (const id of ids) st.ok({ type: 'LockOrder', orderId: id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of Object.keys(st.s.walks)) st.pickWalk(w, 'A1');
    st.stageOrder(ids[0] ?? '', 'A2');
    st.now += 6 * MIN;
    st.ok({ type: 'Tick', release: false });
    expect(Object.values(st.s.trips).map((t) => t.orderIds)).toEqual([[ids[0]]]);
    // 单独一张临近时段的订单：暂存后马上成行
    const solo = new Store();
    const o = solo.create(pickOrder((x) => x.type === 'DELIVERY', 2), 40);
    solo.ok({ type: 'LockOrder', orderId: o.id });
    solo.ok({ type: 'ReleaseWalks' });
    for (const w of Object.keys(solo.s.walks)) solo.pickWalk(w, 'A1');
    solo.stageOrder(o.id, 'A2');
    solo.ok({ type: 'Tick', release: false });
    expect(Object.values(solo.s.trips)).toHaveLength(1);
  });
});

describe('扫码解析与事件流', () => {
  it('标签、格位、商品条码、订单短号', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'PICKUP', 10));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    const t = st.s.totes[st.s.orders[o.id]?.toteIds[0] ?? ''];
    expect(resolveScan(st.s, statics, ` ${t?.labelId?.toLowerCase()} `)).toMatchObject({ kind: 'label', toteId: t?.id, orderId: o.id, voided: false });
    expect(resolveScan(st.s, statics, 'SW1:AAAAAAAAA').kind).toBe('unknown-label');
    expect(resolveScan(st.s, statics, statics.slots[0]?.code ?? '')).toEqual({ kind: 'slot', code: statics.slots[0]?.code });
    expect(resolveScan(st.s, statics, '012345678905')).toEqual({ kind: 'item', gtin: '012345678905' });
    expect(resolveScan(st.s, statics, o.shortCode)).toEqual({ kind: 'order', orderId: o.id });
  });

  it('逐条应用与整体重放结果一致，快照可以 JSON 往返', () => {
    const st = new Store();
    for (let i = 0; i < 5; i++) st.create(pickOrder((x) => x.type === 'PICKUP', 11 + i), rules.lockLeadMin - 20 + i * 5);
    st.ok({ type: 'Tick', release: true });
    for (const w of Object.keys(st.s.walks).slice(0, 2)) st.pickWalk(w, `A${w}`);
    const snap = JSON.parse(JSON.stringify(st.s)) as OpsState;
    expect(snap).toEqual(replay(st.log, undefined, statics));
    // 从快照接着应用后续事件
    const more = st.ok({ type: 'CheckIn', orderId: Object.keys(st.s.orders)[0] ?? '' }, 'customer');
    for (const e of more) applyEvent(snap, e, statics);
    expect(snap).toEqual(st.s);
    expect(st.log.map((e) => e.seq)).toEqual(st.log.map((_, i) => i + 1));
  });
});
