import { describe, expect, it } from 'vitest';
import type { AnyOpsEvent, StoreStatic } from '@storewright/ops';
import { applyEvent, emptyState } from '@storewright/ops';
import { addFidelity, assessDegradation, DEFAULT_DEGRADATION, DEMO_DEGRADATION, DEMO_RULES, ReplayLog, RuleEngine, TelemetryStore, TEMP_LIMITS, type SensorDef } from './index';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 23, 9, 0, 0);

const cooler: SensorDef = { id: 'T-COOLER-1', kind: 'TEMP', anchor: { type: 'AREA', areaId: 'COOLER-1', areaKind: 'COOLER' }, tempZone: 'CHILLED', intervalSec: 10, limits: TEMP_LIMITS.CHILLED };
const hot: SensorDef = { id: 'T-HOT-1', kind: 'TEMP', anchor: { type: 'AREA', areaId: 'HOT-1', areaKind: 'HOT_HOLD' }, tempZone: 'HOT', intervalSec: 10, limits: TEMP_LIMITS.HOT };
const door: SensorDef = { id: 'D-DOOR-1', kind: 'DOOR', anchor: { type: 'DOCK', dockId: 'DOOR-1', index: 0 }, intervalSec: 10 };

describe('telemetry store (decision 0016)', () => {
  it('keeps the latest reading and one-minute buckets; answers values at any past moment', () => {
    const ts = new TelemetryStore();
    expect(ts.ingest({ sensorId: 'a', at: T0, value: 3 })).toBe(true);
    expect(ts.ingest({ sensorId: 'a', at: T0 + 20_000, value: 5 })).toBe(true);
    expect(ts.ingest({ sensorId: 'a', at: T0 + MIN + 5_000, value: 4 })).toBe(true);
    expect(ts.ingest({ sensorId: 'a', at: T0 + 30_000, value: Number.NaN })).toBe(false);
    const b = ts.range('a', T0, T0 + 2 * MIN);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ t: T0, min: 3, max: 5, avg: 4, last: 5, n: 2 });
    // 晚到的读数放进它所在的那一分钟，不改变最新读数
    expect(ts.ingest({ sensorId: 'a', at: T0 - MIN + 1000, value: 1 })).toBe(true);
    expect(ts.range('a', T0 - MIN, T0 + 2 * MIN).map((x) => x.t)).toEqual([T0 - MIN, T0, T0 + MIN]);
    expect(ts.latest('a')?.value).toBe(4);
    expect(ts.valueAt('a', T0 - 2 * MIN)).toBeUndefined();
    expect(ts.valueAt('a', T0 - 1)).toBe(1);
    // 最近 60 分钟内精确到读数
    expect(ts.valueAt('a', T0 + 10_000)).toBe(3);
    expect(ts.valueAt('a', T0 + 30_000)).toBe(5);
    expect(ts.valueAt('a', T0 + 10 * MIN)).toBe(4);
    expect(ts.firstAt()).toBe(T0 - MIN);
    // 超过保留期的读数不收
    expect(ts.ingest({ sensorId: 'a', at: T0 - 25 * 60 * MIN, value: 1 })).toBe(false);
  });

  it('drops buckets older than the retention window', () => {
    const ts = new TelemetryStore(3);
    for (let i = 0; i < 6; i++) ts.ingest({ sensorId: 'a', at: T0 + i * MIN, value: i });
    expect(ts.range('a', 0, T0 + 10 * MIN).map((x) => x.last)).toEqual([3, 4, 5]);
  });
});

describe('alert rules (decision 0016)', () => {
  const feed = (ts: TelemetryStore, id: string, from: number, to: number, value: number | ((t: number) => number)) => {
    for (let t = from; t <= to; t += 10_000) ts.ingest({ sensorId: id, at: t, value: typeof value === 'number' ? value : value(t) });
  };

  it('a chilled unit above 5 °C alarms only after the breach lasts; above 8 °C it alarms at once; it clears after recovering', () => {
    const ts = new TelemetryStore();
    const eng = new RuleEngine([cooler], { ...DEMO_RULES, breachMin: 10, clearSec: 180 });
    feed(ts, cooler.id, T0, T0 + 5 * MIN, 3.1);
    expect(eng.evaluate(ts, T0 + 5 * MIN).evals[0]?.status).toBe('OK');
    feed(ts, cooler.id, T0 + 5 * MIN + 10_000, T0 + 12 * MIN, 5.6);
    let r = eng.evaluate(ts, T0 + 12 * MIN);
    expect(r.raise).toEqual([]);
    expect(r.evals[0]?.status).toBe('WARN');
    feed(ts, cooler.id, T0 + 12 * MIN + 10_000, T0 + 16 * MIN, 5.6);
    r = eng.evaluate(ts, T0 + 16 * MIN);
    expect(r.raise).toMatchObject([{ sensorId: cooler.id, kind: 'TEMP_HIGH', severity: 'ALARM', limit: 5 }]);
    expect(r.evals[0]?.status).toBe('ALARM');
    // 已经告警的不重复发
    expect(eng.evaluate(ts, T0 + 16 * MIN).raise).toEqual([]);
    feed(ts, cooler.id, T0 + 16 * MIN + 10_000, T0 + 18 * MIN, 3);
    expect(eng.evaluate(ts, T0 + 18 * MIN).clear).toEqual([]);
    feed(ts, cooler.id, T0 + 18 * MIN + 10_000, T0 + 20 * MIN, 3);
    expect(eng.evaluate(ts, T0 + 20 * MIN).clear).toEqual([{ sensorId: cooler.id, kind: 'TEMP_HIGH', peak: 5.6 }]);

    const ts2 = new TelemetryStore();
    const eng2 = new RuleEngine([cooler], { ...DEMO_RULES, breachMin: 10 });
    feed(ts2, cooler.id, T0, T0 + 20_000, 8.4);
    expect(eng2.evaluate(ts2, T0 + 20_000).raise.map((x) => x.kind)).toEqual(['TEMP_HIGH']);
  });

  it('the breach starts at the first reading over the limit, not at the start of that minute', () => {
    const ts = new TelemetryStore();
    const eng = new RuleEngine([cooler], { ...DEMO_RULES, breachMin: 1 });
    // 3 °C 到 :45 秒，之后 5.5 °C：越线从 :50 开始，1 分钟后（下一分钟的 :50）才告警
    feed(ts, cooler.id, T0, T0 + 40_000, 3);
    feed(ts, cooler.id, T0 + 50_000, T0 + MIN + 40_000, 5.5);
    expect(eng.evaluate(ts, T0 + MIN + 40_000).raise).toEqual([]);
    feed(ts, cooler.id, T0 + MIN + 50_000, T0 + MIN + 50_000, 5.5);
    expect(eng.evaluate(ts, T0 + MIN + 50_000).raise).toMatchObject([{ kind: 'TEMP_HIGH', since: T0 + 50_000 }]);
  });

  it('hot holding alarms when it drops below 57 °C', () => {
    const ts = new TelemetryStore();
    const eng = new RuleEngine([hot], DEMO_RULES);
    feed(ts, hot.id, T0, T0 + 30_000, 49);
    expect(eng.evaluate(ts, T0 + 30_000).raise).toMatchObject([{ kind: 'TEMP_LOW', limit: 57 }]);
  });

  it('a dock door open without receiving warns after the limit; receiving makes it normal', () => {
    const ts = new TelemetryStore();
    const eng = new RuleEngine([door], { ...DEMO_RULES, doorOpenMaxMin: 2 });
    let busy = true;
    feed(ts, door.id, T0, T0 + 5 * MIN, 1);
    expect(eng.evaluate(ts, T0 + 5 * MIN, { dockBusy: () => busy }).raise).toEqual([]);
    busy = false;
    feed(ts, door.id, T0 + 5 * MIN + 10_000, T0 + 6 * MIN, 1);
    expect(eng.evaluate(ts, T0 + 6 * MIN, { dockBusy: () => busy }).evals[0]?.status).toBe('WARN');
    feed(ts, door.id, T0 + 6 * MIN + 10_000, T0 + 8 * MIN, 1);
    expect(eng.evaluate(ts, T0 + 8 * MIN, { dockBusy: () => busy }).raise.map((x) => x.kind)).toEqual(['DOOR_OPEN']);
    feed(ts, door.id, T0 + 8 * MIN + 10_000, T0 + 8 * MIN + 10_000, 0);
    expect(eng.evaluate(ts, T0 + 8 * MIN + 10_000, { dockBusy: () => busy }).clear.map((x) => x.kind)).toEqual(['DOOR_OPEN']);
  });

  it('a silent sensor goes stale, then raises an offline warning; a new reading clears it', () => {
    const ts = new TelemetryStore();
    const eng = new RuleEngine([cooler], { ...DEMO_RULES, offlineAlertMin: 2 });
    ts.ingest({ sensorId: cooler.id, at: T0, value: 3 });
    expect(eng.evaluate(ts, T0 + 60_000).evals[0]?.status).toBe('STALE');
    expect(eng.evaluate(ts, T0 + 60_000).raise).toEqual([]);
    expect(eng.evaluate(ts, T0 + 3 * MIN).raise.map((x) => x.kind)).toEqual(['SENSOR_OFFLINE']);
    ts.ingest({ sensorId: cooler.id, at: T0 + 3 * MIN + 1000, value: 3 });
    expect(eng.evaluate(ts, T0 + 3 * MIN + 2000).clear.map((x) => x.kind)).toEqual(['SENSOR_OFFLINE']);
  });

  it('alerts already in the operations state are adopted after a restart', () => {
    const ts = new TelemetryStore();
    const eng = new RuleEngine([cooler], DEMO_RULES);
    eng.adopt(cooler.id, 'TEMP_HIGH');
    feed(ts, cooler.id, T0, T0 + 3 * MIN, 9);
    expect(eng.evaluate(ts, T0 + 3 * MIN).raise).toEqual([]);
  });

  it('fidelity counts a count within one unit as matching', () => {
    const f = { checks: 0, withinOne: 0 };
    addFidelity(f, 10, 9);
    addFidelity(f, 10, 7);
    expect(f).toEqual({ checks: 2, withinOne: 1 });
  });
});

describe('replay (decision 0016)', () => {
  const statics = { roster: [], slots: [], bins: [], planogram: [] } as unknown as StoreStatic;
  const note = (seq: number, at: number): AnyOpsEvent => ({ seq, at, type: 'NoteAdded', actor: 'A01', payload: { noteId: `N${seq}`, text: `note ${seq}`, tags: [] } });

  it('rebuilds the store at any moment from the event log, with checkpoints', () => {
    const log = new ReplayLog(statics, 3, 2);
    const events = Array.from({ length: 20 }, (_, i) => note(i + 1, T0 + i * MIN));
    log.append(events.slice(0, 7));
    log.append(events.slice(5));
    expect(log.size).toBe(20);
    expect(log.firstAt).toBe(T0);
    for (const k of [0, 1, 2, 3, 6, 7, 12, 19]) {
      const s = log.stateAt(T0 + k * MIN + 30_000);
      expect(Object.keys(s.notes).length).toBe(k + 1);
      expect(s.seq).toBe(k + 1);
    }
    expect(Object.keys(log.stateAt(T0 - 1).notes)).toEqual([]);
    // 返回的是副本：修改它不影响之后的回放
    const s = log.stateAt(T0 + 30 * MIN);
    delete s.notes.N1;
    expect(log.stateAt(T0 + 30 * MIN).notes.N1).toBeDefined();
    expect(log.between(T0 + 5 * MIN, T0 + 8 * MIN).map((e) => e.seq)).toEqual([7, 8, 9]);
  });

  it('checkpoints are rate-limited in time, so heavy load does not copy the whole state over and over', () => {
    const fast = new ReplayLog(statics, 3, 16, 150_000, 60_000, 50);
    // 1 秒一条：每 3 条够了数量，但离上一个检查点不到 1 分钟时不存
    fast.append(Array.from({ length: 200 }, (_, i) => note(i + 1, T0 + i * 1000)));
    const cps = (fast as unknown as { checkpoints: Array<{ index: number }> }).checkpoints.map((c) => c.index);
    expect(cps.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < cps.length; i++) expect((cps[i] as number) - (cps[i - 1] as number)).toBeGreaterThanOrEqual(50);
    expect(Object.keys(fast.stateAt(T0 + 150_500).notes).length).toBe(151);
  });

  it('live appends reuse the runtime state instead of applying events twice', () => {
    const events = Array.from({ length: 12 }, (_, i) => note(i + 1, T0 + i * MIN));
    const live = new ReplayLog(statics, 3, 16);
    // 「门店运行时」：每批事件先应用到它的状态，再交给回放日志
    const runtime = emptyState();
    for (let i = 0; i < events.length; i += 4) {
      const batch = events.slice(i, i + 4);
      for (const e of batch) applyEvent(runtime, e, statics);
      live.append(batch, () => runtime);
    }
    for (const k of [0, 3, 5, 9, 11]) expect(Object.keys(live.stateAt(T0 + k * MIN + 30_000).notes).length).toBe(k + 1);
    // 现在的状态是运行时状态的副本
    const now = live.stateAt(T0 + 60 * MIN);
    expect(now).toEqual(runtime);
    expect(now).not.toBe(runtime);
  });

  it('caps memory: the oldest events fold into a base state, replay of the retained window stays exact', () => {
    const log = new ReplayLog(statics, 4, 8, 12);
    log.append(Array.from({ length: 20 }, (_, i) => note(i + 1, T0 + i * MIN)));
    expect(log.size).toBeLessThanOrEqual(12);
    expect(log.firstAt).toBeGreaterThan(T0);
    for (const k of [9, 12, 15, 19]) expect(Object.keys(log.stateAt(T0 + k * MIN + 30_000).notes).length).toBe(k + 1);
    // 早于保留窗口的时刻：得到并入后的起点状态
    expect(Object.keys(log.stateAt(T0).notes).length).toBe(20 - log.size);
  });
});

describe('预测性维护（决策记录 0022 · E1）', () => {
  const def: SensorDef = { id: 'T-COOLER-1', kind: 'TEMP', anchor: { type: 'AREA', areaId: 'A', areaKind: 'COOLER' }, tempZone: 'CHILLED', intervalSec: 2, limits: { direction: 'MAX', nominal: 3, limit: 5, critical: 8 } };
  const T = Date.UTC(2026, 9, 20, 12);
  /** 每分钟一个汇总：底线 base(k)，每隔几分钟开一次门（最高读数高出 bump） */
  const series = (n: number, base: (k: number) => number, bump = 0.6, noise = 0.15) =>
    Array.from({ length: n }, (_, k) => {
      const b = base(k);
      const hi = b + (k % 3 === 0 ? bump : noise);
      return { t: T + k * 60_000, min: b, max: hi, avg: (b + hi) / 2, last: b + noise / 2, n: 30 };
    });

  it('平时的设备是正常；底线温度慢慢升高时给出风险和预计多久越线；读数卡住时单独报出', () => {
    const ok = assessDegradation(def, series(12, () => 3), T + 12 * 60_000, DEMO_DEGRADATION);
    expect(ok.status).toBe('OK');
    // 一分钟升 0.1 °C（每小时 6 °C）：从 3.6 °C 到 5 °C 还有约 14 分钟
    const bad = assessDegradation(def, series(12, (k) => 2.5 + 0.1 * k), T + 12 * 60_000, DEMO_DEGRADATION);
    expect(bad.status).toBe('RISK');
    expect(bad.slopePerHour).toBeGreaterThan(4);
    expect(bad.etaMin).toBeGreaterThan(5);
    expect(bad.etaMin).toBeLessThan(30);
    expect(bad.etaLow as number).toBeLessThanOrEqual(bad.etaMin as number);
    expect(bad.reasons.map((r) => r.factor)).toContain('ETA_LIMIT');
    // 读数卡住：前面有正常波动，最近几分钟一点不变
    const s = series(12, () => 3);
    for (const b of s.slice(-4)) Object.assign(b, { min: 3.2, max: 3.2, avg: 3.2, last: 3.2 });
    expect(assessDegradation(def, s, T + 12 * 60_000, DEMO_DEGRADATION).status).toBe('STUCK');
  });

  it('开门回温明显变大（门封漏气）时留意；真实门店的参数按小时看趋势', () => {
    const s = series(12, () => 3, 0.4).map((b, k) => (k >= 6 ? { ...b, max: b.min + (k % 3 === 0 ? 1.8 : 1.2) } : b));
    const r = assessDegradation(def, s, T + 12 * 60_000, DEMO_DEGRADATION);
    expect(r.status).toBe('WATCH');
    expect(r.reasons.map((x) => x.factor)).toContain('DOOR_RECOVERY');
    // 真实门店：6 小时里每小时升 0.4 °C，现在约 4 °C，大约 2.5 小时后越线 → 在 12 小时的提前量之内
    const slow = Array.from({ length: 360 }, (_, k) => ({ t: T + k * 60_000, min: 1.6 + (0.4 * k) / 60, max: 1.9 + (0.4 * k) / 60, avg: 1.75 + (0.4 * k) / 60, last: 1.7, n: 30 }));
    const real = assessDegradation(def, slow, T + 360 * 60_000, DEFAULT_DEGRADATION);
    expect(real.status).toBe('RISK');
    expect(real.etaMin).toBeGreaterThan(30);
  });
});

describe('打烊复盘与反事实归因（决策记录 0024 · F3）', () => {
  it('单量比预测多、少一名拣货员、拣货比标准慢：Shapley 值加起来等于复刻的迟到减去全都正常时的迟到；没有扰动的因素分到 0', async () => {
    const { attributeLate, replayLate } = await import('./review');
    const slots = Array.from({ length: 8 }, (_, k) => ({ start: (11 + k) * 60, orders: k === 5 ? 34 : 14, forecast: 14, pickers: k >= 4 ? 2 : 3, scheduled: 3 }));
    const day = { slots, perOrderMin: 8, pace: 1.2 };
    const all = replayLate(day);
    const none = replayLate(day, new Set(['DEMAND', 'STAFF', 'PACE'] as const));
    expect(all).toBeGreaterThan(none);
    const r = attributeLate(day);
    expect(r.replay).toBe(all);
    expect(r.baseline).toBe(none);
    const sum = r.factors.DEMAND + r.factors.STAFF + r.factors.PACE;
    expect(Math.abs(sum - (all - none))).toBeLessThan(0.21);
    expect(r.factors.DEMAND).toBeGreaterThan(0);
    expect(r.factors.STAFF).toBeGreaterThan(0);
    // 拣货按标准快慢：PACE 分到 0
    const r2 = attributeLate({ ...day, pace: 1 });
    expect(r2.factors.PACE).toBe(0);
  });
});
