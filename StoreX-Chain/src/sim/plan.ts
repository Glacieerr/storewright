import type { ChainScenario } from './config';

/**
 * 调度台能改的两层计划：
 *
 * - 常规计划：每天都照着排的时刻表（各温区的出车时段、门店的收货时段、长途直送车的收货时段、供应商到货预约、区域生鲜集货、
 *   航班、船期、港口铁路接驳、洲际班列），
 *   改了以后整段 18 周重新仿真，结果和原计划比；
 * - 当天调度：只改动画那一天的单个作业（某趟配送车几点走、某家供应商几点到、用哪个月台门、派哪辆车）。
 *
 * 不改任何东西时，仿真结果和报告里的数字完全一样。
 */
export type Zone = 'chilled' | 'frozen' | 'ambient' | 'multi';
export const ZONE_LABEL: Record<Zone | 'bakery', string> = { chilled: '冷藏', frozen: '冷冻', ambient: '常温', multi: '多温区', bakery: '面包' };

export interface StandingPlan {
  /** 这一代用到的温区的出车时段 [开始, 结束]（小时） */
  windows: Partial<Record<Zone, [number, number]>>;
  /** 单独排了收货时段的门店：门店编号 → [开始, 结束] */
  receive: Record<string, [number, number]>;
  /** 国内供应商到配送中心的预约时段 */
  inbound: [number, number];
  /** 区域生鲜集货车（内陆产区）几点到配送中心 */
  farm: number;
  /** 货运航班几点落地 */
  flight: number;
  /** 班轮每周几（0 = 周一）、几点靠泊 */
  vessel: { day: number; hour: number };
  /** 港口铁路接驳每周几、几点从港口发车 */
  rail: { days: number[]; hour: number };
  /** 洲际班列每周几（0 = 周一）、几点按时刻表到物流园货运站 */
  train: { day: number; hour: number };
  /** 门店收长途直送车的时段 */
  direct: [number, number];
}

export interface DayPlan {
  /** 配送车次 → 出发时刻（当天的小时） */
  depart: Record<string, number>;
  /** 进货（供应商 IN-商品族、区域生鲜 FR）→ 到配送中心的时刻；长途直送（DS-商品族）→ 到门店的时刻 */
  arrive: Record<string, number>;
  /** 作业 → 月台门 */
  door: Record<string, string>;
  /** 作业 → 车辆编号 */
  unit: Record<string, string>;
}

export const emptyDay = (): DayPlan => ({ depart: {}, arrive: {}, door: {}, unit: {} });
export const dayIsEmpty = (d: DayPlan): boolean => !Object.keys(d.depart).length && !Object.keys(d.arrive).length && !Object.keys(d.door).length && !Object.keys(d.unit).length;

/** 这一代用到哪些温区的出车时段：全链路是多温区车，前两代按温区分开派车 */
export const zonesOf = (s: ChainScenario): Zone[] => (s.fleet.consolidated ? ['multi'] : ['chilled', 'frozen', 'ambient']);

/** 最早几点能发车：分配库存以后半小时（上一代 / StoreX 前一晚 23 点分配，全链路当天 2 点分配） */
export const earliestDepart = (s: ChainScenario): number => (s.gen === 'g3' ? 2.5 : 0);

/** 分配库存的时刻（当天的小时）：进货赶不上它，就要等到下一次分配 */
export const allocationHour = (s: ChainScenario): number => (s.gen === 'g3' ? 2 : 23);

export function standingOf(s: ChainScenario): StandingPlan {
  const windows: StandingPlan['windows'] = {};
  for (const z of zonesOf(s)) windows[z] = [...s.fleet.windows[z]] as [number, number];
  return {
    windows,
    receive: Object.fromEntries(Object.entries(s.store.windows ?? {}).map(([k, w]) => [k, [...w] as [number, number]])),
    inbound: [...s.dc.inboundWindow] as [number, number],
    farm: s.dc.localArriveHour,
    flight: s.air.flightHour,
    vessel: { day: s.port.vesselDay, hour: s.port.vesselHour },
    rail: { days: [...s.port.railDays], hour: s.port.railHour },
    train: { day: s.rail.arriveDay, hour: s.rail.arriveHour },
    direct: [...s.flow.window] as [number, number],
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** 把常规计划写进场景（场景是新建的，可以直接改）；时刻都限制在合理范围里 */
export function applyStanding(s: ChainScenario, p: StandingPlan): ChainScenario {
  const first = earliestDepart(s);
  const windows = { ...s.fleet.windows };
  for (const [z, w] of Object.entries(p.windows) as [Zone, [number, number]][]) {
    const a = clamp(w[0], first, 22);
    windows[z] = [a, clamp(w[1], a + 0.25, 23.5)];
  }
  s.fleet = { ...s.fleet, windows };
  const receive: Record<string, [number, number]> = {};
  for (const [k, w] of Object.entries(p.receive)) {
    const a = clamp(w[0], 0, 23);
    receive[k] = [a, clamp(w[1], a + 0.5, 24)];
  }
  s.store = { ...s.store };
  if (Object.keys(receive).length) s.store.windows = receive;
  else delete s.store.windows;
  const i0 = clamp(p.inbound[0], 0, 23);
  s.dc = { ...s.dc, inboundWindow: [i0, clamp(p.inbound[1], i0 + 0.5, 24)], localArriveHour: clamp(p.farm, 0, 23.5) };
  s.air = { ...s.air, flightHour: clamp(p.flight, 0, 23.75) };
  s.port = { ...s.port, vesselDay: Math.round(clamp(p.vessel.day, 0, 6)), vesselHour: clamp(p.vessel.hour, 0, 23.5), railDays: [...new Set(p.rail.days.map((d) => Math.round(clamp(d, 0, 6))))].sort(), railHour: clamp(p.rail.hour, 0, 22) };
  s.rail = { ...s.rail, arriveDay: Math.round(clamp(p.train.day, 0, 6)), arriveHour: clamp(p.train.hour, 0, 23.5) };
  const d0 = clamp(p.direct[0], 0, 23);
  s.flow = { ...s.flow, window: [d0, clamp(p.direct[1], d0 + 0.5, 24)] };
  return s;
}

export const samePlan = (a: StandingPlan, b: StandingPlan): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 小时 → "05:30"（超过 24 点写成第二天） */
export function hhmm(h: number): string {
  const m = Math.round(h * 60);
  const day = Math.floor(m / 1440);
  const r = ((m % 1440) + 1440) % 1440;
  return `${day > 0 ? '次日 ' : day < 0 ? '前日 ' : ''}${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}
