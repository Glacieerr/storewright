import { describe, expect, it } from 'vitest';
import { onDuty } from '@storewright/ops';
import { forecast, sensorsFor, type TwinReplay, type TwinSnapshot } from '@storewright/twin';
import { Hub } from './hub';
import { webPlatform } from './platform';
import { memoryStorage } from './storage';

async function demoHub() {
  const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'], lazyStores: true });
  const call = (method: string, path: string, body?: unknown, token?: string, query: Record<string, string> = {}) => hub.handle({ method, path, query, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  const consoleToken = ((await call('POST', '/api/stores/demo/session', { role: 'console' })).body as { token: string }).token;
  const e = hub.stores.get('demo');
  if (!e) throw new Error('no store');
  return { hub, call, consoleToken, e };
}

describe('digital twin on the store hub (decision 0016)', () => {
  it('derives sensors from the store, takes device telemetry, and pushes frames only to twin subscribers', async () => {
    const { hub, call, consoleToken, e } = await demoHub();
    const ids = e.twin.defs.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['T-COOLER-1', 'T-FREEZER-1', 'C-ENTRANCE']));
    expect(ids.some((id) => id.startsWith('T-STAGING') && id.endsWith('-C'))).toBe(true);
    expect(ids.some((id) => id.startsWith('T-STAGING') && id.endsWith('-F'))).toBe(true);
    expect(ids.some((id) => id.startsWith('D-DOOR-'))).toBe(true);
    // 查看端从同一份静态数据算出同一份清单
    expect(sensorsFor(e.runtime.statics).map((d) => d.id)).toEqual(ids);

    let now = Date.now();
    for (let i = 0; i < 5; i++, now += 2000) await e.twin.tick(now);
    const snap = (await call('GET', '/api/stores/demo/twin', undefined, consoleToken)).body as TwinSnapshot;
    expect(snap.demo).toBe(true);
    expect(snap.frame.sensors.map((s) => s.id).sort()).toEqual([...ids].sort());
    // 正常波动不会告警
    expect(snap.frame.sensors.filter((s) => s.s === 'ALARM')).toEqual([]);
    expect(Object.keys(e.runtime.state.alerts)).toEqual([]);
    const cooler = snap.frame.sensors.find((s) => s.id === 'T-COOLER-1');
    expect(cooler?.v).toBeGreaterThan(1);
    expect(cooler?.v).toBeLessThan(5);
    expect(snap.series['T-COOLER-1']?.length).toBeGreaterThan(0);

    const tel = await call('POST', '/api/stores/demo/telemetry', { readings: [{ sensor: 'T-COOLER-1', value: 3.4 }, { sensor: 'nope', value: 1 }, { sensor: 'C-ENTRANCE', value: 'x' }] });
    expect(tel.body).toEqual({ accepted: 1, rejected: [{ index: 1, error: 'unknown_sensor' }, { index: 2, error: 'value' }] });

    // 控制台订阅孪生：马上收到一帧；员工手机不订阅就收不到
    const frames: Array<{ t: string }> = [];
    const viewer = await hub.connect('demo', consoleToken, 0, (m) => frames.push(JSON.parse(m) as { t: string }));
    viewer?.receive(JSON.stringify({ t: 'twin', on: true }));
    const phone = ((await call('POST', '/api/stores/demo/session', { associateId: 'A01' })).body as { token: string }).token;
    const phoneFrames: Array<{ t: string }> = [];
    const phoneConn = await hub.connect('demo', phone, 0, (m) => phoneFrames.push(JSON.parse(m) as { t: string }));
    // 连着的手机算在线设备（还没有扫描过）
    expect(e.twin.health(now).devices.online).toBe(1);
    await e.twin.tick(now);
    expect(frames.filter((f) => f.t === 'twin').length).toBe(2);
    expect(phoneFrames.some((f) => f.t === 'twin')).toBe(false);
    viewer?.receive(JSON.stringify({ t: 'twin', on: false }));
    await e.twin.tick(now + 2000);
    expect(frames.filter((f) => f.t === 'twin').length).toBe(2);
    phoneConn?.close();
    expect(e.twin.health(now).devices.online).toBe(0);
    hub.stop();
  });

  it('a cooler fault raises an alarm with its impact; only the lead can acknowledge; repair clears it; replay goes back to before it', async () => {
    const { hub, call, consoleToken, e } = await demoHub();
    let now = Date.now();
    for (let i = 0; i < 3; i++, now += 2000) await e.twin.tick(now);
    const f = await call('POST', '/api/stores/demo/demo/fault', { target: 'COOLER' }, consoleToken);
    expect(f.body).toMatchObject({ ok: true, sensorId: 'T-COOLER-1', faults: ['T-COOLER-1'] });
    for (let i = 0; i < 90 && !Object.keys(e.runtime.state.alerts).length; i++, now += 2000) await e.twin.tick(now);
    const alert = Object.values(e.runtime.state.alerts)[0];
    expect(alert).toMatchObject({ sensorId: 'T-COOLER-1', kind: 'TEMP_HIGH', severity: 'ALARM', status: 'ACTIVE', limit: 5 });
    if (!alert) return;
    // 后仓冷藏库里的箱子受影响
    expect(alert.impact.cases).toBeGreaterThan(0);
    expect(alert.impact.units).toBeGreaterThanOrEqual(alert.impact.cases);
    expect(e.twin.health(now).issues).toContain('ALARMS');

    const picker = ((await call('POST', '/api/stores/demo/session', { associateId: 'A01' })).body as { token: string }).token;
    const lead = ((await call('POST', '/api/stores/demo/session', { associateId: 'A08' })).body as { token: string }).token;
    const no = await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AcknowledgeAlert', alertId: alert.id } }, picker);
    expect((no.body as { reject: { code: string } }).reject.code).toBe('NOT_AUTHORIZED');
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'AcknowledgeAlert', alertId: alert.id } }, lead)).status).toBe(200);
    expect(e.runtime.state.alerts[alert.id]).toMatchObject({ status: 'ACKED', ackBy: 'A08' });
    // 员工和控制台不能自己发出或解除告警
    expect((await call('POST', '/api/stores/demo/commands', { cmd: { type: 'ClearEquipmentAlert', alertId: alert.id } }, consoleToken)).status).toBe(403);

    expect((await call('POST', '/api/stores/demo/demo/fault', { on: false, target: 'ALL' }, consoleToken)).body).toMatchObject({ ok: true, repaired: ['T-COOLER-1'], faults: [] });
    for (let i = 0; i < 150 && e.runtime.state.alerts[alert.id]?.status !== 'CLEARED'; i++, now += 2000) await e.twin.tick(now);
    const cleared = e.runtime.state.alerts[alert.id];
    expect(cleared?.status).toBe('CLEARED');
    expect(cleared?.peak).toBeGreaterThan(5);

    // 回放：告警之前的时刻没有这条告警，但有当时的温度
    const before = (await call('GET', '/api/stores/demo/twin/at', undefined, consoleToken, { t: String(alert.raisedAt - 1) })).body as TwinReplay;
    expect(Object.keys(before.state.alerts ?? {})).toEqual([]);
    expect(before.sensors.find((s) => s.id === 'T-COOLER-1')?.v).toBeLessThan(5);
    expect((await call('GET', '/api/stores/demo/twin/at', undefined, consoleToken, { t: 'x' })).status).toBe(400);
    hub.stop();
  });

  it('forecasts the next hours from the live state; more pickers never make it worse, no pickers leave orders unready', async () => {
    const { hub, call, consoleToken, e } = await demoHub();
    const r = await call('POST', '/api/stores/demo/demo/orders', { type: 'PICKUP', count: 8, release: true, maxLines: 6, slotInMin: 40 }, consoleToken);
    expect(r.status).toBe(200);
    const now = Date.now();
    const s = e.runtime.state;
    const st = e.runtime.statics;
    const base = forecast(s, st, now);
    expect(base.steps).toHaveLength(37);
    expect(base.orders.filter((o) => !o.projected)).toHaveLength(8);
    // 还没有人扫描过：按名单上此刻在班次里的拣货员算（有固定班次的学生不在班次时不算）
    expect(base.basis.staff.PICK).toBe(st.roster.filter((a) => a.role === 'PICK' && onDuty(st, s, a.id, now)).length);
    expect(base.basis.measured.pick).toBe(false);
    const more = forecast(s, st, now, { staffDelta: { PICK: 2, HANDOFF: 1 } });
    expect(more.kpi.late).toBeLessThanOrEqual(base.kpi.late);
    expect(more.kpi.peakBacklogMin).toBeLessThanOrEqual(base.kpi.peakBacklogMin);
    expect(more.kpi.avgWaitMin).toBeLessThanOrEqual(base.kpi.avgWaitMin + 1e-9);
    const none = forecast(s, st, now, { staffDelta: { PICK: -99 }, ordersPerHour: 0 });
    expect(none.kpi.late).toBe(8);
    expect(none.orders.every((o) => o.readyAt === undefined)).toBe(true);
    expect(none.steps[none.steps.length - 1]?.backlogMin).toBeGreaterThan(0);
    // 新订单速度：最近一小时下了 8 单
    expect(base.basis.ordersPerHour).toBe(8);
    expect(base.kpi.projectedOrders).toBe(24);
    hub.stop();
  });
});
