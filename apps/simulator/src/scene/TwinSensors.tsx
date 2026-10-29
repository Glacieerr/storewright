import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { activeAlerts, type StoreStatic } from '@storewright/ops';
import { slotsOf, type SensorDef } from '@storewright/twin';
import { useApp } from '../state/store';
import { liveClient, viewState } from '../live/link';
import { sensorReading, twinView } from '../live/twin';
import { sensorName, sensorValueText, STATUS_COLOR } from '../ui/twinText';
import type { StoreGeometry } from './layout';
import type { StoreModel } from '@storewright/store-config';
import { customerEntrance } from './crowd';

/**
 * 数字孪生的设备层（决策记录 0016）：温度牌、卸货门状态、入口客流；有告警的设备脚下一圈红环，所在的区域闪红。
 * 位置：冷库、保温区按区域中心；暂存柜按它管着的格位的平均位置；卸货门、入口按场景的几何。回放时显示那一刻的读数。
 */
interface Placed {
  def: SensorDef;
  x: number;
  y: number;
  z: number;
  /** 告警时闪红的范围 */
  box?: { x0: number; x1: number; z0: number; z1: number };
}

export function placeSensors(defs: readonly SensorDef[], st: StoreStatic, geo: StoreGeometry, model: StoreModel): Placed[] {
  const out: Placed[] = [];
  const f0 = geo.floors[0];
  for (const d of defs) {
    if (d.anchor.type === 'AREA') {
      const slots = slotsOf(d, st)
        .map((c) => geo.slots.get(c))
        .filter((p): p is NonNullable<typeof p> => !!p);
      if (slots.length && d.anchor.areaKind !== 'COOLER' && d.anchor.areaKind !== 'FREEZER') {
        const xs = slots.map((p) => p.x);
        const zs = slots.map((p) => p.z);
        const x0 = Math.min(...xs) - 0.7;
        const x1 = Math.max(...xs) + 0.7;
        const z0 = Math.min(...zs) - 0.7;
        const z1 = Math.max(...zs) + 0.7;
        const y = Math.min(...slots.map((p) => p.y));
        out.push({ def: d, x: (x0 + x1) / 2, y: Math.max(0, y - 0.2), z: (z0 + z1) / 2, box: { x0, x1, z0, z1 } });
        continue;
      }
      const areaId = d.anchor.areaId;
      const a = geo.areas.find((x) => x.id === areaId);
      if (!a) continue;
      out.push({ def: d, x: (a.x0 + a.x1) / 2, y: geo.floorY.get(a.floorId) ?? 0, z: (a.z0 + a.z1) / 2, box: { x0: a.x0, x1: a.x1, z0: a.z0, z1: a.z1 } });
    } else if (d.anchor.type === 'DOCK') {
      const dock = geo.docks[d.anchor.index];
      if (dock) out.push({ def: d, x: dock.x, y: f0?.y ?? 0, z: dock.z - 1.2 });
    } else if (f0) {
      const e = customerEntrance(model, geo).outside;
      out.push({ def: d, x: e.x + 2.5, y: f0.y, z: e.z + 1.5 });
    }
  }
  return out;
}

export function TwinSensors() {
  const liveOnly = useApp((s) => s.liveView && s.live.status !== 'off');
  useApp((s) => s.twinVersion);
  useApp((s) => s.liveVersion);
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  if (!liveOnly) return null;
  const c = liveClient();
  const tv = twinView();
  if (!c?.statics || !tv.defs.length) return null;
  const s = viewState();
  const alarmed = new Set((s ? activeAlerts(s) : []).map((a) => a.sensorId));
  return (
    <group>
      {placeSensors(tv.defs, c.statics, geo, model).map((p) => (
        <SensorMarker key={p.def.id} p={p} alarm={alarmed.has(p.def.id)} />
      ))}
    </group>
  );
}

function SensorMarker({ p, alarm }: { p: Placed; alarm: boolean }) {
  const r = sensorReading(p.def);
  const status = r?.s ?? 'NO_DATA';
  const color = STATUS_COLOR[status];
  const ring = useRef<THREE.Mesh>(null);
  const zone = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!alarm) return;
    const k = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5);
    if (ring.current) {
      ring.current.scale.setScalar(1 + k * 0.5);
      (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.8 - k * 0.5;
    }
    if (zone.current) (zone.current.material as THREE.MeshBasicMaterial).opacity = 0.12 + k * 0.18;
  });
  const b = p.box;
  return (
    <group>
      <group position={[p.x, p.y, p.z]}>
        <mesh position={[0, 1.2, 0]}>
          <cylinderGeometry args={[0.04, 0.04, 2.4, 6]} />
          <meshBasicMaterial color="#5b6670" />
        </mesh>
        <mesh position={[0, 2.45, 0]}>
          <sphereGeometry args={[0.2, 16, 12]} />
          <meshBasicMaterial color={color} />
        </mesh>
        {alarm && (
          <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
            <ringGeometry args={[1.2, 1.6, 48]} />
            <meshBasicMaterial color="#d64545" transparent opacity={0.6} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        )}
        <Html position={[0, 3, 0]} center className={`scene-label twin-label kind-${p.def.kind} s-${status.toLowerCase()}`} zIndexRange={[25, 0]}>
          <i style={{ background: color }} />
          {sensorName(p.def)} <b>{r ? sensorValueText(p.def, r.v) : '—'}</b>
        </Html>
      </group>
      {alarm && b && (
        <mesh ref={zone} position={[(b.x0 + b.x1) / 2, p.y + 1.3, (b.z0 + b.z1) / 2]}>
          <boxGeometry args={[Math.max(0.5, b.x1 - b.x0), 2.6, Math.max(0.5, b.z1 - b.z0)]} />
          <meshBasicMaterial color="#d64545" transparent opacity={0.2} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
