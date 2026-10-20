import { describe, expect, it } from 'vitest';
import { createTemplate, fitsInside, formatSlotCode, StoreModel, validateStoreConfig } from './index';

describe('门店模板', () => {
  for (const t of ['small', 'medium', 'large'] as const) {
    it(`${t} 模板通过结构与语义校验，所有货位可达`, () => {
      const res = validateStoreConfig(createTemplate(t));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.model.unreachableLocations()).toEqual([]);
        expect(res.model.stagingSlots.length).toBeGreaterThan(0);
      }
    });
  }

  it('大型模板有两层，二楼经电梯可达', () => {
    const m = new StoreModel(createTemplate('large'));
    const f2 = [...m.locations.values()].find((l) => l.floorId === 'F2');
    expect(f2).toBeDefined();
    if (f2) expect(Number.isFinite(m.distance(m.stagingNode, f2.nodeId))).toBe(true);
  });

  it('最短路径的长度等于距离', () => {
    const m = new StoreModel(createTemplate('small'));
    const loc = [...m.locations.values()][50];
    if (!loc) throw new Error('no location');
    const path = m.path(m.stagingNode, loc.nodeId);
    let d = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as number;
      const b = path[i] as number;
      d += m.adjacency[a]?.find((e) => e.to === b)?.w ?? Number.NaN;
    }
    expect(d).toBeCloseTo(m.distance(m.stagingNode, loc.nodeId), 6);
  });

  it('引用不存在的类别时校验失败', () => {
    const cfg = createTemplate('small');
    cfg.layout.runs[0]?.categoryIds.push('does-not-exist');
    const res = validateStoreConfig(cfg);
    expect(res.ok).toBe(false);
  });

  it('暂存格位编码可自定义（决策 S-01）', () => {
    expect(formatSlotCode('{zone}-{rack}-{level}-{slot}', { zone: 'AMB', rack: 3, level: 2, slot: 16 }, 2)).toBe('AMB-03-02-16');
    expect(formatSlotCode('{zone}{rack}/{slot}', { zone: 'FRZ', rack: 1, level: 1, slot: 4 }, 3)).toBe('FRZ001/004');
  });

  it('尺寸判断允许旋转', () => {
    expect(fitsInside({ l: 40, w: 27, h: 24 }, { l: 53, w: 35, h: 28 })).toBe(true);
    expect(fitsInside({ l: 60, w: 40, h: 12 }, { l: 53, w: 35, h: 28 })).toBe(false);
  });
});
