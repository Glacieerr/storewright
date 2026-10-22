import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBroker } from 'aedes';
import { connectAsync } from 'mqtt';
import { LiveClient } from '@storewright/ops/client';
import { sellableCases, shelfNow, type PlanogramEntry } from '@storewright/ops';
import { buildApp } from './app';
import { openDb, type Db } from './db';
import { sensorPayload } from './sensing';
import { StoreSim } from './storeSim';

let db: Db;
let base = '';
let close: () => Promise<void>;
let broker: ReturnType<typeof createBroker>;
let mqttServer: Server;
let mqttPort = 0;
let built: Awaited<ReturnType<typeof buildApp>>;
let viewer: LiveClient;
let consoleToken = '';

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function session(body: Record<string, string>): Promise<string> {
  const r = await fetch(`${base}/api/stores/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return ((await r.json()) as { token: string }).token;
}

async function post(token: string | undefined, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/stores/demo${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

beforeAll(async () => {
  broker = createBroker();
  mqttServer = createServer(broker.handle);
  await new Promise<void>((r) => mqttServer.listen(0, '127.0.0.1', () => r()));
  const a = mqttServer.address();
  mqttPort = typeof a === 'object' && a ? a.port : 0;
  db = await openDb({});
  built = await buildApp({ db, demo: true, mqttUrl: `mqtt://127.0.0.1:${mqttPort}` });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  close = built.close;
  consoleToken = await session({ role: 'console' });
  viewer = new LiveClient({ baseUrl: base, storeId: 'demo', token: await session({ role: 'viewer' }) });
  viewer.connect();
  await until(() => viewer.status === 'live' && !!viewer.statics);
});

afterAll(async () => {
  viewer.close();
  await close();
  await db.close();
  await new Promise<void>((r) => broker.close(() => r()));
  await new Promise<void>((r) => mqttServer.close(() => r()));
});

const rt = () => {
  const r = built.stores.get('demo')?.runtime;
  if (!r) throw new Error('runtime');
  return r;
};

describe('后仓库存与补货（后端）', () => {
  it('建店时载入期初库存；快照里有陈列表和库位', () => {
    expect(Object.keys(viewer.state.cases).length).toBeGreaterThan(100);
    expect(viewer.statics?.planogram.length).toBeGreaterThan(1000);
    expect(viewer.statics?.bins.some((b) => b.status === 'QA')).toBe(true);
    expect(JSON.stringify(viewer.state)).toBe(JSON.stringify(rt().state));
  });

  it('传感器 HTTP 入口：原型格式的读数更新估算；格式不对的被拒绝；遮挡标记按低置信度处理', async () => {
    const p = viewer.statics?.planogram.find((x) => x.sensor === 'tof') as PlanogramEntry;
    const ok = await post(undefined, '/sensors', sensorPayload('demo', p.locationId, 'tof', 2, 0.95, 1, p.itemId));
    expect(ok.body).toEqual({ accepted: 1, rejected: [] });
    await until(() => viewer.state.shelf[p.itemId]?.est === 2);
    expect(viewer.state.shelf[p.itemId]).toMatchObject({ source: 'SENSOR', conf: 0.95 });
    const bad = await post(undefined, '/sensors', [{ schema: 'other' }, { ...sensorPayload('demo', p.locationId, 'tof', 1, 0.9, 2, p.itemId), flags: ['occluded'] }]);
    expect(bad.body.accepted).toBe(1);
    expect(bad.body.rejected).toEqual([{ index: 0, error: 'schema' }]);
    await until(() => viewer.state.shelf[p.itemId]?.sensorAnomaly === true);
  });

  it('MQTT 入口：订阅 state 主题', async () => {
    const p = viewer.statics?.planogram.filter((x) => x.sensor).at(-1) as PlanogramEntry;
    const client = await connectAsync(`mqtt://127.0.0.1:${mqttPort}`);
    const topic = `storewright/v1/demo/sense/${p.locationId.split('-').slice(0, 2).join('-')}/${p.locationId}/${p.sensor}/state`;
    await client.publishAsync(topic, JSON.stringify(sensorPayload('demo', p.locationId, p.sensor ?? 'tof', 3, 0.93, 7, p.itemId)), { qos: 1 });
    await until(() => viewer.state.shelf[p.itemId]?.est === 3 && viewer.state.shelf[p.itemId]?.source === 'SENSOR');
    await client.endAsync();
  });

  it('门店客流仿真提交销售流水，真实存量与估算一起变化', async () => {
    const sim = new StoreSim(rt(), 3, 40);
    sim.start(3600);
    await until(() => sim.status.sold > 0 && Object.values(viewer.state.shelf).some((s) => s.source === 'POS'));
    sim.stop();
    expect(sim.status.running).toBe(false);
  });

  it('实时闭环：货架变空 → 补货任务 → 补货员扫描箱子和货位上架 → 估算恢复', async () => {
    const st = viewer.statics;
    if (!st) throw new Error('statics');
    const p = st.planogram.find((x) => sellableCases(viewer.state, x.itemId).length && !Object.values(viewer.state.repl).some((t) => t.itemId === x.itemId)) as PlanogramEntry;
    const e = await post(consoleToken, '/demo/shelf-empty', { itemId: p.itemId, silent: false });
    expect(e.status).toBe(200);
    await until(() => Object.values(viewer.state.repl).some((t) => t.itemId === p.itemId && t.status === 'OPEN'));
    expect(shelfNow(viewer.state, p).est).toBe(0);
    const task = Object.values(viewer.state.repl).find((t) => t.itemId === p.itemId);
    const restocker = await session({ associateId: 'A10' });
    const cmd = (c: unknown) => post(restocker, '/commands', { cmd: c });
    expect((await cmd({ type: 'ClaimReplenishment', taskIds: [task?.id] })).status).toBe(200);
    const kase = sellableCases(viewer.state, p.itemId)[0];
    const units = Math.min(kase?.units ?? 1, p.capacity);
    const done = await cmd({ type: 'CompleteReplenishment', taskId: task?.id, caseId: kase?.id, locationId: p.locationId, units });
    expect(done.status).toBe(200);
    await until(() => shelfNow(viewer.state, p).est === units);
    expect(viewer.state.repl[task?.id ?? '']?.status).toBe('DONE');
  });

  it('到货通知 → 收货 → 打印箱标签 → 上架', async () => {
    const asn = await post(consoleToken, '/demo/asn', { items: 2 });
    expect(asn.status).toBe(200);
    const receiptId = asn.body.events[0].payload.receiptId as string;
    const line = asn.body.events[0].payload.expected[0] as { gtin: string; itemId: string };
    expect((await post(consoleToken, '/commands', { cmd: { type: 'ArriveTruck', receiptId } })).status).toBe(200);
    const receiver = await session({ associateId: 'A09' });
    const got = await post(receiver, '/commands', { cmd: { type: 'ReceiveCases', receiptId, gtin: line.gtin, cases: 2 } });
    expect(got.status).toBe(200);
    const caseIds = got.body.events[0].payload.caseIds as string[];
    const svg = await fetch(`${base}/api/stores/demo/labels/case/${caseIds[0]}.svg`);
    expect(svg.status).toBe(200);
    expect(await svg.text()).toContain(caseIds[0]);
    const sheet = await fetch(`${base}/api/stores/demo/labels/receipt/${receiptId}`);
    expect((await sheet.text()).split('<svg').length - 1).toBe(2);
    const p = viewer.statics?.planogram.find((x) => x.itemId === line.itemId) as PlanogramEntry;
    const bin = viewer.statics?.bins.find((b) => b.status === 'SELLABLE' && b.tempZone === p.tempZone && b.area === p.area && (viewer.state.bins[b.code]?.length ?? 0) < b.capacityCases);
    const put = await post(receiver, '/commands', { cmd: { type: 'PutAwayCase', caseId: caseIds[0], binCode: bin?.code } });
    expect(put.status).toBe(200);
    const closed = await post(receiver, '/commands', { cmd: { type: 'CloseReceipt', receiptId } });
    expect(closed.body.events[0].payload.discrepancies.length).toBeGreaterThan(0);
  });
});
