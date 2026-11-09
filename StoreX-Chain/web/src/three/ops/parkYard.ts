import * as THREE from 'three';
import { box, cyl, merge, type Part } from '../../../../../StoreX/web/src/three/models';
import { BUILDS, partGeometry, type LampSpec } from '../fleet';
import { usePaintMask } from '../vehicles/index';
import { doorOut, sectionAt, type Actor, type Leg, type ParkDoor, type ParkLayout, type ParkPlan, type Pt, type Tow } from '../../../../src/hub/park';
import { fillet, ForwardRig, Polyline, ReverseRig, type RigPose } from '@storewright/yard';
import { drain, ease, Pool, prog, type Steps } from './kit';
import { isNight, Lamps, turnOf, type LampState } from './lamps';
import { tx } from '../../i18n';

/**
 * 物流园的场地（ops/dc.ts 管库房和库内，这里管库房外面）：铁路转运仓（越库仓）、门口的进园登记（两进两出、登记亭在司机一侧、
 * 识别门架、道闸）、待命停车场（直进直出的货车位）、甩挂区、场内路和标线（短驳环线单向逆时针、双向路的中线、靠台车道、
 * 门前的水泥地坪和导向线）、标牌；以及场里所有不归仿真管的车——短驳牵引车（拖着骨架车和箱）、场内牵引车（拖挂车）、
 * 别家的货车和承运商的车头、外来集卡，还有甩在门上和车位里的挂车、骨架车。
 *
 * 车按 src/hub/park.ts 的计划走：每一段首尾相接（开过去、倒车靠台、摘挂、拉出、等着）。铰接车用场地引擎的运动学：
 * 前进时牵引销沿路走、挂车按追踪曲线跟着（转弯切内侧），倒车时挂车车轴沿一条平顺的曲线退进门（从司机一侧），牵引车跟着摆；
 * 外来的车从园区路口外的公路上开来、在门外排队登记，走的时候开出去。坐标是物流园的局部坐标（真实尺寸）。
 */

interface Pose {
  x: number;
  z: number;
  /** 牵引车、挂车朝向（atan2(dx, dz)） */
  h: number;
  th: number;
}
interface Seg {
  t0: number;
  t1: number;
  leg: Leg;
  start: Pose;
  end: Pose;
  /** 动的段：按距离取位姿 */
  rig?: { len: number; at(s: number, o: Pose): void };
  /** 倒车（车速曲线慢一些） */
  back?: boolean;
  /** 门外排队：沿开来的那段路停在前面的车后面，前面走一辆往前挪一个车位 */
  queue?: { rig: NonNullable<Seg['rig']>; ahead: number[] };
  /** 开来的这段停在离终点多远（前面还有车在排队） */
  short?: number;
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
interface Track {
  actor: Actor;
  segs: Seg[];
  road: boolean;
  term: boolean;
}
interface Unit {
  tow: Tow;
  pose: Pose;
  t0: number;
  t1: number;
}

const dir = (h: number) => ({ x: Math.sin(h), z: Math.cos(h) });
const segKey = (a: Pt, b: Pt) => `${a.x.toFixed(1)},${a.z.toFixed(1)}|${b.x.toFixed(1)},${b.z.toFixed(1)}`;
const DOCK_Y = 1.3;
/** 车模的锚点（和区域车辆层一样，从 fleet.ts 取）：牵引销在牵引车零件里的 x、挂车 / 骨架车车尾到牵引销、集装箱抬高 */
const TRACTOR = BUILDS.ownDry.parts[0] as { ax: number; ra: number; fa: number };
const KP_ROAD = TRACTOR.ax - (TRACTOR.ra - TRACTOR.fa);
const KP_TERM = 1.4;
const REAR = { trailer: (BUILDS.plainDry.parts[1] as { ax: number }).ax, chassis: (BUILDS.drayage.parts[1] as { ax: number }).ax };
const BOX_Y = (BUILDS.drayage.parts[2] as { y?: number }).y ?? 1.25;
/** 牵引销到挂车车轴（场地引擎的尺寸） */
const AXLE = { trailer: 9.5, chassis: 9.2 };
const TRAILER_LEN = { trailer: 13.6, chassis: 12.2 };
/** 门外排队的车距（半挂车长 16.8 米加 2 米多的空当） */
const QUEUE_GAP = 19;
/** 双向的场内路：车靠右走（离路中线半个车道） */
const LANE = 1.75;
/** 场内牵引车（自己拼的车模）的灯位：车头的大灯、转向灯，车尾的尾灯、倒车灯、转向灯 */
const TERM_LAMPS: LampSpec = { head: [4.4, 0.78, 0.82], frontTurn: [4.4, 0.78, 1.08], tail: [-0.02, 0.62, 1.0], back: [-0.02, 0.62, 0.7], rearTurn: [-0.02, 0.84, 1.05], k: 1 };
/**
 * 外来的车交给区域的外来货车层（ops/extTrucks.ts）的那一部分：从高速口开到门外、排队、开到登记亭（交接：开始登记的时刻），
 * 出门登记完以后从登记亭开回高速口。坐标是物流园的局部坐标；车型：0 集装箱车（骨架车，有箱给颜色）、1 厢式半挂、2 冷藏半挂、5 光车头
 */
export interface ParkTrip {
  id: string;
  buildIn: 0 | 1 | 2 | 5;
  buildOut: 0 | 1 | 2 | 5;
  boxIn?: number;
  boxOut?: number;
  cab: number;
  trailerIn: number;
  trailerOut: number;
  /** 到门外（排队或直接到登记亭）、开始登记、出门登记完 */
  arrive: number;
  kiosk: number;
  leave: number;
  /** 进门车道（0、1）、登记亭的位置（牵引销停在这里，车头朝园内） */
  lane: number;
  kioskAt: Pt;
  /** 同一条进门车道上排在前面的车离开登记亭的时刻（由早到晚） */
  ahead: number[];
  /** 出门登记完的姿态：牵引销的位置、牵引车和挂车的朝向 */
  out: { x: number; z: number; h: number; th: number };
}

/** 场内牵引车（码头 / 物流园常用的单人驾驶室牵引车）：驾驶室偏在一侧、短车身、抬高的牵引座；原点在车尾，车头朝 +x */
function terminalTractor(): THREE.BufferGeometry {
  const Y = '#e5a823';
  const D = '#2b2f35';
  return merge([
    box(4.3, 0.55, 2.4, D, 2.15, 0.45, 0),
    box(1.5, 1.25, 2.3, Y, 3.55, 1.0, 0),
    box(1.6, 1.9, 1.15, Y, 3.4, 1.0, 0.55),
    box(1.45, 1.0, 1.05, '#9fc0ea', 3.45, 1.85, 0.56),
    box(1.66, 0.12, 1.2, Y, 3.4, 2.9, 0.55),
    box(1.5, 0.18, 1.4, '#5b6067', 1.4, 1.15, 0),
    cyl(0.07, 0.07, 1.4, D, 4.0, 2.0, -0.6),
    box(0.15, 0.35, 2.3, '#d03b2a', 4.32, 0.6, 0),
    ...[0.9, 3.7].flatMap((x) => [-1.05, 1.05].map((z) => box(0.9, 0.9, 0.42, '#1d1d1d', x, 0.05, z))),
  ]);
}
/** 道闸的杆（红白），原点在转轴、杆沿 +x */
function barrierArm(len: number): THREE.BufferGeometry {
  const p: Part[] = [box(len, 0.14, 0.14, '#efefef', len / 2, 0, 0)];
  for (let x = 0.6; x < len; x += 1.8) p.push(box(0.8, 0.15, 0.15, '#d03b2a', x + 0.4, 0, 0));
  return merge(p);
}
/** 叉车（转运仓里拆箱、装车）：原点在车身中心，货叉朝 +x */
function forklift(): THREE.BufferGeometry {
  return merge([box(2.2, 0.8, 1.1, '#e0a526', -0.1, 0.25, 0), box(0.65, 0.6, 1.05, '#3d4650', -0.95, 1.05, 0), box(1.3, 0.07, 1.1, '#2b2f35', -0.1, 2.2, 0), box(0.1, 2.2, 0.8, '#5b6067', 0.98, 0.1, 0), box(1.1, 0.06, 0.12, '#5b6067', 1.6, 0.12, 0.3), box(1.1, 0.06, 0.12, '#5b6067', 1.6, 0.12, -0.3)]);
}
function palletLoad(): THREE.BufferGeometry {
  return merge([box(1.0, 0.14, 1.2, '#b08a5a', 0, 0, 0), box(0.96, 1.2, 1.16, '#ffffff', 0, 0.14, 0)]);
}
/** 地上的箭头（标线）：沿 +x，长 4 米 */
function arrowParts(x: number, z: number, h: number, color = '#f2f2ee', y = 0.33): Part[] {
  const yaw = h - Math.PI / 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const put = (g: Part, dx: number) => g.rotateY(yaw).translate(x + dx * c, 0, z - dx * s);
  return [put(box(2.6, 0.02, 0.28, color, 0, y, 0), -0.7), put(box(1.3, 0.02, 0.28, color, 0, y, 0).rotateY(0.6).translate(0.75, 0, 0.32), 0), put(box(1.3, 0.02, 0.28, color, 0, y, 0).rotateY(-0.6).translate(0.75, 0, -0.32), 0)];
}
/** 一条有宽度的带子（路面、标线）：沿折线，每段一个长方体 */
function strip(pts: readonly Pt[], w: number, color: string, y: number, h = 0.1, dash = 0): Part[] {
  const out: Part[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.05) continue;
    const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
    if (dash > 0) {
      for (let s = dash / 2; s < len; s += dash * 2) {
        const f = s / len;
        const l = Math.min(dash, len - s);
        out.push(box(l, h, w, color, 0, y, 0).rotateY(yaw).translate(a.x + (b.x - a.x) * (f + l / 2 / len), 0, a.z + (b.z - a.z) * (f + l / 2 / len)));
      }
      continue;
    }
    out.push(box(len + w * 0.5, h, w, color, 0, y, 0).rotateY(yaw).translate((a.x + b.x) / 2, 0, (a.z + b.z) / 2));
  }
  return out;
}
/** 标牌：蓝底白字的牌子（画布贴图）立在两根柱子上 */
function sign(text: string, x: number, z: number, h: number, w = 6): THREE.Group {
  const g = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const x2 = c.getContext('2d') as CanvasRenderingContext2D;
  x2.fillStyle = '#1f5fa8';
  x2.fillRect(0, 0, 512, 128);
  x2.strokeStyle = '#ffffff';
  x2.lineWidth = 6;
  x2.strokeRect(8, 8, 496, 112);
  x2.fillStyle = '#ffffff';
  // 英文界面按字典翻译；字多时缩小字号放进牌子
  const label = tx(text);
  let size = 54;
  x2.font = `bold ${size}px system-ui, sans-serif`;
  while (x2.measureText(label).width > 480 && size > 16) {
    size -= 4;
    x2.font = `bold ${size}px system-ui, sans-serif`;
  }
  x2.textAlign = 'center';
  x2.textBaseline = 'middle';
  x2.fillText(label, 256, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  board.position.set(0, 3.2, 0);
  const posts = new THREE.Mesh(merge([box(0.15, 3.2, 0.15, '#7d8288', -w * 0.35, 0, 0), box(0.15, 3.2, 0.15, '#7d8288', w * 0.35, 0, 0)]), new THREE.MeshStandardMaterial({ vertexColors: true }));
  g.add(board, posts);
  g.position.set(x, 0, z);
  g.rotation.y = h - Math.PI / 2;
  g.name = `sign-${text}`;
  return g;
}

/** 掉头的半径（米）：拖着挂车的车绕这么大的圈，铰接角不超过约 50° */
const TURN_R = 12;
/**
 * 掉头：折线在某一点几乎折回来（或者起步的方向和车头相反）时，车不能原地转身，在宽的场地上绕一个灯泡形的圈：
 * 先向右摆 60°、向左绕 300°、再向右摆 60°，回到原地、车头正好反过来（三段圆弧相切，半径相同时正好闭合）。
 */
function bulb(p: Pt, h: number, out: Pt[]): void {
  const R = TURN_R;
  let x = p.x;
  let z = p.z;
  let a = h;
  const arc = (turn: number) => {
    const n = Math.max(4, Math.ceil((Math.abs(turn) * R) / 2));
    const da = turn / n;
    for (let i = 0; i < n; i++) {
      // 弦的方向取圆弧中点的切线；turn > 0 向左（朝向角减小：x 向东、z 向南时 atan2(dx, dz) 向左转变小的是相反方向，这里统一用 −da）
      x += Math.sin(a - da / 2) * (Math.abs(da) * R);
      z += Math.cos(a - da / 2) * (Math.abs(da) * R);
      a -= da;
      out.push({ x, z });
    }
  };
  arc(-Math.PI / 3);
  arc((5 * Math.PI) / 3);
  arc(-Math.PI / 3);
}
/** 把折回来的地方换成掉头的圈；h0 是起步时车头的朝向 */
function unreverse(raw: readonly Pt[], h0: number): Pt[] {
  const out: Pt[] = [{ ...(raw[0] as Pt) }];
  let h = h0;
  for (let i = 1; i < raw.length; i++) {
    const a = out[out.length - 1] as Pt;
    const b = raw[i] as Pt;
    if (Math.hypot(b.x - a.x, b.z - a.z) < 0.3) continue;
    const next = Math.atan2(b.x - a.x, b.z - a.z);
    let d = Math.abs(next - h) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > (i === 1 ? 1.9 : 2.3)) bulb(a, h, out);
    // 起步的方向和车头差得不多：先顺着车头开几米，让圆角接上（车不会原地转身）
    else if (i === 1 && d > 0.2) {
      const k = Math.min(8, Math.hypot(b.x - a.x, b.z - a.z) * 0.45);
      out.push({ x: a.x + Math.sin(h) * k, z: a.z + Math.cos(h) * k });
    }
    out.push({ x: b.x, z: b.z });
    h = next;
  }
  return out;
}

/** 车速曲线：起步加速、到点前减速（倒车慢慢退、最后几米蠕行） */
function profile(f: number, back: boolean): number {
  const a = back ? 0.3 : 0.18;
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  // 梯形速度：0–a 加速、a–(1−a) 匀速、最后 a 减速；距离按面积
  const vmax = 1 / (1 - a);
  if (f < a) return (vmax * f * f) / (2 * a);
  if (f > 1 - a) return 1 - (vmax * (1 - f) * (1 - f)) / (2 * a);
  return vmax * (a / 2 + (f - a));
}

export class ParkYard {
  readonly group = new THREE.Group();
  /** 转运仓的屋顶（镜头靠近时隐藏）和库内 */
  private readonly roof = new THREE.Group();
  private readonly inside = new THREE.Group();
  private L: ParkLayout;
  private plan: ParkPlan | undefined;
  private tracks: Track[] = [];
  private units: Unit[] = [];
  private readonly pools: Record<'term' | 'road' | 'trailer' | 'reefer' | 'chassis' | 'box' | 'barrier' | 'panel' | 'light' | 'fork' | 'pallet', Pool>;
  private readonly pose: Pose = { x: 0, z: 0, h: 0, th: 0 };
  private readonly rp: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
  /** 仿真车经过门口时抬杆（区域里的车辆层告诉这里） */
  private simGate = false;
  private gateOpen = [0, 0, 0, 0];
  private lastT = 0;
  /** 本店甩挂的挂车（仿真车头来挂走的时刻）：画到那一刻为止 */
  private ownHook = new Map<string, number>();
  /** 车灯（场内牵引车、外来的车、挂车） */
  private readonly lamps = new Lamps('park-vehicle-lamps', 600);
  private readonly ls: LampState = { night: false };
  private readonly p2: Pose = { x: 0, z: 0, h: 0, th: 0 };
  private readonly qa: Pose = { x: 0, z: 0, h: 0, th: 0 };
  private readonly qb: Pose = { x: 0, z: 0, h: 0, th: 0 };
  private readonly ba: Body[] = [];
  private readonly bb: Body[] = [];
  /** 外来的车在园区外的路上、门外排队由区域的外来货车层画（ops/extTrucks.ts）：这里从开始登记画到出门登记完 */
  extRoad = true;
  /** 单行的场内路（短驳环线）的路段：车沿路中走，别的路靠右 */
  private oneWay = new Set<string>();

  constructor(L: ParkLayout) {
    this.L = L;
    this.group.name = 'park-yard';
    const VC = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
    // 车模（fleet.ts 的零件）：车漆乘实例颜色，车窗、灯、轮胎不跟着变色
    const PM = usePaintMask(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 }));
    this.pools = {
      term: new Pool(terminalTractor(), VC, 16, 'park-terminal-tractors'),
      road: new Pool(partGeometry('tractor'), usePaintMask(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2 })), 60, 'park-road-tractors'),
      trailer: new Pool(partGeometry('trailerPlain'), PM, 140, 'park-trailers'),
      reefer: new Pool(partGeometry('trailerPlainReefer'), PM, 40, 'park-reefer-trailers'),
      chassis: new Pool(partGeometry('chassis'), PM, 40, 'park-chassis'),
      box: new Pool(partGeometry('container'), usePaintMask(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 })), 40, 'park-containers'),
      barrier: new Pool(barrierArm(3.4), VC, 4, 'park-gate-barriers', false),
      panel: new Pool(merge([box(3.2, 1, 0.12, '#d4d8dc', 0, 0, 0), box(3.2, 0.06, 0.14, '#9aa0a6', 0, 0.5, 0)]), VC, 24, 'park-dock-doors', false),
      light: new Pool(new THREE.BoxGeometry(0.5, 0.5, 0.25), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 80, 'park-dock-lights', false),
      fork: new Pool(forklift(), VC, 24, 'park-forklifts'),
      pallet: new Pool(palletLoad(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 420, 'park-pallets', false),
    };
    for (const k of ['term', 'road', 'trailer', 'reefer', 'chassis', 'box', 'barrier', 'panel', 'light'] as const) this.group.add(this.pools[k].mesh);
    for (const k of ['fork', 'pallet'] as const) this.inside.add(this.pools[k].mesh);
    this.group.add(this.lamps.mesh);
    this.group.add(this.roof, this.inside);
    this.build();
  }

  /** 不动的部分：地面、转运仓、门口、停车场和标线、标牌 */
  private build(): void {
    const L = this.L;
    const p: Part[] = [];
    const roof: Part[] = [];
    const { tl, dc, wallZ } = L;
    const N = L.nodes;
    const ASPH = '#4f5256';
    // —— 地面：西边的场地（转运仓、停车场、甩挂区）、场内路、集卡道的接口 ——
    p.push(box(L.dcBox.x0 - 692, 0.12, 214, ASPH, (692 + L.dcBox.x0) / 2, 0.1, dc.z - 120 - 107 + 107));
    const road = (pts: Pt[], w = 9) => p.push(...strip(pts, w, ASPH, 0.12, 0.1));
    const R = (a: string) => N[a] as Pt;
    road([R('gate'), R('rsE'), R('rsMid'), R('rsW')]);
    road([R('rsW'), R('dropW'), R('truckCourt'), R('holdOut'), R('holdIn'), R('boxCourt')]);
    road([R('courtE'), R('gapS'), R('gapN')]);
    road([R('gapN'), R('behindE'), { x: dc.x - 40, z: dc.z - 238 }, R('laneExitE'), R('laneEntryW'), R('northMid'), R('northW'), R('boxCourt')]);
    road([R('northMid'), R('boxCourtE')]);
    road([R('gapN'), R('laneEntryE')], 8);
    road([R('laneEntryW'), sectionAt(L.rail.W, L.rail.W.len - 30, L.rail.W.laneV)], 8);
    road([sectionAt(L.rail.E, 46, L.rail.E.laneV), R('laneExitE')], 8);
    road([R('laneExitW'), sectionAt(L.rail.W, -34, L.rail.W.legV[1] as number), R('boxCourt')], 8);
    // —— 水泥地坪：配送中心和冷链中心门前 18 米（盖住原来的线）、转运仓两面的门前 ——
    const CON = '#c3c1b8';
    p.push(box(L.coldBox.x1 + 5 - (L.dcBox.x0 + 10), 0.06, 18, CON, (L.coldBox.x1 + 5 + L.dcBox.x0 + 10) / 2, 0.26, wallZ + 9));
    p.push(box(tl.x1 - tl.x0 + 12, 0.06, 16, CON, (tl.x0 + tl.x1) / 2, 0.26, tl.zS + 8));
    p.push(box(tl.x1 - tl.x0 + 12, 0.06, 14, CON, (tl.x0 + tl.x1) / 2, 0.26, tl.zN - 7));
    // —— 标线 ——
    const W_ = '#f2f2ee';
    const Y_ = '#f0c419';
    for (const d of L.doors) {
      // 门前的导向线（黄）：两条，从墙到 16 米外
      for (const sx of [-1.95, 1.95]) p.push(box(0.15, 0.02, 15, Y_, d.x + sx, 0.33, d.wallZ + d.face * 8.5));
    }
    // 靠台车道的中线（白虚线）、行车方向箭头
    p.push(...strip([{ x: L.dcBox.x0 + 6, z: wallZ + 30 }, { x: L.coldBox.x1 + 10, z: wallZ + 30 }], 0.15, W_, 0.31, 0.02, 3));
    for (let x = L.dcBox.x0 + 20; x < L.coldBox.x1; x += 60) p.push(...arrowParts(x, wallZ + 26, Math.PI / 2), ...arrowParts(x + 30, wallZ + 41, -Math.PI / 2));
    p.push(...strip([{ x: tl.x0 - 14, z: tl.zS + 30 }, { x: tl.x1 + 6, z: tl.zS + 30 }], 0.15, W_, 0.31, 0.02, 3));
    for (let x = tl.x0; x < tl.x1; x += 40) p.push(...arrowParts(x, tl.zS + 27, Math.PI / 2));
    for (let x = tl.x1 - 10; x > tl.x0; x -= 40) p.push(...arrowParts(x, tl.zN - 24, -Math.PI / 2));
    // 双向路的中线（白虚线），单向环线的箭头
    p.push(...strip([R('gate'), R('rsE'), R('rsMid'), R('rsW')], 0.15, W_, 0.24, 0.02, 3));
    p.push(...strip([R('rsW'), R('boxCourt')], 0.15, W_, 0.24, 0.02, 3));
    const loop = [R('gapS'), R('gapN'), R('behindE'), { x: dc.x - 40, z: dc.z - 238 }, R('laneExitE'), R('laneEntryW'), R('northMid'), R('northW'), R('boxCourt')];
    for (let i = 1; i < loop.length; i++) {
      const a = loop[i - 1] as Pt;
      const b = loop[i] as Pt;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const h = Math.atan2(b.x - a.x, b.z - a.z);
      for (let s = 12; s < len - 6; s += 45) p.push(...arrowParts(a.x + ((b.x - a.x) * s) / len, a.z + ((b.z - a.z) * s) / len, h, W_, 0.24));
    }
    // 待命停车场：直进直出的车位线（白），甩挂区：车位线（黄）
    for (const st of L.hold.stalls) p.push(box(0.15, 0.02, st.len, W_, st.x - st.wid / 2, 0.24, st.z), box(0.15, 0.02, st.len, W_, st.x + st.wid / 2, 0.24, st.z));
    for (const z of L.hold.aisles) p.push(...arrowParts(L.hold.x1 - 20, z, -Math.PI / 2, W_, 0.24), ...arrowParts(L.hold.x0 + 30, z, -Math.PI / 2, W_, 0.24));
    for (const st of L.drop.stalls) p.push(box(0.15, 0.02, st.len, Y_, st.x - st.wid / 2, 0.24, st.z), box(st.wid, 0.02, 0.15, Y_, st.x, 0.24, st.z - Math.cos(st.heading) * (st.len / 2)));
    // —— 转运仓：墙（两面留门洞）、门封、防撞块、雨棚、库内地坪（月台高 1.3 米）、屋顶、西头两层的办公楼 ——
    const WALL = '#d9d6cc';
    const t = 0.5;
    const face = (z: number, doors: ParkDoor[], out: 1 | -1) => {
      p.push(box(tl.x1 - tl.x0, DOCK_Y, t, '#b9b6ad', (tl.x0 + tl.x1) / 2, 0, z), box(tl.x1 - tl.x0, tl.h - DOCK_Y - 3.6, t, WALL, (tl.x0 + tl.x1) / 2, DOCK_Y + 3.6, z));
      const xs = [tl.x0, ...doors.flatMap((d) => [d.x - 1.6, d.x + 1.6]), tl.x1];
      for (let i = 0; i < xs.length; i += 2) {
        const a = xs[i] as number;
        const b = xs[i + 1] as number;
        if (b - a > 0.05) p.push(box(b - a, 3.6, t, WALL, (a + b) / 2, DOCK_Y, z));
      }
      for (const d of doors) {
        p.push(box(0.5, 4.2, 0.85, '#1f2226', d.x - 1.9, DOCK_Y - 0.2, z + out * 0.7), box(0.5, 4.2, 0.85, '#1f2226', d.x + 1.9, DOCK_Y - 0.2, z + out * 0.7), box(4.3, 0.6, 0.85, '#1f2226', d.x, DOCK_Y + 3.65, z + out * 0.7));
        p.push(box(0.35, 0.45, 0.25, '#151515', d.x - 1.25, DOCK_Y - 0.55, z + out * 0.38), box(0.35, 0.45, 0.25, '#151515', d.x + 1.25, DOCK_Y - 0.55, z + out * 0.38));
        p.push(box(5.4, 0.2, 2.4, '#8d949b', d.x, DOCK_Y + 4.6, z + out * 1.2));
      }
    };
    face(tl.zS, L.doors.filter((d) => d.group === 'tlTruck'), 1);
    face(tl.zN, L.doors.filter((d) => d.group === 'tlBox'), -1);
    p.push(box(t, tl.h, tl.zS - tl.zN, WALL, tl.x0, 0, (tl.zN + tl.zS) / 2), box(t, tl.h, tl.zS - tl.zN, WALL, tl.x1, 0, (tl.zN + tl.zS) / 2));
    p.push(box(tl.x1 - tl.x0 - 1, 0.2, tl.zS - tl.zN - 1, '#9b9e9f', (tl.x0 + tl.x1) / 2, DOCK_Y - 0.2, (tl.zN + tl.zS) / 2));
    // 库内：两面的暂存道（每樘门一条，16–23 米深）的地标线、中间的通道
    for (const d of L.doors.filter((x) => x.group === 'tlTruck' || x.group === 'tlBox')) {
      const z0 = d.wallZ - d.face * 2;
      const z1 = d.wallZ - d.face * 20;
      p.push(box(0.1, 0.02, Math.abs(z1 - z0), '#3d8ff0', d.x - 1.6, DOCK_Y + 0.01, (z0 + z1) / 2), box(0.1, 0.02, Math.abs(z1 - z0), '#3d8ff0', d.x + 1.6, DOCK_Y + 0.01, (z0 + z1) / 2));
    }
    p.push(box(tl.x1 - tl.x0 - 4, 0.02, 0.12, '#f0c419', (tl.x0 + tl.x1) / 2, DOCK_Y + 0.01, (tl.zN + tl.zS) / 2 - 3), box(tl.x1 - tl.x0 - 4, 0.02, 0.12, '#f0c419', (tl.x0 + tl.x1) / 2, DOCK_Y + 0.01, (tl.zN + tl.zS) / 2 + 3));
    roof.push(box(tl.x1 - tl.x0 + 1.5, 0.8, tl.zS - tl.zN + 1.5, '#c9ccd1', (tl.x0 + tl.x1) / 2, tl.h, (tl.zN + tl.zS) / 2));
    for (let x = tl.x0 + 10; x < tl.x1 - 6; x += 16) roof.push(box(4, 0.3, tl.zS - tl.zN - 12, '#e8f0f6', x, tl.h + 0.8, (tl.zN + tl.zS) / 2));
    p.push(box(14, 8, 22, '#e7e4dc', tl.x0 - 8, 0, (tl.zN + tl.zS) / 2), box(14.2, 0.4, 22.2, '#7a8088', tl.x0 - 8, 8, (tl.zN + tl.zS) / 2));
    for (let k = 0; k < 2; k++) p.push(box(14.1, 1.3, 18, '#7fa7d6', tl.x0 - 8, 1.6 + k * 3.4, (tl.zN + tl.zS) / 2));
    // —— 门口：两进两出四条车道、登记亭（司机一侧）、识别门架、雨棚、中间的岗亭 ——
    const kz = L.kioskIn[0] as Pt;
    const oz = L.kioskOut[0] as Pt;
    const lanesX = [...L.kioskOut.map((q) => q.x), ...L.kioskIn.map((q) => q.x)];
    const gx0 = Math.min(...lanesX) - 4;
    const gx1 = Math.max(...lanesX) + 4;
    p.push(box(gx1 - gx0, 0.1, 26, ASPH, (gx0 + gx1) / 2, 0.13, dc.z - 15));
    // 车道之间的安全岛（路缘石）
    const isl = (x0: number, x1: number) => p.push(box(x1 - x0, 0.25, 14, '#c9c6bd', (x0 + x1) / 2, 0.13, dc.z - 15));
    isl((L.kioskOut[1] as Pt).x + 1.9, (L.kioskOut[0] as Pt).x - 1.9);
    isl((L.kioskOut[0] as Pt).x + 1.9, (L.kioskIn[0] as Pt).x - 1.9);
    isl((L.kioskIn[0] as Pt).x + 1.9, (L.kioskIn[1] as Pt).x - 1.9);
    // 登记亭：进门的在车道西边（车头朝北，左舵车司机在西边），出门的在车道东边
    for (const q of L.kioskIn) p.push(box(1.0, 1.6, 1.2, '#dfe3e6', q.x - 2.4, 0.38, kz.z), box(0.8, 0.6, 0.1, '#1b2a3a', q.x - 2.4, 1.4, kz.z - 0.62), box(0.2, 1.4, 0.2, '#f0c419', q.x - 2.4, 0.38, kz.z + 1.6));
    for (const q of L.kioskOut) p.push(box(1.0, 1.6, 1.2, '#dfe3e6', q.x + 2.4, 0.38, oz.z), box(0.8, 0.6, 0.1, '#1b2a3a', q.x + 2.4, 1.4, oz.z + 0.62), box(0.2, 1.4, 0.2, '#f0c419', q.x + 2.4, 0.38, oz.z - 1.6));
    // 岗亭（中间的安全岛上）
    const mx = ((L.kioskOut[0] as Pt).x + (L.kioskIn[0] as Pt).x) / 2;
    p.push(box(3.4, 2.8, 4.2, '#eef0f2', mx, 0.38, dc.z - 22), box(3.8, 0.3, 4.6, '#2a78d6', mx, 3.18, dc.z - 22), box(3.45, 1.0, 4.25, '#9fc0ea', mx, 1.5, dc.z - 22));
    // 雨棚：四根柱子、顶板、蓝色檐口
    for (const x of [gx0 + 1, gx1 - 1]) for (const z of [dc.z - 8, dc.z - 22]) p.push(box(0.4, 6.2, 0.4, '#9aa0a6', x, 0, z));
    roof.push();
    p.push(box(gx1 - gx0 + 1, 0.5, 17, '#e8e8e4', (gx0 + gx1) / 2, 6.2, dc.z - 15), box(gx1 - gx0 + 1.2, 0.8, 0.3, '#2a78d6', (gx0 + gx1) / 2, 6.0, dc.z - 6.4), box(gx1 - gx0 + 1.2, 0.8, 0.3, '#2a78d6', (gx0 + gx1) / 2, 6.0, dc.z - 23.6));
    // 识别门架（进门车道上方，车牌、箱号识别摄像头）
    const ix0 = (L.kioskIn[0] as Pt).x - 2.2;
    const ix1 = (L.kioskIn[1] as Pt).x + 2.2;
    p.push(box(0.3, 5.6, 0.3, '#5b6067', ix0, 0, dc.z - 3), box(0.3, 5.6, 0.3, '#5b6067', ix1, 0, dc.z - 3), box(ix1 - ix0, 0.4, 0.4, '#5b6067', (ix0 + ix1) / 2, 5.6, dc.z - 3));
    for (const q of L.kioskIn) p.push(box(0.4, 0.3, 0.6, '#1b1f24', q.x, 5.2, dc.z - 3));
    // 停车线
    for (const q of L.kioskIn) p.push(box(3.3, 0.02, 0.35, W_, q.x, 0.25, q.z - 9.5));
    for (const q of L.kioskOut) p.push(box(3.3, 0.02, 0.35, W_, q.x, 0.25, q.z + 9.5));
    // —— 道闸的底座 ——
    for (const q of L.kioskIn) p.push(box(0.5, 1.0, 0.5, '#f0c419', q.x - 2.0, 0.13, q.z - 5));
    for (const q of L.kioskOut) p.push(box(0.5, 1.0, 0.5, '#f0c419', q.x + 2.0, 0.13, q.z + 5));
    // —— 高杆灯：待命停车场、甩挂区、拆箱车场 ——
    for (const [x, z] of [
      [L.hold.x0 + 4, L.hold.z0 + 6],
      [L.hold.x0 + 4, L.hold.z1 - 6],
      [L.drop.x0 - 4, L.drop.aisleZ],
      [L.drop.x1 + 6, L.drop.aisleZ],
      [tl.x0 - 6, tl.zN - 20],
    ] as [number, number][])
      p.push(cyl(0.3, 0.45, 22, '#9aa3ab', x, 0, z), box(2.6, 0.8, 2.6, '#f4f1e6', x, 22, z));
    const body = new THREE.Mesh(merge(p), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    body.receiveShadow = true;
    body.castShadow = true;
    body.name = 'park-yard-static';
    this.group.add(body);
    const rm = new THREE.Mesh(merge(roof), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    rm.castShadow = true;
    this.roof.add(rm);
    // 标牌
    this.group.add(
      sign('铁路转运仓', (tl.x0 + tl.x1) / 2, tl.zS + 46, 0, 9),
      sign('待命停车场 · 直进直出', (L.hold.x0 + L.hold.x1) / 2, L.hold.z1 + 4, 0, 9),
      sign('甩挂区', L.drop.x0 - 2, L.drop.z1 + 3, 0, 5),
      sign('进园登记 · 按预约到车', (L.kioskIn[1] as Pt).x + 7, dc.z - 2, 0, 9),
      sign('短驳环线 · 单向', (N.gapS as Pt).x - 7, (N.gapS as Pt).z - 6, Math.PI / 2, 7),
      sign('拆箱车场 · 从东头进', (N.boxCourtE as Pt).x + 6, (N.boxCourtE as Pt).z + 2, -Math.PI / 2, 8),
    );
  }

  /** 当天的计划；approach(k, out)：外来的车从第 k 条公路开来（out = 开走），给物流园局部坐标里的折线（远处 → 路口） */
  setPlan(plan: ParkPlan, approach: (k: number, out: boolean) => Pt[]): void {
    drain(this.setPlanSteps(plan, approach));
  }

  /**
   * 和 setPlan 一样，分段排（场内每辆车排轨迹一段，互相让的检查每一段动的一段）：先后、结果都和一口气排完一样。
   * 车的轨迹都排好才一起换上（和一口气排时一样，排每辆车时看到的还是上一份）；互相让的那几段边查边改等待。
   * Same as setPlan, split into steps (one actor, then one moving segment per step).
   */
  *setPlanSteps(plan: ParkPlan, approach: (k: number, out: boolean) => Pt[]): Steps {
    this.plan = plan;
    this.L = plan.layout;
    this.oneWay = new Set();
    for (const e of this.L.edges) {
      if (!e.oneWay) continue;
      const line = [this.L.nodes[e.a] as Pt, ...(e.via ?? []), this.L.nodes[e.b] as Pt];
      for (let i = 0; i + 1 < line.length; i++) {
        this.oneWay.add(segKey(line[i] as Pt, line[i + 1] as Pt));
        this.oneWay.add(segKey(line[i + 1] as Pt, line[i] as Pt));
      }
    }
    this.ownHook = new Map(plan.sims.filter((s) => s.drop).map((s) => [(s.drop as { trailer: string }).trailer, (s.drop as { hookAt: number }).hookAt]));
    const tracks: Track[] = [];
    for (const a of plan.actors) {
      tracks.push(this.track(a, approach));
      yield;
    }
    this.tracks = tracks;
    this.units = this.parkedUnits();
    this.queueAhead();
    yield;
    yield* this.yieldPass();
  }

  /**
   * 场内路上的车互相让（跟车、错车、路口让行）：按出发的先后，每一段动的（开过去、倒车、拉出）沿轨迹每秒查一次车身和别的车（开着的、停着的）
   * 碰不碰；碰上就在起点多等一会儿（每次 2 秒，最多这一段时长的三成），后面开快一点、还是按计划的时刻到。先走的不让后来的，后来的自己等。
   */
  private *yieldPass(): Steps {
    type It = { tr: Track; seg: Seg; x0: number; x1: number; z0: number; z1: number };
    const items: It[] = [];
    const o: Pose = { x: 0, z: 0, h: 0, th: 0 };
    for (const tr of this.tracks)
      for (const seg of tr.segs) {
        let x0 = Infinity;
        let x1 = -Infinity;
        let z0 = Infinity;
        let z1 = -Infinity;
        const n = seg.rig ? 8 : 0;
        for (let k = 0; k <= n; k++) {
          if (seg.rig) seg.rig.at((seg.rig.len * k) / Math.max(1, n), o);
          else Object.assign(o, seg.end.x === seg.start.x ? seg.start : seg.end);
          x0 = Math.min(x0, o.x);
          x1 = Math.max(x1, o.x);
          z0 = Math.min(z0, o.z);
          z1 = Math.max(z1, o.z);
        }
        items.push({ tr, seg, x0: x0 - 16, x1: x1 + 16, z0: z0 - 16, z1: z1 + 16 });
      }
    const moving = items.filter((it) => it.seg.rig && it.seg.t1 - it.seg.t0 > 4).sort((a, b) => a.seg.t0 - b.seg.t0);
    for (const m of moving) {
      yield;
      const seg = m.seg;
      const near = new Set<Track>();
      for (const it of items) if (it.tr !== m.tr && it.seg.t0 < seg.t1 + 1 && it.seg.t1 > seg.t0 - 1 && it.x0 < m.x1 && it.x1 > m.x0 && it.z0 < m.z1 && it.z1 > m.z0) near.add(it.tr);
      if (!near.size) continue;
      const list = [...near];
      if (!this.clash(m.tr, seg, list)) continue;
      let ok = false;
      for (let D = 2; D <= (seg.t1 - seg.t0) * 0.6 && !ok; D += 2) {
        seg.delay = D;
        ok = !this.clash(m.tr, seg, list);
        // 长的一段要试很多次：每试一次让出一下（分段排时）
        yield;
      }
      if (!ok) delete seg.delay;
      // 还是碰：前后都是停着的（等着、挂摘挂车、装卸）就整段往后挪（前面多等、后面那一步少用一点时间），车速不变
      if (!ok) {
        const i = m.tr.segs.indexOf(seg);
        const prev = m.tr.segs[i - 1];
        const next = m.tr.segs[i + 1];
        // 后面一步是动的也行：它晚一点出发、开快一点（最多快三成），到的时刻不变
        if (prev && next && !prev.rig && !prev.queue && (!next.rig || !next.delay)) {
          const t00 = seg.t0;
          const t10 = seg.t1;
          const room = Math.min(150, next.rig ? (next.t1 - next.t0) * 0.3 : next.t1 - next.t0 - 8);
          let D = 0;
          for (let d = 2; d <= Math.min(90, room) && !ok; d += 2) {
            seg.t0 = t00 + d;
            seg.t1 = t10 + d;
            ok = !this.clash(m.tr, seg, list);
            if (ok) D = d;
            yield;
          }
          seg.t0 = t00 + D;
          seg.t1 = t10 + D;
          prev.t1 += D;
          next.t0 += D;
        }
      }
    }
  }
  /** 这一段（按现在的等待）每秒的车身和别的车碰不碰 */
  private clash(tr: Track, seg: Seg, others: Track[]): boolean {
    const a = this.qa;
    const b = this.qb;
    for (let t = seg.t0 + 0.5; t < seg.t1; t += 1) {
      this.poseIn(seg, t, a);
      const na = this.bodies(tr, seg, t, a, this.ba);
      for (const ot of others) {
        const s2 = this.segAt(ot, t);
        if (!s2) continue;
        this.poseIn(s2, t, b);
        const nb = this.bodies(ot, s2, t, b, this.bb);
        for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) if (bodyHit(this.ba[i] as Body, this.bb[j] as Body)) return true;
      }
    }
    return false;
  }
  /** 一辆车此刻的车身：牵引车，加上拖着的挂车 / 骨架车（挂、摘的那一段按一半时刻算） */
  private bodies(tr: Track, seg: Seg, t: number, o: Pose, out: Body[]): number {
    const put = (i: number, h: number, front: number, rear: number) => {
      const b = (out[i] ??= { cx: 0, cz: 0, h: 0, hl: 0, hw: 0 });
      const c = (front - rear) / 2;
      b.cx = o.x + Math.sin(h) * c;
      b.cz = o.z + Math.cos(h) * c;
      b.h = h;
      b.hl = (front + rear) / 2 - 0.2;
      b.hw = 1.2;
    };
    if (tr.term) put(0, o.h, 2.9, 1.4);
    else put(0, o.h, 4.4, 1.6);
    const mid = (seg.t0 + seg.t1) / 2;
    const k = seg.leg.kind;
    const tow = k === 'hook' ? (t >= mid ? seg.leg.tow : undefined) : k === 'unhook' ? (t < mid ? seg.leg.tow : undefined) : seg.leg.tow;
    if (!tow) return 1;
    if (tow.kind === 'chassis') put(1, o.th, 1.0, 11.2);
    else put(1, o.th, 1.2, 12.4);
    return 2;
  }

  /** 一辆车的各段：开过去（牵引销沿路走、挂车追踪）、倒车（挂车车轴沿曲线退进门）、拉出、停着 */
  private track(a: Actor, approach: (k: number, out: boolean) => Pt[]): Track {
    const term = a.kind === 'shuttle' || a.kind === 'shunter';
    const road = a.gateIn !== undefined;
    let legs = [...a.legs];
    // 外来的车：路上和门外排队交给外来货车层，从开始登记（车停在登记亭、车头朝园内）画起
    if (road && this.extRoad) {
      const k = legs.findIndex((l) => l.kind === 'kiosk');
      if (k > 0) legs = legs.slice(k);
    }
    // 外来的车（没有外来货车层时）：前面接上从公路开来的一段、后面接上开走的一段
    if (road && !this.extRoad && a.road && legs.length) {
      const first = legs[0] as Leg;
      const p0 = (first.path?.[0] ?? this.L.nodes.gate) as Pt;
      const inPts = [...approach(a.road.in, false), { x: p0.x, z: p0.z + 22 }, p0];
      const dur = new Polyline(inPts).length / 8.5;
      legs.unshift({ t0: first.t0 - dur, t1: first.t0, kind: 'drive', path: inPts, ...(first.tow ? { tow: first.tow } : {}), note: '开来' });
      const last = legs[legs.length - 1] as Leg;
      const p1 = (last.path?.[last.path.length - 1] ?? this.L.nodes.gate) as Pt;
      const outPts = [p1, { x: p1.x, z: p1.z + 14 }, ...[...approach(a.road.out, true)].reverse()];
      const dur2 = new Polyline(outPts).length / 8.5;
      legs.push({ t0: last.t1, t1: last.t1 + dur2, kind: 'drive', path: outPts, ...(last.tow ? { tow: last.tow } : {}), note: '开走' });
    }
    // 接连的两段行驶并成一段：拐角一起倒圆、中间不停车
    for (let i = legs.length - 1; i > 0; i--) {
      const x = legs[i - 1] as Leg;
      const y = legs[i] as Leg;
      if (x.kind !== 'drive' || y.kind !== 'drive' || Math.abs(y.t0 - x.t1) > 1 || !x.path || !y.path) continue;
      if ((x.tow?.box ?? x.tow?.trailer ?? x.tow?.kind) !== (y.tow?.box ?? y.tow?.trailer ?? y.tow?.kind)) continue;
      legs.splice(i - 1, 2, { ...x, t1: y.t1, path: [...x.path, ...y.path.slice(1)] });
    }
    const segs: Seg[] = [];
    let cur: Pose | undefined;
    // 第一段之前的姿态：沿第一段动的方向
    const firstMove = legs.find((l) => (l.kind === 'drive' || l.kind === 'pull') && (l.path?.length ?? 0) >= 2);
    if (road && this.extRoad && legs[0]?.kind === 'kiosk' && legs[0].path?.[0]) {
      const s0 = legs[0].path[0] as Pt;
      cur = { x: s0.x, z: s0.z, h: Math.PI, th: Math.PI };
    } else if (firstMove?.path) {
      const [q0, q1] = firstMove.path as [Pt, Pt];
      const h = Math.atan2(q1.x - q0.x, q1.z - q0.z);
      const s0 = (legs[0]?.path?.[0] ?? q0) as Pt;
      cur = { x: s0.x, z: s0.z, h, th: h };
    } else cur = { x: (this.L.nodes.dropW as Pt).x, z: (this.L.nodes.dropW as Pt).z, h: Math.PI, th: Math.PI };
    for (const leg of legs) {
      const start = { ...cur };
      const seg: Seg = { t0: leg.t0, t1: leg.t1, leg, start, end: start };
      const towK = leg.tow ? (leg.tow.kind === 'chassis' ? 'chassis' : 'trailer') : undefined;
      if (leg.kind === 'drive' && (leg.path?.length ?? 0) >= 2) {
        // 拖着挂车的转弯半径不小于 12 米（路网上的拐角放得下时），光车头 9 米
        const pts = fillet(unreverse(this.keepRight([{ x: start.x, z: start.z }, ...(leg.path as Pt[]).slice(1)]), start.h), towK ? 13 : 9, 1);
        const line = new Polyline(pts, 0.5);
        if (towK) {
          const rig = new ForwardRig(line, AXLE[towK], start.th);
          seg.rig = { len: rig.length, at: (s, o) => this.rigPose(rig, s, o) };
        } else seg.rig = { len: line.length, at: (s, o) => this.linePose(line, s, o, false) };
      } else if (leg.kind === 'back' && (leg.door || leg.stall)) {
        seg.back = true;
        const dock = this.dockPose(leg, towK);
        if (towK) {
          // 挂车车轴：从现在的位置退到靠稳的位置（起点沿挂车反方向、终点对着门 / 车位），平顺的三次曲线
          const L = AXLE[towK];
          const dt0 = dir(start.th);
          const A0 = { x: start.x - dt0.x * L, z: start.z - dt0.z * L };
          const dd = dir(dock.th);
          const Ad = { x: dock.x - dd.x * L, z: dock.z - dd.z * L };
          const k = Math.max(4, Math.hypot(Ad.x - A0.x, Ad.z - A0.z) * 0.45);
          const P1 = { x: A0.x - dt0.x * k, z: A0.z - dt0.z * k };
          const P2 = { x: Ad.x + dd.x * k, z: Ad.z + dd.z * k };
          const pts: Pt[] = [];
          for (let i = 0; i <= 40; i++) {
            const u = i / 40;
            const v = 1 - u;
            pts.push({ x: v * v * v * A0.x + 3 * v * v * u * P1.x + 3 * v * u * u * P2.x + u * u * u * Ad.x, z: v * v * v * A0.z + 3 * v * v * u * P1.z + 3 * v * u * u * P2.z + u * u * u * Ad.z });
          }
          const rig = new ReverseRig(pts, L, start.h);
          seg.rig = { len: rig.length, at: (s, o) => this.rigPose(rig, s, o) };
        } else {
          // 光车头倒到挂车 / 骨架车的牵引销下面
          const d0 = dir(start.h);
          const dd = dir(dock.h);
          const k = Math.max(3, Math.hypot(dock.x - start.x, dock.z - start.z) * 0.45);
          const pts: Pt[] = [];
          for (let i = 0; i <= 30; i++) {
            const u = i / 30;
            const v = 1 - u;
            const P1 = { x: start.x - d0.x * k, z: start.z - d0.z * k };
            const P2 = { x: dock.x + dd.x * k, z: dock.z + dd.z * k };
            pts.push({ x: v * v * v * start.x + 3 * v * v * u * P1.x + 3 * v * u * u * P2.x + u * u * u * dock.x, z: v * v * v * start.z + 3 * v * v * u * P1.z + 3 * v * u * u * P2.z + u * u * u * dock.z });
          }
          const line = new Polyline(pts, 0.5);
          seg.rig = { len: line.length, at: (s, o) => this.linePose(line, s, o, true) };
        }
      } else if (leg.kind === 'pull' && (leg.door || leg.stall)) {
        // 拉出：先顺着挂车方向笔直开出 14 米，再转到拉出点
        const end = (leg.path?.[leg.path.length - 1] ?? doorOut(this.L.doors[0] as ParkDoor)) as Pt;
        const d = dir(start.th);
        // 笔直开出的长度不超过到拉出点的距离（车位前的通道窄，不开过头再折回来）
        const run = Math.max(2, Math.min(14, (end.x - start.x) * d.x + (end.z - start.z) * d.z - 2));
        const pts = fillet([{ x: start.x, z: start.z }, { x: start.x + d.x * run, z: start.z + d.z * run }, end], 8, 1);
        const line = new Polyline(pts, 0.5);
        if (towK) {
          const rig = new ForwardRig(line, AXLE[towK], start.th);
          seg.rig = { len: rig.length, at: (s, o) => this.rigPose(rig, s, o) };
        } else seg.rig = { len: line.length, at: (s, o) => this.linePose(line, s, o, false) };
      }
      if (seg.rig) {
        const e: Pose = { x: 0, z: 0, h: 0, th: 0 };
        seg.rig.at(seg.rig.len, e);
        if (!towK) e.th = e.h;
        seg.end = e;
      } else if (leg.kind === 'hook' && towK) {
        // 挂上：挂车的朝向就是它停着的朝向（车头倒到牵引销下面时牵引车和挂车对齐）
        seg.end = { ...start, th: start.h };
      } else if (leg.kind === 'unhook') seg.end = { ...start };
      else if (leg.kind === 'hold' && road && segs.length <= 1 && (leg.path?.length ?? 0) >= 1) {
        seg.end = { ...start };
      }
      segs.push(seg);
      cur = seg.end;
    }
    // 门外排队：登记前等着的车，排在前面的车后面（前面走一辆往前挪一个车位）
    if (road) {
      const hold = segs.find((s) => s.leg.kind === 'hold' && !s.leg.stall && s.leg.note?.includes('排队'));
      const appr = segs[0];
      if (hold && appr?.rig && hold.t1 - hold.t0 > 5) {
        hold.queue = { rig: appr.rig, ahead: [] };
      }
    }
    return { actor: a, segs, road, term };
  }

  /** 双向的场内路上靠右走：折线中间的点往行驶方向的右侧挪半个车道（单行的路段不挪；起点、终点不挪，和前后两段接得上） */
  private keepRight(pts: Pt[]): Pt[] {
    const n = pts.length;
    if (n < 3) return pts;
    const nr: ({ x: number; z: number } | undefined)[] = [];
    for (let i = 0; i + 1 < n; i++) {
      const a = pts[i] as Pt;
      const b = pts[i + 1] as Pt;
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      nr.push(l < 0.5 || this.oneWay.has(segKey(a, b)) ? undefined : { x: -(b.z - a.z) / l, z: (b.x - a.x) / l });
    }
    const out: Pt[] = [pts[0] as Pt];
    for (let i = 1; i < n - 1; i++) {
      const p = pts[i] as Pt;
      const u = nr[i - 1];
      const v = nr[i];
      const mx = (u?.x ?? 0) + (v?.x ?? 0);
      const mz = (u?.z ?? 0) + (v?.z ?? 0);
      const ml = Math.hypot(mx, mz);
      // 掉头的点、单行路上的点不挪；两段都靠右时按夹角斜接（最多挪两个半车道），只有一段时挪一半
      if ((!u && !v) || ml < 0.3) out.push(p);
      else {
        const k = u && v ? Math.min(2 / (ml * ml), 2 / ml) : 0.5;
        out.push({ x: p.x + mx * k * LANE, z: p.z + mz * k * LANE });
      }
    }
    out.push(pts[n - 1] as Pt);
    return out;
  }

  /** 外来的车交给外来货车层的那一部分（见 ParkTrip）：同一条进门车道上排在前面的车也算上本店的仿真车（只走 1 号车道） */
  trips(): ParkTrip[] {
    const plan = this.plan;
    if (!plan || !this.extRoad) return [];
    const hex = (c: string) => parseInt(c.slice(1), 16);
    const buildOf = (tw: Tow | undefined): 0 | 1 | 2 | 5 => (!tw ? 5 : tw.kind === 'chassis' ? 0 : tw.reefer ? 2 : 1);
    const laneOf = (s: Seg) => (/2 号/.test(s.leg.note ?? '') ? 1 : 0);
    const kiosks: { lane: number; t0: number; t1: number; tr?: Track }[] = [];
    for (const tr of this.tracks) {
      const k = tr.segs[0];
      if (tr.road && k?.leg.kind === 'kiosk' && !/出门/.test(k.leg.note ?? '')) kiosks.push({ lane: laneOf(k), t0: k.t0, t1: k.t1, tr });
    }
    for (const sv of plan.sims) if (sv.checkIn[1] > sv.checkIn[0]) kiosks.push({ lane: 0, t0: sv.checkIn[0], t1: sv.checkIn[1] });
    const out: ParkTrip[] = [];
    for (const tr of this.tracks) {
      const k = tr.segs[0];
      const z = tr.segs[tr.segs.length - 1];
      if (!tr.road || !k || !z || k === z || k.leg.kind !== 'kiosk' || z.leg.kind !== 'kiosk' || !/出门/.test(z.leg.note ?? '')) continue;
      const a = tr.actor;
      const lane = laneOf(k);
      const arrive = Math.min(k.t0, a.legs[0]?.t0 ?? k.t0);
      const ahead = kiosks
        .filter((o) => o.tr !== tr && o.lane === lane && o.t0 < k.t0 && o.t1 > arrive - 90)
        .map((o) => o.t1)
        .sort((x, y) => x - y);
      const color = a.kind === 'carrier' ? '#b8352e' : a.kind === 'dray' ? '#3f6e4a' : '#e9e9e6';
      const ti = k.leg.tow;
      const to = z.leg.tow;
      out.push({
        id: a.id,
        buildIn: buildOf(ti),
        buildOut: buildOf(to),
        ...(ti?.box && ti.color ? { boxIn: hex(ti.color) } : {}),
        ...(to?.box && to.color ? { boxOut: hex(to.color) } : {}),
        cab: hex(color),
        trailerIn: ti?.loaded ? 0xf4f4f1 : 0xdcdcd6,
        trailerOut: to?.loaded ? 0xf4f4f1 : 0xdcdcd6,
        arrive,
        kiosk: k.t0,
        leave: z.t1,
        lane,
        kioskAt: { x: k.start.x, z: k.start.z },
        ahead,
        out: { x: z.end.x, z: z.end.z, h: z.end.h, th: z.end.th },
      });
    }
    return out;
  }

  /** 门外排队的车：同一条进门车道上排在它前面、还没登记完的车（登记完的时刻） */
  private queueAhead(): void {
    const byLane = new Map<number, Track[]>();
    for (const tr of this.tracks) {
      const kiosk = tr.segs.find((s) => s.leg.kind === 'kiosk');
      if (!kiosk) continue;
      const lane = /2 号/.test(kiosk.leg.note ?? '') ? 1 : 0;
      byLane.set(lane, [...(byLane.get(lane) ?? []), tr]);
    }
    for (const list of byLane.values()) {
      for (const tr of list) {
        const hold = tr.segs.find((s) => s.queue);
        if (!hold?.queue) continue;
        const kiosk = tr.segs.find((s) => s.leg.kind === 'kiosk') as Seg;
        hold.queue.ahead = list
          .filter((o) => o !== tr)
          .map((o) => o.segs.find((s) => s.leg.kind === 'kiosk') as Seg)
          .filter((k) => k.t0 < kiosk.t0 && k.t1 > hold.t0)
          .map((k) => k.t1);
        // 开来的那一段就停在队尾，不开到登记亭再退回来
        (tr.segs[0] as Seg).short = hold.queue.ahead.length * QUEUE_GAP;
      }
    }
  }

  private rigPose(rig: ForwardRig | ReverseRig, s: number, o: Pose): void {
    rig.poseAt(s, this.rp);
    o.x = this.rp.x;
    o.z = this.rp.z;
    o.h = this.rp.heading;
    o.th = this.rp.trailer;
  }
  private linePose(line: Polyline, s: number, o: Pose, back: boolean): void {
    const st = { x: 0, z: 0, heading: 0 };
    line.at(s, st);
    o.x = st.x;
    o.z = st.z;
    o.h = back ? st.heading + Math.PI : st.heading;
    o.th = o.h;
  }

  /** 靠稳（或停进车位）时的位姿：牵引销的位置、挂车 / 牵引车朝向（车头背对墙） */
  private dockPose(leg: Leg, towK: 'chassis' | 'trailer' | undefined): Pose {
    const kind = towK ?? (leg.tow?.kind === 'chassis' ? 'chassis' : 'trailer');
    if (leg.door) {
      const d = this.L.doors.find((x) => x.id === leg.door) as ParkDoor;
      const th = d.face > 0 ? 0 : Math.PI;
      const rear = REAR[kind];
      // 光车头来挂骨架车 / 挂车时：门上停着的是哪种（拆箱门是骨架车）
      const r2 = !towK && d.group !== 'tlTruck' && d.group !== 'dc' ? REAR.chassis : !towK && d.group === 'dc' && this.unitAt(leg) === 'chassis' ? REAR.chassis : rear;
      return { x: d.x, z: d.wallZ + d.face * (0.6 + r2), h: th, th };
    }
    const st = [...this.L.drop.stalls, ...this.L.hold.stalls].find((x) => x.id === leg.stall);
    if (!st) return { x: 0, z: 0, h: 0, th: 0 };
    const d = dir(st.heading);
    const off = REAR.trailer - TRAILER_LEN.trailer / 2;
    return { x: st.x + d.x * off, z: st.z + d.z * off, h: st.heading, th: st.heading };
  }
  /** 门上停着的是骨架车还是挂车（光车头倒过去挂的时候用） */
  private unitAt(leg: Leg): 'chassis' | 'trailer' {
    const u = this.plan?.doorUse.find((x) => x.door === leg.door && leg.t0 >= x.t0 - 60 && leg.t0 <= x.t1 + 60);
    return u?.kind === 'devan' ? 'chassis' : 'trailer';
  }

  /** 甩在门上、车位上的挂车和骨架车：摘下来到被挂走（一早就在车位上的空挂车从当天开始） */
  private parkedUnits(): Unit[] {
    const out: Unit[] = [];
    const open = new Map<string, Unit>();
    const idOf = (tw: Tow) => tw.trailer ?? tw.box ?? '';
    const evs: { t: number; kind: 'hook' | 'unhook'; seg: Seg }[] = [];
    for (const tr of this.tracks)
      for (const s of tr.segs) {
        if (s.leg.kind === 'unhook' && s.leg.tow) evs.push({ t: (s.t0 + s.t1) / 2, kind: 'unhook', seg: s });
        if (s.leg.kind === 'hook' && s.leg.tow) evs.push({ t: (s.t0 + s.t1) / 2, kind: 'hook', seg: s });
      }
    evs.sort((a, b) => a.t - b.t);
    // 一早就在车位上的挂车（计划里从 −1 小时起的）
    for (const t of this.plan?.trailers ?? []) {
      if (t.t0 > -1) continue;
      const st = this.L.drop.stalls.find((x) => x.id === t.stall);
      if (!st) continue;
      const d = dir(st.heading);
      const off = REAR.trailer - TRAILER_LEN.trailer / 2;
      const u: Unit = { tow: { kind: 'trailer', trailer: t.id, loaded: t.loaded, reefer: t.reefer }, pose: { x: st.x + d.x * off, z: st.z + d.z * off, h: st.heading, th: st.heading }, t0: -3600, t1: 30 * 3600 };
      open.set(t.id, u);
      out.push(u);
    }
    for (const e of evs) {
      const tw = e.seg.leg.tow as Tow;
      const id = idOf(tw);
      if (e.kind === 'unhook') {
        const u: Unit = { tow: tw, pose: { ...e.seg.end }, t0: e.t, t1: this.ownHook.get(id) ?? 30 * 3600 };
        open.set(id, u);
        out.push(u);
      } else {
        const u = open.get(id);
        if (u) {
          u.t1 = e.t;
          open.delete(id);
        }
      }
    }
    return out;
  }

  /** 仿真车经过门口（区域车辆层算的）：两个方向的道闸都抬 */
  setSimGate(busy: boolean): void {
    this.simGate = busy;
  }

  update(t: number, near: boolean, scale = 1): void {
    if (!this.plan) return;
    this.roof.visible = !near;
    this.inside.visible = near;
    const P = this.pools;
    for (const k of Object.keys(P) as (keyof typeof P)[]) P[k].begin();
    const gate = this.L.nodes.gate as Pt;
    const busy = [false, false, false, false];
    this.lamps.begin(t);
    const night = isNight(t);
    for (const tr of this.tracks) {
      const seg = this.segAt(tr, t);
      if (!seg) {
        // 出门登记完交给外来货车层：开过道闸的那几秒杆还抬着
        const z = tr.segs[tr.segs.length - 1];
        if (tr.road && this.extRoad && z?.leg.kind === 'kiosk' && t >= z.t1 && t < z.t1 + 9) busy[2 + (/2 号/.test(z.leg.note ?? '') ? 1 : 0)] = true;
        continue;
      }
      const o = this.pose;
      this.poseIn(seg, t, o);
      // 路上远看时放大（和区域里的车一样），进到园区里按真实大小
      const far = tr.road ? Math.min(1, Math.max(0, (Math.hypot(o.x - gate.x, o.z - gate.z) - 60) / 140)) : 0;
      const sc = 1 + (scale - 1) * far;
      const mid = (seg.t0 + seg.t1) / 2;
      const tow = seg.leg.kind === 'hook' ? (t >= mid ? seg.leg.tow : undefined) : seg.leg.kind === 'unhook' ? (t < mid ? seg.leg.tow : undefined) : seg.leg.tow;
      // 车灯：夜里开着的、刚停下的车亮大灯尾灯；减速、停着等（登记、排队）亮刹车灯；倒车亮倒车灯；转弯打转向灯；倒车靠台、挂摘挂车打双闪
      const st = this.ls;
      const moving = !!seg.rig && t > seg.t0 + (seg.delay ?? 0) && t < seg.t1;
      const kind = seg.leg.kind;
      st.night = night && (moving || seg.t1 - seg.t0 < 600 || kind === 'kiosk');
      st.rev = moving && !!seg.back;
      st.hazard = kind === 'back' || kind === 'hook' || kind === 'unhook';
      st.brake = moving ? prog(t, seg.t0, seg.t1) > 0.86 : !!seg.rig || kind === 'kiosk' || kind === 'hold' || (kind === 'park' && seg.t1 - seg.t0 < 300);
      st.turn = 0;
      if (moving && !seg.back) {
        this.poseIn(seg, Math.min(seg.t1, t + 1.5), this.p2);
        st.turn = turnOf(o.h, this.p2.h);
      }
      this.drawRig(tr.term, tr.actor, o, tow, sc, kind === 'xfer', st);
      if (seg.leg.kind === 'kiosk') {
        const lane = /2 号/.test(seg.leg.note ?? '') ? 1 : 0;
        if (/出门/.test(seg.leg.note ?? '')) busy[2 + lane] = busy[2 + lane] || t > seg.t1 - 4;
        else busy[lane] = busy[lane] || t > seg.t1 - 4;
      }
      // 刚登记完、开过道闸
      const prev = tr.segs[tr.segs.indexOf(seg) - 1];
      if (prev?.leg.kind === 'kiosk' && t < seg.t0 + 9) {
        const lane = /2 号/.test(prev.leg.note ?? '') ? 1 : 0;
        busy[(/出门/.test(prev.leg.note ?? '') ? 2 : 0) + lane] = true;
      }
    }
    // 甩着的挂车、骨架车
    for (const u of this.units) if (t >= u.t0 && t < u.t1) this.drawUnit(u.tow, u.pose, t);
    // 道闸：有车登记完就抬杆（2 秒抬起），过去 3 秒后落下；仿真车经过时两个方向的第一条车道都抬
    const dt = Math.min(0.5, Math.max(0, Math.abs(t - this.lastT) > 30 ? 0.5 : 0.25));
    this.lastT = t;
    const lanes = [...this.L.kioskIn.map((q) => ({ x: q.x - 2.0, z: q.z - 5, yaw: 0 })), ...this.L.kioskOut.map((q) => ({ x: q.x + 2.0, z: q.z + 5, yaw: Math.PI }))];
    lanes.forEach((b, i) => {
      const target = busy[i] || (this.simGate && (i === 0 || i === 2)) ? 1 : 0;
      const cur = this.gateOpen[i] as number;
      this.gateOpen[i] = target > cur ? Math.min(1, cur + dt) : Math.max(0, cur - dt * 0.7);
      P.barrier.put(b.x, 1.05, b.z, b.yaw, (this.gateOpen[i] as number) * 1.45);
    });
    // 门：转运仓的卷帘门（有车靠稳才升起），每樘门边的信号灯（红 = 有车 / 在倒车，绿 = 空）
    const plan = this.plan;
    for (const d of this.L.doors) {
      const u = plan.doorUse.find((x) => x.door === d.id && t >= x.t0 && t < x.t1);
      const sim = d.group === 'dc' ? plan.sims.find((s) => s.door === d.id && t >= s.dockAt[0] - 100 && t < s.dockAt[1] + 50) : undefined;
      const occupied = !!u || !!sim;
      P.light.put(d.x + 2.6 * (d.face > 0 ? 1 : -1), DOCK_Y + 2.6, d.wallZ + d.face * 0.35, 0, 0, 1, 1, 1, occupied ? '#ff3b30' : '#28c840');
      if (d.group === 'dc') continue;
      const open = u ? Math.min(ease(prog(t, u.t0 + 90, u.t0 + 100)), 1 - ease(prog(t, u.t1 - 70, u.t1 - 58))) : 0;
      const h = 3.6 * (1 - open * 0.92);
      P.panel.put(d.x, DOCK_Y + 3.6 - h, d.wallZ - d.face * 0.05, 0, 0, 1, h, 1);
      // 库内：门开着就有一台叉车在门和暂存道之间来回
      if (near && open > 0.5) {
        const f = (Math.sin((t / 40) * Math.PI) + 1) / 2;
        const z = d.wallZ - d.face * (2.5 + f * 14);
        P.fork.put(d.x, DOCK_Y, z, d.face > 0 ? Math.PI / 2 : -Math.PI / 2);
        if (Math.cos((t / 40) * Math.PI) > 0) P.pallet.put(d.x, DOCK_Y + 0.15, z - d.face * 1.7, 0);
      }
    }
    // 暂存道上的托盘（按计划的板数，一条条摆满装卸门里的暂存道）
    if (near) {
      const k = Math.max(0, Math.min(plan.staging.length - 1, Math.floor(t / 300)));
      let n = Math.min(380, Math.round(plan.staging[k] ?? 0));
      for (const d of this.L.doors.filter((x) => x.group === 'tlTruck')) {
        for (let j = 0; j < 22 && n > 0; j++, n--) P.pallet.put(d.x + (j % 2 ? 0.7 : -0.7), DOCK_Y, d.wallZ - d.face * (4 + Math.floor(j / 2) * 1.4), 0, 0, 1, 1, 1, '#f3efe4');
        if (n <= 0) break;
      }
    }
    for (const k of Object.keys(P) as (keyof typeof P)[]) P[k].end();
    this.lamps.end();
  }

  private segAt(tr: Track, t: number): Seg | undefined {
    const s = tr.segs;
    if (!s.length || t < (s[0] as Seg).t0 || t >= (s[s.length - 1] as Seg).t1) return undefined;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((s[mid] as Seg).t0 <= t) lo = mid;
      else hi = mid - 1;
    }
    return s[lo];
  }

  private poseIn(seg: Seg, t: number, o: Pose): void {
    if (seg.queue) {
      // 门外排队：前面每有一辆还没登记完，往后排 19 米；前面走一辆，8 秒挪上去
      let back = 0;
      for (const d of seg.queue.ahead) back += QUEUE_GAP * (1 - ease(Math.min(1, Math.max(0, (t - d) / 8))));
      seg.queue.rig.at(Math.max(0, seg.queue.rig.len - back), o);
      return;
    }
    if (!seg.rig) {
      Object.assign(o, seg.end.x === seg.start.x ? seg.start : seg.end);
      return;
    }
    const f = profile(prog(t, seg.t0 + (seg.delay ?? 0), seg.t1), !!seg.back);
    seg.rig.at(Math.max(0, seg.rig.len - (seg.short ?? 0)) * f, o);
    if (!seg.leg.tow && seg.leg.kind !== 'back') o.th = o.h;
  }

  /** 画一辆车：牵引车（公路的 / 场内的）+ 挂车或骨架车（+ 箱） */
  private drawRig(term: boolean, a: Actor, o: Pose, tow: Tow | undefined, sc: number, inXfer: boolean, st?: LampState): void {
    const P = this.pools;
    const kp = term ? KP_TERM : KP_ROAD;
    const d = dir(o.h);
    const color = a.own ? '#1d6fe0' : a.kind === 'carrier' ? '#b8352e' : a.kind === 'dray' ? '#3f6e4a' : '#e9e9e6';
    const x = o.x - d.x * kp * sc;
    const z = o.z - d.z * kp * sc;
    (term ? P.term : P.road).put(x, 0, z, o.h - Math.PI / 2, 0, sc, sc, sc, term ? undefined : color);
    if (st) this.lamps.part(term ? TERM_LAMPS : 'tractor', x, 0, z, o.h - Math.PI / 2, sc, true, !tow, st);
    if (!tow) return;
    this.drawUnit(tow, o, Infinity, sc, inXfer, st);
  }
  /** 挂车 / 骨架车（和上面的箱），位姿是牵引销的位置和挂车朝向 */
  private drawUnit(tow: Tow, o: Pose, t: number, sc = 1, inXfer = false, st?: LampState): void {
    const P = this.pools;
    const k = tow.kind === 'chassis' ? 'chassis' : 'trailer';
    const d = dir(o.th);
    const x = o.x - d.x * REAR[k] * sc;
    const z = o.z - d.z * REAR[k] * sc;
    const yaw = o.th - Math.PI / 2;
    if (st) this.lamps.part(k === 'chassis' ? 'chassis' : tow.reefer ? 'trailerPlainReefer' : 'trailerPlain', x, 0, z, yaw, sc, false, true, st);
    if (k === 'chassis') {
      P.chassis.put(x, 0, z, yaw, 0, sc, sc, sc);
      // 龙门吊装 / 卸箱的那一会儿箱由货运站画（在吊具上、刚放下）
      if (tow.box && !inXfer && !this.inTransfer(tow.box, t)) P.box.put(x, BOX_Y * sc, z, yaw, 0, sc, sc, sc, tow.color ?? '#888888');
      return;
    }
    (tow.reefer ? P.reefer : P.trailer).put(x, 0, z, yaw, 0, sc, sc, sc, tow.loaded ? '#f4f4f1' : '#dcdcd6');
  }
  private inTransfer(box: string, t: number): boolean {
    if (!Number.isFinite(t) || !this.plan) return false;
    return [...this.plan.transfers.W, ...this.plan.transfers.E].some((x) => x.box === box && t >= x.t0 && t < x.t1);
  }

  /** 监控面板：门外排队、待命停车场、甩挂区、转运仓的门、短驳车在干什么 */
  info(t: number): ParkYardInfo | undefined {
    const plan = this.plan;
    if (!plan) return undefined;
    const now = (a: Actor) => a.legs.find((l) => t >= l.t0 && t < l.t1);
    const gateQ = plan.actors.filter((a) => {
      const l = now(a);
      return l && ((l.kind === 'hold' && !l.stall) || l.kind === 'kiosk') && (a.gateIn ?? Infinity) <= t;
    }).length;
    const holding = plan.actors
      .map((a) => ({ a, l: now(a) }))
      .filter((x) => x.l?.kind === 'hold' && x.l.stall)
      .map((x) => ({ label: x.a.label, stall: x.l?.stall as string, until: (x.l as Leg).t1 }));
    for (const s of plan.sims) if (s.hold && t >= s.hold.t0 && t < s.hold.t1) holding.push({ label: s.label, stall: s.hold.stall, until: s.hold.t1 });
    const trailers = this.units.filter((u) => t >= u.t0 && t < u.t1 && !u.tow.box);
    const doors = plan.layout.doors
      .filter((d) => d.group !== 'dc')
      .map((d) => {
        const u = plan.doorUse.find((x) => x.door === d.id && t >= x.t0 && t < x.t1);
        const next = plan.doorUse.filter((x) => x.door === d.id && x.t0 > t).sort((a, b) => a.t0 - b.t0)[0];
        return { id: d.id, box: d.group === 'tlBox', ...(u ? { who: u.who, kind: u.kind, until: u.t1 } : {}), ...(next ? { next: { who: next.who, t: next.t0 } } : {}) };
      });
    const shuttles = plan.actors
      .filter((a) => a.kind === 'shuttle' || a.kind === 'shunter')
      .map((a) => {
        const l = now(a);
        const what = !l ? '收车' : l.kind === 'xfer' ? (l.note ?? '龙门吊装卸') : l.kind === 'back' ? `倒车${l.door ? `靠 ${l.door}` : '进车位'}` : l.kind === 'hook' ? '挂上' : l.kind === 'unhook' ? '摘下' : l.kind === 'drive' ? (l.tow?.box ? `拉箱 ${l.tow.box}${l.tow.empty ? '（空）' : ''}` : l.tow?.trailer ? `拖挂车 ${l.tow.trailer}` : (l.note ?? '空车行驶')) : l.kind === 'pull' ? '拉出' : '待命';
        return { id: a.id, label: a.label, now: what };
      });
    const own = plan.boxes
      .filter((b) => b.own)
      .map((b) => ({ id: b.id, now: b.emptyAt !== undefined && t >= b.emptyAt ? '空箱已回货运站' : b.devan && t >= b.devan[1] ? `在 ${b.door} 拆完` : b.devan && t >= b.devan[0] ? `在 ${b.door} 拆箱` : b.pickAt !== undefined && t >= b.pickAt ? '短驳去配送中心' : t >= b.landAt ? '在货运站箱位' : '还在列车上' }));
    const k = Math.max(0, Math.min(plan.staging.length - 1, Math.floor(t / 300)));
    return {
      gateQueue: gateQ,
      holding,
      holdCap: plan.layout.hold.stalls.length,
      dropCount: trailers.length,
      dropLoaded: trailers.filter((u) => u.tow.loaded).length,
      dropCap: plan.layout.drop.stalls.length,
      doors,
      staged: Math.round(plan.staging[k] ?? 0),
      shuttles,
      own,
      kpi: plan.hub.kpi.map((x) => ({ label: x.label, value: x.value, unit: x.unit })),
      notes: plan.hub.notes,
    };
  }
}

export interface ParkYardInfo {
  gateQueue: number;
  holding: { label: string; stall: string; until: number }[];
  holdCap: number;
  dropCount: number;
  dropLoaded: number;
  dropCap: number;
  doors: { id: string; box: boolean; who?: string; kind?: string; until?: number; next?: { who: string; t: number } }[];
  staged: number;
  shuttles: { id: string; label: string; now: string }[];
  own: { id: string; now: string }[];
  kpi: { label: string; value: number; unit: string }[];
  notes: string[];
}
