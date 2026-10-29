/**
 * 道路拥堵模型：按小时的拥堵指数 × 强度，拉长顾客和配送司机在路上的时间。
 *
 * 顾客按原计划出发（点击「我在路上」的时刻不变），堵车让实际到店时间推后；
 * 基于位置的 ETA 信号跟着实际到店时间走，而「我在路上」信号不会。
 * 这正是两种备货触发方式在高峰期表现不同的原因。
 *
 * level = 0 时完全关闭，结果与接入拥堵模型之前逐位相同（Phase 1 结果可复现）。
 *
 * 周边的问题（决策记录 0019，都是假设参数）：
 * - 学校：上学（7:15–8:30）、放学（14:45–15:45）时附近的路额外堵一阵（与拥堵强度无关，强度关闭时也有）；
 * - 铁路道口：火车约每 12 分钟经过一趟，道口关闭约 1 分钟；从道口那一侧来的车（约一半）碰上关闭时要等
 *   （按关闭时长均匀分布，加上放行后排队消散的 15 秒）。
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
  /** 附加的拥堵（与强度无关）：时段（小时）与增加的拥堵程度，例如学校的上学、放学 */
  extra?: Array<{ from: number; to: number; add: number }>;
  /** 铁路道口：平均间隔与每次关闭的秒数 */
  railway?: { headwaySec: number; closeSec: number };
}

/** 学校附近上学、放学的附加拥堵 */
export const SCHOOL_RUSH: NonNullable<TrafficParams['extra']> = [
  { from: 7.25, to: 8.5, add: 0.6 },
  { from: 14.75, to: 15.75, add: 0.5 },
];

/** 铁路道口：约每 12 分钟一趟车，每次关闭约 1 分钟 */
export const RAILWAY_CROSSING: NonNullable<TrafficParams['railway']> = { headwaySec: 720, closeSec: 60 };

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
  let c = (a + (b - a) * (h - h0)) * p.level;
  // 附加拥堵：时段两头各用 15 分钟渐入渐出
  for (const e of p.extra ?? []) {
    const k = Math.min(1, Math.max(0, (h - e.from) / 0.25), Math.max(0, (e.to - h) / 0.25));
    c += e.add * k;
  }
  return c;
}

/**
 * 路上延误（秒）= 自由流行驶时间 × slowdown × 出发时的拥堵程度 × 个体系数。
 * u 是 [0, 1) 的均匀随机数（调用方按订单键控，保证不同策略看到同样的路况）。
 */
export function trafficDelaySec(p: TrafficParams | undefined, departAt: number, freeFlowSec: number, u: number): number {
  if (!p || (p.level <= 0 && !p.extra?.length && !p.railway)) return 0;
  const c = congestionAt(p, departAt);
  let d = Math.max(0, Math.round(freeFlowSec * p.slowdown * c * (1 - p.spread + 2 * p.spread * u)));
  if (p.railway) {
    // 由 u 派生两个相互独立的随机数：从道口那一侧来（一半）、碰上道口关闭（关闭时长 / 间隔）
    const u2 = (u * 7919.137) % 1;
    const u3 = (u * 104729.71) % 1;
    const hit = p.railway.closeSec / p.railway.headwaySec;
    if (u2 < 0.5 && u3 < hit) d += Math.round((u3 / hit) * p.railway.closeSec + 15);
  }
  return d;
}
