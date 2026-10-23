import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { congestionAt, DEFAULT_TRAFFIC } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { carState } from './motion';
import { carSpotIndex, entryPath, exitPaths, type ParkingSpot, type TimedPath } from './lot';
import { stayAt } from './shoppers';
import { planServiceVisits } from './service';
import { planDock } from './dock';
import { backroomLayout } from '@storewright/store-config';
import { emergencyPaths } from './evacuation';
import { customerEntrance } from './crowd';
import { trafficFor, type Obstacle } from './traffic';
import { useSiteLayout, useStays } from './useSite';
import { carColor, carType, LAMP_LAYOUT, SEMI, TRAILER_WHEELS, trailerGeometry, vehicleGeometry, VEHICLE_LENGTH, VEHICLE_TYPES, WHEEL_LAYOUT, wheelGeometry, type TrailerKind, type VehicleType, type WheelSpec } from './vehicles';
import { planSemiDock, type RigPose } from './rig';
import { framePositions } from './Actors';
import { cartTrain } from './CartAttendants';
import { toonGradient } from './toon';
import { armMenu } from './contextTarget';
import { env } from './environment';
import { radialTexture } from './Surroundings';

const CAP = 220;
/** 每种车型的实例上限（半挂车只用于到货，数量很少） */
const capFor = (t: VehicleType) => (t === 'semi' ? 6 : CAP);
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
const LAMP_CAP = 1400;
const pose = { x: 0, z: 0, heading: 0, speed: 0, accel: 0, steer: 0, dist: 0 };
const rig: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, accel: 0, steer: 0, dist: 0 };
const BRAKE = new THREE.Color('#ff1f1a');
const REVERSE = new THREE.Color('#fbfbf4');
const AMBER = new THREE.Color('#ffb11a');
const TRAILER_KINDS: TrailerKind[] = ['dry', 'reefer'];

/** 车辆的运动状态：车轮转动、前轮转角、刹车灯、倒车灯、转向灯 / 双闪 */
interface Motion {
  dist: number;
  steer: number;
  braking: boolean;
  reversing: boolean;
  turning: boolean;
  hazard: boolean;
}
const STILL: Motion = { dist: 0, steer: 0, braking: false, reversing: false, turning: false, hazard: false };
function motionOf(p: { speed?: number; accel?: number; steer?: number; dist?: number }, reversing = false, hazard = false): Motion {
  const steer = p.steer ?? 0;
  return { dist: p.dist ?? 0, steer, braking: (p.accel ?? 0) < -0.25 || (p.speed ?? 0) < 0.15, reversing, turning: Math.abs(steer) > 0.12, hazard };
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
  const lampRef = useRef<THREE.InstancedMesh>(null);
  const trailers = useRef<Record<TrailerKind, Batch>>({ dry: { paint: null, detail: null, n: 0, owners: [] }, reefer: { paint: null, detail: null, n: 0, owners: [] } });
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
  const paths = useMemo(() => {
    const cache = new Map<string, TimedPath | [TimedPath, TimedPath]>();
    return {
      entry(spot: ParkingSpot, idx: number, fromLeft: boolean): TimedPath {
        const k = `e${idx}${fromLeft ? 'L' : 'R'}`;
        let p = cache.get(k) as TimedPath | undefined;
        if (!p) cache.set(k, (p = entryPath(lot, site.road, spot, fromLeft)));
        return p;
      },
      exit(spot: ParkingSpot, idx: number, toLeft: boolean): [TimedPath, TimedPath] {
        const k = `x${idx}${toLeft ? 'L' : 'R'}`;
        let p = cache.get(k) as [TimedPath, TimedPath] | undefined;
        if (!p) cache.set(k, (p = exitPaths(lot, site.road, spot, toLeft)));
        return p;
      },
    };
  }, [lot, site]);

  // 到货车辆：配送中心半挂车（常温、冷藏）与供应商厢式货车
  const docks = useMemo(() => {
    const f0 = geo.floors[0];
    if (!f0) return [];
    const doors = backroomLayout(model.config).docks;
    return (timeline?.inbound.trucks ?? []).map((d, i) => {
      const type: VehicleType = d.kind === 'BOX' ? 'truck' : 'semi';
      const doorX = (doors[d.door] ?? doors[0])?.x ?? f0.maxX - 10;
      const color = d.kind === 'SEMI' ? '#c8433a' : d.kind === 'REEFER' ? '#2f6fb5' : (['#e0a42f', '#3f8f5a', '#7a4fa0', '#d0573a', '#2f8f8f'][i % 5] as string);
      const fromLeft = i % 2 === 0;
      const toLeft = i % 3 !== 0;
      // 半挂车：铰接运动学（牵引车 + 挂车），厢式货车按整车
      const semi =
        type === 'semi'
          ? planSemiDock({
              startX: fromLeft ? site.road.spawnMinX : site.road.spawnMaxX,
              inLane: fromLeft ? site.road.nearLaneZ : site.road.farLaneZ,
              outLane: toLeft ? site.road.farLaneZ : site.road.nearLaneZ,
              endX: toLeft ? site.road.spawnMinX : site.road.spawnMaxX,
              serviceX: lot.maxX + 4,
              zTurn: f0.maxZ + 27,
              doorX,
              wallZ: f0.maxZ,
              roadEdgeZ: lot.edgeZ,
            })
          : undefined;
      return { d, type, plan: planDock(site, lot, f0, doorX, type, fromLeft, toLeft), semi, color, trailer: (d.kind === 'REEFER' ? 'reefer' : 'dry') as TrailerKind };
    });
  }, [timeline, geo, site, lot, model]);

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
    const wheelMesh = wheelRef.current;
    const lampMesh = lampRef.current;
    let wheelN = 0;
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
    const cong = congestionAt({ ...DEFAULT_TRAFFIC, level: profile.level || level, profile: profile.profile }, t);
    const sim = trafficFor(site, siteSeed, cong);
    // 夜里路上的行人少
    sim.pedBusy = 1 - 0.85 * env.night;
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
    /** 车轮：车辆局部坐标的轮位 → 世界矩阵（前轮转向、按行驶距离转动） */
    const wheelsAt = (specs: readonly WheelSpec[], mo: Motion) => {
      if (!wheelMesh) return;
      for (const w of specs) {
        if (wheelN >= WHEEL_CAP) return;
        child.position.set(w.x, w.r, w.z);
        child.rotation.set(-(mo.dist / w.r), w.steer ? mo.steer : 0, 0, 'YXZ');
        child.scale.set(w.w, w.r, w.r);
        child.updateMatrix();
        wheelMesh.setMatrixAt(wheelN++, m4.multiplyMatrices(tmp.matrix, child.matrix));
      }
    };
    /** 车灯：刹车灯、倒车灯（车尾），转向灯 / 双闪（四角） */
    const lampsAt = (lx: number, ly: number, front: number | undefined, rear: number, mo: Motion) => {
      if (!lampMesh) return;
      const add = (x: number, z: number, c: THREE.Color, sx = 0.3) => {
        if (lampN >= LAMP_CAP) return;
        lampMesh.setMatrixAt(lampN, local(x, ly, z, sx, 0.14, 0.06));
        lampMesh.setColorAt(lampN++, c);
      };
      if (mo.braking) for (const sx of [lx - 0.22, -(lx - 0.22)]) add(sx, rear - 0.04, BRAKE);
      if (mo.reversing) for (const sx of [lx - 0.5, -(lx - 0.5)]) add(sx, rear - 0.04, REVERSE, 0.16);
      if (blinkOn && (mo.hazard || mo.turning)) {
        const sides = mo.hazard ? [1, -1] : [mo.steer > 0 ? 1 : -1];
        for (const s of sides) {
          // 车头朝 +Z 时左侧是 +X
          if (front !== undefined) add(s * lx, front + 0.04, AMBER, 0.14);
          add(s * lx, rear - 0.05, AMBER, 0.14);
        }
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
    /** 半挂车：牵引车在牵引销处，挂车按自己的航向挂在后面 */
    const writeRig = (kx: number, kz: number, heading: number, trailerHeading: number, paint: string, kind: TrailerKind, trailerPaint: string, mo: Motion, ambient = false) => {
      write('semi', kx, kz, heading, paint, '', 0, ambient, { ...mo, reversing: false, braking: mo.braking && !mo.reversing }, true);
      const batch = tb[kind];
      if (!batch.paint || !batch.detail || batch.n >= 8) return;
      tmp.position.set(kx, 0, kz);
      tmp.rotation.set(0, trailerHeading, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      batch.paint.setMatrixAt(batch.n, tmp.matrix);
      batch.detail.setMatrixAt(batch.n, tmp.matrix);
      batch.paint.setColorAt(batch.n, color.set(trailerPaint));
      batch.n++;
      wheelsAt(TRAILER_WHEELS, { ...mo, steer: 0 });
      lampsAt(1.2, 1.4, undefined, -SEMI.kingpinToRear, mo);
      if (lightsOn && glow && glows + 2 <= GLOW_CAP)
        for (const sx of [-1.0, 1.0]) {
          glow.setMatrixAt(glows, local(sx, 1.4, -SEMI.kingpinToRear - 0.05, 0.18, 0.18, 0.18));
          glow.setColorAt(glows++, TAIL);
        }
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
      batch.paint.setMatrixAt(batch.n, tmp.matrix);
      batch.detail.setMatrixAt(batch.n, tmp.matrix);
      batch.paint.setColorAt(batch.n, color.set(paint));
      batch.owners[batch.n] = owner;
      batch.n++;
      wheelsAt(WHEEL_LAYOUT[type], mo);
      const lamp = LAMP_LAYOUT[type];
      // 半挂车的尾灯在挂车上（由 writeRig 画）
      lampsAt(lamp.halfW, lamp.y, lamp.front, rigTractor ? -1.3 : lamp.rear, rigTractor ? { ...mo, braking: false, reversing: false } : mo);
      // 夜间车灯：前大灯、尾灯和地面上的灯光（位置按车型）
      if (lightsOn && glow && beam && glows + 4 <= GLOW_CAP) {
        for (const sx of [-(lamp.halfW - 0.22), lamp.halfW - 0.22]) {
          glow.setMatrixAt(glows, local(sx, lamp.y, lamp.front + 0.05, 0.22, 0.22, 0.22));
          glow.setColorAt(glows++, HEAD);
          if (!rigTractor) {
            glow.setMatrixAt(glows, local(sx, lamp.y + 0.05, lamp.rear - 0.05, mo.braking ? 0.24 : 0.18, mo.braking ? 0.24 : 0.18, mo.braking ? 0.24 : 0.18));
            glow.setColorAt(glows++, TAIL);
          }
        }
        if (beams < BEAM_CAP && y === 0) beam.setMatrixAt(beams++, local(0, 0.06, lamp.front + 4.2, 3.4, 8.5, 1, -Math.PI / 2));
      }
    };

    if (visible) {
      // 1. 路上的背景车流
      const traffic = (type: VehicleType, x: number, z: number, heading: number, paint: string, mo: Motion) => {
        if (type === 'semi') {
          // 背景车流的位置是车身中心，换算到牵引销
          writeRig(x + SEMI.center * Math.sin(heading), z + SEMI.center * Math.cos(heading), heading, heading, paint, 'dry', '#f3f4f1', mo, true);
          return;
        }
        put(type, x, z, heading, paint, '', 0, true, false, mo);
      };
      sim.lanes.forEach((list, li) => {
        for (const car of list) {
          sim.pose(li, car, pose);
          traffic(car.type, pose.x, pose.z, pose.heading, car.color, { dist: car.d, steer: 0, braking: car.braking || car.v < 0.3, reversing: false, turning: Math.abs(car.shift) > 0.3, hazard: false });
        }
      });
      for (const tc of sim.turning) {
        sim.turningPose(tc, pose);
        traffic(tc.car.type, pose.x, pose.z, pose.heading, tc.car.color, { dist: tc.car.d + tc.s, steer: 0.3, braking: false, reversing: false, turning: true, hazard: false });
      }

      // 2. 到店购物的私家车（门店实况里只显示背景车流）
      if (!trafficOnly) stays.forEach((list, idx) => {
        const s = stayAt(list, t, 120 * f);
        if (!s) return;
        const spot = lot.spots[idx] as ParkingSpot;
        if (!placeParked(spot, idx, s.arrive, s.leave, s.fromLeft, s.toLeft)) return;
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

      // 4. 到货车辆：驶入 → 倒车靠台 → 卸货 → 驶离
      for (const { d, type, plan, semi, color: paint, trailer } of trafficOnly ? [] : docks) {
        if (t < d.arrive - 200 * f || t > d.leave + 200 * f) continue;
        if (semi) {
          // 半挂车：前进驶过卸货门 → 倒车靠台（倒车灯、双闪）→ 卸货（熄火）→ 驶离
          let hazard = false;
          const dockAt = Math.max(d.arrive, d.dockAt ?? d.arrive);
          if (t < d.arrive) {
            const tau = semi.entry.duration - (d.arrive - t) / f;
            if (tau < 0) continue;
            semi.entry.at(tau, rig);
          } else if (t < dockAt) {
            // 卸货门被占用：停在门前等（双闪）
            Object.assign(rig, semi.entry.end(), { speed: 0, accel: 0, steer: 0 });
            hazard = true;
          } else if (t <= d.leave) {
            const tau = (t - dockAt) / f;
            if (tau < semi.back.duration) {
              semi.back.at(tau, rig);
              hazard = true;
            } else Object.assign(rig, semi.parked, { speed: 0, accel: 0, steer: 0 });
          } else {
            const tau = (t - d.leave) / f;
            if (tau > semi.leave.duration) continue;
            semi.leave.at(tau, rig);
          }
          const parkedNow = t >= dockAt && t <= d.leave && (t - dockAt) / f >= semi.back.duration;
          writeRig(rig.x, rig.z, rig.heading, rig.trailer, paint, trailer, d.kind === 'REEFER' ? '#eef3f7' : '#f3f4f1', parkedNow ? STILL : t >= d.arrive && t < dockAt ? { ...STILL, hazard: true, braking: true } : motionOf(rig, rig.reversing, hazard));
          continue;
        }
        let mo: Motion = STILL;
        if (t < d.arrive) {
          const tau = plan.entry.duration - (d.arrive - t) / f;
          if (tau < 0) continue;
          plan.entry.at(tau, pose);
          mo = motionOf(pose);
        } else if (t < Math.max(d.arrive, d.dockAt ?? d.arrive)) {
          plan.entry.at(plan.entry.duration, pose);
          mo = { ...STILL, hazard: true, braking: true };
        } else if (t <= d.leave) {
          const tau = (t - Math.max(d.arrive, d.dockAt ?? d.arrive)) / f;
          if (tau < plan.back.duration) {
            plan.back.at(tau, pose);
            mo = motionOf(pose, true, true);
          } else {
            pose.x = plan.parked.x;
            pose.z = plan.parked.z;
            pose.heading = plan.parked.heading;
          }
        } else {
          const tau = (t - d.leave) / f;
          if (tau > plan.leave.duration) continue;
          plan.leave.at(tau, pose);
          mo = motionOf(pose);
        }
        // 大货车靠台倒车时不让行（其他车让它）
        put(type, pose.x, pose.z, pose.heading, paint, '', 0, false, false, mo);
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

      // 6. 线上取货顾客与配送司机（来自仿真结果）
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
    for (const k of TRAILER_KINDS) {
      const batch = tb[k];
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
    function placeParked(spot: ParkingSpot, idx: number, arrive: number, leave: number, fromLeft: boolean, toLeft: boolean): boolean {
      placedReversing = false;
      if (t < arrive) {
        const p = paths.entry(spot, idx, fromLeft);
        const tau = p.duration - (arrive - t) / f;
        if (tau < 0) return false;
        p.at(tau, pose);
        return true;
      }
      if (t <= leave) {
        pose.x = spot.x;
        pose.z = spot.z;
        pose.heading = spot.heading;
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
              castShadow
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
              args={[g.paint, undefined, 8]}
              frustumCulled={false}
              castShadow
            >
              <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
            </instancedMesh>
            <instancedMesh
              ref={(m) => {
                trailers.current[k].detail = m;
              }}
              args={[g.detail, undefined, 8]}
              frustumCulled={false}
              castShadow
            >
              <meshToonMaterial vertexColors gradientMap={toonGradient()} />
            </instancedMesh>
          </group>
        );
      })}
      <instancedMesh ref={wheelRef} args={[wheelGeometry(), undefined, WHEEL_CAP]} frustumCulled={false} castShadow>
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
