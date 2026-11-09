/**
 * 车辆的尺寸和运动学参数（唯一的一份表；纯数据，不依赖 three.js，收货场引擎 @storewright/yard（packages/yard） 和测试也用）。
 * 尺寸都是按公开资料取的假设参数（常见车型的公开外形尺寸取整，都是通用外形，不对应任何品牌）：
 * 乘用车按常见中型轿车、两厢车、紧凑型 SUV、MPV、全尺寸皮卡，货车按平头厢式货车、电动厢式冷藏车、
 * 平头牵引车（高顶卧铺 6×4、日间驾驶室 4×2）、长头卧铺牵引车，13.6 米三轴厢式挂车、40 / 20 尺集装箱骨架车，
 * 12 米城市公交，A 型自行式房车和三种小拖车，港口场内拖车和配送中心场内牵引车。
 * 外廓按公开的限值取：半挂车长不超过 13.75 米、铰接列车不超过 17.1 米（平头牵引车 + 13.6 米挂车 16.8 米）、
 * 长头（流线形）铰接列车不超过 18.1 米（长头牵引车 + 13.6 米挂车正好 18.1 米）、车宽不超过 2.55 米、车高不超过 4.0 米。
 *
 * 坐标（零件坐标，米）：原点在零件的车尾、车头朝 +x、地面 y = 0；z 向车辆右侧为正，车轴、车灯左右对称（|z|）。
 * 牵引销（kingpin）：牵引车上是鞍座中心，挂车 / 骨架车上是牵引销；挂钩（hitch）：拖车上是挂钩球头的位置。
 * 现有车型（tractor、trailer*、chassis、container、evTruck、van*、bus）的长度和牵引销位置不变：运动规划（motion.ts）、
 * 收货场引擎（yard/rig.ts 的 VEHICLE_DIMS）和设施的作业动画都按这些数排车位、倒车、算车长。
 */

/** 零件（车型）的键：区域车辆层每种一个实例化网格 */
export type ModelKey =
  | 'car'
  | 'hatch'
  | 'suv'
  | 'mpv'
  | 'pickup'
  | 'van'
  | 'vanOnline'
  | 'vanBakery'
  | 'boxTruck'
  | 'evTruck'
  | 'tractor'
  | 'tractorDay'
  | 'tractorLong'
  | 'trailerDry'
  | 'trailerReefer'
  | 'trailerPlain'
  | 'trailerPlainReefer'
  | 'chassis'
  | 'chassis20'
  | 'container'
  | 'container20'
  | 'bus'
  | 'rv'
  | 'camper'
  | 'boatTrailer'
  | 'utilityTrailer'
  | 'terminalTractor'
  | 'yardShunter';

/** 一根车轴：零件坐标的 x、轮半径、轮距的一半（双胎是两只轮胎中间）、双胎、转向轴 */
export interface AxleSpec {
  x: number;
  r: number;
  half: number;
  dual?: boolean;
  steer?: boolean;
}

/** 车灯（零件坐标 [x, y, |z|]，左右各一）：尾灯 / 刹车灯、倒车灯、后转向灯、前转向灯、大灯；k 是灯的大小倍数 */
export interface LampSpec {
  tail?: [number, number, number];
  back?: [number, number, number];
  rearTurn?: [number, number, number];
  frontTurn?: [number, number, number];
  head?: [number, number, number];
  k: number;
}

export interface ModelSpec {
  label: string;
  /** 车长、车宽、车高（米） */
  length: number;
  width: number;
  height: number;
  axles: AxleSpec[];
  lamps: LampSpec;
  /** 车轮的样子：乘用车的五辐轮毂、货车的钢圈 */
  wheel: 'car' | 'truck';
  /** 牵引销 / 鞍座中心（零件坐标 x） */
  kingpin?: number;
  /** 拖车的挂钩球头（拖车）、牵引车辆的拖钩（零件坐标 x，车尾外为负） */
  hitch?: number;
  /** 车身姿态：刹车、加速时最大俯仰角，转弯时最大侧倾角（度）；越高、越软的车倾得越多 */
  posture: { pitch: number; roll: number };
}

const CAR_LAMPS = (L: number, yh: number, yt: number, hw: number, k = 0.75): LampSpec => ({
  tail: [0.03, yt, hw - 0.27],
  back: [0.03, yt, hw - 0.5],
  rearTurn: [0.03, yt + 0.05, hw - 0.12],
  frontTurn: [L - 0.06, yh, hw - 0.14],
  head: [L - 0.05, yh, hw - 0.36],
  k,
});

const TRAILER_AXLES: AxleSpec[] = [1.6, 2.9, 4.2].map((x) => ({ x, r: 0.5, half: 0.9, dual: true }));
const TRAILER_LAMPS: LampSpec = { tail: [-0.04, 1.02, 1.0], back: [-0.04, 1.02, 0.66], rearTurn: [-0.04, 1.02, 1.16], k: 1 };
const VAN_LAMPS: LampSpec = { tail: [0.02, 1.2, 0.94], back: [0.02, 0.95, 0.94], rearTurn: [0.02, 1.42, 0.94], frontTurn: [5.97, 0.98, 0.9], head: [5.98, 1.0, 0.68], k: 0.85 };
const VAN_AXLES: AxleSpec[] = [
  { x: 5.1, r: 0.37, half: 0.88, steer: true },
  { x: 1.4, r: 0.37, half: 0.88 },
];

export const MODEL_SPECS: Record<ModelKey, ModelSpec> = {
  // —— 乘用车 ——
  car: { label: '中型轿车', length: 4.85, width: 1.84, height: 1.44, wheel: 'car', axles: [{ x: 3.845, r: 0.33, half: 0.8, steer: true }, { x: 1.015, r: 0.33, half: 0.8 }], lamps: CAR_LAMPS(4.85, 0.68, 0.84, 0.92), posture: { pitch: 1.4, roll: 2.2 } },
  hatch: { label: '两厢车', length: 4.3, width: 1.8, height: 1.46, wheel: 'car', axles: [{ x: 3.43, r: 0.31, half: 0.78, steer: true }, { x: 0.78, r: 0.31, half: 0.78 }], lamps: CAR_LAMPS(4.3, 0.72, 1.02, 0.9), posture: { pitch: 1.5, roll: 2.4 } },
  suv: { label: '紧凑型 SUV', length: 4.62, width: 1.86, height: 1.68, wheel: 'car', hitch: -0.05, axles: [{ x: 3.68, r: 0.36, half: 0.82, steer: true }, { x: 0.99, r: 0.36, half: 0.82 }], lamps: CAR_LAMPS(4.62, 0.88, 1.0, 0.93, 0.8), posture: { pitch: 1.6, roll: 3.0 } },
  mpv: { label: 'MPV', length: 4.95, width: 1.85, height: 1.75, wheel: 'car', axles: [{ x: 3.9, r: 0.34, half: 0.8, steer: true }, { x: 0.9, r: 0.34, half: 0.8 }], lamps: CAR_LAMPS(4.95, 0.86, 1.05, 0.92, 0.8), posture: { pitch: 1.6, roll: 3.2 } },
  pickup: { label: '全尺寸皮卡', length: 5.88, width: 2.03, height: 1.95, wheel: 'car', hitch: -0.3, axles: [{ x: 4.97, r: 0.41, half: 0.88, steer: true }, { x: 1.29, r: 0.41, half: 0.88 }], lamps: { tail: [0.03, 0.98, 0.95], back: [0.03, 0.86, 0.95], rearTurn: [0.03, 1.1, 0.95], frontTurn: [5.83, 0.98, 0.86], head: [5.84, 1.0, 0.64], k: 0.85 }, posture: { pitch: 1.6, roll: 2.8 } },
  // —— 厢式车、货车 ——
  van: { label: '高顶厢式车', length: 6.0, width: 2.05, height: 2.55, wheel: 'truck', axles: VAN_AXLES, lamps: VAN_LAMPS, posture: { pitch: 1.8, roll: 3.6 } },
  vanOnline: { label: '线上配送车', length: 6.0, width: 2.05, height: 2.55, wheel: 'truck', axles: VAN_AXLES, lamps: VAN_LAMPS, posture: { pitch: 1.8, roll: 3.6 } },
  vanBakery: { label: '面包配送车', length: 6.0, width: 2.05, height: 2.55, wheel: 'truck', axles: VAN_AXLES, lamps: VAN_LAMPS, posture: { pitch: 1.8, roll: 3.6 } },
  boxTruck: {
    label: '平头厢式货车',
    length: 7.6,
    width: 2.3,
    height: 3.4,
    wheel: 'truck',
    axles: [
      { x: 6.5, r: 0.44, half: 0.98, steer: true },
      { x: 2.2, r: 0.44, half: 0.9, dual: true },
    ],
    lamps: { tail: [-0.02, 1.25, 1.02], back: [-0.02, 1.0, 0.98], rearTurn: [-0.02, 1.5, 1.02], frontTurn: [7.6, 1.18, 0.98], head: [7.62, 1.0, 0.75], k: 0.95 },
    posture: { pitch: 1.2, roll: 3.2 },
  },
  evTruck: {
    label: '电动厢式冷藏车',
    length: 11.0,
    width: 2.5,
    height: 3.86,
    wheel: 'truck',
    axles: [
      { x: 9.6, r: 0.5, half: 1.0, steer: true },
      { x: 3.4, r: 0.5, half: 0.9, dual: true },
    ],
    lamps: { tail: [-0.05, 1.12, 1.02], back: [-0.05, 1.12, 0.66], rearTurn: [-0.05, 1.4, 1.04], frontTurn: [11.0, 1.22, 1.04], head: [11.02, 0.92, 0.82], k: 1 },
    posture: { pitch: 1.0, roll: 3.0 },
  },
  // —— 牵引车（kingpin = 鞍座中心）——
  tractor: {
    label: '平头牵引车（高顶卧铺，6×4）',
    length: 6.0,
    width: 2.5,
    height: 3.9,
    wheel: 'truck',
    kingpin: 1.6,
    axles: [
      { x: 4.9, r: 0.52, half: 1.02, steer: true },
      { x: 1.95, r: 0.52, half: 0.9, dual: true },
      { x: 0.65, r: 0.52, half: 0.9, dual: true },
    ],
    lamps: { tail: [0.06, 0.92, 0.95], frontTurn: [6.0, 1.28, 1.08], head: [6.02, 0.98, 0.8], k: 1 },
    posture: { pitch: 0.9, roll: 2.2 },
  },
  tractorDay: {
    label: '平头牵引车（日间驾驶室，4×2）',
    length: 6.0,
    width: 2.5,
    height: 3.05,
    wheel: 'truck',
    kingpin: 1.6,
    axles: [
      { x: 4.9, r: 0.52, half: 1.02, steer: true },
      { x: 1.25, r: 0.52, half: 0.9, dual: true },
    ],
    lamps: { tail: [0.06, 0.92, 0.95], frontTurn: [6.0, 1.28, 1.08], head: [6.02, 0.98, 0.8], k: 1 },
    posture: { pitch: 0.9, roll: 2.0 },
  },
  tractorLong: {
    label: '长头卧铺牵引车（6×4）',
    length: 7.0,
    width: 2.5,
    height: 3.85,
    wheel: 'truck',
    kingpin: 1.3,
    axles: [
      { x: 5.81, r: 0.52, half: 1.04, steer: true },
      { x: 1.95, r: 0.52, half: 0.95, dual: true },
      { x: 0.65, r: 0.52, half: 0.95, dual: true },
    ],
    lamps: { tail: [0.06, 0.92, 0.95], frontTurn: [6.85, 1.3, 1.14], head: [6.92, 1.3, 0.93], k: 1 },
    posture: { pitch: 1.0, roll: 2.2 },
  },
  // —— 挂车（kingpin = 牵引销）——
  trailerDry: { label: '厢式挂车（自有车队）', length: 13.6, width: 2.55, height: 4.0, wheel: 'truck', kingpin: 12.4, axles: TRAILER_AXLES, lamps: TRAILER_LAMPS, posture: { pitch: 0.4, roll: 2.6 } },
  trailerReefer: { label: '冷藏挂车（自有车队）', length: 13.6, width: 2.55, height: 4.0, wheel: 'truck', kingpin: 12.4, axles: TRAILER_AXLES, lamps: TRAILER_LAMPS, posture: { pitch: 0.4, roll: 2.6 } },
  trailerPlain: { label: '厢式挂车', length: 13.6, width: 2.55, height: 4.0, wheel: 'truck', kingpin: 12.4, axles: TRAILER_AXLES, lamps: TRAILER_LAMPS, posture: { pitch: 0.4, roll: 2.6 } },
  trailerPlainReefer: { label: '冷藏挂车', length: 13.6, width: 2.55, height: 4.0, wheel: 'truck', kingpin: 12.4, axles: TRAILER_AXLES, lamps: TRAILER_LAMPS, posture: { pitch: 0.4, roll: 2.6 } },
  chassis: {
    label: '40 尺集装箱骨架车',
    length: 12.2,
    width: 2.5,
    height: 1.45,
    wheel: 'truck',
    kingpin: 11.2,
    axles: [1.4, 2.6].map((x) => ({ x, r: 0.5, half: 0.9, dual: true })),
    lamps: { tail: [0.02, 0.98, 1.02], back: [0.02, 0.98, 0.66], rearTurn: [0.02, 0.98, 1.18], k: 0.9 },
    posture: { pitch: 0.3, roll: 1.4 },
  },
  chassis20: {
    label: '20 尺集装箱骨架车',
    length: 7.0,
    width: 2.5,
    height: 1.45,
    wheel: 'truck',
    kingpin: 6.2,
    axles: [{ x: 1.4, r: 0.5, half: 0.9, dual: true }],
    lamps: { tail: [0.02, 0.98, 1.02], back: [0.02, 0.98, 0.66], rearTurn: [0.02, 0.98, 1.18], k: 0.9 },
    posture: { pitch: 0.3, roll: 1.4 },
  },
  container: { label: '40 尺集装箱', length: 12.19, width: 2.44, height: 2.59, wheel: 'truck', axles: [], lamps: { k: 1 }, posture: { pitch: 0.3, roll: 1.6 } },
  container20: { label: '20 尺集装箱', length: 6.06, width: 2.44, height: 2.59, wheel: 'truck', axles: [], lamps: { k: 1 }, posture: { pitch: 0.3, roll: 1.6 } },
  // —— 公交、房车、小拖车 ——
  bus: {
    label: '12 米城市公交（低地板）',
    length: 12.0,
    width: 2.55,
    height: 3.2,
    wheel: 'truck',
    axles: [
      { x: 9.4, r: 0.5, half: 1.02, steer: true },
      { x: 2.6, r: 0.5, half: 0.92, dual: true },
    ],
    lamps: { tail: [-0.03, 0.95, 1.06], back: [-0.03, 0.72, 1.02], rearTurn: [-0.03, 1.2, 1.08], frontTurn: [12.02, 1.0, 1.1], head: [12.03, 0.78, 0.9], k: 1 },
    posture: { pitch: 1.0, roll: 3.0 },
  },
  rv: {
    label: 'A 型自行式房车',
    length: 11.2,
    width: 2.55,
    height: 3.75,
    wheel: 'truck',
    hitch: -0.15,
    axles: [
      { x: 9.0, r: 0.5, half: 1.05, steer: true },
      { x: 3.0, r: 0.5, half: 0.98, dual: true },
    ],
    lamps: { tail: [0.02, 1.25, 1.12], back: [0.02, 1.0, 1.12], rearTurn: [0.02, 1.5, 1.12], frontTurn: [11.18, 1.05, 1.1], head: [11.2, 1.05, 0.85], k: 1 },
    posture: { pitch: 1.2, roll: 3.6 },
  },
  camper: { label: '拖挂式房车', length: 9.65, width: 2.44, height: 3.4, wheel: 'car', hitch: 9.65, axles: [3.6, 2.8].map((x) => ({ x, r: 0.36, half: 1.05 })), lamps: { tail: [0.0, 0.9, 1.0], back: [0.0, 0.9, 0.76], rearTurn: [0.0, 0.9, 1.12], k: 0.8 }, posture: { pitch: 0.3, roll: 2.0 } },
  boatTrailer: { label: '船拖车（带快艇）', length: 7.4, width: 2.3, height: 1.35, wheel: 'car', hitch: 7.4, axles: [{ x: 2.4, r: 0.33, half: 0.95 }], lamps: { tail: [0.15, 0.55, 0.62], rearTurn: [0.15, 0.55, 0.72], k: 0.7 }, posture: { pitch: 0.3, roll: 1.8 } },
  utilityTrailer: { label: '小型平板拖车', length: 4.3, width: 2.4, height: 1.5, wheel: 'car', hitch: 4.3, axles: [{ x: 1.3, r: 0.3, half: 1.0 }], lamps: { tail: [0.0, 0.55, 0.85], rearTurn: [0.0, 0.55, 0.95], k: 0.65 }, posture: { pitch: 0.3, roll: 1.6 } },
  // —— 场内牵引车（港口拖车、配送中心的调车车）——
  terminalTractor: {
    label: '港口场内拖车',
    length: 5.5,
    width: 2.6,
    height: 3.2,
    wheel: 'truck',
    kingpin: 1.45,
    axles: [
      { x: 4.2, r: 0.56, half: 1.0, steer: true },
      { x: 1.1, r: 0.56, half: 0.9, dual: true },
    ],
    lamps: { tail: [0.04, 1.1, 1.05], back: [0.04, 0.9, 1.05], rearTurn: [0.04, 1.3, 1.05], frontTurn: [5.5, 1.35, 1.1], head: [5.52, 1.15, 0.85], k: 0.9 },
    posture: { pitch: 0.8, roll: 1.6 },
  },
  yardShunter: {
    label: '配送中心场内牵引车',
    length: 5.2,
    width: 2.5,
    height: 3.1,
    wheel: 'truck',
    kingpin: 1.3,
    axles: [
      { x: 3.85, r: 0.5, half: 0.98, steer: true },
      { x: 0.95, r: 0.5, half: 0.88, dual: true },
    ],
    lamps: { tail: [0.04, 1.05, 1.0], back: [0.04, 0.85, 1.0], rearTurn: [0.04, 1.25, 1.0], frontTurn: [5.2, 1.3, 1.05], head: [5.22, 1.1, 0.82], k: 0.9 },
    posture: { pitch: 0.8, roll: 1.6 },
  },
};

/**
 * 铰接车的尺寸（米，从牵引销量；字段和收货场引擎 yard/index.ts 的 RigDims 一样）：牵引车车头在前 front 处、车尾在后 tractorRear 处，
 * 挂车前端在前 trailerFront 处、车尾在后 rear 处、车轴组中心在后 axle 处；wheelbase 是牵引车前轴到牵引销
 * （运动学按「牵引销 ≈ 牵引车后轴」算；真实的后轴组中心在牵引销后 driveBehind 米）。
 */
export interface RigDimsSpec {
  kind: 'rig';
  tractor: ModelKey;
  trailer: ModelKey;
  front: number;
  tractorRear: number;
  trailerFront: number;
  rear: number;
  axle: number;
  width: number;
  wheelbase: number;
  driveBehind: number;
}

function rig(tractor: ModelKey, trailer: ModelKey): RigDimsSpec {
  const t = MODEL_SPECS[tractor];
  const tr = MODEL_SPECS[trailer];
  const kp = t.kingpin as number;
  const tkp = tr.kingpin as number;
  const steer = t.axles.find((a) => a.steer) as AxleSpec;
  const drives = t.axles.filter((a) => !a.steer);
  const trAx = tr.axles.reduce((s, a) => s + a.x, 0) / Math.max(1, tr.axles.length);
  const dc = drives.reduce((s, a) => s + a.x, 0) / Math.max(1, drives.length);
  return { kind: 'rig', tractor, trailer, front: t.length - kp, tractorRear: kp, trailerFront: tr.length - tkp, rear: tkp, axle: +(tkp - trAx).toFixed(3), width: Math.max(t.width, tr.width), wheelbase: +(steer.x - kp).toFixed(3), driveBehind: +(kp - dc).toFixed(3) };
}

/** 常用的铰接组合：平头牵引车 + 13.6 米厢式 / 冷藏挂车、长头牵引车 + 挂车、日间驾驶室 + 40 / 20 尺骨架车、场内牵引车拖挂车 */
export const RIG_DIMS = {
  semi: rig('tractor', 'trailerPlain'),
  reefer: rig('tractor', 'trailerPlainReefer'),
  longSemi: rig('tractorLong', 'trailerPlain'),
  chassis: rig('tractorDay', 'chassis'),
  chassis20: rig('tractorDay', 'chassis20'),
  terminal: rig('terminalTractor', 'chassis'),
  shunter: rig('yardShunter', 'trailerPlain'),
} as const satisfies Record<string, RigDimsSpec>;

/** 单体车的尺寸（字段和 yard/index.ts 的 BodyDims 一样）：车长、车宽、轴距（前轴到后轴 / 后轴组中心）、后轴到车尾 */
export interface BodyDimsSpec {
  kind: 'body';
  model: ModelKey;
  length: number;
  width: number;
  wheelbase: number;
  rearOverhang: number;
}

export function bodyDims(model: ModelKey): BodyDimsSpec {
  const s = MODEL_SPECS[model];
  const steer = s.axles.find((a) => a.steer);
  const rears = s.axles.filter((a) => !a.steer);
  const rx = rears.length ? rears.reduce((a, b) => a + b.x, 0) / rears.length : 0;
  const kp = s.kingpin;
  // 牵引车不带挂车时按「牵引销 ≈ 后轴」算（和铰接时一致）
  const rear = kp !== undefined ? kp : rx;
  return { kind: 'body', model, length: s.length, width: s.width, wheelbase: +((steer?.x ?? rear) - rear).toFixed(3), rearOverhang: +rear.toFixed(3) };
}

export const BODY_DIMS = {
  truck: bodyDims('evTruck'),
  boxTruck: bodyDims('boxTruck'),
  van: bodyDims('van'),
  bus: bodyDims('bus'),
  rv: bodyDims('rv'),
  tractor: bodyDims('tractor'),
  tractorDay: bodyDims('tractorDay'),
  terminalTractor: bodyDims('terminalTractor'),
  shunter: bodyDims('yardShunter'),
} as const satisfies Record<string, BodyDimsSpec>;

/**
 * 小汽车拖小拖车（房车拖挂、船拖车、平板拖车）：挂钩球头在牵引车辆车尾后 hitchBehind 米，挂钩到拖车车轴 axle 米（决定内轮差），拖车长 length
 */
export const TOW_DIMS = {
  camper: { tow: 'camper' as ModelKey, length: MODEL_SPECS.camper.length, axle: +(9.65 - 3.2).toFixed(2), width: MODEL_SPECS.camper.width },
  boat: { tow: 'boatTrailer' as ModelKey, length: MODEL_SPECS.boatTrailer.length, axle: +(7.4 - 2.4).toFixed(2), width: MODEL_SPECS.boatTrailer.width },
  utility: { tow: 'utilityTrailer' as ModelKey, length: MODEL_SPECS.utilityTrailer.length, axle: +(4.3 - 1.3).toFixed(2), width: MODEL_SPECS.utilityTrailer.width },
} as const;

/** 牵引车辆（SUV、皮卡、房车）的拖钩：车尾后多远（米） */
export const HITCH_BEHIND: Partial<Record<ModelKey, number>> = { suv: 0.05, pickup: 0.3, rv: 0.15 };

/** 场内车速、加减速的参考（米 / 秒、米 / 秒²，真实尺寸）：收货场引擎和姿态都用 */
export const DYNAMICS = {
  car: { accel: 2.2, decel: 3.0, lat: 2.0 },
  van: { accel: 1.4, decel: 2.2, lat: 1.6 },
  truck: { accel: 0.8, decel: 1.6, lat: 1.1 },
} as const;
