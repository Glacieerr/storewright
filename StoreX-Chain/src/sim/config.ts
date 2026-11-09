import type { Source, Temp } from '../region/products';

/**
 * 三代全链路方案（同一个引擎、同一套需求、同一个区域、同一家综合型门店，只有流程不同）：
 *
 * - g1 = 上一代（Storewright）：门店用手机作业 + AI，但供应链是传统做法——门店按经验订货、配送中心只看到门店的订单、
 *   人工拣货、按温区分开派车、长途来的货全部先进配送中心、港口和机场按部就班；
 * - g2 = StoreX：门店升级成 StoreX（AI 预测订货、动态降价、机器人），上游不变；
 * - g3 = StoreX 全链路：门店 + 上游一起由全链路数字孪生协同——共享销售数据和促销日历、供应商管理库存、
 *   长途整车按规划直送门店（其余进配送中心）、配送中心自动化 + 生鲜越库、多温区合并配送、电动卡车、
 *   港口预清关和预约、铁路接驳、班列预清关、空运预清关越库。
 *
 * 货流（三代都一样的部分）：海运、铁路班列、空运来的货先进配送中心（拆箱、分拣），再用卡车送店；
 * 长途公路（含跨境）来的整车可以直送门店，也可以进配送中心，由 flow.direct 决定（规划见 flows.ts）。
 */
export type Gen = 'g1' | 'g2' | 'g3';

export type DisruptionKey = 'portCongestion' | 'airportClosed' | 'highwayClosed' | 'supplierOutage' | 'demandSurge';
export interface Disruption {
  key: DisruptionKey;
  /** 从第几天开始（0 起算）、持续几天 */
  start: number;
  days: number;
  /** 需求突增的倍数（不给 = 1.35） */
  factor?: number;
  /** 港口拥堵时班轮多晚到几天（不给 = 6） */
  delayDays?: number;
}

export interface Costs {
  driverHour: number;
  dcLaborHour: number;
  diesel: { perKm: number; perDay: number };
  ev: { perKm: number; perDay: number };
  trailerPerDay: { dry: number; reefer: number; multi: number };
  /** 柴油冷机每小时的油费（电动车的冷机用电，算在每公里里） */
  reeferPerHour: number;
  van: { perKm: number; perDay: number; driverHour: number };
  /** 供应商送货（到货价里含运费）：每车每公里 */
  inboundPerKm: number;
  drayage: { base: number; perKm: number; waitPerHour: number };
  railPerContainer: number;
  /** 洲际铁路班列每个 40 尺箱的运费 */
  railFreightPerFeu: number;
  demurragePerDay: number;
  oceanPerFeu: number;
  airPerKg: number;
  /** 库存持有成本（每年，占库存成本的比例） */
  carrying: number;
  /** 排放因子（千克二氧化碳） */
  co2: { dieselKm: number; reeferHour: number; evKm: number; vanKm: number; drayageKm: number; railContainerKm: number; oceanTonne: number; railTonne: number; airTonne: number };
}

export const COSTS: Costs = {
  driverHour: 32,
  dcLaborHour: 28,
  diesel: { perKm: 0.62, perDay: 210 },
  // 电动卡车按 2030 年的价格（比 2026 年便宜约三成）
  ev: { perKm: 0.28, perDay: 250 },
  trailerPerDay: { dry: 22, reefer: 38, multi: 48 },
  reeferPerHour: 3.1,
  van: { perKm: 0.35, perDay: 90, driverHour: 28 },
  inboundPerKm: 2.1,
  drayage: { base: 120, perKm: 2.5, waitPerHour: 60 },
  railPerContainer: 150,
  railFreightPerFeu: 4800,
  demurragePerDay: 75,
  oceanPerFeu: 2600,
  airPerKg: 2.4,
  carrying: 0.22,
  // 柴油半挂约 34 升 / 100 公里；电动卡车 1.25 千瓦时 / 公里 × 电网 0.35 千克 / 千瓦时；
  // 海运每吨约 9,000 公里 × 0.012；洲际班列每吨约 8,500 公里 × 0.022；空运每吨约 7,500 公里 × 0.6
  co2: { dieselKm: 0.92, reeferHour: 2.7, evKm: 0.44, vanKm: 0.32, drayageKm: 1.0, railContainerKm: 0.28, oceanTonne: 108, railTonne: 187, airTonne: 4500 },
};

export interface ChainScenario {
  name: string;
  gen: Gen;
  seed: number;
  /** 仿真天数、预热天数（预热期不计入结果） */
  days: number;
  warmup: number;
  /** 记录三维动画的那一天（-1 = 不记录） */
  traceDay: number;
  demand: {
    /** 需求整体倍数（容量实验用） */
    scale: number;
    /** 每周促销的商品族个数、促销提升 */
    promoPerWeek: number;
    promoUplift: number;
    /** 门店每天的总量波动 */
    storeNoise: number;
  };
  store: {
    /** 门店订货的预测误差（每天） */
    forecastError: number;
    /** 门店预测里能考虑到的促销提升比例 */
    promoKnown: number;
    safetyZ: number;
    /** 生鲜（易腐品）单独的安全系数；不设就和其他商品一样 */
    safetyZFresh?: number;
    /** 生鲜陈列量（天） */
    presentationDays: number;
    markdown: 'lastDay' | 'dynamic';
    /** 生鲜搬运、品相损耗的倍数 */
    spoilFactor: number;
    /** 每个温区在星期几送（0 = 周一）；分 A、B 两组门店错开 */
    deliveryDays: Record<Temp, { A: number[]; B: number[] }>;
    receiveFrom: number;
    /** 单独排了收货时段的门店：门店编号 → [开始, 结束]（小时）；没排的门店从 receiveFrom 开始收、按各温区的 dueBy 算准时 */
    windows?: Record<string, [number, number]>;
    unloadMin: number;
    unloadMinPerPallet: number;
  };
  dc: {
    /** 配送中心的预测依据：门店订单（看不到真实销售）还是共享的门店销售数据 */
    forecastFrom: 'orders' | 'pos';
    promoKnown: number;
    safetyZ: number;
    /** 不易腐商品每种货源隔几天下一次单（生鲜每天下单，海运冷箱每周） */
    reviewDays: Record<Source, number>;
    /** 下单到货到配送中心的天数（海运是到港天数）、波动 */
    leadDays: Record<Source, number>;
    leadCv: number;
    /** 劳动效率：拣货箱 / 工时（混合人工和自动化）、收货托盘 / 工时、装车托盘 / 工时 */
    pickRate: number;
    receiveRate: number;
    loadRate: number;
    fixedHours: number;
    /** 货到配送中心以后最少要多久才能装车：生鲜（越库时很短）、其他（上架） */
    freshHandlingHours: number;
    putawayHours: number;
    /** 区域生鲜（内陆产区）的集货车几点到配送中心 */
    localArriveHour: number;
    /** 国内供应商到配送中心的预约时段 [开始, 结束]（小时），车在时段里随机到 */
    inboundWindow: [number, number];
    /** 生鲜越库：本地生鲜按当晚的门店订单订，配送中心不留库存 */
    crossDock: boolean;
    automationShare: number;
  };
  fleet: {
    /** 多温区合并配送：每家店每天一辆车装所有温区 */
    consolidated: boolean;
    dynamicRouting: boolean;
    evShare: number;
    maxStops: number;
    /** 第一波车出发的时刻（分配库存的时刻跟着它定） */
    departStart: number;
    /** 各温区的出车时段 [开始, 结束]（小时）：车在时段里均匀出发，跑完回来可以再跑一趟 */
    windows: Record<'chilled' | 'frozen' | 'ambient' | 'multi', [number, number]>;
    /** 门店各温区最晚几点前到算准时 */
    dueBy: Record<'chilled' | 'frozen' | 'ambient' | 'multi', number>;
    /** 面包房自己用小货车直送门店 */
    bakeryDsd: boolean;
    /** 国内供应商的货有多少由自己回程的空车顺路带回 */
    backhaulShare: number;
  };
  port: {
    /** 每周几、几点有船靠港；平均晚到几天 */
    vesselDay: number;
    vesselHour: number;
    vesselDelayDays: number;
    /** 集装箱在堆场的平均停留天数（清关、提箱）、波动 */
    dwellDays: number;
    dwellCv: number;
    /** 拖车在港口闸口排队的小时 */
    gateWaitHours: number;
    /** 走铁路的集装箱比例、铁路班列每周几发车 */
    railShare: number;
    railDays: number[];
    /** 铁路班列几点从港口发车 */
    railHour: number;
    freeDays: number;
    /** 本店班轮每周几个航次（从 vesselDay 起在一周里均匀排开；不设 = 1） */
    callsPerWeek?: number;
  };
  /**
   * 铁路班列（洲际 / 内陆的整列集装箱班列，从东面进物流园货运站）：每周 arriveDay 的 arriveHour 按时刻表到站，
   * 平均晚 delayDays 天；在货运站查验、卸箱、调车 terminalHours 小时后进配送中心。下单后备货 leadDays.rail 天，
   * 赶上之后第一班「到站前 transitDays 天发车」的班列。
   */
  rail: { arriveDay: number; arriveHour: number; transitDays: number; delayDays: number; terminalHours: number; trainsPerWeek?: number };
  /** 货运航班：flightHour 是主航班；flightsPerDay > 1 时从主航班起每隔 24 / n 小时一班，当天的空运货分到各班 */
  air: { flightHour: number; handlingHours: number; crossDock: boolean; flightsPerDay?: number };
  /** 长途公路整车直送门店的商品族（其余进配送中心），以及门店收直送车的时段 [开始, 结束]（小时） */
  flow: { direct: string[]; window: [number, number] };
  twin: {
    /** 道路封闭时孪生提前改道（否则第一趟车要绕回去） */
    reroute: boolean;
    /** 发现供应商断货要几天 */
    detectOutageDays: number;
    /** 需求突增时订货多快跟上（天） */
    surgeResponseDays: number;
    /** 预先认证的备用供应商：发现断货后立即把卡住的订单转过去 */
    dualSource: boolean;
    /** 港口拥堵时向国内分销商「过桥采购」，并优先放行自己的集装箱 */
    bridgeBuy: boolean;
    /** 机场关闭时改降备降机场，卡车运回 */
    altAirport: boolean;
  };
  disruption?: Disruption;
  /** 同时发生的几种扰动（演练：台风 = 抢购 + 机场关闭 + 港口拥堵）；和 disruption 一起生效，同一种扰动只取第一条 */
  disruptions?: Disruption[];
  /** 记录每天每个商品族的需求、期望需求和促销，以及每班船、每列班列的晚到（预测模型训练用；不影响结果） */
  history?: boolean;
  /** 负荷档位（压力测试）：放大需求、加密航次 / 班列 / 航班；三维里的公共枢纽（别家的船、航班、外来集卡、社会车流）也跟着变密 */
  load?: LoadLevel;
  /** 当天调度：只改动画那一天的单个作业（调度台里拖动、改时刻） */
  plan?: DayOverrides;
  costs: Costs;
}

/** 当天调度的改动：配送车次的出发时刻、进货车的到达时刻（作业编号 → 当天的小时） */
export interface DayOverrides {
  depart?: Record<string, number>;
  arrive?: Record<string, number>;
}

// 海运下单到货约 6 周：跑 18 周，前 10 周预热（海运在途的货全部换成运行中下的单），后 8 周计入结果
const BASE_DAYS = 126;
const WARMUP = 70;

function base(gen: Gen, seed: number): Omit<ChainScenario, 'name' | 'store' | 'dc' | 'fleet' | 'port' | 'rail' | 'air' | 'flow' | 'twin'> {
  return { gen, seed, days: BASE_DAYS, warmup: WARMUP, traceDay: -1, demand: { scale: 1, promoPerWeek: 2, promoUplift: 0.6, storeNoise: 0.08 }, costs: COSTS };
}

/** 上一代：传统供应链 */
export function g1(seed = 1): ChainScenario {
  return {
    ...base('g1', seed),
    name: '上一代（Storewright）',
    store: {
      forecastError: 0.25,
      promoKnown: 0.5,
      safetyZ: 1.65,
      presentationDays: 0.8,
      markdown: 'lastDay',
      spoilFactor: 1,
      deliveryDays: {
        ambient: { A: [0, 2, 4], B: [1, 3, 5] },
        chilled: { A: [0, 1, 2, 3, 4, 5, 6], B: [0, 1, 2, 3, 4, 5, 6] },
        frozen: { A: [1, 4], B: [2, 5] },
      },
      receiveFrom: 6,
      unloadMin: 25,
      unloadMinPerPallet: 2,
    },
    dc: {
      forecastFrom: 'orders',
      promoKnown: 0,
      safetyZ: 1.65,
      reviewDays: { domestic: 7, local: 1, bakery: 1, sea: 14, rail: 7, air: 1 },
      leadDays: { domestic: 3, local: 1, bakery: 0, sea: 38, rail: 3, air: 2 },
      leadCv: 0.25,
      pickRate: 155,
      receiveRate: 22,
      loadRate: 30,
      fixedHours: 16,
      freshHandlingHours: 6,
      putawayHours: 8,
      localArriveHour: 4.5,
      inboundWindow: [6, 14],
      crossDock: false,
      automationShare: 0,
    },
    // 冷藏、冷冻早上送（4–9 点出车），常温下午送（12–18 点出车）
    fleet: { consolidated: false, dynamicRouting: false, evShare: 0, maxStops: 3, departStart: 4, windows: { chilled: [4, 9], frozen: [4, 9], ambient: [12, 18], multi: [4, 9] }, dueBy: { chilled: 11, frozen: 11, ambient: 20, multi: 11 }, bakeryDsd: true, backhaulShare: 0 },
    port: { vesselDay: 1, vesselHour: 6, vesselDelayDays: 0.6, dwellDays: 4.5, dwellCv: 0.5, gateWaitHours: 1.6, railShare: 0, railDays: [0, 2, 4], railHour: 14, freeDays: 3 },
    rail: { arriveDay: 2, arriveHour: 10, transitDays: 16, delayDays: 0.6, terminalHours: 12 },
    air: { flightHour: 5.5, handlingHours: 8, crossDock: false },
    flow: { direct: [], window: [6, 12] },
    twin: { reroute: false, detectOutageDays: 3, surgeResponseDays: 2, dualSource: false, bridgeBuy: false, altAirport: false },
  };
}

/** StoreX：门店升级，上游不变 */
export function g2(seed = 1): ChainScenario {
  const s = g1(seed);
  return {
    ...s,
    gen: 'g2',
    name: 'StoreX（门店升级）',
    store: { ...s.store, forecastError: 0.12, promoKnown: 0.9, presentationDays: 0.6, markdown: 'dynamic', spoilFactor: 0.85, receiveFrom: 5, unloadMin: 20, unloadMinPerPallet: 1.5 },
  };
}

/** StoreX 全链路：门店 + 上游一起协同 */
export function g3(seed = 1): ChainScenario {
  const s = g2(seed);
  const every = [0, 1, 2, 3, 4, 5, 6];
  return {
    ...s,
    gen: 'g3',
    name: 'StoreX 全链路',
    // 安全库存分品类：生鲜报废贵、系数低一些；常温缺货贵、系数高一些
    store: { ...s.store, forecastError: 0.08, promoKnown: 1, presentationDays: 0.5, safetyZ: 2.05, safetyZFresh: 1.28, deliveryDays: { ambient: { A: every, B: every }, chilled: { A: every, B: every }, frozen: { A: every, B: every } }, receiveFrom: 4, unloadMin: 15, unloadMinPerPallet: 1 },
    dc: {
      ...s.dc,
      forecastFrom: 'pos',
      promoKnown: 1,
      reviewDays: { domestic: 4, local: 1, bakery: 1, sea: 7, rail: 7, air: 1 },
      // 空运改订夜间到港的航班（第二天 23 点到）
      leadDays: { domestic: 2, local: 1, bakery: 0, sea: 38, rail: 3, air: 1 },
      leadCv: 0.1,
      // 八成的箱由自动化系统拣（每工时约 1,200 箱，含维护和监控），两成人工（180 箱 / 工时）
      pickRate: Math.round(1 / (0.8 / 1200 + 0.2 / 180)),
      receiveRate: 34,
      loadRate: 40,
      fixedHours: 20,
      freshHandlingHours: 1,
      putawayHours: 3,
      // 夜间集货：内陆产区的生鲜 1 点到，赶上早上那一波配送（越库）
      localArriveHour: 1,
      crossDock: true,
      automationShare: 0.8,
    },
    // 多温区车夜里和清早送（2:30–10 点出车，避开早高峰；门店无人值守收货）
    fleet: { consolidated: true, dynamicRouting: true, evShare: 0.6, maxStops: 4, departStart: 2.5, windows: { chilled: [2.5, 10], frozen: [2.5, 10], ambient: [2.5, 10], multi: [2.5, 10] }, dueBy: { chilled: 12, frozen: 12, ambient: 12, multi: 12 }, bakeryDsd: false, backhaulShare: 0.35 },
    port: { ...s.port, dwellDays: 1.6, dwellCv: 0.35, gateWaitHours: 0.3, railShare: 0.6 },
    // 班列改到夜里的时刻表、预清关：到站 4 小时后进配送中心
    rail: { ...s.rail, arriveHour: 3, delayDays: 0.4, terminalHours: 4 },
    air: { flightHour: 23, handlingHours: 2.5, crossDock: true },
    // 长途整车直送门店：按 flows.ts 的规划（整车能装满、保质期够、比进配送中心便宜的商品族），清早 4–10 点收
    flow: { direct: ['AMB_A', 'AMB_B', 'BEV', 'HH_DOM'], window: [4, 10] },
    twin: { reroute: true, detectOutageDays: 0.5, surgeResponseDays: 0.5, dualSource: true, bridgeBuy: true, altAirport: true },
  };
}

export const GEN_LABEL: Record<Gen, string> = { g1: '上一代', g2: 'StoreX', g3: 'StoreX 全链路' };

/**
 * 负荷档位：平常 = 基线（报告和商业分析按它算）；旺季、高负荷、极限用来做压力测试——
 * 需求放大，本店班轮每周的航次、洲际班列每周的班次、货运航班每天的班次加密（补货周期跟着缩短，每一班都有本店的货），
 * 港口铁路接驳每天都开；三维里的港口、机场、道路按 traffic 放大别家的船、航班、外来集卡和社会车流。
 */
export type LoadLevel = 'normal' | 'peak' | 'high' | 'extreme';
export const LOAD_LABEL: Record<LoadLevel, string> = { normal: '平常', peak: '旺季', high: '高负荷', extreme: '极限' };
export interface LoadSpec {
  demand: number;
  calls: number;
  trains: number;
  flights: number;
  /** 公共枢纽的背景流量倍数（别家的船和航班、外来集卡、社会车流） */
  traffic: number;
}
export const LOADS: Record<LoadLevel, LoadSpec> = {
  normal: { demand: 1, calls: 1, trains: 1, flights: 1, traffic: 1 },
  peak: { demand: 1.35, calls: 2, trains: 2, flights: 2, traffic: 1.4 },
  high: { demand: 1.8, calls: 3, trains: 3, flights: 3, traffic: 2 },
  extreme: { demand: 2.5, calls: 4, trains: 4, flights: 4, traffic: 2.8 },
};

/** 把场景换到某个负荷档位（平常档原样返回） */
export function withLoad(s: ChainScenario, level: LoadLevel): ChainScenario {
  if (level === 'normal') return { ...s, load: 'normal' };
  const L = LOADS[level];
  const review = (cur: number, n: number) => Math.max(1, Math.min(cur, Math.floor(7 / n)));
  return {
    ...s,
    load: level,
    demand: { ...s.demand, scale: s.demand.scale * L.demand },
    port: { ...s.port, callsPerWeek: L.calls, railDays: [0, 1, 2, 3, 4, 5, 6] },
    rail: { ...s.rail, trainsPerWeek: L.trains },
    air: { ...s.air, flightsPerDay: L.flights },
    dc: { ...s.dc, reviewDays: { ...s.dc.reviewDays, sea: review(s.dc.reviewDays.sea, L.calls), rail: review(s.dc.reviewDays.rail, L.trains) } },
  };
}

/** 每周的班次：从第一班那天起在一周里均匀排开（星期几，0 = 周一） */
export function weekDays(first: number, n = 1): number[] {
  const k = Math.max(1, Math.min(7, Math.round(n)));
  return [...new Set(Array.from({ length: k }, (_, i) => (first + Math.round((i * 7) / k)) % 7))].sort((a, b) => a - b);
}
export const vesselDays = (s: ChainScenario): number[] => weekDays(s.port.vesselDay, s.port.callsPerWeek);
export const trainDays = (s: ChainScenario): number[] => weekDays(s.rail.arriveDay, s.rail.trainsPerWeek);
/** 当天各班货运航班的落地时刻（小时）：主航班起每隔 24 / n 小时一班 */
export function flightHours(s: ChainScenario): number[] {
  const n = Math.max(1, Math.round(s.air.flightsPerDay ?? 1));
  return Array.from({ length: n }, (_, i) => (((s.air.flightHour - (i * 24) / n) % 24) + 24) % 24);
}
/** 从某天（可以带小数）起，下一个落在 days（星期几）里的整天 */
export function nextWeekDay(from: number, days: number[]): number {
  let a = Math.ceil(from - 1e-9);
  for (let k = 0; k < 8; k++, a++) if (days.includes(((a % 7) + 7) % 7)) return a;
  return a;
}

export function scenarioFor(gen: Gen, seed = 1): ChainScenario {
  return gen === 'g1' ? g1(seed) : gen === 'g2' ? g2(seed) : g3(seed);
}
