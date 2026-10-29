import { describe, expect, it } from 'vitest';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import type { RecommendationDraft } from '@storewright/ai';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateCatalog, generateOrders } from '@storewright/synth';
import type { OpsCommand } from './commands';
import { buildBins, buildPlanogram, execute, orderInfoFrom, type OpsContext } from './server';
import { emptyState, type LiveWalk, type OpsState, type StoreStatic } from './types';

/** 冷链与分批、分框学习（决策记录 0023 · B3、B7）的作业侧 */

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
    { id: 'P2', name: 'Picker 2', role: 'PICK', exceptionAuthorized: false },
    { id: 'L1', name: 'Lead', role: 'LEAD', exceptionAuthorized: true },
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
  /** 下几张订单、锁单、生成批次；返回含 2 张以上订单的某个温区的批次 */
  walkWith(zone: 'FROZEN' | 'CHILLED' | 'AMBIENT', n = 6): LiveWalk {
    for (let i = 0; i < n; i++) {
      const o = orders[i];
      if (!o) throw new Error('no order');
      const info = orderInfoFrom({ ...o, id: `O${i}`, shortCode: `S${i}` }, catalog.byId, this.now + 60 * MIN, rules.slotLengthMin);
      this.ok({ type: 'CreateOrder', order: info, codeHash: 'x' });
      this.ok({ type: 'LockOrder', orderId: info.id });
    }
    this.ok({ type: 'ReleaseWalks' });
    const w = Object.values(this.s.walks).find((x) => x.tempZone === zone && new Set(x.toteIds.map((id) => this.s.totes[id]?.orderId)).size >= 2);
    if (!w) throw new Error(`no ${zone} walk with 2+ orders`);
    return w;
  }
  claimAndBind(w: LiveWalk, who = 'P1') {
    this.ok({ type: 'ClaimWalk', walkId: w.id }, who);
    for (const id of w.toteIds) this.ok({ type: 'BindLabel', walkId: w.id, labelId: this.s.totes[id]?.labelId as string }, who);
  }
}

const rec = (st: Store, kind: string, target: string, params: Record<string, string>) => {
  const draft: RecommendationDraft = { module: 'PICKING', target, action: { kind, params }, confidence: 0.7, reasons: [], alternatives: [], model: { id: 'm', version: 1, kind: 'k' }, expiresAt: st.now + 30 * MIN };
  return st.ok({ type: 'IssueRecommendation', draft }, 'ai');
};

describe('冷链拆批与转交（决策记录 0023 · B3）', () => {
  it('领取前拆批：按订单分成两个批次，路线顺序不变、框不重不漏；已经领取的批次不能拆', () => {
    const st = new Store();
    const w = st.walkWith('AMBIENT');
    const byOrder = new Map<string, string[]>();
    for (const id of w.toteIds) {
      const oid = st.s.totes[id]?.orderId as string;
      byOrder.set(oid, [...(byOrder.get(oid) ?? []), id]);
    }
    const [first, ...rest] = [...byOrder.values()];
    const groups = [first as string[], rest.flat()];
    const ev = rec(st, 'SPLIT_WALK', `SPLIT:${w.id}`, { walkId: w.id, groups: groups.map((g) => g.join(',')).join('|') });
    expect(ev.some((e) => e.type === 'PickWalkSplit')).toBe(true);
    expect(st.s.walks[w.id]).toBeUndefined();
    const parts = Object.values(st.s.walks).filter((x) => x.toteIds.some((id) => w.toteIds.includes(id)));
    expect(parts).toHaveLength(2);
    expect(parts.flatMap((x) => x.toteIds).sort()).toEqual([...w.toteIds].sort());
    for (const p of parts) {
      // 子路线：货位顺序是原路线的子序列
      const order = p.stops.map((x) => w.stops.findIndex((y) => y.locationId === x.locationId));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      for (const id of p.toteIds) expect(st.s.totes[id]?.walkId).toBe(p.id);
    }
    // 已经领取的批次：动作过时
    const p0 = parts[0] as LiveWalk;
    st.ok({ type: 'ClaimWalk', walkId: p0.id }, 'P1');
    expect(st.run({ type: 'IssueRecommendation', draft: { module: 'PICKING', target: `SPLIT:${p0.id}`, action: { kind: 'SPLIT_WALK', params: { walkId: p0.id, groups: p0.toteIds.join(',') } }, confidence: 0.7, reasons: [], alternatives: [], model: { id: 'm', version: 1, kind: 'k' }, expiresAt: st.now + MIN } }, 'ai').decision.ok).toBe(false);
  });

  it('拣到一半转给别人：没拣的行进新批次（补新框、打新标签），原批次只留拣了的、可以马上完成；一件都没拣的框作废', () => {
    const st = new Store();
    const w = st.walkWith('AMBIENT');
    // 状态是就地更新的：先留一份原批次
    const orig = structuredClone(w);
    st.claimAndBind(w);
    // 只拣第一站
    const s0 = w.stops[0];
    if (!s0) throw new Error('no stop');
    for (const p of s0.picks) st.ok({ type: 'PickItem', walkId: w.id, toteId: p.toteId, lineId: p.lineId, qty: p.qty }, 'P1');
    const touched = new Set(s0.picks.map((p) => p.toteId));
    const before = Object.keys(st.s.walks).length;
    // 别人不能替他转交
    expect((st.run({ type: 'HandOverLines', walkId: w.id }, 'P2').decision as { ok: false; reject: { code: string } }).reject.code).toBe('WALK_NOT_YOURS');
    const ev = st.ok({ type: 'HandOverLines', walkId: w.id }, 'P1');
    expect(ev.filter((e) => e.type === 'LabelPrinted').length).toBeGreaterThan(0);
    expect(Object.keys(st.s.walks).length).toBe(before + 1);
    const nw = Object.values(st.s.walks).find((x) => x.status === 'OPEN' && x.priority && x.id !== w.id) as LiveWalk;
    expect(nw.toteIds.every((id) => !orig.toteIds.includes(id))).toBe(true);
    for (const id of nw.toteIds) expect(st.s.totes[id]?.labelId).toBeDefined();
    // 原批次：只剩拣了的，马上可以完成；一件都没拣的框从订单里去掉
    const cur = st.s.walks[w.id] as LiveWalk;
    expect(cur.stops).toHaveLength(1);
    expect(cur.toteIds.every((id) => touched.has(id))).toBe(true);
    for (const id of orig.toteIds.filter((x) => !touched.has(x))) expect(st.s.totes[id]).toBeUndefined();
    st.ok({ type: 'CompleteWalk', walkId: w.id }, 'P1');
    // 新批次由另一位拣货员领取、拣完
    st.claimAndBind(nw, 'P2');
    for (const x of nw.stops) for (const p of x.picks) st.ok({ type: 'PickItem', walkId: nw.id, toteId: p.toteId, lineId: p.lineId, qty: p.qty }, 'P2');
    st.ok({ type: 'CompleteWalk', walkId: nw.id }, 'P2');
    // 原批次里的每一行都拣齐了（两个批次加起来）
    const want = new Map<string, number>();
    for (const x of orig.stops) for (const p of x.picks) {
      const k = `${p.toteId.split('-T')[0]}|${p.lineId}`;
      want.set(k, (want.get(k) ?? 0) + p.qty);
    }
    for (const [k, qty] of want) {
      const [oid, lineId] = k.split('|') as [string, string];
      expect(st.s.orders[oid]?.lineResults[lineId]?.picked ?? 0).toBe(qty);
    }
  });

  it('AI 标出冷链风险：只有 AI 服务可以标；拣货员的手机上提前提醒（紧急）', async () => {
    const st = new Store();
    const w = st.walkWith('AMBIENT');
    st.claimAndBind(w);
    expect(st.run({ type: 'FlagColdRisk', walkId: w.id, overSec: 300, remainingLines: 3 }, 'P1').decision.ok).toBe(false);
    st.ok({ type: 'FlagColdRisk', walkId: w.id, overSec: 300, remainingLines: 3 }, 'ai');
    expect(st.s.walks[w.id]?.coldRisk).toMatchObject({ overSec: 300, remainingLines: 3 });
    const { planNudges } = await import('./nudges');
    // 只有拣货中的批次才提醒
    const s0 = w.stops[0] as LiveWalk['stops'][number];
    const p0 = s0.picks[0] as LiveWalk['stops'][number]['picks'][number];
    st.ok({ type: 'PickItem', walkId: w.id, toteId: p0.toteId, lineId: p0.lineId, qty: 1 }, 'P1');
    const n = planNudges(st.s, statics, st.now).send.find((x) => x.topic === `COLDRISK:${w.id}`);
    expect(n).toMatchObject({ to: 'P1', kind: 'COLD', urgent: true });
    expect(n?.params?.over).toBe(5);
  });
});

describe('分框学习（决策记录 0023 · B7）', () => {
  it('框装满了加一个框：还没拣的行挪进新框（已绑定），记一次加框；学到的系数让之后锁单时多分框', () => {
    const st = new Store();
    const w = st.walkWith('AMBIENT');
    st.claimAndBind(w);
    const t0 = w.toteIds.find((id) => w.stops.some((x) => x.picks.some((p) => p.toteId === id))) as string;
    const oid = st.s.totes[t0]?.orderId as string;
    const n0 = st.s.orders[oid]?.toteIds.length as number;
    st.ok({ type: 'AddTote', walkId: w.id, toteId: t0 }, 'P1');
    const o = st.s.orders[oid];
    expect(o?.toteIds.length).toBe(n0 + 1);
    const nt = o?.toteIds.at(-1) as string;
    expect(st.s.walks[w.id]?.bound).toContain(nt);
    expect(st.s.walks[w.id]?.stops.some((x) => x.picks.some((p) => p.toteId === nt))).toBe(true);
    expect(st.s.walks[w.id]?.stops.some((x) => x.picks.some((p) => p.toteId === t0 && p.qty > 0))).toBe(false);
    expect(st.s.overflows).toBe(1);
    // 分框系数：只有 AI 服务可以写；范围 0.8–1.6
    const cats = [...new Set(catalog.items.map((it) => it.categoryId))];
    expect(st.run({ type: 'UpdateToteFactors', factors: { x: 1.2 } }, 'P1').decision.ok).toBe(false);
    st.ok({ type: 'UpdateToteFactors', factors: Object.fromEntries(cats.map((c) => [c, 9])) }, 'ai');
    expect(Object.values(st.s.toteFactors ?? {}).every((v) => v === 1.6)).toBe(true);
    // 同一张订单（换个编号）在系数 1.6 下锁单：框不会更少，大多数情况下更多
    const base = new Store();
    const more = new Store();
    more.ok({ type: 'UpdateToteFactors', factors: Object.fromEntries(cats.map((c) => [c, 1.6])) }, 'ai');
    let a = 0;
    let b = 0;
    for (let i = 0; i < 8; i++) {
      for (const [k, x] of [[0, base], [1, more]] as const) {
        const ord = orders[i];
        if (!ord) continue;
        const info = orderInfoFrom({ ...ord, id: `Q${i}`, shortCode: `Q${i}` }, catalog.byId, x.now + 60 * MIN, rules.slotLengthMin);
        x.ok({ type: 'CreateOrder', order: info, codeHash: 'x' });
        x.ok({ type: 'LockOrder', orderId: info.id });
        const count = x.s.orders[info.id]?.toteIds.length ?? 0;
        if (k === 0) a += count;
        else b += count;
      }
    }
    expect(b).toBeGreaterThan(a);
  });
});
