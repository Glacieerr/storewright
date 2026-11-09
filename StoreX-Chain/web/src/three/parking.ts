import * as THREE from 'three';
import { box, cyl, merge, type Part } from '../../../../StoreX/web/src/three/models';
import { currentRegion } from '../../../src/region/network';
import { FRAMES, RAIL, REGION, type Km } from '../../../src/region/region';
import { footprintKm, type Frame } from '../../../src/region/frames';
import { CORES, LOCAL } from '../../../src/region/regionGen';
import { bezier, cumulative, GeoBuilder, pointInPoly, polyDist, rand, sampleAt, SegGrid, v3, type V3 } from './geo';
import { halfAll, S, type Line, type RoadNet } from './roadnet';
import type { Site } from './stores';

/**
 * 停车场。每个区域都配：港口和机场货运区（员工停车场、货车等候区）、物流园（员工停车场，配送中心、冷链中心和中央面包房共用）、
 * 城市客运站（停车场）、城区（几处公共停车场）；综合店的顾客停车场是门店模型自带的（第二部分的顾客车流在那里停车、取货）。
 *
 * 停车场摆在附近道路的一侧（不压路、不下海、不进设施的核心区和门店、离铁路、河、路口远一点），从路上开一个 T 形路口，
 * 一小段进出场的路接到场口；员工停车场和货车等候区的场口有岗亭、道闸。按第一部分（Storewright）停车场的做法：
 * - 进出分道：场口一进一出两条车道，中间一道绿化分隔岛（岗亭在岛上），出口车道在场口前有停车线，出场的车停下看清再并上路；
 * - 场内单向环形通道，靠右行驶：从场口进去沿右侧开到底，掉头沿另一侧开回场口出去；通道上画行车方向箭头；
 * - 小车位 2.5 × 5.3 米（按公开资料：垂直车位 2.4 × 5.3 米、倒车出位的通道不小于 5.5 米，这里通道 6.5 米）：
 *   通道两侧各一排（车头朝里停，走的时候先倒出来），中间是背靠背的两排；中间那两排每四列有一列是「穿过停」的长车位
 *  （从进场一侧的通道开进去、穿过去车头朝外停，走的时候直接往前开到出场一侧的通道，不用倒车）；
 * - 离场口最近的车位是无障碍车位（蓝底、旁边一条斜线的轮椅通道），旁边两个是充电车位（绿底、充电桩）；
 * - 中间两排的两头是种了树的端岛，端岛上立灯杆，场地四周也有灯杆；
 * - 货车位（4.4 × 18 米）在中间，从进场一侧的通道开进去、往前开到出场一侧的通道出来，不用倒车。
 * 背景车流在这些车位、出区域的高速口之间往来（traffic.ts）。
 */
export type LotUse = 'staff' | 'hold' | 'public' | 'station' | 'home';
export interface Bay {
  /** 停好时车头的位置、车头朝向（atan2(dz, dx)） */
  p: V3;
  dir: number;
  /** 从场口沿通道开到车位、拐进去停好的路（车头的轨迹，从场口外的进场车道接过来） */
  park: V3[];
  /** 小车离开时先沿 back 倒出车位（倒着走，车头朝向不变）；货车没有 */
  back: V3[];
  /** 再沿 out 开到场口（接出场车道） */
  out: V3[];
}
export interface Lot {
  id: string;
  name: string;
  use: LotUse;
  truck: boolean;
  /** 场口：进出场的路的尽头（道路网里的路口），车在这里离开道路网 */
  gate: string;
  line: number;
  bays: Bay[];
  outline: { x: number; z: number }[];
  /** 道闸（员工停车场、货车等候区）：岗亭的位置和场的朝向 */
  barrier?: { p: V3; dir: number };
  /** 场内的环形通道（从进场一侧的场地边开进去、绕到出场一侧的场地边）：满了的车绕一圈找车位 */
  loop?: V3[];
  /** 每小时的占用率（0–1） */
  occ: number[];
  /** 场地的坐标系（画场口的分隔岛、标线用）：场口在 o，沿 d 伸进去，n 是右手边；L 是场地长度、half 是半宽 */
  frame?: { o: V3; d: { x: number; z: number }; n: { x: number; z: number }; L: number; half: number; n0: number; through: number[] };
}

/** 每小时的占用率：三班倒的员工停车场白天满、夜里留夜班；客运站白天；城区夜里是住户的车，白天是上班、办事的车；
 * 小区停车场夜里满、白天空一大半（住户早上开车出门、晚上回来，见 traffic.ts 的通勤） */
const OCC: Record<LotUse, number[]> = {
  staff: [0.38, 0.38, 0.38, 0.38, 0.38, 0.42, 0.58, 0.82, 0.88, 0.88, 0.88, 0.86, 0.84, 0.86, 0.88, 0.86, 0.72, 0.6, 0.56, 0.54, 0.52, 0.5, 0.46, 0.4],
  hold: [0.3, 0.25, 0.25, 0.25, 0.3, 0.45, 0.6, 0.7, 0.75, 0.75, 0.7, 0.7, 0.7, 0.7, 0.72, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3],
  public: [0.62, 0.62, 0.6, 0.6, 0.6, 0.58, 0.52, 0.5, 0.6, 0.72, 0.8, 0.84, 0.86, 0.84, 0.82, 0.8, 0.78, 0.76, 0.74, 0.72, 0.7, 0.68, 0.66, 0.64],
  station: [0.12, 0.1, 0.1, 0.1, 0.12, 0.2, 0.42, 0.68, 0.82, 0.86, 0.86, 0.84, 0.82, 0.82, 0.82, 0.8, 0.74, 0.66, 0.56, 0.46, 0.36, 0.28, 0.2, 0.15],
  home: [0.88, 0.88, 0.88, 0.88, 0.88, 0.86, 0.8, 0.6, 0.45, 0.4, 0.38, 0.38, 0.4, 0.4, 0.4, 0.42, 0.5, 0.62, 0.74, 0.8, 0.84, 0.86, 0.87, 0.88],
};

/**
 * 尺寸（米）：小车场横向 −17.2…17.2：外侧车位（5.3）、进场通道（6.5）、中间背靠背两排（2 × 5.3）、出场通道（6.5）、外侧车位（5.3）；
 * 通道中心离中线 aisle 米；货车场 −21…21
 */
const CAR = { half: 17.2, aisle: 8.55, bay: 2.5, depth: 5.3, entry: 7, far: 12, r: 4.5 };
const TRUCK = { half: 21, aisle: 13, bay: 4.4, entry: 10, far: 20, r: 9 };
/** 场地边离路中心多远（路的半宽以外）、场口（进出场的路的尽头）在场地外多远、道闸在哪 */
const SET_BACK = 26;
const GATE_U = -12;
const BAR_U = -5;

interface Frame2 {
  o: V3;
  d: { x: number; z: number };
  n: { x: number; z: number };
}
const at = (f: Frame2, u: number, v: number): V3 => v3(f.o.x + f.d.x * u + f.n.x * v, 0, f.o.z + f.d.z * u + f.n.z * v);
const dirOf = (f: Frame2, du: number, dv: number) => ({ x: f.d.x * du + f.n.x * dv, z: f.d.z * du + f.n.z * dv });
const head = (a: { x: number; z: number }) => Math.atan2(a.z, a.x);

/** 场地的长度：入口区 + 一排车位 + 掉头区 */
const lotLen = (truck: boolean, n: number) => (truck ? TRUCK.entry + n * TRUCK.bay + TRUCK.far : CAR.entry + n * CAR.bay + CAR.far);

/** 一个停车场的几何：场口在 f.o（u = 0 是场地边），场地沿 f.d 伸进去；n 是一排的车位数 */
function layoutLot(f: Frame2, truck: boolean, n: number): { bays: Bay[]; L: number; loop: V3[]; through: number[] } {
  const K = truck ? TRUCK : CAR;
  const L = lotLen(truck, n);
  const a = K.aisle;
  // 掉头的半圆不出场地
  const uTurn = L - a - 1;
  // 环形通道：小车场从场口的进场车道（分隔岛右边）拐上 v = +a 的通道，绕半圆到 v = −a 开回来，再拐回出场车道；货车场直接从场地边进出
  const lead = truck ? [at(f, 0, a)] : [at(f, -5, 2.9), at(f, 1, a)];
  const inbound: V3[] = [...lead, at(f, uTurn, a)];
  for (let k = 1; k < 12; k++) {
    const t = (k / 12) * Math.PI;
    inbound.push(at(f, uTurn + Math.sin(t) * a, Math.cos(t) * a));
  }
  inbound.push(at(f, uTurn, -a));
  const loop = [...inbound, ...(truck ? [at(f, 0, -a)] : [at(f, 1, -a), at(f, -5, -2.9)])];
  const cum = cumulative(loop);
  // 进场一侧的直道从 lead 的最后一点起：u 处在通道上的路程
  const u0 = truck ? 0 : 1;
  const sIn = (u: number) => (cum[lead.length - 1] as number) + (u - u0);
  const sOut = (u: number) => (cum[inbound.length - 1] as number) + (uTurn - u);
  const slice = (s0: number, s1: number): V3[] => {
    const out: V3[] = [sampleAt(loop, cum, s0).p.clone()];
    for (let i = 0; i < loop.length; i++) if ((cum[i] as number) > s0 + 0.05 && (cum[i] as number) < s1 - 0.05) out.push((loop[i] as V3).clone());
    out.push(sampleAt(loop, cum, s1).p.clone());
    return out;
  };
  const total = cum[cum.length - 1] as number;
  const bays: Bay[] = [];
  // 穿过停的长车位：中间两排每四列一列（车位多于 5 列时）
  const through: number[] = [];
  if (!truck && n > 5) for (let k = 2; k < n - 1; k += 4) through.push(k);
  for (let k = 0; k < n; k++) {
    const u = K.entry + K.bay * (k + 0.5);
    if (truck) {
      // 货车：从进场通道往左拐进车位（横穿中间），停住；走的时候往前开，左拐上出场通道
      const s0 = sIn(u - K.r);
      const turn = bezier(at(f, u - K.r, a), dirOf(f, 1, 0), at(f, u, a - K.r), dirOf(f, 0, -1), 0.55, 10);
      const front = at(f, u, -8.6);
      const park = [...slice(0, s0), ...turn.slice(1), front];
      const exitTurn = bezier(front, dirOf(f, 0, -1), at(f, u - K.r, -a), dirOf(f, -1, 0), 0.55, 10);
      const out = [...exitTurn, ...slice(sOut(u - K.r), total).slice(1)];
      bays.push({ p: front, dir: head(dirOf(f, 0, -1)), park, back: [], out });
      continue;
    }
    const pull = through.includes(k);
    // 小车：四排——进场通道两侧（外侧右拐、中间左拐），出场通道两侧（外侧右拐、中间左拐）；穿过停的那一列中间两排合成一个车位
    for (const [side, inSide] of [
      [1, true],
      [-1, true],
      [-1, false],
      [1, false],
    ] as const) {
      if (pull && side === 1 && !inSide) continue;
      // 进场一侧往 +u 开、出场一侧往 −u 开；side：往 +v（1）还是 −v（−1）拐进车位
      const along = inSide ? 1 : -1;
      const va = inSide ? a : -a;
      const uStart = u - along * K.r;
      const s0 = inSide ? sIn(uStart) : sOut(uStart);
      if (pull && side === -1 && inSide) {
        // 穿过停：从进场通道拐进来，穿过中间两排，车头朝出场一侧停（车头离出场通道的车位边 0.4 米）；走的时候往前拐上出场通道
        const turn = bezier(at(f, uStart, va), dirOf(f, 1, 0), at(f, u, va - K.r), dirOf(f, 0, -1), 0.55, 8);
        const front = at(f, u, -(CAR.depth - 0.4));
        const park = [...slice(0, s0), ...turn.slice(1), front];
        const exitTurn = bezier(front, dirOf(f, 0, -1), at(f, u - K.r, -a), dirOf(f, -1, 0), 0.55, 8);
        const out = [...exitTurn, ...slice(sOut(u - K.r), total).slice(1)];
        bays.push({ p: front, dir: head(dirOf(f, 0, -1)), park, back: [], out });
        continue;
      }
      const vEnd = inSide ? (side > 0 ? K.half - 0.4 : 0.4) : side > 0 ? -0.4 : -(K.half - 0.4);
      const turn = bezier(at(f, uStart, va), dirOf(f, along, 0), at(f, u, va + side * K.r), dirOf(f, 0, side), 0.55, 8);
      const front = at(f, u, vEnd);
      const back = [...turn, front];
      const park = [...slice(0, s0), ...back.slice(1)];
      const out = slice(s0, total);
      bays.push({ p: front, dir: head(dirOf(f, 0, side)), park, back, out });
    }
  }
  return { bays, L, loop: loop.map((p) => p.clone()), through };
}

interface Host {
  line: Line;
  s0: number;
  s1: number;
  /** 从哪头开始找（1：从 s0 往 s1，−1 反过来）：设施的停车场从离大门近的一头找 */
  dir: 1 | -1;
}
interface Want {
  id: string;
  name: string;
  use: LotUse;
  truck: boolean;
  /** 一排几个车位 */
  n: number;
  /** 接哪条路、沿线从哪到哪找位置 */
  hosts: Host[];
  /** 设施的停车场：可以在这个设施的占地里（核心区以外） */
  inside?: { x: number; z: number }[];
  barrier: boolean;
}

/**
 * 摆停车场、铺进出场的路（在 net.finalize 之前调，进出场的路要算路口）。返回所有停车场，也挂在 net.lots 上给背景车流用。
 */
/** 摆停车场的空地检查：不压路、不下海、不进设施的核心区和门店、不和别的停车场重叠、离铁路和河远一点 */
function makeFree(net: RoadNet, sites: Map<string, Site>, taken: { x: number; z: number }[][]) {
  const plan = currentRegion();
  const roads = new SegGrid(60, 30);
  for (const l of net.lines) roads.add(l.pts, halfAll(l.xs) + 4);
  const sd = plan.seaDir;
  const c0 = plan.coast[0] as Km;
  const c1 = plan.coast[plan.coast.length - 1] as Km;
  const land = [...plan.coast, { x: c1.x - sd.x * 160, y: c1.y - sd.y * 160 }, { x: c0.x - sd.x * 160, y: c0.y - sd.y * 160 }].map((k) => ({ x: k.x * S, z: -k.y * S }));
  const poly = (f: Frame, r: { x0: number; x1: number; z0: number; z1: number }) => footprintKm(f, r).map((k) => ({ x: k.x * S, z: -k.y * S }));
  const cores = [poly(FRAMES.port, CORES.port), poly(FRAMES.airport, CORES.airport), poly(FRAMES.park, CORES.park)];
  const facility = [poly(FRAMES.port, LOCAL.port.rect), poly(FRAMES.airport, LOCAL.airport.rect), poly(FRAMES.park, LOCAL.park.rect)];
  const rail = RAIL.map((k) => v3(k.x * S, 0, -k.y * S));
  const river = REGION.plan?.river;
  const riverLines = river ? [river.pts, ...(river.branches ?? [])].map((l) => l.map((k) => v3(k.x * S, 0, -k.y * S))) : [];
  const riverHalf = river ? (river.width * S) / 2 : 0;
  const siteOutlines = [...sites.values()].map((s) => s.outline);
  const free = (q: { x: number; z: number }[], want: { id: string; inside?: { x: number; z: number }[] }): boolean => {
    // 场地四周外扩 8 米的一圈点都要在陆地上、不压路（自己接的那条路除外，只查场地本身）、不进核心区和门店
    const cx = q.reduce((s, p) => s + p.x, 0) / q.length;
    const cz = q.reduce((s, p) => s + p.z, 0) / q.length;
    const pts: { x: number; z: number }[] = [{ x: cx, z: cz }];
    for (let i = 0; i < q.length; i++) {
      const p0 = q[i] as { x: number; z: number };
      const p1 = q[(i + 1) % q.length] as { x: number; z: number };
      for (let k = 0; k < 6; k++) pts.push({ x: p0.x + ((p1.x - p0.x) * k) / 6, z: p0.z + ((p1.z - p0.z) * k) / 6 });
    }
    const dbg = (globalThis as { __lotDebug?: Record<string, number> }).__lotDebug;
    const no = (why: string) => {
      if (dbg) dbg[`${want.id}:${why}`] = (dbg[`${want.id}:${why}`] ?? 0) + 1;
      return false;
    };
    for (const p of pts) {
      if (!pointInPoly(p.x, p.z, land)) return no('sea');
      if (roads.near(p.x, p.z, 6)) return no('road');
      if (cores.some((c) => pointInPoly(p.x, p.z, c))) return no('core');
      if (facility.some((c) => c !== want.inside && pointInPoly(p.x, p.z, c))) return no('facility');
      if (siteOutlines.some((o) => pointInPoly(p.x, p.z, o))) return no('store');
      if (taken.some((o) => pointInPoly(p.x, p.z, o))) return no('taken');
      if (rail.length > 1 && polyDist(p.x, p.z, rail) < 30) return no('rail');
      if (riverLines.some((l) => l.length > 1 && polyDist(p.x, p.z, l) < riverHalf + 25)) return no('river');
    }
    // 场地也不能把别的停车场、门店、铁路圈在里面
    if (taken.some((o) => o.some((p) => pointInPoly(p.x, p.z, q)))) return false;
    return true;
  };
  return { roads, free, facility, rail };
}

/**
 * 摆停车场、铺进出场的路（在 net.finalize 之前调，进出场的路要算路口）。返回所有停车场，也挂在 net.lots 上给背景车流用。
 */
/**
 * 停车场的 T 形路口离停止线多远（按公开资料取的假设参数）：信号灯路口、和主干路及以上的路相交的路口 70 米，小街之间 30 米；
 * 同一条路上别的 T 形路口也隔这么远。停止线按收尾以后的路口退让（line.trimA / trimB）量：路口越大、相交的路越斜，退得越远。
 * 离得太近，路口排的队会排到停车场门口，出入的车堵在 T 形路口上。摆不下就换地方，还不行就不摆。
 */
export function lotClear(net: RoadNet, line: Line, s: number, relax = false): boolean {
  const small = (l: Line) => l.cls === 'street' || l.cls === 'service';
  const need = (jid: string) => {
    const j = net.junctions.get(jid);
    if (!j || j.kind === 'end') return 0;
    if (j.kind === 'mid' || j.kind === 'merge') return small(line) ? 30 : 70;
    const big = !!j.signal || !small(line) || net.lines.some((l) => (l.ja === jid || l.jb === jid) && !small(l));
    // 设施的员工停车场、货车等候区（进场路短，摆不下就放宽到 35 米，不然外来货车没处等）
    return relax ? 37 : (big ? 70 : 30) + 2;
  };
  if (s - line.trimA < need(line.ja) || line.len - line.trimB - s < need(line.jb)) return false;
  const gap = relax ? 37 : small(line) ? 30 : 70;
  return !line.mids.some((m) => Math.abs(m.s - s) < gap);
}

export function planLots(net: RoadNet, sites: Map<string, Site>): Lot[] {
  // 先收一次尾：路口退让（停止线的位置）要用来量停车场门口离路口多远
  net.finalize();
  const plan = currentRegion();
  const lots: Lot[] = [];
  const taken: { x: number; z: number }[][] = [];
  const { roads, free, facility, rail } = makeFree(net, sites, taken);
  const city = plan.city.boundary.map((k) => ({ x: k.x * S, z: -k.y * S }));

  /**
   * 摆不下就缩小规模（一排的车位少一些）再找；设施的停车场还摆不下时放宽一点（离路口、桥头近一些也行），
   * 设施的进场路太短或者贴着核心区走的区域，再到进场路另一头接着的路上找（见 hosts2）
   */
  const place = (want: Want, hosts2: Host[] = []): Lot | undefined => {
    for (const relax of want.inside ? [false, true] : [false])
      for (const k of [1, 0.65, 0.4]) {
        const n = Math.max(3, Math.round(want.n * k));
        const lot = placeN(want, n, relax, want.hosts, relax ? 700 : 0);
        if (lot) return lot;
      }
    for (const k of [1, 0.65, 0.4]) {
      const lot = hosts2.length ? placeN(want, Math.max(3, Math.round(want.n * k)), true, hosts2, 0) : undefined;
      if (lot) return lot;
    }
    // 还摆不下（进场路短、两边贴着核心区或者别的路）：离路远一些，进出场的路长一点
    if (want.inside)
      for (const back of [55, 90, 130])
        for (const k of [0.65, 0.4]) {
          const lot = placeN(want, Math.max(3, Math.round(want.n * k)), true, [...want.hosts, ...hosts2], 700, back);
          if (lot) return lot;
        }
    return undefined;
  };
  /** ext：沿进场路往外多找多远（放宽时：进场路的前一段都在核心区里的区域）；back：场地边离路边多远 */
  const placeN = (want: Want, nBays: number, relax: boolean, hosts: Host[], ext: number, back = SET_BACK): Lot | undefined => {
    const L = lotLen(want.truck, nBays);
    const half = want.truck ? TRUCK.half : CAR.half;
    const gap = relax ? 45 : 80;
    for (const h of hosts) {
      const line = h.line;
      const hw = halfAll(line.xs);
      const a = Math.max(relax ? 35 : 70, h.dir < 0 ? h.s0 - ext : h.s0);
      const b = Math.min(line.len - (relax ? 35 : 70), h.dir > 0 ? h.s1 + ext : h.s1);
      // 货车等候区先摆在开往设施方向的右手边：进场、出场去设施都是右转，不用横穿中央分隔带
      const sides = want.use === 'hold' ? [-h.dir, h.dir] : [1, -1];
      for (let k = 0; a + k * 25 <= b; k++) {
        const s = h.dir > 0 ? a + k * 25 : b - k * 25;
        // 设施的货车等候区实在摆不下时（放宽的那一轮）照旧摆：外来货车要有地方等
        if (!(relax && want.use === 'hold') && !lotClear(net, line, s, relax && !!want.inside)) continue;
        const q = sampleAt(line.pts, line.cum, s);
        // 离路口、别的 T 形路口远一点；不在桥上
        if ([...net.junctions.values()].some((j) => Math.hypot(j.pos.x - q.p.x, j.pos.z - q.p.z) < gap) || line.mids.some((m) => Math.abs(m.s - s) < gap)) continue;
        if (line.elev(s) > 0.5 || line.bridges.some((br) => s > br.s0 - (relax ? 25 : 40) && s < br.s1 + (relax ? 25 : 40))) continue;
        for (const side of sides) {
          const d = { x: -q.dz * side, z: q.dx * side };
          const n = { x: -d.z, z: d.x };
          const o = v3(q.p.x + d.x * (hw + back), 0, q.p.z + d.z * (hw + back));
          const f: Frame2 = { o, d, n };
          const outline = [at(f, -2, -half - 1), at(f, L + 1, -half - 1), at(f, L + 1, half + 1), at(f, -2, half + 1)].map((p) => ({ x: p.x, z: p.z }));
          const grown = [at(f, -1, -half - 8), at(f, L + 8, -half - 8), at(f, L + 8, half + 8), at(f, -1, half + 8)].map((p) => ({ x: p.x, z: p.z }));
          if (!free(grown, want)) continue;
          // 进出场的路：T 形路口 → 场口
          const jid = net.addMid(line, s, `${want.id}:t`, 'mid', false);
          const gid = `${want.id}:gate`;
          const gp = at(f, GATE_U, 0);
          net.junction(gid, gp, 'end');
          const tp = (net.junctions.get(jid) as { pos: V3 }).pos;
          const drive = net.addLine('service', [tp.clone(), gp.clone()], jid, gid, { name: `${want.name}进出场路` });
          roads.add(drive.pts, halfAll(drive.xs) + 4);
          const { bays, loop, through } = layoutLot(f, want.truck, nBays);
          taken.push(grown);
          const lot: Lot = {
            frame: { o, d, n, L, half, n0: nBays, through },
            id: want.id,
            name: want.name,
            use: want.use,
            truck: want.truck,
            gate: gid,
            line: drive.id,
            bays,
            outline,
            ...(want.barrier ? { barrier: { p: at(f, BAR_U, 0), dir: head(d) } } : {}),
            ...(want.truck ? {} : { loop }),
            occ: OCC[want.use],
          };
          lots.push(lot);
          return lot;
        }
      }
    }
    return undefined;
  };

  // —— 设施的停车场：接设施的进场路（出大门那一段） ——
  const from = (id: string) => net.lines.filter((l) => l.ja === id || l.jb === id);
  const span = (l: Line, id: string, a: number, b: number): Host => (l.ja === id ? { line: l, s0: a, s1: b, dir: 1 } : { line: l, s0: l.len - b, s1: l.len - a, dir: -1 });
  const portRoad = from('PORT').map((l) => span(l, 'PORT', 60, 900));
  const airRoad = from('AIR').map((l) => span(l, 'AIR', 60, 900));
  // 物流园的进场路：出了库房和挂车场再摆（园区南边的空地或者园区外）
  const dcRoads = from('DC').filter((l) => l.cls !== 'service').map((l) => span(l, 'DC', 90, 560));
  const portArea = facility[0] as { x: number; z: number }[];
  const airArea = facility[1] as { x: number; z: number }[];
  const parkArea = facility[2] as { x: number; z: number }[];
  // 进场路另一头是立交的外侧匝道口、进场路又短又贴着核心区时：到立交另一侧接着的城市道路上找（车穿过立交桥下过去）
  const beyond = (id: string): Host[] => {
    const out: Host[] = [];
    for (const l of from(id)) {
      if (l.cls === 'service') continue;
      const far = l.ja === id ? l.jb : l.ja;
      for (const ic of net.ics.values()) {
        if (ic.tout !== far && ic.tin !== far) continue;
        const other = ic.tout === far ? ic.tin : ic.tout;
        // 立交另一侧的城市道路，再往前一个路口接着的城市道路（那条太短、已经摆了别的停车场时）
        const city = (m: Line) => m.cls === 'arterial' || m.cls === 'local' || m.cls === 'street';
        const near: Host[] = [];
        for (const m of net.lines) {
          if (!city(m)) continue;
          if (m.ja === other) near.push({ line: m, s0: 40, s1: 700, dir: 1 });
          else if (m.jb === other) near.push({ line: m, s0: m.len - 700, s1: m.len - 40, dir: -1 });
        }
        out.push(...near);
        for (const h of near) {
          const end = h.dir > 0 ? h.line.jb : h.line.ja;
          for (const m of net.lines) {
            if (!city(m) || m === h.line) continue;
            if (m.ja === end) out.push({ line: m, s0: 40, s1: 600, dir: 1 });
            else if (m.jb === end) out.push({ line: m, s0: m.len - 600, s1: m.len - 40, dir: -1 });
          }
        }
      }
    }
    return out;
  };
  place({ id: 'PORT:staff', name: '港口员工停车场', use: 'staff', truck: false, n: 14, hosts: portRoad, inside: portArea, barrier: true }, beyond('PORT'));
  place({ id: 'PORT:hold', name: '港口集卡等候区', use: 'hold', truck: true, n: 8, hosts: portRoad, inside: portArea, barrier: true }, beyond('PORT'));
  place({ id: 'AIR:staff', name: '机场货运区员工停车场', use: 'staff', truck: false, n: 12, hosts: airRoad, inside: airArea, barrier: true }, beyond('AIR'));
  place({ id: 'AIR:hold', name: '机场货车等候区', use: 'hold', truck: true, n: 6, hosts: airRoad, inside: airArea, barrier: true }, beyond('AIR'));
  place({ id: 'DC:staff', name: '物流园员工停车场', use: 'staff', truck: false, n: 20, hosts: dcRoads, inside: parkArea, barrier: true }, beyond('DC'));

  // —— 城市客运站的停车场：站房附近的干道 ——
  const pax = plan.railPassenger;
  if (pax && rail.length > 1) {
    const st = sampleAt(rail, cumulative(rail), pax.s * S).p;
    const near = net.lines
      .filter((l) => l.cls === 'arterial')
      .map((l) => {
        let best = { d: Infinity, s: 0 };
        l.pts.forEach((p, i) => {
          const d = Math.hypot(p.x - st.x, p.z - st.z);
          if (d < best.d) best = { d, s: l.cum[i] as number };
        });
        return { line: l, s0: best.s - 260, s1: best.s + 260, dir: 1 as const, d: best.d };
      })
      .filter((h) => h.d < 520)
      .sort((a, b) => a.d - b.d);
    place({ id: 'STATION:lot', name: '城市客运站停车场', use: 'station', truck: false, n: 16, hosts: near, barrier: true });
  }

  // —— 城区：沿干道分散摆几处公共停车场（城区边界以内，彼此隔开） ——
  const want = plan.options.size === 'S' ? 6 : plan.options.size === 'L' ? 10 : 8;
  const centers = plan.city.centers.map((k) => ({ x: k.x * S, z: -k.y * S }));
  const art = net.lines.filter((l) => l.cls === 'arterial' && l.len > 260);
  // 候选的路按离市中心的远近排开，轮流从近到远、不同方向上挑
  const cands = art
    .map((l) => {
      const m = sampleAt(l.pts, l.cum, l.len / 2).p;
      const dc = Math.min(...centers.map((c) => Math.hypot(c.x - m.x, c.z - m.z)));
      return { l, m, dc, inCity: pointInPoly(m.x, m.z, city) };
    })
    .filter((c) => c.inCity)
    .sort((a, b) => a.dc - b.dc);
  let made = 0;
  for (const c of cands) {
    if (made >= want) break;
    if (lots.some((lt) => lt.use === 'public' && Math.hypot((lt.outline[0] as { x: number }).x - c.m.x, (lt.outline[0] as { z: number }).z - c.m.z) < 380)) continue;
    const lot = place({ id: `CITY:${made}`, name: `城区公共停车场 ${made + 1}`, use: 'public', truck: false, n: 12 + ((made * 5) % 9), hosts: [{ line: c.l, s0: 0, s1: c.l.len, dir: 1 }], barrier: false });
    if (lot) made++;
  }
  // 城区的干道少、短（小城市、路网被门店和铁路切碎）时公共停车场不到 4 处：短一点的干道、支路也摆，彼此隔开 220 米
  if (made < 4) {
    const more = net.lines
      .filter((l) => (l.cls === 'arterial' || l.cls === 'local') && l.len > 150)
      .map((l) => {
        const m = sampleAt(l.pts, l.cum, l.len / 2).p;
        return { l, m, dc: Math.min(...centers.map((c) => Math.hypot(c.x - m.x, c.z - m.z))) };
      })
      .filter((c) => pointInPoly(c.m.x, c.m.z, city))
      .sort((a, b) => a.dc - b.dc);
    for (const c of more) {
      if (made >= 4) break;
      if (lots.some((lt) => lt.use === 'public' && Math.hypot((lt.outline[0] as { x: number }).x - c.m.x, (lt.outline[0] as { z: number }).z - c.m.z) < 220)) continue;
      const lot = place({ id: `CITY:${made}`, name: `城区公共停车场 ${made + 1}`, use: 'public', truck: false, n: 10 + ((made * 5) % 7), hosts: [{ line: c.l, s0: 0, s1: c.l.len, dir: 1 }], barrier: false });
      if (lot) made++;
    }
  }
  net.lots = lots;
  return lots;
}

/**
 * 小区停车场：沿城区的小街摆几处小的停车场（一排 4–5 个车位，四排），场口不设道闸。
 * 住户的车夜里停在这里，早上开出去上班、办事，晚上回来（traffic.ts）。在小街铺好以后、net.finalize 之前调。
 */
export function planHomeLots(net: RoadNet, sites: Map<string, Site>, streets: readonly Line[]): Lot[] {
  const plan = currentRegion();
  const r = rand(5501 + plan.spec.seed * 13);
  const taken: { x: number; z: number }[][] = net.lots.map((l) => grow(l.outline, 8));
  const { roads, free } = makeFree(net, sites, taken);
  const city = plan.city.boundary.map((k) => ({ x: k.x * S, z: -k.y * S }));
  const made: Lot[] = [];
  const want = Math.max(6, Math.min(26, Math.round(streets.length * 0.7) + 4));
  const SET = 13;
  // 只摆在小街上（干道上再加路口会挤掉公交港湾的位置）
  const hosts = streets.map((l) => ({ line: l, prio: r() })).sort((a, b) => a.prio - b.prio);
  for (const { line } of hosts) {
    if (made.length >= want) break;
    const n = 4 + Math.floor(r() * 2);
    const L = lotLen(false, n);
    const half = CAR.half;
    const hw = halfAll(line.xs);
    const gap = 32;
    let done = false;
    for (let k = 0, s0 = 30 + r() * 20; !done && s0 + k * 18 < line.len - 30; k++) {
      const s = s0 + k * 18;
      const q = sampleAt(line.pts, line.cum, s);
      if (!pointInPoly(q.p.x, q.p.z, city)) continue;
      if ([...net.junctions.values()].some((j) => Math.hypot(j.pos.x - q.p.x, j.pos.z - q.p.z) < gap) || line.mids.some((m) => Math.abs(m.s - s) < gap)) continue;
      if (line.elev(s) > 0.3 || line.bridges.some((br) => s > br.s0 - 30 && s < br.s1 + 30)) continue;
      for (const side of r() < 0.5 ? [1, -1] : [-1, 1]) {
        const d = { x: -q.dz * side, z: q.dx * side };
        const nn = { x: -d.z, z: d.x };
        const o = v3(q.p.x + d.x * (hw + SET), 0, q.p.z + d.z * (hw + SET));
        const f: Frame2 = { o, d, n: nn };
        const outline = [at(f, -2, -half - 1), at(f, L + 1, -half - 1), at(f, L + 1, half + 1), at(f, -2, half + 1)].map((p) => ({ x: p.x, z: p.z }));
        const grown = [at(f, -1, -half - 6), at(f, L + 6, -half - 6), at(f, L + 6, half + 6), at(f, -1, half + 6)].map((p) => ({ x: p.x, z: p.z }));
        const id = `HOME:${made.length}`;
        if (!grown.every((p) => pointInPoly(p.x, p.z, city)) || !free(grown, { id })) continue;
        const jid = net.addMid(line, s, `${id}:t`, 'mid', false);
        const gid = `${id}:gate`;
        const gp = at(f, GATE_U, 0);
        net.junction(gid, gp, 'end');
        const tp = (net.junctions.get(jid) as { pos: V3 }).pos;
        const drive = net.addLine('service', [tp.clone(), gp.clone()], jid, gid, { name: '小区停车场进出场路' });
        roads.add(drive.pts, halfAll(drive.xs) + 4);
        const { bays, loop, through } = layoutLot(f, false, n);
        taken.push(grown);
        made.push({ id, name: `小区停车场 ${made.length + 1}`, use: 'home', truck: false, gate: gid, line: drive.id, bays, outline, loop, occ: OCC.home, frame: { o, d, n: nn, L, half, n0: n, through } });
        done = true;
        break;
      }
    }
  }
  net.lots = [...net.lots, ...made];
  return made;
}

/** 多边形从中心往外扩 pad 米 */
function grow(poly: readonly { x: number; z: number }[], pad: number): { x: number; z: number }[] {
  const c = { x: poly.reduce((a, p) => a + p.x, 0) / poly.length, z: poly.reduce((a, p) => a + p.z, 0) / poly.length };
  return poly.map((p) => {
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dx / l) * pad, z: p.z + (dz / l) * pad };
  });
}

// ———————————————————————— 画 ————————————————————————

const LOT_Y = 0.3;
const MARK = 0.075;

export interface LotMeshes {
  group: THREE.Group;
  /** 道闸：raised(停车场编号:in / :out) 给出这一刻进场、出场的杆是不是抬着（背景车流过道闸时停一下、抬杆） */
  update: (raised: (key: string) => boolean) => void;
  /** 夜里灯杆亮一些（0 白天 … 1 夜里） */
  setNight: (night: number) => void;
  /** 灯头的位置（夜里的光晕、地上的光圈，见 lamps.ts） */
  lamps: { x: number; y: number; z: number }[];
}

/** 停车场的地面、车位线、通道箭头、路缘石、灯杆、蓝底白字的 P 牌、岗亭和道闸；场口的分隔岛和停车线、端岛的树和灯杆、无障碍和充电车位 */
export function buildLots(lots: readonly Lot[]): LotMeshes {
  const group = new THREE.Group();
  group.name = 'parking';
  const pad = new GeoBuilder();
  const kerb = new GeoBuilder();
  const marks = new GeoBuilder();
  const sign = new GeoBuilder();
  const parts: Part[] = [];
  const lampHeads: Part[] = [];
  const lamps: { x: number; y: number; z: number }[] = [];
  const bars: { p: V3; dir: number; key: string }[] = [];
  const island = new GeoBuilder();
  for (const lot of lots) {
    const o = lot.outline;
    pad.color(lot.truck ? '#64676c' : '#5c5f64');
    pad.polygon(o, LOT_Y + 0.002);
    const F = lot.frame;
    if (F) {
      const A = (u: number, v: number) => at(F, u, v);
      const K = lot.truck ? TRUCK : CAR;
      const ang = Math.atan2(F.d.x, F.d.z);
      const aw = K.aisle + (lot.truck ? 6.5 : 3.25);
      // 场口：进出场的路到场地边铺成喇叭口，中间一道分隔岛（岗亭在岛上）
      pad.polygon([A(-12.5, -4.4), A(-12.5, 4.4), A(-1.9, aw), A(-1.9, -aw)], LOT_Y + 0.001);
      const tip = lot.truck ? -3 : K.entry - 3.2;
      const hw = (u: number) => 0.45 + Math.max(0, u + 11) * (lot.truck ? 0.2 : 0.19);
      const isl = [A(-11, -0.45), A(-5, -hw(-5)), A(tip, -hw(tip)), A(tip, hw(tip)), A(-5, hw(-5)), A(-11, 0.45)];
      island.color('#c9c9c2');
      island.polygon(isl, LOT_Y + 0.18);
      island.color('#8db36f');
      island.polygon(isl.map((p, i) => A(i === 0 || i === 5 ? -10.6 : i === 2 || i === 3 ? tip - 0.3 : -5, (i < 3 ? -1 : 1) * Math.max(0.15, (i === 0 || i === 5 ? 0.45 : hw(i === 2 || i === 3 ? tip - 0.3 : -5)) - 0.25))), LOT_Y + 0.2);
      // 出口车道的停车线（出场的车在这里停下，看清路上再并进去）
      marks.color('#f4f4ef');
      const sl = A(-3.2, -2.4);
      marks.box(sl.x, LOT_Y + MARK - 0.02, sl.z, 3.6, 0.02, 0.45, ang);
      // 通道上的行车方向箭头（进场一侧朝里、出场一侧朝外）
      const L0 = K.entry + F.n0 * K.bay;
      const arrow = (u: number, v: number, dir: number) => {
        const c = A(u, v);
        const a2 = ang + (dir > 0 ? 0 : Math.PI);
        const fx = Math.sin(a2);
        const fz = Math.cos(a2);
        marks.box(c.x - fx * 0.7, LOT_Y + MARK - 0.02, c.z - fz * 0.7, 0.3, 0.02, 2.4, a2);
        const tipP = { x: c.x + fx * 1.6, z: c.z + fz * 1.6 };
        const l = { x: c.x + fx * 0.4 - fz * 0.75, z: c.z + fz * 0.4 + fx * 0.75 };
        const r2 = { x: c.x + fx * 0.4 + fz * 0.75, z: c.z + fz * 0.4 - fx * 0.75 };
        marks.polygon([tipP, l, r2], LOT_Y + MARK - 0.01);
      };
      for (const u of [K.entry + 2, (K.entry + L0) / 2, L0 - 2]) {
        arrow(u, K.aisle, 1);
        arrow(u, -K.aisle, -1);
      }
      if (!lot.truck) {
        // 车位线：外侧两排、中间背靠背两排（中线分开；穿过停的那一列不画中线，画一个箭头）
        const D = CAR.depth;
        for (let k = 0; k <= F.n0; k++) {
          const u = K.entry + K.bay * k;
          for (const [v0, v1] of [
            [K.aisle + 3.25, K.half],
            [-K.aisle - 3.25, -K.half],
            [-D, D],
          ] as const) {
            const m = A(u, (v0 + v1) / 2);
            marks.box(m.x, LOT_Y + MARK - 0.02, m.z, 0.12, 0.02, Math.abs(v1 - v0), ang + Math.PI / 2);
          }
        }
        for (let k = 0; k < F.n0; k++) {
          const u = K.entry + K.bay * (k + 0.5);
          if (F.through.includes(k)) {
            arrow(u, 0, 0);
            continue;
          }
          const m = A(u, 0);
          marks.box(m.x, LOT_Y + MARK - 0.02, m.z, K.bay, 0.02, 0.12, ang + Math.PI / 2);
        }
        // 无障碍车位（离场口最近的两个外侧车位：蓝底、白色的轮椅标志、旁边一条斜线的轮椅通道）、充电车位（绿底、充电桩）
        const fill = (k: number, side: number, color: string) => {
          const u0 = K.entry + K.bay * k;
          const v0 = side * (K.aisle + 3.25);
          const v1 = side * K.half;
          island.color(color);
          island.polygon([A(u0 + 0.1, v0), A(u0 + K.bay - 0.1, v0), A(u0 + K.bay - 0.1, v1), A(u0 + 0.1, v1)], LOT_Y + 0.01);
        };
        for (const side of [1, -1]) {
          fill(0, side, '#2f6db5');
          const c = A(K.entry + K.bay * 0.5, side * (K.aisle + 3.25 + CAR.depth * 0.45));
          marks.box(c.x, LOT_Y + MARK, c.z, 0.9, 0.02, 0.9, ang);
          // 轮椅通道：车位外侧（场口那一边）1.2 米宽的斜线
          for (let t = 0; t < 4; t++) {
            const h = A(K.entry - 0.6, side * (K.aisle + 3.25 + 0.8 + t * 1.15));
            marks.box(h.x, LOT_Y + MARK - 0.02, h.z, 0.12, 0.02, 1.5, ang + Math.PI / 4);
          }
        }
        for (const k of [1, 2]) {
          if (k >= F.n0) continue;
          fill(k, -1, '#3e9e6a');
          const post = A(K.entry + K.bay * (k + 0.5), -K.half + 0.35);
          parts.push(box(0.45, 1.5, 0.3, '#e8ece9', post.x, LOT_Y, post.z), box(0.3, 0.3, 0.05, '#27c46b', post.x, LOT_Y + 1.1, post.z));
        }
        // 中间两排两头的端岛：路缘石、草、树、灯杆
        for (const u of [K.entry - 1.5, L0 + 1.5]) {
          const e = [A(u - 1.15, -D + 0.3), A(u + 1.15, -D + 0.3), A(u + 1.15, D - 0.3), A(u - 1.15, D - 0.3)];
          island.color('#c9c9c2');
          island.polygon(e, LOT_Y + 0.18);
          island.color('#8db36f');
          island.polygon([A(u - 0.9, -D + 0.55), A(u + 0.9, -D + 0.55), A(u + 0.9, D - 0.55), A(u - 0.9, D - 0.55)], LOT_Y + 0.2);
          for (const v of [-2.6, 2.6]) {
            const t = A(u, v);
            parts.push(cyl(0.18, 0.24, 1.6, '#7a5a3a', t.x, LOT_Y + 0.2, t.z, 6), cyl(0, 1.9, 4.2, '#5f9150', t.x, LOT_Y + 1.5, t.z, 7));
          }
          const pl = A(u, 0);
          parts.push(cyl(0.14, 0.18, 9, '#8c9096', pl.x, LOT_Y + 0.2, pl.z, 6));
          for (const sgn of [-1, 1]) {
            const hd = A(u, sgn * 0.7);
            lampHeads.push(box(0.5, 0.22, 1.0, '#ffffff', hd.x, LOT_Y + 9.0, hd.z));
            lamps.push({ x: hd.x, y: LOT_Y + 8.9, z: hd.z });
          }
        }
      }
    }
    // 路缘石：沿场地边一圈（场口那一边留出进出口）
    kerb.color('#c9c9c2');
    for (let i = 0; i < o.length; i++) {
      const a = o[i] as { x: number; z: number };
      const b = o[(i + 1) % o.length] as { x: number; z: number };
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const ang = Math.atan2(b.x - a.x, b.z - a.z);
      if (i === 3) {
        // 场口一边：两头各留一段，中间是进出口（有坐标系的场地：整个喇叭口都开着）
        const gap = lot.frame ? Math.min(len - 2, 2 * ((lot.truck ? TRUCK.aisle + 6.5 : CAR.aisle + 3.25) + 0.3)) : 11;
        const seg = (len - gap) / 2;
        for (const k of [0, 1]) {
          const t0 = k ? (seg + gap) / len : 0;
          const t1 = k ? 1 : seg / len;
          const cx = a.x + (b.x - a.x) * ((t0 + t1) / 2);
          const cz = a.z + (b.z - a.z) * ((t0 + t1) / 2);
          kerb.box(cx, LOT_Y, cz, 0.5, 0.25, len * (t1 - t0), ang);
        }
        continue;
      }
      kerb.box((a.x + b.x) / 2, LOT_Y, (a.z + b.z) / 2, 0.5, 0.25, len, ang);
    }
    // 车位线（货车位、没有坐标系的场地）：每个车位两侧的白线（小车 5 米长，货车 18 米长）
    marks.color('#efefea');
    for (const bay of lot.frame && !lot.truck ? [] : lot.bays) {
      const dx = Math.cos(bay.dir);
      const dz = Math.sin(bay.dir);
      const len = lot.truck ? 18 : 5;
      const wid = lot.truck ? 4.4 : 2.5;
      const cx = bay.p.x - dx * (len / 2 - 0.3);
      const cz = bay.p.z - dz * (len / 2 - 0.3);
      for (const sg of [-1, 1]) marks.box(cx - dz * (wid / 2) * sg, LOT_Y + MARK - 0.02, cz + dx * (wid / 2) * sg, 0.12, 0.02, len, Math.atan2(dx, dz));
    }
    // 货车等候区里停的车是外来货车（ops/extTrucks.ts）按当天的时刻开进开出的，这里不画
    // 灯杆：沿场地长边每 30 米一根
    const a0 = o[0] as { x: number; z: number };
    const a1 = o[1] as { x: number; z: number };
    const a2 = o[2] as { x: number; z: number };
    const a3 = o[3] as { x: number; z: number };
    for (const [p, q] of [
      [a0, a1],
      [a3, a2],
    ] as const) {
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      for (let s = 8; s < len - 4; s += 30) {
        const x = p.x + ((q.x - p.x) * s) / len;
        const z = p.z + ((q.z - p.z) * s) / len;
        parts.push(cyl(0.14, 0.18, 9, '#8c9096', x, LOT_Y, z, 6));
        lampHeads.push(box(1.1, 0.25, 0.5, '#ffffff', x, LOT_Y + 8.9, z));
        lamps.push({ x, y: LOT_Y + 8.8, z });
      }
    }
    // P 牌（场口外、进场一侧）
    const u = { x: a0.x - a3.x, z: a0.z - a3.z };
    const ul = Math.hypot(u.x, u.z) || 1;
    const along = { x: u.x / ul, z: u.z / ul };
    const into = { x: a1.x - a0.x, z: a1.z - a0.z };
    const il = Math.hypot(into.x, into.z) || 1;
    const inw = { x: into.x / il, z: into.z / il };
    const sx = a3.x + along.x * 2 - inw.x * 4;
    const sz = a3.z + along.z * 2 - inw.z * 4;
    parts.push(cyl(0.08, 0.08, 3.2, '#9aa0a6', sx, LOT_Y, sz, 6));
    sign.color('#1f5fbf');
    sign.box(sx, LOT_Y + 3.2, sz, 1.6, 1.6, 0.12, Math.atan2(inw.x, inw.z));
    sign.color('#ffffff');
    // 白色的 P：竖杠 + 上面的半框
    const r = { x: inw.z, z: -inw.x };
    const pp = (dx: number, dy: number) => ({ x: sx + r.x * dx - inw.x * 0.08, z: sz + r.z * dx - inw.z * 0.08, y: LOT_Y + 3.2 + dy });
    const bar = (dx: number, dy: number, w: number, h: number) => {
      const c = pp(dx, dy);
      sign.box(c.x, c.y, c.z, w, h, 0.04, Math.atan2(inw.x, inw.z));
    };
    bar(-0.32, 0.25, 0.22, 1.1);
    bar(0.02, 1.13, 0.5, 0.2);
    bar(0.02, 0.73, 0.5, 0.2);
    bar(0.32, 0.73, 0.2, 0.6);
    if (lot.barrier) {
      // 岗亭（两条车道中间）、两根道闸（进场一根、出场一根）
      const b = lot.barrier;
      const dx = Math.cos(b.dir);
      const dz = Math.sin(b.dir);
      parts.push(box(1.8, 0.25, 2.6, '#c9ccd1', b.p.x, LOT_Y, b.p.z), box(1.5, 2.6, 2.0, '#eef0f2', b.p.x, LOT_Y + 0.25, b.p.z), box(1.8, 0.25, 2.3, '#2a78d6', b.p.x, LOT_Y + 2.85, b.p.z));
      for (const side of [1, -1]) {
        // 道闸机箱在岗亭两侧，杆横跨车道（side = 1：进场车道，在进场方向的右侧）
        const nx = -dz * side;
        const nz = dx * side;
        const mx = b.p.x + nx * 1.4;
        const mz = b.p.z + nz * 1.4;
        parts.push(box(0.45, 1.0, 0.45, '#f0c419', mx, LOT_Y, mz));
        bars.push({ p: v3(mx, LOT_Y + 0.95, mz), dir: Math.atan2(nz, nx), key: `${lot.id}:${side > 0 ? 'in' : 'out'}` });
      }
    }
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  const add = (g: GeoBuilder, name: string) => {
    if (g.empty) return;
    const m = new THREE.Mesh(g.build(), mat);
    m.receiveShadow = true;
    m.name = name;
    group.add(m);
  };
  add(pad, 'parking-pads');
  add(island, 'parking-islands');
  add(kerb, 'parking-kerbs');
  add(marks, 'parking-marks');
  add(sign, 'parking-signs');
  if (parts.length) {
    const m = new THREE.Mesh(merge(parts), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'parking-furniture';
    group.add(m);
  }
  const lampMat = new THREE.MeshBasicMaterial({ color: '#fff4d6', toneMapped: false });
  if (lampHeads.length) {
    const lm = new THREE.Mesh(merge(lampHeads), lampMat);
    lm.name = 'parking-lamps';
    group.add(lm);
  }
  // 道闸的杆：红白相间的长条，原点在机箱上，抬起时绕杆根转 80°
  const armGeo = new THREE.BoxGeometry(4.2, 0.12, 0.12).translate(2.1, 0, 0);
  const arms = new THREE.InstancedMesh(armGeo, new THREE.MeshStandardMaterial({ color: '#f4f4f0', roughness: 0.6 }), Math.max(1, bars.length));
  arms.count = bars.length;
  arms.name = 'parking-barriers';
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);
  const raised = bars.map(() => false);
  const setArm = (i: number, up: boolean) => {
    const b = bars[i] as (typeof bars)[number];
    e.set(0, -b.dir, up ? Math.PI * 0.44 : 0, 'YXZ');
    q.setFromEuler(e);
    m4.compose(b.p, q, one);
    arms.setMatrixAt(i, m4);
  };
  bars.forEach((_, i) => setArm(i, false));
  arms.instanceMatrix.needsUpdate = true;
  group.add(arms);
  return {
    group,
    lamps,
    setNight: (night) => lampMat.color.setScalar(0.35 + 0.9 * Math.max(0, Math.min(1, night))),
    update: (isUp) => {
      let dirty = false;
      bars.forEach((b, i) => {
        const up = isUp(b.key);
        if (up !== raised[i]) {
          raised[i] = up;
          setArm(i, up);
          dirty = true;
        }
      });
      if (dirty) arms.instanceMatrix.needsUpdate = true;
    },
  };
}

/** 场口外进场车道的终点到车位那条路的起点：贝塞尔接上（背景车流、孪生里的车都用） */
export const lotEntry = (from: V3, fromDir: { x: number; z: number }, bay: Bay): V3[] => {
  const p0 = bay.park[0] as V3;
  const p1 = bay.park[1] ?? p0;
  const l = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
  return [...bezier(from, fromDir, p0, { x: (p1.x - p0.x) / l, z: (p1.z - p0.z) / l }, 0.42, 10), ...bay.park.slice(1)];
};
