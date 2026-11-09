import { H } from '../../src/core/sim';
import { gen1, storex, storex2030, type Scenario } from '../../src/world/config';

/** 网页上可以调的东西（孪生的「演练」）：方案、日子、订单量和几项设备 */
export type Preset = 'gen1' | 'storex' | 'storex2030';

export interface Knobs {
  preset: Preset;
  seed: number;
  orders: number;
  /** StoreX 才有的设备 */
  bots: number;
  amr: number;
  carts: number;
  gates: number;
  /** 演练 */
  outage: boolean;
  fallback: boolean;
  surge: boolean;
}

export const PRESETS: { key: Preset; label: string; orders: number }[] = [
  { key: 'gen1', label: '上一代', orders: 266 },
  { key: 'storex', label: 'StoreX', orders: 266 },
  { key: 'storex2030', label: 'StoreX 2030', orders: 532 },
];

export function defaults(preset: Preset, seed = 1): Knobs {
  const s = make(preset, seed, undefined);
  return {
    preset,
    seed,
    orders: s.demand.ordersPerDay,
    bots: s.mfc.bots,
    amr: s.robots.amr,
    carts: s.pickup.carts,
    gates: s.checkout.gates,
    outage: false,
    fallback: s.mfc.fallback,
    surge: false,
  };
}

function make(preset: Preset, seed: number, orders: number | undefined): Scenario {
  const demand = orders ? { ordersPerDay: orders } : {};
  return preset === 'gen1' ? gen1(seed, demand) : preset === 'storex' ? storex(seed, demand) : storex2030(seed, demand);
}

/** 把网页上的设置变成一个仿真场景 */
export function scenarioOf(k: Knobs, trace: boolean): Scenario {
  // 订单比预测多 25%：订单量 × 1.25，排班仍按原来的量
  const s = make(k.preset, k.seed, Math.round(k.orders * (k.surge ? 1.25 : 1)));
  s.trace = trace;
  if (k.surge) s.staffing.planBias = 1 / 1.25;
  if (k.preset !== 'gen1') {
    s.mfc.bots = k.bots;
    s.robots.amr = k.amr;
    s.pickup.carts = k.carts;
    s.checkout.gates = k.gates;
    s.mfc.fallback = k.fallback;
    if (k.outage) s.mfc.outage = { start: 15 * H, sec: 2 * H };
  }
  return s;
}

/** 对照：同一天、同样订单量的上一代 */
export function baselineOf(k: Knobs): Knobs {
  return { ...defaults('gen1', k.seed), orders: k.orders, surge: k.surge };
}
