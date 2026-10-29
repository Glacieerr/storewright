import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpsState } from '@storewright/ops';
import { buildApp } from './app';
import { openDb, type Db } from './db';

let db: Db;
let base = '';
let close: () => Promise<void>;

async function session(body: Record<string, string>): Promise<string> {
  const r = await fetch(`${base}/api/stores/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return ((await r.json()) as { token: string }).token;
}
async function call(method: 'GET' | 'POST', token: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/stores/demo${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
}
const state = async (t: string) => (await call('GET', t, '/snapshot')).body.state as OpsState;

beforeAll(async () => {
  db = await openDb({});
  const built = await buildApp({ db, demo: true, storeIds: ['demo', 'hardware'] });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  close = built.close;
});
afterAll(async () => {
  await close();
  await db.close();
});

describe('business modules over HTTP (Phase 6)', () => {
  it('MTO tickets get an AI-adjusted start time; the deli cooks and holds them', async () => {
    const c = await session({ role: 'console' });
    const deli = await session({ associateId: 'A11' });
    const r = await call('POST', c, '/demo/orders', { type: 'PICKUP', count: 3, maxLines: 2, release: false, slotInMin: 180, mto: true });
    expect(r.status).toBe(200);
    let s = await state(c);
    for (let i = 0; i < 50 && Object.values(s.recs).filter((x) => x.module === 'MTO').length < 3; i++) {
      await new Promise((res) => setTimeout(res, 20));
      s = await state(c);
    }
    const tickets = Object.values(s.mto);
    expect(tickets).toHaveLength(3);
    const recs = Object.values(s.recs).filter((x) => x.module === 'MTO');
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toMatchObject({ status: 'AUTO_APPLIED', action: { kind: 'SET_MTO_START' } });
    expect(tickets.some((t) => t.aiAdjusted && t.startAt !== t.standardStartAt)).toBe(true);
    const t = tickets[0]!;
    expect((await call('POST', deli, '/commands', { cmd: { type: 'StartMto', ticketId: t.id } })).status).toBe(200);
    expect((await call('POST', deli, '/commands', { cmd: { type: 'CompleteMto', ticketId: t.id, slotCode: 'H-01' } })).status).toBe(200);
    expect((await state(c)).mto[t.id]).toMatchObject({ status: 'HELD', slotCode: 'H-01' });
  });

  it('returns get a disposition suggestion; oversized orders create pieces; parcels flow by trip', async () => {
    const c = await session({ role: 'console' });
    const lead = await session({ associateId: 'A08' });
    const created = await call('POST', c, '/demo/orders', { type: 'PICKUP', count: 1, maxLines: 2, release: true, slotInMin: 40, oversized: true });
    const orderId = created.body.orders[0].orderId as string;
    let s = await state(c);
    const pieces = Object.values(s.oversized).filter((p) => p.orderId === orderId);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    // 退货
    expect((await call('POST', lead, '/commands', { cmd: { type: 'StartReturn', orderId, kind: 'CUSTOMER' } })).status).toBe(200);
    s = await state(c);
    const ret = Object.values(s.returns)[0]!;
    const gtin = s.orders[orderId]!.lines[0]!.gtin;
    expect((await call('POST', lead, '/commands', { cmd: { type: 'ScanReturnItem', returnId: ret.id, code: gtin, qty: 1, condition: 'SEALED' } })).status).toBe(200);
    const sug = await call('GET', lead, `/ai/return-suggestion?returnId=${ret.id}&index=0`);
    expect(['RESTOCK', 'DISPOSE', 'HAZMAT', 'VENDOR']).toContain(sug.body.disposition);
    expect(sug.body.p).toBeGreaterThan(0);
    // 硬性规则：冷藏商品的建议不会是回架，员工选回架被拒绝
    const snap = (await call('GET', lead, '/snapshot')).body as { statics: { planogram: Array<{ gtin: string; tempZone: string }> } };
    const cold = snap.statics.planogram.find((p) => p.tempZone === 'CHILLED')!;
    expect((await call('POST', lead, '/commands', { cmd: { type: 'ScanReturnItem', returnId: ret.id, code: cold.gtin, qty: 1, condition: 'SEALED' } })).status).toBe(200);
    const coldSug = await call('GET', lead, `/ai/return-suggestion?returnId=${ret.id}&index=1`);
    expect(coldSug.body.disposition).not.toBe('RESTOCK');
    expect(coldSug.body.allowed).not.toContain('RESTOCK');
    const refused = await call('POST', lead, '/commands', { cmd: { type: 'SetReturnDisposition', returnId: ret.id, index: 1, disposition: 'RESTOCK' } });
    expect(refused.status).toBe(409);
    expect(refused.body.reject.code).toBe('DISPOSITION_NOT_ALLOWED');
    // 包裹
    const asn = await call('POST', c, '/demo/parcels', { count: 4, trips: 2 });
    const [p1, p2, p3] = asn.body.parcels as string[];
    // 到货通知里没有的编码不会直接变成「多出」（决策记录 0026）
    const unknown = await call('POST', lead, '/commands', { cmd: { type: 'InductParcel', code: 'NOPE-1' } });
    expect(unknown.status).toBe(409);
    expect(unknown.body.reject.code).toBe('PARCEL_NOT_FOUND');
    expect((await call('POST', lead, '/commands', { cmd: { type: 'InductParcel', code: 'NOPE-1', extra: true } })).status).toBe(200);
    expect((await call('POST', lead, '/commands', { cmd: { type: 'ResolveParcel', parcelId: 'NOPE-1', action: 'RETURN' } })).status).toBe(200);
    expect((await call('POST', lead, '/commands', { cmd: { type: 'InductParcel', code: p1 } })).status).toBe(200);
    expect((await call('POST', lead, '/commands', { cmd: { type: 'InductParcel', code: p3 } })).status).toBe(200);
    expect((await call('POST', lead, '/commands', { cmd: { type: 'StageParcel', parcelId: p1, slotCode: 'P01' } })).status).toBe(200);
    expect((await call('POST', lead, '/commands', { cmd: { type: 'StageParcel', parcelId: p3, slotCode: 'P02' } })).status).toBe(200);
    s = await state(c);
    expect(s.parcels[p1!]!.tripRef).toBe(s.parcels[p3!]!.tripRef);
    // 员工手机也能按行程交给司机（以前只有控制台）
    expect((await call('POST', lead, '/commands', { cmd: { type: 'HandOffParcels', tripRef: s.parcels[p1!]!.tripRef } })).status).toBe(200);
    expect((await state(c)).parcels[p2!]!.status).toBe('EXPECTED');
  });
});

describe('second industry over HTTP (Phase 6)', () => {
  it('the hardware store runs on the same server with its own modules and roster', async () => {
    const r = await fetch(`${base}/api/stores/hardware/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'console' }) });
    const token = ((await r.json()) as { token: string }).token;
    const snap = (await (await fetch(`${base}/api/stores/hardware/snapshot`, { headers: { authorization: `Bearer ${token}` } })).json()) as { statics: { name: string; modules: Record<string, boolean>; roster: Array<{ role: string }>; slots: Array<{ tempZone: string }> } };
    expect(snap.statics.name).toBe('Home improvement store');
    expect(snap.statics.modules).toMatchObject({ mto: false, parcel: true, oversized: true, returns: true });
    expect(snap.statics.roster.some((a) => a.role === 'DELI')).toBe(false);
    expect(snap.statics.slots.every((x) => x.tempZone === 'AMBIENT')).toBe(true);
    const post = (path: string, body: unknown) => fetch(`${base}/api/stores/hardware${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: (await x.json()) as any }));
    const created = await post('/demo/orders', { type: 'PICKUP', count: 2, maxLines: 3, release: false, slotInMin: 180, oversized: true });
    expect(created.status).toBe(200);
    const orderId = created.body.orders[0].orderId as string;
    // 两家店的订单短号不重复（短号里含门店编号）
    const demoConsole = await session({ role: 'console' });
    const demoOrders = Object.values((await state(demoConsole)).orders).map((o) => o.shortCode);
    expect(created.body.orders.some((o: { shortCode: string }) => demoOrders.includes(o.shortCode))).toBe(false);
    // 熟食模块关闭：命令被拒绝
    const mto = await post('/commands', { cmd: { type: 'CreateMtoTicket', orderId, menuId: 'x', qty: 1 } });
    expect(mto.body.reject?.code ?? mto.body.code).toBe('MODULE_DISABLED');
  });
});
