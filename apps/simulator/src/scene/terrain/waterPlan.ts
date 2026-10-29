import { createRng } from '@storewright/domain';
import type { Pt } from '../lot';

/**
 * 门店周边的水系（纯函数，可复现）：
 * - 湖（港池）：在主路对面、门店右前方，岸线是加了起伏的椭圆，北岸有栈桥码头和小广场，一圈环湖步道；
 * - 出海口（决策记录 0019）：湖的南岸接一条 14 米宽的出海水道，向南通到场地前沿的海湾，水道口两侧各有一道
 *   伸进海湾的防波堤，堤头有航标灯（进港方向右红左绿）；湖面和海面同一水位，船只经水道进出港；
 * - 河：从场地后方流过来，沿着进场道路外面向南，穿过主路下面的石拱桥进入石砌渠道，在渠口漫过跌水堰流进湖里
 *   （河水比湖面高）；离开路口后渐渐变成自然河岸并蜿蜒；
 * - 堰上游有一座木制人行小桥。
 * 没有水面时（周边环境设置）各部分都是空的，场地是平地。
 * 坐标与场景一致：门店正面朝 −Z，主路在门店前方沿 X 方向。地面高度 −0.1 米（原地面板的顶面）。
 */

export const GROUND_Y = -0.1;

export interface RiverPlan {
  /** 渠道段的中心线 x（直线段），过桥处也是这条线 */
  x: number;
  /** 水面半宽 */
  half: number;
  /** 渠口（跌水堰）的 z；河道从这里向 +Z 方向延伸 */
  zWeir: number;
  /** 渠道（石砌直墙）结束的 z，此后河岸逐渐变成自然斜坡 */
  zCanalEnd: number;
  /** 河道终点（场地边缘外） */
  zEnd: number;
  /** 蜿蜒：幅度与波长（只在渠道段之后） */
  amp: number;
  wave: number;
  /** 水面与河床高度 */
  level: number;
  bed: number;
  /** 自然河岸的坡宽 */
  bank: number;
}

export interface LakePlan {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  /** 水边线（闭合多边形，逆时针） */
  shore: Pt[];
  level: number;
  bed: number;
  /** 岸坡宽度随方位变化：bankBase + bankVar * (1 + sin(2θ + bankPhase)) / 2 */
  bankBase: number;
  bankVar: number;
  bankPhase: number;
  /** 湖与渠道之间的渠口（石墙夹着的一小段湖水，到跌水堰为止） */
  neck: { x0: number; x1: number; z0: number; z1: number };
}

export interface BridgePlan {
  /** 桥面范围：x 方向跨过渠道（含两侧石墙），z 方向是整条主路加两侧人行道 */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 路面高度（与道路沥青面一致） */
  deckTop: number;
  /** 中间桥墩的半宽（两孔拱桥） */
  pierHalf: number;
  /** 拱脚与拱顶高度 */
  spring: number;
  crown: number;
}

export interface Boat {
  x: number;
  z: number;
  heading: number;
  color: string;
  /** 划艇、开放式快艇、小帆船、皮划艇、浮筒船（决策记录 0018） */
  kind: 'row' | 'motor' | 'sail' | 'kayak' | 'pontoon';
}

export interface PierPlan {
  /** 栈桥中线 x，岸上一端与湖里一端的 z（湖在 −Z 方向） */
  x: number;
  zLand: number;
  zEnd: number;
  width: number;
  /** 栈桥尽头的 T 形平台 */
  head: { w: number; d: number };
  deckY: number;
  boats: Boat[];
}

/** 出海口：水道（湖的南岸 → 海湾）、海湾（场地前沿的半椭圆）、两道防波堤 */
export interface OutletPlan {
  x: number;
  half: number;
  /** 水道从 z1（湖里）向 −Z 到 z0（海湾里） */
  z0: number;
  z1: number;
  bay: { cx: number; cz: number; rx: number; rz: number };
  /** 防波堤（轴对齐的石堤），堤头航标灯的颜色 */
  jetties: Array<{ x0: number; x1: number; z0: number; z1: number; light: 'red' | 'green' }>;
  bed: number;
  /** 环湖步道跨过水道的人行开启桥（帆船经过时两扇桥面抬起）：x 范围、中线 z、宽度 */
  bridge: { x0: number; x1: number; z: number; width: number };
}

export interface WaterPlan {
  /** 有没有水面（周边环境设置，决策记录 0019） */
  enabled: boolean;
  groundY: number;
  /** 场地前沿：有出海口时要包住海湾 */
  minZ: number;
  outlet?: OutletPlan;
  river: RiverPlan;
  lake: LakePlan;
  bridge: BridgePlan;
  pier: PierPlan;
  /** 栈桥岸边的小广场 */
  plaza: { x: number; z: number; w: number; d: number };
  /** 堰下游的人行木桥（跨渠道，沿 X 方向） */
  footbridge: { x0: number; x1: number; z: number; width: number };
  /** 环湖步道离水边线的距离 */
  pathOffset: number;
  /** 不能放建筑的区域 */
  keepOut: Array<{ x: number; z: number; w: number; d: number }>;
  /** 右侧支路西缘不能小于这个 x */
  rightClear: number;
  /** 湖边、河边的树 */
  trees: Array<{ x: number; z: number; s: number; kind: 'round' | 'cone' }>;
  /** 步道与广场的路灯 */
  lamps: Pt[];
  /** 长椅：位置与朝向（面向湖） */
  benches: Array<{ x: number; z: number; heading: number }>;
}

export function smooth01(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

/** 点到闭合多边形的有符号距离：在内部为正 */
export function polySdf(poly: readonly Pt[], x: number, z: number): number {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Pt;
    const b = poly[j] as Pt;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const wx = x - a.x;
    const wz = z - a.z;
    const t = Math.min(1, Math.max(0, (wx * ex + wz * ez) / (ex * ex + ez * ez || 1)));
    const dx = wx - ex * t;
    const dz = wz - ez * t;
    d = Math.min(d, dx * dx + dz * dz);
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside ? Math.sqrt(d) : -Math.sqrt(d);
}

/** 轴对齐矩形的有符号距离：在内部为正 */
export function boxSdf(b: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number): number {
  const dx = Math.min(x - b.x0, b.x1 - x);
  const dz = Math.min(z - b.z0, b.z1 - z);
  if (dx >= 0 && dz >= 0) return Math.min(dx, dz);
  const ox = Math.max(b.x0 - x, 0, x - b.x1);
  const oz = Math.max(b.z0 - z, 0, z - b.z1);
  return -Math.hypot(ox, oz);
}

/** 河道中心线在 z 处的 x：渠道段是直线，之后逐渐开始蜿蜒（只向东偏，不靠近门店） */
export function riverX(r: RiverPlan, z: number): number {
  const u = z - r.zCanalEnd - 4;
  if (u <= 0) return r.x;
  const k = smooth01(u / 30);
  return r.x + r.amp * k * 0.5 * (1 - Math.cos((u / r.wave) * Math.PI * 2));
}

/** 河岸坡宽：渠道段是石墙（墙后只留很窄的一点坡），之后过渡到自然河岸 */
export function riverBank(r: RiverPlan, z: number): number {
  return WALL_BANK + (r.bank - WALL_BANK) * smooth01((z - r.zCanalEnd) / 8);
}

/** 石墙段的坡宽（藏在墙后面） */
export const WALL_BANK = 0.625;

/** 河道的有符号距离（水里为正）；跌水堰上游不属于河道 */
export function riverSdf(r: RiverPlan, x: number, z: number): number {
  if (z < r.zWeir) return -1e6;
  return r.half - Math.abs(x - riverX(r, z));
}

/** 湖（含渠口）的有符号距离 */
export function lakeSdf(l: LakePlan, x: number, z: number): number {
  if (!l.shore.length) return -1e6;
  return Math.max(polySdf(l.shore, x, z), boxSdf(l.neck, x, z));
}

/** 出海口（水道和海湾）的有符号距离（水里为正） */
export function outletSdf(o: OutletPlan | undefined, x: number, z: number): number {
  if (!o) return -1e6;
  const ch = boxSdf({ x0: o.x - o.half, x1: o.x + o.half, z0: o.z0, z1: o.z1 }, x, z);
  // 海湾：半椭圆（按到椭圆边界的近似距离）
  const b = o.bay;
  const u = (x - b.cx) / b.rx;
  const v = (z - b.cz) / b.rz;
  const r = Math.hypot(u, v);
  const bay = (1 - r) * Math.min(b.rx, b.rz);
  return Math.max(ch, bay);
}

/** 港池和海：湖、渠口、出海水道和海湾（同一水位） */
export function harborSdf(w: WaterPlan, x: number, z: number): number {
  return Math.max(lakeSdf(w.lake, x, z), outletSdf(w.outlet, x, z));
}

/** 湖岸坡宽（随方位变化：有的地方是缓坡沙滩，有的地方陡一些） */
export function lakeBank(l: LakePlan, x: number, z: number): number {
  const a = Math.atan2(z - l.cz, x - l.cx);
  return l.bankBase + l.bankVar * 0.5 * (1 + Math.sin(2 * a + l.bankPhase));
}

/**
 * 地形剖面：s 为到水边线的有符号距离（水里为正），bank 为岸坡宽。
 * 岸上：坡顶圆滑，越靠近水边越陡（水边线附近的地形和水面交得干脆，不会大片重叠闪烁）；
 * 水下：继续以同样的坡度下降，约 2.5 米后到达河床。
 */
export function carve(s: number, bank: number, ground: number, level: number, bed: number): number {
  if (s <= -bank) return ground;
  if (s < 0) {
    const t = (s + bank) / bank;
    return ground + (level - ground) * t * t;
  }
  const depthW = Math.max(1.2, Math.min(3, ((bed - level) / (level - ground || -1)) * bank));
  const u = Math.min(1, s / depthW);
  return level + (bed - level) * (1 - (1 - u) * (1 - u));
}

/** 地形高度：地面被湖、渠口、出海口和河道挖下去 */
export function terrainY(w: WaterPlan, x: number, z: number): number {
  if (!w.enabled) return w.groundY;
  const g = w.groundY;
  let h = g;
  const l = w.lake;
  const ls = polySdf(l.shore, x, z);
  if (ls > -12) h = Math.min(h, carve(ls, lakeBank(l, x, z), g, l.level, l.bed));
  const ns = boxSdf(l.neck, x, z);
  if (ns > -2) h = Math.min(h, carve(ns, WALL_BANK, g, l.level, l.bed));
  const os = outletSdf(w.outlet, x, z);
  if (os > -12) h = Math.min(h, carve(os, OUTLET_BANK, g, l.level, w.outlet?.bed ?? l.bed));
  const r = w.river;
  const rs = riverSdf(r, x, z);
  if (rs > -12) h = Math.min(h, carve(rs, riverBank(r, z), g, r.level, r.bed));
  return h;
}

/** 出海口两岸的坡宽（石砌护岸，比湖岸陡） */
export const OUTLET_BANK = 2.2;

/** 某点在哪片水里：'lake'（含出海口）| 'river' | undefined，以及到水边线的距离（水里为正） */
export function waterAt(w: WaterPlan, x: number, z: number): { body?: 'lake' | 'river'; s: number } {
  const ls = harborSdf(w, x, z);
  const rs = riverSdf(w.river, x, z);
  if (ls >= rs) return { body: ls > 0 ? 'lake' : undefined, s: ls };
  return { body: rs > 0 ? 'river' : undefined, s: rs };
}

/** 多边形在竖线 x 上最北（z 最大）的交点 */
function northShoreZ(poly: readonly Pt[], x: number): number | undefined {
  let best: number | undefined;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Pt;
    const b = poly[j] as Pt;
    if (a.x > x === b.x > x) continue;
    const z = a.z + ((x - a.x) / (b.x - a.x)) * (b.z - a.z);
    if (best === undefined || z > best) best = z;
  }
  return best;
}

export interface WaterInput {
  lot: { minX: number; maxX: number; edgeZ: number };
  store: { maxZ: number };
  roadTopZ: number;
  roadBottomZ: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 右侧后勤通道外沿 */
  serviceX1: number;
  /** 门店左侧（x 小于停车场）的支路中心线与半宽（湖不能压到它们） */
  leftRoads: Array<{ x: number; half: number }>;
  seed: number;
  /** 没有水面时为 false */
  enabled?: boolean;
}

/** 没有水面：各部分都是空的（放在场地外，尺寸为 0） */
function emptyWater(input: WaterInput): WaterPlan {
  const far = input.maxX + 1000;
  return {
    enabled: false,
    groundY: GROUND_Y,
    minZ: input.minZ,
    river: { x: far, half: 0, zWeir: 1e9, zCanalEnd: 1e9, zEnd: 1e9, amp: 0, wave: 100, level: GROUND_Y, bed: GROUND_Y, bank: 1 },
    lake: { cx: far, cz: 0, rx: 1, rz: 1, shore: [], level: GROUND_Y, bed: GROUND_Y, bankBase: 1, bankVar: 0, bankPhase: 0, neck: { x0: far, x1: far, z0: 0, z1: 0 } },
    bridge: { x0: far, x1: far, z0: 0, z1: 0, deckTop: 0, pierHalf: 0, spring: 0, crown: 0 },
    pier: { x: far, zLand: 0, zEnd: 0, width: 0, head: { w: 0, d: 0 }, deckY: 0, boats: [] },
    plaza: { x: far, z: 0, w: 0, d: 0 },
    footbridge: { x0: far, x1: far, z: 0, width: 0 },
    pathOffset: 0,
    keepOut: [],
    rightClear: input.serviceX1,
    trees: [],
    lamps: [],
    benches: [],
  };
}

const SIDEWALK = 2.4;

/**
 * 港池（湖）与海的水位、河的水位：河水比湖面高 0.6 米，经跌水堰流进湖里；湖面（海平面）比地面低约 2.9 米，
 * 岸边是石砌护岸和缓坡，栈桥顺着坡道下到水面附近
 */
export const HARBOR_LEVEL = -3.0;
export const RIVER_LEVEL = -2.4;

export function planWater(input: WaterInput): WaterPlan {
  if (input.enabled === false) return emptyWater(input);
  const rng = createRng(input.seed * 4513 + 97);
  const g = GROUND_Y;
  const half = 5;
  const riverXc = input.serviceX1 + 16;
  const farWalk = input.roadBottomZ - SIDEWALK;
  const nearWalk = input.roadTopZ + SIDEWALK;

  // 湖：北岸离路边人行道 17 米（中间是广场和步道），湖心在出水口西边
  let rx = rng.uniform(34, 40);
  const rz = rng.uniform(23, 27);
  const bankBase = 6;
  const bankVar = 3;
  const margin = bankBase + bankVar + 3.5;
  // 左边不能压到左侧的支路
  const leftLimit = Math.max(input.minX + 8, ...input.leftRoads.filter((r) => r.x < riverXc).map((r) => r.x + r.half + SIDEWALK + 2));
  rx = Math.max(16, Math.min(rx, (riverXc - leftLimit - margin) / 1.86));
  const cx = riverXc - 0.7 * rx;
  const top = farWalk - 15;
  const cz = top - rz;
  const ph = [rng.uniform(0, 6.28), rng.uniform(0, 6.28), rng.uniform(0, 6.28)];
  const shore: Pt[] = [];
  const N = 120;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const k = 1 + 0.08 * Math.sin(3 * a + (ph[0] as number)) + 0.05 * Math.sin(5 * a + (ph[1] as number)) + 0.025 * Math.sin(9 * a + (ph[2] as number));
    let x = cx + Math.cos(a) * rx * k;
    let z = cz + Math.sin(a) * rz * k;
    // 东边不越过出水口太多（右侧支路可以离得近一些）
    if (x > riverXc + 3) x = riverXc + 3 + (x - riverXc - 3) * 0.25;
    if (z > top) z = top - (z - top) * 0.2;
    shore.push({ x, z });
  }
  const zShore = northShoreZ(shore, riverXc) ?? cz + rz * 0.7;
  const zWeir = zShore + 3.2;
  const neck = { x0: riverXc - half, x1: riverXc + half, z0: zShore - 2.5, z1: zWeir };
  const lake: LakePlan = { cx, cz, rx, rz, shore, level: HARBOR_LEVEL, bed: -4.8, bankBase, bankVar, bankPhase: rng.uniform(0, 6.28), neck };

  const zCanalEnd = nearWalk + 14;
  const river: RiverPlan = { x: riverXc, half, zWeir, zCanalEnd, zEnd: input.maxZ + 12, amp: rng.uniform(6, 10), wave: rng.uniform(80, 110), level: RIVER_LEVEL, bed: -3.7, bank: 3.6 };

  const bridge: BridgePlan = { x0: riverXc - half - 1.3, x1: riverXc + half + 1.3, z0: farWalk, z1: nearWalk, deckTop: -0.04, pierHalf: 0.65, spring: -2.25, crown: -0.78 };

  // 栈桥：北岸，出水口西边；岸上一端落在平地上
  const px = cx - 0.22 * rx;
  const shoreN = northShoreZ(shore, px) ?? top;
  const zLand = shoreN + bankBase + bankVar + 1.2;
  const zEnd = shoreN - Math.min(20, rz * 0.8);
  const BOAT = ['#d9643a', '#3f7fb8', '#e9d6a8', '#4c9a6a', '#c8453f'];
  const head = { w: 10, d: 3.2 };
  // 系在栈桥边的船：T 形平台外侧一条小帆船、一条浮筒船；栈桥两侧快艇、划艇，靠岸一端两条皮划艇
  const mid = (zEnd + shoreN) / 2;
  const boats: Boat[] = [
    { x: px - head.w / 2 + 2.7, z: zEnd - head.d / 2 - 1.65, heading: Math.PI / 2 + rng.uniform(-0.04, 0.04), color: rng.pick(['#26354f', '#8a2f2a', '#2f5f4f']), kind: 'sail' },
    { x: px + head.w / 2 - 2.6, z: zEnd - head.d / 2 - 1.75, heading: -Math.PI / 2 + rng.uniform(-0.04, 0.04), color: rng.pick(['#2f8f8f', '#3f7fb8', '#8a5a3c']), kind: 'pontoon' },
    { x: px - 1.3 - 1.6, z: mid - 2, heading: rng.uniform(-0.05, 0.05), color: rng.pick(BOAT), kind: 'motor' },
    { x: px + 1.3 + 1.1, z: mid + 1, heading: Math.PI + rng.uniform(-0.1, 0.1), color: '#3f7fb8', kind: 'row' },
  ];
  {
    const br = createRng(input.seed * 6173 + 29);
    boats.push({ x: px + 1.3 + 1.1, z: mid - 4, heading: Math.PI + br.uniform(-0.1, 0.1), color: br.pick(BOAT), kind: 'row' });
    boats.push({ x: px - 1.3 - 1.1, z: mid + 4, heading: br.uniform(-0.1, 0.1), color: br.pick(BOAT), kind: 'row' });
    boats.push({ x: px + 1.3 + 0.75, z: shoreN - 4.2, heading: Math.PI + br.uniform(-0.08, 0.08), color: '#e0a42f', kind: 'kayak' });
    boats.push({ x: px + 1.3 + 1.55, z: shoreN - 4.6, heading: Math.PI + br.uniform(-0.08, 0.08), color: '#c8453f', kind: 'kayak' });
  }
  // 栈桥的桥面比水面高 0.75 米（湖面比地面低 1.9 米）：岸上一端顺着坡道下来
  const pier: PierPlan = { x: px, zLand, zEnd, width: 2.6, head, deckY: lake.level + 0.75, boats };
  const plaza = { x: px, z: Math.min(zLand + 3.4, farWalk - 3.4), w: 14, d: 6 };

  const footbridge = { x0: riverXc - half - 0.8, x1: riverXc + half + 0.8, z: zWeir + 6, width: 2.2 };

  // 出海口：湖的南岸接一条出海水道，向南 16 米进入场地前沿的海湾（场地边缘切在海湾中间），水道口两侧是防波堤
  let wx0 = Infinity;
  let wx1 = -Infinity;
  for (const p of shore) {
    wx0 = Math.min(wx0, p.x);
    wx1 = Math.max(wx1, p.x);
  }
  const chHalf = 7;
  const chX = Math.min(wx1 - chHalf - 6, Math.max(wx0 + chHalf + 6, cx + 0.12 * rx));
  const zSouth = southShoreZ(shore, chX) ?? cz - rz;
  const bayTop = zSouth - 16;
  const bay = { cx: (wx0 + wx1) / 2, cz: bayTop - 36, rx: (wx1 - wx0) / 2 + 4, rz: 36 };
  const outlet: OutletPlan = {
    x: chX,
    half: chHalf,
    z0: bayTop - 3,
    z1: zSouth + 3,
    bay,
    jetties: [
      { x0: chX - chHalf - 3.4, x1: chX - chHalf, z0: bayTop - 17, z1: bayTop + 1.5, light: 'red' },
      { x0: chX + chHalf, x1: chX + chHalf + 3.4, z0: bayTop - 17, z1: bayTop + 1.5, light: 'green' },
    ],
    bed: -5.4,
    // 环湖步道离湖岸 pathOffset 米：在水道上与它相交的地方架一座开启桥
    bridge: { x0: chX - chHalf - OUTLET_BANK - 0.6, x1: chX + chHalf + OUTLET_BANK + 0.6, z: zSouth - (bankBase + bankVar + 1.6), width: 2.4 },
  };
  // 场地前沿切在海湾中间：出海口外留一段海面，看得见船只进港、离港
  const minZ = bay.cz;
  const pathOffset = bankBase + bankVar + 1.6;

  // 禁建区：湖（含岸坡和步道）、广场、河道两侧
  const keepOut: WaterPlan['keepOut'] = [];
  let lx0 = Infinity;
  let lx1 = -Infinity;
  let lz0 = Infinity;
  let lz1 = -Infinity;
  for (const p of shore) {
    lx0 = Math.min(lx0, p.x);
    lx1 = Math.max(lx1, p.x);
    lz0 = Math.min(lz0, p.z);
    lz1 = Math.max(lz1, p.z);
  }
  const m = pathOffset + 3;
  keepOut.push({ x: (lx0 + lx1) / 2, z: (lz0 + lz1) / 2, w: lx1 - lx0 + 2 * m, d: lz1 - lz0 + 2 * m });
  keepOut.push({ x: plaza.x, z: plaza.z, w: plaza.w + 2, d: plaza.d + 2 });
  // 出海水道和海湾（含两岸的步道余量）
  keepOut.push({ x: chX, z: (outlet.z0 + outlet.z1) / 2, w: 2 * (chHalf + OUTLET_BANK + 5), d: outlet.z1 - outlet.z0 });
  keepOut.push({ x: bay.cx, z: bay.cz + bay.rz / 2 + 2, w: 2 * (bay.rx + 4), d: bay.rz + 8 });
  let rightClear = lx1 + m;
  for (let z = zShore - 4; z < river.zEnd; z += 8) {
    const xa = Math.min(riverX(river, z), riverX(river, z + 8));
    const xb = Math.max(riverX(river, z), riverX(river, z + 8));
    const b = Math.max(riverBank(river, z), riverBank(river, z + 8)) + 4;
    keepOut.push({ x: (xa + xb) / 2, z: z + 4, w: xb - xa + 2 * (half + b), d: 8 });
    rightClear = Math.max(rightClear, xb + half + b);
  }

  // 湖边的树：岸坡顶外侧一圈，北岸广场和栈桥附近留空；河的自然段两岸也种一些
  const trees: WaterPlan['trees'] = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rng.uniform(-0.08, 0.08);
    const k = 1 + 0.08 * Math.sin(3 * a + (ph[0] as number)) + 0.05 * Math.sin(5 * a + (ph[1] as number));
    const off = pathOffset + rng.uniform(2.6, 6);
    const x = cx + Math.cos(a) * (rx * k + off);
    const z = cz + Math.sin(a) * (rz * k + off);
    if (z > top - 4 && Math.abs(x - px) < 12) continue;
    if (Math.abs(x - riverXc) < half + 9 && z > zShore - 10) continue;
    if (z > farWalk - 2) continue;
    trees.push({ x, z, s: rng.uniform(0.9, 1.35), kind: rng.chance(0.3) ? 'cone' : 'round' });
  }
  for (let z = zCanalEnd + 10; z < input.maxZ - 4; z += rng.uniform(9, 15)) {
    const side = rng.chance(0.5) ? 1 : -1;
    const b = riverBank(river, z);
    const x = riverX(river, z) + side * (half + b + rng.uniform(2.2, 5));
    // 后勤通道和卸货场（到后墙外 80 米）旁边不种树，货车转弯时车头车尾不扫到
    if (side < 0 && x < input.serviceX1 + 6 && z < input.store.maxZ + 80) continue;
    trees.push({ x, z, s: rng.uniform(0.9, 1.3), kind: rng.chance(0.25) ? 'cone' : 'round' });
  }

  // 环湖步道的路灯和长椅（北半圈），广场四角的灯
  const lamps: Pt[] = [];
  const benches: WaterPlan['benches'] = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    if (i % 4 !== 0) continue;
    const k = 1 + 0.08 * Math.sin(3 * a + (ph[0] as number)) + 0.05 * Math.sin(5 * a + (ph[1] as number));
    const x = cx + Math.cos(a) * (rx * k + pathOffset + 1.6);
    const z = cz + Math.sin(a) * (rz * k + pathOffset + 1.6);
    if (Math.abs(x - riverXc) < half + 7) continue;
    if (Math.abs(x - px) < 9 && z > top - 6) continue;
    lamps.push({ x, z });
    if (i % 8 === 0) {
      const bx = cx + Math.cos(a + 0.05) * (rx * k + pathOffset - 0.9);
      const bz = cz + Math.sin(a + 0.05) * (rz * k + pathOffset - 0.9);
      benches.push({ x: bx, z: bz, heading: Math.atan2(cx - bx, cz - bz) });
    }
  }
  for (const dx of [-plaza.w / 2 + 0.6, plaza.w / 2 - 0.6]) lamps.push({ x: plaza.x + dx, z: plaza.z + plaza.d / 2 - 0.6 });
  for (const dx of [-4.2, 4.2]) benches.push({ x: plaza.x + dx, z: plaza.z - plaza.d / 2 + 1.2, heading: Math.PI });

  // 出海水道两岸各种几棵树
  for (const side of [-1, 1]) for (let z = outlet.z0 + 4; z < outlet.z1 - 2; z += 7) trees.push({ x: chX + side * (chHalf + OUTLET_BANK + 3), z, s: rng.uniform(0.85, 1.15), kind: rng.chance(0.5) ? 'cone' : 'round' });

  return { enabled: true, groundY: g, minZ, outlet, river, lake, bridge, pier, plaza, footbridge, pathOffset, keepOut, rightClear, trees, lamps, benches };
}

/** 多边形在竖线 x 上最南（z 最小）的交点 */
function southShoreZ(poly: readonly Pt[], x: number): number | undefined {
  let best: number | undefined;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Pt;
    const b = poly[j] as Pt;
    if (a.x > x === b.x > x) continue;
    const z = a.z + ((x - a.x) / (b.x - a.x)) * (b.z - a.z);
    if (best === undefined || z < best) best = z;
  }
  return best;
}
