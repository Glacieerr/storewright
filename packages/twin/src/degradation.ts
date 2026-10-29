import type { SensorDef } from './registry';
import type { Bucket } from './telemetry';

/**
 * 冷链设备的预测性维护（决策记录 0022 · 第二批 E1）。
 *
 * 越线才告警往往已经晚了：多数设备是慢慢变坏的。每台设备和自己的平时比：
 * - 趋势：每段时间（几分钟）取最低读数作为「底线温度」（去掉开门和除霜造成的短暂升温），
 *   用 Theil–Sen 稳健回归估计底线温度每小时升多少，外推多久到告警线（给出区间）；
 * - 开门回温：每分钟最高读数比底线高多少，和前一段时间比，明显变大（门封漏气、风机变弱）时留意；
 * - 读数卡住：好几分钟读数一点不变（正常时有小幅波动）时，传感器可能坏了，读数不可信。
 * 状态：正常、留意（在变坏，但离越线还远）、风险（预计在提前量之内越线）、读数卡住。
 * 演示门店的设备仿真按分钟变坏，真实设备按小时；两套参数见 DEMO_DEGRADATION、DEFAULT_DEGRADATION。
 */

export type HealthStatus = 'OK' | 'WATCH' | 'RISK' | 'STUCK';

export interface DegradationConfig {
  /** 看多长的历史（分钟） */
  windowMin: number;
  /** 取底线温度的时间段长度（分钟） */
  blockMin: number;
  /** 底线温度每小时至少升多少才算在变坏（°C） */
  slopeMin: number;
  /** 预计在多少分钟内越过告警线算风险 */
  horizonMin: number;
  /** 读数连续几分钟不变算卡住 */
  stuckMin: number;
}

export const DEFAULT_DEGRADATION: DegradationConfig = { windowMin: 360, blockMin: 10, slopeMin: 0.15, horizonMin: 12 * 60, stuckMin: 30 };
/** 演示门店：设备仿真里的慢性故障按分钟发展，几分钟内就能看到预警 */
export const DEMO_DEGRADATION: DegradationConfig = { windowMin: 12, blockMin: 2, slopeMin: 1, horizonMin: 30, stuckMin: 3 };

export interface DegradationResult {
  sensorId: string;
  status: HealthStatus;
  /** 底线温度（°C）与每小时的变化 */
  level?: number;
  slopePerHour?: number;
  /** 预计多少分钟后越过告警线（区间） */
  etaMin?: number;
  etaLow?: number;
  etaHigh?: number;
  /** 开门回温：这段时间的平均高出底线的幅度，和之前相比的倍数 */
  bump?: number;
  bumpRatio?: number;
  reasons: Array<{ factor: string; value?: number; params?: Record<string, string | number> }>;
}

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] as number;
}

/** Theil–Sen：两两斜率的中位数（对少数异常点稳健）；同时返回 10% / 90% 分位作为斜率的粗略区间 */
export function theilSen(pts: ReadonlyArray<[number, number]>): { slope: number; low: number; high: number } {
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const [x0, y0] = pts[i] as [number, number];
      const [x1, y1] = pts[j] as [number, number];
      if (x1 !== x0) slopes.push((y1 - y0) / (x1 - x0));
    }
  return { slope: median(slopes), low: quantile(slopes, 0.1), high: quantile(slopes, 0.9) };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 一台温控设备的健康评估（buckets：按分钟汇总的读数，时间升序） */
export function assessDegradation(def: SensorDef, buckets: readonly Bucket[], now: number, cfg: DegradationConfig = DEFAULT_DEGRADATION): DegradationResult {
  const out: DegradationResult = { sensorId: def.id, status: 'OK', reasons: [] };
  const L = def.limits;
  if (def.kind !== 'TEMP' || !L) return out;
  const MIN = 60_000;
  const win = buckets.filter((b) => b.n > 0 && b.t >= now - cfg.windowMin * MIN && b.t <= now);
  if (win.length < Math.max(4, cfg.stuckMin)) return out;

  // 读数卡住：最近 stuckMin 分钟每分钟的最高、最低和平均都一样，而之前有正常的小幅波动
  const tail = win.slice(-cfg.stuckMin);
  const flat = tail.length >= cfg.stuckMin && tail.every((b) => Math.abs(b.max - b.min) < 1e-6 && Math.abs(b.avg - (tail[0] as Bucket).avg) < 1e-6);
  const before = win.slice(0, -cfg.stuckMin);
  const noisy = before.some((b) => b.max - b.min > 0.02) || new Set(before.map((b) => b.avg.toFixed(3))).size > 1;
  if (flat && noisy) {
    out.status = 'STUCK';
    out.level = r1((tail[0] as Bucket).avg);
    out.reasons.push({ factor: 'STUCK', value: cfg.stuckMin });
    return out;
  }

  // 底线温度：每段时间的最低读数（冷的取最低，热保温取最高）
  const sign = L.direction === 'MAX' ? 1 : -1;
  const blocks = new Map<number, number>();
  for (const b of win) {
    const k = Math.floor((b.t - (now - cfg.windowMin * MIN)) / (cfg.blockMin * MIN));
    const v = sign > 0 ? b.min : b.max;
    const cur = blocks.get(k);
    blocks.set(k, cur === undefined ? v : sign > 0 ? Math.min(cur, v) : Math.max(cur, v));
  }
  const pts: Array<[number, number]> = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k * cfg.blockMin, v]);
  if (pts.length < 3) return out;
  const ts = theilSen(pts);
  const perHour = ts.slope * 60 * sign;
  const level = median(pts.slice(-2).map((p) => p[1]));
  out.level = r1(level);
  out.slopePerHour = r2(perHour);
  // 开门回温：每分钟最高读数高出底线的幅度，后一半和前一半比
  const half = Math.floor(win.length / 2);
  const bumpOf = (xs: readonly Bucket[]) => (xs.length ? xs.reduce((a, b) => a + Math.max(0, sign * ((sign > 0 ? b.max : b.min) - level)), 0) / xs.length : 0);
  const early = bumpOf(win.slice(0, half));
  const late = bumpOf(win.slice(half));
  out.bump = r2(late);
  out.bumpRatio = early > 0.05 ? r2(late / early) : undefined;

  if (perHour >= cfg.slopeMin) {
    const gap = sign * (L.limit - level);
    const eta = gap > 0 ? (gap / perHour) * 60 : 0;
    const fast = ts.high * 60 * sign > 0 ? Math.max(ts.high, ts.low) * 60 * sign : perHour;
    const slow = Math.max(1e-6, Math.min(ts.high, ts.low) * 60 * sign);
    out.etaMin = Math.round(eta);
    out.etaLow = Math.round(gap > 0 ? (gap / Math.max(perHour, fast)) * 60 : 0);
    out.etaHigh = Math.round(gap > 0 ? Math.min(10 * cfg.horizonMin, (gap / Math.max(slow, perHour * 0.5)) * 60) : 0);
    out.status = eta <= cfg.horizonMin ? 'RISK' : 'WATCH';
    out.reasons.push({ factor: 'TEMP_TREND', value: r2(perHour) }, { factor: 'TEMP_LEVEL', value: r1(level), params: { nominal: L.nominal, limit: L.limit } }, { factor: 'ETA_LIMIT', value: Math.round(eta), params: { low: out.etaLow, high: out.etaHigh } });
  } else if (perHour >= cfg.slopeMin / 2) {
    out.status = 'WATCH';
    out.reasons.push({ factor: 'TEMP_TREND', value: r2(perHour) });
  }
  if (out.bumpRatio !== undefined && out.bumpRatio >= 2 && late >= 0.4) {
    if (out.status === 'OK') out.status = 'WATCH';
    out.reasons.push({ factor: 'DOOR_RECOVERY', value: out.bumpRatio, params: { bump: r1(late) } });
  }
  return out;
}
