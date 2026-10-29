import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { backroomLayout } from '@storewright/store-config';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { toonGradient } from './toon';
import { liveClient, viewState } from '../live/link';
import { env } from './environment';
import { lampGlass, lampMetal } from './style/lights';

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
    const liveBusy = c ? Object.values((viewState() ?? c.state).receipts).filter((r) => r.arrivedAt !== undefined && r.closedAt === undefined).length : 0;
    docks.forEach((_, i) => {
      if (liveOnly) {
        const p = panels.current[i];
        const busy = i < liveBusy;
        if (p) {
          const h = busy ? 0.05 : DOOR_H;
          p.scale.y = h;
          p.position.y = DOOR_H + 0.2 - h / 2;
        }
        lights.current[i]?.color.set(busy ? '#ff3b30' : '#2fd36b').multiplyScalar(1 + 1.8 * env.night);
        return;
      }
      // 卷帘门：车靠稳、调平板放好后升起（开始卸货前 1.5 分钟），车拉出之前落下；
      // 门口的灯：有车被派到这个门（正在倒车过来）到车拉出之后都是红灯
      let open = 0;
      let busy = false;
      for (const tr of trucks) {
        if (tr.door !== i) continue;
        const a = tr.unloadStart - 90;
        const z = tr.leave - OPEN_SEC - 5;
        if (t >= tr.dockAt && t <= tr.leave + 45) busy = true;
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
      lights.current[i]?.color.set(busy ? '#ff3b30' : '#2fd36b').multiplyScalar(1 + 1.8 * env.night);
    });
  });

  if (!f0) return null;
  const z = f0.maxZ;
  const xs = docks.map((d) => d.x);
  const c0 = Math.min(...xs) - DOOR_W / 2 - 1.6;
  const c1 = Math.max(...xs) + DOOR_W / 2 + 1.6;
  return (
    <group>
      {/* 卸货雨棚：贯通所有卸货口，斜撑托着 */}
      {docks.length > 0 && (
        <group>
          <mesh position={[(c0 + c1) / 2, 4.85, z + 1.25]} rotation={[0.06, 0, 0]} castShadow receiveShadow>
            <boxGeometry args={[c1 - c0, 0.14, 2.4]} />
            <meshToonMaterial color="#e3e6e8" gradientMap={toonGradient()} />
          </mesh>
          <mesh position={[(c0 + c1) / 2, 4.95, z + 2.42]} castShadow>
            <boxGeometry args={[c1 - c0, 0.32, 0.1]} />
            <meshToonMaterial color="#2f7d55" gradientMap={toonGradient()} />
          </mesh>
          {Array.from({ length: Math.max(2, Math.round((c1 - c0) / 6) + 1) }, (_, k) => {
            const n = Math.max(2, Math.round((c1 - c0) / 6) + 1);
            const x = c0 + ((c1 - c0) * k) / (n - 1);
            return (
              <mesh key={k} position={[x, 4.25, z + 0.9]} rotation={[-0.75, 0, 0]} castShadow>
                <boxGeometry args={[0.1, 0.1, 2.1]} />
                <meshToonMaterial color="#59626b" gradientMap={toonGradient()} />
              </mesh>
            );
          })}
        </group>
      )}
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
          {/* 门封：门洞两侧和上方的黑色海绵垫 */}
          {[-1, 1].map((s) => (
            <mesh key={`seal${s}`} position={[s * (DOOR_W / 2 + 0.32), 1.95, 0.42]} castShadow>
              <boxGeometry args={[0.32, 3.5, 0.42]} />
              <meshToonMaterial color="#26292c" gradientMap={toonGradient()} />
            </mesh>
          ))}
          <mesh position={[0, DOOR_H + 0.85, 0.42]} castShadow>
            <boxGeometry args={[DOOR_W + 0.96, 0.42, 0.42]} />
            <meshToonMaterial color="#26292c" gradientMap={toonGradient()} />
          </mesh>
          {/* 地面导向线 */}
          {[-1.55, 1.55].map((dx) => (
            <mesh key={`g${dx}`} position={[dx, -0.03, 7.2]} receiveShadow>
              <boxGeometry args={[0.14, 0.012, 13]} />
              <meshToonMaterial color="#f0c13a" gradientMap={toonGradient()} />
            </mesh>
          ))}
          {/* 摇臂作业灯 */}
          <mesh position={[-DOOR_W / 2 - 0.85, 3.3, 0.55]} rotation={[0, 0, 0]} material={lampMetal} castShadow>
            <boxGeometry args={[0.08, 0.08, 0.9]} />
          </mesh>
          <mesh position={[-DOOR_W / 2 - 0.85, 3.25, 1.05]} material={lampGlass}>
            <boxGeometry args={[0.24, 0.18, 0.24]} />
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
