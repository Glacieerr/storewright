import { rankReasons } from '@storewright/ai';
import type { StaffChange, StagingLab, StagingRun } from './staging';
import { avg, confidenceOf, type Advice } from './types';

/**
 * 异常与风险（决策记录 0020 · 方向 5）：每条写清原因和建议怎么做。
 * - 顾客等太久：等得太久的人集中在哪个小时，那个时段加一名交付员能少多少；
 * - 订单没按时备好：集中在哪个小时，提前两小时加一名拣货员能少多少；
 * - 叉车在通道口等：两台叉车常要进同一条通道；
 * - 冷链超时：冷藏、冷冻拣货单从第一站到回到暂存区超过时限；
 * - 当天的突发状况（火警、停电、系统故障、打印机卡纸、雨雪）：影响哪些岗位、怎么应对。
 * 到货晚点、卸货门被占在「到货与卸货场」、开门时没补完在「后仓与补货」里，这里不重复。
 */

export interface RiskInput {
  /** 未按时就绪的订单比例（%）、等得太久的顾客比例（%）、平均等待（分钟） */
  lateOrderPct: number;
  longWaitPct: number;
  avgWaitMin: number;
  /** 冷链拣货单超时的比例（%）、最长的一单（分钟）、超时记录 */
  coldViolationPct: number;
  maxColdMinutes: number;
  coldAlerts: Array<{ t: number; elapsedSec: number; limitSec: number }>;
  /** 每小时没按时备好的订单（按备好的时刻） */
  lateByHour: number[];
  /** 叉车在通道口等别的叉车出来（每次的时刻和秒数） */
  forkliftWaits: Array<{ t: number; sec: number }>;
  forklifts: number;
  /** 当天的大事件 */
  disruptions: Array<{ id: string; kind: string; start: number; end: number }>;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const peakHour = (byHour: readonly number[]): number => byHour.reduce((m, v, h) => (v > (byHour[m] ?? 0) ? h : m), 0);

export function adviseRisks(input: RiskInput, lab: StagingLab, runs: readonly StagingRun[]): Advice[] {
  const out: Advice[] = [];
  const base = runs[0];
  const two = lab.seeds.slice(0, Math.min(2, lab.seeds.length));
  const baseOf = (i: number) => runs[i] as StagingRun;

  // ---------- 1. 顾客等太久 ----------
  if (base && input.longWaitPct >= 2) {
    const h = peakHour(base.longWaitByHour);
    const change: StaffChange = { role: 'handoff', fromHour: Math.max(0, h - 1), toHour: Math.min(24, h + 2), delta: 1 };
    const after = two.map((s) => lab.run([change], s));
    const before = avg(two.map((_, i) => baseOf(i).longWaitPct));
    const aft = avg(after.map((r) => r.longWaitPct));
    const recur = runs.filter((r) => r.longWaitPct >= 2).length;
    out.push({
      id: 'RISK:LONG_WAIT',
      area: 'RISK',
      code: 'LONG_WAIT',
      severity: input.longWaitPct >= 5 ? 'warn' : 'info',
      from: h * 3600,
      to: (h + 1) * 3600,
      params: { pct: round1(input.longWaitPct), hour: h, count: base.longWaitByHour[h] ?? 0, fromHour: change.fromHour, toHour: change.toHour },
      reasons: rankReasons(
        [
          { factor: 'LONG_WAIT_PCT', value: round1(input.longWaitPct), weight: 0.4 },
          { factor: 'LONG_WAIT_HOUR', value: base.longWaitByHour[h] ?? 0, weight: 0.4, params: { hour: h } },
          { factor: 'WAIT_NOW', value: round1(input.avgWaitMin), weight: 0.2 },
        ],
        3,
      ),
      ...(before - aft >= 0.5
        ? {
            action: { kind: 'STAFF' as const, role: 'handoff' as const, fromHour: change.fromHour, toHour: change.toHour, delta: 1 },
            effect: [
              { metric: 'LONG_WAIT', unit: 'PCT' as const, before: round1(before) / 100, after: round1(aft) / 100, better: 'lower' as const },
              { metric: 'WAIT', unit: 'MIN' as const, before: round1(avg(two.map((_, i) => baseOf(i).avgWaitMin))), after: round1(avg(after.map((r) => r.avgWaitMin))), better: 'lower' as const },
              { metric: 'LABOR_HOURS', unit: 'HOURS' as const, before: 0, after: change.toHour - change.fromHour, better: 'lower' as const },
            ],
          }
        : {}),
      confidence: confidenceOf(recur / runs.length, after.every((r, i) => r.longWaitPct <= baseOf(i).longWaitPct)),
      recur: { days: recur, of: runs.length },
      focus: { t: h * 3600 + 1800, kind: 'lot' },
    });
  }

  // ---------- 2. 订单没按时备好 ----------
  if (base && input.lateOrderPct >= 2) {
    const h = peakHour(input.lateByHour);
    const change: StaffChange = { role: 'pick', fromHour: Math.max(0, h - 2), toHour: Math.max(1, h), delta: 1 };
    const after = two.map((s) => lab.run([change], s));
    const before = avg(two.map((_, i) => baseOf(i).lateOrderPct));
    const aft = avg(after.map((r) => r.lateOrderPct));
    const recur = runs.filter((r) => r.lateOrderPct >= 2).length;
    out.push({
      id: 'RISK:LATE_ORDERS',
      area: 'RISK',
      code: 'LATE_ORDERS',
      severity: input.lateOrderPct >= 5 ? 'warn' : 'info',
      from: h * 3600,
      to: (h + 1) * 3600,
      params: { pct: round1(input.lateOrderPct), hour: h, count: input.lateByHour[h] ?? 0, fromHour: change.fromHour, toHour: change.toHour },
      reasons: rankReasons(
        [
          { factor: 'LATE_PCT', value: round1(input.lateOrderPct), weight: 0.5 },
          { factor: 'LATE_HOUR', value: input.lateByHour[h] ?? 0, weight: 0.5, params: { hour: h } },
        ],
        2,
      ),
      ...(before - aft >= 0.5
        ? {
            action: { kind: 'STAFF' as const, role: 'pick' as const, fromHour: change.fromHour, toHour: change.toHour, delta: 1 },
            effect: [
              { metric: 'LATE_ORDERS', unit: 'PCT' as const, before: round1(before) / 100, after: round1(aft) / 100, better: 'lower' as const },
              { metric: 'LABOR_HOURS', unit: 'HOURS' as const, before: 0, after: change.toHour - change.fromHour, better: 'lower' as const },
            ],
          }
        : {}),
      confidence: confidenceOf(recur / runs.length, after.every((r, i) => r.lateOrderPct <= baseOf(i).lateOrderPct)),
      recur: { days: recur, of: runs.length },
      focus: { t: h * 3600, kind: 'staging' },
    });
  }

  // ---------- 3. 叉车在通道口等 ----------
  const waitSec = input.forkliftWaits.reduce((s, w) => s + w.sec, 0);
  if (waitSec >= 5 * 60 && input.forkliftWaits.length) {
    const longest = input.forkliftWaits.reduce((m, w) => (w.sec > m.sec ? w : m));
    out.push({
      id: 'RISK:FORKLIFT_WAIT',
      area: 'RISK',
      code: 'FORKLIFT_WAIT',
      severity: waitSec >= 20 * 60 ? 'warn' : 'info',
      from: longest.t,
      params: { times: input.forkliftWaits.length, minutes: Math.round(waitSec / 60), longest: Math.round(longest.sec / 60), forklifts: input.forklifts },
      reasons: rankReasons(
        [
          { factor: 'FORKLIFT_WAITS', value: input.forkliftWaits.length, weight: 0.5 },
          { factor: 'FORKLIFT_WAIT_MIN', value: Math.round(waitSec / 60), weight: 0.3 },
          { factor: 'FORKLIFTS', value: input.forklifts, weight: 0.2 },
        ],
        3,
      ),
      confidence: 0.6,
      focus: { t: longest.t, kind: 'rack' },
    });
  }

  // ---------- 4. 冷链超时 ----------
  if (input.coldAlerts.length) {
    const worst = input.coldAlerts.reduce((m, a) => (a.elapsedSec - a.limitSec > m.elapsedSec - m.limitSec ? a : m));
    out.push({
      id: 'RISK:COLD_CHAIN',
      area: 'RISK',
      code: 'COLD_CHAIN',
      severity: input.coldViolationPct >= 5 ? 'critical' : 'warn',
      from: worst.t,
      params: { times: input.coldAlerts.length, pct: round1(input.coldViolationPct), worst: Math.round(worst.elapsedSec / 60), limit: Math.round(worst.limitSec / 60) },
      reasons: rankReasons(
        [
          { factor: 'COLD_ALERTS', value: input.coldAlerts.length, weight: 0.5 },
          { factor: 'COLD_WORST', value: Math.round(worst.elapsedSec / 60), weight: 0.3, params: { limit: Math.round(worst.limitSec / 60) } },
          { factor: 'COLD_PCT', value: round1(input.coldViolationPct), weight: 0.2 },
        ],
        3,
      ),
      confidence: 0.7,
      focus: { t: worst.t, kind: 'staging' },
    });
  }

  // ---------- 5. 突发状况 ----------
  for (const d of input.disruptions.filter((x) => !x.kind.startsWith('WEATHER')).slice(0, 4)) {
    out.push({
      id: `RISK:INCIDENT:${d.id}`,
      area: 'RISK',
      code: `INCIDENT_${d.kind}`,
      severity: d.kind === 'FIRE_ALARM' || d.kind === 'POWER_OUTAGE' ? 'critical' : 'warn',
      from: d.start,
      to: d.end,
      params: { kind: d.kind, minutes: Math.round((d.end - d.start) / 60) },
      reasons: [{ factor: 'INCIDENT', weight: 1, params: { kind: d.kind } }],
      confidence: 0.9,
      focus: { t: d.start + 60, kind: 'lot' },
    });
  }
  return out;
}
