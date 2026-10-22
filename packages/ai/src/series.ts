import type { SeriesPoint } from './forecast';

/**
 * 特征层的第一部分：把按天汇总的数据展开成按小时的时间序列。
 * 合成历史和事件流都先汇总成 DailyHours，再交给预测器，模型不关心数据来自哪里。
 */

export interface DailyHours {
  day: number;
  dow: number;
  /** 长度 24：每小时的值（例如按取货时段开始时间统计的订单数） */
  hourly: readonly number[];
  /** 当天事先可以知道的特征（促销、节假日、天气预报） */
  x?: Record<string, number>;
  /** 样本权重 */
  w?: number;
}

/** 只保留给定的营业小时 */
export function hourlySeries(days: readonly DailyHours[], hours: readonly number[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const d of days)
    for (const h of hours) {
      const p: SeriesPoint = { day: d.day, dow: d.dow, hour: h, y: d.hourly[h] ?? 0 };
      if (d.x) p.x = d.x;
      if (d.w !== undefined) p.w = d.w;
      out.push(p);
    }
  return out;
}

/** 对照值：最近 weeks 周同一星期、同一小时的平均（界面显示「比平时高 / 低多少」） */
export function usualLevel(series: readonly SeriesPoint[], dow: number, hour: number, weeks = 4): number | undefined {
  const xs = series
    .filter((p) => p.dow === dow && p.hour === hour)
    .sort((a, b) => a.day - b.day)
    .slice(-weeks)
    .map((p) => p.y);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}
