import { BASE_UNITS, FAMILIES, type Family } from '../region/products';
import { g3 } from '../sim/config';
import type { NetStore } from './sites';

/**
 * 货不够时怎么分给各店（公平分配）：
 *
 * - 每家店的目标库存 = 预测需求 ×（到货提前期 + 补货周期）+ 安全库存（安全系数 × 需求波动 × √（提前期 + 周期））；
 *   需要补的 = 目标 − 手上的库存；
 * - 货够：每家店补到目标；货不够：让每家店补完以后都到目标的同一个比例（谁离目标远先补谁），
 *   而不是按销量比例平分——按比例分时库存本来就少的店会先断货；
 * - 满足率：按正态分布算接下来（提前期 + 周期）里卖掉的期望缺货。
 *
 * 门店手上的库存是合成的（每家店、每个商品族固定），用来演示分法；接上门店系统时换成实时库存。
 */
export interface AllocRow {
  key: string;
  name: string;
  /** 每天的预测需求（件）、手上的库存、安全库存、目标、需要补的、分到的、分完以后够卖几天、满足率（公平分法 / 按销量比例分） */
  demand: number;
  onHand: number;
  safety: number;
  target: number;
  need: number;
  alloc: number;
  cover: number;
  fill: number;
  propAlloc: number;
  propFill: number;
}
export interface Allocation {
  family: Family;
  supply: number;
  need: number;
  /** 补完以后每家店到目标的比例（≥ 1 = 货够） */
  ratio: number;
  rows: AllocRow[];
  /** 最差那家店的满足率：公平分法、按比例分 */
  worstFill: number;
  worstPropFill: number;
}

/** 补货：到货提前期 1 天、每天补一次（全链路方案每天送） */
const LEAD = 1;
const REVIEW = 1;
/** 门店一个商品族加起来的波动比单个商品小（几百个商品的波动抵消一部分） */
const FAMILY_CV = 0.5;

const phi = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
/** 标准正态分布的累积分布（Abramowitz–Stegun 7.1.26，误差 < 1.5e-7） */
function Phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** 库存 y、需求 N(μ, σ) 时的满足率 */
export function fillRate(y: number, mu: number, sigma: number): number {
  if (mu <= 0) return 1;
  if (sigma <= 0) return Math.min(1, y / mu);
  const z = (y - mu) / sigma;
  const short = sigma * (phi(z) - z * (1 - Phi(z)));
  return Math.max(0, Math.min(1, 1 - short / mu));
}

/** 每家店、每个商品族手上的库存（够卖几天，0.3–1.8 天，合成的、固定的） */
function coverDays(storeIdx: number, famIdx: number): number {
  let h = (storeIdx * 2654435761 + famIdx * 40503 + 12345) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return 0.3 + (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 1.5;
}

/** 有哪些商品族要分（经过配送中心的） */
export const ALLOC_FAMILIES = FAMILIES.filter((f) => !g3(1).flow.direct.includes(f.key));

export function allocate(stores: readonly NetStore[], famKey: string, supplyShare: number, growth = 1): Allocation {
  const fi = FAMILIES.findIndex((f) => f.key === famKey);
  const family = FAMILIES[fi] as Family;
  const s3 = g3(1);
  const z = family.life ? (s3.store.safetyZFresh ?? s3.store.safetyZ) : s3.store.safetyZ;
  const span = LEAD + REVIEW;
  const base = stores.map((st, i) => {
    const demand = BASE_UNITS * st.size * growth * family.share;
    const sigma = family.cv * FAMILY_CV * demand;
    const onHand = demand * coverDays(i, fi);
    const safety = z * sigma * Math.sqrt(span);
    const target = demand * span + safety;
    return { st, demand, sigma, onHand, safety, target, need: Math.max(0, target - onHand) };
  });
  const need = base.reduce((a, b) => a + b.need, 0);
  const supply = need * supplyShare;
  // 公平分法：找一个比例 r，让每家店补到 r × 目标（手上已经超过的不补），分的总数正好等于到货
  const give = (r: number) => base.reduce((a, b) => a + Math.max(0, r * b.target - b.onHand), 0);
  let ratio: number;
  if (supply >= need - 1e-9) ratio = Math.max(1, ...base.map((b) => b.onHand / b.target));
  else {
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 80; it++) {
      const mid = (lo + hi) / 2;
      if (give(mid) > supply) hi = mid;
      else lo = mid;
    }
    ratio = lo;
  }
  const totalDemand = base.reduce((a, b) => a + b.demand, 0);
  const rows: AllocRow[] = base.map((b) => {
    const alloc = supply >= need - 1e-9 ? b.need : Math.max(0, ratio * b.target - b.onHand);
    const propAlloc = supply >= need - 1e-9 ? b.need : (supply * b.demand) / totalDemand;
    const mu = b.demand * span;
    const sd = b.sigma * Math.sqrt(span);
    return {
      key: b.st.key,
      name: b.st.name,
      demand: b.demand,
      onHand: b.onHand,
      safety: b.safety,
      target: b.target,
      need: b.need,
      alloc,
      cover: (b.onHand + alloc) / b.demand,
      fill: fillRate(b.onHand + alloc, mu, sd),
      propAlloc,
      propFill: fillRate(b.onHand + propAlloc, mu, sd),
    };
  });
  return { family, supply, need, ratio: supply >= need - 1e-9 ? 1 : ratio, rows, worstFill: Math.min(...rows.map((r) => r.fill)), worstPropFill: Math.min(...rows.map((r) => r.propFill)) };
}
