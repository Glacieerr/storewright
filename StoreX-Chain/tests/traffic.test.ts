import { afterAll, describe, expect, it } from 'vitest';
import { setRegion } from '../src/region/network';
import { DEFAULT_REGION, regionSpecFrom, type RegionSpec } from '../src/region/regionGen';
import type { Bay } from '../web/src/three/parking';
import type { RoadNet } from '../web/src/three/roadnet';
import { buildCity } from '../web/src/three/regionCity';
import { planPeds } from '../web/src/three/peds';
import { CAR_LEN, CAR_W, Traffic, TrafficPlanner, trafficTransfer, type CarTrack, type TrafficPose } from '../web/src/three/traffic';
import { buildMotion, DYN, leadState, roadRuns, trackAt } from '../web/src/three/motion';
import { runChain } from '../src/sim/engine';
import { g3 } from '../src/sim/config';
import { TRACE_DAY } from '../src/analysis/studies';

/**
 * 背景车流的回归测试：在 Node 里按网页的顺序搭好道路网和停车场，算一整天，再按画出来的样子（车尾在路径上、车身朝向车头）检查：
 * 同一条车道上的车不叠在一起、整体重叠很少、画出来的位置不跳、不闯红灯、路上不长时间堵死、出行都从车位或高速口开始和结束、
 * 公交车在港湾里停靠、在首末站发车和过夜；行人过斑马线的时候斑马线上没有车；下雨的时段车开得慢；
 * 住户的车早出晚归、回到小区的车位；停车场离场口近的车位先停满；背景车让仿真车（红灯前停着的货车身上不叠车、后面的车排在它后面）；
 * 小街路边的车位有进有出；停车场里约一成半的车开过车位再倒进去，路边车位进出不蹭旁边停着的车。
 */
type V = { x: number; z: number };
/** 车长、车宽（小汽车、大一点的乘用车、公交、平头厢式货车、半挂车） */
const LEN = CAR_LEN;
const WID = CAR_W;

interface Built {
  tag: string;
  net: RoadNet;
  tr: TrafficPlanner;
}
function build(spec: RegionSpec, tag: string): Built {
  const { net } = buildCity(spec);
  const tr = new TrafficPlanner(net);
  tr.simulate(9000);
  return { tag, net, tr };
}

/** 画出来的车身（车尾 + 朝向，按真实车长车宽各缩 0.2 米，只算真叠上的） */
function body(tr: Traffic, c: CarTrack, t: number, tp: TrafficPose) {
  const L = LEN[c.kind] as number;
  if (!tr.pose(c, t, tp, L) || tp.parked) return undefined;
  const dx = Math.cos(tp.yaw);
  const dz = -Math.sin(tp.yaw);
  return { cx: tp.x + (dx * L) / 2, cz: tp.z + (dz * L) / 2, y: tp.y, dx, dz, hl: L / 2 - 0.2, hw: (WID[c.kind] as number) / 2 - 0.2 };
}
type Body = NonNullable<ReturnType<typeof body>>;
function overlap(a: Body, b: Body): boolean {
  if (Math.abs(a.y - b.y) > 2.5) return false;
  for (const [ux, uz] of [
    [a.dx, a.dz],
    [-a.dz, a.dx],
    [b.dx, b.dz],
    [-b.dz, b.dx],
  ] as const) {
    const ra = a.hl * Math.abs(a.dx * ux + a.dz * uz) + a.hw * Math.abs(-a.dz * ux + a.dx * uz);
    const rb = b.hl * Math.abs(b.dx * ux + b.dz * uz) + b.hw * Math.abs(-b.dz * ux + b.dx * uz);
    if (Math.abs((b.cx - a.cx) * ux + (b.cz - a.cz) * uz) > ra + rb) return false;
  }
  return true;
}
function segAt(c: CarTrack, t: number): number {
  let lo = 0;
  let hi = c.segT0.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if ((c.segT0[m] as number) <= t) lo = m;
    else hi = m - 1;
  }
  return lo;
}

describe('背景车流（跟车、让行、停车场、公交）', () => {
  afterAll(() => setRegion(DEFAULT_REGION));
  const regions: Built[] = [build(DEFAULT_REGION, 'default'), build(regionSpecFrom('random-3'), 'random-3'), build(regionSpecFrom('random-11'), 'random-11')];

  it('同一条车道上的车先来后到、不叠在一起；整体重叠很少（按画出来的车身每 15 秒查一次）', () => {
    for (const { tag, tr } of regions) {
      const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
      const pairs = new Set<string>();
      const same = new Set<string>();
      for (let t = 6 * 3600; t < 22 * 3600; t += 15) {
        const grid = new Map<string, { ci: number; b: Body; p: number }[]>();
        for (const ci of tr.activeAt(t)) {
          const c = tr.cars[ci] as CarTrack;
          const b = body(tr, c, t, tp);
          if (!b) continue;
          const gx = Math.floor(b.cx / 14);
          const gz = Math.floor(b.cz / 14);
          for (let i = -1; i <= 1; i++)
            for (let j = -1; j <= 1; j++)
              for (const o of grid.get(`${gx + i},${gz + j}`) ?? []) {
                if (!overlap(b, o.b)) continue;
                const key = `${Math.min(ci, o.ci)}-${Math.max(ci, o.ci)}`;
                pairs.add(key);
                if (o.p === (c.segP[segAt(c, t)] as number)) same.add(key);
              }
          const k = `${gx},${gz}`;
          const list = grid.get(k) ?? [];
          list.push({ ci, b, p: c.segP[segAt(c, t)] as number });
          grid.set(k, list);
        }
      }
      // 改之前（只在信号灯前排队）默认区域一天有几千对车叠在一起
      expect(same.size, `${tag} 同一条路径上叠在一起的车`).toBeLessThanOrEqual(12);
      expect(pairs.size, `${tag} 叠在一起的车（对）`).toBeLessThanOrEqual(220);
    }
  });

  it('不闯红灯、轨迹前后接得上、路上不长时间堵死', () => {
    for (const { tag, tr } of regions) {
      const a = tr.audit();
      expect(a.crossings, tag).toBeGreaterThan(10000);
      expect(a.redRuns, `${tag} 闯红灯`).toBe(0);
      expect(a.gaps, `${tag} 轨迹接不上`).toBe(0);
      expect(a.maxRoadStill, `${tag} 路上停得最久（秒）`).toBeLessThan(600);
    }
  });

  it('画出来的位置不跳：车尾沿走过的路量，换路径时也连着', () => {
    for (const { tag, tr } of regions) {
      const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
      let worst = 0;
      for (let ci = 0; ci < tr.cars.length; ci += 7) {
        const c = tr.cars[ci] as CarTrack;
        let px = NaN;
        let pz = NaN;
        for (let t = Math.max(c.t0, 6 * 3600); t < Math.min(c.t1, 22 * 3600); t += 2) {
          if (!tr.pose(c, t, tp, LEN[c.kind] as number)) continue;
          if (Number.isFinite(px)) worst = Math.max(worst, Math.hypot(tp.x - px, tp.z - pz));
          px = tp.x;
          pz = tp.z;
        }
      }
      // 最快的高速 2.8 米 / 秒：两秒最多走 5.6 米，加上转弯时车尾的摆动
      expect(worst, `${tag} 两秒里画出来的位置最多挪了几米`).toBeLessThan(8);
    }
  });

  it('出行从车位或高速口开始、在车位或高速口结束，车流量和以前相当', () => {
    for (const { tag, tr, net } of regions) {
      const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
      const edges = ['MAP_N', 'MAP_E'].map((id) => net.junctions.get(id)?.pos).filter((p): p is NonNullable<typeof p> => !!p);
      const nearEdge = (x: number, z: number) => edges.some((p) => Math.hypot(p.x - x, p.z - z) < 120);
      let bad = 0;
      let n = 0;
      for (const c of tr.cars) {
        if (c.kind === 2) continue;
        n++;
        const first = c.segLot[0] === 1 || (tr.pose(c, c.t0, tp) && nearEdge(tp.x, tp.z));
        const k = c.segT0.length - 1;
        const last = c.segLot[k] === 1 || c.t1 >= 25.9 * 3600 || (tr.pose(c, c.t1, tp) && nearEdge(tp.x, tp.z));
        if (!first || !last) bad++;
      }
      expect(bad, `${tag} 不在车位、高速口开始或结束的出行（共 ${n} 辆车）`).toBe(0);
      expect(tr.stats.trips, `${tag} 一天的出行`).toBeGreaterThan(tag === 'default' ? 6500 : 4000);
    }
  });

  it('公交：3–5 条线路，首末站按时刻表发车、在港湾里停靠，零点和收车后都停在首末站的港湾里（不在路上出现）', () => {
    for (const { tag, tr } of regions) {
      expect(tr.busLines.length, `${tag} 线路数`).toBeGreaterThanOrEqual(3);
      expect(tr.busLines.length, tag).toBeLessThanOrEqual(5);
      expect(tr.busStops.length, tag).toBeGreaterThanOrEqual(tr.busLines.length * 2);
      const a = tr.audit();
      expect(tr.stats.busTrips, `${tag} 首末站发车`).toBeGreaterThan(300);
      expect(a.busDwells, `${tag} 中途站停靠（20 秒以上）`).toBeGreaterThan(300);
      const buses = tr.cars.filter((c) => c.kind === 2);
      expect(buses.length, tag).toBeGreaterThan(10);
      for (const b of buses) {
        expect(b.segLot[0], `${tag} 公交车零点在首末站`).toBe(2);
        expect(b.segT0[0], tag).toBe(0);
      }
      // 收车以后停在首末站（过夜）
      const parked = buses.filter((b) => b.segLot[b.segT0.length - 1] === 2).length;
      expect(parked / buses.length, `${tag} 收车后在首末站过夜的比例`).toBeGreaterThan(0.85);
    }
  });

  it('行人和车不同时占着斑马线（行人过街的时段每秒查一次画出来的车身）', () => {
    for (const { tag, tr, net } of regions) {
      const cws = tr.crosswalks();
      const d = planPeds({ net, traffic: tr, crosswalks: cws, lots: net.lots });
      expect(cws.length, `${tag} 斑马线`).toBeGreaterThan(20);
      expect(d.stats.crossings, `${tag} 一天过斑马线的人次`).toBeGreaterThan(1000);
      expect(d.stats.boardings, `${tag} 一天上公交的人次`).toBeGreaterThan(300);
      const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
      let seen = 0;
      let checked = 0;
      let clash = 0;
      let off = 0;
      for (let i = 0; i < d.off.length; i++) {
        const o = d.off[i] as number;
        for (let k = o; k < o + (d.n[i] as number) - 1; k++) {
          const ci = d.kc[k] as number;
          if (ci < 0 || seen++ % 5) continue;
          checked++;
          const cw = cws[ci] as (typeof cws)[number];
          // 斑马线画在车行道上（路缘到路缘）
          const zone: Body = { cx: cw.cx, cz: cw.cz, y: cw.cy, dx: cw.ux, dz: cw.uz, hl: cw.hl, hw: cw.curb };
          const ta = d.kt[k] as number;
          const tb = d.kt[k + 1] as number;
          for (let t = ta; t <= tb; t += 1) {
            // 行人在斑马线上（沿路方向离中线不超过半条斑马线）
            const f = (t - ta) / Math.max(1e-6, tb - ta);
            const px = (d.kx[k] as number) + ((d.kx[k + 1] as number) - (d.kx[k] as number)) * f;
            const pz = (d.kz[k] as number) + ((d.kz[k + 1] as number) - (d.kz[k] as number)) * f;
            if (Math.abs((px - cw.cx) * cw.ux + (pz - cw.cz) * cw.uz) > cw.hl + 0.01) off++;
            for (const c of tr.activeAt(t)) {
              const b = body(tr, tr.cars[c] as CarTrack, t, tp);
              if (b && overlap(b, zone)) clash++;
            }
          }
        }
      }
      expect(checked, tag).toBeGreaterThan(200);
      expect(off, `${tag} 过街时不在斑马线上`).toBe(0);
      expect(clash, `${tag} 行人过街时斑马线上有车`).toBe(0);
    }
  });

  it('下雨的时段车开得慢（每小时一个速度系数，晴天 1），出行数不变', () => {
    const { tr: clear, net } = regions[0] as Built;
    setRegion(DEFAULT_REGION);
    // 早上 7–10 点大雨（0.6），其余时段晴
    const weather = Array.from({ length: 25 }, (_, h) => (h >= 7 && h < 10 ? 0.6 : 1));
    const wet = new TrafficPlanner(net);
    wet.simulate(9000, undefined, weather);
    // 路上（不算停车场里）走过的距离 ÷ 用的时间，按段开始的小时分开
    const speed = (tr: TrafficPlanner, h0: number, h1: number) => {
      let dist = 0;
      let time = 0;
      for (const c of tr.cars) {
        if (c.kind === 2) continue;
        for (let k = 0; k < c.segT0.length; k++) {
          const t0 = c.segT0[k] as number;
          if ((c.segLot[k] as number) !== 0 || t0 < h0 * 3600 || t0 >= h1 * 3600) continue;
          const dk = (c.segS1[k] as number) - (c.segS0[k] as number);
          if (dk <= 0.01) continue;
          dist += dk;
          time += (c.segT1[k] as number) - t0;
        }
      }
      return dist / Math.max(1, time);
    };
    const morning = speed(wet, 7.5, 9.5) / speed(clear, 7.5, 9.5);
    const afternoon = speed(wet, 13, 16) / speed(clear, 13, 16);
    expect(morning, '下雨的早上比晴天慢').toBeLessThan(0.8);
    expect(afternoon, '雨停以后的下午和晴天差不多').toBeGreaterThan(0.9);
    expect(wet.stats.trips / clear.stats.trips, '出行数').toBeGreaterThan(0.95);
  });

  it('住户的车：夜里停在小区停车场，早上开出去、晚上开回小区的车位（出区域的从高速口回来）', () => {
    for (const { tag, tr, net } of regions) {
      const homes = net.lots.filter((l) => l.use === 'home');
      expect(homes.length, `${tag} 小区停车场`).toBeGreaterThanOrEqual(tag === 'default' ? 12 : 4);
      const bays = homes.flatMap((l) => l.bays.map((b) => b.p));
      const grid = new Map<string, { x: number; z: number }[]>();
      for (const p of bays) {
        const k = `${Math.floor(p.x / 20)},${Math.floor(p.z / 20)}`;
        grid.set(k, [...(grid.get(k) ?? []), p]);
      }
      const atHome = (x: number, z: number) => {
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++) for (const p of grid.get(`${Math.floor(x / 20) + i},${Math.floor(z / 20) + j}`) ?? []) if (Math.hypot(p.x - x, p.z - z) < 0.6) return true;
        return false;
      };
      const edges = ['MAP_N', 'MAP_E'].map((id) => net.junctions.get(id)?.pos).filter((p): p is NonNullable<typeof p> => !!p);
      const nearEdge = (x: number, z: number) => edges.some((p) => Math.hypot(p.x - x, p.z - z) < 120);
      const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
      let leaveAm = 0;
      let leavePm = 0;
      let arriveAm = 0;
      let arrivePm = 0;
      let fromHome = 0;
      let backHome = 0;
      for (const c of tr.cars) {
        if (c.kind === 2) continue;
        const n = c.segT0.length;
        // 停在车位上的段（车头在车位里）：是不是小区的车位
        const parkedAt = (k: number): boolean | undefined => {
          if ((c.segLot[k] as number) !== 1 || Math.abs((c.segS1[k] as number) - (c.segS0[k] as number)) > 0.01 || (c.segT1[k] as number) - (c.segT0[k] as number) < 60) return undefined;
          return tr.pose(c, ((c.segT0[k] as number) + (c.segT1[k] as number)) / 2, tp, 0) ? atHome(tp.x, tp.z) : undefined;
        };
        const first = parkedAt(0);
        let last: boolean | undefined;
        for (let k = 0; k < n; k++) {
          const h = parkedAt(k);
          if (h === undefined) continue;
          last = h;
          const moveAfter = k + 1 < n && Math.abs((c.segS1[k + 1] as number) - (c.segS0[k + 1] as number)) > 0.01;
          const moveBefore = k > 0 && Math.abs((c.segS1[k - 1] as number) - (c.segS0[k - 1] as number)) > 0.01;
          const hourOut = (c.segT1[k] as number) / 3600;
          const hourIn = (c.segT0[k] as number) / 3600;
          if (h && moveAfter) {
            if (hourOut >= 5.5 && hourOut < 10.5) leaveAm++;
            if (hourOut >= 15 && hourOut < 23) leavePm++;
          }
          if (h && moveBefore) {
            if (hourIn >= 5.5 && hourIn < 10.5) arriveAm++;
            if (hourIn >= 15 && hourIn < 23) arrivePm++;
          }
        }
        // 早上从小区出发的车：这一天最后停在小区的车位上，或者开出了区域
        const moved = c.segT0.length > 1 && first === true;
        if (!moved) continue;
        fromHome++;
        const endOut = !!tr.pose(c, c.t1, tp) && nearEdge(tp.x, tp.z) && c.t1 < 25.9 * 3600;
        if (last === true || endOut) backHome++;
      }
      expect(fromHome, `${tag} 从小区出门的车`).toBeGreaterThan(tag === 'default' ? 150 : 40);
      expect(backHome / fromHome, `${tag} 回到小区车位（或开出区域）的比例`).toBeGreaterThan(0.95);
      expect(leaveAm, `${tag} 早上出门的比晚上多`).toBeGreaterThan(leavePm * 2);
      expect(arrivePm, `${tag} 晚上回来的比早上多`).toBeGreaterThan(arriveAm * 2);
    }
  });

  it('停车场离场口近的车位先停满（白天各车位停着车的时间：近的三分之一比远的三分之一长）', () => {
    for (const { tag, tr, net } of regions) {
      const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
      const occ = new Map<string, number>();
      const key = (x: number, z: number) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
      for (const c of tr.cars) {
        if (c.kind === 2) continue;
        for (let k = 0; k < c.segT0.length; k++) {
          if ((c.segLot[k] as number) !== 1 || Math.abs((c.segS1[k] as number) - (c.segS0[k] as number)) > 0.01) continue;
          const a = Math.max(8 * 3600, c.segT0[k] as number);
          const b = Math.min(18 * 3600, c.segT1[k] as number);
          if (b - a < 60 || !tr.pose(c, (a + b) / 2, tp, 0)) continue;
          const kk = key(tp.x, tp.z);
          occ.set(kk, (occ.get(kk) ?? 0) + (b - a));
        }
      }
      let near = 0;
      let far = 0;
      for (const lot of net.lots) {
        if (lot.truck || lot.bays.length < 12 || lot.use === 'home') continue;
        // 进场的路程（场地边沿通道到车位）
        const dist = lot.bays.map((b, i) => ({ i, d: b.park.reduce((s, p, j) => (j ? s + Math.hypot(p.x - (b.park[j - 1] as V).x, p.z - (b.park[j - 1] as V).z) : 0), 0) })).sort((x, y) => x.d - y.d);
        const third = Math.floor(dist.length / 3);
        const sum = (list: typeof dist) => list.reduce((s, x) => s + (occ.get(key((lot.bays[x.i] as Bay).p.x, (lot.bays[x.i] as Bay).p.z)) ?? 0), 0);
        near += sum(dist.slice(0, third));
        far += sum(dist.slice(-third));
      }
      expect(near, `${tag} 近的车位停着车的时间`).toBeGreaterThan(far * 1.15);
    }
  });

  it('公共停车场里约一成半的车倒进车位（车头朝外）；开着的车不压停着的车：路边车位一辆也不蹭，停车场里很少（每 2 秒查一次）', () => {
    const { tr } = regions[0] as Built;
    expect(tr.stats.revIn, '倒进车位的车').toBeGreaterThan(100);
    expect(tr.stats.revIn / tr.stats.lotIn).toBeGreaterThan(0.08);
    expect(tr.stats.revIn / tr.stats.lotIn).toBeLessThan(0.2);
    const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
    const at = (c: CarTrack, t: number) => {
      const L = LEN[c.kind] as number;
      if (!tr.pose(c, t, tp, L)) return undefined;
      const dx = Math.cos(tp.yaw);
      const dz = -Math.sin(tp.yaw);
      return { b: { cx: tp.x + (dx * L) / 2, cz: tp.z + (dz * L) / 2, y: tp.y, dx, dz, hl: L / 2 - 0.2, hw: (WID[c.kind] as number) / 2 - 0.2 }, parked: tp.parked, lot: tp.lot };
    };
    const curb = new Set<string>();
    const lot = new Set<string>();
    for (let t = 6 * 3600; t < 22 * 3600; t += 2) {
      const grid = new Map<string, { ci: number; b: Body }[]>();
      const moving: { ci: number; b: Body; lot: boolean }[] = [];
      for (const ci of tr.activeAt(t)) {
        const q = at(tr.cars[ci] as CarTrack, t);
        if (!q) continue;
        if (!q.parked) {
          moving.push({ ci, b: q.b, lot: q.lot });
          continue;
        }
        const k = `${Math.floor(q.b.cx / 10)},${Math.floor(q.b.cz / 10)}`;
        grid.set(k, [...(grid.get(k) ?? []), { ci, b: q.b }]);
      }
      for (const m of moving) {
        const gx = Math.floor(m.b.cx / 10);
        const gz = Math.floor(m.b.cz / 10);
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++)
            for (const o of grid.get(`${gx + i},${gz + j}`) ?? []) {
              if (o.ci === m.ci || !overlap(m.b, o.b)) continue;
              // 路上的车：只数顺着停着的车开的（进出路边车位的那几下），横着压上路口转角那几个整天停着的车位的不算
              if (m.lot) lot.add(`${m.ci}-${o.ci}`);
              else if (Math.abs(m.b.dx * o.b.dx + m.b.dz * o.b.dz) > Math.cos((40 * Math.PI) / 180)) curb.add(`${m.ci}-${o.ci}`);
            }
      }
    }
    // 改之前（车位挨着用、没有倒车入位）：路边 19 对、停车场里 389 对
    expect(curb.size, '路边车位进出蹭到停着的车（对）').toBe(0);
    expect(lot.size, '停车场里开着的车压到停着的车（对）').toBeLessThanOrEqual(320);
  });

  it('背景车让仿真车：红灯前停着的仿真车（货车、配送车）身上不叠背景车，后面的背景车排在它后面', () => {
    // 运动规划按 @storewright/yard 全局表里的场地算：前面搭过别的区域（表里是那个区域的场地），默认区域要重新搭，不拿旧的道路网接着用
    const { net } = buildCity(DEFAULT_REGION);
    const sc = g3(1);
    sc.traceDay = TRACE_DAY;
    const res = runChain(sc);
    const L = 16.5;
    const motions = (res.trace?.vehicles ?? []).filter((v) => v.kind !== 'ship' && v.kind !== 'plane' && v.kind !== 'train').map((v) => buildMotion(v, net, { L, resolve: () => undefined, yard: v.id, lane: 0, dyn: DYN.heavy }));
    const runs = motions.flatMap((m) => roadRuns(m));
    expect(runs.length, '仿真车在路上的行驶段').toBeGreaterThan(5);
    const tr = new TrafficPlanner(net);
    tr.simulate(9000, undefined, undefined, runs);
    expect(tr.stats.trucks, '仿真车占的车道').toBeGreaterThan(50);
    const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
    const ls = { u: 0, v: 0, a: 0 };
    const near = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
      const ux = bx - ax;
      const uz = bz - az;
      const l2 = ux * ux + uz * uz || 1e-9;
      const k = Math.max(0, Math.min(1, ((px - ax) * ux + (pz - az) * uz) / l2));
      return { d: Math.hypot(px - ax - ux * k, pz - az - uz * k), k };
    };
    let stoppedSec = 0;
    let clash = 0;
    const queued = new Set<number>();
    for (const m of motions)
      for (const leg of m.legs) {
        if (!leg.spans?.length || !leg.tu) continue;
        for (let t = Math.ceil(leg.t0); t < leg.t1; t++) {
          const st = leadState(leg, t, ls);
          // 只看路上停着的时候（红灯前、排队）
          if (st.v > 0.01 || st.u < leg.u + 2 || st.u > (leg.tuS?.[leg.tuS.length - 1] ?? 0) - 1) continue;
          stoppedSec++;
          const F = trackAt(leg.track, st.u);
          const B = trackAt(leg.track, st.u - L);
          const hx = (F.x - B.x) / L;
          const hz = (F.z - B.z) / L;
          for (const ci of tr.activeAt(t)) {
            const c = tr.cars[ci] as CarTrack;
            const Lc = LEN[c.kind] as number;
            if (!tr.pose(c, t, tp, Lc) || tp.parked || Math.abs(tp.y - F.y) > 2.5) continue;
            const dx = Math.cos(tp.yaw);
            const dz = -Math.sin(tp.yaw);
            const hw = (WID[c.kind] as number) / 2 - 0.2 + 1.05;
            if ([0.1, 0.5, 0.9].some((f) => near(tp.x + dx * Lc * f, tp.z + dz * Lc * f, F.x, F.z, B.x, B.z).d < hw)) clash++;
            // 排在后面：车头在仿真车车尾后面 12 米以内、同一条车道、同一个方向
            const fx = tp.x + dx * Lc;
            const fz = tp.z + dz * Lc;
            const back = (B.x - fx) * hx + (B.z - fz) * hz;
            const side = Math.abs(-(fx - B.x) * hz + (fz - B.z) * hx);
            if (back > 0 && back < 12 && side < 1.2 && dx * hx + dz * hz > 0.9) queued.add(ci);
          }
        }
      }
    expect(stoppedSec, '仿真车在路上停着的秒数').toBeGreaterThan(200);
    expect(clash, '仿真车停着的时候身上叠着的背景车（车·秒）').toBe(0);
    expect(queued.size, '排在停着的仿真车后面的背景车').toBeGreaterThan(2);
    const a = tr.audit();
    expect(a.redRuns).toBe(0);
    expect(a.gaps).toBe(0);
  });

  it('小街路边的车位有进有出：夜里大多停着车，白天住户开走、来办事的停一会儿，晚上又停回来', () => {
    for (const { tag, tr, net } of regions) {
      const bays = net.curbs.map((c) => c.b);
      if (bays.length < 40) continue;
      const grid = new Map<string, V[]>();
      for (const p of bays) {
        const k = `${Math.floor(p.x / 20)},${Math.floor(p.z / 20)}`;
        grid.set(k, [...(grid.get(k) ?? []), p]);
      }
      const atBay = (x: number, z: number) => {
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++) for (const p of grid.get(`${Math.floor(x / 20) + i},${Math.floor(z / 20) + j}`) ?? []) if (Math.hypot(p.x - x, p.z - z) < 0.6) return true;
        return false;
      };
      const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
      const occ = (h: number) => {
        let n = 0;
        for (const ci of tr.activeAt(h * 3600)) if (tr.pose(tr.cars[ci] as CarTrack, h * 3600, tp) && tp.parked && atBay(tp.x, tp.z)) n++;
        return n / bays.length;
      };
      const night = occ(3);
      const noon = occ(12.5);
      const late = occ(22.5);
      expect(night, `${tag} 夜里路边车位停着车的比例`).toBeGreaterThan(0.55);
      expect(noon, `${tag} 中午比夜里少`).toBeLessThan(night - 0.1);
      expect(late, `${tag} 晚上又停回来`).toBeGreaterThan(noon + 0.08);
      expect(tr.stats.curbOut, `${tag} 从路边车位开走的车次`).toBeGreaterThan(bays.length * 0.12);
      expect(tr.stats.curbIn, `${tag} 停进路边车位的车次`).toBeGreaterThan(bays.length * 0.1);
    }
  });

  it('算好的数据传给主线程以后播放结果一样', () => {
    const { tr } = regions[0] as Built;
    const d = tr.data();
    expect(trafficTransfer(d).length).toBe(24);
    const view = Traffic.from(d);
    const a: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
    const b: TrafficPose = { ...a };
    for (let ci = 0; ci < tr.cars.length; ci += 37)
      for (const t of [7.5 * 3600, 12 * 3600, 18.2 * 3600]) {
        const oa = tr.pose(tr.cars[ci] as CarTrack, t, a, 4.6);
        const ob = view.pose(view.cars[ci] as CarTrack, t, b, 4.6);
        expect(ob).toBe(oa);
        if (oa) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-3);
      }
    expect(view.busStops.length).toBe(tr.busStops.length);
    expect(view.activeAt(8 * 3600).length).toBe(tr.activeAt(8 * 3600).length);
  });
});
