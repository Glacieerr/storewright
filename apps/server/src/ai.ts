import { keyedUniform, volumeLiters, type TempZone } from '@storewright/domain';
import {
  abcPolicy,
  aggregateForecast,
  AVAILABILITY_GATE,
  backtest,
  bayesAvailability,
  discountSilence,
  COUNT_GATE,
  evaluateAvailability,
  fitAvailability,
  fitCountRisk,
  makeCountItems,
  predictAvailability,
  predictCountRisk,
  rankSubstitutes,
  riskPolicy,
  ruleScore,
  simulateCounting,
  evaluateSubstitution,
  SUBSTITUTION_GATE,
  adviseDispatch,
  evaluatePrepTime,
  evaluateReturns,
  fitPrepTime,
  predictPrepTime,
  suggestDisposition,
  type PrepParams,
  type ReturnParams,
  planStaffing,
  STAFF_ROLES,
  type DispatchState,
  type StaffRole,
  type SubstitutionParams,
  type Reason,
  type AvailabilityParams,
  type CountRiskParams,
  confidenceFromInterval,
  ETA_GATE,
  ETA_VARIANTS,
  evaluateEta,
  fitEta,
  FORECAST_GATE,
  FORECASTERS,
  hourlySeries,
  ModelRegistry,
  predictEta,
  withDerived,
  type Alternative,
  type CustomerStats,
  type DailyHours,
  type EtaParams,
  type EtaSample,
  type GateResult,
  type ModelVersion,
  type RecommendationDraft,
  type RegistryData,
  type SeriesPoint,
  evaluatePickTime,
  fitPickTime,
  PICK_VARIANTS,
  PICKTIME_GATE,
  predictPickWalk,
  type PickTenure,
  type PickTimeParams,
  type PickWalkSample,
  fixedHeads,
  generateSchedule,
  headsFromWorkload,
  naiveSchedule,
  workloadByHour,
  type ScheduleAssociate,
  type ScheduleDemand,
  type ScheduleResult,
  DEFAULT_RELIABILITY,
  evaluateNoShow,
  evaluateAttributes,
  evaluatePersonalization,
  fitNoShow,
  NOSHOW_GATE,
  NOSHOW_VARIANTS,
  predictNoShow,
  type NoShowParams,
  fuseShelf,
  learnReliability,
  reliabilityOf,
  SHELF_SIGNALS,
  type ShelfBelief,
  type ShelfSignal,
  type ShelfSignalKind,
  type SignalReliability,
} from '@storewright/ai';
import { allowedDispositions, dateInWeek, dutyOf, handoffBoard, isBusy, openTaskAt, planogramByItem, returnBlocks, roleOf, scheduleAssociates, shelfNow, type AiModelHealth, type AnyOpsEvent, type AssociateRole, type DemandOutlook, type LiveOrder, type LiveRec, type LiveWalk, type PlanogramEntry, type ReturnDisposition, type ReturnLine, type WalkEstimate } from '@storewright/ops';
import { aisleDistance, DEFAULT_DEMAND, generateArrivals, generateNoShowRecords, generateDeliHistory, generateDemandHistory, generatePickRecords, generateReturns, generateShelfTruth, generateSubstitutionEvents, isPerishableCategory, isRushHour, pickLocationsFromModel, STORE_TRAFFIC, substituteCandidates, type DemandHistory, type HistoryFactors, type PickLocationInfo } from '@storewright/synth';
import type { HubStorage } from './storage';
import type { DemoStore } from './demo';
import type { StoreRuntime, SubmitResult } from './runtime';

/**
 * 门店 AI 服务（决策记录 0010）：每家店一份模型仓库，在本机训练和推理，不调用外部服务。
 *
 * - 仿真预训练：用该店的门店配置生成两年合成需求历史（含模型看不到的隐藏因素和一次结构性变化），
 *   回测全部预测器（基线 + 正式模型），最好的一个过上线门槛后成为当前版本；
 * - 真实数据接管：事件流里完整的营业日（订单量达到平时一半以上）替换同一天的合成数据，
 *   合成数据的权重随真实天数增加而降低：w = 28 / (28 + 真实天数)；
 * - 重新训练：候选与当前版本在同一份数据上比较（当前版本重新回测），没有明显改善就保留当前版本；
 * - 每到一个新的小时，发出一条「未来几小时订单量」的预测建议（信息类），附理由、区间、按温区的商品行数和其他模型的预测；
 * - 到店时间修正：顾客点「我在路上」时，按导航用时、高峰、天气预报和这位顾客以往的到店记录修正预计到达，
 *   发出「使用 AI 修正的到达时间」建议（默认自动执行：交付看板按修正后的时间提醒）；
 * - 可售概率 / 幽灵库存：收银流水正常时，每 10 分钟检查一次「系统有货、但该卖没卖」的商品，发出「核对货架」建议；
 * - 按风险盘点：每天一次，按后仓记录不准的概率发出「盘点这个库位」建议。
 *
 * 促销日历与天气预报属于「事先可以知道」的信息：演示中由同一个种子的合成计划提供（延伸到训练日之后）。
 * 模型仓库和预测需要的上下文保存在 ai_state 表里，重启后直接恢复，不需要重新训练。
 */

export const ORDERS_MODEL = 'orders-hourly';
export const ETA_MODEL = 'eta-arrival';
export const AVAILABILITY_MODEL = 'shelf-availability';
export const COUNT_MODEL = 'count-risk';
export const SUBSTITUTION_MODEL = 'substitution';
export const MTO_MODEL = 'mto-prep';
export const RETURNS_MODEL = 'returns-disposition';
/** 拣货时长预测（决策记录 0021 · B1） */
export const PICKTIME_MODEL = 'pick-time';
/** 未取订单的风险（决策记录 0023 · B5） */
export const NOSHOW_MODEL = 'no-show';
/** 收银流水中断超过这个时间时，不用「沉默」判断幽灵库存（演示中客流仿真没开时也是这样） */
const POS_GAP_MS = 30 * 60_000;
const HOUR_MS = 3_600_000;
/** 「找得到的概率」低于这个值才发出核对建议（宁可少报，也不要让员工白跑） */
const ALERT_BELOW = 0.35;
/** 销售比例向计划比例收缩的强度（相当于已经看过多少件全店销售） */
const SHARE_PRIOR = 400;

/** 预测窗口的小时数 */
const WINDOW_HOURS = 3;
const DAY_MS = 86_400_000;
/** 回测窗口：最后 12 周 */
const BACKTEST_DAYS = 84;
/** 真实数据接管时合成数据降权的半衰天数 */
const LIVE_HALF = 28;

export interface AiContext {
  /** 合成历史：第一天（本地日期）、训练天数、种子、结构性变化 */
  history: { from: string; days: number; seed: number; regime: { day: number; multiplier: number } | null };
  /** 有订单的小时 */
  hours: number[];
  /** 星期-小时 → 最近 4 周的平均订单数（「比平时高 / 低多少」的对照） */
  usual: Record<string, number>;
  /** 按温区的商品行占比与每单平均行数（最近 4 周） */
  zoneShares: Record<string, number>;
  linesPerOrder: number;
}

interface AiStateRow {
  registry: RegistryData;
  context: AiContext;
  /** 拣货员报告的可靠度（多源货架真相，决策记录 0022 · C1） */
  reliability?: SignalReliability;
  /** 替代品的真实标签（交付时的顾客反应）、要求删除个人记录的顾客（决策记录 0023 · B4） */
  subLabels?: SubLabel[];
  forgotten?: string[];
}

/** 一条替代品的真实标签：原商品、替代品条码、AI 推荐里的名次、顾客满不满意 */
export interface SubLabel {
  itemId: string;
  gtin: string;
  rank?: number;
  accepted: boolean;
  customer: string;
  at: number;
}

export interface TrainResult {
  candidates: Array<{ version: number; kind: string; metrics: Record<string, number> }>;
  best: number;
  gate: GateResult;
  promoted: boolean;
  /** 当前版本（如果有）在同一份数据上的指标 */
  championMetrics?: Record<string, number>;
  liveDays: number;
  /** 到店时间修正、可售概率、按风险盘点模型的训练结果 */
  eta: FamilyResult;
  availability: FamilyResult;
  count: FamilyResult;
  substitution: FamilyResult;
  mto: FamilyResult;
  returns: FamilyResult;
  pickTime: FamilyResult;
  noShow: FamilyResult;
}

export interface SubstituteSuggestion {
  itemId: string;
  name: string;
  gtin: string;
  unitPrice: number;
  /** 货架上的货位 */
  locationId?: string;
  /** AI 排序时：预计顾客接受的概率与理由 */
  p?: number;
  reasons?: Reason[];
}

export interface FamilyResult {
  best: number;
  kind: string;
  promoted: boolean;
  metrics: Record<string, number>;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isoToUtc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export const daysBetween = (from: string, to: string) => Math.round((isoToUtc(to) - isoToUtc(from)) / DAY_MS);

/**
 * 事件流里的真实营业日：按取货时段开始时间的本地日期和小时统计订单（不含取消的），
 * 只保留今天之前、订单量达到 minPerDay 的日子（数据质量检查：明显不完整的日子不用于训练）。
 */
export function liveDailyHours(
  orders: Iterable<{ slotStart: number; status: string }>,
  opts: { from: string; today: string; hours: readonly number[]; minPerDay: number },
): Array<{ day: number; dow: number; hourly: number[]; date: string }> {
  const keep = new Set(opts.hours);
  const byDate = new Map<string, number[]>();
  for (const o of orders) {
    if (o.status === 'CANCELLED') continue;
    const date = localDate(o.slotStart);
    if (date >= opts.today || date < opts.from) continue;
    const h = new Date(o.slotStart).getHours();
    if (!keep.has(h)) continue;
    const arr = byDate.get(date) ?? new Array<number>(24).fill(0);
    arr[h] = (arr[h] as number) + 1;
    byDate.set(date, arr);
  }
  const out: Array<{ day: number; dow: number; hourly: number[]; date: string }> = [];
  for (const [date, hourly] of byDate) {
    if (hourly.reduce((a, b) => a + b, 0) < opts.minPerDay) continue;
    out.push({ day: daysBetween(opts.from, date), dow: new Date(isoToUtc(date)).getUTCDay(), hourly, date });
  }
  return out.sort((a, b) => a.day - b.day);
}

export class AiService {
  registry = new ModelRegistry();
  context?: AiContext;
  private lastIssued = '';
  /** 事先可以知道的特征（促销日历、天气预报）的缓存：天序号 → 特征 */
  private plan?: { key: string; days: DemandHistory['days'] };
  /** 收银流水：最近一次销售事件、这一段连续流水的开始时间 */
  private lastSaleEvent?: number;
  private posAliveSince?: number;
  /** 这段连续流水里全店卖出的件数、每个商品卖出的件数、每个商品上次卖出时的全店累计件数 */
  private storeUnits = 0;
  private itemUnits = new Map<string, number>();
  private lastSaleMark = new Map<string, number>();
  /** 员工到货架确认数量时全店的累计销量（确认之后的沉默从这里算） */
  private confirmMark = new Map<string, number>();
  private lastShelfScan = 0;
  private lastHealth = 0;
  /** 多源货架真相（决策记录 0022 · C1）：每件商品上次补货 / 核对之后拣货员的报告；各种报告的可靠度（从核对结果学） */
  private readonly signals = new Map<string, ShelfSignal[]>();
  reliability: SignalReliability = { ...DEFAULT_RELIABILITY };
  /** 替代品的真实标签（最多 5000 条）；要求删除个人记录的顾客（按姓名） */
  subLabels: SubLabel[] = [];
  private forgotten = new Set<string>();
  private lastCountScanDay = '';
  private lastDispatchScan = 0;

  constructor(
    private readonly runtime: StoreRuntime,
    private readonly demo: DemoStore,
    private readonly storage: Pick<HubStorage, 'loadAiState' | 'saveAiState'>,
    private readonly opts: { historyDays?: number; seed?: number } = {},
  ) {
    // 顾客上报预计到达时，修正并发出建议（只处理新事件；AI 自己发出的事件不会触发）
    runtime.subscribe((m) => {
      if (m.t !== 'events') return;
      for (const e of m.events) {
        if (e.type === 'EtaUpdated' && e.payload.orderId) void this.issueEta(e).catch(() => undefined);
        if (e.type === 'MtoTicketCreated') void this.issueMtoStart(e.payload.ticketId, e.at).catch(() => undefined);
        if (e.type === 'ShelfCounted') {
          this.confirmMark.set(e.payload.itemId, this.storeUnits);
          // 员工数过货架：用结果更新这件商品之前那些报告的可靠度，然后清空
          const list = this.signals.get(e.payload.itemId);
          if (list?.length) {
            this.reliability = learnReliability(this.reliability, list, e.payload.units, e.payload.found);
            this.signals.delete(e.payload.itemId);
            void this.save().catch(() => undefined);
          }
        }
        if (e.type === 'ReplenishmentCompleted') this.signals.delete(e.payload.itemId);
        // 替代品的真实标签（决策记录 0023 · B4）
        if (e.type === 'SubstitutionRated') {
          const o = this.runtime.state.orders[e.payload.orderId];
          const line = o?.lines.find((l) => l.lineId === e.payload.lineId);
          if (o && line && !this.forgotten.has(customerKey(o))) {
            this.subLabels = [...this.subLabels.filter((x) => !(x.customer === customerKey(o) && x.itemId === line.itemId && x.at === e.at)), { itemId: line.itemId, gtin: e.payload.gtin ?? '', ...(e.payload.rank !== undefined ? { rank: e.payload.rank } : {}), accepted: e.payload.accepted, customer: customerKey(o), at: e.at }].slice(-5000);
            void this.save().catch(() => undefined);
          }
        }
        if (e.type === 'ItemNotFound' || e.type === 'ItemPicked') {
          const t = this.runtime.state.totes[e.payload.toteId];
          const itemId = t ? this.runtime.state.orders[t.orderId]?.lines.find((l) => l.lineId === e.payload.lineId)?.itemId : undefined;
          if (itemId) {
            const kind: ShelfSignalKind = e.type === 'ItemPicked' ? 'PICKED_OK' : (({ EMPTY: 'NOT_FOUND_EMPTY', NOT_AT_LOCATION: 'NOT_FOUND_ELSEWHERE', DAMAGED: 'NOT_FOUND_DAMAGED', PRICE_TAG: 'NOT_FOUND_TAG', OTHER: 'NOT_FOUND_OTHER' } as const)[e.payload.reason ?? 'EMPTY'] ?? 'NOT_FOUND_EMPTY');
            const list = this.signals.get(itemId) ?? [];
            list.push({ kind, at: e.at });
            this.signals.set(itemId, list.slice(-12));
          }
        }
        if (e.type === 'SalesRecorded') {
          if (this.lastSaleEvent === undefined || e.at - this.lastSaleEvent > POS_GAP_MS) {
            this.posAliveSince = e.at;
            this.storeUnits = 0;
            this.itemUnits.clear();
            this.lastSaleMark.clear();
            this.confirmMark.clear();
          }
          this.lastSaleEvent = e.at;
          for (const l of e.payload.lines) {
            this.storeUnits += l.qty;
            this.itemUnits.set(l.itemId, (this.itemUnits.get(l.itemId) ?? 0) + l.qty);
          }
          for (const l of e.payload.lines) this.lastSaleMark.set(l.itemId, this.storeUnits);
        }
      }
    });
  }

  /** 载入模型仓库；还没有当前版本时做仿真预训练 */
  async init(now = Date.now()): Promise<void> {
    const raw = (await this.storage.loadAiState(this.runtime.id)) as AiStateRow | undefined;
    if (raw) {
      const row = raw;
      // 旧版本的上下文缺字段时重新训练
      if (row.context?.history?.regime !== undefined && row.context.zoneShares) {
        this.registry = new ModelRegistry(row.registry);
        this.context = row.context;
        if (row.reliability) this.reliability = { ...DEFAULT_RELIABILITY, ...row.reliability };
        if (row.subLabels) this.subLabels = row.subLabels;
        if (row.forgotten) this.forgotten = new Set(row.forgotten);
      }
    }
    const families = [ORDERS_MODEL, ETA_MODEL, AVAILABILITY_MODEL, COUNT_MODEL, SUBSTITUTION_MODEL, MTO_MODEL, RETURNS_MODEL, PICKTIME_MODEL];
    if (families.some((f) => !this.registry.champion(f)) || !this.context) await this.train({ now });
    // 后来加的模型族（决策记录 0023）：只补训练缺的那一个，不用全部重来
    else if (!this.registry.champion(NOSHOW_MODEL)) {
      this.trainNoShow(now, this.opts.seed ?? 107);
      await this.save();
    }
  }

  private scenario() {
    const model = this.demo.ctx.model;
    return DEFAULT_DEMAND[model.config.template === 'custom' ? 'medium' : model.config.template];
  }

  private generate(h: AiContext['history'], days: number): DemandHistory {
    const factors: Partial<HistoryFactors> = { regimeShift: h.regime };
    return generateDemandHistory(this.demo.ctx.model, { seed: h.seed, days, startDate: h.from, scenario: this.scenario(), factors });
  }

  /** 某一天事先可以知道的特征（同一个种子的合成计划可以延伸到训练日之后） */
  private planX(h: AiContext['history'], day: number): Record<string, number> {
    const key = `${h.from}:${h.seed}:${h.regime?.day ?? ''}`;
    if (!this.plan || this.plan.key !== key || this.plan.days.length <= day + 1) {
      this.plan = { key, days: this.generate(h, Math.max(day + 8, h.days + 8)).days };
    }
    return this.plan.days[day]?.x ?? {};
  }

  /** 生成合成历史、并入真实营业日，回测并登记候选，最好的候选过上线门槛 */
  async train(opts: { now?: number; kinds?: string[]; seed?: number } = {}): Promise<TrainResult> {
    const now = opts.now ?? Date.now();
    const days = this.opts.historyDays ?? 730;
    const seed = opts.seed ?? this.opts.seed ?? 107;
    const kinds = (opts.kinds ?? Object.keys(FORECASTERS)).filter((k) => FORECASTERS[k]);
    if (!kinds.length) throw new Error('no known model kinds');
    const t = new Date(now);
    const from = localDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() - days).getTime());
    const today = localDate(now);
    const history: AiContext['history'] = { from, days, seed, regime: { day: Math.floor(days * 0.8), multiplier: 0.9 } };
    const hist = this.generate(history, days);
    this.plan = undefined;

    // 真实营业日替换同一天的合成数据
    const recent = hist.days.slice(-28);
    const usualPerDay = recent.reduce((a, d) => a + d.actual.orders, 0) / Math.max(1, recent.length);
    const live = liveDailyHours(Object.values(this.runtime.state.orders), { from, today, hours: hist.hours, minPerDay: usualPerDay * 0.5 });
    const liveByDay = new Map(live.map((d) => [d.day, d]));
    const simWeight = Math.round((LIVE_HALF / (LIVE_HALF + live.length)) * 1000) / 1000;
    const rows: DailyHours[] = hist.days.map((d) => {
      const l = liveByDay.get(d.day);
      return l ? { day: d.day, dow: d.dow, hourly: l.hourly, x: d.x, w: 1 } : { day: d.day, dow: d.dow, hourly: d.actual.hourly, x: d.x, w: simWeight };
    });
    const series = hourlySeries(rows, hist.hours);
    const bt = { initialDays: Math.max(56, days - BACKTEST_DAYS), horizonDays: 7, stepDays: 7 };

    const champ = this.registry.champion(ORDERS_MODEL);
    const champF = champ ? FORECASTERS[champ.kind] : undefined;
    const championMetrics = champF ? withDerived(backtest(series, champF, bt).metrics) : undefined;
    const data: ModelVersion['data'] = {
      source: live.length ? 'MIXED' : 'SIM',
      days,
      from,
      to: localDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1).getTime()),
      seed,
      liveDays: live.length,
      simWeight,
    };
    const candidates: ModelVersion[] = kinds.map((kind) => {
      const f = FORECASTERS[kind] as (typeof FORECASTERS)[string];
      const res = backtest(series, f, bt);
      return this.registry.register({ id: ORDERS_MODEL, kind, trainedAt: now, data, metrics: withDerived(res.metrics), params: f.fit(series) });
    });
    const best = [...candidates].sort((a, b) => (a.metrics.wape ?? Infinity) - (b.metrics.wape ?? Infinity) || a.version - b.version)[0] as ModelVersion;
    for (const c of candidates) if (c !== best) this.registry.reject(ORDERS_MODEL, c.version, 'NOT_BEST');
    const gate = this.registry.promote(ORDERS_MODEL, best.version, FORECAST_GATE, now, championMetrics ? { championMetrics } : {});
    if (gate.passed || !this.context) this.context = { history, hours: hist.hours, usual: usualTable(series), ...zoneMix(hist, this.demo) };
    const eta = this.trainEta(hist, now, seed);
    const availability = this.trainAvailability(now, seed);
    const count = this.trainCountRisk(now, seed);
    const substitution = this.trainSubstitution(now, seed);
    const mto = this.trainMto(now, seed);
    const returns = this.trainReturns(now, seed);
    const pickTime = this.trainPickTime(now, seed);
    const noShow = this.trainNoShow(now, seed);
    this.rates = undefined;
    await this.save();
    return {
      candidates: candidates.map((c) => ({ version: c.version, kind: c.kind, metrics: c.metrics })),
      best: best.version,
      gate,
      promoted: gate.passed,
      liveDays: live.length,
      eta,
      availability,
      count,
      substitution,
      mto,
      returns,
      pickTime,
      noShow,
      ...(championMetrics ? { championMetrics } : {}),
    };
  }

  /** 未取订单（决策记录 0023 · B5）：合成的自取订单记录（顾客有模型看不到的爽约倾向），按时间切分比较规则和逻辑回归 */
  private trainNoShow(now: number, seed: number): FamilyResult {
    const rows = generateNoShowRecords({ seed });
    const ev = evaluateNoShow(rows);
    const champ = this.registry.champion(NOSHOW_MODEL);
    const data: ModelVersion['data'] = { source: 'SIM', days: 240, seed };
    const cands = NOSHOW_VARIANTS.map((kind) => this.registry.register({ id: NOSHOW_MODEL, kind, trainedAt: now, data, metrics: withDerived(ev.metrics[kind]), params: fitNoShow(rows, kind) }));
    return this.promoteBest(NOSHOW_MODEL, cands, 'brier', NOSHOW_GATE, now, champ ? withDerived(ev.metrics[champ.kind as (typeof NOSHOW_VARIANTS)[number]] ?? {}) : undefined);
  }

  /**
   * 这张自取单最后不来的概率：这位顾客以前取过几次、爽约过几次（按姓名，取消原因记为 NO_SHOW 的算爽约）、
   * 下单提前量、时段、星期、天气预报；取货时段前 30 分钟以后才看有没有报预计到达（之前当作会报）。
   */
  noShowRisk(o: LiveOrder, now = Date.now()): { p: number; reasons: Reason[] } | undefined {
    const champ = this.registry.champion(NOSHOW_MODEL);
    if (!champ || o.type !== 'PICKUP') return undefined;
    const key = customerKey(o);
    let pastOrders = 0;
    let pastNoShows = 0;
    for (const x of Object.values(this.runtime.state.orders)) {
      if (x.id === o.id || x.type !== 'PICKUP' || x.createdAt >= o.createdAt || customerKey(x) !== key) continue;
      if (x.status === 'COMPLETED') pastOrders++;
      else if (x.status === 'CANCELLED' && x.cancelReason === 'NO_SHOW') {
        pastOrders++;
        pastNoShows++;
      }
    }
    const ctx = this.context;
    const x = ctx ? this.planX(ctx.history, daysBetween(ctx.history.from, localDate(o.slotStart))) : {};
    const etaShared = now < o.slotStart - 30 * 60_000 ? true : o.etaReportedAt !== undefined || o.arrivedAt !== undefined;
    const d = new Date(o.slotStart);
    return predictNoShow(champ.params as NoShowParams, { aheadH: Math.max(0, (o.slotStart - o.createdAt) / 3_600_000), slotHour: d.getHours(), dow: d.getDay(), rain: (x.forecastRainMm ?? 0) >= 5, etaShared, pastOrders, pastNoShows });
  }

  /**
   * 拣货时长（决策记录 0021 · B1）：按本店的货位生成合成拣货记录（每个货位有模型看不到的难度、高峰更挤、新人更慢、偶尔被打断），
   * 比较标准工时、标准工时 × 实测比例与本模型，最好的过门槛。
   */
  private trainPickTime(now: number, seed: number): FamilyResult {
    const { walks } = generatePickRecords([...this.pickLocations().values()], { seed, days: 60, depot: this.depot() });
    const samples: PickWalkSample[] = walks.map((w, i) => ({ t: i, hour: w.hour, tenure: w.tenure, lines: w.lines, standardSec: w.standardSec, actualSec: w.actualSec, overheadSec: w.overheadSec }));
    const ev = evaluatePickTime(samples, { traffic: STORE_TRAFFIC });
    const champ = this.registry.champion(PICKTIME_MODEL);
    const data: ModelVersion['data'] = { source: 'SIM', days: 60, seed };
    const cands = PICK_VARIANTS.map((kind) => this.registry.register({ id: PICKTIME_MODEL, kind, trainedAt: now, data, metrics: withDerived(ev.metrics[kind]), params: fitPickTime(samples, kind, { traffic: STORE_TRAFFIC }) }));
    return this.promoteBest(PICKTIME_MODEL, cands, 'wape', PICKTIME_GATE, now, champ ? withDerived(ev.metrics[champ.kind as (typeof PICK_VARIANTS)[number]] ?? {}) : undefined);
  }

  private pickLocs?: Map<string, PickLocationInfo>;
  /** 本店每个陈列货位的拣货信息（类型、层高、坐标、通道） */
  pickLocations(): Map<string, PickLocationInfo> {
    if (!this.pickLocs) this.pickLocs = new Map(pickLocationsFromModel(this.demo.ctx.model, this.demo.catalog.values()).map((l) => [l.locationId, l]));
    return this.pickLocs;
  }

  private depot(): { x: number; y: number } {
    const p = this.demo.ctx.model.config.layout.points.cartDepot;
    return { x: p.x, y: p.y };
  }

  /** 熟练度组：入职不到 3 个月是新人，3–18 个月中等，更久是熟手；虚拟员工和没有记录的按中等 */
  tenureOf(associateId: string | undefined, now: number): PickTenure {
    const a = associateId ? this.runtime.statics.roster.find((x) => x.id === associateId) : undefined;
    if (!a?.hiredAt) return 'MID';
    const months = (now - Date.parse(a.hiredAt)) / (30.4 * 86_400_000);
    return months < 3 ? 'NEW' : months < 18 ? 'MID' : 'SENIOR';
  }

  /** 商品的类别和单件体积（升）：分框学习用（决策记录 0023 · B7） */
  itemInfo(itemId: string): { categoryId: string; volumeL: number } | undefined {
    const it = this.demo.catalog.get(itemId);
    return it ? { categoryId: it.categoryId, volumeL: volumeLiters(it.dims) } : undefined;
  }

  /** 批次 → 模型的输入：按路线顺序的每一站（类型、层高、与上一站的距离、件数） */
  walkSample(w: LiveWalk, tenure: PickTenure, now: number): PickWalkSample {
    const locs = this.pickLocations();
    let prev = this.depot();
    const lines = w.stops.map((st) => {
      const l = locs.get(st.locationId);
      const qty = st.picks.reduce((a, p) => a + p.qty, 0);
      const distM = l ? Math.round(aisleDistance(prev, l) * 10) / 10 : 8;
      if (l) prev = l;
      return { locationId: st.locationId, kind: l?.kind ?? 'SHELF', level: l?.level ?? 2, distM, qty };
    });
    return { t: now, hour: new Date(now).getHours(), tenure, lines, standardSec: w.estimatedSec };
  }

  /** 批次的 AI 预计用时；当前版本还是标准工时时也给出（区间按标准工时的历史误差） */
  estimateWalk(w: LiveWalk, now = Date.now(), associateId?: string): Omit<WalkEstimate, 'at'> | undefined {
    const champ = this.registry.champion(PICKTIME_MODEL);
    if (!champ) return undefined;
    const tenure = this.tenureOf(associateId ?? w.associateId, now);
    const pred = predictPickWalk(champ.params as PickTimeParams, this.walkSample(w, tenure, now));
    return { sec: pred.sec, low: pred.low, high: pred.high, model: `${champ.id} v${champ.version}`, tenure, reasons: pred.reasons };
  }

  /** 某一天每小时的预计订单数（按取货时段开始的小时；用订单量模型和那一天事先可以知道的特征） */
  ordersByHourOn(date: string): number[] | undefined {
    const champ = this.registry.champion(ORDERS_MODEL);
    const ctx = this.context;
    const f = champ ? FORECASTERS[champ.kind] : undefined;
    if (!champ || !ctx || !f) return undefined;
    const from = champ.data.from ?? ctx.history.from;
    const day = daysBetween(from, date);
    const dow = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay();
    const x = this.planX({ ...ctx.history, from, seed: champ.data.seed ?? ctx.history.seed }, day);
    const out = new Array<number>(24).fill(0);
    for (const p of f.predict(champ.params, ctx.hours.map((hour) => ({ day, dow, hour, x })))) out[p.hour] = p.mean;
    return out;
  }

  /**
   * 一周的排班草稿（决策记录 0022 · D1）：每天每小时的订单预测 → 拣货、暂存、交付的工作量（与排班建议同一套换算）→ 每个半小时要几个人；
   * 后仓、补货、带班负责人、熟食按固定覆盖。员工的岗位、技能、可上班时间、雇佣类型来自名单。
   * 同时给出「每人从早上排满 8 小时」的固定班表作对照。
   */
  scheduleDraft(week: string): { week: string; dates: string[]; draft: ScheduleResult; naive: ScheduleResult; demand: ScheduleDemand[]; rules: { open: { from: number; to: number } } } | undefined {
    const d = this.scheduleDemand(week);
    if (!d) return undefined;
    const { dates, demand, open, close } = d;
    const associates: ScheduleAssociate[] = scheduleAssociates(this.runtime.statics.roster);
    const rules = { open: { from: Math.max(5, open - 3), to: Math.min(24, close + 1) } };
    return { week, dates, draft: generateSchedule({ associates, demand, rules }), naive: naiveSchedule({ associates, demand, rules }), demand, rules };
  }

  /** 一周每天每个岗位每半小时要几个人（排班草稿和开店简报的人手缺口共用） */
  scheduleDemand(week: string): { dates: string[]; demand: ScheduleDemand[]; open: number; close: number } | undefined {
    const ctx = this.context;
    if (!ctx) return undefined;
    const open = ctx.hours[0] ?? 8;
    const close = (ctx.hours.at(-1) ?? 20) + 1;
    // 每行、每单的拣货用时取自拣货时长模型（本店货位的合成批次上的平均预测，含走动）：排班和推演用同一套用时
    const rates = this.pickRates();
    const params = { linesPerOrder: ctx.linesPerOrder, pickSecPerLine: rates.secPerLine, pickSecPerOrder: rates.secPerOrder, pickLeadHours: 2, stageSecPerOrder: 30, handoffSecPerOrder: 240, pickupShare: 0.45 };
    const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
    const dates = Array.from({ length: 7 }, (_, d) => dateInWeek(week, d));
    const demand: ScheduleDemand[] = [];
    const st = this.runtime.statics;
    const has = (r: string) => st.roster.some((a) => a.role === r || a.skills?.includes(r));
    dates.forEach((date, day) => {
      const orders = this.ordersByHourOn(date) ?? new Array<number>(24).fill(0);
      const w = workloadByHour(orders, params);
      demand.push(
        { day, role: 'PICK', slots: headsFromWorkload(w.pick, { minHeads: 1, hours: range(open - 2, close - 1) }) },
        { day, role: 'STAGE', slots: headsFromWorkload(w.stage, { minHeads: 0, hours: range(open, close) }) },
        { day, role: 'HANDOFF', slots: headsFromWorkload(w.handoff, { minHeads: 1, hours: range(open, close) }) },
      );
      if (has('BACKROOM')) demand.push({ day, role: 'BACKROOM', slots: fixedHeads(Math.max(5, open - 3), Math.min(close, open + 7), 1) });
      if (has('RESTOCK')) demand.push({ day, role: 'RESTOCK', slots: fixedHeads(open - 1, close - 2, 1) });
      if (has('LEAD')) demand.push({ day, role: 'LEAD', slots: fixedHeads(open - 1, close, 1) });
      if (has('DELI') && st.modules?.mto) demand.push({ day, role: 'DELI', slots: fixedHeads(open + 2, close - 1, 1) });
    });
    return { dates, demand, open, close };
  }

  /** 某一天的订单量预测（营业时间合计、80% 区间、主要原因、每小时）：开店简报用 */
  dayForecast(date: string): { orders: number; low: number; high: number; usual: number; reasons: Reason[]; byHour: number[] } | undefined {
    const champ = this.registry.champion(ORDERS_MODEL);
    const ctx = this.context;
    const f = champ ? FORECASTERS[champ.kind] : undefined;
    if (!champ || !ctx || !f || !ctx.hours.length) return undefined;
    const from = champ.data.from ?? ctx.history.from;
    const day = daysBetween(from, date);
    const dow = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay();
    const x = this.planX({ ...ctx.history, from, seed: champ.data.seed ?? ctx.history.seed }, day);
    const points = f.predict(champ.params, ctx.hours.map((hour) => ({ day, dow, hour, x })));
    const agg = aggregateForecast(points);
    const byHour = new Array<number>(24).fill(0);
    for (const p of points) byHour[p.hour] = p.mean;
    const usual = ctx.hours.reduce((a, h) => a + (ctx.usual[`${dow}-${h}`] ?? 0), 0);
    // 「这段时间占全天订单的比例」对整天没有意义
    return { orders: Math.round(agg.mean), low: Math.round(agg.low), high: Math.round(agg.high), usual: Math.round(usual), reasons: agg.reasons.filter((r) => r.factor !== 'HOUR_SHARE'), byHour };
  }

  private rates?: { secPerLine: number; secPerOrder: number };
  /** 拣货时长模型给出的平均每行用时（含走动）和每单开销（批次开销按每批 3 单摊）；没有模型时用排班建议的标准值 */
  pickRates(): { secPerLine: number; secPerOrder: number } {
    const p = this.pickParams();
    if (!p || p.variant !== 'pick-model') return { secPerLine: 55, secPerOrder: 60 };
    if (this.rates) return this.rates;
    const { walks } = generatePickRecords([...this.pickLocations().values()], { seed: 5, days: 2, depot: this.depot() });
    let lines = 0;
    let sec = 0;
    for (const w of walks) {
      const pr = predictPickWalk(p, { hour: w.hour, tenure: 'MID', lines: w.lines, standardSec: w.standardSec });
      lines += w.lines.length;
      sec += pr.lines.reduce((a, b) => a + b, 0);
    }
    this.rates = { secPerLine: Math.round(sec / Math.max(1, lines)), secPerOrder: Math.round(p.overheadSec / 3) };
    return this.rates;
  }

  /** 拣货时长模型的参数（剩余用时、展望里的每单用时要用） */
  pickParams(): PickTimeParams | undefined {
    return this.registry.champion(PICKTIME_MODEL)?.params as PickTimeParams | undefined;
  }

  /**
   * 订单量展望（决策记录 0021 · A1）：今天剩下的营业小时，每小时（按取货时段开始）的预计订单数和 80% 区间，
   * 乘以今天的修正系数 r =（最近观察到的下单数 + k）÷（同期预测 + k）：早上数据少时 r 接近 1，越往后越相信今天的实际。
   * 观察窗口从今天第一张订单开始、最多往回 3 小时（门店服务刚启动时，之前没有数据的小时不算「今天没人下单」）。
   */
  outlookDraft(now = Date.now(), opts: { minObsMin?: number } = {}): Omit<DemandOutlook, 'at'> | undefined {
    const champ = this.registry.champion(ORDERS_MODEL);
    const ctx = this.context;
    const f = champ ? FORECASTERS[champ.kind] : undefined;
    if (!champ || !ctx || !f || !ctx.hours.length) return undefined;
    const t = new Date(now);
    const dayStart = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    const date = localDate(now);
    const from = champ.data.from ?? ctx.history.from;
    const day = daysBetween(from, date);
    const x = this.planX({ ...ctx.history, from, seed: champ.data.seed ?? ctx.history.seed }, day);
    const preds = f.predict(champ.params, ctx.hours.map((hour) => ({ day, dow: t.getDay(), hour, x })));
    const byHour = new Map(preds.map((p) => [p.hour, p]));
    // 修正系数：最近观察窗口里的实际下单数 vs 同期的预测（按小时的预测摊到分钟）
    const orders = Object.values(this.runtime.state.orders).filter((o) => o.status !== 'CANCELLED' && o.createdAt >= dayStart && o.createdAt <= now);
    const first = orders.reduce((m, o) => Math.min(m, o.createdAt), now);
    const winFrom = Math.max(first, now - 3 * HOUR_MS);
    let expected = 0;
    for (let ms = winFrom; ms < now; ms += 60_000) expected += (byHour.get(new Date(ms).getHours())?.mean ?? 0) / 60;
    const observed = orders.filter((o) => o.createdAt >= winFrom).length;
    const k = 8;
    const correction = now - winFrom >= (opts.minObsMin ?? 20) * 60_000 ? Math.min(3, Math.max(0.3, (observed + k) / (expected + k))) : 1;
    const hours = ctx.hours
      .filter((h) => h >= t.getHours())
      .slice(0, 8)
      .map((h) => {
        const p = byHour.get(h);
        const r2 = (v: number) => Math.round(v * correction * 10) / 10;
        return { t: dayStart + h * HOUR_MS, mean: r2(p?.mean ?? 0), low: r2(p?.low ?? 0), high: r2(p?.high ?? 0) };
      });
    // 每单的拣货用时：最近有 AI 预计的批次，按批次里的订单数摊；每单件数：最近的订单
    const recentWalks = Object.values(this.runtime.state.walks).filter((w) => w.ai && w.createdAt >= now - 3 * HOUR_MS);
    let sec = 0;
    let n = 0;
    for (const w of recentWalks) {
      const ids = new Set(w.toteIds.map((id) => this.runtime.state.totes[id]?.orderId));
      sec += w.ai?.sec ?? 0;
      n += ids.size;
    }
    const recentOrders = orders.filter((o) => o.createdAt >= now - 3 * HOUR_MS);
    const unitsPerOrder = recentOrders.length >= 5 ? recentOrders.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.qty, 0), 0) / recentOrders.length : ctx.linesPerOrder * 1.25;
    return {
      model: `${champ.id} v${champ.version}`,
      correction: Math.round(correction * 100) / 100,
      observed,
      expected: Math.round(expected * 10) / 10,
      hours,
      ...(n >= 3 ? { perOrderSec: Math.round(sec / n) } : {}),
      unitsPerOrder: Math.round(unitsPerOrder * 10) / 10,
    };
  }

  /** 到店时间修正：用同一份合成历史生成最近半年的到店记录，三个版本按时间先后评估，最好的过门槛 */
  private trainEta(hist: DemandHistory, now: number, seed: number): TrainResult['eta'] {
    const recent: DemandHistory = { ...hist, days: hist.days.slice(-180) };
    const samples: EtaSample[] = generateArrivals({ seed, history: recent }).map((a) => ({ t: a.t, customer: a.customer, reportedMin: a.reportedMin, actualMin: a.actualMin, hour: a.hour, dow: a.dow, x: a.x }));
    const champ = this.registry.champion(ETA_MODEL);
    const championMetrics = champ ? withDerived(evaluateEta(samples, champ.kind as (typeof ETA_VARIANTS)[number]).metrics) : undefined;
    const data: ModelVersion['data'] = { source: 'SIM', days: recent.days.length, from: recent.days[0]?.date, to: recent.days.at(-1)?.date, seed };
    const cands = ETA_VARIANTS.map((kind) => {
      const ev = evaluateEta(samples, kind);
      // 上线用全部记录重新拟合；合成顾客的记录对真实顾客没有意义，不保存
      const params: EtaParams = { ...fitEta(samples, kind), customers: {} };
      return this.registry.register({ id: ETA_MODEL, kind, trainedAt: now, data, metrics: withDerived(ev.metrics), params });
    });
    const best = [...cands].sort((a, b) => (a.metrics.mae ?? Infinity) - (b.metrics.mae ?? Infinity) || a.version - b.version)[0] as ModelVersion;
    for (const c of cands) if (c !== best) this.registry.reject(ETA_MODEL, c.version, 'NOT_BEST');
    const gate = this.registry.promote(ETA_MODEL, best.version, ETA_GATE, now, championMetrics ? { championMetrics } : {});
    return { best: best.version, kind: best.kind, promoted: gate.passed, metrics: best.metrics };
  }

  /** 同一批候选里选最好的，过门槛；championMetrics 是当前版本在同一份数据上的指标 */
  private promoteBest(family: string, cands: ModelVersion[], primary: string, gate: typeof ETA_GATE, now: number, championMetrics?: Record<string, number>): FamilyResult {
    const sign = gate.primary.lowerIsBetter ? 1 : -1;
    const best = [...cands].sort((a, b) => sign * ((a.metrics[primary] ?? sign * Infinity) - (b.metrics[primary] ?? sign * Infinity)) || a.version - b.version)[0] as ModelVersion;
    for (const c of cands) if (c !== best) this.registry.reject(family, c.version, 'NOT_BEST');
    const g = this.registry.promote(family, best.version, gate, now, championMetrics ? { championMetrics } : {});
    return { best: best.version, kind: best.kind, promoted: g.passed, metrics: best.metrics };
  }

  /** 可售概率：合成货架真实存量（含幽灵库存与零星损耗），按天切分评估朴素贝叶斯与逻辑回归 */
  private trainAvailability(now: number, seed: number): FamilyResult {
    const rows = generateShelfTruth({ seed, items: 150, days: 50 });
    const ev = evaluateAvailability(rows);
    const byKind: Record<string, Record<string, number>> = { 'availability-bayes': ev.metrics.bayes ?? {}, 'availability-logistic': ev.metrics.logistic ?? {} };
    const champ = this.registry.champion(AVAILABILITY_MODEL);
    const data: ModelVersion['data'] = { source: 'SIM', days: 50, seed };
    const full = fitAvailability(rows);
    const cands = Object.keys(byKind).map((kind) =>
      this.registry.register({ id: AVAILABILITY_MODEL, kind, trainedAt: now, data, metrics: byKind[kind] as Record<string, number>, params: kind === 'availability-logistic' ? full : { prior: full.prior } }),
    );
    return this.promoteBest(AVAILABILITY_MODEL, cands, 'brier', AVAILABILITY_GATE, now, champ ? byKind[champ.kind] : undefined);
  }

  /** 按风险盘点：同一套随机数下比较「ABC 周期 + 事件触发」与「按模型风险排序」，模型用前 100 天的盘点结果训练 */
  private trainCountRisk(now: number, seed: number): FamilyResult {
    const uniform = (stream: string, key: string) => keyedUniform(seed, stream, key);
    const items = makeCountItems(300, uniform);
    const days = 200;
    const half = 100;
    const budget = 9;
    const warm = simulateCounting({ items, days: half, budget, uniform, policyFor: () => abcPolicy });
    const params: CountRiskParams = fitCountRisk(warm.samples);
    const base = simulateCounting({ items, days, budget, uniform, policyFor: () => abcPolicy, measureFrom: half });
    const risk = simulateCounting({ items, days, budget, uniform, policyFor: (d) => (d < half ? abcPolicy : riskPolicy(params)), measureFrom: half });
    const pick = (r: typeof base) => ({ avgInaccurate: r.avgInaccurate, meanDetectDays: r.meanDetectDays, hitRate: r.hitRate, counts: r.counts });
    const byKind: Record<string, Record<string, number>> = { 'count-abc': pick(base), 'count-risk': pick(risk) };
    const champ = this.registry.champion(COUNT_MODEL);
    const data: ModelVersion['data'] = { source: 'SIM', days, seed };
    const cands = Object.keys(byKind).map((kind) =>
      this.registry.register({ id: COUNT_MODEL, kind, trainedAt: now, data, metrics: byKind[kind] as Record<string, number>, params: kind === 'count-risk' ? params : null }),
    );
    return this.promoteBest(COUNT_MODEL, cands, 'avgInaccurate', COUNT_GATE, now, champ ? byKind[champ.kind] : undefined);
  }

  /** 替代推荐：合成替代记录（顾客偏好看不到），比较现有规则、属性相似度和学习排序 */
  private trainSubstitution(now: number, seed: number): FamilyResult {
    const items = [...this.demo.catalog.values()];
    const logs = generateSubstitutionEvents(items, { seed, events: 3000 });
    const ev = evaluateSubstitution(logs, this.demo.catalog);
    // 个性化值不值得做（决策记录 0023 · B4）：固定顾客的合成记录上，按顾客自己的反应调整后第一名的期望接受率变化
    const pz = evaluatePersonalization(generateSubstitutionEvents(items, { seed: seed + 1, events: 6000, customers: 300 }), this.demo.catalog);
    const learned = { ...(ev.metrics.learned ?? {}), personalLift: pz.lift, personalLiftLow: pz.liftLow, personalOracle: pz.oracle };
    const byKind: Record<string, Record<string, number>> = { 'sub-rule': ev.metrics.rule ?? {}, 'sub-similarity': ev.metrics.similarity ?? {}, 'sub-learned': learned };
    const champ = this.registry.champion(SUBSTITUTION_MODEL);
    const data: ModelVersion['data'] = { source: 'SIM', days: 0, seed };
    const cands = Object.keys(byKind).map((kind) =>
      this.registry.register({ id: SUBSTITUTION_MODEL, kind, trainedAt: now, data, metrics: byKind[kind] as Record<string, number>, params: kind === 'sub-learned' ? ev.params : null }),
    );
    return this.promoteBest(SUBSTITUTION_MODEL, cands, 'acceptTop1', SUBSTITUTION_GATE, now, champ ? byKind[champ.kind] : undefined);
  }

  /** 出餐时间：合成熟食制作记录（每道菜的本店系数看不到），比较「按标准时长」与「收缩估计 + 负荷效应」 */
  private trainMto(now: number, seed: number): FamilyResult {
    const menu = this.runtime.statics.mtoMenu ?? [];
    const samples = generateDeliHistory({ seed, menu: menu.length ? menu : undefined }).map((r) => ({ dishId: r.dishId, standardMin: r.standardMin, load: r.load, actualMin: r.actualMin }));
    const ev = evaluatePrepTime(samples);
    const champ = this.registry.champion(MTO_MODEL);
    const byKind: Record<string, Record<string, number>> = { 'prep-standard': { mae: ev.metrics.maeStandard as number, n: ev.metrics.n as number }, 'prep-model': { mae: ev.metrics.maeModel as number, n: ev.metrics.n as number } };
    const data: ModelVersion['data'] = { source: 'SIM', days: 60, seed };
    const params: PrepParams = fitPrepTime(samples);
    const cands = Object.keys(byKind).map((kind) => this.registry.register({ id: MTO_MODEL, kind, trainedAt: now, data, metrics: byKind[kind] as Record<string, number>, params: kind === 'prep-model' ? params : null }));
    return this.promoteBest(MTO_MODEL, cands, 'mae', ETA_GATE, now, champ ? byKind[champ.kind] : undefined);
  }

  /** 退货去向：合成退货记录，比较现有规则与逻辑回归的回架判断 */
  private trainReturns(now: number, seed: number): FamilyResult {
    const rows = generateReturns([...this.demo.catalog.values()], { seed }).map((r) => ({ ...r, perishable: isPerishableCategory(r.categoryId) }));
    const ev = evaluateReturns(rows);
    const byKind: Record<string, Record<string, number>> = { 'returns-rule': ev.metrics.rule ?? {}, 'returns-model': ev.metrics.model ?? {} };
    const champ = this.registry.champion(RETURNS_MODEL);
    const data: ModelVersion['data'] = { source: 'SIM', days: 0, seed };
    const cands = Object.keys(byKind).map((kind) => this.registry.register({ id: RETURNS_MODEL, kind, trainedAt: now, data, metrics: byKind[kind] as Record<string, number>, params: kind === 'returns-model' ? ev.params : null }));
    return this.promoteBest(RETURNS_MODEL, cands, 'accuracy', { primary: { metric: 'accuracy', lowerIsBetter: false }, minImprovement: 0.002, guardrails: [{ metric: 'falseRestock', lowerIsBetter: true, maxRegression: 0.5 }] }, now, champ ? byKind[champ.kind] : undefined);
  }

  /**
   * 熟食现做单创建后：按菜品在本店的系数和厨房负荷预测制作时长，调整建议开始时间
   * （建议记录，默认自动执行：只改变熟食看板上的提醒时间）。
   */
  async issueMtoStart(ticketId: string, now = Date.now()): Promise<SubmitResult | undefined> {
    const champ = this.registry.champion(MTO_MODEL);
    const s = this.runtime.state;
    const t = s.mto[ticketId];
    const menu = this.runtime.statics.mtoMenu?.find((m) => m.id === t?.menuId);
    if (!champ || champ.kind !== 'prep-model' || !t || !menu || t.status !== 'QUEUED') return undefined;
    // 负荷：标准开始时间前后 15 分钟内要开始或正在做的其他单
    const load = Object.values(s.mto).filter((x) => x.id !== t.id && (x.status === 'COOKING' || (x.status === 'QUEUED' && Math.abs(x.startAt - t.standardStartAt) <= 15 * 60_000))).length;
    const pred = predictPrepTime(champ.params as PrepParams, menu.id, menu.prepMin, load);
    const order = s.orders[t.orderId];
    if (!order) return undefined;
    const startAt = Math.round(order.slotStart - (pred.minutes + 10) * 60_000);
    if (Math.abs(startAt - t.startAt) < 60_000) return undefined;
    const draft: RecommendationDraft = {
      module: 'MTO',
      target: t.id,
      action: { kind: 'SET_MTO_START', params: { ticketId: t.id, startAt } },
      prediction: { value: pred.minutes, baseline: menu.prepMin, unit: 'MINUTES' },
      confidence: Math.round((1 / (1 + ((champ.params as PrepParams).residualSd ?? 3) / Math.max(1, pred.minutes))) * 1000) / 1000,
      reasons: pred.reasons,
      alternatives: [],
      model: { id: champ.id, version: champ.version, kind: champ.kind },
      expiresAt: Math.max(now + 60_000, order.slotStart),
    };
    return this.runtime.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now });
  }

  /** 退货去向建议：能再售的概率 + 规则（化学品、高价损坏）；当前版本是规则时只给规则结果 */
  returnSuggestion(returnId: string, index: number): { disposition: string; p?: number; reasons: Reason[]; model?: string; allowed: string[] } | undefined {
    const r = this.runtime.state.returns[returnId];
    const line = r?.lines[index];
    if (!r || !line) return undefined;
    const sug = this.rawReturnSuggestion(r.orderId, line);
    // 硬性规则（决策 RT-02）：建议必须是允许的去向；被规则改掉时在理由最前面说明
    const allowed = allowedDispositions(line);
    const blocked = returnBlocks(line)[sug.disposition as ReturnDisposition];
    if (!blocked) return { ...sug, allowed };
    const fallback = (line.chemical ? 'HAZMAT' : allowed.includes('DISPOSE') ? 'DISPOSE' : allowed[0]) ?? 'HAZMAT';
    return { ...sug, disposition: fallback, reasons: [{ factor: 'RULE', weight: 1, params: { reason: blocked, original: sug.disposition } }, ...sug.reasons], allowed };
  }

  private rawReturnSuggestion(orderId: string | undefined, line: ReturnLine): { disposition: string; p?: number; reasons: Reason[]; model?: string } {
    const item = this.demo.catalog.get(line.itemId);
    const order = orderId ? this.runtime.state.orders[orderId] : undefined;
    const hours = order?.completedAt !== undefined ? Math.max(0, (Date.now() - order.completedAt) / HOUR_MS) : 24;
    const input = { condition: line.condition, tempZone: line.tempZone, perishable: item ? isPerishableCategory(item.categoryId) : false, chemical: !!item?.handling.includes('CHEMICAL'), hoursSinceHandoff: Math.round(hours * 10) / 10, unitPrice: line.unitPrice };
    const champ = this.registry.champion(RETURNS_MODEL);
    if (champ?.kind === 'returns-model' && champ.params) {
      const sug = suggestDisposition(champ.params as ReturnParams, input);
      // 没有原订单时不知道交付了多久，按 24 小时估计，并在理由里标出
      const reasons = order ? sug.reasons : sug.reasons.map((x) => (x.factor === 'COLD_HOURS' || x.factor === 'PERISHABLE_HOURS' ? { ...x, params: { ...x.params, assumed: 1 } } : x));
      return { disposition: sug.disposition, p: sug.p, reasons, model: `${champ.id} v${champ.version}` };
    }
    return { disposition: input.chemical && input.condition !== 'SEALED' ? 'HAZMAT' : input.condition === 'SEALED' && !input.perishable && input.tempZone === 'AMBIENT' ? 'RESTOCK' : 'DISPOSE', reasons: [] };
  }

  /**
   * 替代候选：硬约束（同类别、同温区、年龄限制一致、价格在门店规则的范围内），
   * 当前版本是学习排序时按预计接受概率排序并给出理由，否则按现有规则排序。
   */
  substitutes(itemId: string, limit = 5): { items: SubstituteSuggestion[]; model?: string } {
    const o = this.demo.catalog.get(itemId);
    if (!o) return { items: [] };
    const band = this.demo.ctx.model.config.rules.substitution.priceBand;
    const cands = substituteCandidates([...this.demo.catalog.values()], o).filter((x) => Math.abs(x.unitPrice - o.unitPrice) <= o.unitPrice * band);
    const champ = this.registry.champion(SUBSTITUTION_MODEL);
    // 替代品写上货位（决策记录 0026）：拣货员不用再去找
    const base = (x: (typeof cands)[number]) => ({ itemId: x.id, name: x.name, gtin: x.gtin, unitPrice: x.unitPrice, ...(x.locationIds[0] ? { locationId: x.locationIds[0] } : {}) });
    if (champ?.kind === 'sub-learned' && champ.params) {
      const ranked = rankSubstitutes(champ.params as SubstitutionParams, o, cands, limit);
      return { items: ranked.map((r) => ({ ...base(cands.find((c) => c.id === r.item.id) as (typeof cands)[number]), p: r.p, reasons: r.reasons })), model: `${champ.id} v${champ.version}` };
    }
    return { items: [...cands].sort((a, b) => ruleScore(o, b) - ruleScore(o, a) || a.id.localeCompare(b.id)).slice(0, limit).map(base) };
  }

  /**
   * 幽灵库存检查：系统估算 ≥ 1 件、但按销量本应卖出却一直没有卖出的商品。
   * 只在收银流水正常时检查，沉默只从这段流水开始算。每次最多发出 limit 条「核对货架」建议。
   */
  async scanShelves(now = Date.now(), limit = 5): Promise<number> {
    const champ = this.registry.champion(AVAILABILITY_MODEL);
    if (!champ || this.lastSaleEvent === undefined || now - this.lastSaleEvent > POS_GAP_MS) return 0;
    const s = this.runtime.state;
    const openRecItems = new Set(Object.values(s.recs).filter((r) => r.status === 'OPEN' && r.module === 'AVAILABILITY').map((r) => r.target));
    const checking = new Set(Object.values(s.checks).filter((c) => c.status === 'OPEN').map((c) => c.itemId));
    const found: Array<{ draft: RecommendationDraft; p: number }> = [];
    for (const pe of this.runtime.statics.planogram) {
      if (openRecItems.has(pe.itemId) || checking.has(pe.itemId) || openTaskAt(s, pe.itemId)) continue;
      const r = this.shelfAvailability(pe, now);
      if (!r || r.p >= ALERT_BELOW) continue;
      found.push({
        p: r.p,
        draft: {
          module: 'AVAILABILITY',
          target: pe.itemId,
          action: { kind: 'CHECK_SHELF', params: { itemId: pe.itemId, locationId: pe.locationId } },
          prediction: { value: r.p, unit: 'PROBABILITY', baseline: 1 },
          confidence: Math.round((1 - r.p) * 1000) / 1000,
          reasons: r.reasons,
          alternatives: r.alternatives,
          model: { id: champ.id, version: champ.version, kind: champ.kind },
          expiresAt: now + 2 * HOUR_MS,
        },
      });
    }
    found.sort((a, b) => a.p - b.p || a.draft.target.localeCompare(b.draft.target));
    let n = 0;
    for (const f of found.slice(0, limit)) {
      const r = await this.runtime.submit({ cmd: { type: 'IssueRecommendation', draft: f.draft }, actor: 'ai', at: now });
      if (r.ok) n++;
    }
    return n;
  }

  /**
   * 一件商品在货架上找得到的概率（「该卖没卖」的沉默证据，Phase 5b）。收银流水中断时没有沉默证据，返回 undefined；
   * 系统估算已经是 0 的商品不在这里判断（直接按缺货处理）。
   */
  shelfAvailability(pe: PlanogramEntry, now = Date.now()): { p: number; reasons: Reason[]; alternatives: Alternative[] } | undefined {
    const champ = this.registry.champion(AVAILABILITY_MODEL);
    if (!champ || this.lastSaleEvent === undefined || now - this.lastSaleEvent > POS_GAP_MS) return undefined;
    const s = this.runtime.state;
    const totalBase = this.runtime.statics.planogram.reduce((a, p) => a + p.baseVelocity, 0);
    // 还没有货架记录的商品（开门以来没卖过、没补过、没传感器读数）按期初估算（满货架）处理：
    // 以前直接跳过，开门后还没卖出就被放错地方的商品永远发现不了（全流程走查发现）
    const sh = shelfNow(s, pe);
    if (sh.est < 1) return undefined;
    const start = Math.max(sh.lastSaleAt ?? 0, sh.confirmedAt ?? 0, this.posAliveSince ?? now);
    const hoursSinceSale = Math.max(0, (now - start) / HOUR_MS);
    // 本应卖出的件数 = 这件商品卖得正常时占全店销量的比例 × 它上次卖出之后全店卖出的件数。
    // 比例只用它最后一次卖出之前的流水计算（沉默期不稀释比例），并向陈列表的计划比例收缩
    // （相当于先验里已经看过 SHARE_PRIOR 件全店销售），避免几件偶然集中的销售把比例抬高；
    // 与时段高峰、客流快慢都无关。之后员工确认过的商品退回按销售速度 × 时间估计
    const cum = this.itemUnits.get(pe.itemId) ?? 0;
    // 沉默的起点（按全店累计销量计）：上次卖出、员工上次确认、开始接收 POS 流水，取最晚的。
    // 以前只有卖出过的商品才按销量算，开始接收流水后一件都没卖出的商品退回按时间估计；
    // 演示的加速购物仿真里时间几乎不走，这样的商品永远发现不了（全流程走查发现）。
    const confirmedLater = (sh.confirmedAt ?? 0) > (sh.lastSaleAt ?? 0);
    const saleMark = this.lastSaleMark.get(pe.itemId);
    const mark = confirmedLater ? (this.confirmMark.get(pe.itemId) ?? saleMark ?? 0) : (saleMark ?? 0);
    const planShare = totalBase > 0 ? pe.baseVelocity / totalBase : 0;
    // 比例只用沉默开始之前的流水（cum 是开始接收流水以来这件商品的销量；mark 之前的全店销量是 saleMark）
    const share = (cum + SHARE_PRIOR * planShare) / ((saleMark ?? 0) + SHARE_PRIOR);
    const rawExpected = this.storeUnits > 0 ? share * Math.max(0, this.storeUnits - mark) : sh.velocity * hoursSinceSale;
    // 销量估计有误差：按负二项分布折算沉默证据
    const expectedSinceSale = discountSilence(rawExpected);
    // 理由里显示的沉默时长：按时钟和按全店销量折算（全店平均每小时的销量）取较大的。
    // 真实门店两者差不多；演示的加速购物仿真里时钟几乎不走，按销量折算才说得通
    const silentHours = Math.max(hoursSinceSale, totalBase > 0 ? Math.max(0, this.storeUnits - mark) / totalBase : 0);
    const input = { est: sh.est, velocity: sh.velocity, expectedSinceSale, hoursSinceSale: silentHours, hoursSinceConfirm: Math.max(0, (now - (sh.confirmedAt ?? start)) / HOUR_MS) };
    const bayes = bayesAvailability((champ.params as { prior: number }).prior, input);
    const pred = champ.kind === 'availability-logistic' ? predictAvailability(champ.params as AvailabilityParams, input) : { pAvailable: bayes, reasons: [{ factor: 'NO_SALES', value: Math.round(silentHours * 10) / 10, weight: 1, params: { expected: Math.round(input.expectedSinceSale * 10) / 10 } }] };
    // 理由里显示原始的「本应卖出件数」（折算只用于判断）
    for (const r of pred.reasons) {
      if (r.factor === 'NO_SALES') r.params = { expected: Math.round(rawExpected * 10) / 10 };
      if (r.factor === 'SINCE_CONFIRMED' && sh.confirmedAt === undefined) r.params = { never: 1 };
    }
    const alternatives: Alternative[] = champ.kind === 'availability-logistic' ? [{ action: { kind: 'INFO', params: { model: 'availability-bayes', value: Math.round(bayes * 1000) / 1000 } }, score: 0 }] : [];
    return { p: pred.pAvailable, reasons: pred.reasons, alternatives };
  }

  /**
   * 拣货前要用的「找得到的概率」（决策记录 0021 · B2）：沉默证据（收银流水正常时）和货架估算够不够这一单，取较小的。
   * 货架估算的判断是规则：估算 ≤ 0 时 0.05，不够这一单（扣掉其他还没拣的线上订单）时 0.3，够时 0.95。
   */
  findProbability(itemId: string, need: number, otherDemand: number, now = Date.now()): { p: number; silence?: number; est: number; belief?: ShelfBelief } {
    const pe = planogramByItem(this.runtime.statics).get(itemId);
    if (!pe) return { p: 1, est: 0 };
    const sh = shelfNow(this.runtime.state, pe);
    const left = sh.est - otherDemand;
    const pEst = sh.est <= 0 ? 0.05 : left < need ? 0.3 : 0.95;
    const silence = this.shelfAvailability(pe, now)?.p;
    // 拣货员最近的报告（决策记录 0022 · C1）
    const belief = this.shelfBelief(itemId, now, silence);
    const fused = belief ? belief.pOn : (silence ?? 1);
    return { p: Math.round(Math.min(pEst, fused) * 1000) / 1000, est: sh.est, ...(silence !== undefined ? { silence: Math.round(silence * 1000) / 1000 } : {}), ...(belief ? { belief } : {}) };
  }

  /** 多源货架真相：收银沉默（或系统估算）+ 拣货员最近的报告；没有报告时返回 undefined */
  shelfBelief(itemId: string, now = Date.now(), silence?: number): ShelfBelief | undefined {
    const list = this.signals.get(itemId);
    if (!list?.length) return undefined;
    const pe = planogramByItem(this.runtime.statics).get(itemId);
    const est = pe ? shelfNow(this.runtime.state, pe).est : 0;
    // 起点：沉默给出的概率；拣货员报告找不到时系统估算已经清零，所以没有沉默证据时按「本来有货」的先验算，让报告本身说话
    const prior = silence ?? (est >= 1 ? 0.95 : 0.9);
    return fuseShelf({ pPrior: prior, signals: list, now, reliability: this.reliability });
  }

  /** 各种拣货员报告的可靠度（接口和界面用） */
  reliabilityTable(): Array<{ kind: ShelfSignalKind; hit: number; miss: number; r: number }> {
    return SHELF_SIGNALS.map((k) => ({ kind: k, ...this.reliability[k], r: Math.round(reliabilityOf(this.reliability, k) * 1000) / 1000 }));
  }

  /**
   * 可能放错了地方（决策记录 0022 · C1）：最近有拣货员报告找不到、而且多半是放错了地方（不是卖完或损坏）的商品，
   * 发出「附近找一找」建议（同一通道前后几个货架段）。已经安排了补货的商品不重复（补货员到了货位会看到）。
   */
  async scanTruth(now = Date.now(), limit = 3): Promise<number> {
    const s = this.runtime.state;
    const st = this.runtime.statics;
    const plan = planogramByItem(st);
    const found: Array<{ draft: RecommendationDraft; p: number }> = [];
    for (const [itemId, list] of this.signals) {
      const pe = plan.get(itemId);
      if (!pe || !list.some((x) => x.kind !== 'PICKED_OK' && now - x.at <= 2 * HOUR_MS)) continue;
      // 已经有核对任务、没处理的货架建议、或者补货员正要去这个货位（他到了会看到）时不重复
      if (
        Object.values(s.checks).some((c) => c.itemId === itemId && c.status === 'OPEN') ||
        Object.values(s.recs).some((r) => r.status === 'OPEN' && r.module === 'AVAILABILITY' && r.target === itemId) ||
        Object.values(s.repl).some((t) => t.itemId === itemId && (t.status === 'OPEN' || t.status === 'CLAIMED'))
      )
        continue;
      const b = this.shelfBelief(itemId, now);
      if (!b || b.pMisplaced < 0.4) continue;
      // 同一通道里离它最近的几个货架段
      const near = [...new Set(st.planogram.filter((x) => x.runId === pe.runId && x.locationId !== pe.locationId).map((x) => x.locationId))]
        .map((id) => ({ id, d: locationDistance(id, pe.locationId) }))
        .sort((a, b2) => a.d - b2.d || a.id.localeCompare(b2.id))
        .slice(0, 4)
        .map((x) => x.id);
      const reports = list.filter((x) => x.kind !== 'PICKED_OK');
      const last = reports[reports.length - 1] as ShelfSignal;
      found.push({
        p: b.pMisplaced,
        draft: {
          module: 'AVAILABILITY',
          target: itemId,
          action: { kind: 'SEARCH_NEARBY', params: { itemId, locationId: pe.locationId, near: near.join(',') } },
          prediction: { value: b.pMisplaced, unit: 'PROBABILITY' },
          confidence: Math.round(Math.min(0.9, b.pMisplaced + 0.1) * 1000) / 1000,
          reasons: [
            { factor: 'PICKER_REPORTS', value: reports.length, weight: 0.5, params: { kind: last.kind, ago: Math.round((now - last.at) / 60_000) } },
            { factor: 'MISPLACED_LIKELY', value: Math.round(b.pMisplaced * 100), weight: 0.3 },
            { factor: 'REPORT_RELIABILITY', value: Math.round(reliabilityOf(this.reliability, last.kind) * 100), weight: 0.2, params: { kind: last.kind } },
          ],
          alternatives: [],
          model: { id: 'shelf-truth', version: 1, kind: 'bayes-fusion' },
          expiresAt: now + 2 * HOUR_MS,
        },
      });
    }
    found.sort((a, b) => b.p - a.p || a.draft.target.localeCompare(b.draft.target));
    let n = 0;
    for (const f of found.slice(0, limit)) if ((await this.runtime.submit({ cmd: { type: 'IssueRecommendation', draft: f.draft }, actor: 'ai', at: now })).ok) n++;
    return n;
  }

  /** 按风险盘点：每个库位里最可能不准的商品，概率 ≥ 0.5 时发出「盘点」建议（每次最多 limit 条） */
  async scanCounts(now = Date.now(), limit = 3): Promise<number> {
    const champ = this.registry.champion(COUNT_MODEL);
    if (!champ || champ.kind !== 'count-risk') return 0;
    const params = champ.params as CountRiskParams;
    const s = this.runtime.state;
    const plan = new Map(this.runtime.statics.planogram.map((p) => [p.itemId, p]));
    const openRecBins = new Set(Object.values(s.recs).filter((r) => r.status === 'OPEN' && r.module === 'COUNT').map((r) => r.target));
    const openCountBins = new Set(Object.values(s.counts).filter((c) => c.status !== 'DONE').map((c) => c.binCode));
    const found: Array<{ draft: RecommendationDraft; p: number }> = [];
    for (const [bin, ids] of Object.entries(s.bins)) {
      if (openRecBins.has(bin) || openCountBins.has(bin)) continue;
      const since = s.countedAt[bin] ?? 0;
      const items = new Map<string, { cases: number; damaged: number; moves: number }>();
      for (const id of ids) {
        const c = s.cases[id];
        if (!c || c.state !== 'STORED') continue;
        const it = items.get(c.itemId) ?? { cases: 0, damaged: 0, moves: 0 };
        it.cases++;
        if (c.damaged) it.damaged++;
        if (c.receivedAt > since) it.moves++;
        items.set(c.itemId, it);
      }
      let best: { itemId: string; p: number; reasons: RecommendationDraft['reasons'] } | undefined;
      for (const [itemId, it] of items) {
        const moves = it.moves + Object.values(s.repl).filter((t) => t.itemId === itemId && t.status === 'DONE' && (t.doneAt ?? 0) > since).length + Object.values(s.exceptions).filter((x) => x.itemId === itemId && (x.foundAt ?? 0) > since).length;
        const discrepancy = Object.values(s.receipts).some((r) => (r.closedAt ?? 0) > since && r.discrepancies?.some((d) => d.itemId === itemId));
        const pe = plan.get(itemId);
        const velocity = pe ? (pe.baseVelocity * 16) / Math.max(1, pe.packQty) : 0.5;
        const loadedAt = Math.min(...ids.map((id) => s.cases[id]?.receivedAt ?? now));
        const daysSinceCount = (now - (s.countedAt[bin] ?? loadedAt)) / (24 * HOUR_MS);
        const pred = predictCountRisk(params, { daysSinceCount, movesSinceCount: moves, discrepancy, suspect: s.suspect[itemId] !== undefined, damaged: it.damaged, velocity });
        if (!best || pred.p > best.p) best = { itemId, p: pred.p, reasons: pred.reasons };
      }
      if (best && best.p >= 0.5)
        found.push({
          p: best.p,
          draft: {
            module: 'COUNT',
            target: bin,
            action: { kind: 'CREATE_COUNT', params: { binCode: bin, itemId: best.itemId } },
            prediction: { value: best.p, unit: 'PROBABILITY' },
            confidence: best.p,
            reasons: best.reasons,
            alternatives: [],
            model: { id: champ.id, version: champ.version, kind: champ.kind },
            expiresAt: now + 24 * HOUR_MS,
          },
        });
    }
    found.sort((a, b) => b.p - a.p || a.draft.target.localeCompare(b.draft.target));
    let n = 0;
    for (const f of found.slice(0, limit)) {
      const r = await this.runtime.submit({ cmd: { type: 'IssueRecommendation', draft: f.draft }, actor: 'ai', at: now });
      if (r.ok) n++;
    }
    return n;
  }

  /**
   * 实时调度：交付排队、待拣工作量、待暂存框数 → 是否值得从某个岗位调一个人过去。
   * 只考虑未锁定、手上没有任务的员工；同岗位里调今天完成任务最少的人（负荷均衡）。
   */
  async scanDispatch(now = Date.now()): Promise<boolean> {
    const s = this.runtime.state;
    const st = this.runtime.statics;
    // 运营预警（决策记录 0021）已经发出调人建议时，这里不再重复
    if (Object.values(s.recs).some((r) => r.status === 'OPEN' && (r.module === 'STAFFING' || r.module === 'FORESIGHT') && r.action.kind === 'MOVE_ASSOCIATE')) return false;
    const map: Partial<Record<AssociateRole, StaffRole>> = { PICK: 'pick', STAGE: 'stage', HANDOFF: 'handoff' };
    const staff: Record<StaffRole, number> = { pick: 0, stage: 0, handoff: 0 };
    const movable: Record<StaffRole, number> = { pick: 0, stage: 0, handoff: 0 };
    const people: Record<StaffRole, string[]> = { pick: [], stage: [], handoff: [] };
    for (const a of st.roster) {
      const r = map[roleOf(st, s, a.id) ?? a.role];
      // 不在岗的人（学生兼职工的时段外、发布的排班里今天没有班、缺勤，决策记录 0020、0022）既不算在岗人数，也不能调动
      if (!r || !dutyOf(st, s, a.id, now).on) continue;
      staff[r]++;
      if (!s.staffLocks[a.id] && !isBusy(s, a.id)) {
        movable[r]++;
        people[r].push(a.id);
      }
    }
    const horizonMin = 15;
    const rows = handoffBoard(s, st, now);
    const waiting = rows.filter((r) => r.arrivedAt !== undefined && !r.session).length;
    const arriving = rows.filter((r) => r.arrivedAt === undefined && r.etaAt !== undefined && r.etaAt - now <= horizonMin * 60_000).length;
    const open = Object.values(s.walks).filter((w) => w.status !== 'COMPLETED');
    const pickBacklogMin = open.reduce((a, w) => a + (w.status === 'OPEN' ? w.estimatedSec : w.estimatedSec / 2) / 60, 0);
    const pickDueInMin = open.length ? Math.min(...open.map((w) => (w.dueAt - now) / 60_000)) : 120;
    const stageBacklog = Object.values(s.totes).filter((t) => t.status === 'PICKED').length;
    const state: DispatchState = { staff, waiting, arriving, horizonMin, handoffServiceMin: 4, pickBacklogMin, pickDueInMin, stageBacklog, stageMinPerTote: 0.5 };
    const advice = adviseDispatch(state, movable);
    if (!advice) return false;
    // 负荷均衡：今天完成任务最少的人（先一次数好每人的完成数：大型店几百人、几千个批次时不在排序里反复遍历，决策记录 0014）
    const doneBy = new Map<string, number>();
    for (const w of Object.values(s.walks)) if (w.status === 'COMPLETED' && w.associateId) doneBy.set(w.associateId, (doneBy.get(w.associateId) ?? 0) + 1);
    for (const x of Object.values(s.sessions)) if (x.status === 'COMPLETED') doneBy.set(x.owner, (doneBy.get(x.owner) ?? 0) + 1);
    const done = (id: string) => doneBy.get(id) ?? 0;
    const who = [...people[advice.from]].sort((a, b) => done(a) - done(b) || a.localeCompare(b))[0];
    if (!who) return false;
    const toRole = (Object.entries(map).find(([, v]) => v === advice.to)?.[0] ?? 'HANDOFF') as AssociateRole;
    const draft: RecommendationDraft = {
      module: 'STAFFING',
      target: who,
      action: { kind: 'MOVE_ASSOCIATE', params: { associateId: who, from: advice.from, to: toRole } },
      // 显示调入岗位最关心的指标：交付区的平均等待，或拣货的预计迟到
      prediction:
        advice.to === 'handoff' || advice.from === 'handoff'
          ? { value: advice.after.handoffWaitMin, baseline: advice.before.handoffWaitMin, unit: 'MINUTES' }
          : advice.to === 'pick' || advice.from === 'pick'
            ? { value: advice.after.pickLateMin, baseline: advice.before.pickLateMin, unit: 'MINUTES' }
            : { value: advice.after.stageDelayMin, baseline: advice.before.stageDelayMin, unit: 'MINUTES' },
      confidence: Math.min(0.95, Math.round((0.5 + advice.gain / 2) * 1000) / 1000),
      reasons: advice.reasons,
      alternatives: [],
      model: { id: 'staffing-dispatch', version: 1, kind: 'queue-sim' },
      expiresAt: now + 15 * 60_000,
    };
    const r = await this.runtime.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now });
    return r.ok;
  }

  /** 今天剩余营业小时的排班建议（信息类）：各岗位总工时与名单相同，按预测工作量重新分配到各小时 */
  async issueStaffPlan(now = Date.now()): Promise<SubmitResult | undefined> {
    const champ = this.registry.champion(ORDERS_MODEL);
    const ctx = this.context;
    const f = champ ? FORECASTERS[champ.kind] : undefined;
    if (!champ || !ctx || !f) return undefined;
    const st = this.runtime.statics;
    const s = this.runtime.state;
    const t = new Date(now);
    const date = localDate(now);
    const day = daysBetween(champ.data.from ?? ctx.history.from, date);
    const x = this.planX({ ...ctx.history, from: champ.data.from ?? ctx.history.from, seed: champ.data.seed ?? ctx.history.seed }, day);
    const ordersByHour = new Array<number>(24).fill(0);
    for (const p of f.predict(champ.params, ctx.hours.map((hour) => ({ day, dow: t.getDay(), hour, x })))) ordersByHour[p.hour] = p.mean;
    const map: Partial<Record<AssociateRole, StaffRole>> = { PICK: 'pick', STAGE: 'stage', HANDOFF: 'handoff' };
    const heads: Record<StaffRole, number> = { pick: 0, stage: 0, handoff: 0 };
    // 学生兼职工（决策记录 0020）只在自己的班次里算人
    const parttime: Array<{ role: StaffRole; from: number; to: number }> = [];
    for (const a of st.roster) {
      const r = map[roleOf(st, s, a.id) ?? a.role];
      if (!r) continue;
      if (a.shift) parttime.push({ role: r, from: a.shift.from / 60, to: a.shift.to / 60 });
      else heads[r]++;
    }
    // 当前：全职的人整天都在岗（演示门店没有班表）；拣货从第一个营业小时前 2 小时开始
    const first = Math.max(0, (ctx.hours[0] ?? 8) - 2);
    const last = (ctx.hours.at(-1) ?? 20) + 1;
    const current = Object.fromEntries(
      STAFF_ROLES.map((r) => [r, Array.from({ length: 24 }, (_, h) => (h >= first && h < last ? heads[r] : 0) + parttime.filter((p) => p.role === r && h >= p.from && h < p.to).length)]),
    ) as Record<StaffRole, number[]>;
    const { plan, workload } = planStaffing(ordersByHour, current, { linesPerOrder: ctx.linesPerOrder, pickSecPerLine: 55, pickSecPerOrder: 60, pickLeadHours: 2, stageSecPerOrder: 30, handoffSecPerOrder: 240, pickupShare: 0.45 });
    const from = t.getHours();
    const peak = ordersByHour.reduce((m, v, h) => (v > (ordersByHour[m] ?? 0) ? h : m), 0);
    const enc = (arr: number[]) => arr.slice(first, last).join(',');
    const draft: RecommendationDraft = {
      module: 'STAFFING',
      target: `plan:${date}`,
      action: { kind: 'INFO', params: { plan: 1, first, pick: enc(plan.pick), stage: enc(plan.stage), handoff: enc(plan.handoff), currentPick: heads.pick, currentStage: heads.stage, currentHandoff: heads.handoff } },
      prediction: { value: Math.round(ordersByHour.reduce((a, b) => a + b, 0)), unit: 'ORDERS', breakdown: { unit: 'WORK_MIN', values: { pick: Math.round(workload.pick.reduce((a, b) => a + b, 0)), stage: Math.round(workload.stage.reduce((a, b) => a + b, 0)), handoff: Math.round(workload.handoff.reduce((a, b) => a + b, 0)) } } },
      confidence: 0.7,
      reasons: [
        { factor: 'PEAK_HOUR', value: Math.round(ordersByHour[peak] ?? 0), weight: 0.6, params: { hour: peak } },
        { factor: 'SAME_TOTAL_HOURS', weight: 0.4 },
      ],
      alternatives: [],
      model: { id: champ.id, version: champ.version, kind: champ.kind },
      expiresAt: new Date(t.getFullYear(), t.getMonth(), t.getDate(), Math.max(from + 1, last)).getTime(),
    };
    return this.runtime.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now });
  }

  /** 排程：每小时预测，每 5 分钟检查调度，每 10 分钟检查货架，每天检查一次盘点风险并给出排班建议 */
  async tick(now = Date.now()): Promise<void> {
    await this.maybeIssue(now);
    if (now - this.lastHealth >= 60_000) {
      this.lastHealth = now;
      await this.publishHealth(now);
    }
    if (now - this.lastDispatchScan >= 5 * 60_000 && this.context && this.inBusinessHours(now)) {
      this.lastDispatchScan = now;
      await this.scanDispatch(now);
    }
    if (now - this.lastShelfScan >= 10 * 60_000) {
      this.lastShelfScan = now;
      await this.scanShelves(now);
      await this.scanTruth(now);
    }
    const day = localDate(now);
    if (day !== this.lastCountScanDay && this.context && new Date(now).getHours() >= (this.context.hours[0] ?? 8) - 1) {
      this.lastCountScanDay = day;
      await this.scanCounts(now);
      await this.issueStaffPlan(now);
    }
  }

  // ---------------------------------------------------------------------------
  // AI 运行监控（决策记录 0022 · H3）

  /**
   * 每个模型族的健康度：
   * - 误差漂移：最近 7 天对账出来的误差（效果追踪 F4 记下的实际值）比回测时高三成以上 → 误差变大（提醒重新训练或回滚）；
   *   概率模型（可售概率、盘点风险、顺路核对）看「实际发生的比例」和模型自己说的平均概率差多少；
   * - 数据质量：收银流水中断时可售概率暂停（已经在用的规则，这里让它看得见）；有传感器离线时设备健康的预测对这些设备暂停；
   * - 样本不够时为「数据不够」，不下结论。
   */
  health(now = Date.now()): AiModelHealth[] {
    const s = this.runtime.state;
    const week = now - 7 * DAY_MS;
    const recs = Object.values(s.recs).filter((r): r is LiveRec & { outcome: NonNullable<LiveRec['outcome']> } => !!r.outcome && r.outcome.at >= week);
    const prev = new Map((s.aiHealth?.models ?? []).map((m) => [m.id, m]));
    const out: AiModelHealth[] = [];
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const add = (h: Omit<AiModelHealth, 'since'>) => {
      const p = prev.get(h.id);
      out.push({ ...h, since: p && p.status === h.status ? p.since : now });
    };
    const worse = (recent: number, backtest: number | undefined) => backtest !== undefined && backtest > 0 && recent > backtest * 1.3 && recent - backtest > 0.02;
    // 订单量：最近对账的 WAPE 对比回测
    const orders = this.registry.champion(ORDERS_MODEL);
    const fc = recs.filter((r) => r.module === 'FORECAST' && r.outcome.metric === 'ORDERS');
    const wape = fc.length ? fc.reduce((a, r) => a + Math.abs(r.outcome.actual - r.outcome.predicted), 0) / Math.max(1, fc.reduce((a, r) => a + r.outcome.actual, 0)) : 0;
    add({ id: ORDERS_MODEL, status: fc.length < 3 ? 'NO_DATA' : worse(wape, orders?.metrics.wape) ? 'DRIFT' : 'OK', metric: 'wape', n: fc.length, ...(fc.length ? { recent: r3(wape) } : {}), ...(orders?.metrics.wape !== undefined ? { backtest: orders.metrics.wape } : {}) });
    // 到店时间：平均绝对误差（分钟）
    const eta = this.registry.champion(ETA_MODEL);
    const et = recs.filter((r) => r.module === 'ETA' && r.outcome.metric === 'ETA_MIN');
    const mae = et.length ? et.reduce((a, r) => a + Math.abs(r.outcome.actual - r.outcome.predicted), 0) / et.length : 0;
    add({ id: ETA_MODEL, status: et.length < 5 ? 'NO_DATA' : worse(mae, eta?.metrics.mae) ? 'DRIFT' : 'OK', metric: 'mae', n: et.length, ...(et.length ? { recent: Math.round(mae * 10) / 10 } : {}), ...(eta?.metrics.mae !== undefined ? { backtest: eta.metrics.mae } : {}) });
    // 拣货时长：员工自己拣的、做完的批次（虚拟员工的不算）
    const pt = this.registry.champion(PICKTIME_MODEL);
    const walks = Object.values(s.walks).filter((w) => w.status === 'COMPLETED' && w.ai && w.claimedAt !== undefined && w.completedAt !== undefined && w.completedAt >= week && !w.associateId?.startsWith('V-'));
    const pw = walks.length ? walks.reduce((a, w) => a + Math.abs(((w.completedAt as number) - (w.claimedAt as number)) / 1000 - (w.ai?.sec ?? 0)), 0) / Math.max(1, walks.reduce((a, w) => a + ((w.completedAt as number) - (w.claimedAt as number)) / 1000, 0)) : 0;
    add({ id: PICKTIME_MODEL, status: walks.length < 10 ? 'NO_DATA' : worse(pw, pt?.metrics.wape) ? 'DRIFT' : 'OK', metric: 'wape', n: walks.length, ...(walks.length ? { recent: r3(pw) } : {}), ...(pt?.metrics.wape !== undefined ? { backtest: pt.metrics.wape } : {}) });
    // 概率模型：实际发生的比例 vs 模型自己说的平均概率（相差一成半以上、而且超过三成算漂移）
    const calib = (id: string, list: typeof recs, minN: number, cause?: string) => {
      if (cause) return add({ id, status: 'PAUSED', cause, n: list.length });
      if (list.length < minN) return add({ id, status: 'NO_DATA', metric: 'rate', n: list.length });
      const observed = list.reduce((a, r) => a + r.outcome.actual, 0) / list.length;
      const expected = list.reduce((a, r) => a + r.outcome.predicted, 0) / list.length;
      add({ id, status: Math.abs(observed - expected) > Math.max(0.15, 0.3 * expected) ? 'DRIFT' : 'OK', metric: 'rate', recent: r3(observed), backtest: r3(expected), n: list.length });
    };
    const posStale = this.lastSaleEvent !== undefined && now - this.lastSaleEvent > POS_GAP_MS;
    calib(AVAILABILITY_MODEL, recs.filter((r) => r.module === 'AVAILABILITY' && r.outcome.metric === 'ON_SHELF'), 5, posStale ? 'POS_STALE' : undefined);
    calib(COUNT_MODEL, recs.filter((r) => r.module === 'COUNT'), 5);
    calib('shelf-truth', recs.filter((r) => r.outcome.metric === 'ON_SHELF' && r.module === 'PICKING'), 8);
    // 运营预警：没采纳时问题真的发生的比例（预警准确率）
    const ctrl = recs.filter((r) => r.module === 'FORESIGHT' && !r.outcome.adopted);
    const precision = ctrl.length ? ctrl.filter((r) => r.outcome.hit).length / ctrl.length : 0;
    add({ id: 'ops-foresight', status: ctrl.length < 5 ? 'NO_DATA' : precision < 0.3 ? 'DRIFT' : 'OK', metric: 'precision', n: ctrl.length, ...(ctrl.length ? { recent: r3(precision) } : {}) });
    // 设备健康：有传感器离线时，这些设备的预测暂停
    const offline = Object.values(s.alerts ?? {}).filter((a) => a.status === 'ACTIVE' && a.kind === 'SENSOR_OFFLINE').length;
    add({ id: 'equipment-health', status: offline ? 'PAUSED' : 'OK', ...(offline ? { cause: 'SENSORS_OFFLINE', n: offline } : {}) });
    return out;
  }

  /** 状态有变化、或者距上次发布超过 30 分钟时，把健康度写进事件流（界面、孪生健康度、提醒都看这一份） */
  async publishHealth(now = Date.now()): Promise<boolean> {
    const models = this.health(now);
    const cur = this.runtime.state.aiHealth;
    const key = (xs: readonly AiModelHealth[]) => xs.map((m) => `${m.id}:${m.status}`).join('|');
    if (cur && key(cur.models) === key(models) && now - cur.at < 30 * 60_000) return false;
    return (await this.runtime.submit({ cmd: { type: 'PublishAiHealth', health: { at: now, models } }, actor: 'ai', at: now })).ok;
  }

  private inBusinessHours(now: number): boolean {
    const h = new Date(now).getHours();
    const hours = this.context?.hours ?? [];
    return hours.length > 0 && h >= (hours[0] as number) - 2 && h <= (hours.at(-1) as number) + 1;
  }

  /** 这位顾客以前的真实到店记录（实际用时 − 固定效应预测） */
  private liveCustomerStats(params: EtaParams, key: string, before: number): CustomerStats {
    const st = { n: 0, sum: 0 };
    // 要求删除个人记录的顾客：不用他以前的到店习惯（决策记录 0023 · B4）
    if (this.forgotten.has(key)) return { n: 0, sum: 0 };
    for (const o of Object.values(this.runtime.state.orders)) {
      if (customerKey(o) !== key || o.arrivedAt === undefined || o.etaAt === undefined || o.etaReportedAt === undefined || o.arrivedAt >= before) continue;
      const s = this.etaSample(o, o.etaReportedAt, o.etaAt);
      if (!s) continue;
      const fixed = predictEta({ ...params, variant: 'eta-fixed', customers: {} }, s).mean;
      st.n++;
      st.sum += (o.arrivedAt - o.etaReportedAt) / 60_000 - fixed;
    }
    return st;
  }

  private etaSample(o: LiveOrder, reportedAt: number, etaAt: number): EtaSample | undefined {
    const reportedMin = (etaAt - reportedAt) / 60_000;
    if (!(reportedMin > 0) || reportedMin > 240) return undefined;
    const d = new Date(reportedAt);
    const dow = d.getDay();
    const hour = d.getHours();
    const ctx = this.context;
    const x = ctx ? this.planX(ctx.history, daysBetween(ctx.history.from, localDate(reportedAt))) : {};
    const rain = x.forecastRainMm ?? 0;
    return { t: reportedAt, customer: customerKey(o), reportedMin, hour, dow, x: { rush: isRushHour(dow, hour) ? 1 : 0, weekend: dow === 0 || dow === 6 ? 1 : 0, rainHeavy: rain >= 10 ? 1 : 0, forecastRainMm: rain } };
  }

  /** 顾客上报预计到达后：修正并发出建议 */
  async issueEta(e: AnyOpsEvent): Promise<SubmitResult | undefined> {
    if (e.type !== 'EtaUpdated' || !e.payload.orderId) return undefined;
    const champ = this.registry.champion(ETA_MODEL);
    const o = this.runtime.state.orders[e.payload.orderId];
    // 自动运营的虚拟顾客按压缩的时间到店（几十秒），不在到店时间模型的范围里：不做修正，也不进效果追踪
    if (!champ || !o || o.arrivedAt !== undefined || o.track === 'AUTO') return undefined;
    const sample = this.etaSample(o, e.at, e.payload.etaAt);
    if (!sample) return undefined;
    const params = champ.params as EtaParams;
    const pred = predictEta(params, sample, this.liveCustomerStats(params, sample.customer, e.at));
    const etaAt = Math.round(e.at + pred.mean * 60_000);
    const alternatives: Alternative[] = this.registry
      .list(ETA_MODEL)
      .filter((m) => m.note === 'NOT_BEST' && m.trainedAt === champ.trainedAt)
      .map((m) => ({ action: { kind: 'INFO', params: { model: m.kind, version: m.version, value: predictEta(m.params as EtaParams, sample).mean } }, score: Math.round(-(m.metrics.mae ?? 0) * 100) / 100 }));
    const draft: RecommendationDraft = {
      module: 'ETA',
      target: o.id,
      action: { kind: 'USE_AI_ETA', params: { orderId: o.id, etaAt } },
      prediction: { value: pred.mean, low: pred.low, high: pred.high, unit: 'MINUTES', from: e.at, to: etaAt, baseline: Math.round(sample.reportedMin * 10) / 10 },
      confidence: confidenceFromInterval(pred.mean, pred.low, pred.high),
      reasons: pred.reasons,
      alternatives,
      model: { id: champ.id, version: champ.version, kind: champ.kind },
      expiresAt: etaAt + 30 * 60_000,
    };
    return this.runtime.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: Date.now() });
  }

  async rollback(now = Date.now()): Promise<ModelVersion | undefined> {
    const v = this.registry.rollback(ORDERS_MODEL, now);
    if (v) await this.save();
    return v;
  }

  /** 未来几小时（今天剩余的营业小时；今天已结束时为明天开头）的订单量预测建议 */
  forecastDraft(now = Date.now()): RecommendationDraft | undefined {
    const champ = this.registry.champion(ORDERS_MODEL);
    const ctx = this.context;
    const f = champ ? FORECASTERS[champ.kind] : undefined;
    if (!champ || !ctx || !f || !ctx.hours.length) return undefined;
    const t = new Date(now);
    let dayStart = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    let hours = ctx.hours.filter((h) => h > t.getHours()).slice(0, WINDOW_HOURS);
    if (!hours.length) {
      dayStart = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
      hours = ctx.hours.slice(0, WINDOW_HOURS);
    }
    const date = localDate(dayStart.getTime());
    const dow = dayStart.getDay();
    const future = (m: ModelVersion) => {
      // 天序号相对于该版本自己的训练数据（回滚后可能是更早的一批）
      const from = m.data.from ?? ctx.history.from;
      const day = daysBetween(from, date);
      const x = this.planX({ ...ctx.history, from, seed: m.data.seed ?? ctx.history.seed }, day);
      return hours.map((hour) => ({ day, dow, hour, x }));
    };
    const agg = aggregateForecast(f.predict(champ.params, future(champ)));
    const usual = hours.reduce((a, h) => a + (ctx.usual[`${dow}-${h}`] ?? 0), 0);
    const at = (h: number) => new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), h).getTime();
    const fromMs = at(hours[0] as number);
    const toMs = at((hours.at(-1) as number) + 1);
    // 同一批训练中没有被选中的模型：作为备选预测一起显示，让人看到模型之间的分歧
    const alternatives: Alternative[] = this.registry
      .list(ORDERS_MODEL)
      .filter((m) => m.note === 'NOT_BEST' && m.trainedAt === champ.trainedAt && FORECASTERS[m.kind])
      .map((m) => {
        const alt = aggregateForecast((FORECASTERS[m.kind] as typeof f).predict(m.params, future(m)));
        return { action: { kind: 'INFO', params: { model: m.kind, version: m.version, value: alt.mean } }, score: Math.round((1 - (m.metrics.wape ?? 1)) * 1000) / 1000 };
      });
    const lines = agg.mean * ctx.linesPerOrder;
    const breakdown = Object.fromEntries(Object.entries(ctx.zoneShares).map(([z, s]) => [z, Math.round(lines * s)]));
    return {
      module: 'FORECAST',
      target: 'store',
      action: { kind: 'INFO', params: { window: hours.length } },
      prediction: { value: agg.mean, low: agg.low, high: agg.high, unit: 'ORDERS', from: fromMs, to: toMs, baseline: Math.round(usual * 10) / 10, breakdown: { unit: 'LINES', values: breakdown } },
      confidence: confidenceFromInterval(agg.mean, agg.low, agg.high),
      reasons: agg.reasons,
      alternatives,
      model: { id: champ.id, version: champ.version, kind: champ.kind },
      expiresAt: toMs,
    };
  }

  async issueForecast(now = Date.now()): Promise<SubmitResult | undefined> {
    const draft = this.forecastDraft(now);
    if (!draft) return undefined;
    this.lastIssued = hourKey(now);
    return this.runtime.submit({ cmd: { type: 'IssueRecommendation', draft }, actor: 'ai', at: now });
  }

  /** 排程调用：每个小时发一次（营业时间内） */
  async maybeIssue(now = Date.now()): Promise<void> {
    if (hourKey(now) === this.lastIssued || !this.context) return;
    const h = new Date(now).getHours();
    const hours = this.context.hours;
    if (!hours.length || h < (hours[0] as number) - 2 || h > (hours.at(-1) as number)) return;
    await this.issueForecast(now);
  }

  summary(): { models: ModelVersion[]; champion?: number; context?: AiContext; shelfTruth: { reliability: ReturnType<AiService['reliabilityTable']>; tracked: number }; substitution: { labels: ReturnType<AiService['labelStats']>; attributes: ReturnType<AiService['attributeStats']> } } {
    const champ = this.registry.champion(ORDERS_MODEL);
    return {
      models: this.registry.list().map((m) => ({ ...m, params: undefined })),
      ...(champ ? { champion: champ.version } : {}),
      ...(this.context ? { context: this.context } : {}),
      // 多源货架真相（决策记录 0022 · C1）：各种拣货员报告的可靠度、正在跟踪的商品数
      shelfTruth: { reliability: this.reliabilityTable(), tracked: this.signals.size },
      // 替代推荐 2.0（决策记录 0023 · B4）：交付时记下的真实标签、商品名里抽属性的效果
      substitution: { labels: this.labelStats(), attributes: this.attributeStats() },
    };
  }

  /** 真实标签的统计：一共几条、满意的比例、AI 推荐第一名的满意比例 */
  labelStats(): { n: number; accepted: number; top1: number; top1Accepted: number } {
    const top = this.subLabels.filter((x) => x.rank === 1);
    return { n: this.subLabels.length, accepted: this.subLabels.filter((x) => x.accepted).length, top1: top.length, top1Accepted: top.filter((x) => x.accepted).length };
  }

  private attrStats?: ReturnType<typeof evaluateAttributes>;
  attributeStats(): ReturnType<typeof evaluateAttributes> {
    this.attrStats ??= evaluateAttributes([...this.demo.catalog.values()]);
    return this.attrStats;
  }

  /** 顾客要求删除个人记录：替代品标签删掉，以后不再用他的到店习惯和替代偏好（按姓名） */
  async forgetCustomer(key: string): Promise<{ removed: number }> {
    const before = this.subLabels.length;
    this.subLabels = this.subLabels.filter((x) => x.customer !== key);
    this.forgotten.add(key);
    await this.save();
    return { removed: before - this.subLabels.length };
  }

  private async save(): Promise<void> {
    if (!this.context) return;
    const row: AiStateRow = { registry: this.registry.toJSON(), context: this.context, reliability: this.reliability, subLabels: this.subLabels, forgotten: [...this.forgotten] };
    await this.storage.saveAiState(this.runtime.id, row, Date.now());
  }
}

/** 两个货位隔多远（货位编号「通道-边段-层」，如 F1-A01-R11-3）：同一通道里段号差 × 10 + 层差，对面货架加 5；不在同一通道算很远 */
export function locationDistance(a: string, b: string): number {
  const parse = (id: string) => /^(.*)-([A-Z])(\d+)-(\d+)$/.exec(id);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y || x[1] !== y[1]) return a === b ? 0 : 999;
  return Math.abs(Number(x[3]) - Number(y[3])) * 10 + Math.abs(Number(x[4]) - Number(y[4])) + (x[2] === y[2] ? 0 : 5);
}

/** 演示数据里没有顾客编号，用姓名代替（同名顾客会被当成同一人） */
function customerKey(o: { firstName: string; lastName: string }): string {
  return `${o.firstName} ${o.lastName}`;
}

function hourKey(ms: number): string {
  const d = new Date(ms);
  return `${localDate(ms)}T${d.getHours()}`;
}

function usualTable(series: readonly SeriesPoint[], weeks = 4): Record<string, number> {
  const by = new Map<string, number[]>();
  for (const p of [...series].sort((a, b) => a.day - b.day)) {
    const k = `${p.dow}-${p.hour}`;
    const list = by.get(k) ?? [];
    list.push(p.y);
    by.set(k, list);
  }
  const out: Record<string, number> = {};
  for (const [k, list] of by) {
    const recent = list.slice(-weeks);
    out[k] = Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 10) / 10;
  }
  return out;
}

/** 最近 4 周按温区的商品行占比与每单平均行数 */
function zoneMix(hist: DemandHistory, demo: DemoStore): Pick<AiContext, 'zoneShares' | 'linesPerOrder'> {
  const zoneOf = new Map<string, TempZone>(demo.ctx.model.config.catalog.categories.map((c) => [c.id, c.tempZone as TempZone]));
  const recent = hist.days.slice(-28);
  const byZone: Record<string, number> = {};
  let lines = 0;
  let orders = 0;
  for (const d of recent) {
    orders += d.actual.orders;
    for (const [c, n] of Object.entries(d.actual.linesByCategory)) {
      const z = zoneOf.get(c) ?? 'AMBIENT';
      byZone[z] = (byZone[z] ?? 0) + n;
      lines += n;
    }
  }
  return {
    zoneShares: Object.fromEntries(Object.entries(byZone).map(([z, n]) => [z, Math.round((n / Math.max(1, lines)) * 1000) / 1000])),
    linesPerOrder: Math.round((lines / Math.max(1, orders)) * 100) / 100,
  };
}
