import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { currentRole, handoffBoard, type BoardColor } from '@storewright/ops';
import { useApp } from '../state/store';
import { isReplaying, liveClient, viewNow, viewState } from '../live/link';
import { ROLE_COLOR } from '../live/roles';
import { t } from '../i18n';

/**
 * 门店实况叠加层：员工显示在最近一次扫描的位置（货位或暂存格位，不做室内定位），
 * 到店顾客显示在签到填写的取货车位上，颜色与交付看板一致。回放时显示回放到的那一刻（决策记录 0016）。
 */
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
  const s = viewState() ?? c.state;
  const st = c.statics;
  const sNow = isReplaying() ? viewNow() : now + c.offset;

  const people: Array<{ id: string; name: string; role: string; x: number; y: number; z: number }> = [];
  for (const [id, a] of Object.entries(s.activity)) {
    if (!a.lastScanAt || sNow - a.lastScanAt > STALE_MS) continue;
    // 自动运营的虚拟员工（V-P1 拣货、V-S1 暂存、V-H1 交付）不在员工名单里
    const who = st.roster.find((r) => r.id === id) ?? virtualWorker(id);
    if (!who) continue;
    let p: { x: number; y: number; z: number } | undefined;
    if (a.lastLocationId) {
      const loc = model.locations.get(a.lastLocationId);
      if (loc) p = { x: loc.x, y: geo.floorY.get(loc.floorId) ?? 0, z: loc.y };
    } else if (a.lastSlotCode) {
      const slot = geo.slots.get(a.lastSlotCode);
      if (slot) p = { x: slot.x, y: slot.y, z: slot.z + 0.9 };
    }
    // 颜色按此刻的岗位（被临时调动的人显示新岗位的颜色）
    if (p) people.push({ id, name: who.name, role: currentRole(st, s, id, sNow) ?? who.role, ...p });
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
        // 车位编号：门店配置了明确车位时按编号找，否则按序号（1 = 离交付门最近）
        const bayNo = Number(r.bay);
        const spot = bays.find((b) => b.id !== undefined && b.id === r.bay) ?? (Number.isInteger(bayNo) && bayNo >= 1 ? bays[bayNo - 1] : undefined);
        const x = spot?.x ?? geo.lot.pickupSign.x + 3 + i * 3;
        const z = spot?.z ?? geo.lot.pickupSign.z - 4;
        const color = BOARD_COLOR[r.color];
        return (
          <group key={r.key} position={[x, 0.05, z]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[1.5, 1.9, 40]} />
              <meshBasicMaterial color={color} transparent opacity={0.9} side={THREE.DoubleSide} depthWrite={false} />
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

function virtualWorker(id: string): { id: string; name: string; role: string } | undefined {
  const role = id.startsWith('V-') ? ({ P: 'PICK', S: 'STAGE', H: 'HANDOFF' } as Record<string, string>)[id.charAt(2)] : undefined;
  return role ? { id, name: id, role } : undefined;
}
