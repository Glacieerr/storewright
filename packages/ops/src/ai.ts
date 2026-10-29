import { AI_MODES, AI_MODULES, DEFAULT_AI_MODES, OVERRIDE_REASONS, type AiMode, type AiModule, type Recommendation } from '@storewright/ai';
import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { AiModuleStats, AssociateRole, LiveRec, OpsState, OutcomeStats, RecOutcome, ShelfCheck, StoreStatic } from './types';
import { canMove, isBusy, roleChangeEvent } from './staff';
import { openCountFor } from './inventory';
import { offerEvent } from './roster';
import { ticketEvent } from './maintenance';
import { handOverEvents, splitWalkEvents } from './coldchain';
import { closeSlotEvent } from './capacity';
import { donateEvent, markdownEvent } from './expiry';

/**
 * AI 建议与运行模式的命令处理和状态更新（决策记录 0010 第 2 节原则 1、2）。
 *
 * - 建议由服务端的 AI 服务以 ai / system 身份发出；同一模块、同一对象还没处理的旧建议被新建议取代；
 * - 带班负责人（LEAD）或控制台可以采纳、否决（必须选原因）、忽略建议，设置模块的运行模式；
 *   锁定的模块只有控制台可以修改；
 * - 自动执行模式下，可执行的建议发出时直接记为自动执行并追加动作的事件；需确认模式下采纳时才执行。
 *   已实现的动作见 EXECUTABLE_ACTIONS；其他动作代码会被拒绝。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode, params?: Record<string, string | number>): Result => ({ ok: false, reject: params ? { code, params } : { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

/** 状态里最多保留的建议条数（超过时先清理最早的已处理建议） */
export const MAX_RECS = 300;

/** 已实现的动作；INFO 只是信息，没有可执行的内容 */
export const EXECUTABLE_ACTIONS = new Set<string>(['USE_AI_ETA', 'CHECK_SHELF', 'CREATE_COUNT', 'MOVE_ASSOCIATE', 'SET_MTO_START', 'EXPEDITE_ORDERS', 'DEFER_FROZEN', 'NOTIFY_DELAY', 'OFFER_SHIFT', 'OFFER_EARLY_LEAVE', 'REQUEST_REPAIR', 'SEARCH_NEARBY', 'ADD_WALK_CHECK', 'SPLIT_WALK', 'HAND_OVER', 'CLOSE_SLOT', 'MARKDOWN', 'DONATE']);

/**
 * 涉及人、钱、顾客的动作：模块设成「自动执行」也要人确认（15 号文档第 9 节：调人、降价、发顾客消息始终需要人确认）。
 * 调人、补班和提前下班的邀请、通知顾客晚到、降价、捐赠、停止接单。
 */
export const CONFIRM_ALWAYS: ReadonlySet<string> = new Set(['MOVE_ASSOCIATE', 'OFFER_SHIFT', 'OFFER_EARLY_LEAVE', 'NOTIFY_DELAY', 'MARKDOWN', 'DONATE', 'CLOSE_SLOT']);

/** 动作参数里的订单列表（逗号分隔） */
/** 货架上的批次任务（决策记录 0026）：贴折扣签、拿下来捐赠 */
function lotTaskEvent(s: OpsState, st: StoreStatic, itemId: string, reason: 'MARKDOWN' | 'DONATE', lot: string, recId: string, pct?: number): PendingEvent | undefined {
  const pe = st.planogram.find((x) => x.itemId === itemId);
  const l = s.shelfLots?.[itemId]?.find((x) => x.lot === lot);
  if (!pe || !l) return undefined;
  return ev('ShelfCheckRequested', { checkId: `SC${String(s.counters.checks + 1).padStart(4, '0')}`, itemId, locationId: pe.locationId, reason, lot, expected: l.units, recId, ...(pct !== undefined && Number.isFinite(pct) ? { pct } : {}) });
}

const idList = (v: unknown): string[] => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** 执行建议的动作：返回要追加的事件；对象已经不存在或已经结束时返回 undefined（动作过时）。autoNext：补班邀请被拒后自动问下一个人 */
function actionEvents(s: OpsState, rec: Recommendation, st: StoreStatic, at?: number, opts: { autoNext?: boolean } = {}): PendingEvent[] | undefined {
  const p = rec.action.params ?? {};
  switch (rec.action.kind) {
    case 'USE_AI_ETA': {
      const o = s.orders[String(p.orderId ?? '')];
      const etaAt = Number(p.etaAt);
      if (!o || !Number.isFinite(etaAt) || o.arrivedAt !== undefined || o.status === 'COMPLETED' || o.status === 'CANCELLED') return undefined;
      return [ev('AiEtaApplied', { orderId: o.id, etaAt, recId: rec.id })];
    }
    case 'CHECK_SHELF': {
      const itemId = String(p.itemId ?? '');
      const locationId = String(p.locationId ?? '');
      if (!itemId || !locationId || Object.values(s.checks).some((c) => c.itemId === itemId && c.status === 'OPEN')) return undefined;
      return [ev('ShelfCheckRequested', { checkId: `SC${String(s.counters.checks + 1).padStart(4, '0')}`, itemId, locationId, reason: 'AI', recId: rec.id })];
    }
    // 多源货架真相（决策记录 0022 · C1）：可能放错了地方，请人到同一通道附近的货架段找一找
    case 'SEARCH_NEARBY': {
      const itemId = String(p.itemId ?? '');
      const locationId = String(p.locationId ?? '');
      if (!itemId || !locationId || Object.values(s.checks).some((c) => c.itemId === itemId && c.status === 'OPEN')) return undefined;
      return [ev('ShelfCheckRequested', { checkId: `SC${String(s.counters.checks + 1).padStart(4, '0')}`, itemId, locationId, reason: 'SEARCH', recId: rec.id, near: idList(p.near).slice(0, 8) })];
    }
    // 顺路核对（决策记录 0022 · C3）：拣货员路过时顺手数一下（每个批次最多一次）
    case 'ADD_WALK_CHECK': {
      const w = s.walks[String(p.walkId ?? '')];
      const itemId = String(p.itemId ?? '');
      if (!w || w.status === 'COMPLETED' || w.checks?.length || !itemId || Object.values(s.checks).some((c) => c.itemId === itemId && c.status === 'OPEN')) return undefined;
      return [ev('WalkCheckAdded', { walkId: w.id, check: { itemId, locationId: String(p.locationId ?? ''), name: String(p.name ?? itemId), afterStop: Math.max(0, Math.round(Number(p.afterStop ?? 0))) }, recId: rec.id })];
    }
    // 冷链（决策记录 0023 · B3）：领取前拆批（groups：「框,框|框,框」）；拣货中剩下的行转给别人
    case 'SPLIT_WALK':
      return splitWalkEvents(s, String(p.walkId ?? ''), String(p.groups ?? '').split('|').map(idList), rec.id);
    case 'HAND_OVER':
      return handOverEvents(s, String(p.walkId ?? ''), rec.id);
    // 临期与损耗（决策记录 0024 · C4）：降价、到期前捐赠
    // 降价、捐赠（决策记录 0026）：同时给补货员一个货架任务 —— 贴折扣签、拿下来捐赠（捐赠的件数按实际拿下来的记）
    case 'MARKDOWN': {
      const e = markdownEvent(s, String(p.itemId ?? ''), String(p.lot ?? ''), Number(p.pct), rec.id);
      return e ? [e, lotTaskEvent(s, st, String(p.itemId ?? ''), 'MARKDOWN', String(p.lot ?? ''), rec.id, Number(p.pct))].filter((x): x is PendingEvent => !!x) : undefined;
    }
    case 'DONATE': {
      if (!donateEvent(s, String(p.itemId ?? ''), String(p.lot ?? ''), rec.id)) return undefined;
      const task = lotTaskEvent(s, st, String(p.itemId ?? ''), 'DONATE', String(p.lot ?? ''), rec.id);
      return task ? [task] : undefined;
    }
    // 时段产能（决策记录 0023 · B6）：这个取货时段停止接新单
    case 'CLOSE_SLOT': {
      const e = closeSlotEvent(s, st, Number(p.slotStart), rec.id);
      return e ? [e] : undefined;
    }
    case 'MOVE_ASSOCIATE': {
      const id = String(p.associateId ?? '');
      const to = String(p.to ?? '') as AssociateRole;
      // 锁定、已经在目标岗位、不允许的岗位：动作过时
      if (s.staffLocks[id] || canMove(st, s, id, to, at)) return undefined;
      // 建议里写了「约 N 小时」的：到时自动调回原岗位；没写的一直在新岗位，直到再调回来
      const minutes = p.hours !== undefined ? Math.min(12 * 60, Math.max(5, Math.round(Number(p.hours) * 60))) : undefined;
      // 手上有任务：做完这一单再去（排队；决策记录 0026，以前算过时）
      if (isBusy(s, id)) return [ev('AssociateMoveQueued', { associateId: id, role: to, recId: rec.id, ...(minutes ? { minutes } : {}) })];
      return [roleChangeEvent(s, st, id, to, rec.id, minutes, at)];
    }
    case 'SET_MTO_START': {
      const t = s.mto[String(p.ticketId ?? '')];
      const startAt = Number(p.startAt);
      if (!t || t.status !== 'QUEUED' || !Number.isFinite(startAt)) return undefined;
      return [ev('MtoStartAdjusted', { ticketId: t.id, startAt, recId: rec.id })];
    }
    // 运营预警（决策记录 0021）：提前开始（不等锁单时间、批次排在最前）、冷冻商品晚点拣、通知顾客延后
    case 'EXPEDITE_ORDERS': {
      const ids = idList(p.orderIds).filter((id) => {
        const o = s.orders[id];
        return !!o && !o.expedite && (o.status === 'CREATED' || o.status === 'LOCKED');
      });
      return ids.length ? [ev('OrdersExpedited', { orderIds: ids, recId: rec.id })] : undefined;
    }
    case 'DEFER_FROZEN': {
      const until = Number(p.until);
      const ids = idList(p.orderIds).filter((id) => {
        const o = s.orders[id];
        if (!o || o.status === 'CANCELLED' || o.status === 'COMPLETED') return false;
        // 冷冻框还没进批次（或订单还没锁单）才来得及晚点拣
        return o.status === 'CREATED' || o.toteIds.some((t) => s.totes[t]?.tempZone === 'FROZEN' && s.totes[t]?.status === 'PLANNED');
      });
      return ids.length && Number.isFinite(until) ? [ev('FrozenDeferred', { orderIds: ids, until, recId: rec.id })] : undefined;
    }
    case 'NOTIFY_DELAY': {
      const minutes = Math.round(Number(p.minutes));
      const ids = idList(p.orderIds).filter((id) => {
        const o = s.orders[id];
        return !!o && o.status !== 'CANCELLED' && o.status !== 'COMPLETED' && o.delayNoticeAt === undefined;
      });
      return ids.length && minutes > 0 ? [ev('DelayNoticeSent', { orderIds: ids, minutes, recId: rec.id })] : undefined;
    }
    // 补位（决策记录 0022 · D2）：给某人发补班 / 延长、或自愿提前下班的邀请，他自己接受或拒绝
    case 'OFFER_SHIFT': {
      const e = offerEvent(s, st, p, 'EXTRA', { recId: rec.id, autoNext: !!opts.autoNext });
      return e ? [e] : undefined;
    }
    case 'OFFER_EARLY_LEAVE': {
      const e = offerEvent(s, st, p, 'EARLY_LEAVE', { recId: rec.id });
      return e ? [e] : undefined;
    }
    // 预测性维护（决策记录 0022 · E1）：开报修单，这台设备管着的暂存格位暂停放新框
    case 'REQUEST_REPAIR': {
      const reason = p.reason === 'STUCK' ? 'STUCK' : p.reason === 'WATCH' ? 'WATCH' : 'RISK';
      const e = ticketEvent(s, String(p.sensorId ?? ''), idList(p.slots), reason, rec.id);
      return e ? [e] : undefined;
    }
    case 'CREATE_COUNT': {
      const binCode = String(p.binCode ?? '');
      const itemId = p.itemId ? String(p.itemId) : undefined;
      if (!binCode || !s.bins[binCode]?.length || openCountFor(s, binCode)) return undefined;
      return [ev('CycleCountCreated', { countId: `CC${String(s.counters.counts + 1).padStart(4, '0')}`, binCode, reason: 'AI_RISK', ...(itemId ? { itemId } : {}) })];
    }
    default:
      return undefined;
  }
}

type AiCommand = Extract<OpsCommand, { type: 'IssueRecommendation' | 'AcceptRecommendation' | 'OverrideRecommendation' | 'DismissRecommendation' | 'SetAiMode' | 'RecordOutcome' | 'PublishAiHealth' }>;

export const AI_COMMANDS = new Set<OpsCommand['type']>(['IssueRecommendation', 'AcceptRecommendation', 'OverrideRecommendation', 'DismissRecommendation', 'SetAiMode', 'RecordOutcome', 'PublishAiHealth']);

const HEALTH_STATUS = ['OK', 'DRIFT', 'PAUSED', 'NO_DATA'];

/** 自动降级（决策记录 0022 · F4）：最近 RECENT_N 次采纳后的结果里至少 DOWNGRADE_MIN 次、说到做到不到 DOWNGRADE_RATE 时降成只显示 */
export const OUTCOME_RECENT_N = 10;
export const DOWNGRADE_MIN = 6;
export const DOWNGRADE_RATE = 0.4;

export function isAiCommand(cmd: OpsCommand): cmd is AiCommand {
  return AI_COMMANDS.has(cmd.type);
}

/** 带班负责人或控制台 */
export function canManageAi(st: StoreStatic, actor: string): boolean {
  return actor === 'console' || st.roster.find((a) => a.id === actor)?.role === 'LEAD';
}

export function aiModeOf(s: OpsState, module: AiModule): AiMode {
  return (s.aiModes[module]?.mode as AiMode | undefined) ?? DEFAULT_AI_MODES[module];
}

export function decideAi(s: OpsState, env: CommandEnvelope & { cmd: AiCommand }, st: StoreStatic): Result {
  const { cmd, actor, at } = env;
  switch (cmd.type) {
    case 'IssueRecommendation': {
      if (actor !== 'ai' && actor !== 'system') return no('NOT_AUTHORIZED');
      const d = cmd.draft;
      if (!AI_MODULES.includes(d.module)) return no('MODULE_UNKNOWN', { module: String(d.module) });
      if (!d.target || !d.model?.id || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1 || !Array.isArray(d.reasons) || !(d.expiresAt > at)) return no('INVALID_RECOMMENDATION');
      if (d.action.kind !== 'INFO' && !EXECUTABLE_ACTIONS.has(d.action.kind)) return no('ACTION_UNKNOWN', { kind: d.action.kind });
      const out: PendingEvent[] = [];
      for (const r of Object.values(s.recs)) if (r.status === 'OPEN' && r.module === d.module && r.target === d.target) out.push(ev('RecommendationResolved', { recId: r.id, resolution: 'SUPERSEDED' }));
      // 模块是自动执行时，涉及人、钱、顾客的动作这一条仍按「需确认」发
      // 例外：补班邀请被拒后问下一个人，带班负责人第一次采纳时已经同意「被拒后自动问下一个人」（决策记录 0026）
      const consented = followUpConsented(s, d.action);
      const mode = consented ? 'AUTO' : aiModeOf(s, d.module) === 'AUTO' && CONFIRM_ALWAYS.has(d.action.kind) ? 'CONFIRM' : aiModeOf(s, d.module);
      const rec: Recommendation = { ...d, id: `REC-${String(s.counters.recs + 1).padStart(6, '0')}`, issuedAt: at, mode };
      const opts = { autoNext: consented };
      if (EXECUTABLE_ACTIONS.has(d.action.kind) && !actionEvents(s, rec, st, at, opts)) return no('ACTION_STALE');
      out.push(ev('RecommendationIssued', { rec }));
      if (mode === 'AUTO' && EXECUTABLE_ACTIONS.has(d.action.kind)) out.push(ev('RecommendationResolved', { recId: rec.id, resolution: 'AUTO_APPLIED' }), ...(actionEvents(s, rec, st, at, opts) ?? []));
      return yes(out);
    }
    case 'AcceptRecommendation':
    case 'DismissRecommendation':
    case 'OverrideRecommendation': {
      if (!canManageAi(st, actor)) return no('NOT_AUTHORIZED');
      const r = s.recs[cmd.recId];
      if (!r) return no('REC_NOT_FOUND');
      if (r.status !== 'OPEN') return no('REC_CLOSED', { status: r.status });
      if (cmd.type === 'AcceptRecommendation') {
        // 「只显示」的建议：采纳就是「有用」，不执行动作（决策记录 0026；要执行请把模块改成需确认）
        if (!EXECUTABLE_ACTIONS.has(r.action.kind) || r.mode === 'SHOW') return yes([ev('RecommendationResolved', { recId: r.id, resolution: 'ACCEPTED' })]);
        const extra = actionEvents(s, r, st, at, { autoNext: !!cmd.autoNext });
        if (!extra) return no('ACTION_STALE');
        return yes([ev('RecommendationResolved', { recId: r.id, resolution: 'ACCEPTED' }), ...extra]);
      }
      if (cmd.type === 'DismissRecommendation') return yes([ev('RecommendationResolved', { recId: r.id, resolution: 'DISMISSED' })]);
      if (!OVERRIDE_REASONS.includes(cmd.reason)) return no('REASON_UNKNOWN');
      const note = typeof cmd.note === 'string' ? cmd.note.trim().slice(0, 200) : '';
      return yes([ev('RecommendationResolved', { recId: r.id, resolution: 'OVERRIDDEN', reason: cmd.reason, ...(note ? { note } : {}) })]);
    }
    case 'SetAiMode': {
      if (!canManageAi(st, actor)) return no('NOT_AUTHORIZED');
      if (!AI_MODULES.includes(cmd.module)) return no('MODULE_UNKNOWN', { module: String(cmd.module) });
      if (!AI_MODES.includes(cmd.mode)) return no('MODE_UNKNOWN');
      const cur = s.aiModes[cmd.module];
      if (cur?.locked && actor !== 'console') return no('MODE_LOCKED');
      // 只有控制台可以加锁或解锁；带班负责人修改时保持原来的锁定状态
      const locked = actor === 'console' ? (cmd.locked ?? cur?.locked ?? false) : (cur?.locked ?? false);
      if (cur && cur.mode === cmd.mode && cur.locked === locked) return yes([]);
      return yes([ev('AiModeSet', { module: cmd.module, mode: cmd.mode, locked })]);
    }
    case 'RecordOutcome': {
      if (actor !== 'ai' && actor !== 'system') return no('NOT_AUTHORIZED');
      const r = s.recs[cmd.recId];
      if (!r) return no('REC_NOT_FOUND');
      // 订单量预测只是信息，时间段过去就可以对账；其他建议要有人处理过
      if (r.status === 'OPEN' && r.module !== 'FORECAST') return no('REC_CLOSED', { status: r.status });
      if (r.outcome) return yes([]);
      const o = cmd.outcome;
      if (!o || !['EFFECT', 'EVENT', 'CALIBRATION'].includes(o.kind) || typeof o.metric !== 'string' || ![o.predicted, o.actual].every(Number.isFinite) || (o.baseline !== undefined && !Number.isFinite(o.baseline))) return no('INVALID_RECOMMENDATION');
      const adopted = r.status === 'ACCEPTED' || r.status === 'AUTO_APPLIED' || (r.module === 'FORECAST' && r.action.kind === 'INFO');
      const outcome: RecOutcome = { kind: o.kind, metric: o.metric, unit: String(o.unit ?? ''), predicted: o.predicted, actual: o.actual, hit: !!o.hit, adopted, at, ...(o.baseline !== undefined ? { baseline: o.baseline } : {}), ...(o.realized !== undefined && Number.isFinite(o.realized) ? { realized: Math.round(o.realized * 1000) / 1000 } : {}) };
      const out: PendingEvent[] = [ev('OutcomeRecorded', { recId: r.id, module: r.module, outcome })];
      // 连续不准时自动降成只显示（带班负责人会收到提醒；锁定的模块不动）
      if (adopted && o.kind !== 'CALIBRATION') {
        const recent = [...(s.aiStats[r.module]?.outcomes?.recent ?? []), outcome.hit ? 1 : 0].slice(-OUTCOME_RECENT_N);
        const rate = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (recent.length >= DOWNGRADE_MIN && rate < DOWNGRADE_RATE && aiModeOf(s, r.module) !== 'SHOW' && !s.aiModes[r.module]?.locked)
          out.push(ev('AiModeSet', { module: r.module, mode: 'SHOW', locked: false, auto: { hitRate: Math.round(rate * 100) / 100, n: recent.length } }));
      }
      return yes(out);
    }
    case 'PublishAiHealth': {
      if (actor !== 'ai' && actor !== 'system') return no('NOT_AUTHORIZED');
      const models = (cmd.health?.models ?? []).filter((m) => typeof m.id === 'string' && HEALTH_STATUS.includes(m.status) && Number.isFinite(m.since)).slice(0, 30);
      return yes([ev('AiHealthPublished', { health: { at, models } })]);
    }
  }
}

/** 补班邀请被拒后问下一个人：被拒的那个邀请同意过「被拒后自动问下一个人」 */
function followUpConsented(s: OpsState, a: Recommendation['action']): boolean {
  if (a.kind !== 'OFFER_SHIFT') return false;
  const prev = s.offers?.[String(a.params?.followUpOf ?? '')];
  return !!prev?.autoNext && prev.status === 'DECLINED';
}

/** 建议的动作已经做不了（对象没了、已经做过、已经在那个岗位）：采纳会被拒（ACTION_STALE） */
export function recStale(s: OpsState, rec: Recommendation, st: StoreStatic, at: number): boolean {
  return EXECUTABLE_ACTIONS.has(rec.action.kind) && !actionEvents(s, rec, st, at);
}

/** Tick：过期的建议记为过期；动作已经做不了的也自动收起（决策记录 0026：以前要先采纳失败再忽略） */
export function aiTick(s: OpsState, at: number, st?: StoreStatic): PendingEvent[] {
  const out: PendingEvent[] = [];
  for (const r of Object.values(s.recs)) if (r.status === 'OPEN' && (r.expiresAt <= at || (st && recStale(s, r, st, at)))) out.push(ev('RecommendationResolved', { recId: r.id, resolution: 'EXPIRED' }));
  return out;
}

/** 各模块建议的紧急程度：设备和运营预警最急，纯信息（订单量预测）最后 */
const URGENCY: Partial<Record<AiModule, number>> = { EQUIPMENT: 6, FORESIGHT: 5, STAFFING: 4, STAGING: 4, CAPACITY: 3, FRONT: 3, INBOUND: 3, EXPIRY: 2, SUBSTITUTION: 2, REPLENISH: 2, AVAILABILITY: 1, COUNT: 1, PICKING: 1, RETURNS: 1 };

/** 建议页的顺序（决策记录 0026）：标了紧急的、要执行的、模块越急越靠前；同样急的先到期的在前 */
export function recsByUrgency(s: OpsState): LiveRec[] {
  const score = (r: LiveRec) => (r.action.params?.urgent === true ? 10 : 0) + (r.action.kind === 'INFO' ? 0 : 3) + (URGENCY[r.module] ?? 0);
  return openRecs(s).sort((a, b) => score(b) - score(a) || a.expiresAt - b.expiresAt || b.issuedAt - a.issuedAt || a.id.localeCompare(b.id));
}

const emptyStats = (): AiModuleStats => ({ issued: 0, ACCEPTED: 0, OVERRIDDEN: 0, DISMISSED: 0, EXPIRED: 0, SUPERSEDED: 0, AUTO_APPLIED: 0, reasons: {} });

/** applyEvent 中 AI 相关的事件 */
export function applyAiEvent(s: OpsState, e: AnyOpsEvent): boolean {
  switch (e.type) {
    case 'RecommendationIssued': {
      const rec = e.payload.rec;
      s.recs[rec.id] = { ...rec, status: 'OPEN' };
      s.counters.recs++;
      (s.aiStats[rec.module] ??= emptyStats()).issued++;
      prune(s);
      return true;
    }
    case 'RecommendationResolved': {
      const r = s.recs[e.payload.recId];
      if (r) {
        r.status = e.payload.resolution;
        r.resolvedAt = e.at;
        r.resolvedBy = e.actor;
        if (e.payload.reason) r.reason = e.payload.reason;
        if (e.payload.note) r.note = e.payload.note;
        const st = (s.aiStats[r.module] ??= emptyStats());
        st[e.payload.resolution]++;
        if (e.payload.reason) st.reasons[e.payload.reason] = (st.reasons[e.payload.reason] ?? 0) + 1;
      }
      return true;
    }
    case 'AiModeSet': {
      s.aiModes[e.payload.module] = { mode: e.payload.mode, locked: e.payload.locked, at: e.at, by: e.actor, ...(e.payload.auto ? { auto: e.payload.auto } : {}) };
      // 自动降级后重新开始计数（带班负责人改回来之后要再攒够次数才会再降）
      const o = e.payload.auto ? s.aiStats[e.payload.module]?.outcomes : undefined;
      if (o) o.recent = [];
      return true;
    }
    case 'AiHealthPublished':
      s.aiHealth = e.payload.health;
      return true;
    case 'OutcomeRecorded': {
      const r = s.recs[e.payload.recId];
      const x = e.payload.outcome;
      if (r) r.outcome = x;
      const st = (s.aiStats[e.payload.module] ??= emptyStats());
      const o = (st.outcomes ??= { n: 0, hits: 0, realizedSum: 0, realizedN: 0, ctrlN: 0, ctrlHits: 0, brierSum: 0, brierN: 0, recent: [], gains: {} });
      if (x.adopted) {
        o.n++;
        if (x.hit) o.hits++;
        if (x.realized !== undefined) {
          o.realizedSum += x.realized;
          o.realizedN++;
        }
        if (x.kind !== 'CALIBRATION') o.recent = [...o.recent, x.hit ? 1 : 0].slice(-OUTCOME_RECENT_N);
        if (x.kind === 'EFFECT' && x.baseline !== undefined) {
          const g = (o.gains[x.metric] ??= { n: 0, predicted: 0, actual: 0 });
          g.n++;
          g.predicted += x.baseline - x.predicted;
          g.actual += x.baseline - x.actual;
        }
      } else {
        o.ctrlN++;
        if (x.hit) o.ctrlHits++;
      }
      if (x.unit === 'PROBABILITY' && (x.actual === 0 || x.actual === 1)) {
        o.brierSum += (x.predicted - x.actual) ** 2;
        o.brierN++;
      }
      return true;
    }
    case 'SubstitutionPicked': {
      // 替代推荐的采纳率：拣货员选了 AI 推荐的第一名记为采纳，选了其他候选记为否决
      const rank = e.payload.rank;
      if (rank !== undefined) {
        const st = (s.aiStats.SUBSTITUTION ??= emptyStats());
        st.issued++;
        if (rank === 1) st.ACCEPTED++;
        else st.OVERRIDDEN++;
      }
      return false;
    }
    case 'AiEtaApplied': {
      const o = s.orders[e.payload.orderId];
      if (o) o.aiEtaAt = e.payload.etaAt;
      return true;
    }
    default:
      return false;
  }
}

function prune(s: OpsState): void {
  const ids = Object.keys(s.recs);
  if (ids.length <= MAX_RECS) return;
  const closed = Object.values(s.recs)
    .filter((r) => r.status !== 'OPEN')
    .sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id));
  for (const r of closed.slice(0, ids.length - MAX_RECS)) delete s.recs[r.id];
}

// —— 视图 ——

/** 待处理的建议，最新的在前 */
export function openRecs(s: OpsState, module?: AiModule): LiveRec[] {
  return Object.values(s.recs)
    .filter((r) => r.status === 'OPEN' && (!module || r.module === module))
    .sort((a, b) => b.issuedAt - a.issuedAt || b.id.localeCompare(a.id));
}

/** 未完成的核对货架任务，最早的在前 */
export function openChecks(s: OpsState): ShelfCheck[] {
  return Object.values(s.checks)
    .filter((c) => c.status === 'OPEN')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** 最近处理过的建议，最新的在前 */
export function recentRecs(s: OpsState, limit = 20): LiveRec[] {
  return Object.values(s.recs)
    .filter((r) => r.status !== 'OPEN')
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

/** 效果追踪的汇总（决策记录 0022 · F4）：说到做到率、实现比例、对照组里问题真的发生的比例、Brier 分数；没有样本时为空 */
export function outcomeSummary(st: AiModuleStats | undefined): { n: number; hitRate?: number; realized?: number; ctrlN: number; ctrlRate?: number; brier?: number; gains: OutcomeStats['gains'] } | undefined {
  const o = st?.outcomes;
  if (!o || (!o.n && !o.ctrlN)) return undefined;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    n: o.n,
    ...(o.n ? { hitRate: r2(o.hits / o.n) } : {}),
    ...(o.realizedN ? { realized: r2(o.realizedSum / o.realizedN) } : {}),
    ctrlN: o.ctrlN,
    ...(o.ctrlN ? { ctrlRate: r2(o.ctrlHits / o.ctrlN) } : {}),
    ...(o.brierN ? { brier: Math.round((o.brierSum / o.brierN) * 1000) / 1000 } : {}),
    gains: o.gains,
  };
}

/** 采纳率：采纳 + 自动执行 占「有人处理过」的比例（过期与被取代的不计）；没有样本时为空 */
export function adoptionRate(st: AiModuleStats | undefined): number | undefined {
  if (!st) return undefined;
  const handled = st.ACCEPTED + st.AUTO_APPLIED + st.OVERRIDDEN + st.DISMISSED;
  return handled ? (st.ACCEPTED + st.AUTO_APPLIED) / handled : undefined;
}

