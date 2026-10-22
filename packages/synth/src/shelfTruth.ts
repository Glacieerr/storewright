import { createRng, hashString } from '@storewright/domain';

/**
 * 合成货架真实存量（Phase 5b · 可售概率与幽灵库存）。
 *
 * 每个商品按小时模拟：顾客需求（泊松）、收银扣减系统估算、补货、夜班补满、线上拣货员找货。
 * 系统只知道「上次确认的数量 − 之后的收银销售」，看不到的有两种：
 * - 幽灵库存：货被放错位置或整批丢失，货架上实际找不到，但系统估算仍然大于 0；
 * - 零星损耗：少量被拿走或损坏，没有经过收银，系统估算偏高。
 * 幽灵库存在补货员到货架、或拣货员报告找不到时被发现并纠正。
 *
 * 每个「系统认为有货」的商品-小时产生一条观测：特征（模型可以看到）+ 真实答案（货架上到底有没有）。
 * 全部为假设参数。
 */

export interface ShelfObservation {
  item: string;
  day: number;
  hour: number;
  /** 系统估算的件数（≥ 1） */
  est: number;
  /** 满架容量 */
  capacity: number;
  /** 平均每小时销量（营业时间） */
  velocity: number;
  /** 距离上一次收银销售的小时数（从未卖出过时为距离上次确认） */
  hoursSinceSale: number;
  /** 这段时间按销量本应卖出的件数 */
  expectedSinceSale: number;
  /** 距离上一次员工确认（补货上架、盘点、找不到）的小时数 */
  hoursSinceConfirm: number;
  /** 真实答案：货架上找得到至少 1 件 */
  available: boolean;
  /** 幽灵库存（系统有、实际没有） */
  phantom: boolean;
}

export interface ShelfTruthOptions {
  seed: number;
  items?: number;
  days?: number;
  /** 营业时间 [开门, 关门) */
  hours?: [number, number];
  /** 每个商品每天发生「整批找不到」的平均概率 */
  phantomRate?: number;
}

const PROFILE = [0, 0, 0, 0, 0, 0, 0, 0.5, 0.8, 1, 1.1, 1.3, 1.2, 1, 0.9, 1, 1.2, 1.4, 1.3, 1, 0.7, 0.4, 0.2, 0];

export function generateShelfTruth(opts: ShelfTruthOptions): ShelfObservation[] {
  const rng = createRng(hashString(`${opts.seed}:shelf`));
  const nItems = opts.items ?? 200;
  const days = opts.days ?? 60;
  const [open, close] = opts.hours ?? [7, 22];
  const baseRate = opts.phantomRate ?? 0.015;
  const out: ShelfObservation[] = [];
  for (let i = 0; i < nItems; i++) {
    const id = `I${String(i + 1).padStart(4, '0')}`;
    const v = Math.min(6, Math.exp(rng.normal(Math.log(0.6), 0.9)));
    const capacity = Math.max(6, Math.ceil(v * 16 * 1.5));
    // 小件、容易被拿走的商品更容易出现幽灵库存
    const prone = rng.chance(0.3);
    const hazard = baseRate * (prone ? 2.5 : 0.6);
    let truth = capacity;
    let est = capacity;
    let phantom = false;
    let lastSale = 0;
    let lastConfirm = 0;
    let restockDue: number | undefined;
    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        const t = d * 24 + h;
        if (h === 6 && est < capacity * 0.6) {
          // 夜班补满：补货员看到真实货架，幽灵库存被纠正
          truth = capacity;
          est = capacity;
          phantom = false;
          lastConfirm = t;
          restockDue = undefined;
        }
        if (h < open || h >= close) continue;
        if (est >= 1) {
          let expected = 0;
          for (let k = Math.max(lastSale, lastConfirm); k < t; k++) expected += v * (PROFILE[k % 24] ?? 0);
          out.push({
            item: id,
            day: d,
            hour: h,
            est,
            capacity,
            velocity: Math.round(v * 1000) / 1000,
            hoursSinceSale: t - Math.max(lastSale, lastConfirm),
            expectedSinceSale: Math.round(expected * 100) / 100,
            hoursSinceConfirm: t - lastConfirm,
            available: !phantom && truth >= 1,
            phantom: phantom || truth < 1,
          });
        }
        // 隐藏事件：整批找不到、零星损耗
        if (!phantom && rng.chance(hazard / (close - open))) phantom = true;
        if (truth > 0 && rng.chance(0.004 * (prone ? 2 : 1))) truth = Math.max(0, truth - rng.int(1, 3));
        // 顾客购买
        const demand = rng.poisson(v * (PROFILE[h] ?? 0));
        const sold = phantom ? 0 : Math.min(demand, truth);
        if (sold > 0) {
          truth -= sold;
          est = Math.max(0, est - sold);
          lastSale = t + 1;
        }
        // 线上拣货员找货：找不到时报告，系统把估算清零（触发补货）
        if (rng.chance(Math.min(0.5, v * 0.15))) {
          if (phantom || truth < 1) {
            est = 0;
            lastConfirm = t + 1;
            restockDue = restockDue ?? t + rng.int(1, 3);
          } else if (truth > 0) {
            truth -= 1;
            est = Math.max(0, est - 1);
            lastSale = t + 1;
          }
        }
        // 系统估算偏低时安排补货；补货员到货架后按真实情况补满
        if (restockDue === undefined && est <= capacity * 0.25) restockDue = t + rng.int(1, 3);
        if (restockDue !== undefined && t >= restockDue) {
          truth = capacity;
          est = capacity;
          phantom = false;
          lastConfirm = t + 1;
          restockDue = undefined;
        }
      }
    }
  }
  return out;
}
