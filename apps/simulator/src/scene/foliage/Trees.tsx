import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRng, type Rng } from '@storewright/domain';
import { makeWindMaterial } from '../terrain/terrainMaterial';
import { toonGradient } from '../toon';

/**
 * 卡通风格的树：
 * - 阔叶树：树干带两三根分枝，树冠由几团起伏的球体堆成；法线朝树冠中心外推（「球形法线」），
 *   卡通光照下整棵树冠是一大块柔和的明暗，而不是一颗颗碎面；顶点色下暗上亮；
 * - 针叶树：四层下垂的圆锥；
 * - 灌木：贴地的几团小球。
 * 树冠随风轻摆（顶点着色器），季节换颜色，冬天落叶树只剩稀疏的枝冠，下雪时树冠偏白。
 */

export interface TreeSpec {
  x: number;
  z: number;
  s: number;
  kind: 'round' | 'cone' | 'bush';
}

function jitterSphere(r: number, rng: Rng, cx: number, cy: number, cz: number, detail = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.getAttribute('position');
  const seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let f = seen.get(k);
    if (f === undefined) {
      f = rng.uniform(0.86, 1.1);
      seen.set(k, f);
    }
    p.setXYZ(i, p.getX(i) * f + cx, p.getY(i) * f * 0.92 + cy, p.getZ(i) * f + cz);
  }
  return g;
}

/** 球形法线 + 由下到上的明暗顶点色 */
function soften(g: THREE.BufferGeometry, center: THREE.Vector3, k: number, y0: number, y1: number, dark = 0.72): THREE.BufferGeometry {
  g.computeVertexNormals();
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const colors = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  const m = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i)).sub(center).normalize();
    m.set(n.getX(i), n.getY(i), n.getZ(i)).lerp(v, k).normalize();
    n.setXYZ(i, m.x, m.y, m.z);
    const t = Math.min(1, Math.max(0, (p.getY(i) - y0) / (y1 - y0)));
    const b = dark + (1 - dark) * t;
    colors.set([b, b, b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(
    list.map((g) => {
      const x = g.index ? g.toNonIndexed() : g;
      if (x.getAttribute('uv')) x.deleteAttribute('uv');
      return x;
    }),
    false,
  );
  if (!out) throw new Error('tree merge failed');
  out.computeBoundingSphere();
  return out;
}

function trunkGeometry(rng: Rng, h: number, branches: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const t = new THREE.CylinderGeometry(0.13, 0.24, h, 7);
  t.translate(0, h / 2, 0);
  parts.push(t);
  for (let k = 0; k < branches; k++) {
    const a = (k / branches) * Math.PI * 2 + rng.uniform(-0.4, 0.4);
    const len = rng.uniform(1.0, 1.5);
    const b = new THREE.CylinderGeometry(0.05, 0.09, len, 5);
    b.translate(0, len / 2, 0);
    b.rotateZ(rng.uniform(0.6, 0.9));
    b.rotateY(a);
    b.translate(0, h * rng.uniform(0.6, 0.8), 0);
    parts.push(b);
  }
  const g = merge(parts);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}

interface Variant {
  trunk: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
}

function broadleaf(seed: number): Variant {
  const rng = createRng(seed);
  const trunkH = rng.uniform(2.3, 2.8);
  const c = new THREE.Vector3(0, trunkH + 1.2, 0);
  const blobs: THREE.BufferGeometry[] = [jitterSphere(1.55, rng, 0, c.y, 0)];
  const n = 5;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.uniform(-0.3, 0.3);
    const r = rng.uniform(1.0, 1.3);
    blobs.push(jitterSphere(r, rng, Math.cos(a) * 1.15, c.y + rng.uniform(-0.55, 0.25), Math.sin(a) * 1.15));
  }
  blobs.push(jitterSphere(1.1, rng, rng.uniform(-0.3, 0.3), c.y + 1.15, rng.uniform(-0.3, 0.3)));
  const crown = soften(merge(blobs), c, 0.78, c.y - 1.7, c.y + 2.0);
  return { trunk: trunkGeometry(rng, trunkH + 0.6, 3), crown };
}

function conifer(seed: number): Variant {
  const rng = createRng(seed);
  const tiers: THREE.BufferGeometry[] = [];
  let y = 1.0;
  const T = 4;
  for (let k = 0; k < T; k++) {
    const r = 1.75 - k * 0.36;
    const h = 2.1 - k * 0.2;
    const g = new THREE.ConeGeometry(r, h, 10, 2);
    const p = g.getAttribute('position');
    // 每层下沿略微下垂、参差
    for (let i = 0; i < p.count; i++) {
      const yy = p.getY(i);
      if (yy < -h / 2 + 0.01) p.setY(i, yy - rng.uniform(0, 0.18));
    }
    g.translate(0, y + h / 2, 0);
    tiers.push(g);
    y += h * 0.58;
  }
  const c = new THREE.Vector3(0, 2.6, 0);
  const crown = soften(merge(tiers), c, 0.45, 0.8, y + 1.2, 0.68);
  return { trunk: trunkGeometry(rng, 1.4, 0), crown };
}

function bush(seed: number): Variant {
  const rng = createRng(seed);
  const blobs = [jitterSphere(0.75, rng, 0, 0.55, 0), jitterSphere(0.55, rng, 0.55, 0.45, 0.2), jitterSphere(0.55, rng, -0.5, 0.42, -0.15), jitterSphere(0.5, rng, 0.05, 0.9, -0.1)];
  const crown = soften(merge(blobs), new THREE.Vector3(0, 0.6, 0), 0.7, 0, 1.4, 0.7);
  const trunk = new THREE.BufferGeometry();
  trunk.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  return { trunk, crown };
}

/** 各季节的阔叶树树冠颜色；春天有几棵开粉花的树 */
const CROWN: Record<string, string[]> = {
  spring: ['#9fd67a', '#b4e08c', '#8fca6b', '#f4b6c8', '#a9dc85', '#c5e69a'],
  summer: ['#5fae4f', '#6dba58', '#4f9e46', '#7cc35f', '#5aa84d', '#68b456'],
  autumn: ['#eab33c', '#dc6a2e', '#f2c84c', '#c9502c', '#a6c86c', '#e39a36'],
  winter: ['#a08f7a', '#94846f', '#a99a84'],
};
const PINE: Record<string, string> = { spring: '#3f8a56', summer: '#357a4b', autumn: '#3d7a52', winter: '#3f6e55' };
const BUSH: Record<string, string> = { spring: '#7fc466', summer: '#5fa850', autumn: '#9cb85c', winter: '#7f8a62' };
const SNOW = new THREE.Color('#f4f7f8');

const tmp = new THREE.Object3D();
const col = new THREE.Color();

function hash(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function Trees({ trees, season, snow }: { trees: TreeSpec[]; season: string; snow: boolean }) {
  const variants = useMemo(() => ({ round: [broadleaf(3), broadleaf(11), broadleaf(29)], cone: [conifer(5), conifer(17)], bush: [bush(7), bush(13)] }), []);
  const crownMat = useMemo(() => makeWindMaterial({ vertexColors: true, sway: 0.06, height: 5 }), []);
  const bushMat = useMemo(() => makeWindMaterial({ vertexColors: true, sway: 0.03, height: 1.4 }), []);
  const trunkMat = useMemo(() => new THREE.MeshToonMaterial({ color: '#8a6a4f', vertexColors: true, gradientMap: toonGradient() }), []);
  const groups = useMemo(() => {
    const out: Array<{ key: string; variant: Variant; items: TreeSpec[]; kind: TreeSpec['kind'] }> = [];
    for (const kind of ['round', 'cone', 'bush'] as const) {
      const vs = variants[kind];
      vs.forEach((v, vi) => {
        const items = trees.filter((t) => t.kind === kind && Math.floor(hash(t.x, t.z) * vs.length) === vi);
        if (items.length) out.push({ key: `${kind}${vi}`, variant: v, items, kind });
      });
    }
    return out;
  }, [trees, variants]);
  return (
    <group>
      {groups.map((g) => (
        <TreeGroup key={`${g.key}-${g.items.length}`} group={g} season={season} snow={snow} crownMat={g.kind === 'bush' ? bushMat : crownMat} trunkMat={trunkMat} />
      ))}
    </group>
  );
}

function TreeGroup({ group, season, snow, crownMat, trunkMat }: { group: { variant: Variant; items: TreeSpec[]; kind: TreeSpec['kind'] }; season: string; snow: boolean; crownMat: THREE.Material; trunkMat: THREE.Material }) {
  const crown = useRef<THREE.InstancedMesh>(null);
  const trunk = useRef<THREE.InstancedMesh>(null);
  const { items, kind, variant } = group;
  const hasTrunk = variant.trunk.getAttribute('position').count > 0;
  useLayoutEffect(() => {
    const palette = CROWN[season] ?? (CROWN.autumn as string[]);
    const bare = season === 'winter' && kind === 'round';
    items.forEach((t, i) => {
      const h = hash(t.x, t.z);
      tmp.position.set(t.x, kind === 'bush' ? -0.05 : 0, t.z);
      tmp.rotation.set(0, h * Math.PI * 2, 0);
      tmp.scale.setScalar(t.s);
      tmp.updateMatrix();
      trunk.current?.setMatrixAt(i, tmp.matrix);
      // 冬天落叶树：树冠缩成稀疏的一团枝梢
      if (bare) {
        tmp.scale.set(t.s * 0.72, t.s * 0.62, t.s * 0.72);
        tmp.updateMatrix();
      }
      crown.current?.setMatrixAt(i, tmp.matrix);
      if (kind === 'cone') col.set(PINE[season] ?? '#3d7a52');
      else if (kind === 'bush') col.set(BUSH[season] ?? '#6fae58');
      else col.set(palette[Math.floor(h * 997) % palette.length] as string);
      col.offsetHSL(0, 0, (hash(t.z, t.x) - 0.5) * 0.06);
      if (snow) col.lerp(SNOW, kind === 'cone' ? 0.45 : 0.6);
      crown.current?.setColorAt(i, col);
    });
    for (const m of [crown.current, trunk.current]) {
      if (!m) continue;
      m.count = items.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [items, season, snow, kind]);
  return (
    <group>
      {hasTrunk && <instancedMesh ref={trunk} args={[variant.trunk, trunkMat, items.length]} castShadow />}
      <instancedMesh ref={crown} args={[variant.crown, crownMat, items.length]} castShadow receiveShadow />
    </group>
  );
}
