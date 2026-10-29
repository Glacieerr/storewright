import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { t } from '../../i18n';
import { createRng } from '@storewright/domain';
import type { SiteLayout } from '../site';
import type { LotLayout } from '../lot';
import { boxGeo, mergeAll } from '../terrain/geom';
import { toonGradient } from '../toon';
import { lampGlass } from '../style/lights';

/**
 * 街道小品：消防栓、垃圾桶、限速牌、公交站（候车亭：立柱、顶棚、玻璃背板、长椅、站牌灯箱）。
 * 位置由道路和种子推出，避开路口、出入口和桥。
 */

const tmp = new THREE.Object3D();

function hydrantGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.13, 0.15, 0.62, 10);
  body.translate(0, 0.31, 0);
  const cap = new THREE.SphereGeometry(0.14, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.translate(0, 0.62, 0);
  const nozzle = new THREE.CylinderGeometry(0.05, 0.05, 0.42, 8);
  nozzle.rotateZ(Math.PI / 2);
  nozzle.translate(0, 0.42, 0);
  const base = new THREE.CylinderGeometry(0.19, 0.2, 0.06, 10);
  base.translate(0, 0.03, 0);
  return mergeAll([body, cap, nozzle, base]);
}

function binGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.27, 0.24, 0.9, 12);
  body.translate(0, 0.45, 0);
  const lid = new THREE.CylinderGeometry(0.3, 0.3, 0.07, 12);
  lid.translate(0, 0.93, 0);
  return mergeAll([body, lid]);
}

/** 限速牌贴图：白底红圈黑字 */
function speedTexture(limit: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(64, 64, 62, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#d62f2f';
    g.lineWidth = 14;
    g.beginPath();
    g.arc(64, 64, 52, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#1d1d1f';
    g.font = '700 54px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(limit), 64, 68);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Placed {
  x: number;
  z: number;
  ry: number;
}

function Instances({ geo, items, material }: { geo: THREE.BufferGeometry; items: Placed[]; material: THREE.Material }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((p, i) => {
      tmp.position.set(p.x, 0.08, p.z);
      tmp.rotation.set(0, p.ry, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return <instancedMesh key={items.length} ref={ref} args={[geo, material, items.length]} castShadow />;
}

/** 货车入口指示牌：蓝底白字、一辆半挂车的剪影和箭头 */
function truckSignTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#1f5fa8';
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 5;
    g.strokeRect(6, 6, 244, 116);
    g.fillStyle = '#ffffff';
    // 半挂车剪影：挂车、牵引车、轮子
    g.fillRect(22, 30, 92, 38);
    g.fillRect(118, 42, 30, 26);
    g.fillRect(140, 50, 8, 18);
    for (const x of [34, 52, 128, 104]) {
      g.beginPath();
      g.arc(x, 74, 7, 0, Math.PI * 2);
      g.fill();
    }
    g.font = 'bold 30px sans-serif';
    g.textAlign = 'center';
    g.fillText(t('货车入口'), 128, 112);
    // 箭头
    g.beginPath();
    g.moveTo(170, 40);
    g.lineTo(220, 40);
    g.lineTo(220, 28);
    g.lineTo(242, 50);
    g.lineTo(220, 72);
    g.lineTo(220, 60);
    g.lineTo(170, 60);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function StreetProps({ site, lot }: { site: SiteLayout; lot: LotLayout }) {
  const parts = useMemo(() => {
    const rng = createRng(Math.round(site.ground.w * 7 + site.roadTopZ * 3));
    const b = site.water.bridge;
    const gx0 = site.ground.x - site.ground.w / 2 + 8;
    const gx1 = site.ground.x + site.ground.w / 2 - 8;
    const busy = (x: number) => site.intersections.some((k) => Math.abs(x - k.x) < k.half + 5) || site.edgeGaps.some(([a, c]) => x > a - 2 && x < c + 2) || (x > b.x0 - 3 && x < b.x1 + 3);
    const zNear = site.roadTopZ + 1.95;
    const zFar = site.roadBottomZ - 1.95;
    const hydrants: Placed[] = [];
    const bins: Placed[] = [];
    for (let x = gx0 + rng.uniform(0, 20); x < gx1; x += rng.uniform(48, 70)) {
      if (!busy(x)) hydrants.push({ x, z: zNear, ry: 0 });
      const x2 = x + rng.uniform(15, 30);
      if (x2 < gx1 && !busy(x2)) hydrants.push({ x: x2, z: zFar, ry: Math.PI });
    }
    for (const k of site.intersections) {
      for (const [dx, z] of [
        [-k.half - 3.2, zNear],
        [k.half + 3.2, zFar],
      ] as const) {
        const x = k.x + dx;
        if (!busy(x) || Math.abs(x - k.x) > k.half + 2) bins.push({ x, z, ry: 0 });
      }
    }
    // 公交站：湖边广场对面的人行道上（远侧），朝向马路
    const stopX = Math.min(gx1 - 6, Math.max(gx0 + 6, site.water.plaza.x + 9));
    const stop = busy(stopX) ? undefined : { x: stopX, z: site.roadBottomZ - 1.55 };
    if (stop) bins.push({ x: stop.x + 3.1, z: stop.z - 0.3, ry: 0 });
    // 限速牌：主路两个方向各一块
    const signs: Placed[] = [];
    for (let x = gx0 + 30; x < gx1; x += 85) {
      if (!busy(x)) signs.push({ x, z: site.roadTopZ + 2.15, ry: Math.PI });
      if (!busy(x + 40)) signs.push({ x: x + 40, z: site.roadBottomZ - 2.15, ry: 0 });
    }
    return { hydrants, bins, stop, signs };
  }, [site]);
  const geos = useMemo(() => ({ hydrant: hydrantGeometry(), bin: binGeometry() }), []);
  const mats = useMemo(
    () => ({
      hydrant: new THREE.MeshToonMaterial({ color: '#d8392f', gradientMap: toonGradient() }),
      bin: new THREE.MeshToonMaterial({ color: '#3f6f55', gradientMap: toonGradient() }),
      metal: new THREE.MeshToonMaterial({ color: '#59626b', gradientMap: toonGradient() }),
      glass: new THREE.MeshToonMaterial({ color: '#a9d2e6', gradientMap: toonGradient(), transparent: true, opacity: 0.45 }),
      roof: new THREE.MeshToonMaterial({ color: '#2f7d55', gradientMap: toonGradient() }),
      wood: new THREE.MeshToonMaterial({ color: '#b4824f', gradientMap: toonGradient() }),
    }),
    [],
  );
  const signTex = useMemo(() => speedTexture(site.style === 'arterial' ? 60 : 40), [site.style]);
  const truckTex = useMemo(() => truckSignTexture(), []);
  const acc = site.access;
  const shelter = useMemo(() => {
    const s = parts.stop;
    if (!s) return undefined;
    const metal: THREE.BufferGeometry[] = [];
    for (const dx of [-1.8, 1.8]) for (const dz of [-0.75, 0.75]) metal.push(boxGeo(s.x + dx - 0.05, s.x + dx + 0.05, 0.08, 2.5, s.z + dz - 0.05, s.z + dz + 0.05));
    metal.push(boxGeo(s.x - 0.05 + 2.4, s.x + 0.05 + 2.4, 0.08, 2.9, s.z - 0.05 - 0.6, s.z + 0.05 - 0.6));
    const roof = boxGeo(s.x - 2.05, s.x + 2.05, 2.5, 2.62, s.z - 1.0, s.z + 1.0);
    const glass = boxGeo(s.x - 1.75, s.x + 1.75, 0.35, 2.35, s.z - 0.77, s.z - 0.72);
    const wood = mergeAll([boxGeo(s.x - 1.5, s.x + 1.5, 0.48, 0.54, s.z - 0.6, s.z - 0.2), boxGeo(s.x - 1.5, s.x + 1.5, 0.08, 0.48, s.z - 0.45, s.z - 0.38)]);
    const panel = boxGeo(s.x + 2.4 - 0.25, s.x + 2.4 + 0.25, 2.15, 2.75, s.z - 0.6 - 0.04, s.z - 0.6 + 0.04);
    return { metal: mergeAll(metal), roof: mergeAll([roof]), glass: mergeAll([glass]), wood, panel: mergeAll([panel]) };
  }, [parts.stop]);
  return (
    <group>
      <Instances geo={geos.hydrant} items={parts.hydrants} material={mats.hydrant} />
      <Instances geo={geos.bin} items={parts.bins} material={mats.bin} />
      {parts.signs.map((s, i) => (
        <group key={i} position={[s.x, 0.08, s.z]} rotation={[0, s.ry, 0]}>
          <mesh position={[0, 1.2, 0]} material={mats.metal} castShadow>
            <cylinderGeometry args={[0.04, 0.04, 2.4, 6]} />
          </mesh>
          <mesh position={[0, 2.25, 0.05]} castShadow>
            <circleGeometry args={[0.36, 24]} />
            <meshToonMaterial map={signTex} gradientMap={toonGradient()} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
      {/* 卸货场的货车入口指示牌（决策记录 0019） */}
      <group position={[acc.sign.x, 0.08, acc.sign.z]} rotation={[0, Math.PI, 0]}>
        {[-0.7, 0.7].map((dx) => (
          <mesh key={dx} position={[dx, 1.1, 0]} material={mats.metal} castShadow>
            <cylinderGeometry args={[0.05, 0.05, 2.2, 6]} />
          </mesh>
        ))}
        <mesh position={[0, 2.05, 0.06]} castShadow>
          <boxGeometry args={[1.9, 0.9, 0.06]} />
          <meshToonMaterial map={truckTex} gradientMap={toonGradient()} />
        </mesh>
      </group>
      {shelter && (
        <group>
          <mesh geometry={shelter.metal} material={mats.metal} castShadow />
          <mesh geometry={shelter.roof} material={mats.roof} castShadow receiveShadow />
          <mesh geometry={shelter.glass} material={mats.glass} />
          <mesh geometry={shelter.wood} material={mats.wood} castShadow />
          <mesh geometry={shelter.panel} material={lampGlass} />
        </group>
      )}
    </group>
  );
}
