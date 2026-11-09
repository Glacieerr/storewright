import { H } from '../core/sim';
import { DEFAULT_CATALOG, type CatalogOptions } from './catalog';
import { DEFAULT_DEMAND, type DemandOptions } from './demand';
import type { Generation } from './layout';

/** 员工岗位（两代流程共用一套名字，没用到的岗位排班为 0） */
export type Role =
  | 'picker' // 上一代：推车拣货
  | 'dispenser' // 上一代：暂存、交付、配送装车
  | 'porter' // 本方案：货格仓站台拣货员
  | 'decanter' // 本方案：拆箱入格
  | 'freshPicker' // 本方案：生鲜、冷冻、大件拣选
  | 'handoff' // 本方案：自提异常、年龄核验、配送装车
  | 'stocker' // 补货
  | 'receiver' // 收货
  | 'cashier' // 人工收银
  | 'host' // 上一代：自助结账看护；本方案：出口与自提柜服务
  | 'robotTech'; // 本方案：机器人值班与维护

export const ROLES: readonly Role[] = ['picker', 'dispenser', 'porter', 'decanter', 'freshPicker', 'handoff', 'stocker', 'receiver', 'cashier', 'host', 'robotTech'];

export interface Scenario {
  name: string;
  generation: Generation;
  seed: number;
  demand: DemandOptions;
  catalog: CatalogOptions;
  /** 是否记录动画轨迹（批量实验时关掉） */
  trace: boolean;
  online: {
    /** 推车 / 智能推车速度（米 / 秒）、每个拣货点和每件的时间、每车框数 */
    cartSpeed: number;
    perStopSec: number;
    perItemSec: number;
    totesPerCart: number;
    /** 拣货提前量：时段开始前多久放出（秒） */
    releaseLeadSec: number;
    /** 上一代：暂存每框、交付取框 / 核验 / 装车、提前准备的量 */
    stageSecPerTote: number;
    stageSecPerWalk: number;
    handoffSecPerTote: number;
    verifySec: number;
    loadSecPerTote: number;
    prepLeadSec: number;
    walkSpeed: number;
    /** 配送装车每单（秒） */
    deliveryLoadSec: number;
  };
  mfc: {
    bots: number;
    ports: number;
    portPicker: 'human' | 'arm';
    /** 机器人取一次箱的平均用时（含挖箱，秒）和变异系数 */
    botCycleSec: number;
    botCycleCv: number;
    /** 人在站台拣：每行、每件；机械臂：每件、成功率 */
    humanLineSec: number;
    humanItemSec: number;
    armItemSec: number;
    armSuccess: number;
    /** 站台到合流台的输送时间 */
    transferSec: number;
    decantSecPerCase: number;
    /** 演练：货格仓整体停机（断电、软件故障）的开始时刻和时长（秒） */
    outage?: { start: number; sec: number };
    /** 降级模式：停机时线上的包装商品改由门店作业员在卖场货架上拣（货架上同样有这些商品） */
    fallback: boolean;
  };
  pickup: {
    /** 自提柜格口数（按温区）和每格口能放的框数 */
    lockers: { ambient: number; chilled: number; frozen: number };
    totesPerCompartment: number;
    loaderSecPerTote: number;
    lockerPickupSec: number;
    lockerPickupSecPerTote: number;
    /** 免下车取货送框小车 */
    carts: number;
    cartSpeed: number;
    cartLoadSec: number;
    driveCustomerSec: number;
    driveCustomerSecPerTote: number;
    /** 送框小车在顾客预计到达前多久出发 */
    cartLeadSec: number;
    /** 需要人工处理的订单比例（替代确认、设备异常等） */
    exceptionShare: number;
  };
  robots: { amr: number; scanners: number; scrubbers: number; palletMovers: number; lockerLoaders: number };
  /** 机器人的平均无故障时间、平均修复时间（小时 / 分钟）；预测性维护让故障更少 */
  reliability: { mtbfHours: number; mttrMin: number };
  checkout: {
    staffedLanes: number;
    selfCheckouts: number;
    gates: number;
    staffedBaseSec: number;
    staffedItemSec: number;
    selfBaseSec: number;
    selfItemSec: number;
    payTimeSec: number;
    interventionRate: number;
    interventionSec: number;
    gateSec: number;
  };
  shopping: { baseSec: number; perItemSec: number; substitution: number; walkSpeed: number };
  shelf: {
    openFill: number;
    lowShare: number;
    /** 开门时货架就空着的商品比例（库存记录显示有货、其实没有，系统不会补，直到有人发现） */
    zeroAtOpen: number;
    reorderFrac: number;
    /** 上一代：巡店查缺货的时刻；本方案：盘点机器人巡航的时刻 */
    scanTimes: number[];
    scanDurationSec: number;
    /** 本方案：装了智能货架传感器的商品比例（按热销程度） */
    smartShelfShare: number;
    /** 拣货员 / 顾客发现缺货后上报的概率 */
    reportProb: number;
    fetchSec: number;
    stockSecPerUnit: number;
    /** 后仓记录不准：去了找不到 */
    phantomRate: number;
    /** 后仓也没有货的商品比例 */
    backroomOutRate: number;
  };
  inbound: {
    trucks: { time: number; kind: 'dc' | 'fresh' | 'dsd'; pallets: number; cases: number }[];
    unloadSecPerPallet: number;
    checkSecPerCase: number;
    dsdCheckSec: number;
    putawaySecPerPallet: number;
    /** 夜间 / 开门前上架：每箱用时（不进事件仿真，按工作量算工时） */
    nightSecPerCase: number;
  };
  staffing: {
    /** 排班依据的预测误差（每小时） */
    forecastError: number;
    /** 目标利用率（排班时给的余量） */
    targetUtil: number;
    /** 排班颗粒度（最短 4 小时班次等）带来的额外带薪工时 */
    shiftOverhead: number;
    /** 演练：排班按预测工作量的多少倍来排（没预料到的客流高峰：订单多 25%、排班仍按原预测 → 0.8） */
    planBias: number;
    /** 固定岗位每天的工时：生鲜加工、顾客服务、店长 */
    fixedHours: { fresh: number; service: number; management: number };
  };
  /**
   * 生鲜订货：预测误差、安全量系数（乘以误差）、陈列量（为了「看起来满」多放的天数，按大类再乘系数）、是否动态降价。
   * 陈列量是生鲜损耗的主要来源：货架上永远要多放一些，短保质期的商品就容易过期。
   */
  fresh: { forecastError: number; safety: number; presentationDays: number; dynamicMarkdown: boolean };
  energy: {
    refrigerationKw: number;
    hvacKw: number;
    lightingKw: number;
    lightingNightKw: number;
    itKw: number;
    solarKwp: number;
    batteryKwh: number;
  };
}

/** 上一代（Storewright 优化后的流程）：数字化的手机作业 + AI，但拣货、暂存、交付、补货全靠人 */
export function gen1(seed = 1, demand: Partial<DemandOptions> = {}): Scenario {
  return {
    name: '上一代（Storewright）',
    generation: 'gen1',
    seed,
    demand: { ...DEFAULT_DEMAND, ...demand },
    catalog: DEFAULT_CATALOG,
    trace: false,
    online: {
      cartSpeed: 0.7,
      // 每个拣货点 52 秒：在这个布局上校准到上一代实测的拣货效率（约 66 件 / 拣货工时，含暂存）
      perStopSec: 52,
      perItemSec: 10,
      totesPerCart: 8,
      releaseLeadSec: 150 * 60,
      stageSecPerTote: 12,
      stageSecPerWalk: 60,
      handoffSecPerTote: 6,
      verifySec: 60,
      loadSecPerTote: 8,
      prepLeadSec: 5 * 60,
      walkSpeed: 0.8,
      deliveryLoadSec: 180,
    },
    mfc: { bots: 0, ports: 0, portPicker: 'human', botCycleSec: 90, botCycleCv: 0.35, humanLineSec: 4, humanItemSec: 2.5, armItemSec: 5, armSuccess: 0.93, transferSec: 120, decantSecPerCase: 35, fallback: false },
    pickup: {
      lockers: { ambient: 0, chilled: 0, frozen: 0 },
      totesPerCompartment: 2,
      loaderSecPerTote: 20,
      lockerPickupSec: 50,
      lockerPickupSecPerTote: 8,
      carts: 0,
      cartSpeed: 1.2,
      cartLoadSec: 40,
      driveCustomerSec: 45,
      driveCustomerSecPerTote: 6,
      cartLeadSec: 4 * 60,
      exceptionShare: 0,
    },
    robots: { amr: 0, scanners: 0, scrubbers: 0, palletMovers: 0, lockerLoaders: 0 },
    reliability: { mtbfHours: 300, mttrMin: 30 },
    checkout: { staffedLanes: 6, selfCheckouts: 6, gates: 0, staffedBaseSec: 40, staffedItemSec: 3.2, selfBaseSec: 30, selfItemSec: 5.5, payTimeSec: 35, interventionRate: 0.1, interventionSec: 45, gateSec: 6 },
    shopping: { baseSec: 180, perItemSec: 27, substitution: 0.4, walkSpeed: 0.8 },
    shelf: {
      openFill: 0.9,
      lowShare: 0.08,
      zeroAtOpen: 0.015,
      reorderFrac: 0.35,
      scanTimes: [7 * H, 12 * H, 17 * H],
      scanDurationSec: 45 * 60,
      smartShelfShare: 0,
      reportProb: 0.5,
      fetchSec: 60,
      stockSecPerUnit: 7,
      phantomRate: 0.08,
      backroomOutRate: 0.06,
    },
    inbound: {
      trucks: [
        { time: 5 * H, kind: 'dc', pallets: 20, cases: 1000 },
        { time: 7.5 * H, kind: 'fresh', pallets: 8, cases: 320 },
        ...Array.from({ length: 8 }, (_, i) => ({ time: 6.5 * H + i * 0.55 * H, kind: 'dsd' as const, pallets: 1, cases: 40 })),
      ],
      unloadSecPerPallet: 240,
      checkSecPerCase: 3,
      dsdCheckSec: 8 * 60,
      putawaySecPerPallet: 120,
      nightSecPerCase: 80,
    },
    staffing: { forecastError: 0.15, targetUtil: 0.85, shiftOverhead: 0.08, planBias: 1, fixedHours: { fresh: 64, service: 30, management: 32 } },
    // 门店经理为了「货架看起来满」多订一些
    fresh: { forecastError: 0.28, safety: 1.0, presentationDays: 0.8, dynamicMarkdown: false },
    energy: { refrigerationKw: 120, hvacKw: 70, lightingKw: 38, lightingNightKw: 8, itKw: 2, solarKwp: 0, batteryKwh: 0 },
  };
}

/**
 * 本方案（StoreX，面向 2030 年）：
 * 线上订单的常温、冷藏包装商品由立体货格仓的机器人送到站台拣，生鲜、冷冻、大件由生鲜拣选员拣；
 * 合流后由机器人装进分温区自提柜，免下车取货由送框小车送到车边；货架靠智能货架和盘点机器人发现缺货，
 * 补货机器人送箱、员工上架；出口是免排队通道 + 视觉辅助自助结账；屋顶光伏 + 储能。
 * 设备数量是实验选出来的（见实验报告），这里是最终方案。
 */
export function storex(seed = 1, demand: Partial<DemandOptions> = {}): Scenario {
  const s = gen1(seed, demand);
  return {
    ...s,
    name: 'StoreX（本方案）',
    generation: 'storex',
    online: { ...s.online, cartSpeed: 0.85, perStopSec: 28, perItemSec: 8, totesPerCart: 6, releaseLeadSec: 120 * 60, deliveryLoadSec: 90 },
    mfc: { ...s.mfc, bots: 12, ports: 3, portPicker: 'human', fallback: true },
    pickup: {
      ...s.pickup,
      lockers: { ambient: 60, chilled: 48, frozen: 24 },
      carts: 2,
      exceptionShare: 0.03,
    },
    robots: { amr: 3, scanners: 1, scrubbers: 2, palletMovers: 1, lockerLoaders: 1 },
    reliability: { mtbfHours: 500, mttrMin: 20 },
    checkout: { ...s.checkout, staffedLanes: 2, selfCheckouts: 6, gates: 2, selfBaseSec: 25, selfItemSec: 3.8, payTimeSec: 25, interventionRate: 0.04 },
    shelf: {
      ...s.shelf,
      openFill: 0.96,
      lowShare: 0.02,
      // 开门前空着的商品比例和上一代一样（同样的夜班）；区别在发现：盘点机器人 6 点先巡一遍，开门前补上
      scanTimes: [6 * H, 8 * H, 11 * H, 14 * H, 17 * H, 20 * H],
      scanDurationSec: 60 * 60,
      smartShelfShare: 0.25,
      reportProb: 0.8,
      stockSecPerUnit: 5.5,
      phantomRate: 0.02,
      backroomOutRate: 0.02,
    },
    inbound: { ...s.inbound, unloadSecPerPallet: 240, checkSecPerCase: 0, dsdCheckSec: 3 * 60, putawaySecPerPallet: 60, nightSecPerCase: 60 },
    staffing: { ...s.staffing, forecastError: 0.07, fixedHours: { fresh: 64, service: 24, management: 32 } },
    // AI 按门店、商品、天气预测，订货量按损耗和缺货的代价平衡
    fresh: { forecastError: 0.15, safety: 0.8, presentationDays: 0.6, dynamicMarkdown: true },
    // 冷柜全部加门、二氧化碳跨临界制冷 + 热回收、按日光调光、AI 控制除霜和预冷
    energy: { refrigerationKw: 85, hvacKw: 52, lightingKw: 26, lightingNightKw: 4, itKw: 5, solarKwp: 250, batteryKwh: 500 },
  };
}

/** 2030 年的需求：线上订单翻倍（266 → 532 单），到店顾客略少 */
export const GROWTH_2030: Partial<DemandOptions> = { ordersPerDay: 532, shoppersPerDay: 1700 };

/**
 * 本方案的 2030 年配置：同一个货格仓、同一套自提柜，按实验结果加设备（货格机器人可以随时加，不用停业）。
 * 默认用 2030 年的需求；传入 demand 可以改订单量（容量实验用）。
 */
export const FLEET_2030 = { bots: 20, carts: 3, lockers: { ambient: 72, chilled: 56, frozen: 28 } };
export function storex2030(seed = 1, demand: Partial<DemandOptions> = {}): Scenario {
  const s = storex(seed, { ...GROWTH_2030, ...demand });
  return {
    ...s,
    name: 'StoreX 2030',
    mfc: { ...s.mfc, bots: FLEET_2030.bots },
    pickup: { ...s.pickup, carts: FLEET_2030.carts, lockers: { ...FLEET_2030.lockers } },
  };
}

/**
 * 对照方案：本方案去掉立体货格仓（其余技术都保留），线上订单全部由生鲜拣选员推智能推车在卖场拣。
 * 用来回答「货格仓本身值不值」。
 */
export function storexNoMfc(seed = 1, demand: Partial<DemandOptions> = {}): Scenario {
  return withoutMfc(storex(seed, demand));
}
export function withoutMfc(s: Scenario): Scenario {
  return { ...s, name: `${s.name} · 不建货格仓`, catalog: { ...s.catalog, mfcSkuCapacity: 0 }, mfc: { ...s.mfc, bots: 0, ports: 0, fallback: false } };
}

export function scenarioFor(generation: Generation, seed = 1, demand: Partial<DemandOptions> = {}): Scenario {
  return generation === 'gen1' ? gen1(seed, demand) : storex(seed, demand);
}
