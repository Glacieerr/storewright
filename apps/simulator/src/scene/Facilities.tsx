import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import type { GardenGeometry } from './layout';
import { People, type PersonState } from './People';
import { toonGradient } from './toon';
import { t } from '../i18n';

const tmp = new THREE.Object3D();
const col = new THREE.Color();
const FLOWERS = ['#e86a8a', '#f2c14e', '#b48ee0', '#ff8a5b', '#f4f1ea', '#e34b4b', '#7cc6e8'];

/** 园艺中心：围栏、遮阳棚、花架和收银亭 */
function Garden({ g }: { g: GardenGeometry }) {
  const mode = useApp((s) => s.mode);
  const pots = useRef<THREE.InstancedMesh>(null);
  const tables = useMemo(() => {
    const out: Array<{ x: number; z: number }> = [];
    for (let x = g.x0 + 2.5; x < g.x1 - 2; x += 3.2) for (let z = g.z0 + 3; z < g.z1 - 6; z += 2.8) out.push({ x, z });
    return out;
  }, [g]);
  const potCount = tables.length * 6;
  useLayoutEffect(() => {
    const m = pots.current;
    if (!m) return;
    let i = 0;
    for (const t of tables) {
      for (let k = 0; k < 6; k++) {
        tmp.position.set(t.x - 0.9 + (k % 3) * 0.9, 1.05, t.z - 0.35 + Math.floor(k / 3) * 0.7);
        const sc = 0.28 + ((i * 37) % 10) / 60;
        tmp.scale.set(sc, sc, sc);
        tmp.updateMatrix();
        m.setMatrixAt(i, tmp.matrix);
        m.setColorAt(i, col.set(FLOWERS[(i * 7) % FLOWERS.length] as string));
        i++;
      }
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [tables]);
  const w = g.x1 - g.x0;
  const d = g.z1 - g.z0;
  const cx = (g.x0 + g.x1) / 2;
  const cz = (g.z0 + g.z1) / 2;
  return (
    <group onClick={(e) => e.stopPropagation()}>
      <mesh position={[cx, -0.04, cz]} receiveShadow>
        <boxGeometry args={[w, 0.08, d]} />
        <meshToonMaterial color="#cfc6b4" gradientMap={toonGradient()} />
      </mesh>
      {/* 围栏（正面留出入口） */}
      {[
        [cx, g.z1, w, 0.1],
        [g.x0, cz, 0.1, d],
        [g.x1, cz, 0.1, d],
        [g.x0 + w * 0.2, g.z0, w * 0.4, 0.1],
        [g.x1 - w * 0.2, g.z0, w * 0.4, 0.1],
      ].map(([x, z, sx, sz], i) => (
        <mesh key={i} position={[x as number, 1.1, z as number]}>
          <boxGeometry args={[sx as number, 2.2, sz as number]} />
          <meshStandardMaterial color="#5a6b5d" transparent opacity={0.55} wireframe={false} />
        </mesh>
      ))}
      {/* 遮阳棚 */}
      <mesh position={[cx, 4.2, g.z1 - 3]} castShadow>
        <boxGeometry args={[w - 1, 0.15, 6]} />
        <meshStandardMaterial color="#e9f2e4" transparent opacity={0.75} />
      </mesh>
      {tables.map((t, i) => (
        <mesh key={i} position={[t.x, 0.45, t.z]} castShadow receiveShadow>
          <boxGeometry args={[2.6, 0.9, 1.4]} />
          <meshToonMaterial color="#8a6e55" gradientMap={toonGradient()} />
        </mesh>
      ))}
      <instancedMesh ref={pots} args={[undefined, undefined, Math.max(1, potCount)]} castShadow>
        <icosahedronGeometry args={[1, 0]} />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <mesh position={[g.side === 'LEFT' ? g.x1 - 2 : g.x0 + 2, 1.2, g.z0 + 2]} castShadow>
        <boxGeometry args={[2.4, 2.4, 2]} />
        <meshToonMaterial color="#2f7d55" gradientMap={toonGradient()} />
      </mesh>
      {mode === 'sim' && (
        <Html position={[cx, 3.2, g.z0]} center className="scene-label area-label garden-label">
          {t('园艺中心')}
        </Html>
      )}
    </group>
  );
}

const PATIENT_SHIRTS = ['#c9b8a6', '#9fb4c7', '#b6c7a6', '#d8c2c2', '#a8a6c8'].map((c) => new THREE.Color(c));

/** 店内药房：柜台、标识，以及排队和在柜台前办理的顾客（来自药房仿真） */
function Pharmacy() {
  const geo = useApp((s) => s.simGeo);
  const timeline = useApp((s) => s.timeline);
  const buildingView = useApp((s) => s.buildingView);
  const ph = geo.pharmacy;
  const fill = (out: PersonState[]) => {
    const visits = timeline?.pharmacy?.visits;
    if (!ph || !visits) return 0;
    const t = clock.time;
    let n = 0;
    let q = 0;
    for (const v of visits) {
      if (v.arrive > t) break;
      if (v.end !== undefined && t >= v.end) continue;
      const o = out[n];
      if (!o) break;
      let x: number;
      let z: number;
      if (v.start !== undefined && t >= v.start && v.counter !== undefined) {
        const c = ph.counters[v.counter] ?? ph.counters[0];
        x = c?.x ?? ph.x0;
        z = (c?.z ?? 3) - 1.3;
      } else {
        const spot = ph.queue[Math.min(q++, ph.queue.length - 1)] ?? ph.queue[0];
        x = spot?.x ?? ph.x1;
        z = spot?.z ?? 2;
      }
      o.x = x;
      o.y = 0;
      o.z = z;
      o.heading = Math.PI / 2 + Math.PI;
      o.moving = false;
      o.shirt.copy(PATIENT_SHIRTS[n % PATIENT_SHIRTS.length] as THREE.Color);
      o.pants.set('#3b4250');
      o.cart = 'none';
      o.scale = 1.25;
      o.seed = n;
      n++;
    }
    return n;
  };
  if (!ph) return null;
  const w = ph.x1 - ph.x0;
  return (
    <group>
      <mesh position={[(ph.x0 + ph.x1) / 2, 0.55, 4.1]} castShadow receiveShadow>
        <boxGeometry args={[w - 1, 1.1, 0.7]} />
        <meshToonMaterial color="#f3f1ec" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[(ph.x0 + ph.x1) / 2, 0.02, 2.6]} receiveShadow>
        <boxGeometry args={[w + 5, 0.03, 4.2]} />
        <meshToonMaterial color="#dfe9ef" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[(ph.x0 + ph.x1) / 2, 2.6, 4.5]}>
        <boxGeometry args={[w - 1, 0.6, 0.1]} />
        <meshBasicMaterial color="#2f7db5" toneMapped={false} />
      </mesh>
      {ph.counters.map((c, i) => (
        <mesh key={i} position={[c.x, 1.45, c.z]}>
          <boxGeometry args={[0.5, 0.35, 0.05]} />
          <meshStandardMaterial color="#334552" />
        </mesh>
      ))}
      <People max={24} fill={fill} />
      {buildingView === 'interior' && (
        <Html position={[(ph.x0 + ph.x1) / 2, 3.4, 4.5]} center className="scene-label area-label pharmacy-label">
          {t('药房')}
        </Html>
      )}
    </group>
  );
}

export function Facilities() {
  const gardens = useApp((s) => s.geo.gardens);
  const floor = useApp((s) => s.floor);
  const geo = useApp((s) => s.geo);
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;
  if (!visible) return null;
  return (
    <group>
      {gardens.map((g) => (
        <Garden key={g.id} g={g} />
      ))}
      <Pharmacy />
    </group>
  );
}
