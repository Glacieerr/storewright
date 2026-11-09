import { describe, expect, it } from 'vitest';
import { buildBoard } from '../src/sim/board';
import { g3, withLoad } from '../src/sim/config';
import { HOUR_W, runChain } from '../src/sim/engine';
import { allocationHour, emptyDay } from '../src/sim/plan';
import { defaultFacilities, SHIFTS, type Shift } from '../src/facility/config';
import { activityFromBoard, coverage, SALES_HOUR, shiftHours, solveRole, solveStaffing } from '../src/facility/staffing';

const lo0: Record<Shift, number> = { early: 0, late: 0, night: 0 };

describe('排班求解', () => {
  it('门店每小时的销售比例和仿真一致', () => {
    expect(SALES_HOUR).toEqual(HOUR_W);
  });

  it('不加班时：每班的人数就是这一班里最忙那个小时要的人数（不低于下限）', () => {
    const need = Array.from({ length: 24 }, (_, h) => (h * 7) % 5);
    const r = solveRole(need, 20, { early: 0, late: 3, night: 0 }, 0, 1.5);
    for (const s of SHIFTS) expect(r?.crew[s]).toBe(Math.max(s === 'late' ? 3 : 0, ...shiftHours(s).map((h) => need[h] as number)));
  });

  it('允许加班时：每个小时都有够的人，成本不高于不加班，每人每天最多一段加班', () => {
    const need = [2, 2, 2, 2, 6, 6, 9, 9, 8, 8, 8, 8, 9, 9, 12, 11, 7, 7, 7, 7, 7, 7, 3, 3];
    const plain = solveRole(need, 25, lo0, 0, 1.5);
    const ot = solveRole(need, 25, lo0, 2, 1.5);
    expect(ot && plain).toBeTruthy();
    if (!ot || !plain) return;
    const cov = coverage(ot.crew, ot.overtime);
    for (let h = 0; h < 24; h++) expect(cov[h]).toBeGreaterThanOrEqual(need[h] as number);
    expect(ot.cost).toBeLessThanOrEqual(plain.cost);
    for (const s of SHIFTS) expect(ot.overtime.filter((o) => o.shift === s).reduce((a, o) => a + o.people, 0)).toBeLessThanOrEqual(ot.crew[s]);
    // 小规模穷举核对：同样的加班规则下没有更便宜的三班人数
    let best = Infinity;
    for (let e = 0; e <= 12; e++)
      for (let l = 0; l <= 12; l++)
        for (let n = 0; n <= 12; n++) {
          const r = solveRole(need, 25, { early: e, late: l, night: n }, 2, 1.5);
          if (r && r.crew.early === e && r.crew.late === l && r.crew.night === n) best = Math.min(best, r.cost);
        }
    expect(ot.cost).toBe(best);
  });

  it('真实的一天：物流园和综合店每个小时都有够的人，影响仿真效率的岗位不少于现在', () => {
    for (const load of ['normal', 'extreme'] as const) {
      const s = withLoad(g3(1), load);
      s.traceDay = 86;
      const r = runChain(s);
      const b = buildBoard(r.trace?.ops ?? [], emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
      const sales = Object.values(r.trace?.storeDemand ?? {}).reduce((a, x) => a + x, 0);
      const act = activityFromBoard(b, 'S01', sales);
      const f = defaultFacilities();
      for (const fac of ['dc', 'store'] as const) {
        const plan = solveStaffing(fac, f, act, { overtimeRate: 1.5, maxOvertimeHours: 2, reservePct: 10, minPerShift: 1, simNeutral: true });
        expect(plan.hasData).toBe(true);
        for (const role of plan.roles) {
          if (role.fixed) {
            expect(role.plain).toEqual(role.current);
            continue;
          }
          expect(role.short).toBe(0);
          const cov = coverage(role.plain, []);
          for (let h = 0; h < 24; h++) expect(cov[h]).toBeGreaterThanOrEqual(role.need[h] as number);
          for (const s2 of SHIFTS) if (role.floor[s2] !== undefined) expect(role.plain[s2]).toBeGreaterThanOrEqual(role.floor[s2] as number);
        }
        expect(plan.cost).toBeLessThanOrEqual(plan.costPlain + 1e-6);
      }
    }
  });
});
