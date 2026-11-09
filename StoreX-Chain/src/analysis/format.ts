import { ci95 } from '../../../StoreX/src/core/stats';
import type { ChainResult } from '../sim/engine';
import type { Kpi } from './kpi';

/** 结果表格（Markdown） */
export function fmt(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/^-/, '−');
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[], align?: readonly ('l' | 'r')[]): string {
  const a = align ?? headers.map((_, i) => (i === 0 ? 'l' : 'r'));
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(a.map((x) => (x === 'l' ? '---' : '---:'))), ...rows.map(line)].join('\n');
}

export const meanOf = (k: Kpi, runs: readonly ChainResult[]): number => ci95(runs.map(k.get)).mean;
export function meanCi(k: Kpi, runs: readonly ChainResult[]): string {
  const c = ci95(runs.map(k.get));
  const d = k.digits ?? 1;
  return runs.length > 1 && c.half > 0 ? `${fmt(c.mean, d)} ± ${fmt(c.half, d)}` : fmt(c.mean, d);
}
export const usd = (x: number): string => (x < 0 ? `−$${fmt(-x, 0)}` : `$${fmt(x, 0)}`);
export const musd = (x: number): string => `${fmt(x / 1e6, 2)} 百万美元`;
export const pct = (x: number): string => `${fmt(x * 100, 1)}%`;
