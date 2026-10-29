import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { SiteLayout } from '../site';
import { balusterGeometry, boxGeo, mergeAll, TriBuilder } from './geom';
import { makeTriplanarMaterial, makeWorldTexMaterial } from './terrainMaterial';
import { asphaltTexture, paverTexture, stoneTexture } from './textures';
import { lampMetal, lanternGlass } from '../style/lights';

/**
 * 主路跨渠道的两孔石拱桥：
 * - 两侧桥面墙上各开两个半椭圆拱洞，拱下是弧形拱腹，中间桥墩两头有分水尖；
 * - 桥面与道路齐平（车流、行人照常通过），沥青路面和两侧人行道接着路上的铺装；
 * - 人行道外沿是石栏杆：底座、花瓶形栏杆柱、扶手，四角和中间是方形望柱，四角的望柱上立着灯笼（夜里亮起）；
 * - 桥面墙顶有一道挑出的檐口石。
 */

const SIDEWALK = 2.4;

interface BridgeParts {
  stone: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  road: THREE.BufferGeometry;
  walk: THREE.BufferGeometry;
  balusters: Array<{ x: number; y: number; z: number }>;
  poles: THREE.BufferGeometry;
  lanterns: THREE.BufferGeometry;
}

function buildBridge(site: SiteLayout): BridgeParts {
  const w = site.water;
  const b = w.bridge;
  const r = w.river;
  const top = b.deckTop;
  const arches: Array<[number, number]> = [
    [r.x - r.half, r.x - b.pierHalf],
    [r.x + b.pierHalf, r.x + r.half],
  ];
  const stone: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const FACE = 0.5;

  // 桥面墙（两侧各一面），开两个拱洞
  for (const [zf, dir] of [
    [b.z0, 1],
    [b.z1, -1],
  ] as const) {
    const shape = new THREE.Shape();
    shape.moveTo(b.x0, r.bed - 0.3);
    shape.lineTo(b.x1, r.bed - 0.3);
    shape.lineTo(b.x1, top - 0.06);
    shape.lineTo(b.x0, top - 0.06);
    shape.closePath();
    for (const [a0, a1] of arches) {
      const hole = new THREE.Path();
      hole.moveTo(a0, r.bed);
      hole.lineTo(a0, b.spring);
      hole.absellipse((a0 + a1) / 2, b.spring, (a1 - a0) / 2, b.crown - b.spring, Math.PI, 0, true, 0);
      hole.lineTo(a1, r.bed);
      hole.closePath();
      shape.holes.push(hole);
    }
    const g = new THREE.ExtrudeGeometry(shape, { depth: FACE, bevelEnabled: false, curveSegments: 18 });
    // 拉伸方向是 +Z：外侧面落在 zf，向桥内延伸
    g.translate(0, 0, dir > 0 ? zf : zf - FACE);
    stone.push(g);
    // 檐口石：挑出墙面
    const zc0 = dir > 0 ? zf - 0.2 : zf - 0.25;
    const zc1 = dir > 0 ? zf + 0.25 : zf + 0.2;
    trim.push(boxGeo(b.x0 - 0.15, b.x1 + 0.15, -0.36, -0.06, zc0, zc1));
    // 拱券石：沿拱洞边缘一圈略微突出的石带
    for (const [a0, a1] of arches) {
      const cx = (a0 + a1) / 2;
      const ra = (a1 - a0) / 2;
      const rb = b.crown - b.spring;
      const tb = new TriBuilder();
      const n = 18;
      const out = new THREE.Vector3(0, 0, dir > 0 ? -1 : 1);
      const zo = dir > 0 ? zf - 0.06 : zf + 0.06;
      const zi = dir > 0 ? zf : zf;
      for (let i = 0; i < n; i++) {
        const t0 = Math.PI - (i / n) * Math.PI;
        const t1 = Math.PI - ((i + 1) / n) * Math.PI;
        const p = (t: number, k: number, z: number) => new THREE.Vector3(cx + Math.cos(t) * ra * k, b.spring + Math.sin(t) * rb * k, z);
        const k = 1.16;
        tb.quad(p(t0, 1, zo), p(t1, 1, zo), p(t1, k, zo), p(t0, k, zo), out);
        // 拱券石的内侧小面
        const nIn = new THREE.Vector3(-Math.cos((t0 + t1) / 2), -Math.sin((t0 + t1) / 2), 0);
        tb.quad(p(t0, 1, zi), p(t1, 1, zi), p(t1, 1, zo), p(t0, 1, zo), nIn);
      }
      trim.push(tb.build());
    }
  }

  // 拱腹：两面桥面墙之间的弧形顶
  for (const [a0, a1] of arches) {
    const cx = (a0 + a1) / 2;
    const ra = (a1 - a0) / 2;
    const rb = b.crown - b.spring;
    const tb = new TriBuilder();
    const n = 18;
    const za = b.z0 + FACE;
    const zb = b.z1 - FACE;
    for (let i = 0; i < n; i++) {
      const t0 = Math.PI - (i / n) * Math.PI;
      const t1 = Math.PI - ((i + 1) / n) * Math.PI;
      const p = (t: number, z: number) => new THREE.Vector3(cx + Math.cos(t) * ra, b.spring + Math.sin(t) * rb, z);
      const nrm = (t: number) => new THREE.Vector3(-Math.cos(t) / ra, -Math.sin(t) / rb, 0).normalize();
      tb.quad(p(t0, za), p(t1, za), p(t1, zb), p(t0, zb), nrm(t0), nrm(t1), nrm(t1), nrm(t0));
    }
    stone.push(tb.build());
  }

  // 中间桥墩与两头的分水尖
  const ph = b.pierHalf;
  const pierTop = b.spring + 0.12;
  stone.push(boxGeo(r.x - ph, r.x + ph, r.bed, pierTop, b.z0 - 0.2, b.z1 + 0.2));
  for (const [z, s] of [
    [b.z0 - 0.2, -1],
    [b.z1 + 0.2, 1],
  ] as const) {
    const shape = new THREE.Shape();
    shape.moveTo(r.x - ph, -z);
    shape.lineTo(r.x + ph, -z);
    shape.lineTo(r.x, -(z + s * 1.1));
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: pierTop - r.bed, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, r.bed, 0);
    stone.push(g);
    // 墩帽
    const cap = new THREE.Shape();
    cap.moveTo(r.x - ph - 0.1, -z);
    cap.lineTo(r.x + ph + 0.1, -z);
    cap.lineTo(r.x, -(z + s * 1.25));
    cap.closePath();
    const cg = new THREE.ExtrudeGeometry(cap, { depth: 0.14, bevelEnabled: false });
    cg.rotateX(-Math.PI / 2);
    cg.translate(0, pierTop, 0);
    trim.push(cg);
  }
  trim.push(boxGeo(r.x - ph - 0.1, r.x + ph + 0.1, pierTop, pierTop + 0.14, b.z0 - 0.2, b.z1 + 0.2));

  // 桥身（藏在里面）、路面、人行道和路缘石
  stone.push(boxGeo(b.x0, b.x1, b.crown, top - 0.3, b.z0 + FACE, b.z1 - FACE));
  const road = boxGeo(b.x0, b.x1, top - 0.3, top, b.z0 + SIDEWALK, b.z1 - SIDEWALK);
  const walks = [boxGeo(b.x0, b.x1, top - 0.3, 0.08, b.z0, b.z0 + SIDEWALK), boxGeo(b.x0, b.x1, top - 0.3, 0.08, b.z1 - SIDEWALK, b.z1)];
  trim.push(boxGeo(b.x0, b.x1, top - 0.02, 0.1, b.z0 + SIDEWALK - 0.18, b.z0 + SIDEWALK), boxGeo(b.x0, b.x1, top - 0.02, 0.1, b.z1 - SIDEWALK, b.z1 - SIDEWALK + 0.18));
  // 城郊干道：桥上的中央隔离带是一道矮石台
  if (site.style === 'arterial') {
    const zc = site.roadTopZ - (site.roadTopZ - site.roadBottomZ) / 2;
    trim.push(boxGeo(b.x0, b.x1, top, 0.24, zc - 1.2, zc + 1.2));
  }

  // 石栏杆
  const balusters: BridgeParts['balusters'] = [];
  const poles: THREE.BufferGeometry[] = [];
  const lanterns: THREE.BufferGeometry[] = [];
  const posts = [b.x0 + 0.28, r.x, b.x1 - 0.28];
  for (const ze of [b.z0 + 0.2, b.z1 - 0.2]) {
    trim.push(boxGeo(b.x0, b.x1, 0.08, 0.22, ze - 0.17, ze + 0.17));
    trim.push(boxGeo(b.x0, b.x1, 0.84, 0.98, ze - 0.16, ze + 0.16));
    for (const px of posts) {
      stone.push(boxGeo(px - 0.24, px + 0.24, 0.08, 1.1, ze - 0.24, ze + 0.24));
      trim.push(boxGeo(px - 0.3, px + 0.3, 1.1, 1.22, ze - 0.3, ze + 0.3));
    }
    for (let x = b.x0 + 0.6; x < b.x1 - 0.5; x += 0.3) {
      if (posts.some((px) => Math.abs(px - x) < 0.38)) continue;
      balusters.push({ x, y: 0.22, z: ze });
    }
    // 四角望柱上的灯笼：灯杆 + 灯笼 + 宝顶
    for (const px of [posts[0] as number, posts[2] as number]) {
      const pole = new THREE.CylinderGeometry(0.05, 0.07, 1.6, 8);
      pole.translate(px, 1.22 + 0.8, ze);
      poles.push(pole);
      const roof = new THREE.ConeGeometry(0.32, 0.26, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(px, 3.32, ze);
      poles.push(roof);
      poles.push(boxGeo(px - 0.2, px + 0.2, 2.78, 2.84, ze - 0.2, ze + 0.2));
      lanterns.push(boxGeo(px - 0.16, px + 0.16, 2.84, 3.2, ze - 0.16, ze + 0.16));
    }
  }

  return { stone: mergeAll(stone), trim: mergeAll(trim), road, walk: mergeAll(walks), balusters, poles: mergeAll(poles), lanterns: mergeAll(lanterns) };
}

const tmp = new THREE.Object3D();

export function Bridge({ site }: { site: SiteLayout }) {
  const parts = useMemo(() => buildBridge(site), [site]);
  const mats = useMemo(
    () => ({
      stone: makeTriplanarMaterial(stoneTexture(), 3.2, '#d8cfbd'),
      trim: makeTriplanarMaterial(stoneTexture(), 2.2, '#efe9dc'),
      road: makeWorldTexMaterial(asphaltTexture(), 8, '#8a929a'),
      walk: makeWorldTexMaterial(paverTexture(), 2.4, '#d9d4c8'),
      baluster: makeTriplanarMaterial(stoneTexture(), 2.2, '#efe9dc'),
    }),
    [],
  );
  const balGeo = useMemo(() => balusterGeometry(0.62, 0.065), []);
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    parts.balusters.forEach((p, i) => {
      tmp.position.set(p.x, p.y, p.z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.count = parts.balusters.length;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [parts]);
  return (
    <group>
      <mesh geometry={parts.stone} material={mats.stone} castShadow receiveShadow />
      <mesh geometry={parts.trim} material={mats.trim} castShadow receiveShadow />
      <mesh geometry={parts.road} material={mats.road} receiveShadow />
      <mesh geometry={parts.walk} material={mats.walk} receiveShadow />
      <instancedMesh key={parts.balusters.length} ref={ref} args={[balGeo, mats.baluster, Math.max(1, parts.balusters.length)]} castShadow />
      <mesh geometry={parts.poles} material={lampMetal} castShadow />
      <mesh geometry={parts.lanterns} material={lanternGlass} />
    </group>
  );
}
