import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { createRng } from '@storewright/domain';
import type { SiteLayout } from '../site';
import { type Boat, type WaterPlan } from './waterPlan';
import { atBerth, boatAt, pathPointAt, planBoats, visitorAt, type BoatLeg, type BoatTraffic } from './harbor';
import type { PathState } from '../lot';
import { env } from '../environment';
import { boatGeometry, BOAT_SPEC, type BoatKind } from '../vehicles/boats';
import { clock } from '../../state/clock';
import { useApp } from '../../state/store';
import { boxGeo, mergeAll } from './geom';
import { makeTriplanarMaterial, makeWorldTexMaterial } from './terrainMaterial';
import { flagstoneTexture, paverTexture, plankTexture, stoneTexture } from './textures';
import { toonGradient } from '../toon';
import { lampMetal, lanternGlass } from '../style/lights';

/**
 * 湖边：木栈桥（铺板、横梁、木桩、绳栏、T 形平台）、系在栈桥边随水波起伏的小船、
 * 岸上的石板小广场（长椅、花坛、租船小亭）、环湖步道、跨渠道的拱形木桥、公园路灯和长椅。
 */

const tmp = new THREE.Object3D();
const col = new THREE.Color();
const WOOD = ['#b98a5a', '#a87b4f', '#c49766', '#9c7148'].map((c) => new THREE.Color(c));

interface Inst {
  x: number;
  y: number;
  z: number;
  rx?: number;
  ry?: number;
  rz?: number;
  sx: number;
  sy: number;
  sz: number;
  color?: THREE.Color;
}

function useInst(ref: React.RefObject<THREE.InstancedMesh>, items: Inst[]): void {
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      tmp.position.set(it.x, it.y, it.z);
      tmp.rotation.set(it.rx ?? 0, it.ry ?? 0, it.rz ?? 0);
      tmp.scale.set(it.sx, it.sy, it.sz);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      if (it.color) m.setColorAt(i, it.color);
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [ref, items]);
}

/** 一条船：车漆部分（船体颜色按实例）+ 细节部分（顶点色） */
function BoatBody({ kind, color }: { kind: BoatKind; color: string }) {
  const g = boatGeometry(kind);
  return (
    <>
      <mesh geometry={g.paint} castShadow>
        <meshToonMaterial color={color} gradientMap={toonGradient()} />
      </mesh>
      <mesh geometry={g.detail} castShadow>
        <meshToonMaterial vertexColors gradientMap={toonGradient()} />
      </mesh>
    </>
  );
}

const WAKE_N = 26;
const WAKE_STEP = 1.15;
const MAX_WAKES = 6;

/**
 * 小船（决策记录 0018、0019）：系在栈桥边的划艇、快艇、小帆船、皮划艇、浮筒船随波起伏、轻微横摇；
 * 快艇、小帆船按时刻表出海、回港，浮筒船在湖里兜圈（见 harbor.ts）。开得快时船头抬起，转弯时向弯内侧倾，
 * 船后拖着白色尾迹和 V 形的船行波；驶出场地边缘就看不见了。
 */
function Boats({ boats, w, seed, traffic }: { boats: Boat[]; w: WaterPlan; seed: number; traffic: BoatTraffic }) {
  const level = w.lake.level;
  const refs = useRef<Array<THREE.Group | null>>([]);
  // 没有泊位的船：海上来的访客船、海湾里经过的船（决策记录 0020）
  const vrefs = useRef<Array<THREE.Group | null>>([]);
  // 出海水道上的人行开启桥：两扇桥面绕两岸的转轴抬起（帆船的桅杆过不去时）
  const leafA = useRef<THREE.Group>(null);
  const leafB = useRef<THREE.Group>(null);
  const lift = useRef(0);
  const schedule = useMemo(() => planBoats(w, seed, traffic), [w, seed, traffic]);
  const pose = useMemo<PathState>(() => ({ x: 0, z: 0, heading: 0 }), []);
  // 调试：地址栏带 ?debug 时可以查看当天的船只时刻表
  useEffect(() => {
    const g = window as unknown as { __sw?: Record<string, unknown> };
    if (g.__sw)
      g.__sw.boats = [
        ...schedule.legs.map((l) => ({ berth: l.berth, kind: l.kind, boat: boats[l.berth]?.kind, start: l.start, path: l.path })),
        ...schedule.visitors.map((v) => ({ berth: -1, kind: v.leg.kind, boat: v.kind, start: v.leg.start, path: v.leg.path })),
      ];
  }, [schedule, boats]);
  const wake = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = MAX_WAKES * 3 * WAKE_N * 6;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    g.setDrawRange(0, 0);
    return g;
  }, []);
  useFrame(({ clock: tc }) => {
    const t = tc.elapsedTime;
    const now = clock.time;
    // 高倍速播放时一程按画面拉长（最多 12 倍），和车辆进出场一样看得清
    const f = Math.min(12, Math.max(1, clock.speed / 8));
    const pos = wake.getAttribute('position') as THREE.BufferAttribute;
    const col = wake.getAttribute('color') as THREE.BufferAttribute;
    let vi = 0;
    let wakes = 0;
    const put = (x: number, z: number, a: number) => {
      pos.setXYZ(vi, x, level + 0.03, z);
      col.setXYZW(vi, 1, 1, 1, a);
      vi++;
    };
    boats.forEach((bt, i) => {
      const g = refs.current[i];
      if (!g) return;
      const ph = bt.x * 0.7 + bt.z * 0.3;
      const wl = BOAT_SPEC[bt.kind].waterline;
      // 越小的船晃得越厉害
      const k = bt.kind === 'kayak' || bt.kind === 'row' ? 1.4 : bt.kind === 'pontoon' ? 0.5 : 1;
      if (atBerth(schedule, i, now, f)) {
        g.visible = true;
        g.position.set(bt.x, level - wl + Math.sin(t * 1.3 + ph) * 0.035 * k, bt.z);
        g.rotation.set(Math.sin(t * 0.8 + ph) * 0.02 * k, bt.heading + Math.sin(t * 0.21 + ph) * 0.04, Math.sin(t * 1.05 + ph * 1.3) * 0.04 * k, 'YXZ');
        return;
      }
      const hit = boatAt(schedule, i, now, pose, f);
      // 出海期间（不在场地里）或驶出了场地边缘：看不见
      if (!hit || pose.z < w.minZ + 2) {
        g.visible = false;
        return;
      }
      sail(g, wl, ph, hit.leg, hit.tau);
    });
    schedule.visitors.forEach((vs, i) => {
      const g = vrefs.current[i];
      if (!g) return;
      const tau = visitorAt(vs, now, pose, f);
      if (tau === undefined || pose.z < w.minZ + 2) {
        g.visible = false;
        return;
      }
      sail(g, BOAT_SPEC[vs.kind].waterline, i * 2.3 + 0.7, vs.leg, tau);
    });

    /** 行驶中的船：滑行时船头抬起（最多约 5°），转弯时向弯内侧倾；船后拖着尾迹 */
    function sail(g: THREE.Group, wl: number, ph: number, leg: BoatLeg, tau: number) {
      g.visible = true;
      const v = pose.speed ?? 0;
      const pitch = -Math.min(0.09, v * 0.013) + Math.sin(t * 1.7 + ph) * 0.01;
      const bank = Math.max(-0.14, Math.min(0.14, (pose.lat ?? 0) * 0.05));
      g.position.set(pose.x, level - wl + Math.min(0.12, v * 0.02) + Math.sin(t * 2.1 + ph) * 0.025, pose.z);
      g.rotation.set(pitch, pose.heading, -bank, 'YXZ');
      // 尾迹：沿走过的航线往回取样，中间一条渐宽渐淡的白色泡沫带，两侧是向外张开的船行波（约 19°）
      const local = tau - leg.forwardAt;
      if (v < 1.2 || local < 0 || wakes >= MAX_WAKES) return;
      wakes++;
      const st: PathState = { x: 0, z: 0, heading: 0 };
      leg.forward.at(local, st);
      const dist = st.dist ?? 0;
      const strength = Math.min(1, (v - 1.2) / 3.5);
      const sample = (kk: number, lateral: number) => {
        const q = pathPointAt(leg.forward, dist - 2.2 - kk * WAKE_STEP);
        return { x: q.x - Math.cos(q.heading) * lateral, z: q.z + Math.sin(q.heading) * lateral };
      };
      for (const strip of [0, 1, -1]) {
        for (let kk = 0; kk < WAKE_N; kk++) {
          const d0 = kk * WAKE_STEP;
          const d1 = (kk + 1) * WAKE_STEP;
          const fade0 = (1 - kk / WAKE_N) * strength;
          const fade1 = (1 - (kk + 1) / WAKE_N) * strength;
          const half0 = strip === 0 ? 0.5 + d0 * 0.06 : 0.22;
          const half1 = strip === 0 ? 0.5 + d1 * 0.06 : 0.22;
          const off0 = strip * (0.9 + d0 * 0.35);
          const off1 = strip * (0.9 + d1 * 0.35);
          const a0 = (strip === 0 ? 0.7 : 0.45) * fade0;
          const a1 = (strip === 0 ? 0.7 : 0.45) * fade1;
          const l0 = sample(kk, off0 - half0);
          const r0 = sample(kk, off0 + half0);
          const l1 = sample(kk + 1, off1 - half1);
          const r1 = sample(kk + 1, off1 + half1);
          put(l0.x, l0.z, a0);
          put(r0.x, r0.z, a0);
          put(l1.x, l1.z, a1);
          put(r0.x, r0.z, a0);
          put(r1.x, r1.z, a1);
          put(l1.x, l1.z, a1);
        }
      }
    }
    wake.setDrawRange(0, vi);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    // 开启桥：有帆船在桥两侧 35 米以内（正往桥这边开）时抬起，过去后放下
    const o = w.outlet;
    if (o) {
      let want = 0;
      boats.forEach((bt, i) => {
        if (bt.kind !== 'sail' || atBerth(schedule, i, now, f)) return;
        const hit = boatAt(schedule, i, now, pose, f);
        if (hit && Math.abs(pose.z - o.bridge.z) < 35 && Math.abs(pose.x - o.x) < o.half + 12) want = 1;
      });
      // 进湖的访客帆船也要抬桥
      schedule.visitors.forEach((vs) => {
        if (vs.kind !== 'sail' || vs.leg.kind !== 'visit') return;
        if (visitorAt(vs, now, pose, f) !== undefined && Math.abs(pose.z - o.bridge.z) < 35 && Math.abs(pose.x - o.x) < o.half + 12) want = 1;
      });
      lift.current += (want - lift.current) * Math.min(1, 0.04 * Math.max(1, f));
      const a = lift.current * 1.35;
      if (leafA.current) leafA.current.rotation.z = a;
      if (leafB.current) leafB.current.rotation.z = -a;
    }
  });
  const ob = w.outlet?.bridge;
  const leaf = ob ? (ob.x1 - ob.x0) / 2 : 0;
  const deckY = w.groundY + 0.25;
  return (
    <group>
      {boats.map((b, i) => (
        <group
          key={i}
          ref={(g) => {
            refs.current[i] = g;
          }}
        >
          <BoatBody kind={b.kind} color={b.color} />
        </group>
      ))}
      {schedule.visitors.map((v, i) => (
        <group
          key={`v${i}`}
          visible={false}
          ref={(g) => {
            vrefs.current[i] = g;
          }}
        >
          <BoatBody kind={v.kind} color={v.color} />
        </group>
      ))}
      <mesh geometry={wake} frustumCulled={false} renderOrder={3}>
        <meshBasicMaterial vertexColors transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {ob && (
        <group>
          {[
            { ref: leafA, x: ob.x0, dir: 1 },
            { ref: leafB, x: ob.x1, dir: -1 },
          ].map(({ ref, x, dir }) => (
            <group key={dir} position={[x, deckY, ob.z]} ref={ref}>
              {/* 桥面、两侧栏杆 */}
              <mesh position={[(dir * leaf) / 2, 0, 0]} castShadow receiveShadow>
                <boxGeometry args={[leaf - 0.08, 0.16, ob.width]} />
                <meshToonMaterial color="#b98a5a" gradientMap={toonGradient()} />
              </mesh>
              {[-1, 1].map((side) => (
                <mesh key={side} position={[(dir * leaf) / 2, 0.55, (side * ob.width) / 2]} castShadow>
                  <boxGeometry args={[leaf - 0.1, 0.08, 0.08]} />
                  <meshToonMaterial color="#e9e6df" gradientMap={toonGradient()} />
                </mesh>
              ))}
            </group>
          ))}
          {/* 两岸的桥墩和转轴座 */}
          {[ob.x0, ob.x1].map((x) => (
            <mesh key={x} position={[x, (w.lake.level + deckY) / 2 - 0.4, ob.z]} castShadow>
              <boxGeometry args={[1.0, deckY - w.lake.level + 0.8, ob.width + 0.6]} />
              <meshToonMaterial color="#cfc8b8" gradientMap={toonGradient()} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}

/**
 * 出海口的防波堤（决策记录 0019）：水道口两侧伸进海湾的抛石堤（大块石头堆成、顶上一条压顶），
 * 堤头立着航标灯（进港方向右红左绿，夜里闪）。
 */
function Jetties({ w }: { w: WaterPlan }) {
  const o = w.outlet;
  const parts = useMemo(() => {
    const rocks: Inst[] = [];
    const caps: THREE.BufferGeometry[] = [];
    const towers: Array<{ x: number; z: number; color: string }> = [];
    if (!o) return { rocks, caps: mergeAll([new THREE.BufferGeometry()]), towers };
    const rng = createRng(Math.round(o.x * 13) + 5);
    const ROCK = ['#9c968a', '#a9a294', '#8f8a80', '#b2ab9d'].map((c) => new THREE.Color(c));
    const top = w.groundY + 0.35;
    for (const j of o.jetties) {
      // 抛石：从海底堆到水面以上，两侧斜坡上的大石块
      for (let z = j.z0; z <= j.z1; z += 0.9) {
        for (let k = 0; k < 4; k++) {
          const side = k % 2 === 0 ? -1 : 1;
          const x = (j.x0 + j.x1) / 2 + side * ((j.x1 - j.x0) / 2 + rng.uniform(-0.2, 0.6));
          const s = rng.uniform(0.7, 1.25);
          rocks.push({ x, y: w.lake.level + rng.uniform(-0.6, 0.5), z: z + rng.uniform(-0.3, 0.3), ry: rng.uniform(0, 6.28), rx: rng.uniform(-0.3, 0.3), sx: s * 1.3, sy: s * 0.9, sz: s, color: rng.pick(ROCK) });
        }
      }
      caps.push(boxGeo(j.x0, j.x1, o.bed, top, j.z0, j.z1));
      towers.push({ x: (j.x0 + j.x1) / 2, z: j.z0 + 1.2, color: j.light === 'red' ? '#d23b2f' : '#2f9a55' });
    }
    return { rocks, caps: mergeAll(caps), towers };
  }, [o, w]);
  const rockRef = useRef<THREE.InstancedMesh>(null);
  useInst(rockRef, parts.rocks);
  const lamps = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  useFrame(({ clock: tc }) => {
    // 航标灯：夜里闪（亮 1 秒、灭 3 秒，两盏错开），白天常暗
    const night = env.night > 0.3;
    lamps.current.forEach((m, i) => {
      if (!m) return;
      const on = night && (tc.elapsedTime + i * 2) % 4 < 1;
      m.color.set(on ? (parts.towers[i]?.color === '#d23b2f' ? '#ff5a4a' : '#5cff8a') : (parts.towers[i]?.color ?? '#888888')).multiplyScalar(on ? 1.6 : 0.6);
    });
  });
  if (!o) return null;
  return (
    <group>
      <instancedMesh key={`jr${parts.rocks.length}`} ref={rockRef} args={[undefined, undefined, parts.rocks.length]} castShadow receiveShadow>
        <dodecahedronGeometry args={[0.6, 0]} />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <mesh geometry={parts.caps} castShadow receiveShadow>
        <meshToonMaterial color="#cfc8b8" gradientMap={toonGradient()} />
      </mesh>
      {parts.towers.map((tw, i) => (
        <group key={i} position={[tw.x, w.groundY + 0.35, tw.z]}>
          <mesh position={[0, 1.6, 0]} castShadow>
            <cylinderGeometry args={[0.32, 0.42, 3.2, 10]} />
            <meshToonMaterial color={tw.color} gradientMap={toonGradient()} />
          </mesh>
          <mesh position={[0, 1.6, 0]}>
            <cylinderGeometry args={[0.43, 0.43, 0.5, 10]} />
            <meshToonMaterial color="#f4f2ea" gradientMap={toonGradient()} />
          </mesh>
          <mesh position={[0, 3.45, 0]}>
            <cylinderGeometry args={[0.2, 0.2, 0.5, 8]} />
            <meshBasicMaterial
              ref={(m) => {
                lamps.current[i] = m;
              }}
              color={tw.color}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** 栈桥：铺板（沿栈桥横铺，T 形平台竖铺）、木桩、横梁、绳栏 */
function pierParts(w: WaterPlan, seed: number): { planks: Inst[]; posts: Inst[]; beams: THREE.BufferGeometry; ropes: Inst[] } {
  const p = w.pier;
  const rng = createRng(seed * 31 + 7);
  const planks: Inst[] = [];
  const posts: Inst[] = [];
  const ropes: Inst[] = [];
  const beams: THREE.BufferGeometry[] = [];
  const y = p.deckY;
  const hw = p.width / 2;
  const zHead = p.zEnd - p.head.d / 2;
  // 岸上一端是一段坡道（湖面比地面低很多，决策记录 0019）：从地面降到桥面高度
  const groundTop = w.groundY + 0.06;
  const ramp = Math.min(8, Math.max(0, (groundTop - y) * 3.4));
  const zRamp = p.zLand - ramp;
  const deckAt = (z: number) => (z >= zRamp && ramp > 0 ? y + (groundTop - y) * ((z - zRamp) / ramp) : y);
  const slope = ramp > 0 ? Math.atan2(groundTop - y, ramp) : 0;
  for (let z = p.zLand; z > p.zEnd - 0.1; z -= 0.25) planks.push({ x: p.x + rng.uniform(-0.03, 0.03), y: deckAt(z) - 0.04, z, rx: z > zRamp ? -slope : 0, sx: p.width + rng.uniform(-0.04, 0.08), sy: 0.07, sz: 0.22, color: rng.pick(WOOD) });
  for (let x = p.x - p.head.w / 2 + 0.12; x < p.x + p.head.w / 2; x += 0.25) planks.push({ x, y: y - 0.04, z: zHead, sx: 0.22, sy: 0.07, sz: p.head.d + rng.uniform(-0.04, 0.06), color: rng.pick(WOOD) });
  beams.push(boxGeo(p.x - hw + 0.1, p.x - hw + 0.3, y - 0.36, y - 0.08, p.zEnd, zRamp), boxGeo(p.x + hw - 0.3, p.x + hw - 0.1, y - 0.36, y - 0.08, p.zEnd, zRamp));
  if (ramp > 0) {
    // 坡道下面的两根斜梁
    for (const bx of [p.x - hw + 0.2, p.x + hw - 0.2]) {
      const g = new THREE.BoxGeometry(0.2, 0.28, Math.hypot(ramp, groundTop - y));
      g.rotateX(-slope);
      g.translate(bx, (y + groundTop) / 2 - 0.22, zRamp + ramp / 2);
      beams.push(g);
    }
  }
  beams.push(boxGeo(p.x - p.head.w / 2, p.x + p.head.w / 2, y - 0.36, y - 0.08, zHead - p.head.d / 2 + 0.1, zHead - p.head.d / 2 + 0.3));
  beams.push(boxGeo(p.x - p.head.w / 2, p.x + p.head.w / 2, y - 0.36, y - 0.08, zHead + p.head.d / 2 - 0.3, zHead + p.head.d / 2 - 0.1));
  const bed = w.lake.bed - 0.2;
  const post = (x: number, z: number, above: number) => {
    const h = deckAt(z) + above - bed;
    posts.push({ x, y: bed + h / 2, z, sx: 1, sy: h, sz: 1, ry: rng.uniform(0, 6.28) });
  };
  const railPosts: Array<[number, number]> = [];
  for (let z = p.zLand - 1.2; z > p.zEnd + p.head.d * 0.5; z -= 2.4) {
    post(p.x - hw + 0.05, z, 0.85);
    post(p.x + hw - 0.05, z, 0.85);
    railPosts.push([p.x - hw + 0.05, z], [p.x + hw - 0.05, z]);
  }
  for (let x = p.x - p.head.w / 2 + 0.2; x <= p.x + p.head.w / 2 - 0.1; x += 2.4) {
    post(x, zHead - p.head.d / 2 + 0.1, 0.5);
    post(x, zHead + p.head.d / 2 - 0.1, x > p.x - hw - 0.3 && x < p.x + hw + 0.3 ? -0.05 : 0.5);
  }
  // 绳栏：相邻栏杆柱之间一根略微下垂的绳子（两段直线近似）
  for (const side of [-1, 1]) {
    const pts = railPosts.filter(([x]) => Math.sign(x - p.x) === side).sort((a, b) => b[1] - a[1]);
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1] as [number, number];
      const [x1, z1] = pts[i] as [number, number];
      const len = Math.hypot(x1 - x0, z1 - z0);
      for (const half of [0, 1]) {
        const za = half === 0 ? z0 : (z0 + z1) / 2;
        const zb = half === 0 ? (z0 + z1) / 2 : z1;
        const ya = deckAt(za) + 0.72 - (half === 0 ? 0 : 0.12);
        const yb = deckAt(zb) + 0.72 - (half === 0 ? 0.12 : 0);
        const l = Math.hypot(zb - za, yb - ya);
        ropes.push({ x: (x0 + x1) / 2, y: (ya + yb) / 2, z: (za + zb) / 2, rx: Math.atan2(yb - ya, za - zb) + Math.PI / 2, sx: 1, sy: l, sz: 1 });
      }
      void len;
    }
  }
  return { planks, posts, beams: mergeAll(beams), ropes };
}

/** 环湖步道：沿水边线向外偏移 pathOffset 的一条带子；渠口和广场处断开 */
function lakePath(w: WaterPlan): THREE.BufferGeometry {
  const l = w.lake;
  const sh = l.shore;
  const n = sh.length;
  const off = w.pathOffset;
  const half = 1.3;
  const pos: number[] = [];
  const nrm: number[] = [];
  const o = w.outlet;
  const skip = (x: number, z: number) =>
    (x > l.neck.x0 - 5 && x < l.neck.x1 + 5 && z > l.neck.z0 - 7) ||
    (Math.abs(x - w.plaza.x) < w.plaza.w / 2 && Math.abs(z - w.plaza.z) < w.plaza.d / 2 + 1) ||
    // 出海水道：步道在两岸断开，由开启桥接上
    (!!o && x > o.bridge.x0 + 0.4 && x < o.bridge.x1 - 0.4 && z < o.z1 + 4 && z > o.z0);
  const pt = (i: number, k: number) => {
    const a = sh[(i - 1 + n) % n] as { x: number; z: number };
    const c = sh[(i + 1) % n] as { x: number; z: number };
    const b = sh[i % n] as { x: number; z: number };
    // 外法线（多边形逆时针，左法线朝内，取反）
    let nx = c.z - a.z;
    let nz = -(c.x - a.x);
    const L = Math.hypot(nx, nz) || 1;
    nx /= L;
    nz /= L;
    return { x: b.x + nx * (off + k), z: b.z + nz * (off + k) };
  };
  const y = w.groundY + 0.035;
  for (let i = 0; i < n; i++) {
    const a0 = pt(i, -half);
    const a1 = pt(i, half);
    const b0 = pt(i + 1, -half);
    const b1 = pt(i + 1, half);
    if (skip((a0.x + b1.x) / 2, (a0.z + b1.z) / 2)) continue;
    pos.push(a0.x, y, a0.z, b0.x, y, b0.z, a1.x, y, a1.z, a1.x, y, a1.z, b0.x, y, b0.z, b1.x, y, b1.z);
    for (let k = 0; k < 6; k++) nrm.push(0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  // 三角形朝向统一朝上
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i += 3) {
    const ax = p.getX(i);
    const az = p.getZ(i);
    const bx = p.getX(i + 1);
    const bz = p.getZ(i + 1);
    const cx = p.getX(i + 2);
    const cz = p.getZ(i + 2);
    // y 分量的叉积：(b - a) × (c - a) 的 y = (bz - az)(cx - ax) - (bx - ax)(cz - az)
    if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) {
      p.setXYZ(i + 1, cx, y, cz);
      p.setXYZ(i + 2, bx, y, bz);
    }
  }
  return g;
}

/** 跨渠道的拱形木桥：桥面随拱升起，栏杆柱和扶手跟着弧线 */
function footbridgeParts(w: WaterPlan, seed: number): { planks: Inst[]; posts: Inst[]; rails: Inst[] } {
  const f = w.footbridge;
  const rng = createRng(seed * 17 + 3);
  const planks: Inst[] = [];
  const posts: Inst[] = [];
  const rails: Inst[] = [];
  const span = f.x1 - f.x0;
  const base = w.groundY + 0.24;
  const rise = 0.55;
  const yAt = (x: number) => base + rise * Math.sin((Math.PI * (x - f.x0)) / span);
  const slope = (x: number) => ((rise * Math.PI) / span) * Math.cos((Math.PI * (x - f.x0)) / span);
  for (let x = f.x0 + 0.1; x < f.x1; x += 0.24) planks.push({ x, y: yAt(x), z: f.z, rz: Math.atan(slope(x)), sx: 0.21, sy: 0.07, sz: f.width + rng.uniform(-0.03, 0.05), color: rng.pick(WOOD) });
  const n = 6;
  for (const side of [-1, 1]) {
    const z = f.z + side * (f.width / 2 - 0.06);
    for (let i = 0; i <= n; i++) {
      const x = f.x0 + 0.15 + ((span - 0.3) * i) / n;
      posts.push({ x, y: yAt(x) + 0.45, z, sx: 0.09, sy: 0.9, sz: 0.09, color: WOOD[1] });
    }
    for (let i = 0; i < n * 2; i++) {
      const xa = f.x0 + 0.15 + ((span - 0.3) * i) / (n * 2);
      const xb = f.x0 + 0.15 + ((span - 0.3) * (i + 1)) / (n * 2);
      const ya = yAt(xa) + 0.9;
      const yb = yAt(xb) + 0.9;
      rails.push({ x: (xa + xb) / 2, y: (ya + yb) / 2, z, rz: Math.atan2(yb - ya, xb - xa), sx: Math.hypot(xb - xa, yb - ya) + 0.02, sy: 0.08, sz: 0.1, color: WOOD[0] });
    }
  }
  // 桥下的两根弧形主梁
  for (const side of [-1, 1]) {
    for (let i = 0; i < 12; i++) {
      const xa = f.x0 + (span * i) / 12;
      const xb = f.x0 + (span * (i + 1)) / 12;
      const ya = yAt(xa) - 0.16;
      const yb = yAt(xb) - 0.16;
      rails.push({ x: (xa + xb) / 2, y: (ya + yb) / 2, z: f.z + side * (f.width / 2 - 0.25), rz: Math.atan2(yb - ya, xb - xa), sx: Math.hypot(xb - xa, yb - ya) + 0.02, sy: 0.22, sz: 0.16, color: WOOD[3] });
    }
  }
  return { planks, posts, rails };
}

/** 公园路灯：深色灯杆 + 灯笼形灯头 */
function parkLampParts(points: Array<{ x: number; z: number }>, y0: number): { metal: THREE.BufferGeometry; glass: THREE.BufferGeometry } | undefined {
  if (!points.length) return undefined;
  const metal: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  for (const p of points) {
    const pole = new THREE.CylinderGeometry(0.055, 0.085, 3.1, 8);
    pole.translate(p.x, y0 + 1.55, p.z);
    metal.push(pole, boxGeo(p.x - 0.16, p.x + 0.16, y0, y0 + 0.3, p.z - 0.16, p.z + 0.16));
    metal.push(boxGeo(p.x - 0.2, p.x + 0.2, y0 + 3.1, y0 + 3.16, p.z - 0.2, p.z + 0.2));
    const roof = new THREE.ConeGeometry(0.3, 0.3, 4);
    roof.rotateY(Math.PI / 4);
    roof.translate(p.x, y0 + 3.68, p.z);
    metal.push(roof);
    glass.push(boxGeo(p.x - 0.15, p.x + 0.15, y0 + 3.16, y0 + 3.53, p.z - 0.15, p.z + 0.15));
  }
  return { metal: mergeAll(metal), glass: mergeAll(glass) };
}

/** 长椅：木条座面与靠背、铸铁扶手（按朝向旋转） */
function benchGeometry(): { wood: THREE.BufferGeometry; iron: THREE.BufferGeometry } {
  const wood: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) wood.push(boxGeo(-0.85, 0.85, 0.42, 0.46, -0.2 + k * 0.14, -0.09 + k * 0.14));
  for (let k = 0; k < 2; k++) {
    const g = boxGeo(-0.85, 0.85, 0.58 + k * 0.17, 0.68 + k * 0.17, -0.03, 0.0);
    g.rotateX(-0.18);
    g.translate(0, 0, -0.18);
    wood.push(g);
  }
  const iron: THREE.BufferGeometry[] = [];
  for (const x of [-0.75, 0.75]) {
    iron.push(boxGeo(x - 0.04, x + 0.04, 0, 0.44, -0.22, -0.16), boxGeo(x - 0.04, x + 0.04, 0, 0.44, 0.12, 0.18), boxGeo(x - 0.04, x + 0.04, 0.4, 0.46, -0.22, 0.2), boxGeo(x - 0.04, x + 0.04, 0.44, 0.95, -0.24, -0.18));
  }
  return { wood: mergeAll(wood), iron: mergeAll(iron) };
}

/** 租船小亭：木屋、条纹遮阳篷、柜台 */
function kioskGeometry(x: number, z: number, y0: number): { wall: THREE.BufferGeometry; roof: THREE.BufferGeometry; stripe: THREE.BufferGeometry } {
  const wall = mergeAll([boxGeo(x - 1.3, x + 1.3, y0, y0 + 2.4, z - 1.0, z + 1.0), boxGeo(x - 1.35, x + 1.35, y0 + 0.9, y0 + 1.0, z - 1.25, z - 0.95)]);
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-1.6, 0);
  roofShape.lineTo(1.6, 0);
  roofShape.lineTo(0, 0.8);
  roofShape.closePath();
  const roof = new THREE.ExtrudeGeometry(roofShape, { depth: 2.6, bevelEnabled: false });
  roof.translate(x, y0 + 2.4, z - 1.3);
  const stripes: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    if (k % 2) continue;
    const g = boxGeo(x - 1.5 + k * 0.5, x - 1.0 + k * 0.5, y0 + 2.0, y0 + 2.08, z - 1.9, z - 1.0);
    g.rotateX(0);
    stripes.push(g);
  }
  const awning = boxGeo(x - 1.5, x + 1.5, y0 + 1.98, y0 + 2.0, z - 1.9, z - 1.0);
  return { wall, roof: mergeAll([roof]), stripe: mergeAll([awning, ...stripes]) };
}

export function Lakeside({ site, seed }: { site: SiteLayout; seed: number }) {
  const w = site.water;
  const traffic = useApp((s) => s.site.boats ?? 'normal');
  const parts = useMemo(() => {
    const pier = pierParts(w, seed);
    const foot = footbridgeParts(w, seed);
    const lamps = parkLampParts(w.lamps, w.groundY);
    const path = lakePath(w);
    const pl = w.plaza;
    const plaza = boxGeo(pl.x - pl.w / 2, pl.x + pl.w / 2, w.groundY - 0.05, w.groundY + 0.05, pl.z - pl.d / 2, pl.z + pl.d / 2);
    const curb = mergeAll([
      boxGeo(pl.x - pl.w / 2 - 0.15, pl.x + pl.w / 2 + 0.15, w.groundY - 0.05, w.groundY + 0.1, pl.z - pl.d / 2 - 0.15, pl.z - pl.d / 2),
      boxGeo(pl.x - pl.w / 2 - 0.15, pl.x - pl.w / 2, w.groundY - 0.05, w.groundY + 0.1, pl.z - pl.d / 2, pl.z + pl.d / 2),
      boxGeo(pl.x + pl.w / 2, pl.x + pl.w / 2 + 0.15, w.groundY - 0.05, w.groundY + 0.1, pl.z - pl.d / 2, pl.z + pl.d / 2),
      // 花坛
      boxGeo(pl.x - pl.w / 2 + 0.4, pl.x - pl.w / 2 + 1.6, w.groundY, w.groundY + 0.45, pl.z + pl.d / 2 - 1.6, pl.z + pl.d / 2 - 0.4),
      boxGeo(pl.x + pl.w / 2 - 1.6, pl.x + pl.w / 2 - 0.4, w.groundY, w.groundY + 0.45, pl.z + pl.d / 2 - 1.6, pl.z + pl.d / 2 - 0.4),
    ]);
    const kiosk = kioskGeometry(pl.x + pl.w / 2 - 2.4, pl.z + 0.4, w.groundY + 0.05);
    const bench = benchGeometry();
    return { pier, foot, lamps, path, plaza, curb, kiosk, bench };
  }, [w, seed]);
  const mats = useMemo(
    () => ({
      plank: makeWorldTexMaterial(plankTexture(), 2, '#ffffff'),
      path: makeWorldTexMaterial(paverTexture(), 2.4, '#e2d6bf'),
      plaza: makeWorldTexMaterial(flagstoneTexture(), 3, '#e6dccb'),
      trim: makeTriplanarMaterial(stoneTexture(), 2, '#ece4d4'),
    }),
    [],
  );
  const refs = {
    planks: useRef<THREE.InstancedMesh>(null),
    posts: useRef<THREE.InstancedMesh>(null),
    ropes: useRef<THREE.InstancedMesh>(null),
    fPlanks: useRef<THREE.InstancedMesh>(null),
    fPosts: useRef<THREE.InstancedMesh>(null),
    fRails: useRef<THREE.InstancedMesh>(null),
    bWood: useRef<THREE.InstancedMesh>(null),
    bIron: useRef<THREE.InstancedMesh>(null),
    flowers: useRef<THREE.InstancedMesh>(null),
  };
  const { pier, foot } = parts;
  useInst(refs.planks, pier.planks);
  useInst(refs.posts, pier.posts);
  useInst(refs.ropes, pier.ropes);
  useInst(refs.fPlanks, foot.planks);
  useInst(refs.fPosts, foot.posts);
  useInst(refs.fRails, foot.rails);
  const benches = useMemo<Inst[]>(() => w.benches.map((b) => ({ x: b.x, y: w.groundY + 0.05, z: b.z, ry: b.heading, sx: 1, sy: 1, sz: 1 })), [w]);
  useInst(refs.bWood, benches);
  useInst(refs.bIron, benches);
  // 花坛里的花
  const flowers = useMemo<Inst[]>(() => {
    const rng = createRng(seed * 13 + 1);
    const pl = w.plaza;
    const out: Inst[] = [];
    const FL = ['#f28aa6', '#ffd166', '#f6f1e7', '#c38be8', '#ff8c5a'].map((c) => new THREE.Color(c));
    for (const cx of [pl.x - pl.w / 2 + 1.0, pl.x + pl.w / 2 - 1.0]) {
      for (let k = 0; k < 14; k++) out.push({ x: cx + rng.uniform(-0.5, 0.5), y: w.groundY + 0.5, z: pl.z + pl.d / 2 - 1.0 + rng.uniform(-0.5, 0.5), sx: 0.12, sy: 0.12, sz: 0.12, color: rng.pick(FL) });
    }
    return out;
  }, [w, seed]);
  useInst(refs.flowers, flowers);
  return (
    <group>
      <instancedMesh key={`pk${pier.planks.length}`} ref={refs.planks} args={[undefined, mats.plank, pier.planks.length]} castShadow receiveShadow>
        <boxGeometry />
      </instancedMesh>
      <instancedMesh key={`pp${pier.posts.length}`} ref={refs.posts} args={[undefined, undefined, pier.posts.length]} castShadow>
        <cylinderGeometry args={[0.11, 0.13, 1, 8]} />
        <meshToonMaterial color="#8a6a4a" gradientMap={toonGradient()} />
      </instancedMesh>
      <mesh geometry={pier.beams}>
        <meshToonMaterial color="#7a5c40" gradientMap={toonGradient()} />
      </mesh>
      {pier.ropes.length > 0 && (
        <instancedMesh key={`pr${pier.ropes.length}`} ref={refs.ropes} args={[undefined, undefined, pier.ropes.length]}>
          <cylinderGeometry args={[0.025, 0.025, 1, 5]} />
          <meshToonMaterial color="#d9c49a" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
      <Boats boats={w.pier.boats} w={w} seed={seed} traffic={traffic} />
      <Jetties w={w} />
      <mesh geometry={parts.path} material={mats.path} receiveShadow />
      <mesh geometry={parts.plaza} material={mats.plaza} receiveShadow />
      <mesh geometry={parts.curb} material={mats.trim} castShadow receiveShadow />
      <instancedMesh key={`fl${flowers.length}`} ref={refs.flowers} args={[undefined, undefined, flowers.length]}>
        <icosahedronGeometry args={[1, 0]} />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <mesh geometry={parts.kiosk.wall} castShadow receiveShadow>
        <meshToonMaterial color="#f1e6cf" gradientMap={toonGradient()} />
      </mesh>
      <mesh geometry={parts.kiosk.roof} castShadow>
        <meshToonMaterial color="#c8553d" gradientMap={toonGradient()} />
      </mesh>
      <mesh geometry={parts.kiosk.stripe}>
        <meshToonMaterial color="#f7f3ea" gradientMap={toonGradient()} />
      </mesh>
      <instancedMesh key={`fp${foot.planks.length}`} ref={refs.fPlanks} args={[undefined, mats.plank, foot.planks.length]} castShadow receiveShadow>
        <boxGeometry />
      </instancedMesh>
      <instancedMesh key={`fo${foot.posts.length}`} ref={refs.fPosts} args={[undefined, undefined, foot.posts.length]} castShadow>
        <boxGeometry />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`fr${foot.rails.length}`} ref={refs.fRails} args={[undefined, undefined, foot.rails.length]} castShadow>
        <boxGeometry />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      {benches.length > 0 && (
        <>
          <instancedMesh key={`bw${benches.length}`} ref={refs.bWood} args={[parts.bench.wood, undefined, benches.length]} castShadow>
            <meshToonMaterial color="#b4824f" gradientMap={toonGradient()} />
          </instancedMesh>
          <instancedMesh key={`bi${benches.length}`} ref={refs.bIron} args={[parts.bench.iron, undefined, benches.length]} castShadow>
            <meshToonMaterial color="#39423f" gradientMap={toonGradient()} />
          </instancedMesh>
        </>
      )}
      {parts.lamps && (
        <>
          <mesh geometry={parts.lamps.metal} material={lampMetal} castShadow />
          <mesh geometry={parts.lamps.glass} material={lanternGlass} />
        </>
      )}
    </group>
  );
}

export { parkLampParts };
