import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useApp } from '../state/store';
import { SPOT_D, SPOT_W } from './lot';
import { signalLight, type Rect } from './site';
import { trafficFor } from './traffic';
import { useSiteLayout } from './useSite';
import { toonGradient } from './toon';
import { env } from './environment';
import { t } from '../i18n';

const tmp = new THREE.Object3D();
const col = new THREE.Color();

interface Slab extends Rect {
  y?: number;
  h?: number;
  rotY?: number;
  color?: string;
}

/** 一组同材质的长方体（实例化绘制）：地面、路面、人行道、标线、建筑都用它 */
function Slabs({
  items,
  y = 0,
  h = 0.02,
  color,
  basic = false,
  colored = false,
  cast = false,
  receive = false,
  matRef,
}: {
  items: Slab[];
  y?: number;
  h?: number;
  color: string;
  basic?: boolean;
  colored?: boolean;
  cast?: boolean;
  receive?: boolean;
  matRef?: React.Ref<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((r, i) => {
      const hh = r.h ?? h;
      tmp.position.set(r.x, (r.y ?? y) + hh / 2, r.z);
      tmp.rotation.set(0, r.rotY ?? 0, 0);
      tmp.scale.set(r.w, hh, r.d);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      if (colored) m.setColorAt(i, col.set(r.color ?? color));
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items, y, h, color, colored]);
  if (!items.length) return null;
  return (
    <instancedMesh key={items.length} ref={ref} args={[undefined, undefined, items.length]} castShadow={cast} receiveShadow={receive}>
      <boxGeometry />
      {basic ? (
        <meshBasicMaterial ref={matRef as React.Ref<THREE.MeshBasicMaterial>} color={colored ? '#ffffff' : color} />
      ) : (
        <meshToonMaterial ref={matRef as React.Ref<THREE.MeshToonMaterial>} color={colored ? '#ffffff' : color} gradientMap={toonGradient()} />
      )}
    </instancedMesh>
  );
}

/** 两坡屋顶：沿 X 方向延伸的三棱柱，底面 1×1，高 1 */
function gableGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(0.5, 0);
  shape.lineTo(0, 1);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  g.rotateY(Math.PI / 2);
  return g;
}

function Roofs({ items }: { items: Array<{ x: number; z: number; w: number; d: number; y: number; h: number; ridgeX: boolean; color: string }> }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => gableGeometry(), []);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((r, i) => {
      tmp.position.set(r.x, r.y, r.z);
      tmp.rotation.set(0, r.ridgeX ? 0 : Math.PI / 2, 0);
      tmp.scale.set(r.ridgeX ? r.d : r.w, r.h, r.ridgeX ? r.w : r.d);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, col.set(r.color));
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh key={items.length} ref={ref} args={[geo, undefined, items.length]} castShadow receiveShadow>
      <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
    </instancedMesh>
  );
}

/** 各季节的落叶树树冠颜色；冬天落叶树只剩枝干 */
const CANOPY: Record<string, string[]> = {
  spring: ['#a9d38c', '#b8dc9a', '#9fcb82', '#f2b8c6', '#b3d896'],
  summer: ['#6fa15a', '#7aab63', '#5f9450', '#86b46c', '#6a9c57'],
  autumn: ['#d9a441', '#c8662f', '#e0b84f', '#b5502d', '#8fb573'],
  winter: ['#8b7a68', '#7f6f5f', '#8f806e', '#857563', '#7a6b5c'],
};

function Trees({ trees, season, snow }: { trees: Array<{ x: number; z: number; s: number; kind: 'round' | 'cone' }>; season: string; snow: boolean }) {
  const trunk = useRef<THREE.InstancedMesh>(null);
  const round = useRef<THREE.InstancedMesh>(null);
  const cone = useRef<THREE.InstancedMesh>(null);
  const rounds = useMemo(() => trees.filter((t) => t.kind === 'round'), [trees]);
  const cones = useMemo(() => trees.filter((t) => t.kind === 'cone'), [trees]);
  useLayoutEffect(() => {
    const t = trunk.current;
    const r = round.current;
    const c = cone.current;
    trees.forEach((tr, i) => {
      tmp.position.set(tr.x, 0.8 * tr.s, tr.z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(tr.s, tr.s, tr.s);
      tmp.updateMatrix();
      t?.setMatrixAt(i, tmp.matrix);
    });
    const palette = CANOPY[season] ?? (CANOPY.autumn as string[]);
    const bare = season === 'winter';
    rounds.forEach((tr, i) => {
      tmp.position.set(tr.x, 2.7 * tr.s, tr.z);
      tmp.rotation.set(0, (tr.x * 13 + tr.z * 7) % Math.PI, 0);
      // 冬天落叶后树冠变得稀疏（缩小、偏枝干色）
      const k = bare ? 0.55 : 1;
      tmp.scale.set(tr.s * k, tr.s * 0.9 * k, tr.s * k);
      tmp.updateMatrix();
      r?.setMatrixAt(i, tmp.matrix);
      col.set(palette[Math.abs(Math.round(tr.x * 3 + tr.z)) % palette.length] as string);
      if (snow) col.lerp(new THREE.Color('#f4f7f8'), 0.6);
      r?.setColorAt(i, col);
    });
    cones.forEach((tr, i) => {
      tmp.position.set(tr.x, 3.0 * tr.s, tr.z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(tr.s, tr.s, tr.s);
      tmp.updateMatrix();
      c?.setMatrixAt(i, tmp.matrix);
      c?.setColorAt(i, snow ? col.set('#6f9a62').lerp(new THREE.Color('#f4f7f8'), 0.45) : col.set('#6f9a62'));
    });
    for (const m of [t, r, c]) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [trees, rounds, cones, season, snow]);
  return (
    <group>
      {trees.length > 0 && (
        <instancedMesh key={`t${trees.length}`} ref={trunk} args={[undefined, undefined, trees.length]} castShadow>
          <cylinderGeometry args={[0.12, 0.16, 1.6, 6]} />
          <meshToonMaterial color="#8a6e55" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
      {rounds.length > 0 && (
        <instancedMesh key={`r${rounds.length}`} ref={round} args={[undefined, undefined, rounds.length]} castShadow>
          <icosahedronGeometry args={[1.6, 0]} />
          <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
      {cones.length > 0 && (
        <instancedMesh key={`c${cones.length}`} ref={cone} args={[undefined, undefined, cones.length]} castShadow>
          <coneGeometry args={[1.3, 3.8, 7]} />
          <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
    </group>
  );
}

const LIGHT_ON = { R: '#ff3b30', Y: '#ffc400', G: '#2fd06a' } as const;
const LIGHT_OFF = '#3a3f44';

/** 信号灯：灯杆 + 三色灯头，灯色跟随车流时钟 */
function Signals() {
  const site = useSiteLayout();
  const traffic = useApp((s) => s.site.traffic);
  const siteSeed = useApp((s) => s.site.seed);
  const lampRef = useRef<THREE.InstancedMesh>(null);
  const heads = useMemo(() => site.signals.flatMap((s, si) => s.heads.map((h) => ({ ...h, si }))), [site]);

  useFrame(() => {
    const m = lampRef.current;
    if (!m) return;
    const sim = trafficFor(site, siteSeed, traffic * 0.5);
    let i = 0;
    for (const h of heads) {
      const signal = site.signals[h.si];
      if (!signal) continue;
      const light = signalLight(signal, sim.time, h.group);
      (['R', 'Y', 'G'] as const).forEach((k, j) => {
        const fx = Math.sin(h.facing);
        const fz = Math.cos(h.facing);
        tmp.position.set(h.x + fx * 0.2, 4.6 - j * 0.32, h.z + fz * 0.2);
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(0.22, 0.22, 0.22);
        tmp.updateMatrix();
        m.setMatrixAt(i, tmp.matrix);
        m.setColorAt(i, col.set(light === k ? LIGHT_ON[k] : LIGHT_OFF));
        i++;
      });
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  const poles = useMemo<Slab[]>(() => heads.map((h) => ({ x: h.x, z: h.z, w: 0.16, d: 0.16, y: 0, h: 5.0 })), [heads]);
  const boxes = useMemo<Slab[]>(() => heads.map((h) => ({ x: h.x, z: h.z, w: 0.38, d: 0.38, y: 4.1, h: 1.0 })), [heads]);
  if (!heads.length) return null;
  return (
    <group>
      <Slabs items={poles} color="#5c636a" />
      <Slabs items={boxes} color="#2d3135" />
      <instancedMesh key={heads.length} ref={lampRef} args={[undefined, undefined, heads.length * 3]} frustumCulled={false}>
        <sphereGeometry args={[0.5, 8, 6]} />
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
    </group>
  );
}

const WINDOW_DAY = new THREE.Color('#5d6f7d');
const WINDOW_NIGHT = new THREE.Color('#f2cf7a');
const LAMP_OFF = new THREE.Color('#4d5459');
const LAMP_ON = new THREE.Color('#fff1c4');

/** 路灯下的光斑：夜间逐渐亮起（加法混合，不需要实时光源） */
function LampPools({ lamps }: { lamps: Array<{ x: number; z: number }> }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const tex = useMemo(() => radialTexture('#fff0c8'), []);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    lamps.forEach((p, i) => {
      tmp.position.set(p.x, 0.02, p.z);
      tmp.rotation.set(-Math.PI / 2, 0, 0);
      tmp.scale.set(14, 14, 1);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [lamps]);
  useFrame(() => {
    const m = mat.current;
    const mesh = ref.current;
    if (!m || !mesh) return;
    m.opacity = env.night * 0.55;
    mesh.visible = env.night > 0.02;
  });
  if (!lamps.length) return null;
  return (
    <instancedMesh key={lamps.length} ref={ref} args={[undefined, undefined, lamps.length]} renderOrder={2}>
      <planeGeometry />
      <meshBasicMaterial ref={mat} map={tex} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </instancedMesh>
  );
}

/** 中心亮、边缘透明的圆形渐变贴图（光斑、车灯） */
export function radialTexture(color: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 店外：地面、道路、停车场、人行道、建筑、树木、路灯和信号灯 */
export function Surroundings() {
  const site = useSiteLayout();
  const geo = useApp((s) => s.simGeo);
  const simModel = useApp((s) => s.simModel);
  const floor = useApp((s) => s.floor);
  const mode = useApp((s) => s.mode);
  const weather = useApp((s) => s.site.weather ?? 'clear');
  const season = useApp((s) => s.site.season ?? 'autumn');
  const lot = geo.lot;
  const f0 = geo.floors[0];
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;

  const statics = useMemo(() => {
    const lotAsphalt: Slab[] = [{ x: (lot.minX + lot.maxX) / 2, z: (lot.edgeZ + lot.frontZ) / 2, w: lot.maxX - lot.minX, d: lot.frontZ - lot.edgeZ }];
    const front: Slab[] = [{ x: (lot.minX + lot.maxX) / 2, z: lot.frontZ / 2, w: lot.maxX - lot.minX, d: -lot.frontZ }];
    // 车位线：每个车位两侧各一条，相邻车位共用
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
    // 门前消防车道的黄色路缘线和通往门口的人行横道
    const yellow: Slab[] = [{ x: (lot.minX + lot.maxX) / 2, z: lot.frontZ - 0.12, w: lot.maxX - lot.minX, d: 0.18 }];
    const zebra: Slab[] = [];
    for (let k = 0; k < 6; k++) zebra.push({ x: geo.door.x - 2.5 + k * 1.0, z: lot.fireLaneZ, w: 0.5, d: 5.4 });
    const islands: Slab[] = lot.islands.map((i) => ({ ...i }));
    const buildings: Slab[] = site.buildings.map((b) => ({ x: b.x, z: b.z, w: b.w, d: b.d, h: b.h, color: b.color }));
    const roofs = site.buildings.filter((b) => b.roof === 'gable').map((b) => ({ x: b.x, z: b.z, w: b.w + 0.8, d: b.d + 0.8, y: b.h, h: Math.min(b.w, b.d) * 0.38, ridgeX: b.w >= b.d, color: '#8c6f5e' }));
    // 城市楼房的窗带：每层一条深色玻璃带
    const windows: Slab[] = [];
    if (site.style !== 'suburban') {
      for (const b of site.buildings) {
        if (b.roof !== 'flat') continue;
        for (let y = 1.4; y < b.h - 1; y += 3.3) windows.push({ x: b.x, z: b.z, w: b.w + 0.06, d: b.d + 0.06, y, h: 1.2 });
      }
    }
    const canopyRoofs: Slab[] = site.canopies.map((c) => ({ x: c.x, z: c.z, w: c.w, d: c.d, y: c.h, h: 0.6 }));
    const canopyPosts: Slab[] = site.canopies.flatMap((c) => [-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ x: c.x + sx * (c.w / 2 - 2), z: c.z + sz * (c.d / 2 - 2), w: 0.4, d: 0.4, y: 0, h: c.h }))));
    const lampPoles: Slab[] = site.lamps.map((p) => ({ x: p.x, z: p.z, w: 0.14, d: 0.14, y: 0, h: 6.5 }));
    const lampHeads: Slab[] = site.lamps.map((p) => ({ x: p.x, z: p.z, w: 0.9, d: 0.35, y: 6.4, h: 0.18 }));
    const white = site.markings.filter((m) => m.color === 'white');
    const yellowMarks = site.markings.filter((m) => m.color === 'yellow');
    return { white, yellowMarks, ground: [site.ground], lotAsphalt, front, lines, paint, bayPosts, yellow, zebra, islands, buildings, roofs, windows, canopyRoofs, canopyPosts, lampPoles, lampHeads };
  }, [site, lot, geo.door.x, f0, simModel]);

  // 夜间：窗户亮灯、路灯发光
  const windowMat = useRef<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>(null);
  const lampMat = useRef<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>(null);
  // 地面材质：按路面湿度和积雪逐帧调色（多变天气时雨后路面慢慢变干、雪慢慢积起来）
  const groundMat = useRef<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>(null);
  const grassMat = useRef<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>(null);
  const asphaltMat = useRef<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>(null);
  const lotMat = useRef<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>(null);
  const walkMat = useRef<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>(null);
  const islandMat = useRef<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>(null);
  const [snowRoofs, setSnowRoofs] = useState(false);
  const g = site.ground;
  const dry = useMemo(() => {
    const ground = season === 'winter' ? '#cfcbb6' : season === 'autumn' && site.style !== 'urban' ? '#d6d8ae' : season === 'summer' && site.style !== 'urban' ? '#c3dba6' : g.color;
    const grass = season === 'winter' ? '#c4c2a8' : season === 'autumn' ? '#c9cf9a' : '#bcd6a2';
    return {
      ground: new THREE.Color(ground),
      grass: new THREE.Color(grass),
      asphalt: new THREE.Color('#8f979e'),
      lot: new THREE.Color('#9aa2a9'),
      walk: new THREE.Color('#d9d6cf'),
    };
  }, [season, site.style, g.color]);
  const WET = useMemo(() => ({ asphalt: new THREE.Color('#6c747b'), lot: new THREE.Color('#77808a'), walk: new THREE.Color('#bfbcb5') }), []);
  const SNOWY = useMemo(() => ({ ground: new THREE.Color('#eef2f3'), grass: new THREE.Color('#e6ecee'), asphalt: new THREE.Color('#a3aab0'), lot: new THREE.Color('#adb4ba'), walk: new THREE.Color('#f0f2f2') }), []);
  useFrame(() => {
    windowMat.current?.color.copy(WINDOW_DAY).lerp(WINDOW_NIGHT, env.night * 0.85);
    lampMat.current?.color.copy(LAMP_OFF).lerp(LAMP_ON, env.night);
    const wet = Math.min(1, env.wet);
    const cover = Math.min(1, env.snowCover);
    groundMat.current?.color.copy(dry.ground).lerp(SNOWY.ground, cover);
    grassMat.current?.color.copy(dry.grass).lerp(SNOWY.grass, cover);
    islandMat.current?.color.copy(dry.grass).lerp(SNOWY.ground, cover);
    asphaltMat.current?.color.copy(dry.asphalt).lerp(WET.asphalt, wet).lerp(SNOWY.asphalt, cover * 0.8);
    lotMat.current?.color.copy(dry.lot).lerp(WET.lot, wet).lerp(SNOWY.lot, cover * 0.8);
    walkMat.current?.color.copy(dry.walk).lerp(WET.walk, wet).lerp(SNOWY.walk, cover);
    if (cover > 0.5 !== snowRoofs) setSnowRoofs(cover > 0.5);
  });

  if (!visible) return null;
  void weather;
  const snow = snowRoofs;
  const groundColor = `#${dry.ground.getHexString()}`;
  const grassColor = `#${dry.grass.getHexString()}`;
  const asphaltColor = '#8f979e';
  const lotColor = '#9aa2a9';
  const walkColor = '#d9d6cf';
  return (
    <group>
      <Slabs items={statics.ground} y={-0.16} h={0.06} color={groundColor} receive matRef={groundMat} />
      <Slabs items={site.grass} y={-0.1} h={0.12} color={grassColor} receive matRef={grassMat} />
      <Slabs items={site.asphalt} y={-0.1} h={0.06} color={asphaltColor} receive matRef={asphaltMat} />
      <Slabs items={statics.lotAsphalt} y={-0.1} h={0.065} color={lotColor} receive matRef={lotMat} />
      <Slabs items={site.sidewalks} y={-0.1} h={0.18} color={walkColor} receive matRef={walkMat} />
      <Slabs items={statics.front} y={-0.1} h={0.18} color="#dedbd3" receive />
      <Slabs items={statics.islands} y={-0.1} h={0.2} color={grassColor} receive matRef={islandMat} />
      <Slabs items={statics.white} y={-0.04} h={0.012} color="#f4f4ef" basic />
      <Slabs items={statics.yellowMarks} y={-0.04} h={0.012} color="#f1c232" basic />
      <Slabs items={statics.lines} y={-0.035} h={0.012} color="#f4f4ef" basic />
      <Slabs items={statics.paint} y={-0.036} h={0.012} color="#f2b27a" basic />
      <Slabs items={statics.yellow} y={0.08} h={0.012} color="#f1c232" basic />
      <Slabs items={statics.zebra} y={-0.035} h={0.012} color="#f4f4ef" basic />
      <Slabs items={statics.bayPosts} y={0} color="#ee8a35" />
      <Slabs items={statics.buildings} color="#ffffff" colored cast receive />
      <Slabs items={statics.windows} color="#5d6f7d" matRef={windowMat} />
      <Roofs items={snow ? statics.roofs.map((r) => ({ ...r, color: '#f3f6f7' })) : statics.roofs} />
      <Slabs items={statics.canopyRoofs} color="#e9edf0" cast />
      <Slabs items={statics.canopyPosts} color="#c7cdd2" cast />
      <Slabs items={statics.lampPoles} color="#6b7379" cast />
      <Slabs items={statics.lampHeads} color="#4d5459" basic matRef={lampMat} />
      <LampPools lamps={site.lamps} />
      <Trees trees={site.trees} season={season} snow={snow} />
      {site.ponds.map((p, i) => (
        <mesh key={`pond${i}`} position={[p.x, -0.02, p.z]} scale={[p.rx, 1, p.rz]} receiveShadow>
          <cylinderGeometry args={[1, 1, 0.1, 32]} />
          <meshStandardMaterial color="#6fa8c9" roughness={0.15} metalness={0.1} />
        </mesh>
      ))}
      {site.works && (
        <group>
          <Slabs items={site.works.cones.map((c) => ({ x: c.x, z: c.z, w: 0.4, d: 0.4, y: -0.04, h: 0.75, color: '#f07c1f' }))} color="#ffffff" colored />
          <Slabs items={[{ x: site.works.sign.x, z: site.works.sign.z, w: 1.6, d: 0.12, y: 0.4, h: 1.1, color: '#f2c230' }]} color="#ffffff" colored />
          {mode === 'sim' && (
            <Html position={[site.works.sign.x, 2.4, site.works.sign.z]} center className="scene-label works-label">
              {t('前方施工 · 限速')}
            </Html>
          )}
        </group>
      )}
      <Signals />
      {mode === 'sim' && (
        <Html position={[lot.pickupSign.x, 2.6, lot.pickupSign.z - 3.2]} center className="scene-label area-label pickup-label">
          <span className="label-full">{t('线上取货 · {0} 个车位', lot.pickupCount)}</span>
          <span className="label-short">{t('线上取货')}</span>
        </Html>
      )}
    </group>
  );
}
