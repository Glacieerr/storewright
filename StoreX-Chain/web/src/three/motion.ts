import { OFFMAP_KM } from '../../../src/region/region';
import type { WSeg, WVehicle } from '../../../src/sim/trace';
import { bezier, cumulative, fillet, reverse, v3, type V3 } from './geo';
import { laneOffset, type Arc, type Junction, type Line, type Place, type RoadNet } from './roadnet';
import type { PartSpec } from './fleet';
import { approachPhase, greenAt, nextGreen, REACT, STOP_BACK } from './signals';
import { addSimVisit, findYardDoor, frontOf, poseAt as yardPoseAt, scheduleYard, setVehicleDims, siteVisit, type YardPiece, simVisitFor, simVisitId, siteTimeline, siteVersion, toWorld as yardToWorld, TowChain, yardSite, yawOf, type BodyDims, type ChainUnit, type RigDims, type RigPose, type VehicleDims, type YardSite, type YardTimeline, type YardVehicle } from '@storewright/yard';
import * as SPECS from './vehicles/specs';

/**
 * 车辆的运动规划：把仿真轨迹的一段段「开往某地 / 在某地停」变成沿车道的三维运动——
 * 从月台或卸货位开出来（先往前拉出、开过场地）、沿车道过路口和立交、开进对方的场地、开过头再倒车靠上月台。
 *
 * 每一段运动有一条路径（Track）和「时刻 → 路径上的位置」的对应；车上的零件按到车头的距离落在路径上。
 * 前进时车头领先（零件在 u − x），倒车时车尾领先（零件在 u − L + x）。
 *
 * 速度曲线：每段运动先按路况排一条限速——道路等级、弯道曲率（路口转弯、环岛、匝道前减速）、场地车速、
 * 倒车靠台最后几米蠕行——再加上加减速的限制（起步慢慢加速、到弯道和停车点之前提前减速、出弯再加速），
 * 整条曲线按一个系数缩放，让走完全程正好用仿真给的时长：出发、到达的时刻和仿真完全一样，中间没有瞬间起步或急停。
 * 曲线存成采样点（时刻、位置、速度），两点之间匀加速，所以速度连续；刹车灯、转向灯、车轮转角都从这里算。
 */
export interface Track {
  pts: V3[];
  cum: number[];
  len: number;
}
export interface MLeg {
  t0: number;
  t1: number;
  track: Track;
  /** 运动段：采样点的时刻 tu、领先点位置 tuS、那一刻的速度 tv（米 / 秒，两点之间匀加速）；停着的段 u 固定 */
  tu?: number[];
  tuS?: number[];
  tv?: number[];
  u: number;
  /** 倒车（车尾领先） */
  rev: boolean;
  act?: string;
  /** 这一段开始时的里程（米，倒车往回减）：车轮转角 = 里程 / 轮半径 */
  odo?: number;
  /** 刹车灯亮的时段（开、关、开、关……） */
  brake?: number[];
  /** 打转向灯的时段：每三个数一组（开、关、方向：−1 左 / 1 右） */
  blink?: number[];
  /** 道路上的行驶段：走过的每条道路弧在路径上的位置（背景车流按它让仿真车，见 roadSpans） */
  spans?: RoadSpan[];
  /** 收货场里的一段：按场地排程取的位姿（零件按它摆，见 partPose），track 是车头走过的路 */
  ys?: YardSamples;
  /** 属于哪一次收货场停靠（场地的排程变了就重算这一段，见 legAt） */
  yb?: YardBlock;
  /** 只有牵引车（甩挂时空车头）：挂车零件不画 */
  bobtail?: boolean;
  /** 这一段不画（一开始就该靠着、可是门还被占着的车：在场外等，轮到它进场才出现） */
  hidden?: boolean;
}
export interface Motion {
  legs: MLeg[];
  L: number;
  t0: number;
  t1: number;
  /** 这辆车在收货场的停靠 */
  yards?: YardBlock[];
}

/**
 * 收货场里一段的采样（每 0.5 秒一个）：车头走过的距离 s（和 tuS 一样，倒车时 tuS 多加整车长）、
 * 参考点（铰接车的牵引销、单体车的后轴）的区域坐标、牵引车和挂车的 three.js yaw
 */
export interface YardSamples {
  s: Float64Array;
  kx: Float64Array;
  kz: Float64Array;
  hk: Float64Array;
  ht: Float64Array;
  dims: VehicleDims;
  y: number;
}
/** 一次收货场停靠：仿真的停留时段交给场地排程（@storewright/yard），按需要（场地的排程版本变了）换成一段段场内的运动 */
export interface YardBlock {
  key: string;
  id: string;
  /** 这次停靠的所有编号（连着几段停在同一个地点时不止一个） */
  ids: string[];
  door: number;
  kind: YardVehicle;
  L: number;
  t0: number;
  t1: number;
  /** 一开始就停在门口（出发前装车）：从 t0 起就靠着 */
  initial: boolean;
  ver: number;
  legs: MLeg[];
  y: number;
  act?: string;
}

/** 场地（真实尺寸）里的车速、倒车车速（米 / 秒） */
const LOT_SPEED = 1.6;
const REVERSE_SPEED = 0.9;
/** 车速系数里「场地」的记号 */
const LOT = -1;

/**
 * 动力学参数（米 / 秒²）。道路部分在沙盘里：距离压缩成 1/10、时间不变，所以车速、加速度都是真实的 1/10
 * （重型半挂车真实起步约 0.45 米 / 秒²、常用制动约 0.8）；场地、倒车按真实尺寸。
 */
export interface Dyn {
  acc: number;
  dec: number;
  lotAcc: number;
  lotDec: number;
  revAcc: number;
  revDec: number;
}
export const DYN: Record<'heavy' | 'medium' | 'light', Dyn> = {
  heavy: { acc: 0.045, dec: 0.08, lotAcc: 0.3, lotDec: 0.35, revAcc: 0.18, revDec: 0.25 },
  medium: { acc: 0.06, dec: 0.1, lotAcc: 0.4, lotDec: 0.45, revAcc: 0.22, revDec: 0.3 },
  light: { acc: 0.09, dec: 0.13, lotAcc: 0.6, lotDec: 0.6, revAcc: 0.3, revDec: 0.4 },
};

export function makeTrack(pts: readonly V3[]): Track {
  const clean: V3[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.05) clean.push(p.clone());
  }
  if (clean.length === 1) clean.push((clean[0] as V3).clone().add(v3(0.1, 0, 0)));
  const cum = cumulative(clean);
  return { pts: clean, cum, len: cum[cum.length - 1] as number };
}

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** 路径上 s 处的点写进 out（不新建对象，每帧用）；超出两头时沿首尾的方向直线延伸 */
export function trackInto(tr: Track, s: number, out: XYZ): XYZ {
  const n = tr.pts.length;
  if (s <= 0 || s >= tr.len) {
    const end = s >= tr.len;
    const a = tr.pts[end ? n - 2 : 0] as V3;
    const b = tr.pts[end ? n - 1 : 1] as V3;
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const o = end ? b : a;
    const e = end ? s - tr.len : s;
    out.x = o.x + ((b.x - a.x) / l) * e;
    out.y = o.y;
    out.z = o.z + ((b.z - a.z) / l) * e;
    return out;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((tr.cum[mid] as number) <= s) lo = mid;
    else hi = mid;
  }
  const a = tr.pts[lo] as V3;
  const b = tr.pts[hi] as V3;
  const d = (tr.cum[hi] as number) - (tr.cum[lo] as number) || 1;
  const k = (s - (tr.cum[lo] as number)) / d;
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  return out;
}

/** 路径上 s 处的点；超出两头时沿首尾的方向直线延伸 */
export function trackAt(tr: Track, s: number): V3 {
  const o = v3(0, 0, 0);
  trackInto(tr, s, o);
  return o;
}

/** 领先点此刻的状态：路径上的位置、速度、加速度（倒车时也是沿路径方向的正值） */
export interface LeadState {
  u: number;
  v: number;
  a: number;
}

/** 运动段在时刻 t 的领先点：位置、速度、加速度（停着的段速度为 0） */
export function leadState(leg: MLeg, t: number, out: LeadState): LeadState {
  const tu = leg.tu;
  const ts = leg.tuS;
  const tv = leg.tv;
  out.v = 0;
  out.a = 0;
  if (!tu || !ts || tu.length < 2) {
    out.u = leg.u;
    return out;
  }
  const n = tu.length;
  if (t <= (tu[0] as number)) {
    out.u = ts[0] as number;
    if (tv) out.v = tv[0] as number;
    return out;
  }
  if (t >= (tu[n - 1] as number)) {
    out.u = ts[n - 1] as number;
    if (tv) out.v = tv[n - 1] as number;
    return out;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((tu[mid] as number) <= t) lo = mid;
    else hi = mid;
  }
  const dt = (tu[hi] as number) - (tu[lo] as number) || 1e-9;
  const tau = t - (tu[lo] as number);
  if (tv) {
    const v0 = tv[lo] as number;
    const a = ((tv[hi] as number) - v0) / dt;
    out.u = (ts[lo] as number) + v0 * tau + 0.5 * a * tau * tau;
    out.v = v0 + a * tau;
    out.a = a;
  } else {
    const vv = ((ts[hi] as number) - (ts[lo] as number)) / dt;
    out.u = (ts[lo] as number) + vv * tau;
    out.v = vv;
  }
  return out;
}

const LS: LeadState = { u: 0, v: 0, a: 0 };
/** 运动段在时刻 t 的领先点位置 */
export function leadU(leg: MLeg, t: number): number {
  return leadState(leg, t, LS).u;
}

/** 时刻 t 在不在某个时段里（时段按 step 个数一组，开始时刻递增：刹车 [开, 关]、转向灯 [开, 关, 方向]）；返回那一组的下标或 −1 */
export function inSpans(spans: readonly number[] | undefined, t: number, step: number): number {
  if (!spans) return -1;
  for (let i = 0; i < spans.length; i += step) {
    if (t < (spans[i] as number)) return -1;
    if (t <= (spans[i + 1] as number)) return i;
  }
  return -1;
}

export interface PartPose {
  x: number;
  y: number;
  z: number;
  /** 绕 y 轴的角度（three.js 的 rotation.y：车头 +x 转到行进方向） */
  yaw: number;
  pitch: number;
}

const PF: XYZ = { x: 0, y: 0, z: 0 };
const PR: XYZ = { x: 0, y: 0, z: 0 };
const PK: XYZ = { x: 0, y: 0, z: 0 };
const PA: XYZ = { x: 0, y: 0, z: 0 };

/** 被拖的零件（挂车、骨架车、集装箱、小汽车拖的房车 / 船 / 平板拖车）：前锚点是牵引销或挂钩 */
const TOWED = /^(trailer|chassis|container|camper|boatTrailer|utilityTrailer)/;
/** 牵引车（倒车时按挂车反推它的朝向） */
const TRACTORS = /^(tractor|terminalTractor|yardShunter)/;

/**
 * 零件的姿态（零件原点 = 前锚点沿朝向往后退 ax）：
 * - 收货场里的段（leg.ys）：按场地排程的位姿摆（牵引销 / 后轴的位置，牵引车和挂车各自的朝向）；
 * - 前进：牵引车和单体车两个锚点落在路径上；挂车的牵引销在路径上，车轴按追踪曲线跟着（转弯切内侧、出弯慢慢摆正），
 *   从牵引销往回 5 倍轴距处的摆直状态积分到此刻（再往前的影响不到 1%）；
 * - 倒车：挂车车轴沿路径退，挂车朝向是行进方向的反方向，牵引销在车轴前方一个轴距；牵引车朝向取牵引销运动方向的反方向，
 *   起步的 4 米里从和挂车摆直的状态平滑过渡；单体车两个锚点落在路径上。
 */
export function partPose(leg: MLeg, u: number, L: number, p: PartSpec, scale: number, out: PartPose): PartPose {
  if (leg.ys) return yardPartPose(leg.ys, leg.rev ? u - L : u, p, scale, out);
  const towed = TOWED.test(p.slot);
  if (leg.bobtail && towed) {
    // 空车头：挂车藏到地下
    out.x = 0;
    out.y = -1000;
    out.z = 0;
    out.yaw = 0;
    out.pitch = 0;
    return out;
  }
  if (!leg.rev && towed) return towedForward(leg, u, p, scale, out);
  if (leg.rev && !leg.bobtail && (towed || TRACTORS.test(p.slot))) {
    const rig = rigOfLength(L);
    if (rig) return reversePart(leg, u, L, p, scale, rig, towed, out);
  }
  return anchorPose(leg, u, L, p, scale, out);
}

/** 两个锚点都落在路径上（单体车、前进的牵引车） */
function anchorPose(leg: MLeg, u: number, L: number, p: PartSpec, scale: number, out: PartPose): PartPose {
  const coord = (x: number) => (leg.rev ? u - L * scale + x * scale : u - x * scale);
  const f = trackInto(leg.track, coord(p.fa), PF);
  const r = trackInto(leg.track, coord(p.ra), PR);
  let dx = f.x - r.x;
  let dz = f.z - r.z;
  let len = Math.hypot(dx, dz);
  if (len < 1e-4) {
    dx = 1;
    dz = 0;
    len = 1;
  }
  dx /= len;
  dz /= len;
  out.x = f.x - dx * p.ax * scale;
  out.z = f.z - dz * p.ax * scale;
  out.y = (f.y + r.y) / 2 + (p.y ?? 0) * scale;
  out.yaw = Math.atan2(-dz, dx);
  out.pitch = Math.atan2(f.y - r.y, Math.max(0.5, (p.ra - p.fa) * scale));
  return out;
}

/**
 * 路径在 s 处的方向（three.js 的 yaw，按前后各 2.5 米的弦，折线的拐点不会让方向跳）；back = 车头朝路径的反方向（倒车）。
 * 前后轴都落在路径上时，车身朝向是两轴间的弦，前轴处的切线和弦差半个圆心角，所以前轮转向角 ≈ 2 ×（这个方向 − 车身朝向）。
 */
export function pathYaw(tr: Track, s: number, back: boolean): number {
  trackInto(tr, s + 2.5, PF);
  trackInto(tr, s - 2.5, PR);
  const dx = PF.x - PR.x;
  const dz = PF.z - PR.z;
  return back ? Math.atan2(dz, -dx) : Math.atan2(-dz, dx);
}

export function legAt(m: { legs: MLeg[]; t0: number; t1: number }, t: number): MLeg | undefined {
  const legs = m.legs;
  if (!legs.length || t < m.t0 || t > m.t1) return undefined;
  let lo = 0;
  let hi = legs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((legs[mid] as MLeg).t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  const leg = legs[lo];
  // 收货场里的段：场地的排程变了（场地登记了当天的车、来了外来车）就按新的排程重排这一次停靠
  const yb = leg?.yb;
  if (yb && yb.ver !== siteVersion(yb.key)) {
    resolveYard(m as Motion, yb);
    return legAt(m, t);
  }
  return leg;
}

// ———————————————————————— 速度曲线 ————————————————————————

/**
 * 一段运动的限速和加减速：采样点 s（递增）；每个点的限速 = min(cap, c × rel)，cap 是绝对限速（场地车速）、
 * rel 是相对限速（道路等级 × 弯道系数），c 是整条曲线的系数；acc / dec 是每个区间 [i, i+1] 的加速度、减速度上限。
 */
interface Spec {
  s: number[];
  cap: number[];
  rel: number[];
  acc: number[];
  dec: number[];
}

/**
 * 排速度曲线：起点 / 终点停住（free 的一头按限速进出：从地图外开进来、开出地图；v0：起点带着这个速度，接着前一段开），先按限速、再前向（加速）
 * 和反向（减速）各扫一遍；找系数 c 让全程正好用时 T。限速卡住找不到时，整条曲线按比例缩放（时刻仍然精确）。
 * 返回每个采样点的时刻、速度，和刹车灯亮的时段（减速度超过允许值的 30%，松油门滑行不算）。
 */
function solve(sp: Spec, t0: number, T: number, free0: boolean, free1: boolean, v0?: number): { tu: number[]; tv: number[]; brake: number[] | undefined } {
  const { s, cap, rel, acc, dec } = sp;
  const n = s.length;
  const v = new Float64Array(n);
  const lim = (i: number, c: number) => Math.max(1e-4, Math.min(cap[i] as number, c * (rel[i] as number)));
  const run = (c: number): number => {
    v[0] = v0 ?? (free0 ? lim(0, c) : 0);
    if (!Number.isFinite(v[0] as number)) v[0] = 0;
    for (let i = 0; i < n - 1; i++) {
      const vi = v[i] as number;
      v[i + 1] = Math.min(lim(i + 1, c), Math.sqrt(vi * vi + 2 * (acc[i] as number) * ((s[i + 1] as number) - (s[i] as number))));
    }
    if (!free1) v[n - 1] = 0;
    for (let i = n - 2; i >= 0; i--) {
      const vn = v[i + 1] as number;
      v[i] = Math.min(v[i] as number, Math.sqrt(vn * vn + 2 * (dec[i] as number) * ((s[i + 1] as number) - (s[i] as number))));
    }
    // 接着上一段开（v0：带着速度进来）：起点速度不变
    if (v0 !== undefined) v[0] = v0;
    let total = 0;
    for (let i = 0; i < n - 1; i++) {
      const sum = (v[i] as number) + (v[i + 1] as number);
      total += sum > 1e-9 ? (2 * ((s[i + 1] as number) - (s[i] as number))) / sum : 1e9;
    }
    return total;
  };
  // 初值：不算加减速时正好用时 T 的系数
  let base = 0;
  let fixed = 0;
  for (let i = 0; i < n - 1; i++) {
    const ds = (s[i + 1] as number) - (s[i] as number);
    const r = rel[i + 1] as number;
    if (Number.isFinite(r)) base += ds / Math.max(1e-4, r);
    else fixed += ds / Math.max(1e-4, cap[i + 1] as number);
  }
  let c = base > 0 ? base / Math.max(0.1 * T, T - fixed) : 1;
  if (base > 0) {
    let lo = c;
    let hi = c;
    let tLo = run(c);
    let tHi = tLo;
    if (tLo > T) {
      for (let k = 0; k < 40 && tHi > T; k++) {
        lo = hi;
        tLo = tHi;
        hi *= 1.6;
        tHi = run(hi);
      }
    } else {
      for (let k = 0; k < 40 && tLo < T; k++) {
        hi = lo;
        tHi = tLo;
        lo /= 1.6;
        tLo = run(lo);
      }
    }
    if (tLo >= T && tHi <= T) {
      for (let k = 0; k < 60 && hi / lo > 1 + 1e-6; k++) {
        const mid = Math.sqrt(lo * hi);
        const tm = run(mid);
        if (Math.abs(tm - T) < 1e-4 * T) {
          lo = hi = mid;
          break;
        }
        if (tm > T) lo = mid;
        else hi = mid;
      }
      c = Math.sqrt(lo * hi);
    } else c = tHi <= T ? hi : lo;
  }
  const Tc = run(c);
  // 剩下的误差（或者找不到系数时的差距）按比例摊到整条曲线上：时刻 × k，速度 ÷ k
  const k = T / Tc;
  const tu: number[] = [t0];
  const tv: number[] = [(v[0] as number) / k];
  const brake: number[] = [];
  let acc0 = 0;
  for (let i = 0; i < n - 1; i++) {
    const sum = (v[i] as number) + (v[i + 1] as number);
    const dt = sum > 1e-9 ? (2 * ((s[i + 1] as number) - (s[i] as number))) / sum : 0;
    const ta = t0 + acc0 * k;
    acc0 += dt;
    const tb = t0 + acc0 * k;
    tu.push(tb);
    tv.push((v[i + 1] as number) / k);
    if (dt > 0 && ((v[i + 1] as number) - (v[i] as number)) / dt < -0.3 * (dec[i] as number)) {
      const L = brake.length;
      if (L && ta - (brake[L - 1] as number) < 0.6) brake[L - 1] = tb;
      else brake.push(ta, tb);
    }
  }
  tu[n - 1] = t0 + T;
  return { tu, tv, brake: brake.length ? brake : undefined };
}

/** 弯道限速系数：转弯半径 R = 1 / k 小于 r0 时按 √(R / r0) 降速（侧向加速度不变），最低 floor */
function bend(k: number, r0: number, floor: number): number {
  const R = 1 / Math.max(1e-6, k);
  return R >= r0 ? 1 : Math.max(floor, Math.sqrt(R / r0));
}

const smooth = (x: number): number => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};
const smoother = (x: number): number => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * k * (k * (k * 6 - 15) + 10);
};

/** 路径上 [a, b] 的采样点：路径的拐点都取，长的直段按 step 细分；至少 7 个点 */
function sampleRange(tr: Track, a: number, b: number, step: number): number[] {
  const out: number[] = [a];
  const add = (x: number) => {
    const last = out[out.length - 1] as number;
    const d = x - last;
    if (d < 0.05) return;
    const k = Math.ceil(d / step);
    for (let j = 1; j <= k; j++) out.push(last + (d * j) / k);
  };
  for (const c of tr.cum) if (c > a + 0.05 && c < b - 0.05) add(c);
  add(b);
  if (out.length < 7) {
    const r: number[] = [];
    for (let j = 0; j <= 6; j++) r.push(a + ((b - a) * j) / 6);
    return r;
  }
  out[out.length - 1] = b;
  return out;
}

const C0: XYZ = { x: 0, y: 0, z: 0 };
const C1: XYZ = { x: 0, y: 0, z: 0 };
const C2: XYZ = { x: 0, y: 0, z: 0 };
/** 每个采样点的曲率（有符号，1 / 米）：前后各 w 米的两段弦的方向差 ÷ w；正 = 右转（x 向东、z 向南） */
function curvature(tr: Track, s: readonly number[], w: number): Float64Array {
  const k = new Float64Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const x = s[i] as number;
    trackInto(tr, x - w, C0);
    trackInto(tr, x, C1);
    trackInto(tr, x + w, C2);
    let d = Math.atan2(C2.z - C1.z, C2.x - C1.x) - Math.atan2(C1.z - C0.z, C1.x - C0.x);
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    k[i] = d / w;
  }
  return k;
}

/** s 所在的那一段路径的终点下标（采样点的属性取这个点的） */
function vertexAfter(cum: readonly number[], s: number): number {
  const n = cum.length;
  if (s <= (cum[0] as number)) return Math.min(1, n - 1);
  if (s >= (cum[n - 1] as number)) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) <= s) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * 路口的连接段：realize 给转弯曲线一个固定的低车速系数（0.35，环岛 0.3），直行、缓弯也一样慢。这里把
 * 两头都是更快道路、不到 35 米的「低谷」抬到两头道路里较慢的那个——慢不慢交给弯道曲率（急弯按半径减速）。
 * 长的低速段（环岛绕大半圈、街道）不动；场地的点不动。
 */
function liftJoins(cum: readonly number[], pace: readonly number[]): number[] {
  const n = pace.length;
  const out = pace.slice();
  for (let i = 0; i < n; i++) {
    const p = pace[i] as number;
    if (p < 0) continue;
    let left = -1;
    for (let j = i - 1; j >= 0 && (cum[i] as number) - (cum[j] as number) <= 35; j--) if ((pace[j] as number) >= 0) left = Math.max(left, pace[j] as number);
    let right = -1;
    for (let j = i + 1; j < n && (cum[j] as number) - (cum[i] as number) <= 35; j++) if ((pace[j] as number) >= 0) right = Math.max(right, pace[j] as number);
    if (left > p && right > p) out[i] = Math.min(left, right);
  }
  return out;
}

/** 每个采样点取前后 w 米里的最小值（弯道限速：进弯前就减到整个弯要的速度，弯里不忽快忽慢） */
function minWindow(s: readonly number[], x: readonly number[], w: number): number[] {
  const n = s.length;
  const out = x.slice();
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while ((s[lo] as number) < (s[i] as number) - w) lo++;
    let m = x[i] as number;
    for (let j = lo; j < n && (s[j] as number) <= (s[i] as number) + w; j++) m = Math.min(m, x[j] as number);
    out[i] = m;
  }
  return out;
}

/** 转弯曲率的门槛（转弯半径 36 米以内）：路口转弯、环岛进出口、场地里拐弯；环岛本身和高速的弯不算 */
const K_TURN = 1 / 36;

/** 打转向灯的时段：同一个方向、曲率超过门槛、总共转过 25° 以上的弯；提前 6 秒开灯，出弯 1 秒后关 */
function blinks(s: readonly number[], kap: Float64Array, tu: readonly number[], t0: number): number[] | undefined {
  const out: number[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ki = kap[i] as number;
    if (Math.abs(ki) < K_TURN) {
      i++;
      continue;
    }
    const sg = Math.sign(ki);
    let a = i;
    let b = i;
    while (a > 0 && (kap[a - 1] as number) * sg > K_TURN * 0.5) a--;
    while (b < n - 1 && (kap[b + 1] as number) * sg > K_TURN * 0.5) b++;
    let ang = 0;
    for (let j = a; j < b; j++) ang += 0.5 * ((kap[j] as number) + (kap[j + 1] as number)) * ((s[j + 1] as number) - (s[j] as number));
    if (Math.abs(ang) > 0.44) {
      const on = Math.max(t0, (tu[a] as number) - 6);
      const off = (tu[b] as number) + 1;
      const L = out.length;
      if (L && out[L - 1] === sg && (out[L - 2] as number) >= on - 2) out[L - 2] = off;
      else out.push(on, off, sg);
    }
    i = b + 1;
  }
  return out.length ? out : undefined;
}

/** 路上要过的一个信号灯：停止线在路径上的位置、路口、这条进口道的相位 */
interface Light {
  s: number;
  j: Junction;
  phase: 0 | 1;
}

/**
 * 外来车在信号灯前排队（ops/extTrucks.ts 登记谁在哪个灯前停到什么时候）：ahead 返回此刻（到停止线的时刻）前面还停着几辆车、
 * 它们里最晚起步的时刻；stopped 登记自己停在第几个车位、停住和起步的时刻
 */
export interface QueueHook {
  ahead(light: number, t: number): { k: number; after: number };
  stopped(light: number, k: number, tStop: number, tGo: number): void;
}
/** 排队：车位间距（米，半挂车长 16.8 米加 2 米空当）、最多排几个车位、后车比前车晚多少秒起步 */
const QUEUE_GAP = 19;
const QUEUE_SLOTS = 4;
const QUEUE_WAVE = 2.4;

/**
 * 每个还没过的信号灯预留的等灯时间（秒，最多剩下时间的 25%）：前面的路稍快一点，存下的时间给红灯用；
 * 绿灯过去了就少留一个灯的，存下的时间在后面慢慢用掉。重型车起步、刹车慢，一次红灯连等带起停要半分钟左右。
 */
const LIGHT_RESERVE = 32;
const LIGHT_CAP = 0.25;
/** 停过红灯以后剩下的路，最高车速最多比不停车时高多少（倍）；再高就不停这个灯（极少数时间太紧的行程，最后的退路） */
const LIGHT_SPEEDUP = 1.35;

/** 路径上从 from 往后、离点 p 最近的位置（2.5 米以内；找不到返回 undefined） */
function nearestS(tr: Track, p: V3, from: number): number | undefined {
  let best: number | undefined;
  let bd = 2.5;
  for (let i = Math.max(1, vertexAfter(tr.cum, from)); i < tr.pts.length; i++) {
    const a = tr.pts[i - 1] as V3;
    const b = tr.pts[i] as V3;
    const ux = b.x - a.x;
    const uz = b.z - a.z;
    const l2 = ux * ux + uz * uz || 1e-9;
    const k = Math.max(0, Math.min(1, ((p.x - a.x) * ux + (p.z - a.z) * uz) / l2));
    const d = Math.hypot(p.x - a.x - ux * k, p.z - a.z - uz * k);
    if (d < bd) {
      bd = d;
      best = (tr.cum[i - 1] as number) + Math.sqrt(l2) * k;
    } else if (best !== undefined && d > 30) break;
  }
  return best;
}

/**
 * 路线上的信号灯：行程开到有信号灯的路口、接着还要往下走时（T 形路口、分合流点不算，和背景车流一样），
 * 车道在路口退让处结束，停止线在它前面 STOP_BACK 米（中间是斑马线）。返回停止线在路径上的位置。
 */
export function stopLines(net: RoadNet, arcs: readonly Arc[], lane: number, tr: Track, uStart: number): Light[] {
  const out: Light[] = [];
  let from = uStart;
  for (let i = 0; i + 1 < arcs.length; i++) {
    const arc = arcs[i] as Arc;
    const line = net.lines[arc.line];
    if (!line) continue;
    const j = net.junctions.get(arc.jb);
    const phase = approachPhase(j, line, arc.jb);
    if (phase === undefined || !j) continue;
    const trimOut = arc.jb === line.ja ? line.trimA : arc.jb === line.jb ? line.trimB : 0;
    const trimIn = arc.ja === line.ja ? line.trimA : arc.ja === line.jb ? line.trimB : 0;
    if (Math.abs(arc.s1 - arc.s0) - trimIn - trimOut < STOP_BACK + 4) continue;
    const fwd = arc.s1 >= arc.s0;
    const b = arc.s1 - (fwd ? trimOut : -trimOut);
    const tail = net.lanePath(line, b - (fwd ? 1 : -1), b, lane);
    const end = tail[tail.length - 1];
    const sEnd = end ? nearestS(tr, end, from) : undefined;
    if (sEnd === undefined) continue;
    from = sEnd;
    const s = sEnd - STOP_BACK;
    if (s > uStart + 3 && s < tr.len - 6) out.push({ s, j, phase });
  }
  return out;
}

/** 有序采样点里插进几个位置（离已有的点不到 5 厘米就用已有的），返回新数组和每个位置的下标 */
function withPoints(s: readonly number[], xs: readonly number[]): { s: number[]; at: number[] } {
  const out = s.slice();
  for (const x of xs) {
    let i = 0;
    while (i < out.length && (out[i] as number) < x - 0.05) i++;
    if (i < out.length && Math.abs((out[i] as number) - x) <= 0.05) continue;
    out.splice(i, 0, x);
  }
  return { s: out, at: xs.map((x) => out.findIndex((y) => Math.abs(y - x) <= 0.05)) };
}

/** 时段 [开, 关, 开, 关……] 排序、合并重叠的 */
function mergeSpans(spans: readonly number[]): number[] | undefined {
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < spans.length; i += 2) pairs.push([spans[i] as number, spans[i + 1] as number]);
  if (!pairs.length) return undefined;
  pairs.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [a, b] of pairs) {
    const L = out.length;
    if (L && a <= (out[L - 1] as number) + 0.6) out[L - 1] = Math.max(out[L - 1] as number, b);
    else out.push(a, b);
  }
  return out;
}

/**
 * 按信号灯排速度曲线：一个个灯往下看，按排好的曲线（给前面的灯预留了时间）到停止线时是绿灯就带着速度开过去，
 * 从那里接着排；红灯就提前刹车、停在线后，等绿灯亮了（加上起步反应）再走——绿灯几秒内就亮的，前面慢一点开、
 * 到线时正好变绿。最后一个灯以后正好在仿真给的时刻到达。停下以后剩下的路要开得比不停车时快 35% 以上才赶得上的，
 * 这个灯不停（最后的退路）。返回拼好的采样点（等灯时同一个位置有两个采样点）、刹车时段、每个采样点在原采样里的下标。
 */
function obeyLights(sp: Spec, at: readonly number[], lights: readonly Light[], base: { tu: number[]; tv: number[] }, t0: number, t1: number, free0: boolean, free1: boolean, queue?: QueueHook, atQ?: readonly number[][]): { s: number[]; tu: number[]; tv: number[]; brake: number[] | undefined; idx: number[] } {
  const n = sp.s.length;
  const slice = (ia: number, ib: number): Spec => ({ s: sp.s.slice(ia, ib + 1), cap: sp.cap.slice(ia, ib + 1), rel: sp.rel.slice(ia, ib + 1), acc: sp.acc.slice(ia, ib), dec: sp.dec.slice(ia, ib) });
  const peak = (a: readonly number[], i0 = 0, i1 = a.length - 1): number => {
    let m = 0;
    for (let i = i0; i <= i1; i++) m = Math.max(m, a[i] as number);
    return m;
  };
  const outS: number[] = [];
  const outT: number[] = [];
  const outV: number[] = [];
  const idx: number[] = [];
  const brake: number[] = [];
  /** 收下曲线 r（从采样点 ia 起）到采样点 ib 为止的部分 */
  const take = (ia: number, r: { tu: number[]; tv: number[]; brake: number[] | undefined }, ib: number) => {
    for (let k = 0; k <= ib - ia; k++) {
      // 接着上一段：起步比停住晚（等灯）就留着这个点，同一时刻（带着速度接上）就不要重复
      if (k === 0 && outT.length && (r.tu[0] as number) <= (outT[outT.length - 1] as number) + 1e-6) continue;
      outS.push(sp.s[ia + k] as number);
      outT.push(r.tu[k] as number);
      outV.push(r.tv[k] as number);
      idx.push(ia + k);
    }
    const tEnd = r.tu[ib - ia] as number;
    const b = r.brake ?? [];
    for (let i = 0; i + 1 < b.length; i += 2) if ((b[i] as number) < tEnd) brake.push(b[i] as number, Math.min(tEnd, b[i + 1] as number));
  };
  let ia = 0;
  let tCur = t0;
  let f0 = free0;
  let v0: number | undefined;
  for (let q = 0; q < lights.length; q++) {
    const iS = at[q] as number;
    if (iS <= ia || iS >= n - 1) continue;
    const L = lights[q] as Light;
    const Trem = t1 - tCur;
    const R = solve(slice(ia, n - 1), tCur, Trem - Math.min((lights.length - q) * LIGHT_RESERVE, LIGHT_CAP * Trem), f0, free1, v0);
    const tq = R.tu[iS - ia] as number;
    const vq = R.tv[iS - ia] as number;
    const pass = () => {
      take(ia, R, iS);
      ia = iS;
      tCur = tq;
      f0 = false;
      v0 = vq;
    };
    if (greenAt(L.j, L.phase, tq)) {
      pass();
      continue;
    }
    // 排队：前面还有几辆在等这个灯，就停在它们后面（每辆一个车位），前车起步后再晚一点起步
    const Q = queue ? queue.ahead(q, tq) : undefined;
    const kq = Q ? Math.min(Q.k, (atQ?.[q]?.length ?? 1) - 1) : 0;
    const iStop = kq > 0 ? (atQ?.[q]?.[kq] ?? iS) : iS;
    if (iStop <= ia) {
      pass();
      continue;
    }
    const tqs = R.tu[iStop - ia] as number;
    const vqs = R.tv[iStop - ia] as number;
    let TA = tqs - tCur + vqs / (2 * ((sp.dec[iStop - 1] as number) || 0.08));
    const g = nextGreen(L.j, L.phase, tCur + TA);
    if (!kq && g > tCur + TA && g - (tCur + TA) < 6) TA = g - tCur;
    const arrive = tCur + TA;
    const go0 = greenAt(L.j, L.phase, arrive) && !kq ? arrive + 0.6 : nextGreen(L.j, L.phase, arrive) + REACT;
    const go = Q && kq > 0 ? Math.max(go0 + kq * QUEUE_WAVE, Q.after + QUEUE_WAVE, arrive + 0.6) : go0;
    // 剩下的路（先不算后面的灯）：最高车速比不停车时高太多就不停这个灯
    const B = t1 - go > 5 ? solve(slice(iStop, n - 1), go, t1 - go, false, free1) : undefined;
    if (!B || peak(B.tv) > LIGHT_SPEEDUP * Math.max(0.3, peak(base.tv, iStop, n - 1))) {
      pass();
      continue;
    }
    take(ia, solve(slice(ia, iStop), tCur, TA, f0, false, v0), iStop);
    if (go > arrive) brake.push(arrive, go);
    queue?.stopped(q, kq, arrive, go);
    ia = iStop;
    tCur = go;
    f0 = false;
    v0 = 0;
  }
  take(ia, solve(slice(ia, n - 1), tCur, t1 - tCur, f0, free1, v0), n - 1);
  return { s: outS, tu: outT, tv: outV, brake: mergeSpans(brake), idx };
}

/**
 * 一段行驶：路径 tr（每个点的车速系数 pace，场地的点是 LOT），领先点从 uStart 开到终点，用时 [t0, t1]。
 * free0 / free1：从地图外开进来 / 开出地图（这一头不用停）。lights：路上的信号灯（红灯停、绿灯走，到达时刻不变）。
 */
function driveLeg(tr: Track, rawPace: readonly number[], uStart: number, t0: number, t1: number, dyn: Dyn, free0: boolean, free1: boolean, act: string | undefined, lights: readonly Light[] = [], step = 3, queue?: QueueHook): MLeg {
  // 停止线也取成采样点：红灯时正好停在那里；排队的车位（停止线后面每 QUEUE_GAP 米一个）也取成采样点
  const slots = queue ? QUEUE_SLOTS : 0;
  const qs = lights.flatMap((l) => Array.from({ length: slots + 1 }, (_, k) => l.s - k * QUEUE_GAP).filter((x, k) => k === 0 || x > uStart + 2));
  const { s, at: atAll } = withPoints(sampleRange(tr, uStart, tr.len, step), qs);
  const at: number[] = [];
  const atQ: number[][] = [];
  {
    let c = 0;
    for (const l of lights) {
      const row: number[] = [];
      for (let k = 0; k <= slots; k++) {
        if (k > 0 && !(l.s - k * QUEUE_GAP > uStart + 2)) break;
        row.push(atAll[c++] as number);
      }
      at.push(row[0] as number);
      atQ.push(row);
    }
  }
  const n = s.length;
  const pace = liftJoins(tr.cum, rawPace);
  // 曲率：道路按前后 10 米（真实的路口转弯半径十几米；折线上的小折角不算弯），场地按前后 4 米
  const kap = curvature(tr, s, 10);
  const kLot = curvature(tr, s, 4);
  const T = t1 - t0;
  const lot: boolean[] = s.map((x) => (pace[vertexAfter(tr.cum, x)] ?? 1) < 0);
  const bendAt = minWindow(
    s,
    s.map((_, i) => (lot[i] ? bend(Math.abs(kLot[i] as number), 14, 0.45) : bend(Math.abs(kap[i] as number), 90, 0.33))),
    8,
  );
  // 停车前的最后 8 米慢慢收（开过头准备倒车、开进车位），不是到了才猛刹
  const end = tr.len;
  const creep = (x: number) => (free1 ? 1 : 0.35 + 0.65 * smooth((end - x) / 8));
  // 场地按场地车速；场地用时超过整段的 40%（行程很短）时场地也开快一些，道路分剩下的时间
  let lotT = 0;
  let road = false;
  for (let i = 0; i < n - 1; i++) {
    const ds = (s[i + 1] as number) - (s[i] as number);
    if (lot[i + 1]) lotT += ds / (LOT_SPEED * (bendAt[i + 1] as number));
    else road = true;
  }
  const lotScale = road && lotT > 0.4 * T ? lotT / (0.4 * T) : 1;
  const sp: Spec = { s, cap: [], rel: [], acc: [], dec: [] };
  for (let i = 0; i < n; i++) {
    const f = (bendAt[i] as number) * creep(s[i] as number);
    if (lot[i]) {
      sp.cap.push(LOT_SPEED * lotScale * f);
      sp.rel.push(Infinity);
    } else {
      sp.cap.push(Infinity);
      sp.rel.push(Math.max(0.05, pace[vertexAfter(tr.cum, s[i] as number)] ?? 1) * f);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    sp.acc.push(lot[i + 1] ? dyn.lotAcc : dyn.acc);
    sp.dec.push(lot[i + 1] ? dyn.lotDec : dyn.dec);
  }
  const base = solve(sp, t0, T, free0, free1);
  if (!lights.length) {
    const blink = blinks(s, kap, base.tu, t0);
    return { t0, t1, track: tr, tu: base.tu, tuS: s, tv: base.tv, u: uStart, rev: false, ...(act ? { act } : {}), ...(base.brake ? { brake: base.brake } : {}), ...(blink ? { blink } : {}) };
  }
  const r = obeyLights(sp, at, lights, base, t0, t1, free0, free1, queue, atQ);
  const blink = blinks(r.s, Float64Array.from(r.idx, (i) => kap[i] as number), r.tu, t0);
  return { t0, t1, track: tr, tu: r.tu, tuS: r.s, tv: r.tv, u: uStart, rev: false, ...(act ? { act } : {}), ...(r.brake ? { brake: r.brake } : {}), ...(blink ? { blink } : {}) };
}

/** 倒车靠台：车尾领先，从 uFrom 倒到路径终点，用时 T；起步慢慢加速，弯里慢一些，最后 3.5 米蠕行、平稳停住 */
function reverseLeg(B: Track, uFrom: number, t0: number, T: number, dyn: Dyn, act: string | undefined): MLeg {
  const s = sampleRange(B, uFrom, B.len, 0.5);
  const kap = curvature(B, s, 2.5);
  const bendAt = minWindow(
    s,
    s.map((_, i) => bend(Math.abs(kap[i] as number), 8, 0.55)),
    3,
  );
  const sp: Spec = { s, cap: [], rel: [], acc: [], dec: [] };
  for (let i = 0; i < s.length; i++) {
    const left = B.len - (s[i] as number);
    sp.cap.push(REVERSE_SPEED * 1.6);
    sp.rel.push((bendAt[i] as number) * (0.3 + 0.7 * smooth(left / 3.5)));
  }
  for (let i = 0; i < s.length - 1; i++) {
    sp.acc.push(dyn.revAcc);
    sp.dec.push(dyn.revDec);
  }
  const { tu, tv, brake } = solve(sp, t0, T, false, false);
  return { t0, t1: t0 + T, track: B, tu, tuS: s, tv, u: uFrom, rev: true, ...(act ? { act } : {}), ...(brake ? { brake } : {}) };
}

// ———————————————————————— 设施的外来车（ops/extTrucks.ts）：和仿真车同一套路径、速度曲线和信号灯 ————————————————————————

/** 场地里的点的车速系数记号（按场地车速开） */
export const LOT_PACE = LOT;
export type DrivePiece = Piece;
/** 拼好的一条行驶路径：路径、每个点的车速系数、路上的信号灯（停止线的位置）、领先点从哪里开始（前面是引入段） */
export interface DrivePath {
  track: Track;
  pace: number[];
  lights: Light[];
  uStart: number;
  /** 道路部分走过的每条道路弧在路径上的位置（外来车互相跟车用） */
  spans: RoadSpan[];
}

/** 几段路径首尾接起来（断开处用贝塞尔曲线连），找出道路部分（arcs、第 lane 条车道）上的信号灯 */
export function drivePath(net: RoadNet, pieces: readonly Piece[], arcs: readonly Arc[], lane: number, uStart = 0): DrivePath {
  const g = stitch(pieces);
  const { track, pace } = trackOf(g.pts, g.pace);
  return { track, pace, lights: arcs.length ? stopLines(net, arcs, lane, track, uStart) : [], uStart, spans: arcs.length ? roadSpans(net, arcs, lane, track, uStart) : [] };
}

/** 不算等红灯，按道路车速（车速系数 1 = vRoad 米 / 秒）、场地车速大致要开多久（秒，含起步、停车和弯道） */
export function driveTime(p: DrivePath, vRoad: number): number {
  const { track, pace } = p;
  let T = 0;
  for (let i = 1; i < track.pts.length; i++) {
    const c0 = track.cum[i - 1] as number;
    const c1 = track.cum[i] as number;
    const a = Math.max(c0, p.uStart);
    if (c1 <= a) continue;
    const pc = pace[i] ?? 1;
    T += (c1 - a) / (pc < 0 ? LOT_SPEED * 0.85 : vRoad * Math.max(0.05, pc) * 0.93);
  }
  return T + 12;
}

/**
 * 按固定的车速系数 c（车速系数 1 的路上开 c 米 / 秒）开完这条路径要多久（秒，不等红灯；限速、弯道、加减速和 driveLeg 一样）。
 * 外来车用它定行程时间：用时 = 这个时间 + 每个信号灯预留的 LIGHT_RESERVE，到第一个灯之前正好按 c 开，同一段路上的车车速一样
 */
export function cruiseTime(p: DrivePath, c: number, dyn: Dyn, free0: boolean, free1: boolean, step = 3): number {
  const tr = p.track;
  const s = sampleRange(tr, p.uStart, tr.len, step);
  const n = s.length;
  const pace = liftJoins(tr.cum, p.pace);
  const kap = curvature(tr, s, 10);
  const kLot = curvature(tr, s, 4);
  const lot: boolean[] = s.map((x) => (pace[vertexAfter(tr.cum, x)] ?? 1) < 0);
  const bendAt = minWindow(
    s,
    s.map((_, i) => (lot[i] ? bend(Math.abs(kLot[i] as number), 14, 0.45) : bend(Math.abs(kap[i] as number), 90, 0.33))),
    8,
  );
  const end = tr.len;
  const lim = (i: number): number => {
    const f = (bendAt[i] as number) * (free1 ? 1 : 0.35 + 0.65 * smooth((end - (s[i] as number)) / 8));
    return Math.max(1e-4, lot[i] ? LOT_SPEED * f : c * Math.max(0.05, pace[vertexAfter(tr.cum, s[i] as number)] ?? 1) * f);
  };
  const v = new Float64Array(n);
  v[0] = free0 ? lim(0) : 0;
  for (let i = 0; i < n - 1; i++) v[i + 1] = Math.min(lim(i + 1), Math.sqrt((v[i] as number) ** 2 + 2 * (lot[i + 1] ? dyn.lotAcc : dyn.acc) * ((s[i + 1] as number) - (s[i] as number))));
  if (!free1) v[n - 1] = 0;
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i] as number, Math.sqrt((v[i + 1] as number) ** 2 + 2 * (lot[i + 1] ? dyn.lotDec : dyn.dec) * ((s[i + 1] as number) - (s[i] as number))));
  let T = 0;
  for (let i = 0; i < n - 1; i++) {
    const sum = (v[i] as number) + (v[i + 1] as number);
    T += sum > 1e-9 ? (2 * ((s[i + 1] as number) - (s[i] as number))) / sum : 0;
  }
  return T;
}
/** 每个还没过的信号灯预留的等灯时间（外来车定行程时间用） */
export const LIGHT_WAIT = LIGHT_RESERVE;

// ———————————————————————— 车道上的位置（背景车流让仿真车、外来车互相跟车用） ————————————————————————

/**
 * 行驶路径走过的一条道路弧（routeArcs 给的一段）：线 line、方向 dir（顺着线 1 / 逆着线 −1）、车道 lane，
 * 路径上的位置 us 和线上的坐标 ss 一对对（按行进方向排）。车道是线的偏移：线上的折点偏移到车道上、折点之间每 25 米补一个点，
 * 落在路径上的记一对；两对之间按直线插值（同一段偏移线上路径长和线长成比例）。路口里的转弯、场地不在任何一段里。
 */
export interface RoadSpan {
  line: number;
  dir: 1 | -1;
  lane: number;
  us: number[];
  ss: number[];
}

/** 路径上 u0 以后、离点 p 不到 tol 米的位置（往后最多找 ahead 米；找不到返回 undefined） */
function findOn(tr: Track, px: number, pz: number, u0: number, ahead: number, tol: number): number | undefined {
  let best: number | undefined;
  let bd = tol;
  for (let i = Math.max(1, vertexAfter(tr.cum, u0)); i < tr.pts.length; i++) {
    const c0 = tr.cum[i - 1] as number;
    if (c0 > u0 + ahead) break;
    const a = tr.pts[i - 1] as V3;
    const b = tr.pts[i] as V3;
    const ux = b.x - a.x;
    const uz = b.z - a.z;
    const l2 = ux * ux + uz * uz || 1e-9;
    const k = Math.max(0, Math.min(1, ((px - a.x) * ux + (pz - a.z) * uz) / l2));
    const d = Math.hypot(px - a.x - ux * k, pz - a.z - uz * k);
    const at = c0 + Math.sqrt(l2) * k;
    if (d < bd && at >= u0 - 0.01) {
      bd = d;
      best = at;
    } else if (best !== undefined && d > bd + 6) break;
  }
  return best;
}

/** 线 line 的第 i 个折点偏移到车道上（和 roadnet 的 offset 一样：前后两点的方向、拐角处按斜接放大），dir = −1 是逆着线走的车道 */
function laneVertex(line: Line, i: number, dir: 1 | -1, off: number): { x: number; z: number } {
  const p = line.pts[i] as V3;
  const a = line.pts[i - 1] as V3;
  const b = line.pts[i + 1] as V3;
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const dx = (b.x - a.x) / l;
  const dz = (b.z - a.z) / l;
  const ul = Math.hypot(p.x - a.x, p.z - a.z) || 1;
  const wl = Math.hypot(b.x - p.x, b.z - p.z) || 1;
  const cos = ((p.x - a.x) / ul) * ((b.x - p.x) / wl) + ((p.z - a.z) / ul) * ((b.z - p.z) / wl);
  const k = (dir * off) / Math.max(0.5, Math.sqrt((1 + cos) / 2));
  return { x: p.x - dz * k, z: p.z + dx * k };
}

/** 行程 arcs（车道 lane）在拼好的路径 tr 上各落在哪里：每条弧一段（见 RoadSpan）；只读几何，不改速度曲线 */
export function roadSpans(net: RoadNet, arcs: readonly Arc[], lane: number, tr: Track, uStart = 0): RoadSpan[] {
  const out: RoadSpan[] = [];
  let from = Math.max(0, uStart - 40);
  for (const arc of arcs) {
    const line = net.lines[arc.line];
    if (!line || line.pts.length < 3) continue;
    const dir: 1 | -1 = arc.s1 >= arc.s0 ? 1 : -1;
    const lo = Math.min(arc.s0, arc.s1);
    const hi = Math.max(arc.s0, arc.s1);
    const off = laneOffset(line.xs, lane);
    const L = line.len;
    // 线上的折点（不算两头；闭合的线把坐标挪到弧的范围里），折点之间按偏移后的两点插值补点
    const vs: { c: number; i: number }[] = [];
    for (let i = 1; i < line.pts.length - 1; i++)
      for (const c of line.closed ? [line.cum[i] as number, (line.cum[i] as number) + L, (line.cum[i] as number) - L] : [line.cum[i] as number]) if (c > lo - 60 && c < hi + 60) vs.push({ c, i });
    vs.sort((x, y) => x.c - y.c);
    const probes: { c: number; x: number; z: number }[] = [];
    for (let k = 0; k < vs.length; k++) {
      const v = vs[k] as { c: number; i: number };
      const p = laneVertex(line, v.i, dir, off);
      if (v.c > lo && v.c < hi) probes.push({ c: v.c, ...p });
      const w = vs[k + 1];
      if (!w || w.i !== v.i + 1) continue;
      const q = laneVertex(line, w.i, dir, off);
      const n = Math.floor((w.c - v.c) / 25);
      for (let j = 1; j <= n; j++) {
        const f = j / (n + 1);
        const c = v.c + (w.c - v.c) * f;
        if (c > lo && c < hi) probes.push({ c, x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f });
      }
    }
    if (dir < 0) probes.reverse();
    const us: number[] = [];
    const ss: number[] = [];
    for (const pr of probes) {
      const u = findOn(tr, pr.x, pr.z, from, us.length ? 120 : 900, 0.8);
      if (u === undefined || (us.length && u <= (us[us.length - 1] as number) + 0.05)) continue;
      us.push(u);
      ss.push(pr.c);
      from = u;
    }
    // 车道数比要走的车道少的路（单车道的匝道）：落在最外侧那条车道上
    if (us.length >= 2) out.push({ line: line.id, dir, lane: Math.max(0, Math.min(lane, line.xs.lanes - 1)), us, ss });
  }
  return out;
}

/** 一段道路上的行驶（交给社会车流的后台线程，见 traffic.ts 的 TruckRun）：车长、速度曲线的采样点、走过的道路弧 */
export interface RoadRun {
  len: number;
  tu: Float64Array;
  us: Float32Array;
  tv: Float32Array;
  spans: RoadSpan[];
}

/**
 * 一辆车在路上的各段行驶（社会车流里背景车让它）：速度曲线去掉匀加速连着的中间点。
 * delays：闭环现场里这辆车每分钟晚了多少秒（车按「计划时刻 = 现在 − 延误」画，见 vehicles.ts 的 planT），
 * 这时按实际时刻每 2 秒取一次位置（两点之间匀速）；end：几点收车（以后不在路上）
 */
export function roadRuns(m: Motion, delays?: Float32Array, end = Infinity, warp?: Warp): RoadRun[] {
  const out: RoadRun[] = [];
  const ls: LeadState = { u: 0, v: 0, a: 0 };
  // 和 vehicles.ts 的 planT 一样：还没出发的分钟按出发那一刻的延误
  const delayAt = (t: number): number => {
    const d = delays as Float32Array;
    const m0 = Math.max(0, Math.min(d.length - 1, Math.floor(t / 60)));
    let k = m0;
    while (k < d.length && !Number.isFinite(d[k] as number)) k++;
    return k < d.length ? (d[k] as number) : 0;
  };
  for (const leg of m.legs) {
    if (!leg.spans?.length || !leg.tu || !leg.tuS || !leg.tv || leg.rev || leg.tu.length < 2) continue;
    let tu: readonly number[] = leg.tu;
    let us: readonly number[] = leg.tuS;
    let tv: readonly number[] = leg.tv;
    if (delays && delays.length) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of delays) if (Number.isFinite(x)) [lo, hi] = [Math.min(lo, x), Math.max(hi, x)];
      if (!Number.isFinite(lo)) [lo, hi] = [0, 0];
      if (warp) hi += warpMax(warp);
      const T: number[] = [];
      const U: number[] = [];
      for (let t = Math.floor(leg.t0 + lo) - 2; t <= Math.min(end, leg.t1 + hi + 2); t += 2) {
        const tp = warp ? warpAt(warp, t - delayAt(t)) : t - delayAt(t);
        if (tp < leg.t0 || tp > leg.t1) continue;
        const u = Math.max(U.length ? (U[U.length - 1] as number) : -Infinity, leadState(leg, tp, ls).u);
        T.push(t);
        U.push(u);
      }
      if (T.length < 2) continue;
      // 每两点之间匀速：同一个时刻放两个点（前一截的速度、后一截的速度）
      const t2: number[] = [];
      const u2: number[] = [];
      const v2: number[] = [];
      for (let i = 0; i + 1 < T.length; i++) {
        const v = ((U[i + 1] as number) - (U[i] as number)) / ((T[i + 1] as number) - (T[i] as number));
        t2.push(T[i] as number, T[i + 1] as number);
        u2.push(U[i] as number, U[i + 1] as number);
        v2.push(v, v);
      }
      [tu, us, tv] = [t2, u2, v2];
    } else if (warp) {
      // 开着的段里车队间距只是整体晚一点（停一下、往前跳都在停着的段里）
      const d = warpDelay(warp, (leg.t0 + leg.t1) / 2);
      if (d) tu = tu.map((x) => x + d);
    }
    const n = tu.length;
    const keep = [0];
    const acc = (i: number) => ((tv[i + 1] as number) - (tv[i] as number)) / Math.max(1e-9, (tu[i + 1] as number) - (tu[i] as number));
    for (let i = 1; i < n - 1; i++) if (Math.abs(acc(i) - acc(i - 1)) > 1e-6 || us[i] === us[i - 1] || us[i + 1] === us[i]) keep.push(i);
    keep.push(n - 1);
    out.push({ len: m.L, tu: Float64Array.from(keep, (i) => tu[i] as number), us: Float32Array.from(keep, (i) => us[i] as number), tv: Float32Array.from(keep, (i) => tv[i] as number), spans: leg.spans });
  }
  return out;
}

/**
 * 车队间距（vehicles.ts 的 planConvoy）：画面上显示时刻 T → 运动时刻 M 的折线，斜率 1（照常走）或 0（停着多等一会儿），
 * 也可以在同一个 T 往前跳（停着的时候补回晚的时间）；d0 是第一个点以前晚的秒数。开着的段里只是整体晚一点，车不会在路上停或者跳。
 * Display-time → motion-time warp (slope 1 or 0, forward jumps only while standing).
 */
export interface Warp {
  d0: number;
  T: Float64Array;
  M: Float64Array;
}
/** 显示时刻 t 对应的运动时刻 */
export function warpAt(w: Warp, t: number): number {
  const T = w.T;
  const n = T.length;
  if (!n || t < (T[0] as number)) return t - w.d0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((T[mid] as number) <= t) lo = mid;
    else hi = mid - 1;
  }
  const t0 = T[lo] as number;
  const m0 = w.M[lo] as number;
  if (lo === n - 1) return m0 + (t - t0);
  const dT = (T[lo + 1] as number) - t0;
  return dT > 0 ? m0 + ((t - t0) * ((w.M[lo + 1] as number) - m0)) / dT : m0;
}
/** 运动时刻 tau（开着的段里）晚了多少秒 */
export function warpDelay(w: Warp, tau: number): number {
  const M = w.M;
  if (!M.length || tau < (M[0] as number)) return w.d0;
  let lo = 0;
  let hi = M.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((M[mid] as number) <= tau) lo = mid;
    else hi = mid - 1;
  }
  return (w.T[lo] as number) - (M[lo] as number);
}
/** 最多晚多少秒 */
export function warpMax(w: Warp): number {
  let d = w.d0;
  for (let k = 0; k < w.T.length; k++) d = Math.max(d, (w.T[k] as number) - (w.M[k] as number));
  return d;
}

/** 这次停靠按场地现在的排程排好（场地的排程变了就重排，和 legAt 用到时一样），返回它的几段 */
export function yardBlockLegs(m: Motion, yb: YardBlock): readonly MLeg[] {
  if (yb.ver !== siteVersion(yb.key)) resolveYard(m, yb);
  return yb.legs;
}

/** 按 [t0, t1] 排速度曲线（起步、加减速、弯道限速、红灯停在停止线后）；路长的按 step 米取样 */
export function driveOn(p: DrivePath, t0: number, t1: number, dyn: Dyn, free0: boolean, free1: boolean, act?: string, step = 3, queue?: QueueHook): MLeg {
  return driveLeg(p.track, p.pace, p.uStart, t0, t1, dyn, free0, free1, act, p.lights, step, queue);
}
/** 路线上第 i 个信号灯的停止线在哪（区域坐标；排队登记用它认是哪个路口的哪个进口） */
export function lightAt(p: DrivePath, i: number): { x: number; z: number; j: string } | undefined {
  const l = p.lights[i];
  if (!l) return undefined;
  const q = trackAt(p.track, l.s);
  return { x: q.x, z: q.z, j: l.j.id };
}

/** 倒车靠台（车尾领先）：沿 B 从 uFrom 倒到终点，用时 T */
export function reverseOn(B: Track, uFrom: number, t0: number, T: number, dyn: Dyn, act?: string): MLeg {
  return reverseLeg(B, uFrom, t0, T, dyn, act);
}

/**
 * 一维的速度曲线（列车车头沿铁路走的距离 0 → D）：起步加速、巡航、进站制动；free 的一头不停（开进 / 开出区域）。
 * 返回一个运动段（没有路径，只用 leadState 取距离、速度）。
 */
export function lineLeg(D: number, t0: number, t1: number, free0: boolean, free1: boolean, acc: number, dec: number): MLeg {
  // 两头（起步、制动的那几百米）每 2 米一个点，中间粗一些
  const E = Math.min(D / 2, 600);
  const s: number[] = [];
  for (let x = 0; x < E; x += 2) s.push(x);
  const mid = Math.max(1, Math.ceil((D - 2 * E) / 100));
  for (let k = 0; k < mid; k++) s.push(E + ((D - 2 * E) * k) / mid);
  for (let x = D - E; x < D - 1e-6; x += 2) if (x > (s[s.length - 1] as number) + 0.5) s.push(x);
  s.push(D);
  const sp: Spec = { s, cap: s.map(() => Infinity), rel: s.map(() => 1), acc: s.map(() => acc), dec: s.map(() => dec) };
  const { tu, tv, brake } = solve(sp, t0, t1 - t0, free0, free1);
  return { t0, t1, track: EMPTY, tu, tuS: s, tv, u: 0, rev: false, ...(brake ? { brake } : {}) };
}
const EMPTY: Track = { pts: [v3(0, 0, 0), v3(1, 0, 0)], cum: [0, 1], len: 1 };

// ———————————————————————— 构建 ————————————————————————

interface Piece {
  pts: V3[];
  /** 每个点的车速系数（道路，相对值；realize 给的）；场地是 LOT */
  pace: number[];
}

const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.z - b.z);
const dirAt = (pts: readonly V3[], end: boolean): { x: number; z: number } => {
  const n = pts.length;
  const a = end ? (pts[Math.max(0, n - 2)] as V3) : (pts[0] as V3);
  const b = end ? (pts[n - 1] as V3) : (pts[Math.min(n - 1, 1)] as V3);
  const l = dist(a, b) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
};

/** 把几段路径首尾接起来（断开的地方用贝塞尔曲线连，连接段取后一段的车速系数） */
function stitch(pieces: readonly Piece[]): { pts: V3[]; pace: number[] } {
  const pts: V3[] = [];
  const pace: number[] = [];
  for (const pc of pieces) {
    if (pc.pts.length < 2) continue;
    if (pts.length) {
      const a = pts[pts.length - 1] as V3;
      const b = pc.pts[0] as V3;
      if (dist(a, b) > 0.6) {
        for (const q of bezier(a, dirAt(pts, true), b, dirAt(pc.pts, false), 0.42).slice(1, -1)) {
          pts.push(q);
          pace.push(pc.pace[0] as number);
        }
      }
    }
    pc.pts.forEach((q, i) => {
      const last = pts[pts.length - 1];
      if (last && dist(last, q) < 0.05) return;
      pts.push(q.clone());
      pace.push(pc.pace[Math.min(i, pc.pace.length - 1)] as number);
    });
  }
  return { pts, pace };
}

/** 在开头加一段往后的直线（挂车在起点后面也有路可落） */
function withLeadIn(g: { pts: V3[]; pace: number[] }, len: number): { pts: V3[]; pace: number[]; lead: number } {
  const d = dirAt(g.pts, false);
  const a = g.pts[0] as V3;
  return { pts: [v3(a.x - d.x * len, a.y, a.z - d.z * len), ...g.pts], pace: [g.pace[0] as number, ...g.pace], lead: len };
}

/** 路径和每个点的属性一起去掉重复点 */
function trackOf(pts: readonly V3[], pace: readonly number[]): { track: Track; pace: number[] } {
  const keep: V3[] = [];
  const kp: number[] = [];
  pts.forEach((p, i) => {
    const last = keep[keep.length - 1];
    if (last && Math.hypot(p.x - last.x, p.z - last.z) <= 0.05) return;
    keep.push(p);
    kp.push(pace[i] ?? 1);
  });
  if (keep.length === 1) {
    keep.push((keep[0] as V3).clone().add(v3(0.1, 0, 0)));
    kp.push(kp[0] ?? 1);
  }
  return { track: makeTrack(keep), pace: kp };
}

export interface MotionOptions {
  L: number;
  /** 仿真的地点 → 三维的停车位：配送中心换成调度台排的月台门（没有就去车场），门店换成排的卸货口 */
  resolve: (key: string) => string | undefined;
  /** 车场里停哪个位置 */
  yard: number;
  /** 车道：0 = 最右 */
  lane: number;
  /** 线上配送车绕一圈去的路口 */
  loopTo?: (store: string, k: number) => string | undefined;
  /** 加减速（重型、中型、轻型车不一样） */
  dyn?: Dyn;
}

export function doorPlace(door: string | undefined): string | undefined {
  if (!door) return undefined;
  const n = Number(door.slice(1)) - 1;
  return door.startsWith('C') ? `DCC#${n}` : `DC#${n}`;
}

/**
 * 一辆车的运动。不认识的段（没有路线、没有地点）按仿真给的折线走（退路）。
 */
export function buildMotion(v: WVehicle, net: RoadNet, o: MotionOptions): Motion {
  const L = o.L;
  const dyn = o.dyn ?? DYN.heavy;
  const legs: MLeg[] = [];
  const yardKey = `DC:yard#${o.yard % 24}`;
  const placeOf = (key: string | undefined): { key: string; place: Place } | undefined => {
    if (!key) return undefined;
    const k = key.startsWith('DC:yard') ? key : (o.resolve(key) ?? (key === 'DC' ? yardKey : key));
    const place = net.places.get(k);
    return place ? { key: k, place } : undefined;
  };
  // 出区域的高速口（NORTH、EAST）的「地点」是从路口开到地图边上的那段高速：按高速开，在地图边上带着速度出现 / 消失
  const gate = (key: string | undefined) => !!key && key in OFFMAP_KM;
  // 车现在在哪：停在某个地点（倒车进去的 = rev），路径 + 领先点；yard：这个地点是登记了的收货场的门（进出走场地排程）
  let state: { key: string; place: Place; track: Track; u: number; rev: boolean; yard?: YardDoorRef } | undefined;
  const kind = yardKindOf(v);
  const blocks: YardBlock[] = [];
  const yardOf = (key: string | undefined) => (kind && key ? yardDoorOf(key) : undefined);
  const segs = v.segs;
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i] as WSeg;
    const next = segs[i + 1];
    if (sg.loop && sg.place) {
      legs.push(...vanLoop(sg, net, o, L, v.id, dyn));
      continue;
    }
    if (sg.route && sg.route.length > 1) {
      const route = sg.route;
      const first = route[0] as string;
      const last = route[route.length - 1] as string;
      const origin =
        state ??
        (() => {
          const p = placeOf(first === 'DC' ? yardKey : first);
          // 一出发就从收货场开出来（没有在门口停留的那一段）：从驶出点出发
          const py = p ? yardOf(p.key) : undefined;
          return p ? { ...p, track: makeTrack(p.place.path), u: 0, rev: false, ...(py ? { yard: py } : {}) } : undefined;
        })();
      const destKey = next && !next.route && next.place ? next.place : last === 'DC' ? yardKey : last;
      const dest = placeOf(destKey);
      const yd = dest ? yardOf(dest.key) : undefined;
      const pieces: Piece[] = [];
      let dockExit = false;
      // 有单独出场路的地点（机场货站：从卡车场开出来右转并进出场车道，不回进场路的尽头掉头）：道路从并进去的那一点开始
      const ox = origin?.place as (Place & PlaceExit) | undefined;
      if (origin) {
        if (origin.yard) {
          // 从收货场出来：车头在驶出点（场内的拉出、驶离由场地排程走完），沿出场的路接上道路
          pieces.push({ pts: yardLeave(origin.yard, origin.place, blocks[blocks.length - 1]), pace: [LOT] });
        } else if (origin.rev && origin.place.reverse) {
          const pRev = [origin.place.path[origin.place.path.length - 1] as V3, ...origin.place.reverse];
          pieces.push(...pullOut(reverse(pRev), ox?.exit ?? reverse(origin.place.path).slice(1), L));
          dockExit = true;
        } else pieces.push({ pts: ox?.exit ? [origin.place.path[origin.place.path.length - 1] as V3, ...ox.exit] : (origin.place.leave ?? reverse(origin.place.path)), pace: [gate(origin.key) ? 1 : LOT] });
      }
      const arcs = ox?.joinS ? trimArcs(net.routeArcs(route), ox.joinS) : net.routeArcs(route);
      const road = net.realize(arcs, () => o.lane);
      if (road.pts.length > 1) pieces.push({ pts: road.pts, pace: road.pace.map((p) => Math.max(0.05, p)) });
      if (dest && yd) {
        // 开往收货场：道路段在进场点结束（车头停在进场点），后面的排队、进场、倒车靠台由场地排程接着走
        pieces.push({ pts: yardApproach(yd, dest.place), pace: [LOT] });
      } else if (dest) {
        const ap = dest.place.path.map((p) => p.clone());
        if (dest.place.reverse && ap.length > 1) {
          const d = dirAt(ap, true);
          const e = ap[ap.length - 1] as V3;
          ap.push(v3(e.x + d.x * L, e.y, e.z + d.z * L));
        }
        pieces.push({ pts: ap, pace: [gate(dest.key) ? 1 : LOT] });
      }
      if (pieces.length === 0 || pieces.every((p) => p.pts.length < 2)) {
        legs.push(fallback(sg, dyn));
        state = undefined;
        continue;
      }
      const lead = withLeadIn(stitch(pieces), L + 2);
      const { track: tr, pace } = trackOf(lead.pts, lead.pace);
      const uStart = lead.lead + (dockExit ? L : 0);
      // 从停车位出发的从静止起步；从地图外开进来的（没有出发地点或从高速口进来）带着速度出现，开出地图的不减速
      // 路上的信号灯：红灯停、绿灯走（到达时刻仍然和仿真一样）
      legs.push(driveLeg(tr, pace, uStart, sg.t0, sg.t1, dyn, !origin || gate(origin.key), !dest || gate(dest.key), sg.act, stopLines(net, arcs, o.lane, tr, uStart)));
      (legs[legs.length - 1] as MLeg).spans = roadSpans(net, arcs, o.lane, tr, uStart);
      // 高速口在区域边上：开进来的车先在区域外的延长段上从远处开过来，开出区域的车接着开出视野（仿真时刻以外，只是画面）
      const main = legs[legs.length - 1] as MLeg;
      const prevEnd = legs.length > 1 ? Math.max(...legs.slice(0, -1).map((l) => l.t1)) : -Infinity;
      if (origin && gate(origin.key) && origin.place.offIn && origin.place.offIn.length > 1) {
        const lead = cruise(origin.place.offIn, sg.t0, main.tv?.[0] ?? 2.5, -1, sg.act);
        if (lead.t0 > prevEnd) legs.push(lead);
      }
      if (dest && gate(dest.key) && dest.place.offOut && dest.place.offOut.length > 1) {
        const tail = cruise(dest.place.offOut, sg.t1, main.tv?.[main.tv.length - 1] ?? 2.5, 1, sg.act);
        if (!next || tail.t1 < next.t0) legs.push(tail);
      }
      state = dest ? { ...dest, track: tr, u: tr.len, rev: false, ...(yd ? { yard: yd } : {}) } : undefined;
      continue;
    }
    // 停留
    const here = placeOf(sg.place);
    if (here && state && state.key === here.key && state.yard && kind) {
      // 收货场：这一段停留（连同后面紧接着的同一个地点的停留）交给场地排程
      let j = i;
      while (segs[j + 1] && !(segs[j + 1] as WSeg).route && !(segs[j + 1] as WSeg).loop && (segs[j + 1] as WSeg).place === sg.place) j++;
      const yb = yardBlock(v.id, i, j, state.yard, kind, L, sg.t0, (segs[j] as WSeg).t1, false, sg.act);
      blocks.push(yb);
      legs.push(...yb.legs);
      i = j;
      continue;
    }
    if (here && state && state.key === here.key) {
      if (!state.rev && here.place.reverse) {
        // 开过头了，倒车靠上月台 / 卸货口：车尾从开过头的位置倒进去
        const S = here.place.path[here.place.path.length - 1] as V3;
        const F = trackAt(state.track, state.u);
        const B = makeTrack([F, S, ...here.place.reverse]);
        const uFrom = Math.min(L, B.len);
        const D = B.len - uFrom;
        // 倒车用时不超过设施作业假定的靠台时刻（ops/dc.ts、storeDocks.ts：min(100 秒, 停留的 35%)）
        const rv = Math.min(100, (sg.t1 - sg.t0) * 0.35, Math.max(30, D / REVERSE_SPEED + 12));
        if (D > 0.3 && rv > 2) {
          legs.push(reverseLeg(B, uFrom, sg.t0, rv, dyn, sg.act));
          legs.push({ t0: sg.t0 + rv, t1: sg.t1, track: B, u: B.len, rev: true, act: sg.act });
        } else legs.push({ t0: sg.t0, t1: sg.t1, track: B, u: B.len, rev: true, act: sg.act });
        state = { ...here, track: B, u: B.len, rev: true };
      } else legs.push({ t0: sg.t0, t1: sg.t1, track: state.track, u: state.u, rev: state.rev, act: sg.act });
      continue;
    }
    const hy = here && !state ? yardOf(here.key) : undefined;
    if (here && hy && kind) {
      // 一开始就停在收货场的门口（出发前装车）：从 t0 起就靠着，走的时候按场地排程拉出、驶离
      let j = i;
      while (segs[j + 1] && !(segs[j + 1] as WSeg).route && !(segs[j + 1] as WSeg).loop && (segs[j + 1] as WSeg).place === sg.place) j++;
      const yb = yardBlock(v.id, i, j, hy, kind, L, sg.t0, (segs[j] as WSeg).t1, true, sg.act);
      blocks.push(yb);
      legs.push(...yb.legs);
      state = { ...here, track: makeTrack(here.place.path), u: 0, rev: false, yard: hy };
      i = j;
      continue;
    }
    if (here) {
      // 一开始就停在这里（比如出发前在月台装车）：倒着停进去
      if (here.place.reverse) {
        const S = here.place.path[here.place.path.length - 1] as V3;
        const B = makeTrack([S, ...here.place.reverse]);
        legs.push({ t0: sg.t0, t1: sg.t1, track: B, u: B.len, rev: true, act: sg.act });
        state = { ...here, track: B, u: B.len, rev: true };
      } else {
        const tr = makeTrack(here.place.path);
        legs.push({ t0: sg.t0, t1: sg.t1, track: tr, u: tr.len, rev: false, act: sg.act });
        state = { ...here, track: tr, u: tr.len, rev: false };
      }
      continue;
    }
    legs.push(fallback(sg, dyn));
    state = undefined;
  }
  legs.sort((a, b) => a.t0 - b.t0);
  // 里程：前进加、倒车减（车轮转角用）
  let odo = 0;
  for (const l of legs) {
    l.odo = odo;
    if (l.tu && l.tuS && l.tuS.length > 1) odo += (l.rev ? -1 : 1) * ((l.tuS[l.tuS.length - 1] as number) - (l.tuS[0] as number));
  }
  return { legs, L, t0: legs[0]?.t0 ?? 0, t1: legs[legs.length - 1]?.t1 ?? 0, ...(blocks.length ? { yards: blocks } : {}) };
}

/** 地点的出场路（places.ts）：从车位开出来走 exit，在离路口 joinS 米处并进道路 */
export interface PlaceExit {
  exit?: V3[];
  joinS?: number;
}
/** 行程序列的开头去掉 d 米（不够长的整段去掉） */
function trimArcs(arcs: readonly Arc[], d: number): Arc[] {
  const out = arcs.map((a) => ({ ...a }));
  let left = d;
  while (out.length && left > 0) {
    const a = out[0] as Arc;
    const len = Math.abs(a.s1 - a.s0);
    if (len - left > 8) {
      a.s0 += Math.sign(a.s1 - a.s0) * left;
      left = 0;
    } else {
      out.shift();
      left -= len;
    }
  }
  return out;
}

/**
 * 从月台 / 卸货口开出来的路：先沿倒进来的路往前拉出（车身原来就在这段上），再接回进来的路往回开。
 * 倒车前开过头的那一点常常是个回头弯（进来时开过门再倒，出去时往回走）：拐得比 100° 还急时，拉出一个车身多一点就
 * 转过去（stitch 用贝塞尔曲线接上），不在那一点原地掉头；接近 180° 的（要绕一圈）照原来的走。
 */
function pullOut(out: V3[], back: V3[], L: number): Piece[] {
  const n = out.length;
  const S = out[n - 1] as V3;
  // S 前面那个不重合的点（倒车路线的头一个点常常就是开过头的那一点，重复了）
  let ia = n - 2;
  while (ia > 0 && dist(out[ia] as V3, S) < 0.05) ia--;
  const a = out[ia] ?? S;
  const b = back[0];
  if (!b || n < 2) return [{ pts: [...out, ...back], pace: [LOT] }];
  const d1 = { x: S.x - a.x, z: S.z - a.z };
  const d2 = { x: b.x - S.x, z: b.z - S.z };
  const cos = (d1.x * d2.x + d1.z * d2.z) / ((Math.hypot(d1.x, d1.z) || 1) * (Math.hypot(d2.x, d2.z) || 1));
  const cum = cumulative(out);
  const keep = L + 1.5;
  if (cos > Math.cos((100 * Math.PI) / 180) || cos < Math.cos((150 * Math.PI) / 180) || (cum[n - 1] as number) < keep + 0.4) return [{ pts: [...out, ...back], pace: [LOT] }];
  const pts: V3[] = [out[0] as V3];
  for (let i = 1; i < n; i++) {
    if ((cum[i] as number) < keep) pts.push(out[i] as V3);
    else {
      const p = out[i - 1] as V3;
      const q = out[i] as V3;
      const k = (keep - (cum[i - 1] as number)) / ((cum[i] as number) - (cum[i - 1] as number) || 1);
      pts.push(v3(p.x + (q.x - p.x) * k, p.y + (q.y - p.y) * k, p.z + (q.z - p.z) * k));
      break;
    }
  }
  return [
    { pts, pace: [LOT] },
    { pts: back, pace: [LOT] },
  ];
}

/** 匀速沿 pts 开的一段：side = −1 在 tRef 开到终点（从远处开过来），1 从 tRef 起从起点开出去 */
function cruise(pts: readonly V3[], tRef: number, v: number, side: -1 | 1, act: string | undefined): MLeg {
  const track = makeTrack(pts);
  const T = track.len / Math.max(0.5, v);
  const t0 = side < 0 ? tRef - T : tRef;
  const t1 = side < 0 ? tRef : tRef + T;
  return { t0, t1, track, tu: [t0, t1], tuS: [0, track.len], tv: [v, v], u: 0, rev: false, ...(act ? { act } : {}) };
}

/** 没有车道模型可用时：按仿真的折线走（也是平稳起步、停车） */
function fallback(sg: WSeg, dyn: Dyn): MLeg {
  const pts: V3[] = [];
  for (let k = 0; k + 1 < sg.pts.length; k += 2) pts.push(v3(sg.pts[k] as number, 0, sg.pts[k + 1] as number));
  if (pts.length === 1) pts.push((pts[0] as V3).clone().add(v3(0.5, 0, 0)));
  const tr = makeTrack(pts);
  if (pts.length > 2 || tr.len > 1) return driveLeg(tr, tr.pts.map(() => 1), 0, sg.t0, sg.t1, dyn, false, false, sg.act);
  return { t0: sg.t0, t1: sg.t1, track: tr, u: 0, rev: false, act: sg.act };
}

/** 线上配送车：从门店侧面的配送位开出去，沿道路开到附近的路口，掉头靠边送货，再开回来 */
function vanLoop(sg: WSeg, net: RoadNet, o: MotionOptions, L: number, id: number, dyn: Dyn): MLeg[] {
  const store = sg.place as string;
  const bay = net.places.get(`${store}:van`);
  const to = o.loopTo?.(store, id);
  if (!bay || !to) return [fallback(sg, dyn)];
  const arcsOut = net.routeArcs([store, ...pathTo(net, store, to)]);
  const arcsBack = net.routeArcs([...pathTo(net, store, to)].reverse().concat(store));
  const out = net.realize(arcsOut, () => o.lane);
  const back = net.realize(arcsBack, () => o.lane);
  if (out.pts.length < 2 || back.pts.length < 2) return [fallback(sg, dyn)];
  // 到了路口掉头，接到回程车道的起点（送完货直接往回开，不用原地转身）
  const uturn = bezier(out.pts[out.pts.length - 1] as V3, dirAt(out.pts, true), back.pts[0] as V3, dirAt(back.pts, false), 1.1, 12);
  const go = stitch([
    { pts: reverse(bay.path), pace: [LOT] },
    { pts: out.pts, pace: out.pace },
    // 掉头是按真实尺寸的低速动作（和场地里一样），不按道路的车速系数
    { pts: uturn, pace: [LOT] },
  ]);
  const ret = stitch([
    { pts: back.pts, pace: back.pace },
    { pts: bay.path, pace: [LOT] },
  ]);
  const dur = sg.t1 - sg.t0;
  const tGo = sg.t0 + dur * 0.44;
  const tBack = sg.t0 + dur * 0.56;
  const a = withLeadIn(go, L + 2);
  const ta = trackOf(a.pts, a.pace);
  const b = withLeadIn(ret, L + 2);
  const tb = trackOf(b.pts, b.pace);
  const go1 = driveLeg(ta.track, ta.pace, a.lead, sg.t0, tGo, dyn, false, false, '出门送线上订单', stopLines(net, arcsOut, o.lane, ta.track, a.lead));
  const back1 = driveLeg(tb.track, tb.pace, b.lead, tBack, sg.t1, dyn, false, false, '回门店', stopLines(net, arcsBack, o.lane, tb.track, b.lead));
  go1.spans = roadSpans(net, arcsOut, o.lane, ta.track, a.lead);
  back1.spans = roadSpans(net, arcsBack, o.lane, tb.track, b.lead);
  return [go1, { t0: tGo, t1: tBack, track: ta.track, u: ta.track.len, rev: false, act: '在小区送货' }, back1];
}

/** 门店 → 它接入的节点 → 一个相邻节点（线上配送车送货绕的路） */
function pathTo(net: RoadNet, store: string, to: string): string[] {
  const nodeOf = [...net.edgeArcs.keys()].find((k) => k.startsWith(`${store}|`))?.split('|')[1];
  if (!nodeOf) return [to];
  return to === nodeOf ? [nodeOf] : [nodeOf, to];
}

// ———————————————————————— 船 ————————————————————————

/**
 * 船的一段：沿航线走（MLeg 的路径和速度曲线），或者靠离泊的动作——
 * slide：横移（船头朝向 dir 不变，船中心从 a 移到 b；拖轮在外海一侧顶推靠泊，或者带缆拖离码头）；
 * spin：在泊位正前方的掉头点原地掉头（拖轮在船首、船尾两侧反向推）。
 * sea：外海方向（单位向量，世界坐标）；escort：拖轮护航的时段。
 */
export interface ShipLeg extends MLeg {
  slide?: { ax: number; az: number; bx: number; bz: number; dir: number; tug: TugMode };
  spin?: { x: number; z: number; d0: number; turn: number };
  sea?: { x: number; z: number };
  escort?: [number, number];
}
export interface ShipMotion {
  legs: ShipLeg[];
  L: number;
  t0: number;
  t1: number;
}
/** 拖轮：'' 没有、escort 护航（船首、船尾外侧）、push 顶推靠泊、pull 拖离码头、swing 掉头（首尾在两侧反向推） */
export type TugMode = '' | 'escort' | 'push' | 'pull' | 'swing';
export interface ShipPose {
  x: number;
  z: number;
  /** 船头方向 atan2(dz, dx) */
  dir: number;
  moving: boolean;
  act: string | undefined;
  tug: TugMode;
  /** 外海在船的哪一舷：1 = 右舷（船头方向的右边），−1 = 左舷 */
  side: number;
  /** 掉头的方向：1 = 船头往右舷转 */
  turn: number;
}

/** 船的动力学（沙盘米 / 秒²：距离压缩 1/10，大船真实的加减速约 0.01–0.02） */
const SHIP_ACC = 0.0012;
const SHIP_DEC = 0.0018;
/**
 * 港内是真实尺寸，按港口里别家的大型船算：航道里平均 2.6 米 / 秒（起步、加速、减速、停住），掉头 0.3° / 秒，拖轮横移 0.16 米 / 秒；
 * 引航员在引航站上船停 10 分钟、下船停 6 分钟
 */
const HARBOR_V = 2.6;
const TURN_RATE = (0.3 * Math.PI) / 180;
const LAT_V = 0.16;
const PILOT_ON = 600;
const PILOT_OFF = 360;
/** 拖轮在离掉头点多远的地方接上护航（进港）、护航到离掉头点多远（出港） */
const ESCORT_IN = 650;
const ESCORT_OUT = 450;

/**
 * 近海的一段：harbor = 'in' 开到引航站（最后 700 米减速，最后 250 米慢慢停住）、'out' 从引航站出发（反过来），
 * 其他是近海航行（匀速，弯里稍慢）。
 */
function seaLeg(tr: Track, t0: number, t1: number, free0: boolean, free1: boolean, act: string | undefined, harbor?: 'in' | 'out'): ShipLeg {
  const s = sampleRange(tr, 0, tr.len, 8);
  const kap = curvature(tr, s, 30);
  const sp: Spec = { s, cap: s.map(() => Infinity), rel: [], acc: s.map(() => SHIP_ACC), dec: s.map(() => SHIP_DEC) };
  for (let i = 0; i < s.length; i++) {
    const x = s[i] as number;
    const d = harbor === 'in' ? tr.len - x : harbor === 'out' ? x : Infinity;
    const h = d >= 700 ? 1 : d >= 250 ? 0.55 + 0.45 * smooth((d - 250) / 450) : 0.25 + 0.3 * smooth(d / 250);
    sp.rel.push(h * bend(Math.abs(kap[i] as number), 400, 0.6));
  }
  const { tu, tv } = solve(sp, t0, t1 - t0, free0, free1);
  return { t0, t1, track: tr, tu, tuS: s, tv, u: 0, rev: false, ...(act ? { act } : {}) };
}

/** 港内航道的一段：停着起步、加速、减速、停住（和港口里别家的船起锚进港的速度曲线一样），采样成运动段 */
function harborLeg(tr: Track, t0: number, t1: number, act: string): ShipLeg {
  const T = t1 - t0;
  const n = 48;
  const tu: number[] = [];
  const tv: number[] = [];
  for (let k = 0; k <= n; k++) {
    tu.push(t0 + (T * k) / n);
    tv.push((tr.len / T) * (1 - Math.cos((2 * Math.PI * k) / n)));
  }
  // 位置按相邻两点之间匀加速积出来（和 leadState 的插值一致），再缩放到全长
  const tuS: number[] = [0];
  for (let k = 1; k <= n; k++) tuS.push((tuS[k - 1] as number) + (((tv[k - 1] as number) + (tv[k] as number)) / 2) * (T / n));
  const f = tr.len / ((tuS[n] as number) || 1);
  for (let k = 0; k <= n; k++) {
    tuS[k] = (tuS[k] as number) * f;
    tv[k] = (tv[k] as number) * f;
  }
  return { t0, t1, track: tr, tu, tuS, tv, u: 0, rev: false, act };
}

/** 运动段走到路程 s 的时刻 */
function timeAt(leg: ShipLeg, s: number): number {
  const tu = leg.tu as number[];
  const ts = leg.tuS as number[];
  for (let k = 1; k < ts.length; k++) {
    const b = ts[k] as number;
    if (b >= s) {
      const a = ts[k - 1] as number;
      return (tu[k - 1] as number) + ((tu[k] as number) - (tu[k - 1] as number)) * (b > a ? (s - a) / (b - a) : 0);
    }
  }
  return leg.t1;
}

const toPts = (flat: readonly number[]): V3[] => {
  const pts: V3[] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) pts.push(v3(flat[k] as number, 0, flat[k + 1] as number));
  return pts;
};
const unit = (a: V3, b: V3): { x: number; z: number } => {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
};
const heading = (d: { x: number; z: number }): number => Math.atan2(d.z, d.x);
const ahead = (h: number): { x: number; z: number } => ({ x: Math.cos(h), z: Math.sin(h) });
/** 从朝向 a 转到 b 的角度（−π…π，转小的那一边） */
function angTo(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
/** 停在 p、船头朝 d 的「路径」（停着的段用） */
const parked = (p: { x: number; z: number }, d: { x: number; z: number }): Track => makeTrack([v3(p.x - d.x * 2, 0, p.z - d.z * 2), v3(p.x, 0, p.z)]);
const stay = (p: V3, h: number, t0: number, t1: number, act: string, sea?: { x: number; z: number }): ShipLeg => ({ t0, t1, track: parked(p, ahead(h)), u: 2, rev: false, act, ...(sea ? { sea } : {}) });

/**
 * 进港靠泊（航线：外海 → 引航站 → 航道 → 掉头点 → 泊位，h 是泊位上的船首朝向）：近海航行到引航站减速停住、引航员上船；
 * 沿航道起步、加速、减速，停在泊位正前方的掉头点（最后一段拖轮护航）；原地掉头到泊位的朝向；拖轮顶着外海一侧的船舷横推靠上码头。
 * 港内几步按港口里别家的大型船的速度算，剩下的时间都是近海航行。
 */
function berthIn(pts: V3[], t0: number, t1: number, h: number): ShipLeg[] {
  const m = pts.length;
  const B = pts[m - 1] as V3;
  const T = pts[m - 2] as V3;
  const P = pts[1] as V3;
  const sea = unit(B, T);
  const fair = makeTrack(fillet(pts.slice(1, m - 1), 520, 14));
  const n = fair.pts.length;
  const hIn = heading(unit(fair.pts[n - 2] as V3, fair.pts[n - 1] as V3));
  const turn = angTo(hIn, h);
  let dPush = Math.hypot(B.x - T.x, B.z - T.z) / LAT_V;
  let dSpin = Math.abs(turn) / TURN_RATE;
  let dFair = (2 * fair.len) / HARBOR_V;
  let dPilot = PILOT_ON;
  // 时间不够（仿真给的进港时间太短）就按比例压缩港内几步，近海至少留 10 分钟
  const k = Math.min(1, (t1 - t0 - 600) / (dPush + dSpin + dFair + dPilot));
  dPush *= k;
  dSpin *= k;
  dFair *= k;
  dPilot *= k;
  const tB = t1 - dPush;
  const tA = tB - dSpin;
  const tF = tA - dFair;
  const tP = tF - dPilot;
  const out: ShipLeg[] = [];
  const near = makeTrack(pts.slice(0, 2));
  out.push({ ...seaLeg(near, t0, tP, true, false, '进港 · 近海航行', 'in'), sea });
  out.push(stay(P, heading(unit(pts[0] as V3, P)), tP, tF, '进港 · 引航员登船', sea));
  const run = harborLeg(fair, tF, tA, '进港 · 沿航道进港');
  out.push({ ...run, sea, escort: [timeAt(run, Math.max(0, fair.len - ESCORT_IN)), tA] });
  out.push({ ...stay(T, hIn, tA, tB, '进港 · 拖轮协助掉头', sea), spin: { x: T.x, z: T.z, d0: hIn, turn } });
  out.push({ ...stay(B, h, tB, t1, '进港 · 拖轮顶推靠泊', sea), slide: { ax: T.x, az: T.z, bx: B.x, bz: B.z, dir: h, tug: 'push' } });
  return out;
}

/**
 * 离泊出港（航线：泊位 → 掉头点 → 航道 → 引航站 → 外海，h 是泊位上的船首朝向）：拖轮带缆把船横着拖到掉头点；原地掉头对准出港航道；
 * 拖轮护航一段，沿航道起步、加速、减速，到引航站停住、引航员下船；再加速驶向外海。
 */
function berthOut(pts: V3[], t0: number, t1: number, h: number): ShipLeg[] {
  const m = pts.length;
  const B = pts[0] as V3;
  const T = pts[1] as V3;
  const P = pts[m - 2] as V3;
  const sea = unit(B, T);
  const fair = makeTrack(fillet(pts.slice(1, m - 1), 520, 14));
  const hOut = heading(unit(fair.pts[0] as V3, fair.pts[1] as V3));
  const turn = angTo(h, hOut);
  let dPull = Math.hypot(B.x - T.x, B.z - T.z) / LAT_V;
  let dSpin = Math.abs(turn) / TURN_RATE;
  let dFair = (2 * fair.len) / HARBOR_V;
  let dPilot = PILOT_OFF;
  const k = Math.min(1, (t1 - t0 - 600) / (dPull + dSpin + dFair + dPilot));
  dPull *= k;
  dSpin *= k;
  dFair *= k;
  dPilot *= k;
  const tA = t0 + dPull;
  const tB = tA + dSpin;
  const tF = tB + dFair;
  const tP = tF + dPilot;
  const out: ShipLeg[] = [];
  out.push({ ...stay(T, h, t0, tA, '离港 · 拖轮拖离码头', sea), slide: { ax: B.x, az: B.z, bx: T.x, bz: T.z, dir: h, tug: 'pull' } });
  out.push({ ...stay(T, h, tA, tB, '离港 · 拖轮协助掉头', sea), spin: { x: T.x, z: T.z, d0: h, turn } });
  const run = harborLeg(fair, tB, tF, '离港 · 沿航道出港');
  out.push({ ...run, sea, escort: [tB, timeAt(run, Math.min(fair.len, ESCORT_OUT))] });
  const far = makeTrack(pts.slice(m - 2));
  out.push(stay(P, heading(unit(P, pts[m - 1] as V3)), tF, tP, '离港 · 引航员下船', sea));
  out.push({ ...seaLeg(far, tP, t1, false, true, '离港 · 近海航行', 'out'), sea });
  return out;
}

/**
 * 船的运动：航线拐角倒成大圆弧，沿航线按速度曲线走。本店班轮的进港、离港段按 berthIn / berthOut 排成引航、航道、掉头、拖轮靠离泊几步
 * （泊位上船首的朝向在靠泊那一段的 yaw 里；港口作业按它摆岸桥和甲板上的箱）。
 */
export function shipMotion(v: WVehicle): ShipMotion {
  const legs: ShipLeg[] = [];
  let last: { track: Track; u: number; dir: number } | undefined;
  const segs = v.segs as WSeg[];
  for (let si = 0; si < segs.length; si++) {
    const sg = segs[si] as WSeg;
    const pts = toPts(sg.pts);
    const act = sg.act;
    const yawIn = segs[si + 1]?.yaw;
    if (pts.length >= 4 && /进港/.test(act ?? '') && yawIn !== undefined) {
      legs.push(...berthIn(pts, sg.t0, sg.t1, yawIn));
      last = { track: parked(pts[pts.length - 1] as V3, ahead(yawIn)), u: 2, dir: yawIn };
      continue;
    }
    const yawOut = last?.dir ?? segs[si - 1]?.yaw;
    if (pts.length >= 4 && /离港/.test(act ?? '') && yawOut !== undefined) {
      const out = berthOut(pts, sg.t0, sg.t1, yawOut);
      legs.push(...out);
      const end = out[out.length - 1] as ShipLeg;
      last = { track: end.track, u: end.track.len, dir: heading(unit(pts[pts.length - 2] as V3, pts[pts.length - 1] as V3)) };
      continue;
    }
    if (pts.length > 1) {
      const tr = makeTrack(fillet(pts, 520, 14));
      legs.push(seaLeg(tr, sg.t0, sg.t1, true, true, act));
      const e = unit(tr.pts[tr.pts.length - 2] as V3, tr.pts[tr.pts.length - 1] as V3);
      last = { track: tr, u: tr.len, dir: heading(e) };
    } else if (last) legs.push({ t0: sg.t0, t1: sg.t1, track: last.track, u: last.u, rev: false, ...(act ? { act } : {}) });
    else {
      // 当天一开始就停着（前一天靠的泊、锚地里等泊位的船）：靠泊的按 yaw 朝向，锚泊的船首朝东
      const p = pts[0] ?? v3(0, 0, 0);
      const d = ahead(sg.yaw ?? 0);
      const tr = parked(p, d);
      legs.push({ t0: sg.t0, t1: sg.t1, track: tr, u: tr.len, rev: false, ...(act ? { act } : {}) });
      last = { track: tr, u: tr.len, dir: heading(d) };
    }
  }
  return { legs, L: 280, t0: legs[0]?.t0 ?? 0, t1: legs[legs.length - 1]?.t1 ?? 0 };
}

const SA: XYZ = { x: 0, y: 0, z: 0 };
const SB: XYZ = { x: 0, y: 0, z: 0 };
const SL: LeadState = { u: 0, v: 0, a: 0 };

/** 船在时刻 t 的位置、朝向和拖轮的状态；不在场返回 false */
export function shipAt(m: ShipMotion, t: number, out: ShipPose): boolean {
  const leg = legAt(m, t) as ShipLeg | undefined;
  if (!leg) return false;
  const f = Math.max(0, Math.min(1, (t - leg.t0) / Math.max(1e-6, leg.t1 - leg.t0)));
  out.act = leg.act;
  out.tug = '';
  out.turn = 0;
  if (leg.slide) {
    const g = smoother(f);
    const sl = leg.slide;
    out.x = sl.ax + (sl.bx - sl.ax) * g;
    out.z = sl.az + (sl.bz - sl.az) * g;
    out.dir = sl.dir;
    out.moving = true;
    out.tug = sl.tug;
  } else if (leg.spin) {
    const sw = leg.spin;
    out.x = sw.x;
    out.z = sw.z;
    out.dir = sw.d0 + sw.turn * smoother(f);
    out.moving = true;
    out.tug = 'swing';
    out.turn = Math.sign(sw.turn);
  } else {
    const u = leadState(leg, t, SL).u;
    trackInto(leg.track, u, SA);
    out.x = SA.x;
    out.z = SA.z;
    trackInto(leg.track, Math.min(leg.track.len, u + 8), SA);
    trackInto(leg.track, Math.max(0, u - 8), SB);
    out.dir = Math.atan2(SA.z - SB.z, SA.x - SB.x);
    out.moving = !!leg.tu;
    if (leg.escort && t >= leg.escort[0] && t <= leg.escort[1]) out.tug = 'escort';
  }
  const sea = leg.sea;
  out.side = sea ? (-Math.sin(out.dir) * sea.x + Math.cos(out.dir) * sea.z >= 0 ? 1 : -1) : 1;
  return true;
}

// ———————————————————————— 收货场（@storewright/yard）：道路段在进场点结束，场内的排队、进场、倒车靠台、拉出、驶离按场地排程走 ————————————————————————

// 车型尺寸用三维车模的尺寸表（vehicles/specs.ts），场地排的车道、路线和画出来的车一样大；表里没有的用场地引擎的默认值
{
  const sp = SPECS as unknown as { RIG_DIMS?: Record<string, RigDims | undefined>; BODY_DIMS?: Record<string, BodyDims | undefined> };
  const r = sp.RIG_DIMS ?? {};
  const b = sp.BODY_DIMS ?? {};
  const pick = <T,>(x: T | undefined) => (x ? { ...x } : undefined);
  setVehicleDims({ semi: pick(r.semi), reefer: pick(r.reefer), chassis: pick(r.chassis), shunter: pick(r.shunter), truck: pick(b.truck), van: pick(b.van) } as Parameters<typeof setVehicleDims>[0], { road: pick(b.tractor), shunter: pick(b.shunter) } as Parameters<typeof setVehicleDims>[1]);
}

/**
 * 拖车串（机场的牵引车拖 2–4 节板车）：领头车沿路径走，后面每一节按追踪曲线跟着（内轮差）；
 * chain.at(领头车走过的距离, lead, units) 取每一节的车轴位置和朝向（朝向是 atan2(dx, dz)，换 three.js 的 yaw 减 π/2）。
 */
export function towTrain(tr: Track, units: readonly ChainUnit[]): TowChain {
  return new TowChain(tr.pts.map((q) => ({ x: q.x, z: q.z })), units);
}

/** 收货场的一个门：场地、门的下标 */
export interface YardDoorRef {
  site: YardSite;
  index: number;
  door: YardSite['doors'][number];
}

/** 仿真车的车型 → 场地引擎的车型（和 vehicles.ts 画的车一样：半挂、冷藏半挂、电动厢式车、面包车、集卡）；别的车不进收货场 */
export function yardKindOf(v: Pick<WVehicle, 'kind'>): YardVehicle | undefined {
  switch (v.kind as string) {
    case 'truck':
      return 'semi';
    case 'reefer':
      return 'reefer';
    case 'ev':
      return 'truck';
    case 'van':
      return 'van';
    case 'drayage':
      return 'chassis';
    default:
      return undefined;
  }
}

/** 地点 → 收货场的门：按场地登记的门编号找（三维的地点键，或调度台的门编号：DC#11 → D12、DCC#4 → C05） */
export function yardDoorOf(key: string): YardDoorRef | undefined {
  let hit = findYardDoor(key);
  if (!hit) {
    const m = /^(DCC?)#(\d+)$/.exec(key);
    if (m) hit = findYardDoor(`${m[1] === 'DCC' ? 'C' : 'D'}${String(Number(m[2]) + 1).padStart(2, '0')}`);
  }
  return hit ? { site: hit.site, index: hit.door.index, door: hit.door } : undefined;
}

/** 场地的进场点、驶出点和进场道路在场外那一头（区域坐标；y 取地点路径的高度） */
function yardGates(site: YardSite, y: number): { inW: V3; inFar: V3; outW: V3; outFar: V3 } {
  const p = site.plan;
  const u = p.from === 'back' ? 1 : -1;
  const w = (q: { x: number; z: number }) => {
    const g = yardToWorld(site.frame, q);
    return v3(g.x, y, g.z);
  };
  return { inW: w(p.gateIn), inFar: w({ x: p.xIn, z: p.gateIn.z - u * p.driveLen }), outW: w(p.gateOut), outFar: w({ x: p.xOut, z: p.gateOut.z - u * p.driveLen }) };
}

/** 开往收货场的最后一段路：地点的路径（场地搭建者让它在进场点结束）；没改的地点退而求其次：从离开道路的地方直接接到进场道路 */
function yardApproach(ref: YardDoorRef, place: Place): V3[] {
  const y = (place.path[place.path.length - 1] as V3 | undefined)?.y ?? 0;
  if (ref.door.approach && ref.door.approach.length > 1) return ref.door.approach.map((q) => v3(q.x, y, q.z));
  const g = yardGates(ref.site, y);
  const last = place.path[place.path.length - 1];
  if (last && Math.hypot(last.x - g.inW.x, last.z - g.inW.z) < 1.5) return place.path.map((q) => q.clone());
  const first = (place.path[0] as V3 | undefined) ?? g.inFar;
  return [first.clone(), g.inFar, g.inW];
}

/** 从收货场开出来：地点的出场路（从驶出点开始）；没有的退而求其次：沿进场道路出去、接回离开道路的地方 */
function yardLeave(ref: YardDoorRef, place: Place, yb?: YardBlock): V3[] {
  const y = (place.path[place.path.length - 1] as V3 | undefined)?.y ?? 0;
  // 这一次停靠自己的出场路（甩挂从甩挂区开出去）、门的出场路
  const own = yb ? yb.ids.map((id) => siteVisit(yb.key, id)?.leave).find((x) => x && x.length > 1) : undefined;
  const lv0 = own ?? ref.door.leave;
  if (lv0 && lv0.length > 1) return lv0.map((q) => v3(q.x, y, q.z));
  const g = yardGates(ref.site, y);
  const lv = place.leave ?? (place as Place & PlaceExit).exit;
  const first = lv?.[0];
  if (lv && first && Math.hypot(first.x - g.outW.x, first.z - g.outW.z) < 1.5) return lv.map((q) => q.clone());
  const back = (place.path[0] as V3 | undefined) ?? g.outFar;
  return [g.outW, g.outFar, back.clone()];
}

/** 一次收货场停靠：登记仿真车的访问（场地没登记这一辆时排程用它），先放一段停在进场点的占位，用到时按排程换成场内的运动 */
function yardBlock(vid: number, stop: number, lastStop: number, ref: YardDoorRef, kind: YardVehicle, L: number, t0: number, t1: number, initial: boolean, act: string | undefined): YardBlock {
  const key = ref.site.key;
  const base = simVisitFor(key, vid, stop, kind, ref.index, t0, t1);
  // 连着几段停在同一个地点算一次停靠：场地按其中任何一段登记都认（编号都是这次停靠的）
  const ids: string[] = [];
  for (let k = stop; k <= lastStop; k++) ids.push(simVisitId(vid, k));
  if (base) addSimVisit(key, initial ? { ...base, arrive: t0 - 1200, dockAt: t0 } : base, ids.slice(1));
  const yb: YardBlock = { key, id: ids[0] as string, ids, door: ref.index, kind, L, t0, t1, initial, ver: -1, legs: [], y: 0, ...(act ? { act } : {}) };
  yb.legs = [placeholder(yb)];
  return yb;
}

const newPose = (): RigPose => ({ x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 });

/** 占位：整段停在进场点（车头在进场点）；场地没登记或排程里没有这一辆时就这样 */
function placeholder(yb: YardBlock): MLeg {
  const site = yardSite(yb.key);
  const g = site ? yardGates(site, yb.y) : undefined;
  const tr = makeTrack(g ? [g.inFar, g.inW] : [v3(0, 0, 0), v3(1, 0, 0)]);
  return { t0: yb.t0, t1: yb.t1, track: tr, u: tr.len, rev: false, yb, ...(yb.act ? { act: yb.act } : {}) };
}

/** 按场地现在的排程重排一次停靠的运动段（换掉原来的几段） */
function resolveYard(m: Motion, yb: YardBlock): void {
  yb.ver = siteVersion(yb.key);
  const site = yardSite(yb.key);
  let tl: YardTimeline | undefined;
  // 场地给了整次停靠的几段（甩挂）：直接按它走，不用排程
  const sv = site ? yb.ids.map((id) => siteVisit(yb.key, id)).find((x) => x?.script?.length) : undefined;
  if (site && sv?.script) {
    m.legs.splice(Math.max(0, m.legs.indexOf(yb.legs[0] as MLeg)), m.legs.includes(yb.legs[0] as MLeg) ? yb.legs.length : 0, ...(yb.legs = pieceLegs(sv.script, yb, approachEnd(site, yb), true)));
    return;
  }
  if (site) for (const id of yb.ids) if ((tl = siteTimeline(yb.key, id))) break;
  // 场地把这辆仿真车排成了甩挂（没有自己靠台、拉出的时间线）：画面上这辆车还是整车进出，单独排一条自己靠台的路线
  if (site && tl && !tl.segs.some((x) => x.kind === 'pullout')) tl = scheduleYard(site.plan, [{ ...tl.visit, mode: 'live' }]).timelines[0];
  let legs: MLeg[];
  try {
    legs = site && tl ? yardLegs(site, tl, yb) : [placeholder(yb)];
  } catch {
    legs = [placeholder(yb)];
  }
  const i0 = m.legs.indexOf(yb.legs[0] as MLeg);
  if (i0 >= 0) m.legs.splice(i0, yb.legs.length, ...legs);
  else {
    m.legs.push(...legs);
    m.legs.sort((a, b) => a.t0 - b.t0);
  }
  yb.legs = legs;
}

interface YSample {
  t: number;
  nx: number;
  nz: number;
  kx: number;
  kz: number;
  hk: number;
  ht: number;
}

/**
 * 场地排程 → 运动段。时刻对上仿真：道路段在 t0 把车头送到进场点，下一段道路在 t1 从驶出点出发；
 * 排程里车头开到驶出点的时刻（outAt）不正好是 t1 时（窗口太紧、等场地空出来），拉出驶离那一段按比例压到正好 t1 到驶出点，
 * 进场到靠稳那一段要是挤到了拉出之后，也按比例压进去。时刻换算是分段线性的，位姿都取排程本身的（poseAt）。
 */
function yardLegs(site: YardSite, tl: YardTimeline, yb: YardBlock): MLeg[] {
  const t1 = yb.t1;
  // 整次停靠按场地给的几段走（甩挂）；进场点以前的几段（登记亭、等候区）先走完，场内的从最后一段的终点接上
  const lastTr = approachEnd(site, yb);
  if (tl.visit.script?.length) return pieceLegs(tl.visit.script, yb, lastTr, true);
  const preLegs = tl.visit.pre?.length ? pieceLegs(tl.visit.pre, yb, lastTr, false) : [];
  const t0 = preLegs.length ? Math.min(t1 - 1, Math.max(yb.t0, (preLegs[preLegs.length - 1] as MLeg).t1)) : yb.t0;
  const pull = tl.segs.find((x) => x.kind === 'pullout');
  const exStart = pull?.t0 ?? tl.outAt;
  const D = Math.max(1, tl.outAt - exStart);
  // 一开始就靠在门上（出发前装车）：场地排程里那樘门这时还被前一辆占着（靠稳晚了半分钟以上）就不当场靠着，
  // 按排程先在场里等、再进来靠台（不叠在前一辆上）
  const initial = yb.initial && tl.dockedAt <= yb.t0 + 30;
  // 拉出驶离：正好在 t1 车头到驶出点
  let tEx = t1 - D;
  const dockedT = initial ? t0 : Math.min(tl.dockedAt, t1);
  const minDock = initial ? t0 : t0 + Math.max(5, tl.dockedAt - tl.visit.arrive) * 0.5;
  if (tEx < Math.max(minDock, t0) + 20) tEx = Math.max(t0 + 1, Math.min(t1 - 0.4 * D, Math.max(minDock, t0) + 20));
  // 进场到靠稳：[到达, 靠稳] → [t0, tDock]
  const tDock = initial ? t0 : Math.min(dockedT, tEx - 10);
  // 排程里的到达比道路段到进场点晚（场地要先登记、查验）：在进场点等到那一刻，之后按排程的时刻走；放不下才按比例压
  const aT = tl.visit.arrive;
  const tA = Math.max(t0, Math.min(aT, tDock - 1));
  const mapIn = (t: number) => (tDock > tA ? aT + ((t - tA) / (tDock - tA)) * (tl.dockedAt - aT) : tl.dockedAt);
  const mapOut = (t: number) => exStart + ((t - tEx) / Math.max(1e-6, t1 - tEx)) * D;
  const toBlock = (tau: number) => (tl.dockedAt > aT ? tA + ((tau - aT) / (tl.dockedAt - aT)) * (tDock - tA) : tA);
  const ys: YardLegBuild = { site, yb, dims: undefined };
  const out: MLeg[] = [];
  if (!initial && tDock > t0 + 0.5) {
    const tJoin = Math.max(t0, Math.min(tDock, toBlock(tl.joinAt)));
    const tBack = Math.max(tJoin, Math.min(tDock, toBlock(tl.backAt)));
    if (tJoin > t0 + 0.25) {
      const wait = stillLeg(ys, sample(ys, tl, aT, t0), t0, tJoin, false);
      // 本来一开始就靠着的车（门还被占着）：等的时候在场外（不画在进场点上，那里有排队的外来货车），轮到它进场才出现
      if (yb.initial) wait.hidden = true;
      out.push(wait);
    }
    if (tBack > tJoin + 0.25) out.push(movingLeg(ys, tl, tJoin, tBack, mapIn, false));
    if (tDock > tBack + 0.25) out.push(movingLeg(ys, tl, tBack, tDock, mapIn, true));
  }
  // 靠着：停在门口（倒车进来的，按倒车的样子停）
  const parked = sample(ys, tl, tl.dockedAt + 0.01, Math.max(t0, tDock));
  if (tEx > Math.max(t0, tDock) + 0.25) out.push(stillLeg(ys, parked, Math.max(t0, tDock), tEx, true));
  if (t1 > tEx + 0.25) out.push(movingLeg(ys, tl, tEx, t1, mapOut, false));
  if (!out.length) out.push(placeholder(yb));
  out.unshift(...preLegs);
  // 首尾对齐停留时段
  (out[0] as MLeg).t0 = yb.t0;
  (out[out.length - 1] as MLeg).t1 = t1;
  for (let i = 1; i < out.length; i++) (out[i] as MLeg).t0 = (out[i - 1] as MLeg).t1;
  for (const l of out) l.yb = yb;
  return out;
}

/** 道路段结束的地方（门的 approach 的最后一段）：进场点以前的几段从这里接 */
function approachEnd(site: YardSite, yb: YardBlock): Track | undefined {
  const ap = site.doors.find((d) => d.index === yb.door)?.approach;
  if (!ap || ap.length < 2) return undefined;
  const a = ap[ap.length - 2] as { x: number; z: number };
  const b = ap[ap.length - 1] as { x: number; z: number };
  return makeTrack([v3(a.x, yb.y, a.z), v3(b.x, yb.y, b.z)]);
}

/** 场地给的几段（按时刻）→ 运动段：开的段起停平稳、正好在给的时刻到；停的段停在上一段的终点；空车头不画挂车 */
function pieceLegs(pieces: readonly YardPiece[], yb: YardBlock, start: Track | undefined, whole: boolean): MLeg[] {
  const out: MLeg[] = [];
  let tr = start;
  let rev = false;
  let bob = false;
  for (const pc of pieces) {
    if (pc.t1 <= pc.t0) continue;
    if (pc.kind !== 'stop' && pc.pts && pc.pts.length > 1) {
      tr = makeTrack(pc.pts.map((q) => v3(q.x, yb.y, q.z)));
      rev = pc.kind === 'back';
      bob = !!pc.bobtail;
      const leg = lineLeg(tr.len, pc.t0, pc.t1, false, false, 0.5, 0.8);
      leg.track = tr;
      leg.rev = rev;
      // 倒车：领先点是车尾（零件在 u − L + x），pts 是牵引销的路，牵引销在车尾前面 L − 车头到牵引销
      if (rev && leg.tuS) {
        const off = yb.L - 4.4;
        leg.tuS = leg.tuS.map((x) => x + off);
        leg.u = (leg.tuS[0] as number) ?? off;
      }
      if (bob) leg.bobtail = true;
      if (yb.act) leg.act = yb.act;
      out.push(leg);
    } else if (tr) out.push({ t0: pc.t0, t1: pc.t1, track: tr, u: rev ? tr.len + yb.L - 4.4 : tr.len, rev, ...(bob ? { bobtail: true } : {}), ...(yb.act ? { act: yb.act } : {}) });
  }
  if (whole && out.length) {
    (out[0] as MLeg).t0 = yb.t0;
    (out[out.length - 1] as MLeg).t1 = yb.t1;
  }
  for (let i = 1; i < out.length; i++) (out[i] as MLeg).t0 = Math.max((out[i] as MLeg).t0, (out[i - 1] as MLeg).t1);
  for (const l of out) l.yb = yb;
  return out;
}

interface YardLegBuild {
  site: YardSite;
  yb: YardBlock;
  dims: VehicleDims | undefined;
  /** 上一个取到的样子（排程时刻超出时间线时沿用，不跳） */
  last?: YSample;
}

/** 排程时刻 tau 的样子（车头和参考点的区域坐标、朝向），记在块时刻 t */
function sample(b: YardLegBuild, tl: YardTimeline, tau: number, t: number): YSample {
  const info = yardPoseAt(tl, tau);
  const u = info?.units[0];
  if (!u && b.last) return { ...b.last, t };
  const pose = u?.pose ?? newPose();
  if (u) b.dims = u.dims;
  const f = b.site.frame;
  const k = yardToWorld(f, pose);
  const front = u ? frontOf(u.dims) : 0;
  const n = yardToWorld(f, { x: pose.x + front * Math.sin(pose.heading), z: pose.z + front * Math.cos(pose.heading) });
  b.last = { t, nx: n.x, nz: n.z, kx: k.x, kz: k.z, hk: yawOf(f, pose.heading), ht: yawOf(f, pose.trailer) };
  return b.last;
}

/** 停着的一段 */
function stillLeg(b: YardLegBuild, p: YSample, ta: number, tb: number, rev: boolean): MLeg {
  const y = b.yb.y;
  const dir = { x: Math.cos(p.hk), z: -Math.sin(p.hk) };
  const tr = makeTrack([v3(p.nx - dir.x * 0.5, y, p.nz - dir.z * 0.5), v3(p.nx, y, p.nz)]);
  const sN = tr.len;
  const dims = b.dims ?? { kind: 'body', length: 5, width: 2, wheelbase: 3, rearOverhang: 1 };
  const ys: YardSamples = { s: Float64Array.of(sN), kx: Float64Array.of(p.kx), kz: Float64Array.of(p.kz), hk: Float64Array.of(p.hk), ht: Float64Array.of(p.ht), dims, y };
  return { t0: ta, t1: tb, track: tr, u: rev ? sN + b.yb.L : sN, rev, ys, ...(b.yb.act ? { act: b.yb.act } : {}) };
}

/** 动着的一段：每 0.5 秒取一次排程的位姿；track 是车头走过的路，tuS 是车头走过的距离（倒车时加整车长，和 partPose 的约定一样） */
function movingLeg(b: YardLegBuild, tl: YardTimeline, ta: number, tb: number, map: (t: number) => number, rev: boolean): MLeg {
  const y = b.yb.y;
  const n = Math.max(2, Math.ceil((tb - ta) / 0.5) + 1);
  const smp: YSample[] = [];
  for (let k = 0; k < n; k++) {
    const t = ta + ((tb - ta) * k) / (n - 1);
    smp.push(sample(b, tl, map(t), t));
  }
  // 车头的路：比上一个留下的点远 5 厘米以上才留；每个采样的距离 = 上一个留下的点的距离 + 到它的直线距离
  const pts: V3[] = [];
  const cum: number[] = [];
  const s = new Float64Array(n);
  let lastS = 0;
  smp.forEach((q, k) => {
    const last = pts[pts.length - 1];
    if (!last) {
      pts.push(v3(q.nx, y, q.nz));
      cum.push(0);
      s[k] = 0;
      return;
    }
    const d = Math.hypot(q.nx - last.x, q.nz - last.z);
    if (d > 0.05) {
      lastS = (cum[cum.length - 1] as number) + d;
      pts.push(v3(q.nx, y, q.nz));
      cum.push(lastS);
      s[k] = lastS;
    } else s[k] = (cum[cum.length - 1] as number) + d;
  });
  // 保证不减（停着的时候可能有一点点抖动）
  for (let k = 1; k < n; k++) if ((s[k] as number) < (s[k - 1] as number)) s[k] = s[k - 1] as number;
  const tr = makeTrack(pts.length > 1 ? pts : [pts[0] as V3, v3((pts[0] as V3).x + 0.1, y, (pts[0] as V3).z)]);
  const dims = b.dims ?? { kind: 'body', length: 5, width: 2, wheelbase: 3, rearOverhang: 1 };
  const ys: YardSamples = { s, kx: Float64Array.from(smp, (q) => q.kx), kz: Float64Array.from(smp, (q) => q.kz), hk: Float64Array.from(smp, (q) => q.hk), ht: Float64Array.from(smp, (q) => q.ht), dims, y };
  const off = rev ? b.yb.L : 0;
  const tu = smp.map((q) => q.t);
  const tuS = Array.from(s, (x) => x + off);
  return { t0: ta, t1: tb, track: tr, tu, tuS, u: tuS[0] as number, rev, ys, ...(b.yb.act ? { act: b.yb.act } : {}) };
}

/** 收货场里的零件：按采样插值出参考点和朝向，再按零件的锚点摆（铰接车参考点是牵引销，单体车是后轴） */
function yardPartPose(ys: YardSamples, sN: number, p: PartSpec, scale: number, out: PartPose): PartPose {
  const s = ys.s;
  const n = s.length;
  let i = 0;
  if (n > 1) {
    if (sN >= (s[n - 1] as number)) i = n - 1;
    else if (sN > (s[0] as number)) {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((s[mid] as number) <= sN) lo = mid;
        else hi = mid;
      }
      i = lo;
    }
  }
  const j = Math.min(n - 1, i + 1);
  const span = (s[j] as number) - (s[i] as number);
  const f = span > 1e-9 ? Math.max(0, Math.min(1, (sN - (s[i] as number)) / span)) : 0;
  const lerp = (A: Float64Array) => (A[i] as number) + ((A[j] as number) - (A[i] as number)) * f;
  const alerp = (A: Float64Array) => {
    let d = (A[j] as number) - (A[i] as number);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return (A[i] as number) + d * f;
  };
  const kx = lerp(ys.kx);
  const kz = lerp(ys.kz);
  const towed = ys.dims.kind === 'rig' && TOWED.test(p.slot);
  const yaw = towed ? alerp(ys.ht) : alerp(ys.hk);
  const dx = Math.cos(yaw);
  const dz = -Math.sin(yaw);
  // 挂车：前锚点就是牵引销；牵引车、单体车：前锚点在参考点前 (ra − fa)
  const reach = towed ? 0 : (p.ra - p.fa) * scale;
  const fx = kx + dx * reach;
  const fz = kz + dz * reach;
  out.x = fx - dx * p.ax * scale;
  out.z = fz - dz * p.ax * scale;
  out.y = ys.y + (p.y ?? 0) * scale;
  out.yaw = yaw;
  out.pitch = 0;
  return out;
}

// ———————————————————————— 道路上的铰接运动学 ————————————————————————

const TOW_STEP = 0.5;
const towMemo = { leg: undefined as MLeg | undefined, s: NaN, ls: NaN, ax: 0, az: 0 };

/** 前进时的挂车：牵引销在路径上，车轴按追踪曲线跟着（从牵引销往回 5 倍轴距处摆直开始积分） */
function towedForward(leg: MLeg, u: number, p: PartSpec, scale: number, out: PartPose): PartPose {
  const sK = u - p.fa * scale;
  const Ls = Math.max(0.5, (p.ra - p.fa) * scale);
  let ax: number;
  let az: number;
  if (towMemo.leg === leg && towMemo.s === sK && towMemo.ls === Ls) {
    ax = towMemo.ax;
    az = towMemo.az;
  } else {
    const s0 = sK - 5 * Ls;
    trackInto(leg.track, s0, PK);
    trackInto(leg.track, s0 - 0.5, PA);
    let dx = PK.x - PA.x;
    let dz = PK.z - PA.z;
    let l = Math.hypot(dx, dz) || 1;
    ax = PK.x - (dx / l) * Ls;
    az = PK.z - (dz / l) * Ls;
    const n = Math.max(1, Math.ceil((sK - s0) / TOW_STEP));
    for (let k = 1; k <= n; k++) {
      trackInto(leg.track, s0 + ((sK - s0) * k) / n, PK);
      dx = PK.x - ax;
      dz = PK.z - az;
      l = Math.hypot(dx, dz) || 1;
      ax = PK.x - (dx / l) * Ls;
      az = PK.z - (dz / l) * Ls;
    }
    towMemo.leg = leg;
    towMemo.s = sK;
    towMemo.ls = Ls;
    towMemo.ax = ax;
    towMemo.az = az;
  }
  const f = trackInto(leg.track, sK, PF);
  const r = trackInto(leg.track, sK - Ls, PR);
  let dx = f.x - ax;
  let dz = f.z - az;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  out.x = f.x - dx * p.ax * scale;
  out.z = f.z - dz * p.ax * scale;
  out.y = (f.y + r.y) / 2 + (p.y ?? 0) * scale;
  out.yaw = Math.atan2(-dz, dx);
  out.pitch = Math.atan2(f.y - r.y, Ls);
  return out;
}

/** 铰接车：整车长 → 牵引销、挂车车轴离车头多远（按车型尺寸表；同一个长度的车型尺寸相同） */
const RIG_BY_L: Array<{ L: number; kp: number; axle: number }> = (() => {
  const sp = SPECS as unknown as { RIG_DIMS?: Record<string, RigDims | undefined> };
  const list = Object.values(sp.RIG_DIMS ?? {}).filter((r): r is RigDims => !!r && r.kind === 'rig');
  if (!list.length) list.push({ kind: 'rig', front: 4.4, tractorRear: 1.6, trailerFront: 1.2, rear: 12.4, axle: 9.5, width: 2.55, wheelbase: 3.3 });
  return list.map((r) => ({ L: r.front + r.rear, kp: r.front, axle: r.front + r.axle }));
})();
function rigOfLength(L: number): { kp: number; axle: number } | undefined {
  let best: { L: number; kp: number; axle: number } | undefined;
  for (const r of RIG_BY_L) if (Math.abs(r.L - L) < 0.06 && (!best || Math.abs(r.L - L) < Math.abs(best.L - L))) best = r;
  return best;
}

/** 倒车时挂车车轴在路径 sA 处：牵引销 = 车轴 + 挂车朝向 × 轴距；挂车朝向（车头方向）是路径方向的反方向 */
function kingpinRev(tr: Track, sA: number, Ls: number, out: { kx: number; kz: number; dx: number; dz: number; ax: number; az: number; y: number }): void {
  trackInto(tr, sA + 0.5, PF);
  trackInto(tr, sA - 0.5, PR);
  let dx = PR.x - PF.x;
  let dz = PR.z - PF.z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  trackInto(tr, sA, PA);
  out.ax = PA.x;
  out.az = PA.z;
  out.y = PA.y;
  out.dx = dx;
  out.dz = dz;
  out.kx = PA.x + dx * Ls;
  out.kz = PA.z + dz * Ls;
}
const KR0 = { kx: 0, kz: 0, dx: 0, dz: 0, ax: 0, az: 0, y: 0 };
const KR1 = { kx: 0, kz: 0, dx: 0, dz: 0, ax: 0, az: 0, y: 0 };
const KR2 = { kx: 0, kz: 0, dx: 0, dz: 0, ax: 0, az: 0, y: 0 };

/** 倒车的挂车和牵引车（车尾领先：零件坐标 x 在 u − L + x） */
function reversePart(leg: MLeg, u: number, L: number, p: PartSpec, scale: number, rig: { kp: number; axle: number }, towed: boolean, out: PartPose): PartPose {
  const sA = u - L * scale + rig.axle * scale;
  const Ls = Math.max(0.5, (rig.axle - rig.kp) * scale);
  kingpinRev(leg.track, sA, Ls, KR0);
  let dx: number;
  let dz: number;
  let fx: number;
  let fz: number;
  if (towed) {
    dx = KR0.dx;
    dz = KR0.dz;
    fx = KR0.kx;
    fz = KR0.kz;
  } else {
    // 牵引车朝向 = 牵引销运动方向的反方向（倒车时路径方向就是运动方向）
    kingpinRev(leg.track, sA - 0.75, Ls, KR1);
    kingpinRev(leg.track, sA + 0.75, Ls, KR2);
    let tx = KR1.kx - KR2.kx;
    let tz = KR1.kz - KR2.kz;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-4) {
      tx = KR0.dx;
      tz = KR0.dz;
    } else {
      tx /= tl;
      tz /= tl;
    }
    // 起步的 4 米里从和挂车摆直平滑过渡
    const sA0 = (leg.tuS?.[0] ?? leg.u) - L * scale + rig.axle * scale;
    const w = smoother(Math.max(0, Math.min(1, (sA - sA0) / 4)));
    const a0 = Math.atan2(KR0.dz, KR0.dx);
    let da = Math.atan2(tz, tx) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const a = a0 + da * w;
    dx = Math.cos(a);
    dz = Math.sin(a);
    fx = KR0.kx + dx * (p.ra - p.fa) * scale;
    fz = KR0.kz + dz * (p.ra - p.fa) * scale;
  }
  out.x = fx - dx * p.ax * scale;
  out.z = fz - dz * p.ax * scale;
  out.y = KR0.y + (p.y ?? 0) * scale;
  out.yaw = Math.atan2(-dz, dx);
  out.pitch = 0;
  return out;
}
