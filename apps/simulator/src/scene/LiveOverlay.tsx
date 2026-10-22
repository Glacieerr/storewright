import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { handoffBoard, type BoardColor } from '@storewright/ops';
import { useApp } from '../state/store';
import { liveClient } from '../live/link';
import { t } from '../i18n';

/**
 * 门店实况叠加层：员工显示在最近一次扫描的位置（货位或暂存格位，不做室内定位），
 * 到店顾客显示在签到填写的取货车位上，颜色与交付看板一致。
 */
const ROLE_COLOR: Record<string, string> = { PICK: '#2f9e62', STAGE: '#8a5cd0', HANDOFF: '#e8812f', LEAD: '#2f7fd0' };
const BOARD_COLOR: Record<BoardColor, string> = { GREY: '#8a96a3', YELLOW: '#e0b020', BLUE: '#2f7fd0', RED: '#d64545' };
/** 超过这个时间没有扫描的员工不再显示 */
const STALE_MS = 30 * 60_000;

export function LiveOverlay() {
  const status = useApp((s) => s.live.status);
  useApp((s) => s.liveVersion);
  const model = useApp((s) => s.simModel);
  const geo = useApp((s) => s.simGeo);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status === 'off') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status]);
  const c = liveClient();
  if (status === 'off' || !c?.statics) return null;
  const s = c.state;
  const st = c.statics;
  const sNow = now + c.offset;

  const people: Array<{ id: string; name: string; role: string; x: number; y: number; z: number }> = [];
  for (const [id, a] of Object.entries(s.activity)) {
    if (!a.lastScanAt || sNow - a.lastScanAt > STALE_MS) continue;
    const who = st.roster.find((r) => r.id === id);
    if (!who) continue;
    let p: { x: number; y: number; z: number } | undefined;
    if (a.lastLocationId) {
      const loc = model.locations.get(a.lastLocationId);
      if (loc) p = { x: loc.x, y: geo.floorY.get(loc.floorId) ?? 0, z: loc.y };
    } else if (a.lastSlotCode) {
      const slot = geo.slots.get(a.lastSlotCode);
      if (slot) p = { x: slot.x, y: slot.y, z: slot.z + 0.9 };
    }
    if (p) people.push({ id, name: who.name, role: who.role, ...p });
  }

  const bays = geo.lot.spots.filter((sp) => sp.kind === 'pickup');
  const arrivals = handoffBoard(s, st, sNow).filter((r) => r.arrivedAt !== undefined);

  return (
    <group>
      {people.map((p) => (
        <group key={p.id} position={[p.x, p.y, p.z]}>
          <mesh position={[0, 1.1, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 2.2, 8]} />
            <meshBasicMaterial color={ROLE_COLOR[p.role] ?? '#444'} />
          </mesh>
          <mesh position={[0, 2.35, 0]}>
            <sphereGeometry args={[0.28, 16, 12]} />
            <meshBasicMaterial color={ROLE_COLOR[p.role] ?? '#444'} />
          </mesh>
          <Html position={[0, 2.9, 0]} center className="scene-label live-label" zIndexRange={[20, 0]}>
            <i style={{ background: ROLE_COLOR[p.role] }} />
            {p.name}
          </Html>
        </group>
      ))}
      {arrivals.map((r, i) => {
        const bayNo = Number(r.bay);
        const spot = Number.isInteger(bayNo) && bayNo >= 1 ? bays[bayNo - 1] : undefined;
        const x = spot?.x ?? geo.lot.pickupSign.x + 3 + i * 3;
        const z = spot?.z ?? geo.lot.pickupSign.z - 4;
        const color = BOARD_COLOR[r.color];
        return (
          <group key={r.key} position={[x, 0.05, z]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[1.5, 1.9, 40]} />
              <meshBasicMaterial color={color} transparent opacity={0.9} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <mesh position={[0, 0.7, 0]}>
              <boxGeometry args={[1.8, 1.2, 4.2]} />
              <meshStandardMaterial color={color} transparent opacity={0.55} />
            </mesh>
            <Html position={[0, 2.4, 0]} center className="scene-label live-label car" zIndexRange={[20, 0]}>
              {r.kind === 'TRIP' ? t('行程 {0}', r.title) : (r.shortCode ?? r.title)} · {Math.floor(r.waitSec / 60)}:{String(r.waitSec % 60).padStart(2, '0')}
            </Html>
          </group>
        );
      })}
    </group>
  );
}
