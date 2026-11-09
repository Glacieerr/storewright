import * as THREE from 'three';
import { box, cyl, merge, type Part } from '../../../../../StoreX/web/src/three/models';
import { AISLE_Z, ETV_Z, forkPath, FRONT_Z, LANE_Z, LEVEL_Y, RFS_Z, STAGE_Z, STATION_Z, TERM, type AirTermPlan, type Loc, type PSpan, type StoreKey, type TermLayout, type TermUld, type USpan } from '../../../../src/hub/airport';
import { clamp01, drain, ease, lerp, Pool, STORE_BOX, type Steps } from './kit';
import type { YardPlan } from '@storewright/yard';

/**
 * 机场货站的房子和库内（按 src/hub/airport.ts 排的计划画）：外墙、屋面（镜头靠近时打开）、陆侧收货口（门封、防撞块、调平板、
 * 红绿信号灯、卷帘门——车靠稳了才升起）、空侧板车门（机位对着的门里两条滚轮道：进来的、出去的）。
 * 库内：ETV 升降式板架（两排三层，每台 ETV 的立柱和平台沿巷道走、升降，推板上下）、拆组板工位（滚床、电子秤，
 * 两个人围着板拆、组：板上的货一层层少下去 / 多起来）、整板转运道、出口收货过磅和两台 X 光机（货从通道里过）、
 * 出口货架、冷藏库和冷冻库（保温板墙、冷风机、门帘）、冷链穿堂、进口普货货架、海关查验区（围网、查验台）、
 * 危险品库、贵重品库；叉车（平衡重式，门架、货叉跟着货升降）沿通道把货拉来拉去。
 * 坐标：机场的局部坐标（和 ops/airport.ts 一样），库内地坪高 FLOOR。
 */
const FLOOR = 0.36;
const DOCK_W = 3.2;
const DOCK_H = 3.6;
const OWN = STORE_BOX;
const C_IMPORT = '#f2efe6';
const C_EXPORT = '#dfe7ee';
const C_FRESH = '#e2f0fb';
const PAL: Record<string, string> = { general: '#c9a46c', chill: '#eef6fb', frozen: '#d2e8f8', dg: '#e67e22', vault: '#7f8c8d', customs: '#f1c40f' };
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05, ...o });

/** 集装板的底板和货（货单独一个零件：拆板、组板时按进度缩放高度） */
function uldPlate(): THREE.BufferGeometry {
  return merge([box(3.18, 0.1, 2.44, '#b8bcc0', 0, 0, 0)]);
}
function uldCargo(): THREE.BufferGeometry {
  return merge([box(3.0, 1.55, 2.3, '#ffffff', 0, 0, 0), box(2.6, 0.55, 2.3, '#ffffff', 0, 1.55, 0), box(3.04, 0.06, 2.34, '#4a4f55', 0, 0.8, 0), box(0.06, 2.0, 2.34, '#4a4f55', 0, 0, 0), box(3.04, 0.06, 0.06, '#4a4f55', 0, 2.1, 0)]);
}
/** 一板货：木托盘 + 缠好膜的货（颜色按货类） */
function palletGeo(): THREE.BufferGeometry {
  return merge([box(1.2, 0.14, 1.0, '#9c7a4f', 0, 0, 0), box(1.12, 1.15, 0.94, '#ffffff', 0, 0.14, 0)]);
}
/** 平衡重式叉车：车身、配重、护顶架、座椅、门架（货叉另画），原点在货叉根部的地面，货叉朝 +x */
function forkliftGeo(): THREE.BufferGeometry {
  const parts: Part[] = [box(1.8, 1.0, 1.1, '#f0a500', -1.25, 0.25, 0), box(0.5, 1.15, 1.1, '#3a3d42', -2.15, 0.25, 0), box(0.6, 0.5, 0.5, '#2b2f35', -1.4, 1.25, 0)];
  for (const [x, z] of [
    [-0.55, 0.5],
    [-0.55, -0.5],
    [-1.85, 0.5],
    [-1.85, -0.5],
  ] as const)
    parts.push(box(0.07, 1.0, 0.07, '#2b2f35', x, 1.25, z));
  parts.push(box(1.45, 0.06, 1.1, '#2b2f35', -1.2, 2.25, 0), box(0.12, 2.3, 0.12, '#3a3d42', -0.15, 0.1, 0.38), box(0.12, 2.3, 0.12, '#3a3d42', -0.15, 0.1, -0.38));
  for (const [x, z] of [
    [-0.65, 0.55],
    [-0.65, -0.55],
    [-1.95, 0.55],
    [-1.95, -0.55],
  ] as const)
    parts.push(cyl(0.28, 0.28, 0.22, '#1d1d1d', 0, -0.11, 0, 10).rotateX(Math.PI / 2).translate(x, 0.28, z));
  return merge(parts);
}
function forksGeo(): THREE.BufferGeometry {
  return merge([box(0.1, 0.6, 1.0, '#3a3d42', -0.02, 0, 0), box(1.15, 0.05, 0.12, '#5b6067', 0.55, 0, 0.3), box(1.15, 0.05, 0.12, '#5b6067', 0.55, 0, -0.3)]);
}
/** 简化的人：上身（衣服颜色按实例）、腿、头 */
function personGeo(): THREE.BufferGeometry {
  return merge([cyl(0.2, 0.22, 0.75, '#ffffff', 0, 0.8, 0, 8), cyl(0.15, 0.15, 0.8, '#2f3640', 0, 0, 0, 6), cyl(0.12, 0.12, 0.24, '#e0b48a', 0, 1.58, 0, 8)]);
}
/** ETV：两根立柱、顶梁、底下的走行车（沿巷道走）；平台另画（升降） */
function etvMast(): THREE.BufferGeometry {
  return merge([box(1.6, 0.5, 4.6, '#d35400', 0, 0, 0), box(0.45, 10.6, 0.45, '#e67e22', 0, 0.5, 2.05), box(0.45, 10.6, 0.45, '#e67e22', 0, 0.5, -2.05), box(1.2, 0.5, 4.6, '#d35400', 0, 11.1, 0), box(0.8, 0.8, 0.8, '#5b6067', 0.9, 0.5, 2.05)]);
}
function etvDeck(): THREE.BufferGeometry {
  const parts: Part[] = [box(3.5, 0.3, 2.9, '#9aa0a6', 0, -0.3, 0), box(3.5, 0.35, 0.1, '#f0c419', 0, 0, 1.45), box(3.5, 0.35, 0.1, '#f0c419', 0, 0, -1.45)];
  for (let x = -1.5; x <= 1.5; x += 0.5) parts.push(box(0.1, 0.05, 2.7, '#5b6067', x, 0, 0));
  return merge(parts);
}

/**
 * 叉车沿一条路开 T 秒走完：起步、停下各用 3 秒（路短就各用三分之一）加减速，中间匀速（以前整段缓起缓停：
 * 起步那几秒几乎不动、中间快到平均的两倍）。返回 t 秒时走完的比例
 */
function trap(t: number, T: number): number {
  if (T <= 1e-6) return 1;
  const x = Math.max(0, Math.min(T, t));
  const ta = Math.min(3, T / 3);
  const v = 1 / (T - ta);
  if (x < ta) return (0.5 * v * x * x) / ta;
  if (x <= T - ta) return v * (x - ta / 2);
  return 1 - (0.5 * v * (T - x) * (T - x)) / ta;
}
/** 叉车充电位（画面上停的地方）：计划里的充电位往南让开 1.8 米（车头朝北停，货叉不伸进主通道） */
const PARK_DZ = 1.8;
const parkOf = (h: { x: number; z: number }): { x: number; z: number; y: number } => ({ x: h.x, z: h.z + PARK_DZ, y: 0 });
/** 叉车车身（和重叠审计取的一样：车身零件的包围盒去掉一点边）：原点在货叉根部，车头朝 +x */
const FORK_BODY = { x0: -1.95, x1: -0.34, hw: 0.54 };
/** 两台叉车车身（多留 m 米）重叠没有：分离轴 */
function forkHit(ax: number, az: number, ay: number, bx: number, bz: number, by: number, m: number): boolean {
  const cx = (FORK_BODY.x0 + FORK_BODY.x1) / 2;
  const hl = (FORK_BODY.x1 - FORK_BODY.x0) / 2 + m;
  const hw = FORK_BODY.hw + m;
  // three.js 绕 y 转 yaw：车头方向 (cos, −sin)
  const ux = Math.cos(ay);
  const uz = -Math.sin(ay);
  const vx = Math.cos(by);
  const vz = -Math.sin(by);
  const dx = bx + vx * cx - (ax + ux * cx);
  const dz = bz + vz * cx - (az + uz * cx);
  for (const [nx, nz] of [
    [ux, uz],
    [-uz, ux],
    [vx, vz],
    [-vz, vx],
  ] as const) {
    const ra = hl * Math.abs(ux * nx + uz * nz) + hw * Math.abs(-uz * nx + ux * nz);
    const rb = hl * Math.abs(vx * nx + vz * nz) + hw * Math.abs(-vz * nx + vx * nz);
    if (Math.abs(dx * nx + dz * nz) >= ra + rb) return false;
  }
  return true;
}
/**
 * 叉车两趟活之间怎么待着（排计划时定好，画的时候照着画）：
 * home 开回自己的充电位、下一趟前开回来；stay 停在放下货的地方（车头对着货位）；back 往后倒开 d 米停着（让出货位前面），下一趟前开回来。
 */
interface ForkIdle {
  mode: 'home' | 'stay' | 'back';
  /** 放下货那一刻的样子（停着、倒开的起点） */
  x0: number;
  z0: number;
  yaw: number;
  /** back：倒开多远、倒开用多久 */
  d: number;
  tb: number;
}
/** 闲着的叉车查重叠时每隔几秒取一次；货位前有别的叉车时往回退多远等（米） */
const IDLE_DT = 2;
const HAND_BACK = 2.6;

/** 卷帘门（门洞 3.2 × 3.6 米），原点在门洞底边中点；按实例缩放高度 */
function doorPanel(): THREE.BufferGeometry {
  return merge([box(DOCK_W, 1, 0.12, '#c4c8cc', 0, 0, 0)]);
}

export interface TermInfo {
  etv: { used: number; slots: number; cranesBusy: number; cranes: number };
  stations: { busy: number; total: number; backlog: number };
  cold: { chill: number; chillCap: number; frozen: number; frozenCap: number };
  stores: { label: string; used: number; cap: number }[];
  docks: { id: string; kind: string; truck?: string; until?: number; next?: { t: number; label: string } }[];
  queue: number;
  own: { id: string; now: string; t: number }[];
  today: { trucks: number; uldIn: number; uldOut: number };
}

export class AirTerminal {
  readonly group = new THREE.Group();
  /** 屋面（镜头靠近时隐藏）和库内的东西（屋面盖着时不画） */
  private readonly roof = new THREE.Group();
  private readonly inside = new THREE.Group();
  private readonly shell = new THREE.Group();
  private readonly plates: Pool;
  private readonly cargo: Pool;
  private readonly pallets: Pool;
  private readonly lifts: Pool;
  private readonly forks: Pool;
  private readonly people: Pool;
  private readonly masts: Pool;
  private readonly decks: Pool;
  private readonly doors: Pool;
  private readonly lights: Pool;
  private readonly levelers: Pool;
  private readonly lightMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
  private plan: AirTermPlan | undefined;
  private L: TermLayout | undefined;
  /** 每块板、每板货出现和离开的时刻（画的时候跳过不在场的） */
  private uSpan: Float64Array = new Float64Array(0);
  private pSpan: Float64Array = new Float64Array(0);
  private jobOf = new Map<number, number>();
  private forkTrips: number[][] = [];
  private dockVisits: { t0: number; t1: number; label: string }[][] = [];
  private readonly v = { x: 0, z: 0, y: 0, yaw: 0 };
  private readonly yardG = new THREE.Group();
  /** 卡车场地面和机场道面用同一个材质（下雨时一起变暗、变光滑） */
  paveMat: THREE.Material | undefined;
  near = false;

  constructor() {
    this.group.name = 'air-terminal';
    this.inside.name = 'air-terminal-inside';
    this.roof.name = 'air-terminal-roof';
    const VC = std({ vertexColors: true });
    this.plates = new Pool(uldPlate(), VC, 520, 'term-uld-plates');
    this.cargo = new Pool(uldCargo(), std({ vertexColors: true, roughness: 0.85 }), 520, 'term-uld-cargo');
    this.pallets = new Pool(palletGeo(), std({ vertexColors: true, roughness: 0.9 }), 1800, 'term-pallets');
    this.lifts = new Pool(forkliftGeo(), VC, 16, 'term-forklifts');
    this.forks = new Pool(forksGeo(), VC, 16, 'term-forks');
    this.people = new Pool(personGeo(), VC, 64, 'term-staff');
    this.masts = new Pool(etvMast(), VC, 8, 'term-etv-masts');
    this.decks = new Pool(etvDeck(), VC, 8, 'term-etv-decks');
    this.doors = new Pool(doorPanel(), VC, 40, 'term-dock-doors');
    this.lights = new Pool(new THREE.BoxGeometry(0.22, 0.22, 0.08), this.lightMat, 40, 'term-dock-lights', false);
    this.levelers = new Pool(new THREE.BoxGeometry(2.0, 0.08, 1.2).translate(0, 0.04, -0.6), std({ color: '#5b6067', metalness: 0.4 }), 40, 'term-levelers');
    for (const p of [this.plates, this.cargo, this.pallets, this.lifts, this.forks, this.people, this.masts, this.decks]) this.inside.add(p.mesh);
    // 卷帘门、信号灯、调平板在外面也看得见
    this.yardG.name = 'air-landside-yard';
    this.group.add(this.shell, this.roof, this.inside, this.yardG, this.doors.mesh, this.lights.mesh, this.levelers.mesh);
  }

  /**
   * 陆侧卡车场的地面（收货场引擎排的）：收货口前的水泥地坪、沥青场地和货车专用通道，车道线（白实线、虚线、黄线）、
   * 行车方向箭头、停止线、待命车位框、「货车入口」指示牌。o 是卡车场本地坐标的原点（机场局部坐标；本地转了 180°）。
   */
  buildYard(plan: YardPlan, o: { x: number; z: number }): void {
    this.yardG.traverse((x) => (x as THREE.Mesh).geometry?.dispose());
    this.yardG.clear();
    const A = (p: { x: number; z: number }) => ({ x: o.x - p.x, z: o.z - p.z });
    const pave: Part[] = [];
    const mk: Part[] = [];
    const seg = (a: { x: number; z: number }, b: { x: number; z: number }, w: number, color: string, y: number, out: Part[]) => {
      const pa = A(a);
      const pb = A(b);
      const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
      if (len < 0.05) return;
      out.push(box(len, 0.03, w, color, 0, y, 0).rotateY(Math.atan2(-(pb.z - pa.z), pb.x - pa.x)).translate((pa.x + pb.x) / 2, 0, (pa.z + pb.z) / 2));
    };
    // 地面：场地沥青、收货口前的水泥地坪、货车专用通道（墙后那一段）
    const ax0 = o.x - plan.x1;
    const ax1 = o.x - plan.x0;
    pave.push(box(ax1 - ax0, 0.04, plan.z1, '#55595e', (ax0 + ax1) / 2, 0.29, o.z - plan.z1 / 2));
    pave.push(box(ax1 - ax0, 0.04, plan.apronZ, '#a3a6a2', (ax0 + ax1) / 2, 0.3, o.z - plan.apronZ / 2));
    const dx = o.x - plan.driveX;
    pave.push(box(plan.driveHalf * 2 + 1, 0.04, plan.driveLen + 4, '#55595e', dx, 0.29, o.z + plan.driveLen / 2 - 2));
    // 出场一侧外面再铺 8 米：收货场引擎的驶离路线从场地西头斜着并回出场车道，挂车摆过来的那一段也在路面上
    pave.push(box(8, 0.04, plan.driveLen + 4, '#55595e', dx - plan.driveHalf - 3.5, 0.288, o.z + plan.driveLen / 2 - 2));
    // 通道上真正的行车线：进场从通道外口沿进场一侧开到场地的进场点、出场从驶出点斜着并回出场一侧（和外来货车层、收货场引擎走的一样）：
    // 这一段铺上路面、画两侧的车道边线（原来只有中线，车斜着开过去像是不在车道上）
    const lanePath = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const n = { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
      seg(a, b, 8.6, '#55595e', 0.296, pave);
      for (const sd of [-1, 1]) seg({ x: a.x + n.x * 4 * sd, z: a.z + n.z * 4 * sd }, { x: b.x + n.x * 4 * sd, z: b.z + n.z * 4 * sd }, 0.15, '#f4f4f0', 0.325, mk);
    };
    lanePath({ x: plan.xIn, z: -plan.driveLen }, plan.gateIn);
    lanePath(plan.gateOut, { x: plan.xOut, z: -plan.driveLen });
    for (const fl of plan.junction?.flares ?? []) for (let i = 2; i < fl.length; i++) {
      const a = A(fl[0] as { x: number; z: number });
      const b = A(fl[i - 1] as { x: number; z: number });
      const c = A(fl[i] as { x: number; z: number });
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, 0.315, a.z), new THREE.Vector3(c.x, 0.315, c.z), new THREE.Vector3(b.x, 0.315, b.z)]);
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9).fill(0.33), 3));
      g.computeVertexNormals();
      pave.push(g);
    }
    // 标线
    for (const m of plan.marks) {
      if (m.kind === 'line') {
        const c = m.color === 'yellow' ? '#f2c94c' : '#f4f4f0';
        for (let i = 1; i < m.pts.length; i++) {
          const a = m.pts[i - 1] as { x: number; z: number };
          const b = m.pts[i] as { x: number; z: number };
          if (!m.dashed) seg(a, b, m.width, c, 0.32, mk);
          else {
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            for (let d = 0; d < len; d += 6) {
              const k0 = d / len;
              const k1 = Math.min(1, (d + 3) / len);
              seg({ x: a.x + (b.x - a.x) * k0, z: a.z + (b.z - a.z) * k0 }, { x: a.x + (b.x - a.x) * k1, z: a.z + (b.z - a.z) * k1 }, m.width, c, 0.32, mk);
            }
          }
        }
      } else if (m.kind === 'arrow') {
        const dxh = Math.sin(m.heading);
        const dzh = Math.cos(m.heading);
        const tip = { x: m.at.x + dxh * 2.2, z: m.at.z + dzh * 2.2 };
        seg({ x: m.at.x - dxh * 2.2, z: m.at.z - dzh * 2.2 }, tip, 0.3, '#f4f4f0', 0.32, mk);
        for (const sgn of [-1, 1]) seg(tip, { x: tip.x - dxh * 1.2 + sgn * dzh * 0.9, z: tip.z - dzh * 1.2 - sgn * dxh * 0.9 }, 0.3, '#f4f4f0', 0.32, mk);
      } else if (m.kind === 'stop') seg(m.a, m.b, 0.45, '#f4f4f0', 0.32, mk);
      else if (m.kind === 'box') {
        const c = Math.cos(m.heading);
        const sn = Math.sin(m.heading);
        const corner = (u: number, w: number) => ({ x: m.at.x + u * sn + w * c, z: m.at.z + u * c - w * sn });
        const pts = [corner(m.d / 2, m.w / 2), corner(m.d / 2, -m.w / 2), corner(-m.d / 2, -m.w / 2), corner(-m.d / 2, m.w / 2)];
        for (let i = 0; i < 4; i++) seg(pts[i] as { x: number; z: number }, pts[(i + 1) % 4] as { x: number; z: number }, 0.15, '#f4f4f0', 0.32, mk);
      } else if (m.kind === 'sign') {
        const p = A(m.at);
        mk.push(cyl(0.08, 0.08, 3.2, '#9aa0a6', p.x, 0.3, p.z, 6), box(1.8, 1.1, 0.08, '#1f5fa8', p.x, 3.2, p.z));
      }
    }
    const pm = new THREE.Mesh(merge(pave), this.paveMat ?? std({ vertexColors: true, roughness: 0.95 }));
    pm.receiveShadow = true;
    pm.name = 'air-yard-pavement';
    const mm = new THREE.Mesh(merge(mk), std({ vertexColors: true, roughness: 0.7 }));
    mm.receiveShadow = true;
    mm.name = 'air-yard-markings';
    this.yardG.add(pm, mm);
  }

  /** 按布局搭房子和库内不动的东西 */
  build(L: TermLayout, airDoors: readonly number[]): void {
    this.L = L;
    for (const g of [this.shell, this.roof]) {
      g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      g.clear();
    }
    for (const o of [...this.inside.children]) if (!(o as THREE.InstancedMesh).isInstancedMesh) {
      this.inside.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
    }
    const x0 = L.x0;
    const x1 = L.x1;
    const zL = TERM.zLand;
    const zA = TERM.zAir;
    const H = TERM.h;
    const wall: Part[] = [];
    const wallC = '#d7dadd';
    // —— 陆侧墙：门洞之间的墙段、门洞上面的墙；每樘门外面门封（黑）、两块防撞块，门头色带（冷链蓝、整板黄、出口绿） ——
    const docks = [...L.docks].sort((a, b) => a.x - b.x);
    let cur = x0;
    for (const d of docks) {
      const a = d.x - DOCK_W / 2;
      if (a > cur) wall.push(box(a - cur, DOCK_H + FLOOR, 0.4, wallC, (a + cur) / 2, 0, zL));
      cur = d.x + DOCK_W / 2;
      const band = d.kind === 'cold' ? '#2a78d6' : d.kind === 'uld' ? '#f0c419' : d.kind === 'export' ? '#27ae60' : '#9aa0a6';
      wall.push(box(DOCK_W + 0.9, 0.45, 0.5, '#1f2226', d.x, FLOOR + DOCK_H, zL - 0.45), box(0.45, DOCK_H, 0.5, '#1f2226', d.x - DOCK_W / 2 - 0.22, FLOOR, zL - 0.45), box(0.45, DOCK_H, 0.5, '#1f2226', d.x + DOCK_W / 2 + 0.22, FLOOR, zL - 0.45));
      wall.push(box(0.35, 0.45, 0.35, '#2b2f35', d.x - 1.1, 0.75, zL - 0.35), box(0.35, 0.45, 0.35, '#2b2f35', d.x + 1.1, 0.75, zL - 0.35), box(DOCK_W + 1.2, 0.35, 0.08, band, d.x, FLOOR + DOCK_H + 0.55, zL - 0.24));
    }
    if (x1 > cur) wall.push(box(x1 - cur, DOCK_H + FLOOR, 0.4, wallC, (x1 + cur) / 2, 0, zL));
    wall.push(box(x1 - x0, H - DOCK_H - FLOOR, 0.4, wallC, (x0 + x1) / 2, DOCK_H + FLOOR, zL));
    // 收货口的雨棚（4 米深）
    wall.push(box(docks[docks.length - 1] ? (docks[docks.length - 1] as { x: number }).x - (docks[0] as { x: number }).x + 8 : 10, 0.35, 4.2, '#8a9096', ((docks[0]?.x ?? x0) + (docks[docks.length - 1]?.x ?? x1)) / 2, 6.2, zL - 2.1));
    // —— 空侧墙：板车门（机位对着的门开两条滚轮道，门宽 10.6 米） ——
    const stand = new Set(L.lanes.map((l) => Math.round(l.x)));
    const open = airDoors.map((x) => ({ a: stand.has(Math.round(x)) ? x - 3.4 : x - 3.5, b: stand.has(Math.round(x)) ? x + 3.5 + 3.55 : x + 3.5 }));
    cur = x0;
    for (const o of open) {
      if (o.a > cur) wall.push(box(o.a - cur, 6.5 + FLOOR, 0.4, wallC, (o.a + cur) / 2, 0, zA));
      cur = o.b;
    }
    if (x1 > cur) wall.push(box(x1 - cur, 6.5 + FLOOR, 0.4, wallC, (x1 + cur) / 2, 0, zA));
    wall.push(box(x1 - x0, H - 6.5 - FLOOR, 0.4, wallC, (x0 + x1) / 2, 6.5 + FLOOR, zA));
    // 东西两头的墙、檐口的蓝色色带
    for (const x of [x0, x1]) wall.push(box(0.4, H, zA - zL, wallC, x, 0, (zA + zL) / 2));
    for (const z of [zL, zA]) wall.push(box(x1 - x0 + 0.6, 1.2, 0.6, '#2a78d6', (x0 + x1) / 2, H - 1.2, z));
    for (const x of [x0, x1]) wall.push(box(0.6, 1.2, zA - zL + 0.6, '#2a78d6', x, H - 1.2, (zA + zL) / 2));
    const shellMesh = new THREE.Mesh(merge(wall), std({ vertexColors: true, roughness: 0.85 }));
    shellMesh.castShadow = true;
    shellMesh.receiveShadow = true;
    this.shell.add(shellMesh);
    // —— 屋面：屋面板、采光带、屋面设备 ——
    const roof: Part[] = [box(x1 - x0, 0.6, zA - zL, '#cfd3d7', (x0 + x1) / 2, H - 0.6, (zA + zL) / 2)];
    for (let x = x0 + 12; x < x1 - 8; x += 18) roof.push(box(1.6, 0.12, zA - zL - 10, '#a9c6db', x, H, (zA + zL) / 2));
    for (let x = x0 + 30; x < x1 - 20; x += 40) roof.push(box(8, 2.5, 6, '#9aa3ab', x, H, zL + 25));
    const roofMesh = new THREE.Mesh(merge(roof), std({ vertexColors: true, roughness: 0.9 }));
    roofMesh.castShadow = true;
    this.roof.add(roofMesh);
    // —— 库内 ——
    this.inside.add(this.interior(L));
  }

  /** 库内不动的东西：地坪和标线、ETV 板架和轨道、滚轮道、工位、货架、冷库、各个房间、X 光机、秤 */
  private interior(L: TermLayout): THREE.Group {
    const g = new THREE.Group();
    const p: Part[] = [];
    const fl: Part[] = [];
    const x0 = L.x0;
    const x1 = L.x1;
    const F = FLOOR;
    const Y = '#f2c94c';
    // 地坪（浅灰水泥），各区地面颜色、通道黄线
    fl.push(box(x1 - x0 - 0.8, 0.04, TERM.zAir - TERM.zLand - 0.8, '#cfd2d4', (x0 + x1) / 2, F - 0.04, (TERM.zAir + TERM.zLand) / 2));
    const zoneC: Record<string, string> = { accept: '#d9e8d6', xray: '#d6e2ee', uld: '#ece3c8', coldDock: '#d6e6f2', customs: '#efe6c2', dg: '#f2d9c4', vault: '#d4d6d8', work: '#dcdfe6', etv: '#d9d4e4' };
    for (const r of L.rooms) {
      const c = zoneC[r.key];
      if (c) fl.push(box(r.x1 - r.x0, 0.02, r.z1 - r.z0, c, (r.x0 + r.x1) / 2, F, (r.z0 + r.z1) / 2));
    }
    for (const z of [AISLE_Z - 2, AISLE_Z + 2]) fl.push(box(x1 - x0 - 4, 0.025, 0.12, Y, (x0 + x1) / 2, F + 0.01, z));
    fl.push(box(x1 - x0 - 4, 0.025, 0.12, Y, (x0 + x1) / 2, F + 0.01, FRONT_Z + 1.5));
    for (const cx of L.crossX) fl.push(box(0.12, 0.025, 15.5, Y, cx - 1.3, F + 0.01, 1001.5), box(0.12, 0.025, 15.5, Y, cx + 1.3, F + 0.01, 1001.5));
    // —— ETV：两排三层的板架（立柱、横梁、每个板位的滚床）、地轨和顶轨 ——
    const c0 = (L.cols[0] as number) - 1.78;
    const c1 = (L.cols[L.cols.length - 1] as number) + 1.78;
    for (const z of [ETV_Z.aisle - 1.6, ETV_Z.aisle + 1.6]) p.push(box(c1 - c0, 0.18, 0.18, '#5b6067', (c0 + c1) / 2, F, z));
    p.push(box(c1 - c0, 0.4, 0.4, '#5b6067', (c0 + c1) / 2, F + 11.6, ETV_Z.aisle));
    for (const [zc, side] of [
      [ETV_Z.rowL, 0],
      [ETV_Z.rowA, 1],
    ] as const) {
      for (let i = 0; i <= L.cols.length; i++) {
        const x = (L.cols[0] as number) - 1.77 + i * (92 / 26);
        for (const dz of [-1.35, 1.35]) p.push(box(0.2, 10.4, 0.2, '#6c5b8f', x, F, zc + dz));
      }
      for (let lv = 1; lv < 3; lv++) p.push(box(c1 - c0, 0.22, 0.2, '#e67e22', (c0 + c1) / 2, F + (LEVEL_Y[lv] as number) - 0.45, zc - 1.35), box(c1 - c0, 0.22, 0.2, '#e67e22', (c0 + c1) / 2, F + (LEVEL_Y[lv] as number) - 0.45, zc + 1.35));
      p.push(box(c1 - c0, 0.22, 0.2, '#e67e22', (c0 + c1) / 2, F + 10.2, zc - 1.35), box(c1 - c0, 0.22, 0.2, '#e67e22', (c0 + c1) / 2, F + 10.2, zc + 1.35));
      void side;
    }
    for (const s of L.slots) {
      p.push(box(3.3, 0.12, 2.6, '#8a9096', s.x, F + s.y - 0.14, s.z));
      for (let k = -1; k <= 1; k++) p.push(box(0.08, 0.04, 2.5, '#5b6067', s.x + k * 1.1, F + s.y - 0.02, s.z));
    }
    // —— 空侧板车门里的滚轮道（进、出两条）、整板转运道、转运台 ——
    const rollers = (x: number, za: number, zb: number) => {
      const len = Math.abs(zb - za);
      const zc = (za + zb) / 2;
      p.push(box(3.4, 0.55, len, '#8a9096', x, F, zc), box(0.12, 0.2, len, Y, x - 1.7, F + 0.55, zc), box(0.12, 0.2, len, Y, x + 1.7, F + 0.55, zc));
      for (let z = Math.min(za, zb) + 0.3; z < Math.max(za, zb); z += 0.5) p.push(box(3.2, 0.05, 0.1, '#5b6067', x, F + 0.6, z));
    };
    for (const l of L.lanes) {
      rollers(l.x, (LANE_Z[0] as number) - 1.3, TERM.zAir - 0.2);
      rollers(l.xOut, (LANE_Z[0] as number) - 1.3, TERM.zAir - 0.2);
      // 进、出的箭头（地上）
      p.push(box(0.5, 0.03, 2.2, '#27ae60', l.x - 2.4, F + 0.01, 1044), box(0.5, 0.03, 2.2, '#c0392b', l.xOut + 2.4, F + 0.01, 1044));
    }
    for (const r of L.rfs) rollers(r.x, (RFS_Z[RFS_Z.length - 1] as number) - 1.6, (RFS_Z[0] as number) + 1.3);
    // —— 拆组板工位：滚床台、秤、护栏、终端 ——
    for (const s of L.stations) {
      p.push(box(3.6, 0.5, 3.2, '#9aa0a6', s.x, F, STATION_Z), box(3.7, 0.06, 3.3, '#2b2f35', s.x, F + 0.5, STATION_Z));
      for (let x = -1.5; x <= 1.5; x += 0.5) p.push(box(0.08, 0.04, 3.1, '#5b6067', s.x + x, F + 0.56, STATION_Z));
      p.push(box(0.5, 1.1, 0.5, '#3a3d42', s.x + 2.4, F, STATION_Z + 1.2), box(0.45, 0.32, 0.06, '#1b2a3a', s.x + 2.4, F + 1.15, STATION_Z + 1.0));
      p.push(box(0.06, 1.0, 3.2, Y, s.x - 2.0, F, STATION_Z), box(0.8, 0.02, 0.8, '#27ae60', s.x, F + 0.005, STATION_Z - 2.3));
      // 工位后面的空板、网（一摞）
      p.push(box(3.18, 0.6, 2.44, '#b8bcc0', s.x + 0.2, F, STATION_Z + 4.4 > ETV_Z.rowL - 1.4 ? STATION_Z - 6.2 : STATION_Z + 4.4));
    }
    // —— 货架（立柱蓝、横梁橙）：按货位的位置拉一排排 ——
    const rackRows = (list: readonly Loc[], levels: number) => {
      const rows = new Map<number, number[]>();
      for (const q of list) {
        const k = Math.round(q.z * 10);
        const a = rows.get(k) ?? [];
        if (!a.includes(Math.round(q.x * 100))) a.push(Math.round(q.x * 100));
        rows.set(k, a);
      }
      for (const [kz, xsRaw] of rows) {
        const z = kz / 10;
        const xs = xsRaw.map((v) => v / 100).sort((a, b) => a - b);
        // 连续的一段段（中间留横通道的地方断开）
        let s0 = xs[0] as number;
        let prev = s0;
        const flush = (a: number, b: number) => {
          const xa = a - 0.68;
          const xb = b + 0.68;
          for (let x = xa; x <= xb + 0.01; x += 2.7) p.push(box(0.1, levels * 1.6 + 0.3, 0.1, '#2b5797', Math.min(x, xb), F, z - 0.5), box(0.1, levels * 1.6 + 0.3, 0.1, '#2b5797', Math.min(x, xb), F, z + 0.5));
          for (let lv = 1; lv <= levels; lv++) p.push(box(xb - xa, 0.12, 0.08, '#e67e22', (xa + xb) / 2, F + lv * 1.6 - 0.12, z - 0.5), box(xb - xa, 0.12, 0.08, '#e67e22', (xa + xb) / 2, F + lv * 1.6 - 0.12, z + 0.5));
        };
        for (const x of xs.slice(1)) {
          if (x - prev > 2) {
            flush(s0, prev);
            s0 = x;
          }
          prev = x;
        }
        flush(s0, prev);
      }
    };
    rackRows(L.store.export, 3);
    rackRows(L.store.bulk, 3);
    rackRows(L.store.chill, 2);
    rackRows(L.store.frozen, 2);
    // —— 房间：冷藏库、冷冻库（保温板墙、冷风机、门帘）、冷链穿堂、危险品库、贵重品库、查验区围网 ——
    const room = (key: string) => L.rooms.find((r) => r.key === key);
    const walls = (r: { x0: number; x1: number; z0: number; z1: number }, h: number, c: string, doors: { side: 'z0' | 'z1'; x: number; w: number }[] = []) => {
      for (const side of ['z0', 'z1'] as const) {
        const z = r[side];
        const ds = doors.filter((d) => d.side === side).sort((a, b) => a.x - b.x);
        let xa = r.x0;
        for (const d of ds) {
          if (d.x - d.w / 2 > xa) p.push(box(d.x - d.w / 2 - xa, h, 0.25, c, (xa + d.x - d.w / 2) / 2, F, z));
          p.push(box(d.w, h - 3.4, 0.25, c, d.x, F + 3.4, z));
          xa = d.x + d.w / 2;
        }
        if (r.x1 > xa) p.push(box(r.x1 - xa, h, 0.25, c, (xa + r.x1) / 2, F, z));
      }
      for (const x of [r.x0, r.x1]) p.push(box(0.25, h, r.z1 - r.z0, c, x, F, (r.z0 + r.z1) / 2));
    };
    const strips: Part[] = [];
    const curtain = (x: number, z: number, w: number) => {
      for (let k = 0; k < Math.round(w / 0.3); k++) strips.push(box(0.26, 3.3, 0.02, '#cfe6f5', x - w / 2 + 0.15 + k * 0.3, F, z));
    };
    const chill = room('chill');
    const frozen = room('frozen');
    const cd = room('coldDock');
    if (chill && frozen && cd) {
      const cx = L.crossX.filter((x) => x > chill.x0 && x < chill.x1);
      const dc = cx[0] ?? (chill.x0 + chill.x1) / 2;
      walls(chill, 7, '#f4f6f7', [
        { side: 'z0', x: dc, w: 3 },
        { side: 'z1', x: dc, w: 3 },
      ]);
      walls(frozen, 7, '#e8f1f8', [{ side: 'z0', x: (frozen.x0 + frozen.x1) / 2, w: 3 }]);
      curtain(dc, chill.z0, 3);
      curtain(dc, chill.z1, 3);
      curtain((frozen.x0 + frozen.x1) / 2, frozen.z0, 3);
      // 冷风机（挂在墙上）、温度显示屏
      for (let x = chill.x0 + 4; x < chill.x1 - 2; x += 8) p.push(box(2.4, 0.8, 0.7, '#dfe4e8', x, F + 5.6, chill.z1 - 0.5));
      for (let x = frozen.x0 + 3; x < frozen.x1 - 2; x += 6) p.push(box(2.0, 0.8, 0.7, '#d0dae3', x, F + 5.6, frozen.z1 - 0.5));
      p.push(box(0.8, 0.4, 0.05, '#27ae60', chill.x0 + 2, F + 3.8, chill.z0 - 0.15), box(0.8, 0.4, 0.05, '#2a78d6', frozen.x0 + 2, F + 3.8, frozen.z0 - 0.15));
      // 冷链穿堂：靠库里一侧的墙（门对着冷库）、两头的门帘
      p.push(box(0.25, 4.5, cd.z1 - cd.z0, '#e8eef2', cd.x0, F, (cd.z0 + cd.z1) / 2), box(0.25, 4.5, cd.z1 - cd.z0, '#e8eef2', cd.x1, F, (cd.z0 + cd.z1) / 2));
      p.push(box(cd.x1 - cd.x0, 0.2, cd.z1 - cd.z0, '#e8eef2', (cd.x0 + cd.x1) / 2, F + 4.5, (cd.z0 + cd.z1) / 2));
      curtain(cd.x0, (cd.z0 + cd.z1) / 2, 2.6);
    }
    const dg = room('dg');
    if (dg) {
      walls(dg, 4.2, '#c9c4bc', [{ side: 'z1', x: (dg.x0 + dg.x1) / 2, w: 2.8 }]);
      p.push(box(dg.x1 - dg.x0, 0.4, 0.27, '#f1c40f', (dg.x0 + dg.x1) / 2, F + 3.6, dg.z1), box(0.9, 0.9, 0.05, '#e67e22', (dg.x0 + dg.x1) / 2 + 3, F + 2.2, dg.z1 + 0.15));
      p.push(box(dg.x1 - dg.x0 - 1, 0.15, 0.15, '#f1c40f', (dg.x0 + dg.x1) / 2, F, dg.z0 + 0.4));
    }
    const vault = room('vault');
    if (vault) {
      walls(vault, 4.2, '#7a7f85', [{ side: 'z1', x: vault.x0 + 3, w: 1.6 }]);
      p.push(box(1.6, 2.6, 0.2, '#3a3d42', vault.x0 + 3, F, vault.z1 + 0.05), box(0.35, 0.35, 0.35, '#2b2f35', vault.x1 - 1, F + 3.9, vault.z1 + 0.25));
      for (const q of L.store.vault) if (q.y < 1) p.push(box(1.5, 2.2, 0.6, '#5b6067', q.x, F, q.z + 0.65));
    }
    const cu = room('customs');
    const mesh: Part[] = [];
    if (cu) {
      for (let x = cu.x0; x <= cu.x1; x += 2) for (const z of [cu.z0, cu.z1]) p.push(box(0.08, 2.0, 0.08, '#7f8c8d', x, F, z));
      for (let z = cu.z0; z <= cu.z1; z += 2) for (const x of [cu.x0, cu.x1]) p.push(box(0.08, 2.0, 0.08, '#7f8c8d', x, F, z));
      for (const z of [cu.z0, cu.z1]) mesh.push(box(cu.x1 - cu.x0, 1.9, 0.03, '#9aa3ab', (cu.x0 + cu.x1) / 2, F, z));
      for (const x of [cu.x0, cu.x1]) mesh.push(box(0.03, 1.9, cu.z1 - cu.z0, '#9aa3ab', x, F, (cu.z0 + cu.z1) / 2));
      for (let k = 0; k < 3; k++) p.push(box(2.4, 0.9, 1.2, '#dfe4e8', cu.x0 + 5 + k * 7, F, cu.z1 - 2.5));
      p.push(box(3.2, 2.6, 2.4, '#e9eef2', cu.x1 - 3, F, cu.z0 + 2.2), box(3.0, 1.0, 0.05, '#9cc3e6', cu.x1 - 3, F + 1.3, cu.z0 + 3.42));
    }
    // —— 出口：收货过磅（地磅、量方门架）、X 光机（机身、进出的滚轮台、操作台） ——
    const acc = room('accept');
    for (const d of L.docks.filter((q) => q.kind === 'export')) p.push(box(1.6, 0.06, 1.6, '#4a4f55', d.x, F, 989.6), box(1.7, 0.05, 1.7, '#f2c94c', d.x, F - 0.005, 989.6));
    if (acc) p.push(box(0.15, 3, 0.15, '#9aa0a6', acc.x0 + 3, F, 988.5), box(0.15, 3, 0.15, '#9aa0a6', acc.x0 + 3, F, 990.9), box(0.2, 0.2, 2.6, '#9aa0a6', acc.x0 + 3, F + 3, 989.7));
    for (const m of L.xray) {
      const zc = (m.z0 + m.z1) / 2;
      p.push(box(2.6, 2.5, 3.2, '#6d8fb3', m.x, F, zc), box(1.9, 1.85, 3.25, '#2b2f35', m.x, F + 0.35, zc), box(2.7, 0.2, 3.3, '#3a4f66', m.x, F + 2.5, zc));
      p.push(box(1.6, 0.4, 1.6, '#8a9096', m.x, F, m.z0 - 1.0), box(1.6, 0.4, 1.6, '#8a9096', m.x, F, m.z1 + 1.0));
      p.push(box(1.2, 0.8, 0.6, '#3a3d42', m.x + 2.3, F, zc), box(0.7, 0.45, 0.05, '#1b2a3a', m.x + 2.3, F + 1.0, zc - 0.2));
    }
    // 门里暂存道（每樘门前两排、地上的白框）、叉车充电位
    for (const d of L.docks) for (const z of STAGE_Z) p.push(box(3.4, 0.02, 1.3, '#f4f4f0', d.x, F + 0.003, z));
    // 充电位在主通道南边让开一点（停着的叉车车身、货叉不伸进通道，旁边货架前取货的叉车车尾碰不到它）；充电桩在车尾后面
    for (const h of L.forkHome) {
      const q = parkOf(h);
      p.push(box(1.4, 0.02, 2.6, '#27ae60', q.x, F + 0.004, q.z + 1.0), box(0.4, 1.4, 0.3, '#3a3d42', q.x, F, q.z + 2.75));
    }
    // 高架灯（夜里也有，库里常亮）
    for (let x = x0 + 10; x < x1 - 5; x += 16) for (const z of [997, 1014, 1029.5, 1044]) p.push(box(1.2, 0.25, 0.6, '#eef2f4', x, F + 14, z));
    const body = new THREE.Mesh(merge(p), std({ vertexColors: true }));
    body.castShadow = true;
    body.receiveShadow = true;
    const floor = new THREE.Mesh(merge(fl), std({ vertexColors: true, roughness: 0.95 }));
    floor.receiveShadow = true;
    g.add(floor, body);
    if (strips.length) g.add(new THREE.Mesh(merge(strips), new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false })));
    if (mesh.length) g.add(new THREE.Mesh(merge(mesh), new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false })));
    return g;
  }

  setPlan(plan: AirTermPlan): void {
    drain(this.setPlanSteps(plan));
  }

  /**
   * 和 setPlan 一样，分段排（叉车闲着的样子按叉车、按取放货的那一段、按空档分段）：先后、结果都和一口气排完一样。
   * 排的时候画面、info 先不读这一份（路线、样子的缓存排完以前不碰，免得留下排到一半时的样子）。
   * Same as setPlan, split into steps.
   */
  *setPlanSteps(plan: AirTermPlan): Steps {
    this.building = true;
    try {
      yield* this.setPlanBody(plan);
    } finally {
      this.building = false;
    }
  }
  /** 正在排（setPlanSteps 还没排完）：update、info 不读 */
  private building = false;
  private *setPlanBody(plan: AirTermPlan): Steps {
    this.plan = plan;
    this.pathIn.clear();
    this.pathOut.clear();
    const ext = (spans: { t0: number; t1: number }[]) => [spans[0]?.t0 ?? Infinity, spans[spans.length - 1]?.t1 ?? -Infinity] as const;
    this.uSpan = new Float64Array(plan.ulds.length * 2);
    plan.ulds.forEach((u, i) => {
      const [a, b] = ext(u.spans);
      this.uSpan[2 * i] = a;
      this.uSpan[2 * i + 1] = b;
    });
    this.pSpan = new Float64Array(plan.pallets.length * 2);
    plan.pallets.forEach((p, i) => {
      const [a, b] = ext(p.spans);
      this.pSpan[2 * i] = a;
      this.pSpan[2 * i + 1] = b;
    });
    this.jobOf = new Map(plan.jobs.map((j, i) => [j.uld, i] as const));
    this.forkTrips = plan.layout.forkHome.map(() => []);
    plan.forks.forEach((f, i) => (this.forkTrips[f.fork] as number[]).push(i));
    for (const l of this.forkTrips) l.sort((a, b) => (plan.forks[a] as { t0: number }).t0 - (plan.forks[b] as { t0: number }).t0 || a - b);
    // 叉车闲着的样子（回充电位、停在放货的地方、往后让开）：和干活的、别的闲着的叉车错开
    yield* this.planIdle();
    this.dockVisits = plan.layout.docks.map(() => []);
    for (const tr of plan.trucks) (this.dockVisits[tr.dock] as { t0: number; t1: number; label: string }[]).push({ t0: tr.t0, t1: tr.t1, label: tr.label });
    for (const v of this.dockVisits) v.sort((a, b) => a.t0 - b.t0);
  }

  /** 镜头近了打开屋面、画库内（cam 是机场局部坐标里的镜头位置） */
  setCamera(cam: { x: number; y: number; z: number } | undefined): boolean {
    const L = this.L;
    const near = !!cam && !!L && cam.y < 420 && Math.hypot(cam.x - (L.x0 + L.x1) / 2, cam.z - (TERM.zLand + TERM.zAir) / 2) < 520;
    this.near = near;
    this.roof.visible = !near;
    this.inside.visible = near;
    return near;
  }

  // —— 位置 ——
  private craneAt(mi: number, t: number, o: { x: number; y: number }): void {
    const m = (this.plan as AirTermPlan).moves[mi];
    if (!m) return;
    if (t < m.a) {
      const f = ease(clamp01((t - m.t0) / Math.max(1, m.a - m.t0)));
      o.x = lerp(m.start.x, m.from.x, f);
      o.y = lerp(m.start.y, m.from.y, f);
    } else if (t < m.b) {
      o.x = m.from.x;
      o.y = m.from.y;
    } else if (t < m.c) {
      const f = ease(clamp01((t - m.b) / Math.max(1, m.c - m.b)));
      o.x = lerp(m.from.x, m.to.x, f);
      o.y = lerp(m.from.y, m.to.y, f);
    } else {
      o.x = m.to.x;
      o.y = m.to.y;
    }
  }
  private readonly cp = { x: 0, y: 0 };

  /** 一块板此刻在哪（不在库里返回 false） */
  private uldPos(u: TermUld, i: number, t: number, o: { x: number; y: number; z: number }): USpan | undefined {
    const plan = this.plan as AirTermPlan;
    const L = plan.layout;
    let s: USpan | undefined;
    let si = -1;
    for (let k = u.spans.length - 1; k >= 0; k--) {
      const x = u.spans[k] as USpan;
      if (x.t0 <= t) {
        if (t < x.t1 || (x.t0 === x.t1 && false)) {
          s = x;
          si = k;
        }
        break;
      }
    }
    if (!s) return undefined;
    void i;
    const next = u.spans[si + 1];
    const mv = next && next.at === 'crane' ? plan.moves[next.ref] : undefined;
    // 推上 ETV 平台：从原来的位置滚到平台上
    const toDeck = (px: number, py: number, pz: number) => {
      if (mv && t >= mv.a) {
        const f = clamp01((t - mv.a) / Math.max(1, mv.b - mv.a));
        o.x = px;
        o.y = lerp(py, mv.from.y, f);
        o.z = lerp(pz, ETV_Z.aisle, ease(f));
        return;
      }
      o.x = px;
      o.y = py;
      o.z = pz;
    };
    switch (s.at) {
      case 'lane': {
        const l = L.lanes[s.ref];
        if (!l) return undefined;
        const f = s.t1 > s.t0 ? ease(clamp01((t - s.t0) / (s.t1 - s.t0))) : 1;
        const z = lerp(LANE_Z[s.p0 ?? 0] as number, LANE_Z[s.p1 ?? 0] as number, f);
        toDeck(u.dir === 'in' ? l.x : l.xOut, LEVEL_Y[0], z);
        return s;
      }
      case 'rfs': {
        const r = L.rfs[s.ref];
        if (!r) return undefined;
        const f = s.t1 > s.t0 ? ease(clamp01((t - s.t0) / (s.t1 - s.t0))) : 1;
        toDeck(r.x, LEVEL_Y[0], lerp(RFS_Z[s.p0 ?? 0] as number, RFS_Z[s.p1 ?? 0] as number, f));
        return s;
      }
      case 'slot': {
        const q = L.slots[s.ref];
        if (!q) return undefined;
        toDeck(q.x, q.y, q.z);
        return s;
      }
      case 'station': {
        const st = L.stations[s.ref];
        if (!st) return undefined;
        // 刚放下：从 ETV 那排滚到工位台上；要被取走前滚回去
        const fin = clamp01((t - s.t0) / 12);
        let z = lerp(ETV_Z.rowL, STATION_Z, ease(fin));
        if (mv && t >= mv.a - 12) z = lerp(STATION_Z, ETV_Z.rowL, ease(clamp01((t - (mv.a - 12)) / 12)));
        toDeck(st.x, 0.55, z);
        return s;
      }
      case 'crane': {
        const m = plan.moves[s.ref];
        if (!m) return undefined;
        if (t >= m.c) {
          // 推下平台：滚到放板的位置
          const f = clamp01((t - m.c) / Math.max(1, m.t1 - m.c));
          o.x = m.to.x;
          o.y = m.to.y;
          o.z = lerp(ETV_Z.aisle, m.to.z, ease(f));
          return s;
        }
        this.craneAt(s.ref, t, this.cp);
        o.x = this.cp.x;
        o.y = this.cp.y;
        o.z = ETV_Z.aisle;
        return s;
      }
      default:
        return undefined;
    }
  }

  /** 第 fi 趟同一台叉车的上一趟（没有是 −1） */
  private prevTrip = new Int32Array(0);
  /** 取货（fi:pick）、放货（fi:drop）时货位前有别的叉车：往回退 d 米等到 until，再开上去 */
  private readonly handWait = new Map<string, { until: number; d: number }>();
  /** 每一趟做完以后怎么待着（排计划时定好） */
  private readonly forkIdle = new Map<number, ForkIdle>();
  /** 沿折线走到 k（0–1）处：位置和这一段的朝向（三维的 yaw） */
  private static walk(pts: readonly { x: number; z: number }[], k: number, o: { x: number; z: number; yaw: number }): void {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot((pts[i] as { x: number }).x - (pts[i - 1] as { x: number }).x, (pts[i] as { z: number }).z - (pts[i - 1] as { z: number }).z);
    let d = total * k;
    const p0 = pts[0];
    if (p0 && pts.length === 1) {
      o.x = p0.x;
      o.z = p0.z;
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as { x: number; z: number };
      const b = pts[i] as { x: number; z: number };
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      if (d <= l || i === pts.length - 1) {
        const r = l > 1e-6 ? Math.min(1, d / l) : 1;
        o.x = lerp(a.x, b.x, r);
        o.z = lerp(a.z, b.z, r);
        if (l > 1e-6) o.yaw = -Math.atan2(b.z - a.z, b.x - a.x);
        return;
      }
      d -= l;
    }
  }
  /** 第 fi 趟开去取货的路：从叉车此刻在的地方（上一趟放下货的样子；第一趟从让开的充电位）开始 */
  private inPath(fi: number): { x: number; z: number }[] {
    let pts = this.pathIn.get(fi);
    if (pts) return pts;
    const plan = this.plan as AirTermPlan;
    const f = plan.forks[fi] as AirTermPlan['forks'][number];
    const pv = this.prevTrip[fi] ?? -1;
    const h = plan.layout.forkHome[f.fork];
    if (pv < 0 && h && Math.abs(f.start.x - h.x) < 1e-6 && Math.abs(f.start.z - h.z) < 1e-6) pts = forkPath(parkOf(h), f.from, plan.layout.crossX, plan.layout.rooms);
    else {
      pts = this.fpath(f.start, f.from);
      const e = pv >= 0 ? this.endPose(pv) : undefined;
      const p0 = pts[0];
      if (e && p0 && Math.hypot(p0.x - e.x, p0.z - e.z) > 0.05) pts.unshift({ x: e.x, z: e.z });
    }
    this.pathIn.set(fi, pts);
    return pts;
  }
  private outPath(fi: number): { x: number; z: number }[] {
    let pts = this.pathOut.get(fi);
    if (pts) return pts;
    const plan = this.plan as AirTermPlan;
    const f = plan.forks[fi] as AirTermPlan['forks'][number];
    pts = this.fpath(f.from, f.to);
    this.pathOut.set(fi, pts);
    return pts;
  }
  /** 叉车的路：同一间危险品库、贵重品库里挪货直接在库里走（不出门绕一圈再进来，那样几秒里要跑几十米） */
  private fpath(a: Loc, b: Loc): { x: number; z: number }[] {
    const plan = this.plan as AirTermPlan;
    const room = (p: Loc) => plan.layout.rooms.find((r) => (r.key === 'dg' || r.key === 'vault') && p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1);
    const ra = room(a);
    if (ra && ra === room(b)) {
      const pts = [
        { x: a.x, z: a.z },
        { x: a.x, z: a.az ?? a.z },
        { x: b.x, z: b.az ?? b.z },
        { x: b.x, z: b.z },
      ];
      return pts.filter((p, i) => i === 0 || Math.hypot(p.x - (pts[i - 1] as { x: number }).x, p.z - (pts[i - 1] as { z: number }).z) > 0.05);
    }
    return forkPath(a, b, plan.layout.crossX, plan.layout.rooms);
  }
  /** 放下货那一刻（这一趟最后）的样子 */
  private readonly endMemo = new Map<number, { x: number; z: number; yaw: number }>();
  private endPose(fi: number): { x: number; z: number; yaw: number } {
    let e = this.endMemo.get(fi);
    if (e) return e;
    const f = (this.plan as AirTermPlan).forks[fi] as AirTermPlan['forks'][number];
    const o = { x: 0, z: 0, yaw: Math.PI / 2, fy: 0 };
    this.forkAt(fi, Math.max(f.c, f.t1 - 1e-3), o);
    e = { x: o.x, z: o.z, yaw: o.yaw };
    this.endMemo.set(fi, e);
    return e;
  }

  private forkAt(fi: number, t: number, o: { x: number; z: number; yaw: number; fy: number }): void {
    const plan = this.plan as AirTermPlan;
    const f = plan.forks[fi];
    if (!f) return;
    // 朝向每次都从路线算（不沿用上一台叉车留在 o 里的）
    o.yaw = Math.PI / 2;
    const face = (q: Loc) => {
      const az = q.az ?? q.z;
      o.x = q.x;
      o.z = az + (q.z > az ? -0.2 : 0.2);
      if (Math.abs(q.z - az) > 0.3) o.yaw = -Math.atan2(q.z - az, 0);
    };
    if (t < f.a) {
      const fh = this.fromHome(fi);
      if (fh && t < fh.dep) {
        // 计划里这一趟已经开始，叉车还在回充电位的路上或者在充电位等着出发
        const pv = this.prevTrip[fi] ?? -1;
        this.idlePose(pv, plan.forks[pv] as AirTermPlan['forks'][number], f, t, o);
      } else if (fh) AirTerminal.walk(fh.pts, trap(t - fh.dep, f.a - fh.dep), o);
      else AirTerminal.walk(this.inPath(fi), trap(t - f.t0, f.a - f.t0), o);
      o.fy = 0.1;
      this.blendBack(fi, 'pick', t, f.a, o);
    } else if (t < f.b) {
      AirTerminal.walk(this.fromHome(fi)?.pts ?? this.inPath(fi), 1, o);
      face(f.from);
      o.fy = f.from.y + 0.1;
      this.handBack(o, this.handWait.get(`${fi}:pick`), t);
    } else if (t < f.c) {
      AirTerminal.walk(this.outPath(fi), trap(t - f.b, f.c - f.b), o);
      o.fy = 0.25;
      this.blendBack(fi, 'drop', t, f.c, o);
    } else {
      AirTerminal.walk(this.outPath(fi), 1, o);
      face(f.to);
      o.fy = t < f.t1 ? f.to.y + 0.1 : 0.1;
      if (t < f.t1) this.handBack(o, this.handWait.get(`${fi}:drop`), t);
    }
  }
  /** 要在货位前往回退着等的：开过去的最后 3 秒直接开到退着等的地方（不先开到货位再退回来） */
  private blendBack(fi: number, ph: 'pick' | 'drop', t: number, tEnd: number, o: { x: number; z: number; yaw: number }): void {
    const w = this.handWait.get(`${fi}:${ph}`);
    if (!w || t <= tEnd - 3) return;
    const f = (this.plan as AirTermPlan).forks[fi] as AirTermPlan['forks'][number];
    const q = this.bq;
    q.yaw = o.yaw;
    AirTerminal.walk(ph === 'pick' ? (this.fromHome(fi)?.pts ?? this.inPath(fi)) : this.outPath(fi), 1, q);
    const loc = ph === 'pick' ? f.from : f.to;
    const az = loc.az ?? loc.z;
    q.x = loc.x;
    q.z = az + (loc.z > az ? -0.2 : 0.2);
    if (Math.abs(loc.z - az) > 0.3) q.yaw = -Math.atan2(loc.z - az, 0);
    this.handBack(q, w, tEnd);
    const k = ease(clamp01((t - (tEnd - 3)) / 3));
    o.x = lerp(o.x, q.x, k);
    o.z = lerp(o.z, q.z, k);
  }
  private readonly bq = { x: 0, z: 0, yaw: 0 };
  /** 货位前有别的叉车：往回（车头朝着货位往后）退 w.d 米等到 w.until，之后 2.5 秒开上去 */
  private handBack(o: { x: number; z: number; yaw: number }, w: { until: number; d: number } | undefined, t: number): void {
    if (!w || t >= w.until + 2.5) return;
    const k = t < w.until ? 1 : 1 - ease((t - w.until) / 2.5);
    o.x -= Math.cos(o.yaw) * w.d * k;
    o.z += Math.sin(o.yaw) * w.d * k;
  }
  private readonly fp = { x: 0, z: 0, yaw: 0, fy: 0 };
  /** 开回充电位、从充电位开回来的路（第 fi 趟做完以后） */
  /**
   * 开回充电位的路（第 fi 趟做完以后）、从充电位直接开去下一趟取货的路（不再回到上一趟放货的地方：几台叉车会在那里碰头），
   * 什么时候从充电位出发（正好在下一趟计划取货的时刻开到）
   */
  private homeWays(fi: number): { go: { x: number; z: number }[]; back: { x: number; z: number }[] | undefined; tGo: number; tBack: number; dep: number } {
    let w = this.homeGo.get(fi);
    if (w) return w;
    const plan = this.plan as AirTermPlan;
    const f = plan.forks[fi] as AirTermPlan['forks'][number];
    const k = this.forkTrips[f.fork] as number[];
    const nx = k[k.indexOf(fi) + 1];
    const nf = nx !== undefined ? plan.forks[nx] : undefined;
    const home = parkOf(plan.layout.forkHome[f.fork] as Loc);
    const e = this.endPose(fi);
    const at0 = { x: f.to.x, z: f.to.az ?? f.to.z, y: 0 };
    const go = [{ x: e.x, z: e.z }, ...forkPath(at0, home, plan.layout.crossX, plan.layout.rooms)];
    const back = nf ? this.fpath(home, nf.from) : undefined;
    const len = (q: { x: number; z: number }[]) => q.reduce((a, p, i) => (i ? a + Math.hypot(p.x - (q[i - 1] as { x: number }).x, p.z - (q[i - 1] as { z: number }).z) : 0), 0);
    const tBack = back ? len(back) / 2.0 + 4 : 0;
    w = { go, back, tGo: len(go) / 2.0 + 4, tBack, dep: nf ? nf.a - tBack : Infinity };
    this.homeGo.set(fi, w);
    return w;
  }
  /** 上一趟做完回了充电位的：这一趟从充电位直接开去取货（返回那条路和出发时刻），没回的返回 undefined */
  private fromHome(fi: number): { pts: { x: number; z: number }[]; dep: number } | undefined {
    const pv = this.prevTrip[fi] ?? -1;
    if (pv < 0) return undefined;
    const d = this.forkIdle.get(pv) ?? this.idleDefault(pv);
    if (d.mode !== 'home') return undefined;
    const w = this.homeWays(pv);
    return w.back ? { pts: w.back, dep: w.dep } : undefined;
  }
  /**
   * 叉车两趟活之间闲着（排计划时按 forkIdle 定好的）：开回自己的充电位（一车一位）等着、下一趟开始前开回来；停在放货的地方；
   * 或者往后倒开几米让出货位前面，下一趟前开回来。几台叉车不会挤在同一个放货点上停着。
   */
  private idlePose(fi: number, f: AirTermPlan['forks'][number], nf: AirTermPlan['forks'][number] | undefined, t: number, o: { x: number; z: number; yaw: number; fy: number }): void {
    const d = this.forkIdle.get(fi) ?? this.idleDefault(fi);
    o.fy = 0.1;
    o.yaw = d.yaw;
    if (d.mode === 'stay') {
      o.x = d.x0;
      o.z = d.z0;
      return;
    }
    const end = nf ? nf.t0 : Infinity;
    if (d.mode === 'back') {
      const k = t < f.t1 + d.tb ? ease(clamp01((t - f.t1) / d.tb)) : t >= end - d.tb ? 1 - ease(clamp01((t - (end - d.tb)) / d.tb)) : 1;
      // 车头方向 (cos, −sin)：往后倒是反过来
      o.x = d.x0 - Math.cos(d.yaw) * d.d * k;
      o.z = d.z0 + Math.sin(d.yaw) * d.d * k;
      return;
    }
    const w = this.homeWays(fi);
    void end;
    if (t < f.t1 + w.tGo) AirTerminal.walk(w.go, trap(t - f.t1, w.tGo), o);
    else if (w.back && nf && t >= w.dep) AirTerminal.walk(w.back, trap(t - w.dep, nf.a - w.dep), o);
    else {
      const h = parkOf((this.plan as AirTermPlan).layout.forkHome[f.fork] as Loc);
      o.x = h.x;
      o.z = h.z;
      o.yaw = Math.PI / 2;
    }
  }
  /** 没排过的：闲得够久（开回去、再开回来还有富余）就回充电位，不够就停在放货的地方 */
  private idleDefault(fi: number): ForkIdle {
    const plan = this.plan as AirTermPlan;
    const f = plan.forks[fi] as AirTermPlan['forks'][number];
    const k = this.forkTrips[f.fork] as number[];
    const nx = k[k.indexOf(fi) + 1];
    const end = nx !== undefined ? (plan.forks[nx] as { t0: number }).t0 : Infinity;
    const e = this.endPose(fi);
    const w = this.homeWays(fi);
    void end;
    return { mode: w.dep - (f.t1 + w.tGo) >= 30 ? 'home' : 'stay', x0: e.x, z0: e.z, yaw: e.yaw, d: 0, tb: 0 };
  }
  /** 叉车 fk 在时刻 t 的样子（画面和排闲着的样子都用这个） */
  private forkPose(fk: number, t: number, o: { x: number; z: number; yaw: number; fy: number }): void {
    const plan = this.plan as AirTermPlan;
    const list = this.forkTrips[fk] as number[];
    // 二分找开始不晚于 t 的最后一趟
    let lo = 0;
    let hi = list.length - 1;
    let cur = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if ((plan.forks[list[m] as number] as { t0: number }).t0 <= t) {
        cur = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    if (cur < 0) {
      const h = parkOf(plan.layout.forkHome[fk] as Loc);
      o.x = h.x;
      o.z = h.z;
      o.yaw = Math.PI / 2;
      o.fy = 0.1;
      return;
    }
    const fi = list[cur] as number;
    const f = plan.forks[fi] as AirTermPlan['forks'][number];
    if (t >= f.t1) {
      const nx = list[cur + 1];
      this.idlePose(fi, f, nx !== undefined ? plan.forks[nx] : undefined, t, o);
    } else this.forkAt(fi, t, o);
  }
  /**
   * 排每一段闲着的样子：按开始的先后，闲得够久的回充电位；不够久的先看停在放货的地方会不会和别的叉车（干活的、已经排好的闲着的）
   * 碰上，碰上就往后倒开几米让出来，还碰就挑碰得最少的那个。每 IDLE_DT 秒取一次每台叉车的位置比。
   */
  private *planIdle(): Steps {
    const plan = this.plan as AirTermPlan;
    this.forkIdle.clear();
    this.endMemo.clear();
    this.homeGo.clear();
    const nF = this.forkTrips.length;
    this.prevTrip = new Int32Array(plan.forks.length).fill(-1);
    for (const list of this.forkTrips) for (let k = 1; k < list.length; k++) this.prevTrip[list[k] as number] = list[k - 1] as number;
    let tEnd = 0;
    for (const f of plan.forks) tEnd = Math.max(tEnd, f.t1);
    const n = Math.min(Math.ceil((tEnd + 600) / IDLE_DT) + 1, Math.ceil((30 * 3600) / IDLE_DT));
    const X = Array.from({ length: nF }, () => new Float32Array(n));
    const Z = Array.from({ length: nF }, () => new Float32Array(n));
    const Yw = Array.from({ length: nF }, () => new Float32Array(n));
    const o = { x: 0, z: 0, yaw: 0, fy: 0 };
    const fill = (fk: number, k0: number, k1: number) => {
      for (let k = Math.max(0, k0); k < Math.min(n, k1); k++) {
        this.forkPose(fk, k * IDLE_DT, o);
        (X[fk] as Float32Array)[k] = o.x;
        (Z[fk] as Float32Array)[k] = o.z;
        (Yw[fk] as Float32Array)[k] = o.yaw;
      }
    };
    for (let fk = 0; fk < nF; fk++) {
      fill(fk, 0, n);
      yield;
    }
    const hits = (fk: number, k0: number, k1: number, pose: (k: number, out: { x: number; z: number; yaw: number }) => void): number => {
      let c = 0;
      const q = { x: 0, z: 0, yaw: 0 };
      for (let k = k0; k < k1; k++) {
        pose(k, q);
        for (let j = 0; j < nF; j++) {
          if (j === fk) continue;
          const bx = (X[j] as Float32Array)[k] as number;
          const bz = (Z[j] as Float32Array)[k] as number;
          if (Math.abs(bx - q.x) > 4.5 || Math.abs(bz - q.z) > 4.5) continue;
          if (forkHit(q.x, q.z, q.yaw, bx, bz, (Yw[j] as Float32Array)[k] as number, 0.12)) c++;
        }
      }
      return c;
    };
    // 先排取放货的等候（按到货位的先后）：别的叉车闲着时按默认（回充电位或停在放货处）算；等候会改变放下货那一刻的样子，
    // 所以排完以后清掉算过的路线、放货的样子，重新取样，再排闲着的样子（闲着的叉车躲开取放货、等候的叉车）
    // 取货、放货的时候货位前有别的叉车（两台叉车在挨着的货位同时取放）：后到的那台往回退几米等它走了再上去（按到货位的先后排；
    // 退到的地方也不能碰上别的叉车，退 2.6 米、4.2 米都碰就挑碰得最少的）
    this.handWait.clear();
    const phases = plan.forks.flatMap((f, fi) => [
      { f, fi, ph: 'pick' as const, ta: f.a, tb: f.b },
      { f, fi, ph: 'drop' as const, ta: f.c, tb: f.t1 },
    ]);
    phases.sort((a, b) => a.ta - b.ta || a.fi - b.fi);
    const at = (fk: number, k: number, out: { x: number; z: number; yaw: number }) => {
      this.forkPose(fk, k * IDLE_DT, o);
      out.x = o.x;
      out.z = o.z;
      out.yaw = o.yaw;
    };
    for (const { f, fi, ph, ta, tb } of phases) {
      yield;
      const k0 = Math.ceil(ta / IDLE_DT);
      const k1 = Math.min(n, Math.ceil(tb / IDLE_DT) + 2);
      const key = `${fi}:${ph}`;
      const h0 = hits(f.fork, k0, k1, (k, out) => at(f.fork, k, out));
      if (h0 === 0) continue;
      // 最后一次碰上的时刻：等到那以后
      let last = -1;
      const q = { x: 0, z: 0, yaw: 0 };
      for (let k = k0; k < k1; k++) {
        at(f.fork, k, q);
        for (let j = 0; j < nF && last < k; j++) {
          if (j === f.fork) continue;
          const bx = (X[j] as Float32Array)[k] as number;
          const bz = (Z[j] as Float32Array)[k] as number;
          if (Math.abs(bx - q.x) <= 4.5 && Math.abs(bz - q.z) <= 4.5 && forkHit(q.x, q.z, q.yaw, bx, bz, (Yw[j] as Float32Array)[k] as number, 0.12)) last = k;
        }
      }
      // 取货：最晚在这一段结束前 2.5 秒开上去（叉起货的那一刻车在货位上，接着开走不跳）；放货可以等到最后（放下货那一刻的样子算在退着等的地方）
      const until = Math.min(ph === 'pick' ? tb - 2.5 : tb, (last + 1) * IDLE_DT + 1);
      if (until <= ta) continue;
      let best: { until: number; d: number } | undefined;
      let bestH = h0;
      for (const d of [HAND_BACK, 4.2, 5.8, 7.4]) {
        this.handWait.set(key, { until, d });
        const h = hits(f.fork, k0, k1, (k, out) => at(f.fork, k, out));
        if (h < bestH) {
          bestH = h;
          best = { until, d };
        }
        if (h === 0) break;
      }
      if (best) this.handWait.set(key, best);
      else this.handWait.delete(key);
      fill(f.fork, k0, k1);
    }
      this.endMemo.clear();
    this.pathIn.clear();
    this.homeGo.clear();
    for (let fk = 0; fk < nF; fk++) {
      fill(fk, 0, n);
      yield;
    }
    // 要排的：不够回充电位的那些（按开始的先后）
    const gaps: { fi: number; fk: number; t0: number; t1: number }[] = [];
    for (let fk = 0; fk < nF; fk++) {
      const list = this.forkTrips[fk] as number[];
      list.forEach((fi, k) => {
        const f = plan.forks[fi] as AirTermPlan['forks'][number];
        const nx = list[k + 1];
        const end = nx !== undefined ? (plan.forks[nx] as { t0: number }).t0 : Infinity;
        if (this.idleDefault(fi).mode === 'stay' && end - f.t1 >= IDLE_DT) gaps.push({ fi, fk, t0: f.t1, t1: end });
      });
    }
    gaps.sort((a, b) => a.t0 - b.t0 || a.fk - b.fk);
    for (const g of gaps) {
      yield;
      const f = plan.forks[g.fi] as AirTermPlan['forks'][number];
      const base = this.idleDefault(g.fi);
      const k0 = Math.ceil(g.t0 / IDLE_DT);
      const k1 = Math.min(n, Math.ceil(g.t1 / IDLE_DT));
      if (k1 <= k0) continue;
      const cands: ForkIdle[] = [base];
      for (const d of [2.6, 4.2, 6.5]) {
        const tb = d / 0.9 + 1.5;
        if (g.t1 - g.t0 >= 2 * tb + 4) cands.push({ ...base, mode: 'back', d, tb });
      }
      // 回充电位来得及（不留富余）也算一个
      const w = this.homeWays(g.fi);
      if (w.dep - (g.t0 + w.tGo) >= 4) cands.push({ ...base, mode: 'home' });
      let best = base;
      let bestHits = Infinity;
      for (const c of cands) {
        this.forkIdle.set(g.fi, c);
        const nx = (this.forkTrips[g.fk] as number[])[(this.forkTrips[g.fk] as number[]).indexOf(g.fi) + 1];
        const nf = nx !== undefined ? plan.forks[nx] : undefined;
        const h = hits(g.fk, k0, k1, (k, out) => {
          this.idlePose(g.fi, f, nf, k * IDLE_DT, o);
          out.x = o.x;
          out.z = o.z;
          out.yaw = o.yaw;
        });
        if (h < bestHits) {
          best = c;
          bestHits = h;
        }
        if (h === 0) break;
      }
      this.forkIdle.set(g.fi, best);
      // 回不回充电位也改了下一趟开去取货的路：取样到下一趟取货为止
      if (best !== base) fill(g.fk, k0, Math.ceil(((plan.forks[(this.forkTrips[g.fk] as number[])[(this.forkTrips[g.fk] as number[]).indexOf(g.fi) + 1] ?? -1]?.a ?? g.t1) + 2) / IDLE_DT));
    }
  }
  private readonly homeGo = new Map<number, { go: { x: number; z: number }[]; back: { x: number; z: number }[] | undefined; tGo: number; tBack: number; dep: number }>();
  private readonly pathIn = new Map<number, { x: number; z: number }[]>();
  private readonly pathOut = new Map<number, { x: number; z: number }[]>();
  private readonly up = { x: 0, y: 0, z: 0 };

  private palletLoc(s: PSpan, t: number, o: { x: number; y: number; z: number }, idx: number): boolean {
    const plan = this.plan as AirTermPlan;
    const L = plan.layout;
    switch (s.at) {
      case 'loc': {
        const q = L.store[s.store as StoreKey]?.[s.ref];
        if (!q) return false;
        o.x = q.x;
        o.y = q.y;
        o.z = q.z;
        return true;
      }
      case 'station': {
        const st = L.stations[Math.floor(s.ref / 16)];
        if (!st) return false;
        const k = s.ref % 16;
        o.x = st.x - 2.4 + (k % 4) * 1.6;
        o.y = 0.05;
        o.z = STATION_Z - 3.6 - Math.floor(k / 4) * 1.3;
        return true;
      }
      case 'stage': {
        const d = L.docks[Math.floor(s.ref / 8)];
        if (!d) return false;
        const k = s.ref % 8;
        o.x = d.x - 0.8 + (k % 2) * 1.6;
        o.y = 0.05;
        o.z = STAGE_Z[Math.floor(k / 2) % 2] as number;
        return true;
      }
      case 'xray': {
        const m = L.xray[Math.floor(s.ref / 1000)];
        if (!m) return false;
        const ph = s.ref % 1000;
        o.x = m.x + (ph === 0 ? (idx % 3) - 1 : 0) * 1.3;
        o.y = 0.45;
        o.z = ph === 0 ? m.z0 - 1.0 : ph === 2 ? m.z1 + 1.0 : lerp(m.z0, m.z1, clamp01((t - s.t0) / Math.max(1, s.t1 - s.t0)));
        return true;
      }
      case 'fork': {
        this.forkAt(s.ref, t, this.fp);
        const c = Math.cos(this.fp.yaw);
        const sn = Math.sin(this.fp.yaw);
        o.x = this.fp.x + c * 0.6;
        o.z = this.fp.z - sn * 0.6;
        o.y = this.fp.fy;
        return true;
      }
      default:
        return false;
    }
  }

  update(t: number): void {
    const plan = this.plan;
    const L = this.L;
    if (!plan || !L || this.building) return;
    // —— 陆侧收货口：车靠稳了门才升起，信号灯红（有车）/ 绿 ——
    this.doors.begin();
    this.lights.begin();
    this.levelers.begin();
    L.docks.forEach((d, i) => {
      const vs = (this.dockVisits[i] ?? []).find((v) => t >= v.t0 - 30 && t < v.t1 + 30);
      const open = vs ? Math.min(ease(clamp01((t - vs.t0 - 20) / 12)), 1 - ease(clamp01((t - (vs.t1 - 30)) / 12))) : 0;
      const h = DOCK_H * (1 - open * 0.9);
      this.doors.put(d.x, FLOOR + DOCK_H - h, TERM.zLand - 0.05, 0, 0, 1, h, 1);
      this.lights.put(d.x + DOCK_W / 2 + 0.7, FLOOR + 2.4, TERM.zLand - 0.3, 0, 0, 1, 1, 1, vs && t >= vs.t0 - 30 ? '#ff3b30' : '#2ecc71');
      if (open > 0.5) this.levelers.put(d.x, FLOOR, TERM.zLand + 0.05);
    });
    this.doors.end();
    this.lights.end();
    this.levelers.end();
    if (!this.near) return;
    for (const p of [this.plates, this.cargo, this.pallets, this.lifts, this.forks, this.people, this.masts, this.decks]) p.begin();
    // —— ETV：立柱和平台 ——
    const busyCrane = L.cranes.map(() => -1);
    for (let mi = plan.moves.length - 1; mi >= 0; mi--) {
      const m = plan.moves[mi] as AirTermPlan['moves'][number];
      if (m.t0 <= t && busyCrane[m.crane] === -1) busyCrane[m.crane] = mi;
    }
    L.cranes.forEach((k, ci) => {
      const mi = busyCrane[ci] as number;
      if (mi >= 0) this.craneAt(mi, t, this.cp);
      else {
        this.cp.x = L.cols[k.home] as number;
        this.cp.y = LEVEL_Y[0];
      }
      this.masts.put(this.cp.x, FLOOR, ETV_Z.aisle);
      this.decks.put(this.cp.x, FLOOR + this.cp.y - 0.05, ETV_Z.aisle);
    });
    // —— 板 ——
    for (let i = 0; i < plan.ulds.length; i++) {
      if (t < (this.uSpan[2 * i] as number) || t >= (this.uSpan[2 * i + 1] as number)) continue;
      const u = plan.ulds[i] as TermUld;
      const s = this.uldPos(u, i, t, this.up);
      if (!s) continue;
      const color = u.own ? OWN : u.dir === 'out' ? C_EXPORT : u.perishable ? C_FRESH : C_IMPORT;
      let k = 1;
      if (s.at === 'station') {
        const j = plan.jobs[this.jobOf.get(i) ?? -1];
        if (j) {
          const f = clamp01((t - j.t0) / Math.max(1, j.t1 - j.t0));
          k = j.kind === 'bd' ? (t < j.t0 ? 1 : 1 - f) : t < j.t0 ? 0 : f;
        }
      }
      this.plates.put(this.up.x, FLOOR + this.up.y, this.up.z, 0, 0, 1, 1, 1, '#ffffff');
      if (k > 0.02) this.cargo.put(this.up.x, FLOOR + this.up.y + 0.1, this.up.z, 0, 0, 1, k, 1, color);
    }
    // —— 货 ——
    for (let i = 0; i < plan.pallets.length; i++) {
      if (t < (this.pSpan[2 * i] as number) || t >= (this.pSpan[2 * i + 1] as number)) continue;
      const p = plan.pallets[i] as AirTermPlan['pallets'][number];
      let s: PSpan | undefined;
      for (let k = p.spans.length - 1; k >= 0; k--) {
        const x = p.spans[k] as PSpan;
        if (x.t0 <= t) {
          if (t < x.t1) s = x;
          break;
        }
      }
      if (!s || !this.palletLoc(s, t, this.up, i)) continue;
      this.pallets.put(this.up.x, FLOOR + this.up.y, this.up.z, 0, 0, 1, 1, 1, p.own ? OWN : (PAL[p.cls] ?? '#c9a46c'));
    }
    // —— 叉车：此刻的那一趟（没活时停在最后放货的通道上，或者充电位） ——
    this.forkTrips.forEach((_, fk) => {
      this.forkPose(fk, t, this.fp);
      this.lifts.put(this.fp.x, FLOOR, this.fp.z, this.fp.yaw);
      this.forks.put(this.fp.x, FLOOR + this.fp.fy, this.fp.z, this.fp.yaw);
    });
    // —— 人：拆组板的两人一组、X 光机操作员、收货员、查验员、冷链穿堂的理货员 ——
    const vest = ['#f39c12', '#f1c40f', '#e67e22', '#d35400'];
    const bob = (k: number) => Math.sin(t * 0.9 + k) * 0.35;
    for (const j of plan.jobs) {
      if (t < j.t0 - 120 || t >= j.t1) continue;
      const st = L.stations[j.station];
      if (!st) continue;
      this.people.put(st.x - 2.3 + bob(j.station) * 0.4, FLOOR, STATION_Z - 1.6, 0, 0, 1, 1, 1, vest[j.station % 4]);
      this.people.put(st.x + 0.2 + bob(j.station + 2), FLOOR, STATION_Z - 2.2, 0, 0, 1, 1, 1, vest[(j.station + 1) % 4]);
    }
    const dayShift = (((t / 3600) % 24) + 24) % 24;
    void dayShift;
    for (const m of L.xray) this.people.put(m.x + 2.3, FLOOR, (m.z0 + m.z1) / 2 + 0.7, Math.PI, 0, 1, 1, 1, '#2a78d6');
    const busyDock = (kind: string) => plan.trucks.some((tr) => (L.docks[tr.dock] as { kind: string }).kind === kind && t >= tr.t0 && t < tr.t1);
    if (busyDock('export')) this.people.put(1993, FLOOR, 991.4, 0, 0, 1, 1, 1, '#27ae60');
    if (busyDock('cold')) this.people.put(2045, FLOOR, 990.6, 0, 0, 1, 1, 1, '#ecf0f1');
    const cu = L.rooms.find((r) => r.key === 'customs');
    if (cu) this.people.put(cu.x0 + 6, FLOOR, cu.z1 - 3.6, 0, 0, 1, 1, 1, '#34495e');
    for (const p of [this.plates, this.cargo, this.pallets, this.lifts, this.forks, this.people, this.masts, this.decks]) p.end();
  }

  setNight(night: number): void {
    this.lightMat.color.setScalar(0.8 + 0.8 * clamp01(night));
  }

  /** 监控面板：ETV、工位、冷库、货架、收货口、本店的板 */
  info(t: number, flightIds: (id: string) => string): TermInfo | undefined {
    const plan = this.plan;
    const L = this.L;
    if (!plan || !L || this.building) return undefined;
    const occ = (key: string) => {
      const a = plan.hub.occupancy[key];
      return a ? Math.round(a[Math.max(0, Math.min(a.length - 1, Math.floor(t / 300)))] ?? 0) : 0;
    };
    const cap = (key: string) => plan.hub.zones.find((z) => z.key === key)?.capacity ?? 0;
    const cranesBusy = L.cranes.filter((_, ci) => plan.moves.some((m) => m.crane === ci && t >= m.t0 && t < m.t1)).length;
    const busy = plan.jobs.filter((j) => t >= j.t0 && t < j.t1).length;
    const backlog = plan.ulds.filter((u) => u.dir === 'in' && u.mode === 'bd' && u.tStored !== undefined && u.tStored <= t && (u.tJob0 ?? Infinity) > t).length;
    const docks = L.docks.map((d, i) => {
      const vs = plan.trucks.filter((tr) => tr.dock === i);
      const now = vs.find((tr) => t >= tr.t0 && t < tr.t1);
      const next = vs.filter((tr) => tr.t0 > t).sort((a, b) => a.t0 - b.t0)[0];
      return { id: d.id, kind: d.kind, ...(now ? { truck: now.label, until: now.t1 } : {}), ...(next ? { next: { t: next.t0, label: next.label } } : {}) };
    });
    const queue = plan.trucks.filter((tr) => !tr.own && t >= tr.arrive && t < tr.t0 - 240).length;
    const own: TermInfo['own'] = [];
    for (const u of plan.ulds) {
      if (!u.own) continue;
      const step = [...u.spans].reverse().find((s) => s.t0 <= t);
      if (!step) continue;
      const where = step.at === 'lane' ? '空侧滚轮道（核对板号、过磅）' : step.at === 'slot' ? '存在 ETV 板架里' : step.at === 'crane' ? 'ETV 搬运中' : step.at === 'station' ? (t < (u.tJob1 ?? Infinity) ? '在工位拆板' : '拆完') : '已离开';
      own.push({ id: u.id, now: `${where}（${flightIds(u.flight)}）`, t: step.t0 });
    }
    const ownP = plan.pallets.filter((p) => p.own);
    const inCold = ownP.filter((p) => p.spans.some((s) => s.at === 'loc' && s.t0 <= t && s.t1 > t)).length;
    const loaded = ownP.filter((p) => p.spans.some((s) => s.at === 'truck' && s.t0 <= t)).length;
    if (ownP.length) own.push({ id: `本店的货 ${ownP.length} 板`, now: `冷藏库里 ${inCold} 板，已装车 ${loaded} 板`, t });
    const day = (x: number) => x >= 0 && x < 86400;
    return {
      etv: { used: occ('etv'), slots: cap('etv'), cranesBusy, cranes: L.cranes.length },
      stations: { busy, total: L.stations.length, backlog },
      cold: { chill: occ('chill'), chillCap: cap('chill'), frozen: occ('frozen'), frozenCap: cap('frozen') },
      stores: (['bulk', 'export', 'dg', 'vault', 'customs'] as const).map((k) => ({ label: plan.hub.zones.find((z) => z.key === k)?.label ?? k, used: occ(k), cap: cap(k) })),
      docks,
      queue,
      own,
      today: { trucks: plan.trucks.filter((tr) => day(tr.t0)).length, uldIn: plan.ulds.filter((u) => u.dir === 'in' && day(u.tIn)).length, uldOut: plan.ulds.filter((u) => u.dir === 'out' && u.tDue !== undefined && day(u.tDue)).length },
    };
  }
}
