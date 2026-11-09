import type { Category } from '../../../StoreX/src/world/layout';

/**
 * 商品族：网络层面不需要 8,000 个商品，按「大类 × 温区 × 货源」分成 17 个族。
 * 每个族只有一种货源，所以补货路径是确定的：
 * - 长途公路（domestic）：区外的供应商（含跨境 / 洲际的），整车从北面、东面的高速口进来，按规划直送门店或进配送中心；
 * - 区域生鲜（local）：内陆产区的乳品厂和果蔬集散中心，夜里集货、经北面的高速口进配送中心；中央面包房（bakery）；
 * - 海运（sea）、铁路班列（rail）、空运（air）：先进配送中心（拆箱、分拣），再用卡车送店。
 * 需求占比按 StoreX 的大类结构拆分（常温 38%、日用品 7%、饮料 8%、乳品 14%、冷冻 7%、果蔬 14%、肉类海鲜 6%、面包熟食 6%）。
 */
export type Temp = 'ambient' | 'chilled' | 'frozen';
export type Source = 'domestic' | 'local' | 'bakery' | 'sea' | 'rail' | 'air';

export interface Family {
  key: string;
  label: string;
  cat: Category;
  temp: Temp;
  source: Source;
  /** 供应商在哪个出口外、离出口多少公里（长途公路、区域生鲜）；border = 跨境（洲际）供应商，过境清关多 2 天；面包房 / 进口另有路径 */
  supplier?: { via: 'NORTH' | 'EAST'; km: number; border?: boolean };
  /** 占全部需求件数的比例 */
  share: number;
  unitsPerCase: number;
  /** 每箱体积（立方米）、重量（公斤）、进价（美元） */
  cube: number;
  kg: number;
  caseCost: number;
  /** 每件售价（美元）和毛利率 */
  price: number;
  margin: number;
  /** 从产地（采摘 / 生产）算起的总保质期（天）；不易腐的没有 */
  life?: number;
  /** 单个商品的日需求波动（变异系数） */
  cv: number;
}

/** 规模 1.0 的门店（StoreX 报告里那家店）每天卖多少件 */
export const BASE_UNITS = 30_900;

const F = (f: Omit<Family, 'caseCost'> & { caseCost?: number }): Family => ({ ...f, caseCost: f.caseCost ?? Math.round(f.price * (1 - f.margin) * f.unitsPerCase * 100) / 100 });

export const FAMILIES: readonly Family[] = [
  F({ key: 'AMB_A', label: '常温食品（畅销）', cat: 'ambient', temp: 'ambient', source: 'domestic', supplier: { via: 'NORTH', km: 180 }, share: 0.13, unitsPerCase: 12, cube: 0.028, kg: 7, price: 3.0, margin: 0.25, cv: 0.35 }),
  F({ key: 'AMB_B', label: '常温食品（一般）', cat: 'ambient', temp: 'ambient', source: 'domestic', supplier: { via: 'NORTH', km: 220 }, share: 0.09, unitsPerCase: 12, cube: 0.028, kg: 6.5, price: 3.0, margin: 0.26, cv: 0.45 }),
  F({ key: 'AMB_C', label: '常温食品（长尾，跨境公路）', cat: 'ambient', temp: 'ambient', source: 'domestic', supplier: { via: 'EAST', km: 1400, border: true }, share: 0.065, unitsPerCase: 12, cube: 0.028, kg: 6, price: 3.2, margin: 0.28, cv: 0.6 }),
  F({ key: 'AMB_IMP', label: '常温进口（海运）', cat: 'ambient', temp: 'ambient', source: 'sea', share: 0.06, unitsPerCase: 12, cube: 0.03, kg: 7, price: 3.4, margin: 0.3, cv: 0.45 }),
  F({ key: 'AMB_RAIL', label: '常温进口（铁路班列）', cat: 'ambient', temp: 'ambient', source: 'rail', share: 0.035, unitsPerCase: 12, cube: 0.03, kg: 7, price: 3.5, margin: 0.3, cv: 0.45 }),
  F({ key: 'HH_DOM', label: '日用品（跨境公路）', cat: 'household', temp: 'ambient', source: 'domestic', supplier: { via: 'EAST', km: 1100, border: true }, share: 0.042, unitsPerCase: 12, cube: 0.036, kg: 8, price: 5.0, margin: 0.3, cv: 0.45 }),
  F({ key: 'HH_RAIL', label: '日用品进口（铁路班列）', cat: 'household', temp: 'ambient', source: 'rail', share: 0.028, unitsPerCase: 12, cube: 0.036, kg: 7.5, price: 5.2, margin: 0.33, cv: 0.5 }),
  F({ key: 'BEV', label: '饮料', cat: 'beverage', temp: 'ambient', source: 'domestic', supplier: { via: 'NORTH', km: 120 }, share: 0.08, unitsPerCase: 6, cube: 0.03, kg: 15, price: 3.8, margin: 0.22, cv: 0.4 }),
  F({ key: 'DAIRY', label: '乳品冷藏', cat: 'dairy', temp: 'chilled', source: 'local', supplier: { via: 'NORTH', km: 70 }, share: 0.14, unitsPerCase: 12, cube: 0.022, kg: 10, price: 2.7, margin: 0.28, life: 18, cv: 0.3 }),
  F({ key: 'FRZ_DOM', label: '冷冻', cat: 'frozen', temp: 'frozen', source: 'domestic', supplier: { via: 'NORTH', km: 300 }, share: 0.05, unitsPerCase: 12, cube: 0.03, kg: 8, price: 4.2, margin: 0.27, cv: 0.4 }),
  F({ key: 'FRZ_IMP', label: '冷冻进口（海运冷箱）', cat: 'frozen', temp: 'frozen', source: 'sea', share: 0.02, unitsPerCase: 12, cube: 0.03, kg: 9, price: 5.0, margin: 0.3, cv: 0.45 }),
  F({ key: 'PROD_LOCAL', label: '区域果蔬（内陆产区）', cat: 'produce', temp: 'chilled', source: 'local', supplier: { via: 'NORTH', km: 95 }, share: 0.08, unitsPerCase: 20, cube: 0.045, kg: 12, price: 1.9, margin: 0.35, life: 10, cv: 0.3 }),
  F({ key: 'PROD_AIR', label: '进口果蔬（空运）', cat: 'produce', temp: 'chilled', source: 'air', share: 0.006, unitsPerCase: 12, cube: 0.02, kg: 4, price: 4.5, margin: 0.4, life: 9, cv: 0.4 }),
  F({ key: 'PROD_SEA', label: '进口果蔬（海运冷箱）', cat: 'produce', temp: 'chilled', source: 'sea', share: 0.054, unitsPerCase: 20, cube: 0.04, kg: 18, price: 1.6, margin: 0.33, life: 45, cv: 0.3 }),
  F({ key: 'MEAT', label: '肉类', cat: 'meat', temp: 'chilled', source: 'domestic', supplier: { via: 'EAST', km: 150 }, share: 0.056, unitsPerCase: 8, cube: 0.02, kg: 9, price: 7.0, margin: 0.25, life: 9, cv: 0.35 }),
  F({ key: 'SEAFOOD_AIR', label: '进口海鲜（空运）', cat: 'meat', temp: 'chilled', source: 'air', share: 0.004, unitsPerCase: 8, cube: 0.02, kg: 8, price: 9.0, margin: 0.3, life: 7, cv: 0.45 }),
  F({ key: 'BAKERY', label: '面包熟食', cat: 'bakery', temp: 'ambient', source: 'bakery', share: 0.06, unitsPerCase: 10, cube: 0.04, kg: 4, price: 3.8, margin: 0.45, life: 3, cv: 0.3 }),
];

export function family(key: string): Family {
  const f = FAMILIES.find((x) => x.key === key);
  if (!f) throw new Error(`unknown family ${key}`);
  return f;
}

/** 一个托盘能放多少箱（按体积：托盘有效 1.5 立方米，重量不超过 900 公斤） */
export function casesPerPallet(f: Family): number {
  return Math.max(10, Math.min(Math.floor(1.5 / f.cube), Math.floor(900 / f.kg)));
}

/** 一个 40 尺集装箱（冷箱同）能放多少托盘 */
export const PALLETS_PER_FEU = 21;
/** 一辆半挂车能放多少托盘：单温区 26，多温区（有隔板）24 */
export const PALLETS_PER_TRAILER = 26;
export const PALLETS_PER_MULTI_TEMP = 24;
