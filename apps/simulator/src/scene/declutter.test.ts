import { describe, expect, it } from 'vitest';
import { declutter } from './declutter';

/** 只实现 declutter 用到的部分：classList、getBoundingClientRect */
function label(classes: string, x: number, y: number, w = 60, h = 16) {
  const set = new Set(classes.split(' '));
  return {
    classList: {
      contains: (c: string) => set.has(c),
      toggle: (c: string, on: boolean) => (on ? set.add(c) : set.delete(c)),
      [Symbol.iterator]: () => set.values(),
    },
    getBoundingClientRect: () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) as DOMRect,
    hidden: () => set.has('declutter-hidden'),
  };
}

describe('scene label decluttering (decision 0015)', () => {
  it('keeps the more important of two overlapping labels and leaves separate labels alone', () => {
    const cooler = label('scene-label area-label kind-COOLER', 100, 100);
    const staging = label('scene-label area-label kind-STAGING', 120, 104);
    const aisle = label('scene-label run-label', 300, 300);
    const aisle2 = label('scene-label run-label', 310, 302);
    const far = label('scene-label area-label kind-RACKS', 600, 100);
    const all = [cooler, staging, aisle, aisle2, far];
    const root = { querySelectorAll: () => all } as unknown as HTMLElement;
    expect(declutter(root)).toBe(2);
    // 暂存区（主要区域）比冷藏库优先；两个通道号重叠时留先出现的那个
    expect(staging.hidden()).toBe(false);
    expect(cooler.hidden()).toBe(true);
    expect(aisle.hidden()).toBe(false);
    expect(aisle2.hidden()).toBe(true);
    expect(far.hidden()).toBe(false);
    // 镜头拉近、不再重叠后重新显示
    const spread = [label('scene-label area-label kind-COOLER', 100, 100), label('scene-label area-label kind-STAGING', 400, 400)];
    expect(declutter({ querySelectorAll: () => spread } as unknown as HTMLElement)).toBe(0);
  });
});
