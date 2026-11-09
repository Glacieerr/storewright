import type { Km } from '../region/region';
import { NODES } from '../region/region';
import { attach, Distances, type NetPoint } from './graph';
import { capacityOf, fixedCost, inboundPerSize, inventoryCost, NET, outboundPerDay, palletsOf, servicePenaltyPerDay, type NetParams } from './model';
import { routeSite, type Trip } from './route';
import type { NetSite, NetStore } from './sites';

/**
 * 选址和分配：在候选仓里选开哪几个（物流园一直开着，可以扩建），每家店由哪个仓送。
 *
 * 目标是每年的总成本最低：固定成本 + 每家店分到某个仓的可加成本（外送估算、处理、进仓或转运、时效）
 * + 超出能力的部分交第三方仓 + 安全库存（按各配送中心的货量占比，平方根定律）。
 * 解法：把「开哪几个仓」全部枚举一遍（候选只有几个），每种组合里用分支定界给每家店挑仓（一家店只由一个仓送）——
 * 下界 = 已经分好的成本 + 没分的店各自最便宜的选择 + 已经超出的能力（只会更多）+ 库存的下限（全在一个仓），
 * 下界不比当前最好的方案低就剪掉，所以结果是精确的最优解。测试里和穷举对过。
 */
export interface Instance {
  stores: NetStore[];
  sites: NetSite[];
  params: NetParams;
  d: Distances;
  pallets: number[];
  /** [店][仓]：每年的可加成本 */
  cost: number[][];
  /** 每年的固定成本：每个仓（物流园是现有的运营费）、扩建 */
  fixed: number[];
  expandFixed: number;
  /** 进仓：规模 1 的店的货每天进每个仓（中转仓按物流园 + 转运）的运费 */
  inbound: number[];
  /** 物流园 → 中转仓的转运：每托的运费 */
  shuttle: number[];
  totalSize: number;
}

export interface Choice {
  /** 开着的候选仓（下标，0 是物流园）、是否扩建 */
  open: number[];
  expanded: boolean;
  /** 每家店由哪个仓送（仓的下标） */
  assign: number[];
  /** 选址模型里的总成本（每年） */
  objective: number;
  /** 分支定界走过的节点数、这个结果是不是在节点上限以内算完的 */
  nodes: number;
  exact: boolean;
}

export const gateways = (d: Distances): Record<'PORT' | 'AIR' | 'NORTH' | 'EAST' | 'DC', NetPoint> => {
  const g = d.g;
  const mk = (k: string) => attach(g, `gate-${k}`, NODES[k] as Km, { node: k, linkKm: 0 });
  return { PORT: mk('PORT'), AIR: mk('AIR'), NORTH: mk('NORTH'), EAST: mk('EAST'), DC: mk('DC') };
};

export function buildInstance(d: Distances, stores: NetStore[], sites: NetSite[], params: NetParams): Instance {
  const pallets = stores.map((s) => palletsOf(s, params));
  const gate = gateways(d);
  const park = sites[0] as NetSite;
  const fr = params.freight;
  const inbound = sites.map((s) => (s.kind === 'xd' ? inboundPerSize(d, park, gate) : inboundPerSize(d, s, gate)) * fr);
  const shuttle = sites.map((s) => (s.kind === 'xd' ? d.leg(park.point, s.point).km * NET.shuttlePerPalletKm * fr : 0));
  const cost = stores.map((st, i) =>
    sites.map((s, k) => {
      const p = pallets[i] as number;
      const leg = d.leg(s.point, st.point);
      const perDay =
        outboundPerDay(leg, p, params) +
        p * (NET.handling[s.kind] + (s.kind === 'xd' ? NET.handling.park : 0)) +
        st.size * params.growth * (inbound[k] as number) +
        p * (shuttle[k] as number) +
        servicePenaltyPerDay(leg.hours, p);
      return perDay * NET.days;
    }),
  );
  return { stores, sites, params, d, pallets, cost, fixed: sites.map((s) => fixedCost(s)), expandFixed: fixedCost('expand'), inbound, shuttle, totalSize: stores.reduce((a, s) => a + s.size, 0) };
}

/** 每个仓的出货量（中转仓的货也在物流园拣，算进物流园）、中转仓的转运量 */
function loads(inst: Instance, assign: readonly number[]): { load: number[]; through: number[] } {
  const load = inst.sites.map(() => 0);
  const through = inst.sites.map(() => 0);
  assign.forEach((k, i) => {
    const p = inst.pallets[i] as number;
    if (k < 0) return;
    if (inst.sites[k]?.kind === 'xd') {
      through[k] = (through[k] as number) + p;
      load[0] = (load[0] as number) + p;
    } else load[k] = (load[k] as number) + p;
  });
  return { load, through };
}

/** 超出能力的部分每年交第三方仓的钱 */
function overflow(inst: Instance, assign: readonly number[], expanded: boolean): number {
  const { load, through } = loads(inst, assign);
  let over = 0;
  inst.sites.forEach((s, k) => {
    const cap = capacityOf(s, expanded);
    over += Math.max(0, (s.kind === 'xd' ? (through[k] as number) : (load[k] as number)) - cap);
  });
  return over * NET.overflowPerPallet * NET.days;
}

function inventory(inst: Instance, assign: readonly number[]): number {
  const { load } = loads(inst, assign);
  const total = load.reduce((a, b) => a + b, 0) || 1;
  const shares = inst.sites.map((s, k) => (s.kind === 'xd' ? 0 : (load[k] as number) / total)).filter((x) => x > 0);
  return inventoryCost(shares, inst.params, inst.totalSize);
}

/** 一个完整方案在选址模型里的总成本 */
export function objective(inst: Instance, open: readonly number[], expanded: boolean, assign: readonly number[]): number {
  let c = (inst.fixed[0] as number) + (expanded ? inst.expandFixed : 0);
  for (const k of open) if (k > 0) c += inst.fixed[k] as number;
  assign.forEach((k, i) => (c += (inst.cost[i] as number[])[k] as number));
  return c + overflow(inst, assign, expanded) + inventory(inst, assign);
}

export interface SolveOpts {
  /** 必须开 / 不许开的候选（位：1 << (下标 − 1)；扩建是最高一位） */
  require?: number;
  forbid?: number;
  nodeLimit?: number;
}

/** 一种开仓组合（位掩码）下开着的仓和是否扩建 */
export function openOf(inst: Instance, mask: number): { open: number[]; expanded: boolean } {
  const m = inst.sites.length - 1;
  return { open: [0, ...Array.from({ length: m }, (_, k) => k + 1).filter((k) => mask & (1 << (k - 1)))], expanded: (mask & (1 << m)) !== 0 };
}

/** 能考虑的开仓组合（物流园不让扩建时去掉扩建），开的仓少的排前面 */
export function masksOf(inst: Instance, opts: SolveOpts = {}): number[] {
  const m = inst.sites.length - 1;
  const forbid = (opts.forbid ?? 0) | (inst.params.allowExpand ? 0 : 1 << m);
  const require = opts.require ?? 0;
  return Array.from({ length: 1 << (m + 1) }, (_, i) => i)
    .filter((mask) => (mask & require) === require && (mask & forbid) === 0)
    .sort((a, b) => popcount(a) - popcount(b) || a - b);
}

/**
 * 一种开仓组合下最好的分配（分支定界，精确）。incumbent = 已知的最好成本（别的组合的），
 * 这个组合怎么分都不比它好时返回 undefined。
 */
export function bestForMask(inst: Instance, mask: number, incumbent = Infinity, limit = 4_000_000): (Choice & { exact: boolean }) | undefined {
  const { open, expanded } = openOf(inst, mask);
  const n = inst.stores.length;
  const invLow = inventoryCost([1], inst.params, inst.totalSize);
  const fixed = (inst.fixed[0] as number) + (expanded ? inst.expandFixed : 0) + open.slice(1).reduce((a, k) => a + (inst.fixed[k] as number), 0);
  const minCost = inst.cost.map((row) => Math.min(...open.map((k) => row[k] as number)));
  if (fixed + minCost.reduce((a, b) => a + b, 0) + invLow >= incumbent - 1e-6) return undefined;
  let best: Choice | undefined;
  let bestObj = incumbent;
  let nodes = 0;
  let exact = true;
  // 先用一个好的方案开头（每家店先分给最便宜的仓，再一家一家挪，挪了更省就挪），后面剪得狠
  {
    const assign0 = inst.cost.map((row) => open.reduce((b, k) => ((row[k] as number) < (row[b] as number) ? k : b), open[0] as number));
    let obj0 = objective(inst, open, expanded, assign0);
    for (let improved = true, it = 0; improved && it < 50; it++) {
      improved = false;
      for (let i = 0; i < n; i++)
        for (const k of open) {
          if (assign0[i] === k) continue;
          const was = assign0[i] as number;
          assign0[i] = k;
          const o = objective(inst, open, expanded, assign0);
          if (o < obj0 - 1e-6) {
            obj0 = o;
            improved = true;
          } else assign0[i] = was;
        }
    }
    if (obj0 < bestObj - 1e-9) {
      bestObj = obj0;
      best = { open, expanded, assign: assign0, objective: obj0, nodes: 0, exact: true };
    }
  }
  // 店的顺序：各仓差得多的先定（定错了代价大，剪得早）
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => regret(inst.cost[b] as number[], open) - regret(inst.cost[a] as number[], open) || a - b);
  const rest = new Array<number>(n + 1).fill(0);
  for (let j = n - 1; j >= 0; j--) rest[j] = (rest[j + 1] as number) + (minCost[order[j] as number] as number);
  const assign = new Array<number>(n).fill(-1);
  // 出货量随分配一起增减（中转仓的货算进物流园），超出能力的部分只会越分越多，是合法的下界
  const caps = inst.sites.map((s) => capacityOf(s, expanded));
  const isXd = inst.sites.map((s) => s.kind === 'xd');
  const load = new Float64Array(inst.sites.length);
  const through = new Float64Array(inst.sites.length);
  // 剩下没分的店的货最多先填满各配送中心的空余（中转仓的货也在物流园拣，不添能力），填不下的一定超出
  const remain = new Array<number>(n + 1).fill(0);
  for (let j = n - 1; j >= 0; j--) remain[j] = (remain[j + 1] as number) + (inst.pallets[order[j] as number] as number);
  let left = 0;
  const over = () => {
    let o = 0;
    let slack = 0;
    for (let k = 0; k < caps.length; k++) {
      const used = isXd[k] ? (through[k] as number) : (load[k] as number);
      o += Math.max(0, used - (caps[k] as number));
      if (!isXd[k] && open.includes(k)) slack += Math.max(0, (caps[k] as number) - used);
    }
    return (o + Math.max(0, left - slack)) * NET.overflowPerPallet * NET.days;
  };
  // 库存：各配送中心货量占比的平方根之和是凹的，剩下的货全放进一个配送中心时最小——这就是给定已分部分的下界
  const total = remain[0] as number;
  const fullDc = open.filter((k) => !isXd[k]);
  const invUnit = invLow;
  const inv = () => {
    if (total <= 0) return invUnit;
    // 加了又减的出货量可能是 −1e-14 这样的负数：开方前截到 0
    let sum = 0;
    for (const k of fullDc) sum += Math.sqrt(Math.max(0, load[k] as number) / total);
    let low = Infinity;
    for (const k of fullDc) {
      const lk = Math.max(0, load[k] as number);
      const v = sum - Math.sqrt(lk / total) + Math.sqrt((lk + left) / total);
      if (v < low) low = v;
    }
    return invUnit * (Number.isFinite(low) ? low : 1);
  };
  const step = (j: number, partial: number) => {
    if (nodes > limit) {
      exact = false;
      return;
    }
    nodes++;
    if (j === n) {
      const obj = objective(inst, open, expanded, assign);
      if (obj < bestObj - 1e-9) {
        bestObj = obj;
        best = { open, expanded, assign: [...assign], objective: obj, nodes: 0, exact: true };
      }
      return;
    }
    const i = order[j] as number;
    const row = inst.cost[i] as number[];
    const p = inst.pallets[i] as number;
    for (const k of [...open].sort((a, b) => (row[a] as number) - (row[b] as number))) {
      assign[i] = k;
      if (isXd[k]) {
        through[k] = (through[k] as number) + p;
        load[0] = (load[0] as number) + p;
      } else load[k] = (load[k] as number) + p;
      const part = partial + (row[k] as number);
      left = remain[j + 1] as number;
      if (fixed + part + (rest[j + 1] as number) + over() + inv() < bestObj - 1e-6) step(j + 1, part);
      if (isXd[k]) {
        through[k] = (through[k] as number) - p;
        load[0] = (load[0] as number) - p;
      } else load[k] = (load[k] as number) - p;
      assign[i] = -1;
    }
  };
  step(0, 0);
  return best ? { ...best, nodes, exact } : undefined;
}

/** 全局最优：枚举开仓组合，组合之间共用当前最好的成本剪枝 */
export function solve(inst: Instance, opts: SolveOpts = {}): Choice {
  let best: Choice | undefined;
  let nodes = 0;
  let exact = true;
  for (const mask of masksOf(inst, opts)) {
    const c = bestForMask(inst, mask, best?.objective ?? Infinity, opts.nodeLimit);
    if (!c) continue;
    nodes += c.nodes;
    exact &&= c.exact;
    if (!best || c.objective < best.objective - 1e-9) best = c;
  }
  if (!best) throw new Error('没有可行的方案');
  return { ...best, nodes, exact };
}

/** 每种开仓组合各自的最优分配（不在组合之间剪枝），用来按实际线路排名、解释为什么不选别的 */
export function solveEach(inst: Instance, opts: SolveOpts = {}): { mask: number; choice: Choice }[] {
  return masksOf(inst, opts).map((mask) => ({ mask, choice: bestForMask(inst, mask, Infinity, opts.nodeLimit) as Choice }));
}

/** 穷举（只给测试用）：每种开仓组合 × 每家店的每种分法 */
export function bruteForce(inst: Instance, opts: SolveOpts = {}): Choice {
  const m = inst.sites.length - 1;
  const EXP = 1 << m;
  const forbid = (opts.forbid ?? 0) | (inst.params.allowExpand ? 0 : EXP);
  const require = opts.require ?? 0;
  const n = inst.stores.length;
  let best: Choice | undefined;
  for (let mask = 0; mask < 1 << (m + 1); mask++) {
    if ((mask & require) !== require || (mask & forbid) !== 0) continue;
    const open = [0, ...Array.from({ length: m }, (_, k) => k + 1).filter((k) => mask & (1 << (k - 1)))];
    const expanded = (mask & EXP) !== 0;
    const assign = new Array<number>(n).fill(0);
    const total = open.length ** n;
    for (let code = 0; code < total; code++) {
      let c = code;
      for (let i = 0; i < n; i++) {
        assign[i] = open[c % open.length] as number;
        c = Math.floor(c / open.length);
      }
      const obj = objective(inst, open, expanded, assign);
      if (!best || obj < best.objective - 1e-9) best = { open, expanded, assign: [...assign], objective: obj, nodes: total, exact: true };
    }
  }
  return best as Choice;
}

const popcount = (x: number) => {
  let c = 0;
  for (let v = x; v; v &= v - 1) c++;
  return c;
};
function regret(row: readonly number[], open: readonly number[]): number {
  const v = open.map((k) => row[k] as number).sort((a, b) => a - b);
  return v.length > 1 ? (v[1] as number) - (v[0] as number) : 0;
}

// —————————————————— 按实际线路算一个方案 ——————————————————

export interface SiteUse {
  key: string;
  /** 出货量（托 / 天；物流园含中转仓的货）、能力、中转仓的转运量 */
  load: number;
  cap: number;
  through: number;
  stores: string[];
  trips: number;
  vehicles: number;
  km: number;
}
export interface Evaluation {
  open: string[];
  expanded: boolean;
  assign: Record<string, string>;
  /** 每年（美元） */
  costs: { fixed: number; handling: number; inbound: number; outbound: number; inventory: number; overflow: number; service: number; total: number };
  sites: SiteUse[];
  trips: Trip[];
  vehicles: number;
  kmDay: number;
  /** 超出能力交第三方仓的托数（每天） */
  overflowPallets: number;
  /** 门店离送货的仓的车程（小时）：平均（按托加权）、最远的那家 */
  avgHours: number;
  maxHours: { store: string; hours: number };
  /** 物流园 → 中转仓的转运线路（画图用） */
  shuttles: { site: string; pts: Km[]; pallets: number }[];
}

export function evaluate(inst: Instance, c: Pick<Choice, 'open' | 'expanded' | 'assign'>): Evaluation {
  const { sites, stores, d, params: p } = inst;
  const park = sites[0] as NetSite;
  const { load, through } = loads(inst, c.assign);
  const fixed = (inst.fixed[0] as number) + (c.expanded ? inst.expandFixed : 0) + c.open.filter((k) => k > 0).reduce((a, k) => a + (inst.fixed[k] as number), 0);
  let handling = 0;
  let inbound = 0;
  let service = 0;
  let wh = 0;
  let wp = 0;
  let maxHours = { store: '', hours: 0 };
  c.assign.forEach((k, i) => {
    const s = sites[k] as NetSite;
    const st = stores[i] as NetStore;
    const pal = inst.pallets[i] as number;
    handling += pal * (NET.handling[s.kind] + (s.kind === 'xd' ? NET.handling.park : 0));
    inbound += st.size * p.growth * (inst.inbound[k] as number) + pal * (inst.shuttle[k] as number);
    const h = d.leg(s.point, st.point).hours;
    service += servicePenaltyPerDay(h, pal);
    wh += h * pal;
    wp += pal;
    if (h > maxHours.hours) maxHours = { store: st.key, hours: h };
  });
  const trips: Trip[] = [];
  const uses: SiteUse[] = [];
  let outbound = 0;
  let vehicles = 0;
  let kmDay = 0;
  for (const k of c.open) {
    const s = sites[k] as NetSite;
    const mine = c.assign.map((kk, i) => (kk === k ? i : -1)).filter((i) => i >= 0);
    const r = routeSite(
      d,
      { key: s.key, point: s.point },
      mine.map((i) => ({ key: (stores[i] as NetStore).key, point: (stores[i] as NetStore).point, pallets: inst.pallets[i] as number })),
      p,
    );
    trips.push(...r.trips);
    outbound += r.cost;
    vehicles += r.vehicles;
    kmDay += r.km;
    uses.push({ key: s.key, load: s.kind === 'xd' ? (through[k] as number) : (load[k] as number), cap: capacityOf(s, c.expanded), through: through[k] as number, stores: mine.map((i) => (stores[i] as NetStore).key), trips: r.trips.length, vehicles: r.vehicles, km: r.km });
  }
  const shuttles = c.open
    .filter((k) => (sites[k] as NetSite).kind === 'xd' && (through[k] as number) > 0)
    .map((k) => ({ site: (sites[k] as NetSite).key, pts: d.leg(park.point, (sites[k] as NetSite).point).pts, pallets: through[k] as number }));
  let overflowPallets = 0;
  sites.forEach((s, k) => (overflowPallets += Math.max(0, (s.kind === 'xd' ? (through[k] as number) : (load[k] as number)) - capacityOf(s, c.expanded))));
  const costs = {
    fixed,
    handling: handling * NET.days,
    inbound: inbound * NET.days,
    outbound: outbound * NET.days,
    inventory: inventory(inst, c.assign),
    overflow: overflow(inst, c.assign, c.expanded),
    service: service * NET.days,
    total: 0,
  };
  costs.total = costs.fixed + costs.handling + costs.inbound + costs.outbound + costs.inventory + costs.overflow + costs.service;
  return {
    open: c.open.map((k) => (sites[k] as NetSite).key),
    expanded: c.expanded,
    assign: Object.fromEntries(c.assign.map((k, i) => [(stores[i] as NetStore).key, (sites[k] as NetSite).key])),
    costs,
    sites: uses,
    trips,
    vehicles,
    kmDay,
    overflowPallets,
    avgHours: wp ? wh / wp : 0,
    maxHours,
    shuttles,
  };
}
