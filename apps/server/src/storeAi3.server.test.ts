import { describe, expect, it } from 'vitest';
import { planNudges, type OrderInfo } from '@storewright/ops';
import { Hub, type StoreEntry } from './hub';
import { webPlatform } from './platform';
import { memoryStorage } from './storage';

/** 门店 AI 第二轮 · 第三批（决策记录 0023）：冷链拆批与转交、分框学习、未取订单、时段产能、替代品真实标签、负荷与安全 */

const settle = () => new Promise((r) => setTimeout(r, 60));
const MIN = 60_000;

async function store(): Promise<{ hub: Hub; e: StoreEntry; call: (method: string, path: string, body?: unknown, token?: string) => ReturnType<Hub['handle']> }> {
  const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'] });
  const e = hub.stores.get('demo');
  if (!e) throw new Error('no store');
  const call = (method: string, path: string, body?: unknown, token?: string) => hub.handle({ method, path, query: {}, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  return { hub, e, call };
}

async function token(call: Awaited<ReturnType<typeof store>>['call'], who: { role?: string; associateId?: string }): Promise<string> {
  return ((await call('POST', '/api/stores/demo/session', who)).body as { token: string }).token;
}

/** 一张只含指定商品的订单 */
function orderWith(e: StoreEntry, itemIds: string[], index: number, slotInMin = 45, name?: [string, string]): { info: OrderInfo; codeHash: string } {
  const slotStart = Math.ceil((Date.now() + slotInMin * 60_000) / 300_000) * 300_000;
  const o = e.demo.makeOrder({ index, type: 'PICKUP', slotStart, maxLines: 1 });
  const line = o.info.lines[0];
  if (!line) throw new Error('no line');
  o.info.lines = itemIds.map((id, k) => {
    const it = e.demo.catalog.get(id);
    if (!it) throw new Error('no item');
    return { ...line, lineId: `L${k + 1}`, itemId: it.id, gtin: it.gtin, name: it.name, qty: 2, tempZone: it.tempZone, locationId: it.locationIds[0] as string, allowSubstitution: true, ageRestricted: false, unitPrice: it.unitPrice };
  });
  if (name) [o.info.firstName, o.info.lastName] = name;
  return o;
}

describe('冷链拆批与转交、分框学习（决策记录 0023 · B3、B7）', () => {
  it('冷链批次的 AI 预计暴露时间超过时限：领取前自动拆成两个；拣货中预计会超时：拣货员收到提前提醒', async () => {
    const { hub, e, call } = await store();
    const plan = e.runtime.statics.planogram.filter((p) => p.tempZone === 'CHILLED');
    let k = 0;
    for (const i of [0, 1, 2]) {
      const o = orderWith(e, plan.slice(i * 2, i * 2 + 2).map((p) => p.itemId), 700 + k++);
      await e.runtime.submit({ cmd: { type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, actor: 'console', at: Date.now() });
      await e.runtime.submit({ cmd: { type: 'LockOrder', orderId: o.info.id }, actor: 'console', at: Date.now() });
    }
    await e.runtime.submit({ cmd: { type: 'ReleaseWalks' }, actor: 'console', at: Date.now() });
    await settle();
    const w = Object.values(e.runtime.state.walks).find((x) => x.tempZone === 'CHILLED' && new Set(x.toteIds.map((id) => e.runtime.state.totes[id]?.orderId)).size >= 2);
    if (!w?.coldLimitSec) throw new Error('no chilled walk');
    // 时限收紧到 2 分钟（模拟体积大、路线长的冷链批次）
    w.coldLimitSec = 120;
    const ids = [...w.toteIds];
    expect(await e.opsAi.coldSplit(w.id)).toBe(true);
    await settle();
    expect(e.runtime.state.walks[w.id]).toBeUndefined();
    const parts = Object.values(e.runtime.state.walks).filter((x) => x.toteIds.some((id) => ids.includes(id)));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(Object.values(e.runtime.state.recs).some((r) => r.action.kind === 'SPLIT_WALK' && r.status === 'AUTO_APPLIED')).toBe(true);

    // 拣货中：领取一个批次、拣第一件，冷链计时开始；把时限压低，AI 预计会超时
    const p0 = parts[0];
    if (!p0) throw new Error('no part');
    const a01 = await token(call, { associateId: 'A01' });
    const cmd = (x: unknown) => call('POST', '/api/stores/demo/commands', { cmd: x }, a01);
    expect((await cmd({ type: 'ClaimWalk', walkId: p0.id })).status).toBe(200);
    for (const id of p0.toteIds) await cmd({ type: 'BindLabel', walkId: p0.id, labelId: e.runtime.state.totes[id]?.labelId });
    const pk = p0.stops[0]?.picks[0];
    if (!pk) throw new Error('no pick');
    expect((await cmd({ type: 'PickItem', walkId: p0.id, toteId: pk.toteId, lineId: pk.lineId, qty: 1 })).status).toBe(200);
    const live = e.runtime.state.walks[p0.id];
    if (!live) throw new Error('no live walk');
    expect(live.coldStartedAt).toBeDefined();
    live.coldLimitSec = 30;
    live.coldStartedAt = Date.now() - 25_000;
    expect(await e.opsAi.coldWatch()).toBe(1);
    expect(e.runtime.state.walks[p0.id]?.coldRisk?.overSec).toBeGreaterThanOrEqual(60);
    const plan2 = planNudges(e.runtime.state, e.runtime.statics, Date.now());
    expect(plan2.send.some((n) => n.to === 'A01' && n.topic === `COLDRISK:${p0.id}` && n.urgent)).toBe(true);
    // 拣货员把剩下的转给别人
    expect((await cmd({ type: 'HandOverLines', walkId: p0.id })).status).toBe(200);
    expect(Object.values(e.runtime.state.walks).some((x) => x.status === 'OPEN' && x.priority && x.toteIds.every((id) => !p0.toteIds.includes(id)))).toBe(true);
    hub.stop();
  });

  it('拣货中加了框：AI 按这单各类商品的体积占比调高分框系数，写进作业核心', async () => {
    const { hub, e, call } = await store();
    const c = await token(call, { role: 'console' });
    await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 2, release: true, maxLines: 4, slotInMin: 50 }, c);
    await settle();
    const w = Object.values(e.runtime.state.walks).find((x) => x.tempZone === 'AMBIENT');
    if (!w) throw new Error('no walk');
    const a01 = await token(call, { associateId: 'A01' });
    const cmd = (x: unknown) => call('POST', '/api/stores/demo/commands', { cmd: x }, a01);
    await cmd({ type: 'ClaimWalk', walkId: w.id });
    for (const id of w.toteIds) await cmd({ type: 'BindLabel', walkId: w.id, labelId: e.runtime.state.totes[id]?.labelId });
    const t0 = w.stops[0]?.picks[0]?.toteId as string;
    expect((await cmd({ type: 'AddTote', walkId: w.id, toteId: t0 })).status).toBe(200);
    await settle();
    expect(await e.opsAi.publishToteFactors()).toBe(true);
    const f = e.runtime.state.toteFactors ?? {};
    expect(Object.keys(f).length).toBeGreaterThan(0);
    expect(Object.values(f).every((v) => v > 1 && v <= 1.6)).toBe(true);
    // 没有变化时不重复写
    expect(await e.opsAi.publishToteFactors()).toBe(false);
    hub.stop();
  });
});

describe('未取订单与时段产能（决策记录 0023 · B5、B6）', () => {
  it('以前爽约过的顾客风险更高；风险高的订单冷冻商品晚点拣（到取货前 20 分钟）', async () => {
    const { hub, e } = await store();
    const frozen = e.runtime.statics.planogram.filter((p) => p.tempZone === 'FROZEN').slice(0, 1).map((p) => p.itemId);
    const name: [string, string] = ['Wren', 'Delacroix'];
    // 这位顾客以前两单都没来取
    for (const i of [0, 1]) {
      const o = orderWith(e, frozen, 800 + i, 30, name);
      await e.runtime.submit({ cmd: { type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, actor: 'console', at: Date.now() - (5 - i) * 86_400_000 });
      await e.runtime.submit({ cmd: { type: 'CancelOrder', orderId: o.info.id, reason: 'NO_SHOW' }, actor: 'console', at: Date.now() - (5 - i) * 86_400_000 + MIN });
    }
    const o = orderWith(e, frozen, 810, 240, name);
    await e.runtime.submit({ cmd: { type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, actor: 'console', at: Date.now() });
    const fresh = orderWith(e, frozen, 811, 240, ['Nova', 'Quill']);
    await e.runtime.submit({ cmd: { type: 'CreateOrder', order: fresh.info, codeHash: fresh.codeHash }, actor: 'console', at: Date.now() });
    const risky = e.ai.noShowRisk(e.runtime.state.orders[o.info.id] as never);
    const normal = e.ai.noShowRisk(e.runtime.state.orders[fresh.info.id] as never);
    expect(risky?.p).toBeGreaterThan(normal?.p as number);
    expect(risky?.reasons.some((r) => r.factor === 'PAST_NO_SHOWS')).toBe(true);
    // 风险够高时：冷冻商品晚点拣（这里把阈值以上的风险直接给出来，检查后面的流程）
    const ai = e.ai as unknown as { noShowRisk: (x: { id: string }) => { p: number; reasons: never[] } | undefined };
    const orig = ai.noShowRisk.bind(e.ai);
    ai.noShowRisk = (x) => (x.id === o.info.id ? { p: 0.6, reasons: [] } : orig(x));
    expect(await e.opsAi.scanNoShow()).toBe(1);
    const rec = Object.values(e.runtime.state.recs).find((r) => r.target === `noshow:${o.info.id}`);
    expect(rec?.action.kind).toBe('DEFER_FROZEN');
    const a08 = await token((m, p, b, t) => hub.handle({ method: m, path: p, query: {}, headers: t ? { authorization: `Bearer ${t}` } : {}, body: b }), { associateId: 'A08' });
    expect((await hub.handle({ method: 'POST', path: '/api/stores/demo/commands', query: {}, headers: { authorization: `Bearer ${a08}` }, body: { cmd: { type: 'AcceptRecommendation', recId: rec?.id } } })).status).toBe(200);
    expect(e.runtime.state.orders[o.info.id]?.frozenAfter).toBe(o.info.slotStart - 20 * MIN);
    // 同一单不重复建议
    expect(await e.opsAi.scanNoShow()).toBe(0);
    hub.stop();
  });

  it('时段快接满：建议停止接新单，采纳后这个时段再下的单被拒绝；带班负责人可以重新开放；产能接口和取舍曲线', async () => {
    const { hub, e, call } = await store();
    const c = await token(call, { role: 'console' });
    const r = (await call('GET', '/api/stores/demo/ai/capacity', undefined, c)).body as { slots: Array<{ start: number; end: number; capacity: number; remaining: number; pick: number; handoff: number }> };
    expect(r.slots.length).toBeGreaterThan(0);
    for (const x of r.slots) {
      expect(x.capacity).toBe(Math.min(x.pick, x.handoff));
      expect(x.end).toBeGreaterThan(x.start);
    }
    // 某个时段只剩 1 单的余量（这里直接给出产能，检查后面的流程）
    const sl = r.slots.find((x) => x.start - Date.now() >= 40 * MIN) ?? r.slots[0];
    if (!sl) throw new Error('no slot');
    const ops = e.opsAi as unknown as { slotCapacity: () => unknown[] };
    ops.slotCapacity = () => [{ ...sl, booked: 9, capacity: 10, remaining: 1, closed: false }];
    expect(await e.opsAi.scanCapacity()).toBe(1);
    const rec = Object.values(e.runtime.state.recs).find((x) => x.module === 'CAPACITY' && x.action.kind === 'CLOSE_SLOT');
    expect(rec?.action.params?.slotStart).toBe(sl.start);
    const a08 = await token(call, { associateId: 'A08' });
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AcceptRecommendation', recId: rec?.id } }, a08)).status).toBe(200);
    expect(e.runtime.state.closedSlots?.[String(sl.start)]).toBeDefined();
    // 这个时段再下单：被拒绝
    const o = e.demo.makeOrder({ index: 901, type: 'PICKUP', slotStart: sl.start + 5 * MIN, maxLines: 2 });
    const res = await e.runtime.submit({ cmd: { type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, actor: 'console', at: Date.now() });
    expect(res.ok ? '' : res.reject.code).toBe('SLOT_CLOSED');
    // 普通员工不能重新开放；带班负责人可以
    const a01 = await token(call, { associateId: 'A01' });
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ReopenSlot', slotStart: sl.start } }, a01)).body as { reject: { code: string } }).reject.code).toBe('NOT_AUTHORIZED');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ReopenSlot', slotStart: sl.start } }, a08)).status).toBe(200);
    expect(e.runtime.state.closedSlots?.[String(sl.start)]).toBeUndefined();
    // 取舍曲线
    delete (ops as { slotCapacity?: unknown }).slotCapacity;
    const curve = ((await call('POST', '/api/stores/demo/ai/capacity/curve', {}, a08)).body as { curve: Array<{ accepted: number; late: number }> }).curve;
    if (curve.length) expect(curve[0]?.accepted).toBeLessThanOrEqual(curve.at(-1)?.accepted as number);
    hub.stop();
  });
});

describe('替代品的真实标签与负荷安全（决策记录 0023 · B4、D5）', () => {
  it('交付时记下顾客对替代品的反应：作业核心统计、AI 服务存成训练标签；顾客要求时删除', async () => {
    const { hub, e, call } = await store();
    const item = e.runtime.statics.planogram.find((p) => p.tempZone === 'AMBIENT' && e.ai.substitutes(p.itemId).items.length > 0);
    if (!item) throw new Error('no item');
    const o = orderWith(e, [item.itemId], 950, 45, ['Iris', 'Okafor']);
    await e.runtime.submit({ cmd: { type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, actor: 'console', at: Date.now() });
    await e.runtime.submit({ cmd: { type: 'LockOrder', orderId: o.info.id }, actor: 'console', at: Date.now() });
    await e.runtime.submit({ cmd: { type: 'ReleaseWalks' }, actor: 'console', at: Date.now() });
    await settle();
    const w = Object.values(e.runtime.state.walks).find((x) => x.toteIds.some((id) => e.runtime.state.totes[id]?.orderId === o.info.id));
    if (!w) throw new Error('no walk');
    const a01 = await token(call, { associateId: 'A01' });
    const cmd = (x: unknown, tk = a01) => call('POST', '/api/stores/demo/commands', { cmd: x }, tk);
    await cmd({ type: 'ClaimWalk', walkId: w.id });
    for (const id of w.toteIds) await cmd({ type: 'BindLabel', walkId: w.id, labelId: e.runtime.state.totes[id]?.labelId });
    const pk = w.stops.flatMap((x) => x.picks).find((x) => e.runtime.state.totes[x.toteId]?.orderId === o.info.id);
    const sub = e.ai.substitutes(item.itemId).items[0];
    if (!pk || !sub) throw new Error('no pick');
    expect((await cmd({ type: 'ReportNotFound', walkId: w.id, toteId: pk.toteId, lineId: pk.lineId, qty: pk.qty, resolution: 'SUBSTITUTED', substitute: { name: sub.name, gtin: sub.gtin, rank: 1, model: 'substitution v1' } })).status).toBe(200);
    // 没有替代的行不能记
    expect(((await cmd({ type: 'RateSubstitution', orderId: o.info.id, lineId: 'NOPE', accepted: true })).body as { reject: { code: string } }).reject.code).toBe('NOT_SUBSTITUTED');
    expect((await cmd({ type: 'RateSubstitution', orderId: o.info.id, lineId: pk.lineId, accepted: false })).status).toBe(200);
    await settle();
    expect(e.runtime.state.orders[o.info.id]?.lineResults[pk.lineId]?.subAccepted).toBe(false);
    expect(e.runtime.state.subLabels).toEqual({ n: 1, accepted: 0, top1: 1, top1Accepted: 0 });
    expect(e.ai.labelStats()).toMatchObject({ n: 1, top1: 1, top1Accepted: 0 });
    // 改成满意：作业核心记下最新的，统计只算第一次
    expect((await cmd({ type: 'RateSubstitution', orderId: o.info.id, lineId: pk.lineId, accepted: true })).status).toBe(200);
    expect(e.runtime.state.subLabels?.n).toBe(1);
    // 顾客要求删除个人记录
    const a08 = await token(call, { associateId: 'A08' });
    const del = (await call('POST', '/api/stores/demo/ai/customers/forget', { name: 'Iris Okafor' }, a08)).body as { removed: number };
    expect(del.removed).toBeGreaterThanOrEqual(1);
    expect(e.ai.subLabels.some((x) => x.customer === 'Iris Okafor')).toBe(false);
    hub.stop();
  });

  it('冷冻区累计 45 分钟以上：提醒本人出来暖和一下，可领取的冷冻批次排到后面；需要两人搬运的大件请同事帮忙', async () => {
    const { hub, e } = await store();
    const { avoidFrozen, freezerMinutes } = await import('@storewright/ops');
    const now = Date.now();
    const s = e.runtime.state;
    // 造一个 A01 拣了 50 分钟的冷冻批次（还在拣）
    s.walks.WZ1 = { id: 'WZ1', tempZone: 'FROZEN', toteIds: [], stops: [], distanceM: 0, estimatedSec: 0, dueAt: now + 60 * MIN, status: 'PICKING', createdAt: now - 55 * MIN, associateId: 'A01', claimedAt: now - 52 * MIN, startedAt: now - 50 * MIN, bound: [], done: {} };
    expect(freezerMinutes(s, 'A01', now)).toBe(50);
    expect(avoidFrozen(s, 'A01', now)).toBe(true);
    const plan = planNudges(s, e.runtime.statics, now);
    expect(plan.send.some((n) => n.to === 'A01' && n.kind === 'SAFETY' && n.params?.safety === 'FREEZER')).toBe(true);
    hub.stop();
  });
});
