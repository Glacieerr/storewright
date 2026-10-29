import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useApp } from '../../state/store';
import { signalLight, type SiteLayout } from '../site';
import { trafficFor } from '../traffic';
import { env } from '../environment';
import { boxGeo, mergeAll } from '../terrain/geom';
import { toonGradient } from '../toon';

/**
 * 信号灯：路口转角立灯杆，横臂伸到车道上方，灯箱（带背板和遮光檐）挂在横臂末端面向来车；
 * 左转箭头灯挂在同一根横臂上靠里的位置。灯色跟随车流时钟，夜里亮灯更亮（高画质下有光晕）。
 */

const LIGHT_ON = { R: new THREE.Color('#ff3b30'), Y: new THREE.Color('#ffc400'), G: new THREE.Color('#2fd06a') } as const;
const LIGHT_OFF = new THREE.Color('#2a2e31');
const HEAD_Y = 5.15;
const POLE_H = 5.75;

/** 灯箱（局部坐标：灯面朝 +Z，原点在灯箱中心） */
function headGeometry(): THREE.BufferGeometry {
  const parts = [boxGeo(-0.19, 0.19, -0.55, 0.55, -0.15, 0.15), boxGeo(-0.33, 0.33, -0.68, 0.68, -0.19, -0.16)];
  for (const y of [0.34, 0, -0.34]) parts.push(boxGeo(-0.16, 0.16, y + 0.12, y + 0.15, 0.15, 0.36));
  return mergeAll(parts);
}

interface HeadPose {
  si: number;
  group: 0 | 1 | 2;
  /** 灯箱中心 */
  x: number;
  z: number;
  facing: number;
  /** 灯杆位置与横臂 */
  px: number;
  pz: number;
  arm: number;
  armDir: number;
}

export function Signals({ site }: { site: SiteLayout }) {
  const traffic = useApp((s) => s.site.traffic);
  const siteSeed = useApp((s) => s.site.seed);
  const heads = useMemo<HeadPose[]>(() => {
    const out: HeadPose[] = [];
    site.signals.forEach((s, si) => {
      const base = s.heads.filter((h) => h.group !== 2);
      for (const h of s.heads) {
        // 左转灯与同侧的直行灯共用灯杆
        const host = h.group === 2 ? base.find((b) => Math.abs(b.x - h.x) < 0.1 && Math.abs(b.z - h.z) < 1.0 && b.group === 0) : undefined;
        const px = host?.x ?? h.x;
        const pz = host?.z ?? h.z;
        const fx = Math.sin(h.facing);
        const fz = Math.cos(h.facing);
        let vx = s.x - px;
        let vz = s.z - pz;
        const along = vx * fx + vz * fz;
        vx -= along * fx;
        vz -= along * fz;
        const len = Math.hypot(vx, vz);
        const arm = len < 0.5 ? 0 : Math.min(6.5, Math.max(1.6, len * 0.62)) - (h.group === 2 ? 1.0 : 0);
        const ux = len < 0.5 ? 0 : vx / len;
        const uz = len < 0.5 ? 0 : vz / len;
        out.push({ si, group: h.group, x: px + ux * arm + fx * 0.05, z: pz + uz * arm + fz * 0.05, facing: h.facing, px, pz, arm: h.group === 2 ? 0 : arm, armDir: Math.atan2(ux, uz) });
      }
    });
    return out;
  }, [site]);

  const headGeo = useMemo(() => headGeometry(), []);
  const poleRef = useRef<THREE.InstancedMesh>(null);
  const armRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const lampRef = useRef<THREE.InstancedMesh>(null);
  const poles = useMemo(() => heads.filter((h) => h.group !== 2), [heads]);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const P = poleRef.current;
    const A = armRef.current;
    const H = headRef.current;
    poles.forEach((h, i) => {
      o.position.set(h.px, POLE_H / 2, h.pz);
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      P?.setMatrixAt(i, o.matrix);
      // 横臂：从灯杆顶部沿 armDir 伸出
      o.position.set(h.px + Math.sin(h.armDir) * (h.arm / 2), POLE_H - 0.25, h.pz + Math.cos(h.armDir) * (h.arm / 2));
      o.rotation.set(0, h.armDir, 0);
      o.scale.set(1, 1, Math.max(0.01, h.arm + 0.2));
      o.updateMatrix();
      A?.setMatrixAt(i, o.matrix);
    });
    heads.forEach((h, i) => {
      o.position.set(h.x, HEAD_Y, h.z);
      o.rotation.set(0, h.facing, 0);
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      H?.setMatrixAt(i, o.matrix);
    });
    for (const m of [P, A, H]) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [heads, poles]);

  const col = useMemo(() => new THREE.Color(), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const m = lampRef.current;
    if (!m) return;
    const sim = trafficFor(site, siteSeed, traffic * 0.5);
    const boost = 1 + 2.4 * env.night;
    let i = 0;
    for (const h of heads) {
      const signal = site.signals[h.si];
      if (!signal) continue;
      const light = signalLight(signal, sim.time, h.group);
      const fx = Math.sin(h.facing);
      const fz = Math.cos(h.facing);
      (['R', 'Y', 'G'] as const).forEach((k, j) => {
        o.position.set(h.x + fx * 0.16, HEAD_Y + 0.34 - j * 0.34, h.z + fz * 0.16);
        o.rotation.set(0, 0, 0);
        o.scale.setScalar(0.12);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
        if (light === k) m.setColorAt(i, col.copy(LIGHT_ON[k]).multiplyScalar(boost));
        else m.setColorAt(i, LIGHT_OFF);
        i++;
      });
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  if (!heads.length) return null;
  return (
    <group>
      <instancedMesh key={`p${poles.length}`} ref={poleRef} args={[undefined, undefined, poles.length]} castShadow>
        <cylinderGeometry args={[0.09, 0.12, POLE_H, 10]} />
        <meshToonMaterial color="#59616a" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`a${poles.length}`} ref={armRef} args={[undefined, undefined, poles.length]} castShadow>
        <boxGeometry args={[0.12, 0.14, 1]} />
        <meshToonMaterial color="#59616a" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`h${heads.length}`} ref={headRef} args={[headGeo, undefined, heads.length]} castShadow>
        <meshToonMaterial color="#25292c" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`l${heads.length}`} ref={lampRef} args={[undefined, undefined, heads.length * 3]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
    </group>
  );
}
