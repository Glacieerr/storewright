import { dot, fitGlm, sigmoid } from './glm';
import { rankReasons, type Reason } from './recommendation';

/**
 * 替代推荐（Phase 5c）：缺货时推荐哪件替代品，顾客最可能接受？
 *
 * - 硬约束（在候选生成时保证）：同类别、同温区、年龄限制一致、不是同一件商品；
 * - 打分：顾客接受的概率。特征是「原商品 → 候选」的关系：同品名、同品牌、口味 / 规格是否一致、
 *   有机降级、价格变化（升级、降价）、候选的受欢迎程度；
 * - 三个版本互为对照：现有规则（名称末尾词相同 + 价格接近）、属性相似度（手工权重）、学习排序（逻辑回归，
 *   用过去「拣货员选了哪件、顾客接受没有」的记录训练）。
 *
 * 每个特征的几率比就是理由，界面显示「同品牌」「口味不同」「贵 18%」之类。
 */

export interface SubItem {
  id: string;
  name: string;
  categoryId: string;
  unitPrice: number;
  popularity: number;
  attributes: Readonly<Record<string, string | number | boolean>>;
}

export const SUB_FEATURES = ['INTERCEPT', 'SAME_STEM', 'SAME_BRAND', 'SAME_FLAVOR', 'FLAVOR_CHANGE', 'SAME_SIZE', 'SIZE_CHANGE', 'ORGANIC_DOWNGRADE', 'PRICE_UP', 'PRICE_DOWN', 'POPULARITY'] as const;

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

/** 原商品 → 候选 的关系特征 */
export function subFeatures(o: SubItem, c: SubItem, popRef = 1e-3): number[] {
  const a = o.attributes;
  const b = c.attributes;
  const fo = str(a.flavor);
  const fc = str(b.flavor);
  const so = str(a.size);
  const sc = str(b.size);
  const ratio = c.unitPrice / Math.max(0.01, o.unitPrice);
  return [
    1,
    a.stem && a.stem === b.stem ? 1 : 0,
    a.brand && a.brand === b.brand ? 1 : 0,
    fo && fc && fo === fc ? 1 : 0,
    fo && fc && fo !== fc ? 1 : 0,
    so && sc && so === sc ? 1 : 0,
    so && sc && so !== sc ? 1 : 0,
    a.organic === true && b.organic !== true ? 1 : 0,
    Math.max(0, Math.log(ratio)),
    Math.max(0, -Math.log(ratio)),
    Math.log(Math.max(c.popularity, 1e-6) / popRef),
  ];
}

export interface SubstitutionParams {
  beta: number[];
  /** 受欢迎程度的参照值（目录的中位数） */
  popRef: number;
}

/** 现有规则：名称末尾相同的词越多越好，其次价格越接近越好（与员工端原来的候选排序一致） */
export function ruleScore(o: SubItem, c: SubItem): number {
  const w = o.name.toLowerCase().split(/\s+/);
  const v = c.name.toLowerCase().split(/\s+/);
  let n = 0;
  while (n < w.length && n < v.length && w[w.length - 1 - n] === v[v.length - 1 - n]) n++;
  return n * 100 - Math.abs(c.unitPrice - o.unitPrice);
}

/** 属性相似度（手工权重）：同品名 3、同品牌 1、口味 / 规格一致各 1、有机降级 −2，价格每差 10% 扣 0.5 */
export function similarityScore(o: SubItem, c: SubItem): number {
  const f = subFeatures(o, c);
  return 3 * (f[1] as number) + (f[2] as number) + (f[3] as number) - (f[4] as number) + (f[5] as number) - (f[6] as number) - 2 * (f[7] as number) - 5 * ((f[8] as number) + (f[9] as number));
}

export function fitSubstitution(rows: ReadonlyArray<{ x: number[]; accepted: boolean }>, popRef: number, lambda = 1): SubstitutionParams {
  const fit = fitGlm(
    rows.map((r) => r.x),
    rows.map((r) => (r.accepted ? 1 : 0)),
    { family: 'logistic', lambda, penalize: SUB_FEATURES.map((_, i) => i > 0) },
  );
  return { beta: fit.beta.map((b) => Math.round(b * 10000) / 10000), popRef };
}

export interface RankedSubstitute {
  item: SubItem;
  /** 预计顾客接受的概率 */
  p: number;
  reasons: Reason[];
}

const REASON_VALUE = (o: SubItem, c: SubItem, code: string): number | undefined => {
  if (code === 'PRICE_UP' || code === 'PRICE_DOWN') return Math.round((c.unitPrice / Math.max(0.01, o.unitPrice) - 1) * 100);
  return undefined;
};

/** 按接受概率排序候选，附理由（每个特征相对「什么都不一样」的几率比） */
export function rankSubstitutes(params: SubstitutionParams, o: SubItem, candidates: readonly SubItem[], limit = 5): RankedSubstitute[] {
  return candidates
    .map((c) => {
      const x = subFeatures(o, c, params.popRef);
      const p = sigmoid(dot(x, params.beta));
      const reasons: Reason[] = [];
      for (let j = 1; j < x.length - 1; j++) {
        const logOr = (params.beta[j] as number) * (x[j] as number);
        if (Math.abs(logOr) < 0.1) continue;
        const code = SUB_FEATURES[j] as string;
        const value = REASON_VALUE(o, c, code);
        reasons.push({ factor: code, ...(value !== undefined ? { value } : {}), effect: { kind: 'MULTIPLY', amount: Math.round(Math.exp(logOr) * 100) / 100 }, weight: 0 });
      }
      return { item: c, p: Math.round(p * 1000) / 1000, reasons: rankReasons(reasons, 3) };
    })
    .sort((a, b) => b.p - a.p || a.item.id.localeCompare(b.item.id))
    .slice(0, limit);
}

/** 排序质量：NDCG@k，相关度用真实接受概率（只有仿真里知道） */
export function ndcg(trueProbsInRankedOrder: readonly number[], allTrueProbs: readonly number[], k = 3): number {
  const dcg = (xs: readonly number[]) => xs.slice(0, k).reduce((a, r, i) => a + r / Math.log2(i + 2), 0);
  const ideal = dcg([...allTrueProbs].sort((a, b) => b - a));
  return ideal > 0 ? dcg(trueProbsInRankedOrder) / ideal : 0;
}

export interface SubstitutionLog {
  originalId: string;
  candidateIds: readonly string[];
  shownId: string;
  accepted: boolean;
  trueP: Readonly<Record<string, number>>;
}

/**
 * 按记录先后评估：前 trainFrac 训练学习排序，之后每条记录比较三种排序选出的第一名，
 * 用真实接受概率计算「推荐第一名的期望接受率」和 NDCG@3；oracle 是知道真实概率时的上限。
 */
export function evaluateSubstitution(
  logs: readonly SubstitutionLog[],
  items: ReadonlyMap<string, SubItem>,
  trainFrac = 0.7,
): { params: SubstitutionParams; metrics: Record<string, Record<string, number>> } {
  const pops = [...items.values()].map((i) => i.popularity).sort((a, b) => a - b);
  const popRef = pops[Math.floor(pops.length / 2)] ?? 1e-3;
  const cut = Math.floor(logs.length * trainFrac);
  const rows = logs.slice(0, cut).flatMap((l) => {
    const o = items.get(l.originalId);
    const c = items.get(l.shownId);
    return o && c ? [{ x: subFeatures(o, c, popRef), accepted: l.accepted }] : [];
  });
  const params = fitSubstitution(rows, popRef);
  const methods: Record<string, (o: SubItem, cs: SubItem[]) => SubItem[]> = {
    rule: (o, cs) => [...cs].sort((a, b) => ruleScore(o, b) - ruleScore(o, a) || a.id.localeCompare(b.id)),
    similarity: (o, cs) => [...cs].sort((a, b) => similarityScore(o, b) - similarityScore(o, a) || a.id.localeCompare(b.id)),
    learned: (o, cs) => rankSubstitutes(params, o, cs, cs.length).map((r) => r.item),
  };
  const acc: Record<string, { top1: number; ndcg: number }> = { rule: { top1: 0, ndcg: 0 }, similarity: { top1: 0, ndcg: 0 }, learned: { top1: 0, ndcg: 0 }, oracle: { top1: 0, ndcg: 1 } };
  let n = 0;
  for (const l of logs.slice(cut)) {
    const o = items.get(l.originalId);
    const cs = l.candidateIds.map((id) => items.get(id)).filter((x): x is SubItem => !!x);
    if (!o || !cs.length) continue;
    n++;
    const truth = cs.map((c) => l.trueP[c.id] ?? 0);
    for (const [name, rank] of Object.entries(methods)) {
      const order = rank(o, cs).map((c) => l.trueP[c.id] ?? 0);
      (acc[name] as { top1: number }).top1 += order[0] ?? 0;
      (acc[name] as { ndcg: number }).ndcg += ndcg(order, truth, 3);
    }
    (acc.oracle as { top1: number }).top1 += Math.max(...truth);
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const metrics: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(acc)) metrics[k] = { acceptTop1: r3(v.top1 / Math.max(1, n)), ndcg3: r3(k === 'oracle' ? 1 : v.ndcg / Math.max(1, n)), n };
  return { params, metrics };
}
