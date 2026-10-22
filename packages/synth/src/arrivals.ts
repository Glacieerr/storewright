import { createRng, hashString } from '@storewright/domain';
import type { DemandHistory } from './history';

/**
 * 合成到店记录（Phase 5b · 到店时间修正）。
 *
 * 顾客点「我在路上」时，手机导航给出一个预计到达时间；实际到达和它有偏差：
 * - 导航只反映了约 60% 的高峰拥堵（模型可以知道是不是高峰时段）；
 * - 大雨让路上更慢（模型只能看到带误差的天气预报）；
 * - 每位顾客有自己的习惯：有人总是晚到、有人总是早到（模型能看到这位顾客以前的记录）；
 * - 约 12% 的顾客路上会顺便办点别的事，晚到 5–15 分钟（模型看不到）。
 *
 * 天气与天气预报取自同一份合成需求历史，两者在同一天一致。全部为假设参数。
 */

export interface ArrivalRecord {
  day: number;
  dow: number;
  hour: number;
  /** 订单时间（天序号 × 1440 + 分钟），用于按时间先后切分训练与测试 */
  t: number;
  customer: string;
  /** 导航给出的预计用时（分钟） */
  reportedMin: number;
  /** 实际用时（分钟） */
  actualMin: number;
  /** 事先可以知道的特征 */
  x: { rush: number; weekend: number; rainHeavy: number; forecastRainMm: number };
  hidden: { bias: number; stop: boolean; trafficMult: number; weatherMult: number; baseMin: number };
}

export interface ArrivalOptions {
  seed: number;
  history: DemandHistory;
  /** 每天点了「我在路上」的自取订单数（默认 110） */
  perDay?: number;
  /** 顾客人数（默认 600；少数常客下单最多） */
  customers?: number;
}

/** 平日早晚高峰 */
export function isRushHour(dow: number, hour: number): boolean {
  return dow >= 1 && dow <= 5 && ((hour >= 7 && hour < 9) || (hour >= 16 && hour < 19));
}

export function generateArrivals(opts: ArrivalOptions): ArrivalRecord[] {
  const rng = createRng(hashString(`${opts.seed}:arrivals`));
  const n = opts.customers ?? 600;
  const customers = Array.from({ length: n }, (_, i) => ({
    id: `C${String(i + 1).padStart(4, '0')}`,
    bias: rng.normal(0.5, 4),
    sd: rng.uniform(1.5, 5),
    weight: 1 / Math.pow(i + 1, 0.8),
  }));
  const weights = customers.map((c) => c.weight);
  const hours = opts.history.hours;
  const out: ArrivalRecord[] = [];
  for (const d of opts.history.days) {
    const congestion = rng.normal(0, 0.05);
    const k = rng.poisson(opts.perDay ?? 110);
    for (let i = 0; i < k; i++) {
      const c = customers[rng.weightedIndex(weights)] as (typeof customers)[number];
      const hour = hours[rng.int(0, hours.length - 1)] as number;
      const minute = rng.int(0, 59);
      const rush = isRushHour(d.dow, hour);
      const baseMin = rng.uniform(6, 30);
      const trafficMult = Math.max(0.8, (rush ? 1.35 : 1) + congestion);
      const weatherMult = d.hidden.rainMm >= 10 ? 1.15 : d.hidden.storm ? 1.3 : 1;
      const reported = baseMin * (1 + 0.6 * (trafficMult - 1)) * (1 + rng.normal(0, 0.05));
      const stop = rng.chance(0.12);
      const actual = baseMin * trafficMult * weatherMult + c.bias + rng.normal(0, c.sd) + (stop ? rng.uniform(5, 15) : 0);
      out.push({
        day: d.day,
        dow: d.dow,
        hour,
        t: d.day * 1440 + hour * 60 + minute,
        customer: c.id,
        reportedMin: Math.round(reported * 10) / 10,
        actualMin: Math.round(Math.max(1, actual) * 10) / 10,
        x: { rush: rush ? 1 : 0, weekend: d.dow === 0 || d.dow === 6 ? 1 : 0, rainHeavy: d.observed.forecastRainMm >= 10 ? 1 : 0, forecastRainMm: d.observed.forecastRainMm },
        hidden: { bias: Math.round(c.bias * 10) / 10, stop, trafficMult: Math.round(trafficMult * 1000) / 1000, weatherMult, baseMin: Math.round(baseMin * 10) / 10 },
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
