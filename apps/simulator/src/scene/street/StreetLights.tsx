import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Pt } from '../lot';
import { env } from '../environment';
import { boxGeo, mergeAll } from '../terrain/geom';
import { lampGlass, lampMetal } from '../style/lights';
import { radialTexture } from './radial';

/**
 * 路灯：
 * - 路边：锥形灯杆、弯臂伸向路面、扁平灯头，灯罩朝下（夜里亮起并在路面投下暖色光斑）；
 * - 停车场绿岛：双臂高杆灯，两边各一个灯头。
 * 都是实例化绘制：同一种灯一份几何体，按位置和朝向摆放。
 */

const POLE_H = 7.2;
const REACH = 1.7;

/** 单臂路灯（局部坐标：灯杆在原点，灯臂伸向 +Z） */
function armLamp(arms: number[]): { metal: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
  const metal: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  metal.push(boxGeo(-0.2, 0.2, 0, 0.55, -0.2, 0.2));
  const pole = new THREE.CylinderGeometry(0.07, 0.12, POLE_H, 10);
  pole.translate(0, POLE_H / 2, 0);
  metal.push(pole);
  for (const a of arms) {
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, POLE_H - 0.6, 0), new THREE.Vector3(0, POLE_H + 0.05, REACH * 0.25), new THREE.Vector3(0, POLE_H + 0.22, REACH * 0.7), new THREE.Vector3(0, POLE_H + 0.2, REACH)]);
    const tube = new THREE.TubeGeometry(curve, 12, 0.045, 6, false);
    tube.rotateY(a);
    metal.push(tube);
    const head = boxGeo(-0.24, 0.24, POLE_H + 0.08, POLE_H + 0.26, REACH - 0.1, REACH + 0.75);
    head.rotateY(a);
    metal.push(head);
    const lens = boxGeo(-0.19, 0.19, POLE_H + 0.04, POLE_H + 0.09, REACH, REACH + 0.65);
    lens.rotateY(a);
    glass.push(lens);
  }
  return { metal: mergeAll(metal), glass: mergeAll(glass) };
}

interface Placed {
  x: number;
  z: number;
  rotY: number;
}

function LampSet({ items, arms }: { items: Placed[]; arms: number[] }) {
  const geo = useMemo(() => armLamp(arms), [arms]);
  const metal = useRef<THREE.InstancedMesh>(null);
  const glass = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    for (const m of [metal.current, glass.current]) {
      if (!m) continue;
      items.forEach((p, i) => {
        o.position.set(p.x, 0, p.z);
        o.rotation.set(0, p.rotY, 0);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      });
      m.count = items.length;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [items]);
  if (!items.length) return null;
  return (
    <group>
      <instancedMesh key={`m${items.length}`} ref={metal} args={[geo.metal, lampMetal, items.length]} castShadow />
      <instancedMesh key={`g${items.length}`} ref={glass} args={[geo.glass, lampGlass, items.length]} />
    </group>
  );
}

/** 路灯下的光斑：夜间逐渐亮起（加法混合，不需要实时光源） */
function LampPools({ spots }: { spots: Pt[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const tex = useMemo(() => radialTexture('#fff0c8'), []);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new THREE.Object3D();
    spots.forEach((p, i) => {
      o.position.set(p.x, 0.02, p.z);
      o.rotation.set(-Math.PI / 2, 0, 0);
      o.scale.set(13, 13, 1);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [spots]);
  useFrame(() => {
    const m = mat.current;
    const mesh = ref.current;
    if (!m || !mesh) return;
    m.opacity = env.night * 0.6;
    mesh.visible = env.night > 0.02;
  });
  if (!spots.length) return null;
  return (
    <instancedMesh key={spots.length} ref={ref} args={[undefined, undefined, spots.length]} renderOrder={2}>
      <planeGeometry />
      <meshBasicMaterial ref={mat} map={tex} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </instancedMesh>
  );
}

/** lot 为停车场沥青的边界（靠路一侧的 z）：在停车场里的是绿岛双臂灯，其余是路边单臂灯（灯臂伸向路面 −Z） */
export function StreetLights({ lamps, lotEdgeZ }: { lamps: Pt[]; lotEdgeZ: number }) {
  const { road, lot, pools } = useMemo(() => {
    const road: Placed[] = [];
    const lot: Placed[] = [];
    const pools: Pt[] = [];
    for (const p of lamps) {
      if (p.z > lotEdgeZ) {
        lot.push({ x: p.x, z: p.z, rotY: Math.PI / 2 });
        pools.push({ x: p.x - REACH - 0.3, z: p.z }, { x: p.x + REACH + 0.3, z: p.z });
      } else {
        road.push({ x: p.x, z: p.z, rotY: Math.PI });
        pools.push({ x: p.x, z: p.z - REACH - 0.35 });
      }
    }
    return { road, lot, pools };
  }, [lamps, lotEdgeZ]);
  const single = useMemo(() => [0], []);
  const double = useMemo(() => [0, Math.PI], []);
  return (
    <group>
      <LampSet items={road} arms={single} />
      <LampSet items={lot} arms={double} />
      <LampPools spots={pools} />
    </group>
  );
}
