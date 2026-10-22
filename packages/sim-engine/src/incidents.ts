import { createRng, hashString } from '@storewright/domain';
import type { Role } from './day';

/**
 * 突发状况。
 *
 * 小状况按事件随机发生（按对象键控，不同策略面对同样的状况）：
 * - 标签丢失 / 损坏：暂存时重新打印并重贴，+60 秒；
 * - 商品破损：拣货时重新拿一件，+90 秒；
 * - 框找不到：交付取框时多找一会儿，+3 分钟；
 * - 标签打印机卡纸：每天可能发生一次，15–30 分钟内暂存变慢。
 *
 * 大事件在一个时间窗口内影响作业：
 * - 火警：全员疏散，所有作业暂停；
 * - 警情（停车场）：车边交付暂停；
 * - 停电：拣货、暂存暂停（扫码枪和灯光不可用），交付变慢；
 * - 系统故障：订单暂停下发，暂存和交付改为手工记录而变慢。
 * 正在进行的作业遇到暂停时顺延，暂停期间不开始新作业。全部为假设参数。
 */

export type DisruptionKind = 'FIRE_ALARM' | 'POLICE' | 'POWER_OUTAGE' | 'SYSTEM_OUTAGE' | 'PRINTER_JAM' | 'WEATHER_RAIN' | 'WEATHER_SNOW';

export interface Disruption {
  id: string;
  kind: DisruptionKind;
  start: number;
  end: number;
}

export const DISRUPTION_LABEL: Record<DisruptionKind, string> = {
  FIRE_ALARM: '火警',
  POLICE: '警情（停车场）',
  POWER_OUTAGE: '停电',
  SYSTEM_OUTAGE: '系统故障',
  PRINTER_JAM: '标签打印机卡纸',
  WEATHER_RAIN: '下雨',
  WEATHER_SNOW: '下雪',
};

export const DISRUPTION_EFFECT: Record<DisruptionKind, { paused: Role[]; slow: Partial<Record<Role, number>>; releasePaused: boolean }> = {
  FIRE_ALARM: { paused: ['pick', 'stage', 'handoff', 'exception'], slow: {}, releasePaused: false },
  POLICE: { paused: ['handoff'], slow: {}, releasePaused: false },
  POWER_OUTAGE: { paused: ['pick', 'stage'], slow: { handoff: 1.3 }, releasePaused: false },
  SYSTEM_OUTAGE: { paused: [], slow: { handoff: 1.4, stage: 1.25 }, releasePaused: true },
  PRINTER_JAM: { paused: [], slow: { stage: 1.6 }, releasePaused: false },
  // 雨雪天车边装车更慢（撑伞、防滑、给框盖防水布）
  WEATHER_RAIN: { paused: [], slow: { handoff: 1.15 }, releasePaused: false },
  WEATHER_SNOW: { paused: [], slow: { handoff: 1.3 }, releasePaused: false },
};

/** 默认持续时间（分钟） */
export const DISRUPTION_MINUTES: Record<DisruptionKind, [number, number]> = {
  FIRE_ALARM: [20, 30],
  POLICE: [30, 50],
  POWER_OUTAGE: [15, 40],
  SYSTEM_OUTAGE: [20, 45],
  PRINTER_JAM: [15, 30],
  WEATHER_RAIN: [0, 0],
  WEATHER_SNOW: [0, 0],
};

export interface SmallIncidentRates {
  labelReprint: number;
  damagedItem: number;
  missingTote: number;
  /** 每天发生一次打印机卡纸的概率 */
  printerJam: number;
}

export const DEFAULT_SMALL_INCIDENTS: SmallIncidentRates = { labelReprint: 0.015, damagedItem: 0.008, missingTote: 0.012, printerJam: 0.35 };
export const SMALL_EXTRA_SEC = { labelReprint: 60, damagedItem: 90, missingTote: 180 } as const;

export interface IncidentParams {
  /** 小状况发生率；null 表示关闭 */
  small: SmallIncidentRates | null;
  disruptions: Disruption[];
}

/** 打印机卡纸窗口（按种子，开店后到关门前） */
export function printerJam(seed: number, openSec: number, closeSec: number, rate = DEFAULT_SMALL_INCIDENTS.printerJam): Disruption[] {
  const rng = createRng(hashString('printer', seed >>> 0));
  if (!rng.chance(rate)) return [];
  const start = Math.round(rng.uniform(openSec + 3600, closeSec - 3 * 3600));
  const [a, b] = DISRUPTION_MINUTES.PRINTER_JAM;
  return [{ id: 'JAM-1', kind: 'PRINTER_JAM', start, end: start + Math.round(rng.uniform(a, b) * 60) }];
}

/** 随机大事件：平均每天 ratePerDay 次，时间在营业时间内均匀分布 */
export function randomDisruptions(seed: number, openSec: number, closeSec: number, ratePerDay = 0.6): Disruption[] {
  const rng = createRng(hashString('disrupt', seed >>> 0));
  const kinds: DisruptionKind[] = ['FIRE_ALARM', 'POLICE', 'POWER_OUTAGE', 'SYSTEM_OUTAGE'];
  const n = rng.poisson(ratePerDay);
  const out: Disruption[] = [];
  for (let i = 0; i < n; i++) {
    const kind = rng.pick(kinds);
    const [a, b] = DISRUPTION_MINUTES[kind];
    const start = Math.round(rng.uniform(openSec + 1800, closeSec - 3600));
    out.push({ id: `R${i + 1}-${kind}`, kind, start, end: start + Math.round(rng.uniform(a, b) * 60) });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** 角色在时刻 t 是否处于暂停窗口；返回窗口结束时刻 */
export function pausedUntil(ds: readonly Disruption[], role: Role, t: number): number | undefined {
  let until: number | undefined;
  for (const d of ds) if (t >= d.start && t < d.end && DISRUPTION_EFFECT[d.kind].paused.includes(role)) until = Math.max(until ?? 0, d.end);
  return until;
}

/** 作业 [t0, t0 + dur) 遇到的暂停总时长（遇到暂停就顺延，顺延后可能再遇到下一个窗口） */
export function pauseOverlap(ds: readonly Disruption[], role: Role, t0: number, dur: number): number {
  let end = t0 + dur;
  let extra = 0;
  const windows = ds.filter((d) => DISRUPTION_EFFECT[d.kind].paused.includes(role)).sort((a, b) => a.start - b.start);
  for (const w of windows) {
    if (w.start >= end || w.end <= t0 || w.start < t0) continue;
    const add = w.end - w.start;
    extra += add;
    end += add;
  }
  return extra;
}

/** 时刻 t 的作业变慢倍数 */
export function slowFactor(ds: readonly Disruption[], role: Role, t: number): number {
  let k = 1;
  for (const d of ds) if (t >= d.start && t < d.end) k = Math.max(k, DISRUPTION_EFFECT[d.kind].slow[role] ?? 1);
  return k;
}

export function releasePaused(ds: readonly Disruption[], t: number): boolean {
  return ds.some((d) => t >= d.start && t < d.end && DISRUPTION_EFFECT[d.kind].releasePaused);
}
