import { createRng, type Rng } from '@storewright/domain';
import { LANE_OFF, MEDIAN_W, type LotLayout, type Pt, type RoadAccess } from './lot';
import { trRecord } from '../i18n';
import { planYard, type YardPlan } from './yardPlan';
import { planWater, type WaterPlan } from './terrain/waterPlan';
import type { BoatTraffic } from './terrain/harbor';

/**
 * 门店周边环境：按随机种子和道路风格生成主路、支路、信号灯、人行道、建筑、树木和后勤通道。
 * 纯函数，同一输入总是得到同一结果；交通流在 traffic.ts 中按这里的车道运行。
 */

export type RoadStyle = 'suburban' | 'urban' | 'arterial';

/** 门店所在地块：标准（临主路）、街角（侧面也临街）、商业街（旁边连着几家小店）、自动随机 */
export type SiteLayoutKind = 'auto' | 'standard' | 'corner' | 'strip';

export type Weather = 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog' | 'dynamic';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export const WEATHER_LABEL: Record<Weather, string> = trRecord({ clear: '晴', cloudy: '多云', rain: '雨', snow: '雪', fog: '雾', dynamic: '多变' });
export const SEASON_LABEL: Record<Season, string> = trRecord({ spring: '春', summer: '夏', autumn: '秋', winter: '冬' });

export interface SiteSettings {
  style: RoadStyle;
  seed: number;
  /** 道路拥堵强度：0 关闭，1 一般，2 严重（同时用于仿真到店延误和画面中的车流） */
  traffic: number;
  layout?: SiteLayoutKind;
  /** 主路上有一段施工（限速、锥桶） */
  roadWorks?: boolean;
  /** 天气（影响路况、车边交付速度、线上订单量和画面）与季节（影响日照时间和植物颜色） */
  weather?: Weather;
  season?: Season;
  /** 水系（决策记录 0019）：湖（有出海口，船只进出港，默认）或没有水面 */
  water?: WaterKind;
  /** 附近有学校：上学、放学时路上车多、人多（决策记录 0019） */
  school?: boolean;
  /** 主路上有铁路道口：火车经过时道口栏杆放下，车辆排队（决策记录 0019） */
  railway?: boolean;
  /** 船只多少（决策记录 0020）：栈桥的船跑几趟、海上来的访客船和海湾里经过的船有几条；默认一般 */
  boats?: BoatTraffic;
}

export type WaterKind = 'lake' | 'none';
export const WATER_LABEL: Record<WaterKind, string> = trRecord({ lake: '湖与出海口', none: '没有水面' });
export const BOATS_LABEL: Record<BoatTraffic, string> = trRecord({ few: '少', normal: '一般', many: '多' });

/** 卸货场的进场设置（门店配置 outdoor.yard，决策记录 0019） */
export interface YardAccess {
  side: 'RIGHT' | 'LEFT';
  via: 'DRIVE' | 'STREET';
  offsetM: number;
  slots: number;
  trailerStalls: number;
}

export const DEFAULT_ACCESS: YardAccess = { side: 'RIGHT', via: 'DRIVE', offsetM: 24, slots: 0, trailerStalls: 0 };
/** 专用后勤通道宽 9 米（一进一出两条 4.5 米的车道） */
export const DRIVE_W = 9;
/** 后勤通道接主路的喇叭口：两边路缘的圆弧半径（米） */
export const DRIVE_FLARE = 15;
/** 停车场出入口：宽 8.6 米（一进一出，中间隔离岛），喇叭口路缘半径 6 米 */
export const LOT_GATE_W = 8.6;
export const LOT_FLARE = 6;

export const SITE_LAYOUT_LABEL: Record<SiteLayoutKind, string> = trRecord({
  auto: '随机',
  standard: '临主路',
  corner: '街角地块',
  strip: '商业街（连着小店）',
});

export const ROAD_STYLE_LABEL: Record<RoadStyle, string> = trRecord({
  suburban: '郊区社区',
  urban: '城市街区',
  arterial: '城郊干道',
});

/** 轴对齐矩形（中心 + 尺寸，w 沿 X，d 沿 Z） */
export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface Marking extends Rect {
  color: 'white' | 'yellow';
}

export interface LaneDef {
  pts: [Pt, Pt];
  len: number;
  dir: Pt;
  speed: number;
  /** 车流基准到达率（辆/秒，拥堵指数为 1 时） */
  rate: number;
  /** 停止线：信号灯路口（signal 是信号灯下标）；gate = 'rail' 是铁路道口、'school' 是学校护导员的人行横道（signal 为 −1） */
  stops: Array<{ d: number; signal: number; group: 0 | 1; gate?: 'rail' | 'school' }>;
  kind: 'main' | 'side';
  /** 限速路段（施工）：[起点, 终点, 限速] */
  zones?: Array<{ d0: number; d1: number; vmax: number }>;
}

/** 路口转弯：从某车道的 atD 处转出，沿弧线进入目标车道的 toD 处；左转走保护相位（左转箭头） */
export interface TurnDef {
  from: number;
  to: number;
  atD: number;
  toD: number;
  pts: Pt[];
  len: number;
  share: number;
  kind: 'right' | 'left';
  /** 所在路口的信号灯 */
  signal: number;
}

/** 路口：支路中心线 x、支路半宽、信号灯下标（行人网络用） */
export interface Intersection {
  x: number;
  half: number;
  signal: number;
}

/** 相位组：0 主路直行与右转，1 支路，2 主路左转保护箭头 */
export type SignalGroup = 0 | 1 | 2;

export interface SignalDef {
  x: number;
  z: number;
  cycle: number;
  /** 主路左转保护箭头的绿灯时长（0 表示没有左转相位） */
  leftGreen: number;
  mainGreen: number;
  sideGreen: number;
  yellow: number;
  offset: number;
  /** 信号灯杆：位置、朝向（灯面朝向来车）、控制的相位组 */
  heads: Array<{ x: number; z: number; facing: number; group: SignalGroup }>;
}

export interface Building extends Rect {
  h: number;
  color: string;
  roof: 'flat' | 'gable';
  /** 屋脊方向：true 沿 X */
  ridgeX: boolean;
}

export interface Tree {
  x: number;
  z: number;
  s: number;
  kind: 'round' | 'cone';
}

export interface SiteLayout {
  style: RoadStyle;
  ground: Rect & { color: string };
  asphalt: Rect[];
  sidewalks: Rect[];
  grass: Rect[];
  markings: Marking[];
  lanes: LaneDef[];
  signals: SignalDef[];
  buildings: Building[];
  /** 加油站雨棚等低矮构筑物 */
  canopies: Array<Rect & { h: number }>;
  trees: Tree[];
  lamps: Pt[];
  road: RoadAccess;
  /** 门店背后的卸货区（卸货场的范围） */
  dock: Rect;
  /** 卸货场：单向绕行的车道、待命车位（决策记录 0018） */
  yard: YardPlan;
  roadTopZ: number;
  roadBottomZ: number;
  turns: TurnDef[];
  intersections: Intersection[];
  layout: Exclude<SiteLayoutKind, 'auto'>;
  /** 公园水池 */
  ponds: Array<{ x: number; z: number; rx: number; rz: number }>;
  /** 施工路段：锥桶位置与施工牌 */
  works?: { cones: Pt[]; sign: Pt; x0: number; x1: number };
  /** 水系：湖、跌水堰、渠道与河、石拱桥、栈桥码头、出海水道与海湾 */
  water: WaterPlan;
  /** 不是矩形的路面（出入口的喇叭口，决策记录 0019），逆时针多边形 */
  asphaltPolys: Pt[][];
  /** 出入口跨过人行道的那一段（水泥铺装，和路面齐平） */
  aprons: Rect[];
  /** 停车场出入口中间的隔离岛 */
  medians: Rect[];
  /** 出入口的导向箭头（rotY：箭头所指的方向） */
  driveArrows: Array<{ x: number; z: number; rotY: number }>;
  /** 路边线在这些 x 范围断开（路口、出入口的喇叭口） */
  edgeGaps: Array<[number, number]>;
  /** 卸货场的进场道路（后勤通道或支路）与入口标志的位置 */
  access: { side: 'RIGHT' | 'LEFT'; via: 'DRIVE' | 'STREET'; x: number; half: number; sign: Pt };
  /** 铁路（决策记录 0019）：沿 Z 方向穿过场地，在主路上有一个道口 */
  railway?: { x: number; z0: number; z1: number; roadZ0: number; roadZ1: number };
  /** 学校（决策记录 0019）：主路对面的校园（教学楼、操场、旗杆），门前人行横道有护导员 */
  school?: { x: number; z: number; w: number; d: number; field: Rect; flag: Pt; sign: Pt; crossX: number };
}

const LW = 3.4;

interface StyleParams {
  lanesPerDir: number;
  /** 主路左转保护箭头（秒） */
  leftGreen: number;
  median: number;
  speed: number;
  sideLanesPerDir: number;
  sideSpeed: number;
  ground: string;
  mainGreen: number;
  sideGreen: number;
  yellow: number;
  mainRate: number;
  sideRate: number;
}

const STYLE: Record<RoadStyle, StyleParams> = {
  suburban: { leftGreen: 7, lanesPerDir: 1, median: 0, speed: 12, sideLanesPerDir: 1, sideSpeed: 10, ground: '#d3e2bb', mainGreen: 28, sideGreen: 15, yellow: 3, mainRate: 0.16, sideRate: 0.06 },
  urban: { leftGreen: 8, lanesPerDir: 2, median: 0, speed: 11, sideLanesPerDir: 1, sideSpeed: 9, ground: '#dedcd5', mainGreen: 31, sideGreen: 21, yellow: 3, mainRate: 0.15, sideRate: 0.09 },
  arterial: { leftGreen: 10, lanesPerDir: 3, median: 3, speed: 16, sideLanesPerDir: 2, sideSpeed: 12, ground: '#dde3c4', mainGreen: 47, sideGreen: 23, yellow: 4, mainRate: 0.17, sideRate: 0.08 },
};

const STYLE_SEED: Record<RoadStyle, number> = { suburban: 11, urban: 23, arterial: 37 };

const HOUSE_COLORS = ['#efe6d6', '#e3d5c0', '#d9e1e6', '#f1e3c8', '#dfe7d6', '#e8d3cc', '#cfd8dc'];
const ROOF_COLORS = ['#8c6f5e', '#6f7a83', '#9a5f4f', '#5f6b5c', '#7d6a5a'];
const BLOCK_COLORS = ['#cfd6dd', '#bfc8cf', '#e2dccf', '#d6cbbf', '#c9cfc3', '#dad3c8', '#b9c2c9', '#e5e1d8'];
const SHOP_COLORS = ['#e8e1d3', '#d8dde1', '#e6d8c3', '#d4dbcf', '#efe9df'];

function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 && Math.abs(a.z - b.z) * 2 < a.d + b.d + gap * 2;
}

function rectFrom(x0: number, z0: number, x1: number, z1: number): Rect {
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: Math.abs(x1 - x0), d: Math.abs(z1 - z0) };
}

export interface SiteInput {
  lot: LotLayout;
  /** 门店外轮廓（首层） */
  store: { minX: number; maxX: number; minZ: number; maxZ: number };
  settings: SiteSettings;
  /** 卸货场的进场设置与卸货门的位置（不给时用缺省值：右侧专用后勤通道） */
  access?: YardAccess;
  doorXs?: number[];
}

/** 喇叭口：路缘圆弧（半径 r）和两条直边围成的那一小块路面；corner 是两条边的交点，ux/uz 指向两条边各自离开拐角的方向 */
function flare(corner: Pt, ux: Pt, uz: Pt, r: number, steps = 10): Pt[] {
  // 圆心在两条边外侧 r 处：corner + (ux + uz) * r
  const cx = corner.x + (ux.x + uz.x) * r;
  const cz = corner.z + (ux.z + uz.z) * r;
  const a0 = Math.atan2(-uz.z, -uz.x);
  const a1 = Math.atan2(-ux.z, -ux.x);
  let da = a1 - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const pts: Pt[] = [{ ...corner }];
  for (let k = 0; k <= steps; k++) pts.push({ x: cx + r * Math.cos(a0 + (da * k) / steps), z: cz + r * Math.sin(a0 + (da * k) / steps) });
  // 逆时针
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as Pt;
    const b = pts[(i + 1) % pts.length] as Pt;
    area += a.x * b.z - b.x * a.z;
  }
  return area < 0 ? pts.reverse() : pts;
}

export function generateSite({ lot, store, settings, access: acc = DEFAULT_ACCESS, doorXs }: SiteInput): SiteLayout {
  const P = STYLE[settings.style];
  const rng: Rng = createRng(settings.seed * 7919 + STYLE_SEED[settings.style]);
  const hasWater = (settings.water ?? 'lake') !== 'none';

  // 主路：在停车场外侧，平行于门店正面
  const roadTopZ = lot.edgeZ - 3 - 2.4;
  const roadW = 2 * P.lanesPerDir * LW + P.median;
  const roadBottomZ = roadTopZ - roadW;
  // 场地只到周边一圈（决策记录 0019）：左右各 110 米；路对面有湖时到出海口外的海湾，没有水面时 100 米
  const minX = lot.minX - 110;
  const maxX = lot.maxX + 110;
  let minZ = roadBottomZ - (hasWater ? 115 : 100);

  const asphalt: Rect[] = [];
  const asphaltPolys: Pt[][] = [];
  const aprons: Rect[] = [];
  const medians: Rect[] = [];
  const driveArrows: SiteLayout['driveArrows'] = [];
  const sidewalks: Rect[] = [];
  const grass: Rect[] = [];
  const markings: Marking[] = [];
  const lanes: LaneDef[] = [];
  const signals: SignalDef[] = [];
  const keepOut: Rect[] = [];
  const intersections: Intersection[] = [];

  // 地块类型：自动时按种子随机
  const layoutRng = createRng(settings.seed * 131 + 7);
  const layout: Exclude<SiteLayoutKind, 'auto'> =
    !settings.layout || settings.layout === 'auto' ? (layoutRng.pick(['standard', 'standard', 'corner', 'strip']) as Exclude<SiteLayoutKind, 'auto'>) : settings.layout;

  // 卸货场的进场道路（决策记录 0019）：门店右侧或左侧，专用后勤通道（接主路）或侧面的支路（经信号灯路口）
  const sideW = 2 * P.sideLanesPerDir * LW + (settings.style === 'urban' ? 2.4 : 0);
  const right = acc.side === 'RIGHT';
  const street = acc.via === 'STREET' || (layout === 'corner' && !right);
  const off = Math.max(0, acc.offsetM);
  let driveX: number;
  let driveHalf: number;
  if (street) {
    driveHalf = sideW / 2;
    driveX = right ? lot.maxX + off + 2.4 + driveHalf : layout === 'corner' ? lot.minX - 6 - driveHalf - 2.4 : lot.minX - off - 2.4 - driveHalf;
  } else {
    driveHalf = DRIVE_W / 2;
    driveX = right ? lot.maxX + off + driveHalf : lot.minX - off - driveHalf;
  }
  // 进场道路的外沿（含人行道）：右侧进场时它右边的支路、河要让开；左侧进场时左边的支路要让开
  const accessX0 = driveX - driveHalf - (street ? 2.4 : 0);
  const accessX1 = driveX + driveHalf + (street ? 2.4 : 0);
  // 上行（进场）、下行（驶离）车道：多车道的支路上，右侧进场的车靠路边（右转进场），左侧进场的车靠中线（左转进场）
  const nSide = street ? P.sideLanesPerDir : 1;
  const laneOff = street ? LW : DRIVE_W / 4;
  const xIn = driveX - (right ? nSide - 0.5 : 0.5) * laneOff * (street ? 1 : 2);
  const xOut = driveX + (right ? 0.5 : nSide - 0.5) * laneOff * (street ? 1 : 2);

  // 支路位置：避开停车场、门店和卸货场的进场道路
  const xs: number[] = [];
  const nearAccess = (x: number) => x + sideW / 2 + 2.4 + 30 > accessX0 && x - sideW / 2 - 2.4 - 30 < accessX1;
  if (settings.style === 'urban') {
    for (let k = 0; k < 2; k++) {
      xs.push(lot.minX - 22 - k * rng.uniform(62, 78));
      xs.push(lot.maxX + 29 + k * rng.uniform(62, 78));
    }
  } else if (settings.style === 'suburban') {
    const count = rng.chance(0.6) ? 2 : 1;
    if (count === 2 || rng.chance(0.5)) xs.push(lot.minX - rng.uniform(28, 55));
    if (count === 2 || xs.length === 0) xs.push(lot.maxX + 7 + rng.uniform(28, 60));
  } else {
    xs.push(rng.chance(0.5) ? lot.minX - rng.uniform(45, 70) : lot.maxX + 7 + rng.uniform(45, 75));
  }
  // 街角地块：门店左侧紧挨着一条支路（替换掉太近的支路）
  if (layout === 'corner') {
    const cx = lot.minX - 6 - sideW / 2 - 2.4;
    for (let i = xs.length - 1; i >= 0; i--) if (Math.abs((xs[i] as number) - cx) < sideW + 30) xs.splice(i, 1);
    xs.push(cx);
  }
  // 卸货场在左侧：进场道路和门店之间不能有别的支路（卸货场从进场道路一直铺到门店背后）；
  // 右侧进场时右边的支路也要让开进场道路
  for (let i = xs.length - 1; i >= 0; i--) {
    const x = xs[i] as number;
    if (street && Math.abs(x - driveX) < 0.01) continue;
    if (nearAccess(x) || (!right && x > accessX0 - 30 && x < lot.minX)) xs.splice(i, 1);
  }
  if (street && !xs.some((x) => Math.abs(x - driveX) < 0.01)) xs.push(driveX);
  // 商业街：左侧留出连排小店的位置（左侧进场时小店排在进场道路左边）
  const stripStart = right ? lot.minX - 4.5 : accessX0 - 4;
  if (layout === 'strip') {
    for (let i = xs.length - 1; i >= 0; i--) if ((xs[i] as number) > stripStart - 85 - sideW && (xs[i] as number) < lot.minX && !(street && Math.abs((xs[i] as number) - driveX) < 0.01)) xs.splice(i, 1);
    if (!xs.some((x) => x < Math.min(lot.minX, accessX0))) xs.push(stripStart - 90 - sideW);
  }
  // 铁路：在场地左边沿 Z 方向穿过，离场地边缘 24 米；附近的支路让开
  const railX = settings.railway ? minX + 24 : undefined;
  if (railX !== undefined) for (let i = xs.length - 1; i >= 0; i--) if (Math.abs((xs[i] as number) - railX) < 28 && !(street && Math.abs((xs[i] as number) - driveX) < 0.01)) xs.splice(i, 1);
  xs.sort((a, b) => a - b);

  // 卸货场：右侧进场时西边不越过左侧支路（含人行道）；左侧进场时东边先留宽一些，河再让开它
  const westRoads = xs.filter((x) => x < lot.minX).map((x) => x + sideW / 2 + 2.4 + 1.5);
  const yard = planYard({
    side: acc.side,
    via: street ? 'STREET' : 'DRIVE',
    driveX,
    driveHalf,
    xIn,
    xOut,
    wall: store.maxZ,
    farLimit: right ? Math.max(minX + 10, ...westRoads) : store.maxX + 60,
    doorXs: doorXs ?? [store.maxX - 3],
    slots: acc.slots,
    trailerStalls: acc.trailerStalls,
  });
  // 门店背后留出卸货场（排队、绕行、倒车靠台、甩挂车位）
  const maxZ = Math.max(store.maxZ + 90, yard.z1 + 10);
  const serviceX1 = right ? accessX1 : Math.max(lot.maxX + 1, yard.x1 + 3);

  // 水系：湖在主路对面、门店右前方，有一条出海水道通到场地前沿的海湾；河从后面流过来，经石拱桥下面、跌水堰流进湖里
  const water = planWater({
    lot,
    store,
    roadTopZ,
    roadBottomZ,
    minX,
    maxX,
    minZ,
    maxZ,
    serviceX1,
    leftRoads: xs.filter((x) => x < lot.maxX).map((x) => ({ x, half: sideW / 2 })),
    seed: settings.seed,
    enabled: hasWater,
  });
  if (water.outlet) minZ = water.minZ;
  {
    const rightRoads = xs.filter((x) => x > lot.maxX && !(street && right && Math.abs(x - driveX) < 0.01)).sort((a, b) => a - b);
    const kept = xs.filter((x) => x <= lot.maxX || (street && right && Math.abs(x - driveX) < 0.01));
    let minNext = water.rightClear + 2 + sideW / 2 + 2.4;
    for (const x0 of rightRoads) {
      const x = Math.max(x0, minNext);
      if (x + sideW / 2 + 2.4 > maxX - 20) continue;
      kept.push(x);
      minNext = x + 45;
    }
    xs.length = 0;
    xs.push(...kept.sort((a, b) => a - b));
  }

  asphalt.push(rectFrom(minX, roadBottomZ, maxX, roadTopZ));
  if (P.median > 0) grass.push(rectFrom(minX, roadTopZ - P.lanesPerDir * LW - P.median, maxX, roadTopZ - P.lanesPerDir * LW));
  keepOut.push(rectFrom(minX, roadBottomZ - 3, maxX, roadTopZ + 3));
  // 主路两侧的人行道：在出入口处断开（出入口跨人行道的那段是和路面齐平的水泥铺装）
  const lotGates = lot.perimeterX.map((px) => [px - LOT_GATE_W / 2 - LOT_FLARE, px + LOT_GATE_W / 2 + LOT_FLARE] as [number, number]);
  const driveGate: [number, number] | undefined = street ? undefined : [driveX - driveHalf - DRIVE_FLARE, driveX + driveHalf + DRIVE_FLARE];
  const nearGaps: Array<[number, number]> = [...lotGates, ...(driveGate ? [driveGate] : [])].sort((a, b) => a[0] - b[0]);
  {
    let x0 = minX;
    for (const [a, b] of nearGaps) {
      if (a > x0) sidewalks.push(rectFrom(x0, roadTopZ, a, roadTopZ + 2.4));
      x0 = Math.max(x0, b);
    }
    if (maxX > x0) sidewalks.push(rectFrom(x0, roadTopZ, maxX, roadTopZ + 2.4));
  }
  sidewalks.push(rectFrom(minX, roadBottomZ - 2.4, maxX, roadBottomZ));

  // 卸货场沿支路的那一边：人行道在卸货场入口处断开（整段做成和路面齐平的车道口）
  const yardCut: [number, number] = [yard.wall + 28, yard.z1];
  xs.forEach((sx, si) => {
    const half = sideW / 2;
    asphalt.push(rectFrom(sx - half, minZ, sx + half, roadBottomZ));
    asphalt.push(rectFrom(sx - half, roadTopZ, sx + half, maxZ));
    sidewalks.push(rectFrom(sx - half - 2.4, minZ, sx - half, roadBottomZ - 2.4));
    sidewalks.push(rectFrom(sx + half, minZ, sx + half + 2.4, roadBottomZ - 2.4));
    const isAccess = street && Math.abs(sx - driveX) < 0.01;
    for (const side of [-1, 1] as const) {
      const x0 = side < 0 ? sx - half - 2.4 : sx + half;
      const cut = isAccess && (right ? side < 0 : side > 0);
      if (cut) {
        sidewalks.push(rectFrom(x0, roadTopZ + 2.4, x0 + 2.4, yardCut[0]));
        if (maxZ > yardCut[1]) sidewalks.push(rectFrom(x0, yardCut[1], x0 + 2.4, maxZ));
        aprons.push(rectFrom(x0, yardCut[0], x0 + 2.4, yardCut[1]));
      } else sidewalks.push(rectFrom(x0, roadTopZ + 2.4, x0 + 2.4, maxZ));
    }
    keepOut.push(rectFrom(sx - half - 3, minZ, sx + half + 3, maxZ));

    // 中心双黄线与停止线、人行横道
    markings.push({ ...rectFrom(sx - 0.25, minZ, sx - 0.1, roadBottomZ - 4), color: 'yellow' });
    markings.push({ ...rectFrom(sx + 0.1, minZ, sx + 0.25, roadBottomZ - 4), color: 'yellow' });
    markings.push({ ...rectFrom(sx - 0.25, roadTopZ + 4, sx - 0.1, maxZ), color: 'yellow' });
    markings.push({ ...rectFrom(sx + 0.1, roadTopZ + 4, sx + 0.25, maxZ), color: 'yellow' });
    for (let k = 0; k < Math.floor(roadW / 1.2); k++) {
      const z = roadBottomZ + 0.6 + k * 1.2;
      markings.push({ x: sx - half - 2, z, w: 2.6, d: 0.55, color: 'white' });
      markings.push({ x: sx + half + 2, z, w: 2.6, d: 0.55, color: 'white' });
    }
    for (let k = 0; k < Math.floor(sideW / 1.2); k++) {
      const x = sx - half + 0.6 + k * 1.2;
      markings.push({ x, z: roadBottomZ - 2, w: 0.55, d: 2.6, color: 'white' });
      markings.push({ x, z: roadTopZ + 2, w: 0.55, d: 2.6, color: 'white' });
    }

    const signal: SignalDef = {
      x: sx,
      z: (roadTopZ + roadBottomZ) / 2,
      cycle: P.leftGreen + P.mainGreen + P.sideGreen + 3 * P.yellow + 3,
      leftGreen: P.leftGreen,
      mainGreen: P.mainGreen,
      sideGreen: P.sideGreen,
      yellow: P.yellow,
      offset: rng.uniform(0, 60),
      heads: [
        { x: sx - half - 1.2, z: roadTopZ + 1.2, facing: -Math.PI / 2, group: 0 },
        { x: sx + half + 1.2, z: roadBottomZ - 1.2, facing: Math.PI / 2, group: 0 },
        { x: sx + half + 1.2, z: roadTopZ + 1.2, facing: Math.PI, group: 1 },
        { x: sx - half - 1.2, z: roadBottomZ - 1.2, facing: 0, group: 1 },
        // 左转箭头灯：挂在主路灯头旁边
        { x: sx - half - 1.2, z: roadTopZ + 1.8, facing: -Math.PI / 2, group: 2 },
        { x: sx + half + 1.2, z: roadBottomZ - 1.8, facing: Math.PI / 2, group: 2 },
      ],
    };
    signals.push(signal);
    intersections.push({ x: sx, half, signal: si });

    // 支路车道：+Z 方向行驶时右侧是 −X
    for (let j = 0; j < P.sideLanesPerDir; j++) {
      const xn = sx - (j + 0.5) * LW;
      const xsb = sx + (j + 0.5) * LW;
      lanes.push({ pts: [{ x: xn, z: minZ }, { x: xn, z: maxZ }], len: maxZ - minZ, dir: { x: 0, z: 1 }, speed: P.sideSpeed, rate: P.sideRate, stops: [{ d: roadBottomZ - 3.6 - minZ, signal: si, group: 1 }], kind: 'side' });
      lanes.push({ pts: [{ x: xsb, z: maxZ }, { x: xsb, z: minZ }], len: maxZ - minZ, dir: { x: 0, z: -1 }, speed: P.sideSpeed, rate: P.sideRate, stops: [{ d: maxZ - (roadTopZ + 3.6), signal: si, group: 1 }], kind: 'side' });
    }
  });

  // 主路车道：+X 方向行驶时右侧是 +Z（靠门店一侧）
  for (let i = 0; i < P.lanesPerDir; i++) {
    const zE = roadTopZ - (i + 0.5) * LW;
    const zW = roadBottomZ + (i + 0.5) * LW;
    lanes.push({
      pts: [{ x: minX, z: zE }, { x: maxX, z: zE }],
      len: maxX - minX,
      dir: { x: 1, z: 0 },
      speed: P.speed,
      rate: P.mainRate,
      stops: [...xs.map((sx, si) => ({ d: sx - sideW / 2 - 3.6 - minX, signal: si, group: 0 as const })), ...(railX !== undefined ? [{ d: railX - 7 - minX, signal: -1, group: 0 as const, gate: 'rail' as const }] : [])].sort((a, b) => a.d - b.d),
      kind: 'main',
    });
    lanes.push({
      pts: [{ x: maxX, z: zW }, { x: minX, z: zW }],
      len: maxX - minX,
      dir: { x: -1, z: 0 },
      speed: P.speed,
      rate: P.mainRate,
      stops: [...xs.map((sx, si) => ({ d: maxX - (sx + sideW / 2 + 3.6), signal: si, group: 0 as const })), ...(railX !== undefined ? [{ d: maxX - (railX + 7), signal: -1, group: 0 as const, gate: 'rail' as const }] : [])].sort((a, b) => a.d - b.d),
      kind: 'main',
    });
  }

  // 路口右转：主路最外侧车道 ↔ 支路
  const turns: TurnDef[] = [];
  const laneAt = (pred: (l: LaneDef) => boolean) => lanes.findIndex(pred);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const zE = roadTopZ - 0.5 * LW;
  const zW = roadBottomZ + 0.5 * LW;
  const arc = (a: Pt, c: Pt, b: Pt): { pts: Pt[]; len: number } => {
    const pts: Pt[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const u = 1 - t;
      pts.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, z: u * u * a.z + 2 * u * t * c.z + t * t * b.z });
    }
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += Math.hypot((pts[k] as Pt).x - (pts[k - 1] as Pt).x, (pts[k] as Pt).z - (pts[k - 1] as Pt).z);
    return { pts, len };
  };
  const half = sideW / 2;
  // 主路最内侧车道（左转从这里转出）
  const zEi = roadTopZ - (P.lanesPerDir - 0.5) * LW;
  const zWi = roadBottomZ + (P.lanesPerDir - 0.5) * LW;
  xs.forEach((sx, si) => {
    const east = laneAt((l) => l.kind === 'main' && l.dir.x > 0 && near(l.pts[0].z, zE));
    const west = laneAt((l) => l.kind === 'main' && l.dir.x < 0 && near(l.pts[0].z, zW));
    const eastIn = laneAt((l) => l.kind === 'main' && l.dir.x > 0 && near(l.pts[0].z, zEi));
    const westIn = laneAt((l) => l.kind === 'main' && l.dir.x < 0 && near(l.pts[0].z, zWi));
    const north = laneAt((l) => l.kind === 'side' && l.dir.z > 0 && near(l.pts[0].x, sx - 0.5 * LW));
    const south = laneAt((l) => l.kind === 'side' && l.dir.z < 0 && near(l.pts[0].x, sx + 0.5 * LW));
    if (east >= 0 && north >= 0) {
      const a = arc({ x: sx - half - 1, z: zE }, { x: sx - 0.5 * LW, z: zE }, { x: sx - 0.5 * LW, z: roadTopZ + 1 });
      turns.push({ from: east, to: north, atD: sx - half - 1 - minX, toD: roadTopZ + 1 - minZ, ...a, share: 0.12, kind: 'right', signal: si });
    }
    if (west >= 0 && south >= 0) {
      const a = arc({ x: sx + half + 1, z: zW }, { x: sx + 0.5 * LW, z: zW }, { x: sx + 0.5 * LW, z: roadBottomZ - 1 });
      turns.push({ from: west, to: south, atD: maxX - (sx + half + 1), toD: maxZ - (roadBottomZ - 1), ...a, share: 0.12, kind: 'right', signal: si });
    }
    if (north >= 0 && west >= 0) {
      const a = arc({ x: sx - 0.5 * LW, z: roadBottomZ - 1 }, { x: sx - 0.5 * LW, z: zW }, { x: sx - half - 1, z: zW });
      turns.push({ from: north, to: west, atD: roadBottomZ - 1 - minZ, toD: maxX - (sx - half - 1), ...a, share: 0.35, kind: 'right', signal: si });
    }
    if (south >= 0 && east >= 0) {
      const a = arc({ x: sx + 0.5 * LW, z: roadTopZ + 1 }, { x: sx + 0.5 * LW, z: zE }, { x: sx + half + 1, z: zE });
      turns.push({ from: south, to: east, atD: maxZ - (roadTopZ + 1), toD: sx + half + 1 - minX, ...a, share: 0.35, kind: 'right', signal: si });
    }
    // 主路左转（保护箭头相位）：东行 → 支路南向，西行 → 支路北向；单车道的路上左转车会挡住后面的直行车
    const leftShare = P.lanesPerDir > 1 ? 0.1 : 0.05;
    if (P.leftGreen > 0 && eastIn >= 0 && south >= 0) {
      const a = arc({ x: sx - half - 1, z: zEi }, { x: sx + 0.5 * LW, z: zEi }, { x: sx + 0.5 * LW, z: roadBottomZ - 1 });
      turns.push({ from: eastIn, to: south, atD: sx - half - 1 - minX, toD: maxZ - (roadBottomZ - 1), ...a, share: leftShare, kind: 'left', signal: si });
    }
    if (P.leftGreen > 0 && westIn >= 0 && north >= 0) {
      const a = arc({ x: sx + half + 1, z: zWi }, { x: sx - 0.5 * LW, z: zWi }, { x: sx - 0.5 * LW, z: roadTopZ + 1 });
      turns.push({ from: westIn, to: north, atD: maxX - (sx + half + 1), toD: roadTopZ + 1 - minZ, ...a, share: leftShare, kind: 'left', signal: si });
    }
  });

  // 施工：主路一段限速 4 m/s，最外侧摆锥桶（避开路口和停车场出入口）
  let works: SiteLayout['works'];
  if (settings.roadWorks) {
    const wr = createRng(settings.seed * 977 + 3);
    for (let k = 0; k < 30 && !works; k++) {
      const x0 = wr.uniform(minX + 20, maxX - 60);
      const x1 = x0 + 40;
      if (xs.some((sx) => sx + half + 8 > x0 && sx - half - 8 < x1) || lot.perimeterX.some((px) => px + 8 > x0 && px - 8 < x1)) continue;
      const cones: Pt[] = [];
      for (let x = x0; x <= x1; x += 3) cones.push({ x, z: roadBottomZ + LW * 0.95 });
      works = { cones, sign: { x: x0 - 6, z: roadBottomZ - 1.2 }, x0, x1 };
      for (const l of lanes) {
        if (l.kind !== 'main') continue;
        const d0 = l.dir.x > 0 ? x0 - minX : maxX - x1;
        (l.zones ??= []).push({ d0: d0 - 10, d1: d0 + 50, vmax: 4 });
      }
    }
  }

  // 主路标线：中心双黄线（无中央绿化带时）和同向车道之间的白色虚线，路口处断开
  const gaps = xs.map((sx) => [sx - half - 4, sx + half + 4] as const);
  const centerZ = roadTopZ - P.lanesPerDir * LW;
  const dashed = (z: number) => {
    for (let x = minX; x < maxX; x += 9) {
      if (gaps.some(([a, b]) => x + 4 > a && x < b)) continue;
      markings.push({ x: x + 2, z, w: 4, d: 0.14, color: 'white' });
    }
  };
  const solid = (z: number, color: Marking['color']) => {
    let x0 = minX;
    for (const [a, b] of [...gaps, [maxX, maxX] as const]) {
      if (a > x0) markings.push({ ...rectFrom(x0, z - 0.07, a, z + 0.07), color });
      x0 = b;
    }
  };
  if (P.median === 0) {
    solid(centerZ + 0.15, 'yellow');
    solid(centerZ - 0.15, 'yellow');
  }
  for (let i = 1; i < P.lanesPerDir; i++) {
    dashed(roadTopZ - i * LW);
    dashed(roadBottomZ + i * LW);
  }

  // 停车场与门店的禁建区；停车场出入口（决策记录 0019）：一进一出两条车道，中间一道隔离岛，接主路处是喇叭口
  keepOut.push(rectFrom(lot.minX - 4, lot.edgeZ - 4, lot.maxX + 4, store.maxZ + 4));
  const sw = roadTopZ + 2.4;
  for (const px of lot.perimeterX) {
    const g0 = px - LOT_GATE_W / 2;
    const g1 = px + LOT_GATE_W / 2;
    asphalt.push(rectFrom(g0, sw, g1, lot.edgeZ));
    aprons.push(rectFrom(g0 - LOT_FLARE, roadTopZ, g1 + LOT_FLARE, sw));
    asphaltPolys.push(flare({ x: g0, z: sw }, { x: -1, z: 0 }, { x: 0, z: 1 }, LOT_FLARE));
    asphaltPolys.push(flare({ x: g1, z: sw }, { x: 1, z: 0 }, { x: 0, z: 1 }, LOT_FLARE));
    medians.push(rectFrom(px - MEDIAN_W / 2, roadTopZ + 1.2, px + MEDIAN_W / 2, lot.edgeZ - 0.4));
    // 进口箭头朝里（+Z）、出口箭头朝外，出口车道在人行道前有停车线
    driveArrows.push({ x: px - LANE_OFF - 0.2, z: (sw + lot.edgeZ) / 2 + 0.6, rotY: 0 });
    driveArrows.push({ x: px + LANE_OFF + 0.2, z: (sw + lot.edgeZ) / 2 + 0.6, rotY: Math.PI });
    markings.push({ ...rectFrom(px + MEDIAN_W / 2 + 0.1, sw + 0.35, g1 - 0.2, sw + 0.8), color: 'white' });
  }
  // 卸货场的进场道路：专用后勤通道从主路一直通到卸货场顶部（接主路处是半径 15 米的喇叭口，半挂车不用直角转弯）；
  // 支路的话路面已经有了
  if (!street) {
    const d0 = driveX - driveHalf;
    const d1 = driveX + driveHalf;
    asphalt.push(rectFrom(d0, sw, d1, yard.z1));
    aprons.push(rectFrom(d0 - DRIVE_FLARE, roadTopZ, d1 + DRIVE_FLARE, sw));
    asphaltPolys.push(flare({ x: d0, z: sw }, { x: -1, z: 0 }, { x: 0, z: 1 }, DRIVE_FLARE, 14));
    asphaltPolys.push(flare({ x: d1, z: sw }, { x: 1, z: 0 }, { x: 0, z: 1 }, DRIVE_FLARE, 14));
    // 中心双黄线（进场道路的一进一出），出口停车线
    markings.push({ ...rectFrom(driveX - 0.2, sw + 2, driveX - 0.08, store.maxZ), color: 'yellow' });
    markings.push({ ...rectFrom(driveX + 0.08, sw + 2, driveX + 0.2, store.maxZ), color: 'yellow' });
    markings.push({ ...rectFrom(driveX + 0.3, sw + 0.35, d1 - 0.3, sw + 0.8), color: 'white' });
    driveArrows.push({ x: xIn, z: sw + 9, rotY: 0 });
    driveArrows.push({ x: xOut, z: sw + 9, rotY: Math.PI });
    keepOut.push(rectFrom(d0 - 3, roadTopZ, d1 + 3, yard.z1 + 3));
  }
  // 卸货场的场地：从进场道路铺到门店背后（盖住所有卸货门前的场地）
  const dockX0 = Math.min(yard.x0, store.minX - 4);
  const dockX1 = Math.max(yard.x1, store.maxX + 4);
  const dock = rectFrom(right ? dockX0 : yard.x0, store.maxZ, right ? yard.x1 : dockX1, yard.z1);
  asphalt.push(dock);
  keepOut.push(rectFrom(dock.x - dock.w / 2 - 3, store.maxZ, dock.x + dock.w / 2 + 3, yard.z1 + 3));
  // 标线：待命车道两侧的白线、车位分隔线；靠台车道外侧的黄色禁停线（倒车区）；甩挂车位的白线
  const qz = yard.zQueue;
  const qx0 = yard.xHead - 2;
  const qx1 = right ? yard.xIn - 14 : yard.xEast;
  markings.push({ ...rectFrom(qx0, qz - 2.15, qx1, qz - 2.0), color: 'white' });
  markings.push({ ...rectFrom(qx0, qz + 2.0, qx1, qz + 2.15), color: 'white' });
  for (let j = 0; j <= yard.slots; j++) {
    const x = Math.min(qx1, yard.xHead - 1.5 + j * yard.pitch);
    markings.push({ ...rectFrom(x - 0.08, qz - 2.0, x + 0.08, qz + 2.0), color: 'white' });
  }
  const docks = doorXs ?? [store.maxX - 3];
  markings.push({ ...rectFrom(Math.min(...docks) - 20, store.maxZ + 23.4, Math.max(...docks) + 20, store.maxZ + 23.55), color: 'yellow' });
  // 卸货门前 18 米的水泥地坪（挂车支腿、倒车停靠的地方）
  aprons.push(rectFrom(Math.min(...docks) - 9, store.maxZ, Math.max(...docks) + 9, store.maxZ + 18));
  // 车道之间的白色虚线和行车方向箭头（靠台车道、顶部车道向 +X，驶离车道、待命车道向 −X）
  const lx0 = yard.xTurnDock;
  const lx1 = right ? yard.xIn - 15 : yard.xEast;
  for (const z of [(yard.zCourt + yard.zExit) / 2 + 2, (yard.zQueue + yard.zTop) / 2]) {
    for (let x = lx0 + 2; x < lx1 - 3; x += 6) markings.push({ ...rectFrom(x, z - 0.07, x + 3, z + 0.07), color: 'white' });
  }
  for (const [z, dir] of [
    [yard.zCourt, 1],
    [yard.zExit, -1],
    [yard.zTop, 1],
  ] as const) {
    for (let k = 1; k <= 3; k++) {
      const x = lx0 + ((lx1 - lx0) * k) / 4;
      driveArrows.push({ x, z, rotY: dir > 0 ? Math.PI / 2 : -Math.PI / 2 });
    }
  }
  for (let k = 0; k <= yard.stalls.length; k++) {
    const first = yard.stalls[0];
    if (!first) break;
    const x = first.x - 1.9 + k * 3.8;
    markings.push({ ...rectFrom(x - 0.07, first.z - 8.5, x + 0.07, first.z + 8.5), color: 'white' });
  }
  // 停车场外侧绿化带：在出入口（含喇叭口）处断开
  {
    let x0 = lot.minX;
    for (const [a, b] of [...lotGates].sort((p, q) => p[0] - q[0])) {
      if (a > x0) grass.push(rectFrom(x0, roadTopZ + 2.4, Math.min(a, lot.maxX), lot.edgeZ));
      x0 = Math.max(x0, b);
    }
    if (lot.maxX > x0) grass.push(rectFrom(x0, roadTopZ + 2.4, lot.maxX, lot.edgeZ));
  }
  keepOut.push(...water.keepOut);
  // 路边线在路口和出入口断开
  const edgeGaps: Array<[number, number]> = nearGaps.map(([a, b]) => [a + 0.5, b - 0.5]);

  // 铁路的路基两侧不放建筑和树
  if (railX !== undefined) keepOut.push(rectFrom(railX - 7, minZ, railX + 7, maxZ));

  // 学校：主路对面一块 64 × 46 米的校园（前面是教学楼，后面是操场），从停车场正对面往两边找空地
  let school: SiteLayout['school'];
  if (settings.school) {
    const W = 64;
    const D = 46;
    const zc = roadBottomZ - 2.4 - 7 - D / 2;
    const cx0 = (lot.minX + lot.maxX) / 2;
    for (let k = 0; k < 40 && !school; k++) {
      const x = cx0 + (k % 2 === 0 ? -1 : 1) * Math.ceil(k / 2) * 9;
      const r: Rect = { x, z: zc, w: W, d: D };
      if (r.x - W / 2 < minX + 4 || r.x + W / 2 > maxX - 4 || r.z - D / 2 < minZ + 4) continue;
      if (keepOut.some((q) => overlaps(r, q, 2)) || xs.some((sx) => Math.abs(sx - x) < W / 2 + sideW / 2 + 4)) continue;
      const field: Rect = { x, z: zc - D / 2 + 13, w: W - 6, d: 22 };
      school = { x, z: zc, w: W, d: D, field, flag: { x: x - 14, z: zc + D / 2 - 3 }, sign: { x: x + 18, z: zc + D / 2 - 1.2 }, crossX: x };
      keepOut.push(r);
      grass.push(field);
    }
    if (school) {
      // 门前的人行横道（斑马线）和护导员拦车的停止线
      const cx = school.crossX;
      for (let k = 0; k < Math.floor(roadW / 1.2); k++) markings.push({ x: cx, z: roadBottomZ + 0.6 + k * 1.2, w: 3.2, d: 0.55, color: 'white' });
      for (const l of lanes) {
        if (l.kind !== 'main') continue;
        const d = l.dir.x > 0 ? cx - 3.5 - minX : maxX - (cx + 3.5);
        l.stops.push({ d, signal: -1, group: 0, gate: 'school' });
        l.stops.sort((a, b) => a.d - b.d);
      }
    }
  }

  // ---------- 建筑：沿道路两侧按风格排布 ----------
  const buildings: Building[] = [];
  const canopies: SiteLayout['canopies'] = [];
  // 学校的教学楼：两层砖红色，平屋顶，朝向主路
  if (school) buildings.push({ x: school.x, z: school.z + school.d / 2 - 9, w: 44, d: 15, h: 8.5, color: '#c9775a', roof: 'flat', ridgeX: true });
  const trees: Tree[] = [];
  const free = (r: Rect, gap: number) => r.x - r.w / 2 > minX && r.x + r.w / 2 < maxX && r.z - r.d / 2 > minZ && r.z + r.d / 2 < maxZ && !keepOut.some((k) => overlaps(r, k, gap)) && !buildings.some((b) => overlaps(r, b, gap));

  const frontage = (axis: 'x' | 'z', line: number, from: number, to: number, side: 1 | -1) => {
    let s = from;
    while (s < to) {
      let w: number;
      let d: number;
      let h: number;
      let setback: number;
      let gap: number;
      let color: string;
      let roof: Building['roof'] = 'flat';
      if (settings.style === 'urban') {
        w = rng.uniform(14, 30);
        d = rng.uniform(14, 26);
        h = rng.uniform(9, 38);
        setback = 3.2;
        gap = rng.uniform(1, 4);
        color = rng.pick(BLOCK_COLORS);
      } else if (settings.style === 'suburban') {
        w = rng.uniform(10, 13);
        d = rng.uniform(8, 11);
        h = rng.uniform(3.2, 4);
        setback = rng.uniform(7, 10);
        gap = rng.uniform(6, 11);
        color = rng.pick(HOUSE_COLORS);
        roof = 'gable';
      } else {
        w = rng.uniform(18, 40);
        d = rng.uniform(15, 28);
        h = rng.uniform(5, 8);
        setback = rng.uniform(14, 22);
        gap = rng.uniform(10, 24);
        color = rng.pick(SHOP_COLORS);
      }
      const along = s + w / 2;
      const off = line + side * (setback + d / 2);
      const r: Building = axis === 'x' ? { x: along, z: off, w, d, h, color, roof, ridgeX: true } : { x: off, z: along, w: d, d: w, h, color, roof, ridgeX: false };
      if (free(r, 1)) {
        buildings.push(r);
        if (settings.style === 'suburban' && rng.chance(0.8)) {
          const tx = axis === 'x' ? along + rng.uniform(-w / 2, w / 2) : line + side * rng.uniform(2.5, setback - 1.5);
          const tz = axis === 'x' ? line + side * rng.uniform(2.5, setback - 1.5) : along + rng.uniform(-w / 2, w / 2);
          trees.push({ x: tx, z: tz, s: rng.uniform(0.8, 1.2), kind: rng.chance(0.3) ? 'cone' : 'round' });
        }
        if (settings.style === 'arterial') {
          // 店前的小停车场
          const pad: Rect = axis === 'x' ? { x: along, z: line + side * (setback / 2), w: w * 0.9, d: setback - 4 } : { x: line + side * (setback / 2), z: along, w: setback - 4, d: w * 0.9 };
          asphalt.push(pad);
        }
      }
      s += w + gap;
    }
  };

  // 商业街：门店左侧连着几家小店，前面有一小片停车场
  if (layout === 'strip') {
    let x1 = lot.minX - 4.5;
    const n = rng.int(3, 5);
    const SHOP = ['#e9d9c4', '#d7e2e8', '#efe1d6', '#dfe7d8', '#e6dccf', '#d9d4e6'];
    for (let k = 0; k < n; k++) {
      const w = rng.uniform(10, 15);
      const b: Building = { x: x1 - w / 2, z: 10, w, d: 20, h: rng.uniform(5.5, 7), color: rng.pick(SHOP), roof: 'flat', ridgeX: true };
      if (!free(b, 0.1)) break;
      buildings.push(b);
      x1 -= w + 0.3;
    }
    const x0 = x1;
    if (x0 < lot.minX - 10) {
      asphalt.push(rectFrom(x0, lot.edgeZ, lot.minX - 4, -0.5));
      keepOut.push(rectFrom(x0 - 2, lot.edgeZ, lot.minX, 22));
      for (let x = x0 + 2; x < lot.minX - 6; x += 2.8) markings.push({ x, z: -8, w: 0.12, d: 5, color: 'white' });
    }
  }

  const farLine = roadBottomZ - 2.4;
  const nearLine = roadTopZ + 2.4;
  frontage('x', farLine, minX + 2, maxX - 2, -1);
  frontage('x', nearLine, minX + 2, maxX - 2, 1);
  for (const sx of xs) {
    const half = sideW / 2 + 2.4;
    frontage('z', sx - half, minZ + 2, farLine - 4, -1);
    frontage('z', sx + half, minZ + 2, farLine - 4, 1);
    frontage('z', sx - half, nearLine + 4, maxZ - 2, -1);
    frontage('z', sx + half, nearLine + 4, maxZ - 2, 1);
  }
  // 城郊干道：在路对面加一座加油站
  if (settings.style === 'arterial') {
    for (let k = 0; k < 20; k++) {
      const c: Rect & { h: number } = { x: rng.uniform(minX + 30, maxX - 30), z: farLine - 14, w: 22, d: 14, h: 5 };
      if (free(c, 2)) {
        canopies.push(c);
        asphalt.push({ x: c.x, z: c.z, w: c.w + 12, d: c.d + 6 });
        buildings.push({ x: c.x, z: c.z - 15, w: 12, d: 8, h: 3.6, color: '#f2efe8', roof: 'flat', ridgeX: true });
        break;
      }
    }
  }

  // 公园：在空地上放一块草坪，中间有水池和步道
  const ponds: SiteLayout['ponds'] = [];
  if (settings.style !== 'arterial') {
    for (let k = 0; k < 40; k++) {
      const park: Rect = { x: rng.uniform(minX + 30, maxX - 30), z: rng.uniform(minZ + 25, maxZ - 25), w: rng.uniform(34, 48), d: rng.uniform(26, 36) };
      if (!free(park, 3) || asphalt.some((a) => overlaps(park, a, 3))) continue;
      grass.push(park);
      keepOut.push(park);
      ponds.push({ x: park.x + rng.uniform(-4, 4), z: park.z + rng.uniform(-3, 3), rx: park.w * 0.22, rz: park.d * 0.2 });
      sidewalks.push({ x: park.x, z: park.z - park.d * 0.38, w: park.w * 0.9, d: 1.6 });
      sidewalks.push({ x: park.x - park.w * 0.4, z: park.z, w: 1.6, d: park.d * 0.8 });
      for (let a = 0; a < 10; a++) {
        const ang = (a / 10) * Math.PI * 2;
        trees.push({ x: park.x + Math.cos(ang) * park.w * 0.42, z: park.z + Math.sin(ang) * park.d * 0.4, s: rng.uniform(0.9, 1.3), kind: a % 3 === 0 ? 'cone' : 'round' });
      }
      break;
    }
  }

  // ---------- 树木与路灯 ----------
  trees.push(...water.trees);
  for (let x = lot.minX + 4; x < lot.maxX - 4; x += 9) {
    // 出入口（含喇叭口）和立柱招牌处不种树
    if (lot.perimeterX.some((px) => Math.abs(px - x) < 11) || Math.abs(x - (lot.minX + 16)) < 2.5) continue;
    trees.push({ x, z: (roadTopZ + 2.4 + lot.edgeZ) / 2, s: rng.uniform(0.85, 1.1), kind: 'round' });
  }
  for (const isl of lot.islands) trees.push({ x: isl.x, z: isl.z, s: 0.9, kind: 'round' });
  if (settings.style === 'urban') {
    for (let x = minX + 6; x < maxX; x += 12) {
      if (gaps.some(([a, b]) => x > a - 3 && x < b + 3)) continue;
      trees.push({ x, z: farLine + 1.2, s: 0.75, kind: 'round' });
    }
  } else {
    const target = settings.style === 'suburban' ? 140 : 70;
    for (let k = 0, placed = 0; k < target * 6 && placed < target; k++) {
      const t: Tree = { x: rng.uniform(minX + 3, maxX - 3), z: rng.uniform(minZ + 3, maxZ - 3), s: rng.uniform(0.7, 1.3), kind: rng.chance(settings.style === 'suburban' ? 0.35 : 0.5) ? 'cone' : 'round' };
      const r: Rect = { x: t.x, z: t.z, w: 3, d: 3 };
      if (!free(r, 1) || asphalt.some((a) => overlaps(r, a, 1)) || trees.some((o) => Math.hypot(o.x - t.x, o.z - t.z) < 4)) continue;
      trees.push(t);
      placed++;
    }
  }

  const lamps: Pt[] = [];
  for (const isl of lot.islands) {
    lamps.push({ x: isl.x, z: isl.z - isl.d / 2 + 0.6 });
    lamps.push({ x: isl.x, z: isl.z + isl.d / 2 - 0.6 });
  }
  for (let x = minX + 15; x < maxX; x += 32) lamps.push({ x, z: roadTopZ + 0.6 });
  // 卸货场的照明：沿场地的北边和西边（车道之外）
  for (let x = yard.x0 + 6; x < yard.x1 - 10; x += 28) lamps.push({ x, z: yard.z1 - 1.2 });
  for (let z = store.maxZ + 12; z < yard.z1 - 10; z += 28) lamps.push({ x: yard.x0 + 1.2, z });

  const nearLaneZ = roadTopZ - 0.5 * LW;
  const farLaneZ = roadBottomZ + (P.lanesPerDir - 0.5) * LW;
  return {
    style: settings.style,
    ground: { ...rectFrom(minX, minZ, maxX, maxZ), color: P.ground },
    asphalt,
    sidewalks,
    grass,
    markings,
    lanes,
    signals,
    buildings,
    canopies,
    trees,
    lamps,
    // 有铁路道口时，仿真里的车辆在道口东边出现（道口的排队由背景车流表现）
    road: { nearLaneZ, farLaneZ, spawnMinX: railX !== undefined ? railX + 9 : minX + 2, spawnMaxX: maxX - 2 },
    dock,
    yard,
    roadTopZ,
    roadBottomZ,
    turns,
    intersections,
    layout,
    ponds,
    works,
    water,
    asphaltPolys,
    aprons,
    medians,
    driveArrows,
    edgeGaps,
    access: { side: acc.side, via: street ? 'STREET' : 'DRIVE', x: driveX, half: driveHalf, sign: { x: right ? accessX0 - 1.6 - (street ? 0 : DRIVE_FLARE) : accessX1 + 1.6 + (street ? 0 : DRIVE_FLARE), z: roadTopZ + 3.6 } },
    ...(railX !== undefined ? { railway: { x: railX, z0: minZ, z1: maxZ, roadZ0: roadBottomZ - 2.4, roadZ1: roadTopZ + 2.4 } } : {}),
    ...(school ? { school } : {}),
  };
}

export type Light = 'G' | 'Y' | 'R';

/**
 * 信号灯相位：主路左转箭头 → 黄 → 全红 1 秒 → 主路直行 → 黄 → 全红 → 支路 → 黄 → 全红。
 * 返回各相位组的开始时刻（相对周期起点）与绿灯时长。
 */
function phases(s: SignalDef): Array<{ group: SignalGroup; start: number; green: number }> {
  const out: Array<{ group: SignalGroup; start: number; green: number }> = [];
  let t = 0;
  if (s.leftGreen > 0) {
    out.push({ group: 2, start: t, green: s.leftGreen });
    t += s.leftGreen + s.yellow + 1;
  }
  out.push({ group: 0, start: t, green: s.mainGreen });
  t += s.mainGreen + s.yellow + 1;
  out.push({ group: 1, start: t, green: s.sideGreen });
  return out;
}

/** 信号灯在时刻 t（秒）对相位组 group 显示的灯色 */
export function signalLight(s: SignalDef, t: number, group: SignalGroup): Light {
  const tau = (((t + s.offset) % s.cycle) + s.cycle) % s.cycle;
  const ph = phases(s).find((p) => p.group === group);
  if (!ph) return 'R';
  if (tau >= ph.start && tau < ph.start + ph.green) return 'G';
  if (tau >= ph.start + ph.green && tau < ph.start + ph.green + s.yellow) return 'Y';
  return 'R';
}

/** 相位组当前绿灯还剩多少秒（不是绿灯时为 0）；行人据此判断来不来得及过马路 */
export function greenRemaining(s: SignalDef, t: number, group: SignalGroup): number {
  const tau = (((t + s.offset) % s.cycle) + s.cycle) % s.cycle;
  const ph = phases(s).find((p) => p.group === group);
  if (!ph || tau < ph.start || tau >= ph.start + ph.green) return 0;
  return ph.start + ph.green - tau;
}
