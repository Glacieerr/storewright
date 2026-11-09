/**
 * 潮汐：半日潮（一天两次高潮、两次低潮，周期约 12.42 小时），潮差 3 米（振幅 1.5 米，真实尺寸：竖直方向不压缩）。
 * 海面整体涨落，船、拖轮、引航艇浮在水面上一起升降；码头、泊位和岸桥不动（岸桥抓放船上的箱时跟着船的高度）。
 *
 * 海面平面原来在 y = −1.2（船体模型的水线也在 −1.2，船画在 y = 0）。高潮的海面不能高过地面（y = 0，海面是一整块平面，
 * 高过地面就把陆地淹了），所以平均海面放在 −1.7：高潮 −0.2、低潮 −3.2。船按「此刻的海面 − 原来的水线」整体抬高或降低。
 * 每天的高潮时刻比前一天晚约 50 分钟（按当天的编号）。
 */
export const TIDE_PERIOD = 12.42 * 3600;
export const TIDE_AMP = 1.5;
/** 平均海面、船体模型的水线（船画在 y = 0 时） */
export const SEA_MEAN = -1.7;
const WATERLINE = -1.2;

let tHW = 3.2 * 3600;

/** 换一天：第一次高潮的时刻（当天 0 点起的秒） */
export function setTideDay(seed: number): void {
  tHW = (((3.2 * 3600 + seed * 50 * 60) % TIDE_PERIOD) + TIDE_PERIOD) % TIDE_PERIOD;
}

/** 此刻海面的高度（区域坐标的 y） */
export function seaY(t: number): number {
  return SEA_MEAN + TIDE_AMP * Math.cos((2 * Math.PI * (t - tHW)) / TIDE_PERIOD);
}

/** 浮在水面上的东西（船、拖轮、引航艇）此刻要抬高多少（相对画在 y = 0 时） */
export function floatY(t: number): number {
  return seaY(t) - WATERLINE;
}

/** 潮位（潮高，从最低低潮面起算，米）、涨潮还是落潮、下一次高潮和低潮的时刻（当天 0 点起的秒，可能过了半夜） */
export function tideInfo(t: number): { level: number; rising: boolean; nextHigh: number; nextLow: number } {
  const ph = (((t - tHW) % TIDE_PERIOD) + TIDE_PERIOD) % TIDE_PERIOD;
  const level = TIDE_AMP + TIDE_AMP * Math.cos((2 * Math.PI * ph) / TIDE_PERIOD);
  const nextHigh = t + (TIDE_PERIOD - ph);
  const nextLow = t + (ph < TIDE_PERIOD / 2 ? TIDE_PERIOD / 2 - ph : 1.5 * TIDE_PERIOD - ph);
  return { level, rising: ph > TIDE_PERIOD / 2, nextHigh, nextLow };
}
