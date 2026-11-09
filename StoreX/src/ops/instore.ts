import type { Rng } from '../core/rng';
import { H, type Sim } from '../core/sim';
import type { Scenario } from '../world/config';
import type { Shopper } from '../world/demand';
import type { Layout, Pt } from '../world/layout';
import type { Router } from '../world/path';
import type { Pool } from './agents';
import { CAR_ENTRY, CAR_EXIT } from './online';
import type { Shelf } from './shelf';
import type { Trace } from './trace';

/**
 * 到店顾客：进门、按购物清单拿货（拿的是和线上拣货共用的货架库存）、结账、离开。
 * 结账方式：上一代是人工通道和自助结账；本方案多了免排队出口（注册用户走出去就自动结账）。
 */
export type CheckoutKind = 'staffed' | 'self' | 'gate';

export interface InstoreStats {
  shoppers: number;
  items: number;
  sales: number;
  waits: Record<CheckoutKind, number[]>;
  counts: Record<CheckoutKind, number>;
  interventions: number;
  /** 每小时的平均结账等待（分钟）之和、人数 */
  waitByHour: number[];
  countByHour: number[];
}

export class Instore {
  readonly stats: InstoreStats = {
    shoppers: 0,
    items: 0,
    sales: 0,
    waits: { staffed: [], self: [], gate: [] },
    counts: { staffed: 0, self: 0, gate: 0 },
    interventions: 0,
    waitByHour: new Array<number>(24).fill(0),
    countByHour: new Array<number>(24).fill(0),
  };
  private laneTurn = 0;
  /** 动画：每个停车位空出来的时刻、每位开车顾客的车 */
  private readonly stallFree: number[] = [];
  private readonly carOf = new Map<number, { car: number; stall: number }>();

  constructor(
    readonly sim: Sim,
    readonly s: Scenario,
    readonly layout: Layout,
    readonly router: Router,
    readonly trace: Trace,
    private readonly rng: Rng,
    private readonly shelf: Shelf,
    private readonly pools: { cashier: Pool; host: Pool; kiosks: Pool; gates?: Pool },
    shoppers: readonly Shopper[],
  ) {
    for (const sh of shoppers) sim.at(sh.arrival, () => this.arrive(sh));
  }

  private choose(sh: Shopper): CheckoutKind {
    const n = sh.items.length;
    if (this.s.generation === 'gen1') {
      if (n > 15) return sh.choice < 0.15 ? 'self' : 'staffed';
      return sh.choice < 0.55 ? 'self' : 'staffed';
    }
    // 没有免排队通道时，注册了的顾客也走自助或人工
    if (sh.frictionless && this.pools.gates) return 'gate';
    if (n > 20) return sh.choice < 0.4 ? 'self' : 'staffed';
    return sh.choice < 0.8 ? 'self' : 'staffed';
  }

  private arrive(sh: Shopper): void {
    this.parkCar(sh);
    const s = this.s;
    const shopSec = s.shopping.baseSec + s.shopping.perItemSec * sh.items.length;
    const t0 = this.sim.now;
    // 拿货：分散在购物过程中
    for (const sku of sh.items) {
      this.sim.after(shopSec * (0.1 + 0.8 * this.rng.next()), () => {
        const got = this.shelf.take(sku, 1, 'shopper');
        if (got > 0) {
          this.stats.items++;
          this.stats.sales += sku.price;
        } else if (this.shelf.missed(sku, 1)) {
          this.stats.items++;
          this.stats.sales += sku.price * 0.9;
        }
      });
    }
    const kind = this.choose(sh);
    const point = this.checkoutPoint(kind);
    const agent = this.trace.add('shopper', `顾客 ${sh.id + 1}`);
    if (agent >= 0) {
      // 动画：进门 → 去两三个商品的位置 → 结账点
      const stops = [...sh.items]
        .slice(0, 3)
        .map((k) => k.face)
        .sort((a, b) => a.x - b.x);
      let pos = this.layout.poi.entrance;
      const legs = [...stops, point];
      const legSec = shopSec / legs.length;
      legs.forEach((to, i) => {
        this.trace.move(agent, t0 + i * legSec, t0 + i * legSec + legSec * 0.6, this.router.path(pos, to, true), '购物');
        this.trace.dwell(agent, t0 + i * legSec + legSec * 0.6, t0 + (i + 1) * legSec, to, '购物');
        pos = to;
      });
    }
    this.sim.after(shopSec, () => this.checkout(sh, kind, point, agent));
  }

  private checkoutPoint(kind: CheckoutKind): Pt {
    const p = this.layout.poi;
    const list = kind === 'staffed' ? p.staffedLanes : kind === 'self' ? p.selfCheckouts : p.gates;
    return (list[this.laneTurn++ % Math.max(1, list.length)] ?? p.exit) as Pt;
  }

  /**
   * 动画：约七成顾客开车来，停在最早空出来的车位，结完账开走（只记轨迹，不改变结果）。
   */
  private parkCar(sh: Shopper): void {
    if (!this.trace.enabled || sh.id % 10 >= 7) return;
    const stalls = this.layout.poi.parking;
    let stall = -1;
    for (let i = 0; i < stalls.length; i++) {
      const k = (sh.id * 7 + i) % stalls.length;
      if ((this.stallFree[k] ?? 0) <= sh.arrival - 80) {
        stall = k;
        break;
      }
    }
    if (stall < 0) return;
    this.stallFree[stall] = Infinity;
    const at = stalls[stall] as Pt;
    const car = this.trace.add('car', `顾客车辆（顾客 ${sh.id + 1}）`);
    this.trace.move(car, sh.arrival - 80, sh.arrival - 20, this.router.path(CAR_ENTRY, at, true), '找车位');
    this.carOf.set(sh.id, { car, stall });
  }

  private unparkCar(sh: Shopper): void {
    const c = this.carOf.get(sh.id);
    if (!c) return;
    const at = this.layout.poi.parking[c.stall] as Pt;
    const t = this.sim.now + 50;
    this.trace.dwell(c.car, sh.arrival - 20, t, at, '停车');
    this.trace.move(c.car, t, t + 60, this.router.path(at, CAR_EXIT, true), '离开');
    this.stallFree[c.stall] = t + 30;
    this.carOf.delete(sh.id);
  }

  private checkout(sh: Shopper, kind: CheckoutKind, point: Pt, agent: number): void {
    const s = this.s.checkout;
    const n = sh.items.length;
    const joined = this.sim.now;
    const leave = () => {
      this.unparkCar(sh);
      if (agent >= 0) this.trace.move(agent, this.sim.now, this.sim.now + 60, this.router.path(point, this.layout.poi.exit, true), '离开');
      this.stats.shoppers++;
      this.stats.counts[kind]++;
    };
    const record = (start: number) => {
      const wait = (start - joined) / 60;
      this.stats.waits[kind].push(wait);
      const h = Math.min(23, Math.floor(joined / H));
      this.stats.waitByHour[h] = (this.stats.waitByHour[h] as number) + wait;
      this.stats.countByHour[h] = (this.stats.countByHour[h] as number) + 1;
      if (agent >= 0) this.trace.dwell(agent, joined, start, point, '排队');
    };
    if (kind === 'gate') {
      // 免排队出口：年龄限制商品大多由数字身份自动核验，约两成需要店员看一眼
      const needsHost = sh.ageRestricted && this.rng.chance(0.2);
      const pool = this.pools.gates as Pool;
      pool.submit({
        priority: joined,
        label: '免排队出口',
        steps: () => {
          record(this.sim.now);
          return [{ kind: 'work', sec: s.gateSec, act: '出口' }, ...(needsHost ? this.hostHelp() : [])];
        },
        onDone: leave,
      });
      return;
    }
    if (kind === 'self') {
      const intervene = this.rng.chance(s.interventionRate) || (sh.ageRestricted && (this.s.generation === 'gen1' || this.rng.chance(0.2)));
      if (intervene) this.stats.interventions++;
      this.pools.kiosks.submit({
        priority: joined,
        label: '自助结账',
        steps: () => {
          record(this.sim.now);
          return [{ kind: 'work', sec: s.selfBaseSec + s.selfItemSec * n + s.payTimeSec, act: '自助结账' }, ...(intervene ? this.hostHelp() : [])];
        },
        onDone: leave,
      });
      return;
    }
    this.pools.cashier.submit({
      priority: joined,
      label: '人工收银',
      steps: (m) => {
        record(this.sim.now);
        const lane = this.layout.poi.staffedLanes[m.id % this.layout.poi.staffedLanes.length] as Pt;
        return [
          // 收银员站在收银台另一侧
          { kind: 'walk', to: { x: lane.x - 2, y: lane.y }, act: '到收银台' },
          { kind: 'work', sec: s.staffedBaseSec + s.staffedItemSec * n + s.payTimeSec, act: '收银' },
        ];
      },
      onDone: leave,
    });
  }

  /** 需要店员帮忙（自助结账卡住、核验年龄）：等一个看护员过来 */
  private hostHelp(): { kind: 'wait'; act: string; start: (resume: () => void) => void }[] {
    const host = this.pools.host;
    const sec = this.s.checkout.interventionSec;
    return [
      {
        kind: 'wait',
        act: '等店员',
        start: (resume) => {
          host.submit({
            priority: 0,
            label: '协助结账',
            steps: () => [
              { kind: 'walk', to: this.layout.poi.selfCheckouts[0] ?? this.layout.poi.exit, act: '去协助' },
              { kind: 'work', sec, act: '协助结账' },
            ],
            onDone: resume,
          });
        },
      },
    ];
  }
}
