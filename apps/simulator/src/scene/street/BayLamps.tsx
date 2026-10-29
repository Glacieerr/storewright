import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LotLayout } from '../lot';
import { SPOT_D } from '../lot';
import { env } from '../environment';
import { toonGradient } from '../toon';

/**
 * 线上取货车位的立牌：编号牌 + 顶上的状态灯，颜色跟着车位上的实时情况——
 * 空闲绿、有车在等蓝、等太久红色闪烁、正在交付琥珀色（与车边的状态圈一致）。
 * 仿真时由 Fleet、连上门店时由 LiveFleet 每帧写入 bayStatus。
 */

export type BayState = 'waiting' | 'longWait' | 'serving';

/** 车位下标（lot.spots 的下标）→ 当前状态；每帧由车辆渲染组件整体替换 */
export const bayStatus: { map: Map<number, BayState>; at: number } = { map: new Map(), at: 0 };

export function setBayStatus(map: Map<number, BayState>): void {
  bayStatus.map = map;
  bayStatus.at = performance.now();
}

const FREE = new THREE.Color('#5fd27a');
const COLOR: Record<BayState, THREE.Color> = {
  waiting: new THREE.Color('#4aa6ff'),
  longWait: new THREE.Color('#ff4a4a'),
  serving: new THREE.Color('#ffb02e'),
};

function plateTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 96;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#ee8a35';
    g.beginPath();
    g.roundRect(0, 0, 128, 96, 14);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${label.length > 2 ? 40 : 56}px system-ui, sans-serif`;
    g.fillText(label, 64, 52);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function BayLamps({ lot }: { lot: LotLayout }) {
  const bays = useMemo(() => {
    const out: Array<{ idx: number; x: number; z: number; ry: number; label: string }> = [];
    let n = 0;
    lot.spots.forEach((s, idx) => {
      if (s.kind !== 'pickup') return;
      n++;
      const dir = s.heading === 0 ? 1 : -1;
      out.push({ idx, x: s.x, z: s.z + (SPOT_D / 2 + 0.35) * dir, ry: dir > 0 ? Math.PI : 0, label: s.id ?? String(n) });
    });
    return out;
  }, [lot]);
  const plates = useMemo(() => bays.map((b) => plateTexture(b.label)), [bays]);
  const lamp = useRef<THREE.InstancedMesh>(null);
  const col = useMemo(() => new THREE.Color(), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const m = lamp.current;
    if (!m) return;
    // 一秒多没有新数据（例如切换到只看路况），就当作没有车
    const fresh = performance.now() - bayStatus.at < 1500;
    const boost = 1.6 + 1.6 * env.night;
    const blink = Math.sin(clock.elapsedTime * 7) > 0;
    bays.forEach((b, i) => {
      o.position.set(b.x, 2.3, b.z);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(0.11);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      const st = fresh ? bayStatus.map.get(b.idx) : undefined;
      if (!st) col.copy(FREE).multiplyScalar(0.9 + 0.6 * env.night);
      else if (st === 'longWait') col.copy(COLOR.longWait).multiplyScalar(blink ? boost : 0.35);
      else col.copy(COLOR[st]).multiplyScalar(boost);
      m.setColorAt(i, col);
    });
    m.count = bays.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  if (!bays.length) return null;
  return (
    <group>
      {bays.map((b, i) => (
        <mesh key={b.idx} position={[b.x, 1.92, b.z]} rotation={[0, b.ry, 0]} castShadow>
          <boxGeometry args={[0.5, 0.38, 0.04]} />
          <meshToonMaterial attach="material" map={plates[i]} gradientMap={toonGradient()} />
        </mesh>
      ))}
      <instancedMesh key={bays.length} ref={lamp} args={[undefined, undefined, bays.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 12, 10]} />
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
    </group>
  );
}
