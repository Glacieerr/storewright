import { describe, expect, it } from 'vitest';
import { agreeOne, lookup, t } from '../web/src/i18n';
import { EN } from '../web/src/i18n/en';

/**
 * 英文的单复数：数字从 {名字} 填进去、值正好是 1 时，后面的可数名词改单数，紧跟的动词跟着变；中文和别的数字不动。
 * Count-aware English: a filled-in "1" makes the following countable noun singular and the verb agree.
 */
const one = (s: string) => {
  const k = s.indexOf('1 ');
  return agreeOne(s, k, k + 1);
};

describe('English plurals after a filled-in 1', () => {
  it('makes the noun singular and the verb agree', () => {
    expect(one('1 trucks miss the receiving cutoff')).toBe('1 truck misses the receiving cutoff');
    expect(one('1 dispatch-board issues')).toBe('1 dispatch-board issue');
    expect(one('1 recommendation cards')).toBe('1 recommendation card');
    expect(one('1 more trucks due at Store')).toBe('1 more truck due at Store');
    expect(one('1 trucks are late')).toBe('1 truck is late');
    expect(one('1 trucks still need a door')).toBe('1 truck still needs a door');
    expect(one('1 ULDs')).toBe('1 ULD');
    expect(one('1 deliveries')).toBe('1 delivery');
    expect(one('1 Trucks')).toBe('1 Truck');
  });

  it('leaves numbers that are labels, decimals or ranges alone', () => {
    expect(one('Dock 1 trucks waiting')).toBe('Dock 1 trucks waiting');
    expect(one('day 1 pallets')).toBe('day 1 pallets');
    expect(agreeOne('0.1 trucks', 2, 3)).toBe('0.1 trucks');
    expect(one('1–2 trucks')).toBe('1–2 trucks');
    expect(one('1 of 3 trucks')).toBe('1 of 3 trucks');
    expect(one('1 h late')).toBe('1 h late');
  });

  it('applies when a dictionary pattern is filled (tx / lookup), not to other numbers', () => {
    const d = { '{n} 辆车赶不上收货截止': '{n} trucks miss the receiving cutoff', '调度台有 {n} 个问题': '{n} dispatch-board issues' };
    expect(lookup(d, '1 辆车赶不上收货截止')).toBe('1 truck misses the receiving cutoff');
    expect(lookup(d, '11 辆车赶不上收货截止')).toBe('11 trucks miss the receiving cutoff');
    expect(lookup(d, '2 辆车赶不上收货截止')).toBe('2 trucks miss the receiving cutoff');
    expect(lookup(d, '调度台有 1 个问题')).toBe('1 dispatch-board issue');
    // 嵌套的模式：里面一层填进去的 1
    expect(lookup(EN, '1 板')).toBe('1 pallet');
    expect(lookup(EN, '3 板')).toBe('3 pallets');
  });

  it('keeps the Chinese text unchanged (Chinese is the default outside the browser)', () => {
    expect(t('{n} 车', { n: 1 })).toBe('1 车');
    expect(t('还有 {n} trucks', { n: 1 })).toBe('还有 1 trucks');
  });
});
