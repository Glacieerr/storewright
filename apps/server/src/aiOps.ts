import { predictPickWalk, remainingPickSec, type Reason, type RecAction, type RecommendationDraft } from '@storewright/ai';
import { FRONT_RULES, lanesNeeded } from '@storewright/algorithms';
import { capacityCurve, expiryAdvice, type CapacityDay, type CapacityPoint } from '@storewright/ai';
import { dateOf, dutyOf, isBusy, oldestLot, onlineDemand, planogramByItem, planNudges, roleOf, sellableCases, shiftsOn, slotWindow, stagingOccupancy, TOTE_FACTOR_RANGE, weekHours, weekOf, type Absence, type AssociateRole, type LineFlag, type LiveRec, type LiveWalk, type NudgeStats, nudgeStats, type RecOutcome, usableCases } from '@storewright/ops';
import { forecast, foresee, type ForecastRole, type ForesightAction, type ForesightResult } from '@storewright/twin';
import { locationDistance, type AiService } from './ai';
import type { StoreRuntime } from './runtime';

/**
 * 门店 AI 第二轮的实时部分（决策记录 0021 · 第一批）：
 * - 拣货时长：批次生成时按模型估一次预计用时，领取时按领取人的熟练度组再估一次（写进事件流）；
 * - 订单量展望：每个小时、以及今天的实际偏离预测较多时发布（推演和补货优先级用）；
 * - 缺货预判：批次生成时逐行看「找得到的概率」，后仓有货就先安排补上，没有就提前排好替代；
 * - 运营预警：每隔几分钟用 AI 驱动的推演看未来两小时，有问题就试几个办法，发出最好的一个（带预计效果和把握）；
 * - 建议中枢：每隔一会儿决定该发哪些提醒、关哪些提醒（谁、什么时候、合不合并、每人每小时的预算）。
 */

export interface OpsAiOptions {
  /** 运营预警多久看一次（毫秒）；演示门店更频繁，方便看到效果 */
  foresightMs?: number;
  nudgeMs?: number;
  /** 严重告警多少分钟没人确认就升级 */
  escalateAfterMin?: number;
  /** 订单量展望：实际偏离预测时多久重新发布一次、至少观察多久才开始修正（分钟） */
  outlookDriftMin?: number;
  outlookMinObsMin?: number;
  /** 入口客流（每小时人数）：最近 10 分钟和再往前 10 分钟的平均；前场收银通道建议用（决策记录 0022 · A3） */
  shoppers?: () => { now: number; before?: number } | undefined;
  /** 人工收银通道、自助收银机的数量 */
  lanes?: { manual: number; self: number };
  /** 到货、早班补货、收银通道多久看一次（毫秒） */
  storeScanMs?: number;
}

/** 到货（决策记录 0022 · A3）：卸一辆车大约 15 分钟 + 每箱半分钟；开门前补货每人每小时约 100 箱（与规划孪生的到货仿真同一个量级） */
export const UNLOAD_BASE_MIN = 15;
export const UNLOAD_MIN_PER_CASE = 0.5;
export const STOCK_CASES_PER_HOUR = 100;

/** 一个取货时段的产能（决策记录 0023 · B6） */
export interface SlotCapacity {
  start: number;
  end: number;
  booked: number;
  /** 拣货、交付各自能做的单数，取小的作为产能 */
  pick: number;
  handoff: number;
  capacity: number;
  remaining: number;
  closed: boolean;
}

export interface DockSlot {
  receiptId: string;
  supplier: string;
  cases: number;
  /** 还没收的箱数 */
  left: number;
  cold: boolean;
  arrived: boolean;
  arriveAt: number;
  startAt: number;
  endAt: number;
  /** 到场后要等多久才能开始卸（分钟；已经开始收的为 0） */
  waitMin: number;
}

const MIN = 60_000;
/** 保质期那天的最后一刻（本地时间） */
const endOfDay = (iso: string) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 23, 59, 59).getTime();
const FORESIGHT_TARGETS = ['LATE', 'WAIT', 'COLD_FULL', 'BACKLOG'] as const;

export class OpsAiService {
  private lastForesight = 0;
  private lastNudges = 0;
  private busy = false;
  /** 建议中枢这一轮先不发的提醒（累计次数，按原因） */
  readonly deferred: Record<'BUSY' | 'BUDGET' | 'NIGHT', number> = { BUSY: 0, BUDGET: 0, NIGHT: 0 };
  /** 最近一次运营预警的结果（接口和测试用） */
  last?: { at: number; result: ForesightResult };
  private unsub: () => void;
  /** 效果追踪（决策记录 0022 · F4）：每 30 秒记一次冷区暂存占用和拣货积压，用来对账运营预警；测不了的建议不再重复看 */
  private samples: Array<{ t: number; cold: number; backlog: number }> = [];
  private lastSample = 0;
  private lastOutcomes = 0;
  private lastStoreScan = 0;
  /** 早班补货、收银通道：上一次发出的建议内容（一样就不重复发） */
  private lastNight = '';
  private lastLanes = '';
  /** 联系顾客的提醒：每天发一次 */
  private contactDay = '';
  private readonly unmeasurable = new Set<string>();

  constructor(
    private readonly rt: StoreRuntime,
    private readonly ai: AiService,
    private readonly opts: OpsAiOptions = {},
  ) {
    this.unsub = rt.subscribe((m) => {
      if (m.t !== 'events') return;
      for (const e of m.events) {
        if (e.type === 'PickWalkCreated') void this.onWalkCreated(e.payload.walk.id, e.at).catch(() => undefined);
        // 拆出来的批次、转给别人的剩下几行（决策记录 0023 · B3）：和新批次一样估用时、看缺货、看冷链
        if (e.type === 'PickWalkSplit') for (const w of e.payload.walks) void this.onWalkCreated(w.id, e.at).catch(() => undefined);
        if (e.type === 'WalkHandedOver') void this.onWalkCreated(e.payload.newWalk.id, e.at).catch(() => undefined);
        // 分框学习（决策记录 0023 · B7）
        if (e.type === 'TotesAdded') this.learnTotes(e.payload.orderId, true, e.at);
        if (e.type === 'PickWalkCompleted') {
          const w = this.rt.state.walks[e.payload.walkId];
          for (const oid of new Set((w?.toteIds ?? []).map((id) => this.rt.state.totes[id]?.orderId).filter((x): x is string => !!x))) if (!this.overflowed.has(oid)) this.learnTotes(oid, false, e.at);
        }
        if (e.type === 'PickWalkClaimed') void this.onWalkClaimed(e.payload.walkId, e.actor, e.at).catch(() => undefined);
        if (e.type === 'AbsenceReported') void this.onAbsence(e.payload.absence, e.at).catch(() => undefined);
        // 被邀请的人拒绝了：给下一位候选人（决策记录 0022 · D2）
        if (e.type === 'ShiftOfferAnswered' && !e.payload.accept) void this.onOfferDeclined(e.payload.offerId, e.at).catch(() => undefined);
        // 供应商通知晚到（决策记录 0022 · A3）
        if (e.type === 'AsnEtaUpdated') void this.onEtaUpdated(e.payload.receiptId, e.payload.previous, e.payload.expectedAt, e.at).catch(() => undefined);
      }
    });
  }

  close(): void {
    this.unsub();
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.maybeOutlook(now);
      if (now - this.lastForesight >= (this.opts.foresightMs ?? 5 * MIN)) {
        this.lastForesight = now;
        await this.scanForesight(now);
      }
      if (now - this.lastNudges >= (this.opts.nudgeMs ?? 20_000)) {
        this.lastNudges = now;
        await this.syncNudges(now);
      }
      if (now - this.lastSample >= 30_000) {
        this.lastSample = now;
        this.sample(now);
        await this.coldWatch(now);
        await this.publishToteFactors(now);
      }
      if (now - this.lastOutcomes >= 60_000) {
        this.lastOutcomes = now;
        await this.measureOutcomes(now);
      }
      if (now - this.lastStoreScan >= (this.opts.storeScanMs ?? 5 * MIN)) {
        this.lastStoreScan = now;
        await this.scanInbound(now);
        await this.scanNightCrew(now);
        await this.scanFront(now);
        await this.scanEarlyLeave(now);
        await this.scanNoShow(now);
        await this.scanCapacity(now);
        await this.scanExpiry(now);
      }
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 拣货时长与缺货预判

  async onWalkCreated(walkId: string, now = Date.now()): Promise<void> {
    const w = this.rt.state.walks[walkId];
    if (!w) return;
    // 冷链批次预计会超时：先拆开（拆出来的批次各自再走一遍这里）
    if (await this.coldSplit(walkId, now)) return;
    const est = this.ai.estimateWalk(w, now);
    if (est) await this.rt.submit({ cmd: { type: 'EstimateWalk', walkId, estimate: est }, actor: 'ai', at: now });
    await this.prePick(walkId, now);
    await this.walkCheck(walkId, now);
  }

  /**
   * 顺路核对（决策记录 0022 · C3）：在批次经过的通道里找一件「说不准在不在架上」的商品（找得到的概率 0.35–0.7），
   * 让拣货员路过时顺手数一下。每个批次最多一件：挑离路线最近、最说不准、卖得快的。
   * 冷链批次不加（拣货有时限）；正在拣的商品不用（拣到本身就是证据）；已经有核对任务的不重复。
   */
  async walkCheck(walkId: string, now = Date.now()): Promise<boolean> {
    const s = this.rt.state;
    const st = this.rt.statics;
    const w = s.walks[walkId];
    if (!w || w.status === 'COMPLETED' || w.checks?.length || w.tempZone !== 'AMBIENT' || w.stops.length < 2) return false;
    const stopLocs = new Set(w.stops.map((x) => x.locationId));
    const runs = new Set(st.planogram.filter((p) => stopLocs.has(p.locationId)).map((p) => p.runId));
    const busy = new Set(Object.values(s.checks).filter((c) => c.status === 'OPEN').map((c) => c.itemId));
    let best: { itemId: string; locationId: string; name: string; p: number; stop: number; d: number; score: number } | undefined;
    for (const pe of st.planogram) {
      if (!runs.has(pe.runId) || stopLocs.has(pe.locationId) || busy.has(pe.itemId) || s.suspect[pe.itemId] !== undefined) continue;
      const f = this.ai.findProbability(pe.itemId, 1, 0, now);
      if (f.p < 0.35 || f.p >= 0.7) continue;
      let stop = 0;
      let d = Infinity;
      w.stops.forEach((x, i) => {
        const dd = locationDistance(x.locationId, pe.locationId);
        if (dd < d) [stop, d] = [i, dd];
      });
      if (d > 60) continue;
      const score = ((1 - Math.abs(f.p - 0.5) * 2) * (1 + Math.min(3, pe.baseVelocity))) / (1 + d / 20);
      if (!best || score > best.score || (score === best.score && pe.itemId < best.itemId)) best = { itemId: pe.itemId, locationId: pe.locationId, name: pe.name, p: f.p, stop, d, score };
    }
    if (!best) return false;
    const draft: RecommendationDraft = {
      module: 'PICKING',
      target: `CHECK:${walkId}`,
      action: { kind: 'ADD_WALK_CHECK', params: { walkId, itemId: best.itemId, locationId: best.locationId, name: best.name, afterStop: best.stop } },
      prediction: { value: best.p, unit: 'PROBABILITY' },
      confidence: 0.6,
      reasons: [
        { factor: 'SHELF_UNCERTAIN', value: Math.round(best.p * 100), weight: 0.6 },
        { factor: 'ON_THE_WAY', value: best.stop + 1, weight: 0.4, params: { locationId: best.locationId } },
      ],
      alternatives: [],
      model: { id: 'shelf-truth', version: 1, kind: 'bayes-fusion' },
      expiresAt: now + 60 * MIN,
    };
    return (await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok;
  }

  /** 领取后按领取人的熟练度组重新估（熟练度组变了才重新估） */
  async onWalkClaimed(walkId: string, actor: string, now = Date.now()): Promise<void> {
    const w = this.rt.state.walks[walkId];
    if (!w || !w.ai) return;
    const est = this.ai.estimateWalk(w, now, actor);
    if (est && est.tenure !== w.ai.tenure) await this.rt.submit({ cmd: { type: 'EstimateWalk', walkId, estimate: est }, actor: 'ai', at: now });
    // 拣货前补货按领取的时刻重算走到每个货位的时间（决策记录 0026：以前只在生成批次时算一次）
    await this.prePick(walkId, now);
  }

  /**
   * 缺货预判（决策记录 0021 · B2）：拣货员最浪费时间的是找一件架上根本没有的东西。
   * 找得到的概率 < 0.4 时：后仓有货 → 安排补货，截止时间是拣货员预计走到这个货位的时刻；后仓也没有 → 提前排好替代。
   */
  async prePick(walkId: string, now = Date.now()): Promise<number> {
    const s = this.rt.state;
    const w = s.walks[walkId];
    if (!w || w.status === 'COMPLETED') return 0;
    // 拣货员预计走到每一站的时刻：批次开销的一半 + 之前各行的预计用时
    const params = this.ai.pickParams();
    const sample = this.ai.walkSample(w, this.ai.tenureOf(w.associateId, now), now);
    const lines = params ? predictPickWalk(params, sample).lines : sample.lines.map(() => 40);
    const startAt = Math.max(now, w.claimedAt ?? now) + ((params?.overheadSec ?? 120) / 2) * 1000;
    const demand = onlineDemand(s);
    const flags: Record<string, LineFlag> = {};
    let elapsed = 0;
    for (let i = 0; i < w.stops.length; i++) {
      const stop = w.stops[i];
      if (!stop) continue;
      elapsed += (lines[i] ?? 40) * 1000;
      const etaAt = Math.round(startAt + elapsed);
      for (const pk of stop.picks) {
        const tote = s.totes[pk.toteId];
        const line = tote ? s.orders[tote.orderId]?.lines.find((l) => l.lineId === pk.lineId) : undefined;
        if (!line || (w.done[`${pk.toteId}|${pk.lineId}`] ?? 0) >= pk.qty) continue;
        const other = Math.max(0, (demand.get(line.itemId) ?? 0) - pk.qty);
        const f = this.ai.findProbability(line.itemId, pk.qty, other, now);
        // 货架上最早的一批两天内到期（决策记录 0024 · C4）：提醒拣货员拿保质期长的
        const old = oldestLot(s, line.itemId);
        const shortDated = old?.expiry && endOfDay(old.expiry) - now <= 2 * 24 * 60 * MIN ? old.expiry : undefined;
        if (f.p >= 0.4) {
          if (shortDated) flags[`${pk.toteId}|${pk.lineId}`] = { p: f.p, shortDated };
          continue;
        }
        const key = `${pk.toteId}|${pk.lineId}`;
        if (s.suspect[line.itemId] === undefined && usableCases(s, line.itemId).length) {
          await this.rt.submit({ cmd: { type: 'RequestPrepick', itemId: line.itemId, dueAt: etaAt, walkId }, actor: 'ai', at: now });
          const task = Object.values(this.rt.state.repl).find((t) => t.itemId === line.itemId && (t.status === 'OPEN' || t.status === 'CLAIMED'));
          flags[key] = { p: f.p, ...(task ? { pullTaskId: task.id } : {}), ...(task?.dueAt !== undefined ? { readyAt: task.dueAt } : {}), ...(shortDated ? { shortDated } : {}) };
        } else if (line.allowSubstitution) {
          const subs = this.ai.substitutes(line.itemId, 3).items.map((x) => ({ name: x.name, gtin: x.gtin, ...(x.p !== undefined ? { p: x.p } : {}) }));
          flags[key] = { p: f.p, ...(subs.length ? { subs } : {}) };
        } else flags[key] = { p: f.p };
      }
    }
    if (!Object.keys(flags).length) return 0;
    const r = await this.rt.submit({ cmd: { type: 'FlagWalkLines', walkId, flags }, actor: 'ai', at: now });
    return r.ok ? Object.keys(flags).length : 0;
  }

  // ---------------------------------------------------------------------------
  // 冷链与分批、分框学习（决策记录 0023 · B3、B7）

  /** 冷链暴露：从第一件放进框到送回暂存区（拣货时长模型的各行 + 回暂存区的开销） */
  private coldExposure(w: LiveWalk, now: number): number | undefined {
    const params = this.ai.pickParams();
    if (!params) return undefined;
    const pr = predictPickWalk(params, this.ai.walkSample(w, this.ai.tenureOf(w.associateId, now), now));
    return pr.sec - params.overheadSec * 0.6;
  }

  /**
   * 领取前拆批：冷链批次的 AI 预计暴露时间超过时限的 95% 时，按订单在路线上的先后切成两个批次
   * （找「两半里较长的那一半」最短的切法）。只拆有两个以上订单、还没人领取的批次；拆出来的批次各自再看一次。
   * 分批时用的是标准工时，模型知道哪些货位难找、哪个时段拥挤，常常估得更长。
   */
  async coldSplit(walkId: string, now = Date.now()): Promise<boolean> {
    const s = this.rt.state;
    const w = s.walks[walkId];
    if (!w || w.status !== 'OPEN' || w.coldLimitSec === undefined) return false;
    const whole = this.coldExposure(w, now);
    if (whole === undefined || whole <= w.coldLimitSec * 0.95) return false;
    const orders: string[] = [];
    for (const st of w.stops)
      for (const p of st.picks) {
        const oid = s.totes[p.toteId]?.orderId;
        if (oid && !orders.includes(oid)) orders.push(oid);
      }
    if (orders.length < 2) return false;
    const totesOf = (oids: readonly string[]) => w.toteIds.filter((id) => oids.includes(s.totes[id]?.orderId ?? ''));
    const sub = (ids: readonly string[]): LiveWalk => ({ ...w, toteIds: [...ids], stops: w.stops.map((st) => ({ ...st, picks: st.picks.filter((p) => ids.includes(p.toteId)) })).filter((st) => st.picks.length > 0) });
    let best: { k: number; worst: number } | undefined;
    for (let k = 1; k < orders.length; k++) {
      const worst = Math.max(this.coldExposure(sub(totesOf(orders.slice(0, k))), now) ?? Infinity, this.coldExposure(sub(totesOf(orders.slice(k))), now) ?? Infinity);
      if (!best || worst < best.worst) best = { k, worst };
    }
    if (!best || best.worst >= whole) return false;
    const groups = [totesOf(orders.slice(0, best.k)), totesOf(orders.slice(best.k))];
    const draft: RecommendationDraft = {
      module: 'PICKING',
      target: `SPLIT:${walkId}`,
      action: { kind: 'SPLIT_WALK', params: { walkId, groups: groups.map((g) => g.join(',')).join('|') } },
      prediction: { value: Math.round(best.worst), baseline: Math.round(whole), unit: 'SECONDS' },
      confidence: 0.7,
      reasons: [
        { factor: 'COLD_EXPOSURE', value: Math.round(whole / 60), weight: 0.6, params: { limit: Math.round(w.coldLimitSec / 60) } },
        { factor: 'SPLIT_INTO', value: 2, weight: 0.4, params: { worst: Math.round(best.worst / 60) } },
      ],
      alternatives: [],
      model: { id: 'pick-time', version: 1, kind: 'cold-split' },
      expiresAt: now + 30 * MIN,
    };
    return (await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok;
  }

  /**
   * 拣货中看冷链：按这一批到现在的快慢，剩下的行还要多久（拣货时长模型，含回暂存区），会不会超过冷链时限；
   * 预计超时 1 分钟以上时标出来（拣货员的手机上提示「先把框送回暂存，剩下的转给别人」），变化 1 分钟以上时更新，风险消失时清掉。
   */
  async coldWatch(now = Date.now()): Promise<number> {
    const s = this.rt.state;
    const params = this.ai.pickParams();
    let n = 0;
    for (const w of Object.values(s.walks)) {
      if (w.status !== 'PICKING' || w.coldStartedAt === undefined || w.coldLimitSec === undefined || w.coldAlerted || !w.associateId || w.associateId.startsWith('V-')) continue;
      const stopDone = (i: number) => (w.stops[i]?.picks ?? []).every((p) => (w.done[`${p.toteId}|${p.lineId}`] ?? 0) >= p.qty);
      let k = 0;
      while (k < w.stops.length && stopDone(k)) k++;
      const left = w.stops.length - k;
      if (!left) continue;
      const sample = this.ai.walkSample(w, this.ai.tenureOf(w.associateId, now), now);
      const remaining = params ? remainingPickSec(params, sample, k, Math.max(0, (now - (w.claimedAt ?? now)) / 1000)) : w.estimatedSec * (left / Math.max(1, w.stops.length));
      const over = Math.round((now - w.coldStartedAt) / 1000 + remaining - w.coldLimitSec);
      const prev = w.coldRisk?.overSec;
      const flag = over >= 60 ? (prev === undefined || prev <= 0 || Math.abs(prev - over) >= 60) : prev !== undefined && prev > 0;
      if (!flag) continue;
      if ((await this.rt.submit({ cmd: { type: 'FlagColdRisk', walkId: w.id, overSec: Math.max(0, over), remainingLines: left }, actor: 'ai', at: now })).ok) n++;
    }
    return n;
  }

  /** 分框系数（商品类别 → 实际占用 ÷ 体积数据）；加过框的订单 */
  private factors: Record<string, number> = {};
  private publishedFactors = '';
  private readonly overflowed = new Set<string>();

  /**
   * 分框学习：框装不下（拣货中加了框）时，按这单各类商品的体积占比把系数往上调（实际框数 ÷ 计划框数）；
   * 没加框就拣完的订单让系数慢慢回到 1（避免一直往上加）。系数限制在 0.8–1.6。
   */
  learnTotes(orderId: string, overflow: boolean, _now = Date.now()): void {
    const s = this.rt.state;
    const o = s.orders[orderId];
    if (!o) return;
    if (!Object.keys(this.factors).length && s.toteFactors) this.factors = { ...s.toteFactors };
    const vol = new Map<string, number>();
    for (const l of o.lines) {
      const info = this.ai.itemInfo(l.itemId);
      if (info) vol.set(info.categoryId, (vol.get(info.categoryId) ?? 0) + info.volumeL * l.qty);
    }
    const total = [...vol.values()].reduce((a, b) => a + b, 0);
    if (!total) return;
    const [lo, hi] = TOTE_FACTOR_RANGE;
    if (overflow) {
      this.overflowed.add(orderId);
      const planned = Math.max(1, o.toteIds.length - 1);
      const ratio = (planned + 1) / planned;
      for (const [c, v] of vol) this.factors[c] = Math.min(hi, Math.max(lo, (this.factors[c] ?? 1) * (1 + 0.5 * (v / total) * (ratio - 1))));
    } else for (const [c, v] of vol) if (this.factors[c] !== undefined) this.factors[c] = 1 + ((this.factors[c] as number) - 1) * (1 - 0.01 * (v / total));
  }

  /** 系数变化 0.02 以上时写进作业核心（锁单分框时用） */
  async publishToteFactors(now = Date.now()): Promise<boolean> {
    const rounded = Object.fromEntries(Object.entries(this.factors).map(([k, v]) => [k, Math.round(v * 50) / 50]).filter(([, v]) => v !== 1));
    const key = JSON.stringify(rounded);
    if (key === this.publishedFactors || (!this.publishedFactors && key === '{}')) return false;
    this.publishedFactors = key;
    return (await this.rt.submit({ cmd: { type: 'UpdateToteFactors', factors: rounded }, actor: 'ai', at: now })).ok;
  }

  // ---------------------------------------------------------------------------
  // 临期与损耗（决策记录 0024 · C4）

  /**
   * 货架上有保质期的批次（收货时记下了批号和保质期）：四天内到期的，按到期前卖不完的概率建议
   * 降价（店长确认）、移到显眼位置、到期前一天捐赠；已经过期的提醒下架。速度用货架估算的销售速度，售价来自陈列表，
   * 进价按售价的 65% 估。前面更早到期的批次要先卖（先进先出）。每次最多 3 条，同一批同一种办法不重复。
   */
  async scanExpiry(now = Date.now()): Promise<number> {
    const s = this.rt.state;
    const plan = planogramByItem(this.rt.statics);
    const found: Array<{ draft: RecommendationDraft; score: number }> = [];
    for (const [itemId, lots] of Object.entries(s.shelfLots ?? {})) {
      const pe = plan.get(itemId);
      if (!pe) continue;
      const velocity = Math.max(0.01, s.shelf[itemId]?.velocity ?? pe.baseVelocity);
      let ahead = 0;
      for (const l of [...lots].filter((x) => x.expiry && x.units > 0).sort((a, b) => (a.expiry as string).localeCompare(b.expiry as string))) {
        const hoursLeft = (endOfDay(l.expiry as string) - now) / (60 * MIN);
        const target = `${itemId}|${l.lot}`;
        if (hoursLeft > 96) break;
        const a = hoursLeft <= 0 ? { action: 'EXPIRED' as const, risk: 1, leftover: l.units } : expiryAdvice({ unitsAhead: ahead, units: l.units, hoursLeft, velocity }, { price: pe.unitPrice, cost: pe.unitPrice * 0.65 });
        ahead += l.units;
        if (a.action === 'NONE') continue;
        const kind = a.action === 'MARKDOWN' ? 'MARKDOWN' : a.action === 'DONATE' ? 'DONATE' : 'INFO';
        // 过期的批次已经有「下架」任务（决策记录 0026）：不再每 12 小时提醒一次
        if (a.action === 'EXPIRED' && Object.values(s.checks).some((c) => c.reason === 'PULL' && c.itemId === itemId && c.lot === l.lot)) continue;
        if (Object.values(s.recs).some((r) => r.module === 'EXPIRY' && r.target === target && r.action.kind === kind && (r.status === 'OPEN' || now - r.issuedAt < 12 * 60 * MIN))) continue;
        const params: Record<string, string | number | boolean> = { itemId, lot: l.lot, expiry: l.expiry as string, units: l.units, ...(a.action === 'MARKDOWN' ? { pct: a.pct as number } : {}), ...(a.action === 'VISIBLE' ? { visible: true } : {}), ...(a.action === 'EXPIRED' ? { expired: true, nudge: true } : {}) };
        found.push({
          score: a.risk * (a.leftover + 1),
          draft: {
            module: 'EXPIRY',
            target,
            action: { kind, params },
            prediction: { value: a.risk, unit: 'PROBABILITY' },
            confidence: 0.65,
            reasons: [
              { factor: 'EXPIRES_IN', value: Math.max(0, Math.round(hoursLeft)), weight: 0.4, params: { expiry: l.expiry as string } },
              { factor: 'LEFT_AT_EXPIRY', value: Math.round(a.leftover), weight: 0.35, params: { units: l.units } },
              { factor: 'VELOCITY', value: Math.round(velocity * 10) / 10, weight: 0.25 },
            ],
            alternatives: [],
            model: { id: 'expiry-risk', version: 1, kind: 'negative-binomial' },
            expiresAt: Math.max(now + 60 * MIN, endOfDay(l.expiry as string)),
          },
        });
      }
    }
    let n = 0;
    for (const f of found.sort((a, b) => b.score - a.score).slice(0, 3)) if ((await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft: f.draft }, actor: 'ai', at: now })).ok) n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // 时段产能（决策记录 0023 · B6）

  /** 每单的拣货用时（分钟）：拣货时长模型的每行用时 × 平均行数 + 批次开销的分摊 */
  private perOrderPickMin(): number {
    const r = this.ai.pickRates();
    return (r.secPerOrder + (this.ai.context?.linesPerOrder ?? 6) * r.secPerLine) / 60;
  }

  private onDutyIn(role: AssociateRole, at: number): number {
    const st = this.rt.statics;
    return st.roster.filter((a) => {
      const d = dutyOf(st, this.rt.state, a.id, at);
      return d.on && (this.rt.state.roles[a.id] ?? d.role ?? a.role) === role;
    }).length;
  }

  /**
   * 接下来每个取货时段还能接多少单：
   * - 拣货：时段开始前一个时段长度里在岗的拣货员 × 可用时间（八五折）÷ 每单拣货用时；
   * - 交付：时段里在岗的交付员 × 时段长度 × 八五折 ÷ 每单交付 4 分钟（只算自取单的比例）；
   * 取小的作为产能，减去已经接的单。只看营业时间里的时段。
   */
  slotCapacity(now = Date.now(), count = 8): SlotCapacity[] {
    const s = this.rt.state;
    const st = this.rt.statics;
    const len = Math.max(5, st.rules.slotLengthMin) * MIN;
    const hours = this.ai.context?.hours ?? [];
    const perOrder = this.perOrderPickMin();
    const orders = Object.values(s.orders).filter((o) => o.status !== 'CANCELLED');
    const pickupShare = orders.length >= 10 ? orders.filter((o) => o.type === 'PICKUP').length / orders.length : 0.6;
    const out: SlotCapacity[] = [];
    let start = slotWindow(st, now) + len;
    for (let guard = 0; out.length < count && guard < 96; guard++, start += len) {
      const h = new Date(start).getHours();
      if (hours.length && !hours.includes(h)) continue;
      const booked = orders.filter((o) => slotWindow(st, o.slotStart) === start).length;
      const pick = Math.floor((this.onDutyIn('PICK', start - len / 2) * (len / MIN) * 0.85) / Math.max(0.5, perOrder));
      const handoff = Math.floor((this.onDutyIn('HANDOFF', start + len / 2) * (len / MIN) * 0.85) / (4 * Math.max(0.1, pickupShare)));
      const capacity = Math.min(pick, handoff);
      out.push({ start, end: start + len, booked, pick, handoff, capacity, remaining: capacity - booked, closed: !!s.closedSlots?.[String(start)] });
    }
    return out;
  }

  /** 快接满了（剩不到一成、或者已经超了）、开始前还有半小时以上的时段：建议停止接新单；后面还有空的时段一起给出来 */
  async scanCapacity(now = Date.now()): Promise<number> {
    const slots = this.slotCapacity(now);
    let n = 0;
    for (const [i, sl] of slots.entries()) {
      if (sl.closed || sl.capacity <= 0 || sl.start - now < 30 * MIN || sl.remaining > Math.max(1, Math.floor(sl.capacity * 0.1))) continue;
      const target = `slot:${sl.start}`;
      if (Object.values(this.rt.state.recs).some((r) => r.target === target && (r.status === 'OPEN' || r.status === 'OVERRIDDEN' || r.status === 'DISMISSED'))) continue;
      const later = slots.slice(i + 1).find((x) => !x.closed && x.remaining >= Math.max(2, x.capacity * 0.3));
      const draft: RecommendationDraft = {
        module: 'CAPACITY',
        target,
        action: { kind: 'CLOSE_SLOT', params: { slotStart: sl.start, slotEnd: sl.end, booked: sl.booked, capacity: sl.capacity, ...(later ? { later: later.start, laterLeft: later.remaining } : {}), nudge: true } },
        prediction: { value: sl.booked, baseline: sl.capacity, unit: 'ORDERS', from: sl.start, to: sl.end },
        confidence: 0.65,
        reasons: [
          { factor: 'SLOT_BOOKED', value: sl.booked, weight: 0.4, params: { capacity: sl.capacity } },
          { factor: 'PICK_CAPACITY', value: sl.pick, weight: 0.3, params: { perOrder: Math.round(this.perOrderPickMin() * 10) / 10 } },
          { factor: 'HANDOFF_CAPACITY', value: sl.handoff, weight: 0.3 },
        ],
        alternatives: later ? [{ action: { kind: 'INFO', params: { later: later.start, laterLeft: later.remaining } }, score: 0.5 }] : [],
        model: { id: 'slot-capacity', version: 1, kind: 'staffing-throughput' },
        expiresAt: sl.start,
      };
      if ((await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok) n++;
    }
    return n;
  }

  /** 取舍曲线：今天剩下的时段按订单量预测和在岗拣货员仿真，接单上限取产能估计 × 系数（∞ 是不设上限） */
  capacityTradeoff(now = Date.now()): { day: CapacityDay; curve: CapacityPoint[] } | undefined {
    const slots = this.slotCapacity(now, 24);
    if (!slots.length) return undefined;
    const t = new Date(now);
    const day0 = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    const byHour = this.ai.ordersByHourOn(dateOf(now)) ?? [];
    const lenMin = (slots[0] as SlotCapacity).end / MIN - (slots[0] as SlotCapacity).start / MIN;
    const ol = this.rt.state.outlook;
    const corr = ol && now - ol.at < 2 * 60 * MIN ? ol.correction : 1;
    const day: CapacityDay = {
      slots: slots.map((x) => ({ start: Math.round((x.start - day0) / MIN), demand: Math.max(0.5, ((byHour[new Date(x.start).getHours()] ?? 0) * lenMin) / 60) * corr })),
      slotMin: lenMin,
      pickers: slots.map((x) => this.onDutyIn('PICK', x.start - (lenMin * MIN) / 2)),
      perOrderMin: this.perOrderPickMin(),
    };
    return { day, curve: capacityCurve(day) };
  }

  // ---------------------------------------------------------------------------
  // 未取订单（决策记录 0023 · B5）

  /**
   * - 风险高（≥ 0.3）、冷冻商品还没进批次、取货时段还有一个小时以上的自取单：冷冻商品晚点拣（到取货时段前 20 分钟）。
   *   顾客最后没来的话，冷冻商品不用拣出来又退回去，也不占冷冻格位；来了也来得及拣（每次最多 3 单）。
   * - 营业结束前一个半小时：已经备好、过了取货时段 30 分钟还没来的订单，提醒带班负责人联系顾客（风险高的在前；每天一次）。
   */
  async scanNoShow(now = Date.now()): Promise<number> {
    const s = this.rt.state;
    let n = 0;
    const frozenLeft = (o: (typeof s.orders)[string]) => (o.status === 'CREATED' ? o.lines.some((l) => l.tempZone === 'FROZEN') : o.toteIds.some((t) => s.totes[t]?.tempZone === 'FROZEN' && s.totes[t]?.status === 'PLANNED'));
    const risky: Array<{ id: string; p: number; until: number; reasons: Reason[] }> = [];
    for (const o of Object.values(s.orders)) {
      if (o.type !== 'PICKUP' || o.track === 'AUTO' || o.status === 'CANCELLED' || o.status === 'COMPLETED' || o.slotStart - now < 60 * MIN || (o.frozenAfter ?? 0) > now || !frozenLeft(o)) continue;
      if (Object.values(s.recs).some((r) => r.target === `noshow:${o.id}`)) continue;
      const r = this.ai.noShowRisk(o, now);
      if (r && r.p >= 0.3) risky.push({ id: o.id, p: r.p, until: o.slotStart - 20 * MIN, reasons: r.reasons });
    }
    for (const x of risky.sort((a, b) => b.p - a.p).slice(0, 3)) {
      const draft: RecommendationDraft = {
        module: 'STAGING',
        target: `noshow:${x.id}`,
        action: { kind: 'DEFER_FROZEN', params: { orderIds: x.id, until: x.until, noShow: true } },
        prediction: { value: x.p, unit: 'PROBABILITY' },
        confidence: 0.6,
        reasons: [{ factor: 'NO_SHOW_RISK', value: Math.round(x.p * 100), weight: 0.5 }, ...x.reasons.map((r) => ({ ...r, weight: Math.round(r.weight * 0.5 * 1000) / 1000 }))],
        alternatives: [],
        model: { id: 'no-show', version: 1, kind: 'logistic' },
        expiresAt: x.until,
      };
      if ((await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok) n++;
    }
    // 营业结束前：备好了、过了时段还没来的订单
    const hours = this.ai.context?.hours ?? [];
    const date = dateOf(now);
    if (hours.length && this.contactDay !== date) {
      const t = new Date(now);
      const close = new Date(t.getFullYear(), t.getMonth(), t.getDate(), (hours.at(-1) as number) + 1).getTime();
      if (now >= close - 90 * MIN && now < close) {
        const waiting = Object.values(s.orders)
          .filter((o) => o.type === 'PICKUP' && o.track !== 'AUTO' && (o.status === 'STAGED' || o.status === 'READY') && o.arrivedAt === undefined && o.slotStart <= now - 30 * MIN)
          .map((o) => ({ id: o.id, p: this.ai.noShowRisk(o, now)?.p ?? 0.5 }))
          .sort((a, b) => b.p - a.p || a.id.localeCompare(b.id));
        if (waiting.length) {
          this.contactDay = date;
          const draft: RecommendationDraft = {
            module: 'STAGING',
            target: 'CONTACT',
            action: { kind: 'INFO', params: { orderIds: waiting.slice(0, 10).map((w) => w.id).join(','), count: waiting.length, close, nudge: true } },
            prediction: { value: waiting.length, unit: 'ORDERS' },
            confidence: 0.7,
            reasons: [{ factor: 'NOT_PICKED_UP', value: waiting.length, weight: 0.6, params: { close } }, { factor: 'NO_SHOW_RISK', value: Math.round((waiting[0]?.p ?? 0) * 100), weight: 0.4 }],
            alternatives: [],
            model: { id: 'no-show', version: 1, kind: 'logistic' },
            expiresAt: close,
          };
          if ((await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok) n++;
        }
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // 提前下班（决策记录 0022 · D2）

  /**
   * 今天的单量明显低于预测（订单量展望的修正系数 ≤ 0.8）时，用推演试一试少一名交付员或拣货员：
   * 迟到不增加、平均等待多不过半分钟、最长等待不超过提醒线，就请一位今天班次还剩 90 分钟以上的人自愿提前 1 小时下班
   * （这周工时多的先问；只发邀请，本人愿意才生效）。单量高于预测时由运营预警提示叫人。
   */
  async scanEarlyLeave(now = Date.now()): Promise<boolean> {
    const s = this.rt.state;
    const st = this.rt.statics;
    const ol = s.outlook;
    if (!ol || ol.correction > 0.8 || now - ol.at > 60 * MIN) return false;
    if (Object.values(s.recs).some((r) => r.action.kind === 'OFFER_EARLY_LEAVE' && (r.status === 'OPEN' || now - r.issuedAt < 120 * MIN))) return false;
    const date = dateOf(now);
    const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    const base = forecast(s, st, now, { horizonMin: 120 });
    for (const role of ['HANDOFF', 'PICK'] as const) {
      const less = forecast(s, st, now, { horizonMin: 120, staffDelta: { [role]: -1 } });
      if (less.kpi.late > base.kpi.late || less.kpi.avgWaitMin > base.kpi.avgWaitMin + 0.5 || less.kpi.maxWaitMin > 10) continue;
      const cands = st.roster
        .map((a) => ({ a, d: dutyOf(st, s, a.id, now), hours: weekHours(s, a.id, weekOf(date)) }))
        .filter(({ a, d }) => d.on && (s.roles[a.id] ?? d.role ?? a.role) === role && d.to !== undefined && d.to - minute >= 90 && !isBusy(s, a.id) && !s.staffLocks[a.id])
        .sort((x, y) => y.hours - x.hours || x.a.id.localeCompare(y.a.id));
      const c = cands[0];
      if (!c || c.d.to === undefined) continue;
      const draft: RecommendationDraft = {
        module: 'STAFFING',
        target: `early:${date}`,
        action: { kind: 'OFFER_EARLY_LEAVE', params: { associateId: c.a.id, date, from: c.d.to - 60, to: c.d.to, role } },
        prediction: { value: less.kpi.avgWaitMin, baseline: base.kpi.avgWaitMin, unit: 'MINUTES' },
        confidence: 0.6,
        reasons: [
          { factor: 'DEMAND_VS_FORECAST', value: Math.round((ol.correction - 1) * 100), weight: 0.5 },
          { factor: 'NO_WORSE', value: less.kpi.late, weight: 0.3, params: { role, wait: less.kpi.avgWaitMin } },
          { factor: 'HOURS_THIS_WEEK', value: Math.round(c.hours * 10) / 10, weight: 0.2 },
        ],
        alternatives: [],
        model: { id: 'ops-foresight', version: 1, kind: 'queue-forecast' },
        expiresAt: now + 60 * MIN,
      };
      return (await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 到货、早班补货、前场收银通道的门店版（决策记录 0022 · A3）：复用规划孪生里三个建议器的思路，输入换成门店的实时数据

  /** 此刻在岗的收货员（后仓岗位） */
  private receivers(now: number): number {
    const st = this.rt.statics;
    return st.roster.filter((a) => {
      const d = dutyOf(st, this.rt.state, a.id, now);
      return d.on && (this.rt.state.roles[a.id] ?? d.role ?? a.role) === 'BACKROOM';
    }).length;
  }

  /**
   * 卸货门计划：已经开始收的车先占门，其次已到的车（同时到的冷链优先），再按预计到达排还没到的车；
   * 同时能卸几辆 = 卸货门数和在岗收货员数里小的那个（至少 1）。返回每辆车预计开始卸、卸完的时间和要等多久。
   */
  dockPlan(now = Date.now(), extraReceivers = 0): DockSlot[] {
    const s = this.rt.state;
    const st = this.rt.statics;
    const zone = new Map(st.planogram.map((p) => [p.itemId, p.tempZone]));
    const docks = Math.max(1, st.docks?.length ?? 2);
    const servers = Math.max(1, Math.min(docks, this.receivers(now) + extraReceivers));
    const trucks = Object.values(s.receipts)
      .filter((r) => r.closedAt === undefined)
      .map((r) => {
        const cases = r.expected.reduce((n, l) => n + l.cases, 0);
        const got = Object.values(r.received).reduce((n, x) => n + x.cases + x.damaged, 0);
        return { r, cases, left: Math.max(0, cases - got), started: got > 0, cold: r.expected.some((l) => zone.get(l.itemId) === 'CHILLED' || zone.get(l.itemId) === 'FROZEN'), arriveAt: r.arrivedAt ?? r.expectedAt ?? r.createdAt + 60 * MIN };
      })
      .sort((a, b) => Number(b.started) - Number(a.started) || Number(b.r.arrivedAt !== undefined) - Number(a.r.arrivedAt !== undefined) || (a.r.arrivedAt !== undefined && b.r.arrivedAt !== undefined ? Number(b.cold) - Number(a.cold) : 0) || a.arriveAt - b.arriveAt || a.r.id.localeCompare(b.r.id));
    const free = new Array<number>(servers).fill(now);
    return trucks.map((x) => {
      let k = 0;
      for (let i = 1; i < free.length; i++) if ((free[i] as number) < (free[k] as number)) k = i;
      const ready = x.r.arrivedAt !== undefined ? now : Math.max(now, x.arriveAt);
      const startAt = x.started ? now : Math.max(ready, free[k] as number);
      const endAt = startAt + ((x.started ? 0 : UNLOAD_BASE_MIN) + x.left * UNLOAD_MIN_PER_CASE) * MIN;
      free[k] = endAt;
      const waitMin = x.started ? 0 : Math.max(0, (startAt - (x.r.arrivedAt ?? x.arriveAt)) / MIN);
      return { receiptId: x.r.id, supplier: x.r.supplier, cases: x.cases, left: x.left, cold: x.cold, arrived: x.r.arrivedAt !== undefined, arriveAt: x.arriveAt, startAt: Math.round(startAt), endAt: Math.round(endAt), waitMin: Math.round(waitMin * 10) / 10 };
    });
  }

  /** 车在排队：已到的车或接下来两小时要到的车预计要等 15 分钟以上 → 收货顺序（冷链优先）和临时加一名收货员（推演一下能少等多久） */
  async scanInbound(now = Date.now()): Promise<boolean> {
    const plan = this.dockPlan(now).filter((x) => x.arriveAt <= now + 120 * MIN);
    const worst = plan.reduce<DockSlot | undefined>((m, x) => (!m || x.waitMin > m.waitMin ? x : m), undefined);
    if (!worst || worst.waitMin < 15) return false;
    const recent = Object.values(this.rt.state.recs).filter((r) => r.module === 'INBOUND' && r.target === 'DOCK').sort((a, b) => b.issuedAt - a.issuedAt)[0];
    if (recent && (recent.status === 'OPEN' || ((recent.status === 'OVERRIDDEN' || recent.status === 'DISMISSED') && now - (recent.resolvedAt ?? 0) < 30 * MIN))) return false;
    const after = this.dockPlan(now, 1).filter((x) => x.arriveAt <= now + 120 * MIN);
    const worstAfter = after.find((x) => x.receiptId === worst.receiptId)?.waitMin ?? worst.waitMin;
    const order = plan.filter((x) => x.left > 0).map((x) => x.receiptId);
    // 调一名会后仓的人去收货（此刻可以调动、手上没任务）；加人也不会少等时只给收货顺序
    const ppl = this.movablePeople(now);
    const st = this.rt.statics;
    const who = worst.waitMin - worstAfter >= 5 ? [...ppl.OTHER, ...ppl.STAGE, ...ppl.PICK].find((id) => {
      const a = st.roster.find((x) => x.id === id);
      return !!a && (a.role === 'BACKROOM' || a.skills?.includes('BACKROOM')) && (this.rt.state.roles[id] ?? roleOf(st, this.rt.state, id)) !== 'BACKROOM';
    }) : undefined;
    const from = who ? ((roleOf(st, this.rt.state, who) ?? 'RESTOCK') as AssociateRole) : undefined;
    const waiting = plan.filter((x) => x.arrived && x.startAt > now).length;
    const draft: RecommendationDraft = {
      module: 'INBOUND',
      target: 'DOCK',
      action: who ? { kind: 'MOVE_ASSOCIATE', params: { associateId: who, from: from as string, to: 'BACKROOM', hours: 1, order: order.join(','), nudge: true } } : { kind: 'INFO', params: { order: order.join(','), nudge: true } },
      prediction: { value: who ? worstAfter : worst.waitMin, baseline: worst.waitMin, unit: 'MINUTES', from: now, to: worst.startAt },
      confidence: 0.7,
      reasons: [
        { factor: 'TRUCKS_WAITING', value: waiting, weight: 0.35, params: { upcoming: plan.filter((x) => !x.arrived).length } },
        { factor: 'LONGEST_WAIT', value: worst.waitMin, weight: 0.35, params: { receiptId: worst.receiptId } },
        { factor: 'RECEIVERS', value: this.receivers(now), weight: 0.2, params: { docks: Math.max(1, st.docks?.length ?? 2) } },
        ...(plan.some((x) => x.cold && x.left > 0) ? [{ factor: 'COLD_FIRST', value: plan.filter((x) => x.cold && x.left > 0).length, weight: 0.1 }] : []),
      ],
      alternatives: [],
      model: { id: 'dock-plan', version: 1, kind: 'queue' },
      expiresAt: now + 30 * MIN,
    };
    return (await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok;
  }

  /** 供应商通知晚到 20 分钟以上：更新卸货门计划，告诉带班负责人新的时间、会不会和别的车撞在一起 */
  async onEtaUpdated(receiptId: string, previous: number | undefined, expectedAt: number, now = Date.now()): Promise<boolean> {
    if (previous === undefined || expectedAt - previous < 20 * MIN) return false;
    const r = this.rt.state.receipts[receiptId];
    if (!r) return false;
    const st = this.rt.statics;
    const servers = Math.max(1, Math.min(Math.max(1, st.docks?.length ?? 2), this.receivers(now)));
    const overlap = Object.values(this.rt.state.receipts).filter((x) => x.id !== receiptId && x.closedAt === undefined && Math.abs((x.arrivedAt ?? x.expectedAt ?? Infinity) - expectedAt) <= 30 * MIN).length;
    const slot = this.dockPlan(now).find((x) => x.receiptId === receiptId);
    const draft: RecommendationDraft = {
      module: 'INBOUND',
      target: `ETA:${receiptId}`,
      action: { kind: 'INFO', params: { receiptId, supplier: r.supplier, from: previous, to: expectedAt, delayMin: Math.round((expectedAt - previous) / MIN), overlap, docks: servers, ...(overlap >= servers ? { nudge: true } : {}) } },
      prediction: { value: slot?.waitMin ?? 0, unit: 'MINUTES', from: expectedAt, to: slot?.endAt ?? expectedAt },
      confidence: 0.8,
      reasons: [
        { factor: 'SUPPLIER_ETA', value: Math.round((expectedAt - previous) / MIN), weight: 0.6, params: { from: previous, to: expectedAt } },
        { factor: 'TRUCKS_AROUND', value: overlap, weight: 0.4, params: { docks: servers } },
      ],
      alternatives: [],
      model: { id: 'dock-plan', version: 1, kind: 'queue' },
      expiresAt: expectedAt + 60 * MIN,
    };
    return (await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok;
  }

  /**
   * 开门前补货（「夜班」的门店版）：下午起看明天开门前要上架的箱数（还没收完的到货）和排了几个人，
   * 按每人每小时约 100 箱估计几点补完；开门前补不完时提醒要几个人，能找到人时直接起草补班邀请。
   */
  async scanNightCrew(now = Date.now()): Promise<boolean> {
    const hours = this.ai.context?.hours ?? [];
    if (!hours.length || new Date(now).getHours() < 14) return false;
    const st = this.rt.statics;
    const s = this.rt.state;
    const t = new Date(now);
    const tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    const date = dateOf(tomorrow.getTime() + 2 * 60 * MIN);
    const open = (hours[0] as number) * 60;
    const from = Math.max(4 * 60, open - 180);
    const openAt = tomorrow.getTime() + open * MIN;
    const cases = Object.values(s.receipts)
      .filter((r) => r.closedAt === undefined && (r.expectedAt ?? r.createdAt) <= openAt - 30 * MIN)
      .reduce((n, r) => n + Math.max(0, r.expected.reduce((a, l) => a + l.cases, 0) - Object.values(r.received).reduce((a, x) => a + x.cases + x.damaged, 0)), 0);
    if (cases < 20) return false;
    const mid = tomorrow.getTime() + ((from + open) / 2) * MIN;
    const crew = st.roster.filter((a) => {
      const d = dutyOf(st, s, a.id, mid);
      const role = d.role ?? a.role;
      return d.on && (role === 'RESTOCK' || role === 'BACKROOM');
    }).length;
    const hoursNeeded = cases / STOCK_CASES_PER_HOUR;
    const windowH = (open - from) / 60;
    const finishMin = Math.round(from + (crew ? (hoursNeeded / crew) * 60 : Infinity));
    const need = Math.ceil(hoursNeeded / windowH);
    if (crew >= need) return false;
    const key = `${date}:${crew}:${need}`;
    if (key === this.lastNight) return false;
    this.lastNight = key;
    const onNow = new Set(st.roster.filter((x) => dutyOf(st, s, x.id, mid).on).map((x) => x.id));
    const cand = s.schedules?.[weekOf(date)] ? this.candidatesFor(date, from, open, 'RESTOCK', onNow).find((c) => !c.overtime) : undefined;
    const late = Number.isFinite(finishMin) ? finishMin - open : 999;
    const draft: RecommendationDraft = {
      module: 'INBOUND',
      target: 'NIGHT',
      action: cand ? { kind: 'OFFER_SHIFT', params: { associateId: cand.id, date, from: cand.from, to: cand.to, role: 'RESTOCK', nudge: true } } : { kind: 'INFO', params: { date, crew, need, cases, from, open, ...(Number.isFinite(finishMin) ? { finish: finishMin } : {}), nudge: true } },
      prediction: { value: Math.max(0, Math.round(from + (hoursNeeded / Math.max(1, crew + (cand ? 1 : 0))) * 60) - open), baseline: late, unit: 'MINUTES' },
      confidence: 0.7,
      reasons: [
        { factor: 'CASES_TONIGHT', value: cases, weight: 0.45 },
        { factor: 'NIGHT_CREW', value: crew, weight: 0.3, params: { need } },
        { factor: 'FINISH_AT', value: late, weight: 0.25, params: { finish: Number.isFinite(finishMin) ? finishMin : -1, open } },
      ],
      alternatives: [],
      model: { id: 'night-crew', version: 1, kind: 'workload' },
      expiresAt: openAt,
    };
    return (await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok;
  }

  /**
   * 前场收银通道：入口客流（最近 10 分钟）和趋势 → 现在和 30 分钟后要开几条人工通道（Erlang C，平均排队不超过 2 分钟）；
   * 需要的通道数变了才发；要多开时提前 10 分钟提醒带班负责人叫人。
   */
  async scanFront(now = Date.now()): Promise<boolean> {
    const lanes = this.opts.lanes;
    const flow = this.opts.shoppers?.();
    if (!lanes || lanes.manual <= 0 || !flow || !(flow.now > 0)) return false;
    const trend = flow.before !== undefined && flow.before > 0 ? Math.max(-0.5, Math.min(0.5, (flow.now - flow.before) / flow.before)) * 1.5 : 0;
    const next = Math.max(0, flow.now * (1 + trend));
    const cur = lanesNeeded(flow.now, lanes.manual, lanes.self > 0);
    const ahead = lanesNeeded(next, lanes.manual, lanes.self > 0);
    const key = `${cur.lanes}:${ahead.lanes}`;
    if (key === this.lastLanes) return false;
    this.lastLanes = key;
    const draft: RecommendationDraft = {
      module: 'FRONT',
      target: 'LANES',
      action: { kind: 'INFO', params: { lanes: cur.lanes, next: ahead.lanes, at: now + 30 * MIN, perHour: Math.round(flow.now), nextPerHour: Math.round(next), manual: lanes.manual, wait: Number.isFinite(cur.waitMin) ? Math.round(cur.waitMin * 10) / 10 : 99, ...(ahead.lanes > cur.lanes ? { nudge: true, callAt: now + 20 * MIN } : {}) } },
      prediction: { value: cur.lanes, unit: 'LANES', from: now, to: now + 30 * MIN },
      confidence: 0.7,
      reasons: [
        { factor: 'ENTRANCE_RATE', value: Math.round(flow.now), weight: 0.4 },
        { factor: 'FLOW_TREND', value: Math.round(trend * 100), weight: 0.3 },
        { factor: 'SERVICE_MIN', value: FRONT_RULES.serviceMin, weight: 0.15 },
        { factor: 'TARGET_WAIT', value: FRONT_RULES.targetWaitMin, weight: 0.15 },
      ],
      alternatives: [],
      model: { id: 'front-lanes', version: 1, kind: 'erlang-c' },
      expiresAt: now + 30 * MIN,
    };
    return (await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now })).ok;
  }

  // ---------------------------------------------------------------------------
  // 效果追踪（决策记录 0022 · F4）

  /** 记一次冷区暂存占用（冷藏、冷冻里高的那个）和拣货积压（还没拣完的批次剩下的预计用时，分钟），和推演里的同名指标对应 */
  sample(now = Date.now()): void {
    const s = this.rt.state;
    const cold = Math.max(0, ...stagingOccupancy(s, this.rt.statics).filter((z) => z.tempZone === 'CHILLED' || z.tempZone === 'FROZEN').map((z) => z.rate));
    let backlog = 0;
    for (const w of Object.values(s.walks)) {
      if (w.status === 'COMPLETED') continue;
      const total = w.stops.reduce((n, x) => n + x.picks.reduce((m, pk) => m + pk.qty, 0), 0);
      const done = Object.values(w.done).reduce((a, b) => a + b, 0);
      backlog += (w.ai?.sec ?? w.estimatedSec) * (total ? Math.max(0, 1 - done / total) : 1);
    }
    this.samples.push({ t: now, cold: Math.round(cold * 1000) / 1000, backlog: Math.round(backlog / 6) / 10 });
    const cut = now - 4 * 60 * MIN;
    while (this.samples.length && (this.samples[0] as { t: number }).t < cut) this.samples.shift();
  }

  /** 建议的时间段过去、或者对应的任务做完之后，从事件流算出同一个指标的实际值，写进事件流 */
  async measureOutcomes(now = Date.now()): Promise<number> {
    let n = 0;
    for (const r of Object.values(this.rt.state.recs)) {
      if (r.outcome || this.unmeasurable.has(r.id)) continue;
      // 订单量预测只是信息：时间段过去就对账（不管有没有被新的预测取代）；其他建议要有人处理过
      if (r.module !== 'FORECAST' && (r.status === 'OPEN' || r.status === 'SUPERSEDED')) continue;
      const o = this.outcomeOf(r, now);
      if (o === null) {
        this.unmeasurable.add(r.id);
        continue;
      }
      if (o && (await this.rt.submit({ cmd: { type: 'RecordOutcome', recId: r.id, outcome: o }, actor: 'ai', at: now })).ok) n++;
    }
    return n;
  }

  /** 一条建议的实际效果；还不能测（时间没到、任务没做完）返回 undefined，永远测不了返回 null */
  outcomeOf(r: LiveRec, now: number): Omit<RecOutcome, 'adopted' | 'at'> | undefined | null {
    const s = this.rt.state;
    const adopted = r.status === 'ACCEPTED' || r.status === 'AUTO_APPLIED';
    const p = r.action.params ?? {};
    const r2 = (v: number) => Math.round(v * 100) / 100;
    switch (r.module) {
      // 运营预警：时间段结束后，同一个指标的实际值；采纳的看实现了预计改善的多少，没采纳的看问题有没有真的发生（对照）
      case 'FORESIGHT': {
        const pr = r.prediction;
        const end = pr?.to;
        if (!pr || end === undefined) return null;
        if (now < end + 5 * MIN) return undefined;
        const kind = r.target;
        let actual: number;
        if (kind === 'LATE') actual = this.actualLate(r.issuedAt, end, now);
        else if (kind === 'WAIT') actual = this.actualWait(r.issuedAt, end);
        else {
          const xs = this.samples.filter((x) => x.t >= r.issuedAt && x.t <= end);
          if (xs.length < 3) return null;
          actual = Math.max(...xs.map((x) => (kind === 'COLD_FULL' ? x.cold : x.backlog)));
        }
        const baseline = pr.baseline ?? pr.value;
        const limit = Number(r.reasons.find((x) => x.factor === `PROBLEM_${kind}`)?.params?.limit ?? (kind === 'BACKLOG' ? 60 : baseline));
        const realized = adopted && baseline - pr.value > 1e-9 ? Math.max(-2, Math.min(2, (baseline - actual) / (baseline - pr.value))) : undefined;
        const hit = adopted ? (realized !== undefined ? realized >= 0.5 : actual <= pr.value + 1e-9) : actual >= limit;
        return { kind: 'EFFECT', metric: kind, unit: pr.unit, predicted: pr.value, baseline, actual: r2(actual), hit, ...(realized !== undefined ? { realized } : {}) };
      }
      // 核对货架、附近找一找：员工去看的结果
      case 'AVAILABILITY': {
        if (!adopted) return null;
        const c = Object.values(s.checks).find((x) => x.recId === r.id);
        if (!c) return null;
        if (c.status !== 'DONE' || c.units === undefined) return undefined;
        if (r.action.kind === 'SEARCH_NEARBY') return c.found ? { kind: 'EVENT', metric: 'MISPLACED', unit: 'PROBABILITY', predicted: r.prediction?.value ?? 0.5, actual: c.found === 'NEARBY' ? 1 : 0, hit: c.found === 'NEARBY' } : null;
        return { kind: 'EVENT', metric: 'ON_SHELF', unit: 'PROBABILITY', predicted: r.prediction?.value ?? 0.5, actual: c.units > 0 ? 1 : 0, hit: c.units === 0 };
      }
      // 顺路核对：AI 本来就说不准，只用来校准概率
      case 'PICKING': {
        if (r.action.kind !== 'ADD_WALK_CHECK' || !adopted) return null;
        const w = s.walks[String(p.walkId ?? '')];
        const c = w?.checks?.find((x) => x.itemId === p.itemId);
        if (!w || !c || c.status === 'SKIPPED') return null;
        if (c.status !== 'DONE' || c.units === undefined) return w.status === 'COMPLETED' ? null : undefined;
        const pOn = r.prediction?.value ?? 0.5;
        return { kind: 'CALIBRATION', metric: 'ON_SHELF', unit: 'PROBABILITY', predicted: pOn, actual: c.units > 0 ? 1 : 0, hit: pOn >= 0.5 === c.units > 0 };
      }
      // 预测性维护：修好时记下的实际故障
      case 'EQUIPMENT': {
        if (!adopted) return null;
        const tk = Object.values(s.tickets ?? {}).find((x) => x.recId === r.id);
        if (!tk) return null;
        if (tk.status !== 'CLOSED' || !tk.fault) return undefined;
        return { kind: 'EVENT', metric: 'FAULT', unit: 'PROBABILITY', predicted: r.confidence, actual: tk.fault !== 'NONE' ? 1 : 0, hit: tk.fault !== 'NONE' };
      }
      // 到店时间：顾客到了以后，AI 的预计是不是比导航准
      case 'ETA': {
        const pr = r.prediction;
        if (r.action.kind !== 'USE_AI_ETA' || !pr) return null;
        const o = s.orders[String(p.orderId ?? '')];
        if (!o || o.status === 'CANCELLED') return null;
        if (o.arrivedAt === undefined) return now > r.expiresAt + 60 * MIN ? null : undefined;
        const actual = (o.arrivedAt - (pr.from ?? r.issuedAt)) / MIN;
        const nav = pr.baseline ?? pr.value;
        return { kind: 'EVENT', metric: 'ETA_MIN', unit: 'MINUTES', predicted: pr.value, baseline: nav, actual: Math.round(actual * 10) / 10, hit: Math.abs(actual - pr.value) <= Math.abs(actual - nav) };
      }
      // 盘点建议：盘出来有没有差异
      case 'COUNT': {
        if (r.action.kind !== 'CREATE_COUNT' || !adopted) return null;
        const c = Object.values(s.counts).find((x) => x.binCode === p.binCode && x.reason === 'AI_RISK' && x.createdAt >= (r.resolvedAt ?? r.issuedAt) - 1000);
        if (!c) return null;
        if (c.status !== 'DONE' || !c.results) return undefined;
        const wrong = c.results.some((x) => x.expected !== x.counted);
        return { kind: 'EVENT', metric: 'RECORD_WRONG', unit: 'PROBABILITY', predicted: r.prediction?.value ?? r.confidence, actual: wrong ? 1 : 0, hit: wrong };
      }
      // 订单量预测：时间段过去后数实际的单（按取货时段），看落没落在 80% 区间里
      case 'FORECAST': {
        const pr = r.prediction;
        if (pr?.unit !== 'ORDERS' || pr.from === undefined || pr.to === undefined) return null;
        if (now < pr.to) return undefined;
        const actual = Object.values(s.orders).filter((o) => o.status !== 'CANCELLED' && o.slotStart >= (pr.from as number) && o.slotStart < (pr.to as number)).length;
        return { kind: 'CALIBRATION', metric: 'ORDERS', unit: 'ORDERS', predicted: pr.value, actual, hit: actual >= (pr.low ?? -Infinity) && actual <= (pr.high ?? Infinity) };
      }
      default:
        return null;
    }
  }

  /** 赶不上取货时段的订单：取货时段开始前还没全部暂存（建议发出时已经暂存好、或者很久以前的订单不算） */
  private actualLate(from: number, to: number, now: number): number {
    let n = 0;
    for (const o of Object.values(this.rt.state.orders)) {
      if (o.status === 'CANCELLED' || o.slotStart > to || o.slotStart < from - 6 * 60 * MIN || o.createdAt > to) continue;
      const staged = o.stagedAt ?? (o.status === 'COMPLETED' ? o.completedAt : undefined);
      if (staged !== undefined && staged < from) continue;
      if (staged === undefined ? o.slotStart <= now : staged > o.slotStart) n++;
    }
    return n;
  }

  /** 这段时间里到店的顾客平均等了多久（分钟）：到店到交付完成；没交付完的算到时间段结束 */
  private actualWait(from: number, to: number): number {
    const waits: number[] = [];
    for (const o of Object.values(this.rt.state.orders)) {
      const trip = o.tripId ? this.rt.state.trips[o.tripId] : undefined;
      const arr = trip?.arrivedAt ?? o.arrivedAt;
      if (arr === undefined || arr > to || o.status === 'CANCELLED') continue;
      const done = trip?.completedAt ?? o.completedAt;
      if (done !== undefined && done < from) continue;
      waits.push(Math.max(0, ((done ?? to) - Math.max(arr, from)) / MIN));
    }
    return waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  }

  // ---------------------------------------------------------------------------
  // 订单量展望

  async maybeOutlook(now = Date.now()): Promise<boolean> {
    const draft = this.ai.outlookDraft(now, { minObsMin: this.opts.outlookMinObsMin ?? 20 });
    if (!draft) return false;
    const cur = this.rt.state.outlook;
    const hourChanged = !cur || new Date(cur.at).getHours() !== new Date(now).getHours() || now - cur.at >= 60 * MIN;
    const drifted = !!cur && now - cur.at >= (this.opts.outlookDriftMin ?? 10) * MIN && Math.abs(draft.correction - cur.correction) >= 0.08;
    if (!hourChanged && !drifted) return false;
    const r = await this.rt.submit({ cmd: { type: 'PublishOutlook', outlook: draft }, actor: 'ai', at: now });
    return r.ok;
  }

  // ---------------------------------------------------------------------------
  // 运营预警

  /** 此刻可以调动的人：在班次里、没被锁定、手上没有任务；按岗位分组，同岗位里今天做得少的在前（负荷均衡） */
  private movablePeople(now: number): Record<ForecastRole | 'OTHER', string[]> {
    const s = this.rt.state;
    const st = this.rt.statics;
    const out: Record<ForecastRole | 'OTHER', string[]> = { PICK: [], STAGE: [], HANDOFF: [], OTHER: [] };
    const doneBy = new Map<string, number>();
    for (const w of Object.values(s.walks)) if (w.status === 'COMPLETED' && w.associateId) doneBy.set(w.associateId, (doneBy.get(w.associateId) ?? 0) + 1);
    for (const a of st.roster) {
      const duty = dutyOf(st, s, a.id, now);
      if (a.role === 'LEAD' || !duty.on || s.staffLocks[a.id] || isBusy(s, a.id)) continue;
      const r = s.roles[a.id] ?? duty.role ?? roleOf(st, s, a.id) ?? a.role;
      const k: ForecastRole | 'OTHER' = r === 'PICK' || r === 'STAGE' || r === 'HANDOFF' ? r : r === 'RESTOCK' || r === 'BACKROOM' ? 'OTHER' : 'OTHER';
      if (r === 'DELI') continue;
      out[k].push(a.id);
    }
    for (const k of Object.keys(out) as Array<keyof typeof out>) out[k].sort((x, y) => (doneBy.get(x) ?? 0) - (doneBy.get(y) ?? 0) || x.localeCompare(y));
    return out;
  }

  async scanForesight(now = Date.now()): Promise<ForesightResult | undefined> {
    const s = this.rt.state;
    const ppl = this.movablePeople(now);
    const result = foresee(s, this.rt.statics, now, { horizonMin: 120, callIn: true, movable: { PICK: ppl.PICK.length, STAGE: ppl.STAGE.length, HANDOFF: ppl.HANDOFF.length, OTHER: ppl.OTHER.length } });
    this.last = { at: now, result };
    // 先处理更要紧的问题；拣货积压和迟到同时出现时是同一件事（积压造成迟到），只按迟到发；
    // 几个问题的最好办法相同（例如都是调同一个人去拣货）时只发一条
    const order = ['LATE', 'WAIT', 'COLD_FULL', 'BACKLOG'];
    const problems = [...result.problems].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).filter((p) => !(p.kind === 'BACKLOG' && result.problems.some((x) => x.kind === 'LATE')));
    const used = new Set<string>();
    // 每个人只出现在一条调人建议里（包括之前发出、还没处理的其他建议）
    this.takenPeople = new Set<string>();
    for (const problem of problems) {
      this.takenPeople = new Set([...this.takenPeople, ...Object.values(s.recs).filter((r) => r.status === 'OPEN' && r.action.kind === 'MOVE_ASSOCIATE' && !(r.module === 'FORESIGHT' && r.target === problem.kind)).map((r) => String(r.action.params?.associateId ?? ''))]);
      // 每类问题一条建议；新的取代旧的（作业核心按模块 + 对象取代）
      const target = problem.kind;
      const recent = Object.values(s.recs).filter((r) => r.module === 'FORESIGHT' && r.target === target).sort((a, b) => b.issuedAt - a.issuedAt)[0];
      // 被否决或忽略后 30 分钟内同一类问题不再提
      if (recent && (recent.status === 'OVERRIDDEN' || recent.status === 'DISMISSED') && now - (recent.resolvedAt ?? recent.issuedAt) < 30 * MIN) continue;
      // 办法必须真的改善它要解决的问题（例如迟到的单数要变少），而不只是改善别的指标
      const base = result.base.kpi;
      // 改善要够明显：迟到至少少 1 单且少一成；等待至少少一成半（或 1 分钟），只缩短最长等待时平均不能变长；冷区至少降 3 个百分点；积压至少少一成
      const helps = (k: typeof base) =>
        problem.kind === 'LATE'
          ? base.late - k.late >= Math.max(1, 0.1 * base.late)
          : problem.kind === 'WAIT'
            ? base.avgWaitMin - k.avgWaitMin >= Math.max(1, 0.15 * base.avgWaitMin) || (base.maxWaitMin - k.maxWaitMin >= Math.max(2, 0.15 * base.maxWaitMin) && k.avgWaitMin <= base.avgWaitMin)
            : problem.kind === 'COLD_FULL'
              ? base.peakColdOccupancy - k.peakColdOccupancy >= 0.03
              : base.peakBacklogMin - k.peakBacklogMin >= Math.max(5, 0.1 * base.peakBacklogMin);
      // 也不能让别的主要指标变差：迟到不能变多，平均等待最多长一成（或 1 分钟）
      const noHarm = (k: typeof base) => k.late <= base.late && k.avgWaitMin <= base.avgWaitMin + Math.max(1, 0.1 * base.avgWaitMin);
      const relevant = result.options.filter((o) => fits(o.action, problem.kind) && !used.has(actionKey(o.action)) && (o.action.kind === 'NOTIFY_DELAY' || (helps(o.kpi) && noHarm(o.kpi))) && (o.action.kind !== 'MOVE' || this.freePerson(ppl, o.action.from) !== undefined));
      const best = relevant[0];
      const who = best?.action.kind === 'MOVE' ? this.freePerson(ppl, best.action.from) : undefined;
      if (best) used.add(actionKey(best.action));
      if (who) this.takenPeople.add(who);
      const draft = best ? this.draftFor(problem.kind, problem, best, relevant.slice(1, 4), result, ppl, now, who) : undefined;
      if (!draft) continue;
      // 同一个建议还开着、内容差不多：不重复发
      if (recent?.status === 'OPEN' && recent.action.kind === draft.action.kind && JSON.stringify(recent.action.params) === JSON.stringify(draft.action.params) && Math.abs((recent.prediction?.value ?? 0) - (draft.prediction?.value ?? 0)) < 1) continue;
      await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now });
    }
    return result;
  }

  private draftFor(
    kind: (typeof FORESIGHT_TARGETS)[number],
    problem: ForesightResult['problems'][number],
    opt: ForesightResult['options'][number],
    others: ForesightResult['options'],
    result: ForesightResult,
    ppl: Record<ForecastRole | 'OTHER', string[]>,
    now: number,
    who?: string,
  ): RecommendationDraft | undefined {
    const action = this.recAction(opt.action, ppl, problem, now, who);
    if (!action) return undefined;
    const end = result.base.at + result.base.horizonMin * MIN;
    const metric = (k: ForesightResult['base']['kpi']) => (kind === 'LATE' ? k.late : kind === 'WAIT' ? k.avgWaitMin : kind === 'COLD_FULL' ? k.peakColdOccupancy : k.peakBacklogMin);
    const unit = kind === 'LATE' ? 'ORDERS' : kind === 'COLD_FULL' ? 'RATIO' : 'MINUTES';
    const reasons: Reason[] = result.reasons.map((r, i) => ({ factor: r.factor, value: r.value, weight: Math.max(0.1, 0.5 - i * 0.12), ...(r.params ? { params: r.params } : {}) }));
    reasons.unshift({ factor: `PROBLEM_${kind}`, value: Math.round(problem.value * 100) / 100, weight: 0.6, params: { at: problem.at, limit: problem.limit } });
    const total = reasons.reduce((a, r) => a + r.weight, 0);
    for (const r of reasons) r.weight = Math.round((r.weight / total) * 1000) / 1000;
    return {
      module: 'FORESIGHT',
      target: kind,
      action: { ...action, params: { ...action.params, problem: kind, at: problem.at, urgent: problem.at - now <= 30 * MIN, ...(action.kind === 'INFO' ? { nudge: true } : {}), lateAfter: opt.kpi.late, lateBefore: result.base.kpi.late, waitAfter: opt.kpi.avgWaitMin, waitBefore: result.base.kpi.avgWaitMin, coldAfter: opt.kpi.peakColdOccupancy, coldBefore: result.base.kpi.peakColdOccupancy } },
      prediction: { value: Math.round(metric(opt.kpi) * 100) / 100, baseline: Math.round(metric(result.base.kpi) * 100) / 100, unit, from: problem.at, to: end },
      confidence: opt.robust ? 0.85 : 0.6,
      reasons: reasons.slice(0, 4),
      alternatives: others.flatMap((o) => {
        const a = this.recAction(o.action, ppl, problem, now);
        if (!a) return [];
        const params: Record<string, string | number | boolean> = { ...(a.params ?? {}), after: Math.round(metric(o.kpi) * 100) / 100 };
        return [{ action: { kind: a.kind, params }, score: Math.round((o.gain - o.cost) * 100) / 100 }];
      }),
      model: { id: 'ops-foresight', version: 1, kind: 'queue-forecast' },
      expiresAt: now + 15 * MIN,
    };
  }

  private takenPeople = new Set<string>();

  /** 这个岗位里还没被这一轮其他建议用上的第一个人（今天做得少的在前） */
  private freePerson(ppl: Record<ForecastRole | 'OTHER', string[]>, from: ForecastRole | 'OTHER'): string | undefined {
    return ppl[from].find((id) => !this.takenPeople.has(id));
  }

  /** 建议的动作；调人时 who 是选好的人，备选办法选这一轮还没被用上的人 */
  private recAction(a: ForesightAction, ppl: Record<ForecastRole | 'OTHER', string[]>, problem: ForesightResult['problems'][number], now: number, chosen?: string): RecAction | undefined {
    switch (a.kind) {
      case 'MOVE': {
        const who = chosen ?? this.freePerson(ppl, a.from);
        if (!who) return undefined;
        const from = (roleOf(this.rt.statics, this.rt.state, who) ?? 'PICK') as AssociateRole;
        return { kind: 'MOVE_ASSOCIATE', params: { associateId: who, from, to: a.to, hours: 1 } };
      }
      case 'CALL_IN': {
        // 有发布的排班时，找一位此刻不在岗、现在就能来、这周还有工时的人，发补班邀请（决策记录 0022）；找不到时只提醒店长
        const date = dateOf(now);
        const from = Math.ceil((new Date(now).getHours() * 60 + new Date(now).getMinutes()) / 15) * 15;
        const to = Math.min(23 * 60, Math.max(from + 120, Math.ceil(((problem.at + 60 * MIN - new Date(new Date(now).toDateString()).getTime()) / MIN) / 15) * 15));
        const onNow = new Set(this.rt.statics.roster.filter((x) => dutyOf(this.rt.statics, this.rt.state, x.id, now).on).map((x) => x.id));
        const cand = this.rt.state.schedules?.[weekOf(date)] ? this.candidatesFor(date, from, to, a.role as AssociateRole, onNow).find((c) => !c.overtime && c.from <= from + 30) : undefined;
        if (cand) return { kind: 'OFFER_SHIFT', params: { associateId: cand.id, date, from: cand.from, to: cand.to, role: a.role } };
        return { kind: 'INFO', params: { callIn: 1, role: a.role, until: problem.at + 60 * MIN } };
      }
      case 'EXPEDITE':
        return { kind: 'EXPEDITE_ORDERS', params: { orderIds: a.orderIds.join(','), count: a.orderIds.length } };
      case 'DEFER_FROZEN':
        return { kind: 'DEFER_FROZEN', params: { orderIds: a.orderIds.join(','), count: a.orderIds.length, until: Math.round(a.until) } };
      case 'NOTIFY_DELAY':
        return { kind: 'NOTIFY_DELAY', params: { orderIds: a.orderIds.join(','), count: a.orderIds.length, minutes: a.minutes, now } };
    }
  }

  // ---------------------------------------------------------------------------
  // 补位（决策记录 0022 · D2）

  /** 缺勤的那个班：发布的排班里那天的班；没有排班时按名单（学生按自己的时段，其他人按营业时间） */
  private absentShift(ab: Absence): { from: number; to: number; role: AssociateRole } | undefined {
    const s = this.rt.state;
    const a = this.rt.statics.roster.find((x) => x.id === ab.associateId);
    if (!a) return undefined;
    const sched = s.schedules?.[weekOf(ab.date)];
    const sh = sched?.shifts.find((x) => x.associateId === ab.associateId && x.date === ab.date);
    if (sched && !sh) return undefined;
    const ctx = this.ai.context;
    const base = sh ?? (a.shift ? { from: a.shift.from, to: a.shift.to, role: a.role } : { from: ((ctx?.hours[0] ?? 8) - 1) * 60, to: Math.min(((ctx?.hours[0] ?? 8) - 1) * 60 + 8 * 60, ((ctx?.hours.at(-1) ?? 20) + 1) * 60), role: a.role });
    const from = Math.max(base.from, ab.from ?? base.from);
    const to = Math.min(base.to, ab.to ?? base.to);
    return to > from ? { from, to, role: base.role } : undefined;
  }

  /**
   * 能补这个班的人，最合适的在前：会这个岗位、这天这段时间可以上班、这周还有工时、不违反学生和休息的规则；
   * 不加班的在前，其次主岗位就是这个岗位、这周工时少（轮流）。
   */
  candidatesFor(date: string, from: number, to: number, role: AssociateRole, exclude: ReadonlySet<string>): Array<{ id: string; from: number; to: number; hoursLeft: number; overtime: boolean; extend: boolean }> {
    const s = this.rt.state;
    const st = this.rt.statics;
    const week = weekOf(date);
    const dow = (new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay() + 6) % 7;
    const day = shiftsOn(s, date);
    const out: Array<{ id: string; from: number; to: number; hoursLeft: number; overtime: boolean; extend: boolean; score: number }> = [];
    for (const a of st.roster) {
      if (exclude.has(a.id) || a.role === 'LEAD' && role !== 'LEAD') continue;
      if (a.role !== role && !a.skills?.includes(role)) continue;
      if (Object.values(s.absences ?? {}).some((ab) => ab.associateId === a.id && ab.date === date)) continue;
      // 可上班时间（学生：上学日放学后 16–21 点、最多 4 小时；周末 9–20 点、最多 6 小时）
      const student = a.employment === 'STUDENT';
      const school = dow <= 4;
      let wf = 0;
      let wt = 1440;
      if (a.availability) {
        const w = a.availability.find((x) => x.day === dow);
        if (!w) continue;
        wf = w.from;
        wt = w.to;
      }
      if (student) {
        wf = Math.max(wf, (school ? 16 : 9) * 60);
        wt = Math.min(wt, (school ? 21 : 20) * 60);
      }
      const mine = day.find((x) => x.associateId === a.id);
      let f = Math.max(from, wf);
      let t = Math.min(to, wt);
      // 当天已经有班：只能接在自己的班前后（延长），总长不超过 10 小时
      if (mine) {
        if (mine.to >= f && mine.to < t) f = mine.to;
        else if (mine.from <= t && mine.from > f) t = mine.from;
        else continue;
        if (Math.max(mine.to, t) - Math.min(mine.from, f) > 10 * 60) t = Math.min(t, Math.min(mine.from, f) + 10 * 60);
      }
      const len = t - f;
      if (len < (mine ? 60 : 180)) continue;
      if (student && len + (mine ? mine.to - mine.from : 0) > (school ? 4 : 6) * 60) continue;
      const cap = Math.min(a.maxWeeklyHours ?? 99, student ? 20 : a.employment === 'PART_TIME' ? 28 : 48);
      const used = weekHours(s, a.id, week);
      if (used + len / 60 > cap) continue;
      const overtime = !student && a.employment !== 'PART_TIME' && used + len / 60 > 40;
      const cover = len / (to - from);
      out.push({ id: a.id, from: f, to: t, hoursLeft: Math.round((cap - used) * 10) / 10, overtime, extend: !!mine, score: cover * 3 - (overtime ? 2 : 0) + (a.role === role ? 0.6 : 0) - used / 40 });
    }
    return out.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id)).map(({ score: _score, ...rest }) => rest);
  }

  private async offerFor(ab: Absence, exclude: ReadonlySet<string>, now: number, followUpOf?: string): Promise<boolean> {
    const shift = this.absentShift(ab);
    if (!shift) return false;
    const cands = this.candidatesFor(ab.date, shift.from, shift.to, shift.role, exclude);
    const best = cands[0];
    const name = (id: string) => this.rt.statics.roster.find((a) => a.id === id)?.name ?? id;
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    // 今天的缺勤：用推演看缺这个人会怎样
    let impact: { lateBefore: number; lateAfter: number } | undefined;
    if (ab.date === dateOf(now) && (shift.role === 'PICK' || shift.role === 'STAGE' || shift.role === 'HANDOFF')) {
      const short = forecast(this.rt.state, this.rt.statics, now, { horizonMin: 180, staffDelta: { [shift.role]: -1 } });
      const full = forecast(this.rt.state, this.rt.statics, now, { horizonMin: 180 });
      impact = { lateBefore: short.kpi.late, lateAfter: full.kpi.late };
    }
    const draft: RecommendationDraft = {
      module: 'STAFFING',
      target: `absence:${ab.id}`,
      action: best
        ? { kind: 'OFFER_SHIFT', params: { associateId: best.id, date: ab.date, from: best.from, to: best.to, role: shift.role, replaces: ab.associateId, absenceId: ab.id, extend: best.extend, overtime: best.overtime, ...(followUpOf ? { followUpOf } : {}) } }
        : { kind: 'INFO', params: { absenceId: ab.id, replaces: ab.associateId, date: ab.date, from: shift.from, to: shift.to, role: shift.role, nobody: 1, nudge: true } },
      ...(impact ? { prediction: { value: impact.lateAfter, baseline: impact.lateBefore, unit: 'ORDERS' } } : {}),
      confidence: best ? (best.overtime ? 0.6 : 0.8) : 0.5,
      reasons: [
        { factor: 'ABSENCE', weight: 0.4, params: { who: name(ab.associateId), from: hm(shift.from), to: hm(shift.to), role: shift.role, date: ab.date } },
        ...(best ? [{ factor: best.extend ? 'CAN_EXTEND' : 'CAN_COVER', weight: 0.3, params: { who: name(best.id), from: hm(best.from), to: hm(best.to) } }, { factor: 'HOURS_LEFT', value: best.hoursLeft, weight: 0.2 }, ...(best.overtime ? [{ factor: 'OVERTIME', weight: 0.1 }] : [{ factor: 'NO_OVERTIME', weight: 0.1 }])] : [{ factor: 'NO_CANDIDATE', weight: 0.6 }]),
      ],
      alternatives: cands.slice(1, 4).map((c) => ({ action: { kind: 'OFFER_SHIFT', params: { associateId: c.id, date: ab.date, from: c.from, to: c.to, role: shift.role, replaces: ab.associateId } }, score: c.overtime ? 0 : 1 })),
      model: { id: 'shift-fill', version: 1, kind: 'rules' },
      expiresAt: Math.max(now + 2 * 3_600_000, new Date(Number(ab.date.slice(0, 4)), Number(ab.date.slice(5, 7)) - 1, Number(ab.date.slice(8, 10))).getTime() + shift.from * 60_000),
    };
    const r = await this.rt.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now });
    return r.ok;
  }

  async onAbsence(ab: Absence, now = Date.now()): Promise<boolean> {
    return this.offerFor(ab, new Set([ab.associateId]), now);
  }

  /**
   * 邀请被拒绝：同一次缺勤给下一位（拒绝过、已经邀请过的人不再邀请）。
   * 带班负责人同意过「被拒后自动问下一个人」时，这条建议直接执行（作业核心按 followUpOf 判断，决策记录 0026）。
   */
  async onOfferDeclined(offerId: string, now = Date.now()): Promise<boolean> {
    const s = this.rt.state;
    const o = s.offers?.[offerId];
    if (!o || o.kind !== 'EXTRA' || !o.replaces) return false;
    const ab = Object.values(s.absences ?? {}).find((x) => x.associateId === o.replaces && x.date === o.date);
    if (!ab) return false;
    const tried = new Set([ab.associateId, ...Object.values(s.offers ?? {}).filter((x) => x.replaces === o.replaces && x.date === o.date).map((x) => x.associateId)]);
    return this.offerFor(ab, tried, now, o.autoNext ? o.id : undefined);
  }

  // ---------------------------------------------------------------------------
  // 建议中枢

  async syncNudges(now = Date.now()): Promise<{ sent: number; closed: number }> {
    const ctx = this.ai.context;
    const hours = ctx?.hours.length ? { open: ctx.hours[0] as number, close: (ctx.hours.at(-1) as number) + 1 } : undefined;
    const plan = planNudges(this.rt.state, this.rt.statics, now, { budgetPerHour: 3, escalateAfterMin: this.opts.escalateAfterMin ?? 5, ...(hours ? { hours } : {}) });
    for (const d of plan.deferred) this.deferred[d.why] += 1;
    let closed = 0;
    for (const status of ['DONE', 'EXPIRED'] as const) {
      const ids = plan.close.filter((c) => c.status === status).map((c) => c.id);
      if (!ids.length) continue;
      const r = await this.rt.submit({ cmd: { type: 'CloseNudges', ids, status }, actor: 'ai', at: now });
      if (r.ok) closed += ids.length;
    }
    if (plan.send.length) {
      const r = await this.rt.submit({ cmd: { type: 'SendNudges', nudges: plan.send }, actor: 'ai', at: now });
      if (!r.ok) return { sent: 0, closed };
    }
    return { sent: plan.send.length, closed };
  }

  stats(now = Date.now()): NudgeStats & { deferred: Record<'BUSY' | 'BUDGET' | 'NIGHT', number> } {
    return { ...nudgeStats(this.rt.state, now), deferred: { ...this.deferred } };
  }
}

const actionKey = (a: ForesightAction) => JSON.stringify(a);

/** 这个办法能不能解决这类问题 */
function fits(a: ForesightAction, kind: (typeof FORESIGHT_TARGETS)[number]): boolean {
  switch (a.kind) {
    case 'MOVE':
    case 'CALL_IN':
      return kind === 'LATE' || kind === 'BACKLOG' ? a.kind === 'MOVE' ? a.to === 'PICK' : a.role === 'PICK' : a.kind === 'MOVE' ? a.to === 'HANDOFF' : a.role === 'HANDOFF';
    case 'EXPEDITE':
      return kind === 'LATE' || kind === 'BACKLOG';
    case 'DEFER_FROZEN':
      return kind === 'COLD_FULL';
    case 'NOTIFY_DELAY':
      return kind === 'LATE';
  }
}
