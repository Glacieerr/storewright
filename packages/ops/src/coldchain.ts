import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import { opaqueLabelId } from '@storewright/domain';
import type { LiveWalk, OpsState, StoreStatic, ToteInfo, WalkInfo, WalkStop } from './types';

/**
 * 冷链与分批、分框学习（决策记录 0023 · 第三批 B3、B7）。
 *
 * - 拆批（领取前）：AI 用拣货时长模型估计冷链批次从第一件到暂存的用时，超过时限的批次按订单拆成两个；
 * - 剩下的行转给别人（拣货中）：按现在的速度冷链会超时时，剩下没拣的行放进一个新批次（给这些订单补新框、打新标签），
 *   当前的拣货员先把已经拣好的框送回暂存；原来的框里一件都没拣的作废；
 * - 加一个框（拣货中）：框装满了，同一订单补一个框，这个框里还没拣的行挪过去；记下来用于学习；
 * - 分框系数：AI 从「加框」的记录学到每类商品实际占的体积比体积数据大多少，写进作业核心，锁单分框时用。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode, params?: Record<string, string | number>): Result => ({ ok: false, reject: params ? { code, params } : { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

type ColdCommand = Extract<OpsCommand, { type: 'HandOverLines' | 'AddTote' | 'FlagColdRisk' | 'UpdateToteFactors' }>;
export const COLD_COMMANDS = new Set<OpsCommand['type']>(['HandOverLines', 'AddTote', 'FlagColdRisk', 'UpdateToteFactors']);
export function isColdCommand(cmd: OpsCommand): cmd is ColdCommand {
  return COLD_COMMANDS.has(cmd.type);
}

/** 分框系数的范围（体积数据偏小到偏大） */
export const TOTE_FACTOR_RANGE = [0.8, 1.6] as const;

const pickKey = (toteId: string, lineId: string) => `${toteId}|${lineId}`;

/** 批次里还没做的拣货（件数） */
function undone(w: LiveWalk): Array<{ stop: number; toteId: string; lineId: string; qty: number }> {
  const out: Array<{ stop: number; toteId: string; lineId: string; qty: number }> = [];
  w.stops.forEach((st, i) => {
    for (const p of st.picks) {
      const left = p.qty - (w.done[pickKey(p.toteId, p.lineId)] ?? 0);
      if (left > 0) out.push({ stop: i, toteId: p.toteId, lineId: p.lineId, qty: left });
    }
  });
  return out;
}

/** 给订单补一个框：编号接着排，标签版本 1 */
function newTote(s: OpsState, orderId: string, tempZone: ToteInfo['tempZone'], chemical: boolean, dueAt: number, taken: Set<string>): ToteInfo {
  const o = s.orders[orderId];
  let k = (o?.toteIds.length ?? 0) + 1;
  while (s.totes[`${orderId}-T${k}`] || taken.has(`${orderId}-T${k}`)) k++;
  const id = `${orderId}-T${k}`;
  taken.add(id);
  return { id, orderId, tempZone, index: k, count: k, chemical, lines: [], dueAt };
}

/**
 * 领取前拆批：groups 是每个新批次的框；路线顺序保持不变（原路线的子序列），距离和标准用时按比例分。
 * 返回 undefined 表示批次已经被领取、或分组不合法。
 */
export function splitWalkEvents(s: OpsState, walkId: string, groups: readonly (readonly string[])[], recId?: string): PendingEvent[] | undefined {
  const w = s.walks[walkId];
  if (!w || w.status !== 'OPEN' || groups.length < 2) return undefined;
  const all = new Set(groups.flat());
  if (all.size !== w.toteIds.length || w.toteIds.some((id) => !all.has(id)) || groups.some((g) => !g.length)) return undefined;
  const totalStops = Math.max(1, w.stops.length);
  const totalUnits = Math.max(1, w.stops.reduce((n, st) => n + st.picks.reduce((m, p) => m + p.qty, 0), 0));
  let n = s.counters.walks;
  const walks: WalkInfo[] = groups.map((g) => {
    n += 1;
    const ids = new Set(g);
    const stops: WalkStop[] = w.stops.map((st) => ({ locationId: st.locationId, picks: st.picks.filter((p) => ids.has(p.toteId)) })).filter((st) => st.picks.length > 0);
    const units = stops.reduce((m, st) => m + st.picks.reduce((a, p) => a + p.qty, 0), 0);
    const dueAt = Math.min(...g.map((id) => s.totes[id]?.dueAt ?? w.dueAt));
    const out: WalkInfo = {
      id: `W${String(n).padStart(3, '0')}`,
      tempZone: w.tempZone,
      toteIds: [...g],
      stops,
      distanceM: Math.round((w.distanceM * stops.length) / totalStops),
      estimatedSec: Math.round((w.estimatedSec * units) / totalUnits),
      dueAt,
    };
    if (w.coldLimitSec !== undefined) out.coldLimitSec = w.coldLimitSec;
    if (w.track) out.track = w.track;
    if (w.priority) out.priority = true;
    return out;
  });
  return [ev('PickWalkSplit', { walkId, walks, ...(recId ? { recId } : {}) })];
}

/**
 * 剩下的行转给别人：没拣的行进新批次（每个订单补新框），原来的框里一件都没拣的作废。
 * 返回 undefined 表示没有剩下的行、或者批次不在拣货中。
 */
export function handOverEvents(s: OpsState, walkId: string, recId?: string): PendingEvent[] | undefined {
  const w = s.walks[walkId];
  if (!w || (w.status !== 'PICKING' && w.status !== 'CLAIMED')) return undefined;
  const rest = undone(w);
  if (!rest.length) return undefined;
  const taken = new Set<string>();
  // 每个原来的框对应一个新框（同订单、同温区）
  const map = new Map<string, ToteInfo>();
  for (const r of rest) {
    if (map.has(r.toteId)) continue;
    const t = s.totes[r.toteId];
    if (!t) return undefined;
    map.set(r.toteId, newTote(s, t.orderId, t.tempZone, t.chemical, t.dueAt, taken));
  }
  const stops: WalkStop[] = [];
  for (const r of rest) {
    const to = (map.get(r.toteId) as ToteInfo).id;
    const loc = w.stops[r.stop]?.locationId as string;
    let st = stops.find((x) => x.locationId === loc);
    if (!st) {
      st = { locationId: loc, picks: [] };
      stops.push(st);
    }
    st.picks.push({ toteId: to, lineId: r.lineId, qty: r.qty });
    const nt = map.get(r.toteId) as ToteInfo;
    const line = nt.lines.find((l) => l.lineId === r.lineId);
    if (line) line.qty += r.qty;
    else nt.lines.push({ lineId: r.lineId, qty: r.qty });
  }
  const totes = [...map.values()];
  const totalUnits = Math.max(1, w.stops.reduce((n, st) => n + st.picks.reduce((m, p) => m + p.qty, 0), 0));
  const units = rest.reduce((n, r) => n + r.qty, 0);
  const newWalk: WalkInfo = {
    id: `W${String(s.counters.walks + 1).padStart(3, '0')}`,
    tempZone: w.tempZone,
    toteIds: totes.map((t) => t.id),
    stops,
    distanceM: Math.round((w.distanceM * stops.length) / Math.max(1, w.stops.length)),
    estimatedSec: Math.round((w.estimatedSec * units) / totalUnits),
    dueAt: Math.min(...totes.map((t) => t.dueAt)),
    priority: true,
  };
  if (w.coldLimitSec !== undefined) newWalk.coldLimitSec = w.coldLimitSec;
  if (w.track) newWalk.track = w.track;
  // 原来的框里一件都没拣的：作废（标签作废，从订单里去掉）
  const emptied = w.toteIds.filter((id) => !w.stops.some((st) => st.picks.some((p) => p.toteId === id && (w.done[pickKey(p.toteId, p.lineId)] ?? 0) > 0)));
  const out: PendingEvent[] = [ev('WalkHandedOver', { walkId, newWalk, totes, emptied, ...(recId ? { recId } : {}) })];
  for (const t of totes) out.push(ev('LabelPrinted', { labelId: opaqueLabelId(t.id, 1), toteId: t.id, version: 1 }));
  return out;
}

export function decideCold(s: OpsState, env: CommandEnvelope & { cmd: ColdCommand }, _st: StoreStatic): Result {
  const { cmd, actor } = env;
  switch (cmd.type) {
    case 'HandOverLines': {
      const w = s.walks[cmd.walkId];
      if (!w) return no('WALK_NOT_FOUND');
      if (w.associateId !== actor) return no('WALK_NOT_YOURS');
      const out = handOverEvents(s, cmd.walkId);
      return out ? yes(out) : no('NOTHING_TO_HAND_OVER');
    }
    case 'AddTote': {
      const w = s.walks[cmd.walkId];
      if (!w) return no('WALK_NOT_FOUND');
      if (w.associateId !== actor) return no('WALK_NOT_YOURS');
      if (w.status === 'COMPLETED') return no('WALK_COMPLETED');
      const t = s.totes[cmd.toteId];
      if (!t || !w.toteIds.includes(t.id)) return no('TOTE_NOT_FOUND');
      const moves = undone(w).filter((r) => r.toteId === t.id);
      if (!moves.length) return no('NOTHING_TO_HAND_OVER');
      const nt = newTote(s, t.orderId, t.tempZone, t.chemical, t.dueAt, new Set());
      for (const m of moves) {
        const line = nt.lines.find((l) => l.lineId === m.lineId);
        if (line) line.qty += m.qty;
        else nt.lines.push({ lineId: m.lineId, qty: m.qty });
      }
      const labelId = opaqueLabelId(nt.id, 1);
      return yes([
        ev('TotesAdded', { orderId: t.orderId, walkId: w.id, reason: 'OVERFLOW', totes: [nt], moves: moves.map((m) => ({ lineId: m.lineId, from: t.id, to: nt.id, qty: m.qty })) }),
        ev('LabelPrinted', { labelId, toteId: nt.id, version: 1 }),
        // 现场：贴上新标签就放上推车（演示里直接绑定）
        ev('LabelBound', { labelId, walkId: w.id }),
      ]);
    }
    case 'FlagColdRisk': {
      if (actor !== 'ai' && actor !== 'system') return no('NOT_AUTHORIZED');
      const w = s.walks[cmd.walkId];
      if (!w || w.status === 'COMPLETED') return no('WALK_NOT_FOUND');
      if (!Number.isFinite(cmd.overSec)) return no('QTY_INVALID', { remaining: 0 });
      return yes([ev('ColdRiskFlagged', { walkId: w.id, overSec: Math.round(cmd.overSec), remainingLines: Math.max(0, Math.round(cmd.remainingLines)) })]);
    }
    case 'UpdateToteFactors': {
      if (actor !== 'ai' && actor !== 'system') return no('NOT_AUTHORIZED');
      const factors: Record<string, number> = {};
      for (const [k, v] of Object.entries(cmd.factors ?? {}).slice(0, 200)) if (typeof k === 'string' && Number.isFinite(v)) factors[k] = Math.round(Math.min(TOTE_FACTOR_RANGE[1], Math.max(TOTE_FACTOR_RANGE[0], v)) * 1000) / 1000;
      return yes([ev('ToteFactorsUpdated', { factors })]);
    }
  }
}

export function applyColdEvent(s: OpsState, e: AnyOpsEvent): boolean {
  switch (e.type) {
    case 'PickWalkSplit': {
      const old = s.walks[e.payload.walkId];
      if (!old) return true;
      delete s.walks[old.id];
      for (const w of e.payload.walks) {
        s.walks[w.id] = { ...w, status: 'OPEN', createdAt: e.at, bound: [], done: {} };
        s.counters.walks += 1;
        for (const id of w.toteIds) {
          const t = s.totes[id];
          if (t) t.walkId = w.id;
        }
      }
      return true;
    }
    case 'WalkHandedOver': {
      const w = s.walks[e.payload.walkId];
      const { newWalk, totes, emptied } = e.payload;
      if (w) {
        // 原批次只留下已经拣了的部分
        for (const st of w.stops) for (const p of st.picks) p.qty = Math.min(p.qty, w.done[pickKey(p.toteId, p.lineId)] ?? 0);
        w.stops = w.stops.map((st) => ({ ...st, picks: st.picks.filter((p) => p.qty > 0) })).filter((st) => st.picks.length > 0);
        w.toteIds = w.toteIds.filter((id) => !emptied.includes(id));
        w.bound = w.bound.filter((id) => !emptied.includes(id));
        delete w.coldRisk;
      }
      for (const id of emptied) {
        const t = s.totes[id];
        if (!t) continue;
        const o = s.orders[t.orderId];
        if (o) o.toteIds = o.toteIds.filter((x) => x !== id);
        if (t.labelId && s.labels[t.labelId]) (s.labels[t.labelId] as { voided: boolean }).voided = true;
        delete s.totes[id];
      }
      for (const t of totes) {
        s.totes[t.id] = { ...t, status: 'IN_WALK', walkId: newWalk.id, labelVersion: 0 };
        const o = s.orders[t.orderId];
        if (o && !o.toteIds.includes(t.id)) o.toteIds.push(t.id);
      }
      s.walks[newWalk.id] = { ...newWalk, status: 'OPEN', createdAt: e.at, bound: [], done: {} };
      s.counters.walks += 1;
      return true;
    }
    case 'TotesAdded': {
      const w = s.walks[e.payload.walkId];
      for (const t of e.payload.totes) {
        s.totes[t.id] = { ...t, status: 'IN_WALK', walkId: e.payload.walkId, labelVersion: 0 };
        const o = s.orders[t.orderId];
        if (o && !o.toteIds.includes(t.id)) o.toteIds.push(t.id);
        if (w && !w.toteIds.includes(t.id)) w.toteIds.push(t.id);
      }
      if (w)
        for (const m of e.payload.moves) {
          for (const st of w.stops) {
            const p = st.picks.find((x) => x.toteId === m.from && x.lineId === m.lineId);
            if (!p) continue;
            p.qty -= m.qty;
            const q = st.picks.find((x) => x.toteId === m.to && x.lineId === m.lineId);
            if (q) q.qty += m.qty;
            else st.picks.push({ toteId: m.to, lineId: m.lineId, qty: m.qty });
            st.picks = st.picks.filter((x) => x.qty > 0 || (w.done[pickKey(x.toteId, x.lineId)] ?? 0) > 0);
            break;
          }
          const from = s.totes[m.from];
          const line = from?.lines.find((l) => l.lineId === m.lineId);
          if (line) line.qty = Math.max(0, line.qty - m.qty);
        }
      s.overflows = (s.overflows ?? 0) + 1;
      return true;
    }
    case 'ColdRiskFlagged': {
      const w = s.walks[e.payload.walkId];
      if (w) w.coldRisk = { overSec: e.payload.overSec, remainingLines: e.payload.remainingLines, at: e.at };
      return true;
    }
    case 'ToteFactorsUpdated':
      s.toteFactors = e.payload.factors;
      return true;
    default:
      return false;
  }
}
