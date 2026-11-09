import { afterAll, describe, expect, it } from 'vitest';
import { setRegion } from '../src/region/network';
import { DEFAULT_REGION, regionSpecFrom, type RegionSpec } from '../src/region/regionGen';
import { RoadNet } from '../web/src/three/roadnet';
import { registerPlaces } from '../web/src/three/places';
import { planLots, type Lot } from '../web/src/three/parking';
import { layoutCity } from '../web/src/three/cityplan';
import { PortOps } from '../web/src/three/ops/port';
import { AirportOps } from '../web/src/three/ops/airport';
import { ExtTrucks } from '../web/src/three/ops/extTrucks';
import { FRAMES } from '../src/region/region';
import { toWorld } from '../src/region/frames';

/** 三维的道路网和停车场（和 world.ts 一样的顺序，见 cityplan.ts：停车场、小街、小区停车场在路口收尾之前摆） */
function netOf(spec: RegionSpec, full = true): { net: RoadNet; lots: Lot[] } {
  setRegion(spec);
  const net = new RoadNet();
  if (full) return { net, lots: layoutCity(net).lots };
  const sites = registerPlaces(net);
  const lots = planLots(net, sites);
  return { net, lots };
}
const center = (o: { x: number; z: number }[]) => ({ x: o.reduce((s, p) => s + p.x, 0) / o.length, z: o.reduce((s, p) => s + p.z, 0) / o.length });

describe('港口、机场的外来货车', () => {
  afterAll(() => setRegion(DEFAULT_REGION));

  it('每辆车都从高速口外的远处或者等候区里出来、开回那里去，路上不会一跳一跳', () => {
    for (const spec of [DEFAULT_REGION, regionSpecFrom('random-3')]) {
      const { net, lots } = netOf(spec);
      const port = new PortOps();
      const air = new AirportOps();
      port.setDay({ seed: 1, drays: [], traffic: 1, passing: [] });
      air.setDay([], 1, 1);
      const ext = new ExtTrucks(net);
      ext.setDay(port.gateTrips(), air.dockVisits(), 1);
      expect(ext.stats.port).toBeGreaterThan(100);
      expect(ext.stats.air).toBeGreaterThan(20);
      expect(ext.stats.portLot).toBeGreaterThan(10);
      // 出现、消失的地方：高速延长段的远端（离它 400 米内）或者货车等候区里
      const far = (['NORTH', 'EAST'] as const).flatMap((k) => {
        const pl = net.places.get(k);
        return [pl?.offIn?.[0], pl?.offOut?.[(pl?.offOut?.length ?? 1) - 1]].filter((p): p is NonNullable<typeof p> => !!p);
      });
      const holds = lots.filter((l) => l.use === 'hold').map((l) => center(l.outline));
      const ok = (p: { x: number; z: number }) => far.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 400) || holds.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 70);
      const trucks = (ext as unknown as { trucks: { t0: number; t1: number }[] }).trucks;
      let jump = 0;
      for (let i = 0; i < ext.count; i++) {
        const { t0, t1 } = trucks[i] as { t0: number; t1: number };
        const a = ext.poseAt(i, t0 + 0.01);
        const b = ext.poseAt(i, Math.min(t1, 86399) - 0.01);
        if (a && t0 > 1) expect(ok(a), `第 ${i} 辆车在路上出现`).toBe(true);
        if (b && t1 < 86340) expect(ok(b), `第 ${i} 辆车在路上消失`).toBe(true);
        // 每 5 秒取一次车头：最快的是港口里的场内段（约 8 米 / 秒），路上不到 4 米 / 秒
        let prev: { x: number; z: number } | undefined;
        for (let t = Math.ceil(t0); t <= Math.min(t1, 86399); t += 5) {
          const p = ext.poseAt(i, t);
          if (p && prev) jump = Math.max(jump, Math.hypot(p.x - prev.x, p.z - prev.z) / 5);
          prev = p;
        }
      }
      expect(jump).toBeLessThan(9);
    }
  });

  it('机场货站：放进场以前一分钟才开到进场点外排队，等着的车不叠在一起；场里的时刻表从放进场的那一刻开始', () => {
    const { net } = netOf(DEFAULT_REGION);
    const port = new PortOps();
    const air = new AirportOps();
    port.setDay({ seed: 1, drays: [], traffic: 1, passing: [] });
    // 极限负荷：收货口更忙，引擎让车在场外等的更多
    air.setDay([], 1, 2.5);
    const ext = new ExtTrucks(net);
    ext.setDay(port.gateTrips(), air.dockVisits(), 1);
    type YLeg = { t0: number; t1: number; yard?: { tl: { joinAt: number; visit: { arrive: number } } } };
    const trucks = (ext as unknown as { trucks: { t0: number; t1: number; legs: YLeg[] }[] }).trucks;
    const waits: { i: number; a: number; j: number }[] = [];
    trucks.forEach((tk, i) => {
      const y = tk.legs.find((l) => l.yard);
      if (!y?.yard) return;
      const J = Math.max(y.yard.tl.visit.arrive, y.yard.tl.joinAt);
      expect(y.t0, `第 ${i} 辆车的场内时刻表`).toBeCloseTo(J, 6);
      waits.push({ i, a: J - 60, j: J });
    });
    expect(waits.length).toBeGreaterThan(20);
    // 两辆车同时在排队等（各自放进场前的一分钟）：车头不在 6.5 米以内（最短的面包车加 1.5 米的空当；以前叠在进场点上是 0 米）
    let closest = Infinity;
    for (const w of waits)
      for (let t = Math.ceil(w.a); t < w.j; t += 1) {
        const p = ext.poseAt(w.i, t);
        if (!p) continue;
        for (const o of waits) {
          if (o.i === w.i || t < o.a || t > o.j) continue;
          const q = ext.poseAt(o.i, t);
          if (q) closest = Math.min(closest, Math.hypot(p.x - q.x, p.z - q.z));
        }
      }
    expect(closest).toBeGreaterThan(6.5);
  });

  it('机场进场路尽头的回车场：进来的车走外圈、出去的车走里圈，两边的车不碰在一起（每 2 秒查一次车头）', () => {
    const { net } = netOf(DEFAULT_REGION);
    const port = new PortOps();
    const air = new AirportOps();
    port.setDay({ seed: 1, drays: [], traffic: 1, passing: [] });
    air.setDay([], 1, 2.5);
    const ext = new ExtTrucks(net);
    ext.setDay(port.gateTrips(), air.dockVisits(), 1);
    type L = { t0: number; t1: number; yard?: unknown };
    const trucks = (ext as unknown as { trucks: { t0: number; t1: number; legs: L[] }[] }).trucks;
    // 回车场的圆心（机场局部坐标 1950, 1088）换成世界坐标
    const f = FRAMES.airport;
    const c = toWorld(f, { x: 1950, z: 1088 });
    const air0 = trucks.map((tk, i) => ({ i, tk, y: tk.legs.find((l) => l.yard) })).filter((x) => x.y);
    expect(air0.length).toBeGreaterThan(20);
    let close = 0;
    let seen = 0;
    for (let t = 0; t < 86400; t += 2) {
      const ins: { x: number; z: number }[] = [];
      const outs: { x: number; z: number }[] = [];
      for (const { i, tk, y } of air0) {
        if (t < tk.t0 || t > tk.t1 || !y) continue;
        const p = ext.poseAt(i, t);
        if (!p || Math.hypot(p.x - c.x, p.z - c.z) > 30) continue;
        (t < y.t0 ? ins : outs).push(p);
      }
      if (ins.length && outs.length) seen++;
      for (const a of ins) for (const b of outs) if (Math.hypot(a.x - b.x, a.z - b.z) < 3.2) close++;
    }
    // 进来、出去的车同时在回车场里的时刻不少，但车头从不在 3.2 米以内（相邻车道 3.7 米、两个圈隔 5 米；以前同走一个圈、出去的车从排队的车中间穿过去）
    expect(seen).toBeGreaterThan(10);
    expect(close).toBe(0);
  });

  it('港口、机场的员工停车场和货车等候区：默认区域和 40 个随机区域都摆得下', () => {
    const miss: string[] = [];
    for (const spec of [DEFAULT_REGION, ...Array.from({ length: 40 }, (_, i) => ({ mode: 'random' as const, seed: i + 1 }))]) {
      const { lots } = netOf(spec, false);
      for (const id of ['PORT:staff', 'PORT:hold', 'AIR:staff', 'AIR:hold', 'DC:staff']) if (!lots.some((l) => l.id === id)) miss.push(`${spec.mode}-${spec.seed ?? ''}:${id}`);
    }
    expect(miss).toEqual([]);
  });
});
