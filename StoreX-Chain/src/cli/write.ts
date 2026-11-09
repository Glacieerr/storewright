import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ci95 } from '../../../StoreX/src/core/stats';
import { barChart, changeChart, lineChart, SERIES, tornadoChart } from '../../../StoreX/src/analysis/svg';
import { BASE, CAPEX, cashflow, increment, SCENARIOS, sensitivity, STORE_CAPEX_FLAGSHIP, storeProgramCapex, storeProgramOpex, SUBSCRIPTIONS, type Assumptions, type CurvePoint, type DayCost, type EconResult } from '../analysis/economics';
import { fmt, meanCi, meanOf, musd, pct, table, usd } from '../analysis/format';
import { kpi, KPIS, storeOpex } from '../analysis/kpi';
import { regionMap } from '../analysis/mapSvg';
import { capacity, pair, run, runSweep, seedsOf, stress, STRESS, stressMetrics, SWEEPS, threeGens, type Arm, type CapacityResult, type StressResult, type SweepResult } from '../analysis/studies';
import { twinMean, twinStudy, TWIN_ARMS, TWIN_LEVELS, type TwinRun } from '../analysis/twinStudy';
import { STORE, STORES, TOTAL_SIZE } from '../region/network';
import { FAMILIES, type Family, type Source, type Temp } from '../region/products';
import type { ChainResult } from '../sim/engine';
import { g3, type Gen } from '../sim/config';
import { planFlows, type FlowDecision } from '../sim/flows';
import { ISSUE_LABEL, type IssueKind } from '../twin/types';

/**
 * 跑全部实验，写 docs/results/：Markdown 结果页、SVG 图和 data.json（网页「对比与报告」页也读这份数据）。
 */
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../docs/results');
const WEB_DATA = join(dirname(fileURLToPath(import.meta.url)), '../../web/src/data/results.json');
const GC: Record<Gen, string> = { g1: SERIES.gen1, g2: SERIES.storex, g3: SERIES.noMfc };
const GL: Record<Gen, string> = { g1: '上一代', g2: 'StoreX', g3: 'StoreX 全链路' };
const GENS: Gen[] = ['g1', 'g2', 'g3'];
const NOTE = '> 数字来自 `npm run reports` 的全链路仿真（合成数据，每次 18 周，前 10 周预热、后 8 周计入）。「±」后面是 95% 置信区间的半宽；三代用同一组种子（同样的需求、促销和船期），配对差值的置信区间不含 0 才判为「改善 / 变差」。';

const avg = (runs: readonly ChainResult[], f: (r: ChainResult) => number) => ci95(runs.map(f)).mean;
const write = (name: string, text: string) => writeFileSync(join(OUT, name), text);

function dayCost(runs: readonly ChainResult[]): DayCost {
  const m = (f: (r: ChainResult) => number) => avg(runs, f);
  return {
    outbound: m((r) => r.cost.outbound),
    vans: m((r) => r.cost.vans),
    inbound: m((r) => r.cost.inbound),
    drayageRail: m((r) => r.cost.drayageRail),
    freight: m((r) => r.cost.freight),
    dcLabor: m((r) => r.cost.dcLabor),
    carrying: m((r) => r.cost.carrying),
    waste: m((r) => r.cost.waste),
    lostMargin: m((r) => r.cost.lostMargin),
    total: m((r) => r.cost.total),
    storeOpex: m(storeOpex),
    inventory: m((r) => r.store.invValue + r.dc.invValue),
  };
}

function curveOf(c: CapacityResult): CurvePoint[] {
  return c.scales.map((scale, i) => ({ scale, gen: { g1: dayCost(c.arms.g1[i] as ChainResult[]), g2: dayCost(c.arms.g2[i] as ChainResult[]), g3: dayCost(c.arms.g3[i] as ChainResult[]) } }));
}

const SRC: Record<Source, string> = { domestic: '长途公路', local: '区域生鲜', bakery: '中央面包房', sea: '海运进口', rail: '铁路班列', air: '空运进口' };
const TEMP: Record<Temp, string> = { ambient: '常温', chilled: '冷藏', frozen: '冷冻' };

export async function writeAll(opts: { seeds: number; sweepSeeds: number; twinSeeds: number }): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(dirname(WEB_DATA), { recursive: true });
  const t0 = performance.now();
  const seedsA = seedsOf(opts.seeds);
  const seedsB = seedsOf(opts.sweepSeeds);
  const log = (s: string) => process.stderr.write(`\n${s} `);
  log('三代对比');
  const arms = threeGens(seedsA);
  const [A1, A2, A3] = arms as [Arm, Arm, Arm];
  log('决策扫描');
  const sweeps = SWEEPS.map((s) => runSweep(s, seedsB));
  log('需求增长');
  const cap = capacity(seedsB);
  log('压力演练');
  const st = stress(seedsB);
  log('闭环孪生');
  const tw = twinStudy(seedsOf(opts.twinSeeds));
  log('商业分析');
  const curve = curveOf(cap);
  const up = cashflow(curve, BASE, 'upstream');
  const sys = cashflow(curve, BASE, 'system');
  const sensUp = sensitivity(curve, BASE, 'upstream');
  const scenUp = SCENARIOS.map((sc) => ({ sc, r: cashflow(curve, { ...BASE, ...sc.patch }, 'upstream') }));
  const scenSys = SCENARIOS.map((sc) => ({ sc, r: cashflow(curve, { ...BASE, ...sc.patch }, 'system') }));
  // 不上配送中心自动化：全链路的配送中心人工按自动化扫描里 0% 和选用值的比例放大，投资里去掉自动化和切换期的损失
  const autoSweep = sweeps.find((x) => x.spec.key === 'automation') as (typeof sweeps)[number];
  const labor = (v: number | string) => meanOf(kpi('costDc'), (autoSweep.points.find((p) => p.value === v) as (typeof autoSweep.points)[number]).runs);
  const autoRatio = labor(0) / labor(autoSweep.spec.chosen);
  const curveNoAuto: CurvePoint[] = curve.map((p) => ({ ...p, gen: { ...p.gen, g3: { ...p.gen.g3, dcLabor: p.gen.g3.dcLabor * autoRatio, total: p.gen.g3.total + p.gen.g3.dcLabor * (autoRatio - 1) } } }));
  const autoCases = [
    { label: '基准', a: BASE },
    { label: '保守情景', a: { ...BASE, ...(SCENARIOS.find((x) => x.key === 'conservative') as (typeof SCENARIOS)[number]).patch } },
    { label: '投资取低值、时薪 34 美元、2030 年需求 +40%', a: { ...BASE, capex: 'low', wage: 34 / 28, scale2030: 1.4 } as Assumptions },
  ].map(({ label, a }) => {
    const withIt = cashflow(curve, a, 'upstream');
    const without = cashflow(curveNoAuto, a, 'upstream', ['automation', 'cutover']);
    return { label, without, inc: increment(withIt, without, a), hours: (labor(0) - labor(autoSweep.spec.chosen)) / BASE_WAGE };
  });
  const runtime = (performance.now() - t0) / 1000;
  const days = arms.length * seedsA.length + sweeps.reduce((s, x) => s + x.points.length * seedsB.length, 0) + cap.scales.length * 3 * seedsB.length + (1 + STRESS.length) * 3 * seedsB.length + opts.twinSeeds;
  const twinDays = tw.length;

  // —— 图 ——
  write('region-map.svg', regionMap());
  const costCats = ['配送（含面包车）', '进货运输（含长途直送）', '港口拖车和铁路', '海运、班列、空运运费', '配送中心人工', '库存持有', '生鲜报废和打折', '缺货流失的毛利'];
  const costOf = (runs: readonly ChainResult[]) => [avg(runs, (r) => r.cost.outbound + r.cost.vans), avg(runs, (r) => r.cost.inbound), avg(runs, (r) => r.cost.drayageRail), avg(runs, (r) => r.cost.freight), avg(runs, (r) => r.cost.dcLabor), avg(runs, (r) => r.cost.carrying), avg(runs, (r) => r.cost.waste), avg(runs, (r) => r.cost.lostMargin)];
  write('cost-breakdown.svg', barChart({ title: '每天的供应链成本，按项目分', subtitle: `美元 / 天，${seedsA.length} 个种子平均`, categories: costCats, series: arms.map((a) => ({ name: a.label, color: GC[a.gen], values: costOf(a.runs) })) }));
  const headKeys = ['service', 'storeInv', 'waste', 'freshRemain', 'arrivals', 'dcInv', 'dcLabor', 'outKm', 'fill', 'fleet', 'inboundKm', 'dwell', 'co2Local', 'costTransport', 'costTotal', 'workingCapital', 'systemTotal'];
  for (const [b, a, name] of [
    [A3, A1, 'g3-vs-g1'],
    [A3, A2, 'g3-vs-g2'],
  ] as const) {
    const rows = pair(a, b, headKeys.map((k) => kpi(k)));
    const vs = /^[A-Za-z]/.test(a.label) ? ` ${a.label} ` : a.label;
    write(`change-${name}.svg`, changeChart({ title: `StoreX 全链路相对${vs}的变化`, subtitle: `${seedsA.length} 个种子的配对差值 ÷ ${vs}的均值；灰色 = 差异不显著`, items: rows.map((r) => ({ label: r.kpi.label, pct: r.pct, good: r.verdict === '改善' ? true : r.verdict === '变差' ? false : null })) }));
  }
  write('inventory.svg', barChart({ title: '库存（按天数计）', subtitle: `天的需求，${seedsA.length} 个种子平均`, categories: ['门店', '配送中心'], digits: 1, series: arms.map((a) => ({ name: a.label, color: GC[a.gen], values: [avg(a.runs, (r) => r.store.invDays), avg(a.runs, (r) => r.dc.invDays)] })) }));
  write('co2.svg', barChart({ title: '每天的二氧化碳排放', subtitle: '吨 / 天（远洋和航空按自己货物的重量分摊）', categories: ['城市配送', '面包房直送', '供应商和区域生鲜进货', '港口拖车和铁路', '远洋和航空'], digits: 1, series: arms.map((a) => ({ name: a.label, color: GC[a.gen], values: [avg(a.runs, (r) => r.co2.outbound / 1000), avg(a.runs, (r) => r.co2.vans / 1000), avg(a.runs, (r) => r.co2.inbound / 1000), avg(a.runs, (r) => r.co2.portRail / 1000), avg(a.runs, (r) => r.co2.longHaul / 1000)] })) }));
  for (const sw of sweeps) {
    const k = kpi(sw.spec.chart);
    const idx = sw.spec.values.indexOf(sw.spec.chosen);
    const label = (v: number | string) => {
      const s = (sw.spec.short ?? sw.spec.label)(v);
      return s.length > 12 ? s.slice(0, 12) + '…' : s;
    };
    write(`sweep-${sw.spec.key}.svg`, lineChart({ title: sw.spec.title, subtitle: `${k.label}（${k.unit}）· ${seedsB.length} 个种子平均，竖线是 95% 置信区间`, x: sw.spec.values.map(label), digits: k.digits ?? 1, ...(idx >= 0 ? { highlight: idx } : {}), series: [{ name: k.label, color: GC.g3, values: sw.points.map((p) => meanOf(k, p.runs)), err: sw.points.map((p) => ci95(p.runs.map(k.get)).half) }] }));
  }
  const capX = cap.scales.map((x) => `${Math.round(x * 100)}%`);
  const capSeries = (key: string) => GENS.map((gen) => ({ name: GL[gen], color: GC[gen], values: cap.arms[gen].map((runs) => meanOf(kpi(key), runs)) }));
  write('capacity-cost.svg', lineChart({ title: '每箱的供应链成本随需求增长', subtitle: '美元 / 箱；横轴是综合店的需求（100% = 现在，124% ≈ 2030 年线上订单翻倍）', x: capX, digits: 2, series: capSeries('costPerCase') }));
  write('capacity-dclabor.svg', lineChart({ title: '配送中心工时随需求增长', subtitle: '小时 / 天', x: capX, digits: 0, series: capSeries('dcLabor') }));
  write('capacity-fleet.svg', lineChart({ title: '配送车队随需求增长', subtitle: '辆（最多同时用车）', x: capX, digits: 0, series: capSeries('fleet') }));
  write('stress.svg', barChart({ title: '压力演练：最差一天的服务水平比平常低多少', subtitle: `个百分点（扰动开始后 3 周里，和同一种子、没有扰动的那次逐日比），${seedsB.length} 个种子平均；越低越好`, categories: st.cases.map(({ c }) => c.label), digits: 1, series: GENS.map((gen) => ({ name: GL[gen], color: GC[gen], values: st.cases.map(({ gens }) => metricsAvg(gens[gen]).worstDrop) })) }));
  const years = up.rows.map((r) => `${r.year}`);
  write('cashflow-upstream.svg', lineChart({ title: '累计现金流：上游这一步（StoreX → StoreX 全链路）', subtitle: '百万美元（2026 年不变价格，未折现）', x: years, digits: 1, yMin: Math.min(...scenUp.flatMap(({ r }) => r.rows.map((x) => x.cumulative / 1e6))), series: scenUp.map(({ sc, r }, i) => ({ name: sc.label, color: [SERIES.s4, SERIES.storex, SERIES.noMfc][i] as string, values: r.rows.map((x) => x.cumulative / 1e6) })) }));
  write('cashflow-system.svg', lineChart({ title: '累计现金流：全系统（上一代 → StoreX 全链路，含综合店改造）', subtitle: '百万美元（2026 年不变价格，未折现）', x: years, digits: 0, yMin: Math.min(...scenSys.flatMap(({ r }) => r.rows.map((x) => x.cumulative / 1e6))), series: scenSys.map(({ sc, r }, i) => ({ name: sc.label, color: [SERIES.s4, SERIES.storex, SERIES.noMfc][i] as string, values: r.rows.map((x) => x.cumulative / 1e6) })) }));
  const twColors = [SERIES.gen1, SERIES.s4, SERIES.storex, SERIES.noMfc] as const;
  const twSeeds = new Set(tw.map((r) => r.seed)).size;
  for (const lv of TWIN_LEVELS)
    write(`twin-${lv.key}.svg`, barChart({ title: `闭环孪生：${lv.label}，现场出了多少问题`, subtitle: `分钟 / 天，${twSeeds} 个种子平均（全链路方案第 86 天的计划）`, categories: ['门店收货迟到', '冷链超温', '门店缺货'], digits: 0, series: TWIN_ARMS.map((a, i) => ({ name: a.short, color: twColors[i] as string, values: [twinMean(tw, lv.key, a.key, (r) => r.late), twinMean(tw, lv.key, a.key, (r) => r.hot), twinMean(tw, lv.key, a.key, (r) => r.short)] })) }));
  write('tornado-upstream.svg', tornadoChart({ title: '敏感性：上游这一步的 10 年净现值', subtitle: '每次只改一个假设，其余保持基准', base: up.npv, scale: 1e6, unit: ' 百万', items: sensUp.map((s) => ({ label: s.label, low: { label: s.low.label, value: s.low.npv }, high: { label: s.high.label, value: s.high.npv } })) }));

  // —— 结果页 ——
  const fig = (file: string, alt: string) => `![${alt}](${file})`;
  const genTable = (keys: readonly string[]) => {
    const rowsA = pair(A1, A3, keys.map((k) => kpi(k)));
    const rowsB = pair(A2, A3, keys.map((k) => kpi(k)));
    return table(
      ['指标', '上一代', 'StoreX', 'StoreX 全链路', '全链路 vs 上一代', '全链路 vs StoreX'],
      keys.map((key, i) => {
        const k = kpi(key);
        const ra = rowsA[i] as (typeof rowsA)[number];
        const rb = rowsB[i] as (typeof rowsB)[number];
        const v = (r: typeof ra) => (Math.abs(r.a.mean) > 1e-9 ? `${r.pct > 0 ? '+' : ''}${fmt(r.pct, 0)}% ${r.verdict}` : r.verdict);
        return [`${k.group} · ${k.label}（${k.unit}）`, meanCi(k, A1.runs), meanCi(k, A2.runs), meanCi(k, A3.runs), v(ra), v(rb)];
      }),
      ['l', 'r', 'r', 'r', 'l', 'l'],
    );
  };
  const famTable = table(
    ['商品族', '货源', '配送中心满足率（上一代 / StoreX / 全链路，%）', '门店服务水平（%）', '门店生鲜损耗（%）'],
    FAMILIES.map((f, i) => {
      const v = (a: Arm, k: 'dcFill' | 'service' | 'wastePct') => fmt(avg(a.runs, (r) => (r.byFamily[i] as ChainResult['byFamily'][number])[k]), 1);
      return [f.label, SRC[f.source], `${v(A1, 'dcFill')} / ${v(A2, 'dcFill')} / ${v(A3, 'dcFill')}`, `${v(A1, 'service')} / ${v(A2, 'service')} / ${v(A3, 'service')}`, f.life ? `${v(A1, 'wastePct')} / ${v(A2, 'wastePct')} / ${v(A3, 'wastePct')}` : '—'];
    }),
    ['l', 'l', 'r', 'r', 'r'],
  );

  write('01-generations.md', [
    '# 结果 1：三代全链路对比',
    '',
    NOTE,
    '',
    `每一代 ${seedsA.length} 个种子。上一代 = Storewright 的门店 + 传统供应链；StoreX = 门店升级成 StoreX，上游不变；StoreX 全链路 = 门店 + 上游一起由全链路数字孪生协同。区域里只有一家综合店（${STORE.name}，规模约为 StoreX 门店的 ${fmt(TOTAL_SIZE, 1)} 倍），每天约 ${fmt(avg(A1.runs, (r) => r.casesDelivered) / 1000, 1)} 千箱。海运、铁路班列和空运的货先进配送中心，再用卡车送店；长途公路（国内、跨境）的整车由货流规划决定直送门店还是进配送中心，全链路里 ${fmt(avg(A3.runs, kpi('directShare').get), 0)}% 的长途整车直送门店（见[结果 6](06-flows.md)）。`,
    '',
    fig('change-g3-vs-g1.svg', 'StoreX 全链路相对上一代的变化'),
    '',
    fig('change-g3-vs-g2.svg', 'StoreX 全链路相对 StoreX 的变化'),
    '',
    '## 全部指标',
    '',
    genTable(KPIS.map((k) => k.key)),
    '',
    '## 钱花在哪里',
    '',
    fig('cost-breakdown.svg', '每天的供应链成本，按项目分'),
    '',
    fig('inventory.svg', '库存天数'),
    '',
    fig('co2.svg', '每天的二氧化碳排放'),
    '',
    '## 按商品族',
    '',
    famTable,
    '',
  ].join('\n'));

  // 每一项举措单独值多少：选用值 vs「不做这一项」（其余保持全链路），供应链成本和本地排放的差
  const levers = sweeps.map((sw) => {
    const base = sw.points.find((p) => p.value === (sw.spec.baseline ?? sw.spec.values[0])) as (typeof sw.points)[number];
    const chosen = sw.points.find((p) => p.value === sw.spec.chosen) as (typeof sw.points)[number];
    const d = (key: string) => meanOf(kpi(key), chosen.runs) - meanOf(kpi(key), base.runs);
    return { key: sw.spec.key, title: sw.spec.title, from: sw.spec.label(base.value), to: sw.spec.label(chosen.value), cost: d('costTotal'), co2: d('co2Local'), service: d('service'), inventory: d('workingCapital') };
  });
  write('02-sweeps.md', [
    '# 结果 2：全链路方案的决策扫描',
    '',
    NOTE,
    '',
    `每次只改一项，其余保持 StoreX 全链路的选用值；每个配置 ${seedsB.length} 个种子。标「选用」的是最后的方案。`,
    '',
    '## 每一项单独值多少',
    '',
    '其余保持全链路的选用值，只把这一项从「不做」换成选用值时的变化（负数 = 省钱 / 减排）。各项之间有交互，加起来不等于全链路相对 StoreX 的总差。',
    '',
    table(['举措', '不做', '选用', '供应链成本（美元 / 天）', '本地运输排放（吨 / 天）', '门店服务水平（个百分点）', '库存资金（百万美元）'], levers.map((l) => [l.title, l.from, l.to, usd(l.cost), fmt(l.co2, 2), fmt(l.service, 2), fmt(l.inventory, 2)]), ['l', 'l', 'l', 'r', 'r', 'r', 'r']),
    '',
    ...sweeps.flatMap((sw) => {
      const ks = sw.spec.kpis.map((k) => kpi(k));
      return [
        `## ${sw.spec.title}`,
        '',
        `**问题：** ${sw.spec.question}`,
        '',
        fig(`sweep-${sw.spec.key}.svg`, sw.spec.title),
        '',
        table([sw.spec.title, ...ks.map((k) => `${k.label}（${k.unit}）`)], sw.points.map((p) => [`${sw.spec.label(p.value)}${p.value === sw.spec.chosen ? ' **（选用）**' : ''}`, ...ks.map((k) => meanCi(k, p.runs))])),
        '',
        ...(sw.spec.note ? [sw.spec.note((v, key) => meanOf(kpi(key), (sw.points.find((p) => p.value === v) as (typeof sw.points)[number]).runs)), ''] : []),
      ];
    }),
  ].join('\n'));

  const capKeys = ['service', 'dcLabor', 'fleet', 'trips', 'storeInv', 'dcInv', 'costPerCase', 'co2PerCase'];
  write('03-capacity.md', [
    '# 结果 3：需求增长',
    '',
    NOTE,
    '',
    `综合店的需求从现在的 80% 到 160%（StoreX 报告里线上订单翻倍时，门店的总件数约 +24%）。三代都按需求自动排班、派车、订货；全链路的直送清单不变（需求涨了，直送一车的间隔变短）。每个点 ${seedsB.length} 个种子。`,
    '',
    fig('capacity-cost.svg', '每箱的供应链成本'),
    '',
    fig('capacity-dclabor.svg', '配送中心工时'),
    '',
    fig('capacity-fleet.svg', '配送车队'),
    '',
    table(['需求 · 方案', ...capKeys.map((k) => `${kpi(k).label}（${kpi(k).unit}）`)], cap.scales.flatMap((sc, i) => GENS.map((gen) => [`${Math.round(sc * 100)}% · ${GL[gen]}`, ...capKeys.map((k) => meanCi(kpi(k), cap.arms[gen][i] as ChainResult[]))]))),
    '',
  ].join('\n'));

  write('04-stress.md', stressPage(st, seedsB.length));
  write('06-flows.md', flowsPage(planFlows(g3(1)), genTable, sweeps.find((x) => x.spec.key === 'direct')));
  write('07-twin.md', twinPage(tw));
  write('05-economics.md', economicsPage(up, sys, sensUp, scenUp, scenSys, curve, autoCases));

  write('README.md', [
    '# StoreX 全链路：实验结果',
    '',
    '这个目录由 `npm run reports`（`StoreX-Chain/` 下）生成，所有报告里的数字都从这里来。重新生成会覆盖这些文件。',
    '',
    '> 本项目与任何零售商、企业无隶属关系；所有数字都是合成数据上的仿真结果。',
    '',
    table(['结果页', '内容'], [
      ['[01-generations.md](01-generations.md)', '三代全链路对比：门店、配送中心、运输、港口和机场、成本、排放、全系统'],
      ['[02-sweeps.md](02-sweeps.md)', '全链路方案的决策扫描：自动化、合并配送、电动车、铁路、预清关、补货频率、安全库存、越库、回程顺带'],
      ['[03-capacity.md](03-capacity.md)', '需求从 80% 涨到 160%'],
      ['[04-stress.md](04-stress.md)', '压力演练：港口拥堵、机场关闭、高速封闭、供应商停产、需求突增'],
      ['[05-economics.md](05-economics.md)', '投资、10 年现金流、净现值、回收期、敏感性和情景（上游这一步、全系统）'],
      ['[06-flows.md](06-flows.md)', '货流规划：每类货从哪来、走哪条路；长途整车直送门店还是进配送中心，每个商品族的账'],
      ['[07-twin.md](07-twin.md)', '闭环孪生：同一天的现场，不用孪生、只自动执行低风险的、加调度员批准、全部自动执行'],
      ['region-map.svg', '区域地图'],
      ['data.json', '以上结果的数据（网页也用这份数据）'],
    ], ['l', 'l']),
    '',
    table(['', ''], [
      ['仿真次数（每次 18 周）', `${days} 次`],
      ['三代对比的种子数', `${seedsA.length}`],
      ['扫描、增长、压力演练的种子数', `${seedsB.length}`],
      ['闭环孪生（一天的现场，两种状况 × 四种做法）', `${twSeeds} 个种子，${twinDays} 次`],
      ['用时', `${fmt(runtime, 0)} 秒`],
    ], ['l', 'r']),
    '',
  ].join('\n'));

  // —— 数据 ——
  const means = (runs: readonly ChainResult[]) => Object.fromEntries(KPIS.map((k) => [k.key, round(ci95(runs.map(k.get)).mean)]));
  const halves = (runs: readonly ChainResult[]) => Object.fromEntries(KPIS.map((k) => [k.key, round(ci95(runs.map(k.get)).half)]));
  const data = {
    seeds: { compare: seedsA.length, sweep: seedsB.length },
    kpis: KPIS.map((k) => ({ key: k.key, label: k.label, unit: k.unit, group: k.group, better: k.better, digits: k.digits ?? 1 })),
    gens: arms.map((a) => ({ gen: a.gen, label: a.label, mean: means(a.runs), ci: halves(a.runs), cost: costOf(a.runs).map(round) })),
    costCats,
    pairs: { g3g1: pair(A1, A3).map((r) => ({ key: r.kpi.key, pct: round(r.pct), verdict: r.verdict })), g3g2: pair(A2, A3).map((r) => ({ key: r.kpi.key, pct: round(r.pct), verdict: r.verdict })) },
    levers: levers.map((l) => ({ ...l, cost: round(l.cost), co2: round(l.co2), service: round(l.service), inventory: round(l.inventory) })),
    sweeps: sweeps.map((sw) => ({ key: sw.spec.key, title: sw.spec.title, question: sw.spec.question, chart: sw.spec.chart, chosen: sw.spec.chosen, kpis: sw.spec.kpis, points: sw.points.map((p) => ({ value: p.value, label: sw.spec.label(p.value), mean: Object.fromEntries(sw.spec.kpis.map((k) => [k, round(meanOf(kpi(k), p.runs))])) })), ...(sw.spec.note ? { note: sw.spec.note((v, key) => meanOf(kpi(key), (sw.points.find((p) => p.value === v) as (typeof sw.points)[number]).runs)) } : {}) })),
    capacity: { scales: cap.scales, gens: Object.fromEntries(GENS.map((gen) => [gen, cap.arms[gen].map(means)])) },
    stress: st.cases.map(({ c, gens }) => ({ key: c.key, label: c.label, detail: c.detail, gens: Object.fromEntries(GENS.map((gen) => [gen, metricsAvg(gens[gen])])) })),
    automation: autoCases.map((c) => ({ label: c.label, npv: round(c.inc.npv), irr: round(c.inc.irr * 100), payback: round(c.inc.payback), withoutNpv: round(c.without.npv), hours: round(c.hours) })),
    economics: { upstream: econData(up, scenUp), system: econData(sys, scenSys), sensitivity: sensUp.map((s) => ({ label: s.label, low: { label: s.low.label, npv: round(s.low.npv) }, high: { label: s.high.label, npv: round(s.high.npv) } })) },
    stores: STORES.map((s) => ({ key: s.key, name: s.name, size: s.size, docks: s.docks })),
    flows: planFlows(g3(1)).map((d) => ({ key: d.key, label: d.label, via: d.via, palletsPerDay: round(d.palletsPerDay), loads: d.loads, interval: round(d.interval), costDc: round(d.costDc), costDirect: round(d.costDirect), reason: d.reason })),
    twin: {
      seeds: twSeeds,
      arms: TWIN_ARMS.map((a) => ({ key: a.key, label: a.label, short: a.short })),
      levels: TWIN_LEVELS.map((lv) => ({
        key: lv.key,
        label: lv.label,
        arms: Object.fromEntries(TWIN_ARMS.map((a) => [a.key, Object.fromEntries((['late', 'hot', 'short', 'lost', 'cost', 'cards', 'auto', 'user', 'expired'] as const).map((k) => [k, round(twinMean(tw, lv.key, a.key, (r) => r[k]))]))])),
        fidelity: { eta30: round(twinMean(tw, lv.key, 'open', (r) => r.eta30)), eta60: round(twinMean(tw, lv.key, 'open', (r) => r.eta60)), eta120: round(twinMean(tw, lv.key, 'open', (r) => r.eta120)), temp: round(twinMean(tw, lv.key, 'open', (r) => r.temp)) },
      })),
    },
    runtime: round(runtime),
    runs: days,
  };
  const json = JSON.stringify(data, (_, v) => (typeof v === 'number' ? round(v) : v));
  write('data.json', json);
  writeFileSync(WEB_DATA, json);
  process.stderr.write(`\n写好了：${OUT}（${days} 次仿真，${fmt(runtime, 0)} 秒）\n`);
  void g3;
  void run;
}

function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4;
  return Number(x.toFixed(d));
}

function metricsAvg(list: readonly { base: ChainResult; hit: ChainResult }[]) {
  const ms = list.map(stressMetrics);
  const m = (k: keyof (typeof ms)[number]) => ms.reduce((a, x) => a + x[k], 0) / Math.max(1, ms.length);
  return { window: round(m('window')), windowDrop: round(m('windowDrop')), worstDrop: round(m('worstDrop')), airDrop: round(m('airDrop')), onTimeDrop: round(m('onTimeDrop')), response: round(m('response')), extraCost: round(m('extraCost')), lostUnits: round(m('lostUnits')) };
}

function econData(r: EconResult, scen: { sc: (typeof SCENARIOS)[number]; r: EconResult }[]) {
  return {
    capex: round(r.capexTotal),
    npv: round(r.npv),
    irr: round(r.irr * 100),
    payback: round(r.payback),
    workingCapital: round(r.workingCapital),
    steady: { gross: round(r.steady.gross), opex: round(r.steady.opex), net: round(r.steady.net) },
    rows: r.rows.map((x) => ({ year: x.year, gross: round(x.gross), opex: round(x.opex), capex: round(x.capex), wc: round(x.workingCapital), net: round(x.net), cumulative: round(x.cumulative) })),
    scenarios: scen.map(({ sc, r: x }) => ({ key: sc.key, label: sc.label, detail: sc.detail, npv: round(x.npv), irr: round(x.irr * 100), payback: round(x.payback), cumulative: x.rows.map((y) => round(y.cumulative)) })),
  };
}

function stressPage(st: StressResult, n: number): string {
  const rows: string[][] = [];
  for (const { c, gens } of st.cases) {
    for (const gen of GENS) {
      const m = metricsAvg(gens[gen]);
      rows.push([`${c.label} · ${GL[gen]}`, fmt(m.window, 2), fmt(m.windowDrop, 2), fmt(m.worstDrop, 1), fmt(m.airDrop, 1), fmt(m.onTimeDrop, 1), fmt(m.lostUnits / 1000, 1), usd(m.response), usd(m.extraCost)]);
    }
  }
  return [
    '# 结果 4：压力演练',
    '',
    NOTE,
    '',
    `扰动从第 80 天开始（计入结果的第 2 周）。每种情况、每一代 ${n} 个种子。除了第一列，其余都是和同一种子、没有扰动的那次逐日相比：「比平常低」只算扰动带来的下降，不受平常的促销和波动影响。`,
    '',
    table(['情况', '设定'], STRESS.map((c) => [c.label, c.detail]), ['l', 'l']),
    '',
    '![压力演练：最差一天的服务水平比平常低多少](stress.svg)',
    '',
    table(['情况 · 方案', '之后 3 周的服务水平（%）', '3 周平均比平常低（个百分点）', '最差一天比平常低（个百分点）', '空运生鲜最差一天比平常低', '准时送达最差一天比平常低', '多出的缺货（千件）', '应对花的钱', '多花的钱合计'], rows),
    '',
    '全链路的应对：港口拥堵时孪生发现班轮延误，向国内分销商过桥采购 6 天的进口商品（贵 15%），并靠预清关和预约优先放行自己的箱；机场关闭时改降备降机场，卡车运回；供应商停产时立即把订单转给预先认证的备用供应商；高速封闭时所有车提前改道。上一代和 StoreX 的上游没有这些手段。',
    '',
  ].join('\n');
}

function flowsPage(plan: readonly FlowDecision[], genTable: (keys: readonly string[]) => string, sweep: SweepResult | undefined): string {
  const direct = new Set(g3(1).flow.direct);
  const gate = (f: Family) => (f.supplier?.border ? `东边跨境公路（约 ${f.supplier.km} 公里，过境清关）` : `北边国内公路（约 ${f.supplier?.km ?? 0} 公里）`);
  const pathOf = (f: Family): string =>
    ({
      sea: '远洋班轮 → 港口（堆场、清关）→ 铁路接驳或集装箱拖车 → 配送中心（拆箱、上架）→ 配送车 → 门店',
      rail: '洲际铁路班列 → 物流园铁路货运站（卸箱）→ 配送中心（拆箱、上架）→ 配送车 → 门店',
      air: '货运航班 → 机场货运区 → 冷藏车 → 配送中心（夜里越库）→ 配送车 → 门店',
      local: '内陆产区的集货车（夜里，经国内长途的高速口）→ 配送中心（越库）→ 配送车 → 门店',
      bakery: '中央面包房（物流园里）→ 配送车 → 门店',
      domestic: direct.has(f.key) ? `${gate(f)} → **长途整车直送门店收货口**` : `${gate(f)} → 长途整车进配送中心（上架）→ 配送车 → 门店`,
    })[f.source];
  const by = (pred: (f: Family) => boolean) => FAMILIES.filter(pred).reduce((a, f) => a + f.share, 0) * 100;
  const pctOf = (pred: (f: Family) => boolean) => `${fmt(by(pred), 0)}%`;
  const ks = ['directShare', 'arrivals', 'peakAmbient', 'peakFrozen', 'storeInv', 'dcLabor', 'outKm', 'costTransport', 'costTotal', 'service'].map((k) => kpi(k));
  const mean = (v: number | string, key: string) => meanOf(kpi(key), (sweep?.points.find((p) => p.value === v) as SweepResult['points'][number]).runs);
  return [
    '# 结果 6：货流规划',
    '',
    NOTE,
    '',
    `区域里只有一家综合店（${STORE.name}，店后 ${STORE.docks} 个收货口）。货从六个方向来，规划要回答两件事：每类货走哪条路；长途公路的整车直送门店还是先进配送中心。`,
    '',
    '- **海运、铁路班列、空运的货都要先进配送中心**：集装箱和航空板要拆开、按商品分拣、和别的货拼成按温区的配送车；门店没有拆箱的场地，也不能一次收一整箱的单一商品。',
    '- **区域生鲜（内陆产区的乳品和果蔬）和中央面包房**的货量小、每天都要送，夜里进配送中心越库，跟当天的配送车走。',
    '- **长途公路的整车**（北边国内、东边跨境）有两条路：直送门店收货口，或者进配送中心。货流规划给每个商品族算账，再按规则排除不合适直送的。',
    '',
    '## 每类货走哪条路（StoreX 全链路）',
    '',
    `按件数：${pctOf((f) => direct.has(f.key))} 的货由长途整车直送门店；其余经配送中心——海运 ${pctOf((f) => f.source === 'sea')}、铁路班列 ${pctOf((f) => f.source === 'rail')}、空运 ${pctOf((f) => f.source === 'air')}、区域生鲜和面包房 ${pctOf((f) => f.source === 'local' || f.source === 'bakery')}、长途公路进配送中心 ${pctOf((f) => f.source === 'domestic' && !direct.has(f.key))}。上一代和 StoreX 的长途整车全部进配送中心。`,
    '',
    table(['商品族', '温区', '货源', '占件数', '路径'], FAMILIES.map((f) => [f.label, TEMP[f.temp], SRC[f.source], `${fmt(f.share * 100, 1)}%`, pathOf(f)]), ['l', 'l', 'l', 'r', 'l']),
    '',
    '## 长途整车：直送门店还是进配送中心',
    '',
    '- **进配送中心**：整车到配送中心卸车、上架，按门店的订单拣货，和别的货拼成每天的配送车；门店每天收一点，库存少。花的是配送中心的工时、送店那一段，以及配送中心按补货周期多放的库存。',
    '- **直送门店**：门店的库存降到订货点就向供应商订一整车（满载），平均隔几天来一车，到店时间排在早上的收货时段里；省掉配送中心的工时和送店那一段，但门店一次收一整车，店里多压几天的货，收货口也占得久。',
    '',
    '规则（不满足的直接进配送中心）：不是易腐品（保质期 20 天以上，否则要每天小批量送）；不是长尾商品（单品多、每个单品量小，来自很多家小供应商，凑不满整车）；一车的量门店放得下（常温不超过 4 天的量，冷冻不超过 3 天）。满足规则的再比每天的成本，直送便宜才直送。',
    '',
    table(['商品族', '每天（托）', '一车是几天的量', '进配送中心（美元 / 天）', '直送（美元 / 天）', '决定', '原因'], plan.map((d) => [d.label, fmt(d.palletsPerDay, 1), fmt(d.interval, 1), usd(d.costDc), usd(d.costDirect), d.via === 'direct' ? '**直送门店**' : '进配送中心', d.reason]), ['l', 'r', 'r', 'r', 'r', 'l', 'l']),
    '',
    '账的组成（美元 / 天）：',
    '',
    table(['商品族', '进配送中心：进货运输', '配送中心人工', '送店分摊', '库存', '直送：进货运输', '门店收货', '库存'], plan.map((d) => [d.label, usd(d.parts.dcInbound), usd(d.parts.dcLabor), usd(d.parts.dcOutbound), usd(d.parts.dcCarry), usd(d.parts.directInbound), usd(d.parts.directReceive), usd(d.parts.directCarry)]), ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r']),
    '',
    '直送车在全链路的调度台上有自己的泳道（「长途直送门店」）和门店收货口的占用；孪生把它们和配送中心的车一起跟踪，供应商发车晚了，车载终端提前几小时报预计到达时间，孪生据此通知门店顺延收货（见[结果 7](07-twin.md)）。',
    '',
    '## 仿真里的结果',
    '',
    genTable(['directShare', 'inboundLoads', 'arrivals', 'peakAmbient', 'peakChilled', 'peakFrozen', 'storeInv', 'dcInv', 'domLead', 'seaLead', 'railLead', 'airLead']),
    '',
    ...(sweep
      ? [
          '## 直送清单的三种做法',
          '',
          `其余保持全链路的选用值，只换直送清单（${sweep.points[0]?.runs.length ?? 0} 个种子；完整的扫描见[结果 2](02-sweeps.md)）：`,
          '',
          table(['直送清单', ...ks.map((k) => `${k.label}（${k.unit}）`)], sweep.points.map((p) => [`${sweep.spec.label(p.value)}${p.value === sweep.spec.chosen ? ' **（选用）**' : ''}`, ...ks.map((k) => meanCi(k, p.runs))])),
          '',
          `按规划直送比全部进配送中心每天省 ${usd(mean('none', 'costTotal') - mean('planned', 'costTotal'))}：配送中心少 ${fmt(mean('none', 'dcLabor') - mean('planned', 'dcLabor'), 0)} 工时、配送少跑 ${fmt(mean('none', 'outKm') - mean('planned', 'outKm'), 0)} 公里；代价是门店多压 ${fmt(mean('planned', 'storeInv') - mean('none', 'storeInv'), 2)} 天的库存、常温货最多的时候多 ${fmt(mean('planned', 'peakAmbient') - mean('none', 'peakAmbient'), 0)} 托（后仓要留出这些托盘位）。`,
          '',
          (sweep.spec.note?.(mean) ?? '').replace(/（规则和每个商品族的账见\[结果 6\]\(06-flows\.md\)）/, ''),
          '',
        ]
      : []),
  ].join('\n');
}

function twinPage(tw: readonly TwinRun[]): string {
  const seeds = new Set(tw.map((r) => r.seed)).size;
  const m = (lv: TwinRun['level'], arm: TwinRun['arm'], f: (r: TwinRun) => number) => twinMean(tw, lv, arm, f);
  const rowsOf = (lv: TwinRun['level']) =>
    TWIN_ARMS.map((a) => [a.label, fmt(m(lv, a.key, (r) => r.late), 0), fmt(m(lv, a.key, (r) => r.hot), 0), fmt(m(lv, a.key, (r) => r.short), 0), fmt(m(lv, a.key, (r) => r.lost), 0), usd(m(lv, a.key, (r) => r.cost)), fmt(m(lv, a.key, (r) => r.cards), 1), fmt(m(lv, a.key, (r) => r.auto), 1), fmt(m(lv, a.key, (r) => r.user), 1), fmt(m(lv, a.key, (r) => r.expired), 1)]);
  const head = ['做法', '门店收货迟到（分钟）', '冷链超温（分钟）', '门店缺货（分钟）', '少卖（件）', '措施花的钱', '建议卡（张）', '自动执行', '调度员批准', '没处理、问题发生了'];
  const kinds = Object.keys(ISSUE_LABEL) as IssueKind[];
  const d = (lv: TwinRun['level'], f: (r: TwinRun) => number) => [fmt(m(lv, 'open', f), 0), fmt(m(lv, 'dispatcher', f), 0)];
  return [
    '# 结果 7：闭环孪生',
    '',
    `> 数字来自 \`npm run reports\`：全链路方案第 86 天的计划（仿真记录的这一天的全部作业，调度台排好的月台门、门店收货口和车辆）在「现场」里一分钟一分钟跑一整天。现场会出计划不知道的状况，孪生只通过感知数据（定位、车载终端事件、冷机读数、装车进度、门磁、收银、盘点、路况）知道发生了什么。${seeds} 个种子，每个种子的现场状况不同；同一个种子下四种做法面对完全一样的状况。`,
    '',
    '现场的状况：',
    '',
    '- **平常的一天**：一成多的配送车装车晚 12–35 分钟；3 处交通事故或施工；1 辆开往门店的车抛锚（修 1.5–2 小时）；2 辆冷藏车车门密封不严，七成的日子还有 1 辆冷机压缩机坏；门店一个生鲜、一个常温商品族突然卖得快（2.3 倍，持续 5 小时）；一辆长途直送车的供应商发车晚 1.5–3 小时；3 站卸货慢。',
    '- **多事的一天**：三成的配送车装车晚；5 处事故；抛锚的是装生鲜最多的那辆，修 2.5–3.5 小时；一定有 1 辆压缩机坏；突然卖得快的是 3 倍、持续 6 小时；长途直送车晚 3–5 小时。',
    '',
    '四种做法：',
    '',
    ...TWIN_ARMS.map((a) => `- **${a.short}**：${a.label}。`),
    '',
    '孪生每 5 分钟想一次：推演每辆车的到店时间和货温、门店每个商品族什么时候卖空，发现问题就出一张建议卡，列出几种做法和每种做法推演的结果（迟到、超温、缺货的分钟和多花的钱），推荐合计分最低的。低风险的做法（提醒司机检查车门、调低冷机设定温度、改到空闲的月台门）可以自动执行；花钱或牵涉别人的（派救援车、配送中心追加补货、通知门店顺延收货、长途车改去处）要调度员批。调度员批准了「等着 / 不处理」，孪生接着盯，推荐变成要动手的做法时再出卡。',
    '',
    '## 结果',
    '',
    '![平常的一天](twin-normal.svg)',
    '',
    '![多事的一天](twin-rough.svg)',
    '',
    ...TWIN_LEVELS.flatMap((lv) => [`### ${lv.label}（每天平均）`, '', table(head, rowsOf(lv.key), ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r']), '']),
    `多事的一天，调度员在建议卡出来 10 分钟内批准推荐的做法：门店收货迟到 ${d('rough', (r) => r.late).join(' → ')} 分钟，冷链超温 ${d('rough', (r) => r.hot).join(' → ')} 分钟，门店缺货 ${d('rough', (r) => r.short).join(' → ')} 分钟、少卖 ${d('rough', (r) => r.lost).join(' → ')} 件；措施平均每天花 ${usd(m('rough', 'dispatcher', (r) => r.cost))}。`,
    '',
    '## 建议卡按种类（每天平均，加调度员批准的那一组）',
    '',
    table(['种类', ...TWIN_LEVELS.map((lv) => lv.label)], kinds.map((k) => [ISSUE_LABEL[k], ...TWIN_LEVELS.map((lv) => fmt(m(lv.key, 'dispatcher', (r) => r.byKind[k]), 2))]), ['l', 'r', 'r']),
    '',
    '## 孪生估计得准不准',
    '',
    '孪生只看感知数据（「不用孪生」那一组里孪生照样在估计，只是建议没人执行），每辆车到店后拿当初的预测和真实的到达时间比：',
    '',
    table(['', ...TWIN_LEVELS.map((lv) => lv.label)], [
      ['提前 15–45 分钟预测到店时间，平均误差（分钟）', ...TWIN_LEVELS.map((lv) => fmt(m(lv.key, 'open', (r) => r.eta30), 1))],
      ['提前 45–90 分钟（分钟）', ...TWIN_LEVELS.map((lv) => fmt(m(lv.key, 'open', (r) => r.eta60), 1))],
      ['提前 1.5–3 小时（分钟）', ...TWIN_LEVELS.map((lv) => fmt(m(lv.key, 'open', (r) => r.eta120), 1))],
      ['冷机货温：自己的模型推到下一次读数，平均误差（°C）', ...TWIN_LEVELS.map((lv) => fmt(m(lv.key, 'open', (r) => r.temp), 2))],
      ['一天的感知数据（条）', ...TWIN_LEVELS.map((lv) => fmt(m(lv.key, 'open', (r) => r.msgs), 0))],
    ], ['l', 'r', 'r']),
    '',
    '## 读法和局限',
    '',
    '- **建议要有人看。**「只自动执行低风险的」那一组，花钱的建议卡没人批，迟到和缺货和不用孪生几乎一样；低风险的措施（检查车门、调设定温度）挡住了大部分超温。调度员 10 分钟内批准，结果就接近「全部自动执行」。',
    '- **全部自动执行是上限**，不是建议的用法：派救援车、追加补货这类要花钱的措施，实际中由调度员确认。',
    '- **剩下的超温**多发生在门店卸货的最后几分钟：密封坏了的车开着门卸货，孪生能做的（检查车门、调低设定温度、派救援车）对已经靠上收货口的车没有用，要靠门店先卸冷藏货、加人手快卸，这一步还没有做成指令。',
    '- 现场仿真的车按当天的计划开，计划不知道的状况由上面列的扰动产生；真实的现场还有更多种状况（司机生病、货损、系统故障等），没有模拟。',
    '',
  ].join('\n');
}

type AutoCase = { label: string; without: EconResult; inc: ReturnType<typeof increment>; hours: number };
const capexOf = (key: string): number => CAPEX.find((it) => it.key === key)?.base ?? 0;
const BASE_WAGE = 28;

function economicsPage(up: EconResult, sys: EconResult, sens: ReturnType<typeof sensitivity>, scenUp: { sc: (typeof SCENARIOS)[number]; r: EconResult }[], scenSys: { sc: (typeof SCENARIOS)[number]; r: EconResult }[], curve: CurvePoint[], auto: AutoCase[]): string {
  const yrs = (x: number) => (Number.isFinite(x) ? `${fmt(x, 1)} 年` : '分析期内不回本');
  const summary = (r: EconResult) =>
    table(['', '数值'], [
      ['投资', musd(r.capexTotal)],
      ['库存减少一次性释放的资金', musd(r.workingCapital)],
      ['2030 年每年毛节省', musd(r.steady.gross)],
      ['2030 年每年的维护和订阅', musd(r.steady.opex)],
      ['10 年净现值（折现率 7%）', musd(r.npv)],
      ['内部收益率', Number.isFinite(r.irr) ? pct(r.irr) : '—'],
      ['回收期（未折现）', yrs(r.payback)],
    ], ['l', 'r']);
  const parts = (r: EconResult) =>
    table(['来源（2030 年，每天）', '金额'], [
      ['配送中心人工', usd(r.steady.parts.labor)],
      ['运输（配送、面包车、进货、港口）', usd(r.steady.parts.transport)],
      ['库存持有（不含资金成本）', usd(r.steady.parts.carrying)],
      ['生鲜报废和打折', usd(r.steady.parts.waste)],
      ['缺货流失的毛利', usd(r.steady.parts.lost)],
      ['海运、空运运费', usd(r.steady.parts.freight)],
      ['门店人工和能耗', usd(r.steady.parts.store)],
      ['合计', usd(r.steady.parts.total)],
    ], ['l', 'r']);
  const flows = (r: EconResult) => table(['年份', '需求', '毛节省', '维护和订阅', '投资', '释放的库存资金', '净现金流', '累计'], r.rows.map((x) => [`${x.year}`, x.scale ? `${fmt(x.scale * 100, 0)}%` : '—', usd(x.gross), usd(x.opex), usd(x.capex), x.workingCapital ? usd(x.workingCapital) : '—', usd(x.net), usd(x.cumulative)]));
  return [
    '# 结果 5：商业分析',
    '',
    '> 口径：2026 年建设，2027–2036 年运营 10 年，2026 年不变价格，折现率 7%；不算税、补贴和融资。设备价格是公开资料里的常见区间，不是任何供应商的报价。每天的节省来自需求增长实验的仿真结果，按当年的需求插值（2027 年 100%，2030 年 124%，之后每年 +2%）。库存持有成本里的资金成本部分不进每年的节省，而是把库存减少释放的资金一次性算进现金流。',
    '',
    '## 上游这一步：StoreX → StoreX 全链路',
    '',
    '门店已经是 StoreX，只算上游的投资和节省。',
    '',
    summary(up),
    '',
    table(['投资项目', '类别', '基准', '区间', '使用年限', '每年维护'], CAPEX.map((it) => [it.label, it.group, usd(it.base), `${usd(it.low)}–${usd(it.high)}`, it.life >= 99 ? '一次性' : `${it.life} 年`, it.maint ? pct(it.maint) : '—']), ['l', 'l', 'r', 'r', 'r', 'r']),
    '',
    `每年的订阅和服务费：${usd(SUBSCRIPTIONS.base)}（${usd(SUBSCRIPTIONS.low)}–${usd(SUBSCRIPTIONS.high)}）。`,
    '',
    parts(up),
    '',
    flows(up),
    '',
    '![累计现金流：上游这一步](cashflow-upstream.svg)',
    '',
    '![敏感性](tornado-upstream.svg)',
    '',
    table(['假设', '低值', '净现值', '高值', '净现值'], sens.map((s) => [s.label, s.low.label, musd(s.low.npv), s.high.label, musd(s.high.npv)]), ['l', 'l', 'r', 'l', 'r']),
    '',
    table(['情景', '设定', '10 年净现值', '内部收益率', '回收期'], scenUp.map(({ sc, r }) => [sc.label, sc.detail, musd(r.npv), Number.isFinite(r.irr) ? pct(r.irr) : '—', yrs(r.payback)]), ['l', 'l', 'r', 'r', 'r']),
    '',
    '## 配送中心自动化单独的账',
    '',
    `其余保持不变，只比较「上自动化（八成的箱）」和「不上自动化」：不上时，全链路配送中心的人工按决策扫描里 0% 和 80% 的比例放大（每天多约 ${fmt(auto[0]?.hours ?? 0, 0)} 工时，需求增长时按同样的比例），投资里去掉自动化（${usd(capexOf('automation'))}）和切换期的损失（${usd(capexOf('cutover'))}），维护费也去掉。`,
    '',
    table(['情况', '上自动化的增量净现值', '增量内部收益率', '增量回收期', '不上自动化时上游这一步的净现值'], auto.map((c) => [c.label, musd(c.inc.npv), Number.isFinite(c.inc.irr) ? pct(c.inc.irr) : '—', yrs(c.inc.payback), musd(c.without.npv)]), ['l', 'r', 'r', 'r', 'r']),
    '',
    '## 全系统：上一代 → StoreX 全链路',
    '',
    `门店改造成 StoreX 的投资按 StoreX 报告里那家店的 ${usd(STORE_CAPEX_FLAGSHIP)}、按规模的 0.75 次方折算到综合店（规模 ${fmt(TOTAL_SIZE, 1)}），合计 ${musd(storeProgramCapex())}；门店改造每年的维护和订阅合计 ${musd(storeProgramOpex())}。加上上游这一步的投资。`,
    '',
    summary(sys),
    '',
    parts(sys),
    '',
    flows(sys),
    '',
    '![累计现金流：全系统](cashflow-system.svg)',
    '',
    table(['情景', '设定', '10 年净现值', '内部收益率', '回收期'], scenSys.map(({ sc, r }) => [sc.label, sc.detail, musd(r.npv), Number.isFinite(r.irr) ? pct(r.irr) : '—', yrs(r.payback)]), ['l', 'l', 'r', 'r', 'r']),
    '',
    '## 每天的成本随需求变化',
    '',
    table(['需求', '上一代（供应链 / 全系统）', 'StoreX', 'StoreX 全链路'], curve.map((p) => [`${fmt(p.scale * 100, 0)}%`, `${usd(p.gen.g1.total)} / ${usd(p.gen.g1.total + p.gen.g1.storeOpex)}`, `${usd(p.gen.g2.total)} / ${usd(p.gen.g2.total + p.gen.g2.storeOpex)}`, `${usd(p.gen.g3.total)} / ${usd(p.gen.g3.total + p.gen.g3.storeOpex)}`]), ['l', 'r', 'r', 'r']),
    '',
  ].join('\n');
}
