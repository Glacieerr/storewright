import { dutyOf, isBusy, roleOf, type LiveOrder, type OpsState, type StoreStatic } from '@storewright/ops';

/**
 * 推演：从门店的当前状态出发，看未来几个小时（决策记录 0016 第 4.3 节）。
 *
 * 排队推演，不是全天仿真：
 * - 拣货：未完成的拣货批次（计划用时 × 剩余比例）、还没进批次的订单（按件数估算）、按最近一小时下单速度新增的订单，
 *   按应备好时间先后分给在岗的拣货员；进行中的批次留在它的拣货员手里；
 * - 暂存：拣完后几分钟进暂存区（有暂存员时更快）；
 * - 交付：顾客按预计到达（或取货时段开始）到店，在岗的交付员按先能开始的先做；
 * - 用今天的实际数据校准：拣货的「实际用时 ÷ 计划用时」、每单交付用时；没有足够数据时用默认值。
 * 改布局、策略、排班的长期影响用规划孪生里的全天离散事件仿真（sim-engine）。
 */

export type ForecastRole = 'PICK' | 'STAGE' | 'HANDOFF';
type Zone = 'AMBIENT' | 'CHILLED' | 'FROZEN';

export interface ForecastOptions {
  horizonMin?: number;
  stepMin?: number;
  /** 在岗人数的调整（相对现在），例如 { PICK: 1, HANDOFF: -1 } */
  staffDelta?: Partial<Record<ForecastRole, number>>;
  /** 新订单的速度（单/小时）；填了就不用订单量展望 */
  ordersPerHour?: number;
  /** 用订单量展望的哪一条线（决策记录 0021）：乐观（10% 分位）、预计、悲观（90% 分位）；默认预计 */
  band?: 'low' | 'mean' | 'high';
  /** 不用订单量展望（对照：按最近一小时的下单速度） */
  noOutlook?: boolean;
  /** 试方案：这些订单不等锁单时间，现在就可以拣 */
  expedite?: readonly string[];
  /** 试方案：这些订单的冷冻框到 until 才进暂存区（冷冻商品晚点拣） */
  deferFrozen?: { orderIds: readonly string[]; until: number };
}

export interface ForecastStep {
  t: number;
  /** 已经可以拣、还没拣完的工作量（分钟，已校准） */
  backlogMin: number;
  /** 已暂存、还没交付的订单 */
  ready: number;
  /** 已到店、还没交付的顾客 */
  waiting: number;
  /** 到这一步为止，取货时段开始时还没备好的订单（累计） */
  late: number;
  /** 到这一步为止完成交付的订单（累计，不含推演开始前已完成的） */
  handed: number;
  /** 各温区暂存的框数 */
  staged: Record<Zone, number>;
}

export interface ForecastOrder {
  orderId: string;
  shortCode: string;
  dueAt: number;
  readyAt?: number;
  arriveAt: number;
  doneAt?: number;
  late: boolean;
  waitMin?: number;
  /** 推演里新增的预计订单 */
  projected?: boolean;
}

export interface ForecastKpi {
  late: number;
  avgWaitMin: number;
  maxWaitMin: number;
  peakBacklogMin: number;
  /** 冷藏、冷冻暂存的最高占用率（0–1） */
  peakColdOccupancy: number;
  projectedOrders: number;
}

export interface ForecastBasis {
  staff: Record<ForecastRole, number>;
  /** 实际拣货用时 ÷ 计划用时 */
  pickFactor: number;
  handoffMin: number;
  ordersPerHour: number;
  measured: { pick: boolean; handoff: boolean; demand: boolean };
  /** 新订单从哪里来：订单量展望（AI 预测，按今天修正）或最近一小时的速度 */
  demand: 'OUTLOOK' | 'RECENT';
  /** 订单量展望：模型、今天的修正系数、用的哪一条线 */
  outlook?: { model: string; correction: number; band: 'low' | 'mean' | 'high' };
  /** 有多少个批次用的是 AI 预计用时，AI 预计用时的今天实测比例 */
  aiWalks: number;
  aiFactor?: number;
}

export interface Forecast {
  at: number;
  horizonMin: number;
  stepMin: number;
  steps: ForecastStep[];
  orders: ForecastOrder[];
  kpi: ForecastKpi;
  basis: ForecastBasis;
}

const MIN = 60_000;
/** 校准用的时间窗口与样本数下限 */
const CALIBRATE_MIN = 180;
const CALIBRATE_SAMPLES = 3;
/** 默认值：每件拣货 40 秒（没有批次可参考时）、每单交付 4 分钟、新订单的取货时段在下单 2 小时后 */
const DEFAULT_SEC_PER_UNIT = 40;
const DEFAULT_HANDOFF_MIN = 4;
const NEW_ORDER_LEAD_MIN = 120;
const DEFAULT_UNITS = 12;

interface Job {
  remainingSec: number;
  availableAt: number;
  dueAt: number;
  toteIds: string[];
  orderIds: string[];
  owner?: string;
  start?: number;
  end?: number;
}

interface Item {
  id: string;
  shortCode: string;
  dueAt: number;
  arriveAt: number;
  totes: Record<Zone, number>;
  readyAt?: number;
  doneAt?: number;
  projected?: boolean;
  /** 推演开始时已经在交付中：只剩收尾 */
  inSession?: number;
}

const open = (o: LiveOrder) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED';

export function forecast(s: OpsState, st: StoreStatic, now: number, opts: ForecastOptions = {}): Forecast {
  const horizonMin = opts.horizonMin ?? 180;
  const stepMin = opts.stepMin ?? 5;
  const end = now + horizonMin * MIN;

  // 在岗人数（决策记录 0021 修订）：名单上在班次里、最近一小时有扫描或手上有任务的人（含临时调动），
  // 加上最近有扫描的自动运营虚拟员工。名单上有、但没在干活的人不算（演示里没人操作的名单员工就是这样）；
  // 某个岗位一个这样的人都没有时（例如刚开门还没人扫描），按名单上在班次里的人算
  const staff: Record<ForecastRole, number> = { PICK: 0, STAGE: 0, HANDOFF: 0 };
  const rostered: Record<ForecastRole, number> = { PICK: 0, STAGE: 0, HANDOFF: 0 };
  for (const a of st.roster) {
    // 在岗按发布的排班（决策记录 0022）；岗位：临时调动 > 排班里的岗位 > 名单上的岗位
    const duty = dutyOf(st, s, a.id, now);
    const r = s.roles[a.id] ?? duty.role ?? roleOf(st, s, a.id);
    if ((r !== 'PICK' && r !== 'STAGE' && r !== 'HANDOFF') || !duty.on) continue;
    rostered[r] += 1;
    const last = s.activity[a.id]?.lastScanAt;
    if ((last !== undefined && now - last <= 60 * MIN) || isBusy(s, a.id)) staff[r] += 1;
  }
  for (const [id, act] of Object.entries(s.activity)) {
    if (!id.startsWith('V-') || !act.lastScanAt || now - act.lastScanAt > 15 * MIN) continue;
    const r = ({ P: 'PICK', S: 'STAGE', H: 'HANDOFF' } as const)[id.charAt(2) as 'P' | 'S' | 'H'];
    if (r) staff[r] += 1;
  }
  for (const k of ['PICK', 'STAGE', 'HANDOFF'] as const) if (staff[k] === 0) staff[k] = rostered[k];
  for (const k of ['PICK', 'STAGE', 'HANDOFF'] as const) staff[k] = Math.max(0, staff[k] + (opts.staffDelta?.[k] ?? 0));

  // 校准：拣货（实际 ÷ 计划）、交付每单用时
  const since = now - CALIBRATE_MIN * MIN;
  let actual = 0;
  let planned = 0;
  let walksDone = 0;
  let unitsSeen = 0;
  let secSeen = 0;
  const unitsOfTote = (id: string) => s.totes[id]?.lines.reduce((n, l) => n + l.qty, 0) ?? 0;
  for (const w of Object.values(s.walks)) {
    const units = w.toteIds.reduce((n, id) => n + unitsOfTote(id), 0);
    if (units > 0 && w.estimatedSec > 0) {
      unitsSeen += units;
      secSeen += w.estimatedSec;
    }
    if (w.status !== 'COMPLETED' || w.completedAt === undefined || w.completedAt < since) continue;
    const from = w.startedAt ?? w.claimedAt;
    if (from === undefined || w.estimatedSec <= 0) continue;
    actual += (w.completedAt - from) / 1000;
    planned += w.estimatedSec;
    walksDone += 1;
  }
  const pickMeasured = walksDone >= CALIBRATE_SAMPLES && planned > 0;
  const pickFactor = pickMeasured ? Math.min(3, Math.max(0.5, actual / planned)) : 1;
  const secPerUnit = unitsSeen > 0 ? secSeen / unitsSeen : DEFAULT_SEC_PER_UNIT;
  const handoffs = Object.values(s.sessions).filter((x) => x.status === 'COMPLETED' && x.completedAt !== undefined && x.completedAt >= since);
  const handoffMeasured = handoffs.length >= CALIBRATE_SAMPLES;
  const handoffMin = handoffMeasured ? Math.min(20, Math.max(1, handoffs.reduce((n, x) => n + ((x.completedAt as number) - x.startedAt), 0) / handoffs.length / MIN)) : DEFAULT_HANDOFF_MIN;
  // AI 预计用时的今天实测比例（只算有 AI 预计的批次）
  let aiActual = 0;
  let aiPlanned = 0;
  let aiDone = 0;
  for (const w of Object.values(s.walks)) {
    if (!w.ai || w.status !== 'COMPLETED' || w.completedAt === undefined || w.completedAt < since) continue;
    const from = w.claimedAt ?? w.startedAt;
    if (from === undefined) continue;
    aiActual += (w.completedAt - from) / 1000;
    aiPlanned += w.ai.sec;
    aiDone += 1;
  }
  const aiFactor = aiDone >= CALIBRATE_SAMPLES && aiPlanned > 0 ? Math.min(2, Math.max(0.6, aiActual / aiPlanned)) : 1;
  const recent = Object.values(s.orders).filter((o) => o.createdAt >= now - 60 * MIN && o.createdAt <= now);
  const ol = s.outlook;
  const useOutlook = !opts.noOutlook && opts.ordersPerHour === undefined && !!ol && ol.hours.length > 0 && now - ol.at <= 3 * 60 * MIN;
  const band = opts.band ?? 'mean';
  const demandMeasured = opts.ordersPerHour === undefined && recent.length > 0;
  const ordersPerHour = Math.max(0, opts.ordersPerHour ?? recent.length);
  const expedite = new Set(opts.expedite ?? []);
  const deferred = new Set(opts.deferFrozen?.orderIds ?? []);

  // 订单
  const items = new Map<string, Item>();
  const totesByZone = (o: LiveOrder): Record<Zone, number> => {
    const z: Record<Zone, number> = { AMBIENT: 0, CHILLED: 0, FROZEN: 0 };
    for (const id of o.toteIds) {
      const t = s.totes[id];
      if (t && t.tempZone !== 'HOT') z[t.tempZone] += 1;
    }
    if (!o.toteIds.length) z.AMBIENT = 1;
    return z;
  };
  for (const o of Object.values(s.orders)) {
    if (!open(o)) continue;
    const trip = o.tripId ? s.trips[o.tripId] : undefined;
    const arriveAt = trip ? (trip.arrivedAt ?? trip.etaAt ?? o.slotStart) : (o.arrivedAt ?? o.aiEtaAt ?? o.etaAt ?? o.slotStart);
    const it: Item = { id: o.id, shortCode: o.shortCode, dueAt: o.slotStart, arriveAt, totes: totesByZone(o) };
    const staged = o.status === 'STAGED' || o.status === 'PREPPING' || o.status === 'READY' || o.status === 'HANDING_OFF';
    if (staged) it.readyAt = Math.min(now, o.stagedAt ?? now);
    const ss = Object.values(s.sessions).find((x) => x.status !== 'COMPLETED' && x.orderIds.includes(o.id));
    if (ss) it.inSession = Math.max(now, ss.startedAt + handoffMin * MIN);
    items.set(o.id, it);
  }

  // 拣货工作
  const jobs: Job[] = [];
  const covered = new Set<string>();
  for (const w of Object.values(s.walks)) {
    if (w.status === 'COMPLETED') continue;
    let total = 0;
    for (const id of w.toteIds) total += unitsOfTote(id);
    const done = Object.values(w.done).reduce((n, x) => n + x, 0);
    const frac = total > 0 ? Math.max(0, 1 - done / total) : 1;
    const orderIds = [...new Set(w.toteIds.map((id) => s.totes[id]?.orderId).filter((x): x is string => !!x && items.has(x)))];
    for (const id of w.toteIds) covered.add(id);
    // 有 AI 预计用时的批次用它（乘以今天的实测比例），否则用计划用时 × 今天的实测比例
    const job: Job = { remainingSec: w.ai ? w.ai.sec * frac * aiFactor : w.estimatedSec * frac * pickFactor, availableAt: now, dueAt: w.dueAt, toteIds: w.toteIds, orderIds };
    if ((w.status === 'CLAIMED' || w.status === 'PICKING') && w.associateId) job.owner = w.associateId;
    jobs.push(job);
  }
  for (const o of Object.values(s.orders)) {
    if (!open(o) || items.get(o.id)?.readyAt !== undefined) continue;
    const pending = o.toteIds.filter((id) => !covered.has(id) && (s.totes[id]?.status === 'PLANNED' || s.totes[id] === undefined));
    if (o.toteIds.length && !pending.length) continue;
    const units = o.lines.reduce((n, l) => n + l.qty, 0) || DEFAULT_UNITS;
    const availableAt = o.status === 'CREATED' && !expedite.has(o.id) && !o.expedite ? Math.max(now, o.slotStart - st.rules.lockLeadMin * MIN) : now;
    jobs.push({ remainingSec: units * secPerUnit * pickFactor, availableAt, dueAt: o.slotStart, toteIds: pending, orderIds: [o.id] });
  }
  // 推演期间新增的订单
  const avgUnits = recent.length ? recent.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.qty, 0), 0) / recent.length : DEFAULT_UNITS;
  const mix = (() => {
    const z: Record<Zone, number> = { AMBIENT: 0, CHILLED: 0, FROZEN: 0 };
    const list = recent.length ? recent : Object.values(s.orders);
    for (const o of list) {
      const t = totesByZone(o);
      for (const k of ['AMBIENT', 'CHILLED', 'FROZEN'] as const) z[k] += t[k];
    }
    const n = Math.max(1, list.length);
    if (!list.length) return { AMBIENT: 1, CHILLED: 0.3, FROZEN: 0.15 };
    return { AMBIENT: z.AMBIENT / n, CHILLED: z.CHILLED / n, FROZEN: z.FROZEN / n };
  })();
  const perOrderSec = useOutlook && ol?.perOrderSec ? ol.perOrderSec * aiFactor : avgUnits * secPerUnit * pickFactor;
  let projected = 0;
  if (useOutlook && ol) {
    // 订单量展望（决策记录 0021）：每个取货小时的预计单数 − 已经下单的单数 = 还会来的单数；
    // 当前这个小时只算还没过去的部分。取货时段在推演结束之后、但拣货要在推演期间开始的也算上
    const existing = new Map<number, number>();
    for (const o of Object.values(s.orders)) if (o.status !== 'CANCELLED') existing.set(Math.floor(o.slotStart / (60 * MIN)), (existing.get(Math.floor(o.slotStart / (60 * MIN))) ?? 0) + 1);
    const lastDue = end + st.rules.lockLeadMin * MIN;
    // 还没下的单要过一会儿才下，取货时段离下单至少有一段提前量（最近订单的中位数；没有时按 2 小时）：
    // 取货时段太近的小时，还会来的单已经来不及下了，不算
    const leads = recent.map((o) => o.slotStart - o.createdAt).filter((x) => x > 0).sort((a, b) => a - b);
    const lead = leads.length >= 3 ? (leads[Math.floor(leads.length / 2)] as number) : NEW_ORDER_LEAD_MIN * MIN;
    for (const h of ol.hours) {
      const from = Math.max(h.t, now + lead);
      const to = Math.min(h.t + 60 * MIN, lastDue);
      if (to <= from) continue;
      const want = band === 'low' ? h.low : band === 'high' ? h.high : h.mean;
      // 已经下单的单数按这一小时还能下单的比例扣
      const left = Math.max(0, want * ((to - from) / (60 * MIN)) - (existing.get(Math.floor(h.t / (60 * MIN))) ?? 0) * Math.max(0, (to - from) / (60 * MIN)));
      const n = Math.round(left);
      for (let k = 0; k < n; k++) {
        const dueAt = from + ((k + 0.5) * (to - from)) / n;
        projected += 1;
        const id = `~${projected}`;
        items.set(id, { id, shortCode: id, dueAt, arriveAt: dueAt, totes: { ...mix }, projected: true });
        // 下单时间：取货时段前一段提前量（不早于现在）；到锁单时间才可以拣
        const createdAt = Math.max(now, dueAt - lead);
        const availableAt = Math.max(createdAt, dueAt - st.rules.lockLeadMin * MIN);
        if (availableAt < end) jobs.push({ remainingSec: perOrderSec, availableAt, dueAt, toteIds: [], orderIds: [id] });
      }
    }
  } else {
    projected = Math.round((ordersPerHour * horizonMin) / 60);
    for (let k = 0; k < projected; k++) {
      const createdAt = now + ((k + 0.5) * horizonMin * MIN) / projected;
      const dueAt = createdAt + NEW_ORDER_LEAD_MIN * MIN;
      const id = `~${k + 1}`;
      items.set(id, { id, shortCode: id, dueAt, arriveAt: dueAt, totes: { ...mix }, projected: true });
      const availableAt = Math.max(createdAt, dueAt - st.rules.lockLeadMin * MIN);
      if (availableAt < end) jobs.push({ remainingSec: perOrderSec, availableAt, dueAt, toteIds: [], orderIds: [id] });
    }
  }

  // 分给拣货员：进行中的批次留在原来的人手里，其余按应备好时间先后
  const pickers: number[] = new Array<number>(staff.PICK).fill(now);
  let pinnedSlots = 0;
  for (const j of jobs.filter((x) => x.owner)) {
    if (pinnedSlots >= pickers.length) {
      j.owner = undefined;
      continue;
    }
    j.start = now;
    j.end = now + j.remainingSec * 1000;
    pickers[pinnedSlots] = j.end;
    pinnedSlots += 1;
  }
  const queue = jobs.filter((x) => x.start === undefined).sort((a, b) => a.dueAt - b.dueAt || a.availableAt - b.availableAt);
  for (const j of queue) {
    if (!pickers.length) break;
    let best = 0;
    for (let i = 1; i < pickers.length; i++) if ((pickers[i] as number) < (pickers[best] as number)) best = i;
    j.start = Math.max(pickers[best] as number, j.availableAt);
    j.end = j.start + j.remainingSec * 1000;
    pickers[best] = j.end;
  }

  // 订单什么时候备好：它所有的拣货工作都完成，再加暂存的几分钟
  const stageMin = staff.STAGE > 0 ? 4 : 7;
  const pickedAt = new Map<string, number>();
  const unfinished = new Set<string>();
  for (const j of jobs) {
    for (const id of j.orderIds) {
      if (j.end === undefined) unfinished.add(id);
      else pickedAt.set(id, Math.max(pickedAt.get(id) ?? now, j.end));
    }
  }
  for (const it of items.values()) {
    if (it.readyAt !== undefined) continue;
    if (unfinished.has(it.id)) continue;
    const p = pickedAt.get(it.id);
    // 拣完了、还没暂存（没有对应的工作）：暂存后备好
    it.readyAt = (p ?? now) + stageMin * MIN;
  }

  // 交付：在岗的交付员按先能开始的先做
  const servers: number[] = new Array<number>(staff.HANDOFF).fill(now);
  const flow = [...items.values()].filter((it) => it.readyAt !== undefined).sort((a, b) => Math.max(a.readyAt as number, a.arriveAt) - Math.max(b.readyAt as number, b.arriveAt) || a.id.localeCompare(b.id));
  for (const it of flow) {
    if (it.inSession !== undefined) {
      it.doneAt = it.inSession;
      continue;
    }
    if (!servers.length) break;
    let best = 0;
    for (let i = 1; i < servers.length; i++) if ((servers[i] as number) < (servers[best] as number)) best = i;
    const start = Math.max(servers[best] as number, it.readyAt as number, it.arriveAt);
    if (start > end + 6 * 60 * MIN) break;
    it.doneAt = start + handoffMin * MIN;
    servers[best] = it.doneAt;
  }

  // 每一步的状态
  const cap: Record<Zone, number> = { AMBIENT: 0, CHILLED: 0, FROZEN: 0 };
  for (const sl of st.slots) if (sl.tempZone !== 'HOT') cap[sl.tempZone] += sl.capacity;
  const isLate = (it: Item) => it.readyAt === undefined || it.readyAt > it.dueAt;
  const steps: ForecastStep[] = [];
  for (let t = now; t <= end + 1; t += stepMin * MIN) {
    let backlog = 0;
    for (const j of jobs) {
      if (j.availableAt > t) continue;
      if (j.start === undefined || j.end === undefined) backlog += j.remainingSec;
      else if (t < j.start) backlog += j.remainingSec;
      else if (t < j.end) backlog += (j.end - t) / 1000;
    }
    const staged: Record<Zone, number> = { AMBIENT: 0, CHILLED: 0, FROZEN: 0 };
    let ready = 0;
    let waiting = 0;
    let late = 0;
    let handed = 0;
    for (const it of items.values()) {
      const done = it.doneAt !== undefined && it.doneAt <= t;
      if (done) handed += 1;
      if (it.readyAt !== undefined && it.readyAt <= t && !done) {
        ready += 1;
        // 试方案「冷冻商品晚点拣」：这些订单的冷冻框到时间才进暂存区
        const frozenLater = deferred.has(it.id) && t < (opts.deferFrozen?.until ?? 0);
        for (const k of ['AMBIENT', 'CHILLED', 'FROZEN'] as const) if (!(k === 'FROZEN' && frozenLater)) staged[k] += it.totes[k];
      }
      if (it.arriveAt <= t && !done) waiting += 1;
      if (it.dueAt <= t && isLate(it)) late += 1;
    }
    steps.push({ t, backlogMin: Math.round(backlog / 6) / 10, ready, waiting, late, handed, staged: { AMBIENT: Math.round(staged.AMBIENT), CHILLED: Math.round(staged.CHILLED), FROZEN: Math.round(staged.FROZEN) } });
  }

  const orders: ForecastOrder[] = [...items.values()]
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
    .map((it) => {
      const o: ForecastOrder = { orderId: it.id, shortCode: it.shortCode, dueAt: it.dueAt, arriveAt: it.arriveAt, late: isLate(it) };
      if (it.readyAt !== undefined) o.readyAt = it.readyAt;
      if (it.doneAt !== undefined) {
        o.doneAt = it.doneAt;
        o.waitMin = Math.max(0, (it.doneAt - Math.max(it.arriveAt, now)) / MIN);
      } else if (it.arriveAt <= end) {
        // 推演结束前到店、却没人能交付（没有交付员，或者一直没备好）：至少等到推演结束
        o.waitMin = Math.max(0, (end - Math.max(it.arriveAt, now)) / MIN);
      }
      if (it.projected) o.projected = true;
      return o;
    });
  const inWindow = orders.filter((o) => o.arriveAt <= end && o.waitMin !== undefined);
  const waits = inWindow.map((o) => o.waitMin as number);
  const kpi: ForecastKpi = {
    late: orders.filter((o) => o.dueAt <= end && o.late).length,
    avgWaitMin: waits.length ? Math.round((waits.reduce((n, x) => n + x, 0) / waits.length) * 10) / 10 : 0,
    maxWaitMin: waits.length ? Math.round(Math.max(...waits) * 10) / 10 : 0,
    peakBacklogMin: steps.reduce((m, x) => Math.max(m, x.backlogMin), 0),
    peakColdOccupancy: Math.round(steps.reduce((m, x) => Math.max(m, cap.CHILLED ? x.staged.CHILLED / cap.CHILLED : 0, cap.FROZEN ? x.staged.FROZEN / cap.FROZEN : 0), 0) * 100) / 100,
    projectedOrders: projected,
  };
  return {
    at: now,
    horizonMin,
    stepMin,
    steps,
    orders,
    kpi,
    basis: {
      staff,
      pickFactor: Math.round(pickFactor * 100) / 100,
      handoffMin: Math.round(handoffMin * 10) / 10,
      ordersPerHour: useOutlook ? Math.round((projected / horizonMin) * 60 * 10) / 10 : ordersPerHour,
      measured: { pick: pickMeasured, handoff: handoffMeasured, demand: demandMeasured },
      demand: useOutlook ? 'OUTLOOK' : 'RECENT',
      ...(useOutlook && ol ? { outlook: { model: ol.model, correction: ol.correction, band } } : {}),
      aiWalks: Object.values(s.walks).filter((w) => w.ai && w.status !== 'COMPLETED').length,
      ...(aiDone >= CALIBRATE_SAMPLES ? { aiFactor: Math.round(aiFactor * 100) / 100 } : {}),
    },
  };
}

/** 推演里某一时刻（最近的一步） */
export function stepAt(f: Forecast, t: number): ForecastStep | undefined {
  if (!f.steps.length) return undefined;
  const i = Math.round((t - f.at) / (f.stepMin * MIN));
  return f.steps[Math.min(f.steps.length - 1, Math.max(0, i))];
}
