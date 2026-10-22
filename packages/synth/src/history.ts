import { createRng, hashString, type Rng } from '@storewright/domain';
import type { StoreModel } from '@storewright/store-config';
import { CATEGORY_PROFILES, fallbackProfile } from './archetypes';
import type { DemandScenario } from './orders';

/**
 * 合成需求历史（决策记录 0010 第 2 节原则 3：仿真就是评测场）。
 *
 * 按天生成线上订单的数量、按取货时段开始小时的分布、自取 / 配送、按类别的行数。
 * 影响需求的因素分两类：
 * - 模型可以看到的（observed）：星期、节假日日历、每周促销的类别、带误差的天气预报和风暴预警；
 * - 模型看不到的（hidden）：真实天气、促销的实际提升幅度、本地活动、增长趋势、一次结构性变化、日间随机波动。
 * 每一天都记录全部真实因素，评估时可以按「隐藏因素发生的日子」单独计算模型误差。
 *
 * 只用于 AI 模块的训练与评测，Phase 1 的仿真不使用，结果不受影响。
 * 每类因素使用独立的随机数流：关闭某一类因素不会改变其他因素的抽样结果，便于做消融。
 */

export interface HistoryFactors {
  weekday: boolean;
  holidays: boolean;
  weather: boolean;
  promos: boolean;
  /** 年增长率，例如 0.08 */
  trendPerYear: number;
  /** 本地活动：每天发生的概率；发生时一半概率需求上升（up 区间的倍数），一半下降 */
  localEvents: { ratePerDay: number; up: [number, number]; down: [number, number] };
  /** 结构性变化：从第 day 天起需求乘以 multiplier（例如附近新开了一家竞争门店）；null 表示没有 */
  regimeShift: { day: number; multiplier: number } | null;
  /** 日间随机波动的变异系数（对数正态） */
  dayNoiseCv: number;
  /** 季节性（隐藏因素，行业需求形态里振幅为 0 时没有影响；超市默认没有） */
  season: boolean;
}

export const DEFAULT_HISTORY_FACTORS: HistoryFactors = {
  weekday: true,
  holidays: true,
  weather: true,
  promos: true,
  trendPerYear: 0.08,
  localEvents: { ratePerDay: 0.04, up: [1.12, 1.35], down: [0.75, 0.9] },
  regimeShift: null,
  dayNoiseCv: 0.04,
  season: true,
};

/** 关闭全部隐藏因素：只剩模型可以看到的因素和泊松噪声（单元测试、上限对照用） */
export const OBSERVABLE_ONLY: Partial<HistoryFactors> = {
  trendPerYear: 0,
  localEvents: { ratePerDay: 0, up: [1, 1], down: [1, 1] },
  regimeShift: null,
  dayNoiseCv: 0,
  season: false,
};

export interface HistoryOptions {
  seed: number;
  days: number;
  /** 第一天的日期（YYYY-MM-DD），决定星期、季节和节假日 */
  startDate: string;
  /** 基准需求：日均订单、小时分布、自取比例、平均行数 */
  scenario: DemandScenario;
  factors?: Partial<HistoryFactors>;
  /** 类别 → 需求占比；不传时按门店配置的类别和默认需求占比计算 */
  categoryShares?: Record<string, number>;
  /** 行业需求形态；不传时按门店配置的行业 */
  profile?: DemandProfile;
}

export type HolidayCode = 'NEW_YEAR' | 'MEMORIAL_DAY' | 'INDEPENDENCE_DAY' | 'LABOR_DAY' | 'THANKSGIVING' | 'CHRISTMAS';

export interface HistoryDay {
  day: number;
  date: string;
  /** 0 = 星期日 … 6 = 星期六 */
  dow: number;
  observed: {
    holiday: HolidayCode | null;
    holidayEve: boolean;
    dayAfterHoliday: boolean;
    promoCategories: string[];
    forecastTempC: number;
    forecastRainMm: number;
    stormWarning: boolean;
    /** 明天的风暴预警（今天就能知道，顾客会提前囤货） */
    stormWarningTomorrow: boolean;
  };
  hidden: {
    tempC: number;
    rainMm: number;
    storm: boolean;
    /** 各因素对当天订单量的真实倍数 */
    weekday: number;
    holiday: number;
    weather: number;
    promo: number;
    promoUplift: Record<string, number>;
    trend: number;
    localEvent: number;
    regime: number;
    noise: number;
    season: number;
  };
  /** 当天订单量的期望值（全部因素相乘），以及按小时的期望 */
  expected: { orders: number; hourly: number[] };
  actual: { orders: number; hourly: number[]; pickup: number; delivery: number; lines: number; linesByCategory: Record<string, number> };
  /** 事先可以知道的特征（给模型用，只包含 observed 部分） */
  x: Record<string, number>;
}

export interface DemandHistory {
  days: HistoryDay[];
  /** 有订单的小时（按取货时段开始时间） */
  hours: number[];
  categories: string[];
  factors: HistoryFactors;
}

/**
 * 行业需求形态（决策记录 0011）：星期、节假日、天气对订单量的真实影响，季节性，以及周末的小时分布调整。
 * 模型只看到日历和预报，这些倍数本身是隐藏的，需要从本店数据中学出来。
 */
export interface DemandProfile {
  /** 星期日 … 星期六（均值归一） */
  weekday: number[];
  holidays: Record<HolidayCode, { day: number; eve: number }>;
  dayAfterHoliday: number;
  weather: { heavyRain: number; heat: number; cold: number; storm: number; warningTomorrow: number; rainPickupDrop: number };
  /** 季节性：1 + amplitude × sin(2π(第几天 − peakDoy + 91.25) / 365)，峰值在 peakDoy */
  season: { amplitude: number; peakDoy: number };
  /** 周末某小时的权重倍数 */
  weekendHour(h: number): number;
}

const GROCERY_PROFILE: DemandProfile = {
  weekday: normalizeMean([1.05, 0.92, 0.88, 0.93, 0.98, 1.06, 1.18]),
  holidays: {
    NEW_YEAR: { day: 0.6, eve: 1.3 },
    MEMORIAL_DAY: { day: 0.85, eve: 1.15 },
    INDEPENDENCE_DAY: { day: 0.7, eve: 1.3 },
    LABOR_DAY: { day: 0.85, eve: 1.15 },
    THANKSGIVING: { day: 0.35, eve: 1.7 },
    CHRISTMAS: { day: 0.25, eve: 1.5 },
  },
  dayAfterHoliday: 0.92,
  weather: { heavyRain: 1.08, heat: 1.06, cold: 1.07, storm: 0.8, warningTomorrow: 1.25, rainPickupDrop: 0.05 },
  season: { amplitude: 0, peakDoy: 0 },
  // 周末中午更集中，晚间略少
  weekendHour: (h) => (h >= 10 && h <= 14 ? 1.15 : h >= 17 ? 0.9 : 1),
};

/**
 * 家居建材：周六最忙、周日次之（自己动手的顾客），工作日靠施工队；
 * 春季到初夏是旺季；大雨推迟户外工程，风暴预警前一天抢购板材和发电机；
 * 三个「长周末」节日是促销旺日，感恩节和圣诞节几乎没有生意；周末早上没有施工队、上午自己动手的顾客集中。
 */
const HARDWARE_PROFILE: DemandProfile = {
  weekday: normalizeMean([1.15, 0.86, 0.84, 0.86, 0.9, 1.0, 1.45]),
  holidays: {
    NEW_YEAR: { day: 0.45, eve: 0.85 },
    MEMORIAL_DAY: { day: 1.35, eve: 1.15 },
    INDEPENDENCE_DAY: { day: 0.75, eve: 1.1 },
    LABOR_DAY: { day: 1.3, eve: 1.15 },
    THANKSGIVING: { day: 0.2, eve: 0.9 },
    CHRISTMAS: { day: 0.1, eve: 0.7 },
  },
  dayAfterHoliday: 1.0,
  weather: { heavyRain: 0.88, heat: 1.05, cold: 1.1, storm: 0.7, warningTomorrow: 1.45, rainPickupDrop: 0 },
  season: { amplitude: 0.2, peakDoy: 125 },
  weekendHour: (h) => (h <= 7 ? 0.5 : h >= 8 && h <= 12 ? 1.25 : 1),
};

export const DEMAND_PROFILES: Record<'GROCERY' | 'HARDWARE', DemandProfile> = { GROCERY: GROCERY_PROFILE, HARDWARE: HARDWARE_PROFILE };

/** 门店的需求形态（看门店配置的行业，旧配置为超市） */
export function demandProfileFor(model: StoreModel): DemandProfile {
  return DEMAND_PROFILES[model.config.industry ?? 'GROCERY'];
}

function normalizeMean(xs: number[]): number[] {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.map((x) => x / m);
}

const DAY_MS = 86_400_000;

function parseDate(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`bad date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 某月第 n 个星期 w（n = −1 表示最后一个） */
function nthWeekday(year: number, month: number, w: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((w - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDate = new Date(Date.UTC(year, month + 1, 0));
  return lastDate.getUTCDate() - ((lastDate.getUTCDay() - w + 7) % 7);
}

/** 节假日日历（公开的固定规则） */
export function holidayOn(ms: number): HolidayCode | null {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  if (mo === 0 && day === 1) return 'NEW_YEAR';
  if (mo === 4 && day === nthWeekday(y, 4, 1, -1)) return 'MEMORIAL_DAY';
  if (mo === 6 && day === 4) return 'INDEPENDENCE_DAY';
  if (mo === 8 && day === nthWeekday(y, 8, 1, 1)) return 'LABOR_DAY';
  if (mo === 10 && day === nthWeekday(y, 10, 4, 4)) return 'THANKSGIVING';
  if (mo === 11 && day === 25) return 'CHRISTMAS';
  return null;
}

/** 按门店配置的类别和默认需求占比（只算杂货类） */
export function defaultCategoryShares(model: StoreModel): Record<string, number> {
  const cats = model.config.catalog.categories.filter((c) => c.fulfillmentType === 'GROCERY' && model.runIdsForCategory(c.id).length > 0);
  const raw = cats.map((c) => (CATEGORY_PROFILES[c.id] ?? fallbackProfile(c.tempZone)).demandShare);
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(cats.map((c, i) => [c.id, (raw[i] as number) / total]));
}

/** 有订单的小时：开门后 1 小时到关门前 1 小时之间、小时分布权重大于 0 的小时 */
export function demandHours(model: StoreModel, scenario: DemandScenario): number[] {
  const from = Math.ceil(model.config.hours.openMin / 60) + 1;
  const to = Math.floor(model.config.hours.closeMin / 60) - 1;
  const out: number[] = [];
  for (let h = from; h < to; h++) if ((scenario.hourlyProfile[h] ?? 0) > 0) out.push(h);
  return out;
}

const stream = (seed: number, name: string): Rng => createRng(hashString(`${seed}:${name}`));

export function generateDemandHistory(model: StoreModel, opts: HistoryOptions): DemandHistory {
  const f: HistoryFactors = { ...DEFAULT_HISTORY_FACTORS, ...opts.factors };
  const P = opts.profile ?? demandProfileFor(model);
  const shares = opts.categoryShares ?? defaultCategoryShares(model);
  const categories = Object.keys(shares).sort();
  const hours = demandHours(model, opts.scenario);
  const start = parseDate(opts.startDate);
  const n = opts.days;

  // 1. 天气（先生成全部天，才能知道「明天」的风暴预警）
  const wx = stream(opts.seed, 'weather');
  const weather: Array<{ tempC: number; rainMm: number; storm: boolean; fTemp: number; fRain: number; warning: boolean }> = [];
  let anomaly = 0;
  for (let d = 0; d < n; d++) {
    const date = new Date(start + d * DAY_MS);
    const doy = Math.floor((start + d * DAY_MS - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS);
    anomaly = 0.7 * anomaly + wx.normal(0, 2.5);
    const tempC = 13 + 12 * Math.sin((2 * Math.PI * (doy - 105)) / 365) + anomaly;
    const rainMm = wx.chance(0.3) ? wx.exponential(1 / 7) : 0;
    const month = date.getUTCMonth();
    const storm = wx.chance(month >= 5 && month <= 9 ? 0.02 : 0.008);
    const fTemp = tempC + wx.normal(0, 1.8);
    const fRain = rainMm > 0 ? rainMm * Math.exp(wx.normal(0, 0.5)) : wx.chance(0.1) ? wx.exponential(1 / 4) : 0;
    const warning = storm ? wx.chance(0.85) : wx.chance(0.004);
    weather.push({ tempC: r1(tempC), rainMm: r1(rainMm), storm, fTemp: r1(fTemp), fRain: r1(fRain), warning });
  }

  // 2. 每周促销：每周一换两个类别，实际提升幅度模型看不到
  const pr = stream(opts.seed, 'promos');
  const weekPromos = new Map<number, Record<string, number>>();
  const firstMonday = (8 - new Date(start).getUTCDay()) % 7;
  const promosFor = (d: number): Record<string, number> => {
    if (!f.promos || !categories.length) return {};
    const week = Math.floor((d - firstMonday) / 7);
    let p = weekPromos.get(week);
    if (!p) {
      p = {};
      const pool = [...categories];
      for (let k = 0; k < Math.min(2, pool.length); k++) {
        const i = pr.weightedIndex(pool.map((c) => shares[c] ?? 0));
        const c = pool.splice(i, 1)[0] as string;
        p[c] = r3(pr.uniform(1.25, 1.7));
      }
      weekPromos.set(week, p);
    }
    return p;
  };

  const ev = stream(opts.seed, 'events');
  const noise = stream(opts.seed, 'noise');
  const counts = stream(opts.seed, 'counts');
  const sigma = Math.sqrt(Math.log(1 + f.dayNoiseCv ** 2));
  const base = opts.scenario.ordersPerDay;

  const days: HistoryDay[] = [];
  for (let d = 0; d < n; d++) {
    const ms = start + d * DAY_MS;
    const dow = new Date(ms).getUTCDay();
    const w = weather[d] as (typeof weather)[number];
    const tomorrowWarning = weather[d + 1]?.warning ?? false;

    const weekdayMult = f.weekday ? (P.weekday[dow] as number) : 1;
    const holiday = f.holidays ? holidayOn(ms) : null;
    const eveOf = f.holidays ? holidayOn(ms + DAY_MS) : null;
    const after = f.holidays ? holidayOn(ms - DAY_MS) !== null : false;
    const holidayMult = (holiday ? P.holidays[holiday].day : 1) * (eveOf ? P.holidays[eveOf].eve : 1) * (after ? P.dayAfterHoliday : 1);

    let weatherMult = 1;
    if (f.weather) {
      if (w.rainMm >= 10) weatherMult *= P.weather.heavyRain;
      if (w.tempC >= 30) weatherMult *= P.weather.heat;
      if (w.tempC <= -5) weatherMult *= P.weather.cold;
      if (w.storm) weatherMult *= P.weather.storm;
      // 顾客按预警（包括误报）提前囤货
      if (tomorrowWarning) weatherMult *= P.weather.warningTomorrow;
    }

    const promo = promosFor(d);
    let promoMult = 1;
    for (const [c, u] of Object.entries(promo)) promoMult += (shares[c] ?? 0) * (u - 1) * 0.5;

    const trend = (1 + f.trendPerYear) ** (d / 365);
    // 本地活动的随机数每天都抽，保证关闭其他因素时抽样结果不变
    const happen = ev.next();
    const up = ev.next() < 0.5;
    const mag = ev.next();
    const localEvent = happen < f.localEvents.ratePerDay ? (up ? lerp(f.localEvents.up, mag) : lerp(f.localEvents.down, mag)) : 1;
    const regime = f.regimeShift && d >= f.regimeShift.day ? f.regimeShift.multiplier : 1;
    const z = noise.normal(0, 1);
    const dayNoise = sigma > 0 ? Math.exp(z * sigma - (sigma * sigma) / 2) : 1;

    const doy = Math.floor((ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / DAY_MS);
    const seasonMult = f.season && P.season.amplitude ? 1 + P.season.amplitude * Math.sin((2 * Math.PI * (doy - P.season.peakDoy + 91.25)) / 365) : 1;
    const expectedOrders = base * weekdayMult * holidayMult * weatherMult * promoMult * trend * localEvent * regime * dayNoise * seasonMult;

    // 小时分布：周末按行业调整（超市中午更集中、晚间略少）
    const weekend = dow === 0 || dow === 6;
    const weights = new Array<number>(24).fill(0);
    let wsum = 0;
    for (const h of hours) {
      let wh = opts.scenario.hourlyProfile[h] ?? 0;
      if (weekend) wh *= P.weekendHour(h);
      weights[h] = wh;
      wsum += wh;
    }
    const expectedHourly = weights.map((wh) => (wsum > 0 ? (expectedOrders * wh) / wsum : 0));
    const hourly = expectedHourly.map((lam) => (lam > 0 ? counts.poisson(lam) : 0));
    const orders = hourly.reduce((a, b) => a + b, 0);
    const pickupShare = Math.max(0, Math.min(1, opts.scenario.pickupShare - (f.weather && w.rainMm >= 10 ? P.weather.rainPickupDrop : 0)));
    let pickup = 0;
    for (let i = 0; i < orders; i++) if (counts.next() < pickupShare) pickup++;

    // 按类别的行数：促销类别的行数按实际提升幅度放大
    const linesByCategory: Record<string, number> = {};
    let lines = 0;
    const adj = categories.map((c) => (shares[c] ?? 0) * (promo[c] ?? 1));
    for (let i = 0; i < categories.length; i++) {
      const k = counts.poisson(orders * opts.scenario.basketMeanLines * (adj[i] as number));
      linesByCategory[categories[i] as string] = k;
      lines += k;
    }

    const observed = {
      holiday,
      holidayEve: eveOf !== null,
      dayAfterHoliday: after,
      promoCategories: Object.keys(promo).sort(),
      forecastTempC: w.fTemp,
      forecastRainMm: w.fRain,
      stormWarning: w.warning,
      stormWarningTomorrow: tomorrowWarning,
    };
    days.push({
      day: d,
      date: isoDate(ms),
      dow,
      observed,
      hidden: {
        tempC: w.tempC,
        rainMm: w.rainMm,
        storm: w.storm,
        weekday: r3(weekdayMult),
        holiday: r3(holidayMult),
        weather: r3(weatherMult),
        promo: r3(promoMult),
        promoUplift: promo,
        trend: r3(trend),
        localEvent: r3(localEvent),
        regime,
        noise: r3(dayNoise),
        season: r3(seasonMult),
      },
      expected: { orders: r2(expectedOrders), hourly: expectedHourly.map(r2) },
      actual: { orders, hourly, pickup, delivery: orders - pickup, lines, linesByCategory },
      x: {
        weekend: weekend ? 1 : 0,
        holiday: holiday ? 1 : 0,
        holidayEve: eveOf ? 1 : 0,
        dayAfterHoliday: after ? 1 : 0,
        promoShare: r3(Object.keys(promo).reduce((a, c) => a + (shares[c] ?? 0), 0)),
        forecastTempC: w.fTemp,
        forecastRainMm: w.fRain,
        stormWarning: w.warning ? 1 : 0,
        stormWarningTomorrow: tomorrowWarning ? 1 : 0,
        // 具体是哪个节日（不同节日的影响差别很大）
        ...(holiday ? { [`holiday_${holiday}`]: 1 } : {}),
        ...(eveOf ? { [`eve_${eveOf}`]: 1 } : {}),
      },
    });
  }
  return { days, hours, categories, factors: f };
}

/** 转成特征层的按天输入（结构与 @storewright/ai 的 DailyHours 相同） */
export function historyDailyHours(h: DemandHistory): Array<{ day: number; dow: number; hourly: number[]; x: Record<string, number> }> {
  return h.days.map((d) => ({ day: d.day, dow: d.dow, hourly: d.actual.hourly, x: d.x }));
}

const lerp = ([a, b]: [number, number], t: number) => a + (b - a) * t;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
