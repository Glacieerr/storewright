import type { StoreConfig } from './schema';

/**
 * 后仓（库存仓库）布局：由门店配置推导，供仿真引擎和模拟器共用。
 *
 * - 后仓位于一楼售货区后墙之后，深度 = 模板默认后仓 + extraDepthM；
 * - 托盘货架按排沿 X 方向布置，排与排之间是叉车通道，靠墙的一排只有朝外一面；
 * - 卸货门在后墙右侧，门内是收货区（卸货、点数、贴标）；
 * - 货架区与收货区之间有一条纵向的叉车主通道。
 * 后仓不进入店内行走网络（不改变拣货距离），后仓内的移动按通道走直角路线。
 */

export interface BackroomLocation {
  id: string;
  row: number;
  bay: number;
  level: number;
  /** -1 朝前面的通道，+1 朝后面的通道 */
  side: -1 | 1;
  x: number;
  z: number;
  /** 货位离地高度（米） */
  y: number;
}

export interface BackroomLayout {
  zone: { x0: number; x1: number; z0: number; z1: number };
  receiving: { x0: number; x1: number; z0: number; z1: number };
  /** 每排货架：中心线 z、x 范围、段数、是否只有前面一面 */
  rows: Array<{ z: number; x0: number; x1: number; bays: number; singleSided: boolean }>;
  /** 每排货架前面的叉车通道中心线 z */
  aisles: number[];
  /** 货架区与收货区之间的纵向主通道 x */
  mainAisleX: number;
  locations: BackroomLocation[];
  docks: Array<{ x: number; z: number }>;
  /** 后仓与店内行走网络的连接点（配置中的 backroom 点） */
  entry: { x: number; z: number };
  capacity: number;
  levels: number;
}

const BAY_W = 2.7;
const RACK_D = 2.4;
const AISLE_D = 3.6;
const LEVEL_H = 1.5;

export function backroomLayout(config: StoreConfig): BackroomLayout {
  const br = config.backroom;
  const f1 = config.layout.floors.find((f) => f.level === 0) ?? config.layout.floors[0];
  const width = f1?.widthM ?? 60;
  const depth = f1?.depthM ?? 40;
  const f1Runs = config.layout.runs.filter((r) => r.floorId === (f1?.id ?? 'F1'));
  const backWall = Math.max(...f1Runs.map((r) => Math.max(r.start.y, r.end.y)), 0);
  const stagingX = config.layout.points.staging.x;
  const entry = { x: config.layout.points.backroom.x, z: config.layout.points.backroom.y };

  // 卸货门：后墙右侧，间隔 5 米
  const docks = Array.from({ length: br.docks }, (_, k) => ({ x: width - 3 - k * 5, z: depth }));
  const receiving = { x0: Math.min(stagingX - 8, width - 3 - (br.docks - 1) * 5 - 4), x1: width - 1, z0: Math.max(backWall + 2.4, depth - 9), z1: depth - 0.5 };
  const zone = { x0: 1.5, x1: Math.max(4, receiving.x0 - 4), z0: backWall + 2.4, z1: depth - 0.6 };
  const mainAisleX = zone.x1 + 1.8;

  // 货架排：从后墙（z1）往前排，第一排靠墙只有一面
  const zoneDepth = zone.z1 - zone.z0;
  const fit = zoneDepth >= RACK_D / 2 + AISLE_D ? Math.max(1, Math.floor((zoneDepth - RACK_D / 2) / (RACK_D + AISLE_D)) + 1) : 0;
  const rowsWanted = br.rackRows > 0 ? Math.min(br.rackRows, fit) : fit;
  const bays = Math.max(0, Math.floor((zone.x1 - zone.x0 - 4) / BAY_W));
  const rows: BackroomLayout['rows'] = [];
  const aisles: number[] = [];
  for (let i = 0; i < rowsWanted; i++) {
    const singleSided = i === 0;
    const z = singleSided ? zone.z1 - RACK_D / 4 - 0.1 : zone.z1 - RACK_D / 2 - i * (RACK_D + AISLE_D) + RACK_D / 4;
    if (z - RACK_D / 2 - AISLE_D < zone.z0 - 0.01) break;
    rows.push({ z, x0: zone.x0 + 2, x1: zone.x0 + 2 + bays * BAY_W, bays, singleSided });
    aisles.push(z - (singleSided ? RACK_D / 4 : RACK_D / 2) - AISLE_D / 2);
  }

  const locations: BackroomLocation[] = [];
  rows.forEach((r, ri) => {
    for (let b = 0; b < r.bays; b++) {
      for (let l = 0; l < br.rackLevels; l++) {
        for (const side of r.singleSided ? ([-1] as const) : ([-1, 1] as const)) {
          locations.push({
            id: `BR-${ri + 1}-${String(b + 1).padStart(2, '0')}-${l + 1}${side < 0 ? 'A' : 'B'}`,
            row: ri,
            bay: b,
            level: l,
            side,
            x: r.x0 + (b + 0.5) * BAY_W,
            z: r.z + side * (r.singleSided ? 0 : RACK_D / 4),
            y: l * LEVEL_H,
          });
        }
      }
    }
  });
  return { zone, receiving, rows, aisles, mainAisleX, locations, docks, entry, capacity: locations.length, levels: br.rackLevels };
}

/**
 * 后仓内两点之间的叉车 / 推车路线：经过主通道和货架前的通道走直角。
 * 返回折线点（x, z）。
 */
export function backroomRoute(b: BackroomLayout, from: { x: number; z: number }, to: { x: number; z: number }, aisleOf?: number): Array<{ x: number; z: number }> {
  const pts: Array<{ x: number; z: number }> = [{ x: from.x, z: from.z }];
  const inZone = (p: { x: number; z: number }) => p.x <= b.zone.x1 + 0.5 && p.z >= b.zone.z0 - 0.5;
  // 目标货位前的通道
  const az = aisleOf !== undefined ? b.aisles[aisleOf] : undefined;
  if (az !== undefined) {
    if (inZone(from)) pts.push({ x: from.x, z: az === undefined ? from.z : nearestAisle(b, from.z) });
    pts.push({ x: b.mainAisleX, z: pts[pts.length - 1]?.z ?? from.z });
    pts.push({ x: b.mainAisleX, z: az });
    pts.push({ x: to.x, z: az });
    pts.push({ x: to.x, z: to.z });
  } else {
    if (inZone(from)) {
      const z = nearestAisle(b, from.z);
      pts.push({ x: from.x, z });
      pts.push({ x: b.mainAisleX, z });
    } else pts.push({ x: b.mainAisleX, z: from.z });
    pts.push({ x: b.mainAisleX, z: to.z });
    pts.push({ x: to.x, z: to.z });
  }
  // 去掉重复点
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - (pts[i - 1] as { x: number }).x, p.z - (pts[i - 1] as { z: number }).z) > 0.01);
}

/** 货位朝向的叉车通道：朝前取前面的通道，朝后取后面一排的前通道 */
export function aisleFor(loc: BackroomLocation): number {
  return loc.side > 0 ? loc.row - 1 : loc.row;
}

/** 货位前的地面：高层托盘放到地面后的位置、补货员取货的站位 */
export function floorSpotFor(loc: BackroomLocation, dist = LETDOWN_DIST): { x: number; z: number } {
  return { x: loc.x, z: loc.z + loc.side * dist };
}

/** 高层托盘取下后放在货位前方地面的距离（米） */
export const LETDOWN_DIST = 1.9;

function nearestAisle(b: BackroomLayout, z: number): number {
  let best = b.zone.z0 + 1;
  let d = Infinity;
  for (const a of b.aisles) {
    if (Math.abs(a - z) < d) {
      d = Math.abs(a - z);
      best = a;
    }
  }
  return best;
}

export function routeLength(pts: Array<{ x: number; z: number }>): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot((pts[i] as { x: number }).x - (pts[i - 1] as { x: number }).x, (pts[i] as { z: number }).z - (pts[i - 1] as { z: number }).z);
  return n;
}
