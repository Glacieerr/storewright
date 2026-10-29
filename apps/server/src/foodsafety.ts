import type { OpsState } from '@storewright/ops';
import type { SensorDef } from '@storewright/twin';
import type { Bucket } from '@storewright/twin';

/**
 * 食品安全记录（决策记录 0024 · 第四批 E5）：某一天每台温控设备的最低、最高、平均温度和越线的分钟数（按每分钟的读数汇总），
 * 当天的告警和处理（谁、几点确认、几点解除）、报修单，加一段说明；带班负责人或门店管理员确认后记进事件流。
 * 读数来自数字孪生的遥测（演示门店是设备仿真）；只保留在内存里的那一段，太早的日子可能没有读数。
 */

export interface FoodSafetyRow {
  sensorId: string;
  tempZone?: string;
  min?: number;
  max?: number;
  avg?: number;
  /** 越过告警线的分钟数 */
  minutesOut: number;
  readings: number;
  limit?: number;
  direction?: 'MAX' | 'MIN';
}

export interface FoodSafetyLog {
  date: string;
  rows: FoodSafetyRow[];
  alerts: Array<{ id: string; sensorId: string; kind: string; severity: string; raisedAt: number; ackAt?: number; ackBy?: string; clearedAt?: number; peak?: number }>;
  tickets: Array<{ id: string; sensorId: string; reason: string; openedAt: number; closedAt?: number; fault?: string }>;
  confirmed?: { at: number; by: string; note?: string };
  /** 说明里要用的数字：设备数、有越线的设备数、告警数、确认用的平均分钟数 */
  summary: { sensors: number; withExcursion: number; alerts: number; acked: number; avgAckMin?: number; tickets: number };
}

export function foodSafetyLog(s: OpsState, defs: readonly SensorDef[], range: (sensorId: string, from: number, to: number) => Bucket[], date: string): FoodSafetyLog {
  const from = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getTime();
  const to = from + 86_400_000;
  const rows: FoodSafetyRow[] = defs
    .filter((d) => d.kind === 'TEMP' && d.limits)
    .map((d) => {
      const b = range(d.id, from, to).filter((x) => x.n > 0);
      const L = d.limits as NonNullable<SensorDef['limits']>;
      const out = (x: Bucket) => (L.direction === 'MAX' ? x.max > L.limit : x.min < L.limit);
      const row: FoodSafetyRow = { sensorId: d.id, minutesOut: b.filter(out).length, readings: b.length, limit: L.limit, direction: L.direction, ...(d.tempZone ? { tempZone: d.tempZone } : {}) };
      if (b.length) {
        row.min = Math.round(Math.min(...b.map((x) => x.min)) * 10) / 10;
        row.max = Math.round(Math.max(...b.map((x) => x.max)) * 10) / 10;
        row.avg = Math.round((b.reduce((a, x) => a + x.avg, 0) / b.length) * 10) / 10;
      }
      return row;
    });
  const alerts = Object.values(s.alerts ?? {})
    .filter((a) => a.raisedAt >= from && a.raisedAt < to)
    .sort((a, b) => a.raisedAt - b.raisedAt)
    .map((a) => ({ id: a.id, sensorId: a.sensorId, kind: a.kind, severity: a.severity, raisedAt: a.raisedAt, ...(a.ackAt !== undefined ? { ackAt: a.ackAt } : {}), ...(a.ackBy ? { ackBy: a.ackBy } : {}), ...(a.clearedAt !== undefined ? { clearedAt: a.clearedAt } : {}), ...(a.peak !== undefined ? { peak: a.peak } : {}) }));
  const tickets = Object.values(s.tickets ?? {})
    .filter((t) => (t.openedAt >= from && t.openedAt < to) || (t.closedAt !== undefined && t.closedAt >= from && t.closedAt < to))
    .map((t) => ({ id: t.id, sensorId: t.sensorId, reason: t.reason, openedAt: t.openedAt, ...(t.closedAt !== undefined ? { closedAt: t.closedAt } : {}), ...(t.fault ? { fault: t.fault } : {}) }));
  const acked = alerts.filter((a) => a.ackAt !== undefined);
  const confirmed = s.foodSafety?.[date];
  return {
    date,
    rows,
    alerts,
    tickets,
    ...(confirmed ? { confirmed } : {}),
    summary: {
      sensors: rows.length,
      withExcursion: rows.filter((r) => r.minutesOut > 0).length,
      alerts: alerts.length,
      acked: acked.length,
      ...(acked.length ? { avgAckMin: Math.round((acked.reduce((a, x) => a + ((x.ackAt as number) - x.raisedAt), 0) / acked.length / 60_000) * 10) / 10 } : {}),
      tickets: tickets.length,
    },
  };
}
