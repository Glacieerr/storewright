/**
 * AI 建议的统一记录格式（决策记录 0010 第 2 节，原则 1、2）。
 *
 * 每条建议都写进事件流：发出时记录动作、置信度、主要理由、备选方案和模型版本；
 * 之后记录员工的处理和实际结果。理由只保存因素代码和数值，界面按语言显示文字。
 */

/** 可以单独设置运行模式的 AI 模块 */
export type AiModule =
  | 'FORECAST'
  | 'ETA'
  | 'AVAILABILITY'
  | 'SUBSTITUTION'
  | 'STAFFING'
  | 'REPLENISH'
  | 'COUNT'
  | 'MTO'
  | 'RETURNS'
  // 门店 AI 第二轮（决策记录 0021–0024）
  | 'FORESIGHT'
  | 'PICKING'
  | 'EQUIPMENT'
  | 'INBOUND'
  | 'FRONT'
  | 'CAPACITY'
  | 'STAGING'
  | 'EXPIRY';

export const AI_MODULES: readonly AiModule[] = ['FORESIGHT', 'FORECAST', 'ETA', 'AVAILABILITY', 'PICKING', 'SUBSTITUTION', 'STAFFING', 'REPLENISH', 'COUNT', 'STAGING', 'CAPACITY', 'INBOUND', 'FRONT', 'EQUIPMENT', 'EXPIRY', 'MTO', 'RETURNS'];

/** 只显示 / 需要确认 / 自动执行 */
export type AiMode = 'SHOW' | 'CONFIRM' | 'AUTO';

export const AI_MODES: readonly AiMode[] = ['SHOW', 'CONFIRM', 'AUTO'];

/** 各模块的默认模式：预测只是信息，到店时间修正自动执行，其余需要人确认 */
export const DEFAULT_AI_MODES: Record<AiModule, AiMode> = {
  FORECAST: 'SHOW',
  // 到店时间修正只改变交付看板上的提醒时间，风险低、频率高，默认自动执行（可以改成需确认）
  ETA: 'AUTO',
  // 核对货架、盘点只给补货员和后仓派任务，风险低：默认自动执行，不用等带班负责人采纳（决策记录 0026）
  AVAILABILITY: 'AUTO',
  SUBSTITUTION: 'CONFIRM',
  STAFFING: 'CONFIRM',
  REPLENISH: 'CONFIRM',
  COUNT: 'AUTO',
  // 出餐时间预测只调整熟食看板上的建议开始时间，默认自动执行
  MTO: 'AUTO',
  RETURNS: 'CONFIRM',
  // 运营预警：调人、提前开始、冷冻晚点拣、通知顾客延后，都要带班负责人确认
  FORESIGHT: 'CONFIRM',
  // 拣货：拆批、顺路核对只改变批次的组成和清单上的提示，风险低、频率高，默认自动执行
  PICKING: 'AUTO',
  EQUIPMENT: 'CONFIRM',
  INBOUND: 'CONFIRM',
  // 前场收银通道：只给建议（叫谁去开通道由带班负责人决定）
  FRONT: 'SHOW',
  CAPACITY: 'CONFIRM',
  STAGING: 'CONFIRM',
  EXPIRY: 'CONFIRM',
};

/**
 * 理由：一个影响结果的因素。
 * - factor：因素代码（例如 SAME_HOUR_LAST_WEEK），界面据此显示文字；
 * - value：因素本身的值（例如上周同时段 34 单）；
 * - effect：对结果的作用，乘法模型用倍数（1.18 表示 +18%），加法模型用与结果同单位的增量；
 * - weight：0–1 的相对重要性，所有理由加起来为 1，用于排序和显示长短条。
 */
export interface Reason {
  factor: string;
  value?: number;
  effect?: { kind: 'MULTIPLY' | 'ADD'; amount: number };
  weight: number;
  params?: Record<string, string | number>;
}

export interface RecAction {
  /** 动作代码：INFO 表示只是信息（例如预测），其他动作由各模块定义 */
  kind: string;
  params?: Record<string, string | number | boolean>;
}

export interface Alternative {
  action: RecAction;
  /** 与主建议同一量纲的评分，越大越好 */
  score: number;
  reasons?: Reason[];
}

export interface Prediction {
  value: number;
  /** 区间下限 / 上限（默认 80% 区间） */
  low?: number;
  high?: number;
  /** 单位代码，例如 ORDERS、MINUTES、PROBABILITY */
  unit: string;
  /** 预测覆盖的时间段（毫秒时间戳） */
  from?: number;
  to?: number;
  /** 对照值（例如平时同一时段的量），界面显示「比平时高 / 低多少」 */
  baseline?: number;
  /** 按类别拆分（例如按温区的商品行数） */
  breakdown?: { unit: string; values: Record<string, number> };
}

export interface ModelRef {
  /** 模型族，例如 orders-hourly */
  id: string;
  version: number;
  /** 算法，例如 seasonal-es */
  kind: string;
}

/** 由模块产生、还没有编号和模式的建议（发出时由作业核心补上） */
export interface RecommendationDraft {
  module: AiModule;
  /** 针对的对象：门店、订单号、商品号、员工号…… */
  target: string;
  action: RecAction;
  prediction?: Prediction;
  /** 0–1 */
  confidence: number;
  reasons: Reason[];
  alternatives: Alternative[];
  model: ModelRef;
  expiresAt: number;
}

export interface Recommendation extends RecommendationDraft {
  id: string;
  issuedAt: number;
  /** 发出时该模块的运行模式 */
  mode: AiMode;
}

/** 员工的处理结果 */
export type Resolution = 'ACCEPTED' | 'OVERRIDDEN' | 'DISMISSED' | 'EXPIRED' | 'SUPERSEDED' | 'AUTO_APPLIED';

/** 否决原因（必选）：反过来成为下一轮训练与评估的数据 */
export type OverrideReason = 'WRONG_DATA' | 'LOCAL_KNOWLEDGE' | 'NO_STAFF' | 'CUSTOMER_REQUEST' | 'DISAGREE' | 'OTHER';

export const OVERRIDE_REASONS: readonly OverrideReason[] = ['WRONG_DATA', 'LOCAL_KNOWLEDGE', 'NO_STAFF', 'CUSTOMER_REQUEST', 'DISAGREE', 'OTHER'];

/**
 * 把理由的权重归一化（和为 1），按权重从大到小排序，只保留前 n 条。
 * 权重缺失或全为 0 时按作用大小（倍数取对数的绝对值、增量取绝对值）计算。
 */
export function rankReasons(reasons: readonly Reason[], n = 3): Reason[] {
  const raw = reasons.map((r) => {
    if (r.weight > 0) return r.weight;
    if (!r.effect) return 0;
    return r.effect.kind === 'MULTIPLY' ? Math.abs(Math.log(Math.max(r.effect.amount, 1e-6))) : Math.abs(r.effect.amount);
  });
  const total = raw.reduce((a, b) => a + b, 0);
  return reasons
    .map((r, i) => ({ ...r, weight: total > 0 ? round3((raw[i] as number) / total) : round3(1 / reasons.length) }))
    .sort((a, b) => b.weight - a.weight || a.factor.localeCompare(b.factor))
    .slice(0, n);
}

/**
 * 由预测区间得到置信度：区间相对点预测越窄，置信度越高。
 * conf = 1 / (1 + 相对半宽)，相对半宽 = (high − low) / (2 · max(|value|, floor))。
 */
export function confidenceFromInterval(value: number, low: number, high: number, floor = 1): number {
  const half = Math.max(0, high - low) / 2;
  return round3(1 / (1 + half / Math.max(Math.abs(value), floor)));
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
