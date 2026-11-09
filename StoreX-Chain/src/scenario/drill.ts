import { TRACE_DAY } from '../analysis/studies';
import type { DisruptionKey } from '../sim/config';

/** 演练的起始日：让动画那一天（第 TRACE_DAY 天）正好在扰动里（网页的后台线程、命令行、教学沙盘共用） */
export const DRILL_START: Record<DisruptionKey, number> = {
  portCongestion: TRACE_DAY - 1,
  airportClosed: TRACE_DAY,
  highwayClosed: TRACE_DAY,
  supplierOutage: TRACE_DAY - 2,
  demandSurge: TRACE_DAY - 1,
};
