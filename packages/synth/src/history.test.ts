import { describe, expect, it } from 'vitest';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, demandHours, generateDemandHistory, holidayOn, OBSERVABLE_ONLY } from './index';

const model = new StoreModel(createTemplate('medium'));
const scenario = DEFAULT_DEMAND.medium;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('synthetic demand history', () => {
  it('is deterministic for a seed and covers the order hours', () => {
    const a = generateDemandHistory(model, { seed: 3, days: 30, startDate: '2025-03-03', scenario });
    const b = generateDemandHistory(model, { seed: 3, days: 30, startDate: '2025-03-03', scenario });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(demandHours(model, scenario)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    for (const d of a.days) {
      expect(d.actual.orders).toBe(d.actual.hourly.reduce((x, y) => x + y, 0));
      expect(d.actual.pickup + d.actual.delivery).toBe(d.actual.orders);
    }
  });

  it('follows the public holiday rules', () => {
    expect(holidayOn(Date.UTC(2025, 10, 27))).toBe('THANKSGIVING');
    expect(holidayOn(Date.UTC(2025, 8, 1))).toBe('LABOR_DAY');
    expect(holidayOn(Date.UTC(2025, 4, 26))).toBe('MEMORIAL_DAY');
    expect(holidayOn(Date.UTC(2025, 6, 4))).toBe('INDEPENDENCE_DAY');
    expect(holidayOn(Date.UTC(2025, 6, 5))).toBeNull();
  });

  it('applies weekday, holiday and storm-warning effects', () => {
    const h = generateDemandHistory(model, { seed: 5, days: 365, startDate: '2025-01-01', scenario, factors: OBSERVABLE_ONLY });
    const sat = avg(h.days.filter((d) => d.dow === 6 && !d.observed.holiday && !d.observed.holidayEve).map((d) => d.expected.orders));
    const tue = avg(h.days.filter((d) => d.dow === 2 && !d.observed.holiday && !d.observed.holidayEve).map((d) => d.expected.orders));
    expect(sat / tue).toBeGreaterThan(1.2);
    const tg = h.days.find((d) => d.observed.holiday === 'THANKSGIVING');
    const eve = h.days.find((d) => d.date === '2025-11-26');
    expect(tg && eve && eve.expected.orders / tg.expected.orders).toBeGreaterThan(3);
    const warned = h.days.filter((d) => d.observed.stormWarningTomorrow);
    expect(warned.length).toBeGreaterThan(0);
    for (const d of warned) expect(d.hidden.weather).toBeGreaterThanOrEqual(1.25 * 0.8 - 1e-9);
    // 实际值与期望值的总量一致（泊松噪声）
    const exp = h.days.reduce((a, d) => a + d.expected.orders, 0);
    const act = h.days.reduce((a, d) => a + d.actual.orders, 0);
    expect(Math.abs(act / exp - 1)).toBeLessThan(0.02);
  });

  it('records hidden factors and keeps factor streams independent', () => {
    const on = generateDemandHistory(model, { seed: 9, days: 120, startDate: '2025-04-07', scenario, factors: { regimeShift: { day: 90, multiplier: 0.85 } } });
    const off = generateDemandHistory(model, { seed: 9, days: 120, startDate: '2025-04-07', scenario, factors: { promos: false, regimeShift: null } });
    // 关闭促销不改变天气抽样
    expect(on.days.map((d) => d.hidden.tempC)).toEqual(off.days.map((d) => d.hidden.tempC));
    expect(off.days.every((d) => d.observed.promoCategories.length === 0)).toBe(true);
    expect(on.days.filter((d) => d.observed.promoCategories.length === 2).length).toBeGreaterThan(100);
    expect(on.days.slice(90).every((d) => d.hidden.regime === 0.85)).toBe(true);
    expect(on.days.some((d) => d.hidden.localEvent !== 1)).toBe(true);
    // 模型可见的特征里没有隐藏因素
    expect(Object.keys(on.days[0]?.x ?? {})).not.toContain('localEvent');
    // 促销类别的行数明显高于平时的占比
    const cat = on.days[10]?.observed.promoCategories[0] as string;
    const promoDays = on.days.filter((d) => d.observed.promoCategories.includes(cat));
    const other = on.days.filter((d) => !d.observed.promoCategories.includes(cat));
    const share = (ds: typeof on.days) => avg(ds.map((d) => (d.actual.linesByCategory[cat] ?? 0) / Math.max(1, d.actual.lines)));
    expect(share(promoDays)).toBeGreaterThan(share(other) * 1.15);
  });

  it('hardware stores have their own demand shape: busy Saturdays, a spring peak, quiet holidays', () => {
    const hw = new StoreModel(createTemplate('hardware'));
    const h = generateDemandHistory(hw, { seed: 5, days: 365, startDate: '2025-01-01', scenario: DEFAULT_DEMAND.hardware, factors: { ...OBSERVABLE_ONLY, season: true } });
    const plain = (dow: number) => avg(h.days.filter((d) => d.dow === dow && !d.observed.holiday && !d.observed.holidayEve).map((d) => d.expected.orders / d.hidden.season));
    expect(plain(6) / plain(2)).toBeGreaterThan(1.6);
    const may = avg(h.days.filter((d) => d.date.startsWith('2025-05')).map((d) => d.hidden.season));
    const dec = avg(h.days.filter((d) => d.date.startsWith('2025-12')).map((d) => d.hidden.season));
    expect(may).toBeGreaterThan(1.15);
    expect(dec).toBeLessThan(0.9);
    const memorial = h.days.find((d) => d.observed.holiday === 'MEMORIAL_DAY');
    const xmas = h.days.find((d) => d.observed.holiday === 'CHRISTMAS');
    expect(memorial?.hidden.holiday).toBeGreaterThan(1.3);
    expect(xmas?.hidden.holiday).toBeLessThan(0.2);
    // 6 点开门，7 点就有订单（施工队）
    expect(h.hours[0]).toBe(7);
  });
});
