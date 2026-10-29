import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import { isBusy, roleOf } from './staff';
import { freezerMinutes, SAFETY_RULES, workedSinceBreak } from './safety';
import { dutyOf } from './roster';
import { rolesForSensor } from './alerts';
import { planogramByItem } from './inventory';
import type { AssociateRole, Nudge, NudgeKind, OpsState, StoreStatic } from './types';

/**
 * 建议中枢（决策记录 0021 · 第一批 G1，含 E2 告警合并与升级）。
 *
 * 门店 AI 的每个想法最后都要变成某个人手机上的一条提醒；提醒太多就等于没有提醒。这里把所有来源
 * （AI 建议、设备告警、核对和补货任务、后仓补取、冷链超时）放在一起决定「发给谁、什么时候发、合不合并」：
 * - 打分：重要程度 × 把握；紧急的（问题半小时内就会发生、严重告警、冷链超时）不受下面的限制；
 * - 路由：建议给在岗的带班负责人；告警按设备给对应岗位；任务给对应岗位在岗的人；冷链超时给正在拣的人；
 * - 时机：正在交付、核验取货码、冷链计时快到的人，非紧急提醒等这一步做完再发；营业时间外只发紧急的；
 * - 合并：同一货架段的任务、同一台设备、同一个模块的建议合成一条；几台冷柜同时超温合成一条（可能是停电）；
 * - 预算：每人每小时最多 3 条非紧急提醒，超出的先排队；同一个模块的建议 10 分钟内最多提醒一次（新的估计取代旧的建议时不重复提醒）；
 * - 升级：严重告警 5 分钟没人确认，提醒门店管理员（控制台）。
 * 提醒写进事件流（谁、什么时候、关于什么），所以每人每小时被提醒几次、多久处理，都可以统计和回放。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode): Result => ({ ok: false, reject: { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

export const MAX_NUDGES = 300;
const HOUR = 3_600_000;
/** 同一个模块的建议多久内只提醒一次 */
export const REC_REPEAT_MS = 10 * 60_000;

type NudgeCommand = Extract<OpsCommand, { type: 'SendNudges' | 'CloseNudges' | 'ReadNudge' }>;
export const NUDGE_COMMANDS = new Set<OpsCommand['type']>(['SendNudges', 'CloseNudges', 'ReadNudge']);
export function isNudgeCommand(cmd: OpsCommand): cmd is NudgeCommand {
  return NUDGE_COMMANDS.has(cmd.type);
}

const KINDS: readonly NudgeKind[] = ['REC', 'ALERT', 'TASK', 'ESCALATION', 'COLD', 'OFFER', 'NOTICE', 'SAFETY'];

export function decideNudge(s: OpsState, env: CommandEnvelope & { cmd: NudgeCommand }, st: StoreStatic): Result {
  const { cmd, actor, at } = env;
  const all = s.nudges ?? {};
  if (cmd.type === 'ReadNudge') {
    const n = all[cmd.nudgeId];
    if (!n) return no('NUDGE_NOT_FOUND');
    if (n.to !== actor) return no('NOT_YOURS');
    if (n.status !== 'SENT') return yes([]);
    return yes([ev('NudgeRead', { nudgeId: n.id })]);
  }
  if (actor !== 'ai' && actor !== 'system') return no('NOT_AUTHORIZED');
  if (cmd.type === 'CloseNudges') {
    const ids = (cmd.ids ?? []).filter((id) => all[id] && (all[id]?.status === 'SENT' || all[id]?.status === 'READ'));
    return yes(ids.length ? [ev('NudgesClosed', { ids, status: cmd.status === 'DONE' ? 'DONE' : 'EXPIRED' })] : []);
  }
  const valid = (cmd.nudges ?? []).filter((n) => KINDS.includes(n.kind) && typeof n.to === 'string' && (n.to === 'console' || st.roster.some((a) => a.id === n.to)) && Array.isArray(n.refs) && n.refs.length > 0);
  if (!valid.length) return yes([]);
  let k = s.counters.nudges ?? 0;
  const nudges: Nudge[] = valid.map((n) => {
    k += 1;
    return { ...n, refs: n.refs.slice(0, 20), id: `N${String(k).padStart(6, '0')}`, createdAt: at, status: 'SENT' };
  });
  return yes([ev('NudgesSent', { nudges })]);
}

export function applyNudgeEvent(s: OpsState, e: AnyOpsEvent): boolean {
  switch (e.type) {
    case 'NudgesSent': {
      const all = (s.nudges ??= {});
      for (const n of e.payload.nudges) all[n.id] = { ...n };
      s.counters.nudges = (s.counters.nudges ?? 0) + e.payload.nudges.length;
      prune(s);
      return true;
    }
    case 'NudgesClosed': {
      for (const id of e.payload.ids) {
        const n = s.nudges?.[id];
        if (n && (n.status === 'SENT' || n.status === 'READ')) {
          n.status = e.payload.status;
          n.closedAt = e.at;
        }
      }
      return true;
    }
    case 'NudgeRead': {
      const n = s.nudges?.[e.payload.nudgeId];
      if (n && n.status === 'SENT') {
        n.status = 'READ';
        n.readAt = e.at;
      }
      return true;
    }
    default:
      return false;
  }
}

function prune(s: OpsState): void {
  const all = s.nudges ?? {};
  const ids = Object.keys(all);
  if (ids.length <= MAX_NUDGES) return;
  const closed = Object.values(all)
    .filter((n) => n.status === 'DONE' || n.status === 'EXPIRED')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const n of closed.slice(0, ids.length - MAX_NUDGES)) delete all[n.id];
}

// ---------------------------------------------------------------------------
// 计划：这一轮该发哪些提醒、关哪些提醒

export interface NudgeCandidate {
  to: string;
  kind: NudgeKind;
  refs: string[];
  topic: string;
  params?: Record<string, string | number>;
  priority: number;
  urgent: boolean;
}

export interface NudgePlanOptions {
  /** 每人每小时最多几条非紧急提醒 */
  budgetPerHour?: number;
  /** 严重告警多少分钟没人确认就升级 */
  escalateAfterMin?: number;
  /** 营业时间（当地小时，[open, close)）；不给时全天都算营业时间 */
  hours?: { open: number; close: number };
}

export interface NudgePlan {
  send: NudgeCandidate[];
  close: Array<{ id: string; status: 'DONE' | 'EXPIRED' }>;
  /** 这一轮先不发的：谁、哪类、为什么（正在交付 / 冷链计时快到 / 超出预算 / 营业时间外） */
  deferred: Array<{ to: string; topic: string; why: 'BUSY' | 'BUDGET' | 'NIGHT' }>;
}

/** 各模块建议的重要程度（乘以把握就是提醒的优先级） */
const REC_WEIGHT: Partial<Record<string, number>> = { FORESIGHT: 3, EQUIPMENT: 3, STAFFING: 2.5, INBOUND: 2, CAPACITY: 2, STAGING: 2, EXPIRY: 1.5, AVAILABILITY: 1.5, PICKING: 1, COUNT: 1, ETA: 0.5 };

export { rolesForSensor };

/** 正在交付（准备、核验取货码、交给顾客）：非紧急提醒等这一步做完 */
export function inHandoff(s: OpsState, associateId: string): boolean {
  return Object.values(s.sessions).some((x) => x.status !== 'COMPLETED' && (x.owner === associateId || x.helpers.includes(associateId)));
}

/** 冷链计时快到（超过时限的 80%）：非紧急提醒也先不打扰 */
function coldRush(s: OpsState, associateId: string, now: number): boolean {
  return Object.values(s.walks).some((w) => w.associateId === associateId && w.status === 'PICKING' && w.coldStartedAt !== undefined && w.coldLimitSec !== undefined && (now - w.coldStartedAt) / 1000 >= 0.8 * w.coldLimitSec);
}

/** 此刻在岗（按发布的排班，决策记录 0022）、岗位符合的人；岗位：临时调动 > 排班里的岗位 > 名单上的岗位 */
function people(st: StoreStatic, s: OpsState, now: number, pred: (role: AssociateRole | undefined, home: AssociateRole) => boolean): string[] {
  return st.roster
    .filter((a) => {
      const d = dutyOf(st, s, a.id, now);
      return d.on && pred(s.roles[a.id] ?? d.role ?? roleOf(st, s, a.id), a.role);
    })
    .map((a) => a.id);
}

/** 这一轮所有可能的提醒（还没去重、没看预算） */
export function nudgeCandidates(s: OpsState, st: StoreStatic, now: number, opts: NudgePlanOptions = {}): NudgeCandidate[] {
  const out: NudgeCandidate[] = [];
  const leads = people(st, s, now, (_r, home) => home === 'LEAD');
  // 1. AI 建议（只提醒可以执行的；纯信息类在 AI 页里看）
  for (const r of Object.values(s.recs)) {
    if (r.status !== 'OPEN' || (r.action.kind === 'INFO' && r.action.params?.nudge !== true)) continue;
    const urgent = r.action.params?.urgent === true;
    // 「只显示」的模块不提醒（紧急的除外，决策记录 0026）：在 AI 页里看
    if (r.mode === 'SHOW' && !urgent) continue;
    const priority = Math.round((REC_WEIGHT[r.module] ?? 1) * r.confidence * 100) / 100;
    for (const to of leads) out.push({ to, kind: 'REC', refs: [r.id], topic: `REC:${r.module}`, params: { module: r.module }, priority, urgent });
  }
  // 2. 设备告警：几台冷柜同时超温合成一条（可能是停电或同一条线路），其余按设备
  const active = Object.values(s.alerts ?? {}).filter((a) => a.status === 'ACTIVE');
  const hot = active.filter((a) => a.kind === 'TEMP_HIGH' || a.kind === 'TEMP_LOW');
  const together = hot.length >= 2 && Math.max(...hot.map((a) => a.raisedAt)) - Math.min(...hot.map((a) => a.raisedAt)) <= 2 * 60_000;
  for (const a of active) {
    const topic = together && hot.includes(a) ? 'ALERT:MULTI' : `ALERT:${a.sensorId}`;
    const roles = rolesForSensor(a.sensorId);
    const to = new Set([...leads, ...people(st, s, now, (r) => !!r && roles.includes(r))]);
    for (const id of to) out.push({ to: id, kind: 'ALERT', refs: [a.id], topic, params: together && hot.includes(a) ? { sensors: hot.length } : { sensor: a.sensorId, kind: a.kind }, priority: a.severity === 'ALARM' ? 5 : 2, urgent: a.severity === 'ALARM' });
    // 升级：严重告警几分钟没人确认，提醒门店管理员
    if (a.severity === 'ALARM' && now - a.raisedAt >= (opts.escalateAfterMin ?? 5) * 60_000) out.push({ to: 'console', kind: 'ESCALATION', refs: [a.id], topic: `ESC:${a.sensorId}`, params: { sensor: a.sensorId, minutes: Math.round((now - a.raisedAt) / 60_000) }, priority: 6, urgent: true });
  }
  // 3. 任务：核对货架、拣货前补货给补货岗位；后仓补取给有权限的人（同一通道的合成一条）
  const plan = planogramByItem(st);
  const runOf = (itemId: string) => plan.get(itemId)?.runId ?? '?';
  const restockers = people(st, s, now, (r) => r === 'RESTOCK');
  for (const c of Object.values(s.checks)) if (c.status === 'OPEN') for (const to of restockers) out.push({ to, kind: 'TASK', refs: [c.id], topic: `CHECK:${runOf(c.itemId)}`, params: { task: 'CHECK', run: runOf(c.itemId) }, priority: 1.2, urgent: false });
  for (const t of Object.values(s.repl)) {
    if (t.status !== 'OPEN' || t.reason !== 'PREPICK') continue;
    const mins = t.dueAt !== undefined ? (t.dueAt - now) / 60_000 : 30;
    for (const to of restockers) out.push({ to, kind: 'TASK', refs: [t.id], topic: `PREPICK:${t.area}`, params: { task: 'PREPICK', run: t.area }, priority: 2, urgent: mins <= 10 });
  }
  const authorized = st.roster.filter((a) => a.exceptionAuthorized && a.role !== 'LEAD' && dutyOf(st, s, a.id, now).on).map((a) => a.id);
  for (const x of Object.values(s.exceptions)) if (x.status === 'OPEN') for (const to of authorized) out.push({ to, kind: 'TASK', refs: [x.id], topic: 'EXCEPTION', params: { task: 'EXCEPTION' }, priority: 2, urgent: false });
  // 3b. 后仓补取找到了、订单的框也放进暂存了（决策记录 0026）：提醒补取的人现在可以送了
  for (const x of Object.values(s.exceptions)) {
    if (x.status !== 'FOUND' || !x.associateId) continue;
    const o = s.orders[x.orderId];
    const tote = o?.toteIds.map((id) => s.totes[id]).find((t) => t?.lines.some((l) => l.lineId === x.lineId));
    if (tote?.status === 'STAGED' && tote.slotCode) out.push({ to: x.associateId, kind: 'TASK', refs: [x.id], topic: `DELIVER:${x.id}`, params: { task: 'DELIVER', slot: tote.slotCode }, priority: 3, urgent: false });
  }
  // 3c. 顾客到店（决策记录 0026）：提醒在岗、手上没在交付的交付员（合成一条；等太久的标紧急）
  const waiting = Object.values(s.orders).filter((o) => o.arrivedAt !== undefined && o.track !== 'AUTO' && (o.status === 'STAGED' || o.status === 'READY') && !Object.values(s.sessions).some((ss) => ss.status !== 'COMPLETED' && ss.orderIds.includes(o.id)));
  if (waiting.length) {
    const handoff = people(st, s, now, (r) => r === 'HANDOFF');
    const longest = Math.max(...waiting.map((o) => now - (o.arrivedAt as number)));
    for (const to of handoff) out.push({ to, kind: 'ARRIVAL', refs: waiting.map((o) => o.id), topic: 'ARRIVAL', params: { order: waiting[0]?.shortCode ?? '', ...(waiting[0]?.bay ? { bay: waiting[0].bay } : {}) }, priority: 4, urgent: longest >= st.rules.longWaitMin * 60_000 });
  }
  // 3d. 改派后可能赶不上送达时段（决策记录 0026）：直接通知带班负责人和开始准备的人，不用转告
  for (const tr of Object.values(s.trips)) {
    const last = tr.cancellations?.[tr.cancellations.length - 1];
    if (!last?.atRisk || tr.completedAt !== undefined || tr.acceptedAt !== undefined) continue;
    const to = new Set([...leads, ...(last.sessionOwner ? [last.sessionOwner] : [])]);
    for (const id of to) out.push({ to: id, kind: 'NOTICE', refs: [`TRIP:${tr.id}`], topic: `TRIP:${tr.id}:${tr.cancellations?.length ?? 1}`, params: { notice: 'TRIP_AT_RISK', trip: tr.id, since: last.at }, priority: 4, urgent: true });
  }
  // 4. 补班 / 延长 / 提前下班的邀请（决策记录 0022）：发给被邀请的人（不管他此刻在不在岗）
  for (const o of Object.values(s.offers ?? {})) if (o.status === 'PENDING') out.push({ to: o.associateId, kind: 'OFFER', refs: [o.id], topic: `OFFER:${o.id}`, params: { kind: o.kind, date: o.date, from: o.from, to: o.to }, priority: 2, urgent: false });
  // 5. 冷链超时：提醒正在拣的人；按现在的速度预计会超时（决策记录 0023 · B3）时提前提醒
  for (const w of Object.values(s.walks)) {
    if (w.status !== 'PICKING' || !w.associateId || w.associateId.startsWith('V-')) continue;
    if (w.coldAlerted) out.push({ to: w.associateId, kind: 'COLD', refs: [w.id], topic: `COLD:${w.id}`, params: { walk: w.id }, priority: 5, urgent: true });
    else if ((w.coldRisk?.overSec ?? 0) >= 60) out.push({ to: w.associateId, kind: 'COLD', refs: [w.id], topic: `COLDRISK:${w.id}`, params: { walk: w.id, early: 1, over: Math.round((w.coldRisk?.overSec ?? 0) / 60), lines: w.coldRisk?.remainingLines ?? 0 }, priority: 4, urgent: true });
  }
  // 6. AI 自己的通知（决策记录 0022 · F4、H3）：效果追踪发现连续不准、自动降成只显示；模型误差明显变大、数据中断暂停。发给带班负责人，每件事只发一次
  for (const [m, ms] of Object.entries(s.aiModes)) {
    if (!ms?.auto || ms.mode !== 'SHOW' || now - ms.at > 12 * HOUR) continue;
    for (const to of leads) out.push({ to, kind: 'NOTICE', refs: [`MODE:${m}`], topic: `MODE:${m}`, params: { notice: 'DOWNGRADED', module: m, hitRate: ms.auto.hitRate, n: ms.auto.n, since: ms.at }, priority: 3, urgent: false });
  }
  // 7. 负荷与安全（决策记录 0023 · D5）：冷冻区待久了、连续工作太久，提醒本人；需要两人搬运的大件，请一位手上没活的同事去帮忙
  for (const a of st.roster) {
    if (a.role === 'LEAD' || !dutyOf(st, s, a.id, now).on) continue;
    const fz = freezerMinutes(s, a.id, now);
    if (fz >= SAFETY_RULES.freezerLimitMin) out.push({ to: a.id, kind: 'SAFETY', refs: [`FREEZER:${a.id}`], topic: `SAFETY:FREEZER:${a.id}`, params: { safety: 'FREEZER', minutes: fz }, priority: 2.5, urgent: false });
    const worked = workedSinceBreak(s, st, a.id, now);
    if (worked >= SAFETY_RULES.breakAfterMin) out.push({ to: a.id, kind: 'SAFETY', refs: [`BREAK:${a.id}`], topic: `SAFETY:BREAK:${a.id}`, params: { safety: 'BREAK', minutes: worked }, priority: 2, urgent: false });
  }
  for (const p of Object.values(s.oversized ?? {})) {
    if (!p.teamLift || p.status !== 'CLAIMED' || !p.associateId) continue;
    const helper = st.roster.find((a) => a.id !== p.associateId && a.role !== 'LEAD' && dutyOf(st, s, a.id, now).on && !isBusy(s, a.id));
    if (helper) out.push({ to: helper.id, kind: 'SAFETY', refs: [`LIFT:${p.id}`], topic: `SAFETY:LIFT:${p.id}`, params: { safety: 'LIFT', piece: p.id, who: p.associateId, kg: Math.round(p.weightKg) }, priority: 3, urgent: false });
  }
  for (const h of s.aiHealth?.models ?? []) {
    if (h.status !== 'DRIFT' && h.status !== 'PAUSED') continue;
    const params: Record<string, string | number> = { notice: h.status, model: h.id, since: h.since, ...(h.cause ? { cause: h.cause } : {}), ...(h.recent !== undefined ? { recent: h.recent } : {}), ...(h.backtest !== undefined ? { backtest: h.backtest } : {}), ...(h.metric ? { metric: h.metric } : {}) };
    for (const to of leads) out.push({ to, kind: 'NOTICE', refs: [`HEALTH:${h.id}`], topic: `HEALTH:${h.id}`, params, priority: 2.5, urgent: false });
  }
  return out;
}

/** AI 通知涉及的事情是否还在：自动降级还没改回来、模型还没恢复正常 */
function noticeActive(s: OpsState, ref: string): boolean {
  if (ref.startsWith('MODE:')) {
    const ms = s.aiModes[ref.slice(5) as keyof OpsState['aiModes']];
    return !!ms?.auto && ms.mode === 'SHOW';
  }
  if (ref.startsWith('HEALTH:')) {
    const h = s.aiHealth?.models.find((x) => x.id === ref.slice(7));
    return h?.status === 'DRIFT' || h?.status === 'PAUSED';
  }
  // 改派后可能超时：还没有新司机接单、行程也没完成
  if (ref.startsWith('TRIP:')) {
    const tr = s.trips[ref.slice(5)];
    return !!tr && tr.completedAt === undefined && tr.acceptedAt === undefined;
  }
  return false;
}

/** 某条提醒涉及的东西是否都已经处理完；返回关闭的方式，还没完时返回 undefined */
/** 负荷与安全的提醒还要不要：冷冻区的时间降下来了、休息过了（或下班了）、大件已经搬完 */
function safetyActive(s: OpsState, st: StoreStatic, ref: string, now: number): boolean {
  const [kind, id] = ref.split(':') as [string, string];
  if (kind === 'FREEZER') return freezerMinutes(s, id, now) >= 30;
  if (kind === 'BREAK') return workedSinceBreak(s, st, id, now) >= 30;
  if (kind === 'LIFT') return s.oversized?.[id]?.status === 'CLAIMED';
  return false;
}

function settled(s: OpsState, st: StoreStatic, n: Nudge, now: number): 'DONE' | 'EXPIRED' | undefined {
  const done = n.refs.every((id) => {
    switch (n.kind) {
      case 'REC':
        return s.recs[id]?.status !== 'OPEN';
      case 'ALERT':
        return s.alerts?.[id]?.status !== 'ACTIVE';
      case 'ESCALATION':
        return s.alerts?.[id]?.status !== 'ACTIVE';
      case 'COLD':
        // 提前提醒：风险消失或者已经真的超时（换成超时提醒）时关闭
        return s.walks[id]?.status !== 'PICKING' || (n.topic.startsWith('COLDRISK:') && (!!s.walks[id]?.coldAlerted || (s.walks[id]?.coldRisk?.overSec ?? 0) < 60));
      case 'TASK':
        // 送补取的商品：送到了、放回货架了、或者框又不在暂存了
        if (n.topic.startsWith('DELIVER:')) return s.exceptions[id]?.status !== 'FOUND';
        return (s.checks[id] ? s.checks[id]?.status !== 'OPEN' : true) && (s.repl[id] ? s.repl[id]?.status !== 'OPEN' : true) && (s.exceptions[id] ? s.exceptions[id]?.status !== 'OPEN' : true);
      case 'ARRIVAL': {
        // 顾客到店：开始准备了、订单完成或取消了
        const o = s.orders[id];
        return !o || o.status === 'COMPLETED' || o.status === 'CANCELLED' || Object.values(s.sessions).some((ss) => ss.status !== 'COMPLETED' && ss.orderIds.includes(id));
      }
      case 'OFFER':
        return s.offers?.[id]?.status !== 'PENDING';
      case 'NOTICE':
        return !noticeActive(s, id);
      case 'SAFETY':
        return !safetyActive(s, st, id, now);
    }
  });
  if (done) {
    if (n.kind === 'REC' && n.refs.every((id) => s.recs[id]?.status === 'EXPIRED' || s.recs[id]?.status === 'SUPERSEDED' || !s.recs[id])) return 'EXPIRED';
    return 'DONE';
  }
  return now - n.createdAt > 2 * HOUR ? 'EXPIRED' : undefined;
}

export function planNudges(s: OpsState, st: StoreStatic, now: number, opts: NudgePlanOptions = {}): NudgePlan {
  const all = Object.values(s.nudges ?? {});
  const open = all.filter((n) => n.status === 'SENT' || n.status === 'READ');
  const close: NudgePlan['close'] = [];
  for (const n of open) {
    const how = settled(s, st, n, now);
    if (how) close.push({ id: n.id, status: how });
  }
  const closing = new Set(close.map((c) => c.id));
  const stillOpen = open.filter((n) => !closing.has(n.id));
  // 合并：同一个人、同一类、同一组
  const merged = new Map<string, NudgeCandidate>();
  for (const c of nudgeCandidates(s, st, now, opts)) {
    const key = `${c.to}|${c.kind}|${c.topic}`;
    const m = merged.get(key);
    if (!m) merged.set(key, { ...c, refs: [...c.refs] });
    else {
      for (const r of c.refs) if (!m.refs.includes(r)) m.refs.push(r);
      m.priority = Math.max(m.priority, c.priority);
      m.urgent = m.urgent || c.urgent;
    }
  }
  const budget = opts.budgetPerHour ?? 3;
  const hour = new Date(now).getHours();
  const night = opts.hours ? hour < opts.hours.open - 1 || hour >= opts.hours.close + 1 : false;
  const sentLastHour = new Map<string, number>();
  for (const n of all) if (!n.urgent && n.createdAt >= now - HOUR) sentLastHour.set(n.to, (sentLastHour.get(n.to) ?? 0) + 1);
  const send: NudgeCandidate[] = [];
  const deferred: NudgePlan['deferred'] = [];
  const ranked = [...merged.values()].sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.priority - a.priority || a.topic.localeCompare(b.topic) || a.to.localeCompare(b.to));
  for (const c of ranked) {
    // 这个人已经有同一组没处理完的提醒：不再重复发
    if (stillOpen.some((n) => n.to === c.to && n.kind === c.kind && n.topic === c.topic)) continue;
    // AI 的通知每件事只发一次（读过、过期之后不再发）
    if (c.kind === 'NOTICE' && all.some((n) => n.to === c.to && n.topic === c.topic && n.createdAt >= Number(c.params?.since ?? 0))) continue;
    // 同一个模块的建议 10 分钟内最多提醒一次（紧急的也一样）：新的估计取代旧的建议时不再重新提醒，打开 AI 页看到的总是最新的
    if (c.kind === 'REC' && all.some((n) => n.to === c.to && n.topic === c.topic && now - n.createdAt < REC_REPEAT_MS)) continue;
    if (c.refs.length > 1) c.params = { ...(c.params ?? {}), count: c.refs.length };
    if (!c.urgent) {
      if (night) {
        deferred.push({ to: c.to, topic: c.topic, why: 'NIGHT' });
        continue;
      }
      if (c.to !== 'console' && (inHandoff(s, c.to) || coldRush(s, c.to, now))) {
        deferred.push({ to: c.to, topic: c.topic, why: 'BUSY' });
        continue;
      }
      const used = sentLastHour.get(c.to) ?? 0;
      // 顾客到店不算进每小时的预算（决策记录 0026）：一个小时来几十位顾客是常事
      if (used >= budget && c.kind !== 'ARRIVAL') {
        deferred.push({ to: c.to, topic: c.topic, why: 'BUDGET' });
        continue;
      }
      sentLastHour.set(c.to, used + 1);
    }
    send.push(c);
  }
  return { send, close, deferred };
}

// ---------------------------------------------------------------------------
// 视图

/** 发给某人、还没处理完的提醒（紧急的在前，再按时间新的在前） */
export function myNudges(s: OpsState, to: string): Nudge[] {
  return Object.values(s.nudges ?? {})
    .filter((n) => n.to === to && (n.status === 'SENT' || n.status === 'READ'))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

export interface NudgeStats {
  /** 最近一小时：发出的条数（全部 / 紧急）、平均每人 */
  lastHour: number;
  urgentLastHour: number;
  perPerson: number;
  /** 每人最近一小时的条数 */
  byPerson: Array<{ to: string; count: number }>;
  /** 从发出到读、到处理完的中位数（秒） */
  medianReadSec?: number;
  medianCloseSec?: number;
  /** 过期没处理的比例（已经关闭的提醒里） */
  expiredShare?: number;
  total: number;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function nudgeStats(s: OpsState, now: number): NudgeStats {
  const all = Object.values(s.nudges ?? {});
  const recent = all.filter((n) => n.createdAt >= now - HOUR);
  const by = new Map<string, number>();
  for (const n of recent) by.set(n.to, (by.get(n.to) ?? 0) + 1);
  const closed = all.filter((n) => n.status === 'DONE' || n.status === 'EXPIRED');
  const read = all.filter((n) => n.readAt !== undefined).map((n) => ((n.readAt as number) - n.createdAt) / 1000);
  const done = closed.filter((n) => n.closedAt !== undefined && n.status === 'DONE').map((n) => ((n.closedAt as number) - n.createdAt) / 1000);
  const stats: NudgeStats = {
    lastHour: recent.length,
    urgentLastHour: recent.filter((n) => n.urgent).length,
    perPerson: by.size ? Math.round((recent.length / by.size) * 10) / 10 : 0,
    byPerson: [...by.entries()].map(([to, count]) => ({ to, count })).sort((a, b) => b.count - a.count || a.to.localeCompare(b.to)),
    total: all.length,
  };
  const mr = median(read);
  const mc = median(done);
  if (mr !== undefined) stats.medianReadSec = Math.round(mr);
  if (mc !== undefined) stats.medianCloseSec = Math.round(mc);
  if (closed.length) stats.expiredShare = Math.round((closed.filter((n) => n.status === 'EXPIRED').length / closed.length) * 1000) / 1000;
  return stats;
}
