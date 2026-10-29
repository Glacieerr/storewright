import { rankReasons } from '@storewright/ai';
import type { Role } from '../day';
import { avg, confidenceOf, type Advice } from './types';

/**
 * 线上订单暂存的建议（决策记录 0020 · 方向 3）：按温区预测常温、冷藏、冷冻暂存（含冷藏库、冷冻库）什么时候最满；
 * 快满时试着在高峰前后多排一名交付员（顾客到了交付得快，订单在暂存区待得短），看峰值能降多少、顾客少等多久。
 */

export type StagingZone = 'AMBIENT' | 'CHILLED' | 'FROZEN';
export const STAGING_ZONES: readonly StagingZone[] = ['AMBIENT', 'CHILLED', 'FROZEN'];

/** 一次线上订单仿真里暂存区的占用（按分钟，0–1）与顾客等待 */
export interface StagingRun {
  t0: number;
  step: number;
  occ: Record<StagingZone, number[]>;
  /** 各温区的暂存格位（框数） */
  capacity: Record<StagingZone, number>;
  avgWaitMin: number;
  longWaitPct: number;
  /** 未按时就绪的订单比例（%） */
  lateOrderPct: number;
  /** 每小时（按到店时刻）等得太久的顾客 */
  longWaitByHour: number[];
}

export interface StaffChange {
  role: Role;
  fromHour: number;
  toHour: number;
  delta: number;
}

export interface StagingLab {
  run(staff: readonly StaffChange[], seed: number): StagingRun;
  seeds: readonly number[];
}

/** 提醒的档位：90% 以上紧急、80% 以上提醒、65% 以上给出高峰预报 */
const LEVELS: Array<[number, Advice['severity']]> = [
  [0.9, 'critical'],
  [0.8, 'warn'],
  [0.65, 'info'],
];

const peakOf = (a: readonly number[]): { v: number; i: number } => a.reduce((m, v, i) => (v > m.v ? { v, i } : m), { v: 0, i: 0 });
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function adviseStaging(lab: StagingLab, runs: readonly StagingRun[]): Advice[] {
  const base = runs[0];
  if (!base) return [];
  const out: Advice[] = [];
  const two = lab.seeds.slice(0, Math.min(2, lab.seeds.length));
  for (const z of STAGING_ZONES) {
    if (!base.capacity[z]) continue;
    const arr = base.occ[z];
    const pk = peakOf(arr);
    const level = LEVELS.find(([th]) => pk.v >= th);
    if (!level) continue;
    const [th, severity] = level;
    // 高峰时段：峰值附近高于（峰值 − 10 个百分点）的连续分钟
    let i0 = pk.i;
    let i1 = pk.i;
    while (i0 > 0 && (arr[i0 - 1] as number) >= pk.v - 0.1) i0--;
    while (i1 < arr.length - 1 && (arr[i1 + 1] as number) >= pk.v - 0.1) i1++;
    const from = base.t0 + i0 * base.step;
    const to = base.t0 + i1 * base.step;
    const peakAt = base.t0 + pk.i * base.step;
    // 别的几天：同一温区在差不多的时间（前后 1.5 小时）也到这个档位
    const recur = runs.filter((r) => {
      const a = r.occ[z];
      return a.some((v, i) => v >= th - 0.05 && Math.abs(r.t0 + i * r.step - peakAt) <= 1.5 * 3600);
    }).length;
    const change: StaffChange = { role: 'handoff', fromHour: Math.max(0, Math.floor(from / 3600) - 1), toHour: Math.min(24, Math.ceil(to / 3600) + 1), delta: 1 };
    const after = two.map((s) => lab.run([change], s));
    const before = two.map((_, i) => runs[i] as StagingRun);
    const peakBefore = avg(before.map((r) => peakOf(r.occ[z]).v));
    const peakAfter = avg(after.map((r) => peakOf(r.occ[z]).v));
    const waitBefore = avg(before.map((r) => r.avgWaitMin));
    const waitAfter = avg(after.map((r) => r.avgWaitMin));
    const helps = peakBefore - peakAfter >= 0.03 || waitBefore - waitAfter >= 0.4;
    const reasons = rankReasons(
      [
        { factor: 'ZONE_PEAK', value: Math.round(pk.v * 100), weight: 0.45, params: { zone: z, at: Math.round(peakAt) } },
        { factor: 'ZONE_CAPACITY', value: base.capacity[z], weight: 0.25, params: { zone: z } },
        { factor: 'EVENING_PICKUPS', weight: peakAt >= 15 * 3600 && peakAt <= 19.5 * 3600 ? 0.2 : 0.0001 },
        { factor: 'WAIT_NOW', value: Math.round(base.avgWaitMin * 10) / 10, weight: 0.1 },
      ],
      3,
    );
    const params = { zone: z, peak: Math.round(pk.v * 100), at: Math.round(peakAt), from: Math.round(from), to: Math.round(to), capacity: base.capacity[z], fromHour: change.fromHour, toHour: change.toHour };
    out.push({
      id: `STAGING:${z}`,
      area: 'STAGING',
      code: helps ? 'STAGING_PEAK' : 'STAGING_PEAK_INFO',
      severity,
      from,
      to,
      params,
      reasons,
      ...(helps
        ? {
            action: { kind: 'STAFF' as const, role: 'handoff' as const, fromHour: change.fromHour, toHour: change.toHour, delta: 1 },
            effect: [
              { metric: 'STAGING_PEAK', unit: 'PCT' as const, before: round3(peakBefore), after: round3(peakAfter), better: 'lower' as const },
              { metric: 'WAIT', unit: 'MIN' as const, before: Math.round(waitBefore * 10) / 10, after: Math.round(waitAfter * 10) / 10, better: 'lower' as const },
              { metric: 'LABOR_HOURS', unit: 'HOURS' as const, before: 0, after: change.toHour - change.fromHour, better: 'lower' as const },
            ],
          }
        : {}),
      confidence: confidenceOf(recur / runs.length, helps && after.every((r, i) => peakOf(r.occ[z]).v <= peakOf((before[i] as StagingRun).occ[z]).v + 0.005)),
      recur: { days: recur, of: runs.length },
      focus: { t: peakAt, kind: 'staging' },
    });
  }
  return out;
}
