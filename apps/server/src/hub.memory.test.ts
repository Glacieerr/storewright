import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hub } from './hub';
import { randomInt, sha256Hex, toBase64Url, webPlatform } from './platform';
import { memoryStorage } from './storage';
import { AUTO_RESTOCK_ACTOR, StoreSim } from './storeSim';
import { areaUsage, sellableCases, shelfNow } from '@storewright/ops';

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
    const conn = await hub.connect('demo', token, 0, (m) => pushed.push(JSON.parse(m) as { t: string }));
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
    // 司机取消接单（决策记录 0014）：控制台代替司机提交（经过作业核心的规则）；员工不能代替司机取消
    const cancel = await call('POST', '/api/stores/demo/commands', { cmd: { type: 'CancelTripDriver', tripId: 'TR999' } }, token);
    expect(cancel.status).toBe(409);
    expect((cancel.body as { reject: { code: string } }).reject.code).toBe('TRIP_NOT_FOUND');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'CancelTripDriver', tripId: 'TR999' } }, picker.token)).status).toBe(403);
    // 改派：员工端允许提交，作业核心只接受带班负责人
    const redispatch = await call('POST', '/api/stores/demo/commands', { cmd: { type: 'RedispatchTrip', tripId: 'TR999' } }, picker.token);
    expect((redispatch.body as { reject: { code: string } }).reject.code).toBe('TRIP_NOT_FOUND');
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

describe('auto-operations track in parallel with manual work (dual track)', () => {
  it('virtual customers and associates complete orders end to end; manual orders never share a walk or trip with them', async () => {
    const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'] });
    const e = hub.stores.get('demo');
    if (!e) throw new Error('no store');
    const s = e.runtime.state;
    let now = Date.now();
    // 员工手里的一张自取订单（控制台下单）
    const mine = e.demo.makeOrder({ index: 0, type: 'PICKUP', slotStart: now + 3_600_000, maxLines: 3 });
    expect((await e.runtime.submit({ cmd: { type: 'CreateOrder', order: mine.info, codeHash: mine.codeHash }, actor: 'console', at: now })).ok).toBe(true);
    await e.runtime.submit({ cmd: { type: 'LockOrder', orderId: mine.info.id }, actor: 'console', at: now });
    e.auto.start({ ordersPerHour: 240, deliveryShare: 0.3, pace: 8 });
    e.auto.stop(); // 测试里手动推进
    for (let i = 0; i < 400; i++) {
      now += 2000;
      await e.auto.tick(false, now);
      if (i % 5 === 0) await e.runtime.submit({ cmd: { type: 'Tick', release: true }, actor: 'system', at: now });
    }
    const auto = Object.values(s.orders).filter((o) => o.track === 'AUTO');
    expect(auto.length).toBeGreaterThan(5);
    expect(e.auto.status.completed).toBeGreaterThan(3);
    expect(e.auto.status.avgMinutes).toBeGreaterThan(0);
    // 分开批次：每个批次要么全是自动运营的订单，要么一张都没有
    for (const w of Object.values(s.walks)) {
      const tracks = new Set(w.toteIds.map((t) => s.orders[s.totes[t]?.orderId ?? '']?.track === 'AUTO'));
      expect(tracks.size).toBe(1);
      expect(w.track === 'AUTO').toBe(tracks.has(true));
    }
    // 员工的订单没有被虚拟员工动过
    const mineWalks = Object.values(s.walks).filter((w) => w.toteIds.some((t) => s.totes[t]?.orderId === mine.info.id));
    expect(mineWalks.length).toBeGreaterThan(0);
    expect(mineWalks.every((w) => w.status === 'OPEN')).toBe(true);
    // 自动运营的配送：行程只含自动运营的订单，虚拟司机接单、到店交接
    for (const t of Object.values(s.trips)) expect(new Set(t.orderIds.map((id) => s.orders[id]?.track === 'AUTO')).size).toBe(1);
    expect(Object.values(s.trips).some((t) => t.completedAt !== undefined)).toBe(true);
    hub.stop();
  });
});

describe('area management in the live store (decision 0013)', () => {
  it('statics carry areas and docks; bins and slots point at their areas; usage follows receiving and staging', async () => {
    const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'] });
    const e = hub.stores.get('demo');
    if (!e) throw new Error('no store');
    const st = e.runtime.statics;
    const s = e.runtime.state;
    const kinds = new Set(st.areas?.map((a) => a.kind));
    for (const k of ['RACKS', 'COOLER', 'FREEZER', 'UNLOAD', 'RECEIVING_HOLD', 'QA', 'RTV', 'STAGING', 'PARCEL', 'HOT_HOLD']) expect(kinds.has(k), k).toBe(true);
    expect(st.docks?.length).toBe(3);
    expect(st.bins.filter((b) => b.code.startsWith('CLR-')).every((b) => st.areas?.find((a) => a.id === b.areaId)?.kind === 'COOLER')).toBe(true);
    expect(st.bins.find((b) => b.code === 'QA-CHL')?.areaId).toBe('QA-1');
    expect(st.slots.every((sl) => !!sl.areaId)).toBe(true);
    const use = (kind: string) => areaUsage(s, st).find((u) => u.area.kind === kind)!;
    // 期初库存放在货架区和冷库里
    expect(use('RACKS').used).toBeGreaterThan(0);
    expect(use('COOLER').used).toBeGreaterThan(0);
    // 收货：没上架的箱子算在收货暂放区
    const now = Date.now();
    const item = st.planogram[0]!;
    const asn = await e.runtime.submit({ cmd: { type: 'CreateAsn', supplier: 'Test', lines: [{ itemId: item.itemId, gtin: item.gtin, name: item.name, cases: 3, packQty: item.packQty }] }, actor: 'console', at: now });
    expect(asn.ok).toBe(true);
    const receiptId = Object.keys(s.receipts).at(-1)!;
    await e.runtime.submit({ cmd: { type: 'ArriveTruck', receiptId }, actor: 'A09', at: now });
    const before = use('RECEIVING_HOLD').used;
    await e.runtime.submit({ cmd: { type: 'ReceiveCases', receiptId, gtin: item.gtin, cases: 2 }, actor: 'A09', at: now });
    expect(use('RECEIVING_HOLD').used).toBe(before + 2);
    hub.stop();
  });
});

describe('Your Store: a live store built from a visitor config (decision 0013)', () => {
  it('creates a store from a valid config (same config, same id), rejects invalid ones, and runs orders on it', async () => {
    const { generateStoreConfig, templateParams, materializeAreas } = await import('@storewright/store-config');
    const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'], lazyStores: true });
    const call = (method: string, path: string, body?: unknown, token?: string) => hub.handle({ method, path, query: {}, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
    const config = generateStoreConfig({ ...templateParams('small'), name: 'My corner shop', parking: { rows: 0, pickupBays: 6 } });
    materializeAreas(config);
    config.parking = { pickupBays: [1, 2, 3].map((k) => ({ id: `B${k}`, x: 10 + k * 3, z: -11.7, heading: 0 })) };
    const a = (await call('POST', '/api/custom-stores', { config })).body as { ok: boolean; storeId: string };
    expect(a.ok).toBe(true);
    expect(a.storeId).toMatch(/^my-[0-9a-f]{10}$/);
    expect(((await call('POST', '/api/custom-stores', { config })).body as { storeId: string }).storeId).toBe(a.storeId);
    const bad = await call('POST', '/api/custom-stores', { config: { ...config, layout: { ...config.layout, runs: [] } } });
    expect(bad.status).toBe(400);
    const e = hub.stores.get(a.storeId)!;
    expect(e.runtime.statics.name).toBe('My corner shop');
    expect(e.runtime.statics.pickupBays).toEqual(['B1', 'B2', 'B3']);
    const token = ((await call('POST', `/api/stores/${a.storeId}/session`, { role: 'console' })).body as { token: string }).token;
    const created = await call('POST', `/api/stores/${a.storeId}/demo/orders`, { type: 'PICKUP', count: 1, release: true }, token);
    expect((created.body as { orders: unknown[] }).orders).toHaveLength(1);
    const id = (created.body as { orders: Array<{ orderId: string }> }).orders[0]!.orderId;
    expect((await call('POST', `/api/stores/${a.storeId}/commands`, { cmd: { type: 'CheckIn', orderId: id, bay: '7' } }, token)).body).toMatchObject({ ok: false, reject: { code: 'BAY_NOT_FOUND' } });
    expect((await call('POST', `/api/stores/${a.storeId}/commands`, { cmd: { type: 'CheckIn', orderId: id, bay: 'B2' } }, token)).status).toBe(200);
    hub.stop();
  });
});

describe('capacity for large stores (decision 0014)', () => {
  it('a 300-person store: pushes are batched under load, devices that already have the static data do not get it again, old work is left out of snapshots', async () => {
    const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['large'], lazyStores: true });
    const e = await hub.store('large');
    if (!e) throw new Error('store');
    expect(e.runtime.statics.roster).toHaveLength(300);
    expect(new Set(e.runtime.statics.roster.map((a) => a.id)).size).toBe(300);
    const call = (method: string, path: string, body?: unknown, token?: string) => hub.handle({ method, path, query: {}, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
    const tok = async (associateId: string) => ((await call('POST', '/api/stores/large/session', { associateId })).body as { token: string }).token;
    // 第一台设备：快照里有静态数据和它的版本
    const a: Array<{ t: string; staticsHash?: string; statics?: unknown; events?: Array<{ seq: number }>; state?: { seq: number } }> = [];
    const ca = await hub.connect('large', await tok('A01'), 0, (m) => a.push(JSON.parse(m) as (typeof a)[number]));
    const hello = a.find((m) => m.t === 'hello');
    const snapA = a.find((m) => m.t === 'snapshot');
    expect(snapA?.statics).toBeDefined();
    expect(snapA?.staticsHash).toBe(hello?.staticsHash);
    // 第二台设备已经有同一版本：快照里不再带静态数据
    const b: typeof a = [];
    const cb = await hub.connect('large', await tok('A150'), 0, (m) => b.push(JSON.parse(m) as (typeof a)[number]), hello?.staticsHash);
    const snapB = b.find((m) => m.t === 'snapshot');
    expect(snapB?.statics).toBeUndefined();
    expect(snapB?.state?.seq).toBe(snapA?.state?.seq);
    // 一口气提交 40 条命令：合成很少几条推送，序号连续
    const o = e.demo.makeOrder({ index: 1, type: 'PICKUP', slotStart: Date.now() + 3600_000, maxLines: 2 });
    await e.runtime.submit({ cmd: { type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, actor: 'console', at: Date.now() });
    await new Promise((r) => setTimeout(r, 40));
    const before = a.length;
    for (let i = 0; i < 40; i++) await e.runtime.submit({ cmd: { type: 'UpdateEta', orderId: o.info.id, etaAt: Date.now() + (10 + i) * 60_000 }, actor: 'customer', at: Date.now() });
    await new Promise((r) => setTimeout(r, 40));
    e.runtime.flush();
    const pushes = a.slice(before).filter((m) => m.t === 'events');
    const seqs = pushes.flatMap((m) => (m.events ?? []).map((x) => x.seq));
    expect(pushes.length).toBeLessThan(10);
    expect(seqs.length).toBeGreaterThanOrEqual(40);
    expect(seqs.every((s, i) => i === 0 || s === (seqs[i - 1] ?? 0) + 1)).toBe(true);
    // 两台设备收到同样的推送
    expect(JSON.stringify(b.slice(-pushes.length))).toBe(JSON.stringify(a.slice(-pushes.length)));
    ca?.close();
    cb?.close();
    hub.stop();
  });
});
