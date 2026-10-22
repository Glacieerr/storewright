import { createRng, lbToKg, type TempZone } from '@storewright/domain';
import type { CategoryConfig, RunConfig, StagingRackConfig, StoreConfig, SizeRule } from './schema';

/**
 * 门店模板（决策 G-03）：小型 / 中型（默认）/ 大型。
 * 三个模板共用同一套 schema，只是参数不同，用来证明同一套配置可以上下伸缩。
 * 第四个模板是另一个行业（家居建材，决策记录 0011）：同一套 schema 和核心，换品类、布局和需求形态。
 */

export type TemplateName = 'small' | 'medium' | 'large' | 'hardware';
export type Industry = 'GROCERY' | 'HARDWARE';

/** 默认商品类别字典；门店可以任意增删（决策 C-01） */
export const DEFAULT_CATEGORIES: CategoryConfig[] = [
  { id: 'produce-amb', name: 'Produce (ambient)', nameZh: '常温蔬果', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'produce-chl', name: 'Produce (chilled)', nameZh: '冷藏蔬果', tempZone: 'CHILLED', fulfillmentType: 'GROCERY', handling: ['FRAGILE'], crushClass: 2, seasonal: false },
  { id: 'bakery', name: 'Bakery', nameZh: '烘焙', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['FRAGILE'], crushClass: 3, seasonal: false },
  { id: 'snacks', name: 'Snacks', nameZh: '零食', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['FRAGILE'], crushClass: 3, seasonal: false },
  { id: 'dry-goods', name: 'Dry goods', nameZh: '干货', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'canned', name: 'Canned goods', nameZh: '罐头', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 0, seasonal: false },
  { id: 'breakfast', name: 'Cereal & breakfast', nameZh: '早餐谷物', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 2, seasonal: false },
  { id: 'beverages', name: 'Beverages', nameZh: '饮料', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 0, seasonal: false },
  { id: 'water', name: 'Water & soda cases', nameZh: '整箱饮用水', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 0, seasonal: false },
  { id: 'alcohol', name: 'Beer & wine', nameZh: '酒类', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['AGE_RESTRICTED'], crushClass: 0, seasonal: false },
  { id: 'dairy', name: 'Dairy', nameZh: '乳制品', tempZone: 'CHILLED', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'eggs', name: 'Eggs', nameZh: '鸡蛋', tempZone: 'CHILLED', fulfillmentType: 'GROCERY', handling: ['FRAGILE'], crushClass: 3, seasonal: false },
  { id: 'meat', name: 'Meat & seafood', nameZh: '肉类海鲜', tempZone: 'CHILLED', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'deli', name: 'Deli (packaged)', nameZh: '预包装熟食', tempZone: 'CHILLED', fulfillmentType: 'GROCERY', handling: [], crushClass: 2, seasonal: false },
  { id: 'frozen-meals', name: 'Frozen meals', nameZh: '冷冻餐', tempZone: 'FROZEN', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'frozen-veg', name: 'Frozen vegetables', nameZh: '冷冻蔬菜', tempZone: 'FROZEN', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'ice-cream', name: 'Ice cream', nameZh: '冰淇淋', tempZone: 'FROZEN', fulfillmentType: 'GROCERY', handling: [], crushClass: 2, seasonal: false },
  { id: 'ice', name: 'Bagged ice', nameZh: '袋装冰', tempZone: 'FROZEN', fulfillmentType: 'GROCERY', handling: [], crushClass: 0, seasonal: false },
  { id: 'cleaning', name: 'Cleaning', nameZh: '清洁用品', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['CHEMICAL'], crushClass: 0, seasonal: false },
  { id: 'paper', name: 'Paper goods', nameZh: '纸品', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 2, seasonal: false },
  { id: 'health-beauty', name: 'Health & beauty', nameZh: '个护保健', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 2, seasonal: false },
  { id: 'baby', name: 'Baby', nameZh: '母婴', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'pet', name: 'Pet', nameZh: '宠物用品', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 0, seasonal: false },
  { id: 'household', name: 'Household', nameZh: '家居日用', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'electronics', name: 'Electronics', nameZh: '电子产品', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: ['SECURED'], crushClass: 1, seasonal: false },
  { id: 'toys', name: 'Toys', nameZh: '玩具', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 2, seasonal: false },
  { id: 'home', name: 'Home & décor', nameZh: '家居装饰', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 1, seasonal: false },
  { id: 'apparel', name: 'Apparel', nameZh: '服饰', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 3, seasonal: false },
  { id: 'automotive', name: 'Automotive', nameZh: '汽车用品', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 0, seasonal: false },
  { id: 'outdoor', name: 'Outdoor', nameZh: '户外用品', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 1, seasonal: false },
  { id: 'seasonal', name: 'Seasonal', nameZh: '节日季节', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 2, seasonal: true },
  { id: 'hot-deli', name: 'Hot deli (made-to-order)', nameZh: '热食现做', tempZone: 'HOT', fulfillmentType: 'MTO', handling: [], crushClass: 2, seasonal: false },
];

/**
 * 家居建材品类（决策记录 0011 第 4 节）：没有冷链和年龄限制；日常散件（五金、水暖、电工、油漆等）按门店拣货订单处理
 * （沿用 fulfillmentType 'GROCERY' 表示「拣进取货框的散件」），板材、建材、家电、户外动力设备按 GM（大件为主）处理。
 */
export const HARDWARE_CATEGORIES: CategoryConfig[] = [
  { id: 'fasteners', name: 'Fasteners & hardware', nameZh: '紧固件五金', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 0, seasonal: false },
  { id: 'hand-tools', name: 'Hand tools', nameZh: '手动工具', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 0, seasonal: false },
  { id: 'power-tools', name: 'Power tools', nameZh: '电动工具', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['SECURED'], crushClass: 1, seasonal: false },
  { id: 'plumbing', name: 'Plumbing', nameZh: '水暖', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 0, seasonal: false },
  { id: 'electrical', name: 'Electrical', nameZh: '电工', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: false },
  { id: 'lighting', name: 'Lighting', nameZh: '灯具', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['FRAGILE'], crushClass: 3, seasonal: false },
  { id: 'paint', name: 'Paint & sundries', nameZh: '油漆涂料', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['CHEMICAL'], crushClass: 0, seasonal: false },
  { id: 'adhesives', name: 'Adhesives & sealants', nameZh: '胶粘密封', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['CHEMICAL'], crushClass: 1, seasonal: false },
  { id: 'storage', name: 'Storage & organization', nameZh: '收纳整理', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 2, seasonal: false },
  { id: 'kitchen-bath', name: 'Kitchen & bath fixtures', nameZh: '厨卫', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: ['FRAGILE'], crushClass: 2, seasonal: false },
  { id: 'garden-supplies', name: 'Garden supplies', nameZh: '园艺用品', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: true },
  { id: 'hvac', name: 'Heating & cooling', nameZh: '冷暖设备', tempZone: 'AMBIENT', fulfillmentType: 'GROCERY', handling: [], crushClass: 1, seasonal: true },
  { id: 'lumber', name: 'Lumber & sheet goods', nameZh: '板材木料', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 0, seasonal: false },
  { id: 'building', name: 'Building materials', nameZh: '建材', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 0, seasonal: false },
  { id: 'appliances', name: 'Appliances', nameZh: '家电', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: ['FRAGILE'], crushClass: 1, seasonal: false },
  { id: 'outdoor-power', name: 'Outdoor power equipment', nameZh: '户外动力设备', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 0, seasonal: true },
  { id: 'flooring', name: 'Flooring', nameZh: '地板', tempZone: 'AMBIENT', fulfillmentType: 'GM', handling: [], crushClass: 0, seasonal: false },
];

const HARDWARE_AISLE_ORDER = ['fasteners', 'hand-tools', 'power-tools', 'electrical', 'lighting', 'plumbing', 'kitchen-bath', 'paint', 'adhesives', 'storage', 'hvac', 'garden-supplies'];
const HARDWARE_GM_AISLE_ORDER = ['flooring', 'outdoor-power', 'appliances'];

/** 沿墙货架：超市是蔬果墙和冷藏柜，建材店是板材墙（左）、建材和家电（后墙） */
interface WallSpec {
  label: string;
  categoryIds: string[];
  tempZone: TempZone;
  levels: number;
}
interface Walls {
  left: WallSpec;
  backLeft: WallSpec;
  backRight: WallSpec;
}
const GROCERY_WALLS: Walls = {
  left: { label: 'Produce wall', categoryIds: ['produce-amb'], tempZone: 'AMBIENT', levels: 3 },
  backLeft: { label: 'Back wall (produce & deli)', categoryIds: ['produce-chl', 'deli'], tempZone: 'CHILLED', levels: 3 },
  backRight: { label: 'Back wall (dairy & meat)', categoryIds: ['dairy', 'eggs', 'meat'], tempZone: 'CHILLED', levels: 4 },
};
const HARDWARE_WALLS: Walls = {
  left: { label: 'Lumber wall', categoryIds: ['lumber'], tempZone: 'AMBIENT', levels: 3 },
  backLeft: { label: 'Back wall (building materials)', categoryIds: ['building'], tempZone: 'AMBIENT', levels: 3 },
  backRight: { label: 'Back wall (appliances)', categoryIds: ['appliances'], tempZone: 'AMBIENT', levels: 2 },
};

const AMBIENT_AISLE_ORDER = [
  'bakery', 'snacks', 'breakfast', 'dry-goods', 'canned', 'beverages', 'water', 'alcohol',
  'household', 'paper', 'cleaning', 'health-beauty', 'baby', 'pet',
];
const FROZEN_AISLE_ORDER = ['frozen-veg', 'frozen-meals', 'ice-cream', 'ice'];
const GM_AISLE_ORDER = ['electronics', 'toys', 'home', 'apparel', 'outdoor', 'automotive', 'seasonal'];

/** 默认大件规则（决策 GM-01）：阈值参考普通成年人安全搬运能力，可配置 */
export const DEFAULT_SIZE_RULES: SizeRule[] = [
  { id: 'team-lift', description: '单件超过 50 lb：两人搬运', when: { field: 'unitWeightKg', op: 'gt', value: round2(lbToKg(50)) }, then: 'TEAM_LIFT' },
  { id: 'heavy-piece', description: '单件超过 30 lb：大件', when: { field: 'unitWeightKg', op: 'gt', value: round2(lbToKg(30)) }, then: 'OVERSIZED' },
  { id: 'does-not-fit', description: '任一边超出框内径：大件', when: { field: 'fitsTote', op: 'eq', value: false }, then: 'OVERSIZED' },
  {
    id: 'gm-heavy-line',
    description: 'GM 订单同一商品合计超过 50 lb：大件',
    when: { all: [{ field: 'fulfillmentType', op: 'eq', value: 'GM' }, { field: 'lineWeightKg', op: 'gt', value: round2(lbToKg(50)) }] },
    then: 'OVERSIZED',
  },
];

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const PITCH_M = 3.2;
const BAY_M = 1.22;
const MARGIN_M = 1.5;

interface FloorPlanParams {
  floorId: string;
  aisles: Array<{ temp: TempZone; categories: string[] }>;
  bays: number;
  levels: number;
  /** 左墙蔬果、后墙冷藏柜（只在 1 楼） */
  perimeter: boolean;
  /** 沿墙货架放什么（默认超市） */
  walls?: Walls;
  startSequence: number;
}

function splitEvenly<T>(items: readonly T[], buckets: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < buckets; i++) {
    const from = Math.floor((i * items.length) / buckets);
    const to = Math.max(from + 1, Math.floor(((i + 1) * items.length) / buckets));
    out.push(items.slice(from, Math.min(to, items.length)) as T[]);
  }
  return out;
}

function floorPlan(p: FloorPlanParams) {
  const x0 = 4;
  const yFront = 6;
  const runLen = p.bays * BAY_M + 2 * MARGIN_M;
  const yBack = yFront + runLen;
  const aisleX = (i: number) => x0 + 4 + i * PITCH_M;
  const xLast = aisleX(p.aisles.length - 1);
  const xEnd = xLast + 4;
  const xStage = xEnd + 6;
  const runs: RunConfig[] = [];
  let seq = p.startSequence;
  const walls = p.walls ?? GROCERY_WALLS;

  if (p.perimeter) {
    runs.push({
      id: `${p.floorId}-PRD`, floorId: p.floorId, kind: 'WALL', label: walls.left.label,
      start: { x: x0, y: yFront }, end: { x: x0, y: yBack }, sides: 1, bays: p.bays, levels: walls.left.levels,
      endMarginM: MARGIN_M, tempZone: walls.left.tempZone, categoryIds: [...walls.left.categoryIds], sequence: seq++,
    });
  }
  p.aisles.forEach((a, i) => {
    const x = aisleX(i);
    runs.push({
      id: `${p.floorId}-A${String(i + 1).padStart(2, '0')}`, floorId: p.floorId, kind: 'AISLE', label: `Aisle ${i + 1}`,
      start: { x, y: yFront }, end: { x, y: yBack }, sides: 2, bays: p.bays, levels: p.levels,
      endMarginM: MARGIN_M, tempZone: a.temp, categoryIds: a.categories, sequence: seq++,
    });
  });
  const xMid = Math.round(((x0 + xEnd) / 2) * 100) / 100;
  if (p.perimeter) {
    const leftBays = Math.max(2, Math.floor((xMid - x0 - 2 * MARGIN_M) / BAY_M));
    const rightBays = Math.max(2, Math.floor((xEnd - xMid - 2 * MARGIN_M) / BAY_M));
    runs.push({
      id: `${p.floorId}-BKL`, floorId: p.floorId, kind: 'WALL', label: walls.backLeft.label,
      start: { x: x0, y: yBack }, end: { x: xMid, y: yBack }, sides: 1, bays: leftBays, levels: walls.backLeft.levels,
      endMarginM: MARGIN_M, tempZone: walls.backLeft.tempZone, categoryIds: [...walls.backLeft.categoryIds], sequence: seq++,
    });
    runs.push({
      id: `${p.floorId}-BKR`, floorId: p.floorId, kind: 'WALL', label: walls.backRight.label,
      start: { x: xMid, y: yBack }, end: { x: xEnd, y: yBack }, sides: 1, bays: rightBays, levels: walls.backRight.levels,
      endMarginM: MARGIN_M, tempZone: walls.backRight.tempZone, categoryIds: [...walls.backRight.categoryIds], sequence: seq++,
    });
  }
  const corridors = [
    { id: `${p.floorId}-C-FRONT`, floorId: p.floorId, start: { x: x0, y: yFront }, end: { x: xStage, y: yFront } },
    { id: `${p.floorId}-C-RIGHT`, floorId: p.floorId, start: { x: xEnd, y: yFront }, end: { x: xEnd, y: yBack } },
  ];
  if (!p.perimeter) {
    corridors.push({ id: `${p.floorId}-C-BACK`, floorId: p.floorId, start: { x: x0, y: yBack }, end: { x: xEnd, y: yBack } });
    corridors.push({ id: `${p.floorId}-C-LEFT`, floorId: p.floorId, start: { x: x0, y: yFront }, end: { x: x0, y: yBack } });
  }
  return { runs, corridors, x0, yFront, yBack, xEnd, xStage, xMid, nextSequence: seq, width: xStage + 8, depth: yBack + 10 };
}

/**
 * 门店生成参数。三个模板只是三组预设参数；编辑器里可以逐项调整或随机生成。
 */
export interface GeneratorParams {
  name: string;
  /** 行业：决定品类字典、通道顺序、沿墙货架、暂存区和默认模块；默认超市 */
  industry?: Industry;
  /** 一楼常温货架通道数 */
  ambientAisles: number;
  frozenAisles: number;
  /** 一楼百货（GM）通道数 */
  gmAislesF1: number;
  /** 每条通道的货架段数（决定通道长度） */
  bays: number;
  levels: number;
  /** 左墙蔬果、后墙冷藏柜 */
  perimeter: boolean;
  /**
   * 二楼百货区；null 表示单层。
   * 电梯（1–3 部，员工推车只能乘电梯）按「左前 → 左后 → 右前」依次布置；
   * 自动扶梯（0–2 组，每组上下各一条，供顾客使用）布置在前走廊上靠近顾客入口处。
   */
  secondFloor: { gmAisles: number; bays: number; levels: number; elevators?: number; escalators?: number } | null;
  /** 暂存区规模（1 = 中型店） */
  stagingScale: number;
  /** 汽车快修中心；null 表示没有。有汽车服务中心时，汽车用品通道放在一楼靠近它的一侧 */
  autoService: { side: 'LEFT' | 'RIGHT'; oilBays: number; tireBays: number } | null;
  /** 园艺中心（门店另一侧的露天卖场）；null 表示没有 */
  garden?: { side: 'LEFT' | 'RIGHT' } | null;
  /** 店内药房柜台数；null 表示没有 */
  pharmacy?: { counters: number } | null;
  /** 营业时间（分钟），默认 7:00–22:00 */
  hours?: { openMin: number; closeMin: number };
  /** 停车场：双排车位排数与取货专用车位数，0 表示自动 */
  parking?: { rows: number; pickupBays: number };
  /** 人员规模倍数（在按门店规模自动匹配的排班上再乘以它），默认 1 */
  staffScale?: number;
  /** 后仓：加深米数、货架排数与层数、卸货门、叉车与搬运车 */
  backroom?: { extraDepthM: number; rackRows: number; rackLevels: number; docks: number; forklifts: number; palletJacks: number };
}

const PARAMS: Record<TemplateName, GeneratorParams> = {
  small: { name: 'Small neighborhood store', ambientAisles: 6, frozenAisles: 1, gmAislesF1: 1, bays: 10, levels: 5, perimeter: true, secondFloor: null, stagingScale: 0.5, autoService: null },
  medium: { name: 'Mid-size supermarket', ambientAisles: 11, frozenAisles: 2, gmAislesF1: 3, bays: 16, levels: 5, perimeter: true, secondFloor: null, stagingScale: 1, autoService: null },
  large: {
    name: 'Large two-floor store',
    ambientAisles: 18,
    frozenAisles: 3,
    gmAislesF1: 0,
    bays: 20,
    levels: 6,
    perimeter: true,
    secondFloor: { gmAisles: 10, bays: 16, levels: 5 },
    stagingScale: 2,
    autoService: null,
  },
  hardware: {
    name: 'Home improvement store',
    industry: 'HARDWARE',
    ambientAisles: 12,
    frozenAisles: 0,
    gmAislesF1: 3,
    bays: 18,
    levels: 4,
    perimeter: true,
    secondFloor: null,
    stagingScale: 1,
    autoService: null,
    garden: { side: 'RIGHT' },
    pharmacy: null,
    // 施工队一早来取货：6 点开门
    hours: { openMin: 6 * 60, closeMin: 21 * 60 },
    backroom: { extraDepthM: 10, rackRows: 0, rackLevels: 4, docks: 3, forklifts: 2, palletJacks: 3 },
  },
};

/** 生成器的预设：三个模板，外加一个带汽车服务中心和扶梯的大型店 */
export const GENERATOR_PRESETS: Array<{ id: string; label: string; params: () => GeneratorParams }> = [
  { id: 'small', label: '小型店', params: () => templateParams('small') },
  { id: 'medium', label: '中型店', params: () => templateParams('medium') },
  { id: 'large', label: '大型店（两层）', params: () => templateParams('large') },
  {
    id: 'large-auto',
    label: '大型店 + 汽车服务',
    params: () => ({
      ...templateParams('large'),
      name: 'Large store with auto center',
      secondFloor: { gmAisles: 10, bays: 16, levels: 5, elevators: 2, escalators: 1 },
      autoService: { side: 'LEFT', oilBays: 3, tireBays: 3 },
      hours: { openMin: 7 * 60, closeMin: 23 * 60 },
    }),
  },
  { id: 'hardware', label: '家居建材店', params: () => templateParams('hardware') },
];

/** 模板对应的生成参数（返回副本，可以放心修改） */
export function templateParams(t: TemplateName): GeneratorParams {
  return structuredClone(PARAMS[t]);
}

/** 参数的合理范围（编辑器的输入框和随机生成都使用它） */
export const GENERATOR_LIMITS = {
  ambientAisles: [3, 24],
  frozenAisles: [0, 5],
  gmAislesF1: [0, 8],
  bays: [6, 26],
  levels: [3, 7],
  secondFloorGmAisles: [2, 14],
  stagingScale: [0.5, 3],
  serviceBays: [0, 6],
  elevators: [1, 3],
  escalators: [0, 2],
  parkingRows: [0, 5],
  pickupBays: [0, 30],
  staffScale: [0.5, 2],
  openHour: [5, 10],
  extraDepth: [0, 30],
  rackRows: [0, 8],
  rackLevels: [2, 5],
  docks: [1, 4],
  forklifts: [0, 4],
  palletJacks: [0, 6],
  closeHour: [17, 24],
} as const;

/** 按种子随机生成一组合理的门店参数：规模、层数、货架和附属设施相互协调 */
export function randomGeneratorParams(seed: number): GeneratorParams {
  const rng = createRng(seed * 2654435761);
  const size = rng.next();
  const ambientAisles = Math.round(5 + size * 15);
  const twoFloors = size > 0.55 && rng.chance(0.6);
  const auto = size > 0.4 && rng.chance(0.55);
  return {
    name: `Generated store #${seed}`,
    ambientAisles,
    frozenAisles: Math.max(1, Math.round(ambientAisles / 6 + rng.uniform(-0.5, 0.5))),
    gmAislesF1: twoFloors ? rng.int(0, 2) : rng.int(1, 5),
    bays: rng.int(9, 22),
    levels: rng.int(4, 6),
    perimeter: rng.chance(0.85),
    secondFloor: twoFloors ? { gmAisles: rng.int(5, 12), bays: rng.int(12, 18), levels: 5, elevators: rng.int(1, 2), escalators: rng.int(0, 2) } : null,
    stagingScale: Math.round((0.5 + size * 1.8) * 2) / 2,
    autoService: auto ? { side: rng.chance(0.7) ? 'LEFT' : 'RIGHT', oilBays: rng.int(1, 4), tireBays: rng.int(1, 4) } : null,
    garden: rng.chance(0.4) ? { side: rng.chance(0.5) ? 'LEFT' : 'RIGHT' } : null,
    pharmacy: size > 0.3 && rng.chance(0.6) ? { counters: rng.int(1, 3) } : null,
    hours: { openMin: rng.pick([6, 7, 7, 8]) * 60, closeMin: rng.pick([21, 22, 22, 23, 24]) * 60 },
    parking: { rows: 0, pickupBays: 0 },
    staffScale: 1,
    backroom: { extraDepthM: Math.round(size * 16), rackRows: 0, rackLevels: rng.int(3, 4), docks: rng.int(2, 3), forklifts: size > 0.5 ? 2 : 1, palletJacks: rng.int(1, 3) },
  };
}

/** 线上订单暂存仓的货架（规模 1 = 中型店）；没有冷链的行业不设冷藏 / 冷冻 / 热食货架，大件区更大 */
export function stagingRacks(scale: number, opts: { cold?: boolean; oversizedSlots?: number } = {}): StagingRackConfig[] {
  const cold = opts.cold ?? true;
  const racks: StagingRackConfig[] = [];
  const amb = Math.max(2, Math.round(8 * scale));
  for (let i = 1; i <= amb; i++) {
    racks.push({ id: `AMB-${i}`, zoneCode: 'AMB', tempZone: 'AMBIENT', purpose: 'ORDERS', area: i <= amb / 2 ? 'PICKUP' : 'DELIVERY', rackNo: i, levels: 4, slotsPerLevel: 6, totesPerSlot: 2, distanceFromStagingM: 3 + 2.2 * i });
  }
  const coldRacks = cold ? Math.max(1, Math.round(2 * scale)) : 0;
  for (let i = 1; i <= coldRacks; i++) {
    racks.push({ id: `CHL-${i}`, zoneCode: 'CHL', tempZone: 'CHILLED', purpose: 'ORDERS', area: 'ANY', rackNo: i, levels: 4, slotsPerLevel: 5, totesPerSlot: 2, distanceFromStagingM: 6 + 2.5 * i });
    racks.push({ id: `FRZ-${i}`, zoneCode: 'FRZ', tempZone: 'FROZEN', purpose: 'ORDERS', area: 'ANY', rackNo: i, levels: 4, slotsPerLevel: 5, totesPerSlot: 2, distanceFromStagingM: 9 + 2.5 * i });
  }
  if (cold) racks.push({ id: 'HOT-1', zoneCode: 'HOT', tempZone: 'HOT', purpose: 'ORDERS', area: 'ANY', rackNo: 1, levels: 3, slotsPerLevel: 4, totesPerSlot: 1, distanceFromStagingM: 4 });
  const gm = Math.max(1, Math.round(2 * scale));
  for (let i = 1; i <= gm; i++) {
    racks.push({ id: `GM-${i}`, zoneCode: 'GM', tempZone: 'AMBIENT', purpose: 'GM', area: 'ANY', rackNo: i, levels: 4, slotsPerLevel: 6, totesPerSlot: 2, distanceFromStagingM: 14 + 2.2 * i });
  }
  racks.push({ id: 'OVS-1', zoneCode: 'OVS', tempZone: 'AMBIENT', purpose: 'OVERSIZED', area: 'ANY', rackNo: 1, levels: 1, slotsPerLevel: opts.oversizedSlots ?? 3, totesPerSlot: 8, distanceFromStagingM: 12 });
  (cold ? (['AMBIENT', 'CHILLED', 'FROZEN'] as const) : (['AMBIENT'] as const)).forEach((tz, i) => {
    racks.push({ id: `RCV-${tz}`, zoneCode: 'RCV', tempZone: tz, purpose: 'RECOVERY', area: 'ANY', rackNo: i + 1, levels: 2, slotsPerLevel: 3, totesPerSlot: 2, distanceFromStagingM: 18 });
  });
  return racks;
}

export function createTemplate(template: TemplateName): StoreConfig {
  return generateStoreConfig(PARAMS[template], template);
}

/** 由生成参数构建一份完整的门店配置（楼层、通道、走廊、电梯、暂存、附属设施、规则） */
export function generateStoreConfig(t: GeneratorParams, template: TemplateName | 'custom' = 'custom'): StoreConfig {
  const hw = t.industry === 'HARDWARE';
  const aisles: Array<{ temp: TempZone; categories: string[] }> = [];
  for (const cats of splitEvenly(hw ? HARDWARE_AISLE_ORDER : AMBIENT_AISLE_ORDER, t.ambientAisles)) aisles.push({ temp: 'AMBIENT', categories: cats });
  if (!hw) for (const cats of splitEvenly(FROZEN_AISLE_ORDER, t.frozenAisles)) aisles.push({ temp: 'FROZEN', categories: cats });
  const gmOrder = hw ? HARDWARE_GM_AISLE_ORDER : GM_AISLE_ORDER;
  if (t.gmAislesF1 > 0) for (const cats of splitEvenly(gmOrder, t.gmAislesF1)) aisles.push({ temp: 'AMBIENT', categories: cats });
  // 汽车用品与汽车服务中心在同一层，并放在靠近它的一侧（顾客等车时可以顺路选购）
  let f2GmOrder: readonly string[] = gmOrder;
  if (t.autoService && !hw) {
    let i = aisles.findIndex((a) => a.categories.includes('automotive'));
    if (i < 0) {
      aisles.push({ temp: 'AMBIENT', categories: ['automotive'] });
      i = aisles.length - 1;
    }
    const [auto] = aisles.splice(i, 1);
    if (auto) {
      if (t.autoService.side === 'LEFT') aisles.unshift(auto);
      else aisles.push(auto);
    }
    f2GmOrder = GM_AISLE_ORDER.filter((c) => c !== 'automotive');
  }

  const f1 = floorPlan({ floorId: 'F1', aisles, bays: t.bays, levels: t.levels, perimeter: t.perimeter, ...(hw ? { walls: HARDWARE_WALLS } : {}), startSequence: 0 });
  const floors = [{ id: 'F1', name: '1F', level: 0, widthM: f1.width, depthM: f1.depth + (t.backroom?.extraDepthM ?? 0) }];
  const runs = [...f1.runs];
  const corridors = [
    ...f1.corridors,
    { id: 'F1-C-HANDOFF', floorId: 'F1', start: { x: f1.xStage, y: f1.yFront }, end: { x: f1.xStage, y: f1.yFront - 5 } },
    { id: 'F1-C-BACKROOM', floorId: 'F1', start: { x: f1.xMid, y: f1.yBack }, end: { x: f1.xMid, y: f1.yBack + 6 } },
  ];
  const connectors: StoreConfig['layout']['connectors'] = [];

  if (t.secondFloor) {
    const gmAisles = splitEvenly(f2GmOrder, t.secondFloor.gmAisles).map((cats) => ({ temp: 'AMBIENT' as TempZone, categories: cats }));
    const f2 = floorPlan({ floorId: 'F2', aisles: gmAisles, bays: t.secondFloor.bays, levels: t.secondFloor.levels, perimeter: false, startSequence: f1.nextSequence });
    floors.push({ id: 'F2', name: '2F', level: 1, widthM: f2.width, depthM: f2.depth });
    runs.push(...f2.runs);
    corridors.push(...f2.corridors);
    // 电梯井和扶梯在两层的同一位置；取两层都能走到的坐标（前后走廊、左侧通道）
    const yBack = Math.min(f1.yBack, f2.yBack);
    const xRight = Math.min(f1.xEnd, f2.xEnd);
    const elevatorSpots = [
      { x: f1.x0, y: f1.yFront },
      { x: f1.x0, y: yBack },
      { x: xRight, y: f1.yFront },
    ];
    const elevators = Math.min(3, Math.max(1, t.secondFloor.elevators ?? 1));
    for (let k = 0; k < elevators; k++) {
      const p = elevatorSpots[k] as { x: number; y: number };
      connectors.push({ id: `ELEV-${k + 1}`, kind: 'ELEVATOR', a: { floorId: 'F1', ...p }, b: { floorId: 'F2', ...p }, traversalSec: 75 });
    }
    // 扶梯放在前走廊上（两层都有），靠近顾客入口
    const at = (k: number) => Math.round((f1.x0 + (xRight - f1.x0) * k) * 100) / 100;
    const escalatorSpots = [
      { x: at(0.42), y: f1.yFront },
      { x: at(0.72), y: f1.yFront },
    ];
    const escalators = Math.min(2, Math.max(0, t.secondFloor.escalators ?? 0));
    for (let k = 0; k < escalators; k++) {
      const p = escalatorSpots[k] as { x: number; y: number };
      connectors.push({ id: `ESC-${k + 1}`, kind: 'ESCALATOR', a: { floorId: 'F1', ...p }, b: { floorId: 'F2', ...p }, traversalSec: 35 });
    }
  }

  const stagingPoint = { floorId: 'F1', x: f1.xStage, y: f1.yFront };
  return {
    schemaVersion: 1,
    configVersion: 1,
    id: template === 'custom' ? `custom-${slug(t.name)}` : `template-${template}`,
    name: t.name,
    template,
    ...(hw ? { industry: 'HARDWARE' as const } : {}),
    units: { weight: 'lb' },
    hours: t.hours ? { ...t.hours } : { openMin: 7 * 60, closeMin: 22 * 60 },
    layout: {
      floors,
      runs,
      corridors,
      connectors,
      points: {
        cartDepot: stagingPoint,
        staging: stagingPoint,
        handoff: { floorId: 'F1', x: f1.xStage, y: f1.yFront - 5 },
        backroom: { floorId: 'F1', x: f1.xMid, y: f1.yBack + 6 },
      },
    },
    staging: { codePattern: '{zone}-{rack}-{level}-{slot}', pad: 2, racks: hw ? stagingRacks(t.stagingScale, { cold: false, oversizedSlots: 8 }) : stagingRacks(t.stagingScale) },
    catalog: { categories: (hw ? HARDWARE_CATEGORIES : DEFAULT_CATEGORIES).map((c) => ({ ...c, handling: [...c.handling] })) },
    equipment: {
      cart: { totesPerCart: 8 },
      tote: { innerCm: { l: 53, w: 35, h: 28 }, maxWeightKg: round2(lbToKg(35)), fillFactor: 0.7 },
    },
    rules: {
      slotLengthMin: 60,
      lockLeadMin: 120,
      coldChain: { baseMin: 20, perItemMin: 0.5, minMin: 15, maxMin: 60 },
      sizeRules: DEFAULT_SIZE_RULES.map((r) => ({ ...r })),
      gmExcludedTempZones: ['CHILLED', 'FROZEN', 'HOT'],
      handoff: { approachingMin: 5, longWaitMin: 8, maxOrdersPerTrip: 4, codeAttempts: 3, deliveryReadyLeadMin: 30, locationIntervalSec: 30 },
      staging: { mode: 'SELF_SELECT', occupancyAlert: 0.85 },
      substitution: { pricing: 'ACTUAL', priceBand: 0.5, curbsideReject: false },
      labels: { nameMaxLength: 14 },
    },
    facilities: [
      ...(t.autoService
        ? [
            {
              id: 'AUTO-1',
              kind: 'AUTO_SERVICE' as const,
              name: 'Auto service center',
              side: t.autoService.side,
              oilBays: t.autoService.oilBays,
              tireBays: t.autoService.tireBays,
              carsPerDay: 0,
              hours: { openMin: 8 * 60, closeMin: 19 * 60 },
            },
          ]
        : []),
      // 园艺中心与汽车服务中心不能在同一侧：冲突时放到另一侧
      ...(t.garden
        ? [{ id: 'GARDEN-1', kind: 'GARDEN_CENTER' as const, name: 'Garden center', side: t.autoService && t.autoService.side === t.garden.side ? (t.garden.side === 'LEFT' ? ('RIGHT' as const) : ('LEFT' as const)) : t.garden.side, widthM: 18, depthM: 22 }]
        : []),
      ...(t.pharmacy
        ? [{ id: 'PHARM-1', kind: 'PHARMACY' as const, name: 'Pharmacy', counters: t.pharmacy.counters, patientsPerDay: 0, hours: { openMin: (t.hours?.openMin ?? 420) + 60, closeMin: Math.min(21 * 60, t.hours?.closeMin ?? 1320) } }]
        : []),
    ],
    outdoor: { parkingRows: t.parking?.rows ?? 0, pickupBays: t.parking?.pickupBays ?? 0 },
    backroom: t.backroom ? { ...t.backroom } : { extraDepthM: 0, rackRows: 0, rackLevels: 3, docks: 3, forklifts: 1, palletJacks: 2 },
    // 建材店默认打开包裹中转（承运商自提点）；没有熟食现做
    modules: { gm: true, mto: false, parcelHub: hw, returns: true, exceptions: true, trips: true, sensors: false, staffingAi: false },
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'store';
}
