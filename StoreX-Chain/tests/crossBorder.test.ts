import { describe, expect, it } from 'vitest';
import { BASE_RATE, crossBorder, MODES } from '../src/analysis/crossBorder';
import { scenarioFor } from '../src/sim/config';

describe('跨境：清关时间和仿真对得上', () => {
  for (const gen of ['g1', 'g2', 'g3'] as const)
    it(`${gen}：每种来货的各步加起来正好是仿真用的时间`, () => {
      const s = scenarioFor(gen, 1);
      const cb = crossBorder(gen);
      const want = { road: 48, sea: s.port.dwellDays * 24, rail: s.rail.terminalHours, air: s.air.handlingHours };
      expect(cb.flows.map((f) => f.mode)).toEqual(MODES);
      for (const f of cb.flows) {
        expect(f.families.length).toBeGreaterThan(0);
        for (const st of f.steps) expect(st.hours).toBeGreaterThanOrEqual(0);
        expect(f.totalHours).toBeCloseTo(want[f.mode], 9);
        expect(f.sim.hours).toBeCloseTo(want[f.mode], 9);
      }
    });

  it('预清关让海运、铁路、空运的清关快了；跨境公路两代一样（仿真里都多 2 天）', () => {
    const a = crossBorder('g1');
    const b = crossBorder('g3');
    const h = (c: typeof a, m: string) => c.flows.find((f) => f.mode === m)?.totalHours ?? NaN;
    expect(h(b, 'sea')).toBeLessThan(h(a, 'sea'));
    expect(h(b, 'rail')).toBeLessThan(h(a, 'rail'));
    expect(h(b, 'air')).toBeLessThan(h(a, 'air'));
    expect(h(b, 'road')).toBe(h(a, 'road'));
  });
});

describe('跨境：单证、税费和汇率', () => {
  const cb = crossBorder('g3');
  it('每票都有发票、装箱单、运输单据和报关单；有生鲜的要检疫证书', () => {
    for (const f of cb.flows) {
      const labels = f.docs.map((d) => d.label);
      expect(labels).toEqual(expect.arrayContaining(['商业发票', '装箱单', '进口报关单']));
      expect(f.docs.filter((d) => d.need === 'all').length).toBeGreaterThanOrEqual(4);
      if (f.families.some((x) => x.fresh)) expect(f.docs.some((d) => d.need === 'fresh')).toBe(true);
    }
  });

  it('到岸成本 = （货值 + 运费 + 保险 + 关税）× 汇率 + 口岸费用；增值税单列', () => {
    expect(cb.rate).toBe(BASE_RATE);
    for (const f of cb.flows)
      for (const x of f.families) {
        expect(x.landedLcu).toBeCloseTo((x.goods + x.freight + x.insurance + x.duty) * cb.rate + x.feesLcu, 9);
        expect(x.duty).toBeCloseTo(x.dutyRate * (x.goods + x.freight + x.insurance), 9);
        expect(x.vatLcu).toBeGreaterThan(0);
      }
  });

  it('本币越贬值到岸成本越高；每 1% 的影响和情景表一致；敏感度按影响从大到小排', () => {
    const totals = cb.scenarios.map((s) => s.total);
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1] as number);
    const base = cb.scenarios.find((s) => s.change === 0)?.total ?? 0;
    const up10 = cb.scenarios.find((s) => Math.abs(s.change - 0.1) < 1e-9)?.total ?? 0;
    expect(up10 - base).toBeCloseTo(cb.perPoint * 10, 3);
    const spans = cb.tornado.map((t) => t.high - t.low);
    for (let i = 1; i < spans.length; i++) expect(spans[i]).toBeLessThanOrEqual(spans[i - 1] as number);
  });

  it('不改仿真：场景参数还是原来的', () => {
    expect(scenarioFor('g3', 1).port.dwellDays).toBe(1.6);
    expect(scenarioFor('g1', 1).port.dwellDays).toBe(4.5);
    expect(scenarioFor('g3', 1).rail.terminalHours).toBe(4);
    expect(scenarioFor('g3', 1).air.handlingHours).toBe(2.5);
  });
});
