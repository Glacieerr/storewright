import { afterAll, describe, expect, it } from 'vitest';
import { TRACE_DAY } from '../src/analysis/studies';
import { planPark } from '../src/hub/park';
import { setRegion, STORE } from '../src/region/network';
import { DEFAULT_REGION, regionSpecFrom } from '../src/region/regionGen';
import { buildBoard } from '../src/sim/board';
import { LOADS, scenarioFor, withLoad, type LoadLevel } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, emptyDay } from '../src/sim/plan';
import { buildContainerJourney, type Journey, type PortBoxLike, type TourInput } from '../src/tour/container';

/** 按网页的做法搭导览的输入：当天的仿真、调度台、物流园的作业计划（港口三维计划的箱由各个用例自己给） */
function inputFor(level: LoadLevel, region = 'default'): TourInput {
  setRegion(region === 'default' ? DEFAULT_REGION : regionSpecFrom(region));
  const sc = withLoad(scenarioFor('g3', 1), level);
  sc.traceDay = TRACE_DAY;
  const r = runChain(sc);
  const trace = r.trace!;
  const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(sc), crossDock: sc.dc.crossDock });
  const byV = new Map(board.ops.filter((o) => o.vehicle >= 0).map((o) => [o.vehicle, o]));
  const place = (d?: string) => (d ? (d.startsWith('C') ? `DCC#${Number(d.slice(1)) - 1}` : `DC#${Number(d.slice(1)) - 1}`) : undefined);
  const park = planPark({ vehicles: trace.vehicles, doorOf: (vid, key) => (key === 'DC' ? place(byV.get(vid)?.door) : undefined), bookings: board.doors.flatMap((d) => d.bookings.map((b) => ({ door: b.door, t0: b.t0, t1: b.t1, mode: b.mode }))), palletsOf: (vid) => byV.get(vid)?.pallets, seed: 1, traffic: LOADS[level].traffic, tracks: 2 });
  return { vehicles: trace.vehicles, ops: board.ops, hubs: [park.hub], dwellDays: sc.port.dwellDays, crossDock: !!sc.dc.crossDock, freshRemainPct: r.store.freshRemainPct, storeKey: STORE.key };
}

/** 港口三维计划里的一个本店箱（和 web/src/three/ops/port.ts 写的步骤一样）：前一天晚上卸船、堆在 B1 箱区 */
const yesterdayBox: PortBoxLike = {
  id: 'SXCU 006574',
  store: true,
  stacked: -18180,
  slot: { block: 'B1', bay: 24, row: 5, tier: 4 },
  steps: [
    { t: -18364, text: '岸桥 QC1 从班轮上吊起（甲板 1 贝 2 列 3 层）' },
    { t: -18306, text: '放到场内集卡 T04' },
    { t: -18230, text: '开到 B1 箱区 24 贝' },
    { t: -18180, text: '龙门吊堆到 B1-24-5-4，等清关、提箱' },
  ],
};

function checkShape(j: Journey | undefined): asserts j is Journey {
  expect(j).toBeDefined();
  if (!j) return;
  expect(j.legs.length).toBeGreaterThanOrEqual(5);
  for (const l of j.legs) {
    expect(l.at).toBeGreaterThanOrEqual(0);
    expect(l.at).toBeLessThanOrEqual(86340);
    expect(['record', 'estimate', 'proxy']).toContain(l.source);
    expect(l.title.length && l.titleEn.length).toBeTruthy();
    expect(l.facts.length).toBeGreaterThan(0);
    for (const f of l.facts) expect(f.zh.length > 0 && f.en.length > 0 && !/\p{Script=Han}/u.test(f.en)).toBe(true);
    // 不是记录的段要说明为什么（估算或用今天的另一件货演示）
    if (l.source === 'proxy') expect(l.note).toBeDefined();
    if (l.note) expect(/\p{Script=Han}/u.test(l.note.en)).toBe(false);
  }
  // 最后三段一定是门店那几段：配送车、收货口、后仓上架
  expect(j.legs.slice(-3).map((l) => l.key)).toEqual(['dispatch', 'store', 'shelf']);
  expect(j.summary.zh).toContain(j.box);
}

describe('演示导览：一个集装箱从船到货架', () => {
  afterAll(() => setRegion(DEFAULT_REGION));

  it('默认区域、平常：前一天卸下的箱——港口几段是记录，堆场停留跨天跳过，后面用今天的同类作业演示', () => {
    const input = inputFor('normal');
    const j = buildContainerJourney({ ...input, portBoxes: [yesterdayBox] });
    checkShape(j);
    expect(j.mode).toBe('sea');
    expect(j.box).toBe('SXCU 006574');
    expect(j.legs.slice(0, 4).map((l) => l.key)).toEqual(['ship', 'discharge', 'yard', 'dwell']);
    const [ship, discharge, yard, dwell] = j.legs;
    expect(ship?.source).toBe('record');
    expect(discharge?.facts.some((f) => f.zh.includes('岸桥 QC1') && f.en.includes('Quay crane QC1'))).toBe(true);
    expect(discharge?.note?.zh).toContain('前一天');
    expect(yard?.where).toEqual({ kind: 'port-box', box: 'SXCU 006574' });
    expect(dwell?.source).toBe('estimate');
    expect(dwell?.skipDays).toBeCloseTo(input.dwellDays ?? 0, 5);
    expect(dwell?.note?.zh).toContain('跳过');
    // 这一天没有本店的集装箱拖车：拖车那一段按路网估算
    const dray = j.legs.find((l) => l.key === 'dray');
    expect(dray?.source).toBe('estimate');
    expect(j.legs.find((l) => l.key === 'store')?.source).toBe('record');
  });

  it('同样的输入两次结果一样', () => {
    const input = inputFor('normal');
    expect(buildContainerJourney({ ...input, portBoxes: [yesterdayBox] })).toEqual(buildContainerJourney({ ...input, portBoxes: [yesterdayBox] }));
  });

  it('没有港口三维计划时（孪生服务、命令行）：今天没有海运箱就改跟铁路班列的箱，拆箱那一段是同一列车的记录', () => {
    const j = buildContainerJourney(inputFor('normal'));
    checkShape(j);
    expect(j.mode).toBe('rail');
    expect(j.legs[0]?.key).toBe('train');
    expect(j.legs[0]?.note?.zh).toContain('铁路');
    expect(j.legs.find((l) => l.key === 'dc')?.source).toBe('record');
  });

  it('高负荷：今天有本店的集装箱拖车——拖车、配送中心拆箱都是记录，门店配送车按先进先出', () => {
    const input = inputFor('high');
    const dr = input.ops.find((o) => o.kind === 'drayage');
    expect(dr).toBeDefined();
    const j = buildContainerJourney(input);
    checkShape(j);
    expect(j.mode).toBe('sea');
    const dray = j.legs.find((l) => l.key === 'dray');
    const dc = j.legs.find((l) => l.key === 'dc');
    expect(dray?.source).toBe('record');
    expect(dray?.vehicle).toBe(dr?.vehicle);
    expect(dc?.source).toBe('record');
    expect(dc?.facts[0]?.zh).toContain(dr?.door ?? '?');
    // 港口三维计划把今天卸下的箱交给这辆拖车时：港口那几段也是记录，停留按记录算小时
    const box: PortBoxLike = { ...yesterdayBox, id: 'SXCU 100001', stacked: (dr?.t0 ?? 0) - 7200, pickup: (dr?.t0 ?? 0) - 300, dray: dr?.vehicle, steps: yesterdayBox.steps.map((s, i) => ({ ...s, t: (dr?.t0 ?? 0) - 7600 + i * 100 })) };
    const j2 = buildContainerJourney({ ...input, portBoxes: [box] });
    checkShape(j2);
    const dwell = j2.legs.find((l) => l.key === 'dwell');
    expect(dwell?.source).toBe('record');
    expect(dwell?.facts[0]?.zh).toContain('小时');
    expect(j2.legs.filter((l) => ['ship', 'discharge', 'yard', 'dwell', 'dray', 'dc'].includes(l.key)).every((l) => l.source === 'record')).toBe(true);
  });

  it('四个负荷、一个随机区域都能串出一条完整的路', () => {
    for (const level of ['peak', 'extreme'] as const) checkShape(buildContainerJourney(inputFor(level)));
    checkShape(buildContainerJourney({ ...inputFor('normal', 'random-3'), portBoxes: [yesterdayBox] }));
    checkShape(buildContainerJourney(inputFor('normal', 'random-3')));
  });
});
