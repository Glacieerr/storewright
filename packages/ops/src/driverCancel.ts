import type { LiveTrip } from './types';

/**
 * 配送司机取消接单的时间窗口（决策记录 0014）。作业核心、控制台和司机端共用这一个函数，规则只写一处：
 * - 接单后、系统标记的预计到店前 lockMin 分钟以外：可以取消；
 * - 进入预计到店前 lockMin 分钟的准备期后：不能取消（门店已经按这个时间备货）；
 * - 到店后等待满 waitMin 分钟：可以取消（等待过久，记为门店原因）；不满时不能取消。
 * 没有预计到店时间时，到店前都可以取消。
 */

export interface DriverCancelRules {
  /** 准备期：预计到店前多少分钟起不能取消 */
  lockMin: number;
  /** 到店后等待多少分钟起可以取消 */
  waitMin: number;
}

export const DEFAULT_DRIVER_CANCEL: DriverCancelRules = { lockMin: 10, waitMin: 10 };

export type DriverCancelReason = 'BEFORE_PREP' | 'WAITED_TOO_LONG' | 'NO_SHOW';

export type CancelWindow =
  | { allowed: true; reason: DriverCancelReason; waitedMin?: number; closesAt?: number }
  | { allowed: false; code: 'ALREADY_DONE' | 'TRIP_NOT_ACCEPTED' | 'CANCEL_LOCKED' | 'CANCEL_WAIT'; opensAt?: number; waitedMin?: number };

const MIN = 60_000;

/** 司机此刻能不能取消这个行程 */
export function driverCancelWindow(trip: Pick<LiveTrip, 'acceptedAt' | 'etaAt' | 'arrivedAt' | 'completedAt'>, now: number, rules: DriverCancelRules = DEFAULT_DRIVER_CANCEL): CancelWindow {
  if (trip.completedAt !== undefined) return { allowed: false, code: 'ALREADY_DONE' };
  if (trip.acceptedAt === undefined) return { allowed: false, code: 'TRIP_NOT_ACCEPTED' };
  if (trip.arrivedAt !== undefined) {
    const waitedMin = Math.floor((now - trip.arrivedAt) / MIN);
    if (now - trip.arrivedAt >= rules.waitMin * MIN) return { allowed: true, reason: 'WAITED_TOO_LONG', waitedMin };
    return { allowed: false, code: 'CANCEL_WAIT', opensAt: trip.arrivedAt + rules.waitMin * MIN, waitedMin };
  }
  if (trip.etaAt !== undefined) {
    const lockAt = trip.etaAt - rules.lockMin * MIN;
    if (now >= lockAt) return { allowed: false, code: 'CANCEL_LOCKED' };
    return { allowed: true, reason: 'BEFORE_PREP', closesAt: lockAt };
  }
  return { allowed: true, reason: 'BEFORE_PREP' };
}

/**
 * 司机没来：预计到店时间过了 waitMin 分钟还没到，带班负责人或控制台可以改派（重新派单）；
 * 没有预计到店时间时，接单满 60 分钟还没到也可以改派。
 */
export function noShowWindow(trip: Pick<LiveTrip, 'acceptedAt' | 'etaAt' | 'arrivedAt' | 'completedAt'>, now: number, rules: DriverCancelRules = DEFAULT_DRIVER_CANCEL): { allowed: boolean; opensAt?: number } {
  if (trip.completedAt !== undefined || trip.acceptedAt === undefined || trip.arrivedAt !== undefined) return { allowed: false };
  const opensAt = trip.etaAt !== undefined ? trip.etaAt + rules.waitMin * MIN : trip.acceptedAt + 60 * MIN;
  return now >= opensAt ? { allowed: true } : { allowed: false, opensAt };
}
