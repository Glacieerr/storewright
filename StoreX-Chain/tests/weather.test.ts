import { describe as group, expect, it } from 'vitest';
import { FrameBudget, TIERS } from '../web/src/three/quality';
import { dayKind, daySchedule, describe, speedFactor } from '../web/src/three/weather';

/** 天气只改画面：一天的天气按编号排、同一个编号每次一样；画质按帧时间自动升降档 */
group('天气', () => {
  it('同一个编号每次一样；默认的那一天（编号 1）是晴天；演练里的风暴整天是台风天', () => {
    expect(JSON.stringify(daySchedule(7))).toBe(JSON.stringify(daySchedule(7)));
    for (const s of daySchedule(1)) expect(describe(s).name).toBe('晴');
    for (const s of daySchedule(5, 'airportClosed')) expect(describe(s).name).toBe('台风');
    const warn = daySchedule(5, 'demandSurge');
    expect((warn[10] as { rain: number }).rain).toBe(0);
    expect((warn[23] as { rain: number }).rain).toBeGreaterThan(0.6);
  });

  it('一百天里晴和多云占多数，也有阵雨、大雾、阴雨的日子；雨停以后地面慢慢干', () => {
    const kinds = new Map<string, number>();
    for (let seed = 2; seed < 102; seed++) {
      const day = daySchedule(seed);
      const rainy = day.some((s) => s.rain > 0.12);
      const foggy = day.some((s) => s.fog > 0.6);
      const k = rainy ? 'rain' : foggy ? 'fog' : 'dry';
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      for (let h = 1; h < day.length; h++) {
        const a = day[h - 1] as { wet: number; rain: number };
        const b = day[h] as { wet: number; rain: number };
        if (b.rain <= 0.12) expect(b.wet).toBeLessThanOrEqual(a.wet + 1e-9);
      }
    }
    expect(kinds.get('dry') ?? 0).toBeGreaterThan(50);
    expect(kinds.get('rain') ?? 0).toBeGreaterThan(10);
    expect(kinds.get('fog') ?? 0).toBeGreaterThan(3);
  });

  it('相邻的两天天气类型不一样；每 10 天里晴 4 天、多云 2 天、午后阵雨 2 天、清早大雾 1 天、阴雨 1 天', () => {
    expect(dayKind(1)).toBe('clear');
    for (let s = 1; s < 3000; s++) expect(dayKind(s + 1)).not.toBe(dayKind(s));
    for (let b = 0; b < 60; b++) {
      const n: Record<string, number> = {};
      for (let s = b * 10 + 1; s <= b * 10 + 10; s++) n[dayKind(s)] = (n[dayKind(s)] ?? 0) + 1;
      expect(n).toEqual({ clear: 4, cloudy: 2, shower: 2, fog: 1, drizzle: 1 });
    }
    // 排出来的一天和类型对得上：阵雨、阴雨的日子下雨，大雾的日子起大雾，晴和多云的日子不下雨
    for (let s = 1; s < 300; s++) {
      const k = dayKind(s);
      const day = daySchedule(s);
      expect(day.some((x) => x.rain > 0.12)).toBe(k === 'shower' || k === 'drizzle');
      expect(day.some((x) => x.fog > 0.6)).toBe(k === 'fog');
    }
  });

  it('编号先打散再抽：小编号不再挤在同一种天气（以前第 2–5 天全是午后阵雨）', () => {
    const month = Array.from({ length: 30 }, (_, i) => dayKind(i + 2));
    expect(month.filter((k) => k === 'shower').length).toBeLessThanOrEqual(7);
    expect(new Set(month.slice(0, 7)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(month.slice(0, 4)).size).toBeGreaterThan(1);
  });

  it('对车速的影响：晴 1、雨约 0.85、大雾约 0.75、台风 0.6；能见度跟着变', () => {
    const s = (o: Partial<{ rain: number; fog: number; cloud: number; wind: number }>) => ({ rain: 0, fog: 0, cloud: 0.2, wind: 0.1, wet: 0, ...o });
    expect(speedFactor(s({}))).toBe(1);
    expect(speedFactor(s({ rain: 0.75 }))).toBeCloseTo(0.85, 2);
    expect(speedFactor(s({ fog: 0.9 }))).toBeCloseTo(0.75, 2);
    expect(speedFactor(s({ rain: 1, wind: 1 }))).toBe(0.6);
    expect(describe(s({})).visKm).toBe(20);
    expect(describe(s({ fog: 0.9 })).visKm).toBeLessThan(1);
  });
});

group('自动画质', () => {
  const feed = (b: FrameBudget, ms: number, from: number, to: number) => {
    let changed: string | undefined;
    for (let t = from; t < to; t += 16) {
      b.push(ms, t);
      changed = b.tick(t) ?? changed;
    }
    return changed;
  };

  it('一直超预算就降档（之间至少隔几秒），有余量再升回来；手机最多到「中」', () => {
    const b = new FrameBudget(false, 0);
    expect(b.tier).toBe('high');
    expect(feed(b, 16, 0, 5000)).toBeUndefined();
    expect(feed(b, 55, 5000, 12000)).toBe('mid');
    expect(feed(b, 55, 12000, 22000)).toBe('low');
    expect(feed(b, 10, 22000, 40000)).toBe('mid');
    const phone = new FrameBudget(true, 0);
    expect(phone.tier).toBe('mid');
    expect(feed(phone, 8, 0, 60000)).toBeUndefined();
  });

  it('对比回放的右半边：高档每帧画，中档隔一帧，低档隔两帧', () => {
    expect([TIERS.high.splitEvery, TIERS.mid.splitEvery, TIERS.low.splitEvery]).toEqual([1, 2, 3]);
  });

  it('偶尔掉一帧（33 毫秒）不降档；手动选了一档就不自动换', () => {
    const b = new FrameBudget(false, 0);
    let t = 0;
    for (; t < 20000; t += 16) {
      b.push(t % 160 < 16 ? 33.3 : 16.7, t);
      expect(b.tick(t)).toBeUndefined();
    }
    b.setMode('low', t);
    expect(feed(b, 8, t, t + 30000)).toBeUndefined();
    expect(b.tier).toBe('low');
  });
});
