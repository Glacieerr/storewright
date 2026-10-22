/**
 * 模型仓库：每个模型族（例如 orders-hourly）的版本、指标和状态。
 *
 * - 新训练的版本先登记为候选；
 * - 上线门槛：候选的主指标必须比当前版本改善至少 minImprovement（相对值），护栏指标不能退化超过允许范围；
 *   没有当前版本时直接通过；
 * - 通过后旧的当前版本退役，候选成为当前版本；不通过的候选标记为已拒绝，并记下逐项检查结果；
 * - 回滚：当前版本退役（标记为已回滚，之后不会再被恢复），最近一个正常退役的版本恢复为当前版本。
 *
 * 仓库是普通 JSON（toJSON / 构造函数），可以直接存进数据库或文件。
 */

export type ModelStatus = 'CANDIDATE' | 'CHAMPION' | 'RETIRED' | 'REJECTED';

export interface GateCheck {
  metric: string;
  rule: 'PRIMARY' | 'GUARDRAIL';
  candidate: number;
  champion: number;
  /** 相对变化，正数表示变好 */
  change: number;
  ok: boolean;
}

export interface GateResult {
  passed: boolean;
  /** 比较对象（当前版本号）；没有当前版本时为空 */
  against?: number;
  checks: GateCheck[];
}

export interface ModelVersion {
  id: string;
  version: number;
  /** 算法 */
  kind: string;
  status: ModelStatus;
  trainedAt: number;
  /** 训练数据：来源、天数、日期范围、合成数据的种子、其中真实营业日的天数与合成数据的权重 */
  data: { source: 'SIM' | 'LIVE' | 'MIXED'; days: number; from?: string; to?: string; seed?: number; liveDays?: number; simWeight?: number };
  metrics: Record<string, number>;
  /** 可序列化的模型参数 */
  params: unknown;
  gate?: GateResult;
  promotedAt?: number;
  retiredAt?: number;
  /** 状态说明代码，例如 NOT_BEST（同一批训练中不是最好的）、ROLLED_BACK */
  note?: string;
}

export interface MetricRule {
  metric: string;
  lowerIsBetter: boolean;
}

export interface GatePolicy {
  primary: MetricRule;
  /** 主指标至少改善的相对比例，例如 0.01 = 1% */
  minImprovement: number;
  guardrails: Array<MetricRule & { maxRegression: number }>;
}

export interface RegistryData {
  models: ModelVersion[];
}

/** 数量预测的默认门槛：WAPE 至少改善 1%，偏差的绝对值和区间覆盖率偏离 80% 的程度不能明显变差 */
export const FORECAST_GATE: GatePolicy = {
  primary: { metric: 'wape', lowerIsBetter: true },
  minImprovement: 0.01,
  guardrails: [
    { metric: 'absBias', lowerIsBetter: true, maxRegression: 0.5 },
    { metric: 'coverageGap', lowerIsBetter: true, maxRegression: 1 },
  ],
};

/** 到店时间修正：平均绝对误差（分钟）至少改善 1%，偏差与区间覆盖率不明显变差 */
export const ETA_GATE: GatePolicy = {
  primary: { metric: 'mae', lowerIsBetter: true },
  minImprovement: 0.01,
  guardrails: [
    { metric: 'absBias', lowerIsBetter: true, maxRegression: 0.5 },
    { metric: 'coverageGap', lowerIsBetter: true, maxRegression: 1 },
  ],
};

/** 可售概率：Brier 分数至少改善 1%，校准误差不明显变差 */
export const AVAILABILITY_GATE: GatePolicy = {
  primary: { metric: 'brier', lowerIsBetter: true },
  minImprovement: 0.01,
  guardrails: [{ metric: 'ece', lowerIsBetter: true, maxRegression: 1 }],
};

/** 按风险盘点：同样盘点数量下，平均不准的记录数至少减少 1% */
export const COUNT_GATE: GatePolicy = {
  primary: { metric: 'avgInaccurate', lowerIsBetter: true },
  minImprovement: 0.01,
  guardrails: [{ metric: 'meanDetectDays', lowerIsBetter: true, maxRegression: 0.2 }],
};

/** 替代推荐：推荐第一名的期望接受率至少提高 1%，NDCG@3 不明显变差 */
export const SUBSTITUTION_GATE: GatePolicy = {
  primary: { metric: 'acceptTop1', lowerIsBetter: false },
  minImprovement: 0.01,
  guardrails: [{ metric: 'ndcg3', lowerIsBetter: false, maxRegression: 0.05 }],
};

/** 给数量预测的指标补上门槛需要的派生项 */
export function withDerived(metrics: Record<string, number>): Record<string, number> {
  const out = { ...metrics };
  if (Number.isFinite(metrics.bias)) out.absBias = Math.abs(metrics.bias as number);
  if (Number.isFinite(metrics.coverage80)) out.coverageGap = Math.round(Math.abs((metrics.coverage80 as number) - 0.8) * 10000) / 10000;
  return out;
}

/** 相对变化（正数表示变好）；基准接近 0 时用绝对差，避免除以 0 */
function relChange(candidate: number, champion: number, lowerIsBetter: boolean): number {
  const diff = lowerIsBetter ? champion - candidate : candidate - champion;
  const base = Math.abs(champion);
  return Math.round((base > 1e-3 ? diff / base : diff) * 10000) / 10000;
}

export function evaluateGate(candidate: ModelVersion, champion: ModelVersion | undefined, policy: GatePolicy): GateResult {
  if (!champion) return { passed: true, checks: [] };
  const checks: GateCheck[] = [];
  const get = (m: ModelVersion, k: string) => m.metrics[k] ?? NaN;
  const p = policy.primary;
  const pc = relChange(get(candidate, p.metric), get(champion, p.metric), p.lowerIsBetter);
  checks.push({ metric: p.metric, rule: 'PRIMARY', candidate: get(candidate, p.metric), champion: get(champion, p.metric), change: pc, ok: Number.isFinite(pc) && pc >= policy.minImprovement });
  for (const g of policy.guardrails) {
    const a = get(candidate, g.metric);
    const b = get(champion, g.metric);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const c = relChange(a, b, g.lowerIsBetter);
    // 护栏只防止明显变差：两边都很小（< 0.02）时视为没有退化
    const ok = c >= -g.maxRegression || Math.max(Math.abs(a), Math.abs(b)) < 0.02;
    checks.push({ metric: g.metric, rule: 'GUARDRAIL', candidate: a, champion: b, change: c, ok });
  }
  return { passed: checks.every((c) => c.ok), against: champion.version, checks };
}

export class ModelRegistry {
  private readonly models: ModelVersion[];

  constructor(data?: RegistryData) {
    this.models = data ? data.models.map((m) => ({ ...m })) : [];
  }

  /** 登记一个候选版本，版本号在模型族内递增 */
  register(m: Omit<ModelVersion, 'version' | 'status'>): ModelVersion {
    const version = Math.max(0, ...this.models.filter((x) => x.id === m.id).map((x) => x.version)) + 1;
    const v: ModelVersion = { ...m, version, status: 'CANDIDATE' };
    this.models.push(v);
    return v;
  }

  get(id: string, version: number): ModelVersion | undefined {
    return this.models.find((m) => m.id === id && m.version === version);
  }

  champion(id: string): ModelVersion | undefined {
    return this.models.find((m) => m.id === id && m.status === 'CHAMPION');
  }

  list(id?: string): ModelVersion[] {
    return this.models.filter((m) => !id || m.id === id).sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version);
  }

  /**
   * 候选版本过门槛；通过则上线，不通过则拒绝。
   * - championMetrics：当前版本在「同一份评估数据」上的指标（训练数据变了时，旧指标不可比，需要重新评估当前版本）；
   * - force：跳过门槛（人工决定），检查结果仍然记录。
   */
  promote(id: string, version: number, policy: GatePolicy, at: number, opts: { force?: boolean; championMetrics?: Record<string, number> } = {}): GateResult {
    const cand = this.get(id, version);
    if (!cand) throw new Error(`model ${id} v${version} not found`);
    if (cand.status !== 'CANDIDATE') throw new Error(`model ${id} v${version} is ${cand.status}`);
    const champ = this.champion(id);
    const gate = evaluateGate(cand, champ && opts.championMetrics ? { ...champ, metrics: opts.championMetrics } : champ, policy);
    const force = opts.force ?? false;
    cand.gate = gate;
    if (gate.passed || force) {
      if (champ) {
        champ.status = 'RETIRED';
        champ.retiredAt = at;
      }
      cand.status = 'CHAMPION';
      cand.promotedAt = at;
      if (!gate.passed) cand.note = 'FORCED';
    } else cand.status = 'REJECTED';
    return gate;
  }

  /** 标记一个候选为拒绝（例如同一批训练中不是最好的） */
  reject(id: string, version: number, note: string): void {
    const m = this.get(id, version);
    if (m && m.status === 'CANDIDATE') {
      m.status = 'REJECTED';
      m.note = note;
    }
  }

  /** 回滚到最近一个退役版本；没有可回滚的版本时返回 undefined，状态不变 */
  rollback(id: string, at: number): ModelVersion | undefined {
    const champ = this.champion(id);
    const prev = this.models.filter((m) => m.id === id && m.status === 'RETIRED' && m.note !== 'ROLLED_BACK').sort((a, b) => (b.retiredAt ?? 0) - (a.retiredAt ?? 0) || b.version - a.version)[0];
    if (!champ || !prev) return undefined;
    champ.status = 'RETIRED';
    champ.retiredAt = at;
    champ.note = 'ROLLED_BACK';
    prev.status = 'CHAMPION';
    prev.promotedAt = at;
    delete prev.retiredAt;
    return prev;
  }

  toJSON(): RegistryData {
    return { models: this.models.map((m) => ({ ...m })) };
  }
}
