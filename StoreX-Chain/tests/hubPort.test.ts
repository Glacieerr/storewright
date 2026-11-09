import { describe, expect, it } from 'vitest';
import { crossBorder } from '../src/analysis/crossBorder';
import { BONDED_DOORS, CFS_BOX_DOORS, CFS_TRUCK_DOORS, EMPTY_SLOTS, INSPECT_BAYS, MANEUVER, planPortHub, tractorCount, type PortHubPlan } from '../src/hub/port';
import { AREAS, PL, SECTIONS, sectionPlan } from '../src/hub/portLayout';
import { occupancyAt, HUB_SLOT } from '../src/hub/types';
import { checkRoute, dimsOf, poseAt, yardRoute } from '@storewright/yard';
import { PortLogistics } from '../web/src/three/ops/portLogistics';

/**
 * 港口物流中心的作业计划：门不重复占用、拖车的活接得上、货和箱对得上数、查验比例在范围里、本店的箱按仿真的时刻提走；
 * 布置放得下（场地的路线都能倒进门）。收货场引擎排一天要一两秒，所以只排有限几天。
 */
const own = Array.from({ length: 40 }, (_, i) => ({ id: `STXU ${String(400000 + i * 37)}`, discharged: 8 * 3600 + i * 240, ...(i % 2 === 0 ? { pickup: 20 * 3600 + i * 60, dray: `DR-${String(i + 1).padStart(2, '0')}` } : {}), liner: 'VS1' }));
const days: [string, PortHubPlan][] = [
  ['平常', planPortHub({ seed: 86, traffic: 1, gen: 'g3', own })],
  ['高负荷', planPortHub({ seed: 86, traffic: 2.4, gen: 'g1', own })],
];

describe('港口物流中心的作业计划', () => {
  it('同一份输入每次一样', () => {
    const a = planPortHub({ seed: 5, traffic: 1 });
    const b = planPortHub({ seed: 5, traffic: 1 });
    expect(a.docks.map((d) => [d.id, d.door, d.backAt, d.gone])).toEqual(b.docks.map((d) => [d.id, d.door, d.backAt, d.gone]));
    expect(a.day.kpi).toEqual(b.day.kpi);
  });

  it.each(days)('%s：一个门同一时间只有一辆车', (_, p) => {
    for (const [face, doors] of [['cfs-box', CFS_BOX_DOORS], ['cfs-truck', CFS_TRUCK_DOORS], ['bonded', BONDED_DOORS]] as const) {
      const list = p.docks.filter((d) => d.face === face);
      for (const d of list) {
        expect(d.door).toBeLessThan(doors);
        expect(d.gone).toBeGreaterThan(d.backAt);
      }
      // 外面的车按引擎排的「靠稳到开始拉出」，场内拖车按倒车到挂走
      for (const a of list)
        for (const b of list) {
          if (a === b || a.door !== b.door) continue;
          const [a0, a1, b0, b1] = face === 'cfs-box' ? [a.backAt, a.gone, b.backAt, b.gone] : [a.docked, a.pullAt, b.docked, b.pullAt];
          expect(a0 < b1 && b0 < a1, `${face} 门 ${a.door}：${a.id} 和 ${b.id} 重叠`).toBe(false);
        }
    }
  });

  it.each(days)('%s：靠稳以后才开始装卸，装卸完才拉出', (_, p) => {
    for (const d of p.docks) {
      expect(d.start).toBeGreaterThanOrEqual(d.docked - 1);
      expect(d.done).toBeGreaterThan(d.start);
      expect(d.pullAt).toBeGreaterThanOrEqual(d.done - 1);
    }
  });

  it.each(days)('%s：每辆拖车的活一段接一段（不重叠、位置接得上）', (_, p) => {
    const n = tractorCount(_ === '平常' ? 1 : 2.4);
    for (let k = 0; k < n; k++) {
      const legs = p.tractors.filter((l) => l.tractor === k).sort((a, b) => a.t0 - b.t0);
      for (let i = 1; i < legs.length; i++) {
        const a = legs[i - 1] as (typeof legs)[number];
        const b = legs[i] as (typeof legs)[number];
        expect(b.t0).toBeGreaterThanOrEqual(Math.max(a.t1, a.then?.t1 ?? 0) - 1);
        expect(b.from).toBe(a.to);
      }
    }
  });

  it.each(days)('%s：查验台的车位、机检通道同一时间只有一个箱', (_, p) => {
    const scans = [...p.inspections].sort((a, b) => a.scan[0] - b.scan[0]);
    for (let i = 1; i < scans.length; i++) expect((scans[i] as (typeof scans)[number]).scan[0]).toBeGreaterThanOrEqual((scans[i - 1] as (typeof scans)[number]).scan[1] - 1e-6);
    for (const a of p.inspections)
      for (const b of p.inspections) {
        if (a === b || a.bay === undefined || a.bay !== b.bay || !a.open || !b.open) continue;
        expect(a.open[0] < b.open[1] && b.open[0] < a.open[1]).toBe(false);
      }
    for (const i of p.inspections) if (i.bay !== undefined) expect(i.bay).toBeLessThan(INSPECT_BAYS);
  });

  it('查验比例和跨境分析一致、在范围里', () => {
    for (const [gen, seed] of [['g1', 11], ['g3', 12]] as const) {
      const p = planPortHub({ seed, traffic: 1, gen });
      const sea = crossBorder(gen).flows.find((f) => f.mode === 'sea');
      expect(p.rates.open).toBe(sea?.inspection.physical);
      expect(p.rates.scan).toBeGreaterThanOrEqual(p.rates.open);
      const opened = p.inspections.filter((i) => i.open).length;
      expect(opened).toBeLessThanOrEqual(p.inspections.length);
      expect(p.inspections.length).toBeGreaterThan(0);
    }
  });

  it.each(days)('%s：本店的箱都有流程，提箱的时刻和仿真一样，布控的在提箱之前查完', (_, p) => {
    for (const b of own) {
      const f = p.day.flows.find((x) => x.id === b.id);
      expect(f?.own).toBe(true);
      expect(f?.kind).toBe('cargo');
      expect(f?.carrierIn).toBe('VS1');
      const cy = f?.steps.find((s) => s.zone === 'cy');
      expect(cy?.t0).toBe(b.discharged);
      if (b.pickup !== undefined) {
        expect(cy?.t1).toBe(b.pickup);
        expect(f?.carrierOut).toBe(b.dray);
        const ins = p.inspections.find((i) => i.box === b.id);
        if (ins) expect(ins.back).toBeLessThanOrEqual(b.pickup);
      }
    }
  });

  it.each(days)('%s：数量对得上（空箱堆场不超库容、拆完的箱进了空箱堆场、每条流程都标了车或货）', (_, p) => {
    const empty = p.day.occupancy.empty as Float32Array;
    expect(Math.max(...empty)).toBeLessThanOrEqual(EMPTY_SLOTS + 1e-3);
    const devans = p.docks.filter((d) => d.kind === 'devan');
    const fromCfs = p.depot.filter((m) => m.kind === 'from-cfs');
    expect(fromCfs.length).toBe(devans.length);
    const keys = new Set(p.day.zones.map((z) => z.key));
    for (const f of p.day.flows) {
      expect(f.kind === 'vehicle' || f.kind === 'cargo').toBe(true);
      for (const s of f.steps) expect(keys.has(s.zone)).toBe(true);
    }
    for (const k of p.day.kpi) expect(Number.isFinite(k.value)).toBe(true);
    // 门的占用不超过门数
    for (const z of p.day.zones.filter((x) => x.kind === 'dock')) expect(Math.max(...(p.day.occupancy[z.key] as Float32Array))).toBeLessThanOrEqual(z.capacity + 1e-3);
    expect(occupancyAt(p.day, 'cfs', 12 * HUB_SLOT * 12)).toBeGreaterThan(0);
  });

  it('外面的车按引擎的时间线：有排程、靠台时刻不早于到场、门和计划的一样', () => {
    const p = days[0]?.[1] as PortHubPlan;
    const trucks = p.docks.filter((d) => d.face !== 'cfs-box');
    expect(trucks.length).toBeGreaterThan(50);
    for (const d of trucks) {
      expect(d.tl).toBeDefined();
      expect(d.tl?.visit.door).toBe(d.door);
      expect(d.docked).toBeGreaterThan(d.arrive);
      expect(d.gone).toBeGreaterThan(d.pullAt);
      expect(d.gateIn).toBeLessThan(d.arrive);
      expect(d.gateOut).toBeGreaterThan(d.gone);
    }
  });
});

describe('港口物流中心的布置', () => {
  it('场地不重叠、都在地块里，门都能从司机一侧倒进去', () => {
    const plans = SECTIONS.map((s) => ({ s, p: sectionPlan(s.key) })).sort((a, b) => a.p.x0 - b.p.x0);
    for (let i = 1; i < plans.length; i++) expect((plans[i] as (typeof plans)[number]).p.x0).toBeGreaterThanOrEqual((plans[i - 1] as (typeof plans)[number]).p.x1 - 1e-6);
    for (const { s, p } of plans) {
      expect(p.z1 + PL.zWall).toBeLessThanOrEqual(PL.zFence + 0.01);
      expect(p.x0).toBeGreaterThanOrEqual(PL.xWest);
      expect(p.x1).toBeLessThanOrEqual(PL.xEast);
      p.doors.forEach((_, i) => {
        const r = yardRoute(p, i, s.kinds[0] as (typeof s.kinds)[number]);
        expect(r.ok, `${s.key} 门 ${i}`).toBe(true);
        const c = checkRoute(p, r);
        expect(c.maxArtic).toBeLessThan((68 * Math.PI) / 180);
      });
    }
  });

  it('其它区域不和场地重叠', () => {
    const sx0 = Math.min(...SECTIONS.map((s) => sectionPlan(s.key).x0));
    const sx1 = Math.max(...SECTIONS.map((s) => sectionPlan(s.key).x1));
    expect(AREAS.depot.x1).toBeLessThan(AREAS.scan.xIn);
    expect(AREAS.scan.xOut).toBeLessThan(sx0);
    expect(AREAS.hold.x0).toBeGreaterThan(sx1);
    expect(MANEUVER.scan).toBeGreaterThan(80);
  });
});

describe('港口物流中心的三维计划', () => {
  const plan = days[0]?.[1] as PortHubPlan;
  const logi = new PortLogistics();
  logi.setPlan(plan, -2200);
  const gate = { laneIn: [-2135, -2121, -2107], laneOut: [-2093, -2079, -2065], z: 1222, busy: () => false };
  const trips = logi.trips(gate);

  it('场内拖车的位置不跳（每 2 秒最多走 40 米）', () => {
    const p = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
    let worst = 0;
    let bad = 0;
    for (let k = 0; k < logi.tractorCount; k++) {
      let px: number | undefined;
      let pz = 0;
      for (let t = 0; t < 86400; t += 2) {
        logi.tractorAt(k, t, p);
        if (px !== undefined) {
          const d = Math.hypot(p.x - px, p.z - pz);
          worst = Math.max(worst, d);
          if (d > 40) bad++;
        }
        px = p.x;
        pz = p.z;
      }
    }
    expect(bad, `最大一步 ${worst.toFixed(1)} 米`).toBeLessThanOrEqual(2);
  });

  it('外面的车：路上和场地里交接时车头对得上，进闸早于进场地、出闸晚于离开场地', () => {
    const list = trips.filter((x) => x.build !== 0);
    expect(list.length).toBe(plan.docks.filter((d) => d.face !== 'cfs-box').length);
    const byIdx = plan.docks.filter((d) => d.face !== 'cfs-box');
    list.forEach((tr, i) => {
      const d = byIdx[i] as (typeof byIdx)[number];
      const hid = tr.legs.findIndex((l) => l.hidden);
      expect(hid).toBeGreaterThan(0);
      const h = tr.legs[hid] as (typeof tr.legs)[number];
      expect(tr.inAt).toBeLessThan(h.t0);
      expect(tr.t1).toBeGreaterThan(h.t1);
      const before = tr.legs[hid - 1]?.pts;
      const dims = dimsOf(d.reefer ? 'reefer' : 'semi');
      const fr = dims.kind === 'rig' ? dims.front : 4.4;
      const pose = poseAt(d.tl as NonNullable<typeof d.tl>, h.t0 + 0.01)?.units[0]?.pose;
      const end = before?.[before.length - 1];
      expect(pose && end).toBeTruthy();
      if (pose && end) expect(Math.hypot(pose.x + fr * Math.sin(pose.heading) - end.x, pose.z + PL.zWall + fr * Math.cos(pose.heading) - end.z)).toBeLessThan(3.2);
    });
  });

  it('空箱堆场的集卡：车上的箱在正面吊吊箱的时候换，一趟时间接得上', () => {
    const list = trips.filter((x) => x.build === 0);
    expect(list.length).toBeGreaterThan(10);
    for (const tr of list) {
      for (let i = 1; i < tr.legs.length; i++) expect((tr.legs[i] as (typeof tr.legs)[number]).t0).toBeGreaterThanOrEqual((tr.legs[i - 1] as (typeof tr.legs)[number]).t1 - 1e-6);
      expect(tr.legs.some((l) => l.box !== undefined)).toBe(true);
    }
  });
});
