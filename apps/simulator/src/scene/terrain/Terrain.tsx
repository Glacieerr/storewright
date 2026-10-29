import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { createRng } from '@storewright/domain';
import type { SiteLayout } from '../site';
import { buildTerrain, buildWaterGrid, terrainPatches, terrainSample, type Patch } from './terrainGeometry';
import { harborSdf, riverSdf, riverX, smooth01, waterAt, type WaterPlan } from './waterPlan';
import { makeTerrainMaterial, makeTriplanarMaterial, makeWindMaterial } from './terrainMaterial';
import { linkStyle, makeCascadeMaterial, makeWaterMaterial } from './waterMaterial';
import { stoneTexture } from './textures';
import { toonGradient } from '../toon';

/**
 * 地形与水：挖出湖和河道的地面、湖面与河面（各自的水位）、跌水堰与水帘、渠道两侧的石墙与压顶石，
 * 以及岸边的石头、浅水里的芦苇、湖里的睡莲。全部由 site.water 推出，同一种子总是同一片风景。
 */

const tmp = new THREE.Object3D();
const col = new THREE.Color();

/** 一簇芦苇：几片细长的叶子向外倾斜，个别顶上有香蒲穗；顶点色由根部深绿到叶尖浅绿 */
function reedGeometry(): THREE.BufferGeometry {
  const rng = createRng(5);
  const pos: number[] = [];
  const colr: number[] = [];
  const dark = new THREE.Color('#4f7f3a');
  const light = new THREE.Color('#a8c86a');
  const n = 8;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.uniform(-0.3, 0.3);
    const h = rng.uniform(0.75, 1.35);
    const lean = rng.uniform(0.08, 0.28);
    const w = 0.035;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rot = (x: number, z: number): [number, number] => [x * ca - z * sa, x * sa + z * ca];
    const [bx0, bz0] = rot(-w, 0.04);
    const [bx1, bz1] = rot(w, 0.04);
    const [mx0, mz0] = rot(-w * 0.7 + lean * 0.4, 0.04 + lean * 0.5);
    const [mx1, mz1] = rot(w * 0.7 + lean * 0.4, 0.04 + lean * 0.5);
    const [tx, tz] = rot(lean, 0.04 + lean);
    const quad = [
      [bx0, 0, bz0, 0],
      [bx1, 0, bz1, 0],
      [mx1, h * 0.55, mz1, 0.55],
      [bx0, 0, bz0, 0],
      [mx1, h * 0.55, mz1, 0.55],
      [mx0, h * 0.55, mz0, 0.55],
      [mx0, h * 0.55, mz0, 0.55],
      [mx1, h * 0.55, mz1, 0.55],
      [tx, h, tz, 1],
    ];
    for (const [x, y, z, t] of quad) {
      pos.push(x as number, y as number, z as number);
      col.copy(dark).lerp(light, t as number);
      colr.push(col.r, col.g, col.b);
    }
    // 香蒲穗：一个细长的棕色小柱
    if (k % 3 === 0) {
      const cyl = new THREE.CylinderGeometry(0.035, 0.035, 0.22, 5).toNonIndexed();
      cyl.translate(tx * 0.92, h * 0.92, tz * 0.92);
      const p = cyl.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        pos.push(p.getX(i), p.getY(i), p.getZ(i));
        colr.push(0.42, 0.27, 0.16);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.computeVertexNormals();
  // 叶片的法线统一朝上偏外，卡通光照下不会一面黑一面白
  const nrm = g.getAttribute('normal');
  for (let i = 0; i < nrm.count; i++) {
    const x = g.getAttribute('position').getX(i);
    const z = g.getAttribute('position').getZ(i);
    const v = new THREE.Vector3(x, 1.4, z).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

/** 低多边形的石头：二十面体的顶点按噪声推拉，压扁 */
function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position');
  const rng = createRng(17);
  const seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let f = seen.get(k);
    if (f === undefined) {
      f = rng.uniform(0.78, 1.12);
      seen.set(k, f);
    }
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.62, p.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
}

/** 睡莲叶：缺一个口的圆片 */
function lilyGeometry(): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(1, 16, 0.35, Math.PI * 2 - 0.7);
  g.rotateX(-Math.PI / 2);
  return g;
}

function useInstances(ref: React.RefObject<THREE.InstancedMesh>, items: Array<{ x: number; y: number; z: number; ry: number; s: number; sy?: number; color?: THREE.Color }>): void {
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      tmp.position.set(it.x, it.y, it.z);
      tmp.rotation.set(0, it.ry, 0);
      tmp.scale.set(it.s, it.sy ?? it.s, it.s);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      if (it.color) m.setColorAt(i, it.color);
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [ref, items]);
}

/** 跌水的水帘：沿台阶外形的一条曲面，河水漫过堰顶落到湖面（河在北边、比湖面高；水向 −Z 流） */
function cascadeGeometry(w: WaterPlan): THREE.BufferGeometry {
  const r = w.river;
  const z0 = r.zWeir;
  const lake = w.lake.level;
  const riv = r.level;
  const drop = riv - lake;
  const prof: Array<[number, number]> = [
    [2.6, riv + 0.02],
    [2.1, riv + 0.04],
    [1.82, riv - drop * 0.09],
    [1.55, riv - drop * 0.33],
    [1.28, riv - drop * 0.42],
    [1.0, riv - drop * 0.66],
    [0.73, riv - drop * 0.74],
    [0.45, riv - drop * 0.97],
    [0.0, lake + 0.03],
  ];
  const x0 = r.x - r.half;
  const x1 = r.x + r.half;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let len = 0;
  const lens: number[] = [0];
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1] as [number, number];
    const b = prof[i] as [number, number];
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
    lens.push(len);
  }
  prof.forEach(([dz, y], i) => {
    pos.push(x0, y, z0 + dz, x1, y, z0 + dz);
    const v = (lens[i] as number) / len;
    uv.push(0, v, 1, v);
  });
  for (let i = 0; i < prof.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface StoneBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

/** 渠道的石墙、压顶石、跌水堰的台阶和墙端的石墩 */
function canalStones(w: WaterPlan): { walls: StoneBox[]; caps: StoneBox[] } {
  const r = w.river;
  const walls: StoneBox[] = [];
  const caps: StoneBox[] = [];
  const z0 = w.lake.neck.z0;
  const z1 = r.zCanalEnd;
  const g = w.groundY;
  const top = g + 0.04;
  for (const side of [-1, 1]) {
    const xi = r.x + side * r.half;
    const t = 0.55;
    walls.push({ x: xi + side * (t / 2), y: (r.bed + top) / 2, z: (z0 + z1) / 2, w: t, h: top - r.bed, d: z1 - z0 });
    caps.push({ x: xi + side * 0.28, y: top + 0.09, z: (z0 + z1) / 2, w: 0.85, h: 0.18, d: z1 - z0 + 0.3 });
    // 两端的石墩
    for (const zz of [z0, z1]) caps.push({ x: xi + side * 0.3, y: (r.bed + top + 0.55) / 2, z: zz, w: 1.0, h: top + 0.55 - r.bed, d: 1.0 });
  }
  // 跌水堰：三级台阶，从河水位（北边、上游）降到湖水位（南边、渠口）
  const steps = 3;
  const drop = r.level - w.lake.level;
  for (let k = 0; k < steps; k++) {
    const yt = r.level - 0.04 - (k * drop) / steps;
    const zs = r.zWeir + 1.65 - k * 0.55;
    walls.push({ x: r.x, y: (w.lake.bed + yt) / 2, z: zs + 0.275, w: r.half * 2, h: yt - w.lake.bed, d: 0.55 });
  }
  return { walls, caps };
}

function StoneBoxes({ items, material }: { items: StoneBox[]; material: THREE.Material }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((b, i) => {
      tmp.position.set(b.x, b.y, b.z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(b.w, b.h, b.d);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh key={items.length} ref={ref} args={[undefined, material, items.length]} castShadow receiveShadow>
      <boxGeometry />
    </instancedMesh>
  );
}

interface Scatter {
  x: number;
  y: number;
  z: number;
  ry: number;
  s: number;
  sy?: number;
  color?: THREE.Color;
}

/** 岸边的石头、浅水里的芦苇、湖里的睡莲（避开栈桥、广场、渠口） */
function scatter(w: WaterPlan, seed: number): { rocks: Scatter[]; reeds: Scatter[]; lilies: Scatter[]; flowers: Scatter[] } {
  const rng = createRng(seed * 911 + 5);
  const rocks: Scatter[] = [];
  const reeds: Scatter[] = [];
  const lilies: Scatter[] = [];
  const flowers: Scatter[] = [];
  const r = w.river;
  const l = w.lake;
  const p = w.pier;
  const nearPier = (x: number, z: number) => Math.abs(x - p.x) < p.head.w / 2 + 3 && z > p.zEnd - p.head.d - 3 && z < p.zLand + 2;
  const nearNeck = (x: number, z: number) => (x > l.neck.x0 - 3 && x < l.neck.x1 + 3 && z > l.neck.z0 - 3) || (!!w.outlet && Math.abs(x - w.outlet.x) < w.outlet.half + 4 && z < w.outlet.z1 + 4);
  const ROCK = ['#a9a294', '#9c968a', '#b8b1a2', '#8f8a80'].map((c) => new THREE.Color(c));
  // 河的自然段：水边一线石头和几丛芦苇
  for (let z = r.zCanalEnd + 2; z < r.zEnd - 4; z += rng.uniform(0.9, 2.2)) {
    for (const side of [-1, 1]) {
      if (rng.chance(0.45)) continue;
      const x = riverX(r, z) + side * (r.half + rng.uniform(-0.3, 0.5));
      const y = terrainSample(w, x, z).y;
      rocks.push({ x, y: y + 0.05, z, ry: rng.uniform(0, 6.28), s: rng.uniform(0.25, 0.65), color: rng.pick(ROCK) });
    }
    if (rng.chance(0.3)) {
      const side = rng.chance(0.5) ? 1 : -1;
      const x = riverX(r, z) + side * (r.half - rng.uniform(0.3, 1.0));
      reeds.push({ x, y: r.level - 0.05, z, ry: rng.uniform(0, 6.28), s: rng.uniform(0.8, 1.25) });
    }
  }
  // 湖岸：沿水边线走一圈；岸坡窄的地方放石头，宽（缓坡）的地方成片的芦苇
  const shore = l.shore;
  for (let i = 0; i < shore.length; i++) {
    const a = shore[i] as { x: number; z: number };
    const b = shore[(i + 1) % shore.length] as { x: number; z: number };
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    for (let t = 0; t < len; t += 0.8) {
      const x = a.x + ((b.x - a.x) * t) / len;
      const z = a.z + ((b.z - a.z) * t) / len;
      if (nearPier(x, z) || nearNeck(x, z)) continue;
      const ang = Math.atan2(z - l.cz, x - l.cx);
      const patch = 0.5 + 0.5 * Math.sin(ang * 5 + seed);
      if (patch > 0.62 && rng.chance(0.7)) {
        // 向湖里一点（多边形是逆时针，法线 (nx, nz) 指向内侧）
        const k = rng.uniform(0.4, 1.8);
        reeds.push({ x: x + nx * k, y: l.level - 0.05, z: z + nz * k, ry: rng.uniform(0, 6.28), s: rng.uniform(0.8, 1.3) });
      } else if (patch < 0.3 && rng.chance(0.35)) {
        const k = rng.uniform(-0.6, 0.4);
        const xx = x + nx * k;
        const zz = z + nz * k;
        rocks.push({ x: xx, y: terrainSample(w, xx, zz).y + 0.05, z: zz, ry: rng.uniform(0, 6.28), s: rng.uniform(0.3, 0.8), color: rng.pick(ROCK) });
      }
    }
  }
  // 睡莲：湖里离岸 2–8 米，成簇（通海的港池是咸水，没有睡莲）
  const centers: Array<{ x: number; z: number }> = [];
  for (let k = 0; k < 40 && centers.length < 6 && !w.outlet; k++) {
    const ang = rng.uniform(0, Math.PI * 2);
    const rr = rng.uniform(0.55, 0.85);
    const x = l.cx + Math.cos(ang) * l.rx * rr;
    const z = l.cz + Math.sin(ang) * l.rz * rr;
    const s = harborSdf(w, x, z);
    if (s < 2 || s > 8 || nearPier(x, z) || nearNeck(x, z)) continue;
    centers.push({ x, z });
  }
  const LILY = ['#5f9a4a', '#6aa652', '#7db35e'].map((c) => new THREE.Color(c));
  for (const c of centers) {
    const n = rng.int(6, 12);
    for (let i = 0; i < n; i++) {
      const x = c.x + rng.normal(0, 1.6);
      const z = c.z + rng.normal(0, 1.6);
      const s = waterAt(w, x, z);
      if (s.body !== 'lake' || s.s < 1) continue;
      const sz = rng.uniform(0.28, 0.55);
      lilies.push({ x, y: l.level + 0.02, z, ry: rng.uniform(0, 6.28), s: sz, color: rng.pick(LILY) });
      if (rng.chance(0.25)) flowers.push({ x: x + 0.05, y: l.level + 0.06, z: z + 0.05, ry: rng.uniform(0, 6.28), s: 0.13, color: new THREE.Color(rng.chance(0.6) ? '#f4a7c0' : '#fdf3f6') });
    }
  }
  return { rocks, reeds, lilies, flowers };
}

export function Terrain({ site, seed }: { site: SiteLayout; seed: number }) {
  const w = site.water;
  const ground = site.ground;
  const parts = useMemo(() => {
    const terrain = buildTerrain(w, ground);
    if (!w.enabled) return { terrain };
    const patches = terrainPatches(w, ground);
    const lakePatch = patches[0] as Patch;
    const r = w.river;
    // 港池（湖、渠口、出海水道和海湾）同一水面：渠口的水从跌水堰往南流进湖里，出海水道里的水流向海湾
    const o = w.outlet;
    const lakeWater = buildWaterGrid(
      lakePatch,
      0.9,
      w.lake.level,
      (x, z) => harborSdf(w, x, z),
      (x, z) => {
        if (x > w.lake.neck.x0 - 1 && x < w.lake.neck.x1 + 1 && z > w.lake.neck.z0 - 4) return [0, -0.35];
        if (o && Math.abs(x - o.x) < o.half + 1 && z < o.z1 && z > o.z0 - 6) return [0, -0.22];
        return [0.04, 0.025];
      },
      (x, z) => (x > w.lake.neck.x0 - 1 && x < w.lake.neck.x1 + 1 ? 1 - smooth01((w.river.zWeir - z) / 6) : 0),
    );
    const riverPatch = patches[1] ?? lakePatch;
    const riverWater = buildWaterGrid(
      { ...riverPatch, z0: r.zWeir + 2.1 },
      0.9,
      r.level,
      (x, z) => riverSdf(r, x, z),
      (x, z) => {
        // 河水往南（−Z）流向跌水堰
        const dx = riverX(r, z + 1) - riverX(r, z - 1);
        const k = 0.7 / Math.hypot(dx, 2);
        void x;
        return [-dx * k, -2 * k];
      },
      (_x, z) => 0.25 * (1 - smooth01((z - r.zWeir - 2.1) / 3)),
    );
    return { terrain, lakeWater, riverWater, cascade: cascadeGeometry(w), stones: canalStones(w), deco: scatter(w, seed) };
  }, [w, ground, seed]);

  const mats = useMemo(
    () => ({
      terrain: makeTerrainMaterial(),
      lake: linkStyle(makeWaterMaterial({ shallow: '#6fd6c6', deep: '#1c6684', depthRange: 7, foamWidth: 0.55, waves: 1 })),
      river: linkStyle(makeWaterMaterial({ shallow: '#5cc4bd', deep: '#25708a', depthRange: 4, foamWidth: 0.4, waves: 0 })),
      cascade: makeCascadeMaterial(),
      stone: makeTriplanarMaterial(stoneTexture(), 4, '#d9d2c2'),
      cap: makeTriplanarMaterial(stoneTexture(), 2.5, '#ece6d8'),
      reed: makeWindMaterial({ vertexColors: true, sway: 0.12, height: 1.2, side: THREE.DoubleSide }),
    }),
    [],
  );
  const reedGeo = useMemo(() => reedGeometry(), []);
  const rockGeo = useMemo(() => rockGeometry(), []);
  const lilyGeo = useMemo(() => lilyGeometry(), []);
  const rockRef = useRef<THREE.InstancedMesh>(null);
  const reedRef = useRef<THREE.InstancedMesh>(null);
  const lilyRef = useRef<THREE.InstancedMesh>(null);
  const flowerRef = useRef<THREE.InstancedMesh>(null);
  const none: Scatter[] = useMemo(() => [], []);
  useInstances(rockRef, parts.deco?.rocks ?? none);
  useInstances(reedRef, parts.deco?.reeds ?? none);
  useInstances(lilyRef, parts.deco?.lilies ?? none);
  useInstances(flowerRef, parts.deco?.flowers ?? none);
  if (!parts.deco || !parts.lakeWater || !parts.riverWater || !parts.cascade || !parts.stones) return <mesh geometry={parts.terrain} material={mats.terrain} receiveShadow />;
  const d = parts.deco;
  return (
    <group>
      <mesh geometry={parts.terrain} material={mats.terrain} receiveShadow />
      <mesh geometry={parts.lakeWater} material={mats.lake} receiveShadow={false} />
      <mesh geometry={parts.riverWater} material={mats.river} />
      <mesh geometry={parts.cascade} material={mats.cascade} />
      <StoneBoxes items={parts.stones.walls} material={mats.stone} />
      <StoneBoxes items={parts.stones.caps} material={mats.cap} />
      {d.rocks.length > 0 && (
        <instancedMesh key={`r${d.rocks.length}`} ref={rockRef} args={[rockGeo, undefined, d.rocks.length]} castShadow receiveShadow>
          <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
      {d.reeds.length > 0 && <instancedMesh key={`d${d.reeds.length}`} ref={reedRef} args={[reedGeo, mats.reed, d.reeds.length]} />}
      {d.lilies.length > 0 && (
        <instancedMesh key={`l${d.lilies.length}`} ref={lilyRef} args={[lilyGeo, undefined, d.lilies.length]}>
          <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} side={THREE.DoubleSide} />
        </instancedMesh>
      )}
      {d.flowers.length > 0 && (
        <instancedMesh key={`f${d.flowers.length}`} ref={flowerRef} args={[undefined, undefined, d.flowers.length]}>
          <coneGeometry args={[0.7, 0.8, 6]} />
          <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
    </group>
  );
}


/** 公园里的小水池：椭圆水面（同样的卡通水面材质）和一圈压边的卵石 */
export function Ponds({ ponds }: { ponds: SiteLayout['ponds'] }) {
  const parts = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    const stones: Scatter[] = [];
    const rng = createRng(ponds.length * 7 + 1);
    const ROCK = ['#b9b2a3', '#a8a194', '#c7c0b1'].map((c) => new THREE.Color(c));
    for (const p of ponds) {
      const sdf = (x: number, z: number) => (1 - Math.hypot((x - p.x) / p.rx, (z - p.z) / p.rz)) * Math.min(p.rx, p.rz);
      geos.push(buildWaterGrid({ x0: p.x - p.rx - 1, x1: p.x + p.rx + 1, z0: p.z - p.rz - 1, z1: p.z + p.rz + 1 }, 0.6, 0.035, sdf, () => [0.02, 0.01]));
      const n = Math.round((Math.PI * (p.rx + p.rz)) / 0.55);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        stones.push({ x: p.x + Math.cos(a) * (p.rx + 0.15), y: 0.05, z: p.z + Math.sin(a) * (p.rz + 0.15), ry: rng.uniform(0, 6.28), s: rng.uniform(0.28, 0.42), sy: rng.uniform(0.2, 0.3), color: rng.pick(ROCK) });
      }
    }
    return { geos, stones };
  }, [ponds]);
  const mat = useMemo(() => linkStyle(makeWaterMaterial({ shallow: '#69d2c2', deep: '#2e8a99', depthRange: 3, foamWidth: 0.3, waves: 0.6 })), []);
  const rockGeo = useMemo(() => rockGeometry(), []);
  const ref = useRef<THREE.InstancedMesh>(null);
  useInstances(ref, parts.stones);
  if (!ponds.length) return null;
  return (
    <group>
      {parts.geos.map((g, i) => (
        <mesh key={i} geometry={g} material={mat} />
      ))}
      <instancedMesh key={parts.stones.length} ref={ref} args={[rockGeo, undefined, Math.max(1, parts.stones.length)]} castShadow receiveShadow>
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
    </group>
  );
}
