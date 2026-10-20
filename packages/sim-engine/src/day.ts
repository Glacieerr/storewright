import {
  EventLog,
  keyedRange,
  keyedUniform,
  type AnyDomainEvent,
  type Item,
  type Order,
  type OversizedPiece,
  type PickWalk,
  type TempZone,
  type ToteAssignment,
} from '@storewright/domain';
import type { StagingSlot, StoreModel } from '@storewright/store-config';
import {
  assignTotes,
  assignTotesByEye,
  coldChainLimitSec,
  composeTrips,
  createOccupancy,
  dueAtFor,
  hasCrushRisk,
  isColdZone,
  mixesChemicalWithFood,
  occupancyRate,
  occupy,
  planPickWalks,
  release,
  suggestSlot,
  type PlanningContext,
} from '@storewright/algorithms';
import { Simulation } from './kernel';
import type { Policy, SimScenario } from './scenario';
import { mean, percentile } from './stats';

export interface SimInput {
  model: StoreModel;
  items: ReadonlyMap<string, Item>;
  orders: readonly Order[];
  scenario: SimScenario;
  policy: Policy;
  /** 随机事件种子（缺货、到达时间等），不同策略用同一种子即为公共随机数 */
  seed: number;
  /** 是否保留完整事件日志（回放 / 动画用）；批量实验时关闭以节省内存 */
  retainEvents?: boolean;
}

export interface DayMetrics {
  policy: string;
  orders: number;
  lines: number;
  units: number;
  totes: number;
  walks: number;
  oversizedPieces: number;
  totesPerOrder: number;
  unitsPerTote: number;
  /** 框平均体积利用率（相对物理容积） */
  toteVolumeUtil: number;
  overweightTotePct: number;
  crushRiskTotePct: number;
  chemicalMixTotePct: number;
  pickDistanceKm: number;
  metersPerUnit: number;
  pickBusyHours: number;
  /** 每拣货工时件数（按拣货员实际作业时间计） */
  uph: number;
  coldWalks: number;
  coldViolationPct: number;
  maxColdMinutes: number;
  notFoundLinePct: number;
  substitutedLines: number;
  exceptionsCreated: number;
  exceptionsRecovered: number;
  shortLines: number;
  /** 缺货行的销售额（美元） */
  shortValue: number;
  /** 按订单交付的行数比例（含替代） */
  fillRate: number;
  stageBusyHours: number;
  overflowTotes: number;
  lateOrderPct: number;
  avgLatenessMin: number;
  handoffSessions: number;
  avgWaitMin: number;
  p50WaitMin: number;
  p80WaitMin: number;
  p90WaitMin: number;
  longWaitPct: number;
  earlyPreps: number;
  /** 提前取出的订单在门口等待顾客的时间（冷链风险指标） */
  avgReadyDwellMin: number;
  p90ReadyDwellMin: number;
  handoffBusyHours: number;
  exceptionBusyHours: number;
  busyHoursTotal: number;
  staffedHoursTotal: number;
  laborMinutesPerOrder: number;
  laborCostPerOrder: number;
  unfinishedOrders: number;
  eventsExecuted: number;
}

export interface SimResult {
  metrics: DayMetrics;
  walks: PickWalk[];
  events: AnyDomainEvent[];
}

type Role = 'pick' | 'stage' | 'handoff' | 'exception';
const ROLES: Role[] = ['pick', 'stage', 'handoff', 'exception'];

interface Associate {
  id: string;
  role: Role;
  busy: boolean;
  leaving: boolean;
}

interface Task {
  /** 返回作业时长（秒） */
  start(a: Associate): number;
  finish(a: Associate): void;
}

interface OrderState {
  order: Order;
  totes: ToteAssignment[];
  oversized: OversizedPiece[];
  stagedTotes: number;
  oversizedDone: number;
  stagedAt?: number;
  dueAt: number;
  toteSlot: Map<string, { slot?: StagingSlot; overflow: boolean }>;
  pendingExceptions: Set<string>;
  lineOutcome: Map<string, 'OK' | 'SUBSTITUTED' | 'RECOVERED' | 'SHORT' | 'PENDING'>;
  handedOff: boolean;
  sessionId?: string;
}

interface Session {
  id: string;
  kind: 'PICKUP' | 'TRIP';
  orderIds: string[];
  arrivedAt?: number;
  /** 收到可以开始准备的信号（「我在路上」或 ETA 低于阈值）的时间 */
  approachAt?: number;
  prepped: boolean;
  preppedAt?: number;
  inService: boolean;
  done: boolean;
}

interface CartTask {
  walkId: string;
  totes: ToteAssignment[];
  arrivedAt: number;
}

const DAY_START = 5 * 3600;
/** 后仓补取的时间余量：预计完成时间之外再留 10 分钟 */
const EXCEPTION_SLACK_SEC = 600;
const DAY_END = 26 * 3600;

export function simulateDay(input: SimInput): SimResult {
  const { model, items, orders, scenario, policy, seed } = input;
  const ctx: PlanningContext = { model, items };
  const cfg = model.config;
  const T = scenario.times;
  const B = scenario.behavior;
  const sim = new Simulation(DAY_START);
  const log = new EventLog(input.retainEvents ?? false);
  const occ = createOccupancy();

  const state = new Map<string, OrderState>();
  const sessions = new Map<string, Session>();
  const allWalks: PickWalk[] = [];
  const toteById = new Map<string, ToteAssignment>();
  const walkExpress = new Map<string, boolean>();
  const walkQueue: PickWalk[] = [];
  const oversizedQueue: Array<{ piece: OversizedPiece; dueAt: number }> = [];
  const cartQueue: CartTask[] = [];
  const exceptionQueue: Array<{ id: string; orderId: string; lineId: string; itemId: string; dueAt: number }> = [];

  // 指标累加器
  const busy: Record<Role, number> = { pick: 0, stage: 0, handoff: 0, exception: 0 };
  let extraTeamLiftSec = 0;
  let pickDistanceM = 0;
  let pickedUnits = 0;
  let coldWalks = 0;
  let coldViolations = 0;
  let maxColdSec = 0;
  let notFound = 0;
  let substituted = 0;
  let exceptionsCreated = 0;
  let exceptionsRecovered = 0;
  let overflowTotes = 0;
  let earlyPreps = 0;
  const waits: number[] = [];
  const readyDwell: number[] = [];
  let releaseSeq = 0;

  // ---------- 人员 ----------
  const pools: Record<Role, Associate[]> = { pick: [], stage: [], handoff: [], exception: [] };
  let associateSeq = 0;
  const staffed: Record<Role, number> = { pick: 0, stage: 0, handoff: 0, exception: 0 };

  const nextTask: Record<Role, () => Task | undefined> = {
    pick: () => nextPickTask(),
    stage: () => nextStageTask(),
    handoff: () => nextHandoffTask(),
    exception: () => nextExceptionTask(),
  };

  function dispatch(role: Role): void {
    for (const a of pools[role]) {
      if (a.busy || a.leaving) continue;
      const task = nextTask[role]();
      if (!task) return;
      a.busy = true;
      const dur = Math.max(1, task.start(a));
      busy[role] += dur;
      sim.after(dur, () => {
        a.busy = false;
        task.finish(a);
        if (a.leaving) pools[role] = pools[role].filter((x) => x !== a);
        dispatchAll();
      });
    }
  }

  function dispatchAll(): void {
    for (const r of ROLES) dispatch(r);
  }

  function setHeadcount(role: Role, target: number): void {
    const pool = pools[role];
    const active = pool.filter((a) => !a.leaving);
    if (active.length < target) {
      let need = target - active.length;
      for (const a of pool) {
        if (need > 0 && a.leaving) {
          a.leaving = false;
          need--;
        }
      }
      for (let i = 0; i < need; i++) pool.push({ id: `${role}-${++associateSeq}`, role, busy: false, leaving: false });
    } else if (active.length > target) {
      let excess = active.length - target;
      const idleFirst = [...active].sort((a, b) => Number(a.busy) - Number(b.busy));
      for (const a of idleFirst) {
        if (excess <= 0) break;
        a.leaving = true;
        excess--;
      }
      pools[role] = pool.filter((a) => a.busy || !a.leaving);
    }
  }

  for (let h = Math.floor(DAY_START / 3600); h < 24; h++) {
    sim.at(h * 3600, () => {
      for (const r of ROLES) {
        const n = scenario.staffing[r][h] ?? 0;
        staffed[r] += n * 3600;
        setHeadcount(r, n);
      }
      dispatchAll();
    });
  }

  // ---------- 订单释放与分批 ----------
  const lockAt = (o: Order) => Math.max(o.createdAt, o.slotStart - cfg.rules.lockLeadMin * 60);
  const pendingRelease = [...orders].sort((a, b) => lockAt(a) - lockAt(b) || a.id.localeCompare(b.id));
  let releaseIdx = 0;

  function releaseOrders(now: number): void {
    const batch: Order[] = [];
    while (releaseIdx < pendingRelease.length && lockAt(pendingRelease[releaseIdx] as Order) <= now) batch.push(pendingRelease[releaseIdx++] as Order);
    if (!batch.length) return;
    const totes: ToteAssignment[] = [];
    for (const o of batch) {
      const res = policy.toteAssignment === 'OPTIMIZED' ? assignTotes(ctx, o, policy.fillFactor === undefined ? {} : { fillFactor: policy.fillFactor }) : assignTotesByEye(ctx, o);
      const st: OrderState = {
        order: o,
        totes: res.totes,
        oversized: res.oversized,
        stagedTotes: 0,
        oversizedDone: 0,
        dueAt: dueAtFor(ctx, o),
        toteSlot: new Map(),
        pendingExceptions: new Set(),
        lineOutcome: new Map(o.lines.map((l) => [l.lineId, 'OK'])),
        handedOff: false,
      };
      state.set(o.id, st);
      for (const tt of res.totes) toteById.set(tt.id, tt);
      totes.push(...res.totes);
      for (const p of res.oversized) oversizedQueue.push({ piece: p, dueAt: st.dueAt });
      log.append(now, 'OrderLocked', { orderId: o.id, type: o.type, fulfillmentType: o.fulfillmentType, lines: o.lines.length });
      log.append(now, 'ToteAssignmentsCreated', { orderId: o.id, toteIds: res.totes.map((t) => t.id), oversizedPieces: res.oversized.length });
      if (res.totes.length === 0 && res.oversized.length === 0) markStaged(st, now);
    }
    const walks = planPickWalks(ctx, totes, { strategy: policy.batching, routing: policy.routing, enforceColdLimit: policy.coldLimit, unit: policy.batchUnit }, `W${++releaseSeq}-`);
    for (const w of walks) {
      walkExpress.set(w.id, w.toteAssignmentIds.some((id) => state.get((toteById.get(id) as ToteAssignment).orderId)?.order.express));
      allWalks.push(w);
      walkQueue.push(w);
      log.append(now, 'PickWalkCreated', { walkId: w.id, tempZone: w.tempZone, totes: w.toteAssignmentIds.length, stops: w.stops.length, distanceM: w.distanceM, estimatedSec: w.estimatedSec });
    }
    dispatchAll();
  }

  for (let t = DAY_START; t <= 22 * 3600; t += scenario.planningIntervalMin * 60) sim.at(t, () => releaseOrders(sim.now));

  // ---------- 拣货 ----------

  function nextPickTask(): Task | undefined {
    if (!walkQueue.length && !oversizedQueue.length) return undefined;
    walkQueue.sort((a, b) => a.dueAt - b.dueAt || Number(walkExpress.get(b.id) ?? false) - Number(walkExpress.get(a.id) ?? false) || a.id.localeCompare(b.id));
    oversizedQueue.sort((a, b) => a.dueAt - b.dueAt || a.piece.id.localeCompare(b.piece.id));
    const w = walkQueue[0];
    const p = oversizedQueue[0];
    if (p && (!w || p.dueAt < w.dueAt)) {
      oversizedQueue.shift();
      return oversizedTask(p.piece);
    }
    walkQueue.shift();
    return w ? walkTask(w) : undefined;
  }

  function oversizedTask(piece: OversizedPiece): Task {
    return {
      start: (a) => {
        const extra = piece.teamLift ? T.teamLiftExtraSec : 0;
        if (piece.teamLift) extraTeamLiftSec += T.oversizedPieceSec + extra; // 第二个人的工时
        log.append(sim.now, 'PickWalkClaimed', { walkId: piece.id, associateId: a.id });
        return T.oversizedPieceSec + extra;
      },
      finish: (a) => {
        const st = state.get(piece.orderId) as OrderState;
        st.oversizedDone++;
        pickedUnits++;
        log.append(sim.now, 'OversizedPicked', { pieceId: piece.id, orderId: piece.orderId, associateId: a.id });
        checkStaged(st);
      },
    };
  }

  function walkTask(w: PickWalk): Task {
    let duration = 0;
    return {
      start: (a) => {
        const startAt = sim.now;
        log.append(startAt, 'PickWalkClaimed', { walkId: w.id, associateId: a.id });
        const totes = w.toteAssignmentIds.map(findTote);
        let t = T.cartPrepSec + totes.length * T.toteSetupSec;
        const setup = t;
        let pos = model.cartDepotNode;
        let firstStopAt: number | undefined;
        let dist = 0;
        const seenLine = new Set<string>();
        for (const stop of w.stops) {
          const d = model.distance(pos, stop.nodeId);
          dist += d;
          t += d / T.cartSpeedMps;
          pos = stop.nodeId;
          if (firstStopAt === undefined) firstStopAt = t;
          t += T.stopSec;
          for (const pick of stop.picks) {
            const item = items.get(pick.itemId) as Item;
            const orderId = (toteById.get(pick.toteAssignmentId) as ToteAssignment).orderId;
            const st = state.get(orderId) as OrderState;
            if (!seenLine.has(pick.lineId)) {
              seenLine.add(pick.lineId);
              const found = keyedUniform(seed, 'shelf', pick.lineId) < item.shelfAvailability;
              if (!found) {
                notFound++;
                const line = st.order.lines.find((l) => l.lineId === pick.lineId);
                let resolution: 'SUBSTITUTED' | 'EXCEPTION' | 'SHORT';
                if (line?.allowSubstitution && keyedUniform(seed, 'subFound', pick.lineId) < B.substitutionFoundRate) {
                  resolution = 'SUBSTITUTED';
                  substituted++;
                  st.lineOutcome.set(pick.lineId, 'SUBSTITUTED');
                  t += T.substituteSec;
                } else if (
                  policy.exceptions &&
                  cfg.modules.exceptions &&
                  backroomRecordSaysStock(pick.lineId, item) &&
                  // 只有来得及在交付前完成时才派发，否则只是白白消耗工时
                  st.dueAt - (startAt + t) >= T.exceptionBaseSec + T.exceptionVarSec / 2 + EXCEPTION_SLACK_SEC
                ) {
                  resolution = 'EXCEPTION';
                  const exId = `EX-${pick.lineId}`;
                  st.pendingExceptions.add(exId);
                  st.lineOutcome.set(pick.lineId, 'PENDING');
                  exceptionsCreated++;
                  const createdAt = startAt + t;
                  sim.at(createdAt, () => {
                    exceptionQueue.push({ id: exId, orderId, lineId: pick.lineId, itemId: pick.itemId, dueAt: st.dueAt });
                    log.append(sim.now, 'ExceptionCreated', { exceptionId: exId, orderId, lineId: pick.lineId, itemId: pick.itemId });
                    dispatch('exception');
                  });
                  t += T.notFoundSec;
                } else {
                  resolution = 'SHORT';
                  st.lineOutcome.set(pick.lineId, 'SHORT');
                  t += T.notFoundSec;
                }
                if (input.retainEvents) {
                  const payload = { walkId: w.id, lineId: pick.lineId, itemId: pick.itemId, resolution };
                  sim.at(startAt + t, () => log.append(sim.now, 'ItemNotFound', payload));
                }
                if (resolution !== 'SUBSTITUTED') continue;
              }
            } else if (st.lineOutcome.get(pick.lineId) === 'SHORT' || st.lineOutcome.get(pick.lineId) === 'PENDING') {
              continue;
            }
            t += pick.qty * T.unitSec;
            pickedUnits += pick.qty;
            if (input.retainEvents) {
              const payload = { walkId: w.id, toteId: pick.toteAssignmentId, lineId: pick.lineId, itemId: pick.itemId, qty: pick.qty };
              sim.at(startAt + t, () => log.append(sim.now, 'ItemPicked', payload));
            }
          }
        }
        const back = model.distance(pos, model.stagingNode);
        dist += back;
        t += back / T.cartSpeedMps;
        pickDistanceM += dist;
        duration = t;
        if (isColdZone(w.tempZone)) {
          coldWalks++;
          const units = totes.reduce((n, x) => n + x.lines.reduce((m, l) => m + l.qty, 0), 0);
          const limit = coldChainLimitSec(units, cfg.rules.coldChain);
          const elapsed = t - (firstStopAt ?? setup);
          maxColdSec = Math.max(maxColdSec, elapsed);
          if (elapsed > limit) {
            coldViolations++;
            const payload = { walkId: w.id, elapsedSec: Math.round(elapsed), limitSec: limit };
            sim.at(startAt + t, () => log.append(sim.now, 'ColdChainAlert', payload));
          }
        }
        return duration;
      },
      finish: (a) => {
        log.append(sim.now, 'PickWalkCompleted', { walkId: w.id, associateId: a.id, durationSec: Math.round(duration) });
        cartQueue.push({ walkId: w.id, totes: w.toteAssignmentIds.map(findTote), arrivedAt: sim.now });
        dispatch('stage');
      },
    };
  }

  function findTote(id: string): ToteAssignment {
    const t = toteById.get(id);
    if (!t) throw new Error(`Unknown tote ${id}`);
    return t;
  }

  // ---------- 暂存 ----------
  function nextStageTask(): Task | undefined {
    const cart = cartQueue.shift();
    if (!cart) return undefined;
    const placements: Array<{ tote: ToteAssignment; slot?: StagingSlot }> = [];
    return {
      start: () => {
        let t = 0;
        for (const tote of cart.totes) {
          const st = state.get(tote.orderId) as OrderState;
          const purpose = tote.fulfillmentType === 'GM' ? 'GM' : 'ORDERS';
          const slot = suggestSlot(model.stagingSlots, occ, { orderId: tote.orderId, tempZone: tote.tempZone, purpose, area: st.order.type });
          if (slot) occupy(occ, slot, tote.orderId);
          else overflowTotes++;
          const walk = slot ? (2 * slot.distanceM) / T.walkSpeedMps : (2 * 20) / T.walkSpeedMps;
          t += walk + (policy.stagingRecord ? T.stageRecordedSec : T.stageUnrecordedSec);
          placements.push(slot ? { tote, slot } : { tote });
        }
        return t;
      },
      finish: () => {
        for (const p of placements) {
          const st = state.get(p.tote.orderId) as OrderState;
          st.toteSlot.set(p.tote.id, p.slot ? { slot: p.slot, overflow: false } : { overflow: true });
          st.stagedTotes++;
          log.append(sim.now, 'ToteStaged', { toteId: p.tote.id, orderId: p.tote.orderId, slotCode: p.slot?.code ?? 'OVERFLOW', recorded: policy.stagingRecord });
          checkStaged(st);
        }
      },
    };
  }

  function checkStaged(st: OrderState): void {
    if (st.stagedAt !== undefined) return;
    if (st.stagedTotes >= st.totes.length && st.oversizedDone >= st.oversized.length) markStaged(st, sim.now);
  }

  function markStaged(st: OrderState, now: number): void {
    st.stagedAt = now;
    log.append(now, 'OrderStaged', { orderId: st.order.id, lateBySec: Math.max(0, Math.round(now - st.dueAt)) });
    dispatch('handoff');
  }

  // ---------- 后仓补取 ----------
  /** 后仓实际是否有货（合成数据中的真实状态） */
  const backroomHasStock = (lineId: string, item: Item) => keyedUniform(seed, 'backroom', lineId) < item.backroomAvailability;
  /**
   * 系统库存记录是否显示后仓有货：有货时记录正确；没货时有一定概率记录仍显示有货（幽灵库存）。
   * 只有记录显示有货时才会生成 Exception 任务（决策 P-08）。
   */
  function backroomRecordSaysStock(lineId: string, item: Item): boolean {
    return backroomHasStock(lineId, item) || keyedUniform(seed, 'phantom', lineId) < B.phantomRecordRate;
  }

  function nextExceptionTask(): Task | undefined {
    if (!exceptionQueue.length) return undefined;
    exceptionQueue.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
    const ex = exceptionQueue.shift();
    if (!ex) return undefined;
    return {
      start: () => T.exceptionBaseSec + T.exceptionVarSec * keyedUniform(seed, 'exDuration', ex.lineId),
      finish: () => {
        const st = state.get(ex.orderId) as OrderState;
        const item = items.get(ex.itemId) as Item;
        const found = backroomHasStock(ex.lineId, item) && keyedUniform(seed, 'exFind', ex.lineId) >= B.backroomMissRate;
        if (st.pendingExceptions.has(ex.id)) {
          st.pendingExceptions.delete(ex.id);
          st.lineOutcome.set(ex.lineId, found ? 'RECOVERED' : 'SHORT');
          if (found) exceptionsRecovered++;
        }
        log.append(sim.now, 'ExceptionResolved', { exceptionId: ex.id, found });
        if (found) log.append(sim.now, 'ReplenishmentTaskCreated', { itemId: ex.itemId, reason: 'EXCEPTION' });
      },
    };
  }

  // ---------- 到达与交付 ----------
  const approachSec = cfg.rules.handoff.approachingMin * 60;

  /**
   * 安排到达。signal 为「可以开始准备」的信号时间：
   * ETA 模式为到达前固定阈值（需要位置共享）；ON_MY_WAY 模式为顾客点击「我在路上」的时间。
   */
  function scheduleArrival(session: Session, arrival: number, canShareLocation: boolean, onMyWayAt: number | undefined): void {
    let signal: number | undefined;
    if (policy.prepTrigger === 'ETA' && canShareLocation) signal = arrival - approachSec;
    else if (policy.prepTrigger === 'ON_MY_WAY' && onMyWayAt !== undefined) signal = onMyWayAt;
    if (signal !== undefined) {
      const at = signal;
      sim.at(at, () => {
        session.approachAt = sim.now;
        for (const oid of session.orderIds) log.append(sim.now, 'CustomerApproaching', { orderId: oid, etaSec: Math.round(arrival - sim.now) });
        dispatch('handoff');
      });
    }
    sim.at(arrival, () => {
      session.arrivedAt = sim.now;
      for (const oid of session.orderIds) log.append(sim.now, 'CustomerArrived', session.kind === 'TRIP' ? { orderId: oid, tripId: session.id } : { orderId: oid });
      dispatch('handoff');
    });
  }

  // 自取：每单一个会话
  for (const o of orders) {
    if (o.type !== 'PICKUP') continue;
    const u = keyedUniform(seed, 'arrivalMode', o.id);
    let arrival: number;
    if (u < B.earlyArrivalShare) arrival = o.slotStart - keyedRange(seed, 'arrivalOffset', o.id, 0, 15 * 60);
    else if (u < B.earlyArrivalShare + B.lateArrivalShare) arrival = o.slotStart + o.slotLengthSec + keyedRange(seed, 'arrivalOffset', o.id, 0, 30 * 60);
    else arrival = o.slotStart + keyedRange(seed, 'arrivalOffset', o.id, 0, o.slotLengthSec);
    const session: Session = { id: `S-${o.id}`, kind: 'PICKUP', orderIds: [o.id], prepped: false, inService: false, done: false };
    sessions.set(session.id, session);
    const taps = keyedUniform(seed, 'tap', o.id) < B.onMyWayTapRate;
    const tapAt = taps ? arrival - keyedRange(seed, 'tapLead', o.id, B.onMyWayLeadMin[0] * 60, B.onMyWayLeadMin[1] * 60) : undefined;
    scheduleArrival(session, Math.round(arrival), keyedUniform(seed, 'share', o.id) < B.locationShareRate, tapAt);
  }

  // 配送：每个时段在截止时间前 20 分钟组合行程（暂存之后，工程约束 EC-6）
  const deliveryBySlot = new Map<string, Order[]>();
  for (const o of orders) {
    if (o.type !== 'DELIVERY') continue;
    const key = `${o.slotStart}|${o.fulfillmentType}`;
    const list = deliveryBySlot.get(key) ?? [];
    list.push(o);
    deliveryBySlot.set(key, list);
  }
  for (const [key, list] of deliveryBySlot) {
    const due = dueAtFor(ctx, list[0] as Order);
    sim.at(due - 20 * 60, () => {
      const candidates = list.map((o) => {
        const st = state.get(o.id);
        return { order: o, totes: Math.max(1, st?.totes.length ?? 1), weightKg: st?.totes.reduce((a, t) => a + t.weightKg, 0) ?? 5 };
      });
      const trips = cfg.modules.trips
        ? composeTrips(candidates, { maxOrders: cfg.rules.handoff.maxOrdersPerTrip, vehicleTotes: B.vehicleTotes, vehicleMaxKg: B.vehicleMaxKg }, `TR-${key.replace('|', '-')}-`)
        : candidates.map((c, i) => ({ id: `TR-${key}-${i + 1}`, orderIds: [c.order.id], placements: { [c.order.id]: 'TRUNK' as const }, totes: c.totes, weightKg: c.weightKg }));
      for (const trip of trips) {
        log.append(sim.now, 'TripComposed', { tripId: trip.id, orderIds: trip.orderIds });
        const session: Session = { id: trip.id, kind: 'TRIP', orderIds: trip.orderIds, prepped: false, inService: false, done: false };
        sessions.set(session.id, session);
        const anchor = trip.orderIds[0] as string;
        const arrival = due + keyedRange(seed, 'driverArrival', anchor, -5 * 60, 15 * 60);
        const driverArrival = Math.round(Math.max(arrival, sim.now + approachSec + 60));
        // 司机端应用同时提供位置和「已出发」信号
        const departAt = Math.max(sim.now + 1, driverArrival - keyedRange(seed, 'driverDepart', anchor, B.onMyWayLeadMin[0] * 60, B.onMyWayLeadMin[1] * 60));
        scheduleArrival(session, driverArrival, true, departAt);
      }
    });
  }

  const sessionReady = (s: Session) => s.orderIds.every((id) => state.get(id)?.stagedAt !== undefined);

  function retrievalSec(s: Session): number {
    let t = 0;
    for (const id of s.orderIds) {
      const st = state.get(id) as OrderState;
      for (const tote of st.totes) {
        const placed = st.toteSlot.get(tote.id);
        const dist = placed?.slot ? placed.slot.distanceM : 20;
        t += (2 * dist) / T.walkSpeedMps;
        if (policy.stagingRecord && placed?.slot) t += T.findRecordedSec;
        else t += T.searchBaseSec + T.searchPerOccupancySec * occupancyRate(model.stagingSlots, occ, tote.tempZone as TempZone) + (placed?.overflow ? 30 : 0);
        if (placed?.slot) release(occ, placed.slot.code, id);
      }
      // 取货时仍未完成的后仓补取按缺货处理（不让顾客等）
      for (const ex of st.pendingExceptions) st.lineOutcome.set(ex.replace(/^EX-/, ''), 'SHORT');
      st.pendingExceptions.clear();
    }
    return t;
  }

  function nextHandoffTask(): Task | undefined {
    const open = [...sessions.values()].filter((s) => !s.done && !s.inService);
    const arrived = open.filter((s) => s.arrivedAt !== undefined && sessionReady(s)).sort((a, b) => (a.arrivedAt as number) - (b.arrivedAt as number) || a.id.localeCompare(b.id));
    const s = arrived[0];
    if (s) return serviceTask(s);
    if (policy.prepTrigger === 'ARRIVAL') return undefined;
    const approaching = open
      .filter((x) => x.arrivedAt === undefined && x.approachAt !== undefined && !x.prepped && sessionReady(x))
      .sort((a, b) => (a.approachAt as number) - (b.approachAt as number) || a.id.localeCompare(b.id));
    const p = approaching[0];
    return p ? prepTask(p) : undefined;
  }

  function prepTask(s: Session): Task {
    return {
      start: (a) => {
        s.inService = true;
        for (const id of s.orderIds) log.append(sim.now, 'PrepStarted', { orderId: id, associateId: a.id, early: true });
        return retrievalSec(s);
      },
      finish: () => {
        s.inService = false;
        s.prepped = true;
        s.preppedAt = sim.now;
        earlyPreps++;
        for (const id of s.orderIds) log.append(sim.now, 'ReadyToLoad', { orderId: id });
      },
    };
  }

  function serviceTask(s: Session): Task {
    return {
      start: (a) => {
        s.inService = true;
        if (s.preppedAt !== undefined) readyDwell.push(sim.now - s.preppedAt);
        let t = 0;
        if (!s.prepped) {
          for (const id of s.orderIds) log.append(sim.now, 'PrepStarted', { orderId: id, associateId: a.id, early: false });
          t += retrievalSec(s);
        }
        const totes = s.orderIds.reduce((n, id) => n + (state.get(id)?.totes.length ?? 0) + (state.get(id)?.oversized.length ?? 0), 0);
        const trolleyTrips = Math.max(1, Math.ceil(totes / T.totesPerTrolley));
        t += trolleyTrips * ((2 * T.handoffWalkM) / T.walkSpeedMps);
        const codes = s.kind === 'TRIP' && !policy.tripSingleCode ? s.orderIds.length : 1;
        t += codes * T.codeVerifySec;
        t += totes * (T.toteScanSec + T.loadPerToteSec);
        for (const id of s.orderIds) {
          const st = state.get(id) as OrderState;
          if (st.order.lines.some((l) => (items.get(l.itemId) as Item).handling.includes('AGE_RESTRICTED') && st.lineOutcome.get(l.lineId) !== 'SHORT')) t += T.idCheckSec;
        }
        if (s.kind === 'TRIP' && policy.tripSingleCode) t += s.orderIds.length * T.placementSec;
        return t;
      },
      finish: () => {
        s.inService = false;
        s.done = true;
        log.append(sim.now, 'CodeVerified', s.kind === 'TRIP' ? { tripId: s.id } : { orderId: s.orderIds[0] as string });
        for (const id of s.orderIds) {
          const st = state.get(id) as OrderState;
          st.handedOff = true;
          const wait = sim.now - (s.arrivedAt as number);
          waits.push(wait);
          log.append(sim.now, 'OrderHandedOff', { orderId: id, waitSec: Math.round(wait) });
        }
      },
    };
  }

  // ---------- 运行 ----------
  sim.run(DAY_END);

  // ---------- 指标 ----------
  const states = [...state.values()];
  const allTotes = states.flatMap((s) => s.totes);
  const lines = orders.reduce((n, o) => n + o.lines.length, 0);
  const units = orders.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.qty, 0), 0);
  const maxKg = cfg.equipment.tote.maxWeightKg;
  let short = 0;
  let shortValue = 0;
  for (const s of states) {
    for (const line of s.order.lines) {
      const v = s.lineOutcome.get(line.lineId);
      if (v !== 'SHORT' && v !== 'PENDING') continue;
      short++;
      const item = items.get(line.itemId) as Item;
      shortValue += item.unitPrice * (item.pricing === 'WEIGHT' ? item.weightKg : line.qty);
    }
  }
  const late = states.filter((s) => s.stagedAt !== undefined && s.stagedAt > s.dueAt);
  const pickBusyHours = (busy.pick + extraTeamLiftSec) / 3600;
  const busyTotal = (busy.pick + extraTeamLiftSec + busy.stage + busy.handoff + busy.exception) / 3600;
  const staffedTotal = (staffed.pick + staffed.stage + staffed.handoff + staffed.exception) / 3600;
  const pct = (n: number, d: number) => (d === 0 ? 0 : (100 * n) / d);

  const metrics: DayMetrics = {
    policy: policy.name,
    orders: orders.length,
    lines,
    units,
    totes: allTotes.length,
    walks: allWalks.length,
    oversizedPieces: states.reduce((n, s) => n + s.oversized.length, 0),
    totesPerOrder: allTotes.length / Math.max(1, orders.length),
    unitsPerTote: allTotes.reduce((n, t) => n + t.lines.reduce((m, l) => m + l.qty, 0), 0) / Math.max(1, allTotes.length),
    toteVolumeUtil: mean(allTotes.map((t) => t.volumeL / model.toteCapacityL)),
    overweightTotePct: pct(allTotes.filter((t) => t.weightKg > maxKg).length, allTotes.length),
    crushRiskTotePct: pct(allTotes.filter((t) => hasCrushRisk(ctx, t)).length, allTotes.length),
    chemicalMixTotePct: pct(allTotes.filter((t) => mixesChemicalWithFood(ctx, t)).length, allTotes.length),
    pickDistanceKm: pickDistanceM / 1000,
    metersPerUnit: pickDistanceM / Math.max(1, pickedUnits),
    pickBusyHours,
    uph: pickedUnits / Math.max(1e-9, pickBusyHours),
    coldWalks,
    coldViolationPct: pct(coldViolations, coldWalks),
    maxColdMinutes: maxColdSec / 60,
    notFoundLinePct: pct(notFound, lines),
    substitutedLines: substituted,
    exceptionsCreated,
    exceptionsRecovered,
    shortLines: short,
    shortValue,
    fillRate: 1 - short / Math.max(1, lines),
    stageBusyHours: busy.stage / 3600,
    overflowTotes,
    lateOrderPct: pct(late.length, states.length),
    avgLatenessMin: late.length ? mean(late.map((s) => ((s.stagedAt as number) - s.dueAt) / 60)) : 0,
    handoffSessions: [...sessions.values()].filter((s) => s.done).length,
    avgWaitMin: mean(waits) / 60,
    p50WaitMin: percentile(waits, 0.5) / 60,
    p80WaitMin: percentile(waits, 0.8) / 60,
    p90WaitMin: percentile(waits, 0.9) / 60,
    longWaitPct: pct(waits.filter((w) => w >= cfg.rules.handoff.longWaitMin * 60).length, waits.length),
    earlyPreps,
    avgReadyDwellMin: mean(readyDwell) / 60,
    p90ReadyDwellMin: percentile(readyDwell, 0.9) / 60,
    handoffBusyHours: busy.handoff / 3600,
    exceptionBusyHours: busy.exception / 3600,
    busyHoursTotal: busyTotal,
    staffedHoursTotal: staffedTotal,
    laborMinutesPerOrder: (busyTotal * 60) / Math.max(1, orders.length),
    laborCostPerOrder: (busyTotal * scenario.hourlyWage) / Math.max(1, orders.length),
    unfinishedOrders: states.filter((s) => !s.handedOff).length + (orders.length - states.length),
    eventsExecuted: sim.eventsExecuted,
  };
  return { metrics, walks: allWalks, events: log.events };
}
