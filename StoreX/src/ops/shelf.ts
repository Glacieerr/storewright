import type { Rng } from '../core/rng';
import { TimeWeighted } from '../core/stats';
import type { Sim } from '../core/sim';
import { CATEGORY, type Catalog, type Sku } from '../world/catalog';
import type { Scenario } from '../world/config';
import { CLOSE, OPEN } from '../world/demand';
import type { Layout, Pt } from '../world/layout';
import type { Pool, Step } from './agents';
import type { Trace } from './trace';

/**
 * 货架：每个商品的地面库存。顾客和地面拣货员拿走商品；低于补货点后，
 * 只有「被发现」才会生成补货任务（上一代靠巡店和上报，本方案靠智能货架和盘点机器人）。
 */
export class Shelf {
  readonly stock: Int32Array;
  private readonly outSince: Float64Array;
  private readonly requested: Uint8Array;
  private readonly smart: Uint8Array;
  private readonly backroomOut: Uint8Array;
  readonly outCount: TimeWeighted;
  /** 营业时间内的缺货（商品 · 秒） */
  outageSec = 0;
  outages = 0;
  lostItems = 0;
  lostSales = 0;
  substitutions = 0;
  restocks = 0;
  restockUnits = 0;
  failedTrips = 0;
  /** 从缺货到补回来的时长（秒） */
  readonly recoverSec: number[] = [];
  /** 每 15 分钟的缺货商品数 */
  readonly outSeries: number[] = [];

  constructor(
    readonly sim: Sim,
    readonly catalog: Catalog,
    readonly scenario: Scenario,
    readonly layout: Layout,
    readonly trace: Trace,
    private readonly rng: Rng,
    private readonly crew: { stocker: Pool; amr?: Pool; scanner?: Pool },
  ) {
    const n = catalog.skus.length;
    this.stock = new Int32Array(n);
    this.outSince = new Float64Array(n).fill(NaN);
    this.requested = new Uint8Array(n);
    this.smart = new Uint8Array(n);
    this.backroomOut = new Uint8Array(n);
    const sh = scenario.shelf;
    // 智能货架：最热销的那部分商品 + 所有生鲜
    const ranked = [...catalog.skus].sort((a, b) => demandRate(catalog, b) - demandRate(catalog, a));
    const nSmart = Math.round(n * sh.smartShelfShare);
    ranked.forEach((s, i) => {
      if (i < nSmart || (sh.smartShelfShare > 0 && CATEGORY[s.category].shelfLifeDays !== undefined)) this.smart[s.id] = 1;
    });
    let out = 0;
    for (const s of catalog.skus) {
      const zero = rng.chance(sh.zeroAtOpen);
      const low = rng.chance(sh.lowShare);
      const fill = zero ? 0 : low ? 0.1 + 0.2 * rng.next() : Math.min(1, sh.openFill + rng.normal(0, 0.06));
      this.stock[s.id] = Math.max(0, Math.round(s.shelfCap * fill));
      if (rng.chance(sh.backroomOutRate)) this.backroomOut[s.id] = 1;
      if (this.stock[s.id] === 0) {
        this.outSince[s.id] = OPEN;
        out++;
      }
    }
    this.outCount = new TimeWeighted(OPEN, out);
    // 开门前的低库存：智能货架开门就报
    sim.at(OPEN, () => {
      for (const s of catalog.skus) if (this.isLow(s)) this.maybeSensor(s);
    });
    for (const t of sh.scanTimes) sim.at(t, () => this.scan());
    for (let t = OPEN; t <= CLOSE; t += 900) sim.at(t, () => this.outSeries.push(this.outCount.current));
  }

  /** 后仓有没有这个商品（补取前先看库存记录） */
  backroomHas(s: Sku): boolean {
    return !this.backroomOut[s.id];
  }

  private isLow(s: Sku): boolean {
    return (this.stock[s.id] as number) <= Math.floor(s.shelfCap * this.scenario.shelf.reorderFrac);
  }

  /** 拿走商品；返回实际拿到的件数 */
  take(s: Sku, qty: number, who: 'shopper' | 'picker'): number {
    const have = this.stock[s.id] as number;
    const got = Math.min(have, qty);
    this.stock[s.id] = have - got;
    if (have > 0 && have - got === 0) this.startOut(s);
    if (this.isLow(s)) this.maybeSensor(s);
    if (got < qty) {
      // 发现缺货：一部分人会上报（店员拣货时更可能）
      if (this.rng.chance(who === 'picker' ? this.scenario.shelf.reportProb : this.scenario.shelf.reportProb * 0.3)) this.request(s);
    }
    return got;
  }

  /** 顾客想买但货架空了：一部分换成别的商品，其余算流失 */
  missed(s: Sku, qty: number): boolean {
    if (this.rng.chance(this.scenario.shopping.substitution)) {
      this.substitutions += qty;
      return true;
    }
    this.lostItems += qty;
    this.lostSales += qty * s.price;
    return false;
  }

  private startOut(s: Sku): void {
    if (!Number.isNaN(this.outSince[s.id] as number)) return;
    this.outSince[s.id] = this.sim.now;
    this.outages++;
    this.outCount.add(this.sim.now, 1);
  }

  private endOut(s: Sku): void {
    const since = this.outSince[s.id] as number;
    if (Number.isNaN(since)) return;
    const t = this.sim.now;
    const a = Math.max(since, OPEN);
    const b = Math.min(t, CLOSE);
    if (b > a) this.outageSec += b - a;
    this.recoverSec.push(t - since);
    this.outSince[s.id] = NaN;
    this.outCount.add(t, -1);
  }

  private maybeSensor(s: Sku): void {
    if (this.smart[s.id]) this.request(s);
  }

  /** 巡店（上一代：补货员走一圈；本方案：盘点机器人巡航），把低于补货点的商品都找出来 */
  private scan(): void {
    const sh = this.scenario.shelf;
    const pool = this.crew.scanner ?? this.crew.stocker;
    const route = scanRoute(this.layout);
    const start = this.sim.now;
    pool.submit({
      priority: 1,
      label: '巡店查缺货',
      steps: () => {
        // 沿通道走一圈，每个点停下来看（拍照）一会儿，总时长大约是 scanDurationSec
        const steps: Step[] = [];
        const dwell = (sh.scanDurationSec * 0.5) / route.length;
        for (const p of route) steps.push({ kind: 'walk', to: p, act: '巡店' }, { kind: 'work', sec: dwell, act: '巡店' });
        steps.push({
          kind: 'call',
          fn: () => {
            // 巡完时把低库存的商品按陈列位置先后报出（越早经过的越早报）
            for (const s of this.catalog.skus) if (this.isLow(s)) this.request(s);
          },
        });
        return steps;
      },
    });
    this.trace.event(start, 'info', pool === this.crew.scanner ? '盘点机器人开始巡航' : '补货员开始巡店查缺货');
  }

  /** 生成补货任务（同一个商品同时只有一个） */
  request(s: Sku): void {
    if (this.requested[s.id]) return;
    if (this.backroomOut[s.id]) return;
    this.requested[s.id] = 1;
    const priority = 10 - Math.min(9, Math.round(demandRate(this.catalog, s) * 4000));
    if (this.crew.amr) this.restockWithRobot(s, priority);
    else this.restockByHand(s, priority);
  }

  private casesFor(s: Sku): number {
    const gap = s.shelfCap - (this.stock[s.id] as number);
    return Math.max(1, Math.min(2, Math.ceil(gap / s.caseQty)));
  }

  /** 上一代：补货员走去后仓取箱、回来上架 */
  private restockByHand(s: Sku, priority: number): void {
    const sh = this.scenario.shelf;
    const stockPt = nearest(this.layout.poi.backroomStock, s.face);
    this.crew.stocker.submit({
      priority,
      label: '补货',
      steps: () => {
        const found = !this.rng.chance(sh.phantomRate);
        const steps: Step[] = [
          { kind: 'walk', to: stockPt, act: '去后仓取箱' },
          { kind: 'work', sec: sh.fetchSec, act: '找箱' },
        ];
        if (!found) {
          steps.push({ kind: 'call', fn: () => this.failed(s) });
          return steps;
        }
        steps.push({ kind: 'walk', to: s.face, act: '送到货架' });
        steps.push({ kind: 'work', sec: () => Math.min(this.casesFor(s) * s.caseQty, s.shelfCap - (this.stock[s.id] as number)) * sh.stockSecPerUnit, act: '上架' });
        steps.push({ kind: 'call', fn: () => this.refill(s) });
        return steps;
      },
    });
  }

  /**
   * 本方案：补货机器人从后仓取箱、送到货架旁放下；放下以后才把「上架」派给门店作业员，
   * 员工不用站在货架边等机器人。
   */
  private restockWithRobot(s: Sku, priority: number): void {
    const sh = this.scenario.shelf;
    const amr = this.crew.amr as Pool;
    const stockPt = nearest(this.layout.poi.backroomStock, s.face);
    const found = !this.rng.chance(sh.phantomRate);
    amr.submit({
      priority,
      label: '送箱',
      steps: () => [
        { kind: 'walk', to: stockPt, act: '去后仓取箱' },
        { kind: 'work', sec: 30, act: '取箱' },
        ...(found ? [{ kind: 'walk' as const, to: s.face, act: '送箱' }, { kind: 'work' as const, sec: 20, act: '放下货箱' }] : []),
      ],
      onDone: () => {
        if (!found) {
          this.failed(s);
          return;
        }
        this.crew.stocker.submit({
          priority,
          label: '上架',
          steps: () => [
            { kind: 'walk', to: s.face, act: '去货架' },
            { kind: 'work', sec: () => Math.min(this.casesFor(s) * s.caseQty, s.shelfCap - (this.stock[s.id] as number)) * sh.stockSecPerUnit, act: '上架' },
            { kind: 'call', fn: () => this.refill(s) },
          ],
        });
      },
    });
  }

  private refill(s: Sku): void {
    const before = this.stock[s.id] as number;
    const units = Math.min(this.casesFor(s) * s.caseQty, s.shelfCap - before);
    this.stock[s.id] = before + Math.max(0, units);
    this.requested[s.id] = 0;
    this.restocks++;
    this.restockUnits += Math.max(0, units);
    if (before === 0 && units > 0) this.endOut(s);
  }

  private failed(s: Sku): void {
    // 后仓找不到：这一趟白跑，等下一次发现再去
    this.failedTrips++;
    this.requested[s.id] = 0;
  }

  /** 收尾：把还空着的商品算到关门为止 */
  close(): void {
    for (const s of this.catalog.skus) {
      const since = this.outSince[s.id] as number;
      if (Number.isNaN(since)) continue;
      const a = Math.max(since, OPEN);
      if (CLOSE > a) this.outageSec += CLOSE - a;
    }
  }

  /** 营业时间内平均的缺货率（缺货商品数 / 商品总数） */
  outOfShelfRate(): number {
    return this.outageSec / (this.catalog.skus.length * (CLOSE - OPEN));
  }
}

/** 一个商品每天的需求权重（在全部需求行中的比例） */
const rateCache = new WeakMap<Catalog, Map<number, number>>();
export function demandRate(cat: Catalog, s: Sku): number {
  let m = rateCache.get(cat);
  if (!m) {
    m = new Map();
    for (const c of Object.keys(cat.byCategory) as Sku['category'][]) {
      const list = cat.byCategory[c];
      const total = list.reduce((a, k) => a + k.weight, 0);
      for (const k of list) m.set(k.id, (k.weight / total) * CATEGORY[c].lineShare);
    }
    rateCache.set(cat, m);
  }
  return m.get(s.id) ?? 0;
}

export function nearest(points: readonly Pt[], to: Pt): Pt {
  let best = points[0] as Pt;
  let bd = Infinity;
  for (const p of points) {
    const d = Math.abs(p.x - to.x) + Math.abs(p.y - to.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** 巡店路线：沿着货架通道蛇形走一圈 */
function scanRoute(layout: Layout): Pt[] {
  const faces = [...layout.faces.ambient, ...layout.faces.household, ...layout.faces.beverage, ...layout.faces.frozen, ...layout.faces.dairy, ...layout.faces.produce, ...layout.faces.bakery, ...layout.faces.meat];
  const xs = [...new Set(faces.map((f) => f.x))].sort((a, b) => a - b);
  const pts: Pt[] = [];
  xs.forEach((x, i) => {
    const col = faces.filter((f) => f.x === x).map((f) => f.y);
    const top = Math.min(...col);
    const bottom = Math.max(...col);
    if (i % 2 === 0) pts.push({ x, y: top }, { x, y: bottom });
    else pts.push({ x, y: bottom }, { x, y: top });
  });
  // 每隔几条通道取一次，路线别太碎
  return pts.filter((_, i) => i % 4 === 0 || i % 4 === 1);
}
