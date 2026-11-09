import { runDay } from '../ops/day';
import { capacity, headline, runSweep, seedsOf, setProgress, stress, SWEEPS } from '../analysis/studies';
import { capacityTable, compareTable, stressTable, sweepTable } from '../analysis/report';
import { GROWTH_2030, gen1, storex, storex2030 } from '../world/config';
import { writeAll } from './write';

/**
 * 命令行：
 *   day [gen1|storex|storex2030] [种子]   跑一天，打印主要指标
 *   compare [--seeds 10]                 两代对比（现在、2030 年）
 *   sweep [实验名|all] [--seeds 5]        设备和人员的扫描
 *   capacity [--seeds 5]                 订单量从 266 到 800
 *   stress [--seeds 5]                   压力演练
 *   all                                  跑全部实验，写 docs/results/
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

function day(): void {
  const which = args[1] ?? 'storex';
  const seed = Number(args[2] ?? 1);
  const s = which === 'gen1' ? gen1(seed) : which === 'gen1-2030' ? gen1(seed, GROWTH_2030) : which === 'storex2030' ? storex2030(seed) : storex(seed);
  const t0 = performance.now();
  const r = runDay(s);
  const ms = performance.now() - t0;
  const o = r.online;
  console.log(`${r.name} · 种子 ${seed} · ${r.demand.orders} 单 / ${r.demand.shoppers} 位到店顾客 · 用时 ${ms.toFixed(0)} 毫秒`);
  console.log(`线上：完成 ${o.done}，按时 ${o.onTimePct.toFixed(1)}%，等待 ${o.waitAvg.toFixed(2)} 分钟（95% ${o.waitP95.toFixed(1)}），满足率 ${o.fillPct.toFixed(2)}%，线上工时 ${o.laborMinPerOrder.toFixed(1)} 分钟 / 单`);
  console.log(`货架：缺货率 ${r.shelf.outOfShelfPct.toFixed(2)}%；生鲜损耗 ${r.fresh.wastePct.toFixed(2)}%；用电 ${r.energy.kwh.toFixed(0)} 度（购电 ${r.energy.gridKwh.toFixed(0)}）`);
  console.log(`人工：${r.labor.paidTotal.toFixed(1)} 小时（${r.labor.fte.toFixed(1)} 人）；机器人 ${r.robots.total} 台；每天合计 $${r.money.total.toFixed(0)}`);
}

switch (cmd) {
  case 'day':
    day();
    break;
  case 'compare':
    for (const h of headline(seedsOf(flag('seeds', 10)))) console.log(`\n## ${h.title}\n\n${compareTable(h)}`);
    break;
  case 'sweep': {
    const key = args[1] && !args[1].startsWith('--') ? args[1] : 'all';
    const seeds = seedsOf(flag('seeds', 5));
    for (const spec of SWEEPS.filter((s) => key === 'all' || s.key === key)) console.log(`\n## ${spec.title}\n\n${spec.question}\n\n${sweepTable(runSweep(spec, seeds))}`);
    break;
  }
  case 'capacity':
    console.log(capacityTable(capacity(seedsOf(flag('seeds', 5)))));
    break;
  case 'stress':
    console.log(stressTable(stress(seedsOf(flag('seeds', 5)))));
    break;
  case 'all':
    await writeAll({ compareSeeds: flag('seeds', 10), sweepSeeds: flag('sweep-seeds', 5) });
    break;
  default:
    console.log('用法：npm run sim -- day|compare|sweep|capacity|stress|all（详见 src/cli/main.ts）');
}
process.stderr.write('\n');
