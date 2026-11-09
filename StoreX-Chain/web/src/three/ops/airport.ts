import * as THREE from 'three';
import { isNight, Lamps, type LampState } from './lamps';
import type { LampSpec } from '../fleet';
import { box, cyl, merge, wheel, type Part } from '../../../../../StoreX/web/src/three/models';
import type { WVehicle } from '../../../../src/sim/trace';
import { clamp01, cruise, drain, ease, leadIn, lerp, Poly, Pool, prog, rng, rounded, STORE_BOX, type At, type Steps } from './kit';
import { currentFacilities } from '../../../../src/facility/state';
import { crewOf, shiftOf, type Role } from '../../../../src/facility/config';
import { AIR_YARD, applyYardTimes, LANE_Z as TLANE_Z, PITCH as TPITCH, planAirTerminal, registerLandsideYard, terminalLayout, type AirTermPlan, type AirTermInput, type TermLayout } from '../../../../src/hub/airport';
import type { HubDay } from '../../../../src/hub/types';
import { FRAMES } from '../../../../src/region/region';
import { scheduleYard, setSiteVisits, simVisitFor, simVisitId, siteSchedule, type YardFrame, type YardPlan, type YardSchedule, type YardVehicle, type YardVisit } from '@storewright/yard';
import { AirTerminal, type TermInfo } from './airTerminal';

/**
 * 机场货运区（按真实尺寸画，局部坐标：跑道沿 x，货站在 −z 一侧；区域生成器整体平移、旋转进区域，这里不用区域坐标）：
 * 一条 2100 米的跑道（入口标志、接地区、瞄准点、中线、边灯、进近灯、坡度指示灯）、平行滑行道和三条联络道
 * （两条脱离道 E0、E1，一条起飞联络道 D）、按设施配置排的 2–6 个货机机位（机位多了机坪和货站一起往 +x 加长）、塔台、助航灯。
 *
 * 一天的航班：仿真里本店的货运航班（接地、撤轮挡的时刻照仿真），加上其他货运航班（三种机型，按机位数和负荷档位排满全天）。
 * 跑道 A 端（+x 一头）进近和起飞，都朝 −x 方向：
 * - 进场：转弯切入航向道（压坡度）、沿 3° 下滑道进近、拉平、主轮接地（机头上仰）、放前轮、扰流板升起、反推减速，
 *   从脱离道 E1（中段）或 E0（跑道 B 端）两个 90° 转弯上平行滑行道，往 +x 滑到机位前转进机位，停到停止线；
 * - 机位上：挡轮挡、接电源车，主货舱门打开，升降平台车靠上舱门，集装板一块块卸下来、板车串拉去货站；卸完换装出口的板；
 *   加油车开到机翼下加油；关舱门、平台车撤走，推出车顶着前轮把飞机推到滑行道上（机头转向 +x）、启动发动机、脱开推出车；
 * - 离场：沿平行滑行道滑到 A 端的等待位置，跑道空了进跑道对正，起飞滑跑（加速）、抬头离地、收起落架、爬升、压坡度转弯离开。
 * 跑道一次只给一架飞机用（落地的脱离了才能起飞、起飞的飞过跑道头才能落地，前后两架隔开尾流间隔）；
 * 平行滑行道单向（往 +x），按时空占用排：推出、滑入、滑出不会撞上，机位一个时段只停一架。速度都有加减速，转弯按转弯半径限速。
 * 本店的板（蓝色）单独跟踪：在飞机上 → 板车 → 货站拆板 → 进冷库等空运冷藏车。
 *
 * 货站是机场自己的仓储中心（ops/airTerminal.ts 画，src/hub/airport.ts 排计划）：所有进出口的板都从空侧板车门进出货站，
 * 存进 ETV 升降式板架、在工位拆板 / 组板，散货进普货货架、冷藏库、冷冻库、危险品库、贵重品库或海关查验区，
 * 再从陆侧收货口装上货代的车（出口反过来，组板前先过安检）；整板提货、整板送来的走整板转运道。
 * 板车串把板推进门（进来的那条滚轮道）的时刻、从门里拉出板（出去的那条滚轮道）的时刻就是货站计划的输入。
 */

const H = 3600;
// —— 布局（局部坐标，沙盘米） ——
const RW_Z = 1285;
const RW_X0 = 1080;
const RW_X1 = 3180;
/** 平行滑行道中线：离跑道中线 100 米 */
const TW_Z = 1185;
/** 跑道 A 端的入口、下滑道瞄准点、接地点（落地都朝 −x） */
const THR_X = RW_X1 - 30;
const AIM_X = THR_X - 300;
const TD_X = THR_X - 420;
/** 脱离道：E0 在跑道 B 端、E1 在中段；起飞联络道 D 在 A 端 */
const EXITS = [RW_X0 + 60, 1480];
const DEP_X = RW_X1 - 50;
const TURN_R = 45;
const STAND_R = 40;
/** 起飞前在滑行道上等待的位置（机身中心）、对正后的起飞位置 */
const HOLD_X = DEP_X - TURN_R - 60;
const LU_X = DEP_X - TURN_R - 25;
const GS = Math.tan((3 * Math.PI) / 180);
const DEG = Math.PI / 180;
/** 货站：陆侧收货口 z = 985、空侧大门 z = 1055；一期 x 1980–2250，机位多了往 +x 接二期 */
const TERM = { x0: 1980, x1: 2250, zLand: 985, zAir: 1055 };
/** 机位停止线（机头停在这里）、货站门前的行车道、机尾后面的服务车道 */
const NOSE_Z = 1072;
const LANE_Z = TERM.zAir + 6;
const TAIL_Z = 1143;
const STAND_X0 = 2030;
const STAND_SP = 92;
/** 道面顶的高度：飞机和地面车辆都放在这上面 */
const PAVE = 0.36;
/** 推出后机身中心在机位中线 −x 多远 */
const PUSH_BACK = 60;
/** 推出后启动发动机、脱开推出车的时间（秒） */
const START = 90;
/** 滑行道占用按 2 秒一格采样 */
const OG = 2;
/** 机位上的地面作业：平台车面高、板车面高、平台厚 */
const LOADER_TOP = 0.57;
const DOLLY_TOP = 1.0;
const PLAT_T = 0.4;
/** 一块板过平台车的时间（舱门 ↔ 板车）、每块的节拍、卸完换装的时间、货站门口 4 块板推进 / 推出的时间 */
const XFER = 95;
const CYCLE = 175;
const SWITCH = 240;
const DOCK = 200;
/** 板车路线前面的引入段（米） */
const LEAD = 30;
/** 货站门口被别的套板车占着：在门口前多远等（一套板车 19 米长，留 3 米） */
const DOOR_Q = 22;
const BED_Z = TERM.zAir + 2;
/** 门里滚轮道靠门的那个位置（货站计划从这里接手：进口板推到这里、出口板从这里拉出去） */
const LANE_IN_Z = TLANE_Z[TLANE_Z.length - 1] as number;
const OWN_LIVERY = '#2a78d6';
/** 热循环里用的常量数组（每帧不分配） */
const SIDES = [1, -1] as const;
const SCISSOR_DX = [-1.5, 1.5] as const;
const LIVERIES = ['#c0392b', '#1e8449', '#5d6d7e', '#d35400', '#7d3c98', '#117a65', '#b7950b', '#2e4053'];

// —— 机型 ——
type KindKey = 'heavy' | 'wide' | 'medium';
interface Kind {
  key: KindKey;
  name: string;
  /** 机身长度相对基准（68 米）的比例、机身半径、翼展、发动机台数 */
  fx: number;
  rad: number;
  span: number;
  eng: 2 | 4;
  /** 进近、接地速度，着陆滑跑的减速度；抬头、离地速度，起飞加速度，初始爬升角（度） */
  vApp: number;
  vTd: number;
  aRoll: number;
  vR: number;
  vLof: number;
  aTo: number;
  climb: number;
  /** 主舱板位、过站小时、加油分钟 */
  ulds: number;
  ground: [number, number];
  fuel: number;
}
const KINDS: Kind[] = [
  { key: 'heavy', name: '四发重型货机', fx: 1.08, rad: 3.35, span: 68, eng: 4, vApp: 74, vTd: 70, aRoll: 1.9, vR: 77, vLof: 81, aTo: 2.2, climb: 5.5, ulds: 30, ground: [2.6, 3.6], fuel: 50 },
  { key: 'wide', name: '双发宽体货机', fx: 1, rad: 3.1, span: 65, eng: 2, vApp: 71, vTd: 67, aRoll: 2.0, vR: 75, vLof: 79, aTo: 2.3, climb: 6.5, ulds: 26, ground: [2.2, 3.2], fuel: 40 },
  { key: 'medium', name: '双发中型货机', fx: 0.8, rad: 2.6, span: 48, eng: 2, vApp: 67, vTd: 63, aRoll: 2.1, vR: 71, vLof: 75, aTo: 2.45, climb: 7, ulds: 18, ground: [1.6, 2.5], fuel: 30 },
];
/** 本店的航班是双发宽体货机 */
const OWN_KIND = 1;

/** 每种机型在机身坐标里的尺寸（机头 +x，左侧 −z，原点在机身中心的地面） */
interface KGeo {
  k: Kind;
  q: number;
  fs: number;
  yc: number;
  nose: number;
  ext: number;
  doorX: number;
  sill: number;
  doorW: number;
  doorH: number;
  gearX: number;
  mainX: number;
  mains: number[];
  /** 平台车（机身左侧的 z）：前平台、底盘、后平台、板车 */
  front: number;
  base: number;
  rear: number;
  wait: number;
  /** 加油车停的位置（机翼下）、加油口 */
  fuelZ: number;
  fuelX: number;
  wingBot: number;
  semi: number;
  /** 翼尖前缘 x、翼尖 z */
  tipX: number;
  /** 右侧襟翼、扰流板：铰链中点、长度、铰链线方向 */
  flap: { x: number; y: number; z: number; len: number; beta: number };
  spoil: { x: number; y: number; z: number; len: number; beta: number };
  /** 着陆后从哪条脱离道出去（0 = E0，1 = E1） */
  exit: number;
  /** 发动机短舱（风扇面中心，两侧都列）和半径 */
  engines: { x: number; y: number; z: number; r: number }[];
}
/** 发动机的位置（四发的外侧那台更靠后、小一点） */
function engineList(k: Kind): { x: number; z: number; s: number }[] {
  const fx = k.fx;
  const fs = k.span / 65;
  return k.eng === 4 ? [{ x: 5.2 * fx, z: 10.5 * fs, s: 0.82 }, { x: 5.2 * fx - 15 * fs * 0.6 + 1.2, z: 19 * fs, s: 0.78 }] : [{ x: 4.2 * fx, z: 9.6 * fs, s: 1 }];
}
function kgeo(k: Kind): KGeo {
  const q = k.rad / 3.1;
  const fs = k.span / 65;
  const fx = k.fx;
  const semi = 30 * fs;
  const wingY = k.rad + 1.5 * q;
  const teRoot = -7 * fx;
  const teTip = 2.5 * fx - 15 * fs;
  const te = (z: number) => teRoot + ((teTip - teRoot) * z) / semi;
  const le = (z: number) => 6 * fx - (15 * fs * z) / semi;
  const fz = k.eng === 4 ? 19 * fs + 1.75 * q * 0.78 + 2.4 : k.rad + 18;
  const z0 = k.rad + 0.5;
  const z1 = semi * 0.6;
  const beta = Math.atan2(te(z1) - te(z0), z1 - z0);
  const sz0 = semi * 0.2;
  const sz1 = semi * 0.58;
  // 着陆滑跑：按减速度减到 13 米/秒，再减到转弯速度，留 30 米余量，够得着 E1 就走 E1
  const need = (k.vTd * k.vTd - 169) / (2 * k.aRoll) + (169 - 29) / 2.4 + 30;
  return {
    k,
    q,
    fs,
    yc: 2 * k.rad,
    nose: 32 * fx,
    ext: Math.max(69 * fx, k.span),
    doorX: -12 * fx,
    sill: 1.645 * k.rad,
    doorW: 3.7 * Math.max(0.92, q),
    doorH: 3.05 * q,
    gearX: 24 * fx,
    mainX: -2 * fx,
    mains: k.eng === 4 ? [-2.9 * q, -1.2 * q, 1.2 * q, 2.9 * q] : [-2.7 * q, 2.7 * q],
    front: -k.rad - 2.0,
    base: -k.rad - 4.75,
    rear: -k.rad - 7.65,
    wait: -k.rad - 12.0,
    fuelZ: -fz,
    fuelX: (le(fz) + te(fz)) / 2,
    wingBot: wingY - 0.55 * q,
    semi,
    tipX: le(semi),
    flap: { x: (te(z0) + te(z1)) / 2, y: wingY - 0.2 * q, z: (z0 + z1) / 2, len: (z1 - z0) / Math.cos(beta), beta: -beta },
    spoil: { x: (te(sz0) + te(sz1)) / 2 + 3.0 * fx, y: wingY + 0.55 * q, z: (sz0 + sz1) / 2, len: (sz1 - sz0) / Math.cos(beta), beta: -beta },
    exit: need <= TD_X - (EXITS[1] as number) - TURN_R ? 1 : 0,
    engines: engineList(k).flatMap((e) => {
      const r = 1.75 * q * e.s;
      const y = wingY - 0.55 * q - r * 0.7;
      return [1, -1].map((side) => ({ x: e.x + 3.4 * q * e.s, y, z: e.z * side, r }));
    }),
  };
}
const KG: KGeo[] = KINDS.map(kgeo);
const kg = (i: number): KGeo => KG[i] as KGeo;

/** 布局：机位、每个机位对着的货站大门、机坪和货站的范围 */
interface Layout {
  n: number;
  sx: number[];
  dock: number[];
  ax0: number;
  ax1: number;
  tx1: number;
  doors: number[];
}
function layoutFor(stands: number): Layout {
  const n = Number.isFinite(stands) ? Math.max(2, Math.min(6, Math.round(stands))) : 2;
  const sx = Array.from({ length: n }, (_, i) => STAND_X0 + i * STAND_SP);
  const last = sx[n - 1] as number;
  const dock = sx.map((x) => x + 18);
  const tx1 = n <= 3 ? TERM.x1 : last + 38;
  const doors: number[] = [];
  for (let x = (dock[0] as number) - 46; x <= tx1 - 12; x += 23) if (x >= TERM.x0 + 12) doors.push(x);
  return { n, sx, dock, ax0: (sx[0] as number) - 56, ax1: Math.max(tx1 + 20, last + 116), tx1, doors };
}
const standName = (i: number): string => `${i + 1} 号机位`;

/**
 * 货代的车在陆侧收货口的一次装卸（货站计划排的，区域车辆层画整趟车，ops/extTrucks.ts）：
 * 哪个收货口、预约的时刻（plan）、实际靠上和离开的时刻（收货口没空就晚一点，先在等候区、待命车道等）、是不是冷藏挂车
 */
export interface DockVisit {
  dock: number;
  plan: number;
  t0: number;
  t1: number;
  reefer: boolean;
  /** 到场的时刻（排队从这时起）、车型（整板卡车、半挂车、厢式货车、面包车）、提货还是送货、车的说明 */
  arrive?: number;
  kind?: 'semi' | 'reefer' | 'truck' | 'van' | 'uld';
  dir?: 'pickup' | 'delivery';
  label?: string;
  /** 场内时刻表里的编号（yard.sched 的 visit.id） */
  id?: string;
}

const ix = (a: ArrayLike<number>, i: number): number => a[i] as number;
const wrapA = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.08, ...o });
const clk = (t: number): string => {
  const m = Math.round((((t / 60) % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// —— 模型 ——
/** 横放的圆柱（沿 x）：rTop 在 +x 一头；y 是轴的高度 */
function hcyl(rTop: number, rBot: number, len: number, color: string, x: number, y: number, z: number, seg = 18): Part {
  return cyl(rTop, rBot, len, color, 0, -len / 2, 0, seg).rotateZ(-Math.PI / 2).translate(x, y, z);
}
function paintAll(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}
/** 后掠的翼面 */
function wing(c0: number, c1: number, span: number, sweep: number, th: number, color: string, x: number, y: number, side: 1 | -1): Part {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(-sweep, span * side);
  s.lineTo(-sweep - c1, span * side);
  s.lineTo(-c0, 0);
  s.lineTo(0, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: th, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(x, y - th / 2, 0);
  return paintAll(g, color);
}
/**
 * 货机（按机型的尺寸）：机身、机头和风挡、机翼和襟翼滑轨整流罩、两台或四台发动机（风扇面、尾喷、挂架）、平尾；
 * gear = 是否放下起落架。腰线和垂尾在涂装里画（按航空公司上色，不画任何公司的标志），主货舱门单独画（会打开）。
 */
function freighterGeo(k: Kind, gear: boolean): THREE.BufferGeometry {
  const fx = k.fx;
  const r = k.rad;
  const q = r / 3.1;
  const fs = k.span / 65;
  const yc = 2 * r;
  const W = '#f4f4f1';
  const G = '#e3e4e1';
  const wingY = r + 1.5 * q;
  const p: Part[] = [
    hcyl(r, r, 46 * fx, W, 0, yc, 0),
    hcyl(0.7 * q, r, 9 * fx, W, 27.5 * fx, yc, 0),
    hcyl(r, 0.75 * q, 13 * fx, W, -29.5 * fx, yc + 0.7 * q, 0),
    box(2.2 * fx, 0.6 * q, 2.9 * q, '#1d2a38', 28.2 * fx, yc + 0.95 * q, 0),
    // 机腹整流罩、主货舱门的门洞（门打开以后露出来）、前后下货舱门（右侧）
    box(22 * fx, 0.6 * q, 3.3 * q, '#e6e7e4', -1 * fx, r - 0.12, 0),
    box(3.7 * Math.max(0.92, q), 3.05 * q, 0.06, '#23272d', -12 * fx, 1.645 * r, -r - 0.02),
    box(2.4 * q, 1.7 * q, 0.06, '#c9cdd1', 15 * fx, yc - 3.0 * q, r + 0.02),
    box(2.4 * q, 1.7 * q, 0.06, '#c9cdd1', -16 * fx, yc - 3.0 * q, r + 0.02),
    wing(13 * fx, 3.5 * fx, 30 * fs, 15 * fs, 1.1 * q, G, 6 * fx, wingY, 1),
    wing(13 * fx, 3.5 * fx, 30 * fs, 15 * fs, 1.1 * q, G, 6 * fx, wingY, -1),
    wing(6 * fx, 2.2 * fx, 10.5 * fs, 5.5 * fs, 0.5 * q, G, -27 * fx, yc + 1.2 * q, 1),
    wing(6 * fx, 2.2 * fx, 10.5 * fs, 5.5 * fs, 0.5 * q, G, -27 * fx, yc + 1.2 * q, -1),
  ];
  // 发动机：短舱、风扇面、尾喷、挂架
  const engs = engineList(k);
  const wingBot = wingY - 0.55 * q;
  for (const e of engs)
    for (const side of [1, -1]) {
      const z = e.z * side;
      const er = 1.75 * q * e.s;
      const ey = wingBot - er * 0.7;
      const L = 6.8 * q * e.s;
      p.push(hcyl(er, er * 0.92, L, '#b3b8be', e.x, ey, z), hcyl(er * 0.83, er * 0.83, 0.2, '#2d2f33', e.x + L / 2 + 0.02, ey, z), hcyl(er * 0.46, er * 0.63, 1.4 * e.s, '#6f757c', e.x - L / 2 - 0.6, ey, z), box(4.4 * e.s * q, wingBot - ey - er * 0.5 + 0.3, 0.5 * q, '#d9dcdf', e.x - 0.8, ey + er * 0.5, z));
    }
  // 襟翼滑轨整流罩（挂在后缘下面，往后伸出一点）
  const teRoot = -7 * fx;
  const teTip = 2.5 * fx - 15 * fs;
  for (const zz of [13, 19, 24]) for (const side of [1, -1]) p.push(box(3.6 * fx, 0.55 * q, 0.45 * q, '#d0d3d6', teRoot + ((teTip - teRoot) * zz) / 30 - 0.6 * fx, wingBot - 0.25 * q, zz * fs * side));
  if (gear) {
    const wr = 0.72 * q;
    const nr = 0.6 * q;
    p.push(box(0.4 * q, 1.09 * r + 0.3 - nr, 0.4 * q, '#5b6067', 24 * fx, nr, 0), wheel(nr, 0.5 * q, '#1d1d1d', 24 * fx, nr, 0.35 * q), wheel(nr, 0.5 * q, '#1d1d1d', 24 * fx, nr, -0.35 * q));
    const mains = k.eng === 4 ? [-2.9 * q, -1.2 * q, 1.2 * q, 2.9 * q] : [-2.7 * q, 2.7 * q];
    for (const z of mains) {
      const gx = (Math.abs(z) < 2 * q ? -5 : -2) * fx;
      p.push(box(0.6 * q, r - wr + 0.3, 0.6 * q, '#5b6067', gx, wr, z), box(4.6 * q, 0.4 * q, 0.5 * q, '#5b6067', gx, wr - 0.2 * q, z));
      const axles = k.key === 'medium' ? [-0.8, 0.8] : k.eng === 4 ? [-1.0, 1.0] : [-1.6, 0, 1.6];
      for (const ax of axles) for (const dz of [-0.55 * q, 0.55 * q]) p.push(wheel(wr, 0.5 * q, '#1d1d1d', gx + ax * q, wr, z + dz));
    }
  }
  return merge(p);
}
/** 涂装：垂尾、机身腰线、发动机进气口的一圈（顶点色白，按航空公司的颜色给实例上色） */
function liveryGeo(k: Kind): THREE.BufferGeometry {
  const fx = k.fx;
  const r = k.rad;
  const q = r / 3.1;
  const fs = k.span / 65;
  const yc = 2 * r;
  const fin = new THREE.Shape();
  fin.moveTo(0, 0);
  fin.lineTo(-7 * fx, 11 * q);
  fin.lineTo(-11 * fx, 11 * q);
  fin.lineTo(-9.5 * fx, 0);
  fin.lineTo(0, 0);
  const finGeo = paintAll(new THREE.ExtrudeGeometry(fin, { depth: 0.6 * q, bevelEnabled: false }), '#ffffff');
  finGeo.translate(-26 * fx, yc + 2.2 * q, -0.3 * q);
  const p: Part[] = [finGeo, box(52 * fx, 0.45 * q, 2 * r + 0.1, '#ffffff', -2 * fx, yc - 0.8 * q, 0)];
  const engs = engineList(k);
  const wingBot = r + 1.5 * q - 0.55 * q;
  for (const e of engs)
    for (const side of [1, -1]) {
      const er = 1.75 * q * e.s;
      p.push(hcyl(er * 1.02, er * 1.02, 0.7 * q, '#ffffff', e.x + 3.4 * q * e.s - 0.35, wingBot - er * 0.7, e.z * side));
    }
  return merge(p);
}
/** 主货舱门（宽 3.7、高 3.05 米，按机型缩放）：原点在门的上沿（铰链），门板往下；内侧的加强框 */
function cargoDoor(): THREE.BufferGeometry {
  return merge([box(3.7, 3.05, 0.22, '#e9eae7', 0, -3.05, 0), box(3.5, 0.14, 0.3, '#9aa0a6', 0, -0.35, 0.1), box(3.5, 0.14, 0.3, '#9aa0a6', 0, -2.8, 0.1), ...[-1.6, 0, 1.6].map((x) => box(0.12, 2.6, 0.3, '#9aa0a6', x, -2.85, 0.1))]);
}
/** 襟翼（弦长 2.4 米、长 1 米，按实例拉长）：原点在铰链线中点，往 −x 伸出去 */
function flapGeo(): THREE.BufferGeometry {
  return merge([box(2.4, 0.22, 1, '#d6d8d5', -1.2, -0.11, 0)]);
}
/** 扰流板（弦长 1.8 米）：原点在前缘（铰链）中点 */
function spoilerGeo(): THREE.BufferGeometry {
  return merge([box(1.8, 0.1, 1, '#c9ccc9', -0.9, 0, 0)]);
}
/**
 * 主货舱升降平台车（长 11 米）：低底盘（面高 0.57 米）、前端防撞条、车尾侧面的驾驶室、四个支腿；
 * 原点在底盘中心的地面，车头（前平台那头）朝 +x。前后两块平台和剪叉另画（会升降）。
 */
function loaderBase(): THREE.BufferGeometry {
  const Y = '#f0c419';
  return merge([
    box(11, 0.35, 3.3, Y, 0, 0.22, 0),
    box(0.35, 0.45, 3.3, '#2b2f35', 5.6, 0.2, 0),
    box(2.0, 0.3, 1.3, Y, -4.2, 0.27, 2.35),
    box(1.7, 1.25, 1.15, '#3d4650', -4.2, 0.57, 2.35),
    box(1.7, 0.75, 1.15, '#bcd3e6', -4.2, 1.82, 2.35),
    box(1.8, 0.1, 1.25, '#3d4650', -4.2, 2.57, 2.35),
    ...[-4.7, 4.7].flatMap((x) => [wheel(0.3, 0.3, '#1d1d1d', x, 0.3, 1.45), wheel(0.3, 0.3, '#1d1d1d', x, 0.3, -1.45)]),
    ...[-5.2, 5.2].flatMap((x) => [box(0.3, 0.22, 0.3, '#5b6067', x, 0, 1.85), box(0.3, 0.22, 0.3, '#5b6067', x, 0, -1.85)]),
  ]);
}
/** 平台（长 4.2、宽 3.5 米，面上一排滚轮、两侧导轨）：原点在平台底面中心；后平台按 1.19 倍拉长 */
function platform(): THREE.BufferGeometry {
  const L = 4.2;
  const parts = [box(L, PLAT_T - 0.05, 3.5, '#c9cdd1', 0, 0, 0), box(L, 0.5, 0.12, '#f0c419', 0, PLAT_T, 1.75), box(L, 0.5, 0.12, '#f0c419', 0, PLAT_T, -1.75)];
  for (let x = -L / 2 + 0.25; x < L / 2 - 0.1; x += 0.42) parts.push(cyl(0.07, 0.07, 3.3, '#8a9096', 0, -1.65, 0, 6).rotateX(Math.PI / 2).translate(x, PLAT_T - 0.05, 0));
  return merge(parts);
}
/** 航空集装板（PMC，底板 3.18 × 2.44 米，货堆成轮廓、罩着网） */
function uld(): THREE.BufferGeometry {
  return merge([box(3.18, 0.1, 2.44, '#b8bcc0', 0, 0, 0), box(3.0, 1.55, 2.3, '#ffffff', 0, 0.1, 0), box(2.6, 0.55, 2.3, '#ffffff', 0, 1.65, 0), box(3.04, 0.06, 2.34, '#4a4f55', 0, 0.9, 0), box(0.06, 2.0, 2.34, '#4a4f55', 0, 0.1, 0), box(3.04, 0.06, 0.06, '#4a4f55', 0, 2.2, 0)]);
}
/** 板车（集装板拖车）：车面一排滚轮、面高 1.0 米、两头挡板、前端拖杆 */
function dolly(): THREE.BufferGeometry {
  const parts = [box(3.6, 0.32, 2.7, '#8a9096', 0, 0.63, 0), box(0.2, 0.3, 2.7, '#f0c419', 1.9, 0.63, 0), box(0.2, 0.3, 2.7, '#f0c419', -1.9, 0.63, 0), box(1.2, 0.12, 0.12, '#5b6067', 2.4, 0.55, 0), ...[-1.3, 1.3].flatMap((x) => [wheel(0.3, 0.25, '#1d1d1d', x, 0.3, 1.2), wheel(0.3, 0.25, '#1d1d1d', x, 0.3, -1.2)])];
  for (let x = -1.5; x <= 1.5; x += 0.5) parts.push(box(0.12, 0.06, 2.5, '#5b6067', x, 0.95, 0));
  return merge(parts);
}
/** 管线加油车：底盘、驾驶室、过滤分离器罐、软管卷盘；原点在底盘中心的地面，车头朝 +x。车尾的升降工作台另画 */
function fuelTruck(): THREE.BufferGeometry {
  return merge([
    box(7.2, 0.6, 2.4, '#e9eae7', 0, 0.55, 0),
    box(1.9, 1.9, 2.3, '#e9eae7', 2.6, 1.15, 0),
    box(0.15, 0.8, 2.1, '#bcd3e6', 3.55, 2.0, 0),
    box(3.4, 1.2, 2.2, '#c9cdd1', -0.4, 1.15, 0),
    cyl(0.55, 0.55, 2.0, '#5b6067', 0, -1.0, 0, 12).rotateX(Math.PI / 2).translate(-0.4, 2.9, 0),
    box(7.4, 0.12, 2.5, '#2a78d6', 0, 1.1, 0),
    ...[-2.4, 2.4].flatMap((x) => [wheel(0.5, 0.4, '#1d1d1d', x, 0.5, 1.05), wheel(0.5, 0.4, '#1d1d1d', x, 0.5, -1.05)]),
  ]);
}
/** 加油车的升降工作台（2.2 × 2.2 米、护栏 1 米）：原点在台面底部中心 */
function fuelDeck(): THREE.BufferGeometry {
  return merge([box(2.2, 0.15, 2.2, '#9aa0a6', 0, 0, 0), ...[-1.05, 1.05].map((z) => box(2.2, 1.0, 0.06, '#f0c419', 0, 0.15, z)), box(0.06, 1.0, 2.2, '#f0c419', -1.05, 0.15, 0)]);
}
function apronTug(): THREE.BufferGeometry {
  return merge([box(3.2, 1.0, 1.8, '#f0c419', 0, 0.45, 0), box(1.1, 1.2, 1.6, '#26313c', -0.7, 1.45, 0), box(1.0, 0.1, 1.5, '#26313c', -0.7, 2.65, 0), ...[-1, 1].flatMap((x) => [wheel(0.42, 0.35, '#1d1d1d', x, 0.42, 0.9), wheel(0.42, 0.35, '#1d1d1d', x, 0.42, -0.9)])]);
}
/** 推出车（低矮的大牵引车）和拖把（朝 +x 伸出去，接前起落架） */
function pushTug(): THREE.BufferGeometry {
  return merge([box(6.4, 1.5, 3.2, '#f0c419', 0, 0.4, 0), box(1.6, 0.9, 1.8, '#bcd3e6', -1.6, 1.9, 0.6), box(5.2, 0.2, 0.3, '#5b6067', 5.6, 0.7, 0), ...[-2.2, 2.2].flatMap((x) => [wheel(0.6, 0.6, '#1d1d1d', x, 0.6, 1.5), wheel(0.6, 0.6, '#1d1d1d', x, 0.6, -1.5)])]);
}
function gpu(): THREE.BufferGeometry {
  return merge([box(3.2, 1.6, 1.8, '#e9eae7', 0, 0.5, 0), box(3.3, 0.2, 1.9, '#2a78d6', 0, 2.1, 0), ...[-1.1, 1.1].flatMap((x) => [wheel(0.35, 0.3, '#1d1d1d', x, 0.35, 0.85), wheel(0.35, 0.3, '#1d1d1d', x, 0.35, -0.85)])]);
}
/** 配餐车的底盘和驾驶室（车头朝 +x，长 8 米）：车厢单独画（会升起来） */
function caterTruck(): THREE.BufferGeometry {
  return merge([
    box(8, 0.5, 2.4, '#3a3d42', 0, 0.55, 0),
    box(2.1, 2.1, 2.4, '#f4f4f0', 2.95, 1.05, 0),
    box(0.06, 0.9, 2.1, '#26313c', 4.0, 2.0, 0),
    ...[-2.6, 2.6].flatMap((x) => [wheel(0.48, 0.32, '#1d1d1d', x, 0.48, 1.05), wheel(0.48, 0.32, '#1d1d1d', x, 0.48, -1.05)]),
  ]);
}
/** 配餐车的车厢（原点在车厢底面中心）：白色、蓝色腰线，前端的小平台 */
function caterBox(): THREE.BufferGeometry {
  return merge([box(5.2, 2.5, 2.4, '#f4f6f7', 0, 0, 0), box(5.22, 0.35, 2.42, '#2a78d6', 0, 1.1, 0), box(1.2, 0.1, 2.4, '#9aa0a6', -3.1, 0, 0)]);
}

/** 地勤设备场里的一台设备（或一串板车）：车位（车头朝 −x）、开出去 / 开回来的路（cruise 匀加速—匀速—匀减速）、在外面的时段 */
type GseKind = 'loader' | 'fuel' | 'push' | 'gpu' | 'cater' | 'train';
interface GseUnit {
  kind: GseKind;
  slot: { x: number; z: number };
  moves: { t0: number; t1: number; poly: Poly; lead: number }[];
  busy: [number, number][];
  /** 平台车开过去时后平台的高度（接着机位上一开始的样子：后平台在门槛高度） */
  rear?: number;
}
/** 设备场里的车速（米 / 秒），板车串慢一些 */
const GSE_V = 5;
const TRAIN_V = 4;

/** 原来那架双发宽体货机的模型（别的模块要用可以直接拿） */
export function freighterModel(gear: boolean): THREE.BufferGeometry {
  return freighterGeo(KINDS[OWN_KIND] as Kind, gear);
}

/** 按矩阵放实例的池子（襟翼、扰流板要跟着机身的俯仰、滚转再绕铰链转） */
class MPool {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly capacity: number, name: string) {
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = name;
  }
  begin(): void {
    this.n = 0;
  }
  put(m: THREE.Matrix4): void {
    if (this.n >= this.capacity) return;
    this.mesh.setMatrixAt(this.n++, m);
  }
  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.boundingSphere = null;
  }
}

// —— 路径和速度曲线 ——
interface XZ {
  x: number;
  z: number;
}
/**
 * 滑行路线：折线的拐角按转弯半径插圆弧，按走过的距离取位置和朝向（朝向在点和点之间插值，转弯是连续的）；
 * 每一段记着曲率（直线 0），速度曲线按它限速。
 */
class Track {
  readonly x: number[] = [];
  readonly z: number[] = [];
  readonly s: number[] = [];
  readonly a: number[] = [];
  /** 每段的曲率（带符号：方向角随路程的变化率） */
  readonly k: number[] = [];
  readonly len: number;
  constructor(pts: readonly XZ[], radii: number | readonly number[]) {
    const kp: number[] = [];
    const push = (x: number, z: number, k: number) => {
      const m = this.x.length;
      if (m && Math.hypot(x - ix(this.x, m - 1), z - ix(this.z, m - 1)) < 0.05) {
        if (k) kp[m - 1] = k;
        return;
      }
      this.x.push(x);
      this.z.push(z);
      kp.push(k);
    };
    const n = pts.length;
    const P0 = pts[0] as XZ;
    push(P0.x, P0.z, 0);
    let px = P0.x;
    let pz = P0.z;
    for (let i = 1; i < n - 1; i++) {
      const A = pts[i - 1] as XZ;
      const B = pts[i] as XZ;
      const C = pts[i + 1] as XZ;
      const l1 = Math.hypot(B.x - A.x, B.z - A.z) || 1e-6;
      const l2 = Math.hypot(C.x - B.x, C.z - B.z) || 1e-6;
      const u1x = (B.x - A.x) / l1;
      const u1z = (B.z - A.z) / l1;
      const u2x = (C.x - B.x) / l2;
      const u2z = (C.z - B.z) / l2;
      const th = Math.atan2(u1x * u2z - u1z * u2x, u1x * u2x + u1z * u2z);
      if (Math.abs(th) < 1e-3) {
        push(B.x, B.z, 0);
        px = B.x;
        pz = B.z;
        continue;
      }
      const r = typeof radii === 'number' ? radii : (radii[i - 1] ?? 10);
      const tanH = Math.tan(Math.abs(th) / 2);
      const tl = Math.min(r * tanH, Math.hypot(B.x - px, B.z - pz), i === n - 2 ? l2 : l2 / 2);
      const re = tl / tanH;
      const sx = B.x - u1x * tl;
      const sz = B.z - u1z * tl;
      const nx = th > 0 ? -u1z : u1z;
      const nz = th > 0 ? u1x : -u1x;
      const cx = sx + nx * re;
      const cz = sz + nz * re;
      const kk = (th > 0 ? 1 : -1) / re;
      push(sx, sz, kk);
      const a0 = Math.atan2(sz - cz, sx - cx);
      const m = Math.max(3, Math.ceil((Math.abs(th) * re) / 2));
      for (let j = 1; j <= m; j++) {
        const ang = a0 + (th * j) / m;
        push(cx + re * Math.cos(ang), cz + re * Math.sin(ang), kk);
      }
      px = B.x + u2x * tl;
      pz = B.z + u2z * tl;
    }
    const Pn = pts[n - 1] as XZ;
    push(Pn.x, Pn.z, 0);
    if (this.x.length === 1) push(Pn.x + 0.1, Pn.z, 0);
    const m = this.x.length;
    let acc = 0;
    for (let i = 0; i < m; i++) {
      if (i) acc += Math.hypot(ix(this.x, i) - ix(this.x, i - 1), ix(this.z, i) - ix(this.z, i - 1));
      this.s.push(acc);
    }
    this.len = acc;
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(m - 1, i + 1);
      this.a.push(Math.atan2(ix(this.z, b) - ix(this.z, a), ix(this.x, b) - ix(this.x, a)));
    }
    for (let i = 0; i + 1 < m; i++) this.k.push(ix(kp, i) && ix(kp, i + 1) ? ix(kp, i) : 0);
  }
  /** 第几段（s 落在哪两个点之间） */
  seg(s: number): number {
    let lo = 0;
    let hi = this.x.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ix(this.s, mid) <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  at(s: number, out: At): At {
    const d = s <= 0 ? 0 : s >= this.len ? this.len : s;
    const lo = this.seg(d);
    const hi = Math.min(this.x.length - 1, lo + 1);
    const s0 = ix(this.s, lo);
    const f = (d - s0) / (ix(this.s, hi) - s0 || 1);
    out.x = ix(this.x, lo) + (ix(this.x, hi) - ix(this.x, lo)) * f;
    out.z = ix(this.z, lo) + (ix(this.z, hi) - ix(this.z, lo)) * f;
    const a0 = ix(this.a, lo);
    out.yaw = -(a0 + wrapA(ix(this.a, hi) - a0) * f);
    return out;
  }
}

/** 速度曲线：按 dt 采样的走过距离和速度 */
interface Prof {
  s: Float32Array;
  v: Float32Array;
  dt: number;
  T: number;
}
interface ProfOpt {
  v0: number;
  v1: number;
  vmax: (s: number) => number;
  acc: number;
  dec: (s: number) => number;
  /** 转弯的横向加速度、转弯角速度上限 */
  lat?: number;
  yaw?: number;
}
/** 沿路线的速度曲线：转弯按半径限速，前推加速、倒推减速（不会有瞬间的速度跳变），再按时间重采样 */
function profile(tr: Track, o: ProfOpt, dt = 0.5): Prof {
  const n = Math.max(2, Math.min(60000, Math.ceil(tr.len) + 1));
  const ds = tr.len / (n - 1);
  const lat = o.lat ?? 1.0;
  const yr = o.yaw ?? 0.12;
  const v = new Float64Array(n);
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const s = j * ds;
    while (seg < tr.k.length - 1 && ix(tr.s, seg + 1) < s) seg++;
    const k = Math.abs(ix(tr.k, seg));
    let m = o.vmax(s);
    if (k > 1e-5) m = Math.min(m, Math.sqrt(lat / k), yr / k);
    v[j] = Math.max(0.3, m);
  }
  v[0] = Math.min(o.v0, ix(v, 0));
  if (o.v0 <= 0) v[0] = 0;
  for (let j = 1; j < n; j++) v[j] = Math.min(ix(v, j), Math.sqrt(ix(v, j - 1) ** 2 + 2 * o.acc * ds));
  v[n - 1] = Math.min(ix(v, n - 1), o.v1);
  for (let j = n - 2; j >= 0; j--) v[j] = Math.min(ix(v, j), Math.sqrt(ix(v, j + 1) ** 2 + 2 * o.dec(j * ds) * ds));
  const tt = new Float64Array(n);
  for (let j = 1; j < n; j++) {
    const a = ix(v, j - 1) + ix(v, j);
    tt[j] = ix(tt, j - 1) + (a > 1e-4 ? (2 * ds) / a : Math.sqrt((2 * ds) / Math.max(0.05, o.acc)));
  }
  const T = ix(tt, n - 1);
  const m = Math.max(2, Math.ceil(T / dt) + 1);
  const dtE = T / (m - 1);
  const so = new Float32Array(m);
  const vo = new Float32Array(m);
  let j = 0;
  for (let i = 0; i < m; i++) {
    const t = Math.min(T, i * dtE);
    while (j < n - 2 && ix(tt, j + 1) < t) j++;
    const f = clamp01((t - ix(tt, j)) / (ix(tt, j + 1) - ix(tt, j) || 1));
    so[i] = (j + f) * ds;
    vo[i] = ix(v, j) + (ix(v, j + 1) - ix(v, j)) * f;
  }
  return { s: so, v: vo, dt: dtE, T };
}
const sAtT = (p: Prof, t: number): number => {
  const u = clamp01(t / p.T) * (p.s.length - 1);
  const i = Math.min(p.s.length - 2, Math.floor(u));
  return ix(p.s, i) + (ix(p.s, i + 1) - ix(p.s, i)) * (u - i);
};
/** 曲线上第一次满足条件的时刻（秒，从这一段开始算） */
function firstT(p: Prof, tr: Track | undefined, test: (s: number, v: number, x: number, z: number) => boolean): number | undefined {
  const at: At = { x: 0, z: 0, yaw: 0 };
  for (let i = 0; i < p.s.length; i++) {
    const s = ix(p.s, i);
    if (tr) tr.at(s, at);
    if (test(s, ix(p.v, i), at.x, at.z)) return i * p.dt;
  }
  return undefined;
}

// —— 一架飞机的运动：空中（按时间采样的位姿）、地面（沿路线 + 速度曲线）、停着 ——
interface AirTpl {
  /** 每 dt 秒一组 7 个数：x y z yaw pitch roll gear */
  d: Float32Array;
  dt: number;
  T: number;
  acts: { t: number; act: string }[];
  mark: Record<string, number>;
}
interface GndTpl {
  tr: Track;
  p: Prof;
  acts: { s: number; act: string }[];
  mark: Record<string, number>;
}
type Leg = { k: 'a'; t0: number; t1: number; a: AirTpl } | { k: 'g'; t0: number; t1: number; g: GndTpl; back: boolean; td: boolean } | { k: 'h'; t0: number; t1: number; x: number; z: number; yaw: number; act: string; stand: boolean };

/** 飞机此刻的位姿（局部坐标；y 是离道面的高度） */
interface PlanePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  gear: boolean;
  act: string;
  /** 襟翼、扰流板的角度（度） */
  flap: number;
  spoiler: number;
}
/** 给区域车辆层的位姿（拾取、跟随、跟踪、标签） */
export interface AirPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  gear: boolean;
  act: string;
  /** 停在机位上（不在动） */
  parked: boolean;
}
const newPose = (): PlanePose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, gear: true, act: '', flap: 0, spoiler: 0 });
/** 接地时的机头仰角 */
const PITCH_TD = 5.5 * DEG;

/** 跑道上的一次落地或起飞（排跑道用） */
interface RwEv {
  arr: boolean;
  /** 落地：过入口、脱离跑道；起飞：进跑道、开始滑跑、飞过跑道 B 端 */
  thr: number;
  vac: number;
  lu: number;
  roll: number;
  clr: number;
}
/**
 * 跑道的间隔规则（两架之间）：落地跟落地——后一架过入口时前一架已经脱离、且隔开 105 秒（尾流）；
 * 起飞跟起飞——隔开 110 秒，后一架等前一架开始滑跑了才进跑道；落地和起飞——要么落地的先（起飞的等它过了入口才进跑道、
 * 等它脱离才滑跑），要么起飞的先（落地的等它飞过跑道 B 端才过入口）。
 */
function rwOk(a: RwEv, b: RwEv): boolean {
  if (a.arr && b.arr) {
    const [p, q] = a.thr <= b.thr ? [a, b] : [b, a];
    return q.thr >= p.vac + 5 && q.thr >= p.thr + 105;
  }
  if (!a.arr && !b.arr) {
    const [p, q] = a.roll <= b.roll ? [a, b] : [b, a];
    return q.roll >= p.roll + 110 && q.lu >= p.roll + 5;
  }
  const A = a.arr ? a : b;
  const D = a.arr ? b : a;
  return (D.lu >= A.thr + 5 && D.roll >= A.vac + 5) || A.thr >= D.clr + 5;
}
/** 平行滑行道的占用：每 2 秒一格，飞机在滑行道上（或机尾伸到滑行道上）时记它的 x（不在就是 NaN）；ext = 机身长或翼展里大的那个 */
interface Occ {
  i0: number;
  xs: Float32Array;
  ext: number;
}
function clash(a: Occ, b: Occ): boolean {
  const lo = Math.max(a.i0, b.i0);
  const hi = Math.min(a.i0 + a.xs.length, b.i0 + b.xs.length) - 1;
  if (hi < lo) return false;
  const sep = (a.ext + b.ext) / 2 + 25;
  for (let i = lo; i <= hi; i++) {
    const xa = ix(a.xs, i - a.i0);
    const xb = ix(b.xs, i - b.i0);
    if (xa === xa && xb === xb && Math.abs(xa - xb) < sep) return true;
  }
  return false;
}
const busyAt = (list: { a: number; b: number }[], a: number, b: number): boolean => list.some((u) => u.a < b && a < u.b);

// —— 机位上的地面作业 ——
/** 一块板过平台车：out = 卸（舱门 → 板车），否则是装（板车 → 舱门）；t 是开始的时刻 */
interface Xfer {
  id: string;
  store: boolean;
  out: boolean;
  t: number;
  trip: number;
  slot: number;
}
/**
 * 一串板车（一辆牵引车 + 4 辆板车）的一趟：卸货趟空车从货站门口出发 → 机尾后面的排队点 → 进位到平台车后面 →
 * 每接一块往前挪一个车位 → 装满拉回货站门口 → 板横推进货站；装货趟先在货站门口把出口的板推上板车，再开过去一块块交给平台车，
 * 空车回货站。几套车轮流（第 k 趟用第 k mod 套数 套）。
 */
interface Trip {
  k: number;
  set: number;
  out: boolean;
  tPrep: number;
  tApp: number;
  tQ: number;
  tPull: number;
  tReady: number;
  t0: number;
  tArr: number;
  tDone: number;
  /** 这一套车的最后一趟：卸完回排队点停着（最后一趟留在货站门口）；parkSlot = 排在排队点后面第几个 */
  park: boolean;
  parkSlot?: number;
  /** 这一套车的下一趟（下标）、这一趟的板（按车位） */
  next?: number;
  xs: Xfer[];
}
interface Ops {
  cx: number;
  cz: number;
  xf: Xfer[];
  trips: Trip[];
  S: number;
  rt: { back: Poly; pull: Poly; toTerm: Poly; dockX: number; door: number };
  /** 货站门口一次只停一套板车：别的套占着门口时在门口前 DOOR_Q 米等（每套一串 [开始, 门口空出来]），空出来再往前挪 */
  doorWait?: number[][];
  /** 平台车：开过来、靠好、平台升起；关舱门；平台降下；撤离 */
  lo?: { in0: number; in1: number; up1: number; close0: number; close1: number; down0: number; down1: number; out0: number; out1: number; sw: number };
  fuel?: { in0: number; in1: number; out0: number; out1: number; inP: Poly; outP: Poly };
  tug: { in0: number; in1: number; inP: Poly; away?: Poly };
  /** 配餐车（地勤设备场开来）：开到右舷前门外、往前靠上、车厢升到门槛、送完降下、退出来 */
  cater?: { in0: number; in1: number; out0: number; out1: number; x: number; z: number; lift: number };
  /** 卸完、装完的时刻 */
  unloadEnd: number;
  loadEnd: number;
  noLoader: boolean;
  noFuel: boolean;
}

interface Spec {
  own: boolean;
  vid: number;
  kind: number;
  td: number;
  /** 计划撤轮挡（本店的照仿真），过站秒数（别的航班） */
  offPlan: number;
  ground: number;
  side: number;
  livery: string;
  nIn: number;
  nOut: number;
  label: string;
  id: string;
}
interface Flight {
  vid: number;
  own: boolean;
  id: string;
  label: string;
  kind: number;
  livery: string;
  stand: number;
  legs: Leg[];
  tApp: number;
  tThr: number;
  td: number;
  tStow: number;
  /** 反推收起（滑跑减到 32 米/秒） */
  tRev: number;
  tVac: number;
  tOn: number;
  offPlan: number;
  tOff: number;
  tClear: number;
  tTaxi: number;
  tHp: number;
  tLu: number;
  tRoll: number;
  tLof: number;
  tClr: number;
  tEnd: number;
  nIn: number;
  nOut: number;
  /** 空中多等的秒数（跑道排不开）、推出多等的秒数 */
  delayIn: number;
  delayOut: number;
  /** 同一个机位下一架飞机上轮挡的时刻（这架的板车、平台车在那之前收走） */
  nextOn: number;
  ops?: Ops;
  pose: PlanePose;
}
interface Committed {
  rw: RwEv[];
  occ: Occ[];
  stands: { a: number; b: number }[][];
}

export interface Uld {
  id: string;
  store: boolean;
  steps: { t: number; text: string }[];
}
export interface AirInfo {
  /** 今天的航班（在场的在前，然后是没到的，已离场的在最后） */
  flights: { id: string; label: string; kind?: string; own?: boolean; stand: string; status: string; land?: number; onBlock?: number; offBlock?: number; takeoff?: number; ulds: number; done: number; load?: number; loaded?: number; phase?: 'due' | 'air' | 'ground' | 'gone' }[];
  ulds: Uld[];
  equip: { id: string; kind: string; now: string }[];
  terminal: { inside: number; storeReady: number; exportOut?: number; term?: TermInfo };
  /** 今天的概况：航班数（本店几班）、跑道起降架次、机位（在用几个） */
  today?: { flights: number; own: number; moves: number; stands: number; inUse: number; dropped: number };
}

export class AirportOps {
  readonly group = new THREE.Group();
  /** 动的部分（飞机、地面车辆）放在道面高度上 */
  private readonly dyn = new THREE.Group();
  private readonly bodies: Pool[] = [];
  private readonly liveries: Pool[] = [];
  private readonly doors: Pool;
  private readonly lamps: Pool;
  private readonly flaps: MPool;
  private readonly spoilers: MPool;
  private readonly loaders: Pool;
  private readonly platforms: Pool;
  private readonly rods: Pool;
  private readonly ulds: Pool;
  private readonly dollies: Pool;
  private readonly tugs: Pool;
  private readonly pushers: Pool;
  private readonly gpus: Pool;
  private readonly chocks: Pool;
  private readonly fuel: Pool;
  private readonly decks: Pool;
  /** 反推时发动机往前吹起的水汽、尘土（半透明） */
  private readonly spray: Pool;
  /** 助航灯、机坪高杆灯（静态，夜里亮）；飞机的航行灯、防撞灯、着陆灯 */
  private readonly lampMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  /** 道面（跑道、滑行道、联络道、机坪、卡车场和上面的标志线）单独一个材质：下雨时天气把它变暗、变光滑（weather.ts） */
  readonly paveMat = std({ vertexColors: true, roughness: 0.9 });
  private readonly navMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
  private staticGroup: THREE.Group | undefined;
  /** 货站（机场的仓储中心）：房子、库内和一天的作业计划 */
  readonly term = new AirTerminal();
  private readonly apronLamps = new Lamps('apron-vehicle-lamps', 200);
  private readonly apronSpec = new Map<Pool, LampSpec>();
  private readonly apronSt: LampState = { night: false };
  private termLayout: TermLayout;
  private termPlan: AirTermPlan | undefined;
  /** 陆侧卡车场：收货场引擎排的车道、今天每辆车在场里的时刻（货代的车由 ext 画，本店的冷藏车由区域车辆层画） */
  private yardPlan: YardPlan | undefined;
  private yardSched: YardSchedule | undefined;
  private yardFrame: YardFrame | undefined;
  private builtYard: YardPlan | undefined;
  /** 本店冷藏车这一天的场内访问（和运动规划算的一样）：车辆编号 → 访问 */
  private readonly simVisits = new Map<number, YardVisit>();
  /** 本店每班航班（按车辆编号）的货有几板 */
  private readonly ownPallets = new Map<number, number>();
  private L: Layout;
  private flights: Flight[] = [];
  private dropped = 0;
  private visits: DockVisit[] = [];
  /** 地勤设备场里的设备：车位、开出去 / 开回来的路和时刻、在外面的时段 */
  private units: GseUnit[] = [];
  private readonly caters: Pool;
  private readonly caterBoxes: Pool;
  private readonly cache = new Map<string, AirTpl | GndTpl | GndTpl[]>();
  /** 拾取：每个机身池子里第几个实例是哪架飞机 */
  private readonly pickMap: Int32Array[] = [];
  private readonly pickN: number[] = [];
  /** 每架飞机此刻的位姿（给区域车辆层：拾取、跟随、实时跟踪） */
  readonly poses = new Map<number, PlanePose>();
  // —— 每帧复用的临时对象（热循环里不分配） ——
  private readonly atA: At = { x: 0, z: 0, yaw: 0 };
  private readonly atB: At = { x: 0, z: 0, yaw: 0 };
  private readonly atT: At = { x: 0, z: 0, yaw: 0 };
  private readonly tmp: PlanePose = newPose();
  private readonly mP = new THREE.Matrix4();
  private readonly mL = new THREE.Matrix4();
  private readonly mR = new THREE.Matrix4();
  private readonly mT = new THREE.Matrix4();
  private readonly qP = new THREE.Quaternion();
  private readonly eP = new THREE.Euler(0, 0, 0, 'YZX');
  private readonly vP = new THREE.Vector3();
  private readonly sP = new THREE.Vector3();
  private readonly va = new THREE.Vector3();
  private readonly vb = new THREE.Vector3();
  private readonly w = { x: 0, z: 0 };
  private cx = 0;
  private cz = 0;

  constructor() {
    this.group.name = 'airport-ops';
    this.dyn.name = 'airport-moving';
    this.dyn.position.y = PAVE;
    this.group.add(this.dyn);
    const VC = std({ vertexColors: true });
    for (const k of KINDS) {
      for (const gear of [true, false]) {
        const pool = new Pool(freighterGeo(k, gear), VC, gear ? 12 : 6, `freighters-${k.key}${gear ? '' : '-gear-up'}`);
        this.bodies.push(pool);
        this.pickMap.push(new Int32Array(pool.capacity));
        this.pickN.push(0);
      }
      this.liveries.push(new Pool(liveryGeo(k), std({ vertexColors: true, roughness: 0.6 }), 16, `freighter-livery-${k.key}`));
    }
    this.doors = new Pool(cargoDoor(), VC, 24, 'cargo-doors');
    this.lamps = new Pool(new THREE.SphereGeometry(0.42, 8, 6), this.navMat, 256, 'aircraft-lights', false);
    this.flaps = new MPool(flapGeo(), VC, 64, 'flaps');
    this.spoilers = new MPool(spoilerGeo(), VC, 64, 'spoilers');
    this.loaders = new Pool(loaderBase(), VC, 8, 'md-loaders');
    this.platforms = new Pool(platform(), VC, 16, 'loader-platforms');
    this.rods = new Pool(new THREE.CylinderGeometry(1, 1, 1, 6), std({ color: '#ffffff', metalness: 0.4 }), 200, 'scissors', false);
    this.ulds = new Pool(uld(), std({ vertexColors: true, roughness: 0.8 }), 240, 'ulds');
    this.dollies = new Pool(dolly(), VC, 100, 'dollies');
    this.tugs = new Pool(apronTug(), VC, 30, 'apron-tugs');
    this.pushers = new Pool(pushTug(), VC, 10, 'pushback-tugs');
    this.gpus = new Pool(gpu(), VC, 8, 'gpus');
    this.caters = new Pool(caterTruck(), VC, 6, 'catering-trucks');
    this.caterBoxes = new Pool(caterBox(), VC, 6, 'catering-boxes');
    this.chocks = new Pool(new THREE.BoxGeometry(0.5, 0.35, 0.3).translate(0, 0.17, 0), std({ color: '#f0c419' }), 64, 'chocks', false);
    this.fuel = new Pool(fuelTruck(), VC, 8, 'hydrant-dispensers');
    // 机坪上的车（牵引车、配餐车、加油车）的车灯：灯位按车模的包围盒，夜里亮大灯尾灯
    for (const pl of [this.tugs, this.caters, this.fuel]) this.apronSpec.set(pl, Lamps.specOf(pl.mesh.geometry));
    this.group.add(this.apronLamps.mesh);
    this.decks = new Pool(fuelDeck(), VC, 8, 'dispenser-decks');
    this.spray = new Pool(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: '#eef2f4', transparent: true, opacity: 0.18, depthWrite: false }), 96, 'reverser-spray', false);
    for (const p of this.pools()) this.dyn.add(p.mesh);
    this.dyn.add(this.flaps.mesh, this.spoilers.mesh);
    this.L = layoutFor(currentFacilities().airport.stands ?? 2);
    this.termLayout = terminalLayout(this.L.dock, this.L.tx1);
    this.group.add(this.term.group);
    this.term.paveMat = this.paveMat;
    this.rebuildStatic();
    this.setNight(0);
  }

  private pools(): Pool[] {
    return [...this.bodies, ...this.liveries, this.doors, this.lamps, this.loaders, this.platforms, this.rods, this.ulds, this.dollies, this.tugs, this.pushers, this.gpus, this.caters, this.caterBoxes, this.chocks, this.fuel, this.decks, this.spray];
  }

  private rebuildStatic(): void {
    if (this.staticGroup) {
      this.group.remove(this.staticGroup);
      this.staticGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        if (m.material && m.material !== this.lampMat && m.material !== this.paveMat) (m.material as THREE.Material).dispose();
      });
    }
    this.staticGroup = this.staticParts(this.L);
    this.group.add(this.staticGroup);
    this.termLayout = terminalLayout(this.L.dock, this.L.tx1);
    this.term.build(this.termLayout, this.L.doors);
  }

  /** 不动的部分：跑道和标志、滑行道和联络道、机坪和机位线、货站、塔台、助航灯 */
  private staticParts(L: Layout): THREE.Group {
    const g = new THREE.Group();
    g.name = 'airport-static';
    const p: Part[] = [];
    /** 道面和标志线（湿了变暗、变光滑） */
    const pv: Part[] = [];
    const lamps: Part[] = [];
    const W = '#f2f2f2';
    const Y = '#f5c518';
    // 道面顶：跑道 0.36、滑行道 0.355、机坪 0.35；标志线比道面高 2 厘米
    const flat = (w: number, d: number, color: string, x: number, z: number, top: number, yaw = 0, th = 0.3) => (yaw ? box(w, th, d, color, 0, top - th, 0).rotateY(yaw).translate(x, 0, z) : box(w, th, d, color, x, top - th, z));
    const mark = (w: number, d: number, color: string, x: number, z: number, top = 0.36, yaw = 0) => flat(w, d, color, x, z, top + 0.02, yaw, 0.04);
    const lamp = (x: number, z: number, color: string, s = 0.6) => lamps.push(box(s, 0.45, s, color, x, 0.2, z));
    const rwL = RW_X1 - RW_X0;
    const rwC = (RW_X0 + RW_X1) / 2;
    // —— 跑道：道肩、道面、两头的入口标志（琴键）、中线、接地区和瞄准点标志、边线 ——
    pv.push(flat(rwL + 30, 62, '#8a8c86', rwC, RW_Z, 0.335), flat(rwL, 45, '#3c3f43', rwC, RW_Z, 0.36));
    for (let x = RW_X0 + 70; x < RW_X1 - 70; x += 50) pv.push(mark(30, 0.9, W, x, RW_Z));
    for (const x0 of [RW_X0 + 6, RW_X1 - 36]) for (let k = -6; k <= 6; k++) if (k) pv.push(mark(30, 1.8, W, x0 + 15, RW_Z + k * 3.3 - Math.sign(k) * 1.0));
    for (const [thr, dir] of [
      [THR_X, -1],
      [RW_X0 + 30, 1],
    ] as const) {
      // 瞄准点（入口后 300 米两条大白块）、接地区（150、450、600、750、900 米）
      for (const s of [-1, 1]) pv.push(mark(50, 8, W, thr + dir * 325, RW_Z + s * 9.5));
      for (const [d, n] of [
        [150, 3],
        [450, 2],
        [600, 2],
        [750, 1],
        [900, 1],
      ] as const)
        for (let k = 0; k < n; k++) for (const s of [-1, 1]) pv.push(mark(22.5, 1.8, W, thr + dir * (d + 11), RW_Z + s * (6 + k * 3.2)));
    }
    for (const s of [-1, 1]) pv.push(mark(rwL, 0.9, W, rwC, RW_Z + s * 21.6));
    // 跑道边灯（白，每 60 米）、A 端入口灯（绿）、B 端跑道端灯（红）
    for (let x = RW_X0; x <= RW_X1; x += 60) for (const s of [-1, 1]) lamp(x, RW_Z + s * 24.5, '#ffffff');
    for (let z = -21; z <= 21; z += 3) {
      lamp(RW_X1 - 2, RW_Z + z, '#37d67a', 0.7);
      lamp(RW_X0 + 2, RW_Z + z, '#ff4436', 0.7);
    }
    // 进近灯（A 端外面，每 30 米一排）和坡度指示灯（瞄准点旁边，两红两白）
    for (let x = RW_X1 + 30; x <= 3300; x += 30) {
      for (let z = -6; z <= 6; z += 3) lamp(x, RW_Z + z, '#fff3c8', 0.7);
      p.push(box(0.3, 0.6, 14, '#6f757c', x, 0, RW_Z));
    }
    for (let k = 0; k < 4; k++) {
      p.push(box(1.6, 0.9, 1.2, '#4a4f55', AIM_X, 0, RW_Z - 37 - k * 6));
      lamp(AIM_X + 0.9, RW_Z - 37 - k * 6, k < 2 ? '#ff4436' : '#ffffff', 0.8);
    }
    // —— 平行滑行道（黄色中线、蓝色边灯）和三条联络道（两条脱离道、一条起飞联络道） ——
    const tw0 = (EXITS[0] as number) - 12;
    const tw1 = DEP_X + 12;
    pv.push(flat(tw1 - tw0, 23, '#4a4d52', (tw0 + tw1) / 2, TW_Z, 0.355));
    for (let x = tw0 + 14; x < tw1 - 14; x += 6) pv.push(mark(3.5, 0.3, Y, x, TW_Z, 0.355));
    for (let x = tw0 + 30; x <= tw1 - 30; x += 40) for (const s of [-1, 1]) lamp(x, TW_Z + s * 12.5, '#4d8dff', 0.5);
    const connector = (pts: XZ[]) => {
      const tr = new Track(pts, [TURN_R, TURN_R]);
      for (let s = 0; s <= tr.len; s += 3) {
        tr.at(s, this.atT);
        pv.push(flat(4.2, 23, '#4a4d52', this.atT.x, this.atT.z, 0.352, this.atT.yaw + Math.PI / 2));
        if (Math.round(s) % 6 === 0) pv.push(mark(0.3, 2.4, Y, this.atT.x, this.atT.z, 0.352, this.atT.yaw + Math.PI / 2));
      }
      for (let s = 10; s < tr.len - 10; s += 30) {
        tr.at(s, this.atT);
        const c = Math.cos(this.atT.yaw);
        const sn = Math.sin(this.atT.yaw);
        for (const side of [-1, 1]) lamp(this.atT.x + side * 12.5 * sn, this.atT.z + side * 12.5 * c, '#4d8dff', 0.5);
      }
    };
    for (const ex of EXITS) connector([{ x: ex - 60, z: RW_Z }, { x: ex, z: RW_Z }, { x: ex, z: TW_Z }, { x: ex + 60, z: TW_Z }]);
    connector([{ x: DEP_X - 60, z: TW_Z }, { x: DEP_X, z: TW_Z }, { x: DEP_X, z: RW_Z }, { x: DEP_X - 60, z: RW_Z }]);
    // 跑道等待位置标志（联络道上四条黄线）
    for (const x of [...EXITS, DEP_X]) for (let k = 0; k < 4; k++) pv.push(mark(23, 0.3, Y, x, RW_Z - 52 + k * 0.8, 0.352));
    // —— 货运机坪（混凝土）、机位引入线、停止线、设备限制线（红）、行车道、加油井、高杆灯 ——
    const apZ0 = TERM.zAir;
    const apZ1 = TW_Z - 11.5;
    pv.push(flat(L.ax1 - L.ax0, apZ1 - apZ0, '#9b9c97', (L.ax0 + L.ax1) / 2, (apZ0 + apZ1) / 2, 0.35));
    for (const sx of L.sx) {
      const lead = new Track([{ x: sx - STAND_R - 20, z: TW_Z }, { x: sx, z: TW_Z }, { x: sx, z: NOSE_Z }], STAND_R);
      for (let s = 0; s < lead.len; s += 4) {
        lead.at(s, this.atT);
        pv.push(mark(2.4, 0.35, Y, this.atT.x, this.atT.z, 0.35, this.atT.yaw));
      }
      pv.push(mark(6, 0.5, Y, sx, NOSE_Z - 0.5, 0.35));
      for (const s of [-1, 1]) pv.push(mark(0.3, TAIL_Z - 4 - (NOSE_Z - 6), '#d03b2a', sx + s * 40, (TAIL_Z - 4 + NOSE_Z - 6) / 2, 0.35));
      // 设备通道（两个机位之间的白虚线）、加油井（三种机型的停车位置旁边）
      for (let z = LANE_Z + 4; z < TAIL_Z - 3; z += 6) pv.push(mark(0.2, 3, '#f2f2ee', sx + 46 - 3.2, z, 0.35), mark(0.2, 3, '#f2f2ee', sx + 46 + 3.2, z, 0.35));
      for (const k of KG) p.push(box(1.0, 0.33, 1.0, '#2b2f34', sx + k.fuelZ - 2.6, 0.04, NOSE_Z + k.nose + 9));
      // 高杆灯（机位之间靠货站一侧）
      const mx = sx + 52;
      p.push(cyl(0.35, 0.55, 26, '#9aa3ab', mx, 0, NOSE_Z - 4, 8), box(3.2, 0.9, 1.4, '#4a4f55', mx, 26, NOSE_Z - 4));
      lamps.push(box(3.0, 0.3, 1.2, '#fff1d0', mx, 25.8, NOSE_Z - 4));
    }
    pv.push(mark(0.2, 3, '#f2f2ee', (L.sx[0] as number) - 46 - 3.2, LANE_Z + 7, 0.35));
    for (const z of [LANE_Z - 2.6, LANE_Z + 2.6]) pv.push(mark(L.ax1 - L.ax0 - 10, 0.2, '#f2f2ee', (L.ax0 + L.ax1) / 2, z, 0.35));
    for (let x = L.ax0 + 6; x < L.ax1 - 6; x += 6) pv.push(mark(3, 0.2, '#f2f2ee', x, TAIL_Z + 2.6, 0.35), mark(3, 0.2, '#f2f2ee', x, TAIL_Z - 2.6, 0.35));
    // 地勤设备库（最后一个机位外面）：平台车、加油车、推出车、电源车、配餐车和板车串不干活时停在里面，库门朝西；门口几摞空板
    const yard0 = (L.sx[L.n - 1] as number) + 60;
    p.push(box(58, 9, 34, '#cfd5da', yard0 + 20 + 29, 0.35, 1102), box(58.6, 0.6, 34.6, '#2a78d6', yard0 + 20 + 29, 9.35, 1102));
    p.push(box(0.2, 6.2, 15, '#2b2f34', yard0 + 19.95, 0.35, 1102), box(0.3, 0.5, 16, '#f0c419', yard0 + 19.9, 6.55, 1102));
    for (let k = 0; k < 4; k++) p.push(box(3.18, 0.6, 2.44, '#b8bcc0', yard0 + 24 + k * 5, 0.35, 1124));
    // —— 货站：房子、库内、陆侧收货口在 ops/airTerminal.ts；这里画空侧板车门的门头和门外的滚轮台（机位对着的门开两条道，滚轮台加长） ——
    const x0 = TERM.x0;
    const x1 = L.tx1;
    for (const x of L.doors) {
      const two = L.dock.includes(x);
      const w = two ? 10.6 : 7;
      const cx = two ? x + TPITCH / 2 : x;
      p.push(box(w + 1, 0.5, 1.4, '#3a3d42', cx, 6.7, TERM.zAir + 0.6), box(w + 0.4, 0.9, 0.9, '#5b6067', cx, 6.5, TERM.zAir + 0.5));
      if (!two) p.push(box(7, 6.5, 0.3, '#22262b', x, 0, TERM.zAir + 0.15));
      const bl = two ? 22 : 18;
      p.push(box(bl, 0.95, 3.2, '#8a9096', cx, 0.35, BED_Z), box(bl, 0.08, 0.15, '#f0c419', cx, 1.3, BED_Z + 1.55));
      for (let xx = -bl / 2 + 0.3; xx <= bl / 2 - 0.3; xx += 0.6) p.push(box(0.1, 0.06, 3.0, '#5b6067', cx + xx, 1.3, BED_Z));
    }
    // 陆侧卡车场（收货口外的沥青场地；车道、待命车位由收货场引擎排，画在 ops/airTerminal.ts 旁边）
    pv.push(box(x1 - x0 + 60, 0.2, 62, '#5d6166', (x0 + x1) / 2 - 20, 0.1, TERM.zLand - 31));
    // 进场路尽头的回车场：外来货车在这里掉头（ops/extTrucks.ts：进场的车走外圈、出去的车走里圈），沿出场一侧开进卡车场
    pv.push(cyl(16.5, 16.5, 0.296, '#4f5256', 1950, 0, 1087.5, 28));
    // 塔台（混凝土塔身 + 玻璃塔冠）
    const twx = x0 - 120;
    const twz = TERM.zLand - 20;
    p.push(cyl(5, 6.5, 44, '#e5e7e9', twx, 0, twz, 16), cyl(9, 7, 7, '#2e4a62', twx, 44, twz, 16), cyl(9.5, 9.5, 1, '#e5e7e9', twx, 51, twz, 16), cyl(0.3, 0.3, 8, '#9aa3ab', twx, 52, twz, 6));
    // 客运航站楼（背景，简单体量）和它的机坪、接平行滑行道的联络道
    const px = 2880;
    p.push(box(360, 22, 60, '#e8eaed', px, 0, TERM.zLand + 20), box(360, 2, 62, '#7fb3d5', px, 22, TERM.zLand + 20));
    pv.push(flat(420, 70, '#9b9c97', px, TERM.zLand + 90, 0.35), flat(23, TW_Z - 11.5 - (TERM.zLand + 125), '#4a4d52', px, (TW_Z - 11.5 + TERM.zLand + 125) / 2, 0.352));
    // 风向袋、航向台天线（跑道 B 端外面）、下滑台（都在占地范围里：z ≤ 1330）
    p.push(cyl(0.15, 0.2, 8, '#d9dcdf', THR_X - 380, 0, RW_Z + 38, 6), hcyl(0.6, 1.1, 4, '#ff7a1a', THR_X - 380 - 2.2, 7.6, RW_Z + 38, 10));
    for (let k = -6; k <= 6; k++) p.push(box(0.5, 3 + (6 - Math.abs(k)) * 0.15, 0.5, '#c9cdd1', RW_X0 - 75, 0, RW_Z + k * 3));
    p.push(box(14, 0.4, 2, '#c9cdd1', RW_X0 - 75, 2.6, RW_Z), cyl(0.4, 0.5, 14, '#c9cdd1', AIM_X - 30, 0, RW_Z - 45, 8));
    const body = new THREE.Mesh(merge(p), std({ vertexColors: true, roughness: 0.9 }));
    body.receiveShadow = true;
    body.castShadow = true;
    // 道面是平的，只接影子
    const pave = new THREE.Mesh(merge(pv), this.paveMat);
    pave.name = 'airport-pavement';
    pave.receiveShadow = true;
    g.add(body, pave);
    const lm = new THREE.Mesh(merge(lamps), this.lampMat);
    lm.name = 'airfield-lights';
    g.add(lm);
    return g;
  }

  setNight(night: number): void {
    this.term.setNight(night);
    const n = clamp01(night);
    this.lampMat.color.setScalar(0.55 + 1.2 * n);
    this.navMat.color.setScalar(0.7 + 1.0 * n);
  }

  // —— 一天的航班：模板（缓存）、排跑道 / 滑行道 / 机位 ——
  private tpl<T extends AirTpl | GndTpl | GndTpl[]>(key: string, make: () => T): T {
    const hit = this.cache.get(key);
    if (hit) return hit as T;
    const v = make();
    this.cache.set(key, v);
    return v;
  }

  /**
   * 进近（按时间采样）：先沿 25° 的切入航向飞、压 20° 坡度转上跑道中线延长线，在 320 米高截获 3° 下滑道，
   * 过入口约 16 米高，离地 12 米开始拉平（机头抬到 5.5°），在入口后 420 米主轮接地。最后一个采样就是接地。
   */
  private approachTpl(ki: number, side: number): AirTpl {
    return this.tpl(`app:${ki}:${side}`, () => {
      const k = kg(ki).k;
      const Rt = (k.vApp * k.vApp) / (9.81 * Math.tan(20 * DEG));
      const psi = 25 * DEG;
      const tl = Rt * Math.tan(psi / 2);
      const C = { x: THR_X + 4300 + tl, z: RW_Z };
      const Lin = 1300 + tl;
      const P0 = { x: C.x + Math.cos(psi) * Lin, z: RW_Z + side * Math.sin(psi) * Lin };
      const tr = new Track([P0, C, { x: TD_X, z: RW_Z }], [Rt]);
      const S = tr.len;
      const sThr = S - (THR_X - TD_X);
      const sAim = S - (AIM_X - TD_X);
      const sF = sAim - 12 / GS;
      const tF = sF / k.vApp;
      const Tf = (2 * (S - sF)) / (k.vApp + k.vTd);
      const T = tF + Tf;
      const m = Math.ceil(T / 0.25) + 1;
      const dt = T / (m - 1);
      const d = new Float32Array(m * 7);
      const HC = 320;
      const KS = 25;
      const roll = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        const tau = i * dt;
        let s: number;
        let h: number;
        let pitch: number;
        let v = k.vApp;
        if (tau <= tF) {
          s = k.vApp * tau;
          const hg = (sAim - s) * GS;
          h = -KS * Math.log(Math.exp(-HC / KS) + Math.exp(-hg / KS));
          pitch = (2.5 + 2.5 * clamp01((hg - HC) / 60)) * DEG;
        } else {
          const u = (tau - tF) / Tf;
          v = k.vApp + (k.vTd - k.vApp) * u;
          s = sF + k.vApp * (tau - tF) + (0.5 * (k.vTd - k.vApp) * (tau - tF) ** 2) / Tf;
          // 拉平：高度按三次埃尔米特曲线从 12 米收到 0，下降率从下滑道的 3.7 米/秒减到 0.6 米/秒
          const m0 = -k.vApp * GS * Tf;
          const m1 = -0.6 * Tf;
          h = 12 * (2 * u ** 3 - 3 * u * u + 1) + m0 * (u ** 3 - 2 * u * u + u) + m1 * (u ** 3 - u * u);
          pitch = 2.5 * DEG + (PITCH_TD - 2.5 * DEG) * ease(u);
        }
        tr.at(s, this.atT);
        const kk = ix(tr.k, Math.min(tr.k.length - 1, tr.seg(s)));
        roll[i] = Math.atan((v * v * kk) / 9.81);
        d.set([this.atT.x, Math.max(0, h), this.atT.z, this.atT.yaw, pitch, 0, 1], i * 7);
      }
      // 坡度不会突变：前后 2 秒平滑（压坡度、改平都有过程）
      const W2 = 8;
      for (let i = 0; i < m; i++) {
        let a = 0;
        let c = 0;
        for (let j = Math.max(0, i - W2); j <= Math.min(m - 1, i + W2); j++) {
          a += ix(roll, j);
          c++;
        }
        d[i * 7 + 5] = a / c;
      }
      return { d, dt, T, acts: [{ t: 0, act: '进近' }, { t: tF, act: '拉平接地' }], mark: { thr: sThr / k.vApp, flare: tF } };
    });
  }

  /**
   * 起飞（按时间采样）：在对正位置松刹车，加速滑跑，到抬头速度以每秒 3° 抬头，离地后爬升、6 秒后收起落架；
   * 飞过跑道 B 端 300 米、高度过 140 米以后压 18° 坡度转 40° 离开，再爬升 2 分钟。side = 坡度的方向。
   */
  private takeoffTpl(ki: number, side: number): AirTpl {
    return this.tpl(`tko:${ki}:${side}`, () => {
      const k = kg(ki).k;
      const dt = 0.25;
      const out: number[] = [];
      const acts: { t: number; act: string }[] = [{ t: 0, act: '起飞滑跑' }];
      let x = LU_X;
      let z = RW_Z;
      let a = Math.PI;
      let v = 0;
      let h = 0;
      let vs = 0;
      let pitch = 0;
      let roll = 0;
      let tau = 0;
      let lof = -1;
      let rot = -1;
      let clr = -1;
      let gearUp = -1;
      let turned = 0;
      let turning = 0;
      const climb = k.climb * DEG;
      for (let i = 0; i < 4000; i++) {
        out.push(x, h, z, -a, pitch, roll, gearUp < 0 || tau < gearUp ? 1 : 0);
        if (lof >= 0 && tau > lof + 125) break;
        if (lof < 0) {
          v += k.aTo * (1 - (0.18 * v) / k.vR) * dt;
          if (v >= k.vR) {
            if (rot < 0) {
              rot = tau;
              acts.push({ t: tau, act: '抬头离地' });
            }
            pitch = Math.min(pitch + 3 * DEG * dt, 11 * DEG);
          }
          if (v >= k.vLof && pitch >= 7.5 * DEG) lof = tau + dt;
        } else {
          v = Math.min(v + 1.1 * dt, k.vLof + 28);
          vs = Math.min(vs + 1.6 * dt, v * Math.sin(climb));
          h += vs * dt;
          const pT = climb + 6 * DEG;
          pitch += Math.max(-2 * DEG * dt, Math.min(2 * DEG * dt, pT - pitch));
          if (gearUp < 0 && tau > lof + 6) gearUp = tau + 2;
          if (turning === 0 && h > 140 && x < RW_X0 - 300) {
            turning = 1;
            acts.push({ t: tau, act: '转弯离场' });
          }
          const want = turning === 1 ? side * 18 * DEG : 0;
          roll += Math.max(-4 * DEG * dt, Math.min(4 * DEG * dt, want - roll));
          const wr = (9.81 * Math.tan(roll)) / v;
          a += wr * dt;
          turned += Math.abs(wr * dt);
          if (turning === 1 && turned > 40 * DEG) {
            turning = 2;
            acts.push({ t: tau, act: '爬升离场' });
          }
          if (lof >= 0 && acts.length < 3 && tau > lof + 4) acts.push({ t: tau, act: '爬升' });
        }
        x += v * Math.cos(a) * dt;
        z += v * Math.sin(a) * dt;
        if (clr < 0 && x < RW_X0) clr = tau;
        tau += dt;
      }
      const d = new Float32Array(out);
      return { d, dt, T: (d.length / 7 - 1) * dt, acts, mark: { lof, clr: clr < 0 ? lof + 20 : clr, rot } };
    });
  }

  /** 着陆滑跑 + 脱离 + 滑入机位（hold：在滑行道上脱离道口后面停一下，分成两段） */
  private arrTpl(ki: number, stand: number, hold: boolean): GndTpl[] {
    return this.tpl(`arr:${ki}:${stand}:${hold ? 1 : 0}`, () => {
      const G = kg(ki);
      const k = G.k;
      const ex = EXITS[G.exit] as number;
      const sx = this.L.sx[stand] as number;
      const zc = NOSE_Z + G.nose;
      const rwEnd = TD_X - ex - TURN_R;
      const hx = ex + TURN_R + 22;
      const roll = (s: number) => (s < rwEnd ? Math.sqrt(Math.max(169, k.vTd * k.vTd - 2 * k.aRoll * s)) : 13);
      const dec = (s: number) => (s < rwEnd - 160 ? 2.6 : s < rwEnd + 10 ? 1.2 : 0.8);
      const mk = (pts: XZ[], radii: number[], v0: number, v1: number, off: number, last: boolean): GndTpl => {
        const tr = new Track(pts, radii);
        const p = profile(tr, { v0, v1, vmax: (s) => Math.min(roll(s + off), last ? 0.6 + 0.12 * (tr.len - s) : 99), acc: 0.45, dec: (s) => dec(s + off) });
        const acts: { s: number; act: string }[] = [];
        const tEnter = firstT(p, tr, (_s, _v, _x, z) => z < TW_Z + 34) ?? 0;
        const tRev = off === 0 ? (firstT(p, undefined, (_s, vv) => vv < 32) ?? 0) : 0;
        if (off === 0) {
          acts.push({ s: 0, act: '着陆滑跑' }, { s: 40, act: '反推减速' }, { s: sAtT(p, tRev), act: '着陆滑跑' }, { s: rwEnd, act: '脱离跑道' }, { s: sAtT(p, tEnter), act: '滑行进港' });
        } else acts.push({ s: 0, act: '滑行进港' });
        if (last) acts.push({ s: Math.max(0, tr.len - (zc - (TW_Z - STAND_R)) - Math.PI * 0.5 * STAND_R), act: '进机位' });
        const mark: Record<string, number> = { T: p.T };
        if (off === 0) {
          mark.vac = firstT(p, tr, (_s, _v, _x, z) => z < RW_Z - 50) ?? p.T;
          mark.stow = firstT(p, undefined, (_s, vv) => vv < 18) ?? 10;
          mark.rev = tRev;
        }
        return { tr, p, acts, mark };
      };
      const A = { x: TD_X, z: RW_Z };
      const B = { x: ex, z: RW_Z };
      const C = { x: ex, z: TW_Z };
      if (!hold) return [mk([A, B, C, { x: sx, z: TW_Z }, { x: sx, z: zc }], [TURN_R, TURN_R, STAND_R], k.vTd, 0, 0, true)];
      return [mk([A, B, C, { x: hx, z: TW_Z }], [TURN_R, TURN_R], k.vTd, 0, 0, false), mk([{ x: hx, z: TW_Z }, { x: sx, z: TW_Z }, { x: sx, z: zc }], [STAND_R], 0, 0, 1e6, true)];
    });
  }

  /** 推出（倒着走：机尾先出机位，转到滑行道上机头朝 +x） */
  private pushTpl(ki: number, stand: number): GndTpl {
    return this.tpl(`push:${ki}:${stand}`, () => {
      const sx = this.L.sx[stand] as number;
      const zc = NOSE_Z + kg(ki).nose;
      const tr = new Track([{ x: sx, z: zc }, { x: sx, z: TW_Z }, { x: sx - PUSH_BACK, z: TW_Z }], STAND_R);
      const p = profile(tr, { v0: 0, v1: 0, vmax: () => 1.3, acc: 0.15, dec: () => 0.22, lat: 0.5, yaw: 0.06 });
      return { tr, p, acts: [{ s: 0, act: '推出' }], mark: { T: p.T, clear: firstT(p, tr, (_s, _v, _x, z) => z > TW_Z - 30) ?? p.T } };
    });
  }

  /** 滑出：沿平行滑行道往 +x 滑到 A 端的等待位置停下 */
  private taxiTpl(stand: number): GndTpl {
    return this.tpl(`taxi:${stand}`, () => {
      const sx = this.L.sx[stand] as number;
      const tr = new Track([{ x: sx - PUSH_BACK, z: TW_Z }, { x: HOLD_X, z: TW_Z }], 0);
      const p = profile(tr, { v0: 0, v1: 0, vmax: () => 13, acc: 0.45, dec: () => 0.8 });
      return { tr, p, acts: [{ s: 0, act: '滑行出港' }], mark: { T: p.T } };
    });
  }

  /** 进跑道对正：从等待位置经起飞联络道两个 90° 转弯上跑道，在对正位置停住 */
  private lineupTpl(): GndTpl {
    return this.tpl('lineup', () => {
      const tr = new Track([{ x: HOLD_X, z: TW_Z }, { x: DEP_X, z: TW_Z }, { x: DEP_X, z: RW_Z }, { x: LU_X, z: RW_Z }], [TURN_R, TURN_R]);
      const p = profile(tr, { v0: 0, v1: 0, vmax: () => 8, acc: 0.4, dec: () => 0.7 });
      return { tr, p, acts: [{ s: 0, act: '进跑道对正' }], mark: { T: p.T, enter: firstT(p, tr, (_s, _v, _x, z) => z > RW_Z - 50) ?? p.T } };
    });
  }

  /** 按航段取位姿（只要位置和姿态；不管动作说明和襟翼） */
  private legPose(legs: Leg[], t: number, o: PlanePose): Leg | undefined {
    const n = legs.length;
    if (!n || t < (legs[0] as Leg).t0 || t >= (legs[n - 1] as Leg).t1) return undefined;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((legs[mid] as Leg).t0 <= t) lo = mid;
      else hi = mid - 1;
    }
    const g = legs[lo] as Leg;
    o.roll = 0;
    o.pitch = 0;
    o.y = 0;
    o.gear = true;
    if (g.k === 'h') {
      o.x = g.x;
      o.z = g.z;
      o.yaw = g.yaw;
    } else if (g.k === 'g') {
      const s = sAtT(g.g.p, t - g.t0);
      g.g.tr.at(s, this.atA);
      o.x = this.atA.x;
      o.z = this.atA.z;
      o.yaw = g.back ? this.atA.yaw + Math.PI : this.atA.yaw;
      // 接地后放前轮：机头从接地时的仰角在 5 秒里放平
      if (g.td && t - g.t0 < 5) o.pitch = PITCH_TD * (1 - ease((t - g.t0) / 5));
    } else {
      const a = g.a;
      const u = Math.max(0, (t - g.t0) / a.dt);
      const m = a.d.length / 7;
      const i = Math.min(m - 2, Math.floor(u));
      const f = Math.min(1, u - i);
      const b = i * 7;
      const d = a.d;
      o.x = ix(d, b) + (ix(d, b + 7) - ix(d, b)) * f;
      o.y = ix(d, b + 1) + (ix(d, b + 8) - ix(d, b + 1)) * f;
      o.z = ix(d, b + 2) + (ix(d, b + 9) - ix(d, b + 2)) * f;
      const y0 = ix(d, b + 3);
      o.yaw = y0 + wrapA(ix(d, b + 10) - y0) * f;
      o.pitch = ix(d, b + 4) + (ix(d, b + 11) - ix(d, b + 4)) * f;
      o.roll = ix(d, b + 5) + (ix(d, b + 12) - ix(d, b + 5)) * f;
      o.gear = ix(d, b + 6) > 0.5;
    }
    return g;
  }

  /** 一架飞机此刻的位姿、动作说明、襟翼和扰流板（不在场返回 false） */
  private evalPose(f: Flight, t: number, o: PlanePose): boolean {
    const g = this.legPose(f.legs, t, o);
    if (!g) return false;
    if (g.k === 'h') o.act = g.stand ? this.standAct(f, t) : g.act;
    else if (g.k === 'g') {
      const s = sAtT(g.g.p, t - g.t0);
      let act = '';
      for (const a of g.g.acts) if (a.s <= s) act = a.act;
      o.act = act;
    } else {
      let act = '';
      for (const a of g.a.acts) if (a.t <= t - g.t0) act = a.act;
      o.act = act;
    }
    // 襟翼：进近、着陆 30°，脱离后收；滑出时放起飞襟翼 15°，离地 25 秒后收。扰流板：接地升起，慢下来收
    let flap = 0;
    if (t < f.tVac + 30) flap = 30;
    else if (t < f.tVac + 60) flap = 30 * (1 - (t - f.tVac - 30) / 30);
    if (t >= f.tTaxi + 20) flap = 15 * clamp01((t - f.tTaxi - 20) / 20) * (1 - clamp01((t - f.tLof - 25) / 25));
    o.flap = flap;
    o.spoiler = t >= f.td && t < f.tStow + 4 ? 50 * clamp01((t - f.td) / 1.2) * (1 - clamp01((t - f.tStow) / 4)) : 0;
    return true;
  }

  /** 停在机位上的动作说明 */
  private standAct(f: Flight, t: number): string {
    const op = f.ops;
    if (!op) return '停机';
    if (t >= f.tOff - 900) return '准备推出';
    const first = op.xf[0];
    if (!first || t < first.t) return op.noLoader ? '停机 · 平台车没人开' : '停机 · 准备卸货';
    if (t < op.unloadEnd) return '卸货';
    if (t < op.loadEnd) return '装货';
    return '装卸完毕 · 等推出';
  }

  /** 候选航段在平行滑行道上的占用 */
  private occOf(legs: Leg[], t0: number, t1: number, ext: number): Occ {
    const i0 = Math.floor(t0 / OG);
    const i1 = Math.ceil(t1 / OG);
    const xs = new Float32Array(Math.max(1, i1 - i0 + 1)).fill(NaN);
    for (let i = i0; i <= i1; i++) {
      if (!this.legPose(legs, i * OG, this.tmp)) continue;
      // 机身中心离滑行道中线 70 米以内都算占着（推出、转进机位时机尾已经伸到滑行道上）
      if (this.tmp.y < 1 && Math.abs(this.tmp.z - TW_Z) < 70) xs[i - i0] = this.tmp.x;
    }
    return { i0, xs, ext };
  }

  /** 一架飞机的进场段：进近 → 着陆滑跑 → 脱离 →（在滑行道上等）→ 滑进机位 */
  private arrLegs(sp: Spec, stand: number, td: number, hold: number): { legs: Leg[]; tOn: number; tVac: number; tStow: number; tRev: number; occ: Occ } {
    const app = this.approachTpl(sp.kind, sp.side);
    const G = kg(sp.kind);
    const tp = this.arrTpl(sp.kind, stand, hold >= 0);
    const legs: Leg[] = [{ k: 'a', t0: td - app.T, t1: td, a: app }];
    const g0 = tp[0] as GndTpl;
    legs.push({ k: 'g', t0: td, t1: td + g0.p.T, g: g0, back: false, td: true });
    let t = td + g0.p.T;
    const g1 = tp[1];
    if (g1 && hold >= 0) {
      const end = g0.tr.at(g0.tr.len, this.atB);
      legs.push({ k: 'h', t0: t, t1: t + hold, x: end.x, z: end.z, yaw: end.yaw, act: '等待滑行', stand: false });
      t += hold;
      legs.push({ k: 'g', t0: t, t1: t + g1.p.T, g: g1, back: false, td: false });
      t += g1.p.T;
    }
    const tVac = td + (g0.mark.vac as number);
    return { legs, tOn: t, tVac, tStow: td + (g0.mark.stow as number), tRev: td + (g0.mark.rev as number), occ: this.occOf(legs, tVac - 40, t, G.ext) };
  }

  /** 一架飞机的离场段：推出 → 启动 → 滑到等待位置 →（等）→ 进跑道对正 →（等）→ 起飞、爬升转弯 */
  private depLegs(sp: Spec, stand: number, offPlan: number, C: Committed, arrEv: RwEv): { legs: Leg[]; tOff: number; tClear: number; tTaxi: number; tHp: number; tLu: number; tRoll: number; tLof: number; tClr: number; occ: Occ[]; ev: RwEv } | undefined {
    const G = kg(sp.kind);
    const push = this.pushTpl(sp.kind, stand);
    const taxi = this.taxiTpl(stand);
    const lu = this.lineupTpl();
    const tko = this.takeoffTpl(sp.kind, -sp.side);
    const sx = this.L.sx[stand] as number;
    for (let p = 0; p <= 2400; p += 30) {
      const tOff = offPlan + p;
      const tStart = tOff + push.p.T;
      const tTaxi = tStart + START;
      const tHp = tTaxi + taxi.p.T;
      const legs: Leg[] = [
        { k: 'g', t0: tOff, t1: tStart, g: push, back: true, td: false },
        { k: 'h', t0: tStart, t1: tTaxi, x: sx - PUSH_BACK, z: TW_Z, yaw: 0, act: '启动发动机', stand: false },
        { k: 'g', t0: tTaxi, t1: tHp, g: taxi, back: false, td: false },
      ];
      const occ1 = this.occOf(legs, tOff, tHp, G.ext);
      if (C.occ.some((o) => clash(o, occ1))) continue;
      for (let w = 20; w <= 1200; w += 10) {
        const luStart = tHp + w;
        const luEnd = luStart + lu.p.T;
        const tLu = luStart + (lu.mark.enter as number);
        let ev: RwEv | undefined;
        for (const wait of [10, 25, 45, 70, 100]) {
          const tRoll = luEnd + wait;
          const e: RwEv = { arr: false, thr: 0, vac: 0, lu: tLu, roll: tRoll, clr: tRoll + (tko.mark.clr as number) };
          if (rwOk(arrEv, e) && C.rw.every((x) => rwOk(x, e))) {
            ev = e;
            break;
          }
        }
        if (!ev) continue;
        const all: Leg[] = [...legs, { k: 'h', t0: tHp, t1: luStart, x: HOLD_X, z: TW_Z, yaw: 0, act: '跑道外等待', stand: false }, { k: 'g', t0: luStart, t1: luEnd, g: lu, back: false, td: false }, { k: 'h', t0: luEnd, t1: ev.roll, x: LU_X, z: RW_Z, yaw: Math.PI, act: '对正等待', stand: false }, { k: 'a', t0: ev.roll, t1: ev.roll + tko.T, a: tko }];
        const occ2 = this.occOf(all, tHp, luEnd, G.ext);
        if (C.occ.some((o) => clash(o, occ2))) break;
        return { legs: all, tOff, tClear: tOff + (push.mark.clear as number), tTaxi, tHp, tLu, tRoll: ev.roll, tLof: ev.roll + (tko.mark.lof as number), tClr: ev.clr, occ: [occ1, occ2], ev };
      }
    }
    return undefined;
  }

  /**
   * 排一架飞机：本店的航班接地时刻不动；别的航班按想要的时刻往后错（每次 1 分钟，最多 1 小时）找跑道空档。
   * 机位按空出来的先后挑；滑入在滑行道上撞车就先在脱离道口后面等一会；推出撞车就晚点推；进跑道按跑道的间隔规则等。
   */
  private tryPlan(sp: Spec, C: Committed): Flight | undefined {
    const app = this.approachTpl(sp.kind, sp.side);
    const G = kg(sp.kind);
    const g0 = (this.arrTpl(sp.kind, 0, false)[0] as GndTpl).mark;
    const lastEnd = (st: number) => C.stands[st]?.reduce((a, u) => Math.max(a, u.b), -Infinity) ?? -Infinity;
    const order = this.L.sx.map((_, i) => i).sort((a, b) => lastEnd(a) - lastEnd(b) || a - b);
    for (let dly = 0; dly <= (sp.own ? 0 : 3600); dly += 60) {
      const td = sp.td + dly;
      const tThr = td - app.T + (app.mark.thr as number);
      const arrEv: RwEv = { arr: true, thr: tThr, vac: td + (g0.vac as number), lu: 0, roll: 0, clr: 0 };
      if (!C.rw.every((e) => rwOk(e, arrEv))) continue;
      for (const st of order) {
        const list = C.stands[st] as { a: number; b: number }[];
        const estOff = sp.own ? sp.offPlan : td + 300 + sp.ground;
        if (busyAt(list, td + 60, estOff + 300)) continue;
        let arr: ReturnType<AirportOps['arrLegs']> | undefined;
        for (const hold of [-1, 15, 40, 80, 140, 220, 320, 450]) {
          const c = this.arrLegs(sp, st, td, hold);
          if (!C.occ.some((o) => clash(o, c.occ))) {
            arr = c;
            break;
          }
        }
        if (!arr) continue;
        const offPlan = Math.max(sp.own ? sp.offPlan : arr.tOn + sp.ground, arr.tOn + 50 * 60);
        if (busyAt(list, arr.tOn - 90, offPlan + 150)) continue;
        const dep = this.depLegs(sp, st, offPlan, C, arrEv);
        if (!dep) continue;
        if (busyAt(list, arr.tOn - 90, dep.tClear + 20)) continue;
        const sx = this.L.sx[st] as number;
        const legs: Leg[] = [...arr.legs, { k: 'h', t0: arr.tOn, t1: dep.tOff, x: sx, z: NOSE_Z + G.nose, yaw: Math.PI / 2, act: '', stand: true }, ...dep.legs];
        const last = legs[legs.length - 1] as Leg;
        const f: Flight = {
          vid: sp.vid,
          own: sp.own,
          id: sp.id,
          label: sp.label,
          kind: sp.kind,
          livery: sp.livery,
          stand: st,
          legs,
          tApp: td - app.T,
          tThr,
          td,
          tStow: arr.tStow,
          tRev: arr.tRev,
          tVac: arr.tVac,
          tOn: arr.tOn,
          offPlan,
          tOff: dep.tOff,
          tClear: dep.tClear,
          tTaxi: dep.tTaxi,
          tHp: dep.tHp,
          tLu: dep.tLu,
          tRoll: dep.tRoll,
          tLof: dep.tLof,
          tClr: dep.tClr,
          tEnd: last.t1,
          nIn: sp.nIn,
          nOut: sp.nOut,
          delayIn: dly,
          delayOut: dep.tOff - offPlan,
          nextOn: Infinity,
          pose: newPose(),
        };
        C.rw.push(arrEv, dep.ev);
        C.occ.push(arr.occ, ...dep.occ);
        list.push({ a: arr.tOn - 90, b: dep.tClear + 20 });
        return f;
      }
    }
    return undefined;
  }

  /**
   * 当天的航班：区域车辆里 kind = plane 的（本店的货运航班，接地和撤轮挡照仿真），加上其他货运航班——
   * 按机位数和负荷档位定班数（平常机位约六成时间有飞机，负荷越高越密），落地时刻在全天（含前一天晚上落地、
   * 早上才走的）均匀撒开，三种机型、过站 1.6–3.6 小时。同一个编号每次排出来一样。
   */
  setDay(planes: { vid: number; v: WVehicle }[], seed: number, traffic = 1, trucks: { vid: number; v: WVehicle }[] = []): void {
    drain(this.daySteps(planes, seed, traffic, trucks));
  }
  /** 正在分段排这一天（daySteps）：排完以前不画（不画到一半的计划） */
  private planning = false;
  /** 和 setDay 一样排一天，分成几段（航班和地面作业、货站、陆侧卡车场各一段）：先后、结果都和一口气排完一样 */
  *daySteps(planes: { vid: number; v: WVehicle }[], seed: number, traffic = 1, trucks: { vid: number; v: WVehicle }[] = []): Steps {
    this.planning = true;
    try {
      yield* this.planDay(planes, seed, traffic, trucks);
    } finally {
      this.planning = false;
    }
  }
  private *planDay(planes: { vid: number; v: WVehicle }[], seed: number, traffic: number, trucks: { vid: number; v: WVehicle }[]): Steps {
    const cfg = currentFacilities().airport;
    const L = layoutFor(cfg.stands ?? 2);
    if (L.n !== this.L.n) {
      this.L = L;
      this.rebuildStatic();
    }
    this.cache.clear();
    const N = Math.max(4, Math.min(28, Math.round(cfg.uldsPerFlight)));
    const specs: Spec[] = [];
    for (const { vid, v } of planes) {
      const seg = (a: string) => v.segs.find((s) => s.act === a);
      const gnd = seg('卸货');
      const land = seg('减速')?.t0 ?? seg('进近降落')?.t1 ?? (gnd ? gnd.t0 - 0.15 * H : undefined);
      if (land === undefined) continue;
      specs.push({ own: true, vid, kind: OWN_KIND, td: land, offPlan: gnd?.t1 ?? land + 3 * H, ground: 0, side: vid % 2 ? 1 : -1, livery: OWN_LIVERY, nIn: N, nOut: Math.round(N * 0.7), label: v.label, id: '' });
    }
    specs.sort((a, b) => a.td - b.td);
    const r = rng(seed * 977 + 13 + L.n * 7919);
    const util = Math.min(0.9, 0.62 + 0.15 * Math.max(0, traffic - 1));
    const want = Math.max(3, Math.round((L.n * 24 * util) / 2.6) - specs.length);
    const span0 = -5 * H;
    const span1 = 23.7 * H;
    const step = (span1 - span0) / want;
    const bg: Spec[] = [];
    for (let k = 0; k < want; k++) {
      const td = span0 + (k + 0.2 + 0.6 * r()) * step;
      const u = r();
      const ki = u < 0.3 ? 0 : u < 0.75 ? 1 : 2;
      const K = KINDS[ki] as Kind;
      const ground = (K.ground[0] + r() * (K.ground[1] - K.ground[0])) * H;
      const load = 0.55 + 0.4 * r();
      bg.push({ own: false, vid: -(k + 1), kind: ki, td, offPlan: 0, ground, side: r() < 0.5 ? 1 : -1, livery: LIVERIES[Math.floor(r() * LIVERIES.length)] as string, nIn: Math.round(K.ulds * load), nOut: Math.round(K.ulds * (0.45 + 0.4 * r())), label: `其他货运航班 · ${K.name}`, id: '' });
    }
    const C: Committed = { rw: [], occ: [], stands: L.sx.map(() => []) };
    const flights: Flight[] = [];
    for (const sp of specs) {
      const f = this.tryPlan(sp, C) ?? this.tryPlan(sp, { rw: [], occ: [], stands: L.sx.map(() => []) });
      if (f) flights.push(f);
    }
    this.dropped = 0;
    for (const sp of bg) {
      const f = this.tryPlan(sp, C);
      if (!f) {
        this.dropped++;
        continue;
      }
      const hh = Math.round(f.td / 60);
      f.id = `B${String(Math.floor((((hh % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}${String((((hh % 60) + 60) % 60)).padStart(2, '0')}${f.td < 0 ? '-1' : ''}`;
      flights.push(f);
    }
    flights.sort((a, b) => a.td - b.td);
    for (const f of flights) f.nextOn = flights.reduce((m, g) => (g !== f && g.stand === f.stand && g.tOn > f.tOn && g.tOn < m ? g.tOn : m), Infinity);
    this.flights = flights;
    // 本店每班航班的货有几板：这班落地以后、下一班落地以前装车的本店冷藏车装的板数（决定几块是本店的板）
    this.ownPallets.clear();
    const ownF = flights.filter((f) => f.own).sort((a, b) => a.td - b.td);
    for (const { v } of trucks) {
      const sg = v.segs.find((x) => x.act === '在机场货站装车');
      const f = sg ? [...ownF].reverse().find((x) => x.td < sg.t0) : undefined;
      if (f) this.ownPallets.set(f.vid, (this.ownPallets.get(f.vid) ?? 0) + Number(/(\d+) 托/.exec(v.label)?.[1] ?? 6));
    }
    yield;
    this.planOps(cfg.staff, cfg.dollySets, seed);
    for (const f of this.flights) if (f.ops) f.ops.doorWait = AirportOps.doorQueue(f.ops, Math.min(f.tOff + 600, f.nextOn - 150));
    this.planDepot();
    yield;
    yield* this.planTerminal(trucks, seed, traffic, cfg.staff);
  }

  /**
   * 货站一天的作业（src/hub/airport.ts）：板车串推进门、从门里拉出的每一块板，本店空运冷藏车的装车时段（仿真），
   * 拆组板的排班。陆侧收货口的车（货代的提货车、送货车、整板卡车）也由它排：ops/extTrucks.ts 按这些时刻把车开来开走。
   */
  private *planTerminal(trucks: { vid: number; v: WVehicle }[], seed: number, traffic: number, staff: Role[]): Steps {
    const fid = (f: Flight) => (f.own ? `V${f.vid}` : f.id);
    const flights: AirTermInput['flights'] = [];
    const arrivals: AirTermInput['arrivals'] = [];
    const departures: AirTermInput['departures'] = [];
    for (const f of this.flights) {
      flights.push({ id: fid(f), label: f.label, own: f.own, tOn: f.tOn, tOff: f.tOff, stand: f.stand, land: f.td });
      const op = f.ops;
      if (!op) continue;
      for (const u of op.xf) {
        const tr = op.trips[u.trip];
        if (!tr) continue;
        if (u.out) arrivals.push({ id: u.id, flight: fid(f), own: u.store, lane: f.stand, t: tr.tArr + 25 + u.slot * 50 + 11 + this.along(u.slot) });
        else departures.push({ id: u.id, flight: fid(f), lane: f.stand, t: tr.tPrep + 25 + u.slot * 50 });
      }
    }
    const own: AirTermInput['ownTrucks'] = [];
    this.simVisits.clear();
    for (const { vid, v } of trucks) {
      const sg = v.segs.find((x) => x.act === '在机场货站装车');
      if (!sg) continue;
      // 靠稳、拉出的时刻和运动规划算的一样（仿真的时段包括进场、倒车和驶出）
      const yd = registerLandsideYard(this.termLayout, FRAMES.airport);
      const base = simVisitFor(AIR_YARD, vid, v.segs.indexOf(sg), 'reefer', yd.plan.doors.findIndex((d) => d.id === this.termLayout.docks[this.termLayout.simDock]?.id), sg.t0, sg.t1);
      if (base) this.simVisits.set(vid, base);
      own.push({ id: /AT-\d+/.exec(v.label)?.[0] ?? `AT-${own.length + 1}`, label: v.label, vid, t0: base?.dockAt ?? sg.t0, t1: base?.leaveAt ?? sg.t1, pallets: Number(/(\d+) 托/.exec(v.label)?.[1] ?? 10) });
    }
    const hourOf = (t: number) => (((t / H) % 24) + 24) % 24;
    this.termPlan = planAirTerminal({ seed, traffic, layout: this.termLayout, flights, arrivals, departures, ownTrucks: own, crew: (t) => crewOf(staff, 'build', shiftOf(hourOf(t))) });
    yield;
    this.planYardDay(trucks, { seed, traffic, layout: this.termLayout, flights, arrivals, departures, ownTrucks: own, crew: (t) => crewOf(staff, 'build', shiftOf(hourOf(t))) });
    yield;
    // 货站里叉车闲着的样子要排一阵：分段排
    yield* this.term.setPlanSteps(this.termPlan);
    this.visits = this.termPlan.trucks
      .filter((tr) => !tr.own)
      .map((tr) => ({ dock: tr.dock, plan: tr.plan, t0: tr.t0, t1: tr.t1, reefer: tr.kind === 'reefer', arrive: tr.arrive, kind: tr.kind, dir: tr.dir, label: tr.label, id: tr.id }));
  }

  /**
   * 陆侧卡车场（收货场引擎）：按货站的布局排车道、登记场地（区域的运动规划按它把本店的空运冷藏车开进来、倒车靠上冷链 1 号门），
   * 今天所有的车（货代的车和本店的冷藏车）排一份场内的时刻：先到先进待命车道，场里一段一次一辆车调车，从司机一侧倒车靠台。
   * 场里实际靠上、离开的时刻再套回货站的计划（排队、在场的指标和画面一样）。
   */
  private planYardDay(trucks: { vid: number; v: WVehicle }[], input: AirTermInput): void {
    const plan = this.termPlan;
    if (!plan) return;
    const yd = registerLandsideYard(this.termLayout, FRAMES.airport);
    const yp = yd.plan;
    this.yardPlan = yp;
    this.yardFrame = yd.frame;
    if (this.builtYard !== yp) {
      this.builtYard = yp;
      this.term.buildYard(yp, yd.origin);
    }
    const doorOf = (i: number) => Math.max(0, yp.doors.findIndex((d) => d.id === this.termLayout.docks[i]?.id));
    const veh = (k: string): YardVehicle => (k === 'reefer' ? 'reefer' : k === 'truck' ? 'truck' : k === 'van' ? 'van' : 'semi');
    const truckOf = new Map<string, AirTermPlan['trucks'][number]>();
    const visits: YardVisit[] = plan.trucks.map((tr) => {
      // 本店的冷藏车用运动规划认得的编号和时刻（车辆编号 + 停在货站的那一段）
      if (tr.own && tr.vid !== undefined) {
        const v = trucks.find((x) => x.vid === tr.vid)?.v;
        const id = simVisitId(tr.vid, v ? v.segs.findIndex((sg) => sg.act === '在机场货站装车') : 0);
        const base = this.simVisits.get(tr.vid);
        truckOf.set(id, tr);
        return { id, vehicle: 'reefer' as YardVehicle, door: doorOf(tr.dock), arrive: base?.arrive ?? tr.t0 - 600, dockAt: tr.t0, leaveAt: tr.t1, own: true };
      }
      truckOf.set(tr.id, tr);
      return { id: tr.id, vehicle: veh(tr.kind), door: doorOf(tr.dock), arrive: Math.min(tr.arrive, tr.t0 - 900), dockAt: tr.t0, leaveAt: tr.t1, own: false };
    });
    setSiteVisits(AIR_YARD, visits);
    const sched = siteSchedule(AIR_YARD) ?? scheduleYard(yp, visits);
    this.yardSched = sched;
    const times = new Map<string, { arrive: number; docked: number; gone: number }>();
    for (const tl of sched.timelines) {
      const tr = tl && truckOf.get(tl.visit.id);
      if (tr) times.set(tr.id, { arrive: tl.visit.arrive, docked: tl.dockedAt, gone: tl.goneAt });
    }
    applyYardTimes(plan, input, times);
  }

  /** 陆侧卡车场：车道布置、今天的场内时刻（ext 画货代的车）、场地坐标系 */
  yard(): { key: string; plan: YardPlan; sched: YardSchedule; frame: YardFrame } | undefined {
    return this.yardPlan && this.yardSched && this.yardFrame ? { key: AIR_YARD, plan: this.yardPlan, sched: this.yardSched, frame: this.yardFrame } : undefined;
  }

  /** 板车停在货站门口时第 j 车离门有多远（秒，横推过去的时间） */
  private along(j: number): number {
    return Math.abs(6.6 - 4.4 * j) / 1.5;
  }

  /** 本店的一块板在货站里走过的步骤（存进 ETV、拆板、进冷藏库、装上本店的冷藏车） */
  private termSteps(id: string): { t: number; text: string }[] {
    const plan = this.termPlan;
    const u = plan?.ulds.find((x) => x.id === id);
    if (!plan || !u) return [];
    const out: { t: number; text: string }[] = [];
    if (u.tStored !== undefined) out.push({ t: u.tStored, text: 'ETV 存进板架（生鲜优先拆板）' });
    if (u.tJob0 !== undefined) out.push({ t: u.tJob0, text: `在 ${(u.station ?? 0) + 1} 号工位拆板` });
    const ps = u.pallets.map((pi) => plan.pallets[pi]).filter((p): p is NonNullable<typeof p> => !!p);
    const cold = ps.map((p) => p.tIn).filter((x): x is number => x !== undefined);
    const mine = ps.filter((p) => p.own).length;
    if (cold.length) out.push({ t: Math.max(...cold), text: `拆出 ${ps.length} 板货（本店的 ${mine} 板），叉车送进冷藏库（2–8 °C）` });
    const tr = ps[0]?.truck !== undefined ? plan.trucks[ps[0].truck] : undefined;
    if (tr) out.push({ t: tr.t0, text: `${tr.id} 靠上冷链门，装车（${tr.label}）` });
    return out;
  }

  /**
   * 货站这一天的 HubDay（值班助手、看板用）。idOf：仿真车辆 → 调度台的作业编号（本店的航班、空运冷藏车按它写 carrierIn / carrierOut，
   * 值班助手按作业编号把货站里的排队、拆板接到那一趟车上）
   */
  hub(idOf?: (vid: number) => string | undefined): HubDay | undefined {
    const plan = this.termPlan;
    if (!plan) return undefined;
    if (!idOf) return plan.hub;
    const ids = new Map<string, string>();
    for (const tr of plan.trucks) if (tr.own && tr.vid !== undefined) {
      const id = idOf(tr.vid);
      if (id) ids.set(tr.id, id);
    }
    for (const f of this.flights) if (f.own) {
      const id = idOf(f.vid);
      if (id) ids.set(`V${f.vid}`, id);
    }
    const map = (x: string | undefined) => (x !== undefined ? (ids.get(x) ?? x) : x);
    return { ...plan.hub, flows: plan.hub.flows.map((fl) => (ids.has(fl.carrierIn ?? '') || ids.has(fl.carrierOut ?? '') ? { ...fl, ...(fl.carrierIn !== undefined ? { carrierIn: map(fl.carrierIn) } : {}), ...(fl.carrierOut !== undefined ? { carrierOut: map(fl.carrierOut) } : {}) } : fl)) };
  }

  /** 陆侧收货口（局部坐标：门面中点）和今天外来货车的装卸（按靠上的先后） */
  dockVisits(): { docks: { x: number; z: number }[]; visits: DockVisit[]; yard?: { key: string; plan: YardPlan; sched: YardSchedule; frame: YardFrame } } {
    const yard = this.yard();
    return { docks: this.termLayout.docks.map((d) => ({ x: d.x, z: TERM.zLand - 0.6 })), visits: this.visits.slice().sort((a, b) => a.t0 - b.t0), ...(yard ? { yard } : {}) };
  }

  /**
   * 机位上的地面保障按班组排（本店的航班优先）：平台车一班几个司机就最多几架同时卸装，都在忙就等；
   * 加油车同样；每架飞机开几套板车 = 牵引车司机 ÷ 同时在场的飞机数（至少 1 套，最多设施配置的套数）。
   */
  private planOps(staff: Role[], dollySets: number, seed: number): void {
    const hourOf = (t: number) => (((t / H) % 24) + 24) % 24;
    const cap = (key: string) => (t: number) => crewOf(staff, key, shiftOf(hourOf(t)));
    const capL = cap('loader');
    const capF = cap('fuel');
    const order = [...this.flights].sort((a, b) => (a.own === b.own ? a.tOn - b.tOn : a.own ? -1 : 1));
    const lJobs: { a: number; b: number }[] = [];
    const fJobs: { a: number; b: number }[] = [];
    const slot = (jobs: { a: number; b: number }[], c: (t: number) => number, a0: number, dur: number, latest: number): number | undefined => {
      const cands = [a0, ...jobs.map((j) => j.b).filter((b) => b > a0)].sort((x, y) => x - y);
      for (const a of cands) {
        if (a > latest) break;
        const b = a + dur;
        const lim = Math.min(c(a), c(b));
        if (lim <= 0) continue;
        let peak = 0;
        for (const pt of [a, ...jobs.filter((j) => j.a > a && j.a < b).map((j) => j.a)]) peak = Math.max(peak, jobs.filter((j) => j.a <= pt && j.b > pt).length);
        if (peak < lim) return a;
      }
      return undefined;
    };
    for (const f of order) {
      const conc = Math.max(1, ...this.flights.filter((g) => g.tOn < f.tOff && f.tOn < g.tOff).map((g) => this.flights.filter((h) => h.tOn <= g.tOn && g.tOn < h.tOff && h.tOn < f.tOff && f.tOn < h.tOff).length));
      const tugs = crewOf(staff, 'tug', shiftOf(hourOf(f.tOn)));
      const S = Math.max(1, Math.min(3, Math.round(dollySets), Math.floor(tugs / conc)));
      const est = Math.min(f.tOff - f.tOn - 1500, (f.nIn + f.nOut) * CYCLE + 1500);
      const la = slot(lJobs, capL, f.tOn + 120, est, f.tOff - 45 * 60);
      const K = kg(f.kind).k;
      const fa = slot(fJobs, capF, f.tOn + 420, K.fuel * 60 + 300, f.tOff - K.fuel * 60 - 1200);
      const r = rng(seed * 31 + Math.round(f.td) * 7 + f.stand);
      const op = this.buildOps(f, S, la, fa, r);
      f.ops = op;
      if (op.lo) lJobs.push({ a: op.lo.in0, b: op.lo.out1 });
      if (op.fuel) fJobs.push({ a: op.fuel.in0, b: op.fuel.out1 });
    }
  }

  /** 一架飞机在机位上的地面作业：平台车、板车串（卸货趟、装货趟）、加油车、推出车 */
  private buildOps(f: Flight, S: number, loaderA: number | undefined, fuelA: number | undefined, r: () => number): Ops {
    const G = kg(f.kind);
    const sx = this.L.sx[f.stand] as number;
    const cx = sx;
    const cz = NOSE_Z + G.nose;
    const T0 = f.tOn;
    const T1 = f.tOff;
    const deadline = Math.min(f.offPlan, T1) - 25 * 60;
    // 板车路线（都带引入段）：装板位置在平台车后面（左机翼后缘下）；满载往 −z 开到货站门前的行车道、往 +x 停到这个机位的大门；
    // 空车继续往 +x，从两个机位之间的设备通道开到机尾后面的服务车道，往 −x 到排队点，再转进平台车后面
    const wx = cx + G.wait;
    const wz = cz - G.doorX;
    const dockX = this.L.dock[f.stand] as number;
    const lane = sx + 46;
    const rt = {
      toTerm: new Poly(rounded(leadIn([{ x: wx, z: wz - 16.8 }, { x: wx, z: LANE_Z }, { x: dockX + 10.2, z: LANE_Z }], LEAD), 8)),
      back: new Poly(rounded(leadIn([{ x: dockX + 10.2, z: LANE_Z }, { x: lane, z: LANE_Z }, { x: lane, z: TAIL_Z }, { x: wx + 30, z: TAIL_Z }], LEAD), 8)),
      pull: new Poly(rounded(leadIn([{ x: wx + 30, z: TAIL_Z }, { x: wx, z: TAIL_Z }, { x: wx, z: wz - 16.8 }], LEAD), 8)),
      dockX,
      door: this.L.doors.indexOf(dockX) + 1,
    };
    const SPEED = 5;
    const tB = (rt.back.len - LEAD) / SPEED + 10;
    const tP = (rt.pull.len - 13.2 - LEAD) / 3 + 8;
    const tA = (rt.toTerm.len - LEAD) / SPEED + 10;
    const xf: Xfer[] = [];
    const trips: Trip[] = [];
    let lo: Ops['lo'];
    let unloadEnd = T0;
    let loadEnd = T0;
    if (loaderA !== undefined) {
      const in0 = loaderA;
      const in1 = in0 + 150;
      const up1 = in1 + 60;
      // 板：先卸（本店的航班里第 4 块起是本店的：本店的货每 6 板一块主货舱板，最多 2 块），再装出口的
      const storeN = f.own ? Math.max(1, Math.min(2, Math.ceil((this.ownPallets.get(f.vid) ?? 6) / 6))) : 0;
      const items: { out: boolean; store: boolean; id: string }[] = [];
      const code = () => String(30000 + Math.floor(r() * 69999)).padStart(5, '0');
      for (let i = 0; i < f.nIn; i++) {
        const store = i >= 3 && i < 3 + storeN;
        items.push({ out: true, store, id: `PMC ${code()} ${store ? 'SX' : (['X1', 'X2', 'X3', 'X4'][Math.floor(r() * 4)] as string)}` });
      }
      for (let i = 0; i < f.nOut; i++) items.push({ out: false, store: false, id: `PMC ${code()} E${1 + Math.floor(r() * 4)}` });
      let cursor = up1 + 60;
      let idx = 0;
      for (let k = 0; idx < items.length; k++) {
        const mode = (items[idx] as { out: boolean }).out;
        const prev = trips[k - 1];
        const same = trips[k - S];
        if (prev && prev.out && !mode) cursor += SWITCH;
        let tApp: number;
        let tPull: number;
        let tPrep: number;
        if (same) {
          tPrep = same.tDone;
          tApp = mode ? same.tDone : same.tDone + DOCK;
          tPull = Math.max(prev ? prev.t0 + 10 : -Infinity, tApp + tB);
        } else {
          tPull = prev ? prev.t0 + 10 : mode ? cursor + XFER - 60 - tP : cursor - 20 - tP;
          tApp = tPull - tB - 20;
          tPrep = tApp - DOCK;
        }
        const tReady = tPull + tP;
        const mine: Xfer[] = [];
        for (let j = 0; j < 4 && idx < items.length && (items[idx] as { out: boolean }).out === mode; j++, idx++) {
          const it = items[idx] as { out: boolean; store: boolean; id: string };
          const base = cursor + r() * 20;
          const t = Math.max(base, j === 0 ? (mode ? tReady + 20 - XFER : tReady + 20) : -Infinity);
          if (t > deadline) {
            idx = items.length;
            break;
          }
          mine.push({ id: it.id, store: it.store, out: mode, t, trip: k, slot: j });
          cursor = t + CYCLE;
        }
        const last = mine[mine.length - 1];
        if (!last) break;
        xf.push(...mine);
        const t0 = mode ? last.t + XFER + 40 : last.t + 30;
        const tArr = t0 + tA;
        trips.push({ k, set: k % S, out: mode, tPrep, tApp, tQ: tApp + tB, tPull, tReady, t0, tArr, tDone: tArr + (mode ? DOCK : 10), park: false, xs: mine });
      }
      // 最后一趟留在货站门口；其他套的最后一趟回排队点停着（一前一后排开）
      const lastT = trips[trips.length - 1];
      let ps = 0;
      for (let set = 0; set < S; set++) {
        const own = trips.filter((x) => x.set === set);
        for (let i = 0; i + 1 < own.length; i++) (own[i] as Trip).next = (own[i + 1] as Trip).k;
        const fin = own[own.length - 1];
        if (fin && fin !== lastT) {
          fin.park = true;
          fin.parkSlot = ps++;
        }
      }
      const lastX = xf[xf.length - 1];
      const done = lastX ? lastX.t + XFER + 20 : up1;
      const lastIn = [...xf].reverse().find((u) => u.out);
      unloadEnd = lastIn ? lastIn.t + XFER : up1;
      loadEnd = done;
      lo = { in0, in1, up1, close0: done + 20, close1: done + 80, down0: done + 90, down1: done + 150, out0: done + 160, out1: done + 280, sw: lastIn ? lastIn.t + XFER + 60 : up1 };
    }
    // 加油车：从这个机位 −x 一侧的设备通道开到服务车道，再转进左机翼下（工作台对着加油口），加完往 −z 开出去
    let fuel: Ops['fuel'];
    if (fuelA !== undefined) {
      const fx = cx + G.fuelZ;
      const pz = cz + 6;
      const inP = new Poly(rounded([{ x: sx - 86, z: LANE_Z }, { x: sx - 46, z: LANE_Z }, { x: sx - 46, z: TAIL_Z }, { x: fx, z: TAIL_Z }, { x: fx, z: pz }], 7));
      const outP = new Poly(rounded([{ x: fx, z: pz }, { x: fx, z: LANE_Z }, { x: sx - 86, z: LANE_Z }], 7));
      const in1 = fuelA + inP.len / 4 + 6;
      const out0 = Math.min(in1 + kg(f.kind).k.fuel * 60, T1 - 900);
      fuel = { in0: fuelA, in1, out0, out1: out0 + outP.len / 4 + 6, inP, outP };
    }
    // 推出车：撤轮挡前 15 分钟从设备通道开过来，停在机头前面
    const tz = cz - G.gearX - 12;
    const tugIn = new Poly(rounded([{ x: lane, z: LANE_Z - 0.5 }, { x: sx, z: LANE_Z - 0.5 }, { x: sx, z: tz }], 6));
    const tin0 = T1 - 900;
    return { cx, cz, xf, trips, S, rt, ...(lo ? { lo } : {}), ...(fuel ? { fuel } : {}), tug: { in0: tin0, in1: tin0 + tugIn.len / 3 + 4, inP: tugIn }, unloadEnd, loadEnd, noLoader: loaderA === undefined, noFuel: fuelA === undefined };
  }

  /** 某架飞机此刻的位姿（区域车辆层用它拾取、跟随、跟踪；局部坐标） */
  pose(vid: number, t: number): AirPose | undefined {
    const f = this.flights.find((x) => x.vid === vid);
    if (!f) return undefined;
    const o = newPose();
    if (!this.evalPose(f, t, o)) return undefined;
    return { x: o.x, y: o.y, z: o.z, yaw: o.yaw, pitch: o.pitch, roll: o.roll, gear: o.gear, act: o.act, parked: t >= f.tOn && t < f.tOff };
  }

  /** 某架飞机当天的整条路线（局部坐标：进近、滑跑、滑行、推出、起飞爬升），选中时画出来 */
  route(vid: number): { x: number; y: number; z: number }[][] {
    const f = this.flights.find((x) => x.vid === vid);
    if (!f) return [];
    const out: { x: number; y: number; z: number }[][] = [];
    for (const g of f.legs) {
      if (g.k === 'h') continue;
      const pts: { x: number; y: number; z: number }[] = [];
      if (g.k === 'a') for (let i = 0; i < g.a.d.length; i += 7 * 8) pts.push({ x: ix(g.a.d, i), y: ix(g.a.d, i + 1), z: ix(g.a.d, i + 2) });
      else
        for (let s = 0; s <= g.g.tr.len + 4; s += 8) {
          g.g.tr.at(Math.min(s, g.g.tr.len), this.atT);
          pts.push({ x: this.atT.x, y: 0, z: this.atT.z });
        }
      if (pts.length > 1) out.push(pts);
    }
    return out;
  }

  /** 鼠标拾取任意一架飞机（别家的航班也算，编号是负数）：编号、是不是本店的、离镜头多远 */
  pickAny(ray: THREE.Raycaster): { vid: number; own: boolean; dist: number } | undefined {
    let best: { vid: number; own: boolean; dist: number } | undefined;
    this.bodies.forEach((pool, pi) => {
      if (!pool.mesh.count) return;
      const hit = ray.intersectObject(pool.mesh, false)[0];
      if (hit?.instanceId === undefined || (best && hit.distance >= best.dist)) return;
      const fi = (this.pickMap[pi] as Int32Array)[hit.instanceId];
      const f = fi === undefined ? undefined : this.flights[fi];
      if (f) best = { vid: f.vid, own: f.own, dist: hit.distance };
    });
    return best;
  }

  /** 一架飞机此刻的说明（悬停、跟随时显示）：航班号、机型、在做什么、是不是本店的 */
  card(vid: number, t: number): { name: string; type: string; act: string; own: boolean } | undefined {
    const f = this.flights.find((x) => x.vid === vid);
    if (!f) return undefined;
    return { name: f.id || f.label, type: kg(f.kind).k.name, act: this.statusOf(f, t).status, own: f.own };
  }

  /** 一架飞机此刻在做什么（监控面板、悬停说明共用） */
  private statusOf(f: Flight, t: number): { status: string; phase: 'due' | 'air' | 'ground' | 'gone' } {
    if (!this.evalPose(f, t, this.tmp)) return t < f.tApp ? { status: '未到', phase: 'due' } : { status: '已离场', phase: 'gone' };
    if (t < f.tOn || t >= f.tOff) return { status: this.tmp.act, phase: this.tmp.y > 1 ? 'air' : 'ground' };
    const op = f.ops;
    const ins = op ? op.xf.filter((u) => u.out) : [];
    const outs = op ? op.xf.filter((u) => !u.out) : [];
    const done = ins.filter((u) => u.t + XFER <= t).length;
    const loaded = outs.filter((u) => u.t + XFER <= t).length;
    const first = ins[0] ?? outs[0];
    const status = !first || t < first.t ? (op?.noLoader ? '停机 · 平台车没人开' : '停机、开舱门、平台车靠上') : t < (op as Ops).unloadEnd ? `卸板 ${done}/${ins.length}` : t < (op as Ops).loadEnd ? `装板 ${loaded}/${outs.length}` : t >= f.tOff - 900 ? '准备推出' : '装卸完毕';
    return { status, phase: 'ground' };
  }

  // —— 每帧 ——
  /** cam：机场局部坐标里的镜头位置（拉近货站时打开屋面、画库内） */
  /** 货站库内各区的名字（机场局部坐标，离地 6 米）：镜头拉近、打开屋面时显示 */
  zoneLabels(): { text: string; x: number; y: number; z: number }[] {
    const L = (this.term as unknown as { L?: { rooms: { key: string; x0: number; x1: number; z0: number; z1: number }[] } }).L;
    if (!L) return [];
    const names: Record<string, string> = { etv: 'ETV 立体库', work: '拆板/组板区', chill: '冷藏库', frozen: '冷冻库', dg: '危险品库', vault: '贵重品库', xray: '安检', customs: '海关监管区' };
    return L.rooms.filter((r) => names[r.key]).map((r) => ({ text: names[r.key] as string, x: (r.x0 + r.x1) / 2, y: 6, z: (r.z0 + r.z1) / 2 }));
  }

  /** 机坪上的车：画车身，夜里加上大灯、尾灯 */
  private lit(pool: Pool, x: number, y: number, z: number, yaw: number, pitch = 0, sx = 1, sy = 1, sz = 1, color?: THREE.ColorRepresentation): void {
    pool.put(x, y, z, yaw, pitch, sx, sy, sz, color);
    if (this.apronSt.night) this.apronLamps.part(this.apronSpec.get(pool), x, y, z, yaw, sx, true, true, this.apronSt);
  }

  update(t: number, scale: number, cam?: { x: number; y: number; z: number }): void {
    if (this.planning) return;
    this.apronLamps.begin(t);
    this.apronSt.night = isNight(t);
    try {
      this.updateInner(t, scale, cam);
    } finally {
      this.apronLamps.end();
    }
  }
  private updateInner(t: number, scale: number, cam?: { x: number; y: number; z: number }): void {
    this.term.setCamera(cam);
    this.term.update(t);
    for (const p of this.pools()) p.begin();
    this.flaps.begin();
    this.spoilers.begin();
    this.pickN.fill(0);
    this.poses.clear();
    const sc = Math.min(2.5, Math.max(1, scale / 2.5));
    for (let fi = 0; fi < this.flights.length; fi++) {
      const f = this.flights[fi] as Flight;
      if (t < f.tApp || t >= f.tEnd) continue;
      const pose = f.pose;
      if (!this.evalPose(f, t, pose)) continue;
      this.poses.set(f.vid, pose);
      const G = kg(f.kind);
      // 远镜头放大（看得见）；在地面上最多放大到 1.25 倍，免得停着的飞机翼尖碰到一起
      const big = pose.y > 2 ? sc : Math.min(sc, 1.25);
      // 俯仰绕主起落架转（不是绕机身中心）：抬头、拉平时主轮不陷进道面
      if (pose.pitch > 0) pose.y += -G.mainX * Math.sin(pose.pitch);
      const bi = f.kind * 2 + (pose.gear ? 0 : 1);
      const body = this.bodies[bi] as Pool;
      const n = this.pickN[bi] as number;
      if (n < body.capacity) {
        (this.pickMap[bi] as Int32Array)[n] = fi;
        this.pickN[bi] = n + 1;
      }
      body.put(pose.x, pose.y, pose.z, pose.yaw, pose.pitch, big, big, big, undefined, pose.roll);
      (this.liveries[f.kind] as Pool).put(pose.x, pose.y, pose.z, pose.yaw, pose.pitch, big, big, big, f.livery, pose.roll);
      this.eP.set(pose.roll, pose.yaw, pose.pitch);
      this.qP.setFromEuler(this.eP);
      this.mP.compose(this.vP.set(pose.x, pose.y, pose.z), this.qP, this.sP.set(big, big, big));
      // 主货舱门：铰链在上沿，门往上翻；停机、平台车开过来时打开，装卸完关上
      const lo = f.ops?.lo;
      const open = lo && t >= f.tOn && t < f.tOff ? Math.min(ease(prog(t, lo.in1 - 60, lo.in1)), 1 - ease(prog(t, lo.close0, lo.close1))) : 0;
      this.bodyPt(G.doorX, G.sill + G.doorH, -G.k.rad - 0.04, this.va);
      this.doors.put(this.va.x, this.va.y, this.va.z, pose.yaw, pose.pitch, (G.doorW / 3.7) * big, G.q * big, big, undefined, pose.roll + open * Math.PI * 0.55);
      this.drawLights(f, G, pose, t);
      this.drawSurfaces(G, pose);
      if (t > f.td + 1.5 && t < f.tRev + 2) this.drawSpray(G, t, clamp01((t - f.td - 1.5) / 2) * clamp01((f.tRev + 2 - t) / 3));
      if (f.ops && t >= f.tOn - 60 && t < Math.min(f.tOff + 600, f.nextOn - 150)) this.drawOps(f, f.ops, G, t);
      this.drawPushTug(f, G, pose, t);
    }
    this.drawDepot(t);
    for (const p of this.pools()) p.end();
    this.flaps.end();
    this.spoilers.end();
  }

  /** 机身坐标的点 → 局部坐标（按这一帧算好的机身矩阵） */
  private bodyPt(lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(lx, ly, lz).applyMatrix4(this.mP);
  }

  /** 航行灯（左红右绿、尾白）、防撞灯（发动机开着时）、频闪灯和着陆灯（在跑道上和空中） */
  private drawLights(f: Flight, G: KGeo, p: PlanePose, t: number): void {
    const wy = G.wingBot + 0.6 * G.q;
    this.lamp(G.tipX - 1.5, wy, -G.semi, '#ff3b30', 1);
    this.lamp(G.tipX - 1.5, wy, G.semi, '#34c759', 1);
    this.lamp(-36 * G.k.fx, G.yc + 0.7 * G.q, 0, '#ffffff', 0.8);
    const engines = t < f.tOn + 20 || t >= f.tOff - 60;
    if (engines) {
      this.lamp(0, G.yc + G.k.rad + 0.1, 0, '#ff2d2d', 1);
      this.lamp(-4 * G.k.fx, G.k.rad - 0.1, 0, '#ff2d2d', 1);
    }
    if (t < f.tVac || t >= f.tLu) {
      this.lamp(G.tipX - 2.6, wy, -G.semi, '#ffffff', 0.8);
      this.lamp(G.tipX - 2.6, wy, G.semi, '#ffffff', 0.8);
      this.lamp(G.gearX + 0.6, 1.6 * G.q, 0, '#fff6d8', 1.5);
    } else if (engines && p.y < 1 && !(t >= f.tOn && t < f.tOff)) this.lamp(G.gearX + 0.6, 1.6 * G.q, 0, '#fff6d8', 1.1);
  }
  private lamp(lx: number, ly: number, lz: number, color: string, k: number): void {
    const s = this.sP.x * k;
    this.bodyPt(lx, ly, lz, this.vb);
    this.lamps.put(this.vb.x, this.vb.y, this.vb.z, 0, 0, s, s, s, color);
  }

  /** 反推：每台发动机前面、外侧几团往前翻滚的白汽（一团从风扇面往前走 9 米、变大、变淡） */
  private drawSpray(G: KGeo, t: number, k: number): void {
    for (const e of G.engines)
      for (let j = 0; j < 3; j++) {
        const u = (t * 1.6 + j / 3 + (e.z > 0 ? 0.17 : 0)) % 1;
        const sz = e.r * (0.7 + 1.6 * u) * k * (1 - 0.5 * u);
        this.bodyPt(e.x + 1 + 8 * u, e.y - 0.2 * u * e.r, e.z + Math.sign(e.z) * e.r * (0.6 + 1.4 * u), this.vb);
        this.spray.put(this.vb.x, this.vb.y, this.vb.z, 0, 0, sz, sz * 0.7, sz);
      }
  }

  /** 襟翼（往后伸出、往下偏）、扰流板（往上翻）：机身矩阵 × 铰链位置 × 绕铰链线转 */
  private drawSurfaces(G: KGeo, p: PlanePose): void {
    if (p.flap > 0.5) {
      const d = p.flap * DEG;
      const fl = G.flap;
      for (const side of SIDES) {
        this.mT.makeTranslation(fl.x - 0.9 * (p.flap / 30), fl.y - 0.25 * (p.flap / 30), fl.z * side);
        this.mR.makeRotationY(fl.beta * side);
        this.mL.makeRotationZ(-d);
        this.mT.multiply(this.mR).multiply(this.mL).multiply(this.mR.makeScale(1, 1, fl.len));
        this.flaps.put(this.mT.premultiply(this.mP));
      }
    }
    if (p.spoiler > 0.5) {
      const d = p.spoiler * DEG;
      const sp = G.spoil;
      for (const side of SIDES) {
        this.mT.makeTranslation(sp.x, sp.y, sp.z * side);
        this.mR.makeRotationY(sp.beta * side);
        this.mL.makeRotationZ(d);
        this.mT.multiply(this.mR).multiply(this.mL).multiply(this.mR.makeScale(1, 1, sp.len));
        this.spoilers.put(this.mT.premultiply(this.mP));
      }
    }
  }

  /** 推出车：开到机头前面待命 → 推出时顶着前轮 → 推完启动发动机，脱开、倒出来、转弯开回机位 */
  private drawPushTug(f: Flight, G: KGeo, p: PlanePose, t: number): void {
    const op = f.ops;
    if (!op || t < op.tug.in0) return;
    const tStart = f.tTaxi - START;
    if (t < op.tug.in1) {
      const a = op.tug.inP.at(op.tug.inP.len * cruise(prog(t, op.tug.in0, op.tug.in1)), this.atA);
      this.pushers.put(a.x, 0, a.z, a.yaw);
      return;
    }
    if (t < tStart + 25) {
      // 连着前起落架：机身坐标 (前轮 + 12, 0, 0)，车头对着飞机
      const c = Math.cos(p.yaw);
      const sn = Math.sin(p.yaw);
      const d = G.gearX + 12;
      this.pushers.put(p.x + d * c, 0, p.z - d * sn, p.yaw + Math.PI);
      return;
    }
    // 脱开：先倒出来 12 米，再转弯往机位那边开走
    const sx = this.L.sx[f.stand] as number;
    const tx = sx - PUSH_BACK + G.gearX + 12;
    const e = t - tStart - 25;
    if (e < 12) {
      this.pushers.put(tx + 12 * ease(e / 12), 0, TW_Z, Math.PI);
      return;
    }
    const away = op.tug.away ?? this.tugAway(tx + 12);
    const k = (e - 12) / (away.len / 3);
    if (k >= 1) return;
    const a = away.at(away.len * cruise(k), this.atA);
    this.pushers.put(a.x, 0, a.z, a.yaw);
  }
  private readonly tugAwayCache = new Map<number, Poly>();
  /**
   * 地勤设备场（最后一个机位外面，货站门前行车道和机尾服务车道之间的设备库）：平台车、加油车、推出车、地面电源车、配餐车和板车串
   * 不干活时停在库里。每次作业前从库门开出来，往西走机尾后面的服务车道、往东走货站门前的行车道（单向环线），
   * 开到机位旁边原来接着干活的那个位置；干完开回库里。机位上的作业时刻都不变，只在前后加上来回的路。
   */
  private planDepot(): void {
    const L = this.L;
    const x0 = (L.sx[L.n - 1] as number) + 60;
    const DZ = 1102;
    const WL = LANE_Z - 1.5;
    const EL = LANE_Z + 1.5;
    const units: GseUnit[] = [];
    // 机尾后面的服务车道：往西的车走靠机尾的一条，往东的走靠跑道的一条
    const TW = TAIL_Z - 2;
    const inside = { x: x0 + 48, z: DZ };
    const door = { x: x0 + 17, z: DZ };
    /** 从库里开出去，上往西的车道（机尾后面的服务车道或货站门前行车道靠北的一条） */
    const leave = (lane: number): { x: number; z: number }[] => [inside, door, { x: x0 + 4, z: lane > DZ ? DZ + 8 : DZ - 8 }, { x: x0 - 12, z: lane }];
    /** 沿货站门前行车道往东开回来，进库 */
    const enter = (lane = EL): { x: number; z: number }[] => [{ x: x0 - 12, z: lane }, { x: x0 + 4, z: lane > DZ ? DZ + 8 : DZ - 8 }, door, inside];
    const poly = (pts: { x: number; z: number }[], r = 6) => new Poly(rounded(pts, r));
    const add = (kind: GseKind, pOut: Poly | undefined, tIn: number, pBack: Poly | undefined, tOut: number, v = GSE_V, lead = 0, rear?: number) => {
      const u: GseUnit = { kind, slot: inside, moves: [], busy: [], ...(rear !== undefined ? { rear } : {}) };
      if (pOut) {
        const T = (pOut.len - lead) / v + 6;
        u.moves.push({ t0: tIn - T, t1: tIn, poly: pOut, lead });
      }
      if (pBack) {
        const T = (pBack.len - lead) / v + 6;
        u.moves.push({ t0: tOut, t1: tOut + T, poly: pBack, lead });
      }
      units.push(u);
    };
    for (const f of this.flights) {
      const op = f.ops;
      if (!op) continue;
      const G = kg(f.kind);
      const sx = L.sx[f.stand] as number;
      const cx = op.cx;
      const cz = op.cz;
      const aW = sx - 46;
      const aE = sx + 46;
      // 平台车：往西走机尾后面的服务车道，从机位西边的通道下来，往东开到离舱门 18 米处（接着原来的靠台）；撤出 18 米后掉头，从通道下到行车道往东回库
      if (op.lo) {
        const P = { x: cx + G.base - 18, z: cz - G.doorX };
        const out = poly([...leave(TW), { x: aW, z: TW }, { x: aW, z: P.z }, { x: P.x - 8, z: P.z }, P]);
        const back = poly([P, { x: P.x + 3, z: P.z }, { x: P.x + 4, z: P.z + 8 }, { x: P.x - 2, z: P.z + 12 }, { x: aW + 4, z: P.z + 12 }, { x: aW, z: P.z + 6 }, { x: aW, z: EL }, ...enter()], 4);
        add('loader', out, op.lo.in0, back, op.lo.out1, GSE_V, 0, G.sill - PLAT_T);
      }
      // 加油车：库里开出来往西走机尾服务车道，到左机翼下拐进去（原来的路从这里接上）；加完往南开到行车道，往东回库
      if (op.fuel) {
        const fx = cx + G.fuelZ;
        const pz = cz + 6;
        const inP = poly([...leave(TW), { x: fx, z: TW }, { x: fx, z: pz }], 7);
        const outP = poly([{ x: fx, z: pz }, { x: fx, z: EL }, ...enter()], 7);
        const fu = op.fuel;
        op.fuel = { in0: fu.in1 - (inP.len / 4 + 6), in1: fu.in1, out0: fu.out0, out1: fu.out0 + outP.len / 4 + 6, inP, outP };
      }
      // 推出车：库里开出来沿行车道往西开到机头前（原来的路从机位前接上）；推完脱开以后沿机尾服务车道往东回库
      {
        const tz = cz - G.gearX - 12;
        const inP = poly([...leave(WL), { x: sx, z: WL }, { x: sx, z: tz }], 6);
        const in1 = op.tug.in1;
        const tx = sx - PUSH_BACK + G.gearX + 12 + 12;
        const away = poly([{ x: tx, z: TW_Z }, { x: tx - 6, z: TW_Z }, { x: tx - 6, z: TAIL_Z + 2.6 }, { x: x0 - 12, z: TAIL_Z + 2.6 }, ...enter(TAIL_Z + 2.6)], 6);
        op.tug = { in0: in1 - (inP.len / 3 + 4), in1, inP, away };
      }
      // 地面电源车：轮挡挡好以后开到机头左前方，撤轮挡前开走
      {
        const gp = this.lwAt(cx, cz, 20 * G.k.fx, -8 * G.q);
        const out = poly([...leave(WL), { x: gp.x + 16, z: WL }, { x: gp.x + 6, z: gp.z }, gp]);
        const back = poly([gp, { x: gp.x - 6, z: gp.z }, { x: gp.x - 10, z: EL }, ...enter()]);
        add('gpu', out, f.tOn + 60, back, f.tOff - 180);
      }
      // 配餐车：轮挡挡好 15 分钟后开到右舷前门外，往前靠上 6 米、车厢升到门槛，12 分钟后降下、退出来、掉头回库
      {
        const lz = -G.base;
        const P0 = this.lwAt(cx, cz, G.doorX + 4, lz + 6);
        const P = this.lwAt(cx, cz, G.doorX + 4, lz);
        const in0 = f.tOn + 900;
        if (in0 + 900 < f.tOff - 600) {
          op.cater = { in0, in1: in0 + 30, out0: in0 + 30 + 720, out1: in0 + 30 + 720 + 30, x: P.x, z: P.z, lift: Math.max(0.5, G.sill - 3.6) };
          const out = poly([...leave(WL), { x: P0.x + 14, z: WL }, { x: P0.x + 14, z: P0.z }, P0]);
          const back = poly([P0, { x: P0.x + 3, z: P0.z }, { x: P0.x + 9, z: P0.z - 6 }, { x: P0.x + 9, z: EL - 6 }, { x: P0.x + 14, z: EL }, ...enter()], 4);
          add('cater', out, op.cater.in0, back, op.cater.out1);
        }
      }
      // 板车串：每一套从库里开出来，往西走机尾服务车道、从机位西边的通道下到行车道，往东开到货站门口（第一趟从这里出发）；
      // 这架飞机的活干完以后从最后停的地方开回库
      const tEnd = Math.min(f.tOff + 600, f.nextOn - 150);
      const sets = new Set(op.trips.map((x) => x.set));
      for (const set of sets) {
        const mine = op.trips.filter((x) => x.set === set);
        const first = mine[0];
        const fin = mine[mine.length - 1];
        if (!first || !fin) continue;
        const t0 = first.out ? first.tApp : first.tPrep;
        // 第一趟开始时门口被别的套占着：开到门口前等着的地方
        const start = op.rt.back.at(LEAD - AirportOps.doorOff(op, set, t0), this.atA);
        const out = poly([{ x: inside.x + 22, z: DZ }, ...leave(TW), { x: aW, z: TW }, { x: aW, z: LANE_Z }, { x: start.x, z: start.z }], 6);
        // 最后停的位置：最后一趟停在货站门口（往东），别的套回排队点（往西）；从那里接着往前开
        let backPts: { x: number; z: number }[];
        if (fin.park) {
          const path = op.rt.back;
          const sEnd = LEAD + (path.len - 22 * (fin.parkSlot ?? 0) - LEAD);
          const tail: { x: number; z: number }[] = [];
          for (let d = 24; d >= 0; d -= 4) {
            const q = path.at(Math.max(0, sEnd - d), this.atB);
            tail.push({ x: q.x, z: q.z });
          }
          const e = tail[tail.length - 1] as { x: number; z: number };
          backPts = [...tail, { x: Math.min(e.x - 8, aW + 8), z: TW }, { x: aW, z: TW }, { x: aW, z: EL }, ...enter()];
        } else {
          const path = op.rt.toTerm;
          const tail: { x: number; z: number }[] = [];
          for (let d = 24; d >= 0; d -= 4) {
            const q = path.at(Math.max(0, path.len - d), this.atB);
            tail.push({ x: q.x, z: q.z });
          }
          const e = tail[tail.length - 1] as { x: number; z: number };
          backPts = [...tail, { x: e.x + 12, z: EL }, ...enter()];
        }
        add('train', out, t0, poly(backPts, 6), tEnd, TRAIN_V, 24);
      }
    }
    this.units = units;
  }

  /** 机位局部坐标（同 lw，但给定机位中心，不改 this.cx / this.cz） */
  private lwAt(cx: number, cz: number, lx: number, lz: number): { x: number; z: number } {
    return { x: cx + lz, z: cz - lx };
  }

  /** 地勤设备在设备场和机位之间来回的路上 */
  private drawDepot(t: number): void {
    for (const u of this.units) {
      for (const m of u.moves) {
        if (t < m.t0 || t >= m.t1) continue;
        const p = m.poly;
        const s = m.lead + (p.len - m.lead) * cruise(prog(t, m.t0, m.t1));
        const a = p.at(s, this.atA);
        switch (u.kind) {
          case 'loader': {
            this.loaders.put(a.x, 0, a.z, a.yaw);
            const c = Math.cos(a.yaw);
            const sn = Math.sin(a.yaw);
            this.platforms.put(a.x + 6.5 * c, LOADER_TOP, a.z - 6.5 * sn, a.yaw);
            this.platforms.put(a.x - 6.5 * c, m === u.moves[0] && u.rear !== undefined ? u.rear : LOADER_TOP, a.z + 6.5 * sn, a.yaw, 0, 1.19, 1, 1);
            break;
          }
          case 'gpu':
            this.gpus.put(a.x, 0, a.z, a.yaw);
            break;
          case 'cater': {
            this.lit(this.caters, a.x, 0, a.z, a.yaw);
            const c = Math.cos(a.yaw);
            const sn = Math.sin(a.yaw);
            this.caterBoxes.put(a.x - 1.2 * c, 1.05, a.z + 1.2 * sn, a.yaw);
            break;
          }
          case 'train': {
            this.lit(this.tugs, a.x, 0, a.z, a.yaw);
            for (let j = 0; j < 4; j++) {
              const d = p.at(s - 3.6 - j * 4.4, this.atB);
              this.dollies.put(d.x, 0, d.z, d.yaw);
            }
            break;
          }
          default:
            break;
        }
      }
    }
  }

  /** 配餐车靠在右舷前门外：往前靠上 6 米，车厢升到门槛（剪式升降架），送完降下、退出来 */
  private drawCater(op: Ops, t: number): void {
    const c0 = op.cater;
    if (!c0) return;
    const dock = Math.min(ease(prog(t, c0.in0, c0.in1)), 1 - ease(prog(t, c0.out0, c0.out1)));
    const yaw = Math.PI;
    const x = c0.x + (1 - dock) * 6;
    const z = c0.z;
    this.lit(this.caters, x, 0, z, yaw);
    const lift = Math.min(ease(prog(t, c0.in1, c0.in1 + 60)), 1 - ease(prog(t, c0.out0 - 60, c0.out0))) * c0.lift;
    const bx = x + 1.2;
    this.caterBoxes.put(bx, 1.05 + lift, z, yaw);
    if (lift > 0.05)
      for (const dz of [-0.9, 0.9]) {
        this.va.set(bx - 2, 1.05, z + dz);
        this.vb.set(bx + 2, 1.05 + lift, z + dz);
        this.rods.rod(this.va, this.vb, 0.06, '#5b6067');
        this.va.set(bx + 2, 1.05, z + dz);
        this.vb.set(bx - 2, 1.05 + lift, z + dz);
        this.rods.rod(this.va, this.vb, 0.06, '#5b6067');
      }
  }

  private tugAway(x: number): Poly {
    const key = Math.round(x * 10);
    let pl = this.tugAwayCache.get(key);
    if (!pl) {
      pl = new Poly(rounded([{ x, z: TW_Z }, { x: x - 6, z: TW_Z }, { x: x - 6, z: TAIL_Z + 2.6 }, { x: x + 30, z: TAIL_Z + 2.6 }], 6));
      this.tugAwayCache.set(key, pl);
    }
    return pl;
  }

  /** 机位局部坐标（机头朝 −z 停着：机身 +x → 局部 −z，机身左侧 −z → 局部 −x）→ 局部坐标 */
  private lw(lx: number, lz: number): { x: number; z: number } {
    this.w.x = this.cx + lz;
    this.w.z = this.cz - lx;
    return this.w;
  }

  /** 机位上的地面作业 */
  private drawOps(f: Flight, op: Ops, G: KGeo, t: number): void {
    this.cx = op.cx;
    this.cz = op.cz;
    const yaw = Math.PI / 2;
    const T0 = f.tOn;
    const T1 = f.tOff;
    // 轮挡（前轮、主轮）、地面电源车（机头左前方，电缆接到机头下面）
    if (t > T0 + 40 && t < T1 - 120) {
      let w = this.lw(G.gearX + 1.3, 0);
      this.chocks.put(w.x, 0, w.z, yaw);
      for (const z of G.mains) {
        w = this.lw(G.mainX + 2.2 * G.q, z);
        this.chocks.put(w.x, 0, w.z, yaw);
      }
    }
    if (t > T0 + 60 && t < T1 - 180) {
      const w = this.lw(20 * G.k.fx, -8 * G.q);
      this.gpus.put(w.x, 0, w.z, yaw + Math.PI / 2);
      this.va.set(w.x, 1.4, w.z);
      const w2 = this.lw(22 * G.k.fx, -0.8);
      this.vb.set(w2.x, 1.8 * G.q, w2.z);
      this.rods.rod(this.va, this.vb, 0.05, '#1d1d1d');
    }
    if (op.cater && t >= op.cater.in0 && t < op.cater.out1) this.drawCater(op, t);
    // —— 主货舱升降平台车 ——
    // 垂直于机身停在左侧舱门下：前平台的前沿顶到门槛，平台面升到门槛高度；后平台在车尾，接板车的板
    const lo = op.lo;
    if (lo && t >= lo.in0 && t < lo.out1) {
      const dock = Math.min(ease(prog(t, lo.in0, lo.in1)), 1 - ease(prog(t, lo.out0, lo.out1)));
      const off = (1 - dock) * 18;
      const ly = yaw - Math.PI / 2;
      let w = this.lw(G.doorX, G.base - off);
      this.loaders.put(w.x, 0, w.z, ly);
      const lift = Math.min(ease(prog(t, lo.in1, lo.up1)), 1 - ease(prog(t, lo.down0, lo.down1)));
      const SILL = G.sill;
      const frontY = lerp(LOADER_TOP, SILL - PLAT_T, lift);
      // 后平台：卸货时停在门槛高度（接下一块），装货时停在板车高度；每块板上下一趟
      const hiY = SILL - PLAT_T;
      const loY = DOLLY_TOP - PLAT_T;
      let rearY = t < lo.sw ? hiY : lerp(hiY, loY, ease(prog(t, lo.sw, lo.sw + 60)));
      for (const u of op.xf) {
        if (t < u.t || t >= u.t + XFER + 50) continue;
        const k = (t - u.t) / XFER;
        if (u.out) rearY = k < 0.35 ? hiY : k < 0.75 ? lerp(hiY, loY, ease((k - 0.35) / 0.4)) : k < 1 ? loY : lerp(loY, hiY, ease((t - u.t - XFER) / 50));
        else rearY = k < 0.25 ? loY : k < 0.65 ? lerp(loY, hiY, ease((k - 0.25) / 0.4)) : k < 1 ? hiY : lerp(hiY, loY, ease((t - u.t - XFER) / 50));
      }
      rearY = Math.min(rearY, frontY);
      w = this.lw(G.doorX, G.front - off);
      this.platforms.put(w.x, frontY, w.z, ly);
      w = this.lw(G.doorX, G.rear - off);
      this.platforms.put(w.x, rearY, w.z, ly, 0, 1.19, 1, 1);
      // 剪叉：每块平台两侧各一对交叉的臂（平台落下时臂放平）
      for (let pi = 0; pi < 2; pi++) {
        const cz = (pi ? G.rear : G.front) - off;
        const h = pi ? rearY : frontY;
        const half = pi ? 2.2 : 1.8;
        for (const dx of SCISSOR_DX) {
          w = this.lw(G.doorX + dx, cz - half);
          this.va.set(w.x, LOADER_TOP, w.z);
          w = this.lw(G.doorX + dx, cz + half);
          this.vb.set(w.x, h, w.z);
          this.rods.rod(this.va, this.vb, 0.08, '#5b6067');
          this.va.set(w.x, LOADER_TOP, w.z);
          w = this.lw(G.doorX + dx, cz - half);
          this.vb.set(w.x, h, w.z);
          this.rods.rod(this.va, this.vb, 0.08, '#5b6067');
        }
      }
      // 集装板在平台车上：卸 = 舱门 → 前平台 → 后平台 → 后平台降下 → 推上板车；装 = 反过来
      for (const u of op.xf) {
        if (t < u.t || t >= u.t + XFER + (u.out ? 10 : 0)) continue;
        const k = prog(t, u.t, u.t + XFER);
        let y = SILL;
        let z = G.rear;
        if (u.out) {
          if (k < 0.2) z = lerp(-1.0, G.front, ease(k / 0.2));
          else if (k < 0.35) z = lerp(G.front, G.rear, ease((k - 0.2) / 0.15));
          else if (k < 0.75) y = rearY + PLAT_T;
          else {
            y = DOLLY_TOP;
            z = lerp(G.rear, G.wait, ease((k - 0.75) / 0.25));
          }
        } else if (k < 0.25) {
          y = DOLLY_TOP;
          z = lerp(G.wait, G.rear, ease(k / 0.25));
        } else if (k < 0.65) y = rearY + PLAT_T;
        else if (k < 0.8) z = lerp(G.rear, G.front, ease((k - 0.65) / 0.15));
        else z = lerp(G.front, 0.5, ease((k - 0.8) / 0.2));
        w = this.lw(G.doorX, z);
        this.ulds.put(w.x, y, w.z, yaw, 0, 1, 1, 1, u.store ? STORE_BOX : u.out ? '#f2efe6' : '#dfe7ee');
      }
    }
    // —— 板车串 ——
    for (const tr of op.trips) this.drawTrain(op, tr, t);
    // —— 管线加油车：开到左机翼下，工作台升起，软管接翼下加油口和地面加油井 ——
    const fu = op.fuel;
    if (fu && t >= fu.in0 && t < fu.out1) {
      const fp = t < fu.in1 ? fu.inP.at(fu.inP.len * cruise(prog(t, fu.in0, fu.in1)), this.atA) : t < fu.out0 ? fu.inP.at(fu.inP.len, this.atA) : fu.outP.at(fu.outP.len * cruise(prog(t, fu.out0, fu.out1)), this.atA);
      this.lit(this.fuel, fp.x, 0, fp.z, fp.yaw);
      const up = t < fu.out0 ? ease(prog(t, fu.in1, fu.in1 + 30)) * (1 - ease(prog(t, fu.out0 - 50, fu.out0 - 15))) : 0;
      const c = Math.cos(fp.yaw);
      const sn = Math.sin(fp.yaw);
      const dx = fp.x - 2.9 * c;
      const dz = fp.z + 2.9 * sn;
      const dy = lerp(2.0, 2.65, up);
      this.decks.put(dx, dy, dz, fp.yaw);
      if (up > 0.98) {
        this.va.set(dx, dy + 1.0, dz);
        const w = this.lw(G.fuelX, G.fuelZ);
        this.vb.set(w.x, G.wingBot - 0.1, w.z);
        this.rods.rod(this.va, this.vb, 0.07, '#1d1d1d');
        this.va.set(fp.x + 1.6 * c, 0.9, fp.z - 1.6 * sn);
        this.vb.set(this.cx + G.fuelZ - 2.6, 0.4, this.cz + 9);
        this.rods.rod(this.va, this.vb, 0.08, '#1d1d1d');
      }
    }
  }

  /** 一串板车此刻的位置：车头在某条路线上走到 s（含引入段），4 辆板车沿路线排在后面；板跟着板车走，在货站门口横推进出库 */
  /**
   * 货站门口（toTerm 的终点、back 的起点）一次只停一套板车：每套车在门口的时段（装出口板等着出发 [tPrep, tApp)、
   * 回到门口卸板 [tArr, tDone)，最后一趟留在门口到 end；同一套接着的几段算一段）按开始的先后，门口被别的套占着的，
   * 在门口前 DOOR_Q 米等到它走（这一套的 [开始, 空出来]）
   */
  private static doorQueue(op: Ops, end: number): number[][] {
    const iv: { set: number; a: number; b: number }[] = [];
    for (const tr of op.trips) {
      if (!tr.out) iv.push({ set: tr.set, a: tr.tPrep, b: tr.tApp });
      iv.push({ set: tr.set, a: tr.tArr, b: tr.next === undefined && !tr.park ? Math.max(tr.tDone, end) : tr.tDone });
    }
    iv.sort((x, y) => x.set - y.set || x.a - y.a);
    const merged: { set: number; a: number; b: number }[] = [];
    for (const x of iv) {
      const l = merged[merged.length - 1];
      if (l && l.set === x.set && x.a <= l.b + 1) l.b = Math.max(l.b, x.b);
      else merged.push({ ...x });
    }
    merged.sort((x, y) => x.a - y.a || x.set - y.set);
    const out: number[][] = Array.from({ length: Math.max(1, op.S) }, () => []);
    let owner: { set: number; b: number } | undefined;
    for (const m of merged) {
      if (owner && owner.set !== m.set && owner.b > m.a) {
        (out[m.set] ?? (out[m.set] = [])).push(m.a, Math.min(owner.b, m.b));
        if (m.b > owner.b) owner = { set: m.set, b: m.b };
      } else if (!owner || m.b > owner.b || owner.set === m.set) owner = { set: m.set, b: Math.max(m.b, owner && owner.set === m.set ? owner.b : -Infinity) };
    }
    return out;
  }
  /** 这一套车此刻离门口还差几米（在门口前等着是 DOOR_Q，门口空出来以后 10 秒挪上去） */
  private static doorOff(op: Ops, set: number, t: number): number {
    const w = op.doorWait?.[set];
    if (!w) return 0;
    for (let i = 0; i < w.length; i += 2) {
      const a = w[i] as number;
      const u = w[i + 1] as number;
      if (t >= a && t < u) return DOOR_Q;
      if (t >= u && t < u + 10) return DOOR_Q * (1 - ease((t - u) / 10));
    }
    return 0;
  }

  private drawTrain(op: Ops, tr: Trip, t: number): void {
    if (t < (tr.out ? tr.tApp : tr.tPrep)) return;
    const rt = op.rt;
    const xs = tr.xs;
    // 在平台车后面时每转一块板往前挪一个车位（4.4 米）；没装满的那趟，出发时离满位还差 back 米
    const steps = Math.min(3, xs.length - 1);
    let adv = 0;
    for (let j = 0; j < steps; j++) {
      const u = xs[j] as Xfer;
      const ta = u.out ? u.t + XFER + 12 : u.t + 28;
      adv += 4.4 * ease(prog(t, ta, ta + 10));
    }
    const back = 13.2 - 4.4 * steps;
    let path: Poly;
    let s: number;
    const ahead = tr.k > 0 ? op.trips[tr.k - 1] : undefined;
    // 到排队点时前一趟还没进位：停在它后面 22 米，等它走了再往前挪
    const queued = !!ahead && ahead.tPull > tr.tQ;
    if (t < tr.tApp) {
      path = rt.back;
      s = LEAD - AirportOps.doorOff(op, tr.set, t);
    } else if (t < tr.tQ) {
      path = rt.back;
      const s0 = LEAD - AirportOps.doorOff(op, tr.set, tr.tApp - 1e-3);
      s = s0 + (rt.back.len - (queued ? 22 : 0) - s0) * cruise(prog(t, tr.tApp, tr.tQ));
    } else if (t < tr.tPull) {
      path = rt.back;
      s = queued && ahead && t < ahead.tPull + 12 ? rt.back.len - 22 * (1 - ease(prog(t, ahead.tPull, ahead.tPull + 12))) : rt.back.len;
    } else if (t < tr.tReady) {
      path = rt.pull;
      s = LEAD + (rt.pull.len - 13.2 - LEAD) * cruise(prog(t, tr.tPull, tr.tReady));
    } else if (t < tr.t0) {
      path = rt.pull;
      s = rt.pull.len - 13.2 + adv;
    } else if (t < tr.tArr) {
      path = rt.toTerm;
      const s0 = LEAD - back;
      const e = rt.toTerm.len - AirportOps.doorOff(op, tr.set, tr.tArr);
      s = s0 + (e - s0) * cruise(prog(t, tr.t0, tr.tArr));
    } else if (t < tr.tDone || (tr.next === undefined && !tr.park)) {
      path = rt.toTerm;
      s = rt.toTerm.len - AirportOps.doorOff(op, tr.set, t);
    } else if (tr.next !== undefined) return;
    else {
      path = rt.back;
      const s0 = LEAD - AirportOps.doorOff(op, tr.set, tr.tDone - 1e-3);
      s = s0 + (rt.back.len - 22 * (tr.parkSlot ?? 0) - s0) * cruise(prog(t, tr.tDone, tr.tDone + tr.tQ - tr.tApp));
    }
    const head = path.at(s, this.atA);
    this.lit(this.tugs, head.x, 0, head.z, head.yaw);
    for (let j = 0; j < 4; j++) {
      const d = path.at(s - 3.6 - j * 4.4, this.atB);
      this.dollies.put(d.x, 0, d.z, d.yaw);
      const u = xs[j];
      if (!u) continue;
      const color = u.store ? STORE_BOX : u.out ? '#f2efe6' : '#dfe7ee';
      const along = Math.abs(rt.dockX - d.x) / 1.5;
      // 出口的板从门里出去的那条滚轮道出来（门的东边一列）
      const outX = rt.dockX + TPITCH;
      const alongOut = Math.abs(outX - d.x) / 1.5;
      if (u.out) {
        if (t < u.t + XFER + 10) continue;
        const t1 = tr.tArr + 25 + j * 50;
        if (t < t1) {
          this.ulds.put(d.x, DOLLY_TOP, d.z, d.yaw, 0, 1, 1, 1, color);
          continue;
        }
        // 货站门口：横推到门前的滚轮台 → 沿滚轮台移到门口 → 推进门
        const e = t - t1;
        if (e < 6) this.ulds.put(d.x, DOLLY_TOP, lerp(d.z, BED_Z, ease(e / 6)), d.yaw, 0, 1, 1, 1, color);
        else if (e < 6 + along) this.ulds.put(lerp(d.x, rt.dockX, ease((e - 6) / along)), DOLLY_TOP, BED_Z, d.yaw, 0, 1, 1, 1, color);
        else if (e < 11 + along) this.ulds.put(rt.dockX, DOLLY_TOP, lerp(BED_Z, LANE_IN_Z, (e - 6 - along) / 5), d.yaw, 0, 1, 1, 1, color);
      } else {
        // 出口的板：从门里推出来 → 沿滚轮台移到板车旁 → 横推上板车；到了机位交给平台车（那段在平台车里画）
        if (t >= u.t) continue;
        const t1 = tr.tPrep + 25 + j * 50;
        if (t < t1) continue;
        const e = t - t1;
        if (e < 5) this.ulds.put(outX, DOLLY_TOP, lerp(LANE_IN_Z, BED_Z, e / 5), d.yaw, 0, 1, 1, 1, color);
        else if (e < 5 + alongOut) this.ulds.put(lerp(outX, d.x, ease((e - 5) / alongOut)), DOLLY_TOP, BED_Z, d.yaw, 0, 1, 1, 1, color);
        else if (e < 11 + alongOut) this.ulds.put(d.x, DOLLY_TOP, lerp(BED_Z, d.z, ease((e - 5 - alongOut) / 6)), d.yaw, 0, 1, 1, 1, color);
        else this.ulds.put(d.x, DOLLY_TOP, d.z, d.yaw, 0, 1, 1, 1, color);
      }
    }
  }

  /** 设施管理台的指标：本店每个航班卸了几块、用了多久，板车够不够；机位、跑道、其他航班 */
  kpi(): { label: string; value: string; bad?: boolean }[] {
    const out: { label: string; value: string; bad?: boolean }[] = [];
    const own = this.flights.filter((p) => p.own && p.ops);
    for (const p of own) {
      const op = p.ops as Ops;
      const ins = op.xf.filter((u) => u.out);
      const outs = op.xf.filter((u) => !u.out);
      const first = ins[0];
      const last = ins[ins.length - 1];
      const left = p.nIn - ins.length;
      out.push({ label: `航班（${p.td < 0 ? '前一天 ' : p.td >= 86400 ? '次日 ' : ''}落地 ${clk(p.td)}）`, value: `卸 ${ins.length}/${p.nIn} 块${first && last ? `，${clk(first.t)}–${clk(last.t + XFER)}` : ''}${left > 0 ? `，${left} 块来不及卸` : ''}；装 ${outs.length}/${p.nOut} 块${op.noLoader ? '（平台车没人开）' : ''}`, bad: left > 0 });
    }
    const sets = own.map((p) => (p.ops as Ops).S);
    out.push({ label: '板车（实际开的套数）', value: `${sets.length ? Math.min(...sets) : Math.max(1, Math.min(3, Math.round(currentFacilities().airport.dollySets)))} 套 / 机位` });
    const day = this.flights.filter((f) => f.td < 86400 && f.tEnd > 0);
    const moves = day.reduce((a, f) => a + (f.td >= 0 && f.td < 86400 ? 1 : 0) + (f.tRoll >= 0 && f.tRoll < 86400 ? 1 : 0), 0);
    const hourly = new Array(24).fill(0) as number[];
    for (const f of day)
      for (const x of [f.td, f.tRoll])
        if (x >= 0 && x < 86400) {
          const h = Math.floor(x / H);
          hourly[h] = (hourly[h] ?? 0) + 1;
        }
    const used = day.reduce((a, f) => a + Math.max(0, Math.min(86400, f.tOff) - Math.max(0, f.tOn)), 0);
    out.push({ label: '机位', value: `${this.L.n} 个，全天占用 ${Math.round((used / (this.L.n * 86400)) * 100)}%` });
    out.push({ label: '跑道起降', value: `${moves} 架次，最忙的一小时 ${Math.max(0, ...hourly)} 架次` });
    const others = this.flights.filter((f) => !f.own);
    const late = others.filter((f) => f.delayIn + f.delayOut >= 15 * 60).length;
    out.push({ label: '其他货运航班', value: `${others.length} 班（负荷档位、机位数）${late ? `，${late} 班等跑道或滑行道超过 15 分钟` : ''}${this.dropped ? `，${this.dropped} 班排不进` : ''}` });
    // 货站（仓储中心）：待拆板、ETV、冷藏库、陆侧排队、出口截载、本店的板
    const hk = (k: string) => this.termPlan?.hub.kpi.find((x) => x.key === k)?.value;
    if (this.termPlan) {
      out.push({ label: '货站拆组板', value: `待拆板最多 ${Math.round(hk('bd_backlog_peak') ?? 0)} 块，进 ETV 到上工位平均 ${Math.round(hk('bd_wait_avg') ?? 0)} 分钟；出口板按时组好 ${Math.round(hk('export_ontime') ?? 100)}%`, bad: (hk('export_ontime') ?? 100) < 95 });
      out.push({ label: '货站仓位', value: `ETV 板架最满 ${Math.round(hk('etv_peak') ?? 0)}%，冷藏库最满 ${Math.round(hk('chill_peak') ?? 0)}%，冷冻库最满 ${Math.round(hk('frozen_peak') ?? 0)}%`, bad: (hk('etv_peak') ?? 0) > 85 || (hk('chill_peak') ?? 0) > 85 });
      out.push({ label: '货站陆侧', value: `${Math.round(hk('trucks') ?? 0)} 车次，平均排队 ${Math.round(hk('truck_wait_avg') ?? 0)} 分钟、最长 ${Math.round(hk('truck_wait_max') ?? 0)} 分钟；本店的板进门到进冷藏库 ${Math.round(hk('own_to_cold') ?? 0)} 分钟`, bad: (hk('truck_wait_max') ?? 0) > 60 });
    }
    const noFuel = this.flights.filter((f) => f.ops?.noFuel).length;
    const noLoader = this.flights.filter((f) => f.ops?.noLoader).length;
    if (noFuel || noLoader) out.push({ label: '保障班组', value: `${noLoader ? `${noLoader} 班没有平台车司机` : ''}${noLoader && noFuel ? '，' : ''}${noFuel ? `${noFuel} 班没有加油员` : ''}`, bad: own.some((p) => p.ops?.noLoader || p.ops?.noFuel) });
    return out;
  }

  /** 机场监控面板的数据 */
  info(t: number, flightIds: Map<number, string>, labels: Map<number, string>): AirInfo {
    const flights: AirInfo['flights'] = [];
    const ulds: Uld[] = [];
    let inside = 0;
    let storeReady = 0;
    let exportOut = 0;
    let inUse = 0;
    for (const f of this.flights) {
      if (f.tEnd < 0 || f.tApp >= 86400) continue;
      const op = f.ops;
      const ins = op ? op.xf.filter((u) => u.out) : [];
      const outs = op ? op.xf.filter((u) => !u.out) : [];
      const done = ins.filter((u) => u.t + XFER <= t).length;
      const loaded = outs.filter((u) => u.t + XFER <= t).length;
      if (t >= f.tOn && t < f.tOff) inUse++;
      const { status, phase } = this.statusOf(f, t);
      flights.push({
        id: f.own ? (flightIds.get(f.vid) ?? `航班 ${f.vid}`) : f.id,
        label: f.own ? (labels.get(f.vid) ?? f.label) : f.label,
        kind: kg(f.kind).k.name,
        own: f.own,
        stand: `${f.stand + 1} 号`,
        status,
        land: f.td,
        onBlock: f.tOn,
        offBlock: f.tOff,
        takeoff: f.tLof,
        ulds: ins.length,
        done,
        load: outs.length,
        loaded,
        phase,
      });
      if (!op) continue;
      for (const u of op.xf) {
        const tr = op.trips[u.trip];
        if (u.out) {
          if (tr && tr.tArr + 40 + u.slot * 50 <= t) {
            inside++;
            if (u.store) storeReady++;
          }
          if (!u.store) continue;
          const steps = [
            { t: u.t, text: `从 ${flightIds.get(f.vid) ?? '航班'} 主货舱推出，落到升降平台车` },
            { t: u.t + XFER, text: `推上板车（第 ${u.trip + 1} 串第 ${u.slot + 1} 车）` },
            ...(tr ? [{ t: tr.t0, text: `第 ${tr.k + 1} 串板车装满，牵引车拉往货站` }, { t: tr.tArr + 25 + u.slot * 50, text: `在货站空侧 ${op.rt.door} 号门横推进门，滚轮道上核对板号、过磅` }] : []),
            ...this.termSteps(u.id),
          ];
          ulds.push({ id: u.id, store: true, steps });
        } else if (tr && tr.tPrep + 25 + u.slot * 50 <= t && u.t + XFER > t) exportOut++;
      }
    }
    const rank = (p: string | undefined) => (p === 'ground' || p === 'air' ? 0 : p === 'due' ? 1 : 2);
    flights.sort((a, b) => rank(a.phase) - rank(b.phase) || (a.phase === 'gone' ? (b.takeoff ?? 0) - (a.takeoff ?? 0) : (a.land ?? 0) - (b.land ?? 0)));
    const equip: AirInfo['equip'] = [];
    for (const f of this.flights) {
      const op = f.ops;
      if (!op) continue;
      // 只列此刻在场（前后半小时）的航班的设备
      if (t < f.tOn - 1800 || t > f.tOff + 1800) continue;
      const st = standName(f.stand);
      const lo = op.lo;
      equip.push({ id: `主货舱平台车 · ${st}`, kind: '升降平台车', now: !lo ? '没人开（排班里平台车司机不够）' : t < lo.in0 ? '待命' : t < lo.in1 ? '开往舱门' : t < op.unloadEnd ? '卸板' : t < op.loadEnd ? '装板' : t < lo.out1 ? '撤离' : '已撤离' });
      for (const tr of op.trips) {
        if (t < (tr.out ? tr.tApp : tr.tPrep) || (tr.next !== undefined && t >= tr.tDone)) continue;
        const n = tr.xs.length;
        const moved = tr.xs.filter((u) => (u.out ? u.t + XFER : u.t) <= t).length;
        const now = tr.out
          ? t < tr.tQ ? '空车开往机位' : t < tr.tPull ? '在机尾后面排队' : t < tr.tReady ? '进位到平台车后面' : t < tr.t0 ? `在平台车后面接板 ${moved}/${n}` : t < tr.tArr ? `满载 ${n} 块开往货站` : t < tr.tDone ? `在空侧 ${op.rt.door} 号门推板进库` : tr.park ? '回排队点待命' : '在货站门口待命'
          : t < tr.tApp ? `在空侧 ${op.rt.door} 号门装出口的板` : t < tr.tQ ? `拉着 ${n} 块出口的板开往机位` : t < tr.tPull ? '在机尾后面排队' : t < tr.tReady ? '进位到平台车后面' : t < tr.t0 ? `把板交给平台车 ${moved}/${n}` : t < tr.tArr ? '空车回货站' : tr.park ? '回排队点待命' : '在货站门口待命';
        equip.push({ id: `牵引车 ${tr.set + 1} · ${st}`, kind: `牵引车 + 4 辆板车（第 ${tr.k + 1} 趟，${tr.out ? '卸' : '装'}）`, now });
      }
      const fu = op.fuel;
      equip.push({ id: `加油车 · ${st}`, kind: '管线加油车', now: !fu ? '没人开（排班里加油员不够）' : t < fu.in0 ? '待命' : t < fu.in1 ? '开往左机翼下' : t < fu.out0 ? '加油中' : t < fu.out1 ? '撤离' : '已撤离' });
      equip.push({ id: `电源车 · ${st}`, kind: '地面电源车', now: t > f.tOn + 60 && t < f.tOff - 180 ? '供电中' : '待命' });
      equip.push({ id: `推出车 · ${st}`, kind: '飞机推出车', now: t < op.tug.in0 ? '待命' : t < op.tug.in1 ? '开往机头' : t < f.tOff ? '接好拖把，准备推出' : t < f.tClear + 60 ? '推出中' : '已脱开' });
    }
    const today = this.flights.filter((f) => f.td < 86400 && f.tEnd > 0);
    const moves = today.reduce((a, f) => a + (f.td >= 0 && f.td < 86400 ? 1 : 0) + (f.tRoll >= 0 && f.tRoll < 86400 ? 1 : 0), 0);
    const term = this.term.info(t, (id) => (id.startsWith('V') ? (flightIds.get(Number(id.slice(1))) ?? '本店航班') : id));
    return { flights, ulds, equip, terminal: { inside, storeReady, exportOut, ...(term ? { term } : {}) }, today: { flights: today.length, own: today.filter((f) => f.own).length, moves, stands: this.L.n, inUse, dropped: this.dropped } };
  }
}
