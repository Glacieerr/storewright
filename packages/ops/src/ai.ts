import { AI_MODES, AI_MODULES, DEFAULT_AI_MODES, OVERRIDE_REASONS, type AiMode, type AiModule, type Recommendation } from '@storewright/ai';
import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { AiModuleStats, AssociateRole, LiveRec, OpsState, ShelfCheck, StoreStatic } from './types';
import { canMove, isBusy, roleChangeEvent } from './staff';
import { openCountFor } from './inventory';

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
export const EXECUTABLE_ACTIONS = new Set<string>(['USE_AI_ETA', 'CHECK_SHELF', 'CREATE_COUNT', 'MOVE_ASSOCIATE', 'SET_MTO_START']);

/** 执行建议的动作：返回要追加的事件；对象已经不存在或已经结束时返回 undefined（动作过时） */
function actionEvents(s: OpsState, rec: Recommendation, st: StoreStatic): PendingEvent[] | undefined {
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
    case 'MOVE_ASSOCIATE': {
      const id = String(p.associateId ?? '');
      const to = String(p.to ?? '') as AssociateRole;
      // 锁定、手上有任务、已经在目标岗位、不允许的岗位：动作过时
      if (s.staffLocks[id] || isBusy(s, id) || canMove(st, s, id, to)) return undefined;
      return [roleChangeEvent(s, st, id, to, rec.id)];
    }
    case 'SET_MTO_START': {
      const t = s.mto[String(p.ticketId ?? '')];
      const startAt = Number(p.startAt);
      if (!t || t.status !== 'QUEUED' || !Number.isFinite(startAt)) return undefined;
      return [ev('MtoStartAdjusted', { ticketId: t.id, startAt, recId: rec.id })];
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

type AiCommand = Extract<OpsCommand, { type: 'IssueRecommendation' | 'AcceptRecommendation' | 'OverrideRecommendation' | 'DismissRecommendation' | 'SetAiMode' }>;

export const AI_COMMANDS = new Set<OpsCommand['type']>(['IssueRecommendation', 'AcceptRecommendation', 'OverrideRecommendation', 'DismissRecommendation', 'SetAiMode']);

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
      const mode = aiModeOf(s, d.module);
      const rec: Recommendation = { ...d, id: `REC-${String(s.counters.recs + 1).padStart(6, '0')}`, issuedAt: at, mode };
      if (EXECUTABLE_ACTIONS.has(d.action.kind) && !actionEvents(s, rec, st)) return no('ACTION_STALE');
      out.push(ev('RecommendationIssued', { rec }));
      if (mode === 'AUTO' && EXECUTABLE_ACTIONS.has(d.action.kind)) out.push(ev('RecommendationResolved', { recId: rec.id, resolution: 'AUTO_APPLIED' }), ...(actionEvents(s, rec, st) ?? []));
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
        if (!EXECUTABLE_ACTIONS.has(r.action.kind)) return yes([ev('RecommendationResolved', { recId: r.id, resolution: 'ACCEPTED' })]);
        const extra = actionEvents(s, r, st);
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
  }
}

/** Tick：过期的建议记为过期 */
export function aiTick(s: OpsState, at: number): PendingEvent[] {
  const out: PendingEvent[] = [];
  for (const r of Object.values(s.recs)) if (r.status === 'OPEN' && r.expiresAt <= at) out.push(ev('RecommendationResolved', { recId: r.id, resolution: 'EXPIRED' }));
  return out;
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
    case 'AiModeSet':
      s.aiModes[e.payload.module] = { mode: e.payload.mode, locked: e.payload.locked, at: e.at, by: e.actor };
      return true;
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

/** 采纳率：采纳 + 自动执行 占「有人处理过」的比例（过期与被取代的不计）；没有样本时为空 */
export function adoptionRate(st: AiModuleStats | undefined): number | undefined {
  if (!st) return undefined;
  const handled = st.ACCEPTED + st.AUTO_APPLIED + st.OVERRIDDEN + st.DISMISSED;
  return handled ? (st.ACCEPTED + st.AUTO_APPLIED) / handled : undefined;
}

