import { createRng, type Rng } from '@storewright/domain';
import { activeAlerts, clientProjection, openTicketFor, type AnyOpsEvent } from '@storewright/ops';
import type { RecommendationDraft } from '@storewright/ai';
import {
  addFidelity,
  alertImpact,
  assessDegradation,
  DEFAULT_DEGRADATION,
  DEMO_DEGRADATION,
  type DegradationResult,
  DEFAULT_RULES,
  DEMO_RULES,
  ReplayLog,
  RuleEngine,
  sensorsFor,
  slotsOf,
  TelemetryStore,
  twinHealth,
  type Bucket,
  type Fidelity,
  type Reading,
  type RuleConfig,
  type SensorDef,
  type SensorEval,
  type SourceId,
  type TwinFrame,
  type TwinHealth,
  type TwinReplay,
  type TwinSnapshot,
} from '@storewright/twin';
import type { StoreRuntime } from './runtime';
import type { EventLog } from './storage';

/**
 * 门店的数字孪生服务（决策记录 0016）：每家店一个，挂在门店中枢上，Node 后端和浏览器内演示跑的是同一份代码。
 *
 * - 设备遥测：HTTP / MQTT 接入的读数（演示门店由设备仿真产生），按规则判断，越线时把告警写进作业事件流；
 * - 回放：保存全部作业事件，按时间重建任意时刻的门店；
 * - 健康度：各数据源最后一次数据、传感器状态、账实一致（员工数货架和盘点的结果）；
 * - 推送：订阅了孪生的连接（模拟器、控制台）每 2 秒收到一次读数和健康度，员工手机不订阅。
 */

export const TWIN_FRAME_MS = 2000;
/** 遥测读数的时间最多可以比现在早多久（设备补传） */
const MAX_BACKFILL_MS = 24 * 3600_000;

export interface TwinOptions {
  demo: boolean;
  rules?: RuleConfig;
  /** 门店客流仿真的门店时间（小时）；没有运行时为 undefined，按墙上时钟 */
  storeHour?: () => number | undefined;
  seed?: number;
}

export class TwinService {
  readonly defs: SensorDef[];
  readonly telemetry = new TelemetryStore();
  readonly rules: RuleEngine;
  /** 演示门店的设备仿真 */
  readonly sim: EquipmentSim | undefined;
  private readonly replay: ReplayLog;
  private readonly byId: Map<string, SensorDef>;
  private lastAt: Partial<Record<SourceId, number>> = {};
  private fidelity: Fidelity = { checks: 0, withinOne: 0 };
  private evals: SensorEval[] = [];
  private readonly listeners = new Set<(f: TwinFrame) => void>();
  /** 连着门店中枢的员工设备（员工 → 连接数） */
  private readonly devices = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsub: (() => void) | undefined;
  private busy = false;
  private readonly roster: ReadonlySet<string>;
  /** 设备健康（预测性维护，决策记录 0022 · E1）：每台温控设备最近一次的评估 */
  readonly equipment = new Map<string, DegradationResult>();
  private lastAssess = 0;

  constructor(
    private readonly rt: StoreRuntime,
    private readonly log: EventLog,
    private readonly opts: TwinOptions,
  ) {
    this.defs = sensorsFor(rt.statics);
    this.byId = new Map(this.defs.map((d) => [d.id, d]));
    this.rules = new RuleEngine(this.defs, opts.rules ?? (opts.demo ? DEMO_RULES : DEFAULT_RULES));
    this.replay = new ReplayLog(rt.statics);
    this.roster = new Set(rt.statics.roster.map((a) => a.id));
    this.sim = opts.demo ? new EquipmentSim(this, rt, opts.storeHour, opts.seed) : undefined;
  }

  async init(): Promise<void> {
    // 启动时载入历史：回放日志自己应用一遍（存中间的检查点）；之后运行中的事件直接用门店运行时的状态
    this.observe(await this.log.load(this.rt.id), false);
    // 服务重启后接上还没解除的告警，避免重复告警
    for (const a of activeAlerts(this.rt.state)) this.rules.adopt(a.sensorId, a.kind);
    this.unsub = this.rt.subscribe((m) => (m.t === 'reset' ? this.onReset() : this.observe(m.events)));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TWIN_FRAME_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  close(): void {
    this.stop();
    this.unsub?.();
    this.unsub = undefined;
  }

  /** 一个周期：设备仿真出读数（演示）→ 按规则判断、发出或解除告警 → 推送 */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.sim?.step(now);
      await this.evaluate(now);
      // 设备健康：演示门店每 10 秒、真实门店每 5 分钟评估一次
      if (now - this.lastAssess >= (this.opts.demo ? 10_000 : 5 * 60_000)) {
        this.lastAssess = now;
        await this.assessEquipment(now);
      }
      if (this.listeners.size) {
        const f = this.frame(now);
        for (const l of this.listeners) l(f);
      }
    } finally {
      this.busy = false;
    }
  }

  /** 接入读数（设备、MQTT、演示仿真）；返回收下和拒收的条数 */
  ingest(readings: readonly Reading[], now = Date.now()): { accepted: number; rejected: Array<{ index: number; error: string }> } {
    let accepted = 0;
    const rejected: Array<{ index: number; error: string }> = [];
    readings.forEach((r, index) => {
      if (!this.byId.has(r.sensorId)) return rejected.push({ index, error: 'unknown_sensor' });
      if (r.at > now + 60_000 || r.at < now - MAX_BACKFILL_MS) return rejected.push({ index, error: 'timestamp' });
      if (!this.telemetry.ingest(r)) return rejected.push({ index, error: 'value' });
      accepted += 1;
    });
    if (accepted) this.lastAt.EQUIPMENT = now;
    return { accepted, rejected };
  }

  /** 员工设备连上或断开（门店中枢的实时连接调用） */
  deviceConnected(actor: string, delta: 1 | -1): void {
    const n = (this.devices.get(actor) ?? 0) + delta;
    if (n > 0) this.devices.set(actor, n);
    else this.devices.delete(actor);
  }

  subscribe(fn: (f: TwinFrame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  frame(now = Date.now()): TwinFrame {
    const f: TwinFrame = {
      t: 'twin',
      at: now,
      sensors: this.evals
        .filter((e) => e.value !== undefined && e.at !== undefined)
        .map((e) => ({ id: e.id, v: Math.round((e.value as number) * 10) / 10, s: e.status, at: e.at as number, ...(e.since !== undefined ? { since: e.since } : {}) })),
      health: this.health(now),
    };
    const faults = this.sim?.faultList();
    if (faults?.length) f.faults = faults;
    if (this.equipment.size) f.equipment = [...this.equipment.values()].map((r) => ({ id: r.sensorId, s: r.status, ...(r.etaMin !== undefined ? { eta: r.etaMin } : {}), ...(r.slopePerHour !== undefined ? { slope: r.slopePerHour } : {}) }));
    return f;
  }

  /**
   * 设备健康：每台温控设备和自己的平时比（底线温度的趋势、开门回温、读数卡住），
   * 有风险或读数卡住时发出报修建议（带预计多久越线、理由；采纳后开报修单、暂停往这台设备放新框）。
   */
  async assessEquipment(now = Date.now()): Promise<DegradationResult[]> {
    const cfg = this.opts.demo ? DEMO_DEGRADATION : DEFAULT_DEGRADATION;
    const out: DegradationResult[] = [];
    for (const d of this.defs) {
      if (d.kind !== 'TEMP' || !d.limits) continue;
      const r = assessDegradation(d, this.telemetry.range(d.id, now - cfg.windowMin * 60_000, now), now, cfg);
      this.equipment.set(d.id, r);
      out.push(r);
      if (r.status !== 'RISK' && r.status !== 'STUCK') continue;
      // 已经越线告警、已经有报修单、或者同一台设备已经有待处理的建议：不重复
      const s = this.rt.state;
      if (openTicketFor(s, d.id) || activeAlerts(s).some((a) => a.sensorId === d.id) || Object.values(s.recs).some((x) => x.status === 'OPEN' && x.module === 'EQUIPMENT' && x.target === d.id)) continue;
      const draft: RecommendationDraft = {
        module: 'EQUIPMENT',
        target: d.id,
        action: { kind: 'REQUEST_REPAIR', params: { sensorId: d.id, reason: r.status, slots: slotsOf(d, this.rt.statics).join(','), nudge: true, urgent: r.status === 'RISK' && (r.etaMin ?? 99) <= cfg.horizonMin / 2 } },
        ...(r.etaMin !== undefined ? { prediction: { value: r.etaMin, ...(r.etaLow !== undefined ? { low: r.etaLow } : {}), ...(r.etaHigh !== undefined ? { high: r.etaHigh } : {}), unit: 'MINUTES' } } : {}),
        confidence: r.status === 'STUCK' ? 0.8 : Math.min(0.9, 0.55 + Math.min(0.35, (r.slopePerHour ?? 0) / (cfg.slopeMin * 10))),
        reasons: r.reasons.map((x, i) => ({ factor: x.factor, ...(x.value !== undefined ? { value: x.value } : {}), weight: Math.round((1 / (i + 1.5)) * 100) / 100, ...(x.params ? { params: x.params } : {}) })),
        alternatives: [],
        model: { id: 'equipment-health', version: 1, kind: 'robust-trend' },
        expiresAt: now + (this.opts.demo ? 20 : 6 * 60) * 60_000,
      };
      await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now });
    }
    return out;
  }

  health(now = Date.now()): TwinHealth {
    return twinHealth({ state: this.rt.state, statics: this.rt.statics, now, evals: this.evals, lastAt: this.lastAt, fidelity: this.fidelity, connected: new Set(this.devices.keys()) });
  }

  snapshot(now = Date.now()): TwinSnapshot {
    const series: Record<string, Bucket[]> = {};
    for (const d of this.defs) series[d.id] = this.telemetry.range(d.id, now - 60 * 60_000, now);
    const s: TwinSnapshot = { at: now, rules: this.rules.cfg, frame: this.frame(now), series, demo: this.opts.demo };
    const from = this.replay.firstAt;
    if (from !== undefined) s.from = from;
    return s;
  }

  /** 回放：t 时刻的门店（精简快照）和设备读数 */
  at(t: number): TwinReplay {
    const sensors: TwinReplay['sensors'] = [];
    for (const d of this.defs) {
      const v = this.telemetry.valueAt(d.id, t);
      if (v !== undefined) sensors.push({ id: d.id, v: Math.round(v * 10) / 10 });
    }
    return { at: t, state: clientProjection(this.replay.stateAt(t), t), sensors };
  }

  series(sensorId: string, from: number, to: number): Bucket[] {
    return this.telemetry.range(sensorId, from, to);
  }

  get firstAt(): number | undefined {
    return this.replay.firstAt;
  }

  /** 这个卸货门有没有收货作业：已到达、还没收完的收货单按顺序占用卸货门（与三维场景一致） */
  dockBusy(index: number): boolean {
    let open = 0;
    for (const r of Object.values(this.rt.state.receipts)) if (r.arrivedAt !== undefined && r.closedAt === undefined) open += 1;
    return index < open;
  }

  private async evaluate(now: number): Promise<void> {
    const { evals, raise, clear } = this.rules.evaluate(this.telemetry, now, { dockBusy: (_id, i) => this.dockBusy(i) });
    this.evals = evals;
    for (const c of raise) {
      const def = this.byId.get(c.sensorId);
      if (!def) continue;
      const impact = alertImpact(this.rt.state, this.rt.statics, def);
      await this.rt.submit({ cmd: { type: 'RaiseEquipmentAlert', sensorId: c.sensorId, kind: c.kind, severity: c.severity, value: Math.round(c.value * 10) / 10, ...(c.limit !== undefined ? { limit: c.limit } : {}), since: c.since, impact }, actor: 'twin', at: now });
    }
    for (const c of clear) {
      const a = activeAlerts(this.rt.state).find((x) => x.sensorId === c.sensorId && x.kind === c.kind);
      if (a) await this.rt.submit({ cmd: { type: 'ClearEquipmentAlert', alertId: a.id, ...(c.peak !== undefined ? { peak: Math.round(c.peak * 10) / 10 } : {}) }, actor: 'twin', at: now });
    }
  }

  private observe(events: readonly AnyOpsEvent[], live = true): void {
    if (!events.length) return;
    if (live) this.replay.append(events, () => this.rt.state);
    else this.replay.append(events);
    for (const e of events) {
      if (e.type === 'SalesRecorded') this.lastAt.POS = e.at;
      else if (e.type === 'SensorReading') this.lastAt.SHELF_SENSORS = e.at;
      else if (this.roster.has(e.actor) || e.actor.startsWith('V-')) this.lastAt.DEVICES = e.at;
      if (e.type === 'ShelfCounted') addFidelity(this.fidelity, e.payload.previousEst, e.payload.units);
      else if (e.type === 'CycleCountCompleted') for (const r of e.payload.results) addFidelity(this.fidelity, r.expected, r.counted);
    }
    this.sim?.observe(events);
  }

  private onReset(): void {
    this.replay.reset();
    this.rules.reset();
    this.fidelity = { checks: 0, withinOne: 0 };
    this.lastAt = this.lastAt.EQUIPMENT !== undefined ? { EQUIPMENT: this.lastAt.EQUIPMENT } : {};
    this.sim?.clearFaults();
  }
}

/**
 * 演示门店可以模拟的故障：压缩机故障（温度一直升高）、卸货门没关、传感器断线；
 * 慢性故障（决策记录 0022）：制冷慢慢变差（底线温度一分钟升约 0.1 °C）、门封漏气（开门后回温更多、更慢）、传感器读数卡住
 */
export type FaultMode = 'FAIL' | 'OPEN' | 'OFFLINE' | 'DEGRADE' | 'SEAL' | 'STUCK';
/** 控制台的故障按钮对应的传感器 */
export type FaultTarget = 'STAGING_CHILLED' | 'STAGING_FROZEN' | 'COOLER' | 'FREEZER' | 'DOOR' | 'ANY_SENSOR';

/** 每小时客流系数（与门店客流仿真一致） */
const HOURLY = [0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.7, 0.9, 1, 1.1, 1.3, 1.4, 1.2, 1.1, 1.1, 1.3, 1.6, 1.7, 1.5, 1.2, 0.9, 0.6, 0.3];
/** 冷柜除霜：每 40 分钟一次，每次 2 分钟 */
const DEFROST_EVERY_MS = 40 * 60_000;
const DEFROST_MS = 2 * 60_000;

/**
 * 演示门店的设备仿真：
 * - 温度：在设定值附近小幅波动；员工往冷柜里放框、取框时开门，温度短暂上升；定时除霜；
 *   压缩机故障时温度持续升高（冷）或下降（热保温），修复后慢慢回到设定值；
 * - 卸货门：跟着收货单开关（到达后打开、收完关上）；故障「门没关」时一直开着；
 * - 客流：按门店时间的钟点变化。
 * 正常波动不会越过告警线，只有故障会触发告警。
 */
export class EquipmentSim {
  private readonly faults = new Map<string, FaultMode>();
  /** 开门造成的温度上升（°C，逐渐消退） */
  private readonly bump = new Map<string, number>();
  /** 故障造成的偏离（°C） */
  private readonly drift = new Map<string, number>();
  private readonly slotSensor = new Map<string, string>();
  /** 读数卡住的传感器一直报的那个数 */
  private readonly stuck = new Map<string, number>();
  private readonly rng: Rng;
  private last = 0;

  constructor(
    private readonly twin: TwinService,
    private readonly rt: StoreRuntime,
    private readonly storeHour?: () => number | undefined,
    seed = 7,
  ) {
    this.rng = createRng(seed);
    for (const d of twin.defs) for (const code of slotsOf(d, rt.statics)) this.slotSensor.set(code, d.id);
  }

  /** 开关冷柜门：放框、取框 */
  observe(events: readonly AnyOpsEvent[]): void {
    for (const e of events) {
      let code: string | undefined;
      if (e.type === 'ToteStaged') code = e.payload.slotCode;
      else if (e.type === 'ToteScannedForPrep') code = this.rt.state.totes[e.payload.toteId]?.slotCode;
      else if (e.type === 'ToteMoved') code = e.payload.to;
      const id = code ? this.slotSensor.get(code) : undefined;
      const def = id ? this.twin.defs.find((d) => d.id === id) : undefined;
      if (!id || !def?.limits) continue;
      // 冷藏每次开门 +0.35 °C、冷冻 +0.7 °C，热保温 −1 °C；累计有上限，正常作业不会越线
      // 门封漏气：每次开门回温是平时的 3 倍、上限更高
      const seal = this.faults.get(id) === 'SEAL' ? 3 : 1;
      const step = (def.tempZone === 'FROZEN' ? 0.7 : def.tempZone === 'HOT' ? -1 : 0.35) * seal;
      const cap = (def.tempZone === 'FROZEN' ? 1.5 : def.tempZone === 'HOT' ? -4 : 1) * seal;
      const next = (this.bump.get(id) ?? 0) + step;
      this.bump.set(id, step > 0 ? Math.min(cap, next) : Math.max(cap, next));
    }
  }

  step(now: number): void {
    const dt = this.last ? Math.min(30_000, now - this.last) : 2000;
    this.last = now;
    const decay = Math.exp(-dt / 90_000);
    // 门封漏气的设备回温消退得更慢
    const slowDecay = Math.exp(-dt / 270_000);
    const readings: Reading[] = [];
    const h = this.storeHour?.() ?? new Date(now).getHours() + new Date(now).getMinutes() / 60;
    const people = Math.round(Math.min(600, Math.max(20, this.rt.statics.roster.length * 4)) * (HOURLY[Math.floor(h) % 24] ?? 1) * (1 + (this.rng.next() - 0.5) * 0.12));
    for (const d of this.twin.defs) {
      const mode = this.faults.get(d.id);
      if (mode === 'OFFLINE') continue;
      if (mode === 'STUCK' && d.kind === 'TEMP') {
        // 读数卡住：一直报同一个数
        const v = this.stuck.get(d.id) ?? this.twin.telemetry.latest(d.id)?.value ?? d.limits?.nominal ?? 0;
        this.stuck.set(d.id, v);
        readings.push({ sensorId: d.id, at: now, value: v });
        continue;
      }
      if (d.kind === 'TEMP' && d.limits) {
        const L = d.limits;
        const b = (this.bump.get(d.id) ?? 0) * (mode === 'SEAL' ? slowDecay : decay);
        this.bump.set(d.id, b);
        let drift = this.drift.get(d.id) ?? 0;
        // 故障：冷的每 2 秒升 0.25 °C（约 1 分钟到严重线），热保温每 2 秒降 0.6 °C；修复后每 2 秒回落 15%
        if (mode === 'FAIL') drift = L.direction === 'MAX' ? Math.min(12, drift + (0.25 * dt) / 2000) : Math.max(-25, drift - (0.6 * dt) / 2000);
        // 制冷慢慢变差：冷的每 2 秒升 0.0035 °C（一分钟约 0.1 °C），热保温每 2 秒降 0.01 °C
        else if (mode === 'DEGRADE') drift = L.direction === 'MAX' ? Math.min(12, drift + (0.0035 * dt) / 2000) : Math.max(-25, drift - (0.01 * dt) / 2000);
        else if (mode === 'SEAL') drift = Math.min(0.6, drift + (0.0005 * dt) / 2000);
        else {
          drift *= Math.pow(0.85, dt / 2000);
          // 修复后回落到很小就归零（慢性故障每一步只升一点点，不能在这里被清掉）
          if (Math.abs(drift) < 0.05) drift = 0;
        }
        this.drift.set(d.id, drift);
        const phase = (now + this.offsetOf(d.id)) % DEFROST_EVERY_MS;
        const defrost = d.tempZone === 'HOT' ? 0 : phase < DEFROST_MS ? (d.tempZone === 'FROZEN' ? 3 : 0.8) * Math.sin((Math.PI * phase) / DEFROST_MS) : 0;
        const wave = 0.25 * Math.sin((2 * Math.PI * now) / (23 * 60_000) + this.offsetOf(d.id));
        const noise = (this.rng.next() - 0.5) * 0.3;
        readings.push({ sensorId: d.id, at: now, value: L.nominal + wave + noise + defrost + b + drift });
      } else if (d.kind === 'DOOR' && d.anchor.type === 'DOCK') {
        readings.push({ sensorId: d.id, at: now, value: mode === 'OPEN' || this.twin.dockBusy(d.anchor.index) ? 1 : 0 });
      } else if (d.kind === 'COUNT') {
        readings.push({ sensorId: d.id, at: now, value: people });
      }
    }
    this.twin.ingest(readings, now);
  }

  /** 每台设备的相位错开，曲线不会同步起伏 */
  private offsetOf(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100_003;
    return h * 997;
  }

  /** 按控制台的按钮找传感器 */
  resolve(target: string): SensorDef | undefined {
    const defs = this.twin.defs;
    const staging = (zone: string) => defs.find((d) => d.kind === 'TEMP' && d.tempZone === zone && d.anchor.type === 'AREA' && d.anchor.areaKind.startsWith('STAGING'));
    switch (target as FaultTarget) {
      case 'STAGING_CHILLED':
        return staging('CHILLED') ?? defs.find((d) => d.tempZone === 'CHILLED');
      case 'STAGING_FROZEN':
        return staging('FROZEN') ?? defs.find((d) => d.tempZone === 'FROZEN');
      case 'COOLER':
        return defs.find((d) => d.anchor.type === 'AREA' && d.anchor.areaKind === 'COOLER') ?? defs.find((d) => d.tempZone === 'CHILLED');
      case 'FREEZER':
        return defs.find((d) => d.anchor.type === 'AREA' && d.anchor.areaKind === 'FREEZER') ?? defs.find((d) => d.tempZone === 'FROZEN');
      case 'DOOR':
        return defs.filter((d) => d.kind === 'DOOR' && d.anchor.type === 'DOCK').find((d) => d.anchor.type === 'DOCK' && !this.twin.dockBusy(d.anchor.index));
      case 'ANY_SENSOR':
        return defs.find((d) => d.kind === 'COUNT');
      default:
        return defs.find((d) => d.id === target);
    }
  }

  /** 制造故障；返回受影响的传感器 */
  fault(target: string, mode: FaultMode = 'FAIL'): string | undefined {
    const d = this.resolve(target);
    if (!d) return undefined;
    this.faults.set(d.id, d.kind === 'DOOR' ? 'OPEN' : d.kind === 'COUNT' ? 'OFFLINE' : mode);
    this.stuck.delete(d.id);
    return d.id;
  }

  /** 修复故障：一个传感器、一类（按钮），或 ALL 全部；返回修复的传感器 */
  repair(target: string): string[] {
    const fixed: string[] = [];
    for (const id of [...this.faults.keys()]) {
      const d = this.twin.defs.find((x) => x.id === id);
      if (!d) continue;
      const preset = target as FaultTarget;
      const match =
        target === 'ALL' ||
        target === id ||
        (preset === 'DOOR' && d.kind === 'DOOR') ||
        (preset === 'ANY_SENSOR' && d.kind === 'COUNT') ||
        (preset !== 'DOOR' && preset !== 'ANY_SENSOR' && this.resolve(target)?.id === id);
      if (!match) continue;
      this.faults.delete(id);
      fixed.push(id);
    }
    return fixed;
  }

  clearFaults(): void {
    this.faults.clear();
  }

  faultList(): string[] {
    return [...this.faults.keys()];
  }
}
