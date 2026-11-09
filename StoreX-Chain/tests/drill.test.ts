import { describe, expect, it } from 'vitest';
import { cnNum, DRILL_TODAY, NOTICE_PRESETS, noticeDisruptions, parseNotice, playbooksFor, PLAYBOOKS, runDrill, SCORE_SCALE } from '../src/analysis/drill';

const preset = (k: string) => NOTICE_PRESETS.find((p) => p.key === k)?.text ?? '';

describe('通知解析', () => {
  it('中文数字', () => {
    expect(cnNum('两')).toBe(2);
    expect(cnNum('十')).toBe(10);
    expect(cnNum('十二')).toBe(12);
    expect(cnNum('二十')).toBe(20);
    expect(cnNum('3')).toBe(3);
    expect(cnNum('半')).toBe(0.5);
  });
  it('模板里的通知都认得出来', () => {
    const t = parseNotice(preset('typhoon'));
    expect(t).toMatchObject({ kind: 'typhoon', offset: 2, days: 3, severity: 2 });
    const s = parseNotice(preset('strike'));
    // 第 78 天是周二：下周一是 6 天后
    expect(DRILL_TODAY % 7).toBe(1);
    expect(s).toMatchObject({ kind: 'strike', offset: 6, days: 10, severity: 3 });
    expect(parseNotice(preset('holiday'))).toMatchObject({ kind: 'holiday', offset: 5, days: 5, uplift: 0.4 });
    expect(parseNotice(preset('highway'))).toMatchObject({ kind: 'highway', offset: 1, days: 3 });
    expect(parseNotice(preset('supplier'))).toMatchObject({ kind: 'supplier', offset: 1, days: 7 });
    expect(parseNotice(preset('storm'))).toMatchObject({ kind: 'storm', offset: 1, days: 2 });
  });
  it('自由的说法：预警颜色、星期几、小时、百分比、几成、几周', () => {
    expect(parseNotice('台风红色预警，超强台风周四登陆')).toMatchObject({ kind: 'typhoon', offset: 2, severity: 3 });
    expect(parseNotice('台风蓝色预警，3 天后登陆')).toMatchObject({ kind: 'typhoon', offset: 3, severity: 1 });
    expect(parseNotice('下周三起机场停航 36 小时')).toMatchObject({ kind: 'storm', offset: 8, days: 2 });
    expect(parseNotice('店庆大促，销量预计上涨 60%，持续一周')).toMatchObject({ kind: 'holiday', days: 7, uplift: 0.6 });
    expect(parseNotice('春节抢购，需求增加三成')?.uplift).toBeCloseTo(0.3);
    expect(parseNotice('供应商召回，断货两周')).toMatchObject({ kind: 'supplier', days: 14 });
    expect(parseNotice('今天天气不错')).toBeUndefined();
  });
  it('通知换成仿真里的扰动：台风 = 抢购 + 机场关闭 + 港口拥堵（红色预警再加高速封闭）', () => {
    const orange = noticeDisruptions(parseNotice(preset('typhoon')) as NonNullable<ReturnType<typeof parseNotice>>);
    expect(orange.map((x) => x.key)).toEqual(['demandSurge', 'airportClosed', 'portCongestion']);
    expect(orange[0]?.start).toBe(DRILL_TODAY);
    expect(orange[1]?.start).toBe(DRILL_TODAY + 2);
    const red = noticeDisruptions(parseNotice('台风红色预警，后天登陆') as NonNullable<ReturnType<typeof parseNotice>>);
    expect(red.map((x) => x.key)).toContain('highwayClosed');
    expect(playbooksFor(red).map((p) => p.key).sort()).toEqual(['airport', 'highway', 'port', 'surge']);
    // 扰动后 3 周都在仿真的计入时段里
    for (const x of red) expect(x.start + 21).toBeLessThan(126);
  });
});

describe('演练和预案', () => {
  it('每种扰动都有预案，每个预案都有负责人和步骤', () => {
    expect(new Set(PLAYBOOKS.map((p) => p.covers)).size).toBe(5);
    for (const p of PLAYBOOKS) {
      expect(p.owners.length).toBeGreaterThan(0);
      expect(p.steps.length).toBeGreaterThanOrEqual(3);
      expect(parseNotice(p.preset)).toBeDefined();
    }
  });
  it('供应商停产：启动预案（备用供应商）后几乎不缺货，得分高很多', () => {
    const r = runDrill(parseNotice(preset('supplier')) as NonNullable<ReturnType<typeof parseNotice>>, { seeds: [1, 2] });
    expect(r.playbooks).toEqual(['supplier']);
    expect(r.without.lostUnits).toBeGreaterThan(5000);
    expect(r.with.lostUnits).toBeLessThan(r.without.lostUnits * 0.1);
    expect(r.with.score).toBeGreaterThan(r.without.score + 30);
    expect(r.text).toMatch(/供应商断供预案/);
  });
  it('台风：几个预案一起启动，比不启动好，并给出每个预案单独的得分', () => {
    const n = parseNotice(preset('typhoon')) as NonNullable<ReturnType<typeof parseNotice>>;
    const r = runDrill(n, { seeds: [1] });
    expect(r.each.map((e) => e.key).sort()).toEqual(['airport', 'port', 'surge']);
    expect(r.with.score).toBeGreaterThan(r.without.score);
    expect(r.with.airDrop).toBeLessThan(r.without.airDrop);
    expect(r.series.base.length).toBe(r.series.with.length);
    // 得分是五项之和，在 0–100 之间
    for (const s of [r.with, r.without]) {
      const sum = s.parts.service + s.parts.stockout + s.parts.fresh + s.parts.late + s.parts.cost;
      expect(s.score).toBeCloseTo(sum, 6);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(Object.values(SCORE_SCALE).reduce((a, x) => a + x.points, 0));
    }
    // 同样的通知每次结果一样
    expect(JSON.stringify({ ...runDrill(n, { seeds: [1] }), ms: 0 })).toBe(JSON.stringify({ ...r, ms: 0 }));
  });
});
