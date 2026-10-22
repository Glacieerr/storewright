import { rankReasons, type Reason } from './recommendation';

/**
 * 按小时的时间序列与基线预测器。
 *
 * 基线是 5b 正式模型必须胜过的对照：同时段上周值、近几周同时段平均、按星期季节性的指数平滑。
 * 每个预测器的参数都是可序列化的普通对象，存进模型仓库后可以原样恢复，不需要重新拟合。
 * 区间（默认 80%）由训练期内「只用当时已知数据」的滚动预测残差估计：
 * 残差按 √预测值 标准化（计数数据的方差大致与均值成正比），再乘以正态分位数。
 */

export interface SeriesPoint {
  /** 天序号（从 0 开始，连续） */
  day: number;
  /** 0 = 星期日 … 6 = 星期六 */
  dow: number;
  hour: number;
  y: number;
  /** 事先可以知道的外部特征（促销、节假日、天气预报）；基线模型不使用 */
  x?: Record<string, number>;
  /** 样本权重（例如仿真数据在真实数据积累后逐步降权）；默认 1，基线模型不使用 */
  w?: number;
}

export type FuturePoint = Omit<SeriesPoint, 'y'>;

export interface PointForecast {
  day: number;
  hour: number;
  mean: number;
  low: number;
  high: number;
  reasons: Reason[];
}

export interface Forecaster<P = unknown> {
  readonly kind: string;
  fit(history: readonly SeriesPoint[]): P;
  predict(params: P, future: readonly FuturePoint[]): PointForecast[];
}

/** 80% 区间的标准正态分位数 */
export const Z80 = 1.2816;

const key = (dow: number, hour: number) => `${dow}-${hour}`;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** 标准化残差的标准差；样本太少时返回保守的 1.5（约等于泊松噪声的 1.5 倍） */
export function residualScale(pairs: ReadonlyArray<readonly [actual: number, pred: number]>): number {
  if (pairs.length < 10) return 1.5;
  let s = 0;
  for (const [a, p] of pairs) s += ((a - p) / Math.sqrt(Math.max(p, 1))) ** 2;
  return Math.max(0.5, Math.sqrt(s / pairs.length));
}

export function interval(mean: number, scale: number, z = Z80): { low: number; high: number } {
  const half = z * scale * Math.sqrt(Math.max(mean, 1));
  return { low: round2(Math.max(0, mean - half)), high: round2(mean + half) };
}

function sorted(history: readonly SeriesPoint[]): SeriesPoint[] {
  return [...history].sort((a, b) => a.day - b.day || a.hour - b.hour);
}

// ---------------------------------------------------------------------------
// 1. 同时段上周值

export interface SeasonalNaiveParams {
  lastDay: number;
  values: Record<string, number>;
  scale: number;
}

export const seasonalNaive: Forecaster<SeasonalNaiveParams> = {
  kind: 'seasonal-naive',
  fit(history) {
    const pts = sorted(history);
    const byDayHour = new Map<string, number>();
    const values: Record<string, number> = {};
    const pairs: Array<[number, number]> = [];
    for (const p of pts) {
      const prev = byDayHour.get(`${p.day - 7}:${p.hour}`);
      if (prev !== undefined) pairs.push([p.y, prev]);
      byDayHour.set(`${p.day}:${p.hour}`, p.y);
      values[key(p.dow, p.hour)] = p.y;
    }
    return { lastDay: pts.at(-1)?.day ?? -1, values, scale: residualScale(pairs) };
  },
  predict(params, future) {
    return future.map((f) => {
      const v = params.values[key(f.dow, f.hour)] ?? 0;
      return { day: f.day, hour: f.hour, mean: v, ...interval(v, params.scale), reasons: [{ factor: 'SAME_HOUR_LAST_WEEK', value: v, weight: 1, params: { dow: f.dow } }] };
    });
  },
};

// ---------------------------------------------------------------------------
// 2. 近几周同时段平均

export interface HourOfWeekParams {
  weeks: number;
  means: Record<string, number>;
  counts: Record<string, number>;
  scale: number;
}

export function hourOfWeekMean(weeks = 4): Forecaster<HourOfWeekParams> {
  return {
    kind: `hour-of-week-mean-${weeks}`,
    fit(history) {
      const series = new Map<string, number[]>();
      const pairs: Array<[number, number]> = [];
      for (const p of sorted(history)) {
        const list = series.get(key(p.dow, p.hour)) ?? [];
        if (list.length >= 2) pairs.push([p.y, avg(list.slice(-weeks))]);
        list.push(p.y);
        series.set(key(p.dow, p.hour), list);
      }
      const means: Record<string, number> = {};
      const counts: Record<string, number> = {};
      for (const [k, list] of series) {
        const recent = list.slice(-weeks);
        means[k] = round2(avg(recent));
        counts[k] = recent.length;
      }
      return { weeks, means, counts, scale: residualScale(pairs) };
    },
    predict(params, future) {
      return future.map((f) => {
        const k = key(f.dow, f.hour);
        const v = params.means[k] ?? 0;
        return { day: f.day, hour: f.hour, mean: v, ...interval(v, params.scale), reasons: [{ factor: 'RECENT_WEEKS_MEAN', value: v, weight: 1, params: { weeks: params.counts[k] ?? 0, dow: f.dow } }] };
      });
    },
  };
}

function avg(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// ---------------------------------------------------------------------------
// 3. 按星期季节性的指数平滑（日总量）× 各星期的小时占比

export interface SeasonalEsParams {
  lastDay: number;
  level: number;
  trend: number;
  /** 按星期（0–6）的季节系数，平均为 1 */
  season: number[];
  /** 星期 → 小时 → 占全天的比例 */
  shares: Record<string, number>;
  alpha: number;
  beta: number;
  gamma: number;
  phi: number;
  scale: number;
  /** 营业小时数（解释「这个时段比平均一小时忙多少」时用） */
  openHours: number;
}

const ALPHAS = [0.05, 0.1, 0.2, 0.3, 0.5];
const BETAS = [0, 0.02, 0.05, 0.1];
const GAMMAS = [0.05, 0.1, 0.2, 0.3];
const PHI = 0.98;
const WARMUP = 14;

interface EsRun {
  level: number;
  trend: number;
  season: number[];
  sse: number;
  /** 每天的一步预测（日总量），下标为天序号 */
  oneStep: Map<number, number>;
}

function runEs(days: ReadonlyArray<{ day: number; dow: number; total: number }>, alpha: number, beta: number, gamma: number): EsRun {
  const init = days.slice(0, Math.min(days.length, WARMUP));
  const level0 = avg(init.map((d) => d.total)) || 1;
  const season = Array.from({ length: 7 }, (_, w) => {
    const xs = init.filter((d) => d.dow === w).map((d) => d.total);
    return xs.length ? avg(xs) / level0 : 1;
  });
  normalize(season);
  let level = level0;
  let trend = 0;
  let sse = 0;
  const oneStep = new Map<number, number>();
  for (const d of days) {
    const s = season[d.dow] as number;
    const f = Math.max(0, (level + PHI * trend) * s);
    oneStep.set(d.day, f);
    if (d.day - (days[0]?.day ?? 0) >= WARMUP) sse += (d.total - f) ** 2;
    const newLevel = alpha * (d.total / Math.max(s, 1e-6)) + (1 - alpha) * (level + PHI * trend);
    trend = beta * (newLevel - level) + (1 - beta) * PHI * trend;
    level = newLevel;
    season[d.dow] = gamma * (d.total / Math.max(level, 1e-6)) + (1 - gamma) * s;
  }
  normalize(season);
  return { level, trend, season, sse, oneStep };
}

function normalize(season: number[]): void {
  const m = avg(season) || 1;
  for (let i = 0; i < season.length; i++) season[i] = (season[i] as number) / m;
}

export const seasonalEs: Forecaster<SeasonalEsParams> = {
  kind: 'seasonal-es',
  fit(history) {
    const pts = sorted(history);
    const totals = new Map<number, { day: number; dow: number; total: number }>();
    const hours = new Set<number>();
    for (const p of pts) {
      const t = totals.get(p.day) ?? { day: p.day, dow: p.dow, total: 0 };
      t.total += p.y;
      totals.set(p.day, t);
      hours.add(p.hour);
    }
    const days = [...totals.values()].sort((a, b) => a.day - b.day);
    let best: (EsRun & { alpha: number; beta: number; gamma: number }) | undefined;
    for (const a of ALPHAS)
      for (const b of BETAS)
        for (const g of GAMMAS) {
          const r = runEs(days, a, b, g);
          if (!best || r.sse < best.sse) best = { ...r, alpha: a, beta: b, gamma: g };
        }
    if (!best) throw new Error('seasonal-es needs history');
    // 小时占比：每个星期最近 8 次的合计
    const shares: Record<string, number> = {};
    for (let w = 0; w < 7; w++) {
      const recent = days.filter((d) => d.dow === w).slice(-8);
      const keep = new Set(recent.map((d) => d.day));
      const sum = recent.reduce((a, d) => a + d.total, 0);
      for (const h of hours) {
        const hs = pts.filter((p) => p.hour === h && keep.has(p.day)).reduce((a, p) => a + p.y, 0);
        shares[key(w, h)] = sum > 0 ? hs / sum : 1 / hours.size;
      }
    }
    // 残差：预热之后每天的一步预测 × 当时的小时占比
    const pairs: Array<[number, number]> = [];
    const first = days[0]?.day ?? 0;
    for (const p of pts) {
      if (p.day - first < WARMUP) continue;
      const f = best.oneStep.get(p.day) ?? 0;
      pairs.push([p.y, f * (shares[key(p.dow, p.hour)] ?? 0)]);
    }
    return {
      lastDay: days.at(-1)?.day ?? -1,
      level: round2(best.level),
      trend: Math.round(best.trend * 1000) / 1000,
      season: best.season.map((s) => Math.round(s * 1000) / 1000),
      shares: Object.fromEntries(Object.entries(shares).map(([k, v]) => [k, Math.round(v * 10000) / 10000])),
      alpha: best.alpha,
      beta: best.beta,
      gamma: best.gamma,
      phi: PHI,
      scale: residualScale(pairs),
      openHours: hours.size,
    };
  },
  predict(params, future) {
    return future.map((f) => {
      const h = Math.max(1, f.day - params.lastDay);
      let damp = 0;
      for (let i = 1; i <= h; i++) damp += params.phi ** i;
      const base = Math.max(0, params.level + damp * params.trend);
      const s = params.season[f.dow] ?? 1;
      const share = params.shares[key(f.dow, f.hour)] ?? 0;
      const mean = round2(base * s * share);
      const hourFactor = share * params.openHours;
      const reasons = rankReasons(
        [
          { factor: 'WEEKDAY_FACTOR', value: s, effect: { kind: 'MULTIPLY', amount: s }, weight: 0, params: { dow: f.dow } },
          { factor: 'HOUR_SHARE', value: round2(share * 100), effect: { kind: 'MULTIPLY', amount: hourFactor || 1 }, weight: 0, params: { hour: f.hour } },
          { factor: 'TREND', value: round2(damp * params.trend), effect: { kind: 'MULTIPLY', amount: params.level > 0 ? base / params.level : 1 }, weight: 0 },
          { factor: 'BASE_LEVEL', value: params.level, weight: 0.0001 },
        ],
        4,
      );
      return { day: f.day, hour: f.hour, mean, ...interval(mean, params.scale), reasons };
    });
  },
};

// ---------------------------------------------------------------------------

/** 所有基线预测器（按算法名） */
export const BASELINES: Record<string, Forecaster<unknown>> = {
  [seasonalNaive.kind]: seasonalNaive,
  [hourOfWeekMean(4).kind]: hourOfWeekMean(4),
  [seasonalEs.kind]: seasonalEs,
};

/** 合并时间段时数值应当相加的因素（例如各小时占全天的比例） */
const SUM_VALUES = new Set(['HOUR_SHARE', 'SAME_HOUR_LAST_WEEK', 'RECENT_WEEKS_MEAN']);

/**
 * 把几个小时的点预测合并成一个时间段的预测：均值相加，方差相加（假设各小时独立）。
 * 同名理由合并：权重和倍数按各小时的均值加权，数值按因素相加或加权平均；各小时参数不同的参数项去掉。
 */
export function aggregateForecast(points: readonly PointForecast[], z = Z80): { mean: number; low: number; high: number; reasons: Reason[] } {
  let mean = 0;
  let variance = 0;
  const merged = new Map<string, { r: Reason; w: number; logSum: number; valSum: number; valWeighted: number; n: number; params?: Record<string, string | number> }>();
  for (const p of points) {
    mean += p.mean;
    const sd = (p.high - p.low) / (2 * z);
    variance += sd * sd;
    for (const r of p.reasons) {
      const wt = Math.max(p.mean, 1e-6);
      let m = merged.get(r.factor);
      if (!m) {
        m = { r, w: 0, logSum: 0, valSum: 0, valWeighted: 0, n: 0, ...(r.params ? { params: { ...r.params } } : {}) };
        merged.set(r.factor, m);
      } else if (m.params) {
        for (const k of Object.keys(m.params)) if (r.params?.[k] !== m.params[k]) delete m.params[k];
      }
      m.w += r.weight * wt;
      if (r.effect?.kind === 'MULTIPLY') m.logSum += Math.log(Math.max(r.effect.amount, 1e-6)) * wt;
      m.valSum += r.value ?? 0;
      m.valWeighted += (r.value ?? 0) * wt;
      m.n += wt;
    }
  }
  const sd = Math.sqrt(variance);
  const reasons = rankReasons(
    [...merged.values()].map(({ r, w, logSum, valSum, valWeighted, n, params }) => {
      const out: Reason = { factor: r.factor, value: round2(SUM_VALUES.has(r.factor) ? valSum : valWeighted / n), weight: w / Math.max(mean, 1e-6) };
      if (r.effect?.kind === 'MULTIPLY') out.effect = { kind: 'MULTIPLY', amount: Math.round(Math.exp(logSum / n) * 1000) / 1000 };
      else if (r.effect) out.effect = r.effect;
      if (params && Object.keys(params).length) out.params = params;
      return out;
    }),
    4,
  );
  return { mean: round2(mean), low: round2(Math.max(0, mean - z * sd)), high: round2(mean + z * sd), reasons };
}
