import type { DayMetrics } from '@storewright/sim-engine';
import { num, pct } from './format';
import { t } from '../i18n';

/** 指标表的行定义与差值格式（策略对比、方案对比、报告共用） */

export type Better = 'lower' | 'higher' | 'none';

export interface Row {
  key: keyof DayMetrics;
  label: string;
  fmt: (v: number) => string;
  better: Better;
  /** 百分比指标比较差值（个百分点），其他指标比较相对变化 */
  diff: 'points' | 'relative';
  /** 百分点差值的换算系数（指标本身是 0–1 时为 100） */
  scale?: number;
}

export const ROWS: Array<{ group: string; rows: Row[] }> = [
  {
    group: '顾客体验',
    rows: [
      { key: 'avgWaitMin', label: '平均到店等待', fmt: (v) => t('{0} 分钟', num(v, 2)), better: 'lower', diff: 'relative' },
      { key: 'p90WaitMin', label: '等待 P90', fmt: (v) => t('{0} 分钟', num(v, 1)), better: 'lower', diff: 'relative' },
      { key: 'longWaitPct', label: '长等待占比', fmt: (v) => `${num(v, 1)}%`, better: 'lower', diff: 'points' },
      { key: 'lateOrderPct', label: '未按时就绪', fmt: (v) => `${num(v, 1)}%`, better: 'lower', diff: 'points' },
      { key: 'fillRate', label: '订单满足率', fmt: (v) => pct(v, 2), better: 'higher', diff: 'points', scale: 100 },
      { key: 'shortValue', label: '缺货行销售额', fmt: (v) => `$${num(v, 0)}`, better: 'lower', diff: 'relative' },
      { key: 'avgTrafficDelayMin', label: '路上堵车延误（外部因素）', fmt: (v) => t('{0} 分钟', num(v, 1)), better: 'none', diff: 'relative' },
    ],
  },
  {
    group: '商品安全',
    rows: [
      { key: 'overweightTotePct', label: '超重框', fmt: (v) => `${num(v, 1)}%`, better: 'lower', diff: 'points' },
      { key: 'crushRiskTotePct', label: '压坏风险框', fmt: (v) => `${num(v, 1)}%`, better: 'lower', diff: 'points' },
      { key: 'chemicalMixTotePct', label: '化学品与食品混装', fmt: (v) => `${num(v, 1)}%`, better: 'lower', diff: 'points' },
      { key: 'avgReadyDwellMin', label: '门口停留（冷链风险）', fmt: (v) => t('{0} 分钟', num(v, 1)), better: 'lower', diff: 'relative' },
    ],
  },
  {
    group: '作业效率',
    rows: [
      { key: 'laborMinutesPerOrder', label: '单均作业工时', fmt: (v) => t('{0} 分钟', num(v, 1)), better: 'lower', diff: 'relative' },
      { key: 'uph', label: '拣货效率', fmt: (v) => t('{0} 件/工时', num(v, 1)), better: 'higher', diff: 'relative' },
      { key: 'pickDistanceKm', label: '拣货总距离', fmt: (v) => `${num(v, 1)} km`, better: 'lower', diff: 'relative' },
      { key: 'totesPerOrder', label: '每单框数', fmt: (v) => num(v, 2), better: 'none', diff: 'relative' },
    ],
  },
];

export function delta(row: Row, base: number, v: number): { text: string; tone: 'good' | 'bad' | 'flat' } {
  let d: number;
  let text: string;
  if (row.diff === 'points') {
    d = (v - base) * (row.scale ?? 1);
    text = t('{0}{1} 点', d >= 0 ? '+' : '−', Math.abs(d).toFixed(1));
  } else {
    if (Math.abs(base) < 1e-9) return { text: v === 0 ? '—' : t('新增'), tone: v === 0 ? 'flat' : row.better === 'lower' ? 'bad' : 'good' };
    d = ((v - base) / Math.abs(base)) * 100;
    text = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%`;
  }
  if (Math.abs(d) < 0.05 || row.better === 'none') return { text, tone: 'flat' };
  const improved = row.better === 'lower' ? d < 0 : d > 0;
  return { text, tone: improved ? 'good' : 'bad' };
}

