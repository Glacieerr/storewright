#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTemplate, StoreModel, type TemplateName } from '@storewright/store-config';
import { generateCatalog, generateOrders } from '@storewright/synth';
import { BASELINE, EFFICIENCY, OPTIMIZED, ablationPolicies, defaultScenario, runExperiment, simulateDay, type SimScenario } from '@storewright/sim-engine';
import { renderComparison, renderDay, renderSensitivity, type SensitivityRow } from './report';
import { aiReport } from './aiReport';
import { industryReport } from './industryReport';

const HELP = `Storewright 仿真命令行

用法：
  npm run sim -- [--template small|medium|large|hardware] [--policy baseline|optimized] [--seed N] [--events 文件.json]
      仿真一天并打印指标；--events 导出完整事件日志（回放 / 动画用）

  npm run compare -- [--template medium] [--reps 30] [--seed 1] [--profiles] [--ablation] [--out experiments/results]
      基线与优化策略的公共随机数对比实验；--profiles 加入「效率优先」配置档位；--ablation 同时运行消融实验

  npm run sensitivity -- [--template medium] [--reps 10] [--seed 1]
      敏感性分析：逐个把假设参数调到低值 / 高值，观察「优化 − 基线」的差值如何变化

  npm run ai-report -- [--reps 20] [--seeds 4] [--quick] [--out experiments/results]
      AI 效益报告：五个模型族的离线评估、运营上的 AI 开 / 关对比、到店时间的取舍曲线、敏感性分析

  npm run industry-report -- [--reps 20] [--seeds 3] [--out experiments/results]
      行业迁移报告：中型超市与家居建材店的配置、订单形态、运营仿真、AI 开 / 关和订单量预测对比
`;

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

function template(flags: Record<string, string | boolean>): TemplateName {
  const t = String(flags.template ?? 'medium');
  if (t !== 'small' && t !== 'medium' && t !== 'large' && t !== 'hardware') throw new Error(`未知模板：${t}`);
  return t;
}

function runDay(flags: Record<string, string | boolean>): void {
  const tpl = template(flags);
  const seed = Number(flags.seed ?? 42);
  const policy = String(flags.policy ?? 'optimized') === 'baseline' ? BASELINE : OPTIMIZED;
  const model = new StoreModel(createTemplate(tpl));
  const scenario = defaultScenario(tpl);
  const catalog = generateCatalog(model, { seed: 7 });
  const orders = generateOrders(model, catalog, scenario.demand, { seed });
  const exportEvents = typeof flags.events === 'string';
  const t0 = performance.now();
  const res = simulateDay({ model, items: catalog.byId, orders, scenario, policy, seed, retainEvents: exportEvents });
  const ms = performance.now() - t0;
  console.log(`\n${model.config.name}（${tpl}）· 策略 ${policy.name} · 种子 ${seed}`);
  console.log(`${res.metrics.orders} 单 / ${res.metrics.lines} 行 / ${res.metrics.units} 件，${res.metrics.eventsExecuted} 个仿真事件，用时 ${ms.toFixed(0)} ms\n`);
  console.log(renderDay(res.metrics as unknown as Record<string, number | string>));
  if (exportEvents) {
    const file = resolve(String(flags.events));
    writeFileSync(file, JSON.stringify({ policy: policy.name, seed, template: tpl, events: res.events }, null, 0));
    console.log(`\n事件日志：${res.events.length} 条 → ${file}`);
  }
}

function compare(flags: Record<string, string | boolean>): void {
  const tpl = template(flags);
  const reps = Number(flags.reps ?? 30);
  const seed = Number(flags.seed ?? 1);
  const policies = [BASELINE, OPTIMIZED, ...(flags.profiles ? [EFFICIENCY] : []), ...(flags.ablation ? ablationPolicies() : [])];
  const outDir = resolve(String(flags.out ?? 'experiments/results'));
  const t0 = performance.now();
  let last = -1;
  const result = runExperiment({ template: tpl, reps, baseSeed: seed, policies }, (done, total) => {
    const pct = Math.floor((100 * done) / total);
    if (pct !== last && pct % 10 === 0) {
      process.stdout.write(`\r运行中 ${pct}%`);
      last = pct;
    }
  });
  process.stdout.write(`\r完成：${reps} 次重复 × ${policies.length} 个策略，用时 ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);
  const model = new StoreModel(createTemplate(tpl));
  const md = renderComparison(result, model);
  mkdirSync(outDir, { recursive: true });
  const base = `${tpl}-reps${reps}-seed${seed}${flags.profiles ? '-profiles' : ''}${flags.ablation ? '-ablation' : ''}`;
  writeFileSync(join(outDir, `${base}.md`), md);
  writeFileSync(join(outDir, `${base}.json`), JSON.stringify(result, null, 2));
  console.log(md);
  console.log(`报告：${join(outDir, `${base}.md`)}`);
}

interface Variant {
  param: string;
  label: string;
  low: number;
  base: number;
  high: number;
  apply: (scenario: SimScenario, config: ReturnType<typeof createTemplate>, value: number) => void;
}

const VARIANTS: Variant[] = [
  { param: 'searchPerOccupancySec', label: '不记录格位时的寻找时间（秒 × 占用率）', low: 30, base: 60, high: 90, apply: (s, _c, v) => (s.times.searchPerOccupancySec = v) },
  { param: 'stageRecordedSec', label: '扫描记录格位的暂存时间（秒/框）', low: 8, base: 12, high: 18, apply: (s, _c, v) => (s.times.stageRecordedSec = v) },
  { param: 'exceptionBaseSec', label: '后仓补取基础时间（秒）', low: 120, base: 180, high: 300, apply: (s, _c, v) => (s.times.exceptionBaseSec = v) },
  { param: 'phantomRecordRate', label: '库存记录不准率', low: 0.1, base: 0.25, high: 0.4, apply: (s, _c, v) => (s.behavior.phantomRecordRate = v) },
  { param: 'fillFactor', label: '框装填系数', low: 0.6, base: 0.7, high: 0.8, apply: (_s, c, v) => (c.equipment.tote.fillFactor = v) },
  { param: 'stopSec', label: '每个拣货点用时（秒）', low: 25, base: 40, high: 55, apply: (s, _c, v) => (s.times.stopSec = v) },
  { param: 'onMyWayTapRate', label: '「我在路上」点击率', low: 0.4, base: 0.7, high: 0.9, apply: (s, _c, v) => (s.behavior.onMyWayTapRate = v) },
  { param: 'locationShareRate', label: '位置共享率', low: 0.3, base: 0.6, high: 0.9, apply: (s, _c, v) => (s.behavior.locationShareRate = v) },
];

function sensitivity(flags: Record<string, string | boolean>): void {
  const tpl = template(flags);
  const reps = Number(flags.reps ?? 10);
  const seed = Number(flags.seed ?? 1);
  const outDir = resolve(String(flags.out ?? 'experiments/results'));
  const rows: SensitivityRow[] = [];
  const t0 = performance.now();
  const runOne = (variant?: Variant, value?: number) => {
    const scenario = defaultScenario(tpl);
    const config = createTemplate(tpl);
    if (variant && value !== undefined) variant.apply(scenario, config, value);
    const r = runExperiment({ template: tpl, reps, baseSeed: seed, policies: [BASELINE, OPTIMIZED], scenario, config });
    return (r.paired[0] as (typeof r.paired)[number]).delta;
  };
  const base = runOne();
  rows.push({ label: '基准假设', value: '—', delta: base });
  for (const v of VARIANTS) {
    for (const [tag, value] of [['低', v.low], ['高', v.high]] as const) {
      process.stdout.write(`\r${v.param} ${tag}…            `);
      rows.push({ label: `${v.label}：${tag}`, value: `${value}（基准 ${v.base}）`, delta: runOne(v, value) });
    }
  }
  process.stdout.write(`\r完成，用时 ${((performance.now() - t0) / 1000).toFixed(1)} s            \n`);
  const md = renderSensitivity(tpl, reps, seed, rows);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${tpl}-sensitivity-reps${reps}-seed${seed}.md`);
  writeFileSync(file, md);
  console.log(md);
  console.log(`报告：${file}`);
}

function runAiReport(flags: Record<string, string | boolean>): void {
  const reps = Number(flags.reps ?? 20);
  const seeds = Number(flags.seeds ?? 4);
  const quick = !!flags.quick;
  const outDir = resolve(String(flags.out ?? 'experiments/results'));
  const t0 = performance.now();
  const md = aiReport({ reps, seeds, quick, onProgress: (m) => process.stdout.write(`\r${m}                    `) });
  process.stdout.write(`\r完成，用时 ${((performance.now() - t0) / 1000).toFixed(1)} s                    \n`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `ai-report-reps${reps}-seeds${seeds}${quick ? '-quick' : ''}.md`);
  writeFileSync(file, md);
  console.log(md);
  console.log(`报告：${file}`);
}

function runIndustryReport(flags: Record<string, string | boolean>): void {
  const reps = Number(flags.reps ?? 20);
  const seeds = Number(flags.seeds ?? 3);
  const outDir = resolve(String(flags.out ?? 'experiments/results'));
  const t0 = performance.now();
  const md = industryReport({ reps, seeds, onProgress: (m) => process.stdout.write(`\r${m}                    `) });
  process.stdout.write(`\r完成，用时 ${((performance.now() - t0) / 1000).toFixed(1)} s                    \n`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `industry-report-reps${reps}-seeds${seeds}.md`);
  writeFileSync(file, md);
  console.log(md);
  console.log(`报告：${file}`);
}

const { command, flags } = parseArgs(process.argv.slice(2));
try {
  if (command === 'run') runDay(flags);
  else if (command === 'compare') compare(flags);
  else if (command === 'sensitivity') sensitivity(flags);
  else if (command === 'ai-report') runAiReport(flags);
  else if (command === 'industry-report') runIndustryReport(flags);
  else console.log(HELP);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
