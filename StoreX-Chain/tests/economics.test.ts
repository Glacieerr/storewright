import { describe, expect, it } from 'vitest';
import { BASE, cashflow, scaleIn, storeProgramCapex, type CurvePoint, type DayCost } from '../src/analysis/economics';

const cost = (total: number, inv: number, store: number): DayCost => ({ outbound: total * 0.15, vans: 0, inbound: total * 0.1, drayageRail: total * 0.03, freight: total * 0.25, dcLabor: total * 0.12, carrying: total * 0.12, waste: total * 0.2, lostMargin: total * 0.03, total, storeOpex: store, inventory: inv });
// 一家综合店的量级：供应链每天约 1.5–3.3 万美元，库存资金 1–3 百万美元
const curve: CurvePoint[] = [0.8, 1, 1.24, 1.6].map((scale) => ({ scale, gen: { g1: cost(33_000 * scale, 3e6, 37_000 * scale), g2: cost(24_000 * scale, 2.8e6, 23_000 * scale), g3: cost(15_000 * scale, 1.2e6, 23_000 * scale) } }));

describe('全链路商业分析', () => {
  it('需求路径：2027 年 100%，2030 年到目标，之后每年 +2%', () => {
    expect(scaleIn(2027, BASE)).toBe(1);
    expect(scaleIn(2030, BASE)).toBeCloseTo(1.24, 6);
    expect(scaleIn(2031, BASE)).toBeCloseTo(1.24 * 1.02, 6);
  });
  it('上游这一步：投资在 2026 年，库存释放在前两年，回收期有限', () => {
    const r = cashflow(curve, BASE, 'upstream');
    expect(r.rows[0]?.capex).toBeGreaterThan(10e6);
    expect(r.workingCapital).toBeCloseTo(1.6e6, -3);
    expect((r.rows[1]?.workingCapital ?? 0) + (r.rows[2]?.workingCapital ?? 0)).toBeCloseTo(r.workingCapital, 0);
    expect(Number.isFinite(r.payback)).toBe(true);
  });
  it('全系统包含综合店改造成 StoreX 的投资，比上游这一步大', () => {
    const up = cashflow(curve, BASE, 'upstream');
    const sys = cashflow(curve, BASE, 'system');
    expect(sys.capexTotal - up.capexTotal).toBeCloseTo(storeProgramCapex(), 0);
    expect(storeProgramCapex()).toBeGreaterThan(10e6);
  });
  it('投资越高净现值越低', () => {
    expect(cashflow(curve, { ...BASE, capex: 'high' }, 'upstream').npv).toBeLessThan(cashflow(curve, BASE, 'upstream').npv);
  });
});
