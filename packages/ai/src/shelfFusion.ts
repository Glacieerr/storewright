import { brier } from './metrics';

/**
 * 多源货架真相（决策记录 0022 · 第二批 C1）。
 *
 * 只看收银沉默（Phase 5b 的可售概率）要等好几个小时；拣货员每天在货架间走来走去，他们的「找不到」
 * 和「拣到了」是最及时的证据。这里把几种证据合在一起，给每件商品一个「货架上找得到」的概率，
 * 找不到时再分成「可能放错了地方」和「真的没了（卖完、损坏、丢失）」：
 * - 起点：收银沉默给出的概率（没有收银流水时按系统估算）；
 * - 每条「找不到」的报告按它的可靠度更新几率：可靠度 r 是「报告之后数出来确实没有」的比例，是在平时的缺货率 π（约 5%）下得到的，
 *   所以似然比 = r/(1−r) ÷ π/(1−π)，对数几率减去 logit(r) − logit(π)；「拣到了」是直接看到货在架上，按固定的强证据加上；
 *   越旧的报告权重越低（半衰期）；
 * - 可靠度从「报告之后员工到货架数的结果」学：报告找不到、数出来确实是 0 记一次对；先验相当于看过 10 次；
 * - 放错地方的概率：报告「货位上是别的东西 / 空位」时高，报告损坏时低。
 * 全部是贝叶斯更新，几微秒一件；理由列出用到的证据。
 */

export type ShelfSignalKind = 'NOT_FOUND_EMPTY' | 'NOT_FOUND_ELSEWHERE' | 'NOT_FOUND_DAMAGED' | 'NOT_FOUND_TAG' | 'NOT_FOUND_OTHER' | 'PICKED_OK';
export const SHELF_SIGNALS: readonly ShelfSignalKind[] = ['NOT_FOUND_EMPTY', 'NOT_FOUND_ELSEWHERE', 'NOT_FOUND_DAMAGED', 'NOT_FOUND_TAG', 'NOT_FOUND_OTHER', 'PICKED_OK'];

export interface ShelfSignal {
  kind: ShelfSignalKind;
  at: number;
}

/** 每种证据的可靠度：说对、说错的次数（NOT_FOUND_*：数出来确实是 0 算对；PICKED_OK：数出来大于 0 算对） */
export type SignalReliability = Record<ShelfSignalKind, { hit: number; miss: number }>;

export const DEFAULT_RELIABILITY: SignalReliability = {
  NOT_FOUND_EMPTY: { hit: 9, miss: 1 },
  NOT_FOUND_ELSEWHERE: { hit: 8, miss: 2 },
  NOT_FOUND_DAMAGED: { hit: 9, miss: 1 },
  NOT_FOUND_TAG: { hit: 6, miss: 4 },
  NOT_FOUND_OTHER: { hit: 7, miss: 3 },
  PICKED_OK: { hit: 9, miss: 1 },
};

/** 找不到时「放错了地方」的概率（按报告的原因） */
const MISPLACED: Record<ShelfSignalKind, number> = { NOT_FOUND_EMPTY: 0.25, NOT_FOUND_ELSEWHERE: 0.8, NOT_FOUND_DAMAGED: 0.1, NOT_FOUND_TAG: 0.6, NOT_FOUND_OTHER: 0.35, PICKED_OK: 0.35 };

export interface ShelfBelief {
  /** 货架上找得到的概率 */
  pOn: number;
  /** 找不到时：放错了地方 / 真的没了 */
  pMisplaced: number;
  pGone: number;
  /** 用到的证据（新的在前） */
  used: Array<{ kind: ShelfSignalKind; ageH: number; weight: number }>;
}

const clamp = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = (p: number) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function reliabilityOf(r: SignalReliability, k: ShelfSignalKind): number {
  const x = r[k] ?? DEFAULT_RELIABILITY[k];
  return (x.hit + 1) / (x.hit + x.miss + 2);
}

/** 平时的缺货率（可靠度是在这个基准下测出来的） */
const BASE_OUT = 0.05;
/** 「拣到了」的似然比（对数）：直接看到货在架上 */
const PICKED_LR = 3;

export function fuseShelf(input: { pPrior: number; signals: readonly ShelfSignal[]; now: number; reliability?: SignalReliability; halfLifeH?: number }): ShelfBelief {
  const rel = input.reliability ?? DEFAULT_RELIABILITY;
  const half = input.halfLifeH ?? 2;
  let z = logit(input.pPrior);
  let misZ = logit(0.35);
  const used: ShelfBelief['used'] = [];
  for (const sgn of [...input.signals].sort((a, b) => b.at - a.at)) {
    const ageH = Math.max(0, (input.now - sgn.at) / 3_600_000);
    const w = Math.pow(0.5, ageH / half);
    if (w < 0.05) continue;
    if (sgn.kind === 'PICKED_OK') z += w * PICKED_LR;
    else {
      const lr = Math.max(0.5, logit(reliabilityOf(rel, sgn.kind)) - logit(BASE_OUT));
      z -= w * lr;
      misZ += w * (logit(MISPLACED[sgn.kind]) - logit(0.35));
    }
    used.push({ kind: sgn.kind, ageH: Math.round(ageH * 10) / 10, weight: Math.round(w * 100) / 100 });
  }
  const pOn = sigmoid(z);
  const mis = sigmoid(misZ);
  return { pOn: Math.round(pOn * 1000) / 1000, pMisplaced: Math.round((1 - pOn) * mis * 1000) / 1000, pGone: Math.round((1 - pOn) * (1 - mis) * 1000) / 1000, used };
}

/**
 * 员工数货架后，用数出来的结果更新每种证据的可靠度。
 * found：附近找一找时商品在哪里——在附近找到（已放回原货位再数）说明「原货位上找不到」的报告是对的，即使数出来大于 0。
 */
export function learnReliability(r: SignalReliability, signals: readonly ShelfSignal[], countedUnits: number, found?: 'HOME' | 'NEARBY' | 'NONE'): SignalReliability {
  const out = { ...r } as SignalReliability;
  const atHome = found ? found === 'HOME' : countedUnits > 0;
  for (const s of signals) {
    const cur = out[s.kind] ?? DEFAULT_RELIABILITY[s.kind];
    const right = s.kind === 'PICKED_OK' ? atHome : !atHome;
    out[s.kind] = { hit: cur.hit + (right ? 1 : 0), miss: cur.miss + (right ? 0 : 1) };
  }
  return out;
}

/**
 * 离线评估：合成的货架（每小时卖货、偶尔整批找不到——放错地方或丢失，补货时被发现）、
 * 拣货员按需求路过（找不到时 90% 会报告，原因多半对；货在架上时偶尔也报找不到）。
 * 比较「只看收银沉默」与「沉默 + 拣货员报告」：Brier 分数、整批找不到后多久被认出来（概率 < 0.35）。
 */
export function evaluateShelfFusion(seed = 1, items = 150, hours = 240): { metrics: Record<'silence' | 'fused', { brier: number; detectH: number; n: number }> } {
  let x = seed * 9973 + 17;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const probs = { silence: [] as number[], fused: [] as number[] };
  const truth: boolean[] = [];
  const detect = { silence: [] as number[], fused: [] as number[] };
  for (let i = 0; i < items; i++) {
    const rate = 0.3 + rnd() * 2.5;
    let onShelf = 8;
    let phantomFrom = -1;
    let silentH = 0;
    const signals: ShelfSignal[] = [];
    const found = { silence: -1, fused: -1 };
    for (let h = 0; h < hours; h++) {
      const t = h * 3_600_000;
      // 整批找不到（放错地方或丢失），每小时 1%；补货员每 24 小时到一次，会发现并补满
      if (phantomFrom < 0 && onShelf > 0 && rnd() < 0.01) phantomFrom = h;
      if (h % 24 === 0) {
        onShelf = 8;
        phantomFrom = -1;
        silentH = 0;
        signals.length = 0;
        found.silence = found.fused = -1;
      }
      const available = phantomFrom < 0 && onShelf > 0;
      // 卖货：货在架上时按速度卖
      let sold = 0;
      if (available) {
        const lambda = rate;
        let k = 0;
        let p = Math.exp(-lambda);
        let c = p;
        const u = rnd();
        while (u > c && k < 20) {
          k++;
          p *= lambda / k;
          c += p;
        }
        sold = Math.min(onShelf, k);
        onShelf -= sold;
      }
      silentH = sold > 0 ? 0 : silentH + 1;
      // 拣货员路过：按速度的一部分
      if (rnd() < Math.min(0.6, 0.08 + rate * 0.06)) {
        if (!available) {
          if (rnd() < 0.9) signals.push({ kind: phantomFrom >= 0 && rnd() < 0.7 ? 'NOT_FOUND_ELSEWHERE' : 'NOT_FOUND_EMPTY', at: t });
        } else if (rnd() < 0.03) signals.push({ kind: 'NOT_FOUND_EMPTY', at: t });
        else signals.push({ kind: 'PICKED_OK', at: t });
      }
      // 只看沉默：P(货在架上 | 沉默 silentH 小时) ∝ 先验 × e^(−速度 × 小时)
      const prior = 0.97;
      const pSilence = (prior * Math.exp(-rate * silentH)) / (prior * Math.exp(-rate * silentH) + (1 - prior));
      const fused = fuseShelf({ pPrior: pSilence, signals, now: t }).pOn;
      probs.silence.push(pSilence);
      probs.fused.push(fused);
      truth.push(available);
      if (phantomFrom >= 0) {
        if (found.silence < 0 && pSilence < 0.35) {
          found.silence = h;
          detect.silence.push(h - phantomFrom);
        }
        if (found.fused < 0 && fused < 0.35) {
          found.fused = h;
          detect.fused.push(h - phantomFrom);
        }
      }
    }
  }
  const outcome = truth.map((v) => (v ? 1 : 0) as 0 | 1);
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  return {
    metrics: {
      silence: { brier: Math.round(brier(probs.silence, outcome) * 10000) / 10000, detectH: mean(detect.silence), n: detect.silence.length },
      fused: { brier: Math.round(brier(probs.fused, outcome) * 10000) / 10000, detectH: mean(detect.fused), n: detect.fused.length },
    },
  };
}
