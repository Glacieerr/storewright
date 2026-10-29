import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import { planogramByItem, sellableCases, shelfNow, usableCases } from './inventory';
import type { LiveWalk, OpsState, StoreStatic } from './types';

/**
 * 门店 AI 第二轮的作业侧（决策记录 0021）：AI 服务写进事件流的估计和标记。
 *
 * - 批次的 AI 预计用时（拣货时长预测）：推演、调度、拣货清单都用它；
 * - 订单量展望：每小时的预计订单数（已按今天的实际修正），推演和补货优先级用它；
 * - 缺货预判：拣货清单上「多半缺货」的行，后仓有货时先安排补上（拣货员走到之前），没有时提前排好替代；
 * - 运营预警采纳后的动作：加急订单、冷冻商品晚点拣、通知顾客延后。
 * 只有 AI 服务（ai / system）可以发出估计和标记；员工和控制台不能伪造。写进事件流的好处：
 * 回放到过去时，看到的是当时 AI 知道的东西。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode, params?: Record<string, string | number>): Result => ({ ok: false, reject: params ? { code, params } : { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

type AssistCommand = Extract<OpsCommand, { type: 'EstimateWalk' | 'PublishOutlook' | 'FlagWalkLines' | 'RequestPrepick' }>;
export const ASSIST_COMMANDS = new Set<OpsCommand['type']>(['EstimateWalk', 'PublishOutlook', 'FlagWalkLines', 'RequestPrepick']);
export function isAssistCommand(cmd: OpsCommand): cmd is AssistCommand {
  return ASSIST_COMMANDS.has(cmd.type);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function decideAssist(s: OpsState, env: CommandEnvelope & { cmd: AssistCommand }, st: StoreStatic): Result {
  const { cmd, actor, at } = env;
  if (actor !== 'ai' && actor !== 'system') return no('NOT_AUTHORIZED');
  switch (cmd.type) {
    case 'EstimateWalk': {
      const w = s.walks[cmd.walkId];
      if (!w) return no('WALK_NOT_FOUND');
      if (w.status === 'COMPLETED') return no('WALK_COMPLETED');
      const e = cmd.estimate;
      if (!finite(e.sec) || e.sec <= 0 || !finite(e.low) || !finite(e.high) || typeof e.model !== 'string') return no('INVALID_RECOMMENDATION');
      return yes([ev('PickWalkEstimated', { walkId: w.id, estimate: { ...e, sec: Math.round(e.sec), low: Math.round(e.low), high: Math.round(e.high), at } })]);
    }
    case 'PublishOutlook': {
      const o = cmd.outlook;
      if (!Array.isArray(o.hours) || o.hours.length > 48 || !o.hours.every((h) => finite(h.t) && finite(h.mean) && h.mean >= 0) || !finite(o.correction) || typeof o.model !== 'string') return no('INVALID_RECOMMENDATION');
      return yes([ev('DemandOutlookPublished', { outlook: { ...o, at } })]);
    }
    case 'FlagWalkLines': {
      const w = s.walks[cmd.walkId];
      if (!w) return no('WALK_NOT_FOUND');
      if (w.status === 'COMPLETED') return no('WALK_COMPLETED');
      const keys = new Set(w.stops.flatMap((x) => x.picks.map((p) => `${p.toteId}|${p.lineId}`)));
      const flags = Object.fromEntries(Object.entries(cmd.flags ?? {}).filter(([k, f]) => keys.has(k) && finite(f.p) && f.p >= 0 && f.p <= 1));
      if (!Object.keys(flags).length) return yes([]);
      return yes([ev('WalkLinesFlagged', { walkId: w.id, flags })]);
    }
    case 'RequestPrepick': {
      const p = planogramByItem(st).get(cmd.itemId);
      if (!p) return no('ITEM_NOT_FOUND');
      if (!s.walks[cmd.walkId]) return no('WALK_NOT_FOUND');
      // 已经有补货任务（例如低库存任务）：还没人领取就把它提前（截止时间、排到最前），已经有人在做就不用动
      const existing = Object.values(s.repl).find((t) => t.itemId === p.itemId && (t.status === 'OPEN' || t.status === 'CLAIMED'));
      if (existing) {
        if (existing.status !== 'OPEN' || (existing.dueAt !== undefined && existing.dueAt <= cmd.dueAt)) return yes([]);
        return yes([ev('ReplenishmentExpedited', { taskId: existing.id, dueAt: Math.round(cmd.dueAt) })]);
      }
      // 后仓没有可售的箱子、或记录可疑时不能安排
      if (s.suspect[p.itemId] !== undefined || !usableCases(s, p.itemId).length) return no('NO_BACKROOM_STOCK');
      const sh = shelfNow(s, p);
      return yes([
        ev('ReplenishmentTaskCreated', {
          taskId: `RP${String(s.counters.repl + 1).padStart(4, '0')}`,
          locationId: p.locationId,
          itemId: p.itemId,
          area: p.runId,
          reason: 'PREPICK',
          suggestedUnits: Math.max(1, Math.round(p.capacity - Math.max(0, sh.est))),
          priority: 0,
          dueAt: Math.round(cmd.dueAt),
        }),
      ]);
    }
  }
}

/** applyEvent 中这一部分的事件 */
export function applyAssistEvent(s: OpsState, e: AnyOpsEvent): boolean {
  switch (e.type) {
    case 'PickWalkEstimated': {
      const w = s.walks[e.payload.walkId];
      if (w) w.ai = e.payload.estimate;
      return true;
    }
    case 'DemandOutlookPublished':
      s.outlook = e.payload.outlook;
      return true;
    case 'ReplenishmentExpedited': {
      const t = s.repl[e.payload.taskId];
      if (t) {
        t.dueAt = e.payload.dueAt;
        t.priority = 0;
      }
      return true;
    }
    case 'WalkLinesFlagged': {
      const w = s.walks[e.payload.walkId];
      if (w) w.flags = { ...(w.flags ?? {}), ...e.payload.flags };
      return true;
    }
    case 'OrdersExpedited': {
      for (const id of e.payload.orderIds) {
        const o = s.orders[id];
        if (o) o.expedite = true;
      }
      // 已经生成的批次里含这些订单的，排到最前面
      const set = new Set(e.payload.orderIds);
      for (const w of Object.values(s.walks)) if (w.status !== 'COMPLETED' && w.toteIds.some((t) => set.has(s.totes[t]?.orderId ?? ''))) w.priority = true;
      return true;
    }
    case 'FrozenDeferred': {
      for (const id of e.payload.orderIds) {
        const o = s.orders[id];
        if (o) o.frozenAfter = e.payload.until;
      }
      return true;
    }
    case 'DelayNoticeSent': {
      for (const id of e.payload.orderIds) {
        const o = s.orders[id];
        if (!o) continue;
        o.delayNoticeAt = e.at;
        o.delayMin = e.payload.minutes;
      }
      return true;
    }
    default:
      return false;
  }
}

/** 拣货清单的顺序：优先的批次在前，再按应备好时间 */
export function walkOrder(a: LiveWalk, b: LiveWalk): number {
  return (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || a.dueAt - b.dueAt || a.id.localeCompare(b.id);
}
