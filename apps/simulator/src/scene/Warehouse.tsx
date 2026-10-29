import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { backroomLayout, floorSpotFor, LETDOWN_DIST } from '@storewright/store-config';
import type { EquipmentTrace, PalletRecord } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { makePolyPose, polyPose } from './polyTrace';
import { toonGradient } from './toon';
import { useNightGlow } from './environment';

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

interface EquipRefs {
  g: THREE.Group | null;
  forks: THREE.Group | null;
  /** 门架（含货叉）：行驶时载货后倾 */
  mast: THREE.Group | null;
  beacon: THREE.MeshBasicMaterial | null;
  /** 地面上的蓝色警示光斑（行驶方向前方） */
  spot: THREE.Mesh | null;
}
type Register = (id: string, part: Partial<EquipRefs>) => void;

const tg = () => toonGradient();

/**
 * 平衡重式叉车（室内常见的液化气款，按公开的常见外形）：圆角车身与后部配重、四柱护顶架、座椅与司机、方向盘、
 * 后部卧放的液化气瓶、门架（两根立柱、横梁、倾斜油缸）、货叉架与 L 形货叉、前大后小的实心轮胎；
 * 护顶架上的琥珀色警示灯、行驶时投在前方地面的蓝色光斑。举升高度、门架后倾和灯光由每帧更新。
 */
function Forklift({ id, register }: { id: string; register: Register }) {
  return (
    <group ref={(g) => register(id, { g })}>
      {/* 车身与配重 */}
      <mesh position={[0, 0.62, -0.05]} castShadow>
        <boxGeometry args={[1.12, 0.62, 1.55]} />
        <meshToonMaterial color="#e8a33d" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 0.98, 0.25]} castShadow>
        <boxGeometry args={[1.05, 0.12, 0.7]} />
        <meshToonMaterial color="#e8a33d" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 0.72, -0.92]} castShadow>
        <cylinderGeometry args={[0.42, 0.42, 1.12, 18, 1, false, 0, Math.PI]} />
        <meshToonMaterial color="#3d4247" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 0.72, -0.86]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <boxGeometry args={[0.84, 1.12, 0.14]} />
        <meshToonMaterial color="#3d4247" gradientMap={tg()} />
      </mesh>
      {/* 液化气瓶（卧放在配重上） */}
      <mesh position={[0, 1.34, -0.95]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.17, 0.17, 0.82, 14]} />
        <meshToonMaterial color="#e9ecef" gradientMap={tg()} />
      </mesh>
      {/* 护顶架：四根立柱 + 顶棚格栅 */}
      {[-0.5, 0.5].flatMap((x) =>
        [-0.62, 0.42].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 1.55, z]} rotation={[z > 0 ? -0.08 : 0, 0, 0]}>
            <boxGeometry args={[0.07, 1.15, 0.07]} />
            <meshToonMaterial color="#2b2e31" gradientMap={tg()} />
          </mesh>
        )),
      )}
      <mesh position={[0, 2.13, -0.12]}>
        <boxGeometry args={[1.1, 0.05, 1.18]} />
        <meshToonMaterial color="#2b2e31" gradientMap={tg()} />
      </mesh>
      {[-0.3, 0, 0.3].map((x) => (
        <mesh key={x} position={[x, 2.16, -0.12]}>
          <boxGeometry args={[0.05, 0.03, 1.15]} />
          <meshToonMaterial color="#2b2e31" gradientMap={tg()} />
        </mesh>
      ))}
      {/* 警示灯 */}
      <mesh position={[0.38, 2.24, -0.6]}>
        <cylinderGeometry args={[0.07, 0.08, 0.13, 10]} />
        <meshBasicMaterial ref={(m) => register(id, { beacon: m })} color="#ffb11a" toneMapped={false} />
      </mesh>
      {/* 座椅、司机、方向盘 */}
      <mesh position={[0, 1.08, -0.35]}>
        <boxGeometry args={[0.5, 0.12, 0.45]} />
        <meshToonMaterial color="#25282b" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 1.36, -0.53]} rotation={[-0.15, 0, 0]}>
        <boxGeometry args={[0.48, 0.5, 0.1]} />
        <meshToonMaterial color="#25282b" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 1.42, -0.3]}>
        <capsuleGeometry args={[0.21, 0.36, 4, 10]} />
        <meshToonMaterial color="#2f5d8a" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 1.83, -0.28]}>
        <sphereGeometry args={[0.13, 12, 10]} />
        <meshToonMaterial color="#e0b48a" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 1.25, 0.12]} rotation={[-0.9, 0, 0]}>
        <torusGeometry args={[0.15, 0.02, 6, 16]} />
        <meshToonMaterial color="#25282b" gradientMap={tg()} />
      </mesh>
      {/* 门架：以前轮轴为支点后倾；立柱、横梁、倾斜油缸，货叉架在里面上下 */}
      <group ref={(g) => register(id, { mast: g })} position={[0, 0.28, 0.82]}>
        {[-0.36, 0.36].map((x) => (
          <mesh key={x} position={[x, 1.08, 0]} castShadow>
            <boxGeometry args={[0.09, 2.3, 0.12]} />
            <meshToonMaterial color="#5c636a" gradientMap={tg()} />
          </mesh>
        ))}
        <mesh position={[0, 2.18, 0]}>
          <boxGeometry args={[0.82, 0.08, 0.1]} />
          <meshToonMaterial color="#5c636a" gradientMap={tg()} />
        </mesh>
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[0.82, 0.08, 0.1]} />
          <meshToonMaterial color="#5c636a" gradientMap={tg()} />
        </mesh>
        {[-0.45, 0.45].map((x) => (
          <mesh key={`c${x}`} position={[x, 0.75, -0.3]} rotation={[0.75, 0, 0]}>
            <cylinderGeometry args={[0.035, 0.035, 0.75, 8]} />
            <meshToonMaterial color="#c7ccd1" gradientMap={tg()} />
          </mesh>
        ))}
        <group ref={(g) => register(id, { forks: g })} position={[0, -0.13, 0.08]}>
          <mesh position={[0, 0.38, 0]}>
            <boxGeometry args={[0.92, 0.6, 0.06]} />
            <meshToonMaterial color="#3d4247" gradientMap={tg()} />
          </mesh>
          {[-0.25, 0.25].map((x) => (
            <group key={x}>
              <mesh position={[x, 0.32, 0.04]}>
                <boxGeometry args={[0.12, 0.62, 0.05]} />
                <meshToonMaterial color="#3d4247" gradientMap={tg()} />
              </mesh>
              <mesh position={[x, 0.03, 0.58]}>
                <boxGeometry args={[0.12, 0.05, 1.1]} />
                <meshToonMaterial color="#3d4247" gradientMap={tg()} />
              </mesh>
            </group>
          ))}
        </group>
      </group>
      {/* 实心轮胎：前轮大（驱动）、后轮小（转向） */}
      {[-0.5, 0.5].flatMap((x) =>
        (
          [
            [0.62, 0.3],
            [-0.68, 0.23],
          ] as const
        ).map(([z, r]) => (
          <mesh key={`w${x}${z}`} position={[x, r, z]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[r, r, 0.24, 14]} />
            <meshToonMaterial color="#25282b" gradientMap={tg()} />
          </mesh>
        )),
      )}
      {/* 蓝色警示光斑：行驶方向前方 3 米的地面上 */}
      <mesh ref={(m) => register(id, { spot: m })} position={[0, 0.03, 3.2]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <circleGeometry args={[0.32, 18]} />
        <meshBasicMaterial color="#3d8bff" transparent opacity={0.85} toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** 手动液压搬运车：两根货叉、承载轮、液压泵和手柄 */
function Jack({ id, register }: { id: string; register: Register }) {
  return (
    <group ref={(g) => register(id, { g })}>
      {[-0.28, 0.28].map((x) => (
        <mesh key={x} position={[x, 0.07, 0.35]}>
          <boxGeometry args={[0.16, 0.08, 1.15]} />
          <meshToonMaterial color="#c8433a" gradientMap={tg()} />
        </mesh>
      ))}
      <mesh position={[0, 0.25, -0.3]}>
        <boxGeometry args={[0.6, 0.3, 0.25]} />
        <meshToonMaterial color="#c8433a" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 0.42, -0.3]}>
        <cylinderGeometry args={[0.07, 0.07, 0.25, 10]} />
        <meshToonMaterial color="#c7ccd1" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 0.85, -0.55]} rotation={[0.5, 0, 0]}>
        <boxGeometry args={[0.05, 1.0, 0.05]} />
        <meshToonMaterial color="#2b2e31" gradientMap={tg()} />
      </mesh>
      <mesh position={[0, 1.27, -0.79]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.03, 0.03, 0.32, 8]} />
        <meshToonMaterial color="#2b2e31" gradientMap={tg()} />
      </mesh>
      {[-0.12, 0.12].map((x) => (
        <mesh key={`w${x}`} position={[x, 0.09, -0.32]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.09, 0.09, 0.07, 10]} />
          <meshToonMaterial color="#25282b" gradientMap={tg()} />
        </mesh>
      ))}
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
    // 卸货平台（收货区、暂存区的地面由区域图层画）
    for (const d of b.docks) out.push({ x: d.x, y: 0.005, z: d.z - 1.3, w: 3, h: 0.02, d: 2.4, color: '#5c636a' });
    // 叉车主通道标线
    out.push({ x: b.mainAisleX, y: 0.006, z: (b.zone.z0 + b.zone.z1) / 2, w: 0.12, h: 0.01, d: b.zone.z1 - b.zone.z0, color: '#f1c232' });
    // 线上订单暂存区的矮隔断（沿暂存区域的后边和外侧）
    for (const a of geo.areas) {
      if (a.kind !== 'STAGING' && a.kind !== 'STAGING_DELIVERY') continue;
      out.push({ x: (a.x0 + a.x1) / 2, y: 0, z: a.z1 + 0.6, w: a.x1 - a.x0 + 1.2, h: 1.2, d: 0.08, color: '#c9d3dc' });
      out.push({ x: a.x1 + 0.6, y: 0, z: (a.z0 + a.z1) / 2, w: 0.08, h: 1.2, d: a.z1 - a.z0 + 1.2, color: '#c9d3dc' });
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

  const groups = useRef(new Map<string, EquipRefs>());
  const register: Register = (id, part) => {
    const cur = groups.current.get(id) ?? { g: null, forks: null, mast: null, beacon: null, spot: null };
    for (const [k, v] of Object.entries(part)) if (v) (cur as unknown as Record<string, unknown>)[k] = v;
    groups.current.set(id, cur);
  };
  /** 主通道靠右行驶的横向偏移（每台设备平滑过渡） */
  const lateral = useRef(new Map<string, number>());
  const base = useRef<THREE.InstancedMesh>(null);
  const stack = useRef<THREE.InstancedMesh>(null);
  const pose = useMemo(() => makePolyPose(), []);
  const eqPose = useRef(new Map<string, { x: number; z: number; y: number; heading: number; forkY: number }>());
  const glowB = useNightGlow<THREE.MeshToonMaterial>(0.12);
  const glowS = useNightGlow<THREE.MeshToonMaterial>(0.12);

  useFrame((_, delta) => {
    const t = clock.time;
    const blink = Math.floor(performance.now() / 420) % 2 === 0;
    // 叉车与搬运车：起步加速、刹车减速（不是匀速平移），拐角处车头逐渐转过去
    for (const e of equipment) {
      const ref = groups.current.get(e.id);
      if (!ref?.g) continue;
      const ok = polyPose(e.segments, t, pose, { ease: e.kind === 'forklift' ? 1.4 : 0.8, corner: e.kind === 'forklift' ? 1.1 : 0.6 });
      const last = eqPose.current.get(e.id);
      let x = last?.x ?? b.receiving.x0 + 1;
      let z = last?.z ?? b.receiving.z0 + 1;
      let heading = last?.heading ?? Math.PI;
      // 所在楼层的高度（搬运车乘货梯上二楼时随轿厢升上去，决策记录 0019）
      let fy = last?.y ?? 0;
      let forkY = 0.15;
      let back = 0;
      let moving = false;
      let reversing = false;
      let loaded = false;
      if (ok) {
        x = pose.x;
        z = pose.z;
        fy = pose.y;
        heading = pose.heading;
        moving = pose.moving;
        loaded = !!pose.carry && pose.carry !== 'cases';
        const seg = pose.gapAfter ? undefined : pose.seg;
        if (seg?.reverseLegs && moving) {
          const p1 = seg.pts[1];
          const p0 = seg.pts[0];
          reversing = !!p0 && !!p1 && Math.cos(Math.atan2(p1.x - p0.x, p1.z - p0.z) - heading) < 0;
        }
        // 在货位前举升：放货时货叉升到目标层、放下托盘后降回；取货时空叉升上去、托着托盘降到地面
        const lf = pose.gapAfter ? pose.gapAfter.lift : pose.seg?.lift;
        if (lf && !pose.gapAfter) forkY = 0.15 + lf.y * liftCurve(lf.mode, pose.k);
        // 取下高层托盘：一边降叉一边倒车，把托盘放在货位前的地面上
        if (lf?.mode === 'down') back = LETDOWN_DIST * (pose.gapAfter ? 1 : Math.max(0, (pose.k - DOWN_PICK) / (1 - DOWN_PICK)));
      }
      // 主通道上靠右行驶（双向通行）：沿主通道纵向行驶时向自己的右侧让 0.55 米，进出主通道时逐渐过渡
      const alongMain = moving && Math.abs(x - b.mainAisleX) < 0.4 && Math.abs(Math.cos(heading)) > 0.9;
      const curLat = lateral.current.get(e.id) ?? 0;
      const nextLat = curLat + ((alongMain ? (reversing ? -0.55 : 0.55) : 0) - curLat) * Math.min(1, delta * 3);
      lateral.current.set(e.id, nextLat);
      x += -Math.cos(heading) * nextLat;
      z += Math.sin(heading) * nextLat;
      // 车身停在货位前（不压在货架上）：搬运时车头朝向前进方向
      const off = (e.kind === 'forklift' ? 1.5 : 0.8) + back;
      ref.g.position.set(x - Math.sin(heading) * off, fy, z - Math.cos(heading) * off);
      ref.g.rotation.set(0, heading, 0);
      if (ref.forks) ref.forks.position.y = forkY - 0.15 - 0.13;
      // 门架：载货行驶时后倾 4°，举升放货时竖直
      if (ref.mast) ref.mast.rotation.x = THREE.MathUtils.lerp(ref.mast.rotation.x, loaded && moving && forkY < 0.4 ? -0.07 : 0, Math.min(1, delta * 4));
      // 行驶时警示灯闪烁、蓝色光斑投在行驶方向前方（倒车时在后方）
      if (ref.beacon) ref.beacon.color.set(moving && blink ? '#ffcc44' : '#7a5a1a');
      if (ref.spot) {
        ref.spot.visible = moving;
        ref.spot.position.z = reversing ? -3.2 : 3.6;
      }
      eqPose.current.set(e.id, { x, z, y: fy, heading, forkY });
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
          py = ep.y + ep.forkY + 0.05;
          rot = ep.heading;
        }
      } else if (p.emptiedAt !== undefined && t >= p.emptiedAt) continue;
      else if (p.upSpot && p.upAt !== undefined && t >= p.upAt) {
        // 二楼补货区（货梯送上去的托盘）
        px = p.upSpot.x;
        pz = p.upSpot.z;
        py = p.upSpot.y;
      } else if (p.overflowSpot && p.overflowAt !== undefined && t >= p.overflowAt) {
        // 暂存区的溢流位（经连通通道送过去的托盘）
        px = p.overflowSpot.x;
        pz = p.overflowSpot.z;
      }
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
    </group>
  );
}
