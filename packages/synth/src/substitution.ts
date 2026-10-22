import { createRng, hashString, type Item } from '@storewright/domain';

/**
 * 合成替代记录（Phase 5c · 替代推荐）。
 *
 * 顾客是否接受一件替代品，取决于它和原商品的关系，以及顾客自己的偏好（模型看不到偏好类型）：
 * - 约 30% 的顾客忠于品牌：换品牌更容易被拒绝；
 * - 约 35% 的顾客对价格敏感：替代品更贵时更容易被拒绝；
 * - 买有机商品的顾客里约 60% 坚持有机：换成非有机几乎都会拒绝。
 * 记录方式与上线后一致：拣货员按现有规则选一件（60% 选第一，其余在前 5 个里随便选），顾客接受或拒绝。
 * 每条记录同时保存所有候选的真实接受概率，用来评估不同排序方法（只有仿真里知道）。全部为假设参数。
 */

export interface SubstitutionEvent {
  originalId: string;
  candidateIds: string[];
  shownId: string;
  accepted: boolean;
  /** 候选 → 这位顾客真实的接受概率 */
  trueP: Record<string, number>;
  customerType: { brandLoyal: boolean; priceSensitive: boolean; organicStrict: boolean };
}

/** 硬约束：同类别、同温区、年龄限制一致、不是同一件商品、名字不同 */
export function substituteCandidates(items: readonly Item[], o: Item): Item[] {
  const age = o.handling.includes('AGE_RESTRICTED');
  return items.filter((x) => x.id !== o.id && x.name !== o.name && x.categoryId === o.categoryId && x.tempZone === o.tempZone && x.handling.includes('AGE_RESTRICTED') === age);
}

/** 与员工端原来的候选排序相同：名称末尾相同的词越多越好，其次价格越接近 */
function ruleOrder(o: Item, cands: readonly Item[]): Item[] {
  const w = o.name.toLowerCase().split(/\s+/);
  const shared = (name: string) => {
    const v = name.toLowerCase().split(/\s+/);
    let n = 0;
    while (n < w.length && n < v.length && w[w.length - 1 - n] === v[v.length - 1 - n]) n++;
    return n;
  };
  return [...cands].sort((a, b) => shared(b.name) - shared(a.name) || Math.abs(a.unitPrice - o.unitPrice) - Math.abs(b.unitPrice - o.unitPrice) || a.id.localeCompare(b.id));
}

function trueAcceptance(o: Item, c: Item, t: SubstitutionEvent['customerType'], popRef: number, intercept: number): number {
  const a = o.attributes;
  const b = c.attributes;
  const ratio = c.unitPrice / Math.max(0.01, o.unitPrice);
  let u = intercept;
  if (a.stem === b.stem) u += 2.2;
  if (a.brand === b.brand) u += t.brandLoyal ? 1.8 : 0.4;
  else if (t.brandLoyal) u -= 0.6;
  if (a.flavor !== undefined && b.flavor !== undefined) u += a.flavor === b.flavor ? 0.9 : -1.1;
  if (a.size !== undefined && b.size !== undefined) u += a.size === b.size ? 0.6 : -0.8;
  if (a.organic === true && b.organic !== true) u -= t.organicStrict ? 3 : 0.8;
  const up = Math.max(0, Math.log(ratio));
  u -= up * (t.priceSensitive ? 4 : 1.5);
  u += Math.max(0, -Math.log(ratio)) * 0.4;
  u += 0.15 * Math.log(Math.max(c.popularity, 1e-6) / popRef);
  return 1 / (1 + Math.exp(-u));
}

export function generateSubstitutionEvents(items: readonly Item[], opts: { seed: number; events?: number; maxCandidates?: number }): SubstitutionEvent[] {
  const rng = createRng(hashString(`${opts.seed}:subs`));
  const grocery = items.filter((i) => i.fulfillmentType === 'GROCERY');
  const pops = grocery.map((i) => i.popularity).sort((a, b) => a - b);
  const popRef = pops[Math.floor(pops.length / 2)] ?? 1e-3;
  const pool = grocery.filter((o) => substituteCandidates(grocery, o).length >= 3);
  const weights = pool.map((o) => o.popularity);
  const out: SubstitutionEvent[] = [];
  const n = opts.events ?? 4000;
  for (let i = 0; i < n; i++) {
    const o = pool[rng.weightedIndex(weights)] as Item;
    const all = substituteCandidates(grocery, o);
    const cands = rng.shuffle([...all]).slice(0, opts.maxCandidates ?? 10);
    const type = { brandLoyal: rng.chance(0.3), priceSensitive: rng.chance(0.35), organicStrict: o.attributes.organic === true && rng.chance(0.6) };
    const intercept = rng.normal(-0.8, 0.6);
    const trueP: Record<string, number> = {};
    for (const c of cands) trueP[c.id] = Math.round(trueAcceptance(o, c, type, popRef, intercept) * 10000) / 10000;
    const ranked = ruleOrder(o, cands);
    const shown = rng.chance(0.6) ? (ranked[0] as Item) : (ranked[rng.int(0, Math.min(4, ranked.length - 1))] as Item);
    out.push({ originalId: o.id, candidateIds: cands.map((c) => c.id), shownId: shown.id, accepted: rng.chance(trueP[shown.id] as number), trueP, customerType: type });
  }
  return out;
}
