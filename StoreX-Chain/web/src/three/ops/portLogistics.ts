import * as THREE from 'three';
import { usePaintMask } from '../vehicles/index';
import { isNight, Lamps, turnOf, type LampState } from './lamps';
import { box, cyl, merge, type Part } from '../../../../../StoreX/web/src/three/models';
import { partGeometry } from '../fleet';
import { MODEL_SPECS } from '../vehicles/index';
import { BOBTAIL, defineYardSite, dimsOf, fillet, forwardRig, BodyRig, Polyline, poseAt, setSiteVisits, yardRoute, type DistRig, type PathLike, type PathState, type Pt, type RigPose, type YardPlan, type YardRoute } from '@storewright/yard';
import { AREAS, BAY_PITCH, JunctionBook, junctionSpan, PL, SECTIONS, sectionPlan, type PortSection } from '../../../../src/hub/portLayout';
import { CFS_SLOTS, BONDED_SLOTS, DEPOT_TIERS, MANEUVER, type PortDock, type PortHubPlan, type PortNode, type PortTractorLeg } from '../../../../src/hub/port';
import { occupancyAt } from '../../../../src/hub/types';
import { BOX_COLORS, clamp01, containerGeometry, drain, ease, Pool, STORE_BOX, type Steps } from './kit';

/**
 * 港口物流中心的三维（港口的局部坐标；布置见 src/hub/portLayout.ts，作业计划见 src/hub/port.ts）：
 *
 * - 拆装箱库（CFS）：一栋 34 米进深的库房，南墙西段是集装箱侧月台（场内拖车把骨架车倒进门、甩下，班组和叉车拆箱 / 装箱，
 *   做完另一辆拖车来挂走），东段是货车侧月台（外面的半挂车倒车靠台装卸）；台高 1.32 米，门距 4.3 米，
 *   卷帘门车靠稳以后才升起，门边的信号灯有车红、没车绿，调平板搭进车厢；
 * - 保税仓库：围网里的一栋库房，南墙一排月台（两樘冷藏门），保税货进库、出库放行；
 * - 海关查验：机检通道（大型集装箱检查门架，车从车道开进来、向北慢慢穿过门架、绕回来）和开箱查验台
 *   （有顶棚的高台，拖车把箱倒到台边甩下，查验员开箱）；
 * - 空箱堆场：两个箱区，空箱堆 7 层，两台正面吊在装卸车道和箱区之间吊箱；
 * - 待命区、拖车停车位、办公楼、围网、高杆灯，车道的标线和箭头（场地的标线按收货场引擎排的车道画）。
 *
 * 车：外面的半挂车在货车侧、保税库的场地里按收货场引擎的时间线（排队、驶过门、车头外摆、从司机一侧倒车靠台、拉出）画，
 * 路上和闸口那一段由外来车层（extTrucks.ts）画，交接点在进场道路外口、驶出路线的终点；场内拖车按作业计划的每一段画
 * （在集装箱侧、查验台用收货场引擎的路线：驶近、外摆、倒车甩挂，挂走时拉出），骨架车在门口、台边停着的时段单独画。
 * 镜头拉近（离物流中心 500 米内、不太高）时屋顶隐藏，看得见库里的货架、托盘和叉车。
 */

const DAY = 24 * 3600;
/** 出闸口袋最多排几辆（第 0 到第 POCKET_MAX 个车位，往西每 18.2 米一个）：再多的停在最后一个车位后面等（以前只有 3 个车位，第 4 辆停到第 3 辆身上） */
const POCKET_MAX = 4;
const hex = (c: string): number => parseInt(c.slice(1), 16);
const BOX_HEX = BOX_COLORS.map(hex);
const STORE_HEX = hex(STORE_BOX);
const boxHex = (i: number | undefined) => (i === undefined || i < 0 ? STORE_HEX : (BOX_HEX[i % BOX_HEX.length] as number));
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.08, ...o });
/** 40 尺箱半长（集装箱模型的原点在箱中心） */
const BOX_MID = 6.095;
/** 月台台高、门高 */
const DOCK_H = 1.32;
const DOOR_H = 3.0;
/** 外面的半挂车的驾驶室颜色（和外来车层用同一份：交接时颜色不变） */
export const LOGI_CABS = [0xf4f4f2, 0x2a5c9a, 0xb03a2e, 0x2e7d4f, 0x6b6e72, 0xd9a21b, 0x1f2a36];
export const LOGI_TRAILERS = [0xf2f3f4, 0xe8e9eb, 0xdfe3e8, 0xf6f1e4];
function idHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export const cabOf = (id: string) => LOGI_CABS[idHash(id) % LOGI_CABS.length] as number;
export const trailerOf = (id: string) => LOGI_TRAILERS[(idHash(id) >>> 4) % LOGI_TRAILERS.length] as number;

/** 本地（场地）坐标 → 港口局部坐标 */
const toPortPt = (p: Pt): Pt => ({ x: p.x, z: p.z + PL.zWall });
/** 三维的 yaw：车模车头朝 +x，heading = atan2(dx, dz) */
const yaw3 = (h: number) => h - Math.PI / 2;

// ———————————————————————— 几何 ————————————————————————

/** 正面吊（空箱）：底盘、驾驶室、伸缩臂（单独一个零件，按角度转）；原点在前轴中心，车头朝 +x */
function stackerBody(): THREE.BufferGeometry {
  return merge([box(8.2, 1.3, 3.4, '#d4a017', -2.6, 0.6, 0), box(2.2, 2.3, 2.0, '#2b2f35', -1.2, 1.9, -0.5), box(1.6, 0.9, 3.2, '#3a3d42', -6.4, 0.6, 0), cyl(0.75, 0.75, 0.6, '#1d1d1d', 0, 0.75, 1.5), cyl(0.75, 0.75, 0.6, '#1d1d1d', 0, 0.75, -1.5), cyl(0.7, 0.7, 0.5, '#1d1d1d', -5.2, 0.7, 1.45), cyl(0.7, 0.7, 0.5, '#1d1d1d', -5.2, 0.7, -1.45)]);
}
/** 伸缩臂和吊具（原点在臂根，沿 +x 伸出 10 米） */
function stackerBoom(): THREE.BufferGeometry {
  return merge([box(10, 0.8, 0.8, '#c99512', 5, -0.4, 0), box(1.2, 0.6, 6.2, '#3a3d42', 10.2, -1.1, 0)]);
}
/** 叉车（库内）：车身、护顶架、货叉；原点在车身中心，货叉朝 +x */
function forklift(): THREE.BufferGeometry {
  return merge([box(2.2, 1.2, 1.15, '#e0a800', -0.2, 0.15, 0), box(0.1, 1.9, 1.0, '#2b2f35', 0.95, 0.2, 0), box(1.3, 0.08, 1.1, '#2b2f35', -0.1, 2.1, 0), box(1.2, 0.06, 0.12, '#555a60', 1.6, 0.18, 0.32), box(1.2, 0.06, 0.12, '#555a60', 1.6, 0.18, -0.32)]);
}
/** 一托货（托盘 + 纸箱） */
function palletGeo(): THREE.BufferGeometry {
  return merge([box(1.2, 0.14, 1.0, '#b48a5a', 0, 0, 0), box(1.12, 1.1, 0.94, '#c9a877', 0, 0.14, 0)]);
}
/** 卷帘门的门帘（宽 1、高 1，按门的大小缩放） */
function doorPanel(): THREE.BufferGeometry {
  return merge([box(1, 1, 0.12, '#c9ced4', 0, 0, 0)]);
}

// ———————————————————————— 运动段 ————————————————————————

/** 一段运动：沿 DistRig 从 s0 走到 s1（缓起缓停 / 按引擎的速度曲线 / 停着）；带不带骨架车、箱 */
interface Seg {
  t0: number;
  t1: number;
  rig: DistRig;
  s0: number;
  s1: number;
  /** 引擎的速度曲线（时刻 → 距离）；没有就缓起缓停 */
  timed?: { path: PathLike; dur: number };
  /** 本地（场地）坐标（要加 zWall） */
  local?: boolean;
  load: PortTractorLeg['load'];
  color?: number;
  rev?: boolean;
  hazard?: boolean;
  /** 让别的车：在起点多等几秒再走（后面开快一点，还是按计划的时刻到） */
  delay?: number;
}
/** 车身矩形（中心、朝向、半长、半宽） */
interface Body {
  cx: number;
  cz: number;
  h: number;
  hl: number;
  hw: number;
}
function bodyHit(a: Body, b: Body): boolean {
  // 两个外接圆碰不到就不用再按分离轴细查（结果一样）
  const rx = b.cx - a.cx;
  const rz = b.cz - a.cz;
  const rr = a.hl + a.hw + b.hl + b.hw;
  if (rx * rx + rz * rz > rr * rr) return false;
  const ax = Math.sin(a.h);
  const az = Math.cos(a.h);
  const bx = Math.sin(b.h);
  const bz = Math.cos(b.h);
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  for (const [nx, nz] of [
    [ax, az],
    [az, -ax],
    [bx, bz],
    [bz, -bx],
  ] as const) {
    const ra = a.hl * Math.abs(ax * nx + az * nz) + a.hw * Math.abs(az * nx - ax * nz);
    const rb = b.hl * Math.abs(bx * nx + bz * nz) + b.hw * Math.abs(bz * nx - bx * nz);
    if (Math.abs(dx * nx + dz * nz) >= ra + rb) return false;
  }
  return true;
}
/** 牵引销的位姿 → 车身矩形（牵引车：牵引销前 front、后 rear；挂车 / 骨架车按挂车朝向） */
function bodyOf(o: Body, x: number, z: number, h: number, front: number, rear: number): Body {
  const c = (front - rear) / 2;
  o.cx = x + Math.sin(h) * c;
  o.cz = z + Math.cos(h) * c;
  o.h = h;
  o.hl = (front + rear) / 2 - 0.2;
  o.hw = 1.2;
  return o;
}
const ST: PathState = { x: 0, z: 0, heading: 0 };
const POSE = (): RigPose => ({ x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 });

/** 一段运动此刻的位姿（港口局部坐标） */
function segPose(g: Seg, t: number, out: RigPose): void {
  let s: number;
  if (g.timed) {
    const k = clamp01((t - g.t0) / Math.max(1e-3, g.t1 - g.t0));
    g.timed.path.at(k * g.timed.dur, ST);
    s = ST.dist ?? 0;
  } else if (g.s0 === g.s1) s = g.s0;
  else {
    const t0 = g.t0 + (g.delay ?? 0);
    s = g.s0 + (g.s1 - g.s0) * ease(clamp01((t - t0) / Math.max(1e-3, g.t1 - t0)));
  }
  g.rig.poseAt(Math.max(0, Math.min(g.rig.length, s)), out);
  if (g.local) out.z += PL.zWall;
}

/** 节点在车道上的大致位置（判断往东还是往西） */
const NODE_X: Record<PortNode, number> = { park: -2160, cy: -2210, cfs: -2490, bay: -2740, scan: -2786, depot: -2870 };
/** 路线点（港口局部坐标）→ 圆角的折线 */
const road = (pts: Pt[], r = 9): Pt[] => fillet(pts, r, 1);

/** 每个场地的路线（按门、车型缓存）：倒车靠台用的整套 */
const ROUTES = new Map<string, YardRoute>();
function routeOf(key: PortSection['key'], door: number, toLeft: boolean): YardRoute {
  const k = `${key}:${door}:${toLeft ? 'L' : 'R'}`;
  let r = ROUTES.get(k);
  if (!r) ROUTES.set(k, (r = yardRoute(sectionPlan(key), door, 'chassis', { toLeft })));
  return r;
}

/** 驶出路线开到车道上那一点（引擎的驶出路线沿车道一直开到地块头，这里只用到上了车道的那一截） */
function exitCut(r: YardRoute): number {
  const lane = PL.zDrive - PL.zWall;
  const p = POSE();
  // 上了车道、车身摆直（再开 18 米，挂车也摆直了）才交给下一段
  for (let s = 0; s <= r.exit.rig.length; s += 1) {
    r.exit.rig.poseAt(s, p);
    if (Math.abs(p.z - lane) < PL.driveHalf && Math.abs(Math.sin(p.heading)) > 0.985) return Math.min(r.exit.rig.length, s + 18);
  }
  return r.exit.rig.length;
}
/** 进场道路上车身摆直的那一点（离靠台车道的转弯还差一点）：外面的车、拖车的路线在这里交给引擎的路线 */
const handZ = (p: YardPlan) => p.zCourt + 14.3;
function laneHand(r: YardRoute, p: YardPlan): number {
  const q = POSE();
  for (let s = 0; s <= r.lane.length; s += 0.5) {
    r.laneRig.poseAt(s, q);
    if (q.z <= handZ(p)) return s;
  }
  return 0;
}

/** 倒车时牵引销走过的路线（单车头来挂骨架车时照着倒回去） */
const KINGPIN = new Map<string, Pt[]>();
function kingpinPath(r: YardRoute, key: string): Pt[] {
  let pts = KINGPIN.get(key);
  if (pts) return pts;
  pts = [];
  const p = POSE();
  const D = r.back.path.duration;
  for (let i = 0; i <= 60; i++) {
    r.back.path.at((i / 60) * D, ST);
    r.back.rig.poseAt(ST.dist ?? 0, p);
    pts.push({ x: p.x, z: p.z });
  }
  KINGPIN.set(key, pts);
  return pts;
}

export interface PortLogisticsInfo {
  devanning: number;
  stuffing: number;
  backlog: number;
  cfsPallets: number;
  cfsFill: number;
  truckDocks: { busy: number; doors: number; queue: number };
  bonded: { pallets: number; fill: number; busy: number; doors: number };
  inspection: { scanning: boolean; open: number; bays: number; today: number; openedToday: number; own: { box: string; text: string }[] };
  depot: { boxes: number; slots: number; stackers: number };
  tractors: { busy: number; total: number };
  kpi: { label: string; value: string }[];
  notes: string[];
}

/** 外来车层要的一趟（港口局部坐标）：和港口的 GateTrip 一样，另外带车型、颜色；hidden 的段由这里画 */
export interface LogiTrip {
  t0: number;
  t1: number;
  load: boolean;
  box: number;
  inK: number;
  outK: number;
  inAt: number;
  legs: { t0: number; t1: number; pts?: { x: number; z: number }[]; at?: { x: number; z: number; yaw: number }; box?: number; hidden?: boolean; u0?: number; still?: boolean }[];
  build: 0 | 1 | 2;
  cab: number;
  trailer: number;
}

export class PortLogistics {
  readonly group = new THREE.Group();
  private statics?: THREE.Group;
  private readonly roofs = new THREE.Group();
  private readonly inside = new THREE.Group();
  private readonly lampMat: THREE.MeshStandardMaterial;
  /** 车灯（场内拖车、货车侧和保税库场地里的半挂车） */
  private readonly lamp = new Lamps('logi-vehicle-lamps', 500);
  /** 拖车停车位的间距、外来车层画的车（上一次给出去的整趟，拖车让它们） */
  private stallPitch = 4.4;
  private lastTrips: LogiTrip[] = [];
  /** 口袋排满（第 4 辆起只能在场地口等）的次数：检查用 */
  pocketOverflow = 0;
  private stallX(k: number): number {
    const pk = AREAS.park;
    const cap = Math.max(1, Math.floor((pk.x1 - pk.x0 - 2.4) / this.stallPitch) + 1);
    return pk.x0 + 2.2 + this.stallPitch * (k % cap);
  }
  private readonly st: LampState = { night: false };
  private readonly P2: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
  private readonly tractors: Pool;
  private readonly chassis: Pool;
  private readonly boxes: Pool;
  private readonly cabs: Pool;
  private readonly dryTrailers: Pool;
  private readonly reeferTrailers: Pool;
  private readonly stackers: Pool;
  private readonly booms: Pool;
  private readonly doors: Pool;
  private readonly levelers: Pool;
  private readonly lights: Pool;
  private readonly forks: Pool;
  private readonly pallets: Pool;
  private readonly beams: Pool;
  private readonly hazards: Pool;
  private readonly all: Pool[];
  private plan?: PortHubPlan;
  private builtX0 = NaN;
  /** 每辆场内拖车的运动段 */
  private tracks: Seg[][] = [];
  /** 门口、台边停着的骨架车：位姿（港口局部坐标）、时段、箱的颜色 */
  private parked: { t0: number; t1: number; pose: RigPose; color: number }[] = [];
  /** 正面吊的作业段：位置、时段、吊着的箱从哪到哪 */
  private stackJobs: { t0: number; t1: number; x: number; z: number; yaw: number; from: Pt & { y: number }; to: Pt & { y: number }; color: number; stacker: number }[] = [];
  /**
   * 空箱堆场装卸车道上每个贝位停车的时段（拖车排的，外面的集卡排的时候再加）：两辆车要在同一时段用同一个贝位时，后排的停到旁边空着的贝位，
   * 正面吊把箱吊到那辆车上（作业的时刻不变）。depotJobBay：作业编号 → 车停的贝位（和箱位的贝位不一样的才记）
   */
  private depotBookT: { bay: number; a: number; b: number }[] = [];
  private depotJobBay = new Map<string, number>();
  /** 空箱堆场每个箱位的占用 */
  private slots: { x: number; z: number; y: number; t0: number; t1: number; color: number }[] = [];
  /** 外面的车交给引擎路线的时刻（进场道路上车身摆直的地方） */
  private readonly handIn = new Map<string, number>();
  private readonly P = POSE();
  private readonly Q = POSE();
  private near = false;

  constructor(lampMat?: THREE.MeshStandardMaterial) {
    this.group.name = 'port-logistics';
    this.lampMat = lampMat ?? std({ color: '#fff4d6', emissive: new THREE.Color('#ffe2a8'), emissiveIntensity: 0 });
    const VC = std({ vertexColors: true });
    const tint = std({ vertexColors: true, roughness: 0.6 });
    // 车模（fleet.ts 的零件）：车漆乘实例颜色，车窗、灯、轮胎不跟着变色
    const PM = usePaintMask(std({ vertexColors: true, roughness: 0.6 }));
    this.tractors = new Pool(partGeometry('terminalTractor'), PM, 16, 'logi-tractors');
    this.chassis = new Pool(partGeometry('chassis'), PM, 48, 'logi-chassis');
    this.boxes = new Pool(containerGeometry(box, merge), std({ vertexColors: true, roughness: 0.7 }), 560, 'logi-boxes');
    this.cabs = new Pool(partGeometry('tractor'), PM, 40, 'logi-cabs');
    this.dryTrailers = new Pool(partGeometry('trailerPlain'), PM, 40, 'logi-dry');
    this.reeferTrailers = new Pool(partGeometry('trailerPlainReefer'), PM, 16, 'logi-reefer');
    this.stackers = new Pool(stackerBody(), VC, 2, 'logi-stackers');
    this.booms = new Pool(stackerBoom(), VC, 2, 'logi-booms');
    this.doors = new Pool(doorPanel(), VC, 64, 'logi-doors');
    this.levelers = new Pool(merge([box(2.4, 0.12, 2.6, '#6d7278', 0, 0, 0)]), VC, 64, 'logi-levelers');
    this.lights = new Pool(merge([box(0.35, 0.35, 0.12, '#ffffff', 0, 0, 0)]), std({ vertexColors: true, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.6, roughness: 0.4 }), 64, 'logi-lights', false);
    this.forks = new Pool(forklift(), VC, 40, 'logi-forklifts');
    this.pallets = new Pool(palletGeo(), VC, 1600, 'logi-pallets');
    this.beams = new Pool(merge([box(0.3, 6, 22, '#ff5a3c', 0, 0, 0)]), new THREE.MeshBasicMaterial({ color: '#ff5a3c', transparent: true, opacity: 0.35, depthWrite: false }), 2, 'logi-scan-beam', false);
    this.hazards = new Pool(merge([box(0.3, 0.3, 0.3, '#ffb000', 0, 0, 0)]), std({ color: '#ffb000', emissive: new THREE.Color('#ffb000'), emissiveIntensity: 1.2 }), 160, 'logi-hazards', false);
    this.all = [this.tractors, this.chassis, this.boxes, this.cabs, this.dryTrailers, this.reeferTrailers, this.stackers, this.booms, this.doors, this.levelers, this.lights, this.hazards, this.beams];
    this.group.add(this.lamp.mesh);
    for (const p of this.all) this.group.add(p.mesh);
    this.inside.add(this.forks.mesh, this.pallets.mesh);
    this.inside.visible = false;
    this.group.add(this.roofs, this.inside);
  }

  /** 堆场的西头（码头的泊位多了堆场往西接，车道和堆场的沥青就从那里接上） */
  private buildStatic(yardX0: number): void {
    if (this.statics) {
      this.group.remove(this.statics);
      this.statics.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.roofs.clear();
    }
    const g = new THREE.Group();
    g.name = 'port-logistics-static';
    const ground: Part[] = [];
    const marks: Part[] = [];
    const solid: Part[] = [];
    const roof: Part[] = [];
    const glass: Part[] = [];
    const lampHeads: Part[] = [];
    const xa = PL.xWest;
    const xb = PL.xEast;
    // 地坪：整块沥青（物流中心），场地里月台前 18 米是水泥地坪
    ground.push(box(xb - xa + 10, 0.24, PL.zFence - PL.zNorth + 4, '#62666b', (xa + xb) / 2, 0.02, (PL.zNorth + PL.zFence) / 2));
    // 车道（堆场最外侧那条车道接到物流中心西头）：沥青、中心双黄线、边线
    const dx0 = PL.xWest - 6;
    const dx1 = Math.min(yardX0 - 18, PL.xEast + 10);
    ground.push(box(dx1 - dx0, 0.25, PL.driveHalf * 2 + 1, '#5d6166', (dx0 + dx1) / 2, 0.02, PL.zDrive));
    for (const s of [-0.13, 0.13]) marks.push(box(dx1 - dx0, 0.04, 0.12, '#f2c94c', (dx0 + dx1) / 2, 0.28, PL.zDrive + s));
    for (const e of [-1, 1]) for (let x = dx0; x < dx1; x += 9) marks.push(box(4.5, 0.04, 0.14, '#f2f2ee', x + 2.25, 0.28, PL.zDrive + e * (PL.driveHalf - 0.4)));
    // 场地：每个场地的水泥地坪、车道线、箭头、对位线、停止线、牌子（按收货场引擎排的）
    for (const s of SECTIONS) {
      const p = sectionPlan(s.key);
      ground.push(box(p.x1 - p.x0, 0.06, 18, '#a7a59e', (p.x0 + p.x1) / 2, 0.26, PL.zWall + 9));
      for (const m of p.marks) {
        if (m.kind === 'line') {
          for (let i = 1; i < m.pts.length; i++) {
            const a = toPortPt(m.pts[i - 1] as Pt);
            const b = toPortPt(m.pts[i] as Pt);
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            if (len < 0.05) continue;
            const ang = Math.atan2(b.z - a.z, b.x - a.x);
            const col = m.color === 'yellow' ? '#f2c94c' : '#f2f2ee';
            const n = m.dashed ? Math.floor(len / 6) : 1;
            for (let k = 0; k < n; k++) {
              const f0 = m.dashed ? (k * 6) / len : 0;
              const f1 = m.dashed ? Math.min(1, (k * 6 + 3) / len) : 1;
              const cx = a.x + (b.x - a.x) * ((f0 + f1) / 2);
              const cz = a.z + (b.z - a.z) * ((f0 + f1) / 2);
              const piece = box(len * (f1 - f0), 0.04, m.width, col, 0, 0, 0);
              piece.applyMatrix4(new THREE.Matrix4().makeRotationY(-ang));
              piece.translate(cx, 0.33, cz);
              marks.push(piece);
            }
          }
        } else if (m.kind === 'arrow') {
          const a = toPortPt(m.at);
          // 箭杆 + 两笔箭头
          const tip = box(3.4, 0.04, 0.32, '#f2f2ee', 0, 0, 0);
          const h1 = box(1.6, 0.04, 0.32, '#f2f2ee', 0, 0, 0);
          h1.applyMatrix4(new THREE.Matrix4().makeRotationY(0.65));
          h1.translate(1.15, 0, 0.45);
          const h2 = box(1.6, 0.04, 0.32, '#f2f2ee', 0, 0, 0);
          h2.applyMatrix4(new THREE.Matrix4().makeRotationY(-0.65));
          h2.translate(1.15, 0, -0.45);
          const arr = merge([tip, h1, h2]);
          arr.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw3(m.heading)));
          arr.translate(a.x, 0.33, a.z);
          marks.push(arr);
        } else if (m.kind === 'stop') {
          const a = toPortPt(m.a);
          const b = toPortPt(m.b);
          marks.push(box(Math.max(0.4, Math.abs(b.x - a.x)), 0.04, Math.max(0.4, Math.abs(b.z - a.z)), '#f2f2ee', (a.x + b.x) / 2, 0.33, (a.z + b.z) / 2));
        } else if (m.kind === 'sign') {
          const a = toPortPt(m.at);
          solid.push(box(0.15, 2.6, 0.15, '#9aa3ab', a.x, 0, a.z), box(1.8, 1.0, 0.1, '#1f5fbf', a.x, 2.2, a.z));
        }
      }
    }
    // 库房：拆装箱库、保税仓库（墙、台、雨棚、门洞），开箱查验台（高台 + 顶棚）
    const shed = (x0: number, x1: number, h: number, wall: string, label: 'cfs' | 'bonded') => {
      const z0 = PL.zNorth;
      const z1 = PL.zWall;
      solid.push(box(x1 - x0, h, 0.4, wall, (x0 + x1) / 2, 0, z0 + 0.2), box(0.4, h, z1 - z0, wall, x0 + 0.2, 0, (z0 + z1) / 2), box(0.4, h, z1 - z0, wall, x1 - 0.2, 0, (z0 + z1) / 2));
      // 南墙：门洞上方的墙、门与门之间的墙垛（门洞宽 3 米、高 3 米，从台面起）
      solid.push(box(x1 - x0, h - DOCK_H - DOOR_H, 0.4, wall, (x0 + x1) / 2, DOCK_H + DOOR_H, z1 - 0.2), box(x1 - x0, DOCK_H, 0.6, '#8e9196', (x0 + x1) / 2, 0, z1 - 0.3));
      const doorXs = SECTIONS.filter((s) => (label === 'cfs' ? s.key.startsWith('port-cfs') : s.key === 'port-bonded')).flatMap((s) => s.doors.map((d) => d.x));
      const xs = [...doorXs].sort((a, b) => a - b);
      let prev = x0;
      for (const x of xs) {
        if (x - PL.doorW / 2 - prev > 0.05) solid.push(box(x - PL.doorW / 2 - prev, DOOR_H, 0.4, wall, (prev + x - PL.doorW / 2) / 2, DOCK_H, z1 - 0.2));
        prev = x + PL.doorW / 2;
        // 门罩（黑色海绵）、防撞块、门边的灯座
        solid.push(box(0.35, DOOR_H + 0.3, 0.5, '#1e1f22', x - PL.doorW / 2 - 0.2, DOCK_H - 0.1, z1 + 0.25), box(0.35, DOOR_H + 0.3, 0.5, '#1e1f22', x + PL.doorW / 2 + 0.2, DOCK_H - 0.1, z1 + 0.25), box(PL.doorW + 0.8, 0.4, 0.5, '#1e1f22', x, DOCK_H + DOOR_H, z1 + 0.25));
        solid.push(box(0.4, 0.5, 0.3, '#2b2b2b', x - 1.1, DOCK_H - 0.65, z1 + 0.15), box(0.4, 0.5, 0.3, '#2b2b2b', x + 1.1, DOCK_H - 0.65, z1 + 0.15));
      }
      if (x1 - prev > 0.05) solid.push(box(x1 - prev, DOOR_H, 0.4, wall, (prev + x1) / 2, DOCK_H, z1 - 0.2));
      // 雨棚（月台上方伸出 4 米）
      solid.push(box(x1 - x0, 0.3, 4, '#d6d9dd', (x0 + x1) / 2, DOCK_H + DOOR_H + 0.6, z1 + 2));
      roof.push(box(x1 - x0 + 0.6, 0.5, z1 - z0 + 0.6, '#c3c7cc', (x0 + x1) / 2, h, (z0 + z1) / 2));
      for (let x = x0 + 8; x < x1 - 6; x += 14) roof.push(box(8, 0.25, 5, '#2b4a6b', x, h + 0.5, (z0 + z1) / 2 - 6));
      // 库内地坪
      ground.push(box(x1 - x0 - 1, 0.1, z1 - z0 - 1, '#d9d6cf', (x0 + x1) / 2, DOCK_H - 0.1, (z0 + z1) / 2));
    };
    shed(-2470, -2262, 11, '#e4e2dc', 'cfs');
    shed(-2602, -2508, 10, '#dfe3e6', 'bonded');
    // 保税库的围网（区港联动：单独围起来，场地口有卡口）
    const fence = (pts: Pt[], gaps: [number, number][] = []) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as Pt;
        const b = pts[i] as Pt;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(1, Math.round(len / 3));
        for (let k = 0; k < n; k++) {
          const f = (k + 0.5) / n;
          const x = a.x + (b.x - a.x) * f;
          const z = a.z + (b.z - a.z) * f;
          if (gaps.some(([g0, g1]) => Math.abs(b.z - a.z) < 0.1 && x > g0 && x < g1)) continue;
          const seg = box(len / n, 2.2, 0.05, '#7f8a8f', 0, 0, 0);
          seg.applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.atan2(b.z - a.z, b.x - a.x)));
          seg.translate(x, 0.1, z);
          solid.push(seg);
          solid.push(box(0.1, 2.4, 0.1, '#5f6a70', x - ((b.x - a.x) / n) / 2, 0, z - ((b.z - a.z) / n) / 2));
        }
      }
    };
    // 物流中心南边的围网：每个场地的进场道路、空箱堆场和机检通道、停车位的口留出来
    const gates: [number, number][] = [
      ...SECTIONS.map((s) => [sectionPlan(s.key).driveX - 6, sectionPlan(s.key).driveX + 6] as [number, number]),
      [AREAS.depot.x0 - 6, AREAS.depot.x0 + 6],
      [AREAS.depot.x1 - 6, AREAS.depot.x1 + 6],
      [AREAS.scan.xIn - 6, AREAS.scan.xOut + 6],
      [AREAS.park.x1 - 8, AREAS.park.x1 + 4],
      [AREAS.hold.x0 - 4, AREAS.hold.x1 + 4],
    ];
    fence([{ x: PL.xWest, z: PL.zFence }, { x: PL.xEast, z: PL.zFence }], gates);
    fence([{ x: PL.xWest, z: PL.zNorth }, { x: PL.xEast, z: PL.zNorth }]);
    fence([{ x: PL.xWest, z: PL.zNorth }, { x: PL.xWest, z: PL.zFence }]);
    fence([{ x: -2626, z: PL.zNorth }, { x: -2626, z: PL.zFence }]);
    fence([{ x: -2504, z: PL.zNorth }, { x: -2504, z: PL.zFence }]);
    // 卡口岗亭：保税库、货车侧场地口
    for (const k of ['port-bonded', 'port-cfs-truck'] as const) {
      const p = sectionPlan(k);
      solid.push(box(2.4, 2.8, 2.4, '#f4f6f7', p.driveX + p.driveHalf + 2.2, 0, PL.zFence - 3), box(2.6, 0.25, 2.6, '#2a78d6', p.driveX + p.driveHalf + 2.2, 2.8, PL.zFence - 3));
    }
    // 开箱查验台：高台（台高 1.32 米）、顶棚（立柱）、台上的查验桌；台边每个车位的编号线
    {
      const s = SECTIONS.find((x) => x.key === 'port-inspect') as PortSection;
      const xA = (s.doors[0]?.x ?? 0) - BAY_PITCH;
      const xB = (s.doors[s.doors.length - 1]?.x ?? 0) + BAY_PITCH;
      solid.push(box(xB - xA, DOCK_H, 9, '#9a9d9f', (xA + xB) / 2, 0, PL.zWall - 4.5));
      for (let x = xA; x <= xB + 0.1; x += BAY_PITCH) solid.push(box(0.35, 7.2, 0.35, '#8a949c', x, 0, PL.zWall - 0.6), box(0.35, 7.2, 0.35, '#8a949c', x, 0, PL.zWall - 16));
      roof.push(box(xB - xA + 2, 0.35, 18, '#d8dde2', (xA + xB) / 2, 7.2, PL.zWall - 7.5));
      for (const d of s.doors) solid.push(box(1.6, 0.9, 0.8, '#e5e7e9', d.x, DOCK_H, PL.zWall - 5));
      solid.push(box(xB - xA, 3.2, 8, '#d0d4d8', (xA + xB) / 2, 0, PL.zNorth + 6));
    }
    // 机检通道：门架（两侧墙、顶梁、设备舱）、车道、绕回来的环道
    {
      const a = AREAS.scan;
      const [p0, p1] = a.portal;
      solid.push(box(1.6, 7.5, p1 - p0, '#cfd3d6', a.xIn - 3.6, 0, (p0 + p1) / 2), box(1.6, 7.5, p1 - p0, '#cfd3d6', a.xIn + 3.6, 0, (p0 + p1) / 2), box(8.8, 1.2, p1 - p0, '#b9bec2', a.xIn, 7.5, (p0 + p1) / 2), box(5, 4, 6, '#e8eaec', a.xIn - 8.5, 0, p1 - 3));
      solid.push(box(8.8, 0.25, 0.5, '#f2c94c', a.xIn, 7.6, p0), box(8.8, 0.25, 0.5, '#f2c94c', a.xIn, 7.6, p1));
      for (let z = a.z0 + 6; z < PL.zFence; z += 6) marks.push(box(0.14, 0.04, 3, '#f2f2ee', (a.xIn + a.xOut) / 2, 0.33, z));
    }
    // 空箱堆场：箱区的地面线、正面吊的作业车道
    {
      const d = AREAS.depot;
      for (const b of d.blocks) for (let k = 0; k <= d.bays; k++) marks.push(box(0.15, 0.04, 3 * d.rowPitch + 1, '#e8e8e2', d.x0 + k * d.bayPitch, 0.33, b.z + d.rowPitch));
      for (let x = d.x0; x < d.x1; x += 9) marks.push(box(4.5, 0.04, 0.15, '#f2f2ee', x + 2.25, 0.33, (d.laneZ + d.passZ) / 2));
    }
    // 待命区、拖车停车位的车位线
    {
      const h = AREAS.hold;
      for (let k = 0; k <= h.n; k++) marks.push(box(0.15, 0.04, h.z1 - h.z0, '#f2f2ee', h.x0 + ((h.x1 - h.x0) * k) / h.n, 0.33, (h.z0 + h.z1) / 2));
      const pk = AREAS.park;
      for (let x = pk.x0; x <= pk.x1 + 0.1; x += 4.4) marks.push(box(0.15, 0.04, pk.stallZ[1] - pk.stallZ[0] + 6, '#f2f2ee', x, 0.33, (pk.stallZ[0] + pk.stallZ[1]) / 2));
      const o = AREAS.office;
      solid.push(box(o.x1 - o.x0, 8, o.z1 - o.z0, '#e9ecef', (o.x0 + o.x1) / 2, 0, (o.z0 + o.z1) / 2));
      glass.push(box(o.x1 - o.x0 + 0.1, 1.4, o.z1 - o.z0 + 0.1, '#3b5568', (o.x0 + o.x1) / 2, 2.2, (o.z0 + o.z1) / 2), box(o.x1 - o.x0 + 0.1, 1.4, o.z1 - o.z0 + 0.1, '#3b5568', (o.x0 + o.x1) / 2, 5.6, (o.z0 + o.z1) / 2));
    }
    // 高杆灯
    const masts: Pt[] = [];
    // 高杆灯避开场地的进场道路、空箱堆场和机检通道的路、库房
    const roads = [...SECTIONS.map((s) => sectionPlan(s.key).driveX), AREAS.depot.x1 + 4, AREAS.depot.x0 - 4, AREAS.scan.xIn, AREAS.scan.xOut, AREAS.park.x1 + 3];
    const clearX = (x: number) => [0, 14, -14, 28, -28].map((d) => x + d).find((c) => roads.every((r) => Math.abs(r - c) > 9)) ?? x;
    for (let x = PL.xWest + 30; x < PL.xEast; x += 120) masts.push({ x: clearX(x), z: PL.zFence - 3 });
    for (const x of [-2880, -2700, -2640, -2490, -2240]) masts.push({ x, z: PL.zNorth + 3 });
    for (const m of masts) solid.push(cyl(0.3, 0.45, 26, '#9aa3ab', m.x, 0, m.z)), lampHeads.push(box(3, 0.9, 3, '#ffffff', m.x, 26, m.z));
    const add = (parts: Part[], mat: THREE.Material, name: string, parent: THREE.Object3D = g, shadow = true) => {
      if (!parts.length) return;
      const mesh = new THREE.Mesh(merge(parts), mat);
      mesh.name = name;
      mesh.receiveShadow = true;
      mesh.castShadow = shadow;
      parent.add(mesh);
    };
    add(ground, std({ vertexColors: true, roughness: 0.92 }), 'logi-ground', g, false);
    add(marks, std({ vertexColors: true, roughness: 0.7 }), 'logi-marks', g, false);
    add(solid, std({ vertexColors: true, roughness: 0.82 }), 'logi-buildings');
    add(glass, std({ vertexColors: true, roughness: 0.25, metalness: 0.4 }), 'logi-glass');
    add(roof, std({ vertexColors: true, roughness: 0.85 }), 'logi-roofs', this.roofs);
    add(lampHeads, this.lampMat, 'logi-lamps');
    // 库内：货架（拆装箱库中段、保税库整栋），镜头拉近才画
    const racks: Part[] = [];
    for (const [x0, x1, rows] of [
      [-2405, -2352, 5],
      [-2596, -2512, 6],
    ] as const)
      for (let r = 0; r < rows; r++) {
        const z = PL.zNorth + 6 + r * 4.4;
        racks.push(box(x1 - x0, 0.12, 1.1, '#3f6fb5', (x0 + x1) / 2, 2.0, z), box(x1 - x0, 0.12, 1.1, '#3f6fb5', (x0 + x1) / 2, 4.0, z), box(x1 - x0, 0.12, 1.1, '#3f6fb5', (x0 + x1) / 2, 6.0, z));
        for (let x = x0; x <= x1; x += 2.7) racks.push(box(0.1, 7.5, 1.1, '#e07b27', x, 0.1, z));
      }
    if (racks.length) {
      const m = new THREE.Mesh(merge(racks), std({ vertexColors: true }));
      m.name = 'logi-racks';
      this.inside.add(m);
    }
    this.statics = g;
    this.group.add(g);
    this.builtX0 = yardX0;
  }

  setNight(n: number): void {
    if (!this.statics) return;
    this.lampMat.emissiveIntensity = Math.max(this.lampMat.emissiveIntensity, 1.4 * clamp01(n));
  }

  /**
   * 一天的计划：排好场内拖车的每一段运动、门口停着的骨架车、正面吊、空箱堆场每个箱位；
   * 货车侧、保税库的外面的车交给收货场引擎（登记场地和当天的访问，画的时候取时间线）。yardX0：码头堆场的西头。
   */
  /** 港口正在分段排这一天：先空着（不画场内的车，监控读不到旧的一天） */
  idle(): void {
    this.plan = undefined;
  }

  setPlan(plan: PortHubPlan, yardX0: number): void {
    drain(this.setPlanSteps(plan, yardX0));
  }
  /** 和 setPlan 一样，分成几段（场地登记、场内拖车、空箱堆场各一段）；排完才换上新计划（中间画面上这里先空着，计算不读 this.plan） */
  *setPlanSteps(plan: PortHubPlan, yardX0: number): Steps {
    if (this.builtX0 !== yardX0) this.buildStatic(yardX0);
    // 场地登记（收货场引擎）：货车侧、保税库的当天访问；集装箱侧、查验台只登记场地（场内拖车的甩挂由这里排）
    for (const s of SECTIONS) {
      const p = sectionPlan(s.key);
      defineYardSite({ key: s.key, frame: { origin: { x: 0, z: PL.zWall }, yaw: 0 }, plan: p, doors: s.doors.map((d, i) => ({ id: d.id ?? `${s.key}-${i}`, index: i, kinds: s.kinds })) });
    }
    setSiteVisits('port-cfs-truck', plan.yardVisits['port-cfs-truck']);
    setSiteVisits('port-bonded', plan.yardVisits['port-bonded']);
    this.handIn.clear();
    for (const d of plan.docks) {
      if (!d.tl || d.face === 'cfs-box') continue;
      const p = sectionPlan(d.face === 'bonded' ? 'port-bonded' : 'port-cfs-truck');
      const t0 = d.tl.segs[0]?.t0 ?? d.arrive;
      let tH = t0;
      for (let t = t0; t < d.tl.backAt; t += 0.5) {
        const u = poseAt(d.tl, t)?.units[0];
        if (u && u.pose.z <= handZ(p)) {
          tH = t;
          break;
        }
      }
      this.handIn.set(d.id, tH);
    }
    yield;
    this.buildTractors(plan);
    // 门口停着的骨架车：同一个门上前一辆还没被挂走、后一辆已经靠上来的那几秒（计划里挂走和靠台挨得很近），前一辆画到后一辆靠上来为止
    {
      const byPose = [...this.parked].sort((a, b) => a.pose.x - b.pose.x || a.pose.z - b.pose.z || a.t0 - b.t0);
      for (let i = 0; i < byPose.length; i++)
        for (let j = i + 1; j < byPose.length; j++) {
          const a = byPose[i] as (typeof byPose)[number];
          const b = byPose[j] as (typeof byPose)[number];
          if (Math.abs(b.pose.x - a.pose.x) > 1) break;
          if (Math.abs(b.pose.z - a.pose.z) < 1 && b.t0 < a.t1 && b.t0 >= a.t0) a.t1 = b.t0;
        }
    }
    yield;
    this.buildDepot(plan);
    this.plan = plan;
  }

  // ———————————————————————— 场内拖车 ————————————————————————

  /** 节点在车道上的接口：从车道拐进去、拐出来的那一段（港口局部坐标） */
  private entryPts(node: PortNode, east: boolean, extra: { door?: number; bay?: number; depotBay?: number; tractor?: number }): Pt[] {
    const zW = PL.zLaneW;
    const zE = PL.zLaneE;
    switch (node) {
      case 'cfs':
      case 'bay': {
        const key = node === 'cfs' ? 'port-cfs-box' : 'port-inspect';
        const p = sectionPlan(key);
        // 沿车道开过来（向西的右转、向东的左转）拐进进场道路，开到车身摆直的地方（从那里接引擎的路线）
        return east ? [{ x: p.xIn - 16, z: zE }, { x: p.xIn, z: zE }, toPortPt({ x: p.xIn, z: handZ(p) })] : [{ x: p.xIn + 16, z: zW }, { x: p.xIn, z: zW }, toPortPt({ x: p.xIn, z: handZ(p) })];
      }
      case 'depot': {
        const d = AREAS.depot;
        // 拖车的牵引销：骨架车上的箱对着箱位（箱中心在牵引销后 5.1 米，车头朝西）
        const x = d.x0 + ((extra.depotBay ?? Math.floor(d.bays / 2)) + 0.5) * d.bayPitch - 5.1;
        return [{ x: d.x1 + 14, z: zW }, { x: d.x1 + 4, z: zW }, { x: d.x1 + 4, z: d.passZ }, { x: x + 18, z: d.passZ }, { x: x + 7, z: d.laneZ }, { x, z: d.laneZ }];
      }
      case 'scan': {
        const a = AREAS.scan;
        return east ? [{ x: a.xIn - 14, z: zE }, { x: a.xIn, z: zE }, { x: a.xIn, z: a.portal[1] + 6 }] : [{ x: a.xIn + 14, z: zW }, { x: a.xIn, z: zW }, { x: a.xIn, z: a.portal[1] + 6 }];
      }
      case 'cy': {
        const c = AREAS.cy;
        return east ? [{ x: c.x - 18, z: zE }, { x: c.x, z: zE }, { x: c.x, z: c.z }] : [{ x: c.x + 14, z: zW }, { x: c.x, z: zW }, { x: c.x, z: c.z }];
      }
      case 'park': {
        const pk = AREAS.park;
        const x = this.stallX(extra.tractor ?? 0);
        const in0 = east ? [{ x: pk.x1 - 12, z: zE }, { x: pk.x1 + 2, z: zE }] : [{ x: pk.x1 + 12, z: zW }, { x: pk.x1 + 2, z: zW }];
        return [...in0, { x: pk.x1 + 2, z: pk.laneIn }, { x: x + 4, z: pk.laneIn }, { x, z: pk.laneIn - 6 }, { x, z: (pk.stallZ[0] + pk.stallZ[1]) / 2 }];
      }
    }
  }
  /** 从节点出来上车道的那一段（end：出来以后往东还是往西） */
  private exitPts(node: PortNode, from: Pt, east: boolean, extra: { tractor?: number }): Pt[] {
    const zW = PL.zLaneW;
    const zE = PL.zLaneE;
    const lane = east ? zE : zW;
    switch (node) {
      case 'depot': {
        const d = AREAS.depot;
        const xp = Math.max(d.x0 + 2, from.x - 22);
        return [from, { x: Math.max(d.x0 + 8, from.x - 10), z: d.laneZ }, { x: xp, z: d.passZ }, { x: d.x0 - 4, z: d.passZ }, { x: d.x0 - 4, z: lane }, { x: d.x0 + (east ? 20 : 6), z: lane }];
      }
      case 'scan': {
        const a = AREAS.scan;
        return [from, { x: a.xIn, z: a.z0 + 2 }, { x: (a.xIn + a.xOut) / 2, z: a.z0 - 6 }, { x: a.xOut, z: a.z0 + 2 }, { x: a.xOut, z: lane }, { x: a.xOut + (east ? 18 : -18), z: lane }];
      }
      case 'cy': {
        const c = AREAS.cy;
        // 在通道里掉头，回到车道
        return [from, { x: c.x, z: c.z + 14 }, { x: c.x + 13, z: c.z + 14 }, { x: c.x + 13, z: zE + 2 }, { x: c.x + 13, z: lane }, { x: c.x + (east ? 30 : -10), z: lane }];
      }
      case 'park': {
        const pk = AREAS.park;
        void extra;
        // 出停车场走东边单独的一条（离进场的那条 7 米），进、出的拖车不在停车场口迎面碰上
        return [from, { x: from.x, z: pk.laneOut }, { x: pk.x1 + 9, z: pk.laneOut }, { x: pk.x1 + 9, z: lane }, { x: pk.x1 + (east ? 26 : -6), z: lane }];
      }
      default:
        return [from, { x: from.x + (east ? 12 : -12), z: lane }];
    }
  }

  private buildTractors(plan: PortHubPlan): void {
    const n = Math.max(0, ...plan.tractors.map((l) => l.tractor)) + 1;
    // 停车位：每辆拖车一个（拖车多的时候车位窄一点，最窄 3.2 米）
    this.stallPitch = Math.max(3.2, Math.min(4.4, (AREAS.park.x1 - AREAS.park.x0 - 2.4) / Math.max(1, n)));
    this.tracks = Array.from({ length: n }, () => []);
    this.parked = [];
    this.depotBookT = [];
    this.depotJobBay = new Map();
    /** 挂上箱从门口拉出来、在车道上等下一段的拖车：等的地方和时段（两辆不等在同一个地方） */
    const laneWaits: { x: number; z: number; a: number; b: number }[] = [];
    /** 每辆拖车此刻在空箱堆场停着的那一次（贝位、时段） */
    const depotStay: ({ bay: number; a: number; b: number } | undefined)[] = [];
    const docksByBox = new Map(plan.docks.filter((d) => d.face === 'cfs-box').map((d) => [d.box ?? d.id, d] as const));
    const insByBox = new Map(plan.inspections.filter((i) => i.bay !== undefined).map((i) => [i.box, i] as const));
    const chassisDims = 'chassis' as const;
    const bob = BOBTAIL.road;
    const bayOf = new Map(plan.depot.map((m) => [m.id, m.slot.bay] as const));
    /** 堆场交接点同时有几辆拖车（挂箱、等吊）：并排停（往西每 4.6 米一个车位），各占的时段 */
    const cySlots: [number, number][][] = Array.from({ length: 10 }, () => []);
    /** 从停车场出发的时刻（同一条出场车道）：前后隔 14 秒一辆，一早上班的时候不排成一串挤在一起 */
    const parkOut: number[] = [];
    for (let k = 0; k < n; k++) {
      const legs = plan.tractors.filter((l) => l.tractor === k).sort((a, b) => a.t0 - b.t0);
      const track = this.tracks[k] as Seg[];
      // 当前位置（港口局部坐标）和朝向
      let at: Pt = { x: this.stallX(k), z: (AREAS.park.stallZ[0] + AREAS.park.stallZ[1]) / 2 };
      let prevPt: Pt = { x: at.x, z: at.z + 1 };
      let atNode: PortNode = 'park';
      let tFree = -Infinity;
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i] as PortTractorLeg;
        const next = legs[i + 1];
        // 光车头在交接点、机检通道、空箱堆场这些大家都用的地方闲着超过 3 分钟：先回自己的停车位，不和别的拖车挤在一起
        const prevL = legs[i - 1];
        const after = prevL ? (prevL.then?.kind === 'drop' ? 'bobtail' : prevL.then?.kind === 'hook' ? 'chassis' : prevL.load) : 'full';
        // 光车头；空箱堆场卸完箱还拖着骨架车的也走（不占着贝位）
        const bare = after === 'bobtail' || (after === 'chassis' && atNode === 'depot');
        // 摘完挂车拉出来停在车道上的（拆装箱库、查验台门口出来）也回去，不在路上等
        const onRoad = Math.abs(at.z - PL.zLaneE) < 8 || Math.abs(at.z - PL.zLaneW) < 8;
        if (bare && atNode !== 'park' && ((atNode !== 'cfs' && atNode !== 'bay') || onRoad) && l.to !== atNode && l.t0 - tFree > (onRoad ? 60 : 180)) {
          const eastP = NODE_X.park > NODE_X[atNode];
          const ex = this.exitPts(atNode, at, eastP, { tractor: k });
          const en = this.entryPts('park', eastP, { tractor: k });
          const laneP = eastP ? PL.zLaneE : PL.zLaneW;
          const lineP = road([...ex, { x: (ex[ex.length - 1] as Pt).x, z: laneP }, { x: (en[0] as Pt).x, z: laneP }, ...en], 8);
          const rigP = forwardRig(after === 'bobtail' ? bob : chassisDims, lineP);
          const dur = rigP.length / 4.5 + 6;
          const back = this.exitPts('park', lineP[lineP.length - 1] as Pt, NODE_X[l.to] > NODE_X.park, { tractor: k });
          if (l.t0 - tFree > dur + new Polyline(back).length / 4.5 + 90) {
            track.push({ t0: tFree, t1: tFree + dur, rig: rigP, s0: 0, s1: rigP.length, load: after });
            at = lineP[lineP.length - 1] as Pt;
            prevPt = lineP[lineP.length - 2] ?? prevPt;
            atNode = 'park';
            tFree += dur;
          }
        }
        const east = NODE_X[l.to] > NODE_X[atNode];
        const color = l.color !== undefined ? boxHex(l.color) : l.own ? STORE_HEX : 0xffffff;
        // 1) 从现在的位置开出来、沿车道、拐进下一个节点
        let t0 = Math.max(l.t0, tFree);
        if (atNode === 'park' && l.to !== 'park') {
          for (let g = 0; g < 150 && parkOut.some((d) => Math.abs(d - t0) < 30); g++) t0 += 2;
          parkOut.push(t0);
        }
        const court = l.to === 'cfs' || l.to === 'bay';
        const sameNode = l.to === atNode;
        let depotBay = bayOf.get(next?.box ?? l.box ?? '') ?? idHash(`${k}:${i}`) % AREAS.depot.bays;
        const tBook = Math.max(l.t1, l.then?.t1 ?? l.t1, next?.t0 ?? l.t1 + 300) + 25;
        if (l.to === 'depot' && !sameNode) {
          // 空箱堆场：这个贝位这段时间有别的拖车停着就停到旁边空着的贝位（正面吊把箱吊过去），停的时段：开到以后到下一段出发
          const tA = Math.max(l.t0, tFree) + 20;
          const want = depotBay;
          depotBay = PortLogistics.freeDepotBay(this.depotBookT, want, tA - 40, tBook);
          const bk = { bay: depotBay, a: tA - 40, b: tBook };
          this.depotBookT.push(bk);
          depotStay[k] = bk;
          if (depotBay !== want) for (const id of [l.box, next?.box]) if (id && bayOf.has(id)) this.depotJobBay.set(id, depotBay);
        } else if (l.to === 'depot' && sameNode) {
          // 接着在同一个贝位吊箱：停的时段往后延，吊的这个箱也在这个贝位
          const bk = depotStay[k];
          if (bk) {
            bk.b = Math.max(bk.b, tBook);
            for (const id of [l.box, next?.box]) if (id && bayOf.has(id) && bayOf.get(id) !== bk.bay) this.depotJobBay.set(id, bk.bay);
          }
        } else depotStay[k] = undefined;
        const entryRaw = sameNode ? [] : this.entryPts(l.to, east, { ...(l.then?.door !== undefined ? { door: l.then.door } : {}), ...(l.then?.bay !== undefined ? { bay: l.then.bay } : {}), tractor: k, depotBay });
        if (l.to === 'cy' && !sameNode && entryRaw.length >= 2) {
          // 在交接点待到哪一刻（接着几段都在交接点：挂箱、放箱）
          let j = i + 1;
          while (j < legs.length && (legs[j] as PortTractorLeg).to === 'cy') j++;
          const tA = Math.max(l.t0, tFree);
          // 开走的时刻：下一段的计划时刻和在交接点最后一件事做完，取晚的
          let tB = (legs[j] as PortTractorLeg | undefined)?.t0 ?? tA + 600;
          for (let q = i; q < j; q++) tB = Math.max(tB, (legs[q] as PortTractorLeg).t1, (legs[q] as PortTractorLeg).then?.t1 ?? 0);
          let slot = cySlots.findIndex((sl) => sl.every(([a, b]) => b + 20 <= tA || tB + 20 <= a));
          if (slot < 0) slot = cySlots.reduce((bi, sl, i) => (Math.max(...sl.map(([, b]) => b)) < Math.max(...(cySlots[bi] as [number, number][]).map(([, b]) => b)) ? i : bi), 0);
          (cySlots[slot] as [number, number][]).push([tA, tB]);
          // 两边轮流：西 10、东 10、西 20……（相隔 10 米：从车道拐进来只开 20 多米，骨架车车尾还没完全摆直，6 米会蹭到旁边那辆）
          const dx = (slot % 2 ? 1 : -1) * 10 * Math.ceil((slot + 1) / 2);
          for (let q = entryRaw.length - 2; q < entryRaw.length; q++) entryRaw[q] = { x: (entryRaw[q] as Pt).x + dx, z: (entryRaw[q] as Pt).z };
        }
        const dims = l.load === 'bobtail' ? bob : chassisDims;
        let t1 = Math.max(t0 + (sameNode ? 2 : 5), l.t1);
        let line: Pt[];
        let courtS: number | undefined;
        if (sameNode && court) {
          // 同一个场地接下一辆（单车头）：从门口拉出来，沿驶离车道向西，在西头掉头上靠台车道，接着开到要挂的车的门
          const p = sectionPlan(l.to === 'cfs' ? 'port-cfs-box' : 'port-inspect');
          const zx = p.zExit + PL.zWall;
          const zc = p.zCourt + PL.zWall;
          const xT = p.xIn + 20;
          line = road([at, { x: at.x, z: zx - 7 }, { x: at.x - 9, z: zx }, { x: xT - 8, z: zx }, { x: xT - 8, z: zc }, { x: xT + 4, z: zc }], 5);
          track.push({ t0, t1: Math.max(t1, t0 + 14), rig: new BodyRig(line, false, bob.wheelbase), s0: 0, s1: new Polyline(line).length, load: 'bobtail' });
          courtS = xT + 4;
          tFree = Math.max(t1, t0 + 14);
          at = line[line.length - 1] as Pt;
          prevPt = line[line.length - 2] ?? prevPt;
        } else if (sameNode) {
          // 原地（堆场交接点挂骨架车以后接着放箱、空箱堆场接着吊箱）
          line = [prevPt, at];
          tFree = t1;
        } else {
          const pts = atNode === 'cfs' || atNode === 'bay' ? [at, { x: at.x + (east ? 14 : -14), z: east ? PL.zLaneE : PL.zLaneW }] : this.exitPts(atNode, at, east, { tractor: k });
          const lane = east ? PL.zLaneE : PL.zLaneW;
          const mid: Pt[] = [{ x: (pts[pts.length - 1] as Pt).x, z: lane }, { x: (entryRaw[0] as Pt).x, z: lane }];
          line = road([...pts, ...mid, ...entryRaw], 8);
          const rig = forwardRig(dims, line.length > 1 ? line : [line[0] as Pt, { x: (line[0] as Pt).x + 0.1, z: (line[0] as Pt).z }]);
          // 前一段晚了也不能开得太快（平均不超过 8 米 / 秒）
          t1 = Math.max(t1, t0 + rig.length / 8);
          track.push({ t0, t1, rig, s0: 0, s1: rig.length, load: l.load, color });
          at = line[line.length - 1] as Pt;
          prevPt = line[line.length - 2] ?? prevPt;
          tFree = t1;
        }
        atNode = l.to;
        // 2) 到了以后做的事
        const th = l.then;
        if (!th) continue;
        if ((th.kind === 'drop' || th.kind === 'hook') && (l.to === 'cfs' || l.to === 'bay')) {
          const key = l.to === 'cfs' ? 'port-cfs-box' : 'port-inspect';
          const door = (l.to === 'cfs' ? th.door : th.bay) ?? 0;
          const nextWest = next ? NODE_X[next.to] < NODE_X[l.to] : false;
          const r = routeOf(key, door, nextWest);
          const sEnd = r.lane.length;
          const sHand = laneHand(r, sectionPlan(key));
          const laneRig = { length: r.laneRig.length, poseAt: (s: number, o: RigPose) => r.laneRig.poseAt(s, o) } as DistRig;
          if (th.kind === 'drop') {
            // 送箱：沿进场道路、靠台车道开到倒车起点（打双闪等着），倒车靠台，摘挂
            const enterEnd = Math.max(tFree + 8, Math.min(th.t0 - 20, tFree + 70));
            track.push({ t0: tFree, t1: enterEnd, rig: laneRig, s0: sHand, s1: sEnd, local: true, load: l.load, color });
            if (th.t0 > enterEnd) track.push({ t0: enterEnd, t1: th.t0, rig: laneRig, s0: sEnd, s1: sEnd, local: true, load: l.load, color, hazard: true });
            const backEnd = Math.max(th.t0 + 20, th.t1 - MANEUVER.couple);
            track.push({ t0: th.t0, t1: backEnd, rig: r.back.rig, s0: 0, s1: r.back.rig.length, timed: { path: r.back.path, dur: r.back.path.duration }, local: true, load: l.load, color, rev: true });
            const pk = POSE();
            Object.assign(pk, r.parked);
            pk.z += PL.zWall;
            // 骨架车停在门口，一直到来挂走（找这个箱的靠台记录 / 查验记录）
            const dk = l.to === 'cfs' ? docksByBox.get(l.box ?? '') : undefined;
            const ins = l.to === 'bay' ? insByBox.get(l.box ?? '') : undefined;
            const hookAt = dk ? dk.pullAt - MANEUVER.couple : ins?.open ? ins.open[1] + 5 * 60 : th.t1 + 3600;
            this.parked.push({ t0: backEnd, t1: hookAt, pose: pk, color });
            // 车头（单车头）在门口摘挂
            const bobRig = new BodyRig([{ x: pk.x, z: pk.z }, { x: pk.x + Math.sin(pk.heading) * 0.1, z: pk.z + Math.cos(pk.heading) * 0.1 }], false, bob.wheelbase);
            track.push({ t0: backEnd, t1: th.t1, rig: bobRig, s0: 0, s1: 0, load: 'bobtail' });
            // 下一段还在这个场地（接着去挂别的车）：先不开出去，在门口等着
            if (next && next.to === l.to) {
              at = { x: pk.x, z: pk.z };
              prevPt = { x: pk.x, z: pk.z - 1 };
              tFree = th.t1;
              continue;
            }
            // 单车头开出来：照着驶出路线开到车道上；要在车道上等下一段的，那一点这段时间有别的拖车等着，就顺着驶出路线再往前开一个车位
            const cut0 = exitCut(r);
            let cut = cut0;
            {
              const out0 = th.t1 + Math.max(25, cut0 / 4.2);
              const until = Math.max(out0, next?.t0 ?? out0);
              const p0 = POSE();
              for (let slot = 0; slot < 4; slot++) {
                const c = Math.min(r.exit.rig.length, cut0 + slot * 21);
                r.exit.rig.poseAt(c, p0);
                const w = toPortPt({ x: p0.x, z: p0.z });
                cut = c;
                if (!laneWaits.some((q) => Math.hypot(q.x - w.x, q.z - w.z) < 19 && q.a < until + 5 && out0 - 5 < q.b)) {
                  laneWaits.push({ x: w.x, z: w.z, a: out0, b: until });
                  break;
                }
              }
            }
            const exitPts: Pt[] = [];
            const p = POSE();
            for (let s = 0; s <= cut; s += 1.5) {
              r.exit.rig.poseAt(s, p);
              exitPts.push(toPortPt({ x: p.x, z: p.z }));
            }
            const outEnd = th.t1 + Math.max(25, cut / 4.2);
            if (exitPts.length > 1) track.push({ t0: th.t1, t1: outEnd, rig: new BodyRig(exitPts, false, bob.wheelbase), s0: 0, s1: new Polyline(exitPts).length, load: 'bobtail' });
            at = exitPts[exitPts.length - 1] ?? at;
            prevPt = exitPts[exitPts.length - 2] ?? prevPt;
            tFree = outEnd;
          } else {
            // 挂走：单车头开到倒车起点，照着当初倒车时牵引销走的路线倒回去，挂上，拉出
            const enterEnd = Math.max(tFree + 8, Math.min(th.t0 - 50, tFree + 70));
            // 同一个场地接着来的：已经在靠台车道上了，从那一点接引擎的路线
            let sFrom = sHand;
            if (courtS !== undefined) {
              const q = POSE();
              for (let s = sHand; s < sEnd; s += 0.5) {
                r.laneRig.poseAt(s, q);
                if (q.x >= courtS && Math.abs(q.z - r.laneRig.length * 0 - sectionPlan(key).zCourt) < 1) {
                  sFrom = s;
                  break;
                }
              }
            }
            const bobLane = new BodyRig(r.lane.from(sFrom), false, bob.wheelbase);
            track.push({ t0: tFree, t1: enterEnd, rig: bobLane, s0: 0, s1: bobLane.length, local: true, load: 'bobtail' });
            const kp = kingpinPath(r, `${key}:${door}`);
            const revRig = new BodyRig(kp, true, bob.wheelbase);
            const revStart = Math.max(enterEnd, th.t0 - 45);
            if (revStart > enterEnd) track.push({ t0: enterEnd, t1: revStart, rig: bobLane, s0: bobLane.length, s1: bobLane.length, local: true, load: 'bobtail', hazard: true });
            track.push({ t0: revStart, t1: th.t0, rig: revRig, s0: 0, s1: revRig.length, local: true, load: 'bobtail', rev: true });
            const pk = POSE();
            Object.assign(pk, r.parked);
            const parkRig = forwardRig(chassisDims, [{ x: pk.x, z: pk.z }, { x: pk.x + Math.sin(pk.heading) * 0.1, z: pk.z + Math.cos(pk.heading) * 0.1 }], pk.trailer);
            track.push({ t0: th.t0, t1: th.t1, rig: parkRig, s0: 0, s1: 0, local: true, load: next?.load ?? 'full', color: next?.color !== undefined ? boxHex(next.color) : color });
            prevPt = { x: pk.x, z: pk.z + PL.zWall - 1 };
            // 拉出：引擎的驶出路线（带着骨架车）开到车道上；要在车道上等下一段的，那一点这段时间有别的拖车等着，就顺着驶出路线再往前开一个车位
            const cut0 = exitCut(r);
            const outEnd = th.t1 + Math.max(30, r.exit.tClear + 20);
            let cut = cut0;
            {
              const until = Math.max(outEnd, next?.t0 ?? outEnd);
              const p0 = POSE();
              for (let slot = 0; slot < 4; slot++) {
                const c = Math.min(r.exit.rig.length, cut0 + slot * 21);
                r.exit.rig.poseAt(c, p0);
                const w = toPortPt({ x: p0.x, z: p0.z });
                cut = c;
                if (!laneWaits.some((q) => Math.hypot(q.x - w.x, q.z - w.z) < 19 && q.a < until + 5 && outEnd - 5 < q.b)) {
                  laneWaits.push({ x: w.x, z: w.z, a: outEnd, b: until });
                  break;
                }
              }
            }
            track.push({ t0: th.t1, t1: outEnd + (cut - cut0) / 5, rig: r.exit.rig, s0: 0, s1: cut, local: true, load: next?.load ?? 'full', color: next?.color !== undefined ? boxHex(next.color) : color });
            const p = POSE();
            r.exit.rig.poseAt(cut, p);
            at = toPortPt({ x: p.x, z: p.z });
            prevPt = { x: at.x + (nextWest ? 1 : -1), z: at.z };
            tFree = outEnd + (cut - cut0) / 5;
          }
          continue;
        }
        // 其它：原地停着（堆场交接点放箱 / 取箱、正面吊卸空箱 / 吊上空箱、开过机检门架）
        if (th.kind === 'scan') {
          const a = AREAS.scan;
          const pts2 = [at, { x: a.xIn, z: a.portal[0] - 4 }];
          const rig2 = forwardRig(chassisDims, pts2);
          track.push({ t0: Math.max(th.t0, tFree), t1: Math.max(th.t1, tFree + 10), rig: rig2, s0: 0, s1: rig2.length, load: l.load, color });
          prevPt = at;
          at = pts2[1] as Pt;
          tFree = Math.max(th.t1, tFree + 10);
        } else {
          const stillRig = forwardRig(l.load === 'bobtail' ? bob : chassisDims, [prevPt, at]);
          // 箱在作业做完的那一刻换（放下 / 吊上）
          const after: PortTractorLeg['load'] = th.kind === 'unload' ? 'chassis' : th.kind === 'loadEmpty' ? 'empty' : th.kind === 'cy' ? (l.load === 'full' ? 'chassis' : next?.load === 'full' ? 'full' : l.load) : l.load;
          const mid2 = (th.t0 + th.t1) / 2;
          track.push({ t0: Math.max(tFree, th.t0 - 1), t1: mid2, rig: stillRig, s0: stillRig.length, s1: stillRig.length, load: l.load, color });
          track.push({ t0: mid2, t1: th.t1, rig: stillRig, s0: stillRig.length, s1: stillRig.length, load: after, color: next?.color !== undefined ? boxHex(next.color) : color });
          tFree = Math.max(tFree, th.t1);
        }
      }
      track.sort((a, b) => a.t0 - b.t0);
    }
  }

  // ———————————————————————— 空箱堆场 ————————————————————————

  /** 这个时段 [a, b] 里空着的贝位：先看想要的贝位，再往两边找（都占着就还用想要的） */
  private static freeDepotBay(book: readonly { bay: number; a: number; b: number }[], want: number, a: number, b: number): number {
    const n = AREAS.depot.bays;
    const free = (k: number) => book.every((x) => x.bay !== k || x.b <= a || b <= x.a);
    for (let d = 0; d < n; d++)
      for (const k of d ? [want - d, want + d] : [want]) if (k >= 0 && k < n && free(k)) return k;
    return want;
  }
  private slotPos(s: { block: number; bay: number; row: number; tier: number }): { x: number; z: number; y: number } {
    const d = AREAS.depot;
    return { x: d.x0 + (s.bay + 0.5) * d.bayPitch, z: (d.blocks[s.block] as { z: number }).z + s.row * d.rowPitch, y: s.tier * 2.59 };
  }
  private buildDepot(plan: PortHubPlan): void {
    // 每个箱位的占用：0 点的存货（取走的时刻）、拆空的箱放进来、装箱用的空箱取走、外面的集卡还箱 / 提箱
    const occ = new Map<string, { x: number; z: number; y: number; t0: number; t1: number; color: number }[]>();
    const key = (s: { block: number; bay: number; row: number; tier: number }) => `${s.block}:${s.bay}:${s.row}:${s.tier}`;
    for (const d of plan.depot0) {
      const p = this.slotPos(d.slot);
      occ.set(key(d.slot), [{ ...p, t0: -Infinity, t1: d.out ?? Infinity, color: boxHex(d.color) }]);
    }
    for (const m of [...plan.depot].sort((a, b) => a.start - b.start)) {
      const k = key(m.slot);
      const list = occ.get(k) ?? [];
      const p = this.slotPos(m.slot);
      if (m.kind === 'from-cfs' || m.kind === 'return') list.push({ ...p, t0: m.end, t1: Infinity, color: boxHex(m.color) });
      else {
        const cur = [...list].reverse().find((u) => u.t0 <= m.start && u.t1 > m.start);
        if (cur) cur.t1 = m.start + MANEUVER.reach * 0.4;
      }
      occ.set(k, list);
    }
    this.slots = [...occ.values()].flat();
    // 正面吊：每次吊箱停在车位旁边（装卸车道和箱区之间），箱从车上到箱位（或反过来）
    const d = AREAS.depot;
    this.stackJobs = plan.depot.map((m) => {
      const p = this.slotPos(m.slot);
      const jb = this.depotJobBay.get(m.id);
      const onTruck = { x: jb !== undefined ? d.x0 + (jb + 0.5) * d.bayPitch : p.x, z: d.laneZ, y: 1.55 };
      const inStack = { x: p.x, z: p.z, y: p.y };
      const toStack = m.kind === 'from-cfs' || m.kind === 'return';
      const sz = m.slot.block === 0 ? (d.stackerZ[0] as number) : (d.stackerZ[1] as number);
      // 南边的箱区在 +z：吊具朝箱区
      return { t0: m.start, t1: m.end, x: p.x, z: sz, yaw: m.slot.block === 0 ? -Math.PI / 2 : Math.PI / 2, from: toStack ? onTruck : inStack, to: toStack ? inStack : onTruck, color: boxHex(m.color), stacker: m.slot.block };
    });
    // 同一个箱区两单的时段叠在一起：另一台正面吊空着就开过来吊（两个箱都画出来）
    // （离得近的不换：两台吊不挤在一起，箱照样都画）
    const busy = [-Infinity, -Infinity];
    const at = [Infinity, Infinity];
    for (const j of [...this.stackJobs].sort((a, b) => a.t0 - b.t0)) {
      const k = j.stacker;
      // （不再把另一台吊调过来：两台正面吊挤进同一个箱区会碰在一起；叠在一起的几单由本箱区的吊做，箱照样都画）
      void k;
      busy[j.stacker] = Math.max(busy[j.stacker] as number, j.t1);
      at[j.stacker] = j.x;
    }
  }

  // ———————————————————————— 外面的车（交给外来车层） ————————————————————————

  /**
   * 外面的车的整趟（外来车层画）：闸口外排队 → 进闸 → 沿车道开到场地的进场道路外口 →（场地里由这里按收货场引擎画）→
   * 从驶出路线的终点沿车道开回闸口 → 出闸。空箱堆场的集卡全程由外来车层画（车上的箱按正面吊吊箱的时刻换）。
   * lanes：闸口进、出各几条车道的 x（港口的 GATE_X 起算）；gateZ：闸口的 z；inAt 之前在闸口交单。
   */
  trips(gate: { laneIn: number[]; laneOut: number[]; z: number; busy: (k: number, t: number) => boolean; junction?: number[]; junctionIv?: [number, number][] }): LogiTrip[] {
    return drain(this.tripsSteps(gate));
  }
  /** 和 trips 一样，分成小段算（场内拖车的让行一辆一段） */
  *tripsSteps(gate: { laneIn: number[]; laneOut: number[]; z: number; busy: (k: number, t: number) => boolean; junction?: number[]; junctionIv?: [number, number][] }): Steps<LogiTrip[]> {
    const plan = this.plan;
    if (!plan) return [];
    // 过了道闸的路口一次过一辆：和港口的集卡、别的物流中心的车错开（各自过路口的时刻隔 9 秒以上）；最西边那条进闸车道上前后两辆隔开交单的时间
    const lane0: number[] = [];
    // 和港口的集卡同一张预订表（portLayout 的 JunctionBook，同一个路口范围、同一个占用时段的算法）；拷一份，不改港口计划里的那张。
    // 进来的车（最西边的进闸车道、右转进向西的车道）和出去的车（向东的车道、左转进出闸车道）路线不交叉，各记各的
    const jbIn = new JunctionBook([...(gate.junctionIv ?? [])]);
    const jbOut = new JunctionBook([...(gate.junctionIv ?? [])]);
    const lane0Ok = (t: number) => !lane0.some((a) => Math.abs(a - t) < MANEUVER.booth + 8);
    /**
     * 出闸的车排队的「口袋」：路口西头、港口的第二条进闸车道前面那一截向东车道（港口的车不走这里），车头停在那条进闸车道前 4.4 米，
     * 往后每辆 18.2 米（第 3 辆的车头在场地口，收货场引擎交车的地方）。先到先走：前面的车开走 6 秒以后后面的才走；
     * 路口空着、前面没有车在等就直接开过去。过路口的时段和港口的车错开（同一张预订表）。
     */
    const P0 = (gate.laneIn.length >= 2 ? (gate.laneIn[1] as number) : (gate.laneIn[0] as number)) - 4.4;
    const pocket: { t0: number; depart: number; slot: number }[] = [];
    const lastSpan = (legs: ReturnType<typeof outLegs>, L: number) => {
      const l = legs[legs.length - 1] as ReturnType<typeof outLegs>[number];
      return junctionSpan(l.pts, l.t0, l.t1, l.u0, L);
    };
    let overflow = 0;
    const pocketExit = (pts: Pt[], lead: number, t0: number, t1: number, headX: number, L: number) => {
      const total = new Polyline(pts).length;
      const uAt = (x: number) => Math.max(lead, Math.min(total - 5, lead + (x - headX)));
      const tAt = (u: number) => t0 + (t1 - t0) * ((u - lead) / Math.max(1, total - lead));
      const ahead = pocket.filter((q) => q.depart + 6 > t0 + 2);
      const slot = ahead.length ? Math.max(...ahead.map((q) => q.slot)) + 1 : 0;
      if (slot > POCKET_MAX) overflow++;
      const uStop = uAt(P0 - 18.2 * Math.min(slot, POCKET_MAX));
      const tStop = tAt(uStop);
      const h0 = ahead.length ? Math.max(0, Math.ceil(Math.max(...ahead.map((q) => q.depart)) + 6 - tStop)) : 0;
      // 停下等的那几种走法形状都一样、只是时刻往后挪：算一次占用时段再挪（不用每试一次重算一遍）
      const sp0 = h0 <= 0 ? lastSpan(outLegs(pts, lead, t0, t1, 0, uStop), L) : undefined;
      const sp1 = lastSpan(outLegs(pts, lead, t0, t1, 1, uStop), L);
      const spanH = (h: number): [number, number] | undefined => (h <= 0 ? sp0 : sp1 ? [sp1[0] + h - 1, sp1[1] + h - 1] : undefined);
      let hold = h0;
      while (hold < h0 + 400 && jbOut.busy(spanH(hold))) hold += 2;
      if (hold >= h0 + 400) hold = h0;
      const legs = outLegs(pts, lead, t0, t1, hold, uStop);
      pocket.push({ t0, depart: tStop + hold, slot: hold > 0 ? Math.min(slot, POCKET_MAX) : -1 });
      return { legs, hold };
    };
    /** 收货场引擎开着的车在物流中心的路（向东车道）上：每 2 秒一个车头的 x（空箱堆场的车开上这条路时前后让开） */
    const engineAt = new Map<number, number[]>();
    const out: LogiTrip[] = [];
    const pickLane = (list: number[], t: number, dir: 'in' | 'out') => {
      for (let i = 0; i < list.length; i++) {
        const k = dir === 'in' ? i : i + 3;
        if (!gate.busy(k, t)) return i;
      }
      return Math.floor(t / 97) % list.length;
    };
    const zQ = gate.z - 40;
    // 按交车的先后排（口袋里先到先走）；排好以后按原来的顺序放回去
    const dockTrips = new Map<PortDock, LogiTrip>();
    for (const d of [...plan.docks].sort((a, b) => (a.tl?.goneAt ?? 0) - (b.tl?.goneAt ?? 0))) {
      if (d.face === 'cfs-box' || !d.tl) continue;
      const key = d.face === 'bonded' ? 'port-bonded' : 'port-cfs-truck';
      // 和登记给场地的是同一份排程的结果（同样的输入、同样的时间线），这里不用再排一遍
      const tl = d.tl;
      const p = sectionPlan(key);
      const handIn = this.handIn.get(d.id) ?? tl.segs[0]?.t0 ?? d.arrive;
      const handOut = tl.goneAt;
      const front = dimsOf(d.reefer ? 'reefer' : 'semi');
      const fr = front.kind === 'rig' ? front.front : 4.4;
      const lo = pickLane(gate.laneOut, handOut + 30, 'out');
      const xo = gate.laneOut[lo] as number;
      // 进：排队点 → 道闸前（交单）→ 过杆、开到向西的车道、右转进进场道路，车头开到车身摆直的地方（牵引销接引擎的路线）。
      // 引擎让它在场外等的（门一时空不出来）在等候区等够了再进闸，不堵车道
      // 进闸走最西边的车道（过杆以后右转向西，不和去码头箱区、往东左转的车交叉）
      const li0 = 0;
      const xi0 = gate.laneIn[li0] as number;
      let headZ = handZ(p) + PL.zWall - fr;
      {
        const u0 = poseAt(tl, handIn + 1e-3)?.units[0];
        if (u0) {
          const fp = toPortPt({ x: u0.pose.x + Math.sin(u0.pose.heading) * fr, z: u0.pose.z + Math.cos(u0.pose.heading) * fr });
          if (Math.abs(fp.x - p.xIn) < 3 && Math.abs(fp.z - headZ) < 40) headZ = fp.z;
        }
      }
      const inPts = road([{ x: xi0, z: gate.z - 4 }, { x: xi0, z: PL.zLaneW }, { x: p.xIn, z: PL.zLaneW }, { x: p.xIn, z: headZ }], 10.5);
      const inLen = new Polyline(inPts).length;
      // 过道闸的时刻：路口、车道上有车就往前挪（在闸口外排队等着、进来以后慢一点开到场地口，不赶）
      let inAt = handIn - Math.max(25, inLen / 5);
      const inSpan = (t: number) => junctionSpan(inPts, t, handIn, 0, 16.6);
      // 港口自己的集卡也走最西边的进闸车道：道闸前同一时刻只停一辆（港口的车过杆前后 70 秒里不排）
      for (let k = 0; k < 60 && (jbIn.busy(inSpan(inAt)) || !lane0Ok(inAt)); k++) inAt -= 4;
      jbIn.add(inSpan(inAt));
      lane0.push(inAt);
      const li = 0;
      const xi = gate.laneIn[li] as number;
      const inPts2 = li === li0 ? inPts : road([{ x: xi, z: gate.z - 4 }, { x: xi, z: PL.zLaneW }, { x: p.xIn, z: PL.zLaneW }, { x: p.xIn, z: headZ }], 10.5);
      const booth = MANEUVER.booth;
      // 出：引擎的驶出路线开到物流中心东头的向东车道上，车头接着沿车道开、左转进出闸车道（前面留一段直线，挂车落在路上）
      const endPose = POSE();
      const info = poseAt(tl, handOut - 0.01);
      if (info) Object.assign(endPose, info.units[0]?.pose ?? endPose);
      const endPt = toPortPt({ x: endPose.x, z: endPose.z });
      const headX = endPt.x + fr;
      const LEAD = 26;
      const outPts = [{ x: headX - LEAD, z: endPt.z }, ...road([{ x: headX, z: endPt.z }, { x: xo, z: endPt.z }, { x: xo, z: zQ }], 11)];
      const tOut0 = handOut + Math.max(30, (new Polyline(outPts).length - LEAD) / 5);
      // 出来过闸口里面的路口（穿过港口进闸的车道、拐进出闸车道）：和港口进出闸的车错开；要等就在路口西头的口袋里排队，不在物流中心的路上等
      const ex = pocketExit(outPts, LEAD, handOut, tOut0, headX, 16.6);
      const tOut = tOut0 + ex.hold;
      // 引擎开着它在路上的那一段（交车前）记下来
      for (let t = Math.ceil((handOut - 240) / 2) * 2; t < handOut; t += 2) {
        const u = poseAt(tl, t)?.units[0];
        if (!u) continue;
        const fp = toPortPt({ x: u.pose.x + Math.sin(u.pose.heading) * fr, z: u.pose.z + Math.cos(u.pose.heading) * fr });
        if (Math.abs(fp.z - PL.zLaneE) > 2.5) continue;
        const l = engineAt.get(t) ?? [];
        l.push(fp.x);
        engineAt.set(t, l);
      }
      dockTrips.set(d, {
        t0: inAt - booth - 6,
        t1: tOut,
        load: false,
        box: 0,
        inK: li,
        outK: 3 + lo,
        inAt,
        legs: [
          { t0: inAt - booth - 6, t1: inAt, pts: [{ x: xi, z: zQ }, { x: xi, z: gate.z - 4 }] },
          { t0: inAt, t1: handIn, pts: inPts2 },
          { t0: handIn, t1: handOut, hidden: true },
          ...ex.legs,
        ],
        build: d.reefer ? 2 : 1,
        cab: cabOf(d.id),
        trailer: trailerOf(d.id),
      });
    }
    for (const d of plan.docks) {
      const tr = dockTrips.get(d);
      if (tr) out.push(tr);
    }
    // 空箱堆场的集卡：进闸 → 沿车道向西 → 从东头拐进装卸车道 → 停在箱位旁（正面吊吊箱）→ 从西头出来 → 沿车道向东回闸口
    const dp = AREAS.depot;
    /** 空箱堆场出来的车在西头拐上大路之前那一段排队（堆场里面）：先到先走 */
    const depQ: { depart: number; slot: number }[] = [];
    /** 空箱堆场的车开上大路的那一段：和引擎开着的车前后错开 21 米以上；口袋里有车在等、刚交出来的时候不从那里开过去 */
    /** 这一段每 2 秒的车头位置（在物流中心的向东车道上的）：同一个形状往后挪偶数秒时取样点不变，只挪时刻 */
    const depotSamples = (l: { t0: number; t1: number; pts: Pt[]; u0: number }) => {
      const total = new Polyline(l.pts).length;
      const out: { t: number; x: number; z: number }[] = [];
      for (let t = Math.ceil(l.t0 / 2) * 2; t <= l.t1; t += 2) {
        const q = ptAt(l.pts, l.u0 + (total - l.u0) * ease((t - l.t0) / Math.max(1e-3, l.t1 - l.t0)));
        if (Math.abs(q.z - PL.zLaneE) <= 2.5) out.push({ t, x: q.x, z: q.z });
      }
      return out;
    };
    const depotClear = (sm: { t: number; x: number; z: number }[], off: number) => {
      let a = Infinity;
      let b = -Infinity;
      for (const s of sm) {
        const t = s.t + off;
        for (const xe of engineAt.get(t) ?? []) if (Math.abs(xe - s.x) < 21) return false;
        if (s.x > -2184 && s.x < P0 + 20) {
          a = Math.min(a, t);
          b = Math.max(b, t);
        }
      }
      return !(a <= b && pocket.some((p) => p.t0 - 4 < b + 2 && a - 2 < p.depart + 10));
    };
    const depotBook = [...this.depotBookT];
    for (const m of [...plan.depot].sort((p, q) => p.gone - q.gone)) {
      if ((m.kind !== 'return' && m.kind !== 'pickup') || m.gateIn === undefined || m.gateOut === undefined) continue;
      const li = 0;
      const lo = pickLane(gate.laneOut, m.gateOut + 60, 'out');
      const xi = gate.laneIn[li] as number;
      const xo = gate.laneOut[lo] as number;
      // 车头朝西停：车上的箱（箱中心在车头后 9.5 米）对着箱位；这个贝位这段时间有车（拖车、先排的集卡）就停到旁边空着的贝位，正面吊把箱吊过去
      const bay = PortLogistics.freeDepotBay(depotBook, m.slot.bay, m.start - 60, m.gone + 25);
      depotBook.push({ bay, a: m.start - 60, b: m.gone + 25 });
      const bx = dp.x0 + (bay + 0.5) * dp.bayPitch;
      const job = this.stackJobs[plan.depot.indexOf(m)];
      if (job) {
        // 还箱：箱从车上吊进箱区（起点在车上）；提箱反过来
        (m.kind === 'return' ? job.from : job.to).x = bx;
      }
      const stop = { x: bx - 9.5, z: dp.laneZ };
      const inPts = road([{ x: xi, z: gate.z - 4 }, { x: xi, z: PL.zLaneW }, { x: dp.x1 + 4, z: PL.zLaneW }, { x: dp.x1 + 4, z: dp.passZ }, { x: stop.x + 26, z: dp.passZ }, { x: stop.x + 12, z: dp.laneZ }, stop], 9);
      const outPts = road([stop, { x: Math.max(dp.x0 + 8, stop.x - 10), z: dp.laneZ }, { x: Math.max(dp.x0 + 2, stop.x - 22), z: dp.passZ }, { x: dp.x0 - 6, z: dp.passZ }, { x: dp.x0 - 6, z: PL.zLaneE }, { x: xo, z: PL.zLaneE }, { x: xo, z: gate.z - 40 }], 9);
      const box0 = m.kind === 'return' ? m.color : undefined;
      const box1 = m.kind === 'pickup' ? m.color : undefined;
      const colorOf = (c: number | undefined) => (c === undefined ? undefined : boxHex(c));
      // 场内车速：平均不超过 4.5 米 / 秒（路线长的车早一点进闸、晚一点出闸）
      const arriveStop = m.start - 5;
      let inAt = Math.min(m.gateIn, arriveStop - new Polyline(inPts).length / 4.5);
      const dSpan = (t: number) => junctionSpan(inPts, t, Math.max(t + 30, m.start - 5), 0, 17.5);
      for (let k = 0; k < 60 && (jbIn.busy(dSpan(inAt)) || !lane0Ok(inAt)); k++) inAt -= 4;
      jbIn.add(dSpan(inAt));
      lane0.push(inAt);
      const dTotal = new Polyline(outPts).length;
      const outEnd0 = Math.max(m.gateOut, m.gone + dTotal / 4.5);
      // 出来要等（路口、物流中心的路上、口袋里有车）就在堆场西头拐上大路之前那一段等（车头离大路的边 4 米，往后每辆 19 米，还在堆场里面）
      let uC = 0;
      for (let u = 0; u <= dTotal; u += 1) {
        const q = ptAt(outPts, u);
        if (q.x < dp.x0 - 2 && q.z >= PL.zFence - 4.5) {
          uC = u;
          break;
        }
      }
      const tC = m.gone + (outEnd0 - m.gone) * (uC / Math.max(1, dTotal));
      const aheadD = depQ.filter((q) => q.depart + 6 > tC);
      const slotD = aheadD.length ? Math.max(...aheadD.map((q) => q.slot)) + 1 : 0;
      const uStopD = Math.max(1, uC - 19 * slotD);
      const tStopD = m.gone + (outEnd0 - m.gone) * (uStopD / Math.max(1, dTotal));
      const h0 = aheadD.length ? Math.max(0, Math.ceil(Math.max(...aheadD.map((q) => q.depart)) + 6 - tStopD)) : 0;
      // 不停的走法、停下等的走法（形状一样，只是往后挪）各算一次；停的那种按奇偶各取一次样
      const lg0 = outLegs(outPts, 0, m.gone, outEnd0, 0, uStopD);
      const lg1 = outLegs(outPts, 0, m.gone, outEnd0, 1, uStopD);
      const last0 = lg0[lg0.length - 1] as ReturnType<typeof outLegs>[number];
      const last1 = lg1[lg1.length - 1] as ReturnType<typeof outLegs>[number];
      const sp0 = lastSpan(lg0, 17.5);
      const sp1 = lastSpan(lg1, 17.5);
      const sm0 = depotSamples(last0);
      const smP = [depotSamples(last1), depotSamples({ ...last1, t0: last1.t0 + 1, t1: last1.t1 + 1 })];
      const okD = (h: number) => {
        if (h <= 0) return !jbOut.busy(sp0) && depotClear(sm0, 0);
        const d = (((h - 1) % 2) + 2) % 2;
        return !jbOut.busy(sp1 ? [sp1[0] + h - 1, sp1[1] + h - 1] : undefined) && depotClear(smP[d] as { t: number; x: number; z: number }[], h - 1 - d);
      };
      let dHold = h0;
      while (dHold < h0 + 900 && !okD(dHold)) dHold += 4;
      if (dHold >= h0 + 900) dHold = h0;
      depQ.push({ depart: tStopD + dHold, slot: dHold > 0 ? slotD : -1 });
      const outEnd = outEnd0 + dHold;
      out.push({
        t0: inAt - MANEUVER.booth - 6,
        t1: outEnd,
        load: m.kind === 'pickup',
        box: colorOf(box0 ?? box1) ?? 0,
        inK: li,
        outK: 3 + lo,
        inAt,
        legs: [
          { t0: inAt - MANEUVER.booth - 6, t1: inAt, pts: [{ x: xi, z: gate.z - 40 }, { x: xi, z: gate.z - 4 }], ...(box0 !== undefined ? { box: colorOf(box0) as number } : {}) },
          { t0: inAt, t1: Math.max(inAt + 30, m.start - 5), pts: inPts, ...(box0 !== undefined ? { box: colorOf(box0) as number } : {}) },
          { t0: Math.max(inAt + 30, m.start - 5), t1: (m.start + m.end) / 2, at: { x: stop.x, z: stop.z, yaw: Math.PI }, ...(box0 !== undefined ? { box: colorOf(box0) as number } : {}) },
          { t0: (m.start + m.end) / 2, t1: m.gone, at: { x: stop.x, z: stop.z, yaw: Math.PI }, ...(box1 !== undefined ? { box: colorOf(box1) as number } : {}) },
          ...outLegs(outPts, 0, m.gone, outEnd0, dHold, uStopD).map((l) => ({ ...l, ...(box1 !== undefined ? { box: colorOf(box1) as number } : {}) })),
        ],
        build: 0,
        cab: cabOf(m.id),
        trailer: 0xffffff,
      });
    }
    this.lastTrips = out;
    this.pocketOverflow = overflow;
    // 外面的车都排好了：接着排场内拖车的让行（和外来车层的排程一起，在换一天的那一下做完，不在画面里卡一帧）
    yield* this.yieldTractors();
    return out;
  }

  // ———————————————————————— 画 ————————————————————————

  /** 第 k 辆拖车此刻的位姿（港口局部坐标）；两段之间停在上一段的终点，第一段之前在停车位 */
  tractorAt(k: number, t: number, out: RigPose): { load: PortTractorLeg['load']; color?: number; hazard?: boolean } | undefined {
    const track = this.tracks[k];
    if (!track?.length) return undefined;
    let g: Seg | undefined;
    let last: Seg | undefined;
    for (const s of track) {
      if (t >= s.t0 && t < s.t1) g = s;
      if (s.t1 <= t) last = s;
    }
    if (g) {
      segPose(g, t, out);
      return g;
    }
    const s = last ?? (track[0] as Seg);
    segPose(s, last ? s.t1 : s.t0, out);
    return s;
  }
  get tractorCount(): number {
    return this.tracks.length;
  }

  /** 画铰接车或单车头（港口局部坐标的位姿）：牵引车、骨架车 / 挂车、箱 */
  private drawRig(pose: RigPose, load: PortTractorLeg['load'], color: number, cabPool: Pool, cabColor: number, trailerPool?: Pool, trailerColor = 0xffffff, cabKp = (MODEL_SPECS.terminalTractor.kingpin as number) ?? 1.45, trKp = (MODEL_SPECS.chassis.kingpin as number) ?? 11.2): void {
    const h = pose.heading;
    const st = this.st;
    cabPool.put(pose.x - cabKp * Math.sin(h), 0.3, pose.z - cabKp * Math.cos(h), yaw3(h), 0, 1, 1, 1, cabColor);
    this.lamp.part(cabPool === this.tractors ? 'terminalTractor' : 'tractor', pose.x - cabKp * Math.sin(h), 0.3, pose.z - cabKp * Math.cos(h), yaw3(h), 1, true, load === 'bobtail', st);
    if (load === 'bobtail') return;
    const ht = pose.trailer;
    const rx = pose.x - trKp * Math.sin(ht);
    const rz = pose.z - trKp * Math.cos(ht);
    (trailerPool ?? this.chassis).put(rx, 0.3, rz, yaw3(ht), 0, 1, 1, 1, trailerColor);
    this.lamp.part(trailerPool === this.dryTrailers ? 'trailerPlain' : trailerPool === this.reeferTrailers ? 'trailerPlainReefer' : 'chassis', rx, 0.3, rz, yaw3(ht), 1, false, true, st);
    // 箱的原点在箱中心，箱尾和骨架车车尾对齐
    if (load === 'full' || load === 'empty') this.boxes.put(rx + BOX_MID * Math.sin(ht), 0.3 + 1.25, rz + BOX_MID * Math.cos(ht), yaw3(ht), 0, 1, 1, 1, color);
  }

  /** 车灯的状态：比较此刻和 1 秒后的位姿（动没动、往前开还是倒车、转弯），夜里亮大灯尾灯，停着亮刹车灯 */
  private lampState(a: RigPose, b: RigPose, night: boolean, hazard: boolean): LampState {
    const st = this.st;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const moving = Math.hypot(dx, dz) > 0.15;
    st.night = night;
    st.hazard = hazard;
    st.rev = moving && dx * Math.sin(a.heading) + dz * Math.cos(a.heading) < 0;
    st.brake = !moving;
    st.turn = moving && !st.rev ? turnOf(a.heading, b.heading) : 0;
    return st;
  }

  /** 镜头离物流中心近（局部坐标）：屋顶隐藏、画库内 */
  private cutaway(cam?: { x: number; y: number; z: number }): void {
    const near = !!cam && Math.hypot(cam.x - -2440, cam.z - 1190) < 340 && cam.y < 260;
    if (near === this.near) return;
    this.near = near;
    this.roofs.visible = !near;
    this.inside.visible = near;
  }

  /**
   * 场内拖车（物流中心各场地、交接点、车道上）互相让，也让收货场引擎排的半挂车（货车侧、保税库）和门口停着的骨架车：
   * 按出发的先后，每一段动的沿轨迹每秒查一次车身碰不碰，碰上就在起点多等一会儿（每次 2 秒，最多这一段时长的三成），后面开快一点、按计划的时刻到。
   * 和 ops/parkYard.ts 一样：先走的不让后来的，后来的自己等。
   */
  private *yieldTractors(): Steps {
    const plan = this.plan;
    if (!plan) return;
    type It = { k: number; g: Seg; x0: number; x1: number; z0: number; z1: number };
    const items: It[] = [];
    const P = this.P2;
    this.tracks.forEach((tr, k) =>
      tr.forEach((g) => {
        let x0 = Infinity;
        let x1 = -Infinity;
        let z0 = Infinity;
        let z1 = -Infinity;
        for (let i = 0; i <= 6; i++) {
          segPose(g, g.t0 + ((g.t1 - g.t0) * i) / 6 + (i === 6 ? -1e-3 : 0), P);
          x0 = Math.min(x0, P.x);
          x1 = Math.max(x1, P.x);
          z0 = Math.min(z0, P.z);
          z1 = Math.max(z1, P.z);
        }
        items.push({ k, g, x0: x0 - 15, x1: x1 + 15, z0: z0 - 15, z1: z1 + 15 });
      }),
    );
    const docks = plan.docks.filter((d) => d.tl && d.face !== 'cfs-box');
    for (const tr of this.tracks) for (const g of tr) delete g.delay;
    // 每辆半挂车在场地里走过的范围（时刻表的各段首尾的位姿，外扩 20 米）：离得远的不用逐秒查
    const dockBox = new Map<(typeof docks)[number], { x0: number; x1: number; z0: number; z1: number }>();
    for (const d of docks) {
      const tl = d.tl as NonNullable<typeof d.tl>;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const sg of tl.segs)
        for (const t of [sg.t0, (sg.t0 + sg.t1) / 2, sg.t1 - 1e-3]) {
          const u = poseAt(tl, t)?.units[0];
          if (!u) continue;
          x0 = Math.min(x0, u.pose.x);
          x1 = Math.max(x1, u.pose.x);
          z0 = Math.min(z0, u.pose.z + PL.zWall);
          z1 = Math.max(z1, u.pose.z + PL.zWall);
        }
      dockBox.set(d, { x0: x0 - 20, x1: x1 + 20, z0: z0 - 20, z1: z1 + 20 });
    }
    // 外来车层画的车在物流中心的路上、空箱堆场里（进闸开到场地口、出来开回闸口、空箱堆场的集卡停在箱位旁）：缓起缓停沿折线走，车身取前后两段
    type XL = { t0: number; t1: number; pts: Pt[]; cum: number[]; u0: number; L: number; still: boolean; x0: number; x1: number; z0: number; z1: number };
    const xls: XL[] = [];
    for (const tr of this.lastTrips) {
      let prev: Pt[] | undefined;
      for (const l of tr.legs) {
        const pts = l.pts && l.pts.length > 1 ? l.pts : l.hidden ? undefined : prev;
        if (!pts) {
          prev = undefined;
          continue;
        }
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).z - (pts[i - 1] as Pt).z));
        const xs = pts.map((p) => p.x);
        const zs = pts.map((p) => p.z);
        const still = !(l.pts && l.pts.length > 1);
        xls.push({ t0: l.t0, t1: l.t1, pts, cum, u0: still ? (cum[cum.length - 1] as number) : (l.u0 ?? 0), L: tr.build === 0 ? 17.5 : 16.6, still, x0: Math.min(...xs) - 18, x1: Math.max(...xs) + 18, z0: Math.min(...zs) - 18, z1: Math.max(...zs) + 18 });
        prev = pts;
      }
    }
    const ptAt = (x: XL, u: number): Pt => {
      const n = x.pts.length;
      let i = 1;
      while (i < n - 1 && (x.cum[i] as number) < u) i++;
      const a = x.pts[i - 1] as Pt;
      const b = x.pts[i] as Pt;
      const seg = Math.max(1e-6, (x.cum[i] as number) - (x.cum[i - 1] as number));
      const k = (u - (x.cum[i - 1] as number)) / seg;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
    };
    const half = (o: Body, p: Pt, q: Pt) => {
      o.cx = (p.x + q.x) / 2;
      o.cz = (p.z + q.z) / 2;
      o.h = Math.atan2(p.x - q.x, p.z - q.z);
      o.hl = Math.max(0.5, Math.hypot(p.x - q.x, p.z - q.z) / 2 - 0.2);
      o.hw = 1.2;
    };
    const A: Body[] = [0, 1].map(() => ({ cx: 0, cz: 0, h: 0, hl: 0, hw: 0 }));
    const B: Body[] = [0, 1].map(() => ({ cx: 0, cz: 0, h: 0, hl: 0, hw: 0 }));
    const Q: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
    const rig = (o: Body[], p: RigPose, load: PortTractorLeg['load'], f: number, r: number, tr: number): number => {
      bodyOf(o[0] as Body, p.x, p.z, p.heading, f, r);
      if (load === 'bobtail') return 1;
      bodyOf(o[1] as Body, p.x, p.z, p.trailer, 1.0, tr);
      return 2;
    };
    /** 第 k 辆拖车此刻所在的段（二分查找；两段之间停在上一段的终点） */
    const segOf = (k: number, t: number): Seg | undefined => {
      const tr = this.tracks[k] as Seg[];
      if (!tr.length) return undefined;
      let lo = 0;
      let hi = tr.length - 1;
      if (t < (tr[0] as Seg).t0) return tr[0];
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((tr[mid] as Seg).t0 <= t) lo = mid;
        else hi = mid - 1;
      }
      return tr[lo];
    };
    const clash = (m: It, near: number[], dks: typeof docks, pk: typeof this.parked, ends: RigPose[], xs: XL[] = []): boolean => {
      for (let t = m.g.t0 + 0.5; t < m.g.t1; t += 1.5) {
        segPose(m.g, t, P);
        const na = rig(A, P, m.g.load, 3.9, 1.3, 11.2);
        const hit = (nb: number) => {
          for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) if (bodyHit(A[i] as Body, B[j] as Body)) return true;
          return false;
        };
        for (const k of near) {
          const g = segOf(k, t);
          if (!g) continue;
          segPose(g, Math.min(t, g.t1 - 1e-3), Q);
          if (hit(rig(B, Q, g.load, 3.9, 1.3, 11.2))) return true;
        }
        for (const x of xs) {
          if (t < x.t0 || t >= x.t1) continue;
          const len = x.cum[x.cum.length - 1] as number;
          const u = x.still ? len : x.u0 + (len - x.u0) * ease(clamp01((t - x.t0) / Math.max(1e-3, x.t1 - x.t0)));
          const p0 = ptAt(x, u);
          const p1 = ptAt(x, u - x.L / 2);
          const p2 = ptAt(x, u - x.L);
          half(B[0] as Body, p0, p1);
          half(B[1] as Body, p1, p2);
          if (hit(2)) return true;
        }
        for (const d of dks) {
          // 先看这辆半挂车大概在哪（每 2 秒一个样，缓存）：离得远（50 米外）的不用算准确的位姿
          const c = dockNear(d, t);
          if (c && (Math.abs(c.x - P.x) > 50 || Math.abs(c.z - P.z) > 50)) continue;
          const u = poseAt(d.tl as NonNullable<typeof d.tl>, t)?.units[0];
          if (!u) continue;
          Object.assign(Q, u.pose);
          Q.z += PL.zWall;
          if (hit(rig(B, Q, 'chassis', 4.4, 1.6, 12.4))) return true;
        }
        for (const p of pk) {
          // 自己要挂上、刚摘下的那一辆不算
          if (t < p.t0 || t >= p.t1 || ends.some((e) => Math.hypot(p.pose.x - e.x, p.pose.z - e.z) < 5)) continue;
          bodyOf(B[0] as Body, p.pose.x, p.pose.z, p.pose.trailer, 1.0, 11.2);
          if (hit(1)) return true;
        }
      }
      return false;
    };
    const dockCache = new Map<(typeof docks)[number], Map<number, { x: number; z: number } | null>>();
    const dockNear = (d: (typeof docks)[number], t: number): { x: number; z: number } | null => {
      let m = dockCache.get(d);
      if (!m) {
        m = new Map();
        dockCache.set(d, m);
      }
      const k = Math.round(t / 2);
      let v = m.get(k);
      if (v === undefined) {
        const u = poseAt(d.tl as NonNullable<typeof d.tl>, k * 2)?.units[0];
        v = u ? { x: u.pose.x, z: u.pose.z + PL.zWall } : null;
        m.set(k, v);
      }
      return v;
    };
    const end: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
    const moving = items.filter((it) => !it.g.timed && it.g.s0 !== it.g.s1 && it.g.t1 - it.g.t0 > 4).sort((a, b) => a.g.t0 - b.g.t0);
    // 按时段分桶（每 120 秒一桶；段往后挪最多 60 秒，桶多记 61 秒），找时段重叠的不用每次把所有段过一遍；挑出来的还是按原来的条件、原来的先后
    const BK = 120;
    const bucket = <T,>(list: T[], t0: (x: T) => number, t1: (x: T) => number, pad: number) => {
      const map = new Map<number, number[]>();
      list.forEach((x, i) => {
        for (let b = Math.floor((t0(x) - 1) / BK); b <= Math.floor((t1(x) + pad) / BK); b++) {
          const l = map.get(b);
          if (l) l.push(i);
          else map.set(b, [i]);
        }
      });
      return (a: number, b: number): T[] => {
        const seen = new Set<number>();
        for (let k = Math.floor(a / BK); k <= Math.floor(b / BK); k++) for (const i of map.get(k) ?? []) seen.add(i);
        return [...seen].sort((p, q) => p - q).map((i) => list[i] as T);
      };
    };
    const itemsIn = bucket(items, (o) => o.g.t0, (o) => o.g.t1, 61);
    const xlsIn = bucket(xls, (x) => x.t0, (x) => x.t1, 1);
    for (const m of moving) {
      yield;
      const near = [...new Set(itemsIn(m.g.t0 - 1, m.g.t1 + 1).filter((o) => o.k !== m.k && o.g.t0 < m.g.t1 + 1 && o.g.t1 > m.g.t0 - 1 && o.x0 < m.x1 && o.x1 > m.x0 && o.z0 < m.z1 && o.z1 > m.z0).map((o) => o.k))];
      const dks = docks.filter((d) => {
        const tl = d.tl as NonNullable<typeof d.tl>;
        const bx = dockBox.get(d);
        return (tl.segs[0]?.t0 ?? 0) < m.g.t1 && tl.goneAt > m.g.t0 && !!bx && bx.x0 < m.x1 && bx.x1 > m.x0 && bx.z0 < m.z1 && bx.z1 > m.z0;
      });
      const pk = this.parked.filter((p) => p.t0 < m.g.t1 && p.t1 > m.g.t0 && p.pose.x > m.x0 && p.pose.x < m.x1 && p.pose.z > m.z0 && p.pose.z < m.z1);
      const xs = xlsIn(m.g.t0, m.g.t1).filter((x) => x.t0 < m.g.t1 && x.t1 > m.g.t0 && x.x0 < m.x1 && x.x1 > m.x0 && x.z0 < m.z1 && x.z1 > m.z0);
      if (!near.length && !dks.length && !pk.length && !xs.length) continue;
      segPose(m.g, m.g.t1 - 1e-3, end);
      const e2 = { ...end };
      segPose(m.g, m.g.t0, end);
      const ends = [{ ...end }, e2];
      const clashAny = () => clash(m, near, dks, pk, ends as RigPose[], xs);
      if (!clashAny()) continue;
      let ok = false;
      for (let D = 2; D <= (m.g.t1 - m.g.t0) * 0.45 && !ok; D += 2) {
        m.g.delay = D;
        ok = !clashAny();
      }
      if (!ok) delete m.g.delay;
      // 还是碰：整段往后挪（这一段后面闲着的时间、或者后面停着的那一段里匀出来，车速不变），最多 2 分钟
      if (!ok) {
        const tr = this.tracks[m.k] as Seg[];
        const i = tr.indexOf(m.g);
        const nx = tr[i + 1];
        const room = !nx ? 60 : nx.t0 - m.g.t1 > 1 ? Math.min(60, nx.t0 - m.g.t1 - 1) : nx.s0 === nx.s1 && !nx.timed ? Math.min(60, (nx.t1 - nx.t0) * 0.5) : 0;
        if (room >= 2) {
          const a0 = m.g.t0;
          const a1 = m.g.t1;
          const nearW = [...new Set(itemsIn(a0 - 1, a1 + room + 1).filter((o) => o.k !== m.k && o.g.t0 < a1 + room + 1 && o.g.t1 > a0 - 1 && o.x0 < m.x1 && o.x1 > m.x0 && o.z0 < m.z1 && o.z1 > m.z0).map((o) => o.k))];
          const xsW = xlsIn(a0, a1 + room).filter((x) => x.t0 < a1 + room && x.t1 > a0 && x.x0 < m.x1 && x.x1 > m.x0 && x.z0 < m.z1 && x.z1 > m.z0);
          let D = 0;
          for (let d = 4; d <= room && !ok; d += 4) {
            m.g.t0 = a0 + d;
            m.g.t1 = a1 + d;
            ok = !clash(m, nearW, dks, pk, ends as RigPose[], xsW);
            if (ok) D = d;
          }
          m.g.t0 = a0 + D;
          m.g.t1 = a1 + D;
          if (D && nx && nx.t0 < m.g.t1) nx.t0 = m.g.t1;
        }
      }
    }
  }

  update(t: number, cam?: { x: number; y: number; z: number }): void {
    const plan = this.plan;
    for (const p of this.all) p.begin();
    this.forks.begin();
    this.pallets.begin();
    this.cutaway(cam);
    if (!plan) {
      for (const p of this.all) p.end();
      this.forks.end();
      this.pallets.end();
      return;
    }
    const blink = Math.floor(t * 1.6) % 2 === 0;
    const night = isNight(t);
    this.lamp.begin(t);
    // —— 场内拖车 ——
    for (let k = 0; k < this.tracks.length; k++) {
      const g = this.tractorAt(k, t, this.P);
      if (!g) continue;
      this.tractorAt(k, t + 1, this.P2);
      this.lampState(this.P, this.P2, night, !!g.hazard);
      this.drawRig(this.P, g.load, g.color ?? 0xffffff, this.tractors, 0xd9a21b);
      if (g.hazard && blink) this.hazards.put(this.P.x, 2.2, this.P.z, 0, 0, 1, 1, 1);
    }
    // —— 门口、台边停着的骨架车 ——
    for (const p of this.parked) {
      if (t < p.t0 || t >= p.t1) continue;
      const ht = p.pose.trailer;
      const kp = (MODEL_SPECS.chassis.kingpin as number) ?? 11.2;
      const rx = p.pose.x - kp * Math.sin(ht);
      const rz = p.pose.z - kp * Math.cos(ht);
      this.chassis.put(rx, 0.3, rz, yaw3(ht), 0, 1, 1, 1, 0xffffff);
      this.boxes.put(rx + BOX_MID * Math.sin(ht), 1.55, rz + BOX_MID * Math.cos(ht), yaw3(ht), 0, 1, 1, 1, p.color);
    }
    // —— 外面的半挂车（货车侧、保税库的场地里，收货场引擎的时间线） ——
    for (const d of plan.docks) {
      if (!d.tl || d.face === 'cfs-box') continue;
      const tl = d.tl;
      const t0 = this.handIn.get(d.id) ?? tl.segs[0]?.t0 ?? 0;
      if (t < t0 || t >= tl.goneAt) continue;
      const info = poseAt(tl, t);
      if (!info) continue;
      const u = info.units[0];
      if (!u) continue;
      Object.assign(this.Q, u.pose);
      this.Q.z += PL.zWall;
      const u2 = poseAt(tl, t + 1)?.units[0];
      if (u2) {
        Object.assign(this.P2, u2.pose);
        this.P2.z += PL.zWall;
      } else Object.assign(this.P2, this.Q);
      this.lampState(this.Q, this.P2, night, !!info.hazard);
      this.drawRig(this.Q, 'chassis', 0xffffff, this.cabs, cabOf(d.id), d.reefer ? this.reeferTrailers : this.dryTrailers, trailerOf(d.id), (MODEL_SPECS.tractor.kingpin as number) ?? 1.6, (MODEL_SPECS.trailerPlain.kingpin as number) ?? 12.4);
      if (info.hazard && blink) {
        const h = this.Q.heading;
        this.hazards.put(this.Q.x + 4 * Math.sin(h), 1.2, this.Q.z + 4 * Math.cos(h), 0, 0, 1, 1, 1);
      }
    }
    // —— 月台门：车靠稳以后卷帘门升起、调平板搭上；门边的灯有车红、没车绿 ——
    for (const s of SECTIONS) {
      const list = s.key === 'port-cfs-box' ? plan.docks.filter((d) => d.face === 'cfs-box') : s.key === 'port-cfs-truck' ? plan.docks.filter((d) => d.face === 'cfs-truck') : s.key === 'port-bonded' ? plan.docks.filter((d) => d.face === 'bonded') : [];
      s.doors.forEach((door, i) => {
        if (s.key === 'port-inspect') return;
        const v = list.find((d) => d.door === i && t >= d.backAt - 20 && t < d.gone);
        const open = !!v && t >= v.docked + 30 && t < v.pullAt - 20;
        const lift = open ? clamp01((t - v.docked - 30) / 12) : 0;
        const h = DOOR_H * (1 - lift);
        if (h > 0.05) this.doors.put(door.x, DOCK_H + DOOR_H - h, PL.zWall - 0.05, 0, 0, PL.doorW, h, 1, 0xc9ced4);
        if (open) this.levelers.put(door.x, DOCK_H - 0.06, PL.zWall + 1.0, 0, 0, 1, 1, 1);
        this.lights.put(door.x + PL.doorW / 2 + 0.6, DOCK_H + 2.4, PL.zWall + 0.1, 0, 0, 1, 1, 1, v ? 0xff3b30 : 0x34c759);
      });
    }
    // —— 机检：车开过门架的时段亮扫描光 ——
    if (plan.inspections.some((i) => t >= i.scan[0] && t < i.scan[1])) {
      const a = AREAS.scan;
      this.beams.put(a.xIn, 0.5, (a.portal[0] + a.portal[1]) / 2, 0, 0, 1, 1, 1);
    }
    // —— 空箱堆场：每个箱位的箱、正面吊 ——
    for (const s of this.slots) if (t >= s.t0 && t < s.t1) this.boxes.put(s.x, s.y + 0.32, s.z, 0, 0, 1, 1, 1, s.color);
    const dp = AREAS.depot;
    for (let k = 0; k < 2; k++) {
      const jobs = this.stackJobs.filter((j) => j.stacker === k);
      const cur = jobs.find((j) => t >= j.t0 && t < j.t1);
      let prev: (typeof jobs)[number] | undefined;
      for (const j of jobs) if (j.t1 <= t) prev = j;
      const next = jobs.find((j) => j.t0 > t);
      let x = (dp.x0 + dp.x1) / 2 + (k ? 30 : -30);
      let z = (dp.stackerZ[k] as number) ?? 1200;
      let yaw = k === 0 ? -Math.PI / 2 : Math.PI / 2;
      let ang = 0.15;
      if (cur) {
        x = cur.x;
        z = cur.z;
        yaw = cur.yaw;
        // 吊着箱：从起点抬起、转过去、放下（同一台吊叠在一起的几单，每个箱都画）
        let lift = 0;
        for (const j of jobs) {
          if (t < j.t0 || t >= j.t1) continue;
          const f = clamp01((t - j.t0) / Math.max(1, j.t1 - j.t0));
          const lj = Math.sin(Math.PI * f);
          if (j === cur) lift = lj;
          this.boxes.put(j.from.x + (j.to.x - j.from.x) * f, j.from.y + (j.to.y - j.from.y) * f + lj * 4, j.from.z + (j.to.z - j.from.z) * f, 0, 0, 1, 1, 1, j.color);
        }
        ang = 0.15 + lift * 0.35;
      } else if (prev && next) {
        const f = clamp01((t - prev.t1) / Math.max(1, next.t0 - prev.t1));
        const e = ease(clamp01(f * 3));
        x = prev.x + (next.x - prev.x) * e;
        z = prev.z + (next.z - prev.z) * e;
        yaw = e < 0.5 ? prev.yaw : next.yaw;
      } else if (prev) {
        x = prev.x;
        z = prev.z;
        yaw = prev.yaw;
      }
      this.stackers.put(x, 0, z, yaw, 0, 1, 1, 1);
      this.booms.put(x - 3.6 * Math.cos(yaw), 3.4, z + 3.6 * Math.sin(yaw), yaw, ang, 1, 1, 1);
    }
    // —— 库内（镜头近才画）：托盘按库里的数量摆在货架上，正在拆箱 / 装车的门口有叉车来回 ——
    if (this.near) {
      const fill = (x0: number, x1: number, rows: number, count: number) => {
        let n = 0;
        for (let lv = 0; lv < 3 && n < count; lv++)
          for (let r = 0; r < rows && n < count; r++)
            for (let x = x0 + 1.35; x < x1 - 1 && n < count; x += 1.35) {
              this.pallets.put(x, 2.12 + lv * 2.0, PL.zNorth + 6 + r * 4.4, 0, 0, 1, 1, 1);
              n++;
            }
      };
      const cfs = occupancyAt(plan.day, 'cfs', t);
      const bnd = occupancyAt(plan.day, 'bonded', t);
      fill(-2405, -2352, 5, Math.round((cfs / CFS_SLOTS) * 5 * 3 * 39));
      fill(-2596, -2512, 6, Math.round((bnd / BONDED_SLOTS) * 6 * 3 * 62));
      for (const d of plan.docks) {
        if (t < d.start || t >= d.done) continue;
        const sec = d.face === 'cfs-box' ? SECTIONS[2] : d.face === 'cfs-truck' ? SECTIONS[3] : SECTIONS[1];
        const door = sec?.doors[d.door];
        if (!door) continue;
        // 叉车在门口和暂存区之间来回：一趟约 70 秒
        const f = ((t - d.start) % 70) / 70;
        const k = f < 0.5 ? f * 2 : 2 - f * 2;
        const z = PL.zWall - 2 - k * 14;
        this.forks.put(door.x, DOCK_H, z, f < 0.5 ? -Math.PI / 2 : Math.PI / 2, 0, 1, 1, 1);
        this.pallets.put(door.x + 0.4, DOCK_H + 0.2, z - (f < 0.5 ? 1.4 : -1.4), 0, 0, 1, 1, 1);
      }
    }
    for (const p of this.all) p.end();
    this.lamp.end();
    this.forks.end();
    this.pallets.end();
  }

  // ———————————————————————— 监控 ————————————————————————

  info(t: number): PortLogisticsInfo | undefined {
    const plan = this.plan;
    if (!plan) return undefined;
    const day = plan.day;
    const at = (z: string) => occupancyAt(day, z, t);
    const docksNow = (face: PortDock['face']) => plan.docks.filter((d) => d.face === face && t >= d.backAt && t < d.gone).length;
    const queueNow = plan.docks.filter((d) => d.face !== 'cfs-box' && d.tl && d.tl.segs.some((g) => (g.kind === 'hold' || g.kind === 'queue') && t >= g.t0 && t < g.t1)).length;
    const own = plan.inspections.filter((i) => i.own).map((i) => ({ box: i.box, text: t < i.scan[0] ? `已布控，${clockOf(i.scan[0])} 机检` : t < i.scan[1] ? '正在过机检通道' : i.open && t < i.open[1] ? (t < i.open[0] ? '等开箱查验' : '开箱查验中') : i.result }));
    const busy = this.tracks.filter((tr) => tr.some((g) => t >= g.t0 && t < g.t1 && g.s0 !== g.s1)).length;
    return {
      devanning: plan.docks.filter((d) => d.kind === 'devan' && t >= d.start && t < d.done).length,
      stuffing: plan.docks.filter((d) => d.kind === 'stuff' && t >= d.start && t < d.done).length,
      backlog: Math.round(day.kpi.find((k) => k.key === 'backlogPeak')?.value ?? 0),
      cfsPallets: Math.round(at('cfs')),
      cfsFill: Math.round((at('cfs') / CFS_SLOTS) * 100),
      truckDocks: { busy: docksNow('cfs-truck'), doors: SECTIONS[3]?.doors.length ?? 0, queue: queueNow },
      bonded: { pallets: Math.round(at('bonded')), fill: Math.round((at('bonded') / BONDED_SLOTS) * 100), busy: docksNow('bonded'), doors: SECTIONS[1]?.doors.length ?? 0 },
      inspection: { scanning: plan.inspections.some((i) => t >= i.scan[0] && t < i.scan[1]), open: plan.inspections.filter((i) => i.open && t >= i.open[0] && t < i.open[1]).length, bays: SECTIONS[0]?.doors.length ?? 0, today: plan.inspections.filter((i) => i.scan[0] <= t).length, openedToday: plan.inspections.filter((i) => i.open && i.open[0] <= t).length, own },
      depot: { boxes: Math.round(at('empty')), slots: 2 * 3 * 11 * DEPOT_TIERS, stackers: this.stackJobs.filter((j) => t >= j.t0 && t < j.t1).length },
      tractors: { busy, total: this.tracks.length },
      kpi: day.kpi.map((k) => ({ label: k.label, value: `${k.unit === '%' ? Math.round(k.value) : k.value >= 100 ? Math.round(k.value) : Math.round(k.value * 10) / 10} ${k.unit}` })),
      notes: day.notes,
    };
  }
}

function clockOf(t: number): string {
  const m = Math.round(t / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 折线上离起点 u 米的点 */
function ptAt(pts: readonly Pt[], u: number): Pt {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + d >= u || i === pts.length - 1) {
      const k = d > 1e-6 ? Math.max(0, Math.min(1, (u - acc) / d)) : 0;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
    }
    acc += d;
  }
  return { ...(pts[0] as Pt) };
}

/**
 * 出来的那一段（从场地口开到出闸车道的排队点）：要等的话开到 uStop（车头的位置：路口西头的口袋、空箱堆场西头拐上大路之前）停下等 hold 秒再走。
 * 后一段的折线从停的地方往回带 24 米（挂车摆的历史），从那里接着开。
 */
function outLegs(pts: Pt[], lead: number, t0: number, t1: number, hold: number, uStop: number): { t0: number; t1: number; pts: Pt[]; u0: number; still?: boolean }[] {
  if (hold <= 0) return [{ t0, t1, pts, u0: lead }];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).z - (pts[i - 1] as Pt).z));
  const total = cum[cum.length - 1] as number;
  const cut = (u0: number, u1: number): Pt[] => {
    const out: Pt[] = [ptAt(pts, u0)];
    for (let i = 0; i < pts.length; i++) if ((cum[i] as number) > u0 + 0.3 && (cum[i] as number) < u1 - 0.3) out.push(pts[i] as Pt);
    out.push(ptAt(pts, u1));
    return out;
  };
  const uS = Math.max(lead, Math.min(total - 5, uStop));
  const tA = t0 + (t1 - t0) * ((uS - lead) / Math.max(1, total - lead));
  const p1 = cut(0, uS);
  const back = Math.min(24, uS);
  const p2 = cut(uS - back, total);
  return [
    ...(uS - lead >= 1 ? [{ t0, t1: tA, pts: p1, u0: lead }] : []),
    { t0: tA, t1: tA + hold, pts: p1, u0: uS, still: true },
    { t0: tA + hold, t1: t1 + hold, pts: p2, u0: back },
  ];
}
