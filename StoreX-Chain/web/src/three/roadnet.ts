import * as THREE from 'three';
import { buildGraph, currentRegion, STORES, type StoreSite } from '../../../src/region/network';
import { FRAMES, RAIL, REGION, type Km } from '../../../src/region/region';
import { DIR_LABEL, dirOf, LOCAL } from '../../../src/region/regionGen';
import { footprintKm } from '../../../src/region/frames';
import { bezier, closedSpline, cumulative, fillet, mapAngle, offset, pointInPoly, resample, reverse, sampleAt, segIntersect, slice, v3, type V3 } from './geo';
import type { Lot } from './parking';

/**
 * 三维场景的道路网：在仿真的道路图（节点 + 边）之上细化出真实的道路几何——
 * 每条路有横断面（几条车道、车道宽、中央分隔带、路肩、人行道），路口有转弯曲线和信号灯，
 * 绕城快速路（沿内陆一侧绕过城区，不成环）和进城干道相交处是菱形立交（快速路上桥、匝道、两个信号控制的匝道口），
 * 高架快速路整段架在空中跨过城区，过河的路都是桥，高速、快速路和干道跨铁路处上桥；门店的进店路从最近的干道或匝道口接出来。
 *
 * 仿真里的车只告诉三维场景「经过哪些节点」，这里负责把它变成一条沿车道、过路口和立交、上下桥的三维路径；
 * 背景车流也在这张网上找路。沙盘坐标：x = 公里 × 100（向东），z = −公里 × 100，单位米。
 */
export const S = 100;
export const P = (k: Km): V3 => v3(k.x * S, 0, -k.y * S);

export type RClass = 'highway' | 'ring' | 'elevated' | 'arterial' | 'local' | 'street' | 'ramp' | 'under' | 'service' | 'farm';
/** 横断面：每个方向几条车道、车道宽、中央分隔带、内外路肩、人行道（米） */
export interface XS {
  lanes: number;
  laneW: number;
  median: number;
  inner: number;
  outer: number;
  walk: number;
  oneWay?: boolean;
}
export const XSEC: Record<RClass, XS> = {
  highway: { lanes: 2, laneW: 3.75, median: 4, inner: 1, outer: 2.5, walk: 0 },
  ring: { lanes: 3, laneW: 3.5, median: 1.2, inner: 0.6, outer: 2, walk: 0 },
  elevated: { lanes: 2, laneW: 3.5, median: 1.0, inner: 0.5, outer: 1.0, walk: 0 },
  arterial: { lanes: 2, laneW: 3.4, median: 3, inner: 0.3, outer: 1.5, walk: 3.5 },
  under: { lanes: 2, laneW: 3.4, median: 1.2, inner: 0.3, outer: 1.2, walk: 2 },
  local: { lanes: 1, laneW: 3.5, median: 0, inner: 0, outer: 2.2, walk: 2.5 },
  street: { lanes: 1, laneW: 3.25, median: 0, inner: 0, outer: 2, walk: 2.2 },
  ramp: { lanes: 1, laneW: 4, median: 0, inner: 1, outer: 2, walk: 0, oneWay: true },
  service: { lanes: 1, laneW: 3.6, median: 0, inner: 0, outer: 0.6, walk: 0 },
  farm: { lanes: 1, laneW: 3, median: 0, inner: 0, outer: 0.4, walk: 0 },
};
/** 车行道的半宽（单向路是整宽的一半） */
export const halfRoad = (xs: XS): number => (xs.oneWay ? (xs.inner + xs.lanes * xs.laneW + xs.outer) / 2 : xs.median / 2 + xs.inner + xs.lanes * xs.laneW + xs.outer);
export const halfAll = (xs: XS): number => halfRoad(xs) + xs.walk;
/** 第 k 条车道（0 = 最右，也就是最外侧）中心在行进方向右侧的偏移 */
export function laneOffset(xs: XS, k: number): number {
  const j = xs.lanes - 1 - Math.max(0, Math.min(xs.lanes - 1, k));
  if (xs.oneWay) return -halfRoad(xs) + xs.inner + (j + 0.5) * xs.laneW;
  return xs.median / 2 + xs.inner + (j + 0.5) * xs.laneW;
}
/** 各级道路的车速系数（仿真车在一段行程里按它分配快慢）和背景车的车速（沙盘米 / 秒，真实车速的 1/10） */
export const PACE: Record<RClass, number> = { highway: 1, ring: 0.95, elevated: 0.85, ramp: 0.55, under: 0.5, arterial: 0.55, local: 0.4, street: 0.35, service: 0.18, farm: 0.45 };
export const SPEED: Record<RClass, number> = { highway: 2.8, ring: 2.5, elevated: 2.2, ramp: 1.5, under: 1.3, arterial: 1.45, local: 1.0, street: 0.85, service: 0.45, farm: 1.2 };

export interface Line {
  id: number;
  cls: RClass;
  xs: XS;
  pts: V3[];
  cum: number[];
  len: number;
  ja: string;
  jb: string;
  closed?: boolean;
  /** 沿线的高度（桥） */
  elev: (s: number) => number;
  /** 线上的 T 形路口、匝道分合流点（从小到大） */
  mids: { s: number; j: string }[];
  trimA: number;
  trimB: number;
  lights: 'both' | 'median' | 'one' | 'none';
  trees: 'median' | 'walk' | 'none';
  name?: string;
  /** 跨过铁路的位置（画桥墩、栏杆） */
  bridges: { s0: number; s1: number }[];
  /** 出区域的高速：区域边界在线上的位置（再往外是一直画到远处的延长段） */
  edgeS?: number;
}

export type JKind = 'grade' | 'roundabout' | 'mid' | 'end' | 'merge';
export interface Leg {
  line: number;
  end: 'a' | 'b';
  ang: number;
  hw: number;
  hwAll: number;
}
export interface Junction {
  id: string;
  pos: V3;
  kind: JKind;
  signal: boolean;
  legs: Leg[];
  /** mid / merge：所在的线和位置 */
  host?: number;
  s?: number;
  /** 环岛半径 */
  radius?: number;
  /** 信号：每条进口道属于哪个相位、周期偏移 */
  phase: Map<number, 0 | 1>;
  offset: number;
  /** merge 节点允许的转向（"进线:方向>出线:方向"） */
  allow?: Set<string>;
  /** 是不是立交的匝道口 / 是不是铁路平交道口 */
  tag?: string;
  /** 尽头路的回车场（车开到头掉头） */
  bulb?: boolean;
}

/** 一段有向行程：在线 line 上从 s0 走到 s1（s0 > s1 表示逆着线的方向走） */
export interface Arc {
  line: number;
  s0: number;
  s1: number;
  ja: string;
  jb: string;
}

export interface Place {
  /** 车从这个路口离开道路网，沿 path 开过去；有 reverse 时再倒车进车位（车尾贴门） */
  junction: string;
  path: V3[];
  reverse?: V3[];
  /** 离开时走的路（没有就把 path 倒过来走）：出区域的高速去程和回程在不同的车道上 */
  leave?: V3[];
  /** 出区域的高速口：开出区域边界以后沿延长段接着开的路（offOut），开进来的车从延长段远处开过来（offIn） */
  offOut?: V3[];
  offIn?: V3[];
}

export interface Crossing {
  pos: V3;
  ang: number;
  line: number;
  s: number;
}

/** 出区域的高速画到区域边界外多远（沙盘米）：远处接地平线，不在区域边上断掉 */
export const MAP_RUN = 3000;

/** 立交尺寸（沙盘米）：快速路上桥的平段半长、坡段终点、匝道分合流点，匝道口离快速路中心的距离、桥高 */
export const IC = { flat: 40, ramp: 140, zone: 165, term: 72, height: 6.5 };
const ROUNDABOUT_R = 58;

const smooth01 = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
/** 桥的高度剖面：中间 flat 米平段，往外到 ramp 米降到地面 */
const bump = (d: number, h: number, flat: number, ramp: number) => h * smooth01((ramp - Math.abs(d)) / (ramp - flat));

export class RoadNet {
  lines: Line[] = [];
  junctions = new Map<string, Junction>();
  /** 仿真的边（"a|b"）→ 三维里对应的行程（从 a 到 b 的方向） */
  edgeArcs = new Map<string, Arc[]>();
  /** 门店：进店路的接入点、门店的站点数据由 stores 模块填 */
  storeAttach = new Map<string, { pos: V3; dir: { x: number; z: number }; junction: string; viaLine?: number; viaS?: number }>();
  places = new Map<string, Place>();
  /** 停车场（parking 模块摆的）：背景车流在车位之间往来 */
  lots: Lot[] = [];
  crossings: Crossing[] = [];
  /** 小街路边的停车位（zoning.planCurbs 划的）：车尾、车头的位置（车头朝这一侧的行车方向） */
  curbs: { a: V3; b: V3; line: number }[] = [];
  /** 立交：立交节点 → 两个匝道口、两个分合流点、桥的位置 */
  ics = new Map<string, { tin: string; tout: string; zbm: string; zbp: string; ring: number; s: number; t: { x: number; z: number }; n: { x: number; z: number }; under: number; ramps: Record<'ccwOff' | 'ccwOn' | 'cwOff' | 'cwOn', number> }>();
  /** 绕城快速路主线（这张网里唯一的 ring 线）的编号 */
  ringLine = -1;
  /** 绕城快速路上从一头到另一头的节点、其中的立交 */
  chain: string[] = [];
  icIds = new Set<string>();
  private sim = buildGraph();

  constructor() {
    this.buildMain();
  }

  // ———————————————————————— 构建 ————————————————————————

  addLine(cls: RClass, pts: V3[], ja: string, jb: string, o: Partial<Line> = {}): Line {
    const dense = resample(pts, cls === 'ring' ? 12 : cls === 'street' || cls === 'service' ? 8 : 10);
    const cum = cumulative(dense);
    const line: Line = {
      id: this.lines.length,
      cls,
      xs: XSEC[cls],
      pts: dense,
      cum,
      len: cum[cum.length - 1] as number,
      ja,
      jb,
      elev: () => 0,
      mids: [],
      trimA: 0,
      trimB: 0,
      lights: cls === 'arterial' || cls === 'under' ? 'both' : cls === 'ring' || cls === 'highway' || cls === 'elevated' ? 'median' : cls === 'street' || cls === 'local' || cls === 'ramp' ? 'one' : 'none',
      trees: cls === 'arterial' ? 'median' : cls === 'street' || cls === 'local' ? 'walk' : 'none',
      bridges: [],
      ...o,
    };
    this.lines.push(line);
    return line;
  }

  junction(id: string, pos: V3, kind: JKind, signal = false, extra: Partial<Junction> = {}): Junction {
    let j = this.junctions.get(id);
    if (!j) {
      j = { id, pos: pos.clone(), kind, signal, legs: [], phase: new Map(), offset: 0, ...extra };
      this.junctions.set(id, j);
    }
    return j;
  }

  /** 在线上 s 处加一个 T 形路口（或分合流点），返回路口编号 */
  addMid(line: Line, s: number, id: string, kind: 'mid' | 'merge' = 'mid', signal = false): string {
    const p = sampleAt(line.pts, line.cum, s).p;
    this.junction(id, p, kind, signal, { host: line.id, s });
    line.mids.push({ s, j: id });
    line.mids.sort((a, b) => a.s - b.s);
    return id;
  }

  private nodeP(id: string): V3 {
    return P(this.sim.nodes.get(id) as Km);
  }

  /** 立交内侧接的城区路口（区域生成器给的） */
  private gateway(rid: string): string {
    return currentRegion().gateways[rid] as string;
  }

  private buildMain(): void {
    const plan = currentRegion();
    this.chain = [...plan.bypass];
    this.icIds = new Set(plan.ics);
    const simEdge = (a: string, b: string) => this.sim.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    const ptsOf = (e: { a: string; pts: Km[] }, from: string) => (e.a === from ? e.pts : [...e.pts].reverse());
    // 绕城快速路：沿生成器给的折线（两头 BE0、BE1，中间是立交），不成环
    const ringKm: Km[] = [];
    for (let k = 0; k < this.chain.length - 1; k++) {
      const e = simEdge(this.chain[k] as string, this.chain[k + 1] as string);
      if (!e) continue;
      const seg = ptsOf(e, this.chain[k] as string);
      for (const p of ringKm.length ? seg.slice(1) : seg) ringKm.push(p);
    }
    const ring = this.addLine('ring', fillet(ringKm.map(P), 400, 14), 'BE0', 'BE1', { name: '绕城快速路' });
    this.ringLine = ring.id;
    const nearestS = (p: V3) => {
      let best = 0;
      let bd = Infinity;
      ring.pts.forEach((q, i) => {
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bd) {
          bd = d;
          best = ring.cum[i] as number;
        }
      });
      return best;
    };
    const L = ring.len;
    const ringS = plan.ics.map((id) => Math.max(IC.zone + 20, Math.min(L - IC.zone - 20, nearestS(this.nodeP(id)))));
    ring.elev = (s) => {
      let h = 0;
      for (const sk of ringS) h = Math.max(h, bump(s - sk, IC.height, IC.flat, IC.ramp));
      return h;
    };
    ringS.forEach((sk) => ring.bridges.push({ s0: sk - IC.ramp, s1: sk + IC.ramp }));

    // 城区路口：信号灯路口
    for (const id of plan.city.nodes) if (this.sim.nodes.has(id)) this.junction(id, this.nodeP(id), 'grade', true);

    // 立交：每个立交节点（快速路上桥，桥下一条路，两个信号控制的匝道口，四条单向匝道）
    plan.ics.forEach((rid, k) => {
      const sk = ringS[k] as number;
      const sm = sampleAt(ring.pts, ring.cum, sk);
      const R = sm.p.clone().setY(0);
      const t = { x: sm.dx, z: sm.dz };
      // 向外的法线（离开市中心）
      let n = { x: -t.z, z: t.x };
      if (n.x * R.x + n.z * R.z < 0) n = { x: -n.x, z: -n.z };
      const mid = this.nodeP(this.gateway(rid));
      const toMid = new THREE.Vector3(mid.x - R.x, 0, mid.z - R.z).normalize();
      const tin = v3(R.x + toMid.x * IC.term, 0, R.z + toMid.z * IC.term);
      // 外侧：只有一条高速时沿它的方向，否则沿法线
      const outer = this.sim.edges.filter((e) => (e.a === rid || e.b === rid) && e.cls === 'highway');
      let outDir = { x: n.x, z: n.z };
      if (outer.length === 1) {
        const pts = ptsOf(outer[0] as (typeof outer)[number], rid).map(P);
        const q = pts[Math.min(pts.length - 1, 1)] as V3;
        const l = Math.hypot(q.x - R.x, q.z - R.z) || 1;
        outDir = { x: (q.x - R.x) / l, z: (q.z - R.z) / l };
        if (outDir.x * n.x + outDir.z * n.z < 0.2) outDir = { x: n.x, z: n.z };
      }
      const tout = v3(R.x + outDir.x * IC.term, 0, R.z + outDir.z * IC.term);
      const idIn = `${rid}:in`;
      const idOut = `${rid}:out`;
      this.junction(idIn, tin, 'grade', true, { tag: 'terminal' });
      this.junction(idOut, tout, 'grade', true, { tag: 'terminal' });
      // 快速路上的分合流点：沿线 s 增加方向的上游是 zbm
      const zbm = this.addMid(ring, sk - IC.zone, `${rid}:zbm`, 'merge');
      const zbp = this.addMid(ring, sk + IC.zone, `${rid}:zbp`, 'merge');
      const under = this.addLine('under', [tin, R.clone(), tout], idIn, idOut, { name: `${rid} 桥下` });
      // 匝道：沿 s 增加方向行驶的车道在外侧（右侧 = 外），反方向在内侧
      const ringEdge = halfRoad(ring.xs) + 2.2;
      const at = (s: number, side: number) => {
        const q = sampleAt(ring.pts, ring.cum, Math.max(0, Math.min(L, s)));
        const rx = -q.dz;
        const rz = q.dx;
        const sgn = rx * n.x + rz * n.z > 0 ? side : -side;
        return { p: v3(q.p.x + rx * ringEdge * sgn, 0, q.p.z + rz * ringEdge * sgn), d: { x: q.dx, z: q.dz } };
      };
      const termTrim = 18;
      const tdir = (d: { x: number; z: number }) => ({ x: d.x, z: d.z });
      const a1 = at(sk - IC.zone, 1);
      const e1 = v3(tout.x - t.x * termTrim, 0, tout.z - t.z * termTrim);
      const ccwOff = this.addLine('ramp', [...bezier(a1.p, tdir(a1.d), e1, t, 0.45, 24)], zbm, idOut, { name: `${rid} 出口匝道` });
      const a2 = at(sk + IC.zone, 1);
      const s2 = v3(tout.x + t.x * termTrim, 0, tout.z + t.z * termTrim);
      const ccwOn = this.addLine('ramp', [...bezier(s2, t, a2.p, tdir(a2.d), 0.45, 24)], idOut, zbp, { name: `${rid} 入口匝道` });
      const a3 = at(sk + IC.zone, -1);
      const nt = { x: -t.x, z: -t.z };
      const e3 = v3(tin.x + t.x * termTrim, 0, tin.z + t.z * termTrim);
      const cwOff = this.addLine('ramp', [...bezier(a3.p, { x: -a3.d.x, z: -a3.d.z }, e3, nt, 0.45, 24)], zbp, idIn, { name: `${rid} 出口匝道` });
      const a4 = at(sk - IC.zone, -1);
      const s4 = v3(tin.x - t.x * termTrim, 0, tin.z - t.z * termTrim);
      const cwOn = this.addLine('ramp', [...bezier(s4, nt, a4.p, { x: -a4.d.x, z: -a4.d.z }, 0.45, 24)], idIn, zbm, { name: `${rid} 入口匝道` });
      const zm = this.junctions.get(zbm) as Junction;
      const zp = this.junctions.get(zbp) as Junction;
      zm.allow = new Set([`ring+>ring+`, `ring+>${ccwOff.id}`, `ring->ring-`, `${cwOn.id}>ring-`]);
      zp.allow = new Set([`ring+>ring+`, `${ccwOn.id}>ring+`, `ring->ring-`, `ring->${cwOff.id}`]);
      this.ics.set(rid, { tin: idIn, tout: idOut, zbm, zbp, ring: ring.id, s: sk, t, n, under: under.id, ramps: { ccwOff: ccwOff.id, ccwOn: ccwOn.id, cwOff: cwOff.id, cwOn: cwOn.id } });
    });

    // 快速路的两头：有别的路接上来就是平交路口，否则是尽头
    for (const [id, s] of [
      ['BE0', 0],
      ['BE1', L],
    ] as const) {
      const others = this.sim.edges.some((e) => (e.a === id || e.b === id) && !(e.cls === 'ring' && this.chain.includes(e.a) && this.chain.includes(e.b)));
      this.junction(id, sampleAt(ring.pts, ring.cum, s).p.clone().setY(0), others ? 'grade' : 'end', others);
    }
    // 快速路的边：BE0 → 立交 → … → BE1，在立交之间沿主线走
    const endS = (id: string, asStart: boolean): { s: number; j: string } => {
      if (id === 'BE0') return { s: 0, j: 'BE0' };
      if (id === 'BE1') return { s: L, j: 'BE1' };
      const ic = this.ics.get(id) as NonNullable<ReturnType<typeof this.ics.get>>;
      const j = asStart ? ic.zbp : ic.zbm;
      return { s: (this.junctions.get(j) as Junction).s as number, j };
    };
    for (let k = 0; k < this.chain.length - 1; k++) {
      const a = this.chain[k] as string;
      const b = this.chain[k + 1] as string;
      const A = endS(a, true);
      const B = endS(b, false);
      this.mapEdge(a, b, [{ line: ring.id, s0: A.s, s1: B.s, ja: A.j, jb: B.j }]);
    }

    // 城区干道（生成器给的路段，沿它的折线）：接立交的那头接到内侧匝道口；高架快速路单独画（整段架在空中）
    const viaduct = plan.viaduct;
    for (const e of this.sim.edges) {
      const isViaduct = !!viaduct && e.cls === 'ring' && ((e.a === viaduct.a && e.b === viaduct.b) || (e.a === viaduct.b && e.b === viaduct.a));
      if (isViaduct) {
        const pts = fillet(e.pts.map(P), 260, 10);
        pts[0] = this.nodeP(e.a);
        pts[pts.length - 1] = this.nodeP(e.b);
        const l = this.addLine('elevated', pts, e.a, e.b, { name: '高架快速路' });
        const H = 9.5;
        l.elev = (s) => H * smooth01((Math.min(s, l.len - s) - 40) / 230);
        l.bridges.push({ s0: 40, s1: l.len - 40 });
        this.mapEdge(e.a, e.b, [{ line: l.id, s0: 0, s1: l.len, ja: e.a, jb: e.b }]);
        continue;
      }
      if (e.cls !== 'arterial') continue;
      const icEnd = this.icIds.has(e.a) ? e.a : this.icIds.has(e.b) ? e.b : undefined;
      if (icEnd) {
        const urban = icEnd === e.a ? e.b : e.a;
        const ic = this.ics.get(icEnd) as NonNullable<ReturnType<typeof this.ics.get>>;
        const tin = (this.junctions.get(ic.tin) as Junction).pos;
        const l = this.addLine('arterial', [this.nodeP(urban), tin.clone()], urban, ic.tin, { name: '进城干道' });
        this.mapEdge(urban, icEnd, [{ line: l.id, s0: 0, s1: l.len, ja: urban, jb: ic.tin }]);
        continue;
      }
      const pts = fillet(e.pts.map(P), 160, 8);
      const l = this.addLine('arterial', pts, e.a, e.b, { name: '城市干道' });
      this.mapEdge(e.a, e.b, [{ line: l.id, s0: 0, s1: l.len, ja: e.a, jb: e.b }]);
    }

    // 高速和设施路：沿仿真的折线（拐角倒圆），立交那头换成外侧匝道口
    const facilityKind: Record<string, JKind> = { DC: 'grade', NORTH: 'grade', EAST: 'grade', PORT: 'end', AIR: 'end', BAKERY: 'end' };
    for (const [id, kind] of Object.entries(facilityKind)) this.junction(id, this.nodeP(id), kind, id === 'DC');
    for (const e of this.sim.edges) {
      if (e.cls !== 'highway' && !(e.cls === 'local' && ((e.a === 'DC' && e.b === 'BAKERY') || (e.a === 'BAKERY' && e.b === 'DC')))) continue;
      const toJ = (id: string) => (this.icIds.has(id) ? (this.ics.get(id) as NonNullable<ReturnType<typeof this.ics.get>>).tout : id);
      const ja = toJ(e.a);
      const jb = toJ(e.b);
      const pts = e.pts.map(P);
      pts[0] = (this.junctions.get(ja) as Junction).pos.clone();
      pts[pts.length - 1] = (this.junctions.get(jb) as Junction).pos.clone();
      const cls = e.cls === 'local' ? 'service' : 'highway';
      const line = this.addLine(cls, cls === 'service' ? fillet(pts, 30, 6) : fillet(pts, 220, 10), ja, jb, { name: e.cls === 'local' ? '面包房路' : '高速' });
      this.mapEdge(e.a, e.b, [{ line: line.id, s0: 0, s1: line.len, ja, jb }]);
    }
    // 出区域的高速（国内长途、跨境长途的方向）：过了区域边界再沿出区域的方向画 3 公里，远处接地平线
    for (const [id, mapId, name] of [
      ['NORTH', 'MAP_N', `往${DIR_LABEL[dirOf(plan.offmap.NORTH)]} · 国内长途高速`],
      ['EAST', 'MAP_E', `往${DIR_LABEL[dirOf(plan.offmap.EAST)]} · 跨境长途高速`],
    ] as const) {
      const a = this.nodeP(id);
      const b = P(plan.offmap[id]);
      const m = v3((a.x + b.x) / 2 + (b.z - a.z) * 0.04, 0, (a.z + b.z) / 2 - (b.x - a.x) * 0.04);
      const pts = fillet([a.clone(), m, b.clone()], 400, 12);
      const edgeS = cumulative(pts)[pts.length - 1] as number;
      const q = pts[pts.length - 2] as V3;
      const dl = Math.hypot(b.x - q.x, b.z - q.z) || 1;
      const far = v3(b.x + ((b.x - q.x) / dl) * MAP_RUN, 0, b.z + ((b.z - q.z) / dl) * MAP_RUN);
      this.junction(mapId, far, 'end');
      this.addLine('highway', [...pts, far], id, mapId, { name, edgeS });
    }

    // 断头路接通（在过河、跨铁路之前：连接线照样上桥）
    this.connectDeadEnds();
    // 过河：桥（中间平、两头坡）；跨铁路：高速、快速路、干道上桥
    this.riverCrossings();
    this.railCrossings();
    // 门店的进店路接入点
    this.storeAttachPoints();
  }

  /**
   * 断头路接通：干道、快速路的尽头（设施大门、出区域的高速口、门店入口不算）在三维里接到附近的路上——
   * 优先接城区路口，其次在别的干道上开一个 T 形路口；连接线顺着原来的方向出去，不和别的路相交、不下海、
   * 不穿过设施和门店，离别的路口远一点，过河、跨铁路照样上桥。只改三维的路网（背景车流可以走），
   * 仿真的道路图和报告的里程不变。实在接不上的做成带回车场的尽头路（车开到头掉头）。
   */
  private connectDeadEnds(): void {
    const plan = currentRegion();
    const degree = new Map<string, number>();
    for (const l of this.lines) {
      for (const j of [l.ja, l.jb]) degree.set(j, (degree.get(j) ?? 0) + 1);
      for (const m of l.mids) degree.set(m.j, (degree.get(m.j) ?? 0) + 2);
    }
    // 门店的进店路后面才铺（stores 模块），接门店的路口不算尽头
    const legit = (id: string) => /^MAP_/.test(id) || id === 'PORT' || id === 'AIR' || id === 'BAKERY' || id.endsWith(':gate') || STORES.some((st) => st.node === id);
    const ends = [...this.junctions.values()].filter((j) => degree.get(j.id) === 1 && !legit(j.id));
    if (!ends.length) return;
    // 陆地（海岸线朝陆地一侧）、设施的核心区（港口的闸口、堆场和码头，机场的货站、机坪和跑道，整个物流园）、门店周围 200 米：连接线不能进去
    const sd = plan.seaDir;
    const c0 = plan.coast[0] as Km;
    const c1 = plan.coast[plan.coast.length - 1] as Km;
    const land = [...plan.coast, { x: c1.x - sd.x * 160, y: c1.y - sd.y * 160 }, { x: c0.x - sd.x * 160, y: c0.y - sd.y * 160 }].map((k) => ({ x: k.x * S, z: -k.y * S }));
    const foot = ([
      [FRAMES.port, { ...LOCAL.port.rect, z0: 1150 }],
      [FRAMES.airport, { ...LOCAL.airport.rect, z0: 950 }],
      [FRAMES.park, LOCAL.park.rect],
    ] as const).map(([f, r]) => footprintKm(f, r).map((k) => ({ x: k.x * S, z: -k.y * S })));
    const stores = STORES.map((st) => P(st.km));
    const blocked = (p: V3) => !pointInPoly(p.x, p.z, land) || foot.some((f) => pointInPoly(p.x, p.z, f)) || stores.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 200);
    const rail = RAIL.map(P);
    const river = REGION.plan?.river?.pts.map(P) ?? [];
    const crosses = (pts: readonly V3[], other: readonly V3[]) => {
      let n = 0;
      for (let i = 1; i < pts.length; i++) for (let k = 1; k < other.length; k++) if (segIntersect(pts[i - 1] as V3, pts[i] as V3, other[k - 1] as V3, other[k] as V3)) n++;
      return n;
    };
    const unit2 = (x: number, z: number) => {
      const l = Math.hypot(x, z) || 1;
      return { x: x / l, z: z / l };
    };
    for (const D of ends) {
      const own = this.lines.find((l) => l.ja === D.id || l.jb === D.id) as Line;
      const atB = own.jb === D.id;
      const inner = sampleAt(own.pts, own.cum, atB ? Math.max(0, own.len - 25) : Math.min(own.len, 25)).p;
      const out = unit2(D.pos.x - inner.x, D.pos.z - inner.z);
      const other = atB ? own.ja : own.jb;
      // 候选：城区路口、别的干道上的点（垂直接上去）
      const cands: { pos: V3; dIn: { x: number; z: number }; j?: string; host?: Line; s?: number }[] = [];
      for (const J of this.junctions.values()) {
        if (J === D || J.id === other || J.kind !== 'grade' || J.tag === 'terminal') continue;
        const d = Math.hypot(J.pos.x - D.pos.x, J.pos.z - D.pos.z);
        if (d < 120 || d > 1600) continue;
        cands.push({ pos: J.pos, dIn: unit2(J.pos.x - D.pos.x, J.pos.z - D.pos.z), j: J.id });
      }
      for (const L of this.lines) {
        if (L === own || L.cls !== 'arterial') continue;
        let best = { d: Infinity, s: 0 };
        for (let i = 0; i < L.pts.length; i++) {
          const q = L.pts[i] as V3;
          const d = Math.hypot(q.x - D.pos.x, q.z - D.pos.z);
          if (d < best.d) best = { d, s: L.cum[i] as number };
        }
        if (best.d < 120 || best.d > 1600 || best.s < 80 || best.s > L.len - 80 || L.mids.some((m) => Math.abs(m.s - best.s) < 80)) continue;
        const q = sampleAt(L.pts, L.cum, best.s);
        // 垂直接上去：从 D 那一侧接近
        let n = { x: -q.dz, z: q.dx };
        if ((D.pos.x - q.p.x) * n.x + (D.pos.z - q.p.z) * n.z > 0) n = { x: -n.x, z: -n.z };
        cands.push({ pos: q.p.clone().setY(0), dIn: n, host: L, s: best.s });
      }
      let pick: { pts: V3[]; c: (typeof cands)[number]; score: number } | undefined;
      for (const c of cands) {
        // 先顺着原来的方向出去再拐过去；顺着走会下海、撞上别的路时，换成更直的走法
        for (const k of [0.35, 0.15, 0]) {
          const a = D.pos.clone().setY(0);
          const b = c.pos.clone().setY(0);
          const pts = k > 0 ? bezier(a, out, b, c.dIn, k, 18) : resample([a, b], 12);
          const cum = cumulative(pts);
          const len = cum[cum.length - 1] as number;
          // 两头 30 米以内是路口里，不查相交
          const mid = pts.filter((_, i) => (cum[i] as number) > 30 && (cum[i] as number) < len - 30);
          // 尽头本身可能就贴着海岸线、设施：离尽头 120 米以内不查
          if (mid.length < 2 || mid.some((p) => Math.hypot(p.x - D.pos.x, p.z - D.pos.z) > 120 && blocked(p))) continue;
          if (this.lines.some((l) => crosses(mid, l.pts) > 0)) continue;
          if ([...this.junctions.values()].some((J) => J !== D && J.id !== c.j && pts.some((p) => Math.hypot(p.x - J.pos.x, p.z - J.pos.z) < 45))) continue;
          const nRail = crosses(pts, rail);
          const nRiver = crosses(pts, river);
          if (nRail > 1 || nRiver > 1) continue;
          const ang = Math.acos(Math.max(-1, Math.min(1, out.x * c.dIn.x + out.z * c.dIn.z)));
          const score = len + ang * 380 + nRail * 160 + nRiver * 260 + (c.host ? 70 : 0) + (k === 0 ? 120 : k < 0.3 ? 40 : 0);
          if (!pick || score < pick.score) pick = { pts, c, score };
          break;
        }
      }
      if (!pick) {
        // 接不上：尽头做回车场
        D.kind = 'end';
        D.signal = false;
        D.bulb = true;
        continue;
      }
      const c = pick.c;
      const to = c.host && c.s !== undefined ? this.addMid(c.host, c.s, `${D.id}~t`, 'mid', false) : (c.j as string);
      D.kind = 'grade';
      this.addLine('arterial', pick.pts, D.id, to, { name: '城市干道' });
    }
  }

  /** 仿真的边 a→b 对应的行程；同时存反方向 */
  mapEdge(a: string, b: string, arcs: Arc[]): void {
    this.edgeArcs.set(`${a}|${b}`, arcs);
    this.edgeArcs.set(
      `${b}|${a}`,
      [...arcs].reverse().map((x) => ({ line: x.line, s0: x.s1, s1: x.s0, ja: x.jb, jb: x.ja })),
    );
  }

  /** 一条线和一条折线（铁路、河）的交点（沿线的 s） */
  private hits(line: Line, other: readonly V3[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < line.pts.length; i++)
      for (let k = 1; k < other.length; k++) {
        const hit = segIntersect(line.pts[i - 1] as V3, line.pts[i] as V3, other[k - 1] as V3, other[k] as V3);
        if (hit) out.push((line.cum[i - 1] as number) + hit.t * ((line.cum[i] as number) - (line.cum[i - 1] as number)));
      }
    return out;
  }

  /** 跨铁路：高速、快速路、干道和桥下的路在交点上桥（本地道路、街道是平交道口，见 roadmesh） */
  private railCrossings(): void {
    const rail = RAIL.map(P);
    for (const line of this.lines) {
      if (line.cls !== 'highway' && line.cls !== 'ring' && line.cls !== 'arterial' && line.cls !== 'under') continue;
      for (const s of this.hits(line, rail)) {
        // 太靠近线的两头（路口里）上不了桥：退到离路口 130 米以外的那一段才起坡
        const room = Math.min(s, line.len - s);
        if (room < 60) continue;
        const ramp = Math.min(125, room - 8);
        const flat = Math.min(22, ramp - 30);
        if (flat < 6) continue;
        const prev = line.elev;
        line.elev = (x) => Math.max(prev(x), bump(x - s, 7.5, flat, ramp));
        line.bridges.push({ s0: s - ramp, s1: s + ramp });
      }
    }
  }

  /** 过河：所有路在过河处做成桥（河面中间平、两头接坡），高架本来就在空中 */
  private riverCrossings(): void {
    const river = REGION.plan?.river;
    if (!river) return;
    // 干流和支流（随机区域的支流比干流窄）
    for (const [pts, half] of [[river.pts.map(P), (river.width * S) / 2] as const, ...(river.branches ?? []).map((b) => [b.map(P), ((river.branchWidth ?? river.width) * S) / 2] as const)])
    for (const line of this.lines) {
      if (line.cls === 'elevated') continue;
      for (const s of this.hits(line, pts)) {
        const flat = half + 12;
        const room = Math.min(s, line.len - s);
        const ramp = Math.min(flat + 90, Math.max(flat + 20, room - 6));
        const h = line.cls === 'highway' || line.cls === 'ring' ? 6 : 4.5;
        const prev = line.elev;
        line.elev = (x) => Math.max(prev(x), bump(x - s, h, flat, ramp));
        line.bridges.push({ s0: s - ramp, s1: s + ramp });
      }
    }
  }

  /**
   * 进店路接在哪里：接立交节点的店接到靠近门店一侧的匝道口；接环岛的店是环岛的一条腿；
   * 接中间节点的店，如果和某条干道夹角太小，就在那条干道上离路口约 95 米处开一个 T 形路口。
   */
  private storeAttachPoints(): void {
    for (const st of STORES) {
      const sp = P(st.km);
      if (this.icIds.has(st.node)) {
        const ic = this.ics.get(st.node) as NonNullable<ReturnType<typeof this.ics.get>>;
        const R = this.nodeP(st.node);
        const inside = (sp.x - R.x) * ic.n.x + (sp.z - R.z) * ic.n.z < 0;
        const jid = inside ? ic.tin : ic.tout;
        const pos = (this.junctions.get(jid) as Junction).pos;
        const l = Math.hypot(sp.x - pos.x, sp.z - pos.z) || 1;
        this.storeAttach.set(st.key, { pos: pos.clone(), dir: { x: (sp.x - pos.x) / l, z: (sp.z - pos.z) / l }, junction: jid });
        continue;
      }
      const np = this.nodeP(st.node);
      const l = Math.hypot(sp.x - np.x, sp.z - np.z) || 1;
      const dir = { x: (sp.x - np.x) / l, z: (sp.z - np.z) / l };
      if (this.junctions.get(st.node)?.kind === 'roundabout') {
        this.storeAttach.set(st.key, { pos: np.clone(), dir, junction: st.node });
        continue;
      }
      // 中间节点：找夹角最小的干道
      const ang = mapAngle(dir.x, dir.z);
      let best: { line: Line; s: number; gap: number; fromA: boolean } | undefined;
      for (const line of this.lines) {
        if (line.cls !== 'arterial') continue;
        const fromA = line.ja === st.node;
        const fromB = line.jb === st.node;
        if (!fromA && !fromB) continue;
        const q = sampleAt(line.pts, line.cum, fromA ? 15 : line.len - 15);
        const la = fromA ? mapAngle(q.dx, q.dz) : mapAngle(-q.dx, -q.dz);
        let gap = Math.abs(la - ang);
        if (gap > Math.PI) gap = 2 * Math.PI - gap;
        if (!best || gap < best.gap) best = { line, s: fromA ? 95 : line.len - 95, gap, fromA };
      }
      if (best && best.gap < (32 * Math.PI) / 180) {
        const jid = this.addMid(best.line, best.s, `${st.key}:t`, 'mid', true);
        const pos = (this.junctions.get(jid) as Junction).pos;
        const l2 = Math.hypot(sp.x - pos.x, sp.z - pos.z) || 1;
        this.storeAttach.set(st.key, { pos: pos.clone(), dir: { x: (sp.x - pos.x) / l2, z: (sp.z - pos.z) / l2 }, junction: jid, viaLine: best.line.id, viaS: best.s });
      } else this.storeAttach.set(st.key, { pos: np.clone(), dir, junction: st.node });
    }
  }

  /** 门店的站点确定以后（stores 模块），铺进店路：接入点 → 门店入口 */
  addStoreRoad(st: StoreSite, entrance: V3, entranceDir: { x: number; z: number }): Line {
    const at = this.storeAttach.get(st.key) as NonNullable<ReturnType<typeof this.storeAttach.get>>;
    const ej = this.junction(`${st.key}:gate`, entrance, 'end');
    void ej;
    // 最后 25 米垂直进入停车场
    const pre = v3(entrance.x - entranceDir.x * 25, 0, entrance.z - entranceDir.z * 25);
    const start = at.pos.clone();
    const line = this.addLine('local', fillet([start, pre, entrance.clone()], 30, 6), at.junction, `${st.key}:gate`, { name: `${st.name}进店路` });
    const arcs: Arc[] = [];
    if (at.viaLine !== undefined && at.viaS !== undefined) {
      // 先沿干道从节点开到 T 形路口
      const host = this.lines[at.viaLine] as Line;
      const fromA = host.ja === st.node;
      arcs.push({ line: host.id, s0: fromA ? 0 : host.len, s1: at.viaS, ja: st.node, jb: at.junction });
    }
    arcs.push({ line: line.id, s0: 0, s1: line.len, ja: at.junction, jb: `${st.key}:gate` });
    this.mapEdge(st.node, st.key, arcs);
    return line;
  }

  // ———————————————————————— 收尾：路口的腿、退让距离、信号相位 ————————————————————————

  finalize(): void {
    for (const j of this.junctions.values()) j.legs = [];
    for (const line of this.lines) {
      for (const end of ['a', 'b'] as const) {
        const jid = end === 'a' ? line.ja : line.jb;
        if (!jid) continue;
        const j = this.junctions.get(jid);
        if (!j) continue;
        const q = sampleAt(line.pts, line.cum, end === 'a' ? Math.min(12, line.len / 2) : Math.max(0, line.len - 12));
        const p0 = end === 'a' ? (line.pts[0] as V3) : (line.pts[line.pts.length - 1] as V3);
        const ang = mapAngle(q.p.x - p0.x, q.p.z - p0.z);
        j.legs.push({ line: line.id, end, ang, hw: halfRoad(line.xs), hwAll: halfAll(line.xs) });
      }
    }
    for (const j of this.junctions.values()) {
      j.legs.sort((a, b) => a.ang - b.ang);
      // 只有两条腿的路口是路的转折点：不设信号灯
      if (j.kind === 'grade' && j.legs.length < 3) j.signal = false;
      this.trims(j);
      this.phases(j);
    }
    // mid 节点：侧路退到主路边缘
    for (const j of this.junctions.values()) {
      if (j.kind !== 'mid' && j.kind !== 'merge') continue;
      const host = this.lines[j.host as number] as Line;
      for (const leg of j.legs) {
        const line = this.lines[leg.line] as Line;
        const t = j.kind === 'merge' ? 0 : halfRoad(host.xs) - 0.5;
        if (leg.end === 'a') line.trimA = t;
        else line.trimB = t;
      }
    }
  }

  /** 普通路口：每条腿退到不和相邻的腿重叠的距离 */
  private trims(j: Junction): void {
    if (j.kind === 'mid' || j.kind === 'merge') return;
    const n = j.legs.length;
    for (let i = 0; i < n; i++) {
      const leg = j.legs[i] as Leg;
      let t = leg.hw + 2;
      if (j.kind === 'roundabout') t = (j.radius as number) + 9;
      else if (j.kind === 'end') t = 0;
      else
        for (const k of [i - 1, i + 1]) {
          if (n < 2) break;
          const o = j.legs[(k + n) % n] as Leg;
          let gap = Math.abs(o.ang - leg.ang);
          if (gap > Math.PI) gap = 2 * Math.PI - gap;
          const need = (leg.hwAll + o.hwAll) / (2 * Math.max(0.2, Math.sin(Math.min(Math.PI / 2, gap) / 2))) * 0.9 + 2;
          t = Math.max(t, Math.min(need, 70));
        }
      const line = this.lines[leg.line] as Line;
      if (leg.end === 'a') line.trimA = t;
      else line.trimB = t;
    }
  }

  /** 信号相位：最接近对向的一对腿和它们附近的腿是相位 0，其余是相位 1 */
  private phases(j: Junction): void {
    if (!j.signal || j.legs.length < 3) return;
    let bestPair: [Leg, Leg] | undefined;
    let bestDev = Infinity;
    for (const a of j.legs)
      for (const b of j.legs) {
        if (a === b) continue;
        const d = Math.abs(Math.abs(a.ang - b.ang) - Math.PI);
        if (d < bestDev) {
          bestDev = d;
          bestPair = [a, b];
        }
      }
    const axis = bestPair ? bestPair[0].ang : 0;
    for (const leg of j.legs) {
      let d = Math.abs(leg.ang - axis) % Math.PI;
      if (d > Math.PI / 2) d = Math.PI - d;
      j.phase.set(leg.line * 2 + (leg.end === 'a' ? 0 : 1), d < Math.PI / 4 ? 0 : 1);
    }
    let h = 0;
    for (const c of j.id) h = (h * 31 + c.charCodeAt(0)) % 9973;
    j.offset = h % 80;
  }

  // ———————————————————————— 路径：节点序列 → 三维折线 ————————————————————————

  /** 车道折线：在线 line 上从 s0 到 s1，第 lane 条车道（0 = 最右） */
  lanePath(line: Line, s0: number, s1: number, lane: number): V3[] {
    const fwd = s1 >= s0;
    let pts: V3[];
    if (line.closed && (s0 > line.len || s1 > line.len || s0 < 0 || s1 < 0)) {
      // 环线跨过起点：分两段取
      const L = line.len;
      const a = fwd ? s0 : s1;
      const b = fwd ? s1 : s0;
      const parts: V3[] = [];
      const pushRange = (x0: number, x1: number) => {
        for (const p of slice(line.pts, line.cum, x0, x1)) parts.push(p);
      };
      const wa = ((a % L) + L) % L;
      const wb = ((b % L) + L) % L;
      if (wb < wa) {
        pushRange(wa, L);
        pushRange(0, wb);
      } else pushRange(wa, wb);
      pts = parts;
      // 高度
      let acc = wa;
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) acc += Math.hypot((pts[i] as V3).x - (pts[i - 1] as V3).x, (pts[i] as V3).z - (pts[i - 1] as V3).z);
        (pts[i] as V3).y = line.elev(((acc % L) + L) % L);
      }
      if (!fwd) pts = reverse(pts);
    } else {
      const a = Math.min(s0, s1);
      const b = Math.max(s0, s1);
      pts = slice(line.pts, line.cum, a, b);
      let acc = a;
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) acc += Math.hypot((pts[i] as V3).x - (pts[i - 1] as V3).x, (pts[i] as V3).z - (pts[i - 1] as V3).z);
        (pts[i] as V3).y = line.elev(acc);
      }
      if (!fwd) pts = reverse(pts);
    }
    return offset(pts, laneOffset(line.xs, lane));
  }

  /** 行程在路口处退让多少：普通路口用线的 trim；mid 路口直行不退、转弯退侧路半宽 */
  private cut(arc: Arc, atEnd: boolean, turning: boolean): number {
    const line = this.lines[arc.line] as Line;
    const jid = atEnd ? arc.jb : arc.ja;
    const j = this.junctions.get(jid);
    if (!j) return 0;
    if ((j.kind === 'mid' || j.kind === 'merge') && j.host === line.id) {
      if (!turning) return 0;
      const side = j.legs[0];
      return side ? (j.kind === 'merge' ? 24 : side.hwAll + 3) : 0;
    }
    return jid === line.ja ? line.trimA : jid === line.jb ? line.trimB : 0;
  }

  /**
   * 把一串有向行程连成三维路径：每段沿车道走，段与段之间在路口按转弯曲线（环岛绕圈）连接。
   * 返回点和每个点的速度系数（仿真车按它分配时间）。
   */
  realize(arcs: readonly Arc[], laneOf: (line: Line, i: number) => number): { pts: V3[]; pace: number[] } {
    const pts: V3[] = [];
    const pace: number[] = [];
    const push = (list: readonly V3[], p: number) => {
      for (const q of list) {
        const last = pts[pts.length - 1];
        if (last && Math.hypot(q.x - last.x, q.z - last.z) < 0.3) continue;
        pts.push(q);
        pace.push(p);
      }
    };
    for (let i = 0; i < arcs.length; i++) {
      const arc = arcs[i] as Arc;
      const line = this.lines[arc.line] as Line;
      const prev = arcs[i - 1];
      const next = arcs[i + 1];
      const through = (a: Arc | undefined, b: Arc | undefined) => !!a && !!b && a.line === b.line && Math.sign(a.s1 - a.s0) === Math.sign(b.s1 - b.s0);
      const turnIn = !!prev && !through(prev, arc);
      const turnOut = !!next && !through(arc, next);
      const fwd = arc.s1 >= arc.s0;
      const cIn = prev ? this.cut(arc, false, turnIn) : 0;
      const cOut = next ? this.cut(arc, true, turnOut) : 0;
      const len = Math.abs(arc.s1 - arc.s0);
      if (len - cIn - cOut < 1) continue;
      const a = arc.s0 + (fwd ? cIn : -cIn);
      const b = arc.s1 - (fwd ? cOut : -cOut);
      const lane = laneOf(line, i);
      const lp = this.lanePath(line, a, b, lane);
      // 转弯：从上一段的末端接过来
      if (turnIn && pts.length) {
        const from = pts[pts.length - 1] as V3;
        const fromPrev = pts[pts.length - 2] ?? from;
        const d0l = Math.hypot(from.x - fromPrev.x, from.z - fromPrev.z) || 1;
        const d0 = { x: (from.x - fromPrev.x) / d0l, z: (from.z - fromPrev.z) / d0l };
        const to = lp[0] as V3;
        const to2 = lp[1] ?? to;
        const d1l = Math.hypot(to2.x - to.x, to2.z - to.z) || 1;
        const d1 = { x: (to2.x - to.x) / d1l, z: (to2.z - to.z) / d1l };
        const j = this.junctions.get(arc.ja);
        if (j && j.kind === 'roundabout') push(this.roundaboutPath(j, from, d0, to, d1), 0.3);
        else push(bezier(from, d0, to, d1, 0.45).slice(1, -1), 0.35);
      }
      push(lp, PACE[line.cls]);
    }
    return { pts, pace };
  }

  /** 环岛：切进外圈车道，逆时针（从上往下看）绕到出口，再切出去 */
  roundaboutPath(j: Junction, from: V3, d0: { x: number; z: number }, to: V3, d1: { x: number; z: number }): V3[] {
    const R = (j.radius as number) + 2;
    const c = j.pos;
    const angOf = (p: V3) => mapAngle(p.x - c.x, p.z - c.z);
    let a0 = angOf(from) + 0.12;
    let a1 = angOf(to) - 0.12;
    while (a1 <= a0) a1 += 2 * Math.PI;
    if (a1 - a0 > 2 * Math.PI - 0.1) a1 -= 2 * Math.PI;
    const at = (a: number) => v3(c.x + Math.cos(a) * R, from.y, c.z - Math.sin(a) * R);
    const tan = (a: number) => ({ x: -Math.sin(a), z: -Math.cos(a) });
    const out: V3[] = [];
    const entry = at(a0);
    out.push(...bezier(from, d0, entry, tan(a0), 0.5, 8).slice(1));
    const steps = Math.max(2, Math.ceil(((a1 - a0) * R) / 6));
    for (let k = 1; k < steps; k++) out.push(at(a0 + ((a1 - a0) * k) / steps));
    const exit = at(a1);
    out.push(exit);
    out.push(...bezier(exit, tan(a1), to, d1, 0.5, 8).slice(1, -1));
    return out;
  }

  /** 立交里的转向：根据进来和出去的边，返回中间要走的匝道 / 桥下路 / 桥 */
  private icMovement(rid: string, from: string, to: string): Arc[] {
    const ic = this.ics.get(rid) as NonNullable<ReturnType<typeof this.ics.get>>;
    const k = this.chain.indexOf(rid);
    const prevR = this.chain[k - 1] as string;
    const nextR = this.chain[k + 1] as string;
    const ring = this.lines[ic.ring] as Line;
    const zbmS = (this.junctions.get(ic.zbm) as Junction).s as number;
    const zbpS = (this.junctions.get(ic.zbp) as Junction).s as number;
    const under = this.lines[ic.under] as Line;
    const full = (id: number, rev = false): Arc => {
      const l = this.lines[id] as Line;
      return rev ? { line: id, s0: l.len, s1: 0, ja: l.jb, jb: l.ja } : { line: id, s0: 0, s1: l.len, ja: l.ja, jb: l.jb };
    };
    const sideOf = (node: string): 'in' | 'out' => {
      if (node === this.gateway(rid)) return 'in';
      const st = STORES.find((x) => x.key === node);
      if (st) return (this.storeAttach.get(st.key) as { junction: string }).junction === ic.tin ? 'in' : 'out';
      return 'out';
    };
    const uIn2Out = full(under.id);
    const uOut2In = full(under.id, true);
    if (from === prevR && to === nextR) return [{ line: ring.id, s0: zbmS, s1: zbpS, ja: ic.zbm, jb: ic.zbp }];
    if (from === nextR && to === prevR) return [{ line: ring.id, s0: zbpS, s1: zbmS, ja: ic.zbp, jb: ic.zbm }];
    if (from === prevR) {
      // 逆时针：走外侧出口
      const side = sideOf(to);
      return side === 'out' ? [full(ic.ramps.ccwOff)] : [full(ic.ramps.ccwOff), uOut2In];
    }
    if (from === nextR) {
      const side = sideOf(to);
      return side === 'in' ? [full(ic.ramps.cwOff)] : [full(ic.ramps.cwOff), uIn2Out];
    }
    const fs = sideOf(from);
    if (to === nextR) return fs === 'out' ? [full(ic.ramps.ccwOn)] : [uIn2Out, full(ic.ramps.ccwOn)];
    if (to === prevR) return fs === 'in' ? [full(ic.ramps.cwOn)] : [uOut2In, full(ic.ramps.cwOn)];
    const ts = sideOf(to);
    if (fs === ts) return [];
    return [fs === 'in' ? uIn2Out : uOut2In];
  }

  /** 仿真的节点序列 → 行程序列（含立交里的匝道） */
  routeArcs(nodes: readonly string[]): Arc[] {
    const out: Arc[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i] as string;
      const b = nodes[i + 1] as string;
      if (i > 0 && this.icIds.has(a)) out.push(...this.icMovement(a, nodes[i - 1] as string, b));
      const arcs = this.edgeArcs.get(`${a}|${b}`);
      if (arcs) out.push(...arcs);
    }
    // 从立交节点出发 / 到立交节点结束的路线（很少见）：不处理立交，直接接上
    return out;
  }
}

export { ROUNDABOUT_R };
