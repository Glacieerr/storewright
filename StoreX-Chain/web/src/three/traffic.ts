import { bezier, cumulative, rand, sampleAt, v3, type V3 } from './geo';
import type { Lot } from './parking';
import { halfRoad, laneOffset, SPEED, type Junction, type Line, type RoadNet } from './roadnet';
import { AMBER, CYCLE, GREEN, phaseClock as local, REACT, STOP_BACK } from './signals';

/**
 * 社会车流（背景，不参与仿真）：几千辆私家车在各区域的停车场、出区域的高速口之间往来，几条公交线路按时刻表在城区跑；
 * 车不会在路中间凭空出现或消失。
 * - 出发：车从车位里倒出来，沿场内通道开到场口（员工停车场有道闸：停一下、抬杆再走），等出场的路上有空当再并进去。
 * - 路上：按到目的地用时最短的路线开（每辆车的偏好略有不同）；有中央分隔带的路上进出停车场只能右进右出，
 *   要往另一个方向就开到前面的路口掉头。每条车道上的车先来后到、不超车：后车跟着前车走——前车的轨迹往后推一个反应时间、
 *   往回让一个车长加空当，后车不越过这条线（追上前车之前提前减速），所以停下时车距几米，开起来车距随车速加大；
 *   汇入别的车道（匝道汇入、T 形路口、出停车场、公交车出站、路口转弯进同一条车道）要在那条车道上有空当，没有就在路口前停下等。
 *   信号灯路口遇红灯停在停止线后，后面的车依次排队；绿灯亮后头车先起步，后面的车隔一个反应时间跟上，黄灯时还在开的车可以过线。
 * - 到达：进场减速、打灯，过道闸，沿通道开到空车位、车头朝里停进去；停车场满了就掉头去最近的另一个。
 *   场内通道上的车互相让：前面有车在倒车、在通道上开，就在场口外或车位里多等一会儿。
 * - 公交：几条线路连着客运站、城区的停车场和物流园、机场、港口的员工停车场，在两个首末站之间往返。路边是港湾式车站：
 *   公交车减速、打右转灯靠进港湾，停 20–40 秒，再打左转灯、等车道上有空当出站；首末站按时刻表发车（高峰 12 分钟一班），
 *   车在首末站的港湾里排队等发车、收车后在那里过夜（满了就空车开到另一个首末站）。
 * - 出行按停车场每小时的占用率排：早上进员工停车场、客运站，傍晚离开；城区停车场整天有人来有人走。
 *   过路的车和进出区域的车从高速口外面的远处开进来、开出去；过路的车里约两成是货车（平头厢式货车、半挂车，只走高速口到高速口）。
 *
 * 整天的行驶事先按事件推进算好：车开进一条车道时就定下在这条车道上怎么开（跟车、停车、等灯、等空当）和过路口的转弯，
 * 并在下一条车道上预约进去的时刻；前车先定，后车跟着前车已经定好的轨迹算。每辆车一整天一条轨迹（一段段「开 / 停」，
 * 每段带起始、最高、结束速度和加速、减速的时长，段内匀加速—匀速—匀减速；停在车位上的时段也是一段），
 * 播放时按时刻查位置、速度（刹车灯）、倒车灯和转向（转向灯），可以随意拖时间轴。
 */
interface Arc {
  line: number;
  s0: number;
  s1: number;
  ja: string;
  jb: string;
  /** 沿线方向（+1 / −1） */
  dir: number;
  len: number;
}
interface Path {
  pts: V3[];
  cum: number[];
  len: number;
}
export interface CarTrack {
  kind: number;
  color: number;
  /** 公交车跑的线路（busLines 的下标）；别的车是 −1 */
  line: number;
  t0: number;
  t1: number;
  /** 每段：开始、结束时刻、路径编号、路径上的起止位置（终点比起点小 = 倒车） */
  segT0: Float64Array;
  segT1: Float64Array;
  segP: Int32Array;
  segS0: Float32Array;
  segS1: Float32Array;
  /** 每段的起始、最高、结束速度，加速（或减到最高速度）段、减速段的时长 */
  segV0: Float32Array;
  segVp: Float32Array;
  segV1: Float32Array;
  segTa: Float32Array;
  segTb: Float32Array;
  /** 转向灯：±2 整段都打（转弯、在路口排队、起步过线），±1 段尾 6 秒打（快到路口）；正 = 右转 */
  segTurn: Int8Array;
  /** 这一段在哪：0 路上；1 停车场里（停着、倒车、场内通道：按真实大小画，不随镜头远近放大）；2 公交车在首末站的港湾里等发车、过夜 */
  segLot: Uint8Array;
}
/** 背景车此刻的位置、朝向、刹车灯、转向灯（−1 左 / 1 右）、倒车灯、在不在停车场里、是不是熄火停着（车位上、首末站过夜） */
export interface TrafficPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  brake: boolean;
  turn: number;
  rev: boolean;
  lot: boolean;
  parked: boolean;
  /** 车速（沙盘米 / 秒，停车场里是真实尺寸）、加速度（倒车时沿路径方向）：车身姿态、车轮转动用 */
  v?: number;
  acc?: number;
  /** 车头处路径的切线方向（three.js 的 yaw）：和车身朝向之差就是前轮转角、弯道的曲率 */
  headYaw?: number;
  /** 车走过的路程（车轮按它转；换路径时可能跳一下） */
  odo?: number;
}

/** 公交站：路边的港湾式车站（最右车道右边让出一段，公交车开进去停靠，不挡后面的车） */
export interface BusStop {
  id: string;
  name: string;
  /** 在哪条路（道路网的线）上、线上的位置（港湾中点）、沿线的哪个方向（1 顺着线、−1 逆着线）、港湾一半的长度 */
  line: number;
  s: number;
  dir: 1 | -1;
  g: number;
  /** 首末站：公交车在这里排队等发车、过夜 */
  terminal: boolean;
  /** 停靠的线路（busLines 的下标） */
  lines: number[];
  /** 画站用：港湾里公交车车头的轨迹（进站、停靠、出站）、车停的位置、站台雨棚的位置、站牌的位置、行车方向（atan2(dz, dx)） */
  bay: Pt3[];
  stopAt: number;
  shelter: Pt3;
  sign: Pt3;
  heading: number;
}
/**
 * 人行横道（城市道路的路口，每条腿一条，和 roadmesh 画的斑马线同一个位置）：中心、沿路方向（指离开路口）、
 * 横向的半宽、沿路的半长、行人上下斑马线的路缘离中心多远；有没有信号灯、这条腿的相位、路口的周期偏移；
 * 车占着斑马线的时段（开始、结束交替，按开始排、合并过，两头各多留半秒）——行人按它找空当过街，车不用让人。
 */
export interface Crosswalk {
  id: string;
  junction: string;
  line: number;
  cx: number;
  cy: number;
  cz: number;
  ux: number;
  uz: number;
  hw: number;
  hl: number;
  curb: number;
  signal: boolean;
  phase: number;
  offset: number;
  busy: number[];
}
/** 斑马线在路口那一端往里多远（米，和 roadmesh 一致：退让处往外 1.2 米起、沿路 4 米长的白条，中心在 3.4 米） */
export const ZEBRA_MID = 3.4;
const ZEBRA_HALF = 2;

/** 普通的三维点（要能在线程之间传） */
export interface Pt3 {
  x: number;
  y: number;
  z: number;
}
export interface BusLine {
  id: number;
  name: string;
  color: number;
  /** 一圈依次经过的站（BusStop.id）；两个首末站在 stops 里的下标 */
  stops: string[];
  terminals: [number, number];
  /** 配车数、一圈大约多少分钟（按不堵车估）、两个首末站各能停几辆（过夜） */
  fleet: number;
  cycleMin: number;
  cap: [number, number];
}

/** 一段匀加速—匀速—匀减速的运动的结果：用时、最高速度、实际的结束速度、加速段和减速段的时长 */
interface Kin {
  T: number;
  vp: number;
  v1: number;
  ta: number;
  tb: number;
}

/**
 * 长 D 的一段：起始速度 v0，最高不超过 vc，结束速度 v1（加速到不了就按能到的），加速度 a、减速度 b；
 * 来不及按 b 减速时这一段按需要的减速度刹车。
 */
function kin(D: number, v0: number, vc: number, v1: number, a: number, b: number): Kin {
  if (D <= 1e-4) return { T: 0, vp: v0, v1: v0, ta: 0, tb: 0 };
  let end = Math.min(v1, vc);
  const reach = Math.sqrt(v0 * v0 + 2 * a * D);
  if (end > reach) end = reach;
  if (v0 > end && (v0 * v0 - end * end) / (2 * b) > D) {
    const bb = (v0 * v0 - end * end) / (2 * D);
    const tb = (v0 - end) / bb;
    return { T: tb, vp: v0, v1: end, ta: 0, tb };
  }
  const vp = v0 > vc ? vc : Math.max(Math.max(v0, end), Math.min(vc, Math.sqrt((2 * a * b * D + b * v0 * v0 + a * end * end) / (a + b))));
  const r1 = vp >= v0 ? a : b;
  const ta = Math.abs(vp - v0) / r1;
  const d1 = Math.abs(vp * vp - v0 * v0) / (2 * r1);
  const tb = (vp - end) / b;
  const d3 = (vp * vp - end * end) / (2 * b);
  const d2 = Math.max(0, D - d1 - d3);
  return { T: ta + (vp > 1e-6 ? d2 / vp : 0) + tb, vp, v1: end, ta, tb };
}

/** 一段（起始、最高、结束速度，加速段、减速段时长，总时长 T，可以是无穷）在第 tau 秒走过的路程和速度 */
function prof(v0: number, vp: number, v1: number, ta: number, tb: number, T: number, tau: number, out: number[]): void {
  const tc = Math.max(0, T - ta - tb);
  const u = Math.max(0, Math.min(T, tau));
  if (u < ta) {
    const a = (vp - v0) / ta;
    out[0] = v0 * u + 0.5 * a * u * u;
    out[1] = v0 + a * u;
  } else if (u < ta + tc) {
    out[0] = ((v0 + vp) / 2) * ta + vp * (u - ta);
    out[1] = vp;
  } else {
    const t3 = Math.min(tb, u - ta - tc);
    const a = tb > 0 ? (v1 - vp) / tb : 0;
    out[0] = ((v0 + vp) / 2) * ta + vp * tc + vp * t3 + 0.5 * a * t3 * t3;
    out[1] = vp + a * t3;
  }
}
const TMP = [0, 0];
/** 把一段截成 [u0, u1] 这一截：新一段的 [起始速度, 最高速度, 结束速度, 加速段, 减速段, 时长, 原来走到 u0 的路程, 走到 u1 的路程] */
function cutProf(v0: number, vp: number, v1: number, ta: number, tb: number, T: number, u0: number, u1: number, out: number[]): void {
  const tc = Math.max(0, T - ta - tb);
  prof(v0, vp, v1, ta, tb, T, u0, TMP);
  const x0 = TMP[0] as number;
  const w0 = TMP[1] as number;
  prof(v0, vp, v1, ta, tb, T, u1, TMP);
  let ta2: number;
  let vp2: number;
  let tb2: number;
  if (u0 < ta) {
    if (u1 <= ta) [ta2, vp2, tb2] = [u1 - u0, TMP[1] as number, 0];
    else [ta2, vp2, tb2] = [ta - u0, vp, Math.max(0, u1 - ta - tc)];
  } else if (u0 < ta + tc) [ta2, vp2, tb2] = [0, vp, Math.max(0, u1 - ta - tc)];
  else [ta2, vp2, tb2] = [0, w0, u1 - u0];
  out[0] = w0;
  out[1] = vp2;
  out[2] = TMP[1] as number;
  out[3] = ta2;
  out[4] = tb2;
  out[5] = u1 - u0;
  out[6] = x0;
  out[7] = TMP[0] as number;
}

/**
 * 车长（真实尺寸，车头到车尾）、车宽：小汽车、大一点的乘用车（SUV、MPV、皮卡、厢式车）、公交车、平头厢式货车、半挂车
 * （半挂车按最长的长头牵引车 + 13.6 米挂车留车距）。画出来的车型见 vehicles.ts 的 trafficLook。
 */
export const CAR_LEN = [4.6, 5, 12.2, 7.8, 18.1];
export const CAR_W = [1.8, 1.9, 2.5, 2.4, 2.55];
/**
 * 货车（平头厢式货车、半挂车）：只在过路的车流里。车速、加减速和大一点的乘用车一样：
 * 这个车流模型不超车，慢车后面会长时间排成一串（真实的路上小汽车会超过去）。
 */
const HEAVY = 3;
/** 第 k 趟过路的车是不是货车：按车次编号的确定性随机数（不占用出行的随机数序列） */
function heavyDraw(k: number, seed: number): number {
  let h = Math.imul(k ^ 0x51ed270b, 0x9e3779b1) ^ Math.imul((seed | 0) + 0x2545f491, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}
const BUS_LEN = CAR_LEN[2] as number;
const BUS_W = CAR_W[2] as number;
/**
 * 跟车：停着时前后车之间留的空当（米）、反应时间（秒）。沙盘里路程和车速都是真实的 1/10，车按真实大小画，
 * 所以车头间距 = 前车车长 + 空当 + 车速 × 反应时间（车速是沙盘的米 / 秒）。
 */
const GAP0 = 2.4;
const TAU = 1.2;
/** 加速度、减速度（沙盘米 / 秒²：距离压缩成 1/10，是真实的 1/10）：小汽车、大一点的乘用车、公交车、厢式货车、半挂车 */
const ACC = [0.16, 0.14, 0.09, 0.14, 0.14];
const DEC = [0.24, 0.22, 0.15, 0.22, 0.22];
/** 过路的车里货车的比例（按公开资料取的假设参数）：平头厢式货车、半挂车 */
const THROUGH_BOX = 0.09;
const THROUGH_SEMI = 0.13;
/** 每小时出发的车次占全天的比例（早晚高峰）：过路的车按它排 */
const HOURLY = [0.6, 0.4, 0.3, 0.3, 0.5, 1.2, 3.0, 6.5, 7.5, 5.2, 4.6, 4.8, 5.0, 4.8, 4.7, 5.2, 6.4, 7.6, 7.0, 5.0, 3.6, 2.6, 1.8, 1.1];
/** 停车场里的车速：通道里、拐进车位、倒车（和进出场的路上的车速接近）；道闸前停多久、倒出车位后换挡停多久（秒） */
const LOT_V = 1.2;
const TURN_V = 0.7;
const REV_V = 0.5;
const BARRIER_WAIT = 2.5;
const GEAR = 0.8;
/** 停车场是真实尺寸：起步、刹车按真实的加减速（米 / 秒²） */
const LOT_ACC = 0.7;
const LOT_DEC = 0.9;
/** 每小时有多少停着的车开走（再有别的车停进来）：员工停车场按班次走，城区停车场一直有人来有人走 */
const TURNOVER: Record<Lot['use'], number> = { staff: 0.025, hold: 0, public: 0.36, station: 0.08, home: 0 };
/** 路线的代价（秒）：转弯、掉头、过信号灯路口（平均等灯） */
const TURN_COST = 3;
const UTURN_COST = 30;
const SIGNAL_COST = 14;
/** 一段的字段数：开始、结束时刻、路径、起止位置、起始 / 最高 / 结束速度、加速段、减速段、转向灯、在哪 */
const W = 12;
/**
 * 公交：车速（按道路车速打折）、港湾两头的渐变段长、港湾让出多宽（停靠时车身中心离最右车道中心；车身左边离开车道上的车）、
 * 进站车速、中途站停靠的秒数、首末站至少歇多久（秒）
 */
const BUS_SPEED = 0.85;
const TAPER = 14;
const BAY_OFF = 3.3;
const BAY_IN_V = 0.7;
const DWELL: [number, number] = [20, 40];
/** 公交站离门店路口至少多远（米）：站里停着、进出港湾的公交车不挡在门店的车前面 */
const STORE_BUS_GAP = 60;
/**
 * 门店路口左转进进店路的那几条腿（两条车道以上的干道）：门店的车从这条腿开过来（最里面那条车道只给它们），也从这里右转出去。
 * 只看道路网的几何（从路口出去的方向，叉积小于 0 是左转，和 turnOf 一样）
 */
function storeLeftLegs(net: RoadNet): { line: number; end: 'a' | 'b' }[] {
  const out: { line: number; end: 'a' | 'b' }[] = [];
  for (const at of net.storeAttach.values()) {
    const J = net.junctions.get(at.junction);
    const gate = J?.legs.find((lg) => {
      const l = net.lines[lg.line] as Line;
      return l.ja.endsWith(':gate') || l.jb.endsWith(':gate');
    });
    if (!J || !gate) continue;
    const dir = (lg: { line: number; end: 'a' | 'b' }) => {
      const l = net.lines[lg.line] as Line;
      const n = l.pts.length;
      const [p, q] = lg.end === 'a' ? [l.pts[0] as V3, l.pts[1] as V3] : [l.pts[n - 1] as V3, l.pts[n - 2] as V3];
      return { x: q.x - p.x, z: q.z - p.z };
    };
    const g = dir(gate);
    for (const lg of J.legs) {
      if (lg === gate || (net.lines[lg.line] as Line).xs.lanes < 2) continue;
      const o = dir(lg);
      if (-o.x * g.z + o.z * g.x < 0) out.push({ line: lg.line, end: lg.end });
    }
  }
  return out;
}
/** 公交车出站最多找几轮空当（找不到才硬挤进车道） */
const BUS_TRIES = 48;
const LAYOVER_MIN = 90;
/** 港湾的一半长：两头渐变段 + 能排下 n 辆公交（车头停在出口渐变段前 1 米） */
const bayHalf = (n: number) => (2 * TAPER + 1 + BUS_LEN + (n - 1) * (BUS_LEN + GAP0) + 2) / 2;

/** 一个停车场在算车流时的状态：哪个车位停着哪辆车，车位进出的路径 */
interface LotRun {
  lot: Lot;
  /** 进场的弧（进出场的路往场口方向）、出场的弧 */
  inArc: number;
  outArc: number;
  parked: (number | undefined)[];
  /** 每个车位：从进场车道的终点开进车位的路径、倒出车位的路径、开出场口接出场车道的路径 */
  park: number[];
  back: number[];
  out: number[];
  /** 道闸在进场、出场路径上的位置（没有道闸是 −1） */
  barIn: number[];
  barOut: number[];
  /** 满了的车绕场内通道一圈的路径（从进场车道的终点进去、绕一圈接出场车道；有道闸的场没有，−1） */
  loop: number;
}
/**
 * 小街路边的一个车位（纵向停车）：在哪条弧的最右车道旁边、进出的路径 path（车位后面 → 车头停的位置 pRest → S 形弯到车道上 pY
 * → 沿车道再开一个车长到 pX）。来停的车在车道上停在 sX（pX 那一点），挂倒挡沿 path 倒进车位；走的车沿 path 往前开到 pY，在 sY 并进车道
 */
interface CurbBay {
  arc: number;
  pid: number;
  path: number;
  sY: number;
  sX: number;
  pRest: number;
  pY: number;
  pX: number;
  line: number;
  x: number;
  z: number;
  /** 停着的车、已经定了要来停的车 */
  car?: number;
  claim?: number;
}
/** 一条公交线路一圈的路线：依次开的弧、每条弧开到头要不要进站（站的编号）、开到首末站的那条弧的下标 */
interface BusRoute {
  line: number;
  route: number[];
  stopAfter: (string | undefined)[];
  kA: number;
  kB: number;
  ids: [string, string];
  cap: [number, number];
  fleet: number;
}
/** 一辆车在算车流时的状态 */
interface Car {
  id: number;
  track: CarTrack;
  segs: number[];
  kind: number;
  len: number;
  arc: number;
  lane: number;
  t: number;
  /** 此刻的速度（进车道时） */
  v: number;
  /** 进的这条车道上的预约（进车道的时刻、先后） */
  res?: Res;
  /** 目的地（停车场的场口或高速口）、去的停车场 */
  dest: string;
  destLot?: LotRun;
  /** 路线偏好（每辆车不一样，避免都挤在同一条路上） */
  noise: number;
  /** 停着的车位：停车场、车位、停在哪条路径的哪个位置、从几点开始停 */
  park?: { run: LotRun; bay: number; path: number; s: number; since: number; out?: number };
  /** 住户的车：家在哪个小区停车场；hold 以前（晚上回家）不被别的出行挑走 */
  home?: LotRun;
  hold?: number;
  /** 开出区域、停到这一天结束：轨迹收尾 */
  done?: boolean;
  bus?: BusRun;
  /** 要去停的路边车位、停着的路边车位（从几点开始）、家门口的路边车位（住户的车晚上回来停在附近） */
  curb?: CurbBay;
  curbAt?: { cb: CurbBay; since: number };
  homeCurb?: CurbBay;
  /** 去路边车位时先开到这条弧（它的尽头能转进车位那条弧）的起点；绕了几次 */
  curbVia?: number;
  curbTries?: number;
  /** 长路段开到半路的检查点：这条车道从哪接着定（车道起点那一段的下标、前车、开到的位置） */
  resume?: { i0: number; s: number; lead: Res | undefined };
}
interface Term {
  stop: string;
  deps: number[];
  next: number;
  cap: number;
  overnight: number;
  other?: Term;
  /** 开进港湾的车什么时候走（过夜的是 Infinity）：港湾里此刻有几辆 */
  inBay: number[];
}
interface BusRun {
  r: BusRoute;
  /** 现在开的是 route 里的第几条弧 */
  k: number;
  terms: Map<string, Term>;
  /** 收车时首末站满了：空车开往的另一个首末站 */
  deadhead?: string;
}
/** 一辆车在一条路径上的预约和轨迹：进去的时刻、速度、车长；定好以后在车的段里的下标 [i0, i1)，离开的时刻、速度、位置 */
interface Res {
  t: number;
  v: number;
  len: number;
  car: Car | undefined;
  i0: number;
  i1: number;
  tx: number;
  vx: number;
  sx: number;
  /** 离开这条路径以后接着开的那几段（转弯路径、公交港湾；位置接在 sx 后面），后车在路口前跟车按它算 */
  c0?: number;
  c1?: number;
  /** 在哪条车道上预约的、那条车道的限速（只有预约、还没开进来的车要按它们估位置） */
  pid?: number;
  vc?: number;
  /** 仿真车（轨迹定死，背景车让它） */
  truck?: boolean;
  /** 停进路边车位的车：开出这条车道的轨迹以后停在 sx 倒车，gone 以后倒进车位、不再挡后面的车 */
  gone?: number;
}
/** 停车场里的一次进场或出场（在车的段里的下标、起止时刻） */
interface Move {
  car: Car;
  k0: number;
  k1: number;
  t0: number;
  t1: number;
}
interface Front {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/**
 * 仿真车（区域车辆层的货车、配送车）在路上的一段行驶：速度曲线（时刻、路径上的位置、速度，两点之间匀加速）和走过的道路弧
 * （motion.ts 的 roadSpans：线、方向、车道，路径位置和线上坐标一对对）。社会车流把它当成车道上占着位置、不会让人的车：
 * 后面的车跟着它、在红灯前排在它后面，在它前面进车道的车要一路开在它前面，不然等它过去再进。
 */
export interface TruckRun {
  len: number;
  tu: Float64Array;
  us: Float32Array;
  tv: Float32Array;
  spans: { line: number; dir: 1 | -1; lane: number; us: number[]; ss: number[] }[];
}

/** 算好的一天社会车流（可以在后台线程里算好传回来）：所有车的段首尾相接放在几个数组里，用到的路径的点拍平 */
export interface TrafficData {
  /** 每辆车：种类、颜色、公交线路（−1 不是公交）、起止时刻、第一段的下标、段数 */
  kind: Uint8Array;
  color: Uint8Array;
  line: Int16Array;
  t0: Float64Array;
  t1: Float64Array;
  off: Int32Array;
  n: Int32Array;
  segT0: Float64Array;
  segT1: Float64Array;
  segP: Int32Array;
  segS0: Float32Array;
  segS1: Float32Array;
  segV0: Float32Array;
  segVp: Float32Array;
  segV1: Float32Array;
  segTa: Float32Array;
  segTb: Float32Array;
  segTurn: Int8Array;
  segLot: Uint8Array;
  /** 路径：每条路径第一个点的下标（多一个收尾），点的坐标、累计路程 */
  pOff: Int32Array;
  pX: Float32Array;
  pY: Float32Array;
  pZ: Float32Array;
  pCum: Float32Array;
  barriers: [string, number[]][];
  busStops: BusStop[];
  busLines: BusLine[];
  stats: Traffic['stats'];
}
/** TrafficData 里要转交（不复制）的数组 */
export function trafficTransfer(d: TrafficData): ArrayBuffer[] {
  return [d.kind, d.color, d.line, d.t0, d.t1, d.off, d.n, d.segT0, d.segT1, d.segP, d.segS0, d.segS1, d.segV0, d.segVp, d.segV1, d.segTa, d.segTb, d.segTurn, d.segLot, d.pOff, d.pX, d.pY, d.pZ, d.pCum].map((a) => a.buffer as ArrayBuffer);
}

/** 播放：按时刻查每辆背景车的位置、朝向和车灯（数据由 TrafficPlanner 算好，可以来自后台线程） */
export class Traffic {
  cars: CarTrack[] = [];
  busLines: BusLine[] = [];
  busStops: BusStop[] = [];
  /**
   * 统计（测试和调试用）：出行（停车场出发 + 高速口进来）、公交发车、公交中途站停靠；
   * 被迫急停（进车道时离前车太近）、没等到空当硬挤进去、停车场里等不到通道空出来
   */
  stats = { trips: 0, busTrips: 0, busDwells: 0, forced: 0, stalled: 0, squeezed: 0, lotWait: 0, circled: 0, trucks: 0, yielded: 0, curbOut: 0, curbIn: 0, revIn: 0, lotIn: 0 };
  /** 道闸抬杆的时段（停车场编号:in / :out → 开、关、开、关……），停车场的道闸按它画 */
  barrierUp = new Map<string, number[]>();
  /** 按小时分桶：每帧只看这个小时在场的车（停在车位上的也算） */
  byHour: number[][] = [];
  protected pOff = new Int32Array(1);
  protected pX = new Float32Array(0);
  protected pY = new Float32Array(0);
  protected pZ = new Float32Array(0);
  protected pCum = new Float32Array(0);

  static from(d: TrafficData): Traffic {
    const tr = new Traffic();
    [tr.pOff, tr.pX, tr.pY, tr.pZ, tr.pCum] = [d.pOff, d.pX, d.pY, d.pZ, d.pCum];
    for (let i = 0; i < d.kind.length; i++) {
      const a = d.off[i] as number;
      const b = a + (d.n[i] as number);
      tr.cars.push({
        kind: d.kind[i] as number,
        color: d.color[i] as number,
        line: d.line[i] as number,
        t0: d.t0[i] as number,
        t1: d.t1[i] as number,
        segT0: d.segT0.subarray(a, b),
        segT1: d.segT1.subarray(a, b),
        segP: d.segP.subarray(a, b),
        segS0: d.segS0.subarray(a, b),
        segS1: d.segS1.subarray(a, b),
        segV0: d.segV0.subarray(a, b),
        segVp: d.segVp.subarray(a, b),
        segV1: d.segV1.subarray(a, b),
        segTa: d.segTa.subarray(a, b),
        segTb: d.segTb.subarray(a, b),
        segTurn: d.segTurn.subarray(a, b),
        segLot: d.segLot.subarray(a, b),
      });
    }
    tr.barrierUp = new Map(d.barriers);
    tr.busStops = d.busStops;
    tr.busLines = d.busLines;
    tr.stats = d.stats;
    tr.index();
    return tr;
  }

  protected index(): void {
    this.byHour = [];
    this.cars.forEach((c, i) => {
      for (let h = Math.max(0, Math.floor(c.t0 / 3600)); h <= Math.min(25, Math.floor(c.t1 / 3600)); h++) (this.byHour[h] ??= []).push(i);
    });
  }

  activeAt(t: number): readonly number[] {
    return this.byHour[Math.max(0, Math.min(25, Math.floor(t / 3600)))] ?? [];
  }

  /** 停车场进场（key = 编号:in）或出场（编号:out）一侧的道闸此刻是不是抬着 */
  barrierRaised(key: string, t: number): boolean {
    const list = this.barrierUp.get(key);
    if (!list) return false;
    for (let i = 0; i + 1 < list.length; i += 2) if (t >= (list[i] as number) && t <= (list[i + 1] as number)) return true;
    return false;
  }

  /** 路径 pid 上路程 s 处的点（超出两头按端点的方向往外延）和方向 */
  protected at(pid: number, s: number, out: { x: number; y: number; z: number; dx: number; dz: number }): void {
    const a0 = this.pOff[pid] as number;
    const a1 = (this.pOff[pid + 1] as number) - 1;
    const X = this.pX;
    const Z = this.pZ;
    const C = this.pCum;
    if (a1 <= a0) {
      out.x = X[a0] as number;
      out.y = this.pY[a0] as number;
      out.z = Z[a0] as number;
      out.dx = 1;
      out.dz = 0;
      return;
    }
    const total = C[a1] as number;
    const ss = Math.max(0, Math.min(total, s));
    let lo = a0;
    let hi = a1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if ((C[m] as number) <= ss) lo = m;
      else hi = m;
    }
    const d = (C[hi] as number) - (C[lo] as number) || 1;
    const k = Math.max(0, Math.min(1, (ss - (C[lo] as number)) / d));
    const ex = (X[hi] as number) - (X[lo] as number);
    const ez = (Z[hi] as number) - (Z[lo] as number);
    const el = Math.hypot(ex, ez) || 1;
    out.dx = ex / el;
    out.dz = ez / el;
    const over = s < 0 ? s : s > total ? s - total : 0;
    out.x = (X[lo] as number) + ex * k + out.dx * over;
    out.y = (this.pY[lo] as number) + ((this.pY[hi] as number) - (this.pY[lo] as number)) * k;
    out.z = (Z[lo] as number) + ez * k + out.dz * over;
  }

  /**
   * 车尾的位置：从车头（第 k 段、路径上的位置 sF）沿走过的路往回量 len，可能落在前一条、前几条路径上；
   * 倒车的段车尾在路径的低处一侧；量到这辆车的第一段、或者前面是倒车的段，就沿那条路径起点的方向往后延
   */
  private rearOf(c: CarTrack, k: number, sF: number, len: number, out: { x: number; y: number; z: number; dx: number; dz: number }): void {
    if ((c.segS1[k] as number) < (c.segS0[k] as number) - 1e-6) {
      this.at(c.segP[k] as number, Math.max(0, sF - len), out);
      return;
    }
    let need = len;
    let kk = k;
    let ss = sF;
    for (;;) {
      const moved = ss - (c.segS0[kk] as number);
      if (moved >= need) return this.at(c.segP[kk] as number, ss - need, out);
      const prev = kk - 1;
      if (prev < 0 || (c.segS1[prev] as number) < (c.segS0[prev] as number) - 1e-6) return this.at(c.segP[kk] as number, ss - need, out);
      need -= Math.max(0, moved);
      ss = c.segS1[prev] as number;
      kk = prev;
    }
  }

  /**
   * 车在时刻 t 的位置、朝向、刹车灯（减速或停着）、转向灯和倒车灯（不在场返回 false）；
   * 轨迹记的是车头，back 是车长（车模型的原点在车尾）：车尾沿走过的路往回量（可能在前一条路径上），车身朝向车尾指向车头。
   * 倒车的段车头朝向不变，沿路径往回走；在车位上停着、首末站过夜的不亮灯。
   */
  pose(c: CarTrack, t: number, out: TrafficPose, back = 0): boolean {
    if (t < c.t0 || t > c.t1) return false;
    const n = c.segT0.length;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((c.segT0[mid] as number) <= t) lo = mid;
      else hi = mid - 1;
    }
    const t0 = c.segT0[lo] as number;
    const t1 = c.segT1[lo] as number;
    const s0 = c.segS0[lo] as number;
    const dS = (c.segS1[lo] as number) - s0;
    const D = Math.abs(dS);
    const T = Math.max(0, t1 - t0);
    const tau = Math.max(0, Math.min(T, t - t0));
    const v0 = c.segV0[lo] as number;
    const vp = c.segVp[lo] as number;
    const v1 = c.segV1[lo] as number;
    const ta = c.segTa[lo] as number;
    const tb = c.segTb[lo] as number;
    const tc = Math.max(0, T - ta - tb);
    let x: number;
    let v: number;
    let acc: number;
    if (tau < ta) {
      acc = (vp - v0) / ta;
      x = v0 * tau + 0.5 * acc * tau * tau;
      v = v0 + acc * tau;
    } else if (tau < ta + tc) {
      acc = 0;
      x = ((v0 + vp) / 2) * ta + vp * (tau - ta);
      v = vp;
    } else {
      const t3 = Math.min(tb, tau - ta - tc);
      acc = tb > 0 ? (v1 - vp) / tb : 0;
      x = ((v0 + vp) / 2) * ta + vp * tc + vp * t3 + 0.5 * acc * t3 * t3;
      v = vp + acc * t3;
    }
    const sF = s0 + Math.sign(dS) * Math.max(0, Math.min(D, x));
    const P = POSE_PT;
    this.at(c.segP[lo] as number, sF, P);
    out.x = P.x;
    out.y = P.y;
    out.z = P.z;
    out.yaw = Math.atan2(-P.dz, P.dx);
    out.headYaw = out.yaw;
    out.v = v;
    out.acc = acc;
    out.odo = sF + lo * 41.7;
    if (back > 0.01) {
      // 车模型的原点在车尾
      const fx = P.x;
      const fz = P.z;
      this.rearOf(c, lo, sF, back, P);
      out.x = P.x;
      out.y = P.y;
      out.z = P.z;
      if (Math.hypot(fx - P.x, fz - P.z) > 0.3) out.yaw = Math.atan2(-(fz - P.z), fx - P.x);
    }
    const kind = Math.min(c.kind, DEC.length - 1);
    const where = c.segLot[lo] as number;
    out.lot = where === 1;
    out.parked = where > 0 && D < 0.01 && T > 60;
    out.rev = dS < -0.01;
    out.brake = (v < 0.03 && !out.parked) || acc < -0.25 * (DEC[kind] as number);
    const tf = c.segTurn[lo] as number;
    out.turn = tf === 2 || tf === -2 || (tf !== 0 && t > t1 - 6) ? Math.sign(tf) : 0;
    return true;
  }
}
const POSE_PT = { x: 0, y: 0, z: 0, dx: 1, dz: 0 };

/**
 * 算一天的社会车流（在网页的后台线程里跑，也可以在 Node 里跑测试）：路网切成弧、公交线路和车站、每辆车的轨迹。
 * 算完以后自己也能播放（pose 等用拍平的路径），data() 把结果打包传给主线程。
 */
export class TrafficPlanner extends Traffic {
  /** 小街路边的车位有进有出（关掉就整天停着，对比用） */
  static curbTurnover = true;
  /** 公共停车场里开过车位再倒进去的车占多少（通道往前通的车位） */
  static reverseIn = 0.15;
  /** 门店路口左转进口道最里面那条车道只给门店的车（关掉：背景车也走这条车道，对比干道通行能力用） */
  static storeLane = true;
  private paths: Path[] = [];
  private arcs: Arc[] = [];
  private out = new Map<string, number[]>();
  private lanePaths = new Map<string, number>();
  /** 车道路径 → 弧 */
  private laneArc = new Map<number, number>();
  private turnPaths = new Map<string, number>();
  private succ: number[][] = [];
  private pred: number[][] = [];
  private toGo = new Map<string, Float64Array>();
  private turnCosts = new Map<number, number>();
  private depths = new Map<string, number>();
  /** 公交站（虚拟路口：在站前后把这个方向的车道断开，公交车走港湾，别的车直行或换车道）、港湾的路径、每条线路一圈的路线 */
  private virt = new Map<string, BusStop>();
  private bayPaths = new Map<string, number>();
  private busRoutes: BusRoute[] = [];

  constructor(private readonly net: RoadNet) {
    super();
    this.build();
    this.planBuses();
  }

  private build(): void {
    this.paths = [];
    this.arcs = [];
    this.out = new Map();
    this.lanePaths = new Map();
    this.laneArc = new Map();
    this.turnPaths = new Map();
    this.toGo = new Map();
    this.turnCosts = new Map();
    this.depths = new Map();
    this.buildArcs();
    this.succ = this.arcs.map((_, a) => this.next(a));
    this.pred = this.arcs.map(() => []);
    this.succ.forEach((list, a) => list.forEach((b) => (this.pred[b] as number[]).push(a)));
  }

  /** 路网切成一段段有向的「弧」：每条路在路口和 T 形路口处断开，双向路两个方向都有；公交站在它那个方向上再断开 */
  private buildArcs(): void {
    const stopsOn = new Map<number, BusStop[]>();
    for (const st of this.virt.values()) {
      const list = stopsOn.get(st.line) ?? [];
      list.push(st);
      stopsOn.set(st.line, list);
    }
    for (const line of this.net.lines) {
      if (line.cls === 'farm') continue;
      const br: { s: number; j: string }[] = [];
      if (!line.closed) br.push({ s: 0, j: line.ja });
      for (const m of line.mids) br.push({ s: m.s, j: m.j });
      if (!line.closed) br.push({ s: line.len, j: line.jb });
      const vs = stopsOn.get(line.id) ?? [];
      for (const dir of [1, -1] as const) {
        if (dir < 0 && line.xs.oneWay) continue;
        const list = [...br, ...vs.filter((st) => st.dir === dir).map((st) => ({ s: st.s, j: st.id }))].sort((a, b) => a.s - b.s);
        const n = list.length;
        const segs = line.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const a = list[i] as { s: number; j: string };
          const b = list[(i + 1) % n] as { s: number; j: string };
          const s1 = line.closed && b.s <= a.s ? b.s + line.len : b.s;
          if (s1 - a.s < 4 || !a.j || !b.j) continue;
          if (dir > 0) this.addArc({ line: line.id, s0: a.s, s1, ja: a.j, jb: b.j, dir: 1, len: s1 - a.s });
          else this.addArc({ line: line.id, s0: s1, s1: a.s, ja: b.j, jb: a.j, dir: -1, len: s1 - a.s });
        }
      }
    }
  }

  private addArc(a: Arc): void {
    const id = this.arcs.length;
    this.arcs.push(a);
    const list = this.out.get(a.ja) ?? [];
    list.push(id);
    this.out.set(a.ja, list);
  }

  /** 弧在 s 处沿行驶方向的方向 */
  private heading(A: Arc, s: number): { x: number; z: number } {
    const line = this.net.lines[A.line] as Line;
    const q = sampleAt(line.pts, line.cum, Math.max(0, Math.min(line.len, s)));
    return { x: q.dx * A.dir, z: q.dz * A.dir };
  }

  /**
   * 从弧 a 到了路口，能接哪些弧：尽头路、平交路口可以掉头（快速路、高速、匝道上不掉头）；立交的分合流点按允许的转向；
   * 匝道口不从匝道掉回匝道；有中央分隔带的路上开出来的 T 形路口（停车场、门店的进出口）只能右进右出；公交站只能接着往前开
   */
  private next(a: number): number[] {
    const A = this.arcs[a] as Arc;
    const j = this.net.junctions.get(A.jb);
    if (!j) return this.virt.has(A.jb) ? [...(this.out.get(A.jb) ?? [])] : [];
    const ring = this.net.ringLine;
    const tag = (x: Arc) => (x.line === ring ? (x.dir > 0 ? 'ring+' : 'ring-') : String(x.line));
    const la = this.net.lines[A.line] as Line;
    const host = j.kind === 'mid' && j.host !== undefined ? (this.net.lines[j.host] as Line) : undefined;
    return (this.out.get(A.jb) ?? []).filter((b) => {
      const B = this.arcs[b] as Arc;
      const lb = this.net.lines[B.line] as Line;
      const uturn = B.line === A.line && B.dir === -A.dir && Math.abs(B.s0 - A.s1) < 1;
      if (uturn) return j.kind === 'end' || (j.kind === 'grade' && j.legs.length >= 3 && la.cls !== 'ramp' && la.cls !== 'ring' && la.cls !== 'highway');
      if (j.kind === 'merge') return !!j.allow?.has(`${tag(A)}>${tag(B)}`);
      if (j.tag === 'terminal' && la.cls === 'ramp' && lb.cls === 'ramp') return false;
      if (host && host.xs.median > 0 && (A.line === host.id) !== (B.line === host.id)) {
        const d0 = this.heading(A, A.s1 - A.dir * 2);
        const d1 = this.heading(B, B.s0 + B.dir * 2);
        if (d0.x * d1.z - d0.z * d1.x < 0) return false;
      }
      return true;
    });
  }

  /** 弧在路口处退让多少：路口的退让距离；T 形路口上的主路不退（转弯从路口中心起）；公交站前后各让出半个港湾 */
  private cut(jid: string, line: Line): number {
    const st = this.virt.get(jid);
    if (st) return st.g;
    const j = this.net.junctions.get(jid) as Junction | undefined;
    if (!j) return 0;
    if ((j.kind === 'mid' || j.kind === 'merge') && j.host === line.id) return j.kind === 'merge' ? 12 : 4;
    return jid === line.ja ? line.trimA : jid === line.jb ? line.trimB : 0;
  }

  private addPath(pts: V3[]): number {
    const cum = cumulative(pts);
    this.paths.push({ pts, cum, len: cum[cum.length - 1] as number });
    return this.paths.length - 1;
  }

  private lanePath(a: number, lane: number): number {
    const key = `${a}:${lane}`;
    const hit = this.lanePaths.get(key);
    if (hit !== undefined) return hit;
    const A = this.arcs[a] as Arc;
    const line = this.net.lines[A.line] as Line;
    const c0 = this.cut(A.ja, line);
    const c1 = this.cut(A.jb, line);
    const s0 = A.s0 + A.dir * c0;
    const s1 = A.s1 - A.dir * c1;
    const ok = (s1 - s0) * A.dir > 2;
    const pts = this.net.lanePath(line, ok ? s0 : A.s0, ok ? s1 : A.s1, lane);
    const id = this.addPath(pts.length > 1 ? pts : [...pts, ...pts.map((p) => p.clone().addScalar(0.1))]);
    this.lanePaths.set(key, id);
    this.laneArc.set(id, a);
    return id;
  }

  /** 沿线 line 从 sFrom 到 sTo（可以逆着线）取一条路径，横向偏移（行进方向右侧为正）随走过的路程 u（总长 U）变 */
  private strip(line: Line, sFrom: number, sTo: number, off: (u: number, U: number) => number, lift: (u: number, U: number) => number = () => 0): V3[] {
    const fwd = sTo >= sFrom;
    const U = Math.abs(sTo - sFrom);
    const n = Math.max(2, Math.ceil(U / 2));
    const pts: V3[] = [];
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * U;
      const s = fwd ? sFrom + u : sFrom - u;
      const q = sampleAt(line.pts, line.cum, s);
      const dx = fwd ? q.dx : -q.dx;
      const dz = fwd ? q.dz : -q.dz;
      const o = off(u, U);
      pts.push(v3(q.p.x - dz * o, line.elev(s) + lift(u, U), q.p.z + dx * o));
    }
    return pts;
  }

  private turnPath(a: number, la: number, b: number, lb: number): number {
    const key = `${a}:${la}>${b}:${lb}`;
    const hit = this.turnPaths.get(key);
    if (hit !== undefined) return hit;
    const A = this.arcs[a] as Arc;
    const B = this.arcs[b] as Arc;
    const st = this.virt.get(A.jb);
    let pts: V3[];
    if (st) {
      // 公交站前后：沿着路走（可以换车道，横向偏移平滑过渡）
      const line = this.net.lines[A.line] as Line;
      const o0 = laneOffset(line.xs, la);
      const o1 = laneOffset(line.xs, lb);
      pts = this.strip(line, st.s - st.dir * st.g, st.s + st.dir * st.g, (u, U) => o0 + (o1 - o0) * smooth(u / U));
    } else {
      const pa = this.paths[this.lanePath(a, la)] as Path;
      const pb = this.paths[this.lanePath(b, lb)] as Path;
      const from = pa.pts[pa.pts.length - 1] as V3;
      const fromPrev = pa.pts[pa.pts.length - 2] ?? from;
      const to = pb.pts[0] as V3;
      const to2 = pb.pts[1] ?? to;
      const d0l = Math.hypot(from.x - fromPrev.x, from.z - fromPrev.z) || 1;
      const d1l = Math.hypot(to2.x - to.x, to2.z - to.z) || 1;
      const d0 = { x: (from.x - fromPrev.x) / d0l, z: (from.z - fromPrev.z) / d0l };
      const d1 = { x: (to2.x - to.x) / d1l, z: (to2.z - to.z) / d1l };
      const j = this.net.junctions.get(A.jb);
      const uturn = A.line === B.line && A.dir === -B.dir;
      if (j?.kind === 'roundabout') pts = [from.clone(), ...this.net.roundaboutPath(j, from, d0, to, d1), to.clone()];
      else pts = bezier(from, d0, to, d1, uturn ? 2.2 : 0.45);
    }
    const id = this.addPath(pts);
    this.turnPaths.set(key, id);
    return id;
  }

  /**
   * 车道 (a, lane) 的尽头（end）或起点有多长一截和这个路口别的路的车道挨着（横向不到 2.6 米：两条路在路口汇得很尖时会有）。
   * 在路口前等的车停在这一截以外，过路口的记录也把这一截算进去
   */
  private boxDepth(a: number, lane: number, end: boolean): number {
    const key = `${a}:${lane}:${end ? 1 : 0}`;
    const hit = this.depths.get(key);
    if (hit !== undefined) return hit;
    const A = this.arcs[a] as Arc;
    const jid = end ? A.jb : A.ja;
    let depth = 0;
    if (this.net.junctions.has(jid)) {
      const P = this.paths[this.lanePath(a, lane)] as Path;
      const xs: number[] = [];
      const zs: number[] = [];
      this.arcs.forEach((B, b) => {
        if (B.line === A.line || (B.ja !== jid && B.jb !== jid)) return;
        for (let lb = 0; lb < (this.net.lines[B.line] as Line).xs.lanes; lb++) {
          const Q = this.paths[this.lanePath(b, lb)] as Path;
          for (let u = 0; u <= Math.min(60, Q.len); u += 1.5) {
            const q = sampleAt(Q.pts, Q.cum, B.jb === jid ? Q.len - u : u);
            xs.push(q.p.x);
            zs.push(q.p.z);
          }
        }
      });
      for (let u = 0; u <= Math.min(60, P.len - 2); u += 1.5) {
        const q = sampleAt(P.pts, P.cum, end ? P.len - u : u);
        for (let i = 0; i < xs.length; i++)
          if (Math.hypot((xs[i] as number) - q.p.x, (zs[i] as number) - q.p.z) < 2.6) {
            depth = u;
            break;
          }
      }
    }
    this.depths.set(key, depth);
    return depth;
  }

  // ———————————————————————— 路线 ————————————————————————

  private arcTime(a: number): number {
    const A = this.arcs[a] as Arc;
    const cls = (this.net.lines[A.line] as Line).cls;
    // 小街只给住在那里、到那里的车走：选路时按慢得多算（过路的车、公交走干道）
    return (A.len / SPEED[cls]) * (cls === 'street' ? 2.5 : 1);
  }

  /** 从弧 a 转到弧 b 的代价（秒）：直行 0，转弯、掉头、过信号灯路口另加 */
  private turnCost(a: number, b: number): number {
    const key = a * 100003 + b;
    const hit = this.turnCosts.get(key);
    if (hit !== undefined) return hit;
    const A = this.arcs[a] as Arc;
    const B = this.arcs[b] as Arc;
    const j = this.net.junctions.get(A.jb);
    let c = j?.signal && j.kind === 'grade' ? SIGNAL_COST : 0;
    if (A.line === B.line && A.dir === -B.dir) c += UTURN_COST;
    else if (A.line !== B.line) {
      const d0 = this.heading(A, A.s1 - A.dir * 2);
      const d1 = this.heading(B, B.s0 + B.dir * 2);
      if (d0.x * d1.x + d0.z * d1.z < 0.85) c += TURN_COST;
    }
    this.turnCosts.set(key, c);
    return c;
  }

  /** 到路口 dest 还要多久（秒）：每条弧从起点开到 dest 的最短用时（含这条弧本身）；到不了是 Infinity */
  private costTo(dest: string): Float64Array {
    const hit = this.toGo.get(dest);
    if (hit) return hit;
    const cost = new Float64Array(this.arcs.length).fill(Infinity);
    const heap: [number, number][] = [];
    const push = (c: number, a: number) => {
      heap.push([c, a]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if ((heap[p] as [number, number])[0] <= c) break;
        heap[i] = heap[p] as [number, number];
        i = p;
      }
      heap[i] = [c, a];
    };
    const pop = (): [number, number] => {
      const top = heap[0] as [number, number];
      const last = heap.pop() as [number, number];
      if (heap.length) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          const mv = (k: number) => (k === i ? last[0] : (heap[k] as [number, number])[0]);
          if (l < heap.length && (heap[l] as [number, number])[0] < mv(m)) m = l;
          if (r < heap.length && (heap[r] as [number, number])[0] < mv(m)) m = r;
          if (m === i) break;
          heap[i] = heap[m] as [number, number];
          i = m;
        }
        heap[i] = last;
      }
      return top;
    };
    this.arcs.forEach((A, a) => {
      if (A.jb === dest) {
        cost[a] = this.arcTime(a);
        push(cost[a] as number, a);
      }
    });
    while (heap.length) {
      const [c, a] = pop();
      if (c > (cost[a] as number)) continue;
      for (const p of this.pred[a] as number[]) {
        const cand = this.arcTime(p) + this.turnCost(p, a) + c;
        if (cand < (cost[p] as number)) {
          cost[p] = cand;
          push(cand, p);
        }
      }
    }
    this.toGo.set(dest, cost);
    return cost;
  }

  /** 从弧 from 沿用时最短的路线开到路口 dest：返回 from 之后依次开的弧（from 本身就到 dest 时为空）；到不了返回 undefined */
  private walk(from: number, dest: string): number[] | undefined {
    const cost = this.costTo(dest);
    const path: number[] = [];
    let a = from;
    for (let guard = 0; guard < 800; guard++) {
      if ((this.arcs[a] as Arc).jb === dest) return path;
      let best = -1;
      let bc = Infinity;
      for (const b of this.succ[a] as number[]) {
        const c = this.turnCost(a, b) + (cost[b] as number);
        if (c < bc) [bc, best] = [c, b];
      }
      if (best < 0 || !Number.isFinite(bc)) return undefined;
      path.push(best);
      a = best;
    }
    return undefined;
  }

  // ———————————————————————— 公交线路 ————————————————————————

  /**
   * 公交线路：从客运站出发，城区的停车场按绕客运站的方位分成两半，各串成一条线（离上一站最近的先到）；
   * 再各开一条到物流园、机场货运区、港口的员工停车场（最多 5 条）。每条线在两个首末站之间往返：
   * 首末站在线路离开客运站 / 终点的第一段能摆下港湾的路上，经过的停车场门口各设一站，中间隔 650 米左右再设一站；
   * 同一个方向上离得近的站几条线共用。配车数按一圈不堵车的用时估（高峰 12 分钟一班）。
   */
  private planBuses(): void {
    const net = this.net;
    const lots = net.lots.filter((l) => !l.truck);
    const hostJ = (lot: Lot): string | undefined => {
      const al = net.lines[lot.line];
      if (!al) return undefined;
      const jid = al.ja === lot.gate ? al.jb : al.ja;
      return net.junctions.get(jid)?.kind === 'mid' ? jid : undefined;
    };
    // 线路的总站：城市客运站；区域里没有客运站时用城区停车场里最靠中间的那个
    const pub = lots.filter((l) => l.use === 'public' && hostJ(l));
    const mid = pub.reduce((a, l) => ({ x: a.x + (l.outline[0] as { x: number }).x / pub.length, z: a.z + (l.outline[0] as { z: number }).z / pub.length }), { x: 0, z: 0 });
    const central = [...pub].sort((a, b) => Math.hypot((a.outline[0] as { x: number }).x - mid.x, (a.outline[0] as { z: number }).z - mid.z) - Math.hypot((b.outline[0] as { x: number }).x - mid.x, (b.outline[0] as { z: number }).z - mid.z))[0];
    // 总站旁边要有能摆首末站的路（城区的干道、支路、街道上够长的一段）：客运站紧挨着立交、匝道、下穿道的，
    // 换城区停车场里最靠中间、旁边有地方的那个当总站（没有客运站时原来就是这么选的，城区停车场至少 4 个才开线）
    const roomy = (j: string) => this.arcs.some((A) => (A.ja === j || A.jb === j) && A.len > 70 && ['arterial', 'local', 'street'].includes((net.lines[A.line] as Line).cls));
    const stationLot = lots.find((l) => l.use === 'station');
    const byCenter = [...pub].sort((a, b) => Math.hypot((a.outline[0] as { x: number }).x - mid.x, (a.outline[0] as { z: number }).z - mid.z) - Math.hypot((b.outline[0] as { x: number }).x - mid.x, (b.outline[0] as { z: number }).z - mid.z));
    const hubLots = [...(stationLot ? [stationLot] : []), ...(stationLot || pub.length >= 4 ? byCenter : [])];
    const station = hubLots.find((l) => { const j = hostJ(l); return !!j && roomy(j); }) ?? (stationLot ?? (pub.length >= 4 ? central : undefined));
    const hub = station ? hostJ(station) : undefined;
    if (!hub) return;
    const posOf = (j: string) => (net.junctions.get(j) as Junction).pos;
    const hp = posOf(hub);
    const nameOf = new Map<string, string>();
    for (const l of lots) {
      const j = hostJ(l);
      if (j) nameOf.set(j, l.use === 'station' ? '客运站' : l.name.replace(/停车场.*$|员工停车场$/, '').replace(/^城区公共/, '城区') || l.name);
    }
    // 城区停车场：按绕客运站的方位排，从最大的空隙处断开，分成两半
    const byAng = lots
      .filter((l) => l.use === 'public')
      .map(hostJ)
      .filter((j): j is string => !!j && j !== hub)
      .map((j) => ({ j, a: Math.atan2(posOf(j).z - hp.z, posOf(j).x - hp.x) }))
      .sort((x, y) => x.a - y.a);
    let cutAt = 0;
    let gapMax = -1;
    byAng.forEach((x, i) => {
      const nx = byAng[i + 1];
      const gap = (nx ? nx.a : (byAng[0] as { a: number }).a + Math.PI * 2) - x.a;
      if (gap > gapMax) [gapMax, cutAt] = [gap, i + 1];
    });
    const around = [...byAng.slice(cutAt), ...byAng.slice(0, cutAt)].map((x) => x.j);
    const chain = (list: string[]): string[] => {
      const left = [...list];
      const outL: string[] = [];
      let p = hp;
      while (left.length) {
        left.sort((x, y) => Math.hypot(posOf(x).x - p.x, posOf(x).z - p.z) - Math.hypot(posOf(y).x - p.x, posOf(y).z - p.z));
        const j = left.shift() as string;
        outL.push(j);
        p = posOf(j);
      }
      return outL;
    };
    const seqs: string[][] = [];
    const parts = around.length >= 6 ? 3 : around.length >= 4 ? 2 : around.length ? 1 : 0;
    for (let k = 0; k < parts; k++) seqs.push(chain(around.slice(Math.round((k * around.length) / parts), Math.round(((k + 1) * around.length) / parts))));
    /** 通勤线：到设施员工停车场的那一头首末站可以摆在设施进场路（高速）的路肩上 */
    const commute = new Set<number>();
    for (const id of ['DC:staff', 'AIR:staff', 'PORT:staff']) {
      const lot = lots.find((l) => l.id === id);
      const j = lot ? hostJ(lot) : undefined;
      if (j && seqs.length < 5) {
        commute.add(seqs.length);
        seqs.push([j]);
      }
    }
    if (!seqs.length) return;

    const stops: BusStop[] = [];
    const G2 = bayHalf(2);
    const storeAt = [...net.storeAttach.values()].map((x) => x.pos);
    /** 弧 a 上能不能摆一个半长 g 的港湾（城区的干道、支路、街道，不在桥上，离路口、门店路口和别的站够远）：返回线上的位置 */
    const spot = (a: number, g: number, prefer: 'start' | 'mid', shoulder = false): number | undefined => {
      const A = this.arcs[a] as Arc;
      const line = net.lines[A.line] as Line;
      if (line.cls !== 'arterial' && line.cls !== 'local' && line.cls !== 'street' && !(shoulder && line.cls === 'highway')) return undefined;
      // 港湾前后留出够排两三辆车的车道（首末站留得更长）：路口排的队不压到港湾口
      const room = g > bayHalf(2) + 1 ? 45 : 30;
      const c0 = this.cut(A.ja, line) + g + room;
      const c1 = this.cut(A.jb, line) + g + room;
      if (A.len < c0 + c1) return undefined;
      const s = A.s0 + A.dir * (prefer === 'start' ? c0 : (c0 + A.len - c1) / 2);
      if (line.elev(s - g) > 0.2 || line.elev(s) > 0.2 || line.elev(s + g) > 0.2) return undefined;
      if (line.bridges.some((br) => s + g > br.s0 - 15 && s - g < br.s1 + 15)) return undefined;
      if (stops.some((st) => st.line === A.line && st.dir === A.dir && Math.abs(st.s - s) < st.g + g + 20)) return undefined;
      const q = sampleAt(line.pts, line.cum, s).p;
      if (storeAt.some((x) => Math.hypot(x.x - q.x, x.z - q.z) < STORE_BUS_GAP + g)) return undefined;
      return s;
    };
    const addStop = (a: number, s: number, g: number, terminal: boolean, li: number, name: string): string => {
      const A = this.arcs[a] as Arc;
      const id = `BUS:${stops.length}`;
      stops.push({ id, name, line: A.line, s, dir: A.dir as 1 | -1, g, terminal, lines: [li], bay: [], stopAt: 0, shelter: v3(0, 0, 0), sign: v3(0, 0, 0), heading: 0 });
      return id;
    };
    const into = (j: string) => this.arcs.map((A, i) => (A.jb === j ? i : -1)).filter((i) => i >= 0);
    const thread = (a0: number, seq: string[]): number[] | undefined => {
      const outL: number[] = [];
      let a = a0;
      for (const j of seq) {
        const p = this.walk(a, j);
        if (!p) return undefined;
        outL.push(...p);
        if (p.length) a = p[p.length - 1] as number;
      }
      return outL;
    };
    const defs: { li: number; ids: string[]; cap: [number, number]; fleet: number; cycle: number }[] = [];
    // 另一头摆不下首末站（总站旁边的路已经被别的线占了，或者紧挨着立交）时，这条线改从附近的城区停车场发车
    const altHubs = pub.map(hostJ).filter((j): j is string => !!j && j !== hub && roomy(j)).sort((x, y) => Math.hypot(posOf(x).x - hp.x, posOf(x).z - hp.z) - Math.hypot(posOf(y).x - hp.x, posOf(y).z - hp.z));
    const mainHub = hub;
    const planLine = (seq: string[], li: number, hub: string): boolean => {
      let best: { fwd: number[]; back: number[]; len: number } | undefined;
      for (const a0 of into(hub)) {
        const fwd = thread(a0, seq);
        if (!fwd || !fwd.length) continue;
        const back = thread(fwd[fwd.length - 1] as number, [...seq.slice(0, -1).reverse(), hub]);
        if (!back || !back.length) continue;
        const len = [...fwd, ...back].reduce((s, a) => s + (this.arcs[a] as Arc).len, 0);
        if (!best || len < best.len) best = { fwd, back, len };
      }
      if (!best) return false;
      const route = best;
      // 一圈不堵车的用时：公交车速、每站停 35 秒、首末站各歇 4 分钟，再放宽 25%；高峰 12 分钟一班
      const run = [...route.fwd, ...route.back].reduce((s, a) => s + this.arcTime(a) / BUS_SPEED, 0);
      const cycle = (run + (Math.round(route.len / 650) + seq.length * 2) * 35 + 480) * 1.25;
      const want = Math.max(2, Math.min(9, Math.ceil(cycle / 720) + 1));
      const mark = stops.length;
      const ids: string[] = [];
      const term = (list: number[], cap0: number, name: string, shoulder = false): { id: string; cap: number; k: number } | undefined => {
        for (let cap = cap0; cap >= 1; cap--) {
          for (let k = 0; k < Math.min(list.length, 6); k++) {
            const s = spot(list[k] as number, bayHalf(cap), 'start', shoulder);
            if (s !== undefined) return { id: addStop(list[k] as number, s, bayHalf(cap), true, li, name), cap, k };
          }
        }
        return undefined;
      };
      const along = (list: number[], k0: number, anchors: Set<string>) => {
        let since = 0;
        for (let k = k0 + 1; k < list.length; k++) {
          const a = list[k] as number;
          const A = this.arcs[a] as Arc;
          const prev = (this.arcs[list[k - 1] as number] as Arc).jb;
          const leaving = anchors.has(prev);
          since += A.len;
          if (!leaving && since < 650) continue;
          const lo = Math.min(A.s0, A.s1);
          const hi = Math.max(A.s0, A.s1);
          const shared = stops.find((st) => !st.terminal && st.line === A.line && st.dir === A.dir && st.s > lo && st.s < hi);
          if (shared) {
            if (!shared.lines.includes(li)) shared.lines.push(li);
            if (ids[ids.length - 1] !== shared.id) ids.push(shared.id);
            since = 0;
            continue;
          }
          const s = spot(a, G2, leaving ? 'start' : 'mid');
          if (s === undefined) continue;
          ids.push(addStop(a, s, G2, false, li, leaving ? (nameOf.get(prev) ?? '') : ''));
          since = 0;
        }
      };
      const last = seq[seq.length - 1] as string;
      const tA = term(route.fwd, want, hub === mainHub ? '客运站' : (nameOf.get(hub) ?? '客运站'));
      const tB = tA ? term(route.back, Math.ceil(want / 2), nameOf.get(last) ?? '', commute.has(li)) : undefined;
      if (!tA || !tB) {
        stops.splice(mark);
        for (const st of stops) st.lines = st.lines.filter((x) => x !== li);
        return false;
      }
      ids.push(tA.id);
      along(route.fwd, tA.k, new Set(seq));
      ids.push(tB.id);
      along(route.back, tB.k, new Set([...seq.slice(0, -1), hub]));
      defs.push({ li, ids, cap: [tA.cap, tB.cap], fleet: Math.min(want, tA.cap + tB.cap), cycle });
      return true;
    };
    seqs.forEach((seq, li) => {
      for (const from of [hub, ...altHubs.filter((j) => !seq.includes(j))].slice(0, 4)) if (planLine(seq, li, from)) return;
    });
    if (!defs.length) return;

    // 车站断开车道，重建路网的弧；港湾的路径
    this.virt = new Map(stops.map((st) => [st.id, st]));
    this.build();
    for (const st of stops) {
      const line = net.lines[st.line] as Line;
      const o = laneOffset(line.xs, 0);
      const ramp = (u: number, U: number) => smooth(Math.min(u, U - u) / TAPER);
      const pts = this.strip(line, st.s - st.dir * st.g, st.s + st.dir * st.g, (u, U) => o + BAY_OFF * ramp(u, U));
      this.bayPaths.set(st.id, this.addPath(pts));
      st.bay = pts;
      st.stopAt = 2 * st.g - TAPER - 1;
      const q = sampleAt(line.pts, line.cum, st.s);
      const dx = q.dx * st.dir;
      const dz = q.dz * st.dir;
      st.heading = Math.atan2(dz, dx);
      // 雨棚在港湾外侧的人行道上，站牌在公交车车头停的地方
      const side = o + BAY_OFF + BUS_W / 2 + 1.3;
      st.shelter = v3(q.p.x - dz * side, line.elev(st.s), q.p.z + dx * side);
      const qs = sampleAt(line.pts, line.cum, st.s + st.dir * (st.stopAt - st.g));
      const sideS = o + BAY_OFF + BUS_W / 2 + 0.7;
      st.sign = v3(qs.p.x - qs.dz * st.dir * sideS, line.elev(st.s), qs.p.z + qs.dx * st.dir * sideS);
    }
    // 每条线一圈的路线（在断开以后的路网上）：首末站 A → 去程各站 → 首末站 B → 回程各站 → A
    const used = new Set<string>();
    for (const d of defs) {
      const ids = d.ids.filter((id, i) => id !== d.ids[(i + 1) % d.ids.length]);
      const iB = ids.indexOf(d.ids.find((id) => (this.virt.get(id) as BusStop).terminal && id !== ids[0]) as string);
      if (iB <= 0) continue;
      const route: number[] = [];
      const stopAfter: (string | undefined)[] = [];
      let kB = -1;
      let ok = true;
      for (let i = 0; i < ids.length && ok; i++) {
        const to = ids[(i + 1) % ids.length] as string;
        const start = (this.out.get(ids[i] as string) ?? [])[0];
        const rest = start === undefined ? undefined : this.walk(start, to);
        if (start === undefined || !rest) {
          ok = false;
          break;
        }
        for (const a of [start, ...rest]) {
          route.push(a);
          stopAfter.push(undefined);
        }
        stopAfter[stopAfter.length - 1] = to;
        if (i + 1 === iB) kB = route.length - 1;
      }
      if (!ok || kB < 0) continue;
      const li = this.busLines.length;
      for (const id of ids) used.add(id);
      for (const st of stops) st.lines = st.lines.map((x) => (x === d.li ? li + 1000 : x));
      this.busRoutes.push({ line: li, route, stopAfter, kA: route.length - 1, kB, ids: [ids[0] as string, ids[iB] as string], cap: d.cap, fleet: d.fleet });
      this.busLines.push({ id: li, name: `${li + 1} 路`, color: li, stops: ids, terminals: [0, iB], fleet: d.fleet, cycleMin: Math.round(d.cycle / 60), cap: d.cap });
    }
    for (const st of stops) st.lines = st.lines.filter((x) => x >= 1000).map((x) => x - 1000);
    this.busStops = stops.filter((st) => used.has(st.id) && st.lines.length);
  }

  // ———————————————————————— 停车场 ————————————————————————

  /** 每个小车停车场：进出场的弧，每个车位进、出、倒车的路径，道闸在路径上的位置 */
  /**
   * 小街路边的一个车位（zoning.ts 划的：车尾 a、车头 b，车头朝这一侧的行驶方向）落在哪条弧的最右车道旁边，铺进出的路径；
   * 离路口太近（车道上放不下停车、倒车的那一截）返回 undefined（整天停着）
   */
  private curbBay(c: { a: V3; b: V3; line: number }, onLine: Map<number, number[]>): CurbBay | undefined {
    const dl = Math.hypot(c.b.x - c.a.x, c.b.z - c.a.z) || 1;
    const d = { x: (c.b.x - c.a.x) / dl, z: (c.b.z - c.a.z) / dl };
    // 进出车位的车要能从别的街开进这条弧、开到头再接着开（死胡同、只能从停车场的进出路掉头的街整天停着）
    const through = (a: number, list: readonly number[]) =>
      list.some((b) => {
        const B = this.arcs[b] as Arc;
        const A = this.arcs[a] as Arc;
        return (this.net.lines[B.line] as Line).cls !== 'service' && !(B.line === A.line && B.dir !== A.dir);
      });
    for (const a of onLine.get(c.line) ?? []) {
      const pid = this.lanePath(a, 0);
      const P = this.paths[pid] as Path;
      // 车头在车道上的投影：横向离车道中线 1.5–4.5 米、方向一致
      let best = Infinity;
      let sb = 0;
      for (let i = 1; i < P.pts.length; i++) {
        const A = P.pts[i - 1] as V3;
        const B = P.pts[i] as V3;
        const ux = B.x - A.x;
        const uz = B.z - A.z;
        const l2 = ux * ux + uz * uz || 1e-9;
        const k = Math.max(0, Math.min(1, ((c.b.x - A.x) * ux + (c.b.z - A.z) * uz) / l2));
        const dd = Math.hypot(c.b.x - A.x - ux * k, c.b.z - A.z - uz * k);
        if (dd < best) [best, sb] = [dd, (P.cum[i - 1] as number) + Math.sqrt(l2) * k];
      }
      const q = sampleAt(P.pts, P.cum, sb);
      if (best < 1.5 || best > 4.5 || q.dx * d.x + q.dz * d.z < 0.8) continue;
      const sY = sb + 4.5;
      const sX = sY + 5.6;
      if (sb < 9 || sX > P.len - 2 || !through(a, this.succ[a] as number[])) return undefined;
      const Y = sampleAt(P.pts, P.cum, sY);
      const y = Y.p.y;
      const b = v3(c.b.x, y, c.b.z);
      const pts: V3[] = [v3(b.x - d.x * 8, y, b.z - d.z * 8), b];
      for (const p of bezier(b, d, Y.p, { x: Y.dx, z: Y.dz }, 0.3, 8).slice(1, -1)) pts.push(p);
      pts.push(Y.p);
      const iY = pts.length - 1;
      for (let u = sY + 1; u < sX - 0.05; u += 1) pts.push(sampleAt(P.pts, P.cum, u).p);
      pts.push(sampleAt(P.pts, P.cum, sX).p);
      const path = this.addPath(pts);
      const cum = (this.paths[path] as Path).cum;
      return { arc: a, pid, path, sY, sX, pRest: cum[1] as number, pY: cum[iY] as number, pX: cum[cum.length - 1] as number, line: c.line, x: b.x, z: b.z };
    }
    return undefined;
  }

  private lotRuns(): LotRun[] {
    const out: LotRun[] = [];
    for (const lot of this.net.lots) {
      if (lot.truck) continue;
      const inArc = this.arcs.findIndex((A) => A.line === lot.line && A.jb === lot.gate);
      const outArc = this.arcs.findIndex((A) => A.line === lot.line && A.ja === lot.gate);
      if (inArc < 0 || outArc < 0) continue;
      const pin = this.paths[this.lanePath(inArc, 0)] as Path;
      const pout = this.paths[this.lanePath(outArc, 0)] as Path;
      const e = pin.pts[pin.pts.length - 1] as V3;
      const e0 = pin.pts[pin.pts.length - 2] ?? e;
      const el = Math.hypot(e.x - e0.x, e.z - e0.z) || 1;
      const inDir = { x: (e.x - e0.x) / el, z: (e.z - e0.z) / el };
      const s = pout.pts[0] as V3;
      const s1 = pout.pts[1] ?? s;
      const sl = Math.hypot(s1.x - s.x, s1.z - s.z) || 1;
      const outDir = { x: (s1.x - s.x) / sl, z: (s1.z - s.z) / sl };
      const bar = lot.barrier;
      // 道闸在路径上的位置：路径上离道闸最近的点（6 米以内才算经过）
      const barS = (pid: number) => {
        if (!bar) return -1;
        const p = this.paths[pid] as Path;
        let best = { d: Infinity, s: -1 };
        p.pts.forEach((q, i) => {
          const d = Math.hypot(q.x - bar.p.x, q.z - bar.p.z);
          if (d < best.d) best = { d, s: p.cum[i] as number };
        });
        return best.d < 6 ? best.s : -1;
      };
      const run: LotRun = { lot, inArc, outArc, parked: lot.bays.map(() => undefined), park: [], back: [], out: [], barIn: [], barOut: [], loop: -1 };
      if (lot.loop && lot.loop.length > 2 && !bar) {
        const L = lot.loop;
        const a0 = L[0] as V3;
        const a1 = L[1] as V3;
        const al = Math.hypot(a1.x - a0.x, a1.z - a0.z) || 1;
        const z0 = L[L.length - 1] as V3;
        const z1 = L[L.length - 2] as V3;
        const zl = Math.hypot(z0.x - z1.x, z0.z - z1.z) || 1;
        run.loop = this.addPath([
          ...bezier(e.clone(), inDir, a0.clone(), { x: (a1.x - a0.x) / al, z: (a1.z - a0.z) / al }, 0.42, 10),
          ...L.slice(1, -1).map((q) => q.clone()),
          ...bezier(z0.clone(), { x: (z0.x - z1.x) / zl, z: (z0.z - z1.z) / zl }, s.clone(), outDir, 0.42, 10),
        ]);
      }
      for (const bay of lot.bays) {
        const p0 = bay.park[0] as V3;
        const p1 = bay.park[1] ?? p0;
        const pl = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
        const park = this.addPath([...bezier(e.clone(), inDir, p0.clone(), { x: (p1.x - p0.x) / pl, z: (p1.z - p0.z) / pl }, 0.42, 10), ...bay.park.slice(1).map((q) => q.clone())]);
        const o0 = bay.out[bay.out.length - 1] as V3;
        const o1 = bay.out[bay.out.length - 2] ?? o0;
        const ol = Math.hypot(o0.x - o1.x, o0.z - o1.z) || 1;
        const outId = this.addPath([...bay.out.map((q) => q.clone()), ...bezier(o0.clone(), { x: (o0.x - o1.x) / ol, z: (o0.z - o1.z) / ol }, s.clone(), outDir, 0.42, 10).slice(1)]);
        run.park.push(park);
        run.back.push(this.addPath(bay.back.length > 1 ? bay.back.map((q) => q.clone()) : [bay.p.clone(), bay.p.clone().addScalar(0.01)]));
        run.out.push(outId);
        run.barIn.push(barS(park));
        run.barOut.push(barS(outId));
      }
      out.push(run);
    }
    return out;
  }

  /**
   * 算一整天：按停车场的占用率排出行（哪辆车几点从哪个车位走、去哪），过路的车按时段分布，公交按时刻表；事件按时间推进。
   * 车进一条车道时就定好在这条车道上怎么开、到路口往哪走（好提前减速、打灯）、什么时候进下一条车道（在那条车道上预约）。
   * trips 是车流密度（平常 9000，按负荷档位放大缩小）。
   */
  /**
   * weather：每个钟点的车速系数（0–24 点，天气下雨、起雾时小于 1）；车进一条车道时按那个钟点的系数开，
   * 仿真车辆（自己的车队）不受影响，它们的时刻来自仿真。
   */
  simulate(trips = 9000, seed = 2026, weather?: readonly number[], trucks: readonly TruckRun[] = []): void {
    const r = rand(seed);
    const wf = (t: number): number => (weather ? Math.max(0.4, Math.min(1, weather[Math.max(0, Math.min(weather.length - 1, Math.floor(t / 3600)))] ?? 1)) : 1);
    const lines = this.net.lines;
    const density = trips / 9000;
    const runs = this.lotRuns();
    const edges = ['MAP_N', 'MAP_E'].filter((id) => this.net.junctions.has(id) && (this.out.get(id) ?? []).length);
    const DAY_END = 26 * 3600;
    const stats = this.stats;
    /** 车道上的预约（按进车道的时刻排）：先来后到，后车跟着前车 */
    const resv = new Map<number, Res[]>();
    /** 转弯路径、公交港湾上最后一辆定好怎么开的车（同一条路径上的车都从同一条车道过来，先后不变） */
    const lastOn = new Map<number, Res>();
    /** 每个停车场里在动的车（进场、出场）：场内通道上互相让 */
    const moves = new Map<string, Move[]>();
    /** 此刻（事件推进到的时刻）：清理用过的记录 */
    let now = 0;
    // 门店路口：左转进进店路的那条进口道，最里面那条车道只给门店的车（排队、左转），背景车、公交车走别的车道
    // （门店的车真走这条车道时才这样：仿真车的预约排好以后看那条车道上有没有它们，见下面）
    const storeLane = new Map<number, number>();
    const phaseOf = (a: Arc): { j: Junction; phase: number } | undefined => {
      const j = this.net.junctions.get(a.jb);
      if (!j || !j.signal || j.kind === 'mid' || j.kind === 'merge') return undefined;
      const line = lines[a.line] as Line;
      const end = a.jb === line.ja ? 0 : 1;
      const p = j.phase.get(a.line * 2 + end);
      return p === undefined ? undefined : { j, phase: p };
    };
    const cars: Car[] = [];
    const newCar = (kind: number, t0: number, color = Math.floor(r() * 10), line = -1, rr = r): Car => {
      const track: CarTrack = {
        kind,
        color,
        line,
        t0,
        t1: t0,
        segT0: new Float64Array(0),
        segT1: new Float64Array(0),
        segP: new Int32Array(0),
        segS0: new Float32Array(0),
        segS1: new Float32Array(0),
        segV0: new Float32Array(0),
        segVp: new Float32Array(0),
        segV1: new Float32Array(0),
        segTa: new Float32Array(0),
        segTb: new Float32Array(0),
        segTurn: new Int8Array(0),
        segLot: new Uint8Array(0),
      };
      const car: Car = { id: cars.length, track, segs: [], kind, len: CAR_LEN[kind] as number, arc: -1, lane: 0, t: t0, v: 0, dest: '', noise: rr() };
      cars.push(car);
      return car;
    };
    // 事件：一个按时刻排的二叉堆（车开进一条车道的时刻）
    const heap: { t: number; car: Car }[] = [];
    const push = (e: { t: number; car: Car }) => {
      heap.push(e);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if ((heap[p] as { t: number }).t <= e.t) break;
        heap[i] = heap[p] as { t: number; car: Car };
        i = p;
      }
      heap[i] = e;
    };
    const pop = () => {
      const top = heap[0] as { t: number; car: Car };
      const last = heap.pop() as { t: number; car: Car };
      if (heap.length) {
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const rr = l + 1;
          let m = i;
          if (l < heap.length && (heap[l] as { t: number }).t < (m === i ? last.t : (heap[m] as { t: number }).t)) m = l;
          if (rr < heap.length && (heap[rr] as { t: number }).t < (m === i ? last.t : (heap[m] as { t: number }).t)) m = rr;
          if (m === i) break;
          heap[i] = heap[m] as { t: number; car: Car };
          i = m;
        }
        heap[i] = last;
      }
      return top;
    };
    const speedOf = (a: number, bus: boolean, t: number) => SPEED[(lines[(this.arcs[a] as Arc).line] as Line).cls] * (bus ? BUS_SPEED : 1) * wf(t);
    const emit = (car: Car, t0: number, t1: number, pid: number, s0: number, s1: number, v0: number, vp: number, v1: number, ta: number, tb: number, turn: number, lot: number) => {
      car.segs.push(t0, t1, pid, s0, s1, v0, vp, v1, ta, tb, turn, lot);
    };

    // —— 跟车 ——
    /** 前车（它在这条路径上的预约和轨迹）在时刻 t 的位置和速度：进路径之前、离开之后按匀速往前后延 */
    let depthEst = 0;
    const leadAt = (rr: Res, t: number, out: number[]): void => {
      if (rr.gone !== undefined && t >= rr.tx) {
        out[0] = t >= rr.gone ? 1e6 : rr.sx;
        out[1] = 0;
        return;
      }
      if (t <= rr.t) {
        out[0] = rr.v * (t - rr.t);
        out[1] = rr.v;
        return;
      }
      if (rr.i1 < 0) {
        // 还没开进这条车道的车（只有预约）：按从进车道时的速度慢慢加速到 1.2 米 / 秒估，
        // 但不会开到它前面那辆车（往后推 TAU 秒、让一个车长加空当）的前头：车道上在排队时，后面的车也得排
        const tau = t - rr.t;
        // 进来以后向这条车道的限速靠：比限速快就按 0.25 米 / 秒² 减下来，慢就按 0.12 加上去
        const vmax = rr.vc ?? Math.max(rr.v, 1.2);
        const acc = rr.v > vmax ? -0.25 : 0.12;
        const ta = Math.abs(vmax - rr.v) / Math.abs(acc);
        let x: number;
        let v: number;
        if (tau < ta) {
          x = rr.v * tau + 0.5 * acc * tau * tau;
          v = rr.v + acc * tau;
        } else {
          x = rr.v * ta + 0.5 * acc * ta * ta + vmax * (tau - ta);
          v = vmax;
        }
        const list = rr.pid === undefined ? undefined : resv.get(rr.pid);
        if (list && depthEst < 12) {
          let i = upper(list, rr.t) - 1;
          while (i >= 0 && list[i] !== rr) i--;
          const pr = i > 0 ? list[i - 1] : undefined;
          if (pr) {
            depthEst++;
            leadAt(pr, t - TAU, out);
            depthEst--;
            const cap = (out[0] as number) - (pr.len + GAP0);
            if (cap < x) [x, v] = [Math.max(cap, Math.min(x, 0)), Math.min(v, out[1] as number)];
          }
        }
        out[0] = x;
        out[1] = v;
        return;
      }
      let lo = rr.i0;
      let hi = rr.i1 - 1;
      let off = 0;
      if (t >= rr.tx || rr.i1 <= rr.i0) {
        const c0 = rr.c0 ?? -1;
        const c1 = rr.c1 ?? -1;
        const hasC = c0 >= 0 && c1 > c0;
        const segs = (rr.car as Car).segs;
        if (!hasC || t >= (segs[(c1 - 1) * W + 1] as number)) {
          // 开出接着的那几段以后：按最后的速度往前延
          const tEnd = hasC ? (segs[(c1 - 1) * W + 1] as number) : rr.tx;
          const sEnd = hasC ? rr.sx + (segs[(c1 - 1) * W + 4] as number) : rr.sx;
          const sp = Math.max(hasC ? (segs[(c1 - 1) * W + 7] as number) : rr.vx, 0.3);
          out[0] = sEnd + sp * (t - tEnd);
          out[1] = sp;
          return;
        }
        lo = c0;
        hi = c1 - 1;
        off = rr.sx;
      }
      const segs = (rr.car as Car).segs;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if ((segs[m * W] as number) <= t) lo = m;
        else hi = m - 1;
      }
      const o = lo * W;
      prof(segs[o + 5] as number, segs[o + 6] as number, segs[o + 7] as number, segs[o + 8] as number, segs[o + 9] as number, (segs[o + 1] as number) - (segs[o] as number), t - (segs[o] as number), out);
      out[0] = off + (segs[o + 3] as number) + (out[0] as number);
    };
    const L2 = [0, 0];
    const L3 = [0, 0];
    const CUT = [0, 0, 0, 0, 0, 0, 0, 0];
    /** 最早的 t ≥ t0 使 lim(t) ≥ target（lim 随时间不减）；等不到返回 Infinity */
    const waitFor = (lim: (t: number) => number, target: number, t0: number): number => {
      if (lim(t0) >= target) return t0;
      let lo = t0;
      let hi = t0 + 1;
      while (lim(hi) < target) {
        lo = hi;
        hi = t0 + (hi - t0) * 2;
        if (hi - t0 > 40 * 3600) return Infinity;
      }
      for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2;
        if (lim(m) >= target) hi = m;
        else lo = m;
      }
      return hi;
    };
    /** 按不跟车的速度曲线 G 开，第一次越过前车那条线的时刻（从 t 起的秒数）；不会越过返回 −1 */
    const firstHit = (G: Kin, v0: number, s: number, t: number, lim: (t: number) => number): number => {
      let prev = 0;
      let tau = 0;
      for (;;) {
        prof(v0, G.vp, G.v1, G.ta, G.tb, G.T, tau, L3);
        const gap = lim(t + tau) - (s + (L3[0] as number));
        if (gap < -0.01) {
          if (tau <= 0) return 0;
          let lo = prev;
          let hi = tau;
          for (let i = 0; i < 14; i++) {
            const m = (lo + hi) / 2;
            prof(v0, G.vp, G.v1, G.ta, G.tb, G.T, m, L3);
            if (lim(t + m) - (s + (L3[0] as number)) < -0.01) hi = m;
            else lo = m;
          }
          return hi;
        }
        if (tau >= G.T) return -1;
        prev = tau;
        // 两车的速度差不超过 3 米 / 秒：离得远就跨大步查
        tau = Math.min(G.T, tau + Math.max(0.25, Math.min(8, gap / 3)));
      }
    };
    /** 一截（起始、最高、结束速度，加速段、减速段，时长）里走到 D 的时刻；走不到返回 Infinity */
    const reach = (v0: number, vp: number, v1: number, ta: number, tb: number, T: number, D: number): number => {
      if (D <= 0) return 0;
      const cap = Number.isFinite(T) ? T : ta + (vp > 1e-6 ? D / vp : Infinity) + 1;
      if (!Number.isFinite(cap)) return Infinity;
      prof(v0, vp, v1, ta, tb, T, cap, L3);
      if ((L3[0] as number) < D - 1e-7) return Infinity;
      let lo = 0;
      let hi = cap;
      for (let i = 0; i < 40; i++) {
        const m = (lo + hi) / 2;
        prof(v0, vp, v1, ta, tb, T, m, L3);
        if ((L3[0] as number) >= D) hi = m;
        else lo = m;
      }
      return hi;
    };
    /** 照这一截开下去，什么时候必须开始刹车（才能在 D 处减到 vEnd）；不用刹返回 Infinity */
    const brakeAt = (v0: number, vp: number, v1: number, ta: number, tb: number, T: number, D: number, vEnd: number, b: number, maxT: number): number => {
      const g = (tau: number) => {
        prof(v0, vp, v1, ta, tb, T, tau, L3);
        const w = L3[1] as number;
        return w <= vEnd ? -1 : w * w - vEnd * vEnd - 2 * b * (D - (L3[0] as number));
      };
      const end = Math.min(maxT, T);
      if (!Number.isFinite(end)) {
        // 匀速往前延的一截
        if (vp <= vEnd) return Infinity;
        return Math.max(0, (D - (vp * vp - vEnd * vEnd) / (2 * b)) / vp);
      }
      if (g(0) >= 0) return 0;
      let prev = 0;
      for (let tau = Math.min(end, 0.5); ; tau = Math.min(end, tau + 0.5)) {
        if (g(tau) >= 0) {
          let lo = prev;
          let hi = tau;
          for (let i = 0; i < 20; i++) {
            const m = (lo + hi) / 2;
            if (g(m) >= 0) hi = m;
            else lo = m;
          }
          return hi;
        }
        if (tau >= end) return Infinity;
        prev = tau;
      }
    };
    /**
     * 沿路径 pid 从 (t, s, v) 开到 sEnd（结束速度不高于 vEnd，限速 vc）。前车 rr 的轨迹往后推 TAU 秒、往回让车长加空当
     * 是这辆车不能越过的线（Newell 跟车）：不跟车能开的就照常开；会追上就提前减速，刹到前车的速度时正好跟在它后面，
     * 然后照着前车的速度变化开（前车停、后车停，前车起步、后车隔 TAU 秒起步）；前车走远了、或者自己到头要减速了再按自己的开。
     * 返回到 sEnd 的时刻（car.v 是那时的速度）。
     */
    const follow = (car: Car, pid: number, t: number, s: number, v: number, sEnd: number, vEnd: number, vc: number, rr: Res | undefined, turn: number, lot: number): number => {
      const a = ACC[car.kind] as number;
      const b = DEC[car.kind] as number;
      const delta = rr ? rr.len + GAP0 : 0;
      const lim = (tt: number): number => {
        leadAt(rr as Res, tt - TAU, L2);
        return (L2[0] as number) - delta;
      };
      let stall = 0;
      for (let guard = 0; guard < 160 && sEnd - s > 1e-4; guard++) {
        const tPrev = t;
        if (!rr || stall >= 3 || lim(t) >= sEnd) {
          if (stall >= 3) stats.stalled++;
          const G = kin(sEnd - s, v, vc, vEnd, a, b);
          emit(car, t, t + G.T, pid, s, sEnd, v, G.vp, G.v1, G.ta, G.tb, turn, lot);
          t += G.T;
          s = sEnd;
          v = G.v1;
          break;
        }
        if (lim(t) < s - 0.02) {
          // 长路段的检查点上接着定下一段时，车还开着就已经进了前车的安全线（前车过检查点以后比当初估的慢了一点）：
          // 没真碰上就踩刹车拉开车距，不原地停死——停死的话，后面已经定好开到检查点的车会全叠在这一点上
          if (resuming && v > 0.05 && rr) {
            leadAt(rr, t, L2);
            const room = (L2[0] as number) - rr.len - s;
            if (room > 0.3) {
              const w = Math.max(0, L2[1] as number);
              const need = v > w ? ((v - w) * (v - w)) / (2 * room) : 0;
              const bb = Math.min(b * 8, Math.max(b * 1.2, need * 1.15));
              const dT = Math.min(v / bb, 0.6);
              const vj = Math.max(0, v - bb * dT);
              const dist = ((v + vj) / 2) * dT;
              if (s + dist >= sEnd - 1e-4) {
                const d = sEnd - s;
                const tt = (v - Math.sqrt(Math.max(0, v * v - 2 * bb * d))) / bb;
                const ve = Math.max(0, v - bb * tt);
                emit(car, t, t + tt, pid, s, sEnd, v, v, ve, 0, tt, turn, lot);
                t += tt;
                s = sEnd;
                v = ve;
                break;
              }
              emit(car, t, t + dT, pid, s, s + dist, v, v, vj, 0, dT, turn, lot);
              t += dT;
              s += dist;
              v = vj;
              continue;
            }
          }
          // 前车还没让开（排队的车还没动、刚从这条路径的起点出发）：原地等
          if (v > 0.05) stats.forced++;
          const tw = waitFor(lim, s, t);
          const te = Math.min(tw, DAY_END);
          if (te > t) emit(car, t, te, pid, s, s, 0, 0, 0, 0, 0, turn, lot);
          t = Math.max(t, te);
          v = 0;
          if (tw >= DAY_END) break;
          continue;
        }
        const G = kin(sEnd - s, v, vc, vEnd, a, b);
        const tv = firstHit(G, v, s, t, lim);
        if (tv < 0) {
          emit(car, t, t + G.T, pid, s, sEnd, v, G.vp, G.v1, G.ta, G.tb, turn, lot);
          t += G.T;
          s = sEnd;
          v = G.v1;
          break;
        }
        // —— 追上前车之前开始减速：找最晚的开始刹车的时刻，刹车过程中都不越过那条线，刹到前车（往后推 TAU 秒）的速度 ——
        const brake = (t0: number, x0: number, v0: number, bb: number): number => {
          // 返回刹车的时长（刹到不高于前车的速度）；会越过那条线返回 −1
          for (let tt = 0; tt < 600; tt += 0.25) {
            const w = Math.max(0, v0 - bb * tt);
            const x = x0 + ((v0 + w) / 2) * tt;
            leadAt(rr, t0 + tt - TAU, L2);
            if (x > (L2[0] as number) - delta + 0.01) return -1;
            if (w <= Math.max(0, L2[1] as number) + 1e-3) return tt;
          }
          return -1;
        };
        let tb = -1;
        let dT = -1;
        let bb = b;
        prof(v, G.vp, G.v1, G.ta, G.tb, G.T, tv, L3);
        const okAt = (tau: number): number => {
          prof(v, G.vp, G.v1, G.ta, G.tb, G.T, tau, L3);
          return brake(t + tau, s + (L3[0] as number), L3[1] as number, b);
        };
        if (okAt(0) >= 0) {
          // 刹车越晚越危险：在 [0, tv] 里二分找最晚还来得及的时刻
          let lo = 0;
          let hi = tv;
          for (let i = 0; i < 12; i++) {
            const m = (lo + hi) / 2;
            if (okAt(m) >= 0) lo = m;
            else hi = m;
          }
          tb = lo;
          dT = okAt(tb);
        } else {
          // 来不及按平常的减速度刹：马上刹，刹得急一点
          for (const k of [1.6, 2.5, 4, 8]) {
            const d = brake(t, s, v, b * k);
            if (d >= 0) {
              [tb, dT, bb] = [0, d, b * k];
              break;
            }
          }
          if (tb < 0) {
            stats.forced++;
            [tb, dT, bb] = [0, v / (b * 8), b * 8];
          }
        }
        if (tb > 1e-4) {
          cutProf(v, G.vp, G.v1, G.ta, G.tb, G.T, 0, tb, CUT);
          emit(car, t, t + tb, pid, s, s + (CUT[7] as number), v, CUT[1] as number, CUT[2] as number, CUT[3] as number, CUT[4] as number, turn, lot);
          t += tb;
          s += CUT[7] as number;
          v = CUT[2] as number;
        }
        if (dT > 1e-4) {
          const vj = Math.max(0, v - bb * dT);
          const dist = ((v + vj) / 2) * dT;
          if (s + dist >= sEnd - 1e-4) {
            // 刹车途中就到头了
            const d = sEnd - s;
            const tt = (v - Math.sqrt(Math.max(0, v * v - 2 * bb * d))) / bb;
            const ve = Math.max(0, v - bb * tt);
            emit(car, t, t + tt, pid, s, sEnd, v, v, ve, 0, tt, turn, lot);
            t += tt;
            s = sEnd;
            v = ve;
            break;
          }
          emit(car, t, t + dT, pid, s, s + dist, v, v, vj, 0, dT, turn, lot);
          t += dT;
          s += dist;
          v = vj;
        }
        // —— 跟着前车开：照着前车（往后推 TAU 秒）的速度变化 ——
        const l0 = lim(t) - s;
        if (l0 >= -0.02) {
          let reached = false;
          for (let pc = 0; pc < 600; pc++) {
            const u = t - TAU;
            let pv0: number;
            let pvp: number;
            let pv1: number;
            let pta = 0;
            let ptb = 0;
            let pT: number;
            if (rr.i1 < 0) {
              pv0 = pvp = pv1 = Math.max(0.3, rr.v);
              pT = Infinity;
            } else if (u < rr.t) {
              pv0 = pvp = pv1 = Math.max(0, rr.v);
              pT = rr.t - u;
            } else if ((u >= rr.tx || rr.i1 <= rr.i0) && !((rr.c0 ?? -1) >= 0 && (rr.c1 ?? -1) > (rr.c0 ?? -1) && u < ((rr.car as Car).segs[((rr.c1 as number) - 1) * W + 1] as number))) {
              // 停路边车位的前车：倒进车位以前停着，倒进去以后不再挡路（回到上面按没有前车开）
              if (rr.gone !== undefined && u >= rr.gone) break;
              leadAt(rr, u, L2);
              pv0 = pvp = pv1 = L2[1] as number;
              pT = rr.gone !== undefined ? rr.gone - u : Infinity;
            } else {
              const segs = (rr.car as Car).segs;
              const inC = u >= rr.tx || rr.i1 <= rr.i0;
              let lo = inC ? (rr.c0 as number) : rr.i0;
              let hi = (inC ? (rr.c1 as number) : rr.i1) - 1;
              while (lo < hi) {
                const m = (lo + hi + 1) >> 1;
                if ((segs[m * W] as number) <= u) lo = m;
                else hi = m - 1;
              }
              const o = lo * W;
              const st0 = segs[o] as number;
              const sT = (segs[o + 1] as number) - st0;
              if (st0 + sT - u < 1e-6) {
                t = st0 + sT + TAU + 1e-7;
                continue;
              }
              cutProf(segs[o + 5] as number, segs[o + 6] as number, segs[o + 7] as number, segs[o + 8] as number, segs[o + 9] as number, sT, u - st0, sT, CUT);
              [pv0, pvp, pv1, pta, ptb, pT] = [CUT[0] as number, CUT[1] as number, CUT[2] as number, CUT[3] as number, CUT[4] as number, CUT[5] as number];
            }
            if (pT < 1e-6) {
              t += 1e-6;
              continue;
            }
            const D = sEnd - s;
            let tEnd = pT;
            let why = 0;
            const tr = reach(pv0, pvp, pv1, pta, ptb, pT, D);
            if (tr <= tEnd) [tEnd, why] = [tr, 1];
            const td = pv0 > vc + 0.01 ? 0 : pvp > vc + 0.01 && pta > 0 ? (pta * (vc + 0.01 - pv0)) / (pvp - pv0) : Infinity;
            if (td < tEnd) [tEnd, why] = [td, 2];
            const tc = brakeAt(pv0, pvp, pv1, pta, ptb, pT, D, vEnd, b, tEnd);
            if (tc < tEnd) [tEnd, why] = [tc, 2];
            if (!Number.isFinite(tEnd)) {
              // 前车在这一天剩下的时间里都停着
              if (DAY_END > t) emit(car, t, DAY_END, pid, s, s, 0, 0, 0, 0, 0, turn, lot);
              t = Math.max(t, DAY_END);
              v = 0;
              reached = true;
              break;
            }
            if (tEnd > 1e-6) {
              cutProf(pv0, pvp, pv1, pta, ptb, pT, 0, tEnd, CUT);
              const ds = why === 1 ? D : Math.min(D, CUT[7] as number);
              emit(car, t, t + tEnd, pid, s, s + ds, CUT[0] as number, CUT[1] as number, CUT[2] as number, CUT[3] as number, CUT[4] as number, turn, lot);
              s += ds;
              v = CUT[2] as number;
              t += tEnd;
            }
            if (why === 1) {
              s = sEnd;
              reached = true;
              break;
            }
            if (why === 2) break;
          }
          if (reached) break;
        }
        stall = t <= tPrev + 1e-6 ? stall + 1 : 0;
      }
      car.v = v;
      return t;
    };

    // —— 车道上的预约：先来后到，进车道时离前车够远 ——
    const upper = (list: Res[], t: number): number => {
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if ((list[m] as Res).t <= t) lo = m + 1;
        else hi = m;
      }
      return lo;
    };
    /** 以速度 v 在时刻 tt 跟着 lead 进车道还差多少（≥ 0 就够远：前车往后推 TAU 秒还在一个车长加空当、加上速度差的刹车距离以外） */
    const room = (lead: Res, v: number, tt: number): number => {
      leadAt(lead, tt - TAU, L2);
      const vl = Math.max(0, L2[1] as number);
      const need = v > vl ? ((v - vl) * (v - vl)) / 0.4 : 0;
      return (L2[0] as number) - (lead.len + GAP0) - need;
    };
    const earliest = (lead: Res, v: number, t0: number): number => {
      if (room(lead, v, t0) >= 0) return t0;
      let lo = t0;
      let hi = t0 + 1;
      while (room(lead, v, hi) < 0) {
        lo = hi;
        hi = t0 + (hi - t0) * 2;
        if (hi - t0 > 7200) return hi;
      }
      for (let i = 0; i < 24; i++) {
        const m = (lo + hi) / 2;
        if (room(lead, v, m) >= 0) hi = m;
        else lo = m;
      }
      return hi;
    };
    const ME: Res = { t: 0, v: 0, len: 0, car: undefined, i0: -1, i1: -1, tx: Infinity, vx: 0, sx: 0 };
    /**
     * 以速度 v 进车道 pid 最早什么时候有空当（不早于 tWant）：跟得上前面预约的车，后面已经预约的车也跟得上自己；
     * 后面两分钟里有仿真车（不会让人）进这条车道的，还要一路开在它前面（truckClear），不然等它过去再进
     */
    const findSlot = (pid: number, tWant: number, v: number, len: number, kind = 0): number => {
      const list = resv.get(pid);
      if (!list || !list.length) return tWant;
      let t = tWant;
      for (let guard = 0; guard < 500 && t < tWant + 1800; guard++) {
        const i = upper(list, t);
        const p = list[i - 1];
        if (p) {
          const e = earliest(p, v, t);
          if (e > t + 1e-6) {
            t = e;
            continue;
          }
        }
        const n = list[i];
        if (n) {
          ME.t = t;
          ME.v = v;
          ME.len = len;
          if (room(ME, n.v, n.t) < 0) {
            t = n.t + 1e-3;
            continue;
          }
          let tk: Res | undefined;
          for (let j = i; j < list.length && j < i + 8; j++) {
            const x = list[j] as Res;
            if (x.t > t + 120) break;
            if (x.truck) {
              tk = x;
              break;
            }
          }
          if (tk && !truckClear(pid, t, v, len, kind, p, tk)) {
            stats.yielded++;
            t = tk.t + 1e-3;
            continue;
          }
        }
        return t;
      }
      return t;
    };
    const reserve = (pid: number, t: number, v: number, car: Car, vc?: number): Res => {
      const res: Res = { t, v, len: car.len, car, i0: -1, i1: -1, tx: Infinity, vx: v, sx: 0, pid, ...(vc !== undefined ? { vc } : {}) };
      let list = resv.get(pid);
      if (!list) resv.set(pid, (list = []));
      list.splice(upper(list, t), 0, res);
      return res;
    };
    const prevRes = (pid: number, res: Res): Res | undefined => {
      const list = resv.get(pid);
      if (!list) return undefined;
      let i = upper(list, res.t) - 1;
      while (i >= 0 && list[i] !== res) i--;
      return i > 0 ? list[i - 1] : undefined;
    };
    const finalize = (res: Res, i0: number, i1: number, tx: number, vx: number, sx: number, c0 = -1, c1 = -1) => {
      res.i0 = i0;
      res.i1 = i1;
      res.tx = tx;
      res.vx = vx;
      res.sx = sx;
      if (c1 > c0 && c0 >= 0) [res.c0, res.c1] = [c0, c1];
    };

    // —— 信号、转弯、转向灯 ——
    /** 开着的车过停止线：绿灯和黄灯都可以 */
    // 黄灯最后 1 秒到停止线的也停（长路段分段定的轨迹，到线的时刻可能差一点点，不压着红灯过）
    const mayCross = (ph: { j: Junction; phase: number }, t: number) => local(ph.j, ph.phase, t) < GREEN + AMBER - 1;
    /** 停在停止线上的车最早什么时候起步：绿灯亮后 REACT 秒；绿灯只剩 3 秒以内的等下一个绿灯 */
    const goTime = (ph: { j: Junction; phase: number }, t: number): number => {
      const l = local(ph.j, ph.phase, t);
      if (l < REACT) return t + (REACT - l);
      if (l < GREEN - 3) return t;
      return t + (CYCLE - l) + REACT;
    };
    /** 段的数组里时刻 t 的位置（路径上的路程；最后一段以后停在终点） */
    const sOn = (segs: readonly number[], t: number): number => {
      const n = segs.length / W;
      if (!n) return 0;
      if (t <= (segs[0] as number)) return segs[3] as number;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if ((segs[m * W] as number) <= t) lo = m;
        else hi = m - 1;
      }
      const o = lo * W;
      prof(segs[o + 5] as number, segs[o + 6] as number, segs[o + 7] as number, segs[o + 8] as number, segs[o + 9] as number, (segs[o + 1] as number) - (segs[o] as number), t - (segs[o] as number), L3);
      const sA = segs[o + 3] as number;
      const sB = segs[o + 4] as number;
      return sA + Math.sign(sB - sA) * Math.min(Math.abs(sB - sA), Math.max(0, L3[0] as number));
    };
    /** 试开用的车（不进车流，只用来估一辆车照这样进车道会怎么开） */
    const TRIAL: Car = { id: -1, track: { kind: 0, color: 0, line: -1, t0: 0, t1: 0, segT0: new Float64Array(0), segT1: new Float64Array(0), segP: new Int32Array(0), segS0: new Float32Array(0), segS1: new Float32Array(0), segV0: new Float32Array(0), segVp: new Float32Array(0), segV1: new Float32Array(0), segTa: new Float32Array(0), segTb: new Float32Array(0), segTurn: new Int8Array(0), segLot: new Uint8Array(0) }, segs: [], kind: 0, len: 4.6, arc: -1, lane: 0, t: 0, v: 0, dest: '', noise: 0 };
    /**
     * 车（车长 len、车型 kind）在 t 以速度 v 进车道 pid、跟着前车 p：后面的仿真车 tk 会不会追上它。照跟车、信号灯试开到停止线
     * （到线时减到限速的六成，红灯就停下等），过线以后加速到限速、车尾离开这条车道为止，每半秒比一次：仿真车的车头离它的车尾不到一个空当加 1 米就不行
     */
    const truckClear = (pid: number, t: number, v: number, len: number, kind: number, p: Res | undefined, tk: Res, s0 = 0): boolean => {
      const a = this.laneArc.get(pid);
      if (a === undefined) return true;
      const A = this.arcs[a] as Arc;
      const P = this.paths[pid] as Path;
      const ph = phaseOf(A);
      const vc = speedOf(a, kind === 2, t);
      const Ld = ph ? Math.max(0, P.len - STOP_BACK) : P.len;
      const [stalled, forced] = [stats.stalled, stats.forced];
      TRIAL.kind = kind;
      TRIAL.len = len;
      TRIAL.segs.length = 0;
      let tx = s0 < Ld ? follow(TRIAL, pid, t, s0, v, Ld, 0.6 * vc, vc, p, 0, 0) : t;
      let vx = s0 < Ld ? TRIAL.v : v;
      if (ph && s0 < Ld && !mayCross(ph, tx)) {
        TRIAL.segs.length = 0;
        const ts = follow(TRIAL, pid, t, s0, v, Ld, 0, vc, p, 0, 0);
        const tg = Math.max(ts, goTime(ph, ts));
        if (tg > ts) emit(TRIAL, ts, tg, pid, Ld, Ld, 0, 0, 0, 0, 0, 0, 0);
        tx = tg;
        vx = 0;
      }
      [stats.stalled, stats.forced] = [stalled, forced];
      const acc = ACC[kind] as number;
      const tAcc = Math.max(0, (vc - vx) / acc);
      const dAcc = vx * tAcc + 0.5 * acc * tAcc * tAcc;
      const rest = P.len - Math.max(Ld, s0) + len + GAP0;
      const tClear = tx + (rest <= dAcc ? (Math.sqrt(vx * vx + 2 * acc * rest) - vx) / acc : tAcc + (rest - dAcc) / Math.max(0.05, vc));
      const after = (tt: number): number => {
        const u = Math.min(tt - tx, tAcc);
        return Math.max(Ld, s0) + vx * u + 0.5 * acc * u * u + vc * Math.max(0, tt - tx - tAcc);
      };
      for (let tt = Math.max(t, tk.t); tt <= tClear + 0.25; tt += 0.5) {
        const sc = tt <= tx ? sOn(TRIAL.segs, tt) : after(tt);
        leadAt(tk, tt, L2);
        if ((L2[0] as number) > sc - len - GAP0 - 1) return false;
      }
      return true;
    };
    /** 从弧 a 的车道 la 转进弧 b 的车道 lb：转弯车速（直行不减速，90° 减一半，不低于慢的那条路或 0.55；掉头另算）、转向灯 */
    const turnOf = (a: number, la: number, b: number, lb: number, tp: number, bus: boolean, t: number): { vt: number; turn: number } => {
      const A = this.arcs[a] as Arc;
      const B = this.arcs[b] as Arc;
      const va = speedOf(a, bus, t);
      const vb = speedOf(b, bus, t);
      const vmin = Math.min(va, vb);
      const j = this.net.junctions.get(A.jb);
      // 公交站前后：直行，换车道打灯
      if (!j) return { vt: vmin, turn: lb === la ? 0 : lb > la ? -1 : 1 };
      const tpts = (this.paths[tp] as Path).pts;
      const n = tpts.length;
      const p0 = tpts[0] as V3;
      const p1 = tpts[1] ?? p0;
      const q0 = tpts[Math.max(0, n - 2)] as V3;
      const q1 = tpts[n - 1] as V3;
      const ang = Math.atan2((p1.x - p0.x) * (q1.z - q0.z) - (p1.z - p0.z) * (q1.x - q0.x), (p1.x - p0.x) * (q1.x - q0.x) + (p1.z - p0.z) * (q1.z - q0.z));
      const uturn = B.line === A.line && B.dir === -A.dir;
      const vt = uturn ? Math.max(0.3, vmin * 0.3) : j.kind === 'roundabout' ? Math.max(Math.min(vmin, 0.55), Math.min(0.9, vmin)) : Math.max(Math.min(vmin, 0.55), ((va + vb) / 2) * (1 - 0.5 * Math.min(1, Math.abs(ang) / (Math.PI / 2))));
      return { vt, turn: Math.abs(ang) > 0.5 || uturn ? (ang >= 0 ? 1 : -1) : 0 };
    };
    /** 快到路口的最后 6 秒打转向灯，在路口前停着等（排队、等灯、等空当）时一直打 */
    const markTurn = (car: Car, k0: number, k1: number, tEnd: number, turn: number) => {
      if (!turn) return;
      for (let k = k0; k < k1; k++) {
        const o = k * W;
        if ((car.segs[o + 10] as number) !== 0) continue;
        if (car.segs[o + 3] === car.segs[o + 4]) car.segs[o + 10] = turn * 2;
        else if ((car.segs[o + 1] as number) > tEnd - 6) car.segs[o + 10] = turn;
      }
    };
    /** 到路口往哪走：去目的地用时最短（加上每辆车自己的偏好），只在离目的地更近的方向里挑（不会兜圈） */
    const pickNext = (car: Car): number => {
      const options = this.succ[car.arc] as number[];
      if (!options.length) return -1;
      const cost = this.costTo(car.dest);
      const here = cost[car.arc] as number;
      let b = options[0] as number;
      let best = Infinity;
      // 停车场的进出路只在要进这个停车场时才开进去（不拿它的尽头当掉头的地方：场口常常有车排队进场）
      const lotRoad = (o: number) => {
        const B = this.arcs[o] as Arc;
        return (lines[B.line] as Line).cls === 'service' && B.jb !== car.dest && !this.net.junctions.get(B.jb)?.legs.some((l) => (lines[l.line] as Line).cls !== 'service');
      };
      for (const o of options) {
        const left = cost[o] as number;
        if (!(left < here) || lotRoad(o)) continue;
        const c = (this.turnCost(car.arc, o) + left) * (1 + (0.18 * ((car.noise * 7919 + o * 104729) % 1000)) / 1000);
        if (c < best) [best, b] = [c, o];
      }
      if (!Number.isFinite(best)) for (const o of options) if ((cost[o] as number) < best && !lotRoad(o)) [best, b] = [cost[o] as number, o];
      if (!Number.isFinite(best)) for (const o of options) if ((cost[o] as number) < best) [best, b] = [cost[o] as number, o];
      if (!Number.isFinite(best)) b = options[Math.floor(r() * options.length)] as number;
      return b;
    };
    /** 车在它的第 k0…k1 段里时刻 t 的车头位置和朝向（停车场里、路口里查让行用） */
    const frontAt = (car: Car, k0: number, k1: number, t: number, out: Front): boolean => {
      const segs = car.segs;
      if (k1 <= k0 || t < (segs[k0 * W] as number) || t > (segs[(k1 - 1) * W + 1] as number)) return false;
      let lo = k0;
      let hi = k1 - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if ((segs[m * W] as number) <= t) lo = m;
        else hi = m - 1;
      }
      const o = lo * W;
      prof(segs[o + 5] as number, segs[o + 6] as number, segs[o + 7] as number, segs[o + 8] as number, segs[o + 9] as number, (segs[o + 1] as number) - (segs[o] as number), t - (segs[o] as number), L3);
      const sA = segs[o + 3] as number;
      const sB = segs[o + 4] as number;
      const s = sA + Math.sign(sB - sA) * Math.min(Math.abs(sB - sA), Math.max(0, L3[0] as number));
      const p = this.paths[segs[o + 2] as number] as Path;
      const q = sampleAt(p.pts, p.cum, s);
      out.x = q.p.x;
      out.z = q.p.z;
      out.dx = q.dx;
      out.dz = q.dz;
      return true;
    };
    const FA: Front = { x: 0, z: 0, dx: 1, dz: 0 };
    const FB: Front = { x: 0, z: 0, dx: 1, dz: 0 };
    /** 两辆车（车头位置和朝向、车长、车宽）的车身各放大 0.3 米以后会不会碰上 */
    const touch = (p: Front, la: number, wa: number, q: Front, lb: number, wb: number): boolean => {
      const ax = p.x - (p.dx * la) / 2;
      const az = p.z - (p.dz * la) / 2;
      const bx = q.x - (q.dx * lb) / 2;
      const bz = q.z - (q.dz * lb) / 2;
      const ha = la / 2 + 0.3;
      const wa2 = wa / 2 + 0.3;
      const hb = lb / 2 + 0.3;
      const wb2 = wb / 2 + 0.3;
      for (let k = 0; k < 4; k++) {
        const ux = k === 0 ? p.dx : k === 1 ? -p.dz : k === 2 ? q.dx : -q.dz;
        const uz = k === 0 ? p.dz : k === 1 ? p.dx : k === 2 ? q.dz : q.dx;
        const ra = ha * Math.abs(p.dx * ux + p.dz * uz) + wa2 * Math.abs(-p.dz * ux + p.dx * uz);
        const rb = hb * Math.abs(q.dx * ux + q.dz * uz) + wb2 * Math.abs(-q.dz * ux + q.dx * uz);
        if (Math.abs((bx - ax) * ux + (bz - az) * uz) > ra + rb) return false;
      }
      return true;
    };
    /**
     * 每个路口里过路口的车（从停止线前一个车长开过转弯路径，再往前延一个车长；刚进车道、车尾还在路口里的车）：
     * 后定下来的车要和它们错开。每条记录带着车头扫过的路线（每秒一个点）和外框，先按路线远近筛掉不可能碰的
     */
    interface Sweep {
      xs: Float32Array;
      zs: Float32Array;
      /** 每个点车头走过的路程（从这段扫的起点算） */
      ds: Float32Array;
      /** 每个点车头在那里的时段（开着的点两个数一样，停着的点是停的那段时间） */
      t0s: Float64Array;
      t1s: Float64Array;
      box: [number, number, number, number];
    }
    interface JRec extends Move {
      ext: number;
      /** 车头扫过的路线（第一次要比的时候才算） */
      sw?: Sweep;
    }
    const jrec = new Map<string, JRec[]>();
    /** 车头在第 k0…k1 段以后再按最后的方向和速度往前延 ext 秒 */
    const frontX = (car: Car, k0: number, k1: number, ext: number, t: number, out: Front): boolean => {
      const tEnd = car.segs[(k1 - 1) * W + 1] as number;
      if (t <= tEnd) return frontAt(car, k0, k1, t, out);
      if (t > tEnd + ext || !frontAt(car, k0, k1, tEnd, out)) return false;
      const d = Math.max(car.segs[(k1 - 1) * W + 7] as number, 0.3) * (t - tEnd);
      out.x += out.dx * d;
      out.z += out.dz * d;
      return true;
    };
    const JA: Front = { x: 0, z: 0, dx: 1, dz: 0 };
    const JB: Front = { x: 0, z: 0, dx: 1, dz: 0 };
    /** 车头在时段 [t0, t1] 里扫过的路线：按路程每 2 米一个点（停着的地方一个点，带停的时段），开出最后一段以后沿切线往前延 */
    const sweep = (car: Car, k0: number, k1: number, ext: number, t0: number, t1: number): Sweep => {
      const xs: number[] = [];
      const zs: number[] = [];
      const a0: number[] = [];
      const a1: number[] = [];
      const segs = car.segs;
      const push = (x: number, z: number, ta: number, tb: number) => {
        xs.push(x);
        zs.push(z);
        a0.push(ta);
        a1.push(tb);
      };
      for (let k = k0; k < k1; k++) {
        const o = k * W;
        const ts = segs[o] as number;
        const te = segs[o + 1] as number;
        if (te < t0 || ts > t1) continue;
        const ta = Math.max(ts, t0);
        const tb = Math.min(te, t1);
        const sA = segs[o + 3] as number;
        const sB = segs[o + 4] as number;
        const p = this.paths[segs[o + 2] as number] as Path;
        const D = Math.abs(sB - sA);
        const dir = Math.sign(sB - sA);
        const T = te - ts;
        prof(segs[o + 5] as number, segs[o + 6] as number, segs[o + 7] as number, segs[o + 8] as number, segs[o + 9] as number, T, ta - ts, L3);
        const xa = sA + dir * Math.min(D, Math.max(0, L3[0] as number));
        prof(segs[o + 5] as number, segs[o + 6] as number, segs[o + 7] as number, segs[o + 8] as number, segs[o + 9] as number, T, tb - ts, L3);
        const xb = sA + dir * Math.min(D, Math.max(0, L3[0] as number));
        if (Math.abs(xb - xa) < 0.05) {
          const q = sampleAt(p.pts, p.cum, xa);
          push(q.p.x, q.p.z, ta, tb);
          continue;
        }
        const n = Math.max(1, Math.ceil(Math.abs(xb - xa) / 2));
        for (let i = 0; i <= n; i++) {
          const q = sampleAt(p.pts, p.cum, xa + ((xb - xa) * i) / n);
          const tt = ta + ((tb - ta) * i) / n;
          push(q.p.x, q.p.z, tt, tt);
        }
      }
      const tEnd = segs[(k1 - 1) * W + 1] as number;
      if (ext > 0 && t1 > tEnd && frontAt(car, k0, k1, tEnd, JA)) {
        const v = Math.max(segs[(k1 - 1) * W + 7] as number, 0.3);
        const len = v * Math.min(ext, t1 - tEnd);
        const n = Math.max(1, Math.ceil(len / 2));
        for (let i = 1; i <= n; i++) push(JA.x + (JA.dx * len * i) / n, JA.z + (JA.dz * len * i) / n, tEnd + (len * i) / n / v, tEnd + (len * i) / n / v);
      }
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < xs.length; i++) {
        x0 = Math.min(x0, xs[i] as number);
        x1 = Math.max(x1, xs[i] as number);
        z0 = Math.min(z0, zs[i] as number);
        z1 = Math.max(z1, zs[i] as number);
      }
      const ds = new Float32Array(xs.length);
      for (let i = 1; i < xs.length; i++) ds[i] = (ds[i - 1] as number) + Math.hypot((xs[i] as number) - (xs[i - 1] as number), (zs[i] as number) - (zs[i - 1] as number));
      return { xs: Float32Array.from(xs), zs: Float32Array.from(zs), ds, t0s: Float64Array.from(a0), t1s: Float64Array.from(a1), box: [x0, z0, x1, z1] };
    };
    /**
     * 两条扫过的路线在哪儿挨得近（横向不到两车半宽之和加余量：交叉、汇合、分开的那一带；并排的两条车道不算）：
     * 两车各自从车头进那一带到车尾离开那一带的时段（车尾比车头晚走一个车长）；挨不着返回 false
     */
    const NW = [0, 0, 0, 0];
    const winOf = (a: Sweep, i0: number, i1: number, len: number, out: number, at: number) => {
      // 车头开过那一带以后再走一个车长，车尾才离开
      const need = (a.ds[i1] as number) + len;
      let j = i1;
      while (j < a.ds.length - 1 && (a.ds[j] as number) < need) j++;
      const tEnd = (a.ds[j] as number) >= need ? (a.t1s[j] as number) : (a.t1s[a.ds.length - 1] as number) + (need - (a.ds[a.ds.length - 1] as number)) / 0.4;
      NW[out] = (a.t0s[i0] as number) - 0.5;
      NW[at] = tEnd + 0.5;
    };
    const nearWin = (a: Sweep, b: Sweep, r: number, la: number, lb: number): boolean => {
      if (a.box[0] > b.box[2] + r || b.box[0] > a.box[2] + r || a.box[1] > b.box[3] + r || b.box[1] > a.box[3] + r) return false;
      const r2 = r * r;
      let a0 = Infinity;
      let a1 = -1;
      let b0 = Infinity;
      let b1 = -1;
      for (let i = 0; i < a.xs.length; i++)
        for (let j = 0; j < b.xs.length; j++) {
          const dx = (a.xs[i] as number) - (b.xs[j] as number);
          const dz = (a.zs[i] as number) - (b.zs[j] as number);
          if (dx * dx + dz * dz >= r2) continue;
          if (i < a0) a0 = i;
          if (i > a1) a1 = i;
          if (j < b0) b0 = j;
          if (j > b1) b1 = j;
        }
      if (a1 < 0) return false;
      winOf(a, a0, a1, la, 0, 1);
      winOf(b, b0, b1, lb, 2, 3);
      return true;
    };
    const SHIFTS = [0, 0.6, 1.2, 2, 3, 4.5, 6.5, 9, 12, 16, 21, 28, 36, 46, 60];
    /**
     * 这次过路口（车的第 k0…k1 段，从 tA 起）整体推迟多少秒才不和路口里已经定好的车碰（车身各放大 0.3 米查）；推迟 60 秒也不行返回 60。
     * 先按两车扫过的路线找出离得近的那一带和各自在那里的时段，只在两段时段重叠的时候逐个时刻查车身碰不碰
     */
    const junctionShift = (jid: string, car: Car, k0: number, k1: number, ext: number, tA: number): number => {
      const list = jrec.get(jid);
      if (!list || k1 <= k0) return 0;
      const t1 = (car.segs[(k1 - 1) * W + 1] as number) + ext;
      let mine: Sweep | undefined;
      const rel: { m: JRec; a0: number; a1: number; b0: number; b1: number }[] = [];
      for (const m of list) {
        if (m.car === car || m.t1 + m.ext < tA || m.t0 > t1 + 60) continue;
        mine ??= sweep(car, k0, k1, ext, tA, t1);
        m.sw ??= sweep(m.car, m.k0, m.k1, m.ext, m.t0, m.t1 + m.ext);
        const r = ((CAR_W[car.kind] as number) + (CAR_W[m.car.kind] as number)) / 2 + 0.6;
        if (nearWin(mine, m.sw, r, car.len, m.car.len)) rel.push({ m, a0: NW[0] as number, a1: NW[1] as number, b0: NW[2] as number, b1: NW[3] as number });
      }
      if (!rel.length) return 0;
      for (const d of SHIFTS) {
        let ok = true;
        for (const x of rel) {
          const lo = Math.max(x.a0 + d, x.b0, tA + d, x.m.t0);
          const hi = Math.min(x.a1 + d, x.b1, t1 + d, x.m.t1 + x.m.ext);
          const reach = Math.max(car.len, x.m.car.len) + 3;
          for (let tt = lo; tt <= hi + 1e-6; ) {
            if (!frontX(car, k0, k1, ext, tt - d, JA) || !frontX(x.m.car, x.m.k0, x.m.k1, x.m.ext, tt, JB)) {
              tt += 0.3;
              continue;
            }
            const dd = Math.hypot(JA.x - JB.x, JA.z - JB.z);
            if (dd < reach && touch(JA, car.len, CAR_W[car.kind] as number, JB, x.m.car.len, CAR_W[x.m.car.kind] as number)) {
              ok = false;
              break;
            }
            // 两车相对速度不超过 4 米 / 秒：离得远就跨大步
            tt += Math.max(0.3, (dd - reach) / 4);
          }
          if (!ok) break;
        }
        if (ok) return d;
      }
      return SHIFTS[SHIFTS.length - 1] as number;
    };
    const addJ = (jid: string, car: Car, k0: number, k1: number, ext: number, tA = car.segs[k0 * W] as number, tB = car.segs[(k1 - 1) * W + 1] as number) => {
      if (k1 <= k0) return;
      const t0 = tA;
      const t1 = tB;
      let list = jrec.get(jid);
      if (!list) jrec.set(jid, (list = []));
      if (list.length > 60) {
        list = list.filter((m) => m.t1 + m.ext > now - 60);
        jrec.set(jid, list);
      }
      list.push({ car, k0, k1, t0, t1, ext });
    };
    /** 车头（顺着路径开的那几段 k0…k1 里）开到路程 sT 的时刻 */
    const timeAt = (car: Car, k0: number, k1: number, sT: number): number => {
      const segs = car.segs;
      for (let k = k0; k < k1; k++) {
        const o = k * W;
        const s0 = segs[o + 3] as number;
        const s1 = segs[o + 4] as number;
        if (s1 < sT - 1e-6) continue;
        if (s0 >= sT || s1 <= s0) return segs[o] as number;
        const T = (segs[o + 1] as number) - (segs[o] as number);
        const tau = reach(segs[o + 5] as number, segs[o + 6] as number, segs[o + 7] as number, segs[o + 8] as number, segs[o + 9] as number, T, sT - s0);
        return (segs[o] as number) + Math.min(T, tau);
      }
      return segs[(k1 - 1) * W + 1] as number;
    };
    /** 这条车道上最后一个车长（车头离路口前的停止线 / 车道尽头不到一个车长，含在那里等着的时段）从第几段开始 */
    const tailOf = (car: Car, i0: number, i1: number, Ld: number): number => {
      let k = i1;
      while (k > i0 && (car.segs[(k - 1) * W + 4] as number) >= Ld - car.len - 2) k--;
      return k < i1 ? k : i1;
    };
    /**
     * 开过这条车道、过路口进弧 nb：先跟车开到停止线（有信号灯）或路口前，红灯就停下等绿灯；
     * 再看转进去的车道（每条车道都试一下，挑最早有空当的）有没有空当，没有就在停止线 / 路口前停下等到有空当。
     * 定好以后记下这条车道、转弯路径上的轨迹，在新车道上预约，排下一个事件。
     */
    const cross = (car: Car, a: number, pid: number, P: Path, t: number, s0: number, v0: number, lead: Res | undefined, vc: number, res: Res, i0: number, nb: number): void => {
      const A = this.arcs[a] as Arc;
      const B = this.arcs[nb] as Arc;
      const ph = phaseOf(A);
      // 在路口前等的位置：停止线（有信号灯）或车道尽头，路口太尖、车道和别的路挨着的那一截以外
      const depth = this.boxDepth(a, car.lane, true);
      const Ld = Math.max(s0, Math.min(ph ? P.len - STOP_BACK : P.len, P.len - depth - (depth > 0 ? 0.5 : 0)));
      const bus = !!car.bus;
      const nl = bus ? 1 : (lines[B.line] as Line).xs.lanes;
      const opts: { lb: number; tp: number; vt: number; turn: number; q: number }[] = [];
      for (let lb = 0; lb < nl; lb++) {
        if (nl > 1 && storeLane.get(nb) === lb) continue;
        const tp = this.turnPath(a, car.lane, nb, lb);
        opts.push({ lb, tp, ...turnOf(a, car.lane, nb, lb, tp, bus, car.t), q: this.lanePath(nb, lb) });
      }
      const vt = Math.min(...opts.map((o) => o.vt));
      const base = car.segs.length;
      let goAt = -Infinity;
      /** 为了路口里错开已经多等了多少秒：等到 150 秒还没空当就不再等（宁可挤一下，也不让一个路口堵成长队） */
      let jWaited = 0;
      // 停车场 T 形路口（mid）上直行的车：前面路口的队排过来时多等几轮，不挤进车道口停着车的车道（有上限，不会卡死）
      const IT = this.net.junctions.get(A.jb)?.kind === 'mid' ? 48 : 16;
      for (let it = 0; it < IT; it++) {
        car.segs.length = base;
        let tx: number;
        let vx: number;
        if (goAt === -Infinity) {
          tx = follow(car, pid, t, s0, v0, Ld, vt, vc, lead, 0, 0);
          vx = car.v;
          if (ph && !mayCross(ph, tx)) {
            goAt = goTime(ph, tx);
            continue;
          }
        } else {
          const ts = follow(car, pid, t, s0, v0, Ld, 0, vc, lead, 0, 0);
          let tg = Math.max(ts + 0.4, goAt);
          if (ph) tg = goTime(ph, tg);
          if (tg > ts + 1e-3) emit(car, ts, tg, pid, Ld, Ld, 0, 0, 0, 0, 0, 0, 0);
          tx = Math.max(ts, tg);
          vx = 0;
        }
        const iR = car.segs.length;
        let t1 = tx;
        let v1 = vx;
        if (Ld < P.len - 1e-3) {
          t1 = follow(car, pid, tx, Ld, vx, P.len, vt, vc, lead, 0, 0);
          v1 = car.v;
        }
        const iT = car.segs.length;
        // 每条车道先看进去的空当，按「最早能进」排，再依次查路口里会不会和别的车碰（找到不用等的就不再往下查）
        const cand: { o: (typeof opts)[number]; tq: number; vq: number; wait: number; score: number }[] = [];
        for (const o of opts) {
          car.segs.length = iT;
          const tq = follow(car, o.tp, t1, 0, v1, (this.paths[o.tp] as Path).len, o.vt, o.vt, lastOn.get(o.tp), o.turn * 2, 0);
          const wait = Math.max(0, findSlot(o.q, tq, car.v, car.len, car.kind) - tq);
          cand.push({ o, tq, vq: car.v, wait, score: tq + wait + (o.lb === car.lane ? 0 : 0.4) + r() * 0.2 });
        }
        cand.sort((x, y) => x.score - y.score);
        const k0 = tailOf(car, i0, iT / W, Ld);
        const tTail = timeAt(car, k0, iT / W, Ld - car.len - 2);
        let best: ((typeof cand)[number] & { total: number }) | undefined;
        for (const c of cand) {
          // 路口里要等只会更晚：后面的车道最早也赶不上已经找到的
          if (best && c.score >= best.total) break;
          car.segs.length = iT;
          follow(car, c.o.tp, t1, 0, v1, (this.paths[c.o.tp] as Path).len, c.o.vt, c.o.vt, lastOn.get(c.o.tp), c.o.turn * 2, 0);
          // 路口里和别的车错开（交叉、汇合、分开的转弯，路口出口排着的车）
          const jw = jWaited >= 150 ? 0 : junctionShift(A.jb, car, k0, car.segs.length / W, (car.len + 2) / Math.max(car.v, 0.3), tTail);
          const w = Math.max(c.wait, jw);
          const total = c.score - c.wait + w;
          if (!best || total < best.total) best = { ...c, wait: w, total };
          if (jw <= c.wait + 0.05) break;
        }
        const pick = best as NonNullable<typeof best>;
        if (pick.wait <= 0.05 || it === IT - 1) {
          if (pick.wait > 0.05) stats.squeezed++;
          car.segs.length = iT;
          const Tlen = (this.paths[pick.o.tp] as Path).len;
          const tq = follow(car, pick.o.tp, t1, 0, v1, Tlen, pick.o.vt, pick.o.vt, lastOn.get(pick.o.tp), pick.o.turn * 2, 0);
          const vq = car.v;
          finalize(res, i0, iT / W, t1, v1, P.len, iT / W, car.segs.length / W);
          lastOn.set(pick.o.tp, { t: t1, v: v1, len: car.len, car, i0: iT / W, i1: car.segs.length / W, tx: tq, vx: vq, sx: Tlen });
          const kt = tailOf(car, i0, iT / W, Ld);
          addJ(A.jb, car, kt, car.segs.length / W, (car.len + 2) / Math.max(vq, 0.3), timeAt(car, kt, iT / W, Ld - car.len - 2));
          markTurn(car, i0, iT / W, t1, pick.o.turn);
          car.res = reserve(pick.o.q, tq, vq, car, speedOf(nb, !!car.bus, tq));
          // 要在这条车道上停路边车位的车：后面的车多留 3 米（倒车进车位要用）
          if (car.curb && car.curb.arc === nb) car.res.len += 3;
          car.arc = nb;
          car.lane = pick.o.lb;
          car.v = vq;
          car.t = tq;
          if (car.bus) car.bus.k = (car.bus.k + 1) % car.bus.r.route.length;
          push({ t: tq, car });
          return;
        }
        if (pick.wait > Math.max(0, findSlot(pick.o.q, pick.tq, pick.vq, car.len, car.kind) - pick.tq) + 0.05) {
          jWaited += pick.wait;
          if (jWaited >= 150) stats.squeezed++;
        }
        goAt = (goAt === -Infinity ? tx : goAt) + pick.wait + (vx > 0.05 ? 1 : 0);
      }
    };

    // —— 停车场 ——
    /** 道闸抬杆的时段先记在这里，这次进出场定下来了再记上（试了不行要重来） */
    const bars: [string, number, number][] = [];
    const markBarrier = (key: string, t0: number, t1: number) => {
      const list = this.barrierUp.get(key) ?? [];
      list.push(t0, t1);
      this.barrierUp.set(key, list);
    };
    const commitBars = () => {
      for (const [k, t0, t1] of bars) markBarrier(k, t0, t1);
      bars.length = 0;
    };
    /** 在停车场里沿一条路径从 s0 开到 s1（倒车时 s1 < s0）：起止速度、限速；经过道闸（sBar ≥ 0）停一下等抬杆。返回到达的时刻 */
    const drive = (car: Car, t: number, pid: number, s0: number, s1: number, v0: number, vc: number, v1: number, sBar: number, barKey: string, turn = 0): number => {
      const a = LOT_ACC;
      const b = LOT_DEC;
      const dirn = s1 >= s0 ? 1 : -1;
      if (sBar >= 0 && (sBar - s0) * dirn > 0.5 && (s1 - sBar) * dirn > 0.5) {
        const k1 = kin(Math.abs(sBar - s0), v0, vc, 0, a, b);
        emit(car, t, t + k1.T, pid, s0, sBar, v0, k1.vp, k1.v1, k1.ta, k1.tb, turn, 1);
        const tUp = t + k1.T;
        emit(car, tUp, tUp + BARRIER_WAIT, pid, sBar, sBar, 0, 0, 0, 0, 0, turn, 1);
        bars.push([barKey, tUp - 1.5, tUp + BARRIER_WAIT + 2.5]);
        const k2 = kin(Math.abs(s1 - sBar), 0, vc, v1, a, b);
        emit(car, tUp + BARRIER_WAIT, tUp + BARRIER_WAIT + k2.T, pid, sBar, s1, 0, k2.vp, k2.v1, k2.ta, k2.tb, turn, 1);
        car.v = k2.v1;
        return tUp + BARRIER_WAIT + k2.T;
      }
      const k = kin(Math.abs(s1 - s0), v0, vc, v1, a, b);
      emit(car, t, t + k.T, pid, s0, s1, v0, k.vp, k.v1, k.ta, k.tb, turn, 1);
      car.v = k.v1;
      return t + k.T;
    };
    /** 这次进出场（车的第 k0…k1 段）和停车场里已经定好的进出场碰不碰（离得远就跨大步查） */
    const lotOk = (run: LotRun, car: Car, k0: number, k1: number): boolean => {
      const list = moves.get(run.lot.id);
      if (!list) return true;
      const t0 = car.segs[k0 * W] as number;
      const t1 = car.segs[(k1 - 1) * W + 1] as number;
      for (const m of list) {
        if (m.car === car || m.t1 < t0 || m.t0 > t1) continue;
        const hi = Math.min(t1, m.t1);
        for (let tt = Math.max(t0, m.t0); tt <= hi + 1e-6; ) {
          if (!frontAt(car, k0, k1, tt, FA) || !frontAt(m.car, m.k0, m.k1, tt, FB)) {
            tt += 0.5;
            continue;
          }
          const d = Math.hypot(FA.x - FB.x, FA.z - FB.z);
          if (d < 16 && touch(FA, car.len, CAR_W[car.kind] as number, FB, m.car.len, CAR_W[m.car.kind] as number)) return false;
          // 两车相对速度不超过 5 米 / 秒
          tt += Math.max(0.4, (d - 14) / 5);
        }
      }
      return true;
    };
    const addMove = (run: LotRun, car: Car, k0: number, k1: number) => {
      const t0 = car.segs[k0 * W] as number;
      const t1 = car.segs[(k1 - 1) * W + 1] as number;
      let list = moves.get(run.lot.id);
      if (!list) moves.set(run.lot.id, (list = []));
      if (list.length > 40) list = list.filter((m) => m.t1 > now - 120);
      list.push({ car, k0, k1, t0, t1 });
      moves.set(run.lot.id, list);
    };
    /**
     * 到了停车场的场口（时刻 tg、在进场车道 gatePid 的尽头 sGate）：找空车位停进去（沿通道开到车位前，拐进车位时再慢一点，
     * 车头停在车位里头）；场内通道上有车在倒车、在开，就在场口外等一会儿再进。返回进场那段在车的段里的下标；满了返回 −1
     */
    const rRev = rand(seed * 7 + 811);
    /** 倒进车位的路线（按停车场、车位缓存；通道到这里不往前通的是 null）：沿通道开过车位停下的那一段、倒进去的路径（车尾在 0）、车头朝外开出来接上出场路线的路径 */
    const revCache = new Map<string, { pass: number; rev: number; out: number } | null>();
    const revPaths = (run: LotRun, bay: number, len: number) => {
      const key = `${run.lot.id}:${bay}`;
      const hit = revCache.get(key);
      if (hit !== undefined) return hit;
      let res: { pass: number; rev: number; out: number } | null = null;
      const p = this.paths[run.park[bay] as number] as Path;
      const back = this.paths[run.back[bay] as number] as Path;
      const o = this.paths[run.out[bay] as number] as Path;
      const n = p.pts.length;
      if (n >= 3 && o.pts.length >= 2 && back.pts.length >= 1 && !run.lot.truck) {
        const F = p.pts[n - 1] as V3;
        const F1 = p.pts[n - 2] as V3;
        const fl = Math.hypot(F.x - F1.x, F.z - F1.z) || 1;
        const ds = { x: (F.x - F1.x) / fl, z: (F.z - F1.z) / fl };
        const sTurn = Math.max(0, p.len - Math.max(back.len, 4));
        const A = sampleAt(p.pts, p.cum, sTurn);
        const a = { x: A.dx, z: A.dz };
        // 车位口外 1 米；开过车位口 6 米、往通道中间偏 2.5 米的地方停下倒车
        const Es = v3(F.x - ds.x * (len + 1), F.y, F.z - ds.z * (len + 1));
        const B = v3(Es.x + a.x * 6 - ds.x * 2.5, F.y, Es.z + a.z * 6 - ds.z * 2.5);
        // 通道要通到那里：别的车位进场的路线经过停车的地方
        const onAisle = run.park.some((q, i) => i !== bay && (this.paths[q] as Path).pts.some((x) => Math.hypot(x.x - B.x, x.z - B.z) < 1.8));
        if (onAisle) {
          const mid = bezier(Es, { x: -ds.x, z: -ds.z }, B, a, 0.4, 8).slice(1, -1);
          const rev = this.addPath([F.clone(), Es, ...mid, B]);
          const E0 = o.pts[0] as V3;
          const E1 = o.pts[1] as V3;
          const el = Math.hypot(E1.x - E0.x, E1.z - E0.z) || 1;
          const Fo = v3(F.x - ds.x * len, F.y, F.z - ds.z * len);
          const outMid = bezier(Es, { x: -ds.x, z: -ds.z }, E0, { x: (E1.x - E0.x) / el, z: (E1.z - E0.z) / el }, 0.4, 8).slice(1, -1);
          res = { pass: this.addPath([A.p.clone(), B.clone()]), rev, out: this.addPath([Fo, Es.clone(), ...outMid, E0.clone()]) };
        }
      }
      revCache.set(key, res);
      return res;
    };
    const parkIn = (car: Car, tg: number, gatePid: number, sGate: number): number => {
      const run = car.destLot as LotRun;
      const free: number[] = [];
      run.parked.forEach((c, i) => {
        if (c === undefined) free.push(i);
      });
      if (!free.length) return -1;
      // 先挑离场口近的空车位（按进场的路程排，前几个里随机挑一个，近的机会大）
      free.sort((a, b) => (this.paths[run.park[a] as number] as Path).len - (this.paths[run.park[b] as number] as Path).len);
      const bay = free[Math.floor(r() * r() * Math.min(free.length, 4))] as number;
      const pid = run.park[bay] as number;
      const p = this.paths[pid] as Path;
      const turnLen = (this.paths[run.back[bay] as number] as Path).len;
      const sTurn = Math.max(0, p.len - Math.max(turnLen, 4));
      // 公共停车场里约一成半的车（通道往前通的车位）开过车位、停下、倒进去（车头朝外）；小区里的车照常车头朝里
      const rv = run.lot.use !== 'home' && rRev() < TrafficPlanner.reverseIn ? revPaths(run, bay, car.len) : null;
      const v0 = car.v;
      const base = car.segs.length;
      let wait = 0;
      for (let k = 0; k < 30; k++, wait += Math.min(30, 2 * 1.35 ** k)) {
        car.segs.length = base;
        bars.length = 0;
        let tt = tg;
        let v = v0;
        if (k > 0) {
          tt = tg + wait;
          emit(car, tg, tt, gatePid, sGate, sGate, 0, 0, 0, 0, 0, 1, 0);
          v = 0;
        }
        const k0 = car.segs.length / W;
        tt = drive(car, tt, pid, 0, sTurn, v, LOT_V, TURN_V, run.barIn[bay] ?? -1, `${run.lot.id}:in`, 1);
        if (rv) {
          const pp = this.paths[rv.pass] as Path;
          const pr = this.paths[rv.rev] as Path;
          tt = drive(car, tt, rv.pass, 0, pp.len, car.v, TURN_V, 0, -1, '', 1);
          emit(car, tt, tt + GEAR, rv.pass, pp.len, pp.len, 0, 0, 0, 0, 0, 0, 0);
          tt = drive(car, tt + GEAR, rv.rev, pr.len, car.len, 0, REV_V, 0, -1, '');
        } else tt = drive(car, tt, pid, sTurn, p.len, car.v, TURN_V, 0, -1, '', 1);
        const k1 = car.segs.length / W;
        if (k === 29 || (lotOk(run, car, k0, k1) && junctionShift(run.lot.gate, car, k0, k1, 0, car.segs[k0 * W] as number) === 0)) {
          if (k === 29) stats.lotWait++;
          commitBars();
          addMove(run, car, k0, k1);
          addJ(run.lot.gate, car, k0, k1, 0);
          run.parked[bay] = car.id;
          car.park = rv ? { run, bay, path: rv.rev, s: car.len, since: tt, out: rv.out } : { run, bay, path: pid, s: p.len, since: tt };
          if (run.lot.use !== 'home') stats.lotIn++;
          if (rv) stats.revIn++;
          car.v = 0;
          car.t = tt;
          return k0;
        }
      }
      return -1;
    };
    /**
     * 从车位出发（不早于 tDep）：倒出车位、换挡，沿通道开到场口（有道闸停一下），出场的路上有空当就并进去、没有就在场口等；
     * 通道上有别的车在动就在车位里多等一会儿。返回并进出场车道的时刻（车的预约、弧、车道都改好了）
     */
    const leaveLot = (car: Car, tDep: number): number => {
      const pk = car.park as NonNullable<Car['park']>;
      const run = pk.run;
      const outQ = this.lanePath(run.outArc, 0);
      const base = car.segs.length;
      let wait = 0;
      for (let k = 0; ; k++, wait += Math.min(30, 2 * 1.35 ** k)) {
        car.segs.length = base;
        bars.length = 0;
        const t0 = Math.max(pk.since, tDep + wait);
        if (t0 > pk.since) emit(car, pk.since, t0, pk.path, pk.s, pk.s, 0, 0, 0, 0, 0, 0, 1);
        const k0 = car.segs.length / W;
        let tt = t0;
        const back = run.back[pk.bay] as number;
        const bp = this.paths[back] as Path;
        if (pk.out !== undefined) {
          // 车头朝外停的：直接开出车位，接上出场的路线
          const po = this.paths[pk.out] as Path;
          tt = drive(car, tt, pk.out, 0, po.len, 0, TURN_V, 0, -1, '', -1);
        } else if (bp.len > 0.5) {
          tt = drive(car, tt, back, bp.len, 0, 0, REV_V, 0, -1, '');
          emit(car, tt, tt + GEAR, back, 0, 0, 0, 0, 0, 0, 0, 0, 1);
          tt += GEAR;
        }
        const op = run.out[pk.bay] as number;
        const o = this.paths[op] as Path;
        const kOut = car.segs.length;
        const nb = bars.length;
        const tOut = tt;
        tt = drive(car, tt, op, 0, o.len, 0, LOT_V, SPEED.service, run.barOut[pk.bay] ?? -1, `${run.lot.id}:out`);
        let vEnd = car.v;
        let slot = findSlot(outQ, tt, vEnd, car.len, car.kind);
        if (slot > tt + 0.05) {
          // 出场的路上没有空当：在场口停下等
          car.segs.length = kOut;
          bars.length = nb;
          const tStop = drive(car, tOut, op, 0, o.len, 0, LOT_V, 0, run.barOut[pk.bay] ?? -1, `${run.lot.id}:out`);
          slot = findSlot(outQ, tStop, 0, car.len, car.kind);
          if (slot > tStop + 1e-3) emit(car, tStop, slot, op, o.len, o.len, 0, 0, 0, 0, 0, -2, 1);
          tt = Math.max(tStop, slot);
          vEnd = 0;
        }
        const k1 = car.segs.length / W;
        if (k >= 29 || (lotOk(run, car, k0, k1) && junctionShift(run.lot.gate, car, kOut / W, k1, 0, car.segs[kOut] as number) === 0)) {
          if (k >= 29) stats.lotWait++;
          commitBars();
          addMove(run, car, k0, k1);
          addJ(run.lot.gate, car, kOut / W, k1, 0);
          run.parked[pk.bay] = undefined;
          car.park = undefined;
          car.arc = run.outArc;
          car.lane = 0;
          car.v = vEnd;
          car.t = tt;
          car.res = reserve(outQ, tt, vEnd, car, SPEED.service);
          return tt;
        }
      }
    };
    /**
     * 从路边车位开走（不早于 tDep）：打左转灯，沿车位的路径往前开出 S 弯，到车道上 sY 那一点并进去。车道上前面的车已经让开、
     * 后面的车来得及跟上（轨迹已经定死的车、仿真车要一路追不上它）才走，不然在车位里多等一会儿。返回并进车道的时刻（车的预约、弧都改好了）；
     * 等太久返回 undefined（这一趟不去了）
     */
    const leaveCurb = (car: Car, tDep: number): number | undefined => {
      const cp = car.curbAt as NonNullable<Car['curbAt']>;
      const cb = cp.cb;
      const pid = cb.pid;
      const base = car.segs.length;
      const vJ = Math.min(0.45, speedOf(cb.arc, false, tDep));
      for (let k = 0, wait = 0; k < 40; k++, wait += Math.min(20, 2 + k)) {
        car.segs.length = base;
        const t0 = Math.max(cp.since, tDep + wait);
        if (t0 > cp.since) emit(car, cp.since, t0, cb.path, cb.pRest, cb.pRest, 0, 0, 0, 0, 0, k > 0 ? -2 : 0, 1);
        const tJ = drive(car, t0, cb.path, cb.pRest, cb.pY, 0, TURN_V, vJ, -1, '', -1);
        const list = resv.get(pid) ?? [];
        // 并进去的时刻车头已经过了 sY 的是前面的车，其余是后面的
        let i = 0;
        for (; i < list.length; i++) {
          leadAt(list[i] as Res, tJ, L2);
          if ((L2[0] as number) < cb.sY + 1) break;
        }
        const p = list[i - 1];
        const n = list[i];
        let ok = true;
        if (p) {
          leadAt(p, tJ - 3, L2);
          if ((L2[0] as number) - p.len - GAP0 < cb.sY + 1) ok = false;
        }
        if (ok && n) {
          // 后面已经定好怎么开的车（还有仿真车）：等它开过去再并进去。并进去以后这辆车在路口前可能要等很久（让行、排队），
          // 那辆车的轨迹已经定死、不会因为前面多了一辆车而停下，并到它前面就会被它追上叠在一起
          if (n.i1 >= 0 || n.truck) ok = false;
          else {
            leadAt(n, tJ, L2);
            const vn = Math.max(0, L2[1] as number);
            ok = (L2[0] as number) <= cb.sY - car.len - GAP0 - (vn > vJ ? ((vn - vJ) * (vn - vJ)) / 0.4 : 0) - vn * TAU;
          }
        }
        if (!ok) continue;
        // 预约排在 p、n 之间（进车道的时刻按车速往回推，夹在两者之间）
        const vc = speedOf(cb.arc, false, tJ);
        let tv = tJ - cb.sY / Math.max(0.3, vc);
        if (p) tv = Math.max(tv, p.t + 1e-4);
        if (n) tv = Math.min(tv, n.t - 1e-4);
        if (p && n && tv <= p.t) tv = (p.t + n.t) / 2;
        const res: Res = { t: tv, v: vc, len: car.len, car, i0: -1, i1: -1, tx: Infinity, vx: vc, sx: 0, pid, vc };
        list.splice(i, 0, res);
        resv.set(pid, list);
        cb.car = undefined;
        car.curbAt = undefined;
        car.arc = cb.arc;
        car.lane = 0;
        car.v = vJ;
        car.t = tJ;
        car.res = res;
        car.resume = { i0: car.segs.length / W, s: cb.sY, lead: p };
        return tJ;
      }
      car.segs.length = base;
      return undefined;
    };
    /**
     * 停车场满了：沿场内通道绕一圈找车位，还是没有就从出口开出去（换一个停车场）。场内有车在动就在场口外等一会儿；
     * 出场的路上没有空当就在出口停下等。返回进场那段在车的段里的下标（车的预约、弧、车道都改好了）；这个场不能绕返回 −1
     */
    const circleLot = (car: Car, tg: number, gatePid: number, sGate: number): number => {
      const run = car.destLot as LotRun;
      if (run.loop < 0) return -1;
      const lp = this.paths[run.loop] as Path;
      const outQ = this.lanePath(run.outArc, 0);
      const base = car.segs.length;
      const v0 = car.v;
      let wait = 0;
      for (let k = 0; k < 30; k++, wait += Math.min(30, 2 * 1.35 ** k)) {
        car.segs.length = base;
        bars.length = 0;
        let tt = tg;
        let v = v0;
        if (k > 0) {
          tt = tg + wait;
          emit(car, tg, tt, gatePid, sGate, sGate, 0, 0, 0, 0, 0, 1, 0);
          v = 0;
        }
        const k0 = car.segs.length / W;
        const tIn = tt;
        tt = drive(car, tt, run.loop, 0, lp.len, v, LOT_V, SPEED.service, -1, '');
        let vEnd = car.v;
        let slot = findSlot(outQ, tt, vEnd, car.len, car.kind);
        if (slot > tt + 0.05) {
          car.segs.length = k0 * W;
          const tStop = drive(car, tIn, run.loop, 0, lp.len, v, LOT_V, 0, -1, '');
          slot = findSlot(outQ, tStop, 0, car.len, car.kind);
          if (slot > tStop + 1e-3) emit(car, tStop, slot, run.loop, lp.len, lp.len, 0, 0, 0, 0, 0, -2, 1);
          tt = Math.max(tStop, slot);
          vEnd = 0;
        }
        const k1 = car.segs.length / W;
        if (k === 29 || (lotOk(run, car, k0, k1) && junctionShift(run.lot.gate, car, k0, k1, 0, car.segs[k0 * W] as number) === 0)) {
          if (k === 29) stats.lotWait++;
          commitBars();
          addMove(run, car, k0, k1);
          addJ(run.lot.gate, car, k0, k1, 0);
          car.arc = run.outArc;
          car.lane = 0;
          car.v = vEnd;
          car.t = tt;
          car.res = reserve(outQ, tt, vEnd, car, SPEED.service);
          stats.circled++;
          return k0;
        }
      }
      return -1;
    };
    /** 停车场满了：换一个有空位、离这里最近的（同一类优先） */
    const fallbackLot = (car: Car): LotRun | undefined => {
      let best: { run: LotRun; c: number } | undefined;
      for (const run of runs) {
        if (run === car.destLot || !run.parked.some((c) => c === undefined)) continue;
        // 别人家的小区停车场不去
        if (run.lot.use === 'home' && run !== car.home) continue;
        const cost = this.costTo(run.lot.gate)[car.arc] as number;
        const c = cost * (run.lot.use === car.destLot?.lot.use ? 1 : 1.6);
        if (Number.isFinite(c) && (!best || c < best.c)) best = { run, c };
      }
      return best?.run;
    };

    // —— 公交 ——
    /** 每条线的两个首末站：发车时刻表（高峰 12 分钟一班，平时 15 分钟，早晚 20 分钟）、下一班、能停几辆、过夜停了几辆 */
    const headway = (h: number) => (h < 7 ? 20 : h < 9 ? 12 : h < 16.5 ? 15 : h < 19 ? 12 : h < 21 ? 15 : 20) * 60;
    const timetable = (start: number): number[] => {
      const out: number[] = [];
      for (let t = start; t <= 23 * 3600; t += headway(t / 3600)) out.push(t);
      return out;
    };
    const lineTerms = this.busRoutes.map((br) => {
      const A: Term = { stop: br.ids[0], deps: timetable(6 * 3600 + br.line * 180), next: 0, cap: br.cap[0], overnight: 0, inBay: [] };
      const B: Term = { stop: br.ids[1], deps: timetable(6 * 3600 + br.line * 180 + 600), next: 0, cap: br.cap[1], overnight: 0, inBay: [] };
      A.other = B;
      B.other = A;
      return new Map([
        [A.stop, A],
        [B.stop, B],
      ]);
    });
    /**
     * 公交车在港湾里（从位置 sIn、速度 vIn、时刻 tIn 起）：开到停靠的位置（前面有车在停就排在后面），
     * 中途站停 20–40 秒，首末站等时刻表上的下一班（至少歇 90 秒），再等车道上有空当出站；收车了就停到这一天结束
     */
    const bayPart = (car: Car, stop: BusStop, tIn: number, sIn: number, vIn: number): void => {
      const bus = car.bus as BusRun;
      const L = this.bayPaths.get(stop.id) as number;
      const Lp = this.paths[L] as Path;
      const sStop = stop.stopAt;
      const tl = lastOn.get(L);
      const iB = car.segs.length / W;
      const term = bus.terms.get(stop.id);
      // 首末站：在港湾里排着等（前面有车在等发车）也算歇着
      const ta = follow(car, L, tIn, sIn, vIn, sStop, 0, Math.max(vIn, BAY_IN_V), tl, 0, term ? 2 : 0);
      // 首末站的港湾先来先走：只有这一天的班次都发完了才停下过夜（空车开过来的也一样先接还没发的班次），不挡后面要发车的车
      const stay = !!term && term.next >= term.deps.length;
      if (stay) {
        if (DAY_END > ta) emit(car, ta, DAY_END, L, sStop, sStop, 0, 0, 0, 0, 0, 0, 2);
        if (term) {
          term.overnight++;
          term.inBay.push(Infinity);
        }
        bus.deadhead = undefined;
        lastOn.set(L, { t: tIn, v: vIn, len: car.len, car, i0: iB, i1: car.segs.length / W, tx: DAY_END, vx: 0, sx: Lp.len });
        addJ(stop.id, car, iB, car.segs.length / W, 0);
        car.done = true;
        car.t = DAY_END;
        return;
      }
      const dwell = term ? 0 : DWELL[0] + r() * (DWELL[1] - DWELL[0]) + (stop.lines.length > 1 ? 8 : 0);
      const ready = term ? Math.max(ta + LAYOVER_MIN, term.deps[term.next] as number) : ta + dwell;
      const nb = bus.r.route[(bus.k + 1) % bus.r.route.length] as number;
      const q = this.lanePath(nb, 0);
      const vOut = Math.min(speedOf(nb, true, ta), 1);
      const base = car.segs.length;
      let tDep = ready;
      // 车道上接连有不会让人的仿真车（综合店顾客的车一两分钟一辆）：多等几轮空当再硬挤
      for (let it = 0; it < BUS_TRIES; it++) {
        car.segs.length = base;
        if (tDep > ta) emit(car, ta, tDep, L, sStop, sStop, 0, 0, 0, 0, 0, 0, term ? 2 : 0);
        const kOut = car.segs.length / W;
        const tq = follow(car, L, tDep, sStop, 0, Lp.len, vOut, vOut, tl, -2, 0);
        // 出站：车道上要有够长的空当（车身斜着并进去的那一截也算上），港湾口没有车在过
        const slot = findSlot(q, tq, car.v, car.len + TAPER, car.kind);
        const wait = Math.max(slot - tq, junctionShift(stop.id, car, kOut, car.segs.length / W, (car.len + 2) / Math.max(car.v, 0.3), car.segs[kOut * W] as number));
        if (wait <= 0.05 || it === BUS_TRIES - 1) {
          if (wait > 0.05) stats.squeezed++;
          lastOn.set(L, { t: tIn, v: vIn, len: car.len, car, i0: iB, i1: car.segs.length / W, tx: tq, vx: car.v, sx: Lp.len });
          addJ(stop.id, car, iB, car.segs.length / W, (car.len + 2) / Math.max(car.v, 0.3));
          car.res = reserve(q, tq, car.v, car, speedOf(nb, true, tq));
          car.arc = nb;
          car.lane = 0;
          car.t = tq;
          bus.k = (bus.k + 1) % bus.r.route.length;
          if (term) {
            term.next++;
            term.inBay.push(tDep);
            bus.deadhead = undefined;
            stats.busTrips++;
          } else stats.busDwells++;
          push({ t: tq, car });
          return;
        }
        tDep += wait + 0.5;
      }
    };
    /** 公交车开进一条车道：这条弧开到头要进站就靠进港湾，不进站（不是这条线的站、空车回首末站）就照常过路口 */
    const busDecide = (car: Car, a: number, pid: number, P: Path, t: number, s0: number, v0: number, lead: Res | undefined, vc: number, res: Res, i0: number): void => {
      const bus = car.bus as BusRun;
      const stopId = bus.r.stopAfter[bus.k];
      const nb = bus.r.route[(bus.k + 1) % bus.r.route.length] as number;
      const stop = stopId ? this.virt.get(stopId) : undefined;
      let serve = !!stop && (!bus.deadhead || bus.deadhead === stopId);
      if (stop && serve && !bus.deadhead) {
        const term = bus.terms.get(stop.id);
        // 收车：首末站已经停满，空车开到另一个首末站过夜
        if (term && term.next >= term.deps.length && term.overnight >= term.cap && term.other) {
          bus.deadhead = term.other.stop;
          serve = false;
        }
        // 平时首末站的港湾已经排满（车多、班次少的时候车会扎堆）：不进去歇，接着跑下一趟（调度临时加一班），不在路上排队
        if (term && serve && term.next < term.deps.length) {
          const eta = t + (P.len - s0) / Math.max(vc, 0.3) + stop.stopAt / BAY_IN_V;
          if (term.inBay.filter((d) => d > eta).length >= term.cap) serve = false;
        }
      }
      if (!stop || !serve) {
        cross(car, a, pid, P, t, s0, v0, lead, vc, res, i0, nb);
        return;
      }
      const vIn = Math.min(vc, BAY_IN_V);
      const t1 = follow(car, pid, t, s0, v0, P.len, vIn, vc, lead, 0, 0);
      const v1 = car.v;
      const iL = car.segs.length / W;
      markTurn(car, i0, iL, t1, 1);
      bayPart(car, stop, t1, 0, v1);
      // 后车在港湾口前跟车按公交车进港湾的这段算（港湾的路径接在这条车道的尽头）
      let c1 = iL;
      while (c1 < car.segs.length / W && (car.segs[c1 * W + 2] as number) === this.bayPaths.get(stop.id)) c1++;
      finalize(res, i0, iL, t1, v1, P.len, iL, c1);
    };

    /** 车开进一条车道（预约的时刻 t）：定下这条车道上怎么开、到头去哪 */
    /** 刚进车道的这一截（车头离车道起点不到一个车长，车尾还在路口里）也记到路口里 */
    const markEntry = (car: Car, jid: string, i0: number, i1: number, a: number, lane: number) => {
      const reachS = car.len + 2 + this.boxDepth(a, lane, false);
      let k = i0;
      while (k < i1 && (car.segs[k * W + 4] as number) < reachS) k++;
      const k1 = Math.min(i1, k + 1);
      addJ(jid, car, i0, k1, 0, car.segs[i0 * W] as number, timeAt(car, i0, k1, reachS));
    };
    /**
     * 长路段（高速、快速路上几百米到几公里）：进车道时只定到离尽头 CHECK 米的检查点，开到那里再定剩下的一段和过路口
     * （下一条车道上的空当、路口里的让行）。离得太早就定，前面的车后来停下排队时会挨得太近
     */
    const CHECK = 400;
    /** 正在检查点上接着定一条长车道剩下的一段（follow 里按它决定进了安全线时是刹车还是原地等） */
    let resuming = false;
    const decide = (car: Car, t: number): void => {
      const a = car.arc;
      const A = this.arcs[a] as Arc;
      const pid = this.lanePath(a, car.lane);
      const P = this.paths[pid] as Path;
      const res = car.res as Res;
      const vc = speedOf(a, !!car.bus, t);
      const v0 = car.v;
      const rs = car.resume;
      if (rs) {
        // 开到检查点了：接着定这条车道剩下的一段
        car.resume = undefined;
        resuming = true;
        try {
          decideLane(car, a, A, pid, P, t, res, rs.lead, rs.i0, vc, v0, rs.s);
        } finally {
          resuming = false;
        }
        return;
      }
      const lead = prevRes(pid, res);
      const i0 = car.segs.length / W;
      const lane = car.lane;
      if (P.len > CHECK * 1.5 && A.jb !== car.dest && car.curb?.arc !== a) {
        // 很长的路段（高速）检查点再往前放：路口排的队长到几百米也接得住
        const back = P.len > 1800 ? Math.min(P.len * 0.5, 1200) : CHECK;
        const tc = follow(car, pid, t, 0, v0, P.len - back, vc, vc, lead, 0, 0);
        finalize(res, i0, car.segs.length / W, tc, car.v, P.len - back);
        car.resume = { i0, s: P.len - back, lead };
        car.t = tc;
        push({ t: tc, car });
      } else decideLane(car, a, A, pid, P, t, res, lead, i0, vc, v0, 0);
      if (car.segs.length / W > i0 && (car.segs[i0 * W + 2] as number) === pid) {
        let i1 = i0;
        while (i1 < car.segs.length / W && (car.segs[i1 * W + 2] as number) === pid) i1++;
        markEntry(car, A.ja, i0, i1, a, lane);
      }
    };
    const decideLane = (car: Car, a: number, A: Arc, pid: number, P: Path, t: number, res: Res, lead: Res | undefined, i0: number, vc: number, v0: number, s0: number): void => {
      if (car.bus) {
        busDecide(car, a, pid, P, t, s0, v0, lead, vc, res, i0);
        return;
      }
      if (car.curb) {
        const cb = car.curb;
        if (a === cb.arc && s0 < cb.sX - 1) {
          // 到了要停的路边车位：打右转灯开到车位前面停下，挂倒挡沿车位的路径倒进去（倒完以前后面的车在后面等）
          const tg = follow(car, pid, t, s0, v0, cb.sX, 0, vc, lead, 0, 0);
          markTurn(car, i0, car.segs.length / W, tg, 1);
          const kL = car.segs.length / W;
          emit(car, tg, tg + GEAR, pid, cb.sX, cb.sX, 0, 0, 0, 0, 0, 2, 0);
          const tp = drive(car, tg + GEAR, cb.path, cb.pX, cb.pRest, 0, REV_V, 0, -1, '');
          finalize(res, i0, kL, tg, 0, cb.sX);
          res.gone = tp - 2;
          cb.car = car.id;
          cb.claim = undefined;
          car.curb = undefined;
          car.curbAt = { cb, since: tp };
          car.v = 0;
          car.t = tp;
          stats.curbIn++;
          return;
        }
        const A0 = this.arcs[cb.arc] as Arc;
        if (A.jb === A0.ja && (this.succ[a] as number[]).includes(cb.arc)) {
          cross(car, a, pid, P, t, s0, v0, lead, vc, res, i0, cb.arc);
          return;
        }
        if (A.jb === car.dest) {
          // 到了要先开上的那条弧的起点：转上去，接着往车位那条弧的起点开
          const via = car.curbVia;
          if (via !== undefined && (this.succ[a] as number[]).includes(via)) {
            car.curbVia = undefined;
            car.dest = A0.ja;
            cross(car, a, pid, P, t, s0, v0, lead, vc, res, i0, via);
            return;
          }
          // 转不过去（不能掉头）：挑一条不进停车场、能绕回来的路开出去，绕三次还不行就去附近的公共停车场
          const tries = (car.curbTries = (car.curbTries ?? 0) + 1);
          const opts = (this.succ[a] as number[]).filter((b) => (lines[(this.arcs[b] as Arc).line] as Line).cls !== 'service' && Number.isFinite(this.costTo(car.dest)[b] as number));
          const nb = tries <= 3 ? opts[Math.floor(r() * opts.length)] : undefined;
          if (nb !== undefined) {
            cross(car, a, pid, P, t, s0, v0, lead, vc, res, i0, nb);
            return;
          }
          cb.claim = undefined;
          car.curb = undefined;
          car.curbVia = undefined;
          let alt: LotRun | undefined;
          let bc = Infinity;
          for (const run of runs) {
            if (run.lot.use !== 'public' || !run.parked.some((c) => c === undefined)) continue;
            const c = this.costTo(run.lot.gate)[a] as number;
            if (c < bc) [bc, alt] = [c, run];
          }
          if (alt) {
            car.dest = alt.lot.gate;
            car.destLot = alt;
            const nb2 = pickNext(car);
            if (nb2 >= 0) {
              cross(car, a, pid, P, t, s0, v0, lead, vc, res, i0, nb2);
              return;
            }
          }
        }
      }
      if (A.jb === car.dest) {
        if (car.destLot) {
          // 到停车场的场口：减速打右转灯，进场停车；满了就换一个停车场，在场口掉头开出去
          const tg = follow(car, pid, t, 0, v0, P.len, LOT_V, vc, lead, 0, 0);
          markTurn(car, i0, car.segs.length / W, tg, 1);
          const k0 = parkIn(car, tg, pid, P.len);
          if (k0 >= 0) {
            finalize(res, i0, k0, car.segs[k0 * W] as number, car.segs[k0 * W + 5] as number, P.len);
            return;
          }
          const alt = fallbackLot(car);
          // 没有道闸的场：先绕通道一圈找车位，没有再开出去
          if (alt) {
            const kc = circleLot(car, tg, pid, P.len);
            if (kc >= 0) {
              finalize(res, i0, kc, car.segs[kc * W] as number, car.segs[kc * W + 5] as number, P.len);
              car.dest = alt.lot.gate;
              car.destLot = alt;
              push({ t: car.t, car });
              return;
            }
          }
          const nb = alt ? ((car.dest = alt.lot.gate), (car.destLot = alt), pickNext(car)) : -1;
          if (nb < 0) {
            finalize(res, i0, car.segs.length / W, tg, car.v, P.len);
            car.done = true;
            car.t = tg;
            return;
          }
          cross(car, a, pid, P, tg, P.len, car.v, lead, vc, res, i0, nb);
          return;
        }
        // 到出区域的高速口（在区域外的远处）：开出区域
        const te = follow(car, pid, t, 0, v0, P.len, vc, vc, lead, 0, 0);
        finalize(res, i0, car.segs.length / W, te, car.v, P.len);
        car.done = true;
        car.t = te;
        return;
      }
      const nb = pickNext(car);
      if (nb < 0) {
        const te = follow(car, pid, t, s0, v0, P.len, 0, vc, lead, 0, 0);
        finalize(res, i0, car.segs.length / W, te, 0, P.len);
        car.done = true;
        car.t = te;
        return;
      }
      cross(car, a, pid, P, t, s0, v0, lead, vc, res, i0, nb);
    };

    // —— 仿真车：每辆车走过的每条车道一个预约（只有轨迹、不画、不进 cars），排进车道的先来后到 ——
    {
      const ghostTrack = TRIAL.track;
      const onLine = new Map<number, number[]>();
      this.arcs.forEach((A, a) => {
        const l = onLine.get(A.line) ?? [];
        l.push(a);
        onLine.set(A.line, l);
      });
      /** 按单调的 xs 线性插值（两头按最后一段外推） */
      const interp = (xs: readonly number[], ys: readonly number[], x: number): number => {
        const n = xs.length;
        const inc = (xs[n - 1] as number) >= (xs[0] as number);
        let k = 0;
        while (k < n - 2 && (inc ? (xs[k + 1] as number) < x : (xs[k + 1] as number) > x)) k++;
        const x0 = xs[k] as number;
        const x1 = xs[k + 1] as number;
        return (ys[k] as number) + (((ys[k + 1] as number) - (ys[k] as number)) * (x - x0)) / (x1 - x0 || 1e-9);
      };
      /** 仿真车在路径位置 [U0, U1] 里的那几截速度曲线，按 s = (u − uBase)·k 落到车流的路径 pid 上，记成车的段 */
      const emitRange = (run: TruckRun, car: Car, pid: number, U0: number, U1: number, uBase: number, k: number, sBase: number): void => {
        const { tu, us, tv } = run;
        for (let j = 0; j + 1 < tu.length; j++) {
          const ua = us[j] as number;
          const ub = us[j + 1] as number;
          if (ub < U0 || ua > U1) continue;
          const ta = tu[j] as number;
          const T = (tu[j + 1] as number) - ta;
          if (T <= 1e-6) continue;
          const va = tv[j] as number;
          const acc = ((tv[j + 1] as number) - va) / T;
          /** 这一截里走到 U 的时刻（从 ta 起的秒数） */
          const at = (U: number): number => {
            const d = U - ua;
            if (Math.abs(acc) < 1e-9) return va > 1e-9 ? Math.min(T, Math.max(0, d / va)) : 0;
            return Math.min(T, Math.max(0, (Math.sqrt(Math.max(0, va * va + 2 * acc * d)) - va) / acc));
          };
          const ka = ua < U0 ? at(U0) : 0;
          const kb = ub > U1 ? at(U1) : T;
          if (kb <= ka + 1e-6) continue;
          const u0 = Math.max(U0, Math.min(U1, ua + va * ka + 0.5 * acc * ka * ka));
          const u1 = Math.max(U0, Math.min(U1, ua + va * kb + 0.5 * acc * kb * kb));
          const v0 = Math.max(0, va + acc * ka) * k;
          const v1 = Math.max(0, va + acc * kb) * k;
          emit(car, ta + ka, ta + kb, pid, sBase + (u0 - uBase) * k, sBase + (u1 - uBase) * k, v0, v1, v1, kb - ka, 0, 0, 0);
        }
      };
      for (const run of trucks) {
        const { tu, us } = run;
        const n = tu.length;
        if (n < 2) continue;
        /** 这辆车这一段行驶落在哪些车道上（路径位置的范围），按先后 */
        const maps: { a: number; lane: number; uIn: number; uOut: number; U0: number; U1: number; k: number; pid: number }[] = [];
        // 同一条线、同一个方向接着走的几段并成一段（区域的行程弧比车流的弧粗时，一条车道只记一次）
        const spans: TruckRun['spans'] = [];
        for (const sp of run.spans) {
          const last = spans[spans.length - 1];
          if (last && last.line === sp.line && last.dir === sp.dir && last.lane === sp.lane && (sp.us[0] as number) - (last.us[last.us.length - 1] as number) < 30) spans[spans.length - 1] = { ...last, us: [...last.us, ...sp.us], ss: [...last.ss, ...sp.ss] };
          else if (sp.us.length >= 2) spans.push(sp);
        }
        for (const sp of spans) {
          const line = lines[sp.line];
          if (!line) continue;
          const lane = Math.min(sp.lane, line.xs.lanes - 1);
          const sMin = Math.min(...sp.ss) - 30;
          const sMax = Math.max(...sp.ss) + 30;
          for (const a of onLine.get(sp.line) ?? []) {
            const A = this.arcs[a] as Arc;
            if (A.dir !== sp.dir) continue;
            let c0 = A.s0 + A.dir * this.cut(A.ja, line);
            let c1 = A.s1 - A.dir * this.cut(A.jb, line);
            if (line.closed) {
              const k = Math.round((sMin + sMax - c0 - c1) / 2 / line.len);
              c0 += k * line.len;
              c1 += k * line.len;
            }
            if (Math.max(c0, c1) < sMin || Math.min(c0, c1) > sMax) continue;
            const uIn = interp(sp.ss, sp.us, c0);
            const uOut = interp(sp.ss, sp.us, c1);
            if (!(uOut > uIn + 1)) continue;
            const U0 = Math.max(uIn, us[0] as number, (sp.us[0] as number) - 25);
            const U1 = Math.min(uOut, us[n - 1] as number, (sp.us[sp.us.length - 1] as number) + 25);
            if (U1 <= U0 + 0.5) continue;
            const pid = this.lanePath(a, lane);
            const P = this.paths[pid] as Path;
            const k = P.len / (uOut - uIn);
            const ph: Car = { id: -1, track: ghostTrack, segs: [], kind: 1, len: run.len, arc: a, lane, t: 0, v: 0, dest: '', noise: 0 };
            emitRange(run, ph, pid, U0, U1, uIn, k, 0);
            const segs = ph.segs;
            if (!segs.length) continue;
            maps.push({ a, lane, uIn, uOut, U0, U1, k, pid });
            // 从车道半路开进来的（从场地、路口转进来）：车道起点到它出现的地方按匀速补一段（后面的车跟它用，不画）
            const s0 = segs[3] as number;
            if (s0 > 0.5) {
              const vv = Math.max(segs[5] as number, 0.8 * speedOf(a, false, segs[0] as number));
              segs.unshift((segs[0] as number) - s0 / vv, segs[0] as number, pid, 0, s0, vv, vv, vv, 0, 0, 0, 0);
            }
            const m = segs.length / W;
            const o = (m - 1) * W;
            const res: Res = { t: segs[0] as number, v: segs[5] as number, len: run.len, car: ph, i0: 0, i1: m, tx: segs[o + 1] as number, vx: segs[o + 7] as number, sx: segs[o + 4] as number, pid, vc: speedOf(a, false, segs[0] as number), truck: true };
            let list = resv.get(pid);
            if (!list) resv.set(pid, (list = []));
            list.splice(upper(list, res.t), 0, res);
            stats.trucks++;
          }
        }
        // 过路口：前一条车道的尽头前几米到下一条车道开进去一个车长，按车流的转弯路径记进路口的记录（过路口的背景车和它错开）
        maps.sort((x, y) => x.uIn - y.uIn);
        for (let i = 0; i + 1 < maps.length; i++) {
          const m0 = maps[i] as (typeof maps)[number];
          const m1 = maps[i + 1] as (typeof maps)[number];
          const A0 = this.arcs[m0.a] as Arc;
          if ((!this.net.junctions.has(A0.jb) && !this.virt.has(A0.jb)) || m1.uIn < m0.uOut - 1 || m1.uIn - m0.uOut > 160 || !(this.succ[m0.a] as number[]).includes(m1.a)) continue;
          if (m0.U1 < m0.uOut - 1 || m1.U0 > m1.uIn + 1) continue;
          const tp = this.turnPath(m0.a, m0.lane, m1.a, m1.lane);
          const T = this.paths[tp] as Path;
          const g: Car = { id: -1, track: ghostTrack, segs: [], kind: 2, len: run.len, arc: m1.a, lane: m1.lane, t: 0, v: 0, dest: '', noise: 0 };
          const P0 = this.paths[m0.pid] as Path;
          emitRange(run, g, m0.pid, Math.max(m0.U0, m0.uOut - (P0.len - Math.max(0, P0.len - STOP_BACK - 1)) / m0.k), m0.uOut, m0.uIn, m0.k, 0);
          emitRange(run, g, tp, m0.uOut, m1.uIn, m0.uOut, T.len / Math.max(0.5, m1.uIn - m0.uOut), 0);
          emitRange(run, g, m1.pid, m1.uIn, Math.min(m1.U1, m1.uIn + (run.len + 2) / m1.k), m1.uIn, m1.k, 0);
          if (g.segs.length < W) continue;
          const kEnd = g.segs.length / W;
          let list = jrec.get(A0.jb);
          if (!list) jrec.set(A0.jb, (list = []));
          list.push({ car: g, k0: 0, k1: kEnd, t0: g.segs[0] as number, t1: g.segs[(kEnd - 1) * W + 1] as number, ext: 0 });
        }
      }
    }

    for (const lg of TrafficPlanner.storeLane ? storeLeftLegs(this.net) : []) {
      const lanes = (lines[lg.line] as Line).xs.lanes;
      this.arcs.forEach((A, a) => {
        if (A.line !== lg.line || A.dir !== (lg.end === 'b' ? 1 : -1)) return;
        if ((resv.get(this.lanePath(a, lanes - 1)) ?? []).some((x) => x.truck)) storeLane.set(a, lanes - 1);
      });
    }
    this.storeLaneOn = new Set(storeLane.keys());

    // —— 一天的出行 ——
    // 零点停在各停车场里的车
    for (const run of runs) {
      const n = Math.round((run.lot.occ[0] as number) * run.lot.bays.length);
      // 离场口近的车位先停满（进场的路程加一点随机）
      const order = run.lot.bays.map((_, i) => ({ i, k: (this.paths[run.park[i] as number] as Path).len + r() * 25 })).sort((a, b) => a.k - b.k);
      for (const { i: bay } of order.slice(0, n)) {
        const car = newCar(r() < 0.62 ? 0 : 1, 0);
        const back = run.back[bay] as number;
        run.parked[bay] = car.id;
        car.park = { run, bay, path: back, s: (this.paths[back] as Path).len, since: 0 };
        if (run.lot.use === 'home') car.home = run;
      }
    }
    // 小街路边的车位：零点七成停着住户的车（离路口太近、放不下进出的车位整天停着，最后再加）
    const rc = rand(seed * 3 + 1301);
    const curbs: CurbBay[] = [];
    const curbStatic: { a: V3; b: V3 }[] = [];
    {
      const onLine = new Map<number, number[]>();
      this.arcs.forEach((A, a) => {
        const l = onLine.get(A.line) ?? [];
        l.push(a);
        onLine.set(A.line, l);
      });
      for (const c of this.net.curbs) {
        const cb = TrafficPlanner.curbTurnover ? this.curbBay(c, onLine) : undefined;
        if (cb) curbs.push(cb);
        else curbStatic.push(c);
      }
    }
    for (const cb of curbs) {
      if (rc() > 0.72) continue;
      const car = newCar(rc() < 0.62 ? 0 : 1, 0, Math.floor(rc() * 10), -1, rc);
      car.curbAt = { cb, since: 0 };
      car.homeCurb = cb;
      cb.car = car.id;
    }
    // 每个停车场每小时走几辆、来几辆（按占用率的变化和周转），配成「从这个停车场到那个停车场」的出行；
    // 配不上的：走的去高速口（出区域），来的从高速口进来
    const departs: { t: number; run: LotRun }[] = [];
    const arrivals: { t: number; run: LotRun; used: boolean }[] = [];
    for (const run of runs) {
      // 小区停车场的进出按住户的通勤排（见下面）
      if (run.lot.use === 'home') continue;
      const B = run.lot.bays.length;
      const tau = TURNOVER[run.lot.use] * density;
      for (let h = 0; h < 24; h++) {
        const o0 = run.lot.occ[h] as number;
        const o1 = run.lot.occ[(h + 1) % 24] as number;
        const dep = B * (tau * o0 + Math.max(0, o0 - o1));
        const arr = B * (tau * o0 + Math.max(0, o1 - o0));
        for (let k = 0; k < Math.floor(dep + r()); k++) departs.push({ t: (h + r()) * 3600, run });
        for (let k = 0; k < Math.floor(arr + r()); k++) arrivals.push({ t: (h + r()) * 3600, run, used: false });
      }
    }
    departs.sort((a, b) => a.t - b.t);
    arrivals.sort((a, b) => a.t - b.t);
    interface Depart {
      t: number;
      from?: LotRun;
      edge?: string;
      dest: string;
      destLot?: LotRun;
      /** 指定哪辆车（住户的通勤：早上从家出发的那辆、晚上开回家的那辆） */
      car?: number;
      /** 去停路边车位：这个车位（满了停附近的）、回家门口（停在家门口的路边车位附近） */
      destCurb?: CurbBay;
      curbHome?: boolean;
      /** 过路的货车：车流类别（3 平头厢式货车、4 半挂车） */
      heavy?: number;
    }
    const plans: Depart[] = [];
    let ai = 0;
    for (const d of departs) {
      while (ai < arrivals.length && (arrivals[ai] as { t: number }).t < d.t - 600) ai++;
      let pick = -1;
      if (edges.length === 0 || r() > 0.2)
        for (let k = ai; k < arrivals.length && (arrivals[k] as { t: number }).t < d.t + 2400; k++) {
          const a = arrivals[k] as (typeof arrivals)[number];
          if (!a.used && a.run !== d.run && Number.isFinite(this.costTo(a.run.lot.gate)[d.run.outArc] as number)) {
            pick = k;
            break;
          }
        }
      if (pick >= 0) {
        const a = arrivals[pick] as (typeof arrivals)[number];
        a.used = true;
        plans.push({ t: d.t, from: d.run, dest: a.run.lot.gate, destLot: a.run });
      } else if (edges.length) {
        const e = edges[Math.floor(r() * edges.length)] as string;
        if (Number.isFinite(this.costTo(e)[d.run.outArc] as number)) plans.push({ t: d.t, from: d.run, dest: e });
      }
    }
    // 从高速口进来的车：配不上的到达（提前按路上的用时出发）、过路的车（一个高速口到另一个）
    for (const a of arrivals) {
      if (a.used || !edges.length) continue;
      const e = edges[Math.floor(r() * edges.length)] as string;
      const arc0 = (this.out.get(e) ?? [])[0];
      if (arc0 === undefined) continue;
      const tt = this.costTo(a.run.lot.gate)[arc0] as number;
      if (!Number.isFinite(tt)) continue;
      plans.push({ t: Math.max(0, a.t - tt * 1.15), edge: e, dest: a.run.lot.gate, destLot: a.run });
    }
    // 住户的通勤：零点停在小区停车场的车，一部分早上开出去（去城区、客运站、设施的停车场，或者出区域），晚上开回自己家的小区；
    // 一部分白天出去办一趟事，过一两个小时回来；出区域的车晚上从高速口开回来（算另一辆车的轨迹）
    // 每个停车场白天给住户的车留的车位（这些停车场自己按占用率还有车来车往，留多了会满）
    const work = runs.filter((x) => x.lot.use !== 'home' && x.lot.use !== 'hold');
    const budget = new Map(work.map((x) => [x, Math.max(1, Math.round(x.lot.bays.length * (x.lot.use === 'public' ? 0.14 : 0.2)))]));
    const pickWork = (): LotRun | undefined => {
      const open = work.filter((w) => (budget.get(w) as number) > 0);
      const w = open[Math.floor(r() * open.length)];
      if (w) budget.set(w, (budget.get(w) as number) - 1);
      return w;
    };
    const normalT = (mu: number, sd: number, lo: number, hi: number) => {
      const z = Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
      return Math.max(lo, Math.min(hi, mu + sd * z)) * 3600;
    };
    const commute = Math.min(0.9, 0.72 * Math.sqrt(density));
    for (const run of runs) {
      if (run.lot.use !== 'home') continue;
      for (const id of run.parked) {
        if (id === undefined) continue;
        const car = cars[id] as Car;
        const u = r();
        if (u < commute) {
          const tOut = normalT(7.7, 0.75, 5.8, 10.5);
          const tBack = normalT(18.1, 1.0, 15.5, 22.5);
          const toEdge = edges.length > 0 && r() < 0.3;
          const w = toEdge ? undefined : pickWork();
          if (w && Number.isFinite(this.costTo(w.lot.gate)[run.outArc] as number)) {
            plans.push({ t: tOut, from: run, dest: w.lot.gate, destLot: w, car: id });
            plans.push({ t: tBack, dest: run.lot.gate, destLot: run, car: id });
            car.hold = tBack;
          } else if (edges.length) {
            const e = edges[Math.floor(r() * edges.length)] as string;
            if (!Number.isFinite(this.costTo(e)[run.outArc] as number)) continue;
            plans.push({ t: tOut, from: run, dest: e, car: id });
            // 晚上从高速口开回来：按路上的用时提前出发
            const arc0 = (this.out.get(e) ?? [])[0];
            const tt = arc0 === undefined ? Infinity : (this.costTo(run.lot.gate)[arc0] as number);
            if (Number.isFinite(tt)) plans.push({ t: Math.max(0, tBack - tt * 1.15), edge: e, dest: run.lot.gate, destLot: run });
          }
        } else if (u < commute + 0.18 * Math.min(1.5, density)) {
          const w = work.filter((x) => x.lot.use === 'public' && (budget.get(x) as number) > 0);
          const to = w[Math.floor(r() * w.length)];
          if (to) budget.set(to, (budget.get(to) as number) - 1);
          if (!to || !Number.isFinite(this.costTo(to.lot.gate)[run.outArc] as number)) continue;
          const tOut = (9.5 + r() * 6.5) * 3600;
          const tBack = tOut + (0.6 + r() * 1.6) * 3600;
          // 四成去小街办事：停路边车位（出发的时候挑一个空着的，没有空的再去停车场）
          const cb = curbs.length && rc() < 0.4 ? curbs[Math.floor(rc() * curbs.length)] : undefined;
          plans.push({ t: tOut, from: run, dest: to.lot.gate, destLot: to, car: id, ...(cb ? { destCurb: cb } : {}) });
          plans.push({ t: tBack, dest: run.lot.gate, destLot: run, car: id });
          car.hold = tBack;
        }
      }
    }
    // 路边车位上住户的车：四成多早上开去上班（三成出区域，晚上另一辆从高速口回来），两成白天出去办一趟事；回来停在家门口附近空着的车位
    {
      const normalC = (mu: number, sd: number, lo: number, hi: number) => {
        const z = Math.sqrt(-2 * Math.log(Math.max(1e-9, rc()))) * Math.cos(2 * Math.PI * rc());
        return Math.max(lo, Math.min(hi, mu + sd * z)) * 3600;
      };
      const share = Math.min(0.7, 0.42 * Math.sqrt(density));
      for (const cb of curbs) {
        const id = cb.car;
        if (id === undefined) continue;
        const outArc = cb.arc;
        const u = rc();
        if (u < share) {
          const tOut = normalC(7.5, 0.8, 5.8, 10.5);
          const tBack = normalC(18.4, 1.1, 15.5, 22.8);
          const w = edges.length && rc() < 0.3 ? undefined : pickWork();
          if (w && Number.isFinite(this.costTo(w.lot.gate)[outArc] as number)) {
            plans.push({ t: tOut, dest: w.lot.gate, destLot: w, car: id });
            plans.push({ t: tBack, dest: '', curbHome: true, car: id });
          } else if (edges.length) {
            const e = edges[Math.floor(rc() * edges.length)] as string;
            if (!Number.isFinite(this.costTo(e)[outArc] as number)) continue;
            plans.push({ t: tOut, dest: e, car: id });
            const arc0 = (this.out.get(e) ?? [])[0];
            const tt = arc0 === undefined ? Infinity : (this.costTo((this.arcs[cb.arc] as Arc).ja)[arc0] as number);
            if (Number.isFinite(tt)) plans.push({ t: Math.max(0, tBack - tt * 1.15), edge: e, dest: '', destCurb: cb });
          }
        } else if (u < share + 0.2) {
          const w = work.filter((x) => x.lot.use === 'public');
          const to = w[Math.floor(rc() * w.length)];
          if (!to || !Number.isFinite(this.costTo(to.lot.gate)[outArc] as number)) continue;
          const tOut = (9 + rc() * 7.5) * 3600;
          plans.push({ t: tOut, dest: to.lot.gate, destLot: to, car: id });
          plans.push({ t: tOut + (0.4 + rc() * 1.8) * 3600, dest: '', curbHome: true, car: id });
        }
      }
    }
    if (edges.length >= 2) {
      const hourW = HOURLY.reduce((s, x) => s + x, 0);
      // 过路的车：负荷高的时候按平方根增加（高速口外面已经堵着，进来的车有上限），本地往来的车照常按倍数增加
      const n = Math.round(2400 * (density <= 1 ? density : Math.sqrt(density)));
      for (let k = 0; k < n; k++) {
        let x = r() * hourW;
        let h = 0;
        while (h < 23 && x > (HOURLY[h] as number)) x -= HOURLY[h++] as number;
        const i = Math.floor(r() * edges.length);
        // 过路的车里有一些货车（按车次的编号定，不多抽随机数：小汽车的出行和以前一样）
        const u = heavyDraw(k, seed);
        const heavy = u < THROUGH_BOX ? HEAVY : u < THROUGH_BOX + THROUGH_SEMI ? HEAVY + 1 : undefined;
        plans.push({ t: (h + r()) * 3600, edge: edges[i] as string, dest: edges[(i + 1) % edges.length] as string, ...(heavy ? { heavy } : {}) });
      }
    }
    plans.sort((a, b) => a.t - b.t);
    /** 一趟出行出发：从停车场出发的挑一辆此刻停在那里的车；从高速口进来的在区域外的远处、车道有空当时上路 */
    /** 路边车位：near 附近（同一条街先挑，离得近的先挑）此刻空着、没人定的车位；都没有返回 undefined */
    const freeCurb = (near: CurbBay | undefined, from: number): CurbBay | undefined => {
      let best: CurbBay | undefined;
      let bd = Infinity;
      for (const cb of curbs) {
        if (cb.car !== undefined || cb.claim !== undefined || !Number.isFinite(this.costTo((this.arcs[cb.arc] as Arc).ja)[from] as number)) continue;
        const d = near ? Math.hypot(cb.x - near.x, cb.z - near.z) + (cb.line === near.line ? 0 : 150) : rc() * 1000;
        if (d < bd) [bd, best] = [d, cb];
      }
      return near && bd > 900 ? undefined : best;
    };
    /**
     * 车（此刻在弧 from 上）去停路边车位 cb：先开到一条能转进车位那条弧的弧（路口不能掉头，从另一头来的转不进去）的起点，
     * 沿它开到头、转进去，在车位前停车倒进去
     */
    const toCurb = (car: Car, cb: CurbBay, from: number) => {
      const A0 = this.arcs[cb.arc] as Arc;
      car.curb = cb;
      cb.claim = car.id;
      car.curbTries = 0;
      car.destLot = undefined;
      car.curbVia = undefined;
      car.dest = A0.ja;
      if ((this.pred[cb.arc] as number[]).includes(from)) return;
      let best = Infinity;
      for (const p of this.pred[cb.arc] as number[]) {
        const P0 = this.arcs[p] as Arc;
        const c = (this.costTo(P0.ja)[from] as number) + P0.len / Math.max(0.3, SPEED[(lines[P0.line] as Line).cls]);
        if (c < best) [best, car.curbVia, car.dest] = [c, p, P0.ja];
      }
    };
    const launch = (dp: Depart) => {
      if (dp.car !== undefined) {
        // 住户的车：早上在家、晚上在停着的地方（满了换过停车场也照样找得到）
        const car = cars[dp.car] as Car;
        const cp = car.curbAt;
        const pk = car.park;
        if (cp ? cp.since > dp.t : !pk || pk.since > dp.t || (dp.from && pk.run !== dp.from)) return;
        const from = cp ? cp.cb.arc : (pk as NonNullable<typeof pk>).run.outArc;
        // 去路边车位的：挑一个此刻空着的（回家的停在家门口附近；来办事的没有空位就照原来去停车场）
        const cb = dp.curbHome || dp.destCurb ? freeCurb(dp.destCurb ?? car.homeCurb, from) : undefined;
        if (cb) toCurb(car, cb, from);
        else {
          if (dp.curbHome || !dp.dest) return;
          if (pk && pk.run === dp.destLot) return;
          if (!Number.isFinite(this.costTo(dp.dest)[from] as number)) return;
          car.dest = dp.dest;
          car.destLot = dp.destLot;
        }
        if (dp.destLot === car.home && !cb) car.hold = undefined;
        if (cp) {
          const tj = leaveCurb(car, dp.t);
          if (tj === undefined) {
            if (car.curb) car.curb.claim = undefined;
            car.curb = undefined;
            return;
          }
          stats.trips++;
          stats.curbOut++;
          push({ t: tj, car });
          return;
        }
        stats.trips++;
        push({ t: leaveLot(car, dp.t), car });
        return;
      }
      if (dp.from) {
        const here = dp.from.parked.filter((c): c is number => c !== undefined).map((id) => cars[id] as Car).filter((c) => c.park && c.park.since <= dp.t && (c.hold ?? 0) <= dp.t);
        if (!here.length) return;
        const car = here[Math.floor(r() * here.length)] as Car;
        car.dest = dp.dest;
        car.destLot = dp.destLot;
        stats.trips++;
        push({ t: leaveLot(car, dp.t), car });
        return;
      }
      const arc0 = (this.out.get(dp.edge as string) ?? [])[0];
      if (arc0 === undefined) return;
      // 晚上从高速口回来、停家门口路边车位的车：此刻家门口附近没有空位就不来
      const cbE = dp.destCurb ? freeCurb(dp.destCurb, arc0) : undefined;
      if (dp.destCurb && !cbE) return;
      const u0 = r();
      const car = newCar(dp.heavy ?? (u0 < 0.62 ? 0 : 1), dp.t);
      car.dest = dp.dest;
      car.destLot = dp.destLot;
      if (cbE) {
        toCurb(car, cbE, arc0);
        car.homeCurb = dp.destCurb;
      }
      const vc = speedOf(arc0, false, dp.t);
      let lane = 0;
      let at = Infinity;
      for (let l = 0; l < (lines[(this.arcs[arc0] as Arc).line] as Line).xs.lanes; l++) {
        const s = findSlot(this.lanePath(arc0, l), dp.t, vc, car.len, car.kind);
        if (s < at - 0.01) [at, lane] = [s, l];
      }
      car.arc = arc0;
      car.lane = lane;
      car.v = vc;
      car.t = at;
      car.res = reserve(this.lanePath(arc0, lane), at, vc, car, vc);
      stats.trips++;
      push({ t: at, car });
    };
    // 零点的公交车：在首末站的港湾里排着（一半在 A 站、一半在 B 站），按时刻表发车
    this.busRoutes.forEach((br, li) => {
      const terms = lineTerms[li] as Map<string, Term>;
      const nA = Math.min(br.cap[0], Math.ceil(br.fleet / 2));
      const nB = Math.min(br.cap[1], br.fleet - nA);
      for (const [stopId, n, k] of [
        [br.ids[0], nA, br.kA],
        [br.ids[1], nB, br.kB],
      ] as const) {
        const stop = this.virt.get(stopId) as BusStop;
        for (let i = 0; i < n; i++) {
          const car = newCar(2, 0, br.line, br.line);
          car.bus = { r: br, k, terms };
          bayPart(car, stop, 0, Math.max(0, stop.stopAt - i * (BUS_LEN + GAP0)), 0);
        }
      }
    });
    let pi = 0;
    while (heap.length || pi < plans.length) {
      if (pi < plans.length && (!heap.length || (plans[pi] as Depart).t <= (heap[0] as { t: number }).t)) {
        now = (plans[pi] as Depart).t;
        launch(plans[pi++] as Depart);
        continue;
      }
      const { t, car } = pop();
      now = t;
      if (car.done) continue;
      if (t > DAY_END) {
        car.done = true;
        car.t = t;
        continue;
      }
      decide(car, t);
    }
    // 小街路边离路口太近的车位（放不下进出）：整天停着（六成车位有车）
    for (const c of curbStatic) {
      if (rc() > 0.62) continue;
      const car = newCar(rc() < 0.62 ? 0 : 1, 0, Math.floor(rc() * 10), -1, rc);
      // 路径从车尾再往后 2 米起（车长 5 米的车尾也落在路径上），车头在终点
      const dl = c.a.distanceTo(c.b) || 1;
      const pid = this.addPath([c.a.clone().lerp(c.b, -2 / dl), c.b.clone()]);
      const len = (this.paths[pid] as Path).len;
      emit(car, 0, DAY_END, pid, len, len, 0, 0, 0, 0, 0, 0, 1);
      car.t = DAY_END;
      car.done = true;
    }
    // 收尾：停着的车停到这一天结束；每辆车一条轨迹
    for (const car of cars) {
      if (car.park) {
        const pk = car.park;
        if (DAY_END > pk.since) emit(car, pk.since, DAY_END, pk.path, pk.s, pk.s, 0, 0, 0, 0, 0, 0, 1);
        car.t = DAY_END;
      }
      if (car.curbAt) {
        const cp = car.curbAt;
        if (DAY_END > cp.since) emit(car, cp.since, DAY_END, cp.cb.path, cp.cb.pRest, cp.cb.pRest, 0, 0, 0, 0, 0, 0, 1);
        car.t = DAY_END;
      }
      this.finish(car.track, car.segs, Math.max(car.t, car.track.t0));
    }
    this.flatten();
    this.index();
  }

  private finish(track: CarTrack, segs: number[], t: number): void {
    const n = segs.length / W;
    track.segT0 = new Float64Array(n);
    track.segT1 = new Float64Array(n);
    track.segP = new Int32Array(n);
    track.segS0 = new Float32Array(n);
    track.segS1 = new Float32Array(n);
    track.segV0 = new Float32Array(n);
    track.segVp = new Float32Array(n);
    track.segV1 = new Float32Array(n);
    track.segTa = new Float32Array(n);
    track.segTb = new Float32Array(n);
    track.segTurn = new Int8Array(n);
    track.segLot = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * W;
      track.segT0[i] = segs[o] as number;
      track.segT1[i] = segs[o + 1] as number;
      track.segP[i] = segs[o + 2] as number;
      track.segS0[i] = segs[o + 3] as number;
      track.segS1[i] = segs[o + 4] as number;
      track.segV0[i] = segs[o + 5] as number;
      track.segVp[i] = segs[o + 6] as number;
      track.segV1[i] = segs[o + 7] as number;
      track.segTa[i] = segs[o + 8] as number;
      track.segTb[i] = segs[o + 9] as number;
      track.segTurn[i] = segs[o + 10] as number;
      track.segLot[i] = segs[o + 11] as number;
    }
    if (!n) return;
    track.t0 = track.segT0[0] as number;
    track.t1 = Math.max(t, track.segT1[n - 1] as number);
    this.cars.push(track);
  }

  /** 路径 pid 在路程 s 处的位置和朝向（测试用；算之前也能用） */
  /**
   * 门店路口左转进口道（门店的车左转进进店路的那几条腿）上的背景车：每辆开过这一截的车开进、开出的时刻（开出 = 过停止线进路口）、
   * 这一截按限速开要多久；门店的车（预约）不算。对比门店专用车道对干道直行车的影响（通行量、平均多等多久）。
   * Background cars on the store's left-turn approach legs: entry / exit times and free-flow time (to measure the store-only lane's effect).
   */
  storeApproach(): { legs: { line: number; arcs: number[]; lanes: number; len: number; free: number; storeLane: boolean; cars: { t0: number; t1: number; bus: boolean }[] }[] } {
    const lines = this.net.lines;
    const out: ReturnType<TrafficPlanner['storeApproach']>['legs'] = [];
    for (const lg of storeLeftLegs(this.net)) {
      const line = lines[lg.line] as Line;
      const lanes = line.xs.lanes;
      const arcs: number[] = [];
      this.arcs.forEach((A, a) => {
        if (A.line === lg.line && A.dir === (lg.end === 'b' ? 1 : -1)) arcs.push(a);
      });
      // 只看到路口的那一截（最后一条弧：从上一个路口或停车场口到门店路口）
      const jid = lg.end === 'a' ? line.ja : line.jb;
      const a = arcs.find((x) => (this.arcs[x] as Arc).jb === jid) ?? arcs[arcs.length - 1];
      if (a === undefined) continue;
      const A = this.arcs[a] as Arc;
      const pids = new Map<number, number>();
      for (let k = 0; k < lanes; k++) pids.set(this.lanePath(a, k), k);
      const cars: { t0: number; t1: number; bus: boolean }[] = [];
      for (const c of this.cars) {
        // 从这一截的起点开进来、开到停止线过路口的（路边车位、停车场口在这一截中间进出的不算）；一辆车一天可能过几次
        let t0 = NaN;
        for (let i = 0; i < c.segP.length; i++) {
          const pid = c.segP[i] as number;
          if (!pids.has(pid) || c.segLot[i]) {
            t0 = NaN;
            continue;
          }
          const L = (this.paths[pid] as Path).len;
          if (Number.isNaN(t0) && (c.segS0[i] as number) < 3) t0 = c.segT0[i] as number;
          const nx = c.segP[i + 1];
          if (!Number.isNaN(t0) && (c.segS1[i] as number) > L - STOP_BACK - 3 && (nx === undefined || !pids.has(nx))) {
            cars.push({ t0, t1: c.segT1[i] as number, bus: c.kind === 2 });
            t0 = NaN;
          }
        }
      }
      const storeLane = TrafficPlanner.storeLane && this.cars.length > 0 && this.storeLaneOn.has(a);
      out.push({ line: lg.line, arcs: [a], lanes, len: A.len, free: A.len / SPEED[line.cls], storeLane, cars });
    }
    return { legs: out };
  }
  /** 这一天哪几条弧的最里面那条车道只给门店的车（simulate 里定） */
  private storeLaneOn = new Set<number>();

  pathAt(pid: number, s: number): { x: number; z: number; dx: number; dz: number } {
    const p = this.paths[pid] as Path;
    const q = sampleAt(p.pts, p.cum, s);
    return { x: q.p.x, z: q.p.z, dx: q.dx, dz: q.dz };
  }

  /**
   * 自查（测试用）：过信号灯路口的次数和闯红灯的次数（按车开过停止线 / 等候线的时刻查灯色，黄灯算可以过）、
   * 路上停得最久的一次（秒，不算停车场、公交港湾）、轨迹前后接不上的地方、公交在港湾里停靠的次数（中途站、首末站）
   */
  audit(): { crossings: number; redRuns: number; maxRoadStill: number; gaps: number; busDwells: number; busTermWaits: number } {
    const signalAt = new Map<number, { j: Junction; phase: number; Ld: number }>();
    for (const [key, pid] of this.lanePaths) {
      const [as, ls] = key.split(':');
      const a = Number(as);
      const A = this.arcs[a] as Arc;
      const j = this.net.junctions.get(A.jb);
      if (!j || !j.signal || j.kind === 'mid' || j.kind === 'merge') continue;
      const line = this.net.lines[A.line] as Line;
      const ph = j.phase.get(A.line * 2 + (A.jb === line.ja ? 0 : 1));
      if (ph === undefined) continue;
      const P = this.paths[pid] as Path;
      const depth = this.boxDepth(a, Number(ls), true);
      signalAt.set(pid, { j, phase: ph, Ld: Math.min(P.len - STOP_BACK, P.len - depth - (depth > 0 ? 0.5 : 0)) });
    }
    const bays = new Set(this.bayPaths.values());
    const out = { crossings: 0, redRuns: 0, maxRoadStill: 0, gaps: 0, busDwells: 0, busTermWaits: 0 };
    const pt = (pid: number, ss: number) => {
      const p = this.paths[pid] as Path;
      return sampleAt(p.pts, p.cum, ss).p;
    };
    for (const c of this.cars) {
      const n = c.segT0.length;
      for (let k = 0; k < n; k++) {
        const pid = c.segP[k] as number;
        const s0 = c.segS0[k] as number;
        const s1 = c.segS1[k] as number;
        const T = (c.segT1[k] as number) - (c.segT0[k] as number);
        if (k > 0) {
          const pp = c.segP[k - 1] as number;
          const e = c.segS1[k - 1] as number;
          if (pp === pid ? Math.abs(e - s0) > 0.05 : pt(pp, e).distanceTo(pt(pid, s0)) > 1) out.gaps++;
        }
        if (s0 === s1) {
          if (bays.has(pid)) {
            if (c.kind === 2 && T >= 15) (c.segLot[k] === 2 ? out.busTermWaits++ : out.busDwells++);
          } else if ((c.segLot[k] as number) === 0) out.maxRoadStill = Math.max(out.maxRoadStill, T);
          continue;
        }
        const sig = signalAt.get(pid);
        if (!sig) continue;
        // 开着车越过等候线（到线上时还有速度），或者停在线上以后起步：那一刻要是绿灯或黄灯
        const e = 1e-3;
        let tc = -1;
        if (Math.abs(s0 - sig.Ld) <= e && s1 > s0 + e) tc = c.segT0[k] as number;
        else if (s0 < sig.Ld - e && (s1 > sig.Ld + e || (s1 >= sig.Ld - e && (c.segV1[k] as number) > 0.05))) {
          let lo = 0;
          let hi = T;
          for (let i = 0; i < 40; i++) {
            const m = (lo + hi) / 2;
            prof(c.segV0[k] as number, c.segVp[k] as number, c.segV1[k] as number, c.segTa[k] as number, c.segTb[k] as number, T, m, TMP);
            if (s0 + (TMP[0] as number) >= sig.Ld - e) hi = m;
            else lo = m;
          }
          tc = (c.segT0[k] as number) + hi;
        }
        if (tc < 0) continue;
        out.crossings++;
        if (local(sig.j, sig.phase, tc) >= GREEN + AMBER) out.redRuns++;
      }
    }
    return out;
  }

  /** 路径的点拍平（播放用） */
  private flatten(): void {
    let total = 0;
    for (const p of this.paths) total += p.pts.length;
    this.pOff = new Int32Array(this.paths.length + 1);
    this.pX = new Float32Array(total);
    this.pY = new Float32Array(total);
    this.pZ = new Float32Array(total);
    this.pCum = new Float32Array(total);
    let k = 0;
    this.paths.forEach((p, i) => {
      this.pOff[i] = k;
      p.pts.forEach((q, j) => {
        this.pX[k] = q.x;
        this.pY[k] = q.y;
        this.pZ[k] = q.z;
        this.pCum[k] = p.cum[j] as number;
        k++;
      });
    });
    this.pOff[this.paths.length] = k;
  }

  /**
   * 人行横道和车占着它的时段：每条斑马线落在进路口、出路口的车道路径的哪一截（进口道是路径最后 1.4–5.4 米，
   * 出口道是开头 1.4–5.4 米），扫一遍所有车的轨迹，车身（车头往后一个车长）压在这一截上的时段都记下来。
   */
  crosswalks(): Crosswalk[] {
    const net = this.net;
    const out: Crosswalk[] = [];
    for (const j of net.junctions.values()) {
      if (j.kind !== 'grade' && j.kind !== 'mid') continue;
      if (j.kind === 'grade' && j.legs.length < 3) continue;
      for (const leg of j.legs) {
        const line = net.lines[leg.line] as Line;
        if (line.cls !== 'arterial' && line.cls !== 'street' && line.cls !== 'local' && line.cls !== 'under') continue;
        const tr = leg.end === 'a' ? line.trimA : line.trimB;
        if (tr <= 0.5 && j.kind !== 'mid') continue;
        if (line.len < tr * 2 + 12) continue;
        const sMid = leg.end === 'a' ? tr + ZEBRA_MID : line.len - tr - ZEBRA_MID;
        const q = sampleAt(line.pts, line.cum, sMid);
        const u = leg.end === 'a' ? { x: q.dx, z: q.dz } : { x: -q.dx, z: -q.dz };
        out.push({ id: `${j.id}:${leg.line}:${leg.end}`, junction: j.id, line: leg.line, cx: q.p.x, cy: line.elev(sMid), cz: q.p.z, ux: u.x, uz: u.z, hw: leg.hw, hl: ZEBRA_HALF, curb: halfRoad(line.xs) + 0.3, signal: j.signal && j.kind === 'grade', phase: j.phase.get(leg.line * 2 + (leg.end === 'a' ? 0 : 1)) ?? 0, offset: j.offset, busy: [] });
      }
    }
    // 每条路径从斑马线上经过的那一截：路径（车身中线）进到斑马线外扩半个车宽再留点余量的范围里。
    // 按几何找，不按「哪条线的车道」找：挨着、压着这条路的高速、匝道、公交港湾、路口里拐弯的路径都算上
    const G = 25;
    const key = (gx: number, gz: number) => gx * 65536 + gz;
    // 格子 → 附近（本格和周围 8 格）的斑马线
    const near = new Map<number, number[]>();
    out.forEach((cw, i) => {
      const gx = Math.floor(cw.cx / G);
      const gz = Math.floor(cw.cz / G);
      for (let ix = gx - 1; ix <= gx + 1; ix++)
        for (let iz = gz - 1; iz <= gz + 1; iz++) {
          const list = near.get(key(ix, iz)) ?? [];
          list.push(i);
          near.set(key(ix, iz), list);
        }
    });
    /** 车道上哪几截在斑马线上：车道中线离斑马线不到 EXT 米（车身半宽，长车再加转弯时车身切进弯里的弦高）就算 */
    const bandsFor = (EXT: number) => {
    const bands = new Map<number, { cw: number; b0: number; b1: number }[]>();
    this.paths.forEach((P, pid) => {
      const open = new Map<number, [number, number]>();
      const close = (ci: number, run: [number, number]) => {
        const list = bands.get(pid) ?? [];
        list.push({ cw: ci, b0: run[0] - 0.5, b1: run[1] + 0.5 });
        bands.set(pid, list);
      };
      const pts = P.pts;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i] as V3;
        const b = pts[i + 1] as V3;
        const sa = P.cum[i] as number;
        const dl = (P.cum[i + 1] as number) - sa;
        const n = Math.max(1, Math.ceil(dl / 0.5));
        for (let k = i === 0 ? 0 : 1; k <= n; k++) {
          const f = k / n;
          const x = a.x + (b.x - a.x) * f;
          const y = a.y + (b.y - a.y) * f;
          const z = a.z + (b.z - a.z) * f;
          const s = sa + dl * f;
          const list = near.get(key(Math.floor(x / G), Math.floor(z / G)));
          if (!list && !open.size) continue;
          const inside = new Set<number>();
          for (const ci of list ?? []) {
            const cw = out[ci] as Crosswalk;
            if (Math.abs(y - cw.cy) > 2.5) continue;
            const along = (x - cw.cx) * cw.ux + (z - cw.cz) * cw.uz;
            const across = -(x - cw.cx) * cw.uz + (z - cw.cz) * cw.ux;
            if (Math.abs(along) <= cw.hl + EXT && Math.abs(across) <= cw.curb + EXT) inside.add(ci);
          }
          for (const ci of inside) {
            const run = open.get(ci);
            if (run) run[1] = s;
            else open.set(ci, [s, s]);
          }
          for (const [ci, run] of open)
            if (!inside.has(ci)) {
              close(ci, run);
              open.delete(ci);
            }
        }
      }
      for (const [ci, run] of open) close(ci, run);
    });
    return bands;
    };
    const bandsCar = bandsFor(1.25 + 0.4);
    // 公交、货车车身长：路口里转弯时车身（车头到车尾的那根弦）切进弯里，按转弯半径 12 米的弦高（车长² / 8R）多留出来
    const bandsLong = bandsFor(1.25 + 0.4 + (CAR_LEN[4] as number) ** 2 / (8 * 12));
    // 一段里走过 d 米的时刻（段内匀加速—匀速—匀减速，二分）
    const tmp = [0, 0];
    const timeAt = (c: CarTrack, k: number, d: number): number => {
      const t0 = c.segT0[k] as number;
      const T = Math.max(0, (c.segT1[k] as number) - t0);
      const D = Math.abs((c.segS1[k] as number) - (c.segS0[k] as number));
      if (d <= 0) return t0;
      if (d >= D) return t0 + T;
      let lo = 0;
      let hi = T;
      for (let it = 0; it < 32; it++) {
        const m = (lo + hi) / 2;
        prof(c.segV0[k] as number, c.segVp[k] as number, c.segV1[k] as number, c.segTa[k] as number, c.segTb[k] as number, T, m, tmp);
        if ((tmp[0] as number) < d) lo = m;
        else hi = m;
      }
      return t0 + hi;
    };
    for (const c of this.cars) {
      const n = c.segT0.length;
      const L = CAR_LEN[c.kind] ?? 4.6;
      for (let k = 0; k < n; k++) {
        const list = (c.kind >= 2 ? bandsLong : bandsCar).get(c.segP[k] as number);
        if (!list) continue;
        const s0 = c.segS0[k] as number;
        const s1 = c.segS1[k] as number;
        if (s1 < s0 - 1e-6) continue;
        for (const b of list) {
          const top = b.b1 + L;
          if (s1 < b.b0 || s0 > top) continue;
          const tIn = s0 >= b.b0 ? (c.segT0[k] as number) : timeAt(c, k, b.b0 - s0);
          // 车尾离开这一截：车头再往前一个车长（可能已经在下一条路径上）
          let need = top - s0;
          let kk = k;
          let tOut = c.t1;
          while (kk < n) {
            const a0 = c.segS0[kk] as number;
            const a1 = c.segS1[kk] as number;
            if (a1 < a0 - 1e-6) {
              tOut = c.segT0[kk] as number;
              break;
            }
            const dk = a1 - a0;
            if (need <= dk) {
              tOut = timeAt(c, kk, need);
              break;
            }
            need -= Math.max(0, dk);
            kk++;
          }
          (out[b.cw] as Crosswalk).busy.push(tIn - 0.5, tOut + 0.5);
        }
      }
    }
    for (const cw of out) {
      const iv: [number, number][] = [];
      for (let i = 0; i < cw.busy.length; i += 2) iv.push([cw.busy[i] as number, cw.busy[i + 1] as number]);
      iv.sort((a, b) => a[0] - b[0]);
      const merged: number[] = [];
      for (const [a, b] of iv) {
        const n = merged.length;
        if (n && a <= (merged[n - 1] as number)) merged[n - 1] = Math.max(merged[n - 1] as number, b);
        else merged.push(a, b);
      }
      cw.busy = merged;
    }
    return out;
  }

  /** 打包算好的结果（传给主线程） */
  data(): TrafficData {
    const cars = this.cars;
    const N = cars.reduce((acc, c) => acc + c.segT0.length, 0);
    const d: TrafficData = {
      kind: new Uint8Array(cars.length),
      color: new Uint8Array(cars.length),
      line: new Int16Array(cars.length),
      t0: new Float64Array(cars.length),
      t1: new Float64Array(cars.length),
      off: new Int32Array(cars.length),
      n: new Int32Array(cars.length),
      segT0: new Float64Array(N),
      segT1: new Float64Array(N),
      segP: new Int32Array(N),
      segS0: new Float32Array(N),
      segS1: new Float32Array(N),
      segV0: new Float32Array(N),
      segVp: new Float32Array(N),
      segV1: new Float32Array(N),
      segTa: new Float32Array(N),
      segTb: new Float32Array(N),
      segTurn: new Int8Array(N),
      segLot: new Uint8Array(N),
      pOff: this.pOff.slice(),
      pX: this.pX.slice(),
      pY: this.pY.slice(),
      pZ: this.pZ.slice(),
      pCum: this.pCum.slice(),
      barriers: [...this.barrierUp],
      busStops: this.busStops.map((st) => ({ ...st, bay: st.bay.map((q) => ({ x: q.x, y: q.y, z: q.z })), shelter: { x: st.shelter.x, y: st.shelter.y, z: st.shelter.z }, sign: { x: st.sign.x, y: st.sign.y, z: st.sign.z } })),
      busLines: this.busLines.map((l) => ({ ...l })),
      stats: { ...this.stats },
    };
    let o = 0;
    cars.forEach((c, i) => {
      d.kind[i] = c.kind;
      d.color[i] = c.color;
      d.line[i] = c.line;
      d.t0[i] = c.t0;
      d.t1[i] = c.t1;
      d.off[i] = o;
      d.n[i] = c.segT0.length;
      d.segT0.set(c.segT0, o);
      d.segT1.set(c.segT1, o);
      d.segP.set(c.segP, o);
      d.segS0.set(c.segS0, o);
      d.segS1.set(c.segS1, o);
      d.segV0.set(c.segV0, o);
      d.segVp.set(c.segVp, o);
      d.segV1.set(c.segV1, o);
      d.segTa.set(c.segTa, o);
      d.segTb.set(c.segTb, o);
      d.segTurn.set(c.segTurn, o);
      d.segLot.set(c.segLot, o);
      o += c.segT0.length;
    });
    return d;
  }
}

/** 0…1 的平滑过渡（两头导数为 0） */
function smooth(x: number): number {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
}
