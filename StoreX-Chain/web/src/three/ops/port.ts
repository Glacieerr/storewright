import * as THREE from 'three';
import { JunctionBook, junctionSpan } from '../../../../src/hub/portLayout';
import { isNight, Lamps, type LampState } from './lamps';
import type { LampSpec } from '../fleet';
import { box, cyl, merge, wheel, type Part } from '../../../../../StoreX/web/src/three/models';
import { boxShip, hullBays, tug, type HullSpec } from '../craft';
import { fillet, v3 } from '../geo';
import { currentFacilities } from '../../../../src/facility/state';
import { minCrew, type PortCfg } from '../../../../src/facility/config';
import { BOX_COLORS, clamp01, containerGeometry, drain, ease, lerp, Poly, Pool, prog, REEFER_BOX, rng, rodGeometry, rounded, STORE_BOX, type At, type Steps } from './kit';
import { floatY, SEA_MEAN, TIDE_AMP, tideInfo } from '../tide';
import { planPortHub, type PortHubPlan } from '../../../../src/hub/port';
import { HUB_SLOT, HUB_SLOTS, type HubDay } from '../../../../src/hub/types';
import { PortLogistics, type PortLogisticsInfo } from './portLogistics';

/**
 * 集装箱港口（按真实尺寸画；只有设施之间的距离在沙盘里压缩了）。整个港口按自己的局部坐标画：码头沿 x，海在 +z 一侧；
 * 区域生成器决定港口放在哪里、朝哪个方向（整体平移、旋转），这里不用区域里的坐标。
 *
 * - 码头：混凝土岸线、系缆桩、护舷、两条岸桥轨道（轨距 30 米）；泊位按设施配置 2–4 个（每个 330 米），一个留给本店班轮，
 *   其余停别家的船，每个泊位有自己的岸桥（门架、后伸距、可俯仰的前大梁——不作业时仰起、A 字架和拉杆、机房、带司机室的小车、吊具和钢丝绳）；
 * - 堆场：每个泊位后面一列箱区（3 排，每个箱区 24 个贝位 × 6 列，堆 1–5 层），每个箱区一台轮胎式龙门吊（跨 6 列 + 一条集卡道）；
 * - 场内集卡（码头拖车）：每台岸桥配几辆，岸桥卸下的箱放到拖车上，拖车开到箱区，龙门吊把箱堆好；装船反过来；
 * - 闸口：雨棚、岗亭、道闸和识别门架；外来集卡进闸、到箱区装卸、出闸；
 * - 高杆灯（夜里亮）、冷藏箱区的供电架、码头一头的拖轮基地。
 *
 * 船期：本店班轮按仿真的靠泊时段（船由区域车辆层画，这里画甲板上的箱和缆绳）；别家的船由港口按当天的编号排一份船期，负荷越高船越多：
 * 支线船、中型、大型几种尺寸，从外海沿进港航道减速驶来，两条拖轮接上，在泊位前掉头、横推靠上码头、带缆，
 * 岸桥按贝位先卸后装（甲板上的箱一层层变），作业完解缆、拖轮拖离、掉头、加速出港；泊位没空时先到锚地抛锚等，轮到了再进港。
 * 同一个泊位不会同时有两条船；每条船的航迹按时刻和别的船（包括本店班轮的进出港航线）检查过，不会相撞。
 *
 * 作业按船期排出来：每一个箱的「岸桥起吊 → 放到拖车 → 拖车开到箱区 → 龙门吊堆箱」都有时刻，
 * 三维按时刻摆每条船、每台设备、每辆车、每个箱；同一份计划给港口的监控面板用（每条船、每个箱、每台设备在做什么）。
 * 本店的箱（蓝色）单独列出来跟踪。
 */

// —— 布局（港口的局部坐标，米） ——
/** 码头前沿（岸线） */
const ZQ = 1435;
/** 岸桥门架中心（陆侧轨道 1395、海侧轨道 1425） */
const ZC = 1410;
const RAIL_L = 1395;
const RAIL_W = 1425;
/** 岸桥后面沿码头的车道 */
const Z_BACK = 1380;
/** 堆场：三排箱区的龙门吊两条腿的 z（n 靠闸口一侧、s 靠码头一侧）；集卡道在 s 腿内侧 */
const ROWS = [
  { n: 1328, s: 1352 },
  { n: 1290, s: 1314 },
  { n: 1252, s: 1276 },
];
const LANE = (r: number) => (ROWS[r] as { s: number }).s - 3.5;
const ROW_Z = (r: number, j: number) => (ROWS[r] as { n: number }).n + 2.6 + j * 2.64;
/** 箱区之间、最靠闸口那一排外侧（通闸口）沿码头方向的车道 */
const DRIVE = [1320, 1282, 1244];
/** 泊位中心（一个泊位 330 米），和后面一列箱区一一对应；第 3 个位置留给本店班轮（对着区域里的班轮泊位） */
const BERTH_X = [-2650, -2320, -1990, -1660];
const OWN_SLOT = 2;
const BERTH_LEN = 330;
/** 每个位置那一列箱区的起点（24 个贝位，长 309.6 米） */
const COL_X0 = [-2885, -2525, -2165, -1805];
/** 箱区之间和两头的通道：第 c 列在 AISLE_X[c] 和 AISLE_X[c + 1] 之间（拖车从 c + 1 那条进、从 c 那条出） */
const AISLE_X = [-2905, -2550, -2190, -1830, -1485];
/** 沿箱区之间的通道开时离通道中线多远（靠右，双向的车错开） */
const AISLE_KEEP = 2.2;
/**
 * 几个泊位用哪几个位置：本店班轮在位置 2（从泊位正前方进出，不经过别的泊位）；2 个泊位时别家的泊位在位置 3，
 * 3 个、4 个泊位时再往位置 1、0 加
 */
const SLOTS_OF: Record<number, number[]> = { 2: [2, 3], 3: [1, 2, 3], 4: [0, 1, 2, 3] };
const BAYS = 24;
const TIERS = 5;
/** 闸口（一半进闸车道、一半出闸车道）：从陆侧的路进来，朝码头方向开 */
const GATE_X = -2100;
const GATE_Z = 1222;

/** 本店班轮的甲板：16 个贝位（船的本地 x）、13 列（本地 z）、堆 3–6 层；甲板面 y = 5 */
const SHIP_BAYS = Array.from({ length: 16 }, (_, i) => -92 + i * 13.2);
const SHIP_ROWS = 13;
const SHIP_ROW_Z = (r: number) => (r - 6) * 2.6;
const DECK_Y = 5;
/** 本店班轮在泊位上的船中位置（和区域里的班轮泊位一致） */
const OWN_X = -1990;
const OWN_Z = 1457;
/** 别家的船：舱盖板顶面（甲板上的箱从这里往上堆） */
const HATCH_Y = 5.8;

/** 岸桥最多 17 台（本店班轮 5 台 + 别家的船 3 个泊位 × 4 台），每台最多配 7 辆场内集卡；龙门吊最多 12 台（4 列 × 3 排） */
const MAX_CRANES = 17;
const MAX_GANG = 7;
const MAX_RTG = 12;
const TRAC_V = 6.5;
const UP_Y = 40;
const CHASSIS_TOP = 1.55;
const BOX_H = 2.59;

// —— 水域（局部坐标）：进港航道、泊位前的掉头点、锚地 ——
/** 进港航道和码头法线的夹角：船从外海斜着驶来，各泊位的航道互相平行 */
const FAIR_ANG = (20 * Math.PI) / 180;
/** 进港的方向（单位向量，朝码头）；航道的横向：进港船走一侧、出港船走另一侧 */
const DIN = { x: -Math.sin(FAIR_ANG), z: -Math.cos(FAIR_ANG) };
const DN = { x: Math.cos(FAIR_ANG), z: -Math.sin(FAIR_ANG) };
const H_IN = Math.atan2(DIN.z, DIN.x);
const LANE_OFF = 55;
/** 航道口离掉头点多远（米）：船从这里进入画面 */
const FAIR_LEN = 1900;
/** 港口拥堵时本店班轮在锚地等泊位的位置 */
const LINER_ANCHOR = { x: -2750, z: 1920 };
/** 仿真里班轮进港、离港各 3 小时 */
const LINER_RUN = 3 * 3600;
const LINER_LEN = 292;
const LINER_BEAM = 40;
/** 航迹检查：采样间隔（秒）、两船之间至少留多少米 */
const DT = 20;
const MARGIN = 14;
const DAY_END = 24 * 3600;

// —— 小工具 ——
const at = <T>(a: readonly T[], i: number): T => a[i] as T;
const hex = (c: string): number => parseInt(c.slice(1), 16);
const BOX_HEX = BOX_COLORS.map(hex);
const STORE_HEX = hex(STORE_BOX);
const REEFER_HEX = hex(REEFER_BOX);
const WHITE = 0xffffff;
const ROPE_HEX = 0x2b2b2b;
const LINE_HEX = 0xd9c27a;
const OWNERS = ['XAAU', 'XBBU', 'XCCU', 'XDDU', 'XEEU', 'XFFU'];
const pickHex = (r: () => number): number => at(BOX_HEX, Math.floor(r() * BOX_HEX.length));
/** 从 a 转到 b 的角度差（−π…π） */
function angDiff(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export interface PortBox {
  id: string;
  store: boolean;
  fam?: string;
  color: string;
  /** 每一步的时刻和说明 */
  steps: { t: number; text: string }[];
  /** 箱区、贝位、列、层 */
  slot?: { block: string; bay: number; row: number; tier: number };
  /** 卸到堆场、装上集装箱拖车的时刻，来提它的拖车（车辆下标） */
  stacked?: number;
  pickup?: number;
  dray?: number;
}
export interface PortEquip {
  id: string;
  kind: '岸桥' | '龙门吊' | '场内集卡';
  /** 每一段在做什么 */
  tasks: { t0: number; t1: number; text: string }[];
  moves: number;
}
/** 别家的一条船（今天的船期）：泊位、到港、靠泊、离泊、锚地等泊位的时段、此刻的状态、岸桥作业的进度 */
export interface PortCallInfo {
  id: string;
  name: string;
  cls: string;
  berth: string;
  eta: number;
  fast?: number;
  cast?: number;
  anchor?: [number, number];
  status: string;
  moves: number;
  done: number;
}
export interface PortInfo {
  vessel?: { label: string; berth: [number, number]; moves: number; done: number; discharge: number; loaded: number };
  other: { moves: number; done: number };
  /** 今天的船期（别家的船）和每个泊位此刻的情况 */
  calls: PortCallInfo[];
  berths: { label: string; own: boolean; cranes: number; ship?: string; status: string }[];
  boxes: PortBox[];
  equip: { id: string; kind: string; now: string; moves: number; doneMoves: number }[];
  gate: { inside: number; inToday: number; outToday: number; queue: number };
  yard: { boxes: number; slots: number };
  /** 潮位（潮高，米）、涨潮还是落潮、下一次高潮和低潮的时刻 */
  tide: { level: number; rising: boolean; nextHigh: number; nextLow: number };
  /** 物流中心（拆装箱库、保税库、查验、空箱堆场）此刻的情况 */
  logistics?: PortLogisticsInfo;
}

export interface PortDay {
  seed: number;
  /**
   * 本店班轮：靠泊时段（秒）、本店的箱数；三维里船的位置取 poseOf(vid)。
   * pose：它在任意时刻的姿态（港口局部坐标，区域车辆层画的那条船），别家的船按它避让；path：它进港、离港的航线（锚位离它远一点）
   */
  ship?: { vid: number; berth: [number, number]; storeBoxes: number; label: string; pose?: (t: number, out: { x: number; z: number; h: number }) => boolean; path?: { x: number; z: number }[]; pilots?: [number, number][] };
  /** 来提本店箱的集装箱拖车：停在本店泊位后面中间那排箱区集卡道上的时段（区域车辆层的「在港口堆场装箱」） */
  drays?: { vid: number; t0: number; t1: number; label: string }[];
  /** 负荷档位的背景流量倍数：别家的船更多（泊位排不过来就在锚地等）、外来集卡更密、闸口开得更久（平常 1） */
  traffic?: number;
  /** 方案：物流中心的查验比例按它（不给按全链路） */
  gen?: 'g1' | 'g2' | 'g3';
  /** 过路的船（区域车辆层画的背景船，匀速）：航线（港口局部坐标，沙盘米）和时段；别家的船进出港、抛锚都避开它们 */
  passing?: { t0: number; t1: number; pts: { x: number; z: number }[] }[];
}

type Tier = { color: number; t0: number; t1: number; tier: number };
interface Slot {
  /** 每一层：颜色、出现、消失的时刻 */
  tiers: Tier[];
}
interface CraneMove {
  id: string;
  crane: number;
  kind: 'dis' | 'load';
  own: boolean;
  store: boolean;
  color: number;
  /** 船上的位置：贝 / 列 / 层（层 < 0 = 舱里） */
  bay: number;
  row: number;
  tier: number;
  x: number;
  zr: number;
  /** 岸桥：小车出发、到船上方、放下、起升、回陆侧、放到拖车、松开、升起（秒） */
  tt: number[];
  shipY: number;
  tractor: number;
  /** 哪条船：别家的船是船期里的下标，本店班轮是 −1 */
  call: number;
}
interface Leg {
  t0: number;
  t1: number;
  poly?: Poly;
  at?: At;
  /** 车上有没有箱、箱的颜色 */
  box?: number;
}
interface RtgTask {
  t0: number;
  /** 到贝位、对位、放下、锁、升、移到列、放下、松、升 */
  tt: number[];
  x: number;
  zFrom: number;
  zTo: number;
  yFrom: number;
  yTo: number;
  color: number;
  label: string;
  /** 小车开始时在哪（上一个任务结束的位置） */
  zStart: number;
}
interface Gate {
  t0: number;
  legs: Leg[];
  load: boolean;
  inAt: number;
  outAt: number;
  /** 进闸、出闸的车道（道闸编号 0–5：前三樘进闸、后三樘出闸），车上的箱（提箱走时带、送箱来时带） */
  inK: number;
  outK: number;
  box: number;
  /** 进闸、出闸的道闸抬起的时段 */
  upIn: [number, number];
  upOut: [number, number];
}
/** 外来集卡在港口里的一趟（局部坐标）：区域车辆层接上进港、离港的路，画整趟车（ops/extTrucks.ts） */
export interface GateTrip {
  /** 到闸口外排队点、出港回到排队点的时刻 */
  t0: number;
  t1: number;
  /** 提箱（空车进来、带箱走）还是送箱 */
  load: boolean;
  box: number;
  inK: number;
  outK: number;
  /** 进闸时刻（过道闸） */
  inAt: number;
  /** 一段段：沿折线（缓起缓停）开，或者停在 at；hidden 的段由物流中心按收货场引擎的时间线画（场地里调车） */
  legs: { t0: number; t1: number; pts?: { x: number; z: number }[]; at?: At; box?: number; hidden?: boolean; u0?: number; /** 停在这条折线的 u0 处等（不动） */ still?: boolean }[];
  /** 物流中心的车：车型（0 集卡、1 厢式半挂、2 冷藏半挂）、驾驶室和挂车的颜色（和物流中心画的一样，交接时不变） */
  build?: 0 | 1 | 2;
  cab?: number;
  trailer?: number;
}

// ———————————————————————— 船的运动：航迹、速度曲线、分段 ————————————————————————

interface Pose {
  x: number;
  z: number;
  /** 船首朝向：atan2(dz, dx)（三维的 yaw = −h） */
  h: number;
  /** 前进速度（米 / 秒），横移和掉头时为 0 */
  v: number;
}
const pose = (): Pose => ({ x: 0, z: 0, h: 0, v: 0 });

/** 平滑的航迹：控制点的拐角倒圆，再按 5 米重采样；按走过的距离取位置和朝向（朝向插值，不会一跳一跳） */
class Track {
  readonly xs: number[] = [];
  readonly zs: number[] = [];
  readonly hs: number[] = [];
  readonly cum: number[] = [0];
  readonly len: number;
  constructor(ctrl: readonly { x: number; z: number }[], r: number) {
    const poly = new Poly(r > 0 ? rounded(ctrl, r, 16) : ctrl);
    const n = Math.max(2, Math.ceil(poly.len / 5));
    const a: At = { x: 0, z: 0, yaw: 0 };
    for (let i = 0; i <= n; i++) {
      poly.at((poly.len * i) / n, a);
      this.xs.push(a.x);
      this.zs.push(a.z);
    }
    for (let i = 1; i <= n; i++) this.cum.push(at(this.cum, i - 1) + Math.hypot(at(this.xs, i) - at(this.xs, i - 1), at(this.zs, i) - at(this.zs, i - 1)));
    this.len = at(this.cum, n);
    for (let i = 0; i <= n; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n, i + 1);
      let h = Math.atan2(at(this.zs, i1) - at(this.zs, i0), at(this.xs, i1) - at(this.xs, i0));
      if (i > 0) h = at(this.hs, i - 1) + angDiff(at(this.hs, i - 1), h);
      this.hs.push(h);
    }
  }
  at(s: number, o: Pose): Pose {
    const n = this.xs.length - 1;
    const ss = Math.max(0, Math.min(this.len, s));
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at(this.cum, mid) <= ss) lo = mid;
      else hi = mid;
    }
    const d = at(this.cum, hi) - at(this.cum, lo) || 1;
    const k = (ss - at(this.cum, lo)) / d;
    o.x = lerp(at(this.xs, lo), at(this.xs, hi), k);
    o.z = lerp(at(this.zs, lo), at(this.zs, hi), k);
    o.h = lerp(at(this.hs, lo), at(this.hs, hi), k);
    return o;
  }
  headAt(s: number): number {
    return this.at(s, SCRATCH).h;
  }
}
const SCRATCH = pose();

/**
 * 速度曲线（时间比例 u → 路程比例）：dec 从航速平滑减到 0（进港），acc 从 0 平滑加速到航速（出港），bump 起步、加速、减速、停住（起锚进港），
 * herm 起止速度任意（拖轮接船、回基地）。
 */
type Prof = 'dec' | 'acc' | 'bump' | 'herm' | 'lin';
function profS(p: Prof, u: number, m0: number, m1: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  switch (p) {
    case 'dec':
      return 2 * (u - u3 + (u3 * u) / 2);
    case 'acc':
      return 2 * (u3 - (u3 * u) / 2);
    case 'bump':
      return u - Math.sin(2 * Math.PI * u) / (2 * Math.PI);
    case 'lin':
      return u;
    default:
      return (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) + (u3 - u2) * m1;
  }
}
/** 上面的导数（路程比例 / 时间比例） */
function profV(p: Prof, u: number, m0: number, m1: number): number {
  const u2 = u * u;
  switch (p) {
    case 'dec':
      return 2 * (1 - 3 * u2 + 2 * u2 * u);
    case 'acc':
      return 2 * (3 * u2 - 2 * u2 * u);
    case 'bump':
      return 1 - Math.cos(2 * Math.PI * u);
    case 'lin':
      return 1;
    default:
      return (3 * u2 - 4 * u + 1) * m0 + (-6 * u2 + 6 * u) + (3 * u2 - 2 * u) * m1;
  }
}

/** 一段运动：沿航迹走（path）、原地掉头 / 横移（lerp：位置和朝向一起平滑过渡）、停着（hold：靠泊、锚泊）、按函数算（fn：本店班轮） */
type Phase =
  | { k: 'path'; t0: number; t1: number; tr: Track; s0: number; s1: number; prof: Prof; m0: number; m1: number }
  | { k: 'lerp'; t0: number; t1: number; x0: number; z0: number; x1: number; z1: number; h0: number; h1: number }
  | { k: 'hold'; t0: number; t1: number; x: number; z: number; h: number }
  | { k: 'fn'; t0: number; t1: number; f: (t: number, o: Pose) => void };
interface Mover {
  ph: Phase[];
}

function evalPhase(p: Phase, t: number, o: Pose): void {
  if (p.k === 'fn') {
    p.f(t, o);
    return;
  }
  if (p.k === 'hold') {
    o.x = p.x;
    o.z = p.z;
    o.h = p.h;
    o.v = 0;
    return;
  }
  const T = p.t1 - p.t0;
  const u = T > 0 ? clamp01((t - p.t0) / T) : 1;
  if (p.k === 'lerp') {
    const f = ease(u);
    o.x = lerp(p.x0, p.x1, f);
    o.z = lerp(p.z0, p.z1, f);
    o.h = lerp(p.h0, p.h1, f);
    o.v = 0;
    return;
  }
  p.tr.at(p.s0 + (p.s1 - p.s0) * profS(p.prof, u, p.m0, p.m1), o);
  o.v = (Math.abs(p.s1 - p.s0) / Math.max(1, T)) * Math.max(0, profV(p.prof, u, p.m0, p.m1));
}
/** 某个时刻的位置；不在画面里（还没来、已经走了）返回 undefined */
function poseAt(m: Mover, t: number, o: Pose): Phase | undefined {
  const ph = m.ph;
  const n = ph.length;
  if (!n || t < at(ph, 0).t0 || t > at(ph, n - 1).t1) return undefined;
  let p = at(ph, 0);
  for (let i = n - 1; i >= 0; i--) {
    const q = at(ph, i);
    if (q.t0 <= t) {
      p = q;
      break;
    }
  }
  evalPhase(p, t, o);
  return p;
}
/** 沿航迹走到 s 处的时刻（二分速度曲线） */
function timeAtS(p: Extract<Phase, { k: 'path' }>, s: number): number {
  const f = (s - p.s0) / (p.s1 - p.s0 || 1);
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const u = (lo + hi) / 2;
    if (profS(p.prof, u, p.m0, p.m1) < f) lo = u;
    else hi = u;
  }
  return p.t0 + ((lo + hi) / 2) * (p.t1 - p.t0);
}

/** 两条线段之间的最短距离（平面） */
function ptSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ux = bx - ax;
  const uz = bz - az;
  const k = clamp01(((px - ax) * ux + (pz - az) * uz) / (ux * ux + uz * uz || 1));
  return Math.hypot(px - ax - ux * k, pz - az - uz * k);
}
function segDist(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const ux = bx - ax;
  const uz = bz - az;
  const vx = dx - cx;
  const vz = dz - cz;
  const den = ux * vz - uz * vx;
  if (Math.abs(den) > 1e-9) {
    const s = ((cx - ax) * vz - (cz - az) * vx) / den;
    const t = ((cx - ax) * uz - (cz - az) * ux) / den;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return 0;
  }
  return Math.min(ptSeg(ax, az, cx, cz, dx, dz), ptSeg(bx, bz, cx, cz, dx, dz), ptSeg(cx, cz, ax, az, bx, bz), ptSeg(dx, dz, ax, az, bx, bz));
}
/** 两条船（按胶囊形：船长 × 船宽）是不是挨得太近 */
function shipsHit(a: Pose, La: number, Ba: number, b: Pose, Lb: number, Bb: number): boolean {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const R = (La + Lb) / 2 + MARGIN;
  if (dx * dx + dz * dz > R * R) return false;
  const ha = La / 2 - Ba / 2;
  const hb = Lb / 2 - Bb / 2;
  const ca = Math.cos(a.h) * ha;
  const sa = Math.sin(a.h) * ha;
  const cb = Math.cos(b.h) * hb;
  const sb = Math.sin(b.h) * hb;
  return segDist(a.x - ca, a.z - sa, a.x + ca, a.z + sa, b.x - cb, b.z - sb, b.x + cb, b.z + sb) < (Ba + Bb) / 2 + MARGIN;
}

// ———————————————————————— 船型、船期 ————————————————————————

interface ShipClass {
  key: string;
  label: string;
  len: number;
  beam: number;
  rows: number;
  bays: { x: number; rows: number }[];
  /** 到港时甲板上每列堆几层、每个贝卸掉多少（比例）、每个贝舱里卸 / 装几箱 */
  tiers: [number, number];
  ex: [number, number];
  hold: number;
  /** 进港航速（米 / 秒）、掉头的平均角速度（弧度 / 秒）、横移的平均速度（米 / 秒） */
  v0: number;
  turn: number;
  lat: number;
  /** 几种涂装（船体、驾驶楼、烟囱色带） */
  specs: HullSpec[];
}
const CLASSES: ShipClass[] = (() => {
  const mk = (key: string, label: string, len: number, beam: number, bays: number, rows: number, tiers: [number, number], ex: [number, number], hold: number, v0: number, turnDeg: number, lat: number, liv: [string, string, string][]): ShipClass => {
    const specs = liv.map(([hull, house, band]) => ({ len, beam, bays, rows, hull, house, band }));
    return { key, label, len, beam, rows, bays: hullBays(at(specs, 0)), tiers, ex, hold, v0, turn: (turnDeg * Math.PI) / 180, lat, specs };
  };
  return [
    mk('feeder', '支线船', 172, 27, 9, 10, [2, 4], [0.35, 0.6], 2, 3.2, 0.5, 0.2, [
      ['#2e6b4f', '#f2f2ef', '#e0a526'],
      ['#8a4b22', '#eef1f3', '#2471a3'],
    ]),
    mk('medium', '中型集装箱船', 232, 32, 12, 12, [3, 5], [0.25, 0.45], 2, 3.5, 0.38, 0.18, [
      ['#3c4650', '#f4f4f1', '#c0392b'],
      ['#1d5f73', '#eef1f3', '#f0b429'],
    ]),
    mk('large', '大型集装箱船', 292, 40, 16, 13, [3, 6], [0.2, 0.35], 2, 3.8, 0.3, 0.16, [
      ['#5b2333', '#f2f2ef', '#e5e7e9'],
      ['#2b2e33', '#eef1f3', '#1e8449'],
    ]),
  ];
})();
/** 船名（虚构） */
const NAMES = ['长风', '海鹰', '明珠', '远帆', '云帆', '青峰', '白鹭', '启航', '星河', '银湾', '金帆', '翠海', '鲸歌', '瀚海', '碧波', '晨光', '海燕', '鹏程', '宁远', '和风', '春潮', '安澜', '飞鱼', '凌波'];
const rowZ = (c: ShipClass, ri: number) => (ri - (c.rows - 1) / 2) * 2.6;
/** 一个贝能放的列（船首收窄的贝只用中间几列） */
function rowRange(c: ShipClass, bi: number): [number, number] {
  const n = at(c.bays, bi).rows;
  const off = Math.floor((c.rows - n) / 2);
  return [off, off + n];
}

/** 别家的一条船（船期里的一个挂靠） */
interface Call extends Mover {
  id: string;
  name: string;
  cls: number;
  liv: number;
  /** 泊位（layout.berths 的下标，还没排到泊位是 −1）、靠泊时船首朝 +x（1）还是 −x（−1） */
  berth: number;
  dir: 1 | -1;
  /** 泊位上的船中位置、掉头点的 z */
  x: number;
  zM: number;
  zT: number;
  /** 到港（到航道口或锚地）的时刻 */
  eta: number;
  /** 锚地：哪个锚位、抛锚、起锚的时刻 */
  anchor?: { spot: number; t0: number; t1: number };
  /** 进港（从航道口或锚地出发）、拖轮接上、开始掉头、开始横移、靠上码头、系缆完成 */
  tArr: number;
  tMeet: number;
  tSwing: number;
  tPush: number;
  tAlong: number;
  tFast: number;
  /** 岸桥作业的头一个箱、最后一个箱 */
  tW0: number;
  tW1: number;
  /** 解缆、拖离（缆绳都收了）、掉头、出港、离开画面 */
  tCast: number;
  tOff: number;
  tSwingOut: number;
  tOut: number;
  tGone: number;
  deck: Slot[][];
  moves: number;
  /** 这条船的岸桥作业（按开始时刻排）、每个箱做完的时刻（排好序） */
  ops: CraneMove[];
  fin: number[];
}

// ———————————————————————— 布局：泊位、岸桥、箱区 ————————————————————————

interface Berth {
  i: number;
  no: number;
  x: number;
  own: boolean;
  slot: number;
  /** 后面那列箱区（在 cols 里的下标） */
  col: number;
  cranes: number[];
}
interface Crane {
  id: string;
  berth: number;
  /** 不作业时停在哪；在这个泊位的岸桥里排第几 */
  rest: number;
  k: number;
}
interface Layout {
  n: number;
  berths: Berth[];
  /** 用到的箱区列（位置下标） */
  cols: number[];
  cranes: Crane[];
  x0: number;
  x1: number;
  other: number;
  own: number;
}

/** 按设施配置排泊位和岸桥：岸桥编号沿码头从一头排到另一头 */
function portLayout(cfg: PortCfg): Layout {
  const n = Math.max(2, Math.min(4, Math.round(cfg.berths || 2)));
  const slots = SLOTS_OF[n] as number[];
  const other = Math.max(1, Math.min(4, Math.round(cfg.otherCranes)));
  const own = Math.max(1, Math.min(5, Math.round(cfg.ownCranes)));
  const berths: Berth[] = slots.map((s, i) => ({ i, no: i + 1, x: at(BERTH_X, s), own: s === OWN_SLOT, slot: s, col: i, cranes: [] }));
  const cranes: Crane[] = [];
  for (const b of berths) {
    const k = b.own ? own : other;
    for (let j = 0; j < k; j++) {
      b.cranes.push(cranes.length);
      cranes.push({ id: `QC${cranes.length + 1}`, berth: b.i, rest: b.x - 118 + (k > 1 ? (236 * j) / (k - 1) : 118), k: j });
    }
  }
  const first = at(slots, 0);
  const last = at(slots, slots.length - 1);
  const x0 = Math.min(at(BERTH_X, first) - BERTH_LEN / 2, at(COL_X0, first) - 35);
  const x1 = last === 3 ? at(COL_X0, 3) + 310 + 20 : Math.max(at(BERTH_X, last) + BERTH_LEN / 2, at(COL_X0, last) + 310 + 35);
  return { n, berths, cols: slots, cranes, x0, x1, other, own };
}

/** 冷藏箱区在哪一列（位置 1 那列有就放那里，否则放位置 3 那列） */
const reeferOf = (L: Layout): number => (L.cols.includes(1) ? 1 : 3);

/** 岸桥清单（编号沿码头从一头排到另一头）：设施管理台列检修设备时可以用 */
export function portCranes(cfg: PortCfg): { id: string; berth: number; own: boolean; label: string }[] {
  const L = portLayout(cfg);
  return L.cranes.map((c) => {
    const b = at(L.berths, c.berth);
    return { id: c.id, berth: b.no, own: b.own, label: `岸桥 ${c.id}（${b.no} 号泊位 · ${b.own ? '本店班轮' : '别家的船'}）` };
  });
}

/** 锚地的锚位：在各泊位进港航道之间的空当和外侧，离本店班轮的航线、它等泊位的地方、过路船的航线远一点；船首都朝进港方向 */
function anchorSpots(L: Layout, lanes: { x: number; z: number }[][], liner: readonly { x: number; z: number }[]): { x: number; z: number; h: number }[] {
  const lines = L.berths.filter((b) => !b.own).map((b) => ({ x: b.x, z: 1600 }));
  const nearLiner = (x: number, z: number) => {
    let d = Infinity;
    for (let i = 1; i < liner.length; i++) d = Math.min(d, ptSeg(x, z, at(liner, i - 1).x, at(liner, i - 1).z, at(liner, i).x, at(liner, i).z));
    return d;
  };
  const cand: { x: number; z: number; d: number }[] = [];
  for (let z = 2250; z <= 3250; z += 125)
    for (let x = -3000; x <= -650; x += 40) {
      let ok = true;
      for (const l of lines) {
        const perp = Math.abs((x - l.x) * DIN.z - (z - l.z) * DIN.x);
        if (perp < 175) {
          ok = false;
          break;
        }
      }
      if (!ok || nearLiner(x, z) < 300 || Math.hypot(x - LINER_ANCHOR.x, z - LINER_ANCHOR.z) < 420) continue;
      if (lanes.some((ln) => ln.some((p, i) => i > 0 && ptSeg(x, z, at(ln, i - 1).x, at(ln, i - 1).z, p.x, p.z) < 260))) continue;
      cand.push({ x, z, d: Math.hypot(x + 2150, z - 1750) });
    }
  cand.sort((a, b) => a.d - b.d);
  const out: { x: number; z: number; h: number }[] = [];
  for (const c of cand) {
    if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) > 360)) out.push({ x: c.x, z: c.z, h: H_IN });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * 本店班轮的运动（航迹检查、尾迹用）：就是区域车辆层画的那条船（进港 3 小时、靠泊、离港 3 小时）。
 * 速度取船首方向上的分量：拖轮横推、原地掉头时没有尾迹
 */
function linerMover(b0: number, b1: number, pose: (t: number, out: { x: number; z: number; h: number }) => boolean): Mover {
  const q = { x: 0, z: 0, h: 0 };
  const f = (t: number, o: Pose) => {
    if (!pose(t, q)) {
      o.x = OWN_X;
      o.z = OWN_Z;
      o.h = 0;
      o.v = 0;
      return;
    }
    o.x = q.x;
    o.z = q.z;
    o.h = q.h;
    o.v = pose(t + 4, q) ? Math.max(0, ((q.x - o.x) * Math.cos(o.h) + (q.z - o.z) * Math.sin(o.h)) / 4) : 0;
  };
  return {
    ph: [
      { k: 'fn', t0: b0 - LINER_RUN, t1: b0, f },
      { k: 'hold', t0: b0, t1: b1, x: OWN_X, z: OWN_Z, h: 0 },
      { k: 'fn', t0: b1, t1: b1 + LINER_RUN, f },
    ],
  };
}

// ———————————————————————— 拖轮 ————————————————————————

/** 拖轮相对船的位置（船的本地坐标：x 朝船首，z 朝右舷）；m：0 赶路、1 顶推、2 拖带（带缆）、3 船首前方拖带、4 船尾、5 待命 */
interface TugKey {
  t: number;
  lx: number;
  lz: number;
  lh: number;
  m: number;
}
interface TugSeg {
  t0: number;
  t1: number;
  ph?: Phase;
  att?: { call: Call; keys: TugKey[] };
}
interface TugPlan {
  home: { x: number; z: number };
  segs: TugSeg[];
  free: number;
}

interface Plan {
  L: Layout;
  moves: CraneMove[];
  byCrane: CraneMove[][];
  /** 每台岸桥的作业时段（前大梁放平的时段） */
  boomWin: [number, number][][];
  tractorLegs: Leg[][];
  /** 闸口里面的路口被港口的集卡占着的时段（物流中心的车按它错开） */
  junctionIv?: [number, number][];
  rtgTasks: RtgTask[][];
  slots: Slot[][][][];
  deck: Slot[][];
  gate: Gate[];
  boxesInfo: PortBox[];
  drayLoaded: Map<number, number>;
  layout: { other: number; own: number; gang: number; cranes: number; idle: string[]; berths: number };
  why: Map<string, string>;
  calls: Call[];
  tugs: TugPlan[];
  liner?: Mover;
  pilots: PilotBoat[];
  gangs: Gang[];
}

// ———————————————————————— 几何 ————————————————————————

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.1, ...o });

/** 两点之间的方梁（几何体，烤进静态模型） */
function strut(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, color: string): Part {
  const len = a.distanceTo(b);
  const g = box(w, len, h, color, 0, -len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/** 岸桥的固定部分（原点：门架中心、轨面；陆侧在 −z） */
function stsFrame(): THREE.BufferGeometry {
  const R = '#c8402f';
  const W = '#eceae4';
  const D = '#3d4650';
  const p: Part[] = [];
  const legs: [number, number][] = [
    [-8.5, -15],
    [8.5, -15],
    [-8.5, 15],
    [8.5, 15],
  ];
  for (const [x, z] of legs) {
    p.push(box(2.4, 42.5, 2.4, R, x, 1.6, z));
    // 行走台车：两组车轮
    p.push(box(2.2, 1.0, 7.4, D, x, 0.55, z), box(1.2, 0.6, 7.4, R, x, 1.0, z));
    for (const dz of [-2.6, -0.9, 0.9, 2.6]) p.push(wheel(0.45, 0.5, '#1d1d1d', x, 0.45, z + dz).rotateY(Math.PI / 2).translate(0, 0, 0));
  }
  // 门架的横梁（拖车从下面过，净空 18 米）、斜撑
  for (const x of [-8.5, 8.5]) p.push(box(2, 2.4, 30, R, x, 18, 0), strut(new THREE.Vector3(x, 20, -14), new THREE.Vector3(x, 41, 0), 0.9, 0.9, R), strut(new THREE.Vector3(x, 20, 14), new THREE.Vector3(x, 41, 0), 0.9, 0.9, R));
  for (const z of [-15, 15]) p.push(box(19.4, 2.8, 2.4, R, 0, 41.5, z));
  // 主梁（后伸距 + 门架段），两根，梁上的小车轨道
  for (const x of [-4.2, 4.2]) p.push(box(1.7, 3.4, 52, W, x, 44.2, -8), box(0.4, 0.3, 52, D, x, 47.6, -8));
  for (let z = -32; z <= 16; z += 6) p.push(box(8.4, 0.5, 0.5, W, 0, 44.2, z));
  // 机房（后伸距末端）
  p.push(box(12, 6.5, 12.5, '#e8e6df', 0, 47.6, -28), box(12.2, 0.6, 12.7, D, 0, 54.1, -28), box(2, 1.2, 4, '#9aa3ab', 3, 54.7, -26));
  // A 字架：从海侧和陆侧腿顶升到 76 米
  const apex = (x: number) => new THREE.Vector3(x, 76, 9);
  for (const x of [-3.4, 3.4]) {
    p.push(strut(new THREE.Vector3(Math.sign(x) * 8.5, 44, 15), apex(x), 1.5, 1.5, R), strut(new THREE.Vector3(Math.sign(x) * 8.5, 44, -15), apex(x), 1.3, 1.3, R));
    // 后拉杆：A 字架顶 → 后伸距末端
    p.push(strut(apex(x), new THREE.Vector3(x * 1.2, 47.6, -33), 0.5, 0.5, W));
  }
  p.push(box(8.4, 2.2, 2.2, R, 0, 75, 9));
  // 爬梯、平台
  p.push(box(0.6, 40, 0.6, D, -9.9, 2, -15), box(3, 0.3, 3, D, -9.9, 18.2, -15), box(3, 0.3, 3, D, -9.9, 41.2, -15));
  return merge(p);
}
/** 前大梁（原点：铰点，沿 +z 伸出 62 米；俯仰绕 x 轴） */
function stsBoom(): THREE.BufferGeometry {
  const W = '#eceae4';
  const D = '#3d4650';
  const p: Part[] = [];
  for (const x of [-4.2, 4.2]) p.push(box(1.6, 3.2, 62, W, x, -1.6, 31), box(0.4, 0.3, 62, D, x, 1.6, 31));
  for (let z = 4; z <= 60; z += 6) p.push(box(8.4, 0.45, 0.45, W, 0, -1.4, z));
  // 端部的滑轮架、航空障碍灯
  p.push(box(9, 2.4, 2.4, '#c8402f', 0, -1.4, 61), box(0.5, 0.5, 0.5, '#ff3b30', 0, 1.2, 61.5));
  return merge(p);
}
function stsTrolley(): THREE.BufferGeometry {
  return merge([box(9.6, 2.4, 7, '#3d4650', 0, -0.2, 0), box(9.8, 0.4, 7.2, '#c8402f', 0, 2.2, 0), box(3.2, 2.8, 3.2, '#d6e4f0', 2.4, -4.4, 0.5), box(3.3, 0.3, 3.3, '#3d4650', 2.4, -1.6, 0.5)]);
}
function spreader(): THREE.BufferGeometry {
  return merge([box(12.2, 0.55, 0.5, '#f2c94c', 0, 0, -1.05), box(12.2, 0.55, 0.5, '#f2c94c', 0, 0, 1.05), box(0.5, 0.55, 2.6, '#f2c94c', -5.9, 0, 0), box(0.5, 0.55, 2.6, '#f2c94c', 5.9, 0, 0), box(2.6, 0.9, 2.2, '#d4a017', 0, 0.55, 0), box(0.6, 0.6, 0.6, '#3d4650', 0, 1.45, 0)]);
}
/** 轮胎式龙门吊的门架（原点：中心、地面；跨距沿 z 23.5 米，轮距沿 x 12.5 米） */
function rtgFrame(): THREE.BufferGeometry {
  const Y = '#f0b429';
  const W = '#eceae4';
  const D = '#3d4650';
  const p: Part[] = [];
  for (const z of [-11.75, 11.75]) {
    p.push(box(15, 1.8, 1.6, Y, 0, 1.1, z));
    for (const x of [-6.25, 6.25]) {
      p.push(box(1.5, 20, 1.5, Y, x, 2.9, z));
      for (const dx of [-0.95, 0.95]) p.push(wheel(0.85, 0.55, '#1d1d1d', x + dx, 0.85, z));
    }
    p.push(box(14, 1.6, 1.3, Y, 0, 20.6, z), strut(new THREE.Vector3(-6.25, 4, z), new THREE.Vector3(0, 19.5, z), 0.5, 0.5, Y), strut(new THREE.Vector3(6.25, 4, z), new THREE.Vector3(0, 19.5, z), 0.5, 0.5, Y));
  }
  for (const x of [-4.4, 4.4]) p.push(box(1.3, 1.8, 25, W, x, 22.2, 0), box(0.3, 0.25, 25, D, x, 24, 0));
  // 发电机组 / 电气房（闸口一侧的腿外面）、爬梯
  p.push(box(3.2, 3, 5.5, '#dfe3e6', 0, 3.2, -13.4), box(3.3, 0.3, 5.6, D, 0, 6.2, -13.4), box(0.5, 17, 0.5, D, 7.4, 3, -11.75));
  return merge(p);
}
function rtgTrolley(): THREE.BufferGeometry {
  return merge([box(9.8, 1.8, 5, '#3d4650', 0, 0, 0), box(10, 0.3, 5.2, '#f0b429', 0, 1.8, 0), box(2.2, 2.4, 2.2, '#d6e4f0', 3.6, -2.6, 2.2)]);
}
/** 码头拖车（场内集卡）：平头、单人驾驶室偏在一边、鞍座；原点在车尾、地面，车头朝 +x */
function terminalTractor(): THREE.BufferGeometry {
  const O = '#e67e22';
  return merge([
    box(5.8, 0.7, 2.3, '#2f3336', 2.9, 0.75, 0),
    box(2.0, 2.3, 1.5, O, 4.8, 1.45, 0.38),
    box(1.9, 1.0, 1.42, '#bcd3e6', 4.95, 2.4, 0.38),
    box(2.4, 1.4, 0.7, O, 4.6, 1.45, -0.8),
    box(1.6, 0.25, 2.2, '#3d4650', 1.6, 1.45, 0),
    box(0.25, 1.6, 0.25, '#2f3336', 3.6, 1.8, -0.9),
    ...[0.9, 4.9].flatMap((x) => [wheel(0.55, 0.45, '#1d1d1d', x, 0.55, 1.05), wheel(0.55, 0.45, '#1d1d1d', x, 0.55, -1.05)]),
  ]);
}
/** 码头拖车拖的平板车（12.5 米，前端鹅颈搭在鞍座上）：原点在车尾 */
function terminalChassis(): THREE.BufferGeometry {
  return merge([box(12.5, 0.35, 2.3, '#3a3f44', 6.25, 1.2, 0), box(0.3, 0.3, 2.3, '#e9b730', 0.15, 1.2, 0), box(0.3, 0.3, 2.3, '#e9b730', 12.35, 1.2, 0), ...[1.2, 2.5].flatMap((x) => [wheel(0.5, 0.5, '#1d1d1d', x, 0.5, 0.95), wheel(0.5, 0.5, '#1d1d1d', x, 0.5, -0.95)])]);
}
/** 简化的集装箱（堆场、别家的船的甲板上成千上万个）：箱体、角柱、上下边梁、门端锁杆 */
function lowContainer(): THREE.BufferGeometry {
  const L = 12.19;
  const W = 2.44;
  const H = 2.59;
  const p: Part[] = [box(L - 0.3, H - 0.16, W - 0.08, '#ffffff', 0, 0.08, 0)];
  for (const x of [-L / 2 + 0.12, L / 2 - 0.12]) for (const z of [-W / 2 + 0.1, W / 2 - 0.1]) p.push(box(0.24, H, 0.2, '#d0d0d0', x, 0, z));
  for (const y of [0, H - 0.14]) for (const z of [-W / 2 + 0.06, W / 2 - 0.06]) p.push(box(L, 0.14, 0.12, '#d0d0d0', 0, y, z));
  for (const z of [-0.6, 0.6]) p.push(box(0.05, H - 0.3, 0.07, '#9a9a9a', L / 2 + 0.01, 0.15, z));
  return merge(p);
}
/**
 * 平铺在水面上的浪花：一条条带子（沿长度方向 u 从 0 到 1），每一截横向三个点（两边透明、中间最白），
 * 透明度按顶点给（RGBA 顶点色），越往后越淡。center(u) 是带子中线的横向位置、width(u) 是半宽、alpha(u) 是中间的不透明度。
 */
function foamGeometry(strips: { center: (u: number) => number; width: (u: number) => number; alpha: (u: number) => number; len: number }[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const N = 16;
  const push = (x: number, z: number, a: number) => {
    pos.push(x, 0, z);
    col.push(0.94, 0.97, 1, a);
  };
  for (const st of strips)
    for (let i = 0; i < N; i++) {
      const u0 = i / N;
      const u1 = (i + 1) / N;
      const x0 = -u0 * st.len;
      const x1 = -u1 * st.len;
      const c0 = st.center(u0);
      const c1 = st.center(u1);
      const w0 = st.width(u0);
      const w1 = st.width(u1);
      const a0 = st.alpha(u0);
      const a1 = st.alpha(u1);
      // 左半边、右半边两个四边形（边上透明）
      for (const s of [-1, 1]) {
        push(x0, c0 + s * w0, 0);
        push(x0, c0, a0);
        push(x1, c1, a1);
        push(x0, c0 + s * w0, 0);
        push(x1, c1, a1);
        push(x1, c1 + s * w1, 0);
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.computeVertexNormals();
  return g;
}
/** 尾迹（原点在船尾，往 −x 拖 1 个单位长、横向按船宽缩放）：两条张开的波臂（约 19 度）+ 中间翻白的螺旋桨尾流，越往后越淡 */
function wakeGeometry(): THREE.BufferGeometry {
  const arm = (side: number) => ({ center: (u: number) => side * (0.45 + 0.85 * u), width: (u: number) => 0.1 + 0.28 * u, alpha: (u: number) => 0.55 * (1 - u) ** 1.6, len: 1 });
  return foamGeometry([arm(1), arm(-1), { center: () => 0, width: (u: number) => 0.42 * (1 - 0.6 * u), alpha: (u: number) => 0.85 * (1 - u) ** 2.2, len: 0.7 }]);
}
/** 船首浪（原点在船首尖，往 −x 拖 1 个单位长，两侧张开） */
function bowWaveGeometry(): THREE.BufferGeometry {
  const arm = (side: number) => ({ center: (u: number) => side * (0.06 + 0.8 * u), width: (u: number) => 0.08 + 0.16 * u, alpha: (u: number) => 0.75 * (1 - u) ** 1.4, len: 1 });
  return foamGeometry([arm(1), arm(-1)]);
}

/** 岸桥吊具每一段起点的高度：第 2、3 段在 a（卸船是船上、装船是拖车上），第 6、7 段在 b，其余在上方 */
const trolleyY = (i: number, a: number, b: number): number => (i === 2 || i === 3 ? a : i === 6 || i === 7 ? b : UP_Y);

/** 岸桥拉杆在前大梁上的两个点、左右两根；龙门吊两根钢丝绳 */
const TIE_ALONG = [26, 52] as const;
const TIE_X = [-3.4, 3.4] as const;
const RTG_ROPE_X = [-4, 4] as const;
const ROPE_OFF: readonly (readonly [number, number])[] = [
  [-4.5, -0.8],
  [4.5, -0.8],
  [-4.5, 0.8],
  [4.5, 0.8],
];
/** 缆绳（头缆、前横缆、前倒缆、后倒缆、后横缆、尾缆）：船上的点、码头上系缆桩的位置（都是离船中多少个船长，船首方向为正） */
const MOOR = [
  { s: 0.44, b: 0.6 },
  { s: 0.38, b: 0.4 },
  { s: 0.3, b: 0.08 },
  { s: -0.3, b: -0.08 },
  { s: -0.38, b: -0.4 },
  { s: -0.45, b: -0.6 },
];

// ———————————————————————— 引航艇、带缆工 ————————————————————————

/** 引航艇：泊在拖轮基地栈桥西侧靠外的一段；航速（米 / 秒，真实尺寸，约 17 节） */
const PILOT_HOME_Z = ZQ + 112;
const PILOT_V = 9;
/** 带缆工的值班亭（门朝码头前沿）在码头后方岸桥陆侧轨道外面；走路的速度；沿码头前沿走的那条线 */
const GANG_Z = 1393.4;
const WALK_V = 1.4;
const EDGE_Z = 1429.5;

/**
 * 场内集卡沿一段路开：起步、停车各最多 6 秒（匀加速、匀减速），中间匀速。返回 f（时间进度 0~1）时走过的路程占全程的比例。
 * 以前整段缓起缓停（中间最快是平均的 1.5 倍），前后两辆车一快一慢就会追尾、从对方身上开过去；匀速开前后的距离能保持住
 */
function drivePos(f: number, T: number): number {
  const x = Math.max(0, Math.min(1, f));
  const a = Math.min(6, T / 3) / Math.max(1e-6, T);
  const v = 1 / (1 - a);
  if (x < a) return ((0.5 * v) / a) * x * x;
  if (x > 1 - a) return 1 - ((0.5 * v) / a) * (1 - x) * (1 - x);
  return 0.5 * v * a + v * (x - a);
}
const gangHutX = (bx: number): number => bx + BERTH_LEN / 2 - 22;

/** 引航员上下船：跟着哪条船（本店班轮或别家的船）、在船边靠着的时段 */
interface PilotJob {
  t0: number;
  t1: number;
  call?: Call;
  len: number;
  beam: number;
}
/** 引航艇一段：开过去 / 开回来（a → b）、靠在船边（job）；h0：开始时的船首朝向 */
interface PilotSeg {
  t0: number;
  t1: number;
  a?: { x: number; z: number };
  b?: { x: number; z: number };
  h0?: number;
  job?: PilotJob;
}
interface PilotBoat {
  home: { x: number; z: number };
  segs: PilotSeg[];
  /** 回到泊位的时刻、泊着时船首的朝向（最后一次开回来的方向） */
  free: number;
  h: number;
}
/** 一个带缆工一次的走动：沿折线走过去、站着、走回来（时刻、折线） */
interface Gang {
  legs: { t0: number; t1: number; pts: { x: number; z: number }[] }[];
}

/** 引航艇（长 16 米）：橙色船体、白色驾驶室、蓝顶、桅杆；原点在船中，水线在 −1.2（和拖轮、船一样画在 y = 0） */
function pilotBoatGeo(): THREE.BufferGeometry {
  return merge([
    box(14, 2.5, 4.4, '#e8702a', -1, -2, 0),
    box(3.2, 1.9, 3.0, '#e8702a', 7.2, -1.4, 0),
    box(14.4, 0.28, 4.6, '#1d1d1d', -1, 0.25, 0),
    box(5.6, 2.1, 3.4, '#f4f4f0', -1.2, 0.5, 0),
    box(5.8, 0.18, 3.6, '#1f5fbf', -1.2, 2.6, 0),
    box(0.12, 0.85, 3.0, '#26313c', 1.62, 1.55, 0),
    box(4.2, 0.85, 0.06, '#26313c', -1.2, 1.55, 1.71),
    box(4.2, 0.85, 0.06, '#26313c', -1.2, 1.55, -1.71),
    cyl(0.07, 0.07, 2.8, '#d9dcdf', -2.6, 2.78, 0, 6),
    box(0.8, 0.12, 0.12, '#d9dcdf', -2.6, 4.6, 0),
    box(3.6, 0.5, 3.6, '#cfd3d7', -6.2, 0.5, 0),
  ]);
}

/** 带缆工（1.75 米）：深色工装裤、橙色反光背心、安全帽；原点在脚底 */
function handlerGeo(): THREE.BufferGeometry {
  return merge([
    box(0.18, 0.86, 0.2, '#2b2e33', 0, 0, 0.13),
    box(0.18, 0.86, 0.2, '#2b2e33', 0, 0, -0.13),
    box(0.3, 0.66, 0.52, '#ff7a1a', 0, 0.86, 0),
    box(0.1, 0.62, 0.12, '#ff7a1a', 0, 0.88, 0.32),
    box(0.1, 0.62, 0.12, '#ff7a1a', 0, 0.88, -0.32),
    box(0.22, 0.24, 0.22, '#d7b08c', 0, 1.52, 0),
    box(0.3, 0.1, 0.3, '#f4d03f', 0, 1.74, 0),
  ]);
}

export class PortOps {
  readonly group = new THREE.Group();
  private frames: Pool;
  private booms: Pool;
  private trolleys: Pool;
  private spreaders: Pool;
  private ropes: Pool;
  private rtgs: Pool;
  private rtgTrolleys: Pool;
  /** 细节的箱（本店班轮的甲板、吊具上、拖车 / 集卡上）、简化的箱（堆场、别家的船的甲板） */
  private boxes: Pool;
  private stacks: Pool;
  private tractors: Pool;
  private chassis: Pool;
  private barriers: Pool;
  /** 别家的船：每种船型、每种涂装一个实例池 */
  private hulls: Pool[][];
  /** 每个船体网格这一帧的实例是哪条船（calls 里的下标）：鼠标拾取用 */
  private hullOwner = new Map<THREE.InstancedMesh, number[]>();
  private readonly pickP = pose();
  private tugs: Pool;
  private pilotBoats: Pool;
  private handlers: Pool;
  private wakes: Pool;
  private bowWaves: Pool;
  private all: Pool[];
  private lampMat: THREE.MeshStandardMaterial;
  private statics: THREE.Group | undefined;
  private builtN = 0;
  private plan: Plan | undefined;
  private day: PortDay = { seed: 1 };
  private readonly P = pose();
  private readonly S = pose();
  private readonly at: At = { x: 0, z: 0, yaw: 0 };
  private readonly va = new THREE.Vector3();
  private readonly vb = new THREE.Vector3();
  private readonly raised: boolean[] = [false, false, false, false, false, false];
  /** 此刻浮在水面上的东西抬高多少（潮汐） */
  private fy = 0;
  /** 物流中心：作业计划（三维、监控、值班助手用同一份）、外面的车过闸口的道闸时段、调度台的作业编号（车辆下标 → 编号） */
  private readonly logi: PortLogistics;
  private readonly ttLamps = new Lamps('terminal-tractor-lamps', 160);
  private readonly ttSt: LampState = { night: false };
  private ttLamp: LampSpec = { k: 1 };
  private tcLamp: LampSpec = { k: 1 };
  private hub: PortHubPlan | undefined;
  private hubKey = '';
  private logiGates: { inK: number; outK: number; upIn: [number, number]; upOut: [number, number] }[] = [];
  private readonly opIds = new Map<number, string>();
  /** 三维层正在分段排这一天（hold）：调度台送来的作业编号先记在这里，排完再套上 */
  private held = false;
  private heldOps: readonly { id: string; vehicle?: number; zone?: string }[] | undefined;

  constructor() {
    this.group.name = 'port-ops';
    const VC = std({ vertexColors: true });
    this.frames = new Pool(stsFrame(), VC, MAX_CRANES, 'sts-frames');
    this.booms = new Pool(stsBoom(), VC, MAX_CRANES, 'sts-booms');
    this.trolleys = new Pool(stsTrolley(), VC, MAX_CRANES, 'trolleys');
    this.spreaders = new Pool(spreader(), VC, MAX_CRANES + MAX_RTG, 'spreaders');
    this.ropes = new Pool(rodGeometry(), std({ color: '#ffffff', metalness: 0.4 }), 560, 'ropes', false);
    this.rtgs = new Pool(rtgFrame(), VC, MAX_RTG, 'rtg-frames');
    this.rtgTrolleys = new Pool(rtgTrolley(), VC, MAX_RTG, 'rtg-trolleys');
    this.boxes = new Pool(containerGeometry(box, merge), std({ vertexColors: true, roughness: 0.7 }), 2400, 'port-boxes');
    this.stacks = new Pool(lowContainer(), std({ vertexColors: true, roughness: 0.72 }), 14000, 'port-stacks');
    this.tractors = new Pool(terminalTractor(), VC, MAX_CRANES * MAX_GANG + 2, 'terminal-tractors');
    this.chassis = new Pool(terminalChassis(), VC, MAX_CRANES * MAX_GANG + 2, 'terminal-chassis');
    // 码头拖车的车灯：车头大灯、平板车尾灯（灯位按车模的包围盒）
    this.ttLamp = Lamps.specOf(this.tractors.mesh.geometry);
    this.tcLamp = Lamps.specOf(this.chassis.mesh.geometry);
    this.barriers = new Pool(merge([box(5.6, 0.18, 0.18, '#f4f4f4', 2.8, 0, 0), box(0.8, 0.2, 0.2, '#d03b2a', 1.6, 0.01, 0), box(0.8, 0.2, 0.2, '#d03b2a', 3.6, 0.01, 0)]), VC, 12, 'gate-barriers');
    const hullMat = std({ vertexColors: true, roughness: 0.8 });
    this.hulls = CLASSES.map((c) => c.specs.map((s, i) => new Pool(boxShip(s), hullMat, 10, `ships-${c.key}-${i}`)));
    this.tugs = new Pool(tug(), VC, 14, 'harbour-tugs');
    this.pilotBoats = new Pool(pilotBoatGeo(), VC, 4, 'pilot-boats');
    this.handlers = new Pool(handlerGeo(), VC, 36, 'line-handlers');
    const foam = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.wakes = new Pool(wakeGeometry(), foam, 40, 'wakes', false);
    this.bowWaves = new Pool(bowWaveGeometry(), foam, 24, 'bow-waves', false);
    this.all = [this.frames, this.booms, this.trolleys, this.spreaders, this.ropes, this.rtgs, this.rtgTrolleys, this.boxes, this.stacks, this.tractors, this.chassis, this.barriers, ...this.hulls.flat(), this.tugs, this.pilotBoats, this.handlers, this.wakes, this.bowWaves];
    for (const p of this.all) this.group.add(p.mesh);
    this.lampMat = std({ color: '#fff4d6', emissive: new THREE.Color('#ffe2a8'), emissiveIntensity: 0 });
    this.buildStatic(portLayout(currentFacilities().port));
    this.logi = new PortLogistics(this.lampMat);
    this.group.add(this.ttLamps.mesh);
    this.group.add(this.logi.group);
  }

  /** 当前的泊位和岸桥布局（泊位编号、位置、哪个留给本店班轮、每个泊位的岸桥编号） */
  get layout(): { berths: { no: number; x: number; own: boolean; cranes: string[] }[]; x0: number; x1: number } {
    const L = this.plan?.L ?? portLayout(currentFacilities().port);
    return { berths: L.berths.map((b) => ({ no: b.no, x: b.x, own: b.own, cranes: b.cranes.map((c) => at(L.cranes, c).id) })), x0: L.x0, x1: L.x1 };
  }

  private buildStatic(L: Layout): void {
    if (this.statics) {
      this.group.remove(this.statics);
      this.statics.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    this.statics = this.staticParts(L);
    this.builtN = L.n;
    this.group.add(this.statics);
  }

  /** 不动的部分：码头、轨道、系缆桩、护舷、堆场的地面和标线、闸口、高杆灯、冷藏箱供电架、拖轮基地 */
  private staticParts(L: Layout): THREE.Group {
    const g = new THREE.Group();
    g.name = 'port-static';
    const X0 = L.x0;
    const X1 = L.x1;
    const p: Part[] = [];
    // 码头面（混凝土）和岸线
    p.push(box(X1 - X0 + 40, 5.8, ZQ - 1360, '#c9c6bd', (X0 + X1) / 2, -5, (ZQ + 1360) / 2));
    // 潮位线：码头墙面上高潮、低潮之间常被海水浸着的一段颜色深一些，高潮线那里有一道海藻的痕迹
    p.push(box(X1 - X0 + 40, 2 * TIDE_AMP, 0.08, '#8e8f86', (X0 + X1) / 2, SEA_MEAN - TIDE_AMP, ZQ + 0.04), box(X1 - X0 + 40, 0.22, 0.1, '#56664c', (X0 + X1) / 2, SEA_MEAN + TIDE_AMP - 0.2, ZQ + 0.05));
    p.push(box(X1 - X0 + 40, 0.5, 1.2, '#efeee9', (X0 + X1) / 2, 0.8, ZQ - 0.8));
    for (let x = X0 - 10; x <= X1 + 10; x += 22) p.push(cyl(0.45, 0.55, 0.9, '#3a3d42', x, 0.8, ZQ - 2.2), box(2.2, 2.6, 0.9, '#1e1e1e', x + 11, -2.2, ZQ + 0.3));
    // 泊位的分界：码头前沿的黄色标线
    for (const b of L.berths) for (const x of [b.x - BERTH_LEN / 2, b.x + BERTH_LEN / 2]) p.push(box(0.6, 0.06, 7, '#f2c94c', x, 0.82, ZQ - 5));
    // 带缆工的值班亭：每个泊位一头一个（码头后方）
    for (const b of L.berths) {
      const hx = gangHutX(b.x);
      p.push(box(5, 2.8, 3.4, '#e4e7ea', hx, 0.8, GANG_Z - 2.4), box(5.4, 0.3, 3.8, '#e8702a', hx, 3.6, GANG_Z - 2.4), box(1, 2.1, 0.08, '#3a3d42', hx + 1.2, 0.8, GANG_Z - 0.66));
    }
    // 引航艇的泊位：拖轮基地栈桥西侧靠外的一段（一排护舷）
    for (let k = 0; k < 2; k++) p.push(box(0.7, 1.6, 9, '#1e1e1e', X1 - 4.4, -1.4, PILOT_HOME_Z - k * 24));
    // 岸桥轨道
    for (const z of [RAIL_L, RAIL_W]) p.push(box(X1 - X0 + 40, 0.22, 0.6, '#4a4f55', (X0 + X1) / 2, 0.8, z));
    // 车道标线（码头前沿 3 条拖车道、后方车道）
    for (const z of [ZC - 9, ZC - 3, ZC + 3, ZC + 9, Z_BACK - 7, Z_BACK + 7]) for (let x = X0; x < X1; x += 12) p.push(box(6, 0.05, 0.18, '#f2f2ee', x + 3, 0.82, z));
    // 堆场地面（沥青）和箱区的白线、贝位号的短线
    p.push(box(X1 - X0 + 40, 0.2, 1360 - 1205, '#5d6166', (X0 + X1) / 2, 0.1, (1360 + 1205) / 2));
    for (let r = 0; r < 3; r++)
      for (const c of L.cols) {
        const x0 = at(COL_X0, c);
        const x1 = x0 + BAYS * 12.9;
        const zn = (ROWS[r] as { n: number }).n + 1;
        const zs = LANE(r) - 2;
        for (const z of [zn, zs]) p.push(box(x1 - x0, 0.05, 0.25, '#f2f2ee', (x0 + x1) / 2, 0.22, z));
        for (let k = 0; k <= BAYS; k++) p.push(box(0.2, 0.05, zs - zn, '#e8e8e2', x0 + k * 12.9, 0.22, (zn + zs) / 2));
        // 龙门吊的轮胎走道（两条深色带）
        for (const z of [(ROWS[r] as { n: number }).n, (ROWS[r] as { s: number }).s]) p.push(box(x1 - x0 + 20, 0.06, 2.2, '#474b50', (x0 + x1) / 2, 0.21, z));
      }
    // 冷藏箱区（一列箱区中间那排的后半段）：供电架（钢架 + 走道）
    {
      const rs = reeferOf(L);
      for (let k = 12; k < BAYS; k += 2) {
        const x = at(COL_X0, rs) + 6.45 + k * 12.9 + 6.45;
        const zn = (ROWS[1] as { n: number }).n + 1.5;
        p.push(box(0.4, 13, 0.4, '#7f8c8d', x, 0, zn), box(0.4, 13, 0.4, '#7f8c8d', x, 0, LANE(1) - 2.5), box(0.6, 0.2, LANE(1) - 2.5 - zn, '#95a5a6', x, 6.5, (zn + LANE(1) - 2.5) / 2), box(0.6, 0.2, LANE(1) - 2.5 - zn, '#95a5a6', x, 11.5, (zn + LANE(1) - 2.5) / 2));
      }
    }
    // 闸口：雨棚、6 个岗亭、识别门架、闸口楼
    p.push(box(84, 1.2, 26, '#e6e9ec', GATE_X, 7, GATE_Z), box(84.4, 0.4, 26.4, '#2a78d6', GATE_X, 8.2, GATE_Z));
    for (let k = 0; k <= 6; k++) p.push(box(0.8, 7, 0.8, '#c9cdd2', GATE_X - 42 + k * 14, 0, GATE_Z - 12), box(0.8, 7, 0.8, '#c9cdd2', GATE_X - 42 + k * 14, 0, GATE_Z + 12));
    for (let k = 0; k < 6; k++) p.push(box(2.2, 2.8, 3.2, '#f4f6f7', GATE_X - 35 + k * 14 + 4.6, 0.2, GATE_Z), box(2.3, 0.3, 3.3, '#2a78d6', GATE_X - 35 + k * 14 + 4.6, 3, GATE_Z), box(1.2, 0.15, 3.2, '#ffd166', GATE_X - 35 + k * 14 + 4.6, 0.25, GATE_Z - 4));
    for (const z of [GATE_Z - 20]) p.push(box(0.6, 7.5, 0.6, '#7f8c8d', GATE_X - 42, 0, z), box(0.6, 7.5, 0.6, '#7f8c8d', GATE_X + 42, 0, z), box(84.6, 0.8, 0.8, '#7f8c8d', GATE_X, 7.5, z));
    p.push(box(26, 9, 14, '#dfe4e8', GATE_X + 62, 0, GATE_Z - 6), box(26.2, 0.5, 14.2, '#2a78d6', GATE_X + 62, 9, GATE_Z - 6));
    for (let k = 0; k < 6; k++) for (let x = GATE_X - 42; x < GATE_X + 42; x += 14) p.push(box(0.2, 0.05, 30, '#f2f2ee', x, 0.24, GATE_Z));
    // 闸口前的广场（沥青）：外来集卡从进港的路分到各自的进闸车道排队，出闸后并回出港的路；车道分隔的虚线
    p.push(box(96, 0.29, 1205 - 1128, '#5d6166', GATE_X, 0, (1205 + 1128) / 2));
    for (let k = 0; k <= 6; k++) for (let z = 1152; z < 1200; z += 8) p.push(box(0.2, 0.04, 4, k === 3 ? '#f2c94c' : '#f2f2ee', GATE_X - 42 + k * 14, 0.29, z));
    // 拖轮基地：码头一头伸进海里的小栈桥、桥面上的系缆桩
    p.push(box(5, 5.8, 122, '#bdb9ae', X1 - 1.5, -5, ZQ + 61), box(5.2, 0.4, 122, '#efeee9', X1 - 1.5, 0.8, ZQ + 61));
    for (let z = ZQ + 10; z < ZQ + 122; z += 15) p.push(cyl(0.3, 0.38, 0.7, '#3a3d42', X1 + 0.4, 0.8, z));
    // 高杆灯：堆场四周、码头后方、箱区之间的通道
    const masts: [number, number][] = [];
    for (let x = X0 + 30; x <= X1; x += 150) masts.push([x, 1366], [x, 1236]);
    for (let i = at(L.cols, 0); i <= at(L.cols, L.cols.length - 1) + 1; i++) masts.push([at(AISLE_X, i), 1300]);
    for (const [x, z] of masts) p.push(cyl(0.35, 0.55, 36, '#9aa3ab', x, 0, z));
    const body = new THREE.Mesh(merge(p), std({ vertexColors: true, roughness: 0.85 }));
    body.receiveShadow = true;
    body.castShadow = true;
    g.add(body);
    const lamps = new THREE.Mesh(merge(masts.map(([x, z]) => box(4, 1.2, 4, '#ffffff', x, 36, z))), this.lampMat);
    g.add(lamps);
    return g;
  }

  /** 夜里高杆灯亮 */
  setNight(night: number): void {
    this.lampMat.emissiveIntensity = 1.6 * clamp01(night);
  }

  setDay(day: PortDay): void {
    drain(this.daySteps(day));
  }

  /** 和 setDay 一样排一天，只是分成很多小段（段与段之间可以让出主线程）：先后、结果都和一口气排完一样 */
  *daySteps(day: PortDay): Steps {
    this.day = day;
    // 上一天调度台的作业编号（车辆下标 → 编号）不带到这一天：物流中心的计划按这一天排（编号由 setOps 套上），
    // 换回同一天时和第一次打开时排出来的一样
    this.opIds.clear();
    const L = portLayout(currentFacilities().port);
    if (L.n !== this.builtN) this.buildStatic(L);
    const plan = yield* this.planSteps(day, L);
    this.plan = plan;
    yield;
    this.hub = this.planHub(day, plan);
    yield;
    yield* this.logi.setPlanSteps(this.hub, L.x0);
  }

  /**
   * 三维层分段排一天（view.ts）：从换了一天的车到外来集卡的行程取走为止 hold(true)。这段时间里港口先空着（没有计划，
   * 物流中心也空着），调度台送来的作业编号先记下，hold(false) 时再套上——和一口气排完时的先后一样（编号在排完、取走行程以后才套上）。
   */
  hold(on: boolean): void {
    this.held = on;
    if (on) {
      this.plan = undefined;
      this.logi.idle();
      return;
    }
    const ops = this.heldOps;
    this.heldOps = undefined;
    if (ops) this.setOps(ops);
  }

  /** 物流中心当天的作业计划：别家的船期、本店的箱、堆场每 5 分钟的箱数都从这一天的港口计划来 */
  private planHub(day: PortDay, plan: Plan): PortHubPlan {
    const calls = plan.calls
      .map((c, ci) => {
        const ops = plan.moves.filter((m) => m.call === ci);
        return { name: c.name, t0: c.tW0, t1: c.tW1, dis: ops.filter((m) => m.kind === 'dis').length, load: ops.filter((m) => m.kind === 'load').length };
      })
      .filter((c) => c.dis + c.load > 0 && Number.isFinite(c.t0) && Number.isFinite(c.t1));
    const liner = day.ship ? this.opIds.get(day.ship.vid) : undefined;
    const own = plan.boxesInfo
      .filter((b) => b.store && b.stacked !== undefined)
      .map((b) => {
        const op = b.dray !== undefined ? this.opIds.get(b.dray) : undefined;
        return { id: b.id, discharged: b.stacked as number, ...(b.pickup !== undefined ? { pickup: b.pickup } : {}), ...(op ? { dray: op } : {}), ...(liner ? { liner } : {}) };
      });
    // 堆场每 5 分钟有多少箱（差分再累加）
    const diff = new Float32Array(HUB_SLOTS + 1);
    for (const row of plan.slots)
      for (const col of row)
        for (const bay of col)
          for (const sl of bay)
            for (const tr of sl.tiers) {
              const a = Math.max(0, Math.min(HUB_SLOTS, Number.isFinite(tr.t0) ? Math.ceil(tr.t0 / HUB_SLOT) : 0));
              const b = Math.max(0, Math.min(HUB_SLOTS, Number.isFinite(tr.t1) ? Math.ceil(tr.t1 / HUB_SLOT) : HUB_SLOTS));
              if (b <= a) continue;
              diff[a] = (diff[a] as number) + 1;
              diff[b] = (diff[b] as number) - 1;
            }
    const boxes = new Float32Array(HUB_SLOTS);
    let acc = 0;
    for (let k = 0; k < HUB_SLOTS; k++) {
      acc += diff[k] as number;
      boxes[k] = acc;
    }
    // 同一天的同一份输入不用再排一遍（收货场引擎排货车要一秒左右；切换视图时港口的计划会重排）
    const input = { seed: day.seed, traffic: day.traffic ?? 1, gen: day.gen ?? ('g3' as const), calls, own };
    const key = JSON.stringify(input);
    if (this.hubKey === key && this.hub) return this.hub;
    this.hubKey = key;
    return planPortHub({ ...input, yard: { slots: 3 * plan.L.cols.length * BAYS * 6 * TIERS, boxes } });
  }

  /** 物流中心当天的作业（值班助手、看板读） */
  hubDay(): HubDay | undefined {
    return this.held ? undefined : this.hub?.day;
  }

  /** 本店的一个箱在堆场里的位置（港口局部坐标，箱位中心）：演示导览的镜头用 */
  boxSpot(id: string): { x: number; z: number; y: number } | undefined {
    const s = this.plan?.boxesInfo.find((b) => b.id === id)?.slot;
    const cols = this.plan?.L.cols;
    if (!s || !cols) return undefined;
    const r = 'ABC'.indexOf(s.block.charAt(0));
    const col = cols[Number(s.block.slice(1)) - 1];
    if (r < 0 || col === undefined) return undefined;
    return { x: at(COL_X0, col) + 6.45 + (s.bay - 1) * 12.9, z: ROW_Z(r, s.row - 1), y: s.tier * BOX_H };
  }

  /** 本店班轮那个泊位岸桥下的点（港口局部坐标）：演示导览的镜头用 */
  ownBerthSpot(): { x: number; z: number } {
    const b = this.plan?.L.berths.find((x) => x.own);
    return { x: b?.x ?? at(BERTH_X, OWN_SLOT), z: Z_BACK };
  }

  /** 调度台的作业（编号、车辆下标）：本店的集装箱拖车、班轮在物流中心的流程里按作业编号记，值班助手才接得上那一趟车 */
  setOps(ops: readonly { id: string; vehicle?: number; zone?: string }[]): void {
    if (this.held) {
      this.heldOps = ops;
      return;
    }
    this.opIds.clear();
    const cold = new Set<number>();
    for (const o of ops) {
      if (o.vehicle === undefined) continue;
      this.opIds.set(o.vehicle, o.id);
      if (o.zone && o.zone !== 'ambient') cold.add(o.vehicle);
    }
    const plan = this.plan;
    const hub = this.hub;
    if (!plan || !hub) return;
    const liner = this.day.ship ? this.opIds.get(this.day.ship.vid) : undefined;
    for (const f of hub.day.flows) {
      if (!f.own) continue;
      const b = plan.boxesInfo.find((x) => x.id === f.id);
      if (liner) f.carrierIn = liner;
      const op = b?.dray !== undefined ? this.opIds.get(b.dray) : undefined;
      if (op) f.carrierOut = op;
      if (b?.dray !== undefined && cold.has(b.dray)) f.cold = true;
    }
  }

  /** 排一天的作业：别家的船的船期（进港、靠泊、离港的航迹，拖轮）、岸桥的每一个箱、场内集卡、龙门吊、外来集卡、堆场里每个箱位 */
  private *planSteps(day: PortDay, L: Layout): Steps<Plan> {
    const r = rng(day.seed * 977 + 13);
    const rp = rng(day.seed * 7919 + 101);
    const cfg = currentFacilities().port;
    const cols = L.cols;
    const nC = cols.length;
    const colX0 = (b: number) => at(COL_X0, at(cols, b));
    const BAY_X = (b: number, k: number) => colX0(b) + 6.45 + k * 12.9;
    const reeferSlot = reeferOf(L);
    // —— 堆场：每个箱区每个贝位、每列一开始堆几层 ——
    const slots: Slot[][][][] = [];
    for (let rr = 0; rr < 3; rr++) {
      const row: Slot[][][] = [];
      for (let b = 0; b < nC; b++) {
        const col: Slot[][] = [];
        for (let k = 0; k < BAYS; k++) {
          const bay: Slot[] = [];
          for (let j = 0; j < 6; j++) {
            const reefer = rr === 1 && at(cols, b) === reeferSlot && k >= 12;
            const h = Math.floor(r() * (reefer ? 3 : 4.2));
            bay.push({ tiers: Array.from({ length: h }, (_, tier) => ({ color: reefer ? REEFER_HEX : pickHex(r), t0: -Infinity, t1: Infinity, tier })) });
          }
          col.push(bay);
        }
        row.push(col);
      }
      slots.push(row);
    }
    const slotAt = (rr: number, b: number, k: number, j: number) => at(at(at(at(slots, rr), b), k), j);
    /** 某个时刻某个箱位堆了几层、最上面那个箱 */
    const height = (s: Slot, t: number) => {
      let n = 0;
      for (const x of s.tiers) if (x.t0 <= t && t < x.t1) n++;
      return n;
    };
    const topAt = (s: Slot, t: number): Tier | undefined => {
      let best: Tier | undefined;
      for (const x of s.tiers) if (x.t0 <= t && t < x.t1 && (!best || x.tier > best.tier)) best = x;
      return best;
    };
    // —— 岸桥：检修中的、没排司机的停用（司机先保本店班轮，剩下的轮流分给别家的泊位） ——
    const why = new Map<string, string>();
    for (const c of L.cranes) if (cfg.down.includes(c.id)) why.set(c.id, '检修中（停用）');
    let crew = minCrew(cfg.staff, 'qc');
    const ownB = L.berths.find((b) => b.own) as Berth;
    for (const ci of ownB.cranes) {
      const c = at(L.cranes, ci);
      if (why.has(c.id)) continue;
      if (crew > 0) crew--;
      else why.set(c.id, '没排司机（停用）');
    }
    const otherLists = L.berths.filter((b) => !b.own).map((b) => b.cranes.filter((ci) => !why.has(at(L.cranes, ci).id)));
    const maxK = otherLists.reduce((a, l) => Math.max(a, l.length), 0);
    for (let k = 0; k < maxK; k++)
      for (const lst of otherLists) {
        const ci = lst[k];
        if (ci === undefined) continue;
        if (crew > 0) crew--;
        else why.set(at(L.cranes, ci).id, '没排司机（停用）');
      }
    const idle = (ci: number) => why.has(at(L.cranes, ci).id);
    const NC = L.cranes.length;
    const working = L.cranes.filter((_, ci) => !idle(ci)).length;
    // 场内集卡：每台岸桥配 gang 辆，司机不够就少配（至少 2 辆）
    const GANG = Math.max(2, Math.min(MAX_GANG, cfg.gang, Math.floor(minCrew(cfg.staff, 'tt') / Math.max(1, working))));
    const tractorLegs: Leg[][] = Array.from({ length: NC * GANG }, () => []);
    const nR = 3 * nC;
    const rtgTasks: RtgTask[][] = Array.from({ length: nR }, () => []);
    const rtgFree = Array.from({ length: nR }, (_, k) => ({ t: -1e9, x: BAY_X(k % nC, 12), z: ((ROWS[Math.floor(k / nC)] as { n: number }).n + (ROWS[Math.floor(k / nC)] as { s: number }).s) / 2 }));
    const rtgHome = rtgFree.map((f) => ({ x: f.x, z: f.z }));
    const tFree = Array.from({ length: NC * GANG }, () => ({ t: -1e9, at: undefined as At | undefined }));
    /** 岸桥下面的车位什么时候空出来（一次只停一辆拖车：前一辆开走、让出来以后后一辆才开进去） */
    const craneSpotFree = Array.from({ length: NC }, () => -Infinity);
    /**
     * 岸桥后面那条车道（ZC + 6）上的等候位：每辆拖车停着等的那一段（车身的 x 范围 × 时段）、从等候位开到岸桥下扫过的那一段都记下来，
     * 后来的拖车挑不重叠的位置（岸桥两边隔 22 米一个，比车身长；从近到远），停着的拖车不挤在一起，也不停在别的拖车要开过的路上。
     * 回到等候位、还不知道什么时候走的：先记到最后（开走的时候改成开走的时刻），中间停着的这一段也画出来。
     */
    type WR = { x0: number; x1: number; t0: number; t1: number; ti: number; z: number };
    const waitRes: WR[] = [];
    const openWait = new Map<number, WR>();
    const Q0 = at(BERTH_X, 0) - BERTH_LEN / 2 + 4;
    const Q1 = at(BERTH_X, BERTH_X.length - 1) + BERTH_LEN / 2 - 4;
    /** 两条等候车道：岸桥后面那条（ZC + 6），满了用后场那条（岸桥车道和后场通道之间，Z_BACK + 16） */
    const WZ = [ZC + 6, Z_BACK + 16];
    const wFree = (x0: number, x1: number, t0: number, t1: number, ti: number, z: number) => waitRes.every((w) => w.ti === ti || w.z !== z || w.x1 <= x0 || x1 <= w.x0 || w.t1 <= t0 || t1 <= w.t0);
    /**
     * 等候车道旁边的行车道：等候车道上不开车（不从别的停着的拖车身上过）。岸桥车道和后场那条等候车道之间一条、岸桥后面那条等候车道外侧一条，
     * 都是双向的：向东的靠南、向西的靠北（各偏 2 米），对开的车不在一条线上
     */
    const DRV = (z: number, east: boolean) => (z > ZC + 1 ? ZC + 12.5 : ZC - 7) + (east ? 2 : -2);
    /** 从等候位开到岸桥下：车头朝着岸桥，先斜着拐进行车道，沿行车道开到岸桥跟前再拐到吊具下面 */
    const toCrane = (w: { x: number; z: number }, xc: number): { x: number; z: number }[] => {
      const sd = w.x > xc ? 1 : -1;
      const zd = DRV(w.z, sd < 0);
      return [{ x: w.x, z: w.z }, { x: w.x - sd * 12, z: zd }, { x: xc + sd * 16, z: zd }, { x: xc, z: ZC }];
    };
    /** 开进等候位的最后一段：沿行车道往外开，从靠岸桥的那头斜着拐进等候位，车头停在等候位的外头（车身在自己的等候位里） */
    const intoWait = (w: { x: number; z: number }, xc: number): { x: number; z: number }[] => {
      const sd = w.x > xc ? 1 : -1;
      const zd = DRV(w.z, sd > 0);
      return [{ x: w.x - sd * 4, z: zd }, { x: w.x + sd * 10, z: w.z }, { x: w.x + sd * 17.5, z: w.z }];
    };
    const bodyAt = (x: number, side: number): [number, number] => (side < 0 ? [x - 17.5, x + 1] : [x - 1, x + 17.5]);
    const pickWait = (ti: number, xc: number, t0: number, t1: number) => {
      let pick: { x: number; side: number; z: number } | undefined;
      let fb: { x: number; side: number; z: number } | undefined;
      let fbBad = Infinity;
      const tEnd = Number.isFinite(t1) ? t1 + 3 : t0 + 1800;
      // 短时间等的从近到远挑（先岸桥后面那条）；不知道要停多久的（回来以后闲着）从远到近挑（先后场那条），不占岸桥跟前常用的位置
      const open = !Number.isFinite(t1);
      // 只有时段和这次挑的时段重叠的预订才有影响（顺序不变，加出来的数一样）：先挑出来，每个位置不用把一天的预订都过一遍
      const rel = waitRes.filter((w) => w.ti !== ti && w.t1 > t0 - 3 && w.t0 < Math.max(tEnd, t1 + 3));
      for (const z of open ? [...WZ].reverse() : WZ)
        for (let jj = 0; jj < 22 && !pick; jj++)
          for (const side of [-1, 1]) {
            // 不知道要停多久的从第二个位置往外挑（离岸桥最近的那个留给马上要上岸桥的），不再挑最远的：开得远、在行车道上跟别的车搅在一起
            const j = open ? Math.min(21, jj + 1) : jj;
            const x = xc + side * (34 + 24 * j);
            if (x - 18 < Q0 || x + 18 > Q1) continue;
            const [b0, b1] = bodyAt(x, side);
            // 后场那条等候车道上，别的岸桥跟前 ±30 米不停车：那台岸桥的拖车开去后场、从后场回来都从那里穿过
            const zone = z < ZC && craneSt.some((q) => Math.abs(q.x - xc) > 1 && b1 > q.x - 30 && b0 < q.x + 30);
            // 都占着的时候退而求其次：和别的车重叠（长度 × 时间）最少的那个
            let bad = zone ? 1e9 : 0;
            for (const r0 of rel) if (r0.z === z) bad += Math.max(0, Math.min(r0.x1, b1) - Math.max(r0.x0, b0)) * Math.max(0, Math.min(r0.t1, tEnd) - Math.max(r0.t0, t0 - 3));
            if (bad < fbBad) {
              fbBad = bad;
              fb = { x, side, z };
            }
            if (!zone && rel.every((w) => w.z !== z || w.x1 <= b0 || b1 <= w.x0 || w.t1 <= t0 - 3 || t1 + 3 <= w.t0)) {
              pick = { x, side, z };
              break;
            }
          }
      const w = pick ?? fb ?? { x: xc - 34, side: -1, z: ZC + 6 };
      const [b0, b1] = bodyAt(w.x, w.side);
      const res: WR = { x0: b0, x1: b1, t0: t0 - 3, t1: Number.isFinite(t1) ? t1 + 3 : Infinity, ti, z: w.z };
      waitRes.push(res);
      if (!Number.isFinite(t1)) openWait.set(ti, res);
      return { x: w.x, z: w.z, yaw: w.side > 0 ? Math.PI : 0, side: w.side };
    };
    /** 拖车从等候位开走（时刻 t）：「还不知道什么时候走」的那一段收到 t；开到岸桥 xc 下面的话记下扫过的那一段；停着的这一段画出来 */
    const leaveWait = (ti: number, legs: Leg[], tf: { t: number; at?: At }, t: number, xc?: number) => {
      const o = openWait.get(ti);
      if (!o) return;
      openWait.delete(ti);
      o.t1 = Math.max(o.t0 + 1, t + 3);
      void xc;
      if (tf.at && t > tf.t + 1) legs.push({ t0: tf.t, t1: t, at: { ...tf.at } });
    };
    /** 集卡道里要等多久才不和已经排好的拖车重叠（停着的、开过的；0 = 不用等） */
    const laneDelay = (k: number, bx: { x0: number; x1: number; t0: number; t1: number }[]) => {
      let D = 0;
      for (const o of tLane.get(k) ?? [])
        for (const q of bx) if (Math.min(o.x1, q.x1) - Math.max(o.x0, q.x0) > 0 && Math.min(o.t1, q.t1) - Math.max(o.t0, q.t0) > 0) D = Math.max(D, o.t1 + 2 - q.t0);
      return D;
    };
    /** 码头拖车在每条集卡道里的占用（x 范围 × 时段）：挑贝位时避开（同 ext 集卡的 laneUse） */
    const tLane = new Map<number, { x0: number; x1: number; t0: number; t1: number }[]>();
    const rLane = rng(day.seed * 4567 + 29);
    const laneBoxes = (b: number, xb: number, arrive: number, leave: number) => {
      const enter = at(AISLE_X, at(cols, b) + 1);
      const exit = at(AISLE_X, at(cols, b));
      return [
        { x0: xb - 1, x1: enter + 18.5, t0: arrive - (enter - xb + 18) / TRAC_V - 3, t1: arrive },
        { x0: xb - 1, x1: xb + 18.5, t0: arrive, t1: leave },
        { x0: exit - 14, x1: xb + 18.5, t0: leave, t1: leave + (xb - exit + 18) / TRAC_V + 3 },
      ];
    };
    const laneBad = (k: number, bx: { x0: number; x1: number; t0: number; t1: number }[]) => {
      let bad = 0;
      for (const o of tLane.get(k) ?? [])
        for (const q of bx) {
          const dx = Math.min(o.x1, q.x1) - Math.max(o.x0, q.x0);
          const dt = Math.min(o.t1, q.t1) - Math.max(o.t0, q.t0);
          if (dx > 0 && dt > 0) bad += dt;
        }
      return bad;
    };
    const laneAdd = (k: number, bx: { x0: number; x1: number; t0: number; t1: number }[]) => {
      const l = tLane.get(k) ?? [];
      l.push(...bx);
      tLane.set(k, l);
    };
    const rtgIndex = (rr: number, b: number) => rr * nC + b;
    // 岸桥的箱进哪个箱区：本泊位后面那列，泊位里的第 k 台岸桥 → 第 k % 3 排
    const blockOf = (c: number) => {
      const cr = at(L.cranes, c);
      return { rr: cr.k % 3, b: at(L.berths, cr.berth).col };
    };
    /** 一条拖车的路：岸桥下（x）→ 后方车道 → 通道 → 箱区的集卡道（贝位 x），回程反过来从箱区另一头出来 */
    const toYard = (xc: number, rr: number, b: number, xb: number, z0 = ZC): Poly => {
      const x1 = colX0(b) + BAYS * 12.9;
      const lane = LANE(rr);
      // 箱区之间的通道是双向的：沿通道开的时候靠右（和外来集卡错开）
      const enter = at(AISLE_X, at(cols, b) + 1) - Math.sign(lane - (Z_BACK + 4)) * AISLE_KEEP;
      // 后场通道两条车道：向东的走南边那条（Z_BACK + 4），向西的走北边那条（Z_BACK − 4），对开的车不在同一条车道上
      const zb = enter > xc ? Z_BACK + 4 : Z_BACK - 4;
      return new Poly(rounded([{ x: xc, z: z0 }, { x: xc + (enter > xc ? 14 : -14), z: zb }, { x: enter, z: zb }, { x: enter, z: lane }, { x: Math.min(x1 + 8, xb + 40), z: lane }, { x: xb, z: lane }], 9));
    };
    const fromYard = (xb: number, rr: number, b: number, xc: number, end?: { x: number; z: number }): Poly => {
      const lane = LANE(rr);
      const exit = at(AISLE_X, at(cols, b)) - Math.sign(Z_BACK - 4 - lane) * AISLE_KEEP;
      const zb = xc > exit ? Z_BACK + 4 : Z_BACK - 4;
      const s = exit < xc ? -1 : 1;
      // 回等候位：在自己岸桥的这一边穿过去（那里没有等候位），上了行车道再开到等候位
      const tail = end ? [{ x: xc + s * 20, z: DRV(end.z, end.x > xc) }, ...intoWait(end, xc)] : [{ x: xc - 18, z: ZC }, { x: xc, z: ZC }];
      return new Poly(rounded([{ x: xb, z: lane }, { x: colX0(b) - 4, z: lane }, { x: exit, z: lane }, { x: exit, z: zb }, { x: xc + s * 16, z: zb }, ...tail], 9));
    };
    const drive = (p: Poly) => (p.len / TRAC_V) * 1.18 + 6;
    /**
     * 龙门吊做一个作业：开到贝位 x，从 (zFrom, yFrom) 吊到 (zTo, yTo)。先找已经排好的作业之间放得下的空档
     * （前一个做完、走过来、做完这一个、再走到下一个作业的贝位都赶得上），没有空档才排在最后。岸桥是先排的，外来集卡和拖车靠插空档。
     * 返回：从原处吊起（lift，拖车 / 集卡上的箱被吊走、可以开走）、放到目的地（drop，箱落到拖车 / 集卡上）、做完（done）的时刻。
     */
    const rtgDo = (k: number, earliest: number, x: number, zFrom: number, yFrom: number, zTo: number, yTo: number, color: number, label: string, dry = false): { lift: number; drop: number; done: number } => {
      const f = at(rtgFree, k);
      const list = at(rtgTasks, k);
      const hFrom = 18 - (yFrom + BOX_H + 0.2);
      const hTo = 18 - (yTo + BOX_H + 0.2);
      const timing = (after: number, px: number, pz: number): number[] => {
        const start = Math.max(earliest - Math.abs(px - x) / 1.8, after);
        const atBay = start + Math.abs(px - x) / 1.8;
        const ready = Math.max(atBay, earliest);
        const tt = [start, atBay];
        tt.push(ready + Math.abs(zFrom - pz) / 1.2 + 2);
        tt.push(at(tt, 2) + hFrom / 1.5);
        tt.push(at(tt, 3) + 4);
        tt.push(at(tt, 4) + hFrom / 1.3);
        tt.push(at(tt, 5) + Math.abs(zTo - zFrom) / 1.2 + 2);
        tt.push(at(tt, 6) + hTo / 1.3);
        tt.push(at(tt, 7) + 4);
        tt.push(at(tt, 8) + hTo / 1.5);
        return tt;
      };
      for (let i = 0; i < list.length; i++) {
        const next = at(list, i);
        if (at(next.tt, 1) < earliest) continue;
        const prev = list[i - 1];
        const home = at(rtgHome, k);
        const tt = timing(prev ? at(prev.tt, 9) : -1e9, prev ? prev.x : home.x, prev ? prev.zTo : home.z);
        const move = Math.abs(x - next.x) / 1.8;
        if (at(tt, 9) + move > at(next.tt, 1)) continue;
        // 只是先算算什么时候能做（外来集卡挑贝位用），不排进去
        if (dry) return { lift: at(tt, 5), drop: at(tt, 8), done: at(tt, 9) };
        list.splice(i, 0, { t0: at(tt, 0), tt, x, zFrom, zTo, yFrom, yTo, color, label, zStart: prev ? prev.zTo : home.z });
        // 下一个作业改从这里出发：大车按原来到贝位的时刻倒推出发，小车从这个作业放下的位置开始
        next.t0 = at(next.tt, 1) - move;
        next.zStart = zTo;
        return { lift: at(tt, 5), drop: at(tt, 8), done: at(tt, 9) };
      }
      const tt = timing(f.t, f.x, f.z);
      if (dry) return { lift: at(tt, 5), drop: at(tt, 8), done: at(tt, 9) };
      list.push({ t0: at(tt, 0), tt, x, zFrom, zTo, yFrom, yTo, color, label, zStart: f.z });
      f.t = at(tt, 9);
      f.x = x;
      f.z = zTo;
      return { lift: at(tt, 5), drop: at(tt, 8), done: at(tt, 9) };
    };

    // —— 岸桥逐箱排 ——
    const moves: CraneMove[] = [];
    const boxesInfo: PortBox[] = [];
    /** 本店的箱在堆场的哪个箱位、哪一层（集装箱拖车来提的时候找它） */
    const storeStack: { id: string; s: Slot; rec: Tier; jj: number; tier: number; ready: number; info: PortBox; taken: boolean }[] = [];
    const drayLoaded = new Map<number, number>();
    let boxSeq = 1000 + Math.floor(r() * 8000);
    /** 每台岸桥：下一个箱最早什么时候开始、停在轨道上的哪里 */
    const craneSt = L.cranes.map((c) => ({ t: -1e9, x: c.rest }));
    const ownCol = ownB.col;
    interface Target {
      bay: number;
      row: number;
      tier: number;
      x: number;
      zr: number;
      y: number;
      slot?: Tier;
      into?: Slot;
    }
    /**
     * 岸桥 c 做一个箱：沿轨道走到贝位，挑这台岸桥最早空出来的场内集卡。
     * 卸船：吊起 → 放到拖车 → 拖车开到箱区、龙门吊堆好 → 拖车回岸桥下；装船：拖车先去箱区取箱（龙门吊吊上拖车）→ 开到岸桥下 → 岸桥吊上船。
     * st 推进到下一个箱能开始的时刻。
     */
    const oneMove = (c: number, st: { t: number; x: number }, kind: 'dis' | 'load', tg: Target, own: boolean, isStore: boolean, win0: number, call: number): CraneMove => {
      st.t += Math.abs(tg.x - st.x) / 0.75;
      st.x = tg.x;
      const craneT = st.t;
      const craneX = st.x;
      const g0 = c * GANG;
      let ti = g0;
      for (let k = g0 + 1; k < g0 + GANG; k++) if (at(tFree, k).t < at(tFree, ti).t) ti = k;
      const tf = at(tFree, ti);
      const legs = at(tractorLegs, ti);
      const color = isStore ? STORE_HEX : kind === 'load' ? pickHex(r) : (tg.slot?.color ?? pickHex(r));
      const id = `${isStore ? 'SXCU' : at(OWNERS, Math.floor(r() * OWNERS.length))} ${String(boxSeq++).padStart(6, '0')}`;
      // 时刻：小车出去、下放、锁、起升、回来、下放、松开、升起（装船反过来：先在陆侧从拖车上吊起，再出去放到船上）
      const dz = Math.abs(tg.zr - ZC);
      const top = tg.y + BOX_H;
      const d =
        kind === 'load'
          ? [2, (UP_Y - CHASSIS_TOP - BOX_H) / 1.8, 4, (UP_Y - CHASSIS_TOP - BOX_H) / 1.4, dz / 2.6, (UP_Y - top) / 1.4, 4, (UP_Y - top) / 1.8 + dz / 3]
          : [dz / 3, (UP_Y - top) / 1.8, 4, (UP_Y - top) / 1.4, dz / 2.6, (UP_Y - CHASSIS_TOP - BOX_H) / 1.4, 4, (UP_Y - CHASSIS_TOP - BOX_H) / 1.8];
      const rel: number[] = [0];
      for (const x of d) rel.push(at(rel, rel.length - 1) + x);
      const { rr, b } = blockOf(c);
      let xb = BAY_X(b, 2 + Math.floor(r() * 21));
      // 集卡道是单行的、只有一条：挑一个贝位，让这一趟（拐进来开到贝位、停着等龙门吊、开出去）和同一条集卡道上已经排好的拖车不重叠（不从停着的车身上开过去）
      if (!isStore) {
        let best = { x: xb, bad: Infinity };
        for (let a = 0; a < 12 && best.bad > 0; a++) {
          const xc = a === 0 ? xb : BAY_X(b, 2 + Math.floor(rLane() * 21));
          const lv = kind === 'load' ? Math.max(tf.t, craneT - 600) : Math.max(tf.t + 10, craneT) + 75;
          const arr = lv + drive(toYard(kind === 'load' ? (tf.at?.x ?? craneX) : craneX, rr, b, xc));
          const jc = rtgDo(rtgIndex(rr, b), arr, xc, LANE(rr), CHASSIS_TOP, ROW_Z(rr, 0), 0, 0, '', true);
          const bad = laneBad(rtgIndex(rr, b), laneBoxes(b, xc, arr, (kind === 'load' ? jc.drop : jc.lift) + 2));
          if (bad < best.bad) best = { x: xc, bad };
        }
        xb = best.x;
      }
      if (kind === 'load') {
        // 装船：拖车先去箱区取箱（龙门吊从堆上吊起放到拖车上），再开到岸桥下；拖车要在「从拖车吊起」的那一刻在岸桥下
        const bayK = Math.round((xb - colX0(b) - 6.45) / 12.9);
        const jj = Math.floor(r() * 6);
        const s = slotAt(rr, b, Math.max(0, Math.min(BAYS - 1, bayK)), jj);
        const p1 = toYard(tf.at?.x ?? craneX, rr, b, xb, tf.at?.z ?? ZC);
        let leave = Math.max(tf.t, craneT - 600);
        let arrive = leave + drive(p1);
        // 集卡道里停着、开过的拖车还没走：在等候位多等一会儿再出发（龙门吊的时刻按同样的参数先试排一遍）
        for (let it = 0; it < 12; it++) {
          const hh = height(s, arrive);
          const pj = rtgDo(rtgIndex(rr, b), arrive, xb, ROW_Z(rr, jj), (hh > 0 ? hh - 1 : 0) * BOX_H, LANE(rr), CHASSIS_TOP, 0, '', true);
          const D = laneDelay(rtgIndex(rr, b), laneBoxes(b, xb, arrive, pj.drop + 2));
          if (D <= 0) break;
          leave += D;
          arrive += D;
        }
        leaveWait(ti, legs, tf, leave);
        const h = height(s, arrive);
        const live = topAt(s, arrive);
        const boxColor = live?.color ?? color;
        const job = rtgDo(rtgIndex(rr, b), arrive, xb, ROW_Z(rr, jj), (h > 0 ? h - 1 : 0) * BOX_H, LANE(rr), CHASSIS_TOP, boxColor, '装船：从箱区吊上拖车');
        laneAdd(rtgIndex(rr, b), laneBoxes(b, xb, arrive, job.drop + 2));
        if (live) live.t1 = job.lift - (BOX_H * 2) / 1.3;
        const p2 = fromYard(xb, rr, b, craneX);
        const tDirect = job.drop + 2 + drive(p2);
        const tUnder = Math.max(tDirect, (craneSpotFree[c] as number) + 6);
        legs.push({ t0: leave, t1: arrive, poly: p1 }, { t0: arrive, t1: job.drop + 2, at: p1.at(p1.len) });
        let direct = true;
        if (tUnder - tDirect > 10) {
          // 岸桥下面还有车：先到一个等候位停着，轮到了再开过去（不慢吞吞地开到正在作业的拖车跟前）
          const wq = pickWait(ti, craneX, tDirect - 4, tUnder - 18);
          const pw = fromYard(xb, rr, b, craneX, wq);
          const pc = new Poly(rounded(toCrane(wq, craneX), 6));
          const tArr = job.drop + 2 + drive(pw);
          const tGo = tUnder - Math.max(18, pc.len / 4.5);
          const r0 = waitRes[waitRes.length - 1];
          if (tGo > tArr + 2 && r0 && r0.ti === ti) {
            r0.t0 = tArr - 3;
            r0.t1 = tGo + 3;
            legs.push({ t0: job.drop + 2, t1: tArr, poly: pw, box: boxColor }, { t0: tArr, t1: tGo, at: { x: wq.x, z: wq.z, yaw: wq.yaw }, box: boxColor }, { t0: tGo, t1: tUnder, poly: pc, box: boxColor });
            direct = false;
          } else if (r0 && r0.ti === ti) waitRes.pop();
        }
        if (direct) legs.push({ t0: job.drop + 2, t1: tUnder, poly: p2, box: boxColor });
        const tSwap = Math.max(craneT + at(rel, 1), tUnder + 6);
        const t0 = tSwap - at(rel, 1);
        const tt = rel.map((x) => t0 + x);
        const mv: CraneMove = { id, crane: c, kind: 'load', own, store: false, color: boxColor, bay: tg.bay, row: tg.row, tier: tg.tier, x: tg.x, zr: tg.zr, tt, shipY: tg.y, tractor: ti, call };
        moves.push(mv);
        legs.push({ t0: tUnder, t1: tSwap + 2, at: { x: craneX, z: ZC, yaw: 0 }, box: boxColor });
        // 吊走以后开到一个空着的等候位（让出岸桥下面的车位）
        const wl = pickWait(ti, craneX, tSwap + 2, Infinity);
        const sdl = wl.x > craneX ? 1 : -1;
        const pw = new Poly(rounded([{ x: craneX, z: ZC }, { x: craneX + sdl * 16, z: DRV(wl.z, sdl > 0) }, ...intoWait(wl, craneX)], 6));
        const tw = tSwap + 2 + Math.max(14, pw.len / 4.5);
        legs.push({ t0: tSwap + 2, t1: tw, poly: pw });
        craneSpotFree[c] = tSwap + 12;
        tf.t = tw;
        tf.at = { x: wl.x, z: wl.z, yaw: wl.yaw };
        // 箱放到船上那一刻（松开吊具）出现在甲板上
        if (tg.into) tg.into.tiers.push({ color: boxColor, t0: at(tt, 7), t1: Infinity, tier: tg.tier });
        st.t = at(tt, 8) + 2;
        return mv;
      }
      // 卸船：拖车从上一个箱区回来（或从车场出来），开到岸桥下等；要在「放到拖车」的那一刻在岸桥下
      const arriveUnder = tf.t;
      const tSwap = Math.max(craneT + at(rel, 5), arriveUnder + 24, (craneSpotFree[c] as number) + 24);
      const t0 = tSwap - at(rel, 5);
      const tt = rel.map((x) => t0 + x);
      if (tg.slot) tg.slot.t1 = at(tt, 3) + 1;
      const mv: CraneMove = { id, crane: c, kind: 'dis', own, store: isStore, color, bay: tg.bay, row: tg.row, tier: tg.tier, x: tg.x, zr: tg.zr, tt, shipY: tg.y, tractor: ti, call };
      moves.push(mv);
      // 先在自己的等候位等（从箱区回来就停在这里），岸桥下面的车位空出来、轮到了再开到吊具下面
      const tIn = arriveUnder < -1e8 ? tSwap - 70 : Math.max(win0 - 300, Math.min(arriveUnder, tSwap - 40));
      let from: At;
      let pc: Poly;
      let tGo: number;
      if (tf.at && Math.abs(tf.at.z - ZC) > 1 && openWait.has(ti)) {
        from = tf.at;
        pc = new Poly(rounded(toCrane(from, craneX), 6));
        tGo = Math.max(tf.t + 1, tSwap - 4 - Math.max(18, pc.len / 4.5));
        leaveWait(ti, legs, tf, tGo, craneX);
      } else {
        const wq = pickWait(ti, craneX, tIn, tSwap - 22);
        from = { x: wq.x, z: wq.z, yaw: wq.yaw };
        pc = new Poly(rounded(toCrane(from, craneX), 6));
        tGo = Math.max(tIn + 1, tSwap - 4 - Math.max(18, pc.len / 4.5));
        if (tGo - tIn > 1) legs.push({ t0: tIn, t1: tGo, at: { ...from } });
      }
      legs.push({ t0: tGo, t1: tSwap - 4, poly: pc });
      legs.push({ t0: tSwap - 4, t1: at(tt, 6) + 3, at: { x: craneX, z: ZC, yaw: 0 } });
      craneSpotFree[c] = at(tt, 6) + 3 + 10;
      const leave = at(tt, 6) + 3;
      const p1 = toYard(craneX, rr, b, xb);
      const arrive = leave + drive(p1);
      // 堆到哪一列：本店的箱都堆在本店泊位后面中间那排箱区的最后一个贝位（集装箱拖车停在它旁边的集卡道上提箱）
      let k = Math.round((xb - colX0(b) - 6.45) / 12.9);
      let jj = 0;
      let s = slotAt(rr, b, k, 0);
      let tries = 0;
      do {
        if (isStore) {
          k = BAYS - 1;
          jj = Math.floor(r() * 6);
        } else {
          k = Math.max(0, Math.min(BAYS - 1, k + (tries ? Math.floor(r() * 5) - 2 : 0)));
          jj = Math.floor(r() * 6);
        }
        s = slotAt(isStore ? 1 : rr, isStore ? ownCol : b, k, jj);
        tries++;
      } while (height(s, arrive) >= TIERS && tries < 30);
      const rrS = isStore ? 1 : rr;
      const bS = isStore ? ownCol : b;
      const xbS = BAY_X(bS, k);
      const pYard = isStore ? toYard(craneX, rrS, bS, xbS) : p1;
      let arriveS = leave + drive(pYard);
      // 集卡道里停着、开过的拖车还没走：开慢一点，等它们走了再到（龙门吊的时刻按同样的参数先试排一遍）
      for (let it = 0; it < 12; it++) {
        const hh = height(s, arriveS);
        const pj = rtgDo(rtgIndex(rrS, bS), arriveS, xbS, LANE(rrS), CHASSIS_TOP, ROW_Z(rrS, jj), hh * BOX_H, 0, '', true);
        const D = laneDelay(rtgIndex(rrS, bS), laneBoxes(bS, pYard.at(pYard.len).x, arriveS, pj.lift + 2));
        if (D <= 0) break;
        arriveS += D;
      }
      const h = height(s, arriveS);
      const job = rtgDo(rtgIndex(rrS, bS), arriveS, xbS, LANE(rrS), CHASSIS_TOP, ROW_Z(rrS, jj), h * BOX_H, color, isStore ? `堆本店的箱 ${id}` : '卸船：堆箱');
      laneAdd(rtgIndex(rrS, bS), laneBoxes(bS, pYard.at(pYard.len).x, arriveS, job.lift + 2));
      const rec: Tier = { color, t0: job.drop - 4, t1: Infinity, tier: h };
      s.tiers.push(rec);
      const liftStart = job.lift - (18 - CHASSIS_TOP - BOX_H) / 1.3;
      legs.push({ t0: leave, t1: arriveS, poly: pYard, box: color }, { t0: arriveS, t1: liftStart, at: pYard.at(pYard.len), box: color }, { t0: liftStart, t1: job.lift + 2, at: pYard.at(pYard.len) });
      // 回到一个空着的等候位（不直接开到岸桥下面：那里可能停着别的拖车）
      const wd = pickWait(ti, craneX, job.lift + 2 + drive(fromYard(xbS, rrS, bS, craneX)) - 10, Infinity);
      const p2 = fromYard(xbS, rrS, bS, craneX, wd);
      legs.push({ t0: job.lift + 2, t1: job.lift + 2 + drive(p2), poly: p2 });
      tf.t = job.lift + 2 + drive(p2);
      tf.at = { x: wd.x, z: wd.z, yaw: wd.yaw };
      st.t = at(tt, 8) + 1;
      if (isStore) {
        const block = `${at(['A', 'B', 'C'], rrS)}${bS + 1}`;
        const info: PortBox = {
          id,
          store: true,
          color: STORE_BOX,
          steps: [
            { t: at(tt, 3), text: `岸桥 ${at(L.cranes, c).id} 从班轮上吊起（${tg.tier < 0 ? '舱内' : `甲板 ${tg.bay + 1} 贝 ${tg.row + 1} 列 ${tg.tier + 1} 层`}）` },
            { t: at(tt, 6), text: `放到场内集卡 T${String(ti + 1).padStart(2, '0')}` },
            { t: arriveS, text: `开到 ${block} 箱区 ${k + 1} 贝` },
            { t: job.drop, text: `龙门吊堆到 ${block}-${k + 1}-${jj + 1}-${h + 1}，等清关、提箱` },
          ],
          slot: { block, bay: k + 1, row: jj + 1, tier: h + 1 },
          stacked: job.drop,
        };
        boxesInfo.push(info);
        storeStack.push({ id, s, rec, jj, tier: h, ready: job.drop, info, taken: false });
      }
      return mv;
    };

    /**
     * 别家的一条船：靠泊的岸桥按贝位分段（相邻两台之间空一个贝位，门架宽 20 多米不能挨着作业），
     * 每台岸桥一个贝一个贝地做：先卸甲板上的箱（从上往下）、卸舱里的，再装舱里的、装甲板上的。返回最后一个箱做完的时刻。
     */
    const workCall = (cl: Call, ci: number, t0: number, deadline: number): number => {
      const cls = at(CLASSES, cl.cls);
      const B = at(L.berths, cl.berth);
      const crs = B.cranes.filter((c) => !idle(c)).sort((a, b) => at(L.cranes, a).rest - at(L.cranes, b).rest);
      if (!crs.length) return t0;
      const nb = cls.bays.length;
      const use = Math.max(1, Math.min(crs.length, Math.floor((nb + 1) / 2)));
      const chosen = Array.from({ length: use }, (_, k) => at(crs, use === 1 ? Math.floor((crs.length - 1) / 2) : Math.round((k * (crs.length - 1)) / (use - 1))));
      // 贝位按码头上的 x 从小到大排（船首朝 −x 时反过来）
      const order = cls.bays.map((_, i) => i).sort((a, b) => cl.dir * (at(cls.bays, a).x - at(cls.bays, b).x));
      const per = (nb - (use - 1)) / use;
      let end = t0;
      let pos = 0;
      for (let g = 0; g < use; g++) {
        const n = Math.max(1, Math.round(per * (g + 1)) - Math.round(per * g));
        const bays = order.slice(pos, pos + n);
        pos += n + 1;
        const c = at(chosen, g);
        const st = at(craneSt, c);
        st.t = Math.max(st.t, t0);
        for (const bi of bays) {
          if (st.t > deadline) break;
          const [r0, r1] = rowRange(cls, bi);
          if (r1 <= r0) continue;
          const wx = cl.x + cl.dir * at(cls.bays, bi).x;
          const zr = (ri: number) => cl.zM + cl.dir * rowZ(cls, ri);
          const stacks: { ri: number; s: Slot; h: number; d: number; add: number }[] = [];
          const ex = cls.ex[0] + r() * (cls.ex[1] - cls.ex[0]);
          for (let ri = r0; ri < r1; ri++) {
            const s = at(at(cl.deck, bi), ri);
            const h = s.tiers.length;
            const dd = Math.min(h, Math.round(h * ex + (r() - 0.5)));
            const add = Math.max(0, Math.min(cls.tiers[1] + 1 - (h - dd), Math.round(dd * (0.7 + r() * 0.6))));
            stacks.push({ ri, s, h, d: dd, add });
          }
          const maxH = stacks.reduce((a, x) => Math.max(a, x.h), 0);
          const run = (kind: 'dis' | 'load', tg: Target) => {
            if (st.t > deadline) return;
            const mv = oneMove(c, st, kind, tg, false, false, t0, ci);
            end = Math.max(end, at(mv.tt, 8));
          };
          for (let tier = maxH - 1; tier >= 0; tier--) for (const x of stacks) if (tier < x.h && tier >= x.h - x.d) run('dis', { bay: bi, row: x.ri, tier, x: wx, zr: zr(x.ri), y: HATCH_Y + tier * BOX_H, slot: at(x.s.tiers, tier) });
          for (let k = 0; k < cls.hold; k++) {
            const ri = r0 + ((k * 5) % (r1 - r0));
            run('dis', { bay: bi, row: ri, tier: -1, x: wx, zr: zr(ri), y: -2.5 });
          }
          for (let k = 0; k < cls.hold; k++) {
            const ri = r0 + ((k * 3 + 1) % (r1 - r0));
            run('load', { bay: bi, row: ri, tier: -1, x: wx, zr: zr(ri), y: -2.5 });
          }
          const top = stacks.reduce((a, x) => Math.max(a, x.h - x.d + x.add), 0);
          for (let tier = 0; tier < top; tier++) for (const x of stacks) if (tier >= x.h - x.d && tier < x.h - x.d + x.add) run('load', { bay: bi, row: x.ri, tier, x: wx, zr: zr(x.ri), y: HATCH_Y + tier * BOX_H, into: x.s });
        }
      }
      return end;
    };

    // —— 别家的船：船期 ——
    const k = Math.max(1, day.traffic ?? 1);
    const others = L.berths.filter((b) => !b.own && b.cranes.some((c) => !idle(c)));
    // 过路的船：匀速沿航线走（和区域车辆层一样把拐角倒圆）
    const passing: { m: Mover; t0: number; t1: number }[] = [];
    const seaLanes: { x: number; z: number }[][] = [];
    for (const ps of day.passing ?? []) {
      if (ps.pts.length < 2 || !(ps.t1 > ps.t0)) continue;
      const pts = fillet(ps.pts.map((q) => v3(q.x, 0, q.z)), 520, 14).map((q) => ({ x: q.x, z: q.z }));
      const tr = new Track(pts, 0);
      passing.push({ m: { ph: [{ k: 'path', t0: ps.t0, t1: ps.t1, tr, s0: 0, s1: tr.len, prof: 'lin', m0: 0, m1: 0 }] }, t0: ps.t0, t1: ps.t1 });
      seaLanes.push(pts);
    }
    const spots = anchorSpots(L, seaLanes, day.ship?.path ?? []);
    const spotBusy: [number, number][][] = spots.map(() => []);
    const names = NAMES.slice();
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(rp() * (i + 1));
      const tmp = at(names, i);
      names[i] = at(names, j);
      names[j] = tmp;
    }
    const calls: Call[] = [];
    let named = 0;
    /** 航迹检查的「障碍」：船在某段时间里的位置（动的按运动算，停着的是固定位置） */
    interface Obst {
      t0: number;
      t1: number;
      len: number;
      beam: number;
      who?: Mover;
      st?: Pose;
    }
    const obst: Obst[] = [];
    const ship = day.ship;
    const liner = ship?.pose ? linerMover(ship.berth[0], ship.berth[1], ship.pose) : undefined;
    if (liner && ship) {
      obst.push({ t0: ship.berth[0] - LINER_RUN, t1: ship.berth[0], len: LINER_LEN, beam: LINER_BEAM, who: liner });
      obst.push({ t0: ship.berth[0], t1: ship.berth[1], len: LINER_LEN, beam: LINER_BEAM, st: { x: OWN_X, z: OWN_Z, h: 0, v: 0 } });
      obst.push({ t0: ship.berth[1], t1: ship.berth[1] + LINER_RUN, len: LINER_LEN, beam: LINER_BEAM, who: liner });
    }
    for (const ps of passing) obst.push({ t0: ps.t0, t1: ps.t1, len: LINER_LEN, beam: LINER_BEAM, who: ps.m });
    // 港口拥堵时本店班轮在锚地等泊位的地方（船身沿 x）：别家的船不往那里开，从旁边过要留出距离
    obst.push({ t0: -Infinity, t1: Infinity, len: LINER_LEN - 40, beam: LINER_BEAM, st: { x: LINER_ANCHOR.x, z: LINER_ANCHOR.z, h: 0, v: 0 } });
    const PA = pose();
    const PB = pose();
    /** 这条船在 [ta, tb] 里会不会和别的船挨得太近 */
    const hits = (c: Call, ta: number, tb: number): boolean => {
      const cls = at(CLASSES, c.cls);
      for (let t = ta; t <= tb; t += DT) {
        if (!poseAt(c, t, PA)) continue;
        for (const o of obst) {
          if (t < o.t0 || t > o.t1 || o.who === c) continue;
          let pb: Pose;
          if (o.st) pb = o.st;
          else if (o.who && poseAt(o.who, t, PB)) pb = PB;
          else continue;
          if (shipsHit(PA, cls.len, cls.beam, pb, o.len, o.beam)) return true;
        }
      }
      return false;
    };
    /** 停在 st（从 t0 起一直停着）会不会挡住已经排好的、会从旁边经过的船 */
    const holdHits = (st: Pose, len: number, beam: number, t0: number): boolean => {
      for (const o of obst) {
        if (!o.who || o.st || o.t1 < t0) continue;
        for (let t = Math.max(t0, o.t0); t <= o.t1; t += DT) if (poseAt(o.who, t, PB) && shipsHit(st, len, beam, PB, o.len, o.beam)) return true;
      }
      return false;
    };
    /** 排好的船登记成障碍：动的几段合在一起，停着的（靠泊、锚泊）是固定位置 */
    const register = (c: Call) => {
      for (let i = obst.length - 1; i >= 0; i--) if (at(obst, i).who === c) obst.splice(i, 1);
      const cls = at(CLASSES, c.cls);
      let m0: number | undefined;
      let m1 = 0;
      for (const p of c.ph) {
        if (p.k === 'hold') {
          if (m0 !== undefined) obst.push({ t0: m0, t1: m1, len: cls.len, beam: cls.beam, who: c });
          m0 = undefined;
          obst.push({ t0: p.t0, t1: p.t1, len: cls.len, beam: cls.beam, who: c, st: { x: p.x, z: p.z, h: p.h, v: 0 } });
        } else {
          if (m0 === undefined) m0 = p.t0;
          m1 = p.t1;
        }
      }
      if (m0 !== undefined) obst.push({ t0: m0, t1: m1, len: cls.len, beam: cls.beam, who: c });
    };
    // 本店班轮进出港时，它的航线扫过的泊位上不能有船（按大型船检查）：每个泊位不能停船的时段
    const blocked = new Map<number, [number, number][]>();
    if (liner && ship)
      for (const b of others) {
        const big = at(CLASSES, 2);
        const st: Pose = { x: b.x, z: ZQ + 2 + big.beam / 2, h: 0, v: 0 };
        const iv: [number, number][] = [];
        for (const [a0, a1] of [
          [ship.berth[0] - LINER_RUN, ship.berth[0]],
          [ship.berth[1], ship.berth[1] + LINER_RUN],
        ] as const) {
          let open: number | undefined;
          for (let t = a0; t <= a1; t += DT) {
            const hit = !!poseAt(liner, t, PA) && shipsHit(PA, LINER_LEN, LINER_BEAM, st, big.len + 40, big.beam);
            if (hit && open === undefined) open = t;
            if (!hit && open !== undefined) {
              iv.push([open - 900, t + 900]);
              open = undefined;
            }
          }
          if (open !== undefined) iv.push([open - 900, a1 + 900]);
        }
        blocked.set(b.i, iv);
      }
    const newCall = (eta: number, force?: number): Call => {
      const u = rp();
      const cls = force ?? (u < 0.38 ? 0 : u < 0.8 ? 1 : 2);
      const C = at(CLASSES, cls);
      const nm = named++;
      const deck: Slot[][] = C.bays.map((_, bi) => {
        const [r0, r1] = rowRange(C, bi);
        const base = C.tiers[0] + Math.floor(rp() * (C.tiers[1] - C.tiers[0] + 1));
        return Array.from({ length: C.rows }, (_, ri) => {
          const h = ri >= r0 && ri < r1 ? Math.max(1, Math.min(C.tiers[1], base + Math.floor(rp() * 3) - 1)) : 0;
          return { tiers: Array.from({ length: h }, (_, tier) => ({ color: pickHex(rp), t0: -Infinity, t1: Infinity, tier })) };
        });
      });
      return {
        id: '',
        name: `${at(names, nm % names.length)}${nm >= names.length ? ' 二' : ''}号`,
        cls,
        liv: rp() < 0.5 ? 0 : 1,
        berth: -1,
        dir: rp() < 0.6 ? -1 : 1,
        x: 0,
        zM: 0,
        zT: 0,
        eta,
        tArr: NaN,
        tMeet: NaN,
        tSwing: NaN,
        tPush: NaN,
        tAlong: NaN,
        tFast: NaN,
        tW0: NaN,
        tW1: NaN,
        tCast: NaN,
        tOff: NaN,
        tSwingOut: NaN,
        tOut: NaN,
        tGone: Infinity,
        ph: [],
        deck,
        moves: 0,
        ops: [],
        fin: [],
      };
    };
    const place = (c: Call, b: Berth) => {
      const C = at(CLASSES, c.cls);
      c.berth = b.i;
      c.x = b.x + (rp() - 0.5) * 16;
      c.zM = ZQ + 2 + C.beam / 2;
      c.zT = ZQ + C.len / 2 + 28;
    };
    /** 进港的航迹：直接从航道口来（减速），或者从锚位起锚过来（起步、加速、减速） */
    const inbound = (c: Call, t0: number, from?: { x: number; z: number }, off = 0): Extract<Phase, { k: 'path' }> => {
      const C = at(CLASSES, c.cls);
      const T = { x: c.x, z: c.zT };
      const Q = { x: T.x - 520 * DIN.x + LANE_OFF * DN.x, z: T.z - 520 * DIN.z + LANE_OFF * DN.z };
      if (!from) {
        const S = { x: T.x - FAIR_LEN * DIN.x + LANE_OFF * DN.x, z: T.z - FAIR_LEN * DIN.z + LANE_OFF * DN.z };
        const tr = new Track([S, Q, T], 320);
        return { k: 'path', t0, t1: t0 + (2 * tr.len) / C.v0, tr, s0: 0, s1: tr.len, prof: 'dec', m0: 0, m1: 0 };
      }
      // 起锚后先往前开一段（off：往旁边绕开前面别的锚泊船）再并进航道
      const A2 = { x: from.x + 240 * DIN.x + off * DN.x, z: from.z + 240 * DIN.z + off * DN.z };
      const tr = new Track([from, A2, Q, T], off ? 200 : 260);
      return { k: 'path', t0, t1: t0 + (2 * tr.len) / 2.6, tr, s0: 0, s1: tr.len, prof: 'bump', m0: 0, m1: 0 };
    };
    /** 靠泊：到掉头点后原地掉头（拖轮一推一拉），横推靠上码头，带缆 */
    const berthing = (c: Call, run: Extract<Phase, { k: 'path' }>): Phase[] => {
      const C = at(CLASSES, c.cls);
      const hIn = run.tr.headAt(run.tr.len);
      const hB = hIn + angDiff(hIn, c.dir > 0 ? 0 : Math.PI);
      c.tSwing = run.t1;
      c.tPush = c.tSwing + Math.abs(hB - hIn) / C.turn;
      c.tAlong = c.tPush + Math.abs(c.zT - c.zM) / C.lat;
      c.tFast = c.tAlong + 14 * 60;
      c.tArr = run.t0;
      const sMeet = Math.max(0, run.tr.len - 650);
      c.tMeet = timeAtS(run, sMeet);
      return [
        run,
        { k: 'lerp', t0: c.tSwing, t1: c.tPush, x0: c.x, z0: c.zT, x1: c.x, z1: c.zT, h0: hIn, h1: hB },
        { k: 'lerp', t0: c.tPush, t1: c.tAlong, x0: c.x, z0: c.zT, x1: c.x, z1: c.zM, h0: hB, h1: hB },
      ];
    };
    /** 离泊：解缆、拖轮拖离到掉头点、掉头、沿出港那一侧加速驶出 */
    const unberthing = (c: Call, tCast: number, hB: number): Phase[] => {
      const C = at(CLASSES, c.cls);
      const T = { x: c.x, z: c.zT };
      const Qo = { x: T.x - 520 * DIN.x - LANE_OFF * DN.x, z: T.z - 520 * DIN.z - LANE_OFF * DN.z };
      const So = { x: T.x - FAIR_LEN * DIN.x - LANE_OFF * DN.x, z: T.z - FAIR_LEN * DIN.z - LANE_OFF * DN.z };
      const tr = new Track([T, Qo, So], 320);
      const hOut = hB + angDiff(hB, tr.headAt(0));
      c.tCast = tCast;
      c.tOff = tCast + 10 * 60;
      c.tSwingOut = c.tOff + Math.abs(c.zT - c.zM) / C.lat;
      c.tOut = c.tSwingOut + Math.abs(hOut - hB) / C.turn;
      c.tGone = c.tOut + (2 * tr.len) / C.v0;
      return [
        { k: 'lerp', t0: c.tOff, t1: c.tSwingOut, x0: c.x, z0: c.zM, x1: c.x, z1: c.zT, h0: hB, h1: hB },
        { k: 'lerp', t0: c.tSwingOut, t1: c.tOut, x0: c.x, z0: c.zT, x1: c.x, z1: c.zT, h0: hB, h1: hOut },
        { k: 'path', t0: c.tOut, t1: c.tGone, tr, s0: 0, s1: tr.len, prof: 'acc', m0: 0, m1: 0 },
      ];
    };
    /** 离泊后让出掉头点的时刻（下一条船可以开始掉头） */
    const clearAt = (c: Call): number => {
      const p = c.ph[c.ph.length - 1];
      if (!p || p.k !== 'path') return c.tGone;
      return timeAtS(p, Math.min(p.s1, 480));
    };
    const spotFree = (si: number, t: number) => at(spotBusy, si).every(([, b]) => b <= t);
    /** 到锚地：沿锚位那条线从外海驶来、减速、抛锚 */
    const toAnchor = (c: Call): boolean => {
      const C = at(CLASSES, c.cls);
      for (let si = 0; si < spots.length; si++) {
        if (!spotFree(si, c.eta)) continue;
        const sp = at(spots, si);
        const S = { x: sp.x - 1700 * DIN.x, z: sp.z - 1700 * DIN.z };
        const tr = new Track([S, sp], 0);
        const t1 = c.eta + (2 * tr.len) / C.v0;
        c.ph = [
          { k: 'path', t0: c.eta, t1, tr, s0: 0, s1: tr.len, prof: 'dec', m0: 0, m1: 0 },
          { k: 'hold', t0: t1, t1: Infinity, x: sp.x, z: sp.z, h: H_IN },
        ];
        if (hits(c, c.eta, t1 + 120) || holdHits({ x: sp.x, z: sp.z, h: H_IN, v: 0 }, C.len, C.beam, t1)) continue;
        c.anchor = { spot: si, t0: t1, t1: Infinity };
        at(spotBusy, si).push([c.eta, Infinity]);
        register(c);
        return true;
      }
      c.ph = [];
      return false;
    };
    /**
     * 进港和靠泊（泊位最早 R 时刻空出来）：从锚位起锚或直接从航道口驶来，掉头、横推、带缆；
     * 本店班轮扫过这个泊位的时段要避开，航迹撞了就晚 2 分钟再试。返回出发的时刻（c.ph 排好到靠泊为止）。
     */
    const arrive = (c: Call, R: number, iv: [number, number][], estDwell: number): number => {
      const sp = c.anchor ? at(spots, c.anchor.spot) : undefined;
      const anchorPh = c.ph.length && c.anchor && c.ph[0]?.k === 'path' ? c.ph[0] : undefined;
      let run = inbound(c, 0, sp);
      const lead = run.t1 - run.t0;
      let t0 = c.anchor ? Math.max(c.anchor.t0 + 900, R - lead) : Math.max(c.eta, R - lead);
      let arr: Phase[] = [];
      // 从锚位出来的几条走法：直接并进航道，或者往两边绕开挡在前面的锚泊船
      const offs = sp ? [0, 170, -170, 340, -340] : [0];
      let ok = false;
      for (let tries = 0; tries < 120 && !ok; tries++) {
        for (const off of offs) {
          run = inbound(c, t0, sp, off);
          arr = berthing(c, run);
          // 起锚：先在锚位上原地转到要走的方向，再开出去
          const anc: Phase[] = [];
          if (sp && c.anchor) {
            const h0 = run.tr.headAt(0);
            const turn = Math.abs(angDiff(H_IN, h0));
            const ts = Math.min(t0, t0 - turn / at(CLASSES, c.cls).turn);
            const hRun = H_IN + angDiff(H_IN, h0);
            // 航迹的朝向接着转过来的角度往下走（不跳 2π）
            if (Math.abs(hRun - h0) > 1e-6) for (let i = 0; i < run.tr.hs.length; i++) run.tr.hs[i] = at(run.tr.hs, i) + (hRun - h0);
            anc.push({ k: 'hold', t0: c.anchor.t0, t1: ts, x: sp.x, z: sp.z, h: H_IN });
            if (ts < t0) anc.push({ k: 'lerp', t0: ts, t1: t0, x0: sp.x, z0: sp.z, x1: sp.x, z1: sp.z, h0: H_IN, h1: hRun });
            const sw = arr[1] as Extract<Phase, { k: 'lerp' }>;
            const hEnd = run.tr.headAt(run.tr.len);
            sw.h1 = hEnd + angDiff(hEnd, sw.h1);
            sw.h0 = hEnd;
            (arr[2] as Extract<Phase, { k: 'lerp' }>).h0 = sw.h1;
            (arr[2] as Extract<Phase, { k: 'lerp' }>).h1 = sw.h1;
          }
          const hB1 = (arr[2] as Extract<Phase, { k: 'lerp' }>).h1;
          c.ph = [...(anchorPh ? [anchorPh] : []), ...anc, ...arr, { k: 'hold', t0: c.tAlong, t1: Infinity, x: c.x, z: c.zM, h: hB1 }];
          // 本店班轮进出港扫过这个泊位的时段里不能在这里：改到那之后再掉头靠泊；窗口开始前还能作业好几个小时的照样靠泊，岸桥只做到窗口前
          const occ0 = c.tSwing - 600;
          const occ1 = c.tFast + estDwell + 3600;
          const clash = iv.find(([a, z]) => occ0 < z && occ1 > a);
          if (clash && !(occ0 < clash[0] && clash[0] - c.tFast > 5.5 * 3600)) {
            t0 += clash[1] - occ0 + 60 - 120;
            break;
          }
          if (!hits(c, t0, c.tFast)) {
            ok = true;
            break;
          }
        }
        if (!ok) t0 += 120;
      }
      return t0;
    };
    /**
     * 把一条船排进泊位 b（泊位最早 R 时刻空出来）：进港靠泊 → 岸桥作业 → 离泊（检查航迹，撞了就晚 3 分钟）。
     * 返回下一条船可以开始掉头的时刻。
     */
    const serve = (c: Call, b: Berth, R: number): number => {
      place(c, b);
      const C = at(CLASSES, c.cls);
      const iv = blocked.get(b.i) ?? [];
      const crs = b.cranes.filter((ci) => !idle(ci)).length;
      const moves0 = c.deck.reduce((a, bay) => a + bay.reduce((p, s) => p + s.tiers.length, 0), 0);
      const estDwell = (moves0 * 0.8 + C.bays.length * C.hold * 2) / Math.max(1, Math.min(crs, Math.floor((C.bays.length + 1) / 2))) / 27 * 3600 + 3600;
      let t0 = arrive(c, R, iv, estDwell);
      // 泊位要等很久才空：先到锚地抛锚等，不在港外干等
      if (!c.anchor && t0 - c.eta > 2400 && toAnchor(c)) t0 = arrive(c, R, iv, estDwell);
      if (c.anchor) {
        c.anchor.t1 = t0;
        const busy = at(spotBusy, c.anchor.spot);
        const last = busy[busy.length - 1];
        if (last) last[1] = t0 + 300;
      }
      if (!calls.includes(c)) calls.push(c);
      const ci = calls.indexOf(c);
      // 岸桥作业：系好缆 15 分钟后开工；本店班轮要扫过这个泊位前得做完、留出离泊的时间
      c.tW0 = c.tFast + 15 * 60;
      const next = iv.find(([a]) => a > c.tFast);
      const deadline = next ? next[0] - 3 * 3600 : Infinity;
      const end = workCall(c, ci, c.tW0, deadline);
      c.tW1 = end;
      const hB = (c.ph[c.ph.length - 1] as { h: number }).h;
      let tCast = Math.max(end + 25 * 60, c.tFast + 1.5 * 3600);
      const before = c.ph.slice(0, c.ph.length - 1);
      for (let tries = 0; tries < 60; tries++) {
        const dep = unberthing(c, tCast, hB);
        c.ph = [...before, { k: 'hold', t0: c.tAlong, t1: c.tOff, x: c.x, z: c.zM, h: hB }, ...dep];
        if (!hits(c, c.tOff, c.tGone)) break;
        tCast += 180;
      }
      register(c);
      return clearAt(c);
    };

    // 一开始（零点）：有的泊位上停着昨天来的船、作业到一半
    const ready = new Map<number, number>();
    const closed = new Set<number>();
    for (const b of others) {
      yield;
      const iv = blocked.get(b.i) ?? [];
      const tF = -(0.4 + rp() * 4.5) * 3600;
      // 本店班轮进出港要扫过这个泊位：赶不及在那之前做完走掉的，零点时泊位就空着，等班轮过去
      const win = iv.find(([, z]) => z > tF - 3600);
      if (win && win[0] - tF < 4.5 * 3600) {
        rp();
        ready.set(b.i, Math.max(win[1], -3600));
        continue;
      }
      if (rp() < 0.85) {
        const c = newCall(-12 * 3600);
        place(c, b);
        c.tFast = tF;
        c.tAlong = c.tFast - 14 * 60;
        c.tArr = c.tMeet = c.tSwing = c.tPush = -Infinity;
        c.eta = c.tFast - 1.6 * 3600;
        const hB = c.dir > 0 ? 0 : Math.PI;
        calls.push(c);
        c.tW0 = c.tFast + 15 * 60;
        c.tW1 = workCall(c, calls.length - 1, c.tW0, win ? win[0] - 3 * 3600 : Infinity);
        let tCast = Math.max(c.tW1 + 25 * 60, c.tFast + 1.5 * 3600);
        for (let tries = 0; tries < 60; tries++) {
          const dep = unberthing(c, tCast, hB);
          c.ph = [{ k: 'hold', t0: -Infinity, t1: c.tOff, x: c.x, z: c.zM, h: hB }, ...dep];
          if (!hits(c, c.tOff, c.tGone)) break;
          tCast += 180;
        }
        register(c);
        ready.set(b.i, clearAt(c));
      } else ready.set(b.i, (-1 + rp() * 2.5) * 3600);
    }
    // 负荷高：零点时锚地上已经有船在等，白天还会再来几条（泊位排不过来，按到港先后轮流进港）
    const waiting: Call[] = [];
    const nb = others.length;
    const n0 = nb ? Math.round((k - 1) * (0.6 * nb + 0.6)) : 0;
    for (let i = 0; i < n0; i++) {
      const c = newCall(-(1 + rp() * 8) * 3600);
      const si = spots.findIndex((_, j) => spotFree(j, -Infinity));
      if (si < 0) break;
      const sp = at(spots, si);
      c.anchor = { spot: si, t0: -Infinity, t1: Infinity };
      c.ph = [{ k: 'hold', t0: -Infinity, t1: Infinity, x: sp.x, z: sp.z, h: H_IN }];
      at(spotBusy, si).push([-Infinity, Infinity]);
      register(c);
      waiting.push(c);
      calls.push(c);
    }
    waiting.sort((a, b) => a.eta - b.eta);
    const nE = nb ? Math.round((k - 1) * (0.8 * nb + 0.6)) : 0;
    // 平常每天也有一两条船提前到，先在锚地等它的靠泊窗口
    let early = nb ? Math.max(1, Math.round(nb * 0.7)) : 0;
    const extras = Array.from({ length: nE }, () => (0.5 + rp() * 21) * 3600)
      .sort((a, b) => a - b)
      .map((eta) => newCall(eta));
    for (let guard = 0; guard < 400 && nb; guard++) {
      yield;
      let bi = -1;
      let R = Infinity;
      for (const b of others) {
        if (closed.has(b.i)) continue;
        const v = ready.get(b.i) as number;
        if (v < R) {
          R = v;
          bi = b.i;
        }
      }
      const ex = extras[0];
      if (ex && (bi < 0 || ex.eta < R - 25 * 60)) {
        // 泊位都忙：到锚地抛锚等（锚位都满了就在港外等，不画）
        extras.shift();
        if (toAnchor(ex)) calls.push(ex);
        waiting.push(ex);
        continue;
      }
      if (bi < 0) break;
      if (R > DAY_END - 600) {
        closed.add(bi);
        continue;
      }
      const b = at(L.berths, bi);
      let c = waiting.shift();
      if (!c) {
        const eta = R - 20 * 60 + rp() * 55 * 60;
        if (eta > DAY_END - 1500) {
          closed.add(bi);
          continue;
        }
        // 离本店班轮扫过这个泊位的时段不远了：来一条小船（作业量少，赶在那之前走）
        const nextWin = (blocked.get(bi) ?? []).find(([a]) => a > R);
        const isEarly = early > 0 && R > 3 * 3600 && R < DAY_END - 4 * 3600 && rp() < 0.45;
        c = newCall(isEarly ? R - (1.5 + rp() * 2) * 3600 : eta, nextWin && nextWin[0] - R < 10 * 3600 ? 0 : undefined);
        if (isEarly) {
          early--;
          toAnchor(c);
        }
      }
      ready.set(bi, serve(c, b, R));
    }
    // 到半夜还没排上泊位的船：在锚地等到明天（港外等的不画）
    for (const c of waiting) if (!c.anchor) c.ph = [];
    // 船期编号：按靠泊（还没排上的按到港）的先后
    const order = calls.slice().sort((a, b) => (Number.isFinite(a.tFast) ? a.tFast : a.eta + 1e6) - (Number.isFinite(b.tFast) ? b.tFast : b.eta + 1e6));
    order.forEach((c, i) => (c.id = `V${String(i + 1).padStart(2, '0')}`));

    // —— 本店班轮：甲板上的箱（每个贝位每列堆 3–6 层）、岸桥作业 ——
    const own = ship ? { t0: ship.berth[0] + 25 * 60, t1: ship.berth[1] - 25 * 60 } : undefined;
    const deck: Slot[][] = SHIP_BAYS.map(() => Array.from({ length: SHIP_ROWS }, () => ({ tiers: [] as Tier[] })));
    deck.forEach((bay, bi) =>
      bay.forEach((s, ri) => {
        const narrow = bi > 13 && (ri < 2 || ri > SHIP_ROWS - 3);
        const h = narrow ? 0 : 3 + Math.floor(r() * 4);
        for (let tier = 0; tier < h; tier++) s.tiers.push({ color: pickHex(r), t0: -Infinity, t1: Infinity, tier });
      }),
    );
    // 16 个贝位分给本店泊位的几台岸桥：相邻两台之间空一个贝位
    const OWN = ownB.cranes.length;
    const ownBays: number[][] = [];
    {
      const per = (16 - (OWN - 1)) / OWN;
      let pos = 0;
      for (let j = 0; j < OWN; j++) {
        const n = Math.max(1, Math.round(per * (j + 1)) - Math.round(per * j));
        ownBays.push(Array.from({ length: n }, (_, i) => Math.min(15, pos + i)));
        pos += n + 1;
      }
    }
    let storeLeft = ship?.storeBoxes ?? 0;
    if (own)
      for (let j = 0; j < OWN; j++) {
        yield;
        const c = at(ownB.cranes, j);
        if (idle(c)) continue;
        const bays = at(ownBays, j);
        const st = at(craneSt, c);
        st.t = Math.max(st.t, own.t0);
        st.x = OWN_X + at(SHIP_BAYS, at(bays, 0));
        // 这台岸桥卸的箱：按贝位从上往下、按列；甲板下面（舱里）吊具伸进舱口
        const queue: Target[] = [];
        for (const bi of bays)
          for (let tier = 7; tier >= 0; tier--)
            for (let ri = 0; ri < SHIP_ROWS; ri++) {
              const tr = at(at(deck, bi), ri).tiers.find((x) => x.tier === tier);
              if (tr) queue.push({ bay: bi, row: ri, tier, x: OWN_X + at(SHIP_BAYS, bi), zr: OWN_Z + SHIP_ROW_Z(ri), y: DECK_Y + tier * BOX_H, slot: tr });
            }
        for (let kk = 0; kk < 80; kk++) {
          const bi = at(bays, kk % bays.length);
          queue.push({ bay: bi, row: kk % SHIP_ROWS, tier: -1, x: OWN_X + at(SHIP_BAYS, bi), zr: OWN_Z + SHIP_ROW_Z(kk % SHIP_ROWS), y: -2.5 });
        }
        let qi = 0;
        let loadPhase = false;
        let loads = 0;
        let loadPlan = 0;
        while (st.t < own.t1 - 200) {
          // 一次吊一个箱就让出一下（分段排的时候；先后不变）
          yield;
          // 卸完（或者靠泊时段过了 55%）就装船（箱从堆场来，放回甲板），装这台岸桥卸下来的六成（进口为主的挂靠）
          if (!loadPhase && (qi >= queue.length || st.t > own.t0 + (own.t1 - own.t0) * 0.55)) {
            loadPhase = true;
            loadPlan = Math.round(qi * 0.6);
          }
          if (loadPhase ? loads >= loadPlan : qi >= queue.length) break;
          if (loadPhase) {
            // 装船：挑一个这台岸桥的贝位、高度还没到 6 层的列
            const bi = at(bays, Math.floor(r() * bays.length));
            const ri = Math.floor(r() * SHIP_ROWS);
            const sl = at(at(deck, bi), ri);
            const h = height(sl, st.t);
            if (h >= 6 || (bi > 13 && (ri < 2 || ri > SHIP_ROWS - 3))) {
              st.t += 20;
              continue;
            }
            oneMove(c, st, 'load', { bay: bi, row: ri, tier: h, x: OWN_X + at(SHIP_BAYS, bi), zr: OWN_Z + SHIP_ROW_Z(ri), y: DECK_Y + h * BOX_H, into: sl }, true, false, own.t0, -1);
            loads++;
            continue;
          }
          const q = at(queue, qi++);
          const isStore = storeLeft > 0 && r() < 0.08;
          if (isStore) storeLeft--;
          oneMove(c, st, 'dis', q, true, isStore, own.t0, -1);
        }
      }

    // —— 来提本店箱的集装箱拖车：本店泊位后面中间那排箱区的龙门吊把最上面的一个本店箱吊到拖车上（和外来集卡按时间先后排） ——
    const drays = (day.drays ?? []).slice().sort((a, c2) => a.t0 - c2.t0);
    let di = 0;
    const serveDrays = (until: number) => {
      while (di < drays.length && (drays[di] as { t0: number }).t0 + 60 <= until) {
        const d = drays[di++] as NonNullable<PortDay['drays']>[number];
        const kk = rtgIndex(1, ownCol);
        if (at(rtgFree, kk).t > d.t1 - 400) continue;
        const cand = storeStack.find((b) => !b.taken && b.ready < d.t0 && height(b.s, d.t0) - 1 === b.tier);
        if (!cand) continue;
        cand.taken = true;
        const job = rtgDo(kk, d.t0 + 60, BAY_X(ownCol, BAYS - 1), ROW_Z(1, cand.jj), cand.tier * BOX_H, LANE(1), CHASSIS_TOP, STORE_HEX, `装本店的箱 ${cand.id} 上集装箱拖车`);
        if (job.drop > d.t1 - 30) continue;
        cand.rec.t1 = job.lift - (18 - cand.tier * BOX_H - BOX_H - 0.2) / 1.3;
        drayLoaded.set(d.vid, job.drop);
        cand.info.steps.push({ t: job.drop, text: `龙门吊装上集装箱拖车（${d.label.slice(0, 16)}），出闸送物流园` });
        cand.info.pickup = job.drop;
        cand.info.dray = d.vid;
      }
    };
    // —— 场内集卡互相让一让：按出发的先后，这一段要是和别的车（开着的、停着的）挨上了，就在原地多等几秒再走
    // （到的时刻不变、路上开快一点，最多等 10 秒、不超过这一段用时的 35%；只在岸桥下、等候位、后场出发的这几段等，箱区集卡道里的不等）——
    {
      let tMin = Infinity;
      let tMax = -Infinity;
      for (const lst of tractorLegs) {
        lst.sort((a, c2) => a.t0 - c2.t0);
        for (const l of lst) {
          tMin = Math.min(tMin, l.t0);
          tMax = Math.max(tMax, l.t1);
        }
      }
      if (Number.isFinite(tMin)) {
        const T0 = Math.floor(tMin / 2) * 2;
        const NT = tractorLegs.length;
        // 每辆车每 2 秒一个样：车头、车尾（没有路段的时候是空的，和画的时候一样不画）。不存一整天（几十兆），
        // 按一小时一块存（块里再多放一段最长的路段的时长）：换到下一块时按原来的时刻重新取样、再把已经让过的那几段重放一遍，结果和存一整天一样
        let A0 = T0;
        let NS = 0;
        let S = new Float32Array(0);
        const o: At = { x: 0, z: 0, yaw: 0 };
        /** 多等的那几秒停在哪：上一段的终点（朝向也是上一段的，不在原地转个身） */
        let hold: At | undefined;
        const poseOf = (l: Leg, t: number, go = l.t0): boolean => {
          if (l.poly && t <= go && hold) {
            o.x = hold.x;
            o.z = hold.z;
            o.yaw = hold.yaw;
          } else if (l.poly) l.poly.at(t <= go ? 0 : l.poly.len * drivePos(prog(t, go, l.t1), l.t1 - go), o);
          else if (l.at) {
            o.x = l.at.x;
            o.z = l.at.z;
            o.yaw = l.at.yaw;
          } else return false;
          return true;
        };
        const put = (ti: number, t: number) => {
          const i = (ti * NS + (t - A0) / 2) * 4;
          S[i] = o.x;
          S[i + 1] = o.z;
          S[i + 2] = o.x - Math.cos(o.yaw) * 16;
          S[i + 3] = o.z + Math.sin(o.yaw) * 16;
        };
        /** 原来的时刻（让之前）：重新取样用 */
        const orig = new Map<Leg, [number, number]>();
        for (const lst of tractorLegs) for (const l of lst) orig.set(l, [l.t0, l.t1]);
        /** 让过的段：车、段、原来的出发时刻、在哪儿多等 */
        const updates: { ti: number; l: Leg; t0: number; hold: At | undefined }[] = [];
        const writeUpd = (ti: number, l: Leg, t0: number) => {
          for (let t = T0 + Math.ceil((Math.max(t0, A0) - T0) / 2) * 2; t < l.t1 && t < A0 + NS * 2; t += 2) {
            poseOf(l, t);
            put(ti, t);
          }
        };
        const loadSlab = () => {
          S.fill(Number.NaN);
          const A1 = A0 + NS * 2;
          hold = undefined;
          tractorLegs.forEach((lst, ti) => {
            for (const l of lst) {
              const [a, b] = orig.get(l) ?? [l.t0, l.t1];
              if (b <= A0 || a >= A1) continue;
              for (let t = T0 + Math.ceil((Math.max(a, A0) - T0) / 2) * 2; t < b && t < A1; t += 2) if (poseOf(l, t, a)) put(ti, t);
            }
          });
          for (const u of updates) {
            if (u.l.t1 <= A0 || u.t0 >= A1) continue;
            hold = u.hold;
            writeUpd(u.ti, u.l, u.t0);
          }
          hold = undefined;
        };
        const dSeg = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
          const vx = bx - ax;
          const vz = bz - az;
          const L2 = vx * vx + vz * vz || 1;
          const k = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / L2));
          return Math.hypot(px - ax - vx * k, pz - az - vz * k);
        };
        const clash = (ti: number, t: number): boolean => {
          const k = (t - A0) / 2;
          if (k < 0 || k >= NS) return false;
          const fx = o.x;
          const fz = o.z;
          const rx = o.x - Math.cos(o.yaw) * 16;
          const rz = o.z + Math.sin(o.yaw) * 16;
          for (let tj = 0; tj < NT; tj++) {
            if (tj === ti) continue;
            const i = (tj * NS + k) * 4;
            const gx = S[i] as number;
            if (Number.isNaN(gx) || Math.abs(gx - fx) > 36) continue;
            const gz = S[i + 1] as number;
            if (Math.abs(gz - fz) > 36) continue;
            const hx = S[i + 2] as number;
            const hz = S[i + 3] as number;
            if (Math.min(dSeg(fx, fz, gx, gz, hx, hz), dSeg(rx, rz, gx, gz, hx, hz), dSeg(gx, gz, fx, fz, rx, rz), dSeg(hx, hz, fx, fz, rx, rz)) < 2.4) return true;
          }
          return false;
        };
        const order: { ti: number; l: Leg }[] = [];
        tractorLegs.forEach((lst, ti) => {
          for (const l of lst) if (l.poly && l.t1 - l.t0 >= 8 && l.poly.pts[0] && (l.poly.pts[0] as { z: number }).z > 1370) order.push({ ti, l });
        });
        order.sort((a, b) => a.l.t0 - b.l.t0);
        const SLAB = 3600;
        let maxDur = 0;
        for (const { l } of order) maxDur = Math.max(maxDur, l.t1 - l.t0);
        NS = Math.ceil((SLAB + maxDur) / 2) + 4;
        S = new Float32Array(NT * NS * 4);
        let slabEnd = -Infinity;
        const added: Leg[][] = tractorLegs.map(() => []);
        for (const { ti, l } of order) {
          yield;
          if (l.t0 >= slabEnd) {
            A0 = T0 + Math.floor((l.t0 - T0) / SLAB) * SLAB;
            slabEnd = A0 + SLAB;
            loadSlab();
          }
          const lst = at(tractorLegs, ti);
          let prev: Leg | undefined;
          for (const q of lst) if (q !== l && q.t1 <= l.t0 + 0.5 && (!prev || q.t1 > prev.t1)) prev = q;
          if (prev && Math.abs(prev.t1 - l.t0) < 0.5) {
            if (prev.at) hold = { ...prev.at };
            else if (prev.poly) hold = prev.poly.at(prev.poly.len) as At;
            else hold = undefined;
          } else hold = undefined;
          const maxD = Math.min(10, Math.floor((0.35 * (l.t1 - l.t0)) / 2) * 2);
          let best = 0;
          let bestN = Infinity;
          for (let d = 0; d <= maxD && bestN > 0; d += 2) {
            let n = 0;
            for (let t = T0 + Math.ceil((l.t0 - T0) / 2) * 2; t < l.t1 && n < bestN; t += 2) if (poseOf(l, t, l.t0 + d) && clash(ti, t)) n++;
            if (n < bestN) {
              bestN = n;
              best = d;
            }
          }
          if (best <= 0) continue;
          const t0 = l.t0;
          const p0 = hold ?? (l.poly?.at(0) as At);
          if (prev && prev.at && Math.abs(prev.t1 - t0) < 0.5 && prev.box === l.box) prev.t1 = t0 + best;
          else at(added, ti).push({ t0, t1: t0 + best, at: { x: p0.x, z: p0.z, yaw: p0.yaw }, ...(l.box !== undefined ? { box: l.box } : {}) });
          l.t0 = t0 + best;
          updates.push({ ti, l, t0, hold: hold ? { ...hold } : undefined });
          writeUpd(ti, l, t0);
        }
        added.forEach((lst, ti) => {
          if (!lst.length) return;
          at(tractorLegs, ti).push(...lst);
          at(tractorLegs, ti).sort((a, c2) => a.t0 - c2.t0);
        });
      }
    }
    // —— 外来集卡：从闸口进来，到箱区提箱或送箱，再出闸（泊位多的码头车也多） ——
    const gate: Gate[] = [];
    const lanes = Math.max(1, Math.min(3, Math.round(cfg.gateLanes || 3)));
    const rate = k * (0.5 + nC / 4);
    // 箱区集卡道上外来集卡占着的地方：每条集卡道一串（x 范围、时段）。集卡从右边的通道拐进集卡道往左开到贝位停下，做完再往左开出去：
    // 进来、停着、出去各占一块，挑贝位时不和已经排好的车的那几块重叠（挑不到就换一个箱区、贝位，再不行在闸口多等一会儿）
    const laneUse = new Map<number, { x0: number; x1: number; t0: number; t1: number }[]>();
    /** 闸口里面的路口的预订表（portLayout 的 JunctionBook：同一个范围、同一个占用时段）：进、出的车都按它错开，物流中心、空箱堆场的车接着往里记 */
    const jbook = new JunctionBook();
    const junctionIv = jbook.list;
    // 码头拖车在集卡道里的那几段（拐进来开到贝位、停在贝位上等龙门吊、开出去）也记进去：外来集卡挑贝位和时刻时避开它们
    // （以前只避开别的外来集卡，拖车会从停着的集卡身上开过去、两辆车停在同一个贝位上）
    {
      const LT = 17.5;
      const q = { x: 0, z: 0, yaw: 0 };
      const laneOf = (x: number, z: number): number => {
        for (let rr = 0; rr < 3; rr++) {
          if (Math.abs(z - LANE(rr)) > 1.2) continue;
          for (let b = 0; b < nC; b++) if (x >= colX0(b) - 30 && x <= colX0(b) + BAYS * 12.9 + 30) return rtgIndex(rr, b);
        }
        return -1;
      };
      const put = (k: number, o: { x0: number; x1: number; t0: number; t1: number }) => {
        const lu = laneUse.get(k) ?? [];
        lu.push(o);
        laneUse.set(k, lu);
      };
      /** 缓起缓停开完一段路时，开到路程 d 的时刻 */
      const tAt = (leg: Leg, len: number, d: number): number => {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 22; i++) {
          const m = (lo + hi) / 2;
          if (drivePos(m, leg.t1 - leg.t0) * len < d) lo = m;
          else hi = m;
        }
        return leg.t0 + ((lo + hi) / 2) * (leg.t1 - leg.t0);
      };
      for (const legs of tractorLegs)
        for (const leg of legs) {
          if (leg.at) {
            const k = laneOf(leg.at.x, leg.at.z);
            if (k >= 0) put(k, { x0: leg.at.x - 1, x1: leg.at.x + LT + 1, t0: leg.t0 - 2, t1: leg.t1 + 2 });
            continue;
          }
          const p = leg.poly;
          if (!p) continue;
          let k = -1;
          let s0 = 0;
          let s1 = 0;
          let xa = Infinity;
          let xz = -Infinity;
          for (let d = 0; d <= p.len; d += 1.5) {
            p.at(d, q);
            const kk = laneOf(q.x, q.z);
            if (kk < 0) continue;
            if (k < 0) {
              k = kk;
              s0 = d;
            }
            s1 = d;
            xa = Math.min(xa, q.x);
            xz = Math.max(xz, q.x);
          }
          if (k >= 0) put(k, { x0: xa - 1, x1: xz + LT + 1, t0: tAt(leg, p.len, Math.max(0, s0 - LT)) - 2, t1: tAt(leg, p.len, Math.min(p.len, s1 + LT)) + 2 });
        }
    }
    const ry = rng(day.seed * 389 + 61);
    const EXT_L = 17.5;
    /** 缓起缓停地开完一条路径（用时 T）时，开到路程 d 的时刻（从出发算） */
    const easedAt = (p: Poly, d: number, T: number): number => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const m = (lo + hi) / 2;
        if (ease(m) * p.len < d) lo = m;
        else hi = m;
      }
      return ((lo + hi) / 2) * T;
    };
    for (let t = (k > 1 ? 5 : 6) * 3600 + r() * 300; t < (k > 1 ? 23 : 21.5) * 3600; t += (180 + r() * 260) / rate) {
      yield;
      serveDrays(t);
      const rr0 = Math.floor(r() * 3);
      const b0 = Math.floor(r() * nC);
      const bay0 = 2 + Math.floor(r() * 20);
      const jj0 = Math.floor(r() * 6);
      // 进闸车道：最西边那条留给去物流中心的车（过了道闸右转向西），去码头箱区的走东边几条（往东左转），两股车不交叉
      const laneIn = GATE_X - 35 + (lanes > 1 ? 1 + Math.floor(r() * (lanes - 1)) : Math.floor(r() * lanes)) * 14;
      const laneOut = GATE_X + 7 + Math.floor(r() * lanes) * 14;
      const booth0 = 45 + r() * 50;
      const uPick = r();
      const tGate = t + 6;
      type Pick = { rr: number; b: number; bay: number; jj: number; booth: number; pIn: Poly; pOut: Poly; arrive: number; pickup: boolean; h: number; boxes: { x0: number; x1: number; t0: number; t1: number }[]; bad: number };
      let pick: Pick | undefined;
      let best: Pick | undefined;
      for (let attempt = 0; attempt < 72 && !pick; attempt++) {
        const [rr, b, bay, jj] = attempt === 0 ? [rr0, b0, bay0, jj0] : [Math.floor(ry() * 3), Math.floor(ry() * nC), 2 + Math.floor(ry() * 20), Math.floor(ry() * 6)];
        const booth = booth0 + Math.floor(attempt / 12) * 75;
        const xb = BAY_X(b, bay);
        const lane = LANE(rr);
        const aisleIn = at(AISLE_X, at(cols, b) + 1) - Math.sign(lane - (DRIVE[2] as number)) * AISLE_KEEP;
        const aisleOut = at(AISLE_X, at(cols, b)) - Math.sign((DRIVE[2] as number) - 4 - lane) * AISLE_KEEP;
        const pIn = new Poly(rounded([{ x: laneIn, z: GATE_Z - 40 }, { x: laneIn, z: GATE_Z + 14 }, { x: laneIn, z: DRIVE[2] as number }, { x: aisleIn, z: DRIVE[2] as number }, { x: aisleIn, z: lane }, { x: xb, z: lane }], 10));
        const pOut = new Poly(rounded([{ x: xb, z: lane }, { x: colX0(b) - 4, z: lane }, { x: aisleOut, z: lane }, { x: aisleOut, z: (DRIVE[2] as number) - 4 }, { x: laneOut, z: (DRIVE[2] as number) - 4 }, { x: laneOut, z: GATE_Z - 40 }], 10));
        const s0 = slotAt(rr, b, bay, jj);
        const arrive = t + booth + drive(pIn);
        const h = height(s0, arrive);
        const pickup = uPick < 0.55 && h > 0;
        if (!pickup && h >= TIERS) {
          if (attempt === 0) break;
          continue;
        }
        const job = pickup ? rtgDo(rtgIndex(rr, b), arrive, xb, ROW_Z(rr, jj), (h - 1) * BOX_H, lane, CHASSIS_TOP, 0, '', true) : rtgDo(rtgIndex(rr, b), arrive, xb, lane, CHASSIS_TOP, ROW_Z(rr, jj), h * BOX_H, 0, '', true);
        const leave = (pickup ? job.drop : job.lift) + 3;
        // 进集卡道（拐进来那一刻起）、停在贝位、开出集卡道（车尾离开拐角为止）各占的 x 范围和时段
        const T1 = drive(pIn) - 6;
        const tLaneIn = tGate + booth + easedAt(pIn, Math.max(0, pIn.len - (aisleIn - xb) - 14), T1);
        const T2 = drive(pOut);
        const tLaneOut = leave + easedAt(pOut, Math.min(pOut.len, xb - aisleOut + 14 + EXT_L), T2);
        const boxes = [
          { x0: xb - 1, x1: aisleIn + EXT_L, t0: tLaneIn - 2, t1: arrive },
          { x0: xb - 1, x1: xb + EXT_L + 1, t0: arrive - 2, t1: leave + 3 },
          { x0: aisleOut - 14, x1: xb + EXT_L + 1, t0: leave, t1: tLaneOut + 2 },
        ];
        // 过了道闸的路口一次过一辆：过路口的时刻和已经排好的集卡隔 9 秒以上（不然多在闸口外等一会儿交单）
        let bad = jbook.busy(junctionSpan(rounded([{ x: laneIn, z: GATE_Z - 4 }, ...pIn.pts.slice(2)], 10), tGate + booth, arrive, 0, EXT_L)) ? 60 : 0;
        for (const o of laneUse.get(rtgIndex(rr, b)) ?? [])
          for (const q of boxes) {
            const dx = Math.min(o.x1, q.x1) - Math.max(o.x0, q.x0);
            const dt = Math.min(o.t1, q.t1) - Math.max(o.t0, q.t0);
            if (dx > 0 && dt > 0) bad += dt;
          }
        const c: Pick = { rr, b, bay, jj, booth, pIn, pOut, arrive, pickup, h, boxes, bad };
        if (!bad) pick = c;
        else if (!best || bad < best.bad) best = c;
      }
      pick ??= best;
      if (!pick) continue;
      const { rr, b, bay, jj, booth, pIn, pOut, arrive, pickup, h } = pick;
      const xb = BAY_X(b, bay);
      const lane = LANE(rr);
      const s = slotAt(rr, b, bay, jj);
      const live = topAt(s, arrive);
      const color = pickup ? (live?.color ?? 0x888888) : pickHex(r);
      const job = pickup ? rtgDo(rtgIndex(rr, b), arrive, xb, ROW_Z(rr, jj), (h - 1) * BOX_H, lane, CHASSIS_TOP, color, '外来集卡提箱') : rtgDo(rtgIndex(rr, b), arrive, xb, lane, CHASSIS_TOP, ROW_Z(rr, jj), h * BOX_H, color, '外来集卡送箱');
      if (pickup && live) live.t1 = job.lift - (18 - (h - 1) * BOX_H - BOX_H - 0.2) / 1.3;
      if (!pickup) s.tiers.push({ color, t0: job.drop - 4, t1: Infinity, tier: h });
      const lu = laneUse.get(rtgIndex(rr, b)) ?? [];
      lu.push(...pick.boxes);
      laneUse.set(rtgIndex(rr, b), lu);
      const handed = pickup ? job.drop : job.lift - (18 - CHASSIS_TOP - BOX_H) / 1.3;
      // 出闸：开到路口的时段和进闸、别的出闸的车错开——在箱位旁多等一会儿再走（不在路上赶），等的这一段集卡道里也记着
      let leaveAt = (pickup ? job.drop : job.lift) + 3;
      {
        const T2 = drive(pOut);
        const xSpan = (W: number) => junctionSpan(pOut.pts, leaveAt + W, leaveAt + W + T2, 0, EXT_L);
        const lu0 = laneUse.get(rtgIndex(rr, b)) ?? [];
        const mine = new Set(pick.boxes);
        const laneOk = (W: number) => lu0.every((o) => mine.has(o) || o.x1 <= xb - 1 || xb + EXT_L + 1 <= o.x0 || o.t1 <= leaveAt || leaveAt + W + 3 <= o.t0);
        // 进闸的这一段先记上（同一辆车的进、出隔得远，不会互相挡）
        jbook.add(junctionSpan(rounded([{ x: laneIn, z: GATE_Z - 4 }, ...pIn.pts.slice(2)], 10), tGate + booth, arrive, 0, EXT_L));
        let W = 0;
        while (W < 240 && (jbook.busy(xSpan(W)) || !laneOk(W))) W += 4;
        if (W >= 240 || !laneOk(W)) W = 0;
        if (W > 0) {
          leaveAt += W;
          const bx = pick.boxes;
          if (bx[1]) bx[1].t1 += W;
          if (bx[2]) {
            bx[2].t0 += W;
            bx[2].t1 += W;
          }
        }
        jbook.add(xSpan(0));
      }
      const legs: Leg[] = [
        { t0: t, t1: tGate + booth, poly: new Poly([{ x: laneIn, z: GATE_Z - 40 }, { x: laneIn, z: GATE_Z - 4 }]), ...(pickup ? {} : { box: color }) },
        { t0: tGate + booth, t1: arrive, poly: new Poly(rounded([{ x: laneIn, z: GATE_Z - 4 }, ...pIn.pts.slice(2)], 10)), ...(pickup ? {} : { box: color }) },
        { t0: arrive, t1: handed, at: pIn.at(pIn.len), ...(pickup ? {} : { box: color }) },
        { t0: handed, t1: leaveAt, at: pIn.at(pIn.len), ...(pickup ? { box: color } : {}) },
        { t0: leaveAt, t1: leaveAt + drive(pOut), poly: pOut, ...(pickup ? { box: color } : {}) },
      ];
      // 道闸：进闸车道在交完单、车头过杆前抬起，挂车过去后放下；出闸车道在车开出来时抬起（出闸的最后一段是直的，道闸在排队点前 36 米）
      const tOut = leaveAt + drive(pOut);
      const passAt = (s: number) => {
        let lo = 0;
        let hi = 1;
        for (let it = 0; it < 30; it++) {
          const mid = (lo + hi) / 2;
          if (ease(mid) * pOut.len < s) lo = mid;
          else hi = mid;
        }
        return leaveAt + ((lo + hi) / 2) * (tOut - leaveAt);
      };
      const inK = Math.floor((laneIn - (GATE_X - 42)) / 14);
      const outK = Math.floor((laneOut - (GATE_X - 42)) / 14);
      gate.push({ t0: t, legs, load: pickup, inAt: tGate + booth, outAt: tOut, inK, outK, box: color, upIn: [tGate + booth - 2.5, tGate + booth + 9], upOut: [passAt(pOut.len - 38) - 1, passAt(Math.min(pOut.len, pOut.len - 36 + 17.5)) + 1] });
    }
    serveDrays(Infinity);
    for (const lst of rtgTasks) lst.sort((a, c2) => a.t0 - c2.t0);
    for (const lst of tractorLegs) lst.sort((a, c2) => a.t0 - c2.t0);
    moves.sort((a, c2) => at(a.tt, 0) - at(c2.tt, 0));
    const byCrane: CraneMove[][] = Array.from({ length: NC }, () => []);
    for (const m of moves) at(byCrane, m.crane).push(m);
    for (const m of moves) if (m.call >= 0) at(calls, m.call).ops.push(m);
    for (const c of calls) {
      c.fin = c.ops.map((m) => at(m.tt, 8)).sort((a, b) => a - b);
      c.moves = c.ops.length;
    }
    // 前大梁放平的时段：每条船一段（作业前 4 分钟开始放、最后一个箱做完 1 分钟后开始仰起）
    const boomWin = byCrane.map((list) => {
      const w: [number, number][] = [];
      let cur: [number, number] | undefined;
      let call = -2;
      for (const m of list) {
        if (!cur || m.call !== call || at(m.tt, 0) - cur[1] > 3600) {
          cur = [at(m.tt, 0) - 240, at(m.tt, 8) + 60];
          w.push(cur);
          call = m.call;
        } else cur[1] = Math.max(cur[1], at(m.tt, 8) + 60);
      }
      return w;
    });
    /**
     * 拖轮沿这一段走，有几个时刻（每 2.5 秒看一次，拖轮最快 5 米 / 秒，不会漏过一条船宽）离哪条船的船体不到 9 米（skip：不算这条船）；
     * 先按时段挑出可能碰到的船，超过 limit 个就不往下数了
     */
    const TQ = pose();
    const tugBlocked = (ph: Phase, skip?: Mover, limit = 0): number => {
      const os = obst.filter((o) => o.t1 >= ph.t0 && o.t0 <= ph.t1 && o.who !== skip);
      if (!os.length) return 0;
      let n = 0;
      for (let t = ph.t0; t <= ph.t1; t += 2.5) {
        evalPhase(ph, t, TQ);
        for (const o of os) {
          if (t < o.t0 || t > o.t1) continue;
          let q: Pose;
          if (o.st) q = o.st;
          else if (o.who && poseAt(o.who, t, PB)) q = PB;
          else continue;
          const dx = TQ.x - q.x;
          const dz = TQ.z - q.z;
          const R = o.len / 2 + 9;
          if (dx * dx + dz * dz > R * R) continue;
          const hh = o.len / 2 - o.beam / 2;
          const cc = Math.cos(q.h) * hh;
          const ss = Math.sin(q.h) * hh;
          if (ptSeg(TQ.x, TQ.z, q.x - cc, q.z - ss, q.x + cc, q.z + ss) < o.beam / 2 + 9) {
            if (++n > limit) return n;
            break;
          }
        }
      }
      return n;
    };
    yield;
    const tugs = this.tugPlan(L, calls, tugBlocked);
    yield;
    const idleList = L.cranes.filter((c) => why.has(c.id)).map((c) => c.id);
    const layout = { other: L.other, own: L.own, gang: GANG, cranes: NC, idle: idleList, berths: L.n };
    const harbour = this.harbour(L, calls, day);
    return { L, moves, byCrane, boomWin, tractorLegs, rtgTasks, slots, deck, gate, boxesInfo, drayLoaded, layout, why, calls, tugs, junctionIv, ...(liner ? { liner } : {}), ...harbour };
  }

  /**
   * 引航艇和带缆工（不改船期，按船的航迹和靠离泊的时刻排）：
   * - 引航艇：本店班轮在引航站停船的那段时间（进港引航员登船、出港下船），别家的船在航道口出现时（锚地等泊位的在起锚前）、
   *   出港快到航道口时，引航艇从基地开过去靠在船的右舷，引航员上下船后开回来；同时有两条船要接送就再派一条；
   * - 带缆工：每次靠泊前三个人从泊位一头的值班亭走到码头前沿船首、船中、船尾的系缆桩旁边等着，缆绳一根根带好后走回去；
   *   离泊前再来，缆绳一根根解开收回后走回去。
   */
  private harbour(L: Layout, calls: Call[], day: PortDay): { pilots: PilotBoat[]; gangs: Gang[] } {
    const jobs: PilotJob[] = [];
    for (const [t0, t1] of day.ship?.pilots ?? []) jobs.push({ t0, t1, len: LINER_LEN, beam: LINER_BEAM });
    for (const c of calls) {
      if (c.berth < 0) continue;
      const C = at(CLASSES, c.cls);
      if (c.anchor && Number.isFinite(c.anchor.t1)) jobs.push({ t0: c.anchor.t1 - 600, t1: c.anchor.t1 - 330, call: c, len: C.len, beam: C.beam });
      else if (Number.isFinite(c.tArr)) jobs.push({ t0: c.tArr, t1: c.tArr + 170, call: c, len: C.len, beam: C.beam });
      if (Number.isFinite(c.tGone) && c.tGone < DAY_END + 3600) jobs.push({ t0: c.tGone - 290, t1: c.tGone - 120, call: c, len: C.len, beam: C.beam });
    }
    jobs.sort((a, b) => a.t0 - b.t0);
    const boats: PilotBoat[] = [];
    const run = (a: { x: number; z: number }, b: { x: number; z: number }) => (Math.hypot(b.x - a.x, b.z - a.z) / PILOT_V) * 1.2 + 20;
    const o = { x: 0, z: 0, h: 0 };
    for (const j of jobs) {
      if (!this.alongside(j, j.t0, o)) continue;
      const meet = { x: o.x, z: o.z };
      if (!this.alongside(j, j.t1, o)) continue;
      const part = { x: o.x, z: o.z };
      let boat: PilotBoat | undefined;
      for (const bt of boats) if (bt.free + 30 <= j.t0 - run(bt.home, meet)) boat = boat ?? bt;
      if (!boat && boats.length < 3) {
        boat = { home: { x: L.x1 - 6.8, z: PILOT_HOME_Z - 24 * boats.length }, segs: [], free: -Infinity, h: Math.PI / 2 };
        boats.push(boat);
      }
      if (!boat) continue;
      const tOut = run(boat.home, meet);
      const tBack = run(part, boat.home);
      boat.segs.push({ t0: j.t0 - tOut, t1: j.t0, a: boat.home, b: meet, h0: boat.h }, { t0: j.t0, t1: j.t1, job: j }, { t0: j.t1, t1: j.t1 + tBack, a: part, b: boat.home, h0: o.h });
      boat.free = j.t1 + tBack;
      boat.h = Math.atan2(boat.home.z - part.z, boat.home.x - part.x);
    }
    // 带缆工：靠泊（缆绳从靠上码头后 90 秒起一根根带上，最后一根约 10 分钟）、离泊（解缆后 60 秒起一根根收回，约 7 分钟）
    const gangs: Gang[] = [];
    const snap = (bx: number) => L.x0 - 10 + Math.round((bx - (L.x0 - 10)) / 22) * 22;
    const event = (x: number, dir: number, len: number, ready: number, done: number) => {
      if (done < 0 || ready > DAY_END) return;
      const berth = L.berths.reduce((m, b) => (Math.abs(b.x - x) < Math.abs(m.x - x) ? b : m), L.berths[0] as (typeof L.berths)[number]);
      const hx = gangHutX(berth.x) + 1.2;
      [0, 2, 5].forEach((mi, k) => {
        const bx = snap(x + dir * at(MOOR, mi).b * len);
        const pts = [
          { x: hx, z: GANG_Z },
          { x: hx + (k - 1) * 0.9, z: EDGE_Z },
          { x: bx + (k - 1) * 0.6, z: EDGE_Z },
          { x: bx + 1.4, z: ZQ - 3.9 },
        ];
        let L2 = 0;
        for (let i = 1; i < pts.length; i++) L2 += Math.hypot((pts[i] as { x: number }).x - (pts[i - 1] as { x: number }).x, (pts[i] as { z: number }).z - (pts[i - 1] as { z: number }).z);
        const W = L2 / WALK_V;
        const r = ready - k * 8;
        gangs.push({ legs: [{ t0: r - W, t1: r, pts }, { t0: r, t1: done + k * 6, pts: [pts[pts.length - 1] as { x: number; z: number }] }, { t0: done + k * 6, t1: done + k * 6 + W, pts: [...pts].reverse() }] });
      });
    };
    for (const c of calls) {
      if (c.berth < 0) continue;
      const C = at(CLASSES, c.cls);
      if (Number.isFinite(c.tAlong) && c.tAlong > 0) event(c.x, c.dir, C.len, c.tAlong - 240, c.tAlong + 90 + 5 * 100 + 120);
      if (Number.isFinite(c.tCast)) event(c.x, c.dir, C.len, c.tCast - 150, c.tCast + 60 + 5 * 70 + 60);
    }
    const ship = day.ship;
    if (ship) {
      event(OWN_X, 1, LINER_LEN, ship.berth[0] - 240, ship.berth[0] + 90 + 5 * 100 + 120);
      event(OWN_X, 1, LINER_LEN, ship.berth[1] - 600 - 150, ship.berth[1] - 600 + 60 + 5 * 70 + 60);
    }
    return { pilots: boats, gangs };
  }

  /** 引航艇靠在船边（右舷、船中稍靠前）的位置和朝向：本店班轮按区域车辆层给的姿态，别家的船按港口的航迹 */
  private alongside(j: PilotJob, t: number, out: { x: number; z: number; h: number }): boolean {
    const S = this.S;
    if (j.call) {
      if (!poseAt(j.call, t, S)) return false;
    } else if (!this.day.ship?.pose?.(t, S)) return false;
    const lx = 0.12 * j.len;
    const lz = j.beam / 2 + 3.6;
    const ch = Math.cos(S.h);
    const sh = Math.sin(S.h);
    out.x = S.x + lx * ch - lz * sh;
    out.z = S.z + lx * sh + lz * ch;
    out.h = S.h;
    return true;
  }

  private readonly pilotAt = { x: 0, z: 0, h: 0 };
  /** 一条引航艇此刻：泊着、开过去、靠在船边、开回来 */
  private drawPilot(pb: PilotBoat, t: number): void {
    const o = this.pilotAt;
    let seg: PilotSeg | undefined;
    let v = 0;
    for (const sg of pb.segs)
      if (t >= sg.t0 && t < sg.t1) {
        seg = sg;
        break;
      }
    if (!seg) {
      // 泊着：船首朝最近一次开回来的方向
      let h = Math.PI / 2;
      for (const sg of pb.segs) if (sg.b === pb.home && sg.t1 <= t && sg.a) h = Math.atan2(pb.home.z - sg.a.z, pb.home.x - sg.a.x);
      o.x = pb.home.x;
      o.z = pb.home.z;
      o.h = h;
    } else if (seg.job) {
      if (!this.alongside(seg.job, t, o)) return;
      v = 2;
    } else if (seg.a && seg.b) {
      const f = ease(prog(t, seg.t0, seg.t1));
      o.x = lerp(seg.a.x, seg.b.x, f);
      o.z = lerp(seg.a.z, seg.b.z, f);
      const hd = Math.atan2(seg.b.z - seg.a.z, seg.b.x - seg.a.x);
      const h0 = seg.h0 ?? hd;
      o.h = h0 + angDiff(h0, hd) * ease(Math.min(1, (t - seg.t0) / 12));
      v = (Math.hypot(seg.b.x - seg.a.x, seg.b.z - seg.a.z) / Math.max(1, seg.t1 - seg.t0)) * 6 * f * (1 - f);
    }
    this.pilotBoats.put(o.x, this.fy, o.z, -o.h, 0, 1, 1, 1, WHITE);
    if (v > 0.8) this.wakes.put(o.x - Math.cos(o.h) * 9, -0.95 + this.fy, o.z - Math.sin(o.h) * 9, -o.h, 0, 10 + 40 * Math.min(1, v / 9), 1, 5, WHITE);
  }

  /** 一个带缆工此刻：沿折线走（匀速）或站着 */
  private drawGang(g: Gang, t: number): void {
    for (const lg of g.legs) {
      if (t < lg.t0 || t >= lg.t1) continue;
      const pts = lg.pts;
      if (pts.length === 1) {
        const p0 = pts[0] as { x: number; z: number };
        this.handlers.put(p0.x, 0.8, p0.z, -Math.PI / 2);
        return;
      }
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += Math.hypot((pts[i] as { x: number }).x - (pts[i - 1] as { x: number }).x, (pts[i] as { z: number }).z - (pts[i - 1] as { z: number }).z);
      let d = total * prog(t, lg.t0, lg.t1);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as { x: number; z: number };
        const b = pts[i] as { x: number; z: number };
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        if (d <= l || i === pts.length - 1) {
          const k = l > 0 ? Math.min(1, d / l) : 1;
          // 走路时身体上下一点点起伏
          this.handlers.put(a.x + (b.x - a.x) * k, 0.8 + Math.abs(Math.sin(t * 5.5)) * 0.05, a.z + (b.z - a.z) * k, -Math.atan2(b.z - a.z, b.x - a.x));
          return;
        }
        d -= l;
      }
      return;
    }
  }

  /**
   * 拖轮：每次靠泊、离泊两条。从码头一头的拖轮基地倒出来、掉头，赶到船边接上（进港时一前一后带缆，掉头时一推一拉，靠泊时在外侧顶推；
   * 离泊时在外侧带缆拖离，掉头后在船的一侧护航一段），完事回基地靠好。拖轮不够用时基地多派一条。
   */
  private tugPlan(L: Layout, calls: Call[], hitsOf: (ph: Phase, skip?: Mover, limit?: number) => number): TugPlan[] {
    // 拖轮基地的泊位：栈桥外侧两排（并靠），不够再用栈桥内侧
    const home = (i: number) => ({ x: L.x1 + (i < 4 ? 6 : i < 8 ? 16.5 : -10), z: ZQ + 16 + 30 * (i % 4) });
    const nOther = L.berths.filter((b) => !b.own).length;
    const fleet: TugPlan[] = Array.from({ length: Math.max(2, 2 * nOther) }, (_, i) => ({ home: home(i), segs: [], free: -Infinity }));
    const S = pose();
    /** 船的本地坐标 → 区域里的位置 */
    const world = (c: Call, t: number, kk: TugKey, o: Pose): Pose => {
      poseAt(c, t, S);
      const ch = Math.cos(S.h);
      const sh = Math.sin(S.h);
      o.x = S.x + kk.lx * ch - kk.lz * sh;
      o.z = S.z + kk.lx * sh + kk.lz * ch;
      o.h = S.h + kk.lh;
      o.v = S.v;
      return o;
    };
    interface Job {
      call: Call;
      t0: number;
      keys: [TugKey[], TugKey[]];
      /** 先到船边上这个位置等着（船的本地坐标，按接上那一刻的船位换到区域里），再靠上去 */
      wait: [{ x: number; z: number }, { x: number; z: number }];
      tRel: number;
    }
    const jobs: Job[] = [];
    for (const c of calls) {
      if (c.berth < 0) continue;
      const C = at(CLASSES, c.cls);
      const Lh = C.len / 2;
      const Bh = C.beam / 2;
      const sg = c.dir;
      /** 掉头时两条拖轮（都在外侧 sg 那边）：船首那条按转向推或拉，船尾那条反过来 */
      const swing = (t: number, dh: number): [TugKey, TugKey] => {
        const sr = Math.sign(dh) || 1;
        const bowPush = sg === -sr;
        const sternPush = sg === sr;
        return [
          { t, lx: 0.36 * C.len, lz: sg * (Bh + (bowPush ? 6.5 : 38)), lh: bowPush ? (-sg * Math.PI) / 2 : (sg * Math.PI) / 2, m: bowPush ? 1 : 2 },
          { t, lx: -0.34 * C.len, lz: sg * (Bh + (sternPush ? 6.5 : 38)), lh: sternPush ? (-sg * Math.PI) / 2 : (sg * Math.PI) / 2, m: sternPush ? 1 : 2 },
        ];
      };
      const push = (t: number): [TugKey, TugKey] => [
        { t, lx: 0.3 * C.len, lz: sg * (Bh + 6.5), lh: (-sg * Math.PI) / 2, m: 1 },
        { t, lx: -0.3 * C.len, lz: sg * (Bh + 6.5), lh: (-sg * Math.PI) / 2, m: 1 },
      ];
      const pull = (t: number): [TugKey, TugKey] => [
        { t, lx: 0.3 * C.len, lz: sg * (Bh + 40), lh: (sg * Math.PI) / 2, m: 2 },
        { t, lx: -0.3 * C.len, lz: sg * (Bh + 40), lh: (sg * Math.PI) / 2, m: 2 },
      ];
      const ph = c.ph;
      // 进港：拖轮在离掉头点 650 米处接上
      if (Number.isFinite(c.tMeet) && Number.isFinite(c.tSwing)) {
        const sw = ph.find((p) => p.k === 'lerp' && p.t0 === c.tSwing) as Extract<Phase, { k: 'lerp' }> | undefined;
        const dh = sw ? sw.h1 - sw.h0 : 0;
        const A: TugKey[] = [];
        const B: TugKey[] = [];
        const add = (pair: [TugKey, TugKey]) => {
          A.push(pair[0]);
          B.push(pair[1]);
        };
        const tm = c.tMeet;
        // 两条拖轮都从靠拖轮基地的那一侧过来（不用横穿船的航迹）
        poseAt(c, tm, S);
        const hb0 = home(0);
        const near = (hb0.x - S.x) * -Math.sin(S.h) + (hb0.z - S.z) * Math.cos(S.h) >= 0 ? 1 : -1;
        add([
          { t: tm, lx: Lh + 34, lz: near * 10, lh: 0, m: 3 },
          { t: tm, lx: -Lh - 28, lz: near * 8, lh: 0, m: 4 },
        ]);
        add([
          { t: Math.min(c.tSwing - 160, tm + 60), lx: Lh + 34, lz: 0, lh: 0, m: 3 },
          { t: Math.min(c.tSwing - 160, tm + 60), lx: -Lh - 28, lz: 0, lh: 0, m: 4 },
        ]);
        add([
          { t: c.tSwing - 150, lx: Lh + 34, lz: 0, lh: 0, m: 3 },
          { t: c.tSwing - 150, lx: -Lh - 28, lz: 0, lh: 0, m: 4 },
        ]);
        add([
          { t: c.tSwing - 70, lx: Lh + 18, lz: sg * (Bh + 26), lh: (sg * Math.PI) / 4, m: 5 },
          { t: c.tSwing - 70, lx: -Lh - 16, lz: sg * (Bh + 22), lh: (sg * Math.PI) / 4, m: 5 },
        ]);
        add(swing(c.tSwing, dh));
        add(swing(c.tPush - 45, dh));
        add(push(c.tPush + 20));
        add(push(c.tFast - 240));
        add([
          { t: c.tFast - 150, lx: 0.3 * C.len, lz: sg * (Bh + 32), lh: (sg * Math.PI) / 2, m: 5 },
          { t: c.tFast - 150, lx: -0.3 * C.len, lz: sg * (Bh + 32), lh: (sg * Math.PI) / 2, m: 5 },
        ]);
        jobs.push({ call: c, t0: tm, keys: [A, B], wait: [{ x: Lh + 20, z: near * 100 }, { x: -Lh - 40, z: near * 95 }], tRel: c.tFast - 150 });
      }
      // 离泊：解缆前 6 分钟赶到外侧，带缆拖离；掉头后在船的一侧护航 420 米
      if (Number.isFinite(c.tCast) && c.tGone < Infinity) {
        const sw = ph.find((p) => p.k === 'lerp' && p.t0 === c.tSwingOut) as Extract<Phase, { k: 'lerp' }> | undefined;
        const dh = sw ? sw.h1 - sw.h0 : 0;
        const out = ph[ph.length - 1];
        const tRel = out && out.k === 'path' ? timeAtS(out, Math.min(out.s1, 420)) : c.tOut + 300;
        // 护航那一侧：出港航道的外侧（另一侧是进港的船走的）
        poseAt(c, c.tOut + 60, S);
        const side = -DN.x * -Math.sin(S.h) + -DN.z * Math.cos(S.h) >= 0 ? 1 : -1;
        const A: TugKey[] = [];
        const B: TugKey[] = [];
        const add = (pair: [TugKey, TugKey]) => {
          A.push(pair[0]);
          B.push(pair[1]);
        };
        const t0 = c.tCast - 360;
        add([
          { t: t0, lx: 0.3 * C.len, lz: sg * (Bh + 40), lh: (-sg * Math.PI) / 2, m: 5 },
          { t: t0, lx: -0.3 * C.len, lz: sg * (Bh + 40), lh: (-sg * Math.PI) / 2, m: 5 },
        ]);
        add(pull(t0 + 90));
        add(pull(c.tSwingOut - 30));
        add(swing(c.tSwingOut + 30, dh));
        add(swing(c.tOut - 20, dh));
        if (side !== sg) {
          add([
            { t: c.tOut + 50, lx: Lh + 26, lz: 0, lh: 0, m: 5 },
            { t: c.tOut + 50, lx: -Lh - 26, lz: 0, lh: 0, m: 5 },
          ]);
        }
        add([
          { t: c.tOut + 140, lx: Lh - 14, lz: side * (Bh + 26), lh: 0, m: 5 },
          { t: c.tOut + 140, lx: -Lh + 16, lz: side * (Bh + 24), lh: 0, m: 5 },
        ]);
        add([
          { t: Math.max(tRel, c.tOut + 200), lx: Lh - 14, lz: side * (Bh + 40), lh: side * 0.35, m: 5 },
          { t: Math.max(tRel, c.tOut + 200), lx: -Lh + 16, lz: side * (Bh + 38), lh: side * 0.35, m: 5 },
        ]);
        jobs.push({ call: c, t0, keys: [A, B], wait: [{ x: 0.3 * C.len, z: sg * (Bh + 120) }, { x: -0.3 * C.len, z: sg * (Bh + 120) }], tRel: Math.max(tRel, c.tOut + 200) });
      }
    }
    jobs.sort((a, b) => a.t0 - b.t0);
    const P0 = pose();
    for (const j of jobs) {
      for (let role = 0; role < 2; role++) {
        const keys = at(j.keys, role);
        const wl = at(j.wait, role);
        poseAt(j.call, j.t0, S);
        // 挑最早空出来的拖轮（赶路的时间按基地中间估，留出错开别的船的余量）
        const est = Math.hypot(S.x - (L.x1 + 6), S.z - (ZQ + 70)) / 3.6 + 2400;
        let tg = fleet.find((f) => f.free < j.t0 - est);
        if (!tg) {
          if (fleet.length < 12) {
            tg = { home: home(fleet.length), segs: [], free: -Infinity };
            fleet.push(tg);
          } else tg = fleet.reduce((a, f) => (f.free < a.free ? f : a), at(fleet, 0));
        }
        const hm = tg.home;
        const P1 = { x: hm.x, z: hm.z + 45 };
        /**
         * 赶去接船：倒出泊位、掉头，赶到船边上（靠拖轮基地那一侧、离船 100 米左右）和船并排、同速，
         * 再相对船慢慢靠到接船的位置（在船的坐标里走，船怎么动都不会撞上）。
         * 几种走法（离船远一点、中途往两边绕开锚泊的船）× 几种赶路的速度（出发早晚不同），挑第一个一路都碰不到船的。
         */
        const Tf = 75;
        const tAtt = j.t0 - Tf;
        const SA = pose();
        poseAt(j.call, tAtt, SA);
        const ca = Math.cos(SA.h);
        const sa = Math.sin(SA.h);
        let best: { go: Phase; tr: Track; wl: { x: number; z: number } } | undefined;
        let first: typeof best;
        let firstHits = Infinity;
        search: for (const far of [1, 1.6])
          for (const bend of [0, 260, 520])
            for (const vAvg of [3.6, 2.8, 2.2, 1.7]) {
              const wlx = wl.x;
              const wlz = wl.z * far;
              const Pa = { x: SA.x + wlx * ca - wlz * sa, z: SA.z + wlx * sa + wlz * ca };
              // 最后一段和船平行（船在走的话）或者从外侧正对着船靠过来（船停着）
              const out = Math.hypot(wlz, 1) > 0 ? Math.sign(wlz) : 1;
              const pre = SA.v > 0.2 ? { x: Pa.x - ca * 70, z: Pa.z - sa * 70 } : { x: Pa.x - sa * out * 60, z: Pa.z + ca * out * 60 };
              const mx = (P1.x + pre.x) / 2;
              const mz = (P1.z + pre.z) / 2;
              const dl = Math.hypot(pre.x - P1.x, pre.z - P1.z) || 1;
              // 绕行点只往海那一侧（+z）偏，不会绕到码头上
              let nx = -(pre.z - P1.z) / dl;
              let nz = (pre.x - P1.x) / dl;
              if (nz < 0) {
                nx = -nx;
                nz = -nz;
              }
              const pts = bend ? [P1, { x: mx + nx * bend, z: mz + nz * bend }, pre, Pa] : [P1, pre, Pa];
              const tr = new Track(pts, 45);
              const T = tr.len / vAvg;
              const go: Phase = { k: 'path', t0: tAtt - T, t1: tAtt, tr, s0: 0, s1: tr.len, prof: 'herm', m0: 0, m1: Math.min(1.6, (SA.v * T) / Math.max(1, tr.len)) };
              const cand = { go, tr, wl: { x: wlx, z: wlz } };
              const n = hitsOf(go, undefined, firstHits);
              if (!n) {
                best = cand;
                break search;
              }
              if (n < firstHits) {
                first = cand;
                firstHits = n;
              }
            }
        const pl = (best ?? first) as NonNullable<typeof best>;
        const tGo = pl.go.t0;
        const hGo = -Math.PI / 2 + angDiff(-Math.PI / 2, pl.tr.headAt(0));
        // 并排以后：先在等候的位置跟着船（朝向按赶来的方向），再靠到接船的位置、转到预定的朝向
        keys.unshift({ t: tAtt, lx: pl.wl.x, lz: pl.wl.z, lh: angDiff(SA.h, pl.tr.headAt(pl.tr.len)), m: 5 });
        tg.segs.push({ t0: tGo - 50, t1: tGo, ph: { k: 'lerp', t0: tGo - 50, t1: tGo, x0: hm.x, z0: hm.z, x1: P1.x, z1: P1.z, h0: -Math.PI / 2, h1: hGo } });
        tg.segs.push({ t0: tGo, t1: tAtt, ph: pl.go });
        tg.segs.push({ t0: tAtt, t1: j.tRel, att: { call: j.call, keys } });
        // 回基地：从放开的位置往前一点，转回码头一头，船首朝码头靠进泊位。路上会碰到船就先停一会再走；
        // 原地停着也挡路时，先往外让开一段（离开刚送走的船、离开航道）再等
        const last = at(keys, keys.length - 1);
        world(j.call, j.tRel, last, P0);
        const backFrom = (x: number, z: number, h: number, t0: number, v: number, via?: { x: number; z: number }[]): Phase => {
          const fwd = { x: x + Math.cos(h) * 40, z: z + Math.sin(h) * 40 };
          const tr = new Track([{ x, z }, ...(via ?? [fwd]), { x: hm.x, z: hm.z + 90 }, { x: hm.x, z: hm.z }], 40);
          const Tb = tr.len / 3.4;
          return { k: 'path', t0, t1: t0 + Tb, tr, s0: 0, s1: tr.len, prof: 'herm', m0: Math.min(1.6, (v * Tb) / Math.max(1, tr.len)), m1: 0 };
        };
        // 几种回去的走法，挑第一个一路都碰不到船的（都不行就挑碰得最少的）：
        // 直接回；原地停一会再回；先往外让开、从刚送走的那条船后面绕过去；往外让开 150 米再等
        const hs = P0.h - last.lh;
        const sgn = Math.sign(last.lz) || 1;
        const ux = -Math.sin(hs) * sgn;
        const uz = Math.cos(hs) * sgn;
        const cands: (() => { segs: TugSeg[]; back: Phase })[] = [() => ({ segs: [], back: backFrom(P0.x, P0.z, P0.h, j.tRel, P0.v) })];
        for (let k = 1; k <= 16; k++) {
          const hold: Phase = { k: 'hold', t0: j.tRel, t1: j.tRel + k * 90, x: P0.x, z: P0.z, h: P0.h };
          cands.push(() => ({ segs: [{ t0: hold.t0, t1: hold.t1, ph: hold }], back: backFrom(P0.x, P0.z, P0.h, hold.t1, 0) }));
        }
        cands.push(() => {
          const sx = Math.cos(hs);
          const sz = Math.sin(hs);
          const a1 = { x: P0.x + ux * 45 + Math.cos(P0.h) * 20, z: P0.z + uz * 45 + Math.sin(P0.h) * 20 };
          const a2 = { x: P0.x + ux * 55 - sx * 260, z: P0.z + uz * 55 - sz * 260 };
          return { segs: [], back: backFrom(P0.x, P0.z, P0.h, j.tRel, P0.v, [a1, a2]) };
        });
        {
          const ox = P0.x + ux * 150;
          const oz = P0.z + uz * 150;
          const outTr = new Track([{ x: P0.x, z: P0.z }, { x: P0.x + Math.cos(P0.h) * 50, z: P0.z + Math.sin(P0.h) * 50 }, { x: ox, z: oz }], 40);
          const To = outTr.len / 3;
          const outPh: Phase = { k: 'path', t0: j.tRel, t1: j.tRel + To, tr: outTr, s0: 0, s1: outTr.len, prof: 'herm', m0: Math.min(1.6, (P0.v * To) / Math.max(1, outTr.len)), m1: 0 };
          const ho = outTr.headAt(outTr.len);
          for (let k = 0; k <= 16; k++) {
            const hold: Phase = { k: 'hold', t0: outPh.t1, t1: outPh.t1 + k * 90, x: ox, z: oz, h: ho };
            cands.push(() => ({ segs: [{ t0: outPh.t0, t1: outPh.t1, ph: outPh }, ...(k ? [{ t0: hold.t0, t1: hold.t1, ph: hold }] : [])], back: backFrom(ox, oz, ho, hold.t1, 0) }));
          }
        }
        let pick: { segs: TugSeg[]; back: Phase } | undefined;
        let pickN = Infinity;
        for (const mk of cands) {
          const cd = mk();
          let n = 0;
          for (const sg of cd.segs) if (sg.ph) n += hitsOf(sg.ph, undefined, pickN);
          if (n < pickN) n += hitsOf(cd.back, undefined, pickN - n);
          if (n < pickN) {
            pick = cd;
            pickN = n;
          }
          if (!n) break;
        }
        const chosen = pick as { segs: TugSeg[]; back: Phase };
        const segs = chosen.segs;
        const back = chosen.back;
        tg.segs.push(...segs, { t0: back.t0, t1: back.t1, ph: back });
        tg.free = back.t1;
      }
    }
    for (const f of fleet) f.segs.sort((a, b) => a.t0 - b.t0);
    return fleet;
  }

  /** 设施管理台的指标：本店班轮能不能在靠泊窗口里做完、别家的船的船期、岸桥效率、集卡和闸口 */
  kpi(): { label: string; value: string; bad?: boolean }[] {
    const plan = this.plan;
    if (!plan) return [];
    const ship = this.day.ship;
    const L = plan.layout;
    const own = plan.moves.filter((m) => m.own);
    const out: { label: string; value: string; bad?: boolean }[] = [];
    const clk = (t: number) => clockOf(((t % 86400) + 86400) % 86400);
    const ownB = plan.L.berths.find((b) => b.own) as Berth;
    if (ship && own.length) {
      const end = Math.max(...own.map((m) => at(m.tt, 8)));
      const first = Math.min(...own.map((m) => at(m.tt, 0)));
      const spare = (ship.berth[1] - 25 * 60 - end) / 3600;
      const working = ownB.cranes.filter((c) => !plan.why.has(at(plan.L.cranes, c).id)).length;
      out.push({ label: '本店班轮作业量', value: `${own.length} 箱（卸 ${own.filter((m) => m.kind === 'dis').length}、装 ${own.filter((m) => m.kind === 'load').length}）` });
      out.push({ label: '本店班轮完工 / 靠泊窗口', value: `${clk(end)} / ${clk(ship.berth[1])}（${spare >= 0 ? `富余 ${spare.toFixed(1)} 小时` : `超出 ${(-spare).toFixed(1)} 小时`}）`, bad: spare < 0.5 });
      out.push({ label: '岸桥效率（本店班轮）', value: `${(own.length / Math.max(1, working) / Math.max(0.1, (end - first) / 3600)).toFixed(1)} 箱 / 台时，${working} 台在作业` });
    }
    // 别家的船：今天靠泊、离泊的船，作业量，泊位利用率，锚地等泊位
    const calls = plan.calls;
    const today = calls.filter((c) => c.berth >= 0 && c.tAlong < DAY_END && c.tOff > 0);
    const movesToday = plan.moves.filter((m) => !m.own && at(m.tt, 8) >= 0 && at(m.tt, 8) < DAY_END).length;
    const nOther = plan.L.berths.filter((b) => !b.own).length;
    const occ = today.reduce((a, c) => a + Math.max(0, Math.min(DAY_END, c.tOff) - Math.max(0, c.tAlong)), 0);
    const arrived = calls.filter((c) => c.berth >= 0 && c.tFast >= 0 && c.tFast < DAY_END).length;
    const left = calls.filter((c) => c.berth >= 0 && c.tCast >= 0 && c.tCast < DAY_END).length;
    out.push({ label: '别家的船（今天）', value: `${today.length} 艘在泊位上作业过（靠泊 ${arrived}、离泊 ${left}），岸桥 ${movesToday} 箱` });
    out.push({ label: '泊位利用率（别家的船）', value: `${nOther} 个泊位，${Math.round((occ / Math.max(1, nOther * DAY_END)) * 100)}%` });
    const waited = calls.filter((c) => c.anchor && (c.anchor.t1 > 0 || !Number.isFinite(c.anchor.t1)) && c.anchor.t0 < DAY_END);
    if (waited.length) {
      const hrs = waited.map((c) => (Math.min(DAY_END, (c.anchor as { t1: number }).t1) - Math.max(0, (c.anchor as { t0: number }).t0)) / 3600);
      const avg = hrs.reduce((a, b) => a + b, 0) / hrs.length;
      const still = waited.filter((c) => !Number.isFinite((c.anchor as { t1: number }).t1)).length;
      out.push({ label: '锚地等泊位', value: `${waited.length} 艘，平均等 ${avg.toFixed(1)} 小时${still ? `，${still} 艘到半夜还没排上` : ''}`, bad: avg > 6 });
    } else out.push({ label: '锚地等泊位', value: '没有船等泊位' });
    out.push({ label: '岸桥（别家的船 / 本店班轮）', value: `${nOther} 个泊位 × ${L.other} 台 / ${L.own} 台${L.idle.length ? `，停用 ${L.idle.join('、')}` : ''}`, bad: L.idle.length > 0 });
    out.push({ label: '场内集卡', value: `${L.cranes * L.gang} 辆（每台岸桥 ${L.gang} 辆）` });
    const turns = plan.gate.map((g) => (g.outAt - g.inAt) / 60);
    out.push({ label: '外来集卡（闸口）', value: `${plan.gate.length} 车次，场内平均 ${(turns.reduce((a, b) => a + b, 0) / Math.max(1, turns.length)).toFixed(0)} 分钟` });
    return out;
  }

  /** 集装箱拖车此刻车架上有没有箱：龙门吊放上去之前是空车架（不归港口管的车返回 undefined） */
  dray(vid: number, t: number): number | undefined {
    const atT = this.plan?.drayLoaded.get(vid);
    return atT === undefined ? undefined : t < atT ? 0 : 1;
  }

  /** 今天的外来集卡在港口里的每一趟（局部坐标，按到排队点的先后） */
  gateTrips(): GateTrip[] {
    return drain(this.gateTripsSteps());
  }
  /** 和 gateTrips 一样，分成小段算（物流中心的车让行要半秒多） */
  *gateTripsSteps(): Steps<GateTrip[]> {
    const gate = this.plan?.gate ?? [];
    const base: GateTrip[] = gate.map((g) => ({
      t0: g.t0,
      t1: g.outAt,
      load: g.load,
      box: g.box,
      inK: g.inK,
      outK: g.outK,
      inAt: g.inAt,
      legs: g.legs.map((l) => ({ t0: l.t0, t1: l.t1, ...(l.poly ? { pts: l.poly.pts } : {}), ...(l.at ? { at: l.at } : {}), ...(l.box !== undefined ? { box: l.box } : {}) })),
    }));
    // 物流中心的车也走这个闸口：挑一条这一刻前后没有别的车在交单的车道，过杆的时段记下来（道闸跟着抬）
    const lanes = Math.max(1, Math.min(3, Math.round(currentFacilities().port.gateLanes || 3)));
    const laneIn = Array.from({ length: lanes }, (_, k) => GATE_X - 35 + k * 14);
    const laneOut = Array.from({ length: lanes }, (_, k) => GATE_X + 7 + k * 14);
    const busy = (k: number, t: number) => gate.some((g) => (g.inK === k && Math.abs(g.inAt - t) < 70) || (g.outK === k && Math.abs(g.outAt - t) < 40));
    const extra = yield* this.logi.tripsSteps({ laneIn, laneOut, z: GATE_Z, busy, junction: gate.map((g) => g.inAt + 4), junctionIv: this.plan?.junctionIv ?? [] });
    this.logiGates = extra.map((x) => ({ inK: x.inK, outK: x.outK, upIn: [x.inAt - 2.5, x.inAt + 9] as [number, number], upOut: [x.t1 - 11, x.t1 - 3] as [number, number] }));
    return [...base, ...extra].sort((p, q) => p.t0 - q.t0);
  }

  /**
   * 更新到时刻 t。shipPose：本店班轮此刻的位置（区域车辆层给的，港口局部坐标），甲板上的箱跟着它画。
   */
  update(t: number, shipPose: { x: number; y: number; dir: number } | undefined, cam?: { x: number; y: number; z: number }): void {
    this.logi.update(t, cam);
    this.ttLamps.begin(t);
    this.ttSt.night = isNight(t);
    const plan = this.plan;
    // 潮汐：船、拖轮浮在水面上跟着涨落（tide.ts）；岸桥抓放船上的箱时跟着船的高度
    const fy = floatY(t);
    this.fy = fy;
    for (const p of this.all) p.begin();
    if (!plan) {
      for (const p of this.all) p.end();
      return;
    }
    const L = plan.L;
    // —— 岸桥 ——
    for (let c = 0; c < L.cranes.length; c++) {
      const list = at(plan.byCrane, c);
      // 当前（或刚结束的）那一个箱
      let lo = 0;
      let hi = list.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (at(at(list, mid).tt, 0) <= t) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const cur = idx >= 0 ? list[idx] : undefined;
      const nxt = list[idx + 1];
      const working = !!cur && (!!nxt || t < at(cur.tt, 8) + 600);
      let x = cur ? cur.x : nxt ? nxt.x : at(L.cranes, c).rest;
      // 两个箱之间沿轨道走到下一个贝位（大车 0.75 米 / 秒，到点前才走）
      if (cur && nxt && t > at(cur.tt, 8)) {
        const travel = Math.abs(nxt.x - cur.x) / 0.75;
        x = lerp(cur.x, nxt.x, ease(prog(t, at(nxt.tt, 0) - travel, at(nxt.tt, 0))));
      }
      // 前大梁：作业时放平，不作业时仰起（俯仰要 3 分钟）
      let boomUp = 1;
      for (const [w0, w1] of at(plan.boomWin, c)) {
        const u = t < w0 ? 1 : t < w0 + 180 ? 1 - ease((t - w0) / 180) : t < w1 ? 0 : t < w1 + 180 ? ease((t - w1) / 180) : 1;
        if (u < boomUp) boomUp = u;
      }
      const ang = -boomUp * (78 * Math.PI) / 180;
      this.frames.put(x, 0, ZC, 0, 0, 1, 1, 1, WHITE);
      this.booms.put(x, 46.6, ZC + 16, 0, 0, 1, 1, 1, WHITE, ang);
      // 拉杆：A 字架顶 → 前大梁上两个点
      for (const along of TIE_ALONG)
        for (const sx of TIE_X) {
          this.va.set(x + sx, 76, ZC + 9);
          this.vb.set(x + sx * 1.1, 46.6 + Math.sin(-ang) * along, ZC + 16 + Math.cos(-ang) * along);
          this.ropes.rod(this.va, this.vb, 0.22, 0xc8402f);
        }
      // 小车和吊具
      let tz = ZC - 4;
      let sy = UP_Y;
      let carry: number | undefined;
      if (cur && working && boomUp < 0.01) {
        const tt = cur.tt;
        let k = -1;
        for (let i = 1; i < tt.length; i++)
          if (t < at(tt, i)) {
            k = i;
            break;
          }
        const seg = k < 0 ? 8 : k - 1;
        const f = k < 0 ? 1 : prog(t, at(tt, seg), at(tt, seg + 1));
        const top = cur.shipY + BOX_H + fy;
        const lowTruck = CHASSIS_TOP + 0.2 + BOX_H;
        const e = ease(f);
        // 每一段的起点、终点（第 8 段之后停在陆侧上方）：卸船先到船上方放下、吊起、回陆侧放到拖车；装船反过来
        const dis = cur.kind === 'dis';
        const a = dis ? top : lowTruck;
        const b = dis ? lowTruck : top;
        if (dis) tz = lerp(seg === 0 || seg >= 5 ? ZC : cur.zr, seg < 4 ? cur.zr : ZC, e);
        else tz = lerp(seg < 5 || seg === 8 ? ZC : cur.zr, seg < 4 || seg >= 7 ? ZC : cur.zr, e);
        sy = lerp(trolleyY(seg, a, b), trolleyY(seg + 1, a, b), e);
        carry = seg >= 3 && seg < 7 ? cur.color : undefined;
      }
      this.trolleys.put(x, 46.6, tz, 0, 0, 1, 1, 1, WHITE);
      this.spreaders.put(x, sy, tz, 0, 0, 1, 1, 1, WHITE);
      for (const [ox, oz] of ROPE_OFF) {
        this.va.set(x + ox * 0.6, 46.3, tz + oz);
        this.vb.set(x + ox * 0.25, sy + 1.9, tz + oz * 0.5);
        this.ropes.rod(this.va, this.vb, 0.07, ROPE_HEX);
      }
      if (carry !== undefined) this.boxes.put(x, sy - BOX_H - 0.02, tz, 0, 0, 1, 1, 1, carry);
    }
    // —— 本店班轮：甲板上的箱（跟着船走）、靠泊时的缆绳、航行时的尾迹 ——
    if (shipPose) {
      const c = Math.cos(shipPose.dir);
      const s = Math.sin(shipPose.dir);
      for (let bi = 0; bi < plan.deck.length; bi++) {
        const bay = at(plan.deck, bi);
        const lx = at(SHIP_BAYS, bi);
        for (let ri = 0; ri < bay.length; ri++) {
          const lz = SHIP_ROW_Z(ri);
          for (const tr of at(bay, ri).tiers) {
            if (!(tr.t0 <= t && t < tr.t1)) continue;
            this.boxes.put(shipPose.x + lx * c - lz * s, DECK_Y + tr.tier * BOX_H + fy, shipPose.y + lx * s + lz * c, -shipPose.dir, 0, 1, 1, 1, tr.color);
          }
        }
      }
      const ship = this.day.ship;
      if (ship && t >= ship.berth[0] && t < ship.berth[1]) this.mooringLines(OWN_X, OWN_Z, 1, LINER_LEN, LINER_BEAM, t, ship.berth[0], ship.berth[1] - 600, L.x0);
      if (plan.liner && poseAt(plan.liner, t, this.P) && this.P.v > 0.15) this.wake(shipPose.x, shipPose.y, shipPose.dir, LINER_LEN, LINER_BEAM, this.P.v);
    }
    // —— 别家的船：船体、甲板上的箱、尾迹和船首浪、缆绳 ——
    for (const own of this.hullOwner.values()) own.length = 0;
    for (let ci = 0; ci < plan.calls.length; ci++) {
      const cl = at(plan.calls, ci);
      const ph = poseAt(cl, t, this.P);
      if (!ph) continue;
      const C = at(CLASSES, cl.cls);
      const P = this.P;
      const hull = at(at(this.hulls, cl.cls), cl.liv);
      let own = this.hullOwner.get(hull.mesh);
      if (!own) this.hullOwner.set(hull.mesh, (own = []));
      if (own.length < hull.capacity) own.push(ci);
      hull.put(P.x, fy, P.z, -P.h, 0, 1, 1, 1, WHITE);
      const ch = Math.cos(P.h);
      const sh = Math.sin(P.h);
      for (let bi = 0; bi < C.bays.length; bi++) {
        const lx = at(C.bays, bi).x;
        const bay = at(cl.deck, bi);
        for (let ri = 0; ri < bay.length; ri++) {
          const lz = rowZ(C, ri);
          for (const tr of at(bay, ri).tiers) {
            if (!(tr.t0 <= t && t < tr.t1)) continue;
            this.stacks.put(P.x + lx * ch - lz * sh, HATCH_Y + tr.tier * BOX_H + fy, P.z + lx * sh + lz * ch, -P.h, 0, 1, 1, 1, tr.color);
          }
        }
      }
      if (P.v > 0.15) this.wake(P.x, P.z, P.h, C.len, C.beam, P.v);
      if (cl.berth >= 0 && t >= cl.tAlong && t < cl.tOff) this.mooringLines(cl.x, cl.zM, cl.dir, C.len, C.beam, t, cl.tAlong, cl.tCast, L.x0);
    }
    // —— 拖轮 ——
    for (const tp of plan.tugs) this.drawTug(tp, t);
    // —— 引航艇、带缆工 ——
    for (const pb of plan.pilots) this.drawPilot(pb, t);
    for (const g of plan.gangs) this.drawGang(g, t);
    // —— 堆场 ——
    for (let rr = 0; rr < 3; rr++)
      for (let b = 0; b < L.cols.length; b++) {
        const x0 = at(COL_X0, at(L.cols, b)) + 6.45;
        const blk = at(at(plan.slots, rr), b);
        for (let k = 0; k < BAYS; k++) {
          const bay = at(blk, k);
          for (let j = 0; j < 6; j++) {
            const st = at(bay, j);
            let h = 0;
            for (const tr of st.tiers) {
              if (!(tr.t0 <= t && t < tr.t1)) continue;
              this.stacks.put(x0 + k * 12.9, 0.2 + h * BOX_H, ROW_Z(rr, j), 0, 0, 1, 1, 1, tr.color);
              h++;
            }
          }
        }
      }
    // —— 龙门吊 ——
    const nC = L.cols.length;
    for (let k = 0; k < plan.rtgTasks.length; k++) {
      const rr = Math.floor(k / nC);
      const b = k % nC;
      const list = at(plan.rtgTasks, k);
      let idx = -1;
      let lo = 0;
      let hi = list.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (at(list, mid).t0 <= t) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const cur = idx >= 0 ? list[idx] : undefined;
      const prev = idx > 0 ? list[idx - 1] : undefined;
      const zc = ((ROWS[rr] as { n: number }).n + (ROWS[rr] as { s: number }).s) / 2;
      let x = at(COL_X0, at(L.cols, b)) + 6.45 + 12 * 12.9;
      let tz = zc;
      let sy = 18;
      let carry: number | undefined;
      if (cur) {
        const tt = cur.tt;
        const fromX = prev ? prev.x : cur.x;
        if (t < at(tt, 1)) x = lerp(fromX, cur.x, ease(prog(t, at(tt, 0), at(tt, 1))));
        else x = cur.x;
        if (t >= at(tt, 1) && t < at(tt, 9)) {
          let k2 = -1;
          for (let i = 2; i < tt.length; i++)
            if (t < at(tt, i)) {
              k2 = i;
              break;
            }
          const seg = k2 < 0 ? 8 : k2 - 1;
          const f = ease(prog(t, at(tt, seg), at(tt, seg + 1)));
          const lowFrom = cur.yFrom + BOX_H + 0.2;
          const lowTo = cur.yTo + BOX_H + 0.2;
          const zA = seg <= 1 ? cur.zStart : seg <= 5 ? cur.zFrom : cur.zTo;
          const zB = seg === 0 ? cur.zStart : seg <= 4 ? cur.zFrom : cur.zTo;
          tz = lerp(zA, zB, f);
          const Y0 = seg <= 2 ? 18 : seg <= 4 ? lowFrom : seg <= 6 ? 18 : seg <= 8 ? lowTo : 18;
          const Y1 = seg <= 1 ? 18 : seg <= 3 ? lowFrom : seg <= 5 ? 18 : seg <= 7 ? lowTo : 18;
          sy = lerp(Y0, Y1, f);
          carry = seg >= 4 && seg < 8 ? cur.color : undefined;
        } else if (t >= at(tt, 9)) tz = cur.zTo;
        else tz = cur.zStart;
      }
      this.rtgs.put(x, 0.2, zc, 0, 0, 1, 1, 1, WHITE);
      this.rtgTrolleys.put(x, 22.4, tz, 0, 0, 1, 1, 1, WHITE);
      this.spreaders.put(x, sy, tz, 0, 0, 1, 1, 1, WHITE);
      for (const ox of RTG_ROPE_X) {
        this.va.set(x + ox, 22.2, tz);
        this.vb.set(x + ox * 0.3, sy + 1.9, tz);
        this.ropes.rod(this.va, this.vb, 0.06, ROPE_HEX);
      }
      if (carry !== undefined) this.boxes.put(x, sy - BOX_H - 0.02, tz, 0, 0, 1, 1, 1, carry);
    }
    // —— 场内集卡（每辆车的路段按时刻排好，二分查找当前那一段） ——
    const atT = this.at;
    for (const legs of plan.tractorLegs) {
      let lo = 0;
      let hi = legs.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (at(legs, mid).t0 <= t) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      // 路段偶尔有重叠：往前多看两段
      let leg: Leg | undefined;
      for (let i = idx; i >= 0 && i >= idx - 2; i--) {
        const l = at(legs, i);
        if (t >= l.t0 && t < l.t1) {
          leg = l;
          break;
        }
      }
      if (!leg) continue;
      if (leg.poly) leg.poly.at(leg.poly.len * drivePos(prog(t, leg.t0, leg.t1), leg.t1 - leg.t0), atT);
      else if (leg.at) {
        atT.x = leg.at.x;
        atT.z = leg.at.z;
        atT.yaw = leg.at.yaw;
      }
      this.drawTractor(atT, leg.box);
    }
    // —— 闸口的道闸（外来集卡由区域车辆层的外来车画整趟：从高速口或等候区开来、进闸、到箱区、出闸、开走，见 extTrucks.ts） ——
    const raised = this.raised;
    raised.fill(false);
    for (const g of plan.gate) {
      if (t < g.upIn[0] - 1 || t > g.upOut[1] + 1) continue;
      if (t >= g.upIn[0] && t <= g.upIn[1] && g.inK >= 0 && g.inK < raised.length) raised[g.inK] = true;
      if (t >= g.upOut[0] && t <= g.upOut[1] && g.outK >= 0 && g.outK < raised.length) raised[g.outK] = true;
    }
    for (const g of this.logiGates) {
      if (t >= g.upIn[0] && t <= g.upIn[1] && g.inK >= 0 && g.inK < raised.length) raised[g.inK] = true;
      if (t >= g.upOut[0] && t <= g.upOut[1] && g.outK >= 0 && g.outK < raised.length) raised[g.outK] = true;
    }
    for (let k = 0; k < 6; k++) this.barriers.put(GATE_X - 42 + k * 14 + 1.5, 1.1, GATE_Z - 4, 0, raised[k] ? Math.PI / 2.3 : 0, 1, 1, 1, WHITE);
    for (const p of this.all) p.end();
    this.ttLamps.end();
  }

  /** 尾迹（船尾往后拖、长度随航速）和船首浪 */
  private wake(x: number, z: number, h: number, len: number, beam: number, v: number): void {
    const c = Math.cos(h);
    const s = Math.sin(h);
    const k = Math.min(1, v / 3);
    this.wakes.put(x - c * (len / 2 - 2), -0.95 + this.fy, z - s * (len / 2 - 2), -h, 0, 30 + 150 * k, 1, beam * (0.9 + 0.4 * k), WHITE);
    if (v > 0.6) this.bowWaves.put(x + c * (len / 2 - 1), -0.9 + this.fy, z + s * (len / 2 - 1), -h, 0, 8 + 30 * k, 1, beam * (0.5 + 0.35 * k), WHITE);
  }

  /** 靠泊时的缆绳：船首、船尾的头缆和尾缆，前后的横缆和倒缆（靠上码头后一根根带上，解缆时一根根收回） */
  private mooringLines(x: number, zM: number, dir: number, len: number, beam: number, t: number, tOn: number, tOff: number, x0: number): void {
    for (let j = 0; j < MOOR.length; j++) {
      const m = at(MOOR, j);
      if (t < tOn + 90 + j * 100 || t >= tOff + 60 + j * 70) continue;
      const bx = x + dir * m.b * len;
      const snap = x0 - 10 + Math.round((bx - (x0 - 10)) / 22) * 22;
      this.va.set(x + dir * m.s * len, 6.2 + this.fy, zM - beam / 2 + 0.8);
      this.vb.set(snap, 1.6, ZQ - 2.2);
      this.ropes.rod(this.va, this.vb, 0.16, LINE_HEX);
    }
  }

  /** 一条拖轮此刻的位置：在基地靠着、赶路、跟着船（顶推、带缆拖带、护航） */
  private drawTug(tp: TugPlan, t: number): void {
    const P = this.P;
    let seg: TugSeg | undefined;
    for (const s of tp.segs)
      if (t >= s.t0 && t < s.t1) {
        seg = s;
        break;
      }
    let mode = -1;
    if (!seg) {
      P.x = tp.home.x;
      P.z = tp.home.z;
      P.h = -Math.PI / 2;
      P.v = 0;
    } else if (seg.ph) {
      evalPhase(seg.ph, t, P);
      mode = 0;
    } else if (seg.att) {
      const { call, keys } = seg.att;
      const sp = poseAt(call, t, this.S);
      if (!sp) return;
      let i = 0;
      while (i + 1 < keys.length && at(keys, i + 1).t <= t) i++;
      const a = at(keys, i);
      const b = keys[i + 1] ?? a;
      const f = b === a ? 0 : ease(prog(t, a.t, b.t));
      const lx = lerp(a.lx, b.lx, f);
      const lz = lerp(a.lz, b.lz, f);
      const lh = a.lh + angDiff(a.lh, b.lh) * f;
      mode = f > 0.5 ? b.m : a.m;
      const S = this.S;
      const ch = Math.cos(S.h);
      const sh = Math.sin(S.h);
      P.x = S.x + lx * ch - lz * sh;
      P.z = S.z + lx * sh + lz * ch;
      P.h = S.h + lh;
      P.v = S.v;
      // 拖带的缆绳：拖轮船尾（船首前方那条）或船首（船尾那条）→ 船上的缆桩
      if (mode === 2 || mode === 3 || mode === 4) {
        const C = at(CLASSES, call.cls);
        const tEnd = mode === 4 ? 12.5 : -12;
        this.va.set(P.x + Math.cos(P.h) * tEnd, 2.6 + this.fy, P.z + Math.sin(P.h) * tEnd);
        const sx = mode === 3 ? C.len / 2 - 4 : mode === 4 ? -C.len / 2 + 3 : lx;
        const sz = mode === 2 ? Math.sign(lz) * (C.beam / 2 - 1) : 0;
        this.vb.set(S.x + sx * ch - sz * sh, 6.4 + this.fy, S.z + sx * sh + sz * ch);
        this.ropes.rod(this.va, this.vb, 0.14, ROPE_HEX);
      }
      // 顶推、拖带时螺旋桨翻起的水花
      if (sp.k !== 'hold' && mode >= 1 && mode <= 4) P.v = Math.max(P.v, 1.6);
    }
    this.tugs.put(P.x, this.fy, P.z, -P.h, 0, 1, 1, 1, WHITE);
    if (P.v > 0.3 && mode !== -1) this.wakes.put(P.x - Math.cos(P.h) * 12, -0.95 + this.fy, P.z - Math.sin(P.h) * 12, -P.h, 0, 14 + 30 * Math.min(1, P.v / 4), 1, 8, WHITE);
  }

  /** 码头拖车：车头在 at（前进方向），平板车在后，车上有箱就放上去 */
  private drawTractor(a: At, boxColor?: number): void {
    const cx = Math.cos(-a.yaw);
    const cz = Math.sin(-a.yaw);
    // 拖车车头在 at：牵引车原点（车尾）离车头 5.9 米，平板车原点 16.2 米，箱的中心 9.95 米
    this.tractors.put(a.x - cx * 5.9, 0.2, a.z - cz * 5.9, a.yaw, 0, 1, 1, 1, WHITE);
    this.chassis.put(a.x - cx * 16.2, 0.2, a.z - cz * 16.2, a.yaw, 0, 1, 1, 1, WHITE);
    this.ttLamps.part(this.ttLamp, a.x - cx * 5.9, 0.2, a.z - cz * 5.9, a.yaw, 1, true, false, this.ttSt);
    this.ttLamps.part(this.tcLamp, a.x - cx * 16.2, 0.2, a.z - cz * 16.2, a.yaw, 1, false, true, this.ttSt);
    if (boxColor !== undefined) this.boxes.put(a.x - cx * 9.95, 1.75, a.z - cz * 9.95, a.yaw, 0, 1, 1, 1, boxColor);
  }

  /** 鼠标拾取别家的船（船体）：在当天船期里的下标、离镜头多远 */
  pick(ray: THREE.Raycaster): { call: number; dist: number } | undefined {
    let best: { call: number; dist: number } | undefined;
    for (const [mesh, own] of this.hullOwner) {
      if (!mesh.count) continue;
      const hit = ray.intersectObject(mesh, false)[0];
      if (hit?.instanceId === undefined || (best && hit.distance >= best.dist)) continue;
      const call = own[hit.instanceId];
      if (call !== undefined) best = { call, dist: hit.distance };
    }
    return best;
  }

  /** 别家的一条船此刻的位置（港口局部坐标，跟随镜头用）；不在画面里返回 undefined */
  callPose(call: number, t: number): { x: number; z: number; h: number } | undefined {
    const cl = this.plan?.calls[call];
    if (!cl || !poseAt(cl, t, this.pickP)) return undefined;
    return { x: this.pickP.x, z: this.pickP.z, h: this.pickP.h };
  }

  /** 别家的一条船此刻的说明（悬停、跟随时显示）：船名、船型、泊位、在做什么 */
  callCard(call: number, t: number): { name: string; type: string; act: string } | undefined {
    const plan = this.plan;
    const cl = plan?.calls[call];
    if (!plan || !cl) return undefined;
    const b = cl.berth >= 0 ? plan.L.berths[cl.berth] : undefined;
    return { name: cl.name, type: at(CLASSES, cl.cls).label, act: `${b ? `${b.no} 号泊位 · ` : ''}${this.callStatus(cl, t)}` };
  }

  /** 一条船此刻的状态（给监控面板） */
  private callStatus(c: Call, t: number): string {
    if (!c.ph.length) return t < c.eta ? `预计 ${clockOf(c.eta)} 到港` : '港外等泊位';
    if (t < at(c.ph, 0).t0) return `预计 ${clockOf(c.eta)} 到港`;
    if (c.anchor && t < c.anchor.t0) return '驶往锚地';
    if (c.anchor && (c.berth < 0 || t < c.tArr)) return '锚地等泊位';
    if (c.berth < 0) return '港外等泊位';
    if (t < c.tMeet) return '进港';
    if (t < c.tSwing) return '进港（拖轮协助）';
    if (t < c.tPush) return '泊位前掉头';
    if (t < c.tAlong) return '拖轮顶推靠泊';
    if (t < c.tFast) return '带缆';
    if (t < c.tW0) return '准备作业';
    if (t < c.tW1) {
      let cur: CraneMove | undefined;
      for (const m of c.ops) {
        if (at(m.tt, 0) > t) break;
        cur = m;
      }
      return cur ? (cur.kind === 'dis' ? '卸船' : '装船') : '装卸中';
    }
    if (t < c.tCast) return '作业完成，绑扎检查';
    if (t < c.tOff) return '解缆';
    if (t < c.tSwingOut) return '拖轮拖离';
    if (t < c.tOut) return '离泊掉头';
    if (t < c.tGone) return '出港';
    return '已离港';
  }

  /** 港口监控面板的数据：班轮和别家的船的进度、本店的箱、每台设备此刻在做什么、闸口、堆场 */
  info(t: number): PortInfo {
    const plan = this.plan;
    const empty: PortInfo = { other: { moves: 0, done: 0 }, calls: [], berths: [], boxes: [], equip: [], gate: { inside: 0, inToday: 0, outToday: 0, queue: 0 }, yard: { boxes: 0, slots: 0 }, tide: tideInfo(t) };
    if (!plan) return empty;
    const L = plan.L;
    const ownMoves = plan.moves.filter((m) => m.own);
    const ship = this.day.ship;
    const equip: PortInfo['equip'] = [];
    const doneOf = (fin: number[]) => {
      let lo = 0;
      let hi = fin.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (at(fin, mid) <= t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    for (let c = 0; c < L.cranes.length; c++) {
      const cr = at(L.cranes, c);
      const B = at(L.berths, cr.berth);
      const list = at(plan.byCrane, c);
      let done = 0;
      let cur: CraneMove | undefined;
      let next: CraneMove | undefined;
      for (const m of list) {
        if (at(m.tt, 8) <= t) done++;
        if (at(m.tt, 0) <= t && t < at(m.tt, 8)) cur = m;
        if (!next && at(m.tt, 0) > t) next = m;
      }
      const shipName = (m: CraneMove) => (m.call >= 0 ? at(plan.calls, m.call).name : '本店班轮');
      const last = list[list.length - 1];
      const now = cur ? `${cur.kind === 'dis' ? '卸船' : '装船'} ${cur.id}${cur.store ? '（本店）' : ''} · ${shipName(cur)}` : next && (!last || done === 0 || at(next.tt, 0) - t > 1800) ? `待作业（${clockOf(at(next.tt, 0))} ${shipName(next)} 开工）` : next ? '移位 / 等拖车' : list.length && last && t > at(last.tt, 8) ? '作业完成，前大梁仰起' : '待命';
      equip.push({ id: cr.id, kind: `岸桥 · ${B.no} 号泊位（${B.own ? '本店班轮' : '别家的船'}）`, now: plan.why.get(cr.id) ?? now, moves: list.length, doneMoves: done });
    }
    const nC = L.cols.length;
    for (let k = 0; k < plan.rtgTasks.length; k++) {
      const list = at(plan.rtgTasks, k);
      let cur: RtgTask | undefined;
      let done = 0;
      for (const x of list) {
        if (at(x.tt, 9) <= t) done++;
        if (x.t0 <= t && t < at(x.tt, 9)) cur = x;
      }
      equip.push({ id: `RTG${k + 1}`, kind: `龙门吊 · ${at(['A', 'B', 'C'], Math.floor(k / nC))}${(k % nC) + 1} 箱区`, now: cur ? cur.label : '待命', moves: list.length, doneMoves: done });
    }
    let busyTractors = 0;
    for (const legs of plan.tractorLegs) if (legs.some((l) => t >= l.t0 && t < l.t1)) busyTractors++;
    equip.push({ id: '场内集卡', kind: `${plan.layout.cranes * plan.layout.gang} 辆（每台岸桥 ${plan.layout.gang} 辆）`, now: `${busyTractors} 辆在作业`, moves: plan.moves.length, doneMoves: plan.moves.filter((m) => at(m.tt, 8) <= t).length });
    let yard = 0;
    for (const a of plan.slots) for (const b of a) for (const k of b) for (const s of k) for (const tr of s.tiers) if (tr.t0 <= t && t < tr.t1) yard++;
    const inside = plan.gate.filter((g) => g.inAt <= t && t < g.outAt).length;
    const queue = plan.gate.filter((g) => g.t0 <= t && t < g.inAt).length;
    // 船期：今天在港里出现过的船（零点前就在的、半夜还在锚地的都算）
    const calls: PortCallInfo[] = plan.calls
      .filter((c) => c.ph.length && at(c.ph, 0).t0 < DAY_END && c.tGone > 0)
      .map((c) => {
        const B = c.berth >= 0 ? at(L.berths, c.berth) : undefined;
        return {
          id: c.id || '—',
          name: c.name,
          cls: at(CLASSES, c.cls).label,
          berth: B ? `${B.no} 号泊位` : '—',
          eta: c.eta,
          ...(B && Number.isFinite(c.tFast) ? { fast: c.tFast } : {}),
          ...(B && Number.isFinite(c.tCast) ? { cast: c.tCast } : {}),
          ...(c.anchor ? { anchor: [c.anchor.t0, c.anchor.t1] as [number, number] } : {}),
          status: this.callStatus(c, t),
          moves: c.moves,
          done: doneOf(c.fin),
        };
      })
      .sort((a, b) => (a.fast ?? a.eta + 1e6) - (b.fast ?? b.eta + 1e6));
    const berths: PortInfo['berths'] = L.berths.map((b) => {
      const cranes = b.cranes.filter((c) => !plan.why.has(at(L.cranes, c).id)).length;
      if (b.own) {
        const on = ship && t >= ship.berth[0] - LINER_RUN && t < ship.berth[1] + LINER_RUN;
        const st = !ship ? '今天没有本店的班轮' : t < ship.berth[0] - LINER_RUN ? `等本店班轮（${clockOf(ship.berth[0])} 靠泊）` : t < ship.berth[0] ? '本店班轮进港' : t < ship.berth[1] ? '本店班轮装卸中' : t < ship.berth[1] + LINER_RUN ? '本店班轮离港' : '空泊位';
        return { label: `${b.no} 号泊位`, own: true, cranes, ...(on ? { ship: '本店班轮' } : {}), status: st };
      }
      const here = plan.calls.find((c) => c.berth === b.i && c.ph.length && t >= c.tMeet && t < c.tGone);
      const near = plan.calls.find((c) => c.berth === b.i && c.ph.length && t >= (Number.isFinite(c.tSwing) ? c.tSwing - 1800 : -Infinity) && t < c.tOff);
      const c = near ?? here;
      const nxt = plan.calls.filter((x) => x.berth === b.i && Number.isFinite(x.tFast) && x.tFast > t).sort((x, y) => x.tFast - y.tFast)[0];
      return { label: `${b.no} 号泊位`, own: false, cranes, ...(c ? { ship: c.name } : {}), status: c ? this.callStatus(c, t) : nxt ? `空泊位（${nxt.name} 预计 ${clockOf(nxt.tFast)} 靠泊）` : cranes ? '空泊位' : '岸桥都停用，不接船' };
    });
    const otherToday = plan.moves.filter((m) => !m.own && at(m.tt, 8) >= 0 && at(m.tt, 8) < DAY_END);
    const logistics = this.logi.info(t);
    return {
      ...(ship
        ? {
            vessel: {
              label: ship.label,
              berth: ship.berth,
              moves: ownMoves.length,
              done: ownMoves.filter((m) => at(m.tt, 8) <= t).length,
              discharge: ownMoves.filter((m) => m.kind === 'dis' && at(m.tt, 8) <= t).length,
              loaded: ownMoves.filter((m) => m.kind === 'load' && at(m.tt, 8) <= t).length,
            },
          }
        : {}),
      other: { moves: otherToday.length, done: otherToday.filter((m) => at(m.tt, 8) <= t).length },
      calls,
      berths,
      boxes: plan.boxesInfo,
      equip,
      gate: { inside, inToday: plan.gate.filter((g) => g.inAt <= t).length, outToday: plan.gate.filter((g) => g.outAt <= t).length, queue },
      yard: { boxes: yard, slots: 3 * nC * BAYS * 6 * TIERS },
      tide: tideInfo(t),
      ...(logistics ? { logistics } : {}),
    };
  }
}

function clockOf(t: number): string {
  const m = Math.round(t / 60);
  const r = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}
