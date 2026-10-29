import type { Reason } from '@storewright/ai';
import type { Role } from '../day';

/**
 * 运营建议（AI 辅助，决策记录 0020）：模拟器按当天的仿真结果找问题，换几个随机种子（「别的几天」）看问题会不会反复出现，
 * 对可以执行的建议把动作应用到方案上再跑一遍，得出预计效果。
 * 理由只保存因素代码和数值（与决策记录 0010 的 AI 建议格式一致），界面按语言显示文字。
 */

/** 建议的方向：到货与卸货场、后仓与补货、线上订单暂存、前场、异常与风险 */
export type AdviceArea = 'INBOUND' | 'BACKROOM' | 'STAGING' | 'FRONT' | 'RISK';

export const ADVICE_AREAS: readonly AdviceArea[] = ['INBOUND', 'BACKROOM', 'STAGING', 'FRONT', 'RISK'];

export type AdviceSeverity = 'info' | 'warn' | 'critical';

/** 可以执行的动作：模拟器把它应用到方案上（可以撤销），再重新仿真 */
export type AdviceAction =
  /** 把一家供应商的送货预约挪到 to（当天的秒数），在它的送货时段之内 */
  | { kind: 'MOVE_APPOINTMENT'; deliveryId: string; from: number; to: number }
  /** 收货员人数 */
  | { kind: 'RECEIVERS'; from: number; to: number }
  /** 夜班补货组人数 */
  | { kind: 'NIGHT_CREW'; from: number; to: number }
  /** 按走得快慢分货位 */
  | { kind: 'SLOTTING'; policy: 'velocity' }
  /** 二楼托盘按紧缺程度送上货梯 */
  | { kind: 'LIFT_ORDER'; policy: 'urgency' }
  /** 某个岗位 fromHour–toHour（不含）每小时加 delta 人 */
  | { kind: 'STAFF'; role: Role; fromHour: number; toHour: number; delta: number }
  /** 各楼层每小时开几条人工收银通道 */
  | { kind: 'CHECKOUT_PLAN'; lanes: Array<{ floorId: string; byHour: number[] }> }
  /** 停车场高峰时安排人引导（写进当天计划） */
  | { kind: 'PARKING_GUIDE'; fromHour: number; toHour: number }
  /** 用 AI 排班（决策记录 0022 · D1 的规划孪生版）：拣货、暂存、交付每小时的人数整体换成排班生成器的结果 */
  | { kind: 'STAFF_PLAN'; staffing: { pick: number[]; stage: number[]; handoff: number[] } };

export interface AdviceEffect {
  /** 指标代码：YARD_WAIT、DOCK_TO_STOCK、OVERFLOW、BACKLOG、NIGHT_FINISH、STAGING_PEAK、WAIT、LABOR_HOURS、LANE_HOURS…… */
  metric: string;
  unit: 'MIN' | 'PALLETS' | 'CASES' | 'PCT' | 'HOURS' | 'CLOCK' | 'COUNT';
  before: number;
  after: number;
  /** 越小越好还是越大越好 */
  better: 'lower' | 'higher';
}

export interface Advice {
  /** 稳定的编号（方向:类型:对象），用来记采纳、忽略和反馈 */
  id: string;
  area: AdviceArea;
  /** 发现的问题类型（界面按它选文字模板） */
  code: string;
  severity: AdviceSeverity;
  /** 涉及的时段（当天的秒数） */
  from?: number;
  to?: number;
  /** 文字模板的参数 */
  params: Record<string, string | number>;
  /** 为什么：因素代码与数值，按权重排序 */
  reasons: Reason[];
  /** 做什么：可以一键采纳的动作；没有时只是提醒 */
  action?: AdviceAction;
  /** 预计效果：把动作应用到方案上再仿真的结果（几个随机种子的平均） */
  effect?: AdviceEffect[];
  /** 把握多大（0–1）：问题在别的几天里反复出现的比例、动作在每一天都有效 */
  confidence: number;
  /** 在别的几天（随机种子）里也出现的天数 / 一共看了几天 */
  recur?: { days: number; of: number };
  /** 定位：跳到这个时刻、看这个地方 */
  focus?: { t: number; kind: 'truck' | 'dock' | 'rack' | 'staging' | 'checkout' | 'lot' | 'lift'; ref?: string };
}

/** 把握：问题反复出现的比例占大头，动作在每一天都有效再加一点 */
export function confidenceOf(recurShare: number, consistent: boolean): number {
  return Math.round(Math.min(0.95, 0.3 + 0.5 * recurShare + (consistent ? 0.15 : 0)) * 100) / 100;
}

/** 平均（建议模块内部用） */
export const avg = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
