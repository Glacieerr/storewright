import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useApp } from '../state/store';
import { editFloor, editPointer } from '../state/editOps';
import { dragState, drawState, handleState, nearestRun, previewRectOf, type PreviewRect } from './drag';
import { SCENE } from './palette';

/**
 * 编辑模式的地面交互（放在正在编辑的楼层高度上）：
 * - 选择工具：点通道中线附近选中，Shift / ⌘ 点选加入或移出多选；按住已选中的通道拖动，一起移动；
 * - 画通道工具：按下拖出一条通道（点一下则在该处放一条竖向通道并延伸到前后走廊），松开后写入草稿。
 */
export function EditPlane() {
  const mode = useApp((s) => s.mode);
  const tool = useApp((s) => s.editTool);
  // 订阅楼层，切换楼层时地面跟着换高度
  useApp((s) => s.floor);
  const geo = useApp((s) => s.geo);
  if (mode !== 'edit') return null;
  const fid = editFloor();
  const y = (geo.floorY.get(fid) ?? 0) + 0.01;
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, y, 0]}
      onPointerDown={(e) => {
        if (e.button !== 0 || handleState.busy) return;
        const st = useApp.getState();
        if (tool === 'draw') {
          e.stopPropagation();
          drawState.begin(e.point.x, e.point.z);
          return;
        }
        const id = nearestRun(e.point.x, e.point.z, fid);
        if (id && st.editSel.includes(id) && !e.shiftKey && !e.metaKey && !e.ctrlKey) dragState.begin([...st.editSel], e.point.x, e.point.z);
      }}
      onPointerMove={(e) => {
        editPointer.x = e.point.x;
        editPointer.y = e.point.z;
        editPointer.at = performance.now();
        if (drawState.active) drawState.move(e.point.x, e.point.z);
        else dragState.move(e.point.x, e.point.z);
      }}
      onPointerUp={() => {
        if (drawState.active) drawState.end();
        else dragState.end();
      }}
      onPointerLeave={() => {
        if (drawState.active) drawState.cancel();
        else dragState.end();
      }}
      onClick={(e) => {
        if (tool === 'draw' || dragState.justDragged || drawState.justDrew || handleState.justDragged || handleState.busy) return;
        const st = useApp.getState();
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        st.setEditRun(nearestRun(e.point.x, e.point.z, fid), additive);
      }}
    >
      <planeGeometry args={[2000, 2000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

const MAX_PREVIEW = 64;
const tmp = new THREE.Object3D();
const OK = new THREE.Color('#3aa76d');
const BAD = new THREE.Color('#d9534f');

/** 拖动 / 画通道的预览：吸附后的货架范围；画通道时绿色可以放下，红色接不上走廊 */
export function EditPreview() {
  const mode = useApp((s) => s.mode);
  const geo = useApp((s) => s.geo);
  const ref = useRef<THREE.InstancedMesh>(null);
  const ends = useRef<THREE.InstancedMesh>(null);
  const select = useMemo(() => new THREE.Color(SCENE.select), []);

  useFrame(() => {
    const m = ref.current;
    const e = ends.current;
    if (!m || !e) return;
    const y = (geo.floorY.get(editFloor()) ?? 0) + 0.06;
    let rects: PreviewRect[] = [];
    let color = select;
    const endPts: Array<{ x: number; z: number; ok: boolean }> = [];
    if (drawState.active && drawState.plan) {
      const plan = drawState.plan;
      const s = plan.snap;
      const run = plan.run;
      const fake = { start: s.axis === 'V' ? { x: s.c, y: s.a } : { x: s.a, y: s.c }, end: s.axis === 'V' ? { x: s.c, y: s.b } : { x: s.b, y: s.c }, sides: run?.sides ?? 2 };
      rects = [previewRectOf(fake)];
      color = run ? OK : BAD;
      endPts.push({ x: fake.start.x, z: fake.start.y, ok: s.connected[0] }, { x: fake.end.x, z: fake.end.y, ok: s.connected[1] });
    } else if (dragState.preview.length) rects = dragState.preview;
    const n = Math.min(MAX_PREVIEW, rects.length);
    for (let i = 0; i < n; i++) {
      const r = rects[i] as PreviewRect;
      tmp.position.set((r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2);
      tmp.scale.set(Math.max(0.2, r.x1 - r.x0), 0.1, Math.max(0.2, r.z1 - r.z0));
      tmp.rotation.set(0, 0, 0);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, color);
    }
    m.count = n;
    m.visible = n > 0;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    endPts.forEach((p, i) => {
      tmp.position.set(p.x, y + 0.4, p.z);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      e.setMatrixAt(i, tmp.matrix);
      e.setColorAt(i, p.ok ? OK : BAD);
    });
    e.count = endPts.length;
    e.visible = endPts.length > 0;
    e.instanceMatrix.needsUpdate = true;
    if (e.instanceColor) e.instanceColor.needsUpdate = true;
  });

  if (mode !== 'edit') return null;
  return (
    <group>
      <instancedMesh ref={ref} args={[undefined, undefined, MAX_PREVIEW]} frustumCulled={false} renderOrder={5}>
        <boxGeometry />
        <meshBasicMaterial transparent opacity={0.4} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={ends} args={[undefined, undefined, 2]} frustumCulled={false} renderOrder={6}>
        <sphereGeometry args={[0.45, 14, 10]} />
        <meshBasicMaterial />
      </instancedMesh>
    </group>
  );
}
