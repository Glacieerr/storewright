import { keyedUniform } from '@storewright/domain';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { DEFAULT_DEMAND, generateArrivals, generateCatalog, generateDemandHistory, generateShelfTruth, generateSubstitutionEvents, historyDailyHours } from '@storewright/synth';
import {
  abcPolicy,
  backtest,
  ETA_VARIANTS,
  evaluateAvailability,
  evaluateEta,
  evaluateSubstitution,
  fitCountRisk,
  FORECASTERS,
  hourlySeries,
  makeCountItems,
  riskPolicy,
  simulateCounting,
  sliceMetrics,
  wape,
} from '@storewright/ai';
import { AI_EFFECTS, aiAblationPolicies, BASELINE, defaultScenario, OPTIMIZED, runExperiment, type Policy, type SimScenario } from '@storewright/sim-engine';

/**
 * AI 效益报告（Phase 5e）：所有数字都来自合成数据和仿真（证据等级 B），同一个命令可以重新生成。
 * 1–5：五个模型族的离线评估（多个种子）；6：运营上的 AI 开 / 关对比（公共随机数，配对差值与 95% 置信区间）；
 * 7：到店时间修正的取舍曲线；8：AI 效果大小的敏感性分析。
 */

export interface AiReportOptions {
  reps: number;
  seeds: number;
  quick: boolean;
  onProgress?: (msg: string) => void;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const range = (xs: number[], digits = 3) => (xs.length ? `${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}` : '—');
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

function table(head: string[], rows: Array<Array<string | number>>): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function aiReport(o: AiReportOptions): string {
  const log = o.onProgress ?? (() => undefined);
  const model = new StoreModel(createTemplate('medium'));
  const seeds = Array.from({ length: o.seeds }, (_, i) => [107, 1, 2, 3, 4, 5, 6, 7][i] ?? 100 + i);
  const out: string[] = [];
  out.push('# AI 效益报告（自动生成）', '', `> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')} · 种子 ${seeds.length} 个 · 运营仿真每组 ${o.reps} 天 · 全部为合成数据与仿真（证据等级 B）`, '');

  // 1. 订单量
  log('订单量预测…');
  const days = o.quick ? 420 : 730;
  const ord: Record<string, { all: number[]; cov: number[]; special: number[] }> = {};
  const oracle: number[] = [];
  for (const seed of seeds) {
    const h = generateDemandHistory(model, { seed, days, startDate: '2024-10-01', scenario: DEFAULT_DEMAND.medium, factors: { regimeShift: { day: Math.floor(days * 0.82), multiplier: 0.9 } } });
    const s = hourlySeries(historyDailyHours(h), h.hours);
    const testFrom = days - (o.quick ? 120 : 365);
    const known = new Set(h.days.filter((d) => d.observed.holiday || d.observed.holidayEve || d.observed.stormWarningTomorrow).map((d) => d.day));
    const act: number[] = [];
    const exp: number[] = [];
    for (const d of h.days.slice(testFrom)) for (const hr of h.hours) {
      act.push(d.actual.hourly[hr] ?? 0);
      exp.push(d.expected.hourly[hr] ?? 0);
    }
    oracle.push(wape(act, exp));
    for (const f of Object.values(FORECASTERS)) {
      const r = backtest(s, f, { initialDays: testFrom, horizonDays: 7, stepDays: 7 });
      const e = (ord[f.kind] ??= { all: [], cov: [], special: [] });
      e.all.push(r.metrics.wape as number);
      e.cov.push(r.metrics.coverage80 as number);
      const sl = sliceMetrics(r, (p) => known.has(p.day));
      if (sl.n) e.special.push(sl.wape as number);
    }
  }
  out.push('## 1. 订单量预测', '', `中型店，${days} 天合成历史（含隐藏因素与一次需求下降），最后 ${o.quick ? 120 : 365} 天按周滚动回测。`, '');
  out.push(table(['预测器', '按小时 WAPE', '80% 区间覆盖率', '事先知道的特殊日子'], [...Object.entries(ord).map(([k, v]) => [k, pct(mean(v.all)), pct(mean(v.cov)), v.special.length ? pct(mean(v.special)) : '—']), ['理论下限（真实期望值）', pct(mean(oracle)), '—', '—']]), '');

  // 2. 到店时间
  log('到店时间修正…');
  const eta: Record<string, Record<string, number[]>> = {};
  for (const seed of seeds) {
    const h = generateDemandHistory(model, { seed, days: 120, startDate: '2025-06-01', scenario: DEFAULT_DEMAND.medium });
    const samples = generateArrivals({ seed, history: h }).map((a) => ({ t: a.t, customer: a.customer, reportedMin: a.reportedMin, actualMin: a.actualMin, hour: a.hour, dow: a.dow, x: a.x }));
    for (const v of ETA_VARIANTS) {
      const r = evaluateEta(samples, v);
      for (const [k, val] of Object.entries(r.metrics)) ((eta[v] ??= {})[k] ??= []).push(val);
    }
  }
  out.push('## 2. 到店时间修正', '', '120 天合成到店记录，按时间先后前 70% 训练，之后逐条预测（预测后计入顾客习惯）。', '');
  out.push(table(['版本', '平均绝对误差（分钟）', '偏差（分钟）', '80% 区间覆盖率', '老顾客的平均绝对误差'], Object.entries(eta).map(([k, v]) => [k, mean(v.mae ?? []).toFixed(2), mean(v.bias ?? []).toFixed(2), pct(mean(v.coverage80 ?? [])), mean(v.maeRepeat ?? []).toFixed(2)])), '');

  // 3. 可售概率
  log('可售概率…');
  const av: Record<string, Record<string, number[]>> = {};
  for (const seed of seeds.slice(0, 3)) {
    const r = evaluateAvailability(generateShelfTruth({ seed, items: o.quick ? 120 : 200, days: o.quick ? 40 : 60 }));
    for (const [variant, m] of Object.entries(r.metrics)) for (const [k, v] of Object.entries(m)) if (Number.isFinite(v)) ((av[variant] ??= {})[k] ??= []).push(v);
  }
  out.push('## 3. 可售概率与幽灵库存', '', '合成货架真实存量，按天切分前 70% 训练；提醒阈值 P(幽灵) ≥ 0.5。', '');
  out.push(table(['版本', 'Brier', 'AUC', '校准误差', '提醒精确率', '提醒召回率'], Object.entries(av).map(([k, v]) => [k, range(v.brier ?? [], 4), range(v.auc ?? []), range(v.ece ?? [], 4), v.precision?.length ? range(v.precision) : '—', range(v.recall ?? [])])), '');

  // 4. 按风险盘点
  log('按风险盘点…');
  const cr: Array<[number, number, number, number, number]> = [];
  for (const seed of seeds.slice(0, 3)) {
    const uniform = (s: string, k: string) => keyedUniform(seed, s, k);
    const items = makeCountItems(400, uniform);
    const warm = simulateCounting({ items, days: 120, budget: 12, uniform, policyFor: () => abcPolicy });
    const params = fitCountRisk(warm.samples);
    const base = simulateCounting({ items, days: 240, budget: 12, uniform, policyFor: () => abcPolicy, measureFrom: 120 });
    const risk = simulateCounting({ items, days: 240, budget: 12, uniform, policyFor: (d) => (d < 120 ? abcPolicy : riskPolicy(params)), measureFrom: 120 });
    cr.push([seed, base.avgInaccurate, risk.avgInaccurate, base.meanDetectDays, risk.meanDetectDays]);
  }
  out.push('## 4. 按风险盘点', '', '400 条后仓记录、每天 12 次盘点；前 120 天按 ABC 周期盘点积累训练数据，后 120 天比较（公共随机数）。', '');
  out.push(table(['种子', '平均不准的记录数（ABC → 按风险）', '变化', '发现错误的平均天数'], cr.map(([s, a, b, c, d]) => [s, `${a.toFixed(1)} → ${b.toFixed(1)}`, pct((b - a) / a, 0), `${c.toFixed(1)} → ${d.toFixed(1)}`])), '');

  // 5. 替代推荐
  log('替代推荐…');
  const catalog = generateCatalog(model, { seed: 7 });
  const sub: Record<string, Record<string, number[]>> = {};
  for (const seed of seeds.slice(0, 3)) {
    const r = evaluateSubstitution(generateSubstitutionEvents(catalog.items, { seed, events: o.quick ? 2000 : 4000 }), catalog.byId);
    for (const [k, m] of Object.entries(r.metrics)) for (const [mk, v] of Object.entries(m)) ((sub[k] ??= {})[mk] ??= []).push(v);
  }
  out.push('## 5. 替代推荐', '', '合成替代记录（顾客偏好类型模型看不到），前 70% 训练，用真实接受概率评估第一名。', '');
  out.push(table(['排序方法', '推荐第一名的期望接受率', 'NDCG@3'], Object.entries(sub).map(([k, v]) => [k, range((v.acceptTop1 ?? []).map((x) => x * 100), 1).replace(/(\d)–/, '$1%–') + '%', range(v.ndcg3 ?? [])])), '');

  // 6. 运营消融
  log('运营仿真：AI 开 / 关…');
  const metrics: Array<[string, string, number]> = [
    ['avgWaitMin', '平均等待（分钟）', 2],
    ['p90WaitMin', '90 分位等待（分钟）', 2],
    ['lateOrderPct', '迟到订单（%）', 2],
    ['avgReadyDwellMin', '门口停留（分钟）', 2],
    ['fillRate', '满足率', 4],
    ['substitutedLines', '替代行数', 1],
    ['staffedHoursTotal', '排班工时', 1],
  ];
  out.push('## 6. 运营上的 AI 开 / 关对比', '', `中型店，${o.reps} 天，公共随机数（同样的订单和随机事件）。差值为「打开 AI − 不打开」的配对差值，括号里是 95% 置信区间的半宽。AI 排班不增加总工时。`, '');
  for (const base of [OPTIMIZED, BASELINE]) {
    const r = runExperiment({ template: 'medium', reps: o.reps, baseSeed: 2026, policies: [base, ...aiAblationPolicies(base)] });
    const head = ['指标', `${base.name}（不打开 AI）`, ...r.paired.map((p) => p.policy.replace(`${base.name}+`, ''))];
    const rows = metrics.map(([k, label, d]) => [
      label,
      ((r.policies[0]?.summary as Record<string, { mean: number }>)[k]?.mean ?? NaN).toFixed(d),
      ...r.paired.map((p) => {
        const x = (p.delta as Record<string, { mean: number; ci95: number }>)[k];
        return x ? `${x.mean >= 0 ? '+' : ''}${x.mean.toFixed(d)}（±${x.ci95.toFixed(d)}）` : '—';
      }),
    ]);
    out.push(`### 以「${base.name === 'optimized' ? '默认档位' : '基线'}」为基础`, '', table(head, rows), '');
  }

  // 7. 到店时间的取舍曲线
  log('到店时间的取舍曲线…');
  out.push('## 7. 到店时间修正的取舍：提前多少开始准备', '', '按 AI 修正的到达时间开始准备时，再提前 k 个误差标准差。k 越大等待越短、门口停留越长（冷链风险），门店按自己的优先级选择。', '');
  const ks = o.quick ? [0, 1, 2] : [0, 0.5, 1, 1.5, 2];
  const curve: Array<Array<string | number>> = [];
  for (const base of [BASELINE, OPTIMIZED]) {
    for (const k of ks) {
      const scenario: SimScenario = { ...defaultScenario('medium'), aiEffects: { etaSafetySd: k } };
      const p: Policy = { ...base, name: `${base.name}+ai-eta`, ai: { eta: true } };
      const r = runExperiment({ template: 'medium', reps: Math.max(4, Math.round(o.reps / 2)), baseSeed: 2026, policies: [base, p], scenario });
      const d = r.paired[0]?.delta as Record<string, { mean: number }> | undefined;
      curve.push([base.name === 'optimized' ? '默认档位' : '基线', k, `${(d?.avgWaitMin?.mean ?? NaN) >= 0 ? '+' : ''}${(d?.avgWaitMin?.mean ?? NaN).toFixed(2)}`, `${(d?.avgReadyDwellMin?.mean ?? NaN) >= 0 ? '+' : ''}${(d?.avgReadyDwellMin?.mean ?? NaN).toFixed(2)}`]);
    }
  }
  out.push(table(['基础策略', 'k（误差标准差）', '平均等待的变化（分钟）', '门口停留的变化（分钟）'], curve), '');

  // 8. 敏感性
  log('敏感性分析…');
  out.push('## 8. AI 效果大小的敏感性', '', '在默认档位上打开全部 AI 模块，把效果大小调到保守 / 乐观，看结论是否还成立。', '');
  const variants: Array<[string, Partial<typeof AI_EFFECTS>]> = [
    ['默认（离线评估的数值）', {}],
    ['保守：预测误差 ×2、到店误差 ×1.5、替代提升 1.03、挑选时间只缩短 10%', { dayForecastErrorSd: AI_EFFECTS.dayForecastErrorSd * 2, etaErrorSdMin: AI_EFFECTS.etaErrorSdMin * 1.5, substitutionUplift: 1.03, substituteTimeFactor: 0.9 }],
    ['乐观：预测误差 ×0.5、到店误差 ×0.75、替代提升 1.10', { dayForecastErrorSd: AI_EFFECTS.dayForecastErrorSd * 0.5, etaErrorSdMin: AI_EFFECTS.etaErrorSdMin * 0.75, substitutionUplift: 1.1 }],
  ];
  const sens: Array<Array<string>> = [];
  for (const [label, eff] of variants) {
    const scenario: SimScenario = { ...defaultScenario('medium'), aiEffects: eff };
    const all = aiAblationPolicies(OPTIMIZED).at(-1) as Policy;
    const r = runExperiment({ template: 'medium', reps: Math.max(4, Math.round(o.reps / 2)), baseSeed: 2026, policies: [OPTIMIZED, all], scenario });
    const d = r.paired[0]?.delta as Record<string, { mean: number; ci95: number }> | undefined;
    const f = (k: string, dd = 2) => (d?.[k] ? `${d[k].mean >= 0 ? '+' : ''}${d[k].mean.toFixed(dd)}（±${d[k].ci95.toFixed(dd)}）` : '—');
    sens.push([label, f('avgWaitMin'), f('p90WaitMin'), f('lateOrderPct'), f('fillRate', 4)]);
  }
  out.push(table(['效果大小', '平均等待', '90 分位等待', '迟到订单（%）', '满足率'], sens), '');
  out.push('---', '', '说明：所有数字来自合成数据与仿真，用于比较方法与策略，不代表任何真实门店的数据。离线评估与仿真之间的衔接（AI 效果大小）见 `AI_EFFECTS` 的注释。');
  return out.join('\n');
}
