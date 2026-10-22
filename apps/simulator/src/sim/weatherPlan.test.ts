import { describe, expect, it } from 'vitest';
import { fixedWeather, simWeather, weatherAt, weatherPlan } from './weatherPlan';

describe('多变天气', () => {
  it('同一种子和季节生成相同的计划；时段首尾相接覆盖 32 小时；夏天不下雪，冬天会下雪', () => {
    expect(weatherPlan(3, 'summer')).toEqual(weatherPlan(3, 'summer'));
    for (let seed = 1; seed <= 20; seed++) {
      const p = weatherPlan(seed, 'autumn');
      expect(p[0]?.start).toBe(0);
      expect(p[p.length - 1]?.end).toBe(32 * 3600);
      for (let i = 1; i < p.length; i++) expect(p[i]?.start).toBe(p[i - 1]?.end);
      expect(weatherPlan(seed, 'summer').some((s) => s.kind === 'snow')).toBe(false);
    }
    const winterSnow = Array.from({ length: 30 }, (_, i) => weatherPlan(i + 1, 'winter')).some((p) => p.some((s) => s.kind === 'snow'));
    expect(winterSnow).toBe(true);
  });

  it('状态都在 0–1 之间并平滑变化；雨停后路面在一小时内慢慢变干', () => {
    const plan = [
      { start: 0, end: 10 * 3600, kind: 'clear' as const, strength: 1 },
      { start: 10 * 3600, end: 12 * 3600, kind: 'rain' as const, strength: 1 },
      { start: 12 * 3600, end: 32 * 3600, kind: 'cloudy' as const, strength: 1 },
    ];
    let prev = weatherAt(plan, 9 * 3600).rain;
    for (let t = 9 * 3600; t <= 11 * 3600; t += 60) {
      const s = weatherAt(plan, t);
      for (const v of [s.cloud, s.rain, s.snow, s.fog, s.wet, s.snowCover]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1.0001);
      }
      expect(Math.abs(s.rain - prev)).toBeLessThan(0.05);
      prev = s.rain;
    }
    expect(weatherAt(plan, 11 * 3600).kind).toBe('rain');
    expect(weatherAt(plan, 12.5 * 3600).wet).toBeGreaterThan(0.3);
    expect(weatherAt(plan, 12.5 * 3600).wet).toBeLessThan(1);
    expect(weatherAt(plan, 13.5 * 3600).wet).toBe(0);
    expect(fixedWeather('rain').wet).toBe(1);
  });

  it('仿真参数：雨雪时段变成减速窗口，下雨的小时路更堵，订单量略增', () => {
    const plan = [
      { start: 0, end: 14 * 3600, kind: 'clear' as const, strength: 1 },
      { start: 14 * 3600, end: 16 * 3600, kind: 'rain' as const, strength: 0.8 },
      { start: 16 * 3600, end: 32 * 3600, kind: 'clear' as const, strength: 1 },
    ];
    const s = simWeather(plan, 7 * 3600, 22 * 3600);
    expect(s.windows).toEqual([{ kind: 'rain', start: 14 * 3600, end: 16 * 3600 }]);
    expect(s.trafficByHour[14]).toBeGreaterThan(1);
    expect(s.trafficByHour[10]).toBe(1);
    expect(s.demandK).toBeGreaterThan(1);
    expect(s.demandK).toBeLessThan(1.02);
  });
});
