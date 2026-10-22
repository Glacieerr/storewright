import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import type { ConnectorGeometry } from './layout';
import { toonGradient } from './toon';
import { t } from '../i18n';

/** 扶梯踏步的条纹贴图（沿运行方向平移，看起来在走） */
function stepTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#5b6168';
    g.fillRect(0, 0, 64, 16);
    g.fillStyle = '#8a9097';
    for (let x = 0; x < 64; x += 8) g.fillRect(x, 0, 3, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 一条扶梯（上行或下行）：踏步、两侧玻璃栏板、扶手、上下落地板 */
function Flight({ c, dz, up }: { c: ConnectorGeometry; dz: number; up: boolean }) {
  const tex = useMemo(() => {
    const t = stepTexture();
    t.repeat.set(10, 1);
    return t;
  }, []);
  useFrame((_, delta) => {
    // 踏步按画面时间移动；暂停时静止
    if (clock.playing) tex.offset.x += (up ? -1 : 1) * delta * 0.6;
  });
  const b = c.bottom as NonNullable<ConnectorGeometry['bottom']>;
  const t = c.top as NonNullable<ConnectorGeometry['top']>;
  const run = t.x - b.x;
  const rise = t.y - b.y;
  const len = Math.hypot(run, rise);
  const ang = Math.atan2(rise, run);
  const cx = (b.x + t.x) / 2;
  const cy = (b.y + t.y) / 2;
  const z = c.z + dz;
  return (
    <group>
      <mesh position={[cx, cy + 0.15, z]} rotation={[0, 0, ang]} castShadow receiveShadow>
        <boxGeometry args={[len, 0.3, 1.0]} />
        <meshStandardMaterial map={tex} color="#ffffff" metalness={0.4} roughness={0.5} />
      </mesh>
      {[-0.56, 0.56].map((s) => (
        <group key={s}>
          <mesh position={[cx, cy + 0.75, z + s]} rotation={[0, 0, ang]}>
            <boxGeometry args={[len, 0.9, 0.04]} />
            <meshStandardMaterial color="#cfe6f2" transparent opacity={0.3} />
          </mesh>
          <mesh position={[cx, cy + 1.22, z + s]} rotation={[0, 0, ang]}>
            <boxGeometry args={[len + 0.4, 0.07, 0.09]} />
            <meshToonMaterial color="#25282b" gradientMap={toonGradient()} />
          </mesh>
        </group>
      ))}
      {[b, t].map((p, i) => (
        <mesh key={i} position={[p.x + (i === 0 ? -0.9 : 0.9), p.y + 0.02, z]} receiveShadow>
          <boxGeometry args={[1.8, 0.05, 1.1]} />
          <meshStandardMaterial color="#9aa1a8" metalness={0.6} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

/** 电梯：玻璃井道 + 上下运行的轿厢 */
function Elevator({ c, index }: { c: ConnectorGeometry; index: number }) {
  const cab = useRef<THREE.Mesh>(null);
  const x = c.x - 1.7;
  const h = c.y1 - c.y0 + 3.2;
  useFrame(() => {
    const m = cab.current;
    if (!m) return;
    // 往返一次约 90 秒（仿真时间），两端各停靠 20 秒
    const cycle = 90;
    const p = ((clock.time + index * 31) % cycle) / cycle;
    const k = p < 0.22 ? 0 : p < 0.5 ? (p - 0.22) / 0.28 : p < 0.72 ? 1 : 1 - (p - 0.72) / 0.28;
    const e = k * k * (3 - 2 * k);
    m.position.y = c.y0 + 1.25 + (c.y1 - c.y0) * e;
  });
  return (
    <group>
      {[-1.15, 1.15].flatMap((dx) =>
        [-1.15, 1.15].map((dz) => (
          <mesh key={`${dx}${dz}`} position={[x + dx, c.y0 + h / 2, c.z + dz]} castShadow>
            <boxGeometry args={[0.12, h, 0.12]} />
            <meshToonMaterial color="#6b7379" gradientMap={toonGradient()} />
          </mesh>
        )),
      )}
      <mesh position={[x, c.y0 + h / 2, c.z]}>
        <boxGeometry args={[2.3, h, 2.3]} />
        <meshStandardMaterial color="#bfe0ef" transparent opacity={0.16} depthWrite={false} />
      </mesh>
      <mesh ref={cab} position={[x, c.y0 + 1.25, c.z]} castShadow>
        <boxGeometry args={[2.0, 2.4, 2.0]} />
        <meshToonMaterial color="#d9dde0" gradientMap={toonGradient()} />
      </mesh>
    </group>
  );
}

/** 楼层之间的电梯和自动扶梯（只有两层门店才有） */
export function Connectors() {
  const geo = useApp((s) => s.geo);
  const showLabels = useApp((s) => s.mode === 'sim' && s.buildingView === 'interior');
  // 电梯和扶梯跨越两层，任何楼层视图中都显示
  if (!geo.connectors.length) return null;
  return (
    <group>
      {geo.connectors.map((c, i) =>
        c.kind === 'ESCALATOR' && c.bottom && c.top ? (
          <group key={c.id}>
            <Flight c={c} dz={-0.65} up />
            <Flight c={c} dz={0.65} up={false} />
            {showLabels && (
              <Html position={[c.x, (c.y0 + c.y1) / 2 + 2, c.z]} center className="scene-label">
                {t('扶梯 {0}', c.id.replace('ESC-', ''))}
              </Html>
            )}
          </group>
        ) : (
          <group key={c.id}>
            <Elevator c={c} index={i} />
            {showLabels && (
              <Html position={[c.x - 1.7, c.y1 + 3.8, c.z]} center className="scene-label">
                {t('电梯 {0}', c.id.replace('ELEV-', ''))}
              </Html>
            )}
          </group>
        ),
      )}
    </group>
  );
}
