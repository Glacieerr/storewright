import * as THREE from 'three';
import { box, merge, type Part } from '../../../../StoreX/web/src/three/models';
import { TraceCursor, type Pose } from '../../../../StoreX/web/src/tracePos';
import type { WSeg, WVehicle } from '../../../src/sim/trace';
import { RAIL, type Km } from '../../../src/region/region';
import { apronTug, containerShip, dolly, freighter, loader, tug } from './craft';
import { AXLES, BUILDS, bodyGeometry, farGeometry, LAMPS, WHEEL_KIND, wheelGeometry, type Axle, type Build, type BuildKey, type LampSpec, type PartSlot, type PartSpec } from './fleet';
import { ensureSurface, MODEL_SPECS, usePaintMask } from './vehicles/index';
import { resample, v3, type V3 } from './geo';
import { buildMotion, DYN, inSpans, legAt, leadState, lineLeg, makeTrack, partPose, pathYaw, roadRuns, shipAt, shipMotion, trackInto, warpAt, warpDelay, yardBlockLegs, type LeadState, type MLeg, type Motion, type PartPose, type RoadRun, type ShipMotion, type ShipPose, type Track, type Warp, type XYZ } from './motion';
import { floatY } from './tide';
import { drain, type Steps } from './ops/kit';
import { siteTimeline, siteVersion } from '@storewright/yard';
import { P, type RoadNet } from './roadnet';
import type { CarTrack, Traffic, TrafficPose } from './traffic';
import { t as tr } from '../i18n';

/**
 * 区域里的车、火车、船和飞机，按仿真轨迹回放：
 * - 公路车辆沿车道走（运动规划见 motion.ts）：从月台开出、过路口和立交、到门店开过头再倒车靠上卸货口；
 *   半挂车的牵引车和挂车分开摆，转弯、倒车时挂车跟着转；起步、刹车、过弯按速度曲线走；
 *   车轮按走过的路程转、前轮跟着弯道打方向（双胎是两只轮胎），刹车灯、转向灯（闪）、倒车灯，夜里亮尾灯和大灯；
 *   车身有姿态：刹车时车头下沉、加速时车尾下坐，转弯时向弯外侧倾（越高、越软的车倾得越多，挂车比牵引车慢半拍）；
 * - 车型是第一部分 Storewright 的放样精模（vehicles/），离镜头近的画精模和单独的车轮，远的画简模（车轮合在车身里）；
 * - 背景车流：轿车、两厢车、SUV、MPV、皮卡、厢式车按常见的车型、颜色分布，过路的车里有平头厢式货车和半挂车
 *   （半挂车的挂车按铰接运动学跟着牵引销走，转弯时切内侧）；
 * - 火车沿三维铁路走：货运是前后两台机车夹着一节节平车，客运是动车组（两头是头车），折返时都不用调头；进站制动、出站加速；
 * - 船沿航线走，本店班轮进港减速、拖轮顶着靠泊，离港先拖离码头、掉头再出港；飞机的位姿由机场作业动画给。
 * 沙盘把距离压缩成 1/10（1 公里画成 100 米），车辆按真实尺寸画；镜头拉远时按距离放大，全景里也看得见。
 * 每种零件、车轮、车灯各一个实例化网格，每帧只改实例矩阵（不新建对象）。
 */
export type VKind = 'truck' | 'reefer' | 'ev' | 'van' | 'drayage' | 'train' | 'ship' | 'plane';
export const VKIND_LABEL: Record<VKind, string> = { truck: tr('常温配送车、长途整车'), reefer: tr('冷藏 / 多温区车'), ev: tr('电动配送车'), van: tr('线上配送车、面包车'), drayage: tr('集装箱拖车'), train: tr('铁路（班列、港口接驳）'), ship: tr('集装箱船'), plane: tr('货运飞机') };
export const VKIND_COLOR: Record<VKind, string> = { truck: '#2a78d6', reefer: '#5fb0e8', ev: '#1baf7a', van: '#9b7bc4', drayage: '#d35400', train: '#6d6b66', ship: '#2c3e50', plane: '#c9c6bc' };

type Legacy = 'loco' | 'wagon' | 'wagonBox' | 'emuCab' | 'emuCoach' | 'ship' | 'shipHull' | 'plane' | 'marker' | 'tug' | 'loader' | 'dolly' | 'apronTug' | 'lamp';
const LEGACY = new Set<string>(['loco', 'wagon', 'wagonBox', 'emuCab', 'emuCoach', 'ship', 'shipHull', 'plane', 'marker', 'tug', 'loader', 'dolly', 'apronTug', 'lamp']);
/** 远处用的简模（车轮合在车身里） */
type FarSlot = `${PartSlot}~far`;
type Slot = PartSlot | FarSlot | Legacy | 'wheel' | 'wheelCar';
/** 近处精模的容量（同一时刻最多画几个）；超出的画简模 */
const NEAR_CAP: Record<PartSlot, number> = {
  car: 500,
  hatch: 420,
  suv: 500,
  mpv: 220,
  pickup: 180,
  van: 160,
  vanOnline: 80,
  vanBakery: 40,
  boxTruck: 90,
  evTruck: 60,
  tractor: 140,
  tractorDay: 60,
  tractorLong: 50,
  trailerDry: 60,
  trailerReefer: 60,
  trailerPlain: 100,
  trailerPlainReefer: 40,
  chassis: 40,
  chassis20: 10,
  container: 40,
  container20: 10,
  bus: 60,
  rv: 10,
  camper: 10,
  boatTrailer: 10,
  utilityTrailer: 10,
  terminalTractor: 10,
  yardShunter: 10,
};
/** 远处简模的容量 */
const FAR_CAP: Record<PartSlot, number> = {
  car: 1500,
  hatch: 1200,
  suv: 1300,
  mpv: 520,
  pickup: 420,
  van: 420,
  vanOnline: 120,
  vanBakery: 60,
  boxTruck: 260,
  evTruck: 80,
  tractor: 300,
  tractorDay: 120,
  tractorLong: 140,
  trailerDry: 120,
  trailerReefer: 120,
  trailerPlain: 280,
  trailerPlainReefer: 120,
  chassis: 80,
  chassis20: 20,
  container: 80,
  container20: 20,
  bus: 90,
  rv: 20,
  camper: 20,
  boatTrailer: 20,
  utilityTrailer: 20,
  terminalTractor: 20,
  yardShunter: 20,
};
const OTHER_CAP: Record<Legacy | 'wheel' | 'wheelCar', number> = {
  loco: 16,
  wagon: 80,
  wagonBox: 80,
  emuCab: 24,
  emuCoach: 60,
  ship: 6,
  shipHull: 2,
  plane: 6,
  marker: 8,
  tug: 12,
  loader: 12,
  dolly: 36,
  apronTug: 12,
  wheel: 7000,
  wheelCar: 9000,
  lamp: 10000,
};
const PART_SLOTS = Object.keys(NEAR_CAP) as PartSlot[];
const SLOTS: Slot[] = [...PART_SLOTS, ...PART_SLOTS.map((p) => `${p}~far` as FarSlot), ...(Object.keys(OTHER_CAP) as (Legacy | 'wheel' | 'wheelCar')[])];
const capOf = (sl: Slot): number => (sl.endsWith('~far') ? FAR_CAP[sl.slice(0, -4) as PartSlot] : ((NEAR_CAP as Record<string, number>)[sl] ?? (OTHER_CAP as Record<string, number>)[sl] ?? 0));
/** 离镜头多远以内画精模（米；车按 scale 放大画时按同样的屏幕大小放远） */
const NEAR_LOD = 180;
const color = (c: string) => new THREE.Color(c);
/** 私家车车身颜色：按常见乘用车的颜色分布抽（白、黑、灰、银占大多数），停车场和路上看起来像真实的车流 */
const CAR_PALETTE: Array<[string, number]> = [
  ['#f4f4f2', 0.24],
  ['#26282b', 0.2],
  ['#7b8188', 0.17],
  ['#bfc4c8', 0.11],
  ['#2f4f7f', 0.09],
  ['#a3262a', 0.08],
  ['#3f5a46', 0.03],
  ['#c9b48f', 0.03],
  ['#d4782f', 0.02],
  ['#5a3b5f', 0.01],
  ['#e0c341', 0.02],
];
const CAR_COLORS = CAR_PALETTE.map(([c]) => color(c));
const CAR_CUM = CAR_PALETTE.reduce<number[]>((a, [, w]) => [...a, (a[a.length - 1] ?? 0) + w], []);
const carColorAt = (u: number): THREE.Color => CAR_COLORS[Math.max(0, CAR_CUM.findIndex((x) => u < x))] as THREE.Color;
/** 货车驾驶室、厢式车的颜色；挂车多数是白色 */
const CAB_COLORS = ['#e9e9e6', '#c0392b', '#2f5d9a', '#3f6e4a', '#5d6168', '#d9d4c7', '#a07a3c', '#2b2f36', '#e0a030', '#e9e9e6'].map(color);
const TRAILER_COLORS = ['#f3f3f0', '#f3f3f0', '#f3f3f0', '#eceae4', '#f3f3f0', '#d9dcdf', '#2f5d9a', '#b8352e', '#f3f3f0', '#3f6e4a'].map(color);
/** 0–1 的确定性随机数（背景车按车的编号定车型、颜色，每次一样） */
function hash01(a: number, b = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 13;
  return ((h >>> 0) % 1000003) / 1000003;
}
/** 公交车按线路配色（背景车流的公交线路，最多 5 条） */
const BUS_COLORS = ['#2a9d8f', '#e9a23b', '#3a86c8', '#c8553d', '#7a5ea8'].map(color);
const CONTAINER_HEX = ['#c0392b', '#2471a3', '#1e8449', '#d35400', '#7d3c98', '#566573', '#a04000', '#2e86c1', '#f0b27a', '#16a085'];
const CONTAINER = CONTAINER_HEX.map(color);
const SUPPLIER_CABS = ['#c0392b', '#e9e9e6', '#3f6e4a', '#5d6168', '#a07a3c', '#2b2f36', '#7d3c98', '#d9d4c7'];
const WHITE = color('#ffffff');
/** 平车上的箱颜色（铁路站给的十六进制）：缓存，每帧不新建 */
const BOX_COLORS = new Map<string, THREE.Color>();
const boxColor = (hex: string): THREE.Color => {
  let c = BOX_COLORS.get(hex);
  if (!c) BOX_COLORS.set(hex, (c = new THREE.Color(hex)));
  return c;
};
/** 集装箱拖车拉的都是本店的箱（蓝色，和港口堆场、铁路站里的本店箱一致） */
const STORE_BLUE = color('#1d6fe0');
/** 车灯：刹车灯、夜里的尾灯、转向灯、倒车灯、大灯（不受光照、不做色调映射，夜里也鲜亮） */
const BRAKE = color('#ff2414');
const TAIL = color('#8a0d08');
const AMBER = color('#ffa21a');
const REVERSE = color('#f4f6ff');
const HEAD = color('#fff1cf');
const WAGONS = 12;
const WAGON_LEN = 15;
/** 动车组：头车 26 米、中间车 25 米、车钩间隙 0.8 米；头车 + 5 节中间车 + 头车 */
const EMU_CARS = 7;
const EMU_CENTERS = Array.from({ length: EMU_CARS }, (_, k) => (k === 0 ? 13 : k === EMU_CARS - 1 ? 13 + 26.6 + (EMU_CARS - 2) * 25.8 : 13 + 26.6 + (k - 1) * 25.8));
const EMU_LEN = (EMU_CENTERS[EMU_CARS - 1] as number) + 13;
/** 货运列车全长：前机车 + 12 节平车 + 后机车（前后对称，第 k 节平车的中心离车头 17 + (k − 1)·15 + 7.5 米） */
export const FREIGHT_LEN = 17 + (WAGONS - 1) * WAGON_LEN + 14 + 18;
/**
 * 背景车流的车型：动力学按车流的类别（0 小型车、1 大一点的乘用车、2 公交、3 平头厢式货车、4 半挂车），
 * 画的车型按车的编号抽：小型车里轿车、两厢车，大一点的里 SUV、MPV、皮卡、高顶厢式车；半挂车里平头卧铺、长头卧铺、日间驾驶室拉集装箱。
 */
interface TrafficLook {
  build: Build;
  paint: THREE.Color;
  trailer: THREE.Color;
}
function trafficLook(kind: number, ci: number, color: number): TrafficLook {
  const h = hash01(ci, 17);
  const paint = carColorAt(hash01(ci, 29));
  switch (kind) {
    case 0:
      return { build: h < 0.55 ? BUILDS.car : BUILDS.hatch, paint, trailer: WHITE };
    case 1:
      return { build: h < 0.52 ? BUILDS.suv : h < 0.7 ? BUILDS.mpv : h < 0.84 ? BUILDS.pickup : BUILDS.van, paint: h >= 0.84 && hash01(ci, 5) < 0.6 ? WHITE : paint, trailer: WHITE };
    case 2:
      return { build: BUILDS.bus, paint: BUS_COLORS[color % BUS_COLORS.length] as THREE.Color, trailer: WHITE };
    case 3:
      return { build: BUILDS.boxTruck, paint: CAB_COLORS[Math.floor(hash01(ci, 7) * CAB_COLORS.length)] as THREE.Color, trailer: WHITE };
    default: {
      const cab = CAB_COLORS[Math.floor(hash01(ci, 7) * CAB_COLORS.length)] as THREE.Color;
      const tr = TRAILER_COLORS[Math.floor(hash01(ci, 11) * TRAILER_COLORS.length)] as THREE.Color;
      const reefer = hash01(ci, 13) < 0.25;
      if (h < 0.55) return { build: reefer ? BUILDS.plainReefer : BUILDS.plainDry, paint: cab, trailer: tr };
      if (h < 0.85) return { build: reefer ? BUILDS.longReefer : BUILDS.longDry, paint: cab, trailer: tr };
      return { build: BUILDS.drayDay, paint: cab, trailer: CONTAINER[Math.floor(hash01(ci, 19) * CONTAINER.length)] as THREE.Color };
    }
  }
}
const GLOW_ATTRS = ['position', 'aColor', 'aSize', 'aBlink'] as const;

/** 给几何体刷顶点颜色 */
function tint(g: THREE.BufferGeometry, c: string): THREE.BufferGeometry {
  const col = new THREE.Color(c);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

const EMU_BODY = '#eef1f3';
const EMU_STRIPE = '#c8102e';
const EMU_GLASS = '#27313b';
/** 动车组中间车（长 25 米，原点在车厢中心、车头朝 +x）：白色车体、深色车窗带、红色腰带、车门、转向架、风挡 */
function emuCoach(): THREE.BufferGeometry {
  const parts: Part[] = [box(24.6, 0.55, 2.7, '#3a3d42', 0, 0.55), box(24.6, 3.0, 3.3, EMU_BODY, 0, 1.1), box(24.2, 0.3, 2.8, '#c9cdd2', 0, 4.1), box(22.8, 0.8, 3.34, EMU_GLASS, 0, 2.6), box(24.62, 0.2, 3.36, EMU_STRIPE, 0, 2.15)];
  for (const x of [-10.2, 10.2]) parts.push(box(1.3, 2.4, 3.38, '#d5d9de', x, 1.2));
  for (const x of [-8.7, 8.7]) parts.push(box(3.0, 0.75, 2.4, '#26282c', x, 0.05));
  for (const x of [-12.55, 12.55]) parts.push(box(0.5, 2.7, 2.3, '#55595f', x, 1.3));
  return merge(parts);
}
/** 动车组头车（长 26 米，流线型车头朝 +x）：侧面轮廓拉成车体，车头往前收窄；前窗、头灯、受电弓 */
function emuCab(): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  sh.moveTo(-13, 1.1);
  sh.lineTo(-13, 4.1);
  sh.lineTo(4.5, 4.1);
  sh.quadraticCurveTo(9.5, 4.0, 11.8, 2.5);
  sh.quadraticCurveTo(13, 1.7, 13, 1.1);
  sh.lineTo(-13, 1.1);
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(sh, { depth: 3.3, bevelEnabled: false, curveSegments: 8 });
  if (g.index) g = g.toNonIndexed();
  g.translate(0, 0, -1.65);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (x > 6) pos.setZ(i, pos.getZ(i) * (1 - 0.38 * ((x - 6) / 7) ** 2));
  }
  tint(g, EMU_BODY);
  const parts: Part[] = [
    g,
    box(17.5, 0.55, 2.7, '#3a3d42', -4.2, 0.55),
    box(17.0, 0.3, 2.8, '#c9cdd2', -4.5, 4.1),
    box(15.6, 0.8, 3.34, EMU_GLASS, -4.6, 2.6),
    box(17.6, 0.2, 3.36, EMU_STRIPE, -4.2, 2.15),
    box(2.7, 0.08, 2.5, EMU_GLASS, 0, -0.04, 0).rotateZ(-0.22).translate(8.8, 3.72, 0),
    box(1.1, 2.4, 3.38, '#d5d9de', -11.2, 1.2),
    box(3.0, 0.75, 2.4, '#26282c', -9.7, 0.05),
    box(3.0, 0.75, 2.4, '#26282c', 7.0, 0.05),
    box(2.2, 0.35, 1.4, '#5a5e64', -6.5, 4.4),
    box(0.5, 2.7, 2.3, '#55595f', -13.05, 1.3),
  ];
  for (const z of [-0.72, 0.72]) parts.push(box(0.2, 0.22, 0.5, '#fff6d8', 12.72, 1.45, z));
  return merge(parts);
}

function legacyGeometry(slot: Legacy): THREE.BufferGeometry {
  switch (slot) {
    case 'loco':
      return merge([box(20, 3.6, 3.0, '#d94f3a', 0, 1.0), box(20.2, 0.6, 3.1, '#2c2c2c', 0, 4.4), box(3.5, 1.2, 2.6, '#26313c', 8.5, 3.3), box(20, 0.9, 2.6, '#333', 0, 0.1)]);
    case 'wagon':
      return merge([box(WAGON_LEN - 1.2, 0.5, 2.6, '#4a4a48', 0, 1.0), box(WAGON_LEN - 1.2, 0.9, 2.2, '#2f2f2f', 0, 0.1)]);
    case 'wagonBox':
      return merge([box(12.2, 2.6, 2.44, '#ffffff', 0, 1.5)]);
    case 'emuCab':
      return emuCab();
    case 'emuCoach':
      return emuCoach();
    case 'ship':
      return containerShip();
    case 'shipHull':
      return containerShip(false);
    case 'plane':
      return planeModel();
    case 'tug':
      return tug();
    case 'loader':
      return loader();
    case 'dolly':
      return dolly();
    case 'apronTug':
      return apronTug();
    case 'lamp':
      return new THREE.BoxGeometry(1, 1, 1);
    case 'marker': {
      // 选中车辆脚下的光圈
      const g = new THREE.RingGeometry(1, 1.35, 40).rotateX(-Math.PI / 2).toNonIndexed();
      return g;
    }
  }
}

/** 飞机模型（机场里停着的客机也用它）：双发宽体货机 */
export function planeModel(): THREE.BufferGeometry {
  return freighter();
}

export interface PickedVehicle {
  v: WVehicle;
  act?: string;
  /** 离镜头多远（和港口、机场里别家的船、飞机比谁在前面） */
  dist?: number;
}

/** 一辆公路车辆：用哪种车型、牵引车 / 集装箱的颜色、运动；零件的网格下标、哪个零件带尾灯 */
interface Road {
  build: Build;
  tint: THREE.Color;
  motion: Motion;
  ix: number[];
  rear: number;
}

/** 一列火车：客运（动车组）还是货运；每段运行的速度曲线（停着的段没有）和沿铁路的起止位置 */
interface Rail {
  pax: boolean;
  runs: ({ leg: MLeg; s0: number; s1: number; D: number } | undefined)[];
}

export interface VehicleContext {
  net: RoadNet;
  /** 仿真的地点 → 三维的停车位（调度台排的月台门、门店卸货口） */
  resolve: (vehicle: number, key: string) => string | undefined;
}

/** 这一帧某辆车的灯：刹车、倒车、转向（−1 左 / 1 右）、夜里行车灯、转向灯闪的相位 */
interface LampState {
  brake: boolean;
  rev: boolean;
  turn: number;
  night: boolean;
  phase: number;
}

export class Vehicles {
  readonly group = new THREE.Group();
  private meshes = new Map<Slot, THREE.InstancedMesh>();
  private mesh: THREE.InstancedMesh[] = [];
  private own: Int32Array[] = [];
  private count: Int32Array;
  private ix = new Map<Slot, number>();
  private readonly W: number;
  private readonly WC: number;
  private readonly LAMP: number;
  private readonly MARKER: number;
  private readonly blink: THREE.InstancedBufferAttribute;
  /** 转向灯闪烁的时钟（秒，真实时间）：着色器里按它闪，暂停播放时也在闪 */
  private readonly clock = { value: 0 };
  /** 夜里车灯的光晕：一个加色混合的点云（每盏亮着的灯一个点，大小按距离缩放，远处至少 2 像素） */
  private readonly glow: THREE.Points;
  private readonly gPos: Float32Array;
  private readonly gCol: Float32Array;
  private readonly gSize: Float32Array;
  private readonly gBlink: Float32Array;
  private nGlow = 0;
  private glowOn = false;
  private list: WVehicle[] = [];
  private shift: { delays: (Float32Array | undefined)[]; ends: number[] } | undefined;
  private cursor = new TraceCursor([], () => true);
  private roads: (Road | undefined)[] = [];
  private seas: (ShipMotion | undefined)[] = [];
  private rails: (Rail | undefined)[] = [];
  private poses: (Pose | undefined)[] = [];
  private poseBuf: (Pose | undefined)[] = [];
  private rail: Track;
  private readonly m = new THREE.Matrix4();
  /** 带姿态的车身矩阵（车灯跟着车身）、车灯用的矩阵、姿态的临时量 */
  private readonly mb = new THREE.Matrix4();
  private lampM = this.m;
  private readonly mt = new THREE.Matrix4();
  private readonly mr = new THREE.Matrix4();
  private readonly ep = new THREE.Euler(0, 0, 0, 'ZYX');
  /** 这一帧按哪些镜头分远近 */
  private eyesNow: readonly XYZ[] = [];
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YZX');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly pp: PartPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private readonly ls: LeadState = { u: 0, v: 0, a: 0 };
  private readonly pa: XYZ = { x: 0, y: 0, z: 0 };
  private readonly pb: XYZ = { x: 0, y: 0, z: 0 };
  private readonly lamp: LampState = { brake: false, rev: false, turn: 0, night: false, phase: 0 };
  private readonly sp: ShipPose = { x: 0, z: 0, dir: 0, moving: false, act: undefined, tug: '', side: 1, turn: 0 };
  /** 不显示的种类（图例开关） */
  hidden = new Set<string>();
  /** 背景车流 */
  traffic = true;
  /** 选中的车辆（脚下画光圈） */
  selected: number[] = [];
  private trafficSim: Traffic | undefined;
  private readonly tp: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
  private readonly tq: TrafficPose = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
  private readonly kx = new Float64Array(RIG_SAMPLES + 1);
  private readonly kz = new Float64Array(RIG_SAMPLES + 1);
  /** 飞机的位姿由机场作业动画给（精细的进近、滑行、推出、起飞；y 是离道面的高度，parked = 停在机位上），这里只记位置给拾取、跟随和实时跟踪 */
  planePose: ((vid: number, t: number) => { x: number; y: number; z: number; yaw: number; act: string; parked: boolean; roll?: number } | undefined) | undefined;
  /** 车上此刻有几个箱（火车在港口装箱、在货运站卸箱时一个个变；集装箱拖车装箱前是空车）；不给就按标签 */
  cargo: ((v: WVehicle, t: number) => number | undefined) | undefined;
  /** 列车第 k 节平车上的箱颜色（铁路站的龙门吊给；本店的箱是蓝色） */
  trainBoxColor: ((v: WVehicle, k: number) => string | undefined) | undefined;

  constructor() {
    this.group.name = 'vehicles';
    // 车辆共用一个材质：车漆乘实例颜色（车窗、灯、轮胎不跟着变色），粗糙度按顶点（玻璃、车漆亮，轮胎哑）
    const mat = usePaintMask(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 }));
    const markerMat = new THREE.MeshBasicMaterial({ color: '#ffb000', transparent: true, opacity: 0.9, depthWrite: false });
    // 车灯：不受光照、不做色调映射；转向灯（aBlink > 0）按真实时间在着色器里闪，各车的相位不同
    const lampMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
    lampMat.onBeforeCompile = (sh) => {
      sh.uniforms.uClock = this.clock;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aBlink;\nvarying float vBlink;').replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBlink = aBlink;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uClock;\nvarying float vBlink;')
        .replace('void main() {', 'void main() {\n  if (vBlink > 0.5 && fract(uClock * 1.5 + vBlink) > 0.55) discard;');
    };
    this.count = new Int32Array(SLOTS.length);
    SLOTS.forEach((slot, k) => {
      const cap = capOf(slot);
      const geo = LEGACY.has(slot) ? legacyGeometry(slot as Legacy) : slot === 'wheel' ? wheelGeometry('truck') : slot === 'wheelCar' ? wheelGeometry('car') : slot.endsWith('~far') ? farGeometry(slot.slice(0, -4) as PartSlot) : bodyGeometry(slot as PartSlot);
      if (slot !== 'marker' && slot !== 'lamp') ensureSurface(geo);
      const mesh = new THREE.InstancedMesh(geo, slot === 'marker' ? markerMat : slot === 'lamp' ? lampMat : mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      // 车轮、车灯、光圈不投影（车身的影子已经盖住）
      mesh.castShadow = slot !== 'marker' && slot !== 'lamp' && slot !== 'wheel' && slot !== 'wheelCar';
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.name = slot;
      if (slot === 'marker') mesh.renderOrder = 2;
      this.meshes.set(slot, mesh);
      this.mesh.push(mesh);
      this.own.push(new Int32Array(cap));
      this.ix.set(slot, k);
      this.group.add(mesh);
    });
    this.W = this.ix.get('wheel') as number;
    this.WC = this.ix.get('wheelCar') as number;
    this.LAMP = this.ix.get('lamp') as number;
    this.MARKER = this.ix.get('marker') as number;
    const lampMesh = this.mesh[this.LAMP] as THREE.InstancedMesh;
    this.blink = new THREE.InstancedBufferAttribute(new Float32Array(OTHER_CAP.lamp), 1);
    this.blink.setUsage(THREE.DynamicDrawUsage);
    lampMesh.geometry.setAttribute('aBlink', this.blink);
    lampMesh.onBeforeRender = () => {
      this.clock.value = performance.now() / 1000;
    };
    const G = OTHER_CAP.lamp;
    this.gPos = new Float32Array(G * 3);
    this.gCol = new Float32Array(G * 3);
    this.gSize = new Float32Array(G);
    this.gBlink = new Float32Array(G);
    const gg = new THREE.BufferGeometry();
    for (const [name, arr, k] of [['position', this.gPos, 3], ['aColor', this.gCol, 3], ['aSize', this.gSize, 1], ['aBlink', this.gBlink, 1]] as const) gg.setAttribute(name, new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage));
    gg.setDrawRange(0, 0);
    const px = { value: 400 };
    const glowMat = new THREE.ShaderMaterial({
      uniforms: { uClock: this.clock, uPx: px },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor;
attribute float aSize;
attribute float aBlink;
uniform float uClock;
uniform float uPx;
varying vec3 vColor;
void main() {
  vColor = (aBlink > 0.5 && fract(uClock * 1.5 + aBlink) > 0.55) ? vec3(0.0) : aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // 往镜头挪一点：贴着车身的灯，光晕不被自己的车身挡掉半边
  mv.xyz += normalize(-mv.xyz) * aSize * 0.5;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uPx / max(1.0, -mv.z), 2.0, 96.0);
  #include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * max(0.0, exp(-r2 * 3.5) - 0.03), 1.0);
  #include <colorspace_fragment>
}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Points(gg, glowMat);
    this.glow.name = 'lamp-glow';
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 3;
    const vp = new THREE.Vector4();
    this.glow.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getCurrentViewport(vp);
      px.value = (vp.w / 2) * ((camera as THREE.PerspectiveCamera).projectionMatrix.elements[5] ?? 1);
    };
    this.group.add(this.glow);
    this.rail = makeTrack(resample(RAIL.map(P), 6));
  }

  /**
   * 以前在这里换上 Blender 生成的零件（fleet.glb）。现在的公路车辆是放样的精模（vehicles/，比那份模型细），
   * 不再替换；留着这个入口，调用的地方不用改。
   */
  useAssets(geos: ReadonlyMap<string, THREE.BufferGeometry>): void {
    void geos;
  }

  /** 镜头位置（远近分级用）：主画面的镜头在 view.ts 里设一次；监控画面、对比回放各按各的（update 的 eyes） */
  static defaultEyes: readonly XYZ[] = [];

  /** 社会车流（事先算好一整天） */
  setTraffic(tr: Traffic): void {
    this.trafficSim = tr;
  }

  get items(): readonly WVehicle[] {
    return this.list;
  }

  /**
   * 闭环孪生的现场：每辆车（按下标）每分钟晚了多少秒、几点收车。车按「计划时刻 = 现在 − 延误」的位置画，
   * 所以抛锚、等门、堵车的车在三维里真的停着、落在后面（亮着刹车灯）；收车以后不画。不给就按计划画。
   */
  setTimeShift(s?: { delays: (Float32Array | undefined)[]; ends: number[] }): void {
    this.shift = s;
  }

  /** 公路车辆在路上的每一段行驶（现场视图按延误平移）：社会车流的后台线程把它们当成不让人的车，背景车跟在后面、不和它抢 */
  truckRuns(): RoadRun[] {
    return this.roads.flatMap((rd, i) => (rd ? roadRuns(rd.motion, this.shift?.delays[i], this.shift?.ends[i], this.warps[i]) : []));
  }

  /** 第 i 辆车此刻对应的计划时刻（undefined = 已经收车）：现场视图里车按延误平移，设施作业（月台门、叉车）跟着车走 */
  planT(i: number, t: number): number | undefined {
    const tp = this.fieldT(i, t);
    if (tp === undefined) return undefined;
    // 车队间距：画面上晚一点走（停着的时候插进去、补回来）；刚换上新的间距时开着的车先照旧，到下一次停下再换
    const h = this.holds[i];
    if (h && tp < h.until) return tp - h.d;
    const w = this.warps[i];
    return w ? warpAt(w, tp) : tp;
  }
  /** 现场视图的延误平移以后的计划时刻（没有现场视图时就是 t） */
  private fieldT(i: number, t: number): number | undefined {
    const s = this.shift;
    if (!s) return t;
    const end = s.ends[i];
    if (end !== undefined && t > end) return undefined;
    const d = s.delays[i];
    if (!d || !d.length) return t;
    const m = Math.max(0, Math.min(d.length - 1, Math.floor(t / 60)));
    let v = d[m] as number;
    if (!Number.isFinite(v)) {
      // 还没出发：按出发那一刻的延误（发车晚了的车晚出现）；收车以后不会走到这里
      let k = m;
      while (k < d.length && !Number.isFinite(d[k] as number)) k++;
      v = k < d.length ? (d[k] as number) : 0;
    }
    return t - v;
  }

  /** 车队间距的时刻折线（每辆车；undefined = 照仿真的时刻走）、刚换上时开着的车先照旧的晚点、算的时候各个场地的版本 */
  private warps: (Warp | undefined)[] = [];
  private holds: ({ until: number; d: number } | undefined)[] = [];
  private convoyVer = new Map<string, number>();
  /** 每辆车停着时往后让的几次（planStands） */
  private backs: (Back[] | undefined)[] = [];

  /** 第 i 辆车此刻（显示时刻 t、这一段 leg 上车头在 u）该往后让多少米：开过来时按离停车点的距离慢慢让，停着时按前面的车走没走，开走时（同一段里）再慢慢补上 */
  private backOff(i: number, leg: MLeg, u: number, t: number): number {
    const list = this.backs[i];
    if (!list || leg.rev || leg.ys) return 0;
    // 停着：按停着时的退让；开过来、开走（同一条路径上）：取前后两次停的慢慢让里大的（两段挨着时也连得上）
    let off = 0;
    for (const b of list) {
      if (b.track !== leg.track) continue;
      if (t >= b.ts && t <= b.te) return backAt(b, t);
      if (t < b.ts && u >= b.u - b.D && u <= b.u + 0.01) off = Math.max(off, (backAt(b, b.ts) * (u - (b.u - b.D))) / b.D);
      if (t > b.te && b.inLeg && u >= b.u - 0.01 && u <= b.u + b.D) off = Math.max(off, backAt(b, b.te) * (1 - (u - b.u) / b.D));
    }
    return off;
  }

  /**
   * 车队间距：先把每辆车的收货场停靠都按最终的排程排好（一辆一段），再按 planConvoy 排每辆车画面上的晚点（一段），
   * 换上。at() 是此刻的显示时刻：这一刻开着、晚点要变的车先照旧，到下一次停下再换（不在路上跳）。
   * Convoy spacing: resolve all yard stops (one vehicle per step), then plan and install the display warps.
   */
  *convoySteps(at: () => number): Steps {
    const roads = this.roads;
    const ver = new Map<string, number>();
    for (const rd of roads) {
      const yards = rd?.motion.yards;
      if (!yards) continue;
      for (const yb of yards) yardBlockLegs(rd.motion, yb);
      yield;
      if (this.roads !== roads) return;
    }
    for (const rd of roads) for (const yb of rd?.motion.yards ?? []) ver.set(yb.key, siteVersion(yb.key));
    const warps = planConvoy(this.list, roads.map((rd) => rd?.motion));
    yield;
    if (this.roads !== roads) return;
    const backs = planStands(roads.map((rd) => (rd ? { motion: rd.motion, L: rd.build.L } : undefined)), warps);
    const t = at();
    const holds = roads.map((rd, i) => (rd ? holdFor(rd.motion, this.warps[i], warps[i], t) : undefined));
    this.warps = warps;
    this.holds = holds;
    this.backs = backs;
    this.convoyVer = ver;
  }
  /** 算车队间距以后收货场的排程又变了（调度台改了预约）：要重算 */
  convoyStale(): boolean {
    for (const [k, v] of this.convoyVer) if (siteVersion(k) !== v) return true;
    return false;
  }

  /** 公路车辆的运动规划还在分段排（view.ts 换一天的车时）：排完以前公路车辆先不画、没有姿态 */
  pending = false;

  setVehicles(list: WVehicle[], ctx?: VehicleContext): void {
    drain(this.planSteps(list, ctx));
  }

  /**
   * 和 setVehicles 一样，只是公路车辆的运动规划一辆一辆地排（每排完一辆可以让出主线程）：先后和一口气排完时一样，结果也一样。
   * 车辆清单、船和火车的运动（不碰场地登记）在调用时就换好；返回的分段排公路车辆，排完以前 pending = true。
   * Same as setVehicles, but road vehicles are planned one per step (same order, same result).
   */
  planSteps(list: WVehicle[], ctx?: VehicleContext): Steps {
    this.list = list;
    this.cursor = new TraceCursor(list, () => true);
    this.poses = new Array(list.length);
    this.poseBuf = new Array(list.length);
    this.roads = new Array<Road | undefined>(list.length).fill(undefined);
    this.warps = [];
    this.holds = [];
    this.backs = [];
    this.convoyVer = new Map();
    this.seas = list.map((v) => (v.kind === 'ship' ? shipMotion(v) : undefined));
    this.rails = list.map((v) => (v.kind === 'train' ? this.railOf(v) : undefined));
    this.pending = !!ctx && list.length > 0;
    return this.roadSteps(list, this.roads, ctx);
  }
  private *roadSteps(list: WVehicle[], roads: (Road | undefined)[], ctx?: VehicleContext): Steps {
    if (!ctx) return;
    try {
      for (let i = 0; i < list.length; i++) {
        roads[i] = this.roadOf(list[i] as WVehicle, ctx);
        yield;
      }
    } finally {
      // 又换了一天（新的清单）时不动新的那份的标记
      if (this.roads === roads) this.pending = false;
    }
  }

  /** 公路车辆：车型、颜色、运动规划（重型、中型、轻型车的加减速不一样） */
  private roadOf(v: WVehicle, ctx: VehicleContext): Road | undefined {
    const key = buildKey(v);
    if (!key) return undefined;
    const build = BUILDS[key];
    const tint = new THREE.Color(cabColor(v, key));
    const loopTo = (store: string, k: number) => {
      const node = [...ctx.net.edgeArcs.keys()].find((x) => x.startsWith(`${store}|`))?.split('|')[1];
      if (!node) return undefined;
      const nb = [...ctx.net.edgeArcs.keys()].filter((x) => x.startsWith(`${node}|`)).map((x) => x.split('|')[1] as string).filter((x) => !/^S\d\d$/.test(x));
      return nb.length ? nb[k % nb.length] : node;
    };
    const dyn = key === 'ev' ? DYN.medium : key === 'vanOnline' || key === 'vanBakery' ? DYN.light : DYN.heavy;
    const motion = buildMotion(v, ctx.net, { L: build.L, resolve: (key) => ctx.resolve(v.id, key), yard: v.id, lane: 0, loopTo, dyn });
    let rear = 0;
    build.parts.forEach((p, k) => {
      if (LAMPS[p.slot]?.tail) rear = k;
    });
    return { build, tint, motion, ix: build.parts.map((p) => this.ix.get(p.slot) as number), rear };
  }

  /**
   * 列车每段运行的速度曲线：车头从起点开到终点（起点那头留出整列车长），进站停车的一头制动到 0、
   * 出站的一头从 0 加速；开进 / 开出区域（铁路的东头）的一头带着速度。客运动车组加减速快一些。
   */
  private railOf(v: WVehicle): Rail {
    const pax = /客运/.test(v.label);
    const len = pax ? EMU_LEN : FREIGHT_LEN;
    const segs = v.segs;
    const still = (sg: WSeg | undefined) => !!sg && sg.pts.length <= 2;
    const runs = segs.map((sg, j) => {
      if (sg.pts.length <= 2) return undefined;
      const s0 = this.railS(sg.pts[0] as number, sg.pts[1] as number);
      const s1 = this.railS(sg.pts[sg.pts.length - 2] as number, sg.pts[sg.pts.length - 1] as number);
      const D = Math.max(1, Math.abs(s1 - s0) - len);
      // 港口铁路站是线路的尽头（铁路折线的起点），在那里起停；东头出区域
      const stop0 = still(segs[j - 1]) || s0 < 60;
      const stop1 = still(segs[j + 1]) || s1 < 60;
      const leg = pax ? lineLeg(D, sg.t0, sg.t1, !stop0, !stop1, 0.05, 0.06) : lineLeg(D, sg.t0, sg.t1, !stop0, !stop1, 0.007, 0.02);
      return { leg, s0, s1, D };
    });
    return { pax, runs };
  }

  // —— 实例：每种网格一个计数，每帧从 0 开始填 ——

  private begin(): void {
    this.count.fill(0);
  }

  /** 占一个实例（满了返回 −1），记下是哪辆车的（拾取用） */
  private alloc(k: number, owner: number): number {
    const n = this.count[k] as number;
    if (n >= (this.own[k] as Int32Array).length) return -1;
    this.count[k] = n + 1;
    (this.own[k] as Int32Array)[n] = owner;
    return n;
  }

  private setColor(k: number, n: number, c: THREE.Color): void {
    const a = (this.mesh[k] as THREE.InstancedMesh).instanceColor?.array as Float32Array;
    a[n * 3] = c.r;
    a[n * 3 + 1] = c.g;
    a[n * 3 + 2] = c.b;
  }

  /** 放一个实例：位置、绕 y 的朝向、俯仰、均匀缩放（矩阵留在 this.m，车轮、车灯接着用） */
  private put(k: number, owner: number, x: number, y: number, z: number, yaw: number, pitch: number, sc: number, c: THREE.Color = WHITE): number {
    this.e.set(0, yaw, pitch);
    this.q.setFromEuler(this.e);
    this.p.set(x, y, z);
    this.s.setScalar(sc);
    this.m.compose(this.p, this.q, this.s);
    const n = this.alloc(k, owner);
    if (n < 0) return -1;
    this.m.toArray((this.mesh[k] as THREE.InstancedMesh).instanceMatrix.array as Float32Array, n * 16);
    this.setColor(k, n, c);
    return n;
  }

  /**
   * 放一个车身零件：底座矩阵（位置、朝向、路面坡度、缩放）留在 this.m（车轮贴着地面，用它），车身再按姿态转一下——
   * 俯仰 dp（绕横轴，车头向上为正）、侧倾 dr（绕纵轴，车顶向右为正），转轴在零件中点 cx 的地面上——矩阵留在 this.mb（车灯跟着车身）。
   */
  private putBody(k: number, owner: number, x: number, y: number, z: number, yaw: number, pitch: number, sc: number, c: THREE.Color, dp: number, dr: number, cx: number): number {
    this.e.set(0, yaw, pitch);
    this.q.setFromEuler(this.e);
    this.p.set(x, y, z);
    this.s.setScalar(sc);
    this.m.compose(this.p, this.q, this.s);
    this.mb.copy(this.m);
    if (dp || dr) {
      this.ep.set(dr, 0, dp);
      this.mr.makeRotationFromEuler(this.ep);
      this.mb.multiply(this.mt.makeTranslation(cx, 0, 0)).multiply(this.mr).multiply(this.mt.makeTranslation(-cx, 0, 0));
    }
    this.lampM = this.mb;
    const n = this.alloc(k, owner);
    if (n < 0) return -1;
    this.mb.toArray((this.mesh[k] as THREE.InstancedMesh).instanceMatrix.array as Float32Array, n * 16);
    this.setColor(k, n, c);
    return n;
  }

  /** 车身零件：近处画精模（超出容量就画简模），返回画的是不是精模（没画上返回 undefined） */
  private body(slot: PartSlot, near: boolean, owner: number, x: number, y: number, z: number, yaw: number, pitch: number, sc: number, c: THREE.Color, dp: number, dr: number): boolean | undefined {
    const cx = MODEL_SPECS[slot].length / 2;
    if (near && this.putBody(this.ix.get(slot) as number, owner, x, y, z, yaw, pitch, sc, c, dp, dr, cx) >= 0) return true;
    return this.putBody(this.ix.get(`${slot}~far`) as number, owner, x, y, z, yaw, pitch, sc, c, dp, dr, cx) >= 0 ? false : undefined;
  }

  /** 离哪个镜头近（远近分级）：车按 sc 放大画时，同样的屏幕大小离得更远 */
  private nearAt(x: number, y: number, z: number, sc: number): boolean {
    const lim = NEAR_LOD * Math.max(1, sc);
    const l2 = lim * lim;
    for (const e of this.eyesNow) {
      const dx = e.x - x;
      const dy = e.y - y;
      const dz = e.z - z;
      if (dx * dx + dy * dy + dz * dz < l2) return true;
    }
    return false;
  }

  /**
   * 挂在零件上的实例（e 是零件的矩阵）：局部的三个轴向量 c0、c1、c2（已含缩放）和原点 (tx, ty, tz)。
   * 车灯是轴对齐的小方块，车轮带转向和滚动的旋转。
   */
  private putLocal(k: number, owner: number, e: ArrayLike<number>, c00: number, c01: number, c02: number, c10: number, c11: number, c12: number, c20: number, c21: number, c22: number, tx: number, ty: number, tz: number, c: THREE.Color): number {
    const n = this.alloc(k, owner);
    if (n < 0) return -1;
    const a = (this.mesh[k] as THREE.InstancedMesh).instanceMatrix.array as Float32Array;
    const o = n * 16;
    for (let r = 0; r < 3; r++) {
      const m0 = e[r] as number;
      const m1 = e[4 + r] as number;
      const m2 = e[8 + r] as number;
      a[o + r] = m0 * c00 + m1 * c01 + m2 * c02;
      a[o + 4 + r] = m0 * c10 + m1 * c11 + m2 * c12;
      a[o + 8 + r] = m0 * c20 + m1 * c21 + m2 * c22;
      a[o + 12 + r] = m0 * tx + m1 * ty + m2 * tz + (e[12 + r] as number);
    }
    a[o + 3] = 0;
    a[o + 7] = 0;
    a[o + 11] = 0;
    a[o + 15] = 1;
    this.setColor(k, n, c);
    return n;
  }

  /**
   * 一盏灯（零件坐标 x, y, z 的中心，大小 sx × sy × sz），blink > 0 时闪（小数部分是相位）；
   * 夜里再加一个光晕（glow：光晕直径，米，按零件的缩放放大；亮度跟着灯色）。
   */
  private lampAt(owner: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, c: THREE.Color, blink: number, glow: number, gain = 1): void {
    const e = this.lampM.elements;
    const n = this.putLocal(this.LAMP, owner, e, sx, 0, 0, 0, sy, 0, 0, 0, sz, x, y, z, c);
    if (n < 0) return;
    (this.blink.array as Float32Array)[n] = blink;
    if (!this.glowOn || this.nGlow >= this.gSize.length) return;
    const g = this.nGlow++;
    const a = this.gPos;
    for (let r = 0; r < 3; r++) a[g * 3 + r] = (e[r] as number) * x + (e[4 + r] as number) * y + (e[8 + r] as number) * z + (e[12 + r] as number);
    this.gCol[g * 3] = c.r * gain;
    this.gCol[g * 3 + 1] = c.g * gain;
    this.gCol[g * 3 + 2] = c.b * gain;
    this.gSize[g] = glow * Math.hypot(e[0] as number, e[1] as number, e[2] as number);
    this.gBlink[g] = blink;
  }

  /** 左右一对灯 */
  private lampPair(owner: number, at: readonly [number, number, number], sx: number, sy: number, sz: number, c: THREE.Color, glow: number, gain = 1): void {
    this.lampAt(owner, at[0], at[1], at[2], sx, sy, sz, c, 0, glow, gain);
    this.lampAt(owner, at[0], at[1], -at[2], sx, sy, sz, c, 0, glow, gain);
  }

  /** 零件上的灯：尾灯 / 刹车灯、倒车灯、转向灯（转弯那一侧，闪）、夜里的大灯 */
  private lampsOf(owner: number, spec: LampSpec, front: boolean, rear: boolean, st: LampState): void {
    // 灯比真实的稍大一点（沙盘里远看也认得出），夜里加光晕
    const k = spec.k * 1.3;
    if (rear && spec.tail) {
      if (st.brake) this.lampPair(owner, spec.tail, 0.14 * k, 0.24 * k, 0.44 * k, BRAKE, 2.6 * k);
      else if (st.night) this.lampPair(owner, spec.tail, 0.1 * k, 0.2 * k, 0.38 * k, TAIL, 1.7 * k);
    }
    if (rear && st.rev && spec.back) this.lampPair(owner, spec.back, 0.12 * k, 0.2 * k, 0.3 * k, REVERSE, 2 * k, 0.6);
    if (st.turn) {
      const side = st.turn > 0 ? 1 : -1;
      const r = spec.rearTurn;
      const f = spec.frontTurn;
      if (rear && r) this.lampAt(owner, r[0], r[1], r[2] * side, 0.14 * k, 0.2 * k, 0.32 * k, AMBER, 1 + st.phase, 2.2 * k);
      if (front && f) this.lampAt(owner, f[0], f[1], f[2] * side, 0.14 * k, 0.2 * k, 0.32 * k, AMBER, 1 + st.phase, 2.2 * k);
    }
    if (front && st.night && spec.head) this.lampPair(owner, spec.head, 0.12 * k, 0.22 * k, 0.46 * k, HEAD, 2.4 * k, 0.55);
  }

  /**
   * 一根车轴的车轮：转向角 steer（绕竖轴）、滚过的角度 roll（绕车轴，往前滚是负的）；wk 是用哪种车轮（乘用车的五辐、货车的钢圈）。
   * 双胎每边两只轮胎（内外各一只）。车轮跟着底座矩阵 this.m（贴着地面，不跟车身的姿态一起歪）。
   */
  private axleAt(owner: number, ax: Axle, steer: number, roll: number, wk: number): void {
    const cs = Math.cos(steer);
    const ss = Math.sin(steer);
    const cr = Math.cos(-roll);
    const sr = Math.sin(-roll);
    const r = ax.r;
    const w = ax.dual ? 0.27 : wk === this.WC ? 0.22 : 0.3;
    // R = Ry(steer) · Rz(−roll)，再按 (r, r, w) 缩放
    const c00 = cs * cr * r;
    const c01 = sr * r;
    const c02 = -ss * cr * r;
    const c10 = -cs * sr * r;
    const c11 = cr * r;
    const c12 = ss * sr * r;
    const c20 = ss * w;
    const c22 = cs * w;
    const e = this.m.elements;
    for (let side = -1; side <= 1; side += 2) {
      if (ax.dual) for (const off of DUAL_OFF) this.putLocal(wk, owner, e, c00, c01, c02, c10, c11, c12, c20, 0, c22, ax.x, r, side * (ax.half + off), WHITE);
      else this.putLocal(wk, owner, e, c00, c01, c02, c10, c11, c12, c20, 0, c22, ax.x, r, side * ax.half, WHITE);
    }
  }

  /**
   * 更新到时刻 t（当天 0 点起的秒）。scale：镜头远时车辆放大的倍数；eyes：按哪些镜头分远近（不给就用主画面的镜头）。
   */
  update(t: number, scale: number, eyes?: readonly XYZ[]): void {
    this.begin();
    this.eyesNow = eyes ?? Vehicles.defaultEyes;
    const road = Math.min(7, Math.max(1, scale));
    const night = isNight(t);
    this.glowOn = night;
    this.nGlow = 0;
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i] as WVehicle;
      const rd = this.roads[i];
      if (this.pending && (rd || buildKey(v))) {
        // 运动规划还没排完：公路车辆先不画（排完一起出现，不会从仿真折线上跳到道路上）
        this.poses[i] = undefined;
        continue;
      }
      if (rd) {
        this.drawRoad(i, v, rd, t, road, night);
        continue;
      }
      const sea = this.seas[i];
      if (sea) {
        this.drawSea(i, v, sea, t);
        continue;
      }
      const pose = this.cursor.pose(i, t);
      this.poses[i] = pose;
      if (!pose || this.hidden.has(v.kind)) continue;
      if (v.kind === 'train') {
        this.train(i, v, t, Math.min(2, Math.max(1, scale / 3)));
        continue;
      }
      if (v.kind === 'ship') {
        this.put(this.ix.get('ship') as number, i, pose.x, floatY(t), pose.y, -pose.dir, 0, 1);
        continue;
      }
      if (v.kind === 'plane' && this.planePose) {
        const pp = this.planePose(v.id, t);
        this.poses[i] = pp ? { x: pp.x, y: pp.z, dir: -pp.yaw, moving: !pp.parked, busy: true, act: pp.act } : undefined;
        continue;
      }
      if (v.kind === 'plane') {
        const sc = Math.min(2.5, Math.max(1, scale / 2.5));
        this.put(this.ix.get('plane') as number, i, pose.x, altitude(v, t), pose.y, -pose.dir, 0, sc);
        // 卸货时：升降平台车靠在左侧的货舱门，拖车拉着一串板车等在旁边
        if (pose.act === '卸货' && sc < 1.5) {
          const yaw = -pose.dir;
          const c = Math.cos(yaw);
          const sn = Math.sin(yaw);
          const at = (lx: number, lz: number) => [pose.x + lx * c + lz * sn, pose.y - lx * sn + lz * c] as const;
          const [lx0, lz0] = at(-12, -8.5);
          this.put(this.ix.get('loader') as number, i, lx0, 0, lz0, yaw + Math.PI / 2, 0, 1);
          for (let k = 0; k < 3; k++) {
            const [dx, dz] = at(-18 - k * 4.2, -15);
            this.put(this.ix.get('dolly') as number, i, dx, 0, dz, yaw, 0, 1);
          }
          const [tx, tz] = at(-13, -15);
          this.put(this.ix.get('apronTug') as number, i, tx, 0, tz, yaw, 0, 1);
        }
      }
    }
    // 社会车流：各种乘用车、公交车、过路的货车和半挂车（起步、刹车平稳；刹车、排队时亮刹车灯，转弯打灯，夜里开灯）
    if (this.traffic && this.trafficSim) {
      const tr = this.trafficSim;
      const sc = Math.min(6, Math.max(1, scale * 0.85));
      for (const ci of tr.activeAt(t)) {
        const c = tr.cars[ci];
        if (c) this.drawTraffic(tr, c, ci, t, sc, night);
      }
    }
    // 选中车辆脚下的光圈
    for (const id of this.selected) {
      const p = this.poses[id];
      if (!p) continue;
      const big = this.list[id]?.kind === 'ship' ? 60 : this.list[id]?.kind === 'plane' ? 40 : this.list[id]?.kind === 'train' ? 30 : 14;
      this.put(this.MARKER, id, p.x, 0.6, p.y, 0, 0, big * Math.max(1, scale * 0.6));
    }
    this.mesh.forEach((mesh, k) => {
      const n = this.count[k] as number;
      mesh.count = n;
      // 这一帧没有的网格不画（近处精模、远处简模各一个网格，大多数时候只有一部分在用）
      mesh.visible = n > 0;
      // 只上传这一帧用到的实例
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.addUpdateRange(0, Math.max(1, n) * 3);
        mesh.instanceColor.needsUpdate = true;
      }
      mesh.boundingSphere = null;
    });
    const nl = this.count[this.LAMP] as number;
    this.blink.clearUpdateRanges();
    this.blink.addUpdateRange(0, Math.max(1, nl));
    this.blink.needsUpdate = true;
    const gg = this.glow.geometry;
    gg.setDrawRange(0, this.nGlow);
    this.glow.visible = this.nGlow > 0;
    for (const name of GLOW_ATTRS) {
      const at = gg.getAttribute(name) as THREE.BufferAttribute;
      at.clearUpdateRanges();
      at.addUpdateRange(0, Math.max(1, this.nGlow) * at.itemSize);
      at.needsUpdate = true;
    }
  }

  /** 一辆公路车辆：零件沿路径摆、车身姿态、车轮转 / 打方向、车灯；离镜头近的画精模和单独的车轮，远的画简模 */
  private drawRoad(i: number, v: WVehicle, rd: Road, t: number, sc: number, night: boolean): void {
    const tt = this.planT(i, t);
    const leg = tt === undefined ? undefined : legAt(rd.motion, tt);
    if (!leg || tt === undefined || leg.hidden) {
      this.poses[i] = undefined;
      return;
    }
    const st = leadState(leg, tt, this.ls);
    // 和别的车停在同一个地方：后到的停在前一辆后面（沿自己的路往后让一个车身加间隔），前面的走了再挪上去
    const u = st.u - this.backOff(i, leg, st.u, t);
    const L = rd.build.L;
    const moving = !!leg.tu;
    trackInto(leg.track, leg.rev ? u - L * sc : u, this.pa);
    trackInto(leg.track, leg.rev ? u - L * sc - 2 : u + 2, this.pb);
    const pose = (this.poseBuf[i] ??= { x: 0, y: 0, dir: 0, moving: false, busy: false });
    pose.x = this.pa.x;
    pose.y = this.pa.z;
    pose.dir = Math.atan2(this.pb.z - this.pa.z, this.pb.x - this.pa.x);
    pose.moving = moving;
    pose.busy = !moving;
    if (leg.act) pose.act = leg.act;
    else delete pose.act;
    this.poses[i] = pose;
    if (this.hidden.has(v.kind)) return;
    // 现场视图：计划时刻走得比实际慢（堵车、抛锚、等门）时车其实停着，亮刹车灯
    let rate = 1;
    if (this.shift && moving) {
      const prev = this.planT(i, t - 60);
      if (prev !== undefined) rate = Math.max(0, Math.min(1, (tt - prev) / 60));
    }
    const lp = this.lamp;
    lp.brake = moving ? rate < 0.05 || st.v < 0.02 || inSpans(leg.brake, tt, 2) >= 0 : tt - leg.t0 < 4;
    lp.rev = moving && leg.rev;
    const bi = inSpans(leg.blink, tt, 3);
    lp.turn = bi >= 0 ? (leg.blink?.[bi + 2] as number) : 0;
    lp.night = night && moving;
    lp.phase = (i * 0.37) % 1;
    const odo = (leg.odo ?? 0) + (leg.rev ? -1 : 1) * (u - leg.u);
    const empty = v.kind === 'drayage' && this.cargo?.(v, tt) === 0;
    const parts = rd.build.parts;
    const near = this.nearAt(this.pa.x, this.pa.y, this.pa.z, sc);
    // 姿态：路上（沙盘里距离压缩成 1/10、时间不变）的车速、加速度换成真实的，场地、倒车本来就是真实尺寸
    const f = onRoad(leg, u) ? 10 : 1;
    const vR = st.v * f;
    const aR = moving && rate > 0.05 ? st.a * f * (leg.rev ? -1 : 1) : 0;
    let latA = 0;
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k] as PartSpec;
      const box = part.slot === 'container' || part.slot === 'container20';
      if (empty && box) continue;
      const pp = partPose(leg, u, L, part, sc, this.pp);
      const c = part.tint ? (box ? (v.kind === 'drayage' ? STORE_BLUE : (CONTAINER[v.id % CONTAINER.length] as THREE.Color)) : rd.tint) : WHITE;
      // 前轮的转向角：前轴处路径的切线和车身朝向（两轴间的弦）之差的两倍（阿克曼转角，见 pathYaw）；也用来估侧向加速度
      let steer = 0;
      if (k === 0) {
        const coord = leg.rev ? u - L * sc + part.fa * sc : u - part.fa * sc;
        steer = pathYaw(leg.track, coord, leg.rev) - pp.yaw;
        while (steer > Math.PI) steer -= 2 * Math.PI;
        while (steer < -Math.PI) steer += 2 * Math.PI;
        steer = Math.max(-0.6, Math.min(0.6, 2 * steer));
        if (moving && !leg.rev) latA = (vR * vR * Math.tan(steer)) / Math.max(1, (part.ra - part.fa) * sc);
      }
      const post = MODEL_SPECS[part.slot].posture;
      // 挂车的俯仰很小、侧倾比牵引车慢半拍（按牵引车的八成）
      const dp = clamp1(aR / 3) * post.pitch * DEG * (k === 0 ? 1 : 0.3);
      const dr = clamp1(latA / 4) * post.roll * DEG * (k === 0 ? 1 : 0.8);
      const drawn = this.body(part.slot, near, i, pp.x, pp.y + 0.3, pp.z, pp.yaw, pp.pitch, sc, c, dp, dr);
      if (drawn === undefined) continue;
      const axles = AXLES[part.slot];
      if (drawn && axles) {
        const wk = WHEEL_KIND[part.slot] === 'car' ? this.WC : this.W;
        for (const ax of axles) this.axleAt(i, ax, ax.steer ? steer : 0, odo / ax.r, wk);
      }
      const spec = LAMPS[part.slot];
      if (spec && (lp.brake || lp.rev || lp.turn || lp.night)) this.lampsOf(i, spec, k === 0, k === rd.rear, lp);
    }
  }

  /**
   * 背景车流里的一辆车：单体车的车尾沿走过的路往回量、车身朝向车头；半挂车的牵引车两个锚点在路上，
   * 挂车按铰接运动学跟着牵引销走（沿牵引销走过的路积分 dθ挂/ds = sin(θ路 − θ挂) / 挂车轴距，转弯时切内侧）。
   */
  private drawTraffic(tr: Traffic, c: CarTrack, ci: number, t: number, sc: number, night: boolean): void {
    const look = trafficLook(c.kind, ci, c.color);
    const b = look.build;
    const head = b.parts[0] as PartSpec;
    const trailer = b.parts[1];
    // 单体车按车尾、半挂车按牵引销（车头往后量）
    const back = trailer ? trailer.fa : b.L;
    const tp = this.tp;
    let k = sc;
    if (!tr.pose(c, t, tp, back * k)) return;
    // 镜头拉远（车放大画）时停着不动的车（停车场、路边车位）不画：远看只有几个像素
    if (tp.parked && sc >= 3) return;
    // 停车场里（停着、倒车、场内通道）的车按真实大小画，远看也不会挤成一团
    if (tp.lot && sc > 1) {
      k = 1;
      tr.pose(c, t, tp, back);
    }
    const near = this.nearAt(tp.x, tp.y, tp.z, k);
    const yaw = tp.yaw;
    // 车身朝向（弦）和车头处路径切线之差：前轮转角、弯道的曲率
    let dh = (tp.headYaw ?? yaw) - yaw;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const f = tp.lot ? 1 : 10;
    const vR = (tp.v ?? 0) * f;
    const aR = tp.parked ? 0 : (tp.acc ?? 0) * f * (tp.rev ? -1 : 1);
    const latA = tp.parked || tp.rev ? 0 : (vR * vR * 2 * dh) / Math.max(2, back * k);
    const steer = tp.rev ? 0 : Math.max(-0.6, Math.min(0.6, 2 * dh));
    const odo = tp.odo ?? 0;
    const st = this.lamp;
    st.night = night;
    st.brake = tp.brake;
    st.turn = tp.turn;
    st.rev = tp.rev;
    st.phase = (ci * 0.37) % 1;
    const lit = !tp.parked && (st.brake || st.turn || st.rev || night);
    const y = tp.y + 0.3;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    // 单体车：这个点就是车尾（零件原点）；牵引车：这个点是牵引销，原点沿朝向再往后退牵引销在零件里的 x
    const rearAnchorX = trailer ? head.ax - (head.ra - head.fa) : 0;
    const hx = tp.x - cy * rearAnchorX * k;
    const hz = tp.z + sy * rearAnchorX * k;
    const p0 = MODEL_SPECS[head.slot].posture;
    const dp = clamp1(aR / 3) * p0.pitch * DEG;
    const dr = clamp1(latA / 4) * p0.roll * DEG;
    const drawn = this.body(head.slot, near, -1, hx, y, hz, yaw, 0, k, head.tint ? look.paint : WHITE, dp, dr);
    if (drawn === undefined) return;
    if (drawn) {
      const wk = WHEEL_KIND[head.slot] === 'car' ? this.WC : this.W;
      for (const ax of AXLES[head.slot] ?? []) this.axleAt(-1, ax, ax.steer ? steer : 0, odo / ax.r, wk);
    }
    const hs = LAMPS[head.slot];
    if (hs && lit) this.lampsOf(-1, hs, true, !trailer, st);
    if (!trailer) return;
    // 挂车：牵引销走过的路往回取几个点，从最早的一点起积分挂车的朝向
    const tq = this.tq;
    const step = RIG_STEP * k;
    let n = 0;
    for (let j = 0; j <= RIG_SAMPLES; j++) {
      if (!tr.pose(c, t, tq, (back + j * RIG_STEP) * k)) break;
      this.kx[j] = tq.x;
      this.kz[j] = tq.z;
      n = j;
    }
    // 没有走过的路（刚出现）：挂车和牵引车同向
    let th = -yaw;
    if (n >= 1) {
      const ox = (this.kx[n - 1] as number) - (this.kx[n] as number);
      const oz = (this.kz[n - 1] as number) - (this.kz[n] as number);
      if (Math.hypot(ox, oz) > step * 0.3) th = Math.atan2(oz, ox);
      const lt = Math.max(1, (trailer.ra - trailer.fa) * k);
      for (let j = n - 1; j >= 0; j--) {
        const dx = (this.kx[j] as number) - (this.kx[j + 1] as number);
        const dz = (this.kz[j] as number) - (this.kz[j + 1] as number);
        const ds = Math.hypot(dx, dz);
        if (ds < 1e-4) continue;
        let d = Math.atan2(dz, dx) - th;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        th += Math.min(1, ds / lt) * Math.sin(d);
      }
    }
    const tyaw = -th;
    const ct = Math.cos(tyaw);
    const stt = Math.sin(tyaw);
    const dr1 = clamp1(latA / 4) * DEG * 0.8;
    for (let j = 1; j < b.parts.length; j++) {
      const part = b.parts[j] as PartSpec;
      const ox = tp.x - ct * part.ax * k;
      const oz = tp.z + stt * part.ax * k;
      const box = part.slot === 'container' || part.slot === 'container20';
      const got = this.body(part.slot, near, -1, ox, y + (part.y ?? 0) * k, oz, tyaw, 0, k, look.trailer, dp * 0.3, dr1 * MODEL_SPECS[part.slot].posture.roll);
      if (got === undefined) continue;
      if (got && !box) for (const ax of AXLES[part.slot] ?? []) this.axleAt(-1, ax, 0, odo / ax.r, this.W);
      const ls = LAMPS[part.slot];
      if (ls && lit) this.lampsOf(-1, ls, false, true, st);
    }
  }

  /** 船：沿航线走；本店班轮只画船体（甲板上的箱由港口作业动画画），靠离泊时画拖轮 */
  private drawSea(i: number, v: WVehicle, sea: ShipMotion, t: number): void {
    const sp = this.sp;
    if (!shipAt(sea, t, sp)) {
      this.poses[i] = undefined;
      return;
    }
    const pose = (this.poseBuf[i] ??= { x: 0, y: 0, dir: 0, moving: false, busy: true });
    pose.x = sp.x;
    pose.y = sp.z;
    pose.dir = sp.dir;
    pose.moving = sp.moving;
    pose.busy = true;
    if (sp.act) pose.act = sp.act;
    else delete pose.act;
    this.poses[i] = pose;
    if (this.hidden.has(v.kind)) return;
    // 船浮在水面上，跟着潮汐涨落（tide.ts）
    this.put(this.ix.get(/班轮/.test(v.label) ? 'shipHull' : 'ship') as number, i, sp.x, floatY(t), sp.z, -sp.dir, 0, 1);
    if (!sp.tug) return;
    // 拖轮（船坐标：前 F、右舷 R）：护航在船首、船尾外侧；顶推时船头顶着外海一侧的船舷；拖离时在外侧拉；掉头时首尾在两侧反向推
    const c = Math.cos(sp.dir);
    const s = Math.sin(sp.dir);
    const TUG = this.ix.get('tug') as number;
    const tugAt = (along: number, lateral: number, hf: number, hr: number) => {
      const hx = c * hf - s * hr;
      const hz = s * hf + c * hr;
      this.put(TUG, i, sp.x + c * along - s * lateral, floatY(t), sp.z + s * along + c * lateral, Math.atan2(-hz, hx), 0, 1);
    };
    const side = sp.side;
    switch (sp.tug) {
      case 'escort':
        tugAt(108, side * 33, 1, 0);
        tugAt(-104, side * 33, 1, 0);
        break;
      case 'push':
        tugAt(78, side * 34.5, 0, -side);
        tugAt(-78, side * 34.5, 0, -side);
        break;
      case 'pull':
        tugAt(72, side * 64, 0, side);
        tugAt(-72, side * 64, 0, side);
        break;
      case 'swing':
        tugAt(102, -sp.turn * 34.5, 0, sp.turn);
        tugAt(-102, sp.turn * 34.5, 0, -sp.turn);
        break;
    }
  }

  /** 列车沿铁路排开：货运是车头 + 一节节平车（每节一个集装箱），客运是动车组；运行段按速度曲线走 */
  private train(i: number, v: WVehicle, t: number, sc: number): void {
    const rl = this.rails[i];
    if (!rl) return;
    const segs = v.segs;
    let si = segs.findIndex((s) => t >= s.t0 && t <= s.t1);
    if (si < 0) si = segs.length - 1;
    // 停着的段：停在前一段运行的终点；当天还没开过的停在下一段运行的起点
    let run = rl.runs[si];
    let f = 1;
    if (!run) {
      let j = si - 1;
      while (j >= 0 && !rl.runs[j]) j--;
      if (j >= 0) run = rl.runs[j];
      else {
        j = si + 1;
        while (j < segs.length && !rl.runs[j]) j++;
        run = rl.runs[j];
        f = 0;
      }
      if (!run) return;
    } else f = Math.max(0, Math.min(1, leadState(run.leg, t, this.ls).u / run.D));
    const { s0, s1 } = run;
    const dirn = s1 >= s0 ? 1 : -1;
    const len = (rl.pax ? EMU_LEN : FREIGHT_LEN) * sc;
    const head = s0 + dirn * len * (1 - f) + (s1 - s0) * f;
    // 跟踪标签、跟随镜头、道口栏杆用车头的位置（和画出来的列车一致）
    const cp = this.poses[i];
    if (cp) {
      trackInto(this.rail, head, this.pa);
      trackInto(this.rail, head + dirn * 4, this.pb);
      const pose = (this.poseBuf[i] ??= { x: 0, y: 0, dir: 0, moving: false, busy: true });
      pose.x = this.pa.x;
      pose.y = this.pa.z;
      pose.dir = Math.atan2(this.pb.z - this.pa.z, this.pb.x - this.pa.x);
      pose.moving = cp.moving;
      pose.busy = cp.busy;
      if (cp.act) pose.act = cp.act;
      else delete pose.act;
      this.poses[i] = pose;
    }
    const at = (back: number, half: number, k: number, flip: boolean) => {
      trackInto(this.rail, head - dirn * (back - half), this.pa);
      trackInto(this.rail, head - dirn * (back + half), this.pb);
      const yaw = Math.atan2(-(this.pa.z - this.pb.z), this.pa.x - this.pb.x) + (flip ? Math.PI : 0);
      return this.put(k, i, (this.pa.x + this.pb.x) / 2, 0.5, (this.pa.z + this.pb.z) / 2, yaw, 0, sc);
    };
    if (rl.pax) {
      // 动车组：两头是头车（尾部的头车车头朝后），折返时不用掉头
      const cab = this.ix.get('emuCab') as number;
      const coach = this.ix.get('emuCoach') as number;
      for (let k = 0; k < EMU_CARS; k++) at((EMU_CENTERS[k] as number) * sc, 9 * sc, k === 0 || k === EMU_CARS - 1 ? cab : coach, k === EMU_CARS - 1);
      return;
    }
    const boxes = this.cargo?.(v, t) ?? Number(/(\d+) 箱/.exec(v.label)?.[1] ?? 6);
    for (let k = 0; k <= WAGONS; k++) {
      const back = (k === 0 ? 10 : 17 + (k - 1) * WAGON_LEN + 7.5) * sc;
      if (k === 0) at(back, 6 * sc, this.ix.get('loco') as number, false);
      else {
        const n = at(back, 6 * sc, this.ix.get('wagon') as number, false);
        if (n >= 0 && k <= Math.min(WAGONS, boxes)) this.put(this.ix.get('wagonBox') as number, i, (this.pa.x + this.pb.x) / 2, 0.5, (this.pa.z + this.pb.z) / 2, Math.atan2(-(this.pa.z - this.pb.z), this.pa.x - this.pb.x), 0, sc, boxColor(this.trainBoxColor?.(v, k) ?? (CONTAINER_HEX[(v.id + k) % CONTAINER_HEX.length] as string)));
      }
    }
    // 后机车（车头朝后）：折返时换它在前，整列车不用跳
    at((FREIGHT_LEN - 10) * sc, 6 * sc, this.ix.get('loco') as number, true);
  }

  private railCache = new Map<string, number>();
  /** 沙盘坐标投到铁路上，返回沿铁路的距离 */
  private railS(x: number, z: number): number {
    const key = `${Math.round(x)}:${Math.round(z)}`;
    const hit = this.railCache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bd = Infinity;
    const tr = this.rail;
    for (let i = 0; i < tr.pts.length - 1; i++) {
      const a = tr.pts[i] as V3;
      const b = tr.pts[i + 1] as V3;
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const l2 = vx * vx + vz * vz || 1;
      const k = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2));
      const d = Math.hypot(x - (a.x + vx * k), z - (a.z + vz * k));
      if (d < bd) {
        bd = d;
        best = (tr.cum[i] as number) + k * Math.sqrt(l2);
      }
    }
    this.railCache.set(key, best);
    return best;
  }

  /** 鼠标拾取（车轮也算，车灯和光圈不算） */
  pick(ray: THREE.Raycaster): PickedVehicle | undefined {
    const meshes = [...this.meshes.entries()].filter(([slot, m]) => m.count > 0 && slot !== 'marker' && slot !== 'lamp').map(([, m]) => m);
    for (const h of ray.intersectObjects(meshes, false)) {
      const mesh = h.object as THREE.InstancedMesh;
      if (h.instanceId === undefined) continue;
      const k = this.ix.get(mesh.name as Slot);
      if (k === undefined) continue;
      const idx = (this.own[k] as Int32Array)[h.instanceId];
      if (idx === undefined || idx < 0) continue;
      const v = this.list[idx] as WVehicle;
      const act = this.poses[idx]?.act;
      return { v, dist: h.distance, ...(act ? { act } : {}) };
    }
    return undefined;
  }

  /** 此刻在路上 / 在场的数量（按种类） */
  active(): Record<string, number> {
    const out: Record<string, number> = {};
    this.list.forEach((v, i) => {
      if (this.poses[i]) out[v.kind] = (out[v.kind] ?? 0) + 1;
    });
    return out;
  }

  /** 飞机此刻的高度（实时跟踪的标签放在飞机上面） */
  altitudeOf(id: number, t: number): number {
    const v = this.list[id];
    if (v?.kind !== 'plane') return 0;
    return this.planePose ? (this.planePose(v.id, t)?.y ?? 0) : altitude(v, t);
  }

  /** 某个车辆此刻的位置（跟随镜头用） */
  poseOf(id: number): Pose | undefined {
    return this.poses[id];
  }

  /** 船在任意时刻的姿态（区域坐标）：港口按本店班轮实际的航迹给别家的船排避让 */
  shipPoseAt(id: number, t: number, out: ShipPose): boolean {
    const sea = this.seas[id];
    return !!sea && shipAt(sea, t, out);
  }

  /** 车辆整趟的三维路线（选中时画出来）：公路车辆是运动规划的路径，其他按仿真折线 */
  routeOf(id: number): V3[][] {
    const rd = this.roads[id];
    if (rd) return rd.motion.legs.filter((l) => l.tu).map((l) => l.track.pts.slice(1));
    const v = this.list[id];
    if (!v) return [];
    return v.segs.filter((s) => s.pts.length > 2).map((s) => {
      const pts: V3[] = [];
      for (let k = 0; k + 1 < s.pts.length; k += 2) pts.push(v3(s.pts[k] as number, 0, s.pts[k + 1] as number));
      return pts;
    });
  }
}

// ———————————————————————— 车队间距 ————————————————————————

/** 车队间距：最多晚多少秒、同一条路线上前后两辆出发至少隔多少秒、停着补时间时至少还停多久 */
const CONVOY_CAP = 120;
const CONVOY_HEADWAY = 20;
const CONVOY_DWELL = 10;

/** 一辆车停着的一段（运动时刻 a–b）和它后面接着开的那一趟：收货场靠台时的场地排程驶离时刻、那一趟上路的路线和出发时刻 */
interface CWin {
  a: number;
  b: number;
  /** 前面没有停着的段（一出现就在开）：只是晚一点出现 */
  first?: true;
  /** 场地排程里驶离（车头开到驶出点）比仿真的离开晚多少秒（一次一辆车驶离） */
  exitLate: number;
  /** 后面那一趟上路：路线（仿真的路线节点）、开始的运动时刻 */
  route?: string;
  r0?: number;
}

/**
 * 车队间距（只改三维里的运动，仿真的记录、冻结的计划、跟踪表、值班助手都还是仿真的时刻）：
 * - 收货场一次一辆车驶离：场地排程的驶离比仿真的离开晚（前一辆还没走），就按排程的时刻走（在门口多靠一会儿），后面上路也跟着晚；
 * - 同一条路线上两辆车前后不到 CONVOY_HEADWAY 秒出发：按出发的先后，后一辆晚到隔开（也是在出发前停着时多等）；
 * - 晚的时间在下一站停着时补回来（到得晚、少停一会儿，停够了就按原来的时刻走），补不完的带到下一趟；最多晚 CONVOY_CAP 秒。
 * 晚点只在停着的段里加（多等）或者减（往前跳），开着的段里车只是整体晚一点：路上不会停、不会跳。按车的下标和时刻排，结果每次一样。
 * Convoy spacing: per-vehicle display warps (deterministic; sim times unchanged).
 */
export function planConvoy(list: readonly WVehicle[], motions: readonly (Motion | undefined)[]): (Warp | undefined)[] {
  type St = { wins: CWin[]; k: number; d: number; d0: number; T: number[]; M: number[] };
  const st: (St | undefined)[] = motions.map((m, i) => {
    if (!m || !m.legs.length) return undefined;
    const v = list[i] as WVehicle;
    const legs = m.legs;
    const still = (l: MLeg) => !l.tu || l.tu.length < 2;
    const wins: CWin[] = [];
    if (!still(legs[0] as MLeg)) wins.push({ a: m.t0, b: m.t0, first: true, exitLate: 0 });
    for (let j = 0; j < legs.length; j++) {
      const l = legs[j] as MLeg;
      if (!still(l) || l.t1 - l.t0 < 1) continue;
      let exitLate = 0;
      // 收货场里靠着门的一段（倒车靠上的）：场地排程的驶离
      const yb = l.yb;
      if (yb && l.ys && l.rev) {
        for (const id of yb.ids) {
          const tl = siteTimeline(yb.key, id);
          if (!tl) continue;
          if (tl.segs.some((x) => x.kind === 'pullout')) exitLate = Math.max(0, Math.min(CONVOY_CAP, tl.outAt - yb.t1));
          break;
        }
        if (exitLate < 0.5) exitLate = 0;
      }
      wins.push({ a: l.t0, b: l.t1, exitLate });
    }
    // 每一段停着后面那一趟的上路：路线节点和仿真的出发时刻（道路段从仿真那一段的 t0 开始）
    for (let w = 0; w < wins.length; w++) {
      const W = wins[w] as CWin;
      const end = wins[w + 1]?.a ?? Infinity;
      for (const l of legs) {
        if (l.t0 < W.b - 0.5 || l.t0 >= end || !l.spans?.length || still(l)) continue;
        const sg = v.segs.find((x) => x.route && x.route.length > 1 && Math.abs(x.t0 - l.t0) < 0.5);
        if (sg?.route) {
          W.route = sg.route.join('>');
          W.r0 = l.t0;
        }
        break;
      }
    }
    return { wins, k: 0, d: 0, d0: 0, T: [], M: [] };
  });
  // 一段停着排完：补时间（少停一会儿）、加上这一趟要晚的；need = 同一路线上隔开要晚的
  const finish = (s: St, need: number): void => {
    const W = s.wins[s.k] as CWin;
    const din = s.d;
    if (W.first) {
      s.d = Math.min(CONVOY_CAP, Math.max(W.exitLate, need));
      s.d0 = s.d;
    } else {
      const dwell = W.b - W.a;
      const keep = Math.min(CONVOY_DWELL, dwell);
      const dabs = Math.max(0, din - Math.max(0, dwell - keep));
      const dout = Math.min(CONVOY_CAP, Math.max(dabs, W.exitLate, need));
      if (dout < din - 1e-6) {
        // 到的那一刻往前跳（停着，看不出来）
        s.T.push(W.a + din, W.a + din);
        s.M.push(W.a, W.a + din - dout);
      } else if (dout > din + 1e-6) {
        // 走以前多停一会儿
        s.T.push(W.b + din, W.b + dout);
        s.M.push(W.b, W.b);
      }
      s.d = dout;
    }
    s.k++;
  };
  // 不上路的停着先排掉；返回下一段要上路的停着的出发时刻（还没算同一路线隔开），排完了返回 undefined
  const tentative = (s: St): number | undefined => {
    for (;;) {
      const W = s.wins[s.k];
      if (!W) return undefined;
      if (W.route !== undefined && W.r0 !== undefined) {
        const din = s.d;
        if (W.first) return W.r0 + Math.min(CONVOY_CAP, W.exitLate);
        const dwell = W.b - W.a;
        const dabs = Math.max(0, din - Math.max(0, dwell - Math.min(CONVOY_DWELL, dwell)));
        return W.r0 + Math.min(CONVOY_CAP, Math.max(dabs, W.exitLate));
      }
      finish(s, 0);
    }
  };
  const key = st.map((s) => (s ? tentative(s) : undefined));
  const last = new Map<string, number>();
  for (;;) {
    let bi = -1;
    for (let i = 0; i < key.length; i++) if (key[i] !== undefined && (bi < 0 || (key[i] as number) < (key[bi] as number))) bi = i;
    if (bi < 0) break;
    const s = st[bi] as St;
    const W = s.wins[s.k] as CWin;
    const at = key[bi] as number;
    const prev = last.get(W.route as string);
    const need = prev !== undefined && at < prev + CONVOY_HEADWAY ? prev + CONVOY_HEADWAY - (W.r0 as number) : 0;
    finish(s, need);
    last.set(W.route as string, Math.max(prev ?? -Infinity, (W.r0 as number) + s.d));
    key[bi] = tentative(s);
  }
  return st.map((s) => (s && (s.T.length || s.d0) ? { d0: s.d0, T: Float64Array.from(s.T), M: Float64Array.from(s.M) } : undefined));
}

// ———————————————————————— 停着不叠在一起 ————————————————————————

/** 停着往后让：前后两辆之间留的间隔（米）、前面的走了以后挪上去用的秒数、开过来 / 开走时慢慢让的距离至少多少米 */
const STAND_GAP = 2.5;
const STAND_UP = 6;
const STAND_RAMP = 15;

/**
 * 一辆车停着的一次往后让：停在 track 上车头 u 处（显示时刻 ts–te）；steps 是停着的时候往后让多少米（[时刻, 米, 时刻, 米, ……]，
 * 每次变的时候用 STAND_UP 秒慢慢挪）；D 是开过来 / 开走时慢慢让的距离；inLeg = 开着的段里停住（红灯、排队，走的时候还在这条路径上）。
 */
interface Back {
  track: Track;
  u: number;
  ts: number;
  te: number;
  inLeg: boolean;
  D: number;
  steps: number[];
}
/** 停着的时候某一刻往后让多少米 */
function backAt(b: Back, t: number): number {
  const s = b.steps;
  let d = s[1] as number;
  for (let k = 2; k + 1 < s.length; k += 2) {
    const tk = s[k] as number;
    if (t < tk) break;
    const prev = s[k - 1] as number;
    const next = s[k + 1] as number;
    d = t < tk + STAND_UP ? prev + ((next - prev) * (t - tk)) / STAND_UP : next;
  }
  return d;
}

/**
 * 停着不叠在一起：每辆公路车辆停着的每一段（停站、送货点；开着的段里红灯前、排队停住的），在显示时刻里
 * （车队间距的晚点算进去）和别的车停着的地方叠在一起的：按到的先后，后到的停在前面那辆后面（沿自己的路往后让，刚好让开再留 STAND_GAP 米），
 * 前面的走了就挪上去；停站的车要比前面的先走时，走以前 STAND_UP 秒挪上去。收货场里的（场地排程管）、倒车靠着的不在这里。
 * 只改画面上停的位置，时刻不变；按时刻和车的下标排，结果每次一样。
 * Standing sim vehicles never overlap: later arrivals queue behind along their own path.
 */
export function planStands(roads: readonly ({ motion: Motion; L: number } | undefined)[], warps: readonly (Warp | undefined)[]): (Back[] | undefined)[] {
  type S = { i: number; track: Track; u: number; ts: number; te: number; inLeg: boolean; L: number; x: number; z: number; steps?: number[] };
  const P = { x: 0, y: 0, z: 0 };
  const Q = { x: 0, y: 0, z: 0 };
  // 车身矩形（车头在 track 的 u 处，沿路往后整车长）
  const body = (track: Track, u: number, L: number) => {
    trackInto(track, u, P);
    trackInto(track, Math.max(0, u - 1), Q);
    let hx = P.x - Q.x;
    let hz = P.z - Q.z;
    const n = Math.hypot(hx, hz);
    if (n < 1e-6) {
      trackInto(track, u + 1, Q);
      hx = Q.x - P.x;
      hz = Q.z - P.z;
    }
    const m = Math.hypot(hx, hz) || 1;
    const ux = hx / m;
    const uz = hz / m;
    return { cx: P.x - (ux * L) / 2, cz: P.z - (uz * L) / 2, ux, uz, hl: L / 2 - 0.3, hw: 1.15 };
  };
  type B = ReturnType<typeof body>;
  const hit = (A: B, C: B) => {
    for (const [ax, az] of [[A.ux, A.uz], [-A.uz, A.ux], [C.ux, C.uz], [-C.uz, C.ux]] as [number, number][]) {
      const pr = (o: B) => Math.abs(o.ux * ax + o.uz * az) * o.hl + Math.abs(-o.uz * ax + o.ux * az) * o.hw;
      if (Math.abs((A.cx - C.cx) * ax + (A.cz - C.cz) * az) > pr(A) + pr(C)) return false;
    }
    return true;
  };
  // 每辆车停着的段
  const stands: S[] = [];
  roads.forEach((rd, i) => {
    if (!rd) return;
    const w = warps[i];
    const dl = (tau: number) => (w ? warpDelay(w, tau) : 0);
    const add = (track: Track, u: number, a: number, b: number, inLeg: boolean, da: number, db: number) => {
      if (b - a < 2) return;
      trackInto(track, u, P);
      stands.push({ i, track, u, ts: a + da, te: b + db, inLeg, L: rd.L, x: P.x, z: P.z });
    };
    for (const l of rd.motion.legs) {
      if (l.rev || l.ys || l.yb) continue;
      if (!l.tu || l.tu.length < 2) {
        add(l.track, l.u, l.t0, l.t1, false, dl(l.t0 - 1e-3), dl(l.t1 + 1e-3));
        continue;
      }
      const tu = l.tu;
      const us = l.tuS as number[];
      const tv = l.tv;
      if (!tv) continue;
      // 开着的段里停住：速度 0、位置不动的一串采样点
      const n = tu.length;
      let k0 = -1;
      for (let k = 0; k <= n; k++) {
        const still = k < n && (tv[k] as number) <= 0.02 && (k0 < 0 || Math.abs((us[k] as number) - (us[k0] as number)) < 0.05);
        if (still) {
          if (k0 < 0) k0 = k;
          continue;
        }
        if (k0 >= 0) {
          const d = dl(((tu[k0] as number) + (tu[k - 1] as number)) / 2);
          add(l.track, us[k0] as number, tu[k0] as number, tu[k - 1] as number, true, d, d);
          k0 = -1;
        }
        if (k < n && (tv[k] as number) <= 0.02) k0 = k;
      }
    }
  });
  stands.sort((a, b) => a.ts - b.ts || a.i - b.i);
  // 按到的先后：前面停着的（时段有交叠、离得近）挡着的，往后让到刚好不碰
  const grid = new Map<string, S[]>();
  const cell = (x: number, z: number) => `${Math.floor(x / 60)},${Math.floor(z / 60)}`;
  const near = (s: S) => {
    const gx = Math.floor(s.x / 60);
    const gz = Math.floor(s.z / 60);
    const out: S[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const p of grid.get(`${gx + dx},${gz + dz}`) ?? []) out.push(p);
    return out;
  };
  const backOf = (p: S, t: number) => (p.steps ? backAt({ steps: p.steps } as Back, t) : 0);
  const out: (Back[] | undefined)[] = roads.map(() => undefined);
  for (const s of stands) {
    const blockers = near(s).filter((p) => p.i !== s.i && p.te > s.ts && p.ts < s.te && Math.hypot(p.x - s.x, p.z - s.z) < 45);
    const k = cell(s.x, s.z);
    (grid.get(k) ?? grid.set(k, []).get(k) as S[]).push(s);
    if (!blockers.length) continue;
    const dMax = Math.max(0, Math.min(60, s.u / 2 - 0.5));
    const need = (t: number): number => {
      const act = blockers.filter((p) => p.ts <= t + 1e-6 && p.te > t);
      if (!act.length) return 0;
      const bs = act.map((p) => body(p.track, p.u - backOf(p, t), p.L));
      for (let d = 0; d <= dMax; d += 0.5) {
        const me = body(s.track, s.u - d, s.L);
        if (!bs.some((b) => hit(me, b))) return d === 0 ? 0 : Math.min(dMax, d + STAND_GAP);
      }
      return dMax;
    };
    // 前面的车走了、往前挪了的时刻重新算
    const times = [s.ts];
    for (const p of blockers) {
      if (p.te > s.ts && p.te < s.te) times.push(p.te);
      for (let j = 2; p.steps && j < p.steps.length; j += 2) if ((p.steps[j] as number) > s.ts && (p.steps[j] as number) < s.te) times.push((p.steps[j] as number) + STAND_UP);
    }
    times.sort((a, b) => a - b);
    const steps: number[] = [];
    for (const t of times) {
      const d = need(t);
      if (!steps.length || Math.abs((steps[steps.length - 1] as number) - d) > 0.01) steps.push(t, d);
    }
    if (steps.every((x, j) => j % 2 === 0 || x === 0)) continue;
    // 停站的车要先走：走以前挪上去（开走的那一段不在这条路径上）
    const lastD = steps[steps.length - 1] as number;
    if (!s.inLeg && lastD > 0) steps.push(Math.max((steps[steps.length - 2] as number) + 0.1, s.te - STAND_UP), 0);
    s.steps = steps;
    const maxD = Math.max(...steps.filter((_, j) => j % 2 === 1));
    (out[s.i] ??= []).push({ track: s.track, u: s.u, ts: s.ts, te: s.te, inLeg: s.inLeg, D: Math.min(s.u, Math.max(STAND_RAMP, 2 * maxD)), steps });
  }
  return out;
}

/**
 * 换上新的车队间距那一刻（显示时刻 t）开着、晚点要变的车：先照旧（晚 d 秒），到它下一次停下（那一段停着的开头）再换，路上不跳；
 * 停着、新旧的运动时刻落在同一段停着里的不用。
 */
function holdFor(m: Motion, before: Warp | undefined, after: Warp | undefined, t: number): { until: number; d: number } | undefined {
  const tb = before ? warpAt(before, t) : t;
  const ta = after ? warpAt(after, t) : t;
  if (Math.abs(tb - ta) < 0.01) return undefined;
  // 新旧都看不见（都还没出现、或者都已经收车）：直接换
  const vis = (x: number) => x >= m.t0 && x <= m.t1;
  if (!vis(tb) && !vis(ta) && tb < m.t0 === ta < m.t0) return undefined;
  const lb = tb >= m.t0 && tb <= m.t1 ? legAt(m, tb) : undefined;
  const la = ta >= m.t0 && ta <= m.t1 ? legAt(m, ta) : undefined;
  const standing = (l: MLeg | undefined) => !!l && (!l.tu || l.tu.length < 2);
  if (lb && lb === la && standing(lb)) return undefined;
  // 还没出现、已经收车的车也照旧（不突然冒出来、不突然消失），到它下一次停下再换
  const next = m.legs.find((l) => l.t0 > tb && (!l.tu || l.tu.length < 2));
  return { until: next ? next.t0 + (t - tb) : Infinity, d: t - tb };
}

const DEG = Math.PI / 180;
const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));
/** 双胎的两只轮胎离轮距中线多远（米） */
const DUAL_OFF = [-0.155, 0.155];
/** 背景半挂车：挂车朝向积分时，沿牵引销走过的路往回取几个点、每隔几米 */
const RIG_SAMPLES = 10;
const RIG_STEP = 2.5;

/** 领先点在不在道路上（运动规划记下的道路段：路上的车速、加速度是沙盘里压缩过的） */
function onRoad(leg: MLeg, u: number): boolean {
  const sp = leg.spans;
  if (!sp) return false;
  for (const r of sp) if (r.us.length && u >= (r.us[0] as number) && u <= (r.us[r.us.length - 1] as number)) return true;
  return false;
}

/** 天黑了（和视图的天光一样按太阳高度）：行车时开尾灯、大灯 */
function isNight(t: number): boolean {
  const h = (((t / 3600) % 24) + 24) % 24;
  const elev = Math.sin((Math.PI * (h - 6)) / 13.5);
  return elev * 1.6 + 0.2 < 0.62;
}

/** 车型：按种类和标签（供应商、区域生鲜、空运的车不是自己的车队，没有公司的彩条） */
function buildKey(v: WVehicle): BuildKey | undefined {
  const outside = /供应商|生鲜集货|空运/.test(v.label);
  switch (v.kind) {
    case 'truck':
      return outside ? 'plainDry' : 'ownDry';
    case 'reefer':
      return outside ? 'plainReefer' : 'ownReefer';
    case 'ev':
      return 'ev';
    case 'van':
      return /面包/.test(v.label) ? 'vanBakery' : 'vanOnline';
    case 'drayage':
      return 'drayDay';
    default:
      return undefined;
  }
}

function cabColor(v: WVehicle, key: BuildKey): string {
  if (key === 'drayage' || key === 'drayDay') return '#d35400';
  if (key === 'ownDry') return VKIND_COLOR.truck;
  if (key === 'ownReefer') return '#3f8fd0';
  if (/生鲜集货/.test(v.label)) return '#6f9a4e';
  if (/空运/.test(v.label)) return '#e9e9e6';
  return SUPPLIER_CABS[v.id % SUPPLIER_CABS.length] as string;
}

/** 飞机的高度：进近时从 220 米降到地面，起飞时滑跑一段再爬升 */
function altitude(v: WVehicle, t: number): number {
  const seg = v.segs.find((s) => t >= s.t0 && t <= s.t1);
  if (!seg) return 0;
  const f = (t - seg.t0) / Math.max(1, seg.t1 - seg.t0);
  if (seg.act === '进近降落') return 220 * (1 - f) + 0.5;
  if (seg.act === '起飞') return 0.5 + 240 * Math.pow(Math.max(0, (f - 0.35) / 0.65), 1.3);
  return 0.5;
}

export type { Km };
