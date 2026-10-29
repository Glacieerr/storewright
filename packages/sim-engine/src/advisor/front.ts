import { rankReasons } from '@storewright/ai';
import { erlangWaitMin, FRONT_RULES } from '@storewright/algorithms';
import type { Advice } from './types';

/**
 * 前场的建议（决策记录 0020 · 方向 4）：
 * - 收银通道：按每小时到店的顾客（停车场模型）和每层的收银台，用排队论（Erlang C）算出每小时开几条人工通道
 *   能让平均排队不超过 2 分钟；和「全天全开」比省多少人工通道小时，全开也排不过来的时段单独提醒；
 * - 停车场：哪些时段占用到 90% 以上，安排人引导到远一点的车位和溢流区。
 */

export interface FrontFloor {
  floorId: string;
  /** 人工收银通道、自助收银机的数量 */
  manual: number;
  self: number;
  /** 在这一层结账的顾客比例 */
  share: number;
}

export interface FrontInput {
  /** 每小时到店的顾客（每辆车算一次结账） */
  shoppersByHour: number[];
  /** 每小时停车场里最多停了几辆车，与车位数 */
  parkingByHour: number[];
  parkingSpots: number;
  floors: FrontFloor[];
  /** 营业时间（当天的秒数） */
  open: number;
  close: number;
}

// 排队公式和前场规则在 algorithms 包里（门店的实时收银通道建议也用，决策记录 0022 · A3）
export { erlangWaitMin, FRONT_RULES } from '@storewright/algorithms';

export function adviseFront(input: FrontInput): Advice[] {
  const out: Advice[] = [];
  const h0 = Math.floor(input.open / 3600);
  const h1 = Math.ceil(input.close / 3600);
  const mu = 1 / FRONT_RULES.serviceMin;
  // ---------- 1. 收银通道 ----------
  const plan: Array<{ floorId: string; byHour: number[] }> = [];
  let laneHours = 0;
  let allOpen = 0;
  let worst = 0;
  const short: Array<{ floorId: string; hour: number; wait: number }> = [];
  let peakLanes = 0;
  let peakAt = h0;
  for (const f of input.floors) {
    if (f.manual <= 0) continue;
    const byHour = new Array<number>(24).fill(0);
    for (let h = h0; h < h1; h++) {
      const perMin = ((input.shoppersByHour[h] ?? 0) * f.share * (f.self > 0 ? 1 - FRONT_RULES.selfShare : 1)) / 60;
      let c = 1;
      while (c < f.manual && erlangWaitMin(perMin, mu, c) > FRONT_RULES.targetWaitMin) c++;
      byHour[h] = c;
      laneHours += c;
      allOpen += f.manual;
      const w = erlangWaitMin(perMin, mu, c);
      if (w > worst) worst = w;
      if (w > FRONT_RULES.shortWaitMin) short.push({ floorId: f.floorId, hour: h, wait: w });
      if (c > peakLanes) {
        peakLanes = c;
        peakAt = h;
      }
    }
    plan.push({ floorId: f.floorId, byHour });
  }
  if (plan.length) {
    const peakShoppers = Math.max(...input.shoppersByHour.slice(h0, h1));
    out.push({
      id: 'FRONT:CHECKOUT_PLAN',
      area: 'FRONT',
      code: 'CHECKOUT_PLAN',
      severity: 'info',
      from: h0 * 3600,
      to: h1 * 3600,
      params: { peakLanes, peakAt, peakShoppers: Math.round(peakShoppers), laneHours, allOpen, floors: plan.length },
      reasons: rankReasons(
        [
          { factor: 'PEAK_SHOPPERS', value: Math.round(peakShoppers), weight: 0.4, params: { hour: peakAt } },
          { factor: 'SERVICE_MIN', value: FRONT_RULES.serviceMin, weight: 0.2 },
          { factor: 'SELF_CHECKOUT', value: Math.round(FRONT_RULES.selfShare * 100), weight: 0.2 },
          { factor: 'TARGET_WAIT', value: FRONT_RULES.targetWaitMin, weight: 0.2 },
        ],
        4,
      ),
      action: { kind: 'CHECKOUT_PLAN', lanes: plan },
      effect: [
        { metric: 'LANE_HOURS', unit: 'HOURS', before: allOpen, after: laneHours, better: 'lower' },
        ...(Number.isFinite(worst) ? [{ metric: 'CHECKOUT_WAIT', unit: 'MIN' as const, before: 0, after: Math.round(worst * 10) / 10, better: 'lower' as const }] : []),
      ],
      confidence: 0.7,
      focus: { t: peakAt * 3600 + 1800, kind: 'checkout' },
    });
    // 全开也排不过来的时段
    const bad = short.sort((a, b) => b.wait - a.wait)[0];
    if (bad)
      out.push({
        id: `FRONT:CHECKOUT_SHORT:${bad.floorId}`,
        area: 'FRONT',
        code: 'CHECKOUT_SHORT',
        severity: 'warn',
        from: bad.hour * 3600,
        to: (bad.hour + 1) * 3600,
        params: { floorId: bad.floorId, hour: bad.hour, wait: Number.isFinite(bad.wait) ? Math.round(bad.wait * 10) / 10 : 99, lanes: input.floors.find((f) => f.floorId === bad.floorId)?.manual ?? 0 },
        reasons: rankReasons([{ factor: 'PEAK_SHOPPERS', value: Math.round(input.shoppersByHour[bad.hour] ?? 0), weight: 0.6, params: { hour: bad.hour } }, { factor: 'LANES', value: input.floors.find((f) => f.floorId === bad.floorId)?.manual ?? 0, weight: 0.4 }], 2),
        confidence: 0.65,
        focus: { t: bad.hour * 3600 + 1800, kind: 'checkout' },
      });
  }

  // ---------- 2. 停车场高峰 ----------
  if (input.parkingSpots > 0) {
    const full: number[] = [];
    for (let h = h0; h < h1; h++) if ((input.parkingByHour[h] ?? 0) / input.parkingSpots >= 0.9) full.push(h);
    if (full.length) {
      const from = full[0] as number;
      let to = from;
      while (full.includes(to + 1)) to++;
      const peak = Math.max(...full.map((h) => (input.parkingByHour[h] ?? 0) / input.parkingSpots));
      out.push({
        id: `FRONT:PARKING:${from}`,
        area: 'FRONT',
        code: 'PARKING_PEAK',
        severity: peak >= 0.97 ? 'warn' : 'info',
        from: from * 3600,
        to: (to + 1) * 3600,
        params: { fromHour: from, toHour: to + 1, peak: Math.round(peak * 100), spots: input.parkingSpots },
        reasons: rankReasons([{ factor: 'PARKING_PEAK', value: Math.round(peak * 100), weight: 0.6 }, { factor: 'PARKING_SPOTS', value: input.parkingSpots, weight: 0.4 }], 2),
        action: { kind: 'PARKING_GUIDE', fromHour: from, toHour: to + 1 },
        confidence: 0.75,
        focus: { t: from * 3600 + 1800, kind: 'lot' },
      });
    }
  }
  return out;
}
