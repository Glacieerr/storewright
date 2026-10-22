import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useApp } from '../state/store';
import { customerEntrance } from './crowd';
import { useSiteLayout } from './useSite';
import { env } from './environment';
import { toonGradient } from './toon';
import { t } from '../i18n';

/** 画布文字贴图：门头招牌和路边立牌 */
function signTexture(title: string, subtitle: string, w = 512, h = 256): THREE.CanvasTexture {
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
  const site = useSiteLayout();
  const entrance = useMemo(() => customerEntrance(model, geo), [model, geo]);
  const tex = useMemo(() => signTexture('MARKET', name), [name]);
  const lang = useApp((s) => s.lang);
  const pylonTex = useMemo(() => {
    const f = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    return signTexture('MARKET', t('营业时间 {0}–{1}', f(hours.openMin), f(hours.closeMin)));
  }, [hours.openMin, hours.closeMin, lang]);
  const signMats = useRef<THREE.MeshBasicMaterial[]>([]);
  useFrame(() => {
    const k = 0.72 + 0.28 * env.night;
    for (const m of signMats.current) m.color.setScalar(k);
  });
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;
  if (!visible) return null;

  const x = entrance.outside.x;
  const addMat = (m: THREE.MeshBasicMaterial | null) => {
    if (m && !signMats.current.includes(m)) signMats.current.push(m);
  };
  const pylon = { x: geo.lot.minX + 5, z: (site.roadTopZ + 2.4 + geo.lot.edgeZ) / 2 };
  return (
    <group>
      {/* 自动门：门框 + 玻璃 */}
      {[-2.2, 2.2].map((dx) => (
        <mesh key={dx} position={[x + dx, 1.5, 0]} castShadow>
          <boxGeometry args={[0.25, 3, 0.35]} />
          <meshToonMaterial color="#5c6670" gradientMap={toonGradient()} />
        </mesh>
      ))}
      <mesh position={[x, 3.1, 0]} castShadow>
        <boxGeometry args={[4.7, 0.25, 0.4]} />
        <meshToonMaterial color="#5c6670" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[x, 1.45, 0]}>
        <boxGeometry args={[4.1, 2.9, 0.06]} />
        <meshStandardMaterial color="#a9d3ea" transparent opacity={0.28} />
      </mesh>
      {/* 雨棚 */}
      <mesh position={[x, 3.6, -1.6]} castShadow receiveShadow>
        <boxGeometry args={[7, 0.25, 3.4]} />
        <meshToonMaterial color="#2f7d55" gradientMap={toonGradient()} />
      </mesh>
      {[-3.2, 3.2].map((dx) => (
        <mesh key={`p${dx}`} position={[x + dx, 1.8, -3.1]} castShadow>
          <cylinderGeometry args={[0.09, 0.09, 3.6, 8]} />
          <meshToonMaterial color="#c7cdd2" gradientMap={toonGradient()} />
        </mesh>
      ))}
      {/* 门头招牌 */}
      <mesh position={[x, 5.2, -0.1]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[8, 2]} />
        <meshBasicMaterial ref={addMat} map={tex} side={THREE.DoubleSide} transparent toneMapped={false} />
      </mesh>
      {/* 购物车存放处 */}
      {Array.from({ length: 6 }, (_, k) => (
        <mesh key={`c${k}`} position={[x + 4.5 + k * 0.32, 0.55, -1.4]} castShadow>
          <boxGeometry args={[0.55, 0.9, 0.95]} />
          <meshToonMaterial color="#b8c2cc" gradientMap={toonGradient()} />
        </mesh>
      ))}
      {/* 路边立牌 */}
      <mesh position={[pylon.x, 4, pylon.z]} castShadow>
        <boxGeometry args={[0.5, 8, 0.5]} />
        <meshToonMaterial color="#6b7379" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[pylon.x, 8.2, pylon.z]} rotation={[0, Math.PI, 0]} castShadow>
        <boxGeometry args={[5, 2.5, 0.4]} />
        <meshToonMaterial color="#2f7d55" gradientMap={toonGradient()} />
      </mesh>
      {[-0.21, 0.21].map((dz) => (
        <mesh key={`s${dz}`} position={[pylon.x, 8.2, pylon.z + dz]} rotation={[0, dz < 0 ? Math.PI : 0, 0]}>
          <planeGeometry args={[4.8, 2.4]} />
          <meshBasicMaterial ref={addMat} map={pylonTex} transparent toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
