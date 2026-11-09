import * as THREE from 'three';
import { box, cyl, merge, wheel, type Part } from '../../../../../StoreX/web/src/three/models';
import type { WVehicle } from '../../../../src/sim/trace';
import { dcLayout } from '../places';
import { drain, ease, lerp, Poly, Pool, prog, rng, rounded, type At, type Steps } from './kit';
import { currentFacilities } from '../../../../src/facility/state';
import { crewOf, shiftOf } from '../../../../src/facility/config';
import { DOORS } from '../../../../src/sim/board';
import { parkLayout, parkRoute, parkYardInputs, planPark, type ParkBooking, type ParkPlan, type Pt } from '../../../../src/hub/park';
import type { HubDay } from '../../../../src/hub/types';
import { FRAMES } from '../../../../src/region/region';
import { toLocal as frameToLocal, toWorld as frameToWorld } from '../../../../src/region/frames';
import type { RoadNet } from '../roadnet';
import * as Yard from '@storewright/yard';
import type { RailYard } from './rail';
import { ParkYard, type ParkTrip, type ParkYardInfo } from './parkYard';

/**
 * 物流园（按真实尺寸画）：配送中心（干货，300 × 150 米、净高 16 米）和冷链中心（160 × 100 米），南墙一排月台门。
 *
 * 月台：每樘门有卷帘门、门封（黑色海绵罩）、防撞块、液压登车桥。车倒车靠上月台以后卷帘门升起、登车桥的搭板伸进车厢；
 * 叉车按这一车的托盘数一趟趟进出车厢：卸货的把托盘从车厢叉到门东侧的收货暂存道，装车的从门西侧的发货暂存道叉进车厢；
 * 发货暂存道在装车前 40 分钟开始一板板备货，收货暂存道的托盘在车走后一板板送去入库。
 *
 * 库内（镜头靠近时屋顶打开）：西半边是自动化立体库（20 条巷道、双深位货架、每条巷道一台堆垛机：
 * 在巷道口从入库输送线叉起托盘 → 边走边升到货位 → 货叉伸进货架放下 → 再去另一个货位取一板 → 回巷道口放到出库输送线），
 * 东半边是货到人拣选区（一格格货架，移动机器人钻到货架下顶起来送到南边的拣选站，拣完再送回去），
 * 中间一条主输送线把周转箱从拣选站送到月台。冷链中心里是越库暂存道和冷藏货架。
 *
 * 库房外面（园区门口的登记、待命停车场、甩挂区、铁路转运仓、短驳和场内牵引车）在 ops/parkYard.ts，按 src/hub/park.ts 的计划：
 * 仿真车在门上的时段、本店的铁路箱在收货门上拆箱的时段都从计划来，月台门、叉车跟着它。计划也交给铁路货运站（箱位、龙门吊给集卡道上的车装卸）
 * 和场地引擎（配送中心、冷链中心、转运仓的场地和当天在门上的每一次访问），值班助手用计划里的一天（hubDay）。
 */

const FLOOR = 1.25;
const H_DRY = 16;
const H_COLD = 13;
const DOOR_W = 3.2;
const DOOR_H = 3.6;
/** 叉车：车身中心到托盘中心 1.8 米 */
const FORK = 1.8;
/** 暂存道两列（离门中心 1.8、3.1 米），每列沿 z 每 1.35 米一板 */
const LANE_X = [FORK, FORK + 1.3];
const LANE_Z0 = 6;
const LANE_DZ = 1.35;
const LANE_N = 13;
/** 一趟叉车的标准时长（秒）；车停得短就压缩 */
const TRIP = 44;

interface Visit {
  door: number;
  vid: number;
  label: string;
  t0: number;
  dock: number;
  t1: number;
  mode: 'load' | 'unload';
  pallets: number;
  trips: { t0: number; t1: number }[];
  /** 发货：每一板开始备货的时刻；收货：每一板送去入库的时刻 */
  lane: number[];
}
interface Door {
  id: string;
  x: number;
  cold: boolean;
}
interface CraneCycle {
  t0: number;
  t1: number;
  z1: number;
  y1: number;
  s1: number;
  z2: number;
  y2: number;
  s2: number;
}

/** 平衡重叉车（车身长 2.4 米，不含货叉）：车身、配重、座椅、护顶架、门架；原点在车身中心的地面，货叉朝 +x */
function forklift(): THREE.BufferGeometry {
  const Y = '#e0a526';
  const D = '#2b2f35';
  return merge([
    box(2.3, 0.85, 1.15, Y, -0.15, 0.25, 0),
    box(0.7, 0.65, 1.1, '#3d4650', -1.0, 1.1, 0),
    box(0.7, 0.45, 0.7, D, -0.1, 1.1, 0),
    ...[0.5, -0.7].flatMap((x) => [box(0.07, 1.15, 0.07, D, x, 1.1, 0.52), box(0.07, 1.15, 0.07, D, x, 1.1, -0.52)]),
    box(1.35, 0.07, 1.12, D, -0.1, 2.25, 0),
    box(0.1, 2.25, 0.85, '#5b6067', 1.0, 0.1, 0),
    wheel(0.32, 0.25, '#1d1d1d', 0.6, 0.32, 0.5),
    wheel(0.32, 0.25, '#1d1d1d', 0.6, 0.32, -0.5),
    wheel(0.26, 0.2, '#1d1d1d', -0.85, 0.26, 0.45),
    wheel(0.26, 0.2, '#1d1d1d', -0.85, 0.26, -0.45),
  ]);
}
/** 货叉架（随托盘升降）：原点在货叉根部的高度 */
function forks(): THREE.BufferGeometry {
  return merge([box(0.1, 0.65, 1.0, '#3d4650', 1.12, 0, 0), box(1.15, 0.06, 0.12, '#5b6067', 1.75, 0, 0.3), box(1.15, 0.06, 0.12, '#5b6067', 1.75, 0, -0.3)]);
}
/** 托盘货（1.0 × 1.2 米托盘、货高 1.3 米，缠了膜）：原点在托盘底面中心，长边沿 z */
function palletLoad(): THREE.BufferGeometry {
  return merge([box(1.0, 0.14, 1.2, '#b08a5a', 0, 0, 0), box(0.96, 1.25, 1.16, '#ffffff', 0, 0.14, 0), box(0.97, 0.05, 1.17, '#d9d9d9', 0, 1.38, 0)]);
}
/** 堆垛机：地轨上的行走台、立柱、顶部导向；原点在行走台中心的地坪上，立柱沿 y */
function stacker(h: number): THREE.BufferGeometry {
  return merge([box(3.0, 0.55, 0.9, '#d9dde1', 0, 0, 0), box(0.5, h, 0.7, '#e5e7e9', -1.0, 0.55, 0), box(0.5, h, 0.7, '#e5e7e9', 1.0, 0.55, 0), box(2.6, 0.35, 0.7, '#d9dde1', 0, h + 0.55, 0), box(0.8, 0.9, 0.6, '#2a78d6', -1.0, 0.55, 0.65)]);
}
/** 堆垛机的载货台（带伸缩货叉）：原点在台面 */
function stackerCarriage(): THREE.BufferGeometry {
  return merge([box(1.5, 0.3, 1.3, '#2a78d6', 0, -0.3, 0), box(1.4, 0.08, 1.2, '#9aa3ab', 0, 0, 0)]);
}
/** 货到人的移动机器人（顶升式，0.8 × 1.0 米、高 0.35 米） */
function amr(): THREE.BufferGeometry {
  return merge([box(1.0, 0.3, 0.8, '#f08c1e', 0, 0.05, 0), cyl(0.32, 0.32, 0.06, '#3d4650', 0, 0.35, 0, 14)]);
}
/** 拣选货架（1.0 × 1.0 米、高 2.2 米，四层货；底下留 0.4 米给机器人钻进去） */
function pod(): THREE.BufferGeometry {
  return merge([box(1.0, 0.06, 1.0, '#4a4f55', 0, 0.38, 0), box(0.94, 1.7, 0.94, '#d9cbb0', 0, 0.44, 0), box(1.0, 0.06, 1.0, '#4a4f55', 0, 2.14, 0), box(0.96, 0.04, 0.96, '#8a9096', 0, 0.86, 0), box(0.96, 0.04, 0.96, '#8a9096', 0, 1.3, 0), box(0.96, 0.04, 0.96, '#8a9096', 0, 1.74, 0)]);
}
/** 周转箱（0.6 × 0.4 米） */
function tote(): THREE.BufferGeometry {
  return box(0.6, 0.32, 0.4, '#2a78d6', 0, 0, 0);
}

/** 货架面的贴图：4 个货位 × 4 层一格，蓝色立柱、橙色横梁、托盘货有的白膜有的纸箱色，偶尔空位 */
function rackTexture(seed: number, top: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = top ? 512 : 256;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const r = rng(seed);
  const loads = ['#e8e4da', '#d9c3a0', '#c9a678', '#f1efe8', '#b9a07a', '#dcd6c8'];
  if (top) {
    g.fillStyle = '#3a3f45';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 8; j++) {
        if (r() < 0.12) continue;
        g.fillStyle = loads[Math.floor(r() * loads.length)] as string;
        g.fillRect(i * 128 + 8, j * 64 + 6, 112, 52);
      }
    g.fillStyle = '#f08c1e';
    for (let i = 0; i <= 4; i++) g.fillRect(i * 128 - 2, 0, 4, 512);
  } else {
    g.fillStyle = '#23272c';
    g.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        const x = i * 128;
        const y = j * 64;
        if (r() > 0.1) {
          g.fillStyle = '#9c7a4f';
          g.fillRect(x + 10, y + 52, 108, 7);
          g.fillStyle = loads[Math.floor(r() * loads.length)] as string;
          g.fillRect(x + 12, y + 14 + Math.floor(r() * 6), 104, 38);
        }
        g.fillStyle = '#f08c1e';
        g.fillRect(x, y + 59, 128, 5);
      }
    g.fillStyle = '#2a6fb0';
    for (let i = 0; i <= 4; i++) g.fillRect(i * 128 - 3, 0, 6, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
/** 一段平面（贴图按真实尺寸重复）：from → to 两点、离地 y0 → y1；法线朝 n 这一侧 */
function texQuad(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, tileW: number, tileH: number): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, bz - az);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az], 3));
  const u = len / tileW;
  const v = (y1 - y0) / tileH;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u, 0, u, v, 0, 0, u, v, 0, v], 2));
  g.computeVertexNormals();
  return g;
}
/** 水平的贴图面（货架顶） */
function texTop(x0: number, z0: number, x1: number, z1: number, y: number, tileW: number, tileD: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0], 3));
  const u = (x1 - x0) / tileW;
  const v = (z1 - z0) / tileD;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u, 0, u, v, 0, 0, u, v, 0, v], 2));
  g.computeVertexNormals();
  return g;
}

/** 物流园当天的输入：车辆清单、地点 → 门、每车几板、背景流量倍数 */
type ParkDay = { list: WVehicle[]; resolve: (vehicle: number, key: string) => string | undefined; palletsOf: (vid: number) => number | undefined; traffic: number };

export class DcOps {
  readonly group = new THREE.Group();
  /** 屋顶（镜头靠近时隐藏，露出库内） */
  private roofs = new THREE.Group();
  /** 库内的东西（屋顶盖着时不画、不算） */
  private inside = new THREE.Group();
  private doorPanels: Pool;
  private levelers: Pool;
  private lifts: Pool;
  private liftForks: Pool;
  private pallets: Pool;
  private stackers: Pool;
  private carriages: Pool;
  private amrs: Pool;
  private pods: Pool;
  private totes: Pool;
  private barriers: Pool;
  private readonly L = dcLayout();
  private readonly doors: Door[];
  private visits: Visit[] = [];
  private seed = 1;
  private readonly X0: number;
  private readonly X1: number;
  private readonly ZN: number;
  private readonly ZS: number;
  private readonly CX0: number;
  private readonly CX1: number;
  private readonly CZN: number;
  /** 立体库：巷道中心 x、货架沿 z 的范围、巷道口（输送线）的 z */
  private readonly aisles: number[] = [];
  private readonly rackZ: [number, number];
  private cranes: CraneCycle[][] = [];
  /** 货到人：货架格位、拣选站、机器人的任务 */
  private readonly podSlots: { x: number; z: number }[] = [];
  private readonly stations: { x: number; z: number }[] = [];
  private amrPlan: { pod: number; t0: number; legs: { path: Poly; t0: number; t1: number; carry: boolean }[]; wait: [number, number] }[][] = [];
  /** 主输送线 */
  private conveyor: Poly;
  /** 门口的道闸位置（区域里判断有没有仿真车经过门口用；道闸在 parkYard 里画） */
  readonly gates: { x: number; z: number; yaw: number }[];
  /** 库房外面的场地和车 */
  readonly yard: ParkYard;
  private plan: ParkPlan | undefined;
  private rails: { W?: RailYard; E?: RailYard } = {};
  private net: RoadNet | undefined;
  private bookings: ParkBooking[] = [];
  private day: ParkDay | undefined;
  private opOf: ((vid: number) => string | undefined) | undefined;
  private readonly sited = new Set<string>();
  private readonly visitSig = new Map<string, string>();
  private readonly atA: At = { x: 0, z: 0, yaw: 0 };
  private planT: (vid: number, t: number) => number | undefined = (_, x) => x;
  /** 某次靠台按那辆车自己的时钟（现场视图里车晚了，门和叉车也跟着晚） */
  private tv(vs: Visit, t: number): number {
    return this.planT(vs.vid, t) ?? t;
  }

  constructor() {
    this.group.name = 'dc-ops';
    const { dc, wallZ, dryDoors, coldDoors } = this.L;
    this.X0 = dc.x - 140;
    this.X1 = dc.x + 160;
    this.ZN = dc.z - 225;
    this.ZS = wallZ;
    this.CX0 = dc.x + 180;
    this.CX1 = dc.x + 340;
    this.CZN = dc.z - 175;
    this.doors = [...dryDoors.map((x, i) => ({ id: `D${String(i + 1).padStart(2, '0')}`, x, cold: false })), ...coldDoors.map((x, i) => ({ id: `C${String(i + 1).padStart(2, '0')}`, x, cold: true }))];
    // 立体库的巷道数、货到人的机器人数按设施配置
    const cfg = currentFacilities().dc;
    for (let a = 0; a < Math.max(4, Math.min(20, cfg.aisles)); a++) this.aisles.push(this.X0 + 13.5 + a * 7);
    this.rackZ = [this.ZN + 8, this.ZS - 44];
    // 货到人：货架两列一组（间距 1.15 米）、组和组之间 3.4 米通道；沿 z 三个区块、每块 10 格（1.5 米一格）
    for (let pair = 0; pair < 22; pair++)
      for (const cx of [0, 1])
        for (let k = 0; k < 30; k++) this.podSlots.push({ x: this.X0 + 166 + pair * 5.6 + cx * 1.15, z: this.ZN + 16 + Math.floor(k / 10) * 17.5 + (k % 10) * 1.5 });
    for (let s = 0; s < 10; s++) this.stations.push({ x: this.X0 + 168 + s * 12.5, z: this.ZS - 46 });
    this.conveyor = new Poly(rounded([{ x: this.X0 + 8, z: this.ZS - 38 }, { x: this.X1 - 8, z: this.ZS - 38 }, { x: this.X1 - 8, z: this.ZS - 31 }, { x: this.X0 + 8, z: this.ZS - 31 }, { x: this.X0 + 8, z: this.ZS - 37.9 }], 2));
    // 门口：出门车道和进门车道的道闸（区域车辆层按它判断有车经过门口）
    const PL = parkLayout(currentFacilities().dc.railTracks);
    this.gates = [
      { x: (PL.kioskOut[0] as Pt).x, z: (PL.kioskOut[0] as Pt).z + 5, yaw: Math.PI },
      { x: (PL.kioskIn[0] as Pt).x, z: (PL.kioskIn[0] as Pt).z - 5, yaw: 0 },
    ];
    this.yard = new ParkYard(PL);

    const VC = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.06 });
    this.doorPanels = new Pool(merge([box(DOOR_W, 1, 0.12, '#d4d8dc', 0, 0, 0), box(DOOR_W, 0.06, 0.14, '#9aa0a6', 0, 0.5, 0)]), VC, this.doors.length, 'dock-doors', false);
    this.levelers = new Pool(merge([box(2.2, 0.08, 0.7, '#7d8288', 0, -0.08, 0.35), box(2.2, 0.05, 0.12, '#f0c419', 0, 0, 0.66)]), VC, this.doors.length, 'dock-levelers', false);
    this.lifts = new Pool(forklift(), VC, 48, 'forklifts');
    this.liftForks = new Pool(forks(), VC, 48, 'forklift-forks', false);
    this.pallets = new Pool(palletLoad(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 1400, 'pallets');
    this.stackers = new Pool(stacker(14.2), VC, 20, 'stacker-cranes');
    this.carriages = new Pool(stackerCarriage(), VC, 20, 'stacker-carriages', false);
    this.amrs = new Pool(amr(), VC, 60, 'amrs', false);
    this.pods = new Pool(pod(), VC, this.podSlots.length + 4, 'pick-pods');
    this.totes = new Pool(tote(), VC, 90, 'totes', false);
    this.barriers = new Pool(merge([box(7.0, 0.16, 0.16, '#e8e8e8', 3.5, 0, 0)]), VC, 1, 'gate-barriers', false);
    for (const p of [this.doorPanels, this.levelers]) this.group.add(p.mesh);
    this.group.add(this.yard.group);
    for (const p of [this.lifts, this.liftForks, this.pallets, this.stackers, this.carriages, this.amrs, this.pods, this.totes]) this.inside.add(p.mesh);
    this.group.add(this.shell(), this.roofs, this.inside);
    this.inside.add(this.interior());
  }

  /** 库房外壳：墙（南墙留门洞）、库内地坪、门封和防撞块、屋顶（另放，能隐藏）、门卫室和道闸的底座 */
  private shell(): THREE.Group {
    const g = new THREE.Group();
    const p: Part[] = [];
    const roof: Part[] = [];
    const W = '#e4e1d8';
    const C = '#dfe9f2';
    const wall = (x0: number, x1: number, zN: number, zS: number, h: number, color: string, doorXs: number[]) => {
      const t = 0.6;
      p.push(box(x1 - x0, h, t, color, (x0 + x1) / 2, 0, zN), box(t, h, zS - zN, color, x0, 0, (zN + zS) / 2), box(t, h, zS - zN, color, x1, 0, (zN + zS) / 2));
      // 南墙：月台下面一条、门洞上面一条、门洞之间的墙垛
      p.push(box(x1 - x0, FLOOR, t, '#b9b6ad', (x0 + x1) / 2, 0, zS), box(x1 - x0, h - FLOOR - DOOR_H, t, color, (x0 + x1) / 2, FLOOR + DOOR_H, zS));
      const xs = [x0, ...doorXs.flatMap((x) => [x - DOOR_W / 2, x + DOOR_W / 2]), x1];
      for (let i = 0; i < xs.length; i += 2) {
        const a = xs[i] as number;
        const b = xs[i + 1] as number;
        if (b - a > 0.05) p.push(box(b - a, DOOR_H, t, color, (a + b) / 2, FLOOR, zS));
      }
      // 库内地坪（月台高度）、屋面
      p.push(box(x1 - x0 - 1, 0.2, zS - zN - 1, '#9b9e9f', (x0 + x1) / 2, FLOOR - 0.2, (zN + zS) / 2));
      roof.push(box(x1 - x0 + 2, 1.2, zS - zN + 2, '#c9ccd1', (x0 + x1) / 2, h, (zN + zS) / 2));
      for (const x of doorXs) {
        // 门封（黑色海绵罩）、防撞块、门上的雨棚
        p.push(box(0.55, DOOR_H + 0.6, 0.9, '#1f2226', x - DOOR_W / 2 - 0.3, FLOOR - 0.2, zS + 0.75), box(0.55, DOOR_H + 0.6, 0.9, '#1f2226', x + DOOR_W / 2 + 0.3, FLOOR - 0.2, zS + 0.75), box(DOOR_W + 1.7, 0.7, 0.9, '#1f2226', x, FLOOR + DOOR_H + 0.1, zS + 0.75));
        p.push(box(0.35, 0.45, 0.25, '#151515', x - 1.3, FLOOR - 0.55, zS + 0.4), box(0.35, 0.45, 0.25, '#151515', x + 1.3, FLOOR - 0.55, zS + 0.4));
      }
    };
    wall(this.X0, this.X1, this.ZN, this.ZS, H_DRY, W, this.doors.filter((d) => !d.cold).map((d) => d.x));
    wall(this.CX0, this.CX1, this.CZN, this.ZS, H_COLD, C, this.doors.filter((d) => d.cold).map((d) => d.x));
    // 屋顶光伏、冷库屋顶的冷凝机组
    for (let x = this.X0 + 14; x < this.X1 - 10; x += 12) for (let z = this.ZN + 10; z < this.ZS - 12; z += 10) roof.push(box(10.5, 0.3, 8, '#1f3550', x, H_DRY + 1.3, z));
    for (let x = this.CX0 + 20; x < this.CX1 - 15; x += 24) roof.push(box(8, 2.4, 4, '#aab4bd', x, H_COLD + 1.2, this.CZN + 30), box(8.2, 0.3, 4.2, '#5b6067', x, H_COLD + 3.6, this.CZN + 30));
    const body = new THREE.Mesh(merge(p), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    const rm = new THREE.Mesh(merge(roof), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    rm.castShadow = true;
    rm.receiveShadow = true;
    this.roofs.add(rm);
    return g;
  }

  /** 库内不动的部分：立体库货架（贴图）、地轨、输送线、暂存道的地标线、拣选站、冷库的货架 */
  private interior(): THREE.Group {
    const g = new THREE.Group();
    const side = new THREE.MeshStandardMaterial({ map: rackTexture(7, false), roughness: 0.9, side: THREE.DoubleSide });
    const top = new THREE.MeshStandardMaterial({ map: rackTexture(9, true), roughness: 0.9 });
    const sides: THREE.BufferGeometry[] = [];
    const tops: THREE.BufferGeometry[] = [];
    const H = 14.2;
    // 贴图一格 = 4 个货位（3.6 米一个）× 4 层（1.75 米一层）；顶面一格 = 4 × 8 个托盘
    const TW = 14.4;
    const TH = 7;
    const rack = (x0: number, x1: number, z0: number, z1: number, h: number) => {
      sides.push(texQuad(x0, z0, x0, z1, FLOOR, FLOOR + h, TW, TH), texQuad(x1, z1, x1, z0, FLOOR, FLOOR + h, TW, TH));
      sides.push(texQuad(x0, z1, x1, z1, FLOOR, FLOOR + h, TW, TH), texQuad(x1, z0, x0, z0, FLOOR, FLOOR + h, TW, TH));
      tops.push(texTop(x0, z0, x1, z1, FLOOR + h, 5.2, 7.2));
    };
    const [z0, z1] = this.rackZ;
    // 立体库：每条巷道两侧是双深位货架（2.6 米深），相邻巷道的货架背靠背
    for (const ax of this.aisles) {
      rack(ax - 3.5, ax - 0.9, z0, z1, H);
      rack(ax + 0.9, ax + 3.5, z0, z1, H);
    }
    // 冷链中心北半边：冷藏货架（叉车区）
    for (let k = 0; k < 6; k++) rack(this.CX0 + 12 + k * 22, this.CX0 + 14.6 + k * 22, this.CZN + 8, this.CZN + 50, 9);
    const sm = new THREE.Mesh(merge(sides), side);
    sm.receiveShadow = true;
    const tm = new THREE.Mesh(merge(tops), top);
    g.add(sm, tm);
    const p: Part[] = [];
    // 堆垛机地轨、巷道口的出入库输送段
    for (const ax of this.aisles) {
      p.push(box(0.25, 0.15, z1 - z0 + 4, '#5b6067', ax, FLOOR, (z0 + z1) / 2));
      p.push(box(1.3, 0.75, 4.5, '#8a9096', ax + 1.9, FLOOR, z1 + 2.2), box(1.3, 0.75, 4.5, '#8a9096', ax - 1.9, FLOOR, z1 + 2.2));
    }
    // 主输送线（架空 0.9 米，周转箱在上面跑）
    for (let s = 0; s < this.conveyor.len; s += 1.5) {
      const a = this.conveyor.at(s);
      p.push(box(1.6, 0.18, 1.0, '#8a9096', 0, 0, 0).rotateY(a.yaw).translate(a.x, FLOOR + 0.75, a.z));
      if (Math.round(s / 1.5) % 4 === 0) p.push(box(0.12, 0.75, 0.12, '#5b6067', a.x, FLOOR, a.z));
    }
    // 暂存道的地标线（每樘门两侧各一条）
    for (const d of this.doors) {
      for (const sx of [-1, 1]) {
        const xc = d.x + sx * (FORK + 0.65);
        p.push(box(2.5, 0.03, 0.08, '#f0c419', xc, FLOOR + 0.01, this.ZS - LANE_Z0 + 0.7), box(2.5, 0.03, 0.08, '#f0c419', xc, FLOOR + 0.01, this.ZS - LANE_Z0 - LANE_N * LANE_DZ + 0.6));
        p.push(box(0.08, 0.03, LANE_N * LANE_DZ, sx < 0 ? '#3d8ff0' : '#f08c1e', xc + 1.25, FLOOR + 0.01, this.ZS - LANE_Z0 - (LANE_N * LANE_DZ) / 2 + 0.65), box(0.08, 0.03, LANE_N * LANE_DZ, sx < 0 ? '#3d8ff0' : '#f08c1e', xc - 1.25, FLOOR + 0.01, this.ZS - LANE_Z0 - (LANE_N * LANE_DZ) / 2 + 0.65));
      }
    }
    // 货到人拣选站（工作台 + 灯塔）、机器人区的围网
    for (const s of this.stations) p.push(box(3.5, 0.95, 1.4, '#d6d9dc', s.x, FLOOR, s.z + 2.2), box(0.1, 2.2, 0.1, '#5b6067', s.x + 1.9, FLOOR, s.z + 2.2), box(0.25, 0.25, 0.25, '#1baf7a', s.x + 1.9, FLOOR + 2.2, s.z + 2.2));
    p.push(box(this.X1 - this.X0 - 166, 1.8, 0.05, '#9aa3ab', (this.X0 + 158 + this.X1 - 8) / 2, FLOOR, this.ZS - 43.2));
    // 冷链中心：越库区地面（浅蓝）
    p.push(box(this.CX1 - this.CX0 - 4, 0.02, 40, '#cfe0ee', (this.CX0 + this.CX1) / 2, FLOOR + 0.005, this.ZS - 22));
    const body = new THREE.Mesh(merge(p), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    body.receiveShadow = true;
    g.add(body);
    return g;
  }

  /** 区域给的铁路货运站两段站台（物流园的）和道路网（外来的车从公路上开来） */
  attachRail(w: RailYard, e: RailYard, net: RoadNet): void {
    this.rails = { W: w, E: e };
    this.net = net;
    if (this.plan) this.pushPlan();
  }
  /** 调度台的月台门预约变了（排队等门、提前装好的挂车）：重排物流园的计划 */
  setBookings(list: readonly { door: string; t0: number; t1: number; mode: 'load' | 'unload' }[]): void {
    const next = list.filter((b) => /^[DC]\d\d$/.test(b.door)).map((b) => ({ door: b.door, t0: b.t0, t1: b.t1, mode: b.mode }));
    if (JSON.stringify(next) === JSON.stringify(this.bookings)) return;
    this.bookings = next;
    if (!this.day) return;
    if (this.deferred) {
      this.deferred.replan = true;
      this.deferred.visits = true;
      return;
    }
    this.replan();
    this.buildVisits();
  }
  /** 仿真车对应的调度台作业编号（值班助手按它把排队、靠台的时间接到那一趟车上） */
  setOpOf(fn: (vid: number) => string | undefined): void {
    this.opOf = fn;
    if (!this.day) return;
    if (this.deferred) {
      this.deferred.replan = true;
      return;
    }
    this.replan();
  }
  /**
   * 三维层换了一天（view.ts 分段排的时候）：接着送来的作业编号、月台门预约先记下，flush 时只重排一次。
   * 挨个重排时最后一次用的就是这两样最新的值，计划一样；月台门上的作业只在预约变了时按新计划重算（和挨个重排时一样）。
   */
  private deferred: { replan: boolean; visits: boolean } | undefined;
  defer(): void {
    this.deferred = { replan: false, visits: false };
  }
  flush(): void {
    drain(this.flushSteps());
  }
  /**
   * 和 flush 一样，分几段（重排计划、场内的车排轨迹、月台门上的作业各一段）：view.ts 分段排的时候用。
   * 排的这几段里又送来作业编号、预约：照样先记下，排完接着按最新的再排一遍（和 flush 以后再调一样）。
   */
  *flushSteps(): Steps {
    for (;;) {
      const d = this.deferred;
      if (!d || !this.day) {
        this.deferred = undefined;
        return;
      }
      this.deferred = { replan: false, visits: false };
      if (d.replan) yield* this.replanSteps();
      if (d.visits) {
        yield;
        this.buildVisits();
      }
      const again = this.deferred as { replan: boolean; visits: boolean } | undefined;
      if (!again || (!again.replan && !again.visits)) {
        this.deferred = undefined;
        return;
      }
      yield;
    }
  }
  /** 物流园的计划排好了（换了一天、调度台改了预约）：外来的车在路上那一部分交给区域的外来货车层 */
  onPlan?: () => void;
  parkTrips(): ParkTrip[] {
    return this.yard.trips();
  }
  /** 物流园当天的计划、给值班助手的一天 */
  parkPlan(): ParkPlan | undefined {
    return this.plan;
  }
  hubDay(): HubDay | undefined {
    return this.plan?.hub;
  }

  private replan(): void {
    drain(this.replanSteps());
  }
  private *replanSteps(): Steps {
    const d = this.day;
    if (!d) return;
    this.plan = this.planOf(d, { bookings: this.bookings, opOf: this.opOf, fac: currentFacilities().dc }, this.seed);
    yield;
    yield* this.pushSteps();
  }
  /** 物流园一天的计划（输入：当天的车、月台门预约、作业编号、设施配置） */
  private planOf(d: ParkDay, inp: { bookings: ParkBooking[]; opOf: ((vid: number) => string | undefined) | undefined; fac: ReturnType<typeof currentFacilities>['dc'] }, seed: number): ParkPlan {
    const fac = inp.fac;
    return planPark({ vehicles: d.list, doorOf: d.resolve, bookings: inp.bookings, palletsOf: d.palletsOf, ...(inp.opOf ? { opOf: inp.opOf } : {}), seed, traffic: d.traffic, tracks: fac.railTracks, open: { dry: fac.dryDoors, cold: fac.coldDoors } });
  }
  /** 计划交给库房外面的场地、铁路货运站、场地引擎 */
  private pushPlan(): void {
    drain(this.pushSteps());
  }
  /** 和 pushPlan 一样，分段：场内的车排轨迹（parkYard.setPlanSteps：每辆车一段、互相让的检查每一段动的一段），铁路货运站、场地引擎的登记各一段 */
  private *pushSteps(): Steps {
    const plan = this.plan;
    if (!plan) return;
    yield* this.yard.setPlanSteps(plan, (k, out) => this.approach(k, out));
    yield;
    this.onPlan?.();
    this.rails.W?.setPlan({ boxes: plan.boxes.filter((b) => b.section === 'W'), transfers: plan.transfers.W });
    this.rails.E?.setPlan({ boxes: plan.boxes.filter((b) => b.section === 'E'), transfers: plan.transfers.E });
    yield;
    this.registerYards(plan);
  }
  /** 外来的车从园区路口的第 k 条公路开来（out = 开走）：车道折线，远处 → 路口（物流园局部坐标） */
  private approach(k: number, out: boolean): Pt[] {
    const net = this.net;
    if (!net) return [];
    const lines = net.lines.filter((l) => (l.ja === 'DC' || l.jb === 'DC') && !/BAKERY|staff/.test(`${l.ja}|${l.jb}`)).sort((a, b) => `${a.ja}|${a.jb}`.localeCompare(`${b.ja}|${b.jb}`));
    const line = lines[k % Math.max(1, lines.length)];
    if (!line) return [];
    const atA = line.ja === 'DC';
    const near = atA ? Math.min(line.len, line.trimA + 2) : Math.max(0, line.len - line.trimB - 2);
    const far = atA ? Math.min(line.len, 280) : Math.max(0, line.len - 280);
    const pts = out ? net.lanePath(line, near, far, 0).reverse() : net.lanePath(line, far, near, 0);
    return pts.map((q) => frameToLocal(FRAMES.park, { x: q.x, z: q.z }));
  }
  /**
   * 场地引擎：登记配送中心、冷链中心、转运仓两面的场地（门的编号和调度台一样），把配送中心、冷链中心当天在门上的每一次访问交过去
   * （仿真车、本店铁路箱的短驳车）——区域的运动规划按它让仿真车排队、倒车，两边用同一份。
   */
  private registerYards(plan: ParkPlan): void {
    const Y = Yard as unknown as { setSiteVisits?: (key: string, visits: Yard.YardVisit[]) => void; simVisitId?: (vid: number, stop: number) => string };
    const kindOf = (vid: number): Yard.YardVehicle => {
      const k = this.day?.list.find((v) => v.id === vid)?.kind;
      return k === 'drayage' ? 'chassis' : k === 'reefer' ? 'reefer' : k === 'ev' ? 'truck' : k === 'van' ? 'van' : 'semi';
    };
    // 只有配送中心、冷链中心的门上有仿真车（转运仓的车这里自己画，不用登记）；排场地要几秒，同一个区域只排一次，访问没变就不重排
    for (const inp of parkYardInputs(plan.layout)) {
      if (inp.key !== 'park-dc' && inp.key !== 'park-cold') continue;
      try {
        const sig = `${inp.key}|${FRAMES.park.w.x},${FRAMES.park.w.z},${FRAMES.park.rot}|${plan.layout.wallZ}`;
        if (!this.sited.has(sig)) {
          const yp = Yard.planYard({ doors: inp.doors.map((d) => ({ x: d.x, id: d.id, cold: d.cold, kinds: d.kinds as Yard.YardVehicle[] })), x0: inp.x0, x1: inp.x1, depth: inp.depth, side: inp.side, from: inp.from, access: inp.access, driveX: inp.driveX, queue: inp.queue, drop: inp.drop });
          const o = frameToWorld(FRAMES.park, inp.frame.origin);
          // 门的最后一段路：从园区入口开到进门登记亭（道路段在这里结束），出来时从驶出点经登记亭出园
          const Lr = plan.layout;
          const Wd = (q: Pt) => frameToWorld(FRAMES.park, q);
          const P0 = (q: Pt) => ({ x: inp.frame.origin.x + q.x, z: inp.frame.origin.z + q.z });
          const entry = { x: dcLayout().dc.x, z: dcLayout().dc.z - 4 };
          const go = P0(yp.gateOut);
          const nd = (k: string) => Lr.nodes[k] as Pt;
          const out = inp.key === 'park-cold' ? [go, { x: go.x, z: go.z + 8 }, { x: nd('courtW').x + 1.5, z: go.z + 8 }, nd('rsMid'), nd('rsE'), nd('gate'), Lr.kioskOut[0] as Pt, entry] : [go, nd('rsMid'), nd('rsE'), nd('gate'), Lr.kioskOut[0] as Pt, entry];
          Yard.defineYardSite({ key: inp.key, frame: { origin: o, yaw: FRAMES.park.rot + inp.frame.yaw }, plan: yp, doors: inp.doors.map((d, i) => ({ id: d.id, index: i, kinds: d.kinds as Yard.YardVehicle[], approach: [Wd(entry), Wd(Lr.kioskIn[0] as Pt)], leave: out.map(Wd) })) });
          this.sited.add(sig);
        }
        if (!Y.setSiteVisits) continue;
        const idx = new Map(inp.doors.map((d, i) => [d.id, i] as const));
        const visits: Yard.YardVisit[] = [];
        // 本店的仿真车：登记亭停 → （等门的进待命停车场停）→ 干货门经西侧场内路开到进场点、冷链门沿月台前的车道开到靠台车道起点；
        // 甩挂的车空车头去甩挂区挂上装好的挂车就走。离开时刻按场地引擎的 simVisitFor（车头在仿真的离开时刻开到驶出点）
        const Lr = plan.layout;
        const site = Yard.yardSite(inp.key);
        const cold = inp.key === 'park-cold';
        const Wd = (q: Pt) => frameToWorld(FRAMES.park, q);
        const P0 = (q: Pt) => ({ x: inp.frame.origin.x + q.x, z: inp.frame.origin.z + q.z });
        const nd = (k: string) => Lr.nodes[k] as Pt;
        const kIn = Lr.kioskIn[0] as Pt;
        const kOut = Lr.kioskOut[0] as Pt;
        const lenOf = (q: Pt[]) => q.reduce((a, p, k) => (k ? a + Math.hypot(p.x - (q[k - 1] as Pt).x, p.z - (q[k - 1] as Pt).z) : 0), 0);
        const dtOf = (q: Pt[]) => lenOf(q) / 4.5 + 8;
        const gIn = site ? P0(site.plan.gateIn) : nd('courtW');
        const cStart = site ? P0({ x: site.plan.xTurnDock, z: site.plan.zCourt }) : nd('courtE');
        const tail = (from: string): Pt[] => (cold ? [...parkRoute(Lr, from, 'courtE'), cStart] : [...parkRoute(Lr, from, 'rsMid'), { x: gIn.x, z: (nd('rsMid').z + gIn.z) / 2 }, gIn]);
        for (const s of plan.sims) {
          const i = idx.get(s.door);
          if (i === undefined) continue;
          const id = Y.simVisitId ? Y.simVisitId(s.vid, s.stop) : `${s.vid}:${s.stop}`;
          const kind = kindOf(s.vid);
          const leaveAt = Yard.simVisitFor(inp.key, s.vid, s.stop, kind, i, s.arrive, s.leave)?.leaveAt ?? s.dockAt[1];
          if (!(s.checkIn[1] > s.checkIn[0])) {
            visits.push({ id, vehicle: kind, door: i, arrive: s.arrive - 1200, dockAt: s.arrive, leaveAt, own: true });
            continue;
          }
          const W = (q: Pt[]) => q.map(Wd);
          if (s.drop) {
            const st = Lr.drop.stalls.find((x) => x.id === s.drop?.stall) ?? (Lr.drop.stalls[s.vid % Math.max(1, Lr.drop.stalls.length)] as (typeof Lr.drop.stalls)[number]);
            const setup = { x: st.x + 18, z: Lr.drop.aisleZ };
            const c = { x: st.x, z: st.z };
            const goP = [kIn, ...parkRoute(Lr, 'gate', 'dropW'), setup];
            const hook = Math.max(s.checkIn[1] + dtOf(goP) + 45, s.drop.hookAt);
            const away = [c, { x: st.x - 2, z: Lr.drop.aisleZ }, ...parkRoute(Lr, 'dropW', 'gate'), kOut];
            const t5 = Math.min(s.leave - 5, Math.max(hook + 90, s.leave - dtOf(away)));
            visits.push({ id, vehicle: kind, door: i, arrive: s.arrive, dockAt: s.dockAt[0], leaveAt, own: true, leave: W([kOut, { x: dcLayout().dc.x, z: dcLayout().dc.z - 4 }]), script: [
              { kind: 'stop', t0: s.arrive, t1: s.checkIn[1], bobtail: true },
              { kind: 'drive', pts: W(goP), t0: s.checkIn[1], t1: hook - 45, bobtail: true },
              { kind: 'back', pts: W([setup, c]), t0: hook - 45, t1: hook, bobtail: true },
              { kind: 'stop', t0: hook, t1: t5 },
              { kind: 'drive', pts: W(away), t0: t5, t1: s.leave },
            ] });
            continue;
          }
          const pre: Yard.YardPiece[] = [{ kind: 'stop', t0: s.arrive, t1: s.checkIn[1] }];
          let t = s.checkIn[1];
          const hs = s.hold ? Lr.hold.stalls.find((x) => x.id === s.hold?.stall) : undefined;
          if (s.hold && hs) {
            const c = { x: hs.x, z: hs.z + 5 };
            const goP = [kIn, ...parkRoute(Lr, 'gate', 'holdIn'), { x: hs.x, z: hs.z - hs.len / 2 - 8 }, c];
            const t1 = Math.max(t + dtOf(goP), s.hold.t0);
            pre.push({ kind: 'drive', pts: W(goP), t0: t, t1 }, { kind: 'stop', t0: t1, t1: Math.max(t1, s.hold.t1) });
            t = Math.max(t1, s.hold.t1);
            const back = [c, { x: hs.x, z: hs.z + hs.len / 2 + 6 }, ...tail('holdOut')];
            pre.push({ kind: 'drive', pts: W(back), t0: t, t1: t + dtOf(back) });
            t += dtOf(back);
          } else {
            const goP = [kIn, ...tail('gate')];
            pre.push({ kind: 'drive', pts: W(goP), t0: t, t1: t + dtOf(goP) });
            t += dtOf(goP);
          }
          visits.push({ id, vehicle: kind, door: i, arrive: t, dockAt: s.dockAt[0], leaveAt, own: true, pre, ...(cold ? { via: 'court' as const } : {}) });
        }
        for (const b of plan.boxes) {
          const i = b.door ? idx.get(b.door) : undefined;
          if (i === undefined || !b.devan) continue;
          visits.push({ id: `短驳:${b.id}`, vehicle: 'chassis', door: i, arrive: b.devan[0] - 240, dockAt: b.devan[0], leaveAt: b.devan[1], mode: 'live', own: b.own });
        }
        const vs = JSON.stringify(visits);
        if (this.visitSig.get(inp.key) === vs) continue;
        this.visitSig.set(inp.key, vs);
        Y.setSiteVisits(inp.key, visits);
      } catch (err) {
        console.warn(`场地 ${inp.key} 没排出来`, err);
      }
    }
  }

  /**
   * 当天的月台作业：每辆车在哪樘门、什么时段靠台（倒车靠上以后）、装还是卸、几板货。
   * resolve 把车辆的停靠地点（DC）换成具体的门（DC#3、DCC#1）；palletsOf 给这一车的托盘数。
   */
  setDay(list: WVehicle[], resolve: (vehicle: number, key: string) => string | undefined, palletsOf: (vid: number) => number | undefined, seed: number, traffic = 1): void {
    drain(this.setDaySteps(list, resolve, palletsOf, seed, traffic, false));
  }

  /**
   * 和 setDay 一样，分几段排（view.ts 换一天的车时）：当天的车、编号，和这一刻的月台门预约、作业编号在调用时就记下，
   * 返回的分段按记下的排（先后、结果都和一口气排完一样）；之后送来的作业编号、预约照样先记下（defer 以后），flush 时重排。
   * lazy：轮到排的时候预约已经又变了，就省掉这一遍（见下面）。
   * Same as setDay, split into steps; inputs are captured when called.
   */
  setDaySteps(list: WVehicle[], resolve: (vehicle: number, key: string) => string | undefined, palletsOf: (vid: number) => number | undefined, seed: number, traffic = 1, lazy = true): Steps {
    this.seed = seed;
    const day = (this.day = { list, resolve, palletsOf, traffic });
    const inp = { bookings: this.bookings, opOf: this.opOf, fac: currentFacilities().dc };
    return this.daySteps(day, inp, seed, lazy);
  }
  private *daySteps(day: ParkDay, inp: Parameters<DcOps['planOf']>[1], seed: number, lazy: boolean): Steps {
    // 分段排、还没轮到这里时月台门预约已经变了（调度台换了一天的计划总是这样）：flush 时计划、月台门上的作业都按新的预约整个重排，
    // 这一遍排出来的全被换掉，省掉（场内的车排轨迹要一秒上下）
    const d = this.deferred;
    if (!(lazy && d?.replan && d.visits && this.day === day)) {
      this.plan = this.planOf(day, inp, seed);
      yield;
      yield* this.pushSteps();
      this.buildVisits();
      yield;
    }
    this.planInside(seed);
  }

  /** 月台门上的作业：仿真车（门上的时段按物流园的计划）、本店的铁路箱在收货门上拆箱 */
  private buildVisits(): void {
    const d = this.day;
    if (!d) return;
    const { list, resolve, palletsOf } = d;
    this.visits = [];
    for (const v of list) {
      v.segs.forEach((sg, si) => {
        if (!sg.place || sg.route || sg.loop) return;
        const key = resolve(v.id, sg.place) ?? sg.place;
        const m = /^DC(C?)#(\d+)$/.exec(key);
        if (!m) return;
        const idx = Number(m[2]) + (m[1] ? this.doors.filter((d) => !d.cold).length : 0);
        if (!this.doors[idx]) return;
        const prev = v.segs[si - 1];
        const dur = sg.t1 - sg.t0;
        const sim = this.plan?.sims.find((x) => x.vid === v.id && x.stop === si);
        // 靠台、拉出的时刻按场地排程（车真的靠稳、做完准备才开始装卸）；甩挂的挂车按园区的计划
        const ytl = sim && !sim.drop ? Yard.siteTimeline(sim.cold ? 'park-cold' : 'park-dc', Yard.simVisitId(v.id, si)) : undefined;
        const dock = ytl ? ytl.unloadAt : sim ? sim.dockAt[0] : sg.t0 + (prev && (prev.route || prev.pts.length > 2) ? Math.min(100, dur * 0.35) : 0);
        const mode: Visit['mode'] = /卸/.test(sg.act ?? '') ? 'unload' : 'load';
        const n = Math.max(4, Math.min(26, Math.round(palletsOf(v.id) ?? (v.kind === 'ev' ? 16 : v.kind === 'drayage' ? 20 : 24))));
        const a0 = dock + 50;
        const a1 = sg.t1 - 70;
        const trip = Math.max(18, Math.min(TRIP * this.forkFactor(list, resolve, dock, sg.t1), (a1 - a0) / n));
        const trips = Array.from({ length: n }, (_, j) => ({ t0: a0 + j * trip, t1: a0 + (j + 1) * trip }));
        const lane = mode === 'load' ? Array.from({ length: n }, (_, j) => dock - 2400 + (j * 2100) / n) : Array.from({ length: n }, (_, j) => sg.t1 + 240 + j * 55);
        const pullAt = ytl?.segs.find((x) => x.kind === 'pullout')?.t0;
        this.visits.push({ door: idx, vid: v.id, label: v.label, t0: sim?.drop ? sim.dockAt[0] - 120 : (ytl?.dockedAt ?? sg.t0), dock, t1: pullAt ?? (sim ? sim.dockAt[1] : sg.t1), mode, pallets: n, trips, lane });
      });
    }
    // 本店的铁路箱：短驳车靠在收货门上，收货员进箱拆箱（托盘进收货暂存道）
    for (const b of this.plan?.boxes ?? []) {
      if (!b.own || !b.devan || !b.door) continue;
      const idx = this.doors.findIndex((x) => x.id === b.door);
      if (idx < 0) continue;
      const [d0, d1] = b.devan;
      const n = b.pallets;
      const trip = Math.max(18, (d1 - 60 - (d0 + 50)) / n);
      const trips = Array.from({ length: n }, (_, j) => ({ t0: d0 + 50 + j * trip, t1: d0 + 50 + (j + 1) * trip }));
      this.visits.push({ door: idx, vid: -1, label: `本店的箱 ${b.id}`, t0: d0 - 80, dock: d0, t1: d1 + 30, mode: 'unload', pallets: n, trips, lane: Array.from({ length: n }, (_, j) => d1 + 240 + j * 55) });
    }
  }

  /** 库内一天的作业：立体库的堆垛机、货到人的机器人（和门上的车无关） */
  private planInside(seed: number): void {
    // 立体库：每台堆垛机一天的复合作业（存一板、取一板），每个循环 95–150 秒
    const r = rng(seed * 17 + 3);
    const [z0, z1] = this.rackZ;
    const downSc = new Set(currentFacilities().dc.down);
    this.cranes = this.aisles.map((_, ai) => {
      const cyc: CraneCycle[] = [];
      if (downSc.has(`SC${ai + 1}`)) return cyc;
      let t = -600 * r();
      while (t < 24 * 3600 + 600) {
        const z1a = z0 + 2 + r() * (z1 - z0 - 6);
        const z2a = z0 + 2 + r() * (z1 - z0 - 6);
        const y1 = FLOOR + 0.25 + Math.floor(r() * 8) * 1.75;
        const y2 = FLOOR + 0.25 + Math.floor(r() * 8) * 1.75;
        const len = 18 + (Math.abs(z1 - z1a) + Math.abs(z1a - z2a) + Math.abs(z2a - z1)) / 4 + 2 * 14;
        cyc.push({ t0: t, t1: t + len, z1: z1a, y1, s1: r() < 0.5 ? -1 : 1, z2: z2a, y2, s2: r() < 0.5 ? -1 : 1 });
        t += len + 4 + r() * 25;
      }
      return cyc;
    });
    // 货到人：每台机器人一天的任务（去货架 → 顶起 → 送到拣选站排队 → 拣完送回原位）；检修中的不排
    const dcCfg = currentFacilities().dc;
    const amrN = Math.max(0, Math.min(60, dcCfg.amrs - dcCfg.down.filter((x) => x.startsWith('AMR')).length));
    this.amrPlan = Array.from({ length: amrN }, (_, k) => {
      const tasks: DcOps['amrPlan'][number] = [];
      let t = -300 * r();
      let at = { ...(this.podSlots[(k * 37) % this.podSlots.length] as { x: number; z: number }) };
      while (t < 24 * 3600 + 300) {
        const pi = Math.floor(r() * this.podSlots.length);
        const ps = this.podSlots[pi] as { x: number; z: number };
        const st = this.stations[k % this.stations.length] as { x: number; z: number };
        const legs: (typeof tasks)[number]['legs'] = [];
        const add = (pts: { x: number; z: number }[], carry: boolean) => {
          const path = new Poly(pts);
          const dt = path.len / 1.6 + 2 * (pts.length - 2) + 3;
          legs.push({ path, t0: t, t1: t + dt, carry });
          t += dt;
        };
        // 在通道里走：先横移到货架旁边的通道，沿通道（z）走到那一行，再横移钻到货架下面
        const lane = (x: number) => {
          const rel = x - this.X0 - 166;
          const pair = Math.floor((rel + 0.6) / 5.6);
          const west = rel - pair * 5.6 < 0.6;
          return this.X0 + 166 + pair * 5.6 + (west ? -2.225 : 3.375);
        };
        add([at, { x: lane(at.x), z: at.z }, { x: lane(at.x), z: ps.z }, { x: ps.x, z: ps.z }], false);
        t += 4;
        add([ps, { x: lane(ps.x), z: ps.z }, { x: lane(ps.x), z: st.z + 0.5 }, { x: st.x, z: st.z + 0.5 }], true);
        const w0 = t;
        t += 35 + r() * 40;
        add([{ x: st.x, z: st.z + 0.5 }, { x: lane(ps.x), z: st.z + 0.5 }, { x: lane(ps.x), z: ps.z }, ps], true);
        tasks.push({ pod: pi, t0: legs[0]?.t0 ?? t, legs, wait: [w0, w0 + (t - w0)] });
        at = { ...ps };
        t += 3 + r() * 20;
      }
      return tasks;
    });
  }

  /**
   * 叉车不够时每一趟要等多久：这一车靠台的时段里同时有几樘门在作业，除以这一班的叉车司机人数（不少于 1）。
   * 司机够（默认）就是 1，一车 44 秒一趟。
   */
  private forkFactor(list: WVehicle[], resolve: (vehicle: number, key: string) => string | undefined, t0: number, t1: number): number {
    const staff = currentFacilities().dc.staff;
    const drivers = Math.max(1, crewOf(staff, 'fork', shiftOf(((t0 / 3600) % 24 + 24) % 24)));
    let busy = 0;
    for (const v of list)
      for (const sg of v.segs) {
        if (!sg.place || sg.route || sg.loop) continue;
        if (!/^DCC?#/.test(resolve(v.id, sg.place) ?? sg.place)) continue;
        if (sg.t0 < t1 && t0 < sg.t1) busy++;
      }
    return Math.max(1, busy / drivers);
  }

  /** 镜头离物流园多远：近了打开屋顶、画库内 */
  private cutaway(camera: THREE.Camera): boolean {
    const { dc } = this.L;
    const p = camera.position;
    const near = Math.hypot(p.x - (dc.x + 100), p.z - (dc.z - 140)) < 560 && p.y < 520;
    this.roofs.visible = !near;
    this.inside.visible = near;
    return near;
  }

  /** planT：现场视图里每辆车按延误平移后的计划时刻（月台门、叉车跟着车走） */
  update(t: number, camera: THREE.Camera, gateBusy: [boolean, boolean], dt: number, planT: (vid: number, t: number) => number | undefined = (_, x) => x, scale = 1): void {
    this.planT = planT;
    const near = this.cutaway(camera);
    void dt;
    // 门口的道闸、库房外面的车：parkYard（仿真车经过门口时抬杆）
    this.yard.setSimGate(gateBusy[0] || gateBusy[1]);
    this.yard.update(t, near, scale);
    for (const p of [this.doorPanels, this.levelers]) p.begin();
    // 月台门：每樘门此刻有没有车靠着
    const active = new Map<number, Visit>();
    for (const vs of this.visits) {
      const tt = this.tv(vs, t);
      if (tt >= vs.t0 && tt < vs.t1 + 30) active.set(vs.door, vs);
    }
    this.doors.forEach((d, i) => {
      const vs = active.get(i);
      const tt = vs ? this.tv(vs, t) : t;
      const open = vs ? Math.min(ease(prog(tt, vs.dock, vs.dock + 10)), 1 - ease(prog(tt, vs.t1 - 25, vs.t1 - 10))) : 0;
      const h = DOOR_H * (1 - open * 0.92);
      this.doorPanels.put(d.x, FLOOR + DOOR_H - h, this.ZS + 0.05, 0, 0, 1, h, 1);
      if (open > 0.5) this.levelers.put(d.x, FLOOR, this.ZS + 0.1, 0, 0, 1, 1, 1);
    });
    for (const p of [this.doorPanels, this.levelers]) p.end();
    if (!near) return;
    for (const p of [this.lifts, this.liftForks, this.pallets, this.stackers, this.carriages, this.amrs, this.pods, this.totes]) p.begin();
    this.drawDocks(t);
    this.drawCranes(t);
    this.drawAmrs(t);
    // 主输送线上的周转箱（0.8 米 / 秒）
    for (let k = 0; k < 80; k++) {
      const s = (t * 0.8 + k * (this.conveyor.len / 80)) % this.conveyor.len;
      const a = this.conveyor.at(s, this.atA);
      if (k % 5 === 3) continue;
      this.totes.put(a.x, FLOOR + 0.93, a.z, a.yaw);
    }
    for (const p of [this.lifts, this.liftForks, this.pallets, this.stackers, this.carriages, this.amrs, this.pods, this.totes]) p.end();
  }

  /** 月台的叉车和暂存道上的托盘 */
  private drawDocks(tNow: number): void {
    const ZS = this.ZS;
    const slot = (d: Door, side: -1 | 1, j: number) => ({ x: d.x + side * (LANE_X[j % 2] as number), z: ZS - LANE_Z0 - Math.floor(j / 2) * LANE_DZ });
    for (const vs of this.visits) {
      const t = this.tv(vs, tNow);
      const d = this.doors[vs.door] as Door;
      const side: -1 | 1 = vs.mode === 'load' ? -1 : 1;
      const tint = d.cold ? '#dbe9f5' : '#ffffff';
      // 暂存道上的托盘
      for (let j = 0; j < vs.pallets; j++) {
        const tr = vs.trips[j] as { t0: number; t1: number };
        const sp = slot(d, side, j);
        let on = false;
        if (vs.mode === 'load') on = t >= (vs.lane[j] as number) && t < tr.t0 + (tr.t1 - tr.t0) * 0.275;
        else on = t >= tr.t0 + (tr.t1 - tr.t0) * 0.725 && t < (vs.lane[j] as number);
        if (on) this.pallets.put(sp.x, FLOOR, sp.z, 0, 0, 1, 1, 1, tint);
      }
      if (t < vs.dock || t >= vs.t1) continue;
      // 叉车：找此刻这一趟
      const k = vs.trips.findIndex((x) => t >= x.t0 && t < x.t1);
      const home = { x: d.x, z: ZS - 3.2 };
      if (k < 0) {
        this.lifts.put(home.x, FLOOR, home.z, -Math.PI / 2);
        this.liftForks.put(home.x, FLOOR + 0.1, home.z, -Math.PI / 2);
        continue;
      }
      const tr = vs.trips[k] as { t0: number; t1: number };
      const f = prog(t, tr.t0, tr.t1);
      const sp = slot(d, side, k);
      const deep = ZS + 4 + (k % 6) * 1.6;
      // 动作：车厢那头（进车厢 → 叉 / 放 → 倒出来）和暂存道那头（倒到这一板所在的位置 → 转 90° → 叉 / 放 → 转回来）
      const south = -Math.PI / 2;
      const faceLane = side > 0 ? 0 : Math.PI;
      const laneZ = sp.z;
      const extra = Math.abs(sp.x - d.x) - FORK;
      let x = d.x;
      let z = home.z;
      let yaw = south;
      let forkY = FLOOR + 0.1;
      let carry = false;
      // 卸货：车厢(0–0.45) → 暂存道(0.45–1)；装车：暂存道(0–0.55) → 车厢(0.55–1)
      const trailer = (g: number, loaded0: boolean) => {
        // g ∈ [0,1]：0–0.4 开进车厢，0.4–0.6 叉 / 放，0.6–1 倒出到门口
        if (g < 0.4) z = lerp(home.z, deep, ease(g / 0.4));
        else if (g < 0.6) z = deep;
        else z = lerp(deep, home.z, ease((g - 0.6) / 0.4));
        const lifted = g < 0.5 ? loaded0 : !loaded0;
        forkY = FLOOR + (g >= 0.4 && g < 0.6 ? 0.1 + 0.1 * Math.sin(((g - 0.4) / 0.2) * Math.PI) : 0.12);
        carry = lifted;
      };
      const lane = (g: number, loaded0: boolean) => {
        // 0–0.3 倒 / 开到这一板对着的位置，0.3–0.45 转向暂存道，0.45–0.55 往前（第二列）+ 叉 / 放 + 退回，0.55–0.7 转回朝南，0.7–1 回到门口
        if (g < 0.3) z = lerp(home.z, laneZ, ease(g / 0.3));
        else if (g < 0.7) z = laneZ;
        else z = lerp(laneZ, home.z, ease((g - 0.7) / 0.3));
        if (g >= 0.3 && g < 0.45) yaw = lerp(south, faceLane > Math.PI / 2 ? -Math.PI : 0, ease((g - 0.3) / 0.15));
        else if (g >= 0.45 && g < 0.55) {
          yaw = faceLane > Math.PI / 2 ? -Math.PI : 0;
          const e = Math.sin(((g - 0.45) / 0.1) * Math.PI);
          x = d.x + side * extra * e;
        } else if (g >= 0.55 && g < 0.7) yaw = lerp(faceLane > Math.PI / 2 ? -Math.PI : 0, south, ease((g - 0.55) / 0.15));
        carry = g < 0.5 ? loaded0 : !loaded0;
        forkY = FLOOR + (g >= 0.45 && g < 0.55 ? 0.12 : 0.15);
      };
      if (vs.mode === 'unload') {
        if (f < 0.45) trailer(f / 0.45, false);
        else lane((f - 0.45) / 0.55, true);
      } else {
        if (f < 0.55) lane(f / 0.55, false);
        else trailer((f - 0.55) / 0.45, true);
      }
      // 车厢里看不见（被挂车挡着），叉车照样画
      this.lifts.put(x, FLOOR, z, yaw);
      this.liftForks.put(x, forkY, z, yaw);
      if (carry) this.pallets.put(x + Math.cos(yaw) * FORK, forkY + 0.04, z - Math.sin(yaw) * FORK, yaw, 0, 1, 1, 1, tint);
    }
  }

  /** 立体库的堆垛机：在巷道里走、载货台升降、货叉伸进两侧货架 */
  private drawCranes(t: number): void {
    const [z0, z1] = this.rackZ;
    const io = z1 + 1.2;
    const yIo = FLOOR + 0.9;
    this.aisles.forEach((ax, i) => {
      const cyc = (this.cranes[i] ?? []).find((c) => t >= c.t0 && t < c.t1);
      let z = io;
      let y = yIo;
      let fork = 0;
      let carry = false;
      if (cyc) {
        // 0 巷道口叉起入库托盘 → 1 走到货位 1 → 2 伸叉放下 → 3 走到货位 2 → 4 伸叉取出 → 5 回巷道口放到出库输送线
        const T = cyc.t1 - cyc.t0;
        const e = t - cyc.t0;
        const tr1 = Math.abs(cyc.z1 - io) / 4 + 3;
        const tr2 = Math.abs(cyc.z2 - cyc.z1) / 4 + 3;
        const tr3 = Math.abs(io - cyc.z2) / 4 + 3;
        const fk = (T - tr1 - tr2 - tr3) / 3;
        const k = [fk, fk + tr1, 2 * fk + tr1, 2 * fk + tr1 + tr2, 3 * fk + tr1 + tr2, T];
        if (e < (k[0] as number)) {
          fork = Math.sin((e / fk) * Math.PI) * 1.4;
          carry = e > fk / 2;
        } else if (e < (k[1] as number)) {
          const g = ease((e - (k[0] as number)) / tr1);
          z = lerp(io, cyc.z1, g);
          y = lerp(yIo, cyc.y1, g);
          carry = true;
        } else if (e < (k[2] as number)) {
          z = cyc.z1;
          y = cyc.y1;
          const g = (e - (k[1] as number)) / fk;
          fork = Math.sin(g * Math.PI) * 2.3 * cyc.s1;
          carry = g < 0.5;
        } else if (e < (k[3] as number)) {
          const g = ease((e - (k[2] as number)) / tr2);
          z = lerp(cyc.z1, cyc.z2, g);
          y = lerp(cyc.y1, cyc.y2, g);
        } else if (e < (k[4] as number)) {
          z = cyc.z2;
          y = cyc.y2;
          const g = (e - (k[3] as number)) / fk;
          fork = Math.sin(g * Math.PI) * 2.3 * cyc.s2;
          carry = g > 0.5;
        } else {
          const g = ease((e - (k[4] as number)) / tr3);
          z = lerp(cyc.z2, io, g);
          y = lerp(cyc.y2, yIo, g);
          carry = true;
        }
      }
      void z0;
      this.stackers.put(ax, FLOOR, z, Math.PI / 2);
      this.carriages.put(ax, y, z, Math.PI / 2);
      if (carry) this.pallets.put(ax + fork, y, z, 0, 0, 1, 1, 1, '#f3efe4');
    });
  }

  /** 货到人：机器人沿通道走，顶着货架去拣选站、再送回原位；其余货架停在格位上 */
  private drawAmrs(t: number): void {
    const moved = new Set<number>();
    for (const tasks of this.amrPlan) {
      const task = tasks.find((x) => t >= x.t0 && t < (x.legs[x.legs.length - 1]?.t1 ?? x.t0));
      if (!task) continue;
      const leg = task.legs.find((l) => t >= l.t0 && t < l.t1);
      let x: number;
      let z: number;
      let yaw = 0;
      let carry = false;
      if (leg) {
        const a = leg.path.at(leg.path.len * ease(prog(t, leg.t0, leg.t1)), this.atA);
        x = a.x;
        z = a.z;
        yaw = a.yaw;
        carry = leg.carry;
      } else {
        // 在货架下顶升 / 在拣选站排队
        const prev = [...task.legs].reverse().find((l) => l.t1 <= t);
        const e = prev?.path.at(prev.path.len) ?? (this.podSlots[task.pod] as { x: number; z: number });
        x = e.x;
        z = e.z;
        carry = !!prev?.carry || t >= task.wait[0];
      }
      this.amrs.put(x, FLOOR, z, yaw);
      if (carry) {
        moved.add(task.pod);
        this.pods.put(x, FLOOR + 0.42, z, 0);
      }
    }
    this.podSlots.forEach((s, i) => {
      if (!moved.has(i)) this.pods.put(s.x, FLOOR, s.z, 0);
    });
  }

  /** 设施管理台的指标：靠台车次和平均靠台时间、叉车等待、立体库和机器人的作业量 */
  kpi(): { label: string; value: string; bad?: boolean }[] {
    const v = this.visits;
    const out: { label: string; value: string; bad?: boolean }[] = [];
    const dwell = v.map((x) => (x.t1 - x.dock) / 60);
    out.push({ label: '靠台车次（装车 / 卸货）', value: `${v.filter((x) => x.mode === 'load').length} / ${v.filter((x) => x.mode === 'unload').length}，${v.reduce((a, x) => a + x.pallets, 0)} 板` });
    out.push({ label: '平均靠台时间', value: `${(dwell.reduce((a, b) => a + b, 0) / Math.max(1, dwell.length)).toFixed(0)} 分钟 / 车` });
    const slow = v.filter((x) => x.trips.length && (x.trips[0] as { t1: number; t0: number }).t1 - (x.trips[0] as { t0: number }).t0 > 44.5).length;
    out.push({ label: '叉车不够要等的车次', value: `${slow} 车`, bad: slow > 0 });
    out.push({ label: '开放的月台门（干货 / 冷链）', value: `${DOORS.dry.length} / ${DOORS.cold.length} 樘` });
    out.push({ label: '立体库', value: `${this.cranes.filter((c) => c.length).length} 台堆垛机在用，${this.cranes.reduce((a, c) => a + c.length, 0)} 个复合作业 / 天` });
    out.push({ label: '货到人', value: `${this.amrPlan.length} 台机器人，${this.amrPlan.reduce((a, x) => a + x.length, 0)} 次搬货架 / 天` });
    const k = (key: string) => this.plan?.hub.kpi.find((x) => x.key === key);
    const own = k('ownBoxes');
    if (own) out.push({ label: '本店铁路箱短驳进收货门', value: `${own.value} 箱，落地后平均 ${Math.round(k('ownToDc')?.value ?? 0)} 分钟进门` });
    const hold = k('holdMax');
    if (hold) out.push({ label: '待命停车场（最多 / 最长等门）', value: `${Math.round(k('holdPeak')?.value ?? 0)} 车 / ${Math.round(hold.value)} 分钟`, bad: hold.value > 120 });
    const tl = k('tlPallets');
    if (tl) out.push({ label: '铁路转运仓过库', value: `${tl.value} 板，场内牵引车 ${k('shunts')?.value ?? 0} 趟` });
    return out;
  }

  /** 物流园监控面板：每樘门此刻的车、装 / 卸进度，暂存道，立体库、机器人的工作量 */
  info(t: number): {
    doors: { id: string; cold: boolean; open: boolean; vid?: number; label?: string; mode?: string; done?: number; n?: number; since?: number; until?: number; next?: { label: string; t: number; mode: string } }[];
    staged: { out: number; in: number };
    cranesBusy: number;
    cranes: number;
    amrBusy: number;
    amrTotal: number;
    trucksToday: { load: number; unload: number; pallets: number };
    yard?: ParkYardInfo;
  } {
    let out = 0;
    let inn = 0;
    const doors = this.doors.map((d, i) => {
      const vs = this.visits.find((x) => x.door === i && t >= x.t0 && t < x.t1);
      const next = this.visits.filter((x) => x.door === i && x.t0 > t).sort((a, b) => a.t0 - b.t0)[0];
      for (const x of this.visits) {
        if (x.door !== i) continue;
        for (let j = 0; j < x.pallets; j++) {
          const tr = x.trips[j] as { t0: number; t1: number };
          if (x.mode === 'load' && t >= (x.lane[j] as number) && t < tr.t0) out++;
          if (x.mode === 'unload' && t >= tr.t1 && t < (x.lane[j] as number)) inn++;
        }
      }
      return {
        id: d.id,
        cold: d.cold,
        open: (d.cold ? DOORS.cold : DOORS.dry).includes(d.id),
        ...(vs ? { vid: vs.vid, label: vs.label, mode: vs.mode === 'load' ? '装车' : '卸货', done: vs.trips.filter((x) => x.t1 <= t).length, n: vs.pallets, since: vs.dock, until: vs.t1 } : {}),
        ...(next ? { next: { label: next.label, t: next.t0, mode: next.mode === 'load' ? '装车' : '卸货' } } : {}),
      };
    });
    const cranesBusy = this.cranes.filter((c) => c.some((x) => t >= x.t0 && t < x.t1)).length;
    const amrBusy = this.amrPlan.filter((tasks) => tasks.some((x) => t >= x.t0 && t < (x.legs[x.legs.length - 1]?.t1 ?? 0))).length;
    const day = this.visits;
    void this.seed;
    const yard = this.yard.info(t);
    return { doors, staged: { out, in: inn }, cranesBusy, cranes: this.cranes.filter((c) => c.length).length, amrBusy, amrTotal: this.amrPlan.length, trucksToday: { load: day.filter((x) => x.mode === 'load' && x.vid >= 0).length, unload: day.filter((x) => x.mode === 'unload' && x.vid >= 0).length, pallets: day.reduce((s, x) => s + x.pallets, 0) }, ...(yard ? { yard } : {}) };
  }
}
