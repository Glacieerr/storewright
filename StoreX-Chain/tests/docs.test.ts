import { describe, expect, it } from 'vitest';
import { format, syncDocs, valueOf } from '../src/cli/docnums';

/** 文档里标出来的数字都和结果数据（docs/results/data.json）一致 */
describe('文档的数字', () => {
  it('格式：千位逗号、负号用 −、单位换算、变化的百分比', () => {
    expect(format(1234.5, 1)).toBe('1,234.5');
    expect(format(-0.04, 0)).toBe('0');
    expect(format(-55.2, 0)).toBe('−55');
    const data = { gens: [{ gen: 'g1', mean: { x: 4 } }, { gen: 'g3', mean: { x: 2 } }], a: [{ v: 11250000 }] };
    expect(valueOf(data, 'gens.g3.mean.x|2')).toBe('2.00');
    expect(valueOf(data, 'pct:gens.g1.mean.x:gens.g3.mean.x|0')).toBe('−50');
    expect(valueOf(data, 'a.0.v|0|w')).toBe('1,125');
    expect(valueOf(data, 'gens.g9.mean.x|2')).toBeUndefined();
  });

  it('README 和报告里标出来的数字和数据一致（重新跑报告以后用 npm run docs:sync 更新）', () => {
    const { marks, mismatches } = syncDocs(false);
    expect(marks).toBeGreaterThan(40);
    expect(mismatches).toEqual([]);
  });
});
