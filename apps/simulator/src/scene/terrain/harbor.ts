import { createRng } from '@storewright/domain';
import { PathChain, TimedPath, type PathLike, type PathState, type Pt } from '../lot';
import { fillet } from '../yard';
import { harborSdf, type Boat, type WaterPlan } from './waterPlan';
import type { BoatKind } from '../vehicles/boats';

/**
 * 船只进出港（决策记录 0019、0020）：栈桥边的快艇、小帆船早上出海、下午回港（船只多时一天两趟）；浮筒船白天在湖里兜圈；
 * 海上来的访客船经出海水道进湖兜一圈再出去；海湾里有经过的船（不进港）。
 * 出海的航线：离开泊位（系在栈桥两侧、船头朝岸的船先倒出来、原地掉头）→ 绕过栈桥的 T 形平台 → 穿过湖 →
 * 出海水道（低速、不起浪，进出各走右侧的一边）→ 两道防波堤之间 → 海湾里加速 → 驶出场地边缘；回港是反过来，
 * 最后船头朝岸慢慢靠上泊位。同一片水域（湖里、水道的每一边、海湾）同一时间只排一条船（经过海湾的船按方向分两条航道），
 * 按画面最大拉长倍数检查，任何播放速度下都不会撞上。
 * 按仿真时刻（当天的秒数）确定，可以拖动时间轴。划艇和皮划艇一直系在栈桥边。纯函数，只依赖水系。
 */

/** 船只多少（周边环境设置） */
export type BoatTraffic = 'few' | 'normal' | 'many';

/** 每一档的当天安排：栈桥出海船每条跑几趟、浮筒船兜几圈、海上来的访客船几条、海湾里经过的船几条 */
export const BOAT_TRAFFIC: Record<BoatTraffic, { trips: number; cruises: number; visitors: number; passers: number; anglers: number }> = {
  few: { trips: 1, cruises: 1, visitors: 1, passers: 4, anglers: 0 },
  normal: { trips: 1, cruises: 2, visitors: 3, passers: 16, anglers: 2 },
  many: { trips: 2, cruises: 4, visitors: 8, passers: 48, anglers: 3 },
};

/** 出海水道里离中线的距离（米）：出海的走一边、回港的走另一边（各自靠右） */
export const CHANNEL_LANE = 3;
/** 画面最大拉长倍数（和 Lakeside 里的上限一致）：回港、下一趟出发的间隔按它留 */
const MAX_STRETCH = 12;
/** 排程时检查的画面拉长倍数（1 倍到最大）与行驶中的船之间至少要隔开的距离（米） */
const STRETCH_CHECK = [1, 2, 4, 7.5, 12];
const MIN_GAP = 6;
/** 预先取样的步长（秒，按路径时间） */
const SAMPLE_DT = 0.25;

export interface BoatLeg {
  /** 栈桥边的哪条船（pier.boats 的下标）；访客船、经过的船为 −1 */
  berth: number;
  kind: 'out' | 'in' | 'cruise' | 'visit' | 'pass' | 'anchor';
  start: number;
  path: PathLike;
  /** 往前开的那一段（尾迹沿它画）与它在这一程里的起点（秒） */
  forward: TimedPath;
  forwardAt: number;
}

/** 原地掉头：位置不动，船头从 h0 平滑转到 h1 */
class PivotPath implements PathLike {
  constructor(
    private readonly p: Pt,
    private readonly h0: number,
    private readonly h1: number,
    readonly duration: number,
  ) {}
  at(tau: number, out: PathState): void {
    const k = Math.min(1, Math.max(0, tau / this.duration));
    const e = k * k * (3 - 2 * k);
    let d = this.h1 - this.h0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out.x = this.p.x;
    out.z = this.p.z;
    out.heading = this.h0 + d * e;
    out.speed = 0;
    out.accel = 0;
    out.lat = 0;
    out.steer = 0;
  }
}

/** 没有泊位的船：海上来的访客船、海湾里经过的船（只在自己那一程里出现） */
export interface Visitor {
  kind: BoatKind;
  color: string;
  leg: BoatLeg;
}

export interface BoatSchedule {
  legs: BoatLeg[];
  /** 每条船不在泊位上的时段：从 from 到 to 之后再走完最后一程（tail 秒；高倍速播放时按画面拉长） */
  away: Map<number, Array<{ from: number; to: number; tail: number }>>;
  visitors: Visitor[];
}

const BOAT_DYN = { accel: 0.5, decel: 0.45, lat: 0.8, wheelbase: 2.2 };

/** 船速（米/秒）：离泊位近时很慢，湖里 3，出海水道 2.2（不起浪），海湾里滑行 6.5 */
function boatSpeed(w: WaterPlan, berth: Pt) {
  const o = w.outlet;
  return (a: Pt, b: Pt): number => {
    const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    if (Math.hypot(m.x - berth.x, m.z - berth.z) < 9) return 1.1;
    if (o && m.z < o.z0 - 6) return 6.5;
    if (o && m.z < o.z1 + 4) return 2.2;
    return 3;
  };
}

/** 泊位在栈桥两侧（船头朝岸）还是在 T 形平台外侧；离开 / 靠上泊位时在栈桥外侧走的那条线 */
function berthInfo(w: WaterPlan, b: Boat): { side: number; alongPier: boolean; xOut: number; headZ: number; f: Pt } {
  const p = w.pier;
  return { side: b.x < p.x ? -1 : 1, alongPier: Math.abs(Math.sin(b.heading)) < 0.5, xOut: p.x + (b.x < p.x ? -1 : 1) * (p.head.w / 2 + 5), headZ: p.zEnd - p.head.d - 6, f: { x: Math.sin(b.heading), z: Math.cos(b.heading) } };
}

/** 离开泊位：栈桥两侧的船先倒出 3.5 米、原地掉头；T 形平台外侧的船直接往前开出去。返回倒车段和往前开的起点 */
function departure(w: WaterPlan, b: Boat): { back?: Pt[]; forward: Pt[] } {
  const k = berthInfo(w, b);
  if (k.alongPier) {
    const p0 = { x: b.x, z: b.z - 3.5 };
    return { back: [{ x: b.x, z: b.z }, p0], forward: [p0, { x: k.xOut, z: b.z - 9 }, { x: k.xOut, z: k.headZ }] };
  }
  return { forward: [{ x: b.x, z: b.z }, { x: b.x + k.f.x * 4, z: b.z + k.f.z * 4 }, { x: b.x + k.f.x * 7, z: k.headZ }] };
}

/** 靠上泊位：栈桥两侧的船从外侧那条线拐进来、最后两米船头朝岸直着靠上；T 形平台外侧的船顺着平台靠上 */
function arrival(w: WaterPlan, b: Boat): Pt[] {
  const k = berthInfo(w, b);
  if (k.alongPier) return [{ x: k.xOut, z: k.headZ }, { x: k.xOut, z: b.z - 9 }, { x: b.x + k.side * 1.0, z: b.z - 4.5 }, { x: b.x, z: b.z - 2 }, { x: b.x, z: b.z }];
  return [{ x: b.x - k.f.x * 9, z: k.headZ - 2 }, { x: b.x - k.f.x * 4.5, z: b.z - k.f.z * 4.5 }, { x: b.x, z: b.z }];
}

/** 湖里水道口 → 出海水道（离中线 lane 米的那一边）→ 防波堤之间 → 海湾 → 场地边缘外 */
function toSea(w: WaterPlan, drift: number, lane = CHANNEL_LANE): Pt[] {
  const o = w.outlet;
  if (!o) return [];
  const mouth = Math.min(...o.jetties.map((j) => j.z0));
  const x = o.x + lane;
  return [
    { x, z: o.z1 + 9 },
    { x, z: (o.z0 + o.z1) / 2 },
    { x, z: mouth - 3 },
    { x: x + drift * 0.5, z: o.bay.cz + o.bay.rz * 0.35 },
    { x: x + drift, z: w.minZ - 8 },
  ];
}

/** 从海上回来：场地边缘外 → 海湾 → 出海水道（回港的那一边）→ 湖里水道口 */
function fromSea(w: WaterPlan, drift: number): Pt[] {
  return [...toSea(w, drift, -CHANNEL_LANE)].reverse();
}

/** 湖里兜一圈（浮筒船载客游湖）：沿湖心的椭圆，离岸、离栈桥都留出余量 */
function lakeLoop(w: WaterPlan): Pt[] {
  const l = w.lake;
  const cz = l.cz - 0.12 * l.rz;
  let ax = 0.5 * l.rx;
  let az = Math.min(0.36 * l.rz, w.pier.zEnd - w.pier.head.d - 8 - cz);
  for (let k = 0; k < 8; k++) {
    let ok = true;
    for (let i = 0; i < 48 && ok; i++) {
      const a = (i / 48) * Math.PI * 2;
      if (harborSdf(w, l.cx + ax * Math.cos(a), cz + az * Math.sin(a)) < 7) ok = false;
    }
    if (ok) break;
    ax *= 0.88;
    az *= 0.88;
  }
  const pts: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = Math.PI / 2 - (i / 24) * Math.PI * 2;
    pts.push({ x: l.cx + Math.max(6, ax) * Math.cos(a), z: cz + Math.max(4, az) * Math.sin(a) });
  }
  return pts;
}

function boatPath(w: WaterPlan, pts: Pt[], berth: Pt, docking: 'start' | 'end' | 'both'): TimedPath {
  return new TimedPath(fillet(pts, 6, 8), boatSpeed(w, berth), false, { ...BOAT_DYN, v0: docking === 'end' ? 'cap' : 0, v1: docking === 'start' ? 'cap' : 0 });
}

/** 一程：离开泊位（必要时倒出、掉头）+ 往前开的航线 */
function legFrom(w: WaterPlan, b: Boat, route: Pt[], docking: 'start' | 'both'): { path: PathLike; forward: TimedPath; forwardAt: number } {
  const dep = departure(w, b);
  const forward = boatPath(w, [...dep.forward, ...route], b, docking);
  if (!dep.back) return { path: forward, forward, forwardAt: 0 };
  // 倒出泊位（船头仍朝岸），停一下，原地掉头对准往前开的方向
  const back = new TimedPath(dep.back, () => 0.7, true, { ...BOAT_DYN, v0: 0, v1: 0 });
  const st: PathState = { x: 0, z: 0, heading: 0 };
  forward.at(0.5, st);
  const p0 = dep.back[dep.back.length - 1] as Pt;
  const pivot = new PivotPath(p0, b.heading, Math.atan2(st.x - p0.x, st.z - p0.z), 9);
  return { path: new PathChain([back, 1.5, pivot, forward]), forward, forwardAt: back.duration + 1.5 + 9 };
}

/** 一程按路径时间预先取样的位置（排程时查表，不必每次重算路径） */
interface Track {
  start: number;
  duration: number;
  xs: Float32Array;
  zs: Float32Array;
}

function sampleTrack(path: PathLike): Omit<Track, 'start'> {
  const n = Math.floor(path.duration / SAMPLE_DT) + 1;
  const xs = new Float32Array(n);
  const zs = new Float32Array(n);
  const st: PathState = { x: 0, z: 0, heading: 0 };
  for (let i = 0; i < n; i++) {
    path.at(Math.min(path.duration, i * SAMPLE_DT), st);
    xs[i] = st.x;
    zs[i] = st.z;
  }
  return { duration: path.duration, xs, zs };
}

/**
 * 已经排好的各程。新的一程只有在任何画面拉长倍数（1–12 倍）下、和所有同时在走的船都隔开 MIN_GAP 米时才排进去；
 * 两条船都在场地边缘以外（看不见）时不算。
 */
class WaterTraffic {
  private readonly placed: Track[] = [];
  constructor(private readonly minZ: number) {}
  private clear(c: Track): boolean {
    for (const q of this.placed) {
      for (const f of STRETCH_CHECK) {
        const a0 = Math.max(c.start, q.start);
        const a1 = Math.min(c.start + c.duration * f, q.start + q.duration * f);
        if (a1 <= a0) continue;
        for (let T = a0; T <= a1; T += SAMPLE_DT * f) {
          const i = Math.min(c.xs.length - 1, Math.round((T - c.start) / f / SAMPLE_DT));
          const j = Math.min(q.xs.length - 1, Math.round((T - q.start) / f / SAMPLE_DT));
          const cz = c.zs[i] as number;
          const qz = q.zs[j] as number;
          if (cz < this.minZ - 2 && qz < this.minZ - 2) continue;
          if (Math.hypot((c.xs[i] as number) - (q.xs[j] as number), cz - qz) < MIN_GAP) return false;
        }
      }
    }
    return true;
  }
  /** 从 desired 起每分钟往后找第一个不会和别的船挤在一起的出发时刻（最晚 latest）；找不到时返回 undefined（这一程不排） */
  place(desired: number, latest: number, path: PathLike): number | undefined {
    const tr = sampleTrack(path);
    for (let t = Math.round(desired); t <= latest; t += 60) {
      const c = { ...tr, start: t };
      if (this.clear(c)) {
        this.placed.push(c);
        return t;
      }
    }
    return undefined;
  }
}

const VISITOR_COLORS = ['#f2f2ee', '#26354f', '#c8453f', '#2f8f8f', '#e0a42f', '#3f7fb8', '#5a6b3a'];

/** 海上来的访客船：从场地边缘外进海湾 → 水道（回港的一边）→ 湖里兜一圈 → 水道（出海的一边）→ 海湾 → 驶出场地 */
function visitPath(w: WaterPlan, driftIn: number, driftOut: number): TimedPath {
  const loop = lakeLoop(w);
  // 从湖心椭圆上离水道最近的点开始兜一圈
  const o = w.outlet as NonNullable<WaterPlan['outlet']>;
  let k = 0;
  loop.forEach((p, i) => {
    if (Math.hypot(p.x - o.x, p.z - o.z1) < Math.hypot((loop[k] as Pt).x - o.x, (loop[k] as Pt).z - o.z1)) k = i;
  });
  const ring = [...loop.slice(k), ...loop.slice(1, k + 1)];
  const far = { x: 1e6, z: 1e6 };
  return new TimedPath(fillet([...fromSea(w, driftIn), ...ring, ...toSea(w, driftOut)], 6, 8), boatSpeed(w, far), false, { ...BOAT_DYN, v0: 'cap', v1: 'cap' });
}

/** 海湾里经过的船：从场地边缘外驶进海湾，沿离岸的航道横穿海湾，再驶出场地边缘（不进港）；向东、向西各一条航道 */
function passPath(w: WaterPlan, east: boolean, kind: BoatKind): TimedPath {
  const o = w.outlet as NonNullable<WaterPlan['outlet']>;
  const b = o.bay;
  const z = b.cz + (east ? 5 : 11);
  const sgn = east ? 1 : -1;
  const pts: Pt[] = [
    { x: b.cx - sgn * b.rx * 0.8, z: w.minZ - 14 },
    { x: b.cx - sgn * b.rx * 0.6, z },
    { x: b.cx + sgn * b.rx * 0.6, z },
    { x: b.cx + sgn * b.rx * 0.8, z: w.minZ - 14 },
  ];
  const v = kind === 'sail' ? 4.2 : 6.8;
  return new TimedPath(fillet(pts, 14, 8), () => v, false, { ...BOAT_DYN, v0: 'cap', v1: 'cap' });
}

/**
 * 钓鱼船：从场地边缘外驶进海湾，在两侧离岸、离航道都远的地方停下（下锚）钓鱼，过一阵再驶出场地。
 * 停着的那段没有尾迹；尾迹沿驶离的那一段画。
 */
/** 钓鱼船的停泊位（海湾的比例坐标）：离岸、离出海航线、防波堤和经过的船的航道都有余量；东侧靠近防波堤只留一个 */
export const ANCHOR_SPOTS: ReadonlyArray<{ fx: number; dz: number }> = [
  { fx: -0.7, dz: 17 },
  { fx: 0.7, dz: 17 },
  { fx: -0.48, dz: 25 },
];

function anchorLeg(w: WaterPlan, slot: number, hold: number): { path: PathLike; forward: TimedPath; forwardAt: number } {
  const o = w.outlet as NonNullable<WaterPlan['outlet']>;
  const b = o.bay;
  const a = ANCHOR_SPOTS[slot % ANCHOR_SPOTS.length] as (typeof ANCHOR_SPOTS)[number];
  const spot = { x: b.cx + a.fx * b.rx, z: b.cz + a.dz };
  // 从正下方驶进来，离开时偏向海湾中间再驶出场地（不从别的停泊位旁边擦过）
  const toMid = a.fx < 0 ? 1 : -1;
  const come = new TimedPath(fillet([{ x: spot.x + 4, z: w.minZ - 12 }, { x: spot.x + 3, z: spot.z - 10 }, spot], 8, 8), () => 3.2, false, { ...BOAT_DYN, v0: 'cap', v1: 0 });
  const leave = new TimedPath(
    fillet([spot, { x: spot.x + toMid * 5, z: spot.z - 8 }, { x: spot.x + toMid * 9, z: w.minZ - 12 }], 8, 8),
    () => 4.5,
    false,
    { ...BOAT_DYN, v0: 0, v1: 'cap' },
  );
  return { path: new PathChain([come, hold, leave]), forward: leave, forwardAt: come.duration + hold };
}

/** 当天的船只时刻表（同一水系、同一种子、同一档船只多少总是同一张表） */
export function planBoats(w: WaterPlan, seed: number, traffic: BoatTraffic = 'normal'): BoatSchedule {
  const legs: BoatLeg[] = [];
  const away = new Map<number, Array<{ from: number; to: number; tail: number }>>();
  const visitors: Visitor[] = [];
  if (!w.enabled || !w.outlet) return { legs, away, visitors };
  const plan = BOAT_TRAFFIC[traffic];
  const rng = createRng(seed * 3301 + 17);
  const water = new WaterTraffic(w.minZ);
  const boats = w.pier.boats;
  const mark = (berth: number, from: number, to: number, tail: number) => away.set(berth, [...(away.get(berth) ?? []), { from, to, tail }]);
  const H = 3600;
  // 出海的船：快艇、小帆船。一趟时早上出、下午回；两趟时上午、下午各一趟。出发、回港时刻有起伏，水域被占时往后顺延
  const seaGoing = boats.map((b, i) => ({ b, i })).filter(({ b }) => b.kind === 'motor' || b.kind === 'sail');
  const tripTimes = (k: number, j: number): [number, number] =>
    plan.trips === 1
      ? [8 + k * 1.3 + rng.uniform(-0.6, 0.6), 16 + k * 1.1 + rng.uniform(-0.8, 0.8)]
      : j === 0
        ? [7.4 + k * 0.9 + rng.uniform(-0.3, 0.3), 10.8 + k * 0.8 + rng.uniform(-0.3, 0.3)]
        : [13.2 + k * 0.9 + rng.uniform(-0.3, 0.3), 17 + k * 0.8 + rng.uniform(-0.4, 0.4)];
  for (let j = 0; j < plan.trips; j++) {
    seaGoing.forEach(({ b, i }, k) => {
      const drift = (k % 2 === 0 ? -1 : 1) * rng.uniform(6, 16);
      const [hOut, hBack] = tripTimes(k, j);
      const out = legFrom(w, b, toSea(w, drift), 'start');
      const back = boatPath(w, [...fromSea(w, drift), ...arrival(w, b)], b, 'end');
      const prevBack = (away.get(i) ?? []).at(-1);
      const earliest = prevBack ? prevBack.to + prevBack.tail * MAX_STRETCH + 45 * 60 : 0;
      const tOut = water.place(Math.max(earliest, hOut * H), Math.max(earliest, hOut * H) + 2 * H, out.path);
      if (tOut === undefined) return;
      const tBack = water.place(Math.max(hBack * H, tOut + out.path.duration * MAX_STRETCH + H), Math.max(hBack * H, tOut + out.path.duration * MAX_STRETCH + H) + 3 * H, back);
      if (tBack === undefined) return;
      legs.push({ berth: i, kind: 'out', start: tOut, ...out });
      legs.push({ berth: i, kind: 'in', start: tBack, path: back, forward: back, forwardAt: 0 });
      mark(i, tOut, tBack, back.duration);
    });
  }
  // 浮筒船：在湖里兜圈（少 1 圈、一般 2 圈、多 4 圈）
  const cruiseHours = plan.cruises === 1 ? [14.6] : plan.cruises === 2 ? [10.8, 14.6] : Array.from({ length: plan.cruises }, (_, k) => 10 + (k * 7.5) / Math.max(1, plan.cruises - 1));
  boats.forEach((b, i) => {
    if (b.kind !== 'pontoon') return;
    const route = [...lakeLoop(w), ...arrival(w, b)];
    for (const h0 of cruiseHours) {
      const leg = legFrom(w, b, route, 'both');
      const t = water.place((h0 + rng.uniform(-0.3, 0.3)) * H, (h0 + 1.5) * H, leg.path);
      if (t === undefined) continue;
      legs.push({ berth: i, kind: 'cruise', start: t, ...leg });
      mark(i, t, t, leg.path.duration);
    }
  });
  // 海上来的访客船：进湖兜一圈再出去，白天错开
  for (let v = 0; v < plan.visitors; v++) {
    const kind: BoatKind = rng.chance(0.5) ? 'sail' : 'motor';
    const path = visitPath(w, rng.uniform(-14, 14), rng.uniform(-14, 14));
    const h0 = 9.5 + (8.5 * (v + 0.5)) / plan.visitors + rng.uniform(-0.4, 0.4);
    const t = water.place(h0 * H, (h0 + 2) * H, path);
    if (t === undefined) continue;
    visitors.push({ kind, color: rng.pick(VISITOR_COLORS), leg: { berth: -1, kind: 'visit', start: t, path, forward: path, forwardAt: 0 } });
  }
  // 海湾里经过的船：白天从早到晚错开，向东、向西交替各走一条航道；船只多时帆船常常三两成群（一条跟着一条）
  for (let v = 0; v < plan.passers; ) {
    const kind: BoatKind = rng.chance(0.45) ? 'sail' : 'motor';
    const east = rng.chance(0.5);
    const group = traffic === 'many' && kind === 'sail' && rng.chance(0.35) ? rng.int(2, 3) : 1;
    const h0 = 7.6 + (12 * (v + 0.5)) / plan.passers + rng.uniform(-0.25, 0.25);
    let t0 = h0 * H;
    for (let g = 0; g < group && v < plan.passers; g++, v++) {
      const path = passPath(w, east, kind);
      const t = water.place(t0, t0 + 1.2 * H, path);
      if (t === undefined) continue;
      visitors.push({ kind, color: rng.pick(VISITOR_COLORS), leg: { berth: -1, kind: 'pass', start: t, path, forward: path, forwardAt: 0 } });
      t0 = t + 60;
    }
  }
  // 钓鱼船：海湾两侧各停一阵（40–75 分钟），白天错开来
  for (let v = 0; v < plan.anglers; v++) {
    const leg = anchorLeg(w, v, rng.uniform(40, 75) * 60);
    const h0 = 7 + (6 * (v + 0.5)) / plan.anglers + rng.uniform(-0.5, 0.5);
    const t = water.place(h0 * H, (h0 + 2) * H, leg.path);
    if (t === undefined) continue;
    visitors.push({ kind: 'motor', color: rng.pick(VISITOR_COLORS), leg: { berth: -1, kind: 'anchor', start: t, ...leg } });
  }
  legs.sort((a, c) => a.start - c.start);
  visitors.sort((a, c) => a.leg.start - c.leg.start);
  return { legs, away, visitors };
}

/** 访客船此刻在哪（不在场地里时返回 undefined）；out 里写入位置、朝向、速度 */
export function visitorAt(v: Visitor, t: number, out: PathState, f = 1): number | undefined {
  const leg = v.leg;
  if (t < leg.start || t > leg.start + leg.path.duration * f) return undefined;
  const tau = (t - leg.start) / f;
  leg.path.at(tau, out);
  return tau;
}

/**
 * 时刻 t 正在走的航段（没有时返回 undefined）；out 里写入位置、朝向、速度。
 * f：画面拉长倍数（高倍速播放时一程按 f 倍的仿真时间走完，看得清；与车辆进出场一样）
 */
export function boatAt(s: BoatSchedule, berth: number, t: number, out: PathState, f = 1): { leg: BoatLeg; tau: number } | undefined {
  for (const leg of s.legs) {
    if (leg.berth !== berth || t < leg.start || t > leg.start + leg.path.duration * f) continue;
    const tau = (t - leg.start) / f;
    leg.path.at(tau, out);
    return { leg, tau };
  }
  return undefined;
}

/** 这条船此刻在不在泊位上（出海、兜圈期间不在） */
export function atBerth(s: BoatSchedule, berth: number, t: number, f = 1): boolean {
  return !(s.away.get(berth) ?? []).some((a) => t >= a.from && t <= a.to + a.tail * f);
}

/** 沿路径往回 d 米处的位置（尾迹用） */
export function pathPointAt(path: TimedPath, d: number): Pt & { heading: number } {
  const cum = path.cumD;
  const pts = path.pts;
  const dd = Math.min(cum[cum.length - 1] ?? 0, Math.max(0, d));
  let lo = 1;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) < dd) lo = mid + 1;
    else hi = mid;
  }
  const a = pts[lo - 1] as Pt;
  const b = pts[lo] as Pt;
  const seg = (cum[lo] as number) - (cum[lo - 1] as number);
  const k = seg > 1e-9 ? (dd - (cum[lo - 1] as number)) / seg : 0;
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, heading: Math.atan2(b.x - a.x, b.z - a.z) };
}
