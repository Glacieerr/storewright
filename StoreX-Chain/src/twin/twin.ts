import { buildGraph, Routes, STORE, STORES, travelHours } from '../region/network';
import { casesPerPallet, FAMILIES, type Family } from '../region/products';
import { HOUR_W } from '../sim/engine';
import { DOORS, RECEIVING_DOORS, type Board, type BoardOp } from '../sim/board';
import type { WSeg, WVehicle } from '../sim/trace';
import { ambient, filterUpdate, LIMIT, newFilter, REEFER, reeferParams, reeferStep, RESTOCK_PALLETS, SETPOINT, type DelayFilter, type ReeferParams, type ReeferZone } from './models';
import { isDcUnload, isLoad, isMoving, isStoreUnload, isWait, posAt, segAt } from './track';
import type { Cmd, IssueKind, Msg, Option, Rec } from './types';

/**
 * 孪生：只看现场发来的数据（不知道现场的真实情况），
 * 估计每辆车晚了多少、冷机里的温度、门店每个商品族还剩多少、哪樘门 / 哪个收货口被谁占着，
 * 往后推演（到店时间、温度、缺货、等门），发现问题就列出几种做法、逐个推演结果、推荐一个。
 * 它知道当天的计划（每趟车装什么、几点到）和当天的需求预测，不知道现场会出什么状况。
 *
 * 孪生自己的模型参数和现场不完全一样（保温层估计偏 8%），并在运行中校准：
 * 按小时学习车队实际比计划多花的时间（定位数据），按冷机的温度残差估计「解释不了的漏热」（疑似车门密封不严）。
 */
const MIN = 60;
const TWIN_REEFER: ReeferParams = { ...REEFER, tauIns: REEFER.tauIns * 0.92 };

interface Stop {
  key: string;
  arr: number;
  start: number;
  end: number;
  open: number;
  close: number;
  late: number;
}
interface VEst {
  vid: number;
  f: DelayFilter;
  driving: boolean;
  at?: string;
  broken: boolean;
  brokenAt: number;
  /** 抛锚那一刻晚了多少（修好时用：停着的这段时间整个算进延误） */
  dAtBreak: number;
  comp: boolean;
  done: Set<string>;
  seen: boolean;
  /** 司机停车检查过、没找到问题的次数 */
  checks: number;
  /** 在配送中心靠上月台门的时刻（还在场地等门的车没有） */
  docked?: number;
  /** 正在走（或下一段要走）的那一程从计划的第几段开始：定位只往这一程上对（来回走同一条路时不会对到去程上） */
  leg: number;
  /** 这一程出发的现实时刻和计划时刻（到了下一站就知道这一程实际比计划多花了多少） */
  legFrom?: { t: number; tau: number; clean: boolean };
  finished: boolean;
  reefer?: { zone: ReeferZone; air: number; product: number; cool: boolean; set: number; t: number; h: number; door: boolean; lastAir: number };
  soc?: number;
  /** 装车进度（moved：最近一次托数增加的时刻，长时间不涨说明卡住了） */
  load?: { door: string; done: number; total: number; t0: number; t: number; d0: number; moved: number };
  stops: Stop[];
}
export interface EtaLog {
  vid: number;
  store: string;
  tPred: number;
  eta: number;
}

export class Twin {
  readonly v = new Map<number, VEst>();
  /** 门店每个商品族：估计的库存（件）、最近卖得是预测的几倍、最后一次更新的时刻 */
  readonly stock = new Map<string, { est: number; ratio: number; t: number }>();
  readonly incidents = new Map<string, { x: number; z: number; r: number; f: number; until: number; text: string }>();
  readonly doorNow = new Map<string, number>();
  /** 每小时学到的「实际比计划多花的时间」比例 */
  readonly bias = new Array<number>(26).fill(0);
  readonly etaLog: EtaLog[] = [];
  readonly etaErr: { h: number; err: number }[] = [];
  readonly extend = new Map<string, number>();
  readonly tempErr: number[] = [];
  /** 发生过的事（判断一条没处理的建议，问题最后是不是真的发生了）：每站开始卸货的时刻、超过温度上限的车、卖空过的店 */
  private readonly unloadAt = new Map<string, number>();
  private readonly hotSeen = new Set<number>();
  private readonly outSeen = new Set<string>();
  private routes = new Routes(buildGraph());
  private byVehicle = new Map<number, BoardOp>();
  private opById = new Map<string, BoardOp>();
  /** 装车卡住一般卡多久（每次卡住又恢复时更新，起始按 20 分钟） */
  stallMean = 20 * MIN;
  private readonly directFams: Set<string>;
  /** 孪生改过门的车：新门，以及原定在门上的时段 */
  private readonly reassigned = new Map<number, { door: string; t0: number; t1: number }>();

  constructor(
    readonly ops: BoardOp[],
    readonly board: Board,
    private readonly planOf: (vid: number) => WVehicle | undefined,
    /** 当天每个商品族的需求预测（件） */
    private readonly forecast: Record<string, number> = {},
    /** 长途整车直送门店的商品族（配送中心没有这些货的库存） */
    direct: readonly string[] = [],
  ) {
    this.directFams = new Set(direct);
    for (const o of ops) {
      if (o.vehicle >= 0) this.byVehicle.set(o.vehicle, o);
      this.opById.set(o.id, o);
    }
    for (const fam of FAMILIES) this.stock.set(fam.key, { est: NaN, ratio: 1, t: 0 });
  }

  private est(vid: number): VEst {
    let e = this.v.get(vid);
    if (!e) {
      const op = this.byVehicle.get(vid) ?? this.byVehicle.get(this.rescueOf.get(vid) ?? -1);
      const zone: ReeferZone | undefined = op && (op.kind === 'delivery' || op.kind === 'farm' || op.kind === 'airTruck' || op.kind === 'supplier') ? (op.zone === 'frozen' ? 'frozen' : op.zone === 'chilled' || op.zone === 'multi' ? 'chilled' : undefined) : undefined;
      e = { vid, f: newFilter(0), driving: false, broken: false, brokenAt: 0, dAtBreak: 0, checks: 0, comp: true, done: new Set(), seen: false, finished: false, stops: [], leg: 0, ...(zone ? { reefer: { zone, air: SETPOINT[zone], product: SETPOINT[zone] + 0.4, cool: false, set: SETPOINT[zone], t: 0, h: 0, door: false, lastAir: NaN } } : {}) };
      this.v.set(vid, e);
    }
    return e;
  }

  /**
   * 持续校准：每跑完一程（出发 → 到下一站），实际用时比计划多出来的比例按小时记下来（每程权重 0.2 的滑动平均），
   * 之后推演到店时间时按小时加上。经过事故、抛锚、停车检查的那一程不算。
   */
  private learnLeg(from: { t: number; tau: number; clean: boolean }, tArr: number, tauArr: number): void {
    const plan = tauArr - from.tau;
    const real = tArr - from.t;
    if (!from.clean || plan < 5 * MIN) return;
    const x = Math.max(-0.3, Math.min(0.6, real / plan - 1));
    for (let h = Math.floor(from.t / 3600); h <= Math.floor(tArr / 3600) && h < 26; h++) {
      const w = (Math.min(tArr, (h + 1) * 3600) - Math.max(from.t, h * 3600)) / real;
      if (w <= 0 || h < 0) continue;
      this.bias[h] = (this.bias[h] as number) + 0.2 * w * (x - (this.bias[h] as number));
    }
  }

  /** 第一次收到这辆车的数据：按计划看它这会儿该在干什么（零点前就出发的车一开始就在路上） */
  private firstSeen(e: VEst, t: number): void {
    if (e.seen) return;
    e.seen = true;
    const plan = this.planOf(e.vid);
    const cur = plan && segAt(plan, t);
    if (cur && isMoving(cur.s)) {
      e.driving = true;
      e.leg = cur.i;
    } else if (cur?.s.place) e.at = cur.s.place;
  }

  /** 刚离开的那个停留段（地点相同、结束时刻离 τ 最近）的序号 */
  private stayIndex(plan: WVehicle, place: string, tau: number, unload: boolean): number {
    let best = -1;
    plan.segs.forEach((s, i) => {
      if (isMoving(s) || (s.place ?? '') !== place || (unload && !isStoreUnload(s))) return;
      if (best < 0 || Math.abs(s.t1 - tau) < Math.abs((plan.segs[best] as WSeg).t1 - tau)) best = i;
    });
    return best;
  }

  /** 配送中心的装车 / 卸车段（离 τ 最近的那个） */
  private dcSeg(plan: WVehicle, tau: number): WSeg | undefined {
    let best: WSeg | undefined;
    for (const s of plan.segs) if ((isLoad(s) || isDcUnload(s)) && (!best || Math.abs(s.t0 - tau) < Math.abs(best.t0 - tau))) best = s;
    return best;
  }

  /**
   * 这辆车现在在计划的哪一刻：一般按滤波的延误；抛锚停着的车停在抛锚那一刻；还在场地等门的车停在该开始装车的那一刻；
   * 在门店还没离开（卸得慢）的车不会超过卸完的那一刻。
   */
  private tauOf(e: VEst, plan: WVehicle, t: number): number {
    if (e.broken) return e.brokenAt - e.dAtBreak;
    const tau = t - e.f.d;
    if (e.driving || e.at === undefined) return tau;
    if (/^S\d\d$/.test(e.at)) {
      const i = e.done.has(e.at) ? -1 : this.stayIndex(plan, e.at, tau, true);
      const u = plan.segs[i];
      return u && tau > u.t1 - 60 ? u.t1 - 60 : tau;
    }
    const ld = e.docked ? undefined : this.dcSeg(plan, tau);
    return ld && tau > ld.t0 ? ld.t0 : tau;
  }

  /**
   * 孪生此刻对一辆车的估计（给实时跟踪用）：晚了多少秒，下一个门店站预计几点到（不去门店的车没有）。
   * 还没收到过这辆车的数据时返回 undefined。
   */
  estimate(vid: number, t: number): { delay: number; storeEta?: number } | undefined {
    const e = this.v.get(vid);
    const plan = this.planOf(vid);
    if (!e || !e.seen || e.finished || !plan) return undefined;
    const delay = t - this.tauOf(e, plan, t);
    const st = e.stops[0];
    return st ? { delay, storeEta: st.arr } : { delay };
  }

  /** 计划里 τ 附近，离 (x, z) 最近的那一刻（只看这一程的行驶段） */
  private matchTau(plan: WVehicle, x: number, z: number, near: number, leg: number): number | undefined {
    let best: number | undefined;
    let bd = 60;
    for (let i = leg; i < plan.segs.length; i++) {
      const s = plan.segs[i] as WSeg;
      if (!isMoving(s)) {
        if (i > leg) break;
        continue;
      }
      if (s.t1 < near - 1200 || s.t0 > near + 600) continue;
      const a = Math.max(s.t0, near - 1200);
      const b = Math.min(s.t1, near + 600);
      for (let tau = a; tau <= b; tau += 30) {
        const p = posAt(s, tau);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bd) {
          bd = d;
          best = tau;
        }
      }
    }
    if (best === undefined) return undefined;
    // 在最近的那一刻前后 30 秒里细找（3 秒一格）
    const seg = segAt(plan, best);
    if (seg) {
      let fine = best;
      let fd = bd;
      for (let tau = Math.max(seg.s.t0, best - 30); tau <= Math.min(seg.s.t1 - 0.01, best + 30); tau += 3) {
        const p = posAt(seg.s, tau);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < fd) {
          fd = d;
          fine = tau;
        }
      }
      best = fine;
    }
    return best;
  }

  ingest(m: Msg): void {
    switch (m.kind) {
      case 'gps': {
        const e = this.est(m.vid);
        this.firstSeen(e, m.t);
        const plan = this.planOf(m.vid);
        if (!plan || !e.driving || e.broken) return;
        const tau = this.matchTau(plan, m.x, m.z, m.t - e.f.d, e.leg);
        if (tau === undefined) return;
        filterUpdate(e.f, m.t, m.t - tau);
        // 经过事故路段的这一程不拿来学「平常比计划慢多少」
        if (e.legFrom?.clean && [...this.incidents.values()].some((i) => Math.hypot(m.x - i.x, m.z - i.z) < i.r + 40)) e.legFrom.clean = false;
        return;
      }
      case 'event': {
        if (m.vid < 0) {
          if (m.ev === 'ack' && m.place && /确认/.test(m.note ?? '')) this.extend.set(m.place, Math.max(this.extend.get(m.place) ?? 0, m.t));
          return;
        }
        const e = this.est(m.vid);
        this.firstSeen(e, m.t);
        const plan = this.planOf(m.vid);
        if (m.ev === 'ack' && m.units !== undefined && m.fam) {
          // 配送中心追加补货的车出发：车上是哪个商品族、多少件
          this.restockOf.set(m.vid, { fam: m.fam, units: m.units });
          return;
        }
        // 司机按指令停车检查、改顺序：这一程不拿来学
        if (m.ev === 'ack' && e.legFrom) e.legFrom.clean = false;
        if (m.ev === 'fault') {
          if (m.code === 'COMP') e.comp = false;
          else {
            e.broken = true;
            e.brokenAt = m.t;
            e.dAtBreak = e.f.d;
            if (e.legFrom) e.legFrom.clean = false;
          }
        } else if (m.ev === 'done' && /没发现问题/.test(m.note ?? '')) {
          e.checks++;
        } else if (m.ev === 'done' && /转到救援车/.test(m.note ?? '')) {
          // 货转到救援车上了：救援车的冷机状态从这车货的温度重新开始
          for (const [rv, of] of this.rescueOf) {
            const rr = of === m.vid ? this.v.get(rv)?.reefer : undefined;
            if (rr && e.reefer) Object.assign(rr, { product: e.reefer.product, h: 0 });
          }
        } else if (m.ev === 'fixed') {
          e.broken = false;
          Object.assign(e.f, { d: e.dAtBreak + (m.t - e.brokenAt), rate: 0, t: m.t });
          if (/空车/.test(m.note ?? '')) e.finished = true;
        } else if (m.ev === 'eta' && plan && m.eta !== undefined) {
          // 长途车还在区域外：延误按车载终端报的进区域时刻定，当作已经在路上（进了区域按定位接着跟）
          const first = plan.segs[0];
          if (first) Object.assign(e.f, { d: m.eta - first.t0, rate: 0, t: m.t });
          e.driving = true;
          e.leg = 0;
        } else if (m.ev === 'depart' && plan) {
          const i = this.stayIndex(plan, m.place ?? '', m.t - e.f.d, false);
          if (i >= 0) {
            filterUpdate(e.f, m.t, m.t - (plan.segs[i] as WSeg).t1, 0.9, 0.02);
            e.leg = i + 1;
            e.legFrom = { t: m.t, tau: (plan.segs[i] as WSeg).t1, clean: true };
          }
          e.driving = true;
          e.at = undefined;
          e.load = undefined;
          e.docked = undefined;
        } else if (m.ev === 'arrive' && plan) {
          const s = plan.segs.find((x) => x.place === m.place && !isMoving(x) && x.t0 >= m.t - e.f.d - 4 * 3600);
          if (s) {
            filterUpdate(e.f, m.t, m.t - s.t0, 0.9, 0.02);
            if (e.legFrom) this.learnLeg(e.legFrom, m.t, s.t0);
          }
          e.legFrom = undefined;
          e.driving = false;
          e.at = m.place;
          if (m.place && /^S\d\d$/.test(m.place)) {
            const op = this.byVehicle.get(m.vid) ?? this.byVehicle.get(this.rescueOf.get(m.vid) ?? -1);
            const open = ((op?.stops ?? []).find((x) => x.key === m.place)?.open ?? 0) * 3600;
            this.unloadAt.set(`${m.vid}:${m.place}`, Math.max(m.t, open));
          }
          // 孪生保真度：之前对这一站到达时间的预测，现在知道真值了
          for (const l of this.etaLog) if (l.vid === m.vid && l.store === m.place && m.t - l.tPred >= 15 * MIN) this.etaErr.push({ h: (m.t - l.tPred) / 3600, err: Math.abs(l.eta - m.t) / MIN });
          for (let i = this.etaLog.length - 1; i >= 0; i--) if ((this.etaLog[i] as EtaLog).vid === m.vid && (this.etaLog[i] as EtaLog).store === m.place) this.etaLog.splice(i, 1);
        } else if (m.ev === 'leave' && plan && m.place) {
          const i = this.stayIndex(plan, m.place, m.t - e.f.d, true);
          if (i >= 0) {
            filterUpdate(e.f, m.t, m.t - (plan.segs[i] as WSeg).t1, 0.9, 0.02);
            e.leg = i + 1;
            e.legFrom = { t: m.t, tau: (plan.segs[i] as WSeg).t1, clean: true };
          }
          e.done.add(m.place);
          e.driving = true;
          e.at = undefined;
          this.delivered(m.vid, m.place, m.t);
        }
        return;
      }
      case 'temp': {
        const e = this.est(m.vid);
        const r = e.reefer;
        if (!r) return;
        if (r.t > 0) {
          // 用自己的模型从上次推到现在，和读数比：持续偏热（压缩机在转）就是有解释不了的漏热
          const pred = reeferStep({ air: r.air, product: r.product, cool: r.cool }, reeferParams(r.zone, TWIN_REEFER), { amb: ambient(m.t), set: r.set, door: r.door, seal: false, comp: e.comp, extra: r.h }, (m.t - r.t) / MIN);
          const resid = m.air - pred.air;
          // 货温一下跳了一度多（救援车刚转进来一车货）：是状态变了，不是模型不准
          const jump = Math.abs(m.product - pred.product) > 1;
          if (!jump) this.tempErr.push(Math.abs(m.product - pred.product));
          // 两次读数之间车门一直开着或一直关着才学（模型里有开门的漏热，多出来的就是解释不了的）
          if (!jump && m.door === r.door && e.comp) r.h = Math.max(0, Math.min(2, r.h + (0.8 * resid) / Math.max(1, (m.t - r.t) / MIN)));
          else r.h *= 0.9;
        }
        Object.assign(r, { air: m.air, product: m.product, cool: m.cool, set: m.set, t: m.t, door: m.door });
        if (m.product > LIMIT[r.zone] && e.stops.length) this.hotSeen.add(m.vid);
        return;
      }
      case 'load': {
        const e = this.est(m.vid);
        this.firstSeen(e, m.t);
        if (!e.load) e.load = { door: m.door, done: m.done, total: m.total, t0: m.t, t: m.t, d0: m.done, moved: m.t };
        else {
          // 卡住的装车又动了：记下这次卡了多久
          if (m.done > e.load.done && m.t - e.load.moved >= 10 * MIN) this.stallMean = 0.7 * this.stallMean + 0.3 * (m.t - e.load.moved - 5 * MIN);
          Object.assign(e.load, { done: m.done, total: m.total, t: m.t, moved: m.done > e.load.done ? m.t : e.load.moved });
        }
        // 装车进度换算成计划里的时刻：装到第几托，计划里是几点装到这儿的，差就是晚了多少
        const plan = this.planOf(m.vid);
        const ld = plan && this.dcSeg(plan, m.t - e.f.d);
        if (ld && m.total > 0 && m.done < m.total) filterUpdate(e.f, m.t, m.t - (ld.t0 + (m.done / m.total) * (ld.t1 - ld.t0)), 0.7, 0.05);
        return;
      }
      case 'door': {
        // 配送中心月台门（C01…、D01…）和门店收货口（S01-1…）
        if (m.open) this.doorNow.set(m.door, m.vid);
        else if (this.doorNow.get(m.door) === m.vid) this.doorNow.delete(m.door);
        const plan = this.planOf(m.vid);
        if (!m.open || !plan) return;
        const e = this.est(m.vid);
        this.firstSeen(e, m.t);
        if (/^S\d\d-/.test(m.door)) {
          // 门店收货口：靠上的时刻就是开始卸货的时刻
          const i = this.stayIndex(plan, m.door.split('-')[0] as string, m.t - e.f.d, true);
          const u = plan.segs[i];
          if (u) filterUpdate(e.f, m.t, m.t - u.t0, 0.9, 0.02);
          return;
        }
        // 配送中心月台门：靠上门的时刻，计划里这时该开始装车（卸车）了
        e.docked = m.t;
        const ld = this.dcSeg(plan, m.t - e.f.d);
        if (ld) filterUpdate(e.f, m.t, m.t - ld.t0, 0.9, 0.02);
        return;
      }
      case 'pos': {
        const sk = this.stock.get(m.fam);
        if (!sk) return;
        const plan = this.demandBetween(m.fam, m.t - 900, m.t);
        // 货架快空了卖得少是因为没货（需求被截断），不拿来估「卖得比预测快还是慢」
        const censored = Number.isFinite(sk.est) && sk.est < 2 * plan * Math.max(1, sk.ratio);
        if (plan > 1 && !censored) sk.ratio = 0.6 * sk.ratio + 0.4 * (m.units / plan);
        if (Number.isFinite(sk.est)) sk.est = Math.max(0, sk.est - m.units);
        sk.t = m.t;
        return;
      }
      case 'stock': {
        const sk = this.stock.get(m.fam);
        if (sk) {
          sk.est = m.units;
          sk.t = m.t;
        }
        if (m.units <= 0 && m.t >= 7 * 3600 && m.t <= 22 * 3600) this.outSeen.add(m.fam);
        return;
      }
      case 'traffic':
        if (m.end) this.incidents.delete(m.id);
        else this.incidents.set(m.id, { x: m.x, z: m.z, r: m.r, f: m.factor, until: m.until, text: m.text });
        return;
      case 'soc':
        this.est(m.vid).soc = m.soc;
        return;
    }
  }

  /** 一辆车在门店卸的货：仿真里这一站的货；追加补货车、改直送的长途车按它装的 */
  private loadAt(vid: number, store: string): Record<string, number> {
    const rs = this.restockOf.get(vid);
    if (rs) return { [rs.fam]: rs.units };
    const own = this.byVehicle.get(vid);
    if (own?.kind === 'supplier') return this.divertedTo.get(vid) === 'store' ? (own.load ?? {}) : {};
    const op = own ?? this.byVehicle.get(this.rescueOf.get(vid) ?? -1);
    return (op?.stops ?? []).find((x) => x.key === store)?.load ?? {};
  }

  private delivered(vid: number, store: string, t: number): void {
    void t;
    for (const [fam, u] of Object.entries(this.loadAt(vid, store))) {
      const sk = this.stock.get(fam);
      if (sk && Number.isFinite(sk.est)) sk.est += u;
    }
  }

  /** 救援车、追加补货车是孪生派的：它知道它们替谁送、送什么；长途车改了去处的 */
  readonly rescueOf = new Map<number, number>();
  readonly restockOf = new Map<number, { fam: string; units: number }>();
  readonly divertedTo = new Map<number, 'store' | 'DC'>();
  /** 每个商品族接下来几车货预计几点在门店卸完、卸多少（在路上的车用预测，还没出发的车按计划） */
  private incoming = new Map<string, { vid: number; arr: number; units: number }[]>();

  // ———————————————————————— 推演 ————————————————————————

  /** 一辆车剩下的门店：预计到达、开始卸货、卸完、收货时段、预计迟到 */
  predictStops(vid: number, t: number, extraDelay = 0): Stop[] {
    const e = this.v.get(vid);
    const plan = this.planOf(vid);
    const op = this.byVehicle.get(vid) ?? this.byVehicle.get(this.rescueOf.get(vid) ?? -1);
    if (!e || !plan) return [];
    // 现在在计划的哪一刻（τ），往后再晚多少（抛锚的还要等修好，按 95 分钟估）
    const tauNow = this.tauOf(e, plan, t);
    const d = t - tauNow + extraDelay + (e.broken ? Math.max(0, 95 * MIN - (t - e.brokenAt)) : 0);
    const out: Stop[] = [];
    let extra = 0;
    let lastTau = tauNow;
    const segs = plan.segs;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i] as WSeg;
      if (s.t1 <= tauNow) continue;
      // 行驶段：已知的事故、学到的小时偏差
      if (isMoving(s) && s.route) {
        for (let tau = Math.max(s.t0, lastTau); tau < s.t1; tau += 60) {
          const real = tau + d + extra;
          const h = Math.min(25, Math.max(0, Math.floor(real / 3600)));
          extra += 60 * Math.max(0, this.bias[h] as number);
          const p = posAt(s, tau);
          for (const inc of this.incidents.values()) if (real < inc.until && Math.hypot(p.x - inc.x, p.z - inc.z) < inc.r) extra += 60 * (inc.f - 1);
        }
        lastTau = s.t1;
      }
      if (isStoreUnload(s) && s.place && !e.done.has(s.place)) {
        const prev = segs[i - 1];
        const arrTau = prev && isWait(prev) ? prev.t0 : s.t0;
        const stop = (op?.stops ?? []).find((x) => x.key === s.place);
        const open = (stop?.open ?? 0) * 3600;
        // 调拨车不占门店的收货时段（没有截止）
        const close = !op ? Infinity : Math.max((stop?.close ?? 12) * 3600, this.extend.has(s.place) ? (this.extendUntil.get(s.place) ?? 0) : 0);
        const arr = arrTau + d + extra;
        const start = Math.max(arr, open);
        const end = start + (s.t1 - s.t0);
        out.push({ key: s.place, arr, start, end, open, close, late: Math.max(0, (start - close) / MIN) });
        // 等开门的时间吸收掉一部分延误：之后的段按实际开始卸货的时刻往后排
        extra = start - s.t0 - d;
      }
    }
    return out;
  }
  /** 门店答应顺延到几点（孪生发出的通知，门店确认后生效） */
  readonly extendUntil = new Map<string, number>();

  /** 冷机往后推演 minutes 分钟：返回超标的分钟数和第一次超标的时刻 */
  predictTemp(vid: number, t: number, stops: Stop[], opt: { set?: number; fixAt?: number; transferAt?: number; minutes?: number } = {}): { hot: number; first?: number; peak: number } {
    const e = this.v.get(vid);
    const r = e?.reefer;
    if (!e || !r) return { hot: 0, peak: 0 };
    let st = { air: r.air, product: r.product, cool: r.cool };
    let hot = 0;
    let first: number | undefined;
    let peak = r.product;
    const limit = LIMIT[r.zone];
    const lastStop = stops[stops.length - 1];
    const minutes = opt.minutes ?? 10 * 60;
    let moved = false;
    for (let k = 0; k < minutes; k++) {
      const tt = t + k * MIN;
      if (lastStop && tt > lastStop.end) break;
      // 货转到救援车上：车厢已经预冷到设定温度，冷机是好的，没有额外漏热
      if (opt.transferAt !== undefined && !moved && tt >= opt.transferAt) {
        st = { air: SETPOINT[r.zone], product: st.product, cool: true };
        moved = true;
      }
      const door = stops.some((s) => tt >= s.start && tt < s.end);
      const h = moved || (opt.fixAt !== undefined && tt >= opt.fixAt) ? 0 : r.h;
      st = reeferStep(st, reeferParams(r.zone, TWIN_REEFER), { amb: ambient(tt), set: moved ? SETPOINT[r.zone] : (opt.set ?? r.set), door, seal: false, comp: moved || e.comp, extra: h }, 1);
      peak = Math.max(peak, st.product);
      if (st.product > limit) {
        hot++;
        if (first === undefined) first = tt;
      }
    }
    return { hot, ...(first !== undefined ? { first } : {}), peak };
  }

  /** 某个商品族从 t0 到 t1 预测卖出的件数（当天的需求预测 × 小时曲线） */
  demandBetween(fam: string, t0: number, t1: number): number {
    const day = this.forecast[fam] ?? 0;
    let sum = 0;
    for (let t = t0; t < t1; t += 300) sum += (day * (HOUR_W[Math.floor((t / 3600) % 24)] as number) * Math.min(300, t1 - t)) / 3600;
    return sum;
  }

  /**
   * 门店某个商品族往后推到 22 点：按估计的库存、接下来几车的货和需求预测（最近卖得快慢按一小时的时间常数回到预测；
   * 突然卖得快多半是一阵子的事，估得太久会白白追加补货），
   * 返回第一次卖空的时刻、卖空的分钟数和卖不出去的件数；extra 是假设的追加到货，skip 是假设不按原来时刻到的车（比如改派救援车）。
   */
  projectStock(fam: string, t: number, extra: { at: number; units: number }[] = [], skip?: number): { out?: number; short: number; lost: number } {
    const sk = this.stock.get(fam);
    if (!sk || !Number.isFinite(sk.est)) return { short: 0, lost: 0 };
    let left = sk.est;
    const arrivals = [...(this.incoming.get(fam) ?? []).filter((x) => x.vid !== skip).map((x) => ({ at: x.arr, units: x.units })), ...extra].sort((a, b) => a.at - b.at);
    let k = 0;
    let out: number | undefined;
    let short = 0;
    let lost = 0;
    const day = this.forecast[fam] ?? 0;
    for (let tt = t; tt < 22 * 3600; tt += 300) {
      while (k < arrivals.length && (arrivals[k] as { at: number }).at <= tt) left += (arrivals[k++] as { units: number }).units;
      const ratio = 1 + (Math.max(0.5, sk.ratio) - 1) * Math.exp(-(tt - t) / 3600);
      const rate = (day * (HOUR_W[Math.floor((tt / 3600) % 24)] as number)) / 3600;
      left -= rate * 300 * ratio;
      if (left <= 0 && rate > 0) {
        if (out === undefined) out = tt;
        short += 5;
        lost -= left;
        left = 0;
      }
    }
    return { ...(out !== undefined ? { out } : {}), short, lost };
  }

  /** 下一车这个商品族的货预计几点到 */
  nextDelivery(fam: string, t: number): { vid: number; arr: number; units: number } | undefined {
    let best: { vid: number; arr: number; units: number } | undefined;
    for (const x of this.incoming.get(fam) ?? []) if (x.arr > t - 30 * MIN && (!best || x.arr < best.arr)) best = x;
    return best;
  }

  private refreshIncoming(t: number): void {
    this.incoming.clear();
    const add = (vid: number, arr: number, load: Record<string, number>) => {
      for (const [fam, units] of Object.entries(load)) {
        let xs = this.incoming.get(fam);
        if (!xs) this.incoming.set(fam, (xs = []));
        xs.push({ vid, arr, units });
      }
    };
    for (const [vid, e] of this.v) {
      if (!e.seen || e.finished) continue;
      for (const s of e.stops) if (s.key === STORE.key) add(vid, s.end, this.loadAt(vid, s.key));
    }
    // 还没出发、也没开始装车的车：孪生只知道计划
    for (const o of this.ops) {
      if (o.vehicle < 0 || this.v.get(o.vehicle)?.seen || !(o.stops ?? []).length) continue;
      for (const st of o.stops ?? []) if (st.key === STORE.key && st.end > t) add(o.vehicle, st.end, st.load ?? {});
    }
  }

  /**
   * 每 5 分钟想一次：刷新所有车的预测，找出问题，给出做法和推演结果。
   */
  think(t: number): { kind: IssueKind; key: string; title: string; text: string; vid?: number; store?: string; options: Option[] }[] {
    const issues: ReturnType<Twin['think']> = [];
    // 先给所有在路上的车算到店预测（缺货判断要用）
    for (const [vid, e] of this.v) {
      if (!e.seen || e.finished) continue;
      e.stops = this.predictStops(vid, t);
      for (const s of e.stops) if (s.arr - t > 10 * MIN && s.arr - t < 3 * 3600) this.etaLog.push({ vid, store: s.key, tPred: t, eta: s.arr });
    }
    this.refreshIncoming(t);
    for (const [vid, e] of this.v) {
      if (!e.seen || e.finished) continue;
      const op = this.byVehicle.get(vid) ?? this.byVehicle.get(this.rescueOf.get(vid) ?? -1);
      const label = op ? op.id : `车 ${vid}`;
      // 抛锚（货已经交给救援车的不再提）
      if (e.broken && e.stops.length) {
        const remaining = e.stops;
        const wait = remaining.reduce((a, s) => a + s.late, 0);
        const rescue = this.rescueEstimate(vid, t);
        // 门店那边：车上这些货晚到会不会断货（等修好按现在的预测，派救援车按救援车卸完的时刻）
        const load = this.loadAt(vid, STORE.key);
        const rsEnd = rescue.stops.find((x) => x.key === STORE.key)?.end;
        let shortWait = 0;
        let shortRescue = 0;
        for (const fam of Object.keys(load)) {
          shortWait += this.projectStock(fam, t).short;
          shortRescue += this.projectStock(fam, t, rsEnd !== undefined ? [{ at: rsEnd, units: load[fam] as number }] : [], vid).short;
        }
        issues.push({
          kind: 'breakdown',
          key: `breakdown:${vid}`,
          title: `${label} 抛锚`,
          text: `${label} 停在路边（发动机故障），车上还有 ${remaining.length} 站的货`,
          vid,
          options: [
            { key: 'rescue', label: '派救援车接走车上的货', late: rescue.late, hot: 0, short: shortRescue, cost: rescue.cost, note: `救援车约 ${Math.round(rescue.eta / MIN)} 分钟后到，转运 30 分钟`, cmds: [{ kind: 'rescue', t, vid }], auto: false },
            { key: 'wait', label: '等修好（约 1.5 小时）', late: wait, hot: 0, short: shortWait, cost: 0, note: `门店合计晚 ${Math.round(wait)} 分钟${shortWait > 0 ? `，车上的货有 ${Math.round(shortWait)} 分钟断货` : ''}`, cmds: [], auto: true },
          ],
        });
        continue;
      }
      // 迟到
      const late = e.stops.filter((s) => s.late > 5);
      for (const s of late) {
        const st = STORES.find((x) => x.key === s.key);
        const opts: Option[] = [
          { key: 'notify', label: `通知${st?.name ?? s.key}顺延收货`, late: 0, hot: 0, short: 0, cost: 25, note: `收货截止顺延到 ${clock(s.start + 15 * MIN)}（门店多排半小时人手）`, cmds: [{ kind: 'notifyStore', t, store: s.key, until: s.start + 15 * MIN }], auto: false },
        ];
        const reseq = this.resequenceOption(vid, t, s.key);
        if (reseq) opts.push(reseq);
        opts.push({ key: 'accept', label: '不处理', late: s.late, hot: 0, short: 0, cost: 0, note: `晚 ${Math.round(s.late)} 分钟`, cmds: [], auto: true });
        issues.push({ kind: 'late', key: `late:${vid}:${s.key}`, title: `${label} 到${st?.name ?? s.key}预计晚 ${Math.round(s.late)} 分钟`, text: `预计 ${clock(s.start)} 开始卸货，收货截止 ${clock(s.close)}`, vid, store: s.key, options: opts });
      }
      // 温度
      if (e.reefer && e.stops.length) {
        const base = this.predictTemp(vid, t, e.stops);
        // 预计超标不到 5 分钟的不报（在模型误差以内）
        if (base.hot >= 5 && base.first !== undefined) {
          const r = e.reefer;
          const opts: Option[] = [];
          // 派冷藏车接货：压缩机坏了只能这样；超温时间长（半小时以上）也值得考虑
          const shift = (stops: Stop[], dt: number) => stops.map((s) => ({ ...s, arr: s.arr + dt, start: s.start + dt, end: s.end + dt, late: Math.max(0, (s.start + dt - s.close) / MIN) }));
          const rs = !e.comp || (base.hot >= 30 && !this.rescueOf.has(vid)) ? this.rescueEstimate(vid, t) : undefined;
          if (rs) {
            const rt = this.predictTemp(vid, t, rs.stops, { transferAt: t + rs.eta + 30 * MIN });
            opts.push({ key: 'rescue', label: '就近停车，派冷藏车接货', late: rs.late, hot: rt.hot, short: 0, cost: rs.cost, note: `冷藏车约 ${Math.round(rs.eta / MIN)} 分钟后到，转货 30 分钟${e.comp ? '' : '；压缩机坏了，调设定温度没用'}`, cmds: [{ kind: 'rescue', t, vid }], auto: false });
          }
          if (e.comp) {
            // 停车检查：按以往经验十次里约九次能找到并处理（密封条卡住之类）；查不出来而超温时间长的，20 分钟后再派冷藏车
            const checked = shift(e.stops, 16 * MIN);
            const fix = this.predictTemp(vid, t, checked, { fixAt: t + 20 * MIN });
            const fixLate = checked.reduce((a, s) => a + s.late, 0) - e.stops.reduce((a, s) => a + s.late, 0);
            let missHot = base.hot;
            let missLate = fixLate;
            let missCost = 0;
            if (rs) {
              const later = shift(rs.stops, 20 * MIN);
              missHot = this.predictTemp(vid, t, later, { transferAt: t + rs.eta + 50 * MIN }).hot;
              missLate = later.reduce((a, s) => a + s.late, 0) - e.stops.reduce((a, s) => a + s.late, 0);
              missCost = rs.cost;
            }
            opts.push({
              key: 'check',
              label: '提醒司机停车检查车门密封',
              late: Math.max(0, Math.round(0.88 * fixLate + 0.12 * missLate)),
              hot: Math.round(0.88 * fix.hot + 0.12 * missHot),
              short: 0,
              cost: Math.round(0.12 * missCost),
              note: `${r.h > 0.05 ? `温度一直比模型高（每分钟多 ${r.h.toFixed(2)} °C），疑似车门没关严` : '排查车门和冷机'}${rs ? '；查不出来再派冷藏车' : ''}`,
              cmds: [{ kind: 'driverCheck', t, vid }],
              auto: true,
            });
            // 设定温度最多比标准低 2 °C（冷藏货再低会冻伤）
            if (r.set > SETPOINT[r.zone] - 1.9) {
              const sp = this.predictTemp(vid, t, e.stops, { set: SETPOINT[r.zone] - 2 });
              opts.push({ key: 'setpoint', label: '远程把设定温度调低 2 °C', late: 0, hot: sp.hot, short: 0, cost: 0, note: sp.hot >= base.hot - 2 ? '压缩机已经满负荷，调低帮助不大' : `货物最高 ${sp.peak.toFixed(1)} °C`, cmds: [{ kind: 'setpoint', t, vid, delta: -2 }], auto: true });
            }
          }
          opts.push({ key: 'accept', label: '不处理', late: 0, hot: base.hot, short: 0, cost: 0, note: `货物最高 ${base.peak.toFixed(1)} °C`, cmds: [], auto: true });
          // 检查过一次没找到问题：这是新情况，马上重新给建议
          issues.push({ kind: 'temp', key: `temp:${vid}${e.checks ? `:${e.checks}` : ''}`, title: `${label} 冷机温度将超标`, text: `货物温度现在 ${r.product.toFixed(1)} °C，预计 ${clock(base.first)} 超过 ${LIMIT[r.zone]} °C${e.comp ? '' : '（压缩机故障）'}${e.checks ? `；司机检查过 ${e.checks} 次没找到问题` : ''}`, vid, options: opts });
        }
      }
    }
    // 月台门：正在装车的车预计装不完，下一辆要等
    for (const door of [...DOORS.cold, ...DOORS.dry]) {
      const occ = this.doorNow.get(door);
      if (occ === undefined) continue;
      const e = this.v.get(occ);
      const ld = e?.load;
      const plan = this.planOf(occ);
      if (!e || !ld || !plan || ld.done >= ld.total) continue;
      // 剩下的托按计划的速度装；进度十分钟没动是卡住了，再按「一般卡多久」加上还要卡的时间
      const seg = this.dcSeg(plan, t - e.f.d);
      const span = seg ? seg.t1 - seg.t0 : 40 * MIN;
      const stuck = t - ld.moved >= 10 * MIN ? Math.max(5 * MIN, this.stallMean - (t - ld.moved - 5 * MIN)) : 0;
      const end = t + (1 - ld.done / ld.total) * span + stuck;
      // 下一辆排在这樘门的车（已经在场地等着的也算）
      const next = this.bookingsOn(door)
        .filter((b) => b.vid !== occ && b.vid >= 0 && b.t0 > t - 90 * MIN && b.t0 < t + 60 * MIN && !this.v.get(b.vid)?.driving && !this.v.get(b.vid)?.docked && !this.v.get(b.vid)?.finished)
        .sort((x, y) => x.t0 - y.t0)[0];
      if (!next || end < next.t0 + 3 * MIN) continue;
      const nextOp = this.byVehicle.get(next.vid);
      const occOp = this.byVehicle.get(occ);
      const wait = (end - Math.max(t, next.t0)) / MIN;
      const free = this.freeDoor(door, Math.max(t, next.t0), Math.max(t, next.t0) + (next.t1 - next.t0));
      const opts: Option[] = [];
      if (free) opts.push({ key: 'door', label: `改到空闲的 ${free}`, late: 0, hot: 0, short: 0, cost: 0, note: `${free} 在 ${clock(next.t0)}–${clock(next.t1)} 空着`, cmds: [{ kind: 'reassignDoor', t, vid: next.vid, door: free }], auto: true });
      opts.push({ key: 'accept', label: '等这樘门', late: wait, hot: 0, short: 0, cost: 0, note: `${nextOp?.id ?? next.op} 晚装车约 ${Math.round(wait)} 分钟`, cmds: [], auto: true });
      issues.push({ kind: 'door', key: `door:${next.vid}`, title: `${door} 上的 ${occOp?.id ?? ''} 装车超时`, text: `按装车进度（${ld.done}/${ld.total} 托）预计 ${clock(end)} 才装完，${nextOp?.id ?? next.op} 原定 ${clock(next.t0)} 在这樘门装车`, vid: next.vid, options: opts });
    }
    // 门店每个商品族：到 22 点会不会卖空（算上接下来几车的货）；两个半小时以内要卖空的才处理（追加补货一个多小时就到，
    // 太早动手，需求的波动还没看清，容易白跑）
    if (t >= 6 * 3600 && t <= 21 * 3600)
      for (const fam of FAMILIES) {
        const base = this.projectStock(fam.key, t);
        if (base.out === undefined || base.short < 10 || base.out - t > 2.5 * 3600) continue;
        const opts: Option[] = [];
        const rs = this.restockOption(fam, t, base);
        if (rs) opts.push(rs);
        const dv = this.divertOption(fam, t, base);
        if (dv) opts.push(dv);
        opts.push({ key: 'accept', label: '不处理', late: 0, hot: 0, short: base.short, cost: 0, note: `约 ${Math.round(base.short)} 分钟没货卖`, cmds: [], auto: true });
        const ratio = this.stock.get(fam.key)?.ratio ?? 1;
        const nx = this.nextDelivery(fam.key, base.out);
        issues.push({ kind: 'stockout', key: `stockout:${fam.key}`, title: `${fam.label}预计 ${clock(base.out)} 卖空`, text: `最近一小时卖得是预测的 ${Math.round(ratio * 100)}%，${nx ? `下一车预计 ${clock(nx.arr)} 到` : '今天没有车再送这个货'}`, store: STORE.key, options: opts });
      }
    return issues;
  }

  /** 救援车：从配送中心备车 15 分钟、开到抛锚处、转运 30 分钟，再送剩下的门店 */
  private rescueEstimate(vid: number, t: number): { eta: number; late: number; cost: number; stops: Stop[] } {
    const e = this.v.get(vid);
    const plan = this.planOf(vid);
    if (!e || !plan) return { eta: 0, late: 0, cost: 0, stops: [] };
    const cur = segAt(plan, this.tauOf(e, plan, t));
    const target = cur?.s.route?.[cur.s.route.length - 1] ?? 'DC';
    const p = this.routes.get('DC', target);
    const eta = 15 * MIN + travelHours(p, (t / 3600) % 24) * 3600;
    let tt = t + eta + 30 * MIN;
    let late = 0;
    let at = target;
    const stops: Stop[] = [];
    for (const s of e.stops) {
      tt += travelHours(this.routes.get(at, s.key), (tt / 3600) % 24) * 3600;
      const start = Math.max(tt, s.open);
      const sl = Math.max(0, (start - s.close) / MIN);
      late += sl;
      stops.push({ ...s, arr: tt, start, end: start + (s.end - s.start), late: sl });
      tt = start + (s.end - s.start);
      at = s.key;
    }
    return { eta, late, cost: 180 + p.km * 2.4, stops };
  }

  /** 调整顺序：把要迟到的那家店提到前面（当前正开往的那家不动） */
  private resequenceOption(vid: number, t: number, lateKey: string): Option | undefined {
    const e = this.v.get(vid);
    const plan = this.planOf(vid);
    if (!e || !plan || e.stops.length < 3) return undefined;
    const cur = segAt(plan, this.tauOf(e, plan, t));
    const heading = cur?.s.route?.[cur.s.route.length - 1];
    const first = e.stops[0] as Stop;
    if (first.key === lateKey || (heading && heading !== first.key)) return undefined;
    const rest = e.stops.slice(1).map((s) => s.key);
    const order = [lateKey, ...rest.filter((k) => k !== lateKey)];
    // 推演：第一站照常，然后按新顺序
    let tt = first.end;
    let at = first.key;
    let late = first.late;
    for (const k of order) {
      if (k === first.key) continue;
      const s = e.stops.find((x) => x.key === k) as Stop;
      tt += travelHours(this.routes.get(at, k), (tt / 3600) % 24) * 3600;
      const start = Math.max(tt, s.open);
      late += Math.max(0, (start - s.close) / MIN);
      tt = start + (s.end - s.start);
      at = k;
    }
    const before = e.stops.reduce((a, s) => a + s.late, 0);
    if (late >= before - 3) return undefined;
    return { key: 'reseq', label: `调整顺序：先送${STORES.find((x) => x.key === lateKey)?.name ?? lateKey}`, late, hot: 0, short: 0, cost: 15, note: `新顺序 ${[first.key, ...order].map((k) => STORES.find((x) => x.key === k)?.name ?? k).join(' → ')}，合计晚 ${Math.round(late)} 分钟（原来 ${Math.round(before)}）`, cmds: [{ kind: 'resequence', t, vid, order: [first.key, ...order] }], auto: false };
  }

  /**
   * 配送中心追加补货：小车（最多 RESTOCK_PALLETS 托）装 20 分钟开过来；直送门店的商品族配送中心没有库存，不能补。
   * 量：推演里卖不出去的件数，多给一成半。
   */
  private restockOption(fam: Family, t: number, base: { out?: number; short: number; lost: number }): Option | undefined {
    if (fam.source === 'domestic' && this.directFams.has(fam.key)) return undefined;
    if (base.out === undefined) return undefined;
    const need = Math.max(base.lost * 1.15, fam.unitsPerCase * casesPerPallet(fam));
    const units = Math.min(need, RESTOCK_PALLETS * casesPerPallet(fam) * fam.unitsPerCase);
    const p = this.routes.get('DC', STORE.key);
    const arrive = t + 20 * MIN + travelHours(p, (t / 3600) % 24) * 3600 + 20 * MIN;
    const after = this.projectStock(fam.key, t, [{ at: arrive, units }]);
    if (base.short - after.short < 10) return undefined;
    return { key: 'restock', label: `配送中心追加补货 ${Math.round(units)} 件`, late: 0, hot: 0, short: after.short, cost: 150 + p.km * 2.4, note: `小车约 ${clock(arrive)} 到店卸完${units < need - 1 ? '（一车装不下，还差一点）' : ''}`, cmds: [{ kind: 'restock', t, fam: fam.key, units: Math.round(units) }], auto: false };
  }

  /**
   * 长途车改直送门店：今天还有车装着这个货、正开往（或要开往）配送中心，让它直接开到门店卸。
   * 配送中心少了这一车货，后面的补货由下一车补上。
   */
  private divertOption(fam: Family, t: number, base: { out?: number; short: number; lost: number }): Option | undefined {
    if (fam.source !== 'domestic') return undefined;
    let best: { vid: number; arrive: number; units: number; id: string } | undefined;
    for (const o of this.ops) {
      if (o.kind !== 'supplier' || o.vehicle < 0 || !o.load?.[fam.key] || this.divertedTo.has(o.vehicle)) continue;
      const e = this.v.get(o.vehicle);
      if (e?.finished || (e && !e.driving)) continue;
      const plan = this.planOf(o.vehicle);
      if (!plan) continue;
      // 现在在哪（还没出发的按计划出发的时刻和高速口算）、从那儿开到门店要多久
      const tau = e ? this.tauOf(e, plan, t) : t;
      const cur = segAt(plan, tau);
      if (!e && (plan.segs[0]?.t0 ?? 0) > t + 3 * 3600) continue;
      if (e && (!cur || !isMoving(cur.s))) continue;
      const from = cur?.s.route?.[cur.s.route.length - 1] ?? o.from;
      const start = e ? t + Math.max(0, (cur?.s.t1 ?? tau) - tau) : Math.max(t, plan.segs[0]?.t0 ?? t) + travelHours(this.routes.get(o.from, from), 12) * 3600;
      const arrive = start + travelHours(this.routes.get(from, STORE.key), (start / 3600) % 24) * 3600 + 25 * MIN;
      if (!best || arrive < best.arrive) best = { vid: o.vehicle, arrive, units: o.load[fam.key] as number, id: o.id };
    }
    if (!best) return undefined;
    const after = this.projectStock(fam.key, t, [{ at: best.arrive, units: best.units }]);
    if (base.short - after.short < 10) return undefined;
    return { key: 'divert', label: `${best.id} 改直送门店`, late: 0, hot: 0, short: after.short, cost: 40, note: `这车 ${Math.round(best.units)} 件原本进配送中心，改直送约 ${clock(best.arrive)} 到店卸完；配送中心少的这一车由下一车补`, cmds: [{ kind: 'divert', t, vid: best.vid, to: 'store' }], auto: false };
  }

  /** 某樘门现在的排班：调度台排的（改走了的车、提前装好挂车在场地等的除外），加上孪生改过来的车 */
  private bookingsOn(door: string): { vid: number; op: string; t0: number; t1: number }[] {
    const out: { vid: number; op: string; t0: number; t1: number }[] = [];
    for (const b of this.board.doors.find((x) => x.id === door)?.bookings ?? []) {
      const op = this.opById.get(b.op);
      if (!op || op.preload || this.reassigned.has(op.vehicle)) continue;
      out.push({ vid: op.vehicle, op: b.op, t0: b.t0, t1: b.t1 });
    }
    for (const [vid, r] of this.reassigned) if (r.door === door) out.push({ vid, op: this.byVehicle.get(vid)?.id ?? '', ...r });
    return out;
  }

  /** 同组空着的门：现在没人占、那段时间（前后留 5 分钟）也没排别的车；先找发货门，再找收货门 */
  private freeDoor(door: string, t0: number, t1: number): string | undefined {
    const group = door.startsWith('C') ? DOORS.cold : DOORS.dry;
    const recv = door.startsWith('C') ? RECEIVING_DOORS.cold : RECEIVING_DOORS.dry;
    for (const d of [...group.slice(recv), ...group.slice(0, recv)]) {
      if (d === door || this.doorNow.has(d)) continue;
      if (this.bookingsOn(d).every((b) => b.t1 + 300 <= t0 || t1 + 300 <= b.t0)) return d;
    }
    return undefined;
  }

  /** 孪生发出的指令：记下它改了什么（门店顺延、改门、改去处） */
  commanded(c: Cmd): void {
    if (c.kind === 'notifyStore') this.extendUntil.set(c.store, c.until);
    if (c.kind === 'divert') this.divertedTo.set(c.vid, c.to);
    if (c.kind === 'reassignDoor') {
      const op = this.byVehicle.get(c.vid);
      const b = op && this.board.doors.flatMap((d) => d.bookings).find((x) => x.op === op.id);
      if (b) this.reassigned.set(c.vid, { door: c.door, t0: b.t0, t1: b.t1 });
    }
  }

  /** 一条没处理的建议不再报了：是问题真的发生了（迟到、超温、卖空），还是自己没了 */
  happened(r: Rec): boolean {
    if (r.kind === 'late' && r.vid !== undefined && r.store) {
      const start = this.unloadAt.get(`${r.vid}:${r.store}`);
      const op = this.byVehicle.get(r.vid);
      const close = Math.max(((op?.stops ?? []).find((x) => x.key === r.store)?.close ?? 24) * 3600, this.extend.has(r.store) ? (this.extendUntil.get(r.store) ?? 0) : 0);
      return start !== undefined && start > close + MIN;
    }
    if (r.kind === 'temp' && r.vid !== undefined) return this.hotSeen.has(r.vid);
    if (r.kind === 'stockout') {
      const fam = r.key.split(':')[1]?.split('#')[0] ?? '';
      return this.outSeen.has(fam) || (this.stock.get(fam)?.est ?? 1) <= 0;
    }
    return false;
  }

  /** 孪生保真度：到店时间预测的平均误差（分钟），按提前多久分 */
  fidelity(): { eta30: number; eta60: number; eta120: number; n: number; temp: number } {
    const by = (lo: number, hi: number) => {
      const xs = this.etaErr.filter((x) => x.h >= lo && x.h < hi).map((x) => x.err);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
    };
    const te = this.tempErr.length ? this.tempErr.reduce((a, b) => a + b, 0) / this.tempErr.length : NaN;
    return { eta30: by(0.25, 0.75), eta60: by(0.75, 1.5), eta120: by(1.5, 3), n: this.etaErr.length, temp: te };
  }
}

export function clock(t: number): string {
  const m = Math.round(t / MIN);
  const r = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}

export const sumScore = (o: Option): number => o.late + o.hot * 2 + o.short * 1.5 + o.cost / 12;
export type { Cmd, Rec };
