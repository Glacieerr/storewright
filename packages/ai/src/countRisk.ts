import { dot, fitGlm, sigmoid } from './glm';
import { rankReasons, type Reason } from './recommendation';

/**
 * 按风险盘点（Phase 5b）。
 *
 * 后仓记录会因为漏扫、放错库位、收货差错、损坏没登记而变得不准。固定的 ABC 周期（A 每周、B 每月、C 每季度）
 * 不管哪条记录更可能出错；这里用逻辑回归估计每条记录「现在不准」的概率，在同样的盘点数量下优先盘最可能出错的。
 *
 * 特征（系统里都有）：距上次盘点的天数、之后的箱子进出次数、收货差异、后仓补取没找到（可疑）、损坏箱数、周转。
 * 训练标签来自过去的盘点结果（盘点时才知道记录准不准），正好是门店上线后自然积累的数据。
 */

export interface CountRiskInput {
  daysSinceCount: number;
  movesSinceCount: number;
  discrepancy: boolean;
  suspect: boolean;
  damaged: number;
  velocity: number;
}

export interface CountRiskParams {
  beta: number[];
  means: number[];
}

const CODES = ['INTERCEPT', 'DAYS_SINCE_COUNT', 'MOVES_SINCE_COUNT', 'RECEIPT_DISCREPANCY', 'SUSPECT', 'DAMAGED', 'VELOCITY'] as const;

export function countRiskFeatures(o: CountRiskInput): number[] {
  return [1, Math.log1p(o.daysSinceCount), Math.log1p(o.movesSinceCount), o.discrepancy ? 1 : 0, o.suspect ? 1 : 0, Math.log1p(o.damaged), Math.log1p(o.velocity)];
}

export function fitCountRisk(rows: ReadonlyArray<CountRiskInput & { inaccurate: boolean }>, lambda = 1): CountRiskParams {
  const X = rows.map(countRiskFeatures);
  const fit = fitGlm(
    X,
    rows.map((r) => (r.inaccurate ? 1 : 0)),
    { family: 'logistic', lambda, penalize: [false, true, true, true, true, true, true] },
  );
  const means = X[0] ? X[0].map((_, j) => X.reduce((a, x) => a + (x[j] as number), 0) / X.length) : [];
  return { beta: fit.beta.map((b) => Math.round(b * 10000) / 10000), means: means.map((m) => Math.round(m * 1000) / 1000) };
}

export function predictCountRisk(params: CountRiskParams, o: CountRiskInput): { p: number; reasons: Reason[] } {
  const x = countRiskFeatures(o);
  const p = sigmoid(dot(x, params.beta));
  const reasons: Reason[] = [];
  const values = [0, o.daysSinceCount, o.movesSinceCount, o.discrepancy ? 1 : 0, o.suspect ? 1 : 0, o.damaged, o.velocity];
  for (let j = 1; j < x.length; j++) {
    const logOr = (params.beta[j] as number) * ((x[j] as number) - (params.means[j] ?? 0));
    if (logOr < 0.05) continue; // 只解释让风险变高的因素
    reasons.push({ factor: CODES[j] as string, value: values[j] as number, effect: { kind: 'MULTIPLY', amount: Math.round(Math.exp(logOr) * 1000) / 1000 }, weight: 0 });
  }
  return { p: Math.round(p * 10000) / 10000, reasons: rankReasons(reasons, 3) };
}

// ---------------------------------------------------------------------------
// 盘点策略的仿真比较（公共随机数：两种策略面对完全相同的出错事件）

export type AbcClass = 'A' | 'B' | 'C';

export interface CountSimItem {
  id: string;
  velocity: number;
  abc: AbcClass;
  /** 隐藏：更容易出错（例如小件、包装容易破） */
  prone: boolean;
}

export interface CountSimRecord extends CountRiskInput {
  inaccurate: boolean;
  inaccurateSince?: number;
}

export interface CountSimResult {
  /** 平均每天有多少条记录不准 */
  avgInaccurate: number;
  counts: number;
  /** 盘点发现的错误数 / 盘点次数 */
  hitRate: number;
  found: number;
  /** 错误从发生到被盘点发现的平均天数 */
  meanDetectDays: number;
  /** 盘点时记录下的样本（特征 + 结果），用于训练 */
  samples: Array<CountRiskInput & { inaccurate: boolean; day: number }>;
}

export type CountPolicy = (day: number, items: readonly CountSimItem[], state: ReadonlyMap<string, CountSimRecord>, budget: number) => string[];

export const ABC_INTERVAL: Record<AbcClass, number> = { A: 7, B: 30, C: 90 };

/** 现状：可疑的先盘（事件触发），其余按 ABC 周期最逾期的先盘 */
export const abcPolicy: CountPolicy = (_day, items, state, budget) => {
  const due = items
    .map((it) => {
      const r = state.get(it.id) as CountSimRecord;
      return { id: it.id, suspect: r.suspect, overdue: r.daysSinceCount / ABC_INTERVAL[it.abc] };
    })
    .filter((x) => x.suspect || x.overdue >= 1)
    .sort((a, b) => Number(b.suspect) - Number(a.suspect) || b.overdue - a.overdue || a.id.localeCompare(b.id));
  return due.slice(0, budget).map((x) => x.id);
};

export function riskPolicy(params: CountRiskParams): CountPolicy {
  return (_day, items, state, budget) =>
    items
      .map((it) => ({ id: it.id, p: predictCountRisk(params, state.get(it.id) as CountSimRecord).p }))
      .sort((a, b) => b.p - a.p || a.id.localeCompare(b.id))
      .slice(0, budget)
      .map((x) => x.id);
}

/** 由均匀随机数得到泊松抽样（逆变换，λ 不大时足够） */
function poissonFrom(u: number, lambda: number): number {
  let k = 0;
  let p = Math.exp(-lambda);
  let cdf = p;
  while (u > cdf && k < 100) {
    k++;
    p *= lambda / k;
    cdf += p;
  }
  return k;
}

export function makeCountItems(n: number, uniform: (stream: string, key: string) => number): CountSimItem[] {
  const raw = Array.from({ length: n }, (_, i) => {
    const id = `R${String(i + 1).padStart(4, '0')}`;
    const v = Math.exp(Math.log(1.2) + 1.0 * normalFrom(uniform('vel', id), uniform('vel2', id)));
    return { id, velocity: Math.round(Math.min(15, v) * 100) / 100, prone: uniform('prone', id) < 0.25 };
  });
  const ranked = [...raw].sort((a, b) => b.velocity - a.velocity);
  const cls = new Map(ranked.map((r, i) => [r.id, (i < n * 0.2 ? 'A' : i < n * 0.5 ? 'B' : 'C') as AbcClass]));
  return raw.map((r) => ({ ...r, abc: cls.get(r.id) as AbcClass }));
}

function normalFrom(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2);
}

/**
 * 模拟 days 天的后仓记录：每天先发生进出与差错，再按策略盘点 budget 条记录。
 * policyFor(day) 返回当天使用的策略（可以前半段用现状、后半段用模型）；只统计 day ≥ measureFrom 的结果。
 */
export function simulateCounting(opts: {
  items: readonly CountSimItem[];
  days: number;
  budget: number;
  uniform: (stream: string, key: string) => number;
  policyFor: (day: number) => CountPolicy;
  measureFrom?: number;
}): CountSimResult {
  const state = new Map<string, CountSimRecord>(
    opts.items.map((it) => [it.id, { daysSinceCount: Math.floor(opts.uniform('start', it.id) * ABC_INTERVAL[it.abc]), movesSinceCount: 0, discrepancy: false, suspect: false, damaged: 0, velocity: it.velocity, inaccurate: false }]),
  );
  const from = opts.measureFrom ?? 0;
  let inaccurateDays = 0;
  let counts = 0;
  let found = 0;
  let detectDays = 0;
  const samples: CountSimResult['samples'] = [];
  for (let d = 0; d < opts.days; d++) {
    for (const it of opts.items) {
      const r = state.get(it.id) as CountSimRecord;
      const u = (s: string) => opts.uniform(s, `${it.id}:${d}`);
      const moves = poissonFrom(u('moves'), it.velocity);
      r.movesSinceCount += moves;
      r.daysSinceCount += 1;
      const markWrong = () => {
        if (!r.inaccurate) {
          r.inaccurate = true;
          r.inaccurateSince = d;
        }
      };
      const perMove = 0.006 * (it.prone ? 2 : 1);
      if (u('moveErr') < 1 - (1 - perMove) ** moves) markWrong();
      if (u('silent') < 0.0015) markWrong();
      if (u('disc') < 0.01) {
        r.discrepancy = true;
        if (u('discErr') < 0.5) markWrong();
      }
      if (u('dmg') < 0.003 * (it.prone ? 3 : 1)) {
        r.damaged += 1;
        if (u('dmgErr') < 0.4) markWrong();
      }
      // 记录不准时，后仓补取可能找不到，记录被标为可疑
      if (r.inaccurate && u('exc') < Math.min(0.5, 0.05 + 0.05 * it.velocity)) r.suspect = true;
    }
    const picks = opts.policyFor(d)(d, opts.items, state, opts.budget);
    for (const id of picks) {
      const r = state.get(id) as CountSimRecord;
      if (d >= from) {
        counts++;
        if (r.inaccurate) {
          found++;
          detectDays += d - (r.inaccurateSince ?? d);
        }
      }
      samples.push({ daysSinceCount: r.daysSinceCount, movesSinceCount: r.movesSinceCount, discrepancy: r.discrepancy, suspect: r.suspect, damaged: r.damaged, velocity: r.velocity, inaccurate: r.inaccurate, day: d });
      r.daysSinceCount = 0;
      r.movesSinceCount = 0;
      r.discrepancy = false;
      r.suspect = false;
      r.inaccurate = false;
      delete r.inaccurateSince;
    }
    if (d >= from) for (const r of state.values()) if (r.inaccurate) inaccurateDays++;
  }
  const measured = Math.max(1, opts.days - from);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { avgInaccurate: r3(inaccurateDays / measured), counts, hitRate: r3(counts ? found / counts : 0), found, meanDetectDays: r3(found ? detectDays / found : 0), samples };
}
