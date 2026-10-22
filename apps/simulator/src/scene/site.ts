import { createRng, type Rng } from '@storewright/domain';
import type { LotLayout, Pt, RoadAccess } from './lot';
import { trRecord } from '../i18n';

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
}

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
  stops: Array<{ d: number; signal: number; group: 0 | 1 }>;
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
  /** 门店背后的卸货区 */
  dock: Rect;
  roadTopZ: number;
  roadBottomZ: number;
  turns: TurnDef[];
  intersections: Intersection[];
  layout: Exclude<SiteLayoutKind, 'auto'>;
  /** 公园水池 */
  ponds: Array<{ x: number; z: number; rx: number; rz: number }>;
  /** 施工路段：锥桶位置与施工牌 */
  works?: { cones: Pt[]; sign: Pt; x0: number; x1: number };
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
}

export function generateSite({ lot, store, settings }: SiteInput): SiteLayout {
  const P = STYLE[settings.style];
  const rng: Rng = createRng(settings.seed * 7919 + STYLE_SEED[settings.style]);

  // 主路：在停车场外侧，平行于门店正面
  const roadTopZ = lot.edgeZ - 3 - 2.4;
  const roadW = 2 * P.lanesPerDir * LW + P.median;
  const roadBottomZ = roadTopZ - roadW;
  const minX = lot.minX - 125;
  const maxX = lot.maxX + 125;
  const minZ = roadBottomZ - 115;
  const maxZ = store.maxZ + 70;

  const asphalt: Rect[] = [];
  const sidewalks: Rect[] = [];
  const grass: Rect[] = [];
  const markings: Marking[] = [];
  const lanes: LaneDef[] = [];
  const signals: SignalDef[] = [];
  const keepOut: Rect[] = [];
  const intersections: Intersection[] = [];

  asphalt.push(rectFrom(minX, roadBottomZ, maxX, roadTopZ));
  sidewalks.push(rectFrom(minX, roadTopZ, maxX, roadTopZ + 2.4));
  sidewalks.push(rectFrom(minX, roadBottomZ - 2.4, maxX, roadBottomZ));
  keepOut.push(rectFrom(minX, roadBottomZ - 3, maxX, roadTopZ + 3));
  if (P.median > 0) grass.push(rectFrom(minX, roadTopZ - P.lanesPerDir * LW - P.median, maxX, roadTopZ - P.lanesPerDir * LW));

  // 地块类型：自动时按种子随机
  const layoutRng = createRng(settings.seed * 131 + 7);
  const layout: Exclude<SiteLayoutKind, 'auto'> =
    !settings.layout || settings.layout === 'auto' ? (layoutRng.pick(['standard', 'standard', 'corner', 'strip']) as Exclude<SiteLayoutKind, 'auto'>) : settings.layout;

  // 支路位置：避开停车场、门店和右侧后勤通道
  const serviceX0 = lot.maxX + 1;
  const serviceX1 = lot.maxX + 7;
  const sideW = 2 * P.sideLanesPerDir * LW + (settings.style === 'urban' ? 2.4 : 0);
  const xs: number[] = [];
  if (settings.style === 'urban') {
    for (let k = 0; k < 2; k++) {
      xs.push(lot.minX - 22 - k * rng.uniform(62, 78));
      xs.push(serviceX1 + 22 + k * rng.uniform(62, 78));
    }
  } else if (settings.style === 'suburban') {
    const count = rng.chance(0.6) ? 2 : 1;
    if (count === 2 || rng.chance(0.5)) xs.push(lot.minX - rng.uniform(28, 55));
    if (count === 2 || xs.length === 0) xs.push(serviceX1 + rng.uniform(28, 60));
  } else {
    xs.push(rng.chance(0.5) ? lot.minX - rng.uniform(45, 70) : serviceX1 + rng.uniform(45, 75));
  }
  // 街角地块：门店左侧紧挨着一条支路（替换掉太近的支路）
  if (layout === 'corner') {
    const cx = lot.minX - 6 - sideW / 2 - 2.4;
    for (let i = xs.length - 1; i >= 0; i--) if (Math.abs((xs[i] as number) - cx) < sideW + 30) xs.splice(i, 1);
    xs.push(cx);
  }
  // 商业街：左侧留出连排小店的位置
  if (layout === 'strip') {
    for (let i = xs.length - 1; i >= 0; i--) if ((xs[i] as number) > lot.minX - 85 - sideW && (xs[i] as number) < lot.minX) xs.splice(i, 1);
    if (!xs.some((x) => x < lot.minX)) xs.push(lot.minX - 95 - sideW);
  }
  xs.sort((a, b) => a - b);

  xs.forEach((sx, si) => {
    const half = sideW / 2;
    asphalt.push(rectFrom(sx - half, minZ, sx + half, roadBottomZ));
    asphalt.push(rectFrom(sx - half, roadTopZ, sx + half, maxZ));
    sidewalks.push(rectFrom(sx - half - 2.4, minZ, sx - half, roadBottomZ - 2.4));
    sidewalks.push(rectFrom(sx + half, minZ, sx + half + 2.4, roadBottomZ - 2.4));
    sidewalks.push(rectFrom(sx - half - 2.4, roadTopZ + 2.4, sx - half, maxZ));
    sidewalks.push(rectFrom(sx + half, roadTopZ + 2.4, sx + half + 2.4, maxZ));
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
      stops: xs.map((sx, si) => ({ d: sx - sideW / 2 - 3.6 - minX, signal: si, group: 0 as const })),
      kind: 'main',
    });
    lanes.push({
      pts: [{ x: maxX, z: zW }, { x: minX, z: zW }],
      len: maxX - minX,
      dir: { x: -1, z: 0 },
      speed: P.speed,
      rate: P.mainRate,
      stops: xs.map((sx, si) => ({ d: maxX - (sx + sideW / 2 + 3.6), signal: si, group: 0 as const })).sort((a, b) => a.d - b.d),
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

  // 停车场与门店的禁建区、出入口车道、右侧后勤通道与背后卸货区
  keepOut.push(rectFrom(lot.minX - 4, lot.edgeZ - 4, lot.maxX + 4, store.maxZ + 4));
  for (const px of lot.perimeterX) asphalt.push(rectFrom(px - 3.5, roadTopZ, px + 3.5, lot.edgeZ));
  // 卸货区深 28 米，半挂车可以掉头倒车靠台
  asphalt.push(rectFrom(serviceX0, roadTopZ, serviceX1, store.maxZ + 28));
  const dock = rectFrom(store.maxX - 36, store.maxZ, serviceX1, store.maxZ + 28);
  asphalt.push(dock);
  keepOut.push(rectFrom(serviceX0 - 2, roadTopZ, serviceX1 + 3, store.maxZ + 31));
  keepOut.push(rectFrom(store.minX - 4, store.maxZ, serviceX1 + 3, store.maxZ + 31));
  // 停车场外侧绿化带
  grass.push(rectFrom(lot.minX, roadTopZ + 2.4, lot.maxX, lot.edgeZ));

  // ---------- 建筑：沿道路两侧按风格排布 ----------
  const buildings: Building[] = [];
  const canopies: SiteLayout['canopies'] = [];
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
  for (let x = lot.minX + 4; x < lot.maxX - 4; x += 9) {
    if (lot.perimeterX.some((px) => Math.abs(px - x) < 5)) continue;
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
    road: { nearLaneZ, farLaneZ, spawnMinX: minX + 2, spawnMaxX: maxX - 2 },
    dock,
    roadTopZ,
    roadBottomZ,
    turns,
    intersections,
    layout,
    ponds,
    works,
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
