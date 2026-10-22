import { createRng, shortCode, type Order, type OrderLine } from '@storewright/domain';
import type { StoreModel, TemplateName } from '@storewright/store-config';
import type { Catalog } from './catalog';

/** 需求场景：与门店配置分开，同一家店可以跑不同的需求场景（平日、周末、节假日）。 */
export interface DemandScenario {
  ordersPerDay: number;
  /** 按时段起点所在小时的相对权重，长度 24 */
  hourlyProfile: number[];
  /** 杂货订单中自取的比例（其余为配送） */
  pickupShare: number;
  /** GM 订单占全部订单的比例 */
  gmOrderShare: number;
  /** GM 订单中配送的比例 */
  gmDeliveryShare: number;
  expressShare: number;
  basketMeanLines: number;
  basketSigma: number;
  maxLines: number;
  /** 每行数量 1、2、3、4 的相对权重 */
  qtyWeights: number[];
  substitutionAllowedShare: number;
  deliveryRadiusKm: [number, number];
}

const HOURLY = (() => {
  const w = new Array<number>(24).fill(0);
  const set: Record<number, number> = { 8: 0.5, 9: 0.8, 10: 1.0, 11: 1.2, 12: 1.1, 13: 0.9, 14: 0.9, 15: 1.0, 16: 1.2, 17: 1.3, 18: 1.1, 19: 0.7, 20: 0.4 };
  for (const [h, v] of Object.entries(set)) w[Number(h)] = v;
  return w;
})();

const BASE: Omit<DemandScenario, 'ordersPerDay'> = {
  hourlyProfile: HOURLY,
  pickupShare: 0.45,
  gmOrderShare: 0.08,
  gmDeliveryShare: 0.8,
  expressShare: 0.05,
  basketMeanLines: 20,
  basketSigma: 0.6,
  maxLines: 90,
  qtyWeights: [0.62, 0.24, 0.09, 0.05],
  substitutionAllowedShare: 0.7,
  deliveryRadiusKm: [1.5, 12],
};

/** 家居建材：早上施工队取货是第一个高峰，下午下班后是第二个；订单行数少、单件重、多件购买多，大件（GM）订单比例高 */
const HARDWARE_HOURLY = (() => {
  const w = new Array<number>(24).fill(0);
  const set: Record<number, number> = { 6: 0.6, 7: 1.4, 8: 1.5, 9: 1.2, 10: 1.0, 11: 0.9, 12: 0.8, 13: 0.8, 14: 0.9, 15: 1.0, 16: 1.1, 17: 1.0, 18: 0.7, 19: 0.4 };
  for (const [h, v] of Object.entries(set)) w[Number(h)] = v;
  return w;
})();

const HARDWARE: DemandScenario = {
  ordersPerDay: 150,
  hourlyProfile: HARDWARE_HOURLY,
  pickupShare: 0.72,
  gmOrderShare: 0.28,
  gmDeliveryShare: 0.6,
  expressShare: 0.1,
  basketMeanLines: 6,
  basketSigma: 0.7,
  maxLines: 40,
  qtyWeights: [0.45, 0.25, 0.12, 0.18],
  substitutionAllowedShare: 0.5,
  deliveryRadiusKm: [2, 25],
};

export const DEFAULT_DEMAND: Record<TemplateName, DemandScenario> = {
  small: { ...BASE, ordersPerDay: 70 },
  medium: { ...BASE, ordersPerDay: 260 },
  large: { ...BASE, ordersPerDay: 650 },
  hardware: HARDWARE,
};

const FIRST = ['Wei', 'Maria', 'James', 'Aisha', 'Hiroshi', 'Olivia', 'Mateo', 'Priya', 'Noah', 'Fatima', 'Liam', 'Sofia', 'Chen', 'Amara', 'Ethan', 'Yuki', 'Diego', 'Grace', 'Omar', 'Hannah', 'Alexandria', 'Bartholomew', 'Seo-yeon', 'Kwame'];
const LAST = ['Zhang', 'Lopez', 'Carter', 'Khan', 'Tanaka', 'Smith', 'Garcia', 'Patel', 'Johnson', 'Nguyen', 'Brown', 'Rossi', 'Chen', 'Okafor', 'Miller', 'Sato', 'Hernandez', 'Kim', 'Haddad', 'Schmidt', 'Konstantinopoulos', 'Featherstonehaugh', 'Park', 'Mensah'];

/**
 * 生成一天的订单流。
 * 时段从开门后 1 小时到关门前 1 小时；每个时段的订单数服从泊松分布。
 */
export function generateOrders(model: StoreModel, catalog: Catalog, scenario: DemandScenario, options: { seed: number; day?: number }): Order[] {
  const rng = createRng(options.seed);
  const day = options.day ?? 1;
  const { rules, hours, modules } = model.config;
  const slotLen = rules.slotLengthMin * 60;
  const slots: number[] = [];
  for (let t = (hours.openMin + 60) * 60; t + slotLen <= (hours.closeMin - 60) * 60 + 1; t += slotLen) slots.push(t);
  const slotWeight = slots.map((s) => {
    let w = 0;
    for (let h = Math.floor(s / 3600); h < Math.ceil((s + slotLen) / 3600); h++) w += scenario.hourlyProfile[h] ?? 0;
    return w;
  });
  const totalWeight = slotWeight.reduce((a, b) => a + b, 0);
  const grocery = catalog.samplers.GROCERY;
  const gm = catalog.samplers.GM;
  if (!grocery) throw new Error('Catalog has no grocery items');

  const orders: Order[] = [];
  let seq = 0;
  const mu = Math.log(scenario.basketMeanLines) - (scenario.basketSigma * scenario.basketSigma) / 2;

  slots.forEach((slotStart, si) => {
    const n = rng.poisson((scenario.ordersPerDay * (slotWeight[si] as number)) / totalWeight);
    for (let k = 0; k < n; k++) {
      const id = `O${day}-${String(++seq).padStart(5, '0')}`;
      const isGm = modules.gm && gm !== undefined && rng.chance(scenario.gmOrderShare);
      const sampler = isGm && gm ? gm : grocery;
      const lineCount = isGm
        ? 1 + rng.poisson(0.8)
        : Math.min(scenario.maxLines, Math.max(1, Math.round(rng.logNormal(mu, scenario.basketSigma))));
      const seen = new Set<string>();
      const lines: OrderLine[] = [];
      let guard = 0;
      while (lines.length < lineCount && guard++ < lineCount * 20) {
        const item = sampler.sample(rng);
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        let qty = 1 + rng.weightedIndex(scenario.qtyWeights);
        if (item.pricing === 'WEIGHT') qty = 1;
        if (item.weightKg > 8) qty = Math.min(qty, 2);
        lines.push({ lineId: `${id}-L${lines.length + 1}`, itemId: item.id, qty, allowSubstitution: rng.chance(scenario.substitutionAllowedShare) });
      }
      const type = isGm ? (rng.chance(scenario.gmDeliveryShare) ? 'DELIVERY' : 'PICKUP') : rng.chance(scenario.pickupShare) ? 'PICKUP' : 'DELIVERY';
      const express = !isGm && rng.chance(scenario.expressShare);
      const createdAt = express ? slotStart - rng.uniform(60, 100) * 60 : slotStart - rng.uniform(3, 30) * 3600;
      const angle = rng.uniform(0, 2 * Math.PI);
      const r = Math.sqrt(rng.uniform(scenario.deliveryRadiusKm[0] ** 2, scenario.deliveryRadiusKm[1] ** 2));
      orders.push({
        id,
        shortCode: shortCode(id),
        customer: { id: `C-${id}`, firstName: rng.pick(FIRST), lastName: rng.pick(LAST) },
        type,
        fulfillmentType: isGm ? 'GM' : 'GROCERY',
        express,
        createdAt: Math.round(createdAt),
        slotStart,
        slotLengthSec: slotLen,
        lines,
        ...(type === 'DELIVERY' ? { destinationKm: { x: Math.round(r * Math.cos(angle) * 100) / 100, y: Math.round(r * Math.sin(angle) * 100) / 100 } } : {}),
      });
    }
  });
  return orders;
}
