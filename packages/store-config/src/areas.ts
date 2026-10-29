import type { StagingRackConfig, StoreConfig } from './schema';
import { shelfRect, STAGING_COL_PITCH, STAGING_PER_COLUMN, STAGING_ROW_PITCH, stagingRackLength } from './editing';

/**
 * 区域（决策记录 0013 第 4 节）：收货区、后仓、暂存区里每一块有用途的地面。
 *
 * - 配置里可以明确给出区域（`areas`）、卸货门（`docks`）和暂存货架的位置；
 * - 没有给出时按门店的尺寸自动生成默认区域，和原来的布局一致（超市的后仓会分出冷藏库和冷冻库，建材店分出大件区）；
 * - 后仓货架、库位、暂存货架的位置、作业核心的库位和格位都从区域推导，编辑器改区域就改了这些。
 * 坐标：配置里的 (x, y) 米对应这里的 (x, z)，与模拟器一致。区域名称在界面里按类型翻译，这里只用代码。
 */

export type AreaKind =
  // 收货
  | 'UNLOAD'
  | 'RECEIVING_HOLD'
  | 'QA'
  | 'RTV'
  | 'RETURNS'
  | 'PALLETS'
  | 'BALER'
  // 后仓存储
  | 'RACKS'
  | 'COOLER'
  | 'FREEZER'
  | 'OVERSTOCK'
  | 'BULK'
  | 'CAGE'
  | 'CHEM'
  | 'CHARGING'
  // 暂存
  | 'STAGING'
  | 'STAGING_DELIVERY'
  | 'STAGING_OVERSIZED'
  | 'STAGING_COOLER'
  | 'STAGING_FREEZER'
  | 'HOT_HOLD'
  | 'PARCEL'
  | 'RECOVERY'
  // 连通（决策记录 0019）：收货区 ↔ 暂存区的通道、暂存区里放后仓溢出托盘的地面
  | 'PASSAGE'
  | 'OVERFLOW';

export type AreaGroup = 'RECEIVING' | 'STORAGE' | 'STAGING';
/** 容量单位：托盘位、箱、框、件、包裹 */
export type AreaUnit = 'PALLET' | 'CASE' | 'TOTE' | 'ITEM' | 'PARCEL';
export type AreaTemp = 'AMBIENT' | 'CHILLED' | 'FROZEN' | 'HOT';

export const AREA_KINDS: Record<AreaKind, { group: AreaGroup; unit: AreaUnit; temp: AreaTemp }> = {
  UNLOAD: { group: 'RECEIVING', unit: 'PALLET', temp: 'AMBIENT' },
  RECEIVING_HOLD: { group: 'RECEIVING', unit: 'CASE', temp: 'AMBIENT' },
  QA: { group: 'RECEIVING', unit: 'CASE', temp: 'AMBIENT' },
  RTV: { group: 'RECEIVING', unit: 'CASE', temp: 'AMBIENT' },
  RETURNS: { group: 'RECEIVING', unit: 'ITEM', temp: 'AMBIENT' },
  PALLETS: { group: 'RECEIVING', unit: 'PALLET', temp: 'AMBIENT' },
  BALER: { group: 'RECEIVING', unit: 'PALLET', temp: 'AMBIENT' },
  RACKS: { group: 'STORAGE', unit: 'PALLET', temp: 'AMBIENT' },
  COOLER: { group: 'STORAGE', unit: 'CASE', temp: 'CHILLED' },
  FREEZER: { group: 'STORAGE', unit: 'CASE', temp: 'FROZEN' },
  OVERSTOCK: { group: 'STORAGE', unit: 'PALLET', temp: 'AMBIENT' },
  BULK: { group: 'STORAGE', unit: 'ITEM', temp: 'AMBIENT' },
  CAGE: { group: 'STORAGE', unit: 'CASE', temp: 'AMBIENT' },
  CHEM: { group: 'STORAGE', unit: 'CASE', temp: 'AMBIENT' },
  CHARGING: { group: 'STORAGE', unit: 'ITEM', temp: 'AMBIENT' },
  STAGING: { group: 'STAGING', unit: 'TOTE', temp: 'AMBIENT' },
  STAGING_DELIVERY: { group: 'STAGING', unit: 'TOTE', temp: 'AMBIENT' },
  STAGING_OVERSIZED: { group: 'STAGING', unit: 'ITEM', temp: 'AMBIENT' },
  STAGING_COOLER: { group: 'STAGING', unit: 'TOTE', temp: 'CHILLED' },
  STAGING_FREEZER: { group: 'STAGING', unit: 'TOTE', temp: 'FROZEN' },
  HOT_HOLD: { group: 'STAGING', unit: 'ITEM', temp: 'HOT' },
  PARCEL: { group: 'STAGING', unit: 'PARCEL', temp: 'AMBIENT' },
  RECOVERY: { group: 'STAGING', unit: 'TOTE', temp: 'AMBIENT' },
  PASSAGE: { group: 'STAGING', unit: 'PALLET', temp: 'AMBIENT' },
  OVERFLOW: { group: 'STAGING', unit: 'PALLET', temp: 'AMBIENT' },
};

/** 暂存区里装冷藏 / 冷冻订单框的步入式冷库（线上订单冷藏库、冷冻库） */
export const STAGING_WALK_IN: Partial<Record<AreaKind, 'CHILLED' | 'FROZEN'>> = { STAGING_COOLER: 'CHILLED', STAGING_FREEZER: 'FROZEN' };

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface ResolvedArea extends Rect {
  id: string;
  kind: AreaKind;
  group: AreaGroup;
  floorId: string;
  tempZone: AreaTemp;
  capacity: number;
  unit: AreaUnit;
  /** 用户起的名字；没有时界面按类型显示 */
  label?: string;
  /** 预警阈值（0–1），默认 0.85（托盘货架区 0.95） */
  alertAt: number;
  /** 自动生成（配置里没有明确给出） */
  auto: boolean;
}

export interface ResolvedDock {
  id: string;
  x: number;
  z: number;
  /** 高台卸货口（DOCK）或地面卷帘门（GRADE） */
  kind: 'DOCK' | 'GRADE';
  reefer: boolean;
  auto: boolean;
}

/** 暂存货架摆放后的位置（中心点，货架沿 x 方向） */
export interface PlacedRack {
  rackId: string;
  zoneCode: string;
  tempZone: StagingRackConfig['tempZone'];
  purpose: StagingRackConfig['purpose'];
  area: StagingRackConfig['area'];
  areaId?: string;
  x: number;
  z: number;
  length: number;
  levels: number;
  slotsPerLevel: number;
}

/** 后仓的基本框架（不看区域）：货架区、收货区、默认卸货门、主通道 */
export interface BackroomFrame {
  zone: Rect;
  receiving: Rect;
  docks: Array<{ x: number; z: number }>;
  mainAisleX: number;
  entry: { x: number; z: number };
  floorId: string;
  width: number;
  depth: number;
  backWall: number;
  /** 两层的门店：一楼收货区旁的货梯（通到二楼的卸货区和补货区，决策记录 0019） */
  lift?: { x: number; z: number; upperFloorId: string };
}

/** 卸货门的间距（米） */
export const DOCK_PITCH = 5;

/** 后墙上最多能排几个卸货门：约占后墙的 60%（其余是货架区） */
export function maxDocks(width: number): number {
  return Math.max(1, Math.min(10, Math.floor((width * 0.6) / DOCK_PITCH)));
}

export interface StoreAreas {
  areas: ResolvedArea[];
  docks: ResolvedDock[];
  racks: PlacedRack[];
  frame: BackroomFrame;
}

/** 托盘货架的尺寸（米）：一段宽、货架进深、叉车通道宽、层高 */
export const RACK = { BAY_W: 2.7, RACK_D: 2.4, AISLE_D: 3.6, LEVEL_H: 1.5 } as const;
/** 地面堆放托盘的格子（含间隔，米） */
const FLOOR_SPOT = 1.6;

export function backroomFrame(config: StoreConfig): BackroomFrame {
  const br = config.backroom;
  const f1 = config.layout.floors.find((f) => f.level === 0) ?? config.layout.floors[0];
  const width = f1?.widthM ?? 60;
  const depth = f1?.depthM ?? 40;
  const floorId = f1?.id ?? 'F1';
  const f1Runs = config.layout.runs.filter((r) => r.floorId === floorId);
  const backWall = Math.max(...f1Runs.map((r) => Math.max(r.start.y, r.end.y)), 0);
  const stagingX = config.layout.points.staging.x;
  const entry = { x: config.layout.points.backroom.x, z: config.layout.points.backroom.y };
  // 卸货门：后墙右侧，间隔 5 米（门店太窄时少排几个）
  const n = Math.min(br.docks, maxDocks(width));
  const docks = Array.from({ length: n }, (_, k) => ({ x: width - 3 - k * DOCK_PITCH, z: depth }));
  const receiving = { x0: Math.min(stagingX - 8, width - 3 - (n - 1) * DOCK_PITCH - 4), x1: width - 1, z0: Math.max(backWall + 2.4, depth - 9), z1: depth - 0.5 };
  // 两层的门店：货架区和收货区之间留出货梯的位置（货梯在主通道和收货区之间，前后位置两层都要在货架以外）
  const upper = config.layout.floors.find((f) => f.level === (f1?.level ?? 0) + 1);
  const upperRuns = upper ? config.layout.runs.filter((r) => r.floorId === upper.id) : [];
  const upperBack = upperRuns.length ? Math.max(...upperRuns.map((r) => Math.max(r.start.y, r.end.y))) : backWall;
  const liftGap = upper ? 3.4 : 0;
  const zone = { x0: 1.5, x1: Math.max(4, receiving.x0 - 4 - liftGap), z0: backWall + 2.4, z1: depth - 0.6 };
  const lift = upper ? { x: receiving.x0 - 1.9, z: Math.min(Math.min(depth, upper.depthM) - 2, Math.max(backWall, upperBack) + 2.4 + 1.7), upperFloorId: upper.id } : undefined;
  return { zone, receiving, docks, mainAisleX: zone.x1 + 1.8, entry, floorId, width, depth, backWall, ...(lift ? { lift } : {}) };
}

/** 卸货场的设置（决策记录 0019）：没给的项用缺省值 */
export interface YardSettings {
  side: 'RIGHT' | 'LEFT';
  via: 'DRIVE' | 'STREET';
  offsetM: number;
  /** 0 = 按场地自动 */
  slots: number;
  trailerStalls: number;
}

/** 后勤通道离停车场的缺省距离：两个出入口的喇叭口不重叠 */
export const DEFAULT_YARD_OFFSET = 24;

export function yardSettings(config: Pick<StoreConfig, 'outdoor'>): YardSettings {
  const y = config.outdoor.yard ?? {};
  return { side: y.side ?? 'RIGHT', via: y.via ?? 'DRIVE', offsetM: y.offsetM ?? DEFAULT_YARD_OFFSET, slots: y.slots ?? 0, trailerStalls: y.trailerStalls ?? 0 };
}

/** 一块货架区里能排下的托盘货架：从后边（z1）往前排，第一排靠墙只有一面 */
export function rackRowsIn(r: Rect, againstWall = true): Array<{ z: number; x0: number; x1: number; bays: number; singleSided: boolean; aisle: number }> {
  const { BAY_W, RACK_D, AISLE_D } = RACK;
  const depth = r.z1 - r.z0;
  const fit = depth >= RACK_D / 2 + AISLE_D ? Math.max(1, Math.floor((depth - RACK_D / 2) / (RACK_D + AISLE_D)) + 1) : 0;
  const bays = Math.max(0, Math.floor((r.x1 - r.x0 - 4) / BAY_W));
  const rows: Array<{ z: number; x0: number; x1: number; bays: number; singleSided: boolean; aisle: number }> = [];
  for (let i = 0; i < fit; i++) {
    const singleSided = againstWall && i === 0;
    const z = singleSided ? r.z1 - RACK_D / 4 - 0.1 : r.z1 - RACK_D / 2 - i * (RACK_D + AISLE_D) + (againstWall ? RACK_D / 4 : 0);
    if (z - RACK_D / 2 - AISLE_D < r.z0 - 0.01) break;
    rows.push({ z, x0: r.x0 + 2, x1: r.x0 + 2 + bays * BAY_W, bays, singleSided, aisle: z - (singleSided ? RACK_D / 4 : RACK_D / 2) - AISLE_D / 2 });
  }
  return rows;
}

function floorSpots(r: Rect): number {
  return Math.max(1, Math.floor((r.x1 - r.x0) / FLOOR_SPOT) * Math.floor((r.z1 - r.z0) / FLOOR_SPOT));
}

function round1(r: Rect): Rect {
  const q = (v: number) => Math.round(v * 10) / 10;
  return { x0: q(r.x0), z0: q(r.z0), x1: q(r.x1), z1: q(r.z1) };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 暂存货架摆放：明确给了位置的照位置；指定了区域的在区域里排成网格；其余从暂存点往店内排成若干列（原来的规则）。
 * assign：默认布局（没有明确给出区域）里货架归哪个区域，例如冷藏、冷冻订单货架放进线上订单冷藏库、冷冻库（决策记录 0019）
 */
export function stagingPlacement(config: StoreConfig, areas?: ReadonlyArray<{ id: string } & Rect>, assign?: (r: StagingRackConfig) => string | undefined): PlacedRack[] {
  const sp = config.layout.points.staging;
  const order = ['AMB', 'GM', 'CHL', 'FRZ', 'HOT', 'OVS', 'RCV'];
  const rank = (code: string) => {
    const i = order.indexOf(code);
    return i < 0 ? order.length : i;
  };
  const sorted = [...config.staging.racks].sort((a, b) => rank(a.zoneCode) - rank(b.zoneCode) || a.rackNo - b.rackNo);
  const out: PlacedRack[] = [];
  const areaOf = (r: StagingRackConfig) => r.areaId ?? assign?.(r);
  const base = (r: StagingRackConfig, x: number, z: number): PlacedRack => {
    const p: PlacedRack = { rackId: r.id, zoneCode: r.zoneCode, tempZone: r.tempZone, purpose: r.purpose, area: r.area, x, z, length: stagingRackLength(r.slotsPerLevel), levels: r.levels, slotsPerLevel: r.slotsPerLevel };
    const id = areaOf(r);
    if (id) p.areaId = id;
    return p;
  };
  // 默认网格：没有区域、也没有位置的货架
  const free = sorted.filter((r) => {
    const id = areaOf(r);
    return r.x === undefined && !(id && areas?.some((a) => a.id === id));
  });
  free.forEach((r, i) => {
    const col = Math.floor(i / STAGING_PER_COLUMN);
    const row = i % STAGING_PER_COLUMN;
    const length = stagingRackLength(r.slotsPerLevel);
    out.push(base(r, sp.x + 3 + col * STAGING_COL_PITCH + length / 2, sp.y + 2 + row * STAGING_ROW_PITCH));
  });
  // 区域里的网格：按区域分组，从区域左前角排起
  const byArea = new Map<string, StagingRackConfig[]>();
  for (const r of sorted) {
    const id = areaOf(r);
    if (r.x === undefined && id && areas?.some((a) => a.id === id)) byArea.set(id, [...(byArea.get(id) ?? []), r]);
  }
  for (const [areaId, list] of byArea) {
    const a = areas?.find((x) => x.id === areaId);
    if (!a) continue;
    const perCol = Math.max(1, Math.floor((a.z1 - a.z0 - 0.6) / STAGING_ROW_PITCH) + 1);
    list.forEach((r, i) => {
      const length = stagingRackLength(r.slotsPerLevel);
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      out.push(base(r, a.x0 + 0.4 + col * Math.max(STAGING_COL_PITCH, length + 0.8) + length / 2, a.z0 + 0.6 + row * STAGING_ROW_PITCH));
    });
  }
  for (const r of sorted) if (r.x !== undefined) out.push(base(r, r.x, r.z ?? sp.y + 2));
  return out;
}

function bbox(rs: PlacedRack[], pad = 0.5): Rect {
  return {
    x0: Math.min(...rs.map((r) => r.x - r.length / 2)) - pad,
    x1: Math.max(...rs.map((r) => r.x + r.length / 2)) + pad,
    z0: Math.min(...rs.map((r) => r.z)) - pad,
    z1: Math.max(...rs.map((r) => r.z)) + pad,
  };
}

/** 默认布局里装进步入式冷库的暂存货架：冷藏、冷冻订单货架和对应温区的回收货架 */
function walkInFor(r: StagingRackConfig): 'STAGING_COOLER' | 'STAGING_FREEZER' | undefined {
  if (r.tempZone === 'CHILLED') return 'STAGING_COOLER';
  if (r.tempZone === 'FROZEN') return 'STAGING_FREEZER';
  return undefined;
}

/** 步入式冷库的默认大小：货架每列 3 个（区域网格的排法），列宽按最长的货架 */
function walkInSize(racks: readonly StagingRackConfig[]): { w: number; d: number } {
  const rows = Math.min(3, racks.length);
  const cols = Math.ceil(racks.length / 3);
  const longest = Math.max(...racks.map((r) => stagingRackLength(r.slotsPerLevel)));
  const pitch = Math.max(STAGING_COL_PITCH, longest + 0.8);
  return { w: Math.max(3.6, 0.4 + (cols - 1) * pitch + longest + 0.8), d: 0.6 + (rows - 1) * STAGING_ROW_PITCH + 0.9 };
}

type DraftArea = { id: string; kind: AreaKind; floorId: string; tempZone?: AreaTemp } & Rect;

/**
 * 默认的线上订单区（决策记录 0019）：常温暂存货架网格在前（靠交付门口），后面是线上订单冷藏库、冷冻库（冷藏、冷冻订单货架在里面），
 * 一条 3 米宽的连通通道从暂存区一直通到后面的收货区，通道旁边是放后仓溢出托盘的地面（溢流位）。
 * 暂存区和收货区之间放不下冷库时，冷库放到暂存货架右边；两者紧挨着时（很小的门店）不设通道。
 */
function defaultOnlineArea(config: StoreConfig, frame: BackroomFrame): { areas: DraftArea[]; assign: (r: StagingRackConfig) => string | undefined } {
  const sf = config.layout.points.staging.floorId;
  const cold = { STAGING_COOLER: [] as StagingRackConfig[], STAGING_FREEZER: [] as StagingRackConfig[] };
  for (const r of config.staging.racks) {
    const k = r.x === undefined && !r.areaId ? walkInFor(r) : undefined;
    if (k) cold[k].push(r);
  }
  // 常温货架的网格（冷藏、冷冻货架拿出去之后）
  const ambient = stagingPlacement({ ...config, staging: { ...config.staging, racks: config.staging.racks.filter((r) => !(r.x === undefined && !r.areaId && walkInFor(r))) } });
  const areas: DraftArea[] = [];
  if (!ambient.length) return { areas, assign: () => undefined };
  const sb = bbox(ambient);
  const recvZ0 = frame.receiving.z0;
  const rooms = (['STAGING_COOLER', 'STAGING_FREEZER'] as const).filter((k) => cold[k].length);
  const sizes = rooms.map((k) => walkInSize(cold[k]));
  const roomD = Math.max(0, ...sizes.map((z) => z.d));
  const gap = recvZ0 - sb.z1;
  const behind = gap >= roomD + 1.2;
  let x = sb.x1 + 0.6;
  let z0 = sb.z0;
  if (gap >= 1.2) {
    // 通道沿暂存区左边往后通到收货区；溢流位在通道左边、靠暂存区的一端（地面堆放托盘）
    const passage = { x0: sb.x0, x1: sb.x0 + 3, z0: sb.z1 + 0.3, z1: recvZ0 - 0.3 };
    areas.push({ id: 'PASSAGE-1', kind: 'PASSAGE', floorId: sf, ...round1(passage) });
    const d = Math.min(6, Math.max(2.4, passage.z1 - passage.z0 - 0.6));
    areas.push({ id: 'OVERFLOW-1', kind: 'OVERFLOW', floorId: sf, ...round1({ x0: passage.x0 - 6.4, x1: passage.x0 - 0.4, z0: passage.z0 + 0.3, z1: passage.z0 + 0.3 + d }) });
    // 冷库在通道右边，门朝前（暂存区）
    if (behind) {
      x = passage.x1 + 0.4;
      z0 = sb.z1 + 0.6;
    }
  }
  // 放不下时冷库放到暂存货架右边（大件暂存区再往右）
  rooms.forEach((k, i) => {
    const z = sizes[i] as { w: number; d: number };
    areas.push({ id: `${k}-1`, kind: k, floorId: sf, ...round1({ x0: x, x1: x + z.w, z0, z1: z0 + z.d }) });
    x += z.w + 0.4;
  });
  const assign = (r: StagingRackConfig) => {
    const k = r.x === undefined && !r.areaId ? walkInFor(r) : undefined;
    return k && rooms.includes(k) ? `${k}-1` : undefined;
  };
  return { areas, assign };
}

/** 二楼（决策记录 0019）：货梯口旁的卸货区和后面的补货区；只有两层的门店才有 */
function defaultUpper(config: StoreConfig, frame: BackroomFrame): DraftArea[] {
  const lift = frame.lift;
  if (!lift) return [];
  const f = config.layout.floors.find((x) => x.id === lift.upperFloorId);
  if (!f) return [];
  const runs = config.layout.runs.filter((r) => r.floorId === f.id);
  const back = runs.length ? Math.max(...runs.map((r) => Math.max(r.start.y, r.end.y))) : 0;
  const z0 = back + 2.4;
  const z1 = f.depthM - 0.6;
  if (z1 - z0 < 2) return [];
  const out: DraftArea[] = [];
  const unloadX1 = Math.min(f.widthM - 1, lift.x + 1.8 + 7);
  if (unloadX1 - (lift.x + 1.8) >= 2) out.push({ id: 'UNLOAD-2', kind: 'UNLOAD', floorId: f.id, ...round1({ x0: lift.x + 1.8, x1: unloadX1, z0, z1 }) });
  if (lift.x - 1.8 - 1.5 >= 4) out.push({ id: 'OVERSTOCK-2', kind: 'OVERSTOCK', floorId: f.id, ...round1({ x0: 1.5, x1: lift.x - 1.8, z0, z1 }) });
  return out;
}

/** 没有明确给出区域时的默认区域（后仓、收货区与原来一致；线上订单区和二楼见 defaultOnlineArea、defaultUpper） */
export function defaultAreas(config: StoreConfig, frame = backroomFrame(config), online = defaultOnlineArea(config, frame), racks = stagingPlacement(config, online.areas, online.assign)): DraftArea[] {
  const out: DraftArea[] = [];
  const f = frame.floorId;
  const z = frame.zone;
  const zw = z.x1 - z.x0;
  let rackX0 = z.x0;
  if (config.industry === 'HARDWARE') {
    // 建材店：后仓左端是大件区（板材、建材地面堆放）
    const w = clamp(zw * 0.18, 8, 14);
    out.push({ id: 'BULK-AREA-1', kind: 'BULK', floorId: f, ...round1({ x0: z.x0, x1: z.x0 + w, z0: z.z0, z1: z.z1 }) });
    rackX0 = z.x0 + w + 0.6;
  } else {
    // 超市：后仓左端是冷藏库和冷冻库（步入式冷库，紧挨卖场的乳制品和冷冻柜）
    const cw = clamp(zw * 0.14, 6, 12);
    const fw = clamp(zw * 0.1, 5, 9);
    out.push({ id: 'COOLER-1', kind: 'COOLER', floorId: f, ...round1({ x0: z.x0, x1: z.x0 + cw, z0: z.z0, z1: z.z1 }) });
    out.push({ id: 'FREEZER-1', kind: 'FREEZER', floorId: f, ...round1({ x0: z.x0 + cw + 0.3, x1: z.x0 + cw + 0.3 + fw, z0: z.z0, z1: z.z1 }) });
    rackX0 = z.x0 + cw + 0.3 + fw + 0.6;
  }
  out.push({ id: 'RACKS-1', kind: 'RACKS', floorId: f, ...round1({ x0: rackX0, x1: z.x1, z0: z.z0, z1: z.z1 }) });
  // 收货区：左边一列是待检、退供应商、退货、空托盘、纸箱回收；靠卸货门的一条是卸货区，其余是收货暂放
  const r = frame.receiving;
  const wl = clamp((r.x1 - r.x0) * 0.32, 3.6, 6.4);
  const rowH = (r.z1 - r.z0) / 3;
  const cells: Array<[AreaKind, number, number]> = [
    ['QA', 0, 0],
    ['RTV', 1, 0],
    ['RETURNS', 0, 1],
    ['CAGE', 1, 1],
    ['PALLETS', 0, 2],
    ['BALER', 1, 2],
  ];
  for (const [kind, cx, cy] of cells) {
    if (kind === 'RETURNS' && !config.modules.returns) continue;
    out.push({ id: `${kind}-1`, kind, floorId: f, ...round1({ x0: r.x0 + cx * (wl / 2) + 0.1, x1: r.x0 + (cx + 1) * (wl / 2) - 0.1, z0: r.z0 + cy * rowH + 0.1, z1: r.z0 + (cy + 1) * rowH - 0.1 }) });
  }
  const unloadDepth = Math.min(4, (r.z1 - r.z0) * 0.5);
  out.push({ id: 'UNLOAD-1', kind: 'UNLOAD', floorId: f, ...round1({ x0: r.x0 + wl + 0.3, x1: r.x1, z0: r.z1 - unloadDepth, z1: r.z1 }) });
  out.push({ id: 'HOLD-1', kind: 'RECEIVING_HOLD', floorId: f, ...round1({ x0: r.x0 + wl + 0.3, x1: r.x1, z0: r.z0, z1: r.z1 - unloadDepth - 0.2 }) });
  // 暂存区：常温货架网格里各温区（不含冷藏、冷冻）、配送、回收的货架交错排列，所以整体是一个暂存区；
  // 大件暂存是暂存区旁边的一块地面（明确划分配送暂存道、回收专区要在编辑器里画区域）
  const sf = config.layout.points.staging.floorId;
  const ambient = racks.filter((p) => !p.areaId || !online.areas.some((a) => a.id === p.areaId));
  if (ambient.length) {
    const sb = bbox(ambient);
    out.push({ id: 'STAGING-1', kind: 'STAGING', floorId: sf, ...round1(sb) });
    if (config.modules.gm) {
      // 冷库放在暂存货架右边时，大件暂存区让到冷库右边
      const right = Math.max(sb.x1, ...online.areas.filter((a) => a.z0 < sb.z1 && a.x0 >= sb.x1 - 0.01).map((a) => a.x1));
      out.push({ id: 'OVS-1', kind: 'STAGING_OVERSIZED', floorId: sf, ...round1({ x0: right + 0.6, x1: right + 5.6, z0: sb.z0, z1: sb.z0 + Math.min(6, sb.z1 - sb.z0) }) });
    }
  }
  out.push(...online.areas);
  // 包裹区和熟食保温区：交付门和暂存货架之间
  const sp = config.layout.points.staging;
  if (config.modules.parcelHub) out.push({ id: 'PARCEL-1', kind: 'PARCEL', floorId: sf, ...round1({ x0: sp.x + 3, x1: sp.x + 8, z0: sp.y - 4.4, z1: sp.y - 0.6 }) });
  if (config.modules.mto) out.push({ id: 'HOT-1', kind: 'HOT_HOLD', floorId: sf, tempZone: 'HOT', ...round1({ x0: sp.x + 8.5, x1: sp.x + 11.5, z0: sp.y - 4.4, z1: sp.y - 0.6 }) });
  out.push(...defaultUpper(config, frame));
  return out;
}

/** 区域的默认容量（配置里没给时） */
function defaultCapacity(kind: AreaKind, r: Rect, config: StoreConfig, racks: PlacedRack[], id: string, auto: boolean, upper = false): number {
  switch (kind) {
    case 'RACKS':
    case 'OVERSTOCK':
      // 二楼的补货区是地面堆放（没有叉车），按托盘位算
      if (upper) return floorSpots(r);
      return rackRowsIn(r).reduce((n, row) => n + row.bays * config.backroom.rackLevels * (row.singleSided ? 1 : 2), 0);
    case 'COOLER':
      // 默认冷藏库 12 个库位、冷冻库 10 个，每个 30 箱（与原来的固定库位一致）
      return auto ? 12 * 30 : Math.max(30, Math.floor(((r.x1 - r.x0) * (r.z1 - r.z0)) / 2.5) * 10);
    case 'FREEZER':
      return auto ? 10 * 30 : Math.max(30, Math.floor(((r.x1 - r.x0) * (r.z1 - r.z0)) / 2.5) * 10);
    case 'QA':
    case 'RTV':
    case 'CHEM':
    case 'CAGE':
      return auto ? 80 * (kind === 'QA' || kind === 'RTV' ? 3 : 1) : Math.max(20, Math.floor((r.x1 - r.x0) * (r.z1 - r.z0) * 8));
    case 'RETURNS':
      return Math.max(20, Math.floor((r.x1 - r.x0) * (r.z1 - r.z0) * 6));
    case 'STAGING':
    case 'STAGING_DELIVERY':
    case 'STAGING_COOLER':
    case 'STAGING_FREEZER':
    case 'RECOVERY': {
      const inside = racks.filter((p) => p.areaId === id || (!p.areaId && p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1));
      const totes = inside.reduce((n, p) => n + p.levels * p.slotsPerLevel * (config.staging.racks.find((x) => x.id === p.rackId)?.totesPerSlot ?? 1), 0);
      return totes || floorSpots(r) * 4;
    }
    case 'STAGING_OVERSIZED':
    case 'BULK':
      return Math.max(4, floorSpots(r) * 2);
    case 'PARCEL':
      return Math.max(12, Math.floor((r.x1 - r.x0) * (r.z1 - r.z0) * 2));
    case 'HOT_HOLD':
      return auto ? 4 * 6 : Math.max(4, Math.floor((r.x1 - r.x0) * 4));
    case 'RECEIVING_HOLD':
      // 地面堆放：每个托盘位约 20 箱
      return floorSpots(r) * 20;
    case 'PASSAGE':
      // 通道要保持畅通：只算能临时停几个托盘（推车错车用），不当存储
      return Math.max(1, Math.floor(Math.max(r.x1 - r.x0, r.z1 - r.z0) / 8));
    default:
      return floorSpots(r);
  }
}

/** 门店的全部区域、卸货门和暂存货架位置（配置里给了就用配置，否则按默认规则生成） */
export function storeAreas(config: StoreConfig): StoreAreas {
  const frame = backroomFrame(config);
  const given = config.areas;
  const online = given ? undefined : defaultOnlineArea(config, frame);
  const racks = given ? stagingPlacement(config, given) : stagingPlacement(config, online?.areas, online?.assign);
  const raw = given ?? defaultAreas(config, frame, online, racks);
  const areas: ResolvedArea[] = raw.map((a) => {
    const meta = AREA_KINDS[a.kind];
    const rect = { x0: Math.min(a.x0, a.x1), x1: Math.max(a.x0, a.x1), z0: Math.min(a.z0, a.z1), z1: Math.max(a.z0, a.z1) };
    const out: ResolvedArea = {
      id: a.id,
      kind: a.kind,
      group: meta.group,
      floorId: a.floorId,
      tempZone: a.tempZone ?? meta.temp,
      ...rect,
      capacity: 'capacity' in a && typeof a.capacity === 'number' && a.capacity > 0 ? a.capacity : defaultCapacity(a.kind, rect, config, racks, a.id, !given, a.floorId !== frame.floorId),
      unit: meta.unit,
      // 托盘货架平时就放得很满，快满了才提醒
      alertAt: 'alertAt' in a && typeof a.alertAt === 'number' ? a.alertAt : a.kind === 'RACKS' || a.kind === 'OVERSTOCK' ? 0.95 : a.kind === 'PASSAGE' ? 0.5 : 0.85,
      auto: !given,
    };
    if ('label' in a && typeof a.label === 'string' && a.label) out.label = a.label;
    return out;
  });
  const docks: ResolvedDock[] = config.docks
    ? config.docks.map((d) => ({ id: d.id, x: d.x, z: frame.depth, kind: d.kind ?? 'DOCK', reefer: !!d.reefer, auto: false }))
    : frame.docks.map((d, k) => ({ id: `DOOR-${k + 1}`, x: d.x, z: d.z, kind: 'DOCK' as const, reefer: k === 0, auto: true }));
  return { areas, docks, racks, frame };
}

/** 点在哪个区域里（同一楼层） */
export function areaAt(areas: readonly ResolvedArea[], floorId: string, x: number, z: number): ResolvedArea | undefined {
  return areas.find((a) => a.floorId === floorId && x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1);
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0.05): boolean {
  return a.x0 < b.x1 - margin && b.x0 < a.x1 - margin && a.z0 < b.z1 - margin && b.z0 < a.z1 - margin;
}

// ---------------------------------------------------------------------------
// 编辑（纯函数，直接修改传入的草稿；由编辑器调用）

/** 这些类型的默认容量是固定值（原来的固定库位），写进配置时一起写上，避免改成按面积推算后库位数量变化 */
const FIXED_CAPACITY = new Set<AreaKind>(['COOLER', 'FREEZER', 'QA', 'RTV', 'CAGE', 'CHEM', 'HOT_HOLD']);

/** 把默认区域和卸货门写进配置，之后可以逐个编辑；暂存货架放进它们所在的暂存区 */
export function materializeAreas(cfg: StoreConfig): void {
  if (!cfg.areas) {
    const sa = storeAreas(cfg);
    cfg.areas = sa.areas.map((a) => {
      const out: NonNullable<StoreConfig['areas']>[number] = { id: a.id, kind: a.kind, floorId: a.floorId, x0: a.x0, z0: a.z0, x1: a.x1, z1: a.z1 };
      if (a.tempZone !== AREA_KINDS[a.kind].temp) out.tempZone = a.tempZone;
      if (FIXED_CAPACITY.has(a.kind)) out.capacity = a.capacity;
      return out;
    });
    const staging = cfg.areas.find((a) => a.kind === 'STAGING');
    const room = (k: AreaKind) => cfg.areas?.find((a) => a.kind === k)?.id;
    cfg.staging.racks = cfg.staging.racks.map((r) => {
      if (r.areaId || r.x !== undefined) return r;
      const k = walkInFor(r);
      const id = (k && room(k)) ?? staging?.id;
      return id ? { ...r, areaId: id } : r;
    });
  }
  if (!cfg.docks) cfg.docks = storeAreas(cfg).docks.map((d) => ({ id: d.id, x: d.x, kind: d.kind, reefer: d.reefer }));
}

const NEW_SIZE: Partial<Record<AreaKind, [number, number]>> = {
  RACKS: [16, 8],
  OVERSTOCK: [12, 8],
  COOLER: [7, 6],
  FREEZER: [6, 6],
  BULK: [10, 8],
  UNLOAD: [10, 4],
  RECEIVING_HOLD: [8, 5],
  STAGING: [10, 8],
  STAGING_DELIVERY: [10, 5],
  STAGING_COOLER: [5, 5],
  STAGING_FREEZER: [5, 5],
  PARCEL: [5, 4],
  HOT_HOLD: [3, 3],
  PASSAGE: [3, 10],
  OVERFLOW: [6, 6],
};

/** 新建一个区域：放在同组区域附近的空地上；返回新区域的编号 */
export function addArea(cfg: StoreConfig, kind: AreaKind): string {
  materializeAreas(cfg);
  const areas = cfg.areas ?? [];
  const frame = backroomFrame(cfg);
  const group = AREA_KINDS[kind].group;
  const floorId = group === 'STAGING' ? cfg.layout.points.staging.floorId : frame.floorId;
  const [w, d] = NEW_SIZE[kind] ?? [4, 3];
  // 搜索范围：收货和存储在后仓（后墙以后），暂存在暂存点附近
  const sp = cfg.layout.points.staging;
  const box = group === 'STAGING' ? { x0: sp.x - 20, x1: sp.x + 30, z0: 0.5, z1: sp.y + 25 } : { x0: 0.5, x1: frame.width - 0.5, z0: frame.backWall + 2.4, z1: frame.depth - 0.5 };
  // 已占用的地面：同一层的区域和货架
  const busy: Rect[] = [
    ...areas.filter((a) => a.floorId === floorId).map((a) => ({ x0: Math.min(a.x0, a.x1), x1: Math.max(a.x0, a.x1), z0: Math.min(a.z0, a.z1), z1: Math.max(a.z0, a.z1) })),
    ...cfg.layout.runs.filter((r) => r.floorId === floorId).flatMap((r) => {
      const rc = shelfRect(r);
      return rc ? [{ x0: rc.x0, x1: rc.x1, z0: rc.y0, z1: rc.y1 }] : [];
    }),
  ];
  const find = (b: Rect): Rect | undefined => {
    for (let z = b.z0; z + d <= b.z1 + 1e-6; z += 0.5) {
      for (let x = b.x0; x + w <= b.x1 + 1e-6; x += 0.5) {
        const r = { x0: x, z0: z, x1: x + w, z1: z + d };
        if (!busy.some((a) => rectsOverlap(r, a, -0.3))) return r;
      }
    }
    return undefined;
  };
  // 先在本组附近找，找不到就在整层（暂存可以在建筑外侧）找
  const pos = find(box) ?? find(group === 'STAGING' ? { x0: box.x0, x1: box.x1 + 30, z0: 0.5, z1: frame.depth + 20 } : { x0: 0.5, x1: frame.width - 0.5, z0: 0.5, z1: frame.depth - 0.5 });
  const r = pos ?? { x0: box.x0, z0: box.z0, x1: box.x0 + w, z1: box.z0 + d };
  let n = 1;
  while (areas.some((a) => a.id === `${kind}-${n}`)) n++;
  const id = `${kind}-${n}`;
  areas.push({ id, kind, floorId, ...round1(r) });
  cfg.areas = areas;
  return id;
}

export function moveArea(cfg: StoreConfig, id: string, dx: number, dz: number): void {
  materializeAreas(cfg);
  const a = cfg.areas?.find((x) => x.id === id);
  if (!a) return;
  const q = (v: number) => Math.round(v * 10) / 10;
  a.x0 = q(a.x0 + dx);
  a.x1 = q(a.x1 + dx);
  a.z0 = q(a.z0 + dz);
  a.z1 = q(a.z1 + dz);
  // 明确摆放在这个区域里的暂存货架一起移动（按区域网格摆放的会自动跟着走）
  for (const r of cfg.staging.racks) {
    if (r.areaId !== id || r.x === undefined) continue;
    r.x = q(r.x + dx);
    if (r.z !== undefined) r.z = q(r.z + dz);
  }
}

/** 拖动区域的右后角（x1, z1）改大小，最小 1 × 1 米 */
export function resizeArea(cfg: StoreConfig, id: string, x1: number, z1: number): void {
  materializeAreas(cfg);
  const a = cfg.areas?.find((x) => x.id === id);
  if (!a) return;
  const q = (v: number) => Math.round(v * 10) / 10;
  a.x1 = q(Math.max(Math.min(a.x0, a.x1) + 1, x1));
  a.z1 = q(Math.max(Math.min(a.z0, a.z1) + 1, z1));
}

export function removeArea(cfg: StoreConfig, id: string): void {
  materializeAreas(cfg);
  cfg.areas = (cfg.areas ?? []).filter((a) => a.id !== id);
  cfg.staging.racks = cfg.staging.racks.map((r) => {
    if (r.areaId !== id) return r;
    const { areaId: _drop, ...rest } = r;
    void _drop;
    return rest;
  });
}

/** 加一个卸货门：先在收货区后面的墙上找离已有卸货门至少 5 米的位置（靠近已有的门），找不到再找整面后墙上最空的位置；返回编号 */
export function addDock(cfg: StoreConfig): string {
  materializeAreas(cfg);
  const frame = backroomFrame(cfg);
  const docks = cfg.docks ?? [];
  const gapAt = (x: number) => Math.min(...docks.map((d) => Math.abs(d.x - x)), Infinity);
  const recv = (cfg.areas ?? []).filter((a) => a.kind === 'UNLOAD' || a.kind === 'RECEIVING_HOLD');
  const r0 = recv.length ? Math.min(...recv.map((a) => Math.min(a.x0, a.x1))) : frame.receiving.x0;
  const r1 = recv.length ? Math.max(...recv.map((a) => Math.max(a.x0, a.x1))) : frame.receiving.x1;
  let best: number | undefined;
  for (let x = Math.min(frame.width - 3, r1 - 1.5); x >= Math.max(3, r0 - 6); x -= 0.5) {
    if (gapAt(x) >= 5 && (best === undefined || gapAt(x) < gapAt(best))) best = x;
  }
  let gap = -1;
  if (best === undefined) {
    best = frame.width / 2;
    for (let x = 3; x <= frame.width - 3; x += 0.5) {
      if (gapAt(x) > gap) {
        gap = gapAt(x);
        best = x;
      }
    }
  }
  let n = docks.length + 1;
  while (docks.some((d) => d.id === `DOOR-${n}`)) n++;
  const id = `DOOR-${n}`;
  docks.push({ id, x: Math.round(best * 10) / 10, kind: 'DOCK', reefer: false });
  cfg.docks = docks;
  return id;
}

export function moveDock(cfg: StoreConfig, id: string, x: number): void {
  materializeAreas(cfg);
  const frame = backroomFrame(cfg);
  const d = cfg.docks?.find((k) => k.id === id);
  if (d) d.x = Math.round(Math.max(2, Math.min(frame.width - 2, x)) * 10) / 10;
}

export function removeDock(cfg: StoreConfig, id: string): void {
  materializeAreas(cfg);
  if ((cfg.docks?.length ?? 0) <= 1) return;
  cfg.docks = (cfg.docks ?? []).filter((d) => d.id !== id);
}

// ---------------------------------------------------------------------------
// 开业检查（「你的商店」，决策记录 0013）：返回代码和参数，界面负责翻译

export type CheckLevel = 'ok' | 'warn' | 'error';
export interface GoLiveItem {
  level: CheckLevel;
  code:
    | 'CONFIG_ISSUE'
    | 'AREA_MISSING'
    | 'COLD_STORAGE'
    | 'STAGING_CAPACITY'
    | 'PICKUP_BAYS'
    | 'DOCKS'
    | 'REEFER_DOOR'
    | 'RACK_CAPACITY'
    | 'HOURS';
  params: Record<string, string | number>;
}

/**
 * 检查一家门店能不能开业：配置本身的问题（重叠、走不到……）、必需的区域、冷链存储、
 * 暂存格位和取货车位够不够应付高峰、卸货门、后仓托盘位。ordersPerDay 是预计的日订单量。
 */
export function goLiveCheck(config: StoreConfig, ordersPerDay: number, configIssues: ReadonlyArray<{ message: string }> = []): GoLiveItem[] {
  const out: GoLiveItem[] = [];
  for (const i of configIssues.slice(0, 12)) out.push({ level: 'error', code: 'CONFIG_ISSUE', params: { message: i.message } });
  const sa = storeAreas(config);
  const kinds = new Set(sa.areas.map((a) => a.kind));
  for (const k of ['UNLOAD', 'RECEIVING_HOLD', 'RACKS', 'STAGING'] as const) if (!kinds.has(k)) out.push({ level: 'error', code: 'AREA_MISSING', params: { kind: k } });
  for (const k of ['QA', 'RTV', 'PALLETS', 'BALER'] as const) if (!kinds.has(k)) out.push({ level: 'warn', code: 'AREA_MISSING', params: { kind: k } });
  // 卖场有冷藏、冷冻商品时，后仓要有冷藏库、冷冻库
  const temps = new Set(config.layout.runs.map((r) => r.tempZone));
  if (temps.has('CHILLED') && !kinds.has('COOLER')) out.push({ level: 'warn', code: 'COLD_STORAGE', params: { kind: 'COOLER' } });
  if (temps.has('FROZEN') && !kinds.has('FREEZER')) out.push({ level: 'warn', code: 'COLD_STORAGE', params: { kind: 'FREEZER' } });
  // 暂存：高峰小时约占全天 11%，每单约 2.5 个框，平均在暂存区停 2 小时
  const peak = ordersPerDay * 0.11;
  const needTotes = Math.ceil(peak * 2.5 * 2);
  const haveTotes = sa.areas.filter((a) => a.kind === 'STAGING' || a.kind === 'STAGING_DELIVERY').reduce((n, a) => n + a.capacity, 0);
  out.push({ level: haveTotes >= needTotes ? 'ok' : haveTotes >= needTotes * 0.7 ? 'warn' : 'error', code: 'STAGING_CAPACITY', params: { have: haveTotes, need: needTotes } });
  // 取货车位：高峰时每小时到店的自取顾客（约 80%）× 平均停留 6 分钟
  const bays = config.parking?.pickupBays?.length ?? (config.outdoor.pickupBays || 13);
  const needBays = Math.max(2, Math.ceil((peak * 0.8 * 6) / 60) + 1);
  out.push({ level: bays >= needBays ? 'ok' : 'warn', code: 'PICKUP_BAYS', params: { have: bays, need: needBays } });
  out.push({ level: sa.docks.length ? 'ok' : 'error', code: 'DOCKS', params: { have: sa.docks.length } });
  if (config.industry !== 'HARDWARE' && !sa.docks.some((d) => d.reefer)) out.push({ level: 'warn', code: 'REEFER_DOOR', params: {} });
  const racks = sa.areas.filter((a) => a.kind === 'RACKS' || a.kind === 'OVERSTOCK').reduce((n, a) => n + a.capacity, 0);
  out.push({ level: racks >= 24 ? 'ok' : racks > 0 ? 'warn' : 'error', code: 'RACK_CAPACITY', params: { have: racks } });
  const h = config.hours;
  if (h.closeMin - h.openMin < 6 * 60) out.push({ level: 'warn', code: 'HOURS', params: { hours: Math.round((h.closeMin - h.openMin) / 60) } });
  return out;
}
