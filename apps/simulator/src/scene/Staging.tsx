import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { StagingState } from './motion';
import { SCENE, ZONE_COLOR } from './palette';
import { toonGradient } from './toon';
import { useNightGlow } from './environment';
import { armMenu } from './contextTarget';
import { liveSlotCount } from '../live/link';

const tmp = new THREE.Object3D();
const color = new THREE.Color();

/** 暂存区：货架 / 冷柜外形 + 按时刻显示的框 */
export function Staging() {
  const geo = useApp((s) => s.geo);
  const timeline = useApp((s) => s.timeline);
  const floor = useApp((s) => s.floor);
  const model = useApp((s) => s.model);
  const simGeo = useApp((s) => s.simGeo);
  const totesRef = useRef<THREE.InstancedMesh>(null);
  const stagingFloor = model.config.layout.points.staging.floorId;
  const y0 = geo.floorY.get(stagingFloor) ?? 0;
  const visible = floor === 'ALL' || floor === stagingFloor;

  // 框按仿真时的格位摆放（编辑中改了编码规则也不会错位）
  const slotList = useMemo(() => [...simGeo.slots.values()], [simGeo]);
  const maxTotes = useMemo(() => slotList.reduce((n, s) => n + s.capacity, 0) + 1, [slotList]);
  const state = useMemo(() => (timeline ? new StagingState(timeline.staging) : undefined), [timeline]);

  useEffect(() => {
    const mesh = totesRef.current;
    if (!mesh) return;
    for (let i = 0; i < maxTotes; i++) mesh.setColorAt(i, color.set(SCENE.tote));
  }, [maxTotes]);

  useFrame(() => {
    const mesh = totesRef.current;
    if (!mesh || !state) return;
    state.update(clock.time);
    // 门店实况：格位里的框来自后端的实时状态
    const app = useApp.getState();
    const live = app.liveView && app.live.status !== 'off';
    let i = 0;
    for (const s of slotList) {
      const n = Math.min(s.capacity, live ? liveSlotCount(s.code) : (state.counts.get(s.code) ?? 0));
      for (let k = 0; k < n; k++) {
        tmp.position.set(s.x + (k - (s.capacity - 1) / 2) * 0.2, s.y + 0.12, s.z);
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(0.18, 0.2, 0.42);
        tmp.updateMatrix();
        mesh.setMatrixAt(i, tmp.matrix);
        mesh.setColorAt(i, color.set(s.tempZone === 'AMBIENT' ? SCENE.tote : ZONE_COLOR[s.tempZone]).multiplyScalar(0.75));
        i++;
      }
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  const toteGlow = useNightGlow<THREE.MeshToonMaterial>(0.3);
  if (!visible) return null;

  const onRackClick = (e: ThreeEvent<MouseEvent>, zone: string) => {
    e.stopPropagation();
    useApp.getState().select({ type: 'staging', id: zone });
  };

  return (
    <group>
      {geo.racks.map((r) => {
        const height = r.levels * 0.42 + 0.1;
        const cold = r.tempZone === 'CHILLED' || r.tempZone === 'FROZEN' || r.tempZone === 'HOT';
        const zoneKey = r.purpose === 'RECOVERY' ? 'RECOVERY' : r.purpose === 'OVERSIZED' ? 'OVERSIZED' : r.tempZone;
        if (r.purpose === 'OVERSIZED') {
          return (
            <mesh key={r.rackId} position={[r.x, y0 + 0.02, r.z]} onClick={(e) => onRackClick(e, zoneKey)} onContextMenu={(e) => armMenu({ type: 'staging', id: zoneKey }, e)}>
              <boxGeometry args={[r.length, 0.04, 1.2]} />
              <meshBasicMaterial color="#f0c36a" transparent opacity={0.6} />
            </mesh>
          );
        }
        return (
          <group key={r.rackId} position={[r.x, y0, r.z]} onClick={(e) => onRackClick(e, zoneKey)} onContextMenu={(e) => armMenu({ type: 'staging', id: zoneKey }, e)}>
            {/* 柜体：冷柜为半透明的彩色箱体，常温货架为浅色框架 */}
            <mesh position={[0, height / 2, -0.32]} castShadow>
              <boxGeometry args={[r.length, height, 0.06]} />
              <meshToonMaterial color={cold ? ZONE_COLOR[r.tempZone] : SCENE.rack} gradientMap={toonGradient()} />
            </mesh>
            {Array.from({ length: r.levels + 1 }, (_, l) => (
              <mesh key={l} position={[0, l * 0.42 + 0.02, 0]} castShadow receiveShadow>
                <boxGeometry args={[r.length, 0.04, 0.62]} />
                <meshToonMaterial color={cold ? ZONE_COLOR[r.tempZone] : SCENE.rack} gradientMap={toonGradient()} />
              </mesh>
            ))}
            {cold && (
              <mesh position={[0, height / 2, 0]}>
                <boxGeometry args={[r.length + 0.04, height, 0.66]} />
                <meshStandardMaterial color={ZONE_COLOR[r.tempZone]} transparent opacity={0.18} />
              </mesh>
            )}
          </group>
        );
      })}
      <instancedMesh ref={totesRef} args={[undefined, undefined, maxTotes]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshToonMaterial ref={toteGlow} gradientMap={toonGradient()} />
      </instancedMesh>
    </group>
  );
}
