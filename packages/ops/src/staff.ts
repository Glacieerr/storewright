import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import { dutyOf } from './roster';
import type { AssociateInfo, AssociateRole, OpsState, StoreStatic } from './types';
import { handoffBoard } from './views';

/**
 * 岗位调动与锁定（Phase 5c · 人员调配）。
 *
 * - 名单里的岗位是默认岗位；带班负责人（或采纳 AI 的调动建议）可以把员工临时调到别的作业岗位；
 * - 带班负责人和权限岗位（LEAD）不参与调动；
 * - 管理员可以锁定某位员工（固定名单）：AI 不会建议调动他，已发出的建议在执行时视为过时；人工调动不受影响。
 * - 调动可以带时长（例如去交付帮一小时）：到时间由门店的定时节拍自动调回原岗位（当天排班的岗位，没有排班时按名单）。
 * - 手上有任务的人可以选「做完这一单再去」：先排队，任务做完时由节拍调过去（决策记录 0026）。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode): Result => ({ ok: false, reject: { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

/** 可以调动到的作业岗位（决策记录 0026：熟食也可以调） */
export const MOVABLE_ROLES: readonly AssociateRole[] = ['PICK', 'STAGE', 'HANDOFF', 'RESTOCK', 'BACKROOM', 'DELI'];

type StaffCommand = Extract<OpsCommand, { type: 'ChangeRole' | 'LockAssociate' }>;
export const STAFF_COMMANDS = new Set<OpsCommand['type']>(['ChangeRole', 'LockAssociate']);
export function isStaffCommand(cmd: OpsCommand): cmd is StaffCommand {
  return STAFF_COMMANDS.has(cmd.type);
}

/** 此刻在不在岗（当地时间）：有班次的员工（学生兼职工，决策记录 0020）只在班次时段里在岗 */
export function onShift(a: Pick<AssociateInfo, 'shift'>, now: number): boolean {
  if (!a.shift) return true;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= a.shift.from && m < a.shift.to;
}

/** 当前岗位：临时调动优先，否则用名单里的岗位 */
export function roleOf(st: StoreStatic | undefined, s: OpsState, associateId: string): AssociateRole | undefined {
  return s.roles[associateId] ?? st?.roster.find((a) => a.id === associateId)?.role;
}

/** 原岗位：当天排班的岗位，没有排班时按名单 */
export function baseRole(st: StoreStatic | undefined, s: OpsState, associateId: string, at: number): AssociateRole | undefined {
  return dutyOf(st, s, associateId, at).role ?? st?.roster.find((a) => a.id === associateId)?.role;
}

/** 此刻实际在做的岗位：临时调动 > 当天排班的岗位 > 名单里的岗位（在岗人员页、各台设备显示用） */
export function currentRole(st: StoreStatic | undefined, s: OpsState, associateId: string, at: number): AssociateRole | undefined {
  return s.roles[associateId] ?? baseRole(st, s, associateId, at);
}

/** 临时调动的时长：5 分钟到 12 小时 */
const MIN_MOVE = 5;
const MAX_MOVE = 12 * 60;

/** 手上是否有进行中的任务（拣货批次、交付会话、补取、补货、盘点） */
export function isBusy(s: OpsState, associateId: string): boolean {
  return !!taskOf(s, associateId);
}

/** 手上正在做的事（拣货批次、交付、后仓补取、补货、盘点）；没有时是空闲 */
export interface TeamTask {
  kind: 'WALK' | 'HANDOFF' | 'EXCEPTION' | 'RESTOCK' | 'COUNT';
  /** 批次编号、订单短号或任务编号 */
  ref: string;
}

export function taskOf(s: OpsState, associateId: string): TeamTask | undefined {
  const w = Object.values(s.walks).find((x) => x.associateId === associateId && (x.status === 'CLAIMED' || x.status === 'PICKING'));
  if (w) return { kind: 'WALK', ref: w.id };
  const h = Object.values(s.sessions).find((x) => x.status !== 'COMPLETED' && (x.owner === associateId || x.helpers.includes(associateId)));
  if (h) return { kind: 'HANDOFF', ref: s.orders[h.orderIds[0] ?? '']?.shortCode ?? h.key };
  const ex = Object.values(s.exceptions).find((x) => x.associateId === associateId && x.status === 'ASSIGNED');
  if (ex) return { kind: 'EXCEPTION', ref: ex.id };
  const r = Object.values(s.repl).find((x) => x.associateId === associateId && x.status === 'CLAIMED');
  if (r) return { kind: 'RESTOCK', ref: r.id };
  const c = Object.values(s.counts).find((x) => x.associateId === associateId && x.status === 'CLAIMED');
  return c ? { kind: 'COUNT', ref: c.id } : undefined;
}

/** 在岗人员页的一行（决策记录 0025） */
export interface TeamMember {
  id: string;
  name: string;
  /** 此刻的岗位：临时调动 > 当天排班的岗位 > 名单 */
  role: AssociateRole;
  /** 原岗位：当天排班的岗位 > 名单 */
  base: AssociateRole;
  on: boolean;
  /** 今天请假（报了缺勤） */
  absent?: boolean;
  /** 当天的班次（当天的分钟数）；全天在岗的没有 */
  shift?: { from: number; to: number };
  /** 临时调动：调来之前的岗位、几点谁调的、到几点自动调回 */
  moved?: { from: AssociateRole; at?: number; by?: string; until?: number };
  /** 固定名单：AI 不会建议调动 */
  locked: boolean;
  task?: TeamTask;
  /** 排队中的调动：手上的任务做完后去哪个岗位（决策记录 0026） */
  queued?: { role: AssociateRole; minutes?: number };
}

export interface TeamBoard {
  members: TeamMember[];
  /** 各岗位排着的活：待领的拣货批次、待暂存的框、到店等候的顾客、补货任务、后仓补取（不含自动运营的订单） */
  queue: Partial<Record<AssociateRole, number>>;
}

/** 在岗人员页的岗位顺序 */
export const ROLE_ORDER: readonly AssociateRole[] = ['LEAD', 'PICK', 'STAGE', 'HANDOFF', 'RESTOCK', 'BACKROOM', 'DELI'];

/** 在岗人员：谁此刻在哪个岗位、在做什么，各岗位排着多少活（所有设备都能看；带班负责人在这里调配） */
export function teamBoard(st: StoreStatic, s: OpsState, now: number): TeamBoard {
  const members = st.roster.map((a): TeamMember => {
    const d = dutyOf(st, s, a.id, now);
    const base = d.role ?? a.role;
    const role = s.roles[a.id] ?? base;
    const rc = s.roleChanges?.[a.id];
    const task = taskOf(s, a.id);
    const q = s.pendingMoves?.[a.id];
    return {
      id: a.id,
      name: a.name,
      role,
      base,
      on: d.on,
      ...(d.source === 'ABSENT' ? { absent: true } : {}),
      ...(d.from !== undefined && d.to !== undefined ? { shift: { from: d.from, to: d.to } } : {}),
      ...(s.roles[a.id] ? { moved: rc ?? { from: base } } : {}),
      locked: !!s.staffLocks[a.id],
      ...(task ? { task } : {}),
      ...(q ? { queued: { role: q.role, ...(q.minutes ? { minutes: q.minutes } : {}) } } : {}),
    };
  });
  members.sort((x, y) => Number(y.on) - Number(x.on) || ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || x.name.localeCompare(y.name));
  const mine = (orderId: string) => s.orders[orderId]?.track !== 'AUTO';
  const queue: TeamBoard['queue'] = {
    PICK: Object.values(s.walks).filter((w) => w.status === 'OPEN' && w.track !== 'AUTO').length,
    STAGE: Object.values(s.totes).filter((x) => x.status === 'PICKED' && mine(x.orderId)).length,
    HANDOFF: handoffBoard(s, st, now).filter((r) => r.arrivedAt !== undefined && !r.session && r.orderIds.some(mine)).length,
    RESTOCK: Object.values(s.repl).filter((x) => x.status === 'OPEN').length,
    BACKROOM: Object.values(s.exceptions).filter((x) => x.status === 'OPEN').length,
  };
  return { members, queue };
}

/** 是否可以调动（名单里有、不是带班负责人、目标是作业岗位、和现在不同） */
export function canMove(st: StoreStatic, s: OpsState, associateId: string, role: AssociateRole, at?: number): RejectCode | undefined {
  const a = st.roster.find((x) => x.id === associateId);
  if (!a) return 'ASSOCIATE_NOT_FOUND';
  if (a.role === 'LEAD' || !MOVABLE_ROLES.includes(role)) return 'ROLE_NOT_ALLOWED';
  // 有时间时按「此刻实际的岗位」比（含当天排班的岗位）
  if ((at !== undefined ? currentRole(st, s, associateId, at) : roleOf(st, s, associateId)) === role) return 'SAME_ROLE';
  return undefined;
}

export function roleChangeEvent(s: OpsState, st: StoreStatic, associateId: string, role: AssociateRole, recId?: string, minutes?: number, at?: number): PendingEvent {
  const from = (at !== undefined ? currentRole(st, s, associateId, at) : roleOf(st, s, associateId)) ?? role;
  return ev('AssociateRoleChanged', { associateId, role, from, ...(recId ? { recId } : {}), ...(minutes ? { minutes } : {}) });
}

/** 排队中的调动：手上的任务做完了就调过去；已经调不了的（例如已经在那个岗位）取消（门店的定时节拍里调用） */
export function queuedMoveEvents(s: OpsState, st: StoreStatic, at: number, skip: ReadonlySet<string> = new Set()): PendingEvent[] {
  const out: PendingEvent[] = [];
  for (const [id, q] of Object.entries(s.pendingMoves ?? {})) {
    if (skip.has(id) || taskOf(s, id)) continue;
    if (canMove(st, s, id, q.role, at)) out.push(ev('AssociateMoveCancelled', { associateId: id }));
    else out.push(roleChangeEvent(s, st, id, q.role, q.recId, q.minutes, at));
  }
  return out;
}

/** 到时间的临时调动：调回原岗位（门店的定时节拍里调用） */
export function expiredMoveEvents(s: OpsState, st: StoreStatic, at: number): PendingEvent[] {
  const out: PendingEvent[] = [];
  for (const [id, rc] of Object.entries(s.roleChanges ?? {})) {
    const now = s.roles[id];
    if (rc.until === undefined || rc.until > at || !now) continue;
    const back = baseRole(st, s, id, at) ?? rc.from;
    out.push(ev('AssociateRoleChanged', { associateId: id, role: back, from: now, revert: true }));
  }
  return out;
}

export function decideStaff(s: OpsState, env: CommandEnvelope & { cmd: StaffCommand }, st: StoreStatic, canManage: boolean): Result {
  const { cmd } = env;
  if (!canManage) return no('NOT_AUTHORIZED');
  if (cmd.type === 'ChangeRole') {
    // 排队中的调动：选「留在现在的岗位」就是取消排队
    if (s.pendingMoves?.[cmd.associateId] && currentRole(st, s, cmd.associateId, env.at) === cmd.role) return yes([ev('AssociateMoveCancelled', { associateId: cmd.associateId })]);
    const bad = canMove(st, s, cmd.associateId, cmd.role, env.at);
    if (bad) return no(bad);
    if (cmd.minutes !== undefined && !(Number.isInteger(cmd.minutes) && cmd.minutes >= MIN_MOVE && cmd.minutes <= MAX_MOVE)) return no('DURATION_INVALID');
    // 调回原岗位就不需要时长
    const back = baseRole(st, s, cmd.associateId, env.at) === cmd.role;
    const minutes = back ? undefined : cmd.minutes;
    // 手上有任务、选了「做完这一单再去」：先排队
    if (cmd.whenFree && taskOf(s, cmd.associateId)) return yes([ev('AssociateMoveQueued', { associateId: cmd.associateId, role: cmd.role, ...(minutes ? { minutes } : {}) })]);
    return yes([roleChangeEvent(s, st, cmd.associateId, cmd.role, undefined, minutes, env.at)]);
  }
  if (!st.roster.some((a) => a.id === cmd.associateId)) return no('ASSOCIATE_NOT_FOUND');
  if (!!s.staffLocks[cmd.associateId] === cmd.locked) return yes([]);
  return yes([ev('AssociateLockChanged', { associateId: cmd.associateId, locked: cmd.locked })]);
}

export function applyStaffEvent(s: OpsState, e: AnyOpsEvent, st?: StoreStatic): boolean {
  if (e.type === 'AssociateMoveQueued') {
    const p = e.payload;
    (s.pendingMoves ??= {})[p.associateId] = { role: p.role, at: e.at, by: e.actor, ...(p.minutes ? { minutes: p.minutes } : {}), ...(p.recId ? { recId: p.recId } : {}) };
    return true;
  }
  if (e.type === 'AssociateMoveCancelled') {
    if (s.pendingMoves) delete s.pendingMoves[e.payload.associateId];
    return true;
  }
  if (e.type === 'AssociateRoleChanged') {
    const id = e.payload.associateId;
    // 调过去了（或者又调了别的岗位）：排队的调动就不要了
    if (s.pendingMoves) delete s.pendingMoves[id];
    // 原岗位按事件发生时算（当天排班的岗位，没有排班时按名单），重放时结果一样
    const home = baseRole(st, s, id, e.at);
    if (home === e.payload.role) {
      delete s.roles[id];
      if (s.roleChanges) delete s.roleChanges[id];
    } else {
      s.roles[id] = e.payload.role;
      (s.roleChanges ??= {})[id] = { from: e.payload.from, at: e.at, by: e.actor, ...(e.payload.minutes ? { until: e.at + e.payload.minutes * 60_000 } : {}) };
    }
    return true;
  }
  if (e.type === 'AssociateLockChanged') {
    if (e.payload.locked) s.staffLocks[e.payload.associateId] = true;
    else delete s.staffLocks[e.payload.associateId];
    return true;
  }
  return false;
}
