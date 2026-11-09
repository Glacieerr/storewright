import type { Scenario } from '../world/config';

/**
 * 能耗：每小时的负荷（制冷、空调、照明、IT、机器人）、屋顶光伏发电和储能削峰。
 * 电价：平时 0.14 美元 / 度，16–21 点峰时 0.24；需量电费按峰时最大功率，每月 15 美元 / 千瓦（折到每天）。
 */
export interface EnergyResult {
  loadKw: number[];
  solarKw: number[];
  gridKw: number[];
  batteryKw: number[];
  kwh: number;
  gridKwh: number;
  solarKwh: number;
  peakGridKw: number;
  costPerDay: number;
  co2Kg: number;
  byUse: { refrigeration: number; hvac: number; lighting: number; it: number; robots: number };
}

const OFF_PEAK = 0.14;
const PEAK = 0.24;
const DEMAND_PER_KW_MONTH = 15;
const GRID_CO2 = 0.35;
/** 秋季晴天的光伏出力曲线（占装机容量的比例，6–19 点） */
const SOLAR = [0, 0, 0, 0, 0, 0, 0.02, 0.08, 0.2, 0.36, 0.5, 0.6, 0.64, 0.62, 0.54, 0.42, 0.27, 0.12, 0.04, 0.01, 0, 0, 0, 0];

export function energyModel(s: Scenario, shoppersByHour: readonly number[], robotKwByHour: readonly number[]): EnergyResult {
  const e = s.energy;
  const peakTraffic = Math.max(1, ...shoppersByHour);
  const loadKw: number[] = [];
  const byUse = { refrigeration: 0, hvac: 0, lighting: 0, it: 0, robots: 0 };
  for (let h = 0; h < 24; h++) {
    const open = h >= 7 && h < 22;
    const staff = h >= 5 && h < 23;
    const traffic = (shoppersByHour[h] ?? 0) / peakTraffic;
    // 制冷：开门时顾客开柜门多一些，夜里拉帘子
    const refr = e.refrigerationKw * (open ? 0.92 + 0.2 * traffic : 0.78);
    const hvac = e.hvacKw * (open ? 0.75 + 0.35 * traffic : staff ? 0.5 : 0.3);
    const light = open || staff ? e.lightingKw * (open ? 1 : 0.6) : e.lightingNightKw;
    const robots = robotKwByHour[h] ?? 0;
    const total = refr + hvac + light + e.itKw + robots;
    byUse.refrigeration += refr;
    byUse.hvac += hvac;
    byUse.lighting += light;
    byUse.it += e.itKw;
    byUse.robots += robots;
    loadKw.push(total);
  }
  const solarKw = SOLAR.map((f) => f * e.solarKwp);
  // 储能：白天光伏多余的电先充，峰时（16–21 点）放电；没充满的部分在夜里低价时段补充
  const batteryKw = new Array<number>(24).fill(0);
  const gridKw = new Array<number>(24).fill(0);
  let soc = e.batteryKwh * 0.2;
  const power = e.batteryKwh / 4;
  for (let h = 0; h < 24; h++) {
    let net = (loadKw[h] as number) - (solarKw[h] as number);
    const peak = h >= 16 && h < 21;
    if (e.batteryKwh > 0) {
      if (net < 0) {
        const charge = Math.min(-net, power, e.batteryKwh - soc);
        soc += charge;
        batteryKw[h] = -charge;
        net += charge;
      } else if (peak) {
        const discharge = Math.min(net, power, soc - e.batteryKwh * 0.1);
        if (discharge > 0) {
          soc -= discharge;
          batteryKw[h] = discharge;
          net -= discharge;
        }
      } else if (h < 6 && soc < e.batteryKwh * 0.6) {
        const charge = Math.min(power, e.batteryKwh * 0.6 - soc);
        soc += charge;
        batteryKw[h] = -charge;
        net += charge;
      }
    }
    gridKw[h] = Math.max(0, net);
  }
  const kwh = loadKw.reduce((a, b) => a + b, 0);
  const solarKwh = solarKw.reduce((a, b) => a + b, 0);
  const gridKwh = gridKw.reduce((a, b) => a + b, 0);
  const peakGridKw = Math.max(...gridKw.slice(16, 21));
  let energyCost = 0;
  gridKw.forEach((kw, h) => (energyCost += kw * (h >= 16 && h < 21 ? PEAK : OFF_PEAK)));
  const costPerDay = energyCost + (peakGridKw * DEMAND_PER_KW_MONTH) / 30;
  return { loadKw, solarKw, gridKw, batteryKw, kwh, gridKwh, solarKwh, peakGridKw, costPerDay, co2Kg: gridKwh * GRID_CO2, byUse };
}

/** 各类机器人忙碌时的功率（千瓦）；空闲时按 15% 计 */
export const ROBOT_KW: Record<string, number> = { mfcBot: 0.35, amr: 0.25, scanner: 0.15, scrubber: 0.6, cart: 0.2, loader: 0.4, pallet: 0.8 };
