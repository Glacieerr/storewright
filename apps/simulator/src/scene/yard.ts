import { PathChain, roundCorners, TimedPath, type Dynamics, type PathLike, type PathState, type Pt } from './lot';
import { ForwardRig, ReverseRig, TRUCK_DYN, type RigPose } from './rig';
import { SEMI, VEHICLE_LENGTH } from './vehicleTypes';
import { R_IN, R_OUT, type YardPlan } from './yardPlan';

export type { YardPlan };

const SEMI_LEN = VEHICLE_LENGTH.semi;
const L = SEMI.kingpinToAxle;
/** 从主路拐进、拐出进场道路的转弯半径（米）：喇叭口的路缘半径 15 米，半挂车的内侧后轮基本不压到路缘外 */
export const R_ROAD = 15;
/** 在路口停车等灯（经支路进出时）：按信号周期的平均红灯等待 */
export const SIGNAL_WAIT = 28;

/** 到货车型：半挂车（常温、冷藏）、厢式货车、面包车 */
export type YardVehicle = 'semi' | 'truck' | 'van';

/**
 * 卸货场（决策记录 0018、0019）：门店背后的一块场地，单向绕行，半挂车从司机一侧倒车靠台。车道布置见 yardPlan.ts。
 *
 *   顶部车道（向 +X）  ──────────────────────►   右侧进场：驶离的车；左侧进场：进场的车
 *   待命车道（向 −X）  ◄──────── 先到的车在最前（西头），后到的排在后面
 *   驶离车道（向 −X，拉出卸货门后右转）
 *   靠台车道（向 +X，驶向卸货门）  ────► 驶过卸货门 → 车头向外一摆 → 从司机一侧（左侧）倒车靠台
 *   ═══════ 后墙与卸货门 ═══════
 *
 * - 进场：沿进场道路上行；右侧进场在待命车道口右转，左侧进场左转上顶部车道、到东头掉头下到待命车道；排到队尾。
 *   轮到自己（有空门、场地空着）时开到西头，右转掉头下到靠台车道，向东驶过卸货门，车头向外（右）一摆停下，
 *   司机下车打开挂车后门，然后倒车：挂车先在离墙 24 米以外摆正，再笔直退进门里（两边停着别的车，门间距只有 5 米）。
 * - 驶离：先笔直拉出，等挂车尾部越过两边车头再右转上驶离车道；右侧进场到西头左转掉头上顶部车道、向东到进场道路左转下行，
 *   左侧进场一直向西到进场道路右转下行；在路口停车让行（专用通道）或等灯（支路），再拐上主路。
 * - 从主路拐进、拐出进场道路都按 15 米的圆弧转弯（路口是喇叭口），卸货场里的转弯不小于 12 米。
 * 同一时间场地里只有一辆车行驶（仿真里的卸货场调度保证），所以这些路线可以共用地面。
 * 纯函数，坐标与场景一致；半挂车的位置是牵引销，厢式货车和面包车是车身中心。
 */

// ---------------- 路线几何 ----------------

/** 半圆掉头：从 (x, z0) 出发、开始方向沿 −X，掉到 z1 后转回 +X；dz 的正负决定向上还是向下 */
function uTurn(x: number, z0: number, z1: number, steps = 32): Pt[] {
  const r = Math.abs(z1 - z0) / 2;
  const zc = (z0 + z1) / 2;
  const s = Math.sign(z0 - zc) || 1;
  const pts: Pt[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * Math.PI;
    pts.push({ x: x - r * Math.sin(a), z: zc + s * r * Math.cos(a) });
  }
  return pts;
}

/** 东头的半圆掉头：从 (x, z0) 出发、开始方向沿 +X，掉到 z1 后转回 −X */
function uTurnEast(x: number, z0: number, z1: number, steps = 32): Pt[] {
  const r = Math.abs(z1 - z0) / 2;
  const zc = (z0 + z1) / 2;
  const s = Math.sign(z0 - zc) || 1;
  const pts: Pt[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * Math.PI;
    pts.push({ x: x + r * Math.sin(a), z: zc + s * r * Math.cos(a) });
  }
  return pts;
}

/**
 * 折线的拐角换成圆弧（与两边相切，半径 r；两边不够长时按能放下的最大半径）。
 * 与 roundCorners 的二次贝塞尔不同，圆弧上每一点的转弯半径都是 r，大车转弯不会在弯顶突然变急。
 */
export function fillet(pts: Pt[], radius: number, steps = 20): Pt[] {
  if (pts.length < 3) return pts.map((p) => ({ ...p }));
  const out: Pt[] = [{ ...(pts[0] as Pt) }];
  const n = pts.length;
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    const l1 = Math.hypot(b.x - a.x, b.z - a.z);
    const l2 = Math.hypot(c.x - b.x, c.z - b.z);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const u = { x: (b.x - a.x) / l1, z: (b.z - a.z) / l1 };
    const v = { x: (c.x - b.x) / l2, z: (c.z - b.z) / l2 };
    const theta = Math.acos(Math.min(1, Math.max(-1, u.x * v.x + u.z * v.z)));
    if (theta < 1e-3) {
      out.push({ ...b });
      continue;
    }
    // 切点到拐角的距离；首尾两段可以用满，中间的段两头各用一半
    const tmax = Math.min(i === 1 ? l1 : l1 / 2, i === n - 2 ? l2 : l2 / 2);
    const t = Math.min(radius * Math.tan(theta / 2), tmax);
    const r = t / Math.tan(theta / 2);
    const p0 = { x: b.x - u.x * t, z: b.z - u.z * t };
    // 圆心在转弯的一侧
    let nx = u.z;
    let nz = -u.x;
    if (nx * v.x + nz * v.z < 0) {
      nx = -nx;
      nz = -nz;
    }
    const cx = p0.x + nx * r;
    const cz = p0.z + nz * r;
    const a0 = Math.atan2(p0.z - cz, p0.x - cx);
    const p1 = { x: b.x + v.x * t, z: b.z + v.z * t };
    let da = Math.atan2(p1.z - cz, p1.x - cx) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let k = 0; k <= steps; k++) out.push({ x: cx + r * Math.cos(a0 + (da * k) / steps), z: cz + r * Math.sin(a0 + (da * k) / steps) });
  }
  out.push({ ...(pts[n - 1] as Pt) });
  return out;
}

/** 四分之一圆：从 p 出发、初始方向 d0（单位向量），转向 d1（与 d0 垂直），半径 r */
function quarter(p: Pt, d0: Pt, d1: Pt, r: number, steps = 16): Pt[] {
  const cx = p.x + d1.x * r;
  const cz = p.z + d1.z * r;
  const pts: Pt[] = [];
  for (let k = 1; k <= steps; k++) {
    const a = (k / steps) * (Math.PI / 2);
    pts.push({ x: cx - d1.x * r * Math.cos(a) + d0.x * r * Math.sin(a), z: cz - d1.z * r * Math.cos(a) + d0.z * r * Math.sin(a) });
  }
  return pts;
}

/** 按距离等分的折线（每 0.5 米一个点），用于在待命车道上按距离定位 */
export class Polyline {
  readonly pts: Pt[];
  readonly cum: number[];
  readonly length: number;
  constructor(raw: Pt[]) {
    const pts: Pt[] = [];
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i] as Pt;
      if (i === 0) {
        pts.push({ ...p });
        continue;
      }
      const a = raw[i - 1] as Pt;
      const len = Math.hypot(p.x - a.x, p.z - a.z);
      const n = Math.max(1, Math.ceil(len / 0.5));
      for (let k = 1; k <= n; k++) pts.push({ x: a.x + ((p.x - a.x) * k) / n, z: a.z + ((p.z - a.z) * k) / n });
    }
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push((this.cum[i - 1] as number) + Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).z - (pts[i - 1] as Pt).z));
    this.length = this.cum[this.cum.length - 1] ?? 0;
  }
  /** 从距离 s 开始到终点的点列（第一个点是 s 处的插值） */
  from(s: number): Pt[] {
    const t = Math.min(this.length, Math.max(0, s));
    let i = 1;
    while (i < this.pts.length - 1 && (this.cum[i] as number) < t) i++;
    const a = this.pts[i - 1] as Pt;
    const b = this.pts[i] as Pt;
    const seg = (this.cum[i] as number) - (this.cum[i - 1] as number);
    const k = seg > 1e-9 ? (t - (this.cum[i - 1] as number)) / seg : 0;
    return [{ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }, ...this.pts.slice(i)];
  }
}

const YARD_SPEED = 4.2;
const ROAD_SPEED = 11;
const SERVICE_SPEED = 6;

/** 单位速度的路径（τ = 距离），只用来按距离取位置和挂车角度 */
function unitPath(pts: Pt[]): TimedPath {
  return new TimedPath(pts, () => 1, false, { accel: 1e4, decel: 1e4, lat: 1e4, v0: 'cap', v1: 'cap' });
}

/** 一辆车在卸货场里的一套路线（按车型与卸货门） */
export interface YardRoute {
  semi: boolean;
  vehicle: YardVehicle;
  /** 主路 →（支路口等灯）→ 进场道路 → 进场点 */
  approach: { path: PathLike; rig?: ForwardRig };
  /** 进场点 → 待命车道 → 西头掉头 → 靠台车道 → 驶过卸货门车头外摆停下（按距离；semi 时带挂车角度） */
  lane: Polyline;
  laneUnit: TimedPath;
  laneRig?: ForwardRig;
  /** 待命车道上第 j 个车位在 lane 上的距离 */
  slotS: (j: number) => number;
  /** 倒车靠台（半挂车：挂车后轴的倒车路径） */
  back: { rig?: ReverseRig; path?: TimedPath };
  /** 靠稳后的位置（半挂车：牵引销与牵引车、挂车航向） */
  parked: RigPose;
  /** 拉出 → 驶离车道 →（右侧进场：西头掉头 → 顶部车道）→ 进场道路下行 → 路口停车让行或等灯 → 主路 */
  exit: { path: PathLike; rig?: ForwardRig };
}

export interface YardRoad {
  nearLaneZ: number;
  farLaneZ: number;
  spawnMinX: number;
  spawnMaxX: number;
  /** 停车场靠路一侧的边：比它更靠路的路段按主路车速 */
  roadEdgeZ: number;
  /** 主路靠门店一侧的路边（人行道在它和 +2.4 米之间） */
  roadTopZ: number;
  /** 经支路进出时：支路的中心线与半宽（路口的停止线按它算） */
  street?: { x: number; half: number };
}

/** 靠台车道上驶过卸货门的距离、车头外摆的半径和角度：在几组候选里挑一组能顺利倒进门的 */
interface Setup {
  pts: Pt[];
  axlePath: Pt[];
}

const DOCK_DEPTH = 0.6;

/**
 * 半挂车：驶过卸货门 → 车头向外（右）摆 → 再直行一点停下 → 倒车：挂车后轴先沿 th + π 方向直退，
 * 再沿圆弧转到朝墙，在离墙 24 米以外摆正，最后笔直退进门里。在几组候选（驶过多少、摆的半径和角度、摆完直行多少）里
 * 挑一组：倒车圆弧能摆正、牵引车不越过场地东边和待命车道。返回前进部分的点列（从 start 开始）与倒车路径。
 */
function semiSetup(y: YardPlan, doorX: number, start: Pt): Setup {
  const zAlign = y.wall + 24.5;
  const axleDocked = { x: doorX, z: y.wall + DOCK_DEPTH + (SEMI.kingpinToRear - L) };
  const lead = { x: doorX - 25, z: y.zCourt };
  let best: { score: number; s: Setup } | undefined;
  for (const pass of [-4, -1, 2, 5, 8, 11]) {
    for (const rs of [8, 10, 13]) {
      for (const ang of [60, 75, 90, 105]) {
        for (const run of [1, 4, 8]) {
          const x0 = doorX + pass;
          const a = (ang * Math.PI) / 180;
          // 车头向外（+Z，右侧）摆：圆心在 (x0, zCourt + rs)
          const swing: Pt[] = [];
          for (let k = 1; k <= 8; k++) {
            const t = (k / 8) * a;
            swing.push({ x: x0 + rs * Math.sin(t), z: y.zCourt + rs * (1 - Math.cos(t)) });
          }
          const end = swing[swing.length - 1] as Pt;
          const dir = { x: Math.cos(a), z: Math.sin(a) };
          const stop = { x: end.x + dir.x * run, z: end.z + dir.z * run };
          // 牵引车车头（牵引销前 6.4 米）不越过场地东边、不碰待命车道上的车
          const front = { x: stop.x + dir.x * SEMI.kingpinToFront, z: stop.z + dir.z * SEMI.kingpinToFront };
          if (Math.max(stop.x, front.x) > y.x1 - 1.5 || front.z > y.zQueue - 1.3 - 1.2) continue;
          const pts = [lead, { x: x0, z: y.zCourt }, ...swing, stop];
          const rig = new ForwardRig(unitPath(pts), Math.PI / 2);
          const e = rig.end();
          const th = e.trailer;
          if (th <= 0.2 || th >= Math.PI / 2 - 0.05) continue;
          const A0 = { x: e.x - L * Math.sin(th), z: e.z - L * Math.cos(th) };
          const span = A0.x - doorX;
          if (span <= 0.3) continue;
          const R = Math.min(14, span / (1 - Math.cos(th)));
          if (R < 6) continue;
          const s1 = Math.max(0, (span - R * (1 - Math.cos(th))) / Math.sin(th));
          const zEnd = A0.z - s1 * Math.cos(th) - R * Math.sin(th);
          if (zEnd < zAlign) continue;
          const back: Pt[] = [A0];
          const B = { x: A0.x - s1 * Math.sin(th), z: A0.z - s1 * Math.cos(th) };
          if (s1 > 0.05) back.push(B);
          // 圆弧：挂车航向从 th 转到 0，后轴向墙的方向退
          for (let k = 1; k <= 10; k++) {
            const phi = th * (1 - k / 10);
            back.push({ x: B.x - R * (Math.cos(phi) - Math.cos(th)), z: B.z - R * (Math.sin(th) - Math.sin(phi)) });
          }
          back.push(axleDocked);
          // 评分：摆正点离 24.5 米线不远、半径 9–12 米、驶过卸货门少、车头摆得不高
          const score = Math.abs(zEnd - zAlign - 2) * 0.5 + Math.max(0, 9 - R) + Math.max(0, R - 12) * 0.5 + Math.abs(pass) * 0.1 + (front.z - y.zCourt) * 0.08 + run * 0.05;
          if (!best || score < best.score) best = { score, s: { pts: [start, ...pts.slice(1)], axlePath: back } };
        }
      }
    }
  }
  if (best) return best.s;
  // 兜底：沿靠台车道驶过卸货门，直接倒（几乎不会用到）
  const stop = { x: Math.min(y.x1 - 2, doorX + 14 + L), z: y.zCourt };
  return { pts: [start, stop], axlePath: [{ x: stop.x - L, z: y.zCourt }, { x: doorX + 4, z: y.zCourt }, { x: doorX, z: zAlign }, axleDocked] };
}

/**
 * 一套卸货场路线：车型（半挂车 / 厢式货车 / 面包车）、卸货门、来去方向；
 * waitIn / waitOut：经支路进出时在路口等灯的秒数（0 = 正好绿灯）。专用通道驶出时总是停车让行几秒。
 */
export function yardRoute(y: YardPlan, road: YardRoad, doorX: number, vehicle: YardVehicle | boolean, fromLeft: boolean, toLeft: boolean, waitIn = 0, waitOut = SIGNAL_WAIT): YardRoute {
  const kind: YardVehicle = typeof vehicle === 'boolean' ? (vehicle ? 'semi' : 'truck') : vehicle;
  const semi = kind === 'semi';
  const len = semi ? SEMI_LEN : VEHICLE_LENGTH[kind];
  // 车位：车头对齐车位前沿；半挂车的参考点是牵引销（车头后 6.4 米），厢式货车、面包车是车身中心
  const ref = semi ? SEMI.kingpinToFront : len / 2;
  const street = y.via === 'STREET' && road.street ? road.street : undefined;
  const dyn: Dynamics = semi ? { ...TRUCK_DYN } : kind === 'van' ? { accel: 1.8, decel: 2.6, lat: 1.8, wheelbase: 3.6 } : { accel: 1.2, decel: 2, lat: 1.5, wheelbase: 4.3 };
  const speed = (a: Pt, b: Pt) => (Math.max(a.z, b.z) < road.roadEdgeZ - 1 ? ROAD_SPEED : SERVICE_SPEED);

  // 1. 进场：主路 → 进场道路上行车道 → 进场点（右转拐进 15 米、左转 17 米的圆弧）
  const inLane = fromLeft ? road.nearLaneZ : road.farLaneZ;
  const startX = fromLeft ? road.spawnMinX : road.spawnMaxX;
  const gate = { x: y.xIn, z: y.gateZ };
  const rIn = fromLeft ? R_ROAD : R_ROAD + 2;
  let appPath: PathLike;
  if (street) {
    // 经支路：在路口的停止线前停下等灯（车头离停止线 1.5 米），绿灯后拐进支路
    const dir = fromLeft ? 1 : -1;
    const stopX = street.x - dir * (street.half + 3.6 + 1.5 + ref);
    const toStop = new TimedPath([{ x: startX, z: inLane }, { x: stopX, z: inLane }], speed, false, { ...dyn, v0: 'cap', v1: waitIn > 0 ? 0 : 'cap' });
    const turn = new TimedPath(fillet([{ x: stopX, z: inLane }, { x: y.xIn, z: inLane }, gate], Math.min(rIn, Math.abs(y.xIn - stopX))), speed, false, { ...dyn, v0: waitIn > 0 ? 0 : 'cap', v1: YARD_SPEED });
    appPath = waitIn > 0 ? new PathChain([toStop, waitIn, turn]) : new PathChain([toStop, turn]);
  } else {
    appPath = new TimedPath(fillet([{ x: startX, z: inLane }, { x: y.xIn, z: inLane }, gate], rIn), speed, false, { ...dyn, v0: 'cap', v1: YARD_SPEED });
  }

  // 2. 进场点 → 待命车道 → 西头掉头 → 靠台车道 → 驶过卸货门、车头外摆
  const courtStart = { x: y.xTurnDock, z: y.zCourt };
  let tail: Pt[];
  let back: YardRoute['back'];
  let parked: RigPose;
  if (semi) {
    const st = semiSetup(y, doorX, courtStart);
    tail = st.pts.slice(1);
    const backRig = new ReverseRig(new TimedPath(roundCorners(st.axlePath, 3), () => 1.3, true, { accel: 0.5, decel: 0.8, lat: 0.8, wheelbase: 4 }));
    back = { rig: backRig };
    parked = backRig.end();
  } else {
    // 厢式货车、面包车：驶过卸货门 6 米，车头向外摆约 40°，倒车沿圆弧摆正后退进门
    const x0 = doorX + 6;
    const swing = quarter({ x: x0, z: y.zCourt }, { x: 1, z: 0 }, { x: 0, z: 1 }, 7, 8).slice(0, 5);
    tail = [{ x: x0, z: y.zCourt }, ...swing];
    const stop = swing[swing.length - 1] as Pt;
    const docked = { x: doorX, z: y.wall + DOCK_DEPTH + len / 2 };
    const path = new TimedPath(roundCorners([stop, { x: doorX + 1.5, z: y.wall + 16 }, { x: doorX, z: y.wall + 12 }, docked], 5), () => 1.5, true, { accel: 0.8, decel: 1.2, lat: 1, wheelbase: kind === 'van' ? 3.6 : 4.3 });
    back = { path };
    parked = { x: docked.x, z: docked.z, heading: 0, trailer: 0, reversing: false };
  }
  // 进场点到待命车道的队尾（按进场方向），再沿待命车道到西头、掉头下到靠台车道
  const toQueue: Pt[] =
    y.side === 'RIGHT'
      ? [gate, { x: y.xIn, z: y.zQueue - R_IN }, ...quarter({ x: y.xIn, z: y.zQueue - R_IN }, { x: 0, z: 1 }, { x: -1, z: 0 }, R_IN)]
      : [gate, { x: y.xIn, z: y.zTop - R_IN }, ...quarter({ x: y.xIn, z: y.zTop - R_IN }, { x: 0, z: 1 }, { x: 1, z: 0 }, R_IN), { x: y.xEast, z: y.zTop }, ...uTurnEast(y.xEast, y.zTop, y.zQueue).slice(1)];
  const lanePts: Pt[] = [...toQueue, { x: y.xTurnDock, z: y.zQueue }, ...uTurn(y.xTurnDock, y.zQueue, y.zCourt).slice(1), ...tail];
  const lane = new Polyline(lanePts);
  const laneUnit = unitPath(lane.pts);
  const laneRig = semi ? new ForwardRig(laneUnit, 0) : undefined;
  // 待命车道上的车位：沿车道的距离（车道从待命车道的东头起向西）
  const xQueue0 = y.side === 'RIGHT' ? y.xIn - R_IN : y.xEast;
  const qi = lane.pts.findIndex((p) => Math.abs(p.z - y.zQueue) < 0.01 && Math.abs(p.x - xQueue0) < 0.26);
  const sQueue0 = (lane.cum[Math.max(0, qi)] as number) ?? 0;
  const slotS = (j: number) => sQueue0 + (xQueue0 - (y.xHead + ref + j * y.pitch));

  // 3. 驶离：笔直拉出，车尾越过两边车头（后墙外 22 米）后才右转上驶离车道
  const p0 = { x: parked.x, z: parked.z };
  const zTurn = y.wall + 22.25 + 1.2 + (semi ? SEMI.kingpinToRear : len);
  const exitPts: Pt[] = [p0, { x: parked.x, z: zTurn }, ...quarter({ x: parked.x, z: zTurn }, { x: 0, z: 1 }, { x: -1, z: 0 }, y.zExit - zTurn)];
  if (y.side === 'RIGHT') {
    exitPts.push(
      { x: y.xTurnExit, z: y.zExit },
      ...uTurn(y.xTurnExit, y.zExit, y.zTop).slice(1),
      { x: y.xOut - R_OUT, z: y.zTop },
      ...quarter({ x: y.xOut - R_OUT, z: y.zTop }, { x: 1, z: 0 }, { x: 0, z: -1 }, R_OUT),
    );
  } else {
    exitPts.push({ x: y.xOut + R_OUT, z: y.zExit }, ...quarter({ x: y.xOut + R_OUT, z: y.zExit }, { x: -1, z: 0 }, { x: 0, z: -1 }, R_OUT));
  }
  // 进场道路下行到路口：车头停在人行道后面 3 米（专用通道）或支路的停止线后 1.5 米，让行 / 等灯后再拐上主路
  const front = semi ? SEMI.kingpinToFront : len / 2;
  const stopZ = (street ? road.roadTopZ + 3.6 + 1.5 : road.roadTopZ + 2.4 + 3) + front;
  exitPts.push({ x: y.xOut, z: stopZ });
  const outLane = toLeft ? road.farLaneZ : road.nearLaneZ;
  const endX = toLeft ? road.spawnMinX : road.spawnMaxX;
  const exitSpeed = (a: Pt, b: Pt) => (Math.max(a.z, b.z) < road.roadEdgeZ - 1 ? ROAD_SPEED : Math.min(a.z, b.z) > y.wall - 2 ? YARD_SPEED : SERVICE_SPEED);
  // 拉出卸货门的头几米很慢
  const pullOut = (a: Pt, b: Pt) => (Math.min(a.z, b.z) < y.wall + 24 && Math.abs(a.x - parked.x) < 0.5 && Math.abs(b.x - parked.x) < 0.5 ? 1.6 : exitSpeed(a, b));
  const yardPart = new TimedPath(exitPts, pullOut, false, { ...dyn, v1: 0 });
  const rOut = Math.min(toLeft ? R_ROAD + 2 : R_ROAD, stopZ - outLane);
  const roadPart = new TimedPath(fillet([{ x: y.xOut, z: stopZ }, { x: y.xOut, z: outLane }, { x: endX, z: outLane }], rOut), exitSpeed, false, { ...dyn, v0: 0, v1: 'cap' });
  const exitPath = new PathChain([yardPart, street ? Math.max(2, waitOut) : semi ? 5 : 3.5, roadPart]);
  return {
    semi,
    vehicle: kind,
    approach: { path: appPath, rig: semi ? new ForwardRig(appPath) : undefined },
    lane,
    laneUnit,
    laneRig,
    slotS,
    back,
    parked,
    exit: { path: exitPath, rig: semi ? new ForwardRig(exitPath, parked.trailer) : undefined },
  };
}

/** 从车道上的距离 s 开始（初速度 v0）驶完剩下的车道：卸货场里的车速，转弯减速 */
export function laneDrive(r: YardRoute, s0: number, v0: number, trailer0?: number): { path: TimedPath; rig?: ForwardRig } {
  const pts = r.lane.from(s0);
  if (pts.length < 2) pts.push({ ...(pts[0] as Pt) });
  const dyn: Dynamics = r.semi ? { ...TRUCK_DYN, v0, v1: 0 } : r.vehicle === 'van' ? { accel: 1.6, decel: 2.4, lat: 1.8, wheelbase: 3.6, v0, v1: 0 } : { accel: 1.2, decel: 2, lat: 1.5, wheelbase: 4.3, v0, v1: 0 };
  const path = new TimedPath(pts, () => YARD_SPEED, false, dyn);
  return { path, rig: r.semi ? new ForwardRig(path, trailer0) : undefined };
}

/** 在车道上按距离取位置（半挂车带挂车航向） */
export function lanePose(r: YardRoute, s: number, out: RigPose): void {
  if (r.laneRig) r.laneRig.at(s, out);
  else {
    r.laneUnit.at(s, out as PathState);
    out.trailer = out.heading;
    out.reversing = false;
  }
}

// ---------------- 待命车道上的排队移动 ----------------

/** 一辆车在待命车道上的运动：到达后开到队尾的车位，前面的车每进场一辆就往前挪一个车位 */
export class QueueMotion {
  private readonly t: number[] = [];
  private readonly s: number[] = [];
  private readonly v: number[] = [];
  private readonly a: number[] = [];

  /**
   * targets：按时间排列的目标距离变化（第一项是到达时刻的车位）；end：离开队列（进场）的时刻
   * 车速上限 vmax，起步加速度 acc，刹车减速度 dec；按 0.25 秒步长积分，只记下运动中的点
   */
  constructor(start: number, end: number, targets: Array<{ t: number; s: number }>, vmax = 3.6, acc = 0.6, dec = 0.9, v0 = 0) {
    let s = 0;
    let v = Math.min(vmax, v0);
    let ti = 0;
    let target = targets[0]?.s ?? 0;
    const dt = 0.25;
    this.push(start, s, v, 0);
    let t = start;
    let moving = v > 0;
    while (t < end - 1e-6) {
      while (ti < targets.length && (targets[ti] as { t: number }).t <= t + 1e-6) target = (targets[ti++] as { s: number }).s;
      const left = target - s;
      if (left <= 0.01 && v < 0.01) {
        // 停着：跳到下一个目标变化或离开队列
        if (moving) this.push(t, s, 0, 0);
        moving = false;
        const nt = Math.min(end, ti < targets.length ? (targets[ti] as { t: number }).t : end);
        if (nt <= t) break;
        t = nt;
        this.push(t, s, 0, 0);
        continue;
      }
      moving = true;
      // 按剩余距离决定加速还是刹车（v² ≤ 2·dec·剩余距离）
      const vStop = Math.sqrt(Math.max(0, 2 * dec * left));
      let a = v < Math.min(vmax, vStop) - 0.05 ? acc : v > vStop + 0.05 ? -dec : 0;
      if (left <= 0.01) a = -dec;
      const nv = Math.max(0, Math.min(vmax, v + a * dt));
      s = Math.min(target, s + ((v + nv) / 2) * dt);
      v = left <= 0.02 ? 0 : nv;
      t += dt;
      this.push(t, s, v, a);
    }
    this.push(end, s, v, 0);
  }

  private push(t: number, s: number, v: number, a: number): void {
    const n = this.t.length;
    if (n && Math.abs((this.t[n - 1] as number) - t) < 1e-9) {
      this.s[n - 1] = s;
      this.v[n - 1] = v;
      this.a[n - 1] = a;
      return;
    }
    this.t.push(t);
    this.s.push(s);
    this.v.push(v);
    this.a.push(a);
  }

  at(time: number): { s: number; v: number; a: number } {
    const n = this.t.length;
    if (!n) return { s: 0, v: 0, a: 0 };
    if (time <= (this.t[0] as number)) return { s: this.s[0] as number, v: 0, a: 0 };
    if (time >= (this.t[n - 1] as number)) return { s: this.s[n - 1] as number, v: this.v[n - 1] as number, a: 0 };
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
    return { s: (this.s[lo] as number) + ((this.s[hi] as number) - (this.s[lo] as number)) * k, v: (this.v[lo] as number) + ((this.v[hi] as number) - (this.v[lo] as number)) * k, a: this.a[hi] as number };
  }

  /** 离开队列时的距离与速度 */
  end(): { s: number; v: number } {
    const n = this.t.length;
    return { s: (this.s[n - 1] as number) ?? 0, v: (this.v[n - 1] as number) ?? 0 };
  }
}

/** 待命车道上的排队：按到达先后，trucks[i] 在时刻 t 排第几（前面还有几辆没进场的车） */
export function queueTargets(trucks: ReadonlyArray<{ arrive: number; dockAt: number }>, i: number, slotS: (j: number) => number, slots: number): Array<{ t: number; s: number }> {
  const me = trucks[i] as { arrive: number; dockAt: number };
  const ahead = trucks.filter((o, k) => k !== i && (o.arrive < me.arrive || (o.arrive === me.arrive && k < i)) && o.dockAt > me.arrive);
  const leaves = ahead.map((o) => o.dockAt).filter((t) => t < me.dockAt).sort((a, b) => a - b);
  // 车位不够时排在最后一个车位后面（后勤通道上），只是往前挪的距离更长
  const sAt = (n: number) => slotS(Math.min(n, slots - 1)) - Math.max(0, n - (slots - 1)) * 24.65;
  const out = [{ t: me.arrive, s: Math.max(0, sAt(ahead.length)) }];
  leaves.forEach((t, k) => out.push({ t, s: Math.max(0, sAt(ahead.length - k - 1)) }));
  return out;
}
