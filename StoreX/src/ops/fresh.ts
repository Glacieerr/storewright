import type { Rng } from '../core/rng';
import { CATEGORY } from '../world/catalog';
import type { Scenario } from '../world/config';
import type { Category } from '../world/layout';

/**
 * 生鲜损耗：按大类做多天的库存仿真（订货 → 按先进先出卖 → 临期打折 → 过期报废）。
 * 上一代：预测误差大，最后一天统一打 6 折；本方案：AI 预测误差小，电子价签从过期前两天开始逐步降价。
 */
export interface FreshResult {
  /** 报废件数占进货件数 */
  wastePct: number;
  /** 打折损失占生鲜销售额 */
  markdownPct: number;
  /** 缺货没卖成的需求占比 */
  lostPct: number;
  /** 每天的报废金额、打折损失、缺货损失的毛利（美元） */
  wasteValue: number;
  markdownCost: number;
  lostMargin: number;
  byCategory: Record<string, { wastePct: number; markdownPct: number; lostPct: number }>;
}

const PERISHABLE: readonly Category[] = ['dairy', 'produce', 'meat', 'bakery'];
/** 各大类的陈列量系数（果蔬、乳品陈列最满，肉类、面包少一些） */
const PRESENTATION: Partial<Record<Category, number>> = { dairy: 1.0, produce: 1.3, meat: 0.6, bakery: 0.5 };
/**
 * 每天因搬运、挑拣、品相变差、现做食品卖不完而不能卖的比例（占库存）。
 * 校准到公开资料里门店常见的损耗水平：果蔬约 10%、面包熟食约 10%、肉类 4–5%、乳品 2–3%。
 */
const SPOIL: Partial<Record<Category, number>> = { dairy: 0.018, produce: 0.075, meat: 0.05, bakery: 0.035 };
/** 顾客挑最新鲜那批的比例（其余按先进先出） */
const LIFO = 0.5;

export function freshWaste(s: Scenario, dailyUnits: Partial<Record<Category, number>>, rng: Rng): FreshResult {
  let wasteValue = 0;
  let markdownCost = 0;
  let lostMargin = 0;
  let suppliedAll = 0;
  let wasteAll = 0;
  let salesAll = 0;
  let demandAll = 0;
  let lostAll = 0;
  const byCategory: FreshResult['byCategory'] = {};
  for (const c of PERISHABLE) {
    const spec = CATEGORY[c];
    const life = spec.shelfLifeDays ?? 3;
    const mean = dailyUnits[c] ?? 0;
    if (mean <= 0) continue;
    const price = spec.price;
    const cost = price * (1 - spec.margin);
    const err = s.fresh.forecastError;
    // 先进先出的批次：[剩余件数, 已放天数]
    let cohorts: { qty: number; age: number }[] = [];
    let supplied = 0;
    let waste = 0;
    let sold = 0;
    let lost = 0;
    let markdownUnits = 0;
    let markdownLoss = 0;
    let demandTotal = 0;
    const days = 70;
    const warm = 14;
    for (let d = 0; d < days; d++) {
      // 订货补到目标量：预测的需求（有误差）+ 和误差相称的安全量 + 陈列量，减去还能卖的库存
      const forecast = mean * Math.max(0.2, 1 + rng.normal(0, err));
      const onHand = cohorts.filter((k) => k.age < life - 1).reduce((a, k) => a + k.qty, 0);
      const target = forecast * (1 + s.fresh.safety * err) + mean * s.fresh.presentationDays * (PRESENTATION[c] ?? 1);
      const order = Math.max(0, Math.round(target - onHand));
      cohorts.push({ qty: order, age: 0 });
      if (d >= warm) supplied += order;
      // 当天需求（日间波动）：一半顾客挑最新鲜的，其余先拿最老的
      let demand = Math.max(0, Math.round(mean * (1 + rng.normal(0, 0.22))));
      if (d >= warm) demandTotal += demand;
      const pickers = [Math.round(demand * LIFO), demand - Math.round(demand * LIFO)];
      demand = 0;
      for (const [n, order] of [
        [pickers[0] as number, [...cohorts].reverse()],
        [pickers[1] as number, cohorts],
      ] as const) {
        let want = n;
        for (const k of order) {
          const take = Math.min(k.qty, want);
          k.qty -= take;
          want -= take;
          if (d >= warm) sold += take;
          if (want === 0) break;
        }
        demand += want;
      }
      if (d >= warm) lost += demand;
      // 搬运、挑拣损坏（本方案温控和轮换更好，损坏少一成半）
      const spoil = (SPOIL[c] ?? 0) * (s.fresh.dynamicMarkdown ? 0.85 : 1);
      for (const k of cohorts) {
        const bad = Math.round(k.qty * spoil);
        k.qty -= bad;
        if (d >= warm) waste += bad;
      }
      // 临期打折：明天就过期的批次（动态降价从过期前两天开始）
      for (const k of cohorts) {
        const daysLeft = life - 1 - k.age;
        if (k.qty <= 0) continue;
        if (s.fresh.dynamicMarkdown && daysLeft <= 1) {
          const share = daysLeft === 0 ? 0.55 : 0.3;
          const disc = daysLeft === 0 ? 0.35 : 0.15;
          const q = Math.round(k.qty * share);
          k.qty -= q;
          if (d >= warm) {
            markdownUnits += q;
            markdownLoss += q * price * disc;
            sold += q;
          }
        } else if (!s.fresh.dynamicMarkdown && daysLeft === 0) {
          const q = Math.round(k.qty * 0.35);
          k.qty -= q;
          if (d >= warm) {
            markdownUnits += q;
            markdownLoss += q * price * 0.4;
            sold += q;
          }
        }
      }
      // 过期报废，其余批次老一天
      for (const k of cohorts) if (k.age >= life - 1 && d >= warm) waste += k.qty;
      cohorts = cohorts.filter((k) => k.age < life - 1 && k.qty > 0).map((k) => ({ qty: k.qty, age: k.age + 1 }));
    }
    const n = days - warm;
    const salesValue = (sold / n) * price;
    byCategory[c] = {
      wastePct: supplied > 0 ? (waste / supplied) * 100 : 0,
      markdownPct: salesValue > 0 ? (markdownLoss / n / salesValue) * 100 : 0,
      lostPct: demandTotal > 0 ? (lost / demandTotal) * 100 : 0,
    };
    wasteValue += (waste / n) * cost;
    markdownCost += markdownLoss / n;
    lostMargin += (lost / n) * price * spec.margin;
    suppliedAll += supplied / n;
    wasteAll += waste / n;
    salesAll += salesValue;
    demandAll += demandTotal / n;
    lostAll += lost / n;
  }
  return {
    wastePct: suppliedAll > 0 ? (wasteAll / suppliedAll) * 100 : 0,
    markdownPct: salesAll > 0 ? (markdownCost / salesAll) * 100 : 0,
    lostPct: demandAll > 0 ? (lostAll / demandAll) * 100 : 0,
    wasteValue,
    markdownCost,
    lostMargin,
    byCategory,
  };
}
