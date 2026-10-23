import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * 车辆模型：每种车型由「车漆」和「细节」两部分合并几何体组成。
 * 车漆部分不带顶点色，按实例着色；细节部分（车窗、轮胎、灯、保险杠）带固定顶点色。
 * 车辆局部坐标：车头朝 +Z，原点在车底中心。
 */

import { type VehicleType } from './vehicleTypes';

export * from './vehicleTypes';

const C = {
  glass: new THREE.Color('#334552'),
  tire: new THREE.Color('#25282b'),
  rim: new THREE.Color('#b9bfc4'),
  head: new THREE.Color('#fff6d8'),
  tail: new THREE.Color('#d8322e'),
  trim: new THREE.Color('#4a4f54'),
  plate: new THREE.Color('#f2f2ea'),
  bed: new THREE.Color('#3a3d40'),
};

interface Part {
  geo: THREE.BufferGeometry;
  color?: THREE.Color;
}

function box(w: number, h: number, l: number, x: number, y: number, z: number, color?: THREE.Color, radius = 0): Part {
  const geo = radius > 0 ? new RoundedBoxGeometry(w, h, l, 2, radius) : new THREE.BoxGeometry(w, h, l);
  geo.translate(x, y, z);
  return { geo, color };
}

function wheel(x: number, z: number, r: number, w: number): Part[] {
  const tire = new THREE.CylinderGeometry(r, r, w, 14);
  tire.rotateZ(Math.PI / 2);
  tire.translate(x, r, z);
  const rim = new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10);
  rim.rotateZ(Math.PI / 2);
  rim.translate(x, r, z);
  return [
    { geo: tire, color: C.tire },
    { geo: rim, color: C.rim },
  ];
}

function wheels(halfTrack: number, zFront: number, zRear: number, r: number): Part[] {
  return [halfTrack, -halfTrack].flatMap((x) => [...wheel(x, zFront, r, 0.24), ...wheel(x, zRear, r, 0.24)]);
}

function lights(halfW: number, y: number, zFront: number, zRear: number): Part[] {
  return [halfW - 0.22, -(halfW - 0.22)].flatMap((x) => [box(0.32, 0.12, 0.06, x, y, zFront, C.head), box(0.3, 0.12, 0.06, x, y, zRear, C.tail)]);
}

/** 把同类部件合并成一个几何体；colored 为 true 时写入顶点色 */
function merge(parts: Part[], colored: boolean): THREE.BufferGeometry {
  const geos = parts.map((p) => {
    // RoundedBoxGeometry 是非索引几何体，统一转成非索引再合并
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    g.deleteAttribute('uv');
    if (colored) {
      const c = p.color ?? new THREE.Color('#ffffff');
      const n = g.getAttribute('position').count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    return g;
  });
  const out = mergeGeometries(geos, false);
  if (!out) throw new Error('车辆几何体合并失败');
  out.computeBoundingSphere();
  return out;
}

function build(type: Exclude<VehicleType, 'semi'>): { paint: Part[]; detail: Part[] } {
  switch (type) {
    case 'sedan': {
      const L = 4.7;
      return {
        paint: [box(1.82, 0.62, L, 0, 0.62, 0, undefined, 0.16), box(1.6, 0.08, 2.0, 0, 1.47, -0.25, undefined, 0.03)],
        detail: [
          box(1.62, 0.52, 2.35, 0, 1.18, -0.25, C.glass, 0.12),
          box(1.86, 0.16, 0.12, 0, 0.42, L / 2, C.trim),
          box(1.86, 0.16, 0.12, 0, 0.42, -L / 2, C.trim),
          box(0.5, 0.14, 0.02, 0, 0.62, -L / 2 - 0.02, C.plate),
          ...lights(0.91, 0.78, L / 2 + 0.01, -L / 2 - 0.01),
        ],
      };
    }
    case 'hatch': {
      const L = 4.1;
      return {
        paint: [box(1.76, 0.62, L, 0, 0.62, 0, undefined, 0.16), box(1.56, 0.08, 1.9, 0, 1.5, -0.55, undefined, 0.03)],
        detail: [
          box(1.58, 0.56, 2.25, 0, 1.2, -0.48, C.glass, 0.12),
          box(1.8, 0.16, 0.12, 0, 0.42, L / 2, C.trim),
          box(1.8, 0.16, 0.12, 0, 0.42, -L / 2, C.trim),
          ...lights(0.88, 0.8, L / 2 + 0.01, -L / 2 - 0.01),
        ],
      };
    }
    case 'suv': {
      const L = 4.8;
      return {
        paint: [box(1.94, 0.82, L, 0, 0.8, 0, undefined, 0.18), box(1.76, 0.08, 2.9, 0, 1.86, -0.35, undefined, 0.03)],
        detail: [
          box(1.78, 0.62, 3.1, 0, 1.5, -0.32, C.glass, 0.12),
          box(1.98, 0.2, 0.14, 0, 0.5, L / 2, C.trim),
          box(1.98, 0.2, 0.14, 0, 0.5, -L / 2, C.trim),
          box(1.6, 0.06, 2.4, 0, 1.94, -0.35, C.trim),
          ...lights(0.97, 1.0, L / 2 + 0.01, -L / 2 - 0.01),
        ],
      };
    }
    case 'pickup': {
      const L = 5.5;
      return {
        paint: [
          box(1.96, 0.78, L, 0, 0.82, 0, undefined, 0.16),
          box(1.84, 0.08, 1.7, 0, 1.92, 0.55, undefined, 0.03),
          box(0.1, 0.42, 2.25, 0.93, 1.42, -1.55),
          box(0.1, 0.42, 2.25, -0.93, 1.42, -1.55),
          box(1.96, 0.42, 0.1, 0, 1.42, -L / 2 + 0.05),
        ],
        detail: [
          box(1.84, 0.66, 1.9, 0, 1.56, 0.55, C.glass, 0.1),
          box(1.76, 0.04, 2.2, 0, 1.23, -1.55, C.bed),
          box(2.0, 0.2, 0.14, 0, 0.5, L / 2, C.trim),
          box(2.0, 0.2, 0.14, 0, 0.5, -L / 2, C.trim),
          ...lights(0.98, 1.0, L / 2 + 0.01, -L / 2 - 0.01),
        ],
      };
    }
    case 'van': {
      const L = 5.6;
      return {
        paint: [box(2.0, 2.0, L - 0.5, 0, 1.38, -0.25, undefined, 0.14), box(1.96, 0.72, 0.9, 0, 0.78, L / 2 - 0.45, undefined, 0.14)],
        detail: [
          box(1.9, 0.72, 0.5, 0, 1.72, L / 2 - 0.85, C.glass, 0.08),
          box(2.04, 0.36, 0.7, 0, 1.78, L / 2 - 1.4, C.glass),
          box(2.04, 0.2, 0.12, 0, 0.48, L / 2, C.trim),
          box(2.04, 0.2, 0.12, 0, 0.48, -L / 2, C.trim),
          ...lights(1.0, 0.92, L / 2 + 0.01, -L / 2 - 0.01),
        ],
      };
    }
    case 'truck': {
      const L = 7.6;
      return {
        paint: [box(2.1, 1.7, 1.9, 0, 1.25, L / 2 - 0.95, undefined, 0.12)],
        detail: [
          box(2.3, 2.6, 5.4, 0, 1.95, -0.95, new THREE.Color('#f1f2ee')),
          box(1.96, 0.7, 0.1, 0, 1.6, L / 2 + 0.01, C.glass),
          box(2.2, 0.24, 0.14, 0, 0.45, L / 2, C.trim),
          ...lights(1.05, 0.9, L / 2 + 0.01, -L / 2 + 0.6),
        ],
      };
    }
  }
}

/**
 * 半挂车的牵引车：原点在鞍座（牵引销）处，车头朝 +Z。驾驶室带卧铺，油箱、排气管、后视镜，鞍座板。
 * 挂车单独实例化，按铰接运动学跟随（决策记录 0013）。
 */
function buildTractor(): { paint: Part[]; detail: Part[] } {
  const chrome = new THREE.Color('#c9ced2');
  return {
    paint: [box(2.5, 2.3, 2.3, 0, 2.55, 3.9, undefined, 0.14), box(2.45, 1.0, 1.5, 0, 1.45, 5.0, undefined, 0.12), box(2.5, 1.9, 1.6, 0, 2.35, 2.05, undefined, 0.1)],
    detail: [
      box(2.3, 0.8, 0.06, 0, 3.0, 5.06, C.glass),
      box(0.06, 0.6, 1.0, 1.26, 2.9, 4.2, C.glass),
      box(0.06, 0.6, 1.0, -1.26, 2.9, 4.2, C.glass),
      box(2.6, 0.32, 0.22, 0, 0.72, 5.72, C.trim),
      box(1.0, 0.25, 6.4, 0, 1.0, 2.0, C.trim),
      box(1.8, 0.12, 1.4, 0, 1.28, 0, new THREE.Color('#2b2e31')),
      box(0.55, 0.55, 1.3, 1.08, 0.95, 2.6, chrome),
      box(0.55, 0.55, 1.3, -1.08, 0.95, 2.6, chrome),
      box(0.14, 2.2, 0.14, 1.2, 3.1, 2.9, chrome),
      box(0.14, 2.2, 0.14, -1.2, 3.1, 2.9, chrome),
      box(0.1, 0.5, 0.25, 1.42, 2.8, 4.9, C.trim),
      box(0.1, 0.5, 0.25, -1.42, 2.8, 4.9, C.trim),
      box(0.9, 0.32, 0.06, 0, 1.25, 5.82, chrome),
      ...lights(1.2, 1.1, 5.84, -1.3),
    ],
  };
}

/** 53 英尺厢式挂车：原点在牵引销处，向 −Z 延伸到车尾；冷藏挂车前端有冷机 */
function buildTrailer(reefer: boolean): { paint: Part[]; detail: Part[] } {
  const frame = new THREE.Color('#3d4247');
  const detail: Part[] = [
    box(2.6, 0.18, 14.4, 0, 1.22, -6.3, frame),
    box(0.12, 0.9, 0.12, 0.9, 0.7, -1.6, frame),
    box(0.12, 0.9, 0.12, -0.9, 0.7, -1.6, frame),
    box(0.06, 0.55, 6.5, 1.28, 0.95, -6.0, frame),
    box(0.06, 0.55, 6.5, -1.28, 0.95, -6.0, frame),
    box(2.4, 0.14, 0.14, 0, 0.6, -13.55, frame),
    box(0.08, 3.6, 0.1, 0, 3.1, -13.42, frame),
    box(2.62, 0.1, 0.1, 0, 4.92, -13.42, frame),
    ...lights(1.2, 1.4, -13.5, -13.5),
  ];
  if (reefer) detail.push(box(2.0, 1.5, 0.7, 0, 3.6, 1.15, new THREE.Color('#e8ebee')), box(1.6, 1.0, 0.04, 0, 3.6, 1.52, new THREE.Color('#3b4248')));
  return { paint: [box(2.6, 3.6, 14.6, 0, 3.1, -6.3, undefined, 0.06)], detail };
}

export type TrailerKind = 'dry' | 'reefer';
const trailerCache = new Map<TrailerKind, { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry }>();

export function trailerGeometry(kind: TrailerKind): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  let g = trailerCache.get(kind);
  if (!g) {
    const parts = buildTrailer(kind === 'reefer');
    g = { paint: merge(parts.paint, false), detail: merge(parts.detail, true) };
    trailerCache.set(kind, g);
  }
  return g;
}

/** 牵引销到牵引车车头、到挂车车尾、到挂车后轴的距离（米） */
export const SEMI = { kingpinToFront: 5.8, kingpinToRear: 13.6, kingpinToAxle: 12.2, center: 3.9 } as const;

export interface WheelSpec {
  x: number;
  z: number;
  r: number;
  w: number;
  /** 前轮：跟着方向盘转 */
  steer: boolean;
}

const pair = (halfTrack: number, z: number, r: number, w = 0.24, steer = false): WheelSpec[] => [
  { x: halfTrack, z, r, w, steer },
  { x: -halfTrack, z, r, w, steer },
];

/** 每种车型的车轮（车辆局部坐标，半挂车的牵引车以牵引销为原点） */
export const WHEEL_LAYOUT: Record<VehicleType, WheelSpec[]> = {
  sedan: [...pair(0.8, 1.45, 0.33, 0.24, true), ...pair(0.8, -1.4, 0.33)],
  hatch: [...pair(0.78, 1.28, 0.31, 0.24, true), ...pair(0.78, -1.25, 0.31)],
  suv: [...pair(0.86, 1.5, 0.38, 0.26, true), ...pair(0.86, -1.5, 0.38, 0.26)],
  pickup: [...pair(0.86, 1.75, 0.4, 0.26, true), ...pair(0.86, -1.75, 0.4, 0.26)],
  van: [...pair(0.88, 1.9, 0.36, 0.24, true), ...pair(0.88, -1.8, 0.36)],
  truck: [...pair(0.92, 2.7, 0.44, 0.26, true), ...pair(0.92, -1.6, 0.44, 0.46), ...pair(0.92, -2.6, 0.44, 0.46)],
  semi: [...pair(1.05, 4.6, 0.52, 0.3, true), ...pair(1.05, 0.65, 0.52, 0.5), ...pair(1.05, -0.65, 0.52, 0.5)],
};

/** 挂车的串联后轴（以牵引销为原点） */
export const TRAILER_WHEELS: WheelSpec[] = [...pair(1.05, -11.6, 0.52, 0.5), ...pair(1.05, -12.85, 0.52, 0.5)];

/** 车灯位置：半宽、高度、车头和车尾的 z（半挂车的车尾灯在挂车上） */
export const LAMP_LAYOUT: Record<VehicleType, { halfW: number; y: number; front: number; rear: number }> = {
  sedan: { halfW: 0.91, y: 0.78, front: 2.36, rear: -2.36 },
  hatch: { halfW: 0.88, y: 0.8, front: 2.06, rear: -2.06 },
  suv: { halfW: 0.97, y: 1.0, front: 2.41, rear: -2.41 },
  pickup: { halfW: 0.98, y: 1.0, front: 2.76, rear: -2.76 },
  van: { halfW: 1.0, y: 0.92, front: 2.81, rear: -2.81 },
  truck: { halfW: 1.05, y: 0.9, front: 3.81, rear: -3.2 },
  semi: { halfW: 1.2, y: 1.1, front: 5.85, rear: -13.52 },
};

let wheelGeo: THREE.BufferGeometry | undefined;
/** 单位车轮（半径 1、宽 1，轴沿 X）：轮胎、轮辋和三根轮辐（转动时看得出来） */
export function wheelGeometry(): THREE.BufferGeometry {
  if (wheelGeo) return wheelGeo;
  const tire = new THREE.CylinderGeometry(1, 1, 1, 16);
  tire.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.58, 0.58, 1.04, 12);
  rim.rotateZ(Math.PI / 2);
  const spokes: Part[] = [0, 1, 2].map((k) => {
    const g = new THREE.BoxGeometry(1.08, 0.12, 1.0);
    g.rotateX((k * Math.PI) / 3);
    return { geo: g, color: new THREE.Color('#6d7378') };
  });
  wheelGeo = merge([{ geo: tire, color: C.tire }, { geo: rim, color: C.rim }, ...spokes], true);
  return wheelGeo;
}

const cache = new Map<VehicleType, { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry }>();

export function vehicleGeometry(type: VehicleType): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  let g = cache.get(type);
  if (!g) {
    const parts = type === 'semi' ? buildTractor() : build(type);
    g = { paint: merge(parts.paint, false), detail: merge(parts.detail, true) };
    cache.set(type, g);
  }
  return g;
}

