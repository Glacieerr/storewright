import { checkSolution, randomInstance, solveExact, solveNearest, solveSavings, toSol, toVrp, type CvrpInstance, type CvrpSolution } from './cvrp';
import { exactRows, type ExactRow } from './exact';
import { fillRateCases, LOSS_TABLE, lossFromFill, type FillCase } from './inventory';
import { mulberry32 } from './rng';

/**
 * 对照验证（npm run validate）：仿真里用到的算法和公式，跟理论值、精确最优解、穷举、经典算法比，结果写成
 * bench/validation/results.json、CVRPLIB 格式的例子和最优解（bench/validation/cvrp/），以及 docs/08-validation*.md 里自动生成的那几节。
 * 除了用时，所有数字都是确定的（固定种子）。
 *
 * Validation suite: algorithms and formulas used in the simulator vs theory, exact optima, exhaustive search and classic baselines.
 */
export interface CvrpRow {
  variant: 'cvrp' | 'maxstops';
  n: number;
  instances: number;
  capacity: number;
  maxStops: number | null;
  /** 节约法正好是最优的比例、平均 / 95 分位 / 最大差距（%） */
  savingsOptimal: number;
  savingsMeanGap: number;
  savingsP95Gap: number;
  savingsMaxGap: number;
  nearestMeanGap: number;
  nearestMaxGap: number;
  /** 节约法比最近邻省的里程（平均 %） */
  savingsVsNearest: number;
  exactMs: number;
  savingsMs: number;
}

export interface ValidationReport {
  version: 1;
  quick: boolean;
  cvrp: CvrpRow[];
  fill: { cases: FillCase[]; samples: number; maxAbsDiff: number; maxSe: number; loss: { z: number; table: number; ours: number }[] };
  exact: ExactRow[];
  /** 写成 CVRPLIB 文件的例子（标准 CVRP，最优解由精确解法给出） */
  library: { name: string; n: number; capacity: number; optimal: number; savings: number; nearest: number; vrp: string; sol: string }[];
}

const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))] as number) : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function cvrpRows(quick: boolean, library: ValidationReport['library']): CvrpRow[] {
  const rows: CvrpRow[] = [];
  for (const variant of ['cvrp', 'maxstops'] as const)
    for (const n of [6, 8, 10, 12]) {
      const count = quick ? 8 : n === 12 ? 60 : 120;
      const rng = mulberry32(1000 * n + (variant === 'cvrp' ? 1 : 2));
      const capacity = 20;
      const maxStops = variant === 'cvrp' ? Infinity : 4;
      const gS: number[] = [];
      const gN: number[] = [];
      const vsN: number[] = [];
      let optimal = 0;
      let exactMs = 0;
      let savingsMs = 0;
      for (let k = 0; k < count; k++) {
        const inst = randomInstance(rng, n, capacity, maxStops, 8, `sx-${variant}-n${n}-${String(k + 1).padStart(3, '0')}`);
        let t = performance.now();
        const ex = solveExact(inst);
        exactMs += performance.now() - t;
        t = performance.now();
        const sv = solveSavings(inst);
        savingsMs += performance.now() - t;
        const nn = solveNearest(inst);
        for (const [what, sol] of [['exact', ex], ['savings', sv], ['nearest', nn]] as [string, CvrpSolution][]) {
          const errs = checkSolution(inst, sol);
          if (errs.length) throw new Error(`${inst.name} ${what}: ${errs.join('; ')}`);
        }
        if (sv.cost < ex.cost || nn.cost < ex.cost) throw new Error(`${inst.name}: heuristic beat the exact optimum`);
        gS.push(pct(sv.cost, ex.cost));
        gN.push(pct(nn.cost, ex.cost));
        vsN.push(-pct(sv.cost, nn.cost));
        if (sv.cost === ex.cost) optimal++;
        if (variant === 'cvrp' && k < 3) library.push(libEntry(inst, ex, sv, nn));
      }
      rows.push({
        variant,
        n,
        instances: count,
        capacity,
        maxStops: Number.isFinite(maxStops) ? maxStops : null,
        savingsOptimal: (optimal / count) * 100,
        savingsMeanGap: mean(gS),
        savingsP95Gap: quantile(gS, 0.95),
        savingsMaxGap: Math.max(...gS),
        nearestMeanGap: mean(gN),
        nearestMaxGap: Math.max(...gN),
        savingsVsNearest: mean(vsN),
        exactMs,
        savingsMs,
      });
    }
  return rows;
}

function libEntry(inst: CvrpInstance, ex: CvrpSolution, sv: CvrpSolution, nn: CvrpSolution): ValidationReport['library'][number] {
  return {
    name: inst.name,
    n: inst.xy.length - 1,
    capacity: inst.capacity,
    optimal: ex.cost,
    savings: sv.cost,
    nearest: nn.cost,
    vrp: toVrp(inst, `StoreX Chain validation instance; optimal ${ex.cost} (Held-Karp + set partitioning DP); Clarke-Wright savings ${sv.cost}`),
    sol: toSol(ex),
  };
}

export function runValidation(opts: { quick?: boolean } = {}): ValidationReport {
  const quick = !!opts.quick;
  const library: ValidationReport['library'] = [];
  const cvrp = cvrpRows(quick, library);
  const samples = quick ? 20000 : 400000;
  const cases = fillRateCases(samples);
  const exact = exactRows(quick ? 0.1 : 1);
  return {
    version: 1,
    quick,
    cvrp,
    fill: {
      cases,
      samples,
      maxAbsDiff: Math.max(...cases.map((c) => Math.abs(c.formula - c.simulated))),
      maxSe: Math.max(...cases.map((c) => Math.abs(c.formula - c.simulated) / Math.max(1e-12, c.se))),
      loss: LOSS_TABLE.map(([z, table]) => ({ z, table, ours: lossFromFill(z) })),
    },
    exact,
    library,
  };
}

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const ms = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));

/** docs/08-validation*.md 里自动生成的那几节（中文 / 英文） */
export function validationMarkdown(r: ValidationReport, lang: 'zh' | 'en'): string {
  const zh = lang === 'zh';
  const L: string[] = [];
  L.push(zh ? '### 1. 配送线路：节约法 vs 精确最优 vs 最近邻' : '### 1. Delivery routing: savings vs exact optimum vs nearest neighbour', '');
  L.push(
    zh
      ? '每个规模随机生成一批例子（坐标 0–100、需求 1–8 托、车容量 20 托；「限停靠点」一栏是仿真里真实的约束：一车最多 4 家），距离按 TSPLIB 的 EUC_2D 取整。差距 = (启发式 − 最优) / 最优。'
      : 'Random instances per size (coordinates 0–100, demand 1–8 pallets, capacity 20; the "max stops" variant adds the simulator’s real constraint of at most 4 stops per truck). Distances are TSPLIB EUC_2D (rounded). Gap = (heuristic − optimum) / optimum.',
    '',
  );
  L.push(
    zh
      ? '| 变体 | 客户数 | 例子数 | 节约法正好最优 | 节约法平均差距 | 95 分位 | 最大 | 最近邻平均差距 | 最大 | 节约法比最近邻省 |'
      : '| Variant | Customers | Instances | Savings optimal | Savings mean gap | p95 | Max | Nearest-neighbour mean gap | Max | Savings vs NN |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const c of r.cvrp)
    L.push(`| ${c.variant === 'cvrp' ? (zh ? '标准 CVRP' : 'Plain CVRP') : zh ? '限停靠点 4' : 'Max 4 stops'} | ${c.n} | ${c.instances} | ${f1(c.savingsOptimal)}% | ${f2(c.savingsMeanGap)}% | ${f2(c.savingsP95Gap)}% | ${f2(c.savingsMaxGap)}% | ${f2(c.nearestMeanGap)}% | ${f2(c.nearestMaxGap)}% | ${f2(c.savingsVsNearest)}% |`);
  const big = r.cvrp.filter((c) => c.n === 12);
  L.push(
    '',
    zh
      ? `精确解法每个 12 客户的例子平均 ${ms(mean(big.map((c) => c.exactMs / c.instances)))} 毫秒，节约法 ${ms(mean(big.map((c) => c.savingsMs / c.instances)))} 毫秒（本机参考值，每次运行略有不同）。所有解都检查过：每家店恰好送一次、不超载、不超停靠点数、里程重算一致；启发式从来没有比精确解更好（否则精确解法有错，脚本会直接报错）。`
      : `The exact method takes ${ms(mean(big.map((c) => c.exactMs / c.instances)))} ms per 12-customer instance on average, savings ${ms(mean(big.map((c) => c.savingsMs / c.instances)))} ms (reference timings on the author’s machine; they vary between runs). Every solution is checked: each customer served exactly once, no overload, stop limit respected, cost recomputed; no heuristic ever beat the exact optimum (the script fails if one does).`,
    '',
  );
  L.push(zh ? '### 2. 满足率公式 vs 蒙特卡洛模拟' : '### 2. Fill-rate formula vs Monte Carlo', '');
  L.push(
    zh
      ? `需求服从正态分布（均值 100，变异系数 0.2 和 0.5），备货 = 均值 + z × 标准差。每种情况抽 ${r.fill.samples.toLocaleString('en-US')} 个需求。公式和模拟最大相差 ${r.fill.maxAbsDiff.toFixed(4)}（最多 ${f1(r.fill.maxSe)} 倍标准误，在随机误差以内）。`
      : `Normally distributed demand (mean 100, coefficient of variation 0.2 and 0.5), stock = mean + z × sd, ${r.fill.samples.toLocaleString('en-US')} samples per case. Largest difference between formula and simulation: ${r.fill.maxAbsDiff.toFixed(4)} (at most ${f1(r.fill.maxSe)} standard errors, i.e. within sampling noise).`,
    '',
    zh ? '| z | 变异系数 | 公式 | 模拟 | 差 |' : '| z | CV | Formula | Simulated | Difference |',
    '|---|---|---|---|---|',
  );
  const d4 = (x: number) => (Math.abs(x) < 5e-5 ? '0.0000' : x.toFixed(4));
  for (const c of r.fill.cases) L.push(`| ${c.z} | ${c.cv} | ${c.formula.toFixed(4)} | ${c.simulated.toFixed(4)} | ${d4(c.formula - c.simulated)} |`);
  L.push('', zh ? '标准正态损失函数 L(z)：教科书的值（4 位）和由公式反推的值：' : 'Standard normal loss function L(z): textbook values (4 decimals) and the value implied by the formula:', '', '| z | ' + (zh ? '教科书' : 'Textbook') + ' | ' + (zh ? '本项目' : 'This project') + ' |', '|---|---|---|');
  for (const x of r.fill.loss) L.push(`| ${x.z} | ${x.table.toFixed(4)} | ${x.ours.toFixed(4)} |`);
  L.push('', zh ? '### 3. 声称「精确最优」的求解器 vs 穷举' : '### 3. Solvers that claim optimality vs exhaustive search', '');
  L.push(
    zh ? '| 求解器 | 例子数 | 和穷举一致 | 不一致、求解器自己标了「不保证最优」 | 不一致、却声称最优 | 求解器用时 | 穷举用时 |' : '| Solver | Instances | Same as exhaustive | Different, flagged “not proven optimal” by the solver | Different while claiming optimality | Solver time | Exhaustive time |',
    '|---|---|---|---|---|---|---|',
  );
  for (const e of r.exact) L.push(`| ${zh ? e.label : e.labelEn} | ${e.instances} | ${e.matched} | ${e.flagged} | ${e.wrong} | ${ms(e.solverMs)} ms | ${ms(e.bruteMs)} ms |`);
  L.push(
    '',
    zh
      ? '用时是这一批例子的合计（本机参考值）。例子很小是因为穷举的组合数随规模指数增长；真实的一天由同样的求解器求，求不到最优时会给出离最优最多还差多少（见调度台的求解面板）。'
      : 'Times are totals for the batch (reference values). Instances are small because exhaustive search grows exponentially; the real day is solved by the same code, which reports a bound on the remaining gap when it cannot prove optimality (see the solver panel on the dispatch board).',
    '',
  );
  L.push(zh ? '### 4. 公开的例子文件（CVRPLIB 格式）' : '### 4. Published instances (CVRPLIB format)', '');
  L.push(
    zh
      ? '下面这些例子和最优解在 `bench/validation/cvrp/`（.vrp 例子、.sol 最优解），任何读 CVRPLIB 格式的求解器都能拿来核对：'
      : 'These instances and their optimal solutions are in `bench/validation/cvrp/` (.vrp instance, .sol optimum); any solver that reads CVRPLIB files can check them:',
    '',
    zh ? '| 例子 | 客户数 | 容量 | 最优 | 节约法 | 最近邻 |' : '| Instance | Customers | Capacity | Optimum | Savings | Nearest neighbour |',
    '|---|---|---|---|---|---|',
  );
  for (const x of r.library) L.push(`| ${x.name} | ${x.n} | ${x.capacity} | ${x.optimal} | ${x.savings} | ${x.nearest} |`);
  return `${L.join('\n')}\n`;
}

/** 命令行里打印的一行摘要 */
export function validationSummary(r: ValidationReport): string {
  const c12 = r.cvrp.filter((c) => c.n === 12);
  return [
    `routing: savings mean gap ${c12.map((c) => `${c.variant} ${f2(c.savingsMeanGap)}%`).join(', ')} (n = 12); nearest neighbour ${c12.map((c) => `${f2(c.nearestMeanGap)}%`).join(', ')}`,
    `fill rate: max |formula − Monte Carlo| ${r.fill.maxAbsDiff.toFixed(4)} (${f1(r.fill.maxSe)} se)`,
    `exact solvers: ${r.exact.map((e) => `${e.key} ${e.matched}/${e.instances}${e.flagged ? ` (+${e.flagged} flagged)` : ''}${e.wrong ? ` (${e.wrong} WRONG)` : ''}`).join(', ')}`,
  ].join('\n');
}
