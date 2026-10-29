import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import type { Rect } from '../site';
import { toonGradient } from '../toon';

const tmp = new THREE.Object3D();
const col = new THREE.Color();

export interface Slab extends Rect {
  y?: number;
  h?: number;
  rotY?: number;
  color?: string;
}

/** 一组同材质的长方体（实例化绘制）：地面、路面、人行道、标线、建筑都用它 */
export function Slabs({
  items,
  y = 0,
  h = 0.02,
  color,
  basic = false,
  colored = false,
  cast = false,
  receive = false,
  matRef,
  material,
}: {
  material?: THREE.Material;
  items: Slab[];
  y?: number;
  h?: number;
  color: string;
  basic?: boolean;
  colored?: boolean;
  cast?: boolean;
  receive?: boolean;
  matRef?: React.Ref<THREE.MeshBasicMaterial & THREE.MeshToonMaterial>;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((r, i) => {
      const hh = r.h ?? h;
      tmp.position.set(r.x, (r.y ?? y) + hh / 2, r.z);
      tmp.rotation.set(0, r.rotY ?? 0, 0);
      tmp.scale.set(r.w, hh, r.d);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      if (colored) m.setColorAt(i, col.set(r.color ?? color));
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items, y, h, color, colored]);
  if (!items.length) return null;
  if (material)
    return (
      <instancedMesh key={items.length} ref={ref} args={[undefined, material, items.length]} castShadow={cast} receiveShadow={receive}>
        <boxGeometry />
      </instancedMesh>
    );
  return (
    <instancedMesh key={items.length} ref={ref} args={[undefined, undefined, items.length]} castShadow={cast} receiveShadow={receive}>
      <boxGeometry />
      {basic ? (
        <meshBasicMaterial ref={matRef as React.Ref<THREE.MeshBasicMaterial>} color={colored ? '#ffffff' : color} />
      ) : (
        <meshToonMaterial ref={matRef as React.Ref<THREE.MeshToonMaterial>} color={colored ? '#ffffff' : color} gradientMap={toonGradient()} />
      )}
    </instancedMesh>
  );
}

