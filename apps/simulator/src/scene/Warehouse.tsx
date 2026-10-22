import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { backroomLayout, floorSpotFor, LETDOWN_DIST } from '@storewright/store-config';
import type { EquipmentTrace, PalletRecord } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { makePolyPose, polyPose } from './polyTrace';
import { toonGradient } from './toon';
import { useNightGlow } from './environment';
import { t } from '../i18n';

const tmp = new THREE.Object3D();
const col = new THREE.Color();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const CARTON = ['#c9a478', '#b8946a', '#d2b48c', '#c49a6c', '#a98762'];

interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

function StaticBoxes({ items }: { items: Box[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const glow = useNightGlow<THREE.MeshToonMaterial>(0.25);
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
    <instancedMesh key={items.length} ref={ref} args={[undefined, undefined, items.length]} castShadow receiveShadow>
      <boxGeometry />
      <meshToonMaterial ref={glow} color="#ffffff" gradientMap={toonGradient()} />
    </instancedMesh>
  );
}

/** 叉车：车身、配重、护顶架、门架、货叉；举升高度和托盘由每帧更新 */
function Forklift({ id, register }: { id: string; register: (id: string, g: THREE.Group | null, forks: THREE.Group | null) => void }) {
  const forks = useRef<THREE.Group>(null);
  return (
    <group ref={(g) => register(id, g, forks.current)}>
      <mesh position={[0, 0.65, -0.1]} castShadow>
        <boxGeometry args={[1.15, 0.9, 1.7]} />
        <meshToonMaterial color="#e8a33d" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[0, 0.75, -0.95]} castShadow>
        <boxGeometry args={[1.15, 0.8, 0.35]} />
        <meshToonMaterial color="#3d4247" gradientMap={toonGradient()} />
      </mesh>
      {[-0.5, 0.5].flatMap((x) =>
        [-0.75, 0.35].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 1.55, z]}>
            <boxGeometry args={[0.06, 1.1, 0.06]} />
            <meshToonMaterial color="#2b2e31" gradientMap={toonGradient()} />
          </mesh>
        )),
      )}
      <mesh position={[0, 2.12, -0.2]}>
        <boxGeometry args={[1.1, 0.06, 1.2]} />
        <meshToonMaterial color="#2b2e31" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[0, 1.35, -0.3]}>
        <capsuleGeometry args={[0.22, 0.4, 4, 8]} />
        <meshToonMaterial color="#2f5d8a" gradientMap={toonGradient()} />
      </mesh>
      {[-0.35, 0.35].map((x) => (
        <mesh key={x} position={[x, 1.25, 0.8]}>
          <boxGeometry args={[0.08, 2.5, 0.08]} />
          <meshToonMaterial color="#5c636a" gradientMap={toonGradient()} />
        </mesh>
      ))}
      <group ref={forks} position={[0, 0.15, 0.9]}>
        <mesh position={[0, 0.35, 0]}>
          <boxGeometry args={[0.9, 0.7, 0.06]} />
          <meshToonMaterial color="#3d4247" gradientMap={toonGradient()} />
        </mesh>
        {[-0.25, 0.25].map((x) => (
          <mesh key={x} position={[x, 0.03, 0.55]}>
            <boxGeometry args={[0.12, 0.05, 1.1]} />
            <meshToonMaterial color="#3d4247" gradientMap={toonGradient()} />
          </mesh>
        ))}
      </group>
      {[-0.55, 0.55].flatMap((x) =>
        [-0.7, 0.55].map((z) => (
          <mesh key={`w${x}${z}`} position={[x, 0.22, z]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.22, 0.22, 0.2, 10]} />
            <meshToonMaterial color="#25282b" gradientMap={toonGradient()} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** 手动液压搬运车 */
function Jack({ id, register }: { id: string; register: (id: string, g: THREE.Group | null, forks: THREE.Group | null) => void }) {
  return (
    <group ref={(g) => register(id, g, null)}>
      {[-0.28, 0.28].map((x) => (
        <mesh key={x} position={[x, 0.07, 0.35]}>
          <boxGeometry args={[0.16, 0.08, 1.15]} />
          <meshToonMaterial color="#c8433a" gradientMap={toonGradient()} />
        </mesh>
      ))}
      <mesh position={[0, 0.25, -0.3]}>
        <boxGeometry args={[0.6, 0.3, 0.25]} />
        <meshToonMaterial color="#c8433a" gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[0, 0.75, -0.55]} rotation={[0.5, 0, 0]}>
        <boxGeometry args={[0.05, 1.0, 0.05]} />
        <meshToonMaterial color="#2b2e31" gradientMap={toonGradient()} />
      </mesh>
    </group>
  );
}

/** 放货：货叉在前 60% 时间升到目标层，托盘放上去后停一下再降回 */
const UP_PLACE = 0.6;
/** 取货：空叉在前 40% 升上去，托起托盘后降到地面 */
const DOWN_PICK = 0.5;

function liftCurve(mode: 'up' | 'down', k: number): number {
  if (mode === 'up') return k < UP_PLACE ? k / UP_PLACE : k < 0.75 ? 1 : Math.max(0, 1 - (k - 0.75) / 0.25);
  return k < 0.4 ? k / 0.4 : k < DOWN_PICK ? 1 : Math.max(0, 1 - (k - DOWN_PICK) / (1 - DOWN_PICK));
}

/**
 * 后仓库存仓库与线上订单暂存仓：托盘货架、收货区、卸货平台；货架上的托盘按仿真时刻显示，
 * 叉车和搬运车沿轨迹移动并搬运托盘，放进高层时货叉举升。
 */
export function Warehouse() {
  const model = useApp((s) => s.simModel);
  const geo = useApp((s) => s.simGeo);
  const timeline = useApp((s) => s.timeline);
  const floor = useApp((s) => s.floor);
  const mode = useApp((s) => s.mode);
  const buildingView = useApp((s) => s.buildingView);
  const b = useMemo(() => backroomLayout(model.config), [model]);
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;

  const statics = useMemo<Box[]>(() => {
    const out: Box[] = [];
    // 托盘货架：立柱（每段两侧）与横梁（每层）
    for (const r of b.rows) {
      const depth = r.singleSided ? 1.2 : 2.4;
      for (let k = 0; k <= r.bays; k++) {
        const x = r.x0 + k * 2.7;
        for (const dz of [-depth / 2, depth / 2]) out.push({ x, y: 0, z: r.z + dz, w: 0.1, h: b.levels * 1.5 + 0.3, d: 0.1, color: '#2f5d8a' });
      }
      for (let l = 1; l <= b.levels; l++) {
        for (const dz of [-depth / 2, depth / 2]) out.push({ x: (r.x0 + r.x1) / 2, y: l * 1.5 - 0.12, z: r.z + dz, w: r.x1 - r.x0, h: 0.12, d: 0.08, color: '#e8a33d' });
      }
    }
    // 收货区地面（黄色区域）与卸货平台
    const rc = b.receiving;
    out.push({ x: (rc.x0 + rc.x1) / 2, y: 0.005, z: (rc.z0 + rc.z1) / 2, w: rc.x1 - rc.x0, h: 0.01, d: rc.z1 - rc.z0, color: '#efd98a' });
    for (const d of b.docks) out.push({ x: d.x, y: 0.005, z: d.z - 1.3, w: 3, h: 0.02, d: 2.4, color: '#5c636a' });
    // 叉车主通道标线
    out.push({ x: b.mainAisleX, y: 0.006, z: (b.zone.z0 + b.zone.z1) / 2, w: 0.12, h: 0.01, d: b.zone.z1 - b.zone.z0, color: '#f1c232' });
    // 线上订单暂存仓：地面着色与矮隔断
    if (geo.racks.length) {
      const xs = geo.racks.map((r) => r.x);
      const zs = geo.racks.map((r) => r.z);
      const x0 = Math.min(...xs) - 3;
      const x1 = Math.max(...xs) + 3;
      const z0 = Math.min(...zs) - 1.6;
      const z1 = Math.max(...zs) + 1.6;
      out.push({ x: (x0 + x1) / 2, y: 0.004, z: (z0 + z1) / 2, w: x1 - x0, h: 0.01, d: z1 - z0, color: '#dfe8f0' });
      out.push({ x: (x0 + x1) / 2, y: 0, z: z1, w: x1 - x0, h: 1.2, d: 0.08, color: '#c9d3dc' });
      out.push({ x: x1, y: 0, z: (z0 + z1) / 2, w: 0.08, h: 1.2, d: z1 - z0, color: '#c9d3dc' });
    }
    return out;
  }, [b, geo.racks]);

  const locById = useMemo(() => new Map(b.locations.map((l) => [l.id, l])), [b]);
  const pallets = timeline?.inbound.pallets ?? [];
  const equipment = timeline?.inbound.equipment ?? [];
  // 每个托盘被搬运的时间段（叉车或搬运车），以及在货位前举升 / 取下的时间段
  const { carries, lifts } = useMemo(() => {
    const m = new Map<string, Array<{ eq: EquipmentTrace; t0: number; t1: number }>>();
    const lifts = new Map<string, Array<{ eq: EquipmentTrace; t0: number; t1: number; mode: 'up' | 'down' }>>();
    for (const e of equipment) {
      for (const s of e.segments) {
        if (s.lift) {
          const list = lifts.get(s.lift.pallet) ?? [];
          list.push({ eq: e, t0: s.t0, t1: s.t1, mode: s.lift.mode });
          lifts.set(s.lift.pallet, list);
          continue;
        }
        if (!s.carry || s.carry === 'cases') continue;
        // 卸货后放到收货区：多停留一会儿，衔接到落地时刻
        const t1 = s.activity === '叉车放进货架' ? s.t1 : s.t1 + 12;
        const list = m.get(s.carry) ?? [];
        list.push({ eq: e, t0: s.t0, t1 });
        m.set(s.carry, list);
      }
    }
    return { carries: m, lifts };
  }, [equipment]);

  const groups = useRef(new Map<string, { g: THREE.Group | null; forks: THREE.Group | null }>());
  const register = (id: string, g: THREE.Group | null, forks: THREE.Group | null) => {
    const cur = groups.current.get(id) ?? { g: null, forks: null };
    if (g) cur.g = g;
    if (forks) cur.forks = forks;
    groups.current.set(id, cur);
  };
  const base = useRef<THREE.InstancedMesh>(null);
  const stack = useRef<THREE.InstancedMesh>(null);
  const pose = useMemo(() => makePolyPose(), []);
  const eqPose = useRef(new Map<string, { x: number; z: number; heading: number; forkY: number }>());
  const glowB = useNightGlow<THREE.MeshToonMaterial>(0.12);
  const glowS = useNightGlow<THREE.MeshToonMaterial>(0.12);

  useFrame(() => {
    const t = clock.time;
    // 叉车与搬运车
    for (const e of equipment) {
      const ref = groups.current.get(e.id);
      if (!ref?.g) continue;
      const ok = polyPose(e.segments, t, pose);
      const last = eqPose.current.get(e.id);
      let x = last?.x ?? b.receiving.x0 + 1;
      let z = last?.z ?? b.receiving.z0 + 1;
      let heading = last?.heading ?? Math.PI;
      let forkY = 0.15;
      let back = 0;
      if (ok) {
        x = pose.x;
        z = pose.z;
        heading = pose.heading;
        // 在货位前举升：放货时货叉升到目标层、放下托盘后降回；取货时空叉升上去、托着托盘降到地面
        const lf = pose.gapAfter ? pose.gapAfter.lift : pose.seg?.lift;
        if (lf && !pose.gapAfter) forkY = 0.15 + lf.y * liftCurve(lf.mode, pose.k);
        // 取下高层托盘：一边降叉一边倒车，把托盘放在货位前的地面上
        if (lf?.mode === 'down') back = LETDOWN_DIST * (pose.gapAfter ? 1 : Math.max(0, (pose.k - DOWN_PICK) / (1 - DOWN_PICK)));
      }
      // 车身停在货位前（不压在货架上）：搬运时车头朝向前进方向
      const off = (e.kind === 'forklift' ? 1.5 : 0.8) + back;
      ref.g.position.set(x - Math.sin(heading) * off, 0, z - Math.cos(heading) * off);
      ref.g.rotation.set(0, heading, 0);
      if (ref.forks) ref.forks.position.y = forkY;
      eqPose.current.set(e.id, { x, z, heading, forkY });
    }
    // 托盘
    const bm = base.current;
    const sm = stack.current;
    if (!bm || !sm) return;
    let n = 0;
    for (const p of pallets as PalletRecord[]) {
      if (n >= bm.instanceMatrix.count) break;
      let px: number | undefined;
      let py = 0;
      let pz: number | undefined;
      let rot = 0;
      const lift = lifts.get(p.id)?.find((c) => t >= c.t0 && t < c.t1);
      const liftLoc = lift && p.location ? locById.get(p.location) : undefined;
      const carry = lift ? undefined : carries.get(p.id)?.find((c) => t >= c.t0 && t < c.t1);
      if (lift && liftLoc) {
        const k = (t - lift.t0) / Math.max(1e-6, lift.t1 - lift.t0);
        const ep = eqPose.current.get(lift.eq.id);
        px = liftLoc.x;
        pz = liftLoc.z;
        if (lift.mode === 'up') {
          py = k < UP_PLACE ? (ep?.forkY ?? 0.15) + 0.05 : liftLoc.y + 0.02;
        } else if (k < DOWN_PICK) py = liftLoc.y + 0.02;
        else {
          const d = (k - DOWN_PICK) / (1 - DOWN_PICK);
          py = (ep?.forkY ?? 0.15) + 0.05;
          pz = liftLoc.z + liftLoc.side * LETDOWN_DIST * d;
        }
      } else if (carry) {
        const ep = eqPose.current.get(carry.eq.id);
        if (ep) {
          px = ep.x;
          pz = ep.z;
          py = ep.forkY + 0.05;
          rot = ep.heading;
        }
      } else if (p.emptiedAt !== undefined && t >= p.emptiedAt) continue;
      else if (p.location && p.storedAt !== undefined && t >= p.storedAt) {
        const l = locById.get(p.location);
        if (!l) continue;
        if (p.letdownAt !== undefined && t >= p.letdownAt) {
          px = l.x;
          pz = floorSpotFor(l).z;
        } else {
          px = l.x;
          pz = l.z;
          py = l.y + 0.02;
        }
      } else if (p.spot && p.receivedAt !== undefined && t >= p.receivedAt) {
        px = p.spot.x;
        pz = p.spot.z;
      }
      if (px === undefined || pz === undefined) continue;
      tmp.position.set(px, py + 0.07, pz);
      tmp.rotation.set(0, rot, 0);
      tmp.scale.set(1.1, 0.14, 1.1);
      tmp.updateMatrix();
      bm.setMatrixAt(n, tmp.matrix);
      let left = p.initialCases;
      for (const [dt, n] of p.draws) if (dt <= t) left -= n;
      const h = 0.15 + Math.min(1.2, Math.max(0, left) / 50) * 0.9;
      tmp.position.set(px, py + 0.14 + h / 2, pz);
      tmp.scale.set(1.0, h, 1.0);
      tmp.updateMatrix();
      sm.setMatrixAt(n, tmp.matrix);
      sm.setColorAt(n, col.set(CARTON[p.runId.length % CARTON.length] as string));
      n++;
    }
    for (let i = n; i < Math.min(bm.count, n + 4); i++) {
      bm.setMatrixAt(i, HIDDEN);
      sm.setMatrixAt(i, HIDDEN);
    }
    bm.count = n;
    sm.count = n;
    bm.instanceMatrix.needsUpdate = true;
    sm.instanceMatrix.needsUpdate = true;
    if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
  });

  if (!visible) return null;
  const cap = Math.max(1, pallets.length);
  const showLabels = mode === 'sim' && buildingView !== 'exterior';
  return (
    <group>
      <StaticBoxes items={statics} />
      <instancedMesh key={`b${cap}`} ref={base} args={[undefined, undefined, cap]} frustumCulled={false} castShadow>
        <boxGeometry />
        <meshToonMaterial ref={glowB} color="#a07a52" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh key={`s${cap}`} ref={stack} args={[undefined, undefined, cap]} frustumCulled={false} castShadow>
        <boxGeometry />
        <meshToonMaterial ref={glowS} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      {equipment.map((e) => (e.kind === 'forklift' ? <Forklift key={e.id} id={e.id} register={register} /> : <Jack key={e.id} id={e.id} register={register} />))}
      {showLabels && (
        <>
          <Html position={[(b.zone.x0 + b.zone.x1) / 2, 4.6, (b.zone.z0 + b.zone.z1) / 2]} center className="scene-label area-label warehouse-label">
            {t('库存仓库 · {0} 个托盘位', b.capacity)}
          </Html>
          <Html position={[(b.receiving.x0 + b.receiving.x1) / 2, 2.4, (b.receiving.z0 + b.receiving.z1) / 2]} center className="scene-label area-label">
            {t('收货区')}
          </Html>
        </>
      )}
    </group>
  );
}
