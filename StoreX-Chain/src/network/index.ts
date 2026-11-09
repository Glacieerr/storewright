import { Distances } from './graph';
import { capacityOf, DEFAULT_PARAMS, NET, type NetParams } from './model';
import { bestForMask, buildInstance, evaluate, masksOf, openOf, solve, type Choice, type Evaluation, type Instance } from './solve';
import { MAX_STORES, networkSites, type NetSite, type NetStore } from './sites';

export { allocate, ALLOC_FAMILIES, type Allocation } from './allocate';
export { DEFAULT_PARAMS, NET, type NetParams } from './model';
export { MAX_STORES, SITE_KIND_LABEL, STORE_KIND_LABEL, type NetSite, type NetStore } from './sites';
export type { Evaluation } from './solve';

/**
 * 多门店网络规划：在当前区域里放 N 家店，选开哪几个仓、每家店由哪个仓送、每个仓每天的线路和车。
 *
 * 1. 每种开仓组合都用分支定界求出最优的分配（选址模型，精确）；
 * 2. 每种组合的最优分配再按实际排出来的线路核算一遍（节约里程法 + 2-opt，车数按每天的时长装），按核算的总成本排名，取最低的；
 * 3. 和「今天的网络」（只有物流园、不扩建，超出能力的交第三方仓）比；对每个候选说明加上它 / 去掉它每年差多少。
 */
export interface NetOptions {
  n: number;
  /** 远郊镇离高速口多少公里 */
  outerKm: number;
  params: NetParams;
}
export const DEFAULT_OPTIONS: NetOptions = { n: 10, outerKm: 60, params: DEFAULT_PARAMS };
/**
 * 选址模型的成本比最优贵 5% 以上的组合不再按线路核算：按线路核算的第一名在选址模型里离最优从来不到 0.2%
 * （默认区域和两个随机区域、各种店数和需求，108 种情况里测的），翻不了身。
 */
const WINDOW = 0.05;

export interface Ranked {
  mask: number;
  choice: Choice;
  eval: Evaluation;
}
export interface Toggle {
  /** 候选仓的 key，扩建是 'expand' */
  key: string;
  name: string;
  chosen: boolean;
  /** 加上（没选的）或去掉（选了的）以后每年的总成本差（正 = 更贵）和分项的差 */
  delta: number;
  parts: Evaluation['costs'];
  /** 加上它的那个方案里划给它的店数（扩建不算） */
  used: number;
}
export interface NetPlan {
  options: NetOptions;
  /** 全部 12 个店址（前 n 个参与规划） */
  all: NetStore[];
  stores: NetStore[];
  sites: NetSite[];
  inst: Instance;
  best: Ranked;
  today: Ranked;
  /** 选址模型里成本最低的组合（和按线路核算的第一名一般是同一个） */
  modelBest: Ranked;
  ranked: Ranked[];
  toggles: Toggle[];
  explain: string[];
  /** 每天经仓的总托数 */
  pallets: number;
  ms: number;
  /** 只核算选址模型成本离最优不到 window（比例）的组合；一共有几种组合 */
  window: number;
  combos: number;
}

const wan = (x: number) => `${(x / 10_000).toLocaleString('en-US', { maximumFractionDigits: 0 })} 万美元`;
const PART_LABEL: Record<keyof Omit<Evaluation['costs'], 'total'>, string> = { fixed: '固定成本', handling: '仓内处理', inbound: '进仓运输', outbound: '外送', inventory: '安全库存', overflow: '第三方仓', service: '时效罚分' };

export function planNetwork(o: NetOptions = DEFAULT_OPTIONS): NetPlan {
  const t0 = performance.now();
  const d = new Distances();
  const { stores: all, sites } = networkSites(d.g, { outerKm: o.outerKm });
  const stores = all.slice(0, Math.max(1, Math.min(MAX_STORES, o.n, all.length)));
  const inst = buildInstance(d, stores, sites, o.params);
  // 先求选址模型的全局最优（组合之间共用剪枝，几毫秒）；离它不到 WINDOW 的组合各自求精确最优、按线路核算
  const top = solve(inst).objective;
  const ranked: Ranked[] = [];
  const byMask = new Map<number, Ranked>();
  const rank = (mask: number, choice: Choice) => {
    const r = { mask, choice, eval: evaluate(inst, choice) };
    ranked.push(r);
    byMask.set(mask, r);
    return r;
  };
  for (const mask of masksOf(inst)) {
    const c = mask === 0 ? bestForMask(inst, 0) : bestForMask(inst, mask, top * (1 + WINDOW));
    if (c) rank(mask, c);
  }
  ranked.sort((a, b) => a.eval.costs.total - b.eval.costs.total || a.mask - b.mask);
  const best = ranked[0] as Ranked;
  const modelBest = [...ranked].sort((a, b) => a.choice.objective - b.choice.objective || a.mask - b.mask)[0] as Ranked;
  const today = byMask.get(0) as Ranked;
  const m = sites.length - 1;
  const allowed = new Set(masksOf(inst));
  const toggles: Toggle[] = [];
  for (let b = 0; b <= m; b++) {
    const bit = 1 << b;
    const nb = best.mask ^ bit;
    if (!allowed.has(nb)) continue;
    // 建议方案的「邻居」（只差一个仓）要精确的结果来解释：剪掉了的补算
    let other = byMask.get(nb);
    if (!other) {
      const c = bestForMask(inst, nb);
      if (!c) continue;
      other = { mask: nb, choice: c, eval: evaluate(inst, c) };
      byMask.set(nb, other);
    }
    const isExp = b === m;
    const site = isExp ? undefined : (sites[b + 1] as NetSite);
    const parts = Object.fromEntries(Object.entries(other.eval.costs).map(([k, v]) => [k, v - best.eval.costs[k as keyof Evaluation['costs']]])) as Evaluation['costs'];
    const used = isExp ? 0 : Object.values(other.eval.assign).filter((k) => k === (site as NetSite).key).length;
    toggles.push({ key: isExp ? 'expand' : (site as NetSite).key, name: isExp ? `物流园扩建（+${NET.capacity.expand} 托 / 天）` : (site as NetSite).name, chosen: (best.mask & bit) !== 0, delta: parts.total, parts, used });
  }
  const pallets = inst.pallets.reduce((a, b) => a + b, 0);
  const plan: NetPlan = { options: o, all, stores, sites, inst, best, today, modelBest, ranked, toggles, explain: [], pallets, ms: 0, window: WINDOW, combos: allowed.size };
  plan.explain = explain(plan);
  plan.ms = performance.now() - t0;
  return plan;
}

/** 方案的名字：物流园 + 扩建 + 东高速口中转仓 */
export function planName(plan: Pick<NetPlan, 'sites'>, r: Ranked): string {
  const parts = r.choice.open.filter((k) => k > 0).map((k) => (plan.sites[k] as NetSite).short + ((plan.sites[k] as NetSite).kind === 'xd' ? '中转仓' : '配送中心'));
  return ['物流园' + (r.choice.expanded ? '（扩建）' : ''), ...parts].join(' + ');
}

function explain(p: NetPlan): string[] {
  const out: string[] = [];
  const { best, today } = p;
  const park = p.sites[0] as NetSite;
  const cap = capacityOf(park, false);
  out.push(`建议：${planName(p, best)}。`);
  out.push(`${p.stores.length} 家店每天要经过仓的货约 ${Math.round(p.pallets)} 托（长途整车直送门店的不算）；物流园现在每天能出 ${cap} 托${p.pallets > cap ? `，不够 ${Math.round(p.pallets - cap)} 托` : `，还有 ${Math.round(cap - p.pallets)} 托的余量`}${best.choice.expanded ? `，扩建后 ${capacityOf(park, true)} 托` : ''}。`);
  /** 分项的差（正 = 多花），取差得最多的几项 */
  const partsText = (a: Evaluation['costs'], b: Evaluation['costs'], verbUp: string, verbDown: string) =>
    (Object.keys(PART_LABEL) as (keyof typeof PART_LABEL)[])
      .map((k) => ({ k, d: a[k] - b[k] }))
      .filter((x) => Math.abs(x.d) >= 5_000)
      .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
      .slice(0, 3)
      .map((x) => `${PART_LABEL[x.k]}${x.d > 0 ? verbUp : verbDown} ${wan(Math.abs(x.d))}`)
      .join('，');
  const over = today.eval.overflowPallets > 0.5;
  if (best.mask === 0) out.push(over ? `只用物流园、每天超出的 ${Math.round(today.eval.overflowPallets)} 托交第三方仓最省：${p.options.params.allowExpand ? '扩建或者另开一个仓' : '另开一个仓（物流园没有扩建用地）'}，多出来的固定成本都比第三方仓的钱和省下的运输多。` : '只用物流园就是最省的：加任何一个仓，多出来的固定成本都比它省下的运输多。');
  else out.push(`比今天的网络（只有物流园${over ? `，每天超出的 ${Math.round(today.eval.overflowPallets)} 托交第三方仓` : ''}）每年省 ${wan(today.eval.costs.total - best.eval.costs.total)}：${partsText(today.eval.costs, best.eval.costs, '省', '多')}。`);
  const far = p.stores.find((s) => s.key === best.eval.maxHours.store);
  const farSite = far ? p.sites.find((s) => s.key === best.eval.assign[far.key]) : undefined;
  if (far && farSite) out.push(`最远的是${far.name}，离${farSite.short}约 ${best.eval.maxHours.hours.toFixed(1)} 小时车程${best.eval.maxHours.hours > NET.serviceHours ? '（超过 1 小时的部分按时效罚分算进了成本）' : ''}；${best.eval.vehicles} 辆车每天跑 ${Math.round(best.eval.kmDay).toLocaleString('en-US')} 公里。`);
  const zero = { fixed: 0, handling: 0, inbound: 0, outbound: 0, inventory: 0, overflow: 0, service: 0, total: 0 };
  for (const t of p.toggles.filter((x) => !x.chosen).sort((a, b) => a.delta - b.delta).slice(0, 2))
    out.push(t.key !== 'expand' && t.used === 0 ? `没选${t.name}：开了也没有店划给它（每家店都是现在的仓送更省），白多 ${wan(t.delta)}的固定成本。` : `没选${t.name}：加上它每年多 ${wan(t.delta)}（${partsText(t.parts, zero, '多', '省')}）。`);
  for (const t of p.toggles.filter((x) => x.chosen)) out.push(`选了${t.name}：去掉它每年多 ${wan(t.delta)}（${partsText(t.parts, zero, '多', '省')}）。`);
  if (p.modelBest.mask !== best.mask) out.push(`选址模型估算的第一名是「${planName(p, p.modelBest)}」，按实际排出的线路核算后「${planName(p, best)}」更省。`);
  return out;
}

export { masksOf, openOf };
