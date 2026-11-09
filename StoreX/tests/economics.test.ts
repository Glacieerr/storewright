import { describe, expect, it } from 'vitest';
import { BASE, CAPEX, cashflow, crf, interp, irr, mfcBreakEven, ordersIn, payback, sensitivity, type CurvePoint, type Money } from '../src/analysis/economics';

const m = (total: number, labor = total * 0.8): Money => ({ labor, energy: total * 0.05, freshLoss: total * 0.1, lostMargin: total * 0.05 - (labor - total * 0.8), total });
/** 一条合成的容量曲线：上一代每多一单多花 18 美元，StoreX 多花 6 美元，不建货格仓多花 11 美元 */
const curve: CurvePoint[] = [100, 266, 532, 800].map((v) => ({
  volume: v,
  gen1: m(12_000 + 18 * v),
  storex: m(8_000 + 6 * v),
  noMfc: m(8_200 + 11 * v),
  gen1Hours: 0,
  storexHours: 0,
  noMfcHours: 0,
}));

describe('财务工具', () => {
  it('内部收益率、回收期、资本回收系数', () => {
    expect(irr([-100, 110])).toBeCloseTo(0.1, 6);
    expect(irr([-100, 60, 60])).toBeCloseTo(0.1307, 3);
    expect(payback([-100, -40, 20, 80])).toBeCloseTo(1 + 40 / 60, 9);
    expect(payback([-100, -50])).toBeNaN();
    // 10 年、7%：每年 0.1424
    expect(crf(0.07, 10)).toBeCloseTo(0.14238, 4);
  });

  it('按订单量插值，超出范围外推', () => {
    expect(interp(curve, 266, (p) => p.gen1.total)).toBeCloseTo(12_000 + 18 * 266, 6);
    expect(interp(curve, 400, (p) => p.storex.total)).toBeCloseTo(8_000 + 6 * 400, 6);
    expect(interp(curve, 1000, (p) => p.gen1.total)).toBeCloseTo(12_000 + 18 * 1000, 6);
    expect(interp(curve, 50, (p) => p.gen1.total)).toBeCloseTo(12_000 + 18 * 50, 6);
  });

  it('订单量路径：2027 年 266 单，2030 年到目标，之后每年 +3%', () => {
    expect(ordersIn(2027, BASE)).toBe(266);
    expect(ordersIn(2030, BASE)).toBeCloseTo(532, 6);
    expect(ordersIn(2031, BASE)).toBeCloseTo(532 * 1.03, 6);
    expect(ordersIn(2028, BASE)).toBeGreaterThan(266);
    expect(ordersIn(2028, BASE)).toBeLessThan(ordersIn(2029, BASE));
  });
});

describe('现金流', () => {
  const r = cashflow(curve);

  it('第 0 年只有投资，之后每年有节省和运营成本', () => {
    expect(r.rows).toHaveLength(11);
    expect(r.rows[0]!.net).toBeCloseTo(-r.capexOpening, 6);
    expect(r.rows[0]!.gross).toBe(0);
    for (const row of r.rows.slice(1)) {
      expect(row.gross).toBeGreaterThan(0);
      expect(row.maintenance).toBeGreaterThan(0);
    }
    // 累计 = 逐年净现金流之和
    expect(r.rows[10]!.cumulative).toBeCloseTo(r.rows.reduce((s, x) => s + x.net, 0), 3);
  });

  it('开业投资等于 2026 年买的设备之和；后买的设备在对应年份出现', () => {
    const opening = CAPEX.filter((it) => it.year === 2026).reduce((s, it) => s + it.unit * it.qty, 0);
    expect(r.capexOpening).toBeCloseTo(opening, 6);
    expect(r.rows.find((x) => x.year === 2028)!.capex).toBeGreaterThan(0);
    expect(r.rows.find((x) => x.year === 2027)!.capex).toBe(0);
  });

  it('爬坡：第一年的节省低于第三年', () => {
    expect(r.rows[1]!.saving.total).toBeLessThan(r.rows[3]!.saving.total);
  });

  it('投资越高、工资越低，净现值越低', () => {
    expect(cashflow(curve, { ...BASE, capex: 'high' }).npv).toBeLessThan(r.npv);
    expect(cashflow(curve, { ...BASE, capex: 'low' }).npv).toBeGreaterThan(r.npv);
    expect(cashflow(curve, { ...BASE, wage: 0.8 }).npv).toBeLessThan(r.npv);
  });

  it('敏感性：每一项的低值和高值落在基准两侧（或相等）', () => {
    for (const s of sensitivity(curve)) {
      const lo = Math.min(s.low.npv, s.high.npv);
      const hi = Math.max(s.low.npv, s.high.npv);
      expect(lo).toBeLessThanOrEqual(r.npv + 1e-6);
      expect(hi).toBeGreaterThanOrEqual(r.npv - 1e-6);
    }
  });

  it('货格仓的盈亏平衡：省下的钱随订单量增加，能找到平衡点', () => {
    const be = mfcBreakEven(curve);
    expect(be.annualCost).toBeGreaterThan(100_000);
    expect(be.volume).toBeGreaterThan(0);
    expect(be.volume).toBeLessThan(1200);
  });
});
