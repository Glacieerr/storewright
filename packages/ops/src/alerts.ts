import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import { currentRole } from './staff';
import type { AlertImpact, AssociateRole, EquipmentAlert, OpsState, StoreStatic } from './types';

/**
 * 设备告警（数字孪生，决策记录 0016 第 4.1 节）：温度越线、卸货门长时间打开、传感器离线。
 * 门店中枢的孪生服务按规则发出和解除（操作者 twin），带班负责人、控制台或负责这台设备的岗位确认（决策记录 0026：以前只有带班负责人）。
 * 告警写进事件流，所以回放到任何时刻都能看到当时有哪些告警；遥测读数本身不进事件流。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode): Result => ({ ok: false, reject: { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

export const MAX_ALERTS = 200;
/** 可以发出和解除告警的操作者（门店中枢内部） */
const TWIN_ACTORS = new Set(['twin', 'system']);

type AlertCommand = Extract<OpsCommand, { type: 'RaiseEquipmentAlert' | 'ClearEquipmentAlert' | 'AcknowledgeAlert' }>;
export const ALERT_COMMANDS = new Set<OpsCommand['type']>(['RaiseEquipmentAlert', 'ClearEquipmentAlert', 'AcknowledgeAlert']);
export function isAlertCommand(cmd: OpsCommand): cmd is AlertCommand {
  return ALERT_COMMANDS.has(cmd.type);
}

function cleanImpact(i: Partial<AlertImpact> | undefined): AlertImpact {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0);
  const ids = (x: unknown, max: number) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string').slice(0, max) : []);
  return { orders: ids(i?.orders, 200), totes: n(i?.totes), cases: n(i?.cases), units: n(i?.units), moveTo: ids(i?.moveTo, 5) };
}

/** 设备 → 负责的岗位：后仓冷库和卸货门给后仓、补货；暂存冷柜给暂存、交付；熟食保温给熟食 */
export function rolesForSensor(sensorId: string): AssociateRole[] {
  if (sensorId.startsWith('T-STAGING')) return ['STAGE', 'HANDOFF'];
  if (sensorId.startsWith('T-HOT')) return ['DELI'];
  if (sensorId.startsWith('T-') || sensorId.startsWith('D-')) return ['BACKROOM', 'RESTOCK'];
  return [];
}

/** 此刻在负责这台设备的岗位上 */
export function responsibleFor(st: StoreStatic, s: OpsState, sensorId: string, associateId: string, at: number): boolean {
  const role = currentRole(st, s, associateId, at);
  return !!role && rolesForSensor(sensorId).includes(role);
}

export function decideAlert(s: OpsState, env: CommandEnvelope & { cmd: AlertCommand }, canManage: boolean, st?: StoreStatic): Result {
  const { cmd, actor, at } = env;
  if (cmd.type === 'RaiseEquipmentAlert') {
    if (!TWIN_ACTORS.has(actor)) return no('NOT_AUTHORIZED');
    // 同一个传感器、同一类告警还没解除时不重复发
    if (Object.values(s.alerts).some((a) => a.sensorId === cmd.sensorId && a.kind === cmd.kind && a.status !== 'CLEARED')) return yes([]);
    const p = {
      alertId: `AL${String(s.counters.alerts + 1).padStart(5, '0')}`,
      sensorId: String(cmd.sensorId).slice(0, 60),
      kind: cmd.kind,
      severity: cmd.severity === 'ALARM' ? ('ALARM' as const) : ('WARN' as const),
      value: Number.isFinite(cmd.value) ? cmd.value : 0,
      since: Number.isFinite(cmd.since) ? Math.min(cmd.since, at) : at,
      impact: cleanImpact(cmd.impact),
    };
    return yes([ev('EquipmentAlertRaised', cmd.limit !== undefined && Number.isFinite(cmd.limit) ? { ...p, limit: cmd.limit } : p)]);
  }
  const a = s.alerts[cmd.alertId];
  if (!a) return no('ALERT_NOT_FOUND');
  if (cmd.type === 'ClearEquipmentAlert') {
    if (!TWIN_ACTORS.has(actor)) return no('NOT_AUTHORIZED');
    if (a.status === 'CLEARED') return yes([]);
    const p = { alertId: a.id, durationSec: Math.max(0, Math.round((at - a.since) / 1000)) };
    return yes([ev('EquipmentAlertCleared', cmd.peak !== undefined && Number.isFinite(cmd.peak) ? { ...p, peak: cmd.peak } : p)]);
  }
  if (!canManage && !(st && responsibleFor(st, s, a.sensorId, actor, at))) return no('NOT_AUTHORIZED');
  if (a.status === 'CLEARED') return no('ALERT_CLEARED');
  if (a.status === 'ACKED') return yes([]);
  return yes([ev('EquipmentAlertAcknowledged', { alertId: a.id })]);
}

export function applyAlertEvent(s: OpsState, e: AnyOpsEvent): boolean {
  if (e.type === 'EquipmentAlertRaised') {
    const p = e.payload;
    const a: EquipmentAlert = { id: p.alertId, sensorId: p.sensorId, kind: p.kind, severity: p.severity, value: p.value, since: p.since, raisedAt: e.at, status: 'ACTIVE', impact: p.impact };
    if (p.limit !== undefined) a.limit = p.limit;
    s.alerts ??= {};
    s.alerts[p.alertId] = a;
    s.counters.alerts = (s.counters.alerts ?? 0) + 1;
    const ids = Object.keys(s.alerts);
    if (ids.length > MAX_ALERTS) {
      const old = Object.values(s.alerts)
        .filter((x) => x.status === 'CLEARED')
        .sort((x, y) => x.raisedAt - y.raisedAt || x.id.localeCompare(y.id));
      for (const x of old.slice(0, ids.length - MAX_ALERTS)) delete s.alerts[x.id];
    }
    return true;
  }
  if (e.type === 'EquipmentAlertAcknowledged') {
    const a = s.alerts?.[e.payload.alertId];
    if (a && a.status === 'ACTIVE') {
      a.status = 'ACKED';
      a.ackAt = e.at;
      a.ackBy = e.actor;
    }
    return true;
  }
  if (e.type === 'EquipmentAlertCleared') {
    const a = s.alerts?.[e.payload.alertId];
    if (a) {
      a.status = 'CLEARED';
      a.clearedAt = e.at;
      if (e.payload.peak !== undefined) a.peak = e.payload.peak;
    }
    return true;
  }
  return false;
}

/** 还没解除的告警：严重的在前，新的在前 */
export function activeAlerts(s: OpsState): EquipmentAlert[] {
  return Object.values(s.alerts ?? {})
    .filter((a) => a.status !== 'CLEARED')
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'ALARM' ? -1 : 1) || b.raisedAt - a.raisedAt || a.id.localeCompare(b.id));
}
