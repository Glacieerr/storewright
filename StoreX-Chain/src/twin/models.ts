import { BASE_UNITS, HOUR_W } from '../sim/engine';
import type { StoreSite } from '../region/network';

/**
 * 机理模型（现场和孪生用同一套方程；现场用「真实」参数，孪生用自己估计的参数）：
 *
 * - 冷机：车厢空气和货物（探针）两个温度。空气被外面漏进来的热、开门、密封不严加热，压缩机按设定温度上下 0.8 °C 启停；
 *   货物跟着空气慢慢变（冷藏 4 小时、冷冻 10 小时的时间常数）。卸货时开门（月台有门封），空气升上去，货物只升一点；
 *   密封坏了漏热超过制冷量，空气降不下来，一个多小时后货物超标；压缩机坏了就只剩保温。
 * - 延误：alpha-beta 滤波（位置和变化率），用定位和到站事件更新；
 * - 门店生鲜：按 StoreX 的到店曲线每小时卖货。
 *
 * 参数单位是分钟。MATLAB / Simulink 版本在 engines/matlab（同样的方程，用 reference 里的数据核对）。
 */
export interface ReeferParams {
  /** 保温层漏热、开门、密封不严的时间常数，压缩机每分钟能降多少度，货物跟随空气的时间常数，启停的回差 */
  tauIns: number;
  tauDoor: number;
  tauSeal: number;
  rCool: number;
  tauProd: number;
  band: number;
}
export const REEFER: ReeferParams = { tauIns: 300, tauDoor: 90, tauSeal: 22, rCool: 0.25, tauProd: 240, band: 0.8 };
export type ReeferZone = 'chilled' | 'frozen';
/** 冷冻货的热容大得多：货物温度跟随空气慢（时间常数 10 小时） */
export const reeferParams = (zone: ReeferZone, base: ReeferParams = REEFER): ReeferParams => (zone === 'frozen' ? { ...base, tauProd: base.tauProd * 2.5 } : base);
export const SETPOINT: Record<ReeferZone, number> = { chilled: 2, frozen: -20 };
export const LIMIT: Record<ReeferZone, number> = { chilled: 5, frozen: -15 };

export interface ReeferState {
  air: number;
  product: number;
  cool: boolean;
}
export interface ReeferInputs {
  amb: number;
  set: number;
  door: boolean;
  /** 密封不严（现场的故障；孪生用它自己估计的额外漏热代替） */
  seal: boolean;
  /** 压缩机好不好 */
  comp: boolean;
  /** 额外的升温（°C / 分钟），孪生用来吸收模型解释不了的部分 */
  extra?: number;
}

/** 环境温度：凌晨最低约 15.5 °C，下午 3 点最高约 28.5 °C */
export function ambient(t: number): number {
  const h = t / 3600;
  return 22 + 6.5 * Math.sin((2 * Math.PI * (h - 9)) / 24);
}

/** 冷机走 dt 分钟（内部按 1 分钟一步） */
export function reeferStep(s: ReeferState, p: ReeferParams, u: ReeferInputs, dtMin: number): ReeferState {
  let { air, product, cool } = s;
  const n = Math.max(1, Math.round(dtMin));
  const h = dtMin / n;
  for (let i = 0; i < n; i++) {
    if (!u.comp) cool = false;
    else if (air > u.set + p.band) cool = true;
    else if (air < u.set - p.band) cool = false;
    const gap = u.amb - air;
    const heat = gap / p.tauIns + (u.door ? gap / p.tauDoor : 0) + (u.seal ? gap / p.tauSeal : 0) + (u.extra ?? 0);
    const dAir = heat - (cool ? p.rCool : 0) + (product - air) / 200;
    const dProd = (air - product) / p.tauProd;
    air += dAir * h;
    product += dProd * h;
  }
  return { air, product, cool };
}

/** 延误的 alpha-beta 滤波：d 秒、rate 秒 / 秒 */
export interface DelayFilter {
  d: number;
  rate: number;
  t: number;
  n: number;
}
export const newFilter = (t: number, d = 0): DelayFilter => ({ d, rate: 0, t, n: 0 });
export function filterUpdate(f: DelayFilter, t: number, z: number, alpha = 0.55, beta = 0.08): void {
  const dt = Math.max(1, t - f.t);
  const pred = f.d + f.rate * dt;
  const r = z - pred;
  f.d = pred + alpha * r;
  f.rate = Math.max(-0.5, Math.min(1, f.rate * Math.exp(-dt / 1800) + (beta * r) / dt));
  f.t = t;
  f.n++;
}
/** 往后看 dt 秒的延误：变化率按半小时衰减 */
export const filterAhead = (f: DelayFilter, dt: number): number => f.d + f.rate * 1800 * (1 - Math.exp(-Math.max(0, dt) / 1800));

/** 配送中心追加补货的小车最多装几托 */
export const RESTOCK_PALLETS = 12;

/** 门店生鲜（乳品、果蔬、肉类、面包熟食）占全部件数的比例 */
export const FRESH_SHARE = 0.4;
/** 某家店某个时刻每秒卖出的生鲜件数（计划的平均，不含波动） */
export function freshRate(st: StoreSite, t: number): number {
  const h = Math.floor(((t / 3600) % 24 + 24) % 24);
  return (BASE_UNITS * st.size * FRESH_SHARE * (HOUR_W[h] as number)) / 3600;
}
/** 从 t0 到 t1 计划卖出的生鲜件数 */
export function freshBetween(st: StoreSite, t0: number, t1: number): number {
  let s = 0;
  for (let t = t0; t < t1; t += 300) s += freshRate(st, t) * Math.min(300, t1 - t);
  return s;
}
