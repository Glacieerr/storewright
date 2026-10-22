import type { Forecaster, PointForecast, SeriesPoint } from './forecast';
import { forecastMetrics } from './metrics';

/**
 * 滚动起点回测：用第 0…k 天训练，预测之后 horizonDays 天；起点每次后移 stepDays 天。
 * 每一折只用起点之前的数据，相当于「每天晚上用当时已有的数据重训一次」。
 * 汇总指标把所有折的预测点放在一起计算（不是各折指标的平均）。
 */

export interface BacktestOptions {
  /** 第一折的训练天数 */
  initialDays: number;
  horizonDays: number;
  stepDays: number;
  /** 只保留最近的若干折 */
  maxFolds?: number;
  /** 只评估满足条件的点（例如只看节假日、只看结构性变化之后），训练不受影响 */
  filter?: (p: SeriesPoint) => boolean;
}

export interface BacktestFold {
  /** 训练集最后一天 */
  trainTo: number;
  testFrom: number;
  testTo: number;
  metrics: Record<string, number>;
}

export interface BacktestResult {
  kind: string;
  folds: BacktestFold[];
  metrics: Record<string, number>;
  /** 全部测试点的实际值与预测，便于画图或按条件再切分 */
  points: Array<{ actual: SeriesPoint; forecast: PointForecast }>;
}

export function backtest(series: readonly SeriesPoint[], model: Forecaster<unknown>, opts: BacktestOptions): BacktestResult {
  const pts = [...series].sort((a, b) => a.day - b.day || a.hour - b.hour);
  const first = pts[0]?.day ?? 0;
  const last = pts.at(-1)?.day ?? -1;
  const origins: number[] = [];
  for (let t = first + opts.initialDays - 1; t + opts.horizonDays <= last; t += opts.stepDays) origins.push(t);
  const use = opts.maxFolds ? origins.slice(-opts.maxFolds) : origins;
  const folds: BacktestFold[] = [];
  const all: BacktestResult['points'] = [];
  for (const t of use) {
    const train = pts.filter((p) => p.day <= t);
    const test = pts.filter((p) => p.day > t && p.day <= t + opts.horizonDays && (!opts.filter || opts.filter(p)));
    if (!train.length || !test.length) continue;
    const params = model.fit(train);
    const fc = model.predict(
      params,
      test.map(({ y: _y, ...f }) => f),
    );
    const pairs = test.map((a, i) => ({ actual: a, forecast: fc[i] as PointForecast }));
    all.push(...pairs);
    folds.push({ trainTo: t, testFrom: t + 1, testTo: t + opts.horizonDays, metrics: summarize(pairs) });
  }
  return { kind: model.kind, folds, metrics: summarize(all), points: all };
}

function summarize(pairs: BacktestResult['points']): Record<string, number> {
  const m = forecastMetrics(
    pairs.map((p) => p.actual.y),
    pairs.map((p) => p.forecast.mean),
    pairs.map((p) => p.forecast.low),
    pairs.map((p) => p.forecast.high),
  );
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v]));
}

/** 只用部分测试点重新计算指标（例如节假日 / 隐藏因素发生的日子），不需要重新回测 */
export function sliceMetrics(result: BacktestResult, keep: (p: SeriesPoint) => boolean): Record<string, number> {
  return summarize(result.points.filter((p) => keep(p.actual)));
}
