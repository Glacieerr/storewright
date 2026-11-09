import type { PathLike, PathState, Pt, RigPose, VehicleDims, YardPlan, YardVehicle } from './index';
import { BACK_SPEED, BACK_SPEED_BODY, BOX_DYN, DRIVE_SPEED, R_IN, R_OUT, R_ROAD, ROAD_SPEED, SIGNAL_WAIT, TRUCK_DYN, VAN_DYN, YARD_SPEED, YIELD_BODY, YIELD_RIG } from './consts';
import { fillet, Polyline, quarter, uTurn } from './geom';
import { PathChain, TimedPath, type Dynamics } from './path';
import { BOBTAIL, BodyRig, backOf, dimsOf, forwardRig, frontOf, lengthOf, ReverseRig, type DistRig } from './rig';
import { dockSetup, dockedAxleAt, parkedNeighbours, reverseFrom, type FaceGeo } from './setup';

/**
 * 一辆车在场里的路线（第一部分 Storewright 的 yardRoute，按场地布置和车型推广）。参考点：铰接车是牵引销，单体车是后轴中心。
 *
 * - lane：进场道路在场外的一段 → 进场点 → 待命车道（slotS(j) 是第 j 个车位）→ 掉头 → 靠台车道 → 驶过门、车头外摆停下。
 *   按距离取位姿（laneRig），排队时按 QueueMotion 的距离走，进场调车按 laneDrive 的速度剖面走；
 * - back：从司机一侧倒车靠台（挂车车轴沿路径退，牵引车跟着摆）；
 * - exit：笔直拉出、挂车越过两边车头再转上驶离车道 → 驶出点 →（有路口时）停车让行 / 等灯 → 主路。
 * 甩挂：stallRoute（公路牵引车把挂车倒进甩挂车位、空车走；或空车来倒到挂车下面挂上、拖走）、
 * shunterRoute（场内牵引车把挂车从车位拖到门、从门拖回车位）由一段段 Leg 组成。
 */
export function dynOf(d: VehicleDims): Dynamics {
  if (d.kind === 'rig') return { ...TRUCK_DYN, wheelbase: d.wheelbase };
  return d.length > 8 ? { ...BOX_DYN, wheelbase: d.wheelbase } : { ...VAN_DYN, wheelbase: d.wheelbase };
}

/** 倒车的速度剖面 */
const BACK_DYN = { accel: 0.5, decel: 0.8, lat: 0.8 };

export interface YardRoute {
  vehicle: YardVehicle;
  dims: VehicleDims;
  door: number;
  doorX: number;
  /** 主路 → 进场道路（场地给了路口时才有），终点是进场点（lane 上 sGate 处；进场道路在场外那一段和 lane 的开头重合） */
  approach?: { path: PathLike; rig: DistRig };
  lane: Polyline;
  laneRig: DistRig;
  /** 车头到进场点时参考点在 lane 上的距离（仿真的到达时刻车头正好在进场点：道路段在那里结束） */
  sGate: number;
  slotS: (j: number) => number;
  back: { path: TimedPath; rig: DistRig };
  parked: RigPose;
  /** tClear：拉出转上驶离车道的时刻；tGate：车头开到驶出点的时刻（仿真的离开时刻就是这一刻） */
  exit: { path: PathLike; rig: DistRig; tClear: number; tGate: number };
  /** 这个门找到了能顺利倒进去的准备动作 */
  ok: boolean;
  notes: string[];
}

/** 车道上 y = 待命车道 / 顶部车道…… 的转弯：back 进场（朝 +z）还是 front 进场（朝 −z） */
const upDir = (p: YardPlan) => (p.from === 'back' ? 1 : -1);

/** 进场：场外的一段进场道路 → 进场点 → 到靠台车道起点（to = 'court'）或顶部车道（to = 'top'，甩挂用） */
function inbound(p: YardPlan, to: 'court' | 'top'): { pts: Pt[]; queueAt?: Pt } {
  const u = upDir(p);
  const gz = p.gateIn.z;
  const pts: Pt[] = [{ x: p.xIn, z: gz - u * p.driveLen }, { x: p.xIn, z: gz }];
  const toward = (zLane: number) => ({ x: p.xIn, z: zLane - u * R_IN });
  if (p.side === 'right') {
    // 进场道路在 +x 头：拐进待命车道（向 −x）
    const a = toward(p.zQueue);
    pts.push(a, ...quarter(a, { x: 0, z: u }, { x: -1, z: 0 }, R_IN));
    const queueAt = { x: p.xIn - R_IN, z: p.zQueue };
    pts.push({ x: p.xTurnDock, z: p.zQueue });
    if (to === 'court') pts.push(...uTurn(p.xTurnDock, p.zQueue, p.zCourt, -1).slice(1));
    else pts.push(...uTurn(p.xTurnDock, p.zQueue, p.zTop, -1).slice(1));
    return { pts, queueAt };
  }
  if (p.level === 'court') {
    const a = toward(p.zCourt);
    pts.push(a, ...quarter(a, { x: 0, z: u }, { x: 1, z: 0 }, R_IN));
    return { pts };
  }
  // 进场道路在 −x 头：上顶部车道（向 +x）→ +x 头掉头下到待命车道 → −x 头掉头下到靠台车道
  const a = toward(p.zTop);
  pts.push(a, ...quarter(a, { x: 0, z: u }, { x: 1, z: 0 }, R_IN));
  if (to === 'top') return { pts };
  pts.push({ x: p.xEast, z: p.zTop }, ...uTurn(p.xEast, p.zTop, p.zQueue, 1).slice(1));
  const queueAt = { x: p.xEast, z: p.zQueue };
  pts.push({ x: p.xTurnDock, z: p.zQueue }, ...uTurn(p.xTurnDock, p.zQueue, p.zCourt, -1).slice(1));
  return { pts, queueAt };
}

/** 从顶部车道（向 +x）或驶离车道（向 −x）到驶出点、进场道路场外那一段的终点 */
function toGate(p: YardPlan, from: 'top' | 'exitW' | 'exitE'): Pt[] {
  const u = upDir(p);
  const gz = p.gateOut.z;
  const down = { x: 0, z: -u };
  const tail = [{ x: p.xOut, z: gz }, { x: p.xOut, z: gz - u * p.driveLen }];
  if (from === 'top') {
    // 顶部车道向 +x：右侧进场到 +x 头转下进场道路；左侧进场先在 +x 头掉头下到驶离车道
    if (p.side === 'right') {
      const a = { x: p.xOut - R_OUT, z: p.zTop };
      return [a, ...quarter(a, { x: 1, z: 0 }, down, R_OUT), ...tail];
    }
    return [{ x: p.xEast, z: p.zTop }, ...uTurn(p.xEast, p.zTop, p.zExit, 1).slice(1), ...toGate(p, 'exitW')];
  }
  if (from === 'exitE') {
    const a = { x: p.xOut - R_OUT, z: p.zExit };
    return [a, ...quarter(a, { x: 1, z: 0 }, down, R_OUT), ...tail];
  }
  // 驶离车道向 −x：右侧进场到 −x 头掉头上顶部车道；左侧进场一直到进场道路
  if (p.side === 'right') return [{ x: p.xTurnExit, z: p.zExit }, ...uTurn(p.xTurnExit, p.zExit, p.zTop, -1).slice(1), ...toGate(p, 'top')];
  const a = { x: p.xOut + R_OUT, z: p.zExit };
  return [a, ...quarter(a, { x: -1, z: 0 }, down, R_OUT), ...tail];
}

/** 拉出：从门口（参考点 zp）笔直拉出，车尾越过车头线 1.2 米再转上驶离车道 */
function pullOut(p: YardPlan, d: VehicleDims, doorX: number, zp: number): { pts: Pt[]; clear: Pt; east: boolean } {
  const zTurn = Math.max(zp + 1, p.noseLine + 1.2 + backOf(d));
  const r = Math.max(4, p.zExit - zTurn);
  const east = p.level === 'compact';
  const a = { x: doorX, z: zTurn };
  const turn = quarter(a, { x: 0, z: 1 }, { x: east ? 1 : -1, z: 0 }, r);
  return { pts: [{ x: doorX, z: zp }, a, ...turn], clear: turn[turn.length - 1] as Pt, east };
}

/** 一段场内速度的路径；拉出卸货门的头几米很慢，场外的进场道路按通道车速 */
function yardPath(p: YardPlan, pts: readonly Pt[], d: VehicleDims, v0: number | 'cap' = 0, v1: number | 'cap' = 0, slowX?: number): TimedPath {
  const inYard = (q: Pt) => q.z >= Math.min(p.gateIn.z, p.gateOut.z, 0) - 0.5 && q.z <= Math.max(p.z1, 0) + 0.5;
  const speed = (a: Pt, b: Pt) => {
    if (slowX !== undefined && Math.max(a.z, b.z) < p.alignZ && Math.abs(a.x - slowX) < 0.5 && Math.abs(b.x - slowX) < 0.5) return 1.6;
    return inYard(a) && inYard(b) ? YARD_SPEED : DRIVE_SPEED;
  };
  return new TimedPath(pts, speed, false, { ...dynOf(d), v0, v1 });
}

/**
 * 车在哪条线以外要摆正：铰接车按场地的 alignZ（挂车在离墙 24 米外摆正）；单体车只要车尾进到两边车头之间时已经摆正
 * （后轴在车头线 + 0.75 米 + 后悬以外）
 */
export function alignFor(p: YardPlan, d: VehicleDims): number {
  return d.kind === 'rig' ? p.alignZ : p.noseLine + 0.75 + d.rearOverhang;
}

function geoFor(p: YardPlan, d: VehicleDims, doorX: number): FaceGeo {
  const design = dimsOf(p.design);
  const zLimit = Number.isFinite(p.zQueue) ? p.zQueue - 2.5 : p.z1 - 1.5;
  const xMax = p.side === 'right' ? p.driveX - p.driveHalf - 0.5 : p.x1 - 1;
  return { zCourt: p.zCourt, zLimit, xMax, alignZ: alignFor(p, d), noseLine: p.noseLine, parked: parkedNeighbours(design, p.doors.map((q) => q.x), doorX) };
}

/** 主路 → 进场道路（场地给了路口时）：右转 15 米、左转 17 米的圆弧 */
function roadIn(p: YardPlan, d: VehicleDims, fromLeft: boolean, laneStart: Pt): PathLike | undefined {
  const road = p.input.road;
  if (!road) return undefined;
  const off = road.laneOffset ?? Math.min(3.5, road.half / 2);
  const back = p.from === 'back';
  // 右侧通行：向 +x 的车道在 z 大的一侧
  const plusZ = road.z + off;
  const minusZ = road.z - off;
  const laneZ = fromLeft ? plusZ : minusZ;
  const span = road.spanX ?? [p.x0 - 150, p.x1 + 150];
  const startX = fromLeft ? span[0] : span[1];
  const right = back ? fromLeft : !fromLeft;
  const r = right ? R_ROAD : R_ROAD + 2;
  const pts = fillet([{ x: startX, z: laneZ }, { x: p.xIn, z: laneZ }, laneStart], Math.min(r, Math.abs(laneStart.z - laneZ)));
  const speed = (a: Pt, b: Pt) => (Math.abs(a.z - road.z) < road.half + 1 && Math.abs(b.z - road.z) < road.half + 1 ? ROAD_SPEED : DRIVE_SPEED);
  return new TimedPath(pts, speed, false, { ...dynOf(d), v0: 'cap', v1: YARD_SPEED });
}

/** 驶出点 → 路口停车让行 / 等灯 → 主路 */
function roadOut(p: YardPlan, d: VehicleDims, toLeft: boolean, from: Pt, waitOut?: number): { pts: Pt[]; wait: number; road: TimedPath } | undefined {
  const road = p.input.road;
  if (!road) return undefined;
  const off = road.laneOffset ?? Math.min(3.5, road.half / 2);
  const back = p.from === 'back';
  const edge = back ? road.z + road.half : road.z - road.half;
  const s = back ? 1 : -1;
  // 停车线前停下（车头离路边 3 米 / 支路停止线 1.5 米）；进场道路太短时就停在驶出点外一点，不往回倒
  const gz = p.gateOut.z;
  const dist = Math.max(0.5, Math.abs(edge - gz) - ((p.access === 'drive' ? 3 : 1.5) + frontOf(d)));
  const stopZ = gz - s * dist;
  const laneZ = toLeft ? road.z - off : road.z + off;
  const span = road.spanX ?? [p.x0 - 150, p.x1 + 150];
  const endX = toLeft ? span[0] : span[1];
  const right = back ? !toLeft : toLeft;
  const r = Math.min(right ? R_ROAD : R_ROAD + 2, Math.abs(stopZ - laneZ));
  const speed = (a: Pt, b: Pt) => (Math.abs(a.z - road.z) < road.half + 1 && Math.abs(b.z - road.z) < road.half + 1 ? ROAD_SPEED : DRIVE_SPEED);
  const roadPath = new TimedPath(fillet([{ x: p.xOut, z: stopZ }, { x: p.xOut, z: laneZ }, { x: endX, z: laneZ }], r), speed, false, { ...dynOf(d), v0: 0, v1: 'cap' });
  const wait = p.access === 'street' ? Math.max(2, waitOut ?? SIGNAL_WAIT) : d.kind === 'rig' ? YIELD_RIG : YIELD_BODY;
  void from;
  return { pts: [{ x: p.xOut, z: stopZ }], wait, road: roadPath };
}

export interface RouteOpts {
  /** 从主路哪一头来、往哪一头去（场地给了路口时） */
  fromLeft?: boolean;
  toLeft?: boolean;
  /** 驶出时在信号灯路口等灯的秒数（支路） */
  waitOut?: number;
}

/**
 * 一辆车（车型 vehicle）靠 plan.doors[door] 的整套路线
 * The whole route of one vehicle to `plan.doors[door]`: gate, staging lane, court lane, swing-out, driver-side reverse, pull-out, exit.
 */
export function yardRoute(p: YardPlan, door: number, vehicle: YardVehicle, opts: RouteOpts = {}): YardRoute {
  const d = dimsOf(vehicle);
  const dr = p.doors[Math.max(0, Math.min(p.doors.length - 1, door))] as YardPlan['doors'][number];
  const doorX = dr.x;
  const notes: string[] = [];
  const geo = geoFor(p, d, doorX);
  const inb = inbound(p, 'court');
  const setup = dockSetup(d, doorX, geo, Math.max(p.xTurnDock + 2, doorX - 25));
  if (!setup.ok) notes.push(`${dr.id}：倒车靠台的准备动作没有完全通过检查`);
  const lanePts = [...inb.pts, ...setup.fwd.filter((q) => q.x > (inb.pts[inb.pts.length - 1] as Pt).x + 0.05 || q.z !== p.zCourt)];
  const lane = new Polyline(lanePts, 0.25);
  const L = d.kind === 'rig' ? d.axle : 0;
  const laneRig = forwardRig(d, lane);
  // 按从车道起点一路积分出来的实际停车位姿重排倒车（起步不跳）
  const stop: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
  laneRig.poseAt(lane.length, stop);
  const endAxle = dockedAxleAt(d, doorX);
  const re = reverseFrom(d, stop, doorX, endAxle, alignFor(p, d) + 0.25);
  const backPts = re?.pts ?? setup.back;
  if (!re) notes.push(`${dr.id}：按实际停车位姿排不出倒车圆弧，用了准备动作的倒车路径`);
  const backRig: DistRig & { end(): RigPose } = d.kind === 'rig' ? new ReverseRig(backPts, L, stop.heading) : new BodyRig(backPts, true, d.wheelbase);
  const backPath = new TimedPath(backPts, d.kind === 'rig' ? BACK_SPEED : BACK_SPEED_BODY, true, { ...BACK_DYN, wheelbase: d.wheelbase });
  const parked = backRig.end();

  // 驶离
  const po = pullOut(p, d, doorX, parked.z);
  const tail = toGate(p, po.east ? 'exitE' : 'exitW');
  const exitPts = [...po.pts, ...tail];
  const gateOut = p.gateOut;
  const ro = roadOut(p, d, !!opts.toLeft, gateOut, opts.waitOut);
  const yardPts = ro ? [...exitPts.slice(0, -1), ...ro.pts] : exitPts;
  const yardPart = yardPath(p, yardPts, d, 0, ro ? 0 : 'cap', doorX);
  const exitPath: PathLike = ro ? new PathChain([yardPart, ro.wait, ro.road]) : yardPart;
  const exitLine = new Polyline(ro ? [...yardPts, ...ro.road.points().slice(1)] : yardPts, 0.25);
  const exitRig = forwardRig(d, exitLine, 0);
  const front = frontOf(d);
  const sClear = exitLine.nearest(po.clear);
  const sGate = exitLine.nearest(gateOut) - front;
  const tClear = yardPart.timeAt(sClear);
  const tGate = yardPart.timeAt(sGate);

  // 待命车位：车头对齐车位前沿（排在最前的车车头在 xHead，向 −x）；车头在进场点时参考点在车头后 front 米
  const sGateIn = p.driveLen - front;
  let slotS: (j: number) => number;
  // 闭包只留要用的数（不留整条进场路线的点列）
  const { xHead, pitch, slots } = p.queue;
  if (inb.queueAt && slots > 0) {
    const s0 = lane.nearest(inb.queueAt);
    const qx = inb.queueAt.x;
    const at = (j: number) => s0 + qx - (xHead + j * pitch + front);
    slotS = (j: number) => (j < slots ? at(j) : Math.max(0, at(slots - 1) - (j - slots + 1) * pitch));
  } else slotS = (j: number) => Math.max(0, sGateIn - j * pitch);

  const approachPath = roadIn(p, d, opts.fromLeft ?? true, p.gateIn);
  const approach = approachPath ? { path: approachPath, rig: forwardRig(d, (approachPath as TimedPath).points()) } : undefined;
  return { vehicle, dims: d, door, doorX, ...(approach ? { approach } : {}), lane, laneRig, sGate: sGateIn, slotS, back: { path: backPath, rig: backRig }, parked, exit: { path: exitPath, rig: exitRig, tClear, tGate }, ok: setup.ok && !!re, notes };
}

/**
 * 从车道上的距离 s0 开始（初速度 v0）驶完剩下的车道：场内车速，转弯减速，停在倒车起点
 * Drive the rest of the lane from distance s0 (initial speed v0), slowing for bends, stopping at the reversing start.
 */
export function laneDrive(r: YardRoute, s0: number, v0 = 0): TimedPath {
  const pts = r.lane.from(s0);
  if (pts.length < 2) pts.push({ ...(pts[0] as Pt) });
  return new TimedPath(pts, YARD_SPEED, false, { ...dynOf(r.dims), v0, v1: 0 });
}

/**
 * 车道上距离 s 处的位姿
 * Pose at distance s along the lane.
 */
export function lanePose(r: YardRoute, s: number, out: RigPose): void {
  r.laneRig.poseAt(s, out);
}

// ———————————————————————— 待命车道上的排队移动 ————————————————————————

/**
 * 一辆车在待命车道上的运动：到达后开到自己的车位，前面的车每进场一辆就往前挪一个车位（起步、刹车平稳）。
 * targets：按时间排的目标距离（第一项是到达时刻的车位）；end：离开队列（开始进场调车）的时刻。按 0.25 秒积分。
 * limit（排程器用）：跟车，时刻 t 最远能开到哪里（前车车尾再留出车距）；前车慢、还没挪开时后车跟在后面停下等，不会带着速度追上去。
 * Motion in the staging lane: move up one slot each time the vehicle in front enters (smooth start and stop).
 * `limit(t)` (optional) caps the distance at time t, e.g. the rear of the vehicle in front minus a gap, so the vehicle follows instead of closing in.
 */
export class QueueMotion {
  /** 积分时先放在普通数组里，积分完换成 Float64Array（值一样，不留多余的容量） */
  private t: number[] | Float64Array = [];
  private s: number[] | Float64Array = [];
  private v: number[] | Float64Array = [];

  constructor(start: number, end: number, targets: ReadonlyArray<{ t: number; s: number }>, s0 = 0, vmax = 3.6, acc = 0.6, dec = 0.9, v0 = 0, limit?: (t: number) => number) {
    let s = s0;
    let v = Math.min(vmax, v0);
    let ti = 0;
    let target = targets[0]?.s ?? s0;
    const dt = 0.25;
    this.push(start, s, v);
    let t = start;
    let moving = v > 0;
    let guard = 0;
    while (t < end - 1e-6 && guard++ < 400000) {
      while (ti < targets.length && (targets[ti] as { t: number }).t <= t + 1e-6) target = Math.max(s, (targets[ti++] as { s: number }).s);
      // 跟车：不超过前车允许的位置（只往前、不倒退）
      const cap = limit ? Math.max(s, Math.min(target, limit(t))) : target;
      const left = cap - s;
      if (left <= 0.01 && v < 0.01) {
        if (moving) this.push(t, s, 0);
        moving = false;
        if (cap < target - 0.01) {
          // 前车还没挪开：停着等一会儿再看
          t = Math.min(end, t + 0.5);
          this.push(t, s, 0);
          continue;
        }
        const nt = Math.min(end, ti < targets.length ? (targets[ti] as { t: number }).t : end);
        if (nt <= t) break;
        t = nt;
        this.push(t, s, 0);
        continue;
      }
      moving = true;
      const vStop = Math.sqrt(Math.max(0, 2 * dec * left));
      let a = v < Math.min(vmax, vStop) - 0.05 ? acc : v > vStop + 0.05 ? -dec : 0;
      if (left <= 0.01) a = -dec;
      const nv = Math.max(0, Math.min(vmax, v + a * dt));
      s = Math.min(cap, s + ((v + nv) / 2) * dt);
      v = left <= 0.02 ? 0 : nv;
      t += dt;
      this.push(t, s, v);
    }
    this.push(end, s, v);
    this.t = Float64Array.from(this.t);
    this.s = Float64Array.from(this.s);
    this.v = Float64Array.from(this.v);
  }

  private push(t: number, s: number, v: number): void {
    const T = this.t as number[];
    const n = T.length;
    if (n && Math.abs((T[n - 1] as number) - t) < 1e-9) {
      this.s[n - 1] = s;
      this.v[n - 1] = v;
      return;
    }
    T.push(t);
    (this.s as number[]).push(s);
    (this.v as number[]).push(v);
  }

  at(time: number): { s: number; v: number } {
    const n = this.t.length;
    if (!n) return { s: 0, v: 0 };
    if (time <= (this.t[0] as number)) return { s: this.s[0] as number, v: this.v[0] as number };
    if (time >= (this.t[n - 1] as number)) return { s: this.s[n - 1] as number, v: this.v[n - 1] as number };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.t[mid] as number) <= time) lo = mid;
      else hi = mid;
    }
    const t0 = this.t[lo] as number;
    const t1 = this.t[hi] as number;
    const k = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
    return { s: (this.s[lo] as number) + ((this.s[hi] as number) - (this.s[lo] as number)) * k, v: (this.v[lo] as number) + ((this.v[hi] as number) - (this.v[lo] as number)) * k };
  }

  end(): { s: number; v: number } {
    const n = this.t.length;
    return { s: (this.s[n - 1] as number) ?? 0, v: (this.v[n - 1] as number) ?? 0 };
  }

  /**
   * 从 time 起车停着不动到哪一刻（在动就返回 time；最后一段停着返回 Infinity）
   * Until when the vehicle stands still from `time` (`time` while it moves, Infinity once it has stopped for good).
   */
  stillUntil(time: number): number {
    const n = this.t.length;
    if (!n || time >= (this.t[n - 1] as number)) return Infinity;
    if (time < (this.t[0] as number)) return time;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.t[mid] as number) <= time) lo = mid;
      else hi = mid;
    }
    let k = lo;
    while (k + 1 < n && this.s[k + 1] === this.s[lo] && (this.v[k] as number) < 1e-9 && (this.v[k + 1] as number) < 1e-9) k++;
    return k > lo ? (this.t[k] as number) : time;
  }
}

/**
 * 待命车道上的排队（第一部分的 queueTargets）：按进场顺序，trucks[i] 到达时排在第几个车位，前面的车每进场一辆往前挪一个。
 * trucks 带到达（进入车道）和离开队列（开始进场）的时刻；车位不够时排在最后一个车位后面（进场道路上）。 * Staging-lane slot targets for vehicles in arrival order; overflow queues on the access road.
 */
export function queueTargets(trucks: ReadonlyArray<{ arrive: number; leave: number }>, i: number, slotS: (j: number) => number): Array<{ t: number; s: number }> {
  const me = trucks[i] as { arrive: number; leave: number };
  const ahead = trucks.filter((o, k) => k !== i && (o.leave < me.leave || (o.leave === me.leave && k < i)) && o.leave > me.arrive);
  const leaves = ahead.map((o) => o.leave).sort((a, b) => a - b);
  const out = [{ t: me.arrive, s: Math.max(0, slotS(ahead.length)) }];
  leaves.forEach((t, k) => out.push({ t, s: Math.max(0, slotS(ahead.length - k - 1)) }));
  return out;
}

// ———————————————————————— 甩挂：公路牵引车、场内牵引车 ————————————————————————

/** 一段动作：前进 / 倒车，这段时间车是什么样子（带挂车的铰接车 / 空车），参考点的路径、速度剖面、按距离的位姿 */
export interface Leg {
  kind: 'fwd' | 'rev';
  dims: VehicleDims;
  pts: Pt[];
  path: TimedPath;
  rig: DistRig;
  act: string;
}
export interface ShuntRoute {
  legs: Leg[];
  /** 挂上 / 摘下挂车的秒数（在两段之间） */
  couple: number;
  ok: boolean;
  notes: string[];
}

function fwdLeg(p: YardPlan, d: VehicleDims, pts: Pt[], act: string, trailer0?: number, v0: number | 'cap' = 0, v1: number | 'cap' = 0): Leg {
  const line = new Polyline(pts, 0.25);
  return { kind: 'fwd', dims: d, pts, path: yardPath(p, pts, d, v0, v1), rig: forwardRig(d, line, trailer0), act };
}
function revLeg(d: VehicleDims, pts: Pt[], act: string, tractor0: number): Leg {
  const rig = d.kind === 'rig' ? new ReverseRig(pts, d.axle, tractor0) : new BodyRig(pts, true, d.wheelbase);
  return { kind: 'rev', dims: d, pts, path: new TimedPath(pts, d.kind === 'rig' ? BACK_SPEED : BACK_SPEED_BODY, true, { ...BACK_DYN, wheelbase: d.wheelbase }), rig, act };
}

/** 甩挂车位的墙面坐标（镜像）：z' = zBack − z，车位朝 +z'；在墙面坐标里排倒车，再换回来 */
function stallFace(p: YardPlan, d: VehicleDims) {
  const design = dimsOf(p.design);
  const tf = design.kind === 'rig' ? design.trailerFront : 0;
  const rear = design.kind === 'rig' ? design.rear : lengthOf(design);
  const stallD = tf + rear + 1.5;
  const zBack = p.zTop + 5 + stallD;
  const to = (q: Pt): Pt => ({ x: q.x, z: zBack - q.z });
  const zLimit = zBack - (p.zQueue + 2.5);
  const xMax = p.side === 'right' ? p.xIn - R_IN - 1 : p.x1 - 2;
  // 车位里甩着的挂车（只有挂车）：墙面坐标里车头朝 +z'
  const trailerBox = (x: number) => ({ x, z: stallD - 0.3 - (tf + rear) / 2, hl: (tf + rear) / 2, hw: 1.3, h: 0 });
  const geo = (stallX: number): FaceGeo => ({ zCourt: zBack - p.zTop, zLimit, xMax, alignZ: stallD - 0.3 + 1.75, noseLine: stallD - 0.3, parked: p.stalls.filter((s) => Math.abs(s.x - stallX) > 0.01).map((s) => trailerBox(s.x)) });
  void d;
  return { zBack, to, geo, stallD };
}

/** 车位里挂车的牵引销（原坐标） */
function stallKingpin(p: YardPlan, k: number): Pt {
  const s = p.stalls[k] as YardPlan['stalls'][number];
  const design = dimsOf(p.design);
  const L = design.kind === 'rig' ? design.axle : 0;
  return { x: s.x, z: s.z - L };
}

/** 进到甩挂车位：沿顶部车道驶过车位 → 车头向待命车道一侧摆 → 倒进车位（d 是铰接车时倒挂车，空车时倒到挂车牵引销下面） */
function intoStall(p: YardPlan, d: VehicleDims, k: number, lead: Pt[], act: string): { legs: Leg[]; ok: boolean } {
  const st = p.stalls[k] as YardPlan['stalls'][number];
  const face = stallFace(p, d);
  const endOrig = d.kind === 'rig' ? { x: st.x, z: st.z } : stallKingpin(p, k);
  const endFace = face.to(endOrig);
  const startX = (lead[lead.length - 1] as Pt).x;
  const setup = dockSetup(d, st.x, face.geo(st.x), Math.max(startX + 1, st.x - 25), endFace);
  const back = (q: Pt) => face.to(q);
  const fwd = [...lead, ...setup.fwd.map(back).filter((q) => q.x > startX + 0.05)];
  const f = fwdLeg(p, d, fwd, `${act}：驶向车位`, undefined, 0, 0);
  const stopPose: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
  f.rig.poseAt(f.rig.length, stopPose);
  const r = revLeg(d, setup.back.map(back), `${act}：倒进车位`, stopPose.heading);
  return { legs: [f, r], ok: setup.ok };
}

/** 甩挂车位 → 顶部车道之间那片地方：挂着挂车笔直拉出车位，挂车尾越过车位前沿再左转进待命车道（向 −x） */
function outOfStallToQueue(p: YardPlan, k: number): Pt[] {
  const kp = stallKingpin(p, k);
  const design = dimsOf(p.design);
  const rear = design.kind === 'rig' ? design.rear : lengthOf(design);
  const zClear = p.zTop + 5 - 1 - rear;
  const r = Math.max(10, zClear - p.zQueue);
  const a = { x: kp.x, z: p.zQueue + r };
  return [kp, a, ...quarter(a, { x: 0, z: -1 }, { x: -1, z: 0 }, r)];
}

/** 空车从车位前开出来右转上顶部车道（向 +x），驶出 */
function bobtailOut(p: YardPlan, k: number): Pt[] {
  const kp = stallKingpin(p, k);
  const r = Math.max(6, kp.z - p.zTop - 0.3);
  const a = { x: kp.x, z: p.zTop + r };
  return [kp, a, ...quarter(a, { x: 0, z: -1 }, { x: 1, z: 0 }, r), ...toGate(p, 'top')];
}

/**
 * 公路牵引车在甩挂车位的动作：drop = 拖着挂车进来、倒进车位、摘挂、空车走；hook = 空车进来、倒到挂车下面、挂上、拖走。
 * vehicle 是挂车的车型（半挂、冷藏、集卡），空车按公路牵引车的尺寸。 * Road tractor at a drop stall: `drop` reverses in and unhooks, `hook` backs under a trailer and tows it away.
 */
export function stallRoute(p: YardPlan, stall: number, vehicle: YardVehicle, mode: 'drop' | 'hook'): ShuntRoute {
  const notes: string[] = [];
  if (p.level !== 'full' || !p.stalls.length) return { legs: [], couple: 0, ok: false, notes: ['这个场地没有甩挂车位'] };
  const k = Math.max(0, Math.min(p.stalls.length - 1, stall));
  const rigD = dimsOf(vehicle);
  const bob = BOBTAIL.road;
  const inb = inbound(p, 'top').pts;
  if (mode === 'drop') {
    const into = intoStall(p, rigD, k, inb, '甩挂');
    const out = fwdLeg(p, bob, bobtailOut(p, k), '空车驶离', undefined, 0, 'cap');
    if (!into.ok) notes.push('倒进甩挂车位的准备动作没有完全通过检查');
    return { legs: [...into.legs, out], couple: 60, ok: into.ok, notes };
  }
  const into = intoStall(p, bob, k, inb, '取挂');
  const kp = stallKingpin(p, k);
  void kp;
  const outPts = [...outOfStallToQueue(p, k), { x: p.xTurnDock, z: p.zQueue }, ...uTurn(p.xTurnDock, p.zQueue, p.zTop, -1).slice(1), ...toGate(p, 'top')];
  const out = fwdLeg(p, rigD, outPts, '拖着挂车驶离', Math.PI, 0, 'cap');
  if (!into.ok) notes.push('倒到挂车下面的准备动作没有完全通过检查');
  return { legs: [...into.legs, out], couple: 90, ok: into.ok, notes };
}

/**
 * 场内牵引车（shunter）：toDoor = 在车位挂上挂车 → 拉出车位、进待命车道 → 掉头下靠台车道 → 驶过门、外摆、倒车靠台 → 摘挂；
 * toStall = 在门口挂上挂车 → 拉出、转上驶离车道 → 掉头上顶部车道（左侧进场经进场道路上去）→ 倒进车位 → 摘挂。
 * 场内牵引车在两次作业之间空车来回的路不在这里（场地搭建者把它停在旁边）。 * Yard-shunter routes: stall → door (toDoor) and door → stall (toStall), with hook and unhook.
 */
export function shunterRoute(p: YardPlan, stall: number, door: number, dir: 'toDoor' | 'toStall'): ShuntRoute {
  const notes: string[] = [];
  if (p.level !== 'full' || !p.stalls.length) return { legs: [], couple: 0, ok: false, notes: ['这个场地没有甩挂车位'] };
  const k = Math.max(0, Math.min(p.stalls.length - 1, stall));
  const d = dimsOf('shunter');
  const dr = p.doors[Math.max(0, Math.min(p.doors.length - 1, door))] as YardPlan['doors'][number];
  if (dir === 'toDoor') {
    const lead = [...outOfStallToQueue(p, k), { x: p.xTurnDock, z: p.zQueue }, ...uTurn(p.xTurnDock, p.zQueue, p.zCourt, -1).slice(1)];
    const geo = geoFor(p, d, dr.x);
    const setup = dockSetup(d, dr.x, geo, Math.max(p.xTurnDock + 2, dr.x - 25));
    const fwd = [...lead, ...setup.fwd.filter((q) => q.x > p.xTurnDock + 0.05 || q.z !== p.zCourt)];
    const f = fwdLeg(p, d, fwd, '场内牵引车拖挂车去门口', Math.PI);
    const stop: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
    f.rig.poseAt(f.rig.length, stop);
    const re = reverseFrom(d, stop, dr.x, dockedAxleAt(d, dr.x), p.alignZ + 0.25);
    if (!setup.ok || !re) notes.push(`${dr.id}：场内牵引车倒车靠台没有完全通过检查`);
    const r = revLeg(d, re?.pts ?? setup.back, '场内牵引车倒车靠台', stop.heading);
    return { legs: [f, r], couple: 45, ok: setup.ok && !!re, notes };
  }
  // 从门口到车位
  const zp = dockedAxleAt(d, dr.x).z + (d.kind === 'rig' ? d.axle : 0);
  const po = pullOut(p, d, dr.x, zp);
  let lead: Pt[];
  if (p.side === 'right') lead = [...po.pts, { x: p.xTurnExit, z: p.zExit }, ...uTurn(p.xTurnExit, p.zExit, p.zTop, -1).slice(1)];
  else {
    // 左侧进场：驶离车道到进场道路，左转上去、再左转上顶部车道
    // 往 +z 走的那条车道：从墙后上来时是进场车道，从远端进场时是驶出车道
    const xUp = p.from === 'back' ? p.xIn : p.xOut;
    const a = { x: xUp + R_IN, z: p.zExit };
    const up = quarter(a, { x: -1, z: 0 }, { x: 0, z: 1 }, R_IN);
    const b = { x: xUp, z: p.zTop - R_IN };
    lead = [...po.pts, a, ...up, b, ...quarter(b, { x: 0, z: 1 }, { x: 1, z: 0 }, R_IN)];
  }
  const into = intoStall(p, d, k, lead, '场内牵引车送挂车回车位');
  if (!into.ok) notes.push('场内牵引车倒进甩挂车位没有完全通过检查');
  const first = into.legs[0] as Leg;
  // 从门口拉出时挂车朝 +z
  into.legs[0] = fwdLeg(p, d, first.pts, first.act, 0);
  return { legs: into.legs, couple: 45, ok: into.ok, notes };
}

/** 一段 Leg 走到时刻 τ 的位姿（时间从这段开始算） */
export function legPose(leg: Leg, tau: number, out: RigPose, st: PathState = { x: 0, z: 0, heading: 0 }): void {
  leg.path.at(tau, st);
  leg.rig.poseAt(st.dist ?? 0, out);
  out.speed = st.speed ?? 0;
}
