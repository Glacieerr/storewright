import { BASELINES, interval, residualScale, type Forecaster, type FuturePoint } from './forecast';
import { dot, fitGlm } from './glm';
import { rankReasons, type Reason } from './recommendation';

/**
 * 订单量预测（Phase 5b）：「局部水平 × 已知因素」的泊松回归。
 *
 *   日订单量 ~ 泊松( L(前一天) × exp(星期效应 + 节假日 + 节前 + 节后 + 促销 + 风暴预警 + 天气预报) )
 *   每小时 = 日订单量 × 该星期最近几周的小时占比
 *
 * - L 是去掉已知因素之后的需求水平，用指数平滑逐天更新：趋势、结构性变化这类模型「看不到原因」的变化
 *   会通过 L 慢慢反映出来；
 * - 已知因素用 L2 正则的泊松回归估计。具体节日（感恩节、圣诞节……）在通用节假日效应之外各有一项，
 *   历史里只出现过一两次的节日会被正则拉向通用效应；
 * - 每个因素的倍数 exp(β·x) 就是理由，界面直接显示「明天有风暴预警：今天 +24%」。
 */

const DAY_FEATURES = ['holiday', 'holidayEve', 'dayAfterHoliday', 'promoShare', 'stormWarning', 'stormWarningTomorrow', 'rainHeavy', 'hot', 'cold'] as const;

/** 由事先可以知道的原始特征得到模型特征 */
export function deriveDayFeatures(x: Record<string, number> | undefined): Record<string, number> {
  const raw = x ?? {};
  const out: Record<string, number> = {
    holiday: raw.holiday ?? 0,
    holidayEve: raw.holidayEve ?? 0,
    dayAfterHoliday: raw.dayAfterHoliday ?? 0,
    promoShare: raw.promoShare ?? 0,
    stormWarning: raw.stormWarning ?? 0,
    stormWarningTomorrow: raw.stormWarningTomorrow ?? 0,
    rainHeavy: (raw.forecastRainMm ?? 0) >= 10 ? 1 : 0,
    hot: (raw.forecastTempC ?? 15) >= 30 ? 1 : 0,
    cold: (raw.forecastTempC ?? 15) <= -5 ? 1 : 0,
  };
  for (const [k, v] of Object.entries(raw)) if ((k.startsWith('holiday_') || k.startsWith('eve_')) && v) out[k] = v;
  return out;
}

export interface FeatureGlmParams {
  /** 星期之外的特征列名 */
  features: string[];
  /** [星期一…星期六（星期日为基准）, ...features] */
  beta: number[];
  alpha: number;
  lambda: number;
  /** 最后一天之后的水平（「星期日、无特殊因素」口径） */
  level: number;
  /** 训练期内水平的平均值，用来说明「近期比平时高 / 低多少」 */
  levelRef: number;
  lastDay: number;
  shares: Record<string, number>;
  scale: number;
  openHours: number;
}

const ALPHAS = [0.03, 0.06, 0.1, 0.2];
const WARMUP = 14;
const SCORE_FROM = 28;

interface DayRow {
  day: number;
  dow: number;
  total: number;
  x: Record<string, number>;
  special: boolean;
  w: number;
}

const key = (dow: number, hour: number) => `${dow}-${hour}`;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function designRow(dow: number, x: Record<string, number>, features: readonly string[]): number[] {
  const row = new Array<number>(6 + features.length).fill(0);
  if (dow > 0) row[dow - 1] = 1;
  features.forEach((f, j) => (row[6 + j] = x[f] ?? 0));
  return row;
}

/** 逐天的水平：before[i] 是第 i 天开始前的水平（只用之前的数据） */
function levels(rows: readonly DayRow[], X: readonly number[][], beta: readonly number[], alpha: number): { before: number[]; last: number } {
  const init = rows.slice(0, Math.min(rows.length, WARMUP));
  let L = init.length ? init.reduce((a, r, i) => a + r.total / Math.exp(dot(X[i] as number[], beta)), 0) / init.length : 1;
  L = Math.max(L, 1e-3);
  const before: number[] = [];
  rows.forEach((r, i) => {
    before.push(L);
    const f = r.total / Math.exp(dot(X[i] as number[], beta));
    L = Math.max(1e-3, alpha * f + (1 - alpha) * L);
  });
  return { before, last: L };
}

export function featureGlm(lambda = 20): Forecaster<FeatureGlmParams> {
  return {
    kind: 'feature-glm',
    fit(history) {
      const pts = [...history].sort((a, b) => a.day - b.day || a.hour - b.hour);
      const byDay = new Map<number, DayRow>();
      const hours = new Set<number>();
      for (const p of pts) {
        let r = byDay.get(p.day);
        if (!r) {
          const x = deriveDayFeatures(p.x);
          r = { day: p.day, dow: p.dow, total: 0, x, special: !!(x.holiday || x.holidayEve || x.dayAfterHoliday), w: p.w ?? 1 };
          byDay.set(p.day, r);
        }
        r.total += p.y;
        hours.add(p.hour);
      }
      const rows = [...byDay.values()].sort((a, b) => a.day - b.day);
      if (!rows.length) throw new Error('feature-glm needs history');
      // 特征列：固定的日特征 + 训练期出现过的具体节日；全为 0 的列去掉
      const extra = new Set<string>();
      for (const r of rows) for (const k of Object.keys(r.x)) if (k.startsWith('holiday_') || k.startsWith('eve_')) extra.add(k);
      const features = [...DAY_FEATURES, ...[...extra].sort()].filter((f) => rows.some((r) => (r.x[f] ?? 0) !== 0));
      const X = rows.map((r) => designRow(r.dow, r.x, features));
      const y = rows.map((r) => r.total);

      let best: { alpha: number; beta: number[]; sse: number; lv: { before: number[]; last: number } } | undefined;
      for (const alpha of ALPHAS) {
        let beta = new Array<number>(6 + features.length).fill(0);
        let lv = levels(rows, X, beta, alpha);
        for (let it = 0; it < 3; it++) {
          beta = fitGlm(X, y, { family: 'poisson', offset: lv.before.map(Math.log), weights: rows.map((r) => r.w), lambda, start: beta }).beta;
          lv = levels(rows, X, beta, alpha);
        }
        let sse = 0;
        rows.forEach((r, i) => {
          if (i >= SCORE_FROM) sse += (r.total - (lv.before[i] as number) * Math.exp(dot(X[i] as number[], beta))) ** 2;
        });
        if (!best || sse < best.sse) best = { alpha, beta, sse, lv };
      }
      const fit = best as NonNullable<typeof best>;

      // 小时占比：每个星期最近 8 个普通日子（不含节假日前后）
      const shares: Record<string, number> = {};
      for (let w = 0; w < 7; w++) {
        const recent = rows.filter((r) => r.dow === w && !r.special).slice(-8);
        const use = recent.length ? recent : rows.filter((r) => r.dow === w).slice(-8);
        const keep = new Set(use.map((r) => r.day));
        const sum = use.reduce((a, r) => a + r.total, 0);
        for (const h of hours) {
          const hs = pts.filter((p) => p.hour === h && keep.has(p.day)).reduce((a, p) => a + p.y, 0);
          shares[key(w, h)] = sum > 0 ? r4(hs / sum) : 1 / hours.size;
        }
      }
      // 残差：只用当时水平的一步预测 × 小时占比
      const idx = new Map(rows.map((r, i) => [r.day, i]));
      const pairs: Array<[number, number]> = [];
      for (const p of pts) {
        const i = idx.get(p.day) as number;
        if (i < SCORE_FROM) continue;
        const daily = (fit.lv.before[i] as number) * Math.exp(dot(X[i] as number[], fit.beta));
        pairs.push([p.y, daily * (shares[key(p.dow, p.hour)] ?? 0)]);
      }
      const levelRef = fit.lv.before.slice(Math.min(WARMUP, fit.lv.before.length - 1)).reduce((a, b) => a + b, 0) / Math.max(1, fit.lv.before.length - Math.min(WARMUP, fit.lv.before.length - 1));
      return {
        features,
        beta: fit.beta.map(r4),
        alpha: fit.alpha,
        lambda,
        level: r2(fit.lv.last),
        levelRef: r2(levelRef),
        lastDay: rows.at(-1)?.day ?? -1,
        shares,
        scale: residualScale(pairs),
        openHours: hours.size,
      };
    },
    predict(params, future) {
      return future.map((f) => predictPoint(params, f));
    },
  };
}

function predictPoint(params: FeatureGlmParams, f: FuturePoint) {
  const x = deriveDayFeatures(f.x);
  const row = designRow(f.dow, x, params.features);
  const daily = params.level * Math.exp(dot(row, params.beta));
  const share = params.shares[key(f.dow, f.hour)] ?? 0;
  const mean = r2(daily * share);
  return { day: f.day, hour: f.hour, mean, ...interval(mean, params.scale), reasons: explain(params, f, x) };
}

function coef(params: FeatureGlmParams, name: string): number {
  const j = params.features.indexOf(name);
  return j >= 0 ? (params.beta[6 + j] as number) : 0;
}

/** 每个因素的倍数 → 理由 */
function explain(params: FeatureGlmParams, f: FuturePoint, x: Record<string, number>): Reason[] {
  const dowBeta = [0, ...params.beta.slice(0, 6)];
  const meanDow = dowBeta.reduce((a, b) => a + b, 0) / 7;
  const out: Reason[] = [];
  const mult = (factor: string, logEffect: number, value?: number, p?: Record<string, string | number>) => {
    if (Math.abs(logEffect) < 0.005) return;
    const amount = Math.round(Math.exp(logEffect) * 1000) / 1000;
    out.push({ factor, ...(value !== undefined ? { value } : {}), effect: { kind: 'MULTIPLY', amount }, weight: 0, ...(p ? { params: p } : {}) });
  };
  mult('WEEKDAY_FACTOR', (dowBeta[f.dow] as number) - meanDow, Math.round(Math.exp((dowBeta[f.dow] as number) - meanDow) * 1000) / 1000, { dow: f.dow });
  const code = (prefix: string) => Object.keys(x).find((k) => k.startsWith(prefix))?.slice(prefix.length);
  if (x.holiday) {
    const c = code('holiday_');
    mult('HOLIDAY', coef(params, 'holiday') + (c ? coef(params, `holiday_${c}`) : 0), undefined, c ? { code: c } : undefined);
  }
  if (x.holidayEve) {
    const c = code('eve_');
    mult('HOLIDAY_EVE', coef(params, 'holidayEve') + (c ? coef(params, `eve_${c}`) : 0), undefined, c ? { code: c } : undefined);
  }
  if (x.dayAfterHoliday) mult('DAY_AFTER_HOLIDAY', coef(params, 'dayAfterHoliday'));
  if (x.promoShare) mult('PROMO', coef(params, 'promoShare') * (x.promoShare as number), r2((x.promoShare as number) * 100));
  if (x.stormWarningTomorrow) mult('STORM_WARNING_TOMORROW', coef(params, 'stormWarningTomorrow'));
  if (x.stormWarning) mult('STORM_WARNING', coef(params, 'stormWarning'));
  if (x.rainHeavy) mult('HEAVY_RAIN_FORECAST', coef(params, 'rainHeavy'), f.x?.forecastRainMm);
  if (x.hot) mult('HEAT_FORECAST', coef(params, 'hot'), f.x?.forecastTempC);
  if (x.cold) mult('COLD_FORECAST', coef(params, 'cold'), f.x?.forecastTempC);
  if (params.levelRef > 0) mult('RECENT_LEVEL', Math.log(params.level / params.levelRef));
  const share = params.shares[key(f.dow, f.hour)] ?? 0;
  out.push({ factor: 'HOUR_SHARE', value: r2(share * 100), effect: { kind: 'MULTIPLY', amount: Math.round(share * params.openHours * 1000) / 1000 || 1 }, weight: 0, params: { hour: f.hour } });
  const typical = params.levelRef * (dowBeta.reduce((a, b) => a + Math.exp(b), 0) / 7);
  out.push({ factor: 'BASE_LEVEL', value: Math.round(typical), weight: 0.0001 });
  return rankReasons(out, 6);
}

/** 全部预测器：基线 + 正式模型 */
export const FORECASTERS: Record<string, Forecaster<unknown>> = {
  ...BASELINES,
  'feature-glm': featureGlm(),
};

