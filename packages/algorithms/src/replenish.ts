import type { TempZone } from '@storewright/domain';

/**
 * 补货与后仓库存的共用规则（实时系统与模拟器都用）。
 *
 * - 预计售罄时间与补货触发（决策 R-05）；
 * - 补货优先级：预计售罄时间越短越靠前，扣除已被在线订单占用的件数，按单价轻度加权；
 * - 同一通道的任务合并成批；
 * - ABC 分类与盘点周期（决策 I-04）；
 * - 上架库位的温区与隔离规则、库位建议（决策 I-03）。
 */

export interface ReplenishRules {
  /** 估算件数不高于容量的这个比例时触发 */
  lowFraction: number;
  /** 预计售罄时间短于这个小时数时触发 */
  sellOutHorizonH: number;
  /** 每批最多任务数 */
  batchSize: number;
}

export const DEFAULT_REPLENISH_RULES: ReplenishRules = { lowFraction: 0.25, sellOutHorizonH: 2, batchSize: 8 };

/** 预计售罄时间（小时）；几乎不动销时为无穷大 */
export function sellOutHours(est: number, velocityPerHour: number): number {
  if (est <= 0) return 0;
  if (velocityPerHour <= 1e-6) return Number.POSITIVE_INFINITY;
  return est / velocityPerHour;
}

export interface ShelfNeed {
  est: number;
  capacity: number;
  velocityPerHour: number;
  /** 已下单但还没拣的件数（在线订单占用） */
  onlineDemand: number;
}

export function needsReplenishment(s: ShelfNeed, rules: ReplenishRules = DEFAULT_REPLENISH_RULES): boolean {
  if (s.capacity <= 0) return false;
  const free = s.est - s.onlineDemand;
  if (free <= s.capacity * rules.lowFraction) return true;
  return sellOutHours(free, s.velocityPerHour) < rules.sellOutHorizonH;
}

/** 建议补货件数：补到满 */
export function suggestedUnits(s: Pick<ShelfNeed, 'est' | 'capacity'>): number {
  return Math.max(0, Math.round(s.capacity - Math.max(0, s.est)));
}

/**
 * 优先级（分钟，越小越优先）：扣除在线订单占用后的预计售罄时间，单价高的略提前（最多提前 15%）。
 * 货架已空或不够在线订单时为 0。
 */
export function replenishPriority(s: ShelfNeed & { unitPrice: number }): number {
  const free = s.est - s.onlineDemand;
  if (free <= 0) return 0;
  const hours = sellOutHours(free, Math.max(s.velocityPerHour, 0.05));
  const priceBoost = 1 - 0.15 * Math.min(1, Math.max(0, s.unitPrice) / 20);
  return Math.round(hours * 60 * priceBoost);
}

export interface BatchableTask {
  id: string;
  /** 通道（同一通道合并成批） */
  area: string;
  priority: number;
}

/** 同一通道的任务合并成批：批按其中最紧急的任务排序，批内按优先级排序 */
export function batchByArea<T extends BatchableTask>(tasks: readonly T[], batchSize = DEFAULT_REPLENISH_RULES.batchSize): T[][] {
  const groups = new Map<string, T[]>();
  for (const t of tasks) {
    const g = groups.get(t.area) ?? [];
    g.push(t);
    groups.set(t.area, g);
  }
  const batches: T[][] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    for (let i = 0; i < g.length; i += batchSize) batches.push(g.slice(i, i + batchSize));
  }
  return batches.sort((a, b) => (a[0]?.priority ?? 0) - (b[0]?.priority ?? 0) || (a[0]?.id ?? '').localeCompare(b[0]?.id ?? ''));
}

export type AbcClass = 'A' | 'B' | 'C';

/** 盘点周期（天）：A 每周、B 每月、C 每季度 */
export const COUNT_INTERVAL_DAYS: Record<AbcClass, number> = { A: 7, B: 30, C: 90 };

/** 按价值（日销量 × 单价）的帕累托分类：累计价值前 80% 为 A，接下来 15% 为 B，其余为 C */
export function classifyAbc(items: ReadonlyArray<{ id: string; value: number }>): Map<string, AbcClass> {
  const sorted = [...items].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const total = sorted.reduce((n, x) => n + Math.max(0, x.value), 0);
  const out = new Map<string, AbcClass>();
  let acc = 0;
  for (const x of sorted) {
    const share = total > 0 ? acc / total : 1;
    out.set(x.id, share < 0.8 ? 'A' : share < 0.95 ? 'B' : 'C');
    acc += Math.max(0, x.value);
  }
  return out;
}

export type InventoryStatus = 'SELLABLE' | 'QA' | 'RTV' | 'SCRAP';

export interface BinRule {
  code: string;
  tempZone: TempZone;
  status: InventoryStatus;
  /** 存储分区（大类分区）；CHEM 为化学品隔离区 */
  area: string;
  capacityCases: number;
}

export interface ItemRule {
  tempZone: TempZone;
  chemical: boolean;
  /** 商品所属的存储分区 */
  area: string;
}

export type BinCheck = 'OK' | 'ZONE' | 'ISOLATION' | 'STATUS' | 'FULL';

/** 放进某个库位前的检查：温区、隔离（化学品与食品分开）、库存状态、容量（决策 I-03、I-05） */
export function checkBin(bin: BinRule, item: ItemRule, used: number, status: InventoryStatus = 'SELLABLE'): BinCheck {
  if (bin.status !== status) return 'STATUS';
  if (bin.tempZone !== item.tempZone) return 'ZONE';
  // 待检、退供应商、报废区本身就是隔离区，只在可售区强制化学品与食品分开
  if (status === 'SELLABLE' && (bin.area === 'CHEM') !== item.chemical) return 'ISOLATION';
  if (used >= bin.capacityCases) return 'FULL';
  return 'OK';
}

/**
 * 上架库位建议：大类分区内选最空的库位，分区满了再看同温区的其他库位；隔离规则始终强制。
 * status 是这箱货的库存状态：待检、退供应商、报废的箱子只能放进对应状态的库位（默认可售）。
 */
export function suggestBins(bins: readonly BinRule[], used: (code: string) => number, item: ItemRule, limit = 3, status: InventoryStatus = 'SELLABLE'): string[] {
  const ok = bins.filter((b) => checkBin(b, item, used(b.code), status) === 'OK');
  return ok
    .map((b) => ({ code: b.code, score: (b.area === item.area ? 0 : 1000) + used(b.code) / Math.max(1, b.capacityCases) }))
    .sort((a, b) => a.score - b.score || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map((x) => x.code);
}
