import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useApp } from '../state/store';
import { customerEntrance } from './crowd';
import { useSiteLayout } from './useSite';
import { env } from './environment';
import { toonGradient } from './toon';
import { t } from '../i18n';
import { boxGeo, mergeAll } from './terrain/geom';

/** 画布文字贴图：门头招牌和路边立牌 */
export function signTexture(title: string, subtitle: string, w = 512, h = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#2f7d55';
    g.beginPath();
    g.roundRect(0, 0, w, h, 28);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${Math.round(h * 0.36)}px system-ui, -apple-system, 'PingFang SC', sans-serif`;
    g.fillText(title, w / 2, h * 0.42);
    g.globalAlpha = 0.85;
    g.font = `500 ${Math.round(h * 0.13)}px system-ui, -apple-system, 'PingFang SC', sans-serif`;
    g.fillText(subtitle, w / 2, h * 0.76);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 门店正面：顾客入口（自动门、雨棚）、门头招牌、购物车存放处和路边立牌；夜间招牌发光 */
export function Storefront() {
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  const name = useApp((s) => s.config.name);
  const hours = useApp((s) => s.config.hours);
  const floor = useApp((s) => s.floor);
  const buildingView = useApp((s) => s.buildingView);
  const site = useSiteLayout();
  const entrance = useMemo(() => customerEntrance(model, geo), [model, geo]);
  const tex = useMemo(() => signTexture('MARKET', name), [name]);
  const lang = useApp((s) => s.lang);
  const pylonTex = useMemo(() => {
    const f = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    return signTexture('MARKET', t('营业时间 {0}–{1}', f(hours.openMin), f(hours.closeMin)));
  }, [hours.openMin, hours.closeMin, lang]);
  const signMats = useRef<THREE.MeshBasicMaterial[]>([]);
  const downlight = useMemo(() => new THREE.MeshBasicMaterial({ color: '#fff3dc' }), []);
  useFrame(() => {
    const k = 0.78 + 1.5 * env.night;
    for (const m of signMats.current) m.color.setScalar(k);
    downlight.color.set('#fff3dc').multiplyScalar(0.85 + 2.6 * env.night);
  });
  // 入口外的小品：护柱、花箱、长椅、垃圾桶（合并成几个几何体）
  const props = useMemo(() => {
    const x = entrance.outside.x;
    const zf = geo.lot.frontZ;
    const bollards: THREE.BufferGeometry[] = [];
    for (let k = -4; k <= 4; k++) {
      if (Math.abs(k) < 2) continue;
      const g = new THREE.CylinderGeometry(0.11, 0.13, 0.95, 10);
      g.translate(x + k * 1.25, 0.55, zf + 0.35);
      bollards.push(g);
    }
    const planters = [boxGeo(x - 6.2, x - 4.6, 0.08, 0.62, zf + 0.6, zf + 1.6), boxGeo(x + 8.6, x + 10.2, 0.08, 0.62, zf + 0.6, zf + 1.6)];
    const benchWood: THREE.BufferGeometry[] = [];
    const benchIron: THREE.BufferGeometry[] = [];
    for (const bx of [x - 8.2, x + 12]) {
      for (let k = 0; k < 3; k++) benchWood.push(boxGeo(bx - 0.85, bx + 0.85, 0.5, 0.54, zf + 1.1 + k * 0.14, zf + 1.21 + k * 0.14));
      benchWood.push(boxGeo(bx - 0.85, bx + 0.85, 0.66, 0.98, zf + 1.56, zf + 1.6));
      for (const dx of [-0.75, 0.75]) benchIron.push(boxGeo(bx + dx - 0.04, bx + dx + 0.04, 0.08, 0.98, zf + 1.05, zf + 1.6));
    }
    const bins: THREE.BufferGeometry[] = [];
    for (const bx of [x - 3.3, x + 3.3]) {
      const g = new THREE.CylinderGeometry(0.28, 0.25, 0.95, 12);
      g.translate(bx, 0.56, zf + 0.7);
      bins.push(g);
      const lid = new THREE.CylinderGeometry(0.31, 0.31, 0.06, 12);
      lid.translate(bx, 1.06, zf + 0.7);
      bins.push(lid);
    }
    return { bollards: mergeAll(bollards), planters: mergeAll(planters), wood: mergeAll(benchWood), iron: mergeAll([...benchIron, ...bins]), plants: [{ x: x - 5.4, z: zf + 1.1 }, { x: x + 9.4, z: zf + 1.1 }] };
  }, [entrance, geo.lot.frontZ]);
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;
  if (!visible) return null;

  const x = entrance.outside.x;
  const addMat = (m: THREE.MeshBasicMaterial | null) => {
    if (m && !signMats.current.includes(m)) signMats.current.push(m);
  };
  // 立柱招牌：在左边出入口的喇叭口外侧（决策记录 0019）
  const pylon = { x: geo.lot.minX + 16, z: (site.roadTopZ + 2.4 + geo.lot.edgeZ) / 2 };
  return (
    <group>
      {/* 自动门：门框 + 玻璃 */}
      {[-2.2, 2.2].map((dx) => (
        <mesh key={dx} position={[x + dx, 1.5, 0]} castShadow>
          <boxGeometry args={[0.25, 3, 0.35]} />
          <meshToonMaterial color="#4f5961" gradientMap={toonGradient()} />
        </mesh>
      ))}
      <mesh position={[x, 3.1, 0]} castShadow>
        <boxGeometry args={[4.7, 0.25, 0.4]} />
        <meshToonMaterial color="#4f5961" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[x, 1.45, 0]}>
        <boxGeometry args={[4.1, 2.9, 0.06]} />
        <meshStandardMaterial color="#a9d3ea" transparent opacity={0.28} />
      </mesh>
      {/* 雨棚：钢结构，品牌色挑檐，白色底板上一排筒灯（夜里亮） */}
      <mesh position={[x, 3.72, -1.75]} castShadow receiveShadow>
        <boxGeometry args={[8.2, 0.16, 3.7]} />
        <meshToonMaterial color="#f3f1ec" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[x, 3.86, -3.6]} castShadow>
        <boxGeometry args={[8.4, 0.5, 0.16]} />
        <meshToonMaterial color="#2f7d55" gradientMap={toonGradient()} />
      </mesh>
      {[-3.9, 3.9].map((dx) => (
        <mesh key={`e${dx}`} position={[x + dx, 3.86, -1.8]} castShadow>
          <boxGeometry args={[0.16, 0.5, 3.6]} />
          <meshToonMaterial color="#2f7d55" gradientMap={toonGradient()} />
        </mesh>
      ))}
      {[-3.6, 3.6].map((dx) => (
        <mesh key={`p${dx}`} position={[x + dx, 1.82, -3.35]} castShadow>
          <cylinderGeometry args={[0.1, 0.12, 3.64, 10]} />
          <meshToonMaterial color="#59626b" gradientMap={toonGradient()} />
        </mesh>
      ))}
      {[-2.6, -0.9, 0.9, 2.6].map((dx) => (
        <mesh key={`d${dx}`} position={[x + dx, 3.63, -2.1]} rotation={[-Math.PI / 2, 0, 0]} material={downlight}>
          <circleGeometry args={[0.16, 12]} />
        </mesh>
      ))}
      {/* 门头招牌（店内视角时挂在入口上方；外观和半剖时由建筑外壳的门头墙显示） */}
      {buildingView === 'interior' && (
        <mesh position={[x, 5.2, -0.1]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[8, 2]} />
          <meshBasicMaterial ref={addMat} map={tex} side={THREE.DoubleSide} transparent />
        </mesh>
      )}
      {/* 购物车存放处 */}
      {Array.from({ length: 6 }, (_, k) => (
        <mesh key={`c${k}`} position={[x + 4.5 + k * 0.32, 0.55, -1.4]} castShadow>
          <boxGeometry args={[0.55, 0.9, 0.95]} />
          <meshToonMaterial color="#b8c2cc" gradientMap={toonGradient()} />
        </mesh>
      ))}
      {/* 入口外的护柱、花箱、长椅和垃圾桶 */}
      <mesh geometry={props.bollards} castShadow>
        <meshToonMaterial color="#d8dcdf" gradientMap={toonGradient()} />
      </mesh>
      <mesh geometry={props.planters} castShadow receiveShadow>
        <meshToonMaterial color="#c9bba3" gradientMap={toonGradient()} />
      </mesh>
      <mesh geometry={props.wood} castShadow>
        <meshToonMaterial color="#b4824f" gradientMap={toonGradient()} />
      </mesh>
      <mesh geometry={props.iron} castShadow>
        <meshToonMaterial color="#3b4546" gradientMap={toonGradient()} />
      </mesh>
      {props.plants.map((p, i) => (
        <mesh key={`pl${i}`} position={[p.x, 0.95, p.z]} scale={[0.75, 0.55, 0.45]} castShadow>
          <icosahedronGeometry args={[1, 1]} />
          <meshToonMaterial color="#5f9f4c" gradientMap={toonGradient()} />
        </mesh>
      ))}
      {/* 路边立牌：石材底座、立柱、双面灯箱、顶盖 */}
      <mesh position={[pylon.x, 0.45, pylon.z]} castShadow receiveShadow>
        <boxGeometry args={[1.6, 0.9, 1.0]} />
        <meshToonMaterial color="#b9ae9c" gradientMap={toonGradient()} />
      </mesh>
      {[-1.9, 1.9].map((dx) => (
        <mesh key={`py${dx}`} position={[pylon.x + dx, 4.6, pylon.z]} castShadow>
          <boxGeometry args={[0.32, 7.6, 0.32]} />
          <meshToonMaterial color="#59626b" gradientMap={toonGradient()} />
        </mesh>
      ))}
      <mesh position={[pylon.x, 8.2, pylon.z]} rotation={[0, Math.PI, 0]} castShadow>
        <boxGeometry args={[4.2, 2.5, 0.4]} />
        <meshToonMaterial color="#2f7d55" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[pylon.x, 9.6, pylon.z]} castShadow>
        <boxGeometry args={[4.6, 0.22, 0.6]} />
        <meshToonMaterial color="#f1ece2" gradientMap={toonGradient()} />
      </mesh>
      {[-0.21, 0.21].map((dz) => (
        <mesh key={`s${dz}`} position={[pylon.x, 8.2, pylon.z + dz]} rotation={[0, dz < 0 ? Math.PI : 0, 0]}>
          <planeGeometry args={[4.0, 2.3]} />
          <meshBasicMaterial ref={addMat} map={pylonTex} transparent />
        </mesh>
      ))}
    </group>
  );
}
