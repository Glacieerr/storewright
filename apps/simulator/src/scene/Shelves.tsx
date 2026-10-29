import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useApp } from '../state/store';
import { deliBays } from './layout';
import { SCENE, ZONE_COLOR } from './palette';
import { heatColor } from './toon';
import { env } from './environment';
import { makeShelfMaterial } from './interior/shelfMaterial';
import { armMenu } from './contextTarget';
import { clock } from '../state/clock';
import { liveClient, viewState } from '../live/link';
import { bayAt, liveBays, stockColor, type BayStock } from './stock';

const withItems = (b: BayStock | undefined, items: number | undefined): BayStock | undefined => (b && items ? { ...b, items } : b);

const tmp = new THREE.Object3D();
const color = new THREE.Color();

/** 货架：一个 InstancedMesh 画完所有货架段 */
export function Shelves() {
  const geo = useApp((s) => s.geo);
  const floor = useApp((s) => s.floor);
  const view = useApp((s) => s.view);
  const overlay = useApp((s) => s.overlay);
  const timeline = useApp((s) => s.timeline);
  const selection = useApp((s) => s.selection);
  const mode = useApp((s) => s.mode);
  const editSel = useApp((s) => s.editSel);
  const ref = useRef<THREE.InstancedMesh>(null);

  const showAll = view === '3d' && floor === 'ALL';
  // 熟食服务柜台那几段由柜台代替（见 StoreDetails）
  const config = useApp((s) => s.model.config);
  const deli = useMemo(() => deliBays(config), [config]);
  const shelves = useMemo(() => geo.shelves.filter((s) => (showAll || s.floorId === floor) && !(deli && s.runId === deli.runId && deli.bays.has(s.bay))), [geo, floor, showAll, deli]);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    shelves.forEach((s, i) => {
      tmp.position.set(s.x, s.y, s.z);
      tmp.rotation.set(0, s.rotY, 0);
      tmp.scale.set(s.length, s.height, s.depth);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    });
    mesh.count = shelves.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [shelves]);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const heat = timeline?.pickHeat ?? {};
    let max = 1;
    for (const v of Object.values(heat)) max = Math.max(max, v);
    const highlight = new Set(mode === 'edit' ? editSel : selection?.type === 'run' ? [selection.id] : []);
    shelves.forEach((s, i) => {
      if (highlight.has(s.runId)) color.set(SCENE.select);
      else if (overlay === 'heat') heatColor(Math.sqrt((heat[`${s.runId}|${s.bay}`] ?? 0) / max), color);
      else if (overlay === 'stock') color.set(stockColor(withItems(bayAt(timeline?.shelf?.bays[`${s.runId}|${s.bay}`], clock.time), timeline?.shelf?.bayItems[`${s.runId}|${s.bay}`])));
      else if (overlay === 'none') color.set('#d8d2c6');
      else color.set(ZONE_COLOR[s.tempZone]);
      mesh.setColorAt(i, color);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [shelves, overlay, timeline, selection, mode, editSel]);

  // 货架存量叠加层：随播放时刻（或门店实况的估算）更新颜色，每 0.4 秒一次
  const lastStock = useRef(-1);
  const liveVersion = useApp((s) => s.liveVersion);
  useFrame(() => {
    const mesh = ref.current;
    if (!mesh || overlay !== 'stock') return;
    const app = useApp.getState();
    const live = app.liveView && app.live.status !== 'off' ? liveClient() : undefined;
    const key = live ? liveVersion : Math.floor(clock.time / 20);
    if (key === lastStock.current) return;
    lastStock.current = key;
    const highlight = new Set(mode === 'edit' ? editSel : selection?.type === 'run' ? [selection.id] : []);
    const lb = live?.statics ? liveBays(viewState() ?? live.state, live.statics) : undefined;
    shelves.forEach((s, i) => {
      const k = `${s.runId}|${s.bay}`;
      if (highlight.has(s.runId)) color.set(SCENE.select);
      else color.set(stockColor(lb ? lb.get(k) : withItems(bayAt(timeline?.shelf?.bays[k], clock.time), timeline?.shelf?.bayItems[k])));
      mesh.setColorAt(i, color);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  useEffect(() => {
    lastStock.current = -1;
  }, [overlay, shelves, timeline, selection]);

  // 编辑模式下由地面统一处理点选与拖拽（点通道中线附近即可，不必点中细长的货架）
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (useApp.getState().mode === 'edit') return;
    e.stopPropagation();
    const s = e.instanceId === undefined ? undefined : shelves[e.instanceId];
    if (s) useApp.getState().select({ type: 'run', id: s.runId });
  };

  const onContext = (e: ThreeEvent<MouseEvent>) => {
    if (useApp.getState().mode === 'edit') return;
    const s = e.instanceId === undefined ? undefined : shelves[e.instanceId];
    if (s) armMenu({ type: 'run', id: s.runId }, e);
  };

  // 货架外观：朝通道的面画出层板和商品；看热度、存量时商品被数据颜色染色
  const material = useMemo(() => makeShelfMaterial(), []);
  useEffect(() => {
    (material.userData.tint as { value: number }).value = overlay === 'heat' || overlay === 'stock' || overlay === 'areas' ? 0.62 : overlay === 'none' ? 0.04 : 0.12;
  }, [material, overlay]);
  const warm = useMemo(() => new THREE.Color('#fff1d6'), []);
  useFrame(() => {
    material.emissive.copy(warm).multiplyScalar(env.night * 0.32);
  });
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, material, Math.max(1, geo.shelves.length)]}
      castShadow
      receiveShadow
      onClick={onClick}
      onContextMenu={onContext}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = '')}
    >
      <boxGeometry args={[1, 1, 1]} />
    </instancedMesh>
  );
}
