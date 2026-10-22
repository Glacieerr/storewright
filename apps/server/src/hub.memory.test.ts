import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hub } from './hub';
import { randomInt, sha256Hex, toBase64Url, webPlatform } from './platform';
import { memoryStorage } from './storage';
import { AUTO_RESTOCK_ACTOR, StoreSim } from './storeSim';
import { sellableCases, shelfNow } from '@storewright/ops';

describe('browser platform (in-browser demo mode)', () => {
  it('pure TypeScript SHA-256 matches node:crypto', () => {
    for (const s of ['', 'abc', 'salt:O1-00001:K7Q4', '中文 · émoji 🚚', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)]) expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
  });

  it('base64url matches Buffer and random integers stay in range', () => {
    for (const n of [1, 2, 3, 16, 24, 31]) {
      const b = new Uint8Array(randomBytes(n));
      expect(toBase64Url(b)).toBe(Buffer.from(b).toString('base64url'));
    }
    for (let i = 0; i < 500; i++) {
      const v = randomInt(webPlatform, 31);
      expect(v >= 0 && v < 31).toBe(true);
    }
  });
});

describe('store hub on in-memory storage', () => {
  it('serves sessions, commands and live pushes without a database or HTTP server', async () => {
    const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'], lazyStores: true });
    expect(hub.stores.size).toBe(0);
    const call = (method: string, path: string, body?: unknown, token?: string) => hub.handle({ method, path, query: {}, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
    const consoleSession = await call('POST', '/api/stores/demo/session', { role: 'console' });
    expect(consoleSession.status).toBe(200);
    const token = (consoleSession.body as { token: string }).token;
    expect(hub.stores.size).toBe(1);
    expect((await call('POST', '/api/stores/nowhere/session', { role: 'console' })).status).toBe(404);

    const pushed: Array<{ t: string }> = [];
    const conn = await hub.connect('demo', token, 0, (m) => pushed.push(m as { t: string }));
    expect(conn).toBeDefined();
    expect(pushed.map((m) => m.t).slice(0, 2)).toEqual(['hello', 'snapshot']);

    const created = await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 2, release: true, maxLines: 3, slotInMin: 60 }, token);
    expect(created.status).toBe(200);
    expect((created.body as { orders: unknown[] }).orders).toHaveLength(2);
    expect(pushed.some((m) => m.t === 'events')).toBe(true);

    const picker = (await call('POST', '/api/stores/demo/session', { associateId: 'A01' })).body as { token: string };
    const snap = (await call('GET', '/api/stores/demo/snapshot', undefined, picker.token)).body as { state: { walks: Record<string, { id: string }> } };
    const walk = Object.values(snap.state.walks)[0];
    expect(walk).toBeDefined();
    const claim = await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ClaimWalk', walkId: walk?.id } }, picker.token);
    expect(claim.status).toBe(200);
    // 员工不能提交控制台的命令
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'CancelOrder', orderId: 'x', reason: 'r' } }, picker.token)).status).toBe(403);
    // 标签（SVG）
    const label = await call('GET', `/api/stores/demo/labels/walk/${walk?.id}`, undefined, picker.token);
    expect(label.type).toContain('text/html');
    expect(String(label.body)).toContain('<svg');
    conn?.close();
    hub.stop();
  });
});

describe('phantom stock in the accelerated demo (found by the walkthrough)', () => {
  it('flags an item that went missing before it ever sold, once the store keeps selling around it', async () => {
    const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'] });
    const e = hub.stores.get('demo');
    if (!e) throw new Error('no store');
    // 卖得最快、没有货架传感器的商品：开门后还没卖出就被放错地方
    const target = [...e.runtime.statics.planogram].sort((a, b) => b.baseVelocity - a.baseVelocity).find((p) => !p.sensor);
    if (!target) throw new Error('no target');
    const sim = new StoreSim(e.runtime, 11, 2000);
    sim.start(600);
    sim.stop();
    await sim.emptyShelf(target.itemId, true);
    // 每一拍是 20 分钟的仿真销量（时钟几乎不走）
    const tick = (sim as unknown as { tick(): Promise<void> }).tick.bind(sim);
    for (let i = 0; i < 24; i++) await tick();
    await e.ai.scanShelves(Date.now(), 1000);
    const rec = Object.values(e.runtime.state.recs).find((r) => r.module === 'AVAILABILITY' && r.target === target.itemId);
    expect(rec?.prediction?.value).toBeLessThan(0.35);
    const silence = rec?.reasons.find((r) => r.factor === 'NO_SALES');
    expect(silence?.value).toBeGreaterThan(1);
    hub.stop();
  });
});

describe('auto-restock in the demo store (found by the walkthrough)', () => {
  it('a virtual restocker works open restock tasks while the shopping simulation runs', async () => {
    const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'] });
    const e = hub.stores.get('demo');
    if (!e) throw new Error('no store');
    const s = e.runtime.state;
    // 没有传感器的商品（测试里停了仿真的订阅，传感器会按旧的真实存量上报）
    const target = e.runtime.statics.planogram.find((p) => !p.sensor && sellableCases(s, p.itemId).length > 0);
    if (!target) throw new Error('no target');
    const sim = new StoreSim(e.runtime, 11, 2000);
    sim.start(600);
    sim.stop();
    await sim.emptyShelf(target.itemId, false);
    const task = Object.values(s.repl).find((t) => t.itemId === target.itemId && t.status === 'OPEN');
    expect(task).toBeDefined();
    const tick = (sim as unknown as { tick(): Promise<void> }).tick.bind(sim);
    // 关闭时不处理
    await tick();
    expect(s.repl[task!.id]?.status).toBe('OPEN');
    sim.setAutoRestock(true);
    await tick();
    expect(s.repl[task!.id]).toMatchObject({ status: 'DONE', associateId: AUTO_RESTOCK_ACTOR });
    expect(shelfNow(s, target).est).toBeGreaterThan(0);
    expect(sim.status.autoRestocked).toBeGreaterThan(0);
    hub.stop();
  });
});
