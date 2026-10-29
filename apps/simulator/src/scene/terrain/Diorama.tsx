import { useMemo } from 'react';
import * as THREE from 'three';
import type { SiteLayout } from '../site';
import { terrainSample } from './terrainGeometry';
import { harborSdf, riverSdf, type WaterPlan } from './waterPlan';
import { toonGradient } from '../toon';

/**
 * 沙盘底座（决策记录 0019）：场景只到门店周边一圈，不再有铺到天边的远处地面和远山。
 * 场地四边是竖直的断面：最上面一层表土，往下是黄褐色的土层和深色的岩层（几道横纹），底面是一块深色的板；
 * 断面的上沿跟着地形走（海湾、河道在边缘处切开，露出河床），水面在边缘处有一道半透明的水体断面。
 */

const BOTTOM = -9;
const STEP = 0.625;

const TOP = new THREE.Color('#8a9a5c');
const SOIL = new THREE.Color('#b08a5a');
const CLAY = new THREE.Color('#9a7550');
const ROCK = new THREE.Color('#6f665c');
const DEEP = new THREE.Color('#4f4a45');

/** 断面上某个深度（离地面多深）的颜色：表土 → 土层 → 两道浅色横纹 → 岩层 */
function strata(depth: number, out: THREE.Color): THREE.Color {
  if (depth < 0.45) return out.copy(TOP).lerp(SOIL, depth / 0.45);
  if (depth < 3.2) return out.copy(SOIL).lerp(CLAY, (depth - 0.45) / 2.75);
  if (depth < 3.5) return out.copy(CLAY).lerp(new THREE.Color('#c7a476'), 0.5);
  if (depth < 5.6) return out.copy(CLAY).lerp(ROCK, (depth - 3.5) / 2.1);
  if (depth < 5.85) return out.copy(ROCK).lerp(new THREE.Color('#8c8378'), 0.6);
  return out.copy(ROCK).lerp(DEEP, Math.min(1, (depth - 5.85) / 3));
}

interface Edge {
  /** 边上的起点、方向（沿边）、长度、朝外的法线 */
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  len: number;
}

function edgesOf(g: SiteLayout['ground']): Edge[] {
  const x0 = g.x - g.w / 2;
  const x1 = g.x + g.w / 2;
  const z0 = g.z - g.d / 2;
  const z1 = g.z + g.d / 2;
  // 四边都按逆时针走（从外面看是正面）
  return [
    { x0, z0, dx: 1, dz: 0, len: x1 - x0 },
    { x0: x1, z0, dx: 0, dz: 1, len: z1 - z0 },
    { x0: x1, z0: z1, dx: -1, dz: 0, len: x1 - x0 },
    { x0, z0: z1, dx: 0, dz: -1, len: z1 - z0 },
  ];
}

/** 四面断面：每 0.625 米一列，上沿是地形高度，每列在若干深度处分段（顶点色画出土层） */
function skirtGeometry(w: WaterPlan, ground: SiteLayout['ground']): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  const depths = [0, 0.45, 1.6, 3.2, 3.35, 3.5, 5.6, 5.72, 5.85, 7.5];
  const g = w.groundY;
  for (const e of edgesOf(ground)) {
    const n = Math.max(1, Math.round(e.len / STEP));
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * e.len;
      // 往里收 1 厘米取地形高度，避免和地形网格的边缘重合
      const x = e.x0 + e.dx * t;
      const z = e.z0 + e.dz * t;
      const top = terrainSample(w, x - e.dz * 0.01, z + e.dx * 0.01).y;
      for (const d of depths) {
        const y = Math.max(BOTTOM, Math.min(top, g) - d);
        pos.push(x, d === 0 ? top : y, z);
        strata(Math.max(0, g - y), c);
        // 水下的河床、海床更深更暗
        if (top < g - 0.05 && d < 0.5) c.lerp(new THREE.Color('#5f6a5e'), 0.6);
        col.push(c.r, c.g, c.b);
      }
      pos.push(x, BOTTOM, z);
      strata(g - BOTTOM, c);
      col.push(c.r, c.g, c.b);
    }
    const per = depths.length + 1;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < per - 1; k++) {
        const a = base + i * per + k;
        const b = base + (i + 1) * per + k;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** 边缘处的水体断面：水面高度到河床，只在水面切到场地边缘的那几段 */
function waterSections(w: WaterPlan, ground: SiteLayout['ground']): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  if (!w.enabled) return new THREE.BufferGeometry();
  for (const e of edgesOf(ground)) {
    const n = Math.max(1, Math.round(e.len / STEP));
    for (let i = 0; i < n; i++) {
      const ta = (i / n) * e.len;
      const tb = ((i + 1) / n) * e.len;
      const xa = e.x0 + e.dx * ta;
      const za = e.z0 + e.dz * ta;
      const xb = e.x0 + e.dx * tb;
      const zb = e.z0 + e.dz * tb;
      const xm = (xa + xb) / 2 - e.dz * 0.02;
      const zm = (za + zb) / 2 + e.dx * 0.02;
      const harbor = harborSdf(w, xm, zm) > 0;
      const river = riverSdf(w.river, xm, zm) > 0;
      if (!harbor && !river) continue;
      const level = harbor ? w.lake.level : w.river.level;
      const ya = terrainSample(w, xa - e.dz * 0.02, za + e.dx * 0.02).y;
      const yb = terrainSample(w, xb - e.dz * 0.02, zb + e.dx * 0.02).y;
      if (Math.min(ya, yb) >= level) continue;
      const b = pos.length / 3;
      // 往外挪 2 厘米，盖在土层断面前面
      const ox = e.dz * 0.02;
      const oz = -e.dx * 0.02;
      pos.push(xa + ox, level, za + oz, xb + ox, level, zb + oz, xa + ox, Math.min(ya, level), za + oz, xb + ox, Math.min(yb, level), zb + oz);
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function DioramaBase({ site }: { site: SiteLayout }) {
  const g = site.ground;
  const w = site.water;
  const parts = useMemo(() => ({ skirt: skirtGeometry(w, g), water: waterSections(w, g) }), [w, g]);
  return (
    <group>
      <mesh geometry={parts.skirt} receiveShadow>
        <meshToonMaterial vertexColors gradientMap={toonGradient()} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={parts.water} renderOrder={2}>
        <meshToonMaterial color="#3f8fa8" transparent opacity={0.72} depthWrite={false} gradientMap={toonGradient()} side={THREE.DoubleSide} />
      </mesh>
      {/* 底面 */}
      <mesh position={[g.x, BOTTOM - 0.02, g.z]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[g.w, g.d]} />
        <meshBasicMaterial color="#3b3733" side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
