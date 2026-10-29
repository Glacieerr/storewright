import { describe, expect, it } from 'vitest';
import { dateOf, nextTasksFor } from '@storewright/ops';
import { parseDeliveryNote as parseNote } from '@storewright/domain';
import { Hub, type StoreEntry } from './hub';
import { closingReview } from './review';
import { webPlatform } from './platform';
import { memoryStorage } from './storage';

/** 门店 AI 第二轮 · 第四批（决策记录 0024）：送货单与保质期、召回、突发状况、食品安全记录、复盘与周报、问数、操作提示、下一步 */

const settle = () => new Promise((r) => setTimeout(r, 60));


async function store(): Promise<{ hub: Hub; e: StoreEntry; call: (method: string, path: string, body?: unknown, token?: string, query?: Record<string, string>) => ReturnType<Hub['handle']> }> {
  const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'] });
  const e = hub.stores.get('demo');
  if (!e) throw new Error('no store');
  const call = (method: string, path: string, body?: unknown, token?: string, query: Record<string, string> = {}) => hub.handle({ method, path, query, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  return { hub, e, call };
}

async function token(call: Awaited<ReturnType<typeof store>>['call'], who: { role?: string; associateId?: string }): Promise<string> {
  return ((await call('POST', '/api/stores/demo/session', who)).body as { token: string }).token;
}

describe('送货单、批号与保质期（决策记录 0024 · G3、C4）', () => {
  it('演示送货单的二维码内容能解析，和到货通知比对；按送货单收货后每箱带批号和保质期；快到期的批次给出处理建议', async () => {
    const { hub, e, call } = await store();
    const c = await token(call, { role: 'console' });
    await call('POST', '/api/stores/demo/demo/asn', { items: 4, inMin: 0 }, c);
    const r = Object.values(e.runtime.state.receipts)[0];
    if (!r) throw new Error('no receipt');
    await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ArriveTruck', receiptId: r.id } }, c);
    const text = ((await call('GET', `/api/stores/demo/demo/delivery-note/${r.id}`, undefined, c)).body as { text: string }).text;
    const note = parseNote(text);
    expect(note?.order).toBe(r.id);
    expect(note?.lines.length).toBe(r.expected.length);
    // 最后一行少一箱（演示和到货通知的差异）
    const last = r.expected.at(-1);
    if (last && last.cases > 1) expect(note?.lines.find((l) => l.gtin === last.gtin)?.cases).toBe(last.cases - 1);
    // 收货的是后仓员工
    const a09 = await token(call, { associateId: 'A09' });
    for (const l of note?.lines ?? []) expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ReceiveCases', receiptId: r.id, gtin: l.gtin, cases: l.cases, lot: l.lot, expiry: l.expiry } }, a09)).status).toBe(200);
    const cases = Object.values(e.runtime.state.cases).filter((x) => x.receiptId === r.id);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((x) => x.lot && x.expiry)).toBe(true);
    // 日期写法不对的不收，拒绝原因说明是日期（决策记录 0025）
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ReceiveCases', receiptId: r.id, gtin: note?.lines[0]?.gtin, cases: 1, expiry: '11/30/2026' } }, a09)).body as { reject: { code: string } }).reject.code).toBe('DATE_INVALID');

    // 货架上有一批明天到期、明显卖不完的：建议处理
    const p = e.runtime.statics.planogram.find((x) => x.tempZone === 'CHILLED') ?? e.runtime.statics.planogram[0];
    if (!p) throw new Error('no item');
    const d = new Date(Date.now() + 86_400_000);
    const tomorrow = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    e.runtime.state.shelfLots = { [p.itemId]: [{ lot: 'LTEST1', expiry: tomorrow, units: 2000, at: Date.now() }] };
    expect(await e.opsAi.scanExpiry()).toBe(1);
    const rec = Object.values(e.runtime.state.recs).find((x) => x.module === 'EXPIRY' && x.target === `${p.itemId}|LTEST1`);
    expect(['MARKDOWN', 'DONATE', 'INFO']).toContain(rec?.action.kind);
    expect(rec?.reasons[0]?.factor).toBe('EXPIRES_IN');
    // 卖出按先进先出扣批次
    await e.runtime.submit({ cmd: { type: 'RecordSales', lines: [{ itemId: p.itemId, qty: 5 }] }, actor: 'pos', at: Date.now() });
    expect(e.runtime.state.shelfLots?.[p.itemId]?.[0]?.units).toBe(1995);
    hub.stop();
  });
});

describe('召回、突发状况、食品安全记录（决策记录 0024 · C5、E4、E5）', () => {
  it('粘贴召回通知 → 匹配商品 → 确认后开启：后仓的箱子转待检、线上拣货不能再拣、货架下架后存量清零；收银拦截接口', async () => {
    const { hub, e, call } = await store();
    const a08 = await token(call, { associateId: 'A08' });
    const text = ((await call('GET', '/api/stores/demo/demo/recall', undefined, a08)).body as { text: string }).text;
    expect(text.length).toBeGreaterThan(20);
    const parsed = (await call('POST', '/api/stores/demo/ai/recall/parse', { text }, a08)).body as { parsed: { product: string; lots: string[]; reason?: string }; matches: Array<{ itemId: string; score: number; cases: number }> };
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.parsed.reason).toBeDefined();
    const pick = parsed.matches.filter((m) => m.score >= 0.85).map((m) => m.itemId);
    expect(pick.length).toBeGreaterThan(0);
    // 普通员工不能开启召回
    const a01 = await token(call, { associateId: 'A01' });
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'OpenRecall', title: parsed.parsed.product, itemIds: pick } }, a01)).body as { reject: { code: string } }).reject.code).toBe('NOT_AUTHORIZED');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'OpenRecall', title: parsed.parsed.product, itemIds: pick, reason: parsed.parsed.reason } }, a08)).status).toBe(200);
    const rc = Object.values(e.runtime.state.recalls ?? {})[0];
    if (!rc) throw new Error('no recall');
    for (const id of rc.affected.cases) expect(e.runtime.state.cases[id]?.status).not.toBe('SELLABLE');
    const blocked = (await call('GET', '/api/stores/demo/recalls/blocked', undefined, a08)).body as { gtins: string[] };
    expect(blocked.gtins.length).toBe(pick.length);
    // 货架下架（谁都可以打勾）：存量清零
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'MarkRecallStep', recallId: rc.id, step: 'SHELF', done: true } }, a01)).status).toBe(200);
    for (const id of pick) expect(e.runtime.state.shelf[id]?.est).toBe(0);
    // 通知顾客只有带班负责人能确认
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'MarkRecallStep', recallId: rc.id, step: 'CUSTOMERS', done: true } }, a01)).body as { reject: { code: string } }).reject.code).toBe('NOT_AUTHORIZED');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'CloseRecall', recallId: rc.id } }, a08)).status).toBe(200);
    expect(e.runtime.state.recalls?.[rc.id]?.status).toBe('CLOSED');
    hub.stop();
  });

  it('突发状况：带班负责人开启停电清单，员工按岗位打勾，结束后生成时间线；食品安全记录按天整理，带班负责人确认', async () => {
    const { hub, e, call } = await store();
    const a08 = await token(call, { associateId: 'A08' });
    const a04 = await token(call, { associateId: 'A04' });
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'StartIncident', kind: 'POWER' } }, a08)).status).toBe(200);
    const x = Object.values(e.runtime.state.incidents ?? {})[0];
    if (!x) throw new Error('no incident');
    // 同时只能有一个
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'StartIncident', kind: 'STORM' } }, a08)).body as { reject: { code: string } }).reject.code).toBe('INCIDENT_ACTIVE');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'CheckIncidentStep', incidentId: x.id, stepId: 'CLOSE_COLD_DOORS' } }, a04)).status).toBe(200);
    expect(e.runtime.state.incidents?.[x.id]?.checked.CLOSE_COLD_DOORS?.by).toBe('A04');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'EndIncident', incidentId: x.id } }, a08)).status).toBe(200);
    const rep = (await call('GET', `/api/stores/demo/incidents/${x.id}/report`, undefined, a08)).body as { timeline: Array<{ type: string }> };
    expect(rep.timeline.map((r) => r.type)).toEqual(expect.arrayContaining(['IncidentStarted', 'IncidentStepChecked', 'IncidentEnded']));
    // 食品安全记录
    const log = (await call('GET', '/api/stores/demo/ai/foodsafety', undefined, a08)).body as { date: string; rows: Array<{ sensorId: string }>; summary: { sensors: number } };
    expect(log.rows.length).toBe(log.summary.sensors);
    expect(log.rows.length).toBeGreaterThan(0);
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ConfirmFoodSafetyLog', date: log.date, note: 'ok' } }, a08)).status).toBe(200);
    expect(((await call('GET', '/api/stores/demo/ai/foodsafety', undefined, a08)).body as { confirmed?: { by: string } }).confirmed?.by).toBe('A08');
    hub.stop();
  });
});

describe('复盘、周报、问数、操作提示、下一步（决策记录 0024 · F2、F3、F5、D3、D4）', () => {
  it('打烊复盘和周报的接口；门店助手回答复盘、按小时、订单经过的问题，问答写进事件流，可以标有用', async () => {
    const { hub, e, call } = await store();
    const c = await token(call, { role: 'console' });
    await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 6, release: true, maxLines: 3, slotInMin: 40 }, c);
    await settle();
    const rv = (await call('GET', '/api/stores/demo/ai/review', undefined, c)).body as { actualLate: number; replay: number; factors: Record<string, number>; inputs: { orders: number } };
    expect(Object.keys(rv.factors).sort()).toEqual(['DEMAND', 'PACE', 'STAFF']);
    // 复盘只复刻已经开始的时段：这些单的时段在 40 分钟后，现在还不算；时段开始以后算进去
    expect(rv.inputs.orders).toBe(0);
    const slotStart = Math.min(...Object.values(e.runtime.state.orders).map((o) => o.slotStart));
    const later = closingReview(e.runtime, e.ai, slotStart + 60_000, dateOf(slotStart));
    expect(later.inputs.orders).toBeGreaterThanOrEqual(6);
    const wk = (await call('GET', '/api/stores/demo/ai/weekly', undefined, c)).body as { days: unknown[]; nextWeek: { orders: number } };
    expect(wk.days).toHaveLength(7);
    expect(wk.nextWeek.orders).toBeGreaterThan(0);
    const a08 = await token(call, { associateId: 'A08' });
    const ask = async (q: string) => (await call('POST', '/api/stores/demo/ai/ask', { question: q }, a08)).body as { tools: Array<{ name: string }>; answer: string; answerId?: string };
    expect((await ask('做一下打烊复盘')).tools[0]?.name).toBe('closing_review');
    expect((await ask('今天每小时的单量和迟到')).tools[0]?.name).toBe('metrics_by_hour');
    const o = Object.values(e.runtime.state.orders)[0];
    const tl = await ask(`订单 ${o?.shortCode} 的经过是怎样的？`);
    expect(tl.tools[0]?.name).toBe('order_timeline');
    expect(tl.answer).toContain('下单');
    expect(tl.answerId).toBeDefined();
    // 有用 / 没用：提问的人可以标，别人不行
    const a01 = await token(call, { associateId: 'A01' });
    expect(((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'RateAnswer', answerId: tl.answerId, helpful: true } }, a01)).body as { reject: { code: string } }).reject.code).toBe('NOT_YOURS');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'RateAnswer', answerId: tl.answerId, helpful: true } }, a08)).status).toBe(200);
    expect(e.runtime.state.answerStats).toMatchObject({ answered: 3, helpful: 1, unhelpful: 0 });
    hub.stop();
  });

  it('操作提示：有小测验的操作规范；看过记一次。下一步：拣货员手上没活时排出可领取的批次，照着做和换一个都记为反馈', async () => {
    const { hub, e, call } = await store();
    const a02 = await token(call, { associateId: 'A02' });
    const sop = (await call('GET', '/api/stores/demo/sop/cold-chain', undefined, a02)).body as { title: string; quiz: Array<{ options: string[]; answer: number }> };
    expect(sop.title).toBe('冷链时限');
    expect(sop.quiz.length).toBeGreaterThan(0);
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AckSop', sopId: 'cold-chain', correct: 2, total: 2 } }, a02)).status).toBe(200);
    expect(e.runtime.state.sopAcks?.A02?.['cold-chain']).toMatchObject({ correct: 2, total: 2 });
    const c = await token(call, { role: 'console' });
    await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 3, release: true, maxLines: 3, slotInMin: 30 }, c);
    await settle();
    const list = nextTasksFor(e.runtime.state, e.runtime.statics, 'A02', Date.now());
    expect(list[0]?.kind).toBe('WALK');
    expect(list[0]?.why).toContain('YOUR_ROLE');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'NextTaskFeedback', kind: 'WALK', ref: list[0]?.ref, taken: false } }, a02)).status).toBe(200);
    expect(e.runtime.state.nextTaskStats?.WALK).toEqual({ taken: 0, skipped: 1 });
    // 领了批次以后手上有活：不再排
    await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ClaimWalk', walkId: list[0]?.ref } }, a02);
    expect(nextTasksFor(e.runtime.state, e.runtime.statics, 'A02', Date.now())).toHaveLength(0);
    hub.stop();
  });
});
