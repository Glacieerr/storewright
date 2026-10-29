import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forecast } from '@storewright/twin';
import { dutyOf, sellableCases, type OrderInfo } from '@storewright/ops';
import { Hub, type StoreEntry } from './hub';
import { webPlatform } from './platform';
import { memoryStorage } from './storage';

/** 门店 AI 第二轮 · 第一批（决策记录 0021）：拣货时长、订单量展望、缺货预判、运营预警、建议中枢 */

const settle = () => new Promise((r) => setTimeout(r, 60));

// 营业时间外只发紧急的提醒、在岗按班次判断：固定在今天上午 11 点跑（时钟照常走），结果不随跑测试的时刻变
beforeEach(() => {
  const t = new Date();
  t.setHours(11, 0, 0, 0);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(t);
});
afterEach(() => {
  vi.useRealTimers();
});

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

/** 一张只含指定商品的订单（时段在 slotInMin 分钟后） */
function orderWith(e: StoreEntry, itemId: string, index: number, slotInMin = 45): { info: OrderInfo; codeHash: string } {
  const slotStart = Math.ceil((Date.now() + slotInMin * 60_000) / 300_000) * 300_000;
  const o = e.demo.makeOrder({ index, type: 'PICKUP', slotStart, maxLines: 1 });
  const it = e.demo.catalog.get(itemId);
  if (!it) throw new Error('no item');
  const line = o.info.lines[0];
  if (!line) throw new Error('no line');
  o.info.lines = [{ ...line, itemId: it.id, gtin: it.gtin, name: it.name, qty: 2, tempZone: it.tempZone, locationId: it.locationIds[0] as string, allowSubstitution: true, ageRestricted: false, unitPrice: it.unitPrice }];
  return o;
}

describe('拣货时长与订单量展望（决策记录 0021 · B1、A1）', () => {
  it('批次生成时写进 AI 预计用时，领取时按领取人的熟练度组再估一次；展望发布后推演改用 AI 的订单量', async () => {
    const { hub, e, call } = await store();
    expect(e.ai.registry.champion('pick-time')?.kind).toBe('pick-model');
    const c = await token(call, { role: 'console' });
    await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 3, release: true, maxLines: 4, slotInMin: 50 }, c);
    await settle();
    const walks = Object.values(e.runtime.state.walks);
    expect(walks.length).toBeGreaterThan(0);
    for (const w of walks) {
      expect(w.ai?.sec).toBeGreaterThan(0);
      expect(w.ai?.low).toBeLessThanOrEqual(w.ai?.sec as number);
      expect(w.ai?.tenure).toBe('MID');
    }
    // A02 是新人（入职不到 3 个月）：领取后重新估，用时更长
    const w = walks[0];
    const before = w?.ai?.sec as number;
    const a02 = await token(call, { associateId: 'A02' });
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ClaimWalk', walkId: w?.id } }, a02)).status).toBe(200);
    await settle();
    const after = e.runtime.state.walks[w?.id as string]?.ai;
    expect(after?.tenure).toBe('NEW');
    expect(after?.sec).toBeGreaterThan(before);

    // 订单量展望：营业时间内的某个时刻
    const at = new Date();
    at.setHours(15, 0, 0, 0);
    expect(await e.opsAi.maybeOutlook(at.getTime())).toBe(true);
    const ol = e.runtime.state.outlook;
    expect(ol?.hours.length).toBeGreaterThan(0);
    expect(ol?.hours[0]?.high).toBeGreaterThanOrEqual(ol?.hours[0]?.mean as number);
    const f = forecast(e.runtime.state, e.runtime.statics, at.getTime() + 60_000);
    expect(f.basis.demand).toBe('OUTLOOK');
    expect(forecast(e.runtime.state, e.runtime.statics, at.getTime() + 60_000, { noOutlook: true }).basis.demand).toBe('RECENT');
    // 悲观的订单量不会让结果更好
    const hi = forecast(e.runtime.state, e.runtime.statics, at.getTime() + 60_000, { band: 'high' });
    expect(hi.kpi.projectedOrders).toBeGreaterThanOrEqual(f.kpi.projectedOrders);
    hub.stop();
  });
});

describe('缺货预判（决策记录 0021 · B2）', () => {
  it('货架估算为 0、后仓有货：拣货前先安排补货（截止时间是拣货员预计走到的时刻）；后仓也没有：提前排好替代', async () => {
    const { hub, e, call } = await store();
    const s = e.runtime.state;
    const plan = e.runtime.statics.planogram.filter((p) => p.tempZone === 'AMBIENT');
    const withStock = plan.find((p) => sellableCases(s, p.itemId).length > 0);
    const noStock = plan.find((p) => sellableCases(s, p.itemId).length === 0 && e.ai.substitutes(p.itemId).items.length > 0);
    if (!withStock || !noStock) throw new Error('no items');
    const a10 = await token(call, { associateId: 'A10' });
    // 后仓有货的商品货架上只剩 1 件（不够这一单的 2 件）；后仓没货的商品货架上 0 件
    for (const [p, units] of [[withStock, 1], [noStock, 0]] as const) expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ConfirmShelf', itemId: p.itemId, units } }, a10)).status).toBe(200);
    let i = 0;
    for (const p of [withStock, noStock]) {
      const o = orderWith(e, p.itemId, 900 + i++);
      expect((await e.runtime.submit({ cmd: { type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, actor: 'console', at: Date.now() })).ok).toBe(true);
      await e.runtime.submit({ cmd: { type: 'LockOrder', orderId: o.info.id }, actor: 'console', at: Date.now() });
    }
    await e.runtime.submit({ cmd: { type: 'ReleaseWalks' }, actor: 'console', at: Date.now() });
    await settle();
    // 货架低于补货线时已经有一个补货任务：AI 把它提前到拣货员走到之前，而不是再建一个
    const tasks = Object.values(e.runtime.state.repl).filter((t) => t.itemId === withStock.itemId);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task?.dueAt).toBeGreaterThan(Date.now() - 1000);
    expect(task?.priority).toBe(0);
    const flags = Object.values(e.runtime.state.walks).flatMap((w) => Object.values(w.flags ?? {}));
    expect(flags.some((f) => f.pullTaskId === task?.id && f.readyAt === task?.dueAt && f.p < 0.4)).toBe(true);
    expect(flags.some((f) => (f.subs?.length ?? 0) > 0 && f.p < 0.4)).toBe(true);
    // 给订单平台的「找得到的概率」接口
    const c = await token(call, { role: 'console' });
    const av = (await hub.handle({ method: 'GET', path: '/api/stores/demo/ai/availability', query: { itemIds: noStock.itemId }, headers: { authorization: `Bearer ${c}` }, body: undefined })).body as { items: Array<{ itemId: string; pFind: number; likelyOut: boolean }> };
    expect(av.items[0]?.itemId).toBe(noStock.itemId);
    expect(av.items[0]?.likelyOut).toBe(true);
    hub.stop();
  });
});

describe('运营预警与建议中枢（决策记录 0021 · A2、G1）', () => {
  it('订单一下子很多、拣货员不够：提前发现会有订单赶不上，给出试过的办法；提醒发给带班负责人，处理后关闭', async () => {
    const { hub, e, call } = await store();
    const c = await token(call, { role: 'console' });
    for (let k = 0; k < 2; k++) await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 20, release: true, maxLines: 5, slotInMin: 25 }, c);
    await settle();
    // 名单上拣货员很多，但真正在干活的只有 A01（推演只算在岗、最近有扫描或手上有任务的人）
    const a01 = await token(call, { associateId: 'A01' });
    const w0 = Object.values(e.runtime.state.walks).find((w) => w.status === 'OPEN');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ClaimWalk', walkId: w0?.id } }, a01)).status).toBe(200);
    const r = await e.opsAi.scanForesight();
    expect(r?.problems.some((p) => p.kind === 'LATE')).toBe(true);
    const rec = Object.values(e.runtime.state.recs).find((x) => x.module === 'FORESIGHT' && x.status === 'OPEN' && x.target === 'LATE');
    expect(rec).toBeDefined();
    expect(rec?.prediction?.value).toBeLessThan(rec?.prediction?.baseline as number);
    expect(rec?.reasons[0]?.factor).toBe('PROBLEM_LATE');
    // 办法不能让别的主要指标变差：迟到不变多、平均等待最多长一成（走查时发现过只缩短最长等待、平均等待反而变长的调人建议）
    for (const x of Object.values(e.runtime.state.recs).filter((r) => r.module === 'FORESIGHT')) {
      const p = x.action.params ?? {};
      expect(Number(p.lateAfter)).toBeLessThanOrEqual(Number(p.lateBefore));
      expect(Number(p.waitAfter)).toBeLessThanOrEqual(Number(p.waitBefore) + Math.max(1, 0.1 * Number(p.waitBefore)));
    }

    // 建议中枢：发给在岗的带班负责人（A08）
    await e.opsAi.syncNudges();
    const nudge = Object.values(e.runtime.state.nudges).find((n) => n.to === 'A08' && n.refs.includes(rec?.id as string));
    expect(nudge).toBeDefined();
    const a08 = await token(call, { associateId: 'A08' });
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ReadNudge', nudgeId: nudge?.id } }, a01)).body as { reject: { code: string } }).reject.code).toBe('NOT_YOURS');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ReadNudge', nudgeId: nudge?.id } }, a08)).status).toBe(200);
    expect(e.runtime.state.nudges[nudge?.id as string]?.status).toBe('READ');
    // 同一组没处理完的提醒不重复发
    const n0 = Object.keys(e.runtime.state.nudges).length;
    await e.opsAi.syncNudges();
    // 两位带班负责人（A08、A27）各一条，同一个人不重复
    expect(Object.values(e.runtime.state.nudges).filter((n) => n.to === 'A08' && n.refs.includes(rec?.id as string))).toHaveLength(1);
    expect(Object.values(e.runtime.state.nudges).filter((n) => n.to === 'A27' && n.refs.includes(rec?.id as string))).toHaveLength(1);
    expect(Object.keys(e.runtime.state.nudges).length).toBeGreaterThanOrEqual(n0);
    // 采纳后执行动作，提醒关闭
    const acc = await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AcceptRecommendation', recId: rec?.id } }, a08);
    expect(acc.status).toBe(200);
    // 同一个提醒里合并了几条运营预警：都处理完才关闭
    for (const id of nudge?.refs ?? []) if (e.runtime.state.recs[id]?.status === 'OPEN') await call('POST', '/api/stores/demo/commands', { cmd: { type: 'DismissRecommendation', recId: id } }, a08);
    await e.opsAi.syncNudges();
    expect(e.runtime.state.nudges[nudge?.id as string]?.status).toBe('DONE');
    const stats = (await call('GET', '/api/stores/demo/ai/nudges', undefined, a08)).body as { lastHour: number; deferred: Record<string, number> };
    expect(stats.lastHour).toBeGreaterThan(0);
    hub.stop();
  });
});

describe('排班生成与当日补位（决策记录 0022 · D1、D2）', () => {
  it('按订单量预测和名单生成下周排班草稿，硬约束全部满足、比固定班表缺口少；发布后按排班判断谁在岗', async () => {
    const { hub, e, call } = await store();
    const a08 = await token(call, { associateId: 'A08' });
    const r = (await call('POST', '/api/stores/demo/ai/schedule/draft', {}, a08)).body as { ok: boolean; week: string; shifts: Array<{ associateId: string; date: string; from: number; to: number; role: string }>; metrics: { violations: string[]; underHours: number; overHours: number }; naive: { underHours: number; overHours: number }; gaps: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.metrics.violations).toEqual([]);
    expect(r.metrics.underHours).toBeLessThan(r.naive.underHours);
    expect(r.metrics.overHours).toBeLessThan(r.naive.overHours);
    // 学生只排在上学日放学后、每天不超过 4 小时
    for (const sh of r.shifts.filter((x) => ['A12', 'A13', 'A23', 'A24'].includes(x.associateId))) {
      const dow = new Date(`${sh.date}T12:00:00`).getDay();
      if (dow >= 1 && dow <= 5) {
        expect(sh.from).toBeGreaterThanOrEqual(16 * 60);
        expect(sh.to - sh.from).toBeLessThanOrEqual(240);
      }
    }
    // 普通员工不能发布排班；带班负责人可以
    const a01 = await token(call, { associateId: 'A01' });
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'PublishSchedule', week: r.week, shifts: r.shifts } }, a01)).body as { reject: { code: string } }).reject.code).toBe('NOT_AUTHORIZED');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'PublishSchedule', week: r.week, shifts: r.shifts } }, a08)).status).toBe(200);
    expect(e.runtime.state.schedules?.[r.week]?.shifts.length).toBe(r.shifts.length);
    hub.stop();
  });

  it('报告缺勤后，AI 找能补这个班的人（会这个岗位、这段时间能上班、这周还有工时、不加班的在前）；采纳后发邀请，本人接受后在岗', async () => {
    const { hub, e, call } = await store();
    const a08 = await token(call, { associateId: 'A08' });
    const { dateOf, onDuty, shiftsOn } = await import('@storewright/ops');
    const today = dateOf(Date.now());
    // 本周排班：只给几个人排今天的班（A02 缺勤的那个班要有人补）
    const { weekOf } = await import('@storewright/ops');
    const week = weekOf(today);
    const shifts = [
      { associateId: 'A02', date: today, from: 8 * 60, to: 16 * 60, role: 'PICK' as const },
      { associateId: 'A14', date: today, from: 10 * 60, to: 18 * 60, role: 'PICK' as const },
      { associateId: 'A08', date: today, from: 7 * 60, to: 15 * 60, role: 'LEAD' as const },
    ];
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'PublishSchedule', week, shifts } }, a08)).status).toBe(200);
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ReportAbsence', associateId: 'A02', date: today, reason: 'sick' } }, a08)).status).toBe(200);
    await settle();
    const rec = Object.values(e.runtime.state.recs).find((x) => x.module === 'STAFFING' && x.target.startsWith('absence:') && x.status === 'OPEN');
    expect(rec?.action.kind).toBe('OFFER_SHIFT');
    const who = String(rec?.action.params?.associateId);
    expect(who).not.toBe('A02');
    expect(rec?.reasons[0]?.factor).toBe('ABSENCE');
    expect(rec?.alternatives.length).toBeGreaterThan(0);
    // 采纳 → 给这个人发邀请（他收到提醒）
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AcceptRecommendation', recId: rec?.id } }, a08)).status).toBe(200);
    const offer = Object.values(e.runtime.state.offers ?? {}).find((o) => o.associateId === who && o.status === 'PENDING');
    expect(offer).toBeDefined();
    await e.opsAi.syncNudges();
    expect(Object.values(e.runtime.state.nudges).some((n) => n.to === who && n.kind === 'OFFER')).toBe(true);
    // 别人不能替他答复；本人拒绝 → AI 给下一位
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'RespondShiftOffer', offerId: offer?.id, accept: true } }, a08)).body as { reject: { code: string } }).reject.code).toBe('NOT_YOURS');
    const whoToken = await token(call, { associateId: who });
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'RespondShiftOffer', offerId: offer?.id, accept: false } }, whoToken)).status).toBe(200);
    await settle();
    const next = Object.values(e.runtime.state.recs).find((x) => x.module === 'STAFFING' && x.target.startsWith('absence:') && x.status === 'OPEN');
    expect(next?.action.kind).toBe('OFFER_SHIFT');
    const who2 = String(next?.action.params?.associateId);
    expect(who2).not.toBe(who);
    await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AcceptRecommendation', recId: next?.id } }, a08);
    const offer2 = Object.values(e.runtime.state.offers ?? {}).find((o) => o.associateId === who2 && o.status === 'PENDING');
    const who2Token = await token(call, { associateId: who2 });
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'RespondShiftOffer', offerId: offer2?.id, accept: true } }, who2Token)).status).toBe(200);
    const day = shiftsOn(e.runtime.state, today);
    expect(day.some((x) => x.associateId === 'A02')).toBe(false);
    const filled = day.find((x) => x.associateId === who2);
    expect(filled).toBeDefined();
    const mid = new Date();
    mid.setHours(Math.floor(((filled?.from ?? 600) + (filled?.to ?? 660)) / 120), 0, 0, 0);
    expect(onDuty(e.runtime.statics, e.runtime.state, who2, mid.getTime())).toBe(true);
    expect(onDuty(e.runtime.statics, e.runtime.state, 'A02', mid.getTime())).toBe(false);
    hub.stop();
  });
});

describe('提前下班（决策记录 0022 · D2）', () => {
  it('单量明显低于预测、推演显示少一名交付员也不变差：请这周工时多、今天班次还长的人自愿提前 1 小时下班；本人接受后班次缩短', async () => {
    const { hub, e, call } = await store();
    const { dateOf, onDuty, weekOf } = await import('@storewright/ops');
    const at = new Date();
    at.setHours(11, 0, 0, 0);
    const now = at.getTime();
    const today = dateOf(now);
    const a08 = await token(call, { associateId: 'A08' });
    const shifts = [
      { associateId: 'A05', date: today, from: 9 * 60, to: 17 * 60, role: 'HANDOFF' as const },
      { associateId: 'A06', date: today, from: 9 * 60, to: 17 * 60, role: 'HANDOFF' as const },
      { associateId: 'A01', date: today, from: 9 * 60, to: 17 * 60, role: 'PICK' as const },
      { associateId: 'A08', date: today, from: 8 * 60, to: 16 * 60, role: 'LEAD' as const },
    ];
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'PublishSchedule', week: weekOf(today), shifts } }, a08)).status).toBe(200);
    // 今天的单量只有预测的七成
    const hours = Array.from({ length: 6 }, (_, i) => ({ t: now + i * 3_600_000, mean: 3, low: 1, high: 5 }));
    expect((await e.runtime.submit({ cmd: { type: 'PublishOutlook', outlook: { hours, correction: 0.7, observed: 7, expected: 10, model: 'test' } }, actor: 'ai', at: now })).ok).toBe(true);
    expect(await e.opsAi.scanEarlyLeave(now)).toBe(true);
    const rec = Object.values(e.runtime.state.recs).find((r) => r.action.kind === 'OFFER_EARLY_LEAVE');
    expect(rec?.action.params).toMatchObject({ associateId: 'A05', from: 16 * 60, to: 17 * 60, role: 'HANDOFF' });
    expect(rec?.reasons[0]).toMatchObject({ factor: 'DEMAND_VS_FORECAST', value: -30 });
    // 两小时内不重复问
    expect(await e.opsAi.scanEarlyLeave(now + 60_000)).toBe(false);
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AcceptRecommendation', recId: rec?.id } }, a08)).status).toBe(200);
    const offer = Object.values(e.runtime.state.offers ?? {}).find((o) => o.kind === 'EARLY_LEAVE');
    const a05 = await token(call, { associateId: 'A05' });
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'RespondShiftOffer', offerId: offer?.id, accept: true } }, a05)).status).toBe(200);
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
    expect(onDuty(e.runtime.statics, e.runtime.state, 'A05', day + (15 * 60 + 30) * 60_000)).toBe(true);
    expect(onDuty(e.runtime.statics, e.runtime.state, 'A05', day + (16 * 60 + 30) * 60_000)).toBe(false);
    hub.stop();
  });
});

describe('冷链设备的预测性维护（决策记录 0022 · E1）', () => {
  it('暂存冷藏柜的制冷慢慢变差：越线之前就发出报修建议；采纳后开报修单、暂停往里放新框；关单时记下实际故障', async () => {
    const { hub, e, call } = await store();
    const sim = e.twin.sim;
    if (!sim) throw new Error('no sim');
    let now = Date.now() - 20 * 60_000;
    // 先正常运行 8 分钟，再让制冷慢慢变差
    for (let k = 0; k < 240; k++) {
      sim.step(now);
      now += 2000;
    }
    const sensorId = sim.fault('STAGING_CHILLED', 'DEGRADE');
    expect(sensorId).toBeDefined();
    let found = false;
    for (let k = 0; k < 450 && !found; k++) {
      sim.step(now);
      now += 2000;
      if (k % 15 === 0) {
        await e.twin.assessEquipment(now);
        found = Object.values(e.runtime.state.recs).some((r) => r.module === 'EQUIPMENT' && r.target === sensorId && r.status === 'OPEN');
      }
    }
    expect(found).toBe(true);
    const health = e.twin.equipment.get(sensorId as string);
    expect(health?.status).toBe('RISK');
    // 还没越线：读数仍低于 5 °C 的告警线，也还没有告警
    expect(e.twin.telemetry.latest(sensorId as string)?.value ?? 99).toBeLessThan(5.5);
    expect(Object.values(e.runtime.state.alerts).some((a) => a.sensorId === sensorId && a.status !== 'CLEARED')).toBe(false);
    const rec = Object.values(e.runtime.state.recs).find((r) => r.module === 'EQUIPMENT' && r.target === sensorId && r.status === 'OPEN');
    expect(rec?.prediction?.unit).toBe('MINUTES');
    expect(rec?.reasons.map((r) => r.factor)).toContain('TEMP_TREND');
    const a08 = await token(call, { associateId: 'A08' });
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AcceptRecommendation', recId: rec?.id } }, a08)).status).toBe(200);
    const ticket = Object.values(e.runtime.state.tickets ?? {}).find((t) => t.sensorId === sensorId && t.status === 'OPEN');
    expect(ticket?.slots.length).toBeGreaterThan(0);
    const paused = ticket?.slots[0] as string;
    expect(e.runtime.state.pausedSlots?.[paused]).toBe(ticket?.id);
    // 修好后关单（记下实际故障），格位恢复
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'CloseMaintenance', ticketId: ticket?.id, fault: 'COMPRESSOR' } }, a08)).status).toBe(200);
    expect(e.runtime.state.pausedSlots?.[paused]).toBeUndefined();
    expect(e.runtime.state.tickets?.[ticket?.id as string]?.fault).toBe('COMPRESSOR');
    hub.stop();
  });
});

describe('多源货架真相与顺路核对（决策记录 0022 · C1、C3）', () => {
  it('拣货员报告「不在原位」：AI 判断多半放错了地方，发出附近找一找；在附近找到算报告对了，用来更新这类报告的可靠度', async () => {
    const { hub, e, call } = await store();
    // 默认自动执行（决策记录 0026）；这里测「需确认」
    await e.runtime.submit({ cmd: { type: 'SetAiMode', module: 'AVAILABILITY', mode: 'CONFIRM' }, actor: 'console', at: Date.now() });
    const s = e.runtime.state;
    const plan = e.runtime.statics.planogram;
    // 后仓没货的常温商品（不会先安排补货），同一通道里还有别的货位
    const target = plan.find((p) => p.tempZone === 'AMBIENT' && sellableCases(s, p.itemId).length === 0 && plan.filter((x) => x.runId === p.runId && x.locationId !== p.locationId).length >= 3);
    if (!target) throw new Error('no item');
    const o = orderWith(e, target.itemId, 950);
    expect((await e.runtime.submit({ cmd: { type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, actor: 'console', at: Date.now() })).ok).toBe(true);
    await e.runtime.submit({ cmd: { type: 'LockOrder', orderId: o.info.id }, actor: 'console', at: Date.now() });
    await e.runtime.submit({ cmd: { type: 'ReleaseWalks' }, actor: 'console', at: Date.now() });
    await settle();
    const w = Object.values(e.runtime.state.walks).find((x) => x.toteIds.some((id) => e.runtime.state.totes[id]?.orderId === o.info.id));
    if (!w) throw new Error('no walk');
    const a01 = await token(call, { associateId: 'A01' });
    const cmd = (c: unknown, tok = a01) => call('POST', '/api/stores/demo/commands', { cmd: c }, tok);
    expect((await cmd({ type: 'ClaimWalk', walkId: w.id })).status).toBe(200);
    for (const id of w.toteIds) await cmd({ type: 'BindLabel', walkId: w.id, labelId: e.runtime.state.totes[id]?.labelId });
    const pk = w.stops.flatMap((x) => x.picks).find((x) => e.runtime.state.totes[x.toteId]?.orderId === o.info.id);
    if (!pk) throw new Error('no pick');
    expect((await cmd({ type: 'ReportNotFound', walkId: w.id, toteId: pk.toteId, lineId: pk.lineId, qty: pk.qty, resolution: 'SHORT', reason: 'NOT_AT_LOCATION' })).status).toBe(200);
    await settle();
    const b = e.ai.shelfBelief(target.itemId);
    expect(b?.pOn).toBeLessThan(0.4);
    expect(b?.pMisplaced).toBeGreaterThan(b?.pGone as number);

    expect(await e.ai.scanTruth()).toBe(1);
    const rec = Object.values(e.runtime.state.recs).find((r) => r.action.kind === 'SEARCH_NEARBY' && r.target === target.itemId);
    expect(rec?.status).toBe('OPEN');
    expect(rec?.reasons[0]?.factor).toBe('PICKER_REPORTS');
    const near = String(rec?.action.params?.near ?? '').split(',');
    expect(near.length).toBeGreaterThan(0);
    for (const id of near) expect(plan.find((x) => x.locationId === id)?.runId).toBe(target.runId);
    // 同一件商品不重复发
    expect(await e.ai.scanTruth()).toBe(0);

    // 带班负责人采纳 → 附近找一找的核对任务
    const a08 = await token(call, { associateId: 'A08' });
    expect((await cmd({ type: 'AcceptRecommendation', recId: rec?.id }, a08)).status).toBe(200);
    const check = Object.values(e.runtime.state.checks).find((c) => c.itemId === target.itemId && c.status === 'OPEN');
    expect(check?.reason).toBe('SEARCH');
    expect(check?.near).toEqual(near);
    // 「都没有」时数量只能是 0
    const a10 = await token(call, { associateId: 'A10' });
    expect(((await cmd({ type: 'ConfirmShelf', itemId: target.itemId, units: 2, checkId: check?.id, found: 'NONE' }, a10)).body as { reject: { code: string } }).reject.code).toBe('QTY_INVALID');
    // 在附近找到 3 件、放回原货位再数：「不在原位」的报告是对的（虽然数出来大于 0）
    const before = { ...e.ai.reliability.NOT_FOUND_ELSEWHERE };
    expect((await cmd({ type: 'ConfirmShelf', itemId: target.itemId, units: 3, checkId: check?.id, found: 'NEARBY' }, a10)).status).toBe(200);
    await settle();
    expect(e.ai.reliability.NOT_FOUND_ELSEWHERE).toEqual({ hit: before.hit + 1, miss: before.miss });
    expect(e.runtime.state.checks[check?.id as string]?.found).toBe('NEARBY');
    expect(e.ai.shelfBelief(target.itemId)).toBeUndefined();
    // 模型页能看到可靠度
    const c = await token(call, { role: 'console' });
    const models = (await call('GET', '/api/stores/demo/ai/models', undefined, c)).body as { shelfTruth: { reliability: Array<{ kind: string; hit: number }> } };
    expect(models.shelfTruth.reliability.find((r) => r.kind === 'NOT_FOUND_ELSEWHERE')?.hit).toBe(before.hit + 1);
    hub.stop();
  });

  it('批次经过的通道里有说不准在不在架上的商品：拣完附近那一站后顺手数一下（每个批次最多一件），数完或跳过', async () => {
    const { hub, e, call } = await store();
    const c = await token(call, { role: 'console' });
    await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 8, release: true, maxLines: 5, slotInMin: 50 }, c);
    await settle();
    const plan = e.runtime.statics.planogram;
    const walks = Object.values(e.runtime.state.walks).filter((w) => w.tempZone === 'AMBIENT' && w.stops.length >= 2);
    expect(walks.length).toBeGreaterThanOrEqual(2);
    const signals = (e.ai as unknown as { signals: Map<string, Array<{ kind: string; at: number }>> }).signals;
    // 给批次经过的通道里的一件商品一条一小时前的「价签不对」报告：找得到的概率落在说不准的区间
    const prepare = async (walkId: string) => {
      const w = e.runtime.state.walks[walkId];
      if (!w) throw new Error('no walk');
      if (w.checks?.length) return;
      const stopLocs = new Set(w.stops.map((x) => x.locationId));
      const runs = new Set(plan.filter((p) => stopLocs.has(p.locationId)).map((p) => p.runId));
      const y = plan.find((p) => runs.has(p.runId) && !stopLocs.has(p.locationId) && e.runtime.state.suspect[p.itemId] === undefined);
      if (!y) throw new Error('no neighbour');
      signals.set(y.itemId, [{ kind: 'NOT_FOUND_TAG', at: Date.now() - 3_600_000 }]);
      const p = e.ai.findProbability(y.itemId, 1, 0).p;
      expect(p).toBeGreaterThanOrEqual(0.35);
      expect(p).toBeLessThan(0.7);
      expect(await e.opsAi.walkCheck(walkId)).toBe(true);
    };
    const [w1, w2] = walks as [(typeof walks)[number], (typeof walks)[number]];
    await prepare(w1.id);
    await prepare(w2.id);
    const chk = e.runtime.state.walks[w1.id]?.checks?.[0];
    expect(e.runtime.state.walks[w1.id]?.checks).toHaveLength(1);
    expect(chk?.status).toBe('OPEN');
    expect(chk?.afterStop).toBeLessThan(w1.stops.length);
    expect(w1.stops.some((x) => x.locationId === chk?.locationId)).toBe(false);
    // 拣货模块默认自动执行
    expect(Object.values(e.runtime.state.recs).some((r) => r.action.kind === 'ADD_WALK_CHECK' && r.action.params?.walkId === w1.id && r.status === 'AUTO_APPLIED')).toBe(true);
    // 每个批次最多一件
    expect(await e.opsAi.walkCheck(w1.id)).toBe(false);

    const a01 = await token(call, { associateId: 'A01' });
    const a02 = await token(call, { associateId: 'A02' });
    const cmd = (x: unknown, tok: string) => call('POST', '/api/stores/demo/commands', { cmd: x }, tok);
    expect((await cmd({ type: 'ClaimWalk', walkId: w1.id }, a01)).status).toBe(200);
    expect((await cmd({ type: 'ConfirmShelf', itemId: chk?.itemId, units: 4, walkId: w1.id }, a01)).status).toBe(200);
    const done = e.runtime.state.walks[w1.id]?.checks?.[0];
    expect(done?.status).toBe('DONE');
    expect(done?.units).toBe(4);
    // 第二个批次：别人不能替他跳过；本人跳过
    const chk2 = e.runtime.state.walks[w2.id]?.checks?.[0];
    expect((await cmd({ type: 'ClaimWalk', walkId: w2.id }, a02)).status).toBe(200);
    expect(((await cmd({ type: 'SkipWalkCheck', walkId: w2.id, itemId: chk2?.itemId }, a01)).body as { reject: { code: string } }).reject.code).toBe('WALK_NOT_YOURS');
    expect((await cmd({ type: 'SkipWalkCheck', walkId: w2.id, itemId: chk2?.itemId }, a02)).status).toBe(200);
    expect(e.runtime.state.walks[w2.id]?.checks?.[0]?.status).toBe('SKIPPED');
    hub.stop();
  });
});

describe('效果追踪、运行监控、开店简报（决策记录 0022 · F4、H3、F1）', () => {
  it('运营预警的时间段过去后算出实际值：采纳的看实现了多少，没采纳的记作对照；核对货架的结果记为建议依据的事情有没有发生', async () => {
    const { hub, e, call } = await store();
    const c = await token(call, { role: 'console' });
    for (let k = 0; k < 2; k++) await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 20, release: true, maxLines: 5, slotInMin: 25 }, c);
    await settle();
    const a01 = await token(call, { associateId: 'A01' });
    const w0 = Object.values(e.runtime.state.walks).find((w) => w.status === 'OPEN');
    await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ClaimWalk', walkId: w0?.id } }, a01);
    await e.opsAi.scanForesight();
    const rec = Object.values(e.runtime.state.recs).find((x) => x.module === 'FORESIGHT' && x.status === 'OPEN');
    if (!rec?.prediction?.to) throw new Error('no foresight rec');
    const a08 = await token(call, { associateId: 'A08' });
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'DismissRecommendation', recId: rec.id } }, a08)).status).toBe(200);
    // 时间段还没过：不能测
    expect(e.opsAi.outcomeOf(e.runtime.state.recs[rec.id] as never, Date.now())).toBeUndefined();
    const later = rec.prediction.to + 6 * 60_000;
    for (let t = Date.now(); t < later && rec.target !== 'LATE' && rec.target !== 'WAIT'; t += 30_000) e.opsAi.sample(t);
    expect(await e.opsAi.measureOutcomes(later)).toBeGreaterThanOrEqual(1);
    const o = e.runtime.state.recs[rec.id]?.outcome;
    expect(o?.kind).toBe('EFFECT');
    expect(o?.adopted).toBe(false);
    expect(o?.metric).toBe(rec.target);
    expect(e.runtime.state.aiStats.FORESIGHT?.outcomes?.ctrlN).toBe(1);
    // 效果汇总接口
    const h = (await call('GET', '/api/stores/demo/ai/health', undefined, c)).body as { outcomes: Record<string, { ctrlN: number }>; models: Array<{ id: string; status: string }> };
    expect(h.outcomes.FORESIGHT?.ctrlN).toBe(1);
    expect(h.models.find((m) => m.id === 'orders-hourly')).toBeDefined();
    hub.stop();
  });

  it('收银流水中断时可售概率暂停：写进事件流，孪生健康度扣分，带班负责人收到通知；恢复后通知关闭', async () => {
    const { hub, e } = await store();
    const ai = e.ai as unknown as { lastSaleEvent?: number };
    const now = Date.now();
    ai.lastSaleEvent = now - 40 * 60_000;
    expect(await e.ai.publishHealth(now)).toBe(true);
    const sa = e.runtime.state.aiHealth?.models.find((m) => m.id === 'shelf-availability');
    expect(sa?.status).toBe('PAUSED');
    expect(sa?.cause).toBe('POS_STALE');
    expect(e.twin.health(now).issues).toContain('AI_PAUSED');
    // 状态没变时不重复发布
    expect(await e.ai.publishHealth(now + 60_000)).toBe(false);
    await e.opsAi.syncNudges(now);
    const n = Object.values(e.runtime.state.nudges).find((x) => x.kind === 'NOTICE' && x.topic === 'HEALTH:shelf-availability');
    expect(n?.to).toBe('A08');
    // 流水恢复
    ai.lastSaleEvent = now + 120_000;
    expect(await e.ai.publishHealth(now + 120_000)).toBe(true);
    expect(e.runtime.state.aiHealth?.models.find((m) => m.id === 'shelf-availability')?.status).not.toBe('PAUSED');
    await e.opsAi.syncNudges(now + 130_000);
    expect(e.runtime.state.nudges[n?.id as string]?.status).toBe('DONE');
    hub.stop();
  });

  it('开店简报：今天的订单预测、到货、人手缺口、要注意的事和需要店长决定的事；门店助手回答「今天要注意什么」', async () => {
    const { hub, call } = await store();
    const c = await token(call, { role: 'console' });
    await call('POST', '/api/stores/demo/demo/asn', { items: 4, inMin: 45 }, c);
    for (const part of ['MORNING', 'MIDDAY', 'EVENING'] as const) {
      const b = (await hub.handle({ method: 'GET', path: '/api/stores/demo/ai/brief', query: { part }, headers: { authorization: `Bearer ${c}` }, body: undefined })).body as { part: string; forecast?: { orders: number; low: number; high: number }; inbound: { trucks: number; next?: { at?: number } }; staffing: { scheduled: number }; watch: unknown[]; decisions: unknown[] };
      expect(b.part).toBe(part);
      expect(b.forecast?.orders).toBeGreaterThan(0);
      expect(b.forecast?.low).toBeLessThanOrEqual(b.forecast?.orders as number);
      expect(b.inbound.trucks).toBe(1);
      expect(b.inbound.next?.at).toBeGreaterThan(Date.now());
      expect(b.staffing.scheduled).toBeGreaterThan(0);
      expect(b.watch.length).toBeLessThanOrEqual(3);
    }
    const a = (await call('POST', '/api/stores/demo/ai/ask', { question: '今天要注意什么？' }, c)).body as { tools: Array<{ name: string }>; answer: string };
    expect(a.tools[0]?.name).toBe('opening_brief');
    expect(a.answer).toContain('预计');
    const en = (await call('POST', '/api/stores/demo/ai/ask', { question: 'Give me the opening brief.', lang: 'en' }, c)).body as { tools: Array<{ name: string }>; answer: string };
    expect(en.tools[0]?.name).toBe('opening_brief');
    hub.stop();
  });
});

describe('到货、开门前补货、收银通道的门店版（决策记录 0022 · A3）', () => {
  it('三辆车同时到、卸货门和收货员不够：给出收货顺序（冷链优先），能调人时建议调一名会后仓的人；供应商通知晚到 20 分钟以上时更新计划', async () => {
    const { hub, e, call } = await store();
    const c = await token(call, { role: 'console' });
    for (let k = 0; k < 3; k++) await call('POST', '/api/stores/demo/demo/asn', { items: 10, inMin: 0 }, c);
    const ids = Object.keys(e.runtime.state.receipts);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ArriveTruck', receiptId: id } }, c)).status).toBe(200);
    const plan = e.opsAi.dockPlan();
    expect(plan).toHaveLength(3);
    expect(Math.max(...plan.map((x) => x.waitMin))).toBeGreaterThanOrEqual(15);
    expect(await e.opsAi.scanInbound()).toBe(true);
    const rec = Object.values(e.runtime.state.recs).find((r) => r.module === 'INBOUND' && r.target === 'DOCK');
    expect(String(rec?.action.params?.order ?? '').split(',').sort()).toEqual([...ids].sort());
    expect(rec?.reasons[0]?.factor).toBe('TRUCKS_WAITING');
    // 同一件事不重复发
    expect(await e.opsAi.scanInbound()).toBe(false);

    // 第四车还在路上，供应商通知晚 25 分钟
    await call('POST', '/api/stores/demo/demo/asn', { items: 5, inMin: 60 }, c);
    const r4 = Object.values(e.runtime.state.receipts).find((r) => r.arrivedAt === undefined);
    const first = r4?.expectedAt;
    if (!r4 || first === undefined) throw new Error('no in-transit receipt');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'UpdateAsnEta', receiptId: r4.id, expectedAt: first + 25 * 60_000 } }, c)).status).toBe(200);
    await settle();
    expect(e.runtime.state.receipts[r4.id]?.firstExpectedAt).toBe(first);
    expect(e.runtime.state.receipts[r4.id]?.expectedAt).toBe(first + 25 * 60_000);
    const eta = Object.values(e.runtime.state.recs).find((r) => r.module === 'INBOUND' && r.target === `ETA:${r4.id}`);
    expect(eta?.action.params?.delayMin).toBe(25);
    // 已经到了的车不能再改预计到达
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'UpdateAsnEta', receiptId: ids[0], expectedAt: Date.now() } }, c)).body as { reject: { code: string } }).reject.code).toBe('RECEIPT_CLOSED');
    hub.stop();
  });

  it('下午看明早开门前要上架多少箱：排的人补不完时提醒要几个人；收银通道按入口客流用排队论算开几条，要多开时提前叫人', async () => {
    const { hub, e } = await store();
    const st = e.runtime.statics;
    const at = new Date();
    at.setHours(15, 0, 0, 0);
    // 没有发布排班时按名单算：补货、后仓岗位的人都算在开门前补货的人里；箱数按「比现有人数多两个人的工作量」给
    const tomorrow = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, (e.ai.context?.hours[0] ?? 8) - 1, 30).getTime();
    const crew = st.roster.filter((a) => {
      const d = dutyOf(st, e.runtime.state, a.id, tomorrow);
      return d.on && (d.role === 'RESTOCK' || d.role === 'BACKROOM');
    }).length;
    const perLine = Math.ceil(((crew + 2) * 300) / 30);
    const lines = st.planogram.slice(0, 30).map((p) => ({ itemId: p.itemId, gtin: p.gtin, name: p.name, cases: perLine, packQty: p.packQty }));
    expect((await e.runtime.submit({ cmd: { type: 'CreateAsn', supplier: 'Night DC', lines, expectedAt: at.getTime() + 6 * 3_600_000 }, actor: 'console', at: at.getTime() })).ok).toBe(true);
    expect(await e.opsAi.scanNightCrew(at.getTime())).toBe(true);
    const rec = Object.values(e.runtime.state.recs).find((r) => r.module === 'INBOUND' && r.target === 'NIGHT');
    expect(rec?.reasons[0]).toMatchObject({ factor: 'CASES_TONIGHT', value: perLine * 30 });
    expect(Number(rec?.reasons[1]?.params?.need)).toBeGreaterThan(Number(rec?.reasons[1]?.value));
    // 同样的情况不重复发
    expect(await e.opsAi.scanNightCrew(at.getTime() + 60_000)).toBe(false);

    // 收银通道：入口每小时 120 人、比 10 分钟前多一半
    const { OpsAiService } = await import('./aiOps');
    const front = new OpsAiService(e.runtime, e.ai, { shoppers: () => ({ now: 120, before: 80 }), lanes: { manual: 10, self: 4 } });
    expect(await front.scanFront()).toBe(true);
    const lanes = Object.values(e.runtime.state.recs).find((r) => r.module === 'FRONT' && r.target === 'LANES');
    expect(Number(lanes?.action.params?.lanes)).toBeGreaterThanOrEqual(2);
    expect(Number(lanes?.action.params?.next)).toBeGreaterThan(Number(lanes?.action.params?.lanes));
    expect(lanes?.action.params?.nudge).toBe(true);
    expect(await front.scanFront()).toBe(false);
    front.close();
    hub.stop();
  });
});
