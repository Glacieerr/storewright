import { describe, expect, it } from 'vitest';
import { clearSimVisits, clearYardSites, defineYardSite, planYard, siteSchedule, toWorld, yardSummaries, type YardSite } from '@storewright/yard';
import { scenarioFor, withLoad } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { TRACE_DAY } from '../src/analysis/studies';
import { setRegion } from '../src/region/network';
import { DEFAULT_REGION } from '../src/region/regionGen';
import type { WVehicle } from '../src/sim/trace';
import { BUILDS, type PartSpec } from '../web/src/three/fleet';
import { v3 } from '../web/src/three/geo';
import { buildMotion, DYN, legAt, leadState, makeTrack, partPose, trackInto, type LeadState, type MLeg, type Motion, type PartPose, type XYZ } from '../web/src/three/motion';
import { RoadNet } from '../web/src/three/roadnet';
import { layoutCity } from '../web/src/three/cityplan';

/**
 * 运动规划里的铰接运动学和收货场衔接（web/src/three/motion.ts）：
 * - 前进转弯时挂车切内侧、出弯摆正；倒车时挂车车轴沿路径、牵引销在车轴前一个轴距、牵引车起步从摆直平滑过渡；
 * - 一天的仿真车开进登记了的收货场：道路段在仿真的到达时刻把车头送到进场点、在仿真的离开时刻从驶出点出发，
 *   场内按场地排程走，衔接处不跳、每秒的位移合理、道路段的结束时刻和仿真一样。
 */
const semi = BUILDS.plainDry;
const pose = (): PartPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
const dirOf = (yaw: number) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

/** 零件的前锚点（牵引销 / 前轴）和后锚点（挂车车轴 / 牵引销） */
function anchors(pp: PartPose, p: PartSpec): { f: { x: number; z: number }; r: { x: number; z: number } } {
  const d = dirOf(pp.yaw);
  const f = { x: pp.x + d.x * p.ax, z: pp.z + d.z * p.ax };
  return { f, r: { x: f.x - d.x * (p.ra - p.fa), z: f.z - d.z * (p.ra - p.fa) } };
}

function forwardLeg(pts: Array<[number, number]>): MLeg {
  const track = makeTrack(pts.map(([x, z]) => v3(x, 0, z)));
  return { t0: 0, t1: 100, track, tu: [0, 100], tuS: [0, track.len], u: 0, rev: false };
}

describe('道路上的铰接运动学', () => {
  it('前进转弯：挂车车轴切内侧（不在路径上），出弯后摆正', () => {
    // 先直行 60 米，再转 90°（半径 15 米），再直行 80 米
    const pts: Array<[number, number]> = [[0, 0], [60, 0]];
    for (let k = 1; k <= 30; k++) {
      const a = (k / 30) * (Math.PI / 2);
      pts.push([60 + 15 * Math.sin(a), 15 - 15 * Math.cos(a)]);
    }
    pts.push([75, 95]);
    const leg = forwardLeg(pts);
    const trailer = semi.parts[1] as PartSpec;
    const center = { x: 60, z: 15 };
    let minR = Infinity;
    let maxOff = 0;
    for (let u = 70; u <= 95; u += 0.5) {
      const pp = partPose(leg, u, semi.L, trailer, 1, pose());
      const { f, r } = anchors(pp, trailer);
      // 牵引销在路径上
      const K: XYZ = { x: 0, y: 0, z: 0 };
      trackInto(leg.track, u - trailer.fa, K);
      expect(Math.hypot(f.x - K.x, f.z - K.z)).toBeLessThan(0.05);
      if (r.x > 60 && r.z < 15) minR = Math.min(minR, Math.hypot(r.x - center.x, r.z - center.z));
      // 车轴离路径（偏到弯里）
      let off = Infinity;
      for (let s = 0; s <= leg.track.len; s += 0.25) {
        const q: XYZ = { x: 0, y: 0, z: 0 };
        trackInto(leg.track, s, q);
        off = Math.min(off, Math.hypot(q.x - r.x, q.z - r.z));
      }
      maxOff = Math.max(maxOff, off);
    }
    expect(minR).toBeLessThan(15 - 1.5);
    expect(maxOff).toBeGreaterThan(1);
    // 出弯 70 米以后挂车和路径方向一致
    const end = partPose(leg, leg.track.len, semi.L, trailer, 1, pose());
    expect(Math.abs(end.yaw - Math.atan2(-1, 0))).toBeLessThan(0.02);
  });

  it('倒车：挂车车轴在路径上，牵引销在车轴前方一个轴距；牵引车起步时和挂车摆直，倒进弯里以后有铰接角', () => {
    const pts: Array<[number, number]> = [[0, 0], [20, 0]];
    for (let k = 1; k <= 20; k++) {
      const a = (k / 20) * (Math.PI / 2);
      pts.push([20 + 10 * Math.sin(a), 10 - 10 * Math.cos(a)]);
    }
    pts.push([30, 30]);
    const track = makeTrack(pts.map(([x, z]) => v3(x, 0, z)));
    const leg: MLeg = { t0: 0, t1: 60, track, tu: [0, 60], tuS: [semi.L, track.len], u: semi.L, rev: true };
    const tractor = semi.parts[0] as PartSpec;
    const trailer = semi.parts[1] as PartSpec;
    let maxArt = 0;
    for (let u = semi.L; u <= track.len; u += 0.5) {
      const tp = partPose(leg, u, semi.L, trailer, 1, pose());
      const kp = partPose(leg, u, semi.L, tractor, 1, pose());
      const ta = anchors(tp, trailer);
      const A: XYZ = { x: 0, y: 0, z: 0 };
      trackInto(track, u - semi.L + trailer.ra, A);
      expect(Math.hypot(ta.r.x - A.x, ta.r.z - A.z)).toBeLessThan(0.05);
      // 牵引车的后锚点（牵引销）和挂车的前锚点重合
      const ka = anchors(kp, tractor);
      expect(Math.hypot(ka.r.x - ta.f.x, ka.r.z - ta.f.z)).toBeLessThan(0.05);
      let art = kp.yaw - tp.yaw;
      while (art > Math.PI) art -= 2 * Math.PI;
      while (art < -Math.PI) art += 2 * Math.PI;
      if (u === semi.L) expect(Math.abs(art)).toBeLessThan(0.02);
      maxArt = Math.max(maxArt, Math.abs(art));
    }
    expect(maxArt).toBeGreaterThan(0.2);
    expect(maxArt).toBeLessThan((70 * Math.PI) / 180);
  });
});

describe('仿真车开进收货场', () => {
  setRegion(DEFAULT_REGION);
  const s = withLoad(scenarioFor('g3', 1), 'normal');
  s.traceDay = TRACE_DAY;
  const vehicles = (runChain(s) as { trace: { vehicles: WVehicle[] } }).trace.vehicles.filter((v) => !['ship', 'plane', 'train'].includes(v.kind));
  const net = new RoadNet();
  layoutCity(net);
  // 配送中心的车场（DC:yard#k）登记成一个收货场：进场点放在第 0 个车位路径的终点，进场方向和路径最后一段一致
  clearYardSites();
  clearSimVisits();
  const place = net.places.get('DC:yard#0');
  const plan = planYard({ doors: Array.from({ length: 12 }, (_, i) => i * 4.3), x0: -100, x1: 120, depth: 140, side: 'right' });
  const last = place?.path[place.path.length - 1];
  const prev = place?.path[place.path.length - 2];
  const yaw = last && prev ? Math.atan2(last.x - prev.x, last.z - prev.z) : 0;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const origin = last ? { x: last.x - (plan.gateIn.x * c + plan.gateIn.z * sn), z: last.z - (-plan.gateIn.x * sn + plan.gateIn.z * c) } : { x: 0, z: 0 };
  const site: YardSite = defineYardSite({ key: 'test-dc', frame: { origin, yaw }, plan, doors: Array.from({ length: 24 }, (_, k) => ({ id: `DC:yard#${k}`, index: k % 12 })) });
  const motions = vehicles.map((v) => ({ v, m: buildMotion(v, net, { L: v.kind === 'drayage' ? 15.6 : v.kind === 'ev' ? 11 : v.kind === 'van' ? 6 : 16.8, resolve: () => undefined, yard: v.id, lane: 0, dyn: DYN.heavy }) as Motion }));
  const withYard = motions.filter((x) => x.m.yards?.length);

  it('进场点就是地点路径的终点；有车进了这个收货场，排程里每一辆都有时间线', () => {
    const g = toWorld(site.frame, plan.gateIn);
    expect(Math.hypot(g.x - (last?.x ?? 0), g.z - (last?.z ?? 0))).toBeLessThan(1e-6);
    expect(withYard.length).toBeGreaterThan(0);
    const sched = siteSchedule('test-dc');
    const blocks = withYard.flatMap((x) => x.m.yards ?? []);
    expect(sched?.timelines.length).toBe(blocks.length);
  });

  it('道路段的结束时刻和仿真一样；收货场的停靠正好占满仿真的停留时段', () => {
    let mism = 0;
    for (const { v, m } of motions)
      for (const sg of v.segs) {
        if (!sg.route || sg.route.length < 2) continue;
        const leg = m.legs.find((l) => l.tu && Math.abs(l.t0 - sg.t0) < 1e-6 && !l.yb);
        if (!leg?.tu) continue;
        if (Math.abs((leg.tu[leg.tu.length - 1] as number) - sg.t1) > 1e-3) mism++;
      }
    expect(mism).toBe(0);
    for (const { m } of withYard)
      for (const yb of m.yards ?? []) {
        // 按需要换成场内的运动段
        legAt(m, (yb.t0 + yb.t1) / 2);
        const legs = m.legs.filter((l) => l.yb === yb);
        expect(legs.length).toBeGreaterThan(1);
        expect((legs[0] as MLeg).t0).toBeCloseTo(yb.t0, 6);
        expect((legs[legs.length - 1] as MLeg).t1).toBeCloseTo(yb.t1, 6);
        for (const l of legs) expect(l.ys).toBeDefined();
      }
  });

  it('衔接不跳：到达时车头在进场点、离开时车头在驶出点；每秒的位移合理；零件也不跳', () => {
    const gIn = toWorld(site.frame, plan.gateIn);
    const gOut = toWorld(site.frame, plan.gateOut);
    const ls: LeadState = { u: 0, v: 0, a: 0 };
    const nose = (m: Motion, t: number): { x: number; z: number } | undefined => {
      const leg = legAt(m, t);
      if (!leg) return undefined;
      const u = leadState(leg, t, ls).u;
      const q: XYZ = { x: 0, y: 0, z: 0 };
      trackInto(leg.track, leg.rev ? u - m.L : u, q);
      return { x: q.x, z: q.z };
    };
    let handoffs = 0;
    for (const { v, m } of withYard) {
      const build = v.kind === 'drayage' ? BUILDS.drayDay : v.kind === 'ev' ? BUILDS.ev : v.kind === 'van' ? BUILDS.vanOnline : BUILDS.plainDry;
      for (const yb of m.yards ?? []) {
        const a = nose(m, yb.t0 + 0.01);
        const b = nose(m, yb.t1 - 0.01);
        if (!yb.initial) expect(Math.hypot((a?.x ?? 0) - gIn.x, (a?.z ?? 0) - gIn.z), `${v.label} 到达`).toBeLessThan(0.6);
        expect(Math.hypot((b?.x ?? 0) - gOut.x, (b?.z ?? 0) - gOut.z), `${v.label} 离开`).toBeLessThan(0.6);
        // 衔接前后各 3 秒、每 0.25 秒：车头和每个零件都不跳
        for (const t of [yb.t0, yb.t1]) {
          let p0: { x: number; z: number } | undefined;
          let parts0: PartPose[] | undefined;
          for (let tt = t - 3; tt <= t + 3; tt += 0.25) {
            const p = nose(m, tt);
            const leg = legAt(m, tt);
            const parts = leg ? build.parts.map((pt) => partPose(leg, leadState(leg, tt, ls).u, build.L, pt, 1, pose())) : undefined;
            if (p && p0) expect(Math.hypot(p.x - p0.x, p.z - p0.z), `${v.label} ${tt.toFixed(2)}`).toBeLessThan(1.2);
            if (parts && parts0) parts.forEach((q, k) => expect(Math.hypot(q.x - (parts0 as PartPose[])[k]!.x, q.z - (parts0 as PartPose[])[k]!.z), `${v.label} 零件 ${k} ${tt.toFixed(2)}`).toBeLessThan(1.5));
            p0 = p;
            parts0 = parts?.map((q) => ({ ...q }));
          }
          handoffs++;
        }
        // 场内每秒的位移不超过 6 米（场内车速 4.2 米 / 秒）
        let prevP: { x: number; z: number } | undefined;
        for (let tt = yb.t0; tt <= yb.t1; tt += 1) {
          const p = nose(m, tt);
          if (p && prevP) expect(Math.hypot(p.x - prevP.x, p.z - prevP.z), `${v.label} ${tt}`).toBeLessThan(6);
          prevP = p;
        }
      }
    }
    expect(handoffs).toBeGreaterThan(0);
  });

  it('每个场地的调车情况汇总（看板、值班助手读）', () => {
    const sums = yardSummaries();
    const me = sums.find((x) => x.key === 'test-dc');
    expect(me?.visits).toBeGreaterThan(0);
    expect(me?.tight).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(me?.worst)).toBe(true);
    clearYardSites();
    clearSimVisits();
  });
});
