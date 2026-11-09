import * as THREE from 'three';
import { currentRegion } from '../../../src/region/network';
import { DIORAMA_SCALE, FRAMES, RAIL } from '../../../src/region/region';
import { cumulative, rand, sampleAt } from './geo';
import type { Lot } from './parking';
import { halfRoad, type Line, type RoadNet } from './roadnet';
import { AMBER, GREEN, phaseClock } from './signals';
import { ZEBRA_MID, type BusStop, type CarTrack, type Crosswalk, type Traffic, type TrafficPose } from './traffic';

/**
 * 行人（背景，不参与仿真）：
 * - 过街的人：沿人行道走到路口，在路缘等，按信号（这条腿红灯、横向绿灯的时候）和车流的空当过斑马线，
 *   到对面接着走，走进街区。斑马线上有车的时段（车流算好的轨迹）行人不上去，所以人和车不会同时压在斑马线上；
 *   等不到空当（两分半钟）就不过了，原路走开。
 * - 坐公交的人：沿人行道走到车站、在站台边等，公交车停靠时走到前门上车；下车的人从前门下来，沿人行道走开。
 * - 停车的人：车在员工停车场、客运站停车场、城区停车场停好以后，司机从车门边下来，沿场内通道走到场口，再走向设施大门、
 *   客运站或者街区；车要开走之前，司机从那边走回来上车。
 * 行人按真实大小画、按真实的步速走（区域的路压缩成 1/10，人行道上走的路程按画面算，不按真实公里算）；
 * 进了楼、上了车就不画了。整天的行走在后台线程里和社会车流一起算好（关键帧：时刻 + 位置，中间匀速），播放时查位置。
 * 行人互相让开：在路缘、站台等的人各站各的位置（沿路缘错开、前后错开），走路时靠右走（迎面来的人从两边错过去），
 * 画的时候离得太近的两个人再往两边推开一点（按此刻的位置算，拖动时间轴也一样）。
 */
export interface PedData {
  /** 每个行人：第一个关键帧的下标、关键帧数、外观（衣服颜色）、出现和消失的时刻 */
  off: Int32Array;
  n: Int32Array;
  look: Uint8Array;
  t0: Float64Array;
  t1: Float64Array;
  /** 关键帧：时刻、位置；kc = 从这一帧到下一帧在过第几条斑马线（−1 不在斑马线上） */
  kt: Float64Array;
  kx: Float32Array;
  ky: Float32Array;
  kz: Float32Array;
  kc: Int16Array;
  crosswalks: Crosswalk[];
  stats: PedStats;
}
export interface PedStats {
  peds: number;
  walkers: number;
  crossings: number;
  gaveUp: number;
  boardings: number;
  alightings: number;
  drivers: number;
}
/** PedData 里要转交（不复制）的数组 */
export function pedTransfer(d: PedData): ArrayBuffer[] {
  return [d.off, d.n, d.look, d.t0, d.t1, d.kt, d.kx, d.ky, d.kz, d.kc].map((a) => a.buffer as ArrayBuffer);
}

/** 行人每小时出门的权重（白天多、夜里少） */
const PED_HOURLY = [0.15, 0.08, 0.05, 0.05, 0.08, 0.3, 0.9, 1.6, 1.8, 1.4, 1.2, 1.3, 1.5, 1.4, 1.3, 1.4, 1.6, 1.9, 1.8, 1.4, 1.0, 0.7, 0.45, 0.25];
const PH_MAX = Math.max(...PED_HOURLY);
/** 步速（米 / 秒）、过斑马线的步速；在路缘最多等多久（秒） */
const WALK: [number, number] = [1.15, 1.45];
const CROSS_V = 1.3;
const MAX_WAIT = 150;

interface Key {
  t: number;
  x: number;
  y: number;
  z: number;
  c: number;
}
type P3 = { x: number; y: number; z: number };

/** 一个行人的关键帧：走到某点（按步速算时刻）、在原地等到某个时刻 */
class Walk {
  readonly keys: Key[] = [];
  constructor(
    t: number,
    p: P3,
    readonly v: number,
  ) {
    this.keys.push({ t, x: p.x, y: p.y, z: p.z, c: -1 });
  }
  get t(): number {
    return (this.keys[this.keys.length - 1] as Key).t;
  }
  get at(): P3 {
    return this.keys[this.keys.length - 1] as Key;
  }
  to(p: P3, v = this.v, crosswalk = -1): this {
    const a = this.at;
    const d = Math.hypot(p.x - a.x, p.z - a.z);
    (this.keys[this.keys.length - 1] as Key).c = crosswalk;
    this.keys.push({ t: this.t + d / v, x: p.x, y: p.y, z: p.z, c: -1 });
    return this;
  }
  wait(until: number): this {
    if (until <= this.t + 0.05) return this;
    const a = this.at;
    this.keys.push({ t: until, x: a.x, y: a.y, z: a.z, c: -1 });
    return this;
  }
  /** 整条路往后平移 dt 秒（先排好路线，再按要到的时刻对齐） */
  shift(dt: number): this {
    for (const k of this.keys) k.t += dt;
    return this;
  }
}

/** 人行道上的点：线 line 在 s 处，side = 1 在线方向的右侧、−1 左侧；inset 再往街区里走几米 */
function sidewalk(line: Line, s: number, side: number, inset = 0): P3 {
  const q = sampleAt(line.pts, line.cum, Math.max(0, Math.min(line.len, s)));
  const o = (halfRoad(line.xs) + line.xs.walk * 0.5 + inset) * side;
  return { x: q.p.x - q.dz * o, y: line.elev(s), z: q.p.z + q.dx * o };
}

/** 在一个空当里能不能过：[ts, ts + dur] 不碰车占着的时段，有信号的还要在横向的绿灯（加黄灯）里走完 */
function crossStart(cw: Crosswalk, ta: number, dur: number): number | undefined {
  const j = { offset: cw.offset };
  const other = cw.phase === 0 ? 1 : 0;
  let ts = ta;
  const busy = cw.busy;
  let bi = 0;
  for (let it = 0; it < 400 && ts < ta + MAX_WAIT; it++) {
    if (cw.signal) {
      const c = phaseClock(j, other, ts);
      if (c >= GREEN) {
        ts += 80 - c + 0.2;
        continue;
      }
      // 绿灯剩下的时间（加黄灯）走不完就等下一个绿灯
      if (GREEN + AMBER - c < dur) {
        ts += 80 - c + 0.2;
        continue;
      }
    }
    while (bi < busy.length && (busy[bi + 1] as number) <= ts) bi += 2;
    if (bi < busy.length && (busy[bi] as number) <= ts + dur) {
      ts = (busy[bi + 1] as number) + 0.1;
      continue;
    }
    return ts;
  }
  return undefined;
}

export interface PedInput {
  net: RoadNet;
  traffic: Traffic;
  crosswalks: Crosswalk[];
  lots: readonly Lot[];
  /** 行人的多少（平常 1，跟着负荷档位） */
  density?: number;
  seed?: number;
}

/** 算一整天的行人 */
export function planPeds(inp: PedInput): PedData {
  const { net, traffic, crosswalks } = inp;
  const r = rand((inp.seed ?? 7) * 7919 + 11);
  const density = inp.density ?? 1;
  const walks: { w: Walk; look: number }[] = [];
  const stats: PedStats = { peds: 0, walkers: 0, crossings: 0, gaveUp: 0, boardings: 0, alightings: 0, drivers: 0 };
  const speed = () => WALK[0] + r() * (WALK[1] - WALK[0]);
  const look = () => Math.floor(r() * 12);
  const pickHour = (): number => {
    const sum = PED_HOURLY.reduce((a, b) => a + b, 0);
    let x = r() * sum;
    for (let h = 0; h < 24; h++) {
      x -= PED_HOURLY[h] as number;
      if (x <= 0) return h;
    }
    return 12;
  };
  const poisson = (mean: number): number => {
    const L = Math.exp(-mean);
    let k = 0;
    let p = 1;
    for (;;) {
      p *= r();
      if (p < L) return k;
      k++;
    }
  };

  // —— 过街的人 ——
  for (const [ci, cw] of crosswalks.entries()) {
    const line = net.lines[cw.line] as Line;
    if (line.xs.walk <= 0) continue;
    // 斑马线在线上的位置（编号的最后一段是这条腿在线的哪一头）、离开路口的方向是线的正向还是反向
    const fromA = cw.id.endsWith(':a');
    const sMid = fromA ? line.trimA + ZEBRA_MID : line.len - line.trimB - ZEBRA_MID;
    const away = fromA ? 1 : -1;
    const room = fromA ? line.len - line.trimB - 20 - sMid : sMid - line.trimA - 20;
    if (room < 30) continue;
    const n = poisson(60 * density * (line.cls === 'arterial' ? 1 : 0.6));
    for (let k = 0; k < n; k++) {
      const h = pickHour();
      const side = r() < 0.5 ? 1 : -1;
      const d1 = 25 + r() * Math.min(110, room - 5);
      const d2 = 25 + r() * Math.min(110, room - 5);
      const v = speed();
      // 先按时刻 0 排出走到路缘的一段，再平移到要到的时刻
      // 在路缘等的人沿路缘、前后错开站（一起等的几个人不叠在一个点上）
      const curbA = sidewalk(line, sMid + (r() - 0.5) * 3.4, side, -(line.xs.walk * 0.5 - 0.4) + r() * 1.1);
      const w = new Walk(0, sidewalk(line, sMid + away * d1, side, 3), v);
      w.to(sidewalk(line, sMid + away * d1, side)).to(sidewalk(line, sMid + away * 2, side)).to(curbA);
      const tArrive = h * 3600 + r() * 3600;
      w.shift(tArrive - w.t);
      const curbB = sidewalk(line, sMid + (r() - 0.5) * 3.4, -side, -(line.xs.walk * 0.5 - 0.4) + r() * 1.1);
      const dur = Math.hypot(curbB.x - curbA.x, curbB.z - curbA.z) / CROSS_V;
      const ts = crossStart(cw, w.t, dur);
      if (ts === undefined) {
        // 等不到空当：原路走开
        w.wait(w.t + 20 + r() * 40).to(sidewalk(line, sMid + away * d2, side)).to(sidewalk(line, sMid + away * d2, side, 3));
        stats.gaveUp++;
      } else {
        w.wait(ts).to(curbB, CROSS_V, ci).to(sidewalk(line, sMid + away * 2, -side)).to(sidewalk(line, sMid + away * d2, -side)).to(sidewalk(line, sMid + away * d2, -side, 3));
        stats.crossings++;
      }
      walks.push({ w, look: look() });
      stats.walkers++;
    }
  }

  // —— 坐公交的人：公交车在中途站停靠的时段、在首末站发车前和到站后 ——
  const stops = traffic.busStops;
  const stopNear = (x: number, z: number): BusStop | undefined => {
    let best: BusStop | undefined;
    let bd = 30;
    for (const st of stops) {
      const d = Math.hypot(st.shelter.x - x, st.shelter.z - z);
      if (d < bd) [bd, best] = [d, st];
    }
    return best;
  };
  const tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
  const waitSpot = (st: BusStop): P3 => {
    const line = net.lines[st.line] as Line;
    const q = sampleAt(line.pts, line.cum, Math.max(0, Math.min(line.len, st.s)));
    const along = (r() - 0.5) * 6;
    const d = { x: q.dx * st.dir, z: q.dz * st.dir };
    // 站台上前后也错开一点
    const back = (r() - 0.5) * 1.4;
    return { x: st.shelter.x + d.x * along - d.z * back, y: st.shelter.y, z: st.shelter.z + d.z * along + d.x * back };
  };
  for (const c of traffic.cars) {
    if (c.kind !== 2 || c.line < 0) continue;
    const n = c.segT0.length;
    for (let k = 1; k < n; k++) {
      const t0 = c.segT0[k] as number;
      const t1 = c.segT1[k] as number;
      const still = Math.abs((c.segS1[k] as number) - (c.segS0[k] as number)) < 0.01;
      if (!still || t1 - t0 < 8) continue;
      const where = c.segLot[k] as number;
      const moveBefore = Math.abs((c.segS1[k - 1] as number) - (c.segS0[k - 1] as number)) > 0.01;
      const moveAfter = k + 1 < n && Math.abs((c.segS1[k + 1] as number) - (c.segS0[k + 1] as number)) > 0.01;
      if (!moveBefore && !moveAfter) continue;
      if (!traffic.pose(c, t0 + 0.5, tp, 0)) continue;
      const st = stopNear(tp.x, tp.z);
      if (!st) continue;
      const line = net.lines[st.line] as Line;
      const dx = Math.cos(tp.yaw);
      const dz = -Math.sin(tp.yaw);
      // 前门：车头往后 2.2 米、车身右侧外面
      const door: P3 = { x: tp.x - dx * 2.2 - dz * 1.9, y: tp.y, z: tp.z - dz * 2.2 + dx * 1.9 };
      const h = Math.min(23, Math.max(0, Math.floor(t0 / 3600)));
      const busy = (PED_HOURLY[h] as number) / PH_MAX;
      const terminal = where === 2;
      // 中途站：停靠的时候上下车；首末站：到站时下车、发车前上车
      const tOn0 = terminal ? Math.max(t0, t1 - 150) : t0 + 2;
      const tOnEnd = t1 - 2;
      const tOff0 = t0 + 1.5;
      const tOffEnd = terminal ? Math.min(t1 - 2, t0 + 90) : t1 - 3;
      const nOn = moveAfter ? Math.min(Math.floor((tOnEnd - tOn0) / 1.8), poisson((terminal ? 2.5 : 1.4) * busy * density)) : 0;
      const nOff = moveBefore ? Math.min(Math.floor((tOffEnd - tOff0) / 1.8), poisson((terminal ? 3 : 1.3) * busy * density)) : 0;
      for (let i = 0; i < nOn; i++) {
        const v = speed();
        const side = st.dir;
        const along = (r() < 0.5 ? -1 : 1) * (25 + r() * 70);
        const spot = waitSpot(st);
        const w = new Walk(0, sidewalk(line, st.s + along, side, 3), v);
        w.to(sidewalk(line, st.s + along, side)).to(sidewalk(line, st.s + along * 0.15, side)).to(spot);
        // 先到站台等着（车来前几分钟），车停稳了按先后上车
        w.shift(tOn0 - 30 - r() * 420 - w.t);
        const go = tOn0 + i * 1.8;
        if (go + 1 > tOnEnd) break;
        w.wait(go).to(door, v);
        // 走到车门的时刻不晚于车开（走得慢的人小跑几步）
        if (w.t > tOnEnd) w.keys[w.keys.length - 1] = { ...(w.keys[w.keys.length - 1] as Key), t: tOnEnd };
        walks.push({ w, look: look() });
        stats.boardings++;
      }
      for (let i = 0; i < nOff; i++) {
        const v = speed();
        const side = st.dir;
        const along = (r() < 0.5 ? -1 : 1) * (25 + r() * 80);
        const w = new Walk(tOff0 + i * 1.8, door, v);
        w.to(waitSpot(st)).to(sidewalk(line, st.s + along * 0.15, side)).to(sidewalk(line, st.s + along, side)).to(sidewalk(line, st.s + along, side, 3));
        walks.push({ w, look: look() });
        stats.alightings++;
      }
    }
  }

  // —— 停车的人：车停好以后司机走开，车开走之前走回来 ——
  const region = currentRegion();
  const S = DIORAMA_SCALE;
  const rail = RAIL.map((k) => new THREE.Vector3(k.x * S, 0, -k.y * S));
  const station = region.railPassenger && rail.length > 1 ? sampleAt(rail, cumulative(rail), region.railPassenger.s * S).p : undefined;
  const dest = (lot: Lot, gate: P3): P3 => {
    const toward = (o: { x: number; z: number }, max: number): P3 => {
      const dx = o.x - gate.x;
      const dz = o.z - gate.z;
      const l = Math.hypot(dx, dz) || 1;
      const d = Math.min(max, l);
      return { x: gate.x + (dx / l) * d, y: 0, z: gate.z + (dz / l) * d };
    };
    if (lot.id.startsWith('PORT')) return toward(FRAMES.port.o, 90);
    if (lot.id.startsWith('AIR')) return toward(FRAMES.airport.o, 90);
    if (lot.id.startsWith('DC')) return toward(FRAMES.park.o, 90);
    if (lot.use === 'station' && station) return toward(station, 140);
    const a = r() * Math.PI * 2;
    return { x: gate.x + Math.cos(a) * (30 + r() * 40), y: 0, z: gate.z + Math.sin(a) * (30 + r() * 40) };
  };
  const bayIndex: { x: number; z: number; lot: Lot; bay: number }[] = [];
  for (const lot of inp.lots) {
    if (lot.truck || lot.use === 'hold') continue;
    lot.bays.forEach((b, i) => bayIndex.push({ x: b.p.x, z: b.p.z, lot, bay: i }));
  }
  const grid = new Map<string, number[]>();
  const gk = (x: number, z: number) => `${Math.floor(x / 20)},${Math.floor(z / 20)}`;
  bayIndex.forEach((b, i) => {
    const k = gk(b.x, b.z);
    const list = grid.get(k) ?? [];
    list.push(i);
    grid.set(k, list);
  });
  const bayAt = (x: number, z: number) => {
    let best: (typeof bayIndex)[number] | undefined;
    let bd = 3;
    const cx = Math.floor(x / 20);
    const cz = Math.floor(z / 20);
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let k = cz - 1; k <= cz + 1; k++)
        for (const id of grid.get(`${i},${k}`) ?? []) {
          const b = bayIndex[id] as (typeof bayIndex)[number];
          const d = Math.hypot(b.x - x, b.z - z);
          if (d < bd) [bd, best] = [d, b];
        }
    return best;
  };
  const gatePos = (lot: Lot): P3 => {
    const j = net.junctions.get(lot.gate);
    return j ? { x: j.pos.x, y: 0, z: j.pos.z } : { x: (lot.outline[0] as { x: number }).x, y: 0, z: (lot.outline[0] as { z: number }).z };
  };
  for (const c of traffic.cars) {
    if (c.kind === 2) continue;
    const n = c.segT0.length;
    for (let k = 0; k < n; k++) {
      if ((c.segLot[k] as number) !== 1) continue;
      const t0 = c.segT0[k] as number;
      const t1 = c.segT1[k] as number;
      if (t1 - t0 < 120 || Math.abs((c.segS1[k] as number) - (c.segS0[k] as number)) > 0.01) continue;
      if (!traffic.pose(c, t0 + 0.5, tp, 0)) continue;
      const hit = bayAt(tp.x, tp.z);
      if (!hit) continue;
      const bay = hit.lot.bays[hit.bay];
      if (!bay) continue;
      const dx = Math.cos(tp.yaw);
      const dz = -Math.sin(tp.yaw);
      // 司机那一侧（车头往后 1.6 米、车身左边外面）
      const doorP: P3 = { x: tp.x - dx * 1.6 + dz * 1.4, y: 0.3, z: tp.z - dz * 1.6 - dx * 1.4 };
      const gate = gatePos(hit.lot);
      const aisle = bay.out.slice(Math.min(2, Math.max(0, bay.out.length - 1))).map((p) => ({ x: p.x, y: 0.3, z: p.z }));
      const route = [doorP, ...aisle, gate, dest(hit.lot, gate)];
      const v = speed();
      const parkedNow = k > 0 && Math.abs((c.segS1[k - 1] as number) - (c.segS0[k - 1] as number)) > 0.01;
      const leaving = k + 1 < n && Math.abs((c.segS1[k + 1] as number) - (c.segS0[k + 1] as number)) > 0.01;
      // 一部分人省掉（城区停车场的人多，画面里不用每个都画）
      const keep = hit.lot.use === 'public' ? 0.55 : 1;
      if (parkedNow && t0 > 60 && r() < keep * density) {
        const w = new Walk(t0 + 4, route[0] as P3, v);
        for (const p of route.slice(1)) w.to(p);
        walks.push({ w, look: look() });
        stats.drivers++;
      }
      if (leaving && t1 < 26 * 3600 && r() < keep * density) {
        const back = [...route].reverse();
        const w = new Walk(0, back[0] as P3, v);
        for (const p of back.slice(1)) w.to(p);
        w.shift(t1 - 2 - w.t);
        walks.push({ w, look: look() });
        stats.drivers++;
      }
    }
  }

  // —— 打包 ——
  const total = walks.reduce((a, x) => a + x.w.keys.length, 0);
  const d: PedData = {
    off: new Int32Array(walks.length),
    n: new Int32Array(walks.length),
    look: new Uint8Array(walks.length),
    t0: new Float64Array(walks.length),
    t1: new Float64Array(walks.length),
    kt: new Float64Array(total),
    kx: new Float32Array(total),
    ky: new Float32Array(total),
    kz: new Float32Array(total),
    kc: new Int16Array(total),
    crosswalks,
    stats,
  };
  let o = 0;
  walks.forEach(({ w, look: lk }, i) => {
    d.off[i] = o;
    d.n[i] = w.keys.length;
    d.look[i] = lk;
    d.t0[i] = (w.keys[0] as Key).t;
    d.t1[i] = w.t;
    for (const k of w.keys) {
      d.kt[o] = k.t;
      d.kx[o] = k.x;
      d.ky[o] = k.y;
      d.kz[o] = k.z;
      d.kc[o] = k.c;
      o++;
    }
  });
  stats.peds = walks.length;
  return d;
}

/** 行人此刻的位置、朝向（atan2(dz, dx)）、走了多远（摆臂的相位）、是不是在走 */
export interface PedPose {
  x: number;
  y: number;
  z: number;
  dir: number;
  dist: number;
  moving: boolean;
  /** 在过第几条斑马线（−1 不在） */
  cw: number;
}

/** 播放：按小时分桶，查每个行人此刻的位置 */
export class Peds {
  byHour: number[][] = [];
  constructor(readonly d: PedData) {
    for (let i = 0; i < d.off.length; i++) for (let h = Math.max(0, Math.floor((d.t0[i] as number) / 3600)); h <= Math.min(25, Math.floor((d.t1[i] as number) / 3600)); h++) (this.byHour[h] ??= []).push(i);
  }
  get count(): number {
    return this.d.off.length;
  }
  activeAt(t: number): readonly number[] {
    return this.byHour[Math.max(0, Math.min(25, Math.floor(t / 3600)))] ?? [];
  }
  pose(i: number, t: number, out: PedPose): boolean {
    const d = this.d;
    if (t < (d.t0[i] as number) || t > (d.t1[i] as number)) return false;
    const a = d.off[i] as number;
    const n = d.n[i] as number;
    let lo = a;
    let hi = a + n - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if ((d.kt[m] as number) <= t) lo = m;
      else hi = m - 1;
    }
    const k = Math.min(lo, a + n - 2);
    const ta = d.kt[k] as number;
    const tb = d.kt[k + 1] as number;
    const u = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 1;
    const x0 = d.kx[k] as number;
    const z0 = d.kz[k] as number;
    const x1 = d.kx[k + 1] as number;
    const z1 = d.kz[k + 1] as number;
    out.x = x0 + (x1 - x0) * u;
    out.y = (d.ky[k] as number) + ((d.ky[k + 1] as number) - (d.ky[k] as number)) * u;
    out.z = z0 + (z1 - z0) * u;
    const seg = Math.hypot(x1 - x0, z1 - z0);
    out.moving = seg > 0.02;
    if (out.moving) out.dir = Math.atan2(z1 - z0, x1 - x0);
    else {
      // 站着等：朝着下一段要走的方向
      for (let j = k + 1; j < a + n - 1; j++) {
        const dx = (d.kx[j + 1] as number) - (d.kx[j] as number);
        const dz = (d.kz[j + 1] as number) - (d.kz[j] as number);
        if (Math.hypot(dx, dz) > 0.02) {
          out.dir = Math.atan2(dz, dx);
          break;
        }
      }
    }
    out.dist = (t - ta) * (seg / Math.max(1e-6, tb - ta));
    out.cw = d.kc[k] as number;
    return true;
  }
}

/** 衣服的颜色（中性、常见） */
const CLOTHES = ['#3b4a63', '#5c6b7a', '#8a3b3b', '#2f5d50', '#c9a227', '#6d4c8a', '#d9d4c7', '#26303b', '#a5562f', '#4f7cac', '#7b8b5a', '#b94e6a'];

/**
 * 画行人：身体和腿（衣服的颜色）、头两套实例化网格；镜头近的时候才画（远了看不见），只画镜头附近的人。
 */
export class PedLayer {
  readonly group = new THREE.Group();
  private peds: Peds | undefined;
  private readonly body: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly pp: PedPose = { x: 0, y: 0, z: 0, dir: 0, dist: 0, moving: false, cw: -1 };
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly cols = CLOTHES.map((c) => new THREE.Color(c));
  static readonly MAX = 1600;
  /** 这一帧要画的人：位置（推开以前、以后）、朝向、编号 */
  private readonly sep = { x: new Float32Array(1600), y: new Float32Array(1600), z: new Float32Array(1600), dir: new Float32Array(1600), id: new Int32Array(1600) };
  /** 镜头离地多远以内才画、只画镜头看着的那一片多远以内的人 */
  static readonly NEAR = 900;
  static readonly RANGE = 650;

  constructor() {
    this.group.name = 'pedestrians';
    const torso = new THREE.CylinderGeometry(0.2, 0.24, 0.72, 7).translate(0, 1.18, 0);
    const legs = new THREE.BoxGeometry(0.34, 0.82, 0.22).translate(0, 0.41, 0);
    const arms = new THREE.BoxGeometry(0.62, 0.12, 0.14).translate(0, 1.42, 0);
    const g = new THREE.BufferGeometry();
    const parts = [torso, legs, arms].map((x) => x.toNonIndexed());
    const n = parts.reduce((a, p) => a + (p.getAttribute('position') as THREE.BufferAttribute).count, 0);
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    let o = 0;
    for (const p of parts) {
      pos.set((p.getAttribute('position') as THREE.BufferAttribute).array as Float32Array, o * 3);
      nor.set((p.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array, o * 3);
      o += (p.getAttribute('position') as THREE.BufferAttribute).count;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    this.body = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ roughness: 0.85 }), PedLayer.MAX);
    this.head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 8, 6).translate(0, 1.7, 0), new THREE.MeshStandardMaterial({ color: '#d8b38f', roughness: 0.8 }), PedLayer.MAX);
    for (const m of [this.body, this.head]) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    this.body.setColorAt(0, this.cols[0] as THREE.Color);
  }

  setData(d: PedData | undefined): void {
    this.peds = d ? new Peds(d) : undefined;
  }

  get data(): Peds | undefined {
    return this.peds;
  }

  /** 每帧：镜头近的时候按时刻摆行人（走路时上下颠一点） */
  update(t: number, camDist: number, target: { x: number; z: number }): void {
    const P = this.peds;
    if (!P || camDist > PedLayer.NEAR) {
      this.body.count = 0;
      this.head.count = 0;
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const pp = this.pp;
    let k = 0;
    const range = Math.max(160, Math.min(PedLayer.RANGE, camDist * 1.2));
    const S = this.sep;
    for (const i of P.activeAt(t)) {
      if (k >= PedLayer.MAX) break;
      if (!P.pose(i, t, pp)) continue;
      if (Math.abs(pp.x - target.x) > range || Math.abs(pp.z - target.z) > range) continue;
      // 走路靠右：往行进方向的右边偏 0.4 米（迎面来的人从两边错过去）
      const keep = pp.moving ? 0.4 : 0;
      S.x[k] = pp.x - Math.sin(pp.dir) * keep;
      S.z[k] = pp.z + Math.cos(pp.dir) * keep;
      S.y[k] = pp.y + 0.3 + (pp.moving ? Math.abs(Math.sin(pp.dist * 2.6)) * 0.05 : 0);
      S.dir[k] = pp.dir;
      S.id[k] = i;
      k++;
    }
    // 离得太近（不到 0.62 米）的两个人往两边推开（按 1 米的格子找邻居，推两遍）
    const MIN = 0.62;
    for (let pass = 0; pass < 2; pass++) {
      const cell = new Map<number, number[]>();
      for (let a = 0; a < k; a++) {
        const key = (Math.floor(S.x[a] as number) + 50000) * 100003 + Math.floor(S.z[a] as number) + 50000;
        const list = cell.get(key);
        if (list) list.push(a);
        else cell.set(key, [a]);
      }
      for (let a = 0; a < k; a++) {
        const cx = Math.floor(S.x[a] as number);
        const cz = Math.floor(S.z[a] as number);
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++)
            for (const b of cell.get((cx + dx + 50000) * 100003 + cz + dz + 50000) ?? []) {
              if (b <= a) continue;
              const ex = (S.x[b] as number) - (S.x[a] as number);
              const ez = (S.z[b] as number) - (S.z[a] as number);
              const d = Math.hypot(ex, ez);
              if (d >= MIN) continue;
              // 正好重合：按编号定一个方向推
              const ux = d > 1e-4 ? ex / d : Math.cos((S.id[a] as number) * 2.4);
              const uz = d > 1e-4 ? ez / d : Math.sin((S.id[a] as number) * 2.4);
              const push = (MIN - d) / 2;
              S.x[a] = (S.x[a] as number) - ux * push;
              S.z[a] = (S.z[a] as number) - uz * push;
              S.x[b] = (S.x[b] as number) + ux * push;
              S.z[b] = (S.z[b] as number) + uz * push;
            }
      }
    }
    for (let a = 0; a < k; a++) {
      this.pos.set(S.x[a] as number, S.y[a] as number, S.z[a] as number);
      this.q.setFromAxisAngle(this.up, -(S.dir[a] as number));
      this.m4.compose(this.pos, this.q, this.one);
      this.body.setMatrixAt(a, this.m4);
      this.head.setMatrixAt(a, this.m4);
      this.body.setColorAt(a, this.cols[(P.d.look[S.id[a] as number] as number) % this.cols.length] as THREE.Color);
    }
    this.body.count = k;
    this.head.count = k;
    this.body.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
  }
}

export type { CarTrack };
