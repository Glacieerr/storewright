import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRng, keyedUniform } from './rng';
import { firstMatch, type Rule } from './rules';
import { formatCustomerName, isValidLabelId, opaqueLabelId, shortCode } from './labels';
import { EventLog } from './events';

describe('确定性随机数', () => {
  it('同一种子生成同一序列', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('按键生成的数与调用顺序无关，且落在 [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.string(), fc.string(), (seed, stream, key) => {
        const u = keyedUniform(seed, stream, key);
        keyedUniform(seed, 'other', 'noise');
        expect(keyedUniform(seed, stream, key)).toBe(u);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
      }),
    );
  });

  it('泊松抽样的均值接近 λ', () => {
    const rng = createRng(7);
    let s = 0;
    for (let i = 0; i < 20000; i++) s += rng.poisson(4);
    expect(s / 20000).toBeCloseTo(4, 1);
  });
});

describe('规则引擎', () => {
  const rules: Rule<'A' | 'B' | 'C'>[] = [
    { id: 'heavy', when: { field: 'kg', op: 'gt', value: 10 }, then: 'A' },
    { id: 'gm-big', when: { all: [{ field: 'type', op: 'eq', value: 'GM' }, { field: 'kg', op: 'gte', value: 5 }] }, then: 'B' },
  ];
  it('按顺序返回第一条命中的规则', () => {
    expect(firstMatch(rules, { kg: 12, type: 'GM' }, 'C')).toEqual({ result: 'A', ruleId: 'heavy' });
    expect(firstMatch(rules, { kg: 6, type: 'GM' }, 'C')).toEqual({ result: 'B', ruleId: 'gm-big' });
    expect(firstMatch(rules, { kg: 6, type: 'GROCERY' }, 'C')).toEqual({ result: 'C' });
  });
  it('支持 any / not / in', () => {
    const r: Rule<'Y'>[] = [{ id: 'x', when: { any: [{ not: { field: 'z', op: 'in', value: [1, 2] } }] }, then: 'Y' }];
    expect(firstMatch(r, { z: 3 }, 'Y' as const).ruleId).toBe('x');
    expect(firstMatch(r, { z: 1 }, 'Y' as const).ruleId).toBeUndefined();
  });
});

describe('标签', () => {
  it('姓名显示规则（决策 L-02）', () => {
    expect(formatCustomerName('Wei', 'Zhang', 14)).toBe('Wei Zhang');
    expect(formatCustomerName('Alexandria', 'Konstantinopoulos', 14)).toBe('Alexandria K.');
    expect(formatCustomerName('Bartholomew-Jonathan', 'Featherstonehaugh', 14).length).toBeLessThanOrEqual(14);
  });

  it('姓名永远不超过长度上限', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), fc.string({ maxLength: 30 }), fc.integer({ min: 6, max: 24 }), (f, l, max) => {
        expect(formatCustomerName(f, l, max).length).toBeLessThanOrEqual(Math.max(max, 3 + (l.trim() ? 3 : 0)));
      }),
    );
  });

  it('二维码 ID 不含个人信息、带校验位、版本不同则 ID 不同', () => {
    const v1 = opaqueLabelId('O1-00001-T1', 1);
    const v2 = opaqueLabelId('O1-00001-T1', 2);
    expect(isValidLabelId(v1)).toBe(true);
    expect(v1).not.toBe(v2);
    expect(isValidLabelId(v1.slice(0, -1) + (v1.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(shortCode('O1-00001')).toMatch(/^[A-Z2-9]{4}$/);
  });
});

describe('事件日志', () => {
  it('序号递增，订阅者收到每条事件', () => {
    const log = new EventLog();
    const seen: number[] = [];
    log.subscribe((e) => seen.push(e.seq));
    log.append(10, 'ReadyToLoad', { orderId: 'A' });
    log.append(11, 'ReadyToLoad', { orderId: 'B' });
    expect(seen).toEqual([1, 2]);
    expect(log.events.map((e) => e.t)).toEqual([10, 11]);
  });
});

describe('GS1 条码数据（决策记录 0024 · G3）', () => {
  it('三种写法都能读出商品条码、批号、保质期、数量；送货单按商品和批号合并', async () => {
    const { formatGs1, gs1Date, parseDeliveryNote, parseGs1 } = await import('./gs1');
    expect(gs1Date('261130')).toBe('2026-11-30');
    expect(gs1Date('260200')).toBe('2026-02-28');
    expect(gs1Date('261332')).toBeUndefined();
    expect(parseGs1('(01)00012345678905(17)261130(10)L2310A(37)6')).toEqual({ gtin: '00012345678905', expiry: '2026-11-30', lot: 'L2310A', count: 6 });
    const GS = String.fromCharCode(29);
    expect(parseGs1(`]d201000123456789051726113010L2310A${GS}376`)).toEqual({ gtin: '00012345678905', expiry: '2026-11-30', lot: 'L2310A', count: 6 });
    expect(parseGs1('https://id.gs1.org/01/00012345678905/10/L2310A?17=261130')).toMatchObject({ gtin: '00012345678905', lot: 'L2310A', expiry: '2026-11-30' });
    expect(parseGs1('hello')).toBeUndefined();
    // 单独一个商品条码不是 GS1 数据（扫普通条码时不能误读）
    expect(parseGs1('012345678905')).toBeUndefined();
    expect(parseGs1('00012345678905')).toBeUndefined();
    const note = parseDeliveryNote(['(400)R0003', formatGs1({ gtin: '12345678905', lot: 'A1', expiry: '2026-12-01', count: 2 }), formatGs1({ gtin: '12345678905', lot: 'A1', count: 1 }), formatGs1({ gtin: '00036000291452', count: 3 })].join('\n'));
    expect(note?.order).toBe('R0003');
    expect(note?.lines).toEqual([
      { gtin: '00012345678905', cases: 3, lot: 'A1', expiry: '2026-12-01' },
      { gtin: '00036000291452', cases: 3 },
    ]);
  });
});
