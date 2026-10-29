import * as THREE from 'three';
import type { Rect } from '../site';
import { boxSdf, carve, lakeBank, OUTLET_BANK, outletSdf, polySdf, riverBank, riverSdf, riverX, WALL_BANK, type WaterPlan } from './waterPlan';

/**
 * 地形网格：湖和河附近用 0.625 米的规则网格（高度由水系的有符号距离算出，岸坡平滑），
 * 其余平地用大块矩形。顶点色是岸边的沙土、湿泥、水下的深色；aGrass 标出草地的比例
 * （草地颜色在着色器里按季节和积雪统一给，见 terrainMaterial.ts）。
 */

export const TERRAIN_STEP = 0.625;

export interface Patch {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

interface Sample {
  y: number;
  /** 占主导的水体的水面高度（平地时为 undefined） */
  level?: number;
  kind: 'lake' | 'river' | 'ground';
}

export function terrainSample(w: WaterPlan, x: number, z: number): Sample {
  const g = w.groundY;
  if (!w.enabled) return { y: g, kind: 'ground' };
  const l = w.lake;
  const r = w.river;
  let best: Sample = { y: g, kind: 'ground' };
  const ls = polySdf(l.shore, x, z);
  if (ls > -12) {
    const y = carve(ls, lakeBank(l, x, z), g, l.level, l.bed);
    if (y < best.y) best = { y, level: l.level, kind: 'lake' };
  }
  const ns = boxSdf(l.neck, x, z);
  if (ns > -2) {
    const y = carve(ns, WALL_BANK, g, l.level, l.bed);
    if (y < best.y) best = { y, level: l.level, kind: 'lake' };
  }
  const os = outletSdf(w.outlet, x, z);
  if (os > -12) {
    const y = carve(os, OUTLET_BANK, g, l.level, w.outlet?.bed ?? l.bed);
    if (y < best.y) best = { y, level: l.level, kind: 'lake' };
  }
  const rs = riverSdf(r, x, z);
  if (rs > -12) {
    const y = carve(rs, riverBank(r, z), g, r.level, r.bed);
    if (y < best.y) best = { y, level: r.level, kind: 'river' };
  }
  return best;
}

/** 两块细网格：湖（含渠口和跌水堰）、河道（从堰下游到场地边缘）；x 方向网格线对齐渠道石墙 */
export function terrainPatches(w: WaterPlan, ground: Rect): Patch[] {
  const S = TERRAIN_STEP;
  const r = w.river;
  const anchor = r.x + r.half;
  const alignDown = (x: number) => anchor + Math.floor((x - anchor) / S) * S;
  const alignUp = (x: number) => anchor + Math.ceil((x - anchor) / S) * S;
  const gx0 = ground.x - ground.w / 2;
  const gx1 = ground.x + ground.w / 2;
  const gz0 = ground.z - ground.d / 2;
  const gz1 = ground.z + ground.d / 2;
  let lx0 = Infinity;
  let lx1 = -Infinity;
  let lz0 = Infinity;
  let lz1 = -Infinity;
  for (const p of w.lake.shore) {
    lx0 = Math.min(lx0, p.x);
    lx1 = Math.max(lx1, p.x);
    lz0 = Math.min(lz0, p.z);
    lz1 = Math.max(lz1, p.z);
  }
  if (!w.enabled) return [];
  const m = w.lake.bankBase + w.lake.bankVar + 1.5;
  // 湖的细网格要盖住整个湖岸（北岸可能比跌水堰更靠北）、堰、出海水道和海湾；河道的细网格从这里接着往北
  const lakeTop = Math.max(w.lake.neck.z1 + 2.75, lz1 + m);
  const o = w.outlet;
  if (o) {
    lx0 = Math.min(lx0, o.bay.cx - o.bay.rx - OUTLET_BANK, o.x - o.half - OUTLET_BANK);
    lx1 = Math.max(lx1, o.bay.cx + o.bay.rx + OUTLET_BANK, o.x + o.half + OUTLET_BANK);
    lz0 = Math.min(lz0, o.bay.cz - o.bay.rz);
  }
  const lake: Patch = { x0: alignDown(Math.min(lx0 - m, w.lake.neck.x0 - 2)), x1: alignUp(Math.max(lx1 + m, w.lake.neck.x1 + 2)), z0: lz0 - m, z1: lakeTop };
  let rx0 = Infinity;
  let rx1 = -Infinity;
  for (let z = lakeTop; z <= gz1; z += 2) {
    const c = riverX(r, z);
    const b = riverBank(r, z);
    rx0 = Math.min(rx0, c - r.half - b - 1.5);
    rx1 = Math.max(rx1, c + r.half + b + 1.5);
  }
  const river: Patch = { x0: alignDown(rx0), x1: alignUp(rx1), z0: lakeTop, z1: gz1 };
  const clip = (p: Patch): Patch => ({ x0: Math.max(gx0, p.x0), x1: Math.min(gx1, p.x1), z0: Math.max(gz0, p.z0), z1: Math.min(gz1, p.z1) });
  return [clip(lake), clip(river)].filter((p) => p.x1 - p.x0 > 1 && p.z1 - p.z0 > 1);
}

/** 从矩形里挖去若干轴对齐的洞，剩下的部分拆成矩形 */
export function subtractRects(base: Patch, holes: Patch[]): Patch[] {
  const zs = [...new Set([base.z0, base.z1, ...holes.flatMap((h) => [h.z0, h.z1])])].filter((z) => z >= base.z0 && z <= base.z1).sort((a, b) => a - b);
  const out: Patch[] = [];
  for (let i = 1; i < zs.length; i++) {
    const za = zs[i - 1] as number;
    const zb = zs[i] as number;
    if (zb - za < 1e-6) continue;
    const mid = (za + zb) / 2;
    let x = base.x0;
    for (const h of holes.filter((h) => mid > h.z0 && mid < h.z1).sort((a, b) => a.x0 - b.x0)) {
      if (h.x0 > x) out.push({ x0: x, x1: Math.min(h.x0, base.x1), z0: za, z1: zb });
      x = Math.max(x, h.x1);
    }
    if (base.x1 > x) out.push({ x0: x, x1: base.x1, z0: za, z1: zb });
  }
  return out.filter((p) => p.x1 - p.x0 > 1e-6);
}

const SAND = new THREE.Color('#dcc898');
const EARTH = new THREE.Color('#b4a27c');
const WET = new THREE.Color('#8f8566');
const DEEP = new THREE.Color('#3f5e58');
const tmp = new THREE.Color();

function shoreColor(s: Sample, ground: number, out: THREE.Color): number {
  if (s.level === undefined || s.y >= ground - 0.01) {
    out.setRGB(1, 1, 1);
    return 1;
  }
  const lvl = s.level;
  if (s.y >= lvl) {
    const t = (ground - s.y) / (ground - lvl);
    const grass = 1 - Math.min(1, Math.max(0, (t - 0.18) / 0.42));
    out.copy(s.kind === 'lake' ? SAND : EARTH);
    if (t > 0.82) out.lerp(WET, (t - 0.82) / 0.18);
    return grass;
  }
  const k = Math.min(1, (lvl - s.y) / 1.5);
  out.copy(WET).lerp(DEEP, k);
  return 0;
}

export function buildTerrain(w: WaterPlan, ground: Rect): THREE.BufferGeometry {
  const S = TERRAIN_STEP;
  const g = w.groundY;
  const patches = terrainPatches(w, ground);
  const pos: number[] = [];
  const col: number[] = [];
  const grass: number[] = [];
  const idx: number[] = [];
  for (const p of patches) {
    const nx = Math.max(1, Math.round((p.x1 - p.x0) / S));
    const nz = Math.max(1, Math.round((p.z1 - p.z0) / S));
    const dx = (p.x1 - p.x0) / nx;
    const dz = (p.z1 - p.z0) / nz;
    const base = pos.length / 3;
    for (let j = 0; j <= nz; j++) {
      const z = p.z0 + j * dz;
      for (let i = 0; i <= nx; i++) {
        const x = p.x0 + i * dx;
        const s = terrainSample(w, x, z);
        pos.push(x, s.y, z);
        grass.push(shoreColor(s, g, tmp));
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        // 交替对角线，坡面更均匀
        if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, c, d, a, d, b);
      }
  }
  const gx0 = ground.x - ground.w / 2;
  const gz0 = ground.z - ground.d / 2;
  for (const r of subtractRects({ x0: gx0, x1: gx0 + ground.w, z0: gz0, z1: gz0 + ground.d }, patches)) {
    const base = pos.length / 3;
    pos.push(r.x0, g, r.z0, r.x1, g, r.z0, r.x0, g, r.z1, r.x1, g, r.z1);
    for (let k = 0; k < 4; k++) {
      col.push(1, 1, 1);
      grass.push(1);
    }
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aGrass', new THREE.Float32BufferAttribute(grass, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** 水面网格：在 patch 范围内的规则网格，每个顶点带到水边线的距离（水里为正），只保留靠近水的格子 */
export function buildWaterGrid(
  p: Patch,
  step: number,
  y: number,
  sdf: (x: number, z: number) => number,
  flow: (x: number, z: number) => [number, number],
  foam: (x: number, z: number) => number = () => 0,
): THREE.BufferGeometry {
  const nx = Math.max(1, Math.round((p.x1 - p.x0) / step));
  const nz = Math.max(1, Math.round((p.z1 - p.z0) / step));
  const dx = (p.x1 - p.x0) / nx;
  const dz = (p.z1 - p.z0) / nz;
  const pos: number[] = [];
  const sd: number[] = [];
  const fl: number[] = [];
  const fo: number[] = [];
  const idx: number[] = [];
  const keep: number[] = [];
  for (let j = 0; j <= nz; j++) {
    const z = p.z0 + j * dz;
    for (let i = 0; i <= nx; i++) {
      const x = p.x0 + i * dx;
      const s = sdf(x, z);
      pos.push(x, y, z);
      sd.push(s);
      const f = flow(x, z);
      fl.push(f[0], f[1]);
      fo.push(foam(x, z));
      keep.push(s);
    }
  }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      if (Math.max(keep[a] as number, keep[b] as number, keep[c] as number, keep[d] as number) < -0.8) continue;
      idx.push(a, c, b, b, c, d);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSdf', new THREE.Float32BufferAttribute(sd, 1));
  geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(fl, 2));
  geo.setAttribute('aFoam', new THREE.Float32BufferAttribute(fo, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
