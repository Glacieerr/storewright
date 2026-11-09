import { FAMILIES } from '../region/products';
import { buildBoard } from '../sim/board';
import { scenarioFor, type ChainScenario, type Gen } from '../sim/config';
import { runChain, type ChainHistory } from '../sim/engine';
import { allocationHour, emptyDay } from '../sim/plan';
import { runLoop, type LoopResult } from '../twin/loop';

/**
 * 预测模型：用仿真产生的历史数据训练，和系统现在用的规则并排比，哪个准用哪个。
 *
 * - 门店每天每个商品族的销量：规则 = 同星期几过去 4 周的平均；学到的模型 = 岭回归（对数销量 ~ 星期几 + 促销日历 + 近 4 周的水平）、
 *   霍尔特—温特斯指数平滑（周季节，不知道促销）。第 5–12 周训练、第 13–14 周验证（选模型）、选好后用第 5–14 周重训，第 15–18 周检验。
 * - 本店班轮、洲际班列的晚到：规则 = 规划参数里的平均晚到；学到的模型 = 历史中位数（分位数模型，另给 90% 分位数留余量）、最近三班的平均。
 *   12 个独立的 18 周运行，前 12 周训练（前 8 周拟合、第 9–12 周验证），后 6 周检验。
 * - 路上用时：规则 = 计划用时（路网的时段拥堵表）；学到的模型 = 岭回归（每小时一个系数，按这一程在各小时的占比加权）、
 *   孪生在线学到的「比计划慢多少」（按小时；孪生每天从零学起，取每天结束时的值，训练那几天平均）。全链路方案连续 30 天的现场
 *   （闭环孪生的现场，不执行建议），前 20 天训练（前 15 天拟合、后 5 天验证），后 10 天检验。
 *
 * 选模型只看验证期，检验期的误差是选好以后才算的（不偷看检验期）。误差：平均绝对误差、加权平均百分比误差（误差绝对值之和 ÷ 实际之和）、
 * 偏差（误差之和 ÷ 实际之和，正 = 估多了）。
 */
export interface Metric {
  mae: number;
  wape: number;
  bias: number;
  n: number;
}
export interface ModelScore {
  key: string;
  label: string;
  rule: boolean;
  valid: Metric;
  test: Metric;
}
export type ForecastTarget = 'demand' | 'vessel' | 'train' | 'road';

export function metric(pred: readonly number[], act: readonly number[]): Metric {
  let ae = 0;
  let e = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pred.length; i++) {
    const p = pred[i] as number;
    const a = act[i] as number;
    if (!Number.isFinite(p) || !Number.isFinite(a)) continue;
    ae += Math.abs(p - a);
    e += p - a;
    sum += Math.abs(a);
    n++;
  }
  return { mae: n ? ae / n : NaN, wape: sum > 0 ? (ae / sum) * 100 : NaN, bias: sum > 0 ? (e / sum) * 100 : NaN, n };
}

/** 解线性方程组（部分主元的高斯消去） */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((M[r] as number[])[c] as number) > Math.abs((M[p] as number[])[c] as number)) p = r;
    [M[c], M[p]] = [M[p] as number[], M[c] as number[]];
    const piv = (M[c] as number[])[c] as number;
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = ((M[r] as number[])[c] as number) / piv;
      if (!f) continue;
      for (let k = c; k <= n; k++) (M[r] as number[])[k] = ((M[r] as number[])[k] as number) - f * ((M[c] as number[])[k] as number);
    }
  }
  return M.map((row, i) => {
    const piv = row[i] as number;
    return Math.abs(piv) < 1e-12 ? 0 : (row[n] as number) / piv;
  });
}

/** 岭回归：min ‖Xβ − y‖² + λ‖β‖²；free 里为 true 的列不罚（比如星期几的截距） */
export function ridge(X: readonly number[][], y: readonly number[], lambda: number, free: readonly boolean[] = []): number[] {
  const p = (X[0] ?? []).length;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  X.forEach((x, i) => {
    for (let j = 0; j < p; j++) {
      b[j] = (b[j] as number) + (x[j] as number) * (y[i] as number);
      for (let k = j; k < p; k++) (A[j] as number[])[k] = ((A[j] as number[])[k] as number) + (x[j] as number) * (x[k] as number);
    }
  });
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) (A[j] as number[])[k] = (A[k] as number[])[j] as number;
    (A[j] as number[])[j] = ((A[j] as number[])[j] as number) + (free[j] ? 1e-6 : lambda);
  }
  return solve(A, b);
}
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * (b[i] as number), 0);
const quantile = (xs: readonly number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return (s[lo] as number) + ((s[Math.min(s.length - 1, lo + 1)] as number) - (s[lo] as number)) * (pos - lo);
};

// —— 门店销量 ——
/** 第 5 周起训练（前面要留 4 周给规则和「近 4 周的水平」），第 13 周起验证，第 15 周起检验 */
const D_TRAIN = 28;
const D_VALID = 84;
const D_TEST = 98;
export const DEMAND_MODELS = [
  { key: 'rule', label: '同星期几过去 4 周的平均', rule: true },
  { key: 'ridge', label: '岭回归（星期几 + 促销日历 + 近 4 周的水平）', rule: false },
  { key: 'hw', label: '指数平滑（霍尔特—温特斯，周季节）', rule: false },
] as const;
export type DemandModel = (typeof DEMAND_MODELS)[number]['key'];

/** 规则：同星期几过去 4 周的平均 */
function ruleAt(y: readonly number[], d: number): number {
  let s = 0;
  let n = 0;
  for (let k = 1; k <= 4; k++)
    if (d - 7 * k >= 0) {
      s += y[d - 7 * k] as number;
      n++;
    }
  return n ? s / n : NaN;
}
/** 岭回归的特征：星期几（7 列）、促销、近 4 周平均的对数（减去训练期的均值） */
function ridgeX(y: readonly number[], promo: readonly number[], d: number, center: number): number[] {
  const x = new Array<number>(9).fill(0);
  x[d % 7] = 1;
  x[7] = (promo[d] as number) > 1.001 ? 1 : 0;
  let s = 0;
  for (let k = d - 28; k < d; k++) s += y[k] as number;
  x[8] = Math.log(Math.max(1, s / 28)) - center;
  return x;
}
interface RidgeFit {
  beta: number[];
  center: number;
}
function fitRidge(y: readonly number[], promo: readonly number[], d0: number, d1: number): RidgeFit {
  let c = 0;
  for (let d = d0; d < d1; d++) {
    let s = 0;
    for (let k = d - 28; k < d; k++) s += y[k] as number;
    c += Math.log(Math.max(1, s / 28));
  }
  const center = c / Math.max(1, d1 - d0);
  const X: number[][] = [];
  const t: number[] = [];
  for (let d = d0; d < d1; d++) {
    X.push(ridgeX(y, promo, d, center));
    t.push(Math.log(Math.max(1, y[d] as number)));
  }
  return { beta: ridge(X, t, 2, [true, true, true, true, true, true, true, false, false]), center };
}
const ridgeAt = (f: RidgeFit, y: readonly number[], promo: readonly number[], d: number) => Math.exp(dot(ridgeX(y, promo, d, f.center), f.beta));

interface HwFit {
  alpha: number;
  gamma: number;
}
/** 霍尔特—温特斯（乘法周季节、无趋势）：从第 0 天跑到 d1，返回每天的一步预测 */
function hwRun(y: readonly number[], p: HwFit, d1: number): number[] {
  const out = new Array<number>(d1).fill(NaN);
  let level = 0;
  for (let d = 0; d < 14; d++) level += y[d] as number;
  level /= 14;
  const season = Array.from({ length: 7 }, (_, w) => (((y[w] as number) + (y[w + 7] as number)) / 2) / Math.max(1, level));
  for (let d = 14; d < d1; d++) {
    const w = d % 7;
    out[d] = level * (season[w] as number);
    const yd = y[d] as number;
    if (!Number.isFinite(yd)) continue;
    const nl = p.alpha * (yd / Math.max(1e-6, season[w] as number)) + (1 - p.alpha) * level;
    season[w] = p.gamma * (yd / Math.max(1e-6, nl)) + (1 - p.gamma) * (season[w] as number);
    level = nl;
  }
  return out;
}
function fitHw(y: readonly number[], d0: number, d1: number): HwFit {
  let best: HwFit = { alpha: 0.2, gamma: 0.1 };
  let bestErr = Infinity;
  for (const alpha of [0.05, 0.1, 0.2, 0.3, 0.5])
    for (const gamma of [0.05, 0.1, 0.2, 0.3]) {
      const f = hwRun(y, { alpha, gamma }, d1);
      let e = 0;
      for (let d = d0; d < d1; d++) e += Math.abs((f[d] as number) - (y[d] as number));
      if (e < bestErr) {
        bestErr = e;
        best = { alpha, gamma };
      }
    }
  return best;
}

export interface DemandFamily {
  key: string;
  label: string;
  models: ModelScore[];
  selected: DemandModel;
  /** 检验期每天：实际、期望需求（不含随机波动）、三个模型的预测 */
  test: { actual: number[]; expected: number[]; pred: Record<DemandModel, number[]> };
}
export interface DemandReport {
  seed: number;
  days: number;
  window: { train: number; valid: number; test: number };
  families: DemandFamily[];
  /** 全部商品族合计（件数加权）：每个模型、按验证期逐个商品族选的模型 */
  overall: ModelScore[];
  selectedTest: Metric;
  /** 和期望需求比（仿真里门店预测的误差按期望需求设定）：每个模型、按验证期选的模型 */
  vsExpected: Record<DemandModel, Metric>;
  selectedVsExpected: Metric;
  /** 随机波动本身：就算完全知道期望需求，对实际销量的误差（任何模型都消不掉） */
  oracle: Metric;
  /** 仿真里门店预测设定的误差（期望需求的 ±%） */
  assumed: number;
  /** 训练好的参数和历史（forecastDemand 用） */
  y: number[][];
  promo: number[][];
  ridge: RidgeFit[];
  hw: HwFit[];
}

function demandReport(h: ChainHistory, s: ChainScenario): DemandReport {
  const days = (h.demand[0] ?? []).length;
  const families: DemandFamily[] = [];
  const ridgeFits: RidgeFit[] = [];
  const hwFits: HwFit[] = [];
  const all: Record<DemandModel, { valid: { p: number[]; a: number[] }; test: { p: number[]; a: number[] } }> = { rule: { valid: { p: [], a: [] }, test: { p: [], a: [] } }, ridge: { valid: { p: [], a: [] }, test: { p: [], a: [] } }, hw: { valid: { p: [], a: [] }, test: { p: [], a: [] } } };
  const sel = { p: [] as number[], a: [] as number[], e: [] as number[] };
  const vsE: Record<DemandModel, { p: number[]; e: number[] }> = { rule: { p: [], e: [] }, ridge: { p: [], e: [] }, hw: { p: [], e: [] } };
  const oracle = { p: [] as number[], a: [] as number[] };
  FAMILIES.forEach((fam, f) => {
    const y = h.demand[f] as number[];
    const promo = h.promo[f] as number[];
    const exp = h.expected[f] as number[];
    // 选模型：第 5–12 周拟合，第 13–14 周验证
    const r0 = fitRidge(y, promo, D_TRAIN, D_VALID);
    const hw0 = hwRun(y, fitHw(y, D_TRAIN, D_VALID), D_TEST);
    const valid: Record<DemandModel, number[]> = { rule: [], ridge: [], hw: [] };
    const vAct: number[] = [];
    for (let d = D_VALID; d < D_TEST; d++) {
      valid.rule.push(ruleAt(y, d));
      valid.ridge.push(ridgeAt(r0, y, promo, d));
      valid.hw.push(hw0[d] as number);
      vAct.push(y[d] as number);
    }
    // 检验：第 5–14 周重训，第 15–18 周每天往前看一天
    const r1 = fitRidge(y, promo, D_TRAIN, D_TEST);
    const hp = fitHw(y, D_TRAIN, D_TEST);
    const hw1 = hwRun(y, hp, days);
    ridgeFits.push(r1);
    hwFits.push(hp);
    const pred: Record<DemandModel, number[]> = { rule: [], ridge: [], hw: [] };
    const act: number[] = [];
    const ex: number[] = [];
    for (let d = D_TEST; d < days; d++) {
      pred.rule.push(ruleAt(y, d));
      pred.ridge.push(ridgeAt(r1, y, promo, d));
      pred.hw.push(hw1[d] as number);
      act.push(y[d] as number);
      ex.push(exp[d] as number);
    }
    const models: ModelScore[] = DEMAND_MODELS.map((m) => ({ key: m.key, label: m.label, rule: m.rule, valid: metric(valid[m.key], vAct), test: metric(pred[m.key], act) }));
    const selected = [...models].sort((a, b) => a.valid.wape - b.valid.wape)[0]?.key as DemandModel;
    families.push({ key: fam.key, label: fam.label, models, selected, test: { actual: act, expected: ex, pred } });
    for (const m of DEMAND_MODELS) {
      all[m.key].valid.p.push(...valid[m.key]);
      all[m.key].valid.a.push(...vAct);
      all[m.key].test.p.push(...pred[m.key]);
      all[m.key].test.a.push(...act);
      vsE[m.key].p.push(...pred[m.key]);
      vsE[m.key].e.push(...ex);
    }
    sel.p.push(...pred[selected]);
    sel.a.push(...act);
    sel.e.push(...ex);
    oracle.p.push(...ex);
    oracle.a.push(...act);
  });
  const overall = DEMAND_MODELS.map((m) => ({ key: m.key, label: m.label, rule: m.rule, valid: metric(all[m.key].valid.p, all[m.key].valid.a), test: metric(all[m.key].test.p, all[m.key].test.a) }));
  return {
    seed: s.seed,
    days,
    window: { train: D_TRAIN, valid: D_VALID, test: D_TEST },
    families,
    overall,
    selectedTest: metric(sel.p, sel.a),
    vsExpected: { rule: metric(vsE.rule.p, vsE.rule.e), ridge: metric(vsE.ridge.p, vsE.ridge.e), hw: metric(vsE.hw.p, vsE.hw.e) },
    selectedVsExpected: metric(sel.p, sel.e),
    oracle: metric(oracle.p, oracle.a),
    assumed: s.store.forecastError * 100,
    y: h.demand,
    promo: h.promo,
    ridge: ridgeFits,
    hw: hwFits,
  };
}

// —— 班轮、班列的晚到 ——
const W_FIT = 56;
const W_TRAIN = 84;
export const DELAY_MODELS = [
  { key: 'rule', label: '规划的平均晚到', rule: true },
  { key: 'median', label: '历史中位数（分位数模型）', rule: false },
  { key: 'recent', label: '最近三班的平均', rule: false },
] as const;
export type DelayModel = (typeof DELAY_MODELS)[number]['key'];
export interface DelayReport {
  kind: 'vessel' | 'train';
  label: string;
  runs: number;
  /** 规划参数里的平均晚到（天） */
  planned: number;
  models: ModelScore[];
  selected: DelayModel;
  /** 训练期的中位数、90% 分位数（小时）；检验期有多少班在 90% 分位数以内 */
  median: number;
  p90: number;
  coverage: number;
  /** 检验期每班的实际晚到（小时） */
  actual: number[];
}

function delayReport(kind: 'vessel' | 'train', runs: { calls: { day: number; delay: number }[] }[], planned: number): DelayReport {
  const H = 24;
  const fitVals = (until: number) => runs.flatMap((r) => r.calls.filter((c) => c.day < until).map((c) => c.delay * H));
  const recentAt = (r: { calls: { day: number; delay: number }[] }, i: number) => {
    const prev = r.calls.slice(Math.max(0, i - 3), i).map((c) => c.delay * H);
    return prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : planned * H;
  };
  const score = (fitUntil: number, from: number, to: number) => {
    const med = quantile(fitVals(fitUntil), 0.5);
    const out: Record<DelayModel, number[]> = { rule: [], median: [], recent: [] };
    const act: number[] = [];
    for (const r of runs)
      r.calls.forEach((c, i) => {
        if (c.day < from || c.day >= to) return;
        out.rule.push(planned * H);
        out.median.push(med);
        out.recent.push(recentAt(r, i));
        act.push(c.delay * H);
      });
    return { out, act };
  };
  const v = score(W_FIT, W_FIT, W_TRAIN);
  const end = Math.max(...runs.flatMap((r) => r.calls.map((c) => c.day))) + 1;
  const t = score(W_TRAIN, W_TRAIN, end);
  const models: ModelScore[] = DELAY_MODELS.map((m) => ({ key: m.key, label: m.label, rule: m.rule, valid: metric(v.out[m.key], v.act), test: metric(t.out[m.key], t.act) }));
  const selected = [...models].sort((a, b) => a.valid.mae - b.valid.mae)[0]?.key as DelayModel;
  const train = fitVals(W_TRAIN);
  const p90 = quantile(train, 0.9);
  return { kind, label: kind === 'vessel' ? '本店班轮到港晚到' : '洲际班列到站晚到', runs: runs.length, planned, models, selected, median: quantile(train, 0.5), p90, coverage: t.act.length ? t.act.filter((x) => x <= p90).length / t.act.length : NaN, actual: t.act };
}

// —— 路上用时 ——
export const ROAD_MODELS = [
  { key: 'rule', label: '计划用时（路网的时段拥堵表）', rule: true },
  { key: 'ridge', label: '岭回归（每小时一个系数）', rule: false },
  { key: 'twin', label: '孪生在线学到的偏差（按小时）', rule: false },
] as const;
export type RoadModel = (typeof ROAD_MODELS)[number]['key'];
const HOURS = 26;
export interface RoadLeg {
  day: number;
  /** 出发时刻（当天的秒）、计划用时、实际用时（秒） */
  depart: number;
  plan: number;
  real: number;
  /** 这一程的计划时段落在每个小时里的比例 */
  w: number[];
}
/** 一天的现场（不执行建议），取每一程（出发或离开门店 → 到下一站）的计划和实际用时；路上抛锚的那一程不算 */
export function roadDay(day: number, gen: Gen = 'g3', worldSeed = 1, prepare?: (s: ChainScenario) => ChainScenario): { legs: RoadLeg[]; bias: number[] } {
  const s = prepare ? prepare(scenarioFor(gen, worldSeed)) : scenarioFor(gen, worldSeed);
  s.traceDay = day;
  const r = runChain(s);
  const trace = r.trace;
  if (!trace) return { legs: [], bias: new Array<number>(HOURS).fill(0) };
  const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
  const res = runLoop({ vehicles: trace.vehicles, ops: board.ops, board, seed: day, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: [...s.flow.direct], level: 'normal' }, { closed: false, policy: 'manual', decisions: [] });
  return { legs: legsOf(res, day), bias: res.bias.slice(0, HOURS) };
}
function legsOf(res: LoopResult, day: number): RoadLeg[] {
  const idx = new Map(res.vids.map((v, k) => [v, k] as const));
  const open = new Map<number, { t: number; clean: boolean }>();
  const legs: RoadLeg[] = [];
  const delayAt = (vid: number, t: number) => res.delays[idx.get(vid) ?? -1]?.[Math.round(t / 60)];
  for (const m of res.msgs) {
    if (m.kind !== 'event') continue;
    if (m.ev === 'depart' || m.ev === 'leave') open.set(m.vid, { t: m.t, clean: true });
    else if (m.ev === 'fault') {
      const o = open.get(m.vid);
      if (o) o.clean = false;
    } else if (m.ev === 'arrive') {
      const o = open.get(m.vid);
      open.delete(m.vid);
      if (!o || !o.clean) continue;
      const d0 = delayAt(m.vid, o.t);
      const d1 = delayAt(m.vid, m.t);
      if (d0 === undefined || d1 === undefined || !Number.isFinite(d0) || !Number.isFinite(d1)) continue;
      const real = m.t - o.t;
      const plan = real - (d1 - d0);
      if (plan < 300 || real <= 0) continue;
      legs.push({ day, depart: o.t, plan, real, w: exposure(o.t, plan) });
    }
  }
  return legs;
}
/** 从 t 开始的 dur 秒落在每个小时里的比例 */
function exposure(t: number, dur: number): number[] {
  const w = new Array<number>(HOURS).fill(0);
  for (let h = Math.max(0, Math.floor(t / 3600)); h < HOURS && h * 3600 < t + dur; h++) w[h] = (Math.min(t + dur, (h + 1) * 3600) - Math.max(t, h * 3600)) / dur;
  return w;
}
export interface RoadReport {
  days: number[];
  trainDays: number[];
  testDays: number[];
  legs: { train: number; test: number };
  models: ModelScore[];
  selected: RoadModel;
  /** 每小时的系数（实际 / 计划 − 1）：岭回归、孪生学到的偏差（训练那几天的平均） */
  beta: number[];
  twinBias: number[];
  /** 检验期按出发的小时：程数、实际 / 计划的平均、各模型预测的平均 */
  byHour: { hour: number; n: number; actual: number; ridge: number; twin: number }[];
}
const ratioOf = (beta: readonly number[], w: readonly number[]) => 1 + dot(w, beta);
function roadReport(days: { day: number; legs: RoadLeg[]; bias: number[] }[]): RoadReport {
  const nTrain = Math.max(2, Math.round(days.length * (2 / 3)));
  const nFit = Math.max(1, Math.round(nTrain * 0.75));
  const fit = (list: typeof days) => {
    const legs = list.flatMap((d) => d.legs);
    const beta = legs.length ? ridge(legs.map((l) => l.w), legs.map((l) => l.real / l.plan - 1), 0.5) : new Array<number>(HOURS).fill(0);
    const twin = Array.from({ length: HOURS }, (_, h) => list.reduce((a, d) => a + (d.bias[h] ?? 0), 0) / Math.max(1, list.length));
    return { beta, twin };
  };
  const score = (m: { beta: number[]; twin: number[] }, list: typeof days) => {
    const legs = list.flatMap((d) => d.legs);
    const act = legs.map((l) => l.real / 60);
    return {
      rule: metric(legs.map((l) => l.plan / 60), act),
      ridge: metric(legs.map((l) => (l.plan * ratioOf(m.beta, l.w)) / 60), act),
      twin: metric(legs.map((l) => (l.plan * ratioOf(m.twin, l.w)) / 60), act),
    };
  };
  const v = score(fit(days.slice(0, nFit)), days.slice(nFit, nTrain));
  const final = fit(days.slice(0, nTrain));
  const testList = days.slice(nTrain);
  const t = score(final, testList);
  const models: ModelScore[] = ROAD_MODELS.map((m) => ({ key: m.key, label: m.label, rule: m.rule, valid: v[m.key], test: t[m.key] }));
  const selected = [...models].sort((a, b) => a.valid.mae - b.valid.mae)[0]?.key as RoadModel;
  const byHour: RoadReport['byHour'] = [];
  for (let h = 0; h < 24; h++) {
    const legs = testList.flatMap((d) => d.legs).filter((l) => Math.floor(l.depart / 3600) % 24 === h);
    if (!legs.length) continue;
    const avg = (fn: (l: RoadLeg) => number) => legs.reduce((a, l) => a + fn(l), 0) / legs.length;
    byHour.push({ hour: h, n: legs.length, actual: avg((l) => l.real / l.plan), ridge: avg((l) => ratioOf(final.beta, l.w)), twin: avg((l) => ratioOf(final.twin, l.w)) });
  }
  return {
    days: days.map((d) => d.day),
    trainDays: days.slice(0, nTrain).map((d) => d.day),
    testDays: testList.map((d) => d.day),
    legs: { train: days.slice(0, nTrain).reduce((a, d) => a + d.legs.length, 0), test: testList.reduce((a, d) => a + d.legs.length, 0) },
    models,
    selected,
    beta: final.beta,
    twinBias: final.twin,
    byHour,
  };
}

// —— 一次训练全部 ——
export interface ForecastReport {
  gen: Gen;
  demand: DemandReport;
  vessel: DelayReport;
  train: DelayReport;
  road: RoadReport;
  ms: number;
}
export interface ForecastOptions {
  gen?: Gen;
  /** 门店销量用哪个种子（一次 18 周的运行） */
  seed?: number;
  /** 晚到用几次独立的运行 */
  delayRuns?: number;
  /** 路上用时用哪几天的现场（前三分之二训练、后三分之一检验） */
  roadDays?: number[];
  /** 调用方给场景再套一层（网页套上管理台改过的设施配置） */
  prepare?: (s: ChainScenario) => ChainScenario;
  onProgress?: (done: number, total: number, text: string) => void;
}
export const ROAD_DAYS = Array.from({ length: 30 }, (_, i) => 80 + i);

/** 训练全部预测模型（区域按调用方 setRegion 设好的；平常负荷、默认设施） */
export function trainForecasts(opts: ForecastOptions = {}): ForecastReport {
  const t0 = performance.now();
  const gen = opts.gen ?? 'g3';
  const nRuns = opts.delayRuns ?? 12;
  const roadDays = opts.roadDays ?? ROAD_DAYS;
  const total = nRuns + roadDays.length;
  let done = 0;
  const tick = (text: string) => opts.onProgress?.(++done, total, text);
  const runs: { s: ChainScenario; h: ChainHistory }[] = [];
  for (let k = 0; k < nRuns; k++) {
    const s = opts.prepare ? opts.prepare(scenarioFor(gen, (opts.seed ?? 1) + k)) : scenarioFor(gen, (opts.seed ?? 1) + k);
    s.history = true;
    runs.push({ s, h: runChain(s).history as ChainHistory });
    tick(`销量和船期：第 ${k + 1} / ${nRuns} 次运行`);
  }
  const first = runs[0] as { s: ChainScenario; h: ChainHistory };
  const roads: { day: number; legs: RoadLeg[]; bias: number[] }[] = [];
  for (const day of roadDays) {
    roads.push({ day, ...roadDay(day, gen, opts.seed ?? 1, opts.prepare) });
    tick(`路上用时：第 ${day} 天的现场`);
  }
  return {
    gen,
    demand: demandReport(first.h, first.s),
    vessel: delayReport('vessel', runs.map((r) => ({ calls: r.h.calls })), first.s.port.vesselDelayDays),
    train: delayReport('train', runs.map((r) => ({ calls: r.h.trains })), first.s.rail.delayDays),
    road: roadReport(roads),
    ms: performance.now() - t0,
  };
}

// —— 给别的模块用：按选中的模型预测 ——
let current: ForecastReport | undefined;
export function setForecastReport(r: ForecastReport | undefined): void {
  current = r;
}
export function forecastReport(): ForecastReport | undefined {
  return current;
}
const LABEL: Record<ForecastTarget, readonly { key: string; label: string }[]> = { demand: DEMAND_MODELS, vessel: DELAY_MODELS, train: DELAY_MODELS, road: ROAD_MODELS };
/** 某个预测对象选中的模型和理由（门店销量按商品族；不给商品族 = 全部合计里用得最多的） */
export function selectedModel(target: ForecastTarget, fam?: string, r: ForecastReport | undefined = current): { key: string; label: string; reason: string } | undefined {
  if (!r) return undefined;
  const pct = (m: Metric | undefined) => (m ? `${m.wape.toFixed(1)}%` : '—');
  const hrs = (m: Metric | undefined) => (m ? `${m.mae.toFixed(1)} 小时` : '—');
  const mins = (m: Metric | undefined) => (m ? `${m.mae.toFixed(1)} 分钟` : '—');
  const pick = (models: readonly ModelScore[], key: string, fmt: (m: Metric | undefined) => string) => {
    const m = models.find((x) => x.key === key);
    const rule = models.find((x) => x.rule);
    const label = LABEL[target].find((x) => x.key === key)?.label ?? key;
    const others = models.filter((x) => x.key !== key).map((x) => `${x.label} ${fmt(x.valid)}`).join('，');
    const reason = m?.rule ? `验证期里学到的模型都没有比规则准（规则 ${fmt(m.valid)}；${others}），继续用规则` : `验证期误差 ${fmt(m?.valid)}，比规则（${fmt(rule?.valid)}）小，检验期 ${fmt(m?.test)}（规则 ${fmt(rule?.test)}）`;
    return { key, label, reason };
  };
  if (target === 'demand') {
    if (fam) {
      const f = r.demand.families.find((x) => x.key === fam);
      return f ? pick(f.models, f.selected, pct) : undefined;
    }
    const count = new Map<string, number>();
    for (const f of r.demand.families) count.set(f.selected, (count.get(f.selected) ?? 0) + 1);
    const key = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'rule';
    return pick(r.demand.overall, key, pct);
  }
  if (target === 'road') return pick(r.road.models, r.road.selected, mins);
  const d = target === 'vessel' ? r.vessel : r.train;
  return pick(d.models, d.selected, hrs);
}
/** 某个商品族某一天的销量预测（件，门店合计；按选中的模型、用前一天为止的实际；超出记录的天按预测值往后推） */
export function forecastDemand(fam: string, day: number, r: ForecastReport | undefined = current): number | undefined {
  if (!r) return undefined;
  const f = FAMILIES.findIndex((x) => x.key === fam);
  const fr = r.demand.families[f];
  if (f < 0 || !fr || day < D_TRAIN) return undefined;
  const y = [...(r.demand.y[f] as number[])];
  const promo = r.demand.promo[f] as number[];
  const at = (d: number): number => {
    if (fr.selected === 'rule') return ruleAt(y, d);
    if (fr.selected === 'ridge') return ridgeAt(r.demand.ridge[f] as RidgeFit, y, promo, d);
    return hwRun(y, r.demand.hw[f] as HwFit, d + 1)[d] as number;
  };
  // 记录之外的日子没有促销日历（按没有促销算），先把中间的日子按预测补上
  for (let d = y.length; d < day; d++) y[d] = at(d);
  return at(day);
}
/** 下一班的晚到（小时）：按选中的模型，另给 90% 分位数 */
export function forecastDelay(kind: 'vessel' | 'train', r: ForecastReport | undefined = current): { hours: number; p90: number; model: string } | undefined {
  if (!r) return undefined;
  const d = kind === 'vessel' ? r.vessel : r.train;
  const recent = d.actual.slice(-3);
  const hours = d.selected === 'rule' ? d.planned * 24 : d.selected === 'median' ? d.median : recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  return { hours, p90: d.p90, model: DELAY_MODELS.find((m) => m.key === d.selected)?.label ?? d.selected };
}
/** 一程路的预计用时（分钟）：计划用时 planMin、几点出发（当天的秒） */
export function forecastTravel(planMin: number, departSec: number, r: ForecastReport | undefined = current): number | undefined {
  if (!r) return undefined;
  const w = exposure(departSec, planMin * 60);
  const k = r.road.selected;
  return k === 'rule' ? planMin : planMin * ratioOf(k === 'ridge' ? r.road.beta : r.road.twinBias, w);
}
