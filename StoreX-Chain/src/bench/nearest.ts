import { featuresLR, lrRows, type Intent } from '../assistant/intent';

/**
 * 对照系统「nearest」的意图分类器：训练语料（和逻辑回归同一份：模板展开的问法 + 另外收的语料的训练部分）上的 TF-IDF 最近邻。
 * 特征和逻辑回归一样（featuresLR：词、占位符、三字片段），按余弦相似度找最像的一条训练问法，每类意图取它最像的那条的相似度当概率。
 * TF-IDF nearest-neighbour intent ranker over the same training rows and features as the logistic regression.
 */
interface Model {
  idf: Map<string, number>;
  /** 倒排：特征 → [行号, 权重] */
  post: Map<string, [number, number][]>;
  ys: Intent[];
  norms: Float64Array;
}

let model: Model | undefined;

function build(): Model {
  const rows = lrRows();
  // 同一个意图、同样特征的行只留一条（模板展开会有重复）
  const seen = new Set<string>();
  const uniq: { y: Intent; f: readonly string[] }[] = [];
  for (const r of rows) {
    const k = `${r.y}|${[...r.f].sort().join(' ')}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push({ y: r.y as Intent, f: r.f });
  }
  const df = new Map<string, number>();
  for (const r of uniq) for (const f of new Set(r.f)) df.set(f, (df.get(f) ?? 0) + 1);
  const n = uniq.length;
  const idf = new Map<string, number>();
  for (const [f, d] of df) idf.set(f, Math.log((n + 1) / (d + 1)) + 1);
  const post = new Map<string, [number, number][]>();
  const norms = new Float64Array(n);
  uniq.forEach((r, i) => {
    const tf = new Map<string, number>();
    for (const f of r.f) tf.set(f, (tf.get(f) ?? 0) + 1);
    let s = 0;
    for (const [f, c] of tf) {
      const w = c * (idf.get(f) as number);
      s += w * w;
      (post.get(f) ?? (post.set(f, []).get(f) as [number, number][])).push([i, w]);
    }
    norms[i] = Math.sqrt(s) || 1;
  });
  return { idf, post, ys: uniq.map((r) => r.y), norms };
}

/** 每类意图的「概率」（最像的训练问法的余弦相似度，0–1），从大到小；完全没有共同特征时返回空的排序以外的兜底（help，0） */
export function nearestRank(masked: string): { intent: Intent; p: number }[] {
  const m = (model ??= build());
  const tf = new Map<string, number>();
  for (const f of featuresLR(masked)) if (m.idf.has(f)) tf.set(f, (tf.get(f) ?? 0) + 1);
  let qn = 0;
  const dot = new Map<number, number>();
  for (const [f, c] of tf) {
    const w = c * (m.idf.get(f) as number);
    qn += w * w;
    for (const [i, rw] of m.post.get(f) ?? []) dot.set(i, (dot.get(i) ?? 0) + w * rw);
  }
  qn = Math.sqrt(qn);
  const best = new Map<Intent, number>();
  for (const [i, d] of dot) {
    const sim = qn ? d / (qn * (m.norms[i] as number)) : 0;
    const y = m.ys[i] as Intent;
    if (sim > (best.get(y) ?? -1)) best.set(y, sim);
  }
  const out = [...best].map(([intent, p]) => ({ intent, p: Math.min(1, p) })).sort((a, b) => b.p - a.p || (a.intent < b.intent ? -1 : 1));
  return out.length ? out : [{ intent: 'help', p: 0 }];
}
