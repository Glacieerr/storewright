import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import { lotHit, planogramByItem, shelfNow } from './inventory';
import type { Incident, IncidentKind, OpsState, Recall, RecallStep, StoreStatic } from './types';

/**
 * 现场应对（决策记录 0024 · 第四批 C5、E4、E5）：
 * - 召回：人确认匹配到的商品后开启；货架、后仓箱、暂存和推车上的框、未完成和已交付的订单一次列出来；
 *   后仓的箱子马上转待检，线上拣货不能再拣这些商品（按找不到处理：替代或缺货）；下架、处理订单、通知顾客逐项打勾；
 * - 突发状况：停电、火警、系统故障、暴雨时，按岗位分好的清单（谁做什么），附开启时的影响（冷链框、接下来两小时的订单）；
 *   结束后按事件记录生成时间线；
 * - 食品安全记录：每天的温度、告警和处理、维修整理成表，店长确认。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode, params?: Record<string, string | number>): Result => ({ ok: false, reject: params ? { code, params } : { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

type FieldCommand = Extract<OpsCommand, { type: 'OpenRecall' | 'MarkRecallStep' | 'CloseRecall' | 'StartIncident' | 'CheckIncidentStep' | 'EndIncident' | 'ConfirmFoodSafetyLog' | 'LogAnswer' | 'RateAnswer' | 'AckSop' | 'NextTaskFeedback' }>;
export const FIELD_COMMANDS = new Set<OpsCommand['type']>(['OpenRecall', 'MarkRecallStep', 'CloseRecall', 'StartIncident', 'CheckIncidentStep', 'EndIncident', 'ConfirmFoodSafetyLog', 'LogAnswer', 'RateAnswer', 'AckSop', 'NextTaskFeedback']);
export function isFieldCommand(cmd: OpsCommand): cmd is FieldCommand {
  return FIELD_COMMANDS.has(cmd.type);
}

export const RECALL_STEPS: readonly RecallStep[] = ['SHELF', 'BACKROOM', 'STAGED', 'ORDERS', 'CUSTOMERS'];
export const INCIDENT_KINDS: readonly IncidentKind[] = ['POWER', 'FIRE', 'SYSTEM', 'STORM'];

/** 各种突发状况的清单：每一步给哪个岗位做（ALL 是所有人） */
export const INCIDENT_STEPS: Readonly<Record<IncidentKind, ReadonlyArray<{ id: string; role: 'LEAD' | 'PICK' | 'STAGE' | 'HANDOFF' | 'BACKROOM' | 'ALL' }>>> = {
  POWER: [
    { id: 'CALL_FACILITIES', role: 'LEAD' },
    { id: 'DECIDE_PAUSE', role: 'LEAD' },
    { id: 'CLOSE_COLD_DOORS', role: 'STAGE' },
    { id: 'LOG_TEMPS', role: 'BACKROOM' },
    { id: 'RETURN_COLD_TOTES', role: 'PICK' },
    { id: 'INFORM_CUSTOMERS', role: 'HANDOFF' },
  ],
  FIRE: [
    { id: 'CALL_EMERGENCY', role: 'LEAD' },
    { id: 'EVACUATE', role: 'ALL' },
    { id: 'GUIDE_CUSTOMERS', role: 'HANDOFF' },
    { id: 'HEADCOUNT', role: 'LEAD' },
    { id: 'NO_REENTRY', role: 'ALL' },
  ],
  SYSTEM: [
    { id: 'SWITCH_PAPER', role: 'LEAD' },
    { id: 'PRINT_PICKLISTS', role: 'PICK' },
    { id: 'MANUAL_HANDOFF_LOG', role: 'HANDOFF' },
    { id: 'HOLD_RECEIVING', role: 'BACKROOM' },
    { id: 'RECONCILE_AFTER', role: 'LEAD' },
  ],
  STORM: [
    { id: 'SECURE_DOCKS', role: 'BACKROOM' },
    { id: 'PRIORITIZE_PICKUPS', role: 'PICK' },
    { id: 'INFORM_CUSTOMERS', role: 'HANDOFF' },
    { id: 'CHECK_LOT', role: 'LEAD' },
  ],
};

/** 还开着的召回涉及的商品 */
export function recalledItems(s: OpsState): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(s.recalls ?? {})) if (r.status === 'OPEN') for (const id of r.itemIds) out.add(id);
  return out;
}

/**
 * 拣货要拦住的召回商品（决策记录 0026）：整个商品召回的一直拦；只召回部分批号的，货架下架完成后
 * 货架上剩下的是别的批号，可以照常拣（以前按整个商品拦，别的批号却照常补货）。
 */
export function pickBlockedItems(s: OpsState): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(s.recalls ?? {})) if (r.status === 'OPEN' && (!r.lots.length || !r.steps.SHELF)) for (const id of r.itemIds) out.add(id);
  return out;
}

/** 这一行拣进框里的可能是召回的批次：整个商品召回，或者在货架下架完成之前拣的 */
export function lineRecalled(s: OpsState, itemId: string, pickedAt: number | undefined): boolean {
  return Object.values(s.recalls ?? {}).some((r) => r.status === 'OPEN' && r.itemIds.includes(itemId) && (!r.lots.length || !r.steps.SHELF || pickedAt === undefined || pickedAt < r.steps.SHELF.at));
}

/** 召回涉及的框（还没交给顾客的）：在哪里、哪张订单、哪些商品（召回卡片上列出，决策记录 0026） */
export function recallTotes(s: OpsState, r: Recall): Array<{ toteId: string; orderId: string; shortCode: string; status: string; slotCode?: string; items: string[] }> {
  if (r.status !== 'OPEN') return [];
  const out: Array<{ toteId: string; orderId: string; shortCode: string; status: string; slotCode?: string; items: string[] }> = [];
  for (const t of Object.values(s.totes)) {
    if (t.status !== 'IN_WALK' && t.status !== 'BOUND' && t.status !== 'PICKED' && t.status !== 'STAGED' && t.status !== 'PULLED') continue;
    const o = s.orders[t.orderId];
    if (!o || o.status === 'CANCELLED' || o.status === 'COMPLETED') continue;
    const items = t.lines
      .map((l) => o.lines.find((x) => x.lineId === l.lineId))
      .filter((l): l is NonNullable<typeof l> => !!l && r.itemIds.includes(l.itemId) && (o.lineResults[l.lineId]?.picked ?? 0) > 0 && lineRecalled(s, l.itemId, o.lineResults[l.lineId]?.pickedAt))
      .map((l) => l.name);
    if (items.length) out.push({ toteId: t.id, orderId: o.id, shortCode: o.shortCode, status: t.status, ...(t.slotCode ? { slotCode: t.slotCode } : {}), items: [...new Set(items)] });
  }
  return out.sort((a, b) => a.shortCode.localeCompare(b.shortCode) || a.toteId.localeCompare(b.toteId));
}


export function activeIncident(s: OpsState): Incident | undefined {
  return Object.values(s.incidents ?? {}).find((x) => x.endedAt === undefined);
}

export function decideField(s: OpsState, env: CommandEnvelope & { cmd: FieldCommand }, st: StoreStatic, canManage: boolean): Result {
  const { cmd, actor, at } = env;
  switch (cmd.type) {
    case 'OpenRecall': {
      if (!canManage) return no('NOT_AUTHORIZED');
      const plan = planogramByItem(st);
      const itemIds = [...new Set(cmd.itemIds ?? [])].filter((id) => plan.has(id));
      if (!itemIds.length) return no('ITEM_NOT_FOUND');
      const lots = (cmd.lots ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean).slice(0, 20);
      const ids = new Set(itemIds);
      const shelf: Record<string, number> = {};
      for (const id of itemIds) {
        const p = plan.get(id);
        if (p) shelf[id] = Math.round(shelfNow(s, p).est);
      }
      const cases = Object.values(s.cases)
        .filter((c) => ids.has(c.itemId) && c.units > 0 && lotHit(lots, c.lot))
        .map((c) => c.id);
      const totes = Object.values(s.totes)
        .filter((t) => (t.status === 'IN_WALK' || t.status === 'BOUND' || t.status === 'PICKED' || t.status === 'STAGED') && t.lines.some((l) => ids.has(s.orders[t.orderId]?.lines.find((x) => x.lineId === l.lineId)?.itemId ?? '')))
        .map((t) => t.id);
      const withItem = (o: (typeof s.orders)[string]) => o.lines.some((l) => ids.has(l.itemId));
      const openOrders = Object.values(s.orders).filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && withItem(o)).map((o) => o.id);
      const doneOrders = Object.values(s.orders).filter((o) => o.status === 'COMPLETED' && (o.completedAt ?? 0) >= at - 30 * 86_400_000 && withItem(o)).map((o) => o.id);
      const n = Object.keys(s.recalls ?? {}).length + 1;
      const recall: Recall = {
        id: `RC${String(n).padStart(3, '0')}`,
        title: String(cmd.title ?? '').slice(0, 120),
        itemIds,
        lots,
        openedAt: at,
        by: actor,
        status: 'OPEN',
        steps: {},
        affected: { shelf, cases, totes, openOrders, doneOrders },
        ...(cmd.reason ? { reason: String(cmd.reason).slice(0, 40) } : {}),
        ...(cmd.from ? { from: cmd.from } : {}),
        ...(cmd.to ? { to: cmd.to } : {}),
      };
      return yes([ev('RecallOpened', { recall })]);
    }
    case 'MarkRecallStep': {
      const r = s.recalls?.[cmd.recallId];
      if (!r) return no('RECALL_NOT_FOUND');
      if (r.status !== 'OPEN') return no('RECALL_CLOSED');
      if (!RECALL_STEPS.includes(cmd.step)) return no('RECALL_NOT_FOUND');
      // 通知顾客、处理订单只由带班负责人或门店管理员确认
      if ((cmd.step === 'CUSTOMERS' || cmd.step === 'ORDERS') && !canManage) return no('NOT_AUTHORIZED');
      if (!!r.steps[cmd.step] === !!cmd.done) return yes([]);
      const out: PendingEvent[] = [ev('RecallStepMarked', { recallId: r.id, step: cmd.step, done: !!cmd.done })];
      // 只召回部分批号、货架上又没有批次记录（决策记录 0026）：不知道拿走了几件，给补货员一个「数一下剩下的」任务（别的批号）
      if (cmd.step === 'SHELF' && cmd.done && r.lots.length) {
        const plan = planogramByItem(st);
        let k = 0;
        for (const id of r.itemIds) {
          const p = plan.get(id);
          if (!p || s.shelfLots?.[id]?.length || Object.values(s.checks).some((c) => c.itemId === id && c.status === 'OPEN')) continue;
          out.push(ev('ShelfCheckRequested', { checkId: `SC${String(s.counters.checks + 1 + k).padStart(4, '0')}`, itemId: id, locationId: p.locationId, reason: 'RECALL' }));
          k++;
        }
      }
      return yes(out);
    }
    case 'CloseRecall': {
      if (!canManage) return no('NOT_AUTHORIZED');
      const r = s.recalls?.[cmd.recallId];
      if (!r) return no('RECALL_NOT_FOUND');
      if (r.status !== 'OPEN') return yes([]);
      // 五步都做完才能关（决策记录 0026）
      const open = RECALL_STEPS.filter((x) => !r.steps[x]);
      if (open.length) return no('RECALL_STEPS_OPEN', { steps: open.join(',') });
      return yes([ev('RecallClosed', { recallId: r.id })]);
    }
    case 'StartIncident': {
      if (!canManage) return no('NOT_AUTHORIZED');
      if (!INCIDENT_KINDS.includes(cmd.kind)) return no('INCIDENT_NOT_FOUND');
      if (activeIncident(s)) return no('INCIDENT_ACTIVE');
      const cold = Object.values(s.totes).filter((t) => t.status === 'STAGED' && (t.tempZone === 'CHILLED' || t.tempZone === 'FROZEN'));
      const incident: Incident = {
        id: `IN${String(Object.keys(s.incidents ?? {}).length + 1).padStart(3, '0')}`,
        kind: cmd.kind,
        startedAt: at,
        by: actor,
        checked: {},
        impact: {
          coldTotes: cold.filter((t) => t.tempZone === 'CHILLED').length,
          frozenTotes: cold.filter((t) => t.tempZone === 'FROZEN').length,
          coldCases: Object.values(s.cases).filter((c) => c.units > 0 && planogramByItem(st).get(c.itemId)?.tempZone !== 'AMBIENT' && planogramByItem(st).get(c.itemId)?.tempZone !== undefined).length,
          ordersSoon: Object.values(s.orders)
            .filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && o.slotStart >= at - 30 * 60_000 && o.slotStart <= at + 2 * 3_600_000)
            .map((o) => o.id),
        },
      };
      return yes([ev('IncidentStarted', { incident })]);
    }
    case 'CheckIncidentStep': {
      const x = s.incidents?.[cmd.incidentId];
      if (!x) return no('INCIDENT_NOT_FOUND');
      if (x.endedAt !== undefined) return no('INCIDENT_NOT_FOUND');
      if (!INCIDENT_STEPS[x.kind].some((p) => p.id === cmd.stepId)) return no('INCIDENT_NOT_FOUND');
      if (x.checked[cmd.stepId]) return yes([]);
      return yes([ev('IncidentStepChecked', { incidentId: x.id, stepId: cmd.stepId })]);
    }
    case 'EndIncident': {
      if (!canManage) return no('NOT_AUTHORIZED');
      const x = s.incidents?.[cmd.incidentId];
      if (!x) return no('INCIDENT_NOT_FOUND');
      if (x.endedAt !== undefined) return yes([]);
      return yes([ev('IncidentEnded', { incidentId: x.id })]);
    }
    // 「下一步」的反馈（谁做谁记）
    case 'NextTaskFeedback': {
      if (!['WALK', 'STAGE', 'HANDOFF', 'RESTOCK', 'EXCEPTION', 'CHECK', 'COUNT'].includes(cmd.kind)) return no('INVALID_ORDER');
      return yes([ev('NextTaskFeedback', { kind: cmd.kind, ref: String(cmd.ref).slice(0, 40), taken: !!cmd.taken })]);
    }
    // 现场操作提示看过了（谁看谁记）
    case 'AckSop': {
      if (!/^[a-z0-9-]{2,40}$/.test(cmd.sopId)) return no('INVALID_ORDER');
      const quiz = Number.isInteger(cmd.total) && (cmd.total as number) > 0 && Number.isInteger(cmd.correct) ? { correct: Math.max(0, Math.min(cmd.total as number, cmd.correct as number)), total: cmd.total as number } : {};
      return yes([ev('SopAcknowledged', { sopId: cmd.sopId, ...quiz })]);
    }
    // 门店助手的问答记录（AI 服务写）与「有用 / 没用」（提问的人或带班负责人）
    case 'LogAnswer': {
      if (actor !== 'ai' && actor !== 'system') return no('NOT_AUTHORIZED');
      return yes([ev('AnswerLogged', { answerId: String(cmd.answerId).slice(0, 20), question: String(cmd.question ?? '').slice(0, 200), tools: (cmd.tools ?? []).slice(0, 5).map(String), source: String(cmd.source ?? ''), by: String(cmd.by ?? '') })]);
    }
    case 'RateAnswer': {
      const a = s.answers?.[cmd.answerId];
      if (!a) return no('ANSWER_NOT_FOUND');
      if (a.by !== actor && !canManage) return no('NOT_YOURS');
      if (a.helpful === !!cmd.helpful) return yes([]);
      return yes([ev('AnswerRated', { answerId: cmd.answerId, helpful: !!cmd.helpful })]);
    }
    case 'ConfirmFoodSafetyLog': {
      if (!canManage) return no('NOT_AUTHORIZED');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cmd.date)) return no('INVALID_ORDER');
      return yes([ev('FoodSafetyLogConfirmed', { date: cmd.date, ...(cmd.note ? { note: String(cmd.note).slice(0, 300) } : {}) })]);
    }
  }
}

export function applyFieldEvent(s: OpsState, e: AnyOpsEvent, st?: StoreStatic): boolean {
  switch (e.type) {
    case 'RecallOpened': {
      const r = e.payload.recall;
      // 开启时已经做了的、没有要做的步骤直接打勾（决策记录 0026）：后仓的箱子马上转待检；没有框、订单、顾客的那一步
      const auto = { at: e.at, by: e.actor, auto: true };
      (s.recalls ??= {})[r.id] = {
        ...r,
        steps: { BACKROOM: auto, ...(r.affected.totes.length ? {} : { STAGED: auto }), ...(r.affected.openOrders.length ? {} : { ORDERS: auto }), ...(r.affected.doneOrders.length ? {} : { CUSTOMERS: auto }) },
      };
      // 后仓的箱子马上转待检（不能再补上货架）
      for (const id of r.affected.cases) {
        const c = s.cases[id];
        if (c && c.status === 'SELLABLE') c.status = 'QA';
      }
      return true;
    }
    case 'RecallStepMarked': {
      const r = s.recalls?.[e.payload.recallId];
      if (!r) return true;
      if (e.payload.done) r.steps[e.payload.step] = { at: e.at, by: e.actor };
      else delete r.steps[e.payload.step];
      // 货架下架完成：整个商品召回的货架存量清零；只召回部分批号的减去那几个批次的件数（决策记录 0026），批次记录去掉；
      // 货架上没有批次记录时不知道拿走了几件：存量不动、把握降低，同时请补货员数一下剩下的（见 MarkRecallStep）
      if (e.payload.step === 'SHELF' && e.payload.done)
        for (const id of r.itemIds) {
          const lots = s.shelfLots?.[id] ?? [];
          const pulled = lots.filter((l) => lotHit(r.lots, l.lot)).reduce((n, l) => n + l.units, 0);
          const sh = s.shelf[id];
          const unknown = r.lots.length > 0 && !lots.length;
          if (sh) {
            sh.est = r.lots.length ? Math.max(0, sh.est - pulled) : 0;
            if (unknown) sh.conf = Math.min(sh.conf, 0.3);
            sh.at = e.at;
          } else if (st) {
            const p = planogramByItem(st).get(id);
            if (p) s.shelf[id] = { est: r.lots.length ? Math.max(0, p.capacity - pulled) : 0, conf: unknown ? 0.3 : 1, source: 'SCAN', at: e.at, velocity: p.baseVelocity };
          }
          if (s.shelfLots?.[id]) s.shelfLots[id] = lots.filter((l) => !lotHit(r.lots, l.lot));
        }
      return true;
    }
    case 'RecallClosed': {
      const r = s.recalls?.[e.payload.recallId];
      if (r) {
        r.status = 'CLOSED';
        r.closedAt = e.at;
      }
      return true;
    }
    case 'IncidentStarted':
      (s.incidents ??= {})[e.payload.incident.id] = { ...e.payload.incident, checked: {} };
      return true;
    case 'IncidentStepChecked': {
      const x = s.incidents?.[e.payload.incidentId];
      if (x) x.checked[e.payload.stepId] = { at: e.at, by: e.actor };
      return true;
    }
    case 'IncidentEnded': {
      const x = s.incidents?.[e.payload.incidentId];
      if (x) x.endedAt = e.at;
      return true;
    }
    case 'NextTaskFeedback': {
      const x = ((s.nextTaskStats ??= {})[e.payload.kind] ??= { taken: 0, skipped: 0 });
      if (e.payload.taken) x.taken++;
      else x.skipped++;
      return true;
    }
    case 'SopAcknowledged':
      ((s.sopAcks ??= {})[e.actor] ??= {})[e.payload.sopId] = { at: e.at, ...(e.payload.total ? { correct: e.payload.correct ?? 0, total: e.payload.total } : {}) };
      return true;
    case 'AnswerLogged': {
      const p = e.payload;
      const all = (s.answers ??= {});
      all[p.answerId] = { q: p.question, tools: p.tools, source: p.source, at: e.at, by: p.by };
      const st2 = (s.answerStats ??= { answered: 0, helpful: 0, unhelpful: 0 });
      st2.answered++;
      const ids = Object.keys(all);
      if (ids.length > 200) for (const id of ids.sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0)).slice(0, ids.length - 200)) delete all[id];
      return true;
    }
    case 'AnswerRated': {
      const a = s.answers?.[e.payload.answerId];
      const st2 = (s.answerStats ??= { answered: 0, helpful: 0, unhelpful: 0 });
      if (a) {
        if (a.helpful === true) st2.helpful--;
        if (a.helpful === false) st2.unhelpful--;
        a.helpful = e.payload.helpful;
        if (a.helpful) st2.helpful++;
        else st2.unhelpful++;
      }
      return true;
    }
    case 'FoodSafetyLogConfirmed':
      (s.foodSafety ??= {})[e.payload.date] = { at: e.at, by: e.actor, ...(e.payload.note ? { note: e.payload.note } : {}) };
      return true;
    default:
      return false;
  }
}
