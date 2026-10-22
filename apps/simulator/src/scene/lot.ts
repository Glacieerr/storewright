/**
 * 店前停车场：门前消防车道、线上取货专用车位、双排停车位与车道、两侧环形车道和出入口。
 * 纯函数，只依赖门店外轮廓和交付门口位置；坐标与场景一致（门店正面朝 −Z）。
 */

export interface Pt {
  x: number;
  z: number;
}

export interface ParkingSpot {
  x: number;
  y: number;
  z: number;
  /** 停好后车头朝向（与 motion.ts 一致：atan2(dx, dz)，0 = 朝 +Z 即朝向门店） */
  heading: number;
  kind: 'pickup' | 'general';
  /** 从哪条车道驶入（aisles 下标） */
  aisle: number;
}

export interface LotLayout {
  minX: number;
  maxX: number;
  /** 沥青区域靠路一侧的边 */
  edgeZ: number;
  /** 门前人行道外沿 */
  frontZ: number;
  fireLaneZ: number;
  /** 车道中心线（沿 X 方向） */
  aisles: number[];
  /** 两侧环形车道中心线（沿 Z 方向） */
  perimeterX: [number, number];
  spots: ParkingSpot[];
  pickupCount: number;
  /** 车位排的端部绿化岛 */
  islands: Array<{ x: number; z: number; w: number; d: number }>;
  /** 购物车回收栏：占用双排车位中的一列（上下两个车位），x/z 为中心，aisleZ 为上方车道中心 */
  corrals: Array<{ x: number; z: number; w: number; d: number; aisleZ: number }>;
  /** 取货专区招牌位置 */
  pickupSign: Pt;
}

export const SPOT_W = 2.8;
export const SPOT_D = 5.4;
export const AISLE_W = 7;
const SIDEWALK = 3;
const FIRE_LANE = 6;
const PERIM_W = 7;

export interface LotInput {
  storeMinX: number;
  storeMaxX: number;
  doorX: number;
  /** 双排车位的排数；不给时按门店宽度估算 */
  doubleRows?: number;
  /** 线上取货专用车位数；不给时按门店宽度估算（最多一整排） */
  pickupBays?: number;
}

export function buildLot(input: LotInput): LotLayout {
  const width = input.storeMaxX - input.storeMinX;
  const rows = input.doubleRows ?? Math.min(3, Math.max(1, Math.round(width / 35)));
  const minX = input.storeMinX - 4;
  const maxX = input.storeMaxX + 4;
  const perimeterX: [number, number] = [minX + PERIM_W / 2, maxX - PERIM_W / 2];
  const spotX0 = minX + PERIM_W + 1.5;
  const spotX1 = maxX - PERIM_W - 1.5;
  const perRow = Math.max(4, Math.floor((spotX1 - spotX0) / SPOT_W));
  const rowX0 = (spotX0 + spotX1) / 2 - (perRow * SPOT_W) / 2;
  const colX = (i: number) => rowX0 + (i + 0.5) * SPOT_W;

  const frontZ = -SIDEWALK;
  const fireLaneZ = frontZ - FIRE_LANE / 2;
  const pickupRowTop = frontZ - FIRE_LANE;
  const aisles: number[] = [];
  const spots: ParkingSpot[] = [];
  const islands: LotLayout['islands'] = [];

  // 第一排：线上取货专用车位（靠近交付门口），其余为普通车位；车头朝门店
  const pickupZ = pickupRowTop - SPOT_D / 2;
  let z = pickupRowTop - SPOT_D;
  aisles.push(z - AISLE_W / 2);
  const pickupWanted = input.pickupBays ?? Math.min(16, Math.max(8, Math.round(width / 6)));
  const byDoor = Array.from({ length: perRow }, (_, i) => i).sort((a, b) => Math.abs(colX(a) - input.doorX) - Math.abs(colX(b) - input.doorX) || a - b);
  const pickupCols = new Set(byDoor.slice(0, Math.min(pickupWanted, perRow)));
  const pickup: ParkingSpot[] = [];
  const general: ParkingSpot[] = [];
  for (let i = 0; i < perRow; i++) {
    const s: ParkingSpot = { x: colX(i), y: 0, z: pickupZ, heading: 0, kind: pickupCols.has(i) ? 'pickup' : 'general', aisle: 0 };
    (s.kind === 'pickup' ? pickup : general).push(s);
  }
  z -= AISLE_W;

  // 双排车位：上半排从上方车道驶入（车头朝 −Z），下半排从下方车道驶入（车头朝 +Z）；
  // 每排在约 1/3 和 2/3 处各留一列做购物车回收栏（车位少时只留中间一列）
  const corrals: LotLayout['corrals'] = [];
  const corralCols = perRow >= 12 ? [Math.round(perRow / 3), Math.round((perRow * 2) / 3)] : [Math.floor(perRow / 2)];
  for (let r = 0; r < rows; r++) {
    const upper = z - SPOT_D / 2;
    const lower = z - SPOT_D * 1.5;
    for (let i = 0; i < perRow; i++) {
      if (corralCols.includes(i)) {
        corrals.push({ x: colX(i), z: z - SPOT_D, w: SPOT_W - 0.4, d: SPOT_D * 2 - 1.2, aisleZ: z + AISLE_W / 2 });
        continue;
      }
      general.push({ x: colX(i), y: 0, z: upper, heading: Math.PI, kind: 'general', aisle: r });
      general.push({ x: colX(i), y: 0, z: lower, heading: 0, kind: 'general', aisle: r + 1 });
    }
    islands.push({ x: rowX0 - 1.2, z: z - SPOT_D, w: 2.4, d: SPOT_D * 2 - 0.6 });
    islands.push({ x: rowX0 + perRow * SPOT_W + 1.2, z: z - SPOT_D, w: 2.4, d: SPOT_D * 2 - 0.6 });
    z -= SPOT_D * 2;
    aisles.push(z - AISLE_W / 2);
    z -= AISLE_W;
  }

  // 取货车位按离门口由近到远编号；普通车位同样按离门口的距离排序（溢出时先用近的）
  const door = { x: input.doorX, z: 0 };
  const dist = (s: ParkingSpot) => Math.hypot(s.x - door.x, s.z - door.z);
  pickup.sort((a, b) => Math.abs(a.x - door.x) - Math.abs(b.x - door.x) || a.x - b.x);
  general.sort((a, b) => dist(a) - dist(b) || a.x - b.x || a.z - b.z);
  const pickupXs = pickup.map((s) => s.x);
  return {
    minX,
    maxX,
    edgeZ: z,
    frontZ,
    fireLaneZ,
    aisles,
    perimeterX,
    spots: [...pickup, ...general],
    pickupCount: pickup.length,
    islands,
    corrals,
    pickupSign: { x: pickupXs.length ? (Math.min(...pickupXs) + Math.max(...pickupXs)) / 2 : input.doorX, z: pickupRowTop + 0.6 },
  };
}

/** 取货车位不够时，离门口最近的这几个普通车位留给溢出的取货车辆 */
export const OVERFLOW_RESERVE = 8;

/** 仿真分配的车位序号 → 停车场里的车位（超出取货车位和预留车位时循环使用预留车位） */
export function carSpotIndex(lot: LotLayout, index: number): number {
  const i = index < lot.pickupCount + OVERFLOW_RESERVE ? index : lot.pickupCount + (index % OVERFLOW_RESERVE);
  return Math.min(i, lot.spots.length - 1);
}

export function carSpot(lot: LotLayout, index: number): ParkingSpot {
  return lot.spots[carSpotIndex(lot, index)] as ParkingSpot;
}

/** 把折线的拐角替换为二次贝塞尔圆角，车辆转弯更自然 */
export function roundCorners(pts: Pt[], radius: number): Pt[] {
  if (pts.length < 3) return pts.map((p) => ({ ...p }));
  const out: Pt[] = [{ ...(pts[0] as Pt) }];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    const l1 = Math.hypot(b.x - a.x, b.z - a.z);
    const l2 = Math.hypot(c.x - b.x, c.z - b.z);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.05) {
      out.push({ ...b });
      continue;
    }
    const p0 = { x: b.x + ((a.x - b.x) / l1) * r, z: b.z + ((a.z - b.z) / l1) * r };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * r, z: b.z + ((c.z - b.z) / l2) * r };
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      const u = 1 - t;
      out.push({ x: u * u * p0.x + 2 * u * t * b.x + t * t * p2.x, z: u * u * p0.z + 2 * u * t * b.z + t * t * p2.z });
    }
  }
  out.push({ ...(pts[pts.length - 1] as Pt) });
  return out;
}

/** 带累计长度和分段速度的路径，按时间取位置 */
export class TimedPath {
  readonly pts: Pt[];
  readonly cumT: number[];
  readonly cumD: number[];
  readonly duration: number;
  /** 倒车：车头与行进方向相反 */
  readonly reverse: boolean;

  constructor(pts: Pt[], speedAt: (a: Pt, b: Pt) => number, reverse = false) {
    this.pts = pts;
    this.reverse = reverse;
    this.cumT = [0];
    this.cumD = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as Pt;
      const b = pts[i] as Pt;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      this.cumD.push((this.cumD[i - 1] as number) + d);
      this.cumT.push((this.cumT[i - 1] as number) + d / Math.max(0.5, speedAt(a, b)));
    }
    this.duration = this.cumT[this.cumT.length - 1] as number;
  }

  /** 时刻 τ（0…duration）的位置与车头朝向 */
  at(tau: number, out: { x: number; z: number; heading: number }): void {
    const t = Math.min(this.duration, Math.max(0, tau));
    let i = 1;
    while (i < this.cumT.length - 1 && (this.cumT[i] as number) < t) i++;
    const a = this.pts[i - 1] as Pt;
    const b = this.pts[i] as Pt;
    const seg = (this.cumT[i] as number) - (this.cumT[i - 1] as number);
    const k = seg > 0 ? (t - (this.cumT[i - 1] as number)) / seg : 1;
    out.x = a.x + (b.x - a.x) * k;
    out.z = a.z + (b.z - a.z) * k;
    if (Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 1e-6) {
      const h = Math.atan2(b.x - a.x, b.z - a.z);
      out.heading = this.reverse ? h + Math.PI : h;
    }
  }
}

export interface RoadAccess {
  /** 路上靠门店一侧（+X 方向行驶）车道的 Z */
  nearLaneZ: number;
  /** 路上远侧（−X 方向行驶）车道的 Z */
  farLaneZ: number;
  /** 车辆出现和消失的 X 范围 */
  spawnMinX: number;
  spawnMaxX: number;
}

const LOT_SPEED = 4.2;
const ROAD_SPEED = 11;

/**
 * 驶入路径：从道路一端出发 → 出入口 → 环形车道 → 车道 → 车位。
 * fromLeft 决定从哪一端来（从右边来的车要穿过对向车道左转进入）。
 */
export function entryPath(lot: LotLayout, road: RoadAccess, spot: ParkingSpot, fromLeft: boolean): TimedPath {
  const aisleZ = lot.aisles[spot.aisle] as number;
  // 选离车位近的一侧出入口
  const side = Math.abs(spot.x - lot.perimeterX[0]) <= Math.abs(spot.x - lot.perimeterX[1]) ? 0 : 1;
  const px = lot.perimeterX[side];
  const laneZ = fromLeft ? road.nearLaneZ : road.farLaneZ;
  const startX = fromLeft ? road.spawnMinX : road.spawnMaxX;
  const into = spot.heading === 0 ? 1 : -1; // 车头朝 +Z 时从下方车道向 +Z 驶入
  const dir = Math.sign(spot.x - px) || 1;
  const pts = roundCorners(
    [
      { x: startX, z: laneZ },
      { x: px, z: laneZ },
      { x: px, z: lot.edgeZ },
      { x: px, z: aisleZ },
      { x: spot.x - dir * 2.2, z: aisleZ },
      { x: spot.x, z: aisleZ + into * 2.2 },
      { x: spot.x, z: spot.z },
    ],
    3,
  );
  return new TimedPath(pts, (a, b) => (Math.max(a.z, b.z) < lot.edgeZ - 1 ? ROAD_SPEED : LOT_SPEED));
}

/** 离开：先倒车退出车位，再沿车道开到较远一侧的出入口并驶离 */
export function exitPaths(lot: LotLayout, road: RoadAccess, spot: ParkingSpot, toLeft: boolean): [TimedPath, TimedPath] {
  const aisleZ = lot.aisles[spot.aisle] as number;
  const into = spot.heading === 0 ? 1 : -1;
  const side = toLeft ? 0 : 1;
  const px = lot.perimeterX[side];
  const dir = Math.sign(px - spot.x) || 1;
  // 倒车时车尾朝向要去的方向，退出后车头正好朝出口
  const back = new TimedPath(
    roundCorners(
      [
        { x: spot.x, z: spot.z },
        { x: spot.x, z: aisleZ + into * 1.2 },
        { x: spot.x - dir * 2.6, z: aisleZ },
      ],
      2.4,
    ),
    () => 1.6,
    true,
  );
  const laneZ = toLeft ? road.farLaneZ : road.nearLaneZ;
  const endX = toLeft ? road.spawnMinX : road.spawnMaxX;
  const drive = new TimedPath(
    roundCorners(
      [
        { x: spot.x - dir * 2.6, z: aisleZ },
        { x: px, z: aisleZ },
        { x: px, z: lot.edgeZ },
        { x: px, z: laneZ },
        { x: endX, z: laneZ },
      ],
      3,
    ),
    (a, b) => (Math.max(a.z, b.z) < lot.edgeZ - 1 ? ROAD_SPEED : LOT_SPEED),
  );
  return [back, drive];
}
