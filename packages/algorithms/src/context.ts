import type { Item } from '@storewright/domain';
import type { StoreModel } from '@storewright/store-config';

export interface PlanningContext {
  model: StoreModel;
  items: ReadonlyMap<string, Item>;
}

/**
 * 拣货标准工时（秒）。批次划分和冷链时限检查只用这些标准值估算用时，
 * 不读取商品重量和体积（工程约束 EC-1）。
 */
export interface PickStandards {
  /** 每辆推车的固定准备时间（领车、扫描绑定框、回暂存区） */
  baseSec: number;
  /** 每个拣货行：找位、核对 */
  perLineSec: number;
  /** 每件：扫描、放入框 */
  perUnitSec: number;
  /** 每进入一条新的货架通道 */
  perRunSec: number;
}

export const DEFAULT_PICK_STANDARDS: PickStandards = {
  baseSec: 180,
  perLineSec: 18,
  perUnitSec: 4,
  perRunSec: 30,
};

export function getItem(ctx: PlanningContext, itemId: string): Item {
  const item = ctx.items.get(itemId);
  if (!item) throw new Error(`Unknown item ${itemId}`);
  return item;
}
