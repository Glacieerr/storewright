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
          ...wheels(0.8, 1.45, -1.4, 0.33),
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
          ...wheels(0.78, 1.28, -1.25, 0.31),
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
          ...wheels(0.86, 1.5, -1.5, 0.38),
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
          ...wheels(0.86, 1.75, -1.75, 0.4),
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
          ...wheels(0.88, 1.9, -1.8, 0.36),
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
          ...wheels(0.92, 2.7, -2.6, 0.44),
          ...wheel(0.92, -1.6, 0.44, 0.24),
          ...wheel(-0.92, -1.6, 0.44, 0.24),
          ...lights(1.05, 0.9, L / 2 + 0.01, -L / 2 + 0.6),
        ],
      };
    }
  }
}

/** 半挂车：牵引车（车漆）+ 白色厢式挂车 */
function buildSemi(): { paint: Part[]; detail: Part[] } {
  const trailer = new THREE.Color('#f3f4f1');
  return {
    paint: [box(2.5, 2.2, 2.6, 0, 2.6, 8.4, undefined, 0.15), box(2.4, 1.0, 1.6, 0, 1.4, 9.1)],
    detail: [
      box(2.6, 3.0, 14.6, 0, 2.6, -2.6, trailer),
      box(2.3, 0.8, 0.08, 0, 3.0, 9.72, C.glass),
      box(2.6, 0.3, 0.2, 0, 0.7, 9.95, C.trim),
      box(1.0, 0.25, 6.0, 0, 1.0, 4.8, C.trim),
      box(0.5, 0.5, 1.4, 1.1, 0.9, 6.8, new THREE.Color('#9aa1a8')),
      ...wheel(1.05, 9.0, 0.52, 0.3),
      ...wheel(-1.05, 9.0, 0.52, 0.3),
      ...[5.6, 4.4, -7.6, -8.9].flatMap((z) => [...wheel(1.05, z, 0.52, 0.5), ...wheel(-1.05, z, 0.52, 0.5)]),
      ...lights(1.2, 1.1, 10.02, -9.95),
    ],
  };
}

const cache = new Map<VehicleType, { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry }>();

export function vehicleGeometry(type: VehicleType): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  let g = cache.get(type);
  if (!g) {
    const parts = type === 'semi' ? buildSemi() : build(type);
    g = { paint: merge(parts.paint, false), detail: merge(parts.detail, true) };
    cache.set(type, g);
  }
  return g;
}

