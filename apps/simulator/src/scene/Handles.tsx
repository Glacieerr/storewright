import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { moveStaging, type StoreConfig } from '@storewright/store-config';
import { useApp } from '../state/store';
import { activeControls, handleState } from './drag';
import { customerEntrance } from './crowd';
import { ESCALATOR_RUN } from './layout';
import { t } from '../i18n';

/**
 * 编辑模式下的拖拽把手：顾客入口、交付门口、电梯 / 扶梯沿前走廊左右移动；
 * 汽车服务中心、园艺中心拖到门店另一侧即换边（另一侧已有设施时两者互换）；
 * 线上订单暂存区可以在一楼自由拖动，松开时吸附到最近的走廊或通道上。
 * 拖动时只预览，松开后作为一次可撤销的修改实时应用。
 */

interface Handle {
  id: string;
  label: string;
  color: string;
  x: number;
  z: number;
  min: number;
  max: number;
  /** 松开时写回草稿 */
  commit: (d: StoreConfig, x: number, z: number) => void;
  /** 只判断落在哪一侧（设施换边） */
  sideFlip?: boolean;
  /** 可以前后左右自由拖动（z 范围） */
  free?: { zMin: number; zMax: number };
}

function frontCorridor(d: StoreConfig): { x0: number; x1: number; y: number } | undefined {
  const c = d.layout.corridors.find((k) => k.floorId === 'F1' && k.id.endsWith('-C-FRONT'));
  if (!c) return undefined;
  return { x0: Math.min(c.start.x, c.end.x), x1: Math.max(c.start.x, c.end.x), y: c.start.y };
}

export function Handles() {
  const mode = useApp((s) => s.mode);
  const draft = useApp((s) => s.draft);
  const geo = useApp((s) => s.geo);
  const model = useApp((s) => s.model);
  const [drag, setDrag] = useState<{ id: string; x: number; z: number } | undefined>();
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const ground = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const hit = useMemo(() => new THREE.Vector3(), []);

  const handles = useMemo<Handle[]>(() => {
    if (!draft) return [];
    const f0 = geo.floors[0];
    if (!f0) return [];
    const fc = frontCorridor(draft);
    const out: Handle[] = [];
    out.push({
      id: 'entrance',
      label: '顾客入口',
      color: '#2f7d55',
      x: customerEntrance(model, geo).outside.x,
      // 放在入口雨棚外面，避免被遮住
      z: -4.6,
      min: f0.minX + 3,
      max: f0.maxX - 3,
      commit: (d, x) => {
        d.outdoor.entranceX = Math.round(x * 10) / 10;
      },
    });
    if (fc) {
      out.push({
        id: 'door',
        label: '交付门口',
        color: '#ee8a35',
        x: draft.layout.points.handoff.x,
        z: -2.4,
        min: fc.x0 + 1,
        max: fc.x1,
        commit: (d, x) => {
          const nx = Math.round(x * 10) / 10;
          const old = d.layout.points.handoff.x;
          d.layout.points.handoff.x = nx;
          // 交付门口连到前走廊的那段通道一起移动
          for (const c of d.layout.corridors) {
            if (c.floorId !== 'F1' || !c.id.endsWith('-C-HANDOFF')) continue;
            if (Math.abs(c.start.x - old) < 0.01) c.start.x = nx;
            if (Math.abs(c.end.x - old) < 0.01) c.end.x = nx;
          }
        },
      });
      for (const c of draft.layout.connectors) {
        if (Math.abs(c.a.y - fc.y) > 0.01) continue;
        const esc = c.kind === 'ESCALATOR';
        out.push({
          id: `conn-${c.id}`,
          label: esc ? `扶梯 ${c.id.replace('ESC-', '')}` : `电梯 ${c.id.replace('ELEV-', '')}`,
          color: esc ? '#5b6168' : '#7f8c96',
          x: c.a.x,
          z: fc.y - (esc ? 2.6 : 0),
          min: fc.x0 + (esc ? ESCALATOR_RUN / 2 + 1 : 0),
          max: fc.x1 - (esc ? ESCALATOR_RUN / 2 + 1 : 0),
          commit: (d, x) => {
            const k = d.layout.connectors.find((q) => q.id === c.id);
            if (!k) return;
            const nx = Math.round(x * 10) / 10;
            k.a.x = nx;
            k.b.x = nx;
          },
        });
      }
    }
    const sp = draft.layout.points.staging;
    if (sp.floorId === f0.floorId) {
      out.push({
        id: 'staging',
        label: '线上订单暂存区',
        color: '#3b6fb6',
        x: sp.x + 2,
        z: sp.y + 1,
        min: f0.minX + 1,
        max: f0.maxX - 1,
        free: { zMin: f0.minZ + 1, zMax: f0.maxZ - 1 },
        commit: (d, x, z) => {
          moveStaging(d, x - 2, z - 1);
        },
      });
    }
    const center = (f0.minX + f0.maxX) / 2;
    for (const f of [...geo.facilities, ...geo.gardens]) {
      const id = f.id;
      out.push({
        id: `fac-${id}`,
        label: '拖到另一侧换边',
        color: '#c8433a',
        x: (f.x0 + f.x1) / 2,
        z: -3,
        min: f0.minX - 60,
        max: f0.maxX + 60,
        sideFlip: true,
        commit: (d, x) => {
          const side = x < center ? 'LEFT' : 'RIGHT';
          const me = d.facilities.find((q) => q.id === id);
          if (!me || me.kind === 'PHARMACY' || me.side === side) return;
          const other = d.facilities.find((q) => q.kind !== 'PHARMACY' && q.id !== id && q.side === side);
          if (other && other.kind !== 'PHARMACY') other.side = me.side;
          me.side = side;
        },
      });
    }
    return out;
  }, [draft, geo, model]);

  // 拖动中：每帧用指针射线与地面求交，得到把手的新位置
  useFrame(({ pointer, camera, raycaster }) => {
    const d = dragRef.current;
    if (!d) return;
    const h = handles.find((k) => k.id === d.id);
    if (!h) return;
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(ground, hit)) return;
    const x = Math.min(h.max, Math.max(h.min, hit.x));
    const z = h.free ? Math.min(h.free.zMax, Math.max(h.free.zMin, hit.z)) : h.z;
    if (Math.abs(x - d.x) > 0.05 || Math.abs(z - d.z) > 0.05) setDrag({ id: d.id, x, z });
  });

  // 松开（在画面任何位置）时提交
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      const h = handles.find((k) => k.id === d.id);
      setDrag(undefined);
      handleState.busy = false;
      handleState.justDragged = true;
      window.setTimeout(() => (handleState.justDragged = false), 80);
      if (activeControls.current) activeControls.current.enabled = true;
      if (h && (Math.abs(d.x - h.x) > 0.05 || Math.abs(d.z - h.z) > 0.05)) useApp.getState().updateDraft((cfg) => h.commit(cfg, d.x, d.z));
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [handles]);

  if (mode !== 'edit' || !draft) return null;

  const begin = (h: Handle) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    handleState.busy = true;
    if (activeControls.current) activeControls.current.enabled = false;
    setDrag({ id: h.id, x: h.x, z: h.z });
  };

  return (
    <group>
      {handles.map((h) => {
        const x = drag?.id === h.id ? drag.x : h.x;
        const z = drag?.id === h.id ? drag.z : h.z;
        return (
          <group key={h.id} position={[x, 0, z]}>
            <mesh position={[0, 0.9, 0]} onPointerDown={begin(h)} onPointerOver={() => (document.body.style.cursor = h.free ? 'move' : 'ew-resize')} onPointerOut={() => (document.body.style.cursor = '')}>
              <sphereGeometry args={[1, 16, 12]} />
              <meshBasicMaterial color={h.color} toneMapped={false} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
              <ringGeometry args={[0.95, 1.25, 28]} />
              <meshBasicMaterial color={h.color} transparent opacity={0.7} side={THREE.DoubleSide} />
            </mesh>
            <Html position={[0, 2, 0]} center className="scene-label handle-label">
              {h.free ? '✥' : '↔'} {t(h.label)}
            </Html>
          </group>
        );
      })}
    </group>
  );
}
