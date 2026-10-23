import { createRng, type Rng } from '@storewright/domain';
import { planogramIndex, sellableCases, shelfNow, type AnyOpsEvent, type PlanogramEntry } from '@storewright/ops';
import type { StoreRuntime } from './runtime';
import { sensorCommand, sensorPayload } from './sensing';

/**
 * 门店客流与传感器仿真（演示用）：
 * - 按商品热度和时段生成店内销售流水（POS），每隔几秒提交一批；
 * - 维护一份「真实存量」：销售、线上拣货扣减，补货上架增加，另有少量损耗（被拿走、放错位置，系统不知道）；
 * - 配传感器的货位按真实存量加噪声上报，格式与原型设备相同；
 * - 真实存量与系统估算的差距可以在控制台看到。
 * 时间可以加速：speed = 每 1 秒真实时间相当于多少秒门店时间。
 * 可以打开「自动补货」：一个虚拟补货员按优先级处理开放的补货任务（每个约 10 分钟门店时间），
 * 长时间演示时不至于缺货越积越多（全流程走查发现）。只处理系统已知的补货任务，货架核对仍然要员工去做。
 */

/** 虚拟补货员的身份（不在员工名单里） */
export const AUTO_RESTOCK_ACTOR = 'auto-restock';
/** 虚拟补货员处理一个补货任务的门店时间（分钟） */
const RESTOCK_TASK_MIN = 10;

export interface SimStatus {
  running: boolean;
  speed: number;
  /** 已提交的销售件数、损耗件数、传感器读数条数 */
  sold: number;
  lost: number;
  shrink: number;
  readings: number;
  /** 自动补货（虚拟补货员）是否打开、已完成的补货任务数 */
  autoRestock: boolean;
  autoRestocked: number;
  /** 真实存量与系统估算差距最大的商品 */
  drift: Array<{ itemId: string; name: string; locationId: string; truth: number; est: number; capacity: number; sensor?: string }>;
  /** 仿真里的门店时间（小时，0–24） */
  storeHour?: number;
}

/** 每小时客流系数（相对日均） */
const HOURLY = [0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.7, 0.9, 1, 1.1, 1.3, 1.4, 1.2, 1.1, 1.1, 1.3, 1.6, 1.7, 1.5, 1.2, 0.9, 0.6, 0.3];

export class StoreSim {
  private timer: ReturnType<typeof setInterval> | undefined;
  private truth = new Map<string, number>();
  private rng: Rng;
  private seq = 0;
  private unsub: (() => void) | undefined;
  /** 虚拟补货员累计的可用工作量（以补货任务计） */
  private restockBudget = 0;
  status: SimStatus = { running: false, speed: 30, sold: 0, lost: 0, shrink: 0, readings: 0, autoRestock: false, autoRestocked: 0, drift: [] };

  constructor(
    private readonly rt: StoreRuntime,
    seed = 11,
    private readonly tickMs = 2000,
  ) {
    this.rng = createRng(seed);
  }

  /** 某商品的真实存量（还没开始仿真时等于系统估算） */
  truthOf(p: PlanogramEntry): number {
    return this.truth.get(p.itemId) ?? Math.round(shelfNow(this.rt.state, p).est);
  }

  /**
   * 门店时间（小时）：客流按门店时间的钟点变化，跟着仿真加速走，不看墙上的时钟（决策记录 0015）。
   * 原来用墙上时钟，深夜打开演示时客流只有白天的三成，演示和测试都受打开的时间影响。
   */
  private storeHour = 9;

  start(speed = 30): void {
    this.status.speed = Math.max(1, Math.min(600, speed));
    if (this.timer) return;
    // 营业时间内打开：从现在的钟点开始；否则从早上 9 点开始
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    this.storeHour = h >= 8 && h < 21 ? h : 9;
    this.status.storeHour = this.storeHour;
    for (const p of this.rt.statics.planogram) if (!this.truth.has(p.itemId)) this.truth.set(p.itemId, Math.round(shelfNow(this.rt.state, p).est));
    this.unsub = this.rt.subscribe((m) => {
      if (m.t === 'events') this.observe(m.events);
      if (m.t === 'reset') this.truth.clear();
    });
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.status.running = true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsub?.();
    this.unsub = undefined;
    this.status.running = false;
  }

  setAutoRestock(on: boolean): void {
    this.status.autoRestock = on;
    if (!on) this.restockBudget = 0;
  }

  /**
   * 让某个商品的货架变空。silent = true 时系统不知道（被顾客拿走后放错地方、损耗），
   * 要等拣货员报告找不到或传感器发现；否则当作卖光了，系统估算也变成 0。
   */
  async emptyShelf(itemId: string, silent: boolean): Promise<boolean> {
    const p = planogramIndex(this.rt.statics).get(itemId);
    if (!p) return false;
    const est = Math.round(shelfNow(this.rt.state, p).est);
    this.truth.set(itemId, 0);
    if (!silent && est > 0) await this.rt.submit({ cmd: { type: 'RecordSales', lines: [{ itemId, qty: est }] }, actor: 'pos', at: Date.now() });
    return true;
  }

  /** 补货上架、线上拣货改变真实存量 */
  private observe(events: AnyOpsEvent[]): void {
    const index = planogramIndex(this.rt.statics);
    for (const e of events) {
      if (e.type === 'ReplenishmentCompleted') {
        const p = index.get(e.payload.itemId);
        if (p) this.truth.set(p.itemId, Math.min(p.capacity, this.truthOf(p) + e.payload.units));
      } else if (e.type === 'ItemPicked') {
        const o = this.rt.state.totes[e.payload.toteId] ? this.rt.state.orders[this.rt.state.totes[e.payload.toteId]?.orderId ?? ''] : undefined;
        const itemId = o?.lines.find((l) => l.lineId === e.payload.lineId)?.itemId;
        const p = itemId ? index.get(itemId) : undefined;
        if (p) this.truth.set(p.itemId, Math.max(0, this.truthOf(p) - e.payload.qty));
      }
    }
  }

  private async tick(): Promise<void> {
    const dtH = (this.tickMs / 1000) * this.status.speed / 3600;
    const factor = HOURLY[Math.floor(this.storeHour) % 24] ?? 1;
    this.storeHour = (this.storeHour + dtH) % 24;
    this.status.storeHour = this.storeHour;
    const lines: Array<{ itemId: string; qty: number }> = [];
    for (const p of this.rt.statics.planogram) {
      const lambda = p.baseVelocity * factor * dtH;
      if (lambda <= 0) continue;
      const want = this.rng.poisson(lambda);
      const have = this.truthOf(p);
      // 损耗：极少量，系统不知道
      if (have > 0 && this.rng.next() < lambda * 0.01) {
        this.truth.set(p.itemId, have - 1);
        this.status.shrink += 1;
      }
      if (!want) continue;
      const qty = Math.min(want, this.truthOf(p));
      if (qty < want) this.status.lost += want - qty;
      if (!qty) continue;
      this.truth.set(p.itemId, this.truthOf(p) - qty);
      lines.push({ itemId: p.itemId, qty });
    }
    if (lines.length) {
      this.status.sold += lines.reduce((n, l) => n + l.qty, 0);
      await this.rt.submit({ cmd: { type: 'RecordSales', lines }, actor: 'pos', at: Date.now() });
    }
    if (this.status.autoRestock) await this.autoRestock(dtH);
    // 传感器：真实存量加噪声（测距多数情况完全正确，偶尔差 1 件）
    for (const p of this.rt.statics.planogram) {
      if (!p.sensor) continue;
      const truth = this.truthOf(p);
      const noisy = p.sensor === 'tof' && this.rng.next() < 0.05 ? Math.max(0, truth + (this.rng.next() < 0.5 ? -1 : 1)) : truth;
      const r = sensorCommand(sensorPayload(this.rt.statics.storeId, p.locationId, p.sensor, noisy, 0.9 + this.rng.next() * 0.08, ++this.seq, p.itemId));
      if (!r.ok) continue;
      const res = await this.rt.submit({ cmd: r.cmd, actor: 'sensor', at: Date.now() });
      if (res.ok && res.events.length) this.status.readings += 1;
    }
    this.updateDrift();
  }

  /** 虚拟补货员：按优先级领取开放的补货任务，从后仓可售的箱子（件数最少的先用）补到货架 */
  private async autoRestock(dtH: number): Promise<void> {
    this.restockBudget = Math.min(this.restockBudget + (dtH * 60) / RESTOCK_TASK_MIN, 5);
    const s = this.rt.state;
    const index = planogramIndex(this.rt.statics);
    const open = Object.values(s.repl)
      .filter((t) => t.status === 'OPEN')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    for (const t of open) {
      if (this.restockBudget < 1) break;
      const p = index.get(t.itemId);
      const c = sellableCases(s, t.itemId).sort((a, b) => a.units - b.units)[0];
      if (!p || !c) continue;
      const room = Math.max(1, p.capacity - this.truthOf(p));
      const at = Date.now();
      const claim = await this.rt.submit({ cmd: { type: 'ClaimReplenishment', taskIds: [t.id] }, actor: AUTO_RESTOCK_ACTOR, at });
      if (!claim.ok) continue;
      const done = await this.rt.submit({ cmd: { type: 'CompleteReplenishment', taskId: t.id, caseId: c.id, locationId: t.locationId, units: Math.min(c.units, room) }, actor: AUTO_RESTOCK_ACTOR, at });
      if (!done.ok) {
        await this.rt.submit({ cmd: { type: 'ReleaseReplenishment', taskIds: [t.id] }, actor: AUTO_RESTOCK_ACTOR, at });
        continue;
      }
      this.restockBudget -= 1;
      this.status.autoRestocked += 1;
    }
  }

  private updateDrift(): void {
    const rows: SimStatus['drift'] = [];
    for (const p of this.rt.statics.planogram) {
      const truth = this.truthOf(p);
      const est = Math.round(shelfNow(this.rt.state, p).est);
      if (truth === est) continue;
      const row: SimStatus['drift'][number] = { itemId: p.itemId, name: p.name, locationId: p.locationId, truth, est, capacity: p.capacity };
      if (p.sensor) row.sensor = p.sensor;
      rows.push(row);
    }
    this.status.drift = rows.sort((a, b) => Math.abs(b.est - b.truth) - Math.abs(a.est - a.truth)).slice(0, 12);
  }
}
