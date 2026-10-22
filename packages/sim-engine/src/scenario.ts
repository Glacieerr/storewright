import type { TemplateName } from '@storewright/store-config';
import { DEFAULT_DEMAND, type DemandScenario } from '@storewright/synth';
import type { TrafficParams } from './traffic';
import type { IncidentParams } from './incidents';

/**
 * 策略：同一套仿真，用不同的策略开关对比效果。
 * 基线代表「现状通用做法」的抽象，优化策略代表本系统；每个开关都可以单独打开，用于消融实验。
 */
export interface Policy {
  name: string;
  /** OPTIMIZED：体积 + 重量 + 压放 + 化学品分装；BY_EYE：凭目测按体积装框 */
  toteAssignment: 'OPTIMIZED' | 'BY_EYE';
  batching: 'ZONE_PARTITION' | 'FIFO';
  /** 分批单位：同一订单同温区的框是否必须同车 */
  batchUnit: 'ORDER' | 'TOTE';
  routing: 'TSP' | 'SSHAPE';
  /** 用冷链时限约束冷藏 / 冷冻批次大小 */
  coldLimit: boolean;
  /** 暂存时扫描格位并记录（交付时直接去取）；否则交付时需要寻找 */
  stagingRecord: boolean;
  /**
   * 何时开始取出已暂存的框：
   * ARRIVAL：顾客到达后才开始；ON_MY_WAY：顾客在应用中点击「我在路上」时开始（行业常见做法）；
   * ETA：按位置估算，距离到达不足固定阈值时开始（工程约束 EC-7）。
   */
  prepTrigger: 'ARRIVAL' | 'ON_MY_WAY' | 'ETA';
  /** 一个行程一次核验；否则逐单核验 */
  tripSingleCode: boolean;
  /** 货架缺货时异步去后仓补取 */
  exceptions: boolean;
  /** 覆盖门店配置中的框装填系数（用于比较不同的门店配置档位） */
  fillFactor?: number;
  /**
   * AI 模块（决策记录 0010，Phase 5c）：不设置时全部关闭，Phase 1 的结果不变。
   * - staffing：按订单预测重新分配各岗位每小时的人数（总工时不变）；
   * - eta：点了「我在路上」的顾客，按 AI 修正后的到达时间开始准备；
   * - substitution：替代推荐按学习排序，顾客接受率更高、拣货员挑选更快。
   */
  ai?: { staffing?: boolean; eta?: boolean; substitution?: boolean };
}

/**
 * AI 在仿真里的效果大小：取自 Phase 5b / 5c 在合成数据上的离线评估，在报告里列出并做敏感性分析。
 * - dayForecastErrorSd：订单量模型按天的相对误差标准差（两年历史、最后一年滚动回测，4 个种子）；
 * - etaErrorSdMin：到店时间修正的误差标准差（平均绝对误差 3.8 分钟 ≈ 正态分布标准差 4.8 分钟）；
 * - substitutionUplift：学习排序第一名的期望接受率 / 现有规则第一名（约 0.705 / 0.654）；
 * - etaSafetySd：按修正后的到达时间开始准备时，再提前多少个误差标准差（预测有误差，宁可略早）；
 * - substituteTimeFactor：有了排好序的推荐，拣货员挑选替代品的时间（假设缩短 30%）。
 */
export const AI_EFFECTS = { dayForecastErrorSd: 0.096, etaErrorSdMin: 4.8, etaSafetySd: 1, substitutionUplift: 1.078, substituteTimeFactor: 0.7 };

/** AI 消融实验：在给定策略上每次只打开一个 AI 模块，最后全部打开 */
export function aiAblationPolicies(base: Policy = OPTIMIZED): Policy[] {
  return [
    { ...base, name: `${base.name}+ai-staffing`, ai: { staffing: true } },
    { ...base, name: `${base.name}+ai-eta`, ai: { eta: true } },
    { ...base, name: `${base.name}+ai-substitution`, ai: { substitution: true } },
    { ...base, name: `${base.name}+ai-all`, ai: { staffing: true, eta: true, substitution: true } },
  ];
}

export const BASELINE: Policy = {
  name: 'baseline',
  toteAssignment: 'BY_EYE',
  batching: 'FIFO',
  batchUnit: 'TOTE',
  routing: 'SSHAPE',
  coldLimit: false,
  stagingRecord: false,
  prepTrigger: 'ON_MY_WAY',
  tripSingleCode: false,
  exceptions: false,
};

export const OPTIMIZED: Policy = {
  name: 'optimized',
  toteAssignment: 'OPTIMIZED',
  batching: 'ZONE_PARTITION',
  batchUnit: 'ORDER',
  routing: 'TSP',
  coldLimit: true,
  stagingRecord: true,
  prepTrigger: 'ETA',
  tripSingleCode: true,
  exceptions: true,
};

/**
 * 效率优先档位：允许同一订单的框分到不同推车、装填系数 0.8。
 * 与默认档位（服务与安全优先）对比，展示定制化配置的取舍。
 */
export const EFFICIENCY: Policy = { ...OPTIMIZED, name: 'efficiency', batchUnit: 'TOTE', fillFactor: 0.8 };

/** 消融实验：在基线上每次只打开一项优化 */
export function ablationPolicies(): Policy[] {
  const keys: Array<[keyof Policy, Policy[keyof Policy], string]> = [
    ['toteAssignment', 'OPTIMIZED', '+tote-assignment'],
    ['batching', 'ZONE_PARTITION', '+zone-batching'],
    ['routing', 'TSP', '+tsp-routing'],
    ['coldLimit', true, '+cold-limit'],
    ['stagingRecord', true, '+staging-record'],
    ['prepTrigger', 'ETA', '+eta-prep'],
    ['tripSingleCode', true, '+trip-code'],
    ['exceptions', true, '+exceptions'],
  ];
  return keys.map(([k, v, name]) => ({ ...BASELINE, [k]: v, name }));
}

/** 作业标准时间（秒、米/秒）。均为假设参数，在报告中列出并做敏感性分析。 */
export interface TimeParams {
  cartSpeedMps: number;
  walkSpeedMps: number;
  cartPrepSec: number;
  toteSetupSec: number;
  stopSec: number;
  unitSec: number;
  substituteSec: number;
  notFoundSec: number;
  stageRecordedSec: number;
  stageUnrecordedSec: number;
  findRecordedSec: number;
  searchBaseSec: number;
  searchPerOccupancySec: number;
  handoffWalkM: number;
  totesPerTrolley: number;
  codeVerifySec: number;
  toteScanSec: number;
  loadPerToteSec: number;
  idCheckSec: number;
  placementSec: number;
  exceptionBaseSec: number;
  exceptionVarSec: number;
  oversizedPieceSec: number;
  teamLiftExtraSec: number;
}

export interface BehaviorParams {
  /** 自取顾客开启位置共享的比例（ETA 触发需要） */
  locationShareRate: number;
  /** 自取顾客点击「我在路上」的比例，以及点击时距离到达的分钟数范围 */
  onMyWayTapRate: number;
  onMyWayLeadMin: [number, number];
  earlyArrivalShare: number;
  lateArrivalShare: number;
  substitutionFoundRate: number;
  /** 后仓实际没货时，库存记录仍显示有货的概率（库存记录不准） */
  phantomRecordRate: number;
  /** 后仓有货但员工没找到的概率 */
  backroomMissRate: number;
  vehicleTotes: number;
  vehicleMaxKg: number;
}

export interface Staffing {
  /** 每小时在岗人数，长度 24 */
  pick: number[];
  stage: number[];
  handoff: number[];
  exception: number[];
}

export interface SimScenario {
  demand: DemandScenario;
  staffing: Staffing;
  times: TimeParams;
  behavior: BehaviorParams;
  /** 计划周期（分钟）：每个周期释放已锁单的订单并生成批次 */
  planningIntervalMin: number;
  /** 时薪（美元，含福利），只用于把工时换算为成本 */
  hourlyWage: number;
  /** 毛利率，只用于把挽回的销售额换算为毛利 */
  grossMargin: number;
  /** 道路拥堵；不设置或强度为 0 时关闭 */
  traffic?: TrafficParams;
  /** 突发状况；不设置时关闭 */
  incidents?: IncidentParams;
  /** 覆盖 AI 的效果大小（敏感性分析用）；不设置时用 AI_EFFECTS */
  aiEffects?: Partial<typeof AI_EFFECTS>;
}

export const DEFAULT_TIMES: TimeParams = {
  cartSpeedMps: 0.7,
  walkSpeedMps: 1.2,
  cartPrepSec: 60,
  toteSetupSec: 8,
  stopSec: 40,
  unitSec: 10,
  substituteSec: 45,
  notFoundSec: 25,
  stageRecordedSec: 12,
  stageUnrecordedSec: 8,
  findRecordedSec: 6,
  searchBaseSec: 15,
  searchPerOccupancySec: 60,
  handoffWalkM: 35,
  totesPerTrolley: 8,
  codeVerifySec: 20,
  toteScanSec: 3,
  loadPerToteSec: 5,
  idCheckSec: 30,
  placementSec: 5,
  exceptionBaseSec: 180,
  exceptionVarSec: 240,
  oversizedPieceSec: 90,
  teamLiftExtraSec: 60,
};

export const DEFAULT_BEHAVIOR: BehaviorParams = {
  locationShareRate: 0.6,
  onMyWayTapRate: 0.7,
  onMyWayLeadMin: [8, 25],
  earlyArrivalShare: 0.1,
  lateArrivalShare: 0.05,
  substitutionFoundRate: 0.75,
  phantomRecordRate: 0.25,
  backroomMissRate: 0.1,
  vehicleTotes: 12,
  vehicleMaxKg: 160,
};

function hourly(ranges: Array<[number, number, number]>): number[] {
  const out = new Array<number>(24).fill(0);
  for (const [from, to, n] of ranges) for (let h = from; h < to; h++) out[h] = n;
  return out;
}

function scale(arr: number[], k: number): number[] {
  return arr.map((v) => (v === 0 ? 0 : Math.max(1, Math.round(v * k))));
}

/**
 * 中型店默认排班（每小时在岗人数）。这是假设参数：拣货人数按约 65% 的利用率配置，
 * 交付人数按基线策略下平均等待约 5–8 分钟配置（参照公开的路边取货等待时间调查）。
 */
const MEDIUM_STAFFING: Staffing = {
  pick: hourly([[6, 7, 3], [7, 9, 8], [9, 12, 12], [12, 15, 10], [15, 19, 12], [19, 21, 7], [21, 22, 2]]),
  stage: hourly([[6, 9, 1], [9, 20, 2], [20, 22, 1]]),
  handoff: hourly([[8, 10, 3], [10, 15, 4], [15, 20, 6], [20, 23, 3]]),
  exception: hourly([[8, 20, 1]]),
};

/** 中型店排班按倍数缩放（模板和自定义门店共用） */
export function scaledStaffing(k: number): Staffing {
  return {
    pick: scale(MEDIUM_STAFFING.pick, k),
    stage: scale(MEDIUM_STAFFING.stage, k),
    handoff: scale(MEDIUM_STAFFING.handoff, k),
    exception: scale(MEDIUM_STAFFING.exception, k),
  };
}

/** 三个模板的规模锚点：通道总数 → 日订单量、排班倍数 */
const SIZE_ANCHORS: Array<[number, number, number]> = [
  [8, 70, 0.3],
  [16, 260, 1],
  [31, 650, 2.5],
];

/**
 * 自定义门店的规模：按货架通道总数在三个模板之间分段线性插值（两端按最近一段外推），
 * 得到日订单量和排班倍数。模板本身的取值与 defaultScenario 一致。
 */
export function storeSizing(totalAisles: number): { ordersPerDay: number; staffScale: number } {
  const a = SIZE_ANCHORS;
  let i = 0;
  while (i < a.length - 2 && totalAisles > (a[i + 1] as [number, number, number])[0]) i++;
  const [x0, o0, k0] = a[i] as [number, number, number];
  const [x1, o1, k1] = a[i + 1] as [number, number, number];
  const f = (totalAisles - x0) / (x1 - x0);
  return { ordersPerDay: Math.max(30, Math.round(o0 + (o1 - o0) * f)), staffScale: Math.max(0.2, Math.round((k0 + (k1 - k0) * f) * 100) / 100) };
}

/**
 * 把按 7:00–22:00 设计的排班平移、伸缩到新的营业时间：
 * 新营业时间内每个小时取原排班中对应位置的人数；开门前和关门后各保留一小时的准备与收尾。
 */
export function shiftStaffing(base: Staffing, openMin: number, closeMin: number): Staffing {
  const B_OPEN = 7;
  const B_CLOSE = 22;
  const open = openMin / 60;
  const close = closeMin / 60;
  const ratio = (B_CLOSE - B_OPEN) / Math.max(1, close - open);
  const map = (arr: number[]): number[] =>
    Array.from({ length: 24 }, (_, h) => {
      if (h < Math.floor(open) - 1 || h >= Math.ceil(close) + 1) return 0;
      const src = Math.floor(B_OPEN + (h + 0.5 - open) * ratio);
      return arr[Math.min(23, Math.max(B_OPEN - 1, Math.min(B_CLOSE + 1, src)))] ?? 0;
    });
  return { pick: map(base.pick), stage: map(base.stage), handoff: map(base.handoff), exception: map(base.exception) };
}

export function defaultScenario(template: TemplateName): SimScenario {
  const k = template === 'small' ? 0.3 : template === 'large' ? 2.5 : 1;
  // 家居建材：订单少、行数少（拣货工作量约为中型超市的 1/4）。按与超市相同的口径校准：
  // 基线策略下拣货利用率约 57%（早高峰集中，开门第一个时段有迟到），平均等待约 4 分钟；每个岗位每小时至少 1 人
  const hw = template === 'hardware';
  return {
    demand: DEFAULT_DEMAND[template],
    staffing: hw
      ? // 建材店 6:00–21:00 营业（模板的营业时间）
        shiftStaffing(
          { pick: scale(MEDIUM_STAFFING.pick, 0.25), stage: scale(MEDIUM_STAFFING.stage, 0.5), handoff: scale(MEDIUM_STAFFING.handoff, 0.4), exception: scale(MEDIUM_STAFFING.exception, 0.5) },
          6 * 60,
          21 * 60,
        )
      : {
          pick: scale(MEDIUM_STAFFING.pick, k),
          stage: scale(MEDIUM_STAFFING.stage, k),
          handoff: scale(MEDIUM_STAFFING.handoff, k),
          exception: scale(MEDIUM_STAFFING.exception, k),
        },
    times: { ...DEFAULT_TIMES },
    behavior: { ...DEFAULT_BEHAVIOR },
    planningIntervalMin: 15,
    hourlyWage: 22,
    grossMargin: hw ? 0.33 : 0.25,
  };
}
