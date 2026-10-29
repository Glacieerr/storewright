import type { ScheduleAssociate } from '@storewright/ai';
import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { AssociateInfo, AssociateRole, OpsState, ScheduledShift, ShiftOffer, StoreStatic } from './types';

/**
 * 排班、缺勤与补位（决策记录 0022 · 第二批 D1、D2）。
 *
 * - 带班负责人或控制台发布一周的排班（AI 生成草稿，人确认后发布）、报告缺勤；
 * - AI 的补位建议（谁能补这个班、谁可以自愿提前下班）被采纳后，系统给那个人发邀请，他自己接受或拒绝；
 * - 谁此刻在岗：缺勤 → 不在；接受了提前下班、到点后 → 不在；接受了补班 / 延长、在那段时间里 → 在；
 *   这一周发布了排班 → 按排班；没有发布 → 按名单（学生按自己的时段，其他人整天在岗）。
 * 发布的排班本身不随邀请改动：原计划是什么、后来怎么调的，都在事件流里看得到。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode, params?: Record<string, string | number>): Result => ({ ok: false, reject: params ? { code, params } : { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

type RosterCommand = Extract<OpsCommand, { type: 'PublishSchedule' | 'ReportAbsence' | 'RespondShiftOffer' | 'SendShiftOffer' }>;
export const ROSTER_COMMANDS = new Set<OpsCommand['type']>(['PublishSchedule', 'ReportAbsence', 'RespondShiftOffer', 'SendShiftOffer']);
export function isRosterCommand(cmd: OpsCommand): cmd is RosterCommand {
  return ROSTER_COMMANDS.has(cmd.type);
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 本地日期 YYYY-MM-DD */
export function dateOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (date: string) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getTime();
/** 某个日期所在那一周的周一 */
export function weekOf(date: string): string {
  const t = dayStart(date);
  const dow = (new Date(t).getDay() + 6) % 7;
  return dateOf(t - dow * 86_400_000 + 3_600_000);
}
/** 这一周第 day 天（0 = 周一）的日期 */
export function dateInWeek(week: string, day: number): string {
  return dateOf(dayStart(week) + day * 86_400_000 + 3_600_000);
}
const minuteOf = (ms: number) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

export function decideRoster(s: OpsState, env: CommandEnvelope & { cmd: RosterCommand }, st: StoreStatic, canManage: boolean): Result {
  const { cmd, actor } = env;
  switch (cmd.type) {
    case 'PublishSchedule': {
      if (!canManage) return no('NOT_AUTHORIZED');
      if (!DATE.test(cmd.week) || weekOf(cmd.week) !== cmd.week) return no('SCHEDULE_INVALID', { field: 'week' });
      const ids = new Set(st.roster.map((a) => a.id));
      const days = new Set(Array.from({ length: 7 }, (_, d) => dateInWeek(cmd.week, d)));
      const seen = new Set<string>();
      for (const sh of cmd.shifts ?? []) {
        if (!ids.has(sh.associateId) || !days.has(sh.date) || !(sh.from >= 0 && sh.to <= 1440 && sh.to > sh.from)) return no('SCHEDULE_INVALID', { associateId: sh.associateId, date: sh.date });
        const key = `${sh.associateId}|${sh.date}`;
        if (seen.has(key)) return no('SCHEDULE_INVALID', { associateId: sh.associateId, date: sh.date });
        seen.add(key);
      }
      const shifts: ScheduledShift[] = (cmd.shifts ?? []).map((sh, i) => ({ ...sh, id: `SH-${cmd.week}-${String(i + 1).padStart(3, '0')}` }));
      return yes([ev('SchedulePublished', { week: cmd.week, shifts })]);
    }
    case 'ReportAbsence': {
      if (!canManage) return no('NOT_AUTHORIZED');
      if (!st.roster.some((a) => a.id === cmd.associateId)) return no('ASSOCIATE_NOT_FOUND');
      if (!DATE.test(cmd.date)) return no('SCHEDULE_INVALID', { field: 'date' });
      const n = Object.keys(s.absences ?? {}).length + 1;
      const reason = typeof cmd.reason === 'string' ? cmd.reason.trim().slice(0, 80) : '';
      return yes([
        ev('AbsenceReported', {
          absence: {
            id: `AB${String(n).padStart(4, '0')}`,
            associateId: cmd.associateId,
            date: cmd.date,
            ...(cmd.from !== undefined ? { from: cmd.from } : {}),
            ...(cmd.to !== undefined ? { to: cmd.to } : {}),
            ...(reason ? { reason } : {}),
            at: env.at,
            by: actor,
          },
        }),
      ]);
    }
    // 直接给某人发补班邀请（决策记录 0026）：AI 建议里的其他人选，或者带班负责人自己想到的人；带着建议号时这条建议算采纳
    case 'SendShiftOffer': {
      if (!canManage) return no('NOT_AUTHORIZED');
      if (!st.roster.some((a) => a.id === cmd.associateId)) return no('ASSOCIATE_NOT_FOUND');
      if (!DATE.test(cmd.date) || !(cmd.from >= 0 && cmd.to <= 1440 && cmd.to > cmd.from)) return no('SCHEDULE_INVALID', { field: 'time' });
      const rec = cmd.recId ? s.recs[cmd.recId] : undefined;
      const e = offerEvent(s, st, { associateId: cmd.associateId, date: cmd.date, from: cmd.from, to: cmd.to, ...(cmd.role ? { role: cmd.role } : {}), ...(cmd.replaces ? { replaces: cmd.replaces } : {}) }, 'EXTRA', { ...(rec ? { recId: rec.id } : {}), autoNext: !!cmd.autoNext });
      if (!e) return no('OFFER_PENDING');
      return yes([...(rec?.status === 'OPEN' ? [ev('RecommendationResolved', { recId: rec.id, resolution: 'ACCEPTED' })] : []), e]);
    }
    case 'RespondShiftOffer': {
      const o = s.offers?.[cmd.offerId];
      if (!o) return no('OFFER_NOT_FOUND');
      if (o.associateId !== actor) return no('NOT_YOURS');
      if (o.status !== 'PENDING') return no('OFFER_CLOSED', { status: o.status });
      return yes([ev('ShiftOfferAnswered', { offerId: o.id, accept: !!cmd.accept })]);
    }
  }
}

export function applyRosterEvent(s: OpsState, e: AnyOpsEvent): boolean {
  switch (e.type) {
    case 'SchedulePublished':
      (s.schedules ??= {})[e.payload.week] = { week: e.payload.week, shifts: e.payload.shifts, publishedAt: e.at, by: e.actor };
      return true;
    case 'AbsenceReported':
      (s.absences ??= {})[e.payload.absence.id] = e.payload.absence;
      return true;
    case 'ShiftOffered':
      (s.offers ??= {})[e.payload.offer.id] = { ...e.payload.offer, status: 'PENDING', createdAt: e.at };
      return true;
    case 'ShiftOfferAnswered': {
      const o = s.offers?.[e.payload.offerId];
      if (o) {
        o.status = e.payload.accept ? 'ACCEPTED' : 'DECLINED';
        o.answeredAt = e.at;
      }
      return true;
    }
    default:
      return false;
  }
}

/** AI 补位建议的动作：给某人发补班 / 延长或提前下班的邀请（决策记录 0022 · D2）；带班负责人直接发的没有建议号 */
export function offerEvent(s: OpsState, st: StoreStatic, p: Record<string, unknown>, kind: 'EXTRA' | 'EARLY_LEAVE', opts: { recId?: string; autoNext?: boolean } = {}): PendingEvent | undefined {
  const a = st.roster.find((x) => x.id === String(p.associateId ?? ''));
  const date = String(p.date ?? '');
  const from = Number(p.from);
  const to = Number(p.to);
  if (!a || !DATE.test(date) || !(to > from)) return undefined;
  // 同一个人同一天还有没答复的邀请：不再发
  if (Object.values(s.offers ?? {}).some((o) => o.associateId === a.id && o.date === date && o.status === 'PENDING')) return undefined;
  const n = Object.keys(s.offers ?? {}).length + 1;
  const offer: Omit<ShiftOffer, 'status' | 'createdAt' | 'answeredAt'> = {
    id: `OF${String(n).padStart(4, '0')}`,
    associateId: a.id,
    kind,
    date,
    from,
    to,
    role: (String(p.role ?? a.role) as AssociateRole) ?? a.role,
    ...(opts.recId ? { recId: opts.recId } : {}),
    ...(p.replaces ? { replaces: String(p.replaces) } : {}),
    ...(opts.autoNext ? { autoNext: true } : {}),
  };
  return ev('ShiftOffered', { offer });
}

// ---------------------------------------------------------------------------
// 视图

/** 名单 → 排班用的员工：岗位、技能、雇佣类型、每周工时上限、可上班时间（服务端生成草稿、手机上改草稿后重新打分共用） */
export function scheduleAssociates(roster: readonly AssociateInfo[]): ScheduleAssociate[] {
  return roster.map((a) => ({
    id: a.id,
    role: a.role,
    ...(a.skills ? { skills: a.skills } : {}),
    employment: a.employment === 'STUDENT' ? 'STUDENT' : a.employment === 'PART_TIME' ? 'PART_TIME' : 'FULL',
    ...(a.maxWeeklyHours !== undefined ? { maxWeeklyHours: a.maxWeeklyHours } : {}),
    ...(a.availability ? { availability: a.availability } : {}),
  }));
}

/** 某天的班次：发布的排班 + 接受了的补班 / 延长，去掉缺勤和提前下班之后的部分 */
export function shiftsOn(s: OpsState, date: string): ScheduledShift[] {
  const sched = s.schedules?.[weekOf(date)];
  const out = new Map<string, ScheduledShift>();
  for (const sh of sched?.shifts ?? []) if (sh.date === date) out.set(sh.associateId, { ...sh });
  for (const o of Object.values(s.offers ?? {})) {
    if (o.status !== 'ACCEPTED' || o.date !== date) continue;
    const cur = out.get(o.associateId);
    if (o.kind === 'EXTRA') out.set(o.associateId, cur ? { ...cur, from: Math.min(cur.from, o.from), to: Math.max(cur.to, o.to) } : { id: o.id, associateId: o.associateId, date, from: o.from, to: o.to, role: o.role });
    else if (cur) cur.to = Math.min(cur.to, o.from);
  }
  for (const ab of Object.values(s.absences ?? {})) {
    if (ab.date !== date) continue;
    const cur = out.get(ab.associateId);
    if (!cur) continue;
    if (ab.from === undefined || ab.to === undefined || (ab.from <= cur.from && ab.to >= cur.to)) out.delete(ab.associateId);
    else if (ab.from <= cur.from) cur.from = Math.max(cur.from, ab.to);
    else cur.to = Math.min(cur.to, ab.from);
  }
  return [...out.values()].filter((x) => x.to > x.from).sort((a, b) => a.from - b.from || a.associateId.localeCompare(b.associateId));
}

export interface Duty {
  on: boolean;
  /** 在岗时的岗位（排班里的岗位；没有排班时是名单上的岗位） */
  role?: AssociateRole;
  from?: number;
  to?: number;
  source: 'SCHEDULE' | 'ROSTER' | 'ABSENT';
}

/** 此刻在不在岗（决策记录 0022）；没有发布排班时按名单（学生按自己的时段，其他人整天在岗） */
export function dutyOf(st: StoreStatic | undefined, s: OpsState, associateId: string, now: number): Duty {
  const a = st?.roster.find((x) => x.id === associateId);
  const date = dateOf(now);
  const m = minuteOf(now);
  const absent = Object.values(s.absences ?? {}).some((ab) => ab.associateId === associateId && ab.date === date && (ab.from === undefined || ab.to === undefined || (m >= ab.from && m < ab.to)));
  if (absent) return { on: false, source: 'ABSENT' };
  if (s.schedules?.[weekOf(date)] || Object.values(s.offers ?? {}).some((o) => o.associateId === associateId && o.date === date && o.status === 'ACCEPTED')) {
    const sh = shiftsOn(s, date).find((x) => x.associateId === associateId);
    if (sh) return { on: m >= sh.from && m < sh.to, role: sh.role, from: sh.from, to: sh.to, source: 'SCHEDULE' };
    if (s.schedules?.[weekOf(date)]) return { on: false, source: 'SCHEDULE' };
  }
  if (!a) return { on: false, source: 'ROSTER' };
  if (a.shift) return { on: m >= a.shift.from && m < a.shift.to, role: a.role, from: a.shift.from, to: a.shift.to, source: 'ROSTER' };
  return { on: true, role: a.role, source: 'ROSTER' };
}

export function onDuty(st: StoreStatic | undefined, s: OpsState, associateId: string, now: number): boolean {
  return dutyOf(st, s, associateId, now).on;
}

/** 某人这一周的班次（按日期） */
export function myWeek(s: OpsState, associateId: string, week: string): ScheduledShift[] {
  return Array.from({ length: 7 }, (_, d) => shiftsOn(s, dateInWeek(week, d)).find((x) => x.associateId === associateId)).filter((x): x is ScheduledShift => !!x);
}

/** 发给某人、还没答复的邀请 */
export function myOffers(s: OpsState, associateId: string): ShiftOffer[] {
  return Object.values(s.offers ?? {})
    .filter((o) => o.associateId === associateId && o.status === 'PENDING')
    .sort((a, b) => a.date.localeCompare(b.date) || a.from - b.from);
}

/** 这一周已经排了几个小时（含接受了的补班）：补位时检查每周上限 */
export function weekHours(s: OpsState, associateId: string, week: string): number {
  return myWeek(s, associateId, week).reduce((n, x) => n + (x.to - x.from) / 60, 0);
}

export type { AssociateInfo };
