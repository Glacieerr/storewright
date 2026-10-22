import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { FACILITY_BAY_W, type FacilityGeometry } from './layout';
import { toonGradient } from './toon';
import { armMenu } from './contextTarget';
import { t } from '../i18n';

const tmp = new THREE.Object3D();
const WALL = '#e4e0d8';
const FLOOR = '#c4c8cb';
const ACCENT = '#c8433a';
const TECH = '#2f4a7a';

function Box({ x, y, z, w, h, d, color, opacity }: { x: number; y: number; z: number; w: number; h: number; d: number; color: string; opacity?: number }) {
  return (
    <mesh position={[x, y + h / 2, z]} castShadow={opacity === undefined} receiveShadow>
      <boxGeometry args={[w, h, d]} />
      {opacity !== undefined ? <meshStandardMaterial color={color} transparent opacity={opacity} /> : <meshToonMaterial color={color} gradientMap={toonGradient()} />}
    </mesh>
  );
}

/** 一座汽车快修中心：开放式工位（卷帘门上方是招牌带）、举升机 / 地沟、轮胎货架和顾客休息室 */
function Building({ fac }: { fac: FacilityGeometry }) {
  const mode = useApp((s) => s.mode);
  const w = fac.x1 - fac.x0;
  const d = fac.z1 - fac.z0;
  const cx = (fac.x0 + fac.x1) / 2;
  const cz = (fac.z0 + fac.z1) / 2;
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const app = useApp.getState();
    app.select({ type: 'facility', id: fac.id });
    app.focusOn((fac.x0 + fac.x1) / 2, 0, (fac.z0 + fac.z1) / 2 - 6);
  };
  const bayEdges = useMemo(() => {
    const xs = new Set<number>();
    for (const b of fac.bays) {
      xs.add(Math.round((b.x - FACILITY_BAY_W / 2) * 100) / 100);
      xs.add(Math.round((b.x + FACILITY_BAY_W / 2) * 100) / 100);
    }
    return [...xs];
  }, [fac]);
  const outerX = fac.side === 'LEFT' ? fac.x0 : fac.x1;
  const officeCx = (fac.office.x0 + fac.office.x1) / 2;
  return (
    <group onClick={onClick} onContextMenu={(e) => armMenu({ type: 'facility', id: fac.id }, e)}>
      {/* 地面与前方的车道坡口 */}
      <Box x={cx} y={-0.06} z={cz} w={w} h={0.12} d={d} color={FLOOR} />
      <Box x={cx - (fac.side === 'LEFT' ? 3 : -3)} y={-0.05} z={-1.5} w={w - 6} h={0.14} d={3} color="#b7bcc0" />
      {/* 后墙、外侧墙（剖切显示，不加屋顶） */}
      <Box x={cx} y={0} z={fac.z1 - 0.15} w={w} h={fac.height} d={0.3} color={WALL} />
      <Box x={outerX} y={0} z={cz} w={0.3} h={fac.height} d={d} color={WALL} />
      <Box x={fac.side === 'LEFT' ? fac.x1 : fac.x0} y={0} z={cz} w={0.3} h={1.0} d={d} color={WALL} />
      {/* 正面招牌带与立柱 */}
      <Box x={cx} y={fac.height - 1.1} z={0.1} w={w} h={1.1} d={0.35} color={ACCENT} />
      {bayEdges.map((x) => (
        <Box key={x} x={x} y={0} z={0.1} w={0.35} h={fac.height - 1.1} d={0.35} color="#d9d4ca" />
      ))}
      {/* 工位：轮胎工位有两根举升立柱，机油工位有地沟 */}
      {fac.bays.map((b, i) =>
        b.kind === 'TIRE' ? (
          <group key={i}>
            <Box x={b.x - 1.55} y={0} z={b.z} w={0.3} h={3.2} d={0.5} color="#e2b33c" />
            <Box x={b.x + 1.55} y={0} z={b.z} w={0.3} h={3.2} d={0.5} color="#e2b33c" />
          </group>
        ) : (
          <Box key={i} x={b.x} y={-0.05} z={b.z} w={1.0} h={0.11} d={4.8} color="#3b4146" />
        ),
      )}
      {/* 轮胎货架 */}
      {fac.bays
        .filter((b) => b.kind === 'TIRE')
        .map((b, i) => (
          <group key={`r${i}`}>
            {[0, 1, 2].map((k) => (
              <mesh key={k} position={[b.x - 1 + k * 1, 0.4 + (k % 2) * 0.05, fac.z1 - 1.0]} rotation={[0, 0, Math.PI / 2]}>
                <torusGeometry args={[0.32, 0.12, 6, 12]} />
                <meshToonMaterial color="#2b2e31" gradientMap={toonGradient()} />
              </mesh>
            ))}
          </group>
        ))}
      {/* 顾客休息室（玻璃） */}
      <Box x={officeCx} y={0} z={cz} w={fac.office.x1 - fac.office.x0 - 0.4} h={3} d={d - 1} color="#9ec3dc" opacity={0.35} />
      {mode === 'sim' && (
        <Html position={[cx, fac.height + 0.8, 0]} center className="scene-label area-label service-label">
          {t('汽车服务 · 机油 {0} / 轮胎 {1}', fac.bays.filter((b) => b.kind === 'OIL').length, fac.bays.filter((b) => b.kind === 'TIRE').length)}
        </Html>
      )}
    </group>
  );
}

/** 技师：在作业中的工位旁边走动（换轮胎两人，换机油一人） */
function Technicians({ facs }: { facs: FacilityGeometry[] }) {
  const timeline = useApp((s) => s.timeline);
  const body = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const max = 48;
  useFrame(() => {
    const b = body.current;
    const h = head.current;
    if (!b || !h) return;
    const t = clock.time;
    let n = 0;
    for (const a of timeline?.autoService ?? []) {
      const fac = facs.find((f) => f.id === a.facilityId);
      if (!fac) continue;
      for (const j of a.jobs) {
        if (j.start === undefined || j.end === undefined || t < j.start + 30 || t >= j.end || j.bay === undefined) continue;
        const bay = fac.bays[j.bay];
        if (!bay) continue;
        const people = j.kind === 'TIRE' ? 2 : 1;
        for (let p = 0; p < people && n < max; p++) {
          // 绕车慢慢移动，模拟检查、拆装的动作
          const phase = (t / 40 + p * 0.5 + j.bay * 0.17) % 1;
          const side = p === 0 ? 1 : -1;
          const x = bay.x + side * 1.25;
          const z = bay.z + Math.sin(phase * Math.PI * 2) * 1.6;
          tmp.position.set(x, 0.75, z);
          tmp.rotation.set(0, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0);
          tmp.scale.set(1.4, 1.4, 1.4);
          tmp.updateMatrix();
          b.setMatrixAt(n, tmp.matrix);
          tmp.position.set(x, 1.62, z);
          tmp.updateMatrix();
          h.setMatrixAt(n, tmp.matrix);
          n++;
        }
      }
    }
    for (const m of [b, h]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <group>
      <instancedMesh ref={body} args={[undefined, undefined, max]} frustumCulled={false}>
        <capsuleGeometry args={[0.2, 0.55, 3, 8]} />
        <meshToonMaterial color={TECH} gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, max]} frustumCulled={false}>
        <sphereGeometry args={[0.16, 10, 8]} />
        <meshToonMaterial color="#f1c9a5" gradientMap={toonGradient()} />
      </instancedMesh>
    </group>
  );
}

export function AutoServiceCenters() {
  const facs = useApp((s) => s.geo.facilities);
  const floor = useApp((s) => s.floor);
  const geo = useApp((s) => s.geo);
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;
  if (!visible || !facs.length) return null;
  return (
    <group>
      {facs.map((f) => (
        <Building key={f.id} fac={f} />
      ))}
      <Technicians facs={facs} />
    </group>
  );
}
