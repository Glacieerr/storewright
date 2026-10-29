import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SEMI, type VehicleType } from './vehicleTypes';
import { MeshBuilder, MAT_COLOR } from './vehicles/builder';
import { antenna, carBody, carDetails, HATCH, PICKUP, pickupBed, roofRails, SEDAN, SUV } from './vehicles/cars';
import { boatTrailer, boxTruck, rvClassA, tractor, trailerVan, travelTrailer, utilityTrailer, van } from './vehicles/trucks';
import { bowrider } from './vehicles/boats';

/**
 * 车辆模型（决策记录 0018）：按常见车型的公开外形和尺寸放样出车身（vehicles/cars.ts、vehicles/trucks.ts），
 * 每种车型仍是「车漆」和「细节」两个合并几何体：车漆不带顶点色，按实例着色；细节（车窗、灯、格栅、饰条）带固定顶点色。
 * 车辆局部坐标：车头朝 +Z，原点在车底中心（半挂牵引车在鞍座，拖车在挂钩球头）。
 * 车轮单独实例化（转动、转向），乘用车和货车各有一种轮毂。
 */

export * from './vehicleTypes';

type Geo = { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry };

export interface WheelSpec {
  x: number;
  z: number;
  r: number;
  w: number;
  /** 前轮：跟着方向盘转 */
  steer: boolean;
  /** 货车轮毂（钢圈 / 铝圈 + 轮毂螺母），否则是乘用车的五辐轮毂 */
  truck?: boolean;
}

const pair = (halfTrack: number, z: number, r: number, w = 0.22, steer = false, truck = false): WheelSpec[] => [
  { x: halfTrack, z, r, w, steer, truck },
  { x: -halfTrack, z, r, w, steer, truck },
];
/** 双胎：内外两只轮胎 */
const dual = (inner: number, outer: number, z: number, r: number, w = 0.26): WheelSpec[] => [...pair(inner, z, r, w, false, true), ...pair(outer, z, r, w, false, true)];

/** 每种车型的车轮（车辆局部坐标，半挂车的牵引车以牵引销为原点） */
export const WHEEL_LAYOUT: Record<VehicleType, WheelSpec[]> = {
  sedan: [...pair(0.8, SEDAN.axles[1] as number, 0.33, 0.225, true), ...pair(0.8, SEDAN.axles[0] as number, 0.33, 0.225)],
  hatch: [...pair(0.78, HATCH.axles[1] as number, 0.31, 0.215, true), ...pair(0.78, HATCH.axles[0] as number, 0.31, 0.215)],
  suv: [...pair(0.82, SUV.axles[1] as number, 0.36, 0.235, true), ...pair(0.82, SUV.axles[0] as number, 0.36, 0.235)],
  pickup: [...pair(0.88, PICKUP.axles[1] as number, 0.41, 0.27, true), ...pair(0.88, PICKUP.axles[0] as number, 0.41, 0.27)],
  van: [...pair(0.88, 1.95, 0.37, 0.235, true), ...pair(0.88, -1.71, 0.37, 0.235)],
  truck: [...pair(0.98, 2.7, 0.44, 0.26, true, true), ...dual(0.76, 1.04, -1.6, 0.44, 0.24)],
  semi: [...pair(1.04, 5.05, 0.52, 0.3, true, true), ...dual(0.8, 1.1, 0.65, 0.52, 0.28), ...dual(0.8, 1.1, -0.65, 0.52, 0.28)],
  rv: [...pair(1.05, 3.4, 0.5, 0.28, true, true), ...dual(0.84, 1.13, -2.6, 0.5, 0.26)],
};

/** 挂车的串联后轴（以牵引销为原点，双胎） */
export const TRAILER_WHEELS: WheelSpec[] = [...dual(0.8, 1.1, -(SEMI.kingpinToAxle - 0.625), 0.52, 0.28), ...dual(0.8, 1.1, -(SEMI.kingpinToAxle + 0.625), 0.52, 0.28)];

/** 车灯位置：半宽、前灯高度、车头和车尾的 z、尾灯高度（半挂车的尾灯在挂车上） */
export interface LampSpec {
  halfW: number;
  y: number;
  front: number;
  rear: number;
  rearY: number;
}
export const LAMP_LAYOUT: Record<VehicleType, LampSpec> = {
  sedan: { halfW: 0.9, y: 0.66, front: 2.43, rear: -2.43, rearY: 0.86 },
  hatch: { halfW: 0.88, y: 0.72, front: 2.15, rear: -2.15, rearY: 0.92 },
  suv: { halfW: 0.92, y: 0.86, front: 2.31, rear: -2.31, rearY: 1.0 },
  pickup: { halfW: 0.98, y: 0.98, front: 2.94, rear: -2.94, rearY: 0.98 },
  van: { halfW: 1.0, y: 1.0, front: 2.965, rear: -2.965, rearY: 1.25 },
  truck: { halfW: 1.12, y: 1.0, front: 3.8, rear: -3.83, rearY: 1.25 },
  semi: { halfW: 1.2, y: 1.32, front: 6.4, rear: -1.3, rearY: 1.1 },
  rv: { halfW: 1.22, y: 1.05, front: 5.6, rear: -5.62, rearY: 1.25 },
};

/** 半挂车挂车的尾灯 */
export const TRAILER_LAMP = { halfW: 1.12, y: 1.1, rear: -SEMI.kingpinToRear };

// ---------------- 拖车（房车拖挂、船拖车、小平板拖车） ----------------

export type TowKind = 'camper' | 'boat' | 'utility';
export const TOW_KINDS: TowKind[] = ['camper', 'boat', 'utility'];

/** 拖车：挂钩球头到车尾的长度、车轴位置（挂钩到轴的距离决定转弯时的内轮差）、车轮、尾灯 */
export const TOW: Record<TowKind, { length: number; axle: number; wheels: WheelSpec[]; lamp: { halfW: number; y: number; rear: number } }> = {
  camper: { length: 9.65, axle: 6.45, wheels: [...pair(1.05, -6.05, 0.36, 0.22), ...pair(1.05, -6.85, 0.36, 0.22)], lamp: { halfW: 1.0, y: 0.9, rear: -9.65 } },
  boat: { length: 8.5, axle: 5.0, wheels: pair(0.95, -5.0, 0.33, 0.2), lamp: { halfW: 0.62, y: 0.55, rear: -7.25 } },
  utility: { length: 4.3, axle: 3.0, wheels: pair(1.05, -3.0, 0.3, 0.18), lamp: { halfW: 0.85, y: 0.55, rear: -4.3 } },
};

/** 牵引车辆的挂钩球头位置（车辆局部 z）与离后轴的距离 */
export const HITCH: Partial<Record<VehicleType, { z: number; behindAxle: number }>> = {
  pickup: { z: -3.2, behindAxle: 3.2 + (PICKUP.axles[0] as number) },
  suv: { z: -2.55, behindAxle: 2.55 + (SUV.axles[0] as number) },
};

// ---------------- 几何体 ----------------

function carGeometry(type: 'sedan' | 'hatch' | 'suv' | 'pickup'): Geo {
  const b = new MeshBuilder();
  switch (type) {
    case 'sedan':
      carBody(b, SEDAN);
      carDetails(b, SEDAN, { grille: 'wide', tail: 'wide' });
      antenna(b, SEDAN);
      break;
    case 'hatch':
      carBody(b, HATCH);
      carDetails(b, HATCH, { grille: 'slim', tail: 'corner' });
      antenna(b, HATCH);
      break;
    case 'suv':
      carBody(b, SUV);
      carDetails(b, SUV, { grille: 'wide', tail: 'wide' });
      roofRails(b, SUV);
      antenna(b, SUV);
      break;
    case 'pickup':
      carBody(b, PICKUP, { rear: 'paint', front: 'paint' });
      carDetails(b, PICKUP, { grille: 'tall', rear: false });
      pickupBed(b, PICKUP);
      // 拖车钩座
      b.box('trim', 0.08, 0.08, 0.32, 0, 0.5, -PICKUP.L / 2 - 0.1);
      b.cyl('chrome', 0.035, 0.035, 0.07, 0, 0.58, -PICKUP.L / 2 - 0.24, 'y', 8);
      break;
  }
  return b.build();
}

const cache = new Map<VehicleType, Geo>();

export function vehicleGeometry(type: VehicleType): Geo {
  let g = cache.get(type);
  if (!g) {
    switch (type) {
      case 'van':
        g = van();
        break;
      case 'truck':
        g = boxTruck();
        break;
      case 'semi':
        g = tractor();
        break;
      case 'rv':
        g = rvClassA();
        break;
      default:
        g = carGeometry(type);
    }
    cache.set(type, g);
  }
  return g;
}

export type TrailerKind = 'dry' | 'reefer';
const trailerCache = new Map<TrailerKind, Geo>();

export function trailerGeometry(kind: TrailerKind): Geo {
  let g = trailerCache.get(kind);
  if (!g) {
    g = trailerVan(kind === 'reefer');
    trailerCache.set(kind, g);
  }
  return g;
}

const towCache = new Map<TowKind, Geo>();

/** 拖车几何体（原点在挂钩球头）；船拖车连同船一起，船体颜色按实例着色 */
export function towGeometry(kind: TowKind): Geo {
  let g = towCache.get(kind);
  if (!g) {
    if (kind === 'camper') g = travelTrailer();
    else if (kind === 'utility') g = utilityTrailer();
    else {
      const t = boatTrailer();
      const boat = bowrider();
      // 船底压在木垫梁上，船头靠着绞盘柱
      const place = (geo: THREE.BufferGeometry) => geo.clone().translate(0, 0.68, -4.95);
      const paint = mergeGeometries([place(boat.paint)], false) as THREE.BufferGeometry;
      const detail = mergeGeometries([t.detail, place(boat.detail)], false) as THREE.BufferGeometry;
      paint.computeBoundingSphere();
      detail.computeBoundingSphere();
      // 拖车车架本身没有车漆部件，船体的车漆就是这个拖车的实例颜色
      g = { paint, detail };
    }
    towCache.set(kind, g);
  }
  return g;
}

// ---------------- 车轮 ----------------

const wheelCache = new Map<'car' | 'truck', THREE.BufferGeometry>();

/** 车削体：points 为 (半径, 轴向位置)，轴沿 X */
function lathe(points: Array<[number, number]>, seg: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
  g.rotateZ(-Math.PI / 2);
  return g;
}

/**
 * 单位车轮（半径 1、宽 1，轴沿 X，两侧对称）：圆润的胎肩和胎侧、轮辋外圈；
 * 乘用车是五辐轮毂和中心盖，货车是带减重孔的钢圈 / 铝圈、凸出的轮毂和一圈螺母。
 */
export function wheelGeometry(kind: 'car' | 'truck' = 'car'): THREE.BufferGeometry {
  const hit = wheelCache.get(kind);
  if (hit) return hit;
  const b = new MeshBuilder();
  const rubber = MAT_COLOR.rubber;
  const sidewall = new THREE.Color('#2b2e32');
  const truck = kind === 'truck';
  // 轮胎外轮廓（半径, 轴向）：轮辋边 → 胎侧 → 胎肩圆角 → 胎面（略鼓）；胎侧颜色稍浅，受光时看得出轮胎的圆润
  const rimR = truck ? 0.66 : 0.64;
  const side: Array<[number, number]> = truck
    ? [
        [rimR, -0.47],
        [0.8, -0.5],
        [0.95, -0.49],
      ]
    : [
        [rimR, -0.44],
        [0.78, -0.49],
        [0.92, -0.48],
      ];
  const tread: Array<[number, number]> = truck
    ? [
        [0.95, -0.49],
        [0.99, -0.45],
        [1.0, -0.38],
        [1.0, 0.38],
        [0.99, 0.45],
        [0.95, 0.49],
      ]
    : [
        [0.92, -0.48],
        [0.975, -0.43],
        [1.0, -0.33],
        [1.0, 0.33],
        [0.975, 0.43],
        [0.92, 0.48],
      ];
  b.part(lathe(side, 22), 'rubber', sidewall);
  b.part(lathe(tread, 22), 'rubber', rubber);
  b.part(
    lathe(
      [...side].reverse().map(([r, y]) => [r, -y] as [number, number]),
      22,
    ),
    'rubber',
    sidewall,
  );
  const silver = truck ? new THREE.Color('#d6dade') : new THREE.Color('#c2c8cd');
  const dark = new THREE.Color('#2f3337');
  for (const sx of [-1, 1]) {
    const face = sx * 0.43;
    // 轮辋外圈
    const lip = new THREE.RingGeometry(rimR - 0.07, rimR + 0.005, 32);
    lip.rotateY(sx * (Math.PI / 2));
    lip.translate(sx * (truck ? 0.47 : 0.445), 0, 0);
    b.part(lip, 'chrome', silver);
    // 轮毂背板（辐条之间看进去是深色）
    const back = new THREE.CircleGeometry(rimR - 0.06, 28);
    back.rotateY(sx * (Math.PI / 2));
    back.translate(face - sx * 0.06, 0, 0);
    b.part(back, 'trim', dark);
    if (truck) {
      // 钢圈：碟形盘面 + 八个减重孔 + 凸出的轮毂 + 十颗螺母
      const disc = new THREE.RingGeometry(0.2, rimR - 0.07, 32);
      disc.rotateY(sx * (Math.PI / 2));
      disc.translate(face - sx * 0.02, 0, 0);
      b.part(disc, 'chrome', silver);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const hole = new THREE.CircleGeometry(0.07, 10);
        hole.rotateY(sx * (Math.PI / 2));
        hole.translate(face - sx * 0.01, Math.sin(a) * 0.42, Math.cos(a) * 0.42);
        b.part(hole, 'trim', dark);
      }
      b.cyl('chrome', 0.2, 0.15, 0.1, face + sx * 0.03, 0, 0, 'x', 16, new THREE.Color('#aeb4ba'));
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        b.box('chrome', 0.04, 0.045, 0.045, face + sx * 0.01, Math.sin(a) * 0.27, Math.cos(a) * 0.27, { color: new THREE.Color('#e8eaec') });
      }
    } else {
      // 五辐轮毂：辐条从中心盖伸到轮辋，外宽内窄
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        const spoke = new THREE.BufferGeometry();
        const r0 = 0.14;
        const r1 = rimR - 0.07;
        const w0 = 0.07;
        const w1 = 0.12;
        const pts = [
          [r0, -w0],
          [r1, -w1],
          [r1, w1],
          [r0, w0],
        ].map(([r, w]) => new THREE.Vector3(face, Math.sin(a) * (r as number) + Math.cos(a) * (w as number), Math.cos(a) * (r as number) - Math.sin(a) * (w as number)));
        const [p0, p1, p2, p3] = pts as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
        // 辐条略微凹进（盘面中间低）
        p1.x -= sx * 0.03;
        p2.x -= sx * 0.03;
        const pos = sx > 0 ? [p0, p2, p1, p0, p3, p2] : [p0, p1, p2, p0, p2, p3];
        spoke.setAttribute('position', new THREE.Float32BufferAttribute(pos.flatMap((p) => [p.x, p.y, p.z]), 3));
        spoke.computeVertexNormals();
        b.part(spoke, 'chrome', silver);
      }
      b.cyl('chrome', 0.15, 0.13, 0.05, face, 0, 0, 'x', 16, new THREE.Color('#9aa1a7'));
    }
  }
  const g = b.build().detail;
  wheelCache.set(kind, g);
  return g;
}
