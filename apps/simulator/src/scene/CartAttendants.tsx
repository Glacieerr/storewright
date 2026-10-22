import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { corralCounts, planCarts, type CartPlan } from './carts';
import { customerEntrance } from './crowd';
import { People, type PersonState } from './People';
import { makePolyPose, polyPose } from './polyTrace';
import { useStays } from './useSite';
import { toonGradient } from './toon';
import { useNightGlow } from './environment';
import { framePositions } from './Actors';

/** 回收员和身后那串购物车的位置（停车场里的车据此让行） */
export const cartTrain: { pts: Array<{ x: number; z: number }> } = { pts: [] };

const VEST = new THREE.Color('#f2a900');
const PANTS = new THREE.Color('#2f3640');
const CART_GAP = 0.32;
const PER_CORRAL = 16;
const CHAIN_MAX = 20;
const tmp = new THREE.Object3D();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** 身后一串购物车：沿当前片段的折线往回退 back 米处的位置与朝向 */
function backAlong(pts: Array<{ x: number; z: number }>, s: number, back: number, out: { x: number; z: number; heading: number }): void {
  let target = Math.max(0, s - back);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { x: number; z: number };
    const b = pts[i] as { x: number; z: number };
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    if (target <= l || i === pts.length - 1) {
      const k = l > 0 ? Math.min(1, target / l) : 0;
      out.x = a.x + (b.x - a.x) * k;
      out.z = a.z + (b.z - a.z) * k;
      if (l > 0) out.heading = Math.atan2(b.x - a.x, b.z - a.z);
      // 起点之前：沿第一段方向往后延伸
      if (i === 1 && s - back < 0 && l > 0) {
        out.x = a.x - ((b.x - a.x) / l) * (back - s);
        out.z = a.z - ((b.z - a.z) / l) * (back - s);
      }
      return;
    }
    target -= l;
  }
}

/** 购物车回收栏、栏里的购物车，以及推着一串购物车的回收员 */
export function CartAttendants() {
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  const floor = useApp((s) => s.floor);
  const stays = useStays();
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;
  const hours = model.config.hours;
  const plan = useMemo<CartPlan>(() => {
    const e = customerEntrance(model, geo).outside;
    return planCarts(geo.lot, stays, { x: e.x, z: e.z }, hours.openMin * 60, hours.closeMin * 60);
  }, [geo, model, stays, hours.openMin, hours.closeMin]);

  const rails = useRef<THREE.InstancedMesh>(null);
  const signs = useRef<THREE.InstancedMesh>(null);
  const basket = useRef<THREE.InstancedMesh>(null);
  const base = useRef<THREE.InstancedMesh>(null);
  const glowB = useNightGlow<THREE.MeshToonMaterial>(0.25);
  const cap = plan.corrals.length * PER_CORRAL + CHAIN_MAX;
  const pose = useMemo(() => makePolyPose(), []);
  const chainPose = useMemo(() => ({ x: 0, z: 0, heading: 0 }), []);
  const attendant = useRef<{ x: number; z: number; heading: number; moving: boolean; on: boolean }>({ x: 0, z: 0, heading: 0, moving: false, on: false });

  // 回收栏：两侧护栏 + 一根立柱上的蓝色标牌
  useLayoutEffect(() => {
    const m = rails.current;
    if (!m) return;
    let i = 0;
    for (const c of plan.corrals) {
      for (const dx of [-0.95, 0.95]) {
        tmp.position.set(c.x + dx, 0.5, c.z);
        tmp.scale.set(0.07, 0.9, c.d);
        tmp.rotation.set(0, 0, 0);
        tmp.updateMatrix();
        m.setMatrixAt(i++, tmp.matrix);
        tmp.position.set(c.x + dx, 0.92, c.z);
        tmp.scale.set(0.1, 0.08, c.d + 0.1);
        tmp.updateMatrix();
        m.setMatrixAt(i++, tmp.matrix);
      }
      tmp.position.set(c.x, 1.05, c.z - c.d / 2);
      tmp.scale.set(1.9, 0.08, 0.08);
      tmp.updateMatrix();
      m.setMatrixAt(i++, tmp.matrix);
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    // 栏口的蓝色标牌
    const sg = signs.current;
    if (sg) {
      plan.corrals.forEach((c, k) => {
        tmp.position.set(c.x - 1.05, 1.55, c.z + c.d / 2 - 0.2);
        tmp.scale.set(0.06, 0.7, 0.9);
        tmp.rotation.set(0, 0, 0);
        tmp.updateMatrix();
        sg.setMatrixAt(k, tmp.matrix);
      });
      sg.count = plan.corrals.length;
      sg.instanceMatrix.needsUpdate = true;
    }
    // 调试：地址栏带 ?debug 时可以查看回收计划
    const w = window as unknown as { __sw?: Record<string, unknown> };
    if (w.__sw) w.__sw.carts = plan;
  }, [plan]);

  useFrame(() => {
    const bm = basket.current;
    const fm = base.current;
    if (!bm || !fm) return;
    const t = clock.time;
    let n = 0;
    const cart = (x: number, z: number, heading: number) => {
      if (n >= cap) return;
      tmp.position.set(x, 0.62, z);
      tmp.rotation.set(0, heading, 0);
      tmp.scale.set(0.56, 0.42, 0.82);
      tmp.updateMatrix();
      bm.setMatrixAt(n, tmp.matrix);
      tmp.position.set(x, 0.18, z);
      tmp.scale.set(0.5, 0.08, 0.86);
      tmp.updateMatrix();
      fm.setMatrixAt(n, tmp.matrix);
      n++;
    };
    if (visible) {
      // 栏里的购物车：从里往外套在一起
      const counts = corralCounts(plan, t);
      plan.corrals.forEach((c, ci) => {
        const k = Math.min(PER_CORRAL, counts[ci] ?? 0);
        for (let j = 0; j < k; j++) cart(c.x, c.z - c.d / 2 + 0.6 + j * CART_GAP, Math.PI);
      });
      // 回收员与身前推着的一串购物车
      const a = attendant.current;
      a.on = false;
      cartTrain.pts.length = 0;
      if (t >= plan.shift[0] - 60 && t <= plan.shift[1] + 1800 && polyPose(plan.segments, t, pose)) {
        const idle = pose.gapAfter && t - pose.gapAfter.t1 > 20;
        if (!idle) {
          a.on = true;
          a.x = pose.x;
          a.z = pose.z;
          a.heading = pose.heading;
          a.moving = pose.moving;
          const seg = pose.gapAfter ?? pose.seg;
          const chain = Math.min(CHAIN_MAX, Number(seg?.carry ?? 0) || 0);
          if (seg && chain > 0) {
            const pts = seg.pts.map((p) => ({ x: p.x, z: p.z }));
            let total = 0;
            for (let i = 1; i < pts.length; i++) total += Math.hypot((pts[i] as { x: number }).x - (pts[i - 1] as { x: number }).x, (pts[i] as { z: number }).z - (pts[i - 1] as { z: number }).z);
            const s = pose.gapAfter ? total : pose.k * total;
            chainPose.heading = a.heading;
            // 推着走：购物车在人前面；收拢时停在原地
            for (let j = 0; j < chain; j++) {
              backAlong(pts, s, -(0.9 + j * CART_GAP), chainPose);
              cart(chainPose.x, chainPose.z, chainPose.heading);
              if (j % 3 === 2) cartTrain.pts.push({ x: chainPose.x, z: chainPose.z });
            }
          }
          cartTrain.pts.push({ x: a.x, z: a.z });
          framePositions.set('cart-attendant', { x: a.x, y: 0, z: a.z });
        }
      }
    }
    if (!attendant.current.on) framePositions.delete('cart-attendant');
    for (let i = n; i < Math.min(cap, n + 4); i++) {
      bm.setMatrixAt(i, HIDDEN);
      fm.setMatrixAt(i, HIDDEN);
    }
    bm.count = n;
    fm.count = n;
    bm.instanceMatrix.needsUpdate = true;
    fm.instanceMatrix.needsUpdate = true;
  });

  const fill = (out: PersonState[]) => {
    const a = attendant.current;
    if (!visible || !a.on) return 0;
    const o = out[0] as PersonState;
    o.x = a.x;
    o.y = 0;
    o.z = a.z;
    o.heading = a.heading;
    o.moving = a.moving;
    o.shirt.copy(VEST);
    o.pants.copy(PANTS);
    o.cart = 'none';
    o.scale = 1.3;
    o.seed = 7;
    return 1;
  };

  if (!plan.corrals.length) return null;
  return (
    <group>
      <instancedMesh key={`r${plan.corrals.length}`} ref={rails} args={[undefined, undefined, plan.corrals.length * 5]} frustumCulled={false}>
        <boxGeometry />
        <meshToonMaterial color="#8c969e" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`s${plan.corrals.length}`} ref={signs} args={[undefined, undefined, plan.corrals.length]} frustumCulled={false}>
        <boxGeometry />
        <meshToonMaterial color="#2f6fb5" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`b${cap}`} ref={basket} args={[undefined, undefined, cap]} frustumCulled={false} castShadow>
        <boxGeometry />
        <meshToonMaterial ref={glowB} color="#b8c2cc" gradientMap={toonGradient()} transparent opacity={0.85} />
      </instancedMesh>
      <instancedMesh key={`f${cap}`} ref={base} args={[undefined, undefined, cap]} frustumCulled={false}>
        <boxGeometry />
        <meshToonMaterial color="#5c636a" gradientMap={toonGradient()} />
      </instancedMesh>
      <People max={1} fill={fill} />
    </group>
  );
}
