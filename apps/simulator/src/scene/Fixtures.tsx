import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useApp } from '../state/store';
import { useClock } from '../state/clock';
import { ZONE_COLOR } from './palette';
import { toonGradient } from './toon';
import { useNightGlow } from './environment';

const tmp = new THREE.Object3D();
const col = new THREE.Color();

interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

/** 一组实例化长方体 */
function Boxes({ items, transparent = false, opacity = 1, glow = false }: { items: Box[]; transparent?: boolean; opacity?: number; glow?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const mat = useNightGlow<THREE.MeshToonMaterial>(glow ? 0.3 : 0);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((b, i) => {
      tmp.position.set(b.x, b.y + b.h / 2, b.z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(b.w, b.h, b.d);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, col.set(b.color));
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh key={items.length} ref={ref} args={[undefined, undefined, items.length]} castShadow={!transparent} receiveShadow={!transparent}>
      <boxGeometry />
      {transparent ? <meshStandardMaterial color="#ffffff" transparent opacity={opacity} depthWrite={false} /> : <meshToonMaterial ref={mat} color="#ffffff" gradientMap={toonGradient()} />}
    </instancedMesh>
  );
}

/**
 * 店内陈设：收银通道（传送带、收银机、通道号灯柱）和自助收银机、通道上方的吊牌、冷冻柜玻璃门。
 */
export function Fixtures() {
  const geo = useApp((s) => s.geo);
  const floor = useApp((s) => s.floor);
  const view = useApp((s) => s.view);
  const plan = useApp((s) => s.checkoutPlan);
  // 采纳了收银通道计划（决策记录 0020）：按当前小时，开着的通道号灯是绿的、关着的是暗红的
  const hour = Math.floor(useClock(0.5) / 3600) % 24;
  const all = view === '3d' && floor === 'ALL';

  const { solid, glass } = useMemo(() => {
    const solid: Box[] = [];
    const glass: Box[] = [];
    const onFloor = (floorId: string) => all || floorId === floor;
    const manualIndex = new Map<string, number>();
    // 收银台：一楼入口旁，两层的门店二楼也有一组（决策记录 0019）
    for (const c of geo.checkouts) {
      if (!onFloor(c.floorId)) continue;
      const y = c.y;
      if (c.self) {
        solid.push({ x: c.x, y, z: c.z, w: 0.7, h: 1.1, d: 0.6, color: '#3d4a57' });
        solid.push({ x: c.x, y: y + 1.1, z: c.z - 0.15, w: 0.55, h: 0.45, d: 0.08, color: '#7fb7d8' });
      } else {
        solid.push({ x: c.x - 0.6, y, z: c.z, w: 0.8, h: 0.9, d: 3.0, color: '#d9d4ca' });
        solid.push({ x: c.x - 0.6, y: y + 0.9, z: c.z + 0.2, w: 0.55, h: 0.03, d: 2.2, color: '#2b2e31' });
        solid.push({ x: c.x - 0.6, y: y + 0.9, z: c.z - 1.1, w: 0.4, h: 0.35, d: 0.35, color: '#4b5563' });
        // 通道号灯柱
        const i = manualIndex.get(c.floorId) ?? 0;
        manualIndex.set(c.floorId, i + 1);
        const openN = plan?.find((p) => p.floorId === c.floorId)?.byHour[hour];
        const open = openN === undefined || i < openN;
        solid.push({ x: c.x - 0.95, y, z: c.z - 1.4, w: 0.08, h: 2.3, d: 0.08, color: '#6b7379' });
        solid.push({ x: c.x - 0.95, y: y + 2.3, z: c.z - 1.4, w: 0.35, h: 0.3, d: 0.12, color: open ? '#2f7d55' : '#7a2e2a' });
      }
    }
    // 通道吊牌：每条货架通道入口上方，按温区着色
    for (const l of geo.runLabels) {
      if (!onFloor(l.floorId)) continue;
      solid.push({ x: l.x, y: l.y + 1.6, z: l.z + 1.3, w: 1.5, h: 0.5, d: 0.06, color: ZONE_COLOR[l.tempZone] });
    }
    // 冷冻柜玻璃门：冷冻货架的朝通道一面
    for (const sh of geo.shelves) {
      if (sh.tempZone !== 'FROZEN' || !onFloor(sh.floorId)) continue;
      // 竖向通道的货架长边沿 Z；玻璃罩比货架略大一圈
      const vertical = Math.abs(Math.sin(sh.rotY)) > 0.5;
      glass.push({ x: sh.x, y: sh.y - sh.height / 2, z: sh.z, w: vertical ? sh.depth + 0.08 : sh.length, h: sh.height + 0.05, d: vertical ? sh.length : sh.depth + 0.08, color: '#cfeefa' });
    }
    return { solid, glass };
  }, [geo, floor, all, plan, hour]);

  return (
    <group>
      <Boxes items={solid} glow />
      <Boxes items={glass} transparent opacity={0.22} />
    </group>
  );
}
