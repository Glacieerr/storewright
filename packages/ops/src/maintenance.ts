import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { MaintenanceFault, MaintenanceTicket, OpsState } from './types';

/**
 * 设备报修（预测性维护，决策记录 0022 · E1）。
 *
 * - AI 发现设备在变坏（底线温度上升、预计不久越线，或读数卡住）时发出报修建议；采纳后开报修单，
 *   这台设备管着的暂存格位暂停放新框（已经在里面的框可以取出）；
 * - 带班负责人或控制台也可以直接报修；修好后关单并选实际故障（压缩机、门封、传感器、除霜、其他、没发现问题），
 *   这些记录就是以后评估和改进预测的标签。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode): Result => ({ ok: false, reject: { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

export const MAINTENANCE_FAULTS: readonly MaintenanceFault[] = ['COMPRESSOR', 'DOOR_SEAL', 'SENSOR', 'DEFROST', 'OTHER', 'NONE'];

type MaintenanceCommand = Extract<OpsCommand, { type: 'RequestMaintenance' | 'CloseMaintenance' }>;
export const MAINTENANCE_COMMANDS = new Set<OpsCommand['type']>(['RequestMaintenance', 'CloseMaintenance']);
export function isMaintenanceCommand(cmd: OpsCommand): cmd is MaintenanceCommand {
  return MAINTENANCE_COMMANDS.has(cmd.type);
}

export const openTicketFor = (s: OpsState, sensorId: string): MaintenanceTicket | undefined => Object.values(s.tickets ?? {}).find((t) => t.sensorId === sensorId && t.status === 'OPEN');

/** 开报修单的事件（AI 建议的动作和人工报修共用） */
export function ticketEvent(s: OpsState, sensorId: string, slots: readonly string[], reason: MaintenanceTicket['reason'], recId?: string): PendingEvent | undefined {
  if (!sensorId || openTicketFor(s, sensorId)) return undefined;
  const n = Object.keys(s.tickets ?? {}).length + 1;
  return ev('MaintenanceRequested', { ticket: { id: `MT${String(n).padStart(4, '0')}`, sensorId, reason, slots: [...new Set(slots)].slice(0, 200), ...(recId ? { recId } : {}) } });
}

export function decideMaintenance(s: OpsState, env: CommandEnvelope & { cmd: MaintenanceCommand }, canManage: boolean): Result {
  const { cmd } = env;
  if (!canManage) return no('NOT_AUTHORIZED');
  if (cmd.type === 'RequestMaintenance') {
    const e = ticketEvent(s, cmd.sensorId, cmd.slots ?? [], 'MANUAL');
    return e ? yes([e]) : no('TICKET_EXISTS');
  }
  const t = s.tickets?.[cmd.ticketId];
  if (!t) return no('TICKET_NOT_FOUND');
  if (t.status === 'CLOSED') return no('ALREADY_DONE');
  if (!MAINTENANCE_FAULTS.includes(cmd.fault)) return no('REASON_UNKNOWN');
  return yes([ev('MaintenanceClosed', { ticketId: t.id, fault: cmd.fault })]);
}

export function applyMaintenanceEvent(s: OpsState, e: AnyOpsEvent): boolean {
  if (e.type === 'MaintenanceRequested') {
    const t: MaintenanceTicket = { ...e.payload.ticket, status: 'OPEN', openedAt: e.at, by: e.actor };
    (s.tickets ??= {})[t.id] = t;
    const paused = (s.pausedSlots ??= {});
    for (const code of t.slots) paused[code] = t.id;
    return true;
  }
  if (e.type === 'MaintenanceClosed') {
    const t = s.tickets?.[e.payload.ticketId];
    if (t) {
      t.status = 'CLOSED';
      t.fault = e.payload.fault;
      t.closedAt = e.at;
      for (const code of t.slots) if (s.pausedSlots?.[code] === t.id) delete s.pausedSlots[code];
    }
    return true;
  }
  return false;
}

/** 预测性维护的命中情况：AI 发起的报修里，修好时确认有故障的比例 */
export function maintenanceStats(s: OpsState): { predicted: number; confirmed: number; open: number } {
  const all = Object.values(s.tickets ?? {});
  const ai = all.filter((t) => t.reason !== 'MANUAL' && t.status === 'CLOSED');
  return { predicted: ai.length, confirmed: ai.filter((t) => t.fault && t.fault !== 'NONE').length, open: all.filter((t) => t.status === 'OPEN').length };
}
