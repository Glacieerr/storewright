/**
 * 综合店的店前停车场和西侧的即时取货区（第一部分 Storewright 的停车场模板，决策记录 0013、0018、0019）。
 * 纯函数，坐标是门店本地坐标：StoreX 门店模型的中心在原点，x 向东，正面朝 +z（朝进店路），店房正面墙在 z = front；
 * 车头朝向 heading = atan2(dx, dz)（0 = 朝 +z 背对门店，π = 朝门店，π/2 = 朝东）。
 *
 * 店前（从店房往外）：门前人行道 → 消防车道（不停车）→ 第一排（无障碍车位、充电车位、普通车位，车头朝门店）→ 车道 → 几组双排车位
 * （靠门店的半排车头朝外、从门店一侧的车道驶入，靠路的半排车头朝门店、从路一侧的车道驶入）→ 最外侧车道 → 路边绿化带 → 门前路。
 * 两侧是环形车道，连着两个出入口：一进一出两条车道，中间一道绿化隔离岛，接门前路处是喇叭口；车位之间的车道靠右行驶。
 * 每组双排车位在约 1/3、2/3 处各留一列做购物车回收栏，正对店门的一列是人行通道（斑马线穿过车道和消防车道）；
 * 最远一排靠路的半排两头是长车位（房车、拖车，沿车道停在几个车位的前沿上）。
 *
 * 西侧（店房西墙外）：即时取货区，单向绕行——从西侧环形车道一直往北（外侧车道）→ 北头的回车场掉头 →
 * 往南的服务车道：路过配送车装车位、编号的即时取货车位（自提柜就在墙上，上一代是车边交付），
 * 南段分出贴墙的免下车取货车道（4 个取货位，取货口在墙上，司机一侧对着墙）→ 回到店前、从西侧出口出去。
 */
export interface Pt {
  x: number;
  z: number;
}

/**
 * 尺寸（米，按公开资料取的假设参数）：小型车垂直车位 2.5 × 5.3（最小 2.4 × 5.3）、双向车道 7（倒车入位的车道不小于 5.5）、
 * 环形车道 7；店房占地超过 3,000 平方米要有消防车道（净宽不小于 4 米、离外墙不小于 5 米），这里店门前留 5 米人行道、消防车道宽 6 米。
 */
export const SPOT_W = 2.5;
export const SPOT_D = 5.3;
export const AISLE_W = 7;
export const PERIM_W = 7;
export const FIRE_LANE = 6;
export const WALK = 5;
/** 路边绿化带 + 人行道、门前路（双向两车道） */
export const EDGE = 4;
export const FRONTAGE = 7;
/** 出入口和环形车道一进一出（靠右）：车道中心离环形车道中心 1.75 米；车位之间的车道靠右 1.5 米 */
export const LANE_OFF = 1.75;
export const AISLE_OFF = 1.5;
export const MEDIAN_W = 0.9;
export const GATE_W = 8.6;
export const FLARE = 6;
/** 即时取货车位的间距（比普通车位宽，开后备厢、递货方便）；无障碍车位旁的轮椅通道宽 1.2 米 */
export const PICKUP_PITCH = 3;
export const ACCESS_AISLE = 1.2;

export type StallKind = 'general' | 'accessible' | 'ev' | 'pickup' | 'van';

export interface Stall {
  i: number;
  x: number;
  z: number;
  heading: number;
  kind: StallKind;
  zone: 'front' | 'pickup' | 'van';
  /** 店前：从哪条车道驶入（aisles 下标）、第几排、第几列 */
  aisle: number;
  row: number;
  col: number;
  /** 即时取货车位的编号（1…）、配送车位（V1…） */
  id?: string;
  w: number;
  d: number;
}

/** 长车位：最远一排靠路的半排两头；车头朝西（沿车道靠右停在车位前沿上），spots 从车头一端数 */
export interface LongBay {
  spots: number[];
  /** 车道中心、停放中线 */
  aisleZ: number;
  parkZ: number;
  /** 西头、东头的 x（xHead < xTail） */
  xHead: number;
  xTail: number;
  /** 车头朝哪头：-1 西、+1 东（都朝这一排的外头，开出来直接上两侧的车道） */
  nose: -1 | 1;
}

export type LongKind = 'rv' | 'camper' | 'boat' | 'utility';
/** 长车占几个车位（含车尾后面并进来用的一个）：房车 6，带房车拖挂或船 8，带小平板拖车 7 */
export const LONG_SPOTS: Record<LongKind, number> = { rv: 6, camper: 8, boat: 8, utility: 7 };

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** 免下车取货位：车头朝南停，司机一侧（左侧）对着墙上的取货口 */
export interface DriveBay {
  id: string;
  x: number;
  z: number;
  heading: number;
}

export interface WestStrip {
  wallX: number;
  /** 墙外人行道外沿、车位（配送车位、即时取货车位）的外沿、免下车车道的外沿 */
  walkX: number;
  stallX: number;
  driveX0: number;
  driveX1: number;
  /** 车道中心：免下车车道、往南的服务车道、往北的外侧车道；中间绿化带 */
  driveLaneX: number;
  serviceX: number;
  serviceHalf: number;
  outerX: number;
  medianX: [number, number];
  /** 南北范围：服务车道从回车场到店前，免下车车道 */
  zNorth: number;
  zSouth: number;
  driveZ: [number, number];
  /** 回车场：圆心、车道中心半径、铺装半径、中间绿岛半径 */
  bulb: { c: Pt; r: number; pave: number; island: number };
  /** 取货口（墙上）、雨棚范围 */
  hatch: Pt;
  canopy: Rect;
  /** 车道之间的路缘岛（免下车车道和服务车道之间） */
  curb: Rect;
}

export interface StoreLot {
  front: number;
  frontZ: number;
  fireLane: [number, number];
  x0: number;
  x1: number;
  /** 沥青区域靠路一侧的边、门前路的中心线和范围 */
  edgeZ: number;
  frontage: { z: number; x0: number; x1: number; half: number };
  /** 车道中心线（沿 x） */
  aisles: number[];
  /** 两侧环形车道中心线（西、东） */
  ring: [number, number];
  /** 车位列：起点、列数、哪几列是回收栏、人行通道 */
  rowX0: number;
  perRow: number;
  corralCols: number[];
  walkCol: number;
  walkX: number;
  stalls: Stall[];
  /** 店前车位（stalls 的前一段）、即时取货车位、配送车位在 stalls 里的下标 */
  frontStalls: number[];
  pickup: number[];
  vans: number[];
  drive: DriveBay[];
  long: LongBay[];
  islands: Array<Rect & { tree: boolean }>;
  corrals: Array<Rect & { aisleZ: number }>;
  /** 无障碍车位旁的斜线通道 */
  hatches: Rect[];
  /** 灯杆 */
  poles: Pt[];
  /** 斑马线（人行通道穿过车道和消防车道） */
  crossings: Rect[];
  /** 出入口：环形车道中心 x、进场车道 x、出场车道 x */
  gates: Array<{ x: number; inX: number; outX: number }>;
  doors: { entrance: Pt; exit: Pt };
  west: WestStrip;
  /** 指示牌：即时取货、免下车取货、自提柜、消防车道 */
  signs: Array<{ x: number; z: number; heading: number; text: string }>;
}

export interface LotInput {
  /** 店房正面墙的 z、店房东西两端的 x */
  front: number;
  storeX0: number;
  storeX1: number;
  /** 店门（入口、出口）在店外一侧的位置 */
  doors: { entrance: Pt; exit: Pt };
  /** 双排车位的组数 */
  rows: number;
  accessible?: number;
  ev?: number;
  /** 即时取货车位数、配送车装车位数 */
  pickup?: number;
  vans?: number;
}

/** 店前车道靠右：沿 +x 行驶时偏 +z，沿 −x 时偏 −z */
export const aisleLaneZ = (aisleZ: number, dirX: number): number => aisleZ + (dirX >= 0 ? AISLE_OFF : -AISLE_OFF);
/** 出入口、环形车道靠右：往北（−z，进场）走 x 大的一侧，往南（+z，出场）走 x 小的一侧 */
export const inLaneX = (px: number): number => px + LANE_OFF;
export const outLaneX = (px: number): number => px - LANE_OFF;

export function buildStoreLot(input: LotInput): StoreLot {
  const { front } = input;
  const rows = Math.max(1, Math.min(4, Math.round(input.rows)));
  const x0 = input.storeX0 - 22;
  const x1 = input.storeX1 + 9;
  const ring: [number, number] = [x0 + PERIM_W / 2, x1 - PERIM_W / 2];
  const spotX0 = x0 + PERIM_W + 1.5;
  const spotX1 = x1 - PERIM_W - 1.5;
  const perRow = Math.max(8, Math.floor((spotX1 - spotX0) / SPOT_W));
  const rowX0 = (spotX0 + spotX1) / 2 - (perRow * SPOT_W) / 2;
  const colX = (i: number) => rowX0 + (i + 0.5) * SPOT_W;
  const colOf = (x: number) => Math.max(0, Math.min(perRow - 1, Math.round((x - rowX0) / SPOT_W - 0.5)));
  const corralCols = perRow >= 12 ? [Math.round(perRow / 3), Math.round((perRow * 2) / 3)] : [Math.floor(perRow / 2)];
  // 人行通道：正对两樘店门中间的那一列（避开回收栏）
  const doorMid = (input.doors.entrance.x + input.doors.exit.x) / 2;
  let walkCol = colOf(doorMid);
  if (corralCols.includes(walkCol)) walkCol += walkCol + 1 < perRow ? 1 : -1;
  const walkX = colX(walkCol);

  const frontZ = front + WALK;
  const fireLane: [number, number] = [frontZ, frontZ + FIRE_LANE];
  const aisles: number[] = [];
  const stalls: Stall[] = [];
  const islands: StoreLot['islands'] = [];
  const corrals: StoreLot['corrals'] = [];
  const hatches: Rect[] = [];
  const poles: Pt[] = [];
  const crossings: Rect[] = [];
  const add = (s: Omit<Stall, 'i'>) => {
    const st = { ...s, i: stalls.length } as Stall;
    stalls.push(st);
    return st;
  };

  // 第一排（车头朝门店，从后面的车道驶入）：店门旁是无障碍车位（两个一组，中间 1.2 米宽的斜线轮椅通道，一组占三列），
  // 再往外是充电车位（车头前的路缘上有充电桩）
  let z = fireLane[1];
  const firstZ = z + SPOT_D / 2;
  z += SPOT_D;
  aisles.push(z + AISLE_W / 2);
  const ex = input.doors.entrance.x;
  const groups = Math.max(1, Math.round((input.accessible ?? 4) / 2));
  const accGroups: number[] = [];
  // 三列一组（不跨人行通道和回收栏），从离入口最近的往外挑
  const starts = Array.from({ length: perRow - 2 }, (_, i) => i)
    .filter((c) => [c, c + 1, c + 2].every((k) => k !== walkCol))
    .sort((a, b) => Math.abs(colX(a + 1) - ex) - Math.abs(colX(b + 1) - ex) || a - b);
  for (const c of starts) {
    if (accGroups.length >= groups) break;
    if (accGroups.some((g) => Math.abs(g - c) < 3)) continue;
    accGroups.push(c);
  }
  const accCols = new Set(accGroups.flatMap((c) => [c, c + 1, c + 2]));
  const evCols = new Set(
    Array.from({ length: perRow }, (_, i) => i)
      .filter((i) => i !== walkCol && !accCols.has(i))
      .sort((a, b) => Math.abs(colX(a) - ex) - Math.abs(colX(b) - ex) || a - b)
      .slice(0, input.ev ?? 4),
  );
  for (const c of accGroups.sort((a, b) => a - b)) {
    const xc = colX(c + 1);
    hatches.push({ x: xc, z: firstZ, w: ACCESS_AISLE, d: SPOT_D - 0.4 });
    for (const sgn of [-1, 1]) add({ x: xc + sgn * (ACCESS_AISLE / 2 + SPOT_W / 2), z: firstZ, heading: Math.PI, kind: 'accessible', zone: 'front', aisle: 0, row: 0, col: c + 1 + sgn, w: SPOT_W, d: SPOT_D });
  }
  for (let i = 0; i < perRow; i++) {
    if (i === walkCol || accCols.has(i)) continue;
    add({ x: colX(i), z: firstZ, heading: Math.PI, kind: evCols.has(i) ? 'ev' : 'general', zone: 'front', aisle: 0, row: 0, col: i, w: SPOT_W, d: SPOT_D });
  }
  islands.push({ x: rowX0 - 1.2, z: firstZ, w: 2.4, d: SPOT_D - 0.4, tree: true });
  islands.push({ x: rowX0 + perRow * SPOT_W + 1.2, z: firstZ, w: 2.4, d: SPOT_D - 0.4, tree: true });
  z += AISLE_W;

  // 双排车位
  for (let r = 0; r < rows; r++) {
    const near = z + SPOT_D / 2;
    const far = z + SPOT_D * 1.5;
    for (let i = 0; i < perRow; i++) {
      if (corralCols.includes(i)) {
        corrals.push({ x: colX(i), z: z + SPOT_D, w: SPOT_W - 0.4, d: SPOT_D * 2 - 1.2, aisleZ: z - AISLE_W / 2 });
        continue;
      }
      if (i === walkCol) continue;
      add({ x: colX(i), z: near, heading: 0, kind: 'general', zone: 'front', aisle: r, row: r + 1, col: i, w: SPOT_W, d: SPOT_D });
      add({ x: colX(i), z: far, heading: Math.PI, kind: 'general', zone: 'front', aisle: r + 1, row: r + 1, col: i, w: SPOT_W, d: SPOT_D });
    }
    islands.push({ x: rowX0 - 1.2, z: z + SPOT_D, w: 2.4, d: SPOT_D * 2 - 0.6, tree: true });
    islands.push({ x: rowX0 + perRow * SPOT_W + 1.2, z: z + SPOT_D, w: 2.4, d: SPOT_D * 2 - 0.6, tree: true });
    // 人行通道两边的窄绿化带（中间铺装）
    islands.push({ x: walkX - SPOT_W / 2 + 0.25, z: z + SPOT_D, w: 0.5, d: SPOT_D * 2 - 0.6, tree: false });
    islands.push({ x: walkX + SPOT_W / 2 - 0.25, z: z + SPOT_D, w: 0.5, d: SPOT_D * 2 - 0.6, tree: false });
    // 灯杆：双排中线上，回收栏和两头
    for (const c of [...corralCols, -1, perRow]) poles.push({ x: c < 0 ? rowX0 - 1.2 : c >= perRow ? rowX0 + perRow * SPOT_W + 1.2 : colX(c), z: z + SPOT_D });
    z += SPOT_D * 2;
    aisles.push(z + AISLE_W / 2);
    z += AISLE_W;
  }
  const edgeZ = z;
  // 斑马线：人行通道穿过每条车道、消防车道
  crossings.push({ x: walkX, z: (fireLane[0] + fireLane[1]) / 2, w: SPOT_W + 0.6, d: FIRE_LANE });
  for (const az of aisles) crossings.push({ x: walkX, z: az, w: SPOT_W + 0.6, d: AISLE_W });
  // 第一排的两头和消防车道外侧也有灯
  poles.push({ x: rowX0 - 1.2, z: firstZ }, { x: rowX0 + perRow * SPOT_W + 1.2, z: firstZ });

  const frontS = stalls.map((s) => s.i);

  // 长车位：最远一排靠路的半排（从最外侧车道驶入）两头，车头朝这一排的外头（西头的朝西、东头的朝东）
  const long: LongBay[] = [];
  const outer = aisles[rows] as number;
  const lastRow = stalls.filter((s) => s.zone === 'front' && s.row === rows && s.aisle === rows).sort((a, b) => a.x - b.x);
  const need = Math.max(...Object.values(LONG_SPOTS));
  const contiguous = (list: Stall[]) => list.every((e, k) => k === 0 || Math.abs(e.x - (list[k - 1] as Stall).x - SPOT_W) < 0.05);
  if (lastRow.length >= 2 * need + 2) {
    const parkZ = (lastRow[0] as Stall).z + SPOT_D / 2 - 1.4;
    const ends: Array<[Stall[], -1 | 1]> = [
      [lastRow.slice(0, need), -1],
      [lastRow.slice(-need), 1],
    ];
    for (const [list, nose] of ends) {
      if (!contiguous(list)) continue;
      long.push({ spots: list.map((s) => s.i), aisleZ: outer, parkZ, nose, xHead: (list[0] as Stall).x - SPOT_W / 2, xTail: (list[list.length - 1] as Stall).x + SPOT_W / 2 });
    }
  }

  // 西侧的即时取货区
  const wallX = input.storeX0;
  const walkW = 1.5;
  const stallX = wallX - walkW - SPOT_D;
  const driveX1 = wallX - walkW;
  const driveX0 = driveX1 - 3.5;
  const serviceX = stallX - 2.75;
  const outerX = inLaneX(ring[0]);
  const zSouth = frontZ;
  const driveZ: [number, number] = [front - 13, frontZ];
  const pickupN = input.pickup ?? 8;
  const vanN = input.vans ?? 2;
  const pickZ0 = driveZ[0] - 2 - (pickupN - 1) * PICKUP_PITCH;
  const pickup: number[] = [];
  for (let k = 0; k < pickupN; k++) {
    const s = add({ x: wallX - walkW - SPOT_D / 2, z: pickZ0 + k * PICKUP_PITCH, heading: Math.PI / 2, kind: 'pickup', zone: 'pickup', aisle: -1, row: -1, col: k, id: String(k + 1), w: PICKUP_PITCH, d: SPOT_D });
    pickup.push(s.i);
  }
  const vans: number[] = [];
  for (let k = 0; k < vanN; k++) {
    const s = add({ x: wallX - walkW - SPOT_D / 2, z: pickZ0 - PICKUP_PITCH / 2 - 1.7 - k * 3.4, heading: Math.PI / 2, kind: 'van', zone: 'van', aisle: -1, row: -1, col: k, id: `V${k + 1}`, w: 3.4, d: SPOT_D });
    vans.push(s.i);
  }
  const zNorth = pickZ0 - PICKUP_PITCH / 2 - 3.4 * vanN - 2;
  const bulbR = 5.85;
  const bulb = { c: { x: (outerX + serviceX) / 2 - 0.9, z: zNorth - 6 }, r: bulbR, pave: bulbR + 3.2, island: bulbR - 3.1 };
  // 免下车取货位：车道里一辆接一辆（车距 5.5 米，三个位置），第四辆在车道口等
  const drive: DriveBay[] = [0, 1, 2].map((k) => ({ id: `D${k + 1}`, x: (driveX0 + driveX1) / 2, z: driveZ[1] - 3 - (2 - k) * 5.5, heading: 0 }));
  const west: WestStrip = {
    wallX,
    walkX: wallX - walkW,
    stallX,
    driveX0,
    driveX1,
    driveLaneX: (driveX0 + driveX1) / 2,
    serviceX,
    serviceHalf: 2.75,
    outerX,
    medianX: [outerX + 2, serviceX - 2.75],
    zNorth,
    zSouth,
    driveZ,
    bulb,
    hatch: { x: wallX, z: driveZ[0] + 4 },
    canopy: { x: (wallX + driveX0 - 1.8) / 2, z: driveZ[0] + 7.5, w: wallX - driveX0 + 1.8, d: 13 },
    curb: { x: (driveX0 + stallX) / 2, z: (driveZ[0] + 0.6 + driveZ[1] - 1.2) / 2, w: driveX0 - stallX, d: driveZ[1] - driveZ[0] - 1.8 },
  };
  poles.push({ x: (west.medianX[0] + west.medianX[1]) / 2, z: zNorth + 6 }, { x: (west.medianX[0] + west.medianX[1]) / 2, z: (zNorth + zSouth) / 2 }, { x: west.curb.x, z: driveZ[0] + 1 });

  const gates = ring.map((px) => ({ x: px, inX: inLaneX(px), outX: outLaneX(px) }));
  const frontage = { z: edgeZ + EDGE + FRONTAGE / 2, x0: x0 - FLARE - 4, x1: x1 + FLARE + 2, half: FRONTAGE / 2 };
  const signs: StoreLot['signs'] = [
    { x: west.outerX - 3, z: zSouth - 2, heading: Math.PI, text: '即时取货 · 自提柜 · 免下车取货' },
    { x: west.curb.x, z: driveZ[1] - 1.5, heading: 0, text: '免下车取货' },
    { x: (west.medianX[0] + west.medianX[1]) / 2, z: pickZ0 + ((pickupN - 1) * PICKUP_PITCH) / 2, heading: Math.PI / 2, text: `即时取货 · ${pickupN} 个车位` },
    { x: x0 + 2, z: (fireLane[0] + fireLane[1]) / 2, heading: Math.PI / 2, text: '消防车道 · 禁止停车' },
  ];
  return {
    front,
    frontZ,
    fireLane,
    x0,
    x1,
    edgeZ,
    frontage,
    aisles,
    ring,
    rowX0,
    perRow,
    corralCols,
    walkCol,
    walkX,
    stalls,
    frontStalls: frontS,
    pickup,
    vans,
    drive,
    long,
    islands,
    corrals,
    hatches,
    poles,
    crossings,
    gates,
    doors: input.doors,
    west,
    signs,
  };
}

/** 长车位里实际占用的车位（按车型，从车头一端数） */
export function bayCovers(bay: LongBay, kind: LongKind): number[] {
  // 从车头那头数
  return bay.nose > 0 ? bay.spots.slice(-LONG_SPOTS[kind]) : bay.spots.slice(0, LONG_SPOTS[kind]);
}

/** 门店本地坐标的范围（停车场、门前路、西侧取货区）：站点轮廓用 */
export function lotBounds(lot: StoreLot): { x0: number; x1: number; z0: number; z1: number } {
  return { x0: Math.min(lot.x0, lot.west.bulb.c.x - lot.west.bulb.pave) - 2, x1: lot.x1, z0: lot.west.bulb.c.z - lot.west.bulb.pave - 1, z1: lot.frontage.z + lot.frontage.half + 2 };
}

/** 车位按离店门的距离排（越近越容易停满） */
export function doorDistance(lot: StoreLot, s: Stall): number {
  const d = lot.doors.entrance;
  // 走路的距离：沿车道走到人行通道，再沿通道走到店门
  return Math.abs(s.x - lot.walkX) + Math.abs(s.z - d.z) + Math.abs(lot.walkX - d.x) * 0.3;
}

/** 店前车位按双排数估算的车位数（选双排组数用） */
export function frontCapacity(rows: number, perRow = 34): number {
  return perRow - 4 + rows * (perRow - 3) * 2;
}
