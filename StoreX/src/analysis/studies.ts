import { runDay, type DayResult } from '../ops/day';
import { GROWTH_2030, gen1, storex, storex2030, storexNoMfc, withoutMfc, type Scenario } from '../world/config';
import { H } from '../core/sim';
import { compare, pointOf, type Arm, type CompareRow, type SweepPoint } from './experiment';
import { kpi } from './kpi';

/**
 * 实验清单：做决定用的扫描、两代对比、容量、压力演练。
 * 每个实验都用同一组种子（公共随机数），结论看配对差值和 95% 置信区间。
 */
export const seedsOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

let onRun: (() => void) | undefined;
/** 进度回调（命令行打点用） */
export function setProgress(fn: (() => void) | undefined): void {
  onRun = fn;
}
export function run(s: Scenario): DayResult {
  const r = runDay(s);
  onRun?.();
  return r;
}

// —— 两代对比 ——

export interface Headline {
  key: 'today' | 'y2030';
  title: string;
  a: { label: string; runs: DayResult[] };
  b: { label: string; runs: DayResult[] };
  rows: CompareRow[];
}

export function headline(seeds: readonly number[]): Headline[] {
  const pairs: [Headline['key'], string, Arm, Arm][] = [
    ['today', '现在的订单量（266 单 / 天）', { label: '上一代', make: (seed) => gen1(seed) }, { label: 'StoreX', make: (seed) => storex(seed) }],
    ['y2030', '2030 年的订单量（532 单 / 天）', { label: '上一代', make: (seed) => gen1(seed, GROWTH_2030) }, { label: 'StoreX 2030', make: (seed) => storex2030(seed) }],
  ];
  return pairs.map(([key, title, a, b]) => {
    const ra = { label: a.label, runs: seeds.map((seed) => run(a.make(seed))) };
    const rb = { label: b.label, runs: seeds.map((seed) => run(b.make(seed))) };
    return { key, title, a: ra, b: rb, rows: compare(ra, rb) };
  });
}

// —— 设备和人员的扫描（做决定用） ——

export interface SweepSpec {
  key: string;
  title: string;
  /** 这个实验要回答的问题 */
  question: string;
  volume: 'today' | '2030';
  values: readonly (number | string)[];
  label: (v: number | string) => string;
  /** 图上用的短标签（默认同 label） */
  short?: (v: number | string) => string;
  apply: (s: Scenario, v: number | string) => void;
  kpis: readonly string[];
  /** 画图：横轴是 values，纵轴是这个指标 */
  chart: string;
  /** 最后选的值 */
  chosen: number | string;
}

const base = (volume: SweepSpec['volume'], seed: number): Scenario => (volume === 'today' ? storex(seed) : storex2030(seed));

export const SWEEPS: readonly SweepSpec[] = [
  {
    key: 'mfcBots',
    title: '货格机器人数量（2030 年订单量）',
    question: '订单翻倍以后，货格仓要多少台机器人才能按时、不让顾客多等？',
    volume: '2030',
    values: [12, 14, 16, 18, 20, 22, 24],
    label: (v) => `${v} 台`,
    apply: (s, v) => (s.mfc.bots = v as number),
    kpis: ['done', 'onTime', 'wait', 'waitP95', 'waitOver5', 'botUtil'],
    chart: 'waitP95',
    chosen: 20,
  },
  {
    key: 'mfcBotsToday',
    title: '货格机器人数量（现在的订单量）',
    question: '开业时（266 单 / 天）先装多少台？',
    volume: 'today',
    values: [6, 8, 10, 12, 14],
    label: (v) => `${v} 台`,
    apply: (s, v) => (s.mfc.bots = v as number),
    kpis: ['done', 'onTime', 'wait', 'waitP95', 'botUtil'],
    chart: 'waitP95',
    chosen: 12,
  },
  {
    key: 'ports',
    title: '拣货站台数量（2030 年订单量）',
    question: '站台会不会成为瓶颈？',
    volume: '2030',
    values: [2, 3, 4],
    label: (v) => `${v} 个`,
    apply: (s, v) => (s.mfc.ports = v as number),
    kpis: ['onTime', 'wait', 'waitP95', 'portUtil', 'paid'],
    chart: 'waitP95',
    chosen: 3,
  },
  {
    key: 'portPicker',
    title: '站台由人拣还是机械臂拣（2030 年订单量）',
    question: '站台换成机械臂，能省多少人工、会不会变慢？',
    volume: '2030',
    values: ['human', 'arm'],
    label: (v) => (v === 'human' ? '人工拣' : '机械臂拣（失败由人补）'),
    short: (v) => (v === 'human' ? '人工拣' : '机械臂拣'),
    apply: (s, v) => (s.mfc.portPicker = v as 'human' | 'arm'),
    kpis: ['onTime', 'wait', 'waitP95', 'laborMinPerOrder', 'paid'],
    chart: 'paid',
    chosen: 'human',
  },
  {
    key: 'lockers',
    title: '自提柜格口数（2030 年订单量）',
    question: '自提柜要多少格口，顾客才不用等空格口？',
    volume: '2030',
    values: [0.6, 0.8, 1, 1.2],
    label: (v) => {
      const k = v as number;
      return `${Math.round(72 * k)} / ${Math.round(56 * k)} / ${Math.round(28 * k)}`;
    },
    apply: (s, v) => {
      const k = v as number;
      s.pickup.lockers = { ambient: Math.round(72 * k), chilled: Math.round(56 * k), frozen: Math.round(28 * k) };
    },
    kpis: ['lockerWait', 'lockerQ', 'wait', 'waitP95'],
    chart: 'lockerWait',
    chosen: 1,
  },
  {
    key: 'carts',
    title: '免下车取货送框小车数量（2030 年订单量）',
    question: '免下车取货要几台送框小车？',
    volume: '2030',
    values: [1, 2, 3, 4],
    label: (v) => `${v} 台`,
    apply: (s, v) => (s.pickup.carts = v as number),
    kpis: ['driveWait', 'wait', 'waitP95', 'waitOver5'],
    chart: 'driveWait',
    chosen: 3,
  },
  {
    key: 'amr',
    title: '补货机器人数量（现在的订单量）',
    question: '补货机器人能不能让员工少走路、货架更满？要几台？',
    volume: 'today',
    values: [0, 1, 2, 3, 4],
    label: (v) => `${v} 台`,
    apply: (s, v) => (s.robots.amr = v as number),
    kpis: ['oos', 'recover', 'lostSales', 'paid', 'util'],
    chart: 'recover',
    chosen: 3,
  },
  {
    key: 'sensing',
    title: '发现缺货的方式（现在的订单量）',
    question: '盘点机器人和智能货架各值多少？',
    volume: 'today',
    values: ['staff', 'staff+25', 'robot', 'robot+25', 'robot+50'],
    label: (v) =>
      ({
        staff: '员工巡店 3 次（7、12、17 点）',
        'staff+25': '员工巡店 3 次 + 智能货架 25%',
        robot: '盘点机器人 6 次（含 6 点开门前）',
        'robot+25': '盘点机器人 6 次 + 智能货架 25%',
        'robot+50': '盘点机器人 6 次 + 智能货架 50%',
      })[String(v)] ?? String(v),
    short: (v) => ({ staff: '员工巡店', 'staff+25': '员工 + 货架 25%', robot: '机器人', 'robot+25': '机器人 + 货架 25%', 'robot+50': '机器人 + 货架 50%' })[String(v)] ?? String(v),
    apply: (s, v) => {
      const [who, share] = String(v).split('+');
      s.shelf.smartShelfShare = Number(share ?? 0) / 100;
      if (who === 'staff') {
        s.robots.scanners = 0;
        s.shelf.scanTimes = [7 * H, 12 * H, 17 * H];
        s.shelf.scanDurationSec = 45 * 60;
      } else s.robots.scanners = 1;
    },
    kpis: ['oos', 'outages', 'recover', 'lostSales', 'paid'],
    chart: 'oos',
    chosen: 'robot+25',
  },
  {
    key: 'gates',
    title: '免排队通道数量（现在的订单量）',
    question: '出口要几条免排队通道？',
    volume: 'today',
    values: [0, 2, 4, 6],
    label: (v) => `${v} 条`,
    apply: (s, v) => (s.checkout.gates = v as number),
    kpis: ['checkoutWait', 'checkoutP95', 'paid'],
    chart: 'checkoutP95',
    chosen: 2,
  },
  {
    key: 'frictionless',
    title: '注册免排队出口的顾客比例（现在的订单量）',
    question: '如果愿意用免排队出口的顾客比预想的少或多，结账会怎样？',
    volume: 'today',
    values: [0.25, 0.45, 0.65],
    label: (v) => `${Math.round((v as number) * 100)}%`,
    apply: (s, v) => (s.demand.frictionlessShare = v as number),
    kpis: ['checkoutWait', 'checkoutP95', 'paid'],
    chart: 'checkoutP95',
    chosen: 0.45,
  },
];

export interface SweepResult {
  spec: SweepSpec;
  points: SweepPoint<number | string>[];
}

export function runSweep(spec: SweepSpec, seeds: readonly number[]): SweepResult {
  const points = spec.values.map((v) =>
    pointOf(
      v,
      seeds.map((seed) => {
        const s = base(spec.volume, seed);
        spec.apply(s, v);
        return run(s);
      }),
    ),
  );
  return { spec, points };
}

// —— 容量：订单量从 266 涨到 800 ——

export const VOLUMES = [100, 180, 266, 400, 532, 666, 800] as const;

export interface CapacityResult {
  volumes: readonly number[];
  gen1: DayResult[][];
  storex: DayResult[][];
  /** 同样的 StoreX 2030 设备，但不建货格仓 */
  noMfc: DayResult[][];
}

/** 到店顾客固定 1800 位，只变线上订单量；StoreX 用 2030 年的设备 */
export function capacity(seeds: readonly number[]): CapacityResult {
  const g: DayResult[][] = [];
  const x: DayResult[][] = [];
  const n: DayResult[][] = [];
  for (const v of VOLUMES) {
    const demand = { ordersPerDay: v, shoppersPerDay: 1800 };
    g.push(seeds.map((seed) => run(gen1(seed, demand))));
    x.push(seeds.map((seed) => run(storex2030(seed, demand))));
    n.push(seeds.map((seed) => run(withoutMfc(storex2030(seed, demand)))));
  }
  return { volumes: VOLUMES, gen1: g, storex: x, noMfc: n };
}

// —— 成长路径：开业设备能撑到多少单、先加什么 ——

export const GROWTH_STEPS: { key: string; label: string; apply: (s: Scenario) => void }[] = [
  { key: 'open', label: '开业设备（12 台货格机器人、2 台送框小车、132 个格口）', apply: () => {} },
  { key: 'cart', label: '加 1 台送框小车', apply: (s) => (s.pickup.carts = 3) },
  {
    key: 'cartBots',
    label: '加 1 台送框小车、货格机器人加到 16 台（2028 年的配置）',
    apply: (s) => {
      s.pickup.carts = 3;
      s.mfc.bots = 16;
    },
  },
];
export const GROWTH_VOLUMES = [266, 330, 400] as const;
export const GROWTH_KPIS = ['onTime', 'wait', 'waitP95', 'driveWait', 'botUtil'] as const;

export interface GrowthResult {
  volumes: readonly number[];
  steps: { key: string; label: string; runs: DayResult[][] }[];
}

export function growthPath(seeds: readonly number[]): GrowthResult {
  return {
    volumes: GROWTH_VOLUMES,
    steps: GROWTH_STEPS.map((st) => ({
      key: st.key,
      label: st.label,
      runs: GROWTH_VOLUMES.map((v) =>
        seeds.map((seed) => {
          const s = storex(seed, { ordersPerDay: v });
          st.apply(s);
          return run(s);
        }),
      ),
    })),
  };
}

// —— 三个方案并排：上一代、StoreX 不建货格仓、StoreX ——

export interface Alternatives {
  title: string;
  arms: { label: string; runs: DayResult[] }[];
}

export function alternatives(seeds: readonly number[]): Alternatives[] {
  return [
    {
      title: '现在的订单量（266 单 / 天）',
      arms: [
        { label: '上一代', runs: seeds.map((seed) => run(gen1(seed))) },
        { label: 'StoreX 不建货格仓', runs: seeds.map((seed) => run(storexNoMfc(seed))) },
        { label: 'StoreX', runs: seeds.map((seed) => run(storex(seed))) },
      ],
    },
    {
      title: '2030 年的订单量（532 单 / 天）',
      arms: [
        { label: '上一代', runs: seeds.map((seed) => run(gen1(seed, GROWTH_2030))) },
        { label: 'StoreX 不建货格仓', runs: seeds.map((seed) => run(withoutMfc(storex2030(seed)))) },
        { label: 'StoreX 2030', runs: seeds.map((seed) => run(storex2030(seed))) },
      ],
    },
  ];
}

// —— 压力演练：2030 年订单量下出状况会怎样 ——

export interface StressCase {
  key: string;
  label: string;
  detail: string;
  make: (seed: number) => Scenario;
}

export const STRESS: readonly StressCase[] = [
  { key: 'base', label: 'StoreX 2030 正常运行', detail: '2030 年订单量、2030 年设备', make: (seed) => storex2030(seed) },
  {
    key: 'outageNoFallback',
    label: '货格仓停机 2 小时，不降级',
    detail: '15:00–17:00 货格仓整体停机（断电或软件故障），线上订单只能等它恢复',
    make: (seed) => {
      const s = storex2030(seed);
      s.mfc.outage = { start: 15 * H, sec: 2 * H };
      s.mfc.fallback = false;
      return s;
    },
  },
  {
    key: 'outageFallback',
    label: '货格仓停机 2 小时，降级到卖场拣',
    detail: '同样停机，停机期间的包装商品改由门店作业员在卖场货架上拣',
    make: (seed) => {
      const s = storex2030(seed);
      s.mfc.outage = { start: 15 * H, sec: 2 * H };
      s.mfc.fallback = true;
      return s;
    },
  },
  {
    key: 'surge',
    label: '没预料到的订单高峰（多 25%）',
    detail: '订单比预测多 25%（665 单），排班仍按 532 单排',
    make: (seed) => {
      const s = storex2030(seed, { ordersPerDay: 665 });
      s.staffing.planBias = 0.8;
      return s;
    },
  },
  {
    key: 'unreliable',
    label: '机器人可靠性差',
    detail: '平均 100 小时坏一次（正常 500 小时），每次修 60 分钟（正常 20 分钟）',
    make: (seed) => {
      const s = storex2030(seed);
      s.reliability = { mtbfHours: 100, mttrMin: 60 };
      return s;
    },
  },
  {
    key: 'noAi',
    label: 'AI 预测失灵',
    detail: '排班和生鲜订货的预测误差退回上一代的水平',
    make: (seed) => {
      const s = storex2030(seed);
      s.staffing.forecastError = 0.15;
      s.fresh = { ...s.fresh, forecastError: 0.28, safety: 1.0, presentationDays: 0.8 };
      return s;
    },
  },
  { key: 'gen1', label: '上一代，2030 年订单量', detail: '对照：上一代流程按 2030 年订单量排班', make: (seed) => gen1(seed, GROWTH_2030) },
  {
    key: 'gen1Surge',
    label: '上一代，同样多 25% 的订单',
    detail: '对照：上一代遇到同样的高峰',
    make: (seed) => {
      const s = gen1(seed, { ...GROWTH_2030, ordersPerDay: 665 });
      s.staffing.planBias = 0.8;
      return s;
    },
  },
];

export const STRESS_KPIS = ['done', 'onTime', 'wait', 'waitP95', 'waitOver5', 'fill', 'robotFailures', 'freshWaste', 'paid'] as const;

export interface StressResult {
  cases: { c: StressCase; runs: DayResult[] }[];
}

export function stress(seeds: readonly number[]): StressResult {
  return { cases: STRESS.map((c) => ({ c, runs: seeds.map((seed) => run(c.make(seed))) })) };
}

/** 代表性的一天（种子 1）：画小时曲线用 */
export function sampleDays(): { gen1: DayResult; storex: DayResult; gen1y2030: DayResult; storex2030: DayResult } {
  return { gen1: run(gen1(1)), storex: run(storex(1)), gen1y2030: run(gen1(1, GROWTH_2030)), storex2030: run(storex2030(1)) };
}

export { kpi };
