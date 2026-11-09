import { fillet, TimedPath, TowChain, type Dynamics, type PathState } from '@storewright/yard';
import { aisleLaneZ, AISLE_W, type LongBay, type Pt, type Stall, type StoreLot } from './lot';
import { along, planPeople, walkAt, type People } from './people';
import { moveStay, oppositeStall, SERVE_HOLD, type ParkMode, type Stay, type StayPlan } from './stays';
import { isPickup, type CarVisit } from './visits';

/**
 * 停车场里车的时空预约（纯函数，门店本地坐标；第一部分 Storewright 的停车场让行逻辑推广）：
 * 车按到达的先后排进一张「时空预约表」（每 0.5 秒一格，每辆车一个有朝向的矩形，拖车再加一个），
 * 每辆车沿自己的路线往前推：前面要撞上已经排好的车、停着的车、正在过斑马线的人、回收员推的一串购物车，
 * 就在冲突点前停下（车头离冲突点留出一个车身）等到前面让开；整条路线排不开就在入口（进店路上）晚一点进来，
 * 再不行换成车头朝里停；走的车在车位里等路线让开再倒出来。每一辆车都排上（实在排不开的按「只看前面、不看后面」排，计数）。
 * 取货的车先排（到取货位的时刻照门店仿真）；免下车车道按实际到的先后排位置，前面的车走了往前挪，交付那几十秒不动。
 * 进店路（单车道）上按车头时距跟车，出去在干道路口停止线前排队等灯。
 *
 * 结果里的路径只存「怎么生成」（点、限速、加减速），不存算好的路径：后台线程排完传回主线程，画的时候用到才生成（planPath）。
 */

/** 车型（和三维的车型一样的名字、外形尺寸）：车长、车宽；拖车：挂钩在车身中心后面多远、挂钩到拖车车轴、车轴离拖车车尾 */
export interface CarModel {
  key: string;
  len: number;
  wid: number;
  trailer?: { key: string; len: number; wid: number; hitch: number; tongue: number; axleX: number };
}
const BODY: Record<string, [number, number]> = { car: [4.85, 1.84], hatch: [4.3, 1.8], suv: [4.62, 1.86], mpv: [4.95, 1.85], pickup: [5.88, 2.03], van: [6.0, 2.05], rv: [11.2, 2.55] };
const TRAILER: Record<string, [number, number, number]> = { camper: [9.65, 2.44, 3.2], boatTrailer: [7.4, 2.3, 2.4], utilityTrailer: [4.3, 2.4, 1.3] };
const HITCH_BEHIND: Record<string, number> = { suv: 0.05, pickup: 0.3 };

const body = (key: string): CarModel => ({ key, len: (BODY[key] as [number, number])[0], wid: (BODY[key] as [number, number])[1] });
function towModel(car: string, trailer: string): CarModel {
  const c = body(car);
  const [len, wid, axleX] = TRAILER[trailer] as [number, number, number];
  return { ...c, trailer: { key: trailer, len, wid, hitch: c.len / 2 + (HITCH_BEHIND[car] ?? 0.2), tongue: len - axleX, axleX } };
}
/** 一辆车的车型（按来车的随机数：轿车、两厢、SUV、MPV；房车；拖着房车、小艇、平板拖车的 SUV 或皮卡） */
export function modelOf(v: CarVisit): CarModel {
  const r = v.seed;
  if (v.kind === 'rv') return body('rv');
  if (v.kind === 'camper') return towModel(r < 0.5 ? 'pickup' : 'suv', 'camper');
  if (v.kind === 'boat') return towModel(r < 0.5 ? 'suv' : 'pickup', 'boatTrailer');
  if (v.kind === 'utility') return towModel('suv', 'utilityTrailer');
  // 停普通车位的车不超过 5 米（皮卡、厢式车车尾会伸进车道，挤得旁边的车开不进去）：皮卡只拖着拖车停长车位
  return body(r < 0.32 ? 'car' : r < 0.52 ? 'hatch' : r < 0.84 ? 'suv' : 'mpv');
}

/** 一段路径怎么生成（可以在线程之间传）：点、限速、倒车、加减速；拖车按车轴的挂钩运动学 */
export interface PathSpec {
  pts: Pt[];
  v: number;
  rev: boolean;
  dyn: Dynamics;
  tow?: { hitch: number; length: number; init: number };
}
export type LotPart =
  | { kind: 'move'; t0: number; t1: number; spec: PathSpec; path?: TimedPath; chain?: TowChain }
  | { kind: 'hold'; t0: number; t1: number; x: number; z: number; heading: number; brake: boolean; tr?: { x: number; z: number; heading: number } };
type MovePart = Extract<LotPart, { kind: 'move' }>;

/** 生成（并缓存）一段路径 */
export function planPath(p: MovePart): TimedPath {
  p.path ??= new TimedPath(p.spec.pts, p.spec.v, p.spec.rev, p.spec.dyn);
  return p.path;
}
function planChain(p: MovePart): TowChain | undefined {
  if (!p.spec.tow) return undefined;
  p.chain ??= new TowChain(p.spec.pts, [{ hitch: p.spec.tow.hitch, length: p.spec.tow.length }], [p.spec.tow.init]);
  return p.chain;
}

export interface CarPlan {
  i: number;
  model: CarModel;
  mode: ParkMode;
  /** 进来：从进店路上（干道路口后面）开到车位；走：从车位开到进店路上干道路口的停止线 */
  entry: LotPart[];
  exit: LotPart[];
  /** 进店路上的起点时刻（三维从干道接上）、停好的时刻、开始走的时刻、开过停止线的时刻 */
  tIn: number;
  arrive: number;
  leave: number;
  tOut: number;
  park: { x: number; z: number; heading: number; tr?: { x: number; z: number; heading: number } };
  waits: number;
  late: number;
  /** 实在排不开、按「只看前面」排的（停着等的时候可能被别人碰上） */
  forced: boolean;
}

export interface LotRoad {
  /** 进店路：干道路口后面的起点（本地 z）、出去的停止线（本地 z）；车速（沙盘里的路，和背景车流一样） */
  zIn: number;
  zStop: number;
  speed: number;
  /**
   * 干道路口的信号：周期偏移；进来的车走的那条腿的相位（按车，没有信号是 undefined）、出去的相位；
   * inLead：车头过干道停止线比到进店路起点早几秒（按车，没有按 3 秒）
   */
  signal?: { offset: number; inPhase: (0 | 1 | undefined)[]; outPhase: 0 | 1 | undefined; inLead?: number[] };
}

export interface LotTraffic {
  plans: (CarPlan | undefined)[];
  stats: { hardMaxDev: number; hardMaxLate: number; softLate: number; forced: number; dropped: number; waits: number; entranceDelays: number; serveMoved: number };
}

const G = 0.5;
const LOT_V = 4.2;
const SLOW_V = 2.0;
const BACK_V = 1.4;
const LANE_V = 1.4;
const YIELD = 2.5;
const YIELD_LONG = 4;
const CAR_DYN: Dynamics = { accel: 2.0, decel: 2.8, lat: 1.8, wheelbase: 2.7 };
const LONG_DYN: Dynamics = { accel: 1.0, decel: 1.6, lat: 1.2, wheelbase: 4.5 };
/** 信号灯：周期 80 秒、绿灯 36 秒（和 web/src/three/signals.ts 一样） */
const CYCLE = 80;
const GREEN = 36;
const phaseClock = (offset: number, phase: number, t: number) => {
  const c = (((t + offset) % CYCLE) + CYCLE) % CYCLE;
  return phase === 0 ? c : (c + CYCLE / 2) % CYCLE;
};

interface Box {
  x: number;
  z: number;
  fx: number;
  fz: number;
  hl: number;
  hw: number;
}
const mkBox = (x: number, z: number, h: number, len: number, wid: number): Box => ({ x, z, fx: Math.sin(h), fz: Math.cos(h), hl: len / 2, hw: wid / 2 });
/** 两个有朝向的矩形重叠吗（分离轴）；grow 加在第一个上 */
export function boxesOverlap(a: Box, b: Box, growL = 0, growW = 0): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const ahl = a.hl + growL;
  const ahw = a.hw + growW;
  if (dx * dx + dz * dz > (ahl + ahw + b.hl + b.hw) ** 2) return false;
  const axes = [
    [a.fx, a.fz],
    [a.fz, -a.fx],
    [b.fx, b.fz],
    [b.fz, -b.fx],
  ] as const;
  for (const [ux, uz] of axes) {
    const ra = ahl * Math.abs(a.fx * ux + a.fz * uz) + ahw * Math.abs(a.fz * ux - a.fx * uz);
    const rb = b.hl * Math.abs(b.fx * ux + b.fz * uz) + b.hw * Math.abs(b.fz * ux - b.fx * uz);
    if (Math.abs(dx * ux + dz * uz) > ra + rb) return false;
  }
  return true;
}
const pointIn = (a: Box, x: number, z: number, growL: number, growW: number) => {
  const dx = x - a.x;
  const dz = z - a.z;
  return Math.abs(dx * a.fx + dz * a.fz) <= a.hl + growL && Math.abs(dx * a.fz - dz * a.fx) <= a.hw + growW;
};

/** 折线的一段（按距离） */
function sub(pts: readonly Pt[], s0: number, s1: number): Pt[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).z - (pts[i - 1] as Pt).z));
  const at = (s: number) => {
    let i = 1;
    while (i < cum.length - 1 && (cum[i] as number) < s) i++;
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const seg = (cum[i] as number) - (cum[i - 1] as number);
    const f = seg > 1e-9 ? Math.min(1, Math.max(0, (s - (cum[i - 1] as number)) / seg)) : 0;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };
  const out: Pt[] = [at(s0)];
  for (let i = 0; i < pts.length; i++) if ((cum[i] as number) > s0 + 1e-6 && (cum[i] as number) < s1 - 1e-6) out.push({ ...(pts[i] as Pt) });
  out.push(at(s1));
  return out;
}
const lenOf = (pts: readonly Pt[]) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p.x - (pts[i - 1] as Pt).x, p.z - (pts[i - 1] as Pt).z) : 0), 0);

interface Leg {
  pts: Pt[];
  v: number;
  rev?: boolean;
  /** go = 接着开进下一段；stop = 停下（wait 秒让行）；park = 停进车位 */
  end: 'go' | 'stop' | 'park';
  wait?: number;
}

export function planLotTraffic(lot: StoreLot, plan: StayPlan, people: People, road: LotRoad): LotTraffic {
  const stays = plan.stays;
  const slots = new Map<number, number[]>();
  const peds = new Map<number, number[]>();
  const F = lot.frontage;
  const zT = F.z + F.half + 6;
  const zOutT = F.z + F.half + 2;
  const gateZ1 = F.z - F.half;
  const W = lot.west;
  const g0 = lot.gates[0] as StoreLot['gates'][number];
  const g1 = lot.gates[1] as StoreLot['gates'][number];
  const stats = { hardMaxDev: 0, hardMaxLate: 0, softLate: 0, forced: 0, dropped: 0, waits: 0, entranceDelays: 0, serveMoved: 0 };
  const models = stays.map((s) => modelOf(s.visit));
  const addBox = (k: number, b: Box, id: number) => {
    let a = slots.get(k);
    if (!a) slots.set(k, (a = []));
    a.push(b.x, b.z, b.fx, b.fz, b.hl, b.hw, id);
  };

  // —— 人、回收员推的购物车 ——
  const addPed = (k: number, x: number, z: number, id: number) => {
    let a = peds.get(k);
    if (!a) peds.set(k, (a = []));
    a.push(x, z, id);
  };
  for (const w of people.walks) for (let k = Math.ceil(w.t0 / G); k * G <= w.t1; k++) {
    const p = walkAt(w, k * G);
    addPed(k, p.x, p.z, w.id);
  }
  for (const s of people.stands) for (let k = Math.ceil(s.t0 / G); k * G <= s.t1; k++) addPed(k, s.x, s.z, s.id);
  for (const tr of people.trains) {
    const len = tr.cum[tr.cum.length - 1] as number;
    for (let k = Math.ceil(tr.t0 / G); k * G <= tr.t1; k++) {
      const s = Math.min(len, ((k * G - tr.t0) / Math.max(1, tr.t1 - tr.t0)) * len);
      const head = along(tr.pts, tr.cum, Math.min(len, s + 1 + tr.n * 0.34));
      const tail = along(tr.pts, tr.cum, s);
      addBox(k, mkBox((head.x + tail.x) / 2, (head.z + tail.z) / 2, Math.atan2(head.x - tail.x, head.z - tail.z), Math.hypot(head.x - tail.x, head.z - tail.z) + 0.6, 0.9), -2);
    }
  }

  // —— 停着的车（空间分格）：还没排到走的车，按车位安排的离开时刻再多算 2 分钟（走的时候可能要等一会儿）——
  const CELL = 10;
  const cellKey = (x: number, z: number) => (Math.floor(x / CELL) + 5000) * 10000 + (Math.floor(z / CELL) + 5000);
  const parked = new Map<number, Array<{ id: number; a: number; b: number; boxes: Box[] }>>();
  const parkEntry: Array<{ id: number; a: number; b: number; boxes: Box[] } | undefined> = [];
  const register = (id: number, boxes: Box[], a: number, b: number) => {
    const e = { id, a, b, boxes };
    parkEntry[id] = e;
    const keys = new Set<number>();
    for (const bx of boxes) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) keys.add(cellKey(bx.x + dx * CELL, bx.z + dz * CELL));
    for (const key of keys) {
      let l = parked.get(key);
      if (!l) parked.set(key, (l = []));
      l.push(e);
    }
  };
  const parkPose = (st: Stay, m: CarModel, mode: ParkMode): CarPlan['park'] | undefined => {
    if (st.mode === 'drive') return undefined;
    if (st.mode === 'long') {
      // 车头离这一排外头那条线 0.8 米
      const bay = lot.long[st.stall] as LongBay;
      return bay.nose < 0 ? { x: bay.xHead + 0.8 + m.len / 2, z: bay.parkZ, heading: -Math.PI / 2 } : { x: bay.xTail - 0.8 - m.len / 2, z: bay.parkZ, heading: Math.PI / 2 };
    }
    // 车头（倒车入位的是车尾）顶到车位里头那条线前 0.3 米
    const s = lot.stalls[st.stall] as Stall;
    const back = s.d / 2 - (m.len / 2 + 0.3);
    return { x: s.x + Math.sin(s.heading) * back, z: s.z + Math.cos(s.heading) * back, heading: mode === 'back' || mode === 'through' ? s.heading + Math.PI : s.heading };
  };
  const boxesAt = (m: CarModel, x: number, z: number, h: number, tr?: { x: number; z: number; heading: number }): Box[] => {
    const out = [mkBox(x, z, h, m.len, m.wid)];
    if (m.trailer) {
      const t = tr ?? { x: x - Math.sin(h) * (m.trailer.hitch + m.trailer.tongue), z: z - Math.cos(h) * (m.trailer.hitch + m.trailer.tongue), heading: h };
      const c = m.trailer.len / 2 - m.trailer.axleX;
      out.push(mkBox(t.x + Math.sin(t.heading) * c, t.z + Math.cos(t.heading) * c, t.heading, m.trailer.len, m.trailer.wid));
    }
    return out;
  };
  const PARK_EXTRA = 120;
  stays.forEach((st, id) => {
    const p = parkPose(st, models[id] as CarModel, st.mode);
    if (p) register(id, boxesAt(models[id] as CarModel, p.x, p.z, p.heading), st.arrive - 30, st.leave + PARK_EXTRA);
  });

  /** 车 id 在 t 时是这些矩形，和别的东西冲突吗（moving = 在开：前面多留余量、看人） */
  const conflict = (id: number, t: number, boxes: Box[], moving: boolean): boolean => {
    const k = Math.round(t / G);
    const a = slots.get(k);
    if (a)
      for (let i = 0; i < a.length; i += 7) {
        if (a[i + 6] === id) continue;
        const b: Box = { x: a[i] as number, z: a[i + 1] as number, fx: a[i + 2] as number, fz: a[i + 3] as number, hl: a[i + 4] as number, hw: a[i + 5] as number };
        for (const bx of boxes) if (boxesOverlap(bx, b, moving ? 0.45 : 0.1, moving ? 0.18 : 0.08)) return true;
      }
    for (const bx of boxes) {
      const l = parked.get(cellKey(bx.x, bx.z));
      if (l)
        for (const e of l) {
          if (e.id === id || t < e.a || t > e.b) continue;
          for (const pb of e.boxes) if (boxesOverlap(bx, pb, 0.05, 0.05)) return true;
        }
    }
    const pp = peds.get(k);
    if (pp && moving)
      for (let i = 0; i < pp.length; i += 3) {
        if (pp[i + 2] === id) continue;
        for (const bx of boxes) if (pointIn(bx, pp[i] as number, pp[i + 1] as number, 1.2, 0.55)) return true;
      }
    return false;
  };

  /** 停着的车在 [a, b] 里没被别的车碰到（比登记的早到、晚走的那一段：对面车位穿过去的车、下一辆来停的车） */
  const stillFree = (id: number, boxes: Box[], a: number, b: number): boolean => {
    for (let k = Math.ceil(a / G); k * G <= b; k++) if (conflict(id, k * G, boxes, false)) return false;
    return true;
  };

  /** 一段路径在 0.5 秒格点上的矩形：第一个冲突的时刻（相对 t0），没有返回 undefined */
  const firstHit = (id: number, m: CarModel, path: TimedPath, t0: number, tow: TowChain | undefined): number | undefined => {
    const st: PathState = { x: 0, z: 0, heading: 0 };
    const lead = { x: 0, z: 0, heading: 0 };
    const units = [{ x: 0, z: 0, heading: 0 }];
    for (let k = Math.ceil((t0 + 1e-6) / G); k * G <= t0 + path.duration + 1e-6; k++) {
      path.at(k * G - t0, st);
      let tr: { x: number; z: number; heading: number } | undefined;
      if (tow) {
        tow.at(st.dist ?? 0, lead, units);
        tr = units[0];
      }
      if (conflict(id, k * G, boxesAt(m, st.x, st.z, st.heading, tr), true)) return k * G - t0;
    }
    return undefined;
  };

  /**
   * 沿一串路段往前推，遇到冲突停下来等；ok = false 表示停着的时候被别人撞上（这样排不开）。
   * forced = 只看前面（停着的时候不查），一定排得上。
   */
  const run = (id: number, m: CarModel, legs: Leg[], t0: number, v0: number | 'cap', tr0: { x: number; z: number; heading: number } | undefined, forced: boolean) => {
    const parts: LotPart[] = [];
    const dyn = m.trailer || m.key === 'rv' ? LONG_DYN : CAR_DYN;
    let t = t0;
    let vStart: number | 'cap' = v0;
    let trailer = tr0;
    let waits = 0;
    const st: PathState = { x: 0, z: 0, heading: 0 };
    const make = (pts: Pt[], v: number, rev: boolean, v1: number | 'cap', heading0: number): MovePart => {
      const spec: PathSpec = { pts, v, rev, dyn: { ...dyn, v0: vStart, v1 }, ...(m.trailer ? { tow: { hitch: m.trailer.hitch, length: m.trailer.tongue, init: trailer?.heading ?? heading0 } } : {}) };
      const part: MovePart = { kind: 'move', t0: t, t1: t, spec };
      part.t1 = t + planPath(part).duration;
      return part;
    };
    const advance = (part: MovePart) => {
      parts.push(part);
      const ch = planChain(part);
      if (ch) {
        const lead = { x: 0, z: 0, heading: 0 };
        const u = [{ x: 0, z: 0, heading: 0 }];
        ch.at(ch.length, lead, u);
        trailer = { ...(u[0] as { x: number; z: number; heading: number }) };
      }
      t = part.t1;
    };
    const hold = (x: number, z: number, h: number, sec: number, brake: boolean): boolean => {
      if (!forced) {
        const boxes = boxesAt(m, x, z, h, trailer);
        for (let k = Math.ceil((t + 1e-6) / G); k * G <= t + sec; k++) if (conflict(id, k * G, boxes, false)) return false;
      }
      parts.push({ kind: 'hold', t0: t, t1: t + sec, x, z, heading: h, brake, ...(trailer ? { tr: { ...trailer } } : {}) });
      t += sec;
      return true;
    };
    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li] as Leg;
      const next = legs[li + 1];
      const v1: number | 'cap' = leg.end === 'go' && !next?.rev && !leg.rev ? 'cap' : 0;
      let pts = leg.pts;
      let guard = 0;
      for (;;) {
        // 只看前面排的车等了 10 分钟还走不了（前面一直有车）：照直开过去（不再等，算在重叠里），路线不断
        // 不是只看前面排的车：一段路上等了 4 分钟还走不了就算排不开（换个时刻、在入口或车位里等，别堵在车道上）
        if (++guard > (forced ? 400 : 160) && !forced) return { parts, t, ok: false, waits, trailer };
        const p0 = pts[0] as Pt;
        const p1 = pts[1] ?? p0;
        const h0 = Math.atan2(p1.x - p0.x, p1.z - p0.z);
        const part = make(pts, leg.v, !!leg.rev, v1, h0);
        const hitTau = forced && guard > 400 ? undefined : firstHit(id, m, planPath(part), t, planChain(part));
        if (hitTau === undefined) {
          advance(part);
          vStart = v1;
          break;
        }
        // 冲突点前停下：车头离冲突的地方留一个车身
        waits++;
        const at: PathState = { x: 0, z: 0, heading: 0 };
        planPath(part).at(hitTau, at);
        const sw = (at.dist ?? 0) - (leg.rev ? 1.5 : m.len / 2 + 1.2);
        if (sw > 0.8) {
          const short = make(sub(pts, 0, sw), leg.v, !!leg.rev, 0, h0);
          if (firstHit(id, m, planPath(short), t, planChain(short)) === undefined) {
            advance(short);
            pts = sub(pts, sw, lenOf(pts));
            vStart = 0;
          }
        }
        const q0 = pts[0] as Pt;
        const q1 = pts[1] ?? q0;
        const h = leg.rev ? Math.atan2(q0.x - q1.x, q0.z - q1.z) : Math.atan2(q1.x - q0.x, q1.z - q0.z);
        if (!hold(q0.x, q0.z, h, 1.5, true)) return { parts, t, ok: false, waits, trailer };
        vStart = 0;
      }
      if (leg.end === 'stop' && (leg.wait ?? 0) > 0) {
        const last = parts[parts.length - 1];
        if (last && last.kind === 'move') {
          planPath(last).at(planPath(last).duration, st);
          if (!hold(st.x, st.z, st.heading, leg.wait as number, true)) return { parts, t, ok: false, waits, trailer };
        }
      }
    }
    return { parts, t, ok: true, waits, trailer };
  };
  const commit = (id: number, m: CarModel, parts: LotPart[]) => {
    const st: PathState = { x: 0, z: 0, heading: 0 };
    const lead = { x: 0, z: 0, heading: 0 };
    const units = [{ x: 0, z: 0, heading: 0 }];
    for (const p of parts) {
      for (let k = Math.ceil((p.t0 + 1e-6) / G); k * G <= p.t1 + 1e-6; k++) {
        if (p.kind === 'hold') {
          for (const b of boxesAt(m, p.x, p.z, p.heading, p.tr)) addBox(k, b, id);
          continue;
        }
        planPath(p).at(k * G - p.t0, st);
        let tr: { x: number; z: number; heading: number } | undefined;
        const ch = planChain(p);
        if (ch) {
          ch.at(st.dist ?? 0, lead, units);
          tr = units[0];
        }
        for (const b of boxesAt(m, st.x, st.z, st.heading, tr)) addBox(k, b, id);
      }
    }
  };

  // —— 每辆车的路段（门店本地坐标）——
  const fil = (pts: Pt[], r = 4) => fillet(pts, r, 0.8);
  /** alt = 走另一个门（离车位远的那个） */
  const entryLegs = (st: Stay, m: CarModel, mode: ParkMode, alt = false): Leg[] => {
    const park = parkPose(st, m, mode);
    const west = st.mode === 'drive' || isPickup(st.visit.kind);
    const longStay = st.mode === 'long';
    const near0 = park && park.x < (g0.x + g1.x) / 2 ? g0 : g1;
    const near = alt ? (near0 === g0 ? g1 : g0) : near0;
    // 长车从车尾那头进车位：车头朝西的走东门、朝东的走西门
    const nose = longStay ? (lot.long[st.stall] as LongBay).nose : -1;
    const g = west ? g0 : longStay ? (nose < 0 ? g1 : g0) : near;
    const zw = F.z - 1.75;
    const ze = F.z + 1.75;
    const lp: Pt[] = [{ x: 1.75, z: zT }];
    if (g === g0) lp.push({ x: 1.75, z: ze }, { x: -3.25, z: zw }, { x: g.inX + 6, z: zw }, { x: g.inX, z: gateZ1 });
    else lp.push({ x: 1.75, z: ze + 0.5 }, { x: 6.75, z: ze }, { x: g.inX - 6, z: ze }, { x: g.inX, z: gateZ1 });
    if (west) {
      const bc = W.bulb.c;
      lp.push({ x: g.inX, z: lot.edgeZ - 2 }, { x: W.outerX, z: W.zSouth }, { x: W.outerX, z: bc.z + 2 });
      for (let k = 0; k <= 12; k++) {
        const a = Math.PI + (k / 12) * Math.PI;
        lp.push({ x: bc.x + W.bulb.r * Math.cos(a), z: bc.z + W.bulb.r * Math.sin(a) });
      }
      lp.push({ x: W.serviceX + 0.4, z: bc.z + W.bulb.r + 2.5 });
      if (st.mode === 'drive') {
        // 拐进车道、停到最后一个位置（这一段也查冲突：西侧取货位倒出来的车、车道里排着的车）；拐弯不扫最北那个取货位
        const z0 = (lot.drive[0] as StoreLot['drive'][number]).z;
        lp.push({ x: W.serviceX, z: W.driveZ[0] - 5 });
        return [
          { pts: fil(lp), v: LOT_V, end: 'go' },
          { pts: fil([{ x: W.serviceX, z: W.driveZ[0] - 5 }, { x: W.serviceX, z: W.driveZ[0] - 1.2 }, { x: W.driveLaneX, z: z0 - 1.4 }, { x: W.driveLaneX, z: z0 }], 2.5), v: SLOW_V, end: 'stop' },
        ];
      }
      const s = lot.stalls[st.stall] as Stall;
      const pk = park ?? { x: s.x, z: s.z };
      lp.push({ x: W.serviceX, z: s.z - 6 });
      return [
        { pts: fil(lp), v: LOT_V, end: 'go' },
        { pts: fil([{ x: W.serviceX, z: s.z - 6 }, { x: W.serviceX, z: s.z - 3.2 }, { x: W.serviceX + 0.2, z: s.z }, { x: pk.x, z: pk.z }], 2.6), v: SLOW_V, end: 'park' },
      ];
    }
    if (longStay && park) {
      // 顺着最外侧车道开到车尾那头，进了车位范围（往里 2 米）才往里并：挂车内轮差不扫隔壁车位停着的车
      const bay = lot.long[st.stall] as LongBay;
      const n = bay.nose;
      const az = bay.aisleZ;
      const hug = az - AISLE_W / 2 + 1.55;
      const lane = n < 0 ? az + 1.6 : aisleLaneZ(az, 1);
      const tail = n < 0 ? bay.xTail : bay.xHead;
      const lim = (x: number, d: number) => (n < 0 ? Math.min(g.inX - d, x) : Math.max(g.inX + d, x));
      const s0 = { x: tail + n * 2, z: hug };
      lp.push({ x: g.inX, z: lane }, { x: lim(tail - n * 30, 10), z: lane }, { x: lim(tail - n * 16, 18), z: hug }, s0);
      return [
        { pts: fil(lp, 6), v: 3.2, end: 'go' },
        { pts: fil([s0, { x: park.x - n * 6, z: park.z }, { x: park.x, z: park.z }], 6), v: 2.0, end: 'park' },
      ];
    }
    const s = lot.stalls[st.stall] as Stall;
    const pk = park ?? { x: s.x, z: s.z };
    const az = lot.aisles[s.aisle] as number;
    const dir = Math.sign(s.x - g.inX) || 1;
    const into = Math.sign(s.z - az) || 1;
    if (mode === 'through') {
      // 从对面那条车道开进空着的对面车位，一直开过去停进自己的车位（车头朝外）
      const o = oppositeStall(lot, s) as Stall;
      const ao = lot.aisles[o.aisle] as number;
      const io = Math.sign(o.z - ao) || 1;
      const azl = aisleLaneZ(ao, dir);
      lp.push({ x: g.inX, z: azl }, { x: s.x - dir * 7, z: azl });
      return [
        { pts: fil(lp), v: LOT_V, end: 'go' },
        { pts: fil([{ x: s.x - dir * 7, z: azl }, { x: s.x - dir * 3.2, z: ao - io * 1.6 }, { x: s.x, z: ao - io * 1.6 }, { x: pk.x, z: pk.z }], 2.6), v: SLOW_V, end: 'park' },
      ];
    }
    const azl = aisleLaneZ(az, dir);
    if (mode === 'back') {
      // 开过车位停在车道对侧，打方向倒回来、对正以后笔直倒进去（和倒出来的路线一样）
      lp.push({ x: g.inX, z: azl }, { x: s.x - dir * 4, z: azl });
      const past = { x: s.x + dir * 4.5, z: az - into * 1.6 };
      return [
        { pts: fil(lp), v: LOT_V, end: 'go' },
        { pts: fil([{ x: s.x - dir * 4, z: azl }, past], 3), v: SLOW_V, end: 'stop', wait: 1.0 },
        { pts: fil([past, { x: s.x, z: az - into * 0.9 }, { x: pk.x, z: pk.z }], 2.4), v: BACK_V, rev: true, end: 'park' },
      ];
    }
    // 车头朝里：先往车道对侧摆，在对侧拐 90 度、对正车位再笔直开进去（不扫到两边停着的车）
    lp.push({ x: g.inX, z: azl }, { x: s.x - dir * 7, z: azl });
    return [
      { pts: fil(lp), v: LOT_V, end: 'go' },
      { pts: fil([{ x: s.x - dir * 7, z: azl }, { x: s.x - dir * 3.2, z: az - into * 1.6 }, { x: s.x, z: az - into * 1.6 }, { x: pk.x, z: pk.z }], 2.6), v: SLOW_V, end: 'park' },
    ];
  };
  const exitLegs = (st: Stay, m: CarModel, mode: ParkMode, from: Pt, alt = false): Leg[] => {
    const west = st.mode === 'drive' || isPickup(st.visit.kind);
    const longStay = st.mode === 'long';
    const park = parkPose(st, m, mode);
    const near0 = park && park.x < (g0.x + g1.x) / 2 ? g0 : g1;
    const near = alt ? (near0 === g0 ? g1 : g0) : near0;
    // 长车往前开出这一排、拐上两侧的车道：车头朝西的走西门、朝东的走东门
    const nose = longStay ? (lot.long[st.stall] as LongBay).nose : -1;
    const g = west ? g0 : longStay ? (nose < 0 ? g0 : g1) : near;
    const legs: Leg[] = [];
    const out: Pt[] = [];
    if (west) {
      if (st.mode === 'drive') out.push(from, { x: W.driveLaneX, z: lot.frontZ - 0.6 });
      else {
        const s = lot.stalls[st.stall] as Stall;
        legs.push({ pts: fil([from, { x: W.serviceX + 0.2, z: s.z }, { x: W.serviceX, z: s.z - 3.2 }], 2.4), v: BACK_V, rev: true, end: 'stop', wait: 0.8 });
        out.push({ x: W.serviceX, z: s.z - 3.2 }, { x: W.serviceX, z: s.z + 3 }, { x: W.serviceX, z: lot.frontZ - 0.6 });
      }
      legs.push({ pts: fil(out, 3), v: LOT_V, end: 'stop', wait: YIELD });
      const y = out[out.length - 1] as Pt;
      out.length = 0;
      out.push(y, { x: y.x - 2, z: lot.frontZ + 2.2 }, { x: g.outX + 3, z: lot.frontZ + 3.2 }, { x: g.outX, z: lot.frontZ + 7 });
    } else if (longStay && park) {
      out.push({ x: park.x, z: park.z }, { x: g.outX, z: park.z });
    } else {
      const s = lot.stalls[st.stall] as Stall;
      const az = lot.aisles[s.aisle] as number;
      const into = Math.sign(s.z - az) || 1;
      const dir = Math.sign(g.outX - s.x) || 1;
      const azl = aisleLaneZ(az, dir);
      if (mode === 'head') {
        // 笔直倒出来，过了车道中线再打方向（车头不扫两边的车）
        legs.push({ pts: fil([from, { x: s.x, z: az - into * 0.9 }, { x: s.x - dir * 4.5, z: az - into * 1.6 }], 2.4), v: BACK_V, rev: true, end: 'stop', wait: 0.8 });
        out.push({ x: s.x - dir * 4.5, z: az - into * 1.6 }, { x: s.x + dir * 3, z: azl });
      } else out.push(from, { x: s.x, z: az - into * 1.6 }, { x: s.x + dir * 3.2, z: az - into * 1.6 }, { x: s.x + dir * 7, z: azl });
    }
    const last = out[out.length - 1] as Pt;
    if (Math.abs(last.x - g.outX) > 0.5) out.push({ x: g.outX, z: last.z });
    out.push({ x: g.outX, z: gateZ1 - 0.5 });
    legs.push({ pts: fil(out, longStay ? 6 : 4), v: longStay ? 3.2 : LOT_V, end: 'stop', wait: longStay ? YIELD_LONG : YIELD });
    // 门前路 → T 形路口让行
    const fr: Pt[] = [{ x: g.outX, z: gateZ1 - 0.5 }];
    if (g === g0) fr.push({ x: g.outX, z: F.z - 0.5 }, { x: g.outX + 5, z: F.z + 1.75 }, { x: -6, z: F.z + 1.75 });
    else fr.push({ x: g.outX, z: F.z - 1 }, { x: g.outX - 5, z: F.z - 1.75 }, { x: 6, z: F.z - 1.75 });
    fr.push({ x: -1.75, z: zOutT });
    legs.push({ pts: fil(fr, longStay ? 6 : 4), v: 5.0, end: 'stop', wait: 1.5 });
    return legs;
  };
  const dur = (legs: Leg[], m: CarModel, v0: number | 'cap') => {
    let d = 0;
    let vs = v0;
    legs.forEach((l, i) => {
      const v1 = l.end === 'go' && !legs[i + 1]?.rev && !l.rev ? 'cap' : 0;
      d += new TimedPath(l.pts, l.v, !!l.rev, { ...(m.trailer || m.key === 'rv' ? LONG_DYN : CAR_DYN), v0: vs, v1 }).duration + (l.end === 'stop' ? (l.wait ?? 0) : 0);
      vs = v1;
    });
    return d;
  };

  const plans: (CarPlan | undefined)[] = stays.map(() => undefined);
  const inTimes: Array<{ t: number; gap: number }> = [];
  const accessDur = Math.max(1, (road.zIn - zT) / road.speed);
  const headwayOk = (t: number, len: number) => inTimes.every((o) => Math.abs(o.t - t) >= Math.max(o.gap, (len + 2.5) / road.speed));
  const sig = road.signal;
  const lead = (i: number) => sig?.inLead?.[i] ?? 3;
  /** 不是绿灯就退到上一个绿灯的末尾 */
  const prevGreen = (i: number, t: number) => {
    const ph = sig?.inPhase[i];
    if (ph === undefined) return t;
    const c = phaseClock(sig?.offset ?? 0, ph, t - lead(i));
    return c < GREEN ? t : t - (c - GREEN) - 0.5;
  };
  const greenIn = (i: number, t: number) => {
    const ph = sig?.inPhase[i];
    return ph === undefined || phaseClock(sig?.offset ?? 0, ph, t - lead(i)) < GREEN;
  };
  /** 顾客下车走开的时刻（这辆车的人第一段走路的起点）：车要在这之前 3 秒停好，不能晚到 */
  const byWalk = stays.map(() => Infinity);
  for (const w of people.walks) if (w.id >= 0 && w.id < byWalk.length) byWalk[w.id] = Math.min(byWalk[w.id] as number, w.t0 - 3);
  const accessPart = (tIn: number): LotPart => {
    const part: MovePart = { kind: 'move', t0: tIn, t1: tIn + accessDur, spec: { pts: [{ x: 1.75, z: road.zIn }, { x: 1.75, z: zT }], v: road.speed, rev: false, dyn: { accel: 3, decel: 3, v0: road.speed, v1: road.speed } } };
    part.t1 = tIn + planPath(part).duration;
    return part;
  };

  /** 进来：hard = 到车位（或免下车车道口）的时刻照门店仿真；soft = 在 [want − 45, want + 38] 里，排不开换车头朝里、再排不开只看前面 */
  const planEntry = (i: number, hard: boolean): CarPlan => {
    const st = stays[i] as Stay;
    const m = models[i] as CarModel;
    let mode = st.mode;
    let legs = entryLegs(st, m, mode);
    // 免下车照先来后到：比前一辆晚到车道里至少 4 秒
    // 交付前 25 秒以前停进车道（门店仿真里进车道到交付很快的那几辆，提前几秒进来）
    const minT = st.mode === 'drive' ? driveMouth + 4 : -Infinity;
    const hand = st.visit.handoff ?? st.leave - 20;
    const want = st.mode === 'drive' ? Math.max(Math.min(st.enter as number, hand - SERVE_HOLD - 6), minT) : st.arrive;
    const walkBy = byWalk[i] as number;
    const deadline = hard ? want + 8 : want + 38;
    let best: { r: ReturnType<typeof run>; tIn: number } | undefined;
    const tryAt = (tIn: number, forced = false) => {
      if (!forced && !headwayOk(tIn, m.len + (m.trailer?.len ?? 0))) return undefined;
      const r = run(i, m, legs, tIn + accessDur, road.speed, undefined, forced);
      if (!r.ok) return undefined;
      const reg = parkEntry[i];
      const pk = parkPose(st, m, mode);
      if (!forced && reg && pk && r.t < reg.a && !stillFree(i, boxesAt(m, pk.x, pk.z, pk.heading, r.trailer), r.t, reg.a)) return undefined;
      return r;
    };
    let base = want - dur(legs, m, road.speed) - accessDur;
    if (hard) {
      // 照时刻：路口绿灯放进来的时刻里，从 want 往前找第一个排得开、停好不晚过 8 秒的（取货的车早到一点在车位里等交付没关系）
      let tIn = base;
      for (let it = 0; it < 60 && tIn > base - 180; it++) {
        if (!greenIn(i, tIn)) {
          tIn = prevGreen(i, tIn);
          continue;
        }
        const r = tryAt(tIn);
        if (r && r.t < minT - 0.5) break;
        if (r && r.t <= want + 8) {
          best = { r, tIn };
          break;
        }
        tIn -= r ? Math.max(2, r.t - want - 4) : 2;
      }
      // 再排不开：晚一点进来（也是绿灯时）
      for (let tIn = base + 2; !best && tIn < base + 240; tIn += 2) {
        if (!greenIn(i, tIn)) continue;
        const r = tryAt(tIn);
        if (r && r.t >= minT - 0.5) best = { r, tIn };
      }
    } else {
      // 先在想停好的时刻前后 45 秒里找；再往前找到 3 分钟（司机在车里多坐一会儿，顾客进店的时刻不变）
      const offs = [0];
      for (let d = 3; d <= 45; d += 3) offs.push(-d, d);
      for (let d = 51; d <= 180; d += 6) offs.push(-d);
      const search = () => {
        for (const o of offs) {
          const tIn = base + o;
          if (!greenIn(i, tIn)) continue;
          const r = tryAt(tIn);
          if (!r) continue;
          if (r.t <= deadline) return { r, tIn };
          best ??= { r, tIn };
        }
        return undefined;
      };
      best = search() ?? best;
      if (!best && (mode === 'through' || mode === 'back')) {
        mode = 'head';
        legs = entryLegs(st, m, mode);
        base = want - dur(legs, m, road.speed) - accessDur;
        best = search() ?? best;
      }
      // 还排不开就不硬挤：司机早到在车里多坐（最多提前 10 分钟），或者在路上晚到（最多 8 分钟）
      const more: number[] = [];
      for (let d = 200; d <= 600; d += 20) more.push(-d);
      for (let d = 60; d <= 480; d += 20) more.push(d);
      const wider = () => {
        for (const o of more) {
          const tIn = base + o;
          if (!greenIn(i, tIn)) continue;
          const r = tryAt(tIn);
          if (r) return { r, tIn };
        }
        return undefined;
      };
      if (!best) best = wider();
      // 车位还被上一辆占着（它等着出去，晚走了）：等它开走再进来
      const pk0 = parkPose(st, m, mode);
      let busy = -Infinity;
      if (!best && pk0) {
        const mine = boxesAt(m, pk0.x, pk0.z, pk0.heading);
        for (const e of parked.get(cellKey(pk0.x, pk0.z)) ?? []) {
          if (e.id === i || e.b < want - 600 || e.a > want + 45) continue;
          if (e.boxes.some((b) => mine.some((q) => boxesOverlap(b, q, 0.05, 0.05)))) busy = Math.max(busy, e.b);
        }
      }
      for (let o = busy + 25 - want; !best && busy > want - 30 && o <= busy + 900 - want; o += 10) {
        const tIn = base + o;
        if (!greenIn(i, tIn)) continue;
        const r = tryAt(tIn);
        if (r) best = { r, tIn };
      }
      if (!best && st.mode !== 'long') {
        // 再换另一个门进来
        legs = entryLegs(st, m, mode, true);
        base = want - dur(legs, m, road.speed) - accessDur;
        best = search() ?? best ?? wider();
      }
      // 停好的时刻晚过顾客下车走开的时刻：再早一点来、在车位里坐着等（最多提前 40 分钟），两个门都试
      const onTime = () => !!best && best.r.t <= walkBy;
      for (const alt of st.mode === 'long' ? [false] : [false, true]) {
        if (onTime() || walkBy === Infinity) break;
        const lg = entryLegs(st, m, mode, alt);
        const b0 = want - dur(lg, m, road.speed) - accessDur;
        for (let o = 3; !onTime() && o <= 2400; o += o < 180 ? 3 : 20) {
          const tIn = b0 - o;
          if (!greenIn(i, tIn)) continue;
          const r = run(i, m, lg, tIn + accessDur, road.speed, undefined, false);
          if (!r.ok || r.t > walkBy || !headwayOk(tIn, m.len + (m.trailer?.len ?? 0))) continue;
          const reg = parkEntry[i];
          const pk = parkPose(st, m, mode);
          if (reg && pk && r.t < reg.a && !stillFree(i, boxesAt(m, pk.x, pk.z, pk.heading, r.trailer), r.t, reg.a)) continue;
          best = { r, tIn };
          legs = lg;
          base = b0;
        }
      }
    }
    let forced = false;
    if (!best) {
      // 实在排不开：只看前面（停着等的时候不查），一定排得上
      forced = true;
      stats.forced++;
      let r = run(i, m, legs, base + accessDur, road.speed, undefined, true);
      let tIn = base;
      // 有人要下车走开的：再早一点进来，直到停好不晚过下车的时刻
      for (let o = 15; r.t > walkBy && o <= 900; o += 15) r = run(i, m, legs, (tIn = base - o) + accessDur, road.speed, undefined, true);
      best = { r, tIn };
    }
    const { r, tIn } = best;
    inTimes.push({ t: tIn, gap: (m.len + (m.trailer?.len ?? 0) + 2.5) / road.speed });
    const park = parkPose(st, m, mode) ?? { x: W.serviceX, z: W.driveZ[0] - 5, heading: 0 };
    if (r.trailer) park.tr = r.trailer;
    stats.waits += r.waits;
    const dev = r.t - want;
    if (hard) {
      stats.hardMaxDev = Math.max(stats.hardMaxDev, Math.abs(dev));
      stats.hardMaxLate = Math.max(stats.hardMaxLate, dev);
    }
    else if (dev > 38) stats.softLate++;
    if (Math.abs(tIn - (want - dur(legs, m, road.speed) - accessDur)) > 1) stats.entranceDelays++;
    return { i, model: m, mode, entry: [accessPart(tIn), ...r.parts], exit: [], tIn, arrive: r.t, leave: st.leave, tOut: st.leave, park, waits: r.waits, late: dev, forced };
  };

  // —— 免下车车道（先进先出，三个位置）：跟着前一辆车往前挪（晚 6 秒起步），交付前 25 秒起不再挪 ——
  const lane: Array<{ stops: Array<{ t: number; pos: number }>; release: number }> = [];
  let driveMouth = -Infinity;
  const MOVE_UP = 6;
  const driveLane = (p: CarPlan, st: Stay): Array<{ t: number; pos: number }> => {
    const zOf = (pos: number) => (lot.drive[pos] as StoreLot['drive'][number]).z;
    const endPose: PathState = { x: W.driveLaneX, z: zOf(0), heading: 0 };
    const lastMove = [...p.entry].reverse().find((q): q is MovePart => q.kind === 'move');
    if (lastMove) planPath(lastMove).at(planPath(lastMove).duration, endPose);
    let cur: Pt = { x: endPose.x, z: endPose.z };
    const n = lot.drive.length;
    const h = st.visit.handoff ?? st.leave - 20;
    const ahead = lane[lane.length - 1];
    const stops: Array<{ t: number; pos: number }> = [];
    const t = p.arrive;
    // 进来时停在最后一个位置；前面空了就往前挪到最前，前一辆还在就停在它后面一格
    // 交付前 25 秒起车就不再往前挪（交付完直接开走）
    const canMove = (start: number) => start + MOVE_UP <= h - SERVE_HOLD;
    if (!ahead || ahead.release <= t) {
      if (n - 1 > 0 && canMove(t)) stops.push({ t, pos: n - 1 });
    } else {
      const posA = (tt: number) => {
        let q = -1;
        for (const s of ahead.stops) if (s.t <= tt + 1e-6) q = s.pos;
        return q;
      };
      let pos = Math.max(0, Math.min(n - 1, posA(t) - 1));
      if (pos > 0 && canMove(t)) stops.push({ t, pos });
      else pos = 0;
      let tt = t;
      const ev = [...ahead.stops.filter((s) => s.t > t).map((s) => ({ t: s.t + MOVE_UP, to: s.pos - 1 })), { t: ahead.release + 1, to: n - 1 }];
      for (const e of ev) {
        if (e.to <= pos) continue;
        const start = Math.max(tt + MOVE_UP, e.t);
        if (!canMove(start)) break;
        tt = start;
        pos = Math.min(n - 1, e.to);
        stops.push({ t: tt, pos });
      }
    }
    const parts: LotPart[] = [];
    let tc = p.arrive;
    for (const s of stops) {
      if (s.t > tc) parts.push({ kind: 'hold', t0: tc, t1: s.t, x: cur.x, z: cur.z, heading: 0, brake: true });
      tc = Math.max(tc, s.t);
      const to = { x: W.driveLaneX, z: zOf(s.pos) };
      const part: MovePart = { kind: 'move', t0: tc, t1: tc, spec: { pts: [cur, to], v: LANE_V, rev: false, dyn: { ...CAR_DYN, v0: 0, v1: 0 } } };
      part.t1 = tc + planPath(part).duration;
      parts.push(part);
      tc = part.t1;
      cur = to;
    }
    if (tc > h - SERVE_HOLD + 1 && h + 2 > tc - 1e-6) stats.serveMoved++;
    p.park = { x: cur.x, z: cur.z, heading: 0 };
    p.entry.push(...parts);
    p.arrive = tc;
    // 交付完（接过东西再等 3 秒）、前一辆走了才走
    p.leave = Math.max(st.leave, tc + 1, h + 3, ahead && ahead.release > tc ? ahead.release + 1 : 0);
    return stops;
  };

  const planExit = (i: number, p: CarPlan) => {
    const st = stays[i] as Stay;
    const m = p.model;
    const legs = exitLegs(st, m, p.mode, { x: p.park.x, z: p.park.z });
    // 停好以后才走（取货的车到得晚一点时，交付完的时刻往后顺）
    p.leave = Math.max(p.leave, p.arrive + 5);
    let r: ReturnType<typeof run> | undefined;
    let start = p.leave;
    const step = (d: number) => (d < 20 ? 2 : d < 120 ? 10 : 30);
    // 比登记的晚走：多停的这段时间车位里不能有别的车开过
    const reg = parkEntry[i];
    // 下一辆来停这个车位的（还没排）登记得比这辆实际走得早：先让开，排完挪到这辆开出去以后（它会等）
    const nextUp: Array<{ e: { a: number }; a: number }> = [];
    if (reg)
      for (const e of parked.get(cellKey(p.park.x, p.park.z)) ?? []) {
        if (e.id === i || plans[e.id] || e.b < p.leave || e.a === Infinity) continue;
        if (e.boxes.some((b) => reg.boxes.some((q) => boxesOverlap(b, q, 0.05, 0.05)))) {
          nextUp.push({ e, a: e.a });
          e.a = Infinity;
        }
      }
    const keep = (t: number) => !reg || t <= reg.b || stillFree(i, reg.boxes, reg.b, t);
    for (let d = 0; d <= 1800 && !r && keep(p.leave + d); d += step(d)) {
      const x = run(i, m, legs, p.leave + d, 0, p.park.tr, false);
      if (x.ok) {
        r = x;
        start = p.leave + d;
      }
    }
    if (!r && st.mode !== 'long' && st.mode !== 'drive') {
      // 换另一个门出去
      const alt = exitLegs(st, m, p.mode, { x: p.park.x, z: p.park.z }, true);
      for (let d = 0; d <= 1800 && !r && keep(p.leave + d); d += step(d)) {
        const x = run(i, m, alt, p.leave + d, 0, p.park.tr, false);
        if (x.ok) {
          r = x;
          start = p.leave + d;
        }
      }
    }
    if (!r) {
      stats.forced++;
      p.forced = true;
      r = run(i, m, legs, p.leave, 0, p.park.tr, true);
      start = p.leave;
    }
    p.leave = start;
    p.exit = r.parts;
    p.tOut = r.t;
    for (const n of nextUp) n.e.a = Math.max(n.a, r.t);
    stats.waits += r.waits;
    const e = parkEntry[i];
    if (e) {
      e.a = p.arrive;
      e.b = p.leave;
    }
  };

  // —— 排：先取货的车（时刻照门店仿真），再按时间排其余的车（进来、走） ——
  const order = stays.map((s, i) => ({ s, i }));
  const hard = order.filter(({ s }) => isPickup(s.visit.kind)).sort((a, b) => (a.s.enter ?? a.s.arrive) - (b.s.enter ?? b.s.arrive));
  const soft = order.filter(({ s }) => !isPickup(s.visit.kind));
  for (const { s, i } of hard) {
    const p = planEntry(i, true);
    let stops: Array<{ t: number; pos: number }> | undefined;
    if (s.mode === 'drive') {
      driveMouth = p.arrive;
      stops = driveLane(p, s);
    }
    commit(i, p.model, p.entry.slice(1));
    const e = parkEntry[i];
    if (e) e.a = p.arrive;
    if (s.mode === 'drive') commit(i, p.model, [{ kind: 'hold', t0: p.arrive, t1: p.leave, x: p.park.x, z: p.park.z, heading: 0, brake: false }]);
    plans[i] = p;
    planExit(i, p);
    commit(i, p.model, p.exit);
    if (stops) {
      // 车道里的位置在车开出去一个车身多（6.5 米）以后才空出来
      const q = { x: 0, z: 0, heading: 0, speed: 0, accel: 0, rev: false, brake: false } as Parameters<typeof planPose>[2];
      let release = p.leave + 5;
      for (let t = p.leave; t <= p.tOut; t += 0.5) {
        if (planPose(p, t, q) && Math.hypot(q.x - p.park.x, q.z - p.park.z) >= 6.5) {
          release = t + 0.5;
          break;
        }
      }
      lane.push({ stops, release });
    }
  }
  const events = [...soft.map(({ s, i }) => ({ t: s.arrive, i, kind: 'in' as const })), ...soft.map(({ s, i }) => ({ t: s.leave, i, kind: 'out' as const }))].sort((a, b) => a.t - b.t || (a.kind === 'out' ? -1 : 1) || a.i - b.i);
  for (const e of events) {
    if (e.kind === 'in') {
      const p = planEntry(e.i, false);
      commit(e.i, p.model, p.entry.slice(1));
      const pe = parkEntry[e.i];
      if (pe) {
        pe.a = p.arrive;
        const pp = parkPose(stays[e.i] as Stay, p.model, p.mode);
        if (pp) pe.boxes = boxesAt(p.model, pp.x, pp.z, pp.heading, p.park.tr);
      }
      plans[e.i] = p;
    } else {
      const p = plans[e.i];
      if (!p) continue;
      p.leave = Math.max(p.leave, p.arrive + 30);
      planExit(e.i, p);
      commit(e.i, p.model, p.exit);
    }
  }
  stats.dropped = plans.filter((p) => !p).length;

  // —— 进店路出去的那条车道：先进先出，到干道路口停止线前红灯就排队（车距 7.5 米）——
  const outs = plans.filter((p): p is CarPlan => !!p && p.exit.length > 0).sort((a, b) => a.tOut - b.tOut);
  const departs: number[] = [];
  const outPh = sig?.outPhase;
  const green = (t: number) => outPh === undefined || phaseClock(sig?.offset ?? 0, outPh, t) < GREEN;
  const nextGreen = (t: number) => {
    if (outPh === undefined) return t;
    const c = phaseClock(sig?.offset ?? 0, outPh, t);
    return c < GREEN ? t : t + (CYCLE - c);
  };
  const lanePart = (t0: number, z0: number, z1: number, v1: number | 'cap'): MovePart => {
    const part: MovePart = { kind: 'move', t0, t1: t0, spec: { pts: [{ x: -1.75, z: z0 }, { x: -1.75, z: z1 }], v: road.speed, rev: false, dyn: { accel: 1.5, decel: 2, v0: 0, v1 } } };
    part.t1 = t0 + planPath(part).duration;
    return part;
  };
  for (const p of outs) {
    const t0 = p.tOut;
    const free = lanePart(t0, zOutT, road.zStop, 'cap');
    const a = free.t1;
    const prev = departs[departs.length - 1] ?? -Infinity;
    if (green(a) && a >= prev + 2.2) {
      p.exit.push(free);
      p.tOut = a;
      departs.push(a);
      continue;
    }
    const n = departs.filter((d) => d > a).length;
    const zQ = Math.max(zOutT + 0.5, road.zStop - n * 7.5);
    const toQ = lanePart(t0, zOutT, zQ, 0);
    const goDur = planPath(lanePart(0, zQ, road.zStop, 'cap')).duration;
    // 前一辆走了 2.2 秒以后跟上；红灯就等下一个绿灯（第一辆起步慢 1.2 秒）
    let d = Math.max(prev + 2.2, toQ.t1 + goDur);
    if (!green(d)) d = nextGreen(d) + 1.2;
    p.exit.push(toQ);
    p.exit.push({ kind: 'hold', t0: toQ.t1, t1: d - goDur, x: -1.75, z: zQ, heading: 0, brake: true });
    p.exit.push(lanePart(d - goDur, zQ, road.zStop, 'cap'));
    p.tOut = d;
    departs.push(d);
  }
  return { plans, stats };
}

/** 线程之间传之前去掉算好的路径（主线程用到时再生成） */
/** 购物的顾客下车走开的时候车还没停好的车（第一段走路的起点比停好的时刻早） */
export function lateWalkers(plan: StayPlan, people: People, res: LotTraffic): number[] {
  const first = new Map<number, number>();
  for (const w of people.walks) first.set(w.id, Math.min(first.get(w.id) ?? Infinity, w.t0));
  const out: number[] = [];
  res.plans.forEach((p, i) => {
    const k = plan.stays[i]?.visit.kind;
    if (p && (k === 'shopper' || k === 'dept') && (first.get(i) ?? Infinity) < p.arrive) out.push(i);
  });
  return out;
}

/**
 * 人和停车场的车流一起排：先排一遍；停好的时刻晚过顾客下车走开的车换一个空着的车位（moveStay，顾客的路按新车位重排），
 * 人重排以后车流再排一遍（最多 rounds 轮）；还换不了的（停车场满着）顾客等车停好再下车、走快一点。
 * plan 里换过的车位就地改好；返回最后的人、车流和换过车位的车
 */
export function planSiteTraffic(lot: StoreLot, plan: StayPlan, seed: number, road: LotRoad, rounds = 3): { people: People; res: LotTraffic; moved: number[] } {
  let people = planPeople(lot, plan.stays, seed);
  let res = planLotTraffic(lot, plan, people, road);
  const moved: number[] = [];
  for (let k = 0; k < rounds; k++) {
    // 车流里每个车位实际停着车的时段（比车位安排的长：晚走、出场排队）
    const occ = new Map<number, Array<[number, number]>>();
    res.plans.forEach((p, i) => {
      const st = plan.stays[i];
      if (!p || !st || st.mode === 'drive' || st.mode === 'long') return;
      occ.set(st.stall, [...(occ.get(st.stall) ?? []), [p.arrive - 10, Math.max(p.leave, p.tOut) + 10]]);
    });
    const taken = (s: number, a: number, b: number) => (occ.get(s) ?? []).some(([x, y]) => x < b && a < y);
    const late = lateWalkers(plan, people, res).filter((i) => moveStay(lot, plan, i, taken));
    if (!late.length) break;
    moved.push(...late);
    people = planPeople(lot, plan.stays, seed);
    res = planLotTraffic(lot, plan, people, road);
  }
  // 停车场满着、换不了车位的：顾客等车停好再下车，走快一点（不超过 1.8 米 / 秒）赶进店的时刻，赶不上就晚几秒到门口；
  // 人的时刻改了，车流再排一遍（让行按新的时刻）
  for (let k = 0; k < 4; k++) {
    const still = lateWalkers(plan, people, res);
    if (!still.length) break;
    for (const i of still) {
      const p = res.plans[i];
      const w = people.walks.filter((x) => x.id === i).sort((a, b) => a.t0 - b.t0)[0];
      if (!p || !w) continue;
      const t0 = p.arrive + 3;
      w.t1 = Math.max(w.t1, t0 + Math.max(2, (w.cum[w.cum.length - 1] ?? 0) / 1.8));
      w.t0 = t0;
    }
    res = planLotTraffic(lot, plan, people, road);
  }
  return { people, res, moved };
}

export function stripPaths(res: LotTraffic): LotTraffic {
  for (const p of res.plans) if (p) for (const q of [...p.entry, ...p.exit]) if (q.kind === 'move') {
    delete q.path;
    delete q.chain;
  }
  return res;
}

/** 一辆车在 t 时的位姿（门店本地坐标）：在开、停着、停在车位上；不在这一段时间里返回 false */
export function planPose(p: CarPlan, t: number, out: { x: number; z: number; heading: number; speed: number; accel: number; rev: boolean; brake: boolean; tr?: { x: number; z: number; heading: number }; dist?: number }): boolean {
  if (t >= p.arrive && t < p.leave) {
    out.x = p.park.x;
    out.z = p.park.z;
    out.heading = p.park.heading;
    out.speed = 0;
    out.accel = 0;
    out.rev = false;
    out.brake = false;
    out.tr = p.park.tr;
    return true;
  }
  const parts = t < p.leave ? p.entry : p.exit;
  let part: LotPart | undefined;
  for (const q of parts) if (t >= q.t0 && t <= q.t1) part = q;
  if (!part) return false;
  out.tr = undefined;
  if (part.kind === 'hold') {
    out.x = part.x;
    out.z = part.z;
    out.heading = part.heading;
    out.speed = 0;
    out.accel = 0;
    out.rev = false;
    out.brake = part.brake;
    out.tr = part.tr;
    return true;
  }
  const path = planPath(part);
  const st: PathState = { x: 0, z: 0, heading: 0 };
  path.at(t - part.t0, st);
  out.x = st.x;
  out.z = st.z;
  out.heading = st.heading;
  out.speed = st.speed ?? 0;
  out.accel = st.accel ?? 0;
  out.rev = path.reverse;
  out.brake = (st.accel ?? 0) < -0.4;
  out.dist = st.dist;
  const ch = planChain(part);
  if (ch) {
    const lead = { x: 0, z: 0, heading: 0 };
    const u = [{ x: 0, z: 0, heading: 0 }];
    ch.at(st.dist ?? 0, lead, u);
    out.tr = { ...(u[0] as { x: number; z: number; heading: number }) };
  }
  return true;
}

/**
 * 检查（测试用）：在预约表的 0.5 秒格点上取所有车在停车场里的位置（不算进店路），数一数两辆车重叠的次数、
 * 车开过正在过斑马线的人的次数。shrink 是矩形往里缩的米数（模型的圆角、后视镜不算）。
 */
export function lotConflicts(lot: StoreLot, res: LotTraffic, people: People, step = 0.5, shrink = 0.12, limit = 12): { carCar: number; carPed: number; samples: number; pairs: string[] } {
  const zLot = lot.frontage.z + lot.frontage.half + 1;
  const plans = res.plans.filter((p): p is CarPlan => !!p);
  const t0 = Math.ceil(Math.min(...plans.map((p) => p.tIn)) / step) * step;
  const t1 = Math.max(...plans.map((p) => p.tOut));
  let carCar = 0;
  let carPed = 0;
  let samples = 0;
  const pairs: string[] = [];
  const pose = { x: 0, z: 0, heading: 0, speed: 0, accel: 0, rev: false, brake: false } as Parameters<typeof planPose>[2];
  const active = plans.map((p) => ({ p, a: p.tIn, b: p.tOut })).sort((x, y) => x.a - y.a);
  const walks = [...people.walks].sort((a, b) => a.t0 - b.t0);
  // 扫描线：只看这一刻在场的车、在走的人
  let live: typeof active = [];
  let liveW: typeof walks = [];
  let nc = 0;
  let nw = 0;
  for (let t = t0; t <= t1; t += step) {
    while (nc < active.length && (active[nc] as (typeof active)[number]).a <= t) live.push(active[nc++] as (typeof active)[number]);
    while (nw < walks.length && (walks[nw] as (typeof walks)[number]).t0 <= t) liveW.push(walks[nw++] as (typeof walks)[number]);
    live = live.filter((e) => e.b >= t);
    liveW = liveW.filter((w) => w.t1 >= t);
    const boxes: Array<{ id: number; b: Box; moving: boolean }> = [];
    for (const e of live) {
      if (!planPose(e.p, t, pose) || pose.z > zLot) continue;
      const m = e.p.model;
      const moving = pose.speed > 0.05;
      boxes.push({ id: e.p.i, b: mkBox(pose.x, pose.z, pose.heading, m.len - 2 * shrink, m.wid - 2 * shrink), moving });
      if (m.trailer) {
        const tr = pose.tr ?? { x: pose.x - Math.sin(pose.heading) * (m.trailer.hitch + m.trailer.tongue), z: pose.z - Math.cos(pose.heading) * (m.trailer.hitch + m.trailer.tongue), heading: pose.heading };
        const c = m.trailer.len / 2 - m.trailer.axleX;
        boxes.push({ id: e.p.i, b: mkBox(tr.x + Math.sin(tr.heading) * c, tr.z + Math.cos(tr.heading) * c, tr.heading, m.trailer.len - 2 * shrink, m.trailer.wid - 2 * shrink), moving });
      }
    }
    samples++;
    for (let i = 0; i < boxes.length; i++)
      for (let k = i + 1; k < boxes.length; k++) {
        const a = boxes[i] as { id: number; b: Box };
        const b = boxes[k] as { id: number; b: Box };
        if (a.id === b.id) continue;
        if (boxesOverlap(a.b, b.b)) {
          carCar++;
          if (pairs.length < limit) pairs.push(`${a.id}-${b.id}@${t}`);
        }
      }
    for (const w of liveW) {
      const q = walkAt(w, t);
      if (!lot.crossings.some((c) => Math.abs(q.x - c.x) <= c.w / 2 && Math.abs(q.z - c.z) <= c.d / 2)) continue;
      for (const bx of boxes) if (bx.moving && bx.id !== w.id && pointIn(bx.b, q.x, q.z, 0.25, 0.25)) carPed++;
    }
  }
  return { carCar, carPed, samples, pairs };
}
