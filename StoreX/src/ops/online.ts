import type { Rng } from '../core/rng';
import { H, type Sim } from '../core/sim';
import type { Temp } from '../world/catalog';
import type { Scenario } from '../world/config';
import type { Order, OrderLine, PickupMode } from '../world/demand';
import type { Layout, Pt } from '../world/layout';
import type { Router } from '../world/path';
import type { Pool } from './agents';
import type { LineReq, Mfc } from './mfc';
import { planWalks, submitWalk, totesFor, type Part, type PickTimes, type WalkStats } from './picking';
import { nearest, type Shelf } from './shelf';
import { DEPARTURES, dueTime, scheduledDeparture } from './staffing';
import type { Trace } from './trace';

/** 一张订单的结果 */
export interface OrderOutcome {
  id: number;
  slot: number;
  mode: PickupMode;
  items: number;
  picked: number;
  substituted: number;
  short: number;
  totes: number;
  /** 拣完、合流完成的时刻 */
  readyAt: number;
  /** 交到顾客手里 / 装上配送车的时刻 */
  doneAt: number;
  /** 顾客从到店到拿到货的分钟数（配送单为 0） */
  waitMin: number;
  /** 离开温控环境的分钟数（上一代：框离开暂存间到交给顾客；本方案：自提柜里为 0，免下车取货小车出门到交付） */
  dwellMin: number;
  onTime: boolean;
}

export interface OnlinePools {
  stocker?: Pool;
  picker?: Pool;
  dispenser?: Pool;
  freshPicker?: Pool;
  handoff?: Pool;
  carts?: Pool;
  loaders?: Pool;
}

export interface OnlineStats {
  walks: WalkStats;
  lockerPeak: Record<Temp, number>;
  lockerQueuedMax: number;
  exceptions: number;
  mfcShort: number;
  /** 每小时交付的订单数、等待分钟数之和 */
  doneByHour: number[];
  waitByHour: number[];
  /** 降级模式：货格仓停机时门店作业员在卖场拣的包装商品 */
  fallback: WalkStats;
}

interface State {
  o: Order;
  mode: PickupMode;
  parts: number;
  totesByTemp: Record<Temp, number>;
  totes: number;
  picked: number;
  substituted: number;
  short: number;
  readyAt: number;
  doneAt: number;
  called: boolean;
  handoffQueued: boolean;
  inLocker: boolean;
  lockerReserved: Record<Temp, number>;
  customerWaiting: boolean;
  leftCooling: number;
  loaded: boolean;
}

const TEMPS: readonly Temp[] = ['ambient', 'chilled', 'frozen'];
/** 车辆进出停车场的位置（东侧进、西侧出） */
export const CAR_ENTRY: Pt = { x: 82, y: 63 };
export const CAR_EXIT: Pt = { x: 1, y: 63 };

export class Online {
  readonly outcomes: OrderOutcome[] = [];
  readonly stats: OnlineStats = {
    walks: { walks: 0, meters: 0, items: 0 },
    lockerPeak: { ambient: 0, chilled: 0, frozen: 0 },
    lockerQueuedMax: 0,
    exceptions: 0,
    mfcShort: 0,
    doneByHour: new Array<number>(24).fill(0),
    waitByHour: new Array<number>(24).fill(0),
    fallback: { walks: 0, meters: 0, items: 0 },
  };
  /** 门店作业员花在自提异常、年龄核验、配送装车上的秒数（本方案的线上工时要算上） */
  handoffSec = 0;
  private readonly states: State[] = [];
  private readonly lockerFree: Record<Temp, number>;
  private readonly lockerQueue: State[] = [];
  private bayTurn = 0;
  private fallbackTurn = 0;
  /** 动画：顾客车辆（编号）和每个车位空出来的时刻 */
  private readonly cars = new Map<number, { agent: number; bay: Pt }>();
  private readonly bayFree = new Map<string, number>();

  constructor(
    readonly sim: Sim,
    readonly s: Scenario,
    readonly layout: Layout,
    readonly router: Router,
    readonly trace: Trace,
    private readonly rng: Rng,
    private readonly shelf: Shelf,
    private readonly pools: OnlinePools,
    private readonly mfc: Mfc | undefined,
    orders: readonly Order[],
  ) {
    this.lockerFree = { ...s.pickup.lockers };
    const gen1 = s.generation === 'gen1';
    for (const o of orders) {
      const mode: PickupMode = o.delivery ? 'delivery' : gen1 ? 'curbside' : o.prefersLocker && !o.ageRestricted ? 'locker' : 'drive';
      const st: State = {
        o,
        mode,
        parts: 0,
        totesByTemp: { ambient: 0, chilled: 0, frozen: 0 },
        totes: 0,
        picked: 0,
        substituted: 0,
        short: 0,
        readyAt: NaN,
        doneAt: NaN,
        called: false,
        handoffQueued: false,
        inLocker: false,
        lockerReserved: { ambient: 0, chilled: 0, frozen: 0 },
        customerWaiting: false,
        leftCooling: NaN,
        loaded: false,
      };
      for (const t of TEMPS) {
        const lines = o.lines.filter((l) => l.sku.temp === t);
        if (lines.length) st.totesByTemp[t] = totesFor(lines);
      }
      st.totes = TEMPS.reduce((a, t) => a + st.totesByTemp[t], 0);
      this.states.push(st);
      if (!o.delivery) {
        sim.at(o.notice, () => this.onNotice(st));
        sim.at(o.arrival, () => this.onArrival(st));
      }
    }
    // 按要备好的时刻放单（配送单按发车时刻）
    const byDue = new Map<number, State[]>();
    for (const st of this.states) {
      const due = dueTime(st.o);
      const list = byDue.get(due) ?? [];
      list.push(st);
      byDue.set(due, list);
    }
    for (const [due, list] of byDue) sim.at(Math.max(5 * H, due - s.online.releaseLeadSec), () => this.release(list));
    for (const d of [...DEPARTURES, 21 * H]) sim.at(d, () => this.departure(d));
    if (mfc && s.mfc.fallback) mfc.onOutage = (reqs) => this.fallbackDrained(reqs);
  }

  private get gen1(): boolean {
    return this.s.generation === 'gen1';
  }

  private release(list: State[]): void {
    const floorParts: Part[] = [];
    const fallbackParts: Part[] = [];
    for (const st of list) {
      const o = st.o;
      const mfcLines: OrderLine[] = [];
      const floorLines: OrderLine[] = [];
      for (const l of o.lines) (!this.gen1 && l.sku.inMfc ? mfcLines : floorLines).push(l);
      if (mfcLines.length && this.mfc && this.mfc.down && this.s.mfc.fallback) {
        // 降级模式：货格仓停机，包装商品改在卖场货架上拣
        for (const t of TEMPS) {
          const lines = mfcLines.filter((l) => l.sku.temp === t);
          if (!lines.length) continue;
          st.parts++;
          fallbackParts.push({ order: o, due: dueTime(o), temp: t, lines, totes: totesFor(lines), done: (picked, sub, short) => this.sim.after(180, () => this.partDone(st, picked, sub, short)) });
        }
      } else if (mfcLines.length && this.mfc) {
        st.parts++;
        let left = mfcLines.length;
        let picked = 0;
        let short = 0;
        let sub = 0;
        for (const line of mfcLines) {
          this.mfc.pick(line, o, dueTime(o) / 60, (res) => {
            if (res) {
              // 停机时改在卖场拣的行：用卖场拣货的结果
              picked += res.picked;
              sub += res.sub;
              short += res.short;
            } else if (this.rng.chance(0.004)) {
              // 货箱里偶尔少货（记录不准）：一半替代
              this.stats.mfcShort++;
              if (this.rng.chance(0.5)) sub += line.qty;
              else short += line.qty;
            } else picked += line.qty;
            if (--left === 0) this.sim.after(res ? 0 : this.s.mfc.transferSec, () => this.partDone(st, picked, sub, short));
          });
        }
      }
      for (const t of TEMPS) {
        const lines = floorLines.filter((l) => l.sku.temp === t);
        if (!lines.length) continue;
        st.parts++;
        floorParts.push({
          order: o,
          due: dueTime(o),
          temp: t,
          lines,
          totes: totesFor(lines),
          done: (picked, sub, short) => {
            if (this.gen1) this.partDone(st, picked, sub, short);
            // 本方案：生鲜框从投放口经输送线到合流台
            else this.sim.after(180, () => this.partDone(st, picked, sub, short));
          },
        });
      }
      if (st.parts === 0) this.ready(st);
    }
    if (fallbackParts.length) this.submitFallback(fallbackParts);
    const pool = this.gen1 ? this.pools.picker : this.pools.freshPicker;
    if (!pool || !floorParts.length) return;
    for (const walk of planWalks(floorParts, this.s.online.totesPerCart)) submitWalk(pool, this.router, this.shelf, this.rng, walk, this.drop, this.pickTimes(), this.stats.walks);
  }

  /** 拣完放框的地方：上一代是暂存间，本方案是生鲜投放口（输送线送到合流台） */
  private get drop(): Pt {
    return this.gen1 ? (this.layout.poi.staging as Pt) : (this.layout.poi.freshDrop as Pt);
  }

  private pickTimes(): PickTimes {
    const o = this.s.online;
    return {
      speed: o.cartSpeed,
      perStopSec: o.perStopSec,
      perItemSec: o.perItemSec,
      dropSecPerTote: this.gen1 ? o.stageSecPerTote : 6,
      dropSecPerWalk: this.gen1 ? o.stageSecPerWalk : 20,
      substitution: 0.5,
      retrieve: (line, qty, done) => this.retrieve(line, qty, done),
    };
  }

  /**
   * 降级模式：生鲜拣选员和门店作业员（多技能员工）一起在卖场拣，一车一车轮流分给两个岗位。
   * 在门店作业员那里排在顾客在场的任务（年龄核验、配送装车、异常）之后、补货之前；在生鲜拣选员那里和生鲜拣货按备好时刻排。
   */
  private submitFallback(parts: Part[]): void {
    const pools: [Pool, number][] = [];
    if (this.pools.freshPicker) pools.push([this.pools.freshPicker, 0]);
    if (this.pools.stocker) pools.push([this.pools.stocker, -5000]);
    if (!pools.length) return;
    planWalks(parts, this.s.online.totesPerCart).forEach((walk, i) => {
      const [pool, offset] = pools[(this.fallbackTurn + i) % pools.length] as [Pool, number];
      submitWalk(pool, this.router, this.shelf, this.rng, walk, this.drop, { ...this.pickTimes(), priorityOffset: offset }, this.stats.fallback);
    });
    this.fallbackTurn++;
  }

  /** 停机开始时货格仓交出来的、还没派机器人的行：按订单和温区拼成卖场拣货的部分 */
  private fallbackDrained(reqs: LineReq[]): void {
    const groups = new Map<string, LineReq[]>();
    for (const r of reqs) {
      const key = `${r.order.id}:${r.line.sku.temp}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    const parts: Part[] = [];
    for (const list of groups.values()) {
      const first = list[0] as LineReq;
      const lines = list.map((r) => r.line);
      parts.push({
        order: first.order,
        due: dueTime(first.order),
        temp: first.line.sku.temp,
        lines,
        totes: totesFor(lines),
        // 整个部分的结果记在第一行上，其余行记 0（件数守恒）
        done: (picked, sub, short) => this.sim.after(180, () => list.forEach((r, i) => r.done(i === 0 ? { picked, sub, short } : { picked: 0, sub: 0, short: 0 }))),
      });
    }
    this.submitFallback(parts);
  }

  /**
   * 地面缺货时去后仓补取：上一代靠库存记录找（记录不准率 0.25、漏找 0.1，找一次 3–7 分钟）；
   * 本方案的后仓有 RFID，直接知道在哪个托盘上（找一次约 1 分钟，基本不会白跑）。
   */
  private retrieve(line: OrderLine, qty: number, done: (got: number) => void): void {
    const pool = this.pools.stocker;
    if (!pool || !this.shelf.backroomHas(line.sku)) {
      done(0);
      return;
    }
    const found = this.rng.chance(this.gen1 ? 0.65 : 0.95);
    const stock = nearest(this.layout.poi.backroomStock, line.sku.face);
    const drop = this.gen1 ? (this.layout.poi.staging as Pt) : (this.layout.poi.consolidation as Pt);
    pool.submit({
      priority: -1,
      label: '后仓补取',
      steps: () => [
        { kind: 'walk', to: stock, act: '去后仓补取' },
        { kind: 'work', sec: this.gen1 ? 180 + this.rng.next() * 240 : 45 + this.rng.next() * 30, act: '找货' },
        ...(found ? [{ kind: 'walk' as const, to: drop, act: '送到订单' }] : []),
      ],
      onDone: () => done(found ? qty : 0),
    });
  }

  private partDone(st: State, picked: number, sub: number, short: number): void {
    st.picked += picked;
    st.substituted += sub;
    st.short += short;
    if (--st.parts > 0) return;
    // 本方案：一小部分订单要人工处理（替代确认、破损更换）后才算好
    if (!this.gen1 && this.pools.handoff && this.rng.chance(this.s.pickup.exceptionShare)) {
      this.stats.exceptions++;
      const at = this.layout.poi.consolidation as Pt;
      // 面向顾客的任务排在补货前面（补货的优先级是 1–10，数字小的先做；这里减一个大数）
      this.pools.handoff.submit({
        priority: dueTime(st.o) / 60 - 20000,
        label: '处理异常',
        steps: () => {
          this.handoffSec += 360;
          return [
            { kind: 'walk', to: at, act: '去合流台' },
            { kind: 'work', sec: 300, act: '处理异常' },
          ];
        },
        onDone: () => this.ready(st),
      });
      return;
    }
    this.ready(st);
  }

  private ready(st: State): void {
    st.readyAt = this.sim.now;
    this.trace.event(this.sim.now, 'order', `订单 ${st.o.id + 1} 已备好（${st.totes} 框）`);
    if (st.mode === 'delivery') return;
    if (st.mode === 'locker') this.requestLocker(st);
    if (st.called) this.dispatchPickup(st);
  }

  /** 顾客发出「我在路上」 / 位置估算：上一代提前 5 分钟开始准备；本方案的送框小车提前 4 分钟出发 */
  private onNotice(st: State): void {
    const lead = this.gen1 ? this.s.online.prepLeadSec : this.s.pickup.cartLeadSec;
    this.sim.at(Math.max(this.sim.now, st.o.arrival - lead), () => {
      st.called = true;
      if (!Number.isNaN(st.readyAt)) this.dispatchPickup(st);
    });
  }

  private onArrival(st: State): void {
    st.called = true;
    this.carArrives(st);
    if (st.mode === 'locker') {
      if (st.inLocker) this.selfPickup(st);
      else st.customerWaiting = true;
      return;
    }
    if (!Number.isNaN(st.readyAt)) this.dispatchPickup(st);
  }

  private dispatchPickup(st: State): void {
    if (st.handoffQueued || st.mode === 'locker' || st.mode === 'delivery') return;
    st.handoffQueued = true;
    if (st.mode === 'curbside') this.curbside(st);
    else this.drive(st);
  }

  /** 上一代：员工从暂存间取框，推到路边车位，核验后装车 */
  private curbside(st: State): void {
    const pool = this.pools.dispenser as Pool;
    const staging = this.layout.poi.staging as Pt;
    const bays = this.layout.poi.curbsideBays;
    const bay = bays[this.bayTurn++ % bays.length] as Pt;
    const o = this.s.online;
    pool.submit({
      priority: st.o.arrival / 60 - 10000,
      label: '路边交付',
      steps: () => [
        { kind: 'walk', to: staging, act: '回暂存间' },
        // 找齐各温区的框、核对订单和替代品
        { kind: 'work', sec: 45 + o.handoffSecPerTote * st.totes, act: '取框核对' },
        { kind: 'call', fn: () => (st.leftCooling = this.sim.now) },
        { kind: 'walk', to: bay, speed: o.walkSpeed, outdoors: true, act: '送到车位' },
        { kind: 'until', t: st.o.arrival, act: '等顾客' },
        { kind: 'work', sec: o.verifySec + o.loadSecPerTote * st.totes, act: '核验装车' },
        { kind: 'call', fn: () => this.finish(st) },
        { kind: 'walk', to: staging, speed: o.walkSpeed, outdoors: true, act: '返回' },
        { kind: 'work', sec: 30, act: '还推车' },
      ],
    });
  }

  /** 本方案：送框小车从合流台把框送到免下车取货车位；年龄限制商品由员工到车边核验 */
  private drive(st: State): void {
    const carts = this.pools.carts as Pool;
    const hub = this.layout.poi.consolidation as Pt;
    const bays = this.layout.poi.driveBays;
    const bay = bays[this.bayTurn++ % bays.length] as Pt;
    const p = this.s.pickup;
    let verified = !st.o.ageRestricted;
    let cartAt = false;
    const tryFinish = () => {
      if (verified && cartAt && Number.isNaN(st.doneAt)) this.finish(st);
    };
    if (st.o.ageRestricted && this.pools.handoff) {
      const hatch = this.layout.poi.driveHatch as Pt;
      this.pools.handoff.submit({
        priority: st.o.arrival / 60 - 10000,
        label: '年龄核验',
        steps: () => {
          this.handoffSec += 120;
          return [
          { kind: 'walk', to: hatch, act: '去免下车取货口' },
          { kind: 'until', t: st.o.arrival, act: '等顾客' },
          { kind: 'work', sec: 40, act: '核验证件' },
          {
            kind: 'call',
            fn: () => {
              verified = true;
              tryFinish();
            },
          },
        ];
        },
      });
    }
    carts.submit({
      priority: st.o.arrival / 60,
      label: '送框到车边',
      steps: () => [
        { kind: 'walk', to: hub, act: '回合流台' },
        { kind: 'work', sec: p.cartLoadSec, act: '装框' },
        { kind: 'call', fn: () => (st.leftCooling = this.sim.now) },
        { kind: 'walk', to: bay, outdoors: true, act: '送到车位' },
        { kind: 'until', t: st.o.arrival, act: '等顾客' },
        { kind: 'work', sec: p.driveCustomerSec + p.driveCustomerSecPerTote * st.totes, act: '顾客取货' },
        {
          kind: 'call',
          fn: () => {
            cartAt = true;
            tryFinish();
          },
        },
        { kind: 'walk', to: hub, outdoors: true, act: '返回' },
      ],
    });
  }

  /** 本方案：订单合流完成后，装柜机器人把框放进对应温区的格口 */
  private requestLocker(st: State): void {
    const need = this.compartments(st);
    if (TEMPS.some((t) => need[t] > this.lockerFree[t])) {
      this.lockerQueue.push(st);
      this.stats.lockerQueuedMax = Math.max(this.stats.lockerQueuedMax, this.lockerQueue.length);
      return;
    }
    for (const t of TEMPS) {
      this.lockerFree[t] -= need[t];
      st.lockerReserved[t] = need[t];
      const used = this.s.pickup.lockers[t] - this.lockerFree[t];
      this.stats.lockerPeak[t] = Math.max(this.stats.lockerPeak[t], used);
    }
    const loaders = this.pools.loaders as Pool;
    const hub = this.layout.poi.consolidation as Pt;
    const slot = nearest(this.layout.poi.lockerLoad, { x: hub.x, y: hub.y + (st.o.id % 7) - 3 });
    loaders.submit({
      priority: st.o.arrival / 60,
      label: '装柜',
      steps: () => [
        { kind: 'walk', to: hub, act: '取框' },
        { kind: 'walk', to: slot, act: '装柜' },
        { kind: 'work', sec: this.s.pickup.loaderSecPerTote * st.totes, act: '装柜' },
        {
          kind: 'call',
          fn: () => {
            st.inLocker = true;
            if (st.customerWaiting) this.selfPickup(st);
          },
        },
      ],
    });
  }

  private compartments(st: State): Record<Temp, number> {
    const per = this.s.pickup.totesPerCompartment;
    return { ambient: Math.ceil(st.totesByTemp.ambient / per), chilled: Math.ceil(st.totesByTemp.chilled / per), frozen: Math.ceil(st.totesByTemp.frozen / per) };
  }

  /** 顾客在自提柜扫码取货 */
  private selfPickup(st: State): void {
    const p = this.s.pickup;
    this.sim.after(p.lockerPickupSec + p.lockerPickupSecPerTote * st.totes, () => {
      st.leftCooling = this.sim.now;
      this.finish(st);
      for (const t of TEMPS) this.lockerFree[t] += st.lockerReserved[t];
      // 释放格口后，排队的订单按先后装柜
      const waiting = this.lockerQueue.splice(0);
      for (const w of waiting) this.requestLocker(w);
    });
  }

  /**
   * 动画：自提顾客开车进来（路边车位 / 免下车取货车位 / 自提柜外侧），拿到货以后开走。
   * 只记轨迹，不用随机数、不加事件，打开动画不会改变仿真结果。
   */
  private carArrives(st: State): void {
    if (!this.trace.enabled || st.mode === 'delivery') return;
    const p = this.layout.poi;
    const bays = st.mode === 'curbside' ? p.curbsideBays : st.mode === 'drive' ? p.driveBays : p.lockerAccess;
    if (!bays.length) return;
    // 选最早空出来的车位
    let bay = bays[0] as Pt;
    let best = Infinity;
    for (const b of bays) {
      const free = this.bayFree.get(`${b.x},${b.y}`) ?? 0;
      if (free < best) {
        best = free;
        bay = b;
      }
    }
    this.bayFree.set(`${bay.x},${bay.y}`, Infinity);
    const agent = this.trace.add('car', `顾客车辆（订单 ${st.o.id + 1}）`);
    const t = st.o.arrival;
    this.trace.move(agent, t - 70, t, this.router.path(CAR_ENTRY, bay, true), '开进来取货');
    this.cars.set(st.o.id, { agent, bay });
  }

  private carLeaves(st: State): void {
    const car = this.cars.get(st.o.id);
    if (!car) return;
    const now = this.sim.now;
    this.trace.dwell(car.agent, st.o.arrival, now + 20, car.bay, st.mode === 'locker' ? '在自提柜取货' : '等交付');
    this.trace.move(car.agent, now + 20, now + 80, this.router.path(car.bay, CAR_EXIT, true), '离开');
    this.bayFree.set(`${car.bay.x},${car.bay.y}`, now + 40);
    this.cars.delete(st.o.id);
  }

  /** 配送：每班车出发时，把已经备好的配送单装上车 */
  private departure(t: number): void {
    // 动画：这一班有配送单时，配送车在卸货门装车、然后开走
    if (this.trace.enabled && this.states.some((st) => st.mode === 'delivery' && scheduledDeparture(st.o.slot) === t)) {
      const dock = (this.layout.poi.docks[0] as { outside: Pt }).outside;
      const van = this.trace.add('van', `配送车（${Math.round(t / H)} 点班）`);
      this.trace.move(van, t - 15 * 60, t - 13 * 60, this.router.path(CAR_EXIT, dock, true), '来装车');
      this.trace.dwell(van, t - 13 * 60, t + 25 * 60, dock, '装车');
      this.trace.move(van, t + 25 * 60, t + 27 * 60, this.router.path(dock, CAR_EXIT, true), '出发配送');
    }
    const pool = this.gen1 ? this.pools.dispenser : this.pools.handoff;
    if (!pool) return;
    const from = this.gen1 ? (this.layout.poi.staging as Pt) : (this.layout.poi.consolidation as Pt);
    const dock = (this.layout.poi.docks[0] as { inside: Pt }).inside;
    for (const st of this.states) {
      if (st.mode !== 'delivery' || st.loaded || Number.isNaN(st.readyAt)) continue;
      const sched = scheduledDeparture(st.o.slot);
      if (sched > t) continue;
      st.loaded = true;
      pool.submit({
        priority: t / 60 - 15000,
        label: '配送装车',
        steps: () => {
          if (!this.gen1) this.handoffSec += this.s.online.deliveryLoadSec + 60;
          return [
          { kind: 'walk', to: from, act: '取框' },
          { kind: 'walk', to: dock, act: '装车' },
          { kind: 'work', sec: this.s.online.deliveryLoadSec, act: '装车' },
          { kind: 'call', fn: () => this.finish(st, sched) },
        ];
        },
      });
    }
  }

  private finish(st: State, departure?: number): void {
    if (!Number.isNaN(st.doneAt)) return;
    st.doneAt = this.sim.now;
    this.carLeaves(st);
    const wait = st.mode === 'delivery' ? 0 : Math.max(0, st.doneAt - st.o.arrival) / 60;
    const dwell = st.mode === 'delivery' || st.mode === 'locker' ? 0 : Number.isNaN(st.leftCooling) ? 0 : (st.doneAt - st.leftCooling) / 60;
    const due = departure ?? dueTime(st.o);
    const h = Math.min(23, Math.floor(this.sim.now / H));
    this.stats.doneByHour[h] = (this.stats.doneByHour[h] as number) + 1;
    this.stats.waitByHour[h] = (this.stats.waitByHour[h] as number) + wait;
    this.trace.event(this.sim.now, 'pickup', st.mode === 'delivery' ? `订单 ${st.o.id + 1} 装上配送车` : `订单 ${st.o.id + 1} 已交给顾客（等了 ${wait.toFixed(1)} 分钟）`);
    this.outcomes.push({
      id: st.o.id,
      slot: st.o.slot,
      mode: st.mode,
      items: st.o.items,
      picked: st.picked,
      substituted: st.substituted,
      short: st.short,
      totes: st.totes,
      readyAt: st.readyAt,
      doneAt: st.doneAt,
      waitMin: wait,
      dwellMin: dwell,
      onTime: st.readyAt <= due + 1,
    });
  }

  /** 收尾：没有交付的订单也记一笔（按未按时） */
  close(t: number): void {
    for (const st of this.states) {
      if (!Number.isNaN(st.doneAt)) continue;
      this.outcomes.push({
        id: st.o.id,
        slot: st.o.slot,
        mode: st.mode,
        items: st.o.items,
        picked: st.picked,
        substituted: st.substituted,
        short: st.short + Math.max(0, st.o.items - st.picked - st.substituted - st.short),
        totes: st.totes,
        readyAt: st.readyAt,
        doneAt: NaN,
        waitMin: st.mode === 'delivery' ? 0 : Math.max(0, t - st.o.arrival) / 60,
        dwellMin: 0,
        onTime: false,
      });
    }
  }
}

/** 配送单排定的班次：时段开始前最近的一班 */
