import * as THREE from 'three';
import { JUNCTION } from '../../../../src/hub/portLayout';
import { buildGraph, shortestPath } from '../../../../src/region/network';
import { FRAMES } from '../../../../src/region/region';
import { toLocal as frameToLocal, toWorld as frameToWorld, type Frame } from '../../../../src/region/frames';
import { cumulative, reverse, v3, type V3 } from '../geo';
import { BUILDS, partGeometry, type PartSpec } from '../fleet';
import { cruiseTime, DYN, drivePath, driveOn, driveTime, inSpans, leadState, legAt, LIGHT_WAIT, lightAt, LOT_PACE, makeTrack, partPose, reverseOn, roadSpans, trackAt, type DrivePath, type DrivePiece, type LeadState, type MLeg, type PartPose, type QueueHook, type RoadSpan, type Track } from '../motion';
import { lotEntry, type Lot } from '../parking';
import type { Arc, RoadNet } from '../roadnet';
import type { DockVisit } from './airport';
import { drain, ease, Pool, rng, type Steps } from './kit';
import type { GateTrip } from './port';
import type { ParkTrip } from './parkYard';
import { dimsOf, poseAt as yardPoseAt, toWorld as yardToWorld, yawOf, type YardFrame, type YardPlan, type YardSchedule, type YardTimeline } from '@storewright/yard';

/**
 * 港口、机场的外来货车（背景，不参与仿真）：别家的集装箱卡车、货代的厢式货车。整趟车都画出来，不在路上、闸口凭空出现或消失。
 *
 * - 港口：港口的作业计划里每一辆外来集卡都有到闸口排队、进闸、到箱区提箱或送箱、出闸的时刻（ops/port.ts）。这里给它接上来去的路：
 *   从出区域的高速口外的远处开来（来早了先进港口的集卡等候区停着，到预约的时段再开出来），沿进港的路开到闸口前、分到自己的进闸车道排队；
 *   出闸以后并回出港的车道，开到高速口、沿延长段开出视野。夜里有提前到的车在等候区过夜，早上闸口一开就进港；晚上也有为明天来排队的车。
 * - 机场：别家货运航班的进出口货由货代的车在货站陆侧的收货口装卸（ops/airport.ts 排的时段，一樘一次一辆）。车从进场路的尽头掉头，
 *   开进卡车场，沿场内车道开过收货口，再倒车靠上（车尾贴门）；装卸完往前开出来，右转回到出场的车道。来早了或收货口没空，先在机场的货车等候区等。
 * - 等候区：车从场口进去（道闸前停一下、抬杆），沿通道开进货车位（直进直出，不倒车），走的时候往前开到出场一侧的通道，过道闸出去。
 *
 * 道路部分和仿真车用同一套运动规划（motion.ts：车道、路口转弯、加减速、红灯停在停止线后）。路上远看时车辆放大（和区域里的车一样），
 * 进到港口、机场、等候区里按真实大小画（离场地 BLEND 米内渐变）。
 */
const H = 3600;
const DAY = 24 * H;
/** 道路上车速系数 1（高速）对应的车速：沙盘米 / 秒（距离压缩成 1/10，约 83 公里 / 小时） */
const V_ROAD = 2.3;
/** 道闸前停多久（秒）；离场地多远开始从放大渐变到真实大小（米） */
const BAR_WAIT = 4;
const BLEND = 120;
/** 港口：沿进港的路离闸口排队点多远离开车道、分到各自的进闸车道（米）；排队点到道闸开多久（秒） */
const PORT_FAN = 150;
const GATE_UP = 13;
/** 同一个等候区前后两辆车停好的时刻至少隔多少秒（从不同的高速口来、在进场路上汇到一起的车不会叠在一起） */
const LOT_GAP = 45;
const BAR_GAP = 35;
/** 闸口排队：排队点后面每个车位的间距（米） */
const QUEUE_STEP = 20;
/** 同一个高速口开进来的车、同一个设施开出去的车，前后至少隔多少秒（一个信号周期：前车等红灯时后车不会停到它身上） */
const GAP = 80;
/** 机场货站陆侧墙的 z（局部坐标）：卡车场的进场点在墙线上 */
const TERM_ZLAND = 985;
/**
 * 机场：在进场路尽头前多远离开道路、进回车场掉头（米）。回车场（ops/airport.ts 铺的圆形场地）里进来、出去的车各走各的圈，
 * 不交叉：进场的车走外圈（外车道 → 外圈 → 出场一侧的外车道，排队、开进卡车场），出去的车走里圈（里车道 → 里圈 → 出场一侧的里车道，
 * 从排队的车旁边开过去）
 */
const AIR_TURN = 8;
/** 机场回车场：两个圈的圆心在进场路尽头往南 AIR_C 米，外圈、里圈的半径；车道宽 */
const AIR_C = 8;
const AIR_RO = 12.5;
const AIR_RI = 7.5;
const AIR_LW = 3.7;
/**
 * 路上跟车：同一条车道上前车的车头往后推 FOLLOW_TAU 秒、再往回让一个车长加 FOLLOW_GAP 米，是后车车头不能越过的线；
 * 被耽误了以后按原来的速度曲线快 CATCH_UP 倍追回来（追不回来就晚到，后面停着等的那一段缩短）
 */
const FOLLOW_TAU = 1.6;
const FOLLOW_GAP = 3;
const CATCH_UP = 0.2;
const CABS = [0xc0392b, 0x1f5fbf, 0xf2f2ef, 0x2e7d4f, 0xd68910, 0x5d6d7e, 0x7d3c98, 0xe5e7e9];
const TRAILERS = [0xf3f3f0, 0xe9ecef, 0xdfe3e6, 0x2f6f8f];
/** 晚上来过夜的集卡车上的箱（各家公司的颜色） */
const BOXES = [0xb03a2e, 0x2471a3, 0x1e8449, 0xca6f1e, 0x7d3c98, 0x5d6d7e];
type End = 'NORTH' | 'EAST';
/** 车灯在零件上的位置（fleet.ts 的 LAMPS：[x, y, |z|]）和颜色：大灯、尾灯（夜里常亮）、刹车灯 */
const HEAD: readonly [number, number, number] = [6.06, 0.98, 0.78];
const TAIL_CHASSIS: readonly [number, number, number] = [-0.02, 0.98, 1.02];
const TAIL_TRAILER: readonly [number, number, number] = [-0.09, 1.1, 1.0];
const HEAD_HEX = 0xfff3cf;
const TAIL_HEX = 0x9a1208;
const BRAKE_HEX = 0xff2a14;
const SIDES = [1, -1] as const;
/** 天黑了（和区域车辆层一样按太阳高度）：开车灯 */
function isNight(t: number): boolean {
  const h = (((t / 3600) % 24) + 24) % 24;
  return Math.sin((Math.PI * (h - 6)) / 13.5) * 1.6 + 0.2 < 0.62;
}

interface XLeg extends MLeg {
  /** 1 = 在场地里（港口、机场、等候区：真实大小）；0 = 路上（远看放大），路径上 uA 以前、uB 以后是场地，离它 BLEND 米内渐变 */
  site: 0 | 1;
  uA: number;
  uB: number;
  /** 车上的集装箱的颜色（没有箱 = undefined） */
  box?: number;
  /**
   * 路上的段：要画到它（或者空闲时）才排速度曲线（排红灯要算好几遍，一天几百辆车一起排太慢）。
   * 所有车的路上的段按开始的时刻先后排，红灯前排队看的是先排好的车（结果和看的先后无关）
   */
  drive?: { dp: DrivePath; t2: number; free0: boolean; free1: boolean };
  /** 这一段不在这里画（港口物流中心的场地里，按收货场引擎的时间线画） */
  hidden?: boolean;
  /** 哪辆车的（车长、后面的段） */
  tk?: XTruck;
  /** 收货场里的一段（机场陆侧卡车场）：按收货场引擎的时刻表取位姿（牵引车、挂车各自的朝向） */
  yard?: { tl: YardTimeline; frame: YardFrame };
}
/** 排好速度曲线的路上的段在一条车道上的那一截：路径位置和线上坐标的对应、在这一截里的时段、车长 */
interface LaneUse {
  leg: XLeg;
  sp: RoadSpan;
  t0: number;
  t1: number;
  L: number;
}
interface XTruck {
  /** 车型：0 集装箱车（牵引车 + 骨架车），1 厢式半挂，2 冷藏半挂，3 厢式货车，4 面包车 */
  build: 0 | 1 | 2 | 3 | 4;
  cab: number;
  trailer: number;
  t0: number;
  t1: number;
  legs: XLeg[];
}
/** 一条拼好的路线：行驶路径、道路部分在路径上的起止（以外是场地）、道闸前的停车点（−1 = 没有） */
interface Way {
  dp: DrivePath;
  roadA: number;
  roadB: number;
  bar: number;
}
interface Piece extends DrivePiece {
  road: boolean;
  /** 高速口外的延长段（进来 / 出去、哪个高速口、哪条车道）：不在道路弧里，跟车按这一段自己的路程比 */
  far?: string;
}
/** 每条路线（按起止是否带着速度）算过的行程时间、按道闸切开的两段（同一条路线上的车共用） */
const SPANS = new WeakMap<DrivePath, number[]>();
const HALVES = new WeakMap<Way, [DrivePath, DrivePath]>();
function halves(w: Way): [DrivePath, DrivePath] {
  let h = HALVES.get(w);
  if (!h) HALVES.set(w, (h = [sub(w.dp, 0, w.bar, 0), sub(w.dp, w.bar, w.dp.track.len, 25)]));
  return h;
}

const smooth = (x: number): number => {
  const k = x < 0 ? 0 : x > 1 ? 1 : x;
  return k * k * (3 - 2 * k);
};

/** 路径上离点 p 最近的位置（只在 [from, to] 里找） */
function nearestOn(tr: Track, p: { x: number; z: number }, from = 0, to = Infinity): number {
  let best = from;
  let bd = Infinity;
  for (let i = 1; i < tr.pts.length; i++) {
    const c0 = tr.cum[i - 1] as number;
    const c1 = tr.cum[i] as number;
    if (c1 < from || c0 > to) continue;
    const a = tr.pts[i - 1] as V3;
    const b = tr.pts[i] as V3;
    const ux = b.x - a.x;
    const uz = b.z - a.z;
    const l2 = ux * ux + uz * uz || 1e-9;
    const k = Math.max(0, Math.min(1, ((p.x - a.x) * ux + (p.z - a.z) * uz) / l2));
    const d = Math.hypot(p.x - a.x - ux * k, p.z - a.z - uz * k);
    if (d < bd) {
      bd = d;
      best = c0 + Math.sqrt(l2) * k;
    }
  }
  return Math.max(from, Math.min(to, best));
}

/** 道路上的直段去掉多余的点（转弯处、车速系数变化处都留着，直段最多隔 40 米一个点）：排速度曲线快几倍 */
function thin(pts: readonly V3[], pace: readonly number[]): { pts: V3[]; pace: number[] } {
  const n = pts.length;
  if (n < 3) return { pts: pts.slice(), pace: pts.map((_, i) => pace[Math.min(i, pace.length - 1)] as number) };
  const pc = (i: number) => pace[Math.min(i, pace.length - 1)] as number;
  const outP: V3[] = [pts[0] as V3];
  const outC: number[] = [pc(0)];
  let k = 0;
  for (let i = 1; i < n - 1; i++) {
    const a = pts[k] as V3;
    const b = pts[i] as V3;
    const c = pts[i + 1] as V3;
    const h1 = Math.atan2(b.z - a.z, b.x - a.x);
    const h2 = Math.atan2(c.z - b.z, c.x - b.x);
    let dh = Math.abs(h2 - h1);
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    const far = Math.hypot(c.x - a.x, c.z - a.z) > 40;
    if (dh > 0.012 || far || pc(i) !== pc(i + 1) || Math.abs(b.y - a.y) > 0.05 || Math.abs(c.y - b.y) > 0.05) {
      outP.push(b);
      outC.push(pc(i));
      k = i;
    }
  }
  outP.push(pts[n - 1] as V3);
  outC.push(pc(n - 1));
  return { pts: outP, pace: outC };
}

/** 一段路径的一部分 [s0, s1]，前面再带 lead 米引入段（领先点从引入段的末端开始）；信号灯跟着挪 */
function sub(dp: DrivePath, s0: number, s1: number, lead: number): DrivePath {
  const tr = dp.track;
  const a = Math.max(0, s0 - lead);
  const paceAt = (s: number): number => {
    let i = 1;
    while (i < tr.cum.length - 1 && (tr.cum[i] as number) < s) i++;
    return dp.pace[i] ?? 1;
  };
  const pts: V3[] = [trackAt(tr, a)];
  const pace: number[] = [paceAt(a)];
  const push = (p: V3, pc: number) => {
    const last = pts[pts.length - 1] as V3;
    if (Math.hypot(p.x - last.x, p.z - last.z) <= 0.05) return;
    pts.push(p);
    pace.push(pc);
  };
  for (let i = 0; i < tr.pts.length; i++) {
    const c = tr.cum[i] as number;
    if (c > a + 0.05 && c < s1 - 0.05) push((tr.pts[i] as V3).clone(), dp.pace[i] ?? 1);
  }
  push(trackAt(tr, s1), paceAt(s1));
  if (pts.length < 2) pts.push(trackAt(tr, s1 + 0.2)), pace.push(paceAt(s1));
  // 道路弧的位置跟着挪（只留这一截前后的点）
  const spans = dp.spans
    .map((sp) => {
      const keep = sp.us.map((u, i) => i).filter((i) => (sp.us[i] as number) > a - 30 && (sp.us[i] as number) < s1 + 30);
      return { ...sp, us: keep.map((i) => (sp.us[i] as number) - a), ss: keep.map((i) => sp.ss[i] as number) };
    })
    .filter((sp) => sp.us.length >= 2);
  return { track: makeTrack(pts), pace, lights: dp.lights.filter((l) => l.s > s0 + 1 && l.s < s1 - 1).map((l) => ({ ...l, s: l.s - a })), uStart: s0 - a, spans };
}

/** 高速口外延长段的编号（跟车按「线」记，延长段用负数） */
/**
 * 道闸前直着开进来的等候区：港口的集卡等候区（以前进场的路一过进出场路的尽头就拐向车位，车在道闸前停下时车头已经在弯上，
 * 牵引车和挂车折成六十多度）。机场的货车等候区试过一样的做法，反而更多重叠，保持原样
 */
const RUNIN_LOTS = new Set(['PORT:hold']);

const FAR_KEYS = new Map<string, number>();
function farKey(k: string): number {
  let v = FAR_KEYS.get(k);
  if (v === undefined) FAR_KEYS.set(k, (v = FAR_KEYS.size));
  return v;
}
/** [开, 关, 开, 关……] 一对对 */
function pairs(spans: readonly number[] | undefined): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; spans && i + 1 < spans.length; i += 2) out.push([spans[i] as number, spans[i + 1] as number]);
  return out;
}
/** 时段排序、合并挨着的 */
function mergePairs(spans: readonly number[]): number[] {
  const ps = pairs(spans).sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [a, b] of ps) {
    const L = out.length;
    if (L && a <= (out[L - 1] as number) + 0.6) out[L - 1] = Math.max(out[L - 1] as number, b);
    else out.push(a, b);
  }
  return out;
}

export class ExtTrucks {
  /** 不跟车（对比、检查用） */
  static noFollow = false;

  readonly group = new THREE.Group();
  private trucks: XTruck[] = [];
  /** 第几次排一天（换了一天，没排完的空闲任务就作废） */
  private gen = 0;
  /** 还没排速度曲线的路上的段（按开始的先后）、排到第几段了；信号灯前停过的车：停止线 → [停住, 起步] */
  private pend: XLeg[] = [];
  private next = 0;
  private lq = new Map<string, { a: number; b: number }[]>();
  /** 已经排好的路上的段按车道（线:方向:车道）记下来，后排的车跟着它们 */
  private onLane = new Map<string, LaneUse[]>();
  /** 跟车改过的段数、一共晚到多少秒（检查用） */
  readonly follow = { legs: 0, late: 0, maxLate: 0 };
  /** 今天的车数：港口、其中进过等候区的、机场、其中进过等候区的、在等候区过夜的 */
  readonly stats = { port: 0, portLot: 0, air: 0, airLot: 0, night: 0, park: 0 };
  /** 闸口里面的路口：经过的段、刚过道闸的（不停）、在停车线前等过的、等不下的 */
  readonly gateStats = { legs: 0, fixed: 0, waited: 0, failed: 0 };
  /** 闸口路口的冲突由港口、物流中心的闸口计划错开（等在箱位、场地口）；这里不再让车停下再赶时间，只数剩下的 */
  private static readonly SPEED_UP: boolean = false;
  /** 物流园的外来车（ops/parkYard.ts 给的路上那一部分）、上一次排的那一天（物流园的计划变了重排） */
  private parkTrips: readonly ParkTrip[] = [];
  private last: { port: GateTrip[]; air: Parameters<ExtTrucks['planAir']>[0]; seed: number } | undefined;
  private parkTimer: ReturnType<typeof setTimeout> | undefined;
  /** 三维层正在分段排这一天（港口、机场的行程还没到）：物流园的计划变了也先不重排，到时候 daySteps 按最新的一起排 */
  waiting = false;
  /** 道闸抬起的时段：停车场编号:in / :out → [开始, 结束, 开始, 结束……] */
  private bars = new Map<string, number[]>();
  private readonly g = buildGraph();
  private readonly arcCache = new Map<string, Arc[]>();
  private readonly ways = new Map<string, Way>();
  private readonly pools: Pool[];
  private readonly tractor: Pool;
  private readonly chassis: Pool;
  private readonly box: Pool;
  private readonly trailer: Pool;
  private readonly reefer: Pool;
  /** 机场货代的厢式货车、面包车（单体车） */
  private readonly boxTruck: Pool;
  private readonly van: Pool;
  private readonly heads: Pool;
  private readonly tails: Pool;
  private readonly ls: LeadState = { u: 0, v: 0, a: 0 };
  private readonly pp: PartPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };

  constructor(private readonly net: RoadNet) {
    this.group.name = 'ext-trucks';
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
    this.tractor = new Pool(partGeometry('tractor'), mat, 360, 'ext-tractors');
    this.chassis = new Pool(partGeometry('chassis'), mat, 300, 'ext-chassis');
    this.box = new Pool(partGeometry('container'), mat, 300, 'ext-boxes');
    this.trailer = new Pool(partGeometry('trailerPlain'), mat, 120, 'ext-trailers');
    this.reefer = new Pool(partGeometry('trailerPlainReefer'), mat, 80, 'ext-reefers');
    this.boxTruck = new Pool(partGeometry('boxTruck'), mat, 60, 'ext-box-trucks');
    this.van = new Pool(partGeometry('van'), mat, 40, 'ext-vans');
    // 车灯：不受光照、不压暗（夜里看得见）
    const lampGeo = new THREE.BoxGeometry(0.12, 0.24, 0.44);
    this.heads = new Pool(lampGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), 720, 'ext-headlamps', false);
    this.tails = new Pool(lampGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), 720, 'ext-taillamps', false);
    this.pools = [this.tractor, this.chassis, this.box, this.trailer, this.reefer, this.boxTruck, this.van, this.heads, this.tails];
    for (const p of this.pools) this.group.add(p.mesh);
  }

  // ———————————————————————— 路线 ————————————————————————

  private arcs(from: string, to: string): Arc[] {
    const k = `${from}>${to}`;
    let a = this.arcCache.get(k);
    if (!a) {
      try {
        a = this.net.routeArcs(shortestPath(this.g, from, to).nodes);
      } catch {
        a = [];
      }
      this.arcCache.set(k, a);
    }
    return a.map((x) => ({ ...x }));
  }

  /** 出区域的高速口：从延长段的远处开到路口（进来），从路口开到延长段的远处（出去）；lane：车道（0 = 最右） */
  private farIn(end: End, lane = 0): V3[] {
    const pl = this.net.places.get(end);
    if (!pl) return [];
    const line = this.net.lines.find((l) => l.ja === end && l.jb === (end === 'NORTH' ? 'MAP_N' : 'MAP_E'));
    if (lane && line) return this.net.lanePath(line, line.len, 0, lane);
    return [...(pl.offIn ?? []), ...(pl.leave ?? reverse(pl.path))];
  }
  private farOut(end: End, lane = 0): V3[] {
    const pl = this.net.places.get(end);
    if (!pl) return [];
    const line = this.net.lines.find((l) => l.ja === end && l.jb === (end === 'NORTH' ? 'MAP_N' : 'MAP_E'));
    if (lane && line) return this.net.lanePath(line, 0, line.len, lane);
    return [...pl.path, ...(pl.offOut ?? [])];
  }

  /** 行程序列的尾巴去掉 d 米（到设施大门前就离开车道）；不够长的整段去掉 */
  private static trimEnd(arcs: Arc[], d: number): Arc[] {
    const out = arcs.map((a) => ({ ...a }));
    let left = d;
    while (out.length && left > 0) {
      const a = out[out.length - 1] as Arc;
      const len = Math.abs(a.s1 - a.s0);
      if (len - left > 8) {
        a.s1 -= Math.sign(a.s1 - a.s0) * left;
        left = 0;
      } else {
        out.pop();
        left -= len;
      }
    }
    return out;
  }
  private static trimStart(arcs: Arc[], d: number): Arc[] {
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

  /** 拼一条路线：几段路径（标出哪些是道路）、道路部分的行程（找信号灯）；bar：道闸（在路径上找停车点） */
  private way(pieces: Piece[], arcs: Arc[], uStart = 0, bar?: { p: V3; d: { x: number; z: number }; out: boolean }, lane = 0): Way {
    const dp = drivePath(this.net, pieces.filter((p) => p.pts.length > 1).map((p) => (p.road ? { ...thin(p.pts, p.pace), road: true } : p)), arcs, lane, uStart);
    const tr = dp.track;
    // 路线前面是高速口外几公里长的延长段：运动规划找道路弧在路径上的位置时从路径开头附近找起（找不到，跟车就看不到路上的前车），
    // 这里从道路部分的起点重新找一遍
    {
      const firstRoad = pieces.find((p) => p.road && !p.far && p.pts.length > 1);
      if (firstRoad && arcs.length) {
        const u0r = nearestOn(tr, firstRoad.pts[0] as V3, 0, tr.len);
        if (u0r > 300) {
          const more = roadSpans(this.net, arcs, lane, tr, u0r);
          if (more.length > dp.spans.length) dp.spans = more;
        }
      }
    }
    // 笔直的路（只有两个点的道路线）运动规划不给车道上的一截（没有中间的折点可对），跟车就看不到同一条路上的前车：
    // 这里按路的直线方向把路径上的点投到路上，补上这一截（车道坐标 = 沿路的距离）
    {
      let uFrom = Math.max(0, uStart - 40);
      for (const arc of arcs) {
        const line = this.net.lines[arc.line];
        const got = dp.spans.find((x) => x.line === arc.line);
        if (got) {
          uFrom = got.us[got.us.length - 1] as number;
          continue;
        }
        if (!line || line.pts.length !== 2) continue;
        const A = line.pts[0] as V3;
        const B = line.pts[1] as V3;
        const LL = Math.hypot(B.x - A.x, B.z - A.z) || 1;
        const dx = (B.x - A.x) / LL;
        const dz = (B.z - A.z) / LL;
        const dir: 1 | -1 = arc.s1 >= arc.s0 ? 1 : -1;
        const lo = Math.min(arc.s0, arc.s1);
        const hi = Math.max(arc.s0, arc.s1);
        const us: number[] = [];
        const ss: number[] = [];
        for (let u = uFrom; u < Math.min(tr.len, uFrom + (hi - lo) + 300); u += 4) {
          const q = trackAt(tr, u);
          const sc = (q.x - A.x) * dx + (q.z - A.z) * dz;
          const lat = Math.abs(-(q.x - A.x) * dz + (q.z - A.z) * dx);
          if (lat > 7 || sc < lo - 1 || sc > hi + 1) {
            if (us.length >= 2) break;
            continue;
          }
          if (!ss.length || dir * (sc - (ss[ss.length - 1] as number)) > 0.5) {
            us.push(u);
            ss.push(sc);
          }
        }
        if (us.length >= 2) {
          dp.spans.push({ line: line.id, dir, lane: Math.max(0, Math.min(lane, line.xs.lanes - 1)), us, ss });
          uFrom = us[us.length - 1] as number;
        }
      }
      dp.spans.sort((a, b) => (a.us[0] as number) - (b.us[0] as number));
    }
    // 高速口外的延长段（路线的第一段或最后一段）：按这一段自己的路程记成一段「车道」，同一个高速口、同一条车道的车在上面也跟车
    const ps = pieces.filter((p) => p.pts.length > 1);
    ps.forEach((p, i) => {
      if (!p.far || (i !== 0 && i !== ps.length - 1)) return;
      const len = cumulative(p.pts)[p.pts.length - 1] as number;
      const u0 = i === 0 ? 0 : nearestOn(tr, p.pts[0] as V3, Math.max(0, tr.len - len - 60), tr.len);
      const u1 = i === 0 ? nearestOn(tr, p.pts[p.pts.length - 1] as V3, 0, len + 60) : tr.len;
      if (u1 - u0 > 5) dp.spans.push({ line: -1 - farKey(p.far), dir: 1, lane: 0, us: [u0, u1], ss: [0, u1 - u0] });
    });
    const roads = pieces.filter((p) => p.road && p.pts.length > 1);
    const first = roads[0];
    const last = roads[roads.length - 1];
    const roadA = !first || pieces[0] === first ? -Infinity : nearestOn(tr, first.pts[0] as V3, 0, tr.len);
    const roadB = !last || pieces[pieces.length - 1] === last ? Infinity : nearestOn(tr, last.pts[last.pts.length - 1] as V3, Math.max(0, roadA), tr.len);
    let s = -1;
    if (bar) {
      // 车头停在杆前 1.5 米：进场找第一次越过杆所在直线的位置（离岗亭 14 米以内），出场反过来
      const n = { x: -bar.d.z, z: bar.d.x };
      const from = bar.out ? uStart : Math.max(0, Number.isFinite(roadB) ? roadB - 30 : 0);
      for (let x = from; x < tr.len; x += 0.5) {
        const q = trackAt(tr, x);
        const along = (q.x - bar.p.x) * bar.d.x + (q.z - bar.p.z) * bar.d.z;
        const side = Math.abs((q.x - bar.p.x) * n.x + (q.z - bar.p.z) * n.z);
        if (side > 14) continue;
        if (bar.out ? along <= 1.5 : along >= -1.5) {
          s = x;
          break;
        }
      }
    }
    return { dp, roadA, roadB, bar: s };
  }

  private cached(key: string, make: () => Way | undefined): Way | undefined {
    if (this.ways.has(key)) return this.ways.get(key);
    const w = make();
    if (w) this.ways.set(key, w);
    return w;
  }

  /** 等候区的进出：T 形路口在路线上的哪一段（不在路线上的停车场不用：要绕路） */
  private lotOnRoute(lot: Lot, arcs: Arc[]): number {
    const drive = this.net.lines[lot.line];
    const tj = drive ? this.net.junctions.get(drive.ja) : undefined;
    if (!tj || tj.host === undefined || tj.s === undefined) return -1;
    return arcs.findIndex((a) => a.line === tj.host && Math.min(a.s0, a.s1) + 3 < (tj.s as number) && (tj.s as number) < Math.max(a.s0, a.s1) - 3);
  }

  /** 从高速口进等候区的路线（到车位停好），道闸前停 */
  private lotIn(lot: Lot, bay: number, end: End, facility: string): Way | undefined {
    return this.cached(`in:${lot.id}:${bay}:${end}`, () => {
      const arcs = this.arcs(end, facility);
      const i = this.lotOnRoute(lot, arcs);
      const drive = this.net.lines[lot.line];
      const b = lot.bays[bay];
      if (i < 0 || !drive || !b || !lot.barrier) return undefined;
      const tj = drive.ja;
      const head = arcs.slice(0, i + 1);
      const hi = head[i] as Arc;
      hi.s1 = this.net.junctions.get(tj)?.s as number;
      hi.jb = tj;
      head.push({ line: drive.id, s0: 0, s1: drive.len, ja: tj, jb: drive.jb });
      const road = this.net.realize(head, () => 0);
      const n = road.pts.length;
      const from = road.pts[n - 1] as V3;
      const prev = road.pts[n - 2] ?? from;
      const l = Math.hypot(from.x - prev.x, from.z - prev.z) || 1;
      const d = { x: Math.cos(lot.barrier.dir), z: Math.sin(lot.barrier.dir) };
      // 道闸前那一段笔直（进出场路尽头再直着开 3 米，车头在杆前停下时车身摆得差不多直），然后平顺地拐向车位
      const bp = lot.barrier.p;
      const runIn = v3(bp.x - d.x * 4, 0, bp.z - d.z * 4);
      const inLot = RUNIN_LOTS.has(lot.id) && d.x * (runIn.x - from.x) + d.z * (runIn.z - from.z) > 0.5 ? [from, ...lotEntry(runIn, d, b)] : lotEntry(from, { x: (from.x - prev.x) / l, z: (from.z - prev.z) / l }, b);
      const w = this.way(
        [
          { pts: this.farIn(end), pace: [1], road: true, far: `in:${end}:0` },
          { pts: road.pts, pace: road.pace, road: true },
          { pts: inLot.slice(1), pace: [LOT_PACE], road: false },
        ],
        head,
        0,
        { p: lot.barrier.p, d, out: false },
      );
      return w;
    });
  }

  /** 从等候区的车位开出来、过道闸、回到路线上往设施去：tail 接上设施门前的那一段（到这条路线的道路部分结束为止） */
  private lotOut(lot: Lot, bay: number, facility: string, cut: number, tail: V3[], key: string): Way | undefined {
    return this.cached(`out:${lot.id}:${bay}:${key}`, () => {
      // 设施的进场路在路线的最后一段；等候区的 T 形路口在它上面
      const arcs = this.arcs('NORTH', facility);
      const i = this.lotOnRoute(lot, arcs);
      const drive = this.net.lines[lot.line];
      const b = lot.bays[bay];
      if (i < 0 || !drive || !b || !lot.barrier) return undefined;
      const tj = drive.ja;
      const sT = this.net.junctions.get(tj)?.s as number;
      let rest = arcs.slice(i).map((a) => ({ ...a }));
      (rest[0] as Arc).s0 = sT;
      (rest[0] as Arc).ja = tj;
      // 离设施大门不到 cut 米就直接拐过去（不够长就整段去掉）
      const left = rest.reduce((s, a) => s + Math.abs(a.s1 - a.s0), 0);
      rest = ExtTrucks.trimEnd(rest, Math.min(cut, Math.max(0, left - 30)));
      const arcsOut: Arc[] = [{ line: drive.id, s0: drive.len, s1: 0, ja: drive.jb, jb: tj }, ...rest];
      const road = this.net.realize(arcsOut, () => 0);
      const d = { x: Math.cos(lot.barrier.dir), z: Math.sin(lot.barrier.dir) };
      const w = this.way(
        [
          { pts: b.out, pace: [LOT_PACE], road: false },
          { pts: road.pts, pace: road.pace, road: true },
          { pts: tail, pace: [LOT_PACE], road: false },
        ],
        arcsOut,
        0,
        { p: lot.barrier.p, d, out: true },
      );
      return w;
    });
  }

  // ———————————————————————— 一天的车 ————————————————————————

  /**
   * 排今天的外来车：港口每一趟外来集卡（GateTrip）、机场每一次收货口装卸（DockVisit）。两个设施的货车等候区在道路网的停车场里找
   * （等候区不在开往设施的路线上的区域，车就不进等候区，直接来）。
   */
  setDay(port: GateTrip[], air: { docks: { x: number; z: number }[]; visits: DockVisit[] }, seed: number): void {
    drain(this.daySteps(port, air, seed));
  }

  /**
   * 三维层换了一天、港口和机场还在分段排：路上先不画外来货车（旧的一天的车不再开进空着的港口），等 daySteps 排这一天。
   */
  hold(): void {
    this.waiting = true;
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = undefined;
    this.gen++;
    this.trucks = [];
    this.pend = [];
    this.next = 0;
    this.bars = new Map();
    this.stops = new Map();
    this.parks = [];
    this.entries = { NORTH: [], EAST: [] };
    this.exits = { NORTH: [], EAST: [] };
    this.lotUse = new Map();
  }

  /** 和 setDay 一样排一天，分成几段（港口、机场、物流园的车各一段）：先后、结果都和一口气排完一样 */
  /** at：分段排时此刻的显示时刻；给了就先把此刻以前要开的段分段排好再放出来（第一帧不用一下子全排） */
  *daySteps(port: GateTrip[], air: { docks: { x: number; z: number }[]; visits: DockVisit[] }, seed: number, at?: () => number): Steps {
    this.waiting = true;
    const parkTrips = this.parkTrips;
    this.last = { port, air, seed };
    this.lotUse = new Map();
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = undefined;
    this.trucks = [];
    this.bars = new Map();
    this.ways.clear();
    Object.assign(this.stats, { port: 0, portLot: 0, air: 0, airLot: 0, night: 0, park: 0 });
    this.entries = { NORTH: [], EAST: [] };
    this.exits = { NORTH: [], EAST: [] };
    this.parks = [];
    this.stops = new Map();
    const lots = this.net.lots;
    const portLot = lots.find((l) => l.id === 'PORT:hold');
    const airLot = lots.find((l) => l.id === 'AIR:hold');
    this.planPort(port, portLot, seed);
    yield;
    yield* this.planAir(air, airLot, seed);
    yield;
    this.planPark(parkTrips, seed);
    yield;
    this.gateOrder();
    this.trucks.sort((a, b) => a.t0 - b.t0);
    this.lq = new Map();
    this.onLane = new Map();
    Object.assign(this.follow, { legs: 0, late: 0, maxLate: 0 });
    this.pend = this.trucks
      .flatMap((tk) => tk.legs.filter((l) => l.drive))
      .map((l, i) => ({ l, i }))
      .sort((a, b) => a.l.t0 - b.l.t0 || a.i - b.i)
      .map((x) => x.l);
    this.next = 0;
    // 第一帧要画到此刻：此刻（再往后半分钟）以前出发的段先一段一段排好（先后和用到时再排一样），再放出来
    if (at) {
      for (;;) {
        const pend = this.pend[this.next];
        if (!pend || pend.t0 > at() + 30) break;
        // 和 ensure 一样：先挪到下一段再排这一段
        this.next++;
        this.build(pend);
        yield;
      }
    }
    const gen = ++this.gen;
    if (typeof window !== 'undefined') setTimeout(() => this.warm(gen), 300);
    this.waiting = false;
    // 分段排的时候物流园的计划又变了：和一口气排完以后再变一样，稍等一下按最新的重排
    if (this.parkTrips !== parkTrips) this.setPark(this.parkTrips);
  }

  /** 物流园的计划变了（换了一天、调度台改了预约）：外来的车跟着重排（稍等一下一起排；换一天时由 setDay 排） */
  setPark(trips: readonly ParkTrip[]): void {
    this.parkTrips = trips;
    if (!this.last || this.waiting) return;
    if (this.parkTimer) clearTimeout(this.parkTimer);
    const run = () => {
      this.parkTimer = undefined;
      if (this.last) this.setDay(this.last.port, this.last.air, this.last.seed);
    };
    if (typeof window === 'undefined') run();
    else this.parkTimer = setTimeout(run, 150);
  }

  /** 等候区里的通道：进车位、出车位的车一次一辆（从过道闸到停好、从车位开出到过道闸的时段） */
  private lotUse = new Map<string, [number, number][]>();
  private lotFree(id: string, a: number, b: number): boolean {
    return (this.lotUse.get(id) ?? []).every(([x, y]) => y + 3 <= a || b + 3 <= x);
  }
  private lotAdd(id: string, a: number, b: number): void {
    const l = this.lotUse.get(id) ?? [];
    l.push([Math.min(a, b), Math.max(a, b)]);
    this.lotUse.set(id, l);
  }

  private markBar(key: string, t0: number, t1: number): void {
    const list = this.bars.get(key) ?? [];
    list.push(t0, t1);
    this.bars.set(key, list);
  }

  /** 一段路上的行驶（和仿真车一样的速度曲线）；路线 w 的道路部分在 [uA, uB] */
  private static road(dp: DrivePath, t0: number, t1: number, free0: boolean, free1: boolean, uA: number, uB: number, box?: number): XLeg {
    const t2 = Math.max(t1, t0 + 2);
    return { t0, t1: t2, track: dp.track, u: dp.uStart, rev: false, site: 0, uA, uB, ...(box !== undefined ? { box } : {}), drive: { dp, t2, free0, free1 } };
  }
  /** 排一段路上的速度曲线（红灯前看登记的车排队），排好了登记自己停在哪个灯前 */
  private build(l: XLeg): void {
    const d = l.drive;
    if (!d) return;
    const m = driveOn(d.dp, l.t0, d.t2, DYN.heavy, d.free0, d.free1, undefined, d.dp.track.len > 600 ? 10 : 3, this.hook(d.dp));
    delete l.drive;
    Object.assign(l, { tu: m.tu, tuS: m.tuS, tv: m.tv, ...(m.brake ? { brake: m.brake } : {}), ...(m.blink ? { blink: m.blink } : {}) });
    if (d.dp.spans.length && l.tk && !ExtTrucks.noFollow) {
      this.followUp(l, d.dp.spans, l.tk);
      this.register(l, d.dp.spans, l.tk);
    }
  }

  /** 路程 u 在段里最晚什么时候还没超过（停着的时段取最后；到不了返回 Infinity） */
  private static lastAt(l: XLeg, u: number): number {
    const tu = l.tu as number[];
    const ts = l.tuS as number[];
    const tv = l.tv;
    const n = tu.length;
    if (u >= (ts[n - 1] as number)) return Infinity;
    if (u < (ts[0] as number)) return -Infinity;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if ((ts[m] as number) <= u) lo = m;
      else hi = m;
    }
    const dt = (tu[hi] as number) - (tu[lo] as number);
    const du = u - (ts[lo] as number);
    if (dt <= 1e-9) return tu[hi] as number;
    if (!tv) return (tu[lo] as number) + (dt * du) / Math.max(1e-9, (ts[hi] as number) - (ts[lo] as number));
    const v0 = tv[lo] as number;
    const a = ((tv[hi] as number) - v0) / dt;
    const tau = Math.abs(a) < 1e-9 ? du / Math.max(1e-9, v0) : (Math.sqrt(Math.max(0, v0 * v0 + 2 * a * du)) - v0) / a;
    return (tu[lo] as number) + Math.max(0, Math.min(dt, tau));
  }
  /** 按单调的 xs 线性插值（两头按最后一段外推） */
  private static interp(xs: readonly number[], ys: readonly number[], x: number): number {
    const n = xs.length;
    const sg = (xs[n - 1] as number) >= (xs[0] as number) ? 1 : -1;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (sg * (xs[m] as number) <= sg * x) lo = m;
      else hi = m;
    }
    const k = lo;
    const x0 = xs[k] as number;
    const x1 = xs[k + 1] as number;
    return (ys[k] as number) + (((ys[k + 1] as number) - (ys[k] as number)) * (x - x0)) / (x1 - x0 || 1e-9);
  }

  /** 排好的段在每条车道上的那一截记下来（在这一截里的时段按速度曲线算） */
  private register(l: XLeg, spans: readonly RoadSpan[], tk: XTruck): void {
    const L = this.len(tk);
    for (const sp of spans) {
      const t0 = ExtTrucks.firstAt(l, sp.us[0] as number);
      const t1 = ExtTrucks.firstAt(l, (sp.us[sp.us.length - 1] as number) + L + 20);
      if (!Number.isFinite(t0)) continue;
      const key = `${sp.line}:${sp.dir}:${sp.lane}`;
      const list = this.onLane.get(key) ?? [];
      list.push({ leg: l, sp, t0, t1: Number.isFinite(t1) ? t1 : l.t1, L });
      this.onLane.set(key, list);
    }
  }
  /** 路程 u 在段里最早什么时候到（到不了返回 Infinity，一开始就过了返回段的开始时刻） */
  private static firstAt(l: XLeg, u: number): number {
    const ts = l.tuS as number[];
    const tu = l.tu as number[];
    const n = ts.length;
    if (u <= (ts[0] as number)) return l.t0;
    if (u > (ts[n - 1] as number)) return Infinity;
    // 第一个 ts ≥ u 的点 k：在第 k − 1 到 k 这一截里第一次到 u（停着的时段在 ts 相等的点上，不影响「最早」）
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if ((ts[m] as number) < u) lo = m;
      else hi = m;
    }
    const dt = (tu[hi] as number) - (tu[lo] as number);
    const du = u - (ts[lo] as number);
    if (dt <= 1e-9) return tu[hi] as number;
    const tv = l.tv;
    if (!tv) return (tu[lo] as number) + (dt * du) / Math.max(1e-9, (ts[hi] as number) - (ts[lo] as number));
    const v0 = tv[lo] as number;
    const a = ((tv[hi] as number) - v0) / dt;
    const tau = Math.abs(a) < 1e-9 ? du / Math.max(1e-9, v0) : (Math.sqrt(Math.max(0, v0 * v0 + 2 * a * du)) - v0) / a;
    return (tu[lo] as number) + Math.max(0, Math.min(dt, tau));
  }

  /**
   * 跟车：这一段（刚排好的速度曲线）在每条车道上和已经排好的车比——先过两车共同那一截起点的是前车；后过的车如果会从后面追上
   * 这一段，这一段就在那一截的起点前等它过去（汇入让行）。前车的车头往后推 FOLLOW_TAU 秒、再让一个车长加空当是这一段的车头不能越过的线：
   * 把这一段的速度曲线按时间往后拖（w(t) ≤ t：此刻开到原来 w(t) 时刻的位置），再按快 CATCH_UP 倍追回来；
   * 后面停着等的那一段（等候区、排队点）缩短来接住晚到的时间，接不住的部分不跟（宁可叠一下，不打乱港口、机场排好的时刻）
   */
  private followUp(f: XLeg, spans: readonly RoadSpan[], tk: XTruck): void {
    if (!f.tu || !f.tuS || f.tu.length < 2) return;
    const Lf = this.len(tk);
    const t0 = f.t0;
    const t2 = f.t1;
    // 前车：每条车道上共同那一截 [cs, ce]（行进方向的坐标）
    const leads: { E: LaneUse; sp: RoadSpan; cs: number; ce: number; yieldTo: boolean; w0: number; w1: number }[] = [];
    /** 先过共同那一截起点、后面有排定了的车跟来的（看要不要让） */
    const behindC: { E: LaneUse; sp: RoadSpan; cs: number; ce: number; tE: number; tf: number; w1: number }[] = [];
    for (const sp of spans) {
      const key = `${sp.line}:${sp.dir}:${sp.lane}`;
      let list = this.onLane.get(key);
      if (!list) continue;
      // 早就开走了的车不用再比（段按开始的先后排，后排的段只会更晚）
      if (list.length > 48) {
        list = list.filter((x) => x.t1 > t0 - 120);
        this.onLane.set(key, list);
      }
      const dir = sp.dir;
      const a0 = dir * (sp.ss[0] as number);
      const a1 = dir * (sp.ss[sp.ss.length - 1] as number);
      const tf0 = ExtTrucks.firstAt(f, sp.us[0] as number);
      const tf1 = ExtTrucks.firstAt(f, sp.us[sp.us.length - 1] as number);
      if (!Number.isFinite(tf0)) continue;
      for (const E of list) {
        if (E.leg === f || E.t1 < tf0 - 30 || E.t0 > (Number.isFinite(tf1) ? tf1 : t2) + 300) continue;
        const b0 = dir * (E.sp.ss[0] as number);
        const b1 = dir * (E.sp.ss[E.sp.ss.length - 1] as number);
        const cs = Math.max(a0, b0);
        const ce = Math.min(a1, b1);
        if (ce - cs < 5) continue;
        const tf = ExtTrucks.firstAt(f, ExtTrucks.interp(sp.ss, sp.us, dir * cs));
        const tE = ExtTrucks.firstAt(E.leg, ExtTrucks.interp(E.sp.ss, E.sp.us, dir * cs));
        if (!Number.isFinite(tf) || !Number.isFinite(tE)) continue;
        const tEnd = ExtTrucks.firstAt(E.leg, ExtTrucks.interp(E.sp.ss, E.sp.us, dir * (ce + E.L + 25)));
        const w1 = (Number.isFinite(tEnd) ? tEnd : E.leg.t1) + FOLLOW_TAU + 5;
        if (tE <= tf) {
          leads.push({ E, sp, cs, ce, yieldTo: false, w0: tE + FOLLOW_TAU - 5, w1 });
          continue;
        }
        // 这一段先过起点：后面那辆（排定了的）会不会追上来，会就让它先过。按跟上前车以后的速度曲线看（前面堵着、
        // 这一段慢下来，后面那辆会追上）；半分钟以后才到起点的、起点中间终点都落后 12 秒以上的不让（让了要在路上停太久）
        const behind = (c: number) => ExtTrucks.firstAt(E.leg, ExtTrucks.interp(E.sp.ss, E.sp.us, dir * c)) - ExtTrucks.firstAt(f, ExtTrucks.interp(sp.ss, sp.us, dir * c));
        if (tE - tf > 30 || (tE - tf > 12 && behind((cs + ce) / 2) > 12 && behind(ce) > 12)) continue;
        behindC.push({ E, sp, cs, ce, tE, tf, w1 });
      }
    }
    if (!leads.length && !behindC.length) return;
    /** 后面那辆 E 会不会追上这一段（按 f 此刻的速度曲线）：E 的车头到了这一段的车尾后面 FOLLOW_GAP 以内，而这一段还在共同那一截里 */
    const catches = (c: (typeof behindC)[number]): boolean => {
      const dir = c.sp.dir;
      for (let t = c.tE; t < c.tE + 900; t += 2) {
        const ue = leadState(c.E.leg, t, this.ls).u;
        const ce2 = dir * ExtTrucks.interp(c.E.sp.us, c.E.sp.ss, ue);
        if (ce2 > c.ce) break;
        const uf = leadState(f, t, this.ls).u;
        const cf = dir * ExtTrucks.interp(c.sp.us, c.sp.ss, uf);
        if (cf > c.ce + Lf) break;
        if (cf - Lf - FOLLOW_GAP < ce2 && cf >= c.cs) return true;
      }
      return false;
    };
    const yielded = new Set<(typeof behindC)[number]>();
    // 先跟前车（不改这一段，只算出新的速度曲线），再看后面的车会不会追上来；追上来的让它先过，重算（最多三轮）
    for (let round = 0; round < 3; round++) {
      const trial = this.followApply(f, tk, leads, t0, t2, false);
      const keep = { tu: f.tu, tuS: f.tuS, tv: f.tv, t1: f.t1 };
      if (trial) Object.assign(f, { tu: trial.tu, tuS: trial.tuS, tv: trial.tv, t1: trial.t1 });
      let added = false;
      for (const c of behindC) {
        if (yielded.has(c) || !catches(c)) continue;
        yielded.add(c);
        leads.push({ E: c.E, sp: c.sp, cs: c.cs, ce: c.ce, yieldTo: true, w0: c.tf - 30, w1: c.w1 });
        added = true;
      }
      Object.assign(f, keep);
      if (!added) break;
    }
    if (!leads.length) return;
    this.followApply(f, tk, leads, t0, t2, true);
  }

  /**
   * 按前车（和要让的后车）把这一段的速度曲线往后拖：commit = false 只算不改（返回新的采样点；没被拖住、或者后面接不住晚到的返回 undefined）
   */
  private followApply(f: XLeg, tk: XTruck, leads: { E: LaneUse; sp: RoadSpan; cs: number; ce: number; yieldTo: boolean; w0: number; w1: number }[], t0: number, t2: number, commit: boolean): { tu: number[]; tuS: number[]; tv: number[]; t1: number } | undefined {
    if (!leads.length || !f.tu || !f.tuS) return undefined;
    // 车头不能越过的线：此刻对应这一段原来的哪个时刻（W_env）
    const wEnv = (t: number): number => {
      let w = Infinity;
      for (const x of leads) {
        if (t < x.w0 || t > x.w1) continue;
        const dir = x.sp.dir;
        const ue = leadState(x.E.leg, t - FOLLOW_TAU, this.ls).u;
        const tE0 = x.E.leg.t0;
        let c = dir * ExtTrucks.interp(x.E.sp.us, x.E.sp.ss, ue);
        if (t - FOLLOW_TAU < tE0 || c < x.cs) {
          // 前车还没开到共同那一截：让行的在起点前等；本来就在前面的不管
          if (!x.yieldTo) continue;
          c = x.cs - 2 + x.E.L + FOLLOW_GAP;
        } else if (c > x.ce + x.E.L + 25) continue;
        const uLim = ExtTrucks.interp(x.sp.ss, x.sp.us, dir * (c - x.E.L - FOLLOW_GAP));
        w = Math.min(w, ExtTrucks.lastAt(f, uLim));
      }
      return w;
    };
    // 后面接得住多少晚到：下一段是停着的就缩短它；没有下一段（开出区域）随便晚
    const k = tk.legs.indexOf(f);
    const next = tk.legs[k + 1];
    const slack = !next ? Infinity : !next.tu && !next.drive ? Math.max(0, next.t1 - next.t0 - 1) : 0;
    const h = 1;
    const ws: number[] = [];
    const ts: number[] = [];
    // 只在有前车的时段里按秒算（之前、之后没被拖住的时候照原来的）
    const winA = Math.max(t0, Math.min(...leads.map((x) => x.w0)));
    const winB = Math.max(...leads.map((x) => x.w1));
    if (winA >= t2) return;
    let w = winA;
    let dev = false;
    let firstDev = -1;
    for (let t = winA; ; t += h) {
      const we = t <= t2 ? wEnv(t) : t2;
      // 还没被拖住、前车离得还远：那条线只会往前挪，这几秒都碰不到，跳过去
      if (!dev && t < t2 && we > t + 4) {
        // 不跳过还没开始的前车（它开始管的时候那条线可能一下子挪到后面）
        let jump = Math.min(we - t - 3, 60, t2 - t);
        for (const x of leads) if (x.w0 > t) jump = Math.min(jump, x.w0 - t);
        if (jump > h) {
          t += Math.floor(jump / h) * h - h;
          w = t + h;
          continue;
        }
      }
      const lim = t <= t2 ? Math.min(t, we) : t2;
      // 开出区域的（后面没有段）不追：晚几秒开出视野没关系，追的时候还会撞上延长段上的前车
      let wk = Math.max(w, Math.min(lim, w + (Number.isFinite(slack) ? 1 + CATCH_UP : 1) * h));
      // 追不回来的部分不跟
      if (Number.isFinite(slack)) wk = Math.max(wk, t2 - slack - (1 + CATCH_UP) * (t2 - t));
      wk = Math.min(wk, t, t2);
      if (t - wk > 0.02) {
        dev = true;
        if (firstDev < 0) firstDev = ts.length;
      }
      ts.push(t);
      ws.push(wk);
      w = wk;
      if (t >= t2 && wk >= t2 - 1e-6) break;
      if (t > winB && t - wk < 1e-6) break;
      if (t > t2 + 3600) break;
    }
    if (!dev) return;
    // 新的采样点：原来的点到开始被拖住之前，之后每秒一个点（位置 = 原来 w 时刻的位置），追回来以后接原来的点
    const tu0 = f.tu;
    const ts0 = f.tuS;
    const tv0 = f.tv as number[];
    const iA = Math.max(0, firstDev - 2);
    const tA = ts[iA] as number;
    let iB = ts.length - 1;
    for (let i = ts.length - 1; i > firstDev; i--) {
      if ((ts[i] as number) - (ws[i] as number) > 0.02) break;
      iB = i;
    }
    const tB = ts[iB] as number;
    const nt: number[] = [];
    const nu: number[] = [];
    const nv: number[] = [];
    for (let i = 0; i < tu0.length && (tu0[i] as number) < tA - 1e-6; i++) {
      nt.push(tu0[i] as number);
      nu.push(ts0[i] as number);
      nv.push(tv0[i] as number);
    }
    const uAt = (tt: number) => leadState(f, tt, this.ls).u;
    const gu: number[] = [];
    for (let i = iA; i <= iB; i++) gu.push(uAt(ws[i] as number));
    for (let i = iA; i <= iB; i++) {
      const j = i - iA;
      const a = gu[Math.max(0, j - 1)] as number;
      const b = gu[Math.min(gu.length - 1, j + 1)] as number;
      const span = (ts[Math.min(iB, i + 1)] as number) - (ts[Math.max(iA, i - 1)] as number);
      nt.push(ts[i] as number);
      nu.push(gu[j] as number);
      nv.push(span > 1e-9 ? Math.max(0, (b - a) / span) : 0);
    }
    const late = Math.max(0, tB - t2);
    // 后面紧接着要开的段（排队挪车位、进场）接不住晚到：这一段不跟
    if (late > 0.05 && next && (next.tu || next.drive)) return;
    for (let i = 0; i < tu0.length; i++) {
      if ((tu0[i] as number) <= (ws[iB] as number) + 1e-6) continue;
      nt.push((tu0[i] as number) + (tB - (ws[iB] as number)));
      nu.push(ts0[i] as number);
      nv.push(tv0[i] as number);
    }
    if (!commit) return { tu: nt, tuS: nu, tv: nv, t1: t2 + late };
    // 刹车灯：拖住的那一截里减速、停着的时候亮；转向灯按拖过的时刻挪
    const brake: number[] = [];
    for (const [a, b] of pairs(f.brake)) if (b < tA) brake.push(a, b);
    for (let i = 1; i < nt.length; i++) if ((nt[i] as number) >= tA && (nt[i] as number) <= tB && ((nv[i] as number) < (nv[i - 1] as number) - 0.002 || (nv[i] as number) < 0.02)) brake.push(nt[i - 1] as number, nt[i] as number);
    for (const [a, b] of pairs(f.brake)) if (a > (ws[iB] as number)) brake.push(a + (tB - (ws[iB] as number)), b + (tB - (ws[iB] as number)));
    const back = (x: number) => {
      // 原来的时刻 x 现在对应的时刻
      if (x < tA) return x;
      for (let i = iA; i <= iB; i++) if ((ws[i] as number) >= x) return ts[i] as number;
      return x + (tB - (ws[iB] as number));
    };
    const blink: number[] = [];
    for (let i = 0; f.blink && i + 2 < f.blink.length + 1; i += 3) blink.push(back(f.blink[i] as number), back(f.blink[i + 1] as number), f.blink[i + 2] as number);
    f.tu = nt;
    f.tuS = nu;
    f.tv = nv;
    f.t1 = t2 + late;
    if (brake.length) f.brake = mergePairs(brake);
    if (blink.length) f.blink = blink;
    if (late > 0) {
      if (next) next.t0 = Math.min(next.t1, f.t1);
      else tk.t1 = Math.max(tk.t1, f.t1);
    }
    this.follow.legs++;
    this.follow.late += late;
    this.follow.maxLate = Math.max(this.follow.maxLate, late);
    return { tu: nt, tuS: nu, tv: nv, t1: f.t1 };
  }
  /** 一条路线上的信号灯排队：按停止线的位置认是哪个路口的哪条进口车道 */
  private hook(dp: DrivePath): QueueHook {
    const key = (i: number) => {
      const q = lightAt(dp, i);
      return q ? `${q.j}:${Math.round(q.x)}:${Math.round(q.z)}` : `?${i}`;
    };
    return {
      ahead: (i, t) => {
        let k = 0;
        let after = -Infinity;
        for (const e of this.lq.get(key(i)) ?? []) {
          if (e.a <= t + 1 && e.b > t - 0.3) {
            k++;
            after = Math.max(after, e.b);
          }
        }
        return { k, after };
      },
      stopped: (i, _k, a, b) => {
        const kk = key(i);
        const list = this.lq.get(kk) ?? [];
        list.push({ a, b });
        this.lq.set(kk, list);
      },
    };
  }
  /** 把开始时刻不晚于 t 的路上的段都排好（按开始的先后） */
  private ensure(t: number): void {
    const pend = this.pend;
    while (this.next < pend.length && (pend[this.next] as XLeg).t0 <= t) this.build(pend[this.next++] as XLeg);
  }
  /** 空闲时按先后接着往后排（每次十来毫秒），拖时间轴时不卡 */
  private warm(gen: number): void {
    if (typeof window === 'undefined' || gen !== this.gen) return;
    const start = performance.now();
    while (this.next < this.pend.length && performance.now() - start < 12) this.build(this.pend[this.next++] as XLeg);
    if (this.next < this.pend.length) setTimeout(() => this.warm(gen), 25);
  }
  private static still(track: Track, u: number, t0: number, t1: number, box?: number, rev = false): XLeg {
    return { t0, t1, track, u, rev, site: 1, uA: -Infinity, uB: Infinity, ...(box !== undefined ? { box } : {}) };
  }
  /** 场地里缓起缓停地沿折线开（港口的作业计划给的时段） */
  private static eased(track: Track, t0: number, t1: number, box?: number, u0 = 0): XLeg {
    const D = track.len - u0;
    const n = Math.max(8, Math.min(40, Math.ceil(D / 4)));
    const T = Math.max(1e-3, t1 - t0);
    const tu: number[] = [];
    const tuS: number[] = [];
    const tv: number[] = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      tu.push(t0 + f * T);
      tuS.push(u0 + D * ease(f));
      tv.push((D * 6 * f * (1 - f)) / T);
    }
    return { t0, t1, track, tu, tuS, tv, u: u0, rev: false, site: 1, uA: -Infinity, uB: Infinity, ...(box !== undefined ? { box } : {}) };
  }
  /**
   * 一辆车在路上要开多久：不等红灯的时间放宽 5%，加上每个信号灯平均等的。同一条路线上的车用时一样（车速曲线一样），
   * 前后两辆车的间隔一路上基本不变，不会追上前车、穿过去
   */
  private static span(dp: DrivePath, free0: boolean, free1: boolean): number {
    // 按同一个车速系数开要多久，再给每个信号灯加上速度曲线给还没过的灯预留的等灯时间：
    // 不管路线上有几个灯，到第一个灯之前都正好按 V_ROAD 开（同一段路上的车车速一样，不会追上前车）
    const key = (free0 ? 2 : 0) + (free1 ? 1 : 0);
    let c = SPANS.get(dp);
    if (!c) SPANS.set(dp, (c = []));
    return (c[key] ??= cruiseTime(dp, V_ROAD, DYN.heavy, free0, free1, dp.track.len > 600 ? 10 : 3) + dp.lights.length * LIGHT_WAIT);
  }
  /** 从高速口外开进来的车：在延长段远处出现的时刻（同一个高速口前后两辆至少隔 GAP 秒，不然一路叠在一起） */
  private entries: Record<End, number[]> = { NORTH: [], EAST: [] };
  private entryOk(end: End, t: number): boolean {
    return this.entries[end].every((x) => Math.abs(x - t) >= GAP);
  }
  /** 开出区域的车：开到区域边上的时刻（港口、机场开出来的车并到同一条高速上，也要前后错开） */
  private exits: Record<End, number[]> = { NORTH: [], EAST: [] };
  private exitOk(end: End, t: number): boolean {
    return this.exits[end].every((x) => Math.abs(x - t) >= GAP);
  }
  /** 进等候区停好的时刻（不同高速口来的车在进场路上汇到一起：前后至少隔 LOT_GAP 秒） */
  private parks: number[] = [];
  private parkOk(t: number): boolean {
    return this.parks.every((x) => Math.abs(x - t) >= LOT_GAP);
  }
  /** 等候区进场道闸前停车的时刻（不同车位的车开进车位的路程不一样，停好的时刻错开了，道闸前也要错开 BAR_GAP 秒） */
  private stops = new Map<string, number[]>();
  private stopOk(lot: string, t: number): boolean {
    return (this.stops.get(lot) ?? []).every((x) => Math.abs(x - t) >= BAR_GAP);
  }
  private addStop(lot: string, t: number): void {
    const list = this.stops.get(lot) ?? [];
    list.push(t);
    this.stops.set(lot, list);
  }

  /** 等候区的车位占用：每个车位一串 [开始, 结束]；找一个这段时间都空着的车位 */
  private static freeBay(busy: [number, number][][], a: number, b: number, r: () => number): number {
    // 车位挨着（4 米多一个）：开进、开出时车身会扫到旁边停着的车，旁边两个车位这段时间也要空着（都占着才退一步只看自己）
    const free = (i: number) => (busy[i] ?? []).every(([x, y]) => b <= x || y <= a);
    let ok = busy.map((_, i) => (free(i) && free(i - 1) && free(i + 1) ? i : -1)).filter((i) => i >= 0);
    if (!ok.length) ok = busy.map((_, i) => (free(i) ? i : -1)).filter((i) => i >= 0);
    return ok.length ? (ok[Math.floor(r() * ok.length)] as number) : -1;
  }

  /** 进等候区（高速口 → 道闸 → 车位），在 tPark 停好：这几段、车位上停着用的路径、道闸抬起的时段（排定了再记） */
  private intoLot(lot: Lot, bay: number, end: End, facility: string, tPark: number, box?: number): { legs: XLeg[]; track: Track; t0: number; bar: [string, number, number] } | undefined {
    const w = this.lotIn(lot, bay, end, facility);
    if (!w || w.bar < 0) return undefined;
    const [p1, p2] = halves(w);
    const T2 = driveTime(p2, V_ROAD);
    const tGo = tPark - T2;
    const tStop = tGo - BAR_WAIT;
    const T1 = ExtTrucks.span(p1, true, false);
    return {
      legs: [ExtTrucks.road(p1, tStop - T1, tStop, true, false, -Infinity, w.roadB, box), ExtTrucks.still(p1.track, p1.track.len, tStop, tGo, box), { ...ExtTrucks.road(p2, tGo, tPark, false, false, -Infinity, -Infinity, box), site: 1 }],
      track: p2.track,
      t0: tStop - T1,
      bar: [`${lot.id}:in`, tStop + 0.8, tGo + 12],
    };
  }

  /** 车位上停着的车用的路径（从道闸开进车位的那一段，车身落在车位里） */
  private bayTrack(lot: Lot, bay: number, end: End, facility: string): Track | undefined {
    const w = this.lotIn(lot, bay, end, facility);
    return w && w.bar >= 0 ? halves(w)[1].track : undefined;
  }

  /** 出等候区（车位 → 道闸 → 回到路线、开到设施门前 tail 的终点），在 tArrive 到：这几段、离开车位的时刻、道闸抬起的时段 */
  private outOfLot(lot: Lot, bay: number, facility: string, cut: number, tail: V3[], key: string, tArrive: number, box?: number, endCut = 0): { legs: XLeg[]; tLeave: number; bar: [string, number, number]; dp: DrivePath } | undefined {
    const w = this.lotOut(lot, bay, facility, cut, tail, key);
    if (!w || w.bar < 0) return undefined;
    const [p1, p2full] = halves(w);
    // endCut：闸口排队时停在排队点后面几个车位（路线的终点往回 endCut 米）
    const p2 = endCut > 0 ? sub(w.dp, w.bar, w.dp.track.len - endCut, 25) : p2full;
    const a = Math.max(0, w.bar - 25);
    const T2 = ExtTrucks.span(p2, false, false);
    const tGo = tArrive - T2;
    const tStop = tGo - BAR_WAIT;
    const T1 = driveTime(p1, V_ROAD);
    return {
      legs: [{ ...ExtTrucks.road(p1, tStop - T1, tStop, false, false, Infinity, Infinity, box), site: 1 }, ExtTrucks.still(p1.track, p1.track.len, tStop, tGo, box), ExtTrucks.road(p2, tGo, tArrive, false, false, w.roadA - a, w.roadB - a, box)],
      tLeave: tStop - T1,
      bar: [`${lot.id}:out`, tStop + 0.8, tGo + 12],
      dp: w.dp,
    };
  }

  // —— 港口 ——

  private planPort(trips: GateTrip[], lot: Lot | undefined, seed: number): void {
    if (!trips.length) return;
    const f = FRAMES.port;
    const W = (p: { x: number; z: number }) => {
      const q = frameToWorld(f, p);
      return v3(q.x, 0, q.z);
    };
    const r = rng(seed * 4517 + 29);
    // 进闸车道的排队点、出闸车道的排队点（局部坐标，按港口的作业计划）；进港的方向是局部的 +z
    const qIn = new Map<number, { x: number; z: number }>();
    const qOut = new Map<number, { x: number; z: number }>();
    for (const t of trips) {
      const a = t.legs[0]?.pts?.[0];
      const lastPts = t.legs[t.legs.length - 1]?.pts;
      const b = lastPts?.[lastPts.length - 1];
      if (a && !qIn.has(t.inK)) qIn.set(t.inK, a);
      if (b && !qOut.has(t.outK)) qOut.set(t.outK, b);
    }
    // 闸口前分道：排队点后面 14 米是直的
    const fanIn = (k: number): V3[] => {
      const q = qIn.get(k) as { x: number; z: number };
      return [W({ x: q.x, z: q.z - 14 }), W(q)];
    };
    // lane：路上走哪条车道（前后两辆隔得太近时，后一辆走另一条车道，不会停到前车身上）
    const directIn = (end: End, k: number, lane = 0): Way | undefined =>
      this.cached(`pin:${end}:${k}:${lane}`, () => {
        const arcs = ExtTrucks.trimEnd(this.arcs(end, 'PORT'), PORT_FAN);
        if (!arcs.length) return undefined;
        const road = this.net.realize(arcs, () => lane);
        return this.way(
          [
            { pts: this.farIn(end, lane), pace: [1], road: true, far: `in:${end}:${lane}` },
            { pts: road.pts, pace: road.pace, road: true },
            { pts: fanIn(k), pace: [LOT_PACE], road: false },
          ],
          arcs,
          0,
          undefined,
          lane,
        );
      });
    const directOut = (k: number, end: End, lane = 0): Way | undefined =>
      this.cached(`pout:${k}:${end}:${lane}`, () => {
        const arcs = ExtTrucks.trimStart(this.arcs('PORT', end), PORT_FAN);
        if (!arcs.length) return undefined;
        const q = qOut.get(k) as { x: number; z: number };
        const road = this.net.realize(arcs, () => lane);
        // 引入段：出闸车道上排队点后面 25 米（车身还在那里）
        return this.way(
          [
            { pts: [W({ x: q.x, z: q.z + 25 }), W(q), W({ x: q.x, z: q.z - 12 })], pace: [LOT_PACE], road: false },
            { pts: road.pts, pace: road.pace, road: true },
            { pts: this.farOut(end, lane), pace: [1], road: true, far: `out:${end}:${lane}` },
          ],
          arcs,
          25,
          undefined,
          lane,
        );
      });
    const ends = (): End => (r() < 0.6 ? 'NORTH' : 'EAST');
    // 等候区：一个车位一串占用时段；夜里过夜的车（早上头几趟）、晚上来排明天的车
    const nb = lot?.bays.length ?? 0;
    const busy: [number, number][][] = Array.from({ length: nb }, () => []);
    const night = lot ? Math.max(1, Math.min(nb - 1, Math.round(nb * 0.4))) : 0;
    // 先定每一趟从哪个高速口来、到哪个高速口去、进不进等候区（固定的抽签顺序）；直接来的车在高速口出现的时刻先登记，
    // 进等候区的车出现的时刻可以挪，挪开和别的车太近的
    const plan = trips.map((trip, idx) => ({ end: ends(), endOut: ends(), viaLot: !!lot && (idx < night || r() < 0.3), lead: (15 + r() * 50) * 60 }));
    // 直接来的车：按在高速口出现的先后，和同一个高速口前一辆隔不到 GAP 秒的走另一条车道
    const laneIn = new Map<number, number>();
    for (const e of ['NORTH', 'EAST'] as End[]) {
      const list = trips
        .map((trip, idx) => ({ idx, pl: plan[idx] as (typeof plan)[number], trip }))
        .filter((x) => !x.pl.viaLot && x.pl.end === e)
        .map((x) => {
          const w = directIn(e, x.trip.inK);
          return { idx: x.idx, t: w ? x.trip.t0 - ExtTrucks.span(w.dp, true, false) : NaN };
        })
        .filter((x) => Number.isFinite(x.t))
        .sort((a, b) => a.t - b.t);
      let prevT = -Infinity;
      let prevLane = 1;
      for (const x of list) {
        const lane = x.t - prevT < GAP ? 1 - prevLane : 0;
        laneIn.set(x.idx, lane);
        prevT = x.t;
        prevLane = lane;
        this.entries[e].push(x.t);
      }
    }
    // 闸口排队：每条进闸车道上的车按先后，每辆车离开每个车位的时刻（0 = 道闸前，1 = 排队点，2、3……往后每 20 米一个）
    const gateLanes = new Map<number, number[][]>();
    // 出港：按出闸的先后，前后两辆至少隔 GAP 秒开走（在出闸的排队点多等一会儿，最多 150 秒，同一条出闸车道上后一辆到之前一定开走）；
    // 还是太近的走另一条车道
    const depOf0 = ExtTrucks.spaced(trips.map((t) => t.t1));
    const depOf = trips.map((t, i) => {
      const nextSame = trips.filter((u) => u.outK === t.outK && u.t1 > t.t1).reduce((m, u) => Math.min(m, u.t1), Infinity);
      return Math.max(t.t1, Math.min(depOf0[i] as number, nextSame - 25));
    });
    const laneOut = ExtTrucks.lanes(depOf);
    // 等候区的路口（进出场的路接主路的地方）：每辆车直接来的话经过那里的时刻（按这条路线的平均车速估）。进等候区拐进去、
    // 从等候区出来并进主路的车挑时刻时和它们错开：后面有车要过来就不拐、不并（换个时刻，再不行就不进等候区，直接来），不让直行的车撞上。
    // 拐进去的车早到了会在进场路上慢慢挪到道闸前（最多一分半钟，车尾还在路口里）：这一段时间里都不能有直行的车过来
    const jPt = lot ? this.net.lines[lot.line]?.pts[0] : undefined;
    const uNear = new Map<Track, number>();
    const passJ = trips.map((trip, idx) => {
      const pl = plan[idx];
      if (!jPt || !pl) return Number.NaN;
      const w = directIn(pl.end, trip.inK, laneIn.get(idx) ?? 0);
      if (!w) return Number.NaN;
      const tr = w.dp.track;
      let uj = uNear.get(tr);
      if (uj === undefined) {
        uj = Number.NaN;
        let best = 14;
        for (let i = 0; i < tr.pts.length; i++) {
          const q = tr.pts[i] as V3;
          const d = Math.hypot(q.x - jPt.x, q.z - jPt.z);
          if (d < best) {
            best = d;
            uj = tr.cum[i] as number;
          }
        }
        uNear.set(tr, uj);
      }
      if (!Number.isFinite(uj) || uj < w.dp.uStart) return Number.NaN;
      const T = ExtTrucks.span(w.dp, true, false);
      return trip.t0 - T + T * ((uj - w.dp.uStart) / Math.max(1, tr.len - w.dp.uStart));
    });
    /** 进出等候区的车在路口拐进去、并出来的时刻（彼此隔 20 秒以上） */
    const lotJ: number[] = [];
    const jOk = (t: number, idx: number, before: number, after: number) => passJ.every((p, j) => j === idx || !(p > t - before && p < t + after)) && lotJ.every((p) => Math.abs(p - t) > 20);
    trips.forEach((trip, idx) => {
      const p0 = trip.legs[0];
      const pIn = qIn.get(trip.inK);
      const pl = plan[idx] as (typeof plan)[number];
      if (!p0?.pts || !pIn) return;
      const slot = trip.t0;
      const boxIn = trip.load ? undefined : trip.box;
      const boxOut = trip.load ? trip.box : undefined;
      const legs: XLeg[] = [];
      const end = pl.end;
      let came = false;
      // 到的时候进闸车道上前面还有几辆没过道闸：停在它们后面（每 20 米一个车位，最多排到排队点后面 80 米）
      const laneQ = gateLanes.get(trip.inK) ?? [];
      const ahead = laneQ.filter((lv) => (lv[0] as number) > slot);
      const pred = ahead[ahead.length - 1];
      const m0 = Math.min(5, Math.max(1, ahead.length));
      const endCut = QUEUE_STEP * (m0 - 1);
      let full: DrivePath | undefined;
      // —— 来：先在等候区等的（夜里过夜的从 0 点就停在车位上） ——
      if (pl.viaLot && lot) {
        const exitKey = `p${trip.inK}`;
        // 先按 0 号车位估出离开车位的时刻，找这段时间空着的车位，再按那个车位排
        const probe = this.outOfLot(lot, 0, 'PORT', PORT_FAN, fanIn(trip.inK), exitKey, slot, boxIn);
        const tPark0 = probe ? (idx < night ? 0 : probe.tLeave - pl.lead) : 0;
        const bay = probe ? ExtTrucks.freeBay(busy, tPark0 - 400, probe.tLeave + 90, r) : -1;
        let out = bay >= 0 ? this.outOfLot(lot, bay, 'PORT', PORT_FAN, fanIn(trip.inK), exitKey, slot, boxIn, endCut) : undefined;
        // 出等候区：和前后开出去的车隔开（过道闸以后还要沿进出场的路开到路口、等着并进主路，90 秒内不放第二辆）；隔不开就不进等候区，直接从高速口来
        if (out && !this.lotFree(lot.id, out.tLeave, out.bar[2] + 90)) out = undefined;
        // 出等候区、并进主路的时刻（过道闸以后开完进出场的路）：前后 15～25 秒内有直行的车过来就不进等候区
        if (out && !jOk(out.bar[2] + 8, idx, 15, 25)) out = undefined;
        if (out && bay >= 0) {
          let into: ReturnType<ExtTrucks['intoLot']> | undefined;
          let tPark = 0;
          if (idx >= night) {
            // 在高速口出现的时刻和别的车错开（提前或推后最多 6 分钟）
            for (const dt of [0, 40, -40, 80, -80, 120, -120, 180, -180, 240, -240, 300, -300, 360]) {
              const c = this.intoLot(lot, bay, end, 'PORT', out.tLeave - pl.lead + dt, boxIn);
              if (!c) break;
              // 都不行就不进等候区（以前最后一个时刻硬排进去：和前一辆在进场路上排着、车尾压在主路上）
              if (this.entryOk(end, c.t0) && this.parkOk(out.tLeave - pl.lead + dt) && this.stopOk(lot.id, c.legs[0]?.t1 ?? 0) && this.lotFree(lot.id, c.bar[1] - 45, out.tLeave - pl.lead + dt) && jOk(c.legs[0]?.t1 ?? 0, idx, 120, 20)) {
                into = c;
                tPark = out.tLeave - pl.lead + dt;
                break;
              }
            }
          }
          const parkTrack = into?.track ?? this.bayTrack(lot, bay, end, 'PORT');
          if (parkTrack && (idx < night || into)) {
            (busy[bay] as [number, number][]).push([tPark - 120, out.tLeave + 60]);
            lotJ.push(out.bar[2] + 8);
            if (into) {
              lotJ.push(into.legs[0]?.t1 ?? 0);
              legs.push(...into.legs);
              this.markBar(...into.bar);
              this.lotAdd(lot.id, into.bar[1] - 45, tPark);
              this.entries[end].push(into.t0);
              this.parks.push(tPark);
              this.addStop(lot.id, into.legs[0]?.t1 ?? 0);
            }
            legs.push(ExtTrucks.still(parkTrack, parkTrack.len, tPark, out.tLeave, boxIn));
            legs.push(...out.legs);
            this.markBar(...out.bar);
            this.lotAdd(lot.id, out.tLeave, out.bar[2] + 90);
            came = true;
            full = out.dp;
            this.stats.portLot++;
            if (idx < night) this.stats.night++;
          }
        }
      }
      // —— 来：直接从高速口来 ——
      if (!came) {
        const w = directIn(end, trip.inK, laneIn.get(idx) ?? 0);
        if (!w) return;
        const dp = endCut > 0 ? sub(w.dp, w.dp.uStart, w.dp.track.len - endCut, w.dp.uStart) : w.dp;
        const T = ExtTrucks.span(dp, true, false);
        legs.push(ExtTrucks.road(dp, slot - T, slot, true, false, w.roadA, Math.min(w.roadB, dp.track.len), boxIn));
        if (pl.viaLot) this.entries[end].push(slot - T);
        full = w.dp;
      }
      const t0 = legs[0]?.t0 ?? slot;
      // —— 港口里：车位一个个往前挪 → 排队点 → 道闸前（前一辆过了杆才往前挪）→ 等交单 → 箱区 → 出闸（港口的作业计划给的时刻） ——
      const pq = p0.pts.map(W);
      const qTrack = makeTrack(pq);
      const inAt = trip.inAt;
      const leave: number[] = [inAt];
      const lastLeg = legs[legs.length - 1] as XLeg;
      let at: { track: Track; u: number } = { track: lastLeg.track, u: lastLeg.track.len };
      let t = slot;
      // 时间不够（港口排的进闸时刻太紧）就挪得快一点
      const need = GATE_UP + 9 * (m0 - 1);
      const k = Math.max(0.3, Math.min(1, (inAt - 0.5 - slot) / need));
      for (let m = m0; m >= 1; m--) {
        const dur = (m === 1 ? GATE_UP : 9) * k;
        const rest = (GATE_UP + 9 * (m - 1)) * k;
        const tFree = pred ? (pred[m - 1] ?? -Infinity) + (m === 1 ? 3 : 2) : -Infinity;
        const go = Math.max(t, Math.min(tFree, inAt - 0.5 - rest));
        leave[m] = go;
        if (go > t + 0.05) legs.push(ExtTrucks.still(at.track, at.u, t, go, boxIn));
        if (m >= 2 && full) {
          const len = full.track.len;
          const tr = sub(full, len - QUEUE_STEP * (m - 1), len - QUEUE_STEP * (m - 2), 25).track;
          legs.push(ExtTrucks.eased(tr, go, go + dur, boxIn, Math.min(25, tr.len - QUEUE_STEP)));
          at = { track: tr, u: tr.len };
        } else {
          legs.push(ExtTrucks.eased(qTrack, go, go + dur, boxIn));
          at = { track: qTrack, u: qTrack.len };
          m = 1;
        }
        t = go + dur;
      }
      legs.push(ExtTrucks.still(qTrack, qTrack.len, t, Math.max(t, p0.t1), boxIn));
      laneQ.push(leave);
      gateLanes.set(trip.inK, laneQ);
      let prev: Track = qTrack;
      for (let i = 1; i < trip.legs.length; i++) {
        const l = trip.legs[i] as GateTrip['legs'][number];
        if (l.hidden) legs.push({ ...ExtTrucks.still(prev, prev.len, l.t0, l.t1), hidden: true });
        else if (l.pts && l.pts.length > 1) {
          prev = makeTrack(l.pts.map(W));
          legs.push(l.still ? ExtTrucks.still(prev, l.u0 ?? 0, l.t0, l.t1, l.box) : ExtTrucks.eased(prev, l.t0, l.t1, l.box, l.u0 ?? 0));
        } else legs.push(ExtTrucks.still(prev, prev.len, l.t0, l.t1, l.box));
      }
      // —— 走：出闸后在排队点等前一辆出港的车走远一点，并回出港车道，开到高速口、开出区域 ——
      const out = directOut(trip.outK, pl.endOut, laneOut[idx]);
      if (out) {
        const dep = depOf[idx] as number;
        if (dep > trip.t1) legs.push(ExtTrucks.still(prev, prev.len, trip.t1, dep, boxOut));
        const T = ExtTrucks.span(out.dp, false, true);
        legs.push(ExtTrucks.road(out.dp, dep, dep + T, false, true, out.roadA, out.roadB, boxOut));
        this.exits[pl.endOut].push(dep + T);
      }
      this.push(trip.build ?? 0, legs, t0, r, trip.cab, trip.trailer);
      this.stats.port++;
    });
    // 晚上来排明天的车：闸口关了以后陆续开进等候区过夜
    if (lot && night > 0) {
      const lastSlot = trips[trips.length - 1]?.t0 ?? 21 * H;
      for (let k = 0; k < night; k++) {
        const tPark = Math.min(23.6 * H, Math.max(lastSlot + 40 * 60, 20.5 * H) + k * (35 + r() * 25) * 60);
        const bay = ExtTrucks.freeBay(busy, tPark - 120, DAY + 1, r);
        if (bay < 0) continue;
        const e = ends();
        const box = r() < 0.5 ? undefined : (BOXES[Math.floor(r() * BOXES.length)] as number);
        let into: ReturnType<ExtTrucks['intoLot']> | undefined;
        for (const dt of [0, 60, 120, 180, 240]) {
          into = this.intoLot(lot, bay, e, 'PORT', tPark + dt, box);
          if (!into || (this.entryOk(e, into.t0) && this.stopOk(lot.id, into.legs[0]?.t1 ?? 0))) break;
        }
        if (!into) continue;
        (busy[bay] as [number, number][]).push([tPark - 120, DAY + 1]);
        this.markBar(...into.bar);
        this.entries[e].push(into.t0);
        this.addStop(lot.id, into.legs[0]?.t1 ?? 0);
        const tIn = into.legs[into.legs.length - 1]?.t1 ?? tPark;
        this.push(0, [...into.legs, ExtTrucks.still(into.track, into.track.len, tIn, DAY + 60, box)], into.t0, r);
        this.stats.night++;
      }
    }
  }

  // —— 机场 ——

  /**
   * 机场：货代的车（货站计划排的提货车、送货车、整板卡车）。场里的一段按收货场引擎排的时刻表走（yard.sched：
   * 先到先进待命车道，场里一段一次一辆车调车，开过门、车头外摆，从司机一侧倒车靠台，靠稳了卷帘门才升起；拉出、沿驶离车道回到进场路），
   * 这里接上场外的路：从高速口外开来，沿进场路开到尽头的回车场掉头，往北开上来到场地的进场点（进场路在货站西边那一段）；
   * 走的时候从进场路的进场一侧开下去，到回车场掉头，再往北开出去。来早了先进机场的货车等候区。
   */
  private *planAir(air: { docks: { x: number; z: number }[]; visits: DockVisit[]; yard?: { key: string; plan: YardPlan; sched: YardSchedule; frame: YardFrame } }, lot: Lot | undefined, seed: number): Steps {
    const yard = air.yard;
    if (!air.visits.length || !yard) return;
    const f: Frame = FRAMES.airport;
    const W = (x: number, z: number) => {
      const q = frameToWorld(f, { x, z });
      return v3(q.x, 0, q.z);
    };
    const r = rng(seed * 7121 + 53);
    const L = BUILDS.plainDry.L;
    const tlOf = new Map(yard.sched.timelines.map((tl) => [tl.visit.id, tl] as const));
    // 场地的进场点、驶出点（进场路上，离陆侧墙 driveLen 米）：卡车场本地坐标 → 机场局部坐标（本地转了 180°）
    const yo = frameToLocal(f, yard.frame.origin);
    const inAt = { x: yo.x - yard.plan.xIn, z: yo.z + yard.plan.driveLen };
    const outAt = { x: yo.x - yard.plan.xOut, z: yo.z + yard.plan.driveLen };
    const node = { x: 1950, z: 1080 };
    /** 进场路尽头掉头（绕过分隔带的端头），沿出场一侧往北开到场地的进场点（gate：到进场点，hold：在进场道路场外那一头等） */
    let gate = { x: inAt.x, z: TERM_ZLAND };
    // 回车场的两个圈（机场局部坐标）：外圈给进场的车（进场一侧外车道 x = outAt.x → 出场一侧外车道 x = inAt.x），
    // 里圈给出去的车（两侧的里车道），同心、相隔 5 米
    const C = { x: node.x, z: node.z + AIR_C };
    const ring = (r: number): V3[] => Array.from({ length: 13 }, (_, k) => W(C.x + r * Math.cos(Math.PI - (k / 12) * Math.PI), C.z + r * Math.sin(Math.PI - (k / 12) * Math.PI)));
    const outerTurn: V3[] = [W(outAt.x, C.z - AIR_TURN - 7), W(outAt.x, C.z - 13), W(outAt.x - 1.5, C.z - 9), W(outAt.x - 3.3, C.z - 4.5), ...ring(AIR_RO), W(inAt.x + 3.3, C.z - 4.5), W(inAt.x + 1.5, C.z - 9), W(inAt.x, C.z - 13), W(inAt.x, C.z - 16)];
    const innerTurn: V3[] = [W(outAt.x + AIR_LW, C.z - 18), W(outAt.x + AIR_LW, C.z - 14), W(outAt.x + AIR_LW - 1.3, C.z - 7), ...ring(AIR_RI), W(inAt.x - AIR_LW + 1.3, C.z - 7), W(inAt.x - AIR_LW, C.z - 14), W(inAt.x - AIR_LW, C.z - 18)];
    // 进场的车开过驶出点外面（进场一侧外车道）的大概时刻：出去的车从驶出点并到里车道要横过这条车道，和它们错开
    const passAt = air.visits.map((v) => (v.id !== undefined ? tlOf.get(v.id) : undefined)).filter((tl): tl is YardTimeline => !!tl).map((tl) => Math.max(tl.visit.arrive, tl.joinAt) - 60 - 30);
    const goneAll = yard.sched.timelines.map((tl) => tl.goneAt).sort((a, b) => a - b);
    // 沿进场一侧的车道开到离进场点 14 米，最后这一段才挪到进场点（不斜穿过中线）
    const up = (from: V3[], atGate: boolean): V3[] => [...from, W(inAt.x, inAt.z + 16), W(inAt.x, inAt.z), ...(atGate ? [W(inAt.x, Math.min(inAt.z - 1, gate.z + 14)), W(gate.x, gate.z)] : [])];
    const toYard = (end: End, atGate: boolean): Way | undefined =>
      this.cached(`ayin:${end}:${atGate ? `${gate.x.toFixed(1)},${gate.z.toFixed(1)}` : 'h'}`, () => {
        const arcs = ExtTrucks.trimEnd(this.arcs(end, 'AIR'), AIR_TURN);
        if (!arcs.length) return undefined;
        const road = this.net.realize(arcs, () => 0);
        return this.way(
          [
            { pts: this.farIn(end), pace: [1], road: true, far: `in:${end}:0` },
            { pts: road.pts, pace: road.pace, road: true },
            { pts: up(outerTurn, atGate), pace: [LOT_PACE], road: false },
          ],
          arcs,
        );
      });
    /** 从驶出点沿进场一侧往南、并到里车道开到回车场，走里圈掉头，沿出场一侧的里车道往北（从排队的车旁边开过去），再开出去 */
    /** head：从收货场时刻表最后一刻的姿态接上（挂车车尾、牵引销、车头；给了就不共用缓存），没给按驶出点估 */
    const fromYard = (end: End, head?: { pts: V3[]; u: number }): Way | undefined => {
      const make = () => {
        const arcs = ExtTrucks.trimStart(this.arcs('AIR', end), node.z - inAt.z + 12);
        if (!arcs.length) return undefined;
        // 进场路（第一段）走里车道，后面的路照常
        const road = this.net.realize(arcs, (_l, i) => (i === 0 ? 1 : 0));
        return this.way(
          [
            // 从挂车车尾那里开始（场里的最后一刻牵引销在驶出点，车尾在它北边一个挂车长）
            { pts: [...(head?.pts ?? [W(outAt.x, outAt.z - 12.4), W(outAt.x, outAt.z)]), W(outAt.x, outAt.z + 7), W(outAt.x + 1.2, outAt.z + 13), W(outAt.x + AIR_LW, outAt.z + 19), ...innerTurn, W(inAt.x - AIR_LW, inAt.z - 8)], pace: [LOT_PACE], road: false },
            { pts: road.pts, pace: road.pace, road: true },
            { pts: this.farOut(end), pace: [1], road: true, far: `out:${end}:0` },
          ],
          arcs,
          head?.u ?? L,
        );
      };
      return head ? make() : this.cached(`ayout:${end}`, make);
    };
    /** 收货场时刻表最后一刻（驶离）的姿态：挂车车尾、牵引销、车头（世界坐标），车头在路线上的位置 */
    const headOf = (tl: YardTimeline, t: number): { pts: V3[]; u: number } | undefined => {
      const u = yardPoseAt(tl, t)?.units.find((x) => x.role === 'truck') ?? yardPoseAt(tl, t)?.units[0];
      if (!u) return undefined;
      const p = u.pose;
      // 单体车（厢式货车、面包车）：位姿是后轴中心，车头在前 length − rearOverhang、车尾在后 rearOverhang
      const d = u.dims.kind === 'rig' ? (u.dims as { front: number; rear: number }) : { front: (u.dims as { length: number; rearOverhang: number }).length - (u.dims as { rearOverhang: number }).rearOverhang, rear: (u.dims as { rearOverhang: number }).rearOverhang };
      if (u.dims.kind !== 'rig') p.trailer = p.heading;
      const at = (x: number, z: number) => {
        const w = yardToWorld(yard.frame, { x, z });
        return v3(w.x, 0, w.z);
      };
      const pts = [at(p.x - Math.sin(p.trailer) * d.rear, p.z - Math.cos(p.trailer) * d.rear), at(p.x, p.z), at(p.x + Math.sin(p.heading) * d.front, p.z + Math.cos(p.heading) * d.front)];
      const fl = frameToLocal(f, pts[2] as V3);
      if (Math.abs(fl.x - outAt.x) > 6 || fl.z > node.z - 14) return undefined;
      return { pts, u: d.rear + d.front };
    };
    const nb = lot?.bays.length ?? 0;
    const busy: [number, number][][] = Array.from({ length: nb }, () => []);
    const still0 = makeTrack([W(inAt.x, inAt.z + 1), W(inAt.x, inAt.z)]);
    /** 到进场点以前留的余量（秒）：放进场以前 SLACK 秒开到排队的位置，路上前车挡着晚到的时间在这里接住 */
    const SLACK = 60;
    // —— 进场点外的排队 ——
    // 收货场引擎让车在场外等（hold）的时候车不在场里：不画在进场点上（几辆车会叠在一起），在放进场（joinAt）以前 SLACK 秒才开到排队的位置；
    // 等得久的（10 分钟以上）先进货车等候区。按放进场的先后排，前面有车还没放进去（或者刚进去、车尾还没过进场点）就停在它后面，
    // 前车往前开了再跟上去（不超过前车车尾减 Q_GAP，加减速和场里排队一样）；引擎在前车车尾过了进场点 2 米以后才放这辆车，
    // 所以放进场的那一刻车头正好在进场点（最后 2 秒补齐几十厘米的差）。
    const DT = 0.5;
    const Q_GAP = 1.5;
    const Q_VMAX = 3.6;
    const Q_ACC = 0.6;
    const Q_DEC = 0.9;
    /** 车头的位置（卡车场本地坐标）和整车长（车头到车尾） */
    const headAt = (tl: YardTimeline, t: number): { x: number; z: number; len: number } | undefined => {
      const info = yardPoseAt(tl, t);
      const u = info?.units.find((x) => x.role === 'truck') ?? info?.units[0];
      if (!u) return undefined;
      const d = u.dims as { kind: string; front?: number; rear?: number; length?: number; rearOverhang?: number };
      const fr = d.kind === 'rig' ? (d.front ?? 0) : (d.length ?? 0) - (d.rearOverhang ?? 0);
      const len = d.kind === 'rig' ? (d.front ?? 0) + (d.rear ?? 0) : (d.length ?? 0);
      return { x: u.pose.x + Math.sin(u.pose.heading) * fr, z: u.pose.z + Math.cos(u.pose.heading) * fr, len };
    };
    /** 排过队的一辆车：到排队位置的时刻 A、放进场的时刻 J、排队时车头在进场点外多远（每 DT 秒一个）、整车长、放进场以后车头走过的路程（每 DT 秒一个，用到时再算） */
    interface QRec {
      tl: YardTimeline;
      A: number;
      J: number;
      xs: number[];
      len: number;
      ds: number[];
    }
    /** 这辆车的车头此刻过了进场点多远（米；还在进场点外排队时是负的，放进场以后按收货场时刻表里车头走过的路程） */
    const yOf = (q: QRec, t: number): number => {
      if (t <= q.J) return -(q.xs[Math.min(q.xs.length - 1, Math.max(0, Math.round((t - q.A) / DT)))] as number);
      if (t - q.J > 600) return 1e6;
      const k = Math.ceil((t - q.J) / DT);
      while (q.ds.length <= k) {
        const i = q.ds.length;
        const a = headAt(q.tl, q.J + (i - 1) * DT);
        const b = headAt(q.tl, q.J + i * DT);
        q.ds.push((q.ds[i - 1] as number) + (a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0));
      }
      const f = (t - q.J) / DT - (k - 1);
      return (q.ds[k - 1] as number) + ((q.ds[k] as number) - (q.ds[k - 1] as number)) * f;
    };
    /** 排队这一段的运动段：沿开到进场点的路径（终点是进场点），车头在终点往回 xs 米 */
    const queueLegs = (track: Track, A: number, J: number, xs: readonly number[], vs: readonly number[]): XLeg[] => {
      const L = track.len;
      const n = xs.length;
      const out: XLeg[] = [];
      const same = (i: number, j: number) => Math.abs((xs[i] as number) - (xs[j] as number)) < 0.005;
      let i = 0;
      while (i < n - 1) {
        let j = i + 1;
        if (same(i, i + 1)) {
          while (j < n - 1 && same(j + 1, i)) j++;
          out.push(ExtTrucks.still(track, L - (xs[i] as number), A + i * DT, A + j * DT));
        } else {
          while (j < n - 1 && !same(j, j + 1)) j++;
          const tu: number[] = [];
          const tuS: number[] = [];
          const tv: number[] = [];
          for (let k = i; k <= j; k++) {
            tu.push(A + k * DT);
            tuS.push(L - (xs[k] as number));
            tv.push(vs[k] as number);
          }
          out.push({ t0: A + i * DT, t1: A + j * DT, track, tu, tuS, tv, u: L - (xs[i] as number), rev: false, site: 1, uA: -Infinity, uB: Infinity });
        }
        i = j;
      }
      if (!out.length) out.push(ExtTrucks.still(track, L - (xs[0] as number), A, J));
      (out[0] as XLeg).t0 = A;
      (out[out.length - 1] as XLeg).t1 = J;
      return out;
    };
    let prevQ: QRec | undefined;
    const joinOf = (tl: YardTimeline) => Math.max(tl.visit.arrive, tl.joinAt);
    const ordered = air.visits
      .map((v, i) => ({ v, i, tl: v.id !== undefined ? tlOf.get(v.id) : undefined }))
      .filter((x): x is { v: DockVisit; i: number; tl: YardTimeline } => x.tl !== undefined)
      .sort((a, b) => joinOf(a.tl) - joinOf(b.tl) || a.i - b.i);
    // 每一辆车排完让出一下（分段排的时候）：先后和一口气排完一样
    const one = ({ v, tl }: (typeof ordered)[number]): void => {
      const kind = v.kind ?? (v.reefer ? 'reefer' : 'semi');
      const build: 1 | 2 | 3 | 4 = kind === 'reefer' ? 2 : kind === 'truck' ? 3 : kind === 'van' ? 4 : 1;
      const tIn = tl.visit.arrive;
      const tGone = tl.goneAt;
      // 放进场（开始沿待命车道开）的时刻 J；在这以前 SLACK 秒开到排队的位置（A）
      const J = joinOf(tl);
      const A = J - SLACK;
      // 场里的时刻表从哪里开始：先在进场道路场外那一头等（hold），还是直接开到进场点进场（车头在进场点）
      // 场里的时刻表从哪里开始（进场点，或者在场外那一头等着的位置）：路线开到时刻表第一刻车头所在的地方（不跳）
      const atGate = true;
      if (atGate) {
        const first = yardPoseAt(tl, J)?.units[0];
        if (first) {
          const d = first.dims;
          const ahead = d.kind === 'rig' ? d.front : d.length - d.rearOverhang;
          gate = { x: yo.x - (first.pose.x + Math.sin(first.pose.heading) * ahead), z: yo.z - (first.pose.z + Math.cos(first.pose.heading) * ahead) };
        }
      }
      let end: End = r() < 0.6 ? 'NORTH' : 'EAST';
      let w = toYard(end, atGate);
      if (!w) return;
      // 直接来的车在高速口出现的时刻和别的车太近：换另一个高速口来；两个都近就先进等候区
      let crowded = false;
      {
        const other: End = end === 'NORTH' ? 'EAST' : 'NORTH';
        const T = ExtTrucks.span(w.dp, true, false);
        const wo = toYard(other, atGate);
        if (!this.entryOk(end, A - T)) {
          if (wo && this.entryOk(other, A - ExtTrucks.span(wo.dp, true, false))) {
            end = other;
            w = wo;
          } else crowded = true;
        }
      }
      // 排队：到的时候前面的车（按放进场的先后）还在进场点外、或者车尾还没过进场点，就停在它后面；之后跟着前车往前挪
      const lenSelf = headAt(tl, J)?.len ?? 16.5;
      const pq = prevQ;
      const xMinAt = (t: number) => (pq ? Math.max(0, pq.len + Q_GAP - yOf(pq, t)) : 0);
      const xArr = Math.min(60, Math.ceil(xMinAt(A) * 2) / 2);
      const xs: number[] = [xArr];
      {
        let x = xArr;
        let vq = 0;
        for (let k = 1; A + k * DT <= J + 1e-6; k++) {
          const room = x - xMinAt(A + k * DT);
          const vn = room <= 0.02 ? 0 : Math.min(Q_VMAX, vq + Q_ACC * DT, Math.sqrt(2 * Q_DEC * room));
          x -= Math.max(0, Math.min(room, ((vq + vn) / 2) * DT));
          vq = vn;
          xs.push(x);
        }
        // 放进场的那一刻车头在进场点：最后 2 秒补齐
        const n = xs.length;
        const m = Math.min(n - 1, Math.round(2 / DT));
        const rest = xs[n - 1] as number;
        if (rest > 0.005) for (let k = n - 1 - m; k < n; k++) xs[k] = (xs[k] as number) - rest * (m > 0 ? (k - (n - 1 - m)) / m : 1);
      }
      const vs = xs.map((_, k) => Math.max(0, ((xs[Math.max(0, k - 1)] as number) - (xs[Math.min(xs.length - 1, k + 1)] as number)) / ((Math.min(xs.length - 1, k + 1) - Math.max(0, k - 1)) * DT || 1)));
      const legs: XLeg[] = [];
      // 来早了（收货口没空、或者本来就早到）、或者引擎让它在场外等得久，先进货车等候区等，到时候再开过来
      const early = (v.arrive !== undefined && v.t0 - v.arrive > 900) || v.t0 - v.plan > 300 || r() < 0.2 || crowded || J - tIn > 600;
      let came = false;
      let lotTrack: Track | undefined;
      if (early && lot) {
        const exitKey = `ay`;
        const tail = up(outerTurn, atGate);
        const probe = this.outOfLot(lot, 0, 'AIR', AIR_TURN, tail, exitKey, A, undefined, xArr);
        const wait0 = Math.max(15 * 60, v.t0 - v.plan + (r() * 20 + 5) * 60);
        const bay = probe && probe.tLeave - wait0 > 1.5 * H ? ExtTrucks.freeBay(busy, probe.tLeave - wait0 - 400, probe.tLeave + 90, r) : -1;
        let out = bay >= 0 ? this.outOfLot(lot, bay, 'AIR', AIR_TURN, tail, exitKey, A, undefined, xArr) : undefined;
        if (out && !this.lotFree(lot.id, out.tLeave, out.bar[2] + 90)) out = undefined;
        let into: ReturnType<ExtTrucks['intoLot']> | undefined;
        let wait = wait0;
        let fit = false;
        if (out)
          for (const dt of [0, 40, -40, 80, -80, 160, -160, 240]) {
            into = this.intoLot(lot, bay, end, 'AIR', out.tLeave - wait0 + dt);
            wait = wait0 - dt;
            if (!into) break;
            // 都不行就不进等候区（以前最后一个时刻硬排进去）
            if (this.entryOk(end, into.t0) && this.parkOk(out.tLeave - wait0 + dt) && this.stopOk(lot.id, into.legs[0]?.t1 ?? 0) && this.lotFree(lot.id, into.bar[1] - 45, out.tLeave - wait0 + dt)) {
              fit = true;
              break;
            }
          }
        if (out && into && fit) {
          const tPark = out.tLeave - wait;
          this.entries[end].push(into.t0);
          this.parks.push(tPark);
          this.addStop(lot.id, into.legs[0]?.t1 ?? 0);
          (busy[bay] as [number, number][]).push([tPark - 120, out.tLeave + 60]);
          legs.push(...into.legs, ExtTrucks.still(into.track, into.track.len, tPark, out.tLeave), ...out.legs);
          this.markBar(...into.bar);
          this.markBar(...out.bar);
          this.lotAdd(lot.id, into.bar[1] - 45, tPark);
          this.lotAdd(lot.id, out.tLeave, out.bar[2] + 90);
          lotTrack = out.dp.track;
          came = true;
          this.stats.airLot++;
        }
      }
      if (!came) {
        // 排在别的车后面的停在进场点往回 xArr 米
        const dp = xArr > 0 ? sub(w.dp, w.dp.uStart, w.dp.track.len - xArr, w.dp.uStart) : w.dp;
        const T = ExtTrucks.span(dp, true, false);
        legs.push(ExtTrucks.road(dp, A - T, A, true, false, w.roadA, Math.min(w.roadB, dp.track.len)));
        this.entries[end].push(A - T);
      }
      // 在进场点外排队、交单（前车往前开了再跟上去），路上前车挡着晚到的时间在这里接住
      legs.push(...queueLegs(lotTrack ?? w.dp.track, A, J, xs, vs));
      // 场里：收货场引擎的时刻表（待命车道、进场调车、倒车靠台、装卸、拉出、驶离），从放进场的那一刻起
      legs.push({ t0: J, t1: tGone, track: still0, u: still0.len, rev: false, site: 1, uA: -Infinity, uB: Infinity, yard: { tl, frame: yard.frame } });
      // 出去：开出区域时和港口开出来的车并到同一条高速上，太近就换另一个高速口，或者在驶出点多等一会儿（最多 2 分钟）
      let dep = tGone;
      let eo: End = r() < 0.6 ? 'NORTH' : 'EAST';
      let out = fromYard(eo);
      const exitAt = (e: End, d: number) => {
        const w2 = fromYard(e);
        return w2 ? d + ExtTrucks.span(w2.dp, false, true) : NaN;
      };
      if (out && !this.exitOk(eo, exitAt(eo, dep))) {
        const other: End = eo === 'NORTH' ? 'EAST' : 'NORTH';
        if (this.exitOk(other, exitAt(other, dep))) {
          eo = other;
          out = fromYard(eo);
        } else
          for (const dt of [40, 80, 120])
            if (this.exitOk(eo, exitAt(eo, dep + dt))) {
              dep += dt;
              break;
            }
      }
      // 并到里车道（驶出以后 3–14 秒）的时候进场一侧外车道上有进场的车开过来：在驶出点多等一会儿（最多 40 秒，
      // 而且下一辆从场里开出来以前要走：场里的时刻表不知道它还停在驶出点）
      const nextOut = goneAll.find((g) => g > tGone + 0.5) ?? Infinity;
      for (let k = 0; k < 10 && passAt.some((p) => Math.abs(dep + 8 - p) < 16) && dep + 4 < nextOut - 25; k++) dep += 4;
      // 从收货场时刻表最后一刻的姿态接着开（不跳）
      const hd = headOf(tl, tGone - 0.01);
      if (out && hd) out = fromYard(eo, hd) ?? out;
      if (out) {
        if (dep > tGone) legs.push(ExtTrucks.still(out.dp.track, out.dp.uStart, tGone, dep));
        const T = ExtTrucks.span(out.dp, false, true);
        legs.push(ExtTrucks.road(out.dp, dep, dep + T, false, true, out.roadA, out.roadB));
        this.exits[eo].push(dep + T);
      }
      this.push(build, legs, legs[0]?.t0 ?? tIn, r);
      this.stats.air++;
      prevQ = { tl, A, J, xs, len: lenSelf, ds: [0] };
    };
    for (const x of ordered) {
      one(x);
      yield;
    }
  }

  /**
   * 物流园：别家的货车、承运商的车头、外来集卡从高速口开来，沿进园的路开到门口，并到自己的进门车道（最后一段笔直）；
   * 前面有车还没登记完就停在它后面（每 PARK_Q 米一个车位，前面走一辆往前挪一个），开到登记亭交给物流园的场地（ops/parkYard.ts：开始登记的时刻，
   * 牵引销停在登记亭、车头朝园内）。出门登记完从登记亭开出来（挂车、牵引车按场地给的姿态），并到出园的车道，开回高速口。
   */
  private planPark(trips: readonly ParkTrip[], seed: number): void {
    if (!trips.length) return;
    const f: Frame = FRAMES.park;
    const W = (q: { x: number; z: number }) => {
      const w = frameToWorld(f, q);
      return v3(w.x, 0, w.z);
    };
    const r = rng(seed * 4231 + 97);
    const SLACK = 60;
    const PARK_Q = 21;
    const semi = dimsOf('semi') as { front: number; rear: number };
    const dray = dimsOf('chassis') as { front: number; rear: number };
    const FRONT = semi.front;
    const inWay = (end: End, kiosk: { x: number; z: number }): Way | undefined =>
      this.cached(`pkin:${end}:${kiosk.x.toFixed(1)}`, () => {
        const arcs = ExtTrucks.trimEnd(this.arcs(end, 'DC'), 25);
        if (!arcs.length) return undefined;
        const road = this.net.realize(arcs, () => 0);
        const e = frameToLocal(f, road.pts[road.pts.length - 1] as V3);
        // 离开车道以后平顺地挪到登记亭那条车道上（园区局部坐标里车头朝 −z），最后 24 米笔直
        const b = { x: kiosk.x, z: kiosk.z + 18 };
        const pts: V3[] = [];
        for (let k = 1; k <= 12; k++) {
          const u = k / 12;
          pts.push(W({ x: e.x + (b.x - e.x) * u * u * (3 - 2 * u), z: e.z + (b.z - e.z) * u }));
        }
        pts.push(W({ x: kiosk.x, z: kiosk.z + 6 }), W({ x: kiosk.x, z: kiosk.z - FRONT }));
        return this.way(
          [
            { pts: this.farIn(end), pace: [1], road: true, far: `in:${end}:0` },
            { pts: road.pts, pace: road.pace, road: true },
            { pts, pace: [LOT_PACE], road: false },
          ],
          arcs,
        );
      });
    /** 出园：从挂车车尾、牵引销、车头（场地给的出门登记完的姿态）开出登记亭，平顺地并到出园的车道 */
    const outWay = (end: End, trip: ParkTrip): Way | undefined => {
      const arcs = ExtTrucks.trimStart(this.arcs('DC', end), 25);
      if (!arcs.length) return undefined;
      const road = this.net.realize(arcs, () => 0);
      const s0 = frameToLocal(f, road.pts[0] as V3);
      const s1 = frameToLocal(f, (road.pts[1] ?? road.pts[0]) as V3);
      const sl = Math.hypot(s1.x - s0.x, s1.z - s0.z) || 1;
      const sd = { x: (s1.x - s0.x) / sl, z: (s1.z - s0.z) / sl };
      const o = trip.out;
      const dh = { x: Math.sin(o.h), z: Math.cos(o.h) };
      const dt = { x: Math.sin(o.th), z: Math.cos(o.th) };
      const rear = trip.buildOut === 5 ? 1.6 : trip.buildOut === 0 ? dray.rear : semi.rear;
      const Rr = { x: o.x - dt.x * rear, z: o.z - dt.z * rear };
      const F = { x: o.x + dh.x * FRONT, z: o.z + dh.z * FRONT };
      const k = Math.hypot(s0.x - F.x, s0.z - F.z) / 3;
      const P1 = { x: F.x + dh.x * k, z: F.z + dh.z * k };
      const P2 = { x: s0.x - sd.x * k, z: s0.z - sd.z * k };
      const pts: V3[] = [W(Rr), W({ x: o.x, z: o.z }), W(F)];
      for (let i = 1; i < 16; i++) {
        const u = i / 16;
        const v = 1 - u;
        pts.push(W({ x: v * v * v * F.x + 3 * v * v * u * P1.x + 3 * v * u * u * P2.x + u * u * u * s0.x, z: v * v * v * F.z + 3 * v * v * u * P1.z + 3 * v * u * u * P2.z + u * u * u * s0.z }));
      }
      return this.way(
        [
          { pts, pace: [LOT_PACE], road: false },
          { pts: road.pts, pace: road.pace, road: true },
          { pts: this.farOut(end), pace: [1], road: true, far: `out:${end}:0` },
        ],
        arcs,
        rear + FRONT,
      );
    };
    const other = (e: End): End => (e === 'NORTH' ? 'EAST' : 'NORTH');
    for (const trip of trips) {
      const kiosk = trip.kioskAt;
      const build = (b: 0 | 1 | 2 | 5): 0 | 1 | 2 => (b === 5 ? 1 : b);
      const mark = (legs: XLeg[], b: 0 | 1 | 2 | 5) => {
        if (b === 5) for (const l of legs) (l as XLeg & { bobtail?: boolean }).bobtail = true;
        return legs;
      };
      // —— 来 ——
      const tA = trip.arrive - SLACK;
      let end: End = r() < 0.6 ? 'NORTH' : 'EAST';
      let w = inWay(end, kiosk);
      if (w && !this.entryOk(end, tA - ExtTrucks.span(w.dp, true, false))) {
        const wo = inWay(other(end), kiosk);
        if (wo && this.entryOk(other(end), tA - ExtTrucks.span(wo.dp, true, false))) {
          end = other(end);
          w = wo;
        }
      }
      if (w) {
        const full = w.dp;
        const len = full.track.len;
        const m0 = Math.min(2, trip.ahead.length);
        const dp = m0 > 0 ? sub(full, full.uStart, len - PARK_Q * m0, full.uStart) : full;
        const T = ExtTrucks.span(dp, true, false);
        const legs: XLeg[] = [ExtTrucks.road(dp, tA - T, tA, true, false, w.roadA, Math.min(w.roadB, dp.track.len), trip.boxIn)];
        this.entries[end].push(tA - T);
        let at: { track: Track; u: number } = { track: dp.track, u: dp.track.len };
        let t = tA;
        // 门外排队：前面一辆离开登记亭 3 秒后往前挪一个车位（8 秒）
        for (let i = 0; i < m0; i++) {
          const go = Math.max(t, Math.min((trip.ahead[trip.ahead.length - m0 + i] as number) + 2, trip.kiosk - 8.5));
          const dur = Math.max(3, Math.min(7.5, trip.kiosk - 0.3 - go));
          if (go > t + 0.05) legs.push(ExtTrucks.still(at.track, at.u, t, go, trip.boxIn));
          const tr = sub(full, len - PARK_Q * (m0 - i), len - PARK_Q * (m0 - i - 1), 25).track;
          legs.push(ExtTrucks.eased(tr, go, go + dur, trip.boxIn, Math.min(25, tr.len - PARK_Q)));
          at = { track: tr, u: tr.len };
          t = go + dur;
        }
        if (trip.kiosk > t + 0.05) legs.push(ExtTrucks.still(at.track, at.u, t, trip.kiosk, trip.boxIn));
        this.push(build(trip.buildIn), mark(legs, trip.buildIn), legs[0]?.t0 ?? tA, r, trip.cab, trip.trailerIn);
        this.stats.park++;
      }
      // —— 走 ——
      let eo: End = r() < 0.6 ? 'NORTH' : 'EAST';
      let ow = outWay(eo, trip);
      if (ow && !this.exitOk(eo, trip.leave + ExtTrucks.span(ow.dp, false, true))) {
        const oo = outWay(other(eo), trip);
        if (oo && this.exitOk(other(eo), trip.leave + ExtTrucks.span(oo.dp, false, true))) {
          eo = other(eo);
          ow = oo;
        }
      }
      if (ow) {
        const T = ExtTrucks.span(ow.dp, false, true);
        const legs = [ExtTrucks.road(ow.dp, trip.leave, trip.leave + T, false, true, ow.roadA, ow.roadB, trip.boxOut)];
        this.exits[eo].push(trip.leave + T);
        this.push(build(trip.buildOut), mark(legs, trip.buildOut), trip.leave, r, trip.cab, trip.trailerOut);
      }
    }
  }

  /**
   * 港口闸口里面的路口：进闸的车往南开到车道再分开（去码头箱区的往东、去物流中心的往西），从物流中心出来的车往东开进出闸车道，
   * 几股车在这里交叉。一次只放一辆车过：按到路口的先后，后到的在停车线前停下等前一辆过去，过了路口开快一点，还是按计划的时刻到下一段。
   * 刚过道闸的车（离路口不到 30 米就出发）不在路口前停（后面的车跟着过杆），别的车让它们。
   */
  private gateOrder(): void {
    const f: Frame = FRAMES.port;
    const Z = JUNCTION;
    const inZ = (q: { x: number; z: number }) => {
      const l = frameToLocal(f, q);
      return l.x > Z.x0 && l.x < Z.x1 && l.z > Z.z0 && l.z < Z.z1;
    };
    type Occ = { tk: XTruck; li: number; a: number; b: number; uIn: number; fixed: boolean };
    const occOf = (tk: XTruck, l: XLeg): { a: number; b: number; uIn: number } | undefined => {
      const L = this.len(tk);
      let a = Infinity;
      let b = -Infinity;
      let uIn = -1;
      for (let t = l.t0; t <= l.t1; t += 0.5) {
        const u = leadState(l, t, this.ls).u;
        if (inZ(trackAt(l.track, u)) || inZ(trackAt(l.track, Math.max(0, u - L * 0.5))) || inZ(trackAt(l.track, Math.max(0, u - L)))) {
          if (a === Infinity) {
            a = t;
            uIn = u;
          }
          b = t;
        }
      }
      return a < Infinity ? { a, b, uIn } : undefined;
    };
    const occ: Occ[] = [];
    for (const tk of this.trucks)
      tk.legs.forEach((l, li) => {
        if (l.site !== 1 || !l.tu || l.hidden || l.yard || l.t1 - l.t0 < 3) return;
        const o = occOf(tk, l);
        if (o) occ.push({ tk, li, ...o, fixed: o.uIn - l.u < 30 });
      });
    const done = occ.filter((o) => o.fixed);
    Object.assign(this.gateStats, { legs: occ.length, fixed: done.length, waited: 0, failed: 0 });
    for (const o of occ.filter((x) => !x.fixed).sort((x, y) => x.a - y.a)) {
      const l0 = o.tk.legs[o.li] as XLeg;
      const tuS = l0.tuS as number[];
      const uEnd = tuS[tuS.length - 1] as number;
      const uStop = o.uIn - 3;
      let cur = { a: o.a, b: o.b };
      let parts: XLeg[] | undefined;
      let W = 0;
      for (let it = 0; it < 8; it++) {
        const c = done.find((d) => d.tk !== o.tk && d.a < cur.b + 2 && d.b + 2 > cur.a);
        if (!c) break;
        W += c.b + 2 - cur.a;
        // 等的时间最多三成，而且后面开得不能太快（平均不超过 5.5 米 / 秒）
        if (W > (l0.t1 - l0.t0) * 0.3 || uStop <= l0.u + 1 || (uEnd - l0.u) / (l0.t1 - l0.t0 - W) > 5.5) {
          parts = undefined;
          break;
        }
        // 停车线前停下等 W 秒：前一段缓起缓停开到停车线，等着，再开完（整段的时刻不变）
        const T = l0.t1 - l0.t0 - W;
        const tStop = l0.t0 + T * ((uStop - l0.u) / Math.max(1, uEnd - l0.u));
        const p1 = ExtTrucks.easedTo(l0.track, l0.t0, tStop, l0.u, uStop, l0.box);
        const p2 = ExtTrucks.still(l0.track, uStop, tStop, tStop + W, l0.box);
        const p3 = ExtTrucks.easedTo(l0.track, tStop + W, l0.t1, uStop, uEnd, l0.box);
        parts = [p1, p2, p3];
        const o3 = occOf(o.tk, p3);
        cur = o3 ? { a: o3.a, b: o3.b } : { a: tStop + W, b: tStop + W };
      }
      if (W > 0) this.gateStats.failed++;
      if (parts && ExtTrucks.SPEED_UP) {
        this.gateStats.waited++;
        for (const p of parts) p.tk = o.tk;
        o.tk.legs.splice(o.li, 1, ...parts);
        // 后面的段的下标往后挪了两个
        for (const x of occ) if (x.tk === o.tk && x.li > o.li) x.li += 2;
        o.a = cur.a;
        o.b = cur.b;
      }
      done.push(o);
    }
  }
  /** 缓起缓停地从 u0 开到 u1（同一条路径） */
  private static easedTo(track: Track, t0: number, t1: number, u0: number, u1: number, box?: number): XLeg {
    const D = u1 - u0;
    const n = Math.max(8, Math.min(40, Math.ceil(Math.abs(D) / 4)));
    const T = Math.max(1e-3, t1 - t0);
    const tu: number[] = [];
    const tuS: number[] = [];
    const tv: number[] = [];
    for (let i = 0; i <= n; i++) {
      const fr = i / n;
      tu.push(t0 + fr * T);
      tuS.push(u0 + D * ease(fr));
      tv.push((D * 6 * fr * (1 - fr)) / T);
    }
    return { t0, t1, track, tu, tuS, tv, u: u0, rev: false, site: 1, uA: -Infinity, uB: Infinity, ...(box !== undefined ? { box } : {}) };
  }

  /** 一串时刻（按原来的顺序）：和前一个隔不到 GAP 秒的换另一条车道 */
  private static lanes(ts: readonly number[]): number[] {
    const order = ts.map((_, i) => i).sort((a, b) => (ts[a] as number) - (ts[b] as number));
    const out = ts.map(() => 0);
    let prevT = -Infinity;
    let prevLane = 1;
    for (const i of order) {
      const lane = (ts[i] as number) - prevT < GAP ? 1 - prevLane : 0;
      out[i] = lane;
      prevT = ts[i] as number;
      prevLane = lane;
    }
    return out;
  }

  /** 按时刻先后把一串时刻错开：后一个比前一个至少晚 GAP 秒（最多往后挪 150 秒）；按原来的顺序返回 */
  private static spaced(ts: readonly number[]): number[] {
    const order = ts.map((_, i) => i).sort((a, b) => (ts[a] as number) - (ts[b] as number));
    const out = ts.slice();
    let last = -Infinity;
    for (const i of order) {
      const t = ts[i] as number;
      const d = Math.min(t + 150, Math.max(t, last + GAP));
      out[i] = d;
      last = d;
    }
    return out;
  }

  /**
   * 机场：进场路的尽头前（AIR_TURN 米）向左掉头，沿出场一侧开回卡车场的入口（和仿真里空运冷藏车进货站的路一样）。
   * arcs：开到掉头点为止的行程；返回掉头的半圆（两条最外侧车道之间）
   */
  private push(build: 0 | 1 | 2 | 3 | 4, legs: XLeg[], t0: number, r: () => number, cab?: number, trailer?: number): void {
    if (!legs.length) return;
    legs.sort((a, b) => a.t0 - b.t0);
    const cab0 = CABS[Math.floor(r() * CABS.length)] as number;
    const trailer0 = TRAILERS[Math.floor(r() * TRAILERS.length)] as number;
    const tk: XTruck = { build, cab: cab ?? cab0, trailer: trailer ?? trailer0, t0: Math.max(0, Math.min(t0, legs[0]?.t0 ?? t0)), t1: legs[legs.length - 1]?.t1 ?? t0, legs };
    for (const l of legs) l.tk = tk;
    this.trucks.push(tk);
  }

  // ———————————————————————— 画 ————————————————————————

  /** 停车场的道闸此刻抬没抬（外来车过道闸时） */
  barrierRaised(key: string, t: number): boolean {
    if (this.waiting) return false;
    const list = this.bars.get(key);
    if (!list) return false;
    for (let i = 0; i + 1 < list.length; i += 2) if (t >= (list[i] as number) && t <= (list[i + 1] as number)) return true;
    return false;
  }

  /** 第 i 辆车此刻车头的位置和朝向（检查、跟随用）；不在场返回 undefined */
  poseAt(i: number, t: number): { x: number; z: number; yaw: number; site: boolean; scale: number } | undefined {
    if (this.waiting) return undefined;
    const tk = this.trucks[i];
    if (!tk || t < tk.t0 || t > tk.t1) return undefined;
    this.ensure(t);
    const leg = legAt(tk as unknown as { legs: MLeg[]; t0: number; t1: number }, t) as XLeg | undefined;
    if (leg?.hidden) return undefined;
    if (!leg) return undefined;
    if (leg.yard) {
      const info = yardPoseAt(leg.yard.tl, t);
      const unit = info?.units.find((x) => x.role === 'truck') ?? info?.units[0];
      if (!unit) return undefined;
      // 和路上的段一样给车头的位置（时刻表给的是牵引销 / 单体车的后轴）
      const dm = unit.dims as { kind: string; front?: number; length?: number; rearOverhang?: number };
      const fr = dm.kind === 'rig' ? (dm.front ?? 0) : (dm.length ?? 0) - (dm.rearOverhang ?? 0);
      const w = yardToWorld(leg.yard.frame, { x: unit.pose.x + Math.sin(unit.pose.heading) * fr, z: unit.pose.z + Math.cos(unit.pose.heading) * fr });
      return { x: w.x, z: w.z, yaw: yawOf(leg.yard.frame, unit.pose.heading), site: true, scale: 1 };
    }
    const u = leadState(leg, t, this.ls).u;
    const p = trackAt(leg.track, leg.rev ? u - this.len(tk) : u);
    const q = trackAt(leg.track, leg.rev ? u - this.len(tk) + 1 : u - 1);
    return { x: p.x, z: p.z, yaw: Math.atan2(-(p.z - q.z), p.x - q.x), site: leg.site === 1, scale: this.scaleOf(leg, u, 7) };
  }

  get count(): number {
    return this.waiting ? 0 : this.trucks.length;
  }
  /** 此刻在场（在路上、在场地里、停在等候区）的车数 */
  activeAt(t: number): number {
    let n = 0;
    for (const tk of this.trucks) if (t >= tk.t0 && t <= tk.t1) n++;
    return n;
  }

  private len(tk: XTruck): number {
    return tk.build === 0 ? BUILDS.drayage.L : tk.build === 3 ? BUILDS.boxTruck.L : tk.build === 4 ? BUILDS.van.L : BUILDS.plainDry.L;
  }

  /** 路上远看放大（和区域里的车一样），场地里真实大小，离场地 BLEND 米内渐变 */
  private scaleOf(leg: XLeg, u: number, road: number): number {
    if (leg.site === 1 || road <= 1) return 1;
    const w = smooth((u - leg.uA) / BLEND) * smooth((leg.uB - u) / BLEND);
    return 1 + (road - 1) * w;
  }

  private poolOf(part: PartSpec): Pool {
    return part.slot === 'tractor' ? this.tractor : part.slot === 'chassis' ? this.chassis : part.slot === 'container' ? this.box : part.slot === 'trailerPlainReefer' ? this.reefer : part.slot === 'boxTruck' ? this.boxTruck : part.slot === 'van' ? this.van : this.trailer;
  }

  /**
   * 收货场里的一段：收货场引擎给牵引销（单体车是后轴中心）的位置、牵引车和挂车各自的朝向，
   * 零件按车尾放（零件原点在零件的车尾、车头朝 +x）：牵引车的牵引座在零件里 kp 米处，挂车的牵引销在 ax 米处，单体车的后轴在 L − ra 米处。
   * 刹车灯：停着、减速；双闪：倒车起点等着、靠台准备（每秒亮一半）。
   */
  private drawYard(tk: XTruck, yard: { tl: YardTimeline; frame: YardFrame }, parts: readonly PartSpec[], t: number, night: boolean): void {
    const info = yardPoseAt(yard.tl, t);
    const unit = info?.units.find((x) => x.role === 'truck') ?? info?.units[0];
    if (!info || !unit) return;
    const fr = yard.frame;
    const p = unit.pose;
    const blink = info.hazard && Math.floor(t * 2) % 2 === 0;
    const L = this.len(tk);
    for (const part of parts) {
      const tractor = part.slot === 'tractor';
      const single = parts.length === 1;
      const h = single || tractor ? p.heading : p.trailer;
      const back = single ? L - part.ra : tractor ? part.fa + part.ax - part.ra : part.ax;
      const lp = { x: p.x - Math.sin(h) * back, z: p.z - Math.cos(h) * back };
      const w = yardToWorld(fr, lp);
      const yaw = yawOf(fr, h);
      const color = tractor ? tk.cab : single ? tk.cab : tk.trailer;
      this.poolOf(part).put(w.x, 0.3, w.z, yaw, 0, 1, 1, 1, color);
      // 尾灯：挂车（或单体车）车尾两侧
      if (tractor || !(night || info.brake || blink)) continue;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      for (const side of SIDES) {
        const lx = TAIL_TRAILER[0];
        const lz = TAIL_TRAILER[2] * side;
        this.tails.put(w.x + lx * c + lz * sn, 0.3 + TAIL_TRAILER[1], w.z - lx * sn + lz * c, yaw, 0, 1, 1, 1, blink ? '#ffb020' : info.brake ? BRAKE_HEX : TAIL_HEX);
      }
    }
  }

  update(t: number, scale: number): void {
    // 分段排这一天的时候先不画（行程还没排完，路上的段也还没排）
    if (this.waiting) {
      for (const p of this.pools) p.begin();
      for (const p of this.pools) p.end();
      return;
    }
    this.ensure(t);
    for (const p of this.pools) p.begin();
    const road = Math.min(7, Math.max(1, scale));
    const night = isNight(t);
    for (const tk of this.trucks) {
      if (t < tk.t0 || t > tk.t1) continue;
      const leg = legAt(tk as unknown as { legs: MLeg[]; t0: number; t1: number }, t) as XLeg | undefined;
      if (!leg || leg.hidden) continue;
      const u = leadState(leg, t, this.ls).u;
      const k = this.scaleOf(leg, u, road);
      const parts: readonly PartSpec[] = tk.build === 0 ? BUILDS.drayage.parts : tk.build === 1 ? BUILDS.plainDry.parts : tk.build === 3 ? BUILDS.boxTruck.parts : tk.build === 4 ? BUILDS.van.parts : BUILDS.plainReefer.parts;
      if (leg.yard) {
        this.drawYard(tk, leg.yard, parts, t, night);
        continue;
      }
      const L = this.len(tk);
      // 刹车灯：减速、停着等灯 / 排队时亮（白天也亮）；夜里尾灯常亮、开着的车开大灯
      const moving = !!leg.tu;
      const braking = moving ? inSpans(leg.brake, t, 2) >= 0 || this.ls.v < 0.02 : t - leg.t0 < 4 && leg.site === 0;
      // 停下等一会儿（排队、等道闸、交单、装卸箱）也亮着灯，在等候区、收货口长时间停着的熄火不亮
      const lit = night && (moving || leg.site === 0 || leg.t1 - leg.t0 < 600 || t - leg.t0 < 30);
      for (const part of parts) {
        if (part.slot === 'container' && leg.box === undefined) continue;
        const pp = partPose(leg, u, L, part, k, this.pp);
        const pool = this.poolOf(part);
        const color = part.slot === 'tractor' ? tk.cab : part.slot === 'container' ? (leg.box as number) : part.slot === 'chassis' ? 0xffffff : tk.trailer;
        pool.put(pp.x, pp.y + 0.3, pp.z, pp.yaw, pp.pitch, k, k, k, color);
        if (!lit && !braking) continue;
        // 车灯（零件坐标，零件原点在零件的车尾、车头朝 +x）：牵引车的大灯，骨架车 / 挂车的尾灯
        const spec = part.slot === 'tractor' ? HEAD : part.slot === 'chassis' ? TAIL_CHASSIS : part.slot === 'container' ? undefined : TAIL_TRAILER;
        if (!spec || (spec === HEAD && !lit)) continue;
        const c = Math.cos(pp.yaw);
        const sn = Math.sin(pp.yaw);
        for (const side of SIDES) {
          const lx = spec[0];
          const lz = spec[2] * side;
          const x = pp.x + (lx * c + lz * sn) * k;
          const z = pp.z + (-lx * sn + lz * c) * k;
          const y = pp.y + 0.3 + spec[1] * k;
          if (spec === HEAD) this.heads.put(x, y, z, pp.yaw, 0, k, k, k, HEAD_HEX);
          else this.tails.put(x, y, z, pp.yaw, 0, k, k, k, braking ? BRAKE_HEX : TAIL_HEX);
        }
      }
    }
    for (const p of this.pools) p.end();
  }
}
