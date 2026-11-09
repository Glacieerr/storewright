import { ci95, pairedDiff } from '../core/stats';
import { runDay, type DayResult } from '../ops/day';
import type { Scenario } from '../world/config';
import { KPIS, type Kpi } from './kpi';

/**
 * 实验：同一组种子（公共随机数）下跑两个方案，逐个指标给出均值 ± 95% 置信区间和配对差值。
 * 「判断」只在配对差值的置信区间不含 0 时给出改善 / 变差。
 */
export interface Arm {
  label: string;
  make: (seed: number) => Scenario;
}

export interface ArmRuns {
  label: string;
  runs: DayResult[];
}

export function runArm(arm: Arm, seeds: readonly number[]): ArmRuns {
  return { label: arm.label, runs: seeds.map((seed) => runDay(arm.make(seed))) };
}

export interface CompareRow {
  kpi: Kpi;
  a: { mean: number; half: number };
  b: { mean: number; half: number };
  diff: { mean: number; half: number; significant: boolean };
  pct: number;
  verdict: '改善' | '变差' | '无显著差异' | '—';
}

export function compare(a: ArmRuns, b: ArmRuns, kpis: readonly Kpi[] = KPIS.filter((k) => !k.storexOnly)): CompareRow[] {
  return kpis.map((k) => {
    const xa = a.runs.map(k.get);
    const xb = b.runs.map(k.get);
    const diff = pairedDiff(xa, xb);
    const ma = ci95(xa);
    const mb = ci95(xb);
    const pct = ma.mean !== 0 ? (diff.mean / Math.abs(ma.mean)) * 100 : 0;
    let verdict: CompareRow['verdict'] = '—';
    if (k.better !== 'none') {
      if (!diff.significant) verdict = '无显著差异';
      else verdict = (diff.mean < 0) === (k.better === 'lower') ? '改善' : '变差';
    }
    return { kpi: k, a: ma, b: mb, diff, pct, verdict };
  });
}

/** 扫描一组配置：每个配置跑同一组种子，返回每个配置的指标均值 */
export interface SweepPoint<T> {
  value: T;
  runs: DayResult[];
  mean: (k: Kpi) => number;
  ci: (k: Kpi) => { mean: number; half: number };
}

export function pointOf<T>(value: T, runs: DayResult[]): SweepPoint<T> {
  return {
    value,
    runs,
    mean: (k: Kpi) => ci95(runs.map(k.get)).mean,
    ci: (k: Kpi) => ci95(runs.map(k.get)),
  };
}

export function sweep<T>(values: readonly T[], make: (value: T, seed: number) => Scenario, seeds: readonly number[]): SweepPoint<T>[] {
  return values.map((value) => pointOf(value, seeds.map((seed) => runDay(make(value, seed)))));
}
