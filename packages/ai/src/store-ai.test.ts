import { describe, expect, it } from 'vitest';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { generateCatalog, generatePickRecords, pickLocationsFromModel } from '@storewright/synth';
import { checkSchedule, scoreSchedule, DEFAULT_RELIABILITY, evaluateShelfFusion, fuseShelf, learnReliability, reliabilityOf, evaluatePickTime, fitPickTime, fixedHeads, generateSchedule, naiveSchedule, predictPickWalk, remainingPickSec, type PickWalkSample, type ScheduleAssociate, type ScheduleDemand } from './index';

/** 门店 AI 第二轮（决策记录 0021–0024）的模型 */

function pickSamples(seed = 3, days = 30) {
  const model = new StoreModel(createTemplate('medium'));
  const items = generateCatalog(model, { seed: 1 }).items;
  const locs = pickLocationsFromModel(model, items);
  const depot = model.config.layout.points.cartDepot;
  const { walks, truth } = generatePickRecords(locs, { seed, days, depot });
  const samples: PickWalkSample[] = walks.map((w, i) => ({ t: i, hour: w.hour, tenure: w.tenure, lines: w.lines, standardSec: w.standardSec, actualSec: w.actualSec, overheadSec: w.overheadSec }));
  return { samples, truth, locs };
}

describe('拣货时长预测（决策记录 0021 · B1）', () => {
  it('学到的模型比标准工时和「标准工时 × 实测比例」都准，区间覆盖率接近 80%', () => {
    const { samples } = pickSamples();
    const ev = evaluatePickTime(samples);
    const m = ev.metrics;
    expect(ev.n).toBeGreaterThan(200);
    expect(m['pick-model'].wape).toBeLessThan(m['pick-standard-ratio'].wape as number);
    expect(m['pick-standard-ratio'].wape).toBeLessThan(m['pick-standard'].wape as number);
    expect(m['pick-model'].coverage80).toBeGreaterThan(0.65);
    expect(m['pick-model'].coverage80).toBeLessThan(0.95);
  });

  it('收缩后的货位难度和真实难度同方向；难找的货位、新员工、高峰都让预测变长', () => {
    const { samples, truth } = pickSamples(5, 40);
    const p = fitPickTime(samples, 'pick-model');
    const ids = Object.keys(p.loc).filter((id) => truth.locationFactor[id] !== undefined);
    const xs = ids.map((id) => Math.log(truth.locationFactor[id] as number));
    const ys = ids.map((id) => p.loc[id] as number);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const cov = xs.reduce((a, x, i) => a + (x - mx) * ((ys[i] as number) - my), 0);
    expect(cov).toBeGreaterThan(0);
    const w = samples[samples.length - 1] as PickWalkSample;
    const mid = predictPickWalk(p, { ...w, tenure: 'MID', hour: 10 });
    expect(predictPickWalk(p, { ...w, tenure: 'NEW', hour: 10 }).sec).toBeGreaterThan(mid.sec);
    expect(predictPickWalk(p, { ...w, tenure: 'MID', hour: 18 }).sec).toBeGreaterThan(mid.sec);
    expect(mid.low).toBeLessThan(mid.sec);
    expect(mid.high).toBeGreaterThan(mid.sec);
    expect(mid.reasons.length).toBeGreaterThan(0);
  });

  it('拣货进行中：做得慢的批次剩余用时会往上修正', () => {
    const { samples } = pickSamples(7, 20);
    const p = fitPickTime(samples, 'pick-model');
    const w = samples.find((x) => x.lines.length >= 10) as PickWalkSample;
    const pred = predictPickWalk(p, w);
    const half = Math.floor(w.lines.length / 2);
    const onPlan = pred.lines.slice(0, half).reduce((a, b) => a + b, 0) + p.overheadSec * 0.6;
    const normal = remainingPickSec(p, w, half, onPlan);
    const slow = remainingPickSec(p, w, half, onPlan * 1.6);
    expect(slow).toBeGreaterThan(normal);
    expect(remainingPickSec(p, w, w.lines.length, onPlan * 2)).toBeLessThan(normal);
  });
});

describe('排班生成（决策记录 0022 · D1）', () => {
  const team: ScheduleAssociate[] = [
    ...['P1', 'P2', 'P3', 'P4'].map((id) => ({ id, role: 'PICK', skills: ['STAGE'] })),
    ...['S1', 'S2'].map((id) => ({ id, role: 'PICK', employment: 'STUDENT' as const })),
    ...['H1', 'H2', 'H3'].map((id) => ({ id, role: 'HANDOFF', skills: ['STAGE'] })),
    { id: 'H4', role: 'HANDOFF', employment: 'STUDENT' as const },
    { id: 'T1', role: 'STAGE', skills: ['PICK', 'HANDOFF'], employment: 'PART_TIME' as const },
    { id: 'B1', role: 'BACKROOM', availability: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: 6 * 60, to: 15 * 60 })) },
  ];
  // 需求：拣货 8–20 点 2 人、傍晚 16–19 点 3 人；交付 9–21 点 1 人、17–20 点 2 人；暂存 10–19 点 1 人；后仓 6–14 点 1 人
  const demand: ScheduleDemand[] = [];
  for (let day = 0; day < 7; day++) {
    const pick = fixedHeads(8, 20, 2).map((v, k) => (k >= 32 && k < 38 ? 3 : v));
    const handoff = fixedHeads(9, 21, 1).map((v, k) => (k >= 34 && k < 40 ? 2 : v));
    demand.push({ day, role: 'PICK', slots: pick }, { day, role: 'HANDOFF', slots: handoff }, { day, role: 'STAGE', slots: fixedHeads(10, 19, 1) }, { day, role: 'BACKROOM', slots: fixedHeads(6, 14, 1) });
  }

  it('硬约束全部满足；缺口和多排都比「每人从早上排满 8 小时」的固定班表少；学生只排放学后', () => {
    const ai = generateSchedule({ associates: team, demand });
    expect(ai.metrics.violations).toEqual([]);
    expect(checkSchedule(ai.shifts, team)).toEqual([]);
    const naive = naiveSchedule({ associates: team, demand });
    expect(ai.metrics.underHours).toBeLessThan(naive.metrics.underHours);
    expect(ai.metrics.overHours).toBeLessThan(naive.metrics.overHours);
    for (const s of ai.shifts.filter((x) => x.associateId === 'S1' || x.associateId === 'S2' || x.associateId === 'H4')) {
      if (s.day <= 4) expect(s.from).toBeGreaterThanOrEqual(16 * 60);
      expect(s.to - s.from).toBeLessThanOrEqual(s.day <= 4 ? 240 : 360);
    }
    for (const a of team) expect(ai.metrics.hoursBy[a.id] ?? 0).toBeLessThanOrEqual(a.employment === 'STUDENT' ? 20 : a.employment === 'PART_TIME' ? 28 : 40);
  });

  it('排不上的缺口写明原因（例如后仓只有一个人、周末他也要休息）', () => {
    const ai = generateSchedule({ associates: team, demand });
    const backroom = ai.gaps.filter((g) => g.role === 'BACKROOM');
    expect(backroom.length).toBeGreaterThan(0);
    expect(backroom.every((g) => g.why === 'NO_ONE_AVAILABLE' || g.why === 'WEEKLY_LIMIT')).toBe(true);
    // 违反约束的班表能被检查出来
    expect(checkSchedule([{ associateId: 'S1', day: 1, from: 10 * 60, to: 15 * 60, role: 'PICK' }], team).length).toBeGreaterThan(0);
  });

  it('改过的班表重新打分（决策记录 0026）：不改时和草稿一样；删掉一个班工时变少、缺口不会变小；改出来的问题能查出来', () => {
    const ai = generateSchedule({ associates: team, demand });
    expect(scoreSchedule(ai.shifts, team, demand).metrics).toEqual(ai.metrics);
    const first = ai.shifts[0];
    if (!first) throw new Error('no shift');
    const removed = scoreSchedule(ai.shifts.slice(1), team, demand);
    expect(removed.metrics.totalHours).toBeLessThan(ai.metrics.totalHours);
    expect(removed.metrics.underHours).toBeGreaterThanOrEqual(ai.metrics.underHours);
    expect((removed.cover[first.day]?.[first.role] ?? []).reduce((n, x) => n + x, 0)).toBeLessThan((ai.cover[first.day]?.[first.role] ?? []).reduce((n, x) => n + x, 0));
    const twice = scoreSchedule([...ai.shifts, { ...first, from: first.from + 60, to: first.to + 60 }], team, demand);
    expect(twice.metrics.violations.some((v) => v.startsWith(`${first.associateId}: two shifts`))).toBe(true);
  });
});

describe('多源货架真相（决策记录 0022 · C1）', () => {
  it('加上拣货员的「找不到 / 拣到了」后，Brier 分数更低、整批找不到更早被认出来', () => {
    const ev = evaluateShelfFusion(3);
    expect(ev.metrics.fused.brier).toBeLessThan(ev.metrics.silence.brier);
    expect(ev.metrics.fused.detectH).toBeLessThan(ev.metrics.silence.detectH);
    expect(ev.metrics.fused.n).toBeGreaterThan(10);
  });

  it('报告「货位上是别的东西」时放错地方的概率高；数货架的结果会更新每种报告的可靠度', () => {
    const now = 10 * 3_600_000;
    const elsewhere = fuseShelf({ pPrior: 0.9, signals: [{ kind: 'NOT_FOUND_ELSEWHERE', at: now - 600_000 }], now });
    const damaged = fuseShelf({ pPrior: 0.9, signals: [{ kind: 'NOT_FOUND_DAMAGED', at: now - 600_000 }], now });
    expect(elsewhere.pOn).toBeLessThan(0.5);
    expect(elsewhere.pMisplaced).toBeGreaterThan(damaged.pMisplaced);
    // 旧的报告权重低
    const old = fuseShelf({ pPrior: 0.9, signals: [{ kind: 'NOT_FOUND_EMPTY', at: now - 8 * 3_600_000 }], now });
    expect(old.pOn).toBeGreaterThan(fuseShelf({ pPrior: 0.9, signals: [{ kind: 'NOT_FOUND_EMPTY', at: now - 600_000 }], now }).pOn);
    // 报告「价签不对」但数出来有货：这种报告的可靠度下降
    const r1 = learnReliability(DEFAULT_RELIABILITY, [{ kind: 'NOT_FOUND_TAG', at: now }], 5);
    expect(reliabilityOf(r1, 'NOT_FOUND_TAG')).toBeLessThan(reliabilityOf(DEFAULT_RELIABILITY, 'NOT_FOUND_TAG'));
    // 附近找一找时在附近找到（放回原货位后数出 3 件）：「不在原位」的报告算对，同一批「拣到了」算错
    const r2 = learnReliability(DEFAULT_RELIABILITY, [{ kind: 'NOT_FOUND_ELSEWHERE', at: now }, { kind: 'PICKED_OK', at: now - 600_000 }], 3, 'NEARBY');
    expect(r2.NOT_FOUND_ELSEWHERE).toEqual({ hit: DEFAULT_RELIABILITY.NOT_FOUND_ELSEWHERE.hit + 1, miss: DEFAULT_RELIABILITY.NOT_FOUND_ELSEWHERE.miss });
    expect(r2.PICKED_OK.miss).toBe(DEFAULT_RELIABILITY.PICKED_OK.miss + 1);
  });
});

describe('未取订单的风险（决策记录 0023 · B5）', () => {
  it('逻辑回归比「没报预计到达」的规则更准（Brier 更低、风险最高的一成抓到更多爽约）；以前爽约过、没报预计到达的风险高', async () => {
    const { generateNoShowRecords } = await import('@storewright/synth');
    const { evaluateNoShow, fitNoShow, predictNoShow } = await import('./index');
    const rows = generateNoShowRecords({ seed: 3 });
    expect(rows.length).toBeGreaterThan(5000);
    const rate = rows.filter((r) => r.noShow).length / rows.length;
    expect(rate).toBeGreaterThan(0.02);
    expect(rate).toBeLessThan(0.2);
    const ev = evaluateNoShow(rows);
    expect(ev.metrics['noshow-logistic'].brier).toBeLessThan(ev.metrics['noshow-rule'].brier as number);
    expect(ev.metrics['noshow-logistic'].auc).toBeGreaterThan(0.7);
    expect(ev.metrics['noshow-logistic'].captureTop10).toBeGreaterThanOrEqual(ev.metrics['noshow-rule'].captureTop10 as number);
    const p = fitNoShow(rows);
    const risky = predictNoShow(p, { aheadH: 60, slotHour: 20, dow: 2, rain: true, etaShared: false, pastOrders: 4, pastNoShows: 2 });
    const safe = predictNoShow(p, { aheadH: 2, slotHour: 12, dow: 2, rain: false, etaShared: true, pastOrders: 10, pastNoShows: 0 });
    expect(risky.p).toBeGreaterThan(0.3);
    expect(safe.p).toBeLessThan(0.05);
    expect(risky.reasons.map((r) => r.factor)).toContain('NO_ETA');
  });
});

describe('时段产能的取舍（决策记录 0023 · B6）', () => {
  it('接单上限越松，接的单越多、迟到越多；按产能估计接单时迟到明显少于不设上限', async () => {
    const { capacityCurve, estimateSlotCapacity } = await import('./index');
    const slots = Array.from({ length: 10 }, (_, k) => ({ start: (10 + k) * 60, demand: k === 6 || k === 7 ? 40 : 18 }));
    const day = { slots, slotMin: 60, pickers: slots.map(() => 3), perOrderMin: 7 };
    const caps = estimateSlotCapacity(day);
    expect(caps[0]).toBe(Math.floor((3 * 60 * 0.85) / 7));
    const curve = capacityCurve(day, [0.8, 1, Infinity], 15);
    const [tight, est, open] = curve as [(typeof curve)[number], (typeof curve)[number], (typeof curve)[number]];
    expect(tight.accepted).toBeLessThanOrEqual(est.accepted);
    expect(est.accepted).toBeLessThan(open.accepted);
    expect(tight.late).toBeLessThanOrEqual(est.late);
    expect(est.latePct).toBeLessThan(open.latePct);
  });
});

describe('替代推荐 2.0（决策记录 0023 · B4）', () => {
  it('个性化：用顾客自己以前的反应调整后，第一名的期望接受率不比全店模型差，离上限还有距离；给出值不值得做的结论', async () => {
    const { createTemplate, StoreModel } = await import('@storewright/store-config');
    const { generateCatalog, generateSubstitutionEvents } = await import('@storewright/synth');
    const { evaluatePersonalization } = await import('./index');
    const model = new StoreModel(createTemplate('medium'));
    const catalog = generateCatalog(model, { seed: 7 });
    const logs = generateSubstitutionEvents(catalog.items, { seed: 5, events: 6000, customers: 300 });
    expect(logs.every((l) => l.customer)).toBe(true);
    const r = evaluatePersonalization(logs, catalog.byId);
    expect(r.n).toBeGreaterThan(1000);
    expect(r.repeatShare).toBeGreaterThan(0.5);
    expect(r.personal).toBeGreaterThanOrEqual(r.global - 0.005);
    expect(r.oracle).toBeGreaterThan(r.personal);
    expect(typeof r.worth).toBe('boolean');
  });

  it('商品属性补充：规则从商品名里抽口味和规格，准确率高；没写在名字里的有机标签抽不出来', async () => {
    const { createTemplate, StoreModel } = await import('@storewright/store-config');
    const { generateCatalog } = await import('@storewright/synth');
    const { evaluateAttributes, extractAttributes } = await import('./index');
    expect(extractAttributes('Acme Potato Chips Sea Salt 8 oz')).toMatchObject({ flavor: 'sea salt', size: '8 oz' });
    expect(extractAttributes('Organic Gluten-Free Oat Bites')).toMatchObject({ organic: true, glutenFree: true, flavor: 'oat' });
    const model = new StoreModel(createTemplate('medium'));
    const catalog = generateCatalog(model, { seed: 7 });
    const ev = evaluateAttributes(catalog.items);
    expect(ev.flavor.precision).toBeGreaterThan(0.6);
    expect(ev.organic.recall).toBeLessThan(0.5);
  });
});

describe('临期与损耗（决策记录 0024 · C4）', () => {
  it('卖不完的概率：前面还有更早的批次时更高、快到期时更高；降价后变低；仿真里按概率处理比不处理损耗少', async () => {
    const { evaluateMarkdown, expiryAdvice, lotRisk, nbCdf } = await import('./index');
    expect(nbCdf(10, 1000)).toBeCloseTo(1, 6);
    expect(nbCdf(10, 5)).toBeLessThan(nbCdf(10, 10));
    const base = { unitsAhead: 0, units: 20, hoursLeft: 48, velocity: 0.3 };
    expect(lotRisk({ ...base, unitsAhead: 15 })).toBeGreaterThan(lotRisk(base));
    expect(lotRisk({ ...base, hoursLeft: 24 })).toBeGreaterThan(lotRisk(base));
    expect(lotRisk(base, 1.4)).toBeLessThan(lotRisk(base));
    // 多半卖得完：不处理
    expect(expiryAdvice({ unitsAhead: 0, units: 4, hoursLeft: 96, velocity: 0.5 }).action).toBe('NONE');
    // 降价后剩下的更少
    const { expectedLeftover } = await import('./index');
    expect(expectedLeftover(base, 1.6)).toBeLessThan(expectedLeftover(base));
    // 还有两天以上、风险中等：先移到显眼位置（不花钱）
    expect(expiryAdvice({ unitsAhead: 0, units: 20, hoursLeft: 60, velocity: 0.3 }).action).toBe('VISIBLE');
    // 毛利低（进价接近售价）、会剩很多：降价比报废损失小
    const a = expiryAdvice({ unitsAhead: 0, units: 40, hoursLeft: 40, velocity: 0.3 }, { price: 1, cost: 0.9 });
    expect(a.action).toBe('MARKDOWN');
    expect(a.riskAfter).toBeLessThan(a.risk);
    // 毛利高时同样的情况不降价（让掉的钱比省下的报废多）
    expect(expiryAdvice({ unitsAhead: 0, units: 40, hoursLeft: 40, velocity: 0.3 }, { price: 4, cost: 2 }).action).toBe('NONE');
    expect(expiryAdvice({ unitsAhead: 10, units: 30, hoursLeft: 20, velocity: 0.2 }).action).toBe('DONATE');
    const ev = evaluateMarkdown(3);
    expect(ev.model.totalLoss).toBeLessThan(ev.none.totalLoss);
    expect(ev.model.wasteUnits).toBeLessThan(ev.none.wasteUnits);
  });
});

describe('召回处理（决策记录 0024 · C5）', () => {
  it('合成召回通知（不同写法、中英文）：条码、批号、日期、原因都抽得出来；匹配一个不漏（召回率 100%）', async () => {
    const { createTemplate, StoreModel } = await import('@storewright/store-config');
    const { generateCatalog } = await import('@storewright/synth');
    const { evaluateRecall, generateRecallNotices, matchRecall, parseRecallNotice } = await import('./index');
    const model = new StoreModel(createTemplate('medium'));
    const catalog = generateCatalog(model, { seed: 7 });
    const items = catalog.items.filter((i) => i.fulfillmentType === 'GROCERY');
    for (const seed of [1, 2, 3]) {
      const ev = evaluateRecall(generateRecallNotices(items, seed), items);
      expect(ev.matchRecall).toBe(1);
      expect(ev.lot).toBeGreaterThanOrEqual(0.95);
      expect(ev.dates).toBeGreaterThanOrEqual(0.95);
      expect(ev.gtin).toBe(1);
    }
    const p = parseRecallNotice('召回通知：召回「Acme Peanut Butter 340 g」，批次 L2310 开头，保质期 2026年11月1日 至 2026年11月30日。原因：可能受沙门氏菌污染。');
    expect(p).toMatchObject({ product: 'Acme Peanut Butter', size: '340 g', lots: ['L2310'], from: '2026-11-01', to: '2026-11-30', reason: 'SALMONELLA' });
    // 只有品牌对上的不列出来
    const it0 = items[0] as (typeof items)[number];
    const brand = String(it0.attributes.brand ?? '');
    expect(matchRecall({ product: `${brand} Nonexistent Widget`, gtins: [], lots: [] }, items).length).toBe(0);
  });
});

describe('语音命令（决策记录 0024 · G2）', () => {
  it('中文、英文、西班牙语的命令词；数量（含中文数字）；记一下；问题交给助手', async () => {
    const { parseVoiceCommand, zhNumber } = await import('./index');
    expect(zhNumber('十二')).toBe(12);
    expect(zhNumber('二十')).toBe(20);
    expect(zhNumber('三')).toBe(3);
    expect(parseVoiceCommand('下一个')).toEqual({ kind: 'NEXT' });
    expect(parseVoiceCommand('Next')).toEqual({ kind: 'NEXT' });
    expect(parseVoiceCommand('siguiente')).toEqual({ kind: 'NEXT' });
    expect(parseVoiceCommand('找不到')).toEqual({ kind: 'NOT_FOUND' });
    expect(parseVoiceCommand("I can't find it")).toEqual({ kind: 'NOT_FOUND' });
    expect(parseVoiceCommand('no lo encuentro')).toEqual({ kind: 'NOT_FOUND' });
    expect(parseVoiceCommand('数量 3')).toEqual({ kind: 'QTY', qty: 3 });
    expect(parseVoiceCommand('拣了两件')).toEqual({ kind: 'QTY', qty: 2 });
    expect(parseVoiceCommand('quantity three')).toEqual({ kind: 'QTY', qty: 3 });
    expect(parseVoiceCommand('cantidad 4')).toEqual({ kind: 'QTY', qty: 4 });
    expect(parseVoiceCommand('记一下：冷冻 3 号门把手松了')).toEqual({ kind: 'NOTE', text: '冷冻 3 号门把手松了' });
    expect(parseVoiceCommand('note: aisle 7 light is out')).toEqual({ kind: 'NOTE', text: 'aisle 7 light is out' });
    expect(parseVoiceCommand('花生酱在哪里？').kind).toBe('ASK');
    expect(parseVoiceCommand('嗯').kind).toBe('UNKNOWN');
  });
});
