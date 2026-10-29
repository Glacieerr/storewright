import { planogramByItem } from './inventory';
import { dutyOf } from './roster';
import { avoidFrozen } from './safety';
import { currentRole, isBusy } from './staff';
import type { AssociateRole, OpsState, StoreStatic } from './types';

/**
 * 统一任务编排：每个人的「下一步」（决策记录 0024 · 第四批 D3）。
 *
 * 一个任务池：可领取的拣货批次、待暂存的框、到店等着交付的顾客、补货、后仓补取、核对货架、盘点。
 * 给某个人排「下一步」：紧急（离截止多近）× 价值（顾客在等 > 订单截止 > 补货 > 核对）÷ 预计用时，
 * 加上岗位和技能匹配（自己岗位的任务优先，跨岗位的要会这项技能）、就近（和上一次扫描的通道一样）、负荷（冷冻待久了少派冷冻批次）。
 * 只推荐，员工可以选别的；按「渐进」先在岗位内排，跨岗位的排在后面并标出来。不显示个人排名。
 */

export type TaskKind = 'WALK' | 'STAGE' | 'HANDOFF' | 'RESTOCK' | 'EXCEPTION' | 'CHECK' | 'COUNT';

export interface NextTask {
  kind: TaskKind;
  /** 任务的编号：批次、框、订单、补货任务…… */
  ref: string;
  /** 做这个任务的岗位 */
  role: AssociateRole;
  score: number;
  /** 截止时间、预计用时（分钟）、地点（通道或格位） */
  dueAt?: number;
  minutes: number;
  where?: string;
  /** 跨岗位（要会这项技能） */
  crossRole: boolean;
  /** 打分的理由（代码，界面翻译） */
  why: string[];
  /** 展示用：批次的温区和行数、订单短号、商品名 */
  label: Record<string, string | number>;
}

const ROLE_OF: Record<TaskKind, AssociateRole> = { WALK: 'PICK', STAGE: 'STAGE', HANDOFF: 'HANDOFF', RESTOCK: 'RESTOCK', EXCEPTION: 'BACKROOM', CHECK: 'RESTOCK', COUNT: 'BACKROOM' };
const VALUE: Record<TaskKind, number> = { HANDOFF: 10, WALK: 6, STAGE: 5, EXCEPTION: 5, RESTOCK: 3, CHECK: 2, COUNT: 1.5 };

/** 任务池（还没人做的） */
export function taskPool(s: OpsState, st: StoreStatic, now: number): Omit<NextTask, 'score' | 'crossRole' | 'why'>[] {
  const out: Omit<NextTask, 'score' | 'crossRole' | 'why'>[] = [];
  const plan = planogramByItem(st);
  for (const w of Object.values(s.walks)) {
    if (w.status !== 'OPEN' || w.track === 'AUTO') continue;
    const lines = w.stops.reduce((n, x) => n + x.picks.length, 0);
    out.push({ kind: 'WALK', ref: w.id, role: 'PICK', dueAt: w.dueAt, minutes: Math.max(1, Math.round((w.ai?.sec ?? w.estimatedSec) / 60)), where: w.stops[0]?.locationId.split('-').slice(0, 2).join('-'), label: { zone: w.tempZone, lines } });
  }
  for (const t of Object.values(s.totes)) {
    if (t.status !== 'PICKED') continue;
    const o = s.orders[t.orderId];
    if (!o || o.track === 'AUTO') continue;
    out.push({ kind: 'STAGE', ref: t.id, role: 'STAGE', dueAt: o.slotStart, minutes: 1, label: { zone: t.tempZone, order: o.shortCode } });
  }
  for (const o of Object.values(s.orders)) {
    if (o.arrivedAt === undefined || o.status === 'COMPLETED' || o.status === 'CANCELLED' || o.track === 'AUTO' || Object.values(s.sessions).some((x) => x.orderIds.includes(o.id) && x.status !== 'COMPLETED')) continue;
    if (o.status !== 'STAGED' && o.status !== 'READY') continue;
    out.push({ kind: 'HANDOFF', ref: o.id, role: 'HANDOFF', dueAt: o.arrivedAt, minutes: 4, ...(o.bay ? { where: o.bay } : {}), label: { order: o.shortCode, waiting: Math.max(0, Math.round((now - o.arrivedAt) / 60_000)) } });
  }
  for (const t of Object.values(s.repl)) {
    if (t.status !== 'OPEN') continue;
    out.push({ kind: 'RESTOCK', ref: t.id, role: 'RESTOCK', ...(t.dueAt !== undefined ? { dueAt: t.dueAt } : {}), minutes: 8, where: plan.get(t.itemId)?.runId, label: { item: plan.get(t.itemId)?.name ?? t.itemId, risk: Math.round((t.risk ?? 0) * 100) } });
  }
  for (const x of Object.values(s.exceptions)) if (x.status === 'OPEN') out.push({ kind: 'EXCEPTION', ref: x.id, role: 'BACKROOM', minutes: 6, label: { item: x.itemId } });
  for (const c of Object.values(s.checks)) if (c.status === 'OPEN') out.push({ kind: 'CHECK', ref: c.id, role: 'RESTOCK', minutes: 3, where: plan.get(c.itemId)?.runId, label: { item: plan.get(c.itemId)?.name ?? c.itemId } });
  for (const c of Object.values(s.counts)) if (c.status === 'OPEN') out.push({ kind: 'COUNT', ref: c.id, role: 'BACKROOM', minutes: 10, where: c.binCode, label: { bin: c.binCode } });
  return out;
}

/** 某个人的「下一步」：最多 limit 个，自己岗位的在前；手上已经有任务时不排 */
export function nextTasksFor(s: OpsState, st: StoreStatic, associateId: string, now: number, limit = 3): NextTask[] {
  const a = st.roster.find((x) => x.id === associateId);
  if (!a || a.role === 'LEAD' || isBusy(s, associateId) || !dutyOf(st, s, associateId, now).on) return [];
  const role = currentRole(st, s, associateId, now) ?? a.role;
  const skills = new Set([a.role, ...(a.skills ?? [])]);
  const near = s.activity[associateId]?.lastLocationId?.split('-').slice(0, 2).join('-');
  const coldTired = avoidFrozen(s, associateId, now);
  const out: NextTask[] = [];
  for (const t of taskPool(s, st, now)) {
    // 后仓补取只派给有永久授权的人（决策 X-01；流程梳理发现，决策记录 0025）
    if (t.kind === 'EXCEPTION' && !a.exceptionAuthorized) continue;
    const own = t.role === role || (role === 'RESTOCK' && t.role === 'BACKROOM' && skills.has('BACKROOM'));
    if (!own && !skills.has(t.role)) continue;
    const why: string[] = [];
    // 紧急：离截止越近越高（已经过了的最高）；没有截止时间的按 0.3
    const mins = t.dueAt !== undefined ? (t.dueAt - now) / 60_000 : undefined;
    const urgency = mins === undefined ? 0.3 : mins <= 0 ? 1.5 : Math.max(0.2, Math.min(1.2, 60 / (mins + 20)));
    if (mins !== undefined && mins <= 15) why.push(t.kind === 'HANDOFF' ? 'CUSTOMER_WAITING' : 'DUE_SOON');
    let score = (VALUE[t.kind] * urgency) / Math.sqrt(Math.max(1, t.minutes));
    if (own) why.push('YOUR_ROLE');
    else score *= 0.6;
    if (near && t.where && t.where === near) {
      score *= 1.25;
      why.push('NEARBY');
    }
    if (coldTired && t.kind === 'WALK' && t.label.zone === 'FROZEN') {
      score *= 0.3;
      why.push('FREEZER_REST');
    }
    if (t.kind === 'RESTOCK' && Number(t.label.risk) >= 50) {
      score *= 1.3;
      why.push('STOCKOUT_RISK');
    }
    out.push({ ...t, score: Math.round(score * 100) / 100, crossRole: !own, why });
  }
  // 自己岗位的在前（渐进：先在岗位内排），再按分数
  return out.sort((x, y) => Number(x.crossRole) - Number(y.crossRole) || y.score - x.score || x.ref.localeCompare(y.ref)).slice(0, limit);
}
