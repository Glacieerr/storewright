import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { AssociateRole, OpsState, StoreStatic } from './types';

/**
 * 岗位调动与锁定（Phase 5c · 人员调配）。
 *
 * - 名单里的岗位是默认岗位；带班负责人（或采纳 AI 的调动建议）可以把员工临时调到别的作业岗位；
 * - 带班负责人和权限岗位（LEAD）不参与调动；
 * - 管理员可以锁定某位员工（固定名单）：AI 不会建议调动他，已发出的建议在执行时视为过时；人工调动不受影响。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode): Result => ({ ok: false, reject: { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

/** 可以调动到的作业岗位 */
export const MOVABLE_ROLES: readonly AssociateRole[] = ['PICK', 'STAGE', 'HANDOFF', 'RESTOCK', 'BACKROOM'];

type StaffCommand = Extract<OpsCommand, { type: 'ChangeRole' | 'LockAssociate' }>;
export const STAFF_COMMANDS = new Set<OpsCommand['type']>(['ChangeRole', 'LockAssociate']);
export function isStaffCommand(cmd: OpsCommand): cmd is StaffCommand {
  return STAFF_COMMANDS.has(cmd.type);
}

/** 当前岗位：临时调动优先，否则用名单里的岗位 */
export function roleOf(st: StoreStatic | undefined, s: OpsState, associateId: string): AssociateRole | undefined {
  return s.roles[associateId] ?? st?.roster.find((a) => a.id === associateId)?.role;
}

/** 手上是否有进行中的任务（拣货批次、交付会话、补取、补货、盘点） */
export function isBusy(s: OpsState, associateId: string): boolean {
  if (Object.values(s.walks).some((w) => w.associateId === associateId && (w.status === 'CLAIMED' || w.status === 'PICKING'))) return true;
  if (Object.values(s.sessions).some((x) => x.status !== 'COMPLETED' && (x.owner === associateId || x.helpers.includes(associateId)))) return true;
  if (Object.values(s.exceptions).some((x) => x.associateId === associateId && x.status === 'ASSIGNED')) return true;
  if (Object.values(s.repl).some((x) => x.associateId === associateId && x.status === 'CLAIMED')) return true;
  return Object.values(s.counts).some((x) => x.associateId === associateId && x.status === 'CLAIMED');
}

/** 是否可以调动（名单里有、不是带班负责人、目标是作业岗位、和现在不同） */
export function canMove(st: StoreStatic, s: OpsState, associateId: string, role: AssociateRole): RejectCode | undefined {
  const a = st.roster.find((x) => x.id === associateId);
  if (!a) return 'ASSOCIATE_NOT_FOUND';
  if (a.role === 'LEAD' || !MOVABLE_ROLES.includes(role)) return 'ROLE_NOT_ALLOWED';
  if (roleOf(st, s, associateId) === role) return 'SAME_ROLE';
  return undefined;
}

export function roleChangeEvent(s: OpsState, st: StoreStatic, associateId: string, role: AssociateRole, recId?: string): PendingEvent {
  return ev('AssociateRoleChanged', { associateId, role, from: roleOf(st, s, associateId) ?? role, ...(recId ? { recId } : {}) });
}

export function decideStaff(s: OpsState, env: CommandEnvelope & { cmd: StaffCommand }, st: StoreStatic, canManage: boolean): Result {
  const { cmd } = env;
  if (!canManage) return no('NOT_AUTHORIZED');
  if (cmd.type === 'ChangeRole') {
    const bad = canMove(st, s, cmd.associateId, cmd.role);
    if (bad) return no(bad);
    return yes([roleChangeEvent(s, st, cmd.associateId, cmd.role)]);
  }
  if (!st.roster.some((a) => a.id === cmd.associateId)) return no('ASSOCIATE_NOT_FOUND');
  if (!!s.staffLocks[cmd.associateId] === cmd.locked) return yes([]);
  return yes([ev('AssociateLockChanged', { associateId: cmd.associateId, locked: cmd.locked })]);
}

export function applyStaffEvent(s: OpsState, e: AnyOpsEvent, st?: StoreStatic): boolean {
  if (e.type === 'AssociateRoleChanged') {
    const home = st?.roster.find((a) => a.id === e.payload.associateId)?.role;
    if (home === e.payload.role) delete s.roles[e.payload.associateId];
    else s.roles[e.payload.associateId] = e.payload.role;
    return true;
  }
  if (e.type === 'AssociateLockChanged') {
    if (e.payload.locked) s.staffLocks[e.payload.associateId] = true;
    else delete s.staffLocks[e.payload.associateId];
    return true;
  }
  return false;
}
