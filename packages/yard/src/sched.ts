import type { PathState, RigPose, VehicleDims, YardPlan, YardSchedule, YardSeg, YardSegKind, YardTimeline, YardVehicle, YardVisit } from './index';
import { HOLD_WINDOW, MIN_WORK, PREP, R_IN, SWING_WAIT } from './consts';
import type { OBB } from './geom';
import { TimedPath, timingOf, type PathTiming } from './path';
import { BOBTAIL, backOf, dimsOf, footprintInto, frontOf } from './rig';
import { laneDrive, lanePose, legPose, QueueMotion, shunterRoute, stallRoute, yardRoute, type Leg, type ShuntRoute, type YardRoute } from './routes';

/**
 * 场内动作的排程（第一部分 Storewright 卸货场调度的做法，推广到长墙和甩挂）：
 * - 时刻以仿真为准：arrive 到进场点，dockAt 开始装卸（之前要靠稳并做完准备），leaveAt 开始拉出；
 * - 驶离优先：先按 leaveAt 排每辆车的拉出驶离，占用它经过的区段；
 * - 进场按「最晚该开始进场调车的时刻」排先后，待命车道单列先进先出（先到的车要是得让后到的先进，就在场外等候区等着，hold）；
 *   每辆车的进场调车放在不和别的动作冲突、门也空着的最晚时刻（多出来的时间在待命车道上等），排不进就往后挪并标 tight；
 * - 场地按区段（长墙分几段）记占用：车身的矩形落在哪段、哪个掉头处、顶部车道、甩挂区，那一段这段时间就被占着，
 *   同一时间同一段只有一辆车在调车；门少的场地只有一段，就是「场里同一时间只有一辆车在调车」；
 * - 甩挂：公路牵引车甩下挂车（占顶部车道、甩挂区），场内牵引车按 dockAt 把挂车拖到门、leaveAt 后拖回车位，空车来挂走。
 * 结果是确定的；poseAt 取任一时刻每辆车（和挂车、场内牵引车）的位姿。
 */
type Spans = Map<string, Array<[number, number]>>;

const PAD = 1.5;
const STEP = 5;

function prepOf(d: VehicleDims): number {
  return d.kind === 'rig' ? PREP.rig : d.length > 8 ? PREP.truck : PREP.van;
}

/**
 * 进场的通道 G：进场道路的进场车道（场外那一段 + 场里那一段直路）和它拐进场里第一条车道的转弯。
 * 车身落在这里就占着 G：从进场点开进来、在这里排队的车，甩挂进场的车和场内牵引车，紧凑布置里横穿过去驶离的车都走这里。
 * 直路的带子只到进场道路的中线（驶出车道上的车碰不到它）；转弯按圆环算（挂车切内侧，内圈留到半径 6.5 米）。
 */
interface GateZone {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 转弯的圆心、朝哪个象限（dx：转向 −x 为 −1；dz：上来 +1、下来 −1）、圆环的内外半径、整个转弯的外接矩形 */
  cx: number;
  cz: number;
  dx: number;
  dz: number;
  r0: number;
  r1: number;
  box: [number, number, number, number];
}
const GATE_ZONES = new WeakMap<YardPlan, GateZone>();
function gateZone(p: YardPlan): GateZone {
  let g = GATE_ZONES.get(p);
  if (!g) {
    const u = p.from === 'back' ? 1 : -1;
    const zLane = p.side === 'right' ? p.zQueue : p.level === 'court' ? p.zCourt : p.zTop;
    const dx = p.side === 'right' ? -1 : 1;
    const zTurn = zLane - u * R_IN;
    const zOuter = p.gateIn.z - u * (p.driveLen + 25);
    const cx = p.xIn + dx * R_IN;
    const r1 = R_IN + 2.5;
    const bx = [p.xIn - dx * 2.5, cx];
    const bz = [zTurn - u * 1, zTurn + u * r1];
    g = { x0: p.xIn - 2, x1: p.xIn + 2, z0: Math.min(zTurn, zOuter), z1: Math.max(zTurn, zOuter), cx, cz: zTurn, dx, dz: u, r0: R_IN - 6.5, r1, box: [Math.min(bx[0] as number, bx[1] as number), Math.max(bx[0] as number, bx[1] as number), Math.min(bz[0] as number, bz[1] as number), Math.max(bz[0] as number, bz[1] as number)] };
    GATE_ZONES.set(p, g);
  }
  return g;
}
/** 矩形的外接 AABB 写进 R = [x0, x1, z0, z1]（角点和 obbCorners 一样算，不分配） */
const R = new Float64Array(4);
const CU = [1, 1, -1, -1] as const;
const CV = [1, -1, -1, 1] as const;
function boxRange(box: OBB): void {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  const fx = Math.sin(box.h);
  const fz = Math.cos(box.h);
  const sx = Math.cos(box.h);
  const sz = -Math.sin(box.h);
  for (let i = 0; i < 4; i++) {
    const u = CU[i] as number;
    const v = CV[i] as number;
    const cx = box.x + fx * u * box.hl + sx * v * box.hw;
    const cz = box.z + fz * u * box.hl + sz * v * box.hw;
    x0 = Math.min(x0, cx);
    x1 = Math.max(x1, cx);
    z0 = Math.min(z0, cz);
    z1 = Math.max(z1, cz);
  }
  R[0] = x0;
  R[1] = x1;
  R[2] = z0;
  R[3] = z1;
}
/** 车身矩形（反复用） */
const BOXES: OBB[] = [
  { x: 0, z: 0, hl: 0, hw: 0, h: 0 },
  { x: 0, z: 0, hl: 0, hw: 0, h: 0 },
];
/** 一个车身矩形（AABB 已算好）在不在进场通道 G 里：直路按带子，转弯按车身四边上每隔 1.5 米的点落没落在圆环的那个象限里 */
function boxInGate(g: GateZone, box: OBB, x0: number, x1: number, z0: number, z1: number): boolean {
  if (x1 > g.x0 && x0 < g.x1 && z1 > g.z0 && z0 < g.z1) return true;
  if (x1 < g.box[0] || x0 > g.box[1] || z1 < g.box[2] || z0 > g.box[3]) return false;
  const fx = Math.sin(box.h);
  const fz = Math.cos(box.h);
  const n = Math.max(1, Math.ceil(box.hl / 1.5));
  const m = Math.max(1, Math.ceil(box.hw / 1.5));
  const hit = (x: number, z: number) => {
    const ax = (x - g.cx) * -g.dx;
    const az = (z - g.cz) * g.dz;
    if (ax < -1 || az < -1) return false;
    const r = Math.hypot(x - g.cx, z - g.cz);
    return r >= g.r0 && r <= g.r1;
  };
  for (let i = -n; i <= n; i++) {
    const a = (box.hl * i) / n;
    for (let j = -m; j <= m; j++) {
      if (Math.abs(i) !== n && Math.abs(j) !== m) continue;
      const b = (box.hw * j) / m;
      if (hit(box.x + fx * a + fz * b, box.z + fz * a - fx * b)) return true;
    }
  }
  return false;
}
/** 这个位姿的车身在不在进场通道 G 里 */
function inGate(p: YardPlan, d: VehicleDims, pose: RigPose): boolean {
  const g = gateZone(p);
  const nb = footprintInto(d, pose, BOXES);
  for (let i = 0; i < nb; i++) {
    const box = BOXES[i] as OBB;
    boxRange(box);
    if (boxInGate(g, box, R[0] as number, R[1] as number, R[2] as number, R[3] as number)) return true;
  }
  return false;
}

const SECTION = Array.from({ length: 64 }, (_, i) => `S${i}`);
/** 一个位姿占用的场地资源：区段 S0…、−x 头掉头处 TW、顶部车道 TOP、甩挂区 ST、待命车道当通道时 Q、进场道路的进场车道 G */
function resources(p: YardPlan, d: VehicleDims, pose: RigPose, out: Set<string>): void {
  const band = Number.isFinite(p.zQueue) ? p.zQueue - 1.5 : p.z1;
  const g = gateZone(p);
  const top = Number.isFinite(p.zTop) ? p.zTop : Number.isFinite(p.zQueue) ? p.zQueue : p.zCourt;
  const n = p.sections.length;
  const nb = footprintInto(d, pose, BOXES);
  for (let b = 0; b < nb; b++) {
    const box = BOXES[b] as OBB;
    boxRange(box);
    const x0 = R[0] as number;
    const x1 = R[1] as number;
    const z0 = R[2] as number;
    const z1 = R[3] as number;
    if (boxInGate(g, box, x0, x1, z0, z1)) out.add('G');
    if (z0 < band && z1 > -0.5) {
      let hit = false;
      for (let i = 0; i < n; i++) {
        const s = p.sections[i] as { x0: number; x1: number };
        if (x1 > s.x0 && x0 < s.x1) {
          out.add(SECTION[i] ?? `S${i}`);
          hit = true;
        }
      }
      if (!hit) out.add(x1 <= (p.sections[0] as { x0: number }).x0 ? 'S0' : (SECTION[n - 1] ?? `S${n - 1}`));
    }
    if (x0 < p.xTurnDock + 1 && z1 > p.zCourt - 3 && z0 < top + 3) out.add('TW');
    if (Number.isFinite(p.zTop) && z1 > p.zTop - 2.5 && z0 < p.zTop + 2.5) out.add('TOP');
    if (Number.isFinite(p.zTop) && z1 > p.zTop + 4) out.add('ST');
    // 有甩挂车位时待命车道是通道，谁用谁占着
    if (p.stalls.length && Number.isFinite(p.zQueue) && z1 > p.zQueue - 1.6 && z0 < p.zQueue + 1.6) out.add('Q');
  }
}

/**
 * 一个位姿占用的场地资源（测试和场地搭建者核对用）
 * Yard resources (lanes, sections, doors) a pose occupies, for checks.
 */
export function courtResources(p: YardPlan, d: VehicleDims, pose: RigPose): string[] {
  const set = new Set<string>();
  resources(p, d, pose, set);
  return [...set];
}

/** 一段运动（相对时间 0…dur）占用的资源和时段 */
function spansOf(p: YardPlan, sample: (dt: number, out: RigPose) => VehicleDims | undefined, dur: number, t0 = 0, into: Spans = new Map()): Spans {
  const pose: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
  const open = new Map<string, number>();
  const last = new Map<string, number>();
  const set = new Set<string>();
  const close = (k: string) => {
    const a = open.get(k) as number;
    const list = into.get(k) ?? [];
    list.push([a, (last.get(k) as number) + 0.5]);
    into.set(k, list);
    open.delete(k);
  };
  for (let dt = 0; dt <= dur + 1e-6; dt += 0.5) {
    set.clear();
    const d = sample(Math.min(dur, dt), pose);
    if (d) resources(p, d, pose, set);
    for (const k of set) {
      if (!open.has(k)) open.set(k, t0 + dt);
      last.set(k, t0 + dt);
    }
    // open 包含 set：一样多就没有要关的（Map 边遍历边删是安全的，顺序和先拷一份一样）
    if (open.size !== set.size) for (const k of open.keys()) if (!set.has(k)) close(k);
  }
  for (const k of [...open.keys()]) close(k);
  return into;
}

/**
 * 一个资源（区段、门、进场通道……）被占用的时段。list 按加进来的顺序（按顺序找第一个的地方用它）；
 * 另有一份按开始时刻排好的同一批时段和前缀最大的结束时刻：查「有没有和 [x0, x1] 冲突的」用二分，车多的时候不用一个个比。
 * 判断和逐个比完全一样：开始时刻 < x1 的是排好的前缀；d + PAD 随 d 单调（浮点加法也单调），前缀里有一个 x0 < d + PAD 就等于 x0 < 最大的 d + PAD。
 */
class Busy {
  readonly list: Array<[number, number]> = [];
  private readonly sorted: Array<[number, number]> = [];
  private readonly pmax: number[] = [];
  /** 出现过 NaN 就退回逐个比 */
  private nan = false;

  add(c: number, d: number): void {
    const iv: [number, number] = [c, d];
    this.list.push(iv);
    if (Number.isNaN(c) || Number.isNaN(d)) this.nan = true;
    const S = this.sorted;
    let lo = 0;
    let hi = S.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((S[mid] as [number, number])[0] <= c) lo = mid + 1;
      else hi = mid;
    }
    S.splice(lo, 0, iv);
    this.pmax.splice(lo, 0, 0);
    this.fix(lo);
  }

  /** 去掉按加进来的顺序第一个两端都差不到 1e-9 的时段（和原来的 findIndex + splice 一样） */
  removeNear(c: number, d: number): void {
    const i = this.list.findIndex(([x, y]) => Math.abs(x - c) < 1e-9 && Math.abs(y - d) < 1e-9);
    if (i < 0) return;
    const iv = this.list[i] as [number, number];
    this.list.splice(i, 1);
    const S = this.sorted;
    let k = -1;
    if (this.nan) k = S.indexOf(iv);
    else {
      let lo = 0;
      let hi = S.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((S[mid] as [number, number])[0] < iv[0]) lo = mid + 1;
        else hi = mid;
      }
      for (let j = lo; j < S.length && (S[j] as [number, number])[0] === iv[0]; j++)
        if (S[j] === iv) {
          k = j;
          break;
        }
      if (k < 0) k = S.indexOf(iv);
    }
    S.splice(k, 1);
    this.pmax.splice(k, 1);
    this.fix(k);
  }

  private fix(from: number): void {
    const S = this.sorted;
    const P = this.pmax;
    let m = from > 0 ? (P[from - 1] as number) : -Infinity;
    for (let i = from; i < S.length; i++) {
      m = Math.max(m, (S[i] as [number, number])[1]);
      P[i] = m;
    }
  }

  /** 开始时刻 < x1 的前缀有多长 */
  private prefix(x1: number): number {
    const S = this.sorted;
    let lo = 0;
    let hi = S.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((S[mid] as [number, number])[0] < x1) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 有没有时段 [c, d] 满足 x0 < d + PAD 且 c < x1 */
  hits(x0: number, x1: number): boolean {
    if (this.nan) {
      for (const [c, d] of this.list) if (x0 < d + PAD && c < x1) return true;
      return false;
    }
    const n = this.prefix(x1);
    return n > 0 && x0 < (this.pmax[n - 1] as number) + PAD;
  }

  /** 满足 x0 < d + PAD 且 c < x1 的时段里最大的 d + PAD + 0.5（没有就是 −∞） */
  clearAfter(x0: number, x1: number): number {
    let t = -Infinity;
    if (this.nan) {
      for (const [c, d] of this.list) if (x0 < d + PAD && c < x1) t = Math.max(t, d + PAD + 0.5);
      return t;
    }
    const n = this.prefix(x1);
    if (n > 0) {
      const d = this.pmax[n - 1] as number;
      if (x0 < d + PAD) t = Math.max(t, d + PAD + 0.5);
    }
    return t;
  }
}
type Table = Map<string, Busy>;

function conflicts(table: Table, rel: Spans, T: number): boolean {
  for (const [k, list] of rel) {
    const busy = table.get(k);
    if (!busy) continue;
    for (const [a, b] of list) if (busy.hits(T + a, T + b + PAD)) return true;
  }
  return false;
}
function reserve(table: Table, rel: Spans, T: number): void {
  for (const [k, list] of rel) {
    let busy = table.get(k);
    if (!busy) table.set(k, (busy = new Busy()));
    for (const [a, b] of list) busy.add(T + a, T + b);
  }
}
function unreserve(table: Table, rel: Spans, T: number): void {
  for (const [k, list] of rel) {
    const busy = table.get(k);
    if (!busy) continue;
    for (const [a, b] of list) busy.removeNear(T + a, T + b);
  }
}
const single = (k: string, a: number, b: number): Spans => new Map([[k, [[a, b] as [number, number]]]]);
/** 排在前面的车 u 在时刻 t 开到了车道上的哪里（排队时按排队运动，进场以后按进场的路线；车道的前一段每辆车都一样） */
function leadS(u: Live, t: number, st: PathState): number {
  if (t < u.E || !u.enter) return (u.q as QueueMotion).at(t).s;
  u.enter.at(Math.min(t - u.E, u.enter.duration), st);
  return u.sEnter + (st.dist ?? 0);
}
/** 跟车：车头离前车车尾至少留 1.5 米 */
function followLimit(L: Live): ((t: number) => number) | undefined {
  const u = L.lead;
  if (!u) return undefined;
  const st: PathState = { x: 0, z: 0, heading: 0 };
  const gap = backOf(u.d) + frontOf(L.d) + 1.5;
  return (t: number) => leadS(u, t, st) - gap;
}
/** 一段运动在进场通道 G 里的时段，换成 GQ、GE（和在进场通道里排队、从进场点进场的车比） */
function asQueued(rel: Spans, T: number): Spans {
  const g = rel.get('G');
  if (!g) return new Map();
  const abs = g.map(([a, b]) => [T + a, T + b] as [number, number]);
  return new Map([
    ['GQ', abs],
    ['GE', abs],
  ]);
}

/** 一段 Leg 序列（中间带挂上 / 摘下的等待）占用的资源；挂上 / 摘下的时候车停在原地，也占着那里 */
function legsSpans(p: YardPlan, legs: readonly Leg[], waits: readonly number[]): { rel: Spans; starts: number[]; dur: number } {
  const rel: Spans = new Map();
  const starts: number[] = [];
  const still = (leg: Leg, at: number, t0: number, dur: number) => {
    const st: PathState = { x: 0, z: 0, heading: 0 };
    spansOf(
      p,
      (_dt, out) => {
        legPose(leg, at, out, st);
        return leg.dims;
      },
      dur,
      t0,
      rel,
    );
  };
  let t = 0;
  legs.forEach((leg, i) => {
    const w = waits[i] ?? 0;
    if (w > 0) {
      const prev = legs[i - 1];
      if (prev) still(prev, prev.path.duration, t, w);
      else still(leg, 0, t, w);
    }
    t += w;
    starts.push(t);
    const st: PathState = { x: 0, z: 0, heading: 0 };
    spansOf(
      p,
      (dt, out) => {
        legPose(leg, dt, out, st);
        return leg.dims;
      },
      leg.path.duration,
      t,
      rel,
    );
    t += leg.path.duration;
  });
  const wEnd = waits[legs.length] ?? 0;
  const last = legs[legs.length - 1];
  if (wEnd > 0 && last) still(last, last.path.duration, t, wEnd);
  t += wEnd;
  return { rel, starts, dur: t };
}

interface Live {
  kind: 'live';
  v: YardVisit;
  r: YardRoute;
  d: VehicleDims;
  prep: number;
  /** 停在倒车起点的秒数、实际用的靠台准备秒数、开始进场的车道位置（从靠台车道起点进来的不经进场点） */
  wait: number;
  prepUsed?: number;
  entryS?: number;
  sHead: number;
  enter0: PathTiming;
  entryRel: Spans;
  /** 窗口紧时：倒车起点只停 10 秒 */
  shortRel: Spans;
  exitRel: Spans;
  exitStart: number;
  join: number;
  E: number;
  q?: QueueMotion;
  enter?: PathTiming;
  sEnter: number;
  /** 靠稳太晚、拉出重新排到了更晚（避开别的车） */
  pushed?: boolean;
  /** 排在它前面的车（跟车用） */
  lead?: Live;
  tl: YardTimeline;
}
/** 排程里留着的一段甩挂动作：时间部分和按距离的位姿（Leg 的点列和完整的 TimedPath 排完就不要了） */
interface SlimLeg {
  kind: Leg['kind'];
  dims: VehicleDims;
  path: PathTiming;
  rig: Leg['rig'];
}
/** 和 legPose 一样：按时间取距离，再按距离取位姿 */
function slimPose(leg: SlimLeg, tau: number, out: RigPose, st: PathState): void {
  leg.path.at(tau, st);
  leg.rig.poseAt(st.dist ?? 0, out);
  out.speed = st.speed ?? 0;
}
interface Shunt {
  legs: SlimLeg[];
  waits: number[];
  starts: number[];
  t0: number;
  dur: number;
  roles: Array<'truck' | 'shunter' | 'bobtail'>;
}
interface Trailer {
  kind: 'trailer';
  v: YardVisit;
  d: VehicleDims;
  stall: number;
  drop?: Shunt;
  toDoor?: Shunt;
  toStall?: Shunt;
  pickup?: Shunt;
  tl: YardTimeline;
}
type Item = Live | Trailer;

const INTERNAL = new WeakMap<YardTimeline, { plan: YardPlan; item: Item }>();

function makeTimeline(v: YardVisit): YardTimeline {
  return { visit: v, segs: [], joinAt: v.arrive, enterAt: v.arrive, backAt: v.arrive, dockedAt: v.dockAt, unloadAt: v.dockAt, outAt: v.leaveAt, goneAt: v.leaveAt, tight: false, lateDock: 0, lateExit: 0, notes: [] };
}

const MEMO = new WeakMap<YardPlan, Map<string, YardSchedule>>();
const RELS = new WeakMap<YardPlan, Map<string, { r: YardRoute; sHead: number; enter0: PathTiming; entryRel: Spans; shortRel: Spans; exitRel: Spans }>>();

/**
 * 排程（同一个场地、同样的访问只排一次；结果不要改）
 * Schedule all visits of a yard: FCFS staging, one manoeuvre per wall section, exits first, one vehicle per door, drop-and-hook shunts (cached; read-only result).
 */
export function scheduleYard(plan: YardPlan, visits: readonly YardVisit[]): YardSchedule {
  let m = MEMO.get(plan);
  if (!m) MEMO.set(plan, (m = new Map()));
  const key = JSON.stringify(visits);
  const hit = m.get(key);
  if (hit) return hit;
  const s = scheduleNow(plan, visits);
  if (m.size > 8) m.clear();
  m.set(key, s);
  return s;
}

function scheduleNow(plan: YardPlan, visits: readonly YardVisit[]): YardSchedule {
  const notes: string[] = [];
  const table: Table = new Map();
  const routeCache = new Map<string, YardRoute>();
  const routeOf = (door: number, vehicle: YardVehicle) => {
    const key = `${door}|${vehicle}`;
    let r = routeCache.get(key);
    if (!r) {
      r = yardRoute(plan, door, vehicle);
      routeCache.set(key, r);
    }
    return r;
  };
  // 从车道上某处驶完车道（laneDrive）：同一条路线、同一个起点和初速度结果一样，这次排程里只算一次（大多数车都是停在排头起步）；
  // 排进场时只要用时的「开到排头」也一样。只在这次排程里共用，排完只留下时间线引用的。
  // 只留时间部分（PathTiming）：位置按距离在车道上取
  const drives = new Map<YardRoute, Map<number, Map<number, PathTiming>>>();
  const driveOf = (r: YardRoute, s0: number, v0: number, made?: PathTiming): PathTiming => {
    if (Object.is(s0, -0) || Object.is(v0, -0)) return made ?? timingOf(laneDrive(r, s0, v0));
    let m = drives.get(r);
    if (!m) drives.set(r, (m = new Map()));
    let m2 = m.get(s0);
    if (!m2) m.set(s0, (m2 = new Map()));
    let e = m2.get(v0);
    if (!e) m2.set(v0, (e = made ?? timingOf(laneDrive(r, s0, v0))));
    return e;
  };
  const heads = new Map<YardRoute, Map<string, number>>();
  const toHeadOf = (r: YardRoute, s0: number, s1: number): number => {
    let m = heads.get(r);
    if (!m) heads.set(r, (m = new Map()));
    const k = `${s0}|${s1}`;
    let d = m.get(k);
    if (d === undefined) m.set(k, (d = new TimedPath(r.lane.slice(s0, s1), 3.6, false, { accel: 0.6, decel: 0.9, lat: 1.1, v0: 0, v1: 0 }).duration));
    return d;
  };
  /** 自己靠台装卸的车（同一个门、同一种车的路线和占用的场地资源都一样：按场地缓存，长墙、大量的车也快） */
  const makeLive = (v: YardVisit): Live => {
    let rels = RELS.get(plan);
    if (!rels) RELS.set(plan, (rels = new Map()));
    const rk = `${v.door}|${v.vehicle}|${v.via ?? ''}`;
    let R0 = rels.get(rk);
    if (!R0) {
      const r = routeOf(v.door, v.vehicle);
      const d0 = r.dims;
      const sHead = v.via === 'court' ? Math.max(0, r.lane.nearest({ x: plan.xTurnDock, z: plan.zCourt }) - (d0.kind === 'rig' ? d0.front : d0.length - d0.rearOverhang)) : r.slotS(0);
      const enter0 = timingOf(laneDrive(r, sHead, 0));
      const st: PathState = { x: 0, z: 0, heading: 0 };
      const relFor = (w: number) =>
        spansOf(
          plan,
          (dt, out) => {
            if (dt <= enter0.duration + w) {
              enter0.at(Math.min(dt, enter0.duration), st);
              lanePose(r, sHead + (st.dist ?? 0), out);
            } else {
              r.back.path.at(dt - enter0.duration - w, st);
              r.back.rig.poseAt(st.dist ?? 0, out);
            }
            return d0;
          },
          enter0.duration + w + r.back.path.duration,
        );
      const w0 = d0.kind === 'rig' ? SWING_WAIT.rig : SWING_WAIT.body;
      const exitRel = spansOf(
        plan,
        (dt, out) => {
          r.exit.path.at(dt, st);
          r.exit.rig.poseAt(st.dist ?? 0, out);
          return d0;
        },
        Math.min(r.exit.path.duration, r.exit.tGate + 2),
      );
      R0 = { r, sHead, enter0, entryRel: relFor(w0), shortRel: relFor(Math.min(w0, 10)), exitRel };
      rels.set(rk, R0);
    }
    const { r, sHead, enter0, entryRel, shortRel, exitRel } = R0;
    driveOf(r, sHead, 0, enter0);
    const d = r.dims;
    const wait = d.kind === 'rig' ? SWING_WAIT.rig : SWING_WAIT.body;
    return { kind: 'live', v, r, d, prep: prepOf(d), wait, sHead, enter0, entryRel, shortRel, exitRel, exitStart: v.leaveAt, join: v.arrive, E: v.arrive, sEnter: sHead, tl: makeTimeline(v), ...(v.via === 'court' ? { entryS: sHead } : {}) };
  };
  const lives: Live[] = [];
  const trailers: Trailer[] = [];
  for (const v of visits) {
    const mode = v.mode ?? 'live';
    if (mode !== 'live' && (plan.level !== 'full' || !plan.stalls.length)) notes.push(`${v.id}：场地没有甩挂车位，按自己靠台装卸排`);
    if (mode === 'live' || plan.level !== 'full' || !plan.stalls.length) lives.push(makeLive(v));
    else trailers.push({ kind: 'trailer', v, d: dimsOf(v.vehicle), stall: -1, tl: makeTimeline(v) });
  }

  // 甩挂的路线和它占用的资源：同一个车位、同一个门（同一种车）每个挂车都一样，这次排程里只算一次、大家共用（Shunt 自己的 t0 各是各的）
  const shuntCache = new Map<string, { legs: SlimLeg[]; starts: number[]; dur: number; rel: Spans }>();
  const shunt = (key: string, make: () => ShuntRoute, roles: Shunt['roles'], waits: number[]): { s: Shunt; rel: Spans } => {
    let c = shuntCache.get(key);
    if (!c) {
      const route = make();
      const ls = legsSpans(plan, route.legs, waits);
      const legs = route.legs.map((l): SlimLeg => ({ kind: l.kind, dims: l.dims, path: timingOf(l.path), rig: l.rig }));
      shuntCache.set(key, (c = { legs, starts: ls.starts, dur: ls.dur, rel: ls.rel }));
    }
    return { s: { legs: c.legs, waits, starts: c.starts, t0: 0, dur: c.dur, roles }, rel: c.rel };
  };
  /** 在 [lo, hi] 里找最晚（late = true）或最早的不冲突时刻；找不到就从 hi 往后找（最多找到 cap） */
  const place = (rel: Spans, lo: number, hi: number, late: boolean, extra?: (T: number) => Spans | undefined, cap = Infinity): { T: number; ok: boolean } => {
    const free = (T: number) => !conflicts(table, rel, T) && !(extra && conflicts(table, extra(T) ?? new Map(), 0));
    if (hi >= lo) {
      if (late) {
        for (let T = hi; T >= lo - 1e-6; T -= STEP) if (free(T)) return { T, ok: true };
      } else for (let T = lo; T <= hi + 1e-6; T += STEP) if (free(T)) return { T, ok: true };
    }
    for (let T = Math.max(lo, hi); T < Math.min(cap, Math.max(lo, hi) + 4 * 3600); T += STEP) if (free(T)) return { T, ok: false };
    return { T: Math.max(lo, hi), ok: false };
  };
  const placeExit = (L: Live) => {
    const at = place(L.exitRel, L.v.leaveAt, L.v.leaveAt, false);
    L.exitStart = at.T;
    reserve(table, L.exitRel, at.T);
    L.tl.lateExit = Math.max(0, at.T - L.v.leaveAt);
  };

  // 1. 驶离优先：自己靠台的车按 leaveAt 先排拉出驶离，占用它经过的区段
  for (const L of [...lives].sort((a, b) => a.v.leaveAt - b.v.leaveAt)) placeExit(L);

  // 2. 甩挂：先是一早就在车位里的挂车，再按到达，一个一个给挂车找车位、排它的动作：甩下（arrive 起最早，车位空出来以后）、
  //    场内牵引车车位 → 门（dockAt 前最晚）、门 → 车位（leaveAt 起最早；靠稳太晚就往后挪，门一直占到那时）、空车来挂走。
  //    车位按实际时刻占用：从甩下到被挂走（没有取挂时刻就一直占着），同一个车位不会有两个挂车；车位都占着、甩下的挂车赶不上靠台时，
  //    这辆车改成自己靠台装卸（写进 notes），不和别的挂车挤一个车位。
  const stallUse: Array<Array<[number, number]>> = plan.stalls.map(() => []);
  const freeFrom = (k: number) => Math.max(-Infinity, ...(stallUse[k] as Array<[number, number]>).map(([, b]) => b));
  const toLive = (tr: Trailer, why: string) => {
    trailers.splice(trailers.indexOf(tr), 1);
    const L = makeLive(tr.v);
    L.tl.notes.push(why);
    notes.push(`${tr.v.id}：${why}`);
    placeExit(L);
    lives.push(L);
  };
  const seq = [...trailers].sort((a, b) => (a.v.mode === 'hook' ? 0 : 1) - (b.v.mode === 'hook' ? 0 : 1) || a.v.arrive - b.v.arrive);
  for (const tr of seq) {
    const hook = tr.v.mode === 'hook';
    const want = tr.v.stall;
    const cands = [...(want !== undefined && want >= 0 && want < plan.stalls.length ? [want] : []), ...plan.stalls.map((_, i) => i).filter((i) => i !== want)];
    // 一早就在车位里的挂车：要一个空车位；甩下的挂车：到达时已经空着的车位，没有就挑最早空出来的
    let k = hook ? (cands.find((i) => !(stallUse[i] as Array<[number, number]>).length) ?? -1) : (cands.find((i) => freeFrom(i) + 5 <= tr.v.arrive) ?? -1);
    if (!hook && k < 0) {
      let best = Infinity;
      for (const i of cands) if (freeFrom(i) < best) best = freeFrom((k = i));
    }
    if (k < 0 || (!hook && freeFrom(k) === Infinity)) {
      toLive(tr, '甩挂车位都占着，改成自己靠台装卸');
      continue;
    }
    tr.stall = k;
    const prep = prepOf(tr.d);
    const { s, rel } = shunt(`toDoor|${k}|${tr.v.door}`, () => shunterRoute(plan, k, tr.v.door, 'toDoor'), ['shunter', 'shunter'], [45, 0, 45]);
    if (!hook) {
      const { s: sd, rel: drel } = shunt(`drop|${k}|${tr.v.vehicle}`, () => stallRoute(plan, k, tr.v.vehicle, 'drop'), ['truck', 'truck', 'bobtail'], [0, 0, 60, 0]);
      const lo = Math.max(tr.v.arrive, freeFrom(k) + 5);
      const at = place(drel, lo, lo + 4 * 3600, false);
      if (at.T + sd.dur + 30 + s.dur > tr.v.dockAt) {
        toLive(tr, '甩挂车位空出来时已经赶不上靠台，改成自己靠台装卸');
        continue;
      }
      sd.t0 = at.T;
      reserve(table, drel, at.T);
      tr.drop = sd;
      tr.tl.joinAt = at.T;
      if (at.T > tr.v.arrive + 1) tr.tl.notes.push(`等了 ${Math.round(at.T - tr.v.arrive)} 秒才进场甩挂`);
    }
    // 门 → 车位：leaveAt 起最早；挂车靠稳太晚时，按靠稳后至少一分钟往后排（门一直占到那时）
    const { s: so, rel: orel } = shunt(`toStall|${k}|${tr.v.door}`, () => shunterRoute(plan, k, tr.v.door, 'toStall'), ['shunter', 'shunter'], [45, 0, 45]);
    const outMemo = new Map<number, number>();
    const outFor = (dockedAt: number): number => {
      const need = Math.max(tr.v.leaveAt, dockedAt + 60);
      let e = outMemo.get(need);
      if (e === undefined) outMemo.set(need, (e = place(orel, need, need, false).T));
      return e;
    };
    const ready = tr.drop ? tr.drop.t0 + tr.drop.dur + 30 : -Infinity;
    const doorSpan = (T: number) => single(`D:${tr.v.door}`, T + (s.starts[1] ?? 0), outFor(T + s.dur - 45) + 60);
    const latest = tr.v.dockAt - prep * 0.5 - s.dur;
    const at = place(rel, Math.max(ready, latest - 3 * 3600), latest, true, doorSpan);
    s.t0 = at.T;
    reserve(table, rel, at.T);
    tr.toDoor = s;
    tr.tl.enterAt = at.T;
    tr.tl.dockedAt = at.T + s.dur - 45;
    if (!at.ok) {
      tr.tl.tight = true;
      tr.tl.lateDock = Math.max(0, tr.tl.dockedAt + prep * 0.5 - tr.v.dockAt);
    }
    so.t0 = outFor(tr.tl.dockedAt);
    reserve(table, orel, so.t0);
    reserve(table, single(`D:${tr.v.door}`, at.T + (s.starts[1] ?? 0), so.t0 + 60), 0);
    tr.toStall = so;
    tr.tl.lateExit = Math.max(0, so.t0 - tr.v.leaveAt);
    if (so.t0 > Math.max(tr.v.leaveAt, tr.tl.dockedAt + 60) + 1) tr.tl.notes.push(`等场地空出来，拖回车位晚了 ${Math.round(so.t0 - tr.v.leaveAt)} 秒`);
    const pick = hook ? tr.v.arrive : tr.v.pickupAt;
    let until = Infinity;
    if (pick !== undefined) {
      const { s: ps, rel: prel } = shunt(`hook|${k}|${tr.v.vehicle}`, () => stallRoute(plan, k, tr.v.vehicle, 'hook'), ['bobtail', 'bobtail', 'truck'], [0, 0, 90, 0]);
      const lo = Math.max(pick, so.t0 + so.dur + 30);
      const pat = place(prel, lo, lo + 4 * 3600, false);
      ps.t0 = pat.T;
      reserve(table, prel, pat.T);
      tr.pickup = ps;
      until = pat.T + ps.dur;
    }
    (stallUse[k] as Array<[number, number]>).push([tr.drop ? tr.drop.t0 : -Infinity, until]);
  }

  // 3. 进场：先到先进（待命车道单列）；最晚该进场的时刻比到达晚 HOLD_WINDOW 以上的车（门一时空不出来）先在场外等，按那个时刻排进来
  const T0 = (L: Live) => L.v.dockAt - L.prep - L.wait - L.r.back.path.duration - L.enter0.duration;
  const key = (L: Live) => Math.max(L.v.arrive, T0(L) - HOLD_WINDOW);
  const order = [...lives].sort((a, b) => key(a) - key(b) || a.v.arrive - b.v.arrive);
  // 往回推每辆车最晚的进场时刻：后面的车要进场，前面的车得先进去
  const deadline = new Map<Live, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const L = order[i] as Live;
    const next = order[i + 1];
    deadline.set(L, Math.min(T0(L), next ? (deadline.get(next) as number) - 10 : Infinity));
  }
  // 车道上排得下几辆：进场点以内的车位（车头开到进场点时已经有位置）；再多的在场外等（hold），到达的车头总在进场点，和道路段接得上
  const capacityOf = (L: Live) => {
    if (L.entryS !== undefined) return 1;
    let n = 0;
    while (n < 40 && L.r.slotS(n) >= L.r.sGate - 0.01) n++;
    return Math.max(1, n);
  };
  const done: Live[] = [];
  const moveUp = new TimedPath([{ x: 0, z: 0 }, { x: plan.queue.pitch, z: 0 }], 3.6, false, { accel: 0.6, decel: 0.9 }).duration;
  const gPose: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
  const gAt = (L: Live, s: number) => {
    lanePose(L.r, s, gPose);
    return inGate(plan, L.d, gPose);
  };
  /** 和 [a, b] 冲突的进场车道占用里最晚的结束时刻（后面的车从那以后才放进来） */
  const gClear = (a: number, b: number) => table.get('G')?.clearAfter(a, b + PAD) ?? -Infinity;
  for (const L of order) {
    // 进待命车道：排在前面（进场顺序更早）、还没进场的车都已经进了车道；车道排满了就在场外等
    let c = L.v.arrive;
    for (let guard = 0; guard < 200; guard++) {
      let moved = false;
      for (const u of done)
        if (u.E > c && u.join > c) {
          c = u.join + 1;
          moved = true;
        }
      const inLane = done.filter((u) => u.join <= c && u.E > c);
      if (inLane.length >= capacityOf(L)) {
        c = Math.min(...inLane.map((u) => u.E)) + 1;
        moved = true;
      }
      if (!moved) break;
    }
    // 进场通道（进场道路的进场车道和拐进场里的第一个转弯，资源 G）：
    // - 排队的车之间跟车：前面的车车尾过了进场点 2 米才放这辆车进来，在车道上跟着前车走（QueueMotion 的 limit）；
    // - 和别的车流互斥：甩挂进场的车、场内牵引车、紧凑布置里横穿进场转弯驶离的车占着 G 的时候，
    //   这辆车不能在通道里（从进场点开到车位、在通道里停着排队都算），在场外等候区多等一会儿（hold）；
    // - 从进场点直接进场的车（没有待命车道的场地）进场的那一段记成 GE：和别的车进场错开，后面排队的车按跟车放进来。
    // 只会把 c 往后挪，先进先出和车道容量不受影响。
    const wait0 = L.wait;
    // 从进场点进场的车（没有待命车道的场地）进场时也在进场通道里：记成 GE，和别的车进场错开，排队的车按跟车
    const eGs = L.entryRel.get('G') ?? [];
    const eG = Math.max(0, ...eGs.map(([, b]) => b));
    // 自己的拉出先从占用表里拿出来：靠稳太晚时要按靠稳后至少一分钟重新排（门也要一直空到那时），进场排好以后再放回去
    unreserve(table, L.exitRel, L.exitStart);
    // 和 place(exitRel, need, need, false) 一样从 need 起每 STEP 秒找第一个空着的时刻；每个时刻查过一次就记下来（排这辆车的时候占用表不变）
    const exitFree = new Map<number, boolean>();
    const exitOk = (T: number) => {
      const key = Math.round(T * 64);
      let f = exitFree.get(key);
      if (f === undefined) exitFree.set(key, (f = !conflicts(table, L.exitRel, T) && !conflicts(table, asQueued(L.exitRel, T), 0)));
      return f;
    };
    const exitFor = (dockedAt: number): number => {
      const need = dockedAt + 60;
      if (need <= L.exitStart) return L.exitStart;
      for (let T = need; T < need + 4 * 3600; T += STEP) if (exitOk(T)) return T;
      return need;
    };
    let rel = L.entryRel;
    let at = { T: c, ok: false };
    let gSpan: [number, number] | undefined;
    let stillG = false;
    let lastQ = new QueueMotion(c, c, [{ t: c, s: L.sHead }], L.sHead);
    for (let attempt = 0; attempt < 120; attempt++) {
      L.join = c;
      L.wait = wait0;
      L.prepUsed = L.prep;
      rel = L.entryRel;
      const ahead = done.filter((u) => u.join <= c && u.E > c).sort((a, b) => a.E - b.E);
      // 跟车：前面的车（还在排队的、刚从进场点进场的），车尾要过了进场点 2 米这辆车才放进来（车头在进场点）
      let gap = c;
      for (const u of done) {
        if (u.join > c || u.E < c - 600) continue;
        const need = L.r.sGate + frontOf(L.d) + 2 + backOf(u.d);
        let t = c;
        while (t < u.E + 600 && leadS(u, t, tmpSt) < need) {
          // 每 0.5 秒看一次；前车停着不动的那一段结果都一样，直接跳过去（落在同样的 0.5 秒格子上）
          const still = t < u.E ? Math.min((u.q as QueueMotion).stillUntil(t), u.E) : t;
          t += (Math.floor((still - t) / 0.5) + 1) * 0.5;
        }
        gap = Math.max(gap, t);
      }
      if (gap > c + 1e-6) {
        c = gap;
        continue;
      }
      const sStart = L.entryS ?? Math.min(L.r.sGate, L.r.slotS(ahead.length));
      const targets = [{ t: c, s: L.entryS ?? L.r.slotS(ahead.length) }];
      ahead.forEach((u, k) => targets.push({ t: u.E + 2, s: L.r.slotS(ahead.length - k - 1) }));
      L.lead = done[done.length - 1];
      const q = new QueueMotion(c, c + 48 * 3600, targets, sStart, 3.6, 0.6, 0.9, 0, followLimit(L));
      lastQ = q;
      // 排到最前面停稳的时刻（之后在那里等到进场）
      const sF = q.end().s;
      let settle = Math.max(c, (targets[targets.length - 1] as { t: number }).t);
      for (let k = 0; k < 40000; k++) {
        const m = q.at(settle);
        if (m.v < 0.01 && Math.abs(m.s - sF) < 0.01) break;
        settle += 0.25;
      }
      // 在进场车道上的时段：从放进来到车尾开出这一段（车只往前走，出去了就不会再回来）；停稳的位置还在这一段里就一直占到进场
      let gEnd = -Infinity;
      for (let t = c; t <= settle + 1e-6; ) {
        const inside = gAt(L, q.at(t).s);
        if (!inside && gEnd > -Infinity) break;
        // 每 0.5 秒看一次；停着不动的那一段在不在通道里都一样，直接跳过去（落在同样的 0.5 秒格子上）
        const skip = Math.floor((Math.min(q.stillUntil(t), settle + 1e-6) - t) / 0.5);
        const k = Math.max(0, skip);
        if (inside) gEnd = t + k * 0.5 + 0.5;
        t += (k + 1) * 0.5;
      }
      stillG = gEnd > -Infinity && gAt(L, sF);
      gSpan = gEnd > -Infinity ? [c, stillG ? settle : gEnd] : undefined;
      if (gSpan && conflicts(table, single('G', gSpan[0], gSpan[1]), 0)) {
        c = Math.max(c + 1, gClear(gSpan[0], gSpan[1]));
        continue;
      }
      // 停在进场车道上等的车：下一个要用这一段的（甩挂进场的车、场内牵引车）来以前就得进场，不然就再晚一点放进来
      let gCap = Infinity;
      let gNext = Infinity;
      if (stillG)
        for (const [a, b] of table.get('G')?.list ?? [])
          if (b + PAD > settle && a - PAD - eG - 0.01 < gCap) {
            gCap = a - PAD - eG - 0.01;
            gNext = b + PAD + 0.5;
          }
      const toHead = sStart < L.sHead ? toHeadOf(L.r, sStart, L.sHead) : 0;
      const prev = done[done.length - 1];
      let lo = Math.max(L.v.arrive, c + toHead, settle, prev ? prev.E + 10 : -Infinity);
      if (ahead.length) lo = Math.max(lo, (ahead[ahead.length - 1] as Live).E + 2 + moveUp);
      // 同一个门上一辆车拉出去以后才能倒进去
      const tE = L.enter0.duration + L.wait;
      for (const u of lives) if (u !== L && u.v.door === L.v.door && u.v.leaveAt <= L.v.dockAt) lo = Math.max(lo, u.exitStart + u.r.exit.tClear - tE);
      if (gCap < lo) {
        c = Math.max(c + 1, gNext);
        continue;
      }
      // 门从倒车开始一直占到拉出（靠稳太晚时拉出往后挪，门也占得更久）；停在进场车道上等的车一直占着进场车道
      const extraFor = (tEx: number) => (T: number) => {
        const m = single(`D:${L.v.door}`, T + tEx, exitFor(T + tEx + L.r.back.path.duration) + L.r.exit.tClear);
        if (stillG) m.set('G', [[settle, T]]);
        if (eGs.length) m.set('GE', eGs.map(([a, b]) => [T + a, T + b] as [number, number]));
        return m;
      };
      // 放在不冲突的最晚时刻（多出来的时间在待命车道上等，靠稳后多出来的时间在门口等）；放不下先压缩靠台准备（最少一半），再往后挪
      const dl = deadline.get(L) as number;
      // 仿真的靠台时刻是期望：放得下就不晚于它倒推的进场时刻、尽量晚（在车道上等）；早不了就尽早（靠台晚一点不算 tight）
      const work = L.d.kind === 'rig' ? MIN_WORK.rig : L.d.length > 8 ? MIN_WORK.truck : MIN_WORK.van;
      const eMax = (w: number, prep: number) => L.exitStart - work - prep - L.r.back.path.duration - w - L.enter0.duration;
      let extra = extraFor(tE);
      at = place(rel, lo, Math.min(gCap, Math.max(Math.min(dl, T0(L)), Math.min(lo, T0(L)))), true, extra, gCap);
      if (at.T > eMax(L.wait, L.prep)) {
        // 停留放不下完整的流程：倒车起点少停一会儿（10 秒），靠台准备压缩到一半，尽早进场
        L.wait = Math.min(L.wait, 10);
        L.prepUsed = L.prep * 0.5;
        rel = L.shortRel;
        extra = extraFor(L.enter0.duration + L.wait);
        at = place(rel, lo, Math.min(gCap, Math.max(lo, eMax(L.wait, L.prepUsed))), false, extra, gCap);
      }
      // 在进场车道上等着的车，下一个用进场车道的来以前排不进去：等那一个过去以后再放进来
      if (stillG && (at.T > gCap || conflicts(table, rel, at.T) || conflicts(table, extra(at.T), 0)) && Number.isFinite(gNext)) {
        c = Math.max(c + 1, gNext);
        continue;
      }
      break;
    }
    const E = at.T;
    L.E = E;
    // 靠稳太晚（来车多、场地忙）：拉出按靠稳后至少一分钟重新排过，避开别的车（标 tight）
    const ex = exitFor(E + L.enter0.duration + L.wait + L.r.back.path.duration);
    if (ex !== L.exitStart) {
      L.exitStart = ex;
      L.tl.lateExit = Math.max(0, ex - L.v.leaveAt);
      L.pushed = true;
    }
    reserve(table, L.exitRel, L.exitStart);
    reserve(table, new Map([...rel].map(([k, v]) => [k === 'G' ? 'GE' : k, v] as const)), E);
    // 在进场通道里排队的时段记成 GQ：之后才排的拉出（靠稳太晚、往后挪的）要避开它；排队的车之间按跟车，不互相排斥
    if (gSpan) reserve(table, single('GQ', gSpan[0], stillG ? E : gSpan[1]), 0);
    L.q = lastQ;
    const qe = lastQ.end();
    L.sEnter = qe.s;
    L.enter = driveOf(L.r, qe.s, qe.v);
    reserve(table, single(`D:${L.v.door}`, E + L.enter0.duration + L.wait, L.exitStart + L.r.exit.tClear), 0);
    done.push(L);
  }

  // 4. 每辆车的排队运动、时间线
  for (const L of lives) {
    const ahead = lives.filter((u) => u !== L && u.join <= L.join && u.E > L.join && (u.E < L.E || (u.E === L.E && lives.indexOf(u) < lives.indexOf(L)))).sort((a, b) => a.E - b.E);
    const sStart = L.entryS ?? Math.min(L.r.sGate, L.r.slotS(ahead.length));
    const targets = [{ t: L.join, s: L.entryS ?? L.r.slotS(ahead.length) }];
    ahead.forEach((u, k) => targets.push({ t: u.E + 2, s: L.r.slotS(ahead.length - k - 1) }));
    // 车停在进场点（道路段在那里停下）再起步
    L.q = new QueueMotion(L.join, L.E, targets, sStart, 3.6, 0.6, 0.9, 0, followLimit(L));
    const qe = L.q.end();
    L.sEnter = qe.s;
    L.enter = driveOf(L.r, qe.s, qe.v);
    const tl = L.tl;
    const tEnter = L.enter.duration;
    const tBack = L.r.back.path.duration;
    tl.joinAt = L.join;
    tl.enterAt = L.E;
    tl.backAt = L.E + tEnter + L.wait;
    tl.dockedAt = tl.backAt + tBack;
    const prepUsed = L.prepUsed ?? L.prep;
    const work = L.d.kind === 'rig' ? MIN_WORK.rig : L.d.length > 8 ? MIN_WORK.truck : MIN_WORK.van;
    // 靠稳以后至少待一分钟（仿真窗口太短时拉出往后挪；进场时已经重新排过的在这里只记下来）
    if (L.pushed) {
      tl.notes.push('靠稳太晚，拉出往后挪了');
      tl.tight = true;
    }
    if (L.exitStart < tl.dockedAt + 60) {
      tl.notes.push('靠稳太晚，拉出往后挪了');
      tl.lateExit = Math.max(tl.lateExit, tl.dockedAt + 60 - L.v.leaveAt);
      L.exitStart = tl.dockedAt + 60;
      tl.tight = true;
    }
    if (tl.lateExit > 0 && !tl.notes.some((n) => n.includes('拉出'))) tl.notes.push(`等场地空出来，拉出晚了 ${Math.round(tl.lateExit)} 秒`);
    // 开始装卸 = 靠稳并做完准备（仿真的靠台时刻更晚就等到那时）；停留放不下流程加最少的装卸才算 tight
    tl.unloadAt = Math.min(L.exitStart, Math.max(L.v.dockAt, tl.dockedAt + prepUsed));
    tl.lateDock = Math.max(0, Math.round(tl.unloadAt - L.v.dockAt));
    if (tl.dockedAt + prepUsed + work > L.exitStart + 1) {
      tl.tight = true;
      tl.notes.push(`停留太短：靠稳、准备完只剩 ${Math.max(0, Math.round(L.exitStart - tl.dockedAt - prepUsed))} 秒装卸`);
    }
    const segs: YardSeg[] = [];
    const push = (kind: YardSegKind, t0: number, t1: number, hazard = false) => {
      if (t1 > t0 + 1e-6) segs.push({ kind, t0, t1, ...(hazard ? { hazard } : {}) });
    };
    push('hold', L.v.arrive, L.join);
    const stopAt = firstStop(L.q, L.join, L.E);
    push('approach', L.join, stopAt);
    push('queue', stopAt, L.E);
    push('enter', L.E, L.E + tEnter);
    push('wait', L.E + tEnter, tl.backAt, true);
    push('back', tl.backAt, tl.dockedAt);
    const prepEnd = Math.min(tl.dockedAt + prepUsed, L.exitStart);
    push('prep', tl.dockedAt, prepEnd, true);
    push('docked', prepEnd, L.exitStart);
    push('pullout', L.exitStart, L.exitStart + L.r.exit.tClear);
    push('exit', L.exitStart + L.r.exit.tClear, L.exitStart + L.r.exit.path.duration);
    tl.segs = segs;
    tl.goneAt = L.exitStart + L.r.exit.path.duration;
    tl.outAt = L.exitStart + L.r.exit.tGate;
    if (L.join > L.v.arrive + 1) tl.notes.push(`在场外等了 ${Math.round(L.join - L.v.arrive)} 秒才进待命车道`);
    INTERNAL.set(tl, { plan, item: L });
  }
  const shunts: YardSchedule['shunts'] = [];
  for (const tr of trailers) {
    const tl = tr.tl;
    const segs: YardSeg[] = [];
    const push = (kind: YardSegKind, t0: number, t1: number, hazard = false) => {
      if (t1 > t0 + 1e-6) segs.push({ kind, t0, t1, ...(hazard ? { hazard } : {}) });
    };
    if (tr.drop) push('drop', tr.drop.t0, tr.drop.t0 + tr.drop.dur);
    if (tr.toDoor) {
      push('shunt', tr.toDoor.t0, tr.toDoor.t0 + tr.toDoor.dur);
      shunts.push({ trailer: tr.v.id, from: plan.stalls[tr.stall]?.id ?? '', to: plan.doors[tr.v.door]?.id ?? '', t0: tr.toDoor.t0, t1: tr.toDoor.t0 + tr.toDoor.dur });
    }
    const dockedFrom = tr.toDoor ? tr.toDoor.t0 + tr.toDoor.dur : tr.v.dockAt;
    tl.unloadAt = Math.max(tr.v.dockAt, dockedFrom);
    const dockedTo = tr.toStall ? tr.toStall.t0 : tr.v.leaveAt;
    push('docked', dockedFrom, dockedTo);
    if (tr.toStall) {
      push('shunt', tr.toStall.t0, tr.toStall.t0 + tr.toStall.dur);
      shunts.push({ trailer: tr.v.id, from: plan.doors[tr.v.door]?.id ?? '', to: plan.stalls[tr.stall]?.id ?? '', t0: tr.toStall.t0, t1: tr.toStall.t0 + tr.toStall.dur });
    }
    if (tr.pickup) push('hook', tr.pickup.t0, tr.pickup.t0 + tr.pickup.dur);
    tl.segs = segs;
    tl.goneAt = tr.pickup ? tr.pickup.t0 + tr.pickup.dur : Infinity;
    INTERNAL.set(tl, { plan, item: tr });
  }
  const timelines = visits.map((v) => [...lives, ...trailers].find((x) => x.v === v)?.tl as YardTimeline);
  const tight = timelines.filter((t) => t.tight).length;
  if (tight) notes.push(`${tight} 辆车的仿真时间窗太短（靠台准备压缩到下限或拉出往后挪）`);
  return { plan, timelines, shunts, notes };
}

/** 排队运动里第一次停下的时刻（到了自己的车位） */
function firstStop(q: QueueMotion, t0: number, t1: number): number {
  for (let t = t0 + 0.5; t <= t1; t += 0.5) if (q.at(t).v < 0.01) return t;
  return t1;
}

export interface PoseUnit {
  role: 'truck' | 'trailer' | 'shunter' | 'bobtail';
  dims: VehicleDims;
  pose: RigPose;
}
export interface PoseInfo {
  seg: YardSegKind;
  units: PoseUnit[];
  /** 双闪、刹车灯（停着或在减速） */
  hazard: boolean;
  brake: boolean;
}

const tmpSt: PathState = { x: 0, z: 0, heading: 0 };
const newPose = (): RigPose => ({ x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 });

/**
 * 时刻 t 一次访问在场里的样子（不在场里返回 undefined；hold 段给的是进场道路场外那一头的位置，场地可以换成自己的等候区）
 * Pose of a visit at time t (undefined when not in the yard), with trailer angle, reversing, hazard and brake flags.
 */
export function poseAt(tl: YardTimeline, t: number): PoseInfo | undefined {
  const it = INTERNAL.get(tl);
  if (!it) return undefined;
  const seg = tl.segs.find((s) => t >= s.t0 && t < s.t1) ?? (t >= (tl.segs[tl.segs.length - 1]?.t1 ?? Infinity) ? undefined : undefined);
  if (!seg) {
    // 甩挂的挂车在车位里（甩下以后、挂走以前）
    const item = it.item;
    if (item.kind === 'trailer') {
      const first = tl.segs[0]?.t0 ?? 0;
      const gone = tl.goneAt;
      const inStall = item.v.mode === 'hook' ? t < gone : t >= first && t < gone;
      if (!inStall) return undefined;
      const st = it.plan.stalls[item.stall];
      if (!st) return undefined;
      const L = item.d.kind === 'rig' ? item.d.axle : 0;
      const pose = { ...newPose(), x: st.x, z: st.z - L, heading: Math.PI, trailer: Math.PI };
      return { seg: 'pool', units: [{ role: 'trailer', dims: trailerOnly(item.d), pose }], hazard: false, brake: false };
    }
    return undefined;
  }
  const item = it.item;
  if (item.kind === 'live') {
    const out = newPose();
    const r = item.r;
    let brake = false;
    switch (seg.kind) {
      case 'hold':
        // 在进场点外等（车头在进场点）；场地有等候区的可以自己画到等候区
        lanePose(r, r.sGate, out);
        brake = true;
        break;
      case 'approach':
      case 'queue': {
        const m = (item.q as QueueMotion).at(t);
        lanePose(r, m.s, out);
        out.speed = m.v;
        brake = m.v < 0.05 || (item.q as QueueMotion).at(t + 0.5).v < m.v - 0.05;
        break;
      }
      case 'enter':
      case 'wait': {
        const e = item.enter as PathTiming;
        e.at(seg.kind === 'wait' ? e.duration : t - seg.t0, tmpSt);
        lanePose(r, item.sEnter + (tmpSt.dist ?? 0), out);
        out.speed = tmpSt.speed ?? 0;
        brake = (tmpSt.accel ?? 0) < -0.1 || out.speed < 0.05;
        break;
      }
      case 'back':
        r.back.path.at(t - seg.t0, tmpSt);
        r.back.rig.poseAt(tmpSt.dist ?? 0, out);
        out.speed = tmpSt.speed ?? 0;
        brake = (tmpSt.accel ?? 0) < -0.1;
        break;
      case 'prep':
      case 'docked':
        Object.assign(out, r.parked, { speed: 0, reversing: false });
        brake = true;
        break;
      case 'pullout':
      case 'exit': {
        const t0 = item.exitStart;
        r.exit.path.at(t - t0, tmpSt);
        r.exit.rig.poseAt(tmpSt.dist ?? 0, out);
        out.speed = tmpSt.speed ?? 0;
        brake = (tmpSt.accel ?? 0) < -0.1 || out.speed < 0.05;
        break;
      }
      default:
        return undefined;
    }
    return { seg: seg.kind, units: [{ role: 'truck', dims: item.d, pose: out }], hazard: !!seg.hazard, brake };
  }
  // 甩挂：按段找是哪一套动作
  const sh = seg.kind === 'drop' ? item.drop : seg.kind === 'hook' ? item.pickup : seg.kind === 'shunt' ? (item.toDoor && t < item.toDoor.t0 + item.toDoor.dur ? item.toDoor : item.toStall) : undefined;
  if (seg.kind === 'docked' || !sh) {
    const r = yardRouteParked(it.plan, item);
    return { seg: seg.kind, units: [{ role: 'trailer', dims: trailerOnly(item.d), pose: r }], hazard: false, brake: false };
  }
  const rel = t - sh.t0;
  // 在哪一段 Leg：开始时刻不晚于此刻的最后一段；段前段后的空当是挂上 / 摘下挂车（停着、打双闪）
  let k = 0;
  for (let i = 0; i < sh.legs.length; i++) if (rel >= (sh.starts[i] as number)) k = i;
  const leg = sh.legs[k] as SlimLeg;
  const local = rel - (sh.starts[k] as number);
  const waiting = local < 0 || local > leg.path.duration;
  const out = newPose();
  slimPose(leg, Math.max(0, Math.min(leg.path.duration, local)), out, tmpSt);
  if (waiting) out.speed = 0;
  const units: PoseUnit[] = [{ role: sh.roles[k] ?? 'truck', dims: leg.dims, pose: out }];
  // 空车在动的时候挂车留在车位里
  if (leg.dims.kind === 'body') {
    const st = it.plan.stalls[item.stall];
    const L = item.d.kind === 'rig' ? item.d.axle : 0;
    if (st) units.push({ role: 'trailer', dims: trailerOnly(item.d), pose: { ...newPose(), x: st.x, z: st.z - L, heading: Math.PI, trailer: Math.PI } });
  }
  return { seg: seg.kind, units, hazard: waiting, brake: waiting || out.speed < 0.05 };
}

/**
 * 单独停着的挂车（在甩挂车位里、在门口、空车开走以后）的车身：只有挂车那一个矩形（不带牵引车）。参考点仍是牵引销，朝向是挂车的朝向。
 * A trailer standing on its own: just the trailer box (no tractor); the reference point stays the kingpin.
 */
const TRAILER_ONLY = new WeakMap<VehicleDims, VehicleDims>();
function trailerOnly(d: VehicleDims): VehicleDims {
  if (d.kind !== 'rig') return d;
  let t = TRAILER_ONLY.get(d);
  if (!t) TRAILER_ONLY.set(d, (t = { kind: 'body', length: d.trailerFront + d.rear, width: d.width, wheelbase: d.axle, rearOverhang: d.rear }));
  return t;
}

/** 挂车停在门口的位姿 */
function yardRouteParked(p: YardPlan, tr: Trailer): RigPose {
  const d = tr.d;
  const x = p.doors[tr.v.door]?.x ?? 0;
  const z = d.kind === 'rig' ? 0.6 + d.rear : 0.6 + d.rearOverhang;
  return { ...newPose(), x, z, heading: 0, trailer: 0 };
}

export { BOBTAIL };
