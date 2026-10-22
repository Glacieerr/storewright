import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpsState } from '@storewright/ops';
import { liveDailyHours } from './ai';
import { buildApp } from './app';
import { openDb, type Db } from './db';

let db: Db;
let base = '';
let close: () => Promise<void>;
let stores: Awaited<ReturnType<typeof buildApp>>['stores'];

async function start(): Promise<void> {
  const built = await buildApp({ db, demo: true });
  stores = built.stores;
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  close = built.close;
}

async function session(body: Record<string, string>): Promise<string> {
  const r = await fetch(`${base}/api/stores/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return ((await r.json()) as { token: string }).token;
}

async function call(method: 'GET' | 'POST', token: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/stores/demo${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}

beforeAll(async () => {
  db = await openDb({});
  await start();
});

afterAll(async () => {
  await close();
  await db.close();
});

describe('AI service: sim pretraining, recommendations, gate and persistence', () => {
  it('pretrains on synthetic history and serves forecast recommendations with reasons', async () => {
    const consoleToken = await session({ role: 'console' });
    const lead = await session({ associateId: 'A08' });
    const picker = await session({ associateId: 'A01' });

    const models = await call('GET', picker, '/ai/models');
    expect(models.status).toBe(200);
    const all = models.body.models as Array<{ id: string; kind: string; status: string; note?: string; metrics: Record<string, number>; data: { source: string } }>;
    const list = all.filter((m) => m.id === 'orders-hourly');
    expect(all.filter((m) => m.id === 'eta-arrival' && m.status === 'CHAMPION')).toHaveLength(1);
    expect(list).toHaveLength(4);
    expect(list.filter((m) => m.status === 'CHAMPION')).toHaveLength(1);
    expect(list.filter((m) => m.note === 'NOT_BEST')).toHaveLength(3);
    const champ = list.find((m) => m.status === 'CHAMPION');
    expect(champ?.data.source).toBe('SIM');
    expect(champ?.metrics.wape).toBeLessThan(Math.min(...list.filter((m) => m.status !== 'CHAMPION').map((m) => m.metrics.wape as number)));
    expect(models.body.context.hours.length).toBeGreaterThan(8);

    expect((await call('POST', picker, '/ai/forecast', {})).status).toBe(403);
    const issued = await call('POST', lead, '/ai/forecast', {});
    expect(issued.status).toBe(200);
    const rec = issued.body.events.find((e: { type: string }) => e.type === 'RecommendationIssued').payload.rec;
    expect(rec).toMatchObject({ module: 'FORECAST', target: 'store', mode: 'SHOW', action: { kind: 'INFO' }, model: { id: 'orders-hourly' } });
    expect(rec.prediction.low).toBeLessThanOrEqual(rec.prediction.value);
    expect(rec.prediction.high).toBeGreaterThanOrEqual(rec.prediction.value);
    expect(rec.reasons.length).toBeGreaterThan(0);
    expect(rec.alternatives).toHaveLength(3);
    expect(Object.keys(rec.prediction.breakdown.values).sort()).toEqual(['AMBIENT', 'CHILLED', 'FROZEN']);

    // 普通员工不能处理；带班负责人否决时给出原因
    expect((await call('POST', picker, '/commands', { cmd: { type: 'AcceptRecommendation', recId: rec.id } })).body.reject.code).toBe('NOT_AUTHORIZED');
    const over = await call('POST', lead, '/commands', { cmd: { type: 'OverrideRecommendation', recId: rec.id, reason: 'LOCAL_KNOWLEDGE' } });
    expect(over.status).toBe(200);
    const snap = await call('GET', consoleToken, '/snapshot');
    const state = snap.body.state as OpsState;
    expect(state.recs[rec.id]).toMatchObject({ status: 'OVERRIDDEN', reason: 'LOCAL_KNOWLEDGE', resolvedBy: 'A08' });
    expect(state.aiStats.FORECAST?.OVERRIDDEN).toBe(1);

    // 模式设置
    expect((await call('POST', lead, '/commands', { cmd: { type: 'SetAiMode', module: 'FORECAST', mode: 'CONFIRM' } })).status).toBe(200);
  });

  it('rejects a worse candidate at the gate and keeps the champion; nothing to roll back yet', async () => {
    const lead = await session({ associateId: 'A08' });
    const before = (await call('GET', lead, '/ai/models')).body.champion as number;
    const r = await call('POST', lead, '/ai/retrain', { kinds: ['seasonal-naive'], seed: 4242 });
    expect(r.status).toBe(200);
    expect(r.body.promoted).toBe(false);
    expect(r.body.gate.checks[0]).toMatchObject({ metric: 'wape', rule: 'PRIMARY', ok: false });
    // 当前版本在同一份数据上重新评估过
    expect(r.body.championMetrics.wape).toBeLessThan(r.body.candidates[0].metrics.wape);
    const after = await call('GET', lead, '/ai/models');
    expect(after.body.champion).toBe(before);
    expect(r.body.eta.kind).toBe('eta-hierarchical');
    expect(after.body.models.find((m: { version: number }) => m.version === r.body.best).status).toBe('REJECTED');
    expect((await call('POST', lead, '/ai/rollback', {})).status).toBe(409);
  });

  it('corrects a customer ETA and applies it to the handoff board automatically', async () => {
    const consoleToken = await session({ role: 'console' });
    const created = await call('POST', consoleToken, '/demo/orders', { type: 'PICKUP', count: 1, maxLines: 2, release: true, slotInMin: 30 });
    const orderId = created.body.orders[0].orderId as string;
    const etaAt = Date.now() + 12 * 60_000;
    expect((await call('POST', consoleToken, '/commands', { cmd: { type: 'UpdateEta', orderId, etaAt } })).status).toBe(200);
    let state: OpsState | undefined;
    for (let i = 0; i < 100; i++) {
      state = (await call('GET', consoleToken, '/snapshot')).body.state as OpsState;
      if (state.orders[orderId]?.aiEtaAt !== undefined) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const o = state?.orders[orderId];
    expect(o?.etaReportedAt).toBeDefined();
    expect(o?.aiEtaAt).toBeDefined();
    const rec = Object.values(state?.recs ?? {}).find((r) => r.module === 'ETA' && r.target === orderId);
    expect(rec).toMatchObject({ status: 'AUTO_APPLIED', mode: 'AUTO', action: { kind: 'USE_AI_ETA' } });
    expect(rec?.prediction?.baseline).toBeCloseTo(12, 0);
    expect(rec?.reasons.map((r) => r.factor)).toContain('REPORTED_ETA');
    // 顾客重新上报后，旧的修正作废、新的修正接上
    await call('POST', consoleToken, '/commands', { cmd: { type: 'UpdateEta', orderId, etaAt: Date.now() + 3 * 60_000 } });
    for (let i = 0; i < 100; i++) {
      state = (await call('GET', consoleToken, '/snapshot')).body.state as OpsState;
      if (Object.values(state.recs).filter((r) => r.module === 'ETA' && r.target === orderId).length === 2 && state.orders[orderId]?.aiEtaAt !== undefined) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const recs = Object.values(state?.recs ?? {}).filter((r) => r.module === 'ETA' && r.target === orderId);
    expect(recs).toHaveLength(2);
    expect(state?.orders[orderId]?.aiEtaAt).toBeLessThan(o?.aiEtaAt as number);
  });

  it('flags phantom stock from sales silence, and a shelf count closes the loop', async () => {
    const e = stores.get('demo')!;
    const rt = e.runtime;
    const lead = await session({ associateId: 'A08' });
    const restocker = await session({ associateId: 'A10' });
    const [target, other] = [...rt.statics.planogram].sort((a, b) => b.baseVelocity - a.baseVelocity).slice(0, 2);
    const t0 = Date.now();
    // 第一个小时目标商品和其他商品都在卖；之后收银流水一直正常，目标商品 3 小时没有卖出
    const others = [...rt.statics.planogram].sort((a, b) => b.baseVelocity - a.baseVelocity).slice(2, 7);
    for (let k = 0; k < 24; k++) {
      const lines = [...others.map((p) => ({ itemId: p.itemId, qty: 4 })), ...(k < 6 ? [{ itemId: target!.itemId, qty: 10 }] : []), { itemId: other!.itemId, qty: 1 }];
      await rt.submit({ cmd: { type: 'RecordSales', lines }, actor: 'pos', at: t0 + k * 10 * 60_000 });
    }
    const now = t0 + 4 * 3_600_000;
    expect(await e.ai.scanShelves(now)).toBeGreaterThanOrEqual(1);
    const rec = Object.values(rt.state.recs).find((r) => r.module === 'AVAILABILITY' && r.target === target!.itemId);
    expect(rec).toMatchObject({ status: 'OPEN', mode: 'CONFIRM', action: { kind: 'CHECK_SHELF' } });
    expect(rec!.prediction!.value).toBeLessThan(0.5);
    expect(rec!.reasons.map((r) => r.factor)).toContain('NO_SALES');
    expect(Object.values(rt.state.recs).some((r) => r.module === 'AVAILABILITY' && r.target === other!.itemId)).toBe(false);
    // 再扫一次不会重复发
    expect(await e.ai.scanShelves(now + 60_000)).toBe(0);

    expect((await call('POST', lead, '/commands', { cmd: { type: 'AcceptRecommendation', recId: rec!.id } })).status).toBe(200);
    const check = Object.values(rt.state.checks).find((c) => c.itemId === target!.itemId && c.status === 'OPEN');
    expect(check).toMatchObject({ reason: 'AI', recId: rec!.id, locationId: target!.locationId });
    const done = await call('POST', restocker, '/commands', { cmd: { type: 'ConfirmShelf', itemId: target!.itemId, units: 0, checkId: check!.id } });
    expect(done.status).toBe(200);
    expect(rt.state.checks[check!.id]).toMatchObject({ status: 'DONE', units: 0, associateId: 'A10' });
    expect(rt.state.checks[check!.id]!.previousEst).toBeGreaterThan(0);
    expect(rt.state.shelf[target!.itemId]).toMatchObject({ est: 0, conf: 1, source: 'SCAN' });
  });

  it('issues risk-based count recommendations and turns an accepted one into a cycle count', async () => {
    const e = stores.get('demo')!;
    const rt = e.runtime;
    const lead = await session({ associateId: 'A08' });
    const champ = e.ai.registry.champion('count-risk');
    expect(champ?.kind).toBe('count-risk');
    // 用一个「认为每条记录都很可能不准」的模型，检查数量上限与动作
    (champ!.params as { beta: number[] }).beta[0] = 10;
    expect(await e.ai.scanCounts(Date.now(), 3)).toBe(3);
    const recs = Object.values(rt.state.recs).filter((r) => r.module === 'COUNT' && r.status === 'OPEN');
    expect(recs).toHaveLength(3);
    expect(await e.ai.scanCounts(Date.now(), 3)).toBe(3);
    const r = recs[0]!;
    expect((await call('POST', lead, '/commands', { cmd: { type: 'AcceptRecommendation', recId: r.id } })).status).toBe(200);
    const cc = Object.values(rt.state.counts).find((c) => c.binCode === r.target && c.reason === 'AI_RISK');
    expect(cc?.status).toBe('OPEN');
    expect((await call('POST', lead, '/commands', { cmd: { type: 'AcceptRecommendation', recId: recs[1]!.id } })).status).toBe(200);
  });

  it('ranks substitutes by predicted acceptance and counts which AI pick was used', async () => {
    const e = stores.get('demo')!;
    const picker = await session({ associateId: 'A01' });
    const item = [...e.demo.catalog.values()].find((i) => e.ai.substitutes(i.id).items.length >= 3)!;
    const r = await call('GET', picker, `/substitutes?itemId=${item.id}`);
    expect(r.body.model).toMatch(/^substitution v\d+$/);
    const ps = (r.body.items as Array<{ p: number }>).map((x) => x.p);
    expect(ps.every((p) => p > 0 && p < 1)).toBe(true);
    for (let i = 1; i < ps.length; i++) expect(ps[i - 1]!).toBeGreaterThanOrEqual(ps[i]!);
    expect(e.ai.registry.champion('substitution')?.kind).toBe('sub-learned');
  });

  it('suggests moving an idle picker to a busy handoff area; locks keep people in place', async () => {
    const e = stores.get('demo')!;
    const rt = e.runtime;
    const consoleToken = await session({ role: 'console' });
    const lead = await session({ associateId: 'A08' });
    const created = await call('POST', consoleToken, '/demo/orders', { type: 'PICKUP', count: 12, maxLines: 2, release: true, slotInMin: 20 });
    const ids = (created.body.orders as Array<{ orderId: string }>).map((o) => o.orderId);
    for (const id of ids.slice(0, 9)) await call('POST', consoleToken, '/commands', { cmd: { type: 'CheckIn', orderId: id } });
    for (const id of ids.slice(9)) await call('POST', consoleToken, '/commands', { cmd: { type: 'UpdateEta', orderId: id, etaAt: Date.now() + 8 * 60_000 } });
    // 先锁定所有拣货员：不会建议调动
    const pickers = rt.statics.roster.filter((a) => a.role === 'PICK').map((a) => a.id);
    for (const id of pickers) await call('POST', lead, '/commands', { cmd: { type: 'LockAssociate', associateId: id, locked: true } });
    expect(await e.ai.scanDispatch()).toBe(false);
    for (const id of pickers) await call('POST', lead, '/commands', { cmd: { type: 'LockAssociate', associateId: id, locked: false } });
    expect(await e.ai.scanDispatch()).toBe(true);
    const rec = Object.values(rt.state.recs).find((r) => r.module === 'STAFFING' && r.status === 'OPEN')!;
    expect(rec.action).toMatchObject({ kind: 'MOVE_ASSOCIATE', params: { from: 'pick', to: 'HANDOFF' } });
    expect(pickers).toContain(rec.target);
    expect(rec.prediction).toMatchObject({ unit: 'MINUTES' });
    expect(rec.prediction!.value).toBeLessThan(rec.prediction!.baseline as number);
    expect(rec.reasons[0]?.factor).toBe('HANDOFF_QUEUE');
    expect(await e.ai.scanDispatch()).toBe(false); // 已有待处理的调动建议
    expect((await call('POST', lead, '/commands', { cmd: { type: 'AcceptRecommendation', recId: rec.id } })).status).toBe(200);
    expect(rt.state.roles[rec.target]).toBe('HANDOFF');
    // 排班建议：总工时不变
    const plan = await e.ai.issueStaffPlan();
    expect(plan?.ok).toBe(true);
    const p = Object.values(rt.state.recs).find((r) => r.module === 'STAFFING' && r.action.params?.plan)!;
    const sum = (k: string) => String(p.action.params![k]).split(',').reduce((a, b) => a + Number(b), 0);
    expect(sum('pick')).toBeGreaterThan(0);
    expect(sum('handoff')).toBeGreaterThan(0);
  });

  it('restores the registry after a restart without retraining', async () => {
    const t = await session({ role: 'console' });
    const count = (await call('GET', t, '/ai/models')).body.models.length as number;
    await close();
    await start();
    const t2 = await session({ role: 'console' });
    const again = await call('GET', t2, '/ai/models');
    expect(again.body.models).toHaveLength(count);
    expect((await call('POST', t2, '/ai/forecast', {})).status).toBe(200);
  });
});

describe('real-data takeover', () => {
  it('keeps only complete past business days, by local date and slot hour', () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h, 15).getTime();
    const orders = [
      ...Array.from({ length: 30 }, (_, i) => ({ slotStart: at(18, 9 + (i % 5)), status: 'COMPLETED' })),
      { slotStart: at(18, 10), status: 'CANCELLED' },
      { slotStart: at(18, 3), status: 'COMPLETED' },
      ...Array.from({ length: 5 }, () => ({ slotStart: at(19, 11), status: 'COMPLETED' })),
      ...Array.from({ length: 40 }, () => ({ slotStart: at(21, 11), status: 'CREATED' })),
    ];
    const days = liveDailyHours(orders, { from: '2026-10-01', today: '2026-10-21', hours: [8, 9, 10, 11, 12, 13], minPerDay: 20 });
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: '2026-10-18', day: 17, dow: 0 });
    expect(days[0]?.hourly.reduce((a, b) => a + b, 0)).toBe(30);
  });
});

