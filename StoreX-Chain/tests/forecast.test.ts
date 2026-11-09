import { describe, expect, it } from 'vitest';
import { forecastDelay, forecastDemand, forecastReport, forecastTravel, ridge, selectedModel, setForecastReport, trainForecasts, type ForecastReport } from '../src/analysis/forecast';
import { STRESS, STRESS_START } from '../src/analysis/studies';
import { scenarioFor } from '../src/sim/config';
import { runChain, type ChainResult } from '../src/sim/engine';

const strip = (r: ChainResult) => {
  const o: Partial<ChainResult> = { ...r };
  delete o.history;
  return JSON.stringify(o);
};

describe('引擎的预测记录和多种扰动（不改变原来的结果）', () => {
  it('打开预测记录不改变任何结果，记录的形状对', () => {
    const a = runChain(scenarioFor('g3', 1));
    const s = scenarioFor('g3', 1);
    s.history = true;
    const b = runChain(s);
    expect(strip(b)).toBe(strip(a));
    expect(b.history?.demand).toHaveLength(17);
    expect(b.history?.demand[0]).toHaveLength(126);
    expect(b.history?.calls.length).toBe(18);
    expect(b.history?.trains.length).toBe(18);
    // 期望需求和实际需求同一个量级，促销倍数只有 1 和 1.6
    const tot = (x: number[][]) => x.reduce((a2, r) => a2 + r.reduce((p, q) => p + q, 0), 0);
    expect(tot(b.history?.demand ?? []) / tot(b.history?.expected ?? [])).toBeGreaterThan(0.9);
    expect(tot(b.history?.demand ?? []) / tot(b.history?.expected ?? [])).toBeLessThan(1.1);
    expect(new Set(b.history?.promo.flat())).toEqual(new Set([1, 1.6]));
  });
  it('disruptions 里的一条扰动和 disruption 完全一样', () => {
    for (const c of STRESS) {
      const a = scenarioFor('g1', 2);
      a.disruption = { key: c.key, start: STRESS_START, days: c.days };
      const b = scenarioFor('g1', 2);
      b.disruptions = [{ key: c.key, start: STRESS_START, days: c.days }];
      expect(strip(runChain(b))).toBe(strip(runChain(a)));
    }
  });
  it('几种扰动可以同时发生，需求突增的倍数和班轮多晚到的天数可以改', () => {
    const base = runChain(scenarioFor('g1', 1));
    const s = scenarioFor('g1', 1);
    s.disruptions = [
      { key: 'demandSurge', start: 80, days: 3, factor: 1.6 },
      { key: 'portCongestion', start: 82, days: 6, delayDays: 4 },
    ];
    const r = runChain(s);
    const mild = scenarioFor('g1', 1);
    mild.disruptions = [{ key: 'demandSurge', start: 80, days: 3, factor: 1.1 }];
    expect(r.store.demandUnits).toBeGreaterThan(runChain(mild).store.demandUnits);
    expect(r.store.service).toBeLessThan(base.store.service);
  });
});

describe('预测模型：学到的模型和规则比，哪个准用哪个', () => {
  let rep: ForecastReport;
  it('训练全部预测模型（几秒内）', () => {
    const t0 = performance.now();
    rep = trainForecasts({ delayRuns: 8, roadDays: Array.from({ length: 24 }, (_, i) => 80 + i) });
    expect(performance.now() - t0).toBeLessThan(20_000);
  });
  it('门店销量：岭回归比规则准，逐个商品族选的不比规则差；随机波动是误差的下限；对期望需求的误差在仿真设定附近', () => {
    const d = rep.demand;
    const m = (k: string) => d.overall.find((x) => x.key === k)?.test.wape ?? NaN;
    expect(m('ridge')).toBeLessThan(m('rule'));
    expect(d.selectedTest.wape).toBeLessThan(m('rule'));
    expect(d.oracle.wape).toBeLessThan(m('ridge'));
    expect(d.selectedVsExpected.wape).toBeLessThan(d.assumed * 1.6);
    // 每个商品族选的都是验证期误差最小的
    for (const f of d.families) {
      const best = Math.min(...f.models.map((x) => x.valid.wape));
      expect(f.models.find((x) => x.key === f.selected)?.valid.wape).toBe(best);
    }
  });
  it('晚到：选的是验证期平均误差最小的；90% 分位数在检验期大致覆盖九成', () => {
    for (const d of [rep.vessel, rep.train]) {
      const best = Math.min(...d.models.map((x) => x.valid.mae));
      expect(d.models.find((x) => x.key === d.selected)?.valid.mae).toBe(best);
      expect(d.coverage).toBeGreaterThan(0.7);
      expect(d.p90).toBeGreaterThan(d.median);
    }
  });
  it('路上用时：计划用时偏乐观（现实更堵），跨天训练的岭回归比计划准', () => {
    const r = rep.road;
    const m = (k: string) => r.models.find((x) => x.key === k)?.test as { mae: number; bias: number };
    expect(r.legs.test).toBeGreaterThan(10);
    expect(m('rule').bias).toBeLessThan(0);
    expect(m('ridge').mae).toBeLessThan(m('rule').mae);
  });
  it('给别的模块用的接口按选中的模型预测，没训练时返回空', () => {
    setForecastReport(undefined);
    expect(forecastDemand('DAIRY', 100)).toBeUndefined();
    setForecastReport(rep);
    expect(forecastReport()).toBe(rep);
    const f = rep.demand.families.find((x) => x.key === 'DAIRY');
    const y = forecastDemand('DAIRY', 100) as number;
    const actual = rep.demand.y[8]?.[100] as number;
    expect(f).toBeDefined();
    expect(Math.abs(y / actual - 1)).toBeLessThan(0.6);
    expect(forecastDemand('DAIRY', 130)).toBeGreaterThan(0);
    expect(selectedModel('demand')?.reason).toMatch(/验证期/);
    expect(selectedModel('road')?.key).toBe(rep.road.selected);
    expect(forecastDelay('vessel')?.hours).toBeGreaterThan(0);
    const peak = forecastTravel(60, 8 * 3600) as number;
    if (rep.road.selected !== 'rule') expect(peak).toBeGreaterThan(60);
    else expect(peak).toBe(60);
  });
  it('同样的输入每次结果一样', () => {
    const again = trainForecasts({ delayRuns: 8, roadDays: Array.from({ length: 24 }, (_, i) => 80 + i) });
    expect(JSON.stringify({ ...again, ms: 0 })).toBe(JSON.stringify({ ...rep, ms: 0 }));
  });
  it('岭回归能还原线性关系', () => {
    const X = Array.from({ length: 40 }, (_, i) => [1, i % 7, (i * 3) % 5]);
    const y = X.map((x) => 2 + 0.5 * (x[1] as number) - 1.5 * (x[2] as number));
    const b = ridge(X, y, 1e-6);
    expect(b[0]).toBeCloseTo(2, 3);
    expect(b[1]).toBeCloseTo(0.5, 3);
    expect(b[2]).toBeCloseTo(-1.5, 3);
  });
});
