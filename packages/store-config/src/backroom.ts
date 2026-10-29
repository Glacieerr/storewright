import type { StoreConfig } from './schema';
import { RACK, rackRowsIn, storeAreas } from './areas';

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
  /** 所在区域（货架区） */
  areaId: string;
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
  docks: Array<{ x: number; z: number; reefer?: boolean }>;
  /** 后仓与店内行走网络的连接点（配置中的 backroom 点） */
  entry: { x: number; z: number };
  capacity: number;
  levels: number;
}

const { BAY_W, RACK_D, LEVEL_H } = RACK;

/**
 * 后仓布局：托盘货架排在「货架区」类型的区域里（可以有多块），卸货门和收货区来自区域与卸货门配置（决策记录 0013）。
 * 没有明确给出区域时，默认区域与原来一致，只是超市的后仓左端分出了冷藏库和冷冻库、建材店分出了大件区。
 */
export function backroomLayout(config: StoreConfig): BackroomLayout {
  const br = config.backroom;
  const { areas: all, docks, frame } = storeAreas(config);
  // 后仓在一楼：二楼的卸货区、补货区另算（upperStock）
  const areas = all.filter((a) => a.floorId === frame.floorId);
  const rackAreas = areas.filter((a) => a.kind === 'RACKS' || a.kind === 'OVERSTOCK');
  const zone = rackAreas.length
    ? { x0: Math.min(...rackAreas.map((a) => a.x0)), x1: Math.max(...rackAreas.map((a) => a.x1)), z0: Math.min(...rackAreas.map((a) => a.z0)), z1: Math.max(...rackAreas.map((a) => a.z1)) }
    : frame.zone;
  const recv = areas.filter((a) => a.kind === 'UNLOAD' || a.kind === 'RECEIVING_HOLD');
  const receiving = recv.length
    ? { x0: Math.min(...recv.map((a) => a.x0)), x1: Math.max(...recv.map((a) => a.x1)), z0: Math.min(...recv.map((a) => a.z0)), z1: Math.max(...recv.map((a) => a.z1)) }
    : frame.receiving;
  const rows: BackroomLayout['rows'] = [];
  const aisles: number[] = [];
  const rowArea: string[] = [];
  for (const a of rackAreas) {
    // 靠着后墙的货架区第一排只有一面
    for (const r of rackRowsIn(a, a.z1 >= frame.depth - 1.2)) {
      rows.push({ z: r.z, x0: r.x0, x1: r.x1, bays: r.bays, singleSided: r.singleSided });
      aisles.push(r.aisle);
      rowArea.push(a.id);
    }
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
            areaId: rowArea[ri] as string,
          });
        }
      }
    }
  });
  return {
    zone,
    receiving,
    rows,
    aisles,
    mainAisleX: zone.x1 + 1.8,
    locations,
    docks: docks.map((d) => ({ x: d.x, z: d.z, reefer: d.reefer })),
    entry: frame.entry,
    capacity: locations.length,
    levels: br.rackLevels,
  };
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

/**
 * 二楼的卸货区与补货区（决策记录 0019）：一楼收货区旁的货梯通上来，托盘在二楼卸货区放下，
 * 再用搬运车摆进补货区地面（二楼没有叉车）；夜班从这里给二楼的货架补货。只有两层的门店才有。
 */
export interface UpperStock {
  floorId: string;
  /** 楼层高度序号（1 = 二楼） */
  level: number;
  /** 货梯（两层同一位置）：中心与门口（门朝 +X，收货区一侧） */
  lift: { x: number; z: number };
  liftDoor: { x: number; z: number };
  unload: { x0: number; x1: number; z0: number; z1: number };
  stock?: { x0: number; x1: number; z0: number; z1: number };
  /** 地面托盘位：先卸货区、再补货区 */
  spots: Array<{ x: number; z: number }>;
  /** 补货区通往二楼卖场的门（在后走廊上） */
  door: { x: number; z: number };
}

export function upperStock(config: StoreConfig): UpperStock | undefined {
  const { areas, frame } = storeAreas(config);
  const lift = frame.lift;
  if (!lift) return undefined;
  const floor = config.layout.floors.find((f) => f.id === lift.upperFloorId);
  const mine = areas.filter((a) => a.floorId === lift.upperFloorId);
  const unload = mine.find((a) => a.kind === 'UNLOAD');
  if (!floor || !unload) return undefined;
  const stock = mine.find((a) => a.kind === 'OVERSTOCK' || a.kind === 'RACKS' || a.kind === 'BULK');
  const spots: Array<{ x: number; z: number }> = [];
  for (const r of [unload, ...(stock ? [stock] : [])]) {
    for (let z = r.z0 + 1; z < r.z1 - 0.6; z += 1.6) for (let x = r.x0 + 1; x < r.x1 - 0.6; x += 1.6) spots.push({ x, z });
  }
  // 卸货区里离货梯近的托盘位先用
  spots.sort((a, b) => Math.hypot(a.x - lift.x, a.z - lift.z) - Math.hypot(b.x - lift.x, b.z - lift.z));
  const runs = config.layout.runs.filter((r) => r.floorId === floor.id);
  const back = runs.length ? Math.max(...runs.map((r) => Math.max(r.start.y, r.end.y))) : unload.z0 - 2;
  const doorX = stock ? (stock.x0 + stock.x1) / 2 : (unload.x0 + unload.x1) / 2;
  return {
    floorId: floor.id,
    level: floor.level,
    lift: { x: lift.x, z: lift.z },
    liftDoor: { x: lift.x + 1.8, z: lift.z },
    unload: { x0: unload.x0, x1: unload.x1, z0: unload.z0, z1: unload.z1 },
    ...(stock ? { stock: { x0: stock.x0, x1: stock.x1, z0: stock.z0, z1: stock.z1 } } : {}),
    spots,
    door: { x: doorX, z: back },
  };
}

export function routeLength(pts: Array<{ x: number; z: number }>): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot((pts[i] as { x: number }).x - (pts[i - 1] as { x: number }).x, (pts[i] as { z: number }).z - (pts[i - 1] as { z: number }).z);
  return n;
}
