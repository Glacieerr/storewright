import { dutyOf } from './roster';
import type { LiveWalk, OpsState, StoreStatic } from './types';

/**
 * 负荷与安全（决策记录 0023 · 第三批 D5）：
 * - 冷冻区累计停留：最近两小时里拣冷冻批次的时间加起来超过 45 分钟，提醒出来暖和一下，可领取的批次里冷冻的排到后面；
 * - 休息：连续工作 4 小时没有停下来 15 分钟以上（按批次、交付、补货、盘点的时间算），提醒休息；
 * - 大件两人搬运：有人领了需要两人搬运的大件，提醒一位手上没活的同事去帮忙；
 * - 派活时避免同一个人连续做重活：刚做完长时间的冷冻批次或两人搬运的大件，可领取的批次里冷冻的排到后面。
 * 只看团队里的时间记录，不做个人排名；提醒只发给本人（帮忙的提醒发给被请去帮忙的人）。
 */

const MIN = 60_000;
export const SAFETY_RULES = { freezerWindowMin: 120, freezerLimitMin: 45, breakAfterMin: 240, breakGapMin: 15 } as const;

/** 最近 windowMin 分钟里拣冷冻批次的分钟数（领取到完成，还在拣的算到现在） */
export function freezerMinutes(s: OpsState, associateId: string, now: number, windowMin: number = SAFETY_RULES.freezerWindowMin): number {
  const from = now - windowMin * MIN;
  let ms = 0;
  for (const w of Object.values(s.walks)) {
    if (w.tempZone !== 'FROZEN' || w.associateId !== associateId || w.claimedAt === undefined) continue;
    const a = Math.max(from, w.startedAt ?? w.claimedAt);
    const b = Math.min(now, w.completedAt ?? now);
    if (b > a) ms += b - a;
  }
  return Math.round(ms / MIN);
}

/** 这个人今天的忙碌时段（批次、交付、补货、盘点），按开始时间排序 */
function busyIntervals(s: OpsState, associateId: string, now: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const w of Object.values(s.walks)) if (w.associateId === associateId && w.claimedAt !== undefined) out.push([w.claimedAt, w.completedAt ?? now]);
  for (const x of Object.values(s.sessions)) if (x.owner === associateId) out.push([x.startedAt, x.completedAt ?? now]);
  for (const t of Object.values(s.repl)) if (t.associateId === associateId && t.claimedAt !== undefined) out.push([t.claimedAt, t.doneAt ?? (t.status === 'CLAIMED' ? now : t.claimedAt)]);
  const last = s.activity[associateId]?.lastScanAt;
  if (last !== undefined) out.push([last - MIN, last]);
  return out.filter(([a, b]) => b >= a && b > now - 16 * 60 * MIN).sort((x, y) => x[0] - y[0]);
}

/** 连续工作了多少分钟：从这一班开始（或最后一次停下来 15 分钟以上）到现在；不在班上时为 0 */
export function workedSinceBreak(s: OpsState, st: StoreStatic, associateId: string, now: number): number {
  const d = dutyOf(st, s, associateId, now);
  if (!d.on) return 0;
  const day = new Date(now);
  const shiftStart = d.from !== undefined ? new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() + d.from * MIN : undefined;
  const iv = busyIntervals(s, associateId, now);
  if (!iv.length) return 0;
  let start = iv[0]?.[0] as number;
  let end = iv[0]?.[1] as number;
  for (const [a, b] of iv.slice(1)) {
    if (a - end >= SAFETY_RULES.breakGapMin * MIN) start = a;
    end = Math.max(end, b);
  }
  // 最后一段忙完已经歇了 15 分钟以上：算休息过了
  if (now - end >= SAFETY_RULES.breakGapMin * MIN) return 0;
  if (shiftStart !== undefined) start = Math.max(start, shiftStart);
  return Math.max(0, Math.round((now - start) / MIN));
}

/** 刚做完重活：最近 30 分钟内做完 20 分钟以上的冷冻批次，或者搬了需要两人搬运的大件 */
export function heavyRecently(s: OpsState, associateId: string, now: number): boolean {
  const since = now - 30 * MIN;
  const frozen = Object.values(s.walks).some((w) => w.associateId === associateId && w.tempZone === 'FROZEN' && w.completedAt !== undefined && w.completedAt >= since && w.completedAt - (w.startedAt ?? w.claimedAt ?? w.completedAt) >= 20 * MIN);
  const lift = Object.values(s.oversized ?? {}).some((p) => p.teamLift && p.associateId === associateId && (p.stagedAt ?? 0) >= since);
  return frozen || lift;
}

/** 这个人现在该少接冷冻批次（冷冻区待久了或者刚做完重活） */
export function avoidFrozen(s: OpsState, associateId: string, now: number): boolean {
  return freezerMinutes(s, associateId, now) >= SAFETY_RULES.freezerLimitMin || heavyRecently(s, associateId, now);
}

/** 可领取批次的排序（给某个人看）：该少接冷冻的人，冷冻批次排到后面，其余顺序不变 */
export function walkOrderFor(s: OpsState, associateId: string, now: number): (a: LiveWalk, b: LiveWalk) => number {
  const avoid = avoidFrozen(s, associateId, now);
  return (a, b) => (avoid ? Number(a.tempZone === 'FROZEN') - Number(b.tempZone === 'FROZEN') : 0);
}
