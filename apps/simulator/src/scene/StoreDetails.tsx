import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { env } from './environment';
import { deliBays, SHELF_AISLE_HALF, SHELF_DEPTH, type StoreGeometry } from './layout';
import { radialTexture } from './Surroundings';
import { customerEntrance } from './crowd';
import { toonGradient } from './toon';
import { People, type PersonState } from './People';
import { useSiteLayout } from './useSite';
import { cutX } from './BuildingShell';
import type { RunConfig } from '@storewright/store-config';
import { t } from '../i18n';

/**
 * 店内外的细节：冷柜灯光、天花板灯在地面上的光斑、招牌光晕和门口的暖光、
 * 通道两端的促销端架、靠墙的熟食服务柜台（玻璃柜 + 店员）。都只是画面，不影响仿真。
 */

const tmp = new THREE.Object3D();
const col = new THREE.Color();
const PROMO = ['#d9534f', '#f0ad4e', '#5bc0de', '#5cb85c', '#9b59b6', '#e67e22', '#e84393'];

interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rotY: number;
  color: string;
}

function useBoxes(ref: React.RefObject<THREE.InstancedMesh>, items: Box[]): void {
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((b, i) => {
      tmp.position.set(b.x, b.y, b.z);
      tmp.rotation.set(0, b.rotY, 0);
      tmp.scale.set(b.w, b.h, b.d);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, col.set(b.color));
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [ref, items]);
}

/** 通道中线的单位方向和法向量（配置平面），以及货架所在的一侧 */
function runFrame(run: RunConfig) {
  const dx = run.end.x - run.start.x;
  const dy = run.end.y - run.start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return { len, ux, uy, nx: -uy, ny: ux, rotY: Math.atan2(-uy, ux) };
}

/** 与货架相同的楼层显示规则：3D 看全部楼层时都显示，否则只显示当前楼层 */
function visibleFloor(_geo: StoreGeometry, floor: string, view: string, floorId: string): boolean {
  return (view === '3d' && floor === 'ALL') || floor === floorId;
}

export function StoreDetails() {
  const geo = useApp((s) => s.geo);
  const buildingView = useApp((s) => s.buildingView);
  const cutPos = useApp((s) => s.cutPos);
  const model = useApp((s) => s.model);
  const floor = useApp((s) => s.floor);
  const view = useApp((s) => s.view);
  const cfg = model.config;
  const runById = useMemo(() => new Map(cfg.layout.runs.map((r) => [r.id, r])), [cfg]);
  const deli = useMemo(() => deliBays(cfg), [cfg]);
  const floorOk = (fid: string) => visibleFloor(geo, floor, view, fid);

  // 冷柜灯光：冷藏、冷冻货架朝通道的一面
  const fridge = useMemo<Box[]>(() => {
    const out: Box[] = [];
    for (const s of geo.shelves) {
      if (s.tempZone !== 'CHILLED' && s.tempZone !== 'FROZEN') continue;
      if (!floorOk(s.floorId)) continue;
      if (deli && s.runId === deli.runId && deli.bays.has(s.bay)) continue;
      const run = runById.get(s.runId);
      if (!run) continue;
      const f = runFrame(run);
      const side = Math.sign((s.x - run.start.x) * f.nx + (s.z - run.start.y) * f.ny) || 1;
      const k = s.depth / 2 + 0.02;
      out.push({ x: s.x - f.nx * side * k, y: s.y, z: s.z - f.ny * side * k, w: s.length * 0.94, h: s.height * 0.78, d: 0.03, rotY: s.rotY, color: s.tempZone === 'FROZEN' ? '#cfe6ff' : '#e3f4ff' });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, runById, deli, floor, view]);

  // 端架：每条双面货架通道两端、两侧各一个
  const endcaps = useMemo(() => {
    const body: Box[] = [];
    const signs: Box[] = [];
    let k = 0;
    for (const run of cfg.layout.runs) {
      if (run.kind !== 'AISLE' || run.sides !== 2 || !floorOk(run.floorId)) continue;
      const f = runFrame(run);
      const margin = Math.min(run.endMarginM, f.len / 4);
      if (margin < 0.9) continue;
      const y = geo.floorY.get(run.floorId) ?? 0;
      for (const end of [0, 1]) {
        const along = end === 0 ? margin - 0.33 : f.len - margin + 0.33;
        for (const side of [1, -1]) {
          const off = SHELF_AISLE_HALF + SHELF_DEPTH / 2;
          const x = run.start.x + f.ux * along + f.nx * off * side;
          const z = run.start.y + f.uy * along + f.ny * off * side;
          const color = PROMO[k++ % PROMO.length] as string;
          body.push({ x, y: y + 0.68, z, w: 0.55, h: 1.36, d: SHELF_DEPTH * 0.95, rotY: f.rotY, color });
          signs.push({ x, y: y + 1.62, z, w: 0.5, h: 0.32, d: SHELF_DEPTH * 0.6, rotY: f.rotY, color: k % 3 === 0 ? '#c0392b' : '#f1c40f' });
        }
      }
    }
    return { body, signs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, geo, floor, view]);

  // 熟食柜台：柜体 + 玻璃 + 柜内熟食
  const deliParts = useMemo(() => {
    const base: Box[] = [];
    const glass: Box[] = [];
    const food: Box[] = [];
    let label: { x: number; y: number; z: number } | undefined;
    let back: { x: number; z: number; ax: number; az: number; span: number; y: number } | undefined;
    if (!deli) return { base, glass, food, label, back };
    const run = runById.get(deli.runId);
    if (!run || !floorOk(run.floorId)) return { base, glass, food, label, back };
    const f = runFrame(run);
    const shelves = geo.shelves.filter((s) => s.runId === deli.runId && deli.bays.has(s.bay));
    const y = geo.floorY.get(run.floorId) ?? 0;
    let sx = 0;
    let sz = 0;
    for (const s of shelves) {
      base.push({ x: s.x, y: y + 0.42, z: s.z, w: s.length, h: 0.84, d: s.depth, rotY: s.rotY, color: '#ece8df' });
      glass.push({ x: s.x, y: y + 1.05, z: s.z, w: s.length * 0.98, h: 0.42, d: s.depth * 0.9, rotY: s.rotY, color: '#bfe3f2' });
      food.push({ x: s.x, y: y + 0.9, z: s.z, w: s.length * 0.9, h: 0.1, d: s.depth * 0.6, rotY: s.rotY, color: ['#d97b5b', '#e8b26a', '#c95c5c', '#f2d39b'][s.bay % 4] as string });
      sx += s.x;
      sz += s.z;
    }
    if (shelves.length) {
      const cx = sx / shelves.length;
      const cz = sz / shelves.length;
      const side = Math.sign((cx - run.start.x) * f.nx + (cz - run.start.y) * f.ny) || 1;
      label = { x: cx, y: y + 2.3, z: cz };
      back = { x: cx + f.nx * side * 0.95, z: cz + f.ny * side * 0.95, ax: f.ux, az: f.uy, span: (shelves.length / 2) * 1.1, y };
    }
    return { base, glass, food, label, back };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deli, runById, geo, floor, view]);

  // 天花板灯在地面上的光斑：沿通道和走廊每 6 米一个，夜里更明显
  const pools = useMemo(() => {
    const out: Array<{ x: number; y: number; z: number }> = [];
    const segs = [...cfg.layout.runs.filter((r) => r.kind === 'AISLE'), ...cfg.layout.corridors];
    for (const s of segs) {
      if (!floorOk(s.floorId)) continue;
      const len = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
      const n = Math.max(1, Math.round(len / 6));
      const y = (geo.floorY.get(s.floorId) ?? 0) + 0.03;
      for (let i = 0; i < n; i++) {
        const k = (i + 0.5) / n;
        out.push({ x: s.start.x + (s.end.x - s.start.x) * k, y, z: s.start.y + (s.end.y - s.start.y) * k });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, geo, floor, view]);

  const fridgeRef = useRef<THREE.InstancedMesh>(null);
  const fridgeMat = useRef<THREE.MeshBasicMaterial>(null);
  const capRef = useRef<THREE.InstancedMesh>(null);
  const capSignRef = useRef<THREE.InstancedMesh>(null);
  const baseRef = useRef<THREE.InstancedMesh>(null);
  const glassRef = useRef<THREE.InstancedMesh>(null);
  const foodRef = useRef<THREE.InstancedMesh>(null);
  const poolRef = useRef<THREE.InstancedMesh>(null);
  const poolMat = useRef<THREE.MeshBasicMaterial>(null);
  const poolTex = useMemo(() => radialTexture('#fff4d8'), []);
  useBoxes(fridgeRef, fridge);
  useBoxes(capRef, endcaps.body);
  useBoxes(capSignRef, endcaps.signs);
  useBoxes(baseRef, deliParts.base);
  useBoxes(glassRef, deliParts.glass);
  useBoxes(foodRef, deliParts.food);
  useLayoutEffect(() => {
    const m = poolRef.current;
    if (!m) return;
    pools.forEach((p, i) => {
      tmp.position.set(p.x, p.y, p.z);
      tmp.rotation.set(-Math.PI / 2, 0, 0);
      tmp.scale.set(5, 5, 1);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.count = pools.length;
    m.instanceMatrix.needsUpdate = true;
  }, [pools]);

  useFrame(() => {
    if (fridgeMat.current) fridgeMat.current.opacity = 0.35 + 0.5 * env.night;
    if (poolMat.current) poolMat.current.opacity = 0.04 + 0.24 * env.night;
  });

  // 熟食店员：营业时间内在柜台后面来回走动
  const hours = cfg.hours;
  const fill = (out: PersonState[]) => {
    const b = deliParts.back;
    const t = clock.time % 86400;
    if (!b || t < hours.openMin * 60 || t > hours.closeMin * 60) return 0;
    let n = 0;
    for (let k = 0; k < 2 && n < out.length; k++) {
      const phase = clock.time / 40 + k * 2.1;
      const off = Math.sin(phase) * b.span * 0.7 + (k === 0 ? -0.6 : 0.6);
      const o = out[n] as PersonState;
      o.x = b.x + b.ax * off;
      o.y = b.y;
      o.z = b.z + b.az * off;
      o.heading = Math.atan2(b.ax, b.az) + (Math.cos(phase) > 0 ? 0 : Math.PI);
      o.moving = Math.abs(Math.cos(phase)) > 0.35;
      o.shirt.set('#f6f6f2');
      o.pants.set('#2f3640');
      o.cart = 'none';
      o.scale = 1.25;
      o.seed = 41 + k * 7;
      n++;
    }
    return n;
  };

  return (
    <group>
      <instancedMesh key={`f${fridge.length}`} ref={fridgeRef} args={[undefined, undefined, Math.max(1, fridge.length)]} frustumCulled={false}>
        <boxGeometry />
        <meshBasicMaterial ref={fridgeMat} transparent opacity={0.5} toneMapped={false} />
      </instancedMesh>
      <instancedMesh key={`c${endcaps.body.length}`} ref={capRef} args={[undefined, undefined, Math.max(1, endcaps.body.length)]} frustumCulled={false} castShadow>
        <boxGeometry />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`s${endcaps.signs.length}`} ref={capSignRef} args={[undefined, undefined, Math.max(1, endcaps.signs.length)]} frustumCulled={false}>
        <boxGeometry />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>
      <instancedMesh key={`b${deliParts.base.length}`} ref={baseRef} args={[undefined, undefined, Math.max(1, deliParts.base.length)]} frustumCulled={false} castShadow>
        <boxGeometry />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`g${deliParts.glass.length}`} ref={glassRef} args={[undefined, undefined, Math.max(1, deliParts.glass.length)]} frustumCulled={false}>
        <boxGeometry />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.45} toneMapped={false} />
      </instancedMesh>
      <instancedMesh key={`d${deliParts.food.length}`} ref={foodRef} args={[undefined, undefined, Math.max(1, deliParts.food.length)]} frustumCulled={false}>
        <boxGeometry />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`p${pools.length}`} ref={poolRef} args={[undefined, undefined, Math.max(1, pools.length)]} frustumCulled={false} renderOrder={1}>
        <planeGeometry />
        <meshBasicMaterial ref={poolMat} map={poolTex} transparent opacity={0.1} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </instancedMesh>
      {deliParts.label && (buildingView === 'interior' || (buildingView === 'cutaway' && deliParts.label.x < cutX(geo, cutPos))) && (
        <Html position={[deliParts.label.x, deliParts.label.y, deliParts.label.z]} center className="scene-label area-label deli-label">
          {t('熟食柜台')}
        </Html>
      )}
      <People max={2} fill={fill} />
      <SignGlow />
    </group>
  );
}

/** 招牌光晕和门口洒出的暖光（夜里亮起） */
function SignGlow() {
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  const floor = useApp((s) => s.floor);
  const site = useSiteLayout();
  const tex = useMemo(() => radialTexture('#eafff2'), []);
  const warm = useMemo(() => radialTexture('#ffe1a8'), []);
  const mats = useRef<THREE.MeshBasicMaterial[]>([]);
  const add = (m: THREE.MeshBasicMaterial | null) => {
    if (m && !mats.current.includes(m)) mats.current.push(m);
  };
  useFrame(() => {
    for (const m of mats.current) m.opacity = (m.userData.k as number) * env.night;
  });
  const buildingView = useApp((s) => s.buildingView);
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;
  if (!visible) return null;
  const x = customerEntrance(model, geo).outside.x;
  // 外观和半剖时店招在门头墙上（更高、更靠前）
  const signY = buildingView === 'interior' ? 5.2 : 7.55;
  const signZ = buildingView === 'interior' ? -0.04 : -0.75;
  // 立柱招牌：在左边出入口的喇叭口外侧（决策记录 0019）
  const pylon = { x: geo.lot.minX + 16, z: (site.roadTopZ + 2.4 + geo.lot.edgeZ) / 2 };
  const halo = (k: number, map: THREE.Texture) => (m: THREE.MeshBasicMaterial | null) => {
    if (m) m.userData.k = k;
    add(m);
    void map;
  };
  return (
    <group>
      <mesh position={[x, signY, signZ]} rotation={[0, Math.PI, 0]} renderOrder={2}>
        <planeGeometry args={[buildingView === 'interior' ? 12 : 16, 4.5]} />
        <meshBasicMaterial ref={halo(0.6, tex)} map={tex} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      {[-0.42, 0.42].map((dz) => (
        <mesh key={dz} position={[pylon.x, 8.2, pylon.z + dz]} rotation={[0, dz < 0 ? Math.PI : 0, 0]} renderOrder={2}>
          <planeGeometry args={[8, 5]} />
          <meshBasicMaterial ref={halo(0.5, tex)} map={tex} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[x, 0.05, -2.6]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <planeGeometry args={[9, 6]} />
        <meshBasicMaterial ref={halo(0.55, warm)} map={warm} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
    </group>
  );
}
