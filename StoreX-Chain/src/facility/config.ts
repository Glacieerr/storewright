import type { ChainScenario } from '../sim/config';

/**
 * 设施的布局、设备和人员排班（港口、机场、物流园、综合店）：管理台里改、或者按编号随机生成。
 *
 * 两层作用：
 * - 三维的设施作业按它排（岸桥几台、每台配几辆集卡、板车几套、立体库几条巷道、机器人几台、开几樘月台门、门店几个收货口……）；
 * - 和仿真有关的那几项换算成仿真参数（applyFacilities）：门店的规模和收货员决定需求和卸货快慢，机场的地面保障班组决定货站处理时间，
 *   港口闸口的车道和人员决定拖车排队，配送中心的叉车司机决定装卸效率——改了要重新仿真，结果、调度台和报告一起变。
 *
 * 排班按三班：早班 6–14 点、中班 14–22 点、夜班 22–6 点；每个岗位每班几个人。没人开的设备不开工。
 */
export type Shift = 'early' | 'late' | 'night';
export const SHIFTS: Shift[] = ['early', 'late', 'night'];
export const SHIFT_LABEL: Record<Shift, string> = { early: '早班 6–14', late: '中班 14–22', night: '夜班 22–6' };
export const shiftOf = (hour: number): Shift => {
  const h = ((hour % 24) + 24) % 24;
  return h >= 6 && h < 14 ? 'early' : h >= 14 && h < 22 ? 'late' : 'night';
};

/** 一个岗位：每班几个人、每小时工资（美元） */
export interface Role {
  key: string;
  label: string;
  /** 这个岗位开的是什么设备（没有就是不开设备的岗位） */
  drives?: string;
  wage: number;
  crew: Record<Shift, number>;
}

export interface PortCfg {
  /** 泊位个数（码头按泊位加长）：一个留给本店班轮，其余停别家的船 */
  berths: number;
  /** 本店班轮那段泊位的岸桥、别家的船每段泊位的岸桥 */
  ownCranes: number;
  otherCranes: number;
  /** 每台岸桥配几辆场内集卡 */
  gang: number;
  /** 闸口进、出各几条车道 */
  gateLanes: number;
  /** 检修中的设备（编号：QC1…、RTG1…） */
  down: string[];
  staff: Role[];
}
export interface AirportCfg {
  /** 货机机位个数（机坪按机位加长） */
  stands: number;
  /** 每个机位几套牵引车 + 板车 */
  dollySets: number;
  /** 一架货机卸几块集装板 */
  uldsPerFlight: number;
  down: string[];
  staff: Role[];
}
export interface DcCfg {
  /** 立体库的巷道数（每条一台堆垛机） */
  aisles: number;
  /** 货到人机器人 */
  amrs: number;
  /** 开放的月台门：干货（最多 26）、冷链（最多 12） */
  dryDoors: number;
  coldDoors: number;
  /** 铁路货运站的装卸线（每段站台几股道，龙门吊跨着全部装卸线） */
  railTracks: number;
  down: string[];
  staff: Role[];
}
export interface StoreCfg {
  /** 规模（销量相对 StoreX 那家店）：社区店 1、综合店 2.5、大卖场 4、超大卖场 5 */
  size: number;
  /** 收货口 */
  docks: number;
  /** 卖场的货架排数、后仓的货架排数 */
  gondolas: number;
  backroom: number;
  staff: Role[];
}
export interface Facilities {
  port: PortCfg;
  airport: AirportCfg;
  dc: DcCfg;
  store: StoreCfg;
}

const crew = (early: number, late: number, night: number): Record<Shift, number> => ({ early, late, night });

/** 默认的设施（和报告的基线一致） */
export function defaultFacilities(): Facilities {
  return {
    port: {
      berths: 2,
      ownCranes: 3,
      otherCranes: 3,
      gang: 5,
      gateLanes: 3,
      down: [],
      staff: [
        { key: 'qc', label: '岸桥司机', drives: '岸桥', wage: 46, crew: crew(6, 6, 6) },
        { key: 'rtg', label: '龙门吊司机', drives: '龙门吊', wage: 40, crew: crew(6, 6, 6) },
        { key: 'tt', label: '场内集卡司机', drives: '场内集卡', wage: 32, crew: crew(30, 30, 30) },
        { key: 'gate', label: '闸口查验员', wage: 28, crew: crew(6, 6, 3) },
        { key: 'lash', label: '绑扎工', wage: 30, crew: crew(8, 8, 8) },
        { key: 'ctrl', label: '中控调度', wage: 44, crew: crew(3, 3, 2) },
      ],
    },
    airport: {
      stands: 2,
      dollySets: 2,
      uldsPerFlight: 22,
      down: [],
      staff: [
        { key: 'loader', label: '平台车司机', drives: '平台车', wage: 34, crew: crew(2, 2, 2) },
        { key: 'tug', label: '牵引车司机', drives: '牵引车', wage: 30, crew: crew(4, 4, 4) },
        { key: 'ramp', label: '装卸工（机坪）', wage: 26, crew: crew(8, 8, 8) },
        { key: 'build', label: '货站拆板组板', wage: 26, crew: crew(10, 10, 12) },
        { key: 'fuel', label: '加油员', drives: '加油车', wage: 32, crew: crew(2, 2, 2) },
        { key: 'ctrl', label: '机坪调度', wage: 40, crew: crew(1, 1, 1) },
      ],
    },
    dc: {
      aisles: 20,
      amrs: 30,
      dryDoors: 26,
      coldDoors: 12,
      railTracks: 2,
      down: [],
      staff: [
        { key: 'fork', label: '叉车司机', drives: '叉车', wage: 28, crew: crew(14, 12, 10) },
        { key: 'pick', label: '拣货员（人工区）', wage: 24, crew: crew(18, 16, 12) },
        { key: 'recv', label: '收货员', wage: 24, crew: crew(8, 6, 6) },
        { key: 'auto', label: '自动化运维', wage: 38, crew: crew(4, 4, 3) },
        { key: 'ctrl', label: '库内调度', wage: 36, crew: crew(2, 2, 2) },
      ],
    },
    store: {
      size: 2.5,
      docks: 4,
      gondolas: 14,
      backroom: 3,
      staff: [
        { key: 'recv', label: '收货员', drives: '电动搬运车', wage: 22, crew: crew(3, 2, 2) },
        { key: 'stock', label: '理货员', wage: 21, crew: crew(10, 8, 6) },
        { key: 'pick', label: '线上拣货员', wage: 21, crew: crew(6, 8, 0) },
        { key: 'cash', label: '收银 / 客服', wage: 20, crew: crew(8, 10, 2) },
        { key: 'lead', label: '值班经理', wage: 34, crew: crew(1, 1, 1) },
      ],
    },
  };
}

/** 设施的取值范围（管理台的滑块、随机生成都在这里面） */
export const RANGES = {
  port: { berths: [2, 4], ownCranes: [2, 5], otherCranes: [2, 4], gang: [3, 7], gateLanes: [2, 3] },
  airport: { stands: [2, 6], dollySets: [1, 3], uldsPerFlight: [14, 28] },
  dc: { aisles: [8, 20], amrs: [10, 40], dryDoors: [10, 26], coldDoors: [4, 12], railTracks: [1, 4] },
  store: { size: [1, 5], docks: [2, 8], gondolas: [8, 16], backroom: [2, 5] },
} as const;

function rng(seed: number): () => number {
  let s = (Math.abs(Math.floor(seed)) * 48271) % 2147483647 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
const pick = (r: () => number, [a, b]: readonly [number, number], step = 1) => Math.round((a + r() * (b - a)) / step) * step;
/** 人员按设备数配：开设备的岗位每台设备一人（三班都有），其余岗位按默认的比例上下浮动 */
function scaleStaff(base: Role[], r: () => number, units: Record<string, number>): Role[] {
  return base.map((x) => {
    if (x.drives && units[x.drives] !== undefined) {
      const n = units[x.drives] as number;
      return { ...x, crew: crew(n, n, n) };
    }
    const k = 0.8 + r() * 0.5;
    return { ...x, crew: crew(Math.round(x.crew.early * k), Math.round(x.crew.late * k), Math.round(x.crew.night * k)) };
  });
}

/** 随机生成一套设施（同一个编号每次一样）；only 只随机这一个设施，其余保持 base */
export function randomFacilities(seed: number, base: Facilities = defaultFacilities(), only?: keyof Facilities): Facilities {
  const r = rng(seed);
  const d = defaultFacilities();
  const out: Facilities = JSON.parse(JSON.stringify(base));
  if (!only || only === 'port') {
    const own = pick(r, RANGES.port.ownCranes);
    const other = pick(r, RANGES.port.otherCranes);
    const gang = pick(r, RANGES.port.gang);
    const berths = pick(r, RANGES.port.berths);
    const cranes = own + other * (berths - 1);
    out.port = { berths, ownCranes: own, otherCranes: other, gang, gateLanes: pick(r, RANGES.port.gateLanes), down: [], staff: scaleStaff(d.port.staff, r, { 岸桥: cranes, 龙门吊: 3 * berths, 场内集卡: cranes * gang }) };
  }
  if (!only || only === 'airport') {
    const sets = pick(r, RANGES.airport.dollySets);
    const stands = pick(r, RANGES.airport.stands);
    out.airport = { stands, dollySets: sets, uldsPerFlight: pick(r, RANGES.airport.uldsPerFlight), down: [], staff: scaleStaff(d.airport.staff, r, { 平台车: stands, 牵引车: sets * stands, 加油车: Math.max(2, Math.ceil(stands / 2)) }) };
  }
  if (!only || only === 'dc') {
    out.dc = { aisles: pick(r, RANGES.dc.aisles), amrs: pick(r, RANGES.dc.amrs, 2), dryDoors: pick(r, RANGES.dc.dryDoors), coldDoors: pick(r, RANGES.dc.coldDoors), railTracks: pick(r, RANGES.dc.railTracks), down: [], staff: scaleStaff(d.dc.staff, r, {}) };
  }
  if (!only || only === 'store') {
    const size = pick(r, RANGES.store.size, 0.5);
    out.store = { size, docks: Math.max(2, Math.min(8, Math.round(size * 1.6))), gondolas: pick(r, RANGES.store.gondolas), backroom: pick(r, RANGES.store.backroom), staff: scaleStaff(d.store.staff, r, {}).map((x) => (x.key === 'recv' ? { ...x, crew: crew(Math.max(1, Math.round(size)), Math.max(1, Math.round(size * 0.8)), Math.max(1, Math.round(size * 0.8))) } : x)) };
  }
  return out;
}

/** 某个岗位某一班的人数 */
export const crewOf = (staff: Role[], key: string, sh: Shift): number => staff.find((x) => x.key === key)?.crew[sh] ?? 0;
/** 一天的人工成本（美元，三班各 8 小时） */
export const laborCost = (staff: Role[]): number => staff.reduce((a, x) => a + x.wage * 8 * (x.crew.early + x.crew.late + x.crew.night), 0);
/** 全天最少的那一班有几个人（设备能开几台看最紧的那一班） */
export const minCrew = (staff: Role[], key: string): number => Math.min(...SHIFTS.map((sh) => crewOf(staff, key, sh)));

/**
 * 和仿真有关的设施参数换算成场景参数（不改的就原样返回）：
 * - 门店规模：需求（×规模 / 2.5 的比例通过门店对象改，在 setStoreFacility 里）；收货员（早班）决定每托卸货的分钟数；
 * - 机场：板车套数和装卸工决定货站的处理小时；
 * - 港口：闸口车道和查验员决定拖车在闸口排队的小时；
 * - 配送中心：叉车司机和收货员相对默认的比例改收货、装车的效率（人少了每工时干得少一点：要等叉车）。
 */
export function applyFacilities(s: ChainScenario, f: Facilities): ChainScenario {
  const d = defaultFacilities();
  const ratio = (a: number, b: number) => (b > 0 ? a / b : 1);
  const recv = Math.max(1, crewOf(f.store.staff, 'recv', 'early'));
  const recv0 = crewOf(d.store.staff, 'recv', 'early');
  const teams = Math.max(0.5, Math.min(f.airport.dollySets, crewOf(f.airport.staff, 'tug', 'night') / 2) * Math.min(1.3, ratio(crewOf(f.airport.staff, 'build', 'night'), crewOf(d.airport.staff, 'build', 'night'))));
  const teams0 = d.airport.dollySets;
  const gate = Math.max(0.5, Math.min(f.port.gateLanes, crewOf(f.port.staff, 'gate', 'early') / 2));
  const gate0 = Math.min(d.port.gateLanes, crewOf(d.port.staff, 'gate', 'early') / 2);
  const fork = Math.min(1.25, Math.max(0.5, ratio(minCrew(f.dc.staff, 'fork'), minCrew(d.dc.staff, 'fork'))));
  const rv = Math.min(1.25, Math.max(0.5, ratio(minCrew(f.dc.staff, 'recv'), minCrew(d.dc.staff, 'recv'))));
  return {
    ...s,
    store: { ...s.store, unloadMinPerPallet: s.store.unloadMinPerPallet * Math.max(0.6, Math.min(3, recv0 / recv)) },
    air: { ...s.air, handlingHours: s.air.handlingHours * Math.max(0.7, Math.min(2.5, teams0 / teams)) },
    port: { ...s.port, gateWaitHours: s.port.gateWaitHours * Math.max(0.6, Math.min(3, gate0 / gate)) },
    dc: { ...s.dc, receiveRate: s.dc.receiveRate * Math.sqrt(fork * rv), loadRate: s.dc.loadRate * fork },
  };
}

/** 设施配置是不是默认的（默认就不用把它传给后台线程） */
export const isDefault = (f: Facilities): boolean => JSON.stringify(f) === JSON.stringify(defaultFacilities());
