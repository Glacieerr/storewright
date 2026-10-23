import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveClient } from '@storewright/ops/client';
import { pickRows, suggestSlots, type OpsCommand } from '@storewright/ops';
import { buildApp } from './app';
import { openDb, type Db } from './db';

let db: Db;
let base = '';
let close: () => Promise<void>;
const clients: LiveClient[] = [];

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function session(body: Record<string, string>): Promise<string> {
  const r = await fetch(`${base}/api/stores/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return ((await r.json()) as { token: string }).token;
}

async function post(token: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/stores/demo${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

const command = (token: string, cmd: OpsCommand, id?: string) => post(token, '/commands', id ? { id, cmd } : { cmd });

function client(token: string): LiveClient {
  const c = new LiveClient({ baseUrl: base, storeId: 'demo', token, pingMs: 1000 });
  c.connect();
  clients.push(c);
  return c;
}

beforeAll(async () => {
  db = await openDb({});
  const built = await buildApp({ db, demo: true });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  close = built.close;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await close();
  await db.close();
});

describe('后端：命令、推送与同步', () => {
  let consoleToken = '';
  let picker = '';
  let picker2 = '';
  let stager = '';
  let handoff = '';
  let handoff2 = '';
  let viewer = '';

  beforeAll(async () => {
    consoleToken = await session({ role: 'console' });
    picker = await session({ associateId: 'A01' });
    picker2 = await session({ associateId: 'A02' });
    stager = await session({ associateId: 'A04' });
    handoff = await session({ associateId: 'A05' });
    handoff2 = await session({ associateId: 'A06' });
    viewer = await session({ role: 'viewer' });
  });

  it('权限：员工不能下单，控制台不能拣货，没有令牌不能连接', async () => {
    expect((await post(picker, '/demo/orders', {})).status).toBe(403);
    expect((await command(consoleToken, { type: 'ClaimWalk', walkId: 'W001' })).status).toBe(403);
    expect((await command('nope', { type: 'ClaimWalk', walkId: 'W001' })).status).toBe(401);
    expect((await command(picker, { type: 'PickItem' } as never)).status).toBe(400);
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/stores/demo/ws?token=bad`);
      ws.onclose = (e) => resolve(e.code);
    });
    expect(closed).toBe(4401);
  });

  it('一张测试订单走完全链路，三个客户端的状态保持一致', async () => {
    const a = client(picker);
    const h = client(handoff);
    const v = client(viewer);
    await until(() => [a, h, v].every((c) => c.status === 'live'));
    const created = await post(consoleToken, '/demo/orders', { type: 'PICKUP', release: true, maxLines: 4, slotInMin: 30 });
    expect(created.status).toBe(200);
    const { orderId, code } = created.body.orders[0] as { orderId: string; code: string };
    await until(() => Object.keys(v.state.walks).length > 0 && v.state.orders[orderId]?.status === 'LOCKED');
    // 拣货员和交付员的客户端也要收到同样多的事件：负载高时拣货员的客户端可能还差一个批次，
    // 那个批次的框没拣，后面暂存就会被拒绝（偶发失败的原因）
    const seen = v.state.seq;
    await until(() => a.state.seq >= seen && h.state.seq >= seen);
    // 拣货
    for (const w of Object.values(a.state.walks).filter((x) => x.toteIds.some((id) => a.state.totes[id]?.orderId === orderId))) {
      expect((await a.send({ type: 'ClaimWalk', walkId: w.id })).ok).toBe(true);
      for (const id of w.toteIds) await a.send({ type: 'BindLabel', walkId: w.id, labelId: a.state.totes[id]?.labelId ?? '' });
      for (const r of pickRows(a.state, a.state.walks[w.id] as never)) await a.send({ type: 'PickItem', walkId: w.id, toteId: r.toteId, lineId: r.lineId, qty: r.qty });
      expect((await a.send({ type: 'CompleteWalk', walkId: w.id })).ok).toBe(true);
    }
    // 暂存（用命令接口，模拟另一台设备）
    for (const id of a.state.orders[orderId]?.toteIds ?? []) {
      const slot = suggestSlots(a.state, a.statics as never, id)[0] ?? '';
      const r = await command(stager, { type: 'StageTote', labelId: a.state.totes[id]?.labelId ?? '', slotCode: slot });
      expect(r.status, `${slot} ${JSON.stringify(r.body)}`).toBe(200);
    }
    await until(() => h.state.orders[orderId]?.status === 'STAGED');
    // 顾客到店 → 准备加锁 → 第二个员工被拒绝
    await command(consoleToken, { type: 'CheckIn', orderId, bay: '4' });
    await until(() => v.state.orders[orderId]?.arrivedAt !== undefined);
    expect((await h.send({ type: 'StartPrep', key: orderId })).ok).toBe(true);
    const locked = await command(handoff2, { type: 'StartPrep', key: orderId });
    expect(locked.status).toBe(409);
    expect(locked.body.reject).toMatchObject({ code: 'PREP_LOCKED', params: { by: 'A05' } });
    for (const id of h.state.orders[orderId]?.toteIds ?? []) await h.send({ type: 'ScanPrepTote', key: orderId, labelId: h.state.totes[id]?.labelId ?? '' });
    expect((await h.send({ type: 'VerifyCode', key: orderId, code })).ok).toBe(true);
    expect(h.state.sessions[orderId]?.verified).toBe('CODE');
    const done = await h.send({ type: 'CompleteHandoff', key: orderId, removeAgeItems: true });
    expect(done.ok).toBe(true);
    await until(() => v.state.orders[orderId]?.status === 'COMPLETED' && a.state.seq === v.state.seq);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(v.state));
  });

  it('两人同时领取同一个批次：只有一人成功', async () => {
    const made = await post(consoleToken, '/demo/orders', { type: 'PICKUP', release: true, maxLines: 3 });
    const orderId = made.body.orders[0].orderId as string;
    const v = clients[2] as LiveClient;
    const mine = () => Object.values(v.state.walks).find((x) => x.status === 'OPEN' && x.toteIds.some((t) => v.state.totes[t]?.orderId === orderId));
    await until(() => !!mine());
    const w = mine();
    const results = await Promise.all([command(picker, { type: 'ClaimWalk', walkId: w?.id ?? '' }), command(picker2, { type: 'ClaimWalk', walkId: w?.id ?? '' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.reject.code).toBe('WALK_CLAIMED');
  });

  it('同一个命令 ID 重复提交只生效一次', async () => {
    const made = await post(consoleToken, '/demo/orders', { type: 'PICKUP', release: true, maxLines: 2 });
    const orderId = made.body.orders[0].orderId as string;
    const v = clients[2] as LiveClient;
    // 等这张订单的批次推送到客户端（不要误用前一个测试里已被领取的批次）
    const mine = () => Object.values(v.state.walks).find((x) => x.status === 'OPEN' && x.toteIds.some((t) => v.state.totes[t]?.orderId === orderId));
    await until(() => !!mine());
    const w = mine();
    const first = await command(picker2, { type: 'UnclaimWalk', walkId: 'none' });
    expect(first.status).toBe(409);
    const r1 = await command(handoff2, { type: 'ClaimWalk', walkId: w?.id ?? '' }, 'cmd-123');
    const r2 = await command(handoff2, { type: 'ClaimWalk', walkId: w?.id ?? '' }, 'cmd-123');
    expect(r1.body.events).toHaveLength(1);
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.events[0].seq).toBe(r1.body.events[0].seq);
    const seq = r1.body.events[0].seq as number;
    await until(() => v.state.seq >= seq);
    await new Promise((r) => setTimeout(r, 50));
    expect(v.state.seq).toBe(seq);
  });

  it('断线期间的事件在重连后补齐；离线提交的命令进入发件箱，恢复后提交', async () => {
    const c = client(stager);
    await until(() => c.status === 'live');
    const before = c.state.seq;
    c.close();
    await post(consoleToken, '/demo/orders', { type: 'DELIVERY', release: true, maxLines: 2 });
    const v0 = clients[2] as LiveClient;
    await until(() => Object.values(v0.state.walks).some((w) => w.status === 'OPEN'));
    const open = Object.values(v0.state.walks).find((w) => w.status === 'OPEN');
    const queued = await c.send({ type: 'ClaimWalk', walkId: open?.id ?? '' });
    expect(queued).toMatchObject({ ok: true, queued: true });
    expect(c.outbox).toHaveLength(1);
    c.connect();
    const v = clients[2] as LiveClient;
    await until(() => c.outbox.length === 0 && c.state.walks[open?.id ?? '']?.associateId === 'A04' && c.state.seq === v.state.seq && c.state.seq > before);
    expect(JSON.stringify(c.state)).toBe(JSON.stringify(v.state));
  });

  it('重启后由事件重放得到同样的状态', async () => {
    const v = clients[2] as LiveClient;
    const again = await buildApp({ db, demo: true });
    const rt = again.stores.get('demo')?.runtime;
    expect(rt?.state.seq).toBe(v.state.seq);
    // jsonb 会重排对象的键，按结构比较
    expect(rt?.state).toEqual(v.state);
    await again.close();
  });

  it('状态同步延迟：命令提交到其他客户端收到事件，p95 < 200 ms', async () => {
    const other = clients[1] as LiveClient;
    const made = await post(consoleToken, '/demo/orders', { type: 'PICKUP', count: 5, maxLines: 2 });
    const v = clients[2] as LiveClient;
    const madeIds = (made.body.orders as Array<{ orderId: string }>).map((o) => o.orderId);
    await until(() => madeIds.every((id) => !!v.state.orders[id] && !!other.state.orders[id]));
    const ids = Object.values(v.state.orders).filter((o) => o.status === 'CREATED').map((o) => o.id);
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const target = other.state.seq + 1;
      const t0 = performance.now();
      const r = await command(consoleToken, { type: 'UpdateEta', orderId: ids[i % ids.length] ?? '', etaAt: Date.now() + 600_000 });
      expect(r.status).toBe(200);
      await until(() => other.state.seq >= target, 2000);
      samples.push(performance.now() - t0);
    }
    samples.sort((x, y) => x - y);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
    expect(p95).toBeLessThan(200);
  });
});
