import { ci95, pairedDiff } from '../../../StoreX/src/core/stats';
import { runChain, type ChainResult } from '../sim/engine';
import { g1, g2, g3, type ChainScenario, type DisruptionKey, type Gen } from '../sim/config';
import { planFlows } from '../sim/flows';
import { FAMILIES } from '../region/products';
import { KPIS, type Kpi } from './kpi';

/**
 * 实验：三代对比、全链路方案的决策扫描、需求增长、压力演练。
 * 同一个种子下三代面对同样的需求、促销和船期（公共随机数），结论看配对差值的 95% 置信区间。
 */
export const seedsOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

let onRun: (() => void) | undefined;
export function setProgress(fn: (() => void) | undefined): void {
  onRun = fn;
}
export function run(s: ChainScenario): ChainResult {
  const r = runChain(s);
  onRun?.();
  return r;
}

export const MAKERS: Record<Gen, (seed: number) => ChainScenario> = { g1, g2, g3 };

// —— 三代对比 ——
export interface Arm {
  gen: Gen;
  label: string;
  runs: ChainResult[];
}
export interface PairRow {
  kpi: Kpi;
  a: { mean: number; half: number };
  b: { mean: number; half: number };
  diff: { mean: number; half: number; significant: boolean };
  pct: number;
  verdict: '改善' | '变差' | '无显著差异' | '—';
}

export function threeGens(seeds: readonly number[]): Arm[] {
  return (['g1', 'g2', 'g3'] as Gen[]).map((gen) => ({ gen, label: gen === 'g1' ? '上一代' : gen === 'g2' ? 'StoreX' : 'StoreX 全链路', runs: seeds.map((seed) => run(MAKERS[gen](seed))) }));
}

export function pair(a: Arm, b: Arm, kpis: readonly Kpi[] = KPIS): PairRow[] {
  return kpis.map((k) => {
    const xa = a.runs.map(k.get);
    const xb = b.runs.map(k.get);
    const diff = pairedDiff(xa, xb);
    const ma = ci95(xa);
    const mb = ci95(xb);
    const pct = Math.abs(ma.mean) > 1e-9 ? (diff.mean / Math.abs(ma.mean)) * 100 : 0;
    let verdict: PairRow['verdict'] = '—';
    if (k.better !== 'none') verdict = !diff.significant ? '无显著差异' : (diff.mean < 0) === (k.better === 'lower') ? '改善' : '变差';
    return { kpi: k, a: ma, b: mb, diff, pct, verdict };
  });
}

// —— 全链路方案的决策扫描（每次只改一项，其余保持 StoreX 全链路） ——
export interface SweepSpec {
  key: string;
  title: string;
  question: string;
  values: readonly (number | string)[];
  label: (v: number | string) => string;
  /** 图上的短标签（不给就用 label） */
  short?: (v: number | string) => string;
  apply: (s: ChainScenario, v: number | string) => void;
  kpis: readonly string[];
  chart: string;
  chosen: number | string;
  /** 「不做这一项」时的取值（举措单独值多少，和它比）；不给就是第一个值 */
  baseline?: number | string;
  /** 表格下面的说明（mean(取值, 指标) 取扫描结果的平均） */
  note?: (mean: (value: number | string, key: string) => number) => string;
}

/** 自动化比例 → 混合拣货效率、固定工时（技术员和监控） */
export function automation(s: ChainScenario, share: number): void {
  s.dc.automationShare = share;
  s.dc.pickRate = Math.round(1 / (share / 1200 + (1 - share) / 180));
  s.dc.receiveRate = Math.round(22 + 15 * share);
  s.dc.loadRate = Math.round(30 + 12 * share);
  s.dc.fixedHours = Math.round(16 + 5 * share);
}

/** 全链路方案的货流规划选了直送门店的商品族 */
const PLANNED = planFlows(g3(1)).filter((d) => d.via === 'direct');

export const SWEEPS: readonly SweepSpec[] = [
  {
    key: 'automation',
    title: '配送中心自动化的比例',
    question: '多少比例的箱交给自动化系统拣？',
    values: [0, 0.4, 0.6, 0.8, 0.95],
    label: (v) => `${Math.round((v as number) * 100)}%`,
    apply: (s, v) => automation(s, v as number),
    kpis: ['dcLabor', 'casesPerHour', 'costDc', 'dcFill'],
    chart: 'dcLabor',
    chosen: 0.8,
  },
  {
    key: 'consolidation',
    title: '多温区合并配送',
    question: '门店每天的配送车把几个温区的货装在一起（多温区车、动态线路），还是按温区分开送（外加面包房直送）？',
    values: ['split', 'multi'],
    label: (v) => (v === 'multi' ? '多温区合并、动态线路' : '按温区分开、固定线路、面包房直送'),
    apply: (s, v) => {
      if (v === 'split') {
        const old = g2(s.seed);
        s.fleet = { ...s.fleet, consolidated: false, dynamicRouting: false, bakeryDsd: true, windows: old.fleet.windows, dueBy: old.fleet.dueBy, maxStops: 3 };
        s.store.deliveryDays = old.store.deliveryDays;
      }
    },
    kpis: ['arrivals', 'trips', 'vanTrips', 'outKm', 'fill', 'fleet', 'storeInv', 'costTransport'],
    chart: 'outKm',
    chosen: 'multi',
  },
  {
    key: 'ev',
    title: '电动配送车的比例',
    question: '城市配送用多少电动车？',
    values: [0, 0.3, 0.6, 0.9],
    label: (v) => `${Math.round((v as number) * 100)}%`,
    apply: (s, v) => (s.fleet.evShare = v as number),
    kpis: ['evShare', 'co2Local', 'costTransport'],
    chart: 'co2Local',
    chosen: 0.6,
  },
  {
    key: 'rail',
    title: '港口集装箱走铁路的比例',
    question: '港口到物流园的集装箱多少走铁路？',
    values: [0, 0.3, 0.6, 0.9],
    label: (v) => `${Math.round((v as number) * 100)}%`,
    apply: (s, v) => (s.port.railShare = v as number),
    kpis: ['railShare', 'seaLead', 'co2Local', 'costTransport', 'service'],
    chart: 'co2Local',
    chosen: 0.6,
  },
  {
    key: 'dwell',
    title: '港口预清关和提箱预约',
    question: '集装箱在堆场的停留能缩到多短、值多少？',
    values: [4.5, 3, 1.6, 1],
    label: (v) => `平均 ${v} 天`,
    apply: (s, v) => {
      s.port.dwellDays = v as number;
      s.port.gateWaitHours = (v as number) >= 3 ? 1.6 : 0.3;
    },
    kpis: ['dwell', 'seaLead', 'demurrage', 'workingCapital', 'service'],
    chart: 'workingCapital',
    chosen: 1.6,
  },
  {
    key: 'review',
    title: '国内供应商的补货频率（供应商管理库存）',
    question: '进配送中心的长途公路货（全链路里是长尾常温货和冷冻货；不含每天下单的生鲜），配送中心隔几天下一次单？',
    values: [1, 2, 4, 7],
    label: (v) => `每 ${v} 天`,
    apply: (s, v) => (s.dc.reviewDays.domestic = v as number),
    kpis: ['dcInv', 'dcFill', 'inboundLoads', 'costCarrying', 'costTransport', 'co2Local', 'costTotal'],
    chart: 'costTotal',
    chosen: 4,
    baseline: 7,
  },
  {
    key: 'direct',
    title: '长途整车直送门店',
    question: '长途公路来的整车（国内和跨境），哪些直送门店、哪些先进配送中心？海运、铁路班列、空运的货都要先进配送中心，不在这里比。',
    values: ['none', 'planned', 'all'],
    label: (v) => (v === 'none' ? '全部进配送中心' : v === 'planned' ? `按货流规划（${PLANNED.map((f) => f.label).join('、')}直送）` : '不易腐的全部直送（再加长尾常温、冷冻）'),
    short: (v) => (v === 'none' ? '全部进配送中心' : v === 'planned' ? '按货流规划' : '加长尾冷冻'),
    apply: (s, v) => {
      if (v === 'none') s.flow.direct = [];
      else if (v === 'all') s.flow.direct = FAMILIES.filter((f) => f.source === 'domestic' && !(f.life !== undefined && f.life < 20)).map((f) => f.key);
    },
    kpis: ['directShare', 'arrivals', 'peakAmbient', 'peakFrozen', 'storeInv', 'dcLabor', 'outKm', 'costTransport', 'costTotal', 'service'],
    chart: 'costTotal',
    chosen: 'planned',
    baseline: 'none',
    note: (mean) =>
      `「不易腐的全部直送」在仿真里账面上还能再省 ${Math.round(mean('planned', 'costTotal') - mean('all', 'costTotal'))} 美元 / 天，但仿真是按「一家供应商一整车直送」算的：长尾商品实际来自很多家小供应商，每家凑不满一车，直送就成了很多趟零担，门店收货的次数成倍增加；冷冻货一车是约 4 天的量，门店冷冻货最多的时候要多放 ${Math.round(mean('all', 'peakFrozen') - mean('planned', 'peakFrozen'))} 托（冷冻库的托盘位最贵）。这两样仿真没有算进成本，货流规划按规则把它们排除（规则和每个商品族的账见[结果 6](06-flows.md)）。`,
  },
  {
    key: 'safety',
    title: '门店的安全库存',
    question: '门店的安全系数定多少？全部商品一个系数，还是按品类分开（生鲜报废贵、常温缺货贵）？',
    values: ['1.28', '1.65', '2.05', 'split'],
    label: (v) => (v === 'split' ? '分品类：常温 z = 2.05、生鲜 z = 1.28' : `全部 z = ${v}`),
    short: (v) => (v === 'split' ? '分品类' : `全部 ${v}`),
    apply: (s, v) => {
      if (v === 'split') {
        s.store.safetyZ = 2.05;
        s.store.safetyZFresh = 1.28;
      } else {
        s.store.safetyZ = Number(v);
        delete s.store.safetyZFresh;
      }
    },
    kpis: ['service', 'storeInv', 'waste', 'costLost', 'costWaste', 'costCarrying'],
    chart: 'costTotal',
    chosen: 'split',
    baseline: '1.65',
  },
  {
    key: 'crossdock',
    title: '生鲜越库',
    question: '区域生鲜和空运的生鲜当夜到、当天送，值多少？',
    values: ['store', 'cross'],
    label: (v) => (v === 'cross' ? '夜间集货 + 越库（当天送店）' : '早上到货、入库、第二天送店'),
    apply: (s, v) => {
      if (v === 'store') {
        s.dc.crossDock = false;
        s.dc.localArriveHour = 4.5;
        s.dc.freshHandlingHours = 6;
        s.air.flightHour = 5.5;
        s.dc.leadDays.air = 2;
      }
    },
    kpis: ['freshRemain', 'waste', 'costWaste', 'service'],
    chart: 'freshRemain',
    chosen: 'cross',
  },
  {
    key: 'backhaul',
    title: '回程顺带供应商的货',
    question: '配送车回程时顺路到供应商装货的比例？',
    values: [0, 0.2, 0.35, 0.5],
    label: (v) => `${Math.round((v as number) * 100)}%`,
    apply: (s, v) => (s.fleet.backhaulShare = v as number),
    kpis: ['inboundLoads', 'inboundKm', 'co2Local', 'costTransport'],
    chart: 'inboundKm',
    chosen: 0.35,
  },
];

export interface SweepResult {
  spec: SweepSpec;
  points: { value: number | string; runs: ChainResult[] }[];
}

export function runSweep(spec: SweepSpec, seeds: readonly number[]): SweepResult {
  return {
    spec,
    points: spec.values.map((value) => ({
      value,
      runs: seeds.map((seed) => {
        const s = g3(seed);
        spec.apply(s, value);
        return run(s);
      }),
    })),
  };
}

// —— 需求增长：线上订单翻倍时门店的件数约 +24%，再往上看到 +60% ——
export const SCALES = [0.8, 1.0, 1.24, 1.4, 1.6] as const;
export interface CapacityResult {
  scales: readonly number[];
  arms: Record<Gen, ChainResult[][]>;
}
export function capacity(seeds: readonly number[]): CapacityResult {
  const arms = { g1: [], g2: [], g3: [] } as Record<Gen, ChainResult[][]>;
  for (const gen of ['g1', 'g2', 'g3'] as Gen[])
    for (const sc of SCALES)
      arms[gen].push(
        seeds.map((seed) => {
          const s = MAKERS[gen](seed);
          s.demand.scale = sc;
          return run(s);
        }),
      );
  return { scales: SCALES, arms };
}

// —— 压力演练：第 80 天开始（计入结果的第 2 周） ——
export interface StressCase {
  key: DisruptionKey;
  label: string;
  detail: string;
  days: number;
}
export const STRESS: readonly StressCase[] = [
  { key: 'portCongestion', label: '港口拥堵', detail: '本周班轮晚到 6 天，之后 10 天堆场停留翻倍', days: 10 },
  { key: 'airportClosed', label: '机场关闭', detail: '风暴，机场关闭 2 天', days: 2 },
  { key: 'highwayClosed', label: '高速封闭', detail: '物流园进城的高速封闭 1 天', days: 1 },
  { key: 'supplierOutage', label: '供应商停产', detail: '常温畅销品（占全部件数 13%）的主供应商停产 7 天', days: 7 },
  { key: 'demandSurge', label: '需求突增', detail: '风暴预警引发抢购：全部商品 +35%，持续 5 天', days: 5 },
];
export const STRESS_START = 80;

export interface StressRun {
  base: ChainResult;
  hit: ChainResult;
}
export interface StressResult {
  cases: { c: StressCase; gens: Record<Gen, StressRun[]> }[];
}

export function stress(seeds: readonly number[]): StressResult {
  const base = { g1: [], g2: [], g3: [] } as Record<Gen, ChainResult[]>;
  for (const gen of ['g1', 'g2', 'g3'] as Gen[]) base[gen] = seeds.map((seed) => run(MAKERS[gen](seed)));
  return {
    cases: STRESS.map((c) => {
      const gens = { g1: [], g2: [], g3: [] } as Record<Gen, StressRun[]>;
      for (const gen of ['g1', 'g2', 'g3'] as Gen[])
        gens[gen] = seeds.map((seed, i) => {
          const s = MAKERS[gen](seed);
          s.disruption = { key: c.key, start: STRESS_START, days: c.days };
          return { base: (base[gen] as ChainResult[])[i] as ChainResult, hit: run(s) };
        });
      return { c, gens };
    }),
  };
}

/**
 * 演练的指标，都和同一种子、没有扰动的那次逐日相比（只看扰动带来的变化，不受平常的坏天气、促销影响）：
 * 扰动开始后 3 周的平均服务水平和比平常低多少、最差一天比平常低多少、空运生鲜和准时送达最差一天比平常低多少、应对成本、多花的钱
 */
export function stressMetrics(r: StressRun): { window: number; windowDrop: number; worstDrop: number; airDrop: number; onTimeDrop: number; response: number; extraCost: number; lostUnits: number } {
  const s = STRESS_START;
  const slice = (x: readonly number[], n: number) => x.slice(s, s + n);
  const drop = (hit: readonly number[], base: readonly number[]) => Math.max(0, ...hit.map((h, i) => ((base[i] as number) - h) * 100));
  const win = slice(r.hit.daily.service, 21);
  const winBase = slice(r.base.daily.service, 21);
  const mean = (x: readonly number[]) => (x.reduce((a, b) => a + b, 0) / Math.max(1, x.length)) * 100;
  const baseLost = slice(r.base.daily.lost, 21).reduce((a, b) => a + b, 0);
  const hitLost = slice(r.hit.daily.lost, 21).reduce((a, b) => a + b, 0);
  return {
    window: mean(win),
    windowDrop: mean(winBase) - mean(win),
    worstDrop: drop(win, winBase),
    airDrop: drop(slice(r.hit.daily.airService, 7), slice(r.base.daily.airService, 7)),
    onTimeDrop: drop(slice(r.hit.daily.onTime, 3), slice(r.base.daily.onTime, 3)),
    response: r.hit.responseCost,
    extraCost: (r.hit.cost.total - r.base.cost.total) * r.hit.days + r.hit.responseCost,
    lostUnits: hitLost - baseLost,
  };
}

/** 某一天的动画（三代各一份，网页用） */
export const TRACE_DAY = 86;
export function sampleTraces(): Record<Gen, ChainResult> {
  const out = {} as Record<Gen, ChainResult>;
  for (const gen of ['g1', 'g2', 'g3'] as Gen[]) {
    const s = MAKERS[gen](1);
    s.traceDay = TRACE_DAY;
    out[gen] = run(s);
  }
  return out;
}
