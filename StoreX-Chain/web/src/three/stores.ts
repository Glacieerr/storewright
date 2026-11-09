import * as THREE from 'three';
import { currentFacilities } from '../../../src/facility/state';
import { HGT as LAYOUT_D, W as LAYOUT_W } from '../../../../StoreX/src/world/layout';
import { currentRegion, STORES, type StoreSite } from '../../../src/region/network';
import { RAIL, REGION } from '../../../src/region/region';
import { buildStoreLot, frontCapacity, lotBounds, outLaneX, type StoreLot } from '../../../src/site/lot';
import { fillet, GeoBuilder, pointInPoly, polyDist, rand, sampleAt, v3, type V3 } from './geo';
import { halfAll, P, S, XSEC, type Arc, type Line, type RoadNet } from './roadnet';
import { defineYardSite, planYard, toWorld as yardToWorld, yardRoute, type PathLike, type PathState, type YardFrame, type YardPlan, type YardRoute, type YardVehicle } from '@storewright/yard';

/**
 * 门店的站点和外观。区域里只有一家综合店：中间是 StoreX 的门店模型（生鲜和食品区，拉近能看到店里的员工、机器人和顾客），
 * 后面用一条玻璃连廊接一栋更高的百货日用馆，馆后是收货场。
 *
 * 站点按第一部分 Storewright 的模板排（决策记录 0013、0018、0019）：
 * - 店前停车场和西侧的即时取货区（src/site/lot.ts）：进店路从干道上的路口一直进来，接到停车场外沿的门前路（T 形路口），
 *   门前路两头是停车场的两个出入口（一进一出、中间绿化隔离岛、喇叭口）；车位按门店的建筑面积和停车配建指标排几组双排；
 * - 货车走单独的货车通道：在进店路离干道不远处向东分出去，沿停车场和店房的东侧一直到店后的收货场，货车不进顾客的停车场；
 * - 收货场用区域共用的收货场引擎（yard/）排：靠台车道、驶离车道、待命车道、顶部车道单向绕行，半挂车从司机一侧倒车靠台，
 *   待命车道画车位框（先到先进）；进深按店后离干道、铁路、河还剩多远（不够就退成紧凑布置，排队排到货车通道上）。
 * 网页、社会车流线程、孪生服务都调 planStores，同一个区域每次排出来一样。
 */
export interface Site {
  st: StoreSite;
  /** StoreX 门店模型的中心、朝向（本地 +z = 正面朝外的方向）、StoreX 模型的宽和进深 */
  center: V3;
  rot: number;
  w: number;
  d: number;
  /** 进店路的终点（门前路的 T 形路口）和进站方向 */
  entrance: V3;
  inward: { x: number; z: number };
  /** 收货口：货车开到 approach 的终点，倒车到 reverse 的终点（车尾贴门）；从 0 起 */
  docks: { approach: V3[]; reverse: V3[]; door: V3 }[];
  /** 线上配送车的装车位 */
  vanBay: V3[];
  /** 站点轮廓（城区建筑要避开） */
  outline: { x: number; z: number }[];
  /** 停车位（停着的顾客车）：旧接口，现在的车位在 lot 里 */
  stalls: { p: V3; ang: number }[];
  /** 店前停车场和即时取货区（门店本地坐标） */
  lot: StoreLot;
  /** 进店路（道路网的线）、货车通道分出去的位置（沿进店路的距离）、货车通道 */
  access: { line: number; sSplit: number; zSplit: number; attachZ: number };
  truck?: { line: number; x: number; pts: { x: number; z: number }[] };
  /** 收货场：引擎排的布置、放进区域的坐标系、登记的键 */
  yard?: { plan: YardPlan; frame: YardFrame; key: string; depth: number };
}

/** 本地坐标 → 世界坐标 */
export function toWorld(site: { center: V3; rot: number }, lx: number, lz: number, y = 0): V3 {
  const c = Math.cos(site.rot);
  const s = Math.sin(site.rot);
  return v3(site.center.x + lx * c + lz * s, y, site.center.z - lx * s + lz * c);
}
/** 世界坐标 → 本地坐标 */
export function toLocal(site: { center: V3; rot: number }, x: number, z: number): { x: number; z: number } {
  const c = Math.cos(site.rot);
  const s = Math.sin(site.rot);
  const dx = x - site.center.x;
  const dz = z - site.center.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/**
 * 综合店的本地尺寸（米，StoreX 模型的中心在原点、正面朝 +z）：StoreX 店房 x −36…35、z −31…21；
 * 百货日用馆 x −36…35、z −89…−37（比 StoreX 店房高，正面高出来的那截墙不挂店名），中间玻璃连廊 x −6…6；
 * 收货口在百货馆北墙（z = −89），x = −24、−10、4、18；货车通道在东侧（x = TRUCK_X）。
 */
export const EXT = { x0: -36, x1: 35, z0: -89, z1: -37, h: 11, yard: -119 };
/**
 * 门店扩大规模：百货馆的进深跟着规模变（规模 2.5 时 52 米，5 倍时约 90 米），北墙、收货口和店后收货场一起往外挪；
 * 卖场的货架、后仓、窗户按进深排。规模在设施管理台里改（区域生成时已经定好）。
 */
export function scaleStore(size: number): void {
  const d = Math.max(45, Math.min(95, 52 * Math.pow(Math.max(0.5, size) / 2.5, 0.8)));
  EXT.z0 = EXT.z1 - d;
  EXT.yard = EXT.z0 - 30;
}
/** 收货口在百货馆北墙上的位置（本地 x）：按门店的收货口个数居中排开，4 个时是 −24、−10、4、18，最多 8 个 */
export const dockXs = (n = STORES[0]?.docks ?? 4): number[] => {
  const k = Math.max(1, Math.min(8, Math.round(n)));
  const step = k <= 4 ? 14 : Math.min(11.5, 64 / (k - 1));
  return Array.from({ length: k }, (_, i) => -3 + (i - (k - 1) / 2) * step);
};
/** 货车通道中心线的本地 x（停车场东侧绿化带以外） */
export const TRUCK_X = 72;
/** StoreX 店房正面墙、店门（入口、出口，店外一侧） */
const FRONT = 21;
const DOORS = { entrance: { x: -9.5, z: 22 }, exit: { x: 2.5, z: 22 } };
/**
 * 停车配建（按公开资料取的假设参数）：大型超市每 100 平方米建筑面积 0.6–1.5 个车位，这里取 1.0；
 * 同时按门店仿真里最忙的那个小时停着的车（购物、百货馆、员工约 95 辆）留 15% 的余量，两者取大。
 */
export const PARK_RATIO = 1.0;
export const DESIGN_PEAK = 95;

/** 店前的停车场排几组双排：按建筑面积和配建指标、设计高峰小时的车，店前地方不够就减 */
export function lotRows(attachZ: number): number {
  const area = 71 * 52 + (EXT.x1 - EXT.x0) * (EXT.z1 - EXT.z0);
  const need = Math.max((PARK_RATIO * area) / 100, DESIGN_PEAK / 0.85);
  let rows = 1;
  while (rows < 4 && frontCapacity(rows) < need) rows++;
  // 门前路外沿 + 货车通道分岔（14 米）+ 分岔到干道路口至少 22 米
  const outer = (r: number) => buildStoreLot({ front: FRONT, storeX0: EXT.x0, storeX1: EXT.x1, doors: DOORS, rows: r }).frontage;
  while (rows > 1 && outer(rows).z + outer(rows).half + 14 + 22 > attachZ) rows--;
  return rows;
}

/** 收货场能用的进深：店后到干道、铁路、河、海还剩多少（从收货口那面墙算起，最多 110 米） */
function yardDepth(net: RoadNet, site: Site, x0: number, x1: number, skip: Set<number>): number {
  const plan = currentRegion();
  const rail = RAIL.map((k) => v3(k.x * S, 0, -k.y * S));
  const river = REGION.plan?.river;
  const riverPts = river ? river.pts.map((k) => v3(k.x * S, 0, -k.y * S)) : [];
  const riverHalf = river ? (river.width * S) / 2 : 0;
  const sd = plan.seaDir;
  const c0 = plan.coast[0] as { x: number; y: number };
  const c1 = plan.coast[plan.coast.length - 1] as { x: number; y: number };
  const land = [...plan.coast, { x: c1.x - sd.x * 160, y: c1.y - sd.y * 160 }, { x: c0.x - sd.x * 160, y: c0.y - sd.y * 160 }].map((k) => ({ x: k.x * S, z: -k.y * S }));
  const lines = net.lines.filter((l) => !skip.has(l.id) && l.cls !== 'street' && l.cls !== 'service');
  const clear = (lx: number, lz: number) => {
    const p = toWorld(site, lx, lz);
    if (!pointInPoly(p.x, p.z, land)) return false;
    if (rail.length > 1 && polyDist(p.x, p.z, rail) < 18) return false;
    if (riverPts.length > 1 && polyDist(p.x, p.z, riverPts) < riverHalf + 12) return false;
    for (const l of lines) if (polyDist(p.x, p.z, l.pts) < halfAll(l.xs) + 4) return false;
    return true;
  };
  let depth = 30;
  for (let d = 32; d <= 110; d += 2) {
    let ok = true;
    for (let x = x0; x <= x1 && ok; x += 6) ok = clear(x, EXT.z0 - d);
    if (!ok) break;
    depth = d;
  }
  return depth;
}

/** 沿线找离某点最近的位置（沿线距离） */
function nearestS(line: Line, p: V3): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < line.pts.length; i++) {
    const q = line.pts[i] as V3;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < bd) {
      bd = d;
      best = line.cum[i] as number;
    }
  }
  return best;
}

/** 规划门店的站点：停车场、进店路、货车通道、收货场，登记收货口和配送车位 */
export function planStores(net: RoadNet): Map<string, Site> {
  const sites = new Map<string, Site>();
  scaleStore(STORES[0]?.size ?? 2.5);
  for (const st of STORES) {
    const at = net.storeAttach.get(st.key) as NonNullable<ReturnType<typeof net.storeAttach.get>>;
    const sp = P(st.km);
    // 正面朝向接入点
    const fx = at.pos.x - sp.x;
    const fz = at.pos.z - sp.z;
    const fl = Math.hypot(fx, fz) || 1;
    const rot = Math.atan2(fx / fl, fz / fl);
    const attachZ = fl;
    const rows = lotRows(attachZ);
    const lot = buildStoreLot({ front: FRONT, storeX0: EXT.x0, storeX1: EXT.x1, doors: DOORS, rows });
    const site: Site = { st, center: sp.clone(), rot, w: LAYOUT_W, d: LAYOUT_D, entrance: v3(0, 0, 0), inward: { x: -fx / fl, z: -fz / fl }, docks: [], vanBay: [], outline: [], stalls: [], lot, access: { line: -1, sSplit: 0, zSplit: 0, attachZ } };
    const W = (lx: number, lz: number) => toWorld(site, lx, lz);
    site.entrance = W(0, lot.frontage.z);
    const line = net.addStoreRoad(st, site.entrance, site.inward);
    // 货车通道：在门前路外 14 米（离干道路口至少 22 米）从进店路向东分出去，沿东侧一直到店后收货口那面墙
    const zSplit = Math.max(lot.frontage.z + lot.frontage.half + 9, Math.min(attachZ - 22, lot.frontage.z + lot.frontage.half + 14));
    const sSplit = Math.max(8, Math.min(line.len - 8, nearestS(line, W(0, zSplit))));
    site.access = { line: line.id, sSplit, zSplit, attachZ };
    const tj = net.addMid(line, sSplit, `${st.key}:truck`, 'mid');
    // 门店这条仿真的边改成到分岔点为止：货车从这里拐进货车通道，配送车、顾客的车接着往里开（各自的停靠点从这里起）
    const arcs: Arc[] = [];
    if (at.viaLine !== undefined && at.viaS !== undefined) {
      const host = net.lines[at.viaLine] as Line;
      const fromA = host.ja === st.node;
      arcs.push({ line: host.id, s0: fromA ? 0 : host.len, s1: at.viaS, ja: st.node, jb: at.junction });
    }
    arcs.push({ line: line.id, s0: 0, s1: sSplit, ja: at.junction, jb: tj });
    net.mapEdge(st.node, st.key, arcs);
    const split = sampleAt(line.pts, line.cum, sSplit).p.clone();
    const sl = toLocal(site, split.x, split.z);
    const yj = `${st.key}:yard`;
    net.junction(yj, W(TRUCK_X, EXT.z0), 'end');
    // 9 米宽（一进一出两条 4.5 米车道），拐弯是半径 15 米的圆弧（半挂车不做直角转弯）
    const drive = net.addLine('service', fillet([split.clone(), W(TRUCK_X, sl.z), W(TRUCK_X, EXT.z0)], 15, 10), tj, yj, { name: `${st.name}货车通道`, xs: { ...XSEC.service, laneW: 4.5, outer: 0 } });
    site.truck = { line: drive.id, x: TRUCK_X, pts: drive.pts.map((q) => toLocal(site, q.x, q.z)) };
    // 收货场：门在本地 x（引擎的本地坐标 x 反过来），场地从收货口那面墙往店后伸；
    // 进深按场地实际要占的那一段 x（先按最宽的估，排完按排出来的范围再量一次）
    const frame: YardFrame = { origin: { x: W(0, EXT.z0).x, z: W(0, EXT.z0).z }, yaw: rot + Math.PI };
    const skip = new Set([line.id, drive.id]);
    const yardIn = (depth: number) => ({
      doors: dockXs(st.docks).map((x, k) => ({ x: -x, id: k ? `${st.key}#${k + 1}` : st.key, kinds: ['semi', 'reefer', 'truck', 'van'] as YardVehicle[] })),
      x0: -(TRUCK_X + 4.5),
      x1: 58,
      depth,
      side: 'left' as const,
      from: 'back' as const,
      access: 'drive' as const,
      driveX: -TRUCK_X,
      driveHalf: 4.5,
      // 门店的收货场用待命车位排队（先到先进）；甩挂车位要把待命车道让出来当场内通道，门店不用
      drop: 0,
      driveLen: Math.min(60, Math.max(20, sl.z - 15 - EXT.z0)),
    });
    let depth = yardDepth(net, site, -58, TRUCK_X + 4, skip);
    let plan = planYard(yardIn(depth));
    for (let it = 0; it < 2; it++) {
      const d2 = yardDepth(net, site, Math.max(-58, -plan.x1 - 2), Math.min(TRUCK_X + 4, -plan.x0 + 1), skip);
      if (d2 === depth) break;
      depth = d2;
      plan = planYard(yardIn(depth));
    }
    defineYardSite({ key: st.key, frame, plan, doors: plan.doors.map((d, k) => ({ id: d.id, index: k, kinds: d.kinds })) });
    site.yard = { plan, frame, key: st.key, depth };
    site.docks = storeDocks(site, net, drive);
    registerDocks(net, site);
    // 线上配送车：从分岔点沿进店路开进来 → 门前路往西 → 西侧出入口 → 取货区外侧车道往北 → 回车场掉头 → 服务车道往南，倒进配送车装车位
    registerVan(net, site, line);
    const b = lotBounds(lot);
    const yz = EXT.z0 - Math.max(plan.z1, 30) - 4;
    site.outline = [W(b.x0, yz), W(TRUCK_X + 8, yz), W(TRUCK_X + 8, b.z1), W(b.x0, b.z1)];
    sites.set(st.key, site);
  }
  return sites;
}

/** 引擎本地坐标 → 世界坐标（三维向量） */
export function yardW(site: Site, p: { x: number; z: number }): V3 {
  const f = (site.yard as NonNullable<Site['yard']>).frame;
  const w = yardToWorld(f, p);
  return v3(w.x, 0, w.z);
}

/** 按时间走的路径 → 折线（每 0.4 秒一个点，去掉重合的点） */
function sampleLike(path: PathLike, step = 0.4): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const st: PathState = { x: 0, z: 0, heading: 0 };
  for (let t = 0; t <= path.duration + 1e-6; t += step) {
    path.at(Math.min(t, path.duration), st);
    const last = out[out.length - 1];
    if (!last || Math.hypot(st.x - last.x, st.z - last.z) > 0.3) out.push({ x: st.x, z: st.z });
  }
  path.at(path.duration, st);
  out.push({ x: st.x, z: st.z });
  return out;
}

/** 一个收货口的路线（半挂车的）：引擎排的，缓存在站点上 */
const ROUTES = new WeakMap<Site, Map<number, YardRoute>>();
export function storeRoute(site: Site, dock: number, vehicle: 'semi' | 'reefer' | 'truck' | 'van' = 'semi'): YardRoute | undefined {
  if (!site.yard) return undefined;
  let m = ROUTES.get(site);
  if (!m) ROUTES.set(site, (m = new Map()));
  const key = dock * 8 + ['semi', 'reefer', 'truck', 'van'].indexOf(vehicle);
  let r = m.get(key);
  if (!r) m.set(key, (r = yardRoute(site.yard.plan, dock, vehicle)));
  return r;
}

/**
 * 收货口的停靠路线（给运动规划：沿 path 开到倒车起点，倒车沿 reverse 靠上；走的时候拉出、沿 exit 开回分岔点）：
 * 路线来自收货场引擎（半挂车的那一套），开头接上货车通道的进场车道。
 */
function storeDocks(site: Site, net: RoadNet, drive: Line): Site['docks'] {
  const W = (lx: number, lz: number) => toWorld(site, lx, lz);
  const inLane = net.lanePath(drive, 0, drive.len, 0);
  return dockXs(site.st.docks).map((x, k) => {
    const r = storeRoute(site, k);
    const door = W(x, EXT.z0);
    if (!r) return { approach: [...inLane, W(x - 9, EXT.z0 - 17)], reverse: [W(x, EXT.z0 - 6), W(x, EXT.z0 - 0.6)], door };
    const lane = r.lane.pts.filter((_, i) => r.lane.cum[i] === undefined || (r.lane.cum[i] as number) >= r.sGate);
    const approach = [...inLane, ...lane.map((p) => yardW(site, p))];
    const back = r.back.path.pts.map((p) => yardW(site, p));
    return { approach, reverse: back.length > 1 ? back : [W(x, EXT.z0 - 6), W(x, EXT.z0 - 0.6)], door };
  });
}

function registerDocks(net: RoadNet, site: Site): void {
  const gate = `${site.st.key}:truck`;
  const drive = site.truck ? (net.lines[site.truck.line] as Line) : undefined;
  const outLane = drive ? net.lanePath(drive, drive.len, 0, 0) : [];
  site.docks.forEach((d, k) => {
    const r = storeRoute(site, k);
    const exit = r ? [...sampleLike(r.exit.path).map((p) => yardW(site, p)), ...outLane] : undefined;
    net.places.set(k ? `${site.st.key}#${k + 1}` : site.st.key, { junction: gate, path: d.approach, reverse: d.reverse, ...(exit ? { exit, joinS: 0 } : {}) } as Parameters<typeof net.places.set>[1]);
  });
}

/** 线上配送车的装车位：倒进去（车尾朝店房，从后门装车），走的时候往前拉出来、沿服务车道往南、从西侧出口出去 */
function registerVan(net: RoadNet, site: Site, access: Line): void {
  const { lot } = site;
  const W = (lx: number, lz: number) => toWorld(site, lx, lz);
  const w = lot.west;
  const fz = lot.frontage.z;
  const v1 = lot.stalls[lot.vans[0] as number];
  if (!v1) return;
  const inRoad = net.lanePath(access, site.access.sSplit, access.len, 0);
  const outRoad = net.lanePath(access, access.len, site.access.sSplit, 0);
  const g0 = lot.gates[0] as StoreLot['gates'][number];
  const bc = w.bulb.c;
  const path = [
    ...inRoad,
    W(-6, fz - 1.75),
    W(g0.inX + 7, fz - 1.75),
    W(g0.inX, fz - 6),
    W(g0.inX, lot.edgeZ - 3),
    W(w.outerX, w.zSouth),
    W(w.outerX, bc.z + 3),
    W(bc.x - w.bulb.r, bc.z),
    W(bc.x, bc.z - w.bulb.r),
    W(bc.x + w.bulb.r, bc.z),
    W(w.serviceX, bc.z + w.bulb.r + 2),
    W(w.serviceX, v1.z + 7),
  ];
  const reverse = [W(w.serviceX + 1.2, v1.z + 3), W(v1.x - 0.5, v1.z)];
  const exit = [W(w.serviceX + 0.6, v1.z + 3.5), W(w.serviceX, v1.z + 9), W(w.serviceX, w.zSouth - 2), W(w.serviceX - 3, lot.fireLane[0] + 2.5), W(outLaneX(g0.x), lot.fireLane[1] + 4), W(outLaneX(g0.x), lot.edgeZ + 1), W(outLaneX(g0.x) + 6, fz + 1.75), W(-6, fz + 1.75), ...outRoad];
  site.vanBay = path;
  net.places.set(`${site.st.key}:van`, { junction: `${site.st.key}:truck`, path, reverse, exit, joinS: 0 } as Parameters<typeof net.places.set>[1]);
}

/** 门店换布局（上一代 / StoreX）时收货口不变（收货区在百货馆后面）；保留这个入口给视图调用 */
export function setFlagshipDocks(net: RoadNet, sites: Map<string, Site>, gen: 'storex' | 'gen1'): void {
  void gen;
  for (const site of sites.values()) registerDocks(net, site);
}

export interface StoreMeshes {
  group: THREE.Group;
  /** 切换方案：上一代 / StoreX 外观 */
  setGeneration: (gen: 'g1' | 'storex') => void;
  /** 镜头拉近：隐藏百货馆的屋顶，露出收货台、后仓和卖场 */
  setCutaway: (on: boolean) => void;
}

/**
 * 百货日用馆和收货区（本地坐标，StoreX 模型的中心在原点、正面朝 +z）：店房、玻璃入口、屋面设备，
 * 店后的收货场、4 个收货口（卷帘门、门罩、防撞块、调平板、编号牌）、挂车位、压缩垃圾箱、门卫亭；店前的停车场。
 */
function extensionGeometry(site: Site, gen: 'g1' | 'storex'): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; roof: THREE.BufferGeometry } {
  const g = new GeoBuilder();
  const gl = new GeoBuilder();
  const rf = new GeoBuilder();
  const DOCK_X = dockXs();
  const fac = currentFacilities().store;
  const sx = gen === 'storex';
  const { x0, x1, z0, z1, h } = EXT;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const wall = sx ? '#eef0f1' : '#ebe5d8';
  const trim = sx ? '#2a78d6' : '#c8553d';
  const rr = rand(site.st.id * 17 + (sx ? 3 : 1));
  // 连廊两边的绿化（店前停车场、取货区、收货场的地面和标线由 store/ 画）
  g.color('#7ea35f');
  for (const x of [-20, 20]) g.box(x, 0.05, -34, 24, 0.3, 4.6);
  // 店房：外墙（北墙留 4 个收货口的门洞、南墙留连廊的门洞）、地坪；屋面、女儿墙、屋顶设备另放（镜头拉近时隐藏，露出店里）
  const T = 0.4;
  const B = 0.2;
  g.color(wall);
  g.box(x0 + T / 2, B, cz, T, h, d);
  g.box(x1 - T / 2, B, cz, T, h, d);
  g.box(cx, B, z0 + T / 2, w, 1.1 - B, T);
  g.box(cx, 4.5, z0 + T / 2, w, h + B - 4.5, T);
  const xs = [x0, ...DOCK_X.flatMap((x) => [x - 1.6, x + 1.6]), x1];
  for (let i = 0; i < xs.length; i += 2) g.box(((xs[i] as number) + (xs[i + 1] as number)) / 2, 1.1, z0 + T / 2, (xs[i + 1] as number) - (xs[i] as number), 3.4, T);
  g.box((x0 - 5) / 2, B, z1 - T / 2, -5 - x0, h, T);
  g.box((x1 + 5) / 2, B, z1 - T / 2, x1 - 5, h, T);
  g.box(0, 5.0, z1 - T / 2, 10, h + B - 5.0, T);
  rf.color('#c9ccd0').box(cx, h + 0.2, cz, w - 1, 0.1, d - 1);
  for (const [bx, bz, bw, bd] of [[cx, z1 - 0.3, w, 0.6], [cx, z0 + 0.3, w, 0.6], [x0 + 0.3, cz, 0.6, d], [x1 - 0.3, cz, 0.6, d]] as const) rf.color(wall).box(bx, h + 0.2, bz, bw, 1, bd);
  // 店里：地坪；收货台（北墙内侧 8 米深、1.1 米高，台边黄线）；后仓三排货架；后仓和卖场之间的隔墙（中间一樘双开门）；卖场一排排货架和收银台
  const DX0 = DOCK_X[0] as number;
  const DX1 = DOCK_X[DOCK_X.length - 1] as number;
  g.color('#a7aaa6').box(cx, B, cz, w - 2 * T, 0.05, d - 2 * T);
  g.color('#b8bcc0').box((DX0 + DX1) / 2, B, z0 + T + 4, DX1 - DX0 + 12, 1.1 - B, 8);
  g.color('#f0c419').box((DX0 + DX1) / 2, 1.1, z0 + T + 7.9, DX1 - DX0 + 12, 0.02, 0.15);
  g.color('#8d9196').box(DX1 + 8, B, z0 + T + 10, 4, 0.5, 4);
  for (const rz of Array.from({ length: Math.max(1, Math.min(5, fac.backroom)) }, (_, k) => 10.5 + k * (12 / Math.max(1, fac.backroom - 1 || 1)))) {
    g.color('#2a4f7a').box(cx, B, z0 + rz, w - 10, 5.4, 1.1);
    for (let l = 0; l < 3; l++) {
      g.color(['#c8a26a', '#e6dcc8', '#b9a07a'][l] as string);
      for (let x = x0 + 6; x < x1 - 6; x += 2.8) if (rr() > 0.15) g.box(x + 1.3, B + 0.2 + l * 1.8, z0 + rz, 2.4, 1.3, 1.16);
    }
  }
  g.color('#d9dcdf');
  g.box((x0 + -2) / 2, B, z0 + 24, -2 - x0, 4.5, 0.25);
  g.box((x1 + 2) / 2, B, z0 + 24, x1 - 2, 4.5, 0.25);
  const goods = ['#d0533f', '#e8b04a', '#3f8fd0', '#5aa55a', '#9b6bc4', '#e07a3a', '#3fb0a8', '#c44a6e'];
  const gStep = (x1 - x0 - 7) / Math.max(4, fac.gondolas);
  for (let x = x0 + 4; x < x1 - 3; x += gStep) {
    g.color('#cfd3d6').box(x, B, (z0 + 27 + z1 - 7) / 2, 1.3, 1.9, z1 - 7 - (z0 + 27));
    for (let l = 0; l < 4; l++)
      for (let k = 0; k < 6; k++) {
        const zz = z0 + 27 + 0.3 + k * ((z1 - 7 - (z0 + 27)) / 6);
        g.color(goods[Math.floor(rr() * goods.length)] as string).box(x, B + 0.25 + l * 0.42, zz + 1.4, 1.4, 0.28, (z1 - 7 - (z0 + 27)) / 6 - 0.4);
      }
  }
  for (const x of [-26, -18, 14, 22]) g.color('#e9eaec').box(x, B, z1 - 3.5, 1.2, 0.95, 2.6);
  // 正面高出 StoreX 店房的那截墙上：一条色带（不挂店名）；东墙的大窗和员工入口
  g.color(trim).box(cx, h - 2.4, z1 + 0.05, w + 0.4, 2.2, 0.4);
  gl.color('#2b3d4f');
  for (let k = 0; k < Math.floor((d - 8) / 8); k++) gl.box(x1 + 0.08, 3.2, z0 + 6 + k * 8, 0.25, 3, 5.5);
  g.color('#3a4047').box(x0 - 0.05, 0.2, z1 - 6, 0.3, 2.6, 1.4);
  // 玻璃连廊（顾客从 StoreX 店房走到百货馆）
  gl.color('#3d5a73').box(0, 0.25, (z1 - 31) / 2 - 0.5, 12, 4.8, 31 + z1 + 1);
  g.color('#d9dce0').box(0, 5.05, (z1 - 31) / 2 - 0.5, 13, 0.4, 31 + z1 + 2);
  // 屋顶：空调机组、天窗；StoreX 加光伏
  rf.color('#a9adb2');
  for (let k = 0; k < 6; k++) rf.box(x0 + 6 + rr() * (w - 12), h + 0.3, z0 + 6 + rr() * (d - 12), 3 + rr() * 2, 1.6, 2.2);
  rf.color('#e8eef3');
  for (let k = 0; k < 4; k++) rf.box(x0 + 10 + k * 16, h + 0.3, cz, 3, 0.4, 7);
  if (sx) {
    rf.color('#1e3550');
    for (let x = x0 + 4; x < x1 - 4; x += 5.2) for (let z = z0 + 4; z < z1 - 4; z += 3.4) if (Math.abs(z - cz) > 4.5) rf.box(x, h + 0.45, z, 4.8, 0.18, 2.8);
  }
  // 收货口：门罩（帆布门封）、防撞块、调平板、编号牌（卷帘门会动，由 ops/storeDocks 画）；上面一条雨棚
  const DL = DOCK_X[DOCK_X.length - 1] as number;
  g.color('#d4d7da').box((DOCK_X[0]! + DL) / 2, 4.9, z0 - 2.2, DL - DOCK_X[0]! + 10, 0.35, 4.6);
  DOCK_X.forEach((x) => {
    g.color('#23272c').box(x, 1.0, z0 - 0.45, 3.8, 0.35, 0.8);
    g.color('#2b2f34');
    for (const k of [-1, 1]) g.box(x + k * 1.95, 0.9, z0 - 0.5, 0.35, 3.8, 0.9);
    g.color('#2b2f34').box(x, 4.55, z0 - 0.5, 4.3, 0.4, 0.9);
    g.color('#6b7177').box(x, 1.0, z0 - 1.3, 2.6, 0.12, 1.6);
    g.color('#e9b730');
    for (const k of [-1, 1]) g.box(x + k * 1.7, 0.75, z0 - 0.75, 0.35, 0.7, 0.45);
    g.color('#ffffff').box(x, 4.95, z0 - 0.62, 0.9, 0.6, 0.06);
  });
  // 收货平台和台阶（门在 1.1 米高的平台上）
  g.color('#b8bcc0').box((DOCK_X[0]! + DL) / 2, 0.2, z0 - 0.15, DL - DOCK_X[0]! + 8, 0.95, 0.4);
  // 收货口旁的压缩垃圾箱、空托盘堆（贴着墙，不挡倒车）
  g.color('#4d6b4a').box(x1 - 4, 0.2, z0 - 1.9, 6, 2.6, 3.2);
  g.color('#a8814d');
  for (let k = 0; k < 6; k++) g.box(x0 + 2 + (k % 3) * 1.4, 0.2 + Math.floor(k / 3) * 0.9, z0 - 0.9, 1.2, 0.8, 1.0);
  return { body: g.build(), glass: gl.build(), roof: rf.build() };
}

export function buildStores(sites: Map<string, Site>): StoreMeshes {
  const group = new THREE.Group();
  group.name = 'stores';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 });
  const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.5, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 0 });
  const variants: Record<'g1' | 'storex', THREE.Group[]> = { g1: [], storex: [] };
  const roofs: THREE.Mesh[] = [];
  for (const site of sites.values()) {
    for (const gen of ['g1', 'storex'] as const) {
      const sg = new THREE.Group();
      sg.position.copy(site.center);
      sg.rotation.y = site.rot;
      const { body, glass, roof } = extensionGeometry(site, gen);
      const m = new THREE.Mesh(body, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      sg.add(m);
      const rm = new THREE.Mesh(roof, mat);
      rm.castShadow = true;
      rm.name = 'extension-roof';
      roofs.push(rm);
      sg.add(rm);
      sg.add(new THREE.Mesh(glass, glassMat));
      sg.visible = gen === 'storex';
      variants[gen].push(sg);
      group.add(sg);
    }
  }
  group.userData.glass = glassMat;
  return {
    group,
    setGeneration: (gen) => {
      for (const g of variants.g1) g.visible = gen === 'g1';
      for (const g of variants.storex) g.visible = gen === 'storex';
    },
    setCutaway: (on) => {
      for (const r of roofs) r.visible = !on;
    },
  };
}
