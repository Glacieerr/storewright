import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { backroomLayout } from '@storewright/store-config';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { toonGradient } from './toon';
import { liveClient } from '../live/link';

/**
 * 卸货口（决策记录 0013）：卷帘门、门框、防撞块、调节板和门边的信号灯。
 * 有车靠台卸货时卷帘门升起、信号灯变红，车走后门落下、信号灯变绿；冷藏门的门头有一条蓝色色带。
 * 卷帘门的开合按仿真时刻计算（可以拖动时间轴）。
 */

const OPEN_SEC = 25;
const DOOR_W = 3.0;
const DOOR_H = 3.2;

export function DockDoors() {
  const model = useApp((s) => s.simModel);
  const geo = useApp((s) => s.simGeo);
  const timeline = useApp((s) => s.timeline);
  const f0 = geo.floors[0];
  const docks = useMemo(() => backroomLayout(model.config).docks, [model]);
  const trucks = timeline?.inbound.trucks ?? [];
  // 门店实况：已到达、还没收完的收货单占用卸货口（与 LiveFleet 的停车顺序一致）
  const liveOnly = useApp((s) => s.liveView && s.live.status !== 'off');
  useApp((s) => s.liveVersion);
  const panels = useRef<Array<THREE.Mesh | null>>([]);
  const lights = useRef<Array<THREE.MeshBasicMaterial | null>>([]);

  useFrame(() => {
    const t = clock.time;
    const c = liveOnly ? liveClient() : undefined;
    const liveBusy = c ? Object.values(c.state.receipts).filter((r) => r.arrivedAt !== undefined && r.closedAt === undefined).length : 0;
    docks.forEach((_, i) => {
      if (liveOnly) {
        const p = panels.current[i];
        const busy = i < liveBusy;
        if (p) {
          const h = busy ? 0.05 : DOOR_H;
          p.scale.y = h;
          p.position.y = DOOR_H + 0.2 - h / 2;
        }
        lights.current[i]?.color.set(busy ? '#ff3b30' : '#2fd36b');
        return;
      }
      // 卷帘门：开始卸货前 1.5 分钟升起，车驶离后落下
      let open = 0;
      let busy = false;
      for (const tr of trucks) {
        if (tr.door !== i) continue;
        const a = tr.unloadStart - 90;
        const z = tr.leave + 30;
        if (t >= tr.dockAt && t <= tr.leave + 60) busy = true;
        if (t < a - OPEN_SEC || t > z + OPEN_SEC) continue;
        const up = Math.min(1, Math.max(0, (t - (a - OPEN_SEC)) / OPEN_SEC));
        const down = Math.min(1, Math.max(0, (z + OPEN_SEC - t) / OPEN_SEC));
        open = Math.max(open, Math.min(up, down));
      }
      const p = panels.current[i];
      if (p) {
        const h = Math.max(0.05, DOOR_H * (1 - open));
        p.scale.y = h;
        p.position.y = DOOR_H + 0.2 - h / 2;
      }
      lights.current[i]?.color.set(busy ? '#ff3b30' : '#2fd36b');
    });
  });

  if (!f0) return null;
  const z = f0.maxZ;
  return (
    <group>
      {docks.map((d, i) => (
        <group key={i} position={[d.x, 0, z]}>
          {/* 门框 */}
          <mesh position={[0, DOOR_H / 2 + 0.25, 0.16]}>
            <boxGeometry args={[DOOR_W + 0.5, DOOR_H + 0.5, 0.12]} />
            <meshToonMaterial color="#5b6168" gradientMap={toonGradient()} />
          </mesh>
          {/* 门洞（深色，门升起后能看到里面） */}
          <mesh position={[0, DOOR_H / 2 + 0.2, 0.2]}>
            <boxGeometry args={[DOOR_W, DOOR_H, 0.04]} />
            <meshBasicMaterial color="#2a2f34" />
          </mesh>
          {/* 卷帘门板 */}
          <mesh
            ref={(m) => {
              panels.current[i] = m;
            }}
            position={[0, DOOR_H / 2 + 0.2, 0.24]}
          >
            <boxGeometry args={[DOOR_W, 1, 0.06]} />
            <meshToonMaterial color="#aab3bb" gradientMap={toonGradient()} />
          </mesh>
          {/* 卷帘盒与冷藏门的蓝色门头 */}
          <mesh position={[0, DOOR_H + 0.45, 0.3]}>
            <boxGeometry args={[DOOR_W + 0.3, 0.35, 0.35]} />
            <meshToonMaterial color={d.reefer ? '#2f78c4' : '#6f777e'} gradientMap={toonGradient()} />
          </mesh>
          {/* 防撞块与调节板 */}
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 1.25, 1.15, 0.38]}>
              <boxGeometry args={[0.3, 0.5, 0.25]} />
              <meshToonMaterial color="#1f2124" gradientMap={toonGradient()} />
            </mesh>
          ))}
          <mesh position={[0, 1.12, 0.55]}>
            <boxGeometry args={[2.2, 0.06, 0.6]} />
            <meshToonMaterial color="#8d949a" gradientMap={toonGradient()} />
          </mesh>
          {/* 信号灯：红 = 有车卸货，绿 = 空闲 */}
          <mesh position={[DOOR_W / 2 + 0.55, 2.2, 0.3]}>
            <sphereGeometry args={[0.16, 10, 8]} />
            <meshBasicMaterial
              ref={(m) => {
                lights.current[i] = m;
              }}
              color="#2fd36b"
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}
