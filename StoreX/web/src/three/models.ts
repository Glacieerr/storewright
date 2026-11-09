import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 三维模型的小零件：全部用代码生成（不下载任何模型），零件带顶点颜色，合并成一个几何体，
 * 同一种东西用一个 InstancedMesh 画（几百个机器人、车辆也只要几次绘制）。
 * 坐标：x 向右（布局的 x），z 向下（布局的 y），y 向上；模型默认朝 +x 方向。
 */
export type Part = THREE.BufferGeometry;

function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** 长方体：x、z 是中心，y 是底面高度 */
export function box(w: number, h: number, d: number, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0): Part {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y + h / 2, z);
  return paint(g, color);
}

/** 竖直圆柱 */
export function cyl(rTop: number, rBottom: number, h: number, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0, seg = 12): Part {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg).toNonIndexed();
  g.translate(x, y + h / 2, z);
  return paint(g, color);
}

/** 横放的圆柱（车轮）：轴沿 z */
export function wheel(r: number, w: number, color: THREE.ColorRepresentation, x: number, y: number, z: number): Part {
  const g = new THREE.CylinderGeometry(r, r, w, 12).toNonIndexed();
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return paint(g, color);
}

export function sphere(r: number, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0): Part {
  const g = new THREE.SphereGeometry(r, 12, 8).toNonIndexed();
  g.translate(x, y, z);
  return paint(g, color);
}

export function merge(parts: Part[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
  if (!g) throw new Error('merge failed');
  g.computeVertexNormals();
  return g;
}

/** 长方体，贴图按实际尺寸重复（每 2 米一张），长货架不会被拉伸 */
export function boxTiled(w: number, h: number, d: number, tile = 2): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const normal = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const px = pos.getX(i) + w / 2;
    const py = pos.getY(i) + h / 2;
    const pz = pos.getZ(i) + d / 2;
    // 侧面：u 沿水平方向、v 沿高度；顶面：u 沿 x、v 沿 z
    if (ny > 0.5) uv.setXY(i, px / tile, pz / tile);
    else if (nx > 0.5) uv.setXY(i, pz / tile, py / h);
    else uv.setXY(i, px / tile, py / h);
  }
  uv.needsUpdate = true;
  return g;
}

// —— 人和机器人、车辆（单位：米，朝 +x） ——

export const MODELS = {
  /** 人：身体（实例颜色区分岗位）+ 头 */
  personBody: (): THREE.BufferGeometry => merge([cyl(0.2, 0.24, 0.95, '#ffffff', 0, 0.12), cyl(0.12, 0.12, 0.12, '#ffffff', 0, 0)]),
  personHead: (): THREE.BufferGeometry => merge([sphere(0.15, '#f1c9a5', 0, 1.25)]),
  /** 货格机器人：在货格顶上跑的方块 */
  mfcBot: (): THREE.BufferGeometry => merge([box(0.72, 0.42, 0.72, '#f2b705', 0, 0), box(0.74, 0.08, 0.74, '#3b3b3b', 0, 0.42), box(0.3, 0.06, 0.05, '#e34948', 0.2, 0.5, 0)]),
  /** 补货机器人：低矮底盘 + 一个货箱 */
  amr: (): THREE.BufferGeometry => merge([box(0.95, 0.32, 0.7, '#e6e6e2', 0, 0.05), box(0.95, 0.04, 0.7, '#1baf7a', 0, 0.37), box(0.6, 0.34, 0.45, '#c8a46a', 0, 0.41), wheel(0.09, 0.06, '#222', 0.3, 0.09, 0.36), wheel(0.09, 0.06, '#222', -0.3, 0.09, 0.36), wheel(0.09, 0.06, '#222', 0.3, 0.09, -0.36), wheel(0.09, 0.06, '#222', -0.3, 0.09, -0.36)]),
  /** 盘点机器人：细高的塔 + 摄像头 */
  scanner: (): THREE.BufferGeometry => merge([cyl(0.32, 0.36, 0.35, '#f2f2ef', 0, 0.04), cyl(0.1, 0.12, 1.4, '#d8d8d4', 0, 0.39), box(0.18, 0.12, 0.3, '#2a78d6', 0.06, 1.55), box(0.06, 0.9, 0.1, '#202020', 0.12, 0.6)]),
  /** 洗地机器人 */
  scrubber: (): THREE.BufferGeometry => merge([box(0.95, 0.55, 0.7, '#4a7fd0', 0, 0.06), box(0.5, 0.25, 0.6, '#f2f2ef', -0.15, 0.61), box(0.12, 0.05, 0.8, '#202020', 0.45, 0.02)]),
  /** 送框小车：底盘 + 两层货箱 */
  cart: (): THREE.BufferGeometry => merge([box(1.0, 0.3, 0.75, '#e6e6e2', 0, 0.06), box(0.6, 0.3, 0.45, '#2a78d6', 0, 0.36), box(0.6, 0.3, 0.45, '#1baf7a', 0, 0.68), cyl(0.04, 0.04, 0.9, '#888', -0.4, 0.36, 0)]),
  /** 装柜机器人：小车 + 竖向升降臂 */
  loader: (): THREE.BufferGeometry => merge([box(1.0, 0.35, 0.8, '#e6e6e2', 0, 0.05), box(0.12, 2.0, 0.12, '#6250d6', -0.3, 0.4), box(0.5, 0.1, 0.5, '#6250d6', 0.05, 1.3), box(0.45, 0.3, 0.4, '#c8a46a', 0.05, 1.4)]),
  /** 自动托盘车 */
  pallet: (): THREE.BufferGeometry => merge([box(0.9, 1.4, 0.9, '#eda100', -0.45, 0.05), box(1.2, 0.08, 0.2, '#555', 0.55, 0.08, 0.28), box(1.2, 0.08, 0.2, '#555', 0.55, 0.08, -0.28), box(1.1, 0.12, 1.1, '#b48a52', 0.55, 0.16), box(1.0, 0.8, 1.0, '#d8c6a3', 0.55, 0.28)]),
  /** 半挂货车（车头朝 +x） */
  truck: (): THREE.BufferGeometry =>
    merge([
      box(12.5, 3.0, 2.5, '#eeeeec', -2.0, 1.1),
      box(2.4, 2.4, 2.45, '#2a78d6', 5.6, 0.9),
      box(0.1, 0.9, 2.0, '#26313c', 6.82, 2.0),
      box(13.5, 0.25, 0.4, '#333', -1.5, 0.75, 0),
      ...[-6.5, -5.2, 2.0, 5.6].flatMap((x) => [wheel(0.5, 0.3, '#1d1d1d', x, 0.5, 1.15), wheel(0.5, 0.3, '#1d1d1d', x, 0.5, -1.15)]),
    ]),
  /** 配送车（厢式） */
  van: (): THREE.BufferGeometry =>
    merge([box(4.2, 2.3, 2.1, '#f5f5f2', -0.6, 0.45), box(1.6, 1.5, 2.05, '#f5f5f2', 2.2, 0.45), box(0.05, 0.75, 1.8, '#26313c', 3.0, 1.15), box(4.2, 0.18, 2.12, '#1baf7a', -0.6, 1.6), ...[-2.0, 2.2].flatMap((x) => [wheel(0.38, 0.25, '#1d1d1d', x, 0.38, 0.95), wheel(0.38, 0.25, '#1d1d1d', x, 0.38, -0.95)])]),
  /** 小汽车：车身白色（实例颜色上色）+ 深色车窗 */
  car: (): THREE.BufferGeometry =>
    merge([box(4.3, 0.75, 1.8, '#ffffff', 0, 0.3), box(2.3, 0.6, 1.62, '#ffffff', -0.2, 1.05), box(2.35, 0.45, 1.66, '#2b3540', -0.2, 1.1), ...[-1.35, 1.35].flatMap((x) => [wheel(0.33, 0.22, '#1d1d1d', x, 0.33, 0.85), wheel(0.33, 0.22, '#1d1d1d', x, 0.33, -0.85)])]),
};

/** 顾客衣服、顾客车辆的颜色（按编号取，固定不变） */
export const SHIRTS = ['#c96f53', '#5f8fc9', '#83b26c', '#d7a84a', '#9b7bc4', '#c45f86', '#5aa7a2', '#8d8d86', '#d98f3e', '#4f6f9c'];
export const CAR_COLORS = ['#e9e9e6', '#2b2f36', '#8a9099', '#b8352e', '#2f5d9a', '#c9c3b6', '#3f6e4a', '#d9d4c7', '#5d6168', '#a07a3c'];
