import type { TemplateName } from '@storewright/store-config';
import { DEFAULT_DEMAND, type DemandScenario } from '@storewright/synth';

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

export function defaultScenario(template: TemplateName): SimScenario {
  const k = template === 'small' ? 0.3 : template === 'large' ? 2.5 : 1;
  return {
    demand: DEFAULT_DEMAND[template],
    staffing: {
      pick: scale(MEDIUM_STAFFING.pick, k),
      stage: scale(MEDIUM_STAFFING.stage, k),
      handoff: scale(MEDIUM_STAFFING.handoff, k),
      exception: scale(MEDIUM_STAFFING.exception, k),
    },
    times: { ...DEFAULT_TIMES },
    behavior: { ...DEFAULT_BEHAVIOR },
    planningIntervalMin: 15,
    hourlyWage: 22,
    grossMargin: 0.25,
  };
}
