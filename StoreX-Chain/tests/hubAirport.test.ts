import { describe, expect, it } from 'vitest';
import { AIR_YARD, planAirTerminal, standLayout, terminalLayout, type AirTermInput, type AirTermPlan } from '../src/hub/airport';
import { findYardDoor, siteSchedule, checkRoute, yardRoute } from '@storewright/yard';
import { HUB_SLOTS } from '../src/hub/types';
import { g3 } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { setRegion } from '../src/region/network';
import { DEFAULT_REGION } from '../src/region/regionGen';
import { AirportOps } from '../web/src/three/ops/airport';

/** 一天的航班（和机场作业动画排出来的样子差不多）：两个机位轮流，每班先卸后装 */
function dayInput(seed: number, flightsN = 11, own = 3): AirTermInput {
  const L = terminalLayout([2048, 2140], 2250);
  let a = seed * 7 + 3;
  const r = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  const flights: AirTermInput['flights'] = [];
  const arrivals: AirTermInput['arrivals'] = [];
  const departures: AirTermInput['departures'] = [];
  for (let k = 0; k < flightsN; k++) {
    const isOwn = k === own;
    const tOn = -3 * 3600 + k * 2.6 * 3600;
    const stand = k % 2;
    const id = isOwn ? 'V1' : `B${k}`;
    flights.push({ id, label: id, own: isOwn, tOn, tOff: tOn + 3 * 3600, stand, land: tOn - 600 });
    const nIn = 18 + Math.floor(r() * 8);
    for (let i = 0; i < nIn; i++) arrivals.push({ id: `PMC ${30000 + k * 100 + i}`, flight: id, own: isOwn && i >= 3 && i < 5, lane: stand, t: tOn + 600 + i * 175 + Math.floor(i / 4) * 120 });
    const nOut = isOwn ? 10 : 12 + Math.floor(r() * 8);
    for (let i = 0; i < nOut; i++) departures.push({ id: `PMC ${50000 + k * 100 + i}`, flight: id, lane: stand, t: tOn + 600 + nIn * 175 + 600 + i * 175 + Math.floor(i / 4) * 200 });
  }
  const ownTr = flights.find((f) => f.own) as AirTermInput['flights'][number];
  return {
    seed,
    traffic: 1,
    layout: L,
    flights,
    arrivals,
    departures,
    ownTrucks: [{ id: 'AT-1', label: '空运冷藏车 · 12 托', vid: 99, t0: ownTr.land + 2.5 * 3600, t1: ownTr.land + 2.85 * 3600, pallets: 12 }],
    crew: (t) => {
      const h = (((t / 3600) % 24) + 24) % 24;
      return h >= 22 || h < 6 ? 12 : 10;
    },
  };
}

const overlaps = (list: readonly { t0: number; t1: number }[], gap = 0) => {
  const s = [...list].sort((a, b) => a.t0 - b.t0);
  for (let i = 1; i < s.length; i++) if ((s[i] as { t0: number }).t0 < (s[i - 1] as { t1: number }).t1 + gap - 1e-6) return true;
  return false;
};

describe('机场货站：进出口的板都经过货站', () => {
  const input = dayInput(1);
  const plan: AirTermPlan = planAirTerminal(input);
  const END = Math.max(...plan.ulds.flatMap((u) => u.spans.map((s) => s.t1)));

  it('进来的板都有去处：拆完、整板装上卡车，或者到最后还在货站里；货也一样', () => {
    for (const u of plan.ulds.filter((x) => x.dir === 'in')) {
      const last = u.spans[u.spans.length - 1];
      expect(last, u.id).toBeDefined();
      const gone = last?.at === 'truck' || (u.mode === 'bd' && u.tJob1 !== undefined && u.spans.some((s) => s.at === 'station'));
      expect(gone || last?.t1 === END, `${u.id} 不见了`).toBe(true);
    }
    for (const p of plan.pallets) {
      const last = p.spans[p.spans.length - 1];
      if (!last) continue;
      // 出口的货组进板里（在工位上的最后一段长度为 0）；进口的货装上车，或者还在货位、暂存道上
      const ok = last.at === 'truck' || last.t1 === END || (p.dir === 'out' && last.at === 'station' && last.t1 === last.t0);
      expect(ok, `${p.id} 停在 ${last.at}`).toBe(true);
    }
    // 拆板拆出来的货一板不少
    const bd = plan.ulds.filter((u) => u.dir === 'in' && u.mode === 'bd' && u.tJob1 !== undefined && u.tJob1 < END - 3600);
    for (const u of bd) for (const pi of u.pallets) expect(plan.pallets[pi]?.spans.some((s) => s.at === 'loc'), `${u.id} 的货没进库`).toBe(true);
  });

  it('一个收货口一次一辆车（前后留 5 分钟）、一个板位一块板、ETV / 工位 / 叉车 / X 光机一次一件事', () => {
    plan.layout.docks.forEach((_, d) => {
      const vs = plan.trucks.filter((tr) => tr.dock === d);
      expect(overlaps(vs, d === plan.layout.simDock ? 0 : 299), `${d} 号门`).toBe(false);
    });
    const slotUse = new Map<number, { t0: number; t1: number }[]>();
    for (const u of plan.ulds) for (const s of u.spans) if (s.at === 'slot') slotUse.set(s.ref, [...(slotUse.get(s.ref) ?? []), { t0: s.t0, t1: s.t1 }]);
    for (const [slot, list] of slotUse) expect(overlaps(list), `板位 ${slot}`).toBe(false);
    plan.layout.cranes.forEach((_, k) => expect(overlaps(plan.moves.filter((m) => m.crane === k)), `ETV ${k}`).toBe(false));
    plan.layout.stations.forEach((_, k) => expect(overlaps(plan.jobs.filter((j) => j.station === k)), `工位 ${k}`).toBe(false));
    plan.layout.forkHome.forEach((_, k) => expect(overlaps(plan.forks.filter((f) => f.fork === k)), `叉车 ${k}`).toBe(false));
    plan.layout.xray.forEach((_, k) => expect(overlaps(plan.xrays.filter((x) => x.machine === k)), `X 光机 ${k}`).toBe(false));
    // 本店冷藏车的门只给本店的车
    expect(plan.trucks.filter((tr) => tr.dock === plan.layout.simDock).every((tr) => tr.own)).toBe(true);
  });

  it('出口的货组板前都过了安检；出口板按时从板车门出去', () => {
    for (const p of plan.pallets.filter((x) => x.dir === 'out' && x.spans.some((s) => s.at === 'station'))) {
      const scanned = p.spans.findIndex((s) => s.at === 'xray' && s.ref % 1000 === 1);
      const built = p.spans.findIndex((s) => s.at === 'station');
      expect(scanned >= 0 && scanned < built, `${p.id} 没过安检就组板`).toBe(true);
    }
    const out = plan.ulds.filter((u) => u.dir === 'out' && u.tDue !== undefined && u.tDue > 0 && u.tDue < 86400);
    const onTime = out.filter((u) => u.tOut !== undefined && Math.abs(u.tOut - (u.tDue as number)) < 1);
    expect(onTime.length / out.length).toBeGreaterThan(0.95);
  });

  it('冷链货在常温区不超过 20 分钟；本店的板优先拆、按时装上本店的冷藏车', () => {
    for (const p of plan.pallets.filter((x) => x.dir === 'in' && (x.cls === 'chill' || x.cls === 'frozen'))) {
      const st = p.spans.find((s) => s.at === 'station');
      const loc = p.spans.find((s) => s.at === 'loc');
      if (st && loc) expect((loc.t0 - st.t0) / 60, p.id).toBeLessThan(20);
    }
    const own = plan.pallets.filter((p) => p.own);
    const tr = plan.trucks.find((x) => x.own);
    expect(own.length).toBe(12);
    expect(tr?.pallets.length).toBe(12);
    for (const p of own) {
      const load = p.spans.find((s) => s.at === 'truck');
      expect(load && tr && load.t0 >= tr.t0 && load.t0 <= tr.t1, `${p.id} 没在 AT-1 的时段装车`).toBe(true);
    }
  });

  it('HubDay：区、占用、指标齐全，同样的输入排出来一样', () => {
    const hub = plan.hub;
    expect(hub.key).toBe('airport');
    const keys = new Set(hub.zones.map((z) => z.key));
    for (const f of hub.flows) for (const s of f.steps) expect(keys.has(s.zone), s.zone).toBe(true);
    for (const z of hub.zones) expect(hub.occupancy[z.key]?.length).toBe(HUB_SLOTS);
    for (const k of ['imp_dwell_avg', 'bd_backlog_peak', 'etv_peak', 'chill_peak', 'truck_wait_avg', 'export_ontime', 'own_to_cold', 'cold_exposure_max']) expect(hub.kpi.some((x) => x.key === k), k).toBe(true);
    expect(hub.flows.some((f) => f.own && f.unit === 'ULD')).toBe(true);
    const again = planAirTerminal(dayInput(1));
    expect(JSON.stringify(again.hub.kpi)).toBe(JSON.stringify(hub.kpi));
    expect(again.trucks.map((x) => x.t0)).toEqual(plan.trucks.map((x) => x.t0));
  });

  it('负荷高了：待拆板、排队变多，但出口板还是赶上飞机（加班组）', () => {
    const busy = planAirTerminal({ ...dayInput(2, 14), crew: () => 6 });
    const kp = (p: AirTermPlan, k: string) => p.hub.kpi.find((x) => x.key === k)?.value ?? 0;
    expect(kp(busy, 'bd_backlog_peak')).toBeGreaterThan(kp(plan, 'bd_backlog_peak'));
    const out = busy.ulds.filter((u) => u.dir === 'out' && u.tDue !== undefined && u.tDue > 0 && u.tDue < 86400);
    expect(out.filter((u) => u.tOut !== undefined && u.tOut - (u.tDue as number) < 60).length / out.length).toBeGreaterThan(0.9);
  });
});

describe('机场作业动画和货站计划接在一起（仿真的一天）', () => {
  it('本店的板、本店的空运冷藏车都在货站计划里；外来车的收货口有效，不占本店的门', () => {
    setRegion(DEFAULT_REGION);
    const s = g3(1);
    s.traceDay = 86;
    const trace = runChain(s).trace;
    expect(trace).toBeDefined();
    const list = trace?.vehicles ?? [];
    const planes = list.filter((v) => v.kind === 'plane').map((v) => ({ vid: v.id, v }));
    const trucks = list.filter((v) => v.segs.some((sg) => sg.act === '在机场货站装车')).map((v) => ({ vid: v.id, v }));
    const air = new AirportOps();
    air.setDay(planes, 1, 1, trucks);
    const hub = air.hub();
    expect(hub).toBeDefined();
    const own = hub?.flows.filter((f) => f.own) ?? [];
    expect(own.some((f) => f.unit === 'ULD')).toBe(true);
    for (const { v } of trucks) expect(own.some((f) => f.unit === '车' && f.label === v.label), v.label).toBe(true);
    const { docks, visits } = air.dockVisits();
    expect(visits.length).toBeGreaterThan(60);
    for (const vs of visits) {
      expect(docks[vs.dock]).toBeDefined();
      expect(Math.abs((docks[vs.dock] as { x: number }).x - 2038) < 0.01, '外来车靠了本店冷藏车的门').toBe(false);
      expect(vs.t1).toBeGreaterThan(vs.t0);
    }
    // 陆侧卡车场：道路网、货站用同一份布局；本店的冷藏车在场内时刻表里，每樘门都能倒进去，场里的车不互相挡
    const sl = standLayout(2);
    expect(docks.map((d) => d.x)).toEqual(terminalLayout(sl.docks, sl.x1).docks.map((d) => d.x));
    const hit = findYardDoor('AIR');
    expect(hit?.site.key).toBe(AIR_YARD);
    expect(Math.abs((hit?.site.plan.doors[hit.door.index]?.x ?? 0) - (sl.x1 - 2038))).toBeLessThan(0.01);
    const sched = siteSchedule(AIR_YARD);
    expect(sched?.timelines.filter((tl) => tl.visit.own).length).toBe(trucks.length);
    expect(sched?.timelines.length).toBe(visits.length + trucks.length);
    const plan = hit?.site.plan;
    if (plan) for (let d = 0; d < plan.doors.length; d++) for (const v of plan.doors[d]?.kinds ?? []) {
      if (v === 'chassis' || v === 'shunter') continue;
      expect(checkRoute(plan, yardRoute(plan, d, v)).ok, `${plan.doors[d]?.id} ${v}`).toBe(true);
    }
    // 本店的板在面板里能看到货站里的步骤
    const info = air.info(6 * 3600, new Map(), new Map());
    expect(info.ulds.some((u) => u.steps.some((x) => /ETV|拆板/.test(x.text)))).toBe(true);
    expect(info.terminal.term?.etv.slots).toBeGreaterThan(100);
  });
});
