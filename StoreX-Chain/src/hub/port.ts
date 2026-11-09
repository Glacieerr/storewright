import { crossBorder } from '../analysis/crossBorder';
import type { Gen } from '../sim/config';
import { scheduleYard, type YardTimeline, type YardVisit } from '@storewright/yard';
import { AREAS, BONDED_DOORS, CFS_BOX_DOORS, CFS_TRUCK_DOORS, INSPECT_BAYS, sectionPlan } from './portLayout';
import { HUB_SLOT, HUB_SLOTS, tallyOccupancy, type HubDay, type HubFlow, type HubKpi, type HubZone } from './types';

export { BONDED_DOORS, CFS_BOX_DOORS, CFS_TRUCK_DOORS, INSPECT_BAYS };

/**
 * 港口物流中心一天的作业计划（港区里海关监管的作业场所，在码头闸口里面、堆场和闸口之间的一条地块上）：
 *
 * - 集装箱从船上卸下来先进堆场（码头的集装箱仓储）；整箱货（FCL，本店的箱都是整箱）在堆场里等清关、等提箱，
 *   由收货人的集装箱拖车整箱拉走——整箱在港口不拆，到收货人的仓库才拆，少倒一次手（综合物流规划「少一次装卸」的原则）。
 * - 拼箱货（LCL，一个箱里装着好几家收货人的货）由物流中心的场内拖车从堆场拉到拆装箱库（CFS）的集装箱侧月台，
 *   挂车甩在门口，理货班组和叉车把货一板板卸下来、按收货人分拣、在库里存几小时到一两天，
 *   收货人的货车预约到货车侧月台，一票票装车出闸；卸空的箱由拖车送空箱堆场，正面吊堆起来。
 * - 出口拼箱反过来：各家的货车把货送到货车侧月台卸下、在库里集货，凑够一箱以后拖车从空箱堆场拉一个空箱到集装箱侧月台装箱，
 *   装好、施封以后拉回堆场等装船。
 * - 保税仓库：进境的保税货在库里存着（不缴税），按批次出库放行，货车在保税库的月台装卸。
 * - 海关查验：卸船的箱按布控比例抽中的，场内拖车从堆场拉到查验场——先过大型集装箱检查系统（机检通道，车慢慢开过去），
 *   要开箱的再倒到查验台边，查验员开箱、掏箱、查完施封，拖车拉回堆场。开箱查验的比例和 src/analysis/crossBorder.ts 的海运一致。
 * - 空箱堆场：正面吊堆空箱；外面的集卡来还空箱、提空箱。
 *
 * 外面的货车（拆装箱库货车侧、保税库、空箱堆场）都走码头的闸口进出；场内拖车不出闸。
 * 纯函数，不依赖 three.js；同一份输入每次一样。三维（web/src/three/ops/portLogistics.ts）按这一份计划摆车、箱、托盘，
 * 值班助手按它回答（HubDay）。时刻都是当天 0 点起的秒。
 *
 * 数字是按公开资料取的假设参数：拼箱占卸船箱量 6%（公开资料没有权威的统计，常用 5–10%）；打好托盘的 40 尺箱一台叉车 40–60 分钟拆完，
 * 散装的一个班组边卸边打托 1.5–2.5 小时；货车侧装卸一车 20–45 分钟；机检扫描一个箱约 80 秒（加上进出通道约 2.5 分钟）；
 * 开箱查验 1.5–3 小时（查验员 8:00–20:00 在场）；空箱堆 7 层；月台门距 4.3 米、集装箱侧台高 1.32 米（三维按它画）。
 * 堆场里整箱的停留按仿真（本店的箱：上一代 4.5 天、全链路 1.6 天），公开资料里一般是 3–5 天。
 */

/** 场内拖车、正面吊、理货班组（门数、查验台车位按 portLayout.ts 的布置） */
/** 场内拖车：平常 6 辆，忙的日子多派（负荷高 2 档各加 2 辆，最多 12 辆） */
/** 场内拖车停车场的车位（每个 4.4 米宽，一车一位） */
export const TRACTOR_STALLS = Math.floor((AREAS.park.x1 - AREAS.park.x0 - 2.4) / 4.4) + 1;
/**
 * 场内拖车的台数：随负荷加，但不超过停车场的车位数（设备上限：停车场就这么大，车位不能挤窄）。
 * 负荷很高的时候拖车不够用，送箱、取箱的活儿要排队等空出来的拖车：门上的空档往后挪，外面的货车等门、在物流中心停留的时间长一些
 * （值班助手的指标里看得到）；拆箱的积压主要受拆箱班组和门数的限制，变化不大。
 */
export const tractorCount = (traffic = 1): number => Math.min(TRACTOR_STALLS, 6 + 2 * Math.max(0, Math.ceil((traffic - 1.05) / 0.7)));
export const REACH_STACKERS = 2;
export const CREWS = 8;
/** 库容：拆装箱库的托盘位（货架 + 地堆）、保税库的托盘位、空箱堆场的箱位（两个箱区 × 3 排 × DEPOT_BAYS 个贝位 × 7 层） */
export const CFS_SLOTS = 1400;
export const BONDED_SLOTS = 2400;
export const DEPOT_TIERS = 7;
/** 空箱堆场每个箱区的贝位数（贝位间距比集卡长，相邻两个贝位旁边同时停车也不碰） */
export const DEPOT_BAYS = AREAS.depot.bays;
export const EMPTY_SLOTS = 2 * 3 * DEPOT_BAYS * DEPOT_TIERS;

/** 拼箱占卸船箱量的比例、出口拼箱占装船箱量的比例、机检比例（按方案） */
const LCL_SHARE = 0.06;
const LCL_EXPORT_SHARE = 0.03;
const SCAN_SHARE: Record<Gen, number> = { g1: 0.08, g2: 0.08, g3: 0.05 };
/** 作业时段：拆装箱库两班（6:00–22:00 开始干活，做完手上的为止），查验员 8:00–20:00，保税库 8:00–20:00 */
const CFS_OPEN = 6 * 3600;
const CFS_CLOSE = 22 * 3600;
const CUSTOMS_OPEN = 8 * 3600;
const CUSTOMS_CLOSE = 20 * 3600;
const DAY = 24 * 3600;

/**
 * 场内行驶的时间（秒）：按物流中心的布置估的（从闸口、堆场的交接点到各处，场内限速 20 公里 / 时左右，路口、转弯慢一些）。
 * 三维按这些时段把车的路线走完（ops/portLogistics.ts）。
 */
export const RUN = {
  /** 闸口（过杆）→ 拆装箱库货车侧场地口、保税库场地口、空箱堆场 */
  gateCfs: 70,
  gateBonded: 110,
  gateDepot: 170,
  /** 场地口 → 闸口出闸车道的排队点 */
  cfsGate: 80,
  bondedGate: 120,
  depotGate: 180,
  /** 场内拖车：堆场交接点 ↔ 集装箱侧场地口、拆装箱库 ↔ 空箱堆场、空箱堆场 → 堆场、堆场 → 机检通道、查验台 → 堆场 */
  cyCfs: 110,
  cfsDepot: 100,
  depotCy: 190,
  cyScan: 170,
  scanBay: 70,
  bayCy: 170,
};
/** 调车：倒车靠台（半挂车、场内拖车）、摘挂 / 挂上、拉出开到场地口；正面吊吊一个箱；机检一车（扫描约 80 秒，加上进出通道） */
export const MANEUVER = { backSemi: 170, backChassis: 100, couple: 60, pullOut: 90, reach: 240, scan: 150, booth: 50 };

export interface PortHubInput {
  seed: number;
  /** 负荷档位的背景流量倍数（平常 1） */
  traffic?: number;
  /** 方案：查验比例按它 */
  gen?: Gen;
  /** 别家的船（今天的船期）：作业时段、卸、装多少箱。不给就按负荷估一份 */
  calls?: { name: string; t0: number; t1: number; dis: number; load: number }[];
  /**
   * 本店的箱：卸到堆场的时刻、被集装箱拖车提走的时刻（今天没提走就不给）、冷藏箱；
   * 班轮和集装箱拖车写调度台的作业编号（liner、dray，例如 VS1、DR-03），值班助手按它把港口的时间接到那一趟车上
   */
  own?: { id: string; discharged: number; pickup?: number; dray?: string; liner?: string; cold?: boolean }[];
  /** 堆场此刻有多少箱（每 5 分钟一格）和箱位数：给了就用它画堆场的占用（不给只数物流中心跟踪的箱） */
  yard?: { slots: number; boxes: ArrayLike<number> };
}

/** 一次靠台：门、谁、到场地口、靠稳开始装卸、装卸完、离开月台（拉出）；外面的车还有过闸进、出的时刻 */
export interface PortDock {
  id: string;
  label: string;
  /** cfs-box：拆装箱库集装箱侧；cfs-truck：货车侧；bonded：保税库 */
  face: 'cfs-box' | 'cfs-truck' | 'bonded';
  door: number;
  kind: 'devan' | 'stuff' | 'pickup' | 'deliver' | 'bonded-in' | 'bonded-out';
  /** 到场地口（排队前）、开始倒车、靠稳（挂车甩好 / 停稳）、开始装卸、装卸完、开始拉出、离开场地口 */
  arrive: number;
  backAt: number;
  docked: number;
  start: number;
  done: number;
  pullAt: number;
  gone: number;
  pallets: number;
  /** 场内拖车把挂车甩在门口（集装箱侧）：送来的拖车、来挂走的拖车 */
  tractorIn?: number;
  tractorOut?: number;
  /** 外面的货车：过闸进、出闸到排队点的时刻；在场里等门等了多久 */
  gateIn?: number;
  gateOut?: number;
  wait: number;
  /** 箱的颜色下标（集装箱侧）、箱号 */
  color?: number;
  box?: string;
  own?: boolean;
  /** 外面的车：冷藏半挂车；收货场引擎排的场内时间线（货车侧、保税库） */
  reefer?: boolean;
  tl?: YardTimeline;
}

/** 场内拖车的一段：从哪到哪、带着什么（满箱、空箱、只有骨架车、单车头）、时段；到了以后做什么 */
export type PortNode = 'cy' | 'cfs' | 'depot' | 'scan' | 'bay' | 'park';
export interface PortTractorLeg {
  tractor: number;
  from: PortNode;
  to: PortNode;
  t0: number;
  t1: number;
  /** full：拉着满箱；empty：拉着空箱；chassis：只拉骨架车；bobtail：只有车头 */
  load: 'full' | 'empty' | 'chassis' | 'bobtail';
  /** 到了以后：甩挂在门口 / 查验台（door / bay 编号）、挂上、放到空箱堆场、正面吊吊上空箱、开过机检通道 */
  then?: { kind: 'drop' | 'hook' | 'unload' | 'loadEmpty' | 'scan' | 'cy'; door?: number; bay?: number; t0: number; t1: number };
  color?: number;
  box?: string;
  own?: boolean;
}

/** 查验：哪个箱、机检通道的时段、开箱查验的车位和时段（只机检的没有） */
export interface PortInspection {
  box: string;
  own: boolean;
  color: number;
  ready: number;
  scan: [number, number];
  bay?: number;
  open?: [number, number];
  back: number;
  /** 查验结果说明 */
  result: string;
}

/** 空箱堆场的进出：外面的集卡还箱 / 提箱，拖车送来卸空的箱 / 拉走装箱用的空箱；正面吊干活的时段 */
export interface PortDepotMove {
  id: string;
  kind: 'return' | 'pickup' | 'from-cfs' | 'to-cfs';
  arrive: number;
  start: number;
  end: number;
  gone: number;
  stacker: number;
  /** 堆到哪个箱位（箱区、贝、排、层）——三维按它画 */
  slot: { block: number; bay: number; row: number; tier: number };
  color: number;
  gateIn?: number;
  gateOut?: number;
}

export interface PortHubPlan {
  day: HubDay;
  docks: PortDock[];
  tractors: PortTractorLeg[];
  inspections: PortInspection[];
  depot: PortDepotMove[];
  /** 空箱堆场 0 点时的箱（箱位 → 颜色下标） */
  depot0: { slot: PortDepotMove['slot']; color: number; out?: number }[];
  /** 拆装箱库、保税库里的托盘数（每 5 分钟一格） */
  cfsPallets: Float32Array;
  bondedPallets: Float32Array;
  /** 用的查验比例：机检、开箱 */
  rates: { lcl: number; scan: number; open: number };
  /** 货车侧、保税库当天的全部访问（交给收货场引擎排；三维按同一份登记、取时间线画车） */
  yardVisits: Record<'port-cfs-truck' | 'port-bonded', YardVisit[]>;
}

/**
 * 没有三维的时候（孪生服务）：本店的箱按调度台的提箱作业算——每个集装箱拖车的作业提一个箱，卸到堆场的时刻按方案的堆场停留往前推
 * （dwellHours，和 src/analysis/crossBorder.ts 的海运一样）；冷链按作业的温区。三维里用港口计划排的真实时刻。
 */
export function ownFromOps(ops: readonly { id: string; kind: string; t0: number; zone?: string }[], dwellHours: number, liner = 'VS1'): NonNullable<PortHubInput['own']> {
  return ops
    .filter((o) => o.kind === 'drayage')
    .map((o) => ({ id: `${o.id} 的箱`, discharged: o.t0 - dwellHours * 3600, pickup: o.t0, dray: o.id, liner, ...(o.zone && o.zone !== 'ambient' ? { cold: true } : {}) }));
}

// ———————————————————————— 小工具 ————————————————————————

function rng(seed: number): () => number {
  let s = Math.abs(Math.floor(seed)) % 2147483646 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
/** 箱号的确定性散列（0–1）：本店的箱抽不抽中查验 */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const clockOf = (t: number) => {
  const m = Math.round(t / 60);
  const d = Math.floor(m / 1440);
  const mm = m - d * 1440;
  return `${d > 0 ? '次日 ' : d < 0 ? '前一天 ' : ''}${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
};
/** 货车预约到达的时段分布：上午 9–11 点、下午 14–16 点多一些 */
function apptTime(r: () => number, open: number, close: number): number {
  for (let i = 0; i < 20; i++) {
    const t = open + r() * (close - open);
    const h = t / 3600;
    const w = 0.55 + 0.45 * Math.exp(-(((h - 10) / 1.4) ** 2)) + 0.4 * Math.exp(-(((h - 15) / 1.5) ** 2));
    if (r() < w) return t;
  }
  return open + r() * (close - open);
}

/** 资源的忙碌时段：找最早能用的一个 */
class Pool {
  readonly busy: [number, number][][];
  constructor(n: number) {
    this.busy = Array.from({ length: n }, () => []);
  }
  /** 第 i 个在 [a, b) 空着吗 */
  free(i: number, a: number, b: number): boolean {
    for (const [x, y] of this.busy[i] as [number, number][]) if (x < b && a < y) return false;
    return true;
  }
  /** 从 t 起最早空出 dur 秒的一个（先看谁最早，再看编号）；step：往后找的步长 */
  earliest(t: number, dur: number, step = 60, prefer?: (i: number) => number): { i: number; t: number } {
    let best = { i: 0, t: Infinity };
    for (let i = 0; i < this.busy.length; i++) {
      let a = t;
      for (let k = 0; k < 2000 && !this.free(i, a, a + dur); k++) {
        // 跳到挡着的那一段的结束
        let next = a + step;
        for (const [x, y] of this.busy[i] as [number, number][]) if (x < a + dur && a < y) next = Math.max(next, y);
        a = next;
      }
      const score = a + (prefer ? prefer(i) : 0);
      if (score < best.t + (prefer ? prefer(best.i) : 0) - 1e-6 || best.t === Infinity) best = { i, t: a };
    }
    return best;
  }
  take(i: number, a: number, b: number): void {
    (this.busy[i] as [number, number][]).push([a, b]);
  }
  /** [a, b) 里有几个在忙 */
  load(a: number, b: number): number {
    let n = 0;
    for (let i = 0; i < this.busy.length; i++) if (!this.free(i, a, b)) n++;
    return n;
  }
}

/**
 * 场内拖车：每辆一串按时间排的任务（只往后加）。车上有没有骨架车（chassis）：在门口、查验台甩挂以后只剩车头，
 * 要拉箱的活先回堆场的交接点挂一个骨架车（码头的骨架车池）。
 */
interface Tractor {
  at: PortNode;
  freeAt: number;
  chassis: boolean;
}
const RUN_BETWEEN = (a: PortNode, b: PortNode): number => {
  if (a === b) return 30;
  const k = [a, b].sort().join('-');
  const m: Record<string, number> = {
    'cfs-cy': RUN.cyCfs,
    'cfs-depot': RUN.cfsDepot,
    'cy-depot': RUN.depotCy,
    'cy-scan': RUN.cyScan,
    'bay-scan': RUN.scanBay,
    'bay-cy': RUN.bayCy,
    'bay-cfs': 150,
    'bay-depot': 150,
    'cfs-scan': 160,
    'depot-scan': 120,
    'cy-park': 100,
    'cfs-park': 70,
    'depot-park': 160,
    'park-scan': 180,
    'bay-park': 160,
  };
  return m[k] ?? 160;
};
/** 在堆场交接点挂骨架车、龙门吊放箱 / 取箱（秒） */
const CY_HOOK = 120;
const CY_LIFT = 180;
/** 场内拖车从场地的进场道路口开到倒车起点（拉着骨架车；单车头来挂车连倒车） */
const ENTER = 45;
const ENTER_BOB = 75;

// ———————————————————————— 一天的计划 ————————————————————————

export function planPortHub(input: PortHubInput): PortHubPlan {
  const traffic = Math.max(0.3, input.traffic ?? 1);
  const gen: Gen = input.gen ?? 'g3';
  const r = rng(input.seed * 6113 + 211);
  const sea = crossBorder(gen).flows.find((f) => f.mode === 'sea');
  const openRate = sea?.inspection.physical ?? 0.03;
  const scanRate = SCAN_SHARE[gen];
  // 船期：不给就按负荷估（平常 4 条别家的船，每条卸、装约 160 箱，负荷高多一条）
  const calls =
    input.calls ??
    Array.from({ length: traffic > 1.8 ? 5 : 4 }, (_, i) => {
      const t0 = (1.5 + i * 5 + r() * 2) * 3600;
      return { name: `别家的船 ${i + 1}`, t0, t1: t0 + (8 + r() * 4) * 3600, dis: Math.round(150 + r() * 40), load: Math.round(150 + r() * 40) };
    });

  const docks: PortDock[] = [];
  const legs: PortTractorLeg[] = [];
  const inspections: PortInspection[] = [];
  const depot: PortDepotMove[] = [];
  const flows: HubFlow[] = [];

  const boxDoors = new Pool(CFS_BOX_DOORS);
  const truckDoors = new Pool(CFS_TRUCK_DOORS);
  const bondDoors = new Pool(BONDED_DOORS);
  const crews = new Pool(CREWS);
  const stackers = new Pool(REACH_STACKERS);
  const scanner = new Pool(1);
  const bays = new Pool(INSPECT_BAYS);
  /** 堆场交接点同一时间只停一辆拖车 */
  const cyPoint = new Pool(1);
  const TR = tractorCount(traffic);
  const tr: Tractor[] = Array.from({ length: TR }, () => ({ at: 'park' as PortNode, freeAt: 0, chassis: true }));

  /** 拖车 k 最早什么时候能到 node（不早于 t 出发……按它现在的位置和空闲时刻） */
  const reach = (k: number, node: PortNode, t: number) => {
    const x = tr[k] as Tractor;
    const run = RUN_BETWEEN(x.at, node);
    const leave = Math.max(x.freeAt, t - run);
    return { leave, arrive: leave + run };
  };
  /** 挑一辆最早能在 t 到 node 的拖车（needChassis：没骨架车的要先绕到堆场挂一个，算上那一趟） */
  const pick = (node: PortNode, t: number, needChassis: boolean): number => {
    let best = 0;
    let bestT = Infinity;
    tr.forEach((x, k) => {
      let arrive: number;
      if (needChassis && !x.chassis) {
        const a = reach(k, 'cy', t - RUN_BETWEEN('cy', node) - CY_HOOK);
        arrive = a.arrive + CY_HOOK + RUN_BETWEEN('cy', node);
      } else arrive = reach(k, node, t).arrive;
      if (arrive < bestT - 1e-6) {
        bestT = arrive;
        best = k;
      }
    });
    return best;
  };
  /** 拖车开一段到 node（box：拉着满箱 / 空箱；不给就按有没有骨架车），返回到达的时刻 */
  const drive = (k: number, leave: number, to: PortNode, box?: 'full' | 'empty', extra: Partial<PortTractorLeg> = {}): number => {
    const x = tr[k] as Tractor;
    const run = RUN_BETWEEN(x.at, to);
    const t0 = Math.max(leave, x.freeAt);
    const t1 = t0 + run;
    legs.push({ tractor: k, from: x.at, to, t0, t1, load: box ?? (x.chassis ? 'chassis' : 'bobtail'), ...extra });
    x.at = to;
    x.freeAt = t1;
    return t1;
  };
  /** 拖车在原地做一件事（接在上一段后面） */
  const act = (k: number, then: NonNullable<PortTractorLeg['then']>): void => {
    for (let i = legs.length - 1; i >= 0; i--)
      if ((legs[i] as PortTractorLeg).tractor === k) {
        (legs[i] as PortTractorLeg).then = then;
        break;
      }
    const x = tr[k] as Tractor;
    x.freeAt = Math.max(x.freeAt, then.t1);
  };
  /** 没骨架车就先回堆场交接点挂一个 */
  const ensureChassis = (k: number, by: number): void => {
    const x = tr[k] as Tractor;
    if (x.chassis) return;
    const a = reach(k, 'cy', by);
    const at = drive(k, a.leave, 'cy');
    const slot = cyPoint.earliest(at, CY_HOOK, 30);
    cyPoint.take(0, slot.t, slot.t + CY_HOOK);
    act(k, { kind: 'cy', t0: slot.t, t1: slot.t + CY_HOOK });
    x.chassis = true;
  };
  /** 在堆场交接点让龙门吊放上 / 取下一个箱（同一时间只停一辆）；返回做完的时刻 */
  const cyLift = (k: number, at: number): number => {
    const slot = cyPoint.earliest(at, CY_LIFT, 30);
    cyPoint.take(0, slot.t, slot.t + CY_LIFT);
    act(k, { kind: 'cy', t0: slot.t, t1: slot.t + CY_LIFT });
    return slot.t + CY_LIFT;
  };

  // —— 空箱堆场：0 点时的箱，一个个箱位（两个箱区 × 3 排 × 11 个贝位 × 7 层），按先放先用的顺序进出 ——
  const depotSlots: PortDepotMove['slot'][] = [];
  for (let tier = 0; tier < DEPOT_TIERS; tier++) for (let block = 0; block < 2; block++) for (let bay = 0; bay < DEPOT_BAYS; bay++) for (let row = 0; row < 3; row++) depotSlots.push({ block, bay, row, tier });
  const slotKey = (s: PortDepotMove['slot']) => `${s.block}:${s.bay}:${s.row}:${s.tier}`;
  /** 每个箱位被占着的时段（颜色） */
  const slotUse = new Map<string, { t0: number; t1: number; color: number }[]>();
  const stock0 = Math.round(Math.min(EMPTY_SLOTS * 0.7, 200 + 30 * traffic));
  const depot0: PortHubPlan['depot0'] = [];
  for (let i = 0; i < stock0; i++) {
    const s = depotSlots[i] as PortDepotMove['slot'];
    const color = Math.floor(r() * 12);
    slotUse.set(slotKey(s), [{ t0: -Infinity, t1: Infinity, color }]);
    depot0.push({ slot: s, color });
  }
  const usesOf = (s: PortDepotMove['slot']) => slotUse.get(slotKey(s)) ?? [];
  /**
   * 空箱堆场每个贝位旁边停车的时段（两个箱区隔着同一条装卸车道，同一个贝位的车停在同一个地方）：同一个贝位一次只停一辆车，
   * 挑箱位时先挑这段时间贝位空着的（都占着才不管）
   */
  const bayUse = new Map<number, [number, number][]>();
  const bayFree = (bay: number, w?: [number, number]) => !w || (bayUse.get(bay) ?? []).every(([a, b]) => b <= w[0] || w[1] <= a);
  const bayTake = (bay: number, w?: [number, number]) => {
    if (w) bayUse.set(bay, [...(bayUse.get(bay) ?? []), w]);
  };
  /** 放空箱：从 t 起一直空着、下面一层（以后也）有箱的最低的箱位 */
  const depotPut = (t: number, color: number, w?: [number, number]): PortDepotMove['slot'] | undefined => {
    for (const strict of [true, false])
      for (const s of depotSlots) {
        if (strict && !bayFree(s.bay, w)) continue;
        if (usesOf(s).some((u) => u.t1 > t)) continue;
        if (s.tier > 0 && !usesOf({ ...s, tier: s.tier - 1 }).some((u) => u.t0 <= t && u.t1 === Infinity)) continue;
        const list = usesOf(s);
        list.push({ t0: t, t1: Infinity, color });
        slotUse.set(slotKey(s), list);
        bayTake(s.bay, w);
        return s;
      }
    return undefined;
  };
  /** 取空箱：t 时在、上面一层以后都空着的最高的箱 */
  const depotTake = (t: number, w?: [number, number]): { s: PortDepotMove['slot']; color: number } | undefined => {
    for (const strict of [true, false])
    for (let i = depotSlots.length - 1; i >= 0; i--) {
      const s = depotSlots[i] as PortDepotMove['slot'];
      if (strict && !bayFree(s.bay, w)) continue;
      const use = usesOf(s).find((u) => u.t0 <= t && u.t1 === Infinity);
      if (!use) continue;
      if (s.tier < DEPOT_TIERS - 1 && usesOf({ ...s, tier: s.tier + 1 }).some((u) => u.t1 > t)) continue;
      use.t1 = t;
      bayTake(s.bay, w);
      const d0 = depot0.find((d) => slotKey(d.slot) === slotKey(s) && d.out === undefined);
      if (d0 && use.t0 === -Infinity) d0.out = t;
      return { s, color: use.color };
    }
    return undefined;
  };

  /** 拆完 / 装完以后来挂走的拖车：最早几分钟以后到 */
  const HOOK_DELAY = 5 * 60;
  /** 估的「拆完到挂走」的余量（门按它先占着，实际挂走以后按实际的时刻） */
  const HOOK_ALLOW = 60 * 60;

  // —— 货车侧：一辆车的一次装卸（到场地口 → 等门 → 倒车 → 装卸 → 拉出），先到先靠 ——
  let truckSeq = 1;
  const truckVisit = (face: 'cfs-truck' | 'bonded', kind: PortDock['kind'], appt: number, pallets: number, label: string, reefer = false): PortDock | undefined => {
    const doors = face === 'cfs-truck' ? truckDoors : bondDoors;
    const runIn = face === 'cfs-truck' ? RUN.gateCfs : RUN.gateBonded;
    const runOut = face === 'cfs-truck' ? RUN.cfsGate : RUN.bondedGate;
    const work = Math.round((10 + 1.8 * pallets) * 60);
    const need = MANEUVER.backSemi + 180 + work + 60 + MANEUVER.pullOut;
    const got = doors.earliest(appt, need, 60);
    if (!Number.isFinite(got.t) || got.t > DAY + 2 * 3600) return undefined;
    const backAt = got.t;
    const docked = backAt + MANEUVER.backSemi;
    // 靠稳以后放轮挡、车辆锁、调平板、开门约 3 分钟才开始装卸
    const start = docked + 180;
    const done = start + work;
    const pullAt = done + 60;
    const gone = pullAt + MANEUVER.pullOut;
    doors.take(got.i, backAt, gone);
    const id = `${face === 'cfs-truck' ? 'C' : 'B'}${String(truckSeq++).padStart(3, '0')}`;
    const d: PortDock = { id, label: `${label}${reefer ? '（冷藏）' : ''}`, face, door: got.i, kind, arrive: appt, backAt, docked, start, done, pullAt, gone, pallets, gateIn: appt - runIn, gateOut: gone + runOut, wait: Math.max(0, backAt - appt), ...(reefer ? { reefer } : {}) };
    docks.push(d);
    return d;
  };
  /** 外面的车的流程：收货场引擎排完场内的时间线以后再生成（排队、靠台的时段按引擎的） */
  const truckActs = new Map<string, { act: string; inbound: boolean }>();
  const truckFlow = (d: PortDock, act0: string, inbound: boolean) => truckActs.set(d.id, { act: act0, inbound });

  // —— 拼箱进口：昨天卸下还没拆的（0 点时在堆场），加上今天每条船卸下的拼箱 ——
  interface Lcl {
    id: string;
    ready: number;
    discharged: number;
    feet: 20 | 40;
    pallets: number;
    lots: number;
    color: number;
    call: string;
    /** 箱里的货打好托盘了（叉车直接叉）还是散装的纸箱 */
    palletised: boolean;
  }
  const lcl: Lcl[] = [];
  let seq = 1000 + Math.floor(r() * 8000);
  const boxId = () => `XLCU ${String(seq++).padStart(6, '0')}`;
  const mkLcl = (discharged: number, call: string): Lcl => {
    const feet = r() < 0.8 ? 40 : 20;
    return { id: boxId(), discharged, ready: discharged + 3 * 3600, feet, pallets: feet === 40 ? 18 + Math.floor(r() * 8) : 9 + Math.floor(r() * 4), lots: 3 + Math.floor(r() * 6), color: Math.floor(r() * 12), call, palletised: r() < 0.4 };
  };
  const backlog = Math.round(6 * traffic + r() * 4);
  for (let i = 0; i < backlog; i++) lcl.push(mkLcl(-(2 + r() * 20) * 3600, '前一天卸船'));
  for (const c of calls) {
    const n = Math.round(c.dis * LCL_SHARE * (0.8 + r() * 0.4));
    for (let i = 0; i < n; i++) lcl.push(mkLcl(c.t0 + r() * Math.max(600, c.t1 - c.t0), c.name));
  }
  lcl.sort((a, b) => a.ready - b.ready);

  interface Lot {
    id: string;
    pallets: number;
    ready: number;
    pickup?: number;
    bonded: boolean;
  }
  const lots: Lot[] = [];
  const devanned = new Map<string, PortDock>();
  /** 集装箱侧一次作业靠到门口的部分：门、班组、甩挂；挂走在之后的事件里排 */
  interface BoxIn {
    door: number;
    /** 门占用的开头（排的时刻） */
    from?: number;
    back0: number;
    docked: number;
    start: number;
    done: number;
    /** 门先占到哪（估的）：挂走晚于它就把占用延长 */
    held: number;
    k: number;
    arrive: number;
  }
  /**
   * 排集装箱侧的门和班组（并占下）：挂车最早 earliest 能到门口；班组从 earliestStart 起能干活。
   * 门要从倒车一直占到干完以后再留 HOOK_ALLOW（等拖车来挂走），先找一个门和班组都对得上的时段整段占下；
   * 拖车到的时候（派车的事件）再按实际到的时刻微调。
   */
  interface BoxPlan {
    door: number;
    back0: number;
    start: number;
    done: number;
    held: number;
    crew: number;
  }
  const planBox = (earliest: number, dur: number, earliestStart: number): BoxPlan | undefined => {
    const lead = MANEUVER.backChassis + MANEUVER.couple + 300;
    let t = earliest;
    for (let iter = 0; iter < 60; iter++) {
      const crew = crews.earliest(Math.max(earliestStart, t + lead), dur, 60);
      const back0 = Math.max(t, crew.t - lead - 20 * 60);
      const start = Math.max(back0 + lead, crew.t);
      // 多留 15 分钟：拖车晚到一点也还在占着的时段里
      const held = start + dur + HOOK_ALLOW + MANEUVER.pullOut + 900;
      let door = -1;
      for (let i = 0; i < CFS_BOX_DOORS; i++)
        if (boxDoors.free(i, back0, held)) {
          door = i;
          break;
        }
      if (door >= 0 && crews.free(crew.i, start, start + dur)) {
        if (back0 > CFS_CLOSE + 3600) return undefined;
        boxDoors.take(door, back0, held);
        crews.take(crew.i, start, start + dur);
        return { door, back0, start, done: start + dur, held, crew: crew.i };
      }
      const next = boxDoors.earliest(back0, held - back0, 60);
      t = Math.max(t + 60, Math.min(next.t, t + 1800));
      if (t > CFS_CLOSE + 3600) return undefined;
    }
    return undefined;
  };
  /** 换掉资源里占着的一段（按开头和结尾找） */
  const swap = (pool: Pool, i: number, a: number, b: number, a2: number, b2: number): void => {
    const list = pool.busy[i] as [number, number][];
    const k = list.findIndex(([x, y]) => x === a && y === b);
    if (k >= 0) list.splice(k, 1, [a2, b2]);
    else list.push([a2, b2]);
  };
  /** 拖车 k 开到门口（arrive）：倒车、摘挂、走人；晚到了班组和门的占用跟着往后挪 */
  const boxIn = (k: number, arrive: number, pl: BoxPlan): BoxIn => {
    const back0 = Math.max(arrive + ENTER, pl.back0);
    const docked = back0 + MANEUVER.backChassis;
    const dropped = docked + MANEUVER.couple;
    act(k, { kind: 'drop', door: pl.door, t0: back0, t1: dropped });
    (tr[k] as Tractor).chassis = false;
    const late = Math.max(0, dropped + 300 - pl.start);
    const start = pl.start + late;
    const done = pl.done + late;
    if (late > 0) {
      swap(crews, pl.crew, pl.start, pl.done, start, done);
      swap(boxDoors, pl.door, pl.back0, pl.held, pl.back0, pl.held + late);
    }
    return { door: pl.door, from: pl.back0, back0, docked, start, done, held: pl.held + late, k, arrive };
  };
  /** 挂走：单车头开过来挂上、拉出；门的占用按实际的时刻改 */
  const boxOut = (j: BoxIn, t: number): { k2: number; hookAt: number; pullAt: number; gone: number } => {
    const k2 = pick('cfs', t - ENTER_BOB, false);
    const a2 = reach(k2, 'cfs', t - ENTER_BOB);
    const at2 = drive(k2, a2.leave, 'cfs');
    const hookAt = Math.max(at2 + ENTER_BOB, t);
    const pullAt = hookAt + MANEUVER.couple;
    const gone = pullAt + MANEUVER.pullOut;
    act(k2, { kind: 'hook', door: j.door, t0: hookAt, t1: pullAt });
    (tr[k2] as Tractor).chassis = true;
    // 门的占用：先占的那段换成实际的
    swap(boxDoors, j.door, j.from ?? j.back0, j.held, j.from ?? j.back0, Math.max(gone, j.back0 + 60));
    return { k2, hookAt, pullAt, gone };
  };

  // —— 出口拼箱：各家货车送货到货车侧，凑够一箱，拖车从空箱堆场拉空箱来装箱，装好、施封以后拉回堆场 ——
  interface ExportBox {
    id: string;
    feet: 20 | 40;
    total: number;
    trucks: number;
    seen: number;
    last: number;
    cargo: PortDock[];
  }
  const loadTotal = calls.reduce((a, c) => a + c.load, 0);
  const exportBoxes = Math.round(loadTotal * LCL_EXPORT_SHARE * (0.8 + r() * 0.4));

  // —— 海关查验要抽的箱 ——
  interface Pick {
    id: string;
    own: boolean;
    color: number;
    ready: number;
    open: boolean;
    latest?: number;
  }

  // —— 事件队列：所有的活按时刻先后排（拖车、门、班组按这个顺序接活，一上午不会被后面的活占满） ——
  type Ev =
    | { t: number; kind: 'lcl'; b: Lcl }
    | { t: number; kind: 'lclGo'; b: Lcl; pl: BoxPlan }
    | { t: number; kind: 'devanOut'; b: Lcl; j: BoxIn; dock: PortDock }
    | { t: number; kind: 'truck'; face: 'cfs-truck' | 'bonded'; dk: PortDock['kind']; pallets: number; label: string; act: string; inbound: boolean; reefer?: boolean; lot?: Lot; exp?: ExportBox }
    | { t: number; kind: 'stuff'; e: ExportBox }
    | { t: number; kind: 'stuffGo'; e: ExportBox; pl: BoxPlan }
    | { t: number; kind: 'stuffOut'; e: ExportBox; j: BoxIn; color: number; dock: PortDock }
    | { t: number; kind: 'insp'; p: Pick }
    | { t: number; kind: 'inspOut'; p: Pick; ins: PortInspection; bay: number; b0: number; need: number }
    | { t: number; kind: 'depot'; dk: 'return' | 'pickup' };
  const queue: Ev[] = [];
  const popMin = (): Ev | undefined => {
    let bi = -1;
    for (let i = 0; i < queue.length; i++) if (bi < 0 || (queue[i] as Ev).t < (queue[bi] as Ev).t) bi = i;
    return bi < 0 ? undefined : queue.splice(bi, 1)[0];
  };

  // 拼箱进口：能拆的时刻（卸船 3 小时以后，舱单、理货做完；拆装箱库 6:00 开始）
  for (const b of lcl) queue.push({ t: Math.max(b.ready, CFS_OPEN - RUN.cyCfs - CY_LIFT), kind: 'lcl', b });
  // 库里 0 点时已经有的货（前几天拆的），今天来提的预约
  const stockLots = Math.round(26 * traffic + r() * 8);
  for (let i = 0; i < stockLots; i++) {
    const l: Lot = { id: `S${String(i + 1).padStart(3, '0')}`, pallets: 3 + Math.floor(r() * 10), ready: -(4 + r() * 30) * 3600, pickup: apptTime(r, 7 * 3600, 20 * 3600), bonded: false };
    lots.push(l);
    queue.push({ t: l.pickup as number, kind: 'truck', face: 'cfs-truck', dk: 'pickup', pallets: l.pallets, label: `收货人提货（${l.pallets} 板）`, act: `装车（${l.pallets} 板）`, inbound: false, lot: l });
  }
  // 0 点时库里的货（今天不提的）：按库容的三成多
  const cfsStock0 = Math.round(CFS_SLOTS * (0.3 + 0.03 * Math.min(traffic, 2.5)) + r() * 60);
  // 出口拼箱的送货车
  for (let e = 0; e < exportBoxes; e++) {
    const feet = r() < 0.75 ? 40 : 20;
    const total = feet === 40 ? 18 + Math.floor(r() * 7) : 9 + Math.floor(r() * 3);
    const nTrucks = 2 + Math.floor(r() * 3);
    const ex: ExportBox = { id: boxId(), feet, total, trucks: nTrucks, seen: 0, last: 0, cargo: [] };
    let left = total;
    const base = 6.5 * 3600 + r() * 9 * 3600;
    for (let j = 0; j < nTrucks; j++) {
      const p = j === nTrucks - 1 ? left : Math.max(2, Math.min(left - 2 * (nTrucks - 1 - j), Math.round(total / nTrucks)));
      left -= p;
      queue.push({ t: base + j * (20 + r() * 50) * 60, kind: 'truck', face: 'cfs-truck', dk: 'deliver', pallets: Math.max(1, p), label: `出口拼箱送货（${Math.max(1, p)} 板）`, act: `卸货（${Math.max(1, p)} 板）`, inbound: true, exp: ex });
    }
  }
  // 保税库：进库的车（别的保税场所转来的货）、出库放行的车；海关上班时间
  const bondIn = Math.round(7 * traffic + r() * 3);
  const bondOut = Math.round(9 * traffic + r() * 3);
  const bondedStock0 = Math.round(1300 + r() * 300);
  for (let i = 0; i < bondIn + bondOut; i++) {
    const inbound = i < bondIn;
    const p = inbound ? 14 + Math.floor(r() * 9) : 8 + Math.floor(r() * 12);
    queue.push({ t: apptTime(r, CUSTOMS_OPEN, CUSTOMS_CLOSE - 3600), kind: 'truck', face: 'bonded', dk: inbound ? 'bonded-in' : 'bonded-out', pallets: p, label: inbound ? `保税货进库（${p} 板）` : `保税货出库放行（${p} 板）`, act: inbound ? `卸货进库（${p} 板）` : `出库装车（${p} 板）`, inbound, reefer: r() < 0.15 });
  }
  // 空箱堆场：外面的集卡还空箱、提空箱（6:00–21:30 到）
  const returns = Math.round(12 * traffic + r() * 4);
  const pickupsE = Math.round(10 * traffic + r() * 4);
  for (let i = 0; i < returns + pickupsE; i++) queue.push({ t: apptTime(r, 6 * 3600, 21.5 * 3600), kind: 'depot', dk: i < returns ? 'return' : 'pickup' });
  // 查验：今天卸的别家的箱按布控比例抽，加上本店的箱（按箱号抽，时间放得下才查，不能耽误仿真里拖车来提的时刻）
  for (const c of calls) {
    const nScan = Math.round(c.dis * scanRate * (0.8 + r() * 0.4));
    for (let i = 0; i < nScan; i++) {
      const discharged = c.t0 + r() * Math.max(600, c.t1 - c.t0);
      const p: Pick = { id: `${['XAAU', 'XBBU', 'XCCU', 'XDDU'][Math.floor(r() * 4)]} ${String(Math.floor(r() * 9e5) + 1e5)}`, own: false, color: Math.floor(r() * 12), ready: discharged + 2 * 3600, open: r() < openRate / scanRate };
      queue.push({ t: Math.max(p.ready, CUSTOMS_OPEN), kind: 'insp', p });
    }
  }
  const own = input.own ?? [];
  for (const b of own) {
    const u = hash01(b.id);
    if (u >= scanRate) continue;
    const p: Pick = { id: b.id, own: true, color: -1, ready: Math.max(b.discharged + 2 * 3600, CUSTOMS_OPEN), open: u < openRate, latest: b.pickup !== undefined ? b.pickup - 20 * 60 : DAY + 3 * 3600 };
    queue.push({ t: p.ready, kind: 'insp', p });
  }

  const inspectedOwn = new Map<string, PortInspection>();
  let dSeq = 1;
  for (let ev = popMin(); ev; ev = popMin()) {
    if (ev.kind === 'lcl') {
      const b = ev.b;
      // 打好托盘的箱一台叉车 40–60 分钟拆完；散装的（纸箱堆在箱里）一个班组边卸边打托，40 尺 1.5–2.5 小时
      const dur = Math.round((b.palletised ? (b.feet === 40 ? 40 + r() * 20 : 25 + r() * 15) : b.feet === 40 ? 90 + r() * 60 : 50 + r() * 30) * 60);
      if (ev.t > CFS_CLOSE) continue;
      // 先按「现在派车最早能到」排好门和班组（占下），到时候再派拖车：提前 15 分钟到堆场交接点挂箱
      const pl = planBox(ev.t + CY_LIFT + RUN.cyCfs + ENTER, dur, CFS_OPEN);
      if (!pl) continue;
      queue.push({ t: Math.max(ev.t, pl.back0 - ENTER - RUN.cyCfs - CY_LIFT - 300), kind: 'lclGo', b, pl });
    } else if (ev.kind === 'lclGo') {
      const { b, pl } = ev;
      // 送箱：拖车（带骨架车）到堆场交接点，龙门吊放上箱，开到集装箱侧（早到了在场地口等门）
      const want = pl.back0 - ENTER - RUN.cyCfs - CY_LIFT;
      const k = pick('cy', want, true);
      ensureChassis(k, want);
      const a = reach(k, 'cy', want);
      const atCy = drive(k, a.leave, 'cy');
      const lifted = cyLift(k, Math.max(atCy, want));
      const arrive = drive(k, lifted, 'cfs', 'full', { color: b.color, box: b.id });
      const j = boxIn(k, arrive, pl);
      const dock: PortDock = {
        id: b.id,
        label: `拼箱拆箱（${b.feet} 尺 · ${b.palletised ? '整托' : '散装'} · ${b.pallets} 板 · ${b.lots} 票）`,
        face: 'cfs-box',
        door: j.door,
        kind: 'devan',
        arrive,
        backAt: j.back0,
        docked: j.docked,
        start: j.start,
        done: j.done,
        pullAt: j.done,
        gone: j.done,
        pallets: b.pallets,
        tractorIn: k,
        wait: Math.max(0, j.back0 - arrive),
        color: b.color,
        box: b.id,
      };
      docks.push(dock);
      devanned.set(b.id, dock);
      queue.push({ t: j.done + HOOK_DELAY, kind: 'devanOut', b, j, dock });
      flows.push({ id: b.id, label: `拼箱 ${b.id}（${b.call}）`, own: false, units: 1, unit: '箱', steps: [{ zone: 'cy', t0: b.discharged, t1: lifted, act: '在堆场等拆箱' }], carrierIn: b.call });
      // 拆出来的货按收货人分票：理货、上架 20 分钟后可以提；三成当天来提（2–8 小时后），一成多转保税库，其余以后几天
      let left = b.pallets;
      for (let i = 0; i < b.lots; i++) {
        const p = i === b.lots - 1 ? left : Math.max(1, Math.min(left - (b.lots - 1 - i), Math.round(b.pallets / b.lots + (r() - 0.5) * 2)));
        left -= p;
        if (p <= 0) continue;
        const ready = j.done + 20 * 60;
        const lot: Lot = { id: `${b.id}-${i + 1}`, pallets: p, ready, bonded: r() < 0.15 };
        if (!lot.bonded && r() < 0.32) {
          const t = ready + (2 + r() * 6) * 3600;
          if (t < 21 * 3600) {
            lot.pickup = t;
            queue.push({ t, kind: 'truck', face: 'cfs-truck', dk: 'pickup', pallets: p, label: `收货人提货（${p} 板）`, act: `装车（${p} 板）`, inbound: false, lot });
          }
        }
        lots.push(lot);
      }
    } else if (ev.kind === 'devanOut') {
      const { b, j, dock } = ev;
      const o = boxOut(j, ev.t);
      Object.assign(dock, { pullAt: o.pullAt, gone: o.gone, tractorOut: o.k2 });
      // 拉空箱到空箱堆场，正面吊卸下；骨架车留在车上
      const atDepot = drive(o.k2, o.gone, 'depot', 'empty', { color: b.color, box: b.id });
      const st = stackers.earliest(atDepot, MANEUVER.reach, 30);
      stackers.take(st.i, st.t, st.t + MANEUVER.reach);
      const slot = depotPut(st.t + MANEUVER.reach, b.color, [atDepot - 5, st.t + MANEUVER.reach + 25]);
      act(o.k2, { kind: 'unload', t0: st.t, t1: st.t + MANEUVER.reach });
      if (slot) depot.push({ id: b.id, kind: 'from-cfs', arrive: atDepot, start: st.t, end: st.t + MANEUVER.reach, gone: st.t + MANEUVER.reach + 20, stacker: st.i, slot, color: b.color });
      const f = flows.find((x) => x.id === b.id);
      f?.steps.push({ zone: 'cfs-box', t0: j.back0, t1: o.gone, act: `拆箱（${b.pallets} 板）` });
    } else if (ev.kind === 'truck') {
      const d = truckVisit(ev.face, ev.dk, ev.t, ev.pallets, ev.label, ev.reefer);
      if (ev.exp) {
        const ex = ev.exp;
        ex.seen++;
        if (d) {
          ex.last = Math.max(ex.last, d.done);
          ex.cargo.push(d);
        }
        // 这一箱的货都到齐了：凑齐 30 分钟以后装箱（8:00–22:00 开始）
        if (ex.seen === ex.trucks && ex.last) queue.push({ t: Math.max(ex.last + 30 * 60, 8 * 3600), kind: 'stuff', e: ex });
      }
      if (!d) continue;
      truckFlow(d, ev.act, ev.inbound);
      if (ev.lot) flows.push({ id: `${ev.lot.id}-货`, label: `拼箱货 ${ev.lot.id}`, own: false, units: ev.lot.pallets, unit: '板', steps: [{ zone: 'cfs', t0: Math.max(ev.lot.ready, -2 * 3600), t1: d.start, act: '在库里等提货' }] });
    } else if (ev.kind === 'stuff') {
      const ex = ev.e;
      if (ev.t > CFS_CLOSE) {
        for (const d of ex.cargo) flows.push({ id: `${d.id}-货`, label: `出口货（${d.pallets} 板）`, own: false, units: d.pallets, unit: '板', steps: [{ zone: 'cfs', t0: d.done, t1: DAY + 3600, act: '在库里集货等装箱（明天装）' }] });
        continue;
      }
      const dur = Math.round((ex.feet === 40 ? 95 + r() * 40 : 55 + r() * 25) * 60);
      // 门和班组先排好（占下），到时候派拖车：骨架车到空箱堆场，正面吊放上一个空箱，开到集装箱侧
      const pl = planBox(ev.t + RUN.cfsDepot + MANEUVER.reach + ENTER + 120, dur, ev.t);
      if (!pl) continue;
      queue.push({ t: Math.max(ev.t, pl.back0 - ENTER - RUN.cfsDepot - MANEUVER.reach - 300), kind: 'stuffGo', e: ex, pl });
    } else if (ev.kind === 'stuffGo') {
      const { e: ex, pl } = ev;
      const want = pl.back0 - ENTER - RUN.cfsDepot - MANEUVER.reach;
      const k = pick('depot', want, true);
      ensureChassis(k, want);
      const a = reach(k, 'depot', want);
      const atDepot = drive(k, a.leave, 'depot');
      const st = stackers.earliest(Math.max(atDepot, want), MANEUVER.reach, 30);
      stackers.take(st.i, st.t, st.t + MANEUVER.reach);
      const got = depotTake(st.t, [atDepot - 5, st.t + MANEUVER.reach + 25]);
      const color = got?.color ?? Math.floor(r() * 12);
      act(k, { kind: 'loadEmpty', t0: st.t, t1: st.t + MANEUVER.reach });
      const arrive = drive(k, st.t + MANEUVER.reach, 'cfs', 'empty', { color, box: ex.id });
      if (got) depot.push({ id: ex.id, kind: 'to-cfs', arrive: atDepot, start: st.t, end: st.t + MANEUVER.reach, gone: st.t + MANEUVER.reach + 20, stacker: st.i, slot: got.s, color });
      const j = boxIn(k, arrive, pl);
      const dock: PortDock = { id: ex.id, label: `出口拼箱装箱（${ex.feet} 尺 · ${ex.total} 板）`, face: 'cfs-box', door: j.door, kind: 'stuff', arrive, backAt: j.back0, docked: j.docked, start: j.start, done: j.done, pullAt: j.done, gone: j.done, pallets: ex.total, tractorIn: k, wait: Math.max(0, j.back0 - arrive), color, box: ex.id };
      docks.push(dock);
      queue.push({ t: j.done + HOOK_DELAY, kind: 'stuffOut', e: ex, j, color, dock });
      // 集好的货在库里等到装箱（装箱时一板板叉进箱里）
      ex.cargo.forEach((d, i) => flows.push({ id: `${d.id}-货`, label: `出口货（${d.pallets} 板）`, own: false, units: d.pallets, unit: '板', steps: [{ zone: 'cfs', t0: d.done, t1: j.start + ((j.done - j.start) * (i + 1)) / Math.max(1, ex.cargo.length), act: '在库里集货等装箱' }] }));
    } else if (ev.kind === 'stuffOut') {
      const { e, j, color, dock } = ev;
      const o = boxOut(j, ev.t);
      Object.assign(dock, { pullAt: o.pullAt, gone: o.gone, tractorOut: o.k2 });
      // 满箱拉回堆场，龙门吊取下等装船
      const atCy = drive(o.k2, o.gone, 'cy', 'full', { color, box: e.id });
      const off = cyLift(o.k2, atCy);
      flows.push({ id: e.id, label: `出口拼箱 ${e.id}`, own: false, units: 1, unit: '箱', steps: [{ zone: 'cfs-box', t0: j.back0, t1: o.gone, act: `装箱（${e.total} 板）、施封` }, { zone: 'cy', t0: off, t1: DAY + 3600, act: '回堆场等装船' }], carrierOut: '等装船' });
    } else if (ev.kind === 'depot') {
      const st = stackers.earliest(ev.t, MANEUVER.reach, 30);
      let slot: PortDepotMove['slot'] | undefined;
      let color = Math.floor(r() * 12);
      const w: [number, number] = [st.t - 15, st.t + MANEUVER.reach + 45];
      if (ev.dk === 'return') slot = depotPut(st.t + MANEUVER.reach, color, w);
      else {
        const got = depotTake(st.t, w);
        slot = got?.s;
        if (got) color = got.color;
      }
      if (!slot) continue;
      stackers.take(st.i, st.t, st.t + MANEUVER.reach);
      const id = `E${String(dSeq++).padStart(3, '0')}`;
      const m: PortDepotMove = { id, kind: ev.dk, arrive: ev.t, start: st.t, end: st.t + MANEUVER.reach, gone: st.t + MANEUVER.reach + 40, stacker: st.i, slot, color, gateIn: ev.t - RUN.gateDepot, gateOut: st.t + MANEUVER.reach + 40 + RUN.depotGate };
      depot.push(m);
      flows.push({ id, label: ev.dk === 'return' ? '集卡还空箱' : '集卡提空箱', own: false, units: 1, unit: '车', steps: [{ zone: 'depot-lane', t0: m.arrive, t1: m.gone, act: ev.dk === 'return' ? '正面吊卸下空箱' : '正面吊吊上空箱' }], ...(ev.dk === 'return' ? { carrierIn: `集卡 ${id}` } : { carrierOut: `集卡 ${id}` }) });
    } else if (ev.kind === 'insp') {
      const p = ev.p;
      if (ev.t > CUSTOMS_CLOSE - 1800) continue;
      const openDur = p.open ? Math.round((90 + r() * 90) * 60) : 0;
      // 先估一下：拖车最早什么时候能把箱拉到机检通道、查完拉回堆场（本店的箱放不下就今天不查）
      const k = pick('cy', ev.t, true);
      const x = tr[k] as Tractor;
      const est0 = reach(k, 'cy', ev.t).arrive + (x.chassis ? 0 : CY_HOOK) + CY_LIFT + RUN.cyScan;
      const estEnd = est0 + MANEUVER.scan + (p.open ? RUN.scanBay + MANEUVER.backChassis + MANEUVER.couple + 120 + openDur + HOOK_DELAY + MANEUVER.couple + MANEUVER.pullOut + RUN.bayCy : RUN.cyScan) + CY_LIFT;
      if (p.latest !== undefined && estEnd > p.latest) continue;
      ensureChassis(k, ev.t);
      const a = reach(k, 'cy', ev.t);
      const atCy = drive(k, a.leave, 'cy');
      const lifted = cyLift(k, Math.max(atCy, ev.t));
      const s = scanner.earliest(lifted + RUN.cyScan, MANEUVER.scan, 30);
      drive(k, s.t - RUN.cyScan, 'scan', 'full', { color: p.color, box: p.id, own: p.own });
      scanner.take(0, s.t, s.t + MANEUVER.scan);
      act(k, { kind: 'scan', t0: s.t, t1: s.t + MANEUVER.scan });
      const ins: PortInspection = { box: p.id, own: p.own, color: p.color, ready: p.ready, scan: [s.t, s.t + MANEUVER.scan], back: 0, result: '机检正常，放行' };
      if (p.open) {
        // 开箱：倒到查验台边（候检车位排队），甩挂，查验员开箱查；查完来挂走
        const need = MANEUVER.backChassis + MANEUVER.couple + 120 + openDur + HOOK_DELAY + HOOK_ALLOW + MANEUVER.couple + MANEUVER.pullOut;
        const bg = bays.earliest(s.t + MANEUVER.scan + RUN.scanBay + ENTER, need, 60);
        // 查验台车位空出来再开过去（早了在机检通道出口外等）
        drive(k, Math.max(s.t + MANEUVER.scan, bg.t - RUN.scanBay - ENTER), 'bay', 'full', { color: p.color, box: p.id, own: p.own });
        const b0 = bg.t;
        act(k, { kind: 'drop', bay: bg.i, t0: b0, t1: b0 + MANEUVER.backChassis + MANEUVER.couple });
        (tr[k] as Tractor).chassis = false;
        bays.take(bg.i, b0, b0 + need);
        const o0 = b0 + MANEUVER.backChassis + MANEUVER.couple + 120;
        const o1 = o0 + openDur;
        ins.bay = bg.i;
        ins.open = [o0, o1];
        ins.result = '机检图像有疑点，开箱查验：货证相符，施封放行';
        queue.push({ t: o1 + HOOK_DELAY, kind: 'inspOut', p, ins, bay: bg.i, b0, need });
      } else {
        const atCy2 = drive(k, s.t + MANEUVER.scan, 'cy', 'full', { color: p.color, box: p.id, own: p.own });
        ins.back = cyLift(k, atCy2);
        inspections.push(ins);
        if (p.own) inspectedOwn.set(p.id, ins);
        else flows.push({ id: `查验 ${p.id}`, label: `布控的箱 ${p.id}`, own: false, units: 1, unit: '箱', steps: [{ zone: 'scan', t0: ins.scan[0], t1: ins.scan[1], act: '过机检通道' }] });
      }
    } else if (ev.kind === 'inspOut') {
      const { p, ins, bay, b0, need } = ev;
      const k2 = pick('bay', ev.t - ENTER_BOB, false);
      const a2 = reach(k2, 'bay', ev.t - ENTER_BOB);
      const at2 = drive(k2, a2.leave, 'bay');
      const hk = Math.max(at2 + ENTER_BOB, ev.t);
      act(k2, { kind: 'hook', bay, t0: hk, t1: hk + MANEUVER.couple });
      (tr[k2] as Tractor).chassis = true;
      const out = hk + MANEUVER.couple + MANEUVER.pullOut;
      const list = bays.busy[bay] as [number, number][];
      const i = list.findIndex(([a2_, b2_]) => a2_ === b0 && b2_ === b0 + need);
      if (i >= 0) list.splice(i, 1, [b0, out]);
      const atCy2 = drive(k2, out, 'cy', 'full', { color: p.color, box: p.id, own: p.own });
      ins.back = cyLift(k2, atCy2);
      inspections.push(ins);
      if (p.own) inspectedOwn.set(p.id, ins);
      else flows.push({ id: `查验 ${p.id}`, label: `布控的箱 ${p.id}`, own: false, units: 1, unit: '箱', steps: [{ zone: 'scan', t0: ins.scan[0], t1: ins.scan[1], act: '过机检通道' }, { zone: 'inspect', t0: b0, t1: out, act: '开箱查验' }] });
    }
  }
  // 当天没提走的货：拆完一直在库里（转保税的在保税库）
  for (const l of lots) if (l.pickup === undefined && l.ready > -1) flows.push({ id: `${l.id}-货`, label: `拼箱货 ${l.id}${l.bonded ? '（转保税库）' : ''}`, own: false, units: l.pallets, unit: '板', steps: [{ zone: l.bonded ? 'bonded' : 'cfs', t0: l.ready, t1: DAY + 3600, act: l.bonded ? '转进保税库存着' : '在库里等收货人来提' }] });
  inspections.sort((a, b) => a.scan[0] - b.scan[0]);

  // —— 货车侧、保税库：交给收货场引擎排场内的动作（先到先进、同一段同一时间只有一辆车调车、驶离优先），
  //    靠台、离场的时刻和排队按引擎的时间线（三维按同一份访问登记、取时间线画车，画面和数字一致） ——
  const yardVisits: PortHubPlan['yardVisits'] = { 'port-cfs-truck': [], 'port-bonded': [] };
  for (const key of ['port-cfs-truck', 'port-bonded'] as const) {
    const face = key === 'port-cfs-truck' ? 'cfs-truck' : 'bonded';
    const list = docks.filter((d) => d.face === face).sort((a, b) => a.arrive - b.arrive);
    const visits: YardVisit[] = list.map((d) => ({ id: d.id, vehicle: d.reefer ? 'reefer' : 'semi', door: d.door, arrive: d.arrive, dockAt: d.start, leaveAt: d.pullAt }));
    yardVisits[key] = visits;
    if (!visits.length) continue;
    const sched = scheduleYard(sectionPlan(key), visits);
    const byId = new Map(sched.timelines.map((tl) => [tl.visit.id, tl]));
    for (const d of list) {
      const tl = byId.get(d.id);
      if (!tl) continue;
      d.tl = tl;
      const waitSegs = tl.segs.filter((g) => g.kind === 'hold' || g.kind === 'queue');
      d.backAt = tl.backAt;
      d.docked = tl.dockedAt;
      d.gone = tl.goneAt;
      // 引擎排得紧、靠稳晚了的：靠稳以后才开始装卸（拉出的时刻不变，装卸压缩一点）
      if (d.start < tl.dockedAt) {
        d.start = tl.dockedAt;
        d.done = Math.max(d.start + 60, Math.min(d.done, d.pullAt));
      }
      d.wait = waitSegs.reduce((a, g) => a + g.t1 - g.t0, 0);
      // 引擎的驶出路线开到物流中心东头的车道上，再开约 40 秒到闸口出闸车道的排队点
      d.gateOut = tl.goneAt + 40;
    }
  }
  for (const d of docks) {
    const a = truckActs.get(d.id);
    if (!a) continue;
    const tl = d.tl;
    const queue = tl ? tl.segs.filter((g) => g.kind === 'hold' || g.kind === 'queue' || g.kind === 'approach') : [];
    const q0 = queue.length ? Math.min(...queue.map((g) => g.t0)) : d.arrive;
    const q1 = tl ? tl.enterAt : d.backAt;
    flows.push({
      id: d.id,
      label: d.label,
      own: false,
      units: 1,
      unit: '车',
      kind: 'vehicle',
      ...(d.reefer ? { cold: true } : {}),
      steps: [...(d.wait > 60 ? [{ zone: 'queue', t0: q0, t1: q1, act: `等${d.face === 'bonded' ? '保税库' : '货车侧'}的门` }] : []), { zone: d.face === 'bonded' ? 'bonded-dock' : 'cfs-truck', t0: tl ? tl.enterAt : d.backAt, t1: d.gone, act: a.act }],
      ...(a.inbound ? { carrierIn: `货车 ${d.id}` } : { carrierOut: `货车 ${d.id}` }),
    });
  }
  docks.sort((a, b) => a.arrive - b.arrive);

  // —— 本店的箱：卸到堆场 → （布控的先查验）→ 集装箱拖车提走（仿真给的时刻），整箱拉去物流园 ——
  const ownDwell: number[] = [];
  for (const b of own) {
    const ins = inspectedOwn.get(b.id);
    const steps: HubFlow['steps'] = [{ zone: 'cy', t0: b.discharged, t1: b.pickup ?? DAY + 3600, act: b.pickup !== undefined ? '在堆场等清关、提箱' : '在堆场等清关（今天还没来提）' }];
    if (ins) {
      steps.push({ zone: 'scan', t0: ins.scan[0], t1: ins.scan[1], act: '布控：过机检通道' });
      if (ins.open && ins.bay !== undefined) steps.push({ zone: 'inspect', t0: ins.open[0], t1: ins.open[1], act: '开箱查验' });
    }
    if (b.pickup !== undefined) {
      steps.push({ zone: 'gate', t0: b.pickup, t1: b.pickup + 120, act: `装上集装箱拖车出闸${b.dray ? `（${b.dray}）` : ''}` });
      ownDwell.push((b.pickup - b.discharged) / 3600);
    }
    flows.push({ id: b.id, label: `本店的箱 ${b.id}`, own: true, units: 1, unit: '箱', kind: 'cargo', ...(b.cold ? { cold: true } : {}), steps, carrierIn: b.liner ?? '本店班轮', ...(b.dray ? { carrierOut: b.dray } : {}) });
  }

  // —— 拖车干完活回停车位：两段活之间空得久的先回停车位，下一段从停车位出发 ——
  for (let k = 0; k < TR; k++) {
    const mine = legs.filter((l) => l.tractor === k).sort((a, b) => a.t0 - b.t0);
    for (let i = 0; i < mine.length; i++) {
      const l = mine[i] as PortTractorLeg;
      const free = Math.max(l.t1, l.then?.t1 ?? 0);
      const next = mine[i + 1];
      const gap = next ? next.t0 - free : Infinity;
      const toPark = RUN_BETWEEN(l.to, 'park');
      if (l.to === 'park' || (next && gap < toPark + RUN_BETWEEN('park', next.to) + 10 * 60)) continue;
      const load: PortTractorLeg['load'] = l.load === 'full' || l.load === 'empty' ? (l.then?.kind === 'drop' ? 'bobtail' : 'chassis') : l.then?.kind === 'drop' ? 'bobtail' : l.then?.kind === 'hook' ? 'chassis' : l.load;
      const home: PortTractorLeg = { tractor: k, from: l.to, to: 'park', t0: free + 30, t1: free + 30 + toPark, load };
      legs.push(home);
      if (next) {
        // 下一段改从停车位出发（到达的时刻不变）
        const run = RUN_BETWEEN('park', next.to);
        next.from = 'park';
        next.t0 = next.t1 - run;
      }
    }
  }
  legs.sort((a, b) => a.tractor - b.tractor || a.t0 - b.t0);

  // 外面的车过闸：在闸口（交单、过杆）各算 1 分钟
  for (const d of docks)
    if (d.gateIn !== undefined && d.gateOut !== undefined)
      flows.push({ id: `闸口 ${d.id}`, label: d.label, own: false, units: 1, unit: '车', steps: [{ zone: 'gate', t0: d.gateIn - 60, t1: d.gateIn, act: '进闸' }, { zone: 'gate', t0: d.gateOut, t1: d.gateOut + 60, act: '出闸' }] });
  for (const m of depot)
    if (m.gateIn !== undefined && m.gateOut !== undefined)
      flows.push({ id: `闸口 ${m.id}`, label: m.kind === 'return' ? '集卡还空箱' : '集卡提空箱', own: false, units: 1, unit: '车', steps: [{ zone: 'gate', t0: m.gateIn - 60, t1: m.gateIn, act: '进闸' }, { zone: 'gate', t0: m.gateOut, t1: m.gateOut + 60, act: '出闸' }] });
  // 空箱堆场每个箱位的占用（0 点的存货、进出的空箱）
  for (const [key, list] of slotUse)
    for (const u of list) {
      if (u.t1 <= -3600 || u.t0 >= DAY + 3600) continue;
      flows.push({ id: `空箱 ${key}`, label: '空箱', own: false, units: 1, unit: '箱', steps: [{ zone: 'empty', t0: Math.max(-3600, u.t0), t1: Math.min(DAY + 3600, u.t1), act: '堆在空箱堆场' }] });
    }
  const tractorsOut = legs;

  // ———————————————————————— 区、占用、指标 ————————————————————————
  // 每条流程标上是车还是货（没标的按单位）
  for (const f of flows) f.kind ??= f.unit === '车' ? 'vehicle' : 'cargo';
  const zones: HubZone[] = [
    { key: 'cy', label: '堆场', kind: 'storage', capacity: input.yard?.slots ?? 4320, unit: '箱' },
    { key: 'cfs-box', label: '拆装箱库 · 集装箱侧月台', kind: 'dock', capacity: CFS_BOX_DOORS, unit: '樘' },
    { key: 'cfs', label: '拆装箱库 · 库内', kind: 'storage', capacity: CFS_SLOTS, unit: '板' },
    { key: 'cfs-truck', label: '拆装箱库 · 货车侧月台', kind: 'dock', capacity: CFS_TRUCK_DOORS, unit: '樘' },
    { key: 'bonded', label: '保税仓库', kind: 'bonded', capacity: BONDED_SLOTS, unit: '板' },
    { key: 'bonded-dock', label: '保税仓库月台', kind: 'dock', capacity: BONDED_DOORS, unit: '樘' },
    { key: 'scan', label: '机检通道', kind: 'inspection', capacity: 1, unit: '车' },
    { key: 'inspect', label: '开箱查验台', kind: 'inspection', capacity: INSPECT_BAYS, unit: '箱' },
    { key: 'empty', label: '空箱堆场', kind: 'storage', capacity: EMPTY_SLOTS, unit: '箱' },
    { key: 'depot-lane', label: '空箱堆场 · 装卸车道', kind: 'work', capacity: 4, unit: '车' },
    { key: 'queue', label: '物流中心 · 等门的货车', kind: 'queue', capacity: 8, unit: '车' },
    { key: 'gate', label: '闸口（物流中心的车）', kind: 'queue', capacity: 6, unit: '车' },
  ];
  const occupancy = tallyOccupancy(zones, flows);
  // 库里的托盘：0 点时的存货 + 拆进来的 − 提走的（按 flows 已经数过今天的；0 点存货里今天不提的平铺）
  const cfsPallets = new Float32Array(HUB_SLOTS);
  const bondedPallets = new Float32Array(HUB_SLOTS);
  const cfsOcc = occupancy.cfs as Float32Array;
  const bondOcc = occupancy.bonded as Float32Array;
  // 保税库进出：进库的车卸完加、出库的车装车开始减
  const bondDelta = new Float32Array(HUB_SLOTS);
  for (const d of docks) {
    if (d.face !== 'bonded') continue;
    const k = Math.min(HUB_SLOTS - 1, Math.max(0, Math.floor((d.kind === 'bonded-in' ? d.done : d.start) / HUB_SLOT)));
    bondDelta[k] = (bondDelta[k] as number) + (d.kind === 'bonded-in' ? d.pallets : -d.pallets);
  }
  let acc = 0;
  for (let k = 0; k < HUB_SLOTS; k++) {
    acc += bondDelta[k] as number;
    cfsPallets[k] = cfsStock0 + (cfsOcc[k] as number);
    bondedPallets[k] = bondedStock0 + acc + (bondOcc[k] as number);
  }
  occupancy.cfs = cfsPallets;
  occupancy.bonded = bondedPallets;
  // 空箱堆场：0 点的存货已经在 flows 里（每个箱位的占用）
  if (input.yard) {
    const y = new Float32Array(HUB_SLOTS);
    for (let k = 0; k < HUB_SLOTS; k++) y[k] = input.yard.boxes[Math.min(k, input.yard.boxes.length - 1)] ?? 0;
    occupancy.cy = y;
  }

  const devans = docks.filter((d) => d.kind === 'devan');
  const stuffs = docks.filter((d) => d.kind === 'stuff');
  const trucks = docks.filter((d) => d.face !== 'cfs-box');
  const cfsTrucks = docks.filter((d) => d.face === 'cfs-truck');
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
  const peak = (a: Float32Array | undefined, from = 0, to = HUB_SLOTS) => {
    let m = 0;
    for (let k = from; k < to && a; k++) m = Math.max(m, a[k] as number);
    return m;
  };
  // 待拆的箱：已经卸下（可以拆了）还没开始拆的
  const backlogSeries = new Float32Array(HUB_SLOTS);
  for (const b of lcl) {
    const dk = devanned.get(b.id);
    const a = Math.max(0, b.ready);
    const e = dk ? dk.backAt : DAY;
    for (let k = Math.floor(a / HUB_SLOT); k < Math.min(HUB_SLOTS, Math.ceil(e / HUB_SLOT)); k++) backlogSeries[k] = (backlogSeries[k] as number) + 1;
  }
  const utilTruck = cfsTrucks.reduce((a, d) => a + Math.max(0, Math.min(DAY, d.gone) - Math.max(0, d.backAt)), 0) / (CFS_TRUCK_DOORS * (16 * 3600));
  const opens = inspections.filter((i) => i.open);
  const kpi: HubKpi[] = [
    { key: 'devanned', label: '今天拆箱', value: devans.length, unit: '箱', better: 'higher' },
    { key: 'stuffed', label: '今天装箱（出口拼箱）', value: stuffs.length, unit: '箱', better: 'higher' },
    { key: 'devanMean', label: '拆一个箱平均', value: mean(devans.map((d) => (d.done - d.start) / 60)), unit: '分钟', better: 'lower' },
    { key: 'backlogPeak', label: '待拆的箱最多', value: peak(backlogSeries), unit: '箱', better: 'lower' },
    { key: 'backlogEnd', label: '今天没拆完的箱', value: lcl.length - devans.length, unit: '箱', better: 'lower' },
    { key: 'cfsFill', label: '拆装箱库最满', value: (peak(cfsPallets) / CFS_SLOTS) * 100, unit: '%', better: 'lower' },
    { key: 'truckTurn', label: '货车在物流中心平均停留', value: mean(trucks.map((d) => (d.gone - d.arrive) / 60)), unit: '分钟', better: 'lower' },
    { key: 'dockWait', label: '货车等门平均', value: mean(trucks.map((d) => d.wait / 60)), unit: '分钟', better: 'lower' },
    { key: 'truckDoorUtil', label: '货车侧月台利用率（6–22 点）', value: utilTruck * 100, unit: '%' },
    { key: 'bondedStock', label: '保税库库存（24 点）', value: bondedPallets[Math.floor(DAY / HUB_SLOT) - 1] as number, unit: '板' },
    { key: 'scanned', label: '机检', value: inspections.length, unit: '箱' },
    { key: 'opened', label: '开箱查验', value: opens.length, unit: '箱' },
    { key: 'openMean', label: '开箱查验平均用时', value: mean(opens.map((i) => ((i.open as [number, number])[1] - (i.open as [number, number])[0]) / 60)), unit: '分钟', better: 'lower' },
    { key: 'emptyStock', label: '空箱堆场库存（24 点）', value: (occupancy.empty as Float32Array)[Math.floor(DAY / HUB_SLOT) - 1] as number, unit: '箱' },
    { key: 'ownDwell', label: '本店的箱在堆场平均停留（今天提走的）', value: mean(ownDwell), unit: '小时', better: 'lower' },
    { key: 'ownInspected', label: '本店的箱被布控', value: inspectedOwn.size, unit: '箱', better: 'lower' },
  ];
  const notes: string[] = [];
  const bk = peak(backlogSeries);
  notes.push(`今天拆拼箱 ${devans.length} 个、装出口拼箱 ${stuffs.length} 个；待拆的箱最多 ${Math.round(bk)} 个${lcl.length - devans.length > 0 ? `，${lcl.length - devans.length} 个留到明天` : ''}。`);
  const waits = trucks.filter((d) => d.wait > 600);
  if (waits.length) {
    const worst = waits.reduce((a, d) => (d.wait > a.wait ? d : a));
    notes.push(`${waits.length} 辆货车等门超过 10 分钟，最长 ${Math.round(worst.wait / 60)} 分钟（${clockOf(worst.arrive)} 到的${worst.face === 'bonded' ? '保税库' : '货车侧'}的车）。`);
  } else notes.push('货车到了基本不用等门。');
  if (inspectedOwn.size) notes.push(`本店的箱有 ${inspectedOwn.size} 个被布控：${[...inspectedOwn.values()].map((i) => `${i.box}${i.open ? '（开箱查验）' : '（机检）'}`).join('、')}，都在拖车来提之前查完。`);
  else if (own.length) notes.push(`本店的箱今天 ${own.length} 个，都没有被布控查验。`);
  notes.push(`查验：机检 ${inspections.length} 个箱、开箱 ${opens.length} 个（比例按方案：机检 ${Math.round(scanRate * 100)}%、开箱 ${Math.round(openRate * 1000) / 10}%）。`);

  const day: HubDay = { key: 'port', label: '港口物流中心', zones, flows, occupancy, kpi, notes };
  return { day, docks, tractors: tractorsOut, inspections, depot, depot0, cfsPallets, bondedPallets, rates: { lcl: LCL_SHARE, scan: scanRate, open: openRate }, yardVisits };
}
