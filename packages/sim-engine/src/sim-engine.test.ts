import { describe, expect, it } from 'vitest';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { generateCatalog, generateOrders } from '@storewright/synth';
import { EventQueue } from './kernel';
import { simulateDay } from './day';
import { BASELINE, OPTIMIZED, ablationPolicies, defaultScenario } from './scenario';
import { percentile, summarize } from './stats';

const model = new StoreModel(createTemplate('small'));
const catalog = generateCatalog(model, { seed: 7 });
const scenario = defaultScenario('small');
const orders = generateOrders(model, catalog, scenario.demand, { seed: 99 });

describe('事件队列', () => {
  it('按时间排序，同一时刻按加入顺序', () => {
    const q = new EventQueue();
    const out: string[] = [];
    q.push(5, () => out.push('c'));
    q.push(1, () => out.push('a'));
    q.push(5, () => out.push('d'));
    q.push(3, () => out.push('b'));
    for (let e = q.pop(); e; e = q.pop()) e.action();
    expect(out).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('一天的仿真', () => {
  it('同一输入和种子得到完全相同的结果（可复现）', () => {
    const a = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3 });
    const b = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3 });
    expect(b.metrics).toEqual(a.metrics);
  });

  it('所有订单都完成交付，事件时间单调不减', () => {
    for (const policy of [BASELINE, OPTIMIZED, ...ablationPolicies()]) {
      const r = simulateDay({ model, items: catalog.byId, orders, scenario, policy, seed: 3, retainEvents: true });
      expect(r.metrics.unfinishedOrders).toBe(0);
      expect(r.metrics.orders).toBe(orders.length);
      for (let i = 1; i < r.events.length; i++) expect((r.events[i] as { t: number }).t).toBeGreaterThanOrEqual((r.events[i - 1] as { t: number }).t - 1e-6);
    }
  });

  it('公共随机数：不同策略面对同一批缺货事件', () => {
    const a = simulateDay({ model, items: catalog.byId, orders, scenario, policy: BASELINE, seed: 8 });
    const b = simulateDay({ model, items: catalog.byId, orders, scenario, policy: { ...BASELINE, name: 'b2', routing: 'TSP' }, seed: 8 });
    expect(b.metrics.notFoundLinePct).toBe(a.metrics.notFoundLinePct);
    expect(b.metrics.substitutedLines).toBe(a.metrics.substitutedLines);
  });

  it('优化策略消除超重、压坏风险和化学品混装', () => {
    const r = simulateDay({ model, items: catalog.byId, orders, scenario, policy: OPTIMIZED, seed: 3 });
    expect(r.metrics.overweightTotePct).toBe(0);
    expect(r.metrics.crushRiskTotePct).toBe(0);
    expect(r.metrics.chemicalMixTotePct).toBe(0);
  });
});

describe('统计', () => {
  it('分位数与置信区间', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    const s = summarize([10, 10, 10]);
    expect(s.mean).toBe(10);
    expect(s.ci95).toBe(0);
  });
});
