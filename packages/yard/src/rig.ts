import type { BodyDims, Pt, RigPose, VehicleDims, YardVehicle } from './index';
import { angDiff, dirOf, Polyline, type OBB } from './geom';

export type { OBB };

/**
 * 车辆的尺寸和铰接运动学（第一部分 Storewright 决策记录 0013 的做法）：
 * - 前进：牵引销（≈ 牵引车后轴）沿路径走，挂车车轴按「追踪曲线」跟着走（车轴朝牵引销移动、保持轴距不变），
 *   等价于 dθ挂/ds = sin(θ牵 − θ挂) / L：转弯时挂车切内侧（内轮差），出弯后慢慢摆正；
 * - 倒车：挂车车轴沿规划好的路径退进门，挂车朝向就是这条路径的反方向，牵引销在挂车前方 L 处，
 *   牵引车朝向取牵引销运动方向的反方向（牵引车后轴的速度总是沿车身方向）；起步的几米从前进结束时的朝向平滑过渡；
 * - 拖车串（小汽车拖房车、机场牵引车拖 2–4 节板车）：每一节的挂点在前一节车轴后方 hitch 米处，同样按追踪曲线跟着。
 * 全部按路径上的距离预先算好（每 0.25 米一个点），按时间取时先由速度剖面换成距离，可以随意拖动时间轴。
 * 尺寸和 fleet.ts 的车型一致：牵引车长 6 米、牵引销在车头后 4.4 米；13.6 米厢式挂车、牵引销在挂车前端后 1.2 米、
 * 车轴组中心在牵引销后 9.5 米；集卡的骨架车车轴在牵引销后 9.2 米；11 米单体厢式车轴距 6.2 米；6 米面包车轴距 3.7 米。
 */
export const VEHICLE_DIMS: Record<YardVehicle, VehicleDims> = {
  semi: { kind: 'rig', front: 4.4, tractorRear: 1.6, trailerFront: 1.2, rear: 12.4, axle: 9.5, width: 2.55, wheelbase: 3.3 },
  reefer: { kind: 'rig', front: 4.4, tractorRear: 1.6, trailerFront: 1.75, rear: 12.4, axle: 9.5, width: 2.55, wheelbase: 3.3 },
  chassis: { kind: 'rig', front: 4.4, tractorRear: 1.6, trailerFront: 1.0, rear: 11.2, axle: 9.2, width: 2.55, wheelbase: 3.3 },
  truck: { kind: 'body', length: 11, width: 2.55, wheelbase: 6.2, rearOverhang: 3.4 },
  van: { kind: 'body', length: 6, width: 2.1, wheelbase: 3.7, rearOverhang: 1.4 },
  shunter: { kind: 'rig', front: 3.9, tractorRear: 1.3, trailerFront: 1.2, rear: 12.4, axle: 9.5, width: 2.55, wheelbase: 2.55 },
};

/**
 * 换成别处定的车型尺寸（三维车模的尺寸表）：之后排的场地、路线都按新的尺寸。
 * 默认值按 GB 1589-2016 的限值以内（半挂车 ≤ 13.75 米、铰接列车 ≤ 17.1 米、车宽 2.55 米），和 fleet.ts 的车模一致。
 */
export function setVehicleDims(table: Partial<Record<YardVehicle, VehicleDims>>, bobtail?: Partial<Record<'road' | 'shunter', BodyDims>>): void {
  for (const [k, v] of Object.entries(table)) if (v) VEHICLE_DIMS[k as YardVehicle] = { ...v };
  if (bobtail) for (const [k, v] of Object.entries(bobtail)) if (v) BOBTAIL[k as 'road' | 'shunter'] = { ...v };
}

/** 不带挂车的牵引车（甩挂后空车走、来挂车时空车进）：公路牵引车、场内牵引车；参考点是后轴（≈ 牵引销） */
export const BOBTAIL: Record<'road' | 'shunter', BodyDims> = {
  road: { kind: 'body', length: 6.0, width: 2.55, wheelbase: 3.3, rearOverhang: 1.6 },
  shunter: { kind: 'body', length: 5.2, width: 2.5, wheelbase: 2.55, rearOverhang: 1.3 },
};

export function dimsOf(v: YardVehicle | VehicleDims): VehicleDims {
  return typeof v === 'string' ? VEHICLE_DIMS[v] : v;
}

/** 整车长（车头到车尾） */
export function lengthOf(v: YardVehicle | VehicleDims): number {
  const d = dimsOf(v);
  return d.kind === 'rig' ? d.front + d.rear : d.length;
}
/** 参考点到车头的距离（铰接车：牵引销到牵引车车头；单体车：后轴到车头） */
export function frontOf(v: YardVehicle | VehicleDims): number {
  const d = dimsOf(v);
  return d.kind === 'rig' ? d.front : d.length - d.rearOverhang;
}
/** 参考点到车尾的距离（铰接车：牵引销到挂车车尾；单体车：后轴到车尾） */
export function backOf(v: YardVehicle | VehicleDims): number {
  const d = dimsOf(v);
  return d.kind === 'rig' ? d.rear : d.rearOverhang;
}
/** 后轴（铰接车是挂车车轴组）到车尾 */
export function overhangOf(v: YardVehicle | VehicleDims): number {
  const d = dimsOf(v);
  return d.kind === 'rig' ? d.rear - d.axle : d.rearOverhang;
}

/**
 * 车身的矩形：铰接车是挂车和牵引车两个，单体车一个
 * Body rectangles of a vehicle at a pose: trailer and tractor for a rig, one for a rigid vehicle.
 */
export function footprint(v: YardVehicle | VehicleDims, p: RigPose, grow = 0): OBB[] {
  const d = dimsOf(v);
  if (d.kind === 'rig') {
    const ft = dirOf(p.trailer);
    const fk = dirOf(p.heading);
    const tc = (d.trailerFront - d.rear) / 2;
    const kc = (d.front - d.tractorRear) / 2;
    return [
      { x: p.x + ft.x * tc, z: p.z + ft.z * tc, hl: (d.trailerFront + d.rear) / 2 + grow, hw: d.width / 2 + grow, h: p.trailer },
      { x: p.x + fk.x * kc, z: p.z + fk.z * kc, hl: (d.front + d.tractorRear) / 2 + grow, hw: Math.min(d.width, 2.5) / 2 + grow, h: p.heading },
    ];
  }
  const f = dirOf(p.heading);
  const c = (d.length - 2 * d.rearOverhang) / 2;
  return [{ x: p.x + f.x * c, z: p.z + f.z * c, hl: d.length / 2 + grow, hw: d.width / 2 + grow, h: p.heading }];
}

/**
 * 和 footprint(d, p) 一样的矩形，写进 out（不分配新对象；排程里每 0.5 秒都要算）；返回矩形个数
 */
export function footprintInto(d: VehicleDims, p: RigPose, out: OBB[]): number {
  if (d.kind === 'rig') {
    const tc = (d.trailerFront - d.rear) / 2;
    const kc = (d.front - d.tractorRear) / 2;
    const a = out[0] as OBB;
    const b = out[1] as OBB;
    const ftx = Math.sin(p.trailer);
    const ftz = Math.cos(p.trailer);
    const fkx = Math.sin(p.heading);
    const fkz = Math.cos(p.heading);
    a.x = p.x + ftx * tc;
    a.z = p.z + ftz * tc;
    a.hl = (d.trailerFront + d.rear) / 2 + 0;
    a.hw = d.width / 2 + 0;
    a.h = p.trailer;
    b.x = p.x + fkx * kc;
    b.z = p.z + fkz * kc;
    b.hl = (d.front + d.tractorRear) / 2 + 0;
    b.hw = Math.min(d.width, 2.5) / 2 + 0;
    b.h = p.heading;
    return 2;
  }
  const c = (d.length - 2 * d.rearOverhang) / 2;
  const a = out[0] as OBB;
  a.x = p.x + Math.sin(p.heading) * c;
  a.z = p.z + Math.cos(p.heading) * c;
  a.hl = d.length / 2 + 0;
  a.hw = d.width / 2 + 0;
  a.h = p.heading;
  return 1;
}

/** 车头（牵引车车头）中点 */
export function noseOf(v: YardVehicle | VehicleDims, p: RigPose): Pt {
  const f = dirOf(p.heading);
  const k = frontOf(v);
  return { x: p.x + f.x * k, z: p.z + f.z * k };
}
/** 车尾（挂车车尾）中点 */
export function rearOf(v: YardVehicle | VehicleDims, p: RigPose): Pt {
  const f = dirOf(p.trailer);
  const k = backOf(v);
  return { x: p.x - f.x * k, z: p.z - f.z * k };
}

const STEP = 0.25;

export interface ChainUnit {
  /** 挂点在前一节参考车轴后方多远（米；牵引销在牵引车后轴上时是 0） */
  hitch: number;
  /** 挂点到这一节车轴的距离 */
  length: number;
}
export interface ChainPose {
  x: number;
  z: number;
  heading: number;
}

/**
 * 拖车串：领头的车（参考点是它的后轴）沿路径走，后面每一节按追踪曲线跟着。按距离预先算好；
 * init 是每一节一开始的朝向（不给就和领头车一样，即一开始摆直）。 * A towed chain (tractor plus one or more units) following a lead path, each unit on its tractrix.
 */
export class TowChain {
  readonly line: Polyline;
  readonly length: number;
  /** 每个采样点、每一节的车轴位置和朝向：[k][i] */
  private readonly ax: Float64Array[];
  private readonly az: Float64Array[];
  private readonly th: Float64Array[];

  constructor(
    lead: Polyline | readonly Pt[],
    readonly units: readonly ChainUnit[],
    init?: readonly number[],
  ) {
    const src = lead instanceof Polyline ? lead : new Polyline(lead, STEP);
    this.line = src;
    this.length = src.length;
    const n = Math.max(2, Math.ceil(src.length / STEP) + 1);
    this.ax = units.map(() => new Float64Array(n));
    this.az = units.map(() => new Float64Array(n));
    this.th = units.map(() => new Float64Array(n));
    const st = { x: 0, z: 0, heading: 0 };
    src.at(0, st);
    // 一开始：按给的朝向摆好每一节
    const ax = units.map(() => 0);
    const az = units.map(() => 0);
    let px = st.x;
    let pz = st.z;
    let ph = st.heading;
    units.forEach((u, i) => {
      const hx = px - u.hitch * Math.sin(ph);
      const hz = pz - u.hitch * Math.cos(ph);
      const h = init?.[i] ?? ph;
      ax[i] = hx - u.length * Math.sin(h);
      az[i] = hz - u.length * Math.cos(h);
      px = ax[i] as number;
      pz = az[i] as number;
      ph = h;
    });
    for (let k = 0; k < n; k++) {
      src.at(Math.min(src.length, k * STEP), st);
      px = st.x;
      pz = st.z;
      ph = st.heading;
      units.forEach((u, i) => {
        const hx = px - u.hitch * Math.sin(ph);
        const hz = pz - u.hitch * Math.cos(ph);
        let dx = hx - (ax[i] as number);
        let dz = hz - (az[i] as number);
        let dl = Math.hypot(dx, dz);
        if (dl < 1e-9) {
          dx = Math.sin(ph);
          dz = Math.cos(ph);
          dl = 1;
        }
        // 车轴朝挂点移动、保持距离不变（追踪曲线）
        ax[i] = hx - (u.length * dx) / dl;
        az[i] = hz - (u.length * dz) / dl;
        const h = Math.atan2(dx, dz);
        (this.ax[i] as Float64Array)[k] = ax[i] as number;
        (this.az[i] as Float64Array)[k] = az[i] as number;
        (this.th[i] as Float64Array)[k] = h;
        px = ax[i] as number;
        pz = az[i] as number;
        ph = h;
      });
    }
  }

  /** 距离 s 处领头车的位姿和每一节的车轴位置、朝向 */
  at(s: number, lead: ChainPose, units: ChainPose[]): void {
    this.line.at(s, lead);
    const t = Math.min(this.length, Math.max(0, s)) / STEP;
    const k = Math.min((this.th[0]?.length ?? 2) - 2, Math.max(0, Math.floor(t)));
    const f = Math.min(1, Math.max(0, t - k));
    this.units.forEach((_, i) => {
      const X = this.ax[i] as Float64Array;
      const Z = this.az[i] as Float64Array;
      const H = this.th[i] as Float64Array;
      const a = H[k] as number;
      const b = H[k + 1] ?? a;
      const o = units[i] ?? (units[i] = { x: 0, z: 0, heading: 0 });
      o.x = (X[k] as number) + ((X[k + 1] ?? (X[k] as number)) - (X[k] as number)) * f;
      o.z = (Z[k] as number) + ((Z[k + 1] ?? (Z[k] as number)) - (Z[k] as number)) * f;
      o.heading = a + angDiff(a, b) * f;
    });
  }

  /** 走完时每一节的朝向 */
  endHeadings(): number[] {
    return this.th.map((h) => h[h.length - 1] as number);
  }
}

/** 按距离取位姿的路径：铰接车前进、倒车，单体车 */
export interface DistRig {
  readonly length: number;
  poseAt(s: number, out: RigPose): void;
}

/**
 * 前进：牵引销沿路径走，挂车航向按追踪曲线（单节拖车串，挂点在牵引销上）
 * Forward motion of a rig: the kingpin follows the path, the trailer heading follows the tractrix.
 */
export class ForwardRig implements DistRig {
  readonly length: number;
  readonly line: Polyline;
  /**
   * 每个采样点的挂车朝向（单节拖车串、挂点在牵引销上，和 TowChain 逐点一样算；位姿只用得到朝向，车轴位置算完不留）
   */
  private readonly th: Float64Array;
  private readonly lead = { x: 0, z: 0, heading: 0 };

  constructor(
    path: Polyline | readonly Pt[],
    readonly L: number,
    trailer0?: number,
  ) {
    const src = path instanceof Polyline ? path : new Polyline(path, STEP);
    this.line = src;
    this.length = src.length;
    const n = Math.max(2, Math.ceil(src.length / STEP) + 1);
    const th = new Float64Array(n);
    // 和 new TowChain(path, [{ hitch: 0, length: L }], [trailer0]) 的构造一字不差（hitch 是 0 也照样乘，零的正负号都一样）
    const hitch = 0;
    const st = { x: 0, z: 0, heading: 0 };
    src.at(0, st);
    let px = st.x;
    let pz = st.z;
    let ph = st.heading;
    let hx = px - hitch * Math.sin(ph);
    let hz = pz - hitch * Math.cos(ph);
    const h0 = trailer0 ?? ph;
    let ax = hx - L * Math.sin(h0);
    let az = hz - L * Math.cos(h0);
    for (let k = 0; k < n; k++) {
      src.at(Math.min(src.length, k * STEP), st);
      px = st.x;
      pz = st.z;
      ph = st.heading;
      // hitch = 0：ph 是有限数时 hitch × sin(ph) 是 ±0，px 不是 0 时减它还是 px（省两次三角函数）；px 是 ±0 或 ph 不是有限数时照原样算
      const easy = Number.isFinite(ph);
      hx = easy && px !== 0 ? px : px - hitch * Math.sin(ph);
      hz = easy && pz !== 0 ? pz : pz - hitch * Math.cos(ph);
      let dx = hx - ax;
      let dz = hz - az;
      let dl = Math.hypot(dx, dz);
      if (dl < 1e-9) {
        dx = Math.sin(ph);
        dz = Math.cos(ph);
        dl = 1;
      }
      ax = hx - (L * dx) / dl;
      az = hz - (L * dz) / dl;
      th[k] = Math.atan2(dx, dz);
    }
    this.th = th;
  }

  poseAt(s: number, out: RigPose): void {
    this.line.at(s, this.lead);
    // 和 TowChain.at 一样插值挂车朝向
    const t = Math.min(this.length, Math.max(0, s)) / STEP;
    const H = this.th;
    const k = Math.min(H.length - 2, Math.max(0, Math.floor(t)));
    const f = Math.min(1, Math.max(0, t - k));
    const a = H[k] as number;
    const b = H[k + 1] ?? a;
    out.x = this.lead.x;
    out.z = this.lead.z;
    out.heading = this.lead.heading;
    out.trailer = a + angDiff(a, b) * f;
    out.reversing = false;
    out.steer = Math.max(-0.6, Math.min(0.6, angDiff(out.trailer, out.heading) * 0.5));
  }

  end(): RigPose {
    const p: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
    this.poseAt(this.length, p);
    return p;
  }
}

/**
 * 倒车：挂车车轴沿路径（按行进顺序，从倒车起点到靠稳）后退；挂车朝向 = 行进方向 + π，牵引销在车轴前方 L 处，
 * 牵引车朝向 = 牵引销运动方向 + π。tractor0：倒车起点牵引车的朝向（前进结束时的），起步 blend 米内平滑过渡过去。 * Reversing a rig: the trailer axle follows the path backwards; tractor angle derived from the kingpin's motion.
 */
export class ReverseRig implements DistRig {
  readonly length: number;
  readonly line: Polyline;
  private readonly kx: Float64Array;
  private readonly kz: Float64Array;
  private readonly kh: Float64Array;
  private readonly th: Float64Array;

  constructor(
    axlePath: Polyline | readonly Pt[],
    readonly L: number,
    tractor0?: number,
    blend = 4,
  ) {
    const line = axlePath instanceof Polyline ? axlePath : new Polyline(axlePath, STEP);
    this.line = line;
    this.length = line.length;
    const n = Math.max(2, Math.ceil(line.length / STEP) + 1);
    this.kx = new Float64Array(n);
    this.kz = new Float64Array(n);
    this.kh = new Float64Array(n);
    this.th = new Float64Array(n);
    const st = { x: 0, z: 0, heading: 0 };
    for (let k = 0; k < n; k++) {
      line.at(Math.min(line.length, k * STEP), st);
      const t = st.heading + Math.PI;
      this.th[k] = t;
      this.kx[k] = st.x + L * Math.sin(t);
      this.kz[k] = st.z + L * Math.cos(t);
    }
    // 牵引车朝向：牵引销前后各 0.75 米的运动方向 + π；几乎不动时和挂车一样
    const w = Math.max(1, Math.round(0.75 / STEP));
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - w);
      const b = Math.min(n - 1, k + w);
      const dx = (this.kx[b] as number) - (this.kx[a] as number);
      const dz = (this.kz[b] as number) - (this.kz[a] as number);
      this.kh[k] = Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) + Math.PI : (this.th[k] as number);
    }
    if (tractor0 !== undefined) {
      const m = Math.min(n, Math.ceil(blend / STEP) + 1);
      for (let k = 0; k < m; k++) {
        const f = k / Math.max(1, m - 1);
        const e = f * f * (3 - 2 * f);
        const target = this.kh[k] as number;
        this.kh[k] = tractor0 + angDiff(tractor0, target) * e;
      }
    }
  }

  poseAt(s: number, out: RigPose): void {
    const t = Math.min(this.length, Math.max(0, s)) / STEP;
    const n = this.th.length;
    const k = Math.min(n - 2, Math.max(0, Math.floor(t)));
    const f = Math.min(1, Math.max(0, t - k));
    const lerp = (A: Float64Array) => (A[k] as number) + ((A[k + 1] as number) - (A[k] as number)) * f;
    const ang = (A: Float64Array) => (A[k] as number) + angDiff(A[k] as number, A[k + 1] as number) * f;
    out.x = lerp(this.kx);
    out.z = lerp(this.kz);
    out.heading = ang(this.kh);
    out.trailer = ang(this.th);
    out.reversing = true;
    out.steer = Math.max(-0.6, Math.min(0.6, angDiff(out.trailer, out.heading)));
  }

  end(): RigPose {
    const p: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: true, speed: 0, steer: 0 };
    this.poseAt(this.length, p);
    return p;
  }
}

/**
 * 单体车（后轴中心沿路径走）：前进时车头朝行进方向，倒车时相反
 * Rigid vehicle: the rear-axle centre follows the path; nose forward when driving, backwards when reversing.
 */
export class BodyRig implements DistRig {
  readonly length: number;
  readonly line: Polyline;
  private readonly st = { x: 0, z: 0, heading: 0 };

  constructor(
    path: Polyline | readonly Pt[],
    readonly reverse = false,
    readonly wheelbase = 3.5,
  ) {
    this.line = path instanceof Polyline ? path : new Polyline(path, STEP);
    this.length = this.line.length;
  }

  poseAt(s: number, out: RigPose): void {
    this.line.at(s, this.st);
    out.x = this.st.x;
    out.z = this.st.z;
    out.heading = this.reverse ? this.st.heading + Math.PI : this.st.heading;
    out.trailer = out.heading;
    out.reversing = this.reverse;
    // 前轮转角：轴距 × 曲率（前后各 1 米的朝向差）
    this.line.at(s + 1, this.st);
    const h1 = this.st.heading;
    this.line.at(s - 1, this.st);
    const k = angDiff(this.st.heading, h1) / 2;
    out.steer = Math.max(-0.6, Math.min(0.6, Math.atan(this.wheelbase * k) * (this.reverse ? -1 : 1)));
  }

  end(): RigPose {
    const p: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: this.reverse, speed: 0, steer: 0 };
    this.poseAt(this.length, p);
    return p;
  }
}

/**
 * 一辆车沿一条路径前进的距离型位姿（铰接车用 ForwardRig，单体车用 BodyRig）
 * Distance-parameterised forward pose for any vehicle (ForwardRig for rigs, BodyRig for rigid vehicles).
 */
export function forwardRig(v: YardVehicle | VehicleDims, path: Polyline | readonly Pt[], trailer0?: number): DistRig & { end(): RigPose } {
  const d = dimsOf(v);
  return d.kind === 'rig' ? new ForwardRig(path, d.axle, trailer0) : new BodyRig(path, false, d.wheelbase);
}
