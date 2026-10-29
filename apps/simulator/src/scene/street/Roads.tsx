import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { createRng } from '@storewright/domain';
import type { LotLayout } from '../lot';
import { SPOT_D, SPOT_W } from '../lot';
import type { Rect, SiteLayout } from '../site';
import { env } from '../environment';
import { toonGradient } from '../toon';
import { Slabs, type Slab } from './Slabs';
import { makeWorldTexMaterial } from '../terrain/terrainMaterial';
import { asphaltTexture, paverTexture } from '../terrain/textures';
import { subtractRects } from '../terrain/terrainGeometry';

/**
 * 路面：沥青（细小骨料、裂缝）、人行道方砖、花岗岩路缘石、路面标线（车道线、边线、停止线、
 * 人行横道、导向箭头）、井盖和雨水篦子；停车场的车位线、线上取货车位的彩色铺装和立牌。
 * 标线用受光照的材质（夜里不会自己发亮）。下雨时路面变深，积雪时变浅（逐帧调色）。
 */

const LW = 3.4;

/** 桥面那一段由桥自己画，这里挖掉 */
export function cutAt(rects: Rect[], cut: Rect): Rect[] {
  const c = { x0: cut.x - cut.w / 2, x1: cut.x + cut.w / 2, z0: cut.z - cut.d / 2, z1: cut.z + cut.d / 2 };
  return rects.flatMap((r) => {
    const p = { x0: r.x - r.w / 2, x1: r.x + r.w / 2, z0: r.z - r.d / 2, z1: r.z + r.d / 2 };
    if (p.x1 <= c.x0 || p.x0 >= c.x1 || p.z1 <= c.z0 || p.z0 >= c.z1) return [r];
    return subtractRects(p, [c]).map((q) => ({ ...r, x: (q.x0 + q.x1) / 2, z: (q.z0 + q.z1) / 2, w: q.x1 - q.x0, d: q.z1 - q.z0 }));
  });
}

/** 导向箭头贴图：0 直行，1 直行 + 左转，2 直行 + 右转，3 三向（左右两半的图集，按 u 偏移取） */
function arrowTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (g) {
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#ffffff';
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
    const cell = W / 4;
    for (let k = 0; k < 4; k++) {
      const cx = cell * k + cell / 2;
      // 竖杆与箭头（向上 = 行车方向）
      g.lineWidth = 14;
      g.beginPath();
      g.moveTo(cx, H - 10);
      g.lineTo(cx, 70);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 26, 78);
      g.lineTo(cx, 22);
      g.lineTo(cx + 26, 78);
      g.closePath();
      g.fill();
      const turn = (dir: number) => {
        g.lineWidth = 12;
        g.beginPath();
        g.moveTo(cx, 170);
        g.quadraticCurveTo(cx, 130, cx + dir * 34, 128);
        g.stroke();
        g.beginPath();
        g.moveTo(cx + dir * 30, 104);
        g.lineTo(cx + dir * 58, 128);
        g.lineTo(cx + dir * 30, 152);
        g.closePath();
        g.fill();
      };
      if (k === 1 || k === 3) turn(-1);
      if (k === 2 || k === 3) turn(1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface Arrow {
  x: number;
  z: number;
  rotY: number;
  kind: 0 | 1 | 2 | 3;
}

function Arrows({ items }: { items: Arrow[] }) {
  const geos = useMemo(() => {
    // 每种箭头一个几何体（uv 指向图集里的那一格）
    return [0, 1, 2, 3].map((k) => {
      const g = new THREE.PlaneGeometry(1.5, 3.6);
      g.rotateX(-Math.PI / 2);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, (k + uv.getX(i)) / 4);
      return g;
    });
  }, []);
  const mat = useMemo(() => new THREE.MeshToonMaterial({ map: arrowTexture(), transparent: true, depthWrite: false, gradientMap: toonGradient(), color: '#f2f2ea', polygonOffset: true, polygonOffsetFactor: -2 }), []);
  const refs = [useRef<THREE.InstancedMesh>(null), useRef<THREE.InstancedMesh>(null), useRef<THREE.InstancedMesh>(null), useRef<THREE.InstancedMesh>(null)];
  const byKind = useMemo(() => [0, 1, 2, 3].map((k) => items.filter((a) => a.kind === k)), [items]);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    byKind.forEach((list, k) => {
      const m = refs[k]?.current;
      if (!m) return;
      list.forEach((a, i) => {
        o.position.set(a.x, -0.033, a.z);
        o.rotation.set(0, a.rotY, 0);
        o.scale.set(1, 1, 1);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      });
      m.count = list.length;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    });
  }, [byKind]);
  return (
    <group renderOrder={1}>
      {byKind.map((list, k) =>
        list.length ? <instancedMesh key={`${k}-${list.length}`} ref={refs[k]} args={[geos[k], mat, list.length]} renderOrder={1} /> : null,
      )}
    </group>
  );
}

/** 不是矩形的路面（喇叭口）：多边形三角化后挤出一点厚度，和矩形路面同高、同材质 */
function PolySlabs({ polys, y, h, material }: { polys: Array<Array<{ x: number; z: number }>>; y: number; h: number; material: THREE.Material }) {
  const geo = useMemo(() => {
    const pos: number[] = [];
    for (const poly of polys) {
      if (poly.length < 3) continue;
      const contour = poly.map((p) => new THREE.Vector2(p.x, p.z));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      // 顶面：每个三角形按法线朝上排顶点顺序
      for (const [a, b, c] of tris) {
        const pa = poly[a as number] as { x: number; z: number };
        const pb = poly[b as number] as { x: number; z: number };
        const pc = poly[c as number] as { x: number; z: number };
        // (b − a) × (c − a) 的 y 分量 = dz·ex − dx·ez；为负时法线朝下，换个顺序
        const ny = (pc.x - pa.x) * (pb.z - pa.z) - (pb.x - pa.x) * (pc.z - pa.z);
        for (const p of ny >= 0 ? [pa, pb, pc] : [pa, pc, pb]) pos.push(p.x, y + h, p.z);
      }
      // 侧面
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i] as { x: number; z: number };
        const q = poly[(i + 1) % poly.length] as { x: number; z: number };
        pos.push(p.x, y, p.z, q.x, y, q.z, q.x, y + h, q.z, p.x, y, p.z, q.x, y + h, q.z, p.x, y + h, p.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }, [polys, y, h]);
  if (!polys.length) return null;
  return <mesh geometry={geo} material={material} receiveShadow />;
}

/** 路缘石：沿人行道两条长边各一条，比人行道略高、颜色更浅 */
function curbsFor(walks: Rect[]): Slab[] {
  const out: Slab[] = [];
  for (const r of walks) {
    if (r.w >= r.d) for (const s of [-1, 1]) out.push({ x: r.x, z: r.z + s * (r.d / 2 - 0.09), w: r.w, d: 0.18 });
    else for (const s of [-1, 1]) out.push({ x: r.x + s * (r.w / 2 - 0.09), z: r.z, w: 0.18, d: r.d });
  }
  return out;
}

export function Roads({ site, lot, doorX }: { site: SiteLayout; lot: LotLayout; doorX: number }) {
  const statics = useMemo(() => {
    const b = site.water.bridge;
    const cut: Rect = { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, w: b.x1 - b.x0, d: b.z1 - b.z0 };
    const asphalt = cutAt(site.asphalt, cut);
    const walks = cutAt(site.sidewalks, cut);
    const lotAsphalt: Slab[] = [{ x: (lot.minX + lot.maxX) / 2, z: (lot.edgeZ + lot.frontZ) / 2, w: lot.maxX - lot.minX, d: lot.frontZ - lot.edgeZ }];
    const front: Slab[] = [{ x: (lot.minX + lot.maxX) / 2, z: lot.frontZ / 2, w: lot.maxX - lot.minX, d: -lot.frontZ }];
    const curbs = [...curbsFor(walks), { x: (lot.minX + lot.maxX) / 2, z: lot.frontZ + 0.09, w: lot.maxX - lot.minX, d: 0.18 }];

    // 车位线：每个车位两侧各一条，相邻车位共用；取货车位铺彩色并立牌
    const lineKeys = new Set<string>();
    const lines: Slab[] = [];
    const paint: Slab[] = [];
    const bayPosts: Slab[] = [];
    for (const s of lot.spots) {
      for (const dx of [-SPOT_W / 2, SPOT_W / 2]) {
        const k = `${(s.x + dx).toFixed(2)}|${s.z.toFixed(2)}`;
        if (lineKeys.has(k)) continue;
        lineKeys.add(k);
        lines.push({ x: s.x + dx, z: s.z, w: 0.12, d: SPOT_D * 0.92 });
      }
      if (s.kind === 'pickup') {
        paint.push({ x: s.x, z: s.z, w: SPOT_W - 0.35, d: SPOT_D - 0.5 });
        bayPosts.push({ x: s.x, z: s.z + (SPOT_D / 2 + 0.35) * (s.heading === 0 ? 1 : -1), w: 0.1, d: 0.1, h: 1.9 });
      }
    }
    const yellow: Slab[] = [{ x: (lot.minX + lot.maxX) / 2, z: lot.frontZ - 0.12, w: lot.maxX - lot.minX, d: 0.18 }];
    const zebra: Slab[] = [];
    for (let k = 0; k < 6; k++) zebra.push({ x: doorX - 2.5 + k * 1.0, z: lot.fireLaneZ, w: 0.5, d: 5.4 });

    // 路面标线：原有的车道线、人行横道，加上路边线和停止线
    const white: Slab[] = site.markings.filter((m) => m.color === 'white');
    const yellowMarks: Slab[] = site.markings.filter((m) => m.color === 'yellow');
    const gx0 = site.ground.x - site.ground.w / 2;
    const gx1 = site.ground.x + site.ground.w / 2;
    const gz0 = site.ground.z - site.ground.d / 2;
    const gz1 = site.ground.z + site.ground.d / 2;
    const gaps: Array<[number, number]> = [...site.intersections.map((k) => [k.x - k.half - 1.5, k.x + k.half + 1.5] as [number, number]), ...site.edgeGaps];
    const edge = (z: number) => {
      let x0 = gx0;
      for (const [a, c] of [...gaps].sort((p, q) => p[0] - q[0])) {
        if (a > x0) white.push({ x: (x0 + a) / 2, z, w: a - x0, d: 0.15 });
        x0 = Math.max(x0, c);
      }
      if (gx1 > x0) white.push({ x: (x0 + gx1) / 2, z, w: gx1 - x0, d: 0.15 });
    };
    edge(site.roadTopZ - 0.3);
    edge(site.roadBottomZ + 0.3);
    for (const k of site.intersections) {
      for (const s of [-1, 1]) {
        const x = k.x + s * (k.half - 0.3);
        const a = site.roadBottomZ - 4.6;
        const c = site.roadTopZ + 4.6;
        if (a > gz0) white.push({ x, z: (gz0 + a) / 2, w: 0.15, d: a - gz0 });
        if (gz1 > c) white.push({ x, z: (c + gz1) / 2, w: 0.15, d: gz1 - c });
      }
    }
    // 停止线与导向箭头：每条有停车点的车道
    const arrows: Arrow[] = [];
    const lanesPerDir = Math.max(1, site.lanes.filter((l) => l.kind === 'main' && l.dir.x > 0).length);
    site.lanes.forEach((lane) => {
      const p = lane.pts[0];
      const rotY = Math.atan2(lane.dir.x, lane.dir.z);
      for (const st of lane.stops) {
        const x = p.x + lane.dir.x * st.d;
        const z = p.z + lane.dir.z * st.d;
        white.push({ x, z, w: Math.abs(lane.dir.x) > 0.5 ? 0.45 : LW - 0.3, d: Math.abs(lane.dir.x) > 0.5 ? LW - 0.3 : 0.45 });
        if (st.d < 16 || st.gate) continue;
        // 车道在同向车道中的位置：0 最外侧（靠路边）
        let kind: Arrow['kind'] = 0;
        if (lane.kind === 'main') {
          const fromEdge = lane.dir.x > 0 ? Math.round((site.roadTopZ - p.z) / LW - 0.5) : Math.round((p.z - site.roadBottomZ) / LW - 0.5);
          if (lanesPerDir === 1) kind = 3;
          else if (fromEdge === 0) kind = 2;
          else if (fromEdge === lanesPerDir - 1) kind = 1;
        } else kind = 3;
        arrows.push({ x: x - lane.dir.x * 9, z: z - lane.dir.z * 9, rotY: rotY + Math.PI, kind });
      }
    });
    // 出入口的进出箭头（直行箭头，指向行驶方向）
    for (const a of site.driveArrows) arrows.push({ x: a.x, z: a.z, rotY: a.rotY + Math.PI, kind: 0 });
    // 出入口的水泥铺装和隔离岛
    const aprons: Slab[] = site.aprons.map((r) => ({ ...r }));
    const medians: Slab[] = site.medians.map((r) => ({ ...r }));
    const medianCurbs: Slab[] = site.medians.map((r) => ({ ...r, w: r.w + 0.24, d: r.d + 0.24 }));

    // 井盖与雨水篦子
    const rng = createRng(site.water.lake.cx * 13 + 1);
    const manholes: Slab[] = [];
    const drains: Slab[] = [];
    for (const lane of site.lanes) {
      if (lane.kind !== 'main') continue;
      for (let d = rng.uniform(8, 30); d < lane.len - 8; d += rng.uniform(32, 48)) {
        const x = lane.pts[0].x + lane.dir.x * d;
        const z = lane.pts[0].z + lane.dir.z * d + rng.uniform(-0.4, 0.4);
        if (gaps.some(([a, c]) => x > a - 2 && x < c + 2) || (x > site.water.bridge.x0 - 1 && x < site.water.bridge.x1 + 1)) continue;
        manholes.push({ x, z, w: 0.7, d: 0.7 });
      }
    }
    for (let x = gx0 + 6; x < gx1 - 6; x += 24) {
      if (gaps.some(([a, c]) => x > a - 1 && x < c + 1) || (x > site.water.bridge.x0 - 1 && x < site.water.bridge.x1 + 1)) continue;
      drains.push({ x, z: site.roadTopZ - 0.35, w: 0.8, d: 0.36 }, { x: x + 12, z: site.roadBottomZ + 0.35, w: 0.8, d: 0.36 });
    }
    return { asphalt, walks, lotAsphalt, front, curbs, lines, paint, bayPosts, yellow, zebra, white, yellowMarks, arrows, manholes, drains, aprons, medians, medianCurbs };
  }, [site, lot, doorX]);

  const mats = useMemo(
    () => ({
      asphalt: makeWorldTexMaterial(asphaltTexture(), 8, '#858d95'),
      lot: makeWorldTexMaterial(asphaltTexture(), 7, '#939aa1'),
      walk: makeWorldTexMaterial(paverTexture(), 2.4, '#dcd6ca'),
      front: makeWorldTexMaterial(paverTexture(), 2.4, '#e4ded2'),
      curb: new THREE.MeshToonMaterial({ color: '#e9e6df', gradientMap: toonGradient() }),
      apron: makeWorldTexMaterial(paverTexture(), 3.2, '#cfcbc2'),
      median: new THREE.MeshToonMaterial({ color: '#8fae6a', gradientMap: toonGradient() }),
      paintW: new THREE.MeshToonMaterial({ color: '#f4f3ec', gradientMap: toonGradient() }),
      paintY: new THREE.MeshToonMaterial({ color: '#f0c13a', gradientMap: toonGradient() }),
      pickup: new THREE.MeshToonMaterial({ color: '#f2a66e', gradientMap: toonGradient() }),
      iron: new THREE.MeshToonMaterial({ color: '#4c5257', gradientMap: toonGradient() }),
    }),
    [],
  );
  // 路面湿滑、积雪：逐帧调色
  const tone = useMemo(
    () => ({
      asphalt: [new THREE.Color('#858d95'), new THREE.Color('#5d656d'), new THREE.Color('#aab1b7')] as const,
      lot: [new THREE.Color('#939aa1'), new THREE.Color('#68717a'), new THREE.Color('#b3b9be')] as const,
      walk: [new THREE.Color('#dcd6ca'), new THREE.Color('#bdb8ae'), new THREE.Color('#f0f2f2')] as const,
    }),
    [],
  );
  useFrame(() => {
    const wet = Math.min(1, env.wet);
    const cover = Math.min(1, env.snowCover);
    mats.asphalt.color.copy(tone.asphalt[0]).lerp(tone.asphalt[1], wet).lerp(tone.asphalt[2], cover * 0.8);
    mats.lot.color.copy(tone.lot[0]).lerp(tone.lot[1], wet).lerp(tone.lot[2], cover * 0.8);
    mats.walk.color.copy(tone.walk[0]).lerp(tone.walk[1], wet).lerp(tone.walk[2], cover);
    mats.front.color.copy(mats.walk.color).multiplyScalar(1.03);
  });

  const s = statics;
  return (
    <group>
      <Slabs items={s.asphalt} y={-0.1} h={0.06} color="#ffffff" receive material={mats.asphalt} />
      <PolySlabs polys={site.asphaltPolys} y={-0.1} h={0.06} material={mats.asphalt} />
      <Slabs items={s.aprons} y={-0.1} h={0.062} color="#ffffff" receive material={mats.apron} />
      <Slabs items={s.medianCurbs} y={-0.1} h={0.2} color="#ffffff" cast receive material={mats.curb} />
      <Slabs items={s.medians} y={-0.1} h={0.23} color="#ffffff" receive material={mats.median} />
      <Slabs items={s.lotAsphalt} y={-0.1} h={0.065} color="#ffffff" receive material={mats.lot} />
      <Slabs items={s.walks} y={-0.1} h={0.18} color="#ffffff" receive material={mats.walk} />
      <Slabs items={s.front} y={-0.1} h={0.18} color="#ffffff" receive material={mats.front} />
      <Slabs items={s.curbs} y={-0.1} h={0.205} color="#ffffff" cast receive material={mats.curb} />
      <Slabs items={s.white} y={-0.04} h={0.012} color="#ffffff" receive material={mats.paintW} />
      <Slabs items={s.yellowMarks} y={-0.04} h={0.012} color="#ffffff" receive material={mats.paintY} />
      <Slabs items={s.lines} y={-0.035} h={0.012} color="#ffffff" receive material={mats.paintW} />
      <Slabs items={s.paint} y={-0.036} h={0.012} color="#ffffff" receive material={mats.pickup} />
      <Slabs items={s.yellow} y={0.08} h={0.012} color="#ffffff" receive material={mats.paintY} />
      <Slabs items={s.zebra} y={-0.035} h={0.012} color="#ffffff" receive material={mats.paintW} />
      <Slabs items={s.manholes} y={-0.04} h={0.016} color="#ffffff" receive material={mats.iron} />
      <Slabs items={s.drains} y={-0.04} h={0.014} color="#ffffff" receive material={mats.iron} />
      <Slabs items={s.bayPosts} y={0} color="#ee8a35" />
      <Arrows items={s.arrows} />
    </group>
  );
}
