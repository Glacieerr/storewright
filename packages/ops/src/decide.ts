import { assignTotes, composeTrips, planPickWalks, type BatchingOptions, type PlanningContext, type TripCandidate } from '@storewright/algorithms';
import { gtin14, opaqueLabelId, type Item, type Order, type ToteAssignment } from '@storewright/domain';
import type { StoreModel } from '@storewright/store-config';
import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type OpsEventPayloads, type PendingEvent } from './events';
import type { LiveOrder, LiveTote, LiveWalk, OpsState, OrderInfo, StoreStatic, ToteInfo, WalkInfo } from './types';
import { decideInventory, inventoryTick, isInventoryCommand, planogramByItem, replTaskEvent, sellableCases, type InventoryContext } from './inventory';
import { codeHashInput, needsAgeCheck, pickRows, walkRemaining } from './views';
import { DEFAULT_DRIVER_CANCEL, driverCancelWindow, noShowWindow, type DriverCancelReason } from './driverCancel';
import { aiTick, canManageAi, decideAi, isAiCommand } from './ai';
import { decideStaff, isStaffCommand } from './staff';
import { decideNote, isNoteCommand } from './notes';
import { decideModule, moduleFor, moduleTick } from './modules';

/**
 * 命令处理（只在服务端运行）：校验命令，产生事件或拒绝。
 *
 * 纯函数：不读时钟（时间来自信封）、不取随机数（验证码由服务端生成，命令里只带哈希）、不修改状态。
 * 锁单分框、生成拣货批次、组合行程直接调用 Phase 1 的算法，与模拟器使用同一套规则。
 */

export interface OpsContext {
  model: StoreModel;
  /** 门店静态数据：员工名单、暂存格位、后仓库位、陈列表、补货规则 */
  statics: StoreStatic;
  items: ReadonlyMap<string, Item>;
  /** 验证码哈希函数（服务端用带盐的 SHA-256） */
  hash(input: string): string;
  batching?: Partial<BatchingOptions>;
  /** 配送车辆的默认容量 */
  vehicle?: { totes: number; maxKg: number };
}

export type Decision = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };

const no = (code: RejectCode, params?: Record<string, string | number>): Decision => ({ ok: false, reject: params ? { code, params } : { code } });
const yes = (events: PendingEvent[]): Decision => ({ ok: true, events });

const gtinIndexCache = new WeakMap<ReadonlyMap<string, Item>, Map<string, string>>();
function inventoryContext(ctx: OpsContext): InventoryContext {
  let idx = gtinIndexCache.get(ctx.items);
  if (!idx) {
    idx = new Map();
    for (const it of ctx.items.values()) idx.set(gtin14(it.gtin), it.id);
    gtinIndexCache.set(ctx.items, idx);
  }
  const gtins = idx;
  return { statics: ctx.statics, itemByGtin: (g) => gtins.get(gtin14(g)), itemExists: (id) => ctx.items.has(id) };
}

export function decide(s: OpsState, env: CommandEnvelope, ctx: OpsContext): Decision {
  const { cmd, actor, at } = env;
  if (isInventoryCommand(cmd)) return decideInventory(s, { ...env, cmd }, inventoryContext(ctx));
  if (isAiCommand(cmd)) return decideAi(s, { ...env, cmd }, ctx.statics);
  if (isStaffCommand(cmd)) return decideStaff(s, { ...env, cmd }, ctx.statics, canManageAi(ctx.statics, env.actor));
  if (isNoteCommand(cmd)) return decideNote(s, { ...env, cmd }, ctx.statics, canManageAi(ctx.statics, env.actor));
  const mod = moduleFor(cmd);
  if (mod) {
    const ic = inventoryContext(ctx);
    return decideModule(s, env, mod, {
      statics: ctx.statics,
      canManage: canManageAi(ctx.statics, env.actor),
      itemByGtin: (g) => {
        const id = ic.itemByGtin(g) ?? (ctx.items.has(g) ? g : undefined);
        const it = id ? ctx.items.get(id) : undefined;
        if (!it) return undefined;
        const chemical = it.handling.includes('CHEMICAL') || it.handling.includes('HAZMAT');
        // 只有未开封才能回架：超市里门店拣货的散件（食品、日用品、个护）；建材店的散件和百货检验后分流
        return { id: it.id, gtin: it.gtin, name: it.name, tempZone: it.tempZone, unitPrice: it.unitPrice, chemical, sealedOnly: it.fulfillmentType === 'GROCERY' && !it.nonFood && !chemical };
      },
    });
  }
  switch (cmd.type) {
    case 'CreateOrder':
      return createOrder(s, cmd.order, cmd.codeHash, ctx);
    case 'CancelOrder': {
      const o = s.orders[cmd.orderId];
      if (!o) return no('ORDER_NOT_FOUND');
      if (o.status === 'CANCELLED') return no('ORDER_CANCELLED');
      if (o.status === 'COMPLETED') return no('ORDER_COMPLETED');
      const out = [ev('OrderCancelled', { orderId: o.id, reason: cmd.reason })];
      // 拣货开始前取消：标签作废（决策 P-13）；已经拣了的在暂存扫描时提示放回收专区
      for (const id of o.toteIds) {
        const t = s.totes[id];
        const w = t?.walkId ? s.walks[t.walkId] : undefined;
        const started = w && Object.keys(w.done).some((k) => k.startsWith(`${id}|`));
        if (t?.labelId && (t.status === 'IN_WALK' || t.status === 'BOUND') && !started) out.push(ev('LabelVoided', { labelId: t.labelId }));
      }
      for (const x of Object.values(s.exceptions)) if (x.orderId === o.id && (x.status === 'OPEN' || x.status === 'ASSIGNED')) out.push(ev('ExceptionVoided', { exceptionId: x.id }));
      return yes(out);
    }
    case 'LockOrder': {
      const o = s.orders[cmd.orderId];
      if (!o) return no('ORDER_NOT_FOUND');
      if (o.status !== 'CREATED') return no('ORDER_NOT_CREATED', { status: o.status });
      return yes(lockEvents(o, ctx).events);
    }
    case 'ReleaseWalks': {
      const events = releaseEvents(s, [], ctx);
      return events.length ? yes(events) : no('NOTHING_TO_RELEASE');
    }
    case 'Tick':
      return yes(tick(s, at, cmd.release, ctx));
    case 'LoadInventory':
      if (s.counters.cases > 0) return no('ALREADY_DONE');
      return yes(cmd.cases.length ? [ev('InventoryLoaded', { cases: cmd.cases })] : []);
    case 'ClaimWalk': {
      const w = s.walks[cmd.walkId];
      if (!w) return no('WALK_NOT_FOUND');
      if (w.status === 'COMPLETED') return no('WALK_COMPLETED');
      if (w.associateId === actor) return yes([]);
      if (w.status !== 'OPEN') return no('WALK_CLAIMED', { by: w.associateId ?? '' });
      const busy = Object.values(s.walks).find((x) => x.associateId === actor && (x.status === 'CLAIMED' || x.status === 'PICKING'));
      if (busy) return no('ASSOCIATE_BUSY', { walkId: busy.id });
      return yes([ev('PickWalkClaimed', { walkId: w.id })]);
    }
    case 'UnclaimWalk': {
      const w = ownWalk(s, cmd.walkId, actor);
      if ('code' in w) return no(w.code, w.params);
      if (w.status !== 'CLAIMED') return no('WALK_STARTED');
      return yes([ev('PickWalkUnclaimed', { walkId: w.id })]);
    }
    case 'BindLabel': {
      const w = ownWalk(s, cmd.walkId, actor);
      if ('code' in w) return no(w.code, w.params);
      const l = s.labels[cmd.labelId];
      if (!l) return no('LABEL_NOT_FOUND');
      if (l.voided) return no('LABEL_VOIDED');
      if (!w.toteIds.includes(l.toteId)) return no('LABEL_NOT_IN_WALK');
      if (w.bound.includes(l.toteId)) return yes([]);
      return yes([ev('LabelBound', { labelId: l.labelId, walkId: w.id })]);
    }
    case 'PickItem':
    case 'ReportNotFound':
      return pickLine(s, cmd, actor, ctx);
    case 'CompleteWalk': {
      const w = ownWalk(s, cmd.walkId, actor);
      if ('code' in w) return no(w.code, w.params);
      const remaining = walkRemaining(s, w);
      if (remaining > 0) return no('WALK_UNFINISHED', { remaining });
      const from = w.startedAt ?? w.claimedAt ?? at;
      return yes([ev('PickWalkCompleted', { walkId: w.id, durationSec: Math.round((at - from) / 1000) })]);
    }
    case 'ReprintLabel': {
      const t = s.totes[cmd.toteId];
      if (!t) return no('TOTE_NOT_FOUND');
      if (!t.labelId) return no('LABEL_NOT_FOUND');
      // 因丢失而重打：版本号不变，重复扫描按同一标签处理（决策 L-04）
      return yes([ev('LabelReprinted', { labelId: t.labelId })]);
    }
    case 'StageTote':
      return stageTote(s, cmd.labelId, cmd.slotCode, ctx);
    case 'RecoverTote': {
      const r = labelTote(s, cmd.labelId);
      if ('code' in r) return no(r.code);
      const o = s.orders[r.tote.orderId];
      if (o?.status !== 'CANCELLED') return no('NOT_CANCELLED');
      if (r.tote.status === 'RECOVERY') return yes([]);
      return yes([ev('ToteSentToRecovery', { toteId: r.tote.id })]);
    }
    case 'UpdateEta':
    case 'CheckIn': {
      if (cmd.tripId) {
        if (!s.trips[cmd.tripId]) return no('TRIP_NOT_FOUND');
      } else {
        const o = cmd.orderId ? s.orders[cmd.orderId] : undefined;
        if (!o) return no('ORDER_NOT_FOUND');
        if (o.status === 'CANCELLED') return no('ORDER_CANCELLED');
        if (o.status === 'COMPLETED') return no('ORDER_COMPLETED');
      }
      const ref: { orderId?: string; tripId?: string } = cmd.tripId ? { tripId: cmd.tripId } : { orderId: cmd.orderId as string };
      if (cmd.type === 'UpdateEta') return yes([ev('EtaUpdated', { ...ref, etaAt: cmd.etaAt })]);
      // 配置了明确的取货车位时，车位编号必须是其中之一（决策记录 0013）
      if (cmd.bay && ctx.statics.pickupBays && !ctx.statics.pickupBays.includes(cmd.bay)) return no('BAY_NOT_FOUND', { bay: cmd.bay });
      const p: { orderId?: string; tripId?: string; bay?: string; vehicle?: string } = { ...ref };
      if (cmd.bay) p.bay = cmd.bay;
      if (cmd.vehicle) p.vehicle = cmd.vehicle;
      return yes([ev('CustomerArrived', p)]);
    }
    case 'AcceptTrip': {
      const tr = s.trips[cmd.tripId];
      if (!tr) return no('TRIP_NOT_FOUND');
      if (tr.acceptedAt) return no('TRIP_ACCEPTED');
      return yes([ev('TripAccepted', { tripId: tr.id, driverName: cmd.driverName, codeHash: cmd.codeHash })]);
    }
    case 'CancelTripDriver':
    case 'RedispatchTrip':
      return cancelTrip(s, cmd.tripId, cmd.type === 'CancelTripDriver' ? 'DRIVER' : 'STORE', env, ctx);
    case 'StartPrep':
      return startPrep(s, cmd.key, actor);
    case 'JoinPrep': {
      const ss = s.sessions[cmd.key];
      if (!ss || ss.status === 'COMPLETED') return no('SESSION_NOT_FOUND');
      if (ss.owner === actor || ss.helpers.includes(actor)) return yes([]);
      return yes([ev('PrepJoined', { key: ss.key })]);
    }
    case 'ScanPrepTote': {
      const ss = s.sessions[cmd.key];
      if (!ss || ss.status === 'COMPLETED') return no('SESSION_NOT_FOUND');
      if (ss.owner !== actor && !ss.helpers.includes(actor)) return no('NOT_IN_SESSION', { by: ss.owner });
      const r = labelTote(s, cmd.labelId);
      if ('code' in r) return no(r.code);
      const t = r.tote;
      if (!ss.orderIds.includes(t.orderId)) return no('TOTE_NOT_IN_SESSION');
      if (ss.scanned.includes(t.id)) return no('TOTE_ALREADY_SCANNED');
      if (t.status !== 'STAGED') return no('TOTE_NOT_STAGED');
      const out = [ev('ToteScannedForPrep', { key: ss.key, toteId: t.id })];
      const all = sessionToteIds(s, ss.orderIds);
      if (all.every((id) => id === t.id || ss.scanned.includes(id))) out.push(ev('ReadyToLoad', { key: ss.key }));
      return yes(out);
    }
    case 'VerifyCode':
    case 'VerifyManually': {
      const ss = s.sessions[cmd.key];
      if (!ss || ss.status === 'COMPLETED') return no('SESSION_NOT_FOUND');
      if (ss.owner !== actor && !ss.helpers.includes(actor)) return no('NOT_IN_SESSION', { by: ss.owner });
      if (ss.verified) return no('ALREADY_VERIFIED');
      if (ss.status !== 'READY') return no('NOT_READY');
      // 员工必须先定位订单或行程、顾客到场，再核验验证码（决策 D-01）
      const arrived = ss.kind === 'TRIP' ? s.trips[ss.key]?.arrivedAt : s.orders[ss.key]?.arrivedAt;
      if (arrived === undefined) return no('NOT_ARRIVED');
      const codeHash = ss.kind === 'TRIP' ? s.trips[ss.key]?.codeHash : s.orders[ss.key]?.codeHash;
      if (cmd.type === 'VerifyManually') {
        if (!ss.manualRequired && codeHash) return no('MANUAL_NOT_ALLOWED');
        return yes([ev('CodeVerified', { key: ss.key, method: 'MANUAL' })]);
      }
      if (!codeHash) return no('NO_CODE');
      if (ctx.hash(codeHashInput(ss.key, cmd.code)) === codeHash) return yes([ev('CodeVerified', { key: ss.key, method: 'CODE' })]);
      // 输错不限次数、不锁定（决策记录 0014）；错到 codeAttempts 次后另外提供人工核验入口
      const attempt = ss.codeFailures + 1;
      return yes([ev('CodeFailed', { key: ss.key, attempt, manualRequired: ss.manualRequired || attempt >= ctx.model.config.rules.handoff.codeAttempts })]);
    }
    case 'VerifyAge': {
      const ss = s.sessions[cmd.key];
      if (!ss || ss.status === 'COMPLETED') return no('SESSION_NOT_FOUND');
      if (ss.owner !== actor && !ss.helpers.includes(actor)) return no('NOT_IN_SESSION', { by: ss.owner });
      if (ss.ageVerified) return yes([]);
      return yes([ev('AgeVerified', { key: ss.key })]);
    }
    case 'RecordPlacement': {
      const tr = s.trips[cmd.tripId];
      if (!tr) return no('TRIP_NOT_FOUND');
      if (!tr.orderIds.includes(cmd.orderId)) return no('ORDER_NOT_FOUND');
      return yes([ev('VehiclePlacementRecorded', { tripId: tr.id, orderId: cmd.orderId, position: cmd.position })]);
    }
    case 'CompleteHandoff': {
      const ss = s.sessions[cmd.key];
      if (!ss) return no('SESSION_NOT_FOUND');
      if (ss.status === 'COMPLETED') return no('ALREADY_DONE');
      if (ss.owner !== actor && !ss.helpers.includes(actor)) return no('NOT_IN_SESSION', { by: ss.owner });
      if (!ss.verified) return no('NOT_VERIFIED');
      const live = ss.orderIds.filter((id) => s.orders[id] && s.orders[id]?.status !== 'CANCELLED' && s.orders[id]?.status !== 'COMPLETED');
      if (needsAgeCheck(s, live) && !ss.ageVerified && !cmd.removeAgeItems) return no('AGE_CHECK_REQUIRED');
      const out: PendingEvent[] = [];
      for (const id of live) {
        const o = s.orders[id] as LiveOrder;
        const arrived = o.arrivedAt ?? (ss.kind === 'TRIP' ? s.trips[ss.key]?.arrivedAt : undefined);
        out.push(ev('OrderHandedOff', { orderId: id, waitSec: arrived !== undefined ? Math.max(0, Math.round((at - arrived) / 1000)) : 0, ageItemsRemoved: !!cmd.removeAgeItems && !ss.ageVerified }));
      }
      if (ss.kind === 'TRIP') out.push(ev('TripCompleted', { tripId: ss.key }));
      return yes(out);
    }
    default:
      // 扩展模块的命令在前面已经处理；这里只会遇到未知命令
      return no('INVALID_ORDER');
  }
}

// ---------------------------------------------------------------------------
// 订单与锁单

function createOrder(s: OpsState, order: OrderInfo, codeHash: string, ctx: OpsContext): Decision {
  if (s.orders[order.id]) return no('ORDER_EXISTS');
  if (!order.lines.length || !codeHash) return no('INVALID_ORDER');
  const seen = new Set<string>();
  for (const l of order.lines) {
    if (!ctx.items.has(l.itemId) || !Number.isInteger(l.qty) || l.qty <= 0 || seen.has(l.lineId)) return no('INVALID_ORDER', { lineId: l.lineId });
    seen.add(l.lineId);
  }
  return yes([ev('OrderCreated', { order, codeHash })]);
}

/** 订单 → 领域订单（时间换算为秒，供规划算法使用） */
export function toDomainOrder(o: OrderInfo, createdAt = o.slotStart): Order {
  const out: Order = {
    id: o.id,
    shortCode: o.shortCode,
    customer: { id: `C-${o.id}`, firstName: o.firstName, lastName: o.lastName },
    type: o.type,
    fulfillmentType: o.fulfillmentType,
    express: o.express,
    createdAt: Math.floor(createdAt / 1000),
    slotStart: Math.floor(o.slotStart / 1000),
    slotLengthSec: o.slotLengthMin * 60,
    lines: o.lines.map((l) => ({ lineId: l.lineId, itemId: l.itemId, qty: l.qty, allowSubstitution: l.allowSubstitution })),
  };
  if (o.destinationKm) out.destinationKm = o.destinationKm;
  return out;
}

function planning(ctx: OpsContext): PlanningContext {
  return { model: ctx.model, items: ctx.items };
}

/** 锁单：拆成履约段并分框（工程约束 EC-1：一次性完成） */
function lockEvents(o: LiveOrder, ctx: OpsContext): { events: PendingEvent[]; totes: ToteInfo[] } {
  const res = assignTotes(planning(ctx), toDomainOrder(o, o.createdAt));
  const totes: ToteInfo[] = res.totes.map((t) => ({
    id: t.id,
    orderId: o.id,
    tempZone: t.tempZone,
    index: t.index,
    count: t.count,
    chemical: t.chemical,
    lines: t.lines.map((l) => ({ lineId: l.lineId, qty: l.qty })),
    dueAt: t.dueAt * 1000,
  }));
  const events = [ev('OrderLocked', { orderId: o.id }), ev('ToteAssignmentsCreated', { orderId: o.id, totes, oversized: res.oversized.length })];
  // 大件模块打开时：每一件生成一个大件任务（先扫后打、一件一签）
  if (ctx.statics.modules?.oversized && res.oversized.length) {
    events.push(
      ev('OversizedPiecesCreated', {
        orderId: o.id,
        pieces: res.oversized.map((p) => {
          const it = ctx.items.get(p.itemId);
          return { pieceId: p.id, lineId: p.lineId, itemId: p.itemId, name: it?.name ?? p.itemId, gtin: it?.gtin ?? '', index: p.index, count: p.count, weightKg: p.weightKg, teamLift: p.teamLift };
        }),
      }),
    );
  }
  return { events, totes };
}

// ---------------------------------------------------------------------------
// 生成拣货批次

function toAssignment(ctx: OpsContext, t: ToteInfo, o: OrderInfo): ToteAssignment {
  let volumeL = 0;
  let weightKg = 0;
  const lines = t.lines.map((l) => {
    const line = o.lines.find((x) => x.lineId === l.lineId);
    const itemId = line?.itemId ?? '';
    const item = ctx.items.get(itemId);
    if (item) {
      volumeL += ((item.dims.l * item.dims.w * item.dims.h) / 1000) * l.qty;
      weightKg += item.weightKg * l.qty;
    }
    return { lineId: l.lineId, itemId, qty: l.qty };
  });
  return {
    id: t.id,
    orderId: t.orderId,
    tempZone: t.tempZone,
    fulfillmentType: o.fulfillmentType,
    chemical: t.chemical,
    index: t.index,
    count: t.count,
    lines,
    volumeL,
    weightKg,
    slotStart: Math.floor(o.slotStart / 1000),
    dueAt: Math.floor(t.dueAt / 1000),
  };
}

/**
 * 把所有已锁单、尚未进入批次的框一次性划分成拣货批次（工程约束 EC-2），并为每个框打印标签。
 * `fresh` 是同一条命令里刚分好的框（还没进入状态）。
 */
function releaseEvents(s: OpsState, fresh: ReadonlyArray<{ tote: ToteInfo; order: OrderInfo }>, ctx: OpsContext): PendingEvent[] {
  const pending: Array<{ tote: ToteInfo; order: OrderInfo }> = [...fresh];
  for (const t of Object.values(s.totes)) {
    const o = s.orders[t.orderId];
    if (t.status === 'PLANNED' && o && o.status !== 'CANCELLED') pending.push({ tote: t, order: o });
  }
  if (!pending.length) return [];
  const options: BatchingOptions = { strategy: 'ZONE_PARTITION', routing: 'TSP', enforceColdLimit: true, unit: 'ORDER', ...ctx.batching };
  // 自动运营的订单单独分批：虚拟员工的批次里不会混进员工手里的订单
  const groups = [pending.filter((p) => p.order.track !== 'AUTO'), pending.filter((p) => p.order.track === 'AUTO')];
  const planned = groups.flatMap((g, i) =>
    g.length ? planPickWalks(planning(ctx), g.map((p) => toAssignment(ctx, p.tote, p.order)), options, 'tmp-').map((w) => ({ ...w, auto: i === 1 })) : [],
  );
  const out: PendingEvent[] = [];
  let n = s.counters.walks;
  for (const w of planned) {
    n += 1;
    const walk: WalkInfo = {
      id: `W${String(n).padStart(3, '0')}`,
      tempZone: w.tempZone,
      toteIds: w.toteAssignmentIds,
      stops: w.stops.map((st) => ({ locationId: st.locationId, picks: st.picks.map((p) => ({ toteId: p.toteAssignmentId, lineId: p.lineId, qty: p.qty })) })),
      distanceM: w.distanceM,
      estimatedSec: w.estimatedSec,
      dueAt: w.dueAt * 1000,
    };
    if (w.coldLimitSec !== undefined) walk.coldLimitSec = w.coldLimitSec;
    if (w.auto) walk.track = 'AUTO';
    out.push(ev('PickWalkCreated', { walk }));
    for (const id of w.toteAssignmentIds) {
      const version = (s.totes[id]?.labelVersion ?? 0) + 1;
      out.push(ev('LabelPrinted', { labelId: opaqueLabelId(id, version), toteId: id, version }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 排程

function tick(s: OpsState, at: number, release: boolean, ctx: OpsContext): PendingEvent[] {
  const out: PendingEvent[] = [];
  const rules = ctx.model.config.rules;
  // 1. 到锁单时间的订单
  const fresh: Array<{ tote: ToteInfo; order: OrderInfo }> = [];
  const due = Object.values(s.orders)
    .filter((o) => o.status === 'CREATED' && o.slotStart - rules.lockLeadMin * 60_000 <= at)
    .sort((a, b) => a.slotStart - b.slotStart || a.id.localeCompare(b.id));
  for (const o of due) {
    const r = lockEvents(o, ctx);
    out.push(...r.events);
    for (const t of r.totes) fresh.push({ tote: t, order: o });
  }
  // 2. 生成拣货批次
  if (release) out.push(...releaseEvents(s, fresh, ctx));
  // 3. 冷链超时提醒
  for (const w of Object.values(s.walks)) {
    if (w.status !== 'PICKING' || w.coldStartedAt === undefined || w.coldLimitSec === undefined || w.coldAlerted) continue;
    const elapsed = (at - w.coldStartedAt) / 1000;
    if (elapsed > w.coldLimitSec) out.push(ev('ColdChainAlert', { walkId: w.id, elapsedSec: Math.round(elapsed), limitSec: w.coldLimitSec }));
  }
  // 4. 组合配送行程（在订单暂存之后，工程约束 EC-6）
  out.push(...tripEvents(s, at, ctx));
  // 5. 低库存补货任务、到期的周期盘点
  out.push(...inventoryTick(s, ctx.statics, at));
  // 6. 过期的 AI 建议
  out.push(...aiTick(s, at));
  // 7. 扩展模块（熟食保温超时、包裹短少……）
  out.push(...moduleTick(s, at, ctx.statics));
  return out;
}

function tripEvents(s: OpsState, at: number, ctx: OpsContext): PendingEvent[] {
  // 自动运营的订单单独组行程
  const manual = tripEventsFor(s, at, ctx, false, s.counters.trips);
  return [...manual, ...tripEventsFor(s, at, ctx, true, s.counters.trips + manual.length)];
}

function tripEventsFor(s: OpsState, at: number, ctx: OpsContext, auto: boolean, counter: number): PendingEvent[] {
  const rules = ctx.model.config.rules.handoff;
  const sameTrack = (o: LiveOrder) => (o.track === 'AUTO') === auto;
  const ready = Object.values(s.orders).filter((o) => o.type === 'DELIVERY' && o.status === 'STAGED' && !o.tripId && sameTrack(o));
  if (!ready.length) return [];
  // 离必须出发还剩多少时间（时段开始 − 提前量）
  const slack = Math.min(...ready.map((o) => o.slotStart - rules.deliveryReadyLeadMin * 60_000 - at));
  if (ready.length < rules.maxOrdersPerTrip) {
    if (slack > 15 * 60_000) return [];
    // 同一时段里还在拣货、暂存的配送订单：时间还够（超过 5 分钟）就先等它们暂存，
    // 否则先暂存好的那一单会单独成行，整趟只装一单（全流程走查发现）
    const first = ready.reduce((a, o) => (o.slotStart < a.slotStart ? o : a));
    const companions = Object.values(s.orders).some((o) => o.type === 'DELIVERY' && sameTrack(o) && !o.tripId && (o.status === 'LOCKED' || o.status === 'PICKING') && o.slotStart <= first.slotStart + first.slotLengthMin * 60_000);
    if (companions && slack > 5 * 60_000) return [];
  }
  const candidates: TripCandidate[] = ready.map((o) => {
    let weightKg = 0;
    for (const l of o.lines) weightKg += (ctx.items.get(l.itemId)?.weightKg ?? 0) * l.qty;
    return { order: toDomainOrder(o, o.createdAt), totes: o.toteIds.length, weightKg };
  });
  const v = ctx.vehicle ?? { totes: 12, maxKg: 300 };
  const trips = composeTrips(candidates, { maxOrders: rules.maxOrdersPerTrip, vehicleTotes: v.totes, vehicleMaxKg: v.maxKg }, 'tmp-');
  let n = counter;
  return trips.map((tr) => {
    n += 1;
    return ev('TripProposed', { tripId: `TR${String(n).padStart(3, '0')}`, orderIds: tr.orderIds, placements: tr.placements });
  });
}

// ---------------------------------------------------------------------------
// 拣货

function ownWalk(s: OpsState, walkId: string, actor: string): LiveWalk | Rejection {
  const w = s.walks[walkId];
  if (!w) return { code: 'WALK_NOT_FOUND' };
  if (w.status === 'COMPLETED') return { code: 'WALK_COMPLETED' };
  if (w.associateId !== actor) return w.associateId ? { code: 'WALK_NOT_YOURS', params: { by: w.associateId } } : { code: 'WALK_NOT_YOURS' };
  return w;
}

function pickLine(s: OpsState, cmd: Extract<OpsCommand, { type: 'PickItem' | 'ReportNotFound' }>, actor: string, ctx: OpsContext): Decision {
  const w = ownWalk(s, cmd.walkId, actor);
  if ('code' in w) return no(w.code, w.params);
  const t = s.totes[cmd.toteId];
  if (!t || !w.toteIds.includes(t.id)) return no('TOTE_NOT_FOUND');
  if (!w.bound.includes(t.id)) return no('TOTE_NOT_BOUND');
  const row = pickRows(s, w).find((r) => r.toteId === t.id && r.lineId === cmd.lineId);
  if (!row) return no('LINE_NOT_IN_TOTE');
  if (row.cancelled) return no('ORDER_CANCELLED');
  const remaining = row.qty - row.done;
  if (!Number.isInteger(cmd.qty) || cmd.qty <= 0 || cmd.qty > remaining) return no('QTY_INVALID', { remaining });
  const out: PendingEvent[] = [];
  const startCold = (w.tempZone === 'CHILLED' || w.tempZone === 'FROZEN') && w.coldStartedAt === undefined;
  if (cmd.type === 'PickItem') {
    out.push(ev('ItemPicked', { walkId: w.id, toteId: t.id, lineId: cmd.lineId, qty: cmd.qty, locationId: row.locationId }));
    // 冷链计时从第一件冷藏 / 冷冻商品放进框开始（决策 P-12）
    if (startCold) out.push(ev('ColdChainTimerStarted', { walkId: w.id }));
    return yes(out);
  }
  if (cmd.resolution === 'SUBSTITUTED') {
    if (!row.allowSubstitution) return no('SUBSTITUTION_NOT_ALLOWED');
    if (!cmd.substitute?.name) return no('SUBSTITUTE_REQUIRED');
  }
  // 只有库存记录显示后仓有货时才能转后仓补取（决策 P-08）
  if (cmd.resolution === 'EXCEPTION' && (s.suspect[row.itemId] !== undefined || !sellableCases(s, row.itemId).length)) return no('NO_BACKROOM_STOCK');
  out.push(ev('ItemNotFound', { walkId: w.id, toteId: t.id, lineId: cmd.lineId, qty: cmd.qty, resolution: cmd.resolution, locationId: row.locationId }));
  if (cmd.resolution === 'SUBSTITUTED' && cmd.substitute) {
    const sub = cmd.substitute;
    const rank = Number.isInteger(sub.rank) && (sub.rank as number) >= 1 && (sub.rank as number) <= 20 ? sub.rank : undefined;
    const model = typeof sub.model === 'string' ? sub.model.slice(0, 40) : undefined;
    out.push(ev('SubstitutionPicked', { walkId: w.id, toteId: t.id, lineId: cmd.lineId, qty: cmd.qty, itemName: sub.name, gtin: sub.gtin, ...(rank ? { rank } : {}), ...(model ? { model } : {}) }));
    if (startCold) out.push(ev('ColdChainTimerStarted', { walkId: w.id }));
  }
  if (cmd.resolution === 'EXCEPTION') {
    out.push(ev('ExceptionCreated', { exceptionId: `EX${String(s.counters.exceptions + 1).padStart(3, '0')}`, orderId: t.orderId, lineId: cmd.lineId, walkId: w.id, itemId: row.itemId, qty: cmd.qty }));
  } else {
    // 货架空了、后仓有货：立即生成补货任务（Exception 的补货在找到之后生成，决策 X-04）
    const p = planogramByItem(ctx.statics).get(row.itemId);
    const task = p ? replTaskEvent(s, ctx.statics, p, 'EMPTY', 0, 0) : undefined;
    if (task) out.push(task);
  }
  return yes(out);
}

// ---------------------------------------------------------------------------
// 暂存

function labelTote(s: OpsState, labelId: string): { tote: LiveTote } | { code: RejectCode } {
  const l = s.labels[labelId.trim().toUpperCase()];
  if (!l) return { code: 'LABEL_NOT_FOUND' };
  if (l.voided) return { code: 'LABEL_VOIDED' };
  const tote = s.totes[l.toteId];
  if (!tote) return { code: 'TOTE_NOT_FOUND' };
  return { tote };
}

function stageTote(s: OpsState, labelId: string, slotCode: string, ctx: OpsContext): Decision {
  const r = labelTote(s, labelId);
  if ('code' in r) return no(r.code);
  const t = r.tote;
  const o = s.orders[t.orderId];
  if (!o) return no('ORDER_NOT_FOUND');
  // 订单已取消：提示放进对应温区的回收专区（决策 P-13）
  if (o.status === 'CANCELLED') {
    if (t.status === 'RECOVERY') return yes([]);
    return yes([ev('CancelledOrderDetected', { toteId: t.id, orderId: o.id }), ev('ToteSentToRecovery', { toteId: t.id })]);
  }
  if (t.status !== 'PICKED' && t.status !== 'STAGED') return no('TOTE_NOT_PICKED', { status: t.status });
  const code = slotCode.trim().toUpperCase();
  const slot = ctx.model.stagingSlots.find((x) => x.code === code);
  if (!slot) return no('SLOT_NOT_FOUND');
  if (slot.tempZone !== t.tempZone) return no('SLOT_ZONE_MISMATCH', { slot: slot.tempZone, tote: t.tempZone });
  if (t.slotCode === code) return no('SAME_SLOT');
  const used = s.slots[code]?.length ?? 0;
  if (used >= slot.capacityTotes) return no('SLOT_FULL', { capacity: slot.capacityTotes });
  if (t.status === 'STAGED' && t.slotCode) return yes([ev('ToteMoved', { toteId: t.id, from: t.slotCode, to: code })]);
  const out = [ev('ToteStaged', { toteId: t.id, slotCode: code })];
  const rest = o.toteIds.filter((id) => id !== t.id).map((id) => s.totes[id]);
  if (rest.every((x) => !x || x.status === 'STAGED' || x.status === 'RECOVERY')) out.push(ev('OrderStaged', { orderId: o.id }));
  return yes(out);
}

// ---------------------------------------------------------------------------
// 交付

function sessionToteIds(s: OpsState, orderIds: readonly string[]): string[] {
  const ids: string[] = [];
  for (const id of orderIds) {
    const o = s.orders[id];
    if (!o || o.status === 'CANCELLED') continue;
    for (const tid of o.toteIds) if (s.totes[tid]?.status !== 'RECOVERY') ids.push(tid);
  }
  return ids;
}

/**
 * 司机取消接单 / 门店因司机没来而改派（决策记录 0014）。时间窗口见 driverCancel.ts。系统的应对：
 * 行程回到待接单并标记重新派单；正在进行的交付准备结束，已取出的框放回原格位（满了就放同温区有空位的格位）；
 * 顾客收到送达延后的通知；离送达时段结束不足 20 分钟（重新派单大约要这么久）时标记为可能超时，提醒带班负责人。
 */
const REDISPATCH_BUFFER_MS = 20 * 60_000;
function cancelTrip(s: OpsState, tripId: string, by: 'DRIVER' | 'STORE', env: CommandEnvelope, ctx: OpsContext): Decision {
  const tr = s.trips[tripId];
  if (!tr) return no('TRIP_NOT_FOUND');
  const h = ctx.model.config.rules.handoff;
  const rules = { lockMin: h.driverCancelLockMin ?? DEFAULT_DRIVER_CANCEL.lockMin, waitMin: h.driverCancelWaitMin ?? DEFAULT_DRIVER_CANCEL.waitMin };
  let reason: DriverCancelReason;
  let waitedMin: number | undefined;
  if (by === 'DRIVER') {
    // 只有司机本人（经平台或控制台代为操作）可以取消
    if (env.actor !== 'driver' && env.actor !== 'console' && !env.actor.startsWith('V-D')) return no('NOT_AUTHORIZED');
    const w = driverCancelWindow(tr, env.at, rules);
    if (!w.allowed) return no(w.code, w.opensAt !== undefined ? { opensAt: w.opensAt, waitedMin: w.waitedMin ?? 0 } : undefined);
    reason = w.reason;
    waitedMin = w.waitedMin;
  } else {
    if (!canManageAi(ctx.statics, env.actor)) return no('NOT_AUTHORIZED');
    if (tr.completedAt !== undefined) return no('ALREADY_DONE');
    if (tr.acceptedAt === undefined) return no('TRIP_NOT_ACCEPTED');
    const w = noShowWindow(tr, env.at, rules);
    if (!w.allowed) return no('NOT_NO_SHOW', w.opensAt !== undefined ? { opensAt: w.opensAt } : undefined);
    reason = 'NO_SHOW';
  }
  // 已取出的框放回暂存区：优先原格位，满了就找同温区有空位的格位
  const ss = s.sessions[tripId];
  const returns: Array<{ toteId: string; slotCode: string }> = [];
  if (ss && ss.status !== 'COMPLETED') {
    const used = new Map<string, number>();
    const free = (code: string) => {
      const slot = ctx.model.stagingSlots.find((x) => x.code === code);
      return !!slot && (s.slots[code]?.length ?? 0) + (used.get(code) ?? 0) < slot.capacityTotes;
    };
    for (const id of ss.scanned) {
      const t = s.totes[id];
      if (!t || t.status !== 'PULLED') continue;
      const target = t.slotCode && free(t.slotCode) ? t.slotCode : ctx.model.stagingSlots.find((x) => x.tempZone === t.tempZone && free(x.code))?.code;
      if (!target) continue;
      used.set(target, (used.get(target) ?? 0) + 1);
      returns.push({ toteId: id, slotCode: target });
    }
  }
  const atRisk = tr.orderIds.some((id) => {
    const o = s.orders[id];
    return !!o && o.status !== 'CANCELLED' && o.status !== 'COMPLETED' && env.at + REDISPATCH_BUFFER_MS > o.slotStart + o.slotLengthMin * 60_000;
  });
  const p: OpsEventPayloads['TripDriverCancelled'] = { tripId, by, reason, returns, atRisk };
  if (tr.driverName) p.driverName = tr.driverName;
  if (waitedMin !== undefined) p.waitedMin = waitedMin;
  if (ss && ss.status !== 'COMPLETED') p.sessionOwner = ss.owner;
  return yes([ev('TripDriverCancelled', p)]);
}

/** 员工扫描订单的任意一个框，订单立即标记为「准备中」并加锁；第二个员工只能加入协助（决策 D-05） */
function startPrep(s: OpsState, key: string, actor: string): Decision {
  const trip = s.trips[key];
  let kind: 'ORDER' | 'TRIP';
  let orderIds: string[];
  if (trip) {
    if (trip.completedAt) return no('ALREADY_DONE');
    kind = 'TRIP';
    orderIds = trip.orderIds.filter((id) => s.orders[id]?.status !== 'CANCELLED');
  } else {
    const o = s.orders[key];
    if (!o) return no('ORDER_NOT_FOUND');
    if (o.status === 'CANCELLED') return no('ORDER_CANCELLED');
    if (o.status === 'COMPLETED') return no('ORDER_COMPLETED');
    if (o.tripId) return no('ORDER_IN_TRIP', { tripId: o.tripId });
    kind = 'ORDER';
    orderIds = [o.id];
  }
  const existing = s.sessions[key];
  if (existing && existing.status !== 'COMPLETED') {
    if (existing.owner === actor || existing.helpers.includes(actor)) return yes([]);
    return no('PREP_LOCKED', { by: existing.owner });
  }
  const notStaged = orderIds.filter((id) => s.orders[id]?.stagedAt === undefined);
  if (notStaged.length) return no('NOT_STAGED', { orders: notStaged.length });
  return yes([ev('PrepStarted', { key, kind, orderIds })]);
}
