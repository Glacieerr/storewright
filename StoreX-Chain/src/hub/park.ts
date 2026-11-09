import { toLocal } from '../region/frames';
import { FRAMES, RAIL, RAIL_DC_INDEX } from '../region/region';
import { LOCAL } from '../region/regionGen';
import type { WVehicle } from '../sim/trace';
import { HUB_SLOT, HUB_SLOTS, tallyOccupancy, type HubDay, type HubFlow, type HubKpi, type HubZone } from './types';

/**
 * 物流园的仓储和场地作业（一天的计划）：铁路货运站卸下来的箱、配送中心和冷链中心的月台门、园区里的铁路转运仓、
 * 进园登记、待命停车场、甩挂区、场内牵引车。三维（ops/dc.ts、ops/parkYard.ts、ops/rail.ts）按这一份摆车、箱、挂车和托盘，
 * 值班助手按 hubDay 回答，所以画面和回答对得上。纯函数，不依赖 three.js；同一份输入每次一样。
 *
 * 货怎么走（每一票货从火车卸下来到上公路，都要经过一个库）：
 * - 本店的箱：铁路货运站的轨道式龙门吊把箱从平车卸到箱位；查验、调车以后（列车作业时段结束后），
 *   短驳牵引车开进龙门吊跨内的集卡道，龙门吊把箱放到它的骨架车上；短驳车绕到配送中心南面的收货门，倒车靠台、
 *   甩下骨架车（连箱）就走；收货员在门里拆箱（36 分钟，和仿真里集装箱拖车在配送中心拆箱的时长一样），
 *   拆完短驳车回来挂上空箱，拉回货运站，龙门吊把空箱放回箱位。收货门不和调度台排给仿真车的时段重叠。
 * - 别家的箱：大部分短驳到园区的铁路转运仓（越库仓）北面的拆箱门，拆出来的托盘按收货人放进暂存道，
 *   再从南面的装卸门装上别家的货车（按预约）走；一部分整箱由外来集卡来提（龙门吊直接装上它的骨架车）；少数留到明天。
 * - 转运仓也做公路转公路的越库：别家的货车送来整车托盘，卸到暂存道，再拼进去别处的车。
 * - 甩挂：承运商白天先把空挂车甩在甩挂区，场内牵引车按预约把它拖到装卸门，装满再拖回车位，承运商的车头来了挂上就走；
 *   调度台里「提前装好、挂车在场地等发车」的本店配送车也按这个走。
 * - 进园登记：进门的车在登记亭停一下（核预约、看封条），来早了或者门还占着就先进待命停车场，到时候再去门上。
 *
 * 坐标：物流园的局部坐标（沙盘米，和 ops/dc.ts 一样；园区内部按真实尺寸），区域生成器整体平移、旋转。
 */

export interface Pt {
  x: number;
  z: number;
}

// ———————————————————————— 布局 ————————————————————————

/** 铁路货运站的箱位、龙门吊、集卡道（和 ops/rail.ts 共用这几个数） */
export const RAIL_YARD = {
  /** 箱位两排（离主线的 v），加装卸线时往外挪 TRACK_GAP；每排沿铁路 SLOT_U 一个、最多 TIERS 层 */
  rowV: [12, 15.2],
  trackGap: 4.8,
  slotU: 13.2,
  tiers: 2,
  /** 龙门吊支腿（v），主梁高 */
  legV: [-6, 21],
  /** 物流园的站台在外侧支腿里留一条集卡道：支腿往外挪这么多 */
  laneExtra: 4.4,
  /** 每段站台的长度（沿铁路往两边各 215 米） */
  len: 215,
  wagons: 12,
};
/** 某段站台（装卸线股数 tracks）的箱位排、支腿、集卡道中心（v） */
export function railGeometry(tracks: number, truckLane: boolean): { rowV: number[]; legV: number[]; laneV: number } {
  const k = Math.max(1, Math.min(4, Math.round(tracks)));
  const off = (k - 1) * RAIL_YARD.trackGap;
  const rowV = RAIL_YARD.rowV.map((v) => v + off);
  const legV = [RAIL_YARD.legV[0] as number, (RAIL_YARD.legV[1] as number) + off + (truckLane ? RAIL_YARD.laneExtra : 0)];
  // 集卡道：外排箱（半宽 1.22）外面留 0.95 米，车宽 2.5
  return { rowV, legV, laneV: (rowV[rowV.length - 1] as number) + 1.22 + 0.95 + 1.25 };
}

export interface RailSection {
  key: 'W' | 'E';
  title: string;
  /** 局部坐标：起点、方向、右手法向（箱位在这一侧） */
  a: Pt;
  d: Pt;
  n: Pt;
  len: number;
  rowV: number[];
  legV: number[];
  laneV: number;
  slots: number;
}
export const sectionAt = (s: RailSection, u: number, v: number): Pt => ({ x: s.a.x + s.d.x * u + s.n.x * v, z: s.a.z + s.d.z * u + s.n.z * v });

export interface ParkDoor {
  id: string;
  x: number;
  /** 墙在哪（z）、门朝哪边开（+1：场地在 +z 一侧；−1：场地在 −z 一侧） */
  wallZ: number;
  face: 1 | -1;
  cold: boolean;
  /** dc：配送中心 / 冷链中心南墙；tlBox：转运仓北面拆箱门；tlTruck：转运仓南面装卸门 */
  group: 'dc' | 'tlBox' | 'tlTruck';
  /** 收货门（配送中心前几樘） */
  receiving: boolean;
  /** 长墙的区段（同一段里两辆车不同时倒车） */
  section: number;
}
export interface ParkStall {
  id: string;
  /** 车位的中心、车头朝向（atan2(dx, dz)）、长、宽 */
  x: number;
  z: number;
  heading: number;
  len: number;
  wid: number;
}
export interface ParkLayout {
  dc: Pt;
  wallZ: number;
  doors: ParkDoor[];
  gate: Pt;
  /** 门口的登记亭：进门两条车道、出门两条车道（车停在这里登记；车头朝北 / 朝南） */
  kioskIn: Pt[];
  kioskOut: Pt[];
  /** 配送中心、冷链中心的外轮廓（x0, x1, zN, zS） */
  dcBox: { x0: number; x1: number; zN: number; zS: number };
  coldBox: { x0: number; x1: number; zN: number; zS: number };
  /** 铁路转运仓 */
  tl: { x0: number; x1: number; zN: number; zS: number; h: number };
  /** 待命停车场（直进直出的货车位）、甩挂区（挂车车头朝通道） */
  hold: { x0: number; x1: number; z0: number; z1: number; stalls: ParkStall[]; aisles: number[] };
  drop: { x0: number; x1: number; z0: number; z1: number; stalls: ParkStall[]; aisleZ: number };
  /** 园区路网的节点、路段（双向，lane = 单向） */
  nodes: Record<string, Pt>;
  edges: { a: string; b: string; oneWay?: boolean; via?: Pt[] }[];
  rail: { W: RailSection; E: RailSection };
}

/** 门的编号：配送中心 D01–D26、冷链中心 C01–C12（和调度台一样）；转运仓拆箱门 TB1–TB8、装卸门 TT01–TT10 */
const pad = (n: number) => String(n).padStart(2, '0');
const DRY_N = 26;
const COLD_N = 12;
const RECEIVING = { dry: 8, cold: 4 };
/** 转运仓（越库仓）：铁路侧拆箱门 6 樘、汽车侧装卸门 12 樘（出：入 ≈ 2：1，装车的工作量约是卸车的两倍；按公开资料取的假设参数） */
const TL_BOX_DOORS = 6;
const TL_TRUCK_DOORS = 12;
const SECTION_SPAN = 70;

let cached: { key: string; layout: ParkLayout } | undefined;

/** 物流园的布局（按当前区域的铁路和坐标系；换区域时重算） */
export function parkLayout(tracks = 2): ParkLayout {
  const key = `${tracks}|${FRAMES.park.w.x},${FRAMES.park.w.z},${FRAMES.park.rot}|${RAIL.length}|${RAIL_DC_INDEX}|${RAIL[RAIL_DC_INDEX]?.x},${RAIL[RAIL_DC_INDEX]?.y}`;
  if (cached?.key === key) return cached.layout;
  const dc = { x: LOCAL.park.node.x * 100, z: -LOCAL.park.node.y * 100 };
  const wallZ = dc.z - 75;
  const doors: ParkDoor[] = [];
  for (let i = 0; i < DRY_N; i++) doors.push({ id: `D${pad(i + 1)}`, x: dc.x - 120 + i * 10, wallZ, face: 1, cold: false, group: 'dc', receiving: i < RECEIVING.dry, section: 0 });
  for (let i = 0; i < COLD_N; i++) doors.push({ id: `C${pad(i + 1)}`, x: dc.x + 196 + i * 11, wallZ, face: 1, cold: true, group: 'dc', receiving: i < RECEIVING.cold, section: 0 });
  // 转运仓：配送中心西边（库房 136 × 50 米、净高 11 米）；北面对着铁路货运站（拆箱门，骨架车倒进来），南面对着货车场（装卸门）；
  // 两面的门里各有 16–23 米深的暂存道，中间对接（I 形越库仓）
  const tl = { x0: dc.x - 288, x1: dc.x - 152, zN: dc.z - 185, zS: dc.z - 135, h: 11 };
  for (let i = 0; i < TL_BOX_DOORS; i++) doors.push({ id: `TB${i + 1}`, x: tl.x0 + 16 + i * 20.8, wallZ: tl.zN, face: -1, cold: false, group: 'tlBox', receiving: true, section: 0 });
  for (let i = 0; i < TL_TRUCK_DOORS; i++) doors.push({ id: `TT${pad(i + 1)}`, x: tl.x0 + 16 + i * 10, wallZ: tl.zS, face: 1, cold: i >= TL_TRUCK_DOORS - 2, group: 'tlTruck', receiving: i < 4, section: 0 });
  // 长墙分段：从最西的门起每 70 米一段
  for (const g of ['dc', 'tlBox', 'tlTruck'] as const) {
    const list = doors.filter((d) => d.group === g).sort((a, b) => a.x - b.x);
    const x0 = list[0]?.x ?? 0;
    for (const d of list) d.section = Math.floor((d.x - x0) / SECTION_SPAN);
  }
  // 待命停车场：转运仓西边，两排直进直出的货车位（4.6 × 22 米），车头朝南
  const hold = { x0: dc.x - 420, x1: dc.x - 314, z0: dc.z - 205, z1: dc.z - 112, stalls: [] as ParkStall[], aisles: [] as number[] };
  const holdRows = [dc.z - 190, dc.z - 148];
  hold.aisles = [dc.z - 202, dc.z - 169, dc.z - 127];
  holdRows.forEach((zc, r) => {
    for (let i = 0; i < 18; i++) hold.stalls.push({ id: `H${r * 18 + i + 1}`, x: hold.x0 + 6 + i * 4.6, z: zc, heading: 0, len: 22, wid: 4.6 });
  });
  // 甩挂区：转运仓货车场的南边，两排车位（4 × 17.5 米）车头朝中间的通道
  const drop = { x0: dc.x - 285, x1: dc.x - 160, z0: dc.z - 85, z1: dc.z - 31, stalls: [] as ParkStall[], aisleZ: dc.z - 58 };
  for (let i = 0; i < 30; i++) drop.stalls.push({ id: `P${i + 1}`, x: drop.x0 + 3 + i * 4, z: dc.z - 75.5, heading: 0, len: 17.5, wid: 4 });
  for (let i = 0; i < 30; i++) drop.stalls.push({ id: `P${i + 31}`, x: drop.x0 + 3 + i * 4, z: dc.z - 40.5, heading: Math.PI, len: 17.5, wid: 4 });
  const rail = railSections(tracks);
  // 园区路网：门口 → 南侧场内路 → 西侧场内路（双向 8 米）。短驳和提箱的车走逆时针单向的环线（左舵车左转，司机在弯道内侧）：
  // 月台前的车场 → 配送中心和冷链中心之间的通道北上 → 配送中心背后的北侧路西行（两段站台的集卡道从它分出去、并回来）→
  // 西侧场内路南下 → 南侧场内路东行
  const NV = rail.W.legV[1] as number;
  const NE = rail.E.legV[1] as number;
  const xW = dc.x - 302;
  const xGap = dc.x + 170;
  const nodes: Record<string, Pt> = {
    gate: { x: dc.x + 4, z: dc.z - 26 },
    rsE: { x: dc.x - 20, z: dc.z - 26 },
    rsMid: { x: dc.x - 155, z: dc.z - 26 },
    rsW: { x: xW, z: dc.z - 26 },
    dropW: { x: xW, z: dc.z - 58 },
    truckCourt: { x: xW, z: dc.z - 108 },
    holdOut: { x: xW, z: dc.z - 127 },
    holdIn: { x: xW, z: dc.z - 202 },
    boxCourt: { x: xW, z: dc.z - 212 },
    // 月台前的车场：靠台车道（离墙 30 米）从西头向东走（左舵车，墙在司机一侧，从司机一侧倒车靠台）
    courtW: { x: dc.x - 155, z: wallZ + 30 },
    courtG: { x: dc.x + 4, z: wallZ + 30 },
    courtE: { x: xGap - 10, z: wallZ + 30 },
    gapS: { x: xGap, z: wallZ + 22 },
    gapN: { x: xGap, z: dc.z - 222 },
    laneEntryE: sectionAt(rail.E, rail.E.len + 18, rail.E.laneV),
    behindE: { x: xGap - 18, z: dc.z - 238 },
    laneExitE: sectionAt(rail.E, 26, NE + 8),
    laneEntryW: sectionAt(rail.W, rail.W.len - 4, NV + 8),
    northMid: sectionAt(rail.W, 160, NV + 8),
    northW: sectionAt(rail.W, 30, NV + 8),
    laneExitW: sectionAt(rail.W, -30, rail.W.laneV + 2),
    // 转运仓北面的拆箱车场：从东头进、向西走（墙在司机一侧），从西头出
    boxCourtE: { x: tl.x1 + 4, z: tl.zN - 24 },
  };
  const edges: ParkLayout['edges'] = [
    { a: 'gate', b: 'rsE' },
    { a: 'rsE', b: 'rsMid' },
    { a: 'rsMid', b: 'rsW' },
    { a: 'rsW', b: 'dropW' },
    { a: 'dropW', b: 'truckCourt' },
    { a: 'truckCourt', b: 'holdOut' },
    { a: 'holdOut', b: 'holdIn' },
    { a: 'holdIn', b: 'boxCourt' },
    { a: 'rsMid', b: 'courtW' },
    { a: 'courtW', b: 'courtG' },
    { a: 'courtG', b: 'courtE' },
    { a: 'courtE', b: 'gapS', oneWay: true },
    { a: 'gapS', b: 'gapN', oneWay: true },
    { a: 'gapN', b: 'behindE', oneWay: true },
    { a: 'behindE', b: 'laneExitE', oneWay: true, via: [{ x: dc.x - 40, z: dc.z - 238 }] },
    { a: 'laneExitE', b: 'laneEntryW', oneWay: true },
    { a: 'laneEntryW', b: 'northMid', oneWay: true },
    { a: 'northMid', b: 'northW', oneWay: true },
    { a: 'northW', b: 'boxCourt', oneWay: true },
    { a: 'northMid', b: 'boxCourtE', oneWay: true },
    { a: 'boxCourtE', b: 'boxCourt', oneWay: true },
    { a: 'laneExitW', b: 'boxCourt', oneWay: true, via: [sectionAt(rail.W, -34, NV + 10)] },
  ];
  const layout: ParkLayout = {
    dc,
    wallZ,
    doors,
    gate: { x: dc.x, z: dc.z - 6 },
    kioskIn: [{ x: dc.x + 6, z: dc.z - 16 }, { x: dc.x + 13, z: dc.z - 16 }],
    kioskOut: [{ x: dc.x - 8, z: dc.z - 12 }, { x: dc.x - 15, z: dc.z - 12 }],
    dcBox: { x0: dc.x - 140, x1: dc.x + 160, zN: dc.z - 225, zS: wallZ },
    coldBox: { x0: dc.x + 180, x1: dc.x + 340, zN: dc.z - 175, zS: wallZ },
    tl,
    hold,
    drop,
    nodes,
    edges,
    rail,
  };
  cached = { key, layout };
  return layout;
}

/** 铁路货运站两段站台（局部坐标）：西段（港口班列）、东段（洲际班列）；和三维 view.ts 取的两段直线一样 */
function railSections(tracks: number): { W: RailSection; E: RailSection } {
  const pts = RAIL.map((k) => toLocal(FRAMES.park, { x: k.x * 100, z: -k.y * 100 }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).z - (pts[i - 1] as Pt).z));
  const at = (s: number): Pt => {
    const d = Math.max(0, Math.min(cum[cum.length - 1] as number, s));
    let i = 1;
    while (i < pts.length - 1 && (cum[i] as number) < d) i++;
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const seg = (cum[i] as number) - (cum[i - 1] as number) || 1;
    const k = (d - (cum[i - 1] as number)) / seg;
    return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
  };
  const st = cum[RAIL_DC_INDEX] ?? 0;
  const g = railGeometry(tracks, true);
  const make = (key: 'W' | 'E', title: string, a: Pt, b: Pt): RailSection => {
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    return { key, title, a, d, n: { x: -d.z, z: d.x }, len, ...g, slots: Math.max(1, Math.floor(len / RAIL_YARD.slotU)) };
  };
  const S = pts.length ? at(st) : { x: 1020, z: -1620 };
  const west = pts.length ? at(st - RAIL_YARD.len) : { x: 807, z: -1590 };
  const east = pts.length ? at(st + RAIL_YARD.len) : { x: 1235, z: -1631 };
  return { W: make('W', '港口班列站台', west, S), E: make('E', '洲际班列站台', S, east) };
}

/** 园区路网上从 a 到 b 的路（节点折线；单向路段只能顺着走） */
export function parkRoute(L: ParkLayout, a: string, b: string): Pt[] {
  if (a === b) return [L.nodes[a] as Pt];
  const adj = new Map<string, { to: string; pts: Pt[]; len: number }[]>();
  const add = (x: string, y: string, via: Pt[]) => {
    const pts = [L.nodes[x] as Pt, ...via, L.nodes[y] as Pt];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).z - (pts[i - 1] as Pt).z);
    const list = adj.get(x) ?? [];
    list.push({ to: y, pts, len });
    adj.set(x, list);
  };
  for (const e of L.edges) {
    add(e.a, e.b, e.via ?? []);
    if (!e.oneWay) add(e.b, e.a, [...(e.via ?? [])].reverse());
  }
  const dist = new Map<string, number>([[a, 0]]);
  const prev = new Map<string, { from: string; pts: Pt[] }>();
  const open = new Set<string>([a]);
  while (open.size) {
    let cur = '';
    let best = Infinity;
    for (const k of open) if ((dist.get(k) ?? Infinity) < best) [cur, best] = [k, dist.get(k) as number];
    open.delete(cur);
    if (cur === b) break;
    for (const e of adj.get(cur) ?? []) {
      const nd = best + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: cur, pts: e.pts });
        open.add(e.to);
      }
    }
  }
  if (!prev.has(b)) return [L.nodes[a] as Pt, L.nodes[b] as Pt];
  const parts: Pt[][] = [];
  for (let k = b; k !== a; ) {
    const p = prev.get(k) as { from: string; pts: Pt[] };
    parts.unshift(p.pts);
    k = p.from;
  }
  const out: Pt[] = [];
  for (const p of parts) for (const q of p) if (!out.length || Math.hypot(q.x - (out[out.length - 1] as Pt).x, q.z - (out[out.length - 1] as Pt).z) > 0.05) out.push(q);
  return out;
}
export const polyLen = (pts: readonly Pt[]): number => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).z - (pts[i - 1] as Pt).z);
  return s;
};

/** 门前的场内点（车从这里开过门、再倒车靠台）：门前 34 米的车道上 */
export const doorApproach = (d: ParkDoor): Pt => ({ x: d.x, z: d.wallZ + d.face * 34 });
/** 门在路网上的接入点：车从这里沿靠台车道开过门（墙在司机一侧）再倒车靠台 */
export function doorNode(L: ParkLayout, d: ParkDoor): string {
  if (d.group === 'tlBox') return 'boxCourtE';
  if (d.group === 'tlTruck') return 'truckCourt';
  return d.x > (L.nodes.courtE as Pt).x ? 'courtE' : 'courtW';
}

// ———————————————————————— 计划 ————————————————————————

export interface ParkBooking {
  door: string;
  t0: number;
  t1: number;
  mode: 'load' | 'unload';
}
export interface ParkInput {
  vehicles: readonly WVehicle[];
  /** 仿真的地点 → 门（DC#3 = D04、DCC#1 = C02）：和三维、调度台用的同一个 */
  doorOf: (vid: number, key: string) => string | undefined;
  /** 调度台的月台门预约（排队等门、提前装好的挂车按它）；没有就按仿真的时刻 */
  bookings?: readonly ParkBooking[];
  palletsOf?: (vid: number) => number | undefined;
  /** 仿真车对应的调度台作业编号（值班助手按它把排队、靠台时间接到那一趟车上） */
  opOf?: (vid: number) => string | undefined;
  seed: number;
  /** 背景流量倍数（负荷档位的 traffic：平常 1、旺季 1.4、高负荷 2、极限 2.8） */
  traffic?: number;
  /** 铁路货运站的装卸线股数（设施配置） */
  tracks?: number;
  /** 开放的月台门数（设施配置；关掉的门不排） */
  open?: { dry: number; cold: number };
}

/** 一段动作：在哪停、开哪条路、倒车靠台、挂 / 摘挂车、龙门吊装卸、等着 */
export interface Leg {
  t0: number;
  t1: number;
  kind: 'park' | 'drive' | 'back' | 'pull' | 'hook' | 'unhook' | 'xfer' | 'kiosk' | 'hold' | 'work';
  /** drive：路网上的折线；back / pull / work / hook：门或车位；xfer：集卡道上的位置 */
  path?: Pt[];
  door?: string;
  stall?: string;
  /** 集卡道上停的位置：哪段站台、u */
  lane?: { section: 'W' | 'E'; u: number };
  /** 拖着什么（骨架车带不带箱、挂车空 / 满）；没有 = 光车头 */
  tow?: Tow;
  note?: string;
}
export interface Tow {
  kind: 'chassis' | 'trailer';
  /** 骨架车上的箱号、颜色、是不是本店的、空箱 */
  box?: string;
  color?: string;
  own?: boolean;
  empty?: boolean;
  /** 挂车：编号、装满了没有、冷藏挂车 */
  trailer?: string;
  loaded?: boolean;
  reefer?: boolean;
}
export interface Actor {
  id: string;
  kind: 'shuttle' | 'shunter' | 'truck' | 'dray' | 'carrier';
  label: string;
  own: boolean;
  legs: Leg[];
  /** 从园区门口进来、出去的时刻（场内车辆：undefined） */
  gateIn?: number;
  gateOut?: number;
  /** 进来走哪条路（南、西、东）、出去走哪条 */
  road?: { in: number; out: number };
}

/** 本店的仿真车在物流园里的一次访问 */
export interface SimVisit {
  vid: number;
  /** 车在这个门上的那一段轨迹（WVehicle.segs 的下标）、调度台的作业编号 */
  stop: number;
  op?: string;
  label: string;
  door: string;
  mode: 'load' | 'unload';
  pallets: number;
  cold: boolean;
  /** 仿真：到园区（进门登记）、开始拉出离开 */
  arrive: number;
  leave: number;
  checkIn: [number, number];
  /** 在待命停车场等门 */
  hold?: { stall: string; t0: number; t1: number };
  /** 门上的时段：靠稳 → 拉出 */
  dockAt: [number, number];
  /** 甩挂：挂车提前装好放在甩挂区，车头来了挂上就走 */
  drop?: { trailer: string; stall: string; spotAt: number; loadedAt: number; parkedAt: number; hookAt: number };
  tight: boolean;
}
export interface RailBox {
  id: string;
  train?: number;
  trainLabel: string;
  section: 'W' | 'E';
  color: string;
  own: boolean;
  /** 箱位（u、v、层）、落到箱位的时刻（估计）、被提走的时刻 */
  slot: { u: number; v: number; tier: number };
  landAt: number;
  pickAt?: number;
  /** 去向：本店配送中心拆箱、转运仓拆箱、外来集卡整箱提走、留在站里 */
  dest: 'dc' | 'tl' | 'road' | 'stay';
  door?: string;
  devan?: [number, number];
  pallets: number;
  /** 空箱回到箱位 */
  emptyAt?: number;
  emptySlot?: { u: number; v: number; tier: number };
  /** 当天一早就在箱位上的箱（前几天到的） */
  background?: boolean;
}
/** 龙门吊把箱放到集卡道上的车上（out）或从车上放回箱位（in） */
export interface Transfer {
  box: string;
  t0: number;
  t1: number;
  dir: 'out' | 'in';
  slot: { u: number; v: number; tier: number };
  /** 车停在集卡道的哪个位置（u） */
  laneU: number;
  color: string;
  empty: boolean;
}
export interface DoorUse {
  door: string;
  t0: number;
  t1: number;
  who: string;
  kind: 'sim' | 'devan' | 'load' | 'unload' | 'drop';
  own: boolean;
}
export interface ParkPlan {
  layout: ParkLayout;
  sims: SimVisit[];
  boxes: RailBox[];
  actors: Actor[];
  transfers: { W: Transfer[]; E: Transfer[] };
  doorUse: DoorUse[];
  /** 甩挂区每个车位上的挂车（时段） */
  trailers: { id: string; stall: string; t0: number; t1: number; loaded: boolean; reefer: boolean; own: boolean }[];
  /** 转运仓暂存道上的托盘（5 分钟一格） */
  staging: Float32Array;
  hub: HubDay;
  notes: string[];
}

/** 时长（秒）：进门登记、出门登记、半挂车倒车靠台、骨架车倒车、挂 / 摘、龙门吊放一箱、拆箱、装车、卸车 */
export const T = { checkIn: 90, checkOut: 45, back: 100, backBox: 75, pull: 50, hook: 60, unhook: 45, xfer: 150, devanOwn: 36 * 60, devan: [45 * 60, 65 * 60] as [number, number], load: 35 * 60, unload: 30 * 60, prep: 120 };
/** 场内车速（米 / 秒）：牵引车、货车 */
const V_YARD = 4.5;
const V_TRUCK = 4.0;

function rand(seed: number): () => number {
  let a = (Math.floor(Math.abs(seed)) * 2654435761 + 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 和区域车辆层同一组的别家箱颜色、本店的箱 */
const TRAIN_BOX = ['#c0392b', '#2471a3', '#1e8449', '#d35400', '#7d3c98', '#566573', '#a04000', '#2e86c1', '#f0b27a', '#16a085'];
export const OWN_BOX = '#1d6fe0';

/** 一个门的占用表：按时段排，不重叠（两次之间至少留 gap 秒） */
class DoorBook {
  readonly uses = new Map<string, DoorUse[]>();
  /** 每个区段倒车 / 拉出的时段（同一段里两辆车不同时调车） */
  private readonly moves = new Map<string, [number, number][]>();
  constructor(private readonly L: ParkLayout) {}
  free(door: string, t0: number, t1: number, gap = 240): boolean {
    return (this.uses.get(door) ?? []).every((u) => u.t1 + gap <= t0 || t1 + gap <= u.t0);
  }
  private secKey(door: string): string {
    const d = this.L.doors.find((x) => x.id === door);
    return d ? `${d.group}:${d.section}` : door;
  }
  moveFree(door: string, t0: number, t1: number): boolean {
    return (this.moves.get(this.secKey(door)) ?? []).every(([a, b]) => b <= t0 || t1 <= a);
  }
  addMove(door: string, t0: number, t1: number): void {
    const k = this.secKey(door);
    const l = this.moves.get(k) ?? [];
    l.push([t0, t1]);
    this.moves.set(k, l);
  }
  add(u: DoorUse): void {
    const l = this.uses.get(u.door) ?? [];
    l.push(u);
    l.sort((a, b) => a.t0 - b.t0);
    this.uses.set(u.door, l);
  }
  /** 在这几个门里找最早能用的：从 ready 起占 dur 秒（前后倒车各 back 秒不和同段别的车撞） */
  find(doors: readonly string[], ready: number, dur: number, back: number, step = 120, horizon = 30 * 3600): { door: string; t0: number } | undefined {
    for (let t = ready; t < ready + horizon; t += step)
      for (const d of doors) if (this.free(d, t - back, t + dur + back) && this.moveFree(d, t - back, t) && this.moveFree(d, t + dur, t + dur + back)) return { door: d, t0: t };
    return undefined;
  }
  all(): DoorUse[] {
    return [...this.uses.values()].flat().sort((a, b) => a.t0 - b.t0);
  }
}

/** 车位表：每个车位的占用时段 */
class Stalls {
  readonly use = new Map<string, [number, number][]>();
  constructor(readonly ids: readonly string[]) {}
  free(id: string, t0: number, t1: number): boolean {
    return (this.use.get(id) ?? []).every(([a, b]) => b <= t0 || t1 <= a);
  }
  take(t0: number, t1: number, prefer = 0): string | undefined {
    for (let k = 0; k < this.ids.length; k++) {
      const id = this.ids[(prefer + k) % this.ids.length] as string;
      if (this.free(id, t0, t1)) {
        this.book(id, t0, t1);
        return id;
      }
    }
    return undefined;
  }
  book(id: string, t0: number, t1: number): void {
    const l = this.use.get(id) ?? [];
    l.push([t0, t1]);
    this.use.set(id, l);
  }
  /** 车位上那一段（从 t0 起）提前结束：挂车被拖走了 */
  release(id: string, t0: number, t1: number): void {
    const e = this.use.get(id)?.find(([a]) => Math.abs(a - t0) < 1e-6);
    if (e) e[1] = t1;
  }
}

/** 场内行驶用时：路程 / 车速 + 每个拐弯 6 秒 */
function driveTime(pts: readonly Pt[], v: number): number {
  let turns = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    const h1 = Math.atan2(b.x - a.x, b.z - a.z);
    const h2 = Math.atan2(c.x - b.x, c.z - b.z);
    let d = Math.abs(h2 - h1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > 0.5) turns++;
  }
  return polyLen(pts) / v + turns * 6 + 8;
}

/** 列车在站的作业：本店的仿真列车（港口班列卸在西段、洲际班列卸在东段），和 view.ts 的 setRailDay 一样数箱 */
function trainWorks(vehicles: readonly WVehicle[]): { vid: number; label: string; section: 'W' | 'E'; t0: number; t1: number; boxes: { id: string; k: number; own: boolean; color: string }[] }[] {
  const out: ReturnType<typeof trainWorks> = [];
  for (const v of vehicles) {
    if (v.kind !== 'train' || /背景/.test(v.label)) continue;
    const unload = v.segs.find((sg) => sg.act === '在货运站卸箱');
    const dwell = v.segs.find((sg) => /在物流园货运站/.test(sg.act ?? ''));
    const id = (i: number) => `SXCU ${String(700000 + v.id * 20 + i + 1)}`;
    if (unload) {
      const n = Math.min(RAIL_YARD.wagons, Number(/(\d+) 箱/.exec(v.label)?.[1] ?? 1));
      out.push({ vid: v.id, label: v.label, section: 'W', t0: unload.t0, t1: unload.t1, boxes: Array.from({ length: n }, (_, i) => ({ id: id(i), k: i + 1, own: true, color: OWN_BOX })) });
    }
    if (dwell) {
      const mine = Number(/本店 (\d+) 箱/.exec(v.label)?.[1] ?? 0);
      out.push({ vid: v.id, label: v.label, section: 'E', t0: dwell.t0, t1: dwell.t1, boxes: Array.from({ length: RAIL_YARD.wagons }, (_, i) => ({ id: id(i), k: i + 1, own: i + 1 <= mine, color: i + 1 <= mine ? OWN_BOX : (TRAIN_BOX[(v.id + i + 1) % TRAIN_BOX.length] as string) })) });
    }
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/** 箱位表：每个位置（u 下标、排、层）的占用时段 */
class SlotMap {
  private readonly use = new Map<string, [number, number][]>();
  constructor(private readonly s: RailSection) {}
  private key(c: number, r: number, tier: number) {
    return `${c}:${r}:${tier}`;
  }
  free(c: number, r: number, tier: number, t0: number, t1: number): boolean {
    return (this.use.get(this.key(c, r, tier)) ?? []).every(([a, b]) => b <= t0 || t1 <= a);
  }
  book(c: number, r: number, tier: number, t0: number, t1: number): void {
    const k = this.key(c, r, tier);
    const l = this.use.get(k) ?? [];
    l.push([t0, t1]);
    this.use.set(k, l);
  }
  /** 改一个已经订的时段的结束（箱被提走的时刻定下来以后） */
  setEnd(slot: { u: number; v: number; tier: number }, t0: number, t1: number): void {
    const c = Math.round((slot.u - RAIL_YARD.slotU / 2) / RAIL_YARD.slotU);
    const r = this.s.rowV.indexOf(slot.v);
    const l = this.use.get(this.key(c, r, slot.tier));
    const e = l?.find(([a]) => Math.abs(a - t0) < 1e-6);
    if (e) e[1] = t1;
  }
  /** 第一个能从 t0 一直放到 t1 的位置（底层没箱时不能放上层）；按顺序扫（和龙门吊的卸车顺序一样） */
  next(t0: number, t1: number, order: 'seq' | 'far' = 'seq'): { u: number; v: number; tier: number } | undefined {
    const rows = this.s.rowV.length;
    const n = this.s.slots;
    for (let tier = 0; tier < RAIL_YARD.tiers; tier++)
      for (let r = order === 'far' ? rows - 1 : 0; order === 'far' ? r >= 0 : r < rows; order === 'far' ? r-- : r++)
        for (let k = 0; k < n; k++) {
          const c = order === 'far' ? n - 1 - k : k;
          if (!this.free(c, r, tier, t0, t1)) continue;
          if (tier > 0 && this.free(c, r, tier - 1, t0, t1)) continue;
          this.book(c, r, tier, t0, t1);
          return { u: RAIL_YARD.slotU / 2 + c * RAIL_YARD.slotU, v: this.s.rowV[r] as number, tier };
        }
    return undefined;
  }
}

/** 时段表（龙门吊、集卡道、登记亭）：订过的时段不重叠 */
class Spans {
  readonly list: [number, number][] = [];
  free(t0: number, t1: number): boolean {
    return this.list.every(([a, b]) => b <= t0 || t1 <= a);
  }
  add(t0: number, t1: number): void {
    this.list.push([t0, t1]);
  }
  /** 从 t 起第一个能放下 dur 秒的时刻 */
  next(t: number, dur: number): number {
    let x = t;
    for (let k = 0; k < 500; k++) {
      let end = -Infinity;
      for (const [a, b] of this.list) if (b > x && x + dur > a) end = Math.max(end, b);
      if (end === -Infinity) return x;
      x = end;
    }
    return x;
  }
  /** 和 [t0, t1) 冲突的时段里最晚的结束（没有冲突返回 undefined） */
  clash(t0: number, t1: number): number | undefined {
    let end: number | undefined;
    for (const [a, b] of this.list) if (b > t0 && t1 > a) end = Math.max(end ?? -Infinity, b);
    return end;
  }
}

/** 停车位（待命停车场、甩挂区）在三维里的点：车位中心；倒进去以前停在通道上的点；开出来停在通道上的点 */
function stallPoints(L: ParkLayout, id: string): { c: Pt; setup: Pt; out: Pt; drop: boolean } {
  const s = L.drop.stalls.find((x) => x.id === id) ?? L.hold.stalls.find((x) => x.id === id);
  if (!s) return { c: L.nodes.dropW as Pt, setup: L.nodes.dropW as Pt, out: L.nodes.dropW as Pt, drop: true };
  const drop = L.drop.stalls.includes(s);
  // 待命停车场直进直出：从北头开进去、牵引销停在车位南半边（挂车跟着摆直），走的时候往前开出南头
  if (!drop) return { c: { x: s.x, z: s.z + 5 }, setup: { x: s.x, z: s.z - s.len / 2 - 8 }, out: { x: s.x, z: s.z + s.len / 2 + 6 }, drop };
  return { c: { x: s.x, z: s.z }, setup: { x: s.x + 18, z: L.drop.aisleZ }, out: { x: s.x - 2, z: L.drop.aisleZ }, drop };
}
/** 门前倒车的起点（开过门、车头外摆以后停的点）、拉出来停的点 */
export const doorSetup = (d: ParkDoor): Pt => (d.face > 0 ? { x: d.x + 20, z: d.wallZ + 30 } : { x: d.x - 20, z: d.wallZ - 24 });
export const doorOut = (d: ParkDoor): Pt => (d.face > 0 ? { x: d.x - 2, z: d.wallZ + 36 } : { x: d.x + 2, z: d.wallZ - 27 });
export const doorDock = (d: ParkDoor): Pt => ({ x: d.x, z: d.wallZ + d.face * 9 });

/** 场内的一辆车（牵引车、货车）：一段段动作首尾相接，不会瞬移 */
class Mover {
  readonly legs: Leg[] = [];
  t: number;
  pos: Pt;
  node: string | undefined;
  at: { door?: string; stall?: string; lane?: { section: 'W' | 'E'; u: number } } = {};
  tow: Tow | undefined;
  constructor(
    private readonly L: ParkLayout,
    t: number,
    node: string,
    tow?: Tow,
  ) {
    this.t = t;
    this.node = node;
    this.pos = { ...(L.nodes[node] as Pt) };
    this.tow = tow;
  }
  private leg(kind: Leg['kind'], t1: number, extra: Partial<Leg> = {}): void {
    if (t1 <= this.t + 1e-6) return;
    this.legs.push({ t0: this.t, t1, kind, ...(this.at.door ? { door: this.at.door } : {}), ...(this.at.stall ? { stall: this.at.stall } : {}), ...(this.at.lane ? { lane: this.at.lane } : {}), ...(this.tow ? { tow: this.tow } : {}), ...extra });
    this.t = t1;
  }
  wait(until: number, kind: 'park' | 'hold' = 'park', note?: string): void {
    this.leg(kind, until, { path: [{ ...this.pos }], ...(note ? { note } : {}) });
  }
  /** 沿给的折线开过去（第一个点就是现在的位置） */
  go(pts: readonly Pt[], v: number, node?: string, note?: string): void {
    const path: Pt[] = [{ ...this.pos }];
    for (const q of pts) if (Math.hypot(q.x - (path[path.length - 1] as Pt).x, q.z - (path[path.length - 1] as Pt).z) > 0.3) path.push({ x: q.x, z: q.z });
    if (path.length < 2) {
      this.node = node ?? this.node;
      return;
    }
    this.at = {};
    this.leg('drive', this.t + driveTime(path, v), { path, ...(note ? { note } : {}) });
    this.pos = { ...(path[path.length - 1] as Pt) };
    this.node = node;
  }
  /** 沿路网开到节点 */
  drive(to: string, v = V_YARD): void {
    if (this.node === to && Math.hypot(this.pos.x - (this.L.nodes[to] as Pt).x, this.pos.z - (this.L.nodes[to] as Pt).z) < 0.5) return;
    this.go(this.route(to), v, to);
  }
  /** 沿路网开到节点要多久（不动） */
  timeTo(to: string, v = V_YARD): number {
    return driveTime([this.pos, ...this.route(to)], v);
  }
  /** 从现在的位置到节点的路：在节点上就从它走；不在节点上（刚拉出来）就挑一个附近的节点，到它的距离加路网上的路最短（不掉头） */
  private route(to: string): Pt[] {
    if (this.node) return parkRoute(this.L, this.node, to);
    let best: Pt[] = [];
    let len = Infinity;
    for (const [k, q] of Object.entries(this.L.nodes)) {
      const d0 = Math.hypot(q.x - this.pos.x, q.z - this.pos.z);
      if (d0 > 260 || !this.L.edges.some((e) => e.a === k || e.b === k)) continue;
      const r = parkRoute(this.L, k, to);
      const l = d0 + polyLen(r) + (r.length === 2 && k !== to && polyLen(r) > 400 ? 1e6 : 0);
      if (l < len) [len, best] = [l, r];
    }
    return best.length ? best : parkRoute(this.L, nearestNode(this.L, this.pos), to);
  }
  back(target: { door?: string; stall?: string }, dur: number, dock: Pt): void {
    this.at = { ...target };
    this.leg('back', this.t + dur, { path: [{ ...this.pos }, dock] });
    this.pos = { ...dock };
  }
  pull(dur: number, to: Pt, node: string | undefined): void {
    this.leg('pull', this.t + dur, { path: [{ ...this.pos }, to] });
    this.pos = { ...to };
    this.at = {};
    this.node = node;
  }
  hook(tow: Tow, dur: number): void {
    this.leg('hook', this.t + dur, { path: [{ ...this.pos }], tow });
    this.tow = tow;
  }
  unhook(dur: number): void {
    this.leg('unhook', this.t + dur, { path: [{ ...this.pos }] });
    this.tow = undefined;
  }
  still(kind: 'xfer' | 'kiosk' | 'work', dur: number, extra: Partial<Leg> = {}): void {
    this.leg(kind, this.t + dur, { path: [{ ...this.pos }], ...extra });
  }
  actor(a: Omit<Actor, 'legs'>): Actor {
    return { ...a, legs: this.legs };
  }
}
/**
 * 场内车（短驳牵引车、场内牵引车）闲下来的时候不停在路上、门前：沿场内路空跑回待命停车场的车位（从北口进、车头朝南停），
 * 下一单之前从南口出来、沿场内路直接开到下一单要去的地方（和原来同一时刻到）。闲着的一段（停着、不在门 / 车位 / 集卡道上）
 * 超过 12 分钟、来回的路上走得开才去；车位按待命停车场的空档挑（货车先挑，不和它们抢）。一早、收工以后也停在车位上。
 */
function restYard(L: ParkLayout, actors: Actor[], stalls: Stalls, end: number): void {
  const IDLE = 200;
  const nodeAt = (q: Pt) => Object.keys(L.nodes).find((k) => Math.hypot((L.nodes[k] as Pt).x - q.x, (L.nodes[k] as Pt).z - q.z) < 0.5 && L.edges.some((e) => e.a === k || e.b === k));
  const hin = L.nodes.holdIn as Pt;
  const hout = L.nodes.holdOut as Pt;
  actors.forEach((a, ai) => {
    // 场内车，还有在门前、甩挂区通道里等的外来车（承运商的车头、别家的货车）：等得久的都进待命停车场的车位等
    const yardCar = a.kind === 'shuttle' || a.kind === 'shunter';
    if (!yardCar && a.kind !== 'carrier' && a.kind !== 'truck') return;
    const legs = a.legs;
    // 同一个地方接连停着的几段并成一段
    for (let i = legs.length - 1; i > 0; i--) {
      const x = legs[i - 1] as Leg;
      const y = legs[i] as Leg;
      if (x.kind === 'park' && y.kind === 'park' && !x.door && !x.stall && !x.lane && !y.door && !y.stall && !y.lane && Math.abs(x.t1 - y.t0) < 0.5) legs.splice(i - 1, 2, { ...x, t1: y.t1 });
    }
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i] as Leg;
      const P = l.path?.[0];
      if (l.kind !== 'park' || l.door || l.stall || l.lane || !P || l.t1 - l.t0 < IDLE || (!yardCar && (i === 0 || i === legs.length - 1))) continue;
      // 下一单：接着的几段行驶（开到哪、最后一段从哪个节点开过去）；后面直接倒车（在门前的倒车起点等着的）就开回这里，
      // 从原来开过来的那个节点过来（车头朝向和原来一样）；后面是别的（在集卡道上等吊、门上）就不走开
      let j = i + 1;
      while (j < legs.length && (legs[j] as Leg).kind === 'drive') j++;
      const last = legs[j - 1] as Leg | undefined;
      let tail = j - 1 > i && last?.path && last.path.length >= 2 ? last : undefined;
      const prevDrive = legs[i - 1]?.kind === 'drive' ? (legs[i - 1] as Leg) : undefined;
      if (!tail && legs[i + 1]?.kind === 'back' && prevDrive?.path && prevDrive.path.length >= 2) {
        // 倒车之前：回到这里（虚拟的一段：从来的那个节点开到这里，时刻是这一段等完）
        tail = { t0: l.t1, t1: l.t1, kind: 'drive', path: prevDrive.path.slice(-2) };
        j = i + 1;
      }
      if (!tail && i < legs.length - 1) continue;
      const hop = legs[i + 1]?.kind === 'drive' ? (legs[i + 1] as Leg).path?.[1] : undefined;
      const first = i === 0;
      const tow = l.tow;
      const plan = (stall: string | undefined) => {
        const sp = stallPoints(L, stall ?? (L.hold.stalls[0] as ParkStall).id);
        let inLegs: Leg[] = [];
        let tIn = l.t0;
        if (!first) {
          const m = new Mover(L, l.t0, 'holdIn', tow);
          m.pos = { ...P };
          m.node = nodeAt(P);
          // 先照原计划下一段的第一跳开到路网的节点上（不从停着的挂车中间斜穿过去）；在甩挂区通道里的先沿通道开到西头
          if (!m.node && Math.abs(P.z - L.drop.aisleZ) < 3) m.go([L.nodes.dropW as Pt], V_YARD, 'dropW');
          else if (!m.node && hop && nodeAt(hop)) m.go([hop], V_YARD, nodeAt(hop));
          m.drive('holdIn');
          m.go([{ x: hin.x - 10, z: sp.setup.z }, sp.setup, sp.c], V_YARD * 0.6, undefined, '回待命停车场');
          inLegs = m.legs;
          tIn = m.t;
        }
        let outLegs: Leg[] = [];
        let tOut = l.t1;
        if (tail?.path) {
          const m = new Mover(L, 0, 'holdIn', tow);
          m.pos = { ...sp.c };
          m.node = undefined;
          m.go([sp.out, { x: hout.x - 10, z: sp.out.z }, hout], V_YARD * 0.6, 'holdOut', '出待命停车场');
          const q = tail.path[0] as Pt;
          const qn = nodeAt(q) ?? nearestNode(L, q);
          m.drive(qn);
          m.go(qn === nodeAt(q) ? tail.path.slice(1) : tail.path, V_YARD);
          tOut = (j - 1 > i ? (legs[j - 1] as Leg).t1 : l.t1) - m.t;
          outLegs = m.legs.map((x) => ({ ...x, t0: x.t0 + tOut, t1: x.t1 + tOut }));
        } else tOut = end;
        return { sp, inLegs, outLegs, tIn, tOut };
      };
      const probe = plan(undefined);
      if (probe.tOut - probe.tIn < 180) continue;
      const stall = stalls.take(probe.tIn - 40, probe.tOut + 40, 7 + ai * 3);
      if (!stall) continue;
      const r = plan(stall);
      if (r.tOut - r.tIn < 120) {
        stalls.release(stall, probe.tIn - 40, probe.tIn - 40);
        continue;
      }
      const wait: Leg = { t0: first ? l.t0 : r.tIn, t1: r.tOut, kind: 'park', path: [{ ...r.sp.c }], ...(tow ? { tow } : {}), note: '在待命停车场待命' };
      const repl = [...r.inLegs, wait, ...r.outLegs];
      legs.splice(i, (tail ? j : i + 1) - i, ...repl);
      i += repl.length - 1;
    }
  });
}

function nearestNode(L: ParkLayout, p: Pt): string {
  let best = 'gate';
  let d = Infinity;
  for (const [k, q] of Object.entries(L.nodes)) {
    const x = Math.hypot(q.x - p.x, q.z - p.z);
    if (x < d && L.edges.some((e) => e.a === k || e.b === k)) [best, d] = [k, x];
  }
  return best;
}

/** 物流园一天的计划 */
export function planPark(input: ParkInput): ParkPlan {
  const f = Math.max(0.5, input.traffic ?? 1);
  const L = parkLayout(input.tracks ?? 2);
  const r = rand(input.seed * 7919 + 17);
  const notes: string[] = [];
  const book = new DoorBook(L);
  const doorById = new Map(L.doors.map((d) => [d.id, d]));
  const door = (id: string) => doorById.get(id) as ParkDoor;
  const openDry = new Set(L.doors.filter((d) => d.group === 'dc' && !d.cold).slice(0, input.open?.dry ?? DRY_N).map((d) => d.id));
  const actors: Actor[] = [];
  const holdStalls = new Stalls(L.hold.stalls.map((s) => s.id));
  const dropStalls = new Stalls(L.drop.stalls.map((s) => s.id));
  const kioskIn = [new Spans(), new Spans()];
  const kioskOut = [new Spans(), new Spans()];
  let kioskOutN = 0;
  const rsWait: [number, number][] = [];
  const trailers: ParkPlan['trailers'] = [];
  const END = 26 * 3600;
  const nodeOf = (id: string) => doorNode(L, door(id));

  /** 进门登记：两条进门车道，先到先登记（车在门外的路上排队，三维画到登记亭）；车停到登记亭、登记完 */
  const enter = (m: Mover, arrive: number): void => {
    const a0 = kioskIn[0]!.next(arrive, T.checkIn + 10);
    const a1 = kioskIn[1]!.next(arrive, T.checkIn + 10);
    const k = a0 <= a1 ? 0 : 1;
    const t = Math.min(a0, a1);
    // 两辆车之间留 10 秒：前一辆开走，后面排队的车挪上来
    kioskIn[k]!.add(t, t + T.checkIn + 10);
    m.pos = { ...(L.kioskIn[k] as Pt) };
    m.node = undefined;
    m.wait(t, 'hold', '在门外排队登记');
    m.still('kiosk', T.checkIn, { note: `进门登记（${k + 1} 号车道）` });
  };
  /**
   * 出门：沿出园的路开到出门车道的登记亭（最后一段顺着车道笔直开进去），登记完上路。登记亭一次只放一辆车开过来（两条车道轮流、前后隔开，
   * 开过来的车不从另一条车道上停着的车旁边斜穿）；没轮到就在出园的路上等着，不开到登记亭前面去堵着
   */
  const leave = (m: Mover, v = V_TRUCK): void => {
    m.drive('rsE', v);
    const rs = L.nodes.rsE as Pt;
    const appr = (k: number): Pt[] => {
      const q = L.kioskOut[k] as Pt;
      return [{ x: q.x, z: q.z - 10 }, q];
    };
    const lead = driveTime([rs, ...appr(0)], v * 0.6);
    const a0 = kioskOut[0]!.next(m.t + lead, T.checkOut + 15);
    const a1 = kioskOut[1]!.next(m.t + lead, T.checkOut + 15);
    const k = a0 < a1 || (a0 === a1 && kioskOutN++ % 2 === 0) ? 0 : 1;
    const t = Math.min(a0, a1);
    kioskOut[k]!.add(t, t + T.checkOut + 15);
    if (t - lead > m.t + 1) {
      // 两条车道都占着：在出园的路上排着等（前面已经有车在等就停在它后面）
      const n = rsWait.filter(([w0, w1]) => w0 < t - lead && w1 > m.t).length;
      rsWait.push([m.t, t - lead]);
      if (n > 0) {
        m.go([{ x: rs.x - 22 * n, z: rs.z }], v * 0.6, undefined);
        m.wait(Math.max(m.t, t - lead - (22 * n) / (v * 0.6)));
        m.go([rs], v * 0.6, 'rsE');
      } else m.wait(t - lead);
    }
    m.go(appr(k), v * 0.6, undefined);
    m.wait(Math.max(m.t, t));
    m.still('kiosk', T.checkOut, { note: `出门登记（${k + 1} 号车道）` });
  };
  /** 车开到门前、倒车靠台（门前要等就在原地等，算好再出发） */
  const dockAt = (m: Mover, id: string, at: number, back: number, waitHere = false): void => {
    const d = door(id);
    const node = nodeOf(id);
    const lead = m.timeTo(node, V_TRUCK) + driveTime([L.nodes[node] as Pt, doorSetup(d)], V_TRUCK);
    // 在待命位上的车算好了再出发；从门口进来的车先开到门前的车场里等（不堵门口和场内路）
    if (waitHere && at - back - lead > m.t + 1) m.wait(at - back - lead);
    m.drive(node, V_TRUCK);
    m.go([doorSetup(d)], V_YARD * 0.7, undefined);
    if (at - back > m.t + 1) m.wait(at - back);
    m.back({ door: id }, back, doorDock(d));
  };
  const pullFrom = (m: Mover, id: string): void => {
    const d = door(id);
    m.pull(T.pull, doorOut(d), nodeOf(id));
  };

  // ——— 1. 本店的仿真车：门、登记、等门、靠台、甩挂（车由区域的运动规划画，这里排门和时段） ———
  const bookings = [...(input.bookings ?? [])];
  const sims: SimVisit[] = [];
  for (const v of input.vehicles) {
    v.segs.forEach((sg, si) => {
      if (!sg.place || sg.route || sg.loop || !/^DC$|^DC#|^DCC#/.test(sg.place)) return;
      const key = input.doorOf(v.id, sg.place) ?? sg.place;
      const m = /^DC(C?)#(\d+)$/.exec(key);
      if (!m) return;
      const cold = !!m[1];
      const id = `${cold ? 'C' : 'D'}${pad(Number(m[2]) + 1)}`;
      if (!doorById.has(id)) return;
      const mode: SimVisit['mode'] = /卸|拆箱/.test(sg.act ?? '') ? 'unload' : 'load';
      const pallets = Math.max(1, Math.min(26, Math.round(input.palletsOf?.(v.id) ?? (v.kind === 'drayage' ? 21 : 24))));
      const prev = v.segs[si - 1];
      const fromRoad = !!prev && (!!prev.route || prev.pts.length > 2);
      // 调度台在这个门上的预约：和这一段重叠最多的（排队等门的晚于到达，提前装好的早于到达）
      let bk: ParkBooking | undefined;
      let best = -Infinity;
      for (const b of bookings) {
        if (b.door !== id || b.t1 < sg.t0 - 8 * 3600 || b.t0 > sg.t1 + 600) continue;
        const ov = Math.min(b.t1, sg.t1) - Math.max(b.t0, sg.t0);
        if (ov > best) [best, bk] = [ov, b];
      }
      const ci: [number, number] = fromRoad ? [sg.t0, sg.t0 + T.checkIn] : [sg.t0, sg.t0];
      if (fromRoad) kioskIn[0]!.add(ci[0], ci[1]);
      const reach = ci[1] + (fromRoad ? driveTime([L.nodes.gate as Pt, ...parkRoute(L, 'gate', nodeOf(id)), doorSetup(door(id))], V_TRUCK) + T.back : 0);
      let dock0 = Math.max(reach, bk && mode === 'unload' ? bk.t0 : -Infinity);
      const dock1 = sg.t1;
      let tight = false;
      if (dock1 - dock0 < 8 * 60) {
        dock0 = Math.max(sg.t0 + 60, dock1 - 8 * 60);
        tight = true;
      }
      const op = input.opOf?.(v.id);
      const visit: SimVisit = { vid: v.id, stop: si, ...(op ? { op } : {}), label: v.label, door: id, mode, pallets, cold, arrive: sg.t0, leave: sg.t1, checkIn: ci, dockAt: [dock0, dock1], tight };
      // 等门：登记完以后门还没轮到（调度台说要排队），先进待命停车场
      if (fromRoad && dock0 - reach > 6 * 60) {
        const t0 = ci[1] + driveTime(parkRoute(L, 'gate', 'holdIn'), V_TRUCK) + 30;
        const t1 = dock0 - T.back - driveTime([...parkRoute(L, 'holdOut', nodeOf(id)), doorSetup(door(id))], V_TRUCK) - 30;
        const stall = t1 - t0 > 120 ? holdStalls.take(t0, t1, v.id % L.hold.stalls.length) : undefined;
        if (stall) visit.hold = { stall, t0, t1 };
      }
      // 甩挂：调度台让这一车提前装好（预约比车到得早），挂车装满放到甩挂区，车头来了挂上就走
      if (mode === 'load' && bk && bk.t1 < sg.t0 - 15 * 60) {
        visit.drop = { trailer: `本店挂车 ${v.label.replace(/\s.*/, '')}-${v.id}`, stall: '', spotAt: bk.t0 - T.back, loadedAt: bk.t1, parkedAt: 0, hookAt: sg.t0 + T.checkIn + 150 };
        visit.dockAt = [bk.t0, bk.t1];
      }
      sims.push(visit);
      book.add({ door: id, t0: visit.dockAt[0] - (fromRoad || visit.drop ? T.back : 0), t1: visit.dockAt[1] + T.pull + (visit.drop ? T.hook + 120 : 0), who: v.label, kind: visit.drop ? 'drop' : 'sim', own: true });
      book.addMove(id, visit.dockAt[0] - T.back, visit.dockAt[0]);
      book.addMove(id, visit.dockAt[1], visit.dockAt[1] + T.pull);
    });
  }
  sims.sort((a, b) => a.arrive - b.arrive);

  // ——— 2. 铁路货运站的箱：今天卸下来的（本店的、别家的）+ 前几天到的别家箱（当天一早在箱位上） ———
  const works = trainWorks(input.vehicles);
  const slotMaps = { W: new SlotMap(L.rail.W), E: new SlotMap(L.rail.E) };
  const boxes: RailBox[] = [];
  const nBg = Math.round((7 + 4 * f) * (0.8 + 0.4 * r()));
  for (let i = 0; i < nBg; i++) {
    const section: 'W' | 'E' = i % 3 === 2 ? 'W' : 'E';
    const slot = slotMaps[section].next(-2 * 86400, END, 'far');
    if (!slot) continue;
    boxes.push({ id: `TGHU ${String(410000 + ((input.seed * 131 + i * 977) % 89000))}`, trainLabel: '前几天的班列', section, color: TRAIN_BOX[(i * 7 + input.seed) % TRAIN_BOX.length] as string, own: false, slot, landAt: -86400 * (1 + (i % 3)), dest: 'stay', pallets: 18 + Math.floor(r() * 7), background: true });
  }
  for (const w of works) {
    const sec = L.rail[w.section];
    const order = [...w.boxes].reverse();
    const span = Math.max(600, w.t1 - 240 - (w.t0 + 150));
    order.forEach((b, j) => {
      const landAt = w.t0 + 150 + ((j + 0.8) / order.length) * span;
      const slot = slotMaps[w.section].next(landAt, END) ?? { u: RAIL_YARD.slotU / 2, v: sec.rowV[0] as number, tier: 0 };
      boxes.push({ id: b.id, train: w.vid, trainLabel: w.label, section: w.section, color: b.color, own: b.own, slot, landAt, dest: 'stay', pallets: b.own ? 21 : 18 + Math.floor(r() * 7) });
    });
  }
  // 去向：本店的进配送中心；别家的约 6 成进转运仓拆箱、2 成多外来集卡整箱提走、其余留到明天（前几天到的先走）
  for (const b of boxes) {
    if (b.own) b.dest = 'dc';
    else {
      const x = r();
      b.dest = x < (b.background ? 0.62 : 0.55) ? 'tl' : x < (b.background ? 0.9 : 0.8) ? 'road' : 'stay';
    }
  }

  // ——— 3. 集卡道和龙门吊：列车作业时龙门吊不做集卡道的活；一段集卡道同一时间只进一辆车 ———
  const laneUse = { W: new Spans(), E: new Spans() };
  const craneUse = { W: new Spans(), E: new Spans() };
  for (const w of works) craneUse[w.section].add(w.t0 + 120, w.t1 - 200);
  const transfers: ParkPlan['transfers'] = { W: [], E: [] };
  /** 集卡道上的折线：西行，从入口开到 u、从 u 开到出口 */
  const laneIn = (s: 'W' | 'E', u: number): Pt[] => {
    const sec = L.rail[s];
    if (s === 'E') return [L.nodes.laneEntryE as Pt, sectionAt(sec, sec.len, sec.laneV), sectionAt(sec, u, sec.laneV)];
    const u1 = Math.min(u + 0.01, sec.len - 30);
    return [L.nodes.laneEntryW as Pt, sectionAt(sec, u1, sec.laneV), sectionAt(sec, u, sec.laneV)];
  };
  const laneOut = (s: 'W' | 'E', u: number): Pt[] => {
    const sec = L.rail[s];
    if (s === 'E') return [sectionAt(sec, u, sec.laneV), sectionAt(sec, Math.min(u, 46), sec.laneV), L.nodes.laneExitE as Pt];
    return [sectionAt(sec, u, sec.laneV), sectionAt(sec, -10, sec.laneV), L.nodes.laneExitW as Pt];
  };
  const entryNode = (s: 'W' | 'E') => (s === 'E' ? 'gapN' : 'laneEntryW');
  /** 订集卡道：从 ready（到入口的时刻）起，找进道、龙门吊、出道都排得下的时段 */
  const laneSlot = (s: 'W' | 'E', ready: number, u: number): { tIn: number; x0: number; tOut: number } => {
    const din = driveTime(laneIn(s, u), V_YARD * 0.6);
    const dout = driveTime(laneOut(s, u), V_YARD * 0.6);
    let t = ready;
    for (let k = 0; k < 300; k++) {
      const x0 = craneUse[s].next(t + din, T.xfer);
      const tOut = x0 + T.xfer + dout;
      const c = laneUse[s].clash(t, tOut);
      if (c === undefined) return { tIn: t, x0, tOut };
      t = c + 5;
    }
    return { tIn: t, x0: t + din, tOut: t + din + T.xfer + dout };
  };
  /** 一辆车进集卡道、龙门吊装 / 卸一个箱、出道（ready 以后最早排得下的时段；车在原地等到该出发） */
  const viaLane = (m: Mover, s: 'W' | 'E', u: number, ready: number, xfer: Transfer, after: Tow | undefined): void => {
    const toEntry = m.timeTo(entryNode(s)) + (s === 'E' ? driveTime([L.nodes.gapN as Pt, L.nodes.laneEntryE as Pt], V_YARD) : 0);
    const slot = laneSlot(s, Math.max(ready, m.t + toEntry), u);
    if (slot.tIn - toEntry > m.t + 1) m.wait(slot.tIn - toEntry);
    m.drive(entryNode(s));
    m.go(laneIn(s, u), V_YARD * 0.6, undefined, '进集卡道');
    m.at = { lane: { section: s, u } };
    if (slot.x0 > m.t + 1) m.wait(slot.x0);
    m.still('xfer', T.xfer, { note: xfer.dir === 'out' ? '龙门吊装箱' : '龙门吊卸空箱' });
    m.tow = after;
    m.at = {};
    m.go(laneOut(s, u).slice(1), V_YARD * 0.6, s === 'E' ? 'laneExitE' : 'laneExitW', '出集卡道');
    laneUse[s].add(slot.tIn, m.t);
    craneUse[s].add(slot.x0, slot.x0 + T.xfer);
    transfers[s].push({ ...xfer, t0: slot.x0, t1: slot.x0 + T.xfer });
  };

  // ——— 4. 短驳：本店的箱进配送中心收货门、别家的箱进转运仓拆箱门；短驳车拖着骨架车靠在门上等拆完（现拆），拉空箱回货运站 ———
  const nShuttle = 2 + (f >= 1.9 ? 1 : 0) + (f >= 2.7 ? 1 : 0);
  const shuttles = Array.from({ length: nShuttle }, (_, i) => new Mover(L, -3600, i % 2 ? 'boxCourt' : 'rsMid', { kind: 'chassis' }));
  const receivingDry = L.doors.filter((d) => d.group === 'dc' && d.receiving && !d.cold && openDry.has(d.id)).map((d) => d.id);
  const tlBoxDoors = L.doors.filter((d) => d.group === 'tlBox').map((d) => d.id);
  const pallIn: { t: number; n: number }[] = [];
  type Task = { box: RailBox; ready: number };
  const tasks: Task[] = [];
  for (const b of boxes) {
    if (b.dest !== 'dc' && b.dest !== 'tl') continue;
    const w = works.find((x) => x.section === b.section && x.boxes.some((y) => y.id === b.id));
    // 本店的箱：列车作业时段结束（查验、调车）以后才短驳；别家的：前几天到的白天陆续拆、今天到的晚一点
    const ready = b.background ? 6.5 * 3600 + r() * 9 * 3600 : Math.max(b.landAt + 600, (w?.t1 ?? b.landAt) + (b.own ? 300 : 1800 + r() * 3 * 3600));
    if (ready < 22.5 * 3600) tasks.push({ box: b, ready });
  }
  tasks.sort((a, b) => Number(b.box.own) - Number(a.box.own) || a.ready - b.ready);
  const standby = (m: Mover, until: number) => {
    // 空着超过 6 分钟：开到甩挂区通道西头的待命位等（不堵车场）
    if (until - m.t > 360 && m.node !== 'dropW') m.drive('dropW');
    if (until > m.t) m.wait(until);
  };
  for (const task of tasks.sort((a, b) => a.ready - b.ready)) {
    const b = task.box;
    const m = shuttles.reduce((best, x) => (x.t < best.t ? x : best), shuttles[0] as Mover);
    const dest = b.dest === 'dc' ? receivingDry : tlBoxDoors;
    const dur = b.dest === 'dc' ? T.devanOwn : T.devan[0] + r() * (T.devan[1] - T.devan[0]);
    const exitNode = b.section === 'E' ? 'laneExitE' : 'laneExitW';
    const toDoor = (id: string) => driveTime([L.nodes[exitNode] as Pt, ...parkRoute(L, exitNode, nodeOf(id)), doorSetup(door(id))], V_YARD) + T.backBox;
    // 先按门的空当倒推装箱的时刻：门要从靠台一直占到拆完拉出
    let ready = Math.max(task.ready, m.t);
    let target: { door: string; t0: number } | undefined;
    for (let k = 0; k < 6; k++) {
      const slot = laneSlot(b.section, ready + m.timeTo(entryNode(b.section)), b.slot.u);
      const arrive = slot.tOut + toDoor(dest[0] as string);
      target = book.find(dest, arrive, dur + T.pull + 120, T.backBox);
      if (!target || target.t0 - arrive < 120) break;
      ready += target.t0 - arrive;
    }
    if (!target) continue;
    standby(m, Math.max(m.t, ready - 1200));
    const tow: Tow = { kind: 'chassis', box: b.id, color: b.color, own: b.own };
    viaLane(m, b.section, b.slot.u, ready, { box: b.id, t0: 0, t1: 0, dir: 'out', slot: b.slot, laneU: b.slot.u, color: b.color, empty: false }, tow);
    const tr = transfers[b.section][transfers[b.section].length - 1] as Transfer;
    b.pickAt = (tr.t0 + tr.t1) / 2;
    slotMaps[b.section].setEnd(b.slot, b.landAt, b.pickAt);
    // 门可能比倒推的晚一点空出来：到门前再找一次
    const arrive = m.t + toDoor(target.door);
    const t2 = book.find([target.door], arrive, dur + T.pull + 120, T.backBox) ?? book.find(dest, arrive, dur + T.pull + 120, T.backBox) ?? { door: target.door, t0: arrive };
    dockAt(m, t2.door, t2.t0, T.backBox, true);
    const d0 = m.t;
    m.still('work', dur, { note: b.dest === 'dc' ? '靠在收货门上拆箱' : '靠在拆箱门上拆箱' });
    b.door = t2.door;
    b.devan = [d0, d0 + dur];
    m.tow = { kind: 'chassis', box: b.id, color: b.color, own: b.own, empty: true };
    pullFrom(m, t2.door);
    book.add({ door: t2.door, t0: d0 - T.backBox, t1: m.t, who: b.id, kind: 'devan', own: b.own });
    book.addMove(t2.door, d0 - T.backBox, d0);
    book.addMove(t2.door, m.t - T.pull, m.t);
    if (b.dest === 'tl') pallIn.push({ t: d0 + dur, n: b.pallets });
    // 空箱拉回货运站，龙门吊放回箱位
    const slot = slotMaps[b.section].next(m.t + 300, END);
    if (!slot) continue;
    viaLane(m, b.section, slot.u, m.t, { box: b.id, t0: 0, t1: 0, dir: 'in', slot, laneU: slot.u, color: b.color, empty: true }, { kind: 'chassis' });
    const ti = transfers[b.section][transfers[b.section].length - 1] as Transfer;
    b.emptyAt = (ti.t0 + ti.t1) / 2;
    b.emptySlot = slot;
  }
  shuttles.forEach((m, i) => {
    if (m.t < END) standby(m, END);
    actors.push(m.actor({ id: `SH-${i + 1}`, kind: 'shuttle', label: `短驳牵引车 ${i + 1}`, own: true }));
  });

  // ——— 5. 外来集卡整箱提走（龙门吊直接装上它的骨架车） ———
  const roadBoxes = boxes.filter((b) => b.dest === 'road');
  roadBoxes.forEach((b, i) => {
    const appt = 7 * 3600 + ((i + r()) / Math.max(1, roadBoxes.length)) * 13 * 3600;
    const arrive = Math.max(appt - 900 + r() * 1800, b.landAt + 3600);
    if (arrive > 22.5 * 3600) {
      b.dest = 'stay';
      return;
    }
    // 到的时刻往后挪到登记完正好去集卡道（不在登记亭前面等龙门吊，堵着后面登记的车）
    const mk = new Mover(L, 0, 'gate');
    mk.pos = { ...(L.kioskIn[0] as Pt) };
    mk.node = undefined;
    const toE = mk.timeTo(entryNode(b.section)) + T.checkIn + 10;
    const arrive2 = Math.max(arrive, laneSlot(b.section, arrive + toE, b.slot.u).tIn - toE);
    const m = new Mover(L, arrive2, 'gate', { kind: 'chassis' });
    enter(m, arrive2);
    // 龙门吊还没轮到：先进待命停车场的车位等（不在登记亭、场内路上等）
    {
      const probe = laneSlot(b.section, m.t + m.timeTo(entryNode(b.section)), b.slot.u);
      const fromHold = driveTime([L.nodes.holdOut as Pt, ...parkRoute(L, 'holdOut', entryNode(b.section))], V_YARD) + 60;
      const tIn = m.t + m.timeTo('holdIn', V_TRUCK) + 50;
      const tOut = probe.tIn - fromHold - 30;
      const stall = tOut - tIn > 240 ? holdStalls.take(tIn, tOut, i * 5 + 3) : undefined;
      if (stall) {
        const sp = stallPoints(L, stall);
        m.drive('holdIn', V_TRUCK);
        m.go([{ x: (L.nodes.holdIn as Pt).x - 10, z: sp.setup.z }, sp.setup, sp.c], V_TRUCK * 0.6, undefined, '进待命停车场');
        m.at = { stall };
        m.wait(Math.max(m.t, tOut), 'hold', '在待命停车场等龙门吊');
        m.at = {};
        m.go([sp.out, { x: (L.nodes.holdOut as Pt).x - 10, z: sp.out.z }, L.nodes.holdOut as Pt], V_TRUCK * 0.6, 'holdOut', '出待命停车场');
      }
    }
    const tow: Tow = { kind: 'chassis', box: b.id, color: b.color, own: false };
    viaLane(m, b.section, b.slot.u, m.t, { box: b.id, t0: 0, t1: 0, dir: 'out', slot: b.slot, laneU: b.slot.u, color: b.color, empty: false }, tow);
    const tr = transfers[b.section][transfers[b.section].length - 1] as Transfer;
    b.pickAt = (tr.t0 + tr.t1) / 2;
    slotMaps[b.section].setEnd(b.slot, b.landAt, b.pickAt);
    leave(m);
    actors.push({ ...m.actor({ id: `XD-${i + 1}`, kind: 'dray', label: `外来集卡 · 整箱提走 ${b.id}`, own: false }), gateIn: arrive, gateOut: m.t, road: { in: i % 3, out: (i + 1) % 3 } });
  });

  // ——— 6. 转运仓：公路进来的整车越库、按暂存道上的托盘约出库的车（现装 / 甩挂） ———
  const truckDoors = L.doors.filter((d) => d.group === 'tlTruck').map((d) => d.id);
  const recvDoors = truckDoors.slice(0, 4);
  const shipDoors = truckDoors.slice(4, truckDoors.length - 2);
  const coldDoors = truckDoors.slice(truckDoors.length - 2);
  /** 一辆外来货车：门口登记 →（门还占着就先进待命停车场）→ 装卸门 → 出门登记 */
  const truckVisit = (id: string, label: string, appt: number, early: number, doors: readonly string[], dur: number, kind: 'load' | 'unload', reefer: boolean, k: number): { a: Actor; door: string; t0: number; t1: number } | undefined => {
    const arrive = appt - early;
    if (arrive > 23.6 * 3600 || arrive < 0) return undefined;
    const towIn: Tow = { kind: 'trailer', loaded: kind === 'unload', reefer };
    const m = new Mover(L, arrive, 'gate', towIn);
    enter(m, arrive);
    const toCourt = m.timeTo('truckCourt', V_TRUCK) + 40;
    const slot = book.find(doors, Math.max(appt, m.t + toCourt + T.back), dur, T.back) ?? { door: doors[0] as string, t0: Math.max(appt, m.t + toCourt + T.back) };
    if (slot.t0 - T.back - toCourt - m.t > 8 * 60) {
      // 等门：进待命停车场（直进直出的车位），到时候从南头开出来
      m.drive('holdIn', V_TRUCK);
      const leave = slot.t0 - T.back - driveTime([L.nodes.holdOut as Pt, ...parkRoute(L, 'holdOut', 'truckCourt'), doorSetup(door(slot.door))], V_TRUCK) - 45;
      const stall = holdStalls.take(m.t + 50, leave, k * 5);
      if (stall) {
        const sp = stallPoints(L, stall);
        m.go([{ x: (L.nodes.holdIn as Pt).x - 10, z: sp.setup.z }, sp.setup, sp.c], V_TRUCK * 0.6, undefined, '进待命停车场');
        m.at = { stall };
        m.wait(leave, 'hold', '在待命停车场等门');
        m.at = {};
        m.go([sp.out, { x: (L.nodes.holdOut as Pt).x - 10, z: sp.out.z }, L.nodes.holdOut as Pt], V_TRUCK * 0.6, 'holdOut', '出待命停车场');
      }
    }
    dockAt(m, slot.door, Math.max(slot.t0, m.t + m.timeTo('truckCourt', V_TRUCK) + T.back), T.back);
    const t0 = m.t;
    m.still('work', dur, { tow: { kind: 'trailer', loaded: kind === 'unload', reefer }, note: kind === 'load' ? '装车' : '卸货' });
    m.tow = { kind: 'trailer', loaded: kind === 'load', reefer };
    pullFrom(m, slot.door);
    book.add({ door: slot.door, t0: t0 - T.back, t1: m.t, who: label, kind, own: false });
    book.addMove(slot.door, t0 - T.back, t0);
    book.addMove(slot.door, m.t - T.pull, m.t);
    leave(m);
    return { a: { ...m.actor({ id, kind: 'truck', label, own: false }), gateIn: arrive, gateOut: m.t, road: { in: k % 3, out: (k + 2) % 3 } }, door: slot.door, t0, t1: t0 + dur };
  };
  // 进货的车集中在上午（5:30–14:30）；约 4 成提前 15–75 分钟到（按公开资料取的假设参数），门没空就进待命停车场
  const nIn = Math.round((6 + 3 * f) * (0.85 + 0.3 * r()));
  for (let i = 0; i < nIn; i++) {
    const appt = 5.5 * 3600 + ((i + r()) / nIn) * 9 * 3600;
    const n = 16 + Math.floor(r() * 9);
    const reefer = i % 5 === 4;
    const v = truckVisit(`XI-${i + 1}`, `外来货车 · 整车越库进货 ${n} 板`, appt, r() < 0.4 ? 900 + r() * 3600 : r() * 400, reefer ? coldDoors : recvDoors, T.unload, 'unload', reefer, i);
    if (!v) continue;
    pallIn.push({ t: v.t1, n });
    actors.push(v.a);
  }
  // 暂存道：一早有昨天留下的托盘；拆箱、越库进来的托盘按卸完的时刻进来
  const start = Math.round(40 + 20 * f);
  pallIn.sort((a, b) => a.t - b.t);
  const totalIn = start + pallIn.reduce((s, x) => s + x.n, 0);
  const nOut = Math.max(0, Math.floor((totalIn * (0.82 + 0.1 * r())) / 22));
  /** 第 k 车（每车 22 板）的货什么时候凑够（凑够以后 20 分钟备货） */
  const readyAt = (k: number): number => {
    let have = start;
    if (have >= 22 * (k + 1)) return 5.5 * 3600 + k * 600;
    for (const p of pallIn) {
      have += p.n;
      if (have >= 22 * (k + 1)) return p.t + 1200;
    }
    return Infinity;
  };
  const out: { t: number; n: number }[] = [];
  // 甩挂区：一早有承运商甩下的空挂车
  const empties: { id: string; stall: string; from: number; bk: number }[] = [];
  const nEmpty = Math.round(6 + 3 * f);
  for (let i = 0; i < nEmpty; i++) {
    const stall = dropStalls.take(-3600, END, 2 + i * 2);
    if (!stall) break;
    empties.push({ id: `空挂车 ${String.fromCharCode(65 + (i % 26))}${100 + i}`, stall, from: -3600, bk: -3600 });
  }
  // 场内牵引车（甩挂用）
  const nShunt = f >= 1.9 ? 2 : 1;
  const shunters = Array.from({ length: nShunt }, () => new Mover(L, -3600, 'dropW'));
  let shuntMoves = 0;
  const pickShunter = () => shunters.reduce((best, x) => (x.t < best.t ? x : best), shunters[0] as Mover);
  /** 场内牵引车从车位挂上挂车（光车头倒到挂车下面、挂上、拉出到通道） */
  const hookAtStall = (m: Mover, stall: string, tow: Tow) => {
    const sp = stallPoints(L, stall);
    m.drive('dropW');
    m.go([sp.setup], V_YARD * 0.6);
    m.back({ stall }, 40, sp.c);
    m.hook(tow, T.hook);
    m.pull(T.pull, sp.out, undefined);
    m.node = 'dropW';
  };
  /** 挂车倒进车位、摘下来、光车头开出来 */
  const dropAtStall = (m: Mover, stall: string) => {
    const sp = stallPoints(L, stall);
    m.drive('dropW');
    m.go([sp.setup], V_YARD * 0.6);
    m.back({ stall }, T.back, sp.c);
    m.unhook(T.unhook);
    m.pull(25, sp.out, undefined);
    m.node = 'dropW';
  };
  // 本店的甩挂（调度台「提前装好」的车）：牵引车把空挂车拖到门上装、装满拖回甩挂区等车头
  for (const s of sims) {
    if (!s.drop) continue;
    const m = pickShunter();
    const emptyId = `本店空挂车 ${s.vid}`;
    const st0 = dropStalls.take(Math.min(m.t, s.drop.spotAt - 1800), s.drop.spotAt, 40 + s.vid);
    if (!st0) continue;
    trailers.push({ id: emptyId, stall: st0, t0: -3600, t1: s.drop.spotAt - 600, loaded: false, reefer: s.cold, own: true });
    m.wait(Math.max(m.t, s.drop.spotAt - 900));
    hookAtStall(m, st0, { kind: 'trailer', trailer: s.drop.trailer, loaded: false, reefer: s.cold });
    // 场内牵引车不在门前的倒车起点等（和旁边门上等着的车挤在一起）：在挂车的车位前算好时间再出发
    dockAt(m, s.door, s.drop.spotAt + T.back, T.back, true);
    m.unhook(T.unhook);
    pullFrom(m, s.door);
    shuntMoves++;
    const m2 = pickShunter();
    m2.wait(Math.max(m2.t, s.drop.loadedAt - 300));
    dockAt(m2, s.door, Math.max(s.drop.loadedAt, m2.t + 120) + 40, 40, true);
    m2.hook({ kind: 'trailer', trailer: s.drop.trailer, loaded: true, reefer: s.cold, own: true }, T.hook);
    pullFrom(m2, s.door);
    const st1 = dropStalls.take(m2.t, s.drop.hookAt + 120, 50 + s.vid);
    if (!st1) continue;
    dropAtStall(m2, st1);
    shuntMoves++;
    s.drop.stall = st1;
    s.drop.parkedAt = m2.t;
    trailers.push({ id: s.drop.trailer, stall: st1, t0: m2.t - 25, t1: s.drop.hookAt, loaded: true, reefer: s.cold, own: true });
  }
  for (let k = 0; k < nOut; k++) {
    const ready = readyAt(k);
    if (!Number.isFinite(ready) || ready > 22.5 * 3600) break;
    const reefer = k % 6 === 5;
    const viaDrop = !reefer && empties.length > 0 && r() < 0.4;
    if (!viaDrop) {
      const v = truckVisit(`XO-${k + 1}`, '外来货车 · 越库出货 22 板', ready, r() < 0.4 ? 900 + r() * 3600 : r() * 500, reefer ? coldDoors : shipDoors, T.load, 'load', reefer, k + 7);
      if (!v) continue;
      out.push({ t: v.t0, n: 22 });
      actors.push(v.a);
      continue;
    }
    // 甩挂：牵引车从甩挂区拖一辆空挂车到装卸门、装满拖回车位；承运商的车头带一辆空挂车来甩下，挂上装满的那辆走
    const et = empties.shift() as { id: string; stall: string; from: number; bk: number };
    const m = pickShunter();
    const slot = book.find(shipDoors, Math.max(ready, m.t + 600), T.prep + T.load + T.hook + T.pull + 600, T.back);
    if (!slot) continue;
    m.wait(Math.max(m.t, slot.t0 - 900));
    hookAtStall(m, et.stall, { kind: 'trailer', trailer: et.id, loaded: false });
    trailers.push({ id: et.id, stall: et.stall, t0: et.from, t1: m.t - T.pull - T.hook * 0.5, loaded: false, reefer: false, own: false });
    dropStalls.release(et.stall, et.bk, m.t - T.pull);
    dockAt(m, slot.door, Math.max(slot.t0, m.t + m.timeTo('truckCourt') + T.back), T.back, true);
    const dock = m.t;
    m.unhook(T.unhook);
    pullFrom(m, slot.door);
    shuntMoves++;
    const loaded = dock + T.prep + T.load;
    book.add({ door: slot.door, t0: dock - T.back, t1: loaded + T.hook + T.pull + 600, who: et.id, kind: 'drop', own: false });
    book.addMove(slot.door, dock - T.back, dock);
    out.push({ t: dock + T.prep, n: 22 });
    // 装满：牵引车回来挂上，拖回甩挂区
    const m2 = pickShunter();
    m2.wait(Math.max(m2.t, loaded - 240));
    dockAt(m2, slot.door, Math.max(loaded, m2.t + 60) + 40, 40, true);
    const towL: Tow = { kind: 'trailer', trailer: et.id, loaded: true };
    m2.hook(towL, T.hook);
    pullFrom(m2, slot.door);
    const use = (book.uses.get(slot.door) ?? []).find((u) => u.who === et.id);
    if (use) use.t1 = m2.t;
    book.addMove(slot.door, m2.t - T.pull, m2.t);
    // 承运商的车头：装满以后半小时到两小时来
    const hookAt = m2.t + 1800 + r() * 5400;
    const stall = dropStalls.take(m2.t, hookAt + 400, k * 3 + 1);
    if (!stall) continue;
    dropAtStall(m2, stall);
    shuntMoves++;
    trailers.push({ id: et.id, stall, t0: m2.t - 25, t1: hookAt + 260, loaded: true, reefer: false, own: false });
    // 承运商：带一辆空挂车来，甩在空车位上，再挂上装满的那辆走
    const arrive = hookAt - 900;
    if (arrive > 23.7 * 3600) continue;
    const newEmpty = `空挂车 ${String.fromCharCode(75 + (k % 14))}${300 + k}`;
    const c = new Mover(L, arrive, 'gate', { kind: 'trailer', trailer: newEmpty, loaded: false });
    enter(c, arrive);
    const dropFrom = c.t + c.timeTo('dropW', V_TRUCK);
    const dropAt = dropStalls.take(dropFrom, END, k * 5 + 11);
    if (dropAt) {
      dropAtStall(c, dropAt);
      empties.push({ id: newEmpty, stall: dropAt, from: c.t - 25, bk: dropFrom });
    }
    c.wait(Math.max(c.t, hookAt));
    hookAtStall(c, stall, towL);
    const tr2 = trailers.find((x) => x.id === et.id && x.loaded);
    if (tr2) tr2.t1 = c.t - T.pull - T.hook * 0.5;
    leave(c);
    actors.push({ ...c.actor({ id: `XC-${k + 1}`, kind: 'carrier', label: `承运商车头 · 甩挂取货 ${et.id}`, own: false }), gateIn: arrive, gateOut: c.t, road: { in: (k + 1) % 3, out: k % 3 } });
  }
  // 当天没被拖走的空挂车一直停在车位上
  for (const et of empties) if (!trailers.some((x) => x.id === et.id)) trailers.push({ id: et.id, stall: et.stall, t0: et.from, t1: END, loaded: false, reefer: false, own: false });
  shunters.forEach((m, i) => {
    if (m.t < END) m.wait(END);
    actors.push(m.actor({ id: `YT-${i + 1}`, kind: 'shunter', label: `场内牵引车 ${i + 1}`, own: false }));
  });
  for (const s of ['W', 'E'] as const) transfers[s].sort((a, b) => a.t0 - b.t0);

  // 暂存道上的托盘：5 分钟一格
  const staging = new Float32Array(HUB_SLOTS);
  {
    const ev = [...pallIn.map((p) => ({ t: p.t, d: p.n })), ...out.map((o) => ({ t: o.t, d: -o.n }))].sort((a, b) => a.t - b.t);
    let cur = start;
    let j = 0;
    for (let k = 0; k < HUB_SLOTS; k++) {
      const tk = (k + 0.5) * HUB_SLOT;
      while (j < ev.length && (ev[j] as { t: number }).t <= tk) cur += (ev[j++] as { d: number }).d;
      staging[k] = Math.max(0, cur);
    }
  }

  // 场内车闲着的时候回待命停车场的车位
  restYard(L, actors, holdStalls, END);

  const plan: ParkPlan = { layout: L, sims, boxes, actors, transfers, doorUse: book.all(), trailers, staging, hub: undefined as unknown as HubDay, notes };
  plan.hub = hubOf(plan, { start, pallIn, out, shuntMoves, f });
  return plan;
}

/** 值班助手用的一天（区、每件货 / 每辆车的去向、指标、几句话） */
function hubOf(p: ParkPlan, x: { start: number; pallIn: { t: number; n: number }[]; out: { t: number; n: number }[]; shuntMoves: number; f: number }): HubDay {
  const L = p.layout;
  const dcIn = L.doors.filter((d) => d.group === 'dc' && d.receiving).length;
  const dcOut = L.doors.filter((d) => d.group === 'dc' && !d.receiving).length;
  const zones: HubZone[] = [
    { key: 'gate', label: '进园登记', kind: 'queue', capacity: 2, unit: '车' },
    { key: 'hold', label: '待命停车场', kind: 'parking', capacity: L.hold.stalls.length, unit: '车' },
    { key: 'drop', label: '甩挂区', kind: 'parking', capacity: L.drop.stalls.length, unit: '挂车' },
    { key: 'dcIn', label: '配送中心收货门', kind: 'dock', capacity: dcIn, unit: '樘' },
    { key: 'dcOut', label: '配送中心发货门', kind: 'dock', capacity: dcOut, unit: '樘' },
    { key: 'rail', label: '铁路货运站箱位（重箱）', kind: 'storage', capacity: (L.rail.W.slots * L.rail.W.rowV.length + L.rail.E.slots * L.rail.E.rowV.length) * RAIL_YARD.tiers, unit: '箱' },
    { key: 'empty', label: '铁路货运站箱位（空箱）', kind: 'storage', capacity: (L.rail.W.slots * L.rail.W.rowV.length + L.rail.E.slots * L.rail.E.rowV.length) * RAIL_YARD.tiers, unit: '箱' },
    { key: 'tlBox', label: '转运仓拆箱门', kind: 'dock', capacity: L.doors.filter((d) => d.group === 'tlBox').length, unit: '樘' },
    { key: 'tlTruck', label: '转运仓装卸门', kind: 'dock', capacity: L.doors.filter((d) => d.group === 'tlTruck').length, unit: '樘' },
    { key: 'tl', label: '转运仓暂存道', kind: 'staging', capacity: 600, unit: '板' },
  ];
  const flows: HubFlow[] = [];
  const zoneOfDoor = (id: string): string => {
    const d = L.doors.find((q) => q.id === id);
    if (!d) return 'dcIn';
    if (d.group === 'tlBox') return 'tlBox';
    if (d.group === 'tlTruck') return 'tlTruck';
    return d.receiving ? 'dcIn' : 'dcOut';
  };
  for (const s of p.sims) {
    const steps: HubFlow['steps'] = [];
    if (s.checkIn[1] > s.checkIn[0]) steps.push({ zone: 'gate', t0: s.checkIn[0], t1: s.checkIn[1], act: '进门登记' });
    if (s.hold) steps.push({ zone: 'hold', t0: s.hold.t0, t1: s.hold.t1, act: '等门' });
    if (s.drop) {
      steps.push({ zone: zoneOfDoor(s.door), t0: s.drop.spotAt, t1: s.drop.loadedAt, act: '挂车提前装车' });
      steps.push({ zone: 'drop', t0: s.drop.parkedAt, t1: s.drop.hookAt, act: '装好的挂车等车头' });
    } else steps.push({ zone: zoneOfDoor(s.door), t0: s.dockAt[0], t1: s.dockAt[1], act: s.mode === 'load' ? '装车' : '卸货' });
    flows.push({ id: `V${s.vid}-${s.stop}`, label: s.label, own: true, units: 1, unit: '车', steps, carrierIn: s.op ?? s.label, cold: s.cold, kind: 'vehicle' });
  }
  for (const b of p.boxes) {
    const steps: HubFlow['steps'] = [];
    const end = b.pickAt ?? 26 * 3600;
    steps.push({ zone: 'rail', t0: Math.max(-3600, b.landAt), t1: end, act: b.background ? '前几天卸下的箱在箱位上' : '卸到箱位、查验' });
    if (b.devan && b.door) steps.push({ zone: zoneOfDoor(b.door), t0: b.devan[0], t1: b.devan[1], act: b.own ? '在配送中心收货门拆箱' : '在转运仓拆箱' });
    if (b.emptyAt !== undefined) steps.push({ zone: 'empty', t0: b.emptyAt, t1: 26 * 3600, act: '空箱回到箱位' });
    flows.push({ id: b.id, label: `${b.own ? '本店的箱' : '别家的箱'} ${b.id}`, own: b.own, units: 1, unit: '箱', steps, kind: 'cargo', carrierIn: b.trainLabel, ...(b.dest === 'dc' ? { carrierOut: '配送中心' } : b.dest === 'tl' ? { carrierOut: '转运仓' } : b.dest === 'road' ? { carrierOut: '外来集卡' } : {}) });
  }
  for (const a of p.actors) {
    if (a.kind === 'shuttle' || a.kind === 'shunter') continue;
    const steps: HubFlow['steps'] = [];
    for (const l of a.legs) {
      if (l.kind === 'kiosk' || (l.kind === 'hold' && !l.stall)) steps.push({ zone: 'gate', t0: l.t0, t1: l.t1, act: l.kind === 'kiosk' ? '登记' : '门外排队' });
      if (l.kind === 'hold' && l.stall) steps.push({ zone: 'hold', t0: l.t0, t1: l.t1, act: '等门' });
      if (l.kind === 'work' && l.door) steps.push({ zone: zoneOfDoor(l.door), t0: l.t0, t1: l.t1, act: l.note ?? '装卸' });
    }
    flows.push({ id: a.id, label: a.label, own: false, units: 1, unit: '车', steps, kind: 'vehicle', cold: a.legs.some((l) => l.tow?.reefer) });
  }
  for (const tr of p.trailers) flows.push({ id: `TR-${tr.id}-${Math.round(tr.t0)}`, label: tr.id, own: tr.own, units: 1, unit: '挂车', kind: 'vehicle', cold: tr.reefer, steps: [{ zone: 'drop', t0: Math.max(-3600, tr.t0), t1: tr.t1, act: tr.loaded ? '装好的挂车等车头' : '空挂车' }] });
  // 甩挂的挂车在转运仓的门上装车（本店的甩挂已经算在仿真车里）
  for (const u of p.doorUse) if (u.kind === 'drop' && !u.own) flows.push({ id: `DU-${u.door}-${Math.round(u.t0)}`, label: `${u.who} 在 ${u.door} 装车`, own: false, units: 1, unit: '樘', kind: 'vehicle', steps: [{ zone: zoneOfDoor(u.door), t0: u.t0, t1: u.t1, act: '甩挂装车' }] });
  const occupancy = tallyOccupancy(zones, flows);
  occupancy.tl = p.staging;
  // 指标
  const own = p.boxes.filter((b) => b.own && b.devan);
  const holdWaits = [...p.sims.filter((s) => s.hold).map((s) => ((s.hold as { t1: number }).t1 - (s.hold as { t0: number }).t0) / 60), ...p.actors.flatMap((a) => a.legs.filter((l) => l.kind === 'hold' && l.stall).map((l) => (l.t1 - l.t0) / 60))];
  const turns = p.actors.filter((a) => a.gateIn !== undefined && a.gateOut !== undefined).map((a) => ((a.gateOut as number) - (a.gateIn as number)) / 60);
  const dropDwell = p.trailers.filter((t) => t.t0 >= 0 && t.t1 < 26 * 3600).map((t) => (t.t1 - t.t0) / 60);
  const railDwell = p.boxes.filter((b) => b.pickAt !== undefined && b.landAt >= 0).map((b) => ((b.pickAt as number) - b.landAt) / 3600);
  const day = (zone: string, cap: number) => {
    const a = occupancy[zone];
    if (!a || !cap) return 0;
    let s = 0;
    for (let k = 0; k < 288; k++) s += a[k] as number;
    return (s / 288 / cap) * 100;
  };
  const peak = (zone: string) => {
    const a = occupancy[zone];
    let m = 0;
    if (a) for (let k = 0; k < 288; k++) m = Math.max(m, a[k] as number);
    return m;
  };
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
  const kpi: HubKpi[] = [
    { key: 'dcDoorUse', label: '配送中心月台门占用率', value: (day('dcIn', zones[3]?.capacity ?? 1) * dcIn + day('dcOut', dcOut) * dcOut) / Math.max(1, dcIn + dcOut), unit: '%' },
    { key: 'tlDoorUse', label: '转运仓月台门占用率', value: (day('tlBox', 8) * 8 + day('tlTruck', 10) * 10) / 18, unit: '%' },
    { key: 'holdAvg', label: '平均等门', value: avg(holdWaits), unit: '分钟', better: 'lower' },
    { key: 'holdMax', label: '最长等门', value: max(holdWaits), unit: '分钟', better: 'lower' },
    { key: 'holdPeak', label: '待命停车场最多', value: peak('hold'), unit: '车', better: 'lower' },
    { key: 'turn', label: '外来车在园平均', value: avg(turns), unit: '分钟', better: 'lower' },
    { key: 'dropDwell', label: '挂车在甩挂区平均', value: avg(dropDwell), unit: '分钟', better: 'lower' },
    { key: 'dropPeak', label: '甩挂区最多', value: peak('drop'), unit: '挂车' },
    { key: 'railDwell', label: '箱在货运站平均停留', value: avg(railDwell), unit: '小时', better: 'lower' },
    { key: 'ownBoxes', label: '本店的箱短驳进配送中心', value: own.length, unit: '箱' },
    { key: 'ownToDc', label: '本店的箱落地到进门', value: avg(own.map((b) => ((b.devan as [number, number])[0] - b.landAt) / 60)), unit: '分钟', better: 'lower' },
    { key: 'shunts', label: '场内牵引车拖挂车', value: x.shuntMoves, unit: '趟' },
    { key: 'gate', label: '进园登记', value: p.actors.filter((a) => a.gateIn !== undefined).length + p.sims.filter((s) => s.checkIn[1] > s.checkIn[0]).length, unit: '车次' },
    { key: 'tlPallets', label: '转运仓过库', value: x.pallIn.reduce((s, q) => s + q.n, 0), unit: '板', better: 'higher' },
  ];
  // 几句话
  const notes: string[] = [];
  const trains = new Set(p.boxes.filter((b) => b.train !== undefined).map((b) => b.trainLabel));
  notes.push(trains.size ? `今天货运站卸了 ${[...trains].join('、')}，共 ${p.boxes.filter((b) => !b.background).length} 个箱（本店 ${p.boxes.filter((b) => b.own).length} 个）。` : '今天没有本店的班列到货运站，站里是前几天到的别家箱。');
  if (own.length) notes.push(`本店的 ${own.length} 个箱短驳进配送中心收货门拆箱，落地后平均 ${Math.round(avg(own.map((b) => ((b.devan as [number, number])[0] - b.landAt) / 60)))} 分钟进门。`);
  const hp = peak('hold');
  if (hp >= 1) {
    const a = occupancy.hold as Float32Array;
    let k = 0;
    for (let i = 0; i < 288; i++) if ((a[i] as number) > (a[k] as number)) k = i;
    notes.push(`待命停车场最多 ${Math.round(hp)} 辆车（${String(Math.floor((k * HUB_SLOT) / 3600)).padStart(2, '0')}:${String(Math.floor(((k * HUB_SLOT) % 3600) / 60)).padStart(2, '0')} 前后）。`);
  }
  notes.push(`转运仓今天进 ${x.pallIn.reduce((s, q) => s + q.n, 0)} 板、出 ${x.out.reduce((s, q) => s + q.n, 0)} 板，甩挂 ${x.out.length ? p.actors.filter((a) => a.kind === 'carrier').length : 0} 次，场内牵引车拖了 ${x.shuntMoves} 趟。`);
  const tight = p.sims.filter((s) => s.tight);
  if (tight.length) notes.push(`${tight.length} 辆本店的车在门上的时间很紧（仿真给的停留不够倒车和装卸），画面里压缩了调车。`);
  p.notes.push(...notes);
  return { key: 'park', label: '物流园', zones, flows, occupancy, kpi, notes };
}

/**
 * 交给场地引擎（@storewright/yard，packages/yard）的场地：配送中心干货门、冷链中心的门、转运仓装卸门、转运仓拆箱门。
 * 本地坐标是「墙在 z = 0、场地朝 +z」，frame 把它放进物流园的局部坐标（原点、绕 y 轴的角）；门的编号和调度台一样。
 * 待命停车场在场地外（hold），甩挂区的车位算在转运仓装卸门的场地里。
 */
export interface ParkYardInput {
  key: 'park-dc' | 'park-cold' | 'park-tl-truck' | 'park-tl-box';
  label: string;
  /** 本地坐标 → 物流园局部坐标：原点（墙上 x = 0 的点）、yaw（three.js 绕 y 轴的角） */
  frame: { origin: Pt; yaw: number };
  doors: { id: string; x: number; cold: boolean; kinds: string[] }[];
  x0: number;
  x1: number;
  depth: number;
  side: 'left' | 'right';
  from: 'back' | 'front';
  access: 'drive' | 'street';
  driveX: number;
  queue: number;
  drop: number;
}
export function parkYardInputs(L: ParkLayout): ParkYardInput[] {
  const out: ParkYardInput[] = [];
  const dry = L.doors.filter((d) => d.group === 'dc' && !d.cold);
  const cold = L.doors.filter((d) => d.group === 'dc' && d.cold);
  // 配送中心南墙：墙在局部 z = wallZ、场地朝 +z（和场地引擎的本地坐标同向，只平移）；车从西头（courtW）进
  out.push({ key: 'park-dc', label: '配送中心干货月台', frame: { origin: { x: 0, z: L.wallZ }, yaw: 0 }, doors: dry.map((d) => ({ id: d.id, x: d.x, cold: false, kinds: ['semi', 'chassis', 'truck', 'van'] })), x0: (L.nodes.courtW as Pt).x - 6, x1: L.dcBox.x1 + 10, depth: 49, side: 'left', from: 'front', access: 'drive', driveX: (L.nodes.courtW as Pt).x, queue: 0, drop: 0 });
  out.push({ key: 'park-cold', label: '冷链中心月台', frame: { origin: { x: 0, z: L.wallZ }, yaw: 0 }, doors: cold.map((d) => ({ id: d.id, x: d.x, cold: true, kinds: ['reefer', 'semi', 'truck', 'van'] })), x0: (L.nodes.courtE as Pt).x - 6, x1: L.coldBox.x1 + 15, depth: 49, side: 'left', from: 'front', access: 'drive', driveX: (L.nodes.courtE as Pt).x, queue: 0, drop: 0 });
  // 转运仓南面：墙在 z = tl.zS、场地朝 +z；车从西头（西侧场内路）进；甩挂区算在这个场地
  out.push({ key: 'park-tl-truck', label: '转运仓装卸门', frame: { origin: { x: 0, z: L.tl.zS }, yaw: 0 }, doors: L.doors.filter((d) => d.group === 'tlTruck').map((d) => ({ id: d.id, x: d.x, cold: d.cold, kinds: ['semi', 'reefer', 'truck', 'van'] })), x0: L.tl.x0 - 20, x1: L.tl.x1 + 12, depth: 49, side: 'left', from: 'front', access: 'drive', driveX: (L.nodes.truckCourt as Pt).x, queue: 0, drop: L.drop.stalls.length });
  // 转运仓北面：墙朝北（场地在 −z）：本地坐标转 180°（本地 +x 是局部 −x、本地 +z 是局部 −z），车从东头进
  out.push({ key: 'park-tl-box', label: '转运仓拆箱门', frame: { origin: { x: 0, z: L.tl.zN }, yaw: Math.PI }, doors: L.doors.filter((d) => d.group === 'tlBox').map((d) => ({ id: d.id, x: -d.x, cold: false, kinds: ['chassis'] })), x0: -(L.tl.x1 + 24), x1: -(L.tl.x0 - 8), depth: 30, side: 'left', from: 'front', access: 'drive', driveX: -(L.nodes.boxCourtE as Pt).x, queue: 0, drop: 0 });
  return out;
}

/** 门在三维里的位置（局部坐标）：门中心在墙上的点、朝场地的方向 */
export function doorPose(d: ParkDoor): { x: number; z: number; heading: number } {
  return { x: d.x, z: d.wallZ, heading: d.face > 0 ? 0 : Math.PI };
}
