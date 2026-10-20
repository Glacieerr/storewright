import { StoreModel, createTemplate, type StoreConfig, type TemplateName } from '@storewright/store-config';
import { generateCatalog, generateOrders } from '@storewright/synth';
import { simulateDay, type DayMetrics } from './day';
import { defaultScenario, type Policy, type SimScenario } from './scenario';
import { summarize, type Summary } from './stats';

export type MetricKey = Exclude<keyof DayMetrics, 'policy'>;

export interface ExperimentInput {
  template: TemplateName;
  reps: number;
  baseSeed: number;
  policies: Policy[];
  /** 第一个策略之外的策略都与它做配对比较；默认是第一个 */
  referencePolicy?: string;
  scenario?: SimScenario;
  config?: StoreConfig;
  catalogSeed?: number;
}

export interface PolicySummary {
  policy: string;
  runs: DayMetrics[];
  summary: Record<MetricKey, Summary>;
}

export interface PairedComparison {
  policy: string;
  reference: string;
  /** 每次重复的差值（策略 − 参照）的统计 */
  delta: Record<MetricKey, Summary>;
}

export interface ExperimentResult {
  template: TemplateName;
  reps: number;
  baseSeed: number;
  scenario: SimScenario;
  policies: PolicySummary[];
  paired: PairedComparison[];
}

function metricKeys(m: DayMetrics): MetricKey[] {
  return (Object.keys(m) as Array<keyof DayMetrics>).filter((k): k is MetricKey => k !== 'policy' && typeof m[k] === 'number');
}

/**
 * 公共随机数实验：每次重复生成一份订单流，所有策略面对同一份订单和同一组随机事件；
 * 重复 N 次，报告均值、95% 置信区间，以及相对参照策略的配对差值。
 */
export function runExperiment(input: ExperimentInput, onProgress?: (done: number, total: number) => void): ExperimentResult {
  const config = input.config ?? createTemplate(input.template);
  const model = new StoreModel(config);
  const scenario = input.scenario ?? defaultScenario(input.template);
  const catalog = generateCatalog(model, { seed: input.catalogSeed ?? 7 });
  const runs = new Map<string, DayMetrics[]>(input.policies.map((p) => [p.name, []]));
  const total = input.reps * input.policies.length;
  let done = 0;
  for (let r = 0; r < input.reps; r++) {
    const orders = generateOrders(model, catalog, scenario.demand, { seed: input.baseSeed + r * 7919, day: r + 1 });
    const eventSeed = input.baseSeed * 31 + r;
    for (const policy of input.policies) {
      const res = simulateDay({ model, items: catalog.byId, orders, scenario, policy, seed: eventSeed });
      (runs.get(policy.name) as DayMetrics[]).push(res.metrics);
      onProgress?.(++done, total);
    }
  }

  const first = runs.get(input.policies[0]?.name ?? '')?.[0];
  const keys = first ? metricKeys(first) : [];
  const policies: PolicySummary[] = input.policies.map((p) => {
    const list = runs.get(p.name) as DayMetrics[];
    const summary = {} as Record<MetricKey, Summary>;
    for (const k of keys) summary[k] = summarize(list.map((m) => m[k] as number));
    return { policy: p.name, runs: list, summary };
  });

  const refName = input.referencePolicy ?? input.policies[0]?.name ?? '';
  const ref = runs.get(refName) ?? [];
  const paired: PairedComparison[] = input.policies
    .filter((p) => p.name !== refName)
    .map((p) => {
      const list = runs.get(p.name) as DayMetrics[];
      const delta = {} as Record<MetricKey, Summary>;
      for (const k of keys) delta[k] = summarize(list.map((m, i) => (m[k] as number) - ((ref[i] as DayMetrics)[k] as number)));
      return { policy: p.name, reference: refName, delta };
    });

  return { template: input.template, reps: input.reps, baseSeed: input.baseSeed, scenario, policies, paired };
}
