/**
 * 小型广义线性模型（纯 TypeScript，无依赖）：泊松回归与逻辑回归，迭代重加权最小二乘（IRLS）+ L2 正则。
 *
 * 特征只有几十个、样本几百到几千条，在门店的普通电脑和浏览器里几毫秒就能拟合完。
 * 系数可以直接解释：泊松回归里 exp(β) 是倍数，逻辑回归里 exp(β) 是几率比。
 */

/** 解线性方程组 A·x = b（高斯消元，部分主元）。A 会被复制，不修改输入 */
export function solve(A: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((M[r] as number[])[c] as number) > Math.abs((M[p] as number[])[c] as number)) p = r;
    if (p !== c) [M[c], M[p]] = [M[p] as number[], M[c] as number[]];
    const pivotRow = M[c] as number[];
    const pivot = pivotRow[c] as number;
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = c + 1; r < n; r++) {
      const row = M[r] as number[];
      const f = (row[c] as number) / pivot;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) row[k] = (row[k] as number) - f * (pivotRow[k] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = M[r] as number[];
    let s = row[n] as number;
    for (let k = r + 1; k < n; k++) s -= (row[k] as number) * (x[k] as number);
    const d = row[r] as number;
    x[r] = Math.abs(d) < 1e-12 ? 0 : s / d;
  }
  return x;
}

export interface GlmOptions {
  family: 'poisson' | 'logistic';
  /** 每条样本的偏移量（加在线性预测上，例如对数水平） */
  offset?: readonly number[];
  /** 样本权重（默认 1） */
  weights?: readonly number[];
  /** L2 正则强度；penalize[j] = false 的列不受约束（例如截距） */
  lambda?: number;
  penalize?: readonly boolean[];
  maxIter?: number;
  tol?: number;
  /** 初始系数（热启动） */
  start?: readonly number[];
}

export interface GlmFit {
  beta: number[];
  iterations: number;
  converged: boolean;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clampEta = (z: number) => Math.max(-30, Math.min(30, z));

/**
 * 拟合 GLM。X 不自动加截距（需要截距时自己加一列 1）。
 * 泊松：log μ = offset + Xβ；逻辑：logit p = offset + Xβ。
 */
export function fitGlm(X: readonly (readonly number[])[], y: readonly number[], opts: GlmOptions): GlmFit {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const lambda = opts.lambda ?? 0;
  const maxIter = opts.maxIter ?? 30;
  const tol = opts.tol ?? 1e-7;
  let beta = opts.start ? [...opts.start] : new Array<number>(p).fill(0);
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIter; iterations++) {
    const XtWX = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const XtWz = new Array<number>(p).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i] as readonly number[];
      const off = opts.offset?.[i] ?? 0;
      let lin = 0;
      for (let j = 0; j < p; j++) lin += (xi[j] as number) * (beta[j] as number);
      const eta = clampEta(off + lin);
      const wi = opts.weights?.[i] ?? 1;
      let w: number;
      let z: number;
      if (opts.family === 'poisson') {
        const mu = Math.max(Math.exp(eta), 1e-8);
        w = wi * mu;
        z = lin + ((y[i] as number) - mu) / mu;
      } else {
        const pr = Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(eta)));
        const v = pr * (1 - pr);
        w = wi * v;
        z = lin + ((y[i] as number) - pr) / v;
      }
      if (w === 0) continue;
      for (let a = 0; a < p; a++) {
        const xa = xi[a] as number;
        if (xa === 0) continue;
        XtWz[a] = (XtWz[a] as number) + w * xa * z;
        const row = XtWX[a] as number[];
        for (let b = a; b < p; b++) {
          const xb = xi[b] as number;
          if (xb !== 0) row[b] = (row[b] as number) + w * xa * xb;
        }
      }
    }
    for (let a = 0; a < p; a++) {
      const row = XtWX[a] as number[];
      for (let b = 0; b < a; b++) row[b] = (XtWX[b] as number[])[a] as number;
      if (lambda > 0 && opts.penalize?.[a] !== false) row[a] = (row[a] as number) + lambda;
    }
    const next = solve(XtWX, XtWz);
    let delta = 0;
    for (let j = 0; j < p; j++) delta = Math.max(delta, Math.abs((next[j] as number) - (beta[j] as number)));
    beta = next;
    if (delta < tol) {
      converged = true;
      iterations++;
      break;
    }
  }
  return { beta, iterations, converged };
}

/** 线性预测 x·β */
export function dot(x: readonly number[], beta: readonly number[]): number {
  let s = 0;
  for (let j = 0; j < x.length; j++) s += (x[j] as number) * (beta[j] ?? 0);
  return s;
}

export { sigmoid };
