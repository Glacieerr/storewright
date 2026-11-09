import { describe, expect, it } from 'vitest';
import { checkSolution, parseSol, parseVrp, randomInstance, solveExact, solveNearest, solveSavings, toSol, toVrp, type CvrpInstance } from '../src/validate/cvrp';
import { fillRateCases, LOSS_TABLE, lossFromFill } from '../src/validate/inventory';
import { mulberry32 } from '../src/validate/rng';
import { runValidation, validationMarkdown } from '../src/validate';

describe('对照验证：配送线路', () => {
  it('手算得出最优的小例子：精确解法给出同样的线路费用', () => {
    // 配送中心在原点，四家店在正方形四角，每家 5 托、车装 10 托：最优是两车各送相邻的两家
    const inst: CvrpInstance = { name: 'square', xy: [[0, 0], [10, 0], [10, 10], [0, 10], [-10, 10]], demand: [0, 5, 5, 5, 5], capacity: 10, maxStops: Infinity };
    const ex = solveExact(inst);
    expect(checkSolution(inst, ex)).toEqual([]);
    // 两条线路：0-1-2-0 = 10 + 10 + 14 = 34，0-3-4-0 = 10 + 10 + 14 = 34
    expect(ex.cost).toBe(68);
  });
  it('随机例子：节约法、最近邻都可行，且从不比精确解好；节约法平均明显好于最近邻', () => {
    const rng = mulberry32(7);
    let gs = 0;
    let gn = 0;
    for (let k = 0; k < 30; k++) {
      const inst = randomInstance(rng, 8, 20, k % 2 ? 4 : Infinity, 8, `t${k}`);
      const ex = solveExact(inst);
      const sv = solveSavings(inst);
      const nn = solveNearest(inst);
      for (const s of [ex, sv, nn]) expect(checkSolution(inst, s)).toEqual([]);
      expect(sv.cost).toBeGreaterThanOrEqual(ex.cost);
      expect(nn.cost).toBeGreaterThanOrEqual(ex.cost);
      gs += sv.cost / ex.cost - 1;
      gn += nn.cost / ex.cost - 1;
    }
    expect(gs / 30).toBeLessThan(0.05);
    expect(gn).toBeGreaterThan(gs);
  });
  it('CVRPLIB 格式写出再读回来一样；坏的解被查出来', () => {
    const inst = randomInstance(mulberry32(3), 7, 20, Infinity, 8, 'roundtrip');
    const back = parseVrp(toVrp(inst, 'test'));
    expect(back).toEqual({ ...inst, name: 'roundtrip' });
    const ex = solveExact(inst);
    expect(parseSol(toSol(ex))).toEqual(ex);
    const bad = { routes: ex.routes.slice(1), cost: ex.cost };
    expect(checkSolution(inst, bad).length).toBeGreaterThan(0);
  });
});

describe('对照验证：满足率公式', () => {
  it('和蒙特卡洛模拟的差在 4 倍标准误以内', () => {
    for (const c of fillRateCases(20000)) expect(Math.abs(c.formula - c.simulated)).toBeLessThan(4 * c.se + 1e-4);
  });
  it('反推的标准正态损失函数和教科书的值一致（4 位）', () => {
    for (const [z, v] of LOSS_TABLE) expect(Math.abs(lossFromFill(z) - v)).toBeLessThan(6e-5);
  });
});

describe('对照验证：整体（小样本）', () => {
  it('精确求解器和穷举一致，没有「声称最优却不是」；报告中英文都生成', () => {
    const r = runValidation({ quick: true });
    for (const e of r.exact) {
      expect(e.wrong).toBe(0);
      expect(e.matched + e.flagged).toBe(e.instances);
    }
    expect(r.library.length).toBe(12);
    expect(validationMarkdown(r, 'zh')).toContain('节约法');
    expect(validationMarkdown(r, 'en')).toContain('savings');
  });
});
