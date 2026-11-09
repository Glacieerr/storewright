import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { regionMap } from '../src/analysis/mapSvg';
import { setRegion, STORE } from '../src/region/network';
import { DEFAULT_REGION, regionSpecFrom } from '../src/region/regionGen';
import { Distances } from '../src/network/graph';
import { allocate, ALLOC_FAMILIES, DEFAULT_OPTIONS, planNetwork } from '../src/network/index';
import { networkMap } from '../src/network/map';
import { DEFAULT_PARAMS, NET, type NetParams } from '../src/network/model';
import { bestForMask, bruteForce, buildInstance, masksOf, solve } from '../src/network/solve';
import { networkSites } from '../src/network/sites';

afterAll(() => {
  setRegion(DEFAULT_REGION);
});

describe('多门店网络：店址和候选仓', () => {
  for (const name of ['default', 'random-3', 'random-11']) {
    it(`${name}：12 个店址、候选仓都接得上路网，名字不重复`, () => {
      setRegion(regionSpecFrom(name));
      const d = new Distances();
      const { stores, sites } = networkSites(d.g, { outerKm: 60 });
      expect(stores.length).toBe(12);
      expect(stores[0]?.key).toBe('S01');
      expect(stores[0]?.km).toEqual(STORE.km);
      expect(new Set(stores.map((s) => s.key)).size).toBe(12);
      expect(new Set(stores.map((s) => s.name)).size).toBe(12);
      expect(sites[0]?.kind).toBe('park');
      expect(sites.length).toBeGreaterThanOrEqual(4);
      for (const s of sites)
        for (const st of stores) {
          const leg = d.leg(s.point, st.point);
          expect(Number.isFinite(leg.km) && leg.km > 0).toBe(true);
          expect(leg.hours).toBeLessThan(4);
        }
    });
  }
});

describe('多门店网络：选址和分配是精确最优', () => {
  beforeEach(() => {
    setRegion(DEFAULT_REGION);
  });
  const cases: [string, number, NetParams][] = [
    ['现在的需求', 6, { growth: 1, freight: 1, allowExpand: true }],
    ['需求 +60%、不能扩建', 6, { growth: 1.6, freight: 1, allowExpand: false }],
    ['需求翻一番、运价 ×1.5', 7, { growth: 2, freight: 1.5, allowExpand: true }],
  ];
  for (const [label, n, params] of cases)
    it(`${label}：每种开仓组合的最优分配和全局最优都和穷举一样`, () => {
      // 候选取物流园 + 3 个，店取前 n 家：穷举每种组合下每家店的每种分法
      const d = new Distances();
      const { stores, sites } = networkSites(d.g, { outerKm: 60 });
      const inst = buildInstance(d, stores.slice(0, n), sites.slice(0, 4), params);
      const m = inst.sites.length - 1;
      const all = (1 << (m + 1)) - 1;
      for (const mask of masksOf(inst)) {
        const bb = bestForMask(inst, mask);
        const bf = bruteForce(inst, { require: mask, forbid: all & ~mask });
        expect(bb).toBeDefined();
        expect(bb?.objective).toBeCloseTo(bf.objective, 4);
      }
      expect(solve(inst).objective).toBeCloseTo(bruteForce(inst).objective, 4);
    });
});

describe('多门店网络：规划结果', () => {
  beforeEach(() => {
    setRegion(DEFAULT_REGION);
  });
  it('线路把每家店每天的货都送到，一趟不超载、不超时；车数够跑完所有趟', () => {
    const plan = planNetwork({ n: 12, outerKm: 100, params: { growth: 1.6, freight: 1, allowExpand: true } });
    const ev = plan.best.eval;
    const got = new Map<string, number>();
    for (const t of ev.trips) {
      expect(t.pallets).toBeLessThanOrEqual(NET.truckPallets + 1e-9);
      if (!t.full) expect(t.hours).toBeLessThanOrEqual(NET.maxTripHours + 1e-9);
      for (const s of t.stops) got.set(s.key, (got.get(s.key) ?? 0) + s.pallets);
    }
    plan.stores.forEach((s, i) => expect(got.get(s.key) ?? 0).toBeCloseTo(plan.inst.pallets[i] as number, 0));
    const hours = ev.trips.reduce((a, t) => a + t.hours, 0);
    expect(ev.vehicles).toBeGreaterThanOrEqual(Math.ceil(hours / NET.shiftHours - 1e-9));
    expect(ev.costs.total).toBeCloseTo(Object.entries(ev.costs).reduce((a, [k, v]) => (k === 'total' ? a : a + v), 0), 2);
  });

  it('建议的网络不比今天的贵；货多了、不能扩建时会开第二个仓或者交第三方仓；同样的输入结果一样', () => {
    const base = planNetwork(DEFAULT_OPTIONS);
    expect(base.best.eval.costs.total).toBeLessThanOrEqual(base.today.eval.costs.total + 1e-6);
    expect(base.explain[0]).toMatch(/^建议：/);
    const again = planNetwork(DEFAULT_OPTIONS);
    expect(again.best.mask).toBe(base.best.mask);
    expect(again.best.eval.costs.total).toBeCloseTo(base.best.eval.costs.total, 6);
    const small = planNetwork({ n: 3, outerKm: 60, params: { ...DEFAULT_PARAMS, growth: 1 } });
    expect(small.best.mask).toBe(0);
    const big = planNetwork({ n: 12, outerKm: 60, params: { growth: 2, freight: 1, allowExpand: false } });
    expect(big.best.eval.open.length > 1 || big.best.eval.overflowPallets > 0).toBe(true);
    expect(big.ms).toBeLessThan(3000);
    expect(big.ranked.every((r) => r.choice.exact)).toBe(true);
  });

  it('地图画出了每家店和开着的仓；报告用的区域地图输出没变', () => {
    const plan = planNetwork(DEFAULT_OPTIONS);
    const svg = networkMap(plan, plan.best, 'nw-test');
    for (const s of plan.stores) expect(svg).toContain(s.name);
    expect(svg).toContain('id="nw-test"');
    expect(svg).not.toContain('综合店（区域里唯一的门店）');
    expect(regionMap()).toBe(readFileSync('docs/results/region-map.svg', 'utf8'));
  });
});

describe('货不够时的公平分配', () => {
  beforeEach(() => {
    setRegion(DEFAULT_REGION);
  });
  for (const fam of ALLOC_FAMILIES.slice(0, 6))
    it(`${fam.label}：分的总数等于到货，各店补到目标的同一比例，最差的店不比按比例分差`, () => {
      const { stores } = networkSites(new Distances().g, { outerKm: 60 });
      const a = allocate(stores, fam.key, 0.7);
      expect(a.rows.reduce((s, r) => s + r.alloc, 0)).toBeCloseTo(a.supply, 3);
      for (const r of a.rows) if (r.alloc > 1e-6) expect((r.onHand + r.alloc) / r.target).toBeCloseTo(a.ratio, 4);
      expect(a.worstFill).toBeGreaterThanOrEqual(a.worstPropFill - 1e-9);
      const enough = allocate(stores, fam.key, 1.1);
      for (const r of enough.rows) expect(r.alloc).toBeCloseTo(r.need, 6);
    });
});
