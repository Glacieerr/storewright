import { ci95 } from '../core/stats';
import type { DayResult } from '../ops/day';
import type { CompareRow } from './experiment';
import { kpi, type Kpi } from './kpi';
import type { Alternatives, CapacityResult, GrowthResult, Headline, StressResult, SweepResult } from './studies';
import { GROWTH_KPIS, STRESS_KPIS } from './studies';

/** 结果表格（Markdown）：报告和命令行共用 */
export function fmt(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—';
  // 负数用真正的减号
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/^-/, '−');
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[], align?: readonly ('l' | 'r')[]): string {
  const a = align ?? headers.map((_, i) => (i === 0 ? 'l' : 'r'));
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(a.map((x) => (x === 'l' ? '---' : '---:'))), ...rows.map(line)].join('\n');
}

const d = (k: Kpi) => k.digits ?? 1;
export const meanCi = (k: Kpi, runs: readonly DayResult[]): string => {
  const c = ci95(runs.map(k.get));
  return runs.length > 1 && c.half > 0 ? `${fmt(c.mean, d(k))} ± ${fmt(c.half, d(k))}` : fmt(c.mean, d(k));
};
export const meanOf = (k: Kpi, runs: readonly DayResult[]): number => ci95(runs.map(k.get)).mean;

export function compareTable(h: Headline): string {
  const rows = h.rows.map((r: CompareRow) => {
    const k = r.kpi;
    const diff = `${r.diff.mean > 0 ? '+' : ''}${fmt(r.diff.mean, d(k))} ± ${fmt(r.diff.half, d(k))}`;
    const pct = Math.abs(r.a.mean) > 1e-9 ? `${r.pct > 0 ? '+' : ''}${fmt(r.pct, 0)}%` : '—';
    return [`${k.group} · ${k.label}（${k.unit}）`, `${fmt(r.a.mean, d(k))} ± ${fmt(r.a.half, d(k))}`, `${fmt(r.b.mean, d(k))} ± ${fmt(r.b.half, d(k))}`, diff, pct, r.verdict];
  });
  return table(['指标', h.a.label, h.b.label, '配对差值（95% CI）', '变化', '判断'], rows, ['l', 'r', 'r', 'r', 'r', 'l']);
}

export function sweepTable(r: SweepResult): string {
  const ks = r.spec.kpis.map(kpi);
  const rows = r.points.map((p) => [`${r.spec.label(p.value)}${p.value === r.spec.chosen ? ' **（选用）**' : ''}`, ...ks.map((k) => meanCi(k, p.runs))]);
  return table([r.spec.title.replace(/（.*）/, ''), ...ks.map((k) => `${k.label}（${k.unit}）`)], rows);
}

const CAP_KPIS = ['done', 'onTime', 'wait', 'waitP95', 'laborMinPerOrder', 'laborCostPerOrder', 'paid', 'walkKm'] as const;
export function capacityTable(c: CapacityResult): string {
  const ks = CAP_KPIS.map((x) => kpi(x));
  const rows: string[][] = [];
  c.volumes.forEach((v, i) => {
    rows.push([`${v} 单 · 上一代`, ...ks.map((k) => meanCi(k, c.gen1[i] as DayResult[]))]);
    rows.push([`${v} 单 · StoreX 不建货格仓`, ...ks.map((k) => meanCi(k, c.noMfc[i] as DayResult[]))]);
    rows.push([`${v} 单 · StoreX 2030 设备`, ...ks.map((k) => meanCi(k, c.storex[i] as DayResult[]))]);
  });
  return table(['订单量 · 方案', ...ks.map((k) => `${k.label}（${k.unit}）`)], rows);
}

export function growthTable(g: GrowthResult): string {
  const ks = GROWTH_KPIS.map((x) => kpi(x));
  const rows: string[][] = [];
  g.volumes.forEach((v, i) => {
    for (const st of g.steps) rows.push([`${v} 单 · ${st.label}`, ...ks.map((k) => meanCi(k, st.runs[i] as DayResult[]))]);
  });
  return table(['订单量 · 设备', ...ks.map((k) => `${k.label}（${k.unit}）`)], rows);
}

const ALT_KPIS = ['onTime', 'wait', 'waitP95', 'laborMinPerOrder', 'laborCostPerOrder', 'walkKm', 'paid', 'oos', 'freshWaste', 'gridKwh', 'total$'] as const;
export function alternativesTable(a: Alternatives): string {
  const ks = ALT_KPIS.map((x) => kpi(x));
  return table(['指标', ...a.arms.map((x) => x.label)], ks.map((k) => [`${k.label}（${k.unit}）`, ...a.arms.map((x) => meanCi(k, x.runs))]));
}

export function stressTable(s: StressResult): string {
  const ks = STRESS_KPIS.map((x) => kpi(x));
  const rows = s.cases.map(({ c, runs }) => [c.label, ...ks.map((k) => meanCi(k, runs))]);
  return table(['情况', ...ks.map((k) => `${k.label}（${k.unit}）`)], rows);
}
