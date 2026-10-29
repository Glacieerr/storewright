/**
 * 临期与损耗（决策记录 0024 · 第四批 C4）：每个批次到期前卖不完的概率，和该怎么处理。
 *
 * - 到期前还能卖多少：还剩 h 小时，需求按负二项分布（均值 = 每小时速度 × h，离散参数 k = 4，比泊松更分散）；
 *   货架上更早到期的批次要先卖掉（先进先出），所以 P(这一批卖不完) = P(需求 < 前面的件数 + 这一批的件数)；
 * - 处理：中等风险移到显眼位置（假设需求 +15%）；降价 20%（假设需求 +60%）或 40%（假设 +150%，临期打折吸引专门买特价的顾客）——取预计损失
 *   （到期剩下的 × 进价 + 降价让掉的钱）最小的；到期前一天降价也卖不完的，建议捐赠（比报废好）。降价幅度要店长确认。
 * - 评估（仿真）：每件商品有自己的速度、保质期和到货节奏；比较不处理、规则（剩 1 天时降 30%）和模型（按概率分级），
 *   看报废、降价让掉的钱、缺货。全部为假设参数，结论看相对变化。
 */

export const EXPIRY_K = 4;
/** 降价、移到显眼位置后需求的倍数（假设） */
export const MARKDOWN_LIFT: Readonly<Record<string, number>> = { '0.2': 1.6, '0.4': 2.5 };
export const VISIBLE_LIFT = 1.15;

/** 负二项分布 P(X ≤ x)（均值 mean、离散参数 k） */
export function nbCdf(mean: number, x: number, k = EXPIRY_K): number {
  if (x < 0) return 0;
  if (mean <= 0) return 1;
  const p = k / (k + mean);
  let pmf = Math.pow(p, k);
  let cdf = pmf;
  for (let i = 1; i <= Math.floor(x); i++) {
    pmf *= ((i - 1 + k) / i) * (1 - p);
    cdf += pmf;
    if (cdf >= 1 - 1e-12) return 1;
  }
  return Math.min(1, cdf);
}

export interface LotRiskInput {
  /** 前面更早到期的批次还剩多少件 */
  unitsAhead: number;
  units: number;
  hoursLeft: number;
  /** 每小时卖几件 */
  velocity: number;
}

/** 这一批到期前卖不完的概率（lift：降价或移位后需求的倍数） */
export function lotRisk(i: LotRiskInput, lift = 1): number {
  if (i.units <= 0) return 0;
  if (i.hoursLeft <= 0) return 1;
  const need = i.unitsAhead + i.units;
  return Math.round(nbCdf(i.velocity * i.hoursLeft * lift, need - 1) * 1000) / 1000;
}

export type ExpiryActionKind = 'NONE' | 'VISIBLE' | 'MARKDOWN' | 'DONATE';

export interface ExpiryAdvice {
  action: ExpiryActionKind;
  pct?: number;
  risk: number;
  /** 采取这个办法后的风险 */
  riskAfter?: number;
  /** 预计到期时还剩几件（不处理） */
  leftover: number;
}

/** 预计到期时这一批还剩几件：min(这一批, E[max(0, 前面 + 这一批 − 需求)])，需求按负二项 */
export function expectedLeftover(i: LotRiskInput, lift = 1): number {
  if (i.units <= 0) return 0;
  const mean = i.velocity * Math.max(0, i.hoursLeft) * lift;
  const need = i.unitsAhead + i.units;
  if (mean <= 0) return i.units;
  const k = EXPIRY_K;
  const p = k / (k + mean);
  let pmf = Math.pow(p, k);
  let e = need * pmf;
  for (let d = 1; d < need; d++) {
    pmf *= ((d - 1 + k) / d) * (1 - p);
    e += (need - d) * pmf;
  }
  return Math.min(i.units, e);
}

/**
 * 怎么处理：比较不处理、降 20%、降 40% 的预计损失（到期剩下的件数 × 进价 + 降价让掉的钱），取最小的；
 * 中等风险、离到期还有两天以上时先移到显眼位置（不花钱）；到期前一天降 40% 也还会剩不少的，建议捐赠。
 * econ：售价和进价（没有时按售价 1、进价 0.65，只比较相对大小）。
 */
export function expiryAdvice(i: LotRiskInput, econ: { price: number; cost: number } = { price: 1, cost: 0.65 }): ExpiryAdvice {
  const risk = lotRisk(i);
  const left0 = expectedLeftover(i);
  const leftover = Math.round(left0 * 10) / 10;
  if (risk < 0.25 || left0 < 1) return { action: 'NONE', risk, leftover };
  const loss = (pct: number) => {
    const lift = pct === 0 ? 1 : (MARKDOWN_LIFT[String(pct)] as number);
    const left = expectedLeftover(i, lift);
    return left * econ.cost + pct * econ.price * (i.units - left);
  };
  const best = [0, 0.2, 0.4].map((pct) => ({ pct, loss: loss(pct) })).sort((a, b) => a.loss - b.loss)[0] as { pct: number; loss: number };
  // 到期前一天：降到 40% 也还会剩三成以上（至少 3 件）的，捐赠
  if (i.hoursLeft <= 24) {
    const left40 = expectedLeftover(i, MARKDOWN_LIFT['0.4']);
    if (left40 >= Math.max(3, i.units * 0.3)) return { action: 'DONATE', risk, riskAfter: lotRisk(i, MARKDOWN_LIFT['0.4']), leftover };
  }
  if (best.pct > 0 && best.loss < loss(0) - econ.cost) return { action: 'MARKDOWN', pct: best.pct, risk, riskAfter: lotRisk(i, MARKDOWN_LIFT[String(best.pct)]), leftover };
  if (i.hoursLeft >= 48) return { action: 'VISIBLE', risk, riskAfter: lotRisk(i, VISIBLE_LIFT), leftover };
  return { action: 'NONE', risk, leftover };
}

export type MarkdownPolicy = 'none' | 'rule' | 'model';
export const MARKDOWN_POLICIES: readonly MarkdownPolicy[] = ['none', 'rule', 'model'];

function rngOf(seed: number): () => number {
  let x = (seed * 2654435761 + 7) % 4294967296;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function poisson(rnd: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 40) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * (Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd()))));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rnd();
  } while (p > L);
  return k - 1;
}

/**
 * 仿真评估：items 件商品、days 天，按天推进。每件商品：日均速度（对数正态）、保质期 3–14 天、每 2–5 天到一批（按预测的量 ± 20%）、
 * 需求有天与天之间的波动（伽马混合泊松）。每天先处理（按策略降价、移位、捐赠），再卖（先进先出），到期没卖完的报废。
 */
export function evaluateMarkdown(seed = 1, items = 80, days = 60): Record<MarkdownPolicy, { wasteUnits: number; wasteValue: number; markdownLoss: number; donatedUnits: number; lostSales: number; totalLoss: number }> {
  const out = {} as Record<MarkdownPolicy, { wasteUnits: number; wasteValue: number; markdownLoss: number; donatedUnits: number; lostSales: number; totalLoss: number }>;
  for (const policy of MARKDOWN_POLICIES) {
    // 同一个种子：三种策略面对完全相同的商品和需求（公共随机数）
    const rnd = rngOf(seed);
    let wasteUnits = 0;
    let wasteValue = 0;
    let markdownLoss = 0;
    let donatedUnits = 0;
    let lostSales = 0;
    for (let it = 0; it < items; it++) {
      const perDay = Math.exp(Math.log(6) + 0.8 * (Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd())));
      const life = 3 + Math.floor(rnd() * 12);
      const every = 2 + Math.floor(rnd() * 4);
      const price = 2 + rnd() * 8;
      const cost = price * 0.65;
      const lots: Array<{ units: number; expires: number; pct: number; visible: boolean }> = [];
      for (let d = 0; d < days; d++) {
        if (d % every === 0) lots.push({ units: Math.max(1, Math.round(perDay * every * (0.95 + rnd() * 0.45))), expires: d + life, pct: 0, visible: false });
        lots.sort((a, b) => a.expires - b.expires);
        // 处理
        let ahead = 0;
        for (const l of lots) {
          const hoursLeft = (l.expires - d) * 24;
          if (policy === 'rule' && l.expires - d <= 1 && l.pct < 0.3) l.pct = 0.3;
          if (policy === 'model') {
            const a = expiryAdvice({ unitsAhead: ahead, units: l.units, hoursLeft, velocity: perDay / 24 }, { price, cost });
            if (a.action === 'MARKDOWN' && (a.pct ?? 0) > l.pct) l.pct = a.pct as number;
            else if (a.action === 'VISIBLE') l.visible = true;
            else if (a.action === 'DONATE') {
              donatedUnits += l.units;
              wasteValue += l.units * cost * 0.5;
              l.units = 0;
            }
          }
          ahead += l.units;
        }
        // 卖：一天的需求，按到期先后从各批扣；降价、显眼位置提高需求
        const top = lots.find((l) => l.units > 0);
        const lift = top ? (top.pct >= 0.4 ? (MARKDOWN_LIFT['0.4'] as number) : top.pct >= 0.3 ? 2 : top.pct >= 0.2 ? (MARKDOWN_LIFT['0.2'] as number) : 1) * (top.visible ? VISIBLE_LIFT : 1) : 1;
        const gamma = -Math.log(Math.max(1e-12, rnd() * rnd() * rnd() * rnd())) / 4;
        let demand = poisson(rnd, perDay * gamma * lift);
        for (const l of lots) {
          if (demand <= 0) break;
          const take = Math.min(l.units, demand);
          l.units -= take;
          demand -= take;
          markdownLoss += take * price * l.pct;
        }
        lostSales += demand;
        // 到期没卖完的报废
        for (const l of lots) if (l.expires <= d + 1 && l.units > 0) {
          wasteUnits += l.units;
          wasteValue += l.units * cost;
          l.units = 0;
        }
        for (let i = lots.length - 1; i >= 0; i--) if ((lots[i] as { units: number }).units <= 0) lots.splice(i, 1);
      }
    }
    const r = (v: number) => Math.round(v);
    out[policy] = { wasteUnits: r(wasteUnits), wasteValue: r(wasteValue), markdownLoss: r(markdownLoss), donatedUnits: r(donatedUnits), lostSales: r(lostSales), totalLoss: r(wasteValue + markdownLoss) };
  }
  return out;
}
