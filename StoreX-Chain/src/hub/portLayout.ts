import { planYard, type YardDoorInput, type YardInput, type YardPlan, type YardVehicle } from '@storewright/yard';

/**
 * 港口物流中心的布置（港口的局部坐标，米：x 向东，z 向南——海在 +z 一侧）。三维（web/src/three/ops/portLogistics.ts）和
 * 作业计划（src/hub/port.ts）共用这一份：门的位置、场地的范围、进场道路，场地按收货场引擎（yard/）排车道。
 *
 * 物流中心在码头闸口里面、堆场北边的一条地块上（z 1140–1236，闸口西边），是海关监管的作业场所，围网围着；
 * 南边贴着堆场最外侧那条车道（DRIVE，z 1240 / 1244），所有的车都从这条车道进出各个场地：
 *   西 ← 空箱堆场 · 机检通道 · 查验台 · 保税仓库 · 拆装箱库（集装箱侧 | 货车侧）· 待命区和拖车停车位 · 办公楼 → 东（闸口）
 * 库房的月台都朝南（门在南墙上），门前是场地，场地朝南接车道（收货场引擎的 from: 'front'），进场道路在场地西头
 * （左侧进场：靠台车道向东，驶过门、车头外摆、从司机一侧倒车靠台；拉出以后向西开回进场道路）。
 * 进深按 16.8 米的铰接车定：最紧凑的布置（靠台车道 + 驶离车道，排队排在进场道路上）约 49 米，从场地外沿下来的转弯再要 13 米。
 * 第一个门离进场道路约 50 米（倒车前要有一段直线驶近）。月台门距 4.3 米、门宽 3 米。
 */

/** 月台墙（库房南墙）、围网、车道（北侧那条向西、南侧那条向东）、地块的东西头 */
export const PL = {
  zWall: 1174.5,
  zNorth: 1140.5,
  zFence: 1236.5,
  zLaneW: 1240,
  zLaneE: 1244,
  zDrive: 1242,
  driveHalf: 4.5,
  xWest: -2945,
  xEast: -2165,
  doorPitch: 4.3,
  doorW: 3.0,
};

/** 一个场地（一面月台墙的一段）：仿真 / 计划里的键、门、能靠的车、场地的东西范围 */
export interface PortSection {
  key: 'port-cfs-box' | 'port-cfs-truck' | 'port-bonded' | 'port-inspect';
  label: string;
  /** 场地的西头、东头（进场道路在西头） */
  x0: number;
  x1: number;
  doors: YardDoorInput[];
  kinds: YardVehicle[];
}

const doorsFrom = (prefix: string, x: number, n: number, pitch: number, kinds: YardVehicle[], cold: (i: number) => boolean = () => false): YardDoorInput[] =>
  Array.from({ length: n }, (_, i) => ({ x: x + i * pitch, kinds, cold: cold(i), id: `${prefix}${String(i + 1).padStart(2, '0')}` }));

/** 查验台的车位间距（比月台门宽：两边要走人、开箱门） */
export const BAY_PITCH = 6;

/**
 * 四个场地：拆装箱库的集装箱侧（场内拖车拉着骨架车来甩挂）、货车侧（外面的半挂车），保税仓库（半挂车、冷藏半挂车），
 * 开箱查验台（场内拖车把箱倒到台边甩下）。门的 x 按「进场道路 9 米 + 50 米直线驶近」排。
 */
export const SECTIONS: PortSection[] = [
  { key: 'port-inspect', label: '开箱查验台', x0: -2746, x1: -2622, doors: doorsFrom('查验位', -2696, 8, BAY_PITCH, ['chassis']), kinds: ['chassis'] },
  { key: 'port-bonded', label: '保税仓库', x0: -2618, x1: -2505, doors: doorsFrom('B', -2568, 10, PL.doorPitch, ['semi', 'reefer'], (i) => i >= 8), kinds: ['semi', 'reefer'] },
  { key: 'port-cfs-box', label: '拆装箱库 · 集装箱侧', x0: -2502, x1: -2390, doors: doorsFrom('K', -2452, 10, PL.doorPitch, ['chassis']), kinds: ['chassis'] },
  { key: 'port-cfs-truck', label: '拆装箱库 · 货车侧', x0: -2386, x1: -2262, doors: doorsFrom('C', -2336, 14, PL.doorPitch, ['semi', 'reefer']), kinds: ['semi', 'reefer'] },
];
export const sectionOf = (key: PortSection['key']): PortSection => SECTIONS.find((s) => s.key === key) as PortSection;

/** 收货场引擎的输入：墙在本地 z = 0（PL.zWall），场地朝南（本地 +z = 港口 +z），本地 x = 港口 x；进场道路接车道 */
export function sectionInput(s: PortSection): YardInput {
  const depth = PL.zFence - PL.zWall;
  return {
    doors: s.doors,
    x0: s.x0,
    x1: s.x1,
    depth,
    side: 'left',
    from: 'front',
    access: 'drive',
    road: { z: PL.zDrive - PL.zWall, half: PL.driveHalf, spanX: [PL.xWest, PL.xEast] },
  };
}

const PLANS = new Map<string, YardPlan>();
/** 一个场地排好的车道（只排一次） */
export function sectionPlan(key: PortSection['key']): YardPlan {
  let p = PLANS.get(key);
  if (!p) PLANS.set(key, (p = planYard(sectionInput(sectionOf(key)))));
  return p;
}
/** 本地（场地）坐标 → 港口局部坐标 */
export const toPort = (p: { x: number; z: number }): { x: number; z: number } => ({ x: p.x, z: p.z + PL.zWall });

/** 门数（作业计划按它排） */
export const CFS_BOX_DOORS = sectionOf('port-cfs-box').doors.length;
export const CFS_TRUCK_DOORS = sectionOf('port-cfs-truck').doors.length;
export const BONDED_DOORS = sectionOf('port-bonded').doors.length;
export const INSPECT_BAYS = sectionOf('port-inspect').doors.length;

/** 其它区域（港口局部坐标）：空箱堆场、机检通道、待命区、拖车停车位、办公楼 */
export const AREAS = {
  /**
   * 空箱堆场：两个箱区（每个 3 排 × 11 个贝位，40 尺箱沿 x 摆），中间是装卸车道（停车的一条 laneZ、过路的一条 passZ，
   * 车从东头进、西头出，后面的车从停着的车旁边过去），两台正面吊分别在车道和南、北箱区之间
   */
  depot: { x0: -2943, x1: -2800, bays: 7, bayPitch: 20.4, rowPitch: 2.7, blocks: [{ z: 1200 }, { z: 1160 }], laneZ: 1183, passZ: 1189, stackerZ: [1194.5, 1173] },
  /** 机检通道：南北向的一条车道，车从车道（南）开进来、向北慢慢穿过检查门架，绕回来再向南开出去 */
  scan: { xIn: -2786, xOut: -2762, z0: 1162, portal: [1186, 1212] as [number, number], loopZ: 1160 },
  /** 待命区（外面的货车等门）：一排南北向的车位 */
  hold: { x0: -2258, x1: -2222, z0: 1186, z1: 1206, n: 8 },
  /** 拖车停车位：南北向的穿越式车位，南边的进场车道向西、北边的出场车道向东 */
  park: { x0: -2216, x1: -2172, laneIn: 1228, laneOut: 1180, stallZ: [1192, 1214] as [number, number] },
  /** 物流中心办公楼（海关监管办公、调度） */
  office: { x0: -2256, x1: -2226, z0: 1144, z1: 1168 },
  /** 堆场交接点：码头堆场西头 2 号箱区旁边的通道里（龙门吊在这里放箱、取箱） */
  cy: { x: -2210, z: 1266 },
};

// ———————————————————————— 闸口里面的路口 ————————————————————————

/**
 * 闸口里面的路口：进闸的车往南开到车道再分开（去码头箱区的往东、去物流中心和空箱堆场的往西），出来的车拐进出闸车道，几股车在这里交叉。
 * 港口局部坐标的范围（和三维的闸口一样：GATE_X = −2100、GATE_Z = 1222）。港口、物流中心、空箱堆场的闸口计划都按这个范围、
 * 同一个占用时段（junctionSpan）记进同一张预订表（JunctionBook），进、出的车按它排先后（后到的在闸口外、箱位旁、停车线前等）。
 */
export const JUNCTION = { x0: -2156, x1: -2044, z0: 1229, z1: 1258 } as const;
export const inJunction = (p: { x: number; z: number }): boolean => p.x > JUNCTION.x0 && p.x < JUNCTION.x1 && p.z > JUNCTION.z0 && p.z < JUNCTION.z1;

/**
 * 沿折线 pts 缓起缓停地（和三维一样的 3f² − 2f³）在 [t0, t1] 里从路程 u0 开到终点，车头在 u、车长 L：车身有一部分在路口里的时段。
 * 不经过路口返回 undefined。
 */
export function junctionSpan(pts: readonly { x: number; z: number }[], t0: number, t1: number, u0: number, L: number): [number, number] | undefined {
  if (pts.length < 2 || t1 <= t0) return undefined;
  // 路程区间只和折线、起点、车长有关：同一条折线反复算（往后挪时刻试）的时候直接拿
  let byKey = SPAN_U.get(pts);
  if (!byKey) {
    byKey = new Map();
    SPAN_U.set(pts, byKey);
  }
  const key = `${u0}|${L}`;
  let r = byKey.get(key);
  if (!r) {
    r = spanU(pts, u0, L);
    byKey.set(key, r);
  }
  const { uA, uB, total } = r;
  if (uA < 0) return undefined;
  const D = Math.max(1e-6, total - u0);
  const tOf = (u: number) => {
    const f = Math.max(0, Math.min(1, (u - u0) / D));
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 24; it++) {
      const m = (lo + hi) / 2;
      if (m * m * (3 - 2 * m) < f) lo = m;
      else hi = m;
    }
    return t0 + ((lo + hi) / 2) * (t1 - t0);
  };
  return [tOf(uA), tOf(Math.min(total, uB + 1))];
}

const SPAN_U = new WeakMap<readonly { x: number; z: number }[], Map<string, { uA: number; uB: number; total: number }>>();
/** 每米取样（车头、车身中间、车尾）有一个点在路口里的路程区间；整条折线碰不到路口就不逐米查。取样点单调往前，各用一个游标 */
function spanU(pts: readonly { x: number; z: number }[], u0: number, L: number): { uA: number; uB: number; total: number } {
  const n = pts.length;
  const cum = [0];
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = pts[i] as { x: number; z: number };
    if (i > 0) cum.push((cum[i - 1] as number) + Math.hypot(p.x - (pts[i - 1] as { x: number }).x, p.z - (pts[i - 1] as { z: number }).z));
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  const total = cum[n - 1] as number;
  if (x1 < JUNCTION.x0 || x0 > JUNCTION.x1 || z1 < JUNCTION.z0 || z0 > JUNCTION.z1) return { uA: -1, uB: -1, total };
  const cur = [1, 1, 1];
  const inside = (c: number, u: number): boolean => {
    const v = Math.max(0, Math.min(total, u));
    let i = cur[c] as number;
    while (i < n - 1 && (cum[i] as number) < v) i++;
    cur[c] = i;
    const a = pts[i - 1] as { x: number; z: number };
    const b = pts[i] as { x: number; z: number };
    const k = (v - (cum[i - 1] as number)) / Math.max(1e-6, (cum[i] as number) - (cum[i - 1] as number));
    return inJunction({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k });
  };
  let uA = -1;
  let uB = -1;
  for (let u = u0; u <= total + 1e-6; u += 1) {
    const h0 = inside(0, u);
    const h1 = inside(1, u - L / 2);
    const h2 = inside(2, u - L);
    if (h0 || h1 || h2) {
      if (uA < 0) uA = u;
      uB = u;
    }
  }
  return { uA, uB, total };
}

/** 路口的预订表：每一段占用（时段），前后留 2 秒 */
export class JunctionBook {
  constructor(readonly list: [number, number][] = []) {}
  busy(span: [number, number] | undefined): boolean {
    return !!span && this.list.some(([a, b]) => a < span[1] + 2 && span[0] < b + 2);
  }
  add(span: [number, number] | undefined): void {
    if (span) this.list.push(span);
  }
}
