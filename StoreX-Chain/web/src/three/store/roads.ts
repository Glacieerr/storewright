import * as THREE from 'three';
import { planPath, type CarModel, type CarPlan, type LotPart, type LotTraffic } from '../../../../src/site/motion';
import type { Stay } from '../../../../src/site/stays';
import { makeTrack, roadSpans, stopLines, type RoadRun, type RoadSpan } from '../motion';
import type { Arc, Line, RoadNet } from '../roadnet';
import { toLocal, toWorld, type Site } from '../stores';
import { TimedPath, type PathState, type Pt } from '@storewright/yard';

/**
 * 综合店的车在停车场外面的那一段：从干道上游开过来、过干道路口进进店路，出去的时候反过来（干道上各开 320 米）。
 * 画面（cars.ts）和社会车流都按这里的路线和速度曲线：一条腿上的车走同一条路，只是出发的时刻不同。
 * 每辆车在干道、进店路上的行驶打包成 RoadRun 交给社会车流的后台线程（和区域的仿真车一样当成占着车道、不会让人的车），
 * 背景车跟在后面、在它前面进车道的要一路开在它前面；过路口的时刻按两边共用的信号配时（signals.ts）。
 */

/** 道路网上的车速：路网的速度系数换成米 / 秒（和背景车流一样，沙盘里的路是压缩的） */
const PACE_TO_V = 2.6;
/** 停车场外最慢的车速（米 / 秒）：进店路按小路算太慢，过路口、开进进店路的那一截会一直占着路口 */
const MIN_V = 1.2;
/** 干道上远处那头离路口（停止线）留多少米：车在路口前排队的地方；进来的车在远处路口出口以后多远冒出来（不在路口里） */
const FAR_ROOM = 90;
const FAR_IN = 12;

export interface StoreLeg {
  arcIn: Arc;
  arcOut: Arc;
  line: Line;
}

/** 停车场外的一段路线（世界坐标）：速度曲线、拼路径的点、走过的道路弧 */
export interface RoadLeg {
  path: TimedPath;
  pts: Pt[];
  arcs: Arc[];
}

/** 一辆车走哪条腿（进来、出去各按随机数挑） */
export function legOf(seed: number, k: number, n: number): number {
  const x = Math.sin(seed * 9301 + k * 49297) * 233280;
  return Math.min(n - 1, Math.floor((x - Math.floor(x)) * n));
}

/** 进店路接在干道上的路口：车从哪几条腿来、往哪几条腿去（干道上各开 320 米；出去的路短的开到远处路口前 90 米） */
export function storeLegs(site: Site, net: RoadNet): StoreLeg[] {
  const legs: StoreLeg[] = [];
  const at = net.storeAttach.get(site.st.key);
  if (!at) return legs;
  const access = net.lines[site.access.line] as Line;
  if (at.viaLine !== undefined && at.viaS !== undefined) {
    const host = net.lines[at.viaLine] as Line;
    const sv = at.viaS;
    for (const [far, k] of [[Math.min(host.len - host.trimB - FAR_IN, sv + 320), 1], [Math.max(host.trimA + FAR_IN, sv - 320), -1]] as const) {
      if ((far - sv) * k < 40) continue;
      const id = k > 0 ? host.jb : host.ja;
      // 出去的车在远处的路口前排队的地方以前消失（不开进别的路口的车队里）
      const end = k > 0 ? Math.max(sv + 40, Math.min(far, host.len - host.trimB - FAR_ROOM)) : Math.min(sv - 40, Math.max(far, host.trimA + FAR_ROOM));
      legs.push({ line: host, arcIn: { line: host.id, s0: far, s1: sv, ja: id, jb: at.junction }, arcOut: { line: host.id, s0: sv, s1: end, ja: at.junction, jb: id } });
    }
  } else {
    for (const leg of net.junctions.get(at.junction)?.legs ?? []) {
      if (leg.line === access.id) continue;
      const line = net.lines[leg.line] as Line;
      if (line.cls === 'service' || line.cls === 'street') continue;
      const atA = leg.end === 'a';
      const far = atA ? Math.min(line.len - line.trimB - FAR_IN, 320) : Math.max(line.trimA + FAR_IN, line.len - 320);
      // 出去的车在远处的路口前排队的地方以前消失（不开进别的路口的车队里）
      const d = Math.max(Math.min(320, line.len - (atA ? line.trimB : line.trimA) - FAR_ROOM), Math.min(60, line.len));
      const end = atA ? d : line.len - d;
      const id = atA ? line.jb : line.ja;
      legs.push({ line, arcIn: { line: line.id, s0: far, s1: atA ? 0 : line.len, ja: id, jb: at.junction }, arcOut: { line: line.id, s0: atA ? 0 : line.len, s1: end, ja: at.junction, jb: id } });
    }
  }
  return legs;
}

const wPt = (site: Site, x: number, z: number): Pt => {
  const w = toWorld(site, x, z);
  return { x: w.x, z: w.z };
};

/**
 * 进来的车在干道上走最里面那条车道（在那里排队、左转进进店路；社会车流里背景车和公交车不进这条车道，见 traffic.ts 的
 * storeLeftLegs）；出去的照常右转进最外面那条
 */
const inner = (line: Line) => Math.max(0, line.xs.lanes - 1);

/** 车头到车尾（拖车的车尾）多长、车头在车身中点前面多远 */
const bodyOf = (m: CarModel) => ({ len: m.len / 2 + (m.trailer ? m.trailer.hitch + m.trailer.len : m.len / 2), front: m.len / 2 });

/** 速度曲线：时刻、路径上的位置、速度（两点之间匀加速） */
interface Prof {
  t: number[];
  u: number[];
  v: number[];
}

export class StoreRoads {
  readonly legs: StoreLeg[];
  private readonly cache = new Map<string, RoadLeg | null>();
  private readonly spanCache = new Map<string, RoadSpan[]>();
  private readonly st: PathState = { x: 0, z: 0, heading: 0 };

  constructor(
    readonly site: Site,
    readonly net: RoadNet,
    /** 进店路在停车场模型里的两头：干道路口后面的起点、出去的停止线（本地 z） */
    readonly zIn: number,
    readonly zStop: number,
  ) {
    this.legs = storeLegs(site, net);
  }

  /** 出去的车走的腿（只走 outLegs 里的，见那里） */
  outLeg(seed: number): StoreLeg | undefined {
    const k = this.outK(seed);
    return k === undefined ? undefined : this.legs[k];
  }

  /** 进来的车走的腿（只走 inLegs 里的，见那里） */
  inLeg(seed: number): StoreLeg | undefined {
    const k = this.inK(seed);
    return k === undefined ? undefined : this.legs[k];
  }

  /** 进来的那段：从干道上游开到进店路起点 */
  up(seed: number): RoadLeg | undefined {
    const k = this.inK(seed);
    return k === undefined ? undefined : this.upLeg(k);
  }

  private inK(seed: number): number | undefined {
    const ks = this.inLegs();
    return ks.length ? ks[legOf(seed, 1, ks.length)] : undefined;
  }

  /**
   * 进来的车只从一个方向来（左转进进店路的那条腿；没有就都走）：两个方向都来的话，左转进来的车（不会让人）在路口里
   * 挡着对面直行的背景车，它们停在停止线前，后面右转进来的车照定好的轨迹开过来就撞上；只从一个方向来，停在那里等的背景车
   * 后面没有门店的车
   */
  private inLegs(): number[] {
    if (this.inSel) return this.inSel;
    const all = this.legs.map((_, k) => k);
    const left = all.filter((k) => {
      const L = this.upLeg(k);
      if (!L || L.pts.length < 3) return false;
      const light = stopLines(this.net, L.arcs, 0, this.track(L.pts), 0)[0];
      const p = L.path;
      const at = (d: number) => {
        let i = 1;
        while (i < p.cumD.length - 1 && (p.cumD[i] as number) < d) i++;
        const a = p.pts[i - 1] as Pt;
        const b = p.pts[i] as Pt;
        return { x: b.x - a.x, z: b.z - a.z };
      };
      const a = at((light?.s ?? p.length - 40) - 12);
      const b = at(p.length - 0.5);
      // 车流的转弯方向：叉积不小于 0 是右转（traffic.ts 的 turnOf 一样）
      return a.x * b.z - a.z * b.x < 0;
    });
    this.inSel = left.length && left.length < all.length ? left : all;
    return this.inSel;
  }
  private inSel: number[] | undefined;

  private upLeg(k: number): RoadLeg | undefined {
    return this.leg(`up${k}`, () => {
      const { site, net } = this;
      const leg = this.legs[k] as StoreLeg;
      const access = net.lines[site.access.line] as Line;
      const arcs: Arc[] = [leg.arcIn, { line: access.id, s0: 0, s1: access.len, ja: leg.arcIn.jb, jb: `${site.st.key}:gate` }];
      const r = this.realize(arcs, (line, n) => (n === 0 ? inner(line) : 0));
      const i = r.pts.findIndex((q) => toLocal(site, q.x, q.z).z < this.zIn);
      const pts = [...r.pts.slice(0, i < 0 ? r.pts.length : i), wPt(site, 1.75, this.zIn)];
      return { path: new TimedPath(pts, (_a, b) => r.speed.get(b) ?? 1.2, false, { accel: 2, decel: 2.8, v0: 'cap', v1: 'cap' }), pts, arcs };
    });
  }

  /** 出去的那段：从进店路的停止线开出去（只往右转出去的那条腿，见 outLegs） */
  down(seed: number): RoadLeg | undefined {
    const k = this.outK(seed);
    return k === undefined ? undefined : this.downLeg(k);
  }

  private outK(seed: number): number | undefined {
    const ks = this.outLegs();
    return ks.length ? ks[legOf(seed, 2, ks.length)] : undefined;
  }

  /**
   * 出去的车只往右转出去（没有就都走）：左转出去的车并进对面直行过来的那条车道，那些背景车要在进来的车走的那条车道的停止线前
   * 等它（被它挡着进不了车道），后面左转进来的门店的车照定好的轨迹开过来就撞上；右转出去并进的是另一个方向直行过来的车道，
   * 在那里等的背景车后面没有门店的车
   */
  private outLegs(): number[] {
    if (this.outSel) return this.outSel;
    const all = this.legs.map((_, k) => k);
    const right = all.filter((k) => {
      const L = this.downLeg(k);
      if (!L || L.pts.length < 3) return false;
      const p = L.path;
      const at = (d: number) => {
        let i = 1;
        while (i < p.cumD.length - 1 && (p.cumD[i] as number) < d) i++;
        const a = p.pts[i - 1] as Pt;
        const b = p.pts[i] as Pt;
        return { x: b.x - a.x, z: b.z - a.z };
      };
      const a = at(1);
      const b = at(Math.min(p.length - 1, 45));
      return a.x * b.z - a.z * b.x >= 0;
    });
    this.outSel = right.length && right.length < all.length ? right : all;
    return this.outSel;
  }
  private outSel: number[] | undefined;

  private downLeg(k: number): RoadLeg | undefined {
    return this.leg(`down${k}`, () => {
      const { site, net } = this;
      const leg = this.legs[k] as StoreLeg;
      const access = net.lines[site.access.line] as Line;
      const arcs: Arc[] = [{ line: access.id, s0: access.len, s1: 0, ja: `${site.st.key}:gate`, jb: leg.arcOut.ja }, leg.arcOut];
      const r = this.realize(arcs, () => 0);
      const j = r.pts.findIndex((q) => toLocal(site, q.x, q.z).z > this.zStop + 0.5);
      const pts = [wPt(site, -1.75, this.zStop), ...r.pts.slice(j < 0 ? r.pts.length : j)];
      return { path: new TimedPath(pts, (_a, b) => r.speed.get(b) ?? 1.2, false, { accel: 2, decel: 2.8, v0: 'cap', v1: 'cap' }), pts, arcs };
    });
  }

  /**
   * 进来的车车头过干道路口停止线的时刻比到进店路起点早多少秒（停车场的车流按它挑绿灯放进来的时刻，
   * 和社会车流用同一个信号配时）；没有信号灯按 3 秒
   */
  inLead(seed: number, m: CarModel): number {
    const up = this.up(seed);
    if (!up) return 3;
    const light = stopLines(this.net, up.arcs, inner(this.net.lines[(up.arcs[0] as Arc).line] as Line), this.track(up.pts), 0)[0];
    if (!light) return 3;
    const p = up.path;
    const s = Math.max(0, Math.min(p.length, light.s - bodyOf(m).front));
    let k = 1;
    while (k < p.cumD.length - 1 && (p.cumD[k] as number) < s) k++;
    const d0 = p.cumD[k - 1] as number;
    const f = Math.min(1, Math.max(0, (s - d0) / Math.max(1e-9, (p.cumD[k] as number) - d0)));
    const t = (p.cumT[k - 1] as number) + f * ((p.cumT[k] as number) - (p.cumT[k - 1] as number));
    return p.duration - t;
  }

  /**
   * 当天每辆车在干道和进店路上的两段行驶（进来：干道上游 → 进店路到停车场口；出去：出口车道 → 停止线 → 干道下游），
   * 交给社会车流：速度曲线的位置是车头在路径上的位置
   */
  runs(stays: readonly Stay[], lot: LotTraffic): RoadRun[] {
    const out: RoadRun[] = [];
    lot.plans.forEach((p, i) => {
      if (!p) return;
      const seed = stays[i]?.visit.seed ?? 0.5;
      const body = bodyOf(p.model);
      const a = this.inbound(p, seed);
      if (a) out.push(a.run(body));
      const b = this.outbound(p, seed);
      if (b) out.push(b.run(body));
    });
    return out;
  }

  /** 进来：干道上的那段接上进店路上的那段（停车场的车流排的，到停车场口） */
  private inbound(p: CarPlan, seed: number) {
    const up = this.up(seed);
    const acc = p.entry[0];
    if (!up || !acc || acc.kind !== 'move') return undefined;
    const end = acc.spec.pts[acc.spec.pts.length - 1] as Pt;
    const P: Prof = { t: [], u: [], v: [] };
    this.push(P, up.path, p.tIn - up.path.duration, 0);
    this.push(P, planPath(acc), acc.t0, up.path.length);
    const key = `in${this.inK(seed)}:${end.z.toFixed(2)}`;
    const spans = this.spans(key, () => [...up.pts, wPt(this.site, end.x, end.z)], up.arcs, [inner(this.net.lines[(up.arcs[0] as Arc).line] as Line), 0]);
    return { run: (b: { len: number; front: number }) => this.pack(P, b, spans) };
  }

  /** 出去：出口车道上的几段（排队、等绿灯）接上停止线以后的那段 */
  private outbound(p: CarPlan, seed: number) {
    const down = this.down(seed);
    if (!down || !p.exit.length) return undefined;
    // 出口车道上的几段在最后（停车场的车流排在 exit 的末尾：直接开出去，或者开到排队的位置、停着等、再开出去）
    const onLane = (q: LotPart) => (q.kind === 'hold' ? Math.abs(q.x + 1.75) < 1e-6 : q.spec.pts.every((x) => Math.abs(x.x + 1.75) < 1e-6));
    let k = p.exit.length;
    while (k > 0 && onLane(p.exit[k - 1] as LotPart)) k--;
    const parts = p.exit.slice(k);
    const first = parts[0];
    if (!first) return undefined;
    const z0 = first.kind === 'hold' ? first.z : (first.spec.pts[0] as Pt).z;
    const P: Prof = { t: [], u: [], v: [] };
    for (const q of parts) {
      if (q.kind === 'hold') {
        const u = Math.abs(q.z - z0);
        P.t.push(q.t0, q.t1);
        P.u.push(u, u);
        P.v.push(0, 0);
      } else this.push(P, planPath(q), q.t0, Math.abs((q.spec.pts[0] as Pt).z - z0));
    }
    this.push(P, down.path, p.tOut, Math.abs(this.zStop - z0));
    const key = `out${this.outK(seed)}:${z0.toFixed(2)}`;
    const spans = this.spans(key, () => [wPt(this.site, -1.75, z0), ...down.pts], down.arcs, [0, 0]);
    return { run: (b: { len: number; front: number }) => this.pack(P, b, spans) };
  }

  /** 一段速度曲线接在后面（路径上的位置从 u0 起） */
  private push(P: Prof, path: TimedPath, t0: number, u0: number): void {
    for (let k = 0; k < path.pts.length; k++) {
      path.at(path.cumT[k] as number, this.st);
      P.t.push(t0 + (path.cumT[k] as number));
      P.u.push(u0 + (path.cumD[k] as number));
      P.v.push(this.st.speed ?? 0);
    }
  }

  /** 去掉匀加速连着的中间点，位置挪到车头 */
  private pack(P: Prof, b: { len: number; front: number }, spans: RoadSpan[]): RoadRun {
    const n = P.t.length;
    const acc = (i: number) => ((P.v[i + 1] as number) - (P.v[i] as number)) / Math.max(1e-9, (P.t[i + 1] as number) - (P.t[i] as number));
    const keep = [0];
    for (let i = 1; i < n - 1; i++) if (Math.abs(acc(i) - acc(i - 1)) > 1e-6 || P.u[i] === P.u[i - 1] || P.u[i + 1] === P.u[i]) keep.push(i);
    keep.push(n - 1);
    return { len: b.len, tu: Float64Array.from(keep, (i) => P.t[i] as number), us: Float32Array.from(keep, (i) => (P.u[i] as number) + b.front), tv: Float32Array.from(keep, (i) => P.v[i] as number), spans };
  }

  /** 路线落在哪些道路弧上（一条腿上的车都一样，只算一次） */
  private spans(key: string, pts: () => Pt[], arcs: Arc[], lanes: number[]): RoadSpan[] {
    let s = this.spanCache.get(key);
    if (!s) {
      const tr = this.track(pts());
      s = arcs.flatMap((a, n) => roadSpans(this.net, [a], lanes[n] ?? 0, tr, 0));
      this.spanCache.set(key, s);
    }
    return s;
  }

  private track(pts: readonly Pt[]) {
    return makeTrack(pts.map((q) => new THREE.Vector3(q.x, 0, q.z)));
  }

  private leg(key: string, make: () => RoadLeg): RoadLeg | undefined {
    let r = this.cache.get(key);
    if (r === undefined) {
      try {
        r = make();
      } catch {
        r = null;
      }
      this.cache.set(key, r);
    }
    return r ?? undefined;
  }

  private realize(arcs: Arc[], laneOf: (line: Line, n: number) => number): { pts: Pt[]; speed: WeakMap<Pt, number> } {
    const r = this.net.realize(arcs, laneOf);
    const speed = new WeakMap<Pt, number>();
    const pts = r.pts.map((q, i) => {
      const o = { x: q.x, z: q.z };
      speed.set(o, Math.max(MIN_V, (r.pace[i] ?? 0.4) * PACE_TO_V));
      return o;
    });
    return { pts, speed };
  }
}
