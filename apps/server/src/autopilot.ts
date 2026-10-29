import { createRng, type Rng } from '@storewright/domain';
import { needsAgeCheck, pickRows, suggestSlots, type LiveOrder, type LiveWalk, type OpsCommand } from '@storewright/ops';
import type { DemoStore } from './demo';
import type { StoreRuntime } from './runtime';

/**
 * 自动运营（演示门店的「双线并行」）：
 * - 虚拟顾客按设定的频率下单（自取为主，少量配送），订单带 track = AUTO；
 * - 虚拟拣货员、暂存员、交付员和司机用和员工手机完全相同的命令把订单做完：领取批次 → 绑定标签 → 逐站拣货 →
 *   暂存 → 顾客报预计到达、到店 → 开始准备、逐框扫描 → 核验取货码 → 完成交付；配送行程由虚拟司机接单、到店交接。
 * 作业核心把自动运营的订单单独分批、单独组行程，员工手机上不显示它们，所以你在手机上的操作和自动运营同时进行、互不混在一起；
 * 两条线共用同一个暂存区、同一批货架和同一个门店 AI，可以看到资源被占用时的相互影响。
 * 每个动作按「这一步大概要多久」排队（墙钟时间，pace 越大越快），模拟器的数字孪生里能看到订单、顾客的车和暂存占用的变化。
 */

export type AutoRole = 'PICK' | 'STAGE' | 'HANDOFF' | 'DRIVER';

export interface AutoWorker {
  id: string;
  role: AutoRole;
  /** 正在做的事（批次、订单或行程编号） */
  task?: string;
}

export interface AutoPilotStatus {
  running: boolean;
  ordersPerHour: number;
  deliveryShare: number;
  pace: number;
  /** 自动运营的订单：已下单、已完成、进行中 */
  created: number;
  completed: number;
  open: number;
  /** 从下单到交付完成的平均时间（分钟，墙钟） */
  avgMinutes?: number;
  trips: number;
  workers: AutoWorker[];
}

/** 虚拟员工（不在员工名单里，编号以 V- 开头） */
export const AUTO_WORKERS: ReadonlyArray<{ id: string; role: AutoRole }> = [
  { id: 'V-P1', role: 'PICK' },
  { id: 'V-P2', role: 'PICK' },
  { id: 'V-S1', role: 'STAGE' },
  { id: 'V-H1', role: 'HANDOFF' },
  { id: 'V-H2', role: 'HANDOFF' },
  { id: 'V-D1', role: 'DRIVER' },
];
export const AUTO_CUSTOMER = 'V-customer';

/** 每一步的大致用时（秒，pace = 1 时） */
const STEP_SEC = { claim: 3, bind: 4, stop: 6, complete: 3, stage: 4, startPrep: 3, scan: 2, verify: 4, handoff: 4, accept: 5 };

export class AutoPilot {
  private timer: ReturnType<typeof setInterval> | undefined;
  private rng: Rng;
  private busyUntil = new Map<string, number>();
  private tasks = new Map<string, string>();
  /** 虚拟顾客 / 司机的到店时间（订单或行程编号 → 时间） */
  private arriveAt = new Map<string, number>();
  private ticking = false;
  status: AutoPilotStatus = { running: false, ordersPerHour: 40, deliveryShare: 0.25, pace: 1, created: 0, completed: 0, open: 0, trips: 0, workers: [] };

  constructor(
    private readonly rt: StoreRuntime,
    private readonly demo: DemoStore,
    seed = 23,
    private readonly tickMs = 2000,
  ) {
    this.rng = createRng(seed);
    this.refresh();
  }

  start(opts: { ordersPerHour?: number; deliveryShare?: number; pace?: number } = {}): void {
    if (opts.ordersPerHour !== undefined && Number.isFinite(opts.ordersPerHour)) this.status.ordersPerHour = Math.max(1, Math.min(240, Math.round(opts.ordersPerHour)));
    if (opts.deliveryShare !== undefined && Number.isFinite(opts.deliveryShare)) this.status.deliveryShare = Math.max(0, Math.min(1, opts.deliveryShare));
    if (opts.pace !== undefined && Number.isFinite(opts.pace)) this.status.pace = Math.max(0.25, Math.min(8, opts.pace));
    this.status.running = true;
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.tickMs);
    // 一开始就有活干
    void this.tick(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.status.running = false;
    this.refresh();
  }

  /** 推进一拍（测试里可以直接调用）；first = true 时先下一张订单 */
  async tick(first = false, now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.arrivals(first, now);
      for (const w of AUTO_WORKERS) {
        if ((this.busyUntil.get(w.id) ?? 0) > now) continue;
        const sec = await this.work(w.id, w.role, now);
        if (sec > 0) this.busyUntil.set(w.id, now + (sec * 1000) / this.status.pace);
      }
      await this.customers(now);
    } finally {
      this.ticking = false;
      this.refresh();
    }
  }

  private async run(cmd: OpsCommand, actor: string, at: number): Promise<boolean> {
    const r = await this.rt.submit({ cmd, actor, at });
    return r.ok;
  }

  private autoOrders(): LiveOrder[] {
    return Object.values(this.rt.state.orders).filter((o) => o.track === 'AUTO');
  }

  // ---------------------------------------------------------------------------
  // 虚拟顾客下单

  private async arrivals(first: boolean, now: number): Promise<void> {
    const lambda = (this.status.ordersPerHour * this.tickMs) / 3_600_000;
    let n = first ? 1 : this.rng.poisson(lambda);
    if (!n) return;
    n = Math.min(n, 4);
    for (let i = 0; i < n; i++) {
      const type = this.rng.next() < this.status.deliveryShare ? 'DELIVERY' : 'PICKUP';
      // 时段在 10 分钟后（按 5 分钟取整）：拣货、暂存来得及，顾客到店时正好在时段内
      const slotStart = Math.ceil((now + 10 * 60_000) / 300_000) * 300_000;
      const index = Object.keys(this.rt.state.orders).length;
      const id = `D${String(index + 1).padStart(4, '0')}`;
      const ord = this.demo.makeOrder({ index, type, slotStart, maxLines: 4, code: this.demo.autoCode(id), track: 'AUTO' });
      if (!(await this.run({ type: 'CreateOrder', order: ord.info, codeHash: ord.codeHash }, AUTO_CUSTOMER, now))) continue;
      await this.run({ type: 'LockOrder', orderId: ord.info.id }, 'system', now);
    }
    await this.run({ type: 'ReleaseWalks' }, 'system', now);
  }

  // ---------------------------------------------------------------------------
  // 虚拟员工：返回这一步用了多少秒（0 = 没有活）

  private async work(id: string, role: AutoRole, now: number): Promise<number> {
    this.tasks.delete(id);
    if (role === 'PICK') return this.pick(id, now);
    if (role === 'STAGE') return this.stage(id, now);
    if (role === 'HANDOFF') return this.handoff(id, now);
    return this.drive(id, now);
  }

  private async pick(id: string, now: number): Promise<number> {
    const s = this.rt.state;
    let w: LiveWalk | undefined = Object.values(s.walks).find((x) => x.associateId === id && (x.status === 'CLAIMED' || x.status === 'PICKING'));
    if (!w) {
      const open = Object.values(s.walks)
        .filter((x) => x.track === 'AUTO' && x.status === 'OPEN')
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!open) return 0;
      if (!(await this.run({ type: 'ClaimWalk', walkId: open.id }, id, now))) return 1;
      this.tasks.set(id, open.id);
      return STEP_SEC.claim;
    }
    this.tasks.set(id, w.id);
    // 绑定标签（一次把这批的框都扫完）
    const unbound = w.toteIds.filter((t) => !w?.bound.includes(t) && s.orders[s.totes[t]?.orderId ?? '']?.status !== 'CANCELLED');
    if (unbound.length) {
      for (const t of unbound) {
        const labelId = s.totes[t]?.labelId;
        if (labelId) await this.run({ type: 'BindLabel', walkId: w.id, labelId }, id, now);
      }
      return STEP_SEC.bind;
    }
    // 下一站：这一站的每一行都拣完
    const rows = pickRows(s, w).filter((r) => !r.cancelled && r.done < r.qty);
    if (rows.length) {
      const stop = rows[0]?.stopIndex;
      for (const r of rows.filter((x) => x.stopIndex === stop)) {
        const ok = await this.run({ type: 'PickItem', walkId: w.id, toteId: r.toteId, lineId: r.lineId, qty: r.qty - r.done }, id, now);
        // 拣不到（例如货架估算为 0）：按缺货处理，保证流程能走完
        if (!ok) await this.run({ type: 'ReportNotFound', walkId: w.id, toteId: r.toteId, lineId: r.lineId, qty: r.qty - r.done, resolution: 'SHORT' }, id, now);
      }
      return STEP_SEC.stop;
    }
    await this.run({ type: 'CompleteWalk', walkId: w.id }, id, now);
    return STEP_SEC.complete;
  }

  private async stage(id: string, now: number): Promise<number> {
    const s = this.rt.state;
    const tote = Object.values(s.totes).find((t) => t.status === 'PICKED' && s.orders[t.orderId]?.track === 'AUTO' && t.labelId);
    if (!tote?.labelId) return 0;
    const slot = suggestSlots(s, this.rt.statics, tote.id)[0];
    if (!slot) return 3;
    this.tasks.set(id, s.orders[tote.orderId]?.shortCode ?? tote.orderId);
    await this.run({ type: 'StageTote', labelId: tote.labelId, slotCode: slot }, id, now);
    return STEP_SEC.stage;
  }

  private async handoff(id: string, now: number): Promise<number> {
    const s = this.rt.state;
    // 自己手上的交付
    let ss = Object.values(s.sessions).find((x) => x.status !== 'COMPLETED' && x.owner === id);
    if (!ss) {
      const keys = [
        ...this.autoOrders()
          .filter((o) => o.type === 'PICKUP' && o.arrivedAt !== undefined && o.stagedAt !== undefined && o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && !s.sessions[o.id])
          .map((o) => o.id),
        ...Object.values(s.trips)
          .filter((t) => t.arrivedAt !== undefined && !t.completedAt && !s.sessions[t.id] && t.orderIds.every((oid) => s.orders[oid]?.track === 'AUTO' && (s.orders[oid]?.stagedAt !== undefined || s.orders[oid]?.status === 'CANCELLED')))
          .map((t) => t.id),
      ];
      const key = keys[0];
      if (!key) return 0;
      if (!(await this.run({ type: 'StartPrep', key }, id, now))) return 1;
      this.tasks.set(id, key);
      return STEP_SEC.startPrep;
    }
    this.tasks.set(id, ss.key);
    const all = ss.orderIds.flatMap((oid) => s.orders[oid]?.toteIds ?? []).filter((t) => s.totes[t]?.status === 'STAGED' && !ss?.scanned.includes(t));
    const next = all[0];
    if (next) {
      const labelId = s.totes[next]?.labelId;
      if (labelId) await this.run({ type: 'ScanPrepTote', key: ss.key, labelId }, id, now);
      return STEP_SEC.scan;
    }
    if (!ss.verified) {
      await this.run({ type: 'VerifyCode', key: ss.key, code: this.demo.autoCode(ss.key) }, id, now);
      ss = s.sessions[ss.key];
      if (ss && !ss.verified && ss.manualRequired) await this.run({ type: 'VerifyManually', key: ss.key }, id, now);
      return STEP_SEC.verify;
    }
    if (needsAgeCheck(s, ss.orderIds) && !ss.ageVerified) await this.run({ type: 'VerifyAge', key: ss.key }, id, now);
    const trip = s.trips[ss.key];
    if (trip) for (const oid of trip.orderIds) if (trip.placements[oid]) await this.run({ type: 'RecordPlacement', tripId: trip.id, orderId: oid, position: trip.placements[oid] }, id, now);
    await this.run({ type: 'CompleteHandoff', key: ss.key }, id, now);
    return STEP_SEC.handoff;
  }

  /** 虚拟司机：接下自动运营的配送行程（得到验证码），稍后到店 */
  private async drive(id: string, now: number): Promise<number> {
    const s = this.rt.state;
    const trip = Object.values(s.trips).find((t) => !t.acceptedAt && t.orderIds.length > 0 && t.orderIds.every((oid) => s.orders[oid]?.track === 'AUTO'));
    if (!trip) return 0;
    this.tasks.set(id, trip.id);
    const code = this.demo.autoCode(trip.id);
    if (await this.run({ type: 'AcceptTrip', tripId: trip.id, driverName: 'Auto driver', codeHash: this.demo.hashCode(trip.id, code) }, id, now)) this.arriveAt.set(trip.id, now + this.jitter(30, 60));
    return STEP_SEC.accept;
  }

  // ---------------------------------------------------------------------------
  // 虚拟顾客、司机到店

  private jitter(minSec: number, maxSec: number): number {
    return ((minSec + this.rng.next() * (maxSec - minSec)) * 1000) / this.status.pace;
  }

  private async customers(now: number): Promise<void> {
    const s = this.rt.state;
    const taken = new Set<string>();
    for (const o of Object.values(s.orders)) if (o.arrivedAt !== undefined && o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && o.bay) taken.add(o.bay);
    for (const o of this.autoOrders()) {
      if (o.type !== 'PICKUP' || o.arrivedAt !== undefined || o.status === 'COMPLETED' || o.status === 'CANCELLED') continue;
      // 暂存完以后出发：先报预计到达，过一会儿到店
      if (o.stagedAt === undefined) continue;
      const at = this.arriveAt.get(o.id);
      if (at === undefined) {
        const eta = now + this.jitter(40, 90);
        this.arriveAt.set(o.id, eta);
        await this.run({ type: 'UpdateEta', orderId: o.id, etaAt: eta }, AUTO_CUSTOMER, now);
        continue;
      }
      if (at > now) continue;
      const bays = this.rt.statics.pickupBays?.length ? this.rt.statics.pickupBays : Array.from({ length: 30 }, (_, k) => String(k + 1));
      const bay = bays.find((b) => !taken.has(b)) ?? (bays[0] as string);
      taken.add(bay);
      await this.run({ type: 'CheckIn', orderId: o.id, bay, vehicle: VEHICLES[Math.floor(this.rng.next() * VEHICLES.length)] }, AUTO_CUSTOMER, now);
      this.arriveAt.delete(o.id);
    }
    for (const t of Object.values(s.trips)) {
      const at = this.arriveAt.get(t.id);
      if (at === undefined || at > now || t.arrivedAt !== undefined) continue;
      await this.run({ type: 'CheckIn', tripId: t.id, vehicle: 'White delivery van' }, 'V-D1', now);
      this.arriveAt.delete(t.id);
    }
  }

  private refresh(): void {
    const orders = this.autoOrders();
    const done = orders.filter((o) => o.status === 'COMPLETED' && o.completedAt !== undefined);
    const avg = done.length ? done.reduce((a, o) => a + ((o.completedAt ?? 0) - o.createdAt), 0) / done.length / 60_000 : undefined;
    const st = this.status;
    st.created = orders.length;
    st.completed = done.length;
    st.open = orders.filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED').length;
    st.trips = Object.values(this.rt.state.trips).filter((t) => t.orderIds.length > 0 && t.orderIds.every((oid) => this.rt.state.orders[oid]?.track === 'AUTO')).length;
    if (avg !== undefined) st.avgMinutes = Math.round(avg * 10) / 10;
    else delete st.avgMinutes;
    st.workers = AUTO_WORKERS.map((w) => {
      const task = this.tasks.get(w.id);
      return task ? { ...w, task } : { ...w };
    });
  }
}

const VEHICLES = ['Blue hatchback', 'Silver sedan', 'Red SUV', 'White pickup', 'Green minivan', 'Black SUV'];
