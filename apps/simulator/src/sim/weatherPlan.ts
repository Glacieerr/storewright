import { createRng } from '@storewright/domain';
import { trRecord } from '../i18n';

/**
 * 一天之内变化的天气（「多变」选项）：按季节和随机种子生成逐小时的天气，相邻小时合并成时段；
 * 时段之间用 30 分钟渐变（云慢慢变厚、雨慢慢下大）。画面和仿真都用同一份计划：
 * - 画面：雨雪粒子密度、阴天程度、雾的远近、路面湿滑（雨停后约一小时才干）、积雪；
 * - 仿真：下雨 / 下雪的时段内车边交付变慢，路上更堵，全天订单量按雨雪时长略增。
 */

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog';

export interface WeatherSpan {
  start: number;
  end: number;
  kind: WeatherKind;
  /** 强度 0.3–1（小雨 / 大雨） */
  strength: number;
}

/** 某一时刻的天气状态（各项 0–1） */
export interface WeatherState {
  cloud: number;
  rain: number;
  snow: number;
  fog: number;
  /** 路面湿度：下雨时上升，雨停后慢慢变干 */
  wet: number;
  /** 积雪覆盖 */
  snowCover: number;
  kind: WeatherKind;
}

const HOURS = 32;
const RAMP = 1800;

/** 各季节每小时转移的倾向（合理推测）：夏天午后多阵雨，冬天可能下雪，秋冬清晨多雾 */
function weights(season: string, hour: number, prev: WeatherKind): Record<WeatherKind, number> {
  const h = hour % 24;
  const stay = 6;
  const w: Record<WeatherKind, number> = { clear: 3, cloudy: 2, rain: 0.6, snow: 0, fog: 0 };
  if (season === 'summer') {
    w.clear = 4;
    if (h >= 13 && h <= 18) w.rain = 1.4;
  } else if (season === 'winter') {
    w.clear = 2;
    w.cloudy = 3;
    w.rain = 0.2;
    w.snow = 0.9;
  } else if (season === 'spring') {
    w.rain = 1;
    w.cloudy = 2.5;
  }
  if ((season === 'autumn' || season === 'winter' || season === 'spring') && h >= 4 && h <= 8) w.fog = 1.5;
  if (h > 10 && prev !== 'fog') w.fog = 0;
  w[prev] += stay;
  // 雨雪之前多半先转阴
  if (prev === 'clear') {
    w.rain *= 0.3;
    w.snow *= 0.3;
  }
  return w;
}

export function weatherPlan(seed: number, season: string): WeatherSpan[] {
  const rng = createRng(seed * 4099 + season.length * 97 + 11);
  const hours: Array<{ kind: WeatherKind; strength: number }> = [];
  let prev: WeatherKind = rng.chance(0.6) ? 'clear' : 'cloudy';
  for (let h = 0; h < HOURS; h++) {
    const w = weights(season, h, prev);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    let r = rng.next() * total;
    let kind: WeatherKind = prev;
    for (const k of Object.keys(w) as WeatherKind[]) {
      r -= w[k];
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    hours.push({ kind, strength: kind === 'rain' || kind === 'snow' ? rng.uniform(0.3, 1) : kind === 'fog' ? rng.uniform(0.5, 1) : 1 });
    prev = kind;
  }
  const spans: WeatherSpan[] = [];
  hours.forEach((h, i) => {
    const last = spans[spans.length - 1];
    if (last && last.kind === h.kind) {
      last.end = (i + 1) * 3600;
      last.strength = Math.max(last.strength, h.strength);
    } else spans.push({ start: i * 3600, end: (i + 1) * 3600, kind: h.kind, strength: h.strength });
  });
  return spans;
}

/** 固定天气对应的状态 */
export function fixedWeather(kind: WeatherKind): WeatherState {
  return {
    cloud: kind === 'clear' ? 0 : kind === 'fog' ? 0.6 : kind === 'snow' ? 0.9 : 1,
    rain: kind === 'rain' ? 1 : 0,
    snow: kind === 'snow' ? 1 : 0,
    fog: kind === 'fog' ? 1 : 0,
    wet: kind === 'rain' ? 1 : 0,
    snowCover: kind === 'snow' ? 1 : 0,
    kind,
  };
}

const LEVEL: Record<WeatherKind, Omit<WeatherState, 'wet' | 'snowCover' | 'kind'>> = {
  clear: { cloud: 0, rain: 0, snow: 0, fog: 0 },
  cloudy: { cloud: 1, rain: 0, snow: 0, fog: 0 },
  rain: { cloud: 1, rain: 1, snow: 0, fog: 0 },
  snow: { cloud: 0.9, rain: 0, snow: 1, fog: 0 },
  fog: { cloud: 0.6, rain: 0, snow: 0, fog: 1 },
};

/** 时刻 t（秒，按一天之内计）的天气状态：时段边界前后各 15 分钟渐变 */
export function weatherAt(plan: readonly WeatherSpan[], t: number, out?: WeatherState): WeatherState {
  const o: WeatherState = out ?? fixedWeather('clear');
  o.cloud = 0;
  o.rain = 0;
  o.snow = 0;
  o.fog = 0;
  let weightSum = 0;
  let best = 0;
  o.kind = 'clear';
  for (const s of plan) {
    // 梯形权重：时段内为 1，边界外 RAMP/2 内线性下降
    const w = Math.max(0, Math.min(1, (t - (s.start - RAMP / 2)) / RAMP, ((s.end + RAMP / 2) - t) / RAMP));
    if (w <= 0) continue;
    const lv = LEVEL[s.kind];
    const k = s.kind === 'rain' || s.kind === 'snow' || s.kind === 'fog' ? s.strength : 1;
    o.cloud += w * lv.cloud;
    o.rain += w * lv.rain * k;
    o.snow += w * lv.snow * k;
    o.fog += w * lv.fog * k;
    weightSum += w;
    if (w > best) {
      best = w;
      o.kind = s.kind;
    }
  }
  if (weightSum > 0) {
    o.cloud /= weightSum;
    o.rain /= weightSum;
    o.snow /= weightSum;
    o.fog /= weightSum;
  }
  // 路面湿度：最近一次下雨结束后约一小时干透；积雪化得更慢
  let wet = o.rain > 0.05 ? 1 : 0;
  let cover = o.snow > 0.05 ? Math.min(1, 0.3 + o.snow) : 0;
  for (const s of plan) {
    if (s.kind === 'rain' && s.end <= t && t - s.end < 3600) wet = Math.max(wet, 1 - (t - s.end) / 3600);
    if (s.kind === 'snow' && s.start <= t) cover = Math.max(cover, s.end <= t ? Math.max(0, 1 - (t - s.end) / (4 * 3600)) : Math.min(1, (t - s.start) / 3600));
  }
  o.wet = Math.max(wet, cover * 0.4);
  o.snowCover = cover;
  return o;
}

/** 仿真用：订单量系数、逐小时的路况系数、雨雪时段 */
export function simWeather(plan: readonly WeatherSpan[], openSec: number, closeSec: number): { demandK: number; trafficByHour: number[]; windows: Array<{ kind: 'rain' | 'snow'; start: number; end: number }> } {
  const open = Math.max(1, closeSec - openSec);
  let rainShare = 0;
  let snowShare = 0;
  const trafficByHour = Array.from({ length: 24 }, () => 1);
  for (const s of plan) {
    const overlap = Math.max(0, Math.min(s.end, closeSec) - Math.max(s.start, openSec));
    if (s.kind === 'rain') rainShare += (overlap / open) * s.strength;
    if (s.kind === 'snow') snowShare += (overlap / open) * s.strength;
    for (let h = Math.floor(s.start / 3600); h < Math.ceil(s.end / 3600); h++) {
      const k = s.kind === 'rain' ? 1 + 0.3 * s.strength : s.kind === 'snow' ? 1 + 0.8 * s.strength : s.kind === 'fog' ? 1.2 : 1;
      if (h >= 0 && h < 24) trafficByHour[h] = Math.max(trafficByHour[h] as number, k);
    }
  }
  const windows = plan.filter((s) => s.kind === 'rain' || s.kind === 'snow').map((s) => ({ kind: s.kind as 'rain' | 'snow', start: s.start, end: s.end }));
  return { demandK: 1 + 0.08 * rainShare + 0.15 * snowShare, trafficByHour, windows };
}

export const WEATHER_KIND_LABEL: Record<WeatherKind, string> = trRecord({ clear: '晴', cloudy: '多云', rain: '雨', snow: '雪', fog: '雾' });
