import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { coarseWheel, ensureSurface, MeshBuilder } from './builder';
import { carModel } from './cars';
import { MODEL_SPECS, type ModelKey } from './specs';
import { truckModel } from './trucks';

/**
 * 车辆模型库（决策记录见 docs；第一部分 Storewright 决策记录 0018 的车辆标准）：每种车型两级——
 * - near（近处）：放样的精模，不含车轮（区域车辆层单独画会转、会打方向的车轮，见 wheels.ts、fleet.ts 的 AXLES）；
 * - far（远处）：方块拼的简模（约 300–700 个三角形），车轮合在车身里。
 * withWheels：精模 + 合进去的简化车轮（不单独画车轮的地方用，例如港口、机场的外来货车）。
 * 几何体按需生成、缓存；都带 color、aPaint、aRough 三个属性（车漆乘实例颜色，见 builder.ts 的 usePaintMask）。
 */
export type Lod = 'near' | 'far';
const CARS = new Set<ModelKey>(['car', 'hatch', 'suv', 'mpv', 'pickup']);
const cache = new Map<string, THREE.BufferGeometry>();

function build(key: ModelKey, coarse: boolean): THREE.BufferGeometry {
  const g = CARS.has(key) ? carModel(key as 'car' | 'hatch' | 'suv' | 'mpv' | 'pickup', coarse) : truckModel(key, coarse);
  if (!g) throw new Error(`没有车型 ${key}`);
  return g;
}

/** 一种车型某一级的几何体（零件坐标：原点在车尾、车头朝 +x、地面 y = 0） */
export function modelGeometry(key: ModelKey, lod: Lod): THREE.BufferGeometry {
  const k = `${key}:${lod}`;
  let g = cache.get(k);
  if (!g) cache.set(k, (g = build(key, lod === 'far')));
  return g;
}

/** 合进车身的简化车轮（零件坐标） */
export function bakedWheels(key: ModelKey): THREE.BufferGeometry | undefined {
  const s = MODEL_SPECS[key];
  if (!s.axles.length) return undefined;
  const b = new MeshBuilder();
  b.coarse = true;
  for (const a of s.axles) for (const sx of [-1, 1]) coarseWheel(b, sx * a.half, a.x, a.r, a.dual ? 0.26 : 0.3, a.dual);
  return b.finish(0);
}

/** 合并几何体：先补齐、对齐属性（position、normal、color、aPaint、aRough），合不上就只用第一个 */
function mergeSafe(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'color', 'aPaint', 'aRough'];
  const prepared = list.map((g) => {
    const h = ensureSurface(g.index ? g.toNonIndexed() : g.clone());
    for (const n of Object.keys(h.attributes)) if (!names.includes(n)) h.deleteAttribute(n);
    if (!h.getAttribute('normal')) h.computeVertexNormals();
    return h;
  });
  const m = mergeGeometries(prepared, false);
  return m ?? (prepared[0] as THREE.BufferGeometry);
}

/** 精模 + 合进去的简化车轮 */
export function modelWithWheels(key: ModelKey): THREE.BufferGeometry {
  const k = `${key}:wheels`;
  let g = cache.get(k);
  if (!g) {
    const body = modelGeometry(key, 'near');
    const w = bakedWheels(key);
    g = w ? mergeSafe([body, w]) : body;
    g.computeBoundingSphere();
    cache.set(k, g);
  }
  return g;
}

/** 各车型两级的三角形数（统计、测试用） */
export function triangleCounts(): Record<ModelKey, { near: number; far: number }> {
  const out = {} as Record<ModelKey, { near: number; far: number }>;
  for (const key of Object.keys(MODEL_SPECS) as ModelKey[]) out[key] = { near: modelGeometry(key, 'near').getAttribute('position').count / 3, far: modelGeometry(key, 'far').getAttribute('position').count / 3 };
  return out;
}

export { ensureSurface, usePaintMask } from './builder';
export { wheelGeometry } from './wheels';
export { BODY_DIMS, bodyDims, DYNAMICS, HITCH_BEHIND, MODEL_SPECS, RIG_DIMS, TOW_DIMS, type AxleSpec, type BodyDimsSpec, type LampSpec, type ModelKey, type ModelSpec, type RigDimsSpec } from './specs';
