import type { TempZone } from '@storewright/domain';
import { storeAreas, type ResolvedArea, type ResolvedDock, type RunConfig, type StagingSlot, type StoreModel } from '@storewright/store-config';
import { buildLot, OVERFLOW_RESERVE, type LotLayout, type ParkingSpot } from './lot';

/**
 * 由门店模型推导出的渲染几何。
 * 坐标约定：配置中的 (x, y) 米 → three.js 的 (X, Z)，Y 轴向上；楼层按 level 叠放。
 */

export const FLOOR_HEIGHT = 7;
const LEVEL_HEIGHT = 0.34;
const GONDOLA_DEPTH = 0.9;
const AISLE_HALF = 0.6;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ShelfInstance {
  runId: string;
  bay: number;
  floorId: string;
  x: number;
  y: number;
  z: number;
  length: number;
  depth: number;
  height: number;
  rotY: number;
  tempZone: TempZone;
}

export interface RackLayout {
  rackId: string;
  zoneCode: string;
  tempZone: TempZone;
  purpose: StagingSlot['purpose'];
  x: number;
  z: number;
  length: number;
  levels: number;
  slotsPerLevel: number;
}

export interface SlotPosition {
  code: string;
  rackId: string;
  tempZone: TempZone;
  capacity: number;
  x: number;
  y: number;
  z: number;
}

export interface FloorBounds {
  floorId: string;
  level: number;
  y: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** 汽车快修中心的渲染几何：建筑外轮廓、工位、等候车位 */
export interface FacilityGeometry {
  id: string;
  name: string;
  side: 'LEFT' | 'RIGHT';
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  height: number;
  /** 工位中心（建筑内），机油工位在前、轮胎工位在后，与仿真的工位序号一致 */
  bays: Array<{ x: number; z: number; kind: 'OIL' | 'TIRE' }>;
  /** 办公 / 顾客休息室 */
  office: { x0: number; x1: number };
  /** 等候用的停车场车位（lot.spots 下标） */
  waitingSpots: number[];
}

/** 电梯井与自动扶梯的渲染几何 */
export interface ConnectorGeometry {
  id: string;
  kind: 'ELEVATOR' | 'STAIRS' | 'ESCALATOR';
  x: number;
  z: number;
  y0: number;
  y1: number;
  /** 扶梯：下端与上端落地点（沿 X 方向展开，上行与下行两条并排） */
  bottom?: Vec3;
  top?: Vec3;
}

/** 扶梯坡度 30°，水平长度 = 层高 / tan 30° */
export const ESCALATOR_RUN = FLOOR_HEIGHT / Math.tan(Math.PI / 6);

/** 园艺中心：门店一侧的露天围栏卖场 */
export interface GardenGeometry {
  id: string;
  side: 'LEFT' | 'RIGHT';
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** 店内药房柜台区域与排队位置 */
export interface PharmacyGeometry {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  counters: Array<{ x: number; z: number }>;
  /** 排队的位置（第一个最靠近柜台） */
  queue: Array<{ x: number; z: number }>;
}

export const FACILITY_BAY_W = 4.8;
export const FACILITY_DEPTH = 16;

export interface StoreGeometry {
  floorY: Map<string, number>;
  floors: FloorBounds[];
  shelves: ShelfInstance[];
  racks: RackLayout[];
  slots: Map<string, SlotPosition>;
  /** 区域与卸货门（决策记录 0013） */
  areas: ResolvedArea[];
  docks: ResolvedDock[];
  /** 停车位：先是线上取货专用车位（按离门口由近到远），再是普通车位 */
  parking: ParkingSpot[];
  lot: LotLayout;
  facilities: FacilityGeometry[];
  gardens: GardenGeometry[];
  pharmacy?: PharmacyGeometry;
  /** 收银台（顾客入口旁的前区）：位置为收银通道中心 */
  checkouts: Array<{ x: number; z: number; self: boolean }>;
  connectors: ConnectorGeometry[];
  door: Vec3;
  center: Vec3;
  runLabels: Array<{ runId: string; label: string; floorId: string; x: number; y: number; z: number; tempZone: TempZone }>;
}

/** 熟食服务柜台占用的货架段：含熟食类别的靠墙通道最后约 45% 的段（画面里用柜台代替货架） */
export function deliBays(cfg: { layout: { runs: RunConfig[] } }): { runId: string; bays: Set<number> } | undefined {
  const run = cfg.layout.runs.find((r) => r.categoryIds.includes('deli') && r.kind === 'WALL');
  if (!run || run.bays < 4) return undefined;
  const n = Math.max(2, Math.round(run.bays * 0.45));
  return { runId: run.id, bays: new Set(Array.from({ length: n }, (_, k) => run.bays - n + k)) };
}

export const SHELF_AISLE_HALF = 0.6;
export const SHELF_DEPTH = 0.9;

function shelfHeight(run: RunConfig): number {
  if (run.tempZone === 'FROZEN') return 1.1;
  return run.levels * LEVEL_HEIGHT + 0.25;
}

export function buildGeometry(model: StoreModel): StoreGeometry {
  const cfg = model.config;
  const floorY = new Map(cfg.layout.floors.map((f) => [f.id, f.level * FLOOR_HEIGHT]));
  const shelves: ShelfInstance[] = [];
  const runLabels: StoreGeometry['runLabels'] = [];

  const floorCenter = new Map(cfg.layout.floors.map((f) => [f.id, { x: f.widthM / 2, y: f.depthM / 2 }]));

  for (const run of cfg.layout.runs) {
    const y = floorY.get(run.floorId) ?? 0;
    const dx = run.end.x - run.start.x;
    const dy = run.end.y - run.start.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    // 法向量（配置平面内）
    const nx = -uy;
    const ny = ux;
    const margin = Math.min(run.endMarginM, len / 4);
    const bayLen = (len - 2 * margin) / run.bays;
    const rotY = Math.atan2(-uy, ux);
    const height = shelfHeight(run);
    let sides: number[];
    if (run.sides === 2) sides = [1, -1];
    else {
      const c = floorCenter.get(run.floorId) ?? { x: 0, y: 0 };
      const mx = (run.start.x + run.end.x) / 2;
      const my = (run.start.y + run.end.y) / 2;
      const plus = Math.hypot(mx + nx - c.x, my + ny - c.y);
      const minus = Math.hypot(mx - nx - c.x, my - ny - c.y);
      sides = [plus > minus ? 1 : -1];
    }
    for (let b = 0; b < run.bays; b++) {
      const along = margin + (b + 0.5) * bayLen;
      const px = run.start.x + ux * along;
      const py = run.start.y + uy * along;
      for (const s of sides) {
        const off = AISLE_HALF + GONDOLA_DEPTH / 2;
        shelves.push({
          runId: run.id,
          bay: b,
          floorId: run.floorId,
          x: px + nx * off * s,
          y: y + height / 2,
          z: py + ny * off * s,
          length: bayLen * 0.97,
          depth: GONDOLA_DEPTH,
          height,
          rotY,
          tempZone: run.tempZone,
        });
      }
    }
    runLabels.push({ runId: run.id, label: run.label ?? run.id, floorId: run.floorId, x: run.start.x, y: y + 2.4, z: run.start.y - 0.8 * Math.sign(uy || 1), tempZone: run.tempZone });
  }

  // 暂存区：货架位置来自门店配置（明确给出的位置、所在区域，或从暂存点往店内排开的默认网格，决策记录 0013）
  const sp = cfg.layout.points.staging;
  const stagingY = floorY.get(sp.floorId) ?? 0;
  const sa = storeAreas(cfg);
  const racks: RackLayout[] = sa.racks.map((r) => ({ rackId: r.rackId, zoneCode: r.zoneCode, tempZone: r.tempZone, purpose: r.purpose, x: r.x, z: r.z, length: r.length, levels: r.levels, slotsPerLevel: r.slotsPerLevel }));
  const slots = new Map<string, SlotPosition>();
  const rackById = new Map(racks.map((r) => [r.rackId, r]));
  for (const s of model.stagingSlots) {
    const r = rackById.get(s.rackId);
    if (!r) continue;
    const parts = s.code.match(/(\d+)\D+(\d+)$/);
    const level = parts ? Number(parts[1]) : 1;
    const slot = parts ? Number(parts[2]) : 1;
    slots.set(s.code, {
      code: s.code,
      rackId: s.rackId,
      tempZone: s.tempZone,
      capacity: s.capacityTotes,
      x: r.x - r.length / 2 + ((slot - 0.5) * r.length) / r.slotsPerLevel,
      y: stagingY + 0.22 + (level - 1) * 0.42,
      z: r.z,
    });
  }

  // 门口与停车位（店外）
  const hp = cfg.layout.points.handoff;
  const door: Vec3 = { x: hp.x, y: floorY.get(hp.floorId) ?? 0, z: hp.y };

  const floors: FloorBounds[] = cfg.layout.floors.map((f) => {
    let maxX = f.widthM;
    let maxZ = f.depthM;
    let minX = 0;
    let minZ = 0;
    if (f.id === sp.floorId) {
      for (const r of racks) {
        maxX = Math.max(maxX, r.x + r.length / 2 + 2);
        maxZ = Math.max(maxZ, r.z + 2);
      }
    }
    // 区域画在建筑里：楼层轮廓包住这一层的全部区域
    for (const a of sa.areas) {
      if (a.floorId !== f.id) continue;
      maxX = Math.max(maxX, a.x1 + 1);
      maxZ = Math.max(maxZ, a.z1 + 0.6);
      minX = Math.min(minX, a.x0 - 1);
      minZ = Math.min(minZ, a.z0 - 1);
    }
    return { floorId: f.id, level: f.level, y: f.level * FLOOR_HEIGHT, minX, maxX, minZ, maxZ };
  });
  const f0 = floors[0] as FloorBounds;
  // 附属设施建在门店一侧，正面与门店对齐；停车场覆盖门店和设施的正面
  const facilities: FacilityGeometry[] = [];
  const gardens: GardenGeometry[] = [];
  let pharmacy: PharmacyGeometry | undefined;
  for (const f of cfg.facilities) {
    if (f.kind === 'GARDEN_CENTER') {
      const x0 = f.side === 'LEFT' ? f0.minX - 3 - f.widthM : f0.maxX + 3;
      gardens.push({ id: f.id, side: f.side, x0, x1: x0 + f.widthM, z0: 0, z1: f.depthM });
      continue;
    }
    if (f.kind === 'PHARMACY') {
      // 正面左侧角落（前走廊与正面墙之间），柜台沿正面墙内侧一字排开
      const x0 = f0.minX + 1.2;
      const x1 = x0 + 3 + f.counters * 2.4;
      pharmacy = {
        x0,
        x1,
        z0: 0.4,
        z1: 4.8,
        counters: Array.from({ length: f.counters }, (_, k) => ({ x: x0 + 2 + k * 2.4, z: 3.9 })),
        queue: Array.from({ length: 10 }, (_, k) => ({ x: x1 + 0.8 + (k % 5) * 0.9, z: 2.6 - Math.floor(k / 5) * 0.9 })),
      };
      continue;
    }
    const bays = f.oilBays + f.tireBays;
    const officeW = 6;
    const w = bays * FACILITY_BAY_W + officeW;
    const x0 = f.side === 'LEFT' ? f0.minX - 3 - w : f0.maxX + 3;
    const x1 = x0 + w;
    // 工位从靠门店的一端排起，办公室在外侧
    const bayX = (i: number) => (f.side === 'LEFT' ? x1 - (i + 0.5) * FACILITY_BAY_W : x0 + (i + 0.5) * FACILITY_BAY_W);
    facilities.push({
      id: f.id,
      name: f.name,
      side: f.side,
      x0,
      x1,
      z0: 0,
      z1: FACILITY_DEPTH,
      height: 5,
      bays: Array.from({ length: bays }, (_, i) => ({ x: bayX(i), z: FACILITY_DEPTH / 2, kind: i < f.oilBays ? ('OIL' as const) : ('TIRE' as const) })),
      office: f.side === 'LEFT' ? { x0, x1: x0 + officeW } : { x0: x1 - officeW, x1 },
      waitingSpots: [],
    });
  }
  const minX = Math.min(f0.minX, ...facilities.map((f) => f.x0), ...gardens.map((g) => g.x0));
  const maxX = Math.max(f0.maxX, ...facilities.map((f) => f.x1), ...gardens.map((g) => g.x1));
  const lot = buildLot({ storeMinX: minX, storeMaxX: maxX, doorX: door.x, doubleRows: cfg.outdoor.parkingRows || undefined, pickupBays: cfg.outdoor.pickupBays || undefined, bays: cfg.parking?.pickupBays });
  for (const fac of facilities) {
    fac.waitingSpots = lot.spots
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i >= lot.pickupCount + OVERFLOW_RESERVE && s.heading === 0 && s.aisle === 0 && s.x > fac.x0 - 1 && s.x < fac.x1 + 1)
      .sort((a, b) => Math.abs(a.s.x - (fac.x0 + fac.x1) / 2) - Math.abs(b.s.x - (fac.x0 + fac.x1) / 2))
      .map(({ i }) => i);
  }
  const parking = lot.spots;
  // 收银台：放在正面墙与前走廊之间，从顾客入口向右排开，避开扶梯、药房和交付门口
  const entranceX = cfg.outdoor.entranceX ?? f0.minX + (f0.maxX - f0.minX) * 0.42;
  const lanes = Math.min(10, Math.max(3, Math.round((f0.maxX - f0.minX) / 12)));
  const blocked = (x: number) =>
    cfg.layout.connectors.some((c) => c.kind === 'ESCALATOR' && Math.abs(c.a.x - x) < ESCALATOR_RUN / 2 + 1.5) ||
    (pharmacy !== undefined && x < pharmacy.x1 + 6) ||
    Math.abs(x - door.x) < 4 ||
    x > f0.maxX - 3 ||
    Math.abs(x - entranceX) < 3.2;
  const checkouts: StoreGeometry['checkouts'] = [];
  for (let x = entranceX + 3.6; checkouts.length < lanes && x < f0.maxX - 3; x += 2.6) if (!blocked(x)) checkouts.push({ x, z: 2.8, self: false });
  // 自助收银：入口另一侧的 4 台
  for (let k = 0; k < 4; k++) {
    const x = entranceX - 4 - k * 1.6;
    if (!blocked(x) && x > f0.minX + 2) checkouts.push({ x, z: 2.2, self: true });
  }
  const connectors: ConnectorGeometry[] = cfg.layout.connectors.map((c) => {
    const y0 = floorY.get(c.a.floorId) ?? 0;
    const y1 = floorY.get(c.b.floorId) ?? FLOOR_HEIGHT;
    const g: ConnectorGeometry = { id: c.id, kind: c.kind, x: c.a.x, z: c.a.y, y0, y1 };
    if (c.kind === 'ESCALATOR') {
      // 扶梯放在前走廊与门店正面之间，沿 X 方向展开，中点对准连接点
      const z = Math.max(1.6, c.a.y - 2.6);
      g.z = z;
      g.bottom = { x: c.a.x - ESCALATOR_RUN / 2, y: y0, z };
      g.top = { x: c.a.x + ESCALATOR_RUN / 2, y: y1, z };
    }
    return g;
  });
  return {
    floorY,
    floors,
    shelves,
    racks,
    slots,
    areas: sa.areas,
    docks: sa.docks,
    parking,
    lot,
    facilities,
    gardens,
    pharmacy,
    checkouts,
    connectors,
    door,
    center: { x: (f0.minX + f0.maxX) / 2, y: 0, z: (f0.minZ + f0.maxZ) / 2 },
    runLabels,
  };
}

/** 行走网络节点的世界坐标 */
export function nodeWorld(model: StoreModel, floorY: Map<string, number>, nodeId: number): Vec3 {
  const n = model.nodes[nodeId];
  if (!n) return { x: 0, y: 0, z: 0 };
  return { x: n.x, y: floorY.get(n.floorId) ?? 0, z: n.y };
}
