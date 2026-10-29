import type { DayMetrics } from './day';

/**
 * 方案的日经营账（粗略估算，用于比较方案的相对差异，不是财务报表）。
 * 所有单价都是可调的假设值，默认按公开资料中常见的量级取整。
 */
export interface CostParams {
  /** 员工时薪（含福利，美元） */
  wagePerHour: number;
  /** 学生兼职工时薪（没有全职福利，美元；决策记录 0020） */
  studentWagePerHour: number;
  /** 线上订单平均金额 */
  avgOrderValue: number;
  /** 商品毛利率 */
  grossMargin: number;
  /** 每张未按时就绪订单的补偿与流失成本 */
  lateOrderCost: number;
  /** 每次长等待的顾客流失成本 */
  longWaitCost: number;
  /** 叉车日均成本（租赁 / 折旧 / 充电） */
  forkliftPerDay: number;
  /** 手动搬运车日均成本 */
  palletJackPerDay: number;
  /** 汽车服务收入的毛利率 */
  autoServiceMargin: number;
  /** 开门时还没上架的每箱货的缺货损失 */
  backlogCostPerCase: number;
}

export const DEFAULT_COSTS: CostParams = {
  wagePerHour: 18,
  studentWagePerHour: 14,
  avgOrderValue: 85,
  grossMargin: 0.25,
  lateOrderCost: 5,
  longWaitCost: 3,
  forkliftPerDay: 35,
  palletJackPerDay: 4,
  autoServiceMargin: 0.45,
  backlogCostPerCase: 1.5,
};

export const COST_LABEL: Record<keyof CostParams, string> = {
  wagePerHour: '员工时薪（$）',
  studentWagePerHour: '学生兼职时薪（$）',
  avgOrderValue: '线上订单均价（$）',
  grossMargin: '商品毛利率',
  lateOrderCost: '每张迟到订单成本（$）',
  longWaitCost: '每次长等待流失（$）',
  forkliftPerDay: '叉车每台每天（$）',
  palletJackPerDay: '搬运车每台每天（$）',
  autoServiceMargin: '汽车服务毛利率',
  backlogCostPerCase: '开门未上架每箱（$）',
};

export interface EconomicsInput {
  metrics: Pick<DayMetrics, 'orders' | 'fillRate' | 'staffedHoursTotal' | 'studentHours' | 'lateOrderPct' | 'longWaitPct' | 'handoffSessions' | 'shortValue'>;
  /** 收货与夜班工时 */
  receivingHours: number;
  nightHours: number;
  forklifts: number;
  palletJacks: number;
  backlogCases: number;
  /** 汽车服务当天收入 */
  autoRevenue: number;
}

export type PnLGroup = 'online' | 'service' | 'backroom';

export const PNL_GROUP_LABEL: Record<PnLGroup, string> = {
  online: '线上订单业务',
  service: '汽车服务',
  backroom: '后仓收货与补货',
};

export interface PnLLine {
  key: string;
  label: string;
  group: PnLGroup;
  /** 收入为正、成本为负 */
  value: number;
}

export interface DayPnL {
  lines: PnLLine[];
  /** 各部分小计 */
  groups: Record<PnLGroup, number>;
  revenue: number;
  cost: number;
  /**
   * 合计。模拟器不计算门店的店内销售收入，而后仓补货服务的是整个门店，
   * 所以合计通常为负；比较方案时看差值。
   */
  net: number;
  /** 线上订单业务的每单净额 */
  onlinePerOrder: number;
}

export function dayPnL(input: EconomicsInput, p: CostParams = DEFAULT_COSTS): DayPnL {
  const m = input.metrics;
  const lines: PnLLine[] = [
    { key: 'online', group: 'online', label: '线上订单毛利', value: m.orders * p.avgOrderValue * m.fillRate * p.grossMargin },
    { key: 'labor', group: 'online', label: '拣货、暂存与交付人工', value: -((m.staffedHoursTotal - (m.studentHours ?? 0)) * p.wagePerHour + (m.studentHours ?? 0) * p.studentWagePerHour) },
    { key: 'late', group: 'online', label: '迟到订单补偿', value: -m.orders * (m.lateOrderPct / 100) * p.lateOrderCost },
    { key: 'wait', group: 'online', label: '长等待流失', value: -m.handoffSessions * (m.longWaitPct / 100) * p.longWaitCost },
    { key: 'short', group: 'online', label: '缺货损失毛利', value: -m.shortValue * p.grossMargin },
    { key: 'auto', group: 'service', label: '汽车服务毛利', value: input.autoRevenue * p.autoServiceMargin },
    { key: 'inbound', group: 'backroom', label: '收货与夜班人工', value: -(input.receivingHours + input.nightHours) * p.wagePerHour },
    { key: 'equipment', group: 'backroom', label: '叉车与搬运车', value: -(input.forklifts * p.forkliftPerDay + input.palletJacks * p.palletJackPerDay) },
    { key: 'backlog', group: 'backroom', label: '开门未上架损失', value: -input.backlogCases * p.backlogCostPerCase },
  ];
  const groups: Record<PnLGroup, number> = { online: 0, service: 0, backroom: 0 };
  for (const l of lines) groups[l.group] += l.value;
  const revenue = lines.filter((l) => l.value > 0).reduce((n, l) => n + l.value, 0);
  const cost = -lines.filter((l) => l.value < 0).reduce((n, l) => n + l.value, 0);
  return { lines, groups, revenue, cost, net: revenue - cost, onlinePerOrder: groups.online / Math.max(1, m.orders) };
}

/** 一周各天的线上订单量系数（周一起，周末偏高；合理推测） */
export const WEEKDAY_FACTORS = [0.92, 0.9, 0.95, 1.0, 1.08, 1.2, 1.1] as const;
export const WEEKDAY_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

export interface Distribution {
  n: number;
  mean: number;
  min: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
}

/** 多日结果的分布（线性插值分位数） */
export function distribution(values: readonly number[]): Distribution {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0, mean: 0, min: 0, p10: 0, p50: 0, p90: 0, max: 0 };
  const q = (k: number) => {
    const i = (n - 1) * k;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return (v[lo] as number) + ((v[hi] as number) - (v[lo] as number)) * (i - lo);
  };
  return { n, mean: v.reduce((a, b) => a + b, 0) / n, min: v[0] as number, p10: q(0.1), p50: q(0.5), p90: q(0.9), max: v[n - 1] as number };
}
