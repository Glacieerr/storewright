import { createRng, type Rng } from '@storewright/domain';
import { needsReplenishment, replenishPriority, suggestedUnits, DEFAULT_REPLENISH_RULES, type PlanogramEntry, type ReplenishRules } from '@storewright/algorithms';

/**
 * 货架存量模块（Phase 4，默认关闭）：让「货架上有没有」由存量决定，而不是按概率抽取。
 *
 * - 每个商品在它的主货位有一个存量；开门时按平均填充率补货（少数商品开门就偏空，代表夜班没补完）；
 * - 店内销售按商品热度和到店客流的时段曲线生成（泊松到达）；货架空了时顾客买不到（记为少卖）；
 * - 线上拣货从同一货位扣减；拣货员遇到空货位 → 拣货端报告缺货 → 后仓有货时转后仓补取（Exception）；
 * - 补货任务：货架空了或预计售罄时间过短、后仓有货时生成；后仓补取找到后也生成（决策 X-04）；
 *   由后仓补取员在空闲时执行：去后仓取一箱 → 到货位上架；
 * - 存量是时间的函数：每个商品记录「销售 / 拣货 / 补货」事件，查询某一时刻的存量时按时间顺序重放（空了不会变成负数）。
 *
 * 全部按种子可复现。只有 simulateDay 传入本模块时才生效，Phase 1 的结果不受影响。
 */

export interface ShelfStockOptions {
  planogram: readonly PlanogramEntry[];
  /** 营业时间（仿真秒） */
  open: number;
  close: number;
  seed: number;
  /** 开门时的平均填充率 */
  openFill?: number;
  /** 开门时就偏空的商品比例 */
  lowShare?: number;
  /** 后仓库存（件）：商品 → 件数 */
  backroom: ReadonlyMap<string, number>;
  rules?: ReplenishRules;
  /** 店内销售的倍数（相对陈列表的预期销售速度） */
  demandScale?: number;
  /** 手动请求的补货（模拟器里点击货架）：商品与时刻 */
  requests?: ReadonlyArray<{ itemId: string; t: number }>;
}

type Kind = 'S' | 'P' | 'R';
interface Ev {
  t: number;
  qty: number;
  kind: Kind;
}

/** 到店客流的时段曲线（按营业时间内的相对时刻） */
function hourly(t: number, open: number, close: number): number {
  const x = (t - open) / Math.max(1, close - open);
  // 中午和傍晚两个高峰
  return 0.55 + 0.55 * Math.exp(-((x - 0.35) ** 2) / 0.012) + 0.8 * Math.exp(-((x - 0.72) ** 2) / 0.01);
}

export interface ShelfChange {
  t: number;
  /** 货架段：`${runId}|${bay}` */
  bay: string;
  /** 该段所有商品的平均填充率（0–1） */
  fill: number;
  /** 该段空了的商品数 */
  empty: number;
}

export interface ShelfReport {
  /** 店内顾客因为货架空了少买的件数 */
  lostSalesUnits: number;
  soldUnits: number;
  /** 曾经空过的商品数 */
  itemsEmptied: number;
  /** 补货完成次数与件数 */
  restocks: number;
  restockedUnits: number;
  /** 从货架空到补回来的平均分钟数（当天补回来的） */
  avgEmptyMin: number;
  /** 关门时仍然空着的商品数 */
  emptyAtClose: number;
  /** 每 15 分钟的空货架商品数 */
  emptyCurve: Array<[number, number]>;
  /** 货架段存量变化（场景着色用） */
  changes: ShelfChange[];
  /** 开门时每个货架段的填充率与空商品数 */
  initial: Record<string, { fill: number; empty: number }>;
}

export class ShelfStock {
  readonly rules: ReplenishRules;
  private readonly entries = new Map<string, PlanogramEntry>();
  private readonly initial = new Map<string, number>();
  private readonly events = new Map<string, Ev[]>();
  private readonly backroomUnits = new Map<string, number>();
  private readonly rng: Rng;
  restocks = 0;
  restockedUnits = 0;

  constructor(private readonly o: ShelfStockOptions) {
    this.rules = o.rules ?? DEFAULT_REPLENISH_RULES;
    this.rng = createRng(o.seed);
    const fill = o.openFill ?? 0.85;
    const low = o.lowShare ?? 0.04;
    const scale = o.demandScale ?? 1;
    for (const p of o.planogram) {
      this.entries.set(p.itemId, p);
      const r = this.rng.next();
      const f = r < low ? this.rng.uniform(0, 0.2) : Math.min(1, Math.max(0.3, fill + this.rng.normal(0, 0.12)));
      this.initial.set(p.itemId, Math.round(p.capacity * f));
      // 店内销售：非齐次泊松过程（按时段曲线稀疏化）
      const peak = p.baseVelocity * scale * 1.9;
      const list: Ev[] = [];
      if (peak > 0) {
        let t = o.open;
        for (;;) {
          t += this.rng.exponential(peak / 3600);
          if (t >= o.close) break;
          if (this.rng.next() * 1.9 <= hourly(t, o.open, o.close)) list.push({ t, qty: 1, kind: 'S' });
        }
      }
      this.events.set(p.itemId, list);
      this.backroomUnits.set(p.itemId, o.backroom.get(p.itemId) ?? 0);
    }
  }

  get requests(): ReadonlyArray<{ itemId: string; t: number }> {
    return this.o.requests ?? [];
  }

  entry(itemId: string): PlanogramEntry | undefined {
    return this.entries.get(itemId);
  }

  /** 某一时刻的货架存量（按时间顺序重放，空了不再减少） */
  level(itemId: string, t: number): number {
    const p = this.entries.get(itemId);
    if (!p) return Number.POSITIVE_INFINITY;
    let lvl = this.initial.get(itemId) ?? 0;
    for (const e of this.events.get(itemId) ?? []) {
      if (e.t > t) break;
      lvl = e.kind === 'R' ? Math.min(p.capacity, lvl + e.qty) : Math.max(0, lvl - e.qty);
    }
    return lvl;
  }

  private insert(itemId: string, e: Ev): void {
    const list = this.events.get(itemId);
    if (!list) return;
    let i = list.length;
    while (i > 0 && (list[i - 1] as Ev).t > e.t) i--;
    list.splice(i, 0, e);
  }

  /** 线上拣货：货架上够就扣减并返回 true，不够返回 false（拣货员报告找不到） */
  pick(itemId: string, qty: number, t: number): boolean {
    if (!this.entries.has(itemId)) return true;
    if (this.level(itemId, t) < qty) return false;
    this.insert(itemId, { t, qty, kind: 'P' });
    return true;
  }

  backroom(itemId: string): number {
    return this.backroomUnits.get(itemId) ?? 0;
  }

  /** 从后仓取件（Exception 或补货），返回实际取到的件数 */
  takeBackroom(itemId: string, units: number): number {
    const have = this.backroom(itemId);
    const n = Math.max(0, Math.min(have, units));
    this.backroomUnits.set(itemId, have - n);
    return n;
  }

  /** 补货上架：从后仓取一箱，最多补到满；返回上架件数 */
  restock(itemId: string, t: number): number {
    const p = this.entries.get(itemId);
    if (!p) return 0;
    const room = p.capacity - this.level(itemId, t);
    const units = this.takeBackroom(itemId, Math.min(room, p.packQty));
    if (units > 0) {
      this.insert(itemId, { t, qty: units, kind: 'R' });
      this.restocks += 1;
      this.restockedUnits += units;
    }
    return units;
  }

  /** 是否需要补货（后仓有货时） */
  needs(itemId: string, t: number): boolean {
    const p = this.entries.get(itemId);
    if (!p || this.backroom(itemId) <= 0) return false;
    return needsReplenishment({ est: this.level(itemId, t), capacity: p.capacity, velocityPerHour: p.baseVelocity * hourly(t, this.o.open, this.o.close), onlineDemand: 0 }, this.rules);
  }

  priority(itemId: string, t: number): number {
    const p = this.entries.get(itemId);
    if (!p) return Number.POSITIVE_INFINITY;
    return replenishPriority({ est: this.level(itemId, t), capacity: p.capacity, velocityPerHour: p.baseVelocity, onlineDemand: 0, unitPrice: p.unitPrice });
  }

  suggested(itemId: string, t: number): number {
    const p = this.entries.get(itemId);
    return p ? suggestedUnits({ est: this.level(itemId, t), capacity: p.capacity }) : 0;
  }

  /** 需要补货的商品（扫描全部陈列表） */
  lowItems(t: number): string[] {
    const out: string[] = [];
    for (const id of this.entries.keys()) if (this.needs(id, t)) out.push(id);
    return out;
  }

  /** 当天结束后汇总：少卖、空货架、补货，以及每个货架段的存量变化 */
  report(): ShelfReport {
    const { open, close } = this.o;
    const bayOf = (p: PlanogramEntry) => {
      const m = /^(.*)-[LRW](\d+)-\d+$/.exec(p.locationId);
      return m ? `${m[1]}|${Number(m[2]) - 1}` : p.runId;
    };
    let lost = 0;
    let sold = 0;
    let emptied = 0;
    let emptyAtClose = 0;
    const gaps: number[] = [];
    const bays = new Map<string, Array<{ id: string; cap: number }>>();
    const steps: Array<{ t: number; id: string; lvl: number }> = [];
    const levelsAt = new Map<string, number>();
    const emptyTimes: Array<[number, number]> = [];
    for (const [id, p] of this.entries) {
      const b = bayOf(p);
      const list = bays.get(b) ?? [];
      list.push({ id, cap: p.capacity });
      bays.set(b, list);
      let lvl = this.initial.get(id) ?? 0;
      levelsAt.set(id, lvl);
      let emptySince: number | undefined = lvl === 0 ? open : undefined;
      let wasEmpty = lvl === 0;
      if (wasEmpty) emptied++;
      for (const e of this.events.get(id) ?? []) {
        if (e.kind === 'R') lvl = Math.min(p.capacity, lvl + e.qty);
        else if (lvl === 0) {
          if (e.kind === 'S') lost += e.qty;
          continue;
        } else {
          const take = Math.min(lvl, e.qty);
          if (e.kind === 'S') {
            sold += take;
            lost += e.qty - take;
          }
          lvl -= take;
        }
        steps.push({ t: e.t, id, lvl });
        if (lvl === 0 && emptySince === undefined) {
          emptySince = e.t;
          if (!wasEmpty) emptied++;
          wasEmpty = true;
        } else if (lvl > 0 && emptySince !== undefined) {
          gaps.push(e.t - emptySince);
          emptyTimes.push([emptySince, e.t]);
          emptySince = undefined;
        }
      }
      if (emptySince !== undefined) {
        emptyAtClose++;
        emptyTimes.push([emptySince, close]);
      }
    }
    // 货架段的平均填充率随时间变化
    steps.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    const bayOfItem = new Map<string, string>();
    for (const [b, list] of bays) for (const x of list) bayOfItem.set(x.id, b);
    const bayState = new Map<string, { sum: number; empty: number }>();
    const initial: Record<string, { fill: number; empty: number }> = {};
    for (const [b, list] of bays) {
      let sum = 0;
      let empty = 0;
      for (const x of list) {
        const l = levelsAt.get(x.id) ?? 0;
        sum += x.cap ? l / x.cap : 0;
        if (l === 0) empty++;
      }
      bayState.set(b, { sum, empty });
      initial[b] = { fill: sum / list.length, empty };
    }
    const changes: ShelfChange[] = [];
    for (const st of steps) {
      const b = bayOfItem.get(st.id) as string;
      const list = bays.get(b) as Array<{ id: string; cap: number }>;
      const cap = this.entries.get(st.id)?.capacity ?? 1;
      const prev = levelsAt.get(st.id) ?? 0;
      const agg = bayState.get(b) as { sum: number; empty: number };
      agg.sum += (st.lvl - prev) / cap;
      agg.empty += (st.lvl === 0 ? 1 : 0) - (prev === 0 ? 1 : 0);
      levelsAt.set(st.id, st.lvl);
      changes.push({ t: st.t, bay: b, fill: Math.max(0, agg.sum / list.length), empty: agg.empty });
    }
    // 每 15 分钟的空货架商品数
    const emptyCurve: Array<[number, number]> = [];
    for (let t = open; t <= close; t += 900) emptyCurve.push([t, emptyTimes.filter(([a, b]) => a <= t && b > t).length]);
    return {
      lostSalesUnits: lost,
      soldUnits: sold,
      itemsEmptied: emptied,
      restocks: this.restocks,
      restockedUnits: this.restockedUnits,
      avgEmptyMin: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 60) : 0,
      emptyAtClose,
      emptyCurve,
      changes,
      initial,
    };
  }
}
