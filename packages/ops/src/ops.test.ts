import { beforeEach, describe, expect, it } from 'vitest';
import type { Order } from '@storewright/domain';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateCatalog, generateOrders } from '@storewright/synth';
import { applyEvent, replay } from './apply';
import type { OpsCommand } from './commands';
import type { AnyOpsEvent } from './events';
import { resolveScan } from './scan';
import { buildBins, buildPlanogram, execute, orderInfoFrom, type OpsContext } from './server';
import { decide } from './decide';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import { emptyState, type OpsState, type StoreStatic } from './types';
import { isBusy, onShift, teamBoard } from './staff';
import { codeHashInput, handoffBoard, needsAgeCheck, openWalks, orderShortages, pickRows, recoveryNeeded, stagingOccupancy, suggestSlots, summary, toStageTotes } from './views';
import { clientProjection } from './projection';
import { planNudges } from './nudges';

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
    // 门店要求扫码时，没有扫框不能拣进去（不要求扫码时第一次放进框会自动绑定，决策记录 0026）
    st.ok({ type: 'SetStoreSettings', requireScan: true });
    expect(st.code({ type: 'PickItem', walkId: w1?.id ?? '', toteId: r?.toteId ?? '', lineId: r?.lineId ?? '', qty: 1, gtin: r?.gtin ?? '' }, 'A1')).toBe('TOTE_NOT_BOUND');
    st.ok({ type: 'SetStoreSettings', requireScan: false });
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

describe('设备快照（决策记录 0014）', () => {
  it('完成超过一小时的作业不随快照发出，订单只留摘要；之后的事件照常应用，统计不变', () => {
    const st = new Store();
    const done = st.create(pickOrder((x) => x.type === 'PICKUP', 3));
    st.ok({ type: 'LockOrder', orderId: done.id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of st.walksOf(done.id)) st.pickWalk(w, 'A1');
    st.stageOrder(done.id, 'A2');
    st.ok({ type: 'CheckIn', orderId: done.id }, 'customer');
    st.ok({ type: 'StartPrep', key: done.id }, 'A3');
    for (const id of st.s.orders[done.id]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: done.id, labelId: st.s.totes[id]?.labelId ?? '' }, 'A3');
    st.ok({ type: 'VerifyCode', key: done.id, code: 'K7Q2' }, 'A3');
    st.ok({ type: 'CompleteHandoff', key: done.id, removeAgeItems: true }, 'A3');
    const doneTotes = st.s.orders[done.id]?.toteIds ?? [];
    // 90 分钟后来了一张新订单
    st.now += 90 * MIN;
    const live = st.create(pickOrder((x) => x.type === 'PICKUP', 5));
    st.ok({ type: 'LockOrder', orderId: live.id });
    st.ok({ type: 'ReleaseWalks' });
    const proj = clientProjection(st.s, st.now);
    expect(proj).not.toBe(st.s);
    expect(doneTotes.every((t) => !proj.totes[t])).toBe(true);
    expect(Object.values(proj.walks).every((w) => w.status !== 'COMPLETED')).toBe(true);
    expect(proj.sessions[done.id]).toBeUndefined();
    expect(proj.orders[done.id]).toMatchObject({ status: 'COMPLETED', trimmed: true, lines: [] });
    expect(proj.orders[live.id]).toEqual(st.s.orders[live.id]);
    expect(summary(proj, st.now)).toEqual(summary(st.s, st.now));
    // 服务端状态不变
    expect(st.s.orders[done.id]?.lines.length).toBeGreaterThan(0);
    // 设备拿到精简快照后继续应用之后的事件，和服务端的进行中作业一致
    const device = JSON.parse(JSON.stringify(proj)) as typeof proj;
    const from = st.log.length;
    for (const w of st.walksOf(live.id)) st.pickWalk(w, 'A1');
    st.stageOrder(live.id, 'A2');
    for (const e of st.log.slice(from)) applyEvent(device, e, statics);
    expect(device.orders[live.id]).toEqual(st.s.orders[live.id]);
    expect(device.slots).toEqual(st.s.slots);
    // 刚完成的（不到一小时）照常发出
    expect(clientProjection(st.s, st.now - 85 * MIN).totes[doneTotes[0] ?? '']).toBeDefined();
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
    // 顾客已经到了：框没取完也可以先核验（决策记录 0026）
    expect(st.code({ type: 'VerifyCode', key: o.id, code: 'BAD-EARLY' }, 'A3')).toBe('OK');
    for (const id of st.s.orders[o.id]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: o.id, labelId: st.s.totes[id]?.labelId ?? '' }, 'A3');
    expect(st.code({ type: 'VerifyManually', key: o.id }, 'A3')).toBe('MANUAL_NOT_ALLOWED');
    // 输错不限次数、不锁定（决策记录 0014）：错到 codeAttempts 次后多一个人工核验入口，验证码仍可继续输入
    for (let i = 0; i < rules.handoff.codeAttempts + 3; i++) st.ok({ type: 'VerifyCode', key: o.id, code: `BAD${i}` }, 'A3');
    expect(st.s.sessions[o.id]?.codeFailures).toBe(rules.handoff.codeAttempts + 4);
    expect(st.s.sessions[o.id]?.manualRequired).toBe(true);
    expect(decide(st.s, { cmd: { type: 'VerifyManually', key: o.id }, actor: 'A3', at: st.now }, ctx).ok).toBe(true);
    st.ok({ type: 'VerifyCode', key: o.id, code: 'K7Q2' }, 'A3');
    expect(st.s.sessions[o.id]?.verified).toBe('CODE');
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

  it('司机取消接单：准备期以外可以取消，准备期内和到店不满 10 分钟不能取消，等待超过 10 分钟可以取消；系统的应对', () => {
    const st = new Store();
    const ids = [0, 1, 2, 3].map((i) => st.create(pickOrder((x) => x.type === 'DELIVERY', i), 150).id);
    for (const id of ids) st.ok({ type: 'LockOrder', orderId: id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of Object.keys(st.s.walks)) st.pickWalk(w, 'A1');
    for (const id of ids) st.stageOrder(id, 'A2');
    st.ok({ type: 'Tick', release: false });
    const trip = Object.values(st.s.trips)[0];
    if (!trip) throw new Error('trip');
    const accept = (name: string) => st.ok({ type: 'AcceptTrip', tripId: trip.id, driverName: name, codeHash: hash(codeHashInput(trip.id, 'TR77')) }, 'driver');
    expect(st.code({ type: 'CancelTripDriver', tripId: trip.id }, 'driver')).toBe('TRIP_NOT_ACCEPTED');

    // 1) 预计 30 分钟后到店：还没进准备期，可以取消；行程回到待接单，顾客收到延后通知
    accept('Driver 1');
    st.ok({ type: 'UpdateEta', tripId: trip.id, etaAt: st.now + 30 * MIN }, 'driver');
    expect(st.code({ type: 'CancelTripDriver', tripId: trip.id }, 'A3')).toBe('NOT_AUTHORIZED');
    const first = st.ok({ type: 'CancelTripDriver', tripId: trip.id }, 'driver');
    expect(first[0]).toMatchObject({ type: 'TripDriverCancelled', payload: { by: 'DRIVER', reason: 'BEFORE_PREP', driverName: 'Driver 1', returns: [] } });
    expect(st.s.trips[trip.id]).toMatchObject({ redispatchedAt: st.now, cancellations: [{ reason: 'BEFORE_PREP' }] });
    expect(st.s.trips[trip.id]?.acceptedAt).toBeUndefined();
    expect(trip.orderIds.every((id) => st.s.orders[id]?.delayNoticeAt === st.now)).toBe(true);

    // 2) 第二位司机：进入预计到店前 10 分钟的准备期后不能取消
    accept('Driver 2');
    st.ok({ type: 'UpdateEta', tripId: trip.id, etaAt: st.now + 15 * MIN }, 'driver');
    st.now += 6 * MIN;
    expect(st.code({ type: 'CancelTripDriver', tripId: trip.id }, 'driver')).toBe('CANCEL_LOCKED');
    // 到店、员工开始准备并取出框；到店不满 10 分钟也不能取消
    st.ok({ type: 'CheckIn', tripId: trip.id, vehicle: 'Blue hatchback' }, 'driver');
    st.ok({ type: 'StartPrep', key: trip.id }, 'A3');
    const pulled = trip.orderIds.flatMap((id) => st.s.orders[id]?.toteIds ?? []);
    const slotOf = new Map(pulled.map((t) => [t, st.s.totes[t]?.slotCode]));
    for (const t of pulled) st.ok({ type: 'ScanPrepTote', key: trip.id, labelId: st.s.totes[t]?.labelId ?? '' }, 'A3');
    st.now += 5 * MIN;
    expect(st.run({ type: 'CancelTripDriver', tripId: trip.id }, 'driver').decision).toMatchObject({ ok: false, reject: { code: 'CANCEL_WAIT', params: { waitedMin: 5 } } });
    // 等了 11 分钟：可以取消，记为等待过久；框放回原格位，交付准备结束，订单回到已暂存
    st.now += 6 * MIN;
    const second = st.ok({ type: 'CancelTripDriver', tripId: trip.id }, 'driver');
    expect(second[0]).toMatchObject({ payload: { reason: 'WAITED_TOO_LONG', waitedMin: 11, sessionOwner: 'A3' } });
    expect(st.s.sessions[trip.id]).toBeUndefined();
    expect(pulled.every((t) => st.s.totes[t]?.status === 'STAGED' && st.s.totes[t]?.slotCode === slotOf.get(t))).toBe(true);
    expect(pulled.every((t) => st.s.slots[slotOf.get(t) ?? '']?.includes(t))).toBe(true);
    expect(trip.orderIds.every((id) => st.s.orders[id]?.status === 'STAGED' && st.s.orders[id]?.arrivedAt === undefined)).toBe(true);
    expect(st.s.trips[trip.id]?.cancellations?.map((c) => c.reason)).toEqual(['BEFORE_PREP', 'WAITED_TOO_LONG']);

    // 3) 第三位司机没来：预计到店后再过 10 分钟，带班负责人或控制台可以改派
    accept('Driver 3');
    st.ok({ type: 'UpdateEta', tripId: trip.id, etaAt: st.now + 10 * MIN }, 'driver');
    st.now += 15 * MIN;
    expect(st.code({ type: 'RedispatchTrip', tripId: trip.id }, 'console')).toBe('NOT_NO_SHOW');
    st.now += 6 * MIN;
    expect(st.code({ type: 'RedispatchTrip', tripId: trip.id }, 'A3')).toBe('NOT_AUTHORIZED');
    expect(st.ok({ type: 'RedispatchTrip', tripId: trip.id }, 'console')[0]).toMatchObject({ payload: { by: 'STORE', reason: 'NO_SHOW' } });

    // 4) 重新派单后，新司机接单，整趟照常交付
    accept('Driver 4');
    st.ok({ type: 'CheckIn', tripId: trip.id }, 'driver');
    st.ok({ type: 'StartPrep', key: trip.id }, 'A3');
    for (const t of pulled) st.ok({ type: 'ScanPrepTote', key: trip.id, labelId: st.s.totes[t]?.labelId ?? '' }, 'A3');
    st.ok({ type: 'VerifyCode', key: trip.id, code: 'TR77' }, 'A3');
    st.ok({ type: 'CompleteHandoff', key: trip.id, removeAgeItems: true }, 'A3');
    expect(trip.orderIds.every((id) => st.s.orders[id]?.status === 'COMPLETED')).toBe(true);
    // 重放事件得到同样的状态
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
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

describe('取货车位（决策记录 0013）', () => {
  it('配置了明确的取货车位时，顾客到店只能用这些编号', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'PICKUP', 3));
    const withBays = { ...ctx, statics: { ...statics, pickupBays: ['P1', 'P2'] } };
    const r = execute(st.s, { cmd: { type: 'CheckIn', orderId: o.id, bay: '7' }, actor: 'customer', at: st.now }, withBays);
    expect(r.decision.ok ? 'OK' : r.decision.reject.code).toBe('BAY_NOT_FOUND');
    const ok = execute(st.s, { cmd: { type: 'CheckIn', orderId: o.id, bay: 'P2' }, actor: 'customer', at: st.now }, withBays);
    expect(ok.decision.ok).toBe(true);
    // 没有配置车位时不检查
    expect(st.code({ type: 'CheckIn', orderId: o.id, bay: '7' }, 'customer')).toBe('OK');
  });
});

describe('设备告警（数字孪生，决策记录 0016）', () => {
  const impact = { orders: ['O1'], totes: 2, cases: 0, units: 0, moveTo: ['C-09'] };
  const raise = { type: 'RaiseEquipmentAlert' as const, sensorId: 'T-STAGING-1-C', kind: 'TEMP_HIGH' as const, severity: 'ALARM' as const, value: 8.4, limit: 5, since: T0 - 2 * MIN, impact };

  it('只有孪生服务能发出和解除；同一传感器同一类告警不重复；带班负责人或控制台确认；解除后记下持续时长和极值', () => {
    const st = new Store();
    // 员工和控制台都不能自己发出告警
    expect(st.code(raise, 'A1')).toBe('NOT_AUTHORIZED');
    expect(st.code(raise, 'console')).toBe('NOT_AUTHORIZED');
    const [e] = st.ok(raise, 'twin');
    expect(e).toMatchObject({ type: 'EquipmentAlertRaised', payload: { alertId: 'AL00001', since: T0 - 2 * MIN, impact } });
    expect(st.ok(raise, 'twin')).toEqual([]);
    expect(st.s.alerts.AL00001).toMatchObject({ status: 'ACTIVE', severity: 'ALARM', value: 8.4, limit: 5, raisedAt: T0 });
    // 拣货员不能确认；控制台可以（带班负责人同样可以，作业核心用同一个权限判断）
    expect(st.code({ type: 'AcknowledgeAlert', alertId: 'AL00001' }, 'A1')).toBe('NOT_AUTHORIZED');
    expect(st.code({ type: 'AcknowledgeAlert', alertId: 'NOPE' })).toBe('ALERT_NOT_FOUND');
    st.ok({ type: 'AcknowledgeAlert', alertId: 'AL00001' });
    expect(st.s.alerts.AL00001).toMatchObject({ status: 'ACKED', ackBy: 'console', ackAt: T0 });
    expect(st.ok({ type: 'AcknowledgeAlert', alertId: 'AL00001' })).toEqual([]);
    expect(st.code({ type: 'ClearEquipmentAlert', alertId: 'AL00001' }, 'console')).toBe('NOT_AUTHORIZED');
    st.now = T0 + 5 * MIN;
    const [c] = st.ok({ type: 'ClearEquipmentAlert', alertId: 'AL00001', peak: 9.1 }, 'twin');
    expect(c).toMatchObject({ type: 'EquipmentAlertCleared', payload: { durationSec: 7 * 60, peak: 9.1 } });
    expect(st.s.alerts.AL00001).toMatchObject({ status: 'CLEARED', clearedAt: T0 + 5 * MIN, peak: 9.1 });
    expect(st.code({ type: 'AcknowledgeAlert', alertId: 'AL00001' })).toBe('ALERT_CLEARED');
    // 解除之后同一传感器可以再发新的告警
    expect(st.ok(raise, 'twin')[0]).toMatchObject({ payload: { alertId: 'AL00002' } });
    // 告警进事件流：回放得到同样的状态，设备快照里也带着
    expect(replay(st.log, undefined, statics).alerts).toEqual(st.s.alerts);
    expect(clientProjection(st.s, st.now).alerts).toEqual(st.s.alerts);
  });

  it('影响里的数字和编号经过清理', () => {
    const st = new Store();
    const [e] = st.ok({ ...raise, value: Number.NaN, since: T0 + 60 * MIN, impact: { orders: ['O1', 3 as unknown as string], totes: -2, cases: 1.6, units: Number.POSITIVE_INFINITY, moveTo: [] } }, 'twin');
    expect(e).toMatchObject({ payload: { value: 0, since: T0, impact: { orders: ['O1'], totes: 0, cases: 2, units: 0, moveTo: [] } } });
  });
});

describe('学生兼职工的班次（决策记录 0020）', () => {
  it('有班次的员工只在班次时段里在岗（当地时间）；没有班次的全职员工整天在岗', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 22, h, m).getTime();
    const student = { shift: { from: 16 * 60, to: 20 * 60 } };
    expect(onShift(student, at(15, 59))).toBe(false);
    expect(onShift(student, at(16))).toBe(true);
    expect(onShift(student, at(19, 59))).toBe(true);
    expect(onShift(student, at(20))).toBe(false);
    expect(onShift({}, at(3))).toBe(true);
  });
});

// 全部流程梳理时发现的问题（决策记录 0025）
describe('流程梳理发现的问题（决策记录 0025）', () => {
  /** 一张自取订单拣完、暂存、顾客到店，交给 A3 开始准备 */
  function preparing(st: Store) {
    const o = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.length >= 2, 4));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of st.walksOf(o.id)) st.pickWalk(w, 'A1');
    st.stageOrder(o.id, 'A2');
    st.ok({ type: 'CheckIn', orderId: o.id, bay: '1' }, 'customer');
    st.ok({ type: 'StartPrep', key: o.id }, 'A3');
    const first = st.s.orders[o.id]?.toteIds[0] as string;
    st.ok({ type: 'ScanPrepTote', key: o.id, labelId: st.s.totes[first]?.labelId ?? '' }, 'A3');
    return { orderId: o.id, first };
  }

  it('准备中取消订单：这一单的交付准备结束、员工不再「忙」，已取出的框进回收专区的列表', () => {
    const st = new Store();
    const { orderId, first } = preparing(st);
    expect(isBusy(st.s, 'A3')).toBe(true);
    st.ok({ type: 'CancelOrder', orderId, reason: 'customer' });
    expect(st.s.sessions[orderId]).toBeUndefined();
    expect(isBusy(st.s, 'A3')).toBe(false);
    expect(recoveryNeeded(st.s).map((t) => t.id)).toContain(first);
    st.ok({ type: 'RecoverTote', labelId: st.s.totes[first]?.labelId ?? '' }, 'A3');
    expect(st.s.totes[first]?.status).toBe('RECOVERY');
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
  });

  it('取出后不在交付准备里的框可以放回暂存区（改派时没有空格位的情况），也出现在待暂存列表；放回不重复「订单已暂存」', () => {
    const st = new Store();
    const { orderId, first } = preparing(st);
    // 准备中的框不能再暂存
    const label = st.s.totes[first]?.labelId ?? '';
    expect(st.code({ type: 'StageTote', labelId: label, slotCode: st.s.totes[first]?.slotCode ?? '' }, 'A2')).toBe('TOTE_NOT_PICKED');
    // 交付准备结束了、框还在手上（改派时原格位和同温区都满了时就是这样）
    delete st.s.sessions[orderId];
    expect(toStageTotes(st.s).map((t) => t.id)).toContain(first);
    const stagedEvents = st.log.filter((e) => e.type === 'OrderStaged').length;
    st.ok({ type: 'StageTote', labelId: label, slotCode: st.s.totes[first]?.slotCode ?? '' }, 'A2');
    expect(st.s.totes[first]?.status).toBe('STAGED');
    expect(st.log.filter((e) => e.type === 'OrderStaged').length).toBe(stagedEvents);
    expect(toStageTotes(st.s).map((t) => t.id)).not.toContain(first);
  });

  it('配送订单等行程成行后一起准备；换格位时不推荐它现在所在的格位', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'DELIVERY', 1), 150);
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of st.walksOf(o.id)) st.pickWalk(w, 'A1');
    st.stageOrder(o.id, 'A2');
    expect(st.s.orders[o.id]?.tripId).toBeUndefined();
    expect(st.code({ type: 'StartPrep', key: o.id }, 'A3')).toBe('TRIP_PENDING');
    const id = st.s.orders[o.id]?.toteIds[0] as string;
    expect(suggestSlots(st.s, statics, id, 10)).not.toContain(st.s.totes[id]?.slotCode);
  });

  it('年龄限制的商品换成替代品时，交付也要核验证件', () => {
    const s = emptyState();
    s.orders.O1 = { id: 'O1', lines: [{ lineId: 'L1', ageRestricted: true }], lineResults: { L1: { picked: 0, short: 0, substituted: 2 } } } as unknown as OpsState['orders'][string];
    expect(needsAgeCheck(s, ['O1'])).toBe(true);
    (s.orders.O1 as { lineResults: Record<string, { picked: number; short: number; substituted: number }> }).lineResults.L1 = { picked: 0, short: 2, substituted: 0 };
    expect(needsAgeCheck(s, ['O1'])).toBe(false);
  });
});

// 修复全部卡点（决策记录 0026）
describe('门店设置、扫码核对、第一次放进框时绑定（决策记录 0026）', () => {
  function walkFor(st: Store) {
    const o = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.length >= 2, 6));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    const walkId = st.walksOf(o.id)[0] as string;
    st.ok({ type: 'ClaimWalk', walkId }, 'A1');
    return { orderId: o.id, walkId };
  }

  it('不要求扫码：第一次往框里放东西时自动绑定；扫了商品条码就核对', () => {
    const st = new Store();
    const { walkId } = walkFor(st);
    const w = st.s.walks[walkId];
    const row = pickRows(st.s, w as NonNullable<typeof w>)[0];
    if (!row) throw new Error('row');
    expect(st.code({ type: 'PickItem', walkId, toteId: row.toteId, lineId: row.lineId, qty: 1, gtin: '00000000000017' }, 'A1')).toBe('WRONG_ITEM');
    const out = st.ok({ type: 'PickItem', walkId, toteId: row.toteId, lineId: row.lineId, qty: 1, gtin: row.gtin }, 'A1');
    expect(out.map((e) => e.type)).toEqual(['LabelBound', 'ItemPicked']);
    expect(st.s.walks[walkId]?.bound).toContain(row.toteId);
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
  });

  it('要求扫码：点选被拒；没扫商品条码被拒；没绑定的框要扫框标签；只有控制台和带班负责人能改设置', () => {
    const st = new Store();
    const { walkId } = walkFor(st);
    expect(st.code({ type: 'SetStoreSettings', requireScan: true }, 'A1')).toBe('NOT_AUTHORIZED');
    st.ok({ type: 'SetStoreSettings', requireScan: true }, 'console');
    expect(st.s.settings?.requireScan).toBe(true);
    const w = st.s.walks[walkId];
    const row = pickRows(st.s, w as NonNullable<typeof w>)[0];
    if (!row) throw new Error('row');
    const label = st.s.totes[row.toteId]?.labelId ?? '';
    expect(st.code({ type: 'BindLabel', walkId, labelId: label, tap: true }, 'A1')).toBe('SCAN_REQUIRED');
    expect(st.code({ type: 'PickItem', walkId, toteId: row.toteId, lineId: row.lineId, qty: 1, gtin: row.gtin }, 'A1')).toBe('TOTE_NOT_BOUND');
    expect(st.code({ type: 'PickItem', walkId, toteId: row.toteId, lineId: row.lineId, qty: 1, labelId: label }, 'A1')).toBe('SCAN_REQUIRED');
    expect(st.ok({ type: 'PickItem', walkId, toteId: row.toteId, lineId: row.lineId, qty: 1, labelId: label, gtin: row.gtin }, 'A1').map((e) => e.type)).toEqual(['LabelBound', 'ItemPicked']);
    // 缺货不往框里放东西，不用绑定
    const other = pickRows(st.s, st.s.walks[walkId] as NonNullable<typeof w>).find((r) => r.toteId !== row.toteId && r.done < r.qty);
    if (other) expect(st.code({ type: 'ReportNotFound', walkId, toteId: other.toteId, lineId: other.lineId, qty: other.qty - other.done, resolution: 'SHORT' }, 'A1')).toBe('OK');
    expect(st.code({ type: 'SetStoreSettings', prepGate: 'NOPE' as 'ANY' }, 'console')).toBe('SETTING_INVALID');
  });

  it('放弃批次时解除绑定：下一个人领到时要重新扫框', () => {
    const st = new Store();
    const { walkId } = walkFor(st);
    const w = st.s.walks[walkId] as NonNullable<OpsState['walks'][string]>;
    for (const id of w.toteIds) st.ok({ type: 'BindLabel', walkId, labelId: st.s.totes[id]?.labelId ?? '' }, 'A1');
    expect(st.s.walks[walkId]?.bound.length).toBe(w.toteIds.length);
    st.ok({ type: 'UnclaimWalk', walkId }, 'A1');
    expect(st.s.walks[walkId]?.bound).toEqual([]);
    expect(w.toteIds.every((id) => st.s.totes[id]?.status === 'IN_WALK')).toBe(true);
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
  });
});

describe('冷链计时到暂存为止（决策记录 0026）', () => {
  it('完成拣货后框还没放进暂存：超时照样提醒；放进暂存后不再提醒', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.some((l) => catalog.byId.get(l.itemId)?.tempZone === 'CHILLED'), 0));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    const cold = st.walksOf(o.id).find((w) => st.s.walks[w]?.tempZone === 'CHILLED') as string;
    st.pickWalk(cold, 'A1');
    const w = st.s.walks[cold];
    expect(w?.status).toBe('COMPLETED');
    expect(w?.coldStartedAt).toBeDefined();
    st.now += ((w?.coldLimitSec ?? 0) + 60) * 1000;
    const out = st.ok({ type: 'Tick', release: false }, 'system');
    expect(out.some((e) => e.type === 'ColdChainAlert')).toBe(true);
    // 另一张：放进暂存后不提醒
    const st2 = new Store();
    const o2 = st2.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.some((l) => catalog.byId.get(l.itemId)?.tempZone === 'CHILLED'), 0));
    st2.ok({ type: 'LockOrder', orderId: o2.id });
    st2.ok({ type: 'ReleaseWalks' });
    for (const id of st2.walksOf(o2.id)) st2.pickWalk(id, 'A1');
    st2.stageOrder(o2.id, 'A2');
    const w2 = Object.values(st2.s.walks).find((x) => x.tempZone === 'CHILLED');
    st2.now += ((w2?.coldLimitSec ?? 0) + 60) * 1000;
    expect(st2.ok({ type: 'Tick', release: false }, 'system').some((e) => e.type === 'ColdChainAlert')).toBe(false);
  });
});

describe('暂存：自取区和配送区、回收专区扫码（决策记录 0026）', () => {
  it('配送订单的框不能放进自取区的格位；要求扫码时移到回收专区要扫对温区的回收专区标签', () => {
    const st = new Store();
    const o = st.create(pickOrder((x) => x.type === 'DELIVERY', 3), 150);
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of st.walksOf(o.id)) st.pickWalk(w, 'A1');
    const tote = st.s.totes[st.s.orders[o.id]?.toteIds[0] ?? ''];
    const pickupSlot = statics.slots.find((x) => x.area === 'PICKUP' && x.tempZone === tote?.tempZone);
    if (pickupSlot) expect(st.code({ type: 'StageTote', labelId: tote?.labelId ?? '', slotCode: pickupSlot.code }, 'A2')).toBe('SLOT_AREA_MISMATCH');
    st.stageOrder(o.id, 'A2');
    st.ok({ type: 'CancelOrder', orderId: o.id, reason: 'customer' });
    st.ok({ type: 'SetStoreSettings', requireScan: true });
    const label = tote?.labelId ?? '';
    expect(st.code({ type: 'RecoverTote', labelId: label, tap: true }, 'A2')).toBe('SCAN_REQUIRED');
    expect(st.code({ type: 'RecoverTote', labelId: label }, 'A2')).toBe('SCAN_REQUIRED');
    const wrong = tote?.tempZone === 'AMBIENT' ? 'RECOVERY-FRZ' : 'RECOVERY-AMB';
    expect(st.code({ type: 'RecoverTote', labelId: label, area: wrong }, 'A2')).toBe('SLOT_ZONE_MISMATCH');
    const right = { AMBIENT: 'RECOVERY-AMB', CHILLED: 'RECOVERY-CHL', FROZEN: 'RECOVERY-FRZ', HOT: 'RECOVERY-HOT' }[tote?.tempZone ?? 'AMBIENT'];
    st.ok({ type: 'RecoverTote', labelId: label, area: right }, 'A2');
    expect(st.s.totes[tote?.id ?? '']?.status).toBe('RECOVERY');
    expect(resolveScan(st.s, statics, ' recovery-amb ')).toEqual({ kind: 'recovery', code: 'RECOVERY-AMB', tempZone: 'AMBIENT' });
  });
});

describe('交付：先核验再取框、退出准备、顾客到了才开始、召回商品（决策记录 0026）', () => {
  function staged(st: Store, skip = 11) {
    const o = st.create(pickOrder((x) => x.type === 'PICKUP' && x.lines.length >= 2, skip));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of st.walksOf(o.id)) st.pickWalk(w, 'A1');
    st.stageOrder(o.id, 'A2');
    return o.id;
  }

  it('先核验、再取框：框没取完不能交；取完直接进入交付', () => {
    const st = new Store();
    const id = staged(st);
    st.ok({ type: 'CheckIn', orderId: id }, 'customer');
    st.ok({ type: 'StartPrep', key: id }, 'A3');
    st.ok({ type: 'VerifyCode', key: id, code: 'K7Q2' }, 'A3');
    expect(st.s.sessions[id]?.status).toBe('PREPPING');
    expect(st.code({ type: 'CompleteHandoff', key: id, removeAgeItems: true }, 'A3')).toBe('NOT_READY');
    for (const t of st.s.orders[id]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: id, labelId: st.s.totes[t]?.labelId ?? '' }, 'A3');
    expect(st.s.sessions[id]?.status).toBe('HANDING_OFF');
    st.ok({ type: 'CompleteHandoff', key: id, removeAgeItems: true }, 'A3');
    expect(st.s.orders[id]?.status).toBe('COMPLETED');
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
  });

  it('退出准备：取出的框进「待暂存」放回；重新开始时手上的框可以直接扫进来', () => {
    const st = new Store();
    const id = staged(st, 12);
    st.ok({ type: 'StartPrep', key: id }, 'A3');
    const first = st.s.orders[id]?.toteIds[0] as string;
    st.ok({ type: 'ScanPrepTote', key: id, labelId: st.s.totes[first]?.labelId ?? '' }, 'A3');
    expect(st.code({ type: 'AbandonPrep', key: id }, 'A9')).toBe('NOT_IN_SESSION');
    st.ok({ type: 'AbandonPrep', key: id }, 'A3');
    expect(st.s.sessions[id]).toBeUndefined();
    expect(st.s.orders[id]?.status).toBe('STAGED');
    expect(toStageTotes(st.s).map((t) => t.id)).toContain(first);
    // 马上重新开始：手上的框直接扫进新的准备
    st.ok({ type: 'StartPrep', key: id }, 'A4');
    st.ok({ type: 'ScanPrepTote', key: id, labelId: st.s.totes[first]?.labelId ?? '' }, 'A4');
    expect(st.s.sessions[id]?.scanned).toContain(first);
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
  });

  it('门店设置「顾客到了才能开始」：没到时不能开始准备', () => {
    const st = new Store();
    const id = staged(st, 13);
    st.ok({ type: 'SetStoreSettings', prepGate: 'ARRIVED' });
    expect(st.code({ type: 'StartPrep', key: id }, 'A3')).toBe('NOT_ARRIVED');
    st.ok({ type: 'CheckIn', orderId: id }, 'customer');
    expect(st.code({ type: 'StartPrep', key: id }, 'A3')).toBe('OK');
  });

  it('召回商品已经拣进框里：交给顾客前要确认取出', () => {
    const st = new Store();
    const id = staged(st, 14);
    const item = st.s.orders[id]?.lines[0]?.itemId as string;
    st.s.recalls = { RC1: { id: 'RC1', title: 't', itemIds: [item], lots: [], openedAt: st.now, by: 'L1', status: 'OPEN', steps: {}, affected: { shelf: {}, cases: [], totes: [], openOrders: [], doneOrders: [] } } };
    st.ok({ type: 'CheckIn', orderId: id }, 'customer');
    st.ok({ type: 'StartPrep', key: id }, 'A3');
    for (const t of st.s.orders[id]?.toteIds ?? []) st.ok({ type: 'ScanPrepTote', key: id, labelId: st.s.totes[t]?.labelId ?? '' }, 'A3');
    st.ok({ type: 'VerifyCode', key: id, code: 'K7Q2' }, 'A3');
    expect(st.code({ type: 'CompleteHandoff', key: id, removeAgeItems: true }, 'A3')).toBe('RECALL_ITEMS_PRESENT');
    st.ok({ type: 'CompleteHandoff', key: id, removeAgeItems: true, removeRecalled: true }, 'A3');
    expect(st.s.orders[id]?.recallRemoved).toBe(true);
  });
});

describe('提醒：顾客到店（决策记录 0026）', () => {
  it('顾客到店时提醒在岗的交付员；有人开始准备后不再提醒', () => {
    const st = new Store();
    st.ok({ type: 'ChangeRole', associateId: 'A1', role: 'HANDOFF' });
    const o = st.create(pickOrder((x) => x.type === 'PICKUP', 15));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    for (const w of st.walksOf(o.id)) st.pickWalk(w, 'X1');
    st.stageOrder(o.id, 'X1');
    st.ok({ type: 'CheckIn', orderId: o.id, bay: '2' }, 'customer');
    const plan = planNudges(st.s, statics, st.now);
    const arrival = plan.send.find((c) => c.to === 'A1' && c.kind === 'ARRIVAL');
    expect(arrival?.params).toMatchObject({ order: o.shortCode, bay: '2' });
    st.ok({ type: 'StartPrep', key: o.id }, 'A3');
    expect(planNudges(st.s, statics, st.now).send.some((c) => c.kind === 'ARRIVAL')).toBe(false);
  });
});

describe('带班负责人的工具（决策记录 0026）', () => {
  const claimed = (st: Store) => {
    const o = st.create(pickOrder((x) => x.type === 'PICKUP'));
    st.ok({ type: 'LockOrder', orderId: o.id });
    st.ok({ type: 'ReleaseWalks' });
    const w = st.walksOf(o.id)[0] as string;
    st.ok({ type: 'ClaimWalk', walkId: w }, 'A1');
    return w;
  };
  const finish = (st: Store, w: string) => {
    const walk = st.s.walks[w];
    if (!walk) throw new Error('walk');
    for (const r of pickRows(st.s, walk)) if (r.qty > r.done) st.ok({ type: 'PickItem', walkId: w, toteId: r.toteId, lineId: r.lineId, qty: r.qty - r.done }, 'A1');
    st.ok({ type: 'CompleteWalk', walkId: w }, 'A1');
  };

  it('调忙着的人：做完这一单再去（排队），做完后节拍调过去；空闲的人直接调；熟食也可以调', () => {
    const st = new Store();
    const w = claimed(st);
    const [q] = st.ok({ type: 'ChangeRole', associateId: 'A1', role: 'HANDOFF', minutes: 60, whenFree: true });
    expect(q).toMatchObject({ type: 'AssociateMoveQueued', payload: { associateId: 'A1', role: 'HANDOFF', minutes: 60 } });
    expect(st.s.roles.A1).toBeUndefined();
    expect(teamBoard(statics, st.s, st.now).members.find((m) => m.id === 'A1')?.queued).toEqual({ role: 'HANDOFF', minutes: 60 });
    st.ok({ type: 'Tick', release: false }, 'system');
    expect(st.s.roles.A1).toBeUndefined();
    finish(st, w);
    expect(st.s.roles.A1).toBeUndefined();
    st.ok({ type: 'Tick', release: false }, 'system');
    expect(st.s.roles.A1).toBe('HANDOFF');
    expect(st.s.roleChanges?.A1?.until).toBe(st.now + 60 * MIN);
    expect(st.s.pendingMoves?.A1).toBeUndefined();
    expect(st.code({ type: 'ChangeRole', associateId: 'X1', role: 'DELI', whenFree: true })).toBe('OK');
    expect(st.s.roles.X1).toBe('DELI');
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
  });

  it('排队的调动：选「留在现在的岗位」就取消；本人做完后的下一个操作之前先调过去（不用等节拍）', () => {
    const st = new Store();
    const w = claimed(st);
    st.ok({ type: 'ChangeRole', associateId: 'A1', role: 'STAGE', whenFree: true });
    expect(st.ok({ type: 'ChangeRole', associateId: 'A1', role: 'PICK' })[0]).toMatchObject({ type: 'AssociateMoveCancelled', payload: { associateId: 'A1' } });
    expect(st.s.pendingMoves?.A1).toBeUndefined();
    st.ok({ type: 'ChangeRole', associateId: 'A1', role: 'STAGE', whenFree: true });
    finish(st, w);
    const out = st.ok({ type: 'AckSop', sopId: 'stage-scan' }, 'A1');
    expect(out.map((e) => e.type)).toEqual(['AssociateRoleChanged', 'SopAcknowledged']);
    expect(st.s.roles.A1).toBe('STAGE');
    expect(replay(st.log, undefined, statics)).toEqual(st.s);
  });

  it('AI 的调人建议：采纳时这个人手上有任务就排队，做完再去（以前算过时、要再忽略一次）', () => {
    const st = new Store();
    const w = claimed(st);
    const draft = { module: 'STAFFING' as const, target: 'A1', action: { kind: 'MOVE_ASSOCIATE', params: { associateId: 'A1', to: 'STAGE', hours: 1 } }, confidence: 0.7, reasons: [], alternatives: [], model: { id: 'staff', version: 1, kind: 'rules' }, expiresAt: st.now + 60 * MIN };
    st.ok({ type: 'IssueRecommendation', draft }, 'ai');
    const rec = Object.values(st.s.recs)[0];
    if (!rec) throw new Error('rec');
    const out = st.ok({ type: 'AcceptRecommendation', recId: rec.id });
    expect(out.at(-1)).toMatchObject({ type: 'AssociateMoveQueued', payload: { associateId: 'A1', role: 'STAGE', minutes: 60, recId: rec.id } });
    finish(st, w);
    st.ok({ type: 'Tick', release: false }, 'system');
    expect(st.s.roles.A1).toBe('STAGE');
    expect(st.log.filter((e) => e.type === 'AssociateRoleChanged').at(-1)).toMatchObject({ payload: { recId: rec.id, minutes: 60 } });
  });

  it('设备告警：负责这台设备的岗位也能确认（后仓员工确认冷库告警），别的岗位不能', () => {
    const st = new Store();
    const cooler = { type: 'RaiseEquipmentAlert' as const, sensorId: 'T-COOLER', kind: 'TEMP_HIGH' as const, severity: 'WARN' as const, value: 6.2, limit: 5, since: T0, impact: { orders: [], totes: 0, cases: 3, units: 40, moveTo: [] } };
    st.ok(cooler, 'twin');
    const id = Object.keys(st.s.alerts)[0] as string;
    expect(st.code({ type: 'AcknowledgeAlert', alertId: id }, 'A1')).toBe('NOT_AUTHORIZED');
    st.ok({ type: 'AcknowledgeAlert', alertId: id }, 'X1');
    expect(st.s.alerts[id]).toMatchObject({ status: 'ACKED', ackBy: 'X1' });
    // 暂存冷柜的告警给暂存、交付：后仓员工不能确认
    st.ok({ ...cooler, sensorId: 'T-STAGING-1-C' }, 'twin');
    const id2 = Object.keys(st.s.alerts).find((x) => x !== id) as string;
    expect(st.code({ type: 'AcknowledgeAlert', alertId: id2 }, 'X1')).toBe('NOT_AUTHORIZED');
  });
});
