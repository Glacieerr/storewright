import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { OpsState, StoreStatic } from './types';

/**
 * 时段产能（决策记录 0023 · 第三批 B6）：取货时段快接满时停止接新单。
 * 时段按门店的时段长度从当天零点切分；停止接单的时段里，订单平台再下的单会被拒绝（SLOT_CLOSED），已经接的单照常做。
 * AI 估计每个时段还能接多少单（服务端），快到上限时建议停止接单；带班负责人或控制台也可以手动停止、重新开放。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode): Result => ({ ok: false, reject: { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

type CapacityCommand = Extract<OpsCommand, { type: 'CloseSlot' | 'ReopenSlot' }>;
export const CAPACITY_COMMANDS = new Set<OpsCommand['type']>(['CloseSlot', 'ReopenSlot']);
export function isCapacityCommand(cmd: OpsCommand): cmd is CapacityCommand {
  return CAPACITY_COMMANDS.has(cmd.type);
}

/** 某个时刻所在取货时段的开始（按时段长度从当天零点切分） */
export function slotWindow(st: StoreStatic, at: number): number {
  const d = new Date(at);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const len = Math.max(5, st.rules.slotLengthMin) * 60_000;
  return day + Math.floor((at - day) / len) * len;
}

export function slotClosed(s: OpsState, st: StoreStatic, slotStart: number): boolean {
  return !!s.closedSlots?.[String(slotWindow(st, slotStart))];
}

export function closeSlotEvent(s: OpsState, st: StoreStatic, slotStart: number, recId?: string): PendingEvent | undefined {
  const w = slotWindow(st, slotStart);
  if (!Number.isFinite(w) || s.closedSlots?.[String(w)]) return undefined;
  return ev('SlotClosed', { slotStart: w, ...(recId ? { recId } : {}) });
}

export function decideCapacity(s: OpsState, env: CommandEnvelope & { cmd: CapacityCommand }, st: StoreStatic, canManage: boolean): Result {
  const { cmd } = env;
  if (!canManage) return no('NOT_AUTHORIZED');
  if (!Number.isFinite(cmd.slotStart)) return no('SLOT_NOT_FOUND');
  if (cmd.type === 'CloseSlot') {
    const e = closeSlotEvent(s, st, cmd.slotStart);
    return yes(e ? [e] : []);
  }
  const w = slotWindow(st, cmd.slotStart);
  return yes(s.closedSlots?.[String(w)] ? [ev('SlotReopened', { slotStart: w })] : []);
}

export function applyCapacityEvent(s: OpsState, e: AnyOpsEvent): boolean {
  switch (e.type) {
    case 'SlotClosed':
      (s.closedSlots ??= {})[String(e.payload.slotStart)] = { at: e.at, by: e.actor, ...(e.payload.recId ? { recId: e.payload.recId } : {}) };
      return true;
    case 'SlotReopened':
      if (s.closedSlots) delete s.closedSlots[String(e.payload.slotStart)];
      return true;
    default:
      return false;
  }
}
