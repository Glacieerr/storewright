import { pair, runSweep, seedsOf, setProgress, SWEEPS, threeGens, type Arm } from '../analysis/studies';
import { fmt, meanCi, table } from '../analysis/format';
import { KPIS } from '../analysis/kpi';
import { runChain } from '../sim/engine';
import { scenarioFor, type Gen } from '../sim/config';
import { writeAll } from './write';
import { readFileSync } from 'node:fs';
import { parseScenario } from '../scenario';
import { chainScenarioOf } from '../scenario/sim';
import { buildBoard } from '../sim/board';
import { allocationHour, emptyDay } from '../sim/plan';

/**
 * 命令行：
 *   run [g1|g2|g3] [种子]        跑一次（18 周），打印主要指标
 *   compare [--seeds 10]         三代对比
 *   sweep [实验名|all]           全链路方案的决策扫描
 *   all                          跑全部实验，写 docs/results/
 *   scenario <场景文件.json> [--json]   按场景文件（docs/07-scenarios.md）跑一次，打印主要指标和调度台当天的 KPI
 */
const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (name: string, def: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
let dots = 0;
setProgress(() => {
  if (++dots % 10 === 0) process.stderr.write('.');
});

switch (cmd) {
  case 'run': {
    const gen = (args[1] ?? 'g3') as Gen;
    const seed = Number(args[2] ?? 1);
    const t0 = performance.now();
    const r = runChain(scenarioFor(gen, seed));
    console.log(`${r.name} · 种子 ${seed} · ${fmt(performance.now() - t0, 0)} 毫秒`);
    console.log(`门店：服务水平 ${fmt(r.store.service, 2)}%，库存 ${fmt(r.store.invDays, 2)} 天，生鲜损耗 ${fmt(r.store.wastePct, 2)}%，到店剩余保质期 ${fmt(r.store.freshRemainPct, 1)}%`);
    console.log(`配送中心：库存 ${fmt(r.dc.invDays, 2)} 天，满足率 ${fmt(r.dc.fillPct, 2)}%，工时 ${fmt(r.dc.laborHours, 0)} 小时 / 天`);
    console.log(`运输：配送 ${fmt(r.outbound.trips, 1)} 车 / 天、${fmt(r.outbound.km, 0)} 公里，装载率 ${fmt(r.outbound.fillPct, 1)}%，车队 ${r.outbound.fleet} 辆；港口停留 ${fmt(r.inbound.portDwellDays, 2)} 天`);
    console.log(`成本：${fmt(r.cost.total, 0)} 美元 / 天（每箱 ${fmt(r.cost.perCase, 2)}）；排放 ${fmt(r.co2.total / 1000, 1)} 吨 / 天`);
    break;
  }
  case 'compare': {
    const arms = threeGens(seedsOf(flag('seeds', 10)));
    const [a, , c] = arms as [Arm, Arm, Arm];
    const rows = pair(a, c);
    console.log(table(['指标', ...arms.map((x) => x.label), '全链路 vs 上一代'], KPIS.map((k, i) => [`${k.label}（${k.unit}）`, ...arms.map((x) => meanCi(k, x.runs)), `${fmt((rows[i] as (typeof rows)[number]).pct, 0)}% ${(rows[i] as (typeof rows)[number]).verdict}`])));
    break;
  }
  case 'sweep': {
    const key = args[1] && !args[1].startsWith('--') ? args[1] : 'all';
    const seeds = seedsOf(flag('seeds', 5));
    for (const spec of SWEEPS.filter((s) => key === 'all' || s.key === key)) {
      const r = runSweep(spec, seeds);
      console.log(`\n## ${spec.title}\n\n${spec.question}\n`);
      const ks = spec.kpis.map((k) => KPIS.find((x) => x.key === k)!);
      console.log(table([spec.title, ...ks.map((k) => `${k.label}（${k.unit}）`)], r.points.map((p) => [spec.label(p.value), ...ks.map((k) => meanCi(k, p.runs))])));
    }
    break;
  }
  case 'all':
    await writeAll({ seeds: flag('seeds', 20), sweepSeeds: flag('sweep-seeds', 10), twinSeeds: flag('twin-seeds', 20) });
    break;
  case 'scenario': {
    const file = args[1];
    if (!file) {
      console.log('用法：npm run sim -- scenario <场景文件.json> [--json]');
      process.exitCode = 2;
      break;
    }
    const pr = parseScenario(JSON.parse(readFileSync(file, 'utf8')));
    for (const w of pr.warnings) process.stderr.write(`提醒：${w}\n`);
    if (!pr.scenario) {
      for (const e of pr.errors) process.stderr.write(`错误：${e}\n`);
      process.exitCode = 1;
      break;
    }
    const sc = chainScenarioOf(pr.scenario);
    const t0 = performance.now();
    const r = runChain(sc);
    const day = buildBoard(r.trace?.ops ?? [], emptyDay(), { allocation: allocationHour(sc), crossDock: sc.dc.crossDock }).kpi;
    const out = {
      scenario: pr.scenario,
      ms: Math.round(performance.now() - t0),
      store: { servicePct: r.store.service, inventoryDays: r.store.invDays, wastePct: r.store.wastePct, freshRemainPct: r.store.freshRemainPct },
      dc: { inventoryDays: r.dc.invDays, fillPct: r.dc.fillPct, laborHoursPerDay: r.dc.laborHours },
      transport: { tripsPerDay: r.outbound.trips, kmPerDay: r.outbound.km, loadPct: r.outbound.fillPct, fleet: r.outbound.fleet, portDwellDays: r.inbound.portDwellDays },
      cost: { perDay: r.cost.total, perCase: r.cost.perCase },
      co2TonnesPerDay: r.co2.total / 1000,
      traceDay: day,
    };
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`${pr.scenario.title ?? file} · ${r.name} · ${fmt(out.ms, 0)} 毫秒`);
      console.log(`门店：服务水平 ${fmt(r.store.service, 2)}%，库存 ${fmt(r.store.invDays, 2)} 天，生鲜损耗 ${fmt(r.store.wastePct, 2)}%`);
      console.log(`配送中心：库存 ${fmt(r.dc.invDays, 2)} 天，满足率 ${fmt(r.dc.fillPct, 2)}%；运输：${fmt(r.outbound.trips, 1)} 车 / 天，装载率 ${fmt(r.outbound.fillPct, 1)}%；港口停留 ${fmt(r.inbound.portDwellDays, 2)} 天`);
      console.log(`成本：${fmt(r.cost.total, 0)} 美元 / 天；排放 ${fmt(r.co2.total / 1000, 1)} 吨 / 天`);
      console.log(`动画那一天的调度台 KPI：${JSON.stringify(day)}`);
    }
    break;
  }
  default:
    console.log('用法：npm run sim -- run|compare|sweep|all|scenario（详见 src/cli/main.ts）');
}
process.stderr.write('\n');
