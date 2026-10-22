import { describe, expect, it } from 'vitest';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateDemandHistory, historyDailyHours } from '@storewright/synth';
import {
  aggregateForecast,
  backtest,
  BASELINES,
  brier,
  calibration,
  confidenceFromInterval,
  coverage,
  expectedCalibrationError,
  FORECAST_GATE,
  hourlySeries,
  mae,
  ModelRegistry,
  rankReasons,
  seasonalEs,
  seasonalNaive,
  sliceMetrics,
  usualLevel,
  wape,
  withDerived,
  type ModelVersion,
} from './index';

const model = new StoreModel(createTemplate('medium'));
const history = generateDemandHistory(model, { seed: 11, days: 112, startDate: '2025-06-02', scenario: DEFAULT_DEMAND.medium });
const series = hourlySeries(historyDailyHours(history), history.hours);

describe('metrics', () => {
  it('computes standard forecast and probability metrics', () => {
    expect(mae([1, 2, 3], [2, 2, 5])).toBe(1);
    expect(wape([10, 0, 10], [12, 1, 7])).toBeCloseTo(6 / 20);
    expect(coverage([1, 5, 9], [0, 6, 8], [2, 7, 10])).toBeCloseTo(2 / 3);
    expect(brier([1, 0, 0.5], [1, 0, 1])).toBeCloseTo(0.25 / 3);
    const cal = calibration([0.05, 0.15, 0.95, 0.92], [0, 0, 1, 1], 10);
    expect(cal.map((b) => b.n)).toEqual([1, 1, 2]);
    expect(expectedCalibrationError([0.9, 0.9, 0.1, 0.1], [1, 1, 0, 0])).toBeCloseTo(0.1);
    expect(Number.isNaN(mae([], []))).toBe(true);
  });
});

describe('recommendation helpers', () => {
  it('ranks reasons by weight or effect size', () => {
    const r = rankReasons(
      [
        { factor: 'A', effect: { kind: 'MULTIPLY', amount: 1.05 }, weight: 0 },
        { factor: 'B', effect: { kind: 'MULTIPLY', amount: 0.5 }, weight: 0 },
        { factor: 'C', effect: { kind: 'MULTIPLY', amount: 1.3 }, weight: 0 },
        { factor: 'D', effect: { kind: 'MULTIPLY', amount: 1 }, weight: 0 },
      ],
      3,
    );
    expect(r.map((x) => x.factor)).toEqual(['B', 'C', 'A']);
    expect(r.reduce((a, b) => a + b.weight, 0)).toBeCloseTo(1, 2);
    expect(confidenceFromInterval(100, 90, 110)).toBeGreaterThan(confidenceFromInterval(100, 60, 140));
  });
});

describe('baseline forecasters', () => {
  it('backtest on synthetic history: smoothing beats last week, intervals are calibrated', () => {
    const opts = { initialDays: 56, horizonDays: 7, stepDays: 7 };
    const res = Object.fromEntries(Object.values(BASELINES).map((m) => [m.kind, backtest(series, m, opts)]));
    const naive = res['seasonal-naive']?.metrics.wape as number;
    const es = res['seasonal-es']?.metrics.wape as number;
    const how = res['hour-of-week-mean-4']?.metrics.wape as number;
    expect(es).toBeLessThan(naive);
    expect(how).toBeLessThan(naive);
    expect(res['seasonal-es']?.folds.length).toBe(8);
    for (const r of Object.values(res)) {
      expect(r.metrics.coverage80).toBeGreaterThan(0.65);
      expect(r.metrics.coverage80).toBeLessThan(0.95);
    }
    // 只看本地活动发生的日子：隐藏因素下误差更大
    const eventDays = new Set(history.days.filter((d) => d.hidden.localEvent !== 1).map((d) => d.day));
    const sliced = sliceMetrics(res['seasonal-es'] as NonNullable<(typeof res)['seasonal-es']>, (p) => eventDays.has(p.day));
    if (sliced.n) expect(sliced.wape).toBeGreaterThan(es);
  });

  it('parameters are plain JSON and predictions explain themselves', () => {
    const params = seasonalEs.fit(series);
    const restored = JSON.parse(JSON.stringify(params)) as typeof params;
    const future = history.hours.map((hour) => ({ day: 112, dow: 1, hour }));
    expect(seasonalEs.predict(restored, future)).toEqual(seasonalEs.predict(params, future));
    const [p] = seasonalEs.predict(params, [{ day: 112, dow: 6, hour: 11 }]);
    expect(p?.reasons.map((r) => r.factor)).toContain('WEEKDAY_FACTOR');
    expect(p && p.low <= p.mean && p.mean <= p.high).toBe(true);
    const naive = seasonalNaive.predict(seasonalNaive.fit(series), [{ day: 112, dow: 1, hour: 10 }]);
    expect(naive[0]?.mean).toBe(series.filter((s) => s.dow === 1 && s.hour === 10).at(-1)?.y);
  });

  it('aggregates hours into a window', () => {
    const params = seasonalEs.fit(series);
    const pts = seasonalEs.predict(params, [10, 11, 12].map((hour) => ({ day: 112, dow: 1, hour })));
    const w = aggregateForecast(pts);
    expect(w.mean).toBeCloseTo(pts.reduce((a, p) => a + p.mean, 0), 1);
    const sumHalf = pts.reduce((a, p) => a + (p.high - p.low) / 2, 0);
    expect((w.high - w.low) / 2).toBeLessThan(sumHalf);
    expect(w.reasons.find((r) => r.factor === 'HOUR_SHARE')?.value).toBeCloseTo(pts.reduce((a, p) => a + (p.reasons.find((r) => r.factor === 'HOUR_SHARE')?.value ?? 0), 0), 1);
    expect(usualLevel(series, 1, 10)).toBeGreaterThan(0);
  });
});

describe('model registry', () => {
  const version = (wapeValue: number, bias = 0.1, cov = 0.8): Omit<ModelVersion, 'version' | 'status'> => ({
    id: 'orders-hourly',
    kind: 'seasonal-es',
    trainedAt: 0,
    data: { source: 'SIM', days: 84 },
    metrics: withDerived({ wape: wapeValue, bias, coverage80: cov }),
    params: {},
  });

  it('promotes through the gate, rejects worse candidates and rolls back', () => {
    const reg = new ModelRegistry();
    const v1 = reg.register(version(0.3));
    expect(reg.promote(v1.id, v1.version, FORECAST_GATE, 1).passed).toBe(true);
    expect(reg.champion('orders-hourly')?.version).toBe(1);

    const worse = reg.register(version(0.31));
    const g = reg.promote(worse.id, worse.version, FORECAST_GATE, 2);
    expect(g.passed).toBe(false);
    expect(g.checks[0]).toMatchObject({ metric: 'wape', rule: 'PRIMARY', ok: false });
    expect(reg.get('orders-hourly', 2)?.status).toBe('REJECTED');

    // 主指标更好但偏差明显变大：护栏拦下
    const biased = reg.register(version(0.25, 2));
    expect(reg.promote(biased.id, biased.version, FORECAST_GATE, 3).passed).toBe(false);

    const better = reg.register(version(0.27));
    expect(reg.promote(better.id, better.version, FORECAST_GATE, 4).passed).toBe(true);
    expect(reg.champion('orders-hourly')?.version).toBe(4);
    expect(reg.get('orders-hourly', 1)?.status).toBe('RETIRED');

    const restored = new ModelRegistry(JSON.parse(JSON.stringify(reg.toJSON())));
    expect(restored.rollback('orders-hourly', 5)?.version).toBe(1);
    expect(restored.get('orders-hourly', 4)).toMatchObject({ status: 'RETIRED', note: 'ROLLED_BACK' });
    expect(restored.rollback('orders-hourly', 6)).toBeUndefined();
    expect(restored.champion('orders-hourly')?.version).toBe(1);
  });
});

describe('GLM and the feature-based demand model (5b)', () => {
  it('recovers known Poisson and logistic coefficients', async () => {
    const { fitGlm } = await import('./glm');
    const { createRng } = await import('@storewright/domain');
    const rng = createRng(4);
    const X: number[][] = [];
    const yp: number[] = [];
    const yl: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const a = rng.chance(0.3) ? 1 : 0;
      const b = rng.uniform(-1, 1);
      X.push([1, a, b]);
      yp.push(rng.poisson(Math.exp(2 + 0.4 * a - 0.3 * b)));
      yl.push(rng.chance(1 / (1 + Math.exp(-(-0.5 + 1.2 * a + 0.8 * b)))) ? 1 : 0);
    }
    const p = fitGlm(X, yp, { family: 'poisson' });
    expect(p.converged).toBe(true);
    expect(p.beta[0]).toBeCloseTo(2, 1);
    expect(p.beta[1]).toBeCloseTo(0.4, 1);
    expect(p.beta[2]).toBeCloseTo(-0.3, 1);
    const l = fitGlm(X, yl, { family: 'logistic' });
    expect(l.beta[1]).toBeCloseTo(1.2, 0);
    expect(l.beta[2]).toBeCloseTo(0.8, 0);
    // 正则把系数拉向 0
    const shrunk = fitGlm(X, yp, { family: 'poisson', lambda: 1e6, penalize: [false, true, true] });
    expect(Math.abs(shrunk.beta[1] as number)).toBeLessThan(0.05);
  });

  it('uses known special days: beats smoothing on holidays and storm warnings, explains the effects', async () => {
    const { featureGlm } = await import('./demand');
    const long = generateDemandHistory(model, { seed: 21, days: 420, startDate: '2024-01-01', scenario: DEFAULT_DEMAND.medium });
    const s = hourlySeries(historyDailyHours(long), long.hours);
    const known = new Set(long.days.filter((d) => d.observed.holiday || d.observed.holidayEve || d.observed.stormWarningTomorrow).map((d) => d.day));
    const opts = { initialDays: 300, horizonDays: 7, stepDays: 7 };
    const glm = backtest(s, featureGlm(), opts);
    const es = backtest(s, seasonalEs, opts);
    const k = (r: typeof glm) => sliceMetrics(r, (p) => known.has(p.day));
    expect(k(glm).n).toBeGreaterThan(0);
    expect(k(glm).wape).toBeLessThan((k(es).wape as number) * 0.8);
    expect(glm.metrics.wape).toBeLessThan(es.metrics.wape as number);

    const params = featureGlm().fit(s);
    const eve = long.days.find((d) => d.observed.holidayEve && d.date.endsWith('-11-27'));
    expect(eve).toBeDefined();
    const [p] = featureGlm().predict(params, [{ day: eve!.day, dow: eve!.dow, hour: 11, x: eve!.x }]);
    const r = p?.reasons.find((x) => x.factor === 'HOLIDAY_EVE');
    expect(r?.params?.code).toBe('THANKSGIVING');
    expect(r?.effect?.amount).toBeGreaterThan(1.3);
    expect(JSON.parse(JSON.stringify(params))).toEqual(params);
  });
});

describe('ETA correction (5b)', () => {
  it('customer habits and rush-hour effects beat the navigation estimate', async () => {
    const { generateArrivals } = await import('@storewright/synth');
    const { evaluateEta, predictEta } = await import('./eta');
    const h = generateDemandHistory(model, { seed: 8, days: 90, startDate: '2025-05-01', scenario: DEFAULT_DEMAND.medium });
    const arr = generateArrivals({ seed: 8, history: h });
    const samples = arr.map((a) => ({ t: a.t, customer: a.customer, reportedMin: a.reportedMin, actualMin: a.actualMin, hour: a.hour, dow: a.dow, x: a.x }));
    const rep = evaluateEta(samples, 'eta-reported');
    const fix = evaluateEta(samples, 'eta-fixed');
    const hier = evaluateEta(samples, 'eta-hierarchical');
    expect(fix.metrics.mae).toBeLessThan(rep.metrics.mae as number);
    expect(hier.metrics.mae).toBeLessThan((rep.metrics.mae as number) * 0.8);
    expect(Math.abs(hier.metrics.bias as number)).toBeLessThan(0.5);
    expect(hier.metrics.coverage80).toBeGreaterThan(0.72);
    expect(hier.params.beta[2]).toBeGreaterThan(0); // 高峰时段比导航说的更慢
    // 一位总是晚到的老顾客：修正值明显晚于导航
    const late = arr.find((a) => a.hidden.bias > 6 && (hier.params.customers[a.customer]?.n ?? 0) >= 5);
    expect(late).toBeDefined();
    const s = samples.find((x) => x.customer === late!.customer)!;
    const p = predictEta(hier.params, { ...s, reportedMin: 10, x: { rush: 0, weekend: 0, rainHeavy: 0, forecastRainMm: 0 } });
    expect(p.mean).toBeGreaterThan(14);
    expect(p.reasons.find((r) => r.factor === 'CUSTOMER_HABIT')?.params?.visits).toBeGreaterThanOrEqual(5);
  });
});

describe('sellable probability and risk-based counting (5b)', () => {
  it('learns phantom stock from sales silence better than the naive rule, with good calibration', async () => {
    const { generateShelfTruth } = await import('@storewright/synth');
    const { evaluateAvailability, predictAvailability, auc } = await import('./index');
    const rows = generateShelfTruth({ seed: 5, items: 120, days: 40 });
    expect(rows.some((r) => r.phantom)).toBe(true);
    const r = evaluateAvailability(rows);
    const { system, bayes, logistic } = r.metrics as Record<string, Record<string, number>>;
    expect(logistic!.brier).toBeLessThan(system!.brier as number);
    expect(logistic!.auc).toBeGreaterThan(bayes!.auc as number);
    expect(logistic!.ece).toBeLessThan(0.02);
    expect(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBeCloseTo(0.75);
    // 长时间该卖没卖：几乎可以肯定不在架上，理由排第一的是「沉默」
    const quiet = predictAvailability(r.params, { est: 30, velocity: 3, expectedSinceSale: 15, hoursSinceSale: 5, hoursSinceConfirm: 5 });
    expect(quiet.pAvailable).toBeLessThan(0.2);
    expect(quiet.reasons[0]?.factor).toBe('NO_SALES');
    const busy = predictAvailability(r.params, { est: 30, velocity: 3, expectedSinceSale: 0.5, hoursSinceSale: 0.2, hoursSinceConfirm: 5 });
    expect(busy.pAvailable).toBeGreaterThan(0.95);
  });

  it('risk-ranked counting leaves fewer inaccurate records than the ABC schedule with the same budget', async () => {
    const { keyedUniform } = await import('@storewright/domain');
    const { abcPolicy, fitCountRisk, makeCountItems, riskPolicy, simulateCounting, predictCountRisk } = await import('./index');
    const uniform = (s: string, k: string) => keyedUniform(2, s, k);
    const items = makeCountItems(250, uniform);
    const warm = simulateCounting({ items, days: 90, budget: 8, uniform, policyFor: () => abcPolicy });
    const params = fitCountRisk(warm.samples);
    const base = simulateCounting({ items, days: 180, budget: 8, uniform, policyFor: () => abcPolicy, measureFrom: 90 });
    const risk = simulateCounting({ items, days: 180, budget: 8, uniform, policyFor: (d) => (d < 90 ? abcPolicy : riskPolicy(params)), measureFrom: 90 });
    expect(risk.counts).toBe(base.counts);
    expect(risk.avgInaccurate).toBeLessThan(base.avgInaccurate);
    const suspect = predictCountRisk(params, { daysSinceCount: 10, movesSinceCount: 4, discrepancy: false, suspect: true, damaged: 0, velocity: 1 });
    expect(suspect.p).toBeGreaterThan(0.8);
    expect(suspect.reasons[0]?.factor).toBe('SUSPECT');
  });
});

describe('substitution ranking (5c)', () => {
  it('learned ranking beats the name rule and nearly reaches the oracle', async () => {
    const { generateCatalog, generateSubstitutionEvents } = await import('@storewright/synth');
    const { evaluateSubstitution, rankSubstitutes } = await import('./index');
    const cat = generateCatalog(model, { seed: 7 });
    const logs = generateSubstitutionEvents(cat.items, { seed: 4, events: 2500 });
    const r = evaluateSubstitution(logs, cat.byId);
    const m = r.metrics as Record<string, Record<string, number>>;
    expect(m.learned!.acceptTop1).toBeGreaterThan((m.rule!.acceptTop1 as number) + 0.02);
    expect(m.learned!.acceptTop1).toBeGreaterThan(m.similarity!.acceptTop1 as number);
    expect(m.learned!.acceptTop1).toBeLessThanOrEqual(m.oracle!.acceptTop1 as number);
    expect(m.learned!.ndcg3).toBeGreaterThan(0.95);
    // 一件有机商品：非有机候选排在后面，理由里有「不是有机」
    const o = cat.items.find((i) => i.attributes.organic === true && cat.items.some((c) => c.categoryId === i.categoryId && c.attributes.organic !== true && c.id !== i.id));
    const cands = cat.items.filter((c) => c.categoryId === o!.categoryId && c.tempZone === o!.tempZone && c.id !== o!.id);
    const ranked = rankSubstitutes(r.params, o!, cands, cands.length);
    const firstNonOrganic = ranked.find((x) => x.item.attributes.organic !== true);
    expect(firstNonOrganic?.reasons.map((x) => x.factor)).toContain('ORGANIC_DOWNGRADE');
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]!.p).toBeGreaterThanOrEqual(ranked[i]!.p);
  });
});

describe('staffing (5c)', () => {
  it('reallocates the same total hours to follow forecast workload', async () => {
    const { allocateHours, planStaffing, workloadByHour, erlangCWait } = await import('./index');
    const a = allocateHours([0, 10, 30, 60, 0], 12, [1, 1, 1, 1, 0]);
    expect(a.reduce((x, y) => x + y, 0)).toBe(12);
    expect(a[3]).toBeGreaterThan(a[1] as number);
    expect(a[4]).toBe(0);
    const orders = new Array<number>(24).fill(0);
    for (let h = 9; h <= 20; h++) orders[h] = h >= 16 && h <= 18 ? 40 : 15;
    const cur: Record<'pick' | 'stage' | 'handoff', number[]> = { pick: Array.from({ length: 24 }, (_, h) => (h >= 7 && h <= 20 ? 6 : 0)), stage: Array.from({ length: 24 }, (_, h) => (h >= 7 && h <= 20 ? 1 : 0)), handoff: Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 21 ? 3 : 0)) };
    const { plan, workload } = planStaffing(orders, cur);
    for (const r of ['pick', 'stage', 'handoff'] as const) expect(plan[r].reduce((x, y) => x + y, 0)).toBe((cur[r] as number[]).reduce((x: number, y: number) => x + y, 0));
    // 交付人手集中到 16–18 点；拣货在高峰前 2 小时
    expect(plan.handoff[17]).toBeGreaterThan(plan.handoff[10] as number);
    expect(workload.pick[15]).toBeGreaterThan(workload.pick[10] as number);
    expect(workloadByHour(orders).handoff[17]).toBeCloseTo((40 * 0.45 * 240) / 60);
    expect(erlangCWait(0.5, 4, 3)).toBeGreaterThan(erlangCWait(0.5, 4, 4));
    expect(erlangCWait(1, 4, 3)).toBe(Infinity);
  });

  it('recommends moving an idle picker to a growing handoff queue, not the reverse', async () => {
    const { adviseDispatch } = await import('./index');
    const busyHandoff = { staff: { pick: 5, stage: 1, handoff: 1 }, waiting: 4, arriving: 6, horizonMin: 15, handoffServiceMin: 4, pickBacklogMin: 20, pickDueInMin: 90, stageBacklog: 2, stageMinPerTote: 0.5 };
    const a = adviseDispatch(busyHandoff, { pick: 3, stage: 0, handoff: 0 });
    expect(a).toMatchObject({ from: 'pick', to: 'handoff' });
    expect(a!.after.handoffWaitMin).toBeLessThan(a!.before.handoffWaitMin);
    expect(a!.reasons[0]?.factor).toBe('HANDOFF_QUEUE');
    // 没人可调或已经很顺：不建议
    expect(adviseDispatch(busyHandoff, { pick: 0, stage: 0, handoff: 0 })).toBeUndefined();
    expect(adviseDispatch({ ...busyHandoff, waiting: 0, arriving: 1, staff: { pick: 5, stage: 1, handoff: 3 } }, { pick: 3, stage: 0, handoff: 2 })).toBeUndefined();
  });
});
