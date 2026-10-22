import { formatClock } from '@storewright/domain';
import type { Series } from '../sim/protocol';
import { trRecord } from '../i18n';

export const clockText = (t: number): string => formatClock(t);
export const pct = (v: number, digits = 0): string => `${(v * 100).toFixed(digits)}%`;
export const num = (v: number, digits = 0): string => v.toFixed(digits);

/** 时间序列在时刻 t 的取值 */
export function at(series: Series, arr: readonly number[], t: number): number {
  const i = Math.min(arr.length - 1, Math.max(0, Math.floor((t - series.t0) / series.step)));
  return arr[i] ?? 0;
}

export const POLICY_LABEL = trRecord({
  baseline: '基线（无专门系统）',
  optimized: '默认档位（服务与安全优先）',
  efficiency: '效率优先档位',
} as const);

export const TEMPLATE_LABEL = trRecord({
  small: '小型店（单层）',
  medium: '中型店（单层）',
  large: '大型店（两层）',
  hardware: '家居建材店',
} as const);

export const POLICY_SHORT = trRecord({
  baseline: '基线',
  optimized: '默认档位',
  efficiency: '效率优先',
} as const);

/** 图表用色（比场景色深一些，白底上更清楚） */
export const POLICY_COLOR = {
  baseline: '#8a939b',
  optimized: '#2f9a5f',
  efficiency: '#3b6ea8',
} as const;

export const CHART_ZONE_COLOR = {
  AMBIENT: '#c39a4c',
  CHILLED: '#4e93cc',
  FROZEN: '#2fb0c0',
} as const;
