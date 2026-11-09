import { Sampler, type Rng } from '../core/rng';
import { CATEGORIES, type Category, type Layout, type Pt } from './layout';

/** 温区：决定装哪种框、放进自提柜的哪个温区 */
export type Temp = 'ambient' | 'chilled' | 'frozen';

export interface CategorySpec {
  /** 商品数占比、需求行占比 */
  skuShare: number;
  lineShare: number;
  price: number;
  margin: number;
  kg: number;
  temp: Temp;
  /** 能不能进立体货格仓（本方案）：生鲜要人挑、冷冻和大件不进 */
  mfc: boolean;
  /** 保质期（天，生鲜才有） */
  shelfLifeDays?: number;
  /** 货架容量（件）和每箱件数 */
  shelfCap: number;
  caseQty: number;
  label: string;
}

/** 大类参数（合成数据，按中型超市的常见结构设定；行占比与上一代的 266 单 / 5009 行一致） */
export const CATEGORY: Record<Category, CategorySpec> = {
  ambient: { skuShare: 0.44, lineShare: 0.38, price: 3.0, margin: 0.25, kg: 0.6, temp: 'ambient', mfc: true, shelfCap: 24, caseQty: 12, label: '常温食品' },
  household: { skuShare: 0.12, lineShare: 0.07, price: 5.0, margin: 0.3, kg: 0.8, temp: 'ambient', mfc: true, shelfCap: 18, caseQty: 12, label: '日用品' },
  beverage: { skuShare: 0.07, lineShare: 0.08, price: 3.8, margin: 0.22, kg: 2.5, temp: 'ambient', mfc: true, shelfCap: 20, caseQty: 6, label: '饮料' },
  dairy: { skuShare: 0.09, lineShare: 0.14, price: 2.7, margin: 0.28, kg: 0.8, temp: 'chilled', mfc: true, shelfLifeDays: 14, shelfCap: 18, caseQty: 12, label: '乳品冷藏' },
  frozen: { skuShare: 0.08, lineShare: 0.07, price: 4.2, margin: 0.27, kg: 0.7, temp: 'frozen', mfc: false, shelfCap: 16, caseQty: 12, label: '冷冻' },
  produce: { skuShare: 0.05, lineShare: 0.14, price: 1.9, margin: 0.35, kg: 0.7, temp: 'chilled', mfc: false, shelfLifeDays: 5, shelfCap: 40, caseQty: 20, label: '果蔬' },
  meat: { skuShare: 0.04, lineShare: 0.06, price: 7.0, margin: 0.25, kg: 0.9, temp: 'chilled', mfc: false, shelfLifeDays: 4, shelfCap: 12, caseQty: 8, label: '肉类海鲜' },
  bakery: { skuShare: 0.04, lineShare: 0.06, price: 3.8, margin: 0.45, kg: 0.5, temp: 'ambient', mfc: false, shelfLifeDays: 3, shelfCap: 14, caseQty: 10, label: '面包熟食' },
};

export interface Sku {
  id: number;
  category: Category;
  temp: Temp;
  price: number;
  margin: number;
  kg: number;
  /** 需求权重（类内 Zipf） */
  weight: number;
  /** 陈列面（取货站的格子） */
  face: Pt;
  shelfCap: number;
  caseQty: number;
  /** 大件（整箱水等）：不进货格仓 */
  bulky: boolean;
  /** 本方案：是否存放在立体货格仓 */
  inMfc: boolean;
  /** 年龄限制商品（酒类等） */
  ageRestricted: boolean;
}

export interface Catalog {
  skus: Sku[];
  byCategory: Record<Category, Sku[]>;
  /** 按需求行占比选大类、再按类内权重选商品 */
  categorySampler: Sampler;
  skuSamplers: Record<Category, Sampler>;
}

export interface CatalogOptions {
  skuCount: number;
  /** 本方案货格仓能放多少个商品（按线上需求从高到低选） */
  mfcSkuCapacity: number;
  /** 类内需求分布 1 / (i + offset)^zipf（齐普夫—曼德博分布：头部商品不会占得太夸张） */
  zipf: number;
  offset: number;
  /** 货架按几天的地面销量留空间（陈列图的「可售天数」） */
  daysOfSupply: number;
}

export const DEFAULT_CATALOG: CatalogOptions = { skuCount: 8000, mfcSkuCapacity: 3600, zipf: 0.9, offset: 20, daysOfSupply: 1.6 };

export function buildCatalog(layout: Layout, rng: Rng, opts: CatalogOptions = DEFAULT_CATALOG): Catalog {
  const shareSum = CATEGORIES.reduce((s, c) => s + CATEGORY[c].skuShare, 0);
  const skus: Sku[] = [];
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, [] as Sku[]])) as Record<Category, Sku[]>;
  for (const c of CATEGORIES) {
    const spec = CATEGORY[c];
    const n = Math.max(8, Math.round((opts.skuCount * spec.skuShare) / shareSum));
    const faces = layout.faces[c];
    for (let i = 0; i < n; i++) {
      // 同一类商品沿陈列面依次摆放；每个陈列面放若干个商品（不同层）
      const face = faces[Math.floor((i * faces.length) / n)] ?? faces[0] ?? layout.poi.service;
      const priceJitter = 0.5 + rng.next();
      const sku: Sku = {
        id: skus.length,
        category: c,
        temp: spec.temp,
        price: Math.round(spec.price * priceJitter * 100) / 100,
        margin: spec.margin,
        kg: spec.kg * (0.5 + rng.next()),
        weight: 1 / Math.pow(i + 1 + opts.offset, opts.zipf),
        face,
        shelfCap: spec.shelfCap,
        caseQty: spec.caseQty,
        bulky: c === 'beverage' && rng.chance(0.5),
        inMfc: false,
        ageRestricted: c === 'beverage' && rng.chance(0.15),
      };
      // 热销商品排在前面（类内权重从大到小），陈列位置打散到整个类别区域，避免热销商品全挤在一端
      skus.push(sku);
      byCategory[c].push(sku);
    }
    shuffleFaces(byCategory[c], rng);
  }
  // 货格仓：能进的商品按需求权重（类内权重 × 大类行占比 / 类内总权重）排序，取前 N 个
  const eligible = skus.filter((s) => CATEGORY[s.category].mfc && !s.bulky);
  const catTotal = Object.fromEntries(CATEGORIES.map((c) => [c, byCategory[c].reduce((s, k) => s + k.weight, 0)])) as Record<Category, number>;
  const demandShare = (s: Sku) => (s.weight / catTotal[s.category]) * CATEGORY[s.category].lineShare;
  eligible.sort((a, b) => demandShare(b) - demandShare(a));
  for (const s of eligible.slice(0, opts.mfcSkuCapacity)) s.inMfc = true;
  return {
    skus,
    byCategory,
    categorySampler: new Sampler(CATEGORIES.map((c) => CATEGORY[c].lineShare)),
    skuSamplers: Object.fromEntries(CATEGORIES.map((c) => [c, new Sampler(byCategory[c].map((s) => s.weight))])) as Record<Category, Sampler>,
  };
}

/** 打散陈列位置：商品的需求权重不变，只是换一下位置（热销品分布在整个区域） */
function shuffleFaces(list: Sku[], rng: Rng): void {
  const faces = list.map((s) => s.face);
  rng.shuffle(faces);
  list.forEach((s, i) => (s.face = faces[i] as Pt));
}

export function sampleSku(cat: Catalog, rng: Rng): Sku {
  const c = CATEGORIES[cat.categorySampler.sample(rng)] as Category;
  const list = cat.byCategory[c];
  return list[cat.skuSamplers[c].sample(rng)] as Sku;
}

/** 本方案的线上订单行由谁来拣：货格仓（机器人送箱到站台）还是生鲜拣选员（卖场里拣） */
export function mfcLine(sku: Sku): boolean {
  return sku.inMfc;
}

/** 一件商品大约占框的体积（升，含包装间隙）：用来估算框数 */
const LITERS: Record<Category, number> = { ambient: 2.25, household: 2.7, beverage: 2.5, dairy: 1.9, frozen: 2.1, produce: 2.9, meat: 1.8, bakery: 3.3 };
export function itemLiters(sku: Sku): number {
  return sku.bulky ? 10 : LITERS[sku.category];
}

/**
 * 货架容量按「地面销量 × 可售天数」定（陈列图的做法：卖得快的商品陈列面多）。
 * 本方案里货格仓商品的线上需求不走货架，所以地面需求只算到店顾客 + 线上的生鲜、冷冻和大件。
 */
export function sizeShelves(cat: Catalog, floorUnitsPerDay: (s: Sku) => number, daysOfSupply: number): void {
  for (const s of cat.skus) {
    const spec = CATEGORY[s.category];
    const want = Math.ceil(floorUnitsPerDay(s) * daysOfSupply);
    s.shelfCap = Math.max(Math.ceil(spec.shelfCap * 0.5), Math.min(spec.shelfCap * 15, want));
  }
}

export const TOTE_LITERS = 52 * 0.7;
export const TOTE_KG = 15.9;
