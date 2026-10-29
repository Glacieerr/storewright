import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { SiteLayout } from '../site';
import { clock } from '../../state/clock';
import { useApp } from '../../state/store';
import { railClosed, trainsAt, trainsFor } from '../crossings';
import { boxGeo, mergeAll } from '../terrain/geom';
import { toonGradient } from '../toon';
import { Slabs } from './Slabs';

/**
 * 铁路与道口（决策记录 0019）：碎石路基、枕木、两根钢轨，穿过主路处铺橡胶道口板；
 * 道口四角立着叉形标志和红色闪灯，两侧各有一根栏杆——火车来之前 25 秒栏杆放下、闪灯交替闪，车尾过去 5 秒后抬起。
 * 火车按时刻表经过（通勤列车或长货车），背景车流在停止线前排队。
 */

const GAUGE = 1.435;
const TIE = 0.65;
const MAX_CARS = 24;

/** 一节车厢 / 机车：车体、车窗带或货车的箱体，按实例上色 */
function carGeometry(): THREE.BufferGeometry {
  return mergeAll([boxGeo(-1.5, 1.5, 0.95, 4.0, -0.5, 0.5), boxGeo(-1.35, 1.35, 0.45, 0.95, -0.42, 0.42)]);
}

export function Railway({ site }: { site: SiteLayout }) {
  const r = site.railway;
  const seed = useApp((s) => s.site.seed);
  const trains = useMemo(() => (r ? trainsFor(seed) : []), [r, seed]);
  // 调试：地址栏带 ?debug 时可以查看列车时刻表
  useEffect(() => {
    const g = window as unknown as { __sw?: Record<string, unknown> };
    if (g.__sw) g.__sw.trains = trains;
  }, [trains]);
  const statics = useMemo(() => {
    if (!r) return undefined;
    const ballast = [{ x: r.x, z: (r.z0 + r.z1) / 2, w: 4.2, d: r.z1 - r.z0 }];
    const rails = [-GAUGE / 2, GAUGE / 2].map((dx) => ({ x: r.x + dx, z: (r.z0 + r.z1) / 2, w: 0.09, d: r.z1 - r.z0 }));
    const ties: Array<{ x: number; z: number; w: number; d: number }> = [];
    for (let z = r.z0 + 0.4; z < r.z1; z += TIE) if (z < r.roadZ0 - 0.3 || z > r.roadZ1 + 0.3) ties.push({ x: r.x, z, w: 2.6, d: 0.24 });
    // 道口：路面上的橡胶道口板（钢轨两侧）
    const panel = [{ x: r.x, z: (r.roadZ0 + r.roadZ1) / 2, w: 3.4, d: r.roadZ1 - r.roadZ0 + 1 }];
    // 四角的叉形标志与闪灯（灯朝向来车方向），两侧的栏杆（在来车方向的右侧路边）
    const posts = [
      { x: r.x - 3.4, z: r.roadZ1 + 0.4, face: Math.PI / 2 },
      { x: r.x + 3.4, z: r.roadZ0 - 0.4, face: -Math.PI / 2 },
      { x: r.x - 3.4, z: r.roadZ0 - 0.4, face: Math.PI / 2 },
      { x: r.x + 3.4, z: r.roadZ1 + 0.4, face: -Math.PI / 2 },
    ];
    // 栏杆臂长：从人行道外的立柱伸到路中线
    const half = (r.roadZ1 - r.roadZ0) / 2 + 0.4;
    const gates = [
      { x: r.x - 3.05, z: r.roadZ1 + 0.4, yaw: 0, len: half },
      { x: r.x + 3.05, z: r.roadZ0 - 0.4, yaw: Math.PI, len: half },
    ];
    return { ballast, rails, ties, panel, posts, gates };
  }, [r]);
  const gateRefs = useRef<Array<THREE.Group | null>>([]);
  const lightRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const carRef = useRef<THREE.InstancedMesh>(null);
  const carGeo = useMemo(() => carGeometry(), []);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const angle = useRef(0);
  useFrame((_, delta) => {
    if (!r) return;
    const t = clock.time;
    const closed = railClosed(trains, t);
    // 栏杆：约 6 秒放下 / 抬起（按画面时间平滑）
    const target = closed ? 1 : 0;
    angle.current += (target - angle.current) * Math.min(1, delta * 1.2);
    gateRefs.current.forEach((g) => {
      if (g) g.rotation.x = (1 - angle.current) * (Math.PI / 2) * 0.96;
    });
    const blink = Math.floor(performance.now() / 500) % 2;
    lightRefs.current.forEach((m, i) => m?.color.set(closed ? ((i % 2) === blink ? '#ff3b2f' : '#4a1410') : '#3a1a18'));
    // 列车：车头沿行驶方向的位置，车厢一节接一节
    const m = carRef.current;
    if (!m) return;
    let n = 0;
    const zc = (r.roadZ0 + r.roadZ1) / 2;
    for (const { train, head } of trainsAt(trains, t, r.z1 - r.z0)) {
      const cars = Math.round((train.len - (train.kind === 'freight' ? 22 : 0)) / train.car) + (train.kind === 'freight' ? 1 : 0);
      for (let k = 0; k < cars && n < MAX_CARS; k++) {
        const loco = train.kind === 'freight' && k === 0;
        const len = loco ? 22 : train.car;
        const off = loco ? 0 : train.kind === 'freight' ? 22 + (k - 1) * train.car : k * train.car;
        const mid = head - off - len / 2;
        const z = zc + train.dir * mid;
        if (z < r.z0 - len || z > r.z1 + len) continue;
        tmp.position.set(r.x, 0.18, z);
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(1, 1, len - 0.8);
        tmp.updateMatrix();
        m.setMatrixAt(n, tmp.matrix);
        m.setColorAt(n, col.set(loco ? '#2d5f8f' : train.kind === 'freight' ? (['#8a4b2f', '#6b6f73', '#3f6f55', '#9a7a3f'][k % 4] as string) : k === 0 ? '#e6e8ea' : '#d9dde0'));
        n++;
      }
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  useLayoutEffect(() => {
    if (carRef.current) carRef.current.count = 0;
  }, []);
  if (!r || !statics) return null;
  return (
    <group>
      <Slabs items={statics.ballast} y={-0.1} h={0.16} color="#9a958c" receive />
      <Slabs items={statics.ties} y={0.04} h={0.12} color="#6e5a46" receive />
      <Slabs items={statics.rails} y={0.14} h={0.12} color="#8d939a" cast />
      <Slabs items={statics.panel} y={-0.1} h={0.075} color="#3c3f42" receive />
      {statics.posts.map((p, i) => (
        <group key={i} position={[p.x, 0.08, p.z]} rotation={[0, p.face, 0]}>
          <mesh position={[0, 1.7, 0]} castShadow>
            <cylinderGeometry args={[0.07, 0.08, 3.4, 8]} />
            <meshToonMaterial color="#e9ecef" gradientMap={toonGradient()} />
          </mesh>
          {/* 叉形标志 */}
          {[-0.62, 0.62].map((a) => (
            <mesh key={a} position={[0, 3.05, 0.09]} rotation={[0, 0, a]}>
              <boxGeometry args={[1.25, 0.2, 0.04]} />
              <meshToonMaterial color="#f4f2ea" gradientMap={toonGradient()} />
            </mesh>
          ))}
          {/* 两盏交替闪的红灯 */}
          {[-0.32, 0.32].map((dx, k) => (
            <mesh key={dx} position={[dx, 2.3, 0.12]}>
              <circleGeometry args={[0.15, 16]} />
              <meshBasicMaterial
                ref={(mm) => {
                  lightRefs.current[i * 2 + k] = mm;
                }}
                color="#3a1a18"
                side={THREE.DoubleSide}
              />
            </mesh>
          ))}
        </group>
      ))}
      {/* 栏杆：竖起时朝上，放下时横在来车那一侧的车道上方（红白相间）；路北边的拦东行车道，路南边的拦西行车道 */}
      {statics.gates.map((g, i) => (
        <group
          key={`g${i}`}
          position={[g.x, 1.13, g.z]}
          rotation={[0, g.yaw, 0, 'YXZ']}
          ref={(gr) => {
            gateRefs.current[i] = gr;
          }}
        >
          <mesh position={[0, 0, -g.len / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.05, 0.05, g.len, 6]} />
            <meshToonMaterial color="#f2f2ee" gradientMap={toonGradient()} />
          </mesh>
          {Array.from({ length: Math.floor(g.len / 1.8) }, (_, k) => -1.2 - k * 1.8).map((zz) => (
            <mesh key={zz} position={[0, 0, zz]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.055, 0.055, 0.7, 6]} />
              <meshToonMaterial color="#d33a2c" gradientMap={toonGradient()} />
            </mesh>
          ))}
        </group>
      ))}
      <instancedMesh ref={carRef} args={[carGeo, undefined, MAX_CARS]} frustumCulled={false} castShadow>
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
    </group>
  );
}
