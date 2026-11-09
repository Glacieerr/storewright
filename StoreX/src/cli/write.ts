import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ci95 } from '../core/stats';
import type { DayResult } from '../ops/day';
import { BASE, CAPEX, cashflow, mfcBreakEven, SCENARIOS, sensitivity, SUBSCRIPTIONS, type CurvePoint, type EconResult, type Money } from '../analysis/economics';
import { kpi, KPIS } from '../analysis/kpi';
import { alternativesTable, capacityTable, compareTable, fmt, growthTable, meanOf, stressTable, sweepTable, table } from '../analysis/report';
import { capacity, GROWTH_STEPS, GROWTH_VOLUMES, growthPath, headline, run, runSweep, sampleDays, seedsOf, stress, STRESS, SWEEPS, type Alternatives, type CapacityResult, type Headline } from '../analysis/studies';
import { barChart, changeChart, floorPlan, lineChart, SERIES, tornadoChart } from '../analysis/svg';
import { buildLayout } from '../world/layout';
import { FLEET_2030, storex2030, storexNoMfc, withoutMfc } from '../world/config';

/**
 * 跑全部实验，写 docs/results/：Markdown 结果页、SVG 图和 data.json（网页模拟器的「报告」页也读这份数据）。
 * 所有数字都从这里来，报告正文引用这些结果页。
 */
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../docs/results');
const WEB_DATA = join(dirname(fileURLToPath(import.meta.url)), '../../web/src/data/results.json');

const money = (runs: readonly DayResult[]): Money => {
  const m = (f: (r: DayResult) => number) => ci95(runs.map(f)).mean;
  return { labor: m((r) => r.money.labor), energy: m((r) => r.money.energy), freshLoss: m((r) => r.money.freshLoss), lostMargin: m((r) => r.money.lostMargin), total: m((r) => r.money.total) };
};
const avg = (runs: readonly DayResult[], f: (r: DayResult) => number) => ci95(runs.map(f)).mean;
const usd = (x: number) => (x < 0 ? `−$${fmt(-x, 0)}` : `$${fmt(x, 0)}`);
const musd = (x: number) => `${fmt(x / 1e6, 2)} 百万美元`;

/** 岗位分组（两代的岗位名字不同，按工作内容归到一起） */
const ROLE_GROUPS: { label: string; roles: string[] }[] = [
  { label: '线上拣货、站台与交付', roles: ['picker', 'dispenser', 'porter', 'decanter', 'freshPicker', 'handoff'] },
  { label: '补货与卖场服务', roles: ['stocker', 'host'] },
  { label: '收货', roles: ['receiver'] },
  { label: '人工收银', roles: ['cashier'] },
  { label: '机器人值班', roles: ['robotTech'] },
];
function hoursByGroup(runs: readonly DayResult[]): number[] {
  return [
    ...ROLE_GROUPS.map((g) => avg(runs, (r) => g.roles.reduce((s, k) => s + ((r.labor.scheduled as Record<string, number>)[k] ?? 0), 0))),
    avg(runs, (r) => r.labor.night),
    avg(runs, (r) => r.labor.fixed),
  ];
}
const GROUP_LABELS = [...ROLE_GROUPS.map((g) => g.label), '夜班上架', '固定岗位（生鲜加工、服务台、管理）'];

function curveOf(c: CapacityResult): CurvePoint[] {
  return c.volumes.map((volume, i) => ({
    volume,
    gen1: money(c.gen1[i] as DayResult[]),
    storex: money(c.storex[i] as DayResult[]),
    noMfc: money(c.noMfc[i] as DayResult[]),
    gen1Hours: avg(c.gen1[i] as DayResult[], (r) => r.labor.paidTotal),
    storexHours: avg(c.storex[i] as DayResult[], (r) => r.labor.paidTotal),
    noMfcHours: avg(c.noMfc[i] as DayResult[], (r) => r.labor.paidTotal),
  }));
}

function write(name: string, text: string): void {
  writeFileSync(join(OUT, name), text);
}

const NOTE = '> 数字来自 `npm run reports` 的离散事件仿真（合成数据）。「± 」后面是 95% 置信区间的半宽，两个方案用同一组种子（公共随机数），配对差值的置信区间不含 0 才判为「改善 / 变差」。';

export async function writeAll(opts: { compareSeeds: number; sweepSeeds: number }): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(dirname(WEB_DATA), { recursive: true });
  const t0 = performance.now();
  const seedsA = seedsOf(opts.compareSeeds);
  const seedsB = seedsOf(opts.sweepSeeds);
  const log = (s: string) => process.stderr.write(`\n${s} `);

  log('两代对比');
  const heads = headline(seedsA);
  const [today, y2030] = heads as [Headline, Headline];
  log('不建货格仓的对照');
  const noMfcToday = seedsA.map((seed) => run(storexNoMfc(seed)));
  const noMfc2030 = seedsA.map((seed) => run(withoutMfc(storex2030(seed))));
  const alts: Alternatives[] = [
    { title: today.title, arms: [today.a, { label: 'StoreX 不建货格仓', runs: noMfcToday }, today.b] },
    { title: y2030.title, arms: [y2030.a, { label: 'StoreX 2030 不建货格仓', runs: noMfc2030 }, y2030.b] },
  ];
  log('设备扫描');
  const sweeps = SWEEPS.map((s) => runSweep(s, seedsB));
  log('容量');
  const cap = capacity(seedsB);
  const growth = growthPath(seedsB);
  log('压力演练');
  const st = stress(seedsB);
  const days = sampleDays();
  log('商业分析');
  const curve = curveOf(cap);
  const econ = cashflow(curve);
  const econMfc = cashflow(curve, BASE, 'mfc');
  const econPackage = cashflow(curve, BASE, 'package');
  // 订单少的门店（2027 年 150 单，2030 年 180 单）：不建货格仓的方案
  const small = { ...BASE, orders2027: 150, orders2030: 180 };
  const econPackageSmall = cashflow(curve, small, 'package');
  const econFullSmall = cashflow(curve, small);
  const breakEven = mfcBreakEven(curve);
  const sens = sensitivity(curve);
  const scen = SCENARIOS.map((sc) => ({ sc, r: cashflow(curve, { ...BASE, ...sc.patch }) }));
  const runtime = (performance.now() - t0) / 1000;
  const runs = heads.length * 2 * seedsA.length + 2 * seedsA.length + sweeps.reduce((s, x) => s + x.points.length * seedsB.length, 0) + cap.volumes.length * 3 * seedsB.length + GROWTH_STEPS.length * GROWTH_VOLUMES.length * seedsB.length + STRESS.length * seedsB.length + 4;

  // —— 图 ——
  const headKpis = ['onTime', 'wait', 'waitP95', 'dwell', 'laborMinPerOrder', 'walkKm', 'checkoutWait', 'oos', 'lostSales', 'paid', 'freshWaste', 'gridKwh', 'co2', 'dock', 'total$'];
  for (const h of heads) {
    const items = headKpis.map((key) => {
      const row = h.rows.find((r) => r.kpi.key === key);
      if (!row) throw new Error(key);
      return { label: row.kpi.label, pct: row.pct, good: row.verdict === '改善' ? true : row.verdict === '变差' ? false : null };
    });
    write(`change-${h.key}.svg`, changeChart({ title: `StoreX 相对上一代的变化 · ${h.title}`, subtitle: `${seedsA.length} 个种子的配对差值 ÷ 上一代均值；灰色 = 差异不显著`, items }));
  }
  const cats = GROUP_LABELS;
  write('hours-by-role.svg', barChart({ title: '每天的带薪工时，按工作内容分', subtitle: `小时 / 天，${seedsA.length} 个种子平均`, categories: cats, series: [
    { name: '上一代 · 266 单', color: SERIES.gen1, values: hoursByGroup(today.a.runs) },
    { name: 'StoreX · 266 单', color: SERIES.storex, values: hoursByGroup(today.b.runs) },
  ] }));
  write('hours-by-role-2030.svg', barChart({ title: '每天的带薪工时，按工作内容分 · 2030 年', subtitle: `小时 / 天，532 单 / 天，${seedsA.length} 个种子平均`, categories: cats, series: [
    { name: '上一代', color: SERIES.gen1, values: hoursByGroup(y2030.a.runs) },
    { name: 'StoreX 2030', color: SERIES.storex, values: hoursByGroup(y2030.b.runs) },
  ] }));
  const costCats = ['人工', '电费', '生鲜报废和打折', '缺货流失的毛利'];
  const costOf = (r: readonly DayResult[]) => [avg(r, (x) => x.money.labor), avg(r, (x) => x.money.energy), avg(r, (x) => x.money.freshLoss), avg(r, (x) => x.money.lostMargin)];
  write('daily-cost.svg', barChart({ title: '每天的运营成本', subtitle: '美元 / 天（只含仿真里算到的四项）', categories: costCats, unit: '', series: [
    { name: '上一代 · 266 单', color: SERIES.gen1, values: costOf(today.a.runs) },
    { name: 'StoreX · 266 单', color: SERIES.storex, values: costOf(today.b.runs) },
    { name: '上一代 · 532 单', color: SERIES.s4, values: costOf(y2030.a.runs) },
  ] }));
  const hours = Array.from({ length: 18 }, (_, i) => i + 5);
  write('hourly-staff.svg', lineChart({ title: '每小时在岗的员工', subtitle: '人（事件仿真里的岗位，不含夜班和固定岗位）· 266 单 / 天 · 种子 1', x: hours.map((h) => `${h}`), digits: 0, series: [
    { name: '上一代', color: SERIES.gen1, values: hours.map((h) => days.gen1.hourly.staffOnDuty[h] as number) },
    { name: 'StoreX', color: SERIES.storex, values: hours.map((h) => days.storex.hourly.staffOnDuty[h] as number) },
  ] }));
  write('hourly-robots.svg', lineChart({ title: 'StoreX 每小时忙碌的机器人', subtitle: '台（所有机器人的忙碌时长 ÷ 1 小时）· 2030 年 · 种子 1', x: hours.map((h) => `${h}`), digits: 1, series: [
    { name: 'StoreX 2030', color: SERIES.storex, values: hours.map((h) => days.storex2030.hourly.robotsBusy[h] as number) },
  ] }));
  for (const sw of sweeps) {
    const k = kpi(sw.spec.chart);
    const label = sw.spec.short ?? sw.spec.label;
    const idx = sw.spec.values.indexOf(sw.spec.chosen);
    write(`sweep-${sw.spec.key}.svg`, lineChart({ title: sw.spec.title, subtitle: `${k.label}（${k.unit}）· ${seedsB.length} 个种子平均，竖线是 95% 置信区间`, x: sw.spec.values.map((v) => label(v)), digits: k.digits ?? 1, ...(idx >= 0 ? { highlight: idx } : {}), series: [
      { name: k.label, color: SERIES.storex, values: sw.points.map((p) => p.mean(k)), err: sw.points.map((p) => p.ci(k).half) },
    ] }));
  }
  const vols = cap.volumes.map((v) => `${v}`);
  const capSeries = (key: string) => [
    { name: '上一代', color: SERIES.gen1, values: cap.gen1.map((r) => meanOf(kpi(key), r)) },
    { name: '不建货格仓', color: SERIES.noMfc, values: cap.noMfc.map((r) => meanOf(kpi(key), r)) },
    { name: 'StoreX', color: SERIES.storex, values: cap.storex.map((r) => meanOf(kpi(key), r)) },
  ];
  write('capacity-cost.svg', lineChart({ title: '每单的线上作业人工成本', subtitle: '美元 / 单（带薪），横轴是每天的线上订单量', x: vols, digits: 2, series: capSeries('laborCostPerOrder') }));
  write('capacity-hours.svg', lineChart({ title: '全店每天的带薪工时', subtitle: '小时 / 天，横轴是每天的线上订单量（到店顾客固定 1800 位）', x: vols, digits: 0, series: capSeries('paid') }));
  write('capacity-wait.svg', lineChart({ title: '自提顾客等待的 95% 分位', subtitle: '分钟，横轴是每天的线上订单量（StoreX 用 2030 年设备：20 台货格机器人）', x: vols, digits: 1, series: capSeries('waitP95') }));
  write('stress.svg', barChart({ title: '压力演练：自提等待的 95% 分位', subtitle: `分钟 · 2030 年订单量 · ${seedsB.length} 个种子平均`, categories: st.cases.map(({ c }) => c.label), digits: 1, series: [
    { name: '等待 95% 分位', color: SERIES.storex, values: st.cases.map(({ runs }) => meanOf(kpi('waitP95'), runs)) },
  ] }));
  const years = econ.rows.map((r) => `${r.year}`);
  write('cashflow.svg', lineChart({ title: '累计现金流（StoreX 改造，相对继续用上一代流程）', subtitle: '百万美元（2026 年不变价格，未折现）', x: years, digits: 1, yMin: Math.min(...scen.flatMap(({ r }) => r.rows.map((x) => x.cumulative / 1e6))), series: scen.map(({ sc, r }, i) => ({ name: sc.label, color: [SERIES.s4, SERIES.storex, SERIES.noMfc][i] as string, values: r.rows.map((x) => x.cumulative / 1e6) })) }));
  write('tornado.svg', tornadoChart({ title: '敏感性：10 年净现值', subtitle: '每次只改一个假设，其余保持基准', base: econ.npv, scale: 1e6, unit: ' 百万', items: sens.map((s) => ({ label: s.label, low: { label: s.low.label, value: s.low.npv }, high: { label: s.high.label, value: s.high.npv } })) }));

  write('layout-gen1.svg', floorPlan(buildLayout('gen1'), '上一代的门店布置', '1 格 = 1 米；建筑外壳 71 × 56 米，停车场和卸货场两代相同'));
  write('layout-storex.svg', floorPlan(buildLayout('storex'), 'StoreX 的门店布置', '1 格 = 1 米；后仓的立体货格仓、西墙的自提中心和免下车取货、加宽的通道'));

  // —— 结果页 ——
  const fig = (file: string, alt: string) => `![${alt}](${file})`;
  const roleTable = (a: readonly DayResult[], b: readonly DayResult[], la: string, lb: string) =>
    table(['工作内容', `${la}（小时 / 天）`, `${lb}（小时 / 天）`, '差'], GROUP_LABELS.map((g, i) => {
      const x = hoursByGroup(a)[i] as number;
      const y = hoursByGroup(b)[i] as number;
      return [g, fmt(x), fmt(y), `${y - x > 0 ? '+' : ''}${fmt(y - x)}`];
    }).concat([['合计', fmt(avg(a, (r) => r.labor.paidTotal)), fmt(avg(b, (r) => r.labor.paidTotal)), fmt(avg(b, (r) => r.labor.paidTotal) - avg(a, (r) => r.labor.paidTotal))]]));
  const robotsLine = (r: DayResult) => Object.entries(r.robots.counts).filter(([, n]) => n > 0).map(([k, n]) => `${ROBOT_NAMES[k] ?? k} ${n}`).join('、');

  write('01-comparison.md', [
    '# 结果 1：StoreX 与上一代对比',
    '',
    NOTE,
    '',
    `每个方案 ${seedsA.length} 个种子（${seedsA.length} 个不同的日子，两个方案面对完全相同的订单和顾客）。上一代 = Storewright 优化后的流程（手机作业 + AI，拣货、暂存、交付、补货全靠人）。`,
    '',
    ...heads.flatMap((h) => [`## ${h.title}`, '', fig(`change-${h.key}.svg`, `StoreX 相对上一代的变化：${h.title}`), '', compareTable(h), '']),
    '## 工时去了哪里',
    '',
    fig('hours-by-role.svg', '每天的带薪工时，按工作内容分'),
    '',
    roleTable(today.a.runs, today.b.runs, '上一代 · 266 单', 'StoreX · 266 单'),
    '',
    roleTable(y2030.a.runs, y2030.b.runs, '上一代 · 532 单', 'StoreX 2030 · 532 单'),
    '',
    `StoreX 的「门店作业员」一个岗位同时做补货、自提异常、年龄核验、配送装车和出口协助（上一代分成补货员、交付员、出口服务员）；站台拣货员兼做拆箱入格。`,
    '',
    fig('hourly-staff.svg', '每小时在岗的员工'),
    '',
    '## 每天的钱',
    '',
    fig('daily-cost.svg', '每天的运营成本'),
    '',
    '## 三个方案并排：货格仓本身值多少',
    '',
    '「StoreX 不建货格仓」保留了 StoreX 的其他所有技术（智能推车、自提柜、免下车取货、补货机器人、免排队出口、能源），只是线上订单全部在卖场里拣。',
    '',
    ...alts.flatMap((a) => [`### ${a.title}`, '', alternativesTable(a), '']),
    '## 设备和人',
    '',
    table(['', '上一代 · 266 单', 'StoreX · 266 单', '上一代 · 532 单', 'StoreX 2030 · 532 单'], [
      ['机器人（台）', '0', fmt(today.b.runs[0]?.robots.total ?? 0, 0), '0', fmt(y2030.b.runs[0]?.robots.total ?? 0, 0)],
      ['带薪工时（小时 / 天）', meanS(today.a.runs, 'paid'), meanS(today.b.runs, 'paid'), meanS(y2030.a.runs, 'paid'), meanS(y2030.b.runs, 'paid')],
      ['折合全职员工（8 小时 / 人）', meanS(today.a.runs, 'fte'), meanS(today.b.runs, 'fte'), meanS(y2030.a.runs, 'fte'), meanS(y2030.b.runs, 'fte')],
      ['员工 : 机器人', '—', ratio(today.b.runs), '—', ratio(y2030.b.runs)],
    ]),
    '',
    `StoreX 开业的机器人：${robotsLine(today.b.runs[0] as DayResult)}。2030 年：${robotsLine(y2030.b.runs[0] as DayResult)}。`,
    '',
  ].join('\n'));

  write('02-sweeps.md', [
    '# 结果 2：设备和人员怎么定（扫描实验）',
    '',
    NOTE,
    '',
    `每个配置 ${seedsB.length} 个种子；其余设置保持 StoreX（现在的订单量）或 StoreX 2030（2030 年的订单量）的选用值。标「选用」的是最后的方案。`,
    '',
    ...sweeps.flatMap((sw) => [`## ${sw.spec.title}`, '', `**问题：** ${sw.spec.question}`, '', fig(`sweep-${sw.spec.key}.svg`, sw.spec.title), '', sweepTable(sw), '']),
  ].join('\n'));

  write('03-capacity.md', [
    '# 结果 3：容量（线上订单从 100 涨到 800 单 / 天）',
    '',
    NOTE,
    '',
    `到店顾客固定 1800 位 / 天，只变线上订单量。上一代按订单量自动排班（人手随订单量加）；StoreX 用 2030 年的设备（${FLEET_2030.bots} 台货格机器人、${FLEET_2030.carts} 台送框小车、${FLEET_2030.lockers.ambient + FLEET_2030.lockers.chilled + FLEET_2030.lockers.frozen} 个自提柜格口），人手同样按订单量排。每个点 ${seedsB.length} 个种子。`,
    '',
    fig('capacity-cost.svg', '每单的线上作业人工成本'),
    '',
    fig('capacity-hours.svg', '全店每天的带薪工时'),
    '',
    fig('capacity-wait.svg', '自提顾客等待的 95% 分位'),
    '',
    capacityTable(cap),
    '',
    '## 开业设备能撑到多少单、先加什么',
    '',
    `从开业的设备出发，订单量涨到 330、400 单 / 天时，依次加送框小车和货格机器人。每个点 ${seedsB.length} 个种子。`,
    '',
    growthTable(growth),
    '',
  ].join('\n'));

  write('04-stress.md', [
    '# 结果 4：压力演练（2030 年订单量）',
    '',
    NOTE,
    '',
    table(['情况', '设定'], st.cases.map(({ c }) => [c.label, c.detail]), ['l', 'l']),
    '',
    fig('stress.svg', '压力演练：自提等待的 95% 分位'),
    '',
    stressTable(st),
    '',
    `降级模式下，停机期间改在卖场拣的包装商品平均 ${fmt(avg(st.cases.find((x) => x.c.key === 'outageFallback')?.runs ?? [], (r) => r.online.fallbackItems), 0)} 件 / 天。`,
    '',
  ].join('\n'));

  write('05-economics.md', economicsPage(econ, econMfc, breakEven, sens, scen, curve, cap, { pkg: econPackage, pkgSmall: econPackageSmall, fullSmall: econFullSmall }));

  write('README.md', [
    '# StoreX 实验结果',
    '',
    '这个目录由 `npm run reports`（`StoreX/` 下）生成，所有报告里的数字都从这里来。重新生成会覆盖这些文件。',
    '',
    '> 本项目与任何零售商、企业无隶属关系；所有数字都是合成数据上的仿真结果。',
    '',
    table(['结果页', '内容'], [
      ['[01-comparison.md](01-comparison.md)', '两代对比（现在、2030 年）、工时去向、三个方案并排'],
      ['[02-sweeps.md](02-sweeps.md)', '设备和人员的扫描实验：机器人、站台、自提柜、送框小车、补货机器人、发现缺货的方式、出口'],
      ['[03-capacity.md](03-capacity.md)', '线上订单从 100 到 800 单 / 天；开业设备能撑到多少单、先加什么'],
      ['[04-stress.md](04-stress.md)', '压力演练：货格仓停机、订单高峰、机器人可靠性差、AI 预测失灵'],
      ['[05-economics.md](05-economics.md)', '投资、10 年现金流、净现值、回收期、货格仓盈亏平衡、敏感性和情景'],
      ['data.json', '以上结果的数据（网页模拟器的「报告」页也用这份数据）'],
    ], ['l', 'l']),
    '',
    table(['', ''], [
      ['仿真天数', `${runs} 天`],
      ['两代对比的种子数', `${seedsA.length}`],
      ['扫描、容量、压力演练的种子数', `${seedsB.length}`],
      ['用时', `${fmt(runtime, 0)} 秒`],
    ], ['l', 'r']),
    '',
  ].join('\n'));

  // —— 数据 ——
  const kpiMeans = (r: readonly DayResult[]) => Object.fromEntries(KPIS.map((k) => [k.key, round(ci95(r.map(k.get)).mean)]));
  const kpiCi = (r: readonly DayResult[]) => Object.fromEntries(KPIS.map((k) => [k.key, round(ci95(r.map(k.get)).half)]));
  const data = {
    seeds: { compare: seedsA.length, sweep: seedsB.length },
    kpis: KPIS.map((k) => ({ key: k.key, label: k.label, unit: k.unit, group: k.group, better: k.better, digits: k.digits ?? 1 })),
    headline: heads.map((h) => ({ key: h.key, title: h.title, a: { label: h.a.label, mean: kpiMeans(h.a.runs), ci: kpiCi(h.a.runs) }, b: { label: h.b.label, mean: kpiMeans(h.b.runs), ci: kpiCi(h.b.runs) }, rows: h.rows.map((r) => ({ key: r.kpi.key, diff: round(r.diff.mean), half: round(r.diff.half), pct: round(r.pct), verdict: r.verdict })) })),
    alternatives: alts.map((a) => ({ title: a.title, arms: a.arms.map((x) => ({ label: x.label, mean: kpiMeans(x.runs) })) })),
    hoursByGroup: { labels: GROUP_LABELS, gen1: hoursByGroup(today.a.runs).map(round), storex: hoursByGroup(today.b.runs).map(round), gen1y2030: hoursByGroup(y2030.a.runs).map(round), storex2030: hoursByGroup(y2030.b.runs).map(round) },
    sweeps: sweeps.map((sw) => ({ key: sw.spec.key, title: sw.spec.title, question: sw.spec.question, chart: sw.spec.chart, chosen: sw.spec.chosen, points: sw.points.map((p) => ({ value: p.value, label: (sw.spec.short ?? sw.spec.label)(p.value), mean: Object.fromEntries(sw.spec.kpis.map((k) => [k, round(p.mean(kpi(k)))])), half: Object.fromEntries(sw.spec.kpis.map((k) => [k, round(p.ci(kpi(k)).half)])) })), kpis: sw.spec.kpis })),
    capacity: { volumes: cap.volumes, gen1: cap.gen1.map(kpiMeans), noMfc: cap.noMfc.map(kpiMeans), storex: cap.storex.map(kpiMeans) },
    growth: { volumes: growth.volumes, steps: growth.steps.map((st) => ({ key: st.key, label: st.label, mean: st.runs.map(kpiMeans) })) },
    stress: st.cases.map(({ c, runs: r }) => ({ key: c.key, label: c.label, detail: c.detail, mean: kpiMeans(r) })),
    economics: {
      npv: round(econ.npv),
      irr: round(econ.irr * 100),
      payback: round(econ.payback),
      discountedPayback: round(econ.discountedPayback),
      capexTotal: round(econ.capexTotal),
      capexOpening: round(econ.capexOpening),
      capexByGroup: Object.fromEntries(Object.entries(econ.capexByGroup).map(([k, v]) => [k, round(v)])),
      steady: { gross: round(econ.steady.gross), opex: round(econ.steady.opex), net: round(econ.steady.net) },
      rows: econ.rows.map((r) => ({ year: r.year, orders: round(r.orders), gross: round(r.gross), opex: round(r.maintenance + r.subscriptions + r.insurance), capex: round(r.capex + r.replacement), residual: round(r.residual), net: round(r.net), cumulative: round(r.cumulative) })),
      mfc: { npv: round(econMfc.npv), irr: round(econMfc.irr * 100), payback: round(econMfc.payback), breakEven: round(breakEven.volume), annualCost: round(breakEven.annualCost) },
      package: { capex: round(econPackage.capexTotal), npv: round(econPackage.npv), irr: round(econPackage.irr * 100), payback: round(econPackage.payback), smallNpv: round(econPackageSmall.npv), smallFullNpv: round(econFullSmall.npv) },
      scenarios: scen.map(({ sc, r }) => ({ key: sc.key, label: sc.label, detail: sc.detail, npv: round(r.npv), irr: round(r.irr * 100), payback: round(r.payback), cumulative: r.rows.map((x) => round(x.cumulative)) })),
      sensitivity: sens.map((s) => ({ label: s.label, low: { label: s.low.label, npv: round(s.low.npv) }, high: { label: s.high.label, npv: round(s.high.npv) } })),
    },
    hourly: {
      gen1: days.gen1.hourly,
      storex: days.storex.hourly,
      gen1y2030: days.gen1y2030.hourly,
      storex2030: days.storex2030.hourly,
    },
    runtime: round(runtime),
    days: runs,
  };
  const json = JSON.stringify(data, (_, v) => (typeof v === 'number' ? round(v) : v));
  write('data.json', json);
  writeFileSync(WEB_DATA, json);
  process.stderr.write(`\n写好了：${OUT}（${runs} 天，${fmt(runtime, 0)} 秒）\n`);
}

const ROBOT_NAMES: Record<string, string> = { mfcBot: '货格机器人', amr: '补货机器人', scanner: '盘点机器人', scrubber: '洗地机器人', cart: '送框小车', loader: '装柜机器人', pallet: '自动托盘车' };

function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4;
  return Number(x.toFixed(d));
}
function meanS(runs: readonly DayResult[], key: string): string {
  const k = kpi(key);
  return fmt(meanOf(k, runs), k.digits ?? 1);
}
function ratio(runs: readonly DayResult[]): string {
  const fte = avg(runs, (r) => r.labor.fte);
  const robots = (runs[0] as DayResult).robots.total;
  return `${fmt(fte / robots, 1)} : 1`;
}

function economicsPage(econ: EconResult, mfc: EconResult, be: { volume: number; annualCost: number }, sens: ReturnType<typeof sensitivity>, scen: { sc: (typeof SCENARIOS)[number]; r: EconResult }[], curve: CurvePoint[], cap: CapacityResult, pk: { pkg: EconResult; pkgSmall: EconResult; fullSmall: EconResult }): string {
  const a = econ.assumptions;
  const pct = (x: number) => `${fmt(x * 100, 1)}%`;
  const yrs = (x: number) => (Number.isFinite(x) ? `${fmt(x, 1)} 年` : '分析期内不回本');
  const capexRows = CAPEX.map((it) => [it.label, it.group, `${it.year}`, fmt(it.qty, 0), usd(it.unit), `${usd(it.low)}–${usd(it.high)}`, usd(it.unit * it.qty), it.life >= 99 ? '一次性' : `${it.life} 年`, it.maint ? pct(it.maint) : '—']);
  const volRows = curve.map((p) => [
    `${p.volume}`,
    usd(p.gen1.total),
    usd(p.noMfc.total),
    usd(p.storex.total),
    usd(p.gen1.total - p.storex.total),
    usd(p.noMfc.total - p.storex.total),
  ]);
  const costPerOrder = cap.volumes.map((v, i) => {
    const g = meanOf(kpi('laborCostPerOrder'), cap.gen1[i] as DayResult[]);
    const n = meanOf(kpi('laborCostPerOrder'), cap.noMfc[i] as DayResult[]);
    const x = meanOf(kpi('laborCostPerOrder'), cap.storex[i] as DayResult[]);
    return [`${v}`, usd(g), usd(n), usd(x)];
  });
  return [
    '# 结果 5：商业分析',
    '',
    '> 口径：把一家正在用上一代流程的门店改造成 StoreX，只算增量投资和增量收益。2026 年改造，2027–2036 年运营 10 年；按 2026 年不变价格（实际值）计算；不算税、补贴和融资。设备价格是公开资料里的常见区间，不是任何供应商的报价。每天的节省来自容量实验的仿真结果（按当年订单量插值）。',
    '',
    '## 结论',
    '',
    table(['', '数值'], [
      ['总投资（含 2028、2030 年加的设备）', musd(econ.capexTotal)],
      ['开业时的投资', musd(econ.capexOpening)],
      ['2030 年（满负荷）每年毛节省', musd(econ.steady.gross)],
      ['2030 年每年的维护、订阅、保险', musd(econ.steady.opex)],
      [`10 年净现值（折现率 ${pct(a.discount)}）`, musd(econ.npv)],
      ['内部收益率', pct(econ.irr)],
      ['回收期（未折现）', yrs(econ.payback)],
      ['回收期（折现）', yrs(econ.discountedPayback)],
    ], ['l', 'r']),
    '',
    '## 投资清单',
    '',
    table(['项目', '类别', '年份', '数量', '基准单价', '单价区间', '基准金额', '使用年限', '每年维护'], capexRows, ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r']),
    '',
    table(['类别', '金额（基准）'], Object.entries(econ.capexByGroup).map(([k, v]) => [k, usd(v)]), ['l', 'r']),
    '',
    '机器人类设备（货格机器人、送框小车、补货机器人、盘点机器人、洗地机器人、自动托盘车、装柜机器人）后买的和到期换新的，按每年降价 4% 计。',
    '',
    '每年的订阅和服务费：',
    '',
    table(['项目', '基准', '区间'], SUBSCRIPTIONS.map((s) => [s.label, usd(s.base), `${usd(s.low)}–${usd(s.high)}`]), ['l', 'r', 'r']),
    '',
    '## 主要假设',
    '',
    table(['假设', '基准值'], [
      ['综合时薪（工资 + 社保福利）', '22 美元；机器人值班员 32 美元'],
      ['实际工资年增长', pct(a.wageGrowth)],
      ['线上订单', '2027 年 266 单 / 天，2030 年 532 单 / 天（中间按几何增长），之后每年 +3%'],
      ['爬坡', `第 1 年实现稳态节省的 ${pct(a.ramp[0])}，第 2 年 ${pct(a.ramp[1])}`],
      ['每年营业天数', `${a.days} 天`],
      ['仿真外的节省', `洗地机器人替代夜间人工洗地 ${a.cleaningHours} 小时 / 晚`],
      ['保险', '设备原值的 0.5% / 年'],
      ['期末残值', '没用完的年限按直线折算'],
    ], ['l', 'l']),
    '',
    '## 每天的成本随订单量变化',
    '',
    table(['线上订单（单 / 天）', '上一代', 'StoreX 不建货格仓', 'StoreX', '比上一代省', '货格仓带来的节省'], volRows),
    '',
    '每单的线上作业人工成本（带薪）：',
    '',
    table(['线上订单（单 / 天）', '上一代', 'StoreX 不建货格仓', 'StoreX'], costPerOrder),
    '',
    '## 10 年现金流（基准）',
    '',
    table(['年份', '订单（单 / 天）', '毛节省', '维护 + 订阅 + 保险', '投资 + 换新', '残值', '净现金流', '累计'], econ.rows.map((r) => [`${r.year}`, r.orders ? fmt(r.orders, 0) : '—', usd(r.gross), usd(r.maintenance + r.subscriptions + r.insurance), usd(r.capex + r.replacement), r.residual ? usd(r.residual) : '—', usd(r.net), usd(r.cumulative)])),
    '',
    '毛节省的构成（2030 年）：',
    '',
    (() => {
      const r = econ.rows.find((x) => x.year === 2030) as EconResult['rows'][number];
      return table(['来源', '每年'], [
        ['人工', usd(r.saving.labor)],
        ['电费', usd(r.saving.energy)],
        ['生鲜报废和打折', usd(r.saving.freshLoss)],
        ['缺货流失的毛利', usd(r.saving.lostMargin)],
        ['夜间人工洗地（仿真外）', usd(r.extra)],
        ['合计', usd(r.gross)],
      ], ['l', 'r']);
    })(),
    '',
    '![累计现金流](cashflow.svg)',
    '',
    '## 货格仓本身的账',
    '',
    '对照：同样的 StoreX 不建货格仓（线上订单全部用智能推车在卖场拣）。只算货格仓的投资（货格结构、机器人、站台、软件、后仓改造）和它比「不建」多省的钱。',
    '',
    table(['', '数值'], [
      ['10 年净现值', musd(mfc.npv)],
      ['内部收益率', Number.isFinite(mfc.irr) ? pct(mfc.irr) : '—'],
      ['回收期（未折现）', yrs(mfc.payback)],
      ['每年摊销 + 维护 + 订阅（按 2030 年设备）', usd(be.annualCost)],
      ['盈亏平衡的线上订单量', Number.isFinite(be.volume) ? `约 ${fmt(be.volume, 0)} 单 / 天` : '—'],
    ], ['l', 'r']),
    '',
    '## 不建货格仓的方案（给订单少的门店）',
    '',
    'StoreX 去掉货格仓（以及它的软件、站台和后仓改造），其余技术都保留，对上一代的账：',
    '',
    table(['', '订单按基准增长（266 → 532 单）', '订单少的门店（150 → 180 单）'], [
      ['投资', musd(pk.pkg.capexTotal), musd(pk.pkgSmall.capexTotal)],
      ['10 年净现值', musd(pk.pkg.npv), musd(pk.pkgSmall.npv)],
      ['内部收益率', Number.isFinite(pk.pkg.irr) ? pct(pk.pkg.irr) : '—', Number.isFinite(pk.pkgSmall.irr) ? pct(pk.pkgSmall.irr) : '—'],
      ['回收期（未折现）', yrs(pk.pkg.payback), yrs(pk.pkgSmall.payback)],
      ['对照：完整 StoreX 的 10 年净现值', musd(econ.npv), musd(pk.fullSmall.npv)],
    ], ['l', 'r', 'r']),
    '',
    '## 敏感性',
    '',
    '![敏感性：10 年净现值](tornado.svg)',
    '',
    table(['假设', '低值', '净现值', '高值', '净现值'], sens.map((s) => [s.label, s.low.label, musd(s.low.npv), s.high.label, musd(s.high.npv)]), ['l', 'l', 'r', 'l', 'r']),
    '',
    '## 情景',
    '',
    table(['情景', '设定', '10 年净现值', '内部收益率', '回收期'], scen.map(({ sc, r }) => [sc.label, sc.detail, musd(r.npv), Number.isFinite(r.irr) ? pct(r.irr) : '—', yrs(r.payback)]), ['l', 'l', 'r', 'r', 'r']),
    '',
  ].join('\n');
}
