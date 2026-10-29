import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { createRng } from '@storewright/domain';
import type { Rect, SiteLayout } from '../site';
import type { LotLayout } from '../lot';
import { polySdf, terrainY, waterAt } from '../terrain/waterPlan';
import { makeWindMaterial } from '../terrain/terrainMaterial';
import { toonGradient } from '../toon';

/**
 * 草丛与野花（高画质）：草坪、停车场绿岛、湖边和河岸的平地上撒一簇簇细长的草叶，随风摆动；
 * 春夏草丛间点缀几种颜色的小花。积雪时隐藏。只在高画质下绘制，数量有上限。
 */

const CAP = 7000;

function tuftGeometry(): THREE.BufferGeometry {
  const rng = createRng(3);
  const pos: number[] = [];
  const col: number[] = [];
  const dark = new THREE.Color('#5e8a3c');
  const light = new THREE.Color('#bfe07a');
  const n = 6;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.uniform(-0.4, 0.4);
    const h = rng.uniform(0.26, 0.46);
    const lean = rng.uniform(0.06, 0.16);
    const w = 0.045;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const r = (x: number, z: number): [number, number] => [x * ca - z * sa, x * sa + z * ca];
    const [x0, z0] = r(-w, 0.02);
    const [x1, z1] = r(w, 0.02);
    const [tx, tz] = r(lean * 0.3, 0.02 + lean);
    pos.push(x0, 0, z0, x1, 0, z1, tx, h, tz);
    for (const t of [0, 0, 1]) {
      const c = dark.clone().lerp(light, t);
      col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // 草叶的法线一律朝上，卡通光照下不会出现黑白两面
  const nrm = new Float32Array((pos.length / 3) * 3);
  for (let i = 0; i < nrm.length; i += 3) nrm.set([0, 1, 0], i);
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

const SEASON: Record<string, string[]> = {
  spring: ['#a9e07a', '#97d46a', '#b8e58a'],
  summer: ['#86c45a', '#7bbb52', '#94cc63'],
  autumn: ['#c9cf6a', '#b8c45c', '#d6c870'],
  winter: ['#b8b48c', '#aaa784', '#c2bd96'],
};
const FLOWERS = ['#f7a8c4', '#ffd75e', '#ffffff', '#c7a4f0', '#ff9a6a'].map((c) => new THREE.Color(c));

interface Spot {
  x: number;
  y: number;
  z: number;
  r: number;
  s: number;
}

function inRect(r: Rect, x: number, z: number): boolean {
  return Math.abs(x - r.x) < r.w / 2 && Math.abs(z - r.z) < r.d / 2;
}

/** 在哪里长草：草坪、绿岛、湖边和河岸的平地（避开步道、广场、道路和水面） */
function placeTufts(site: SiteLayout, lot: LotLayout, seed: number): Spot[] {
  const rng = createRng(seed * 811 + 9);
  const out: Spot[] = [];
  const w = site.water;
  const blocked = (x: number, z: number) =>
    site.asphalt.some((a) => inRect(a, x, z)) || site.sidewalks.some((a) => inRect(a, x, z)) || inRect({ x: w.plaza.x, z: w.plaza.z, w: w.plaza.w + 1, d: w.plaza.d + 1 }, x, z);
  const push = (x: number, z: number, y: number) => out.push({ x, y, z, r: rng.uniform(0, Math.PI * 2), s: rng.uniform(0.7, 1.3) });
  // 草坪与绿岛：按面积撒点
  for (const r of [...site.grass, ...lot.islands.map((i) => ({ x: i.x, z: i.z, w: i.w, d: i.d }))]) {
    const n = Math.min(900, Math.round(r.w * r.d * 0.45));
    for (let k = 0; k < n && out.length < CAP; k++) {
      const x = r.x + rng.uniform(-r.w / 2 + 0.2, r.w / 2 - 0.2);
      const z = r.z + rng.uniform(-r.d / 2 + 0.2, r.d / 2 - 0.2);
      if (site.ponds.some((p) => Math.hypot((x - p.x) / (p.rx + 0.4), (z - p.z) / (p.rz + 0.4)) < 1)) continue;
      push(x, z, 0.02);
    }
  }
  // 没有水面时只有草坪和绿岛（决策记录 0019）
  if (!w.enabled) return out;
  // 湖边：岸坡顶到步道之间、步道外侧的一圈平地
  const l = w.lake;
  const sh = l.shore;
  for (let k = 0; k < 9000 && out.length < CAP; k++) {
    const i = rng.int(0, sh.length - 1);
    const p = sh[i] as { x: number; z: number };
    const dx = p.x - l.cx;
    const dz = p.z - l.cz;
    const len = Math.hypot(dx, dz) || 1;
    const off = rng.uniform(l.bankBase * 0.6, w.pathOffset + 7);
    const x = p.x + (dx / len) * off + rng.uniform(-0.6, 0.6);
    const z = p.z + (dz / len) * off + rng.uniform(-0.6, 0.6);
    const s = -polySdf(sh, x, z);
    if (Math.abs(s - w.pathOffset) < 1.6) continue;
    if (waterAt(w, x, z).s > -0.3) continue;
    const y = terrainY(w, x, z);
    if (y < w.groundY - 0.25 || blocked(x, z)) continue;
    push(x, z, y);
  }
  // 河的自然段两岸
  for (let k = 0; k < 2500 && out.length < CAP; k++) {
    const z = rng.uniform(w.river.zCanalEnd + 4, w.river.zEnd - 6);
    const side = rng.chance(0.5) ? 1 : -1;
    const x0 = w.river.x;
    const x = x0 + side * rng.uniform(w.river.half + 1, w.river.half + 9);
    const at = waterAt(w, x, z);
    if (at.s > -0.4) continue;
    const y = terrainY(w, x, z);
    if (y < w.groundY - 0.6 || blocked(x, z)) continue;
    push(x, z, y);
  }
  return out;
}

export function Grass({ site, lot, seed, season, snow }: { site: SiteLayout; lot: LotLayout; seed: number; season: string; snow: boolean }) {
  const geo = useMemo(() => tuftGeometry(), []);
  const mat = useMemo(() => makeWindMaterial({ vertexColors: true, sway: 0.1, height: 0.45, side: THREE.DoubleSide }), []);
  const spots = useMemo(() => placeTufts(site, lot, seed), [site, lot, seed]);
  const flowers = useMemo(() => {
    if (season !== 'spring' && season !== 'summer') return [];
    const rng = createRng(seed * 37 + 2);
    return spots.filter(() => rng.chance(0.09)).map((s) => ({ ...s, x: s.x + rng.uniform(-0.2, 0.2), z: s.z + rng.uniform(-0.2, 0.2), c: rng.pick(FLOWERS) }));
  }, [spots, season, seed]);
  const ref = useRef<THREE.InstancedMesh>(null);
  const fref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new THREE.Object3D();
    const col = new THREE.Color();
    const pal = SEASON[season] ?? (SEASON.summer as string[]);
    spots.forEach((s, i) => {
      o.position.set(s.x, s.y - 0.02, s.z);
      o.rotation.set(0, s.r, 0);
      o.scale.set(s.s, s.s * (0.8 + 0.4 * ((i * 7) % 5) / 5), s.s);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, col.set(pal[i % pal.length] as string));
    });
    m.count = spots.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    const f = fref.current;
    if (f) {
      flowers.forEach((s, i) => {
        o.position.set(s.x, s.y + 0.3, s.z);
        o.rotation.set(0, s.r, 0);
        o.scale.setScalar(0.055);
        o.updateMatrix();
        f.setMatrixAt(i, o.matrix);
        f.setColorAt(i, s.c);
      });
      f.count = flowers.length;
      f.instanceMatrix.needsUpdate = true;
      if (f.instanceColor) f.instanceColor.needsUpdate = true;
      f.computeBoundingSphere();
    }
  }, [spots, flowers, season]);
  if (snow || !spots.length) return null;
  return (
    <group>
      <instancedMesh key={`g${spots.length}`} ref={ref} args={[geo, mat, spots.length]} receiveShadow />
      {flowers.length > 0 && (
        <instancedMesh key={`f${flowers.length}`} ref={fref} args={[undefined, undefined, flowers.length]}>
          <icosahedronGeometry args={[1, 0]} />
          <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
    </group>
  );
}
