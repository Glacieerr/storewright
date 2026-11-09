import type * as THREE from 'three';
import { HITCH_BEHIND, MODEL_SPECS, modelGeometry, modelWithWheels, wheelGeometry as wheelGeo, type AxleSpec, type ModelKey } from './vehicles/index';

/**
 * 路上的车：按零件建模，原点在零件的车尾、车头朝 +x（米）。半挂车分成牵引车和挂车两个零件，集卡是牵引车 + 骨架车 + 集装箱，
 * 小汽车拖小拖车是两个零件；单体车（轿车、SUV、厢式车、货车、公交、房车）是一个零件。车型的外形和尺寸见 vehicles/
 * （第一部分 Storewright 的放样精模 + 远处的简模，尺寸表 vehicles/specs.ts）。
 *
 * 每个零件在车上的位置用两个「锚点」表示：前锚点（前轴、牵引销或挂钩）、后锚点（后轴组），
 * 都是从整车车头往后量的米数；ax 是前锚点在零件自己坐标里的 x。车沿路径走时，两个锚点落在路径上，
 * 零件的朝向 = 后锚点指向前锚点（铰接的运动学见 motion.ts 和 yard/rig.ts）。
 *
 * 车轮单独画（按走过的路程转、前轮跟着弯道打方向，双胎是两只轮胎），位置见 AXLES；车灯也单独画（刹车灯、转向灯、倒车灯、
 * 夜里的尾灯和大灯），位置见 LAMPS。远处用简模（车轮合在车身里）。
 */
export type PartSlot = ModelKey;

export interface PartSpec {
  slot: PartSlot;
  /** 前锚点、后锚点离整车车头的距离（米） */
  fa: number;
  ra: number;
  /** 前锚点在零件坐标里的 x */
  ax: number;
  /** 抬高（骨架车上的集装箱） */
  y?: number;
  /** 用实例颜色上色（牵引车驾驶室、集装箱、小汽车、公交） */
  tint?: boolean;
}
export interface Build {
  parts: PartSpec[];
  /** 整车长（车头到车尾） */
  L: number;
}

/** 零件的整体模型（精模 + 合进去的简化车轮）：港口闸口的外来集卡等不单独画车轮的地方用 */
export function partGeometry(slot: PartSlot): THREE.BufferGeometry {
  return modelWithWheels(slot);
}

/** 区域车辆层近处用的车身（精模，不含车轮：车轮单独画，见 AXLES） */
export function bodyGeometry(slot: PartSlot): THREE.BufferGeometry {
  return modelGeometry(slot, 'near');
}

/** 远处用的简模（车轮合在车身里） */
export function farGeometry(slot: PartSlot): THREE.BufferGeometry {
  return modelGeometry(slot, 'far');
}

/** 单独画的车轮：车轴在零件坐标里的 x、轮半径、轮距的一半（双胎是两只轮胎的中间）、双胎、转向轴 */
export type Axle = AxleSpec;
export const AXLES: Partial<Record<PartSlot, Axle[]>> = Object.fromEntries((Object.keys(MODEL_SPECS) as PartSlot[]).filter((k) => MODEL_SPECS[k].axles.length).map((k) => [k, MODEL_SPECS[k].axles]));
/** 车轮的样子：乘用车的五辐轮毂、货车的钢圈 */
export const WHEEL_KIND: Record<PartSlot, 'car' | 'truck'> = Object.fromEntries((Object.keys(MODEL_SPECS) as PartSlot[]).map((k) => [k, MODEL_SPECS[k].wheel])) as Record<PartSlot, 'car' | 'truck'>;

/** 一个车轮（半径 1、宽 1，轴沿 z、中心在原点，按实例缩放到真实尺寸） */
export function wheelGeometry(kind: 'car' | 'truck' = 'truck'): THREE.BufferGeometry {
  return wheelGeo(kind);
}

/**
 * 车灯（零件坐标，[x, y, |z|]，左右各一个）：尾灯 / 刹车灯、倒车灯、后转向灯、前转向灯、大灯；k 是灯的大小倍数。
 * 半挂车的尾灯在挂车上、前转向灯和大灯在牵引车上。
 */
export interface LampSpec {
  tail?: [number, number, number];
  back?: [number, number, number];
  rearTurn?: [number, number, number];
  frontTurn?: [number, number, number];
  head?: [number, number, number];
  k: number;
}
export const LAMPS: Partial<Record<PartSlot, LampSpec>> = Object.fromEntries((Object.keys(MODEL_SPECS) as PartSlot[]).filter((k) => Object.keys(MODEL_SPECS[k].lamps).length > 1).map((k) => [k, MODEL_SPECS[k].lamps]));

// ———————————————————————— 车型 → 零件 ————————————————————————

const steerX = (slot: PartSlot) => (MODEL_SPECS[slot].axles.find((a) => a.steer) as AxleSpec).x;
/** 后锚点：牵引车按牵引销（≈ 后轴，和铰接运动学一致），其他按后轴组中心 */
const rearX = (slot: PartSlot) => {
  const s = MODEL_SPECS[slot];
  if (s.kingpin !== undefined && s.axles.some((a) => a.steer)) return s.kingpin;
  const r = s.axles.filter((a) => !a.steer);
  return r.reduce((a, b) => a + b.x, 0) / Math.max(1, r.length);
};

/** 单体车（或单独开的牵引车）：前轴、后轴落在路径上 */
function single(slot: PartSlot, tint = false): Build {
  const L = MODEL_SPECS[slot].length;
  return { parts: [{ slot, fa: +(L - steerX(slot)).toFixed(3), ra: +(L - rearX(slot)).toFixed(3), ax: steerX(slot), ...(tint ? { tint } : {}) }], L };
}

/** 铰接车：牵引车 + 挂车 / 骨架车（+ 骨架车上的集装箱，箱尾比骨架车车尾往前 boxBack 米） */
function rig(tractor: PartSlot, trailer: PartSlot, box?: { slot: PartSlot; back: number }): Build {
  const t = MODEL_SPECS[tractor];
  const tr = MODEL_SPECS[trailer];
  const kp = t.kingpin as number;
  const fa = +(t.length - kp).toFixed(3);
  const tkp = tr.kingpin as number;
  const trAxle = tr.axles.reduce((a, b) => a + b.x, 0) / tr.axles.length;
  const ra = +(fa + tkp - trAxle).toFixed(3);
  const parts: PartSpec[] = [
    { slot: tractor, fa: +(t.length - steerX(tractor)).toFixed(3), ra: fa, ax: steerX(tractor), tint: true },
    { slot: trailer, fa, ra, ax: tkp },
  ];
  if (box) parts.push({ slot: box.slot, fa, ra, ax: +(tkp - box.back).toFixed(3), y: 1.25, tint: true });
  return { parts, L: +(fa + tkp).toFixed(3) };
}

/** 小汽车 / 房车拖小拖车：拖车的前锚点是挂钩球头（车尾后 HITCH_BEHIND 米），后锚点是拖车车轴 */
function tow(car: PartSlot, trailer: PartSlot): Build {
  const c = single(car, true);
  const tr = MODEL_SPECS[trailer];
  const hitch = +(MODEL_SPECS[car].length + (HITCH_BEHIND[car] ?? 0.2)).toFixed(3);
  const axle = tr.axles.reduce((a, b) => a + b.x, 0) / tr.axles.length;
  return { parts: [...c.parts, { slot: trailer, fa: hitch, ra: +(hitch + (tr.hitch as number) - axle).toFixed(3), ax: tr.hitch as number, tint: true }], L: +(hitch + (tr.hitch as number)).toFixed(3) };
}

/**
 * 车型 → 零件。仿真的车（自有车队的常温 / 冷藏半挂车、供应商的无彩条挂车、电动厢式冷藏车、面包车、集卡）的车长和锚点不变：
 * 运动规划、收货场和设施的作业动画都按这些数排。其余是背景车流、门店停车场、设施场内用的车型。
 */
export const BUILDS = {
  ownDry: rig('tractor', 'trailerDry'),
  ownReefer: rig('tractor', 'trailerReefer'),
  plainDry: rig('tractor', 'trailerPlain'),
  plainReefer: rig('tractor', 'trailerPlainReefer'),
  ev: single('evTruck'),
  vanOnline: single('vanOnline'),
  vanBakery: single('vanBakery'),
  /** 集卡（港口的外来集卡也按它画；牵引车的零件名保持 tractor） */
  drayage: rig('tractor', 'chassis', { slot: 'container', back: 0 }),
  /** 区域车辆层画本店的集卡：日间驾驶室的牵引车（锚点和 drayage 一样） */
  drayDay: rig('tractorDay', 'chassis', { slot: 'container', back: 0 }),
  dray20: rig('tractorDay', 'chassis20', { slot: 'container20', back: 0.2 }),
  car: single('car', true),
  hatch: single('hatch', true),
  suv: single('suv', true),
  mpv: single('mpv', true),
  pickup: single('pickup', true),
  van: single('van', true),
  boxTruck: single('boxTruck', true),
  bus: single('bus', true),
  rv: single('rv', true),
  longDry: rig('tractorLong', 'trailerPlain'),
  longReefer: rig('tractorLong', 'trailerPlainReefer'),
  terminal: rig('terminalTractor', 'chassis', { slot: 'container', back: 0 }),
  shunter: rig('yardShunter', 'trailerPlain'),
  bobtail: single('tractor', true),
  bobtailDay: single('tractorDay', true),
  bobtailLong: single('tractorLong', true),
  terminalBobtail: single('terminalTractor', true),
  shunterBobtail: single('yardShunter', true),
  pickupCamper: tow('pickup', 'camper'),
  suvCamper: tow('suv', 'camper'),
  suvBoat: tow('suv', 'boatTrailer'),
  pickupBoat: tow('pickup', 'boatTrailer'),
  suvUtility: tow('suv', 'utilityTrailer'),
} satisfies Record<string, Build>;
export type BuildKey = keyof typeof BUILDS;
