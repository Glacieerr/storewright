import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { areaUsage } from '@storewright/ops';
import { backroomLayout, type ResolvedArea } from '@storewright/store-config';
import { useApp } from '../state/store';
import { useClock } from '../state/clock';
import { liveClient } from '../live/link';
import { t } from '../i18n';
import { toonGradient } from './toon';
import { AREA_NAME } from '../ui/areaNames';

/**
 * 区域（决策记录 0013）：收货区、后仓、暂存区的每一块地面按类型着色、描边并标注名称；
 * 冷藏库和冷冻库画成步入式冷库（四面保温墙，正面留门）。
 * 叠加层选「区域占用」时按占用着色：门店实况用作业记录算出的占用，仿真用暂存占用和后仓托盘数。
 */

export { AREA_NAME };

const AREA_COLOR: Record<string, string> = {
  UNLOAD: '#f1d878',
  RECEIVING_HOLD: '#eee2b4',
  QA: '#f0b9a4',
  RTV: '#e4b6d6',
  RETURNS: '#cbbbe9',
  PALLETS: '#cfb68e',
  BALER: '#bcc6a8',
  RACKS: '#d9e3ee',
  COOLER: '#cde7f6',
  FREEZER: '#d4daf6',
  OVERSTOCK: '#dde5ee',
  BULK: '#e4d7c3',
  CAGE: '#d2d4d3',
  CHEM: '#f5d6a2',
  CHARGING: '#c9e6ca',
  STAGING: '#dce7f1',
  STAGING_DELIVERY: '#d4ecdd',
  STAGING_OVERSIZED: '#f1df99',
  HOT_HOLD: '#f5c8a6',
  PARCEL: '#e2d3bf',
  RECOVERY: '#f0caca',
};

const EDGE = '#5f6b72';
const WALL_COLOR: Record<string, string> = { COOLER: '#eef6fb', FREEZER: '#e7ecfb' };

export function areaName(a: Pick<ResolvedArea, 'kind' | 'label'>): string {
  return a.label || t(AREA_NAME[a.kind] ?? a.kind);
}

/** 占用率 → 颜色（绿 → 黄 → 红） */
function rateColor(rate: number, alertAt: number): string {
  if (rate >= alertAt) return '#ef9a8f';
  if (rate >= alertAt * 0.7) return '#f4d77e';
  return '#a9dcbc';
}

interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

const tmp = new THREE.Object3D();
const col = new THREE.Color();

function Boxes({ items, opacity = 1 }: { items: Box[]; opacity?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((b, i) => {
      tmp.position.set(b.x, b.y + b.h / 2, b.z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(Math.max(0.01, b.w), Math.max(0.005, b.h), Math.max(0.01, b.d));
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, col.set(b.color));
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [items]);
  return (
    <instancedMesh key={items.length} ref={ref} args={[undefined, undefined, Math.max(1, items.length)]} frustumCulled={false} receiveShadow>
      <boxGeometry />
      <meshToonMaterial gradientMap={toonGradient()} transparent={opacity < 1} opacity={opacity} />
    </instancedMesh>
  );
}

export function Areas() {
  const mode = useApp((s) => s.mode);
  const simGeo = useApp((s) => s.simGeo);
  const draftGeo = useApp((s) => s.geo);
  const simModel = useApp((s) => s.simModel);
  const overlay = useApp((s) => s.overlay);
  const floor = useApp((s) => s.floor);
  const buildingView = useApp((s) => s.buildingView);
  const timeline = useApp((s) => s.timeline);
  const liveStatus = useApp((s) => s.live.status);
  useApp((s) => s.liveVersion);
  const now = useClock(overlay === 'areas' ? 2 : 0.2);
  // 编辑时显示草稿里的区域
  const geo = mode === 'edit' ? draftGeo : simGeo;
  const floorY = geo.floorY;
  const visibleFloor = (id: string) => floor === 'ALL' || floor === id;
  const areas = geo.areas.filter((a) => visibleFloor(a.floorId));

  // 占用：门店实况用作业记录，仿真用暂存占用和后仓托盘数
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    if (overlay !== 'areas') return m;
    const c = liveClient();
    if (liveStatus === 'live' && c?.statics?.areas) {
      for (const u of areaUsage(c.state, c.statics)) if (u.tracked) m.set(u.area.id, u.rate);
      return m;
    }
    const s = timeline?.series;
    if (s) {
      const i = Math.max(0, Math.min(s.rackUsed.length - 1, Math.floor((now - s.t0) / s.step)));
      const occ = (['AMBIENT', 'CHILLED', 'FROZEN'] as const).map((z) => s.stagingOcc[z][i] ?? 0);
      const staging = occ.reduce((a, b) => a + b, 0) / occ.length;
      const cap = backroomLayout(simModel.config).capacity || 1;
      for (const a of geo.areas) {
        if (a.group === 'STAGING' && (a.kind === 'STAGING' || a.kind === 'STAGING_DELIVERY')) m.set(a.id, staging);
        if (a.kind === 'RACKS') m.set(a.id, Math.min(1, (s.rackUsed[i] ?? 0) / cap));
      }
    }
    return m;
  }, [overlay, liveStatus, timeline, now, geo.areas, simModel]);

  const { tiles, edges, walls } = useMemo(() => {
    const tiles: Box[] = [];
    const edges: Box[] = [];
    const walls: Box[] = [];
    for (const a of areas) {
      const y = floorY.get(a.floorId) ?? 0;
      const w = a.x1 - a.x0;
      const d = a.z1 - a.z0;
      const cx = (a.x0 + a.x1) / 2;
      const cz = (a.z0 + a.z1) / 2;
      const rate = usage.get(a.id);
      const color = overlay === 'areas' ? (rate === undefined ? '#e3e6e5' : rateColor(rate, a.alertAt)) : (AREA_COLOR[a.kind] ?? '#e0e4e8');
      tiles.push({ x: cx, y: y + 0.004, z: cz, w, h: 0.012, d, color });
      // 描边（地面标线）
      const e = 0.09;
      edges.push({ x: cx, y: y + 0.006, z: a.z0, w, h: 0.012, d: e, color: EDGE });
      edges.push({ x: cx, y: y + 0.006, z: a.z1, w, h: 0.012, d: e, color: EDGE });
      edges.push({ x: a.x0, y: y + 0.006, z: cz, w: e, h: 0.012, d, color: EDGE });
      edges.push({ x: a.x1, y: y + 0.006, z: cz, w: e, h: 0.012, d, color: EDGE });
      // 步入式冷库：保温墙 2.6 米高，正面（靠卖场一侧）中间留 1.6 米的门
      const wc = WALL_COLOR[a.kind];
      if (wc) {
        const h = 2.6;
        const tW = 0.18;
        walls.push({ x: cx, y, z: a.z1, w, h, d: tW, color: wc });
        walls.push({ x: a.x0, y, z: cz, w: tW, h, d, color: wc });
        walls.push({ x: a.x1, y, z: cz, w: tW, h, d, color: wc });
        const door = Math.min(1.6, w * 0.4);
        const seg = (w - door) / 2;
        walls.push({ x: a.x0 + seg / 2, y, z: a.z0, w: seg, h, d: tW, color: wc });
        walls.push({ x: a.x1 - seg / 2, y, z: a.z0, w: seg, h, d: tW, color: wc });
        // 门头上的蓝色 / 紫色色条
        walls.push({ x: cx, y: y + h - 0.3, z: a.z0, w: door, h: 0.3, d: tW, color: a.kind === 'COOLER' ? '#5aa9d6' : '#6f76d8' });
      }
    }
    return { tiles, edges, walls };
  }, [areas, floorY, usage, overlay]);

  const showLabels = buildingView !== 'exterior' && (mode === 'sim' || mode === 'edit');
  return (
    <group>
      <Boxes items={tiles} opacity={overlay === 'areas' ? 0.95 : 0.85} />
      <Boxes items={edges} />
      {walls.length > 0 && <Boxes items={walls} opacity={0.92} />}
      {showLabels &&
        areas
          // 小区域（收货区里的待检、退供应商……）只在编辑或看区域占用时标注，避免远看时文字挤在一起
          .filter((a) => mode === 'edit' || overlay === 'areas' || (a.x1 - a.x0) * (a.z1 - a.z0) >= 24)
          .map((a) => {
          const y = (floorY.get(a.floorId) ?? 0) + (WALL_COLOR[a.kind] ? 3.1 : 1.4);
          const rate = usage.get(a.id);
          // 手机屏幕上（样式里 600 像素以下）只标注较大的区域，小区域和容量说明在编辑或看区域占用时再显示
          const minor = mode !== 'edit' && overlay !== 'areas' && (a.x1 - a.x0) * (a.z1 - a.z0) < 60;
          return (
            <Html key={a.id} position={[(a.x0 + a.x1) / 2, y, (a.z0 + a.z1) / 2]} center className={`scene-label area-label kind-${a.kind}${rate !== undefined && rate >= a.alertAt ? ' alert' : ''}${minor ? ' minor' : ''}`}>
              {areaName(a)}
              {overlay === 'areas' && rate !== undefined ? ` · ${Math.round(rate * 100)}%` : a.kind === 'RACKS' ? <span className="label-extra"> · {t('{0} 个托盘位', a.capacity)}</span> : ''}
            </Html>
          );
        })}
    </group>
  );
}
