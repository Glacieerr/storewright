import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { activeDisruption } from './evacuation';

/**
 * 大事件的场景效果：火警时门店四角和入口的红色警灯闪烁；停电时店内变暗，只剩应急出口指示灯。
 * （消防车、警车在 Fleet 中绘制，人员疏散在人物组件中处理。）
 */
export function IncidentFx() {
  const geo = useApp((s) => s.simGeo);
  const timeline = useApp((s) => s.timeline);
  const strobes = useRef<THREE.Group>(null);
  const dark = useRef<THREE.Mesh>(null);
  const exits = useRef<THREE.Group>(null);
  const f0 = geo.floors[0];

  useFrame(() => {
    const t = clock.time;
    const fire = activeDisruption(timeline, t, 'FIRE_ALARM');
    const outage = activeDisruption(timeline, t, 'POWER_OUTAGE');
    const on = Math.floor(performance.now() / 300) % 2 === 0;
    if (strobes.current) {
      strobes.current.visible = !!fire;
      strobes.current.children.forEach((c, i) => {
        c.visible = (i % 2 === 0) === on;
      });
    }
    if (dark.current) dark.current.visible = !!outage;
    if (exits.current) exits.current.visible = !!outage;
  });

  if (!f0) return null;
  const w = f0.maxX - f0.minX;
  const d = f0.maxZ - f0.minZ;
  const corners: Array<[number, number]> = [
    [f0.minX + 0.5, f0.minZ + 0.5],
    [f0.maxX - 0.5, f0.minZ + 0.5],
    [f0.minX + 0.5, f0.maxZ - 0.5],
    [f0.maxX - 0.5, f0.maxZ - 0.5],
    [(f0.minX + f0.maxX) / 2, f0.minZ + 0.5],
    [geo.door.x, f0.minZ + 0.5],
  ];
  return (
    <group>
      <group ref={strobes} visible={false}>
        {corners.map(([x, z], i) => (
          <mesh key={i} position={[x, 3.2, z]}>
            <sphereGeometry args={[0.45, 12, 10]} />
            <meshBasicMaterial color="#ff2a1a" toneMapped={false} />
          </mesh>
        ))}
      </group>
      <mesh ref={dark} position={[(f0.minX + f0.maxX) / 2, 2.2, (f0.minZ + f0.maxZ) / 2]} visible={false} renderOrder={3}>
        <boxGeometry args={[w - 0.4, 4.4, d - 0.4]} />
        <meshBasicMaterial color="#0b0f16" transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <group ref={exits} visible={false}>
        {corners.slice(0, 4).map(([x, z], i) => (
          <mesh key={i} position={[x, 2.4, z]}>
            <boxGeometry args={[0.8, 0.3, 0.1]} />
            <meshBasicMaterial color="#2ee86f" toneMapped={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
