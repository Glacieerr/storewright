import type { OpsState, StoreStatic } from '@storewright/ops';
import type { SensorEval } from './rules';

/**
 * 孪生健康度（决策记录 0016 第 4.4 节）：孪生和现场对得上多少。
 * - 同步：最后一条作业事件距今多久；
 * - 数据源：员工设备（连着门店中枢，或最近 10 分钟有扫描；演示门店自动运营的虚拟员工也算）、POS 流水、货架传感器、设备传感器各自最近一次数据；
 * - 设备传感器：正常 / 注意 / 告警 / 离线；
 * - 账实一致：员工数货架和盘点时，系统估算与实际相差不超过 1 件的比例；
 * - AI 模型（决策记录 0022 · H3）：误差明显变大、因为数据中断暂停的模型。
 * 分数只是一个直观的汇总：每个问题扣分，问题代码由界面翻译。
 */

export type SourceId = 'DEVICES' | 'POS' | 'SHELF_SENSORS' | 'EQUIPMENT';
export type HealthIssue = 'NO_EVENTS' | 'DEVICES_OFFLINE' | 'POS_SILENT' | 'SENSORS_OFFLINE' | 'ALARMS' | 'LOW_FIDELITY' | 'AI_DRIFT' | 'AI_PAUSED';

export interface Fidelity {
  checks: number;
  withinOne: number;
}

export interface TwinHealth {
  at: number;
  score: number;
  lastEventAt?: number;
  devices: { online: number; total: number };
  sensors: { ok: number; warn: number; alarm: number; stale: number; total: number };
  sources: Array<{ id: SourceId; lastAt?: number }>;
  fidelity: Fidelity & { rate?: number };
  /** AI 模型的健康度（决策记录 0022 · H3）：正常、误差变大、暂停的个数 */
  ai?: { ok: number; drift: number; paused: number; total: number; drifting: string[]; pausedIds: string[] };
  issues: HealthIssue[];
}

export interface HealthInput {
  state: OpsState;
  statics: StoreStatic;
  now: number;
  evals: readonly SensorEval[];
  /** 各数据源最后一次数据的时间（门店中枢按事件的操作者记下） */
  lastAt: Partial<Record<SourceId, number>>;
  fidelity: Fidelity;
  /** 此刻连着门店中枢的员工（门店中枢按实时连接记下） */
  connected?: ReadonlySet<string>;
}

const MIN = 60_000;

export function twinHealth(h: HealthInput): TwinHealth {
  const { state: s, statics: st, now } = h;
  const recent = (at: number | undefined) => at !== undefined && now - at <= 10 * MIN;
  const virtual = Object.entries(s.activity).filter(([id]) => id.startsWith('V-'));
  const online = st.roster.filter((a) => h.connected?.has(a.id) || recent(s.activity[a.id]?.lastScanAt)).length + virtual.filter(([, a]) => recent(a.lastScanAt)).length;
  const total = st.roster.length + virtual.length;
  const sensors = { ok: 0, warn: 0, alarm: 0, stale: 0, total: h.evals.length };
  for (const e of h.evals) {
    if (e.status === 'OK') sensors.ok += 1;
    else if (e.status === 'WARN') sensors.warn += 1;
    else if (e.status === 'ALARM') sensors.alarm += 1;
    else sensors.stale += 1;
  }
  const rate = h.fidelity.checks ? h.fidelity.withinOne / h.fidelity.checks : undefined;
  const issues: HealthIssue[] = [];
  let score = 100;
  const lastEventAt = s.seq > 0 ? s.at : undefined;
  if (lastEventAt === undefined || now - lastEventAt > 30 * MIN) {
    issues.push('NO_EVENTS');
    score -= 25;
  }
  if ((h.lastAt.DEVICES !== undefined || (h.connected?.size ?? 0) > 0) && online === 0) {
    issues.push('DEVICES_OFFLINE');
    score -= 10;
  }
  if (h.lastAt.POS !== undefined && now - h.lastAt.POS > 15 * MIN) {
    issues.push('POS_SILENT');
    score -= 10;
  }
  if (sensors.stale > 0) {
    issues.push('SENSORS_OFFLINE');
    score -= Math.min(20, sensors.stale * 5);
  }
  if (sensors.alarm > 0) {
    issues.push('ALARMS');
    score -= Math.min(20, sensors.alarm * 10);
  }
  if (rate !== undefined && h.fidelity.checks >= 5 && rate < 0.8) {
    issues.push('LOW_FIDELITY');
    score -= Math.round((0.8 - rate) * 50);
  }
  const models = s.aiHealth?.models ?? [];
  const drifting = models.filter((m) => m.status === 'DRIFT').map((m) => m.id);
  const pausedIds = models.filter((m) => m.status === 'PAUSED').map((m) => m.id);
  if (drifting.length) {
    issues.push('AI_DRIFT');
    score -= Math.min(15, drifting.length * 5);
  }
  if (pausedIds.length) {
    issues.push('AI_PAUSED');
    score -= Math.min(10, pausedIds.length * 5);
  }
  const sources: TwinHealth['sources'] = (['DEVICES', 'POS', 'SHELF_SENSORS', 'EQUIPMENT'] as const).map((id) => (h.lastAt[id] !== undefined ? { id, lastAt: h.lastAt[id] } : { id }));
  return {
    at: now,
    score: Math.max(0, Math.min(100, score)),
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    devices: { online, total },
    sensors,
    sources,
    fidelity: { ...h.fidelity, ...(rate !== undefined ? { rate: Math.round(rate * 1000) / 1000 } : {}) },
    ...(models.length ? { ai: { ok: models.filter((m) => m.status === 'OK').length, drift: drifting.length, paused: pausedIds.length, total: models.length, drifting, pausedIds } } : {}),
    issues,
  };
}

/** 数货架、盘点的结果计入账实一致（相差不超过 1 件算一致） */
export function addFidelity(f: Fidelity, expected: number, counted: number): void {
  f.checks += 1;
  if (Math.abs(expected - counted) <= 1) f.withinOne += 1;
}
