import type { EquipmentAlertKind } from '@storewright/ops';
import type { SensorDef } from './registry';
import type { TelemetryStore } from './telemetry';

/**
 * 告警规则（决策记录 0016 第 4.1 节）：
 * - 温度越过告警线持续 breachMin 分钟、或越过严重线，立即告警；回到线内持续 clearSec 秒解除；
 * - 卸货门打开、又没有收货作业，超过 doorOpenMaxMin 分钟提醒；关门或开始收货就解除；
 * - 连续 staleIntervals 个周期没有读数视为离线，离线 offlineAlertMin 分钟告警，恢复读数就解除。
 * 规则只给出「该告警 / 该解除」，告警本身由门店中枢写进作业事件流（回放里也看得到）。
 */

export type SensorStatus = 'OK' | 'WARN' | 'ALARM' | 'STALE' | 'NO_DATA';
export type AlertKind = EquipmentAlertKind;

export interface RuleConfig {
  breachMin: number;
  clearSec: number;
  doorOpenMaxMin: number;
  staleIntervals: number;
  offlineAlertMin: number;
}

export const DEFAULT_RULES: RuleConfig = { breachMin: 10, clearSec: 180, doorOpenMaxMin: 45, staleIntervals: 3, offlineAlertMin: 5 };
/** 演示门店：访客一两分钟内就能看到告警和解除 */
export const DEMO_RULES: RuleConfig = { breachMin: 1, clearSec: 30, doorOpenMaxMin: 2, staleIntervals: 3, offlineAlertMin: 2 };

export interface SensorEval {
  id: string;
  status: SensorStatus;
  value?: number;
  at?: number;
  /** 越线（或门开着、离线）开始的时间 */
  since?: number;
}

export interface AlertCandidate {
  sensorId: string;
  kind: AlertKind;
  severity: 'WARN' | 'ALARM';
  value: number;
  limit?: number;
  since: number;
}

export interface AlertClear {
  sensorId: string;
  kind: AlertKind;
  /** 越线期间的极值（温度） */
  peak?: number;
}

export interface RuleContext {
  /** 这个卸货门现在有没有收货作业（有作业时开门是正常的） */
  dockBusy?: (dockId: string, index: number) => boolean;
}

interface Track {
  breachSince?: number;
  okSince?: number;
  openSince?: number;
  staleSince?: number;
  peak?: number;
  active: Set<AlertKind>;
}

const isTempAlert = (k: AlertKind) => k === 'TEMP_HIGH' || k === 'TEMP_LOW';

export class RuleEngine {
  private readonly tracks = new Map<string, Track>();

  constructor(
    private readonly defs: readonly SensorDef[],
    public cfg: RuleConfig = DEFAULT_RULES,
  ) {}

  private trackOf(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { active: new Set() };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** 作业状态里已有、还没解除的告警（服务重启后接上，避免重复告警） */
  adopt(sensorId: string, kind: AlertKind): void {
    this.trackOf(sensorId).active.add(kind);
  }

  /** 告警在别处解除了（例如门店被清空） */
  forget(sensorId: string, kind?: AlertKind): void {
    const t = this.tracks.get(sensorId);
    if (!t) return;
    if (kind) t.active.delete(kind);
    else t.active.clear();
  }

  reset(): void {
    this.tracks.clear();
  }

  evaluate(store: TelemetryStore, now: number, ctx: RuleContext = {}): { evals: SensorEval[]; raise: AlertCandidate[]; clear: AlertClear[] } {
    const evals: SensorEval[] = [];
    const raise: AlertCandidate[] = [];
    const clear: AlertClear[] = [];
    const cfg = this.cfg;
    for (const d of this.defs) {
      const tr = this.trackOf(d.id);
      const r = store.latest(d.id);
      if (!r) {
        evals.push({ id: d.id, status: 'NO_DATA' });
        continue;
      }
      // 离线：很久没有读数时不再根据旧读数判断温度
      if (now - r.at > cfg.staleIntervals * d.intervalSec * 1000) {
        tr.staleSince ??= r.at + d.intervalSec * 1000;
        if (!tr.active.has('SENSOR_OFFLINE') && now - tr.staleSince >= cfg.offlineAlertMin * 60_000) {
          tr.active.add('SENSOR_OFFLINE');
          raise.push({ sensorId: d.id, kind: 'SENSOR_OFFLINE', severity: 'WARN', value: r.value, since: tr.staleSince });
        }
        evals.push({ id: d.id, status: 'STALE', value: r.value, at: r.at, since: tr.staleSince });
        continue;
      }
      tr.staleSince = undefined;
      if (tr.active.delete('SENSOR_OFFLINE')) clear.push({ sensorId: d.id, kind: 'SENSOR_OFFLINE' });
      const v = r.value;

      if (d.kind === 'TEMP' && d.limits) {
        const L = d.limits;
        const over = L.direction === 'MAX' ? v > L.limit : v < L.limit;
        const critical = L.direction === 'MAX' ? v >= L.critical : v <= L.critical;
        const near = L.direction === 'MAX' ? v > L.limit - 1 : v < L.limit + 2;
        const kind: AlertKind = L.direction === 'MAX' ? 'TEMP_HIGH' : 'TEMP_LOW';
        const overV = (x: number) => (L.direction === 'MAX' ? x > L.limit : x < L.limit);
        if (over) {
          // 越线从什么时候开始：往回找连续越线的读数（判断不及时或服务刚重启时也算得对）
          tr.breachSince ??= Math.min(r.at, store.runStart(d.id, overV) ?? r.at);
          tr.okSince = undefined;
          tr.peak = tr.peak === undefined ? v : L.direction === 'MAX' ? Math.max(tr.peak, v) : Math.min(tr.peak, v);
          if (!tr.active.has(kind) && (critical || now - tr.breachSince >= cfg.breachMin * 60_000)) {
            tr.active.add(kind);
            raise.push({ sensorId: d.id, kind, severity: 'ALARM', value: v, limit: L.limit, since: tr.breachSince });
          }
        } else {
          tr.okSince ??= Math.min(r.at, store.runStart(d.id, (x) => !overV(x)) ?? r.at);
          if (tr.active.has(kind) && now - tr.okSince >= cfg.clearSec * 1000) {
            tr.active.delete(kind);
            clear.push({ sensorId: d.id, kind, ...(tr.peak !== undefined ? { peak: tr.peak } : {}) });
            tr.peak = undefined;
          }
          if (!tr.active.has(kind)) {
            tr.breachSince = undefined;
            tr.peak = undefined;
          }
        }
        const alarm = [...tr.active].some(isTempAlert);
        const status: SensorStatus = alarm ? 'ALARM' : over || near ? 'WARN' : 'OK';
        evals.push({ id: d.id, status, value: v, at: r.at, ...(tr.breachSince !== undefined ? { since: tr.breachSince } : {}) });
        continue;
      }

      if (d.kind === 'DOOR' && d.anchor.type === 'DOCK') {
        const open = v >= 0.5;
        const busy = ctx.dockBusy?.(d.anchor.dockId, d.anchor.index) ?? false;
        if (open && !busy) {
          tr.openSince ??= r.at;
          if (!tr.active.has('DOOR_OPEN') && now - tr.openSince >= cfg.doorOpenMaxMin * 60_000) {
            tr.active.add('DOOR_OPEN');
            raise.push({ sensorId: d.id, kind: 'DOOR_OPEN', severity: 'WARN', value: v, since: tr.openSince });
          }
        } else {
          tr.openSince = undefined;
          if (tr.active.delete('DOOR_OPEN')) clear.push({ sensorId: d.id, kind: 'DOOR_OPEN' });
        }
        evals.push({ id: d.id, status: open && !busy ? 'WARN' : 'OK', value: v, at: r.at, ...(tr.openSince !== undefined ? { since: tr.openSince } : {}) });
        continue;
      }

      evals.push({ id: d.id, status: 'OK', value: v, at: r.at });
    }
    return { evals, raise, clear };
  }
}
