import { beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '../src/assistant';
import { planAppointments } from '../src/assistant/hubs';
import type { AssistCtx, HubYard } from '../src/assistant/types';
import { yardAppointments } from '../src/assistant/yardAppt';
import { tallyOccupancy, type HubDay, type HubFlow, type HubZone } from '../src/hub/types';
import { DEFAULT_REGION } from '../src/region/regionGen';
import { setRegion, STORE } from '../src/region/network';
import { buildBoard } from '../src/sim/board';
import { g3 } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, emptyDay } from '../src/sim/plan';
import type { YardVisit } from '@storewright/yard';
import { registerPlaces } from '../web/src/three/places';
import { RoadNet } from '../web/src/three/roadnet';

/**
 * 预约错峰用场地排程器（@storewright/yard）算挪之前、挪之后：门店收货场的真实场地布置（和网页、孪生服务同一份），
 * 加上一批挤在一起到的货车（10 辆车 40 分钟内到、4 个收货口、每辆卸 40 分钟）。
 */
const H = 3600;
const N = 10;
let yard: HubYard;
let day: HubDay;
let ctx: AssistCtx;

beforeAll(() => {
  setRegion(DEFAULT_REGION);
  const site = registerPlaces(new RoadNet()).get(STORE.key);
  if (!site?.yard) throw new Error('门店收货场没排出来');
  const arrive = (i: number) => 8 * H + i * 240;
  const cold = (i: number) => i % 4 === 1;
  const visits: YardVisit[] = Array.from({ length: N }, (_, i) => ({ id: `v${i}`, vehicle: cold(i) ? 'reefer' : 'semi', door: i % 4, arrive: arrive(i), dockAt: arrive(i) + 300, leaveAt: arrive(i) + 300 + 40 * 60, mode: 'live', own: true }));
  yard = { plan: site.yard.plan, visits, visitOf: (id) => (/^T\d+$/.test(id) ? `v${id.slice(1)}` : undefined) };
  const zones: HubZone[] = [
    { key: 'queue', label: '收货场待命车位', kind: 'queue', capacity: 4, unit: '车' },
    { key: 'docks', label: '收货口', kind: 'dock', capacity: 4, unit: '樘' },
  ];
  const flows: HubFlow[] = visits.map((v, i) => ({ id: `T${i}`, label: `${cold(i) ? '冷藏车' : '货车'} ${i + 1}`, own: true, units: 1, unit: '车', kind: 'vehicle', cold: cold(i), steps: [{ zone: 'queue', t0: v.arrive, t1: v.arrive + 60, act: '排队' }, { zone: 'docks', t0: v.arrive + 60, t1: v.leaveAt, act: '卸货' }] }));
  day = { key: 'store', label: '综合店停车场与收货场', zones, flows, occupancy: tallyOccupancy(zones, flows), kpi: [], notes: [] };
  const s = g3(1);
  s.traceDay = 86;
  const trace = runChain(s).trace;
  if (!trace) throw new Error('仿真没有记录这一天');
  const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
  ctx = { t: 6 * H, board, rows: [], hubs: () => [day] };
});

const tool = (c: AssistCtx) => {
  const t = TOOLS.find((x) => x.name === 'plan_appointments');
  if (!t) throw new Error('没有 plan_appointments');
  return t.run(c, { hub: 'store' }, { vehicles: [], cards: [] } as unknown as Parameters<typeof t.run>[2]);
};

describe('预约错峰 · 场地排程器', () => {
  it('排队模型挑的车交给场地排程器验证：只留下排出来更好的，挪之后不比挪之前差，冷链车等待不超限', () => {
    const p = planAppointments(day, ctx.t);
    expect(p?.moves.length).toBeGreaterThan(0);
    const ya = yardAppointments(yard, p as NonNullable<typeof p>, ctx.t);
    expect(ya).toBeDefined();
    const y = ya as NonNullable<typeof ya>;
    expect(y.trucks).toBe(N);
    expect(y.before.peak).toBeGreaterThan(0);
    expect(y.after.peak).toBeLessThanOrEqual(y.before.peak);
    expect(y.after.waitMin).toBeLessThanOrEqual(y.before.waitMin + 1e-9);
    for (const m of y.moves) expect(p?.moves).toContainEqual(m);
    expect(y.dropped).toBe((p?.moves.length ?? 0) - y.moves.length);
    expect(y.after.coldMaxMin).toBeLessThanOrEqual(Math.max(30, y.before.coldMaxMin) + 1e-9);
    // 同一组输入排两遍一样
    expect(yardAppointments(yard, p as NonNullable<typeof p>, ctx.t)).toEqual(ya);
  });

  it('有场地布置时回答写明数是场地排程器排的，没有时写明是排队模型估的', () => {
    const real = tool({ ...ctx, yards: () => ({ store: yard }) });
    expect(real.data.model).toBe('yard');
    expect(real.text).toContain('场地排程器排出来的');
    expect(real.cite).toContain('场地排程器');
    for (const pr of real.proposals ?? []) expect(pr.effect).toContain('场地排程器');
    const approx = tool(ctx);
    expect(approx.data.model).toBe('queue');
    expect(approx.text).toContain('排队模型估的');
    expect(approx.text).not.toContain('场地排程器');
  });
});
