import { HUB_SLOTS, tallyOccupancy, type HubDay, type HubFlow, type HubKpi, type HubZone } from './types';
import { toWorld as frameToWorld, type Frame } from '../region/frames';
import { defineYardSite, planYard, type YardFrame, type YardInput, type YardPlan } from '@storewright/yard';

/**
 * 机场货站（航空货运站）一天的作业：所有空运货都经过货站，在飞机和公路车辆之间转一手。
 *
 * - 进口：飞机卸下的集装板（ULD）由板车串拉到空侧板车门 → 门里的滚轮道（核对板号、过磅）→ 升降式板架（ETV）存板 →
 *   拆板工位拆板（生鲜、本店的货优先）→ 散货进普货货架 / 冷藏库（2–8 °C）/ 冷冻库（−18 °C）/ 危险品库 / 贵重品库 /
 *   海关查验区 → 海关放行 → 货代的车在陆侧收货口提走（叉车先把货拉到门里的暂存道）；整板提货的板不拆：ETV → 整板转运道 → 卡车。
 * - 出口：货代的车在出口收货口卸货 → 收货过磅 → 安检（X 光机）→ 出口货架 → 组板（按飞机的板位轮廓、过磅）→ ETV →
 *   起飞前从空侧板车门推出、上板车；卡车送来的整板（货代在外面组好）走整板转运道进 ETV。
 * - 本店的板（生鲜）：拆板优先，进冷藏库等本店的空运冷藏车（仿真给的装车时段），在冷链收货口装车。
 *
 * 资源：每台 ETV 管一段巷道（同一时间只搬一块板）、拆组板工位（每个工位一组 2 人，按排班的「货站拆板组板」人数开组；
 * 出口快赶不上截载、本店的板时加一组）、叉车（一台一次一板）、X 光机、陆侧收货口（一樘一次一辆车，前后留 5 分钟）。
 * 按 15 秒一步推演：每块板、每板货、每辆车、每台设备什么时候在哪都有记录，三维（web/src/three/ops/airTerminal.ts）
 * 按这份计划画，值班助手按这里的 HubDay 回答，两边对得上。时间都是当天 0 点起的秒；同一组输入每次排出来一样。
 *
 * 按公开资料取的假设参数：主货舱板 PMC 3.18 × 2.44 米（PAG / PAJ 3.18 × 2.24 米）、货机主舱轮廓高约 3 米；所有出口货组板前
 * 都要过安检；冷藏库 2–8 °C、冷冻库 −18 °C 以下，危险品单独的库房，贵重品进金库；ETV 走行约 2 米 / 秒，存取一块板一分钟上下；
 * 13.6 米的滚床挂车一车装 4 块主货舱板；陆侧一樘收货口一年约 1.5–2.5 万吨。拆、组板公开的统一工时缺，按通用经验取：
 * 普货板拆板 28–40 分钟、生鲜板 22–30 分钟，组板 35–50 分钟；进口普货放行 1.5–6 小时、生鲜 0.3–1.2 小时；
 * 出口货在起飞前 4.5–8.5 小时送到，截载（组好进 ETV）在推出前 1 小时；别家航班的进口板约 55% 整板提走、出口板约 50% 整板送来；
 * 陆侧装卸一板约 2 分钟。
 */

// ———————————————————————— 布局（局部坐标，和 ops/airport.ts 的跑道、机坪同一个坐标系，沙盘米） ————————————————————————

/** 货站：西端 x0，陆侧墙 z = zLand（收货口），空侧墙 z = zAir（板车门），屋面高 h */
export const TERM = { x0: 1980, zLand: 985, zAir: 1055, h: 18 } as const;
/** ETV：巷道中线、陆侧一排板架、空侧一排板架的 z */
export const ETV_Z = { aisle: 1029.5, rowL: 1025.6, rowA: 1033.4 } as const;
/** 板架三层：板底的高度（米） */
export const LEVEL_Y = [0.75, 4.15, 7.55] as const;
/** 空侧板车门里的滚轮道：0 号位是 ETV 空侧一排的底层（转运台），5 号位在门口 */
export const LANE_Z = [1033.4, 1036.4, 1039.4, 1042.4, 1045.4, 1048.4] as const;
/** 拆组板工位台面中心、叉车主通道、陆侧门里的暂存道 */
export const STATION_Z = 1020.2;
export const AISLE_Z = 1014;
export const STAGE_Z = [988.2, 990.0] as const;
/** 整板转运道（陆侧整板收货口 ↔ ETV 陆侧一排底层）：0 号位在 ETV，最后一位在收货口 */
export const RFS_Z = [1025.6, 1021.4, 1017.2, 1013.0, 1008.8, 1004.6, 1000.4, 996.2, 992.0, 988.4] as const;
/** ETV 的列距：两个机位的板车门相隔 92 米 = 26 列，门正对着一列 */
export const PITCH = 92 / 26;

export type StoreKey = 'bulk' | 'export' | 'chill' | 'frozen' | 'dg' | 'vault' | 'customs';
export type DockKind = 'export' | 'uld' | 'cold' | 'import';
export interface Loc {
  x: number;
  z: number;
  y: number;
  /** 叉车取放这个位置时站在哪条通道上（z）；不给 = 就站在这里（空地上的位置） */
  az?: number;
}
export interface TermLayout {
  x0: number;
  x1: number;
  /** ETV 每一列的 x */
  cols: number[];
  /** 每台 ETV 管的列（下标，含头不含尾）、平时停的列 */
  cranes: { c0: number; c1: number; home: number }[];
  /** 板架上的存板位（工位、转运台占了的底层位置不算） */
  slots: Array<Loc & { col: number; side: 0 | 1; level: number; crane: number }>;
  /** 空侧板车门里的两条滚轮道：进来的（正对门的那一列）、出去的（东边紧挨着的一列）；哪台 ETV；stand = 对着几号机位 */
  lanes: { x: number; col: number; xOut: number; colOut: number; crane: number; stand: number }[];
  /** 拆组板工位：x、列、哪台 ETV */
  stations: { x: number; col: number; crane: number }[];
  /** 整板转运道：x、列、哪台 ETV、接哪樘收货口 */
  rfs: { x: number; col: number; crane: number; dock: number }[];
  store: Record<StoreKey, Loc[]>;
  /** X 光机（通道沿 z，入口在 z0、出口在 z1） */
  xray: { x: number; z0: number; z1: number }[];
  /** 陆侧收货口：x、用途、冷链门、编号 */
  docks: { x: number; kind: DockKind; cold: boolean; id: string }[];
  /** 仿真里本店空运冷藏车靠的收货口（x = 2038，见 places.ts 的 AIR） */
  simDock: number;
  /** 库房里的房间和区域（画墙、围栏、地面颜色） */
  rooms: { key: string; label: string; x0: number; x1: number; z0: number; z1: number }[];
  /** 叉车的停放充电位 */
  forkHome: Loc[];
  /** 货架区里的横通道（x）：叉车从货架通道到主通道、前通道都走这些 */
  crossX: number[];
}
/** 门里的前通道（暂存道和货架之间）、叉车主通道（货架和工位之间） */
export const FRONT_Z = 991.6;

const STORE_LABEL: Record<StoreKey, string> = { bulk: '进口普货货架', export: '出口货架', chill: '冷藏库（2–8 °C）', frozen: '冷冻库（−18 °C）', dg: '危险品库', vault: '贵重品库', customs: '海关查验区' };
/** 本店空运冷藏车靠的收货口（仿真的 AIR 停靠点倒车到 x = 2038） */
export const SIM_DOCK_X = 2038;

/**
 * 按机位对着的板车门和货站东端排布局。从西往东：出口收货（3 樘门，收货过磅、2 台 X 光机、出口货架）、
 * 整板转运（ETV 西头两条转运道接 2 樘整板收货口）、冷链（冷藏库、冷冻库，4 樘带蓝色门头的冷链门，其中 x = 2038 是本店冷藏车的）、
 * 进口普货货架（门 6 樘起，机位多了加门）、东头的海关查验区、危险品库和贵重品库；每台 ETV 管的那段巷道东头再接一条整板转运道。
 * 库房纵深 70 米：陆侧门里 6 米暂存道，往里 21 米货架和冷库，4 米叉车主通道，8 米工位，ETV（两排三层板架夹一条巷道），
 * 空侧 20 米滚轮道接板车门。
 */
export function terminalLayout(standDocks: readonly number[], x1: number): TermLayout {
  const x0 = TERM.x0;
  const first = (standDocks[0] ?? 2048) - 9 * PITCH;
  const lastDock = standDocks[standDocks.length - 1] ?? first;
  const end = Math.min(x1 - 8, lastDock + 5 * PITCH);
  const nCols = Math.max(12, Math.floor((end - first) / PITCH + 1e-6) + 1);
  const cols = Array.from({ length: nCols }, (_, i) => first + i * PITCH);
  const nCranes = Math.max(2, Math.round((nCols * PITCH) / 72));
  const cranes = Array.from({ length: nCranes }, (_, k) => {
    const c0 = Math.round((k * nCols) / nCranes);
    const c1 = Math.round(((k + 1) * nCols) / nCranes);
    return { c0, c1, home: Math.floor((c0 + c1) / 2) };
  });
  const craneOf = (c: number) => Math.max(0, cranes.findIndex((k) => c >= k.c0 && c < k.c1));
  const colOf = (x: number) => Math.max(0, Math.min(nCols - 1, Math.round((x - first) / PITCH)));
  const lanes = standDocks.map((x, stand) => {
    const col = Math.min(colOf(x), nCols - 2);
    return { x: cols[col] as number, col, xOut: cols[col + 1] as number, colOut: col + 1, crane: craneOf(col), stand };
  });
  // 整板转运道：西头两条（第 0、2 列），其余每台 ETV 那段的东头两条
  const rfsCols = [0, 2, ...cranes.slice(1).flatMap((k) => [k.c1 - 3, k.c1 - 1])];
  // 拆组板工位：每台 ETV 那段 4 个，避开整板转运道的列
  const stationCols: number[] = [];
  for (const k of cranes) {
    const free = Array.from({ length: k.c1 - k.c0 }, (_, i) => k.c0 + i).filter((c) => !rfsCols.some((r) => Math.abs(r - c) <= 1));
    for (let j = 0; j < 4 && free.length; j++) stationCols.push(free[Math.min(free.length - 1, Math.floor(((j + 0.5) * free.length) / 4))] as number);
  }
  const stations = stationCols.map((col) => ({ x: cols[col] as number, col, crane: craneOf(col) }));
  const slots: TermLayout['slots'] = [];
  for (let col = 0; col < nCols; col++)
    for (const side of [0, 1] as const)
      for (let level = 0; level < 3; level++) {
        if (level === 0 && side === 0 && (stationCols.includes(col) || rfsCols.includes(col))) continue;
        if (level === 0 && side === 1 && lanes.some((l) => l.col === col || l.colOut === col)) continue;
        slots.push({ x: cols[col] as number, z: side === 0 ? ETV_Z.rowL : ETV_Z.rowA, y: LEVEL_Y[level] as number, col, side, level, crane: craneOf(col) });
      }
  // —— 陆侧收货口 ——
  const docks: TermLayout['docks'] = [];
  const dock = (x: number, kind: DockKind, id: string) => docks.push({ x, kind, cold: kind === 'cold', id });
  // 出口门离货车专用通道（x ≈ 1966）至少 30 米：拉出转弯以后要接得上驶离的转弯
  [1997, 2001.5, 2006, 2010.5].forEach((x, i) => dock(x, 'export', `出口 ${i + 1}`));
  const rfs: TermLayout['rfs'] = [];
  rfsCols.forEach((col, i) => {
    const x = cols[col] as number;
    rfs.push({ x, col, crane: craneOf(col), dock: docks.length });
    dock(x, 'uld', `整板 ${i + 1}`);
  });
  [SIM_DOCK_X, SIM_DOCK_X + 4.5, SIM_DOCK_X + 9, SIM_DOCK_X + 13.5].forEach((x, i) => dock(x, 'cold', `冷链 ${i + 1}`));
  const imports = 8 + 2 * Math.max(0, standDocks.length - 2);
  const rfsEast = rfs.slice(2).map((r) => r.x);
  let xi = 2090;
  for (let k = 0; k < imports && xi < x1 - 50; k++) {
    while (rfsEast.some((x) => Math.abs(x - xi) < 6)) xi += 4.5;
    dock(xi, 'import', `进口 ${k + 1}`);
    xi += 4.5;
  }
  docks.sort((a, b) => a.x - b.x);
  // 排序以后重新对上整板转运道、本店的门
  for (const r of rfs) r.dock = docks.findIndex((d) => d.kind === 'uld' && Math.abs(d.x - r.x) < 0.01);
  const sim = docks.findIndex((d) => d.kind === 'cold' && Math.abs(d.x - SIM_DOCK_X) < 0.01);
  // —— 存货的位置：背靠背的双排货架，每 12 个货位留一条横通道；叉车站在货位朝着的那条通道上取放 ——
  const crossX: number[] = [];
  const rack = (xa: number, xb: number, pairs: readonly [number, number, number, number][], levels: number, gaps: number[] = []): Loc[] => {
    const out: Loc[] = [];
    crossX.push(xa - 0.2, xb + 0.2);
    let bay = 0;
    for (let x = xa + 0.7; x < xb - 0.6; x += 1.35) {
      if (gaps.some((g) => Math.abs(g - x) < 5.5)) continue;
      if (bay % 13 === 12) {
        crossX.push(x);
        bay++;
        continue;
      }
      bay++;
      for (const [za, aa, zb, ab] of pairs)
        for (let l = 0; l < levels; l++) {
          out.push({ x, z: za, y: 0.15 + l * 1.6, az: aa });
          out.push({ x, z: zb, y: 0.15 + l * 1.6, az: ab });
        }
    }
    return out;
  };
  // 三组双排：994.2 / 995.5、1000.2 / 1001.5、1006.2 / 1007.5，通道在 991.6、997.85、1003.85、1010
  const rows3: [number, number, number, number][] = [
    [994.2, FRONT_Z, 995.5, 997.85],
    [1000.2, 997.85, 1001.5, 1003.85],
    [1006.2, 1003.85, 1007.5, 1010],
  ];
  const rfsX = rfs.map((r) => r.x);
  const store: Record<StoreKey, Loc[]> = {
    export: rack(1984, 2011, [
      [1004.2, 1002.6, 1005.5, 1007.55],
      [1009.6, 1007.55, 1010.9, AISLE_Z],
    ], 3),
    chill: rack(2036, 2063, rows3, 2),
    frozen: rack(2064, 2076, rows3, 2),
    bulk: rack(2078, x1 - 48, rows3, 3, rfsX),
    customs: [],
    dg: [],
    vault: [],
  };
  for (const g of rfsX) crossX.push(g);
  for (let x = x1 - 45; x < x1 - 23; x += 1.7) for (const z of [994, 996.2, 1000.2, 1002.4, 1006.4, 1008.6]) store.customs.push({ x, z, y: 0.15 });
  for (let x = x1 - 19; x < x1 - 5; x += 1.7) for (const z of [993.4, 995.6, 997.8]) store.dg.push({ x, z, y: 0.15 });
  for (let x = x1 - 19; x < x1 - 5; x += 1.7) for (const z of [1004, 1007, 1010]) for (const y of [0.15, 1.25]) store.vault.push({ x, z, y, az: z - 1.3 });
  crossX.push(x1 - 46, x1 - 21, x1 - 3.8);
  crossX.sort((a, b) => a - b);
  const rooms: TermLayout['rooms'] = [
    { key: 'accept', label: '出口收货过磅', x0: 1983, x1: 2011, z0: 986, z1: 992 },
    { key: 'xray', label: '安检（X 光机）', x0: 1983, x1: 2011, z0: 992.5, z1: 1002 },
    { key: 'export', label: '出口货架', x0: 1983, x1: 2011, z0: 1003, z1: 1012 },
    { key: 'uld', label: '整板转运', x0: 2012, x1: 2035, z0: 986, z1: 1012 },
    { key: 'chill', label: '冷藏库 2–8 °C', x0: 2035.5, x1: 2063.5, z0: 992, z1: 1011.5 },
    { key: 'frozen', label: '冷冻库 −18 °C', x0: 2063.5, x1: 2077, z0: 992, z1: 1011.5 },
    { key: 'coldDock', label: '冷链穿堂', x0: 2035.5, x1: 2077, z0: 985.5, z1: 991.6 },
    { key: 'bulk', label: '进口普货货架', x0: 2077.5, x1: x1 - 47, z0: 992, z1: 1012 },
    { key: 'customs', label: '海关查验区', x0: x1 - 46.5, x1: x1 - 21.5, z0: 992, z1: 1011.5 },
    { key: 'dg', label: '危险品库', x0: x1 - 20.5, x1: x1 - 3.5, z0: 992, z1: 999.5 },
    { key: 'vault', label: '贵重品库', x0: x1 - 20.5, x1: x1 - 3.5, z0: 1001.5, z1: 1011.5 },
    { key: 'work', label: '拆组板工位', x0: (cols[0] as number) - 2, x1: (cols[nCols - 1] as number) + 2, z0: 1016, z1: 1024 },
    { key: 'etv', label: 'ETV 升降式板架', x0: (cols[0] as number) - 2, x1: (cols[nCols - 1] as number) + 2, z0: 1024, z1: 1035 },
  ];
  const xray = [
    { x: 1991, z0: 993, z1: 1001.5 },
    { x: 2004, z0: 993, z1: 1001.5 },
  ];
  // 叉车充电位：西头、东头的主通道边上各 6 台
  const forkHome = Array.from({ length: 14 }, (_, i) => ({ x: i < 7 ? 1985 + i * 2.2 : x1 - 19 + (i - 7) * 2.2, z: AISLE_Z + 1.6, y: 0 }));
  return { x0, x1, cols, cranes, slots, lanes, stations, rfs, store, xray, docks, simDock: sim, rooms, forkHome, crossX };
}

// ———————————————————————— 陆侧卡车场（收货场引擎的输入，三维、货站计划、运动规划共用） ————————————————————————

/** 收货场引擎要的输入（和 @storewright/yard 的 YardInput 一样的字段） */
export interface LandsideYardInput {
  doors: { x: number; kinds: ('semi' | 'reefer' | 'chassis' | 'truck' | 'van')[]; cold: boolean; id: string }[];
  x0: number;
  x1: number;
  depth: number;
  side: 'right';
  from: 'back';
  access: 'drive';
  driveX: number;
  driveHalf: number;
  driveLen: number;
  queue: number;
  sectionSpan: number;
}
/** 进场路（货站西边那一段是直的，从尽头的回车场到陆侧墙）：中心线、两条车道离中心线 8.6 米（中间是分隔带） */
export const TRUCK_DRIVE_X = 1950;
export const TRUCK_DRIVE_HALF = 17.2;
/**
 * 陆侧卡车场：收货场引擎的本地坐标里，墙在 z = 0、场地朝 +z，本地 +x 朝机场的 −x（所以转了 180°：yaw = π），
 * 原点在货站东端、陆侧墙上（机场局部坐标 (x1, zLand)）。进场道路就是机场的进场路在货站西边的那一段（直的）：
 * 货车先开到尽头的回车场掉头，沿出场一侧往北开上来、右转进待命车道；走的时候拉出、沿驶离车道回到进场路，
 * 左转下到进场一侧，到回车场掉头再往北出去。进深 64 米（不出设施的核心区），按紧凑布置排（没有顶部车道）。
 * 每樘门能靠的车：出口、进口门半挂车 / 厢式货车 / 面包车，整板门滚床半挂车，冷链门冷藏车 / 厢式货车 / 面包车。
 */
export function landsideYard(L: TermLayout): { origin: { x: number; z: number }; yaw: number; input: LandsideYardInput } {
  const XO = L.x1;
  const kinds: Record<DockKind, LandsideYardInput['doors'][number]['kinds']> = { export: ['semi', 'truck', 'van'], uld: ['semi'], cold: ['reefer', 'truck', 'van'], import: ['semi', 'truck', 'van'] };
  return {
    origin: { x: XO, z: TERM.zLand },
    yaw: Math.PI,
    input: {
      doors: L.docks.map((d) => ({ x: XO - d.x, kinds: kinds[d.kind], cold: d.cold, id: d.id })),
      x0: 0,
      x1: XO - (TRUCK_DRIVE_X - TRUCK_DRIVE_HALF) + 0.01,
      depth: 64,
      side: 'right',
      from: 'back',
      access: 'drive',
      driveX: XO - TRUCK_DRIVE_X,
      driveHalf: TRUCK_DRIVE_HALF,
      driveLen: 60,
      queue: 0,
      sectionSpan: 70,
    },
  };
}
/** 陆侧卡车场在收货场引擎里登记的键（仿真里本店的空运冷藏车停靠点 AIR 对着冷链 1 号门） */
export const AIR_YARD = 'air-landside';
/** 机位个数 → 每个机位对着的板车门、货站东端（和 ops/airport.ts 的布局一样） */
export function standLayout(stands: number): { docks: number[]; x1: number } {
  const n = Number.isFinite(stands) ? Math.max(2, Math.min(6, Math.round(stands))) : 2;
  const docks = Array.from({ length: n }, (_, i) => 2030 + i * 92 + 18);
  return { docks, x1: n <= 3 ? 2250 : 2030 + (n - 1) * 92 + 38 };
}
const yardCache = new Map<string, YardPlan>();
/**
 * 登记陆侧卡车场（运动规划按它把本店的空运冷藏车开进来、倒车靠上冷链 1 号门）：道路网摆地点时登记一次（场地要在排车辆之前就有），
 * 货站排计划时再登记（换了机位数）。f 是机场的坐标系。
 */
export function registerLandsideYard(L: TermLayout, f: Frame): { plan: YardPlan; frame: YardFrame; origin: { x: number; z: number } } {
  const y = landsideYard(L);
  const key = JSON.stringify(y.input);
  let plan = yardCache.get(key);
  if (!plan) {
    plan = planYard(y.input as unknown as YardInput);
    yardCache.set(key, plan);
  }
  const o = frameToWorld(f, y.origin);
  const frame: YardFrame = { origin: { x: o.x, z: o.z }, yaw: y.yaw + f.rot };
  defineYardSite({ key: AIR_YARD, frame, plan, doors: L.docks.map((d, i) => ({ id: i === L.simDock ? 'AIR' : d.id, index: i })) });
  return { plan, frame, origin: y.origin };
}

// ———————————————————————— 输入 ————————————————————————

export interface AirTermInput {
  seed: number;
  /** 负荷档位（1 = 平常） */
  traffic: number;
  layout: TermLayout;
  flights: { id: string; label: string; own: boolean; tOn: number; tOff: number; stand: number; land: number }[];
  /** 进口板推进板车门的时刻（lane = 第几条滚轮道，按机位） */
  arrivals: { id: string; flight: string; own: boolean; lane: number; t: number }[];
  /** 出口板从板车门推出的时刻 */
  departures: { id: string; flight: string; lane: number; t: number }[];
  /** 本店的空运冷藏车：装车时段（仿真）、装几板 */
  ownTrucks: { id: string; label: string; vid: number; t0: number; t1: number; pallets: number }[];
  /** 某个时刻的「货站拆板组板」在岗人数 */
  crew: (t: number) => number;
}

// ———————————————————————— 计划（三维和值班助手都按它） ————————————————————————

export type Cls = 'general' | 'chill' | 'frozen' | 'dg' | 'vault' | 'customs';
const CLS_STORE: Record<Cls, StoreKey> = { general: 'bulk', chill: 'chill', frozen: 'frozen', dg: 'dg', vault: 'vault', customs: 'customs' };

/** 一块板在某段时间在哪：滚轮道（p0 → p1 滚过去）、存板位、ETV 上、工位、整板转运道、卡车上 */
export interface USpan {
  t0: number;
  t1: number;
  at: 'lane' | 'slot' | 'crane' | 'station' | 'rfs' | 'truck';
  ref: number;
  p0?: number;
  p1?: number;
}
export interface TermUld {
  id: string;
  flight: string;
  own: boolean;
  perishable: boolean;
  dir: 'in' | 'out';
  /** 进口：bd = 拆板、bup = 整板提走；出口：bd = 在货站组板、bup = 卡车送来的整板 */
  mode: 'bd' | 'bup';
  crane: number;
  lane: number;
  spans: USpan[];
  pallets: number[];
  /** 进门、存进 ETV、拆 / 组板开始和结束、离开货站（推出板车门或装上卡车） */
  tIn: number;
  tStored?: number;
  tJob0?: number;
  tJob1?: number;
  tOut?: number;
  /** 出口：推出板车门的时刻、组好进 ETV 的时刻、是不是赶上截载 */
  tDue?: number;
  ready?: boolean;
  truck?: number;
  station?: number;
}
/** 一板货在某段时间在哪：工位旁、叉车上、货位（store + 下标）、门里的暂存道、X 光机、卡车上 */
export interface PSpan {
  t0: number;
  t1: number;
  at: 'station' | 'fork' | 'loc' | 'stage' | 'xray' | 'truck';
  ref: number;
  store?: StoreKey;
}
export interface TermPallet {
  id: string;
  own: boolean;
  cls: Cls;
  dir: 'in' | 'out';
  uld: number;
  flight: string;
  fwd: number;
  spans: PSpan[];
  /** 放行（进口）、进库、离库的时刻 */
  tRel?: number;
  tIn?: number;
  tOut?: number;
  truck?: number;
}
export interface TermMove {
  crane: number;
  uld: number;
  /** 开始、到取板位、推上平台、到放板位、推下去（结束） */
  t0: number;
  a: number;
  b: number;
  c: number;
  t1: number;
  start: Loc;
  from: Loc;
  to: Loc;
}
export interface TermJob {
  station: number;
  uld: number;
  kind: 'bd' | 'bu';
  t0: number;
  t1: number;
  overtime: boolean;
}
export interface TermFork {
  fork: number;
  pallet: number;
  t0: number;
  a: number;
  b: number;
  c: number;
  t1: number;
  start: Loc;
  from: Loc;
  to: Loc;
}
export interface TermTruck {
  id: string;
  label: string;
  kind: 'semi' | 'reefer' | 'truck' | 'van' | 'uld';
  own: boolean;
  vid?: number;
  dir: 'pickup' | 'delivery';
  dock: number;
  /** 预约（本来打算几点到）、到场、靠上、离开 */
  plan: number;
  arrive: number;
  t0: number;
  t1: number;
  pallets: number[];
  ulds: number[];
  fwd: string;
}
export interface AirTermPlan {
  layout: TermLayout;
  ulds: TermUld[];
  pallets: TermPallet[];
  moves: TermMove[];
  jobs: TermJob[];
  forks: TermFork[];
  xrays: { machine: number; pallet: number; t0: number; t1: number }[];
  trucks: TermTruck[];
  hub: HubDay;
  /** 加班组：本店的板、快赶不上截载的出口板临时多开的组 */
  overtime: number;
  notes: string[];
}

// ———————————————————————— 推演 ————————————————————————

const DT = 15;
const T_START = -6 * 3600;
const T_END = 28.5 * 3600;
const CHECK = 120;
const PICK = 16;
const ROLL_V = 0.35;
const FORKS = 14;
const FORK_V = 2.4;
const FORK_HANDLE = 18;
const XRAY_SEC = 150;
const GAP = 300;
/** 进口：放行要多久（小时）、货代凑一车最多等多久（小时）、一车装几板 */
const REL: Record<Cls, [number, number]> = { general: [1.5, 6], chill: [0.3, 1.2], frozen: [0.3, 1.2], dg: [2, 5], vault: [1, 3], customs: [3, 7] };
/** 货代：车型、一车装几板、凑车最多等几小时、占的份额 */
const FWD = [
  { name: '货代甲', kind: 'semi', cap: 26, wait: 3, cold: false, w: 0.26 },
  { name: '货代乙', kind: 'semi', cap: 26, wait: 3, cold: false, w: 0.24 },
  { name: '货代丙', kind: 'truck', cap: 14, wait: 2.5, cold: false, w: 0.2 },
  { name: '货代丁', kind: 'truck', cap: 14, wait: 2.5, cold: false, w: 0.16 },
  { name: '货代戊', kind: 'truck', cap: 12, wait: 2, cold: false, w: 0.1 },
  { name: '快件公司', kind: 'van', cap: 5, wait: 1.5, cold: false, w: 0.04 },
  { name: '冷链物流甲', kind: 'reefer', cap: 22, wait: 1.2, cold: true, w: 0.6 },
  { name: '冷链物流乙', kind: 'reefer', cap: 16, wait: 1, cold: true, w: 0.4 },
] as const;
const COLD_FWD = [6, 7];
const GEN_FWD = [0, 1, 2, 3, 4, 5];
/** 按份额挑一家货代 */
const pickFwd = (r: () => number, list: readonly number[]) => {
  const tot = list.reduce((a, i) => a + (FWD[i] as { w: number }).w, 0);
  let x = r() * tot;
  for (const i of list) {
    x -= (FWD[i] as { w: number }).w;
    if (x <= 0) return i;
  }
  return list[list.length - 1] as number;
};

function rngOf(seed: number): () => number {
  let a = (Math.floor(Math.abs(seed)) * 2654435761 + 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const logU = (r: () => number, a: number, b: number) => Math.exp(lerp(Math.log(a), Math.log(b), r()));
/** 梯形速度剖面的用时（加速度 acc，最高 v） */
function travel(d: number, v: number, acc: number): number {
  if (d <= 1e-6) return 0;
  const dAcc = (v * v) / acc;
  return d < dAcc ? 2 * Math.sqrt(d / acc) : d / v + v / acc;
}
/** ETV 从 a 到 b：水平（约 2 米 / 秒）、升降同时走，取慢的那个，再加 3 秒对位 */
const craneTime = (a: Loc, b: Loc) => Math.max(travel(Math.abs(a.x - b.x), 2.0, 0.6), Math.abs(a.y - b.y) / 0.45) + 3;
/**
 * 叉车从 a 到 b 走的路：先站到 a 朝着的通道上；在同一条通道（或都在前通道、都在主通道）就沿着走；
 * 否则沿通道走到最近的横通道，穿到前通道或主通道，沿干道走到 b 附近的横通道，再进 b 的通道。三维按同一条路画。
 */
/**
 * 叉车的路线（见 forkPath0）；主通道是双向的：沿主通道开的那一段靠右（往 +x 开的走主通道偏 −z 一侧、往 −x 的偏 +z 一侧，各离中线 1 米），
 * 对开的两台叉车错得开
 */
export function forkPath(a: Loc, b: Loc, crossX: readonly number[], rooms?: readonly { key: string; x0: number; x1: number; z0: number; z1: number }[]): { x: number; z: number }[] {
  const pts = forkPath0(a, b, crossX, rooms);
  const out = pts.map((p) => ({ ...p }));
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i] as { x: number; z: number };
    const q = pts[i + 1] as { x: number; z: number };
    if (Math.abs(p.z - AISLE_Z) > 0.05 || Math.abs(q.z - AISLE_Z) > 0.05 || Math.abs(q.x - p.x) < 0.5) continue;
    const dz = q.x > p.x ? -1 : 1;
    (out[i] as { z: number }).z = AISLE_Z + dz;
    (out[i + 1] as { z: number }).z = AISLE_Z + dz;
  }
  return out;
}
function forkPath0(a: Loc, b: Loc, crossX: readonly number[], rooms?: readonly { key: string; x0: number; x1: number; z0: number; z1: number }[]): { x: number; z: number }[] {
  // 危险品库、贵重品库里的位置：从门进出（门在北墙上：贵重品库的门对着主通道，危险品库的门开在两库之间的过道里，
  // 沿过道往东、从两库和货站东墙之间 3.5 米宽的通道出去；西边和海关查验区之间只有 1 米，叉车过不去），不穿墙
  const inRoom = (p: Loc) => rooms?.find((r) => (r.key === 'dg' || r.key === 'vault') && p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1);
  const ra = inRoom(a);
  const rb = inRoom(b);
  if (ra || rb) {
    const leg = (r: { key: string; x0: number; x1: number; z1: number }, p: Loc) => {
      const dx = r.key === 'vault' ? r.x0 + 3 : (r.x0 + r.x1) / 2;
      const o = r.z1 + 1;
      const q = [
        { x: p.x, z: p.z },
        { x: dx, z: p.z },
        { x: dx, z: o },
      ];
      if (r.key === 'dg') q.push({ x: r.x1 + 1.75, z: o });
      q.push({ x: (q[q.length - 1] as { x: number }).x, z: AISLE_Z });
      return q;
    };
    const A = ra ? leg(ra, a) : [{ x: a.x, z: a.z }];
    const B = rb ? leg(rb, b).reverse() : [{ x: b.x, z: b.z }];
    const a2 = A[A.length - 1] as { x: number; z: number };
    const b2 = B[0] as { x: number; z: number };
    const out: { x: number; z: number }[] = [];
    for (const q of [...A, ...forkPath0({ ...a2, y: 0 }, { ...b2, y: 0 }, crossX).slice(1), ...B.slice(1)]) {
      const l = out[out.length - 1];
      if (!l || Math.abs(l.x - q.x) > 0.05 || Math.abs(l.z - q.z) > 0.05) out.push(q);
    }
    return out;
  }
  const pts: { x: number; z: number }[] = [];
  const add = (x: number, z: number) => {
    const l = pts[pts.length - 1];
    if (!l || Math.abs(l.x - x) > 0.05 || Math.abs(l.z - z) > 0.05) pts.push({ x, z });
  };
  const aa = a.az ?? a.z;
  const ba = b.az ?? b.z;
  const band = (z: number) => (z >= 1008.9 ? 'main' : z <= 993 ? 'front' : 'rack');
  const near = (x: number, toward: number) => {
    let best = crossX[0] ?? x;
    let bc = Infinity;
    for (const c of crossX) {
      const cost = Math.abs(c - x) + 0.3 * Math.abs(c - toward);
      if (cost < bc) {
        bc = cost;
        best = c;
      }
    }
    return best;
  };
  add(a.x, a.z);
  add(a.x, aa);
  const A = band(aa);
  const B = band(ba);
  if (A === 'rack' && B === 'rack' && Math.abs(aa - ba) < 0.15) {
    add(b.x, ba);
    add(b.x, b.z);
    return pts;
  }
  if (A !== 'rack' && A === B) {
    const tz = A === 'main' ? AISLE_Z : FRONT_Z;
    add(a.x, tz);
    add(b.x, tz);
    add(b.x, ba);
    add(b.x, b.z);
    return pts;
  }
  let tz: number;
  if (A === 'rack') {
    const cx = near(a.x, b.x);
    tz = B === 'front' ? FRONT_Z : AISLE_Z;
    add(cx, aa);
    add(cx, tz);
  } else {
    tz = A === 'main' ? AISLE_Z : FRONT_Z;
    add(a.x, tz);
  }
  const bz = B === 'front' ? FRONT_Z : B === 'main' ? AISLE_Z : tz;
  if (Math.abs(bz - tz) > 0.1) {
    const cx = near((a.x + b.x) / 2, b.x);
    add(cx, tz);
    add(cx, bz);
    tz = bz;
  }
  if (B === 'rack') {
    const cx = near(b.x, a.x);
    add(cx, tz);
    add(cx, ba);
    add(b.x, ba);
  } else {
    add(b.x, tz);
    add(b.x, ba);
  }
  add(b.x, b.z);
  return pts;
}
export function pathLen(pts: readonly { x: number; z: number }[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot((pts[i] as { x: number }).x - (pts[i - 1] as { x: number }).x, (pts[i] as { z: number }).z - (pts[i - 1] as { z: number }).z);
  return d;
}
/** 叉车走一段路的时间：按路长的速度剖面，每个拐角多 1.5 秒 */
export const forkTime = (a: Loc, b: Loc, crossX: readonly number[]) => {
  const pts = forkPath(a, b, crossX);
  return travel(pathLen(pts), FORK_V, 0.8) + Math.max(0, pts.length - 2) * 1.5;
};

interface Effect {
  t: number;
  seq: number;
  run: () => void;
}
interface CraneReq {
  uld: number;
  ready: number;
  pri: number;
  from: () => Loc;
  to: () => Loc | undefined;
  onPick: (t: number, mi: number) => void;
  onDrop: (t: number) => void;
  seq: number;
}
interface ForkReq {
  pallet: number;
  ready: number;
  pri: number;
  from: () => Loc;
  to: () => Loc;
  onPick: (t: number, fi: number) => void;
  onDrop: (t: number, to: Loc) => void;
  seq: number;
}

export function planAirTerminal(input: AirTermInput): AirTermPlan {
  const L = input.layout;
  const r = rngOf(input.seed * 7919 + 101);
  const notes: string[] = [];
  const ulds: TermUld[] = [];
  const pallets: TermPallet[] = [];
  const moves: TermMove[] = [];
  const jobs: TermJob[] = [];
  const forks: TermFork[] = [];
  const xrays: AirTermPlan['xrays'] = [];
  const trucks: TermTruck[] = [];
  const flightOf = new Map(input.flights.map((f) => [f.id, f] as const));
  let seq = 0;
  // —— 待办：按时刻执行的效果（最小堆） ——
  const heap: Effect[] = [];
  const at = (t: number, run: () => void) => {
    const e = { t, seq: seq++, run };
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const hp = heap[p] as Effect;
      if (hp.t < e.t || (hp.t === e.t && hp.seq < e.seq)) break;
      heap[i] = hp;
      heap[p] = e;
      i = p;
    }
  };
  const pop = (): Effect | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (!top || !last || !heap.length) return top;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const a = 2 * i + 1;
      const b = a + 1;
      let m = i;
      const less = (x: number, y: number) => {
        const hx = heap[x] as Effect;
        const hy = heap[y] as Effect;
        return hx.t < hy.t || (hx.t === hy.t && hx.seq < hy.seq);
      };
      if (a < heap.length && less(a, m)) m = a;
      if (b < heap.length && less(b, m)) m = b;
      if (m === i) break;
      const tmp = heap[i] as Effect;
      heap[i] = heap[m] as Effect;
      heap[m] = tmp;
      i = m;
    }
    return top;
  };

  // —— 资源 ——
  const slotUld = new Int32Array(L.slots.length).fill(-1);
  const slotHeld = new Uint8Array(L.slots.length);
  const cranePos: Loc[] = L.cranes.map((k) => ({ x: L.cols[k.home] as number, z: ETV_Z.aisle, y: LEVEL_Y[0] }));
  const craneFree = L.cranes.map(() => T_START);
  const craneQ: CraneReq[][] = L.cranes.map(() => []);
  const stationBusy = L.stations.map(() => -1);
  const forkPos: Loc[] = L.forkHome.slice(0, FORKS).map((p) => ({ ...p }));
  const forkFree = forkPos.map(() => T_START);
  const forkQ: ForkReq[] = [];
  const xrayFree = L.xray.map(() => T_START);
  const xrayQ: number[] = [];
  const locUsed: Record<StoreKey, Uint8Array> = { bulk: new Uint8Array(L.store.bulk.length), export: new Uint8Array(L.store.export.length), chill: new Uint8Array(L.store.chill.length), frozen: new Uint8Array(L.store.frozen.length), dg: new Uint8Array(L.store.dg.length), vault: new Uint8Array(L.store.vault.length), customs: new Uint8Array(L.store.customs.length) };
  const dockBook: [number, number, number][][] = L.docks.map(() => []);
  const dockStarts: number[] = [];
  /** 每条板车门滚轮道、整板转运道上排着的板（下标，从 0 号位起） */
  // 进来的板（进口板从板车门进、出口整板从卡车上下来）排在 In，送出去的排在 Out；同一条道上两头不会同时有
  const laneQ: number[][] = L.lanes.map(() => []);
  const laneOut: number[][] = L.lanes.map(() => []);
  const rfsQ: number[][] = L.rfs.map(() => []);
  const rfsOut: number[][] = L.rfs.map(() => []);
  /** 门里暂存道上每樘门的占用（一个门两排各 4 板） */
  const stageUsed: number[][] = L.docks.map(() => []);
  let overtime = 0;
  const teamsAt = (t: number) => Math.max(1, Math.floor(input.crew(t) / 2));
  const activeJobs = () => stationBusy.filter((x) => x >= 0).length;

  // —— 板、货的位置记录 ——
  const uSpan = (u: TermUld, s: USpan) => {
    const last = u.spans[u.spans.length - 1];
    if (last && last.t1 > s.t0) last.t1 = s.t0;
    u.spans.push(s);
  };
  const pSpan = (p: TermPallet, s: PSpan) => {
    const last = p.spans[p.spans.length - 1];
    if (last && last.t1 > s.t0) last.t1 = s.t0;
    p.spans.push(s);
  };
  const slotLoc = (i: number): Loc => L.slots[i] as Loc;
  const laneLoc = (lane: number, pos: number, out = false): Loc => {
    const l = L.lanes[lane] as TermLayout['lanes'][number];
    return { x: out ? l.xOut : l.x, z: LANE_Z[Math.max(0, Math.min(5, pos))] as number, y: LEVEL_Y[0] };
  };
  const rfsLoc = (k: number, pos: number): Loc => ({ x: (L.rfs[k] as { x: number }).x, z: RFS_Z[Math.max(0, Math.min(RFS_Z.length - 1, pos))] as number, y: LEVEL_Y[0] });
  const stationLoc = (s: number): Loc => ({ x: (L.stations[s] as { x: number }).x, z: ETV_Z.rowL, y: LEVEL_Y[0] });
  /** 工位四周放货的位置（拆下来的板、组板用的货） */
  const besideStation = (s: number, k: number): Loc => {
    const x = (L.stations[s] as { x: number }).x;
    return { x: x - 2.4 + (k % 4) * 1.6, z: STATION_Z - 3.6 - Math.floor(k / 4) * 1.3, y: 0.05 };
  };
  const stageLoc = (dock: number, k: number): Loc => {
    const d = L.docks[dock] as { x: number };
    return { x: d.x - 0.8 + (k % 2) * 1.6, z: STAGE_Z[Math.floor(k / 2) % 2] as number, y: 0.05 };
  };
  const xrayIn = (m: number): Loc => ({ x: (L.xray[m] as { x: number }).x, z: (L.xray[m] as { z0: number }).z0 - 1.2, y: 0.05 });
  const xrayOut = (m: number): Loc => ({ x: (L.xray[m] as { x: number }).x, z: (L.xray[m] as { z1: number }).z1 + 1.2, y: 0.05 });

  /** 挑一个空的存板位：这台 ETV 那段里离 from 最近的（低层优先） */
  const pickSlot = (crane: number, from: Loc): number => {
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < L.slots.length; i++) {
      const s = L.slots[i] as TermLayout['slots'][number];
      if (s.crane !== crane || (slotUld[i] as number) >= 0 || slotHeld[i]) continue;
      const c = Math.abs(s.x - from.x) + s.level * 5;
      if (c < bestCost) {
        bestCost = c;
        best = i;
      }
    }
    return best;
  };
  const pickLoc = (key: StoreKey, from: Loc): number => {
    const list = L.store[key];
    const used = locUsed[key];
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      const p = list[i] as Loc;
      const c = Math.abs(p.x - from.x) + Math.abs(p.z - from.z) * 0.5 + p.y * 2;
      if (c < bestCost) {
        bestCost = c;
        best = i;
      }
    }
    return best;
  };
  const stageSlot = (dock: number, t0: number, t1: number): number => {
    const used = stageUsed[dock] as number[];
    for (let k = 0; k < 8; k++) if (!(used[k] !== undefined && (used[k] as number) > t0)) {
      used[k] = t1;
      return k;
    }
    return 0;
  };

  // —— 设备调度 ——
  const craneRequest = (crane: number, req: Omit<CraneReq, 'seq'>) => (craneQ[crane] as CraneReq[]).push({ ...req, seq: seq++ });
  const dispatchCranes = (t: number) => {
    L.cranes.forEach((_, k) => {
      if ((craneFree[k] as number) > t) return;
      const q = (craneQ[k] as CraneReq[]).filter((a) => a.ready <= t).sort((a, b) => a.pri - b.pri || a.ready - b.ready || a.seq - b.seq);
      for (const req of q) {
        const to = req.to();
        if (!to) continue;
        const all = craneQ[k] as CraneReq[];
        all.splice(all.indexOf(req), 1);
        const from = req.from();
        const start = { ...(cranePos[k] as Loc) };
        const a = t + craneTime(start, from);
        const b = a + PICK;
        const c = b + craneTime(from, to);
        const t1 = c + PICK;
        const mi = moves.length;
        moves.push({ crane: k, uld: req.uld, t0: t, a, b, c, t1, start, from, to });
        cranePos[k] = { ...to };
        craneFree[k] = t1;
        at(b, () => req.onPick(b, mi));
        at(t1, () => req.onDrop(t1));
        return;
      }
    });
  };
  const forkRequest = (req: Omit<ForkReq, 'seq'>) => forkQ.push({ ...req, seq: seq++ });
  const dispatchForks = (t: number) => {
    if (!forkQ.length) return;
    forkQ.sort((a, b) => a.pri - b.pri || a.ready - b.ready || a.seq - b.seq);
    for (let i = 0; i < forkQ.length; ) {
      const req = forkQ[i] as ForkReq;
      if (req.ready > t) {
        i++;
        continue;
      }
      const from = req.from();
      let best = -1;
      let bestAt = Infinity;
      // 挑最近的空叉车（先按走通道的粗略距离挑，再算准它的路）
      for (let f = 0; f < forkPos.length; f++) {
        if ((forkFree[f] as number) > t) continue;
        const q = forkPos[f] as Loc;
        const d = Math.abs(q.x - from.x) + Math.abs(q.z - AISLE_Z) + Math.abs(from.z - AISLE_Z);
        if (d < bestAt) {
          bestAt = d;
          best = f;
        }
      }
      if (best < 0) return;
      bestAt = forkTime(forkPos[best] as Loc, from, L.crossX);
      forkQ.splice(i, 1);
      const to = req.to();
      const start = { ...(forkPos[best] as Loc) };
      const a = t + bestAt;
      const b = a + FORK_HANDLE;
      const c = b + forkTime(from, to, L.crossX);
      const t1 = c + FORK_HANDLE;
      const fi = forks.length;
      forks.push({ fork: best, pallet: req.pallet, t0: t, a, b, c, t1, start, from, to });
      // 叉车放下货以后退回到通道上
      forkPos[best] = { x: to.x, z: to.az ?? to.z, y: 0 };
      forkFree[best] = t1;
      at(b, () => req.onPick(b, fi));
      at(t1, () => req.onDrop(t1, to));
    }
  };

  // —— 收货口：一樘一次一辆车，前后留 5 分钟；所有车靠上的时刻彼此隔开 2 分半钟（场里一辆接一辆调车） ——
  const book = (kinds: DockKind[], want: number, dwell: number, only?: number): { dock: number; t0: number } => {
    const doors = only !== undefined ? [only] : L.docks.map((d, i) => (kinds.includes(d.kind) && i !== L.simDock ? i : -1)).filter((i) => i >= 0);
    let best = { dock: doors[0] ?? 0, t0: Infinity };
    for (const d of doors) {
      let t0 = want;
      for (let guard = 0; guard < 400; guard++) {
        const clash = (dockBook[d] as [number, number, number][]).find(([a, b]) => t0 < b + GAP && a < t0 + dwell + GAP);
        const near = dockStarts.find((s) => Math.abs(s - t0) < 150);
        if (!clash && near === undefined) break;
        t0 = clash ? clash[1] + GAP : (near as number) + 150;
      }
      if (t0 < best.t0) best = { dock: d, t0 };
    }
    return best;
  };
  const commitDock = (dock: number, t0: number, t1: number, truck: number) => {
    (dockBook[dock] as [number, number, number][]).push([t0, t1, truck]);
    dockStarts.push(t0);
  };

  // ———————————————— 一、出口：送货车、整板车（预约在前，先排） ————————————————
  const depByFlight = new Map<string, AirTermInput['departures']>();
  for (const d of input.departures) {
    const a = depByFlight.get(d.flight) ?? [];
    a.push(d);
    depByFlight.set(d.flight, a);
  }
  for (const [flight, deps] of depByFlight) {
    deps.sort((a, b) => a.t - b.t);
    const f = flightOf.get(flight);
    const own = !!f?.own;
    const built: number[] = [];
    const bup: number[] = [];
    for (const d of deps) {
      const lane = L.lanes[d.lane] ?? L.lanes[0];
      const isBup = !own && r() < 0.5;
      const per = r() < 0.1;
      const u: TermUld = { id: d.id, flight, own: false, perishable: per, dir: 'out', mode: isBup ? 'bup' : 'bd', crane: lane?.crane ?? 0, lane: d.lane, spans: [], pallets: [], tIn: Infinity, tDue: d.t, ready: false };
      ulds.push(u);
      (isBup ? bup : built).push(ulds.length - 1);
      if (!isBup) {
        const n = 4 + Math.floor(r() * 4);
        for (let k = 0; k < n; k++) {
          const cls: Cls = per ? 'chill' : r() < 0.04 ? 'dg' : 'general';
          pallets.push({ id: `${d.id} · ${k + 1}`, own: false, cls, dir: 'out', uld: ulds.length - 1, flight, fwd: pickFwd(r, GEN_FWD), spans: [] });
          u.pallets.push(pallets.length - 1);
        }
      }
    }
    const firstDue = deps[0]?.t ?? 0;
    // 送货车：每家货代这一班的货凑成几车
    const byFwd = new Map<number, number[]>();
    for (const ui of built) for (const pi of (ulds[ui] as TermUld).pallets) {
      const p = pallets[pi] as TermPallet;
      const a = byFwd.get(p.fwd) ?? [];
      a.push(pi);
      byFwd.set(p.fwd, a);
    }
    for (const [fw, list] of byFwd) {
      const F = FWD[fw] as (typeof FWD)[number];
      for (let k = 0; k < list.length; k += F.cap) {
        const load = list.slice(k, k + F.cap);
        const plan = firstDue - (4.5 + r() * 4) * 3600;
        const dwell = (6 + 1.8 * load.length + 4) * 60;
        const arrive = plan + (r() - 0.4) * 1200;
        const b = book(['export'], arrive + 240, dwell);
        const ti = trucks.length;
        trucks.push({ id: `EX-${ti + 1}`, label: `${F.name} 送出口货 ${load.length} 板（${flight}）`, kind: F.kind === 'van' ? 'van' : F.kind === 'semi' ? 'semi' : 'truck', own: false, dir: 'delivery', dock: b.dock, plan, arrive, t0: b.t0, t1: b.t0 + dwell, pallets: load, ulds: [], fwd: F.name });
        commitDock(b.dock, b.t0, b.t0 + dwell, ti);
        for (const pi of load) (pallets[pi] as TermPallet).truck = ti;
      }
    }
    // 卡车送来的整板：2–4 块一车，走这台 ETV 那段的整板收货口
    for (let k = 0; k < bup.length; ) {
      const n = Math.min(bup.length - k, 2 + Math.floor(r() * 3));
      const group = bup.slice(k, k + n);
      k += n;
      const crane = (ulds[group[0] as number] as TermUld).crane;
      const docks = L.rfs.filter((x) => x.crane === crane).map((x) => x.dock);
      const plan = firstDue - (4 + r() * 3) * 3600;
      const dwell = (6 + 4 * n + 4) * 60;
      let b = { dock: docks[0] ?? 0, t0: Infinity };
      for (const d of docks.length ? docks : L.rfs.map((x) => x.dock)) {
        const c = book(['uld'], plan + 240, dwell, d);
        if (c.t0 < b.t0) b = c;
      }
      const ti = trucks.length;
      trucks.push({ id: `UX-${ti + 1}`, label: `整板卡车 送出口整板 ${n} 块（${flight}）`, kind: 'uld', own: false, dir: 'delivery', dock: b.dock, plan, arrive: plan, t0: b.t0, t1: b.t0 + dwell, pallets: [], ulds: group, fwd: '整板卡车' });
      commitDock(b.dock, b.t0, b.t0 + dwell, ti);
      for (const ui of group) (ulds[ui] as TermUld).truck = ti;
    }
  }
  // 本店的空运冷藏车：按仿真的装车时段，靠本店的冷链门
  for (const ot of input.ownTrucks) {
    const ti = trucks.length;
    trucks.push({ id: ot.id, label: ot.label, kind: 'reefer', own: true, vid: ot.vid, dir: 'pickup', dock: L.simDock, plan: ot.t0, arrive: ot.t0 - 240, t0: ot.t0, t1: ot.t1, pallets: [], ulds: [], fwd: '本店' });
    commitDock(L.simDock, ot.t0, ot.t1, ti);
  }

  // ———————————————— 二、进口板：拆板还是整板提走，几板货 ————————————————
  // 本店的货按航班分：每班本店航班落地以后、下一班落地以前装车的本店冷藏车装几板，这班的本店的板就拆出几板（今天最后一班的货明天才提，按前一班估）
  const ownFlights = input.flights.filter((f) => f.own).sort((a, b) => a.land - b.land);
  const ownTotal = new Map<string, number>();
  for (const tr of input.ownTrucks) {
    const f = [...ownFlights].reverse().find((x) => x.land < tr.t0);
    if (f) ownTotal.set(f.id, (ownTotal.get(f.id) ?? 0) + tr.pallets);
  }
  const known = [...ownTotal.values()];
  const ownGuess = known.length ? Math.max(1, Math.round(known.reduce((a, x) => a + x, 0) / known.length)) : 6;
  const ownUldsOf = new Map<string, number>();
  for (const a of input.arrivals) if (a.own) ownUldsOf.set(a.flight, (ownUldsOf.get(a.flight) ?? 0) + 1);
  const ownSeen = new Map<string, number>();
  const arrivals = [...input.arrivals].sort((a, b) => a.t - b.t);
  for (const a of arrivals) {
    const lane = L.lanes[a.lane] ?? L.lanes[0];
    const per = a.own || r() < 0.28;
    const isBup = !a.own && r() < 0.55;
    const u: TermUld = { id: a.id, flight: a.flight, own: a.own, perishable: per, dir: 'in', mode: isBup ? 'bup' : 'bd', crane: lane?.crane ?? 0, lane: a.lane, spans: [], pallets: [], tIn: a.t };
    ulds.push(u);
    if (isBup) continue;
    // 本店的板：本店的货（按上面分到这块板的板数），不够一板满的拼别家的生鲜
    let mine = 0;
    if (a.own) {
      const total = ownTotal.get(a.flight) ?? ownGuess;
      const nU = ownUldsOf.get(a.flight) ?? 1;
      const k = ownSeen.get(a.flight) ?? 0;
      ownSeen.set(a.flight, k + 1);
      mine = Math.floor(total / nU) + (k < total % nU ? 1 : 0);
    }
    const n = a.own ? Math.max(mine, 3 + Math.floor(r() * 3)) : per ? 3 + Math.floor(r() * 4) : 4 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const x = r();
      const ours = k < mine;
      const cls: Cls = ours ? 'chill' : per ? (x < 0.8 ? 'chill' : 'frozen') : x < 0.04 ? 'dg' : x < 0.05 ? 'vault' : x < 0.09 ? 'customs' : 'general';
      const fwd = cls === 'chill' || cls === 'frozen' ? pickFwd(r, COLD_FWD) : pickFwd(r, GEN_FWD);
      pallets.push({ id: `${a.id} · ${k + 1}`, own: ours, cls, dir: 'in', uld: ulds.length - 1, flight: a.flight, fwd, spans: [] });
      u.pallets.push(pallets.length - 1);
    }
  }

  // ———————————————— 三、按 15 秒推演 ————————————————
  const uIndex = new Map<TermUld, number>(ulds.map((u, i) => [u, i] as const));
  const ixOf = (u: TermUld) => uIndex.get(u) as number;

  /** 滚轮道上的板往前挪（每块板滚到自己的号位） */
  /** out：往外送（ETV 放到 0 号位，滚到外头）；否则往里（从外头进来，滚到 0 号位） */
  const shuffleLane = (q: number[], t: number, locOf: (pos: number) => number, kind: 'lane' | 'rfs', ref: number, out: boolean) => {
    const top = kind === 'lane' ? LANE_Z.length - 1 : RFS_Z.length - 1;
    q.forEach((ui, k) => {
      const u = ulds[ui] as TermUld;
      const target = out ? top - k : k;
      const last = u.spans[u.spans.length - 1];
      const cur = last && last.at === kind && last.ref === ref ? (last.p1 ?? 0) : out ? 0 : top;
      if (last && last.at === kind && last.ref === ref && last.p1 === target) return;
      const d = Math.abs(locOf(cur) - locOf(target));
      const t1 = t + d / ROLL_V;
      uSpan(u, { t0: t, t1, at: kind, ref, p0: cur, p1: target });
      uSpan(u, { t0: t1, t1: Infinity, at: kind, ref, p0: target, p1: target });
    });
  };
  const laneZ = (pos: number) => LANE_Z[pos] as number;
  const rfsZ = (pos: number) => RFS_Z[pos] as number;

  /** 进口板到了滚轮道 0 号位（ETV 转运台）：请 ETV 存进板架 */
  const requestStore = (ui: number, t: number) => {
    const u = ulds[ui] as TermUld;
    let slot = -1;
    craneRequest(u.crane, {
      uld: ui,
      ready: t,
      pri: u.own ? 0 : u.perishable ? 1 : 2,
      from: () => laneLoc(u.lane, 0),
      to: () => {
        slot = pickSlot(u.crane, laneLoc(u.lane, 0));
        if (slot < 0) return undefined;
        slotHeld[slot] = 1;
        return slotLoc(slot);
      },
      onPick: (tp, mi) => {
        const q = laneQ[u.lane] as number[];
        const k = q.indexOf(ui);
        if (k >= 0) q.splice(k, 1);
        uSpan(u, { t0: tp, t1: Infinity, at: 'crane', ref: mi });
        shuffleLane(q, tp, laneZ, 'lane', u.lane, false);
        const head = q[0];
        if (head !== undefined) checkLaneHead(head, tp);
      },
      onDrop: (td) => {
        slotHeld[slot] = 0;
        slotUld[slot] = ui;
        u.tStored = td;
        uSpan(u, { t0: td, t1: Infinity, at: 'slot', ref: slot });
        if (u.mode === 'bd') waiting.push(ui);
        else bupWait(ui, td);
      },
    });
  };
  const checked = new Uint8Array(ulds.length);
  const storeAsked = new Uint8Array(ulds.length);
  const checkLaneHead = (ui: number, t: number) => {
    const u = ulds[ui] as TermUld;
    if (u.dir !== 'in' || storeAsked[ui] || !checked[ui]) return;
    const q = laneQ[u.lane] as number[];
    if (q[0] !== ui) return;
    storeAsked[ui] = 1;
    // 滚到 0 号位还要一点时间（最后一段是停在 0 号位，从它开始的时刻就是滚到的时刻）
    const last = u.spans[u.spans.length - 1];
    const ready = last && last.at === 'lane' && last.p1 === 0 ? Math.max(t, last.t0) : t;
    requestStore(ui, ready);
  };

  /** 进口板：一块块推进门 */
  for (const u of ulds) {
    if (u.dir !== 'in') continue;
    const ui = ixOf(u);
    at(u.tIn, () => {
      const q = laneQ[u.lane] as number[];
      q.push(ui);
      shuffleLane(q, u.tIn, laneZ, 'lane', u.lane, false);
      at(u.tIn + CHECK, () => {
        checked[ui] = 1;
        checkLaneHead(ui, u.tIn + CHECK);
      });
    });
  }

  // —— 拆组板：等着拆的进口板、等着组的出口板 ——
  const waiting: number[] = [];
  const buWait: number[] = [];
  const BU_DUR = () => (35 + r() * 15) * 60;
  const BD_DUR = (u: TermUld) => (u.own ? 22 + r() * 5 : u.perishable ? 22 + r() * 8 : 28 + r() * 12) * 60;
  const stationOf = (crane: number) => L.stations.map((s, i) => (s.crane === crane && (stationBusy[i] as number) < 0 ? i : -1)).filter((i) => i >= 0);

  /** 出口：组板窗口（推出前 6 小时起）、截载（推出前 1 小时组好进 ETV） */
  for (const u of ulds) {
    if (u.dir !== 'out' || u.mode !== 'bd') continue;
    buWait.push(ixOf(u));
  }
  const exportPalletsStored = (u: TermUld) => u.pallets.every((pi) => (pallets[pi] as TermPallet).tIn !== undefined && (pallets[pi] as TermPallet).spans.some((s) => s.at === 'loc'));

  const startBreakdown = (ui: number, s: number, t: number, ot: boolean) => {
    const u = ulds[ui] as TermUld;
    stationBusy[s] = ui;
    u.station = s;
    const slot = (u.spans[u.spans.length - 1] as USpan).ref;
    craneRequest(u.crane, {
      uld: ui,
      ready: t,
      pri: u.own ? 0 : u.perishable ? 1 : 3,
      from: () => slotLoc(slot),
      to: () => stationLoc(s),
      onPick: (tp, mi) => {
        slotUld[slot] = -1;
        uSpan(u, { t0: tp, t1: Infinity, at: 'crane', ref: mi });
      },
      onDrop: (td) => {
        const j0 = td + 60;
        const dur = BD_DUR(u);
        const j1 = j0 + dur;
        u.tJob0 = j0;
        u.tJob1 = j1;
        uSpan(u, { t0: td, t1: Infinity, at: 'station', ref: s });
        jobs.push({ station: s, uld: ui, kind: 'bd', t0: j0, t1: j1, overtime: ot });
        const n = u.pallets.length;
        u.pallets.forEach((pi, k) => {
          const p = pallets[pi] as TermPallet;
          const tk = j0 + (dur * (k + 1)) / n;
          at(tk, () => {
            pSpan(p, { t0: tk, t1: Infinity, at: 'station', ref: s * 16 + k });
            p.tRel = p.own ? tk : tk + logU(r, REL[p.cls][0], REL[p.cls][1]) * 3600;
            const key = CLS_STORE[p.cls];
            let loc = -1;
            forkRequest({
              pallet: pi,
              ready: tk + 20,
              pri: p.own ? 0 : p.cls === 'chill' || p.cls === 'frozen' ? 1 : 3,
              from: () => besideStation(s, k),
              to: () => {
                loc = pickLoc(key, besideStation(s, k));
                if (loc >= 0) (locUsed[key] as Uint8Array)[loc] = 1;
                return loc >= 0 ? (L.store[key][loc] as Loc) : besideStation(s, k);
              },
              onPick: (tp, fi) => pSpan(p, { t0: tp, t1: Infinity, at: 'fork', ref: fi }),
              onDrop: (td2) => {
                p.tIn = td2;
                pSpan(p, { t0: td2, t1: Infinity, at: 'loc', ref: Math.max(0, loc), store: key });
                (p as TermPallet & { loc?: number }).loc = loc;
                if (loc < 0) notes.push(`${STORE_LABEL[key]}满了：${p.id} 先放在工位旁边。`);
                const hook = stageHooks.get(pi);
                if (hook) {
                  stageHooks.delete(pi);
                  hook(td2);
                  return;
                }
                const rel = Math.max(td2, p.tRel ?? td2);
                at(rel, () => released(pi, rel));
              },
            });
          });
        });
        at(j1, () => {
          stationBusy[s] = -1;
          u.tOut = j1;
          uSpan(u, { t0: j1, t1: j1, at: 'station', ref: s });
        });
      },
    });
  };
  const startBuild = (ui: number, s: number, t: number, ot: boolean) => {
    const u = ulds[ui] as TermUld;
    stationBusy[s] = ui;
    u.station = s;
    const dur = BU_DUR();
    const j0 = t + 6 * 60;
    const j1 = j0 + dur;
    u.tJob0 = j0;
    u.tJob1 = j1;
    u.tIn = j0;
    jobs.push({ station: s, uld: ui, kind: 'bu', t0: j0, t1: j1, overtime: ot });
    uSpan(u, { t0: j0, t1: Infinity, at: 'station', ref: s });
    const n = u.pallets.length;
    u.pallets.forEach((pi, k) => {
      const p = pallets[pi] as TermPallet;
      const loc = (p as TermPallet & { loc?: number }).loc ?? 0;
      const key = CLS_STORE[p.cls] === 'chill' ? 'chill' : p.cls === 'dg' ? 'dg' : 'export';
      forkRequest({
        pallet: pi,
        ready: t + (k * dur) / (n + 1) - 240,
        pri: 2,
        from: () => L.store[key][loc] as Loc,
        to: () => besideStation(s, k),
        onPick: (tp, fi) => {
          (locUsed[key] as Uint8Array)[loc] = 0;
          p.tOut = tp;
          pSpan(p, { t0: tp, t1: Infinity, at: 'fork', ref: fi });
        },
        onDrop: (td) => {
          pSpan(p, { t0: td, t1: Infinity, at: 'station', ref: s * 16 + k });
          // 码上板：组板进度到这一板时消失（并进板里）
          const put = Math.max(td + 30, j0 + (dur * (k + 0.5)) / n);
          at(put, () => pSpan(p, { t0: put, t1: put, at: 'station', ref: s * 16 + k }));
        },
      });
    });
    at(j1, () => {
      u.tJob1 = j1;
      // 组好：存进 ETV（快到推出的直接去滚轮道）
      let slot = -1;
      craneRequest(u.crane, {
        uld: ui,
        ready: j1 + 60,
        pri: 2,
        from: () => stationLoc(s),
        to: () => {
          slot = pickSlot(u.crane, stationLoc(s));
          if (slot < 0) return undefined;
          slotHeld[slot] = 1;
          return slotLoc(slot);
        },
        onPick: (tp, mi) => {
          stationBusy[s] = -1;
          uSpan(u, { t0: tp, t1: Infinity, at: 'crane', ref: mi });
        },
        onDrop: (td) => {
          slotHeld[slot] = 0;
          slotUld[slot] = ui;
          u.tStored = td;
          u.ready = td <= (u.tDue ?? Infinity) - 3600;
          uSpan(u, { t0: td, t1: Infinity, at: 'slot', ref: slot });
          outReady(ui);
        },
      });
    });
  };

  /** 出口板：推出前 30 分钟 ETV 把它送到滚轮道（按推出的先后），沿滚轮道滚到门口 */
  const outAsked = new Uint8Array(ulds.length);
  const outReady = (ui: number) => {
    const u = ulds[ui] as TermUld;
    if (outAsked[ui] || u.tStored === undefined) return;
    outAsked[ui] = 1;
    const due = u.tDue ?? 0;
    const slot = (u.spans[u.spans.length - 1] as USpan).ref;
    craneRequest(u.crane, {
      uld: ui,
      ready: Math.max(u.tStored, due - 15 * 60),
      pri: -1,
      from: () => slotLoc(slot),
      // 出去的滚轮道上已经排了 5 块就先等着
      to: () => ((laneOut[u.lane] as number[]).length >= 5 ? undefined : laneLoc(u.lane, 0, true)),
      onPick: (tp, mi) => {
        slotUld[slot] = -1;
        uSpan(u, { t0: tp, t1: Infinity, at: 'crane', ref: mi });
      },
      onDrop: (td) => {
        const q = laneOut[u.lane] as number[];
        q.push(ui);
        q.sort((a, b) => ((ulds[a] as TermUld).tDue ?? 0) - ((ulds[b] as TermUld).tDue ?? 0));
        shuffleLane(q, td, laneZ, 'lane', u.lane, true);
        const leave = Math.max(due, td + 20);
        at(leave, () => {
          const k = q.indexOf(ui);
          if (k >= 0) q.splice(k, 1);
          u.tOut = leave;
          uSpan(u, { t0: leave, t1: leave, at: 'lane', ref: u.lane, p0: 5, p1: 5 });
          shuffleLane(q, leave, laneZ, 'lane', u.lane, true);
        });
      },
    });
  };
  for (const u of ulds) if (u.dir === 'out' && u.tDue !== undefined && u.tDue - 30 * 60 < T_START + 600) u.tDue = Math.max(u.tDue, T_START + 2 * 3600);

  // —— 整板：进口整板等货代的整板卡车；出口整板从卡车上下来进 ETV ——
  const bupPending: number[] = [];
  const bupWait = (ui: number, t: number) => {
    const u = ulds[ui] as TermUld;
    const appt = t + (1.5 + r() * 5) * 3600;
    bupPending.push(ui);
    at(appt, () => {
      // 同一台 ETV 那段里等着的整板凑 2–4 块一车
      const mine = bupPending.filter((x) => (ulds[x] as TermUld).crane === u.crane && (ulds[x] as TermUld).truck === undefined);
      if (!mine.includes(ui)) return;
      const group = mine.slice(0, Math.min(mine.length, 2 + Math.floor(r() * 3)));
      const docks = L.rfs.filter((x) => x.crane === u.crane).map((x) => x.dock);
      const dwell = (6 + 4 * group.length + 4) * 60;
      const arrive = appt + (20 + r() * 30) * 60;
      let b = { dock: docks[0] ?? 0, t0: Infinity };
      for (const d of docks.length ? docks : L.rfs.map((x) => x.dock)) {
        const c = book(['uld'], arrive + 240, dwell, d);
        if (c.t0 < b.t0) b = c;
      }
      const ti = trucks.length;
      trucks.push({ id: `UI-${ti + 1}`, label: `整板卡车 提进口整板 ${group.length} 块`, kind: 'uld', own: false, dir: 'pickup', dock: b.dock, plan: arrive, arrive, t0: b.t0, t1: b.t0 + dwell, pallets: [], ulds: group, fwd: '整板卡车' });
      commitDock(b.dock, b.t0, b.t0 + dwell, ti);
      const rk = L.rfs.findIndex((x) => x.dock === b.dock);
      group.forEach((gi, k) => {
        const g = ulds[gi] as TermUld;
        g.truck = ti;
        bupPending.splice(bupPending.indexOf(gi), 1);
        const slot = (g.spans[g.spans.length - 1] as USpan).ref;
        craneRequest(g.crane, {
          uld: gi,
          ready: b.t0 + k * 90,
          pri: 1,
          from: () => slotLoc(slot),
          // 转运道上还有卡车卸下来、等着进 ETV 的整板时先等着
          to: () => ((rfsQ[rk] as number[]).length ? undefined : rfsLoc(rk, 0)),
          onPick: (tp, mi) => {
            slotUld[slot] = -1;
            uSpan(g, { t0: tp, t1: Infinity, at: 'crane', ref: mi });
          },
          onDrop: (td) => {
            const q = rfsOut[rk] as number[];
            q.push(gi);
            shuffleLane(q, td, rfsZ, 'rfs', rk, true);
            const load = Math.max(b.t0 + (5 + 4 * k) * 60, td + 60);
            at(load, () => {
              const j = q.indexOf(gi);
              if (j >= 0) q.splice(j, 1);
              g.tOut = load;
              uSpan(g, { t0: load, t1: Infinity, at: 'truck', ref: ti });
              shuffleLane(q, load, rfsZ, 'rfs', rk, true);
            });
          },
        });
      });
    });
  };
  for (const tr of trucks) {
    if (tr.kind !== 'uld' || tr.dir !== 'delivery') continue;
    const rk = L.rfs.findIndex((x) => x.dock === tr.dock);
    tr.ulds.forEach((ui, k) => {
      const u = ulds[ui] as TermUld;
      const tOff = tr.t0 + (5 + 4 * k) * 60;
      at(tOff, () => {
        u.tIn = tOff;
        const q = rfsQ[rk] as number[];
        q.push(ui);
        shuffleLane(q, tOff, rfsZ, 'rfs', rk, false);
        rfsHead(rk, tOff);
      });
    });
  }
  /** 整板转运道进来的板：滚到 0 号位（ETV 陆侧一排底层）才请 ETV 存进板架，一块接一块 */
  const rfsAsked = new Uint8Array(ulds.length);
  function rfsHead(rk: number, t: number): void {
    const q = rfsQ[rk] as number[];
    const ui = q[0];
    if (ui === undefined || rfsAsked[ui]) return;
    const u = ulds[ui] as TermUld;
    if (u.dir !== 'out') return;
    rfsAsked[ui] = 1;
    const last = u.spans[u.spans.length - 1];
    const ready = last && last.at === 'rfs' && last.p1 === 0 ? Math.max(t, last.t0) : t;
    {
      {
        let slot = -1;
        craneRequest(u.crane, {
          uld: ui,
          ready,
          pri: 2,
          from: () => rfsLoc(rk, 0),
          to: () => {
            slot = pickSlot(u.crane, rfsLoc(rk, 0));
            if (slot < 0) return undefined;
            slotHeld[slot] = 1;
            return slotLoc(slot);
          },
          onPick: (tp, mi) => {
            const j = q.indexOf(ui);
            if (j >= 0) q.splice(j, 1);
            uSpan(u, { t0: tp, t1: Infinity, at: 'crane', ref: mi });
            shuffleLane(q, tp, rfsZ, 'rfs', rk, false);
            rfsHead(rk, tp);
          },
          onDrop: (td) => {
            slotHeld[slot] = 0;
            slotUld[slot] = ui;
            u.tStored = td;
            u.ready = td <= (u.tDue ?? Infinity) - 3600;
            uSpan(u, { t0: td, t1: Infinity, at: 'slot', ref: slot });
            outReady(ui);
          },
        });
      }
    }
  }

  // —— 出口送货车：一板板卸下 → 暂存道 → 收货过磅 → X 光机 → 出口货架 ——
  for (const tr of trucks) {
    if (tr.dir !== 'delivery' || tr.kind === 'uld') continue;
    tr.pallets.forEach((pi, k) => {
      const p = pallets[pi] as TermPallet;
      const tOff = tr.t0 + (6 + 1.8 * k) * 60;
      const st = stageSlot(tr.dock, tOff, tOff + 600);
      at(tOff, () => {
        pSpan(p, { t0: tOff, t1: Infinity, at: 'stage', ref: tr.dock * 8 + st });
        const m = k % L.xray.length;
        forkRequest({
          pallet: pi,
          ready: tOff + 180,
          pri: 2,
          from: () => stageLoc(tr.dock, st),
          to: () => xrayIn(m),
          onPick: (tp, fi) => pSpan(p, { t0: tp, t1: Infinity, at: 'fork', ref: fi }),
          onDrop: (td) => {
            pSpan(p, { t0: td, t1: Infinity, at: 'xray', ref: m * 1000 + 0 });
            xrayQ.push(pi);
            (p as TermPallet & { xm?: number }).xm = m;
          },
        });
      });
    });
  }
  const dispatchXray = (t: number) => {
    for (let i = 0; i < xrayQ.length; ) {
      const pi = xrayQ[i] as number;
      const p = pallets[pi] as TermPallet & { xm?: number };
      const m = p.xm ?? 0;
      if ((xrayFree[m] as number) > t) {
        i++;
        continue;
      }
      xrayQ.splice(i, 1);
      const t1 = t + XRAY_SEC;
      xrayFree[m] = t1;
      xrays.push({ machine: m, pallet: pi, t0: t, t1 });
      pSpan(p, { t0: t, t1: Infinity, at: 'xray', ref: m * 1000 + 1 });
      at(t1, () => {
        pSpan(p, { t0: t1, t1: Infinity, at: 'xray', ref: m * 1000 + 2 });
        const key: StoreKey = p.cls === 'chill' ? 'chill' : p.cls === 'dg' ? 'dg' : 'export';
        let loc = -1;
        forkRequest({
          pallet: pi,
          ready: t1 + 30,
          pri: 2,
          from: () => xrayOut(m),
          to: () => {
            loc = pickLoc(key, xrayOut(m));
            if (loc >= 0) (locUsed[key] as Uint8Array)[loc] = 1;
            return loc >= 0 ? (L.store[key][loc] as Loc) : xrayOut(m);
          },
          onPick: (tp, fi) => pSpan(p, { t0: tp, t1: Infinity, at: 'fork', ref: fi }),
          onDrop: (td) => {
            p.tIn = td;
            (p as TermPallet & { loc?: number }).loc = Math.max(0, loc);
            pSpan(p, { t0: td, t1: Infinity, at: 'loc', ref: Math.max(0, loc), store: key });
          },
        });
      });
    }
  };

  // —— 进口放行以后：货代凑一车来提；本店的板等本店的冷藏车 ——
  const stageHooks = new Map<number, (t: number) => void>();
  const pending: number[][] = FWD.map(() => []);
  const pendingSince = FWD.map(() => Infinity);
  const ownReady: number[] = [];
  const released = (pi: number, t: number) => {
    const p = pallets[pi] as TermPallet;
    if (p.truck !== undefined) return;
    if (p.own) {
      ownReady.push(pi);
      return;
    }
    const q = pending[p.fwd] as number[];
    if (!q.length) pendingSince[p.fwd] = t;
    q.push(pi);
  };
  const closeBatch = (fw: number, t: number) => {
    const F = FWD[fw] as (typeof FWD)[number];
    const q = pending[fw] as number[];
    const load = q.splice(0, F.cap);
    pendingSince[fw] = q.length ? t : Infinity;
    const plan = t + (20 + r() * 30) * 60;
    const arrive = plan + (r() - 0.5) * 600;
    const dwell = (6 + 2 * load.length + 4) * 60;
    const b = book(F.cold ? ['cold'] : ['import'], arrive + 240, dwell);
    const ti = trucks.length;
    trucks.push({ id: `IM-${ti + 1}`, label: `${F.name} 提进口货 ${load.length} 板`, kind: F.kind, own: false, dir: 'pickup', dock: b.dock, plan, arrive, t0: b.t0, t1: b.t0 + dwell, pallets: load, ulds: [], fwd: F.name });
    commitDock(b.dock, b.t0, b.t0 + dwell, ti);
    stageAndLoad(ti);
  };
  /** 提货车：靠上前 15 分钟叉车把货从货位拉到门里的暂存道，靠上以后一板板装车 */
  const stageAndLoad = (ti: number) => {
    const tr = trucks[ti] as TermTruck;
    tr.pallets.forEach((pi, k) => {
      const p = pallets[pi] as TermPallet & { loc?: number };
      p.truck = ti;
      // 还没进库的（本店的板拆得晚）：进库以后再拉
      if (p.tIn === undefined) {
        stageHooks.set(pi, () => stageOne(ti, pi, k));
        return;
      }
      stageOne(ti, pi, k);
    });
  };
  const stageOne = (ti: number, pi: number, k: number) => {
    const tr = trucks[ti] as TermTruck;
    {
      const p = pallets[pi] as TermPallet & { loc?: number };
      const key = CLS_STORE[p.cls];
      const loc = Math.max(0, p.loc ?? 0);
      const st = stageSlot(tr.dock, tr.t0 - 15 * 60, tr.t1);
      // 一板约 2 分钟；本店的车按仿真给的装车时段，装不完就装快一点（两台叉车一起装）
      const prep = Math.min(6 * 60, (tr.t1 - tr.t0) * 0.25);
      const per = Math.max(15, Math.min(120, (tr.t1 - tr.t0 - prep - 120) / Math.max(1, tr.pallets.length)));
      const tLoad = tr.t0 + prep + per * (k + 1);
      forkRequest({
        pallet: pi,
        ready: Math.max(tr.t0 - 15 * 60 + k * 40, p.tIn ?? -Infinity),
        pri: p.own ? 0 : 1,
        from: () => L.store[key][loc] as Loc,
        to: () => stageLoc(tr.dock, st),
        onPick: (tp, fi) => {
          (locUsed[key] as Uint8Array)[loc] = 0;
          p.tOut = tp;
          pSpan(p, { t0: tp, t1: Infinity, at: 'fork', ref: fi });
        },
        onDrop: (td) => {
          pSpan(p, { t0: td, t1: Infinity, at: 'stage', ref: tr.dock * 8 + st });
          const tl = Math.min(Math.max(tLoad, td + 30), Math.max(tLoad, tr.t1 - 30));
          at(tl, () => pSpan(p, { t0: tl, t1: Infinity, at: 'truck', ref: ti }));
        },
      });
    }
  };
  // 本店的冷藏车：装车前 30 分钟开始把本店已经进冷藏库的板拉到冷链穿堂的暂存道
  for (let ti = 0; ti < trucks.length; ti++) {
    const tr = trucks[ti] as TermTruck;
    if (!tr.own) continue;
    const want = input.ownTrucks.find((o) => o.id === tr.id)?.pallets ?? 0;
    at(tr.t0 - 30 * 60, () => {
      const take = ownReady.splice(0, want);
      // 还没拆完、没进库的本店的板：拆完进库以后直接去暂存道
      const short = want - take.length;
      if (short > 0) {
        const left = pallets.map((p, i) => (p.own && p.dir === 'in' && p.truck === undefined && !take.includes(i) && !ownReady.includes(i) ? i : -1)).filter((i) => i >= 0);
        take.push(...left.slice(0, short));
        if (take.length < want) notes.push(`本店的冷藏车 ${tr.id} 要装 ${want} 板，货站里只有 ${take.length} 板本店的货（落地晚了或板少了）。`);
      }
      tr.pallets = take;
      for (const pi of take) {
        const ix = ownReady.indexOf(pi);
        if (ix >= 0) ownReady.splice(ix, 1);
      }
      stageAndLoad(ti);
    });
  }

  // —— 主循环 ——
  for (let t = T_START; t <= T_END; t += DT) {
    for (let e = heap[0]; e && e.t <= t; e = heap[0]) pop()?.run();
    // 拆组板：空工位、有组 → 先赶截载的出口板、本店的板，再按先后
    const teams = teamsAt(t);
    for (;;) {
      // 急的出口板（再不开始就赶不上截载）：可以加一组
      let urgent = -1;
      let urgentSlack = Infinity;
      for (const ui of buWait) {
        const u = ulds[ui] as TermUld;
        if (!exportPalletsStored(u)) continue;
        const slack = (u.tDue ?? 0) - 3600 - 75 * 60 - t;
        if (slack < urgentSlack) {
          urgentSlack = slack;
          urgent = ui;
        }
      }
      const ownWaiting = waiting.find((ui) => (ulds[ui] as TermUld).own);
      let pick: { ui: number; kind: 'bd' | 'bu'; ot: boolean } | undefined;
      const canTeam = activeJobs() < teams;
      if (urgent >= 0 && urgentSlack < 20 * 60 && stationOf((ulds[urgent] as TermUld).crane).length) pick = { ui: urgent, kind: 'bu', ot: !canTeam };
      else if (ownWaiting !== undefined && stationOf((ulds[ownWaiting] as TermUld).crane).length) pick = { ui: ownWaiting, kind: 'bd', ot: !canTeam };
      else if (canTeam) {
        // 窗口里的出口板（推出前 6 小时内、货都进库了）按截载先后；然后是进口生鲜、其他进口板
        let bu = -1;
        let buDue = Infinity;
        for (const ui of buWait) {
          const u = ulds[ui] as TermUld;
          if ((u.tDue ?? 0) - 6 * 3600 > t || !exportPalletsStored(u) || !stationOf(u.crane).length) continue;
          if ((u.tDue ?? 0) < buDue) {
            buDue = u.tDue ?? 0;
            bu = ui;
          }
        }
        let bd = -1;
        let bdKey = Infinity;
        for (const ui of waiting) {
          const u = ulds[ui] as TermUld;
          if (!stationOf(u.crane).length) continue;
          const key = (u.perishable ? 0 : 1e7) + (u.tStored ?? 0);
          if (key < bdKey) {
            bdKey = key;
            bd = ui;
          }
        }
        const buFirst = bu >= 0 && (bd < 0 || buDue - t < 3 * 3600 || !(ulds[bd] as TermUld).perishable);
        if (bu >= 0 && (buFirst || bd < 0)) pick = { ui: bu, kind: 'bu', ot: false };
        else if (bd >= 0) pick = { ui: bd, kind: 'bd', ot: false };
      }
      if (!pick) break;
      const u = ulds[pick.ui] as TermUld;
      const s = stationOf(u.crane)[0] as number;
      if (pick.ot) overtime++;
      if (pick.kind === 'bd') {
        waiting.splice(waiting.indexOf(pick.ui), 1);
        startBreakdown(pick.ui, s, t, pick.ot);
      } else {
        buWait.splice(buWait.indexOf(pick.ui), 1);
        startBuild(pick.ui, s, t, pick.ot);
      }
    }
    // 货代凑车：凑满一车，或者第一板放行后等够了
    for (let fw = 0; fw < FWD.length; fw++) {
      const q = pending[fw] as number[];
      const F = FWD[fw] as (typeof FWD)[number];
      if (q.length >= F.cap || (q.length && t - (pendingSince[fw] as number) >= F.wait * 3600)) closeBatch(fw, t);
    }
    dispatchXray(t);
    dispatchCranes(t);
    dispatchForks(t);
  }

  // ———————————————— 四、收尾：没走完的记到最后；HubDay ————————————————
  const end = T_END;
  for (const u of ulds) for (const s of u.spans) if (!Number.isFinite(s.t1)) s.t1 = end;
  for (const p of pallets) for (const s of p.spans) if (!Number.isFinite(s.t1)) s.t1 = end;
  const missedCut = ulds.filter((u) => u.dir === 'out' && u.tDue !== undefined && u.tDue > 0 && u.tDue < 86400 && !u.ready).length;
  if (missedCut) notes.push(`${missedCut} 块出口板没在推出前 1 小时组好进 ETV（赶上了飞机，但截载晚了）。`);
  const hub = buildHub(input, L, ulds, pallets, trucks, jobs, overtime, notes);
  return { layout: L, ulds, pallets, moves, jobs, forks, xrays, trucks, hub, overtime, notes };
}

/**
 * 收货场引擎排出来的场内时刻（每辆车：到通道口、靠稳、离开场地）套回计划：车的排队、靠台按场里实际的时刻，
 * 再重算 HubDay（货车排队、在场、收货口利用率这几个指标和场里看到的一样）。
 */
export function applyYardTimes(plan: AirTermPlan, input: AirTermInput, times: ReadonlyMap<string, { arrive: number; docked: number; gone: number }>): void {
  for (const tr of plan.trucks) {
    const y = times.get(tr.id);
    if (!y) continue;
    tr.arrive = Math.min(tr.arrive, y.arrive);
    tr.t0 = Math.max(tr.t0, Math.min(y.docked, tr.t1 - 300));
  }
  plan.hub = buildHub(input, plan.layout, plan.ulds, plan.pallets, plan.trucks, plan.jobs, plan.overtime, plan.notes);
}

// ———————————————————————— HubDay（值班助手、看板） ————————————————————————

const clock = (t: number) => {
  const m = Math.round((((t / 60) % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

function buildHub(input: AirTermInput, L: TermLayout, ulds: TermUld[], pallets: TermPallet[], trucks: TermTruck[], jobs: TermJob[], overtime: number, notes: string[]): HubDay {
  const zones: HubZone[] = [
    { key: 'airside', label: '空侧滚轮道', kind: 'staging', capacity: L.lanes.length * 6, unit: 'ULD' },
    { key: 'etv', label: 'ETV 升降式板架', kind: 'storage', capacity: L.slots.length, unit: 'ULD' },
    { key: 'work', label: '拆组板工位', kind: 'work', capacity: L.stations.length, unit: 'ULD' },
    { key: 'uldlane', label: '整板转运道', kind: 'staging', capacity: L.rfs.length * RFS_Z.length, unit: 'ULD' },
    { key: 'bulk', label: STORE_LABEL.bulk, kind: 'storage', capacity: L.store.bulk.length, unit: '板' },
    { key: 'export', label: STORE_LABEL.export, kind: 'storage', capacity: L.store.export.length, unit: '板' },
    { key: 'chill', label: STORE_LABEL.chill, kind: 'cold', capacity: L.store.chill.length, unit: '板' },
    { key: 'frozen', label: STORE_LABEL.frozen, kind: 'cold', capacity: L.store.frozen.length, unit: '板' },
    { key: 'dg', label: STORE_LABEL.dg, kind: 'storage', capacity: L.store.dg.length, unit: '板' },
    { key: 'vault', label: STORE_LABEL.vault, kind: 'storage', capacity: L.store.vault.length, unit: '板' },
    { key: 'customs', label: STORE_LABEL.customs, kind: 'inspection', capacity: L.store.customs.length, unit: '板' },
    { key: 'screen', label: '安检（X 光机）', kind: 'inspection', capacity: L.xray.length * 4, unit: '板' },
    { key: 'stage', label: '收发货暂存道', kind: 'staging', capacity: L.docks.length * 8, unit: '板' },
    { key: 'docks', label: '陆侧收货口', kind: 'dock', capacity: L.docks.length, unit: '车' },
    { key: 'queue', label: '货车排队', kind: 'queue', capacity: 12, unit: '车' },
  ];
  const flows: HubFlow[] = [];
  const uZone = (s: USpan) => (s.at === 'lane' ? 'airside' : s.at === 'slot' || s.at === 'crane' ? 'etv' : s.at === 'station' ? 'work' : s.at === 'rfs' ? 'uldlane' : undefined);
  const uAct = (s: USpan, u: TermUld) => (s.at === 'lane' ? (u.dir === 'in' ? '空侧进门、核对过磅' : '推往空侧板车门') : s.at === 'slot' ? '存在 ETV 板架' : s.at === 'crane' ? 'ETV 搬运' : s.at === 'station' ? (u.dir === 'in' ? '拆板' : '组板') : '整板转运道');
  const merge = (steps: HubFlow['steps']) => {
    const out: HubFlow['steps'] = [];
    for (const s of steps) {
      if (s.t1 <= s.t0) continue;
      const last = out[out.length - 1];
      if (last && last.zone === s.zone && Math.abs(last.t1 - s.t0) < 1) last.t1 = s.t1;
      else out.push({ ...s });
    }
    return out;
  };
  for (const u of ulds) {
    const steps = merge(u.spans.map((s) => ({ zone: uZone(s) ?? '', t0: s.t0, t1: s.t1, act: uAct(s, u) })).filter((s) => s.zone));
    if (!steps.length) continue;
    const tr = u.truck !== undefined ? trucks[u.truck] : undefined;
    flows.push({
      id: u.id,
      label: `${u.dir === 'in' ? '进口' : '出口'}${u.mode === 'bup' ? '整板' : u.dir === 'in' ? '板（拆板）' : '板（货站组板）'} ${u.id}${u.perishable ? ' · 生鲜' : ''}`,
      own: u.own,
      units: 1,
      unit: 'ULD',
      steps,
      kind: 'cargo',
      cold: u.perishable,
      ...(u.dir === 'in' ? { carrierIn: u.flight } : { carrierOut: u.flight }),
      ...(tr ? (u.dir === 'in' ? { carrierOut: tr.id } : { carrierIn: tr.id }) : {}),
    });
  }
  const pZone = (s: PSpan) => (s.at === 'loc' ? s.store : s.at === 'stage' ? 'stage' : s.at === 'xray' ? 'screen' : undefined);
  const pAct = (s: PSpan) => (s.at === 'loc' ? `在${STORE_LABEL[s.store as StoreKey]}` : s.at === 'stage' ? '门里暂存道' : s.at === 'xray' ? '收货过磅、安检' : '');
  // 同一块板拆出来、同一辆车提走（或送来）、同一类的货并成一条
  const groups = new Map<string, number[]>();
  pallets.forEach((p, i) => {
    const k = `${p.dir}|${p.uld}|${p.cls}|${p.truck ?? -1}`;
    const a = groups.get(k) ?? [];
    a.push(i);
    groups.set(k, a);
  });
  const CLS_LABEL: Record<Cls, string> = { general: '普货', chill: '冷藏货', frozen: '冷冻货', dg: '危险品', vault: '贵重品', customs: '查验货' };
  for (const list of groups.values()) {
    const p = pallets[list[0] as number] as TermPallet;
    const steps = merge(p.spans.map((s) => ({ zone: pZone(s) ?? '', t0: s.t0, t1: s.t1, act: pAct(s) })).filter((s) => s.zone));
    if (!steps.length) continue;
    const u = ulds[p.uld] as TermUld;
    const tr = p.truck !== undefined ? trucks[p.truck] : undefined;
    flows.push({
      id: `${u.id}/${p.cls}/${p.truck ?? '-'}`,
      label: `${p.dir === 'in' ? '进口' : '出口'}${CLS_LABEL[p.cls]} ${list.length} 板（${u.id}）`,
      own: p.own,
      units: list.length,
      unit: '板',
      steps,
      kind: 'cargo',
      cold: p.cls === 'chill' || p.cls === 'frozen',
      ...(p.dir === 'in' ? { carrierIn: u.flight } : { carrierOut: u.flight }),
      ...(tr ? (p.dir === 'in' ? { carrierOut: tr.id } : { carrierIn: tr.id }) : {}),
    });
  }
  for (const tr of trucks) {
    const steps = merge([
      { zone: 'queue', t0: tr.arrive, t1: tr.t0, act: tr.own ? '开到冷链门' : '在等候区、待命车道排队' },
      { zone: 'docks', t0: tr.t0, t1: tr.t1, act: `靠在${(L.docks[tr.dock] as { id: string }).id}号门${tr.dir === 'pickup' ? '装车' : '卸货'}` },
    ]);
    flows.push({ id: tr.id, label: tr.label, own: tr.own, units: 1, unit: '车', steps, kind: 'vehicle', cold: tr.kind === 'reefer', ...(tr.dir === 'pickup' ? { carrierOut: tr.id } : { carrierIn: tr.id }) });
  }
  const occupancy = tallyOccupancy(zones, flows);
  // —— 指标 ——
  const inDay = (t: number) => t >= 0 && t < 86400;
  const peak = (key: string) => {
    const a = occupancy[key];
    let m = 0;
    let at = 0;
    if (a) for (let k = 0; k < Math.min(a.length, 288); k++) if ((a[k] as number) > m) {
      m = a[k] as number;
      at = k * 300;
    }
    return { m, at };
  };
  const cap = (key: string) => zones.find((z) => z.key === key)?.capacity ?? 1;
  const impDwell: number[] = [];
  for (const p of pallets) if (p.dir === 'in' && p.truck !== undefined) {
    const u = ulds[p.uld] as TermUld;
    const tr = trucks[p.truck] as TermTruck;
    if (inDay(tr.t1)) impDwell.push((tr.t1 - u.tIn) / 3600);
  }
  for (const u of ulds) if (u.dir === 'in' && u.mode === 'bup' && u.truck !== undefined) {
    const tr = trucks[u.truck] as TermTruck;
    if (inDay(tr.t1)) impDwell.push((tr.t1 - u.tIn) / 3600);
  }
  impDwell.sort((a, b) => a - b);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const bdWait = ulds.filter((u) => u.dir === 'in' && u.mode === 'bd' && u.tJob0 !== undefined && u.tStored !== undefined && inDay(u.tJob0)).map((u) => ((u.tJob0 as number) - (u.tStored as number)) / 60);
  // 待拆板（存在 ETV 里、还没上工位的进口板）
  const backlog = new Float32Array(HUB_SLOTS);
  for (const u of ulds) if (u.dir === 'in' && u.mode === 'bd' && u.tStored !== undefined) {
    const t1 = u.tJob0 ?? 30 * 3600;
    for (let k = Math.max(0, Math.floor(u.tStored / 300)); k < Math.min(HUB_SLOTS, Math.ceil(t1 / 300)); k++) backlog[k] = (backlog[k] as number) + 1;
  }
  let blMax = 0;
  let blAt = 0;
  for (let k = 0; k < 288; k++) if ((backlog[k] as number) > blMax) {
    blMax = backlog[k] as number;
    blAt = k * 300;
  }
  const dayTrucks = trucks.filter((tr) => inDay(tr.t0));
  const waits = dayTrucks.filter((tr) => !tr.own).map((tr) => Math.max(0, tr.t0 - tr.arrive - 240) / 60);
  const turns = dayTrucks.filter((tr) => !tr.own).map((tr) => (tr.t1 - tr.arrive) / 60);
  const dockHours = dayTrucks.reduce((s, tr) => s + (Math.min(86400, tr.t1) - Math.max(0, tr.t0)), 0) / 3600;
  const exp = ulds.filter((u) => u.dir === 'out' && u.tDue !== undefined && inDay(u.tDue));
  const onTime = exp.length ? exp.filter((u) => u.ready).length / exp.length : 1;
  const own = pallets.filter((p) => p.own && p.dir === 'in');
  const ownCold = own.filter((p) => p.tIn !== undefined).map((p) => (((p.tIn as number) - (ulds[p.uld] as TermUld).tIn) / 60));
  // 冷链货在常温区的时间：从拆板工位拆下来到进冷库（冷链穿堂和冷链门是温控的，不算）
  const exposure = pallets
    .filter((p) => p.dir === 'in' && (p.cls === 'chill' || p.cls === 'frozen'))
    .map((p) => {
      const station = p.spans.find((s) => s.at === 'station');
      const loc = p.spans.find((s) => s.at === 'loc');
      return station && loc ? (loc.t0 - station.t0) / 60 : 0;
    });
  const etv = peak('etv');
  const chill = peak('chill');
  const frozen = peak('frozen');
  const kpi: HubKpi[] = [
    { key: 'imp_dwell_avg', label: '进口货平均在站', value: avg(impDwell), unit: '小时', better: 'lower' },
    { key: 'imp_dwell_p95', label: '进口货在站 95 分位', value: impDwell.length ? (impDwell[Math.min(impDwell.length - 1, Math.floor(impDwell.length * 0.95))] as number) : 0, unit: '小时', better: 'lower' },
    { key: 'bd_wait_avg', label: '进 ETV 到上工位（平均）', value: avg(bdWait), unit: '分钟', better: 'lower' },
    { key: 'bd_backlog_peak', label: '待拆板最多', value: blMax, unit: 'ULD', better: 'lower' },
    { key: 'etv_peak', label: 'ETV 板架最满', value: (etv.m / cap('etv')) * 100, unit: '%', better: 'lower' },
    { key: 'chill_peak', label: '冷藏库最满', value: (chill.m / cap('chill')) * 100, unit: '%', better: 'lower' },
    { key: 'frozen_peak', label: '冷冻库最满', value: (frozen.m / cap('frozen')) * 100, unit: '%', better: 'lower' },
    { key: 'dock_util', label: '陆侧收货口利用率', value: (dockHours / (L.docks.length * 24)) * 100, unit: '%' },
    { key: 'truck_wait_avg', label: '货车平均排队', value: avg(waits), unit: '分钟', better: 'lower' },
    { key: 'truck_wait_max', label: '货车最长排队', value: waits.length ? Math.max(...waits) : 0, unit: '分钟', better: 'lower' },
    { key: 'truck_turn_avg', label: '货车平均在场', value: avg(turns), unit: '分钟', better: 'lower' },
    { key: 'export_ontime', label: '出口板按时组好', value: onTime * 100, unit: '%', better: 'higher' },
    { key: 'overtime', label: '加班组（本店的板、赶截载）', value: overtime, unit: '次', better: 'lower' },
    { key: 'own_to_cold', label: '本店的板：进门到进冷藏库', value: avg(ownCold), unit: '分钟', better: 'lower' },
    { key: 'cold_exposure_max', label: '冷链货在常温区最长', value: exposure.length ? Math.max(...exposure) : 0, unit: '分钟', better: 'lower' },
    { key: 'uld_in', label: '今天进口板', value: ulds.filter((u) => u.dir === 'in' && inDay(u.tIn)).length, unit: 'ULD', better: 'higher' },
    { key: 'uld_out', label: '今天出口板', value: exp.length, unit: 'ULD', better: 'higher' },
    { key: 'trucks', label: '今天陆侧车次', value: dayTrucks.length, unit: '车' },
  ];
  const hn: string[] = [];
  if (blMax > 0) hn.push(`待拆板最多 ${blMax} 块（${clock(blAt)}），工位 ${L.stations.length} 个，拆组板每班 ${Math.max(1, Math.floor(input.crew(blAt) / 2))} 组。`);
  hn.push(`ETV 板架最满 ${Math.round((etv.m / cap('etv')) * 100)}%（${clock(etv.at)}），冷藏库最满 ${Math.round((chill.m / cap('chill')) * 100)}%（${clock(chill.at)}）。`);
  if (waits.length) {
    const w = Math.max(...waits);
    const tr = dayTrucks.filter((x) => !x.own).find((x) => Math.max(0, x.t0 - x.arrive - 240) / 60 === w);
    hn.push(`陆侧今天 ${dayTrucks.length} 车次，平均排队 ${avg(waits).toFixed(0)} 分钟，最长 ${Math.round(w)} 分钟${tr ? `（${clock(tr.arrive)} 到的「${tr.label}」）` : ''}。`);
  }
  const ownTr = trucks.filter((x) => x.own);
  if (own.length) hn.push(`本店的货 ${own.length} 板：进门到进冷藏库平均 ${avg(ownCold).toFixed(0)} 分钟${ownTr.length ? `，${ownTr.map((x) => `${x.id} ${clock(x.t0)} 在${(L.docks[x.dock] as { id: string }).id}号门装车`).join('、')}` : ''}。`);
  if (overtime) hn.push(`为本店的板、赶截载的出口板临时加了 ${overtime} 次组。`);
  void jobs;
  return { key: 'airport', label: '机场货站', zones, flows, occupancy, kpi, notes: [...hn, ...notes] };
}
