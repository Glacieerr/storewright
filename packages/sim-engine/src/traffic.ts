/**
 * 道路拥堵模型：按小时的拥堵指数 × 强度，拉长顾客和配送司机在路上的时间。
 *
 * 顾客按原计划出发（点击「我在路上」的时刻不变），堵车让实际到店时间推后；
 * 基于位置的 ETA 信号跟着实际到店时间走，而「我在路上」信号不会。
 * 这正是两种备货触发方式在高峰期表现不同的原因。
 *
 * level = 0 时完全关闭，结果与接入拥堵模型之前逐位相同（Phase 1 结果可复现）。
 */
export interface TrafficParams {
  /** 拥堵强度：0 关闭，1 一般城市，2 严重 */
  level: number;
  /** 24 个小时的拥堵指数（0–1） */
  profile: number[];
  /** 拥堵指数为 1、强度为 1 时，路上时间增加的比例 */
  slowdown: number;
  /** 个体差异：实际延误在均值的 [1 − spread, 1 + spread] 倍之间均匀分布 */
  spread: number;
}

/** 假设的工作日拥堵曲线：早高峰 7–9 点，午间小高峰，晚高峰 16–18 点最堵 */
export const DEFAULT_TRAFFIC_PROFILE: readonly number[] = [
  0.05, 0.03, 0.02, 0.02, 0.05, 0.15, 0.35, 0.75, 0.85, 0.5, 0.35, 0.4, 0.55, 0.45, 0.4, 0.55, 0.85, 1.0, 0.8, 0.5, 0.35, 0.25, 0.15, 0.08,
];

export const DEFAULT_TRAFFIC: TrafficParams = {
  level: 0,
  profile: [...DEFAULT_TRAFFIC_PROFILE],
  slowdown: 0.6,
  spread: 0.6,
};

/** 时刻 t（秒，可超过 24 小时）的拥堵程度 = 拥堵指数（相邻小时线性插值）× 强度 */
export function congestionAt(p: TrafficParams, t: number): number {
  const h = (((t / 3600) % 24) + 24) % 24;
  const h0 = Math.floor(h);
  const a = p.profile[h0 % 24] ?? 0;
  const b = p.profile[(h0 + 1) % 24] ?? 0;
  return (a + (b - a) * (h - h0)) * p.level;
}

/**
 * 路上延误（秒）= 自由流行驶时间 × slowdown × 出发时的拥堵程度 × 个体系数。
 * u 是 [0, 1) 的均匀随机数（调用方按订单键控，保证不同策略看到同样的路况）。
 */
export function trafficDelaySec(p: TrafficParams | undefined, departAt: number, freeFlowSec: number, u: number): number {
  if (!p || p.level <= 0) return 0;
  const c = congestionAt(p, departAt);
  return Math.max(0, Math.round(freeFlowSec * p.slowdown * c * (1 - p.spread + 2 * p.spread * u)));
}
