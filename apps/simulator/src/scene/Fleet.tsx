import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { congestionAt, DEFAULT_TRAFFIC } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { carState } from './motion';
import { carSpotIndex, entryPath, exitPaths, type ParkingSpot, type PathLike, type TimedPath } from './lot';
import { stayAt, type Stay } from './shoppers';
import { backInPaths, forwardExitPath, LONG_MERGE, LONG_SPOTS, longBays, longPaths, pullThroughPath, TowRig, type LongKind } from './parking';
import { planServiceVisits } from './service';
import { backroomLayout } from '@storewright/store-config';
import { emergencyPaths } from './evacuation';
import { customerEntrance } from './crowd';
import { trafficFor, type Obstacle } from './traffic';
import { useSiteLayout, useStays } from './useSite';
import { carColor, carType, HITCH, LAMP_LAYOUT, rvColor, SEMI, TOW, TOW_KINDS, towGeometry, TRAILER_LAMP, TRAILER_WHEELS, trailerGeometry, vehicleGeometry, VEHICLE_LENGTH, VEHICLE_TYPES, WHEEL_LAYOUT, wheelGeometry, type TowKind, type TrailerKind, type VehicleType, type WheelSpec } from './vehicles';
import { type RigPose } from './rig';
import { laneDrive, lanePose, QueueMotion, queueTargets, yardRoute } from './yard';
import { guardStopping, railClosed, trainsFor } from './crossings';
import { framePositions } from './Actors';
import { cartTrain } from './CartAttendants';
import { toonGradient } from './toon';
import { armMenu } from './contextTarget';
import { env } from './environment';
import { radialTexture } from './Surroundings';
import { setBayStatus, type BayState } from './street/BayLamps';

const CAP = 220;
/** 每种车型的实例上限（半挂车：到货和路上过境的长途车；房车：路过的和停车场里的） */
const capFor = (t: VehicleType) => (t === 'semi' ? 24 : t === 'rv' ? 16 : CAP);
const TRAILER_CAP = 24;
const TOW_CAP = 10;
const tmp = new THREE.Object3D();
const child = new THREE.Object3D();
const m4 = new THREE.Matrix4();
const color = new THREE.Color();
const HEAD = new THREE.Color('#fff4d6');
const TAIL = new THREE.Color('#ff3326');
const GLOW_CAP = 1800;
const SIREN_CAP = 16;
const ROOF_Y: Partial<Record<VehicleType, number>> = { sedan: 1.6, truck: 2.75, suv: 2.0 };
const BEAM_CAP = 450;
const WHEEL_CAP = 2600;
const TRUCK_WHEEL_CAP = 900;
const LAMP_CAP = 1400;
const pose = { x: 0, z: 0, heading: 0, speed: 0, accel: 0, steer: 0, dist: 0 };
const rig: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, accel: 0, steer: 0, dist: 0 };
const BRAKE = new THREE.Color('#ff1f1a');
const REVERSE = new THREE.Color('#fbfbf4');
const AMBER = new THREE.Color('#ffb11a');
const TRAILER_KINDS: TrailerKind[] = ['dry', 'reefer'];

/** 车辆的运动状态：车轮转动、前轮转角、刹车灯、倒车灯、转向灯 / 双闪，以及车身姿态用的纵向、侧向加速度 */
interface Motion {
  dist: number;
  steer: number;
  braking: boolean;
  reversing: boolean;
  turning: boolean;
  hazard: boolean;
  accel: number;
  lat: number;
}
const STILL: Motion = { dist: 0, steer: 0, braking: false, reversing: false, turning: false, hazard: false, accel: 0, lat: 0 };
function motionOf(p: { speed?: number; accel?: number; steer?: number; dist?: number; lat?: number }, reversing = false, hazard = false): Motion {
  const steer = p.steer ?? 0;
  return { dist: p.dist ?? 0, steer, braking: (p.accel ?? 0) < -0.25 || (p.speed ?? 0) < 0.15, reversing, turning: Math.abs(steer) > 0.12, hazard, accel: p.accel ?? 0, lat: p.lat ?? 0 };
}

/**
 * 车身姿态（决策记录 0018）：刹车时车头下沉、加速时车尾下坐（俯仰），转弯时车身向弯外侧倾；
 * 只转动车身（绕侧倾中心），车轮仍贴着地面。系数按车型：越高、越软的车倾得越多。
 */
const BODY: Record<VehicleType, { pitch: number; roll: number; h: number }> = {
  sedan: { pitch: 0.008, roll: 0.012, h: 0.45 },
  hatch: { pitch: 0.008, roll: 0.013, h: 0.45 },
  suv: { pitch: 0.009, roll: 0.016, h: 0.55 },
  pickup: { pitch: 0.009, roll: 0.016, h: 0.6 },
  van: { pitch: 0.01, roll: 0.019, h: 0.6 },
  truck: { pitch: 0.01, roll: 0.02, h: 0.8 },
  semi: { pitch: 0.006, roll: 0.014, h: 1.0 },
  rv: { pitch: 0.01, roll: 0.022, h: 0.8 },
};
const bodyMat = new THREE.Matrix4();
const pivotM = new THREE.Matrix4();
const rotM = new THREE.Matrix4();
const unpivotM = new THREE.Matrix4();
const euler = new THREE.Euler();
const clampA = (v: number, a: number) => Math.max(-a, Math.min(a, v));
/** 在车辆的基准矩阵（位置 + 航向）上叠加俯仰和侧倾 */
function posture(base: THREE.Matrix4, k: { pitch: number; roll: number; h: number }, mo: Motion): THREE.Matrix4 {
  const pitch = clampA(-(mo.reversing ? -1 : 1) * mo.accel * k.pitch, 0.035);
  const roll = clampA(mo.lat * k.roll, 0.05);
  if (Math.abs(pitch) < 1e-4 && Math.abs(roll) < 1e-4) return bodyMat.copy(base);
  euler.set(pitch, 0, roll, 'XZY');
  rotM.makeRotationFromEuler(euler);
  pivotM.makeTranslation(0, k.h, 0);
  unpivotM.makeTranslation(0, -k.h, 0);
  return bodyMat.copy(base).multiply(pivotM).multiply(rotM).multiply(unpivotM);
}

const RING_COLOR: Record<string, string> = {
  arriving: '#9fb3c4',
  waiting: '#5aa9e6',
  longWait: '#e5484d',
  serving: '#3fa36b',
  leaving: '#9fb3c4',
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/**
 * 画面加速系数：背景车流最多按 8 倍速运行（再快就看不清了），
 * 取货车辆的驶入、驶出动画也按同样的比例拉长，避免高倍速下「瞬移」。
 */
function visualFactor(): number {
  return Math.min(12, Math.max(1, clock.speed / 8));
}

/** 长车的路线：车辆参考点（车身中心）的驶入、驶离路径，停放位置；带拖车时还有挂钩位置和两段拖车航向 */
interface LongRoute {
  entry: TimedPath;
  exit: PathLike;
  parked: { x: number; z: number; heading: number };
  tow?: { hitch: number; axle: number };
  enterRig?: TowRig;
  exitRig?: TowRig;
}

interface Batch {
  paint: THREE.InstancedMesh | null;
  detail: THREE.InstancedMesh | null;
  n: number;
  owners: string[];
}

/** 所有车辆：路上的背景车流、到店购物的私家车、线上取货顾客和配送司机 */
export function Vehicles({ trafficOnly = false }: { trafficOnly?: boolean } = {}) {
  const site = useSiteLayout();
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  const timeline = useApp((s) => s.timeline);
  const floor = useApp((s) => s.floor);
  const siteSeed = useApp((s) => s.site.seed);
  const level = useApp((s) => s.site.traffic);
  const batches = useRef<Record<VehicleType, Batch>>(Object.fromEntries(VEHICLE_TYPES.map((t) => [t, { paint: null, detail: null, n: 0, owners: [] }])) as unknown as Record<VehicleType, Batch>);
  const ringRef = useRef<THREE.InstancedMesh>(null);
  const glowRef = useRef<THREE.InstancedMesh>(null);
  const beamRef = useRef<THREE.InstancedMesh>(null);
  const beamMat = useRef<THREE.MeshBasicMaterial>(null);
  const beamTex = useMemo(() => radialTexture('#fff3cf'), []);
  const sirenRef = useRef<THREE.InstancedMesh>(null);
  const wheelRef = useRef<THREE.InstancedMesh>(null);
  const truckWheelRef = useRef<THREE.InstancedMesh>(null);
  const lampRef = useRef<THREE.InstancedMesh>(null);
  const trailers = useRef<Record<TrailerKind, Batch>>({ dry: { paint: null, detail: null, n: 0, owners: [] }, reefer: { paint: null, detail: null, n: 0, owners: [] } });
  const towBatches = useRef<Record<TowKind, Batch>>(Object.fromEntries(TOW_KINDS.map((k) => [k, { paint: null, detail: null, n: 0, owners: [] }])) as unknown as Record<TowKind, Batch>);
  const lot = geo.lot;
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;
  const longWait = model.config.rules.handoff.longWaitMin * 60;
  const profile = timeline?.traffic.profile.length ? timeline.traffic : { level, profile: DEFAULT_TRAFFIC.profile };

  const stays = useStays();

  // 汽车快修中心的车辆动线
  const visits = useMemo(
    () =>
      (timeline?.autoService ?? []).flatMap((a) => {
        const fac = geo.facilities.find((f) => f.id === a.facilityId);
        return fac ? planServiceVisits(fac, lot, site.road, a.jobs) : [];
      }),
    [timeline, geo.facilities, lot, site],
  );

  // 路径缓存：车位 × 方向
  const bays = useMemo(() => longBays(lot), [lot]);
  const paths = useMemo(() => {
    const cache = new Map<string, PathLike | [TimedPath, TimedPath] | [TimedPath, PathLike]>();
    const longCache = new Map<string, LongRoute>();
    return {
      /** 倒车入位：[开到倒车起点, 倒进车位] */
      backIn(spot: ParkingSpot, idx: number, fromLeft: boolean): [TimedPath, TimedPath] {
        const k = `b${idx}${fromLeft ? 'L' : 'R'}`;
        let p = cache.get(k) as [TimedPath, TimedPath] | undefined;
        if (!p) cache.set(k, (p = backInPaths(lot, site.road, spot, fromLeft)));
        return p;
      },
      /** 穿过对面的空车位停进来 */
      through(spot: ParkingSpot, idx: number, fromLeft: boolean): TimedPath {
        const k = `t${idx}${fromLeft ? 'L' : 'R'}`;
        let p = cache.get(k) as TimedPath | undefined;
        if (!p) cache.set(k, (p = pullThroughPath(lot, site.road, spot, fromLeft)));
        return p;
      },
      /** 车头朝外的车直接开出 */
      forward(spot: ParkingSpot, idx: number, toLeft: boolean): PathLike {
        const k = `f${idx}${toLeft ? 'L' : 'R'}`;
        let p = cache.get(k) as PathLike | undefined;
        if (!p) cache.set(k, (p = forwardExitPath(lot, site.road, spot, toLeft)));
        return p;
      },
      /** 房车 / 带拖车的车：驶入长车位、驶离；拖车按挂钩运动学跟随 */
      long(bi: number, kind: LongKind, type: VehicleType, fromLeft: boolean, toLeft: boolean): LongRoute | undefined {
        const bay = bays[bi];
        if (!bay) return undefined;
        const k = `${bi}${kind}${type}${fromLeft ? 'L' : 'R'}${toLeft ? 'L' : 'R'}`;
        let r = longCache.get(k);
        if (!r) {
          const front = VEHICLE_LENGTH[type] / 2;
          const p = longPaths(lot, site.road, bay, front, LONG_SPOTS[kind], fromLeft, toLeft, LONG_MERGE[kind]);
          const tow = kind === 'rv' ? undefined : { hitch: -(HITCH[type]?.z ?? -VEHICLE_LENGTH[type] / 2), axle: TOW[kind as TowKind].axle };
          const enter = tow ? new TowRig(p.entry, tow.hitch, tow.axle) : undefined;
          r = { ...p, tow, enterRig: enter, exitRig: tow ? new TowRig(p.exit, tow.hitch, tow.axle, enter?.end()) : undefined };
          longCache.set(k, r);
        }
        return r;
      },
      entry(spot: ParkingSpot, idx: number, fromLeft: boolean): TimedPath {
        const k = `e${idx}${fromLeft ? 'L' : 'R'}`;
        let p = cache.get(k) as TimedPath | undefined;
        if (!p) cache.set(k, (p = entryPath(lot, site.road, spot, fromLeft)));
        return p;
      },
      exit(spot: ParkingSpot, idx: number, toLeft: boolean): [TimedPath, PathLike] {
        const k = `x${idx}${toLeft ? 'L' : 'R'}`;
        let p = cache.get(k) as [TimedPath, PathLike] | undefined;
        if (!p) cache.set(k, (p = exitPaths(lot, site.road, spot, toLeft)));
        return p;
      },
    };
  }, [lot, site]);

  // 到货车辆（决策记录 0018）：配送中心半挂车（常温、冷藏）、供应商整车直送半挂车与供应商厢式货车。
  // 动线：主路 → 后勤通道 → 卸货场待命车道排队 → 轮到时绕到靠台车道、驶过卸货门车头外摆、司机下车开挂车门、
  // 从司机一侧倒车靠台 → 卸货 → 笔直拉出 → 绕场一圈驶离。场地里同一时间只有一辆车行驶（仿真的卸货场调度）。
  const docks = useMemo(() => {
    const f0 = geo.floors[0];
    if (!f0) return [];
    const doors = backroomLayout(model.config).docks;
    const trucks = timeline?.inbound.trucks ?? [];
    const road = { ...site.road, roadEdgeZ: lot.edgeZ, roadTopZ: site.roadTopZ, street: site.access.via === 'STREET' ? { x: site.access.x, half: site.access.half } : undefined };
    return trucks.map((d, i) => {
      const semi = d.kind === 'SEMI' || d.kind === 'REEFER';
      const vehicle = semi ? 'semi' : d.kind === 'VAN' ? 'van' : 'truck';
      const doorX = (doors[d.door] ?? doors[0])?.x ?? f0.maxX - 10;
      // 经支路进出时在路口等灯：按编号一半车碰上红灯（等 15–45 秒），驶出时同样
      const h = hash(d.id);
      const waitIn = (h & 1) === 0 ? 15 + (h % 31) : 0;
      const waitOut = (h & 2) === 0 ? 15 + ((h >> 3) % 31) : 2;
      const route = yardRoute(site.yard, road, doorX, vehicle, i % 2 === 0, i % 3 !== 0, waitIn, waitOut);
      // 从后勤通道开进来时带着车速
      const q = new QueueMotion(d.arrive, Math.max(d.arrive, d.dockAt), queueTargets(trucks, i, route.slotS, site.yard.slots), semi ? 3.2 : 4, semi ? 0.5 : 0.9, semi ? 0.8 : 1.4, semi ? 3.2 : 4);
      const qe = q.end();
      lanePose(route, qe.s, rig);
      const drive = laneDrive(route, qe.s, qe.v, rig.trailer);
      const backDur = route.back.rig?.duration ?? route.back.path?.duration ?? 0;
      // 进场的时间窗里多出来的时间：停在倒车起点，司机下车打开挂车后门、观察
      const pause = Math.max(semi ? 20 : 8, Math.min(semi ? 75 : 30, d.dockedAt - d.dockAt - drive.path.duration - backDur));
      // 车头颜色：配送中心常温车红色、百货车深青、冷藏车蓝色、供应商整车绿色；厢式货车按编号轮换
      const color = semi ? (d.kind === 'REEFER' ? '#2f6fb5' : d.vendor ? '#3f8f5a' : d.source === 'DC_GM' ? '#2f6f8f' : '#c8433a') : (['#e0a42f', '#3f8f5a', '#7a4fa0', '#d0573a', '#2f8f8f'][i % 5] as string);
      const trailerPaint = d.kind === 'REEFER' ? '#eef3f7' : d.vendor ? '#dfe4e8' : '#f3f4f1';
      return { d, semi, vehicle, route, q, drive, pause, backDur, color, trailerPaint, trailer: (d.kind === 'REEFER' ? 'reefer' : 'dry') as TrailerKind };
    });
  }, [timeline, geo, site, lot, model]);
  // 调试：地址栏带 ?debug 时可以按时刻查看到货车辆的进场路线
  useEffect(() => {
    const g = window as unknown as { __sw?: Record<string, unknown> };
    if (g.__sw) g.__sw.yardTrucks = docks.map((tk) => ({ id: tk.d.id, kind: tk.d.kind, arrive: tk.d.arrive, approach: tk.route.approach.path }));
  }, [docks]);

  // 铁路道口的列车时刻表（决策记录 0019）
  const trains = useMemo(() => (site.railway ? trainsFor(siteSeed) : []), [site, siteSeed]);

  // 消防车（火警）与警车（停车场警情）
  const emergencies = useMemo(() => {
    const entranceX = customerEntrance(model, geo).outside.x;
    return (timeline?.incidents.disruptions ?? []).flatMap((d, i) => {
      if (d.kind === 'FIRE_ALARM') return [{ type: 'truck' as VehicleType, paint: '#c62828', arrive: d.start + 300, leave: d.end + 180, plan: emergencyPaths(lot, site.road, entranceX + 7, i % 2 === 0), colors: ['#ff2a1a', '#ffffff'] }];
      if (d.kind === 'POLICE') return [{ type: 'sedan' as VehicleType, paint: '#f4f4f2', arrive: d.start + 90, leave: d.end, plan: emergencyPaths(lot, site.road, lot.pickupSign.x + 4, i % 2 === 1), colors: ['#ff2a1a', '#2a6bff'] }];
      return [];
    });
  }, [timeline, model, geo, lot, site]);

  // 正在车边交付的会话
  const serving = useMemo(() => {
    const m = new Map<string, Array<[number, number]>>();
    for (const a of timeline?.associates ?? []) {
      if (a.role !== 'handoff') continue;
      for (const s of a.segments) {
        if (!s.ref || (s.activity !== '车边交付' && s.activity !== '司机交接')) continue;
        const list = m.get(s.ref) ?? [];
        list.push([s.t0, s.t1]);
        m.set(s.ref, list);
      }
    }
    return m;
  }, [timeline]);

  useFrame((_, delta) => {
    const b = batches.current;
    for (const t of VEHICLE_TYPES) b[t].n = 0;
    const tb = trailers.current;
    for (const k of TRAILER_KINDS) tb[k].n = 0;
    const towB = towBatches.current;
    for (const k of TOW_KINDS) towB[k].n = 0;
    const wheelMesh = wheelRef.current;
    const truckWheelMesh = truckWheelRef.current;
    const lampMesh = lampRef.current;
    let wheelN = 0;
    let truckWheelN = 0;
    let lampN = 0;
    const blinkOn = Math.floor(performance.now() / 380) % 2 === 0;
    const ring = ringRef.current;
    let rings = 0;
    const glow = glowRef.current;
    const beam = beamRef.current;
    const lightsOn = env.night > 0.05;
    let glows = 0;
    let beams = 0;
    const siren = sirenRef.current;
    let sirens = 0;
    const local = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, rx = 0) => {
      child.position.set(lx, ly, lz);
      child.rotation.set(rx, 0, 0);
      child.scale.set(sx, sy, sz);
      child.updateMatrix();
      return m4.multiplyMatrices(tmp.matrix, child.matrix);
    };
    const t = clock.time;
    const f = visualFactor();
    let placedReversing = false;
    const cong = congestionAt({ ...DEFAULT_TRAFFIC, level: profile.level || level, profile: profile.profile, ...(profile.extra ? { extra: profile.extra } : {}) }, t);
    const sim = trafficFor(site, siteSeed, cong);
    // 夜里路上的行人少
    sim.pedBusy = 1 - 0.85 * env.night;
    // 铁路道口和学校护导员（决策记录 0019）：按仿真时刻关闭，背景车流在停止线前排队
    sim.gates.rail = !!site.railway && railClosed(trains, t);
    sim.gates.school = !!site.school && guardStopping(t);
    // 背景车流按画面时间推进（暂停时静止）
    const vdt = clock.playing ? Math.min(delta, 0.1) * Math.min(clock.speed, 8) : 0;
    const steps = Math.ceil(vdt / 0.1);
    for (let k = 0; k < steps; k++) sim.step(vdt / steps, cong);

    // 进出停车场的车辆在路上时，登记为背景车流的障碍物（下一帧生效）
    const obstacles: Obstacle[] = [];
    const roadTop = site.roadTopZ + 1;
    const roadBottom = site.roadBottomZ - 1;
    const mainLanes = site.lanes.map((l, li) => ({ l, li })).filter(({ l }) => l.kind === 'main');
    // 停车场里行驶中的车先暂存，最后统一做柔性避让（离别的车太近时各自向右让一点），再写入实例
    const pending: Array<{ type: VehicleType; x: number; z: number; heading: number; paint: string; owner: string; y: number; mo: Motion }> = [];
    const lotCars: Array<{ x: number; z: number }> = [];
    /** 车轮：车辆局部坐标的轮位 → 世界矩阵（前轮转向、按行驶距离转动）；货车轮毂单独一批实例 */
    const wheelsAt = (specs: readonly WheelSpec[], mo: Motion, base: THREE.Matrix4 = tmp.matrix) => {
      for (const w of specs) {
        const mesh = w.truck ? truckWheelMesh : wheelMesh;
        if (!mesh) continue;
        if (w.truck ? truckWheelN >= TRUCK_WHEEL_CAP : wheelN >= WHEEL_CAP) continue;
        child.position.set(w.x, w.r, w.z);
        child.rotation.set(-(mo.dist / w.r), w.steer ? mo.steer : 0, 0, 'YXZ');
        child.scale.set(w.w, w.r, w.r);
        child.updateMatrix();
        mesh.setMatrixAt(w.truck ? truckWheelN++ : wheelN++, m4.multiplyMatrices(base, child.matrix));
      }
    };
    /** 车灯：刹车灯、倒车灯（车尾），转向灯 / 双闪（四角） */
    const lampsAt = (lx: number, yFront: number, front: number | undefined, rear: number, yRear: number, mo: Motion) => {
      if (!lampMesh) return;
      const add = (x: number, y: number, z: number, c: THREE.Color, sx = 0.3) => {
        if (lampN >= LAMP_CAP) return;
        lampMesh.setMatrixAt(lampN, local(x, y, z, sx, 0.14, 0.06));
        lampMesh.setColorAt(lampN++, c);
      };
      if (mo.braking) for (const sx of [lx - 0.22, -(lx - 0.22)]) add(sx, yRear, rear - 0.04, BRAKE);
      if (mo.reversing) for (const sx of [lx - 0.5, -(lx - 0.5)]) add(sx, yRear - 0.12, rear - 0.04, REVERSE, 0.16);
      if (blinkOn && (mo.hazard || mo.turning)) {
        const sides = mo.hazard ? [1, -1] : [mo.steer > 0 ? 1 : -1];
        for (const s of sides) {
          // 车头朝 +Z 时左侧是 +X
          if (front !== undefined) add(s * lx, yFront, front + 0.04, AMBER, 0.14);
          add(s * lx, yRear, rear - 0.05, AMBER, 0.14);
        }
      }
    };
    /** 夜里的尾灯光晕 */
    const tailGlow = (lx: number, y: number, rear: number, braking: boolean) => {
      if (!lightsOn || !glow || glows + 2 > GLOW_CAP) return;
      const r = braking ? 0.24 : 0.18;
      for (const sx of [-lx, lx]) {
        glow.setMatrixAt(glows, local(sx, y, rear - 0.05, r, r, r));
        glow.setColorAt(glows++, TAIL);
      }
    };
    const put = (type: VehicleType, x: number, z: number, heading: number, paint: string, owner: string, y = 0, ambient = false, moving = false, mo: Motion = STILL) => {
      if (!ambient && z > roadTop + 1) {
        if (moving) {
          pending.push({ type, x, z, heading, paint, owner, y, mo });
          return;
        }
        lotCars.push({ x, z });
      }
      write(type, x, z, heading, paint, owner, y, ambient, mo);
    };
    /** 挂车类（半挂车的挂车、私家车的拖车）：在挂接点放置，按自己的航向，车轮不随车身倾斜 */
    const placeTrailer = (batch: Batch, cap: number, hx: number, hz: number, heading: number, paint: string, mo: Motion, wheels: readonly WheelSpec[], lamp: { halfW: number; y: number; rear: number }, k: { pitch: number; roll: number; h: number }) => {
      if (!batch.paint || !batch.detail || batch.n >= cap) return;
      tmp.position.set(hx, 0, hz);
      tmp.rotation.set(0, heading, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      wheelsAt(wheels, { ...mo, steer: 0 });
      const m = posture(tmp.matrix, k, { ...mo, accel: 0 });
      batch.paint.setMatrixAt(batch.n, m);
      batch.detail.setMatrixAt(batch.n, m);
      batch.paint.setColorAt(batch.n, color.set(paint));
      batch.n++;
      tmp.matrix.copy(m);
      lampsAt(lamp.halfW, lamp.y, undefined, lamp.rear, lamp.y, mo);
      tailGlow(lamp.halfW - 0.2, lamp.y, lamp.rear, mo.braking);
    };
    /** 半挂车：牵引车在牵引销处，挂车按自己的航向挂在后面 */
    const writeRig = (kx: number, kz: number, heading: number, trailerHeading: number, paint: string, kind: TrailerKind, trailerPaint: string, mo: Motion, ambient = false) => {
      write('semi', kx, kz, heading, paint, '', 0, ambient, { ...mo, reversing: false, braking: mo.braking && !mo.reversing }, true);
      // 挂车的侧倾按牵引车的侧向加速度减半（挂车滞后于牵引车）
      placeTrailer(tb[kind], TRAILER_CAP, kx, kz, trailerHeading, trailerPaint, { ...mo, lat: mo.lat * 0.5 }, TRAILER_WHEELS, TRAILER_LAMP, BODY.semi);
    };
    /** 私家车拖着的拖车：挂钩在车尾，拖车按自己的航向 */
    const writeTow = (kind: TowKind, hx: number, hz: number, heading: number, paint: string, mo: Motion) => {
      placeTrailer(towBatches.current[kind], TOW_CAP, hx, hz, heading, paint, { ...mo, lat: mo.lat * 0.6 }, TOW[kind].wheels, TOW[kind].lamp, kind === 'camper' ? BODY.van : BODY.sedan);
    };
    const write = (type: VehicleType, x: number, z: number, heading: number, paint: string, owner: string, y = 0, ambient = false, mo: Motion = STILL, rigTractor = false) => {
      if (!ambient && z < roadTop && z > roadBottom) {
        for (const { l, li } of mainLanes) {
          if (Math.abs(z - l.pts[0].z) > 2.4) continue;
          // 与车道同向行驶时按正常车速跟车，横穿或转进出入口时当作停着的车让行
          const along = Math.cos(heading - Math.atan2(l.dir.x, l.dir.z)) > 0.9;
          obstacles.push({ lane: li, d: l.dir.x > 0 ? x - l.pts[0].x : l.pts[0].x - x, len: VEHICLE_LENGTH[type], v: along ? 9 : 0 });
        }
      }
      const batch = b[type];
      if (batch.n >= capFor(type) || !batch.paint || !batch.detail) return;
      tmp.position.set(x, y, z);
      tmp.rotation.set(0, heading, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      // 车轮用基准矩阵，车身、车灯叠加俯仰和侧倾
      wheelsAt(WHEEL_LAYOUT[type], mo);
      const m = posture(tmp.matrix, BODY[type], mo);
      batch.paint.setMatrixAt(batch.n, m);
      batch.detail.setMatrixAt(batch.n, m);
      batch.paint.setColorAt(batch.n, color.set(paint));
      batch.owners[batch.n] = owner;
      batch.n++;
      tmp.matrix.copy(m);
      const lamp = LAMP_LAYOUT[type];
      // 半挂车的尾灯在挂车上（由 writeRig 画）
      lampsAt(lamp.halfW, lamp.y, lamp.front, rigTractor ? -1.3 : lamp.rear, lamp.rearY, rigTractor ? { ...mo, braking: false, reversing: false } : mo);
      // 夜间车灯：前大灯、尾灯和地面上的灯光（位置按车型）
      if (lightsOn && glow && beam && glows + 2 <= GLOW_CAP) {
        for (const sx of [-(lamp.halfW - 0.22), lamp.halfW - 0.22]) {
          glow.setMatrixAt(glows, local(sx, lamp.y, lamp.front + 0.05, 0.22, 0.22, 0.22));
          glow.setColorAt(glows++, HEAD);
        }
        if (!rigTractor) tailGlow(lamp.halfW - 0.22, lamp.rearY, lamp.rear, mo.braking);
        if (beams < BEAM_CAP && y === 0) beam.setMatrixAt(beams++, local(0, 0.06, lamp.front + 4.2, 3.4, 8.5, 1, -Math.PI / 2));
      }
    };

    if (visible) {
      // 1. 路上的背景车流
      const traffic = (id: number, type: VehicleType, x: number, z: number, heading: number, paint: string, mo: Motion) => {
        if (type === 'semi') {
          // 背景车流的位置是车身中心，换算到牵引销；挂车多数是白色，少数是彩色或冷藏挂车
          const h = (id * 2654435761) >>> 0;
          const kind: TrailerKind = h % 5 === 0 ? 'reefer' : 'dry';
          const tp = (['#f3f4f1', '#f3f4f1', '#f3f4f1', '#e9ecef', '#2f5f9e', '#b8432f', '#5d6a72'] as const)[h % 7] as string;
          writeRig(x + SEMI.center * Math.sin(heading), z + SEMI.center * Math.cos(heading), heading, heading, paint, kind, tp, mo, true);
          return;
        }
        put(type, x, z, heading, type === 'rv' ? rvColor(((id * 40503) % 1000) / 1000) : paint, '', 0, true, false, mo);
      };
      sim.lanes.forEach((list, li) => {
        for (const car of list) {
          sim.pose(li, car, pose);
          // 变道：横向偏移在右侧时车头朝左，侧向加速度向左
          const lat = car.shift === 0 ? 0 : Math.sign(car.shift) * Math.min(1.6, Math.abs(car.shift) * 0.8);
          traffic(car.id, car.type, pose.x, pose.z, pose.heading, car.color, { dist: car.d, steer: car.shift === 0 ? 0 : Math.sign(car.shift) * 0.05, braking: car.braking || car.v < 0.3, reversing: false, turning: Math.abs(car.shift) > 0.3, hazard: false, accel: car.a, lat });
        }
      });
      for (const tc of sim.turning) {
        sim.turningPose(tc, pose);
        // 左转弧线半径大、右转小；前轮转角和车身侧倾按转弯方向
        const left = site.turns[tc.turn]?.kind === 'left';
        const sgn = left ? 1 : -1;
        traffic(tc.car.id, tc.car.type, pose.x, pose.z, pose.heading, tc.car.color, { dist: tc.car.d + tc.s, steer: sgn * (left ? 0.22 : 0.34), braking: tc.car.braking, reversing: false, turning: true, hazard: false, accel: tc.car.a, lat: (sgn * tc.car.v * tc.car.v) / (left ? 14 : 9) });
      }

      // 2. 到店购物的私家车（门店实况里只显示背景车流）：车头朝里、倒车入位、穿过对面空车位；房车和带拖车的车停长车位
      if (!trafficOnly) stays.forEach((list, idx) => {
        const s = stayAt(list, t, (s0: Stay) => (s0.long ? 200 : 120) * f);
        if (!s) return;
        if (s.long) {
          placeLong(s);
          return;
        }
        const spot = lot.spots[idx] as ParkingSpot;
        if (!placeParked(spot, idx, s.arrive, s.leave, s.fromLeft, s.toLeft, s.mode)) return;
        const moving = t < s.arrive || t > s.leave;
        put(s.type, pose.x, pose.z, pose.heading, s.color, '', 0, false, moving, moving ? motionOf(pose, placedReversing) : STILL);
      });

      // 3. 汽车快修中心：驶入 → 等候 → 进工位（换轮胎时举升）→ 倒出 → 驶离
      for (const v of trafficOnly ? [] : visits) {
        const j = v.job;
        const start = j.start as number;
        const end = j.end as number;
        if (t < j.arrive - 150 * f || t > end + 150 * f) continue;
        let y = 0;
        let moving = true;
        if (t < j.arrive) {
          const tau = v.entry.duration - (j.arrive - t) / f;
          if (tau < 0) continue;
          v.entry.at(tau, pose);
        } else if (t < start) {
          pose.x = v.wait.x;
          pose.z = v.wait.z;
          pose.heading = v.wait.heading;
          moving = false;
        } else if (t < end) {
          const tau = (t - start) / f;
          if (tau < v.toBay.duration) v.toBay.at(tau, pose);
          else {
            moving = false;
            pose.x = v.bay.x;
            pose.z = v.bay.z;
            pose.heading = 0;
            if (v.bay.kind === 'TIRE') {
              // 举升：开进工位后升起，作业结束前放下
              const up = Math.min(1, (tau - v.toBay.duration) / 20, (end - t) / f / 20);
              y = 1.25 * Math.max(0, up);
            }
          }
        } else {
          const tau = (t - end) / f;
          if (tau <= v.back.duration) v.back.at(tau, pose);
          else if (tau <= v.back.duration + v.drive.duration) v.drive.at(tau - v.back.duration, pose);
          else continue;
        }
        const h = hash(j.id);
        put(carType(((h >> 4) % 1000) / 1000), pose.x, pose.z, pose.heading, carColor(((h >> 12) % 1000) / 1000), '', y, false, moving, moving ? motionOf(pose) : STILL);
      }

      // 4a. 甩挂车位上停着的挂车（决策记录 0019）：车头朝顶部车道，放下支腿；约三分之一是冷藏挂车
      site.yard.stalls.forEach((st, k) => {
        const reefer = (k * 7 + 3) % 3 === 0;
        placeTrailer(tb[reefer ? 'reefer' : 'dry'], TRAILER_CAP, st.x, st.z - 8.5 + 0.95, st.heading, reefer ? '#eef3f7' : (['#f3f4f1', '#e6e8e3', '#dfe4e8'][k % 3] as string), STILL, TRAILER_WHEELS, TRAILER_LAMP, BODY.semi);
      });

      // 4. 到货车辆：主路 → 后勤通道 → 待命车道排队 → 绕到卸货门前 → 开挂车门 → 倒车靠台 → 卸货 → 拉出驶离
      for (const tk of trafficOnly ? [] : docks) {
        const { d, semi, route, q, drive, pause, backDur } = tk;
        const app = route.approach.path;
        if (t < d.arrive - app.duration * f - 5 || t > d.leave + route.exit.path.duration + 5) {
          framePositions.delete(d.id);
          continue;
        }
        const dockAt = Math.max(d.arrive, d.dockAt);
        const tBack = dockAt + drive.path.duration + pause;
        let mo: Motion = STILL;
        if (t < d.arrive) {
          // 主路和后勤通道（高倍速时拉长，看得清）
          const tau = app.duration - (d.arrive - t) / f;
          if (tau < 0) {
            framePositions.delete(d.id);
            continue;
          }
          if (route.approach.rig) route.approach.rig.at(tau, rig);
          else {
            app.at(tau, rig);
            rig.trailer = rig.heading;
          }
          mo = motionOf(rig);
        } else if (t < dockAt) {
          // 待命车道：开到队尾的车位停下，前面的车进场后往前挪
          const m = q.at(t);
          lanePose(route, m.s, rig);
          mo = { ...STILL, dist: m.s, steer: rig.steer ?? 0, braking: m.a < -0.2 || m.v < 0.1, accel: m.a, lat: (m.v * m.v * Math.tan(rig.steer ?? 0)) / 4, turning: Math.abs(rig.steer ?? 0) > 0.12 };
        } else if (t < dockAt + drive.path.duration) {
          if (drive.rig) drive.rig.at(t - dockAt, rig);
          else drive.path.at(t - dockAt, rig);
          mo = motionOf(rig);
        } else if (t < tBack) {
          // 倒车起点：双闪，司机下车打开挂车后门
          if (drive.rig) drive.rig.at(drive.path.duration, rig);
          else drive.path.at(drive.path.duration, rig);
          mo = { ...STILL, hazard: true, braking: true, dist: rig.dist ?? 0 };
        } else if (t < tBack + backDur) {
          const tau = t - tBack;
          if (route.back.rig) route.back.rig.at(tau, rig);
          else if (route.back.path) {
            route.back.path.at(tau, rig);
            rig.trailer = rig.heading;
          }
          mo = motionOf(rig, true, true);
        } else if (t < d.leave) {
          Object.assign(rig, route.parked, { speed: 0, accel: 0, steer: 0, lat: 0 });
        } else {
          const tau = t - d.leave;
          if (tau > route.exit.path.duration) {
            framePositions.delete(d.id);
            continue;
          }
          if (route.exit.rig) route.exit.rig.at(tau, rig);
          else route.exit.path.at(tau, rig);
          mo = motionOf(rig);
        }
        if (semi) writeRig(rig.x, rig.z, rig.heading, rig.trailer, tk.color, tk.trailer, tk.trailerPaint, mo);
        else put(tk.vehicle === 'van' ? 'van' : 'truck', rig.x, rig.z, rig.heading, tk.vehicle === 'van' ? '#f1f2ee' : tk.color, '', 0, false, false, mo);
        framePositions.set(d.id, { x: rig.x, y: 0, z: rig.z });
      }

      // 5. 消防车、警车：警灯交替闪烁
      const blink = Math.floor(performance.now() / 260) % 2;
      for (const em of trafficOnly ? [] : emergencies) {
        if (t < em.arrive - 200 * f || t > em.leave + 200 * f) continue;
        if (t < em.arrive) {
          const tau = em.plan.entry.duration - (em.arrive - t) / f;
          if (tau < 0) continue;
          em.plan.entry.at(tau, pose);
        } else if (t <= em.leave) em.plan.entry.at(em.plan.entry.duration, pose);
        else {
          const tau = (t - em.leave) / f;
          if (tau > em.plan.leave.duration) continue;
          em.plan.leave.at(tau, pose);
        }
        put(em.type, pose.x, pose.z, pose.heading, em.paint, '', 0, false, false, t > em.arrive && t <= em.leave ? { ...STILL, hazard: true } : motionOf(pose));
        if (siren && sirens + 2 <= SIREN_CAP) {
          const ry = ROOF_Y[em.type] ?? 1.8;
          siren.setMatrixAt(sirens, local(-0.45, ry, em.type === 'truck' ? 2.9 : 0, 0.22, 0.16, 0.22));
          siren.setColorAt(sirens++, color.set(em.colors[blink] as string));
          siren.setMatrixAt(sirens, local(0.45, ry, em.type === 'truck' ? 2.9 : 0, 0.22, 0.16, 0.22));
          siren.setColorAt(sirens++, color.set(em.colors[1 - blink] as string));
        }
      }

      // 6. 线上取货顾客与配送司机（来自仿真结果）；同时记下各取货车位的状态（车位立牌的状态灯）
      const bays = new Map<number, BayState>();
      for (const c of trafficOnly ? [] : (timeline?.cars ?? [])) {
        if (t < c.arriveAt - 150 * f || t > c.doneAt + 150 * f) continue;
        const idx = carSpotIndex(lot, c.spot);
        const spot = lot.spots[idx] as ParkingSpot;
        const h = hash(c.id);
        if (!placeParked(spot, idx, c.arriveAt, c.doneAt, (h & 1) === 0, (h & 2) === 0)) continue;
        const type: VehicleType = c.kind === 'TRIP' ? ((h >> 3) % 3 === 0 ? 'suv' : 'van') : carType(((h >> 4) % 1000) / 1000);
        const paint = c.kind === 'TRIP' && type === 'van' ? '#f2f3ef' : carColor(((h >> 12) % 1000) / 1000);
        const carMoving = t < c.arriveAt || t > c.doneAt;
        put(type, pose.x, pose.z, pose.heading, paint, c.id, 0, false, carMoving, carMoving ? motionOf(pose, placedReversing) : STILL);
        framePositions.set(c.id, { x: pose.x, y: 0, z: pose.z });
        const isServing = (serving.get(c.id) ?? []).some(([a, z]) => t >= a && t < z);
        const st = carState(c, t, longWait, isServing);
        if (st === 'waiting' || st === 'longWait' || st === 'serving') bays.set(idx, st);
        if (ring && (st === 'waiting' || st === 'longWait' || st === 'serving') && rings < 64) {
          tmp.position.set(spot.x, 0.02, spot.z);
          tmp.rotation.set(-Math.PI / 2, 0, 0);
          tmp.scale.set(1, 1, 1);
          tmp.updateMatrix();
          ring.setMatrixAt(rings, tmp.matrix);
          ring.setColorAt(rings, color.set(RING_COLOR[st] ?? '#9fb3c4'));
          rings++;
        }
      }
      if (!trafficOnly) setBayStatus(bays);
    }

    // 柔性避让：只沿自身的左右方向横移，最多 1.6 米；正对面来车时各自向右让
    const R = 3.4;
    for (const p of pending) {
      // 车头朝 (sin h, cos h)，右侧为 (−cos h, sin h)
      const rx = -Math.cos(p.heading);
      const rz = Math.sin(p.heading);
      let off = 0;
      const push = (q: { x: number; z: number }) => {
        const dx = p.x - q.x;
        const dz = p.z - q.z;
        const d = Math.hypot(dx, dz);
        if (d >= R || d < 1e-3) return;
        const side = dx * rx + dz * rz;
        off += (Math.abs(side) < 0.3 ? 1 : Math.sign(side)) * ((R - d) / R) * 1.1;
      };
      for (const q of pending) if (q !== p) push(q);
      for (const q of lotCars) push(q);
      // 推购物车的回收员
      for (const q of cartTrain.pts) push(q);
      off = Math.max(-1.6, Math.min(1.6, off));
      write(p.type, p.x + rx * off, p.z + rz * off, p.heading, p.paint, p.owner, p.y, false, p.mo);
      if (p.owner) framePositions.set(p.owner, { x: p.x + rx * off, y: 0, z: p.z + rz * off });
    }

    for (const type of VEHICLE_TYPES) {
      const batch = b[type];
      for (const m of [batch.paint, batch.detail]) {
        if (!m) continue;
        m.count = batch.n;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
    for (const batch of [...TRAILER_KINDS.map((k) => tb[k]), ...TOW_KINDS.map((k) => towB[k])]) {
      for (const m of [batch.paint, batch.detail]) {
        if (!m) continue;
        m.count = batch.n;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
    if (wheelMesh) {
      wheelMesh.count = wheelN;
      wheelMesh.instanceMatrix.needsUpdate = true;
    }
    if (truckWheelMesh) {
      truckWheelMesh.count = truckWheelN;
      truckWheelMesh.instanceMatrix.needsUpdate = true;
    }
    if (lampMesh) {
      lampMesh.count = lampN;
      lampMesh.instanceMatrix.needsUpdate = true;
      if (lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate = true;
    }
    sim.obstacles = obstacles;
    if (siren) {
      siren.count = sirens;
      siren.instanceMatrix.needsUpdate = true;
      if (siren.instanceColor) siren.instanceColor.needsUpdate = true;
    }
    if (glow && beam) {
      glow.count = lightsOn ? glows : 0;
      beam.count = lightsOn ? beams : 0;
      glow.instanceMatrix.needsUpdate = true;
      beam.instanceMatrix.needsUpdate = true;
      if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
      if (beamMat.current) beamMat.current.opacity = 0.5 * env.night;
    }
    if (ring) {
      ring.count = rings;
      ring.instanceMatrix.needsUpdate = true;
      if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
    }

    /** 停车车辆在时刻 t 的位置：驶入 → 停放 → 倒车退出 → 驶离；不可见时返回 false */
    function placeParked(spot: ParkingSpot, idx: number, arrive: number, leave: number, fromLeft: boolean, toLeft: boolean, mode?: 'back' | 'through'): boolean {
      placedReversing = false;
      if (t < arrive) {
        if (mode === 'back') {
          // 开过车位停一下，再倒进去
          const [ap, bk] = paths.backIn(spot, idx, fromLeft);
          const tau = ap.duration + 1.5 + bk.duration - (arrive - t) / f;
          if (tau < 0) return false;
          if (tau < ap.duration) ap.at(tau, pose);
          else if (tau < ap.duration + 1.5) ap.at(ap.duration, pose);
          else {
            bk.at(tau - ap.duration - 1.5, pose);
            placedReversing = true;
          }
          return true;
        }
        const p = mode === 'through' ? paths.through(spot, idx, fromLeft) : paths.entry(spot, idx, fromLeft);
        const tau = p.duration - (arrive - t) / f;
        if (tau < 0) return false;
        p.at(tau, pose);
        return true;
      }
      if (t <= leave) {
        pose.x = spot.x;
        pose.z = spot.z;
        // 倒车入位、穿过停进来的车车头朝外
        pose.heading = spot.heading + (mode ? Math.PI : 0);
        return true;
      }
      if (mode) {
        const p = paths.forward(spot, idx, toLeft);
        const tau = (t - leave) / f;
        if (tau > p.duration) return false;
        p.at(tau, pose);
        return true;
      }
      const [back, drive] = paths.exit(spot, idx, toLeft);
      const tau = (t - leave) / f;
      placedReversing = tau <= back.duration;
      if (tau <= back.duration) back.at(tau, pose);
      else if (tau <= back.duration + drive.duration) drive.at(tau - back.duration, pose);
      else return false;
      return true;
    }

    /** 房车 / 带拖车的车：沿车道靠右停进长车位，走时继续向前开出；拖车按挂钩运动学跟随 */
    function placeLong(s: Stay): void {
      const lk = s.long;
      if (!lk) return;
      const r = paths.long(lk.bay, lk.kind, s.type, s.fromLeft, s.toLeft);
      if (!r) return;
      let trailer = r.parked.heading;
      let mo: Motion = STILL;
      if (t < s.arrive) {
        const tau = r.entry.duration - (s.arrive - t) / f;
        if (tau < 0) return;
        r.entry.at(tau, pose);
        trailer = r.enterRig?.trailerAt(tau) ?? pose.heading;
        mo = motionOf(pose);
      } else if (t <= s.leave) {
        pose.x = r.parked.x;
        pose.z = r.parked.z;
        pose.heading = r.parked.heading;
        trailer = r.enterRig?.end() ?? r.parked.heading;
      } else {
        const tau = (t - s.leave) / f;
        if (tau > r.exit.duration) return;
        r.exit.at(tau, pose);
        trailer = r.exitRig?.trailerAt(tau) ?? pose.heading;
        mo = motionOf(pose);
      }
      // 大车不做柔性避让（别的车让它）
      put(s.type, pose.x, pose.z, pose.heading, s.color, '', 0, false, false, mo);
      if (r.tow && lk.kind !== 'rv') {
        const hx = pose.x - r.tow.hitch * Math.sin(pose.heading);
        const hz = pose.z - r.tow.hitch * Math.cos(pose.heading);
        // 拖车颜色：房车拖挂米白，平板拖车深灰，船体按车辆颜色挑一个
        const tp = lk.kind === 'camper' ? '#efeadf' : lk.kind === 'utility' ? '#4a5056' : (['#c8453f', '#3f7fb8', '#f2f2ee', '#2f8f8f'] as const)[Math.floor(((s.arrive * 7) % 4 + 4) % 4)] as string;
        writeTow(lk.kind as TowKind, hx, hz, trailer, tp, mo);
      }
    }
  });

  const onClick = (type: VehicleType) => (e: ThreeEvent<MouseEvent>) => {
    const id = e.instanceId === undefined ? '' : batches.current[type].owners[e.instanceId];
    if (!id) return;
    e.stopPropagation();
    useApp.getState().select({ type: 'car', id });
  };
  const onContext = (type: VehicleType) => (e: ThreeEvent<MouseEvent>) => {
    const id = e.instanceId === undefined ? '' : batches.current[type].owners[e.instanceId];
    if (id) armMenu({ type: 'car', id }, e);
  };

  return (
    <group>
      {VEHICLE_TYPES.map((type) => {
        const g = vehicleGeometry(type);
        return (
          <group key={type}>
            <instancedMesh
              ref={(m) => {
                batches.current[type].paint = m;
              }}
              args={[g.paint, undefined, capFor(type)]}
              frustumCulled={false}
              castShadow
              onClick={onClick(type)}
              onContextMenu={onContext(type)}
            >
              <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
            </instancedMesh>
            <instancedMesh
              ref={(m) => {
                batches.current[type].detail = m;
              }}
              args={[g.detail, undefined, capFor(type)]}
              frustumCulled={false}
              onClick={onClick(type)}
              onContextMenu={onContext(type)}
            >
              <meshToonMaterial vertexColors gradientMap={toonGradient()} />
            </instancedMesh>
          </group>
        );
      })}
      {TRAILER_KINDS.map((k) => {
        const g = trailerGeometry(k);
        return (
          <group key={k}>
            <instancedMesh
              ref={(m) => {
                trailers.current[k].paint = m;
              }}
              args={[g.paint, undefined, TRAILER_CAP]}
              frustumCulled={false}
              castShadow
            >
              <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
            </instancedMesh>
            <instancedMesh
              ref={(m) => {
                trailers.current[k].detail = m;
              }}
              args={[g.detail, undefined, TRAILER_CAP]}
              frustumCulled={false}
            >
              <meshToonMaterial vertexColors gradientMap={toonGradient()} />
            </instancedMesh>
          </group>
        );
      })}
      {TOW_KINDS.map((k) => {
        const g = towGeometry(k);
        return (
          <group key={k}>
            <instancedMesh
              ref={(m) => {
                towBatches.current[k].paint = m;
              }}
              args={[g.paint, undefined, TOW_CAP]}
              frustumCulled={false}
              castShadow
            >
              <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
            </instancedMesh>
            <instancedMesh
              ref={(m) => {
                towBatches.current[k].detail = m;
              }}
              args={[g.detail, undefined, TOW_CAP]}
              frustumCulled={false}
            >
              <meshToonMaterial vertexColors gradientMap={toonGradient()} />
            </instancedMesh>
          </group>
        );
      })}
      <instancedMesh ref={wheelRef} args={[wheelGeometry('car'), undefined, WHEEL_CAP]} frustumCulled={false}>
        <meshToonMaterial vertexColors gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={truckWheelRef} args={[wheelGeometry('truck'), undefined, TRUCK_WHEEL_CAP]} frustumCulled={false}>
        <meshToonMaterial vertexColors gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={lampRef} args={[undefined, undefined, LAMP_CAP]} frustumCulled={false}>
        <boxGeometry />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={sirenRef} args={[undefined, undefined, SIREN_CAP]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={glowRef} args={[undefined, undefined, GLOW_CAP]} frustumCulled={false}>
        <sphereGeometry args={[1, 8, 6]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={beamRef} args={[undefined, undefined, BEAM_CAP]} frustumCulled={false} renderOrder={2}>
        <planeGeometry />
        <meshBasicMaterial ref={beamMat} map={beamTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </instancedMesh>
      <instancedMesh ref={ringRef} args={[undefined, undefined, 64]} frustumCulled={false}>
        <ringGeometry args={[2.3, 2.75, 32]} />
        <meshBasicMaterial transparent opacity={0.8} side={THREE.DoubleSide} />
      </instancedMesh>
    </group>
  );
}
