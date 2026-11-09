import { describe, expect, it } from 'vitest';
import { FAMILIES } from '../src/region/products';
import { g1, g3 } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { planFlows } from '../src/sim/flows';

describe('货流规划：长途整车直送门店还是进配送中心', () => {
  const plan = planFlows(g3(1));

  it('只规划长途公路的商品族；全链路方案的直送清单就是规划算出来的', () => {
    expect(plan.map((d) => d.key).sort()).toEqual(FAMILIES.filter((f) => f.source === 'domestic').map((f) => f.key).sort());
    expect([...g3(1).flow.direct].sort()).toEqual(plan.filter((d) => d.via === 'direct').map((d) => d.key).sort());
    expect(g1(1).flow.direct).toHaveLength(0);
  });

  it('直送的都满足条件：不易腐、不是长尾、一车的量门店放得下、比进配送中心便宜', () => {
    for (const d of plan.filter((x) => x.via === 'direct')) {
      const fam = FAMILIES.find((f) => f.key === d.key)!;
      expect(fam.life === undefined || fam.life >= 20, d.key).toBe(true);
      expect(fam.cv, d.key).toBeLessThan(0.55);
      expect(d.interval, d.key).toBeLessThanOrEqual(fam.temp === 'frozen' ? 3 : 4);
      expect(d.costDirect, d.key).toBeLessThan(d.costDc);
    }
  });

  it('易腐的肉类、长尾的跨境常温货进配送中心；跨境（洲际）公路的货两种去处都有', () => {
    expect(plan.find((d) => d.key === 'MEAT')?.via).toBe('dc');
    expect(plan.find((d) => d.key === 'AMB_C')?.via).toBe('dc');
    const border = plan.filter((d) => FAMILIES.find((f) => f.key === d.key)?.supplier?.border);
    expect(border.some((d) => d.via === 'direct')).toBe(true);
    expect(border.some((d) => d.via === 'dc')).toBe(true);
    for (const d of plan) expect(d.reason.length, d.key).toBeGreaterThan(4);
  });

  it('仿真里：直送的货配送中心不放库存、不进配送中心的车；直送车只装直送的货', () => {
    const s = g3(1);
    s.traceDay = 86;
    const r = runChain(s);
    const direct = new Set(s.flow.direct);
    for (const b of r.byFamily.filter((x) => direct.has(x.key))) expect(b.dcDays, b.key).toBe(0);
    for (const o of r.trace?.ops ?? []) {
      const keys = Object.keys(o.stops?.[0]?.load ?? {});
      if (o.kind === 'direct') expect(keys.every((k) => direct.has(k)), o.id).toBe(true);
      if (o.kind === 'delivery') expect(keys.some((k) => direct.has(k)), o.id).toBe(false);
    }
    expect(r.inbound.directLoads).toBeGreaterThan(1.5);
  });
});
