import { STORE } from '../../src/region/network';
import { FAMILIES } from '../../src/region/products';
import type { Board, BoardOp } from '../../src/sim/board';
import { HOUR_W } from '../../src/sim/engine';
import type { WSeg, WVehicle } from '../../src/sim/trace';
import type { Field, FVehicle, Incident, StopResult } from '../../src/twin/field';
import type { Loop } from '../../src/twin/loop';
import { LIMIT, SETPOINT, type ReeferZone } from '../../src/twin/models';
import { isDcUnload, isLoad, isMoving, isStoreUnload, isWait } from '../../src/twin/track';
import type { Twin } from '../../src/twin/twin';
import type { Cmd, Msg } from '../../src/twin/types';
import type { AdapterName, AdapterStats, FeedItem, VehicleReg } from './common';
import { ContainerBook } from './edi';

/**
 * 「看到的现场」：数据来自记录或外部系统时，代替闭环里模拟的现场（Field）。
 *
 * 闭环（Loop）照常一分钟一步：这里每一步把这一步该到的数据交给它（记录按孪生当时在哪一步收到；外部系统按数据自己的时刻），
 * 孪生照常估计、推演、出建议卡、按自动执行的范围发指令。指令改变不了现实（现实是记录或外部系统），
 * 记下来、换算成外部系统的指令另外发出去；指令导致的新车（救援车、追加补货车）和改了的计划，由记录或运输管理系统登记。
 *
 * 实时接入（ingest）：外部系统推来的数据按数据自己的时刻排队，孪生走到那一步时交给它。和通信质量的通道一样：
 * 孪生已经走过了时刻的（晚到的）下一步交出去、按发生的时刻补记；比已经交给孪生的同一辆车的定位还旧的（过时的）不用；
 * 晚到、顺序乱、过时的条数记在各个接口的统计里。晚到的门磁、盘点、故障不改「现在」的状态（比已经用上的还旧）。
 *
 * 孪生服务的接口照常要的「现场」的样子（车在哪、门被谁占着、门店库存、累计的结果）这里按数据推出来：
 * - 车：位置按孪生估计的进度（计划时钟 τ = 此刻 − 估计的延误），抛锚、冷机读数、电量按车载终端；
 * - 月台门、门店收货口：按门磁；门店库存：最近一次盘点减去之后的收银；本店的箱：按港口 EDI 的事件；
 * - 累计的结果：迟到按门店收货口开门（开始卸货）的时刻和收货截止比；超温按冷机读数（每 5 分钟一条）；
 *   缺货按看到的库存；处理措施的钱按执行的做法；
 * - 等月台门、等收货口按门磁推：车到了配送中心（到达，或者当天第一次有数据、计划从装车开始）或门店（到达），
 *   按计划该装卸的时刻到了（计划里先在场地停一会儿的往后推，门店还没开门的等到开门），它的月台门被别的车占着
 *   （门店：收货口全被别的车占着），从那时起到它自己的门（收货口）打开算等的时间。收货口的个数按设施配置，数据里出现更大的编号按数据。
 */
export interface ObservedFeed {
  /** 回放的记录：步（那一步开始的时刻）→ 这一步孪生收到的数据 */
  steps?: Map<number, FeedItem[]>;
  /** 外部系统的数据：按数据自己的时刻排好 */
  items?: FeedItem[];
  vehicles: VehicleReg[];
}

/** 在配送中心或门店场地上等着轮到装卸的车 */
interface YardWait {
  /** door = 等配送中心的月台门，dock = 等门店的收货口 */
  kind: 'door' | 'dock';
  place: string;
  /** 按计划该开始装卸的时刻 */
  ready: number;
  /** 等的时间记到了哪个时刻 */
  acc: number;
  /** 上一步看的时候门（收货口）是不是被别的车占着 */
  blocked: boolean;
}

const isStoreDock = (door: string) => /^S\d\d-\d$/.test(door);
const SLOTS = (26 * 3600) / 300;

/** 计划里车在 place 停的那一站（连续的停留段），按计划时钟最接近 tau 的；返回段的下标范围 */
function stayAt(v: WVehicle, place: string, tau: number): { i0: number; i1: number } | undefined {
  const segs = v.segs;
  const stay = (i: number) => {
    const s = segs[i];
    return !!s && !isMoving(s) && s.place === place;
  };
  let best: { i0: number; i1: number } | undefined;
  for (let i = 0; i < segs.length; i++) {
    if (!stay(i) || stay(i - 1)) continue;
    let j = i;
    while (stay(j + 1)) j++;
    if (!best || Math.abs((segs[i] as WSeg).t0 - tau) < Math.abs((segs[best.i0] as WSeg).t0 - tau)) best = { i0: i, i1: j };
  }
  return best;
}

export class ObservedField {
  readonly fv: FVehicle[] = [];
  readonly msgs: Msg[] = [];
  readonly stopResults: StopResult[] = [];
  readonly kpi = { lateStops: 0, lateMin: 0, hotMin: 0, shortMin: 0, lostUnits: 0, doorWaitMin: 0, dockWaitMin: 0, extraKm: 0, cost: 0, notified: 0 };
  readonly by = { door: new Map<number, number>(), dock: new Map<number, number>(), hot: new Map<number, Float32Array>(), short: new Map<string, Float32Array>() };
  readonly stock = new Map<string, number>();
  readonly demand = new Map<string, number>();
  readonly extendTo = new Map<string, number>();
  readonly doors = new Map<string, number>();
  readonly storeDocks = new Map<string, number>();
  readonly d: { incidents: Incident[] } = { incidents: [] };
  /** 孪生发出去的指令（改变不了现实，只记下来） */
  readonly sent: Cmd[] = [];
  /** 本店的箱在港口的状态（港口 EDI 的事件） */
  readonly boxes = new ContainerBook();
  /** 实时接进来的数据里最新的时刻（孪生服务让孪生最多走到这里减去允许的晚到） */
  newest = -Infinity;
  private twin: Twin | undefined;
  private readonly pending: VehicleReg[];
  private next = 0;
  private readonly byVid = new Map<number, FVehicle>();
  private readonly opOf = new Map<number, BoardOp>();
  /** 实时接进来、还没到时候交给孪生的数据（按数据的时刻排，同一时刻按收到的先后） */
  private readonly queue: FeedItem[] = [];
  private stepped = false;
  private readonly lastGps = new Map<number, number>();
  private readonly seen = new Set<number>();
  private readonly yard = new Map<number, YardWait>();
  /** 每辆车在每个门（收货口）最后一条门磁的时刻、现在占着门的车从什么时候起、最后一次被关上（谁、什么时候）；门店有几个收货口（数据里见到的最大编号） */
  private readonly doorEv = new Map<string, number>();
  private readonly heldSince = new Map<string, number>();
  private readonly lastClose = new Map<string, { t: number; vid: number }>();
  private readonly docksSeen = new Map<string, number>();
  /** 每个商品族最近一次用上的盘点、每辆车最近一次修好的时刻（更旧的晚到数据不改现在的状态） */
  private readonly countAt = new Map<string, number>();
  private readonly fixedAt = new Map<number, number>();

  constructor(
    base: Field,
    private readonly feed: ObservedFeed,
    board: Board,
    private readonly costOf: (c: Cmd) => number,
    private readonly stats: ReadonlyMap<AdapterName, AdapterStats>,
  ) {
    for (const o of board.ops) if (o.vehicle >= 0) this.opOf.set(o.vehicle, o);
    for (const f of base.fv) this.add(f.vid, f.v, f.op, f.reefer?.zone);
    for (const [k, v] of base.stock) this.stock.set(k, v);
    for (const [k, v] of base.demand) this.demand.set(k, v);
    this.pending = [...feed.vehicles].sort((a, b) => a.eff - b.eff);
  }

  /** 接上孪生（按它的估计放车、登记救援车接的是哪辆车的货） */
  attach(twin: Twin): void {
    this.twin = twin;
  }

  /** 实时接进来、还在排队的条数 */
  get queued(): number {
    return this.queue.length;
  }

  private add(vid: number, v: FVehicle['v'], op: BoardOp | undefined, zone: ReeferZone | undefined, extra?: FVehicle['extra']): FVehicle {
    const f: FVehicle = {
      vid,
      v,
      op,
      tau: v.segs[0]?.t0 ?? 0,
      started: false,
      finished: false,
      door: op?.door,
      atDoor: false,
      waitingDoor: false,
      loadLeft: 0,
      reefer: zone ? { zone, st: { air: SETPOINT[zone], product: SETPOINT[zone] + 0.4, cool: false }, set: SETPOINT[zone], seal: false, comp: true } : undefined,
      soc: v.kind === 'ev' ? 0.94 : undefined,
      done: new Set(),
      ...(extra ? { extra } : {}),
    };
    this.fv.push(f);
    this.byVid.set(vid, f);
    return f;
  }

  /** 登记一辆新车或者改了的计划 */
  private register(r: VehicleReg): void {
    const i = this.pending.indexOf(r);
    if (i >= 0) this.pending.splice(i, 1);
    const f = this.byVid.get(r.vid);
    if (f) {
      f.v = r.v;
      return;
    }
    const of = r.extra?.of !== undefined ? this.byVid.get(r.extra.of) : undefined;
    const fam = r.extra?.fam ? FAMILIES.find((x) => x.key === r.extra?.fam) : undefined;
    const zone: ReeferZone | undefined = r.extra?.kind === 'rescue' ? of?.reefer?.zone : fam?.temp === 'chilled' ? 'chilled' : fam?.temp === 'frozen' ? 'frozen' : undefined;
    this.add(r.vid, r.v, r.extra?.of !== undefined ? this.opOf.get(r.extra.of) : undefined, zone, r.extra);
    if (r.extra?.kind === 'rescue' && r.extra.of !== undefined && this.twin && !this.twin.rescueOf.has(r.vid)) this.twin.rescueOf.set(r.vid, r.extra.of);
  }

  /**
   * 实时接进来的一批（接口解析好的数据和新行程）：按数据自己的时刻排进队列，孪生走到那一步时交给它；
   * 新行程按生效的时刻登记（晚到的下一步登记）。
   */
  ingest(items: readonly FeedItem[], vehicles: readonly VehicleReg[] = []): void {
    for (const it of items) {
      this.stats.get(it.src)?.received(it.m);
      this.newest = Math.max(this.newest, it.m.t);
      this.queue.push(it);
    }
    // 稳定排序：同一时刻按收到的先后（基本有序时很快）
    if (items.length) this.queue.sort((a, b) => a.m.t - b.m.t);
    for (const r of vehicles) {
      this.newest = Math.max(this.newest, r.eff);
      this.pending.push(r);
    }
    if (vehicles.length) this.pending.sort((a, b) => a.eff - b.eff);
  }

  /** 往前走一步：先登记到时候的车，再把这一步该到的数据交出去（闭环随后交给孪生） */
  step(t: number, dt: number): void {
    const t1 = t + dt;
    for (const r of this.pending.filter((x) => x.eff <= t)) this.register(r);
    const batch: FeedItem[] = [];
    if (this.feed.steps) batch.push(...(this.feed.steps.get(t) ?? []));
    else {
      const items = this.feed.items ?? [];
      while (this.next < items.length && (items[this.next] as FeedItem).m.t <= t1) batch.push(items[this.next++] as FeedItem);
    }
    for (const it of batch) this.deliver(it, t1);
    // 实时接进来的：到时候的，加上晚到的
    let k = 0;
    while (k < this.queue.length && (this.queue[k] as FeedItem).m.t <= t1) k++;
    for (const it of k ? this.queue.splice(0, k) : []) {
      const st = this.stats.get(it.src);
      // 晚到：孪生已经走过了它的那一步
      if (st && (it.m.t < t || (it.m.t === t && this.stepped))) st.late++;
      // 过时的定位：孪生只按最新的位置估计
      if (it.m.kind === 'gps' && it.m.t <= (this.lastGps.get(it.m.vid) ?? -Infinity)) {
        if (st) st.stale++;
        continue;
      }
      this.deliver(it, t1);
    }
    this.waits(t1);
    this.stepped = true;
    if (t1 % 300 === 0) this.tally(t1);
  }

  private deliver(it: FeedItem, t1: number): void {
    if (it.m.kind === 'gps') this.lastGps.set(it.m.vid, Math.max(this.lastGps.get(it.m.vid) ?? -Infinity, it.m.t));
    this.msgs.push(it.m);
    this.stats.get(it.src)?.ingested(it.m, t1);
    this.observe(it.m);
  }

  /** 孪生发出的指令：记下来；记录里这一步因为这条指令出现的车（救援车、追加补货车、改了的计划）马上登记 */
  apply(c: Cmd, t: number): void {
    this.sent.push(c);
    this.kpi.cost += this.costOf(c);
    const match = this.pending.find(
      (r) =>
        r.eff === t &&
        (c.kind === 'rescue' ? r.extra?.kind === 'rescue' && r.extra.of === c.vid : c.kind === 'restock' ? r.extra?.kind === 'restock' && r.extra.fam === c.fam : c.kind === 'divert' || c.kind === 'resequence' ? !!r.replan && r.vid === c.vid : false),
    );
    if (match) this.register(match);
  }

  /** 每走一步以后（孪生收完这一步的数据）：按孪生的估计更新每辆车的进度、是不是在路上、收没收车 */
  sync(t: number): void {
    const twin = this.twin;
    if (!twin) return;
    for (const f of this.fv) {
      const e = twin.v.get(f.vid);
      if (!e?.seen || f.finished) continue;
      f.started = true;
      const est = twin.estimate(f.vid, t);
      if (est) f.tau = t - est.delay;
      const last = f.v.segs[f.v.segs.length - 1];
      if (e.finished || (last && f.tau >= last.t1)) {
        f.finished = true;
        f.endAt = t;
        if (f.door && this.doors.get(f.door) === f.vid) this.doors.delete(f.door);
      }
      // 停在路边等救援车（货转走以前）
      const rescuer = [...twin.rescueOf].find(([, of]) => of === f.vid)?.[0];
      if (f.broken && rescuer !== undefined) f.heldBy = rescuer;
    }
  }

  private closeOf(store: string, op: BoardOp | undefined): number {
    const base = (op?.stops ?? []).find((s) => s.key === store)?.close ?? 12;
    return Math.max(base * 3600, this.extendTo.get(store) ?? 0);
  }

  private observe(m: Msg): void {
    if ('vid' in m && m.vid >= 0 && !(m.kind === 'event' && m.ev === 'eta')) this.firstSeen(m);
    switch (m.kind) {
      case 'gps': {
        const f = this.byVid.get(m.vid);
        if (f) f.started = true;
        return;
      }
      case 'door': {
        const store = isStoreDock(m.door);
        const map = store ? this.storeDocks : this.doors;
        const site = m.door.slice(0, 3);
        if (store) this.docksSeen.set(site, Math.max(this.docksSeen.get(site) ?? 0, Number(m.door.slice(4))));
        // 晚到的门磁不改门现在被谁占着：比这辆车在这个门已经收到的还旧，或者（开门）比占着门的车开门还早
        const key = `${m.door} ${m.vid}`;
        const occ = map.get(m.door);
        const fresh = m.t >= (this.doorEv.get(key) ?? -Infinity) && (!m.open || occ === undefined || occ === m.vid || m.t >= (this.heldSince.get(m.door) ?? -Infinity));
        if (fresh) this.doorEv.set(key, m.t);
        if (!m.open) {
          if (fresh && occ === m.vid) map.delete(m.door);
          if (fresh) this.lastClose.set(m.door, { t: m.t, vid: m.vid });
          return;
        }
        if (fresh) {
          map.set(m.door, m.vid);
          this.heldSince.set(m.door, m.t);
        }
        this.docked(m.vid, m.door, m.t);
        if (!store) return;
        // 门店收货口开门 = 开始卸货：按收货截止判迟到（追加补货车不算）
        const f = this.byVid.get(m.vid);
        if (f?.extra?.kind === 'restock') return;
        const op = this.opOf.get(m.vid) ?? (f?.extra?.of !== undefined ? this.opOf.get(f.extra.of) : undefined);
        const close = this.closeOf(site, op);
        const late = Math.max(0, (m.t - close) / 60);
        this.stopResults.push({ vid: m.vid, store: site, t: m.t, close, late });
        if (late > 0.5) {
          this.kpi.lateStops++;
          this.kpi.lateMin += late;
        }
        return;
      }
      case 'temp': {
        const f = this.byVid.get(m.vid);
        if (!f?.reefer) return;
        f.reefer.st = { air: m.air, product: m.product, cool: m.cool };
        f.reefer.set = m.set;
        // 车上有要送门店的货、读数超过上限：这 5 分钟算超温
        const hasLoad = (f.op?.stops ?? []).some((s) => !f.done.has(s.key)) && (f.extra?.kind !== 'rescue' || f.tau >= (f.extra.loadAt ?? 0));
        if (hasLoad && m.product > LIMIT[f.reefer.zone]) {
          this.kpi.hotMin += 5;
          tally(this.by.hot, f.vid, m.t, 5);
        }
        return;
      }
      case 'soc': {
        const f = this.byVid.get(m.vid);
        if (f) f.soc = m.soc;
        return;
      }
      case 'stock':
        // 晚到的盘点比已经用上的那次还旧：不用
        if (m.t < (this.countAt.get(m.fam) ?? -Infinity)) return;
        this.countAt.set(m.fam, m.t);
        this.stock.set(m.fam, m.units);
        return;
      case 'pos':
        // 盘点以前的收银已经算在盘点里了
        if (m.t < (this.countAt.get(m.fam) ?? -Infinity)) return;
        this.stock.set(m.fam, Math.max(0, (this.stock.get(m.fam) ?? 0) - m.units));
        return;
      case 'traffic': {
        const x = this.d.incidents.find((i) => i.id === m.id);
        if (m.end) {
          if (x) x.t1 = m.t;
        } else if (!x) this.d.incidents.push({ id: m.id, x: m.x, z: m.z, r: m.r, f: m.factor, t0: m.t, t1: m.until, text: m.text });
        return;
      }
      case 'event': {
        this.boxes.observe(m);
        if (m.vid < 0) {
          // 门店确认顺延收货：按发出去的通知把截止挪后
          if (m.ev === 'ack' && m.place && /确认/.test(m.note ?? '')) {
            const c = [...this.sent].reverse().find((x) => x.kind === 'notifyStore' && x.store === m.place);
            if (c && c.kind === 'notifyStore') this.extendTo.set(m.place, Math.max(this.extendTo.get(m.place) ?? 0, c.until));
            this.kpi.notified++;
          }
          return;
        }
        const f = this.byVid.get(m.vid);
        if (!f) return;
        if (m.ev === 'depart' || m.ev === 'arrive') f.started = true;
        if (m.ev === 'arrive' && m.place) this.arrived(f, m.place, m.t);
        if ((m.ev === 'depart' || m.ev === 'leave') && this.yard.get(f.vid)?.place === m.place) this.yard.delete(f.vid);
        if (m.ev === 'leave' && m.place) f.done.add(m.place);
        // 晚到的故障（比最近一次修好还早）不再让车抛锚
        if (m.ev === 'fault' && m.code !== 'COMP' && m.t >= (this.fixedAt.get(m.vid) ?? -Infinity)) f.broken = { from: m.t, until: Infinity };
        if (m.ev === 'fault' && m.code === 'COMP' && f.reefer) f.reefer.comp = false;
        if (m.ev === 'fixed') {
          this.fixedAt.set(m.vid, Math.max(this.fixedAt.get(m.vid) ?? -Infinity, m.t));
          f.broken = undefined;
          f.heldBy = undefined;
        }
        if (m.ev === 'done' && /货已转到/.test(m.note ?? '')) f.heldBy = undefined;
        const hold = m.ev === 'ack' ? /(\d+) 分钟后再进门店/.exec(m.note ?? '') : null;
        if (hold) f.holdUntil = m.t + Number(hold[1]) * 60;
        return;
      }
      default:
        return;
    }
  }

  // —— 等月台门、等收货口：按门磁推 ——

  /** 计划这一站里第一个要占门（收货口）的段：到了以后要先等多久（计划里先在场地停的；门店没开门的等到开门） */
  private readyAt(f: FVehicle, run: { i0: number; i1: number }, place: string, t: number): number | undefined {
    const dc = place === 'DC';
    let k = run.i0;
    while (k <= run.i1 && !(dc ? isLoad(f.v.segs[k] as WSeg) || isDcUnload(f.v.segs[k] as WSeg) : isStoreUnload(f.v.segs[k] as WSeg))) k++;
    if (k > run.i1) return undefined;
    const open = dc ? 0 : ((f.op?.stops ?? []).find((s) => s.key === place)?.open ?? 0) * 3600;
    let ready = t;
    for (let i = run.i0; i < k; i++) {
      const s = f.v.segs[i] as WSeg;
      ready += isWait(s) ? Math.min(s.t1 - s.t0, Math.max(0, open - ready)) : s.t1 - s.t0;
    }
    return ready;
  }

  /** 车到了配送中心或门店：这一站按计划要占门（收货口）的，记下它从什么时候起该装卸了 */
  private arrived(f: FVehicle, place: string, t: number): void {
    const dc = place === 'DC';
    if ((dc && (!f.door || f.op?.preload)) || (!dc && !/^S\d\d$/.test(place))) return;
    const run = stayAt(f.v, place, f.tau);
    const ready = run ? this.readyAt(f, run, place, t) : undefined;
    if (ready !== undefined) this.yard.set(f.vid, { kind: dc ? 'door' : 'dock', place, ready, acc: ready, blocked: false });
  }

  /** 当天第一次收到这辆车的数据：计划从配送中心的门上开始（先装车、先卸货）的，从这时起算它该上门了（第一条就是开门的没等） */
  private firstSeen(m: Extract<Msg, { vid: number }>): void {
    if (this.seen.has(m.vid)) return;
    this.seen.add(m.vid);
    const f = this.byVid.get(m.vid);
    const s0 = f?.v.segs[0];
    if (!f?.door || f.op?.preload || m.kind === 'door' || !s0 || isMoving(s0) || s0.place !== 'DC') return;
    const run = stayAt(f.v, 'DC', s0.t0);
    const ready = run?.i0 === 0 ? this.readyAt(f, run, 'DC', m.t) : undefined;
    if (ready === undefined) return;
    // 不早于计划该上门的时刻；前一天就装完车、零点已经在路上的车不算
    const door = f.v.segs.find((s) => isLoad(s) || isDcUnload(s)) as WSeg;
    if (m.t > door.t1) return;
    const at = Math.max(ready, door.t0);
    this.yard.set(f.vid, { kind: 'door', place: 'DC', ready: at, acc: at, blocked: false });
  }

  /** 此刻挡着它的：配送中心看它的月台门被不被别的车占着，门店看收货口是不是全被别的车占着 */
  private blockedNow(f: FVehicle, y: YardWait): boolean {
    if (y.kind === 'door') {
      const occ = f.door ? this.doors.get(f.door) : undefined;
      return occ !== undefined && occ !== f.vid;
    }
    let busy = 0;
    for (const [d, v] of this.storeDocks) if (v !== f.vid && d.startsWith(`${y.place}-`)) busy++;
    return busy >= Math.max(STORE.docks, this.docksSeen.get(y.place) ?? 0);
  }

  /** 挡着它的车最近一次让出门（收货口）的时刻 */
  private freedAt(f: FVehicle, y: YardWait): number | undefined {
    let at: number | undefined;
    for (const [d, c] of this.lastClose)
      if (c.vid !== f.vid && (y.kind === 'door' ? d === f.door : d.startsWith(`${y.place}-`))) at = Math.max(at ?? -Infinity, c.t);
    return at;
  }

  /** from 到 to 之间被挡着的秒数：此刻还挡着就是整段；上一步还挡着、这一步让出来了，算到让出来的时刻 */
  private blockedFor(f: FVehicle, y: YardWait, from: number, to: number, now: boolean): number {
    if (to <= from) return 0;
    if (now) return to - from;
    const freed = this.freedAt(f, y);
    return y.blocked && freed !== undefined && freed > from ? Math.min(freed, to) - from : 0;
  }

  private waited(f: FVehicle, kind: YardWait['kind'], sec: number): void {
    const min = sec / 60;
    if (kind === 'door') {
      this.kpi.doorWaitMin += min;
      this.by.door.set(f.vid, (this.by.door.get(f.vid) ?? 0) + min);
    } else {
      this.kpi.dockWaitMin += min;
      this.by.dock.set(f.vid, (this.by.dock.get(f.vid) ?? 0) + min);
    }
  }

  /** 车的门（收货口）开了：之前在场地被挡着的时间记上，不再算它在等 */
  private docked(vid: number, door: string, t: number): void {
    const y = this.yard.get(vid);
    const f = this.byVid.get(vid);
    if (!y || !f || (y.kind === 'dock') !== isStoreDock(door)) return;
    const from = Math.max(y.acc, y.ready);
    const sec = y.blocked ? Math.max(0, t - from) : this.blockedFor(f, y, from, t, false);
    if (sec > 0) this.waited(f, y.kind, sec);
    this.yard.delete(vid);
    if (y.kind === 'door') f.waitingDoor = false;
    else f.waitingDock = false;
  }

  /** 收完这一步的数据以后：在场地上等着的车，门（收货口）被别的车占着的这段时间记成等门（等收货口） */
  private waits(t1: number): void {
    for (const [vid, y] of this.yard) {
      const f = this.byVid.get(vid);
      if (!f || f.finished) {
        this.yard.delete(vid);
        continue;
      }
      const now = this.blockedNow(f, y);
      const from = Math.max(y.acc, y.ready);
      if (t1 > from) {
        const sec = this.blockedFor(f, y, from, t1, now);
        if (sec > 0) this.waited(f, y.kind, sec);
        y.acc = t1;
      }
      y.blocked = now;
      const waiting = now && t1 > y.ready;
      if (y.kind === 'door') f.waitingDoor = waiting;
      else f.waitingDock = waiting;
    }
  }

  /** 每 5 分钟：门店营业时段里看到的库存卖空了的商品族，这 5 分钟算缺货 */
  private tally(t: number): void {
    const h = Math.floor((t - 1) / 3600) % 24;
    if (!((HOUR_W[h] as number) > 0)) return;
    for (const f of FAMILIES) {
      if ((this.demand.get(f.key) ?? 0) <= 0) continue;
      if ((this.stock.get(f.key) ?? 0) <= 0.5) {
        this.kpi.shortMin += 5;
        tally(this.by.short, f.key, t - 300, 5);
      }
    }
  }
}

function tally<K>(m: Map<K, Float32Array>, key: K, t: number, minutes: number): void {
  let a = m.get(key);
  if (!a) m.set(key, (a = new Float32Array(SLOTS)));
  const k = Math.min(SLOTS - 1, Math.max(0, Math.floor(t / 300)));
  a[k] = (a[k] as number) + minutes;
}

/** 把闭环里模拟的现场换成「看到的现场」（闭环的其余部分不变；孪生按车辆下标查计划时查的也是这里的车） */
export function swapField(loop: Loop, observed: ObservedField): void {
  (loop as unknown as { field: ObservedField }).field = observed;
  observed.attach(loop.twin);
}
