import { lbToKg, type TempZone } from '@storewright/domain';
import type { CategoryConfig, RunConfig, StagingRackConfig, StoreConfig, SizeRule } from './schema';

/**
 * 门店模板（决策 G-03）：小型 / 中型（默认）/ 大型。
 * 三个模板共用同一套 schema，只是参数不同，用来证明同一套配置可以上下伸缩。
 */

export type TemplateName = 'small' | 'medium' | 'large';

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

  if (p.perimeter) {
    runs.push({
      id: `${p.floorId}-PRD`, floorId: p.floorId, kind: 'WALL', label: 'Produce wall',
      start: { x: x0, y: yFront }, end: { x: x0, y: yBack }, sides: 1, bays: p.bays, levels: 3,
      endMarginM: MARGIN_M, tempZone: 'AMBIENT', categoryIds: ['produce-amb'], sequence: seq++,
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
      id: `${p.floorId}-BKL`, floorId: p.floorId, kind: 'WALL', label: 'Back wall (produce & deli)',
      start: { x: x0, y: yBack }, end: { x: xMid, y: yBack }, sides: 1, bays: leftBays, levels: 3,
      endMarginM: MARGIN_M, tempZone: 'CHILLED', categoryIds: ['produce-chl', 'deli'], sequence: seq++,
    });
    runs.push({
      id: `${p.floorId}-BKR`, floorId: p.floorId, kind: 'WALL', label: 'Back wall (dairy & meat)',
      start: { x: xMid, y: yBack }, end: { x: xEnd, y: yBack }, sides: 1, bays: rightBays, levels: 4,
      endMarginM: MARGIN_M, tempZone: 'CHILLED', categoryIds: ['dairy', 'eggs', 'meat'], sequence: seq++,
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

interface TemplateParams {
  name: string;
  ambientAisles: number;
  frozenAisles: number;
  gmAislesF1: number;
  bays: number;
  levels: number;
  secondFloorGmAisles?: number;
  stagingScale: number;
}

const PARAMS: Record<TemplateName, TemplateParams> = {
  small: { name: 'Small neighborhood store', ambientAisles: 6, frozenAisles: 1, gmAislesF1: 1, bays: 10, levels: 5, stagingScale: 0.5 },
  medium: { name: 'Mid-size supermarket', ambientAisles: 11, frozenAisles: 2, gmAislesF1: 3, bays: 16, levels: 5, stagingScale: 1 },
  large: { name: 'Large two-floor store', ambientAisles: 18, frozenAisles: 3, gmAislesF1: 0, bays: 20, levels: 6, secondFloorGmAisles: 10, stagingScale: 2 },
};

function stagingRacks(scale: number): StagingRackConfig[] {
  const racks: StagingRackConfig[] = [];
  const amb = Math.max(2, Math.round(8 * scale));
  for (let i = 1; i <= amb; i++) {
    racks.push({ id: `AMB-${i}`, zoneCode: 'AMB', tempZone: 'AMBIENT', purpose: 'ORDERS', area: i <= amb / 2 ? 'PICKUP' : 'DELIVERY', rackNo: i, levels: 4, slotsPerLevel: 6, totesPerSlot: 2, distanceFromStagingM: 3 + 2.2 * i });
  }
  const cold = Math.max(1, Math.round(2 * scale));
  for (let i = 1; i <= cold; i++) {
    racks.push({ id: `CHL-${i}`, zoneCode: 'CHL', tempZone: 'CHILLED', purpose: 'ORDERS', area: 'ANY', rackNo: i, levels: 4, slotsPerLevel: 5, totesPerSlot: 2, distanceFromStagingM: 6 + 2.5 * i });
    racks.push({ id: `FRZ-${i}`, zoneCode: 'FRZ', tempZone: 'FROZEN', purpose: 'ORDERS', area: 'ANY', rackNo: i, levels: 4, slotsPerLevel: 5, totesPerSlot: 2, distanceFromStagingM: 9 + 2.5 * i });
  }
  racks.push({ id: 'HOT-1', zoneCode: 'HOT', tempZone: 'HOT', purpose: 'ORDERS', area: 'ANY', rackNo: 1, levels: 3, slotsPerLevel: 4, totesPerSlot: 1, distanceFromStagingM: 4 });
  const gm = Math.max(1, Math.round(2 * scale));
  for (let i = 1; i <= gm; i++) {
    racks.push({ id: `GM-${i}`, zoneCode: 'GM', tempZone: 'AMBIENT', purpose: 'GM', area: 'ANY', rackNo: i, levels: 4, slotsPerLevel: 6, totesPerSlot: 2, distanceFromStagingM: 14 + 2.2 * i });
  }
  racks.push({ id: 'OVS-1', zoneCode: 'OVS', tempZone: 'AMBIENT', purpose: 'OVERSIZED', area: 'ANY', rackNo: 1, levels: 1, slotsPerLevel: 3, totesPerSlot: 8, distanceFromStagingM: 12 });
  (['AMBIENT', 'CHILLED', 'FROZEN'] as const).forEach((tz, i) => {
    racks.push({ id: `RCV-${tz}`, zoneCode: 'RCV', tempZone: tz, purpose: 'RECOVERY', area: 'ANY', rackNo: i + 1, levels: 2, slotsPerLevel: 3, totesPerSlot: 2, distanceFromStagingM: 18 });
  });
  return racks;
}

export function createTemplate(template: TemplateName): StoreConfig {
  const t = PARAMS[template];
  const aisles: Array<{ temp: TempZone; categories: string[] }> = [];
  for (const cats of splitEvenly(AMBIENT_AISLE_ORDER, t.ambientAisles)) aisles.push({ temp: 'AMBIENT', categories: cats });
  for (const cats of splitEvenly(FROZEN_AISLE_ORDER, t.frozenAisles)) aisles.push({ temp: 'FROZEN', categories: cats });
  if (t.gmAislesF1 > 0) for (const cats of splitEvenly(GM_AISLE_ORDER, t.gmAislesF1)) aisles.push({ temp: 'AMBIENT', categories: cats });

  const f1 = floorPlan({ floorId: 'F1', aisles, bays: t.bays, levels: t.levels, perimeter: true, startSequence: 0 });
  const floors = [{ id: 'F1', name: '1F', level: 0, widthM: f1.width, depthM: f1.depth }];
  const runs = [...f1.runs];
  const corridors = [
    ...f1.corridors,
    { id: 'F1-C-HANDOFF', floorId: 'F1', start: { x: f1.xStage, y: f1.yFront }, end: { x: f1.xStage, y: f1.yFront - 5 } },
    { id: 'F1-C-BACKROOM', floorId: 'F1', start: { x: f1.xMid, y: f1.yBack }, end: { x: f1.xMid, y: f1.yBack + 6 } },
  ];
  const connectors: StoreConfig['layout']['connectors'] = [];

  if (t.secondFloorGmAisles) {
    const gmAisles = splitEvenly(GM_AISLE_ORDER, t.secondFloorGmAisles).map((cats) => ({ temp: 'AMBIENT' as TempZone, categories: cats }));
    const f2 = floorPlan({ floorId: 'F2', aisles: gmAisles, bays: 16, levels: 5, perimeter: false, startSequence: f1.nextSequence });
    floors.push({ id: 'F2', name: '2F', level: 1, widthM: f2.width, depthM: f2.depth });
    runs.push(...f2.runs);
    corridors.push(...f2.corridors);
    connectors.push({ id: 'ELEV-1', kind: 'ELEVATOR', a: { floorId: 'F1', x: f1.x0, y: f1.yFront }, b: { floorId: 'F2', x: f2.x0, y: f2.yFront }, traversalSec: 75 });
  }

  const stagingPoint = { floorId: 'F1', x: f1.xStage, y: f1.yFront };
  return {
    schemaVersion: 1,
    configVersion: 1,
    id: `template-${template}`,
    name: t.name,
    template,
    units: { weight: 'lb' },
    hours: { openMin: 7 * 60, closeMin: 22 * 60 },
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
    staging: { codePattern: '{zone}-{rack}-{level}-{slot}', pad: 2, racks: stagingRacks(t.stagingScale) },
    catalog: { categories: DEFAULT_CATEGORIES.map((c) => ({ ...c, handling: [...c.handling] })) },
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
    modules: { gm: true, mto: false, parcelHub: false, exceptions: true, trips: true, sensors: false, staffingAi: false },
  };
}
