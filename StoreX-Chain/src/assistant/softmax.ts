/**
 * 多类逻辑回归（softmax 回归）：纯 TypeScript、确定性，给意图分类用（不接语言模型）。
 *
 * - 特征是稀疏的字符串（字的一元、二元、三元组，占位符，英文词）；只保留训练语料里至少在 minCount 条里出现过的，按字典序编号；
 *   每条的计数向量按 L2 范数归一化。
 * - 训练：随机梯度下降，样本顺序由固定种子的伪随机数洗牌，固定的轮数，学习率线性衰减，L2 正则（只衰减这一条用到的权重）；
 *   每条样本可以带权重。同一份语料、同一组参数，每次训练出来一模一样。
 */
export interface SoftmaxModel {
  classes: string[];
  vocab: Map<string, number>;
  /** 权重：特征 j、类 k 在 w[j * K + k] */
  w: Float64Array;
  b: Float64Array;
}
export interface SoftmaxOpts {
  epochs: number;
  lr: number;
  l2: number;
  minCount: number;
  seed: number;
}
export interface SoftmaxRow {
  y: string;
  f: readonly string[];
  w: number;
}

function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function encode(vocab: ReadonlyMap<string, number>, f: readonly string[]): { idx: number[]; val: number[] } {
  const m = new Map<number, number>();
  for (const s of f) {
    const j = vocab.get(s);
    if (j !== undefined) m.set(j, (m.get(j) ?? 0) + 1);
  }
  const idx = [...m.keys()].sort((a, b) => a - b);
  const raw = idx.map((j) => m.get(j) as number);
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
  return { idx, val: raw.map((v) => v / norm) };
}

export function trainSoftmax(rows: readonly SoftmaxRow[], o: SoftmaxOpts): SoftmaxModel {
  const classes = [...new Set(rows.map((r) => r.y))].sort();
  const K = classes.length;
  const cls = new Map(classes.map((c, i) => [c, i] as const));
  const df = new Map<string, number>();
  for (const r of rows) for (const s of new Set(r.f)) df.set(s, (df.get(s) ?? 0) + 1);
  const vocab = new Map<string, number>();
  for (const s of [...df.keys()].sort()) if ((df.get(s) as number) >= o.minCount) vocab.set(s, vocab.size);
  const w = new Float64Array(vocab.size * K);
  const b = new Float64Array(K);
  const X = rows.map((r) => ({ ...encode(vocab, r.f), y: cls.get(r.y) as number, wt: r.w }));
  const order = X.map((_, i) => i);
  const next = rand(o.seed);
  const z = new Float64Array(K);
  const total = o.epochs * X.length;
  let t = 0;
  for (let ep = 0; ep < o.epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const tmp = order[i] as number;
      order[i] = order[j] as number;
      order[j] = tmp;
    }
    for (const i of order) {
      const x = X[i] as (typeof X)[number];
      const eta = o.lr * Math.max(0.05, 1 - t / total);
      let top = -Infinity;
      for (let k = 0; k < K; k++) {
        let s = b[k] as number;
        for (let a = 0; a < x.idx.length; a++) s += (w[(x.idx[a] as number) * K + k] as number) * (x.val[a] as number);
        z[k] = s;
        if (s > top) top = s;
      }
      let sum = 0;
      for (let k = 0; k < K; k++) {
        z[k] = Math.exp((z[k] as number) - top);
        sum += z[k] as number;
      }
      for (let k = 0; k < K; k++) {
        const g = ((z[k] as number) / sum - (k === x.y ? 1 : 0)) * x.wt;
        b[k] = (b[k] as number) - eta * g;
        for (let a = 0; a < x.idx.length; a++) {
          const j = (x.idx[a] as number) * K + k;
          w[j] = (w[j] as number) - eta * (g * (x.val[a] as number) + o.l2 * (w[j] as number));
        }
      }
      t++;
    }
  }
  return { classes, vocab, w, b };
}

/** 每类的打分（logit，未归一化） */
export function softmaxLogits(m: SoftmaxModel, f: readonly string[]): number[] {
  const K = m.classes.length;
  const x = encode(m.vocab, f);
  const out = new Array<number>(K);
  for (let k = 0; k < K; k++) {
    let s = m.b[k] as number;
    for (let a = 0; a < x.idx.length; a++) s += (m.w[(x.idx[a] as number) * K + k] as number) * (x.val[a] as number);
    out[k] = s;
  }
  return out;
}

/** 按温度 T 换成概率（T > 1 变平、T < 1 变尖），从大到小排 */
export function calibrated(classes: readonly string[], scores: readonly number[], T: number): { intent: string; p: number }[] {
  const top = Math.max(...scores);
  const e = scores.map((s) => Math.exp((s - top) / T));
  const z = e.reduce((a, v) => a + v, 0);
  return classes.map((c, i) => ({ intent: c, p: (e[i] as number) / z })).sort((a, b) => b.p - a.p || (a.intent < b.intent ? -1 : 1));
}
